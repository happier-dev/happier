import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  SESSION_AGENT_TRANSITION_CURRENT_VIEW_COMMITTED_CODES_V1,
  SESSION_AGENT_TRANSITION_ERROR_CODES_V1,
  SESSION_AGENT_TRANSITION_REJECTED_CODES_V1,
  SESSION_AGENT_TRANSITION_SOURCE_STOPPED_CODES_V1,
  ComposerAgentContinuationIntentV1Schema,
  SessionAgentTransitionRequestV1Schema,
  SessionAgentTransitionResultV1Schema,
  SessionAgentTransitionSelectionV1Schema,
  SessionContinuationInspectionRequestV1Schema,
  SessionContinuationInspectionV1Schema,
  resolveSessionContinuationUnavailablePresentationV1,
  type SessionContinuationInspectionUnavailableReasonV1,
  type SessionContinuationMachinePresenceV1,
} from './agentTransition.js';
import {
  SESSION_AGENT_TRANSITION_DIVIDER_LOCAL_ID_PREFIX,
  SESSION_AGENT_TRANSITION_DIVIDER_MESSAGE,
  SESSION_AGENT_TRANSITION_DIVIDER_SIDECAR_KEY,
  SessionAgentTransitionDividerV1Schema,
  buildSessionAgentTransitionDividerLocalId,
  isSameSessionAgentTransitionDividerV1,
  isSessionAgentTransitionDividerLocalId,
  readSessionAgentTransitionDividerFromStoredRecordV1,
  readSessionAgentTransitionDividerV1,
} from './agentTransitionDivider.js';
import { SESSION_AGENT_TRANSITION_VECTORS as V } from './agentTransitionVectors.js';
import { SessionSpawnSourceContextV1Schema } from './creation/sessionSpawnSourceContextV1.js';
import {
  SessionForkRpcParamsSchema,
  SessionForkRpcResultSchema,
  SessionForkStrategySchema,
} from './fork.js';
import { createTranscriptRawRecordV1Schema } from './messages/transcriptRawRecordV1.js';

function expectAllParse(schema: z.ZodTypeAny, group: Readonly<Record<string, unknown>>): void {
  for (const [name, value] of Object.entries(group)) {
    const parsed = schema.safeParse(value);
    expect(parsed.success, `${name} should parse but failed: ${JSON.stringify(parsed.error?.issues)}`)
      .toBe(true);
  }
}

function expectAllReject(schema: z.ZodTypeAny, group: Readonly<Record<string, unknown>>): void {
  for (const [name, value] of Object.entries(group)) {
    expect(schema.safeParse(value).success, `${name} should be rejected but parsed`).toBe(false);
  }
}

describe('session agent transition — portable selection', () => {
  it('accepts every valid selection vector and rejects every invalid one', () => {
    expectAllParse(SessionAgentTransitionSelectionV1Schema, V.selection.valid);
    expectAllReject(SessionAgentTransitionSelectionV1Schema, V.selection.invalid);
  });

  it('requires modelId whenever providerConnectionId is set', () => {
    const parsed = SessionAgentTransitionSelectionV1Schema.safeParse(
      V.selection.invalid.providerConnectionWithoutModel,
    );
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.some((issue) => issue.path.join('.') === 'modelId')).toBe(true);
  });

  it('requires canonical Agent routing ids while normalizing non-routing identifiers', () => {
    expect(SessionAgentTransitionSelectionV1Schema.safeParse({
      v: 1,
      agentId: '  claude  ',
      modelId: 'opus',
    }).success).toBe(false);

    const parsed = SessionAgentTransitionSelectionV1Schema.parse({
      v: 1,
      agentId: 'claude',
      modelId: '  opus  ',
    });
    expect(parsed.agentId).toBe('claude');
    expect(parsed.modelId).toBe('opus');
  });

  it('does not accept a builtInAgent target carrier as the selection shape', () => {
    expect(
      SessionAgentTransitionSelectionV1Schema.safeParse({
        v: 1,
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      }).success,
    ).toBe(false);
  });
});

describe('session agent transition — request', () => {
  it('accepts the valid request vectors and rejects the invalid ones', () => {
    expectAllParse(SessionAgentTransitionRequestV1Schema, V.request.valid);
    expectAllReject(SessionAgentTransitionRequestV1Schema, V.request.invalid);
  });

  it('promotes localId from optional to required on the reused message input', () => {
    const parsed = SessionAgentTransitionRequestV1Schema.parse(V.request.valid.minimal);
    expect(parsed.input.localId).toBe('local_01');
  });

  it('closes the nested mutation envelope while preserving opaque metadata', () => {
    const parsed = SessionAgentTransitionRequestV1Schema.parse(V.request.valid.withOpaqueMeta);
    expect(parsed.input.meta).toEqual({ futureComposerMetadata: { v: 2 } });
    expect(SessionAgentTransitionRequestV1Schema.safeParse(V.request.invalid.unknownInputKey).success)
      .toBe(false);
  });
});

