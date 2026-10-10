import assert from 'node:assert/strict';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { readdirSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { access, chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { readProcessInstanceFingerprintSync } from '@happier-dev/cli-common/processInstance';

import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { installNativeAdmissionFixture } from '../../testkit/core/native_admission_fixture.mjs';
import { recordStackRuntimeStart, recordStackRuntimeUpdate } from '../stack/runtime_state.mjs';
import { writePidState } from '../expo/expo.mjs';
import { readLinuxWorkerProcesses, readWorkerMemoryReservations, renderWorkerMemoryReservationRows, writeRuntimeAdmissionPhase } from './service_memory.mjs';

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

test('service and admitted trees account shared resident pages by PSS and expose unreadable rollup fallback', { skip: process.platform !== 'linux' }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-pss-' });
  const envPath = fixture.path('stack', 'env');
  await mkdir(fixture.path('stack'));
  await writeFile(envPath, '');
  const owner = await admittedOwner(t, fixture, { root: fixture.path('admission'),
    env: { ...process.env, HAPPIER_STACK_STACK: 'pss-fixture', HAPPIER_STACK_ENV_FILE: envPath,
      HAPPIER_STACK_PROCESS_KIND: 'browser' } });
  // Only procfs is substituted: real enumeration, process identity, ancestry,
  // Stack binding and admission records establish both accounted trees.
  const readSmapsRollup = path => path === `/proc/${owner.child.pid}/smaps_rollup`
    || path === `/proc/${owner.descendantPid}/smaps_rollup` ? 'Rss: 8192 kB\nPss: 4096 kB\n' : 'Pss: 0 kB\n';
  const workerSnapshot = options => {
    const all = readLinuxWorkerProcesses(options);
    return new Map([owner.child.pid, owner.descendantPid].map(pid => [pid, all.get(pid)]));
  };
  const snapshot = workerSnapshot({ readSmapsRollup });
  const observe = () => readWorkerMemoryReservations({ admissionRoot: owner.root,
    readProcesses: () => snapshot, includeAdmittedRss: true });
  assert.equal(observe().serviceRssKiB, 8192, 'two shares of the same 8192 KiB mapping must count it once');
  assert.equal(observe().admittedOwners[0].rssKiB, 8192, 'admitted credits must use the same proportional accounting');
  const upper = snapshot.get(owner.child.pid).rssKiB + snapshot.get(owner.descendantPid).rssKiB;
  const bounded = readWorkerMemoryReservations({ admissionRoot: owner.root, readProcesses: () => snapshot,
    includeAdmittedRss: true, serviceMemoryCeilingKiB: upper });
  assert.equal(bounded.serviceRssKiB, upper);
  assert.equal(bounded.admittedOwners[0].rssKiB, 8192, 'an RSS service envelope must never over-credit admitted memory');
  const fallback = workerSnapshot({ readSmapsRollup: path => {
    if (path === `/proc/${owner.descendantPid}/smaps_rollup`) throw Object.assign(new Error('unreadable'), { code: 'EACCES' });
    return readSmapsRollup(path);
  } });
  const sample = readWorkerMemoryReservations({ admissionRoot: owner.root, readProcesses: () => fallback, includeAdmittedRss: true });
  assert.equal(sample.serviceRssKiB, 4096 + fallback.get(owner.descendantPid).rssKiB);
  assert.equal(sample.admittedOwners[0].rssKiB, sample.serviceRssKiB);
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
  const afterExit = readWorkerMemoryReservations({ admissionRoot: owner.root, readProcesses: () => gone, includeAdmittedRss: true });
  assert.equal(afterExit.serviceRssKiB, 4096, 'vanished descendants must not retain stale RSS');
  assert.equal(afterExit.admittedOwners[0].rssKiB, 4096);
  assert.deepEqual(afterExit.rssFallbackPids, [], 'vanished PIDs are not unreadable live memory maps');
  statErrorCode = 'EACCES';
  const unreadable = workerSnapshot({ readSmapsRollup: path => {
    if (path === `/proc/${owner.descendantPid}/smaps_rollup`) throw Object.assign(new Error('unavailable'), { code: 'ENOENT' });
    return readSmapsRollup(path);
  } });
  const conservative = readWorkerMemoryReservations({ admissionRoot: owner.root, readProcesses: () => unreadable, includeAdmittedRss: true });
  assert.equal(conservative.serviceRssKiB, 4096 + unreadable.get(owner.descendantPid).rssKiB);
  assert.deepEqual(conservative.rssFallbackPids, [owner.descendantPid], 'unavailable generation observation is not proof of exit');
});

test('native kernel generation observation does not fork per waiting PID', { skip: process.platform !== 'linux' }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-native-identity-scale-' });
  await mkdir(fixture.path('bin'));
  const marker = fixture.path('forked');
  await writeFile(fixture.path('bin', 'awk'), `#!/bin/sh\nprintf fork >> '${marker}'\nexec /usr/bin/awk "$@"\n`);
  await chmod(fixture.path('bin', 'awk'), 0o755);
  const processFingerprint = readProcessInstanceFingerprintSync(process.pid);
  const result = spawnSync('/bin/sh', ['-c', '. "$1"; i=0; while [ "$i" -lt 500 ]; do heavyweight_process_is_current "$2" "$3" || exit 1; i=$((i + 1)); done',
    'kernel-generation-observation', identity, String(process.pid), processFingerprint.slice('linux-proc:'.length)],
  { env: { ...process.env, PATH: `${fixture.path('bin')}:/usr/bin:/bin` }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  await assert.rejects(access(marker), { code: 'ENOENT' }, '500 live waiters must not launch 500 OS identity probes under the global lock');
});

const policy = fileURLToPath(new URL('../dev_targets/native_command_policy.sh', import.meta.url));
const identity = fileURLToPath(new URL('./native_process_identity.sh', import.meta.url));
const hostState = fileURLToPath(new URL('./native_host_admission_state.sh', import.meta.url));

async function memoryBoundary(fixture, { availableKiB, totalKiB }) {
  await mkdir(fixture.path('bin'), { recursive: true });
  const awkPath = fixture.path('bin', 'awk');
  await writeFile(awkPath, `#!/bin/sh
case "$*" in
  */proc/meminfo*) printf '${availableKiB} ${totalKiB}\\n' ;;
  */proc/loadavg*|*/proc/pressure/*) printf '0\\n' ;;
  *) exec /usr/bin/awk "$@" ;;
esac
`);
  await chmod(awkPath, 0o755);
  // This remapped admission root is a worker, not the primary controller's
  // browser-protection floor. Preserve the class envelopes exercised below.
  const env = { ...process.env, PATH: `${fixture.path('bin')}:/usr/bin:/bin`, TMPDIR: fixture.root, HAPPIER_DEV_TARGET_EXECUTION: '1' };
  // These memory-only physical-worker fixtures have no install/build closure.
  // An execution host's cache configuration must not enable disk admission.
  delete env.HAPPIER_STACK_PM_CACHE_BASE_DIR;
  for (const key of Object.keys(env)) {
    if (key.startsWith('HAPPIER_HEAVYWEIGHT_ADMISSION_')) delete env[key];
  }
  return env;
}

function classFloor(className) {
  const result = spawnSync('/bin/sh', ['-c', '. "$1"; heavyweight_memory_floor_kib "$2"', 'memory-policy', policy, className], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return Number(result.stdout.trim());
}

async function admittedOwner(t, fixture, {
  root = fixture.path('old-cli-home', 'heavyweight-admission-v1'), resident = false,
  env = process.env, nestedLauncher = null,
} = {}) {
  const descendantScript = 'globalThis.resident = Buffer.alloc(64 * 1024 * 1024, 1); process.stdout.write("ready\\n"); setInterval(() => {}, 1000);';
  const script = `
    const fs = require('node:fs');
    const path = require('node:path');
    const token = process.env.HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN.split(':')[1];
    const ownerPath = path.join(process.env.HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT, 'owners', process.pid + '-' + token);
    fs.mkdirSync(ownerPath, { recursive: true });
    fs.writeFileSync(path.join(ownerPath, 'process'), process.pid + ' ' + token + '\\n');
    fs.writeFileSync(path.join(ownerPath, 'class'), 'runtime-build\\n');
    fs.writeFileSync(path.join(ownerPath, 'machine'), process.env.HAPPIER_HEAVYWEIGHT_ADMISSION_MACHINE + '\\n');
    ${resident ? "globalThis.resident = Buffer.alloc(64 * 1024 * 1024, 1);" : ''}
    const descendant = ${resident
      ? `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendantScript)}], { env: {}, stdio: ['ignore', 'pipe', 'ignore'] })`
      : "require('node:child_process').spawn('/bin/sleep', ['60'], { stdio: 'ignore' })"};
    process.on('SIGTERM', () => {
      if (descendant.exitCode !== null || descendant.signalCode !== null) process.exit(0);
      descendant.once('exit', () => process.exit(0));
      descendant.kill('SIGTERM');
    });
    ${resident ? "descendant.stdout.once('data'," : "descendant.once('spawn',"} () => process.stdout.write(JSON.stringify({ ownerPath, token, descendantPid: descendant.pid }) + '\\n'));
    ${nestedLauncher ? `process.on('SIGUSR2', () => {
      const result = require('node:child_process').spawnSync('/bin/sh', [${JSON.stringify(nestedLauncher)},
        '--heavyweight-admission', '--class=compilation', '--machine=local', '--no-wait', '--',
        '/usr/bin/printf', 'escalation-admitted\\n'], { encoding: 'utf8' });
      process.stdout.write(JSON.stringify({ status: result.status, stdout: result.stdout, stderr: result.stderr }) + '\\n');
    });` : ''}
    setInterval(() => {}, 1000);
  `;
  const child = spawn('/bin/sh', ['-c', `
    . "$1"
    owner_token=$(heavyweight_process_token "$$")
    export HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT="$2"
    export HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN="$$:$owner_token"
    . "$5"
    export HAPPIER_HEAVYWEIGHT_ADMISSION_MACHINE="$(resolve_native_host_admission_machine)"
    exec "$3" -e "$4"
  `, 'admitted-owner', identity, root, process.execPath, script, hostState], { env, stdio: ['ignore', 'pipe', 'ignore'] });
  const exited = new Promise(resolve => child.once('exit', resolve));
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    await exited;
  });
  const record = JSON.parse(await new Promise(resolve => child.stdout.once('data', data => resolve(String(data)))));
  return { child, root, ...record };
}

