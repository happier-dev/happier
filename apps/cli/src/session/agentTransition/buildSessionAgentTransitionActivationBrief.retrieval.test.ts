import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ resolveReplaySeedDraft: vi.fn() }));

vi.mock('@/session/replay/resolveReplaySeedDraft', () => ({
  resolveReplaySeedDraft: mocks.resolveReplaySeedDraft,
}));

const { buildBoundedActivationBrief } = await import('./buildSessionAgentTransitionActivationBrief');

const NATIVE_LOG_PATH = join(mkdtempSync(join(tmpdir(), 'happier-brief-log-')), 'session.jsonl');
writeFileSync(NATIVE_LOG_PATH, '{}\n');

/**
 * A Codex source keeps a log too, but persists no path for it: the file is named
 * after the vendor resume id under the Agent's own date-partitioned sessions
 * root. Building a real one lets the pointer be proven end to end through the
 * catalog rather than against a stubbed resolver.
 */
const CODEX_VENDOR_RESUME_ID = '019e7cfd-2e3d-74f0-be76-b7459424f0a8';
const CODEX_HOME = join(mkdtempSync(join(tmpdir(), 'happier-brief-codex-')), 'codex-home');
const CODEX_ROLLOUT_PATH = join(
  CODEX_HOME,
  'sessions',
  '2026',
  '08',
  '17',
  `rollout-2026-08-17T10-00-00-${CODEX_VENDOR_RESUME_ID}.jsonl`,
);
mkdirSync(join(CODEX_HOME, 'sessions', '2026', '08', '17'), { recursive: true });
writeFileSync(CODEX_ROLLOUT_PATH, '{}\n');

type Retrieval = {
  sessionId: string;
  renderInvocation: ((cursorSeq: number | null) => string) | null;
  nativeTranscriptPath: string | null;
} | null;

async function buildWith(input: Readonly<{
  targetAgentId?: string;
  sourceAgentId?: string;
  metadata?: Record<string, unknown>;
}>): Promise<Retrieval> {
  mocks.resolveReplaySeedDraft.mockReset();
  mocks.resolveReplaySeedDraft.mockResolvedValue({ status: 'no_source_dialog' });
  const sourceMetadata = { path: '/home/u/project', ...(input.metadata ?? {}) };
  await buildBoundedActivationBrief({
    credentials: { token: 't' } as never,
    sessionId: 'sess_1',
    transcriptHeadSeqInclusive: 42,
    sourceMetadata,
    // The transition's basis: the Session is stopped on the source Agent, so its
    // current view still IS the departing Agent's. The read-only rebuild passes
    // `null` here instead, which is covered where that basis is decided.
    departingAgentCurrentView: sourceMetadata,
    ...(input.targetAgentId === undefined ? {} : { targetAgentId: input.targetAgentId }),
    ...(input.sourceAgentId === undefined ? {} : { sourceAgentId: input.sourceAgentId }),
  });
  return (mocks.resolveReplaySeedDraft.mock.calls[0]?.[0] as { retrieval?: Retrieval }).retrieval ?? null;
}

/**
 * Section 9's retrieval pointer, at the one owner that composes it. Both halves
 * are complementary — a source that kept no log leaves only the Happier
 * transcript, and a target reaching further back than the Session's window may
 * only get there through the log — so neither may be suppressed because the
 * other resolved.
 */
