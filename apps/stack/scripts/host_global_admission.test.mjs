import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { createConnection, createServer } from 'node:net';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createTempFixture } from './testkit/core/temp_fixture.mjs';
import { withPatchedProcessEnv } from './testkit/core/env_scope.mjs';
import { writeFakeBin } from './testkit/core/fake_bin_harness.mjs';
import { buildNativeAdmissionFixtureEnv, holdNativeAdmissionFixtureMemory, installNativeAdmissionFixture } from './testkit/core/native_admission_fixture.mjs';
import { withWorkspaceBundleLock } from '../../../packages/cli-common/workspaceBundleLock.mjs';
import { resolveHeavyweightMemoryFloorKiB } from './utils/dev_targets/remote_commands.mjs';
import { DEFAULT_FILE_CHANGE_CATCH_UP_MS } from '../../../packages/cli-common/fileChangeObserver.mjs';

// Standalone fixture leases are not the routed runner's charged workspace
// leases. Native-admission fixtures explicitly supply their own restrictions.
withPatchedProcessEnv(test, { HAPPIER_WORKSPACE_DIST_BUILD_LOCK_WAIT_ALLOWED: undefined });

async function waitForJointAdmission(condition, child, diagnostic) {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (await condition()) return;
    if (child?.exitCode !== null && child?.exitCode !== undefined) {
      throw new Error(`joint admission exited before the observed condition: ${diagnostic()}`);
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`joint admission condition was not reached: ${diagnostic()}`);
}

async function createJointAdmissionFixture(t, available = 9437184) {
  const fixture = await createTempFixture(t, { prefix: 'host-joint-workspace-' });
  const observedPidsPath = fixture.path('worker-pids.json');
  await writeFile(observedPidsPath, '[]');
  const native = await installNativeAdmissionFixture({ root: fixture.root, observedPidsPath });
  const { launcher } = native;
  const memory = fixture.path('memory');
  await writeFile(memory, `${available} 73400320\n`);
  writeFakeBin({ root: fixture.root, name: 'awk', content: `#!/bin/sh
case "$*" in
  */proc/meminfo*) /usr/bin/awk '{print $1, $2}' "$FIXTURE_MEMORY" ;;
  *) exec /usr/bin/awk "$@" ;;
esac
` });
  writeFakeBin({ root: fixture.root, name: 'systemctl', content: '#!/bin/sh\nexit 1\n' });
  const env = { ...buildNativeAdmissionFixtureEnv(), PATH: `${fixture.path('bin')}:/usr/bin:/bin`, FIXTURE_MEMORY: memory,
    HAPPIER_STACK_PM_CACHE_BASE_DIR: '', HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: '', HAPPIER_WORKSPACE_DIST_BUILD_LOCK_LEASES: '',
    HAPPIER_WORKSPACE_DIST_BUILD_LOCK_WAIT_ALLOWED: '',
    HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN: '', HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT: '', HAPPIER_HEAVYWEIGHT_ADMISSION_MACHINE: '' };
  const start = (locks, args = ['/bin/sh', '-c', 'printf payload'], admissionClass = 'package-dist', options = []) => {
    const child = spawn('/bin/sh', [launcher, '--heavyweight-admission', `--class=${admissionClass}`, '--machine=worker',
      ...options,
      ...(locks === null ? [] : [`--workspace-locks=${JSON.stringify(locks)}`]), '--', ...args], { env });
    let stdout = '', stderr = '';
    child.stdout.on('data', value => { stdout += value; });
    child.stderr.on('data', value => { stderr += value; });
    const exited = new Promise(resolve => child.once('exit', (status, signal) => resolve({ status, signal })));
    const closed = new Promise(resolve => child.once('close', (status, signal) => resolve({ status, signal })));
    t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await exited; });
    return { child, exited, closed, stdout: () => stdout, stderr: () => stderr };
  };
  return { ...fixture, ...native, memory, env, start };
}

async function createSocketAdmissionFixture(t, totalSlots = 3) {
  const fixture = await createTempFixture(t, { prefix: 'host-broker-contract-' });
  const native = await installNativeAdmissionFixture({ root: fixture.root });
  const owner = process.env.HAPPIER_TEST_NATIVE_ADMISSION_BROKER
    ? pathToFileURL(process.env.HAPPIER_TEST_NATIVE_ADMISSION_BROKER).href
    : new URL('./utils/proc/admission_broker.mjs', import.meta.url).href;
  const { brokerAddress, createAdmissionBroker, readAdmissionMemorySample } = await import(owner);
  const floorKiB = resolveHeavyweightMemoryFloorKiB('validation');
  let availableMemoryKiB = floorKiB * totalSlots;
  let physicalReads = 0;
  const broker = createAdmissionBroker({ root: native.admissionRoot, oldLockPath: join(native.admissionRoot, 'old-admission.lock'), sampleResources: ({ slots }) => readAdmissionMemorySample({ slots,
    // OS memory and process observations are the only substituted boundary.
    readMemory: () => { physicalReads++; return { availableMemoryKiB, totalMemoryKiB: floorKiB * totalSlots }; },
    readProcesses: () => new Map(),
  }) });
  await broker.start();
  t.after(() => broker.close());
  const clients = [];
  t.after(async () => { for (const client of clients) await client.release(); });
  const acquire = (floor = floorKiB) => {
    const socket = createConnection(brokerAddress(native.admissionRoot));
    socket.on('error', () => {});
    const lines = createInterface({ input: socket });
    const messages = lines[Symbol.asyncIterator]();
    const peers = new Set();
    let witness;
    socket.write(JSON.stringify({ kind: 'acquire', className: 'validation', floorKiB: floor, pid: process.pid,
      repoDir: `${fixture.root}/native-owner`, cacheBaseDir: fixture.root, locks: [], env: buildNativeAdmissionFixtureEnv() }) + '\n');
    const admitted = (async () => {
      let reserved;
      for (;;) {
        const first = await messages.next();
        if (first.done) return { kind: 'closed' };
        reserved = JSON.parse(first.value);
        if (reserved.kind !== 'queued') break;
      }
      if (reserved.kind !== 'reserved') return reserved;
      witness = createServer(peer => { peers.add(peer); peer.on('error', () => {}); peer.once('close', () => peers.delete(peer)); });
      await new Promise((resolve, reject) => { witness.once('error', reject); witness.listen(reserved.slotAddress, resolve); });
      socket.write('{"kind":"ready"}\n');
      const final = await messages.next();
      return final.done ? { kind: 'closed' } : JSON.parse(final.value);
    })();
    admitted.catch(() => {});
    const client = { admitted, release: async () => {
      socket.destroy();
      lines.close();
      for (const peer of peers) peer.destroy();
      if (witness?.listening) await new Promise(resolve => witness.close(resolve));
      await Promise.allSettled([admitted]);
    } };
    clients.push(client);
    return client;
  };
  return { ...fixture, ...native, broker, floorKiB, acquire,
    physicalReads: () => physicalReads, setAvailable: value => { availableMemoryKiB = value; } };
}

