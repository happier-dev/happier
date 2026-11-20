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
import { connectAdmissionBroker, requestAdmissionSample, runAdmittedTask, runAdmissionClient, runAdmissionCommand, watchAdmissionSamples } from './admission_client.mjs';
import * as admissionMemory from './admission_memory.mjs';
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
  assert.equal(posts.length, 0, 'a broker flag with no blocked waiters stays off the board');
  const ledger = JSON.parse(await readFile(join(root, '.project/tmp/load-sentinel/OVERRUNS.json'), 'utf8'));
  assert.deepEqual(ledger.active.map(row => row.slotId).sort(), first.overruns.map(slot => slot.slotId).sort(),
    'each flagged slot is recorded in the sentinel ledger');
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

test('real clients waiting across a broker succession re-register with their arrival and are admitted by the successor', linux, async t => {
  // windows2-linux 2026-11-16: are queued clients stranded after a succession?
  let availableMemoryKiB = 0;
  const readMemory = () => ({ availableMemoryKiB, totalMemoryKiB: 100 });
  const { root, broker, sampleResources } = await fixture(t, { readMemory });
  const order = [];
  const finished = Promise.withResolvers();
  t.after(() => finished.resolve());
  const waiter = name => runAdmittedTask({ root, className: 'validation', floorKiB: 60, repoDir: root, env: {} }, async () => {
    order.push(name);
    await finished.promise;
  });
  const older = waiter('older');
  while (broker.status().waitingCount !== 1) await new Promise(resolve => setImmediate(resolve));
  const younger = waiter('younger');
  while (broker.status().waitingCount !== 2) await new Promise(resolve => setImmediate(resolve));
  // Hold the startup lock across the swap, as a cutover does: a client that
  // reconnects in the gap and starts its own broker waits on this lock, then
  // finds the successor listening and exits.
  const lockFd = openSync(join(root, 'broker-start.lock'), 'a', 0o600);
  assert.equal(spawnSync('flock', ['--exclusive', '3'], { stdio: ['ignore', 'ignore', 'ignore', lockFd] }).status, 0);
  await broker.close();
  const successor = createAdmissionBroker({ root, oldLockPath: join(root, 'old-admission.lock'), sampleResources, startupLockFd: lockFd });
  t.after(() => successor.close());
  await successor.start();
  while (successor.status().waitingCount !== 2) await new Promise(resolve => setTimeout(resolve, 10));
  availableMemoryKiB = 70;
  const sample = await requestAdmissionSample(root);
  assert.equal(sample.activeCount + sample.waitingCount, 2, 'both waiters are in the successor\'s table');
  while (order.length === 0) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(order, ['older'], 'the older waiter keeps its place and is admitted first');
  finished.resolve();
  await older;
  await younger;
  assert.deepEqual(order, ['older', 'younger']);
});

