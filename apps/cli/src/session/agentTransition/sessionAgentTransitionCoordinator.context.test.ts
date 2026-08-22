import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { readSessionAgentTransitionDividerV1 } from '@happier-dev/protocol';

import {
  buildRawSession,
  buildTransitionRequest,
  CLAUDE_SOURCE_METADATA,
  createTransitionDepsHarness,
  TEST_CREDENTIALS,
  TEST_SESSION_ID,
} from './sessionAgentTransitionTestkit';

/**
 * The bounded activation brief (sections 9.1/9.2, REQ-CONTEXT-01/02).
 *
 * These tests run the coordinator with its REAL default brief builder — the
 * harness's injected stub is dropped — because the defect they exist to prevent
 * lives exactly there: an injectable seam whose shipped default seeds nothing
 * looks green in every test that supplies its own builder, while the product
 * carries no context at all.
 *
 * `resolveReplaySeedDraft` is the genuine boundary here: it performs bounded
 * transcript retrieval over HTTP and Account-mode decryption. The budget,
 * escaping, and framing beneath it are its own owner's tested contract.
 */

const mocks = vi.hoisted(() => ({
  resolveReplaySeedDraft: vi.fn(),
}));

vi.mock('@/session/replay/resolveReplaySeedDraft', () => ({
  resolveReplaySeedDraft: mocks.resolveReplaySeedDraft,
}));

const { runSessionAgentTransition } = await import('./sessionAgentTransitionCoordinator');

/**
 * A real file on THIS machine: the brief refuses to name a native log it cannot
 * stat, so a fixture path would silently test the negative case instead.
 */
const NATIVE_LOG_PATH = join(mkdtempSync(join(tmpdir(), 'happier-native-log-')), 'session.jsonl');
writeFileSync(NATIVE_LOG_PATH, '{}\n');

/** Deps with the stub brief builder removed, so the shipped default runs. */
function depsWithRealBriefBuilder(harness: ReturnType<typeof createTransitionDepsHarness>) {
  const { buildActivationBrief: _stub, ...rest } = harness.deps;
  return rest;
}

function readSealedTargetMetadata(
  harness: ReturnType<typeof createTransitionDepsHarness>,
): Record<string, unknown> {
  const call = (harness.deps.applySessionAgentTransitionCutover as unknown as {
    mock: { calls: readonly (readonly [{ currentView: Record<string, unknown> }])[] };
  }).mock.calls[0]?.[0];
  const currentView = call?.currentView as Record<string, unknown> | undefined;
  const sealed = (currentView?.metadataCiphertext ?? currentView?.ownerPatch) as unknown;
  return typeof sealed === 'string'
    ? JSON.parse(sealed) as Record<string, unknown>
    : (sealed as Record<string, unknown>) ?? {};
}

function readCommittedDivider(harness: ReturnType<typeof createTransitionDepsHarness>) {
  const call = (harness.deps.applySessionAgentTransitionCutover as unknown as {
    mock: { calls: readonly (readonly [{ divider: { localId: string; content: { v?: unknown } } }])[] };
  }).mock.calls[0]?.[0];
  if (!call) return null;
  const record = call.divider.content.v as { content?: { data?: unknown } } | undefined;
  return readSessionAgentTransitionDividerV1({
    localId: call.divider.localId,
    event: record?.content?.data,
  });
}

/**
 * A source Session whose stored metadata still carries an unconsumed
 * `replaySeedV1` from an earlier operation. It has to be in the RAW row, because
 * that tuple is what the cutover seals the target view from.
 */
function harnessWithUnconsumedSeed(): ReturnType<typeof createTransitionDepsHarness> {
  const sourceMetadata = {
    ...CLAUDE_SOURCE_METADATA,
    replaySeedV1: {
      v: 1,
      seedText: 'stale brief from an earlier operation',
      sourceSessionId: 'some-other-session',
      sourceCutoffSeqInclusive: 3,
      createdAtMs: 1,
    },
  };
  const harness = createTransitionDepsHarness({
    resolveSessionTransportContext: vi.fn(async () => ({
      ok: true as const,
      sessionId: TEST_SESSION_ID,
      rawSession: buildRawSession({ metadata: JSON.stringify(sourceMetadata) }),
      accountEncryptionCurrentness: { mode: 'plain' },
      ctx: null,
      mode: 'plain' as const,
    })) as never,
  });
  harness.setMetadata(sourceMetadata);
  return harness;
}