test('broker samples once per arrival, release or shared recovery tick at the observed queue scale', { skip: process.platform !== 'linux', timeout: 30_000 }, async t => {
  // The clock is the substituted boundary; socket and capacity decisions stay real.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fixture = await createSocketAdmissionFixture(t);
  const holder = fixture.acquire(3 * fixture.floorKiB);
  assert.equal((await holder.admitted).kind, 'admitted');
  // LOAD-AUDIT E1 observed 273 waiters on nl3. Keep that actual queue scale.
  const waiters = Array.from({ length: 273 }, () => fixture.acquire());
  while (fixture.broker.status().waitingCount !== waiters.length) await new Promise(setImmediate);
  assert.equal(fixture.physicalReads(), 1 + 1 + waiters.length, 'one startup sample plus one per actual arrival');
  const before = fixture.physicalReads();
  t.mock.timers.tick(100);
  await new Promise(setImmediate);
  assert.equal(fixture.physicalReads(), before, 'queued demand performs no walks between recovery ticks');
  t.mock.timers.tick(DEFAULT_FILE_CHANGE_CATCH_UP_MS);
  while (fixture.broker.status().sampleCount === before) await new Promise(setImmediate);
  assert.equal(fixture.physicalReads(), before + 1, 'one shared recovery tick samples once for all 273 waiters');
  await holder.release();
  assert.equal((await waiters[0].admitted).kind, 'admitted', 'closing the holder pushes the oldest fitting request forward');
  assert.equal(fixture.physicalReads(), before + 2, 'one release performs exactly one new sample');
});

test('broker backfills spare capacity while preserving the waiting head and admitted floors', { skip: process.platform !== 'linux', timeout: 30_000 }, async t => {
  const fixture = await createSocketAdmissionFixture(t, 4);
  const holder = fixture.acquire(3 * fixture.floorKiB);
  assert.equal((await holder.admitted).kind, 'admitted');
  const large = fixture.acquire(2 * fixture.floorKiB);
  await waitForJointAdmission(() => fixture.broker.status().waitingCount === 1, null, () => JSON.stringify(fixture.broker.status()));
  const fitting = fixture.acquire();
  // Owner-approved admission-backfill-1106 replaces strict oldest-first admission.
  await waitForJointAdmission(() => fixture.broker.status().sampleCount === 4, null, () => JSON.stringify(fixture.broker.status()));
  assert.equal(fixture.broker.status().activeCount, 2, 'the head cannot use this spare memory until the older holder releases');
  assert.equal((await fitting.admitted).kind, 'admitted');
  assert.equal(fixture.broker.status().waitingCount, 1);
  assert.equal(fixture.broker.status().reservedMemoryKiB, 4 * fixture.floorKiB);
  await holder.release();
  assert.equal((await large.admitted).kind, 'admitted');
  assert.equal((await fitting.admitted).kind, 'admitted', 'backfill uses spare memory after covering the older floor');
  assert.equal(fixture.broker.status().reservedMemoryKiB, 3 * fixture.floorKiB, 'all admitted floors count even with no resident pages');
  const later = fixture.acquire(3 * fixture.floorKiB);
  await waitForJointAdmission(() => fixture.broker.status().waitingCount === 1, null, () => JSON.stringify(fixture.broker.status()));
  await fitting.release();
  await waitForJointAdmission(() => fixture.broker.status().activeCount === 1, null, () => JSON.stringify(fixture.broker.status()));
  assert.equal(fixture.broker.status().waitingCount, 1, 'the older fitting request takes capacity before its newer peer');
  assert.equal(fixture.broker.status().reservedMemoryKiB, 2 * fixture.floorKiB);
  await large.release();
  assert.equal((await later.admitted).kind, 'admitted');
  assert.equal(fixture.broker.status().reservedMemoryKiB, 3 * fixture.floorKiB);
});