describe('buildBoundedActivationBrief — retrieval pointer', () => {
  let previousCodexHome: string | undefined;

  beforeEach(() => {
    previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = CODEX_HOME;
  });

  afterEach(() => {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
  });

  it('renders an invocation for a target that is given Happier tools', async () => {
    const retrieval = await buildWith({ targetAgentId: 'codex' });
    expect(retrieval?.sessionId).toBe('sess_1');
    expect(retrieval?.renderInvocation?.(4_200)).toContain('session.transcript.get');
  });

  it('hands down no pointer at all for a target the host gives no Happier tools', async () => {
    // Both runtime channels are gated on the same catalog declaration, so naming
    // one for an `unsupported` Agent would be a false instruction — and with no
    // native log either, there is nothing honest left to say.
    expect(await buildWith({ targetAgentId: 'antigravity' })).toBeNull();
  });

  it('still hands down the native log for a target that cannot run Happier tools', async () => {
    const retrieval = await buildWith({
      targetAgentId: 'antigravity',
      sourceAgentId: 'claude',
      metadata: { claudeSessionId: 'claude-1', claudeTranscriptPath: NATIVE_LOG_PATH },
    });
    expect(retrieval?.renderInvocation).toBeNull();
    expect(retrieval?.nativeTranscriptPath).toBe(NATIVE_LOG_PATH);
  });

  it('reads the native log through the catalog-declared proof slot, not a vendor key name', async () => {
    // `codex` declares no continuity proof field, so the same metadata key must
    // not become a log path just because it is present.
    const retrieval = await buildWith({
      targetAgentId: 'claude',
      sourceAgentId: 'codex',
      metadata: { claudeSessionId: 'claude-1', claudeTranscriptPath: NATIVE_LOG_PATH },
    });
    expect(retrieval?.nativeTranscriptPath).toBeNull();
  });

  it('hands down the native log of a source Agent that derives the path instead of persisting it', async () => {
    // Codex declares no continuity-proof field, so the proof slot is empty and the
    // Session was handed over with no log at all. The path is still knowable from
    // the vendor resume id, and the Agent that knows how declares the derivation.
    const retrieval = await buildWith({
      targetAgentId: 'claude',
      sourceAgentId: 'codex',
      metadata: { codexSessionId: CODEX_VENDOR_RESUME_ID },
    });
    expect(retrieval?.nativeTranscriptPath).toBe(CODEX_ROLLOUT_PATH);
  });

  it('names no derived native log when this machine holds no such file', async () => {
    const retrieval = await buildWith({
      targetAgentId: 'claude',
      sourceAgentId: 'codex',
      metadata: { codexSessionId: '019e7cfd-0000-0000-0000-000000000000' },
    });
    expect(retrieval?.nativeTranscriptPath ?? null).toBeNull();
  });

  it('names no native log when the source Agent published no resume identity', async () => {
    const retrieval = await buildWith({
      targetAgentId: 'codex',
      sourceAgentId: 'claude',
      metadata: { claudeTranscriptPath: NATIVE_LOG_PATH },
    });
    expect(retrieval?.nativeTranscriptPath).toBeNull();
  });

  it('passes the canonical source Agent display title to the replay owner', async () => {
    await buildWith({ targetAgentId: 'codex', sourceAgentId: 'claude' });

    expect(mocks.resolveReplaySeedDraft).toHaveBeenCalledWith(
      expect.objectContaining({ sourceAgentLabel: 'Claude' }),
    );
  });
});

/**
 * The delta boundary, at the seam where it leaves this owner (`AM-26`).
 *
 * It is asserted here rather than only at the coordinator because this is the
 * hop that turns "the returning Agent last saw seq D" into the replay owner's
 * source descriptor, and a silent drop here would look exactly like a fresh
 * target: full replay, no error, nothing in the result saying so.
 */
describe('buildBoundedActivationBrief — native-return delta boundary', () => {
  async function readSource(
    input?: Readonly<{ returningAgentLastSeenSeq?: number | null }>,
  ): Promise<Record<string, unknown>> {
    mocks.resolveReplaySeedDraft.mockReset();
    mocks.resolveReplaySeedDraft.mockResolvedValue({ status: 'no_source_dialog' });
    const sourceMetadata = { path: '/home/u/project' };
    await buildBoundedActivationBrief({
      credentials: { token: 't' } as never,
      sessionId: 'sess_1',
      transcriptHeadSeqInclusive: 42,
      sourceMetadata,
      departingAgentCurrentView: sourceMetadata,
      targetAgentId: 'claude',
      sourceAgentId: 'codex',
      ...(input?.returningAgentLastSeenSeq === undefined
        ? {}
        : { returningAgentLastSeenSeq: input.returningAgentLastSeenSeq }),
    });
    return (mocks.resolveReplaySeedDraft.mock.calls[0]?.[0] as {
      source: Record<string, unknown>;
    }).source;
  }

  it('forwards the boundary into the replay owner’s source descriptor', async () => {
    expect(await readSource({ returningAgentLastSeenSeq: 130 })).toEqual({
      kind: 'same_session_agent_change',
      sessionId: 'sess_1',
      upToSeqInclusive: 42,
      returningAgentLastSeenSeq: 130,
    });
  });

  it.each([
    ['omitted', undefined],
    ['explicitly null', null],
  ])('leaves the key ABSENT when the boundary is %s', async (_label, returningAgentLastSeenSeq) => {
    // Absent, not `0` and not `undefined`-valued: a fresh target must produce
    // byte-identically the pre-change descriptor, and a `0` bound would starve
    // it to an away-delta of a departure that never happened.
    const source = await readSource(
      returningAgentLastSeenSeq === undefined ? {} : { returningAgentLastSeenSeq },
    );
    expect(source).not.toHaveProperty('returningAgentLastSeenSeq');
    expect(source).toEqual({
      kind: 'same_session_agent_change',
      sessionId: 'sess_1',
      upToSeqInclusive: 42,
    });
  });
});
