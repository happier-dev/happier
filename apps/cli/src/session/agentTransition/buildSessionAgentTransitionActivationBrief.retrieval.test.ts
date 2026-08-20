import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ resolveReplaySeedDraft: vi.fn() }));

vi.mock('@/session/replay/resolveReplaySeedDraft', () => ({
  resolveReplaySeedDraft: mocks.resolveReplaySeedDraft,
}));

const { buildSessionAgentTransitionActivationBrief } = await import(
  './buildSessionAgentTransitionActivationBrief'
);

/** Claude's route: the Agent recorded the path itself, so metadata already holds it. */
const CLAUDE_LOG_PATH = join(mkdtempSync(join(tmpdir(), 'happier-brief-log-')), 'session.jsonl');
writeFileSync(CLAUDE_LOG_PATH, '{}\n');

/**
 * Codex's route: it records no path at all. Its log is named after the thread id
 * under a date-partitioned sessions root, so a real one is built here and the
 * pointer is proven end to end through the catalog.
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
  sourceAgentId: string;
  targetAgentId: string;
  metadata: Record<string, unknown>;
}>): Promise<Retrieval> {
  mocks.resolveReplaySeedDraft.mockReset();
  mocks.resolveReplaySeedDraft.mockResolvedValue({ status: 'no_source_dialog' });
  await buildSessionAgentTransitionActivationBrief({
    credentials: { token: 't' } as never,
    sessionId: 'sess_1',
    sourceAgentId: input.sourceAgentId,
    targetAgentId: input.targetAgentId,
    workspacePath: '/home/u/project',
    departingAgentCurrentView: input.metadata,
    transcriptHeadSeqInclusive: 42,
  });
  return (mocks.resolveReplaySeedDraft.mock.calls[0]?.[0] as { retrieval?: Retrieval }).retrieval ?? null;
}

/**
 * The native half of the retrieval pointer, at the one owner that composes it.
 * A source Agent that kept a log is worth naming only when following the name
 * works, and an Agent that keeps a log without recording its path must not be
 * read as an Agent that kept none.
 */
describe('buildSessionAgentTransitionActivationBrief — native log pointer', () => {
  let previousCodexHome: string | undefined;

  beforeEach(() => {
    previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = CODEX_HOME;
  });

  afterEach(() => {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
  });

  it('carries a source Agent’s own recorded log path', async () => {
    const retrieval = await buildWith({
      sourceAgentId: 'claude',
      targetAgentId: 'codex',
      metadata: { claudeSessionId: 'claude-1', claudeTranscriptPath: CLAUDE_LOG_PATH },
    });
    expect(retrieval?.nativeTranscriptPath).toBe(CLAUDE_LOG_PATH);
  });

  it('carries the log of a source Agent that derives the path instead of recording it', async () => {
    // Codex declares no continuity-proof field, so the proof slot is empty and
    // the Session was handed over with no log at all. The path is still knowable
    // from the vendor resume id, and the Agent that knows how declares it.
    const retrieval = await buildWith({
      sourceAgentId: 'codex',
      targetAgentId: 'claude',
      metadata: { codexSessionId: CODEX_VENDOR_RESUME_ID },
    });
    expect(retrieval?.nativeTranscriptPath).toBe(CODEX_ROLLOUT_PATH);
  });

  it('names no derived log when this machine holds no such file', async () => {
    const retrieval = await buildWith({
      sourceAgentId: 'codex',
      targetAgentId: 'claude',
      metadata: { codexSessionId: '019e7cfd-0000-0000-0000-000000000000' },
    });
    expect(retrieval?.nativeTranscriptPath ?? null).toBeNull();
  });

  it('names no log when the source Agent published no resume identity at all', async () => {
    const retrieval = await buildWith({
      sourceAgentId: 'codex',
      targetAgentId: 'claude',
      metadata: {},
    });
    expect(retrieval?.nativeTranscriptPath ?? null).toBeNull();
  });
});
