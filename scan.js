import noble from '@abandonware/noble';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load device databases
const deviceData = JSON.parse(readFileSync(join(__dirname, 'devices.json'), 'utf-8'));
const manufacturersPath = join(__dirname, 'manufacturers.json');
const manufacturers = existsSync(manufacturersPath)
  ? JSON.parse(readFileSync(manufacturersPath, 'utf-8'))
  : {};

// Parse arguments
const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`Bluetooth Scanner - Discover nearby BLE devices

Usage: node scan.js [duration] [options]

Arguments:
  duration        Scan duration in minutes (default: continuous until Ctrl+C)

Options:
  --watch, -w     Watch mode: only show new devices as they appear
  --debug, -d     Debug mode: show all detections including repeats
  --update        Update manufacturers.json from Bluetooth SIG database
  --help, -h      Show this help message

Examples:
  node scan.js              Scan until Ctrl+C
  node scan.js 2            Scan for 2 minutes
  node scan.js --watch      Watch for new devices only
  node scan.js 5 --debug    Scan for 5 minutes with debug output
  node scan.js --update     Download latest manufacturer list`);
  process.exit(0);
}

// --- Update manufacturers from Nordic's bluetooth-numbers-database ---

if (args.includes('--update')) {
  const url = 'https://raw.githubusercontent.com/NordicSemiconductor/bluetooth-numbers-database/master/v1/company_ids.json';

  console.log('Fetching manufacturer database from Nordic Semiconductor...');

  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const nordicData = await response.json();
    const updated = {};

    for (const entry of nordicData) {
      const hex = entry.code.toString(16).padStart(4, '0');
      updated[hex] = entry.name;
    }

    // Merge: Nordic data as base, existing custom entries override
    const existing = existsSync(manufacturersPath)
      ? JSON.parse(readFileSync(manufacturersPath, 'utf-8'))
      : {};

    const merged = { ...updated, ...existing };

    writeFileSync(manufacturersPath, JSON.stringify(merged, null, 2) + '\n');

    const newCount = Object.keys(merged).length - Object.keys(existing).length;
    console.log(`Updated manufacturers.json: ${Object.keys(merged).length} manufacturers (${newCount} new)`);
  } catch (err) {
    console.error(`Failed to update: ${err.message}`);
    process.exit(1);
  }

  process.exit(0);
}

const debug = args.includes('--debug') || args.includes('-d');
const watch = args.includes('--watch') || args.includes('-w');
const minutes = parseFloat(args.find(arg => !arg.startsWith('-'))) || 0;
const scanDuration = minutes > 0 ? minutes * 60 * 1000 : 0; // 0 = infinite

// --- Utility functions ---

const swapBytes = (hex4) => hex4.substring(2, 4) + hex4.substring(0, 2);

const parseManufacturerData = (data) => {
  if (!data || data.length < 2) return null;

  const hex = data.toString('hex');
  const rawId = hex.substring(0, 4);
  const manufacturerId = swapBytes(rawId);
  const manufacturer = manufacturers[manufacturerId] || `Unknown (${manufacturerId})`;

  let deviceType = null;

  if (hex.length > 4) {
    const type = hex.substring(4, 6);

    // Only resolve type for manufacturers with known type tables
    const knownTypeMaps = {
      '004c': deviceData.appleTypes,
      '0075': deviceData.samsungTypes,
      '00e0': deviceData.googleTypes,
      '0006': deviceData.microsoftTypes,
      '038f': deviceData.xiaomiTypes,
    };

    const lookup = knownTypeMaps[manufacturerId];
    if (lookup) {
      deviceType = lookup[type] || null;
    }
  }

  return { manufacturer, manufacturerId, type: deviceType, hex };
};