describe('session agent transition — result union', () => {
  it('accepts every valid result vector', () => {
    expectAllParse(SessionAgentTransitionResultV1Schema, V.result.valid);
  });

  it('rejects every invalid result vector', () => {
    expectAllReject(SessionAgentTransitionResultV1Schema, V.result.invalid);
  });

  it('partitions every error code across exactly one arm', () => {
    const partitions = [
      SESSION_AGENT_TRANSITION_REJECTED_CODES_V1,
      SESSION_AGENT_TRANSITION_SOURCE_STOPPED_CODES_V1,
      SESSION_AGENT_TRANSITION_CURRENT_VIEW_COMMITTED_CODES_V1,
    ].flatMap((codes) => [...codes]);

    expect(new Set(partitions).size).toBe(partitions.length);
    expect([...partitions].sort()).toEqual([...SESSION_AGENT_TRANSITION_ERROR_CODES_V1].sort());
  });

  it('makes every error code reachable from the result union', () => {
    for (const code of SESSION_AGENT_TRANSITION_REJECTED_CODES_V1) {
      expect(
        SessionAgentTransitionResultV1Schema.safeParse({
          type: 'rejected', code, sourceEffect: 'none',
        }).success,
        `rejected:${code}`,
      ).toBe(true);
    }
    for (const code of SESSION_AGENT_TRANSITION_SOURCE_STOPPED_CODES_V1) {
      expect(
        SessionAgentTransitionResultV1Schema.safeParse({
          type: 'partially_applied', localId: 'local_01', applied: 'source_stopped', code,
        }).success,
        `source_stopped:${code}`,
      ).toBe(true);
    }
    for (const code of SESSION_AGENT_TRANSITION_CURRENT_VIEW_COMMITTED_CODES_V1) {
      expect(
        SessionAgentTransitionResultV1Schema.safeParse({
          type: 'partially_applied',
          localId: 'local_01',
          applied: 'current_view_committed',
          code,
        }).success,
        `current_view_committed:${code}`,
      ).toBe(true);
    }
  });

  it('carries no code on outcome_unknown, so it cannot name a cause it lacks', () => {
    expect(SessionAgentTransitionResultV1Schema.safeParse(V.result.valid.unknownBare).success)
      .toBe(true);
    for (const code of SESSION_AGENT_TRANSITION_ERROR_CODES_V1) {
      expect(
        SessionAgentTransitionResultV1Schema.safeParse({
          type: 'outcome_unknown', localId: 'local_01', code,
        }).success,
        `outcome_unknown must not carry ${code}`,
      ).toBe(false);
    }
  });

  it('never lets a code reachable after the source stopped ride the rejected arm', () => {
    const postStopCodes = [
      ...SESSION_AGENT_TRANSITION_SOURCE_STOPPED_CODES_V1,
      ...SESSION_AGENT_TRANSITION_CURRENT_VIEW_COMMITTED_CODES_V1,
    ];
    for (const code of postStopCodes) {
      expect(
        SessionAgentTransitionResultV1Schema.safeParse({
          type: 'rejected', code, sourceEffect: 'none',
        }).success,
        `rejected must not carry ${code}`,
      ).toBe(false);
    }
  });

  it('routes a still-running stop to rejected and an unconfirmed stop to outcome_unknown', () => {
    // The stop result PROVED the source is still running: no effect, so keep
    // editing and retry-in-place stay safe.
    expect(
      SessionAgentTransitionResultV1Schema.safeParse(V.result.valid.rejectedSourceStopFailed)
        .success,
    ).toBe(true);

    // An unconfirmed stop means the source may already be gone. It must not
    // claim `sourceEffect: 'none'`, and it names no cause.
    expect(SessionAgentTransitionResultV1Schema.safeParse(V.result.valid.unknownBare).success)
      .toBe(true);
    expect(
      SessionAgentTransitionResultV1Schema.safeParse(V.result.invalid.unknownCarryingStopCode)
        .success,
    ).toBe(false);
  });

  it('separates a known source-stopped outcome from a genuinely indeterminate one', () => {
    // Known: source stopped, nothing committed. The Session is still the source,
    // so the client may safely resume the source or retry.
    const stopped = SessionAgentTransitionResultV1Schema.parse(
      V.result.valid.partialContextUnavailable,
    );
    expect(stopped).toMatchObject({ type: 'partially_applied', applied: 'source_stopped' });

    // Known: the Session IS the target.
    const committed = SessionAgentTransitionResultV1Schema.parse(
      V.result.valid.partialDividerUnavailable,
    );
    expect(committed).toMatchObject({
      type: 'partially_applied',
      applied: 'current_view_committed',
    });

    // Indeterminate: no depth and no cause may be claimed.
    expect(SessionAgentTransitionResultV1Schema.parse(V.result.valid.unknownBare))
      .toEqual({ type: 'outcome_unknown', localId: 'local_01' });
  });

  it('guarantees rejected means the source was never touched', () => {
    const parsed = SessionAgentTransitionResultV1Schema.parse(V.result.valid.rejectedForbidden);
    expect(parsed).toMatchObject({ type: 'rejected', sourceEffect: 'none' });
    expect(
      SessionAgentTransitionResultV1Schema.safeParse(V.result.invalid.rejectedWithSourceEffect)
        .success,
    ).toBe(false);
  });

  it('correlates applied depth with the codes truthfully reachable at that depth', () => {
    for (const name of [
      'partialWithUnknownAppliedDepth',
      'committedCarryingPreCommitCode',
      'sourceStoppedCarryingCommittedCode',
    ] as const) {
      expect(
        SessionAgentTransitionResultV1Schema.safeParse(V.result.invalid[name]).success,
        name,
      ).toBe(false);
    }
  });
});

