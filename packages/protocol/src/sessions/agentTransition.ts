import { z } from 'zod';

import { AcpConfigOptionOverridesV1Schema } from './metadata/metadataOverridesV1.js';
import { PendingLocalIdSchema } from './pending/pendingLocalId.js';
import { SessionUserMessageSendRequestSchema } from './userMessageRpc.js';

/**
 * Same-Session cross-Agent continuation — the frozen shared contract.
 *
 * Both trees implement THIS shape. The outer request/result is closed and
 * versioned; the nested user input reuses the already-canonical user-message
 * schema so no second message vocabulary exists.
 *
 * Machine RPC:      session.agentTransition
 * Inspection RPC:   session.continuation.inspect
 */

/* ------------------------------------------------------------------------- *
 * Portable target selection
 * ------------------------------------------------------------------------- */

/**
 * The smallest portable intersection of the two trees' Session authoring field
 * catalogs. Every field below is present with the same shape in BOTH catalogs
 * (`agentId`, `modelId`, `acpSessionModeId`, `sessionConfigOptionOverrides`).
 *
 * Deliberately NOT used here:
 * - `kind:'builtInAgent'` target carriers with a hard-coded agent-id enum. The
 *   agent id is a free catalog identifier resolved and validated by each
 *   daemon's Agent catalog, so adding an Agent never requires a wire change.
 * - `AgentExecutionTargetV1` / `SessionModelSelectionV1`. Both are dev-only
 *   (zero occurrences in the predecessor tree) and cannot be a shared shape.
 *
 * Each daemon adapts this selection into its own internal target/model owners.
 * The adapters are fixed, so no downstream lane has to re-decide them:
 *
 * successor (`dev`)
 * - `agentId` -> Agent catalog resolution -> `AgentExecutionTargetV1`
 *   (`packages/protocol/src/agents/executionTargetV1.ts`).
 * - `modelId` + `providerConnectionId` -> `SessionModelSelectionV1`
 *   (`packages/protocol/src/providers/selection/v1.ts`).
 * - `acpSessionModeId` -> the existing agent/ACP session-mode owner.
 * - `sessionConfigOptionOverrides` -> carried through unchanged.
 *
 * predecessor (`remote-dev`)
 * - `agentId` -> validated against `CATALOG_AGENT_IDS`, then mapped onto the
 *   INTERNAL `{ kind: 'builtInAgent', agentId }` carrier in
 *   `apps/cli/src/rpc/handlers/spawnSessionOptionsContract.ts`. That carrier is
 *   an internal transport detail and never appears on this wire.
 * - `modelId` -> the flat `modelId` spawn field.
 * - `acpSessionModeId` -> the flat `agentModeId` spawn field.
 * - `sessionConfigOptionOverrides` -> the flat field of the same name.
 * - `providerConnectionId` -> NOT representable. Inspection reports it
 *   unavailable and the final mutation rejects with `target_unavailable`; it is
 *   never silently dropped.
 */
export const SessionAgentTransitionSelectionV1Schema = z
  .object({
    v: z.literal(1),
    agentId: z.string().trim().min(1).max(128),
    modelId: z.string().trim().min(1).max(256).optional(),
    /**
     * Model-provider connection. Accepted only where the receiving tree and the
     * exact target can honor it; a tree that cannot MUST reject the transition
     * with `target_unavailable` rather than silently dropping the field.
     * Carried as a plain bounded identifier — never a tree-local branded type.
     */
    providerConnectionId: z.string().trim().min(1).max(128).nullable().optional(),
    acpSessionModeId: z.string().trim().min(1).max(128).nullable().optional(),
    sessionConfigOptionOverrides: AcpConfigOptionOverridesV1Schema.optional(),
  })
  .strict()
  .superRefine((selection, ctx) => {
    if (selection.providerConnectionId == null) return;
    if (typeof selection.modelId === 'string' && selection.modelId.length > 0) return;
    ctx.addIssue({
      code: 'custom',
      path: ['modelId'],
      message: 'modelId is required when providerConnectionId is set.',
    });
  });
export type SessionAgentTransitionSelectionV1 = z.infer<typeof SessionAgentTransitionSelectionV1Schema>;

/* ------------------------------------------------------------------------- *
 * Request
 * ------------------------------------------------------------------------- */

/**
 * The exact user input carried by the transition. It is the canonical
 * user-message request with `localId` promoted from optional to REQUIRED: that
 * localId is the transition's dedupe identity, divider correlation key, and
 * draft compare-clear key, so it can never be absent.
 *
 * `safeExtend` (not `extend`) is required because the dev base schema carries a
 * refinement; it preserves the base sanitization, refinement, and passthrough.
 */
