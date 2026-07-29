import { describe, expect, it, vi } from 'vitest';

import { abandonSpawnedSessionUntilCompleted } from './awaitSpawnedSessionId';

describe('abandonSpawnedSessionUntilCompleted', () => {
  it('reports completed only after positive canonical cleanup', async () => {
    const archiveSession = vi.fn(async () => true);
    await expect(abandonSpawnedSessionUntilCompleted({
      spawnNonce: 'nonce-a',
      resolveSpawnSessionByNonce: async () => ({ status: 'success', sessionId: 'session-a' }),
      archiveSession,
    })).resolves.toEqual({ status: 'completed', sessionId: 'session-a' });
    expect(archiveSession).toHaveBeenCalledWith('session-a');
  });

  it.each(['pending', 'not_found', 'unsupported'] as const)(
    'retains custody without cleanup when resolution is %s',
    async (status) => {
      const archiveSession = vi.fn(async () => true);
      await expect(abandonSpawnedSessionUntilCompleted({
        spawnNonce: 'nonce-a',
        resolveSpawnSessionByNonce: async () => ({ status }),
        archiveSession,
      })).resolves.toEqual({ status });
      expect(archiveSession).not.toHaveBeenCalled();
    },
  );

  it('keeps failed cleanup non-completed', async () => {
    await expect(abandonSpawnedSessionUntilCompleted({
      spawnNonce: 'nonce-a',
      resolveSpawnSessionByNonce: async () => ({ status: 'success', sessionId: 'session-a' }),
      archiveSession: async () => false,
    })).resolves.toEqual({ status: 'failed' });
  });
});
