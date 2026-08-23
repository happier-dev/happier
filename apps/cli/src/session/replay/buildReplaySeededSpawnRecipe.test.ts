import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { StoredCredentials } from '@/persistence';
import { SPAWN_SESSION_ERROR_CODES } from '@/session/shared/spawnSessionContract';

const resolveReplaySeedDraft = vi.hoisted(() => vi.fn());

vi.mock('@/session/replay/resolveReplaySeedDraft', () => ({
  resolveReplaySeedDraft: (...args: unknown[]) => resolveReplaySeedDraft(...args),
}));

import { buildReplaySeededSpawnRecipe } from './buildReplaySeededSpawnRecipe';

const credentials = {
  token: 'token',
  encryption: { type: 'legacy', secret: new Uint8Array([1]) },
} as unknown as StoredCredentials;

describe('buildReplaySeededSpawnRecipe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveReplaySeedDraft.mockResolvedValue({
      status: 'seeded',
      seedDraft: 'Continue this conversation',
      dialog: [],
      summaryText: null,
      sourceCutoffSeqInclusive: 12,
      referencedSessionMediaWorkspacePaths: [],
    });
  });

  it('composes the canonical envelopes above caller metadata', async () => {
    const result = await buildReplaySeededSpawnRecipe({
      credentials,
      cwd: '/repo',
      source: { sourceSessionId: 'parent', forkPoint: { type: 'latest' } },
      agentHintAgentId: 'codex',
      requestId: 'fork-request-1',
      extraMetadata: { connectedServices: { v: 1 }, forkV1: { v: 1, bogus: true } },
      nowMs: 1000,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.recipe.metadata.connectedServices).toEqual({ v: 1 });
    // A caller overlay can never win over the canonical lineage envelopes.
    expect(result.recipe.metadata.forkV1).toEqual({
      v: 1,
      parentSessionId: 'parent',
      parentCutoffSeqInclusive: 12,
      createdAtMs: 1000,
      strategy: 'replay',
      requestId: 'fork-request-1',
      agentHint: { agentId: 'codex' },
    });
    expect(result.recipe.metadata.replaySeedV1).toMatchObject({
      seedText: 'Continue this conversation',
      sourceSessionId: 'parent',
      sourceCutoffSeqInclusive: 12,
    });
  });

  it('pins the caller-supplied lineage cutoff over the retrieval-resolved one', async () => {
    const result = await buildReplaySeededSpawnRecipe({
      credentials,
      cwd: '/repo',
      source: { sourceSessionId: 'parent', forkPoint: { type: 'seq', upToSeqInclusive: 5 } },
      agentHintAgentId: 'codex',
      lineageCutoffSeqInclusive: 5,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.recipe.cutoffSeqInclusive).toBe(5);
    expect(result.recipe.metadata.forkV1).toMatchObject({ parentCutoffSeqInclusive: 5 });
    expect(result.recipe.metadata.replaySeedV1).toMatchObject({ sourceCutoffSeqInclusive: 5 });
    expect(resolveReplaySeedDraft.mock.calls[0]?.[0].source).toMatchObject({
      kind: 'fork_chain',
      previousSessionId: 'parent',
      upToSeqInclusive: 5,
    });
  });

  it('omits media continuity when the creator cannot prove it runs the child', async () => {
    resolveReplaySeedDraft.mockResolvedValue({
      status: 'seeded',
      seedDraft: 'Continue this conversation',
      dialog: [],
      summaryText: null,
      sourceCutoffSeqInclusive: 12,
      referencedSessionMediaWorkspacePaths: ['/repo/.happier/media/a.png'],
    });

    const usable = await buildReplaySeededSpawnRecipe({
      credentials,
      cwd: '/repo',
      source: { sourceSessionId: 'parent', forkPoint: { type: 'latest' } },
      agentHintAgentId: 'codex',
      mediaContinuityUsableOnCreatingMachine: true,
    });
    const crossMachine = await buildReplaySeededSpawnRecipe({
      credentials,
      cwd: '/repo',
      source: { sourceSessionId: 'parent', forkPoint: { type: 'latest' } },
      agentHintAgentId: 'codex',
      mediaContinuityUsableOnCreatingMachine: false,
    });

    expect(usable.ok && usable.recipe.metadata.sessionMediaContinuityV1).toMatchObject({
      referencedWorkspacePaths: ['/repo/.happier/media/a.png'],
    });
    expect(crossMachine.ok && crossMachine.recipe.metadata).not.toHaveProperty('sessionMediaContinuityV1');
    // The dropped references stay visible so a caller can explain the loss.
    expect(crossMachine.ok && crossMachine.recipe.referencedSessionMediaWorkspacePaths)
      .toEqual(['/repo/.happier/media/a.png']);
  });

  it('uses the explicit retrieval strategy when the ingress exposes one', async () => {
    await buildReplaySeededSpawnRecipe({
      credentials,
      cwd: '/repo',
      source: { sourceSessionId: 'parent', forkPoint: { type: 'latest' } },
      agentHintAgentId: 'codex',
      strategy: 'summary_plus_recent',
      summaryRunner: null,
    });
    expect(resolveReplaySeedDraft.mock.calls[0]?.[0].strategy).toBe('summary_plus_recent');

    resolveReplaySeedDraft.mockClear();
    await buildReplaySeededSpawnRecipe({
      credentials,
      cwd: '/repo',
      source: { sourceSessionId: 'parent', forkPoint: { type: 'latest' } },
      agentHintAgentId: 'codex',
      summaryRunner: { v: 1 } as never,
    });
    expect(resolveReplaySeedDraft.mock.calls[0]?.[0].strategy).toBe('summary_plus_recent');
  });

  it('reports an unresolvable or empty source without composing a recipe', async () => {
    resolveReplaySeedDraft.mockResolvedValueOnce({ status: 'unavailable' });
    const unresolvable = await buildReplaySeededSpawnRecipe({
      credentials,
      cwd: '/repo',
      source: { sourceSessionId: 'parent', forkPoint: { type: 'latest' } },
      agentHintAgentId: 'codex',
    });
    expect(unresolvable).toMatchObject({
      ok: false,
      errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
      errorMessage: 'Unable to hydrate replay dialog from transcript.',
    });

    // The seed owner now names an empty source rather than handing back a
    // blank draft, so the recipe consumes that fact instead of re-deriving it.
    resolveReplaySeedDraft.mockResolvedValueOnce({ status: 'no_source_dialog' });
    const empty = await buildReplaySeededSpawnRecipe({
      credentials,
      cwd: '/repo',
      source: { sourceSessionId: 'parent', forkPoint: { type: 'latest' } },
      agentHintAgentId: 'codex',
    });
    expect(empty).toMatchObject({
      ok: false,
      errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
      errorMessage: 'Replay seed draft is empty',
    });
  });
});
