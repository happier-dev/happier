import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { reapExpoMetroCacheGenerations, resolveExpoMetroCacheRoot, resolveMetroConfigFingerprint } from '../../stack/scripts/utils/dev/expo_dev.mjs';

const uiRoot = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(path.join(uiRoot, 'package.json'));
const { FileStore, stableHash } = require('metro-cache');

function filesIn(root) {
  return readdirSync(root, { recursive: true }).map(name => path.join(root, name)).filter(file => statSync(file).isFile());
}

function metroConfig(root) {
  const originalTmp = process.env.TMPDIR;
  const originalRoot = process.env.HAPPIER_UI_METRO_CACHE_ROOT;
  process.env.TMPDIR = root;
  process.env.HAPPIER_UI_METRO_CACHE_ROOT = path.join(root, 'current-generation');
  try {
    const configPath = path.join(uiRoot, 'metro.config.js');
    delete require.cache[require.resolve(configPath)];
    const config = require(configPath);
    return config;
  } finally {
    if (originalTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = originalTmp;
    if (originalRoot === undefined) delete process.env.HAPPIER_UI_METRO_CACHE_ROOT; else process.env.HAPPIER_UI_METRO_CACHE_ROOT = originalRoot;
  }
}

function configuredStore(root) {
  const config = metroConfig(root);
  const stores = typeof config.cacheStores === 'function' ? config.cacheStores({ FileStore }) : config.cacheStores;
  assert.equal(stores.length, 1);
  return stores[0];
}

test('configured Metro cache replaces superseded source revisions and retains old-mtime restart hits', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'happier-metro-retention-'));
  const baselineRoot = mkdtempSync(path.join(tmpdir(), 'happier-metro-legacy-measurement-'));
  try {
    const partialKey = stableHash(['global-transform-key', 'source.js', { platform: 'web', dev: true }]);
    const key = source => Buffer.concat([partialKey, createHash('sha1').update(source).digest()]);
    const beforeValue = { code: 'before'.repeat(1024), dependencies: [] };
    const afterValue = { code: 'after'.repeat(1024), dependencies: [] };
    const legacy = new FileStore({ root: baselineRoot });
    await legacy.set(key('before'), beforeValue);
    await legacy.set(key('after'), afterValue);
    const legacyFiles = filesIn(baselineRoot);
    const store = configuredStore(root);
    await store.set(key('before'), beforeValue);
    await store.set(key('after'), afterValue);
    const files = filesIn(root);
    console.log(JSON.stringify({ cache: 'source revision retention',
      legacyFiles: legacyFiles.length, beforeBytes: legacyFiles.reduce((sum, file) => sum + statSync(file).size, 0),
      afterBytes: files.reduce((sum, file) => sum + statSync(file).size, 0), files: files.length }));
    assert.equal(files.length, 1, 'one current source revision belongs to each file/options slot');
    const old = new Date('2000-01-01');
    for (const file of files) utimesSync(file, old, old);
    const restarted = configuredStore(root);
    let hits = 0;
    const current = await restarted.get(key('after'));
    if (current !== null) hits++;
    assert.deepEqual(current, afterValue);
    assert.equal(await restarted.get(key('before')), null, 'a mismatched source hash cannot return stale code');
    console.log(JSON.stringify({ cache: 'unchanged old-mtime restart', reads: 2, hits }));
    assert.equal(hits, 1);
    const binaryKey = Buffer.concat([stableHash(['asset.js', 'android']), createHash('sha1').update('binary').digest()]);
    await restarted.set(binaryKey, Buffer.from([0, 1, 254, 255]));
    assert.deepEqual(await configuredStore(root).get(binaryKey), Buffer.from([0, 1, 254, 255]));
    restarted.clear();
    assert.equal(await restarted.get(key('after')), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(baselineRoot, { recursive: true, force: true });
  }
});

