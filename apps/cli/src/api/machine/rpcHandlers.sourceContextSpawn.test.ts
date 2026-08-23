import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
  ConnectedServiceMaterializationIdentityV1Schema,
  SPAWN_SESSION_ERROR_CODES,
} from '@happier-dev/protocol';
import type { Credentials } from '@/persistence';

/**
 * The UI's ordinary creation path reaches the daemon through this machine RPC,
 * not through the `session.spawn_new` Action. An ingress that accepts the
 * request but drops `sourceContext` creates an ordinary blank Session and
 * reports success — a silently wrong outcome, worse than a rejection.
 *
 * These are the daemon half of the "no creation ingress drops the recipe"
 * invariant.
 */
const readCredentials = vi.hoisted(() => vi.fn<() => Promise<Credentials | null>>());
const fetchSessionByIdCompat = vi.hoisted(() => vi.fn());
const getOrCreateSessionByTag = vi.hoisted(() => vi.fn());
const fetchSessionById = vi.hoisted(() => vi.fn());
const fetchEncryptedTranscriptMessages = vi.hoisted(() => vi.fn());
const spawnDaemonSession = vi.hoisted(() => vi.fn());
const archiveSessionByIdBestEffort = vi.hoisted(() => vi.fn(async () => {}));
const psList = vi.hoisted(() => vi.fn(async () => [] as unknown[]));

vi.mock('ps-list', () => ({ default: psList }));

vi.mock('@/persistence', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/persistence')>(),
  readCredentials,
  readDaemonState: async () => null,
}));

vi.mock('@/configuration', () => ({
  configuration: {
    serverUrl: 'http://example.invalid',
    apiServerUrl: 'http://example.invalid',
    activeServerId: 'cloud',
    activeServerDir: '/tmp/happier-test-active-server',
    happyHomeDir: '/tmp/happier-test-home',
    logsDir: '/tmp',
    daemonStateFile: '/tmp/happier-test-home/daemon.state.json',
    daemonReattachCatchUpConcurrency: 0,
    isDaemonProcess: false,
    replaySeedMaxChars: 50_000,
    replaySeedCandidateLimit: 500,
  },
}));

vi.mock('@/session/transport/http/sessionsHttp', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/session/transport/http/sessionsHttp')>(),
  fetchSessionByIdCompat,
  getOrCreateSessionByTag,
  fetchSessionById,
}));

vi.mock('@/session/replay/fetchEncryptedTranscriptMessages', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/session/replay/fetchEncryptedTranscriptMessages')>(),
  fetchEncryptedTranscriptMessages,
  fetchEncryptedTranscriptMessagesPage: async (...args: unknown[]) => ({
    messages: await fetchEncryptedTranscriptMessages(...args),
    hasMore: false,
    nextBeforeSeq: null,
    nextAfterSeq: null,
  }),
}));

vi.mock('@/daemon/controlClient', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/daemon/controlClient')>(),
  spawnDaemonSession,
}));

vi.mock('@/session/services/setSessionArchivedState', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/session/services/setSessionArchivedState')>(),
  archiveSessionByIdBestEffort,
}));

import { registerMachineRpcHandlers } from './rpcHandlers';

const SOURCE_HEAD_SEQ = 7;
const REQUESTED_CUTOFF = 4;

const SOURCE_CONTEXT = {
  v: 1,
  kind: 'session_replay',
  sourceSessionId: 'sess_source',
  forkPoint: { type: 'seq', upToSeqInclusive: REQUESTED_CUTOFF },
} as const;

