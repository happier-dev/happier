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
import { connectAdmissionBroker } from './admission_client.mjs';
import { slotAddress } from './admission_socket.mjs';
import { createWorkspaceBuildResourcePriorityScope, tryWorkspaceBuildResources } from './workspace_build_admission.mjs';
import { createWorkspaceBundleLockPriorityScope } from '../../../../../packages/cli-common/workspaceBundleLock.mjs';
import { DEFAULT_FILE_CHANGE_CATCH_UP_MS } from '../../../../../packages/cli-common/fileChangeObserver.mjs';
import { admitWorkerDiskBudget } from '../dev_targets/worker_disk_budget.mjs';

const linux = { skip: process.platform !== 'linux' };

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

test('a waiting client can reuse its priority after a reserved publication is unwound before payload admission', linux, async t => {
  const { root } = await fixture(t);
  const locks = [{ path: join(root, 'publication.lock') }];
  const priorityScope = createWorkspaceBuildResourcePriorityScope({ locks });
  t.after(() => priorityScope.dispose());
  const first = await tryWorkspaceBuildResources({ locks, priorityScope });
  assert.equal(first.acquired, true);
  await first.release();
  // A broker connection can close after resources are reserved but before the
  // payload is admitted. Its existing client then reconnects and tries again.
  const retried = await tryWorkspaceBuildResources({ locks, priorityScope });
  try { assert.equal(retried.acquired, true); }
  finally { await retried.release?.(); }
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
  const client = await request(root, { kind: 'acquire', className: 'validation', floorKiB,
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

async function fixture(t, { readMemory = () => ({ availableMemoryKiB: 100, totalMemoryKiB: 100 }), admitDisk } = {}) {
  // Unix socket metadata needs a short pathname, independent of the command's
  // potentially deep workspace/custody TMPDIR. This remains a private root.
  const root = await mkdtemp('/tmp/happier-broker-test-');
  const sampleResources = ({ slots }) => readAdmissionMemorySample({ slots,
    readMemory, readProcesses: () => new Map() });
  const broker = createAdmissionBroker({ root, oldLockPath: join(root, 'old-admission.lock'), sampleResources,
    ...(admitDisk ? { admitDisk } : {}) });
  await broker.start();
  t.after(async () => { await broker.close(); await rm(root, { recursive: true, force: true }); });
  return { root, broker, sampleResources };
}

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

test('a late reconnect keeps younger admitted backfills out of its head reservation', linux, async t => {
  const { root } = await fixture(t);
  const younger = await acquire(root, 40, t, { arrivedAt: 20 });
  await younger.admit();
  await acquire(root, 70, t, { arrivedAt: 10 });
  const sample = await request(root, { kind: 'sample' });
  assert.equal((await sample.next()).unreservedMemoryKiB, 0);
  sample.socket.destroy();
  const backfill = await acquire(root, 20, t, { arrivedAt: 30, noWait: true });
  assert.equal((await backfill.next()).reason, 'HSTACK_MEMORY_BUSY');
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
  const large = await acquire(root, 70, t);
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
      sampleResources: async () => ({ availableMemoryKiB: 100, totalMemoryKiB: 100 }) });
    const controls = new Set();
    const servers = new Map();
    const write = Socket.prototype.write;
    async function connect(floorKiB) {
      const socket = createConnection(brokerAddress(root));
      controls.add(socket);
      socket.on('error', () => {});
      await once(socket, 'connect');
      socket.write(JSON.stringify({ kind: 'acquire', className: 'validation', floorKiB,
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
