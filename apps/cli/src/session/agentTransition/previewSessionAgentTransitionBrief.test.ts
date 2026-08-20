import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { buildSessionAgentTransitionActivationBrief } from './buildSessionAgentTransitionActivationBrief';
import { previewSessionAgentTransitionBrief } from './previewSessionAgentTransitionBrief';

// Hoisted by vitest above the imports above: the one test that runs the REAL
// brief owner still stops at the canonical Replay seed owner, so what it
// asserts is the ARGUMENTS that owner is handed rather than a rendered string.
const mocks = vi.hoisted(() => ({ resolveReplaySeedDraft: vi.fn() }));

vi.mock('@/session/replay/resolveReplaySeedDraft', () => ({
  resolveReplaySeedDraft: mocks.resolveReplaySeedDraft,
}));

/**
 * The read-only rebuild behind the transcript's transition card.
 *
 * The property under test is not "it returns a string": it is that the preview
 * runs the SAME bounded context pass the transition ran, bounded by the SAME
 * cutoff the divider recorded and composed for the SAME pair of Agents. A
 * preview composed separately could show a brief the target Agent was never
 * sent, and a surface whose whole claim is "this is what it received" cannot be
 * free to disagree with the thing that sent it.
 */
const CREDENTIALS = { token: 'tok', secret: new Uint8Array(32) } as never;

function buildDeps(overrides?: Partial<Parameters<typeof previewSessionAgentTransitionBrief>[0]['deps']>) {
  return {
    resolveSessionTransportContext: vi.fn(async () => ({
      ok: true as const,
      sessionId: 'sess_resolved',
      rawSession: { id: 'sess_resolved' },
      ctx: null,
      mode: 'plain' as const,
    })) as never,
    decryptSessionMetadata: vi.fn(() => ({ path: '/w' })) as never,
    buildActivationBrief: vi.fn(async () => ({
      status: 'seeded' as const,
      seedDraft: 'REBUILT SEED',
      dialog: [],
      summaryText: null,
      sourceCutoffSeqInclusive: 29_979,
      referencedSessionMediaWorkspacePaths: [],
    })) as never,
    ...overrides,
  };
}

const REQUEST = {
  v: 1 as const,
  sessionId: 'sess',
  sourceCutoffSeqInclusive: 29_979,
  sourceAgentId: 'claude',
  targetAgentId: 'codex',
};

/** A file that exists RIGHT NOW — the incumbent's live native log, not the departing Agent's. */
const LIVE_NATIVE_LOG_PATH = join(mkdtempSync(join(tmpdir(), 'happier-preview-log-')), 'session.jsonl');
writeFileSync(LIVE_NATIVE_LOG_PATH, '{}\n');

/** A displayable snapshot, so nothing but the basis can be what excludes it. */
const INCUMBENT_WORK_STATE = {
  v: 1,
  backendId: 'codex',
  updatedAt: 10,
  items: [{
    id: 'i1',
    kind: 'task',
    origin: 'vendor',
    status: 'active',
    title: 'Work the CURRENT Agent started long after the switch',
    updatedAt: 10,
  }],
};