// Infer device type from BLE service UUIDs when manufacturer type is unknown
const inferTypeFromServices = (serviceUuids) => {
  if (!serviceUuids || serviceUuids.length === 0) return null;

  const serviceTypeMap = {
    '1812': 'Input Device',
    '180d': 'Heart Rate Monitor',
    '1816': 'Cycling Sensor',
    '1818': 'Cycling Power',
    '181a': 'Environment Sensor',
    '1810': 'Blood Pressure',
    '1805': 'Clock',
    '180f': 'Battery Device',
    'fe9f': 'Fast Pair Device',
    'fd6f': 'Exposure Notification',
  };

  for (const uuid of serviceUuids) {
    const short = uuid.substring(0, 4).toLowerCase();
    if (serviceTypeMap[short]) {
      return serviceTypeMap[short];
    }
  }
  return null;
};

const getDistance = (rssi) => {
  if (rssi > -50) return '0-2m';
  if (rssi > -70) return '2-10m';
  if (rssi > -90) return '10-30m';
  return '30m+';
};

const resolveServiceName = (uuid) => {
  const short = uuid.length <= 8 ? uuid.replace(/-/g, '') : null;
  if (short && deviceData.serviceNames[short]) {
    return deviceData.serviceNames[short];
  }
  // Try extracting 16-bit UUID from 128-bit standard BLE UUID
  if (uuid.length >= 8) {
    const prefix = uuid.substring(0, 4).toLowerCase();
    if (deviceData.serviceNames[prefix]) {
      return deviceData.serviceNames[prefix];
    }
  }
  return uuid;
};

const getDeviceKey = (peripheral) => {
  const { address } = peripheral;

  // Real MAC address is the best identifier
  if (address && address !== 'unknown') {
    return address;
  }

  // Use noble's peripheral.id (stable per physical device during a scan session)
  // This ensures the same device isn't duplicated when it alternates between
  // named and unnamed advertisements
  return peripheral.id;
};

const getShortId = (peripheral) => {
  if (peripheral.address && peripheral.address !== 'unknown') {
    return peripheral.address;
  }
  // Show short form of noble's UUID for identification
  return peripheral.id ? peripheral.id.substring(0, 8) : 'hidden';
};

const truncate = (str, max) => {
  if (!str) return '';
  return str.length > max ? str.substring(0, max - 3) + '...' : str;
};

// --- State ---

const devices = new Map();
const unknownManufacturers = new Set();
let detectionCount = 0;
let statusLineShown = false;
let scanning = false;
let summaryShown = false;
const startTime = Date.now();

// --- Status line ---

const updateStatusLine = () => {
  if (debug) return;
  const named = Array.from(devices.values()).filter(d => d.hasName).length;
  const total = devices.size;
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  const msg = `  Scanning... ${total} devices found (${named} named) | ${detectionCount} detections | ${elapsed}s elapsed`;

  if (process.stdout.isTTY) {
    process.stdout.clearLine(0);
    process.stdout.cursorTo(0);
    process.stdout.write(msg);
  } else {
    // Non-TTY (piped to file): overwrite with \r
    process.stdout.write(`\r${msg}`);
  }
  statusLineShown = true;
};

const clearStatusLine = () => {
  if (statusLineShown) {
    if (process.stdout.isTTY) {
      process.stdout.clearLine(0);
      process.stdout.cursorTo(0);
    } else {
      process.stdout.write('\n');
    }
    statusLineShown = false;
  }
};

// --- New device handler (designed for future REST API integration) ---

const onNewDevice = (deviceData) => {
  // deviceData contains all info about the device including timestamp.
  // Future: POST to a REST API endpoint, e.g.:
  //   fetch(apiUrl, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(deviceData) });

  if (watch) {
    const { name, address, manufacturer, type, distance, rssi, timestamp } = deviceData;
    const displayName = name || `[${address}]`;
    const parts = [displayName, distance];
    if (manufacturer) parts.splice(1, 0, manufacturer);
    if (type) parts.splice(2, 0, type);
    console.log(`  [${timestamp}] ${parts.join(' | ')}`);
  }
};

