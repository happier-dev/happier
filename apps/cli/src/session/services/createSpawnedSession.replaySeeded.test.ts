import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Credentials } from '@/persistence';
import { SPAWN_SESSION_ERROR_CODES } from '@/rpc/handlers/registerSessionHandlers';

const spawnDaemonSession = vi.hoisted(() => vi.fn());
const resolveDaemonSpawnSessionByNonce = vi.hoisted(() => vi.fn());
const fetchSessionById = vi.hoisted(() => vi.fn());
const getOrCreateSessionByTag = vi.hoisted(() => vi.fn());
const archiveSessionByIdBestEffort = vi.hoisted(() => vi.fn(async () => {}));
const updateSessionMetadataWithRetry = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('@/daemon/controlClient', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/daemon/controlClient')>(),
  spawnDaemonSession,
  resolveDaemonSpawnSessionByNonce,
}));

vi.mock('@/session/transport/http/sessionsHttp', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/session/transport/http/sessionsHttp')>(),
  fetchSessionById,
  getOrCreateSessionByTag,
}));

vi.mock('@/session/services/setSessionArchivedState', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/session/services/setSessionArchivedState')>(),
  archiveSessionByIdBestEffort,
}));

vi.mock('@/session/metadata/updateSessionMetadataWithRetry', () => ({
  updateSessionMetadataWithRetry,
}));

import { createSpawnedSession, type CreateSpawnedSessionParams } from './createSpawnedSession';

const credentials: Credentials = {
  token: 'token',
  encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
};

const CANONICAL_METADATA: Record<string, unknown> = {
  inheritedFromParent: 'kept',
  forkV1: {
    v: 1,
    parentSessionId: 'sess_parent',
    parentCutoffSeqInclusive: 42,
    createdAtMs: 1_000,
    strategy: 'replay',
    providerHint: { providerId: 'claude' },
  },
  replaySeedV1: {
    v: 1,
    seedText: 'seed text',
    sourceSessionId: 'sess_parent',
    sourceCutoffSeqInclusive: 42,
    createdAtMs: 1_000,
  },
};

function rawSession(metadata: Record<string, unknown> | string | null): Record<string, unknown> {
  return {
    id: 'sess_child',
    seq: 0,
    createdAt: 10,
    updatedAt: 10,
    active: false,
    activeAt: 0,
    encryptionMode: 'plain',
    metadata: typeof metadata === 'string' || metadata === null ? metadata : JSON.stringify(metadata),
    metadataVersion: 0,
    agentState: null,
    agentStateVersion: 0,
    dataEncryptionKey: null,
  };
}

function replaySeededParams(
  overrides: Partial<CreateSpawnedSessionParams> = {},
): CreateSpawnedSessionParams {
  return {
    credentials,
    directory: '/repo',
    backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
    replaySeededCreation: {
      tag: 'replay:sess_parent:42:attempt-1',
      agentId: 'claude',
      metadata: CANONICAL_METADATA,
      sourceRecipe: { sourceSessionId: 'sess_parent', cutoffSeqInclusive: 42 },
    },
    ...overrides,
  } as CreateSpawnedSessionParams;
}