describe('runSessionAgentTransition — bounded activation brief (REQ-CONTEXT-01)', () => {
  it('seals a bounded Replay brief into the committed target view by default', async () => {
    // Without this, the shipped daemon commits the target Agent with no
    // `replaySeedV1`, so the target starts with none of the conversation the
    // product promises to carry over — and nothing in the result union says so.
    mocks.resolveReplaySeedDraft.mockReset();
    mocks.resolveReplaySeedDraft.mockResolvedValue({
      status: 'seeded',
      seedDraft: 'bounded brief',
      dialog: [],
      summaryText: null,
      sourceCutoffSeqInclusive: 42,
      referencedSessionMediaWorkspacePaths: [],
    });
    const harness = createTransitionDepsHarness();

    const result = await runSessionAgentTransition({
      credentials: TEST_CREDENTIALS,
      request: buildTransitionRequest(),
      deps: depsWithRealBriefBuilder(harness),
    });

    expect(result).toMatchObject({ type: 'accepted' });
    expect(readSealedTargetMetadata(harness).replaySeedV1).toMatchObject({
      v: 1,
      seedText: 'bounded brief',
      sourceCutoffSeqInclusive: 42,
    });
  });

  it('bounds the pass at the transcript head captured after the confirmed stop', async () => {
    mocks.resolveReplaySeedDraft.mockReset();
    mocks.resolveReplaySeedDraft.mockResolvedValue({
      status: 'seeded',
      seedDraft: 'bounded brief',
      dialog: [],
      summaryText: null,
      sourceCutoffSeqInclusive: 42,
      referencedSessionMediaWorkspacePaths: [],
    });
    const harness = createTransitionDepsHarness();

    await runSessionAgentTransition({
      credentials: TEST_CREDENTIALS,
      request: buildTransitionRequest(),
      deps: depsWithRealBriefBuilder(harness),
    });

    // Head U is the post-stop transcript head, and the configured cap governs —
    // no local default may compete with `configuration.replaySeedMaxChars`.
    expect(mocks.resolveReplaySeedDraft).toHaveBeenCalledTimes(1);
    const input = mocks.resolveReplaySeedDraft.mock.calls[0]?.[0] as {
      cwd: string;
      source: { kind: string; sessionId?: string; previousSessionId?: string; upToSeqInclusive: number };
      maxSeedChars: number;
    };
    expect(input.cwd).toBe('/home/u/project');
    // This Session is not its own predecessor. Asking through `fork_chain` made
    // the seed tell the target Agent it was continuing from a previous Session
    // and print this Session's own id as that predecessor.
    expect(input.source).toMatchObject({ kind: 'same_session_agent_change', upToSeqInclusive: 42 });
    expect(input.source.previousSessionId).toBeUndefined();
    expect(input.maxSeedChars).toBeGreaterThan(0);
  });

  it('does not leave an unconsumed seed from an earlier operation in the target view', async () => {
    // A seed that the source Agent never consumed is addressed to a runtime that
    // no longer exists. Leaving it in place lets the incoming Agent's first turn
    // be prefixed with an unrelated operation's replay context.
    mocks.resolveReplaySeedDraft.mockReset();
    mocks.resolveReplaySeedDraft.mockResolvedValue({ status: 'no_source_dialog' });
    const harness = harnessWithUnconsumedSeed();

    const result = await runSessionAgentTransition({
      credentials: TEST_CREDENTIALS,
      request: buildTransitionRequest(),
      deps: depsWithRealBriefBuilder(harness),
    });

    expect(result).toMatchObject({ type: 'accepted' });
    expect(readSealedTargetMetadata(harness).replaySeedV1).toBeUndefined();
  });

  it('replaces an unconsumed earlier seed with this operation\u2019s own brief', async () => {
    mocks.resolveReplaySeedDraft.mockReset();
    mocks.resolveReplaySeedDraft.mockResolvedValue({
      status: 'seeded',
      seedDraft: 'this operation\u2019s brief',
      dialog: [],
      summaryText: null,
      sourceCutoffSeqInclusive: 42,
      referencedSessionMediaWorkspacePaths: [],
    });
    const harness = harnessWithUnconsumedSeed();

    await runSessionAgentTransition({
      credentials: TEST_CREDENTIALS,
      request: buildTransitionRequest(),
      deps: depsWithRealBriefBuilder(harness),
    });

    expect(readSealedTargetMetadata(harness).replaySeedV1).toMatchObject({
      seedText: 'this operation\u2019s brief',
      sourceCutoffSeqInclusive: 42,
    });
  });

  it('switches Agent on a source with nothing to carry over, instead of stopping it and failing', async () => {
    // The reachable first-run path: start a Session, switch Agent before
    // sending anything. There is no dialog to replay, which is the trivially
    // satisfiable case — yet while an empty source and a failed retrieval
    // shared one nullish answer, the source was stopped and the switch then
    // failed with `context_unavailable`, leaving the Session stopped with
    // nothing to show for it.
    mocks.resolveReplaySeedDraft.mockReset();
    mocks.resolveReplaySeedDraft.mockResolvedValue({ status: 'no_source_dialog' });
    const harness = createTransitionDepsHarness();

    const result = await runSessionAgentTransition({
      credentials: TEST_CREDENTIALS,
      request: buildTransitionRequest(),
      deps: depsWithRealBriefBuilder(harness),
    });

    expect(result).toMatchObject({ type: 'accepted' });
    expect(harness.deps.applySessionAgentTransitionCutover).toHaveBeenCalledTimes(1);
    // Nothing to carry means no seed is sealed — not an empty seed, and not a
    // seed carried over from some other source.
    expect(readSealedTargetMetadata(harness).replaySeedV1).toBeUndefined();
    expect(readCommittedDivider(harness)).toMatchObject({ sourceCutoffSeqInclusive: 42 });
  });

  it('reports an unbuildable brief as source_stopped/context_unavailable, never as accepted', async () => {
    // The source is already stopped at this point, so a bounded-retrieval
    // failure is a known partial depth — not a silent transition that leaves
    // the target with no context and tells the user everything worked.
    mocks.resolveReplaySeedDraft.mockReset();
    mocks.resolveReplaySeedDraft.mockResolvedValue({ status: 'unavailable' });
    const harness = createTransitionDepsHarness();

    const result = await runSessionAgentTransition({
      credentials: TEST_CREDENTIALS,
      request: buildTransitionRequest(),
      deps: depsWithRealBriefBuilder(harness),
    });

    expect(result).toMatchObject({
      type: 'partially_applied',
      applied: 'source_stopped',
      code: 'context_unavailable',
    });
    expect(harness.deps.applySessionAgentTransitionCutover).not.toHaveBeenCalled();
  });

  /**
   * Section 8 disposes of `sessionWorkStateV1` in two clauses — capture the
   * snapshot into the brief, THEN clear the current field. The cutover projector
   * owns the clear; this owner is the only place the capture can happen, because
   * it is the last reader of the source view before the projection drops it.
   */
  describe('departing work state', () => {
    const WORK_STATE = {
      v: 1,
      backendId: 'claude',
      updatedAt: 10,
      items: [{
        id: 'i1',
        kind: 'task',
        origin: 'vendor',
        status: 'active',
        title: 'Port the parser to the new decoder',
        updatedAt: 10,
      }],
    };

    function seededHarnessWithMetadata(metadata: Record<string, unknown>) {
      mocks.resolveReplaySeedDraft.mockReset();
      mocks.resolveReplaySeedDraft.mockResolvedValue({
        status: 'seeded',
        seedDraft: 'bounded brief',
        dialog: [],
        summaryText: null,
        sourceCutoffSeqInclusive: 42,
        referencedSessionMediaWorkspacePaths: [],
      });
      const harness = createTransitionDepsHarness();
      harness.setMetadata(metadata);
      return harness;
    }

    function readWorkStateArgument(): unknown {
      return (mocks.resolveReplaySeedDraft.mock.calls[0]?.[0] as { workState?: unknown }).workState;
    }

    it('hands the departing Agent’s tracked work to the brief owner', async () => {
      // Without this the cutover deletes the in-flight plan and the target
      // continues the same Session unaware of it: the items are a structured
      // projection, so no amount of replayed prose brings them back.
      const harness = seededHarnessWithMetadata({ ...CLAUDE_SOURCE_METADATA, sessionWorkStateV1: WORK_STATE });

      const result = await runSessionAgentTransition({
        credentials: TEST_CREDENTIALS,
        request: buildTransitionRequest(),
        deps: depsWithRealBriefBuilder(harness),
      });

      expect(result).toMatchObject({ type: 'accepted' });
      expect(readWorkStateArgument()).toMatchObject({
        items: [{ status: 'active', title: 'Port the parser to the new decoder' }],
      });
    });

    it('reads the snapshot through the canonical display-safe reader rather than copying the raw field', async () => {
      // A malformed or placeholder projection is not displayable, and forwarding
      // it raw would put whatever the departing runtime last wrote — including
      // fields the seed must not carry — into another Agent's prompt.
      const harness = seededHarnessWithMetadata({ ...CLAUDE_SOURCE_METADATA, sessionWorkStateV1: { v: 1 } });

      await runSessionAgentTransition({
        credentials: TEST_CREDENTIALS,
        request: buildTransitionRequest(),
        deps: depsWithRealBriefBuilder(harness),
      });

      expect(readWorkStateArgument()).toBeNull();
    });
  });

  /**
   * Section 9's retrieval pointer. The brief is a bounded TAIL, and the target
   * Agent has no way to learn that the rest of the conversation is reachable,
   * where it lives, or which slice it is already holding — so it either works
   * from the tail alone or pages the transcript from the start and re-reads its
   * own prompt.
   */
  describe('retrieval pointer', () => {
    function readRetrievalArgument(): {
      sessionId?: string;
      renderInvocation?: ((cursorSeq: number | null) => string) | null;
      nativeTranscriptPath?: string | null;
    } | null | undefined {
      return (mocks.resolveReplaySeedDraft.mock.calls[0]?.[0] as { retrieval?: never }).retrieval;
    }

    async function runWithMetadata(metadata: Record<string, unknown>) {
      mocks.resolveReplaySeedDraft.mockReset();
      mocks.resolveReplaySeedDraft.mockResolvedValue({
        status: 'seeded',
        seedDraft: 'bounded brief',
        dialog: [],
        summaryText: null,
        sourceCutoffSeqInclusive: 42,
        referencedSessionMediaWorkspacePaths: [],
      });
      const harness = createTransitionDepsHarness();
      harness.setMetadata(metadata);
      const result = await runSessionAgentTransition({
        credentials: TEST_CREDENTIALS,
        request: buildTransitionRequest(),
        deps: depsWithRealBriefBuilder(harness),
      });
      return { harness, result };
    }

    it('hands the brief owner an invocation the TARGET Agent can actually run', async () => {
      const { result } = await runWithMetadata({ ...CLAUDE_SOURCE_METADATA });

      expect(result).toMatchObject({ type: 'accepted' });
      const retrieval = readRetrievalArgument();
      expect(retrieval?.sessionId).toBe(TEST_SESSION_ID);
      // Rendered for the target's own tool channel, with the cursor the framer
      // resolves once it knows which lines survived the budget.
      expect(retrieval?.renderInvocation?.(4_200)).toContain('session.transcript.get');
      expect(retrieval?.renderInvocation?.(4_200)).toContain('"direction":"before"');
    });

    it('carries the SOURCE Agent’s own session log while it is still in the current view', async () => {
      // The cutover projection clears the source Agent’s declared proof key, so
      // this brief is the last reader that can see the log at all.
      const { result } = await runWithMetadata({
        ...CLAUDE_SOURCE_METADATA,
        claudeTranscriptPath: NATIVE_LOG_PATH,
      });

      expect(result).toMatchObject({ type: 'accepted' });
      expect(readRetrievalArgument()?.nativeTranscriptPath).toBe(NATIVE_LOG_PATH);
    });

    it('never names a native log this machine cannot open', async () => {
      // Claude prunes and rotates transcripts, so a recorded path routinely
      // outlives its file; pointing at it would spend the reader’s turn on
      // nothing.
      await runWithMetadata({
        ...CLAUDE_SOURCE_METADATA,
        claudeTranscriptPath: `${NATIVE_LOG_PATH}.gone`,
      });

      expect(readRetrievalArgument()?.nativeTranscriptPath).toBeNull();
    });
  });
});
