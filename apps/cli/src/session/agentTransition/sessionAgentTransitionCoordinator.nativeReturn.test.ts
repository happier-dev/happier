import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

import {
  readSessionAgentTransitionDividerV1,
  type AgentNativeResumeIdentityV1,
} from '@happier-dev/protocol';

import type { LocalAgentNativeResumeRecordStore } from './agentNativeReturn';
import { runSessionAgentTransition } from './sessionAgentTransitionCoordinator';
import {
  buildRawSession,
  buildTransitionRequest,
  createTransitionDepsHarness,
  CLAUDE_SOURCE_METADATA,
  TEST_CREDENTIALS,
  TEST_SESSION_ID,
} from './sessionAgentTransitionTestkit';

/**
 * Same-machine native return (sections 6.5, 7.2 step 4, 7.3 step 1) — the
 * dev-only depth `remote-dev` excludes by design.
 *
 * Two behaviours are under test, and they are the whole feature:
 *
 * 1. A returning Agent RESUMES the native conversation it left rather than
 *    starting fresh with only a replayed brief. Observable in exactly one place:
 *    the committed target current view either carries the Agent's recorded
 *    vendor resume id or it does not, and the ordinary inactive-resume owner
 *    reads it from there.
 * 2. The replay handed to that returning Agent is BOUNDED by the transcript head
 *    it last saw, so it is told what happened while it was away instead of being
 *    re-sent a conversation it still holds (`AM-26`). Observable on the brief
 *    input, which is where the bound leaves this owner.
 *
 * There is deliberately no continuity proof and no decision-time `stat()`
 * (`AM-24`): a dead vendor id fails loudly at the first turn, exactly as any
 * other Happier resume does.
 *
 * The machine-local record store is the mocked boundary (protected files on
 * disk). The projector, the eligibility decision, and the sealing are code under
 * test and run for real.
 */

/**
 * A real file so the SEED POINTER half stays exercised: the brief may offer the
 * successor the departing Agent's own log, and that pointer is still existence-
 * checked. It no longer decides anything about resuming.
 */
const TRANSCRIPT_DIR = mkdtempSync(join(tmpdir(), 'happier-native-return-'));
const CLAUDE_TRANSCRIPT_PATH = join(TRANSCRIPT_DIR, 'claude-1.jsonl');
writeFileSync(CLAUDE_TRANSCRIPT_PATH, '{"type":"summary"}\n');
/** Recorded on departure, pruned before the Agent was asked back. */
const PRUNED_TRANSCRIPT_PATH = join(TRANSCRIPT_DIR, 'claude-pruned.jsonl');

afterAll(() => {
  rmSync(TRANSCRIPT_DIR, { recursive: true, force: true });
});

const CLAUDE_PROVEN_SOURCE_METADATA: Record<string, unknown> = {
  ...CLAUDE_SOURCE_METADATA,
  claudeTranscriptPath: CLAUDE_TRANSCRIPT_PATH,
};

const CODEX_SOURCE_METADATA: Record<string, unknown> = {
  flavor: 'codex',
  machineId: 'machine-1',
  path: '/home/u/project',
  codexSessionId: 'codex-1',
};

const CLAUDE_IDENTITY: AgentNativeResumeIdentityV1 = { v: 1, vendorResumeId: 'claude-1' };
const CLAUDE_DEPARTURE_SEQ = 30;
const CLAUDE_RECORD: StoredRecord = {
  identity: CLAUDE_IDENTITY,
  departureSeqInclusive: CLAUDE_DEPARTURE_SEQ,
};

type StoredRecord = Readonly<{
  identity: AgentNativeResumeIdentityV1;
  departureSeqInclusive: number;
}>;

type RecordWrite = Readonly<{
  agentId: string;
  identity: AgentNativeResumeIdentityV1 | null;
  departureSeqInclusive: number;
}>;

type RecordStoreDouble = Readonly<{
  store: LocalAgentNativeResumeRecordStore;
  writes: RecordWrite[];
}>;

