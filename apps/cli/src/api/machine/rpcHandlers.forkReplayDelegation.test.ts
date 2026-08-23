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

/**
 * `POST /v1/sessions` echoes the row carrying the exact creation metadata the
 * caller posted, lineage envelopes included. Echoing it here rather than pinning
 * a hand-written bag keeps the fixture honest: the creator authenticates the
 * returned row against the requested source recipe, and a row that dropped those
 * envelopes is a shape the server never answers with.
 */
function primeChildRow(): void {
  getOrCreateSessionByTag.mockImplementation(async (params: { metadata: Record<string, unknown> }) => ({
    session: {
      id: 'sess_child',
      seq: 0,
      createdAt: 10,
      updatedAt: 10,
      active: false,
      activeAt: 0,
      encryptionMode: 'plain',
      metadata: JSON.stringify(params.metadata),
      metadataVersion: 0,
      agentState: null,
      agentStateVersion: 0,
      dataEncryptionKey: null,
    },
  }));
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
      requestId: 'fork-request-1',
    });

    expect(result).toMatchObject({ ok: true, childSessionId: 'sess_child' });

    // Exactly one row creation, and it went through the canonical creator.
    expect(getOrCreateSessionByTag).toHaveBeenCalledTimes(1);
    const creation = getOrCreateSessionByTag.mock.calls[0]![0] as {
      tag: string;
      metadata: Record<string, unknown>;
    };

    // The caller-provided id is the retry identity and the durable lineage
    // correlation key for this exact fork attempt.
    expect(creation.tag).toBe('fork:sess_parent:fork-request-1');

    // Persisted lineage names the fork point this lifecycle admitted, NOT the
    // cutoff seed retrieval resolved for itself.
    expect(creation.metadata).toMatchObject({
      flavor: 'claude',
      forkV1: {
        v: 1,
        parentSessionId: 'sess_parent',
        parentCutoffSeqInclusive: PARENT_HEAD_SEQ,
        strategy: 'replay',
        requestId: 'fork-request-1',
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

  it('bounds a `latest` fork seed by the cutoff the lifecycle already admitted', async () => {
    const spawnSession = vi.fn(async () => ({ type: 'success', sessionId: 'sess_child' } as const));
    const handler = registerForkHandler(spawnSession);

    const result = await handler({
      v: 1,
      parentSessionId: 'sess_parent',
      forkPoint: { type: 'latest' },
      strategy: 'replay',
    });

    expect(result).toMatchObject({ ok: true, childSessionId: 'sess_child' });
    // Retrieval must not re-resolve "latest": a row committed after the
    // lifecycle admitted the parent head would otherwise enter the child's seed
    // while its recorded lineage still names that head.
    expect(resolveReplaySeedDraft).toHaveBeenCalledWith(expect.objectContaining({
      source: {
        kind: 'fork_chain',
        previousSessionId: 'sess_parent',
        upToSeqInclusive: PARENT_HEAD_SEQ,
      },
    }));
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

  it('retains a possibly admitted child and reports the launch envelope when spawn outcome is unexpected', async () => {
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
    // `UNEXPECTED` may be a lost response after the daemon admitted the
    // runner. The canonical creator may archive only definite pre-admission
    // rejections, otherwise this retry could delete a live child.
    expect(archiveSessionByIdBestEffort).not.toHaveBeenCalled();
  });

  // The caller's `requestId` is the identity of ONE fork attempt, and it is the
  // only part of the request that outlives this process. Deriving the creation
  // tag from it is what makes a retry idempotent ACROSS a daemon restart: the
  // server's tag-keyed get-or-create rejoins the row the first attempt made
  // rather than committing a second child. A tag minted from a fresh UUID makes
  // every retry a new Session, and an in-process result cache cannot help once
  // the process is gone.
  it('derives the creation identity from the caller attempt id so a retry rejoins one row', async () => {
    const spawnSession = vi.fn(async () => ({ type: 'success', sessionId: 'sess_child' } as const));
    const handler = registerForkHandler(spawnSession);
    const request = {
      v: 1,
      parentSessionId: 'sess_parent',
      forkPoint: { type: 'latest' },
      strategy: 'replay',
      requestId: 'attempt-7',
    };

    await expect(handler(request)).resolves.toMatchObject({ ok: true, childSessionId: 'sess_child' });
    await expect(handler(request)).resolves.toMatchObject({ ok: true, childSessionId: 'sess_child' });

    const tags = getOrCreateSessionByTag.mock.calls.map((call) => (call[0] as { tag: string }).tag);
    expect(tags).toHaveLength(2);
    expect(tags[0]).toContain('attempt-7');
    expect(tags[1]).toBe(tags[0]);
  });

  it('re-attempts a failed fork instead of replaying the failure to the caller', async () => {
    const spawnSession = vi.fn()
      .mockResolvedValueOnce({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'machine hiccup',
      })
      .mockResolvedValue({ type: 'success', sessionId: 'sess_child' });
    const handler = registerForkHandler(spawnSession);
    const request = {
      v: 1,
      parentSessionId: 'sess_parent',
      forkPoint: { type: 'latest' },
      strategy: 'replay',
      requestId: 'attempt-8',
    };

    await expect(handler(request)).resolves.toMatchObject({ ok: false });

    // Retry is the user's only recovery. A cached failure makes the button inert
    // for as long as the entry lives, with nothing on screen saying so.
    await expect(handler(request)).resolves.toMatchObject({ ok: true, childSessionId: 'sess_child' });
  });

  it('coalesces concurrent retries for one request id before creating another child', async () => {
    let resolveSpawn!: (result: { type: 'success'; sessionId: string }) => void;
    const spawnSession = vi.fn(() => new Promise<{ type: 'success'; sessionId: string }>((resolve) => {
      resolveSpawn = resolve;
    }));
    const handler = registerForkHandler(spawnSession);
    const request = {
      v: 1,
      parentSessionId: 'sess_parent',
      forkPoint: { type: 'latest' },
      strategy: 'replay',
      requestId: 'attempt-9',
    };

    const first = handler(request);
    await vi.waitFor(() => expect(spawnSession).toHaveBeenCalledTimes(1));

    const second = handler(request);
    expect(spawnSession).toHaveBeenCalledTimes(1);
    expect(getOrCreateSessionByTag).toHaveBeenCalledTimes(1);

    resolveSpawn({ type: 'success', sessionId: 'sess_child' });
    await expect(Promise.all([first, second])).resolves.toEqual([
      { ok: true, childSessionId: 'sess_child' },
      { ok: true, childSessionId: 'sess_child' },
    ]);
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
