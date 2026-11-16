// @happier-test-preparation source
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net, { createConnection, createServer, Socket } from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import fs, { closeSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { brokerAddress, createAdmissionBroker, readAdmissionMemorySample } from './admission_broker.mjs';
import { connectAdmissionBroker, requestAdmissionSample, runAdmittedTask, runAdmissionCommand, watchAdmissionSamples } from './admission_client.mjs';
import { slotAddress } from './admission_socket.mjs';
import { tryWorkspaceBuildResources } from './workspace_build_admission.mjs';
import { createWorkspaceBundleLockPriorityScope } from '../../../../../packages/cli-common/workspaceBundleLock.mjs';
import { DEFAULT_FILE_CHANGE_CATCH_UP_MS } from '../../../../../packages/cli-common/fileChangeObserver.mjs';
import { admitWorkerDiskBudget } from '../dev_targets/worker_disk_budget.mjs';
import { HEAVYWEIGHT_COMMAND_RESOURCES } from '../dev_targets/command_resources.mjs';
import { createLoadSentinel } from '../../perf/load-sentinel.mjs';
import { postBoardEntry } from '../../../../../scripts/board/postBoardEntry.mjs';

const linux = { skip: process.platform !== 'linux' };

test('status flags each admitted slot once only after twice its recorded class p99 and never releases it', linux, async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const { root, broker } = await fixture(t);
  const duration = { durationClass: 'targeted-validation', p99DurationMs: 100 };
  await (await acquire(root, 1, t, duration)).admit();
  await (await acquire(root, 1, t, duration)).admit();
  await (await acquire(root, 1, t, { durationClass: 'source-search', p99DurationMs: 1000 })).admit();
  await (await acquire(root, 1, t)).admit();
  now += 200;
  assert.deepEqual((await requestAdmissionSample(root)).overruns, []);
  now += 1;
  const first = await requestAdmissionSample(root);
  assert.equal(first.overruns.length, 2);
  assert.equal(new Set(first.overruns.map(slot => slot.slotId)).size, 2);
  assert.ok(first.overruns.every(slot => slot.durationClass === duration.durationClass && slot.p99DurationMs === 100 && slot.ageMs === 201));
  assert.deepEqual(broker.status().overruns, first.overruns);
  assert.equal(first.activeCount, 4, 'overrun reporting never releases a reservation or stops the job');
  assert.equal(first.durationHistoryUnavailableCount, 1, 'no-history jobs remain explicitly observable without an invented threshold');
  const posts = [];
  const board = join(root, 'HANDOFF.md');
  const notice = join(root, 'notice.md');
  await writeFile(board, '# Fixture board\n');
  const sentinel = createLoadSentinel({ repoDir: root, graphs: [], signal: t.signal,
    readAdmissionSamples: async () => [{ target: 'fixture', ...await requestAdmissionSample(root) }],
    post: async post => {
      await writeFile(notice, post);
      await postBoardEntry(board, notice);
      posts.push(post);
    } });
  await sentinel.request();
  await sentinel.request();
  assert.equal(posts.length, 2, 'each overrun slot posts once through the existing sentinel board writer');
  assert.ok(posts.every(post => post.includes('admission overrun') && post.includes('targeted-validation')));
  assert.equal(((await readFile(board, 'utf8')).match(/— admission overrun \[/g) ?? []).length, 2);
});

test('watch pushes a deadline crossing without new commands or resource observations', linux, async t => {
  const { root, broker } = await fixture(t);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const watch = watchAdmissionSamples(root, { signal: controller.signal });
  assert.equal((await watch.next()).value.activeCount, 0);
  await (await acquire(root, 1, t, { durationClass: 'targeted-validation', p99DurationMs: 50 })).admit();
  const samples = broker.status().sampleCount;
  let observed;
  do { observed = (await watch.next()).value; } while (!observed.overruns.length);
  assert.equal(observed.overruns.length, 1);
  assert.equal(observed.sampleCount, samples, 'crossing a duration deadline performs no process or memory sampling');
  assert.equal(observed.activeCount, 1);
  controller.abort();
  await watch.return();
});

test('current admission clients retain duration metadata across broker succession', linux, async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const { root, broker, sampleResources } = await fixture(t);
  const started = Promise.withResolvers();
  const finished = Promise.withResolvers();
  const task = runAdmittedTask({ root, className: 'validation', floorKiB: 1, repoDir: root,
    env: { HAPPIER_ADMISSION_DURATION_CLASS: 'targeted-validation', HAPPIER_ADMISSION_DURATION_P99_MS: '100' } }, async () => {
    started.resolve();
    return await finished.promise;
  });
  t.after(() => finished.resolve());
  await started.promise;
  const slotId = broker.status().nextOverrunAt;
  await broker.close();
  const replacement = createAdmissionBroker({ root, oldLockPath: join(root, 'old-admission.lock'), sampleResources });
  t.after(() => replacement.close());
  await replacement.start();
  now += 201;
  // A sample is an ordered control boundary after the retained client socket
  // advertises the metadata to the replacement broker.
  await new Promise(resolve => setImmediate(resolve));
  const sample = await requestAdmissionSample(root);
  assert.equal(sample.overruns.length, 1);
  assert.equal(sample.overruns[0].ageMs, 201);
  assert.equal(sample.overruns[0].p99DurationMs, 100);
  assert.ok(slotId > 0);
  finished.resolve();
  await task;
});

test('an admitted command reports its run time, excluding its queue wait, once for its dispatcher', linux, async t => {
  const { root } = await fixture(t);
  const holder = await (await acquire(root, 100, t)).admit();
  const lines = [];
  t.mock.method(console, 'error', line => { lines.push(String(line)); });
  const completion = runAdmissionCommand({ root, className: 'native-source-test', floorKiB: 1, failureId: 'dispatch-7',
    machine: 'fixture', repoDir: root, cacheBaseDir: root, env: {}, command: process.execPath,
    args: ['-e', 'setTimeout(() => {}, 50)'] });
  // The dispatcher's wall clock includes this queue wait; run time must not.
  await new Promise(resolve => setTimeout(resolve, 400));
  await holder.release();
  assert.equal(await completion, 0);
  t.mock.restoreAll();
  const markers = lines.filter(line => line.startsWith('HSTACK_ADMISSION_RUN_MS:'));
  assert.equal(markers.length, 1, lines.join('\n'));
  const [, id, ms] = markers[0].split(':');
  assert.equal(id, 'dispatch-7');
  assert.ok(Number(ms) >= 50 && Number(ms) < 400, `run time ${ms} ms must exclude the 400 ms queue wait`);
});

test('CPU admission grants reach the real payload worker controls', linux, async t => {
  const { root } = await fixture(t, { cpuCores: 2 });
  const resultPath = join(root, 'worker-controls.json');
  for (const env of [{}, { GOMAXPROCS: '', HAPPIER_VITEST_GOVERNOR_MAX_WORKERS: '' }]) {
    const status = await runAdmissionCommand({ root, className: 'native-source-test', floorKiB: 1,
      // KiB-unit fixture: the runner's real cgroup peak must not size the repeat.
      readJobPeakKiB: () => null,
      machine: 'fixture', repoDir: root, cacheBaseDir: root, env, command: process.execPath,
      args: ['--input-type=module', '-e',
        'import{writeFileSync}from"node:fs";writeFileSync(process.argv[1],JSON.stringify({go:process.env.GOMAXPROCS,vitest:process.env.HAPPIER_VITEST_GOVERNOR_MAX_WORKERS}))',
        resultPath] });
    assert.equal(status, 0);
    assert.deepEqual(JSON.parse(await readFile(resultPath, 'utf8')), { go: '1', vitest: '1' });
  }
});

test('fixed CPU capacity queues work without observing memory until a holder releases', linux, async t => {
  const clock = captureRecoveryClock(t);
  let reads = 0;
  const { root, broker } = await fixture(t, { cpuCores: 2, readMemory: () => {
    reads += 1;
    return { availableMemoryKiB: 100, totalMemoryKiB: 100 };
  } });
  const first = await acquire(root, 1, t);
  const held = await first.admit();
  const second = await acquire(root, 1, t);
  await second.admit();
  const third = await acquire(root, 1, t);
  const barrier = await request(root, { kind: 'sample' });
  await barrier.next(); barrier.socket.destroy();
  assert.equal(broker.status().activeCount, 2);
  assert.equal(broker.status().reservedCpuCores, 2);
  assert.equal(broker.status().unreservedCpuCores, 0);
  assert.equal(broker.status().queuedCpuCores, 1);
  const before = reads;
  await clock.tick();
  const after = await request(root, { kind: 'sample' });
  await after.next(); after.socket.destroy();
  assert.equal(reads, before, 'CPU-only waiters must not trigger memory/process walks');
  await held.release();
  await third.admit();
  assert.equal(broker.status().reservedCpuCores, 2);
});

test('CPU capacity refusal is observable and dynamic export workers fit both resources', linux, async t => {
  const { root, broker } = await fixture(t, { cpuCores: 2 });
  const oversized = await acquire(root, 1, t, { requestedCpuCores: 3 });
  assert.equal((await oversized.next()).reason, 'HSTACK_CPU_CAPACITY');
  const client = await acquire(root, 90, t, { commandClass: 'source-web-export', floorOptions: [
    { floorKiB: 90, workers: 3 }, { floorKiB: 80, workers: 2 }, { floorKiB: 60, workers: 1 },
  ] });
  const held = await client.admit();
  assert.equal(held.admitted.workers, 2);
  assert.equal(held.admitted.cpuCores, 2);
  assert.equal(broker.status().reservedMemoryKiB, 80);
  assert.equal(broker.status().reservedCpuCores, 2);
});

test('broker succession recovers CPU reservations from live slot sockets', linux, async t => {
  const { root, broker, sampleResources } = await fixture(t, { cpuCores: 2 });
  const first = await acquire(root, 1, t, { requestedCpuCores: 2 });
  const held = await first.admit();
  await broker.close();
  let capacityReads = 0;
  const replacement = createAdmissionBroker({ root, oldLockPath: join(root, 'old-admission.lock'), sampleResources,
    readCpuCapacity: () => { capacityReads += 1; return 2; } });
  await replacement.start();
  t.after(() => replacement.close());
  assert.equal(replacement.status().reservedCpuCores, 2);
  const queued = await acquire(root, 1, t);
  const barrier = await request(root, { kind: 'sample' });
  await barrier.next(); barrier.socket.destroy();
  assert.equal(replacement.status().activeCount, 1);
  assert.equal(replacement.status().waitingCount, 1);
  assert.equal(capacityReads, 1, 'fixed host capacity is read once, never on arrival');
  await held.release();
  await queued.admit();
  assert.equal(replacement.status().reservedCpuCores, 1);
});

test('tsrs compilation retains its memory floor and is admitted on memory alone', linux, async t => {
  const { HEAVYWEIGHT_COMMAND_RESOURCES } = await import('../dev_targets/command_resources.mjs');
  const floorKiB = HEAVYWEIGHT_COMMAND_RESOURCES['compilation-ui-tsrs']?.memoryKiB;
  assert.equal(floorKiB, 10 * 1024 * 1024);
  let capacityKiB = 2 * floorKiB - 1;
  const { root, broker } = await fixture(t, {
    readMemory: () => ({ availableMemoryKiB: capacityKiB, totalMemoryKiB: 64 * 1024 * 1024 }),
  });
  const first = await acquire(root, floorKiB, t, { className: 'compilation-ui-tsrs' });
  const held = await first.admit();
  const second = await acquire(root, floorKiB, t, { className: 'compilation-ui-tsrs' });
  const sample = await request(root, { kind: 'sample' });
  await sample.next();
  sample.socket.destroy();
  assert.equal(broker.status().activeCount, 1);
  assert.equal(broker.status().waitingCount, 1);
  capacityKiB += 1;
  const exact = await request(root, { kind: 'sample' });
  await exact.next();
  exact.socket.destroy();
  assert.equal(broker.status().activeCount, 1);
  assert.equal(broker.status().reservedCpuCores, 0);
  await held.release();
  await second.admit();
  assert.equal(broker.status().activeCount, 1);
  assert.equal(broker.status().waitingCount, 0);
  assert.equal(broker.status().reservedMemoryKiB, floorKiB);
});

test('host-class work is admitted on memory alone and still receives the host core count', linux, async t => {
  // Reproduced 2026-11-10: whole-host CPU reservations for 'host' classes left an
  // idle 128-core worker running one heavyweight job at a time.
  const { root, broker } = await fixture(t, { cpuCores: 2, readMemory: () => ({ availableMemoryKiB: 100, totalMemoryKiB: 100 }) });
  const first = await acquire(root, 1, t, { className: 'source-bundle' });
  const held = await first.admit();
  const second = await acquire(root, 1, t, { className: 'source-bundle' });
  const admitted = await second.admit();
  assert.equal(broker.status().activeCount, 2);
  assert.equal(broker.status().waitingCount, 0);
  assert.equal(broker.status().reservedCpuCores, 0);
  assert.equal(admitted.admitted.cpuCores, 2, 'clients keep their host-sized worker controls');
  await held.release();
});

test('canonical validation floors admit concurrent focused work up to exact capacity', linux, async t => {
  const { resolveRemoteCommandPolicy, resolveHeavyweightMemoryFloorKiB } = await import('../dev_targets/remote_commands.mjs');
  const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
  const policy = resolveRemoteCommandPolicy(['vitest', 'run', 'sources/utils/path/resolvePathRelativeToRoot.test.ts'],
    { repoRoot, cwd: join(repoRoot, 'apps/ui') });
  const floorKiB = resolveHeavyweightMemoryFloorKiB(policy.heavyClass, { machine: 'local' });
  const concurrentRuns = 3;
  // The command-resource owner sizes each class from its current measurements.
  // Admission must use that floor without introducing a controller margin.
  const capacityKiB = concurrentRuns * floorKiB;
  const readMemory = () => ({ availableMemoryKiB: capacityKiB, totalMemoryKiB: 64 * 1024 * 1024 });
  const { root, broker } = await fixture(t, {
    readMemory,
  });
  for (let index = 0; index < concurrentRuns; index++) {
    const client = await acquire(root, floorKiB, t);
    const sample = await request(root, { kind: 'sample' });
    await sample.next();
    sample.socket.destroy();
    assert.equal(broker.status().waitingCount, 0, 'fitting focused work must not queue behind its own oversized floor');
    await client.admit();
  }
  assert.equal(broker.status().activeCount, concurrentRuns);
  assert.equal(broker.status().waitingCount, 0);
  assert.equal(broker.status().reservedMemoryKiB, concurrentRuns * floorKiB);
});

