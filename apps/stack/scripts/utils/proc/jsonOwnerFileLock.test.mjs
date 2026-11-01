import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { unlinkSync, writeFileSync } from 'node:fs';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { describeJsonOwnerLockOwner, readJsonOwnerLockSnapshot, withJsonOwnerFileLock } from './jsonOwnerFileLock.mjs';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { spawnTestProcess } from '../../testkit/core/spawn_test_process.mjs';
import { createWorkspaceBuildWaitNotifier } from './workspaceBuildWaitNotifier.mjs';

test('wait diagnostics report live lock holders from the acquisition snapshot', async (t) => {
  for (const kind of ['reader', 'writer']) await t.test(kind, async (t) => {
    const fixture = await createTempFixture(t, { prefix: 'json-owner-live-holders-' });
    const lockPath = fixture.path('owner.lock');
    const secondReader = kind === 'reader'
      ? spawnTestProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
      : null;
    if (secondReader) {
      t.after(async () => {
        if (secondReader.exitCode !== null || secondReader.signalCode !== null) return;
        const exited = once(secondReader, 'exit');
        secondReader.kill();
        await exited;
      });
      await once(secondReader, 'spawn');
    }
    const nowMs = Date.now();
    const liveOwner = { pid: process.pid, createdAtMs: nowMs - 9000, updatedAtMs: nowMs - 1000 };
    const deadOwner = { pid: 99999999, createdAtMs: nowMs - 30000, updatedAtMs: nowMs - 30000 };
    const liveReaders = [liveOwner, {
      pid: secondReader?.pid, createdAtMs: nowMs - 7000, updatedAtMs: nowMs - 500,
    }];
    await writeFile(lockPath, JSON.stringify(kind === 'reader'
      ? { ...deadOwner, priority: 'reader', readers: [deadOwner, ...liveReaders] }
      : { ...liveOwner, priority: 'writer' }));
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
      lockPath, sharedReaders: true, priority: 'writer', signal: cancellation.signal,
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
    assert.ok(Array.isArray(observed.holders), 'the wait event must identify live holders');
    assert.deepEqual(observed.holders.map(({ pid, kind, heldMs, heartbeatAgeMs }) => ({ pid, kind, heldMs, heartbeatAgeMs })), [
      { pid: process.pid, kind, heldMs: 9000, heartbeatAgeMs: 1000 },
      ...(secondReader ? [{ pid: secondReader.pid, kind, heldMs: 7000, heartbeatAgeMs: 500 }] : []),
    ]);
    assert.equal(observed.owner.pid, process.pid);
    assert.match(notices, new RegExp(`${kind} pid=${process.pid}.*heldMs=9000.*heartbeatAgeMs=1000`));
    if (secondReader) assert.match(notices, new RegExp(`reader pid=${secondReader.pid}.*heldMs=7000.*heartbeatAgeMs=500`));
    assert.doesNotMatch(notices, /99999999/);
  });
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

test('queued-owner heartbeats and unrelated files do not rescan the waiter population', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-json-owner-queue-noise-' });
  const lockPath = fixture.path('owner.lock');
  const waitersDir = `${lockPath}.waiters`;
  await mkdir(waitersDir);
  const owner = { pid: process.pid, createdAtMs: Date.now(), updatedAtMs: Date.now() };
  await writeFile(lockPath, JSON.stringify(owner));
  const tickets = ['1.json', '2.json', '3.json'].map(name => join(waitersDir, name));
  for (const path of tickets) await writeFile(path, JSON.stringify({ ...owner, priority: 'writer' }));
  let reads = 0;
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (path, ...args) => {
    if (typeof path === 'string' && dirname(path) === waitersDir) reads += 1;
    return read(path, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const cancellation = new AbortController();
  let notify;
  const waiting = new Promise(resolve => { notify = resolve; });
  const contender = withJsonOwnerFileLock(() => assert.fail('live owner excludes contender'), {
    lockPath, sharedReaders: true, priority: 'writer', signal: cancellation.signal,
    watchFallbackMs: 10_000, onWait: notify,
  }).catch(error => error.name);
  try {
    await waiting;
    await delay(20);
    const before = reads;
    for (const path of tickets) {
      const pending = `${path}.pending-fixture`;
      await writeFile(pending, JSON.stringify({ ...owner, priority: 'writer', updatedAtMs: Date.now() + 1 }));
      await rename(pending, path);
      await writeFile(fixture.path('unrelated.log'), 'another lane wrote output');
      await delay(20);
    }
    assert.equal(reads, before, 'heartbeat replacement and unrelated logs do not change queue eligibility');
  } finally {
    cancellation.abort();
    assert.equal(await contender, 'AbortError');
  }
});

test('a free lock blocked by a queued writer reports that writer instead of an unknown holder', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-json-owner-queued-diagnostic-' });
  const lockPath = fixture.path('owner.lock');
  await mkdir(`${lockPath}.waiters`);
  await writeFile(join(`${lockPath}.waiters`, '1.json'), JSON.stringify({
    pid: process.pid, priority: 'writer', createdAtMs: Date.now(), updatedAtMs: Date.now(),
  }));
  let notices = '';
  t.mock.method(process.stderr, 'write', chunk => { notices += String(chunk); return true; });
  const notice = createWorkspaceBuildWaitNotifier({
    label: 'dependency refresh', kind: 'lock', env: { HAPPIER_WORKSPACE_BUILD_NOTICE_AFTER_MS: '0' },
  });
  const cancellation = new AbortController();
  await assert.rejects(withJsonOwnerFileLock(() => assert.fail('reader overtook the queued writer'), {
    lockPath, sharedReaders: true, priority: 'reader', signal: cancellation.signal,
    onWait(event) { notice(event); cancellation.abort(); },
  }), { name: 'AbortError' });
  assert.match(notices, new RegExp(`queued.*pid=${process.pid}.*heldMs=.*heartbeatAgeMs=`));
  assert.doesNotMatch(notices, /owner=unknown/);
});

test('writer re-entry reuses its live process ticket without losing queue position', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-json-writer-reentry-' });
  const lockPath = fixture.path('owner.lock');
  const waitersDir = `${lockPath}.waiters`;
  await mkdir(waitersDir);
  const original = { pid: process.pid, priority: 'writer', createdAtMs: Date.now() - 1000, updatedAtMs: Date.now() };
  const ticketPath = join(waitersDir, '1.json');
  await writeFile(ticketPath, JSON.stringify(original));
  const holderRaw = JSON.stringify({ pid: process.pid, createdAtMs: Date.now(), updatedAtMs: Date.now() });
  await writeFile(lockPath, holderRaw);
  let notify;
  const waiting = new Promise(resolve => { notify = resolve; });
  const cancellation = new AbortController();
  const writer = withJsonOwnerFileLock(() => assert.fail('writer entered the held lock'), {
    lockPath, priority: 'writer', sharedReaders: true, signal: cancellation.signal, onWait: notify,
  });
  const outcome = writer.catch(error => error.name);
  try {
    await waiting;
    assert.deepEqual(await readdir(waitersDir), ['1.json'], 're-entry must adopt its original ticket, not append a new one');
    assert.equal(JSON.parse(await readFile(ticketPath, 'utf8')).createdAtMs, original.createdAtMs);
  } finally {
    cancellation.abort();
    assert.equal(await outcome, 'AbortError');
  }
  assert.deepEqual(await readdir(waitersDir), [], 'cancellation removes the retained ticket');
  assert.equal(await readFile(lockPath, 'utf8'), holderRaw);
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
  const contender = withJsonOwnerFileLock(async () => assert.fail('live owner must exclude contender'), {
    lockPath, pollIntervalMs: 125, signal: controller.signal, onWait() { waits++; },
  });
  const outcome = contender.catch(error => error.name);
  try {
    for (let i = 0; i < 8; i++) {
      await delay(50);
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, createdAtMs, updatedAtMs: Date.now() }));
    }
    assert.equal(waits, 1, 'healthy contention must not wake for heartbeat writes or the old 250ms poll');
  } finally {
    controller.abort();
    assert.equal(await outcome, 'AbortError');
    unlinkSync(lockPath);
  }
});