test('native memory observation authenticates live owners before workspace dependencies are installed', { skip: process.platform !== 'linux' }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-fresh-memory-observer-' });
  const sourceDir = fixture.path('fresh', 'apps', 'stack', 'scripts', 'utils');
  const procDir = `${sourceDir}/proc`;
  const pathsDir = `${sourceDir}/paths`;
  await Promise.all([mkdir(procDir, { recursive: true }), mkdir(pathsDir, { recursive: true })]);
  await mkdir(`${sourceDir}/dev_targets`);
  for (const relative of ['proc/service_memory.mjs', 'proc/native_process_identity.sh', 'paths/canonical_home.mjs', 'paths/paths.mjs', 'dev_targets/heavyweight_pressure_cadence.mjs']) {
    await copyFile(fileURLToPath(new URL(`../${relative}`, import.meta.url)), `${sourceDir}/${relative}`);
  }
  await mkdir(fixture.path('fresh', 'packages', 'cli-common'), { recursive: true });
  await copyFile(fileURLToPath(new URL('../../../../../packages/cli-common/processInstance.mjs', import.meta.url)), fixture.path('fresh', 'packages', 'cli-common', 'processInstance.mjs'));
  await assert.rejects(access(fixture.path('fresh', 'node_modules')), { code: 'ENOENT' });
  const admissionRoot = fixture.path('admission');
  const stackDir = fixture.path('stack');
  await mkdir(stackDir);
  const envPath = fixture.path('stack', 'env');
  await writeFile(envPath, '');
  const owner = await admittedOwner(t, fixture, {
    root: admissionRoot,
    env: { ...process.env, HAPPIER_STACK_STACK: 'fresh-memory-fixture', HAPPIER_STACK_ENV_FILE: envPath },
  });
  const statePath = fixture.path('stack', 'stack.runtime.json');
  await recordStackRuntimeStart(statePath, { stackName: 'fresh-memory-fixture', ownerPid: process.pid });
  await recordStackRuntimeUpdate(statePath, { processes: { serverPid: owner.child.pid } });
  const observe = () => spawnSync(process.execPath, [`${procDir}/service_memory.mjs`,
    `--admission-root=${admissionRoot}`, '--include-admitted-rss'], { encoding: 'utf8' });
  const sample = observe();
  assert.equal(sample.status, 0, sample.stderr);
  assert.match(sample.stdout, /^service [1-9]\d*$/m, 'the real canonical service state remains observable');
  const admittedRow = new RegExp(`^admitted ${owner.child.pid} ${owner.token} [1-9]\\d*$`, 'm');
  assert.match(sample.stdout, admittedRow, 'the fresh observer authenticates the live kernel generation and reports RSS');
  await writeFile(`${owner.ownerPath}/process`, `${owner.child.pid} 0\n`);
  const invalid = observe();
  assert.equal(invalid.status, 0, invalid.stderr);
  assert.doesNotMatch(invalid.stdout, admittedRow, 'an inherited token cannot authorize a mismatched owner record');
});