test('an overdue head keeps its held memory across a broker succession (nl1/controller 2026-11-18)', linux, async t => {
  // The successor restarted the head's 18 GiB (nl1) and 8 GiB (controller) holds at 0 and
  // admitted work ahead of it. The waiting client re-registers with the hold it was told.
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const { root, broker, sampleResources } = await fixture(t);
  await (await acquire(root, 60, t)).admit();
  const pledger = await (await acquire(root, 30, t)).admit();
  const stop = new AbortController();
  const head = runAdmittedTask({ root, className: 'validation', floorKiB: 50, repoDir: root, cacheBaseDir: root, env: {},
    signal: stop.signal }, async () => 0);
  // The head is still queued when the test ends: withdraw it before the brokers and root go.
  t.after(async () => { stop.abort(); await head.catch(() => {}); });
  while (broker.status().waitingCount !== 1) await new Promise(resolve => setImmediate(resolve));
  now += headReservationDelayMs;
  await pledger.release();
  while ((await requestAdmissionSample(root)).head?.reservationKiB !== 30) await new Promise(resolve => setImmediate(resolve));
  // Let the held notice reach the waiting client before the broker goes away.
  await new Promise(resolve => setTimeout(resolve, 50));
  await broker.close();
  const successor = createAdmissionBroker({ root, oldLockPath: join(root, 'old-admission.lock'), sampleResources,
    readCpuCapacity: () => 128 });
  t.after(() => successor.close());
  await successor.start();
  while (successor.status().waitingCount !== 1) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((await requestAdmissionSample(root)).head.reservationKiB, 30, 'the successor keeps the head\'s hold');
  const small = await acquire(root, 20, t, { noWait: true });
  assert.equal((await small.next()).reason, 'HSTACK_MEMORY_BUSY', 'nothing is admitted ahead of the head with its hold');
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

test('an admitted parent’s nested process is refused before it can queue for a second slot', { ...linux, timeout: 10_000 }, async t => {
  const { root, broker, sampleResources } = await fixture(t);
  await (await acquire(root, 100, t)).admit();
  const sendAcquire = String.raw`
    import { createConnection } from 'node:net';
    import { once } from 'node:events';
    import { createInterface } from 'node:readline';
    const [socketPath, repoDir] = process.argv.slice(1);
    const socket = createConnection(socketPath);
    const lines = createInterface({ input: socket });
    const response = once(lines, 'line');
    await once(socket, 'connect');
    socket.write(JSON.stringify({ kind: 'acquire', className: 'compilation-ui', cpuCost: 'host',
      floorKiB: 100, pid: process.pid, repoDir, cacheBaseDir: repoDir }) + '\n');
    process.stdout.write((await response)[0]);
    socket.destroy();
  `;
  const nestedDecision = async () => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', sendAcquire, brokerAddress(root), root], {
      env: {}, stdio: ['ignore', 'pipe', 'inherit'],
    });
    t.after(() => child.kill());
    let output = '';
    child.stdout.setEncoding('utf8').on('data', text => { output += text; });
    const [status] = await once(child, 'close');
    assert.equal(status, 0);
    return JSON.parse(output);
  };
  const assertRefused = async currentBroker => {
    const decision = await nestedDecision();
    assert.equal(decision.kind, 'refused');
    assert.equal(decision.reason, 'HSTACK_ADMISSION_INHERITANCE_REQUIRED');
    assert.equal(currentBroker.status().activeCount, 1);
    assert.equal(currentBroker.status().waitingCount, 0);
  };
  await assertRefused(broker);
  await broker.close();
  const successor = createAdmissionBroker({ root, oldLockPath: join(root, 'old-admission.lock'), sampleResources });
  t.after(() => successor.close());
  await successor.start();
  await assertRefused(successor);

  const clientPath = fileURLToPath(new URL('./admission_client.mjs', import.meta.url));
  const child = spawn(process.execPath, [clientPath, '--run', `--root=${root}`, '--class=compilation-ui', '--floor-kib=100',
    '--machine=fixture', `--repo=${root}`, '--failure-id=nested', '--', process.execPath, '-e', 'process.exitCode = 2'],
  { env: {}, signal: t.signal, stdio: ['ignore', 'ignore', 'pipe'] });
  let diagnostic = '';
  child.stderr.setEncoding('utf8').on('data', value => { diagnostic += value; });
  assert.deepEqual(await once(child, 'close'), [1, null]);
  assert.match(diagnostic, /HSTACK_ADMISSION_INHERITANCE_REQUIRED/);
  assert.doesNotMatch(diagnostic, /HSTACK_ADMISSION_UNAVAILABLE|waiting for admission/);
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

test('tsrs compilation retains its memory floor and charges its observed CPU class', linux, async t => {
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
  assert.equal(broker.status().reservedCpuCores, 17);
  await held.release();
  await second.admit();
  assert.equal(broker.status().activeCount, 1);
  assert.equal(broker.status().waitingCount, 0);
  assert.equal(broker.status().reservedMemoryKiB, floorKiB);
});

test('compilation grants reach parallel and explicit single-threaded payloads', linux, async t => {
  const { root } = await fixture(t, { cpuCores: 48 });
  const resultPath = join(root, 'compiler-core-grant');
  for (const [compilerArgs, cores] of [
    [[], '6'], [['--singleThreaded'], '2'], [['--singleThreaded', 'false'], '6'],
  ]) {
    const status = await runAdmissionCommand({ root, className: 'compilation', floorKiB: 1,
      readJobPeakKiB: () => null, machine: 'fixture', repoDir: root, cacheBaseDir: root, env: {},
      authoredArgs: ['node', 'scripts/workspaces/runTypeScriptCli.mjs', ...compilerArgs],
      command: process.execPath, args: ['-e',
        'require("node:fs").writeFileSync(process.argv[1], process.env.GOMAXPROCS)', resultPath] });
    assert.equal(status, 0);
    assert.equal(await readFile(resultPath, 'utf8'), cores);
  }
});

test('nineteen cold multithreaded compiles cannot all reserve a 48-core host', { ...linux, timeout: 6000 }, async t => {
  const { root } = await fixture(t, { cpuCores: 48, readCpuPressure: () => 0,
    readSlotWorkingSetKiB: () => 1 });
  for (let index = 0; index < 19; index++) {
    await acquire(root, 4, t, { className: 'compilation', p99DurationMs: 60_000, durationClass: 'compilation' });
  }
  const offered = await requestAdmissionSample(root);
  assert.equal(offered.activeCount, 8, `the CPU budget must hold the burst to eight offers, got ${offered.activeCount} of 19`);
  assert.equal(offered.waitingCount, 11);
  assert.equal(offered.reservedMemoryKiB, 32, 'fresh offers reserve their full working-set floors');
  assert.equal(offered.reservedCpuCores, 48);
});

test('memory-fitting CPU-heavy waiters admit up to cores minus runnable pressure', { ...linux, timeout: 6000 }, async t => {
  const clock = captureRecoveryClock(t);
  let pressure = 3;
  const { root, broker } = await fixture(t, { cpuCores: 12, readCpuPressure: () => pressure });
  const waiters = [];
  for (let index = 0; index < 9; index++) {
    waiters.push(await acquire(root, 1, t, { className: 'package-dist', requestedCpuCores: 4 }));
  }
  const snapshot = await requestAdmissionSample(root);
  assert.equal(snapshot.activeCount, 2);
  assert.equal(snapshot.waitingCount, 7);
  assert.equal(snapshot.reservedCpuCores, 8);
  assert.equal(snapshot.cpuPressureCores, 3);
  assert.equal(snapshot.unreservedCpuCores, 1);
  for (const waiter of waiters.slice(0, 2)) {
    assert.equal((await waiter.admit()).admitted.cpuCores, 4);
  }
  const check = await request(root, { kind: 'check', floorKiB: 1, className: 'package-dist', requestedCpuCores: 4, cpuCost: 'host' });
  assert.equal((await check.next()).reason, 'HSTACK_CPU_BUSY');
  check.socket.destroy();
  pressure = 0;
  const afterPressureDrop = await request(root, { kind: 'check', floorKiB: 1, className: 'package-dist', requestedCpuCores: 4, cpuCost: 'host' });
  assert.equal((await afterPressureDrop.next()).kind, 'admitted');
  afterPressureDrop.socket.destroy();
  await clock.tick();
  await waiters[2].admit();
  assert.equal(broker.status().reservedCpuCores, 12);
});

test('an idle host starts only its memory-fitting head under outside CPU pressure', { ...linux, timeout: 6000 }, async t => {
  const clock = captureRecoveryClock(t);
  let availableMemoryKiB = 20;
  const { root } = await fixture(t, {
    cpuCores: 8,
    readCpuPressure: () => 12,
    readMemory: () => ({ availableMemoryKiB, totalMemoryKiB: 100 }),
  });
  const head = await acquire(root, 40, t, { className: 'package-dist', requestedCpuCores: 4 });
  const second = await acquire(root, 10, t, { className: 'package-dist', requestedCpuCores: 4 });
  const memoryBlocked = await requestAdmissionSample(root);
  assert.equal(memoryBlocked.activeCount, 0, 'the smaller second request must not get the idle exception');
  assert.equal(memoryBlocked.waitingCount, 2);

  availableMemoryKiB = 100;
  await clock.tick();
  const offered = await requestAdmissionSample(root);
  assert.equal(offered.activeCount, 1, 'outside pressure must not block the sole memory-fitting head');
  assert.equal(offered.waitingCount, 1, 'the first offer consumes the exception before the client sends ready');
  assert.equal(offered.reservedCpuCores, 4);
  assert.equal(offered.cpuPressureCores, 12);
  assert.equal(offered.unreservedCpuCores, 0);

  const held = await head.admit();
  assert.equal((await requestAdmissionSample(root)).waitingCount, 1);
  await held.release();
  const next = await second.admit();
  assert.equal(next.admitted.cpuCores, 4);
  assert.equal((await requestAdmissionSample(root)).waitingCount, 0);
});

test('an aged head can use the sole CPU-pressure exception on a busy host across succession', { ...linux, timeout: 6000 }, async t => {
  const clock = captureRecoveryClock(t);
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  let pressure = 0;
  let availableMemoryKiB = 100;
  const readCpuPressure = () => pressure;
  const { root, broker, sampleResources } = await fixture(t, {
    cpuCores: 8, readCpuPressure,
    readMemory: () => ({ availableMemoryKiB, totalMemoryKiB: 100 }),
  });
  const acquireDist = (floorKiB, requestedCpuCores, arrivedAt = now) =>
    acquire(root, floorKiB, t, { className: 'package-dist', cpuCost: requestedCpuCores, arrivedAt });
  await (await acquireDist(20, 2)).admit();
  const releasing = await (await acquireDist(10, 3)).admit();
  pressure = 12;
  const arrivedAt = now;
  const head = await acquire(root, 40, t, { className: 'source-bundle', cpuCost: 4, arrivedAt });
  await acquireDist(10, 1);
  now += headReservationDelayMs - 1;
  await clock.tick();
  assert.equal((await requestAdmissionSample(root)).activeCount, 2, 'fresh head remains subject to outside pressure');

  // Memory changed since the last sample: age alone cannot grant the head.
  availableMemoryKiB = 65;
  now += 1;
  await clock.tick();
  const memoryBlocked = await requestAdmissionSample(root);
  assert.equal(memoryBlocked.activeCount, 2, 'the aged head must still fit current memory');
  assert.equal(memoryBlocked.waitingCount, 2, 'the smaller second waiter cannot take its place');

  availableMemoryKiB = 100;
  pressure = 2;
  await clock.tick();
  const blockedByReservations = await requestAdmissionSample(root);
  assert.equal(blockedByReservations.activeCount, 2, 'a smaller job must not backfill while the aged head fits memory');
  assert.equal(blockedByReservations.waitingCount, 2);

  pressure = 12;
  await releasing.release();
  const offered = await requestAdmissionSample(root);
  assert.equal(offered.activeCount, 2, 'the aged head must start alongside the original slot under excess outside pressure');
  assert.equal(offered.reservedCpuCores, 6);
  assert.equal(offered.waitingCount, 1, 'the pending offer already consumes the exception');
  const held = await head.admit();

  await broker.close();
  const successor = createAdmissionBroker({ root, oldLockPath: join(root, 'old-admission.lock'),
    sampleResources, readCpuCapacity: () => 8, readCpuPressure });
  t.after(() => successor.close());
  await successor.start();
  const second = await acquireDist(10, 1, arrivedAt);
  const retained = await requestAdmissionSample(root);
  assert.equal(retained.activeCount, 2, 'a successor must not offer a second exception');
  assert.equal(retained.waitingCount, 1);
  await held.release();
  await second.admit();
  const next = await requestAdmissionSample(root);
  assert.equal(next.activeCount, 2, 'the aged waiter can borrow the exception after release');
  assert.equal(next.waitingCount, 0);
});

test('admitted scope runnable threads leave remaining cores available', linux, async t => {
  const uid = process.getuid();
  const scope = `/user.slice/user-${uid}.slice/user@${uid}.service/happier.slice/happier-jobs.slice/happier-jobs-${process.pid}-fixture.scope`;
  let hostPressure = 0;
  const threads = [101, 103, 107, 109, 113, 117];
  const proc = new Map([
    [`/proc/${process.pid}/cgroup`, `0::${scope}\n`],
    ['/proc/self/cgroup', '0::/\n'],
    [`/sys/fs/cgroup${scope}/cgroup.threads`, [...threads, 123].join('\n') + '\n'],
    ...threads.map(tid => [`/proc/${tid}/stat`, `${tid} (cmd ) label) R 0 0`]),
    ['/proc/123/stat', '123 (sleeping) S 0 0'],
  ]);
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (path, ...args) => proc.get(path) ?? read(path, ...args));
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });

  const { root } = await fixture(t, { cpuCores: 12, readCpuPressure: () => hostPressure });
  await (await acquire(root, 1, t, { requestedCpuCores: 4 })).admit();
  await (await acquire(root, 1, t, { requestedCpuCores: 2 })).admit();
  hostPressure = 6;
  const next = await acquire(root, 1, t, { requestedCpuCores: 6 });
  const snapshot = await requestAdmissionSample(root);
  assert.equal(snapshot.activeCount, 3, 'the holder’s own runnable threads must not block the remaining six cores');
  assert.equal(snapshot.cpuPressureCores, 0);
  const held = await next.admit();
  await held.release();

  hostPressure = 8;
  const check = await request(root, { kind: 'check', floorKiB: 1, requestedCpuCores: 6 });
  const outcome = await check.next();
  check.socket.destroy();
  assert.equal(outcome.cpuPressureCores, 2, 'shared scope members count only once and outside pressure remains charged');
  assert.equal(outcome.reason, 'HSTACK_CPU_BUSY');
});

