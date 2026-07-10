import { describe, expect, it, vi } from 'vitest';

import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';

import { createSpawnNewSessionLifecycleActionHandler } from './createSpawnNewSessionLifecycleActionHandler';

describe('createSpawnNewSessionLifecycleActionHandler', () => {
  it('derives a stable fresh-spawn nonce from the caller session id when none is provided', async () => {
    const spawnSession = vi.fn(async (_options: SpawnSessionOptions) => ({
      type: 'success',
      sessionId: 'session-1',
    } as const));
    const handler = createSpawnNewSessionLifecycleActionHandler({ spawnSession });
    const input = {
      directory: '/tmp/project',
      sessionId: 'pending-session-1',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
    } as const;

    await handler(input);
    await handler(input);

    const firstSpawnNonce = spawnSession.mock.calls[0]?.[0].spawnNonce;
    const secondSpawnNonce = spawnSession.mock.calls[1]?.[0].spawnNonce;
    expect(firstSpawnNonce).toEqual(expect.any(String));
    expect(firstSpawnNonce).toBe(secondSpawnNonce);
  });

  it('propagates canonical backendMode over stale codexBackendMode to spawn options', async () => {
    const spawnSession = vi.fn(async (_options: SpawnSessionOptions) => ({
      type: 'success',
      sessionId: 'session-1',
    } as const));
    const handler = createSpawnNewSessionLifecycleActionHandler({ spawnSession });

    const result = await handler({
      directory: '/tmp/project',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      backendMode: 'appServer',
      codexBackendMode: 'acp',
    });

    expect(result).toEqual({ type: 'success', sessionId: 'session-1' });
    const spawnOptions = spawnSession.mock.calls[0]?.[0];
    expect(spawnOptions?.backendMode).toBe('appServer');
    expect(spawnOptions?.codexBackendMode).toBe('appServer');
  });
});
