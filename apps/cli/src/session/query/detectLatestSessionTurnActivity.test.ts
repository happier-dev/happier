import { afterEach, describe, expect, it, vi } from 'vitest';

describe('detectLatestSessionTurnActivity', () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.restoreAllMocks();
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

    const axios = (await import('axios')).default;
    const http = vi.spyOn(axios, 'get').mockImplementation(async () => ({ status: 200, data: {
      hasMore: false, messages: await fetchEncryptedTranscriptPageLatest(),
      activity: { pendingCount: 0, pendingBlockedCount: 0, pendingBlockedNoEffectCount: 0,
        ...await fetchSessionById() },
    } }));

    const { detectLatestSessionTurnActivity } = await import('./detectLatestSessionTurnActivity');

    await expect(detectLatestSessionTurnActivity({
      token: 'token',
      sessionId: 'sess-1',
      encryptionMode: 'plain',
      encryptionKey: new Uint8Array(32).fill(1),
      encryptionVariant: 'dataKey',
    })).resolves.toEqual({
      pendingUserTurns: 0,
      pendingInputCount: 0,
      activeTaskInFlight: false,
      turnInFlight: false,
    });

    const path = new URL(String(http.mock.calls[0][0]));
    expect(path.searchParams.get('scope')).toBe('main');
    expect(path.searchParams.get('projection')).toBe('activity');
  });

  it('keeps a refreshed durable pending input in flight before transcript materialization', async () => {
    const fetchSessionById = vi.fn(async () => ({
      id: 'sess-1',
      latestTurnStatus: null,
      pendingCount: 1,
    }));
    const fetchEncryptedTranscriptPageLatest = vi.fn(async () => []);
    const fetchEncryptedTranscriptPageAfterSeq = vi.fn(async () => []);

    const axios = (await import('axios')).default;
    const http = vi.spyOn(axios, 'get').mockImplementation(async () => ({ status: 200, data: {
      hasMore: false, messages: await fetchEncryptedTranscriptPageLatest(),
      activity: { pendingBlockedCount: 0, pendingBlockedNoEffectCount: 0,
        pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 0, ...await fetchSessionById() },
    } }));

    const { detectLatestSessionTurnActivity } = await import('./detectLatestSessionTurnActivity');

    await expect(detectLatestSessionTurnActivity({
      token: 'token',
      sessionId: 'sess-1',
      encryptionMode: 'plain',
      encryptionKey: new Uint8Array(32).fill(1),
      encryptionVariant: 'dataKey',
    })).resolves.toEqual({
      pendingUserTurns: 1,
      pendingInputCount: 1,
      activeTaskInFlight: false,
      turnInFlight: true,
    });

    const path = new URL(String(http.mock.calls[0][0]));
    expect(path.searchParams.get('scope')).toBe('main');
    expect(path.searchParams.get('projection')).toBe('activity');
  });
});
