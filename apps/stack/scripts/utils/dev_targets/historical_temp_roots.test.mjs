import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, utimes, symlink, access, rm, link, stat, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { reapHistoricalTempRoots } from './historical_temp_roots.mjs';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';

test('historical sweep uses exactly two real process censuses independent of candidate count', async t => {
  for (const count of [1, 32, 1024]) {
    await t.test(`${count} candidates`, async t => {
      const { root } = await createTempFixture(t, { prefix: 'hstack-census-cost-' });
      const parent = join(root, 'tmp'), proc = join(root, 'proc');
      await mkdir(join(proc, '42', 'fd'), { recursive: true });
      await writeFile(join(proc, '42', 'status'), `State:\tS\nUid:\t${Array(4).fill(process.getuid()).join('\t')}\n`);
      await writeFile(join(proc, '42', 'environ'), '');
      await writeFile(join(proc, '42', 'maps'), '');
      await symlink(root, join(proc, '42', 'cwd'));
      const old = new Date(Date.now() - 48 * 3600000);
      for (let index = 0; index < count; index++) {
        const directory = join(parent, `hstack-completed-${index}`);
        await mkdir(directory, { recursive: true });
        await utimes(directory, old, old);
      }
      const readdir = fs.readdirSync;
      let censuses = 0;
      // Observe the OS inventory boundary without replacing the collector.
      t.mock.method(fs, 'readdirSync', (path, ...args) => {
        if (path === proc) censuses++;
        return readdir(path, ...args);
      });
      t.mock.method(console, 'error', () => {});
      syncBuiltinESMExports();
      t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
      const result = reapHistoricalTempRoots(parent, proc);
      assert.equal(result.reclaimedRoots, count);
      assert.deepEqual(result.reclaimedNames.sort(), Array.from({ length: count }, (_, index) => `hstack-completed-${index}`).sort());
      assert.equal(result.retainedRoots, 0);
      assert.equal(fs.readdirSync(parent).length, 0);
      assert.equal(censuses, 2, 'process-reference work must be constant per sweep');
    });
  }
});