test('an interrupted reservation reconnects with released capacity and publication priority', linux, async t => {
  const { root, broker } = await fixture(t);
  const locks = [{ path: join(root, 'publication.lock') }];
  let interrupted = false;
  let offeredPeer;
  const nativeWrite = Socket.prototype.write;
  // Close the remote peer after publication acquisition and slot bind, before
  // ready reaches the broker. Local destruction would not deliver input EOF.
  t.mock.method(Socket.prototype, 'write', function (chunk, ...args) {
    if (!interrupted && typeof chunk === 'string' && chunk.startsWith('{')) {
      const response = JSON.parse(chunk);
      if (response.kind === 'reserved') offeredPeer = this;
      if (response.kind === 'ready') {
        interrupted = true;
        offeredPeer.destroy();
        return false;
      }
    }
    return nativeWrite.call(this, chunk, ...args);
  });
  let payloads = 0;
  const options = { root, className: 'validation', floorKiB: 100, machine: 'fixture',
    repoDir: root, cacheBaseDir: root, locks, env: {}, noWait: true };
  const publish = () => runAdmittedTask(options, async () => {
    payloads += 1;
    assert.equal(broker.status().reservedMemoryKiB, 100);
    assert.equal((await tryWorkspaceBuildResources({ locks })).acquired, false,
      'the payload retains actual publication custody after reconnect');
    return payloads;
  });
  assert.equal(await publish(), 1);
  assert.equal(interrupted, true);
  assert.equal((await requestAdmissionSample(root)).activeCount, 0,
    'the interrupted offer and completed payload leave no reservation');
  assert.equal(await publish(), 2, 'a second publication can reacquire the same capacity and lock');
  const unlocked = await tryWorkspaceBuildResources({ locks });
  try { assert.equal(unlocked.acquired, true); }
  finally { await unlocked.release?.(); }
});

function otherUserCommand(command, args) {
  return process.geteuid() === 0
    ? ['runuser', ['--user', 'nobody', '--', command, ...args]]
    : ['sudo', ['-n', '--user=nobody', '--', command, ...args]];
}

async function request(root, value) {
  const socket = createConnection(brokerAddress(root));
  const lines = createInterface({ input: socket });
  const iterator = lines[Symbol.asyncIterator]();
  await once(socket, 'connect');
  socket.write(JSON.stringify(value) + '\n');
  return { socket, next: async () => {
    let response;
    // Queue notices are diagnostic; these broker assertions consume decisions.
    do { response = JSON.parse((await iterator.next()).value); } while (response.kind === 'queued');
    return response;
  } };
}

async function acquire(root, floorKiB, t, extra = {}) {
  const client = await request(root, { kind: 'acquire', className: 'validation',
    cpuCost: HEAVYWEIGHT_COMMAND_RESOURCES[extra.commandClass ?? extra.className ?? 'native-source-test']?.cpuCores ?? 'host', floorKiB,
    pid: process.pid, repoDir: root, cacheBaseDir: root, locks: [], env: {}, ...extra });
  t.after(() => client.socket.destroy());
  return { ...client, admit: async beforeReady => {
    const reserved = await client.next();
    assert.equal(reserved.kind, 'reserved');
    await beforeReady?.();
    const peers = new Set();
    const server = createServer(socket => { peers.add(socket); socket.on('close', () => peers.delete(socket)); });
    const release = async () => {
      for (const peer of peers) peer.destroy();
      client.socket.destroy();
      await new Promise(resolve => server.close(resolve));
    };
    t.after(release);
    server.listen(reserved.slotAddress);
    await once(server, 'listening');
    client.socket.write(JSON.stringify({ kind: 'ready' }) + '\n');
    const admitted = await client.next();
    assert.equal(admitted.kind, 'admitted');
    return { admitted, release, slotAddress: reserved.slotAddress };
  } };
}

async function fixture(t, { readMemory = () => ({ availableMemoryKiB: 100, totalMemoryKiB: 100 }), readProcesses = () => new Map(), admitDisk, cpuCores = 128 } = {}) {
  // Unix socket metadata needs a short pathname, independent of the command's
  // potentially deep workspace/custody TMPDIR. This remains a private root.
  const root = await mkdtemp('/tmp/happier-broker-test-');
  const sampleResources = ({ slots }) => readAdmissionMemorySample({ slots,
    readMemory, readProcesses });
  const broker = createAdmissionBroker({ root, oldLockPath: join(root, 'old-admission.lock'), sampleResources,
    readCpuCapacity: () => cpuCores,
    ...(admitDisk ? { admitDisk } : {}) });
  await broker.start();
  t.after(async () => { await broker.close(); await rm(root, { recursive: true, force: true }); });
  return { root, broker, sampleResources };
}

// Nearest-rank p95 of 63,482 successful targeted-validation wrapper durations.
const headReservationDelayMs = 1_344_000;

for (const starvation of [false, true]) test(`capped head reservation ${starvation ? 'prevents starvation under sustained small traffic' : 'keeps nl1/nl3 released capacity reusable before the bound'}`, linux, async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const { root } = await fixture(t);
  const holder = await (await acquire(root, 70, t)).admit();
  const head = await acquire(root, 38, t, { arrivedAt: now });
  const sample = () => requestAdmissionSample(root);
  const small = [];
  if (!starvation) {
    for (let i = 0; i < 6; i++) {
      const backfill = await (await acquire(root, 5, t)).admit();
      await backfill.release();
      await sample();
    }
    const before = await sample();
    assert.equal(before.unreservedMemoryKiB, 30, 'six completions must not hide the 30 physically free units');
    await (await acquire(root, 5, t)).admit();
    return;
  }
  for (let i = 0; i < 6; i++) small.push(await (await acquire(root, 5, t)).admit());
  now += headReservationDelayMs - 1;
  for (let i = 0; i < 12; i++) {
    const index = i % small.length;
    await small[index].release();
    const before = await sample();
    assert.equal(before.unreservedMemoryKiB, 5, 'sustained traffic may recycle capacity before the bound');
    assert.equal(before.head.reservationActive, false);
    small[index] = await (await acquire(root, 5, t)).admit();
  }
  now += 1;
  for (let i = 0; i < small.length; i++) {
    await small[i].release();
    const after = await sample();
    assert.equal(after.head.reservationActive, true);
    assert.equal(after.head.reservationDelayMs, headReservationDelayMs);
    assert.equal(after.head.ageMs, headReservationDelayMs);
    assert.equal(after.head.reservationKiB, (i + 1) * 5);
    const follower = await acquire(root, 5, t, { noWait: true });
    assert.equal((await follower.next()).reason, 'HSTACK_MEMORY_BUSY', 'followers cannot consume the aged head pledge');
  }
  await holder.release();
  await head.admit();
  assert.equal((await sample()).waitingCount, 0, 'the head starts despite sustained smaller demand');
});

test('head pledges survive older waiter achievable-memory flips', linux, async t => {
  const clock = captureRecoveryClock(t);
  const gib = 1024 * 1024;
  let availableMemoryKiB = 100 * gib;
  const { root } = await fixture(t, {
    readMemory: () => ({ availableMemoryKiB, totalMemoryKiB: 120 * gib }),
  });
  await (await acquire(root, 40 * gib, t)).admit();
  const small = [];
  for (let i = 0; i < 12; i++) small.push(await (await acquire(root, 5 * gib, t)).admit());
  const arrivedAt = Date.now() - headReservationDelayMs;
  const older = await acquire(root, 110 * gib, t, { arrivedAt: arrivedAt - 1 });
  const head = await acquire(root, 38 * gib, t, { arrivedAt });
  await small[0].release();
  assert.equal((await requestAdmissionSample(root)).head.reservationKiB, 5 * gib);

  availableMemoryKiB = 120 * gib;
  await clock.tick();
  assert.equal((await requestAdmissionSample(root)).head.minimumFloorKiB, 110 * gib);
  await small[1].release();
  assert.equal((await requestAdmissionSample(root)).head.reservationKiB, 5 * gib);
  availableMemoryKiB = 100 * gib;
  await clock.tick();
  const returned = await requestAdmissionSample(root);
  assert.equal(returned.head.minimumFloorKiB, 38 * gib);
  assert.equal(returned.head.reservationKiB, 5 * gib, 'the younger head keeps the release it earned before the flip');
  availableMemoryKiB = 120 * gib;
  await clock.tick();
  assert.equal((await requestAdmissionSample(root)).head.reservationKiB, 5 * gib, 'the older head also keeps its earned release');
  availableMemoryKiB = 100 * gib;
  await clock.tick();
  await (await acquire(root, 5 * gib, t)).admit(); // Spare capacity from the older head's release.
  for (let i = 2; i < 9; i++) {
    const follower = await acquire(root, 5 * gib, t, { noWait: true });
    assert.equal((await follower.next()).reason, 'HSTACK_MEMORY_BUSY');
    await small[i].release();
  }
  await head.admit();
  assert.equal((await requestAdmissionSample(root)).waitingCount, 1, 'the younger head starts after nine 5 GiB releases; the older request keeps its place');
  older.socket.destroy();
});

// Systemic 18:47Z: the shared runtime producer and the blocking commit compiler
// unblock every lane, so they are served before ordinary waiters (the producer
// first). The broker derives this from the admitted command identity; a caller
// flag grants nothing.
const priorityIdentity = (root, kind) => ({
  ordinary: { className: 'compilation', component: '.', entry: 'node scripts/build.mjs' },
  commit: { className: 'compilation', component: '.', entry: `node ${root}/scripts/workspaces/checkCommitTypeCoherence.mjs` },
  producer: { className: 'source-bundle', component: '.', entry: `node ${root}/apps/stack/scripts/build/build_source_runtime.mjs` },
  claimed: { className: 'compilation', component: '.', entry: `node ${root}/scripts/run-tests.mjs`, headPriority: true },
  // P03 rolling HEAD typecheck: admitted from its warm worktree, outside the repository.
  // The shared web export every QA browser consumes (repo-dev producer, 2026-11-16).
  export: { className: 'source-web-export', component: '.', entry: `node ${root}/apps/stack/scripts/build/build_source_web_ui.mjs` },
  rolling: { className: 'compilation', component: '../../cache/commit-typecheck/wt',
    entry: `node ${root}/scripts/workspaces/commitPackageTypecheck.mjs` },
})[kind];
for (const [scenario, earlier, later, laterFirst] of [
  ['commit compiler before an earlier ordinary job', 'ordinary', 'commit', true],
  ['rolling HEAD typecheck before an earlier ordinary job', 'ordinary', 'rolling', true],
  ['shared web export before an earlier commit compiler', 'commit', 'export', true],
  ['runtime producer before an earlier ordinary job', 'ordinary', 'producer', true],
  ['runtime producer before an earlier commit compiler', 'commit', 'producer', true],
  ['an ordinary caller cannot claim priority', 'ordinary', 'claimed', false],
]) {
  test(`head priority: ${scenario}`, linux, async t => {
    const { root } = await fixture(t);
    const large = await (await acquire(root, 70, t)).admit();
    const small = await (await acquire(root, 30, t)).admit();
    const first = await acquire(root, 60, t, priorityIdentity(root, earlier));
    const second = await acquire(root, 60, t, priorityIdentity(root, later));
    const pledging = laterFirst || earlier !== 'ordinary';
    await small.release();
    const pledged = await requestAdmissionSample(root);
    assert.equal(pledged.head.headPriority > 0, pledging, 'the sample names a priority head');
    assert.equal(pledged.head.reservationActive, pledging, 'a priority head pledges releases at once, without the aging bound');
    assert.equal(pledged.head.reservationKiB, pledging ? 30 : 0);
    assert.equal(pledged.waitingCount, 2, 'floors still apply: neither 60-unit waiter starts in 30 free units');
    const follower = await acquire(root, 5, t, { noWait: true });
    if (pledging) assert.equal((await follower.next()).reason, 'HSTACK_MEMORY_BUSY', 'ordinary backfills cannot spend the priority pledge');
    else await follower.admit();
    await large.release();
    const [admittedFirst, waiting] = laterFirst ? [second, first] : [first, second];
    const started = await admittedFirst.admit();
    assert.equal((await requestAdmissionSample(root)).waitingCount, 1, 'only one 60-unit job fits; the other keeps waiting');
    await started.release();
    await waiting.admit();
  });
}

// Coordination 2026-11-13 11:22Z: host-bound reloads may use a relocatable head's pledge.
for (const scenario of ['nl3 reload', 'head resumes', 'relocatable order', 'host-bound head']) {
  test(`host-bound pledge priority: ${scenario}`, linux, async t => {
    const gib = 1024 * 1024;
    let available = 100 * gib;
    const { root } = await fixture(t, { readMemory: () => ({ availableMemoryKiB: available, totalMemoryKiB: 100 * gib }) });
    const holder = await (await acquire(root, 79 * gib, t)).admit();
    const releasing = await (await acquire(root, 21 * gib, t)).admit();
    const head = await acquire(root, 38 * gib, t, {
      className: scenario === 'host-bound head' ? 'source-bundle' : 'compilation',
      arrivedAt: Date.now() - headReservationDelayMs,
    });
    await requestAdmissionSample(root);
    await releasing.release();
    const pledged = await requestAdmissionSample(root);
    assert.equal(pledged.head.reservationKiB, 21 * gib);
    const follower = await acquire(root, 12 * gib, t, { className: 'compilation', noWait: true });
    assert.equal((await follower.next()).reason, 'HSTACK_MEMORY_BUSY', 'relocatable backfills cannot spend the pledge');
    if (scenario === 'host-bound head') {
      const reload = await acquire(root, 12 * gib, t, { className: 'source-bundle', noWait: true });
      assert.equal((await reload.next()).reason, 'HSTACK_MEMORY_BUSY', 'a host-bound head retains its pledge');
      return;
    }
    const reload = await acquire(root, 12 * gib, t, { className: 'source-bundle', noWait: true });
    const reloaded = await reload.admit();
    assert.equal(reloaded.admitted.floorKiB, 12 * gib, 'the reload starts using the 21 GiB pledge');
    const decision = await requestAdmissionSample(root);
    assert.equal(decision.head.lastHostBoundAdmissionKiB, 12 * gib, 'the sample exposes the priority choice');
    await reloaded.release();
    await requestAdmissionSample(root);
    if (scenario === 'nl3 reload') return;
    await acquire(root, 50 * gib, t, { className: 'source-bundle' });
    await requestAdmissionSample(root);
    let younger;
    if (scenario === 'relocatable order') younger = await acquire(root, 38 * gib, t, { className: 'compilation' });
    available = 38 * gib;
    await holder.release();
    const started = await head.admit();
    const after = await requestAdmissionSample(root);
    assert.equal(after.head?.className ?? null, younger ? 'compilation' : null);
    assert.equal(after.waitingCount, younger ? 2 : 1, 'a reload that cannot fit does not delay the head');
    if (younger) {
      assert.equal(after.waitingCount, 2, 'the younger relocatable job and oversized reload still wait behind the head');
      await started.release();
      const second = await younger.admit();
      assert.equal(second.admitted.kind, 'admitted');
    }
    await started.release();
  });
}

