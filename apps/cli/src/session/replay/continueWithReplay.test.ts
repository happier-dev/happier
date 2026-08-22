import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';
import { SPAWN_SESSION_ERROR_CODES } from '@/rpc/handlers/registerSessionHandlers';

const mocks = vi.hoisted(() => ({
  readCredentials: vi.fn(),
  readStoredCredentials: vi.fn(),
  resolveReplaySeedDraft: vi.fn(),
  getOrCreateSessionByTag: vi.fn(),
  fetchSessionOrganizationPlacement: vi.fn(),
  validateStoredAuthTokenAgainstActiveServer: vi.fn(),
  fetchAccountEncryptionCurrentness: vi.fn(),
  archiveSessionOnceInactive: vi.fn(),
  sendSessionMessage: vi.fn(),
}));

vi.mock('@/persistence', () => ({
  readCredentials: (...args: unknown[]) => mocks.readCredentials(...args),
  readStoredCredentials: (...args: unknown[]) => mocks.readStoredCredentials(...args),
}));

vi.mock('@/session/replay/resolveReplaySeedDraft', () => ({
  resolveReplaySeedDraft: (...args: unknown[]) => mocks.resolveReplaySeedDraft(...args),
}));

vi.mock('@/session/transport/http/sessionsHttp', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/session/transport/http/sessionsHttp')>(),
  getOrCreateSessionByTag: (...args: unknown[]) => mocks.getOrCreateSessionByTag(...args),
  fetchSessionOrganizationPlacement: (...args: unknown[]) => mocks.fetchSessionOrganizationPlacement(...args),
}));

vi.mock('@/auth/validateStoredAuthTokenAgainstActiveServer', () => ({
  validateStoredAuthTokenAgainstActiveServer: (...args: unknown[]) =>
    mocks.validateStoredAuthTokenAgainstActiveServer(...args),
}));

vi.mock('@/api/client/connectedServiceCredentialApi', () => ({
  fetchAccountEncryptionCurrentness: (...args: unknown[]) => mocks.fetchAccountEncryptionCurrentness(...args),
}));

vi.mock('@/session/services/archiveSessionOnceInactive', () => ({
  archiveSessionOnceInactive: (...args: unknown[]) => mocks.archiveSessionOnceInactive(...args),
}));

vi.mock('@/session/services/sendSessionMessage', () => ({
  sendSessionMessage: (...args: unknown[]) => mocks.sendSessionMessage(...args),
}));

import { continueSessionWithReplay } from './continueWithReplay';

/**
 * The legacy continue-with-replay contract is a compatibility ingress: it keeps
 * its own nonce/tag identity and result shape, while row creation, create-or-
 * rejoin settlement and orphan cleanup belong to the canonical creator.
 */