test('waiters acquire in arrival order even with different catch-up intervals', async t => {
  const fixture = await createTempFixture(t, {prefix:'hstack-json-owner-fifo-'});
  const lockPath = fixture.path('owner.lock');
  const order = [];
  const tasks = [];
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let entered;
  const entry = new Promise(resolve => { entered = resolve; });
  tasks.push(withJsonOwnerFileLock(async () => { entered(); await held; }, {lockPath}));
  try {
    await entry;
    for (const [name, pollIntervalMs] of [['first', 300], ['second', 5], ['third', 5]]) {
      let observed;
      const waiting = new Promise(resolve => { observed = resolve; });
      tasks.push(withJsonOwnerFileLock(async ({waited}) => {
        assert.equal(waited, true);
        order.push(name);
      }, {lockPath, timeoutMs:3000, watchFallbackMs:pollIntervalMs, onWait:observed}));
      await waiting;
    }
    release();
    await Promise.all(tasks);
    assert.deepEqual(order, ['first', 'second', 'third']);
  } finally {
    release();
    await Promise.allSettled(tasks);
  }
});

test('a dead queued writer does not block new readers', async t => {
  const fixture = await createTempFixture(t, {prefix:'hstack-json-owner-dead-waiter-'});
  const lockPath = fixture.path('owner.lock');
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let entered;
  const entry = new Promise(resolve => { entered = resolve; });
  const holder = withJsonOwnerFileLock(async () => { entered(); await held; }, {lockPath, sharedReaders:true, priority:'reader'});
  await entry;
  const script = `import {withJsonOwnerFileLock} from ${JSON.stringify(new URL('./jsonOwnerFileLock.mjs', import.meta.url).href)};
    await withJsonOwnerFileLock(async()=>{}, {lockPath:process.argv[1], timeoutMs:Infinity, sharedReaders:true, priority:'writer',
      onWait:()=>{process.stdout.write('waiting');}});`;
  const child = spawnTestProcess(process.execPath, ['--input-type=module', '--eval', script, lockPath], {stdio:['ignore','pipe','inherit']});
  let later;
  try {
    await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); });
    const queued = await readdir(`${lockPath}.waiters`).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
    assert.equal(queued.length, 1, 'the waiting process must have joined the filesystem queue');
    await assert.rejects(withJsonOwnerFileLock(() => assert.fail('reader overtook live writer'), {
      lockPath, sharedReaders:true, priority:'reader', wait:false,
    }), { code:'EJSONOWNERFILELOCKBUSY' });
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill();
    await exited;
    later = withJsonOwnerFileLock(async () => 'acquired', {lockPath, timeoutMs:1000, sharedReaders:true, priority:'reader', wait:false});
    assert.equal(await later, 'acquired');
    release();
    await holder;
    assert.deepEqual(await readdir(`${lockPath}.waiters`), []);
  } finally {
    release();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill();
      await exited;
    }
    await Promise.allSettled([holder, later].filter(Boolean));
  }
});

