import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol';
import type { Credentials } from '@/persistence';

/**
 * The `session.fork` replay branch must keep delegating to the canonical
 * Replay-seeded creator. Structural evidence (one creator, no duplicate module)
 * does not stop this branch from quietly reacquiring its own row creation, so
 * this pins the delegation, the branch's own retry identity, and the
 * ingress-specific overlays a careless refactor would drop.
 */
const readCredentials = vi.hoisted(() => vi.fn<() => Promise<Credentials | null>>());
const fetchSessionByIdCompat = vi.hoisted(() => vi.fn());
const getOrCreateSessionByTag = vi.hoisted(() => vi.fn());
const fetchSessionById = vi.hoisted(() => vi.fn());
const resolveReplaySeedDraft = vi.hoisted(() => vi.fn());
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

// Transcript retrieval is the HTTP boundary beneath the recipe owner. The real
// `buildReplaySeededSpawnRecipe` and the real creator stay in the path.
vi.mock('@/session/replay/resolveReplaySeedDraft', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/session/replay/resolveReplaySeedDraft')>(),
  resolveReplaySeedDraft,
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

/** The parent's head seq, which a `latest` fork admits as its cutoff. */
const PARENT_HEAD_SEQ = 11;
/** A deliberately different cutoff resolved by seed retrieval for itself. */
const RETRIEVAL_RESOLVED_SEQ = 5;

function registerForkHandler(spawnSession: ReturnType<typeof vi.fn>) {
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
  const handler = registered.get(RPC_METHODS.SESSION_FORK);
  expect(handler).toBeDefined();
  return handler!;
}

function primeParent(flavor: string, extraMetadata: Record<string, unknown> = {}): void {
  fetchSessionByIdCompat.mockResolvedValue({
    id: 'sess_parent',
    seq: PARENT_HEAD_SEQ,
    createdAt: 1,
    updatedAt: 2,
    active: true,
    activeAt: 2,
    encryptionMode: 'plain',
    metadata: JSON.stringify({
      path: '/repo',
      flavor,
      permissionMode: 'plan',
      permissionModeUpdatedAt: 1_000,
      ...extraMetadata,
    }),
    metadataVersion: 0,
    agentState: null,
    agentStateVersion: 0,
    dataEncryptionKey: null,
  });
}

function primeChildRow(): void {
  getOrCreateSessionByTag.mockResolvedValue({
    session: {
      id: 'sess_child',
      seq: 0,
      createdAt: 10,
      updatedAt: 10,
      active: false,
      activeAt: 0,
      encryptionMode: 'plain',
      metadata: JSON.stringify({ path: '/repo', flavor: 'claude' }),
      metadataVersion: 0,
      agentState: null,
      agentStateVersion: 0,
      dataEncryptionKey: null,
    },
  });
}

describe('session.fork replay branch — canonical creation delegation', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    readCredentials.mockReset();
    fetchSessionByIdCompat.mockReset();
    getOrCreateSessionByTag.mockReset();
    fetchSessionById.mockReset();
    resolveReplaySeedDraft.mockReset();
    spawnDaemonSession.mockReset();
    archiveSessionByIdBestEffort.mockClear();
    psList.mockClear();
    readCredentials.mockResolvedValue({
      token: 'token-1',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(5) },
    } as Credentials);
    resolveReplaySeedDraft.mockResolvedValue({
      status: 'seeded',
      seedDraft: 'replayed dialog',
      dialog: [],
      summaryText: null,
      sourceCutoffSeqInclusive: RETRIEVAL_RESOLVED_SEQ,
    });
    primeParent('claude');
    primeChildRow();
  });

  it('commits the child through the canonical creator with its own fork retry identity', async () => {
    const spawnSession = vi.fn(async () => ({ type: 'success', sessionId: 'sess_child' } as const));
    const handler = registerForkHandler(spawnSession);

    const result = await handler({
      v: 1,
      parentSessionId: 'sess_parent',
      forkPoint: { type: 'latest' },
      strategy: 'replay',
    });

    expect(result).toMatchObject({ ok: true, childSessionId: 'sess_child' });

    // Exactly one row creation, and it went through the canonical creator.
    expect(getOrCreateSessionByTag).toHaveBeenCalledTimes(1);
    const creation = getOrCreateSessionByTag.mock.calls[0]![0] as {
      tag: string;
      metadata: Record<string, unknown>;
    };

    // The branch keeps its existing per-attempt tag form.
    expect(creation.tag).toMatch(
      new RegExp(`^fork:sess_parent:${PARENT_HEAD_SEQ}:[0-9a-f-]{36}$`),
    );

    // Persisted lineage names the fork point this lifecycle admitted, NOT the
    // cutoff seed retrieval resolved for itself.
    expect(creation.metadata).toMatchObject({
      flavor: 'claude',
      forkV1: {
        v: 1,
        parentSessionId: 'sess_parent',
        parentCutoffSeqInclusive: PARENT_HEAD_SEQ,
        strategy: 'replay',
        providerHint: { providerId: 'claude' },
      },
      replaySeedV1: {
        v: 1,
        seedText: 'replayed dialog',
        sourceSessionId: 'sess_parent',
        sourceCutoffSeqInclusive: PARENT_HEAD_SEQ,
      },
    });
    expect((creation.metadata.forkV1 as { parentCutoffSeqInclusive: number }).parentCutoffSeqInclusive)
      .not.toBe(RETRIEVAL_RESOLVED_SEQ);

    // The runner attaches to that exact row, and nothing self-calls the daemon
    // control server from inside the daemon.
    expect(spawnSession).toHaveBeenCalledTimes(1);
    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      existingSessionId: 'sess_child',
      spawnNonce: expect.stringMatching(/:replay$/),
    }));
    expect(spawnDaemonSession).not.toHaveBeenCalled();
    expect(archiveSessionByIdBestEffort).not.toHaveBeenCalled();
  });

  it('carries inherited fork overlays into creation metadata and spawn options', async () => {
    const spawnSession = vi.fn(async () => ({ type: 'success', sessionId: 'sess_child' } as const));
    const handler = registerForkHandler(spawnSession);

    await handler({
      v: 1,
      parentSessionId: 'sess_parent',
      forkPoint: { type: 'latest' },
      strategy: 'replay',
    });

    const creation = getOrCreateSessionByTag.mock.calls[0]![0] as { metadata: Record<string, unknown> };
    // Inherited parent context survives beneath the canonical envelopes.
    expect(creation.metadata).toMatchObject({ permissionMode: 'plan' });
    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: 'plan' }));
  });

  it('carries OpenCode affinity metadata and environment into the forked child', async () => {
    primeParent('opencode', {
      opencodeBackendMode: 'server',
      opencodeServerBaseUrl: 'http://127.0.0.1:4096',
      opencodeServerBaseUrlExplicit: true,
    });
    const spawnSession = vi.fn(async () => ({ type: 'success', sessionId: 'sess_child' } as const));
    const handler = registerForkHandler(spawnSession);

    const result = await handler({
      v: 1,
      parentSessionId: 'sess_parent',
      forkPoint: { type: 'latest' },
      strategy: 'replay',
    });

    expect(result).toMatchObject({ ok: true, childSessionId: 'sess_child' });

    // The OpenCode affinity overlay is an ingress-specific fact that must reach
    // both the creation metadata and the launch environment.
    const creation = getOrCreateSessionByTag.mock.calls[0]![0] as { metadata: Record<string, unknown> };
    expect(creation.metadata).toMatchObject({
      forkV1: { providerHint: { providerId: 'opencode' } },
      opencodeBackendMode: 'server',
      // The affinity reader normalizes the base URL; the child records that form.
      opencodeServerBaseUrl: 'http://127.0.0.1:4096/',
      opencodeServerBaseUrlExplicit: true,
    });
    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      environmentVariables: expect.objectContaining({
        HAPPIER_OPENCODE_BACKEND_MODE: 'server',
        HAPPIER_OPENCODE_SERVER_URL: 'http://127.0.0.1:4096/',
        HAPPIER_OPENCODE_SERVER_URL_EXPLICIT: '1',
      }),
    }));
  });

  it('settles the orphaned child once and reports the launch envelope when spawn fails', async () => {
    const spawnSession = vi.fn(async () => ({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
      errorMessage: 'spawn failed',
    } as const));
    const handler = registerForkHandler(spawnSession);

    const result = await handler({
      v: 1,
      parentSessionId: 'sess_parent',
      forkPoint: { type: 'latest' },
      strategy: 'replay',
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
      errorMessage: 'spawn failed',
    });
    expect(archiveSessionByIdBestEffort).toHaveBeenCalledTimes(1);
    expect(archiveSessionByIdBestEffort).toHaveBeenCalledWith({ token: 'token-1', sessionId: 'sess_child' });
  });

  it('creates no child when the source seed cannot be resolved', async () => {
    resolveReplaySeedDraft.mockResolvedValue({ status: 'unavailable' });
    const spawnSession = vi.fn(async () => ({ type: 'success', sessionId: 'sess_child' } as const));
    const handler = registerForkHandler(spawnSession);

    const result = await handler({
      v: 1,
      parentSessionId: 'sess_parent',
      forkPoint: { type: 'latest' },
      strategy: 'replay',
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
    });
    expect(getOrCreateSessionByTag).not.toHaveBeenCalled();
    expect(spawnSession).not.toHaveBeenCalled();
  });
});
