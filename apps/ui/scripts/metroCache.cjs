const { randomBytes } = require('node:crypto');
const { rename, rm } = require('node:fs/promises');
const path = require('node:path');

// Metro 0.83.5's Transformer concatenates its 16-byte stableHash of global
// configuration, source path and transform options with the 20-byte source
// SHA1. A source edit supersedes the previous result in that partial-key slot.
function partialKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== 36) {
    throw new Error('Metro transform cache requires a 16-byte partial key and 20-byte source SHA1');
  }
  return key.subarray(0, 16);
}

exports.createMetroCacheStore = function createMetroCacheStore({ FileStore, root }) {
  const filePath = key => path.join(root, key.subarray(0, 1).toString('hex'), key.subarray(1).toString('hex'));
  return new class LatestSourceFileStore extends FileStore {
    constructor() {
      super({ root });
    }

    async get(key) {
      const entry = await super.get(partialKey(key));
      if (!entry || entry.key !== key.toString('hex') || typeof entry.binary !== 'boolean') return null;
      if (entry.binary) return typeof entry.value === 'string' ? Buffer.from(entry.value, 'base64') : null;
      return entry.value ?? null;
    }

    async set(key, value) {
      const partial = partialKey(key);
      const binary = Buffer.isBuffer(value);
      const entry = { key: key.toString('hex'), binary, value: binary ? value.toString('base64') : value };
      // Different source revisions may finish together. Serialize through the
      // real FileStore, then atomically publish one coherent key/result pair.
      // Interrupted staging files retire with their configuration generation.
      const staging = Buffer.concat([partial, randomBytes(16)]);
      try {
        await super.set(staging, entry);
        await rename(filePath(staging), filePath(partial));
      } finally {
        await rm(filePath(staging), { force: true });
      }
    }
  }();
};
