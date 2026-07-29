import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';
import { SPAWN_SESSION_ERROR_CODES } from '@/rpc/handlers/registerSessionHandlers';

const mocks = vi.hoisted(() => ({
  readCredentials: vi.fn(),
  resolveReplaySeedDraft: vi.fn(),
  createReplaySeededSession: vi.fn(),
  archiveSessionByIdBestEffort: vi.fn(),
}));

vi.mock('@/persistence', () => ({
  readCredentials: (...args: unknown[]) => mocks.readCredentials(...args),
}));

vi.mock('@/session/replay/resolveReplaySeedDraft', () => ({
  resolveReplaySeedDraft: (...args: unknown[]) => mocks.resolveReplaySeedDraft(...args),
}));

vi.mock('@/session/replay/createReplaySeededSession', () => ({
  createReplaySeededSession: (...args: unknown[]) => mocks.createReplaySeededSession(...args),
}));

vi.mock('@/session/services/setSessionArchivedState', () => ({
  archiveSessionByIdBestEffort: (...args: unknown[]) => mocks.archiveSessionByIdBestEffort(...args),
}));

import { continueSessionWithReplay } from './continueWithReplay';

describe('continueSessionWithReplay spawn nonce safety', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readCredentials.mockResolvedValue({
      token: 'token',
      encryption: { type: 'legacy', secret: new Uint8Array([1]) },
    });
    mocks.resolveReplaySeedDraft.mockResolvedValue({
      seedDraft: 'Continue this conversation',
      dialog: [],
      summaryText: null,
      sourceCutoffSeqInclusive: 7,
      referencedSessionMediaWorkspacePaths: [],
    });
    mocks.createReplaySeededSession.mockResolvedValue({ sessionId: 'replay-child' });
  });

  it('uses the same deterministic replay tag and spawn nonce for repeated equivalent requests', async () => {
    const spawnSession = vi.fn(async (_options: SpawnSessionOptions) => ({
      type: 'success',
      sessionId: 'replay-child',
    } as const));
    const params = {
      directory: '/tmp/project',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' } as const,
      replay: {
        previousSessionId: 'parent-session',
        strategy: 'recent_messages',
      },
    } as const;

    await continueSessionWithReplay(params, { spawnSession });
    await continueSessionWithReplay(params, { spawnSession });

    const firstTag = mocks.createReplaySeededSession.mock.calls[0]?.[0]?.tag;
    const secondTag = mocks.createReplaySeededSession.mock.calls[1]?.[0]?.tag;
    const firstSpawnNonce = spawnSession.mock.calls[0]?.[0].spawnNonce;
    const secondSpawnNonce = spawnSession.mock.calls[1]?.[0].spawnNonce;
    expect(firstTag).toEqual(expect.any(String));
    expect(firstTag).toBe(secondTag);
    expect(firstSpawnNonce).toBe(firstTag);
    expect(secondSpawnNonce).toBe(firstTag);
  });

  it('does not archive the replay-seeded session when spawn times out waiting for webhook', async () => {
    const spawnSession = vi.fn(async (_options: SpawnSessionOptions) => ({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
      errorMessage: 'Timed out waiting for session webhook',
    } as const));

    const result = await continueSessionWithReplay(
      {
        directory: '/tmp/project',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        replay: {
          previousSessionId: 'parent-session',
          strategy: 'recent_messages',
        },
      },
      { spawnSession },
    );

    expect(result).toMatchObject({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
    });
    expect(mocks.archiveSessionByIdBestEffort).not.toHaveBeenCalled();
  });
});