for (const resource of ['memory', 'CPU']) test(`${resource} backfills current free capacity and pledges later releases to the head`, linux, async t => {
  const reservations = [];
  const positions = [];
  const nativeWrite = Socket.prototype.write;
  t.mock.method(Socket.prototype, 'write', function (chunk, ...args) {
    if (typeof chunk === 'string' && chunk.startsWith('{')) {
      const response = JSON.parse(chunk);
      if (response.kind === 'reserved') reservations.push(response.slotAddress);
      if (response.kind === 'queued') positions.push(response.queuePosition);
    }
    return nativeWrite.call(this, chunk, ...args);
  });
  const gibKiB = 1024 * 1024;
  const memory = resource === 'memory';
  const { root } = await fixture(t, {
    readMemory: () => ({ availableMemoryKiB: 20 * gibKiB, totalMemoryKiB: 20 * gibKiB }), cpuCores: 20,
  });
  const job = (units, extra = {}) => acquire(root, memory ? units * gibKiB : 1, t,
    { cpuCost: memory ? 'host' : units, ...extra });
  const barrier = async () => {
    const client = await request(root, { kind: 'sample' });
    const value = await client.next(); client.socket.destroy(); return value;
  };
  const held = await (await job(10)).admit();
  const head = await job(17, { arrivedAt: Date.now() - headReservationDelayMs });
  const followers = [];
  for (let id = 0; id < 3; id++) followers.push({ id, client: await job(2) });
  const initial = await barrier();
  assert.equal(initial.activeCount, 4, 'all three small jobs fit in capacity free when the head arrived');
  assert.equal(initial.waitingCount, 1);
  assert.equal(initial.head.reservationKiB, 0);
  const small = [];
  for (const { client } of followers) small.push(await client.admit());
  const admittedIds = reservations.slice(1).map(address => followers[small.findIndex(slot => slot.slotAddress === address)].id);
  assert.deepEqual(admittedIds, [0, 1, 2], 'socket offers preserve arrival order among backfills');
  await held.release();
  const later = await job(5);
  const released = await barrier();
  assert.equal(released.activeCount, 3, 'later jobs cannot take the released holder capacity');
  assert.equal(released.waitingCount, 2);
  assert.deepEqual(positions, [1, 2], 'the head stays first and the late job queues second');
  assert.equal(memory ? released.unreservedMemoryKiB : released.unreservedCpuCores, memory ? 4 * gibKiB : 4);
  const check = await request(root, { kind: 'check', floorKiB: memory ? 5 * gibKiB : 1, cpuCost: memory ? 'host' : 5 });
  assert.equal((await check.next()).kind, 'refused', 'read-only checks use the same pledge'); check.socket.destroy();
  await small[0].release();
  await small[1].release();
  const runningHead = await head.admit();
  assert.equal((await barrier()).waitingCount, 1, 'head runs as soon as its floor fits');
  await runningHead.release();
  await later.admit();
});

for (const resource of ['memory', 'CPU']) test(`recovered slots pledge ${resource} releases before newer backfills`, linux, async t => {
  const clock = captureRecoveryClock(t);
  const memory = resource === 'memory';
  const { root, broker, sampleResources } = await fixture(t, { cpuCores: 100 });
  const job = (units, extra = {}) => acquire(root, memory ? units : 1, t,
    { cpuCost: memory ? 'host' : units, ...extra });
  const first = await (await job(40)).admit();
  const second = await (await job(40)).admit();
  await broker.close();
  const replacement = createAdmissionBroker({ root, oldLockPath: join(root, 'old-admission.lock'),
    sampleResources, readCpuCapacity: () => 100 });
  await replacement.start();
  t.after(() => replacement.close());
  const head = await job(70, { arrivedAt: Date.now() - headReservationDelayMs });
  const small = await (await job(20)).admit();
  const barrier = async () => {
    const client = await request(root, { kind: 'sample' });
    const result = await client.next(); client.socket.destroy(); return result;
  };
  await first.release();
  // Drive the existing recovery boundary deterministically after the socket closes.
  await clock.tick();
  const snapshot = await barrier();
  assert.equal(memory ? snapshot.head.reservationKiB : snapshot.unreservedCpuCores,
    memory ? 40 : 0, 'a recovered holder release belongs to the waiting head');
  for (let index = 0; index < 3; index++) {
    const follower = await job(20, { noWait: true });
    assert.equal((await follower.next()).reason, memory ? 'HSTACK_MEMORY_BUSY' : 'HSTACK_CPU_BUSY');
  }
  await second.release();
  await head.admit();
  assert.equal((await barrier()).waitingCount, 0, 'the old head runs after enough recovered holders finish');
  await small.release();
});

test('closing the waiting head clears its released-memory pledge', linux, async t => {
  let headSocket;
  const nativeWrite = Socket.prototype.write;
  t.mock.method(Socket.prototype, 'write', function (chunk, ...args) {
    if (typeof chunk === 'string' && chunk.startsWith('{')) {
      const response = JSON.parse(chunk);
      if (response.kind === 'queued' && response.queuePosition === 1 && !headSocket) headSocket = this;
    }
    return nativeWrite.call(this, chunk, ...args);
  });
  const { root } = await fixture(t, { readMemory: () => ({ availableMemoryKiB: 20, totalMemoryKiB: 20 }) });
  const held = await (await acquire(root, 10, t)).admit();
  await acquire(root, 17, t, { arrivedAt: Date.now() - headReservationDelayMs });
  const small = [];
  for (let i = 0; i < 3; i++) small.push(await acquire(root, 2, t));
  const barrier = await request(root, { kind: 'sample' });
  assert.equal((await barrier.next()).activeCount, 4); barrier.socket.destroy();
  for (const client of small) await client.admit();
  await held.release();
  const later = await acquire(root, 5, t);
  const check = await request(root, { kind: 'sample' });
  const pledged = await check.next(); check.socket.destroy();
  assert.equal(pledged.head.reservationKiB, 10);
  assert.equal(pledged.waitingCount, 2);
  const closed = once(headSocket, 'close'); headSocket.destroy(); await closed;
  await later.admit();
  const cleared = await request(root, { kind: 'sample' });
  const value = await cleared.next(); cleared.socket.destroy();
  assert.equal(value.waitingCount, 0);
  assert.equal(value.head, null);
  assert.equal(value.unreservedMemoryKiB, 9);
});

test('status exposes symbolic reservation head and exact queue floor buckets', linux, async t => {
  let reads = 0;
  const { root, broker } = await fixture(t, { readMemory: () => {
    reads += 1;
    return { availableMemoryKiB: 100, totalMemoryKiB: 100 };
  } });
  const holder = await acquire(root, 40, t, { arrivedAt: Date.now() - 10000 });
  const held = await holder.admit();
  const arrivedAt = Date.now() - 5000;
  await acquire(root, 90, t, { className: 'compilation', arrivedAt,
    floorOptions: [{ floorKiB: 90, workers: 2 }, { floorKiB: 80, workers: 1 }] });
  // Owner backfill ruling (2026-11-12): consume the 60 units free at head arrival.
  const small = [];
  for (let index = 0; index < 3; index += 1) small.push(await acquire(root, 30, t));
  const barrier = await request(root, { kind: 'sample' });
  const snapshot = await barrier.next(); barrier.socket.destroy();
  assert.equal(snapshot.head.className, 'compilation');
  assert.equal(snapshot.head.minimumFloorKiB, 80);
  assert.ok(snapshot.head.ageMs >= 5000);
  assert.equal(snapshot.head.reservationKiB, 0);
  assert.equal(snapshot.waitingByClassAndFloor.reduce((n, bucket) => n + bucket.count, 0), 2);
  assert.deepEqual(snapshot.waitingByClassAndFloor.find(bucket => bucket.className === 'compilation'), {
    className: 'compilation', floorKiB: 90, minimumFloorKiB: 80,
    floorOptions: [{ floorKiB: 90, workers: 2 }, { floorKiB: 80, workers: 1 }], count: 1,
  });
  assert.equal(broker.status().waitingByClassAndFloor.find(bucket => bucket.className === 'validation').count, 1);
  await small[0].admit();
  await small[1].admit();
  const before = reads;
  broker.status(); broker.status();
  assert.equal(reads, before, 'diagnostic projection never samples processes or memory');
  await held.release();
});

