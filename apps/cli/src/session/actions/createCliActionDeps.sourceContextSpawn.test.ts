import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Credentials } from '@/persistence';

/**
 * `session.spawn_new` + `sourceContext` on the predecessor Action ingress.
 *
 * The recipe must reach the one canonical creator as a Replay-seeded creation,
 * and an unresolvable source must create no child at all — an ingress that
 * accepted the request and dropped the recipe would produce an ordinary blank
 * Session and report success.
 */
const mocks = vi.hoisted(() => ({
  createSpawnedSession: vi.fn(async (_params: Readonly<{
    replaySeededCreation?: Readonly<{
      tag: string;
      agentId: string;
      metadata: Record<string, unknown>;
      sourceRecipe: Readonly<{ sourceSessionId: string; cutoffSeqInclusive: number }>;
    }>;
  }>) => ({
    sessionId: 'sess_child',
    created: true,
    session: { id: 'sess_child' },
  })),
  // Transcript retrieval is the HTTP boundary beneath the recipe owner; the real
  // `buildReplaySeededSpawnRecipe` stays in the path.
  resolveReplaySeedDraft: vi.fn(async (): Promise<unknown> => ({
    status: 'seeded',
    seedDraft: 'replayed dialog',
    dialog: [],
    summaryText: null,
    sourceCutoffSeqInclusive: 12,
  })),
  readSettings: vi.fn(async () => ({ machineId: 'machine-local' })),
  fetchSessionByIdCompat: vi.fn(),
}));

vi.mock('@/session/services/createSpawnedSession', () => ({
  createSpawnedSession: mocks.createSpawnedSession,
}));

vi.mock('@/session/replay/resolveReplaySeedDraft', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/session/replay/resolveReplaySeedDraft')>()),
  resolveReplaySeedDraft: mocks.resolveReplaySeedDraft,
}));

vi.mock('@/persistence', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/persistence')>()),
  readSettings: mocks.readSettings,
}));

vi.mock('@/session/transport/http/sessionsHttp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/session/transport/http/sessionsHttp')>()),
  fetchSessionByIdCompat: mocks.fetchSessionByIdCompat,
}));

import { createCliActionDeps } from './createCliActionDeps';

const SOURCE_CONTEXT = {
  v: 1,
  kind: 'session_replay',
  sourceSessionId: 'sess_source',
  forkPoint: { type: 'seq', upToSeqInclusive: 12 },
} as const;

function createCredentials(): Credentials {
  return {
    token: 'token',
    encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
  };
}

function createDeps() {
  return createCliActionDeps({
    token: 'token',
    credentials: createCredentials(),
    sessionId: 'sess_1',
    ctx: {
      encryptionKey: new Uint8Array(32).fill(1),
      encryptionVariant: 'legacy',
    },
    mode: 'plain',
    rawSession: { metadata: {} },
  } as any);
}

describe('createCliActionDeps session.spawn_new sourceContext', () => {
  beforeEach(() => {
    mocks.createSpawnedSession.mockReset();
    mocks.createSpawnedSession.mockResolvedValue({
      sessionId: 'sess_child',
      created: true,
      session: { id: 'sess_child' },
    });
    mocks.resolveReplaySeedDraft.mockReset();
    mocks.resolveReplaySeedDraft.mockResolvedValue({
      status: 'seeded',
      seedDraft: 'replayed dialog',
      dialog: [],
      summaryText: null,
      sourceCutoffSeqInclusive: 12,
    });
    mocks.readSettings.mockReset();
    mocks.readSettings.mockResolvedValue({ machineId: 'machine-local' });
    mocks.fetchSessionByIdCompat.mockReset();
    mocks.fetchSessionByIdCompat.mockResolvedValue({ share: null });
  });

  it('delegates a sourceContext spawn to the canonical creator as a replay-seeded creation', async () => {
    const deps = createDeps();

    const result = await deps.sessionSpawnNew({
      directory: '/repo',
      agentId: 'claude',
      sourceContext: SOURCE_CONTEXT,
    } as any);

    expect(result).toMatchObject({ type: 'success', sessionId: 'sess_child' });
    expect(mocks.createSpawnedSession).toHaveBeenCalledTimes(1);

    const createParams = mocks.createSpawnedSession.mock.calls[0]![0];

    // The recipe reached the canonical creator rather than being dropped.
    expect(createParams.replaySeededCreation).toBeDefined();
    const creation = createParams.replaySeededCreation!;
    expect(creation.agentId).toBe('claude');
    expect(creation.tag.trim().length).toBeGreaterThan(0);
    expect(creation.sourceRecipe).toEqual({ sourceSessionId: 'sess_source', cutoffSeqInclusive: 12 });
    expect(creation.metadata).toMatchObject({
      forkV1: {
        v: 1,
        parentSessionId: 'sess_source',
        parentCutoffSeqInclusive: 12,
        strategy: 'replay',
        providerHint: { providerId: 'claude' },
      },
      replaySeedV1: {
        v: 1,
        seedText: 'replayed dialog',
        sourceSessionId: 'sess_source',
        sourceCutoffSeqInclusive: 12,
      },
    });
    expect(creation.metadata).not.toHaveProperty('sessionMediaContinuityV1');
  });

  it('creates no child when the source recipe cannot be resolved', async () => {
    mocks.resolveReplaySeedDraft.mockResolvedValue({ status: 'unavailable' });
    const deps = createDeps();

    const result = await deps.sessionSpawnNew({
      directory: '/repo',
      agentId: 'claude',
      sourceContext: SOURCE_CONTEXT,
    } as any);

    expect(result).toMatchObject({ type: 'error' });
    expect(mocks.createSpawnedSession).not.toHaveBeenCalled();
  });

  it('refuses a shared sourceContext before it creates a child Session', async () => {
    mocks.fetchSessionByIdCompat.mockResolvedValue({
      share: { accessLevel: 'edit', canApprovePermissions: false },
    });
    const deps = createDeps();

    const result = await deps.sessionSpawnNew({
      directory: '/repo',
      agentId: 'claude',
      sourceContext: SOURCE_CONTEXT,
    } as any);

    expect(result).toMatchObject({ type: 'error', errorCode: 'permission_denied' });
    expect(mocks.createSpawnedSession).not.toHaveBeenCalled();
  });

  it('leaves an ordinary spawn without a recipe on the plain creation path', async () => {
    const deps = createDeps();

    await deps.sessionSpawnNew({ directory: '/repo', agentId: 'claude' } as any);

    expect(mocks.createSpawnedSession).toHaveBeenCalledTimes(1);
    expect(mocks.createSpawnedSession.mock.calls[0]![0]).not.toHaveProperty('replaySeededCreation');
    expect(mocks.resolveReplaySeedDraft).not.toHaveBeenCalled();
  });
});