describe('continueSessionWithReplay canonical creation delegation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readCredentials.mockResolvedValue(null);
    mocks.readStoredCredentials.mockResolvedValue({
      token: 'token',
      encryption: null,
    });
    mocks.resolveReplaySeedDraft.mockResolvedValue({
      status: 'seeded',
      seedDraft: 'Continue this conversation',
      dialog: [],
      summaryText: null,
      sourceCutoffSeqInclusive: 7,
      referencedSessionMediaWorkspacePaths: [],
    });
    mocks.getOrCreateSessionByTag.mockResolvedValue({
      session: { id: 'replay-child' },
      created: true,
    });
    mocks.fetchSessionOrganizationPlacement.mockResolvedValue({ folderId: null, tagIds: [] });
    mocks.validateStoredAuthTokenAgainstActiveServer.mockResolvedValue({ state: 'valid' });
    mocks.fetchAccountEncryptionCurrentness.mockResolvedValue({ mode: 'plain', version: 1 });
    mocks.archiveSessionOnceInactive.mockResolvedValue({ archivedAt: 1 });
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

    const firstTag = mocks.getOrCreateSessionByTag.mock.calls[0]?.[0]?.tag;
    const secondTag = mocks.getOrCreateSessionByTag.mock.calls[1]?.[0]?.tag;
    const firstSpawnNonce = spawnSession.mock.calls[0]?.[0].spawnNonce;
    const secondSpawnNonce = spawnSession.mock.calls[1]?.[0].spawnNonce;
    expect(firstTag).toEqual(expect.any(String));
    expect(firstTag).toBe(secondTag);
    expect(firstSpawnNonce).toBe(firstTag);
    expect(secondSpawnNonce).toBe(firstTag);
    expect(mocks.readCredentials).not.toHaveBeenCalled();
  });

  it('creates the child through the canonical creator with the resolved replay recipe', async () => {
    const spawnSession = vi.fn(async (_options: SpawnSessionOptions) => ({
      type: 'success',
      sessionId: 'replay-child',
    } as const));

    const result = await continueSessionWithReplay(
      {
        directory: '/tmp/project',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        replay: { previousSessionId: 'parent-session', strategy: 'recent_messages' },
      },
      { spawnSession },
    );

    expect(result).toEqual({ type: 'success', sessionId: 'replay-child' });
    const creationMetadata = mocks.getOrCreateSessionByTag.mock.calls[0]?.[0]?.metadata as Record<string, unknown>;
    expect(creationMetadata.forkV1).toMatchObject({
      v: 1,
      parentSessionId: 'parent-session',
      parentCutoffSeqInclusive: 7,
      strategy: 'replay',
    });
    expect(creationMetadata.replaySeedV1).toMatchObject({
      v: 1,
      seedText: 'Continue this conversation',
      sourceSessionId: 'parent-session',
      sourceCutoffSeqInclusive: 7,
    });
    // The launched runner attaches to the row the canonical creator committed;
    // it never creates a second one.
    expect(spawnSession.mock.calls[0]?.[0].existingSessionId).toBe('replay-child');
  });

  it('preserves media continuity for a source that referenced Session media', async () => {
    mocks.resolveReplaySeedDraft.mockResolvedValueOnce({
      status: 'seeded',
      seedDraft: 'Continue this conversation',
      dialog: [],
      summaryText: null,
      sourceCutoffSeqInclusive: 9,
      referencedSessionMediaWorkspacePaths: ['/tmp/project/.happier/media/a.png'],
    });
    const spawnSession = vi.fn(async (_options: SpawnSessionOptions) => ({
      type: 'success',
      sessionId: 'replay-child',
    } as const));

    await continueSessionWithReplay(
      {
        directory: '/tmp/project',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        replay: { previousSessionId: 'parent-session', strategy: 'recent_messages' },
      },
      { spawnSession },
    );

    const creationMetadata = mocks.getOrCreateSessionByTag.mock.calls[0]?.[0]?.metadata as Record<string, unknown>;
    expect(creationMetadata.sessionMediaContinuityV1).toMatchObject({
      v: 1,
      sourceSessionId: 'parent-session',
      sourceCutoffSeqInclusive: 9,
      referencedWorkspacePaths: ['/tmp/project/.happier/media/a.png'],
    });
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
    expect(mocks.archiveSessionOnceInactive).not.toHaveBeenCalled();
  });

  it('settles the orphaned child once, at the canonical creator, on a definite spawn failure', async () => {
    const spawnSession = vi.fn(async (_options: SpawnSessionOptions) => ({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
      errorMessage: 'Runner refused to start',
    } as const));

    const result = await continueSessionWithReplay(
      {
        directory: '/tmp/project',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        replay: { previousSessionId: 'parent-session', strategy: 'recent_messages' },
      },
      { spawnSession },
    );

    expect(result).toMatchObject({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
      errorMessage: 'Runner refused to start',
    });
    expect(mocks.archiveSessionOnceInactive).toHaveBeenCalledTimes(1);
    expect(mocks.archiveSessionOnceInactive).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'replay-child' }),
    );
  });

  it('reports an unresolvable source without creating any child', async () => {
    mocks.resolveReplaySeedDraft.mockResolvedValueOnce({ status: 'unavailable' });
    const spawnSession = vi.fn(async (_options: SpawnSessionOptions) => ({
      type: 'success',
      sessionId: 'replay-child',
    } as const));

    const result = await continueSessionWithReplay(
      {
        directory: '/tmp/project',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        replay: { previousSessionId: 'parent-session', strategy: 'recent_messages' },
      },
      { spawnSession },
    );

    expect(result).toMatchObject({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
    });
    expect(mocks.getOrCreateSessionByTag).not.toHaveBeenCalled();
    expect(spawnSession).not.toHaveBeenCalled();
  });
});
