import { afterEach, describe, expect, it, vi } from 'vitest';

describe('detectLatestSessionTurnActivity', () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('trusts a refreshed complete foreground projection over transcript task lifecycle rows', async () => {
    const fetchSessionById = vi.fn(async () => ({
      id: 'sess-1',
      latestTurnStatus: 'completed',
      pendingPermissionRequestCount: 0,
      pendingUserActionRequestCount: 0,
      runtimeActivityState: 'active',
      runtimeActivityActiveCount: 1,
      runtimeActivityObservedAt: 1_000,
      runtimeActivityRevision: 2,
    }));
    const fetchEncryptedTranscriptPageLatest = vi.fn(async () => [
      {
        id: 'm1',
        localId: null,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        content: {
          t: 'plain',
          v: {
            role: 'agent',
            content: {
              type: 'acp',
              agentId: 'claude',
              data: { type: 'task_started', id: 'background-task-1' },
            },
          },
        },
      },
    ]);
    const fetchEncryptedTranscriptPageAfterSeq = vi.fn(async () => []);

    vi.doMock('@/session/transport/http/sessionsHttp', () => ({
      fetchSessionById,
    }));
    vi.doMock('@/api/session/fetchEncryptedTranscriptWindow', () => ({
      fetchEncryptedTranscriptPageLatest,
      fetchEncryptedTranscriptPageAfterSeq,
    }));

    const { detectLatestSessionTurnActivity } = await import('./detectLatestSessionTurnActivity');

    await expect(detectLatestSessionTurnActivity({
      token: 'token',
      sessionId: 'sess-1',
      encryptionMode: 'plain',
      encryptionKey: new Uint8Array(32).fill(1),
      encryptionVariant: 'dataKey',
    })).resolves.toEqual({
      pendingUserTurns: 0,
      activeTaskInFlight: false,
      turnInFlight: false,
    });

    expect(fetchSessionById).toHaveBeenCalledWith({
      token: 'token',
      sessionId: 'sess-1',
    });
    expect(fetchEncryptedTranscriptPageLatest).not.toHaveBeenCalled();
    expect(fetchEncryptedTranscriptPageAfterSeq).not.toHaveBeenCalled();
  });
});
