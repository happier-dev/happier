export const INJECTED_STORAGE_RUNTIME = `
  function canReadStorage(name) {
    try {
      var storage = window[name];
      if (!storage) return false;
      storage.length;
      return true;
    } catch (_error) {
      return false;
    }
  }

  function emitStorageAvailability() {
    var hasStorage = canReadStorage('localStorage') || canReadStorage('sessionStorage');
    postEvents([
      hasStorage
        ? baseEvent('storage', 'storage.availability', {})
        : unavailableEvent('storage', 'collector_unavailable')
    ]);
  }

	  function emitStorageKeyInventoryFor(storageType) {
	    var keys = [];
	    var entries = [];
	    var truncated = false;
	    var totalCount = 0;
	    try {
      var storage = window[storageType];
      if (!storage) return;
      var length = Number(storage.length || 0);
      if (!(length > 0) || typeof storage.key !== 'function') {
        if (!(length > 0)) {
          postEvents([baseEvent('storage', 'storage.keyInventory', {
            storageType: storageType,
            keyCount: 0,
            keysTruncated: false,
            keys: []
          })]);
        }
        return;
      }
      var maxKeys = 200;
      for (var index = 0; index < length; index += 1) {
        var name;
        try {
          name = storage.key(index);
        } catch (_error) {
          name = null;
        }
        if (typeof name !== 'string') continue;
	        totalCount += 1;
	        if (keys.length < maxKeys) {
	          var keyName = name.slice(0, 256);
	          keys.push(keyName);
	          if (ownerValueCaptureEnabled() && typeof storage.getItem === 'function') {
	            try {
	              var value = storage.getItem(name);
	              var capped = capOwnerValue(typeof value === 'string' ? value : '');
	              if (capped) {
	                entries.push({
	                  key: keyName,
	                  value: capped.text,
	                  valueTruncated: capped.truncated
	                });
	              }
	            } catch (_error) {
	              // Ignore page-owned storage read failures.
	            }
	          }
	        } else {
	          truncated = true;
	        }
	      }
    } catch (_error) {
      return;
    }
	    var event = baseEvent('storage', 'storage.keyInventory', {
	      storageType: storageType,
	      keyCount: totalCount,
	      keysTruncated: truncated,
	      keys: keys,
	      ...(entries.length > 0 ? { entries: entries } : {})
	    });
	    if (entries.length > 0) {
	      event.redaction.level = 'none';
	      event.redaction.truncated = truncated || entries.some(function (entry) { return entry.valueTruncated === true; });
	    }
	    postEvents([event]);
	  }

  function emitStorageKeyInventory() {
    emitStorageKeyInventoryFor('localStorage');
    emitStorageKeyInventoryFor('sessionStorage');
  }

`;