function registerSpawnHandler(
  spawnSession: ReturnType<typeof vi.fn>,
  resolveSpawnSessionByNonce?: ReturnType<typeof vi.fn>,
) {
  const registered = new Map<string, (params: any) => Promise<any>>();
  registerMachineRpcHandlers({
    rpcHandlerManager: {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any,
    handlers: {
      spawnSession: spawnSession as any,
      ...(resolveSpawnSessionByNonce ? { resolveSpawnSessionByNonce: resolveSpawnSessionByNonce as any } : {}),
      stopSession: async () => true,
      requestShutdown: () => {},
    },
  });
  const handler = registered.get(RPC_METHODS.SPAWN_HAPPY_SESSION);
  expect(handler).toBeDefined();
  return handler!;
}

function primeSource(): void {
  fetchSessionByIdCompat.mockResolvedValue({
    id: 'sess_source',
    seq: SOURCE_HEAD_SEQ,
    createdAt: 1,
    updatedAt: 2,
    active: true,
    activeAt: 2,
    encryptionMode: 'plain',
    metadata: JSON.stringify({ path: '/repo', flavor: 'claude' }),
    metadataVersion: 0,
    agentState: null,
    agentStateVersion: 0,
    dataEncryptionKey: null,
    share: null,
  });
  fetchEncryptedTranscriptMessages.mockResolvedValue([
    {
      seq: 3,
      createdAt: 3,
      content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'source question' } } },
    },
  ]);
  getOrCreateSessionByTag.mockImplementation(async (request: { metadata: Record<string, unknown> }) => ({
    session: {
      id: 'sess_child',
      seq: 0,
      createdAt: 10,
      updatedAt: 10,
      active: false,
      activeAt: 0,
      encryptionMode: 'plain',
      metadata: JSON.stringify(request.metadata),
      metadataVersion: 0,
      agentState: null,
      agentStateVersion: 0,
      dataEncryptionKey: null,
    },
    created: true,
  }));
}

function spawnRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'spawn-in-directory',
    directory: '/repo',
    backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
    approvedNewDirectoryCreation: true,
    sourceContext: SOURCE_CONTEXT,
    ...overrides,
  };
}