describe('session continuation inspection', () => {
  it('accepts and rejects the inspection request vectors', () => {
    expectAllParse(SessionContinuationInspectionRequestV1Schema, V.inspection.request.valid);
    expectAllReject(SessionContinuationInspectionRequestV1Schema, V.inspection.request.invalid);
  });

  it('accepts and rejects the inspection result vectors', () => {
    expectAllParse(SessionContinuationInspectionV1Schema, V.inspection.valid);
    expectAllReject(SessionContinuationInspectionV1Schema, V.inspection.invalid);
  });

  it('requires every support flag so a missing flag never reads as false', () => {
    expect(
      SessionContinuationInspectionV1Schema.safeParse(V.inspection.invalid.missingFlag).success,
    ).toBe(false);
  });

  it('reports no native-return diagnostic', () => {
    // `AM-24` removed it: zero readers across every released channel, and it
    // cost a protected-file read plus a `stat()` per offered target on every
    // picker open. `.strict()` is what keeps a producer from re-adding it.
    const parsed = SessionContinuationInspectionV1Schema.safeParse({
      ...V.inspection.valid.allSupported,
      nativeReturn: true,
    });
    expect(parsed.success).toBe(false);
  });

  it('distinguishes update-required from machine-offline using machine presence', () => {
    for (const vector of V.inspection.unavailablePresentation) {
      expect(
        resolveSessionContinuationUnavailablePresentationV1({
          reason: vector.reason as SessionContinuationInspectionUnavailableReasonV1,
          machinePresence: vector.machinePresence as SessionContinuationMachinePresenceV1,
        }),
        `${vector.reason}/${vector.machinePresence}`,
      ).toBe(vector.expected);
    }
  });
});