export const SessionAgentTransitionInputV1Schema = SessionUserMessageSendRequestSchema.safeExtend({
  localId: PendingLocalIdSchema,
});
export type SessionAgentTransitionInputV1 = z.infer<typeof SessionAgentTransitionInputV1Schema>;

export const SessionAgentTransitionRequestV1Schema = z
  .object({
    v: z.literal(1),
    sessionId: z.string().trim().min(1),
    /**
     * The Agent the client believes is current. The daemon compares it against
     * decrypted current metadata before stop and again before sealing cutover.
     * The server cannot compare it for an E2EE Session and relies on the
     * metadata tuple/version CAS instead.
     */
    expectedCurrentAgentId: z.string().trim().min(1).max(128),
    selection: SessionAgentTransitionSelectionV1Schema,
    input: SessionAgentTransitionInputV1Schema,
  })
  .strict();
export type SessionAgentTransitionRequestV1 = z.infer<typeof SessionAgentTransitionRequestV1Schema>;

/* ------------------------------------------------------------------------- *
 * Result — partitioned so every code is reachable from exactly one arm
 * ------------------------------------------------------------------------- */

/**
 * Definite rejections with the source PROVABLY untouched and still running.
 * Only these may offer Keep editing / Retry in place.
 *
 * `source_stop_failed` belongs here and only here: it is the stop result that
 * PROVES the source is still running, which is the one stop outcome whose
 * `sourceEffect: 'none'` promise is truthful. An UNCONFIRMED stop
 * (`physical_stop_unconfirmed`, `stopped_projection_unconfirmed`) means the
 * source may already be gone, so it maps to `outcome_unknown` instead — never
 * to a rejection that claims an untouched source.
 */
export const SESSION_AGENT_TRANSITION_REJECTED_CODES_V1 = [
  'unsupported_operation',
  'forbidden',
  'same_target',
  'stale_selection',
  'target_unavailable',
  'source_not_idle',
  'source_stop_failed',
] as const;

/**
 * The source is CONFIRMED stopped and NOTHING was committed. This is a known
 * state, not an indeterminate one: the bounded context pass and the current-view
 * CAS both run after `requestSessionStop` succeeds and before any write.
 *
 * Safe actions: resume the SOURCE, or retry the transition. The UI must not
 * claim the source runtime is still running, and must not offer resume-target —
 * the Session is still owned by the source Agent.
 */
export const SESSION_AGENT_TRANSITION_SOURCE_STOPPED_CODES_V1 = [
  'context_unavailable',
  'cutover_conflict',
] as const;

/**
 * The target current view IS committed: the source is stopped and the Session is
 * now the target Agent. The UI must NOT offer Keep editing; the safe actions are
 * resume-target and send.
 *
 * `divider_missing` and `divider_conflict` are DIFFERENT states and must not be
 * collapsed. `divider_missing` means no row exists at the reserved localId, so
 * resume-and-send normally is safe. `divider_conflict` means a row EXISTS there
 * carrying a different transition payload: the boundary is present but
 * untrustworthy, retrying re-derives the same conflict forever, and — the
 * dangerous part — the bounded context pass must never treat it as a departure
 * boundary.
 *
 * `divider_unknown` is the third and last boundary state: the row could not be
 * read or decoded at all. It is NOT indeterminate — the Session is observably
 * the target — so it must not degrade to `outcome_unknown`, which would tell
 * the user nothing is established in front of a Session that already switched
 * and leave the armed row alive.
 *
 * `input_admission_failed` means admission did not happen; `input_rejected` is a
 * definite rejection by the canonical message owner. Both are only reachable
 * after cutover, so neither may ride `rejected`.
 */
export const SESSION_AGENT_TRANSITION_CURRENT_VIEW_COMMITTED_CODES_V1 = [
  'divider_missing',
  'divider_conflict',
  'divider_unknown',
  'target_start_failed',
  'input_admission_failed',
  'input_rejected',
] as const;

export const SessionAgentTransitionRejectedCodeV1Schema = z.enum(
  SESSION_AGENT_TRANSITION_REJECTED_CODES_V1,
);
export type SessionAgentTransitionRejectedCodeV1 =
  z.infer<typeof SessionAgentTransitionRejectedCodeV1Schema>;

export const SessionAgentTransitionSourceStoppedCodeV1Schema = z.enum(
  SESSION_AGENT_TRANSITION_SOURCE_STOPPED_CODES_V1,
);
export type SessionAgentTransitionSourceStoppedCodeV1 =
  z.infer<typeof SessionAgentTransitionSourceStoppedCodeV1Schema>;