function createRecordStoreDouble(params: Readonly<{
  calls: string[];
  seeded?: Readonly<Record<string, StoredRecord>>;
  failWrites?: boolean;
}>): RecordStoreDouble {
  const records = new Map<string, StoredRecord | null>(Object.entries(params.seeded ?? {}));
  const writes: RecordWrite[] = [];
  return {
    writes,
    store: {
      readAgentNativeResumeRecord: vi.fn(async (key) => {
        params.calls.push(`record:read:${key.agentId}`);
        return records.get(key.agentId) ?? null;
      }),
      writeAgentNativeResumeRecord: vi.fn(async (input) => {
        params.calls.push(`record:write:${input.agentId}`);
        writes.push({
          agentId: input.agentId,
          identity: input.identity,
          departureSeqInclusive: input.departureSeqInclusive,
        });
        if (params.failWrites) throw new Error('protected write failed');
        records.set(
          input.agentId,
          input.identity
            ? { identity: input.identity, departureSeqInclusive: input.departureSeqInclusive }
            : null,
        );
      }),
    },
  };
}

/** The bound this owner handed the brief, or `undefined` when it handed none. */
function readBriefBound(
  harness: ReturnType<typeof createTransitionDepsHarness>,
): number | null | undefined {
  const call = (harness.deps.buildActivationBrief as unknown as {
    mock: { calls: readonly (readonly [Record<string, unknown>])[] };
  }).mock.calls[0]?.[0];
  return call?.returningAgentLastSeenSeq as number | null | undefined;
}

/**
 * A harness whose RAW stored payload is the given metadata, because the cutover
 * sealing projects the raw stored tuple rather than the decrypted owner view.
 */