describe('session agent transition divider', () => {
  /**
   * These cases vary the PAYLOAD, so they hold the reserved localId fixed. The
   * localId half of the contract has its own cases below.
   */
  const readDivider = (event: unknown) =>
    readSessionAgentTransitionDividerV1({ localId: V.divider.expectedLocalId, event });

  it('pins the reserved namespace, sidecar key, and old-reader prose', () => {
    expect(SESSION_AGENT_TRANSITION_DIVIDER_LOCAL_ID_PREFIX).toBe(V.divider.localIdPrefix);
    expect(SESSION_AGENT_TRANSITION_DIVIDER_SIDECAR_KEY).toBe(V.divider.sidecarKey);
    expect(SESSION_AGENT_TRANSITION_DIVIDER_MESSAGE).toBe(V.divider.message);
  });

  it('derives a deterministic divider localId from the submitted localId', () => {
    expect(buildSessionAgentTransitionDividerLocalId(V.divider.submittedLocalId))
      .toBe(V.divider.expectedLocalId);
  });

  it('recognizes exactly the reserved localId namespace', () => {
    for (const localId of V.divider.reservedLocalIds) {
      expect(isSessionAgentTransitionDividerLocalId(localId), localId).toBe(true);
    }
    for (const localId of V.divider.unreservedLocalIds) {
      expect(isSessionAgentTransitionDividerLocalId(localId), localId).toBe(false);
    }
  });

  it('accepts and rejects the divider payload vectors', () => {
    expectAllParse(SessionAgentTransitionDividerV1Schema, V.divider.payload.valid);
    expectAllReject(SessionAgentTransitionDividerV1Schema, V.divider.payload.invalid);
  });

  it('treats both replay bounds as part of the divider identity', () => {
    const original = {
      v: 1 as const,
      fromAgentId: 'claude',
      toAgentId: 'codex',
      sourceCutoffSeqInclusive: 29_979,
      returningAgentLastSeenSeqInclusive: 130,
    };

    expect(isSameSessionAgentTransitionDividerV1(original, { ...original })).toBe(true);
    expect(isSameSessionAgentTransitionDividerV1(original, {
      ...original,
      sourceCutoffSeqInclusive: 29_980,
    })).toBe(false);
    expect(isSameSessionAgentTransitionDividerV1(original, {
      ...original,
      returningAgentLastSeenSeqInclusive: 131,
    })).toBe(false);
    expect(isSameSessionAgentTransitionDividerV1(original, {
      v: 1,
      fromAgentId: 'claude',
      toAgentId: 'codex',
      sourceCutoffSeqInclusive: 29_979,
    })).toBe(false);
  });

  it('exposes one committed-view code for an unavailable divider', () => {
    expect(
      SessionAgentTransitionResultV1Schema.safeParse(
        V.result.valid.partialDividerUnavailable,
      ).success,
    ).toBe(true);
    expect(SESSION_AGENT_TRANSITION_CURRENT_VIEW_COMMITTED_CODES_V1)
      .toEqual([
        'divider_unavailable',
        'target_start_failed',
        'input_admission_failed',
        'input_rejected',
      ]);
  });

  it('requires the source cutoff and rejects a sidecar that omits it', () => {
    // The cutoff is the only surviving input a reader can rebuild the
    // handed-over context from: `replaySeedV1.seedText` is blanked the instant
    // the target Agent accepts it. If the sidecar drops it, the boundary can
    // never be explained after the fact.
    expect(readDivider(V.divider.agentEvent)?.sourceCutoffSeqInclusive)
      .toBe(29_979);
    // Only an unreleased intermediate build ever wrote a cutoff-less sidecar,
    // so there is no third "recorded no bound" state to model. It degrades
    // through the already-designed path: strict parse fails, the whole sidecar
    // is dropped, and the row renders its stored prose.
    expect(readDivider(V.divider.cutoffLessSidecarAgentEvent)).toBeNull();
    // Zero is a recorded bound and stays a divider — it must not collapse into
    // the rejected case.
    expect(
      readDivider({
        ...V.divider.agentEvent,
        sessionAgentTransitionV1: V.divider.payload.valid.emptySourceCutoff,
      })?.sourceCutoffSeqInclusive,
    ).toBe(0);
  });

  it('refuses a valid sidecar carried by an ordinary message row', () => {
    // The sidecar alone is not proof. Every generic ingress refuses the reserved
    // `agent-transition:` prefix, so ONLY the owner-only cutover can produce a
    // row at that localId. A reader that trusts the sidecar without the outer
    // localId lets any authorized session writer silence their own row and
    // manufacture a trusted attribution boundary the transition never made.
    expect(readSessionAgentTransitionDividerV1({
      localId: V.divider.expectedLocalId,
      event: V.divider.agentEvent,
    })).toEqual({ v: 1, fromAgentId: 'codex', toAgentId: 'claude', sourceCutoffSeqInclusive: 29_979 });

    for (const localId of V.divider.unreservedLocalIds) {
      expect(
        readSessionAgentTransitionDividerV1({ localId, event: V.divider.agentEvent }),
        localId,
      ).toBeNull();
    }
    for (const localId of [null, undefined, 42]) {
      expect(readSessionAgentTransitionDividerV1({ localId, event: V.divider.agentEvent })).toBeNull();
    }
  });

  it('refuses a stored divider record planted under an ordinary localId', () => {
    const record = {
      role: 'agent',
      content: { type: 'event', id: 'evt_01', data: V.divider.agentEvent },
    };
    expect(readSessionAgentTransitionDividerFromStoredRecordV1({
      localId: V.divider.expectedLocalId,
      record,
    })).toEqual({ v: 1, fromAgentId: 'codex', toAgentId: 'claude', sourceCutoffSeqInclusive: 29_979 });
    expect(readSessionAgentTransitionDividerFromStoredRecordV1({
      localId: V.divider.submittedLocalId,
      record,
    })).toBeNull();
    // The wrapper checks stay: a user-role row at the reserved localId is still
    // not a divider.
    expect(readSessionAgentTransitionDividerFromStoredRecordV1({
      localId: V.divider.expectedLocalId,
      record: { ...record, role: 'user' },
    })).toBeNull();
  });

  it('reads the sidecar only from a well-formed transition message event', () => {
    expect(readDivider(V.divider.agentEvent))
      .toEqual({ v: 1, fromAgentId: 'codex', toAgentId: 'claude', sourceCutoffSeqInclusive: 29_979 });
    expect(readDivider(V.divider.plainMessageAgentEvent)).toBeNull();
    expect(readDivider(V.divider.malformedSidecarAgentEvent)).toBeNull();
    expect(readDivider({ type: 'switch', mode: 'local' })).toBeNull();
    expect(readDivider(null)).toBeNull();
  });

  it('rides the existing message arm of the real transcript record schema', () => {
    const schema = createTranscriptRawRecordV1Schema(z);
    const parsed = schema.safeParse({
      role: 'agent',
      content: { type: 'event', id: 'evt_01', data: V.divider.agentEvent },
    });
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);

    const content = (parsed.data as { content: { data: unknown } }).content;
    expect(readDivider(content.data))
      .toEqual({ v: 1, fromAgentId: 'codex', toAgentId: 'claude', sourceCutoffSeqInclusive: 29_979 });
  });

  it('is not a new agent-event variant, so a released reader keeps rendering it', () => {
    // Exactly the shipped `type:'message'` arm as it existed before this feature.
    const releasedMessageArm = z
      .object({ type: z.literal('message'), message: z.string() })
      .passthrough();

    const parsed = releasedMessageArm.safeParse(V.divider.agentEvent);
    expect(parsed.success).toBe(true);
    // The old reader renders the prose ...
    expect((parsed.data as { message: string }).message).toBe(V.divider.message);
    // ... and its passthrough preserves the sidecar rather than dropping the row.
    expect((parsed.data as Record<string, unknown>)[V.divider.sidecarKey])
      .toEqual({ v: 1, fromAgentId: 'codex', toAgentId: 'claude', sourceCutoffSeqInclusive: 29_979 });
  });
});