test('broker backfill streams preserve released memory for the head and oldest fitting waiter order', { skip: process.platform !== 'linux', timeout: 30_000 }, async t => {
  const fixture = await createSocketAdmissionFixture(t, 8);
  const floor = fixture.floorKiB;
  const holders = [fixture.acquire(3 * floor), fixture.acquire(3 * floor)];
  for (const holder of holders) assert.equal((await holder.admitted).kind, 'admitted');
  const head = fixture.acquire(6 * floor);
  await waitForJointAdmission(() => fixture.broker.status().waitingCount === 1, null, () => JSON.stringify(fixture.broker.status()));
  const tooLarge = fixture.acquire(7 * floor);
  const small = Array.from({ length: 4 }, () => fixture.acquire());
  const order = [];
  head.admitted.then(value => { if (value.kind === 'admitted') order.push('head'); });
  small.forEach((client, index) => client.admitted.then(value => { if (value.kind === 'admitted') order.push(index); }));
  await waitForJointAdmission(() => fixture.broker.status().sampleCount === 9, null, () => JSON.stringify(fixture.broker.status()));
  assert.equal(fixture.broker.status().activeCount, 4, 'both fitting peers use spare capacity while the head waits');
  await Promise.all(small.slice(0, 2).map(client => client.admitted));
  assert.deepEqual(order, [0, 1], 'a non-fitting peer cannot reserve another floor ahead of fitting work');
  const beforeRelease = fixture.broker.status().sampleCount;
  await holders[0].release();
  await waitForJointAdmission(() => fixture.broker.status().sampleCount > beforeRelease, null, () => JSON.stringify(fixture.broker.status()));
  assert.equal(fixture.broker.status().activeCount, 3, 'new backfill cannot consume the older holder release');
  assert.equal(fixture.broker.status().unreservedMemoryKiB, 0, 'the released older floor is reserved for the head');
  for (const index of [0, 1]) {
    await small[index].release();
    assert.equal((await small[index + 2].admitted).kind, 'admitted');
    assert.deepEqual(order, Array.from({ length: index + 3 }, (_, value) => value), 'backfill reuses only its spare capacity in arrival order');
  }
  const next = fixture.acquire();
  await waitForJointAdmission(() => fixture.broker.status().waitingCount === 3, null, () => JSON.stringify(fixture.broker.status()));
  next.admitted.then(value => { if (value.kind === 'admitted') order.push('next'); });
  await holders[1].release();
  assert.equal((await head.admitted).kind, 'admitted', 'the second older release admits the head despite recurring small work');
  assert.deepEqual(order, [0, 1, 2, 3, 'head']);
  assert.equal(fixture.broker.status().reservedMemoryKiB, 8 * floor);
  assert.equal(fixture.broker.status().waitingCount, 2);
  await head.release();
  await small[2].release();
  assert.equal((await tooLarge.admitted).kind, 'admitted', 'the next head recovers capacity from earlier backfill');
  await small[3].release();
  assert.equal((await next.admitted).kind, 'admitted', 'a later fitting peer uses the remaining capacity');
});

test('nested package and validation commands share their containing compilation slot without another admission', { skip: process.platform !== 'linux', timeout: 30_000 }, async t => {
  const fixture = await createJointAdmissionFixture(t, 73400320);
  const clientOwner = pathToFileURL(fixture.admissionClientPath).href;
  const nested = `import { requestAdmissionSample } from ${JSON.stringify(clientOwner)};
process.stdout.write(JSON.stringify(await requestAdmissionSample(${JSON.stringify(fixture.admissionRoot)})));`;
  const payload = `import { spawnSync } from 'node:child_process';
import { requestAdmissionSample } from ${JSON.stringify(clientOwner)};
const before = await requestAdmissionSample(${JSON.stringify(fixture.admissionRoot)});
const children = [];
for (const className of ['package-dist', 'validation']) {
  const result = spawnSync('/bin/sh', [${JSON.stringify(fixture.launcher)}, '--heavyweight-admission', '--class=' + className,
    '--machine=worker', '--', process.execPath, '--input-type=module', '-e', ${JSON.stringify(nested)}], { env: process.env, encoding: 'utf8' });
  if (result.status !== 0) { process.stderr.write(result.stderr); process.exit(result.status ?? 1); }
  children.push(JSON.parse(result.stdout));
}
const after = await requestAdmissionSample(${JSON.stringify(fixture.admissionRoot)});
process.stdout.write(JSON.stringify({ before, children, after }));`;
  const run = fixture.start(null, [process.execPath, '--input-type=module', '-e', payload], 'compilation');
  assert.deepEqual(await run.exited, { status: 0, signal: null }, run.stderr());
  const { before, children, after } = JSON.parse(run.stdout());
  assert.equal(before.activeCount, 1);
  for (const sample of [...children, after]) {
    assert.equal(sample.activeCount, 1, 'nested commands retain their parent slot');
    assert.equal(sample.sampleCount, before.sampleCount, 'nested commands and cached status reads perform no new admission sample');
  }
  await waitForJointAdmission(async () => (await fixture.brokerStatus()).activeCount === 0, null, () => run.stderr());
});

test('workspace-blocked demand releases partial leases and capacity while unrelated work enters', { skip: process.platform !== 'linux', timeout: 30_000 }, async t => {
  const fixture = await createJointAdmissionFixture(t, 73400320);
  const first = fixture.path('first.lock');
  const foreign = fixture.path('foreign.lock');
  let blocked;
  await withWorkspaceBundleLock(async () => {
    blocked = fixture.start([{ path: first }, { path: foreign }], ['/usr/bin/printf', 'published']);
    await waitForJointAdmission(async () => { const status = await fixture.brokerStatus(); return status.waitingCount === 1 && status.activeCount === 0; },
      blocked.child, blocked.stderr);
    await assert.rejects(access(first), { code: 'ENOENT' }, 'a blocked group releases its partial scope');
    const plain = fixture.start(null, ['/usr/bin/printf', 'plain'], 'validation');
    assert.deepEqual(await plain.exited, { status: 0, signal: null }, plain.stderr());
    assert.equal(plain.stdout(), 'plain');
    assert.equal(blocked.stdout(), '');
  }, { lockPath: foreign, signal: t.signal });
  assert.deepEqual(await blocked.exited, { status: 0, signal: null }, blocked.stderr());
  assert.equal(blocked.stdout(), 'published', 'resource release wakes the existing request without relaunch');
  await assert.rejects(access(first), { code: 'ENOENT' });
});

