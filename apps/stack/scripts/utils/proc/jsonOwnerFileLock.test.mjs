import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { unlinkSync, writeFileSync } from 'node:fs';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { describeJsonOwnerLockOwner, readJsonOwnerLockSnapshot, withJsonOwnerFileLock } from './jsonOwnerFileLock.mjs';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { spawnTestProcess } from '../../testkit/core/spawn_test_process.mjs';
import { createWorkspaceBuildWaitNotifier } from './workspaceBuildWaitNotifier.mjs';

test('exclusive admission preserves arrival order across release and later arrivals, skipping cancellation', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-json-owner-fifo-' });
  const lockPath = fixture.path('owner.lock');
  const order = [];
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const holder = withJsonOwnerFileLock(() => held, { lockPath });
  const cancellation = new AbortController();
  let observed;
  const waiting = new Promise(resolve => { observed = resolve; });
  const early = withJsonOwnerFileLock(() => { order.push('early'); }, { lockPath, onWait: observed });
  const cancelled = withJsonOwnerFileLock(() => assert.fail('cancelled waiter entered'), {
    lockPath, signal: cancellation.signal, onWait: () => cancellation.abort(),
  });
  await assert.rejects(cancelled, { name: 'AbortError' });
  await waiting;
  // Promise continuations run before the native filesystem wake. A newcomer
  // must respect the queued early waiter even when it sees the path free first.
  release();
  await holder;
  const later = Array.from({ length: 12 }, (_, index) => withJsonOwnerFileLock(() => {
    order.push(index);
  }, { lockPath }));
  await Promise.all([early, ...later]);
  assert.deepEqual(order, ['early', ...Array.from({ length: 12 }, (_, index) => index)]);
});

test('nonwaiting acquisition cannot bypass an already waiting caller', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-json-owner-no-barge-' });
  const lockPath = fixture.path('owner.lock');
  let release;
  const holder = withJsonOwnerFileLock(() => new Promise(resolve => { release = resolve; }), { lockPath });
  let observed;
  const waiting = new Promise(resolve => { observed = resolve; });
  const early = withJsonOwnerFileLock(() => {}, { lockPath, onWait: observed });
  await waiting;
  release();
  await holder;
  await assert.rejects(withJsonOwnerFileLock(() => assert.fail('newcomer bypassed queue'), {
    lockPath, wait: false,
  }), { code: 'EJSONOWNERFILELOCKBUSY' });
  await early;
  assert.equal(await withJsonOwnerFileLock(() => 'idle', { lockPath, wait: false }), 'idle');
});

test('cancelling the head waiter leaves its successor ahead of later arrivals', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-json-owner-head-abort-' });
  const lockPath = fixture.path('owner.lock');
  let release;
  const holder = withJsonOwnerFileLock(() => new Promise(resolve => { release = resolve; }), { lockPath });
  const controller = new AbortController();
  let observed;
  const waiting = new Promise(resolve => { observed = resolve; });
  const head = withJsonOwnerFileLock(() => assert.fail('cancelled head entered'), {
    lockPath, signal: controller.signal, onWait: observed,
  });
  await waiting;
  const order = [];
  const successor = withJsonOwnerFileLock(() => { order.push('successor'); }, { lockPath });
  controller.abort();
  await assert.rejects(head, { name: 'AbortError' });
  release();
  await holder;
  const newcomer = withJsonOwnerFileLock(() => { order.push('newcomer'); }, { lockPath });
  await Promise.all([successor, newcomer]);
  assert.deepEqual(order, ['successor', 'newcomer']);
});

