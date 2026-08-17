import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * "There is nothing to replay" and "the bounded retrieval failed" are different
 * facts, and the difference is load-bearing for exactly one consumer: the
 * same-Session Agent transition, which asks this question AFTER it has already
 * stopped the source runtime.
 *
 * While both collapsed into `null`, a Session whose Agent had produced no
 * user/assistant dialog — a brand-new Session where the user switches Agent
 * before sending anything, which is the most likely first-run moment to try the
 * feature — was stopped and then told the transition failed with
 * `context_unavailable`. An empty transcript is the trivially satisfiable case:
 * there is nothing to carry over, so there is nothing that can fail.
 *
 * `hydrateReplayDialogFromForkChain` is the genuine boundary mocked here: it
 * performs the bounded paged transcript retrieval and decryption. It already
 * distinguishes the two — `null` for a failed hydration, `dialog: []` for a
 * source with no dialog — and this owner is where that distinction was lost.
 *
 * The coordinator suite covers the transition's use of this answer; this file
 * pins the owner's own contract, so a future collapse is caught at the place it
 * would be reintroduced rather than one layer up.
 */
const mocks = vi.hoisted(() => ({
  hydrateReplayDialogFromForkChain: vi.fn(),
}));

vi.mock('@/session/replay/hydrateReplayDialogFromForkChain', () => ({
  hydrateReplayDialogFromForkChain: mocks.hydrateReplayDialogFromForkChain,
}));

const CREDENTIALS = { token: 'token', secret: new Uint8Array(32) } as never;

async function resolve() {
  const { resolveReplaySeedDraft } = await import('./resolveReplaySeedDraft');
  return await resolveReplaySeedDraft({
    credentials: CREDENTIALS,
    cwd: '/workspace',
    source: { kind: 'fork_chain', previousSessionId: 'session-1', upToSeqInclusive: 0 },
    strategy: 'recent_messages',
    recentMessagesCount: 8,
    maxSeedChars: 4_000,
    candidateLimit: 8,
  });
}

describe('resolveReplaySeedDraft — empty source vs failed retrieval', () => {
  beforeEach(() => {
    mocks.hydrateReplayDialogFromForkChain.mockReset();
  });

  it('reports a source with no dialog distinctly from a failed retrieval', async () => {
    mocks.hydrateReplayDialogFromForkChain.mockResolvedValueOnce({
      dialog: [],
      sourceCutoffSeqInclusive: 0,
      referencedSessionMediaWorkspacePaths: [],
    });
    const empty = await resolve();

    mocks.hydrateReplayDialogFromForkChain.mockResolvedValueOnce(null);
    const failed = await resolve();

    expect(empty.status).toBe('no_source_dialog');
    expect(failed.status).toBe('unavailable');
  });

  it('reports a dialog that yields no usable prompt text as an empty source, not a failure', async () => {
    // Retrieval succeeded; the rows simply carry nothing replayable. Nothing
    // failed, so nothing may be reported as unavailable.
    mocks.hydrateReplayDialogFromForkChain.mockResolvedValueOnce({
      dialog: [{ role: 'user', text: '   ' }],
      sourceCutoffSeqInclusive: 3,
      referencedSessionMediaWorkspacePaths: [],
    });
    expect((await resolve()).status).toBe('no_source_dialog');
  });

  it('still carries the seed when the source has dialog', async () => {
    mocks.hydrateReplayDialogFromForkChain.mockResolvedValueOnce({
      dialog: [{ role: 'user', text: 'hello there' }],
      sourceCutoffSeqInclusive: 7,
      referencedSessionMediaWorkspacePaths: [],
    });
    const resolved = await resolve();
    expect(resolved.status).toBe('seeded');
    if (resolved.status !== 'seeded') return;
    expect(resolved.seedDraft).toContain('hello there');
    expect(resolved.sourceCutoffSeqInclusive).toBe(7);
  });
});