const buildDeviceData = (device, deviceKey) => ({
  id: deviceKey,
  name: device.hasName ? device.name : null,
  address: device.address,
  manufacturer: device.info?.manufacturer || null,
  manufacturerId: device.info?.manufacturerId || null,
  type: device.info?.type || null,
  rssi: device.rssi,
  distance: getDistance(device.rssi),
  services: device.services,
  advertisementTypes: [...device.seenTypes],
  detections: device.detections,
  firstSeen: device.firstSeen.toISOString(),
  lastSeen: device.lastSeen.toISOString(),
  timestamp: new Date().toISOString(),
});

// --- Table rendering ---

const renderTable = (headers, rows, columnMaxWidths = {}) => {
  if (rows.length === 0) return;

  // Calculate column widths
  const widths = headers.map((h, i) => {
    const maxData = Math.max(...rows.map(r => String(r[i] || '').length));
    const natural = Math.max(h.length, maxData);
    return columnMaxWidths[i] ? Math.min(natural, columnMaxWidths[i]) : natural;
  });

  // Header
  const headerLine = headers.map((h, i) => h.padEnd(widths[i])).join('  ');
  const separator = widths.map(w => '─'.repeat(w)).join('──');

  console.log(`  ${headerLine}`);
  console.log(`  ${separator}`);

  // Rows
  for (const row of rows) {
    const line = row.map((cell, i) => {
      const str = String(cell || '');
      const truncated = truncate(str, widths[i]);
      return truncated.padEnd(widths[i]);
    }).join('  ');
    console.log(`  ${line}`);
  }
};

// --- Device analysis / correlation ---

const inferAppleDevice = (seenTypes, deviceName) => {
  const types = [...seenTypes];
  const has = (t) => types.includes(t);
  const name = (deviceName || '').toLowerCase();

  // Name-based hints take priority when combined with type data
  if (has('AirPods') || name.includes('airpods'))   return 'AirPods';
  if (name.includes('apple watch') || name.includes('watch'))
    return 'Apple Watch';
  if (name.includes('iphone') || name.includes('ipad'))
    return name.includes('iphone') ? 'iPhone' : 'iPad';
  if (name.includes('macbook') || name.includes('imac'))
    return 'Mac';
  if (name.includes('homepod'))                      return 'HomePod';
  if (name.includes('apple tv'))                     return 'Apple TV';

  // Type-based inference
  if (has('AirPlay Source') && has('Handoff')) return 'Mac';
  if (has('AirPlay Source'))                  return 'Mac / HomePod';
  if (has('AirPlay Target') && has('Hey Siri')) return 'HomePod';
  if (has('AirPlay Target'))                  return 'Apple TV / HomePod';
  if (has('Handoff'))                         return 'iPhone / iPad';
  if (has('Hey Siri'))                        return 'HomePod';
  if (has('HomeKit'))                         return 'HomeKit Device';
  if (has('Find My Network'))                 return 'AirTag';
  if (has('Nearby') && has('Find My'))        return 'iPhone / iPad';
  if (has('Nearby'))                          return 'iPhone / iPad / Watch';
  if (has('Find My'))                         return 'Find My Accessory';
  if (has('iBeacon'))                         return 'iBeacon';
  return 'Apple Device';
};

// Device "role" categories — which types can coexist on the same physical device
const deviceRoles = {
  phone:   { types: new Set(['Nearby', 'Handoff', 'Find My']), label: 'iPhone / iPad' },
  mac:     { types: new Set(['AirPlay Source', 'Handoff', 'Nearby']), label: 'Mac' },
  tv:      { types: new Set(['AirPlay Target', 'Nearby', 'Hey Siri']), label: 'Apple TV / HomePod' },
  airpods: { types: new Set(['AirPods', 'Find My']), label: 'AirPods' },
  tracker: { types: new Set(['Find My', 'Find My Network']), label: 'Find My Accessory' },
};