test('cancelling a workspace-blocked command removes only its demand and acquired scope', { skip: process.platform !== 'linux', timeout: 30_000 }, async t => {
  const fixture = await createJointAdmissionFixture(t, 73400320);
  const first = fixture.path('first.lock');
  const foreign = fixture.path('foreign.lock');
  await withWorkspaceBundleLock(async () => {
    const run = fixture.start([{ path: first }, { path: foreign }], ['/usr/bin/printf', 'unexpected']);
    await waitForJointAdmission(async () => (await fixture.brokerStatus()).waitingCount === 1, run.child, run.stderr);
    run.child.kill('SIGTERM');
    assert.deepEqual(await run.exited, { status: 130, signal: null }, run.stderr());
    assert.equal(run.stdout(), '');
    await waitForJointAdmission(async () => { const status = await fixture.brokerStatus(); return status.activeCount === 0 && status.waitingCount === 0; }, null, run.stderr);
    await assert.rejects(access(first), { code: 'ENOENT' });
    await access(foreign);
  }, { lockPath: foreign, signal: t.signal });
});

test('physical capacity refusal is typed and work starts at its exact measured floor', { skip: process.platform !== 'linux', timeout: 30_000 }, async t => {
  const floor = resolveHeavyweightMemoryFloorKiB('compilation');
  const fixture = await createJointAdmissionFixture(t, floor - 1);
  await writeFile(fixture.memory, `${floor - 1} ${floor - 1}\n`);
  const refused = fixture.start(null, ['/usr/bin/printf', 'unexpected'], 'compilation', ['--no-wait', '--failure-id=physical-floor']);
  assert.deepEqual(await refused.exited, { status: 75, signal: null }, refused.stderr());
  assert.equal(refused.stdout(), '');
  assert.match(refused.stderr(), /HSTACK_ADMISSION_CAPACITY:physical-floor/);
  await writeFile(fixture.memory, `${floor} ${floor}\n`);
  const admitted = fixture.start(null, ['/usr/bin/printf', 'admitted'], 'compilation');
  assert.deepEqual(await admitted.exited, { status: 0, signal: null }, admitted.stderr());
  assert.equal(admitted.stdout(), 'admitted');
});

test('payload exit and cancellation release the socket slot without replay', { skip: process.platform !== 'linux', timeout: 30_000 }, async t => {
  const fixture = await createJointAdmissionFixture(t, 73400320);
  const failed = fixture.start(null, ['/bin/sh', '-c', 'printf entered; exit 37'], 'validation');
  assert.deepEqual(await failed.closed, { status: 37, signal: null }, failed.stderr());
  assert.equal(failed.stdout(), 'entered');
  const running = fixture.start(null, ['/bin/sh', '-c', 'printf running; read finish'], 'validation');
  await waitForJointAdmission(() => running.stdout() === 'running', running.child, running.stderr);
  assert.equal((await fixture.brokerStatus()).activeCount, 1);
  running.child.kill('SIGTERM');
  assert.deepEqual(await running.exited, { status: 130, signal: null }, running.stderr());
  await waitForJointAdmission(async () => (await fixture.brokerStatus()).activeCount === 0, null, running.stderr);
});

test('nested compilation reuses its containing validation slot without enlarging its floor', { skip: process.platform !== 'linux', timeout: 30_000 }, async t => {
  const fixture = await createJointAdmissionFixture(t, 73400320);
  const payload = `import { spawnSync } from 'node:child_process';
import { requestAdmissionSample } from ${JSON.stringify(pathToFileURL(fixture.admissionClientPath).href)};
const before = await requestAdmissionSample(${JSON.stringify(fixture.admissionRoot)});
const result = spawnSync('/bin/sh', [${JSON.stringify(fixture.launcher)}, '--heavyweight-admission', '--class=compilation',
 '--machine=worker', '--', '/usr/bin/printf', 'nested'], { env: process.env, encoding: 'utf8' });
process.stdout.write(JSON.stringify({ before, status: result.status, stdout: result.stdout, stderr: result.stderr,
 sample: await requestAdmissionSample(${JSON.stringify(fixture.admissionRoot)}) }));`;
  const run = fixture.start(null, [process.execPath, '--input-type=module', '-e', payload], 'validation');
  assert.deepEqual(await run.exited, { status: 0, signal: null }, run.stderr());
  const result = JSON.parse(run.stdout());
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'nested');
  assert.equal(result.sample.sampleCount, result.before.sampleCount, 'an admitted compiler phase does not request capacity again');
  assert.equal(result.sample.activeCount, 1);
  assert.equal(result.sample.reservedMemoryKiB, resolveHeavyweightMemoryFloorKiB('validation'));
});

