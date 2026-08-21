import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol';
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

function registerSpawnHandler(spawnSession: ReturnType<typeof vi.fn>) {
  const registered = new Map<string, (params: any) => Promise<any>>();
  registerMachineRpcHandlers({
    rpcHandlerManager: {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any,
    handlers: {
      spawnSession: spawnSession as any,
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

    const result = await handler(spawnRequest());

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

    // The runner attaches to that exact row — never a plain blank spawn.
    expect(spawnSession).toHaveBeenCalledTimes(1);
    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      existingSessionId: 'sess_child',
    }));
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
      errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
      errorMessage: 'spawn failed',
    } as const));
    const handler = registerSpawnHandler(spawnSession);

    const result = await handler(spawnRequest());

    expect(result).toMatchObject({ type: 'error', errorMessage: 'spawn failed' });
    expect(archiveSessionByIdBestEffort).toHaveBeenCalledTimes(1);
    expect(archiveSessionByIdBestEffort).toHaveBeenCalledWith({ token: 'token-1', sessionId: 'sess_child' });
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