test('admission diagnostics authenticate owner class, age and recent tree CPU progress without changing custody', { skip: process.platform !== 'linux' }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-owner-progress-' });
  const owner = await admittedOwner(t, fixture, { root: fixture.path('admission') });
  const all = readLinuxWorkerProcesses();
  const processes = new Map([owner.child.pid, owner.descendantPid].map(pid => [pid, { ...all.get(pid) }]));
  processes.get(owner.child.pid).ageSeconds = 14400;
  processes.get(owner.child.pid).cpuSeconds = 5;
  processes.get(owner.descendantPid).cpuSeconds = 1;
  const observe = (nowMs, previousProgress) => readWorkerMemoryReservations({
    admissionRoot: owner.root, readProcesses: () => processes, includeOwnerProgress: true, nowMs, previousProgress,
  });
  await writeFile(`${owner.ownerPath}/phase`, 'awaiting-runtime-request\n');
  assert.equal(writeRuntimeAdmissionPhase('building-runtime', {
    HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT: owner.root,
    HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN: `${owner.child.pid}:${owner.token}`,
  }), false, 'an unrelated live owner is not phase-write authority');
  assert.equal(await readFile(`${owner.ownerPath}/phase`, 'utf8'), 'awaiting-runtime-request\n');
  const first = observe(1000);
  assert.equal(first.ownerProgress?.owners.length, 1);
  assert.deepEqual(first.ownerProgress.owners[0], {
    pid: owner.child.pid, token: owner.token, className: 'runtime-build', ageSeconds: 14400,
    cpuSeconds: 6, recentCpuPercent: null, phase: 'awaiting-runtime-request',
  });
  const idle = observe(5000, first.ownerProgress);
  assert.equal(idle.ownerProgress.owners[0].recentCpuPercent, 0);
  processes.get(owner.descendantPid).cpuSeconds += 2;
  await writeFile(`${owner.ownerPath}/phase`, 'building-runtime\n');
  const active = observe(9000, idle.ownerProgress);
  assert.equal(active.ownerProgress.owners[0].phase, 'building-runtime');
  assert.equal(active.ownerProgress.owners[0].recentCpuPercent, 50, 'CPU progress includes the actual descendant tree');
  await writeFile(`${owner.ownerPath}/process`, `${owner.child.pid} 0\n`);
  assert.deepEqual(observe(13000, active.ownerProgress).ownerProgress.owners, [], 'mismatched owner identity is never reported as live');
  await mkdir(fixture.path('invalid'));
  await writeFile(fixture.path('invalid', 'owners'), 'not a directory');
  assert.throws(() => readWorkerMemoryReservations({ admissionRoot: fixture.path('invalid'),
    readProcesses: () => processes, includeOwnerProgress: true }), /ENOTDIR/,
  'unobservable owner state must not be advertised as no live holders');
});

