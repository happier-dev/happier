import { describe, expect, it, vi } from 'vitest';

import { createSpawnRequestCoalescer, computeDaemonSpawnRequestKey } from './spawnRequestCoalescer';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';

describe('computeDaemonSpawnRequestKey', () => {
  it('is stable for equivalent inputs with different object key order', () => {
    const a = computeDaemonSpawnRequestKey({
      directory: '/tmp/repo',
      agent: 'claude',
      environmentVariables: { B: '2', A: '1' },
      connectedServices: { z: 1, a: 2 },
    } satisfies SpawnSessionOptions);
    const b = computeDaemonSpawnRequestKey({
      agent: 'claude',
      directory: '/tmp/repo',
      environmentVariables: { A: '1', B: '2' },
      connectedServices: { a: 2, z: 1 },
    } satisfies SpawnSessionOptions);
    expect(a.kind).toBe('new');
    expect(b.kind).toBe('new');
    expect(a.key).toBe(b.key);
  });

  it('incorporates spawnNonce when provided', () => {
    const a = computeDaemonSpawnRequestKey({
      directory: '/tmp/repo',
      agent: 'claude',
      spawnNonce: 'nonce-a',
    } satisfies SpawnSessionOptions);
    const b = computeDaemonSpawnRequestKey({
      directory: '/tmp/repo',
      agent: 'claude',
      spawnNonce: 'nonce-b',
    } satisfies SpawnSessionOptions);
    expect(a.kind).toBe('new');
    expect(b.kind).toBe('new');
    expect(a.key).not.toBe(b.key);
  });

  it('keys existing-session spawns by session id', () => {
    const k = computeDaemonSpawnRequestKey({
      directory: '/tmp',
      existingSessionId: '  sess_1 ',
    } satisfies SpawnSessionOptions);
    expect(k).toEqual({ kind: 'existing', key: 'existing:sess_1' });
  });

  it('does not include updatedAt timestamps in the new-session key', () => {
    const a = computeDaemonSpawnRequestKey({
      directory: '/tmp/repo',
      agent: 'claude',
      permissionMode: 'read-only',
      permissionModeUpdatedAt: 111,
      modelId: 'gpt-5',
      modelUpdatedAt: 111,
    } satisfies SpawnSessionOptions);
    const b = computeDaemonSpawnRequestKey({
      directory: '/tmp/repo',
      agent: 'claude',
      permissionMode: 'read-only',
      permissionModeUpdatedAt: 222,
      modelId: 'gpt-5',
      modelUpdatedAt: 222,
    } satisfies SpawnSessionOptions);
    expect(a.kind).toBe('new');
    expect(b.kind).toBe('new');
    expect(a.key).toBe(b.key);
  });
});

describe('createSpawnRequestCoalescer', () => {
  it('coalesces concurrent calls for the same key and caches recent new-session success', async () => {
    let now = 10_000;
    const nowMs = () => now;
    const coalescer = createSpawnRequestCoalescer({ nowMs, recentSuccessTtlMs: 2_000 });

    const work = vi.fn(async () => ({ type: 'success' as const, sessionId: 'sess_new' }));
    const key = { kind: 'new' as const, key: 'new:abc' };

    const [r1, r2] = await Promise.all([coalescer.run(key, work), coalescer.run(key, work)]);
    expect(work).toHaveBeenCalledTimes(1);
    expect(r1).toEqual({ type: 'success', sessionId: 'sess_new' });
    expect(r2).toEqual({ type: 'success', sessionId: 'sess_new' });

    now += 500;
    const r3 = await coalescer.run(key, work);
    expect(work).toHaveBeenCalledTimes(1);
    expect(r3).toEqual({ type: 'success', sessionId: 'sess_new' });

    now += 5_000;
    const r4 = await coalescer.run(key, work);
    expect(work).toHaveBeenCalledTimes(2);
    expect(r4).toEqual({ type: 'success', sessionId: 'sess_new' });
  });
});