test('in-process workspace resources retain an older publication waiter ahead of a newer publisher', { timeout: 30_000 }, async t => {
  const { withWorkspaceBuildResources } = await import('./utils/proc/workspace_build_admission.mjs');
  const fixture = await createTempFixture(t, { prefix: 'workspace-resource-priority-' });
  const lockPath = fixture.path('publication.lock');
  const order = [];
  let releaseHolder, holderEntered, groupWaiting, newerWaiting;
  const holderReady = new Promise(resolve => { holderEntered = resolve; });
  const groupQueued = new Promise(resolve => { groupWaiting = resolve; });
  const newerQueued = new Promise(resolve => { newerWaiting = resolve; });
  // Logging is an OS-output boundary: observe the real first refused attempt,
  // without replacing the acquisition or preference policy being exercised.
  t.mock.method(console, 'error', value => { if (String(value).includes(lockPath)) groupWaiting(); });
  const holder = withWorkspaceBundleLock(async () => {
    holderEntered();
    await new Promise(resolve => { releaseHolder = resolve; });
  }, { lockPath });
  await holderReady;
  let older, newer;
  try {
    older = withWorkspaceBuildResources({ locks: [{ path: lockPath }] }, () => { order.push('older'); });
    await Promise.race([groupQueued, older.then(() => { throw new Error('older group entered before its held lease was released'); })]);
    newer = withWorkspaceBundleLock(() => { order.push('newer'); }, {
      lockPath, onWait: () => newerWaiting(),
    });
    await Promise.race([newerQueued, newer.then(() => { throw new Error('newer publisher entered before its held lease was released'); })]);
    releaseHolder();
    await Promise.all([holder, older, newer]);
    assert.deepEqual(order, ['older', 'newer'],
      'the in-process owner must retain a continuously queued group across nonblocking attempts');
  } finally {
    releaseHolder();
    await Promise.allSettled([holder, older, newer]);
  }
});

test('in-process overlapping resources advance the older group before recurring later-resource publishers', { timeout: 30_000 }, async t => {
  const { withWorkspaceBuildResources } = await import('./utils/proc/workspace_build_admission.mjs');
  const fixture = await createTempFixture(t, { prefix: 'workspace-overlap-priority-' });
  const first = fixture.path('first.lock'), second = fixture.path('second.lock');
  const order = [];
  let clock = Date.now();
  t.mock.method(Date, 'now', () => ++clock);
  let release, entered, queued, newerQueued, oppositeQueued;
  const ready = new Promise(resolve => { entered = resolve; });
  const waiting = new Promise(resolve => { queued = resolve; });
  const newerWaiting = new Promise(resolve => { newerQueued = resolve; });
  const oppositeWaiting = new Promise(resolve => { oppositeQueued = resolve; });
  let refusals = 0;
  t.mock.method(console, 'error', value => {
    if (String(value).includes(second) && ++refusals === 1) queued();
    else if (String(value).includes(second)) oppositeQueued();
  });
  const holder = withWorkspaceBundleLock(async () => { entered(); await new Promise(resolve => { release = resolve; }); }, { lockPath: second });
  await ready;
  let older, opposite, newer, following;
  try {
    older = withWorkspaceBuildResources({ locks: [{ path: first }, { path: second }] }, () => { order.push('older'); });
    await waiting;
    newer = withWorkspaceBundleLock(() => {
      order.push('newer');
      following = withWorkspaceBundleLock(() => { order.push('following'); }, { lockPath: second });
    }, { lockPath: second, onWait: () => newerQueued() });
    await newerWaiting;
    opposite = withWorkspaceBuildResources({ locks: [{ path: second }, { path: first }] }, () => { order.push('opposite'); });
    await oppositeWaiting;
    release();
    await Promise.all([holder, older, opposite, newer]);
    await following;
    assert.equal(order[0], 'older', 'later-resource arrivals cannot repeatedly bypass the continuously waiting group');
    assert.deepEqual(new Set(order), new Set(['older', 'opposite', 'newer', 'following']));
  } finally { release(); await Promise.allSettled([holder, older, opposite, newer, following]); }
});

test('in-process priority permits authenticated publication-holder continuation through a free prerequisite', { timeout: 30_000 }, async t => {
  const { withWorkspaceBuildResources } = await import('./utils/proc/workspace_build_admission.mjs');
  const { withWorkspaceBundleLockSync } = await import('../../../packages/cli-common/workspaceBundleLock.mjs');
  const fixture = await createTempFixture(t, { prefix: 'workspace-held-continuation-' });
  const first = fixture.path('first.lock'), second = fixture.path('second.lock');
  let clock = Date.now();
  t.mock.method(Date, 'now', () => ++clock);
  let writerReady, continueWriter, queued;
  const ready = new Promise(resolve => { writerReady = resolve; });
  const resume = new Promise(resolve => { continueWriter = resolve; });
  const waiting = new Promise(resolve => { queued = resolve; });
  t.mock.method(console, 'error', value => { if (String(value).includes(second)) queued(); });
  const order = [];
  const holder = withWorkspaceBundleLock(async ({ heldLockValue }) => {
    writerReady();
    await resume;
    const env = { ...process.env, HAPPIER_WORKSPACE_DIST_BUILD_LOCK_LEASES: JSON.stringify([heldLockValue]) };
    await withWorkspaceBundleLock(() => { order.push('async-continuation'); }, { lockPath: first, env });
    withWorkspaceBundleLockSync(() => { order.push('sync-continuation'); }, { lockPath: first, env });
  }, { lockPath: second });
  await ready;
  const older = withWorkspaceBuildResources({ locks: [{ path: first }, { path: second }] }, () => { order.push('older'); });
  try {
    await waiting;
    // joint-priority-convoy-1106: a group blocked on second must yield the
    // free first resource to unrelated work, without losing its original age.
    await withWorkspaceBundleLock(() => { order.push('unrelated'); }, { lockPath: first });
    continueWriter();
    await Promise.all([holder, older]);
    assert.deepEqual(order, ['unrelated', 'async-continuation', 'sync-continuation', 'older']);
  } finally { continueWriter(); await Promise.allSettled([holder, older]); }
});