describe('source-context spawn recipe', () => {
  it('accepts and rejects the sourceContext vectors', () => {
    expectAllParse(SessionSpawnSourceContextV1Schema, V.sourceContext.valid);
    expectAllReject(SessionSpawnSourceContextV1Schema, V.sourceContext.invalid);
  });

  it('reuses SessionForkPoint rather than inventing a cutoff field', () => {
    expect(
      SessionSpawnSourceContextV1Schema.safeParse(V.sourceContext.invalid.inventedCutoffField)
        .success,
    ).toBe(false);
    expect(SessionSpawnSourceContextV1Schema.parse(V.sourceContext.valid.exactSeq).forkPoint)
      .toEqual({ type: 'seq', upToSeqInclusive: 42 });
  });
});

describe('fork strategy and request identity', () => {
  it('exposes exactly the agreed strategy vocabulary', () => {
    expect([...SessionForkStrategySchema.options].sort()).toEqual([...V.fork.strategies].sort());
  });

  it('accepts the generic native intent and the predecessor requestId', () => {
    expectAllParse(SessionForkRpcParamsSchema, V.fork.valid);
    expectAllReject(SessionForkRpcParamsSchema, V.fork.invalid);
  });

  it('accepts only declared mutation-result fields', () => {
    expectAllParse(SessionForkRpcResultSchema, V.fork.result.valid);
    expectAllReject(SessionForkRpcResultSchema, V.fork.result.invalid);
  });
});

describe('armed composer intent', () => {
  it('accepts and rejects the composer intent vectors', () => {
    expectAllParse(ComposerAgentContinuationIntentV1Schema, V.composerIntent.valid);
    expectAllReject(ComposerAgentContinuationIntentV1Schema, V.composerIntent.invalid);
  });

  it('rejects a review reason persisted on the intent', () => {
    expect(
      ComposerAgentContinuationIntentV1Schema.safeParse(
        V.composerIntent.invalid.persistedReviewReason,
      ).success,
    ).toBe(false);
  });
});