// Types that CANNOT coexist — if both are present, they are different devices
const incompatiblePairs = [
  ['AirPlay Source', 'AirPlay Target'],
  ['AirPlay Source', 'AirPods'],
  ['AirPlay Target', 'AirPods'],
  ['AirPlay Target', 'Handoff'],
  ['AirPods', 'Handoff'],
  ['AirPods', 'Nearby'],
];

const areTypesCompatible = (existingTypes, newTypes) => {
  const combined = [...existingTypes, ...newTypes];
  for (const [a, b] of incompatiblePairs) {
    if (combined.includes(a) && combined.includes(b)) return false;
  }
  return true;
};

const analyzeAppleDevices = (appleDevices) => {
  if (!appleDevices || appleDevices.length === 0) return null;

  const rssiThreshold = 10; // dBm tolerance for "same location"
  const assigned = new Set();
  const groups = [];

  // Phase 1: Named devices become group anchors
  const namedApple = appleDevices.filter(d => d.hasName).sort((a, b) => b.detections - a.detections);
  const unnamedApple = appleDevices.filter(d => !d.hasName);

  // Determine which types a named device is allowed to absorb
  const getAllowedAbsorb = (seenTypes) => {
    const types = [...seenTypes];
    const has = (t) => types.includes(t);

    // Mac/HomePod with AirPlay Source: can absorb Handoff, Nearby, Hey Siri
    if (has('AirPlay Source'))   return new Set(['Handoff', 'Nearby', 'Hey Siri']);
    // AirPods: can absorb Find My
    if (has('AirPods'))          return new Set(['Find My']);
    // Phone/tablet: can absorb Handoff, Find My
    if (has('Handoff'))          return new Set(['Nearby', 'Find My']);
    if (has('Nearby'))           return new Set(['Handoff', 'Find My']);
    // Apple TV/HomePod: can absorb Nearby
    if (has('AirPlay Target'))   return new Set(['Nearby', 'Hey Siri']);
    // Find My only: this is a tracker, don't absorb active types
    if (has('Find My') || has('Find My Network')) return new Set();

    return new Set();
  };

  // First, merge named devices with the same name into one group
  const namedGroups = new Map(); // name → group
  for (const device of namedApple) {
    assigned.add(device);

    if (namedGroups.has(device.name)) {
      const group = namedGroups.get(device.name);
      group.devices.push(device);
      device.seenTypes.forEach(t => group.seenTypes.add(t));
      group.totalHits += device.detections;
      group.rssiMax = Math.max(group.rssiMax, device.rssiMax);
    } else {
      namedGroups.set(device.name, {
        name: device.name,
        devices: [device],
        seenTypes: new Set(device.seenTypes),
        rssiMax: device.rssiMax,
        totalHits: device.detections,
      });
    }
  }

  // Then try to absorb unnamed devices into named groups
  for (const group of namedGroups.values()) {
    const allowed = getAllowedAbsorb(group.seenTypes);

    for (const candidate of unnamedApple) {
      if (assigned.has(candidate)) continue;
      if (Math.abs(candidate.rssiMax - group.rssiMax) > rssiThreshold) continue;

      const candidateTypes = [...candidate.seenTypes];
      if (!candidateTypes.every(t => allowed.has(t))) continue;
      if (!areTypesCompatible([...group.seenTypes], candidateTypes)) continue;

      group.devices.push(candidate);
      candidate.seenTypes.forEach(t => group.seenTypes.add(t));
      group.totalHits += candidate.detections;
      group.rssiMax = Math.max(group.rssiMax, candidate.rssiMax);
      assigned.add(candidate);
    }

    group.deviceType = inferAppleDevice(group.seenTypes, group.name);
    groups.push(group);
  }

  // Phase 2: Cluster remaining unnamed — active devices absorb nearby shadows
  const remaining = unnamedApple.filter(d => !assigned.has(d));
  const shadowTypes = new Set(['Find My', 'Find My Network']);

  const activeRemaining = remaining.filter(d =>
    [...d.seenTypes].some(t => !shadowTypes.has(t))
  );
  const shadowRemaining = remaining.filter(d =>
    [...d.seenTypes].every(t => shadowTypes.has(t))
  );

  for (const device of activeRemaining) {
    if (assigned.has(device)) continue;
    assigned.add(device);

    const group = {
      name: null,
      devices: [device],
      seenTypes: new Set(device.seenTypes),
      rssiMax: device.rssiMax,
      totalHits: device.detections,
    };

    for (const shadow of shadowRemaining) {
      if (assigned.has(shadow)) continue;
      if (Math.abs(shadow.rssiMax - group.rssiMax) > rssiThreshold) continue;
      if (!areTypesCompatible([...group.seenTypes], [...shadow.seenTypes])) continue;

      group.devices.push(shadow);
      shadow.seenTypes.forEach(t => group.seenTypes.add(t));
      group.totalHits += shadow.detections;
      assigned.add(shadow);
    }

    group.deviceType = inferAppleDevice(group.seenTypes, group.name);
    groups.push(group);
  }

  // Phase 3: Remaining shadow-only devices (AirTags, accessories)
  for (const device of shadowRemaining) {
    if (assigned.has(device)) continue;
    assigned.add(device);

    groups.push({
      name: null,
      devices: [device],
      seenTypes: new Set(device.seenTypes),
      rssiMax: device.rssiMax,
      totalHits: device.detections,
      deviceType: inferAppleDevice(device.seenTypes, null),
    });
  }

  return groups;
};