describe('SPAWN_HAPPY_SESSION sourceContext ingress', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    readCredentials.mockReset();
    fetchSessionByIdCompat.mockReset();
    getOrCreateSessionByTag.mockReset();
    fetchSessionById.mockReset();
    fetchEncryptedTranscriptMessages.mockReset();
    spawnDaemonSession.mockReset();
    archiveSessionByIdBestEffort.mockClear();
    psList.mockClear();
    readCredentials.mockResolvedValue({
      token: 'token-1',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(5) },
    } as Credentials);
    primeSource();
  });

  it('creates a child whose persisted lineage names the requested source and cutoff', async () => {
    const spawnSession = vi.fn(async (_options: Record<string, unknown>) => ({ type: 'success', sessionId: 'sess_child' } as const));
    const handler = registerSpawnHandler(spawnSession);

    const result = await handler(spawnRequest({
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': {
            source: 'connected',
            selection: 'profile',
            profileId: 'profile-1',
          },
        },
      },
    }));

    expect(result).toMatchObject({ type: 'success', sessionId: 'sess_child' });

    // The recipe reached the canonical creator: exactly one row commit, carrying
    // the requested lineage.
    expect(getOrCreateSessionByTag).toHaveBeenCalledTimes(1);
    const creation = getOrCreateSessionByTag.mock.calls[0]![0] as { metadata: Record<string, unknown> };
    expect(creation.metadata).toMatchObject({
      flavor: 'claude',
      forkV1: {
        v: 1,
        parentSessionId: 'sess_source',
        parentCutoffSeqInclusive: REQUESTED_CUTOFF,
        strategy: 'replay',
        providerHint: { providerId: 'claude' },
      },
      replaySeedV1: {
        v: 1,
        sourceSessionId: 'sess_source',
        sourceCutoffSeqInclusive: REQUESTED_CUTOFF,
      },
    });
    expect(String((creation.metadata.replaySeedV1 as { seedText?: unknown }).seedText ?? ''))
      .toContain('source question');
    const persistedIdentity = ConnectedServiceMaterializationIdentityV1Schema.parse(
      creation.metadata.connectedServiceMaterializationIdentityV1,
    );

    // The runner attaches to that exact row — never a plain blank spawn.
    expect(spawnSession).toHaveBeenCalledTimes(1);
    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      existingSessionId: 'sess_child',
    }));
    expect(ConnectedServiceMaterializationIdentityV1Schema.parse(
      (spawnSession.mock.calls[0]![0] as Record<string, unknown>).connectedServiceMaterializationIdentityV1,
    )).toEqual(persistedIdentity);
    expect(spawnSession).not.toHaveBeenCalledWith(expect.objectContaining({ sessionId: undefined, existingSessionId: undefined }));
    expect(spawnDaemonSession).not.toHaveBeenCalled();
  });

  it('refuses a shared sourceContext before it creates a child Session', async () => {
    fetchSessionByIdCompat.mockResolvedValue({
      id: 'sess_source',
      seq: SOURCE_HEAD_SEQ,
      createdAt: 1,
      updatedAt: 2,
      active: true,
      activeAt: 2,
      encryptionMode: 'plain',
      metadata: JSON.stringify({ path: '/repo', flavor: 'claude' }),
      metadataVersion: 0,
      agentState: null,
      agentStateVersion: 0,
      dataEncryptionKey: null,
      share: { accessLevel: 'edit', canApprovePermissions: false },
    });
    const spawnSession = vi.fn(async (_options: Record<string, unknown>) => ({ type: 'success', sessionId: 'sess_child' } as const));
    const handler = registerSpawnHandler(spawnSession);

    const result = await handler(spawnRequest());

    expect(result).toMatchObject({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
    });
    expect(getOrCreateSessionByTag).not.toHaveBeenCalled();
    expect(spawnSession).not.toHaveBeenCalled();
  });

  it('refuses a present-but-invalid recipe instead of stripping it', async () => {
    const spawnSession = vi.fn(async (_options: Record<string, unknown>) => ({ type: 'success', sessionId: 'sess_child' } as const));
    const handler = registerSpawnHandler(spawnSession);

    const result = await handler(spawnRequest({
      sourceContext: { v: 1, kind: 'session_replay', sourceSessionId: '', forkPoint: { type: 'latest' } },
    }));

    expect(result).toMatchObject({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
      errorMessage: 'Invalid sourceContext',
    });
    expect(spawnSession).not.toHaveBeenCalled();
    expect(getOrCreateSessionByTag).not.toHaveBeenCalled();
  });

  it('refuses an unknown cutoff vocabulary rather than falling back to latest', async () => {
    const spawnSession = vi.fn(async (_options: Record<string, unknown>) => ({ type: 'success', sessionId: 'sess_child' } as const));
    const handler = registerSpawnHandler(spawnSession);

    const result = await handler(spawnRequest({
      sourceContext: {
        v: 1,
        kind: 'session_replay',
        sourceSessionId: 'sess_source',
        forkPoint: { type: 'throughSeqInclusive', upToSeqInclusive: 4 },
      },
    }));

    expect(result).toMatchObject({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST });
    expect(spawnSession).not.toHaveBeenCalled();
  });

  it('refuses a recipe on a resume request rather than discarding it', async () => {
    const spawnSession = vi.fn(async () => ({ type: 'success', sessionId: 'sess_existing' } as const));
    const handler = registerSpawnHandler(spawnSession);

    const result = await handler(spawnRequest({
      type: 'resume-session',
      sessionId: 'sess_existing',
    }));

    expect(result).toMatchObject({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
    });
    expect(spawnSession).not.toHaveBeenCalled();
  });

  it('creates no child when the source transcript cannot be hydrated', async () => {
    fetchEncryptedTranscriptMessages.mockResolvedValue([]);
    const spawnSession = vi.fn(async (_options: Record<string, unknown>) => ({ type: 'success', sessionId: 'sess_child' } as const));
    const handler = registerSpawnHandler(spawnSession);

    const result = await handler(spawnRequest());

    expect(result).toMatchObject({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
    });
    expect(getOrCreateSessionByTag).not.toHaveBeenCalled();
    expect(spawnSession).not.toHaveBeenCalled();
  });

  it('settles the orphaned row once when the launch is rejected', async () => {
    const spawnSession = vi.fn(async () => ({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
      errorMessage: 'spawn failed',
    } as const));
    const handler = registerSpawnHandler(spawnSession);

    const result = await handler(spawnRequest());

    expect(result).toMatchObject({ type: 'error', errorMessage: 'spawn failed' });
    expect(archiveSessionByIdBestEffort).toHaveBeenCalledTimes(1);
    expect(archiveSessionByIdBestEffort).toHaveBeenCalledWith({ token: 'token-1', sessionId: 'sess_child' });
  });

  it('rejoins a stable latest attempt before resolving the source again after a lost response', async () => {
    const latestSourceContext = {
      v: 1,
      kind: 'session_replay',
      sourceSessionId: 'sess_source',
      forkPoint: { type: 'latest' },
    } as const;
    let sourceHeadSeq = SOURCE_HEAD_SEQ;
    let persistedMetadata: Record<string, unknown> | null = null;
    fetchSessionByIdCompat.mockImplementation(async ({ sessionId }: { sessionId: string }) => {
      if (sessionId === 'sess_source') {
        return {
          id: 'sess_source',
          seq: sourceHeadSeq,
          createdAt: 1,
          updatedAt: 2,
          active: true,
          activeAt: 2,
          encryptionMode: 'plain',
          metadata: JSON.stringify({ path: '/repo', flavor: 'claude' }),
          metadataVersion: 0,
          agentState: null,
          agentStateVersion: 0,
          dataEncryptionKey: null,
          share: null,
        };
      }
      return persistedMetadata === null
        ? null
        : {
          id: 'sess_child',
          seq: 0,
          createdAt: 10,
          updatedAt: 10,
          active: false,
          activeAt: 0,
          encryptionMode: 'plain',
          metadata: JSON.stringify(persistedMetadata),
          metadataVersion: 0,
          agentState: null,
          agentStateVersion: 0,
          dataEncryptionKey: null,
        };
    });
    getOrCreateSessionByTag.mockImplementation(async (request: { metadata: Record<string, unknown> }) => {
      const created = persistedMetadata === null;
      persistedMetadata ??= request.metadata;
      return {
        session: {
          id: 'sess_child',
          seq: 0,
          createdAt: 10,
          updatedAt: 10,
          active: false,
          activeAt: 0,
          encryptionMode: 'plain',
          metadata: JSON.stringify(persistedMetadata),
          metadataVersion: 0,
          agentState: null,
          agentStateVersion: 0,
          dataEncryptionKey: null,
        },
        created,
      };
    });
    const spawnSession = vi.fn(async () => ({ type: 'success', sessionId: 'sess_child' } as const));
    const resolveSpawnSessionByNonce = vi.fn()
      .mockResolvedValueOnce({ status: 'not_found' as const })
      .mockResolvedValueOnce({ status: 'success' as const, sessionId: 'sess_child' });
    const handler = registerSpawnHandler(spawnSession, resolveSpawnSessionByNonce);
    const request = spawnRequest({ sourceContext: latestSourceContext, spawnNonce: 'latest-lost-response-attempt' });

    await expect(handler(request)).resolves.toMatchObject({ type: 'success', sessionId: 'sess_child' });
    sourceHeadSeq += 1;
    await expect(handler(request)).resolves.toMatchObject({ type: 'success', sessionId: 'sess_child' });

    expect(resolveSpawnSessionByNonce).toHaveBeenCalledTimes(2);
    expect(resolveSpawnSessionByNonce).toHaveBeenNthCalledWith(1, 'latest-lost-response-attempt');
    expect(resolveSpawnSessionByNonce).toHaveBeenNthCalledWith(2, 'latest-lost-response-attempt');
    expect(getOrCreateSessionByTag).toHaveBeenCalledTimes(1);
    // The first create reads the source once for ownership and once to hydrate
    // its seed. The retry validates the persisted child directly, so a moved
    // source head cannot mint a new recipe.
    expect(fetchSessionByIdCompat.mock.calls.map(([request]) => (
      request as { sessionId: string }
    ).sessionId)).toEqual(['sess_source', 'sess_source', 'sess_child']);
    expect(fetchEncryptedTranscriptMessages).toHaveBeenCalledTimes(1);
    expect(spawnSession).toHaveBeenCalledTimes(1);
  });

  it('uses raw latest intent when atomic create-or-rejoin finds the child', async () => {
    // A nonce registry can have no record while get-or-create still finds the
    // child from the first attempt. Its stored cutoff is immutable; a later
    // latest source head must not turn that row into a conflict.
    const latestSourceContext = {
      v: 1,
      kind: 'session_replay',
      sourceSessionId: 'sess_source',
      forkPoint: { type: 'latest' },
    } as const;
    getOrCreateSessionByTag.mockResolvedValue({
      session: {
        id: 'sess_child',
        seq: 0,
        createdAt: 10,
        updatedAt: 10,
        active: false,
        activeAt: 0,
        encryptionMode: 'plain',
        metadata: JSON.stringify({
          replaySeedV1: {
            v: 1,
            seedText: '',
            sourceSessionId: 'sess_source',
            sourceCutoffSeqInclusive: REQUESTED_CUTOFF,
            createdAtMs: 1,
          },
        }),
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
        dataEncryptionKey: null,
      },
      created: false,
    });
    const spawnSession = vi.fn(async () => ({ type: 'success', sessionId: 'sess_child' } as const));
    const resolveSpawnSessionByNonce = vi.fn(async () => ({ status: 'not_found' as const }));
    const handler = registerSpawnHandler(spawnSession, resolveSpawnSessionByNonce);

    await expect(handler(spawnRequest({
      sourceContext: latestSourceContext,
      spawnNonce: 'unregistered-latest-race',
    }))).resolves.toMatchObject({ type: 'success', sessionId: 'sess_child' });

    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({ existingSessionId: 'sess_child' }));
  });

  it('refuses a resolved nonce whose child lineage contradicts the requested source context', async () => {
    fetchSessionByIdCompat.mockImplementation(async ({ sessionId }: { sessionId: string }) => {
      if (sessionId === 'sess_source') {
        return {
          id: 'sess_source',
          seq: SOURCE_HEAD_SEQ,
          createdAt: 1,
          updatedAt: 2,
          active: true,
          activeAt: 2,
          encryptionMode: 'plain',
          metadata: JSON.stringify({ path: '/repo', flavor: 'claude' }),
          metadataVersion: 0,
          agentState: null,
          agentStateVersion: 0,
          dataEncryptionKey: null,
          share: null,
        };
      }
      return {
        id: 'sess_child',
        seq: 0,
        createdAt: 10,
        updatedAt: 10,
        active: false,
        activeAt: 0,
        encryptionMode: 'plain',
        metadata: JSON.stringify({
          replaySeedV1: {
            v: 1,
            seedText: '',
            sourceSessionId: 'different-source',
            sourceCutoffSeqInclusive: REQUESTED_CUTOFF,
            createdAtMs: 1,
          },
        }),
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
        dataEncryptionKey: null,
      };
    });
    const spawnSession = vi.fn(async () => ({ type: 'success', sessionId: 'sess_child' } as const));
    const resolveSpawnSessionByNonce = vi.fn(async () => ({ status: 'success' as const, sessionId: 'sess_child' }));
    const handler = registerSpawnHandler(spawnSession, resolveSpawnSessionByNonce);

    await expect(handler(spawnRequest({ spawnNonce: 'conflicting-source-retry' }))).resolves.toMatchObject({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
    });

    expect(getOrCreateSessionByTag).not.toHaveBeenCalled();
    expect(spawnSession).not.toHaveBeenCalled();
  });

  it('leaves an ordinary spawn without a recipe on the plain creation path', async () => {
    const spawnSession = vi.fn(async (_options: Record<string, unknown>) => ({ type: 'success', sessionId: 'sess_plain' } as const));
    const handler = registerSpawnHandler(spawnSession);

    const result = await handler(spawnRequest({ sourceContext: undefined }));

    expect(result).toMatchObject({ type: 'success', sessionId: 'sess_plain' });
    expect(getOrCreateSessionByTag).not.toHaveBeenCalled();
    expect(spawnSession).toHaveBeenCalledTimes(1);
    expect(spawnSession.mock.calls[0]![0]).not.toHaveProperty('existingSessionId');
  });
});