test('cold preparers use their completed class CPU observations', linux, async t => {
  const { root } = await fixture(t);
  for (const className of ['package-dist', 'dependency-install', 'source-reload']) {
    const waiter = await acquire(root, 1, t, { className });
    const slot = await waiter.admit();
    assert.equal(slot.admitted.cpuCores, 3, className);
    await slot.release();
  }
});

test('small validation jobs stay concurrent on a large host', { ...linux, timeout: 6000 }, async t => {
  const { root } = await fixture(t, { cpuCores: 128, readCpuPressure: () => 8 });
  const waiters = [];
  for (let index = 0; index < 24; index++) {
    waiters.push(await acquire(root, 1, t, { className: 'validation' }));
  }
  const snapshot = await requestAdmissionSample(root);
  assert.equal(snapshot.activeCount, 24);
  assert.equal(snapshot.reservedCpuCores, 24 * 3);
  for (const waiter of waiters) assert.equal((await waiter.admit()).admitted.cpuCores, 3);
  const oneWorker = await acquire(root, 1, t, { className: 'validation', requestedCpuCores: 1 });
  assert.equal((await oneWorker.admit()).admitted.cpuCores, 1);
});

test('succession charges live zero and legacy CPU sockets before admitting reconnects', { ...linux, timeout: 6000 }, async t => {
  const { root, broker, sampleResources } = await fixture(t);
  await broker.close();
  for (const [index, cpu] of [0, undefined].entries()) {
    const holder = createServer(socket => socket.on('error', () => {}));
    holder.listen(slotAddress(root, process.pid, 1, `00000000-0000-4000-8000-00000000000${index}`, cpu));
    await once(holder, 'listening');
    t.after(() => holder.close());
  }
  const successor = createAdmissionBroker({ root, sampleResources, readCpuCapacity: () => 36, readCpuPressure: () => 2 });
  await successor.start();
  t.after(() => successor.close());
  const waiters = [];
  for (let index = 0; index < 8; index++) waiters.push(await acquire(root, 1, t, { className: 'validation' }));
  const snapshot = await requestAdmissionSample(root);
  assert.equal(snapshot.reservedCpuCores, 34);
  assert.equal(snapshot.activeCount, 2);
  assert.equal(snapshot.waitingCount, 8);
});

test('completed CPU usage sizes a queued identity and survives broker succession', { ...linux, timeout: 6000 }, async t => {
  const { root, broker, sampleResources } = await fixture(t);
  const identity = { className: 'validation', component: 'ui', entry: 'synthetic.mjs', projects: ['apps/ui'] };
  const first = await (await acquire(root, 60, t, identity)).admit();
  const queued = await acquire(root, 60, t, identity);
  await first.report({ kind: 'slot-completed', status: 0, cpuMilliCores: 4500 });
  await requestAdmissionSample(root);
  await first.release();
  const learned = await queued.admit();
  assert.equal(learned.admitted.cpuCores, 7);
  await learned.release();
  await broker.close();
  const successor = createAdmissionBroker({ root, sampleResources, readCpuCapacity: () => 128 });
  await successor.start();
  t.after(() => successor.close());
  const again = await (await acquire(root, 60, t, identity)).admit();
  assert.equal(again.admitted.cpuCores, 7);
});

test('the admission client reports payload-only CPU use from its dedicated cgroup', linux, async t => {
  const { root } = await fixture(t);
  const uid = process.getuid();
  const scope = `/user.slice/user-${uid}.slice/user@${uid}.service/happier.slice/happier-jobs.slice/happier-jobs-${process.pid}-fixture.scope`;
  let usageUsec = 100_000_000;
  let now = 10_000;
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (path, ...args) => {
    if (path === '/proc/self/cgroup') return `0::${scope}\n`;
    if (path === `/sys/fs/cgroup${scope}/cpu.stat`) return `usage_usec ${usageUsec}\nuser_usec 0\n`;
    return read(path, ...args);
  });
  syncBuiltinESMExports();
  t.mock.method(performance, 'now', () => now);
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const identity = { className: 'validation', component: 'ui', entry: 'cpu-fixture.mjs', projects: ['apps/ui'] };
  const started = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const running = runAdmittedTask({ root, ...identity, machine: 'fixture', env: {},
    floorKiB: 60, repoDir: root, readJobPeakKiB: () => null }, async () => {
    started.resolve();
    await finish.promise;
    usageUsec += 1_200_000;
    now += 1_000;
    return 0;
  });
  await started.promise;
  const queued = await acquire(root, 60, t, identity);
  await requestAdmissionSample(root);
  finish.resolve();
  assert.equal(await running, 0);
  assert.equal((await queued.admit()).admitted.cpuCores, 2, '1.2 payload cores with 50% headroom round up to two');
});

