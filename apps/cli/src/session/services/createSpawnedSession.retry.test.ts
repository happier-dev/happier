import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Credentials } from '@/persistence';
import { SPAWN_SESSION_ERROR_CODES } from '@/rpc/handlers/registerSessionHandlers';

const spawnDaemonSession = vi.hoisted(() => vi.fn());
const resolveDaemonSpawnSessionByNonce = vi.hoisted(() => vi.fn());
const fetchSessionById = vi.hoisted(() => vi.fn());

vi.mock('@/daemon/controlClient', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/daemon/controlClient')>(),
  spawnDaemonSession,
  resolveDaemonSpawnSessionByNonce,
}));

vi.mock('@/session/transport/http/sessionsHttp', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/session/transport/http/sessionsHttp')>(),
  fetchSessionById,
}));

import {
  createSpawnedSession,
  type CreateSpawnedSessionParams,
} from './createSpawnedSession';

describe('createSpawnedSession retry custody', () => {
  const credentials: Credentials = {
    token: 'token',
    encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
  };

  beforeEach(() => {
    spawnDaemonSession.mockReset();
    resolveDaemonSpawnSessionByNonce.mockReset();
    fetchSessionById.mockReset();
  });

  it('resumes a caller-owned ambiguous nonce without sending a second spawn', async () => {
    spawnDaemonSession.mockResolvedValue({
      success: true,
      status: 'pending',
      sessionIdStatus: 'pending',
    });
    resolveDaemonSpawnSessionByNonce
      .mockResolvedValueOnce({ status: 'unsupported' })
      .mockResolvedValueOnce({ status: 'success', sessionId: 'session-from-original-attempt' });
    fetchSessionById.mockResolvedValue({
      id: 'session-from-original-attempt',
      createdAt: 1,
      updatedAt: 1,
      active: true,
      activeAt: 1,
      pendingCount: 0,
      metadataVersion: 1,
      metadata: { path: '/repo', host: 'host' },
    });

    const stableAttempt = {
      credentials,
      directory: '/repo',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      spawnNonce: 'action-request:session-1:tool-call-1',
    } satisfies CreateSpawnedSessionParams & Readonly<{ spawnNonce: string }>;

    await expect(createSpawnedSession(stableAttempt)).rejects.toMatchObject({
      code: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
    });
    const recovered = await createSpawnedSession({
      ...stableAttempt,
      resumeOnly: true,
    } as CreateSpawnedSessionParams & Readonly<{ resumeOnly: true }>);

    expect(recovered.sessionId).toBe('session-from-original-attempt');
    expect(spawnDaemonSession).toHaveBeenCalledTimes(1);
    expect(spawnDaemonSession).toHaveBeenCalledWith(expect.objectContaining({
      spawnNonce: stableAttempt.spawnNonce,
    }));
    expect(resolveDaemonSpawnSessionByNonce).toHaveBeenNthCalledWith(
      1,
      stableAttempt.spawnNonce,
      expect.any(Number),
    );
    expect(resolveDaemonSpawnSessionByNonce).toHaveBeenNthCalledWith(
      2,
      stableAttempt.spawnNonce,
      expect.any(Number),
    );
  });
});