test('in-process priority activation is whole-group and suspension retains age without fencing fresh publishers', async t => {
  const { createWorkspaceBundleLockPriorityScope, isWorkspaceBundleLockPriorityChange, observeWorkspaceBundleLockPriority, withWorkspaceBundleLockSync } =
    await import('../../../packages/cli-common/workspaceBundleLock.mjs');
  const { basename } = await import('node:path');
  const fixture = await createTempFixture(t, { prefix: 'workspace-priority-lifecycle-' });
  const first = fixture.path('first.lock'), second = fixture.path('second.lock');
  let clock = Date.now();
  t.mock.method(Date, 'now', () => ++clock);
  let fail = true;
  const scope = createWorkspaceBundleLockPriorityScope({ resources: [{ path: first }, { path: second }],
    protectLockFileImpl(path) {
      const resource = path.startsWith(`${first}.`) ? first : second;
      assert.equal(isWorkspaceBundleLockPriorityChange(resource, basename(path)), false,
        'staging writes cannot trigger all-scope reads before commit');
      if (fail && path.startsWith(`${second}.priority-waiter-`)) {
        assert.equal(observeWorkspaceBundleLockPriority(first), '[]', 'partial indexes confer no preference');
        fail = false;
        throw Object.assign(new Error('fixture protection failure'), { code: 'EACCES' });
      }
    },
  });
  try {
    assert.throws(() => scope.activate(), { code: 'EACCES' });
    assert.deepEqual(await readdir(fixture.root), []);
    const ownBaseline = observeWorkspaceBundleLockPriority(first, { priorityScope: scope });
    scope.activate();
    assert.equal(JSON.parse(observeWorkspaceBundleLockPriority(first))[0][0], JSON.parse(observeWorkspaceBundleLockPriority(second))[0][0]);
    assert.equal(observeWorkspaceBundleLockPriority(first, { priorityScope: scope }), ownBaseline,
      'own activation is absent from the meaningful wait projection');
    assert.notEqual(observeWorkspaceBundleLockPriority(first), ownBaseline,
      'omitting exclusion wiring exposes the own-state delta this control must distinguish');
    const ownNames = await readdir(fixture.root);
    for (const name of ownNames) {
      const resource = name.startsWith('first.lock.') ? first : second;
      assert.equal(isWorkspaceBundleLockPriorityChange(resource, name), true);
      assert.equal(isWorkspaceBundleLockPriorityChange(resource, name, scope), false,
        'own committed index and anchor events cannot trigger meaningful reads');
    }
    const other = createWorkspaceBundleLockPriorityScope({ resources: [{ path: first }] });
    try {
      other.activate();
      assert.notEqual(observeWorkspaceBundleLockPriority(first, { priorityScope: scope }), ownBaseline,
        'another participant remains visible in the same projection');
      for (const name of (await readdir(fixture.root)).filter(name => !ownNames.includes(name))) {
        assert.equal(isWorkspaceBundleLockPriorityChange(first, name, scope), true,
          'another participant still wakes the observer');
      }
    } finally { other.dispose(); }
    assert.equal(observeWorkspaceBundleLockPriority(first, { priorityScope: scope }), ownBaseline);
    scope.suspend();
    assert.equal(observeWorkspaceBundleLockPriority(first, { priorityScope: scope }), ownBaseline,
      'own suspension does not erase an external change or create a self-wake');
    await withWorkspaceBundleLock(() => {}, { lockPath: first });
    scope.activate();
    let waited = false;
    withWorkspaceBundleLockSync(() => {}, { lockPath: first, onWait() { waited = true; scope.suspend(); } });
    assert.equal(waited, true, 'fresh synchronous publishers consume the retained current-source ordering');
  } finally { scope.dispose(); }
  assert.deepEqual(await readdir(fixture.root), []);
});