test('missing, corrupt, and memory-only identity histories keep admitting with cold CPU charges', { ...linux, timeout: 6000 }, async t => {
  const identity = { className: 'validation', component: 'ui', entry: 'legacy.mjs', projects: ['apps/ui'] };
  const memoryKey = JSON.stringify(['validation', 'ui', 'legacy.mjs', ['apps/ui']]);
  const gib = 1024 * 1024;
  for (const [history, expectedFloor] of [
    [undefined, gib],
    ['{', gib],
    [JSON.stringify({ 'malformed-key': [4000], [memoryKey]: [2 * gib] }), 2 * gib],
    [JSON.stringify({ [memoryKey]: [2 * gib] }), 2 * gib],
  ]) {
    const { root } = await fixture(t, { readMemory: () => ({ availableMemoryKiB: 8 * gib, totalMemoryKiB: 8 * gib }) });
    if (history !== undefined) await writeFile(join(root, 'identity-kernel-peaks.json'), history);
    const client = await acquire(root, gib, t, identity);
    assert.equal((await requestAdmissionSample(root)).activeCount, 1, `history ${history} must not stall the acquire`);
    const held = await client.admit();
    assert.equal(held.admitted.floorKiB, expectedFloor);
    assert.equal(held.admitted.cpuCores, 3);
  }
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

test('a broker a client starts for a non-host root keeps its legacy lock under that root and exits when the root is removed', linux, async t => {
  // 2026-11-17 20:47Z: a broker a test client started for its private root took the
  // host-wide legacy lock, and the controller's real successor waited behind it (8 min).
  // The client starts the broker exactly as in a test run (inheriting this runner's env).
  const root = await mkdtemp('/tmp/happier-broker-isolated-');
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const brokers = () => fs.readdirSync('/proc').filter(name => /^\d+$/.test(name)).filter(pid => {
    try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').includes(root); } catch { return false; }
  });
  t.after(() => { for (const pid of brokers()) process.kill(Number(pid), 'SIGKILL'); });
  const started = await Promise.race([connectAdmissionBroker(root).then(socket => { socket.destroy(); return 'ready'; }),
    new Promise(resolve => setTimeout(() => resolve('not ready within 10 s'), 10_000))]);
  assert.equal(started, 'ready', 'the broker starts without waiting on the host-wide legacy lock');
  assert.equal(brokers().length, 1);
  const probe = spawnSync('flock', ['--nonblock', join(root, 'old-admission.lock'), 'true']);
  assert.equal(probe.status, 1, 'the broker holds its legacy lock under its own root');
  await rm(root, { recursive: true, force: true });
  const deadline = Date.now() + 10_000;
  while (brokers().length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(brokers().length, 0, 'removing its root stops the broker');
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
    // Queue, capacity-wait and held notices are diagnostic; these broker assertions consume decisions.
    do { response = JSON.parse((await iterator.next()).value); } while (['queued', 'capacity-wait', 'held'].includes(response.kind));
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
    // A slot line from the client (as runAdmittedTask writes working-set and completion metadata).
    const report = line => Promise.all([...peers].map(peer => new Promise(done => peer.write(JSON.stringify(line) + '\n', done))));
    return { admitted, reserved, release, report, slotAddress: reserved.slotAddress };
  } };
}

async function fixture(t, { readMemory = () => ({ availableMemoryKiB: 100, totalMemoryKiB: 100 }), readProcesses = () => new Map(), admitDisk, cpuCores = 128, readCpuPressure, readSlotWorkingSetKiB = () => null } = {}) {
  // Unix socket metadata needs a short pathname, independent of the command's
  // potentially deep workspace/custody TMPDIR. This remains a private root.
  const root = await mkdtemp('/tmp/happier-broker-test-');
  const sampleResources = ({ slots }) => readAdmissionMemorySample({ slots,
    readMemory, readProcesses });
  const broker = createAdmissionBroker({ root, oldLockPath: join(root, 'old-admission.lock'), sampleResources,
    readCpuCapacity: () => cpuCores, readCpuPressure, readSlotWorkingSetKiB,
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
  reload: { className: 'source-reload', component: '.', entry: 'node inline-preparation' },
  claimed: { className: 'compilation', component: '.', entry: `node ${root}/scripts/run-tests.mjs`, headPriority: true },
  // P03 rolling HEAD typecheck: admitted from its warm worktree, outside the repository.
  // The shared web export every QA browser consumes (repo-dev producer, 2026-11-16).
  export: { className: 'source-web-export', component: '.', entry: `node ${root}/apps/stack/scripts/build/build_source_web_ui.mjs` },
  // Systemic 2026-11-16 21:15Z: a stack's Expo dev-startup web UI build runs the same producer
  // script as class validation; every borrowed-UI lane waits on it, so it ranks as a producer.
  devUi: { className: 'validation', component: '.', entry: `node ${root}/apps/stack/scripts/build/build_source_web_ui.mjs` },
  rolling: { className: 'compilation', component: '../../cache/commit-typecheck/wt',
    entry: `node ${root}/scripts/workspaces/commitPackageTypecheck.mjs` },
  // P03-GATE-TC: the commit gate's typecheck delta, admitted on a worker from its lane worktree.
  gate: { className: 'compilation', component: '../../cache/commit-typecheck-worker/slug/lane-gate/worktree',
    entry: `node ${root}/scripts/workspaces/commitGateTypecheck.mjs` },
  // Owner ruling 2026-11-16: a focused test run (class named by the command policy).
  focused: { className: 'validation', resourceClass: 'focused-validation-ui', component: 'apps/ui', entry: 'pnpm exec vitest' },
  // P03 ORCH 2026-11-17: a native-custody preparation is a step of the run it prepares
  // (a routed focused CLI test), so it is admitted at that run's rank, not as a class rank.
  preparation: { className: 'package-dist', resourceClass: 'native-custody', preparesClass: 'focused-validation-cli',
    component: 'packages/iroh-native', entry: 'cargo build' },
  ordinaryPreparation: { className: 'package-dist', resourceClass: 'native-custody', preparesClass: 'validation',
    component: 'packages/iroh-native', entry: 'cargo build' },
  claimedPreparation: { className: 'compilation', preparesClass: 'focused-validation-cli', component: '.', entry: 'node scripts/build.mjs' },
})[kind];
for (const [scenario, earlier, later, laterFirst] of [
  ['commit compiler before an earlier ordinary job', 'ordinary', 'commit', true],
  ['rolling HEAD typecheck before an earlier ordinary job', 'ordinary', 'rolling', true],
  ['commit gate typecheck before an earlier focused test run', 'focused', 'gate', true],
  ['commit gate typecheck before an earlier rolling HEAD typecheck', 'rolling', 'gate', true],
  ['shared web export before an earlier commit compiler', 'commit', 'export', true],
  ['dev-startup web UI build before an earlier commit compiler', 'commit', 'devUi', true],
  ['reload preparation before an earlier ordinary job', 'ordinary', 'reload', true],
  ['reload preparation before an earlier focused test run', 'focused', 'reload', true],
  ['reload preparation before an earlier commit compiler', 'commit', 'reload', true],
  ['runtime producer before an earlier ordinary job', 'ordinary', 'producer', true],
  ['runtime producer before an earlier commit compiler', 'commit', 'producer', true],
  ['an ordinary caller cannot claim priority', 'ordinary', 'claimed', false],
  ['focused test run before an earlier commit compiler', 'commit', 'focused', true],
  ['runtime producer before an earlier focused test run', 'focused', 'producer', true],
  ['native-custody preparation of a focused run before an earlier commit compiler', 'commit', 'preparation', true],
  ['native-custody preparation of an ordinary run stays ordinary', 'ordinary', 'ordinaryPreparation', false],
  ['only a preparation class takes the rank of the run it prepares', 'ordinary', 'claimedPreparation', false],
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
    const producerHead = ['producer', 'export', 'devUi', 'reload', 'gate'].includes(laterFirst ? later : earlier);
    assert.equal(pledged.head.reservationKiB, !pledging ? 0 : producerHead ? 60 : 30,
      'a producer head holds its whole floor; other priority heads hold released memory');
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

test('head priority: the rolling HEAD typecheck and focused test runs share a rank and are served in arrival order', linux, async t => {
  // P03 ORCH 2026-11-17: at rank 1 the rolling typecheck slid behind every later
  // focused run (rank 1.5) while 49 waited; at an equal rank arrival decides, so it cannot starve.
  const { root } = await fixture(t);
  const holder = await (await acquire(root, 100, t)).admit();
  const rolling = await acquire(root, 60, t, priorityIdentity(root, 'rolling'));
  const focused = await acquire(root, 60, t, priorityIdentity(root, 'focused'));
  const sample = await requestAdmissionSample(root);
  assert.equal(sample.head.className, 'compilation', 'the earlier rolling typecheck heads the queue');
  await holder.release();
  const started = await rolling.admit();
  await started.release();
  await focused.admit();
});

test('a waiter past the reservation bound heads the queue ahead of later priority waiters', linux, async t => {
  // nl1 2026-11-17: ranked arrivals (focused runs, producers) kept heading the queue,
  // so rank-0 package-dist and native-custody waiters sat 2.5 h behind them and never
  // reserved. Owner 2026-11-13: once a waiter has waited past the bound it gets a
  // guaranteed start; within the bound ranks still order the queue.
  const { root } = await fixture(t);
  const holder = await (await acquire(root, 100, t)).admit();
  const overdue = await acquire(root, 60, t, { ...priorityIdentity(root, 'ordinary'), arrivedAt: Date.now() - headReservationDelayMs });
  const focused = await acquire(root, 60, t, priorityIdentity(root, 'focused'));
  // A relocatable producer (source bundles are host-bound and may use any pledge first).
  const producer = await acquire(root, 60, t, priorityIdentity(root, 'export'));
  const sample = await requestAdmissionSample(root);
  assert.equal(sample.head.headPriority, 0, 'the overdue ordinary waiter is the head');
  assert.equal(sample.head.reservationActive, true);
  await holder.release();
  const started = await overdue.admit();
  assert.equal((await requestAdmissionSample(root)).waitingCount, 2, 'later ranked waiters wait behind it');
  await started.release();
  const next = await producer.admit();
  await next.release();
  await focused.admit();
});

test('QA reload preparation runs ahead of overdue waiters (reload #173)', linux, async t => {
  // P03 ORCH RULING 2026-11-17 (owner 15:31Z: reload preparation runs ahead of tests):
  // source-reload first, then overdue waiters in arrival order, then rank. #173 slid
  // from 50 to 71 of 109 behind overdue waiters while its QA stack was down.
  const { root } = await fixture(t);
  const holder = await (await acquire(root, 100, t)).admit();
  const overdue = await acquire(root, 60, t, { ...priorityIdentity(root, 'ordinary'), arrivedAt: Date.now() - headReservationDelayMs });
  const reload = await acquire(root, 60, t, { className: 'validation', resourceClass: 'source-reload', component: '.', entry: 'node inline-preparation' });
  const sample = await requestAdmissionSample(root);
  assert.equal(sample.head.headPriority, 2, 'the reload preparation heads the queue');
  assert.equal(sample.head.ageMs < headReservationDelayMs, true);
  await holder.release();
  const started = await reload.admit();
  await started.release();
  await overdue.admit();
});

test('the shared current-source server starts next after a busy producer lock is released', linux, async t => {
  const { root, broker } = await fixture(t);
  const locks = [{ path: join(root, 'build-producer.lock'), kind: 'workspace' }];
  const publishing = await tryWorkspaceBuildResources({ locks, env: {} });
  assert.equal(publishing.acquired, true);
  const order = [];
  const waiters = [];
  const stop = new AbortController();
  const producer = (name, floorKiB, env) => {
    const job = runAdmittedTask({ root, repoDir: root, cacheBaseDir: root, ...priorityIdentity(root, 'producer'),
      floorKiB, env, locks, signal: stop.signal, readJobPeakKiB: () => null }, async () => {
      order.push({ name, floorKiB: broker.status().reservedMemoryKiB });
    });
    waiters.push(job);
    return job;
  };
  const blocked = async count => {
    while (broker.status().waitingCount !== count || broker.status().activeCount) {
      await new Promise(resolve => setImmediate(resolve));
    }
  };
  try {
    producer('identity', 75, {});
    await blocked(1);
    producer('shared server', 60, { HAPPIER_ADMISSION_PREPARES_CLASS: 'source-reload' });
    await blocked(2);
    assert.deepEqual(order, [], 'neither build preempts the current publication');
    await publishing.release();
    await Promise.all(waiters);
    assert.deepEqual(order, [{ name: 'shared server', floorKiB: 60 }, { name: 'identity', floorKiB: 75 }]);
  } finally {
    stop.abort();
    await Promise.allSettled(waiters);
    await publishing.release();
  }
});

test('a shared preparation step takes the highest rank among the runs waiting on it', linux, async t => {
  // P03 ORCH 2026-11-17: a package-dist build is a prerequisite of every run waiting
  // on its output, so a later focused run's request for the same build raises it.
  const { root } = await fixture(t);
  const holder = await (await acquire(root, 100, t)).admit();
  const locks = [{ path: join(root, 'protocol.lock') }];
  const step = preparesClass => ({ className: 'package-dist', resourceClass: 'package-dist', preparesClass, locks,
    component: 'packages/protocol', entry: 'node ensureWorkspacePackagesBuilt.mjs', projects: ['packages/protocol'] });
  const shared = await acquire(root, 60, t, step('validation'));
  const commit = await acquire(root, 60, t, priorityIdentity(root, 'commit'));
  const focused = await acquire(root, 60, t, step('focused-validation-cli'));
  const sample = await requestAdmissionSample(root);
  assert.equal(sample.head.className, 'package-dist', 'the earlier shared step heads the queue');
  assert.equal(sample.head.headPriority, 1.5, 'it is ranked by its highest-ranked waiting run');
  await holder.release();
  const started = await shared.admit();
  await started.release();
  const next = await focused.admit();
  await next.release();
  await commit.admit();
});

test('a producer-ranked head holds free capacity too: nothing backfills past it once it is next', linux, async t => {
  // Systemic 18:35Z: repo-dev's 18.5 GiB server bundle sat at position 1 while
  // smaller validation jobs were admitted into memory that was already free.
  const { root } = await fixture(t);
  const holder = await (await acquire(root, 50, t)).admit();
  const producer = await acquire(root, 60, t, priorityIdentity(root, 'producer'));
  const sample = await requestAdmissionSample(root);
  assert.equal(sample.head.headPriority, 2);
  assert.equal(sample.unreservedMemoryKiB, 0, 'the free 50 units are held for the producer');
  const small = await acquire(root, 10, t, { noWait: true });
  assert.equal((await small.next()).reason, 'HSTACK_MEMORY_BUSY', 'a small job cannot start past the producer');
  await holder.release();
  await producer.admit();
});

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

test('identity keys on component and entry, never the argument list; unrecorded identities use typical related history', linux, async t => {
  const gib = 1024 * 1024;
  const { root } = await fixture(t, { readMemory: () => ({ availableMemoryKiB: 100 * gib, totalMemoryKiB: 100 * gib }),
    admitDisk: () => ({ admitted: true }) });
  const settle = async () => { while ((await requestAdmissionSample(root)).activeCount !== 0) await new Promise(resolve => setImmediate(resolve)); };
  const floorFile = join(root, 'floor.txt');
  const entryA = join(root, 'entry-a.mjs');
  const entryB = join(root, 'entry-b.mjs');
  const record = `import{writeFileSync}from"node:fs";writeFileSync(${JSON.stringify(floorFile)},process.env.HAPPIER_HEAVYWEIGHT_ADMISSION_FLOOR_KIB)`;
  await writeFile(entryA, record); await writeFile(entryB, record);
  const coldFloorKiB = HEAVYWEIGHT_COMMAND_RESOURCES.compilation.memoryKiB;
  const run = (entry, files, peakKiB, className = 'compilation') => runAdmissionCommand({ root, className, floorKiB: coldFloorKiB,
    machine: 'fixture', repoDir: root, cacheBaseDir: root, env: {}, projects: ['.'], readJobPeakKiB: () => peakKiB,
    command: process.execPath, args: [entry, ...files] });
  const admittedFloor = async () => Number(await readFile(floorFile, 'utf8'));
  assert.equal(await run(entryA, ['alpha.test.mjs'], 1 * gib), 0); await settle();
  assert.equal(await admittedFloor(), coldFloorKiB, 'a class without kernel history reserves its floor');
  assert.equal(await run(entryB, ['beta.test.mjs'], 9 * gib), 0); await settle();
  assert.equal(await admittedFloor(), 1 * gib, 'an unrecorded identity uses the 1 GiB related history so far');
  assert.equal(await run(entryA, ['gamma.test.mjs', 'delta.test.mjs'], 1 * gib), 0); await settle();
  assert.equal(await admittedFloor(), 1 * gib, 'new arguments for a recorded entry keep its identity');
  await writeFile(join(root, 'entry-c.mjs'), record);
  assert.equal(await run(join(root, 'entry-c.mjs'), ['x.test.mjs'], 1 * gib), 0); await settle();
  assert.equal(await admittedFloor(), 1 * gib, 'an unrecorded entry uses the related median');
});

test('an unrecorded identity starts from its command family or package set, with a class median as the last fallback', linux, async t => {
  const gib = 1024 * 1024;
  const { root, broker } = await fixture(t, { readMemory: () => ({ availableMemoryKiB: 100 * gib, totalMemoryKiB: 100 * gib }),
    admitDisk: () => ({ admitted: true }) });
  const key = (entry, projects, component = '.') => JSON.stringify(['compilation', component, entry, [...projects].sort()]);
  const fixtureCompile = 'node scripts/workspaces/runTypeScriptCli.mjs';
  const checker = 'node scripts/workspaces/checkCommitTypeCoherence.mjs';
  await writeFile(join(root, 'identity-kernel-peaks.json'), JSON.stringify({
    [key(fixtureCompile, ['packages/plugin-sdk/fixtures/a/tsconfig.json'])]: [Math.round(1.4 * gib)],
    [key(checker, ['.'])]: [Math.round(32.7 * gib)],
    [key(checker, ['apps/cli', 'apps/ui'])]: [17 * gib],
    [key(checker, ['apps/bootstrap', 'apps/cli', 'apps/desktop', 'apps/server'])]: [Math.round(39.9 * gib)],
    [key('pnpm run typecheck:local', ['packages/plugins/machine-lima'], 'packages/plugins/machine-lima')]: [Math.round(4.8 * gib)],
  }));
  const reserved = async identity => {
    const held = await (await acquire(root, 38 * gib, t, { className: 'compilation', resourceClass: 'compilation',
      commandClass: 'compilation', component: '.', ...identity })).admit();
    const floorKiB = broker.status().reservedMemoryKiB;
    await held.release();
    return floorKiB;
  };
  assert.equal(await reserved({ entry: fixtureCompile, projects: ['packages/plugin-sdk/fixtures/b/tsconfig.json'] }), 1.5 * gib,
    'a new fixture compile takes its command family median (1.4 GiB), not the 39.9 GiB class maximum');
  assert.equal(await reserved({ entry: checker, projects: ['apps/cli'] }), 33 * gib,
    'a package set inside recorded runs of the same command takes their median');
  assert.equal(await reserved({ entry: 'pnpm run typecheck:local', projects: ['packages/plugins/machine-lima'],
    component: 'packages/plugins/machine-lima-copy' }), 5 * gib, 'the same command in another component is the same family');
  assert.equal(await reserved({ entry: 'node other-checker.mjs', projects: ['apps/cli', 'apps/ui'] }), 17 * gib,
    'an unknown command on a recorded package set uses that package set\'s history');
  assert.equal(await reserved({ entry: 'node other-checker.mjs', projects: ['apps/website'] }), 17 * gib,
    'with no closer related record the class median applies');
});

test('a routed command is identified by its own argv, not the remote wrapper script', linux, async t => {
  // P03-QUEUE-AUDIT 1.3: routed validation reserved 3.5-6.5 GiB p50 against
  // recorded peaks of 1.1-1.7 GiB. Its admitted payload is the dispatcher's
  // \`bash -c <wrapper>\`, whose text embeds the file list, so the identity never
  // repeated and every run took a related or class maximum.
  const gib = 1024 * 1024;
  const { root } = await fixture(t, { readMemory: () => ({ availableMemoryKiB: 100 * gib, totalMemoryKiB: 100 * gib }),
    admitDisk: () => ({ admitted: true }) });
  await writeFile(join(root, 'identity-kernel-peaks.json'), JSON.stringify({
    [JSON.stringify(['validation', 'apps/ui', 'vitest', ['.']])]: [1.5 * gib],
    [JSON.stringify(['validation', '.', 'node other.mjs', ['.']])]: [9 * gib] }));
  const floorFile = join(root, 'floor.txt');
  const wrapper = `set -euo pipefail; cd -- apps/ui; node -e 'require("node:fs").writeFileSync(${JSON.stringify(floorFile)}, process.env.HAPPIER_HEAVYWEIGHT_ADMISSION_FLOOR_KIB)' x.test.ts`;
  const previous = process.exitCode;
  await runAdmissionClient(['--run', `--root=${root}`, '--class=validation', `--floor-kib=${2 * gib}`, '--machine=fixture',
    '--projects=.', `--repo=${root}`, '--identity-cwd=apps/ui',
    ...['pnpm', 'exec', 'vitest', 'run', 'sources/a.test.ts'].map(arg => `--identity-arg=${arg}`),
    '--', 'bash', '-c', wrapper]);
  assert.equal(process.exitCode, 0);
  process.exitCode = previous;
  assert.equal(Number(await readFile(floorFile, 'utf8')), 1.5 * gib, 'the run reserves its own recorded identity peak');
});

// P03-SPLIT-AUDIT-A P1-4: placement sized commands by the class floor while the
// broker reserved the identity's recorded peak. A sample names the identity, and the
// broker answers with the floor it would reserve for it, so placement uses one rule.
test('a sample for a routed command answers the floor the broker would reserve for its identity', linux, async t => {
  const gib = 1024 * 1024;
  const { root } = await fixture(t, { readMemory: () => ({ availableMemoryKiB: 100 * gib, totalMemoryKiB: 100 * gib }),
    admitDisk: () => ({ admitted: true }) });
  await writeFile(join(root, 'identity-kernel-peaks.json'), JSON.stringify({
    [JSON.stringify(['compilation-ui', 'apps/ui', 'vitest', ['.']])]: [1.5 * gib] }));
  const sample = async identityArgs => {
    let written = '';
    const write = t.mock.method(process.stdout, 'write', chunk => { written += chunk; return true; });
    try {
      await runAdmissionClient(['--sample', `--root=${root}`, '--class=compilation-ui', `--floor-kib=${20 * gib}`,
        '--projects=.', `--repo=${root}`, '--identity-cwd=apps/ui', ...identityArgs.map(arg => `--identity-arg=${arg}`)]);
    } finally { write.mock.restore(); }
    return JSON.parse(written);
  };
  assert.equal((await sample(['pnpm', 'exec', 'vitest', 'run', 'sources/a.test.ts'])).identityFloorKiB, 1.5 * gib,
    'a recorded identity is sized by its recorded peak, as its reservation will be');
  assert.equal((await sample(['node', 'unrecorded.mjs'])).identityFloorKiB, 1.5 * gib,
    'an unrecorded identity takes the same related record the reservation would');
});

test('a queued request uses its own newly recorded peak instead of its initial class estimate', linux, async t => {
  const gib = 1024 * 1024;
  let availableMemoryKiB = 35 * gib;
  const { root } = await fixture(t, {
    readMemory: () => ({ availableMemoryKiB, totalMemoryKiB: 50 * gib }),
    admitDisk: () => ({ admitted: true }),
  });
  await writeFile(join(root, 'identity-kernel-peaks.json'), JSON.stringify({
    [JSON.stringify(['compilation', '.', 'node unrelated.mjs', ['apps/ui']])]: [22 * gib],
  }));
  const identity = { className: 'compilation', resourceClass: 'compilation',
    component: 'apps/cli', entry: 'pnpm run typecheck', projects: ['apps/cli'] };
  const active = await (await acquire(root, 30 * gib, t, identity)).admit();
  assert.equal(active.reserved.floorKiB, 22 * gib);

  const queued = await acquire(root, 30 * gib, t, {
    ...identity, floorOptions: [{ floorKiB: 8 * gib, workers: 8 }, { floorKiB: 4 * gib, workers: 4 }],
  });
  let sample;
  do { sample = await requestAdmissionSample(root); } while (sample.waitingCount === 0);
  assert.equal(sample.head.minimumFloorKiB, 22 * gib);

  // The first run supplies a precise peak while its successor stays connected.
  // There is still insufficient memory for the old estimate after release.
  availableMemoryKiB = 15 * gib;
  await active.report({ kind: 'slot-working-set', ...identity, peakKiB: 4.25 * gib });
  await active.release();
  const before = sample.sampleCount;
  do { sample = await requestAdmissionSample(root); } while (sample.sampleCount === before);
  assert.equal(sample.waitingCount, 0, 'the live waiter should no longer hold its old class estimate');
  const next = await queued.admit();
  assert.equal(next.reserved.floorKiB, 4.5 * gib);
  assert.equal(next.reserved.workers, 4);
  await next.release();
});

test('twenty simultaneous requests reserve only five expected peaks before and during succession', linux, async t => {
  const gib = 1024 * 1024;
  const floorKiB = 2 * gib;
  const readMemory = () => ({ availableMemoryKiB: 5 * floorKiB, totalMemoryKiB: 64 * gib });
  const readSlotWorkingSetKiB = () => 1;
  const { root, broker, sampleResources } = await fixture(t, { readMemory, readSlotWorkingSetKiB,
    admitDisk: () => ({ admitted: true }) });
  const requestOptions = { noWait: true, className: 'compilation', resourceClass: 'compilation' };
  const burst = () => Promise.all(Array.from({ length: 20 }, () => acquire(root, floorKiB, t, requestOptions)));
  const offers = async clients => {
    const decisions = await Promise.all(clients.map(client => client.next()));
    assert.ok(decisions.every(result => result.kind === 'reserved' || result.reason === 'HSTACK_MEMORY_BUSY'));
    return decisions.filter(result => result.kind === 'reserved').length;
  };

  const clients = await burst();
  assert.equal(await offers(clients), 5, 'five expected peaks fit before any payload starts');
  for (const client of clients) client.socket.destroy();
  const holders = await Promise.all(Array.from({ length: 5 }, async () =>
    (await acquire(root, floorKiB, t, requestOptions)).admit()));
  const before = await requestAdmissionSample(root);
  assert.equal(before.reservedMemoryKiB, 5 * floorKiB);
  await broker.close();

  const replacement = createAdmissionBroker({ root, sampleResources, readCpuCapacity: () => 128, readSlotWorkingSetKiB,
    admitDisk: () => ({ admitted: true }) });
  t.after(() => replacement.close());
  await replacement.start();
  assert.equal(await offers(await burst()), 0, 'a successor cannot offer a sixth peak while the first five warm up');
  const after = await requestAdmissionSample(root);
  assert.equal(after.activeCount, 5);
  assert.equal(after.reservedMemoryKiB, before.reservedMemoryKiB);
  assert.equal(after.reservedCpuCores, before.reservedCpuCores);
  for (const holder of holders) await holder.release();
});

test('a slot keeps its expected peak through its recorded median duration then charges its working set', linux, async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  let availableMemoryKiB = 100;
  const readMemory = () => ({ availableMemoryKiB, totalMemoryKiB: 100 });
  const readSlotWorkingSetKiB = () => 12;
  const { root, broker, sampleResources } = await fixture(t, { readMemory, readSlotWorkingSetKiB });
  const identity = { className: 'compilation', component: 'apps/ui', entry: 'node scripts/workspaces/runTypeScriptCli.mjs', projects: ['.'] };
  const key = JSON.stringify([identity.className, identity.component, identity.entry, identity.projects]);
  await writeFile(join(root, 'identity-durations.json'), JSON.stringify({ [key]: [1000, 4000, 2000] }));
  const started = Promise.withResolvers();
  const finished = Promise.withResolvers();
  const task = runAdmittedTask({ root, floorKiB: 60, repoDir: root, env: {}, ...identity }, async () => {
    started.resolve();
    return await finished.promise;
  });
  t.after(async () => { finished.resolve(); await task; });
  await started.promise;

  availableMemoryKiB = 88;
  now += 2000;
  const tooSoon = await acquire(root, 80, t, { noWait: true });
  assert.equal((await tooSoon.next()).reason, 'HSTACK_MEMORY_BUSY', 'the charge still holds at the warm-up boundary');
  await broker.close();
  const replacement = createAdmissionBroker({ root, sampleResources, readSlotWorkingSetKiB, readCpuCapacity: () => 128 });
  t.after(() => replacement.close());
  await replacement.start();
  assert.equal((await requestAdmissionSample(root)).reservedMemoryKiB, 60,
    'the successor retains the expected peak at the warm-up boundary');

  now += 1;
  const afterWarmup = await acquire(root, 80, t, { noWait: true });
  assert.equal((await afterWarmup.next()).kind, 'reserved',
    'the successor uses the working set after the local median even without a dispatcher duration');
  assert.equal((await requestAdmissionSample(root)).reservedMemoryKiB, 92);
});

test('working-set reads use anon, shmem and kernel and ignore the file cache and lifetime peak', linux, () => {
  const scope = `/user.slice/user-${process.getuid()}.slice/user@${process.getuid()}.service/happier.slice/happier-jobs.slice/happier-jobs-123-fixture.scope`;
  const files = new Map([
    ['/proc/123/cgroup', `0::${scope}\n`],
    ['/proc/self/cgroup', '0::/\n'],
    [`/sys/fs/cgroup${scope}/memory.stat`, 'anon 1048576\nfile 104857600\nshmem 65536\nkernel 32768\n'],
  ]);
  const read = file => {
    assert.ok(files.has(file), `unexpected read: ${file}`);
    return files.get(file);
  };
  assert.equal(admissionMemory.readProcessJobScopeWorkingSetKiB(123, read), 1120);
});

test('a retained client can finish after the broker switches to working-set samples', linux, async t => {
  const { root } = await fixture(t);
  const status = await runAdmittedTask({
    root, className: 'validation', floorKiB: 1, machine: 'fixture', env: {},
    // The predecessor client resolves this export only after its payload exits.
    readJobPeakKiB: async () => (await import('./admission_memory.mjs')).readJobScopePeakKiB(),
  }, async () => 23);
  assert.equal(status, 23);
});

test('recent working sets replace a historical outlier and survive succession', linux, async t => {
  const gib = 1024 * 1024;
  const { root, broker, sampleResources } = await fixture(t, {
    readMemory: () => ({ availableMemoryKiB: 100 * gib, totalMemoryKiB: 100 * gib }),
  });
  const identity = { className: 'compilation', component: 'apps/stack', entry: 'node --test', projects: ['.'] };
  const key = JSON.stringify(['compilation', identity.component, identity.entry, identity.projects]);
  const legacyKey = JSON.stringify(['compilation', '.', 'node previous.mjs', ['.']]);
  const target = join(root, 'identity-kernel-peaks.json');
  await writeFile(target, JSON.stringify({ [key]: [39 * gib, ...Array(18).fill(6 * gib)], [legacyKey]: 45 * gib }));
  assert.equal(broker.recordedIdentityFloorKiB({ ...identity, floorKiB: 38 * gib }), 39 * gib);
  const run = async peakKiB => {
    await runAdmittedTask({ root, ...identity, floorKiB: 38 * gib, machine: 'fixture', repoDir: root,
      cacheBaseDir: root, env: {}, readJobPeakKiB: () => peakKiB }, async () => 0);
    while ((await requestAdmissionSample(root)).activeCount) await new Promise(resolve => setImmediate(resolve));
  };
  await run(6 * gib);
  assert.equal(broker.recordedIdentityFloorKiB({ ...identity, floorKiB: 38 * gib }), 6 * gib,
    'p95 discounts one outlier once there are 20 completed observations');
  await run(5 * gib);
  const stored = JSON.parse(await readFile(target, 'utf8'));
  assert.deepEqual(stored[key], [...Array(19).fill(6 * gib), 5 * gib], 'keeps the newest 20 in completion order');
  assert.equal(stored[legacyKey], undefined, 'scalar lifetime peaks are not part of the new cache');
  const successor = createAdmissionBroker({ root, sampleResources });
  assert.equal(successor.recordedIdentityFloorKiB({ ...identity, floorKiB: 38 * gib }), 6 * gib);
});

test('broker observations preserve an in-flight working-set peak above the terminal sample', linux, async t => {
  const gib = 1024 * 1024;
  let scopeKiB = 1 * gib;
  const { root } = await fixture(t, {
    readMemory: () => ({ availableMemoryKiB: 100 * gib, totalMemoryKiB: 100 * gib }),
    readSlotWorkingSetKiB: () => scopeKiB,
  });
  const identity = { className: 'compilation', component: '.', entry: 'node --test', projects: ['.'] };
  await runAdmittedTask({ root, ...identity, floorKiB: 10 * gib, machine: 'fixture', repoDir: root,
    cacheBaseDir: root, env: {}, readJobPeakKiB: () => scopeKiB }, async () => {
    scopeKiB = 4 * gib;
    const observer = await (await acquire(root, 1, t, { pid: 999999 })).admit();
    scopeKiB = 1 * gib;
    await observer.release();
    return 0;
  });
  while ((await requestAdmissionSample(root)).activeCount) await new Promise(resolve => setImmediate(resolve));
  assert.equal((await requestAdmissionSample(root, { kind: 'sample', identity: { ...identity,
    resourceClass: identity.className, floorKiB: 10 * gib } })).identityFloorKiB, 4 * gib);
});

test('a web export reserves the recorded working set with a fitting worker count', linux, async t => {
  const gib = 1024 * 1024;
  const { root, broker } = await fixture(t, { readMemory: () => ({ availableMemoryKiB: 100 * gib, totalMemoryKiB: 100 * gib }) });
  const identity = { className: 'source-web-export', resourceClass: 'source-web-export', component: '.',
    entry: 'node apps/stack/scripts/build/build_source_web_ui.mjs', projects: ['apps/stack'] };
  // The persisted working-set history of this export identity (broker record).
  await writeFile(join(root, 'identity-kernel-peaks.json'), JSON.stringify({
    [JSON.stringify([identity.resourceClass, identity.component, identity.entry, identity.projects])]: [Math.round(16.25 * gib)] }));
  const floorOptions = [{ floorKiB: 32 * gib, workers: 47 }, { floorKiB: 16 * gib, workers: 20 }, { floorKiB: 8 * gib, workers: 1 }];
  const held = await (await acquire(root, 32 * gib, t, { ...identity, commandClass: 'source-web-export', floorOptions })).admit();
  assert.equal(broker.status().reservedMemoryKiB, 16.5 * gib, 'reserves the recorded peak (rounded), not the 32 GiB maximum');
  assert.equal(held.admitted.workers, 20, 'runs the most workers whose modelled floor fits inside the recorded peak');
  const fresh = await (await acquire(root, 32 * gib, t, { ...identity, entry: 'node other-export.mjs', commandClass: 'source-web-export',
    floorOptions })).admit();
  assert.equal(fresh.admitted.workers, 20, 'an unrecorded export identity takes the class median');
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
    'process.stdout.write("ready"); process.stdin.resume();'],
  { env: { ...process.env, HAPPIER_HEAVYWEIGHT_ADMISSION_SLOT: '', HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN: '' },
    stdio: ['pipe', 'pipe', 'inherit'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const exited = once(child, 'exit');
  await once(child.stdout, 'data', { signal: t.signal });
  // Another caller observes the live compiler slot while its payload is held.
  const observer = await acquire(root, 1, t);
  assert.equal((await observer.next()).kind, 'reserved');
  observer.socket.destroy();
  child.stdin.end();
  assert.deepEqual(await exited, [0, null]);
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

test('windows2-linux 2026-11-18: a preparation holder sized by its own recorded duration lets 1-7 GiB waiters backfill and the head still starts on time', linux, async t => {
  // 16:13-17:26Z: a 10.5 GiB plugin batch (entry-load preparation) ran 1 h 50 min carrying its run's 404 s p99.
  // Past that p99 the head projection was "now", so the 10.5 GiB head's 9 GiB pledge lent nothing to 33 waiters.
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const { root } = await fixture(t, { readMemory: () => ({ availableMemoryKiB: 40, totalMemoryKiB: 40 }) });
  const batch = { className: 'package-dist', component: '.', entry: 'node scripts/workspaces/ensureWorkspacePackagesBuilt.mjs', projects: ['.'] };
  const hours = 3_600_000;
  // History: the same preparation identity once completed successfully in 2 h.
  const earlier = await (await acquire(root, 21, t, batch)).admit();
  now += 2 * hours;
  await earlier.report({ kind: 'slot-completed', status: 0 });
  await earlier.release();
  while ((await requestAdmissionSample(root)).activeCount) await new Promise(resolve => setImmediate(resolve));
  const timed = p99DurationMs => ({ durationClass: 'targeted-validation', p99DurationMs });
  const holder = await (await acquire(root, 21, t, batch)).admit();
  now += 2 * hours - 1_200_000;
  const pledger = await (await acquire(root, 18, t, timed(1_000))).admit();
  const head = await acquire(root, 21, t, { className: 'package-dist', arrivedAt: now - headReservationDelayMs });
  await pledger.release();
  assert.equal((await requestAdmissionSample(root)).head.reservationKiB, 18, 'the overdue head pledges the release');
  const untimed = await acquire(root, 2, t, { noWait: true });
  assert.equal((await untimed.next()).reason, 'HSTACK_MEMORY_BUSY', 'a waiter without duration history does not backfill');
  const outliving = await acquire(root, 2, t, { ...timed(3 * hours), noWait: true });
  assert.equal((await outliving.next()).reason, 'HSTACK_MEMORY_BUSY', 'a waiter ending after the head can start does not backfill');
  const backfills = [];
  for (const floorKiB of [2, 6, 10]) {
    const backfill = await (await acquire(root, floorKiB, t, { ...timed(404_000), noWait: true })).admit();
    assert.ok(backfill.reserved.backfill?.borrowedKiB > 0, 'the backfill is announced to its waiter');
    backfills.push(backfill);
  }
  const during = await requestAdmissionSample(root);
  assert.equal(during.activeCount, 4, '1-7 GiB waiters run beside the 10.5 GiB holder');
  assert.equal(during.backfillCount, 3, 'the broker counts its backfills in its status');
  now += 404_000;
  for (const backfill of backfills) await backfill.release();
  // The pledge gets back what it lent plus the free unit the first backfill used.
  assert.equal((await requestAdmissionSample(root)).head.reservationKiB, 19, 'released backfill memory goes to the head');
  now += 1_200_000 - 404_000;
  await holder.report({ kind: 'slot-completed', status: 0 });
  await holder.release();
  await head.admit();
  assert.equal((await requestAdmissionSample(root)).waitingCount, 0, 'the head starts when the holder ends');
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

test('status projects a new arrival\'s start by simulating the queue against achievable capacity', linux, async t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const { root } = await fixture(t);
  const durationClass = 'targeted-validation';
  const held = await (await acquire(root, 60, t, { durationClass, p99DurationMs: 1_000 })).admit();
  await acquire(root, 50, t, { durationClass, p99DurationMs: 2_000 });
  await acquire(root, 50, t);
  const sample = await requestAdmissionSample(root);
  // Capacity 100. The slot (60) releases at 1000; both 50-unit waiters start then
  // (2000 and the mean recorded p99 1500 for the waiter without one), filling the
  // host; a new arrival starts at the first of their releases, 1000 + 1500.
  assert.equal(sample.expectedStartMs, 2_500);
  now += 400;
  assert.equal((await requestAdmissionSample(root)).expectedStartMs, 2_100,
    'an admitted slot contributes only its remaining recorded run time; the fill stays the mean recorded p99');
  await held.release();
});

test('the projected start serializes waiters whose floors cannot run together (windows2-linux 2026-11-17)', linux, async t => {
  // INFRA-SWEEP-3: a 21 GiB host with 16 GiB waiters runs them one at a time, yet the
  // area estimate (memory × time / capacity) projected it as the fleet's earliest start.
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const { root } = await fixture(t);
  const durationClass = 'targeted-validation';
  const held = await (await acquire(root, 80, t, { durationClass, p99DurationMs: 1_000 })).admit();
  await acquire(root, 80, t, { durationClass, p99DurationMs: 1_000 });
  await acquire(root, 80, t, { durationClass, p99DurationMs: 1_000 });
  // Capacity 100: each 80-unit job runs alone. The second waiter starts when the first
  // ends (2000); a new arrival starts after that, when the second releases (3000).
  assert.equal((await requestAdmissionSample(root)).expectedStartMs, 3_000);
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
    [JSON.stringify(['compilation', '.', identity.entry, ['.']])]: [Math.round(16.9 * gib)] }));
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

test('an admitted slot past p99 charges its current working set and keeps its payload', linux, async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  let workingSetKiB = 12;
  let availableMemoryKiB = 100;
  const { root } = await fixture(t, {
    readMemory: () => ({ availableMemoryKiB, totalMemoryKiB: 100 }),
    readSlotWorkingSetKiB: () => workingSetKiB,
  });
  const holder = await (await acquire(root, 60, t, {
    className: 'compilation', durationClass: 'targeted-validation', p99DurationMs: 1000,
  })).admit();
  availableMemoryKiB = 88;
  now += 1000;
  const before = await acquire(root, 80, t, { noWait: true });
  assert.equal((await before.next()).reason, 'HSTACK_MEMORY_BUSY');
  now += 1;
  workingSetKiB = null;
  const unmeasurable = await acquire(root, 80, t, { noWait: true });
  assert.equal((await unmeasurable.next()).reason, 'HSTACK_MEMORY_BUSY', 'retain the floor without a trustworthy scope sample');
  workingSetKiB = 12;
  const small = await acquire(root, 80, t, { noWait: true });
  const charged = await requestAdmissionSample(root);
  assert.equal(charged.activeCount, 2, 'the next job fits beside the admitted holder');
  assert.equal(charged.reservedMemoryKiB, 92);
  assert.equal(charged.overruns.length, 0, 'the sentinel threshold stays at twice p99');
  const newJob = await small.admit();
  await newJob.release();
  await holder.release();
});

test('an aged head yields its pledge when its floor cannot fit within the wait bound', linux, async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const { root } = await fixture(t);
  const holder = await (await acquire(root, 60, t, {
    durationClass: 'targeted-validation', p99DurationMs: 2 * headReservationDelayMs,
  })).admit();
  const pledger = await (await acquire(root, 30, t)).admit();
  const head = await acquire(root, 80, t, { arrivedAt: now - headReservationDelayMs });
  await pledger.release();
  const small = await acquire(root, 30, t, { noWait: true });
  const backfill = await requestAdmissionSample(root);
  assert.equal(backfill.activeCount, 2, 'a fitting job uses memory the head cannot use within the bound');
  assert.equal(backfill.waitingCount, 1);
  assert.equal(backfill.head, null, 'the aged head remains queued without pledging');
  const newJob = await small.admit();
  now += headReservationDelayMs;
  await newJob.release();
  assert.equal((await requestAdmissionSample(root)).head.minimumFloorKiB, 80);
  await holder.release();
  await head.admit();
});

test('an already queued compilation uses its class history as soon as the first related sample arrives', linux, async t => {
  const gib = 1024 * 1024;
  let availableMemoryKiB = 42 * gib;
  const { root } = await fixture(t, {
    readMemory: () => ({ availableMemoryKiB, totalMemoryKiB: 64 * gib }),
    admitDisk: () => ({ admitted: true }),
  });
  const activeIdentity = { className: 'compilation', component: 'apps/cli', entry: 'yarn typecheck', projects: ['apps/cli'] };
  const active = await (await acquire(root, 38 * gib, t, activeIdentity)).admit();
  const waiting = await acquire(root, 38 * gib, t, { className: 'compilation',
    component: 'apps/stack', entry: 'yarn compile', projects: ['apps/stack'] });
  const before = await requestAdmissionSample(root);
  assert.equal(before.head.minimumFloorKiB, 38 * gib);
  availableMemoryKiB = 16 * gib;
  await active.report({ kind: 'slot-working-set', ...activeIdentity, peakKiB: 4.25 * gib });
  await active.release();
  let after;
  do { after = await requestAdmissionSample(root); } while (after.sampleCount === before.sampleCount);
  assert.equal(after.waitingCount, 0);
  const admitted = await waiting.admit();
  assert.equal(admitted.reserved.floorKiB, 4.5 * gib);
  await admitted.release();
});

test('a retained compilation acquire uses the current cold floor', linux, async t => {
  const gib = 1024 * 1024;
  const { root } = await fixture(t, {
    readMemory: () => ({ availableMemoryKiB: 20 * gib, totalMemoryKiB: 64 * gib }),
    admitDisk: () => ({ admitted: true }),
  });
  const retained = await acquire(root, 38 * gib, t, {
    arrivedAt: Date.now() - headReservationDelayMs,
    className: 'compilation', resourceClass: 'compilation',
  });
  const sampled = await requestAdmissionSample(root);
  assert.equal(sampled.activeCount, 1, 'the reconnecting waiter fits the successor’s available memory');
  const granted = await retained.admit();
  assert.equal(granted.reserved.floorKiB, 17 * gib);
  await granted.release();
});