describe('previewSessionAgentTransitionBrief', () => {
  it('runs the transition’s own brief owner, bounded by the divider cutoff and its Agent pair', async () => {
    const deps = buildDeps();

    const preview = await previewSessionAgentTransitionBrief({
      credentials: CREDENTIALS,
      request: REQUEST,
      deps,
    });

    expect(preview).toEqual({ type: 'rebuilt', protocolVersion: 1, briefText: 'REBUILT SEED' });
    // The bound is the divider's, not the Session's current head, and the
    // reader is the Agent that arrived, not whichever runs the Session today.
    expect(deps.buildActivationBrief).toHaveBeenCalledWith(expect.objectContaining({
      transcriptHeadSeqInclusive: 29_979,
      sessionId: 'sess_resolved',
      sourceAgentId: 'claude',
      targetAgentId: 'codex',
      workspacePath: '/w',
    }));
  });

  it('reports an empty source as empty, not as a rebuilt brief', async () => {
    const preview = await previewSessionAgentTransitionBrief({
      credentials: CREDENTIALS,
      request: REQUEST,
      deps: buildDeps({
        buildActivationBrief: vi.fn(async () => ({ status: 'no_source_dialog' as const })) as never,
      }),
    });

    expect(preview).toEqual({ type: 'empty', protocolVersion: 1 });
  });

  it('never reports an unreadable source as empty', async () => {
    // "We could not read it" and "there was nothing" are different facts.
    // Collapsing them tells the reader nothing crossed a boundary that a whole
    // conversation may have crossed.
    const preview = await previewSessionAgentTransitionBrief({
      credentials: CREDENTIALS,
      request: REQUEST,
      deps: buildDeps({
        buildActivationBrief: vi.fn(async () => ({ status: 'unavailable' as const })) as never,
      }),
    });

    expect(preview).toEqual({ type: 'unavailable', reason: 'source_unreadable' });
  });

  it('does not build a brief for a Session this machine cannot address', async () => {
    const buildActivationBrief = vi.fn(async () => ({ status: 'no_source_dialog' as const }));

    const preview = await previewSessionAgentTransitionBrief({
      credentials: CREDENTIALS,
      request: REQUEST,
      deps: buildDeps({
        resolveSessionTransportContext: vi.fn(async () => ({ ok: false as const, code: 'not_found' })) as never,
        buildActivationBrief: buildActivationBrief as never,
      }),
    });

    expect(preview).toEqual({ type: 'unavailable', reason: 'unsupported_session' });
    expect(buildActivationBrief).not.toHaveBeenCalled();
  });

  it('refuses a Session with no readable workspace path rather than guessing one', async () => {
    const preview = await previewSessionAgentTransitionBrief({
      credentials: CREDENTIALS,
      request: REQUEST,
      deps: buildDeps({ decryptSessionMetadata: vi.fn(() => ({})) as never }),
    });

    expect(preview).toEqual({ type: 'unavailable', reason: 'source_unreadable' });
  });

  /**
   * The card's whole claim is "this is what was handed over", so every block in
   * it must come from the boundary. `sessionWorkStateV1` and the departing
   * Agent's own log path do not: both are Agent-scoped current projections that
   * the cutover clears and the NEXT Agent republishes into the same durable
   * keys, so reading them out of the view fetched today shows the incumbent's
   * live state — or, after a switch back, that Agent's newer native session — as
   * though it had crossed the boundary. Nothing records them per boundary (the
   * divider carries only the cutoff and the Agent pair), so the honest rebuild
   * omits them and the card says so.
   */
  it('rebuilds without the departing Agent\u2019s current projections, which no longer belong to the boundary', async () => {
    mocks.resolveReplaySeedDraft.mockReset();
    mocks.resolveReplaySeedDraft.mockResolvedValue({
      status: 'seeded',
      seedDraft: 'REBUILT SEED',
      dialog: [],
      summaryText: null,
      sourceCutoffSeqInclusive: 29_979,
      referencedSessionMediaWorkspacePaths: [],
    });

    const preview = await previewSessionAgentTransitionBrief({
      credentials: CREDENTIALS,
      request: REQUEST,
      deps: buildDeps({
        // Today's view: the Session has been running since, and whatever Agent
        // runs it now has republished both keys.
        decryptSessionMetadata: vi.fn(() => ({
          path: '/w',
          sessionWorkStateV1: INCUMBENT_WORK_STATE,
          claudeSessionId: 'claude-today',
          claudeTranscriptPath: LIVE_NATIVE_LOG_PATH,
        })) as never,
        buildActivationBrief: buildSessionAgentTransitionActivationBrief,
      }),
    });

    expect(preview).toEqual({ type: 'rebuilt', protocolVersion: 1, briefText: 'REBUILT SEED' });
    const seedCall = mocks.resolveReplaySeedDraft.mock.calls[0]?.[0] as {
      workState?: unknown;
      retrieval?: { nativeTranscriptPath?: unknown } | null;
    };
    expect(seedCall.workState).toBeNull();
    expect(seedCall.retrieval?.nativeTranscriptPath ?? null).toBeNull();
  });

  it('survives a throwing brief owner without claiming an empty source', async () => {
    const preview = await previewSessionAgentTransitionBrief({
      credentials: CREDENTIALS,
      request: REQUEST,
      deps: buildDeps({
        buildActivationBrief: vi.fn(() => { throw new Error('boom'); }) as never,
      }),
    });

    expect(preview).toEqual({ type: 'unavailable', reason: 'source_unreadable' });
  });
});
