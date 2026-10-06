import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { installNativeAdmissionFixture } from '../../testkit/core/native_admission_fixture.mjs';
import { recordStackRuntimeStart, recordStackRuntimeUpdate } from '../stack/runtime_state.mjs';
import { writePidState } from '../expo/expo.mjs';
import { readLinuxWorkerProcesses, readWorkerMemoryReservations } from './service_memory.mjs';

const policy = fileURLToPath(new URL('../dev_targets/native_command_policy.sh', import.meta.url));
const identity = fileURLToPath(new URL('./native_process_identity.sh', import.meta.url));

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
  const env = { ...process.env, PATH: `${fixture.path('bin')}:/usr/bin:/bin`, TMPDIR: fixture.root };
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

async function legacyOwner(t, fixture) {
  const root = fixture.path('old-cli-home', 'heavyweight-admission-v1');
  const script = `
    const fs = require('node:fs');
    const path = require('node:path');
    const token = process.env.HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN.split(':')[1];
    const ownerPath = path.join(process.env.HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT, 'owners', process.pid + '-' + token);
    fs.mkdirSync(ownerPath, { recursive: true });
    fs.writeFileSync(path.join(ownerPath, 'process'), process.pid + ' ' + token + '\\n');
    fs.writeFileSync(path.join(ownerPath, 'class'), 'runtime-build\\n');
    const descendant = require('node:child_process').spawn('/bin/sleep', ['60'], { stdio: 'ignore' });
    process.on('SIGTERM', () => {
      if (descendant.exitCode !== null || descendant.signalCode !== null) process.exit(0);
      descendant.once('exit', () => process.exit(0));
      descendant.kill('SIGTERM');
    });
    descendant.once('spawn', () => process.stdout.write(JSON.stringify({ ownerPath, token, descendantPid: descendant.pid }) + '\\n'));
    setInterval(() => {}, 1000);
  `;
  const child = spawn('/bin/sh', ['-c', `
    . "$1"
    owner_token=$(heavyweight_process_token "$$")
    export HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT="$2"
    export HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN="$$:$owner_token"
    exec "$3" -e "$4"
  `, 'legacy-owner', identity, root, process.execPath, script], { stdio: ['ignore', 'pipe', 'ignore'] });
  const exited = new Promise(resolve => child.once('exit', resolve));
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    await exited;
  });
  const record = JSON.parse(await new Promise(resolve => child.stdout.once('data', data => resolve(String(data)))));
  return { child, root, ...record };
}

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
  const resident = spawnSync('ps', ['-o', 'rss=', '-p', String(service.pid)], { encoding: 'utf8' });
  assert.equal(resident.status, 0, resident.stderr);
  const serviceRssKiB = Number(resident.stdout.trim());
  assert.ok(serviceRssKiB > 0);
  const compilationKiB = classFloor('compilation');
  const totalKiB = compilationKiB + Math.floor(serviceRssKiB / 2);
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
  // MemAvailable already reflects resident service memory. Removing RSS from
  // it again would reject this valid suite despite sufficient physical capacity.
  const availableEnv = await memoryBoundary(fixture, {
    availableKiB: suiteKiB + Math.floor(serviceRssKiB / 2),
    totalKiB: suiteKiB + serviceRssKiB * 2,
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
  const owner = await legacyOwner(t, fixture);
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
  assert.match(check.stderr, new RegExp(`reserved-memory=${buildKiB}`));
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
  assert.equal(sample.serviceRssKiB, snapshot.get(service.pid).rssKiB + snapshot.get(descendantPid).rssKiB);
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
});

test('legacy observation validates the original owner, deduplicates inherited tokens and ignores current-root owners', { skip: process.platform !== 'linux' }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-legacy-rss-' });
  const owner = await legacyOwner(t, fixture);
  const all = readLinuxWorkerProcesses();
  const snapshot = new Map([owner.child.pid, owner.descendantPid].map(pid => [pid, all.get(pid)]));
  assert.ok([...snapshot.values()].every(Boolean));
  const observe = admissionRoot => readWorkerMemoryReservations({ admissionRoot, readProcesses: () => snapshot });
  assert.deepEqual(observe(fixture.path('current')).legacyOwners, [{
    pid: owner.child.pid, token: owner.token, className: 'runtime-build',
  }]);
  assert.deepEqual(observe(owner.root).legacyOwners, []);
  await writeFile(`${owner.ownerPath}/process`, `${owner.child.pid} 0\n`);
  assert.deepEqual(observe(fixture.path('current')).legacyOwners, [], 'a live inherited token cannot authorize a mismatched owner record');
  await writeFile(`${owner.ownerPath}/process`, `${owner.child.pid} ${owner.token}\n`);
  const exited = new Promise(resolve => owner.child.once('exit', resolve));
  owner.child.kill('SIGTERM');
  await exited;
  assert.deepEqual(readWorkerMemoryReservations({ admissionRoot: fixture.path('current') }).legacyOwners
    .filter(record => record.pid === owner.child.pid), [], 'an exited owner cannot keep its old reservation live');
});
