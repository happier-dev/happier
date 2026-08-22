import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The seed is the only thing the target Agent is told about the conversation it
 * inherits, so this owner has to hand the framer facts that are true: which
 * Session the history came from, and whether all of it could be read.
 *
 * Both were lost here. Every caller resolved through `fork_chain`, so the
 * in-place Agent transition asked for a seed naming its OWN Session as its
 * predecessor; and the hydrator's incompleteness fact had nowhere to go, so a
 * conversation with holes was framed as the conversation.
 *
 * `hydrateReplayDialogFromForkChain` is the genuine boundary mocked here — it
 * performs the bounded paged retrieval and decryption.
 */
const mocks = vi.hoisted(() => ({
  hydrateReplayDialogFromForkChain: vi.fn(),
}));

vi.mock('@/session/replay/hydrateReplayDialogFromForkChain', () => ({
  hydrateReplayDialogFromForkChain: mocks.hydrateReplayDialogFromForkChain,
}));

const CREDENTIALS = { token: 'token', secret: new Uint8Array(32) } as never;

type Source = Parameters<typeof import('./resolveReplaySeedDraft').resolveReplaySeedDraft>[0]['source'];

async function resolve(source: Source, sourceAgentLabel?: string) {
  const { resolveReplaySeedDraft } = await import('./resolveReplaySeedDraft');
  return await resolveReplaySeedDraft({
    credentials: CREDENTIALS,
    cwd: '/workspace',
    source,
    strategy: 'recent_messages',
    recentMessagesCount: 8,
    maxSeedChars: 4_000,
    candidateLimit: 8,
    ...(sourceAgentLabel === undefined ? {} : { sourceAgentLabel }),
  });
}

function hydrated(overrides?: Readonly<{ historyIncomplete?: boolean }>) {
  return {
    dialog: [{ role: 'User', createdAt: 1, text: 'hello there' }],
    sourceCutoffSeqInclusive: 7,
    referencedSessionMediaWorkspacePaths: [],
    historyIncomplete: overrides?.historyIncomplete ?? false,
  };
}

describe('resolveReplaySeedDraft — truthful framing', () => {
  beforeEach(() => {
    mocks.hydrateReplayDialogFromForkChain.mockReset();
  });

  it('does not frame an in-place Agent change as continuing from another Session', async () => {
    mocks.hydrateReplayDialogFromForkChain.mockResolvedValueOnce(hydrated());

    const resolved = await resolve({ kind: 'same_session_agent_change', sessionId: 'session-1', upToSeqInclusive: 9 });

    expect(resolved.status).toBe('seeded');
    if (resolved.status !== 'seeded') return;
    expect(resolved.seedDraft).not.toContain('Previous session id:');
    // Since the container restructure the same-Session identity is the
    // `<session_context>` attribute rather than a `Session id:` body line; a
    // `previous_session` id deliberately never becomes the container identity,
    // which is what makes this assertion discriminating.
    expect(resolved.seedDraft).toContain('session_id="session-1"');
    // The chain walk is unchanged: this Session is still the starting point.
    expect(mocks.hydrateReplayDialogFromForkChain).toHaveBeenCalledWith(
      expect.objectContaining({ startingSessionId: 'session-1', upToSeqInclusive: 9 }),
    );
  });

  it('still frames a replay-seeded new Session as continuing from its source', async () => {
    mocks.hydrateReplayDialogFromForkChain.mockResolvedValueOnce(hydrated());

    const resolved = await resolve({ kind: 'fork_chain', previousSessionId: 'session-1', upToSeqInclusive: 9 });

    expect(resolved.status).toBe('seeded');
    if (resolved.status !== 'seeded') return;
    expect(resolved.seedDraft).toContain('Previous session id: session-1');
  });

  it('states the replay is incomplete when the hydrator could not read part of the history', async () => {
    mocks.hydrateReplayDialogFromForkChain.mockResolvedValueOnce(hydrated({ historyIncomplete: true }));

    const resolved = await resolve({ kind: 'fork_chain', previousSessionId: 'session-1' });

    expect(resolved.status).toBe('seeded');
    if (resolved.status !== 'seeded') return;
    expect(resolved.seedDraft).toContain('could not be read');
  });

  it('claims no incompleteness when the whole examined range was read', async () => {
    mocks.hydrateReplayDialogFromForkChain.mockResolvedValueOnce(hydrated());

    const resolved = await resolve({ kind: 'fork_chain', previousSessionId: 'session-1' });

    expect(resolved.status).toBe('seeded');
    if (resolved.status !== 'seeded') return;
    expect(resolved.seedDraft).not.toContain('could not be read');
  });

  it('renders the production-supplied source Agent label for an in-place change', async () => {
    mocks.hydrateReplayDialogFromForkChain.mockResolvedValueOnce(hydrated());

    const resolved = await resolve(
      { kind: 'same_session_agent_change', sessionId: 'session-1', upToSeqInclusive: 9 },
      'Claude',
    );

    expect(resolved.status).toBe('seeded');
    if (resolved.status !== 'seeded') return;
    expect(resolved.seedDraft).toContain('- Original agent: Claude');
  });
});
