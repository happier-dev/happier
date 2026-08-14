import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { describeJsonOwnerLockOwner, withJsonOwnerFileLock } from './jsonOwnerFileLock.mjs';

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