test('shared reader death without a file event is recovered through catch-up', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-json-owner-death-events-' });
  const lockPath = fixture.path('owner.lock');
  const script = `import {withJsonOwnerFileLock} from ${JSON.stringify(new URL('./jsonOwnerFileLock.mjs', import.meta.url).href)};
    await withJsonOwnerFileLock(async()=>{process.stdout.write('held');process.stdin.resume();
      await new Promise(()=>{});}, {lockPath:process.argv[1], sharedReaders:true, priority:'reader'});`;
  const child = spawnTestProcess(process.execPath, ['--input-type=module', '--eval', script, lockPath], { stdio: ['pipe', 'pipe', 'inherit'] });
  const exited = new Promise(resolve => child.once('exit', resolve));
  let contender;
  try {
    await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); });
    const raw = await readFile(lockPath, 'utf8');
    let observed;
    const waiting = new Promise(resolve => { observed = resolve; });
    contender = withJsonOwnerFileLock(async () => 'recovered', { lockPath, watchFallbackMs: 100,
      timeoutMs: 2_000, onWait: observed, sharedReaders:true, priority:'writer' });
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

for (const priority of ['reader', 'writer']) test(`an unreaped ${priority} process cannot retain JSON lock ownership`, {
  skip: process.platform !== 'linux', timeout: 10000,
}, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-json-owner-zombie-' });
  const lockPath = fixture.path('owner.lock');
  const releasePath = fixture.path('release-parent');
  const ownerScript = `import {withJsonOwnerFileLock} from ${JSON.stringify(new URL('./jsonOwnerFileLock.mjs', import.meta.url).href)};
    process.stdin.once('data',()=>process.exit(0));
    await withJsonOwnerFileLock(async()=>{process.stdout.write('held');await new Promise(()=>{});},
      {lockPath:process.argv[1],sharedReaders:true,priority:process.argv[2]});`;
  // Block only this fixture parent's event loop until released. Its child can
  // exit, but libuv cannot reap it yet: signal 0 still succeeds for the zombie.
  const parentScript = `import {spawn} from 'node:child_process'; import {existsSync} from 'node:fs';
    const child=spawn(process.execPath,['--input-type=module','-e',${JSON.stringify(ownerScript)},process.argv[1],process.argv[3]],
      {stdio:['pipe','pipe','inherit']});
    child.stdout.once('data',()=>{process.stdout.write(String(child.pid)+'\\n');child.stdin.end('exit');
      const state=new Int32Array(new SharedArrayBuffer(4));
      while(!existsSync(process.argv[2]))Atomics.wait(state,0,0,10);
    });`;
  const parent = spawnTestProcess(process.execPath, ['--input-type=module', '-e', parentScript,
    lockPath, releasePath, priority], { stdio: ['ignore', 'pipe', 'inherit'] });
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
      lockPath, sharedReaders: true, priority: 'writer', wait: false,
    }), 'recovered');
    await assert.rejects(readFile(lockPath), { code: 'ENOENT' });
  } finally {
    await writeFile(releasePath, 'release');
    assert.equal(await exited, 0, 'the fixture parent must resume and reap its departed child');
  }
});