test('separate processes preserve established waiter order', { timeout: 10000 }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-json-owner-process-order-' });
  const lockPath = fixture.path('owner.lock');
  const orderPath = fixture.path('order');
  let release;
  const holder = withJsonOwnerFileLock(() => new Promise(resolve => { release = resolve; }), { lockPath });
  const children = [];
  const script = `import {appendFileSync} from 'node:fs';
    import {withJsonOwnerFileLock} from ${JSON.stringify(new URL('./jsonOwnerFileLock.mjs', import.meta.url).href)};
    let announced=false;await withJsonOwnerFileLock(()=>appendFileSync(process.argv[2],process.argv[3]+'\\n'),
      {lockPath:process.argv[1],onWait(){if(!announced){announced=true;process.stdout.write('waiting');}}});`;
  try {
    for (const id of ['first', 'second', 'third']) {
      const child = spawnTestProcess(process.execPath, ['--input-type=module', '-e', script, lockPath, orderPath, id], {
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      const exited = new Promise(resolve => child.once('exit', resolve));
      children.push({ child, exited });
      const [chunk] = await once(child.stdout, 'data', { signal: t.signal });
      assert.equal(String(chunk), 'waiting');
    }
    release();
    await holder;
    for (const { exited } of children) assert.equal(await exited, 0);
    assert.equal(await readFile(orderPath, 'utf8'), 'first\nsecond\nthird\n');
  } finally {
    release();
    for (const { child } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    await Promise.all([holder, ...children.map(({ exited }) => exited)]);
  }
});

test('a departed queued process cannot strand its successor', { timeout: 10000 }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-json-owner-waiter-death-' });
  const lockPath = fixture.path('owner.lock');
  let release;
  const holder = withJsonOwnerFileLock(() => new Promise(resolve => { release = resolve; }), { lockPath });
  const script = `import {withJsonOwnerFileLock} from ${JSON.stringify(new URL('./jsonOwnerFileLock.mjs', import.meta.url).href)};
    process.stdin.resume();let announced=false;
    await withJsonOwnerFileLock(()=>{process.stdout.write('unexpected');},{lockPath:process.argv[1],
      onWait(){if(!announced){announced=true;process.stdout.write('waiting');}}});`;
  const child = spawnTestProcess(process.execPath, ['--input-type=module', '-e', script, lockPath], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const exited = new Promise(resolve => child.once('exit', resolve));
  let successor;
  try {
    const [chunk] = await once(child.stdout, 'data', { signal: t.signal });
    assert.equal(String(chunk), 'waiting');
    successor = withJsonOwnerFileLock(() => 'recovered', { lockPath, signal: t.signal });
    child.kill('SIGKILL');
    await exited;
    release();
    await holder;
    assert.equal(await successor, 'recovered');
  } finally {
    release();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    await Promise.allSettled([holder, successor].filter(Boolean));
  }
});

test('an idle exclusive lock is available despite a pending former queue ticket', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-json-owner-exclusive-' });
  const lockPath = fixture.path('owner.lock');
  await mkdir(`${lockPath}.waiters`);
  await writeFile(join(`${lockPath}.waiters`, '1.json'), JSON.stringify({
    pid: process.pid, createdAtMs: Date.now(), updatedAtMs: Date.now(), priority: 'writer',
  }));
  assert.equal(await withJsonOwnerFileLock(async () => 'acquired', { lockPath, wait: false }), 'acquired');
});

test('obsolete shared-reader records do not exclude work while live writer records remain protected', async t => {
  for (const priority of ['reader', 'writer', undefined]) await t.test(priority ?? 'untyped', async t => {
    const fixture = await createTempFixture(t, { prefix: 'hstack-json-owner-retired-reader-' });
    const lockPath = fixture.path('owner.lock');
    // Captured owner shape from the shared-reader implementation removed in
    // this change. Already-loaded readers can leave it until their next release.
    const raw = JSON.stringify({ pid: process.pid, createdAtMs: 1, updatedAtMs: 1,
      ...(priority ? { priority } : {}), ...(priority === 'reader' ? { readers: [{ pid: process.pid }] } : {}) });
    await writeFile(lockPath, raw);
    const acquire = () => withJsonOwnerFileLock(async () => 'acquired', { lockPath, wait: false, staleAfterMs: 1 });
    if (priority === 'reader') assert.equal(await acquire(), 'acquired');
    else {
      await assert.rejects(acquire(), { code: 'EJSONOWNERFILELOCKBUSY' });
      assert.equal(await readFile(lockPath, 'utf8'), raw);
    }
  });
});

test('wait diagnostics report the live exclusive holder from the acquisition snapshot', async t => {
  const fixture = await createTempFixture(t, { prefix: 'json-owner-live-holder-' });
  const lockPath = fixture.path('owner.lock');
  const nowMs = Date.now();
  const owner = { pid: process.pid, createdAtMs: nowMs - 9000, updatedAtMs: nowMs - 1000 };
  await writeFile(lockPath, JSON.stringify(owner));
  let clockNowMs = nowMs;
  t.mock.method(Date, 'now', () => clockNowMs);
  const read = fs.readFileSync;
  let reads = 0;
  t.mock.method(fs, 'readFileSync', (path, ...args) => {
    if (path === lockPath) reads += 1;
    return read(path, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  let notices = '';
  t.mock.method(process.stderr, 'write', chunk => { notices += String(chunk); return true; });
  const notice = createWorkspaceBuildWaitNotifier({
    label: 'dependency refresh', kind: 'lock', env: { HAPPIER_WORKSPACE_BUILD_NOTICE_AFTER_MS: '0' },
  });
  const cancellation = new AbortController();
  let observed;
  let notifierReread;
  await assert.rejects(withJsonOwnerFileLock(() => assert.fail('live holder must block acquisition'), {
    lockPath, signal: cancellation.signal,
    onWait(event) {
      observed = event;
      unlinkSync(lockPath);
      clockNowMs = nowMs + 60000;
      const readsBeforeNotice = reads;
      notice(event);
      notifierReread = reads !== readsBeforeNotice;
      cancellation.abort();
    },
  }), { name: 'AbortError' });
  assert.equal(notifierReread, false, 'the notifier must not reread the lock');
  assert.deepEqual(observed.holders.map(({ pid, kind, heldMs, heartbeatAgeMs }) => ({ pid, kind, heldMs, heartbeatAgeMs })), [
    { pid: process.pid, kind: 'writer', heldMs: 9000, heartbeatAgeMs: 1000 },
  ]);
  assert.equal(observed.owner.pid, process.pid);
  assert.match(notices, /writer pid=.*heldMs=9000.*heartbeatAgeMs=1000/);
});

test('owner creation and heartbeat never expose an incomplete owner record', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-json-owner-publication-' });
  const lockPath = fixture.path('owner.lock');
  const open = fs.openSync;
  const write = fs.writeFileSync;
  const observations = [];
  const observe = () => {
    const snapshot = readJsonOwnerLockSnapshot(lockPath);
    if (snapshot.exists) observations.push(snapshot.owner);
  };
  // Observe the real filesystem between creation/truncation and the first
  // write, the same point another process can read after an interrupted write.
  t.mock.method(fs, 'openSync', (...args) => {
    const fd = open(...args);
    if (args[0] === lockPath) observe();
    return fd;
  });
  t.mock.method(fs, 'writeFileSync', (path, data, options) => {
    if (path === lockPath) {
      const flag = typeof options === 'object' ? options.flag ?? 'w' : 'w';
      const fd = open(path, flag);
      try { observe(); write(fd, data, options); } finally { fs.closeSync(fd); }
    } else write(path, data, options);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  t.mock.timers.enable({ apis: ['setInterval'] });
  await withJsonOwnerFileLock(async ({ owner }) => {
    observe();
    t.mock.timers.tick(5_000);
    observe();
    assert.ok(observations.length > 0);
    assert.ok(observations.every(entry => entry?.pid === process.pid && entry.createdAtMs === owner.createdAtMs),
      'every published record must identify the actual holder, including during heartbeat replacement');
  }, { lockPath });
  await assert.rejects(readFile(lockPath), { code: 'ENOENT' });
});

test('stale reclaim preserves a fresh replacement even when restoration is interrupted', async t => {
  for (const interrupted of [false, true]) await t.test(interrupted ? 'interrupted restoration' : 'complete restoration', async t => {
    const fixture = await createTempFixture(t, { prefix: 'hstack-json-owner-reclaim-' });
    const lockPath = fixture.path('owner.lock');
    const staleRaw = JSON.stringify({ pid: 99999999, createdAtMs: 1, updatedAtMs: 1 });
    const freshRaw = JSON.stringify({ pid: process.pid, createdAtMs: Date.now(), updatedAtMs: Date.now() });
    const rename = fs.renameSync;
    const write = fs.writeFileSync;
    const open = fs.openSync;
    let reclaimPath;
    await writeFile(lockPath, staleRaw);
    // Replace the stale snapshot at the real rename boundary, as a competing
    // reclaimer followed by a fresh holder can do between read and quarantine.
    t.mock.method(fs, 'renameSync', (from, to) => {
      if (from === lockPath && String(to).includes('.reclaim-') && !reclaimPath) {
        reclaimPath = to;
        rename(lockPath, fixture.path('previous-owner'));
        write(fixture.path('fresh-owner'), freshRaw);
        fs.linkSync(fixture.path('fresh-owner'), lockPath);
      }
      return rename(from, to);
    });
    t.mock.method(fs, 'writeFileSync', (path, raw, options) => {
      // An interruption after opening the public path must never be possible:
      // the complete-record publisher writes privately before exclusive link.
      if (interrupted && path === lockPath && raw === freshRaw) {
        const fd = open(path, 'wx');
        fs.closeSync(fd);
        throw Object.assign(new Error('interrupted owner restoration'), { code: 'EIO' });
      }
      return write(path, raw, options);
    });
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    await assert.rejects(withJsonOwnerFileLock(() => assert.fail('fresh owner excludes contender'), {
      lockPath, wait: false,
    }), { code: 'EJSONOWNERFILELOCKBUSY' });
    assert.ok(reclaimPath, 'the stale-read/fresh-replacement race was reached');
    const snapshot = readJsonOwnerLockSnapshot(lockPath);
    assert.equal(snapshot.raw, freshRaw, 'restoration never publishes an ownerless record');
    await assert.rejects(readFile(reclaimPath), { code: 'ENOENT' });
  });
});

test('release wakes queued JSON owners without the catch-up delay, including release during onWait', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-json-owner-events-' });
  for (const duringOnWait of [false, true]) {
    const lockPath = fixture.path(`owner-${duringOnWait}.lock`);
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, createdAtMs: Date.now(), updatedAtMs: Date.now() }));
    let observed;
    const waiting = new Promise(resolve => { observed = resolve; });
    const contender = withJsonOwnerFileLock(async () => 'acquired', {
      lockPath, pollIntervalMs: 2_000, watchFallbackMs: 2_000, timeoutMs: 3_000,
      onWait() { observed(); if (duringOnWait) unlinkSync(lockPath); },
    });
    try {
      await waiting;
      if (!duringOnWait) { await delay(30); unlinkSync(lockPath); }
      assert.equal(await Promise.race([contender, delay(500).then(() => 'missed release')]), 'acquired');
    } finally { await contender; }
  }
});

test('JSON owner heartbeat-only changes do not rescan healthy contention', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-json-owner-heartbeat-events-' });
  const lockPath = fixture.path('owner.lock');
  const createdAtMs = Date.now();
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, createdAtMs, updatedAtMs: createdAtMs }));
  const controller = new AbortController();
  let waits = 0;
  let queueScans = 0;
  const readdir = fs.readdirSync;
  t.mock.method(fs, 'readdirSync', (path, ...args) => {
    if (path === `${lockPath}.waiters`) queueScans++;
    return readdir(path, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const contender = withJsonOwnerFileLock(async () => assert.fail('live owner must exclude contender'), {
    lockPath, pollIntervalMs: 125, signal: controller.signal, onWait() { waits++; },
  });
  const outcome = contender.catch(error => error.name);
  const initialQueueScans = queueScans;
  try {
    for (let i = 0; i < 8; i++) {
      await delay(50);
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, createdAtMs, updatedAtMs: Date.now() }));
    }
    assert.equal(waits, 1, 'healthy contention must not wake for heartbeat writes or the old 250ms poll');
    assert.equal(queueScans, initialQueueScans, 'heartbeat-only events must not rescan tickets or queued PIDs');
  } finally {
    controller.abort();
    assert.equal(await outcome, 'AbortError');
    unlinkSync(lockPath);
  }
});