// --- Summary ---

const showSummary = async () => {
  if (summaryShown) return;
  summaryShown = true;

  if (scanning) {
    await noble.stopScanningAsync();
    scanning = false;
  }

  clearStatusLine();

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const allDevices = Array.from(devices.values());
  const named = allDevices.filter(d => d.hasName);
  const unnamed = allDevices.filter(d => !d.hasName);

  console.log('\n');
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log('  SCAN SUMMARY');
  console.log('═══════════════════════════════════════════════════════════════════════════════');

  // --- Device type stats table (overview of all devices) ---
  const typeStats = new Map();
  for (const device of allDevices) {
    const key = device.statsKey;
    const existing = typeStats.get(key) || { count: 0, detections: 0 };
    existing.count++;
    existing.detections += device.detections;
    typeStats.set(key, existing);
  }

  const sortedTypes = Array.from(typeStats.entries()).sort((a, b) => b[1].detections - a[1].detections);

  if (sortedTypes.length > 0) {
    console.log('\n  Device types:\n');
    renderTable(
      ['Type', 'Devices', 'Detections'],
      sortedTypes.map(([type, stats]) => [type, stats.count, stats.detections])
    );
  }

  // --- Group devices by manufacturer ---
  const mfrGroups = new Map();
  const unidentified = [];

  for (const device of allDevices) {
    const mfr = device.info?.manufacturer;
    if (!mfr || mfr.startsWith('Unknown (')) {
      unidentified.push(device);
    } else {
      if (!mfrGroups.has(mfr)) mfrGroups.set(mfr, []);
      mfrGroups.get(mfr).push(device);
    }
  }

  // Helper to render a manufacturer device table
  const renderMfrTable = (mfrDevices) => {
    const sorted = mfrDevices.sort((a, b) => b.detections - a.detections);
    renderTable(
      ['#', 'Name', 'Type', 'Signal', 'Dist', 'Hits', 'Services'],
      sorted.map((d, i) => [
        i + 1,
        d.hasName ? d.name : `[${d.address}]`,
        d.info?.type || '-',
        `${d.rssiMax} dBm`,
        getDistance(d.rssiMax),
        d.detections,
        d.services.length > 0 ? d.services.join(', ') : '-'
      ]),
      { 1: 28, 6: 30 }
    );
  };

  // --- Apple (with device analysis/clustering) ---
  const appleDevices = mfrGroups.get('Apple');
  if (appleDevices) {
    const appleGroups = analyzeAppleDevices(appleDevices);
    mfrGroups.delete('Apple');

    if (appleGroups && appleGroups.length > 0) {
      const sortedGroups = appleGroups.sort((a, b) => b.totalHits - a.totalHits);

      console.log('\n  Apple (estimated physical devices):\n');
      renderTable(
        ['#', 'Device', 'Name', 'Signals', 'Dist', 'Hits', 'IDs'],
        sortedGroups.map((g, i) => [
          i + 1,
          g.deviceType,
          g.name || '[unnamed]',
          [...g.seenTypes].join(' + '),
          getDistance(g.rssiMax),
          g.totalHits,
          g.devices.length,
        ]),
        { 2: 28, 3: 35 }
      );

      const totalIds = appleGroups.reduce((sum, g) => sum + g.devices.length, 0);
      console.log(`\n  ${appleGroups.length} physical devices from ${totalIds} BLE identifiers`);
    }
  }

  // --- Other known manufacturers (sorted by total detections) ---
  const sortedMfrGroups = Array.from(mfrGroups.entries())
    .sort((a, b) => {
      const aHits = a[1].reduce((s, d) => s + d.detections, 0);
      const bHits = b[1].reduce((s, d) => s + d.detections, 0);
      return bHits - aHits;
    });

  for (const [mfrName, mfrDevices] of sortedMfrGroups) {
    console.log(`\n  ${mfrName}:\n`);
    renderMfrTable(mfrDevices);
  }

  // --- Unidentified devices ---
  if (unidentified.length > 0) {
    const sorted = unidentified.sort((a, b) => b.detections - a.detections);
    console.log('\n  Unidentified:\n');
    renderTable(
      ['#', 'Name', 'Signal', 'Dist', 'Hits', 'Services'],
      sorted.map((d, i) => [
        i + 1,
        d.hasName ? d.name : `[${d.address}]`,
        `${d.rssiMax} dBm`,
        getDistance(d.rssiMax),
        d.detections,
        d.services.length > 0 ? d.services.join(', ') : '-'
      ]),
      { 1: 28, 5: 30 }
    );
  }

  // --- Stats ---
  console.log('\n  ─────────────────────────────────────────────────────────────────────────────');
  console.log(`  ${allDevices.length} devices (${named.length} named, ${unnamed.length} unknown) | ${detectionCount} detections | ${elapsed}s scan`);

  // --- Unknown manufacturers ---
  if (unknownManufacturers.size > 0) {
    console.log(`\n  Unknown manufacturer IDs (run --update or add to manufacturers.json):`);
    unknownManufacturers.forEach(id => {
      console.log(`    "${id}": "Manufacturer name",`);
    });
  }

  console.log('═══════════════════════════════════════════════════════════════════════════════\n');
  process.exit(0);
};