test('native runtime phase writer distinguishes waiting from work and releases its phase on cancellation', { skip: process.platform !== 'linux', timeout: 15000 }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-runtime-phase-' });
  const native = await installNativeAdmissionFixture({ root: fixture.root });
  const env = await memoryBoundary(fixture, { availableKiB: 28000000, totalKiB: 30000000 });
  // Physical worker boundary. Exercise the real phase writer under native
  // custody; runtime transport itself is covered by remote_runtime_build tests.
  const worker = `import { writeRuntimeAdmissionPhase } from ${JSON.stringify(new URL('./service_memory.mjs', import.meta.url).href)};
writeRuntimeAdmissionPhase('awaiting-runtime-request');
process.stdout.write('worker-ready\\n');
process.stdin.once('data', () => { writeRuntimeAdmissionPhase('building-runtime'); });
setInterval(() => {}, 1000);`;
  const child = spawn('/bin/sh', [native.launcher, '--heavyweight-admission', '--class=runtime-build', '--',
    'env', process.execPath, '--input-type=module', '-e', worker],
  { cwd: fixture.root, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const completion = new Promise(resolve => child.once('close', resolve));
  t.after(async () => { if (child.exitCode === null) child.kill('SIGTERM'); await completion; });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const observe = () => readWorkerMemoryReservations({ admissionRoot: native.admissionRoot, includeOwnerProgress: true,
    // This fixture is a physical worker; exclude the runner's real admission
    // root at the OS snapshot boundary, just as the native fixture does.
    readProcesses: () => {
      const ownerPids = new Set(readdirSync(`${native.admissionRoot}/owners`).map(name => Number(name.split('-')[0])));
      return new Map([...readLinuxWorkerProcesses()].filter(([pid, record]) => ownerPids.has(pid)
        || record.env.HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT === native.admissionRoot));
    },
  }).ownerProgress.owners;
  for (let attempt = 0; attempt < 500 && !stdout.includes('worker-ready'); attempt++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.match(stdout, /worker-ready/, stderr);
  assert.equal(observe()[0]?.phase, 'awaiting-runtime-request');
  child.stdin.write('begin-work\n');
  for (let attempt = 0; attempt < 500 && observe()[0]?.phase !== 'building-runtime'; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(observe()[0]?.phase, 'building-runtime');
  child.kill('SIGTERM');
  await completion;
  assert.deepEqual(observe(), []);
  assert.deepEqual(await import('node:fs/promises').then(fs => fs.readdir(`${native.admissionRoot}/owners`)), []);
});

test('a real waiting admission reports its live holder and recent CPU without terminating it', { skip: process.platform !== 'linux', timeout: 15000 }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-waiting-progress-' });
  const observedPidsPath = fixture.path('worker-pids.json');
  const native = await installNativeAdmissionFixture({ root: fixture.root, observedPidsPath });
  const owner = await admittedOwner(t, fixture, { root: native.admissionRoot });
  await writeFile(`${owner.ownerPath}/class`, 'validation\n');
  await writeFile(observedPidsPath, JSON.stringify([owner.child.pid, owner.descendantPid]));
  const env = await memoryBoundary(fixture, { availableKiB: classFloor('validation'), totalKiB: classFloor('compilation') * 2 });
  const child = spawn('/bin/sh', [native.launcher, '--heavyweight-admission', '--class=runtime-build', '--machine=fixture', '--', '/usr/bin/printf', 'unexpected-payload'], { cwd: fixture.root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const completion = new Promise(resolve => child.once('close', resolve));
  t.after(async () => { if (child.exitCode === null) child.kill('SIGTERM'); await completion; });
  let stderr = '', stdout = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', chunk => { stdout += chunk; });
  for (let attempt = 0; attempt < 500 && !stderr.includes('recent CPU=~'); attempt++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.match(stderr, new RegExp(`waiting behind validation owner pid ${owner.child.pid}.*age=\\d+s.*recent CPU=~[\\d.]+%`));
  assert.equal(stdout, '');
  assert.equal(owner.child.exitCode, null);
  const status = spawnSync(process.execPath, [fileURLToPath(new URL('./service_memory.mjs', import.meta.url)), `--admission-root=${native.admissionRoot}`, '--admission-status'], { encoding: 'utf8' });
  assert.equal(status.status, 0, status.stderr);
  const observed = JSON.parse(status.stdout);
  assert.equal(observed.owners[0].pid, owner.child.pid);
  assert.equal(observed.owners[0].className, 'validation');
  assert.ok(Number.isFinite(observed.owners[0].recentCpuPercent));
  assert.equal(owner.child.exitCode, null);
});

test('native admission preserves available headroom already consumed by an admitted owner and its descendants', { skip: process.platform !== 'linux' }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-admitted-rss-' });
  const observedPidsPath = fixture.path('worker-pids.json');
  const { launcher, admissionRoot } = await installNativeAdmissionFixture({ root: fixture.root, observedPidsPath });
  const owner = await admittedOwner(t, fixture, { root: admissionRoot, resident: true });
  await writeFile(observedPidsPath, JSON.stringify([owner.child.pid, owner.descendantPid]));
  const processes = readLinuxWorkerProcesses();
  const ownerMemoryKiB = processes.get(owner.child.pid).pssKiB ?? processes.get(owner.child.pid).rssKiB;
  const descendantMemoryKiB = processes.get(owner.descendantPid).pssKiB ?? processes.get(owner.descendantPid).rssKiB;
  assert.ok(descendantMemoryKiB > 64 * 1024, 'the real untagged descendant consumes memory');
  const suiteKiB = classFloor('validation');
  const buildKiB = classFloor('runtime-build');
  // Owner memory alone is insufficient: the actual descendant must also release
  // its already-consumed portion of the envelope from future reservations.
  const availableKiB = buildKiB + suiteKiB - ownerMemoryKiB - Math.floor(descendantMemoryKiB / 2);
  const env = await memoryBoundary(fixture, { availableKiB, totalKiB: buildKiB + suiteKiB * 2 });
  const admitted = spawnSync('/bin/sh', [launcher, '--heavyweight-admission',
    '--class=validation', '--machine=local', '--no-wait', '--',
    '/usr/bin/printf', 'resident-headroom-admitted\\n'], { env, encoding: 'utf8' });
  assert.equal(admitted.status, 0, admitted.stderr);
  assert.equal(admitted.stdout, 'resident-headroom-admitted\n');
  const busyEnv = await memoryBoundary(fixture, {
    availableKiB: buildKiB + suiteKiB - ownerMemoryKiB - descendantMemoryKiB - 64 * 1024,
    totalKiB: buildKiB + suiteKiB * 2,
  });
  const busy = spawnSync('/bin/sh', [launcher, '--heavyweight-admission',
    '--class=validation', '--machine=local', '--no-wait', '--', 'true'], { env: busyEnv, encoding: 'utf8' });
  assert.equal(busy.status, 75, busy.stderr);
  await writeFile(observedPidsPath, '[]');
  const unavailable = spawnSync('/bin/sh', [launcher, '--heavyweight-admission',
    '--class=validation', '--machine=local', '--no-wait', '--', 'true'], { env, encoding: 'utf8' });
  assert.equal(unavailable.status, 75, 'an owner missing from the OS snapshot retains its full reservation');
});

test('native admission escalation credits the authenticated inherited owner resident envelope', { skip: process.platform !== 'linux' }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-escalation-rss-' });
  const observedPidsPath = fixture.path('worker-pids.json');
  const { launcher, admissionRoot } = await installNativeAdmissionFixture({ root: fixture.root, observedPidsPath });
  const compilationKiB = classFloor('compilation');
  const env = await memoryBoundary(fixture, {
    availableKiB: compilationKiB - 64 * 1024, totalKiB: compilationKiB + classFloor('validation'),
  });
  const owner = await admittedOwner(t, fixture, { root: admissionRoot, resident: true, env, nestedLauncher: launcher });
  const requestEscalation = async () => {
    const resultPromise = new Promise(resolve => owner.child.stdout.once('data', data => resolve(JSON.parse(String(data)))));
    owner.child.kill('SIGUSR2');
    return resultPromise;
  };
  await writeFile(observedPidsPath, '[]');
  assert.equal((await requestEscalation()).status, 75, 'unobserved own RSS retains the requested floor');
  await writeFile(observedPidsPath, JSON.stringify([owner.child.pid, owner.descendantPid]));
  await memoryBoundary(fixture, { availableKiB: compilationKiB, totalKiB: compilationKiB - 1 });
  assert.equal((await requestEscalation()).status, 1, 'resident RSS cannot make an undersized physical host capable');
  await memoryBoundary(fixture, {
    availableKiB: compilationKiB - 64 * 1024, totalKiB: compilationKiB + classFloor('validation'),
  });
  const result = await requestEscalation();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'escalation-admitted\n');
  assert.equal((await readFile(`${owner.ownerPath}/class`, 'utf8')).trim(), 'compilation',
    'escalation replaces the inherited class envelope');
});

test('native admission rejects a compilation that cannot fit beside a recorded live service', { skip: process.platform !== 'linux' }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-service-memory-' });
  const observedPidsPath = fixture.path('worker-pids.json');
  const { launcher } = await installNativeAdmissionFixture({ root: fixture.root, observedPidsPath });
  const stackDir = fixture.path('stack');
  const envPath = fixture.path('stack', 'env');
  await mkdir(stackDir);
  await writeFile(envPath, '');
  await writeFile(fixture.path('stack', 'dev-targets.json'), JSON.stringify({
    version: 3,
    targets: [],
    runtimePlacement: { server: { mode: 'local' }, expo: { mode: 'local' }, daemon: { mode: 'local' } },
    commandExecution: { mode: 'local' },
  }));
  const service = spawn(process.execPath, ['-e', 'process.stdout.write("ready\\n"); setInterval(() => {}, 1000);'], {
    env: { ...process.env, HAPPIER_STACK_STACK: 'service-fixture', HAPPIER_STACK_ENV_FILE: envPath },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const exited = new Promise(resolve => service.once('exit', resolve));
  t.after(async () => {
    if (service.exitCode === null) service.kill('SIGTERM');
    await exited;
  });
  await new Promise(resolve => service.stdout.once('data', resolve));
  await writeFile(observedPidsPath, JSON.stringify([service.pid]));
  const statePath = fixture.path('stack', 'stack.runtime.json');
  await recordStackRuntimeStart(statePath, { stackName: 'service-fixture', ownerPid: process.pid });
  await recordStackRuntimeUpdate(statePath, { processes: { serverPid: service.pid } });
  const resident = readLinuxWorkerProcesses().get(service.pid);
  const serviceMemoryKiB = resident.pssKiB ?? resident.rssKiB;
  assert.ok(serviceMemoryKiB > 0);
  const compilationKiB = classFloor('compilation');
  const totalKiB = compilationKiB + Math.floor(serviceMemoryKiB / 2);
  // Only the OS resource boundary is replaced; process discovery, canonical
  // runtime PID recording, generation checks and native admission remain real.
  const env = await memoryBoundary(fixture, { availableKiB: totalKiB, totalKiB });
  const result = spawnSync('/bin/sh', [launcher, '--heavyweight-admission',
    '--class=compilation', '--machine=local', '--no-wait', '--', 'true'], {
    env, encoding: 'utf8',
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /service-reserved-memory=[1-9]\d*/);
  const suiteKiB = classFloor('validation');
  const admitted = spawnSync('/bin/sh', [launcher, '--heavyweight-admission',
    '--class=validation', '--machine=local', '--no-wait', '--',
    '/usr/bin/printf', 'smaller-suite-admitted\n'], { env, encoding: 'utf8' });
  assert.equal(admitted.status, 0, admitted.stderr);
  assert.equal(admitted.stdout, 'smaller-suite-admitted\n');
  // MemAvailable already reflects resident service memory. Removing it from
  // it again would reject this valid suite despite sufficient physical capacity.
  const availableEnv = await memoryBoundary(fixture, {
    availableKiB: suiteKiB + Math.floor(serviceMemoryKiB / 2),
    totalKiB: suiteKiB + serviceMemoryKiB * 2,
  });
  const available = spawnSync('/bin/sh', [launcher, '--heavyweight-admission',
    '--class=validation', '--machine=local', '--no-wait', '--',
    '/usr/bin/printf', 'available-memory-preserved\n'], { env: availableEnv, encoding: 'utf8' });
  assert.equal(available.status, 0, available.stderr);
  assert.equal(available.stdout, 'available-memory-preserved\n');
});

test('native admission counts a live pre-cutover owner in its original CLI-home root', { skip: process.platform !== 'linux' }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-legacy-memory-' });
  const observedPidsPath = fixture.path('worker-pids.json');
  const { launcher, admissionRoot } = await installNativeAdmissionFixture({ root: fixture.root, observedPidsPath });
  const owner = await admittedOwner(t, fixture);
  await writeFile(observedPidsPath, JSON.stringify([owner.child.pid, owner.descendantPid]));
  const suiteKiB = classFloor('validation');
  const buildKiB = classFloor('runtime-build');
  const env = await memoryBoundary(fixture, {
    availableKiB: buildKiB + Math.floor(suiteKiB / 2), totalKiB: buildKiB + suiteKiB * 2,
  });
  const result = spawnSync('/bin/sh', [launcher, '--heavyweight-admission',
    '--class=validation', '--machine=local', '--no-wait', '--', 'true'], {
    env, encoding: 'utf8',
  });
  assert.equal(result.status, 75, result.stderr);
  // A pre-cutover sibling can escalate the old envelope after migration.
  // Matching identity must merge the larger class, not hide the legacy row.
  const migrated = `${admissionRoot}/owners/${owner.child.pid}-${owner.token}`;
  await mkdir(migrated, { recursive: true });
  await writeFile(`${migrated}/process`, `${owner.child.pid} ${owner.token}\n`);
  await writeFile(`${migrated}/class`, 'validation\n');
  const afterMigration = spawnSync('/bin/sh', [launcher, '--heavyweight-admission',
    '--class=validation', '--machine=local', '--no-wait', '--', 'true'], { env, encoding: 'utf8' });
  assert.equal(afterMigration.status, 75, afterMigration.stderr);
  const check = spawnSync('/bin/sh', [launcher, '--heavyweight-admission-check',
    '--class=validation', '--machine=local'], { env, encoding: 'utf8' });
  assert.equal(check.status, 1, check.stderr);
  const reservedKiB = Number(/ reserved-memory=(\d+)/.exec(check.stderr)?.[1]);
  assert.ok(reservedKiB > suiteKiB && reservedKiB < buildKiB,
    'migration merges the larger legacy class and credits resident memory exactly once');
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

test('legacy observation validates the original owner, deduplicates inherited tokens and ignores current-root owners', { skip: process.platform !== 'linux' }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-legacy-rss-' });
  const owner = await admittedOwner(t, fixture);
  const all = readLinuxWorkerProcesses();
  const snapshot = new Map([owner.child.pid, owner.descendantPid].map(pid => [pid, all.get(pid)]));
  assert.ok([...snapshot.values()].every(Boolean));
  const observe = admissionRoot => readWorkerMemoryReservations({ admissionRoot, readProcesses: () => snapshot });
  assert.deepEqual(observe(fixture.path('current')).legacyOwners, [{
    pid: owner.child.pid, token: owner.token, className: 'runtime-build', ownerPath: owner.ownerPath,
  }]);
  assert.deepEqual(observe(owner.root).legacyOwners, []);
  assert.doesNotMatch(renderWorkerMemoryReservationRows(observe(fixture.path('current'))), /^admitted /m,
    'an already-loaded launcher keeps its original row protocol');
  const observeRss = admissionRoot => readWorkerMemoryReservations({ admissionRoot, readProcesses: () => snapshot, includeAdmittedRss: true });
  const expected = [{
    pid: owner.child.pid, token: owner.token,
    rssKiB: (snapshot.get(owner.child.pid).pssKiB ?? snapshot.get(owner.child.pid).rssKiB)
      + (snapshot.get(owner.descendantPid).pssKiB ?? snapshot.get(owner.descendantPid).rssKiB),
  }];
  assert.deepEqual(observeRss(fixture.path('current')).admittedOwners, expected);
  assert.deepEqual(observeRss(owner.root).admittedOwners, expected, 'canonical owners use the same authenticated RSS observation');
  const expectedRecords = [{ pid: owner.child.pid, token: owner.token, ownerPaths: [owner.ownerPath] }];
  assert.deepEqual(observeRss(fixture.path('current')).admittedOwnerRecords, expectedRecords);
  assert.deepEqual(observeRss(owner.root).admittedOwnerRecords, expectedRecords);
  const migrated = fixture.path('current', 'owners', `${owner.child.pid}-${owner.token}`);
  await mkdir(migrated, { recursive: true });
  await writeFile(`${migrated}/process`, `${owner.child.pid} ${owner.token}\n`);
  await writeFile(`${migrated}/class`, 'validation\n');
  assert.deepEqual(observeRss(fixture.path('current')).admittedOwners, expected,
    'canonical and legacy records credit the same process incarnation once');
  assert.deepEqual(observeRss(fixture.path('current')).admittedOwnerRecords, [{ ...expectedRecords[0], ownerPaths: [migrated, owner.ownerPath] }]);

  const readAtBoundary = fs.readFileSync;
  const read = t.mock.method(fs, 'readFileSync', (path, ...args) => {
    if (path === `${owner.ownerPath}/process`) {
      throw Object.assign(new Error('legacy identity permission denied'), { code: 'EACCES' });
    }
    return readAtBoundary(path, ...args);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => readWorkerMemoryReservations({
      admissionRoot: fixture.path('current'), readProcesses: () => snapshot, includeOwnerProgress: true,
    }), { code: 'EACCES' }, 'a legacy authentication error is not proof of retirement');
  } finally {
    read.mock.restore();
    syncBuiltinESMExports();
  }
  const fingerprint = snapshot.get(owner.child.pid).fingerprint;
  snapshot.get(owner.child.pid).fingerprint = 'linux-proc:0';
  assert.deepEqual(observeRss(fixture.path('current')).admittedOwners, [], 'reused owner PIDs grant no RSS credit');
  snapshot.get(owner.child.pid).fingerprint = fingerprint;
  // Detached custody can outlive its original parent edge while its admitted
  // owner remains live. Change only that OS ancestry boundary in the snapshot.
  snapshot.get(owner.descendantPid).parentPid = 1;
  assert.deepEqual(observeRss(fixture.path('current')).admittedOwners, expected,
    'inherited authenticated custody is counted even after reparenting');
  const descendant = snapshot.get(owner.descendantPid);
  snapshot.set(owner.descendantPid, { ...descendant, rssKiB: undefined, pssKiB: null });
  assert.deepEqual(observeRss(owner.root).admittedOwners, [], 'unavailable tree RSS must not release the reservation');
  assert.deepEqual(observeRss(owner.root).admittedOwnerRecords, [{ pid: owner.child.pid, token: owner.token, ownerPaths: [owner.ownerPath] }],
    'unavailable RSS does not retire an authenticated disk owner');
  snapshot.set(owner.descendantPid, descendant);
  await writeFile(`${owner.ownerPath}/process`, `${owner.child.pid} 0\n`);
  assert.deepEqual(observe(fixture.path('current')).legacyOwners, [], 'a live inherited token cannot authorize a mismatched owner record');
  assert.deepEqual(observeRss(owner.root).admittedOwners, [], 'mismatched canonical records also cannot grant RSS credit');
  await writeFile(`${owner.ownerPath}/process`, `${owner.child.pid} ${owner.token}\n`);
  const exited = new Promise(resolve => owner.child.once('exit', resolve));
  owner.child.kill('SIGTERM');
  await exited;
  assert.deepEqual(readWorkerMemoryReservations({ admissionRoot: fixture.path('current') }).legacyOwners
    .filter(record => record.pid === owner.child.pid), [], 'an exited owner cannot keep its old reservation live');
});
