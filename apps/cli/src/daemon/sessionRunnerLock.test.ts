import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { acquireSessionRunnerLock, releaseSessionRunnerLock, sessionRunnerLockPathForSessionId } from './sessionRunnerLock';

describe('sessionRunnerLock', () => {
  it('acquires and releases a new lock', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-session-runner-lock-'));

    const res = await acquireSessionRunnerLock({
      happyHomeDir,
      sessionId: 'sess_1',
      pid: 123,
      nowMs: 10_000,
      getCurrentProcessCommandHash: async () => 'a'.repeat(64),
      isPidAlive: () => true,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const lockPath = sessionRunnerLockPathForSessionId({ happyHomeDir, sessionId: 'sess_1' });
    expect(lockPath).not.toBeNull();
    if (!lockPath) return;

    const raw = await readFile(lockPath, 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed).toEqual(
      expect.objectContaining({
        sessionId: 'sess_1',
        pid: 123,
        acquiredAtMs: 10_000,
        processCommandHash: 'a'.repeat(64),
      }),
    );

    await res.release();
    await expect(readFile(lockPath, 'utf8')).rejects.toThrow();
  });

  it('uses a hashed lock filename when sessionId is too long', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-session-runner-lock-'));

    const old = process.env.HAPPIER_SESSION_RUNNER_LOCK_MAX_BASENAME_CHARS;
    process.env.HAPPIER_SESSION_RUNNER_LOCK_MAX_BASENAME_CHARS = '10';
    try {
      const sessionId = 'sess_' + 'a'.repeat(100);
      const lockPath = sessionRunnerLockPathForSessionId({ happyHomeDir, sessionId });
      expect(lockPath).not.toBeNull();
      if (!lockPath) return;
      expect(basename(lockPath)).toMatch(/^sha-[a-f0-9]{64}\.json$/);
    } finally {
      if (old === undefined) {
        delete process.env.HAPPIER_SESSION_RUNNER_LOCK_MAX_BASENAME_CHARS;
      } else {
        process.env.HAPPIER_SESSION_RUNNER_LOCK_MAX_BASENAME_CHARS = old;
      }
    }
  });

  it('denies acquisition when a live safe pid holds the lock', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-session-runner-lock-'));
    const lockPath = sessionRunnerLockPathForSessionId({ happyHomeDir, sessionId: 'sess_2' });
    expect(lockPath).not.toBeNull();
    if (!lockPath) return;

    await mkdir(dirname(lockPath), { recursive: true });
    await writeFile(
      lockPath,
      JSON.stringify({ sessionId: 'sess_2', pid: 999, acquiredAtMs: 1, processCommandHash: 'a'.repeat(64) }, null, 2),
      'utf8',
    );

    const res = await acquireSessionRunnerLock({
      happyHomeDir,
      sessionId: 'sess_2',
      pid: 123,
      nowMs: 10_000,
      getCurrentProcessCommandHash: async (pid) => (pid === 999 ? 'a'.repeat(64) : 'b'.repeat(64)),
      isPidAlive: () => true,
    });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('already_running');
    if (res.reason !== 'already_running') {
      throw new Error(`Expected already_running, got ${res.reason}`);
    }
    expect(res.heldByPid).toBe(999);

    // Lock file should remain.
    const raw = await readFile(lockPath, 'utf8');
    expect(JSON.parse(raw).pid).toBe(999);
  });

  it('breaks a stale lock when pid is not alive', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-session-runner-lock-'));
    const lockPath = sessionRunnerLockPathForSessionId({ happyHomeDir, sessionId: 'sess_3' });
    expect(lockPath).not.toBeNull();
    if (!lockPath) return;

    await mkdir(dirname(lockPath), { recursive: true });
    await writeFile(
      lockPath,
      JSON.stringify({ sessionId: 'sess_3', pid: 999, acquiredAtMs: 1, processCommandHash: 'a'.repeat(64) }, null, 2),
      'utf8',
    );

    const res = await acquireSessionRunnerLock({
      happyHomeDir,
      sessionId: 'sess_3',
      pid: 123,
      nowMs: 10_000,
      getCurrentProcessCommandHash: async () => 'b'.repeat(64),
      isPidAlive: () => false,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const raw = await readFile(lockPath, 'utf8');
    expect(JSON.parse(raw).pid).toBe(123);
  });

  it('breaks a lock held by a live pid when command hash mismatch can be confirmed', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-session-runner-lock-'));
    const lockPath = sessionRunnerLockPathForSessionId({ happyHomeDir, sessionId: 'sess_5' });
    expect(lockPath).not.toBeNull();
    if (!lockPath) return;

    await mkdir(dirname(lockPath), { recursive: true });
    await writeFile(
      lockPath,
      JSON.stringify({ sessionId: 'sess_5', pid: 999, acquiredAtMs: 1, processCommandHash: 'a'.repeat(64) }, null, 2),
      'utf8',
    );

    const res = await acquireSessionRunnerLock({
      happyHomeDir,
      sessionId: 'sess_5',
      pid: 123,
      nowMs: 10_000,
      getCurrentProcessCommandHash: async (pid) => (pid === 999 ? 'c'.repeat(64) : 'b'.repeat(64)),
      isPidAlive: () => true,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const raw = await readFile(lockPath, 'utf8');
    expect(JSON.parse(raw).pid).toBe(123);
  });

  it('does not break a lock held by a live pid when command hash cannot be inspected', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-session-runner-lock-'));
    const lockPath = sessionRunnerLockPathForSessionId({ happyHomeDir, sessionId: 'sess_6' });
    expect(lockPath).not.toBeNull();
    if (!lockPath) return;

    await mkdir(dirname(lockPath), { recursive: true });
    await writeFile(
      lockPath,
      JSON.stringify({ sessionId: 'sess_6', pid: 999, acquiredAtMs: 1, processCommandHash: 'a'.repeat(64) }, null, 2),
      'utf8',
    );

    const res = await acquireSessionRunnerLock({
      happyHomeDir,
      sessionId: 'sess_6',
      pid: 123,
      nowMs: 10_000,
      getCurrentProcessCommandHash: async (pid) => (pid === 999 ? null : 'b'.repeat(64)),
      isPidAlive: () => true,
    });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('already_running');

    const raw = await readFile(lockPath, 'utf8');
    expect(JSON.parse(raw).pid).toBe(999);
  });

  it('denies acquisition when a live pid holds a lock file with a mismatched sessionId payload', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-session-runner-lock-'));
    const lockPath = sessionRunnerLockPathForSessionId({ happyHomeDir, sessionId: 'sess_7' });
    expect(lockPath).not.toBeNull();
    if (!lockPath) return;

    await mkdir(dirname(lockPath), { recursive: true });
    await writeFile(lockPath, JSON.stringify({ sessionId: 'other', pid: 999, acquiredAtMs: 1 }, null, 2), 'utf8');

    const res = await acquireSessionRunnerLock({
      happyHomeDir,
      sessionId: 'sess_7',
      pid: 123,
      nowMs: 10_000,
      getCurrentProcessCommandHash: async () => 'b'.repeat(64),
      isPidAlive: () => true,
    });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('already_running');
    if (res.reason !== 'already_running') {
      throw new Error(`Expected already_running, got ${res.reason}`);
    }
    expect(res.heldByPid).toBe(999);

    const raw = await readFile(lockPath, 'utf8');
    expect(JSON.parse(raw).pid).toBe(999);
  });

  it('does not delete a lock on release if another pid owns it', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-session-runner-lock-'));
    const lockPath = sessionRunnerLockPathForSessionId({ happyHomeDir, sessionId: 'sess_4' });
    expect(lockPath).not.toBeNull();
    if (!lockPath) return;

    await mkdir(dirname(lockPath), { recursive: true });
    await writeFile(lockPath, JSON.stringify({ sessionId: 'sess_4', pid: 999, acquiredAtMs: 1 }, null, 2), 'utf8');

    const released = await releaseSessionRunnerLock({
      happyHomeDir,
      sessionId: 'sess_4',
      pid: 123,
      acquiredAtMs: 10_000,
    });
    expect(released.ok).toBe(false);
    if (released.ok) return;
    expect(released.reason).toBe('not_owner');
  });
});