export const SessionAgentTransitionCurrentViewCommittedCodeV1Schema = z.enum(
  SESSION_AGENT_TRANSITION_CURRENT_VIEW_COMMITTED_CODES_V1,
);
export type SessionAgentTransitionCurrentViewCommittedCodeV1 =
  z.infer<typeof SessionAgentTransitionCurrentViewCommittedCodeV1Schema>;

/** Every code the `partially_applied` arm can carry, at either depth. */
export const SESSION_AGENT_TRANSITION_PARTIAL_CODES_V1 = [
  ...SESSION_AGENT_TRANSITION_SOURCE_STOPPED_CODES_V1,
  ...SESSION_AGENT_TRANSITION_CURRENT_VIEW_COMMITTED_CODES_V1,
] as const;

export const SessionAgentTransitionPartialCodeV1Schema = z.enum(
  SESSION_AGENT_TRANSITION_PARTIAL_CODES_V1,
);
export type SessionAgentTransitionPartialCodeV1 =
  z.infer<typeof SessionAgentTransitionPartialCodeV1Schema>;

/**
 * Every transition code. Each one is reachable from exactly one result arm, and
 * each arm maps to a distinct safe-action set.
 *
 * `reconciliation_required` is deliberately absent. Once `partially_applied`
 * carries both known partial depths, the only remaining case is a genuinely
 * indeterminate one — which is exactly the meaning of the bare `outcome_unknown`
 * arm. Keeping a code for it would let a daemon name a state it cannot actually
 * establish.
 */
export const SESSION_AGENT_TRANSITION_ERROR_CODES_V1 = [
  ...SESSION_AGENT_TRANSITION_REJECTED_CODES_V1,
  ...SESSION_AGENT_TRANSITION_PARTIAL_CODES_V1,
] as const;

export const SessionAgentTransitionErrorCodeV1Schema = z.enum(
  SESSION_AGENT_TRANSITION_ERROR_CODES_V1,
);
export type SessionAgentTransitionErrorCodeV1 =
  z.infer<typeof SessionAgentTransitionErrorCodeV1Schema>;

const SessionAgentTransitionAcceptedResultV1Schema = z
  .object({
    type: z.literal('accepted'),
    localId: PendingLocalIdSchema,
  })
  .strict();

const SessionAgentTransitionRejectedResultV1Schema = z
  .object({
    type: z.literal('rejected'),
    code: SessionAgentTransitionRejectedCodeV1Schema,
    /**
     * Always `'none'`. `rejected` is the "nothing happened" arm by construction;
     * any code reachable with the source already stopped lives on
     * `partially_applied` or `outcome_unknown` instead.
     */
    sourceEffect: z.literal('none'),
  })
  .strict();

/**
 * `applied` names exactly how far the transition got, and each depth has its own
 * safe-action set:
 *
 * - `source_stopped` — source confirmed stopped, nothing committed. The Session
 *   is still the SOURCE Agent. Safe actions: resume the source, or retry the
 *   transition. Not resume-target.
 * - `current_view_committed` — the Session IS the target Agent. Safe actions:
 *   resume-target and send. Never Keep editing.
 *
 * `applied` and `code` are correlated at the type level, so a consumer that
 * narrows on `applied` sees only the codes truthfully reachable at that depth,
 * and a producer cannot pair a committed-view code with a stopped-only depth.
 */
const SessionAgentTransitionPartiallyAppliedResultV1Schema = z.discriminatedUnion('applied', [
  z
    .object({
      type: z.literal('partially_applied'),
      localId: PendingLocalIdSchema,
      applied: z.literal('source_stopped'),
      code: SessionAgentTransitionSourceStoppedCodeV1Schema,
    })
    .strict(),
  z
    .object({
      type: z.literal('partially_applied'),
      localId: PendingLocalIdSchema,
      applied: z.literal('current_view_committed'),
      code: SessionAgentTransitionCurrentViewCommittedCodeV1Schema,
    })
    .strict(),
]);

/**
 * Genuinely indeterminate: the daemon cannot establish whether the source
 * stopped, whether cutover happened, or whether the input was admitted. It
 * carries NO code — naming a cause here would claim knowledge the daemon does
 * not have. Every state the daemon CAN name rides `rejected` or
 * `partially_applied`.
 *
 * Safe action: check status. Spawn neither Agent speculatively.
 */
const SessionAgentTransitionOutcomeUnknownResultV1Schema = z
  .object({
    type: z.literal('outcome_unknown'),
    localId: PendingLocalIdSchema,
  })
  .strict();

/**
 * `accepted` means the target current view and divider committed AND the exact
 * localId received canonical message admission. It does not claim provider
 * acceptance.
 */