test('final census follows every tree recheck and retains references acquired since the first census', async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-census-late-' });
  const parent = join(root, 'tmp'), proc = join(root, 'proc');
  await mkdir(join(proc, '42', 'fd'), { recursive: true });
  await writeFile(join(proc, '42', 'status'), `State:\tS\nUid:\t${Array(4).fill(process.getuid()).join('\t')}\n`);
  await writeFile(join(proc, '42', 'environ'), '');
  await writeFile(join(proc, '42', 'maps'), '');
  const cwd = join(proc, '42', 'cwd');
  await symlink(root, cwd);
  const old = new Date(Date.now() - 48 * 3600000);
  const candidates = ['hstack-unused', 'hstack-late-held'].map(name => join(parent, name));
  for (const directory of candidates) {
    await mkdir(directory, { recursive: true });
    await utimes(directory, old, old);
  }
  const readdir = fs.readdirSync, lstat = fs.lstatSync;
  const treeReads = new Map(candidates.map(path => [path, 0]));
  let censuses = 0;
  let allTreesRechecked = false;
  t.mock.method(fs, 'lstatSync', (path, ...args) => {
    if (treeReads.has(path)) treeReads.set(path, treeReads.get(path) + 1);
    return lstat(path, ...args);
  });
  t.mock.method(fs, 'readdirSync', (path, ...args) => {
    if (path === proc && ++censuses === 2) {
      allTreesRechecked = [...treeReads.values()].every(count => count >= 3);
      fs.unlinkSync(cwd);
      fs.symlinkSync(candidates[1], cwd);
    }
    return readdir(path, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const result = reapHistoricalTempRoots(parent, proc, { candidateNames: candidates.map(path => path.slice(parent.length + 1)) });
  assert.equal(result.reclaimedRoots, 1);
  assert.equal(result.retainedRoots, 1);
  assert.deepEqual(result.reclaimedNames, ['hstack-unused']);
  assert.equal(fs.existsSync(candidates[0]), false);
  await access(candidates[1]);
  assert.equal(allTreesRechecked, true, 'no deletion census may precede another candidate tree recheck');
  assert.equal(censuses, 2);
});

test('deletion pass retains a root replaced or refreshed during the final process census', async t => {
  for (const change of ['replace', 'refresh']) {
    await t.test(change, async t => {
      const { root } = await createTempFixture(t, { prefix: 'hstack-census-tree-' });
      const parent = join(root, 'tmp'), proc = join(root, 'proc');
      const candidate = join(parent, 'hstack-completed');
      await mkdir(candidate, { recursive: true });
      await mkdir(proc);
      const old = new Date(Date.now() - 48 * 3600000);
      await utimes(candidate, old, old);
      const readdir = fs.readdirSync;
      let censuses = 0;
      t.mock.method(fs, 'readdirSync', (path, ...args) => {
        if (path === proc && ++censuses === 2) {
          if (change === 'replace') {
            fs.renameSync(candidate, join(root, 'original'));
            fs.mkdirSync(candidate);
            fs.utimesSync(candidate, old, old);
          } else fs.utimesSync(candidate, new Date(), new Date());
        }
        return readdir(path, ...args);
      });
      syncBuiltinESMExports();
      t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
      const result = reapHistoricalTempRoots(parent, proc);
      assert.equal(result.reclaimedRoots, 0);
      assert.equal(result.retainedRoots, 1);
      await access(candidate);
    });
  }
});

test('procfs ESRCH completes custody census while unreadable live processes retain roots', { skip: process.platform !== 'linux' }, async t => {
  for (const [entry, code] of [['cwd', 'ESRCH'], ['maps', 'ESRCH'], ['cwd', 'EACCES'], ['maps', 'EPERM'], ['maps', 'EIO']]) {
    await t.test(`${entry} ${code} with existing process directory`, async t => {
      const { root } = await createTempFixture(t, { prefix: 'hstack-proc-exit-' });
      const temp = join(root, 'tmp'), proc = join(root, 'proc'), processRoot = join(proc, '42');
      await mkdir(join(processRoot, 'fd'), { recursive: true });
      await writeFile(join(processRoot, 'status'), `State:\tS\nUid:\t${Array(4).fill(process.getuid()).join('\t')}\n`);
      await writeFile(join(processRoot, 'environ'), '');
      await writeFile(join(processRoot, 'maps'), '');
      await symlink(root, join(processRoot, 'cwd'));
      const candidate = join(temp, 'hstack-completed');
      await mkdir(candidate, { recursive: true });
      const old = new Date(Date.now() - 48 * 3600000);
      await utimes(candidate, old, old);
      const method = entry === 'cwd' ? 'readlinkSync' : 'readFileSync';
      const original = fs[method];
      // Procfs is the OS boundary: an exiting task can retain its directory
      // while its own address-space/descriptor observations report ESRCH.
      t.mock.method(fs, method, (path, ...args) => {
        if (path === join(processRoot, entry)) throw Object.assign(new Error('procfs observation failed'), { code });
        return original(path, ...args);
      });
      syncBuiltinESMExports();
      t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
      const result = reapHistoricalTempRoots(temp, proc);
      assert.equal(fs.existsSync(processRoot), true);
      assert.equal(result.reclaimedRoots, code === 'ESRCH' ? 1 : 0);
      assert.equal(result.retainedRoots, code === 'ESRCH' ? 0 : 1);
      assert.equal(result.observationUnavailable === null, code === 'ESRCH');
      assert.equal(fs.existsSync(candidate), code !== 'ESRCH');
    });
  }
});

test('privileged collector entry skips procfs ESRCH without suppressing live permission denial', { skip: process.platform !== 'linux' }, async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-collector-exit-' });
  const proc = join(root, 'proc');
  await mkdir(join(proc, '42'), { recursive: true });
  await writeFile(join(proc, '42', 'status'), `State:\tS\nUid:\t${Array(4).fill(process.getuid()).join('\t')}\n`);
  const collector = fileURLToPath(new URL('./historical_temp_roots.mjs', import.meta.url));
  const script = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { pathToFileURL } from 'node:url';
    const [collector, proc, code, uid] = process.argv.slice(1);
    const originals = Object.fromEntries(['readFileSync', 'readdirSync', 'existsSync'].map(name => [name, fs[name]]));
    for (const [name, original] of Object.entries(originals)) fs[name] = (path, ...args) => {
      if (path === '/proc/42/environ') throw Object.assign(new Error('procfs observation failed'), { code });
      return original(typeof path === 'string' && (path === '/proc' || path.startsWith('/proc/')) ? proc + path.slice(5) : path, ...args);
    };
    syncBuiltinESMExports();
    process.argv = [process.execPath, collector, '--observe-process-references', uid];
    await import(pathToFileURL(collector).href);
  `;
  for (const code of ['ESRCH', 'EACCES']) {
    const result = childProcess.spawnSync(process.execPath, ['--input-type=module', '-e', script, collector, proc, code, String(process.getuid())], { encoding: 'utf8', input: '["42"]' });
    if (code === 'ESRCH') {
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), { paths: [], identities: [] });
    } else {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /references unavailable \(EACCES\)/);
    }
  }
});

test('historical retention reclaims read-only Go-cache trees without changing held roots or symlink targets', { skip: process.platform === 'win32' }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-readonly-retention-', registerCleanup: false });
  const temp = join(fixture.root, 'tmp'), proc = join(fixture.root, 'proc');
  const outside = join(fixture.root, 'outside'), held = join(temp, 'hstack-held'), fresh = join(temp, 'hstack-fresh');
  const directories = [];
  t.after(async () => {
    for (const directory of directories) await chmod(directory, 0o700).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await fixture.cleanup();
  });
  await mkdir(join(proc, '42', 'fd'), { recursive: true });
  await writeFile(join(proc, '42', 'status'), `State:\tS\nUid:\t${Array(4).fill(process.getuid()).join('\t')}\n`);
  await writeFile(join(proc, '42', 'environ'), '');
  await writeFile(join(proc, '42', 'maps'), '');
  await mkdir(outside);
  await writeFile(join(outside, 'keep'), 'separately owned data');
  directories.push(outside);
  const old = new Date(Date.now() - 48 * 3600000);
  const stale = Array.from({ length: 4 }, (_, index) => join(temp, `hstack-completed-${index}`));
  for (const directory of [...stale, held, fresh]) {
    const cache = join(directory, 'go-cache');
    await mkdir(cache, { recursive: true });
    await writeFile(join(cache, 'module'), 'read-only compiler cache');
    await symlink(outside, join(directory, 'outside'));
    directories.push(cache);
    for (const path of [join(cache, 'module'), cache, join(directory, 'outside'), directory]) {
      if (path.endsWith('/outside')) continue;
      await utimes(path, old, old);
    }
    // Symlink timestamps participate in the existing freshness contract.
    await fs.promises.lutimes(join(directory, 'outside'), old, old);
    await utimes(directory, old, old);
  }
  await symlink(held, join(proc, '42', 'cwd'));
  await utimes(join(fresh, 'go-cache/module'), new Date(), new Date());
  for (const directory of directories) await chmod(directory, 0o500);
  const result = reapHistoricalTempRoots(temp, proc);
  assert.equal(result.reclaimedRoots, stale.length, 'N completed, expired read-only roots must leave zero retained stale roots');
  for (const directory of stale) await assert.rejects(access(directory), { code: 'ENOENT' });
  for (const directory of [outside, join(held, 'go-cache'), join(fresh, 'go-cache')]) {
    assert.equal((await stat(directory)).mode & 0o777, 0o500, 'retained trees and external symlink targets keep their permissions');
  }
  await access(join(outside, 'keep'));
});

test('same-UID procfs permission denial uses complete read-only observation, never a process-name exemption', async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-proc-permission-' });
  const temp = join(root, 'tmp'), proc = join(root, 'proc');
  await mkdir(join(proc, '42', 'fd'), { recursive: true });
  await writeFile(join(proc, '42', 'status'), `Name:\tunknown-native\nState:\tS\nUid:\t${Array(4).fill(process.getuid()).join('\t')}\n`);
  await writeFile(join(proc, '42', 'environ'), `PRIVATE_SECRET=must-not-be-emitted\0TMPDIR=${join(temp, 'happier-inherited')}\0`);
  await writeFile(join(proc, '42', 'maps'), '');
  const old = new Date(Date.now() - 48 * 3600000);
  for (const name of ['happier-old', 'happier-held', 'happier-inherited']) {
    await mkdir(join(temp, name), { recursive: true });
    await utimes(join(temp, name), old, old);
  }
  await symlink(join(temp, 'happier-held'), join(proc, '42', 'cwd'));
  const originals = Object.fromEntries(['readFileSync', 'readlinkSync', 'readdirSync', 'statSync', 'existsSync'].map(name => [name, fs[name]]));
  const fixturePath = path => typeof path === 'string' && (path === '/proc' || path.startsWith('/proc/')) ? proc + path.slice(5) : path;
  // Procfs/coreutils are the OS boundary. Keep the actual reaper and tree/inode
  // comparisons real; model the kernel's nondumpable same-user cwd denial.
  for (const [name, original] of Object.entries(originals)) t.mock.method(fs, name, (path, ...args) => {
    if (typeof path === 'string' && path.startsWith('/proc/42/') && !path.endsWith('/status') && name !== 'existsSync') {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    }
    return original(fixturePath(path), ...args);
  });
  let privilegedAvailable = false;
  let privilegedCalls = 0;
  t.mock.method(childProcess, 'spawnSync', (command, args) => {
    assert.equal(command, 'sudo');
    assert.ok(args.every(arg => !arg.includes('\0')), 'spawn arguments must not contain NUL bytes');
    assert.deepEqual(args.slice(0, 2), ['-n', '--']);
    if (!privilegedAvailable) return { status: 1, stdout: '', stderr: 'permission denied' };
    privilegedCalls++;
    assert.equal(args[2], process.execPath);
    assert.deepEqual(args.slice(-2), ['--observe-process-references', String(process.getuid())]);
    return { status: 0, stdout: JSON.stringify({
      paths: [join(temp, 'happier-held'), join(temp, 'happier-inherited')], identities: [],
    }) };
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.equal(reapHistoricalTempRoots(temp).reclaimedRoots, 0, 'unavailable privileged observation must remain closed');
  privilegedAvailable = true;
  const result = reapHistoricalTempRoots(temp);
  assert.equal(result.observationUnavailable, null);
  assert.equal(result.reclaimedRoots, 1);
  await assert.rejects(access(join(temp, 'happier-old')), { code: 'ENOENT' });
  await access(join(temp, 'happier-held'));
  await access(join(temp, 'happier-inherited'));
  assert.equal(privilegedCalls, 2, 'each of the two reference snapshots needs one privileged collector, not a new sudo process for every proc entry');
});

test('native privileged observation reclaims an unused root while preserving actual cwd/fd and inherited temp bindings', { skip: process.platform !== 'linux' }, async t => {
  // The physical Linux privilege boundary is available on the managed worker;
  // other test hosts keep the deterministic procfs contract above.
  if (childProcess.spawnSync('sudo', ['-n', 'true']).status !== 0) return t.skip('noninteractive privileged procfs observation unavailable');
  const { root } = await createTempFixture(t, { prefix: 'hstack-native-reference-' });
  const parent = join(root, 'tmp');
  const old = new Date(Date.now() - 48 * 3600000);
  for (const name of ['happier-old', 'happier-held', 'happier-inherited']) {
    await mkdir(join(parent, name), { recursive: true });
    await writeFile(join(parent, name, 'data'), 'controlled fixture');
    await utimes(join(parent, name, 'data'), old, old);
    await utimes(join(parent, name), old, old);
  }
  const child = childProcess.spawn(process.execPath, ['--input-type=module', '-e',
    'import{openSync}from"node:fs";openSync("data","r");process.stdin.resume();process.stdin.on("end",()=>process.exit(0));console.log("ready");'], {
    cwd: join(parent, 'happier-held'),
    env: { ...process.env, TMPDIR: join(parent, 'happier-inherited'), HAPPIER_REFERENCE_PRIVATE_FIXTURE: 'never-print-this-fixture-value' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const closed = new Promise(resolve => child.once('close', resolve));
  t.after(async () => { child.stdin.end(); await closed; });
  await new Promise((resolve, reject) => {
    child.stdout.once('data', resolve);
    child.once('error', reject);
    child.once('close', () => reject(new Error('reference fixture exited before readiness')));
  });
  const observation = childProcess.spawnSync('sudo', ['-n', '--', process.execPath,
    fileURLToPath(new URL('./historical_temp_roots.mjs', import.meta.url)), '--observe-process-references', String(process.getuid())], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: Infinity,
  });
  assert.equal(observation.status, 0, 'native read-only collector must complete');
  assert.equal(observation.stdout.includes('never-print-this-fixture-value'), false, 'unselected environment values must not cross the collector boundary');
  const references = JSON.parse(observation.stdout);
  assert.ok(references.paths.includes(join(parent, 'happier-held')));
  assert.ok(references.paths.includes(join(parent, 'happier-inherited')));
  await access(join(parent, 'happier-old'));
  // The native collector above really observes the whole host. Scope the
  // following deletion fixture's process inventory to its known holder: a
  // new unrelated nondumpable process can otherwise correctly block sweeping
  // between those observations. All holder cwd/fd/environ reads stay real.
  const readdir = fs.readdirSync;
  t.mock.method(fs, 'readdirSync', (path, ...args) => path === '/proc'
    ? [String(child.pid)] : readdir(path, ...args));
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const result = reapHistoricalTempRoots(parent);
  assert.equal(result.observationUnavailable, null);
  assert.equal(result.reclaimedRoots, 1);
  await assert.rejects(access(join(parent, 'happier-old')), { code: 'ENOENT' });
  for (const name of ['happier-held', 'happier-inherited']) await access(join(parent, name));
});

test('historical sweep reclaims only old known roots with no cwd, fd or mapped-file users', async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-historical-' });
  const temp = join(root, 'tmp'), proc = join(root, 'proc');
  await mkdir(temp);
  await mkdir(join(proc, '42', 'fd'), { recursive: true });
  // procfs is the genuine OS boundary; directory fixtures model cwd/fds/maps.
  await writeFile(join(proc, '42', 'status'), 'State:\tS (sleeping)\n');
  await writeFile(join(proc, '42', 'environ'), '');
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
  for (const name of ['yarn--old', 'yarn--live', 'yarn--recent-child', 'happier-dev-test-old', 'happier-old', 'hstack-old', 'docs-check-old', 'happier-metro-cache', 'happier-plugin-inventory', 'happier-cwd', 'happier-fd', 'happier-mapped', 'happier-recent-child', 'happier-collision', 'happier-weird\\name', 'random-name']) {
    const dir = join(temp, name);
    await mkdir(dir);
    await writeFile(join(dir, 'data'), 'retained or reclaimed');
    await utimes(join(dir, 'data'), old, old);
    await utimes(dir, old, old);
  }
  await symlink(join(temp, 'happier-cwd'), join(proc, '42', 'cwd'));
  const inventoryPath = join(temp, 'happier-plugin-inventory', 'data');
  // A live process can outlast its inherited scratch directory. Preserve its
  // raw binding without blocking reclamation of unrelated existing roots.
  await writeFile(join(proc, '42', 'environ'), `TMPDIR=${join(root, 'removed-scratch')}\0HAPPIER_TEST_TEMP_ROOTS=${join(root, 'removed-test-root')}\0HAPPIER_UI_METRO_CACHE_ROOT=${join(temp, 'happier-metro-cache')}\0HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY=${inventoryPath}\0`);
  await symlink(join(temp, 'happier-fd', 'data'), join(proc, '42', 'fd', '9'));
  await symlink(join(temp, 'yarn--live', 'data'), join(proc, '42', 'fd', '11'));
  await symlink(join(temp, 'happier-collision') + '2/data', join(proc, '42', 'fd', '10'));
  await writeFile(join(proc, '42', 'maps'), `1-2 r--p 0 00:00 1 ${join(temp, 'happier-mapped', 'data')}\n`);
  await utimes(join(temp, 'happier-recent-child', 'data'), new Date(), new Date());
  await utimes(join(temp, 'yarn--recent-child', 'data'), new Date(), new Date());
  await symlink(join(temp, 'random-name'), join(temp, 'happier-symlink'));
  const freshPaths = [];
  const result = reapHistoricalTempRoots(temp, proc, { retainCandidate: (_directory, references) => {
    freshPaths.push(references?.paths ?? []);
    return false;
  } });
  assert.equal(result.reclaimedRoots, 6);
  assert.ok(freshPaths.length > 0 && freshPaths.every(paths => paths.includes(inventoryPath)),
    'lifecycle retention receives the immediately rechecked process bindings');
  assert.ok(result.reclaimedBytes > 0);
  for (const name of ['yarn--old', 'happier-dev-test-old', 'happier-old', 'hstack-old', 'docs-check-old', 'happier-collision']) {
    await assert.rejects(access(join(temp, name)), { code: 'ENOENT' });
  }
  for (const name of ['yarn--live', 'yarn--recent-child', 'happier-metro-cache', 'happier-plugin-inventory', 'happier-cwd', 'happier-fd', 'happier-mapped', 'happier-recent-child', 'happier-weird\\name', 'random-name', 'happier-symlink']) await access(join(temp, name));
  assert.equal(reapHistoricalTempRoots(temp, proc).reclaimedRoots, 0);
});

test('historical sweep retains old roots when live process observation is unavailable', async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-historical-unknown-' });
  const temp = join(root, 'tmp'), proc = join(root, 'proc');
  const dir = join(temp, 'happier-old');
  await mkdir(dir, { recursive: true });
  await mkdir(join(proc, '42'), { recursive: true });
  await writeFile(join(proc, '42', 'status'), 'State:\tS (sleeping)\n');
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
  await utimes(dir, old, old);
  const result = reapHistoricalTempRoots(temp, proc);
  assert.equal(result.reclaimedRoots, 0);
  assert.equal(result.retainedRoots, 1);
  await access(dir);
  await rm(join(proc, '42'), { recursive: true });
  assert.equal(reapHistoricalTempRoots(temp, proc).reclaimedRoots, 1);
});

test('unavailable fresh process observation settles the sweep and reports retained remaining roots', async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-historical-fresh-unavailable-' });
  const parent = join(root, 'tmp');
  const proc = join(root, 'proc');
  await mkdir(join(proc, '42', 'fd'), { recursive: true });
  await writeFile(join(proc, '42', 'status'), `State:\tS\nUid:\t${Array(4).fill(process.getuid()).join('\t')}\n`);
  await writeFile(join(proc, '42', 'environ'), '');
  await writeFile(join(proc, '42', 'maps'), '');
  await symlink(root, join(proc, '42', 'cwd'));
  const historical = new Date(Date.now() - 48 * 3600000);
  for (const name of ['happier-old-a', 'happier-old-b', 'happier-old-c']) {
    await mkdir(join(parent, name), { recursive: true });
    await utimes(join(parent, name), historical, historical);
  }
  const read = fs.readFileSync;
  let bindingReads = 0;
  t.mock.method(fs, 'readFileSync', (path, ...args) => {
    if (path === join(proc, '42', 'environ') && ++bindingReads > 1) {
      throw Object.assign(new Error('process observation denied'), { code: 'EACCES' });
    }
    return read(path, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const result = reapHistoricalTempRoots(parent, proc);
  assert.equal(result.reclaimedRoots, 0);
  assert.equal(result.retainedRoots, 3);
  assert.equal(bindingReads, 2, 'an unavailable fresh census settles cleanup instead of retrying once per root');
  assert.match(result.observationUnavailable ?? '', /EACCES/);
});

test('sweep retains inherited TMPDIR and test roots before a detached process first uses them', async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-inherited-scratch-' });
  const temp = join(root, 'tmp'), proc = join(root, 'proc');
  await mkdir(temp);
  await mkdir(join(proc, '42', 'fd'), { recursive: true });
  await writeFile(join(proc, '42', 'status'), 'State:\tS (sleeping)\n');
  await symlink(root, join(proc, '42', 'cwd'));
  await writeFile(join(proc, '42', 'maps'), '');
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
  for (const name of ['hstack-command', 'happier-test']) {
    await mkdir(join(temp, name));
    await utimes(join(temp, name), old, old);
  }
  await writeFile(join(proc, '42', 'environ'), `TMPDIR=${join(temp, 'hstack-command')}\0HAPPIER_TEST_TEMP_ROOTS=${join(temp, 'happier-test')}\0`);
  assert.equal(reapHistoricalTempRoots(temp, proc).reclaimedRoots, 0);
  for (const name of ['hstack-command', 'happier-test']) await access(join(temp, name));
  await rm(join(proc, '42'), { recursive: true });
  assert.equal(reapHistoricalTempRoots(temp, proc).reclaimedRoots, 2);
});

test('owner-supplied staging candidates reuse historical custody and retain mapped hard links and symlinks', async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-staging-retention-' });
  const parent = join(root, 'runtime-build'), proc = join(root, 'proc');
  await mkdir(parent);
  await mkdir(join(proc, '42', 'fd'), { recursive: true });
  await writeFile(join(proc, '42', 'status'), 'State:\tS (sleeping)\n');
  await writeFile(join(proc, '42', 'environ'), '');
  await symlink(root, join(proc, '42', 'cwd'));
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
  for (const name of ['linux-arm64', 'darwin-arm64', 'unknown']) {
    await mkdir(join(parent, name));
    await writeFile(join(parent, name, 'output'), 'regenerable');
    await utimes(join(parent, name, 'output'), old, old);
    await utimes(join(parent, name), old, old);
  }
  await link(join(parent, 'darwin-arm64', 'output'), join(root, 'mapped-output'));
  await writeFile(join(proc, '42', 'maps'), `1-2 r--p 0 00:00 1 ${join(root, 'mapped-output')}\n`);
  await symlink(join(parent, 'unknown'), join(parent, 'linux-x64'));
  const result = reapHistoricalTempRoots(parent, proc, { candidateNames: ['linux-arm64', 'darwin-arm64', 'linux-x64'] });
  assert.equal(result.reclaimedRoots, 1);
  await assert.rejects(access(join(parent, 'linux-arm64')), { code: 'ENOENT' });
  for (const name of ['darwin-arm64', 'unknown', 'linux-x64']) await access(join(parent, name));
  assert.throws(() => reapHistoricalTempRoots(parent, proc, { candidateNames: ['../mapped-output'] }), /candidate/);
});

test('dry-run measures verified eligible roots without deleting or changing their bytes', async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-retention-measurement-' });
  const parent = join(root, 'cache'), proc = join(root, 'proc');
  const candidate = join(parent, 'happier-obsolete');
  await mkdir(candidate, { recursive: true });
  await mkdir(proc);
  await writeFile(join(candidate, 'data'), 'x'.repeat(8192));
  const old = new Date(Date.now() - 48 * 3600000);
  await utimes(join(candidate, 'data'), old, old);
  await utimes(candidate, old, old);
  const result = reapHistoricalTempRoots(parent, proc, { dryRun: true });
  assert.equal(result.reclaimedRoots, 0);
  assert.deepEqual(result.reclaimedNames, []);
  assert.equal(result.reclaimableRoots, 1);
  await access(candidate);
  const removed = reapHistoricalTempRoots(parent, proc);
  assert.equal(result.reclaimableBytes, removed.reclaimedBytes);
  assert.equal(removed.reclaimedRoots, 1);
  assert.deepEqual(removed.reclaimedNames, ['happier-obsolete']);
});

test('count-retention owners can reclaim recent unheld candidates while retaining another uid', async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-count-retention-' });
  const parent = join(root, 'cache'), proc = join(root, 'proc');
  await mkdir(join(parent, 'obsolete'), { recursive: true });
  await mkdir(proc);
  await writeFile(join(parent, 'obsolete', 'data'), 'x'.repeat(8192));
  await link(join(parent, 'obsolete', 'data'), join(parent, 'obsolete', 'alias'));
  // Count retention still requires strictly past mtimes. Set them after the
  // hard link updates the directory, avoiding fresh/future filesystem timestamps.
  const recent = new Date(Date.now() - 60 * 1000);
  await utimes(join(parent, 'obsolete', 'data'), recent, recent);
  await utimes(join(parent, 'obsolete'), recent, recent);
  const allocatedBytes = ((await stat(join(parent, 'obsolete'))).blocks + (await stat(join(parent, 'obsolete', 'data'))).blocks) * 512;
  const options = { candidateNames: ['obsolete'], minimumAgeMs: 0 };
  assert.equal(reapHistoricalTempRoots(parent, proc, { ...options, ownerUid: process.getuid() + 1 }).reclaimedRoots, 0);
  const result = reapHistoricalTempRoots(parent, proc, options);
  assert.equal(result.reclaimedRoots, 1);
  assert.equal(result.reclaimedBytes, allocatedBytes, 'hard-linked Cargo outputs occupy storage once');
});