function createSourceHarness(
  sourceMetadata: Record<string, unknown>,
  options?: Readonly<{ preStopSeq?: number; postStopSeq?: number }>,
) {
  // Keyed on the STOP, not on a call index: the coordinator resolves the
  // transport several times before it stops the source, so "which head was
  // recorded" is only a falsifiable question if the double moves at the exact
  // instant the real Session's head can move.
  let stopped = false;
  const harness = createTransitionDepsHarness({
    resolveSessionTransportContext: vi.fn(async () => ({
      ok: true as const,
      sessionId: TEST_SESSION_ID,
      rawSession: buildRawSession({
        metadata: JSON.stringify(sourceMetadata),
        seq: stopped
          ? options?.postStopSeq ?? options?.preStopSeq ?? 42
          : options?.preStopSeq ?? 42,
      }),
      accountEncryptionCurrentness: { mode: 'plain' },
      ctx: null,
      mode: 'plain' as const,
    })) as never,
  });
  const requestSessionStop = harness.deps.requestSessionStop;
  harness.deps.requestSessionStop = (async (...args: Parameters<typeof requestSessionStop>) => {
    const result = await requestSessionStop(...args);
    stopped = true;
    return result;
  }) as typeof requestSessionStop;
  harness.setMetadata({ ...sourceMetadata });
  harness.deps.buildActivationBrief = vi.fn(() => {
    harness.calls.push('brief');
    return { status: 'available' as const, seed: null };
  });
  return harness;
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

/**
 * The transition divider as it was actually COMMITTED, read through the single
 * canonical sidecar reader rather than by poking at the payload shape.
 */
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

describe('runSessionAgentTransition — departing native snapshot (section 7.2 step 4)', () => {
  it('records the departing Agent’s id and PRE-STOP head before the source is stopped', async () => {
    // Written after the stop it would race a runtime that no longer publishes;
    // written from the post-stop view the id would already have been cleared by
    // the cutover. The pre-stop instant is the only one where the id is both
    // current and still committed.
    //
    // The HEAD recorded there is pre-stop for a different and asymmetric reason:
    // a row that lands between this instant and the confirmed stop may never
    // have reached the departing Agent, so an over-estimated boundary skips it
    // PERMANENTLY, while an under-estimate costs one re-replayed turn.
    const harness = createSourceHarness(CLAUDE_PROVEN_SOURCE_METADATA, {
      preStopSeq: 130,
      postStopSeq: 137,
    });
    const { store, writes } = createRecordStoreDouble({ calls: harness.calls });
    harness.deps.localAgentNativeResumeRecordStore = store;

    const result = await runSessionAgentTransition({
      credentials: TEST_CREDENTIALS,
      request: buildTransitionRequest(),
      deps: harness.deps,
    });

    expect(result.type).toBe('accepted');
    expect(writes[0]).toEqual({
      agentId: 'claude',
      identity: CLAUDE_IDENTITY,
      departureSeqInclusive: 130,
    });
    expect(harness.calls.indexOf('record:write:claude')).toBeGreaterThanOrEqual(0);
    expect(harness.calls.indexOf('record:write:claude')).toBeLessThan(harness.calls.indexOf('stop'));
  });

  it('removes a stale record when the departing Agent has no usable native id', async () => {
    // A previous departure may have left a record. If this departure cannot
    // produce a usable id, leaving the old one would let a later return resume a
    // native session this Session no longer corresponds to.
    const harness = createSourceHarness({
      flavor: 'claude',
      machineId: 'machine-1',
      path: '/home/u/project',
    });
    const { store, writes } = createRecordStoreDouble({
      calls: harness.calls,
      seeded: { claude: CLAUDE_RECORD },
    });
    harness.deps.localAgentNativeResumeRecordStore = store;

    await runSessionAgentTransition({
      credentials: TEST_CREDENTIALS,
      request: buildTransitionRequest(),
      deps: harness.deps,
    });

    expect(writes[0]?.identity).toBeNull();
  });

  it('keeps a valid record when the departing Agent is DISABLED in Account settings', async () => {
    // Disabling an Agent is transient and reversible; the conversation it left
    // behind is neither. A capture that evaluated launch policy wrote
    // `identity: null` here, DELETING the only copy of that continuity, and
    // re-enabling the Agent afterwards could never recover it. Whether a
    // recorded identity may be resumed is a RETURN decision, taken against the
    // settings that hold then.
    const harness = createSourceHarness(CLAUDE_PROVEN_SOURCE_METADATA, { preStopSeq: 130 });
    const { store, writes } = createRecordStoreDouble({
      calls: harness.calls,
      seeded: { claude: CLAUDE_RECORD },
    });
    harness.deps.localAgentNativeResumeRecordStore = store;
    harness.deps.readAccountSettings = () => ({
      backendEnabledByTargetKey: { 'agent:claude': false },
    });

    await runSessionAgentTransition({
      credentials: TEST_CREDENTIALS,
      request: buildTransitionRequest(),
      deps: harness.deps,
    });

    expect(writes[0]).toEqual({
      agentId: 'claude',
      identity: CLAUDE_IDENTITY,
      departureSeqInclusive: 130,
    });
  });

  it('completes the transition identically when the record write fails', async () => {
    // The record only decides whether a FUTURE return is native. Failing the
    // switch the user asked for over a protected-file write would be a worse
    // trade — and this is why the write reports nothing back.
    const harness = createSourceHarness(CLAUDE_PROVEN_SOURCE_METADATA);
    const { store } = createRecordStoreDouble({ calls: harness.calls, failWrites: true });
    harness.deps.localAgentNativeResumeRecordStore = store;

    const result = await runSessionAgentTransition({
      credentials: TEST_CREDENTIALS,
      request: buildTransitionRequest(),
      deps: harness.deps,
    });

    expect(result.type).toBe('accepted');
    expect(readSealedTargetMetadata(harness).flavor).toBe('codex');
  });
});

describe('runSessionAgentTransition — native return (sections 6.5, 7.3 step 1)', () => {
  const returnToClaude = buildTransitionRequest({
    expectedCurrentAgentId: 'codex',
    selection: { v: 1, agentId: 'claude' },
  });

  it('restores the target’s recorded id into the committed current view', async () => {
    // This IS native return: the ordinary inactive-resume owner resumes the
    // Agent's own native conversation only because the id is present in the
    // committed view. Without it the target is started fresh and the replayed
    // brief is the whole of its memory.
    const harness = createSourceHarness(CODEX_SOURCE_METADATA);
    const { store } = createRecordStoreDouble({
      calls: harness.calls,
      seeded: { claude: CLAUDE_RECORD },
    });
    harness.deps.localAgentNativeResumeRecordStore = store;

    const result = await runSessionAgentTransition({
      credentials: TEST_CREDENTIALS,
      request: returnToClaude,
      deps: harness.deps,
    });

    expect(result.type).toBe('accepted');
    const sealed = readSealedTargetMetadata(harness);
    expect(sealed.claudeSessionId).toBe('claude-1');
    // The departed Agent's own key never survives the cutover.
    expect(sealed.codexSessionId).toBeUndefined();
    // The returning Agent republishes its own log path on its next established
    // turn, so the projection restores the id alone rather than a stale path.
    expect(sealed.claudeTranscriptPath).toBeUndefined();
  });

  it('hands the brief the recorded departure head as the replay bound', async () => {
    const harness = createSourceHarness(CODEX_SOURCE_METADATA);
    const { store } = createRecordStoreDouble({
      calls: harness.calls,
      seeded: { claude: CLAUDE_RECORD },
    });
    harness.deps.localAgentNativeResumeRecordStore = store;

    await runSessionAgentTransition({
      credentials: TEST_CREDENTIALS,
      request: returnToClaude,
      deps: harness.deps,
    });

    expect(readBriefBound(harness)).toBe(CLAUDE_DEPARTURE_SEQ);
    // The SAME bound, recorded on the boundary it bounded. The brief's text is
    // blanked on acceptance and the departure record is overwritten by the next
    // departure, so a boundary that does not carry this can never be explained
    // again: every later rebuild replays the full prefix and shows more than
    // this Agent was handed.
    expect(readCommittedDivider(harness)?.returningAgentLastSeenSeqInclusive).toBe(CLAUDE_DEPARTURE_SEQ);
  });

  it('hands a FRESH target no bound at all, so it cannot be starved to an away-delta', async () => {
    // Structurally impossible rather than merely avoided: the bound can only
    // come from the target Agent's own departure record, and a target that never
    // ran in this Session has none. There is nothing to starve it with.
    const harness = createSourceHarness(CODEX_SOURCE_METADATA);
    const { store } = createRecordStoreDouble({ calls: harness.calls });
    harness.deps.localAgentNativeResumeRecordStore = store;

    await runSessionAgentTransition({
      credentials: TEST_CREDENTIALS,
      request: returnToClaude,
      deps: harness.deps,
    });

    expect(readBriefBound(harness) ?? null).toBeNull();
    expect(readSealedTargetMetadata(harness).claudeSessionId).toBeUndefined();
    // And the boundary records no bound either: this one genuinely had none,
    // so a later rebuild of it IS the full replay.
    expect(readCommittedDivider(harness)).not.toHaveProperty('returningAgentLastSeenSeqInclusive');
  });

  it('hands no bound when the recorded id is INELIGIBLE for this target', async () => {
    // Reading the seq straight from the store rather than out of the resolved
    // record would bound the replay for a target that is being started fresh —
    // the starvation case, arriving through the back door.
    const harness = createSourceHarness(CODEX_SOURCE_METADATA);
    const { store } = createRecordStoreDouble({
      calls: harness.calls,
      seeded: { claude: CLAUDE_RECORD },
    });
    harness.deps.localAgentNativeResumeRecordStore = store;
    harness.deps.readAccountSettings = () => ({
      backendEnabledByTargetKey: { 'agent:claude': false },
    });

    await runSessionAgentTransition({
      credentials: TEST_CREDENTIALS,
      request: returnToClaude,
      deps: harness.deps,
    });

    expect(readSealedTargetMetadata(harness).claudeSessionId).toBeUndefined();
    expect(readBriefBound(harness) ?? null).toBeNull();
  });

  it('resolves native eligibility before the bounded brief is built', async () => {
    // Section 10.1 risk spot 3: deciding the context bound first and only then
    // discovering that native return is unavailable omits history the fresh
    // target needs, with nothing in the result saying so.
    const harness = createSourceHarness(CODEX_SOURCE_METADATA);
    const { store } = createRecordStoreDouble({
      calls: harness.calls,
      seeded: { claude: CLAUDE_RECORD },
    });
    harness.deps.localAgentNativeResumeRecordStore = store;

    await runSessionAgentTransition({
      credentials: TEST_CREDENTIALS,
      request: returnToClaude,
      deps: harness.deps,
    });

    expect(harness.calls.indexOf('record:read:claude')).toBeGreaterThanOrEqual(0);
    expect(harness.calls.indexOf('record:read:claude'))
      .toBeLessThan(harness.calls.indexOf('brief'));
  });

  it('still returns natively when the Agent’s own session log is gone from disk', async () => {
    // `AM-24`. The recorded id is the whole claim; a missing log is not evidence
    // that the conversation cannot be resumed, and a pre-check on it was a
    // SECOND decision-maker for a question the resume itself answers. If the id
    // really is dead, Claude raises `ClaudeAgentSdkResumeIdentityMismatchError`
    // on the first turn and the user switches back through the picker.
    const harness = createSourceHarness({
      ...CODEX_SOURCE_METADATA,
      claudeTranscriptPath: PRUNED_TRANSCRIPT_PATH,
    });
    const { store } = createRecordStoreDouble({
      calls: harness.calls,
      seeded: { claude: CLAUDE_RECORD },
    });
    harness.deps.localAgentNativeResumeRecordStore = store;

    await runSessionAgentTransition({
      credentials: TEST_CREDENTIALS,
      request: returnToClaude,
      deps: harness.deps,
    });

    expect(readSealedTargetMetadata(harness).claudeSessionId).toBe('claude-1');
    expect(readBriefBound(harness)).toBe(CLAUDE_DEPARTURE_SEQ);
  });

  it('leaves the returning Agent’s record in place, and a STALE record over-covers rather than skips', async () => {
    // Nothing discards the record after activation (`AM-24`): a discard is not
    // observable and it is not GC either, since nothing sweeps the directory.
    //
    // What makes that safe is a coherence property worth pinning: the id and the
    // bound are written by the SAME departure. A capture that failed leaves both
    // halves stale together, so the replay bound is stale-LOW and OVER-covers
    // the missing period. A stale record can therefore degrade to "resumed a
    // superseded conversation with too much replay", never to skipped history.
    const harness = createSourceHarness(CODEX_SOURCE_METADATA);
    const { store, writes } = createRecordStoreDouble({
      calls: harness.calls,
      seeded: { claude: CLAUDE_RECORD },
    });
    harness.deps.localAgentNativeResumeRecordStore = store;

    await runSessionAgentTransition({
      credentials: TEST_CREDENTIALS,
      request: returnToClaude,
      deps: harness.deps,
    });

    expect(writes.some((write) => write.agentId === 'claude')).toBe(false);
    expect(readBriefBound(harness)).toBe(CLAUDE_DEPARTURE_SEQ);
    // Bound at or below the head the brief runs to: the delta is a superset of
    // what actually happened while the Agent was away, never a subset.
    const briefHead = (harness.deps.buildActivationBrief as unknown as {
      mock: { calls: readonly (readonly [{ transcriptHeadSeqInclusive: number }])[] };
    }).mock.calls[0]?.[0].transcriptHeadSeqInclusive;
    expect(readBriefBound(harness)).toBeLessThanOrEqual(briefHead ?? -1);
  });
});
