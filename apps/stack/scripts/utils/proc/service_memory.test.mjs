import assert from 'node:assert/strict';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { spawn, execFile } from 'node:child_process';
import { access, copyFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { buildNativeAdmissionFixtureEnv } from '../../testkit/core/native_admission_fixture.mjs';
import { recordStackRuntimeStart, recordStackRuntimeUpdate } from '../stack/runtime_state.mjs';
import { writePidState } from '../expo/expo.mjs';
import { readLinuxWorkerProcesses, readWorkerMemoryReservations, renderWorkerMemoryReservationRows } from './service_memory.mjs';
const execFileAsync = promisify(execFile);

async function serviceTree(t, env) {
  const child = spawn(process.execPath, ['-e', `
    const descendant = require('node:child_process').spawn('/bin/sleep', ['60'], { stdio: 'ignore' });
    process.on('SIGTERM', () => {
      if (descendant.exitCode !== null || descendant.signalCode !== null) process.exit(0);
      descendant.once('exit', () => process.exit(0));
      descendant.kill('SIGTERM');
    });
    descendant.once('spawn', () => process.stdout.write(JSON.stringify({ descendantPid: descendant.pid }) + '\\n'));
    setInterval(() => {}, 1000);
  `], { env, stdio: ['ignore', 'pipe', 'ignore'] });
  const exited = new Promise(resolve => child.once('exit', resolve));
  t.after(async () => { if (child.exitCode === null) child.kill('SIGTERM'); await exited; });
  const row = JSON.parse(await new Promise(resolve => child.stdout.once('data', data => resolve(String(data)))));
  return { child, ...row };
}

test('service diagnostics never read retired admission owner records', t => {
  const reads = [];
  t.mock.method(fs, 'readdirSync', path => { reads.push(String(path)); return []; });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const sample = readWorkerMemoryReservations({ admissionRoot: '/tmp/retired-admission', readProcesses: () => new Map(), includeAdmittedRss: true, includeOwnerProgress: true });
  assert.deepEqual(reads, [], 'the broker owns active slots; service diagnostics must not enumerate obsolete owner files');
  assert.deepEqual(sample, { serviceRssKiB: 0, servicePids: [], rssFallbackPids: [] });
  assert.equal(renderWorkerMemoryReservationRows(sample), 'service 0\n');
});

test('scale process observation authenticates generations without a subprocess per Stack binding', t => {
  const count = 500;
  let forks = 0;
  let rollups = 0;
  // OS boundaries only; parsing, binding discovery and generation admission
  // remain real. ps supplies its requested schema, just as the actual OS does.
  t.mock.method(childProcess, 'spawnSync', (command, args) => {
    forks++;
    if (command === 'ps') {
      const columns = args[args.indexOf('-o') + 1].split(',').map(value => value.replaceAll('=', ''));
      return { status: 0, stdout: Array.from({ length: count }, (_, i) => {
        const row = { pid: i + 100, ppid: i === 0 ? 1 : 100, rss: 1024, etimes: 10, times: 2, uid: process.getuid(), stat: 'S', comm: 'node' };
        return columns.map(column => row[column]).join(' ');
      }).join('\n') };
    }
    return { status: 0, stdout: '12345' };
  });
  t.mock.method(fs, 'readFileSync', path => {
    if (/^\/proc\/\d+\/environ$/.test(path)) return 'HOME=/tmp\0HAPPIER_STACK_STACK=scale-fixture\0HAPPIER_STACK_ENV_FILE=/tmp/scale-fixture/env\0'
      + (path === '/proc/100/environ' ? 'HAPPIER_STACK_PROCESS_KIND=browser\0' : '');
    if (/^\/proc\/\d+\/stat$/.test(path)) return `${path.split('/')[2]} (node (worker)) S ${Array(18).fill('0').join(' ')} 12345 0 0\n`;
    if (/^\/proc\/\d+\/smaps_rollup$/.test(path)) { rollups++; return 'Pss: 512 kB\n'; }
    throw Object.assign(new Error('vanished'), { code: 'ENOENT' });
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const processes = readLinuxWorkerProcesses();
  assert.equal(processes.size, count);
  assert.equal(processes.get(100).fingerprint, 'linux-proc:12345');
  assert.ok(forks <= 1, `500 Stack bindings launched ${forks} OS subprocesses; observation must not fork per PID`);
  const budget = count * 1024;
  const sample = readWorkerMemoryReservations({ admissionRoot: '/tmp/scale-admission', readProcesses: () => processes, serviceMemoryCeilingKiB: budget });
  assert.equal(sample.servicePids.length, count);
  assert.equal(sample.serviceRssKiB, budget, 'a proven non-constraining RSS envelope is sufficient for admission');
  assert.equal(rollups, 0, 'non-constraining service memory must not walk 500 page tables');
  const constrained = readWorkerMemoryReservations({ admissionRoot: '/tmp/scale-admission', readProcesses: () => processes, serviceMemoryCeilingKiB: budget - 1 });
  assert.equal(constrained.serviceRssKiB, count * 512, 'a potentially constraining RSS envelope requires exact PSS');
  assert.equal(rollups, count);
});

test('service trees account shared resident pages by PSS and expose unreadable rollup fallback', { skip: process.platform !== 'linux' }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-pss-' });
  const envPath = fixture.path('stack', 'env');
  await mkdir(fixture.path('stack'));
  await writeFile(envPath, '');
  const owner = await serviceTree(t, { ...process.env, HAPPIER_STACK_STACK: 'pss-fixture', HAPPIER_STACK_ENV_FILE: envPath,
      HAPPIER_STACK_PROCESS_KIND: 'browser' });
  // Only procfs is substituted: real enumeration, process identity, ancestry,
  // Stack binding establishes the accounted service tree.
  const readSmapsRollup = path => path === `/proc/${owner.child.pid}/smaps_rollup`
    || path === `/proc/${owner.descendantPid}/smaps_rollup` ? 'Rss: 8192 kB\nPss: 4096 kB\n' : 'Pss: 0 kB\n';
  const workerSnapshot = options => {
    const all = readLinuxWorkerProcesses(options);
    return new Map([owner.child.pid, owner.descendantPid].map(pid => [pid, all.get(pid)]));
  };
  const snapshot = workerSnapshot({ readSmapsRollup });
  const observe = () => readWorkerMemoryReservations({ readProcesses: () => snapshot });
  assert.equal(observe().serviceRssKiB, 8192, 'two shares of the same 8192 KiB mapping must count it once');
  const upper = snapshot.get(owner.child.pid).rssKiB + snapshot.get(owner.descendantPid).rssKiB;
  const bounded = readWorkerMemoryReservations({ readProcesses: () => snapshot, serviceMemoryCeilingKiB: upper });
  assert.equal(bounded.serviceRssKiB, upper);
  const fallback = workerSnapshot({ readSmapsRollup: path => {
    if (path === `/proc/${owner.descendantPid}/smaps_rollup`) throw Object.assign(new Error('unreadable'), { code: 'EACCES' });
    return readSmapsRollup(path);
  } });
  const sample = readWorkerMemoryReservations({ readProcesses: () => fallback });
  assert.equal(sample.serviceRssKiB, 4096 + fallback.get(owner.descendantPid).rssKiB);
  assert.deepEqual(sample.rssFallbackPids, [owner.descendantPid]);
  const readProcFile = fs.readFileSync;
  let statErrorCode = 'ENOENT';
  t.mock.method(fs, 'readFileSync', (path, ...args) => {
    if (path === `/proc/${owner.descendantPid}/stat`) throw Object.assign(new Error('unavailable'), { code: statErrorCode });
    return readProcFile(path, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const gone = workerSnapshot({ readSmapsRollup: path => {
    if (path === `/proc/${owner.descendantPid}/smaps_rollup`) throw Object.assign(new Error('vanished'), { code: 'ENOENT' });
    return readSmapsRollup(path);
  } });
  const afterExit = readWorkerMemoryReservations({ readProcesses: () => gone });
  assert.equal(afterExit.serviceRssKiB, 4096, 'vanished descendants must not retain stale RSS');
  assert.deepEqual(afterExit.rssFallbackPids, [], 'vanished PIDs are not unreadable live memory maps');
  statErrorCode = 'EACCES';
  const unreadable = workerSnapshot({ readSmapsRollup: path => {
    if (path === `/proc/${owner.descendantPid}/smaps_rollup`) throw Object.assign(new Error('unavailable'), { code: 'ENOENT' });
    return readSmapsRollup(path);
  } });
  const conservative = readWorkerMemoryReservations({ readProcesses: () => unreadable });
  assert.equal(conservative.serviceRssKiB, 4096 + unreadable.get(owner.descendantPid).rssKiB);
  assert.deepEqual(conservative.rssFallbackPids, [owner.descendantPid], 'unavailable generation observation is not proof of exit');
});

test('service RSS uses current canonical generations and counts overlapping roots and untagged descendants once', { skip: process.platform !== 'linux' }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-service-rss-' });
  const stackDir = fixture.path('stack');
  await mkdir(stackDir);
  const envPath = fixture.path('stack', 'env');
  await writeFile(envPath, '');
  const service = spawn(process.execPath, ['-e', `
    const descendant = require('node:child_process').spawn('/bin/sleep', ['60'], { env: {}, stdio: 'ignore' });
    process.on('SIGTERM', () => {
      if (descendant.exitCode !== null || descendant.signalCode !== null) process.exit(0);
      descendant.once('exit', () => process.exit(0));
      descendant.kill('SIGTERM');
    });
    descendant.once('spawn', () => process.stdout.write(JSON.stringify({ descendantPid: descendant.pid }) + '\\n'));
    setInterval(() => {}, 1000);
  `], {
    env: { ...process.env, HAPPIER_STACK_STACK: 'rss-fixture', HAPPIER_STACK_ENV_FILE: envPath },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const exited = new Promise(resolve => service.once('exit', resolve));
  t.after(async () => {
    if (service.exitCode === null) service.kill('SIGTERM');
    await exited;
  });
  const { descendantPid } = JSON.parse(await new Promise(resolve => service.stdout.once('data', data => resolve(String(data)))));
  const statePath = fixture.path('stack', 'stack.runtime.json');
  await recordStackRuntimeStart(statePath, { stackName: 'rss-fixture', ownerPid: process.pid });
  const recorded = await recordStackRuntimeUpdate(statePath, { processes: {
    serverPid: service.pid, serverWrapperPid: service.pid, expoPid: service.pid,
  } });
  const all = readLinuxWorkerProcesses();
  const snapshot = new Map([service.pid, descendantPid].map(pid => [pid, all.get(pid)]));
  assert.ok([...snapshot.values()].every(Boolean));
  // Filter only the OS enumeration boundary to this isolated physical worker;
  // the real kernel RSS, ancestry, JSON reader and generation logic remain real.
  const observe = () => readWorkerMemoryReservations({ admissionRoot: fixture.path('admission'), readProcesses: () => snapshot });
  const sample = observe();
  assert.deepEqual(new Set(sample.servicePids), new Set([service.pid, descendantPid]));
  assert.equal(sample.serviceRssKiB, (snapshot.get(service.pid).pssKiB ?? snapshot.get(service.pid).rssKiB)
    + (snapshot.get(descendantPid).pssKiB ?? snapshot.get(descendantPid).rssKiB));
  for (const instance of Object.values(recorded.processInstances.processes)) {
    instance.fingerprint = 'linux-proc:0';
  }
  await writeFile(statePath, JSON.stringify(recorded));
  assert.deepEqual(observe().servicePids, [], 'reused live PID must not resurrect an old service root');
  assert.equal(observe().serviceRssKiB, 0);
  const expoState = fixture.path('stack', 'expo-dev', 'project', 'expo.state.json');
  await writePidState(expoState, { pid: service.pid });
  assert.deepEqual(new Set(observe().servicePids), new Set([service.pid, descendantPid]), 'standalone Expo uses its existing canonical PID writer');
  await writeFile(expoState, JSON.stringify({ pid: service.pid, processInstanceFingerprint: 'linux-proc:0' }));
  assert.equal(observe().serviceRssKiB, 0, 'standalone Expo also rejects a reused PID');
  await recordStackRuntimeUpdate(statePath, { processes: {
    serverPid: null, serverWrapperPid: null, expoPid: null,
    daemonPid: service.pid, daemonPids: [service.pid],
  } });
  assert.deepEqual(new Set(observe().servicePids), new Set([service.pid, descendantPid]),
    'the daemon Machine and its untagged children reserve service RSS independently of servers');
  await recordStackRuntimeUpdate(statePath, { processes: { daemonPid: null, daemonPids: [] } });
  assert.equal(observe().serviceRssKiB, 0);
  snapshot.get(service.pid).env.HAPPIER_STACK_PROCESS_KIND = 'browser';
  assert.deepEqual(new Set(observe().servicePids), new Set([service.pid, descendantPid]),
    'a live Stack-bound browser runner reserves its entire process tree');
  delete snapshot.get(service.pid).env.HAPPIER_STACK_ENV_FILE;
  assert.equal(observe().serviceRssKiB, 0, 'an unscoped process-kind label is not service authority');
});

test('admission status consumes the broker cached sample without a process walk', { skip: process.platform !== 'linux' }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-cached-status-' });
  const sockets = await createTempFixture(t, { parentDir: '/tmp', prefix: 'ha-' });
  const env = { ...buildNativeAdmissionFixtureEnv(), HAPPIER_STACK_PM_CACHE_BASE_DIR: '' };
  const { createAdmissionBroker, readAdmissionMemorySample } = await import('./admission_broker.mjs');
  let samples = 0;
  const broker = createAdmissionBroker({ root: sockets.root, oldLockPath: join(sockets.root, 'old-admission.lock'), sampleResources: async ({ slots }) => {
    samples++;
    return await readAdmissionMemorySample({ slots, readMemory: () => ({ availableMemoryKiB: 100, totalMemoryKiB: 200 }), readProcesses: () => new Map() });
  } });
  await broker.start();
  let admitted;
  let exited;
  t.after(async () => {
    if (admitted) {
      if (admitted.exitCode === null) admitted.kill('SIGTERM');
      await exited;
    }
    await broker.close();
  });
  const before = broker.status().sampleCount;
  for (let index = 0; index < 2; index++) {
    const { stdout } = await execFileAsync(process.execPath, [fileURLToPath(new URL('./service_memory.mjs', import.meta.url)), '--admission-status', '--admission-root=' + sockets.root],
      { env });
    const status = JSON.parse(stdout);
    assert.equal(status.state, 'observed');
    assert.equal(status.availableMemoryKiB, 100);
    assert.equal(status.activeCount, 0);
    assert.equal(status.waitingCount, 0);
    assert.equal(status.sampleCount, before);
  }
  assert.equal(samples, before, 'explicit status reads must not trigger another resource sample');
  admitted = spawn(process.execPath, [fileURLToPath(new URL('./admission_client.mjs', import.meta.url)),
    '--run', '--root=' + sockets.root, '--repo=' + fixture.root, '--class=validation', '--floor-kib=20', '--machine=fixture', '--',
    process.execPath, '-e', 'process.stdout.write("ready"); setInterval(() => {}, 1000);'],
  { env, stdio: ['ignore', 'pipe', 'pipe'] });
  exited = new Promise(resolve => admitted.once('exit', resolve));
  await new Promise((resolve, reject) => {
    admitted.once('exit', code => reject(new Error('fixture admission exited before readiness: ' + code)));
    admitted.stdout.once('data', resolve);
  });
  const afterArrival = broker.status().sampleCount;
  const { stdout } = await execFileAsync(process.execPath, [fileURLToPath(new URL('./service_memory.mjs', import.meta.url)), '--admission-status', '--admission-root=' + sockets.root],
    { env });
  const active = JSON.parse(stdout);
  assert.equal(active.activeCount, 1, 'the cached result must include a real newly admitted job');
  assert.equal(active.reservedMemoryKiB, 20);
  assert.equal(active.sampleCount, afterArrival);
  assert.equal(samples, afterArrival, 'reading the changed fact still must not re-sample resources');
});

test('service observation loads before workspace dependencies are installed', { skip: process.platform !== 'linux' }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-fresh-service-' });
  const sourceDir = fixture.path('fresh', 'apps', 'stack', 'scripts', 'utils');
  await mkdir(sourceDir + '/proc', { recursive: true });
  await mkdir(sourceDir + '/paths');
  for (const relative of ['proc/service_memory.mjs', 'paths/canonical_home.mjs', 'paths/paths.mjs']) {
    await copyFile(fileURLToPath(new URL('../' + relative, import.meta.url)), sourceDir + '/' + relative);
  }
  await mkdir(fixture.path('fresh', 'packages', 'cli-common'), { recursive: true });
  await copyFile(fileURLToPath(new URL('../../../../../packages/cli-common/processInstance.mjs', import.meta.url)), fixture.path('fresh', 'packages', 'cli-common', 'processInstance.mjs'));
  await assert.rejects(access(fixture.path('fresh', 'node_modules')), { code: 'ENOENT' });
  const stackDir = fixture.path('stack');
  await mkdir(stackDir);
  await writeFile(stackDir + '/env', '');
  await serviceTree(t, { ...process.env, HAPPIER_STACK_STACK: 'fresh-service', HAPPIER_STACK_ENV_FILE: stackDir + '/env', HAPPIER_STACK_PROCESS_KIND: 'browser' });
  const { stdout } = await execFileAsync(process.execPath, [sourceDir + '/proc/service_memory.mjs']);
  assert.match(stdout, /^service [1-9]\d*\n$/);
});