test('completed slots retain sampled RSS peaks by class without extra process walks or status disclosure', linux, async t => {
  let rssKiB = 17;
  let reads = 0;
  const { root, broker } = await fixture(t, { readProcesses: () => {
    reads += 1;
    return new Map([[process.pid, { pid: process.pid, parentPid: 1, rssKiB, pssKiB: 3 }]]);
  } });
  const first = await acquire(root, 20, t, { className: 'source-bundle' });
  const held = await first.admit();
  const second = await acquire(root, 1, t, { pid: 999999 });
  await second.admit();
  rssKiB = 41;
  const third = await acquire(root, 1, t, { pid: 999998 });
  await third.admit();
  const before = reads;
  assert.equal(broker.status().slotRssKiB, undefined);
  const recorded = new Promise(resolve => {
    const watcher = fs.watch(root, (_, name) => {
      if (name === 'completed-slot-memory.jsonl') { watcher.close(); resolve(); }
    });
    t.after(() => watcher.close());
  });
  await held.release();
  await recorded;
  const rows = (await readFile(join(root, 'completed-slot-memory.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].className, 'source-bundle');
  assert.equal(rows[0].peakRssKiB, 41);
  assert.equal(rows[0].samples, 2);
  assert.equal(rows[0].method, 'broker-event-sampled-tree-rss');
  assert.ok(rows[0].maxGapMs >= 0);
  assert.ok(reads <= before + 1, 'completion reuses samples; only the existing release observation may walk processes');
  assert.deepEqual(Object.keys(rows[0]).sort(), ['className', 'completedAt', 'floorKiB', 'maxGapMs', 'method', 'peakRssKiB', 'samples'].sort());
});

test('identity keys on component and entry, never the argument list; unrecorded identities reserve their package set maximum', linux, async t => {
  const gib = 1024 * 1024;
  const { root } = await fixture(t, { readMemory: () => ({ availableMemoryKiB: 100 * gib, totalMemoryKiB: 100 * gib }),
    admitDisk: () => ({ admitted: true }) });
  const settle = async () => { while ((await requestAdmissionSample(root)).activeCount !== 0) await new Promise(resolve => setImmediate(resolve)); };
  const floorFile = join(root, 'floor.txt');
  const entryA = join(root, 'entry-a.mjs');
  const entryB = join(root, 'entry-b.mjs');
  const record = `import{writeFileSync}from"node:fs";writeFileSync(${JSON.stringify(floorFile)},process.env.HAPPIER_HEAVYWEIGHT_ADMISSION_FLOOR_KIB)`;
  await writeFile(entryA, record); await writeFile(entryB, record);
  const run = (entry, files, peakKiB, className = 'compilation') => runAdmissionCommand({ root, className, floorKiB: 38 * gib,
    machine: 'fixture', repoDir: root, cacheBaseDir: root, env: {}, projects: ['.'], readJobPeakKiB: () => peakKiB,
    command: process.execPath, args: [entry, ...files] });
  const admittedFloor = async () => Number(await readFile(floorFile, 'utf8'));
  assert.equal(await run(entryA, ['alpha.test.mjs'], 1 * gib), 0); await settle();
  assert.equal(await admittedFloor(), 38 * gib, 'a class without kernel history reserves its floor');
  assert.equal(await run(entryB, ['beta.test.mjs'], 9 * gib), 0); await settle();
  assert.equal(await admittedFloor(), 1 * gib, 'an unrecorded identity reserves its package set maximum (1 GiB so far), not the floor');
  assert.equal(await run(entryA, ['gamma.test.mjs', 'delta.test.mjs'], 1 * gib), 0); await settle();
  assert.equal(await admittedFloor(), 1 * gib, 'new arguments for a recorded entry keep its identity');
  await writeFile(join(root, 'entry-c.mjs'), record);
  assert.equal(await run(join(root, 'entry-c.mjs'), ['x.test.mjs'], 1 * gib), 0); await settle();
  assert.ok(await admittedFloor() >= 9 * gib, 'an unrecorded entry reserves at least its package set maximum');
});

test('an unrecorded identity starts from its command family or package set, not the class kernel maximum', linux, async t => {
  const gib = 1024 * 1024;
  const { root, broker } = await fixture(t, { readMemory: () => ({ availableMemoryKiB: 100 * gib, totalMemoryKiB: 100 * gib }),
    admitDisk: () => ({ admitted: true }) });
  const key = (entry, projects, component = '.') => JSON.stringify(['compilation', component, entry, [...projects].sort()]);
  const fixtureCompile = 'node scripts/workspaces/runTypeScriptCli.mjs';
  const checker = 'node scripts/workspaces/checkCommitTypeCoherence.mjs';
  await writeFile(join(root, 'identity-kernel-peaks.json'), JSON.stringify({
    [key(fixtureCompile, ['packages/plugin-sdk/fixtures/a/tsconfig.json'])]: Math.round(1.4 * gib),
    [key(checker, ['.'])]: Math.round(32.7 * gib),
    [key(checker, ['apps/cli', 'apps/ui'])]: 17 * gib,
    [key(checker, ['apps/bootstrap', 'apps/cli', 'apps/desktop', 'apps/server'])]: Math.round(39.9 * gib),
    [key('pnpm run typecheck:local', ['packages/plugins/machine-lima'], 'packages/plugins/machine-lima')]: Math.round(4.8 * gib),
  }));
  const reserved = async identity => {
    const held = await (await acquire(root, 38 * gib, t, { className: 'compilation', resourceClass: 'compilation',
      commandClass: 'compilation', component: '.', ...identity })).admit();
    const floorKiB = broker.status().reservedMemoryKiB;
    await held.release();
    return floorKiB;
  };
  assert.equal(await reserved({ entry: fixtureCompile, projects: ['packages/plugin-sdk/fixtures/b/tsconfig.json'] }), 1.5 * gib,
    'a new fixture compile takes its command family maximum (1.4 GiB), not the 39.9 GiB class maximum');
  assert.equal(await reserved({ entry: checker, projects: ['apps/cli'] }), 17 * gib,
    'a package set inside recorded runs of the same command takes the smallest such superset');
  assert.equal(await reserved({ entry: 'pnpm run typecheck:local', projects: ['packages/plugins/machine-lima'],
    component: 'packages/plugins/machine-lima-copy' }), 5 * gib, 'the same command in another component is the same family');
  assert.equal(await reserved({ entry: 'node other-checker.mjs', projects: ['apps/cli', 'apps/ui'] }), 17 * gib,
    'an unknown command on a recorded package set takes that package set\'s maximum');
  assert.equal(await reserved({ entry: 'node other-checker.mjs', projects: ['apps/website'] }), 40 * gib,
    'with no related record the class kernel maximum still applies');
});

test('succession re-sizes a recovered slot to max(its scope memory.current, its identity kernel peak)', linux, async t => {
  const gib = 1024 * 1024;
  const readMemory = () => ({ availableMemoryKiB: 100 * gib, totalMemoryKiB: 100 * gib });
  const { root, broker, sampleResources } = await fixture(t, { readMemory, admitDisk: () => ({ admitted: true }) });
  const settle = async () => { while ((await requestAdmissionSample(root)).activeCount !== 0) await new Promise(resolve => setImmediate(resolve)); };
  const identity = { component: 'apps/ui', entry: 'pnpm run typecheck' };
  // Record a 9 GiB kernel peak for the identity, then hold one admitted job of it.
  assert.equal(await runAdmissionCommand({ root, className: 'compilation', floorKiB: 38 * gib, machine: 'fixture', repoDir: root,
    cacheBaseDir: root, env: {}, projects: ['.'], ...identity, readJobPeakKiB: () => 9 * gib,
    command: process.execPath, args: ['-e', ''] }), 0);
  await settle();
  const anonymous = await (await acquire(root, 38 * gib, t, { className: 'compilation', resourceClass: 'compilation' })).admit();
  const started = Promise.withResolvers();
  const finished = Promise.withResolvers();
  const task = runAdmittedTask({ root, className: 'compilation', floorKiB: 38 * gib, repoDir: root, cacheBaseDir: root,
    projects: ['.'], ...identity, readJobPeakKiB: () => null, env: {} }, async () => { started.resolve(); return await finished.promise; });
  t.after(() => finished.resolve());
  await started.promise;
  await broker.close();
  const replacement = createAdmissionBroker({ root, oldLockPath: join(root, 'old-admission.lock'), sampleResources,
    readCpuCapacity: () => 128, readRecoveredSlotMemoryKiB: () => Math.round(1.2 * gib) });
  t.after(() => replacement.close());
  await replacement.start();
  await new Promise(resolve => setImmediate(resolve));
  await requestAdmissionSample(root);
  assert.equal(replacement.status().reservedMemoryKiB, 1.5 * gib + 9 * gib,
    'the anonymous recovered slot reserves its 1.2 GiB memory.current; the identified one its 9 GiB identity peak');
  finished.resolve();
  await task;
  await anonymous.release();
});

test('an identity whose history includes a 38.9 GiB kernel peak never reserves less than 38.9 GiB', linux, async t => {
  const gib = 1024 * 1024;
  const peakKiB = Math.round(38.9 * gib);
  const { root, broker, sampleResources } = await fixture(t, {
    readMemory: () => ({ availableMemoryKiB: 100 * gib, totalMemoryKiB: 100 * gib }),
    // Event samples see only 1.2 GiB; they are lower bounds and must never size a reservation.
    readProcesses: () => new Map([[process.pid, { pid: process.pid, parentPid: 1, rssKiB: Math.round(1.2 * gib), pssKiB: 0 }]]),
    admitDisk: () => ({ admitted: true }),
  });
  const identity = { component: 'apps/stack', entry: 'node --test' };
  const settle = async () => { while ((await requestAdmissionSample(root)).activeCount !== 0) await new Promise(resolve => setImmediate(resolve)); };
  const run = readJobPeakKiB => runAdmissionCommand({ root, className: 'compilation', floorKiB: 38 * gib, machine: 'fixture',
    repoDir: root, cacheBaseDir: root, env: {}, projects: ['.'], ...identity, readJobPeakKiB,
    command: process.execPath, args: ['-e', ''] });
  for (const observed of [Math.round(6.1 * gib), peakKiB, Math.round(1 * gib)]) {
    assert.equal(await run(() => observed), 0);
    await settle();
  }
  const probe = async (extra = {}) => {
    const client = await acquire(root, 38 * gib, t, { className: 'compilation', resourceClass: 'compilation',
      projects: ['.'], ...identity, noWait: true, ...extra });
    const reply = await client.next();
    client.socket.destroy();
    await settle();
    return { next: async () => reply };
  };
  const reserved = await (await probe()).next();
  assert.ok(reserved.floorKiB >= peakKiB, `reserved ${reserved.floorKiB} KiB below the recorded ${peakKiB} KiB peak`);
  const unrecorded = await (await probe({ entry: 'node other.mjs' })).next();
  assert.ok(unrecorded.floorKiB >= peakKiB, 'an unrecorded identity reserves at least the class kernel maximum');
  const otherClass = await (await probe({ className: 'compilation-cli', resourceClass: 'compilation-cli' })).next();
  assert.equal(otherClass.floorKiB, 38 * gib, 'a class without kernel history keeps the requested floor');
  const successor = createAdmissionBroker({ root, oldLockPath: join(root, 'old-admission-2.lock'), sampleResources, readCpuCapacity: () => 128 });
  assert.ok(successor.recordedIdentityFloorKiB({ className: 'compilation', resourceClass: 'compilation', projects: ['.'], ...identity,
    floorKiB: 38 * gib }) >= peakKiB, 'broker succession keeps the recorded maximum');
  void broker;
});

test('a web export with a recorded kernel peak reserves that peak, not its largest worker-count floor', linux, async t => {
  const gib = 1024 * 1024;
  const { root, broker } = await fixture(t, { readMemory: () => ({ availableMemoryKiB: 100 * gib, totalMemoryKiB: 100 * gib }) });
  const identity = { className: 'source-web-export', resourceClass: 'source-web-export', component: '.',
    entry: 'node apps/stack/scripts/build/build_source_web_ui.mjs', projects: ['apps/stack'] };
  // The persisted maximum kernel peak of this export identity (broker record).
  await writeFile(join(root, 'identity-kernel-peaks.json'), JSON.stringify({
    [JSON.stringify([identity.resourceClass, identity.component, identity.entry, identity.projects])]: Math.round(16.25 * gib) }));
  const floorOptions = [{ floorKiB: 32 * gib, workers: 47 }, { floorKiB: 16 * gib, workers: 20 }, { floorKiB: 8 * gib, workers: 1 }];
  const held = await (await acquire(root, 32 * gib, t, { ...identity, commandClass: 'source-web-export', floorOptions })).admit();
  assert.equal(broker.status().reservedMemoryKiB, 16.5 * gib, 'reserves the recorded peak (rounded), not the 32 GiB maximum');
  assert.equal(held.admitted.workers, 20, 'runs the most workers whose modelled floor fits inside the recorded peak');
  const fresh = await (await acquire(root, 32 * gib, t, { ...identity, entry: 'node other-export.mjs', commandClass: 'source-web-export',
    floorOptions })).admit();
  assert.equal(fresh.admitted.workers, 20, 'an unrecorded export identity takes the class kernel maximum');
});

for (const resourceClass of ['focused-validation-ui', 'entry-loads']) {
  test(`completed slots attribute ${resourceClass} through the real client beside its disk class`, linux, async t => {
    const { runAdmittedTask } = await import('./admission_client.mjs');
    const diskClasses = [];
    const { root } = await fixture(t, {
      readProcesses: () => new Map([[process.pid, { pid: process.pid, parentPid: 1, rssKiB: 41 }]]),
      admitDisk: request => { diskClasses.push(request.className); return { admitted: true }; },
    });
    const recorded = new Promise(resolve => {
      const watcher = fs.watch(root, (_, name) => {
        if (name === 'completed-slot-memory.jsonl') { watcher.close(); resolve(); }
      });
      t.after(() => watcher.close());
    });
    await runAdmittedTask({ root, className: resourceClass, floorKiB: 20,
      machine: 'fixture', repoDir: root, cacheBaseDir: root, env: {} }, async () => {
      // Another arrival supplies the existing broker event sample while this
      // real client's slot is active; no test-only sampler or history writer.
      const observer = await acquire(root, 1, t, { pid: 999999 });
      await observer.admit();
    });
    await recorded;
    const rows = (await readFile(join(root, 'completed-slot-memory.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].resourceClass, resourceClass);
    assert.equal(rows[0].className, 'validation');
    assert.equal(rows[0].floorKiB, 20);
    assert.equal(rows[0].peakRssKiB, 41);
    assert.deepEqual(diskClasses, ['validation', 'validation']);
  });
}

test('native compiler admission tags completion peaks with canonical projects', { ...linux, timeout: 10_000 }, async t => {
  let child;
  const { renderNativeCommandPolicy } = await import('../dev_targets/remote_commands.mjs');
  const { root } = await fixture(t, {
    readMemory: () => ({ availableMemoryKiB: 100 * 1024 * 1024, totalMemoryKiB: 100 * 1024 * 1024 }),
    readProcesses: () => child ? new Map([[child.pid, { pid: child.pid, parentPid: 1, rssKiB: 41 }]]) : new Map(),
  });
  const repo = fileURLToPath(new URL('../../../../../', import.meta.url)).replace(/\/$/, '');
  const launcher = join(root, 'launcher.sh');
  // Substitute only the executable payload/reentry, keeping native policy,
  // admission CLI, client, broker and history writer real.
  await writeFile(launcher, '#!/bin/sh\nshift 2\nexec "$@"\n', { mode: 0o700 });
  const client = new URL('./admission_client.mjs', import.meta.url).href;
  const recorded = new Promise(resolve => {
    const watcher = fs.watch(root, (_, name) => {
      if (name === 'completed-slot-memory.jsonl') { watcher.close(); resolve(); }
    });
    t.after(() => watcher.close());
  });
  const script = `${renderNativeCommandPolicy()}
repo_root=$1; invoked_cwd=$1; script_dir=$1/apps/stack/bin; launcher_path=$3
. "$1/apps/stack/scripts/utils/proc/native_process_identity.sh"
. "$1/apps/stack/scripts/utils/proc/native_process_priority.sh"
. "$1/apps/stack/scripts/utils/proc/native_admission_client.sh"
resolve_native_command_policy node scripts/workspaces/runTypeScriptCli.mjs -p packages/brand/tsconfig.json -p packages/agents/tsconfig.json
run_heavyweight_admission "$2" compilation fixture "$4" --input-type=module -e "$5" "$2"
`;
  child = spawn('/bin/sh', ['-c', script, 'compiler-peak', repo, root, launcher, process.execPath,
    // A sample request only reads status. A second admission observes the live
    // compiler slot before its payload exits, making a completion peak real.
    `import { requestAdmissionSample } from ${JSON.stringify(client)}; await requestAdmissionSample(process.argv[1], { kind: 'acquire', floorKiB: 1, pid: process.pid, className: 'compilation', repoDir: process.cwd() });`],
  { env: { ...process.env, HAPPIER_HEAVYWEIGHT_ADMISSION_SLOT: '', HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN: '' }, stdio: 'ignore' });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  // Fixture capacity models a real host large enough for the canonical floor.
  assert.equal(await new Promise(resolve => child.once('exit', resolve)), 0);
  await recorded;
  const rows = (await readFile(join(root, 'completed-slot-memory.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].projects, ['packages/brand/tsconfig.json', 'packages/agents/tsconfig.json']);
});

function captureRecoveryClock(t) {
  // Timer scheduling is the OS boundary; broker/socket/resource decisions stay real.
  const active = new Map();
  for (const [schedule, cancel, once] of [
    ['setInterval', 'clearInterval', false], ['setTimeout', 'clearTimeout', true],
  ]) {
    const nativeSchedule = globalThis[schedule];
    const nativeCancel = globalThis[cancel];
    t.mock.method(globalThis, schedule, (callback, milliseconds, ...args) => {
      if (milliseconds !== DEFAULT_FILE_CHANGE_CATCH_UP_MS) return nativeSchedule(callback, milliseconds, ...args);
      const timer = { unref() {} };
      active.set(timer, () => {
        if (once) active.delete(timer);
        return callback();
      });
      return timer;
    });
    t.mock.method(globalThis, cancel, timer => {
      if (!active.delete(timer)) nativeCancel(timer);
    });
  }
  return { active, tick: async () => {
    await Promise.all([...active.values()].map(callback => callback()));
  } };
}

test('a reconnect burst shares one capacity walk and answers sample before another walk', linux, async t => {
  captureRecoveryClock(t);
  let walks = 0;
  const memory = { availableMemoryKiB: 100, totalMemoryKiB: 100 };
  const { root, broker } = await fixture(t, { readMemory: () => memory });
  const holder = await acquire(root, 100, t);
  await holder.admit();
  await broker.close();
  const replacement = createAdmissionBroker({ root, oldLockPath: join(root, 'old-admission.lock'),
    sampleResources: ({ slots }) => readAdmissionMemorySample({ slots, readMemory: () => memory,
      readProcesses: () => {
        walks += 1;
        return new Map(Array.from({ length: 1700 }, (_, index) => [index + 2,
          { pid: index + 2, parentPid: 1, pssKiB: 0 }]));
      } }),
  });
  await replacement.start();
  t.after(() => replacement.close());
  const before = walks;
  const started = performance.now();
  const clients = await Promise.all(Array.from({ length: 100 }, () => acquire(root, 50, t)));
  const sample = await request(root, { kind: 'sample' });
  const response = await sample.next();
  sample.socket.destroy();
  console.log(JSON.stringify({ reconnectWaiters: clients.length, processRows: 1700,
    walks: walks - before, timeToFirstAnswerMs: performance.now() - started }));
  assert.equal(response.waitingCount, clients.length);
  assert.ok(walks - before <= 1, 'reconnecting demand shares capacity; it cannot change physical memory');
  assert.ok(response.sampleCount <= 2, 'sample answers after at most the one burst observation');
  memory.availableMemoryKiB = 100;
  clients.forEach(client => client.socket.destroy());
});

test('broker replacement orders reconnecting waiters by their original arrival', linux, async t => {
  const clock = captureRecoveryClock(t);
  let availableMemoryKiB = 0;
  const { root, broker, sampleResources } = await fixture(t, {
    readMemory: () => ({ availableMemoryKiB, totalMemoryKiB: 100 }),
  });
  await acquire(root, 70, t, { arrivedAt: 10 });
  await acquire(root, 70, t, { arrivedAt: 20 });
  const initial = await request(root, { kind: 'sample' });
  assert.equal((await initial.next()).waitingCount, 2);
  initial.socket.destroy();
  await broker.close();
  const replacement = createAdmissionBroker({ root, oldLockPath: join(root, 'old-admission.lock'), sampleResources });
  await replacement.start();
  t.after(() => replacement.close());
  const younger = await acquire(root, 70, t, { arrivedAt: 20 });
  const older = await acquire(root, 70, t, { arrivedAt: 10 });
  const barrier = await request(root, { kind: 'sample' });
  assert.equal((await barrier.next()).waitingCount, 2);
  barrier.socket.destroy();
  availableMemoryKiB = 70;
  await clock.tick();
  const first = await Promise.race([
    older.next().then(response => ({ waiter: 'older', response })),
    younger.next().then(response => ({ waiter: 'younger', response })),
  ]);
  assert.equal(first.response.kind, 'reserved');
  assert.equal(first.waiter, 'older');
});

test('a late reconnect permits backfill from capacity free when it becomes head', linux, async t => {
  const { root } = await fixture(t);
  const younger = await acquire(root, 40, t, { arrivedAt: 20 });
  await younger.admit();
  await acquire(root, 70, t, { arrivedAt: 10 });
  const sample = await request(root, { kind: 'sample' });
  assert.equal((await sample.next()).unreservedMemoryKiB, 60);
  sample.socket.destroy();
  const backfill = await acquire(root, 20, t, { arrivedAt: 30, noWait: true });
  await backfill.admit();
});

test('queue positions advance on existing passes and unchanged waiters stay silent', linux, async t => {
  const clock = captureRecoveryClock(t);
  const notices = [];
  const nativeWrite = Socket.prototype.write;
  // Observe the real transport output, including its owning server socket.
  t.mock.method(Socket.prototype, 'write', function (chunk, ...args) {
    if (typeof chunk === 'string' && chunk.startsWith('{')) {
      const response = JSON.parse(chunk);
      if (response.kind === 'queued') notices.push({ socket: this, response });
    }
    return nativeWrite.call(this, chunk, ...args);
  });
  const { root } = await fixture(t, { readMemory: () => ({ availableMemoryKiB: 0, totalMemoryKiB: 100 }) });
  for (let index = 0; index < 3; index++) {
    await acquire(root, 70, t);
    const barrier = await request(root, { kind: 'sample' });
    await barrier.next();
    barrier.socket.destroy();
  }
  const positions = () => notices.map(({ response }) =>
    [response.queuePosition, response.countAhead, response.waitingCount]);
  assert.deepEqual(positions(), [[1, 0, 1], [2, 1, 2], [3, 2, 3]],
    'each arrival gets its own rank without logging unchanged older ranks');
  const closed = once(notices[0].socket, 'close');
  notices[0].socket.destroy();
  await closed;
  const after = await request(root, { kind: 'sample' });
  await after.next();
  after.socket.destroy();
  assert.deepEqual(positions().slice(3), [[1, 0, 2], [2, 1, 2]],
    'withdrawing the head advances each remaining waiter at the owner');
  await clock.tick();
  await clock.tick();
  assert.equal(notices.length, 5, 'unchanged positions do not produce catch-up log spam');
});

test('each admission ahead advances a connected waiter until it reaches the head and runs', linux, async t => {
  const notices = [];
  const nativeWrite = Socket.prototype.write;
  // Observe broker progress at the socket boundary; ordering and admission stay real.
  t.mock.method(Socket.prototype, 'write', function (chunk, ...args) {
    if (typeof chunk === 'string' && chunk.startsWith('{')) {
      const response = JSON.parse(chunk);
      if (response.kind === 'queued') notices.push({ socket: this, response });
    }
    return nativeWrite.call(this, chunk, ...args);
  });
  const { root, broker } = await fixture(t);
  const holder = await (await acquire(root, 100, t)).admit();
  const admissionsAhead = 2;
  const ahead = [];
  const barrier = async () => {
    const sample = await request(root, { kind: 'sample' });
    await sample.next();
    sample.socket.destroy();
  };
  for (let index = 0; index < admissionsAhead; index++) {
    ahead.push(await acquire(root, 100, t));
    await barrier();
  }
  const waiter = await acquire(root, 100, t);
  await barrier();
  const waiterSocket = notices.at(-1).socket;
  const positions = () => notices.filter(notice => notice.socket === waiterSocket)
    .map(({ response }) => response.queuePosition);
  assert.deepEqual(positions(), [admissionsAhead + 1]);
  let active = holder;
  for (const [index, client] of ahead.entries()) {
    await active.release();
    active = await client.admit();
    await barrier();
    assert.equal(positions().at(-1), admissionsAhead - index,
      'each admission ahead removes exactly one predecessor from the queue');
  }
  assert.deepEqual(positions(), [3, 2, 1]);
  await active.release();
  await waiter.admit();
  assert.equal(broker.status().waitingCount, 0);
  assert.equal(broker.status().activeCount, 1, 'the original waiter runs when the head fits');
});

test('a missing slot settles its own request even when the following memory observation fails', linux, async t => {
  // Capture the wire outcome at the OS boundary so a missing refusal fails an
  // assertion instead of leaving this negative regression waiting forever.
  const refusals = [];
  const nativeWrite = Socket.prototype.write;
  t.mock.method(Socket.prototype, 'write', function (chunk, ...args) {
    if (typeof chunk === 'string' && chunk.startsWith('{')) {
      const response = JSON.parse(chunk);
      if (response.kind === 'refused') refusals.push(response);
    }
    return nativeWrite.call(this, chunk, ...args);
  });
  let fail = false;
  const { root, broker } = await fixture(t, { readMemory: () => {
    if (fail) throw Object.assign(new Error('Memory read failed'), { code: 'EIO' });
    return { availableMemoryKiB: 100, totalMemoryKiB: 100 };
  } });
  const affected = await acquire(root, 20, t);
  assert.equal((await affected.next()).kind, 'reserved');
  const unrelated = await acquire(root, 90, t);
  const barrier = await request(root, { kind: 'sample' });
  await barrier.next();
  barrier.socket.destroy();
  fail = true;
  affected.socket.write(JSON.stringify({ kind: 'ready' }) + '\n');
  const after = await request(root, { kind: 'sample' });
  await after.next();
  after.socket.destroy();
  assert.equal(broker.status().waitingCount, 1, 'a vanished slot must not leave its request stranded after resampling fails');
  assert.equal(refusals.some(response => response.reason === 'HSTACK_SLOT_UNAVAILABLE'), true,
    'the vanished-slot request must settle before fallible resampling');
  assert.equal((await affected.next()).reason, 'HSTACK_SLOT_UNAVAILABLE');
  fail = false;
  const wake = await acquire(root, 1, t);
  await unrelated.admit();
  await wake.admit();
});

test('a resource observation failure settles only its waiter without leaving a phantom reservation', linux, async t => {
  const clock = captureRecoveryClock(t);
  let availableMemoryKiB = 0;
  let fail = false;
  const { root, broker } = await fixture(t, { readMemory: () => ({ availableMemoryKiB, totalMemoryKiB: 100 }) });
  const lock = { path: join(root, 'fault.lock') };
  const nativeRead = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (path, ...args) => {
    if (fail && path === lock.path) throw Object.assign(new Error('Resource read failed'), { code: 'EIO' });
    return nativeRead(path, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const affected = await acquire(root, 70, t, { locks: [lock] });
  const unaffected = await acquire(root, 40, t);
  const barrier = await request(root, { kind: 'sample' });
  await barrier.next();
  barrier.socket.destroy();
  fail = true;
  availableMemoryKiB = 100;
  await clock.tick();
  assert.equal(broker.status().reservedMemoryKiB, 40, 'the failing snapshot must not leave an unoffered slot or block other waiters');
  // Publication-priority notices can precede the failure decision while
  // arrivals revisit this memory waiter; consume the decision itself.
  let refused;
  do { refused = await affected.next(); } while (refused.kind === 'capacity-wait');
  assert.equal(refused.kind, 'refused');
  assert.equal(refused.reason, 'HSTACK_RESOURCE_OBSERVATION_UNAVAILABLE');
  assert.equal(refused.cause, 'EIO');
  await unaffected.admit();
});

test('a disk admission exception refuses only its request without invalidating host memory', linux, async t => {
  const { root, broker } = await fixture(t);
  const holder = await acquire(root, 100, t);
  const held = await holder.admit();
  const older = await acquire(root, 70, t);
  // A broker with an older disk catalog can receive a newly introduced class.
  // Exercise the real disk owner, whose unknown-class check throws before I/O.
  const unsupported = await acquire(root, 1, t, { className: 'fixture-new-class' });
  const barrier = await request(root, { kind: 'sample' });
  await barrier.next();
  barrier.socket.destroy();
  assert.equal(broker.status().waitingCount, 1, 'the failed disk request must settle without consuming unrelated waiters');
  assert.equal(broker.status().availableMemoryKiB, 100, 'a request-specific disk failure must not zero a valid host sample');
  const refused = await unsupported.next();
  assert.equal(refused.kind, 'refused');
  assert.equal(refused.reason, 'HSTACK_ADMISSION_UNAVAILABLE');
  assert.equal(refused.cause, 'Error');
  await held.release();
  await older.admit();
});

test('a failed memory pass retains oldest-first waiters and recovers on the existing catch-up', linux, async t => {
  const clock = captureRecoveryClock(t);
  let availableMemoryKiB = 0;
  let fail = false;
  const { root, broker } = await fixture(t, { readMemory: () => {
    if (fail) throw Object.assign(new Error('Memory read failed'), { code: 'EIO' });
    return { availableMemoryKiB, totalMemoryKiB: 100 };
  } });
  const older = await acquire(root, 70, t);
  const younger = await acquire(root, 40, t);
  const barrier = async () => {
    const reader = await request(root, { kind: 'sample' });
    await reader.next();
    reader.socket.destroy();
  };
  await barrier();
  assert.equal(broker.status().waitingCount, 2);
  fail = true;
  await clock.tick();
  assert.equal(broker.status().waitingCount, 2, 'an observation failure must not consume queued requests');
  assert.equal(broker.status().unreservedMemoryKiB, 0, 'failed observations cannot authorize from stale capacity');
  assert.equal(clock.active.size, 1, 'the existing catch-up must remain armed after a failed pass');
  assert.equal(broker.status().lastFailure?.code, 'EIO');
  assert.match(broker.status().lastFailure?.source ?? '', /^admission_broker\.test\.mjs:\d+:\d+$/);
  assert.doesNotMatch(JSON.stringify(broker.status().lastFailure), /Memory read failed/);
  fail = false;
  availableMemoryKiB = 100;
  await clock.tick();
  const held = await older.admit();
  assert.equal(broker.status().lastFailure?.code, 'EIO', 'recovery must retain the failure evidence');
  assert.equal(broker.status().waitingCount, 1, 'younger work cannot displace the head reservation');
  assert.equal(broker.status().reservedMemoryKiB, 70);
  await held.release();
  await younger.admit();
});

test('queued filesystem notifications share one resource snapshot and still wake on release', linux, async t => {
  captureRecoveryClock(t);
  const { root, broker } = await fixture(t);
  let notify;
  let scans = 0;
  const readdir = fs.readdirSync;
  // Filesystem notifications and reads are the OS boundary. Resource identity,
  // publication priority, broker admission and the client handshake stay real.
  t.mock.method(fs, 'watch', (_directory, callback) => {
    notify = callback;
    return Object.assign(new EventEmitter(), { close() {} });
  });
  t.mock.method(fs, 'readdirSync', (path, ...args) => {
    if (path === root) scans += 1;
    return readdir(path, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const locks = [{ path: join(root, 'publication.lock') }];
  const priority = createWorkspaceBundleLockPriorityScope({ resources: locks });
  priority.activate();
  t.after(() => priority.dispose());
  const blocked = await acquire(root, 10, t, { locks });
  assert.equal((await blocked.next()).kind, 'reserved');
  assert.equal((await tryWorkspaceBuildResources({ locks })).acquired, false);
  blocked.socket.write(JSON.stringify({ kind: 'resources-busy' }) + '\n');
  const barrier = async () => {
    const reader = await request(root, { kind: 'sample' });
    await reader.next();
    reader.socket.destroy();
  };
  await barrier();
  scans = 0;
  for (let index = 0; index < 40; index += 1) {
    notify('change', 'publication.lock');
    // Node drains microtasks between native watcher callbacks in one poll batch.
    await Promise.resolve();
  }
  await new Promise(setImmediate);
  await barrier();
  assert.equal(scans, 1, 'queued notifications must not multiply unchanged resource scans');
  assert.equal(broker.status().activeCount, 0);
  priority.dispose();
  notify('rename', 'publication.lock');
  const held = await blocked.admit();
  assert.equal(broker.status().activeCount, 1, 'a real release must still admit the retained waiter');
  await held.release();
});

test('the head floor survives a stream of small jobs, with backfill only from spare memory and no idle observations', linux, async t => {
  const { root, broker } = await fixture(t);
  const first = await acquire(root, 40, t);
  const held = await first.admit();
  const second = await acquire(root, 40, t);
  const alsoHeld = await second.admit();
  const large = await acquire(root, 70, t, { arrivedAt: Date.now() - headReservationDelayMs });
  const small = await acquire(root, 20, t);
  // admission-backfill-1106: older holders cover the head's future floor.
  const placement = await request(root, { kind: 'sample' });
  await placement.next();
  placement.socket.destroy();
  assert.equal(broker.status().activeCount, 3, 'spare memory admits the small follower before older holders release');
  const admittedSmall = await small.admit();
  const assertNoBackfill = async () => {
    for (let index = 0; index < 4; index += 1) {
      const arrival = await acquire(root, 20, t, { noWait: true });
      assert.equal((await arrival.next()).reason, 'HSTACK_MEMORY_BUSY',
        'new small jobs must not consume memory reserved for the waiting head');
    }
    assert.equal(broker.status().waitingCount, 1,
      'the head retains its position while small jobs use only spare memory');
  };
  await assertNoBackfill();
  const placementSample = await request(root, { kind: 'sample' });
  assert.equal((await placementSample.next()).unreservedMemoryKiB, 0,
    'placement must not advertise memory covered by the waiting head floor');
  placementSample.socket.destroy();
  const samples = broker.status().sampleCount;
  for (let index = 0; index < 20; index += 1) {
    const client = await request(root, { kind: 'sample' });
    assert.equal((await client.next()).sampleCount, samples);
    client.socket.destroy();
  }
  assert.equal(broker.status().sampleCount, samples);
  await held.release();
  await assertNoBackfill();
  assert.equal(broker.status().reservedMemoryKiB, 60);
  await alsoHeld.release();
  // Backfill remains active while the second release makes room for the head.
  const admittedLarge = await large.admit();
  assert.equal(broker.status().reservedMemoryKiB, 90);
  await admittedLarge.release();
  await admittedSmall.release();
});

test('an aged head lends its pledge only to jobs projected to finish before its own projected start (EASY backfill)', linux, async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const { root } = await fixture(t);
  const timed = p99DurationMs => ({ durationClass: 'targeted-validation', p99DurationMs });
  await (await acquire(root, 40, t, timed(100_000))).admit();
  const ending = await (await acquire(root, 20, t, timed(1_000))).admit();
  const pledger = await (await acquire(root, 30, t, timed(100_000))).admit();
  const head = await acquire(root, 50, t, { arrivedAt: now - headReservationDelayMs });
  await pledger.release();
  const pledged = await requestAdmissionSample(root);
  assert.equal(pledged.head.reservationKiB, 30);
  assert.equal(pledged.unreservedMemoryKiB, 10);
  // Head projection: 40 free now (incl. its pledge) + 20 when `ending` reaches its p99 at +1 s >= 50.
  const long = await acquire(root, 20, t, { ...timed(5_000), noWait: true });
  assert.equal((await long.next()).reason, 'HSTACK_MEMORY_BUSY', 'a job outliving the head projection must not borrow its pledge');
  const short = await acquire(root, 20, t, { ...timed(500), noWait: true });
  const backfilled = await short.admit();
  const borrowed = await requestAdmissionSample(root);
  assert.equal(borrowed.activeCount, 3, 'a job ending before the head can start backfills from the pledge');
  assert.equal(borrowed.head.reservationKiB, 20, 'the pledge lends only the shortfall beyond unpledged free memory');
  now += 500;
  await backfilled.release();
  assert.equal((await requestAdmissionSample(root)).head.reservationKiB, 40, 'the borrowed memory returns to the head');
  now += 500;
  await ending.release();
  await head.admit();
  assert.equal((await requestAdmissionSample(root)).waitingCount, 0, 'the head starts at its projected time');
});

test('without projected run times the aged head pledge stays exclusive', linux, async t => {
  const { root } = await fixture(t);
  await (await acquire(root, 40, t)).admit();
  await (await acquire(root, 20, t)).admit();
  const pledger = await (await acquire(root, 30, t)).admit();
  await acquire(root, 50, t, { arrivedAt: Date.now() - headReservationDelayMs });
  await pledger.release();
  const short = await acquire(root, 20, t, { durationClass: 'targeted-validation', p99DurationMs: 1, noWait: true });
  assert.equal((await short.next()).reason, 'HSTACK_MEMORY_BUSY', 'unknown holder end times give no head projection to backfill against');
});

test('late old launchers cannot acquire their existing flock while the broker runs or after its restart', linux, async t => {
  const { root, broker, sampleResources } = await fixture(t);
  const oldLockPath = join(root, 'old-admission.lock');
  const attemptOldAdmission = () => spawnSync('flock', ['--nonblock', '--exclusive', oldLockPath, '/bin/true'],
    { stdio: 'ignore' }).status;
  assert.equal(attemptOldAdmission(), 1, 'the broker must exclude a late old launcher for its entire runtime');
  await broker.close();
  assert.equal(attemptOldAdmission(), 0, 'stopping the broker releases the old lock');
  const replacement = createAdmissionBroker({ root, oldLockPath, sampleResources });
  t.after(() => replacement.close());
  await replacement.start();
  assert.equal(attemptOldAdmission(), 1, 'a restarted broker must reacquire the same old lock');
  const owner = await acquire(root, 10, t);
  const held = await owner.admit();
  await held.release();
  await replacement.close();
  assert.equal(attemptOldAdmission(), 0);
});

test('cutover transfers both already-held flock descriptions without reopening the old admission path', linux, async t => {
  const root = await mkdtemp('/tmp/happier-broker-handoff-');
  const oldLockPath = join(root, 'old-admission.lock');
  const startupLockPath = join(root, 'broker-start.lock');
  const barrierFds = new Set([openSync(oldLockPath, 'a', 0o600), openSync(startupLockPath, 'a', 0o600)]);
  const [oldFd, startupFd] = barrierFds;
  const children = new Set();
  t.after(async () => {
    for (const fd of barrierFds) closeSync(fd);
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = once(child, 'close');
        child.kill('SIGKILL');
        await closed;
      }
    }
    await rm(root, { recursive: true, force: true });
  });
  for (const fd of barrierFds) {
    assert.equal(spawnSync('flock', ['--exclusive', '3'], { stdio: ['ignore', 'ignore', 'ignore', fd] }).status, 0);
  }
  const start = inherited => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./admission_broker.mjs', import.meta.url)),
      '--serve', root, `--old-lock-path=${oldLockPath}`,
      ...(inherited ? ['--old-lock-fd=3', '--startup-lock-fd=4'] : [])],
    { stdio: inherited ? ['ignore', 'pipe', 'ignore', oldFd, startupFd] : ['ignore', 'pipe', 'ignore'] });
    children.add(child);
    const exited = once(child, 'close');
    const lines = createInterface({ input: child.stdout });
    const ready = Promise.race([
      once(lines, 'line').then(([line]) => assert.equal(line, 'ready')),
      exited.then(() => { throw new Error('Private handoff broker exited before readiness'); }),
    ]).finally(() => lines.close());
    return { child, ready, exited };
  };
  const inherited = start(true);
  await inherited.ready;
  const ordinary = start(false);
  // Closing releases only the barrier's copies, never LOCK_UN on the shared
  // descriptions. The broker keeps the old one and startup has now settled.
  for (const fd of barrierFds) closeSync(fd);
  barrierFds.clear();
  await ordinary.ready;
  assert.equal((await ordinary.exited)[0], 0, 'a competing regular starter must settle through the existing listener');
  assert.equal(spawnSync('flock', ['--nonblock', '--exclusive', startupLockPath, '/bin/true']).status, 0);
  assert.equal(spawnSync('flock', ['--nonblock', '--exclusive', oldLockPath, '/bin/true']).status, 1,
    'a late old launcher must stay excluded after the barrier closes its copies');
  const status = await request(root, { kind: 'sample' });
  assert.ok((await status.next()).totalMemoryKiB > 0, 'the inherited broker must remain usable');
  status.socket.destroy();
  inherited.child.kill('SIGKILL');
  await inherited.exited;
  assert.equal(spawnSync('flock', ['--nonblock', '--exclusive', oldLockPath, '/bin/true']).status, 0,
    'the old path opens only after the broker stops');
});

test('broker restart recovers live kernel slots and closes release them without a PID reaper', linux, async t => {
  const { root, broker, sampleResources } = await fixture(t);
  const first = await acquire(root, 80, t);
  const held = await first.admit();
  await broker.close();
  const failedRecovery = createAdmissionBroker({ root, oldLockPath: join(root, 'old-admission.lock'), sampleResources });
  const connect = net.createConnection;
  // EMFILE is an OS descriptor-acquisition failure, not evidence that the
  // already-bound job witness disappeared. Keep every broker policy real.
  t.mock.method(net, 'createConnection', (...args) => {
    if (args[0] !== held.slotAddress) return connect(...args);
    const socket = new Socket();
    queueMicrotask(() => socket.emit('error', Object.assign(new Error('descriptor acquisition failed'), { code: 'EMFILE' })));
    return socket;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(failedRecovery.start(), { code: 'EMFILE' });
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await failedRecovery.close();
  }
  const replacement = createAdmissionBroker({ root, oldLockPath: join(root, 'old-admission.lock'), sampleResources });
  await replacement.start();
  t.after(() => replacement.close());
  assert.equal(replacement.status().reservedMemoryKiB, 80);
  const queued = await acquire(root, 30, t);
  const check = await request(root, { kind: 'check', floorKiB: 30 });
  assert.equal((await check.next()).kind, 'refused');
  check.socket.destroy();
  await held.release();
  const next = await queued.admit();
  assert.equal(replacement.status().reservedMemoryKiB, 30);
  await next.release();
});

test('a killed holder releases its slot and leaves no slot socket file behind', linux, async t => {
  const { root, broker } = await fixture(t);
  const client = await acquire(root, 60, t);
  const reserved = await client.next();
  assert.equal(reserved.kind, 'reserved');
  // OS boundary: a SIGKILLed holder never closes (or unlinks) its listener.
  const holder = spawn(process.execPath, ['--input-type=module', '-e',
    'import { createServer } from "node:net"; createServer().listen(process.argv[1], () => process.stdout.write("listening\\n")); setInterval(() => {}, 1 << 30);',
    reserved.slotAddress], { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => holder.kill('SIGKILL'));
  await once(holder.stdout, 'data');
  client.socket.write(JSON.stringify({ kind: 'ready' }) + '\n');
  assert.equal((await client.next()).kind, 'admitted');
  holder.kill('SIGKILL');
  await once(holder, 'exit');
  while (broker.status().activeCount !== 0) await new Promise(resolve => setImmediate(resolve));
  assert.equal(broker.status().reservedMemoryKiB, 0);
  await assert.rejects(lstat(reserved.slotAddress), { code: 'ENOENT' },
    'a released slot leaves no socket file that a filesystem census could count as held');
});

test('status projects a new arrival\'s start from memory × recorded run time ahead over achievable capacity', linux, async t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const { root } = await fixture(t);
  const durationClass = 'targeted-validation';
  const held = await (await acquire(root, 60, t, { durationClass, p99DurationMs: 1_000 })).admit();
  await acquire(root, 50, t, { durationClass, p99DurationMs: 2_000 });
  await acquire(root, 50, t);
  const sample = await requestAdmissionSample(root);
  // Slot: 60 × 1000 remaining. Waiters: 50 × 2000, and 50 × the mean recorded
  // p99 (1500) for the waiter without one. Achievable capacity is 100.
  assert.equal(sample.expectedStartMs, (60 * 1_000 + 50 * 2_000 + 50 * 1_500) / 100);
  now += 400;
  assert.equal((await requestAdmissionSample(root)).expectedStartMs, (60 * 600 + 50 * 2_000 + 50 * 1_500) / 100,
    'an admitted slot contributes only its remaining recorded run time; the fill stays the mean recorded p99');
  await held.release();
});

test('queued notices report the floor the broker reserves, not the client class floor', linux, async t => {
  const gib = 1024 * 1024;
  const notices = [];
  const nativeWrite = Socket.prototype.write;
  t.mock.method(Socket.prototype, 'write', function (chunk, ...args) {
    if (typeof chunk === 'string' && chunk.startsWith('{') && JSON.parse(chunk).kind === 'queued') notices.push(JSON.parse(chunk));
    return nativeWrite.call(this, chunk, ...args);
  });
  const { root } = await fixture(t, { readMemory: () => ({ availableMemoryKiB: 0, totalMemoryKiB: 100 * gib }) });
  const identity = { className: 'compilation', component: '.', entry: 'node scripts/workspaces/commitPackageTypecheck.mjs', projects: ['.'] };
  await writeFile(join(root, 'identity-kernel-peaks.json'), JSON.stringify({
    [JSON.stringify(['compilation', '.', identity.entry, ['.']])]: Math.round(16.9 * gib) }));
  await acquire(root, 38 * gib, t, identity);
  const barrier = await request(root, { kind: 'sample' });
  await barrier.next();
  barrier.socket.destroy();
  assert.equal(notices.at(-1)?.floorKiB, 17 * gib, 'the recorded 16.9 GiB peak rounds to a 17 GiB reservation');
});

test('restart discards crash-stale slot sockets while preserving live slots and unrelated files', linux, async t => {
  const { root, broker, sampleResources } = await fixture(t);
  const held = await (await acquire(root, 80, t)).admit();
  await broker.close();
  const staleAddress = slotAddress(root, process.pid, 90, '00000000-0000-4000-8000-000000000001', 1);
  const stale = spawnSync(process.execPath, ['--input-type=module', '-e',
    'import { createServer } from "node:net"; createServer().listen(process.argv[1], () => process.exit(0));',
    staleAddress], { stdio: 'ignore' });
  assert.equal(stale.status, 0);
  assert.equal((await lstat(staleAddress)).isSocket(), true);
  const unrelated = join(root, 'publication-note');
  await writeFile(unrelated, 'retained');
  const replacement = createAdmissionBroker({ root, oldLockPath: join(root, 'old-admission.lock'), sampleResources });
  t.after(() => replacement.close());
  await replacement.start();
  assert.equal(replacement.status().activeCount, 1);
  assert.equal(replacement.status().reservedMemoryKiB, 80, 'only the live job consumes recovered capacity');
  await assert.rejects(lstat(staleAddress), { code: 'ENOENT' });
  assert.equal(await readFile(unrelated, 'utf8'), 'retained');
  const queued = await acquire(root, 100, t);
  const check = await request(root, { kind: 'check', floorKiB: 100 });
  assert.equal((await check.next()).reason, 'HSTACK_MEMORY_BUSY');
  check.socket.destroy();
  await held.release();
  await queued.admit();
});

test('canonical shell root names are numeric-UID scoped for the owner and another real UID', linux, async t => {
  const root = await mkdtemp('/tmp/happier-root-test-');
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o755);
  const source = join(root, 'state.sh');
  await writeFile(source, await readFile(new URL('./native_host_admission_state.sh', import.meta.url)), { mode: 0o644 });
  await chmod(source, 0o644);
  // Source the real canonical owner without invoking its resolver or creating
  // either account's actual admission root. The copy is readable by nobody.
  const args = ['-c', 'id -u; . "$1"; printf "%s\\n" "$native_host_admission_root"', 'root-test', source];
  const owner = spawnSync('/bin/sh', args, { encoding: 'utf8' });
  const invocation = otherUserCommand('/bin/sh', args);
  const foreign = spawnSync(invocation[0], invocation[1], { encoding: 'utf8' });
  assert.equal(owner.status, 0);
  assert.equal(foreign.status, 0, 'HSTACK_TEST_OTHER_UID_UNAVAILABLE');
  const [ownerUid, ownerRoot] = owner.stdout.trim().split('\n');
  const [foreignUid, foreignRoot] = foreign.stdout.trim().split('\n');
  assert.equal(Number(ownerUid), process.geteuid());
  assert.notEqual(foreignUid, ownerUid);
  assert.equal(ownerRoot, `/tmp/happier-heavyweight-admission-v3-${ownerUid}`);
  assert.equal(foreignRoot, `/tmp/happier-heavyweight-admission-v3-${foreignUid}`);
});

test('another real UID cannot connect to the broker or bind an owner witness, while the owner admits', linux, async t => {
  const { root } = await fixture(t);
  const probe = String.raw`import errno, json, os, socket, sys
addresses = json.loads(sys.argv[1])
result = {"uid": os.geteuid(), "errors": {}}
for operation, address in addresses.items():
    peer = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        if operation == "connect": peer.connect(address)
        else: peer.bind(address)
        result["errors"][operation] = None
    except OSError as error:
        result["errors"][operation] = error.errno
    finally:
        peer.close()
print(json.dumps(result))`;
  // Pass the owner's actual addresses; recomputing a UID-scoped name as the
  // other account would test an unrelated endpoint and give false assurance.
  const addresses = JSON.stringify({ connect: brokerAddress(root),
    bind: slotAddress(root, process.pid, 1, '00000000-0000-0000-0000-000000000000') });
  const invocation = otherUserCommand('/usr/bin/python3', ['-c', probe, addresses]);
  const result = spawnSync(invocation[0], invocation[1], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    assert.fail('HSTACK_TEST_OTHER_UID_UNAVAILABLE: real other-UID security proof requires the approved noninteractive system-Python runner');
  }
  const observed = JSON.parse(result.stdout);
  assert.notEqual(observed.uid, process.geteuid());
  assert.ok([1, 13].includes(observed.errors.connect), `other UID connect must be EPERM/EACCES, received ${observed.errors.connect}`);
  assert.ok([1, 13].includes(observed.errors.bind), `other UID bind must be EPERM/EACCES, received ${observed.errors.bind}`);
  const guardedOwner = await connectAdmissionBroker(root);
  guardedOwner.destroy();
  const owner = await acquire(root, 10, t);
  const held = await owner.admit();
  await held.release();
});

test('broker and client reject a real foreign-owned root even with a connectable planted socket', linux, async t => {
  const probe = String.raw`import json, os, socket, sys, tempfile
root = tempfile.mkdtemp(prefix="happier-foreign-", dir="/tmp")
address = os.path.join(root, "broker.sock")
peer = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
try:
    os.chmod(root, 0o755)
    peer.bind(address)
    os.chmod(address, 0o777)
    peer.listen()
    print(json.dumps({"root": root, "uid": os.geteuid()}), flush=True)
    sys.stdin.readline()
finally:
    peer.close()
    if os.path.exists(address): os.unlink(address)
    os.rmdir(root)`;
  const invocation = otherUserCommand('/usr/bin/python3', ['-c', probe]);
  const foreign = spawn(invocation[0], invocation[1], { stdio: ['pipe', 'pipe', 'ignore'] });
  const lines = createInterface({ input: foreign.stdout });
  t.after(async () => {
    if (foreign.exitCode === null) {
      const closed = once(foreign, 'close');
      foreign.stdin.end('\n');
      await closed;
    }
    lines.close();
  });
  const ready = await new Promise((resolveReady, reject) => {
    foreign.once('error', reject);
    foreign.once('exit', () => reject(new Error('HSTACK_TEST_OTHER_UID_UNAVAILABLE')));
    lines.once('line', resolveReady);
  });
  const observed = JSON.parse(ready);
  assert.notEqual(observed.uid, process.geteuid());
  assert.equal((await lstat(observed.root)).uid, observed.uid);
  // Prove the endpoint is actually reachable; OS denial from a private
  // foreign root would not exercise the client's own root admission check.
  const unguarded = createConnection(brokerAddress(observed.root));
  await once(unguarded, 'connect');
  unguarded.destroy();
  const broker = createAdmissionBroker({ root: observed.root });
  t.after(() => broker.close());
  await assert.rejects(broker.start(), { code: 'EACCES' });
  await assert.rejects(async () => {
    const connected = await connectAdmissionBroker(observed.root);
    connected.destroy();
  }, { code: 'EACCES' });
});

test('client refuses a same-UID loose root rather than connecting or changing its permissions', linux, async t => {
  const root = await mkdtemp('/tmp/happier-loose-');
  await chmod(root, 0o755);
  const server = createServer(socket => socket.destroy());
  server.listen(brokerAddress(root));
  await once(server, 'listening');
  t.after(async () => {
    await new Promise(resolveClosed => server.close(resolveClosed));
    await rm(root, { recursive: true, force: true });
  });
  await assert.rejects(async () => {
    const connected = await connectAdmissionBroker(root);
    connected.destroy();
  }, { code: 'EACCES' });
  assert.equal((await lstat(root)).mode & 0o777, 0o755);
});

test('startup replaces a real crash-stale pathname socket under its separate kernel lock', linux, async t => {
  const root = await mkdtemp('/tmp/happier-broker-crash-');
  let broker;
  const child = spawn(process.execPath, [fileURLToPath(new URL('./admission_broker.mjs', import.meta.url)), '--serve', root,
    `--old-lock-path=${join(root, 'old-admission.lock')}`],
    { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close');
      child.kill('SIGKILL');
      await closed;
    }
    await broker?.close();
    await rm(root, { recursive: true, force: true });
  });
  const lines = createInterface({ input: child.stdout });
  await new Promise((ready, reject) => {
    child.once('error', reject);
    child.once('exit', () => reject(new Error('Private fixture broker exited before readiness')));
    lines.once('line', line => line === 'ready' ? ready() : reject(new Error('Private fixture broker not ready')));
  });
  lines.close();
  const closed = once(child, 'close');
  child.kill('SIGKILL');
  await closed;
  assert.equal((await lstat(brokerAddress(root))).isSocket(), true);
  broker = createAdmissionBroker({ root, oldLockPath: join(root, 'old-admission.lock'), sampleResources: ({ slots }) => readAdmissionMemorySample({ slots,
    readMemory: () => ({ availableMemoryKiB: 100, totalMemoryKiB: 100 }), readProcesses: () => new Map() }) });
  await broker.start();
  const owner = await acquire(root, 10, t);
  const held = await owner.admit();
  await held.release();
});

test('a control stream EPIPE drops only that client and preserves broker admission', linux, async t => {
  const root = await mkdtemp('/tmp/happier-broker-stream-');
  const program = `
    import assert from 'node:assert/strict';
    import { once } from 'node:events';
    import { createConnection, createServer, Socket } from 'node:net';
    import { createInterface } from 'node:readline';
    import { join } from 'node:path';
    import { brokerAddress, createAdmissionBroker } from ${JSON.stringify(new URL('./admission_broker.mjs', import.meta.url).href)};
    const root = process.argv[1];
    const broker = createAdmissionBroker({ root, oldLockPath: join(root, 'old-admission.lock'),
      readCpuCapacity: () => 2,
      sampleResources: async () => ({ availableMemoryKiB: 100, totalMemoryKiB: 100 }) });
    const controls = new Set();
    const servers = new Map();
    const write = Socket.prototype.write;
    async function connect(floorKiB) {
      const socket = createConnection(brokerAddress(root));
      controls.add(socket);
      socket.on('error', () => {});
      await once(socket, 'connect');
      socket.write(JSON.stringify({ kind: 'acquire', className: 'validation', cpuCost: 1, floorKiB,
        pid: process.pid, repoDir: root, locks: [] }) + '\\n');
      return socket;
    }
    async function admit(floorKiB) {
      const socket = await connect(floorKiB);
      const lines = createInterface({ input: socket });
      const iterator = lines[Symbol.asyncIterator]();
      const reserved = JSON.parse((await iterator.next()).value);
      assert.equal(reserved.kind, 'reserved');
      const peers = new Set();
      const server = createServer(peer => { peers.add(peer); peer.on('error', () => {}); });
      servers.set(server, peers);
      server.listen(reserved.slotAddress);
      await once(server, 'listening');
      socket.write(JSON.stringify({ kind: 'ready' }) + '\\n');
      assert.equal(JSON.parse((await iterator.next()).value).kind, 'admitted');
      return socket;
    }
    try {
      await broker.start();
      const existing = await admit(20);
      let injected = false;
      // Inject only the genuine network stream boundary, in this isolated
      // process: the scheduler and control/slot lifetimes remain real.
      Socket.prototype.write = function (chunk, ...args) {
        if (this.server && String(chunk).includes('"kind":"reserved"')) {
          Socket.prototype.write = write;
          injected = true;
          this.destroy(Object.assign(new Error('peer disconnected during response'), { code: 'EPIPE' }));
          return false;
        }
        return write.call(this, chunk, ...args);
      };
      const disconnected = await connect(80);
      await new Promise(resolve => disconnected.once('close', resolve));
      assert.equal(injected, true);
      await admit(80);
      assert.equal(existing.destroyed, false);
      assert.equal(broker.status().activeCount, 2);
      assert.equal(broker.status().reservedMemoryKiB, 100);
    } finally {
      Socket.prototype.write = write;
      for (const socket of controls) socket.destroy();
      for (const [server, peers] of servers) {
        for (const peer of peers) peer.destroy();
        await new Promise(resolve => server.close(resolve));
      }
      await broker.close();
    }
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', program, root],
    { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close');
      child.kill('SIGKILL');
      await closed;
    }
    await rm(root, { recursive: true, force: true });
  });
  const [code, signal] = await once(child, 'close');
  assert.equal(signal, null, stderr);
  assert.equal(code, 0, stderr);
});


test('measured package floors fit at capacity and queued work resumes after release', linux, async t => {
  const floorKiB = HEAVYWEIGHT_COMMAND_RESOURCES['package-dist'].memoryKiB;
  const capacityKiB = 2 * floorKiB;
  const { root, broker } = await fixture(t, {
    readMemory: () => ({ availableMemoryKiB: capacityKiB, totalMemoryKiB: capacityKiB }),
  });
  // Isolate memory from CPU admission: package publishers normally reserve host CPU.
  const options = { className: 'package-dist', cpuCost: 1 };
  const first = await acquire(root, floorKiB, t, options);
  const held = await first.admit();
  const second = await acquire(root, floorKiB, t, options);
  await second.admit();
  const third = await acquire(root, floorKiB, t, options);
  await request(root, { kind: 'sample' }).then(async client => {
    await client.next(); client.socket.destroy();
  });
  assert.equal(broker.status().reservedMemoryKiB, capacityKiB);
  assert.equal(broker.status().waitingCount, 1);
  await held.release();
  const resumed = await third.admit();
  assert.equal(resumed.admitted.floorKiB, floorKiB);
});

test('dynamic measured floor options select the most workers at the largest fitting floor', linux, async t => {
  const { root, broker } = await fixture(t);
  const client = await acquire(root, 120, t, { floorOptions: [{ floorKiB: 120, workers: 4 },
    { floorKiB: 90, workers: 2 }, { floorKiB: 90, workers: 3 }, { floorKiB: 60, workers: 1 }] });
  const held = await client.admit();
  assert.equal(held.admitted.floorKiB, 90);
  assert.equal(held.admitted.workers, 3);
  assert.equal(broker.status().reservedMemoryKiB, 90);
  await held.release();
});

test('impossible physical capacity settles with a typed refusal instead of an unwakeable wait', linux, async t => {
  const gibKiB = 1024 * 1024;
  let availableMemoryKiB = 25 * gibKiB;
  const { root, broker } = await fixture(t, {
    readMemory: () => ({ availableMemoryKiB, totalMemoryKiB: 25 * gibKiB }),
  });
  const holder = await acquire(root, 20 * gibKiB, t);
  const held = await holder.admit();
  availableMemoryKiB = 16 * gibKiB;
  const client = await request(root, { kind: 'acquire', className: 'compilation', floorKiB: 38 * gibKiB,
    pid: process.pid, repoDir: root, locks: [] });
  t.after(() => client.socket.destroy());
  const result = await client.next();
  assert.equal(result.kind, 'refused');
  assert.equal(result.reason, 'HSTACK_MEMORY_CAPACITY');
  assert.equal(broker.status().waitingCount, 0);
  assert.equal(broker.status().reservedMemoryKiB, 20 * gibKiB);
  const follower = await acquire(root, 3 * gibKiB, t);
  await held.release();
  const admitted = await follower.admit();
  assert.equal(admitted.admitted.floorKiB, 3 * gibKiB);
});

for (const adaptive of [false, true]) test(`an unachievable ${adaptive ? 'adaptive' : 'fixed'} head yields spare memory and pledges subsequent releases after recovery`, linux, async t => {
  const clock = captureRecoveryClock(t);
  let availableMemoryKiB = 60;
  const { root, broker } = await fixture(t, {
    readMemory: () => ({ availableMemoryKiB, totalMemoryKiB: 100 }),
  });
  const holder = await acquire(root, 20, t);
  const held = await holder.admit();
  const head = await acquire(root, adaptive ? 120 : 80, t, adaptive ? {
    arrivedAt: Date.now() - headReservationDelayMs,
    floorOptions: [{ floorKiB: 120, workers: 2 }, { floorKiB: 80, workers: 1 }],
  } : { arrivedAt: Date.now() - headReservationDelayMs });
  const check = await request(root, { kind: 'check', floorKiB: 10, cpuCost: 1 });
  const spare = await check.next();
  check.socket.destroy();
  assert.equal(spare.achievableMemoryKiB, 60);
  assert.equal(spare.unreservedMemoryKiB, 40, 'non-admitted pressure cannot be drained by holding the head reservation');
  assert.equal(spare.kind, 'admitted', 'read-only checks expose the same spare memory as drain');
  const backfills = [];
  for (let index = 0; index < 4; index += 1) {
    const follower = await acquire(root, 10, t);
    backfills.push(await follower.admit());
  }
  assert.equal(broker.status().activeCount, 5, 'all four small waiters backfill the unachievable head');
  assert.equal(broker.status().waitingCount, 1, 'the unachievable head stays queued with its original arrival');

  // Owner backfill ruling (2026-11-12): recovery makes this request head;
  // capacity already free at that moment remains available to backfill.
  availableMemoryKiB = 80;
  const samples = broker.status().sampleCount;
  await clock.tick();
  assert.equal(broker.status().sampleCount, samples + 1, 'one existing recovery observation serves the queue');
  assert.equal(broker.status().unreservedMemoryKiB, 20);
  const younger = await acquire(root, 5, t);
  const alsoHeld = await younger.admit();
  const barrier = await request(root, { kind: 'sample' });
  await barrier.next();
  barrier.socket.destroy();
  assert.equal(broker.status().waitingCount, 1, 'only the recovered head waits');
  await held.release();
  for (const backfill of backfills) await backfill.release();
  await alsoHeld.release();
  const resumed = await head.admit();
  assert.equal(resumed.admitted.floorKiB, 80);
  assert.equal(broker.status().waitingCount, 0);
  await resumed.release();
});

test('temporary memory pressure without broker slots is busy, not impossible physical capacity', linux, async t => {
  const { root, broker } = await fixture(t, {
    readMemory: () => ({ availableMemoryKiB: 20, totalMemoryKiB: 100 }),
  });
  const client = await acquire(root, 50, t, { noWait: true });
  const result = await client.next();
  assert.equal(result.kind, 'refused');
  assert.equal(result.reason, 'HSTACK_MEMORY_BUSY');
  const check = await request(root, { kind: 'check', floorKiB: 50 });
  assert.equal((await check.next()).reason, 'HSTACK_MEMORY_BUSY');
  check.socket.destroy();
  assert.equal(broker.status().sampleCount, 2);
  const fitting = await acquire(root, 10, t);
  const held = await fitting.admit();
  await held.release();
});

test('arrival samples memory once after canonical disk reclamation settles', linux, async t => {
  // The recovered fixture filesystem must satisfy validation scratch demand
  // before this case can exercise the following memory admission decision.
  const capacityBytes = 2 * 1024 * 1024 * 1024;
  let availableMemoryKiB = 100;
  let inspections = 0;
  const { root, broker } = await fixture(t, {
    readMemory: () => ({ availableMemoryKiB, totalMemoryKiB: 100 }),
    // Keep disk policy and reclamation real. Only df's filesystem observation
    // and /proc's physical memory observation are substituted OS boundaries.
    admitDisk: request => admitWorkerDiskBudget({ ...request, commandClass: request.className,
      scratchRoot: request.repoDir, observeFilesystem: () => {
        inspections += 1;
        if (inspections > 1) availableMemoryKiB = 20;
        return { device: 'private-fixture', totalBytes: capacityBytes, availableBytes: inspections === 1 ? 0 : capacityBytes };
      } }),
  });
  const client = await request(root, { kind: 'acquire', className: 'validation', floorKiB: 50,
    pid: process.pid, repoDir: root, cacheBaseDir: join(root, 'cache', 'store'), locks: [], noWait: true });
  t.after(() => client.socket.destroy());
  const result = await client.next();
  assert.ok(inspections >= 2, 'the canonical low-disk branch must reclaim then reobserve');
  assert.equal(result.kind, 'refused');
  assert.equal(result.reason, 'HSTACK_MEMORY_BUSY');
  assert.equal(broker.status().sampleCount, 2, 'one startup sample and one settled-arrival sample');
});

test('a new workspace resource can be offered before its canonical client creates the parent directory', linux, async t => {
  const { root } = await fixture(t);
  const client = await acquire(root, 10, t, { locks: [{ path: join(root, 'new-publication', 'build.lock') }] });
  const reserved = await client.next();
  assert.equal(reserved.kind, 'reserved');
  client.socket.destroy();
});

test('canonical publication priority release wakes a blocked request even when the lock file is absent', linux, async t => {
  const clock = captureRecoveryClock(t);
  const activeCatchUps = clock.active;
  const { root, broker } = await fixture(t);
  assert.equal(activeCatchUps.size, 0, 'an idle broker schedules no resource catch-up');
  const locks = [{ path: join(root, 'publication.lock') }];
  const priority = createWorkspaceBundleLockPriorityScope({ resources: locks });
  priority.activate();
  t.after(() => priority.dispose());
  const client = await acquire(root, 10, t, { locks });
  assert.equal((await client.next()).kind, 'reserved');
  const busy = await tryWorkspaceBuildResources({ locks });
  assert.equal(busy.acquired, false);
  client.socket.write(JSON.stringify({ kind: 'resources-busy' }) + '\n');
  const barrier = await request(root, { kind: 'sample' });
  await barrier.next();
  barrier.socket.destroy();
  const samples = broker.status().sampleCount;
  assert.equal(activeCatchUps.size, 1, 'resource contention uses one broker-owned catch-up');
  const [catchUp] = activeCatchUps.values();
  await catchUp();
  assert.equal(broker.status().sampleCount, samples, 'unchanged catch-up performs zero capacity samples');
  priority.dispose();
  let resources;
  const held = await client.admit(async () => {
    resources = await tryWorkspaceBuildResources({ locks });
    assert.equal(resources.acquired, true);
    t.after(() => resources.release());
  });
  try {
    assert.equal(activeCatchUps.size, 0, 'admission withdraws catch-up when no blocked consumer remains');
    assert.equal(broker.status().sampleCount, samples + 1);
  } finally {
    await held.release();
    await resources.release();
  }
});

test('an unrelated arrival never reoffers unchanged blocked publication demand', linux, async t => {
  const { root, broker } = await fixture(t);
  const locks = [{ path: join(root, 'publication.lock') }];
  const priority = createWorkspaceBundleLockPriorityScope({ resources: locks });
  priority.activate();
  t.after(() => priority.dispose());
  const blocked = await acquire(root, 70, t, { locks });
  assert.equal((await blocked.next()).kind, 'reserved');
  assert.equal((await tryWorkspaceBuildResources({ locks })).acquired, false);
  blocked.socket.write(JSON.stringify({ kind: 'resources-busy' }) + '\n');
  while (broker.status().activeCount !== 0) await new Promise(setImmediate);
  const unrelated = await acquire(root, 40, t);
  await unrelated.admit();
  const follower = await acquire(root, 20, t);
  await follower.admit();
  assert.equal(broker.status().activeCount, 2,
    'a publication-blocked head must reserve no memory even when its floor exceeds remaining memory');
  assert.equal(broker.status().waitingCount, 1, 'publication demand stays blocked until its own resource changes');
});

test('publication demand cannot reserve a head floor before its first resource offer', linux, async t => {
  const { root, broker } = await fixture(t);
  const holder = await acquire(root, 60, t);
  await holder.admit();
  const locks = [{ path: join(root, 'publication.lock') }];
  const publication = await tryWorkspaceBuildResources({ locks });
  assert.equal(publication.acquired, true);
  try {
    const observedAcquire = async (floorKiB, extra) => {
      const samples = broker.status().sampleCount;
      const client = await acquire(root, floorKiB, t, extra);
      // Capacity observation completes before drain in the same broker turn.
      // Wait for that published progress rather than another socket's query.
      while (broker.status().sampleCount === samples) await new Promise(setImmediate);
      return client;
    };
    await observedAcquire(70, { locks });
    assert.equal(broker.status().unreservedMemoryKiB, 40,
      'a publication-blocked head must not reduce the placement budget');
    const follower = await observedAcquire(20);
    assert.equal(broker.status().activeCount, 2,
      'a head whose publication resource is unavailable must leave memory for admissible work');
    await follower.admit();
  } finally {
    await publication.release();
  }
});

test('connections during startup wait for the recovered initial capacity observation', linux, async t => {
  const root = await mkdtemp('/tmp/happier-broker-start-');
  let releaseMemory;
  let readingMemory;
  const reading = new Promise(resolve => { readingMemory = resolve; });
  const memory = new Promise(resolve => { releaseMemory = resolve; });
  const broker = createAdmissionBroker({ root, oldLockPath: join(root, 'old-admission.lock'), sampleResources: ({ slots }) => readAdmissionMemorySample({ slots,
    readProcesses: () => new Map(), readMemory: () => { readingMemory(); return memory; } }) });
  t.after(async () => { await broker.close(); await rm(root, { recursive: true, force: true }); });
  const starting = broker.start();
  await reading;
  const held = spawnSync('flock', ['--nonblock', '--exclusive', join(root, 'broker-start.lock'), '/bin/true'], { stdio: 'ignore' });
  assert.equal(held.status, 1, 'the original broker FD must retain the startup lock after the flock child exits');
  const client = await request(root, { kind: 'sample' });
  const response = client.next();
  await new Promise(setImmediate);
  releaseMemory({ availableMemoryKiB: 100, totalMemoryKiB: 100 });
  await starting;
  const released = spawnSync('flock', ['--nonblock', '--exclusive', join(root, 'broker-start.lock'), '/bin/true'], { stdio: 'ignore' });
  assert.equal(released.status, 0, 'the kernel lock ends at startup, before admission decisions');
  assert.equal((await response).availableMemoryKiB, 100);
  client.socket.destroy();
});

test('resident descendants offset floors once, including overlapping ancestor slots', async () => {
  const sample = await readAdmissionMemorySample({ slots: [{ pid: 10, floorKiB: 80 }, { pid: 11, floorKiB: 30 }],
    readMemory: () => ({ availableMemoryKiB: 40, totalMemoryKiB: 200 }),
    readProcesses: () => new Map([[10, { pid: 10, parentPid: 1, pssKiB: 20 }],
      [11, { pid: 11, parentPid: 10, pssKiB: 30 }], [12, { pid: 12, parentPid: 11, pssKiB: 10 }]]) });
  assert.equal(sample.reservedMemoryKiB, 110);
  assert.equal(sample.unreservedMemoryKiB, 0);
  assert.equal(sample.achievableMemoryKiB, 100);
  const exceeded = await readAdmissionMemorySample({ slots: [{ pid: 10, floorKiB: 80 }],
    readMemory: () => ({ availableMemoryKiB: 0, totalMemoryKiB: 100 }),
    readProcesses: () => new Map([[10, { pid: 10, parentPid: 1, pssKiB: 100 }]]) });
  assert.equal(exceeded.unreservedMemoryKiB, 0);
  const sharedRss = await readAdmissionMemorySample({ slots: [{ pid: 10, floorKiB: 80 }],
    readMemory: () => ({ availableMemoryKiB: 20, totalMemoryKiB: 100 }),
    readProcesses: () => new Map([[10, { pid: 10, parentPid: 1, pssKiB: null, rssKiB: 80 }]]) });
  assert.equal(sharedRss.unreservedMemoryKiB, 0);
  assert.equal(sharedRss.creditedResidentMemoryKiB, 0);
  assert.deepEqual([...sharedRss.slotRssKiB], [[10, 80]], 'calibration records tree RSS independently of admission PSS credit');
});


test('external memory recovery admits existing waiters once per recovery tick without new admission events', linux, async t => {
  const clock = captureRecoveryClock(t);
  let availableMemoryKiB = 10;
  const { root, broker } = await fixture(t, {
    readMemory: () => ({ availableMemoryKiB, totalMemoryKiB: 100 }),
  });
  const clients = await Promise.all([50, 30, 20].map(floor => acquire(root, floor, t)));
  const barrier = await request(root, { kind: 'sample' });
  await barrier.next();
  barrier.socket.destroy();
  assert.equal(broker.status().waitingCount, clients.length);
  const scheduledCatchUps = clock.active.size;
  const samples = broker.status().sampleCount;
  await clock.tick();
  const pressureTickSamples = broker.status().sampleCount - samples;
  assert.equal(broker.status().activeCount, 0);

  // Only the OS-memory fact changes. Status/check reads must neither refresh
  // it nor trigger admission; no new acquire/release/workspace event follows.
  availableMemoryKiB = 100;
  const beforeRead = broker.status().sampleCount;
  for (const message of [{ kind: 'sample' }, { kind: 'check', floorKiB: 50 }]) {
    const status = await request(root, message);
    await status.next();
    status.socket.destroy();
  }
  assert.equal(broker.status().sampleCount, beforeRead, 'status/check reads remain read-only');
  assert.equal(broker.status().activeCount, 0, 'readers cannot perform recovery admission');
  await clock.tick();
  assert.equal(broker.status().activeCount, clients.length,
    'RAM recovery must offer existing unlocked waiters without a new acquire or release');
  assert.equal(broker.status().waitingCount, 0);
  assert.equal(scheduledCatchUps, 1, 'all capacity waiters share the existing broker recovery clock');
  assert.equal(pressureTickSamples, 1, 'continued pressure samples once per tick, not per waiter');
  assert.equal(broker.status().sampleCount, beforeRead + 1, 'one recovery observation serves every fitting waiter');
  const held = await Promise.all(clients.map(client => client.admit()));
  const admittedSamples = broker.status().sampleCount;
  assert.equal(clock.active.size, 0, 'admitted work without waiters has no recovery clock');
  await clock.tick();
  assert.equal(broker.status().sampleCount, admittedSamples, 'admitted work is not re-admitted per step');
  await Promise.all(held.map(value => value.release()));
});

test('memory recovery does not reoffer unchanged workspace demand or duplicate capacity observations', linux, async t => {
  const clock = captureRecoveryClock(t);
  let availableMemoryKiB = 100;
  const { root, broker } = await fixture(t, {
    readMemory: () => ({ availableMemoryKiB, totalMemoryKiB: 100 }),
  });
  const locks = [{ path: join(root, 'publication.lock') }];
  const priority = createWorkspaceBundleLockPriorityScope({ resources: locks });
  priority.activate();
  t.after(() => priority.dispose());
  const blocked = await acquire(root, 10, t, { locks });
  assert.equal((await blocked.next()).kind, 'reserved');
  assert.equal((await tryWorkspaceBuildResources({ locks })).acquired, false);
  blocked.socket.write(JSON.stringify({ kind: 'resources-busy' }) + '\n');
  const barrier = await request(root, { kind: 'sample' });
  await barrier.next();
  barrier.socket.destroy();
  availableMemoryKiB = 20;
  const memoryWaiter = await acquire(root, 50, t);
  const queued = await request(root, { kind: 'sample' });
  await queued.next();
  queued.socket.destroy();
  const samples = broker.status().sampleCount;
  availableMemoryKiB = 100;
  await clock.tick();
  assert.equal(broker.status().activeCount, 1, 'only the memory waiter receives an offer');
  assert.equal(broker.status().waitingCount, 1, 'unchanged publication demand remains blocked');
  assert.equal(broker.status().sampleCount, samples + 1, 'mixed resource and memory waits share one observation');
  const held = await memoryWaiter.admit();
  assert.equal(clock.active.size, 1, 'the same clock remains for publication liveness');
  const settledSamples = broker.status().sampleCount;
  await clock.tick();
  assert.equal(broker.status().sampleCount, settledSamples, 'unchanged workspace-only catch-up does not resample memory');
  await held.release();
});


test('slow recovery observations coalesce clock ticks, let status settle, and rearm for current waiters only', linux, async t => {
  const clock = captureRecoveryClock(t);
  const memory = { availableMemoryKiB: 10, totalMemoryKiB: 100 };
  let hold = false;
  let reads = 0;
  let started;
  let resolveStarted;
  const held = [];
  const { root, broker } = await fixture(t, { readMemory: () => {
    reads += 1;
    if (!hold) return memory;
    return new Promise(resolve => { held.push(resolve); resolveStarted(); });
  } });
  const client = await acquire(root, 50, t);
  const barrier = await request(root, { kind: 'sample' });
  await barrier.next();
  barrier.socket.destroy();
  const before = broker.status().sampleCount;
  const beforeReads = reads;
  hold = true;
  started = new Promise(resolve => { resolveStarted = resolve; });
  assert.equal(clock.active.size, 1, 'memory demand has a scheduled recovery');
  const firstTick = clock.tick();
  await Promise.race([started, firstTick]);
  assert.equal(reads, beforeReads + 1, 'the recovery tick reaches its OS observation');
  const extraTicks = [clock.tick(), clock.tick(), clock.tick()];
  const status = await request(root, { kind: 'sample' });
  try {
    held[0](memory);
    await firstTick;
    assert.equal(reads, beforeReads + 1, 'elapsed recovery ticks must not queue more OS observations');
    await Promise.all(extraTicks);
    const response = await status.next();
    assert.equal(response.sampleCount, before + 1, 'status settles after the one in-flight sample');
    assert.equal(clock.active.size, 1, 'a remaining memory waiter rearms one catch-up after completion');

    // Withdraw the waiter during the next held recovery, then introduce a new
    // waiter before that recovery completes. The expired handle cannot create
    // another timer while queued/running or cancel the replacement demand.
    started = new Promise(resolve => { resolveStarted = resolve; });
    const nextReads = reads;
    const nextTick = clock.tick();
    extraTicks.push(nextTick);
    await Promise.race([started, nextTick]);
    assert.equal(reads, nextReads + 1, 'the rearmed tick reaches its OS observation');
    client.socket.destroy();
    const replacement = await acquire(root, 50, t);
    hold = false;
    for (const resolve of held) resolve(memory);
    await nextTick;
    const settled = await request(root, { kind: 'sample' });
    await settled.next();
    settled.socket.destroy();
    assert.equal(broker.status().waitingCount, 1);
    assert.equal(clock.active.size, 1, 'withdrawal and replacement leave only the current catch-up');
    memory.availableMemoryKiB = 100;
    await clock.tick();
    const admitted = await replacement.admit();
    assert.equal(clock.active.size, 0, 'admission cancels catch-up when demand is gone');
    await admitted.release();
  } finally {
    hold = false;
    for (const resolve of held) resolve(memory);
    await Promise.allSettled([firstTick, ...extraTicks]);
    status.socket.destroy();
  }
});