// --- Event handlers ---

noble.on('stateChange', async (state) => {
  if (debug) {
    console.log(`Bluetooth state: ${state}`);
  }

  if (state === 'poweredOn') {
    console.log(`Bluetooth Scanner`);
    const durationMsg = scanDuration > 0 ? `for ${minutes} min` : 'until Ctrl+C';
    const modeMsg = watch ? ' (watch mode)' : debug ? ' (debug mode)' : '';
    console.log(`Scanning ${durationMsg}${modeMsg}...\n`);
    await noble.startScanningAsync([], true);
    scanning = true;
  } else {
    console.log(`Bluetooth is ${state}. Waiting for power on...`);
  }
});

noble.on('discover', (peripheral) => {
  const { address, rssi, advertisement } = peripheral;
  const name = advertisement.localName || 'Unknown device';
  const deviceKey = getDeviceKey(peripheral);
  const hasName = advertisement.localName && advertisement.localName.trim() !== '';

  detectionCount++;

  // Parse manufacturer data
  let info = null;
  let statsKey = 'Unknown';

  if (advertisement.manufacturerData) {
    info = parseManufacturerData(advertisement.manufacturerData);
    if (info) {
      if (!manufacturers[info.manufacturerId]) {
        unknownManufacturers.add(info.manufacturerId);
      }
    }
  }

  // Resolve service UUIDs
  const serviceUuids = advertisement.serviceUuids || [];
  const services = serviceUuids.map(resolveServiceName);

  // Infer type from services if manufacturer type is unknown
  if (info && !info.type) {
    info.type = inferTypeFromServices(serviceUuids);
  }

  if (info) {
    statsKey = info.type ? `${info.manufacturer} - ${info.type}` : info.manufacturer;
  }

  const shortId = getShortId(peripheral);
  const isNewDevice = !devices.has(deviceKey);

  const currentDist = getDistance(rssi);

  if (isNewDevice) {
    // Store new device
    devices.set(deviceKey, {
      name,
      address: address && address !== 'unknown' ? address : shortId,
      rssi,
      rssiMin: rssi,
      rssiMax: rssi,
      info,
      statsKey,
      hasName,
      services,
      seenTypes: new Set(info?.type ? [info.type] : []),
      distanceBand: currentDist,
      detections: 1,
      firstSeen: new Date(),
      lastSeen: new Date()
    });

    // Notify new device
    const storedDevice = devices.get(deviceKey);
    onNewDevice(buildDeviceData(storedDevice, deviceKey));

    if (!watch) {
      if (hasName) {
        clearStatusLine();
        console.log(`  + ${name} ${currentDist}`);
      }
      if (debug && !hasName) {
        clearStatusLine();
        const mfr = info?.manufacturer || 'Unknown';
        console.log(`  + [unnamed] ${mfr} ${shortId} ${currentDist}`);
      }
    }
  } else {
    // Update existing device
    const device = devices.get(deviceKey);
    device.rssiMin = Math.min(device.rssiMin, rssi);
    device.rssiMax = Math.max(device.rssiMax, rssi);
    device.rssi = rssi;
    device.detections++;
    device.lastSeen = new Date();

    // Upgrade: unnamed device got a name
    if (hasName && !device.hasName) {
      device.name = name;
      device.hasName = true;
      onNewDevice(buildDeviceData(device, deviceKey));
      if (!watch) {
        clearStatusLine();
        console.log(`  + ${name} ${currentDist}`);
      }
    }

    // Show distance band change (not in watch mode)
    if (!watch) {
      const prevDist = device.distanceBand;
      if (currentDist !== prevDist) {
        device.distanceBand = currentDist;
        const displayName = device.hasName ? device.name : `[${device.address}]`;
        clearStatusLine();
        console.log(`  ~ ${displayName} ${prevDist} -> ${currentDist}`);
      }
    } else {
      device.distanceBand = currentDist;
    }

    // Track all advertisement types seen from this device
    if (info?.type) {
      device.seenTypes.add(info.type);
    }

    // Update info if we got a more specific type
    if (info?.type && !device.info?.type) {
      device.info = info;
      device.statsKey = statsKey;
    }

    // Update services if we got new ones
    if (services.length > 0 && device.services.length === 0) {
      device.services = services;
    }

    if (debug) {
      clearStatusLine();
      console.log(`    ~ ${name} ${rssi} dBm (detection #${device.detections})`);
    }
  }

  if (!watch) updateStatusLine();
});

// --- Shutdown ---

const gracefulShutdown = () => {
  showSummary();
};

process.on('SIGINT', gracefulShutdown);
if (scanDuration > 0) {
  setTimeout(gracefulShutdown, scanDuration);
}
