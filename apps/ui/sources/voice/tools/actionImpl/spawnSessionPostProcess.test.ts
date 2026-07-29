import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  postprocessSpawnedSession,
  resolveVoiceSpawnedFirstTurnLocalId,
} from './spawnSessionPostProcess';

const refreshSessions = vi.hoisted(() => vi.fn(async () => {}));
const patchSessionMetadataWithRetry = vi.hoisted(() =>
  vi.fn(async (_sessionId: string, _updater: unknown) => {}),
);
const publishDisplayTitleMetadataMutation = vi.hoisted(() => vi.fn(async (_params: unknown) => {}));
const followUpSpawnedSessionWithServerScope = vi.hoisted(() => vi.fn(async (_params: unknown) => {}));

vi.mock('@/sync/sync', () => ({
  sync: {
    refreshSessions: () => refreshSessions(),
    patchSessionMetadataWithRetry: (sessionId: string, updater: unknown) =>
      patchSessionMetadataWithRetry(sessionId, updater),
  },
}));

vi.mock('@/sync/state/displayTitlePublish', () => ({
  publishDisplayTitleMetadataMutation: (params: unknown) => publishDisplayTitleMetadataMutation(params),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/followUpSpawnedSession', () => ({
  followUpSpawnedSessionWithServerScope: (params: unknown) => followUpSpawnedSessionWithServerScope(params),
}));

describe('postprocessSpawnedSession', () => {
  beforeEach(() => {
    refreshSessions.mockClear();
    patchSessionMetadataWithRetry.mockClear();
    publishDisplayTitleMetadataMutation.mockClear();
    followUpSpawnedSessionWithServerScope.mockReset();
    followUpSpawnedSessionWithServerScope.mockResolvedValue(undefined);
  });

  it('derives first-turn identity from canonical operation custody when it replaces the provisional nonce', () => {
    expect(resolveVoiceSpawnedFirstTurnLocalId({
      spawned: {
        type: 'success',
        sessionId: 'session-created',
        spawnAttemptCustody: { spawnNonce: 'canonical-nonce' },
      },
      requestedSpawnNonce: 'provisional-nonce',
    })).toBe('spawn-first-turn:canonical-nonce');
  });

  it('propagates initial-message follow-up failures instead of silently dropping the user prompt', async () => {
    followUpSpawnedSessionWithServerScope.mockRejectedValueOnce(new Error('Created session is not active locally yet'));

    await expect(postprocessSpawnedSession({
      sessionId: 'session-created',
      serverId: 'server-a',
      initialMessage: 'Start here',
    })).rejects.toThrow('Created session is not active locally yet');

    expect(followUpSpawnedSessionWithServerScope).toHaveBeenCalledWith({
      sessionId: 'session-created',
      targetServerId: 'server-a',
      initialMessageText: 'Start here',
      metaOverrides: undefined,
    });
  });
});