test('in-process active priority reuse performs no filesystem mutations or publication events', async t => {
  const fs = (await import('node:fs')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const { createWorkspaceBundleLockPriorityScope, observeWorkspaceBundleLockPriority } = await import('../../../packages/cli-common/workspaceBundleLock.mjs');
  const fixture = await createTempFixture(t, { prefix: 'workspace-active-priority-cost-' });
  const lockPath = fixture.path('publication.lock');
  const scope = createWorkspaceBundleLockPriorityScope({ resources: [{ path: lockPath }] });
  scope.activate();
  const before = observeWorkspaceBundleLockPriority(lockPath);
  const names = ['writeFileSync', 'writeSync', 'renameSync', 'unlinkSync', 'utimesSync', 'mkdirSync', 'linkSync', 'copyFileSync'];
  const originals = new Map(names.map(name => [name, fs[name]]));
  const originalOpen = fs.openSync;
  let mutations = 0;
  try {
    // Instrument the real filesystem boundary only during this synchronous
    // reuse interval; no domain policy or resource owner is replaced.
    for (const [name, original] of originals) fs[name] = (...args) => { mutations++; return original(...args); };
    fs.openSync = (path, flags, ...args) => {
      if (typeof flags === 'string' ? /[wa]/.test(flags)
        : (flags & (fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND)) !== 0) mutations++;
      return originalOpen(path, flags, ...args);
    };
    syncBuiltinESMExports();
    for (let attempt = 0; attempt < 3; attempt++) scope.activate();
    assert.equal(mutations, 0, 'retrying an active scope writes and emits nothing');
    assert.equal(observeWorkspaceBundleLockPriority(lockPath), before);
  } finally {
    for (const [name, original] of originals) fs[name] = original;
    fs.openSync = originalOpen;
    syncBuiltinESMExports();
    scope.dispose();
  }
  assert.deepEqual(await readdir(fixture.root), []);
});

test('in-process dependency blocking does not retry on its own priority suspension', async t => {
  const { default: fs } = await import('node:fs');
  const { syncBuiltinESMExports } = await import('node:module');
  const { basename, sep } = await import('node:path');
  const { isWorkspaceBundleLockPriorityChange } = await import('../../../packages/cli-common/workspaceBundleLock.mjs');
  const { withWorkspaceBuildResources } = await import('./utils/proc/workspace_build_admission.mjs');
  const { resolveDependencyRefreshLockPath, withDependencyRefreshLock } = await import('./utils/proc/dependency_refresh.mjs');
  const fixture = await createTempFixture(t, { prefix: 'workspace-dependency-idle-priority-' });
  const installDir = fixture.path('install');
  await mkdir(installDir);
  const env = { ...process.env, HAPPIER_STACK_HOME_DIR: fixture.path('stack-home') };
  delete env.HSTACK_ADMISSION_WAIT_ROOT;
  delete env.HSTACK_ADMISSION_WAITER;
  const dependencyPath = resolveDependencyRefreshLockPath(installDir, env);
  assert.ok(dependencyPath.startsWith(`${fixture.root}${sep}`), 'the dependency writer must be fixture-owned');
  let entered, release;
  const holding = new Promise(resolve => { entered = resolve; });
  const released = new Promise(resolve => { release = resolve; });
  const holder = withDependencyRefreshLock({ installDir, env }, async () => { entered(); await released; });
  await holding;
  const lockPath = fixture.path('publication.lock');
  const cancellation = new AbortController();
  const stopped = new Error('fixture observation complete');
  const originalRename = fs.renameSync;
  let activations = 0;
  let activationsBeforeRelease;
  let dependencyReleaseRequested = false;
  let published = false;
  fs.renameSync = (from, to) => {
    if (String(to).startsWith(`${lockPath}.priority-scope-`)
      && isWorkspaceBundleLockPriorityChange(lockPath, basename(String(to)))
      && ++activations === 2 && !dependencyReleaseRequested) {
      // An immediate self-retry must remain a terminal count assertion even if
      // its microtasks starve the real event-loop cancellation below.
      cancellation.abort(stopped);
    }
    return originalRename(from, to);
  };
  syncBuiltinESMExports();
  t.mock.method(console, 'error', () => { setImmediate(() => {
    activationsBeforeRelease = activations;
    dependencyReleaseRequested = true;
    release();
  }); });
  try {
    let failure;
    try {
      await withWorkspaceBuildResources({
        locks: [{ path: lockPath }, { kind: 'dependency', path: dependencyPath, installDir }],
        env, signal: cancellation.signal,
      }, () => { published = true; });
    } catch (error) { failure = error; }
    assert.equal(activationsBeforeRelease ?? activations, 1,
      'own soft-priority withdrawal is not an external resource change');
    if (failure) throw failure;
    assert.equal(dependencyReleaseRequested && published, true,
      'the same waiting owner observes the real dependency release and publishes');
  } finally {
    fs.renameSync = originalRename;
    syncBuiltinESMExports();
    release();
    await holder;
  }
});

test('in-process malformed soft priority cannot block publication while dead state uses canonical reclamation', { skip: process.platform !== 'linux' }, async t => {
  const { readFileSync, writeFileSync } = await import('node:fs');
  const { createWorkspaceBundleLockPriorityScope, observeWorkspaceBundleLockPriority } = await import('../../../packages/cli-common/workspaceBundleLock.mjs');
  const fixture = await createTempFixture(t, { prefix: 'workspace-malformed-priority-' });
  const lockPath = fixture.path('publication.lock');
  const scope = createWorkspaceBundleLockPriorityScope({ resources: [{ path: lockPath }] });
  scope.activate();
  const name = (await readdir(fixture.root)).find(name => name.startsWith('publication.lock.priority-scope-'));
  const path = fixture.path(name);
  const original = readFileSync(path, 'utf8');
  try {
    const owner = JSON.parse(original);
    owner.priorityResources = [null];
    writeFileSync(path, JSON.stringify(owner));
    const malformed = readFileSync(path, 'utf8');
    assert.doesNotThrow(() => observeWorkspaceBundleLockPriority(lockPath),
      'invalid soft preference must not block the actual publication owner');
    assert.ok(JSON.parse(observeWorkspaceBundleLockPriority(lockPath))
      .some(entry => entry[1] === 'ignored' && entry[2] === 'invalid-owner-or-declaration'),
    'the existing observation exposes degraded soft preference without granting it authority');
    let published = false;
    await withWorkspaceBundleLock(async () => { published = true; }, { lockPath });
    assert.equal(published, true, 'a physically free publication remains available without valid preference');
    assert.equal(readFileSync(path, 'utf8'), malformed, 'live malformed preference is not ours to retire');
    owner.pid = 2147483647;
    writeFileSync(path, JSON.stringify(owner));
    assert.equal(observeWorkspaceBundleLockPriority(lockPath), '[]', 'dead malformed scopes cannot retain preference');
  } finally {
    try { await access(path); writeFileSync(path, original); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    scope.dispose();
  }
  assert.deepEqual(await readdir(fixture.root), []);
});

test('in-process dependency continuation is exact to the declared writer or reader conflict', { timeout: 30_000 }, async t => {
  const { sep } = await import('node:path');
  const { createWorkspaceBundleLockPriorityScope } = await import('../../../packages/cli-common/workspaceBundleLock.mjs');
  const { withWorkspaceBuildResources } = await import('./utils/proc/workspace_build_admission.mjs');
  const { resolveDependencyRefreshLockPath, resolveLockedInstallEnv, withDependencyConsumption, withDependencyRefreshLock } =
    await import('./utils/proc/dependency_refresh.mjs');
  const fixture = await createTempFixture(t, { prefix: 'workspace-dependency-continuation-' });
  const installDir = fixture.path('install'), otherDir = fixture.path('other');
  await mkdir(installDir); await mkdir(otherDir);
  const env = { ...process.env, HAPPIER_STACK_HOME_DIR: fixture.path('stack-home'),
    HAPPIER_WORKSPACE_DIST_BUILD_LOCK_WAIT_ALLOWED: '0' };
  const path = resolveDependencyRefreshLockPath(installDir, env);
  const otherPath = resolveDependencyRefreshLockPath(otherDir, env);
  assert.ok(path.startsWith(`${fixture.root}${sep}`) && otherPath.startsWith(`${fixture.root}${sep}`), 'the canonical dependency gates must be fixture-owned before acquisition');
  const publication = fixture.path('publication.lock');
  let clock = Date.now();
  t.mock.method(Date, 'now', () => ++clock);
  await withDependencyRefreshLock({ installDir, env, signal: t.signal }, async context => {
    const writerEnv = resolveLockedInstallEnv(env, context);
    for (const declared of [
      { kind: 'dependency', path, installDir },
      { kind: 'dependency', path: otherPath, installDir: otherDir },
    ]) {
      const scope = createWorkspaceBundleLockPriorityScope({ resources: [{ path: publication }, declared], env });
      try {
        scope.activate();
        const attempt = withWorkspaceBuildResources({ locks: [{ path: publication }], env: writerEnv, signal: t.signal }, () => 'continued');
        if (declared.path === path) assert.equal(await attempt, 'continued');
        else await assert.rejects(attempt, { code: 'EWORKSPACEBUNDLELOCKBUSY' });
      } finally { scope.dispose(); }
    }
  });
  await withDependencyConsumption({ installDir, env, signal: t.signal }, async readerEnv => {
    const scope = createWorkspaceBundleLockPriorityScope({ resources: [{ path: publication },
      { kind: 'dependency-input-writer', path, installDir }], env });
    try {
      scope.activate();
      assert.equal(await withWorkspaceBuildResources({ locks: [{ path: publication }], env: readerEnv, signal: t.signal }, () => 'reader-continued'), 'reader-continued');
    } finally { scope.dispose(); }
  });
});

test('in-process cancellation removes priority without releasing a foreign publication lease', { timeout: 30_000 }, async t => {
  const { observeWorkspaceBundleLockPriority } = await import('../../../packages/cli-common/workspaceBundleLock.mjs');
  const { withWorkspaceBuildResources } = await import('./utils/proc/workspace_build_admission.mjs');
  const fixture = await createTempFixture(t, { prefix: 'workspace-priority-cancel-' });
  const lockPath = fixture.path('publication.lock');
  let entered, release, queued;
  const ready = new Promise(resolve => { entered = resolve; });
  const waiting = new Promise(resolve => { queued = resolve; });
  t.mock.method(console, 'error', value => { if (String(value).includes(lockPath)) queued(); });
  const holder = withWorkspaceBundleLock(async () => { entered(); await new Promise(resolve => { release = resolve; }); }, { lockPath });
  await ready;
  const cancellation = new AbortController();
  const pending = withWorkspaceBuildResources({ locks: [{ path: lockPath }], signal: cancellation.signal }, () => { throw new Error('canceled publisher entered'); });
  try {
    await waiting;
    cancellation.abort(new Error('fixture canceled'));
    await assert.rejects(pending, /fixture canceled/);
    assert.equal(observeWorkspaceBundleLockPriority(lockPath), '[]');
    await access(lockPath);
  } finally { cancellation.abort(); release(); await Promise.allSettled([holder, pending]); }
  assert.deepEqual(await readdir(fixture.root), []);
});

test('connected admission waiters recover external memory without a holder release', { skip: process.platform !== 'linux', timeout: 30_000 }, async t => {
  // Memory can recover without a socket release. Keep the real shared broker
  // recovery clock and substitute only the OS memory observation.
  const fixture = await createJointAdmissionFixture(t, 0);
  const memory = await holdNativeAdmissionFixtureMemory(t, fixture, { totalKiB: 73400320, availableKiB: 0 });
  const samples = fixture.resourceSamplesPath;
  const waiters = Array.from({ length: 3 }, () => fixture.start(null, ['/usr/bin/printf', 'admitted'], 'validation'));
  await waitForJointAdmission(async () => (await fixture.brokerStatus()).waitingCount === waiters.length,
    waiters[0].child, () => waiters.map(run => run.stderr()).join('\n'));
  const before = await readFile(samples, 'utf8');
  await fixture.setMemoryObservation({ availableMemoryKiB: 73400320, totalMemoryKiB: 73400320 });
  for (const run of waiters) {
    assert.deepEqual(await run.exited, { status: 0, signal: null }, run.stderr());
    assert.equal(run.stdout(), 'admitted', 'shared recovery wakes already-connected waiters without a new arrival');
  }
  assert.ok((await readFile(samples, 'utf8')).length > before.length, 'the broker resamples external memory pressure');
  assert.equal(memory.child.exitCode, null, 'the original holder has not released its slot');
  await memory.release();
});

test('native non-Linux execution preserves its existing path without resolving Linux host state', async t => {
  const fixture = await createTempFixture(t, { prefix: 'host-admission-non-linux-' });
  const { launcher, admissionRoot } = await installNativeAdmissionFixture({ root: fixture.root });
  writeFakeBin({ root: fixture.root, name: 'uname', content: '#!/bin/sh\nprintf "Darwin\\n"\n' });
  writeFakeBin({ root: fixture.root, name: 'stat', content: '#!/bin/sh\nexit 1\n' });
  const result = spawnSync('/bin/sh', [launcher, '--heavyweight-admission', '--class=validation', '--', '/bin/sh', '-c', 'exit 42'], {
    encoding: 'utf8', env: { ...buildNativeAdmissionFixtureEnv(), PATH: `${fixture.path('bin')}:/usr/bin:/bin` },
  });
  assert.equal(result.status, 42, result.stderr);
  assert.deepEqual(await readdir(admissionRoot), [], 'the fixture-precreated socket root must remain untouched');
});