test('exclusive owner death without a file event is recovered through catch-up', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-json-owner-death-events-' });
  const lockPath = fixture.path('owner.lock');
  const script = `import {withJsonOwnerFileLock} from ${JSON.stringify(new URL('./jsonOwnerFileLock.mjs', import.meta.url).href)};
    await withJsonOwnerFileLock(async()=>{process.stdout.write('held');process.stdin.resume();
      await new Promise(()=>{});}, {lockPath:process.argv[1]});`;
  const child = spawnTestProcess(process.execPath, ['--input-type=module', '--eval', script, lockPath], { stdio: ['pipe', 'pipe', 'inherit'] });
  const exited = new Promise(resolve => child.once('exit', resolve));
  let contender;
  try {
    await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); });
    const raw = await readFile(lockPath, 'utf8');
    let observed;
    const waiting = new Promise(resolve => { observed = resolve; });
    contender = withJsonOwnerFileLock(async () => 'recovered', { lockPath, watchFallbackMs: 100,
      timeoutMs: 2_000, onWait: observed });
    await waiting;
    child.kill('SIGKILL'); await exited;
    assert.equal(await readFile(lockPath, 'utf8'), raw, 'death left the held file intact');
    assert.equal(await contender, 'recovered');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    await contender;
  }
});

test('an unreaped process cannot retain exclusive JSON lock ownership', {
  skip: process.platform !== 'linux', timeout: 10000,
}, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-json-owner-zombie-' });
  const lockPath = fixture.path('owner.lock');
  const releasePath = fixture.path('release-parent');
  const ownerScript = `import {withJsonOwnerFileLock} from ${JSON.stringify(new URL('./jsonOwnerFileLock.mjs', import.meta.url).href)};
    process.stdin.once('data',()=>process.exit(0));
    await withJsonOwnerFileLock(async()=>{process.stdout.write('held');await new Promise(()=>{});},
      {lockPath:process.argv[1]});`;
  // Block only this fixture parent's event loop until released. Its child can
  // exit, but libuv cannot reap it yet: signal 0 still succeeds for the zombie.
  const parentScript = `import {spawn} from 'node:child_process'; import {existsSync} from 'node:fs';
    const child=spawn(process.execPath,['--input-type=module','-e',${JSON.stringify(ownerScript)},process.argv[1]],
      {stdio:['pipe','pipe','inherit']});
    child.stdout.once('data',()=>{process.stdout.write(String(child.pid)+'\\n');child.stdin.end('exit');
      const state=new Int32Array(new SharedArrayBuffer(4));
      while(!existsSync(process.argv[2]))Atomics.wait(state,0,0,10);
    });`;
  const parent = spawnTestProcess(process.execPath, ['--input-type=module', '-e', parentScript,
    lockPath, releasePath], { stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = new Promise(resolve => parent.once('close', resolve));
  try {
    const [chunk] = await once(parent.stdout, 'data', { signal: t.signal });
    const pid = Number(String(chunk).trim());
    while (true) {
      t.signal.throwIfAborted();
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      if (stat.slice(stat.lastIndexOf(') ') + 2).startsWith('Z ')) break;
      await delay(5, undefined, { signal: t.signal });
    }
    assert.doesNotThrow(() => process.kill(pid, 0), 'the real OS signal probe still sees this departed PID');
    assert.equal(await withJsonOwnerFileLock(async () => 'recovered', {
      lockPath, wait: false,
    }), 'recovered');
    await assert.rejects(readFile(lockPath), { code: 'ENOENT' });
  } finally {
    await writeFile(releasePath, 'release');
    assert.equal(await exited, 0, 'the fixture parent must resume and reap its departed child');
  }
});

test('describeJsonOwnerLockOwner distinguishes total hold time from heartbeat freshness', () => {
  assert.equal(
    describeJsonOwnerLockOwner({ pid: 42, createdAtMs: 1_000, updatedAtMs: 9_000 }, 10_000),
    'pid=42 heldMs=9000 heartbeatAgeMs=1000',
  );
});

test('withJsonOwnerFileLock reclaims a stale malformed owner using the file mtime fallback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-json-owner-lock-malformed-'));
  const lockPath = join(root, 'owner.lock');

  try {
    await writeFile(lockPath, '{not json', 'utf8');
    const staleTime = new Date(Date.now() - 60_000);
    await utimes(lockPath, staleTime, staleTime);

    const result = await withJsonOwnerFileLock(
      async () => {
        const owner = JSON.parse(await readFile(lockPath, 'utf8'));
        assert.equal(owner.pid, process.pid);
        return 'ok';
      },
      {
        lockPath,
        timeoutMs: 200,
        pollIntervalMs: 10,
        staleAfterMs: 10,
      },
    );

    assert.equal(result, 'ok');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('withJsonOwnerFileLock can narrowly reclaim a stale heartbeat from a reused live pid', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-json-owner-lock-reused-live-pid-'));
  const lockPath = join(root, 'owner.lock');
  try {
    await writeFile(lockPath, JSON.stringify({
      pid: process.pid,
      createdAtMs: Date.now() - 60_000,
      updatedAtMs: Date.now() - 60_000,
    }), 'utf8');
    const result = await withJsonOwnerFileLock(async () => 'reclaimed', {
      lockPath,
      timeoutMs: 200,
      pollIntervalMs: 10,
      staleAfterMs: 10,
      allowLiveOwnerStaleReclaim: true,
    });
    assert.equal(result, 'reclaimed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('live-owner stale reclaim preserves an actively heartbeating owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-json-owner-lock-active-heartbeat-'));
  const lockPath = join(root, 'owner.lock');
  let active = false;
  let releaseHolder;
  let holder;
  let contender;
  try {
    const holderReleased = new Promise((resolve) => { releaseHolder = resolve; });
    let holderEnteredResolve;
    const holderEntered = new Promise((resolve) => { holderEnteredResolve = resolve; });
    holder = withJsonOwnerFileLock(async () => {
      active = true;
      holderEnteredResolve();
      await holderReleased;
      active = false;
    }, { lockPath, timeoutMs: 3_000, pollIntervalMs: 20, staleAfterMs: 800, allowLiveOwnerStaleReclaim: true });
    await holderEntered;

    const initialOwner = JSON.parse(await readFile(lockPath, 'utf8'));
    const firstHeartbeat = initialOwner.updatedAtMs;
    const heartbeatDeadline = Date.now() + 2_000;
    let observedHeartbeat = false;
    while (Date.now() < heartbeatDeadline) {
      const owner = JSON.parse(await readFile(lockPath, 'utf8'));
      if (owner.updatedAtMs > firstHeartbeat) {
        assert.equal(owner.createdAtMs, initialOwner.createdAtMs, 'heartbeat must preserve the acquisition time');
        observedHeartbeat = true;
        break;
      }
      await delay(10);
    }
    assert.equal(observedHeartbeat, true, 'expected to observe a holder heartbeat before contention');

    let contenderWaitResolve;
    const contenderWait = new Promise((resolve) => { contenderWaitResolve = resolve; });
    contender = withJsonOwnerFileLock(async ({ waited }) => {
      assert.equal(waited, true);
      assert.equal(active, false);
    }, {
      lockPath,
      timeoutMs: 3_000,
      pollIntervalMs: 20,
      staleAfterMs: 800,
      allowLiveOwnerStaleReclaim: true,
      onWait: contenderWaitResolve,
    });
    await Promise.race([
      contenderWait,
      delay(2_000).then(() => { throw new Error('contender did not observe the active owner'); }),
    ]);
    assert.equal(active, true);
    releaseHolder();
    await Promise.all([holder, contender]);
  } finally {
    releaseHolder?.();
    await Promise.allSettled([holder, contender].filter(Boolean));
    await rm(root, { recursive: true, force: true });
  }
});

test('a cancelled contender stops waiting without disturbing the active owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-json-owner-lock-abort-'));
  const lockPath = join(root, 'owner.lock');
  const controller = new AbortController();
  let releaseHolder;
  const held = new Promise((resolve) => { releaseHolder = resolve; });
  let enteredHolder;
  const entered = new Promise((resolve) => { enteredHolder = resolve; });
  const holder = withJsonOwnerFileLock(async () => { enteredHolder(); await held; }, { lockPath });
  let contender;
  try {
    await entered;
    const originalOwner = await readFile(lockPath, 'utf8');
    contender = withJsonOwnerFileLock(async () => { throw new Error('cancelled contender acquired lock'); }, {
      lockPath,
      signal: controller.signal,
      onWait: () => controller.abort(),
    });
    const outcome = await Promise.race([
      contender.then(() => 'acquired', (error) => error?.name),
      delay(500).then(() => 'still_waiting'),
    ]);
    assert.equal(outcome, 'AbortError');
    assert.equal(await readFile(lockPath, 'utf8'), originalOwner);
  } finally {
    releaseHolder();
    await Promise.allSettled([holder, contender].filter(Boolean));
    await rm(root, { recursive: true, force: true });
  }
});