describe('createSpawnedSession — Replay-seeded creation', () => {
  beforeEach(() => {
    spawnDaemonSession.mockReset();
    resolveDaemonSpawnSessionByNonce.mockReset();
    fetchSessionById.mockReset();
    getOrCreateSessionByTag.mockReset();
    archiveSessionByIdBestEffort.mockClear();
    updateSessionMetadataWithRetry.mockClear();
  });

  it('commits the row from the caller tag and attaches the launched runner to it', async () => {
    getOrCreateSessionByTag.mockResolvedValue({ session: rawSession(CANONICAL_METADATA) });
    spawnDaemonSession.mockResolvedValue({ success: true, sessionId: 'sess_child' });

    const created = await createSpawnedSession(replaySeededParams());

    expect(created).toMatchObject({ created: true, sessionId: 'sess_child' });
    // The invoking ingress owns the retry identity; the creator never rewrites it.
    expect(getOrCreateSessionByTag).toHaveBeenCalledTimes(1);
    const creation = getOrCreateSessionByTag.mock.calls[0]![0] as {
      tag: string;
      metadata: Record<string, unknown>;
      agentState: unknown;
    };
    expect(creation.tag).toBe('replay:sess_parent:42:attempt-1');
    expect(creation.agentState).toBeNull();
    expect(creation.metadata).toMatchObject({
      tag: 'replay:sess_parent:42:attempt-1',
      path: '/repo',
      flavor: 'claude',
      inheritedFromParent: 'kept',
      forkV1: { parentSessionId: 'sess_parent', parentCutoffSeqInclusive: 42, strategy: 'replay' },
      replaySeedV1: { sourceSessionId: 'sess_parent', sourceCutoffSeqInclusive: 42 },
    });

    expect(spawnDaemonSession).toHaveBeenCalledTimes(1);
    expect(spawnDaemonSession.mock.calls[0]![0]).toMatchObject({ existingSessionId: 'sess_child' });

    // The row is already known and its tag was written at creation.
    expect(fetchSessionById).not.toHaveBeenCalled();
    expect(updateSessionMetadataWithRetry).not.toHaveBeenCalled();
    expect(archiveSessionByIdBestEffort).not.toHaveBeenCalled();
  });

  it('does not compose a media-continuity envelope this tree has no contract for', async () => {
    getOrCreateSessionByTag.mockResolvedValue({ session: rawSession(CANONICAL_METADATA) });
    spawnDaemonSession.mockResolvedValue({ success: true, sessionId: 'sess_child' });

    await createSpawnedSession(replaySeededParams());

    const creation = getOrCreateSessionByTag.mock.calls[0]![0] as { metadata: Record<string, unknown> };
    expect(creation.metadata).not.toHaveProperty('sessionMediaContinuityV1');
  });

  it('settles the orphaned row exactly once when the launch is rejected', async () => {
    getOrCreateSessionByTag.mockResolvedValue({ session: rawSession(CANONICAL_METADATA) });
    spawnDaemonSession.mockResolvedValue({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
      errorMessage: 'spawn failed',
    });

    await expect(createSpawnedSession(replaySeededParams())).rejects.toMatchObject({
      code: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
      message: 'spawn failed',
    });

    expect(archiveSessionByIdBestEffort).toHaveBeenCalledTimes(1);
    expect(archiveSessionByIdBestEffort).toHaveBeenCalledWith({ token: 'token', sessionId: 'sess_child' });
  });

  it('rejects a reused creation identity whose persisted recipe names another source', async () => {
    getOrCreateSessionByTag.mockResolvedValue({
      session: rawSession({
        ...CANONICAL_METADATA,
        replaySeedV1: {
          v: 1,
          seedText: 'seed text',
          sourceSessionId: 'sess_other_parent',
          sourceCutoffSeqInclusive: 42,
          createdAtMs: 1_000,
        },
      }),
    });

    await expect(createSpawnedSession(replaySeededParams())).rejects.toMatchObject({
      code: 'creation_conflict',
    });

    // A conflicting rejoin never launches and never archives the pre-existing row.
    expect(spawnDaemonSession).not.toHaveBeenCalled();
    expect(archiveSessionByIdBestEffort).not.toHaveBeenCalled();
  });

  it('rejects a reused creation identity whose persisted cutoff contradicts the request', async () => {
    getOrCreateSessionByTag.mockResolvedValue({
      session: rawSession({
        ...CANONICAL_METADATA,
        replaySeedV1: {
          v: 1,
          seedText: 'seed text',
          sourceSessionId: 'sess_parent',
          sourceCutoffSeqInclusive: 7,
          createdAtMs: 1_000,
        },
      }),
    });

    await expect(createSpawnedSession(replaySeededParams())).rejects.toMatchObject({
      code: 'creation_conflict',
    });
  });

  it('treats absent persisted metadata as absence of conflict evidence', async () => {
    getOrCreateSessionByTag.mockResolvedValue({ session: rawSession(null) });
    spawnDaemonSession.mockResolvedValue({ success: true, sessionId: 'sess_child' });

    await expect(createSpawnedSession(replaySeededParams())).resolves.toMatchObject({
      sessionId: 'sess_child',
    });
    expect(spawnDaemonSession).toHaveBeenCalledTimes(1);
  });

  it('refuses a row whose stored metadata cannot be authenticated', async () => {
    // Stored bytes this daemon cannot decode mean a pre-existing row whose
    // lineage cannot be verified — a row this call created would always decode,
    // because this call encoded it. Attaching would seed the caller from an
    // unverified source, so fail closed instead.
    getOrCreateSessionByTag.mockResolvedValue({ session: rawSession('{not-decodable') });

    await expect(createSpawnedSession(replaySeededParams())).rejects.toMatchObject({
      code: 'creation_conflict',
    });

    expect(spawnDaemonSession).not.toHaveBeenCalled();
    expect(archiveSessionByIdBestEffort).not.toHaveBeenCalled();
  });

  it('settles the orphaned row when the launch transport throws instead of answering', async () => {
    getOrCreateSessionByTag.mockResolvedValue({ session: rawSession(CANONICAL_METADATA) });
    spawnDaemonSession.mockRejectedValue(new Error('transport exploded'));

    // A throwing transport orphans the row exactly like a rejected envelope.
    await expect(createSpawnedSession(replaySeededParams())).rejects.toMatchObject({
      message: 'transport exploded',
    });

    expect(archiveSessionByIdBestEffort).toHaveBeenCalledTimes(1);
    expect(archiveSessionByIdBestEffort).toHaveBeenCalledWith({ token: 'token', sessionId: 'sess_child' });
  });

  it('launches through an injected in-daemon transport instead of the control client', async () => {
    getOrCreateSessionByTag.mockResolvedValue({ session: rawSession(CANONICAL_METADATA) });
    const directSpawn = vi.fn(
      async (_request: { existingSessionId?: string }) => ({ type: 'success', sessionId: 'sess_child' }),
    );

    const created = await createSpawnedSession(replaySeededParams({
      directTransport: { spawn: directSpawn },
    }));

    expect(created.sessionId).toBe('sess_child');
    expect(directSpawn).toHaveBeenCalledTimes(1);
    expect(directSpawn.mock.calls[0]![0]).toMatchObject({ existingSessionId: 'sess_child' });
    expect(spawnDaemonSession).not.toHaveBeenCalled();
  });
});