export const SessionAgentTransitionResultV1Schema = z.union([
  SessionAgentTransitionAcceptedResultV1Schema,
  SessionAgentTransitionRejectedResultV1Schema,
  SessionAgentTransitionPartiallyAppliedResultV1Schema,
  SessionAgentTransitionOutcomeUnknownResultV1Schema,
]);
export type SessionAgentTransitionResultV1 = z.infer<typeof SessionAgentTransitionResultV1Schema>;

/* ------------------------------------------------------------------------- *
 * Live inspection
 * ------------------------------------------------------------------------- */

export const SessionContinuationInspectionRequestV1Schema = z
  .object({
    v: z.literal(1),
    sourceSessionId: z.string().trim().min(1),
    selection: SessionAgentTransitionSelectionV1Schema,
  })
  .strict();
export type SessionContinuationInspectionRequestV1 =
  z.infer<typeof SessionContinuationInspectionRequestV1Schema>;

/**
 * `operation_unavailable` is the collapsed transport outcome: the machine RPC
 * returned METHOD_NOT_AVAILABLE, which a daemon that predates the operation and
 * an unreachable machine both produce. The daemon cannot distinguish them and
 * this contract does not pretend it can — see
 * {@link resolveSessionContinuationUnavailablePresentationV1}.
 */
export const SessionContinuationInspectionUnavailableReasonV1Schema = z.enum([
  'operation_unavailable',
  'unsupported_session',
  'target_unavailable',
]);
export type SessionContinuationInspectionUnavailableReasonV1 =
  z.infer<typeof SessionContinuationInspectionUnavailableReasonV1Schema>;

export const SessionContinuationInspectionV1Schema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('available'),
      protocolVersion: z.literal(1),
      /** In-place transition on the source machine. */
      sameSessionTransition: z.boolean(),
      /** Same-Session only: an inactive native Agent conversation can be resumed. */
      nativeReturn: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal('unavailable'),
      reason: SessionContinuationInspectionUnavailableReasonV1Schema,
    })
    .strict(),
]);
export type SessionContinuationInspectionV1 = z.infer<typeof SessionContinuationInspectionV1Schema>;

/**
 * Machine reachability as the client already knows it, independent of this RPC.
 * Both trees expose `isMachineOnline(machine)` at
 * `apps/ui/sources/utils/sessions/machineUtils.ts`; `'unknown'` covers the case
 * where no machine record has hydrated yet.
 */
export type SessionContinuationMachinePresenceV1 = 'online' | 'offline' | 'unknown';

export const SessionContinuationUnavailablePresentationV1Schema = z.enum([
  /** Daemon is reachable but predates the operation. */
  'update_cli',
  /** The machine is not reachable at all. */
  'machine_offline',
  /** Reachability is unknown, so the cause genuinely cannot be narrowed. */
  'update_or_reconnect',
  'unsupported_session',
  'target_unavailable',
]);
export type SessionContinuationUnavailablePresentationV1 =
  z.infer<typeof SessionContinuationUnavailablePresentationV1Schema>;

/**
 * The transport collapses "old daemon" and "machine unreachable" into one
 * METHOD_NOT_AVAILABLE, so the RPC alone cannot tell them apart. The CLIENT can,
 * by combining the inspection reason with the machine-presence fact it already
 * holds. This is the one owner of that composition — UI surfaces consume it
 * rather than each re-deriving the three-way branch.
 */
export function resolveSessionContinuationUnavailablePresentationV1(
  params: Readonly<{
    reason: SessionContinuationInspectionUnavailableReasonV1;
    machinePresence: SessionContinuationMachinePresenceV1;
  }>,
): SessionContinuationUnavailablePresentationV1 {
  if (params.reason === 'unsupported_session') return 'unsupported_session';
  if (params.reason === 'target_unavailable') return 'target_unavailable';
  if (params.machinePresence === 'offline') return 'machine_offline';
  if (params.machinePresence === 'online') return 'update_cli';
  return 'update_or_reconnect';
}

/* ------------------------------------------------------------------------- *
 * Armed composer intent
 * ------------------------------------------------------------------------- */

/**
 * The persisted draft intent. Selecting another Agent is effect-free; this value
 * only arms the next true submission.
 *
 * It carries no acknowledgment flag, timer, TTL, operation id, or progress
 * phase: the existing draft envelope owns timestamps, revisions, and cleanup.
 */
export const ComposerAgentContinuationIntentV1Schema = z
  .object({
    v: z.literal(1),
    mode: z.literal('same_session'),
    sourceAgentId: z.string().trim().min(1).max(128),
    selection: SessionAgentTransitionSelectionV1Schema,
  })
  .strict();
export type ComposerAgentContinuationIntentV1 =
  z.infer<typeof ComposerAgentContinuationIntentV1Schema>;
