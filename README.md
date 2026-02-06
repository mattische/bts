# BTS - BlueTooth Scanner in node

Just some fun with bluetooth in node.  
Started this on RPI some years ago. Placed the RPI on my office so I would be notified 
if and who was at the office :). 
Piped the output to a text-file which i read remotely (via ssh).

Did some changes to make it work with noble package.  

This is just for fun.


### Install
```npm install```

and you should be good to go.  
Installs the @abandonware/noble package for bluetooth scanning


### Run

Just ```node scan.js``` and an infinite scan starts.  

```bash
node scan.js --help # show help and available args
node scan.js 0.5 # start a scan, number of minutes (0.5 minutes)
node scan.js -w # start an infite scan - shows only newly detected devices
node scan.js -v # verbose scan
```

Have a look in ```package.json``` for start script (shortcut) commands.

### Info

It's hard to determine manufacturer of devices - some is done in the script.  
It is possible to fetch a list of manufacturers from [here](https://raw.githubusercontent.com/NordicSemiconductor/bluetooth-numbers-database/master/v1/company_ids.json).  

Once in a while, run with the update arg and that list is fetched;

```bash
node scan.js -u # update manufacturer list from Nordic Semiconductor
````

See line 44-79 in scan.js

Cheers!

[@mattische](https://github.com/mattische). 