test('Metro startup identity follows Babel, dependency inputs and transform environment', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'happier-metro-identity-'));
  try {
    writeFileSync(path.join(root, 'metro.config.js'), 'module.exports = {};');
    writeFileSync(path.join(root, 'babel.config.js'), 'module.exports = {plugins: []};');
    const env = {};
    const initial = await resolveMetroConfigFingerprint({ projectDir: root, env });
    assert.equal(await resolveMetroConfigFingerprint({ projectDir: root, env }), initial);
    writeFileSync(path.join(root, 'babel.config.js'), 'module.exports = {plugins: ["changed-transform"]};');
    const changedBabel = await resolveMetroConfigFingerprint({ projectDir: root, env });
    assert.notEqual(changedBabel, initial, 'Babel changes invalidate startup and the retained cache generation');
    assert.notEqual(await resolveMetroConfigFingerprint({ projectDir: root,
      env: { HAPPIER_UI_WORKLETS_BUNDLE_MODE: '1' } }), changedBabel);
    writeFileSync(path.join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
    assert.notEqual(await resolveMetroConfigFingerprint({ projectDir: root, env }), changedBabel,
      'dependency inputs select a new cache generation even before first installation admission');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('startup reaps retired configuration generations while the current generation retains real cache hits', {
  skip: process.platform !== 'linux',
}, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'happier-metro-generations-'));
  try {
    writeFileSync(path.join(root, 'metro.config.js'), 'module.exports = {};');
    writeFileSync(path.join(root, 'babel.config.js'), 'module.exports = {plugins: []};');
    const before = await resolveMetroConfigFingerprint({ projectDir: root, env: {} });
    const oldRoot = resolveExpoMetroCacheRoot({ tmpDir: root, currentFingerprint: before });
    writeFileSync(path.join(root, 'babel.config.js'), 'module.exports = {plugins: ["next-transform"]};');
    const current = await resolveMetroConfigFingerprint({ projectDir: root, env: {} });
    const currentRoot = resolveExpoMetroCacheRoot({ tmpDir: root, currentFingerprint: current });
    const { createMetroCacheStore } = require('./scripts/metroCache.cjs');
    const key = Buffer.concat([stableHash(['source.js', 'web']), createHash('sha1').update('source').digest()]);
    for (const cacheRoot of [oldRoot, currentRoot]) {
      const store = createMetroCacheStore({ FileStore, root: cacheRoot });
      await store.set(key, { code: 'retained source', dependencies: [] });
    }
    const old = new Date('2000-01-01');
    const roots = [oldRoot, currentRoot];
    for (const cacheRoot of roots) {
      // Retirement, rather than an age threshold, makes the old generation
      // eligible. The current generation's unchanged transforms may be ancient.
      const modifiedAt = cacheRoot === oldRoot ? new Date(Date.now() - 1) : old;
      for (const entry of readdirSync(cacheRoot, { recursive: true })) utimesSync(path.join(cacheRoot, entry), modifiedAt, modifiedAt);
      utimesSync(cacheRoot, modifiedAt, modifiedAt);
    }
    // An empty procfs fixture is the OS boundary: no process references either
    // generation. Current selection must independently protect its own root.
    const procRoot = path.join(root, 'proc');
    mkdirSync(procRoot);
    const beforeBytes = roots.flatMap(filesIn).reduce((sum, file) => sum + statSync(file).size, 0);
    const dryRun = await reapExpoMetroCacheGenerations({ tmpDir: root, currentFingerprint: current, procRoot, dryRun: true });
    assert.equal(dryRun.reclaimableRoots, 1);
    assert.equal(dryRun.reclaimedRoots, 0);
    assert.ok(existsSync(oldRoot));
    const result = await reapExpoMetroCacheGenerations({ tmpDir: root, currentFingerprint: current, procRoot });
    assert.equal(result.reclaimedRoots, 1);
    assert.equal(existsSync(oldRoot), false);
    const reopened = createMetroCacheStore({ FileStore, root: currentRoot });
    assert.deepEqual(await reopened.get(key), { code: 'retained source', dependencies: [] });
    const afterBytes = filesIn(currentRoot).reduce((sum, file) => sum + statSync(file).size, 0);
    console.log(JSON.stringify({ cache: 'configuration generation retention', beforeBytes, afterBytes,
      reclaimedRoots: result.reclaimedRoots, reclaimedAllocatedBytes: result.reclaimedBytes, retainedHits: 1 }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('overlapping source writes never publish one source key with another source result', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'happier-metro-overlap-'));
  const writeFile = fs.promises.writeFile;
  let signalHalfWritten;
  const halfWritten = new Promise(resolve => { signalHalfWritten = resolve; });
  let finishFirst;
  const secondWritten = new Promise(resolve => { finishFirst = resolve; });
  let firstOpened = false;
  try {
    const store = configuredStore(root);
    const partial = stableHash(['overlapping-source.js', 'web']);
    const keys = ['first', 'second'].map(source => Buffer.concat([partial, createHash('sha1').update(source).digest()]));
    const values = ['a', 'b'].map(character => ({ code: character.repeat(256 * 1024) }));
    // The OS boundary deliberately overlaps two writes. Internal cache logic
    // and FileStore serialization remain real, including the final reads.
    fs.promises.writeFile = async (file, content, ...options) => {
      if (firstOpened) {
        try { return await writeFile.call(fs.promises, file, content, ...options); }
        finally { finishFirst(); }
      }
      const handle = await fs.promises.open(file, 'w');
      firstOpened = true;
      const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
      const half = Math.floor(bytes.length / 2);
      try {
        await handle.write(bytes.subarray(0, half));
        signalHalfWritten();
        await secondWritten;
        await handle.write(bytes.subarray(half));
      } finally { await handle.close(); }
    };
    const first = store.set(keys[0], values[0]);
    await Promise.race([halfWritten, first.then(() => { throw new Error('the first write did not reach its filesystem boundary'); })]);
    await Promise.all([first, store.set(keys[1], values[1])]);
    fs.promises.writeFile = writeFile;
    let hits = 0;
    for (let index = 0; index < keys.length; index++) {
      const value = await store.get(keys[index]);
      if (value !== null) {
        hits++;
        assert.ok(value.code === values[index].code, 'a published slot must contain the result for its complete source key');
      }
    }
    assert.equal(hits, 1, 'overlapping revisions still publish one source slot');
  } finally {
    fs.promises.writeFile = writeFile;
    finishFirst();
    rmSync(root, { recursive: true, force: true });
  }
});

test('real Metro restart reads its retained transforms and source edits replace the same slots', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'happier-metro-restart-'));
  const entryFile = path.join(root, 'entry.js');
  const { default: Server } = require('metro/private/Server');
  const snapshots = [];
  const cacheFiles = () => ['current-generation', 'metro-cache'].flatMap(name => {
    const cacheRoot = path.join(root, name);
    return existsSync(cacheRoot) ? filesIn(cacheRoot) : [];
  });
  try {
    const imports = `import ${JSON.stringify(path.join(uiRoot, 'sources/text/i18n.ts'))};\n`;
    writeFileSync(entryFile, imports + 'globalThis.retentionMeasurement = "before";');
    const build = async () => {
      const config = metroConfig(root);
      config.watchFolders = [...config.watchFolders, root];
      config.maxWorkers = 2;
      config.serializer = { ...config.serializer, getModulesRunBeforeMainModule: () => [] };
      config.fileMapCacheDirectory = path.join(root, 'filemap');
      mkdirSync(config.fileMapCacheDirectory, { recursive: true });
      config.reporter = { update() {} };
      const stores = typeof config.cacheStores === 'function' ? config.cacheStores({ FileStore }) : config.cacheStores;
      const store = stores[0];
      const metrics = { reads: 0, hits: 0, bytesRead: 0 };
      const readFiles = new Set();
      const pending = new Set();
      const get = store.get.bind(store);
      const set = store.set.bind(store);
      store.get = async key => {
        assert.equal(key.length, 36, 'Metro 0.83.5 key = 16-byte partial key + 20-byte source SHA1');
        metrics.reads++;
        const result = await get(key);
        if (result !== null) {
          metrics.hits++;
          const file = [
            path.join(root, 'current-generation', key.subarray(0, 1).toString('hex'), key.subarray(1, 16).toString('hex')),
            path.join(root, 'metro-cache', key.subarray(0, 1).toString('hex'), key.subarray(1).toString('hex')),
          ].find(existsSync);
          assert.ok(file, 'the hit came from a retained FileStore entry');
          if (!readFiles.has(file)) {
            readFiles.add(file);
            metrics.bytesRead += statSync(file).size;
          }
        }
        return result;
      };
      store.set = (key, value) => {
        const work = set(key, value);
        pending.add(work);
        void work.finally(() => pending.delete(work));
        return work;
      };
      config.cacheStores = stores;
      const server = new Server(config, { watch: false });
      try {
        const bundle = await server.build({ ...Server.DEFAULT_BUNDLE_OPTIONS,
          entryFile, platform: 'web', dev: true, minify: false, lazy: false });
        assert.match(bundle.code, /retentionMeasurement/);
        await Promise.all(pending);
      } finally {
        await server.end();
      }
      const files = cacheFiles();
      const snapshot = { ...metrics, files: files.length,
        bytes: files.reduce((sum, file) => sum + statSync(file).size, 0) };
      snapshots.push(snapshot);
      return snapshot;
    };
    const first = await build();
    assert.ok(first.reads > 0);
    assert.equal(first.hits, 0);
    const old = new Date('2000-01-01');
    for (const file of cacheFiles()) utimesSync(file, old, old);
    const restart = await build();
    assert.equal(restart.hits, restart.reads, 'unchanged source transforms survive process restart irrespective of mtime');
    assert.equal(restart.files, first.files);
    writeFileSync(entryFile, imports + 'globalThis.retentionMeasurement = "after";');
    const edited = await build();
    assert.equal(edited.hits, edited.reads - 1, 'only the changed source is transformed again');
    assert.equal(edited.files, first.files, 'the superseded source transform no longer occupies a cache file');
    console.log(JSON.stringify({ cache: 'real Metro restart and source edit', metroVersion: require('metro/package.json').version,
      entryGraph: 'UI translation runtime', snapshots, unchangedReadShare: restart.bytesRead / restart.bytes }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