test('stale malformed queue heads use the existing mtime reclaim rule', async t => {
  const fixture = await createTempFixture(t, {prefix:'hstack-json-owner-stale-head-'});
  const lockPath = fixture.path('owner.lock');
  await mkdir(`${lockPath}.waiters`);
  const head = join(`${lockPath}.waiters`, '1.json');
  await writeFile(head, '{not json');
  const stale = new Date(Date.now() - 60_000);
  await utimes(head, stale, stale);
  assert.equal(await withJsonOwnerFileLock(async () => 'acquired', {
    lockPath, timeoutMs:1000, staleAfterMs:10, pollIntervalMs:5,
  }), 'acquired');
  assert.deepEqual(await readdir(`${lockPath}.waiters`), []);
});

test('a timed-out head leaves the queue and its successor can acquire', async t => {
  const fixture = await createTempFixture(t, {prefix:'hstack-json-owner-timeout-head-'});
  const lockPath = fixture.path('owner.lock');
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let entered;
  const entry = new Promise(resolve => { entered = resolve; });
  const holder = withJsonOwnerFileLock(async () => { entered(); await held; }, {lockPath});
  let next;
  try {
    await entry;
    await assert.rejects(withJsonOwnerFileLock(async () => assert.fail('head entered early'), {
      lockPath, timeoutMs:30, pollIntervalMs:5,
    }), /Timed out waiting/);
    assert.deepEqual(await readdir(`${lockPath}.waiters`), []);
    next = withJsonOwnerFileLock(async () => 'next', {lockPath, pollIntervalMs:5});
    release();
    assert.equal(await next, 'next');
  } finally {
    release();
    await Promise.allSettled([holder, next].filter(Boolean));
  }
});

test('legacy exclusive-create contenders can bypass the queue without deadlocking queued waiters', async t => {
  const fixture = await createTempFixture(t, {prefix:'hstack-json-owner-legacy-'});
  const lockPath = fixture.path('owner.lock');
  const legacyRaw = JSON.stringify({pid:process.pid, createdAtMs:Date.now(), updatedAtMs:Date.now()});
  // The preceding implementation's shared-file protocol: wx plus PID/heartbeat
  // JSON, with no knowledge of queue entries or the registration lock.
  writeFileSync(lockPath, legacyRaw, {flag:'wx'});
  const order = [];
  const tasks = [];
  try {
    for (const [name, pollIntervalMs] of [['first', 100], ['second', 5]]) {
      let observed;
      const waiting = new Promise(resolve => { observed = resolve; });
      tasks.push(withJsonOwnerFileLock(async () => order.push(name), {
        lockPath, timeoutMs:2000, pollIntervalMs, onWait:observed,
      }));
      await waiting;
    }
    unlinkSync(lockPath);
    writeFileSync(lockPath, legacyRaw, {flag:'wx'}); // An already loaded legacy waiter wins.
    await delay(20);
    assert.deepEqual(order, [], 'queued code must still exclude a legacy owner');
    unlinkSync(lockPath);
    await Promise.all(tasks);
    assert.deepEqual(order, ['first', 'second']);
  } finally {
    if (await readFile(lockPath, 'utf8').catch(() => null) === legacyRaw) unlinkSync(lockPath);
    await Promise.allSettled(tasks);
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
    assert.deepEqual(await readdir(`${lockPath}.waiters`), [], 'cancellation must remove its queue entry');
  } finally {
    releaseHolder();
    await Promise.allSettled([holder, contender].filter(Boolean));
    await rm(root, { recursive: true, force: true });
  }
});


test('a satisfied queued mutation leaves without entering the exclusive action', async t => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-json-satisfied-mutation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lockPath = join(root, 'mutation.lock');
  let release, entered;
  const held = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const holder = withJsonOwnerFileLock(async () => { entered(); await held; }, { lockPath });
  await started;
  let required = true, observed;
  const waiting = new Promise(resolve => { observed = resolve; });
  const queued = withJsonOwnerFileLock(() => assert.fail('satisfied mutation acquired exclusive action'), {
    lockPath, shouldAcquire: () => required, onWait: () => observed(),
  });
  await waiting;
  required = false;
  release();
  await Promise.all([holder, queued]);
  assert.equal(await withJsonOwnerFileLock(() => 'next', { lockPath }), 'next');
});
