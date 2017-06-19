var falcor = require('falcor');
var FalcorServer = require('falcor-express');
var FalcorRouter = require('falcor-router');
var bodyParser = require('body-parser');
var express = require('express');
var app = express();
var libvirt = require('libvirt');
var NodeCache = require('node-cache');
var Promise = require("bluebird");
var Rx = require("rx");
var Observable = Rx.Observable;

var PORT = process.env.PORT || 8080;
var LIBVIRT_URI = process.env.LIBVIRT_URI || "test:///default";

var hvCache = new NodeCache({
  stdTTL: 60,
  checkperiod: 10,
  useClones: false
});

hvCache.on('del', (key, value) => {
  if (value && value.connected) {
    value.handle.disconnectAsync()
    .then(_ => console.log(new Date() + " : " + key + " disconnected"))
    .catch(e => console.log("ERROR: "+e));
  }
});

const HypervisorManager = {
  get(uri) {
    var cached = hvCache.get(uri);

    if (cached && cached.connected) {
      hvCache.ttl(uri);
      return new Promise(function(resolve) {
        resolve(cached.handle);
      });
    } else if (cached) {
      console.log(new Date() + " : Trying to get an unconnected hypervisor");
      return null; // Better thing to return ?? setTimeout loop ? an Observable ?
    }

    var hv = libvirt.createHypervisor(uri);
    hvCache.set(uri, { handle: hv, connected: false });
    return hv.connectAsync()
    .then(() => {
      console.log(new Date() + " : " + uri + " connected");

      hvCache.set(uri, { handle: hv, connected: true });
      return hv;
    })
    .catch((err) => {
      console.log(`Unable to connect to ${uri} : ${err}`);
    });
  }
};

class HypervisorRouter extends FalcorRouter.createClass([
  {
    //route: 'domains[{integers:indices}]',
    route: 'hypervisorsByURI[{keys:uris}].domains[{integers:indices}]',
    get: function(pathSet) {
      return Observable.fromArray(pathSet.uris)
      .flatMap((uri) => {
        return Observable.fromPromise(HypervisorManager.get(uri))
        .flatMap(hv => hv.getAllDomains())
        .flatMap(domains => Observable.fromArray(domains))
        .flatMap(domain => domain.getUUIDAsync())
        .map((uuid, index) => ({
          path: ["hypervisorsByURI", uri, "domains", index],
          value: { $type: 'ref', value: ['hypervisorsByURI', uri, 'domainsByUUID', uuid] } })
        )
      });

      /*return HypervisorManager.get(this.uri)
      .then(hv => hv.getAllDomains())
      .map(domain => domain.getUUIDAsync())
      .map((uuid, index) => ({ path: ["domains", index], value: { $type: 'ref', value: ['domainsByUUID', uuid] } }));*/
    }
  },
  {
    route: 'hypervisorsByURI[{keys:uris}].domainsByUUID[{keys:uuids}]["id", "uuid", "name", "info"]',
    get: function(pathSet) {
      return Observable.fromArray(pathSet.uuids)
      .flatMap((uuid) => {
        return Observable.fromPromise(HypervisorManager.get(pathSet.uris[0]).then(hv => hv.lookupDomainByUUIDAsync(uuid)))
        .flatMap((domain) => {
          return Observable.fromArray(pathSet[4])
          .flatMap((key) => {
            switch(key) {
              case "id":
                return domain.getIdAsync().then(id => ({ path: ['hypervisorsByURI', pathSet.uris[0], 'domainsByUUID', uuid, key], value: id }));
              case "name":
                return domain.getNameAsync().then(name => ({ path: ['hypervisorsByURI', pathSet.uris[0], 'domainsByUUID', uuid, key], value: name }));
              case "uuid":
                return Observable.of({ path: ['hypervisorsByURI', pathSet.uris[0], 'domainsByUUID', uuid, key], value: uuid });
              case "info":
                return domain.getInfoAsync().then(info => ({ path: ['hypervisorsByURI', pathSet.uris[0], 'domainsByUUID', uuid, key], value: { $type: 'atom', $expires: -100, value: info } }));
            }
          });
        });
      });
    }
  },
  {
    route: 'hypervisorsByURI[{keys:uris}].domainsByUUID[{keys:uuids}].["start", "stop"]',
    call: function(callPath, args) {
      return HypervisorManager.get(callPath.uris[0])
      .then(() => {
        return {
          path: ['domainsByUUID', callPath.uuids[0], callPath[2]],
          value: { $type: 'ref', value: ['domainsByUUID', callPath.uuids[0]] }
        };
      })
    }
  },
]) {
  constructor(uri) {
    super();
    this.uri = uri;
  }
}

app.use(bodyParser.urlencoded({ extended: false }));
app.use('/model.json', FalcorServer.dataSourceRoute((req, res) => new HypervisorRouter(LIBVIRT_URI)));
app.use(express.static('.'));

var server = app.listen(PORT, (err) => {
    if (err) {
        console.error(err);
        return;
    }
    console.log("navigate to http://localhost:"+PORT)
});
