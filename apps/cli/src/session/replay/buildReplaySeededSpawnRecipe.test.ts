import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Credentials } from '@/persistence';

const fetchSessionByIdCompat = vi.hoisted(() => vi.fn());
const fetchEncryptedTranscriptMessages = vi.hoisted(() => vi.fn());

vi.mock('@/session/transport/http/sessionsHttp', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/session/transport/http/sessionsHttp')>(),
  fetchSessionByIdCompat,
}));

vi.mock('@/session/replay/fetchEncryptedTranscriptMessages', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/session/replay/fetchEncryptedTranscriptMessages')>(),
  fetchEncryptedTranscriptMessages,
}));

import { buildReplaySeededSpawnRecipe } from './buildReplaySeededSpawnRecipe';

const credentials: Credentials = {
  token: 'token-1',
  encryption: { type: 'legacy', secret: new Uint8Array(32).fill(3) },
};

/** The source Session's own head, which a `latest` retrieval resolves as its cutoff. */
const SOURCE_HEAD_SEQ = 9;
/** The earlier fork point the fork lifecycle already admitted for this attempt. */
const ADMITTED_FORK_CUTOFF = 4;

describe('buildReplaySeededSpawnRecipe', () => {
  beforeEach(() => {
    fetchSessionByIdCompat.mockReset();
    fetchEncryptedTranscriptMessages.mockReset();
    fetchSessionByIdCompat.mockResolvedValue({
      id: 'sess_parent',
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
    });
    fetchEncryptedTranscriptMessages.mockResolvedValue([
      {
        seq: 1,
        createdAt: 1,
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'a question' } } },
      },
    ]);
  });

  it('records the retrieval-resolved cutoff as lineage by default', async () => {
    const result = await buildReplaySeededSpawnRecipe({
      credentials,
      cwd: '/repo',
      source: { sourceSessionId: 'sess_parent', forkPoint: { type: 'latest' } },
      providerHintAgentId: 'claude',
      strategy: 'recent_messages',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.recipe.cutoffSeqInclusive).toBe(SOURCE_HEAD_SEQ);
    expect(result.recipe.metadata).toMatchObject({
      forkV1: { parentCutoffSeqInclusive: SOURCE_HEAD_SEQ },
      replaySeedV1: { sourceCutoffSeqInclusive: SOURCE_HEAD_SEQ },
    });
  });

  it('pins persisted lineage to the caller-admitted cutoff for a latest fork', async () => {
    const result = await buildReplaySeededSpawnRecipe({
      credentials,
      cwd: '/repo',
      source: { sourceSessionId: 'sess_parent', forkPoint: { type: 'latest' } },
      providerHintAgentId: 'claude',
      strategy: 'recent_messages',
      lineageCutoffSeqInclusive: ADMITTED_FORK_CUTOFF,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Immutable child lineage names the fork point the fork lifecycle admitted,
    // never the neighbour a `latest` retrieval resolved for itself.
    expect(result.recipe.cutoffSeqInclusive).toBe(ADMITTED_FORK_CUTOFF);
    expect(result.recipe.metadata).toMatchObject({
      forkV1: { parentSessionId: 'sess_parent', parentCutoffSeqInclusive: ADMITTED_FORK_CUTOFF, strategy: 'replay' },
      replaySeedV1: { sourceSessionId: 'sess_parent', sourceCutoffSeqInclusive: ADMITTED_FORK_CUTOFF },
    });
  });

  it('merges caller metadata beneath the canonical envelopes', async () => {
    const result = await buildReplaySeededSpawnRecipe({
      credentials,
      cwd: '/repo',
      source: { sourceSessionId: 'sess_parent', forkPoint: { type: 'latest' } },
      providerHintAgentId: 'claude',
      strategy: 'recent_messages',
      extraMetadata: {
        inheritedSetting: 'kept',
        // A caller overlay must never win over canonical child lineage.
        forkV1: { v: 1, parentSessionId: 'sess_wrong', parentCutoffSeqInclusive: 999 },
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.recipe.metadata.inheritedSetting).toBe('kept');
    expect(result.recipe.metadata.forkV1).toMatchObject({
      parentSessionId: 'sess_parent',
      parentCutoffSeqInclusive: SOURCE_HEAD_SEQ,
      providerHint: { providerId: 'claude' },
    });
    expect(result.recipe.metadata).not.toHaveProperty('sessionMediaContinuityV1');
  });
});
