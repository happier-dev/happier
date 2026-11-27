import * as zMini from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { WorkflowTargetUnavailableReasonV1Schema } from './workflowTargetUnavailableReasonV1.js';
import { WorkflowDocumentParseFailureV1Schema } from './workflowDocumentSchemasV1.js';
export { WorkflowTargetUnavailableReasonV1Schema, type WorkflowTargetUnavailableReasonV1,
  WorkflowTargetUnavailableDiagnosticV1Schema, type WorkflowTargetUnavailableDiagnosticV1 } from './workflowTargetUnavailableReasonV1.js';
import { WorkflowDiscussionOriginV1Schema } from './workflowDestinationsV1.js';
import { SessionMessageReplyOutcomeV1Schema } from '../sessions/messages/sessionMessageReplyV1.js';
import { z } from '../zodRuntimePolicy.js';
import { ActionCompletionStateV1Schema } from '../actions/actionCompletion.js';
import { ActionExecuteFailureSchema, ActionFailureCauseV1Schema } from '../actions/actionExecutionResult.js';
import { AgentStartRefusalV1Schema } from '../account/settings/admitAgentStartV1.js';
import { AGENT_START_REFUSAL_CODES_V1 } from '../account/settings/agentStartRefusalCodesV1.js';
import { LegacyAutomationWorkflowConversionReasonV1Schema } from '../automations/automationLegacyWorkflowConversionReasonV1.js';

import { createCanonicalJsonSigningInput } from '../crypto/canonicalJson.js';
import { StrictJsonValueSchema } from '../json/strictJsonValue.js';
import { WorkflowRunStateV1Schema, type WorkflowRunStateV1 } from './workflowRunStateV1.js';
export { WORKFLOW_RUN_STATES_V1, WorkflowRunStateV1Schema, type WorkflowRunStateV1 } from './workflowRunStateV1.js';
import { AutomationRunCauseSchema } from '../automations/automationRunCause.js';
import { AutomationIdV1Schema } from '../automations/automationIdV1.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { AutomationEventSourceDisplayLabelV1Schema, MAX_AUTOMATION_SOURCE_DISPLAY_LABEL_CODE_POINTS } from '../automations/automationEventJsonBoundsV1.js';
import { ExecutionRunResumeHandleProviderSessionV1Schema } from '../execution/runs/startRequest.js';
import { preservedBoundedNfcString } from '../strings/preservedBoundedNfcString.js';
import { normalizeExecutableParticipantSelectionV1 } from '../discussions/executableParticipants.js';
import {
  WorkflowDefinitionIdV1Schema,
  WorkflowInvocationRecordIdSchema,
  WorkflowMachineIdV1Schema,
  WorkflowRunIdV1Schema,
} from './workflowIdsV1.js';
import {
  WorkflowAuthoredResultReferenceSchema,
  WorkflowBlockIdSchema,
  WorkflowInputNameSchema,
  WorkflowInputReferenceV1Schema,
  WorkflowResultPathSchema,
} from './workflowReferenceV1.js';
import { WorkflowStepComposerDocumentSchema } from './workflowComposerDocumentV1.js';
import {
  WorkflowSessionAuthoringSelectionSchema,
  WorkflowStepExecutionSelectionSchema,
  WorkflowValidationIssueV1Schema,
  type WorkflowSessionAuthoringSelection,
  type WorkflowStepExecutionSelection,
} from './workflowV1.js';
import { WorkflowProjectTargetV1Schema, WorkflowWorkspaceProgressV1Schema } from './workflowWorkspaceV1.js';
import { WorkflowResolvedInputsV1Schema, WorkflowRunStartedByV1Schema, WorkflowDefinitionContentUnavailableReasonV1Schema, WorkflowDefinitionSavedByV1Schema } from './workflowDefinitionV1.js';
import { WorkflowDestinationsV1Schema } from './workflowDestinationsV1.js';
import { SessionRuntimeIssueV1Schema } from '../sessions/control/runtimeIssueV1.js';
import { StoredPluginJsonSchemaValueIssueSchema } from '../plugins/actions/jsonSchemaValidationIssue.js';

export {
  WorkflowDefinitionIdV1Schema,
  WorkflowInvocationRecordIdSchema,
  WorkflowMachineIdV1Schema,
  WorkflowRunIdV1Schema,
} from './workflowIdsV1.js';
export const WorkflowDecimalV1Schema = lazyZodSchema(() => z.string().check(z.regex(/^(0|[1-9][0-9]*)$/, 'Expected a canonical nonnegative decimal string')));
export type WorkflowDecimalV1 = z.infer<typeof WorkflowDecimalV1Schema>;

export function projectWorkflowBigIntV1(value: bigint): WorkflowDecimalV1 {
  if (value < 0n) throw new TypeError('Workflow counters must be nonnegative');
  return WorkflowDecimalV1Schema.parse(value.toString(10));
}

export const WORKFLOW_INVOCATION_LIFECYCLES_V1 = [
  'pending', 'waiting_for_capacity', 'admitting', 'running', 'waiting_for_approval',
  'needs_attention', 'waiting_for_review', 'completed', 'failed', 'skipped', 'cancel_requested',
  'cancelled', 'outcome_uncertain', 'superseded',
] as const;
export const WorkflowInvocationLifecycleV1Schema = lazyZodSchema(() => z.enum(WORKFLOW_INVOCATION_LIFECYCLES_V1));
export type WorkflowInvocationLifecycleV1 = z.infer<typeof WorkflowInvocationLifecycleV1Schema>;

/**
 * Final execution outcomes for ordinary fact publication. An uncertain outcome
 * may still retain custody until an authorized observation resolves it.
 */
const terminalInvocationLifecycles: ReadonlySet<string> = new Set([
  'completed', 'failed', 'skipped', 'cancelled', 'outcome_uncertain', 'superseded',
] as const satisfies readonly WorkflowInvocationLifecycleV1[]);

export function isTerminalWorkflowInvocationLifecycleV1(lifecycle: string): boolean {
  return terminalInvocationLifecycles.has(lifecycle);
}

/** Indexed custody that must resolve before a terminal Run may settle. */
export const WORKFLOW_UNSETTLED_INVOCATION_LIFECYCLES_V1 = [
  'pending', 'waiting_for_capacity', 'admitting', 'running', 'waiting_for_approval',
  'needs_attention', 'cancel_requested', 'outcome_uncertain', 'waiting_for_review',
] as const satisfies readonly WorkflowInvocationLifecycleV1[];
export const WorkflowInvocationBlockKindV1Schema = lazyZodSchema(() => z.enum(['root', 'step', 'action', 'wait', 'workflow', 'parallel', 'loop', 'if']));

/** Lifecycle eligibility only; the authorized host validates exact initial-input and frozen leaf evidence. */
export function isWorkflowDraftPublicationLifecycleV1(lifecycle: WorkflowInvocationLifecycleV1): boolean {
  return lifecycle === 'admitting' || lifecycle === 'running' || lifecycle === 'waiting_for_approval'
    || lifecycle === 'waiting_for_review';
}

/** Canonical actionable-row vocabulary shared by storage and presentation. */
export const WORKFLOW_ATTENTION_INVOCATION_LIFECYCLES_V1 = [
  'waiting_for_approval', 'needs_attention', 'waiting_for_review', 'outcome_uncertain',
] as const satisfies readonly WorkflowInvocationLifecycleV1[];

export const WorkflowControlV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('running') }),
  z.strictObject({ kind: z.literal('pause_requested') }),
  z.strictObject({ kind: z.literal('paused'), reason: z.literal('boundary') }),
  z.strictObject({
    kind: z.literal('interrupted'),
    reason: z.enum(['invocation_failed', 'runtime_interrupted', 'outcome_uncertain']),
  }),
  z.strictObject({ kind: z.literal('terminal') }),
]));
export type WorkflowControlV1 = z.infer<typeof WorkflowControlV1Schema>;

export const WorkflowRunAutomationOriginV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('automation'),
  automationId: asProtocolZod(AutomationIdV1Schema),
  originSessionId: zMini.optional(preservedBoundedNfcString(191, 'Session ids')),
  /** Bounded immutable provenance; private occurrence content is never projected here. */
  cause: zMini.optional(AutomationRunCauseSchema),
}));
export const WorkflowRunDirectOriginV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('direct'),
  originSessionId: zMini.optional(preservedBoundedNfcString(191, 'Session ids')),
  discussion: z.optional(WorkflowDiscussionOriginV1Schema),
}));
export const WorkflowRunOriginV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  WorkflowRunAutomationOriginV1Schema,
  WorkflowRunDirectOriginV1Schema,
]));
export type WorkflowRunOriginV1 = z.infer<typeof WorkflowRunOriginV1Schema>;

export const WorkflowRunCustodyStateV1Schema = lazyZodSchema(() => z.enum(['pending', 'settled']));
export type WorkflowRunCustodyStateV1 = z.infer<typeof WorkflowRunCustodyStateV1Schema>;

export const WorkflowRunAvailabilityV1Schema = lazyZodSchema(() => z.strictObject({
  pause: z.boolean(),
  resumeBoundary: z.boolean(),
  restoreWorkspace: z.boolean(),
  cancel: z.boolean(),
  inspectExecution: z.boolean(),
  disabledReasons: z.array(z.strictObject({ operation: z.enum([
    'pause', 'resume_boundary', 'recover_same_conversation', 'recover_fresh_agent',
    'retry', 'restore_workspace', 'cancel', 'inspect_execution',
  ]), code: z.string().check(z.minLength(1)) })),
}));
export type WorkflowRunAvailabilityV1 = z.infer<typeof WorkflowRunAvailabilityV1Schema>;

export const WorkflowInvocationRecoveryUnavailableReasonV1Schema = lazyZodSchema(() => z.enum([
  'run_not_interrupted',
  'invocation_not_recoverable',
  'execution_not_admitted',
  'workspace_unavailable',
  'stop_pending',
  'recovery_not_prepared',
  'causal_set_requires_batch_review',
]));
export const WorkflowInvocationRecoveryOperationAvailabilityV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('available') }),
  z.strictObject({
    kind: z.literal('unavailable'),
    reason: WorkflowInvocationRecoveryUnavailableReasonV1Schema,
  }),
]));
export const WorkflowInvocationRetryAvailabilityV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('available'),
    causalInvocationIds: z.array(WorkflowInvocationRecordIdSchema).check(z.minLength(1)),
  }),
  z.strictObject({
    kind: z.literal('unavailable'),
    reason: WorkflowInvocationRecoveryUnavailableReasonV1Schema,
  }),
]));
export const WorkflowInvocationRecoveryAvailabilityV1Schema = lazyZodSchema(() => z.strictObject({
  reattach: WorkflowInvocationRecoveryOperationAvailabilityV1Schema,
  retry: WorkflowInvocationRetryAvailabilityV1Schema,
  continueSameConversation: WorkflowInvocationRecoveryOperationAvailabilityV1Schema,
  continueFreshAgent: WorkflowInvocationRecoveryOperationAvailabilityV1Schema,
  restoreWorkspace: WorkflowInvocationRecoveryOperationAvailabilityV1Schema,
}));
export type WorkflowInvocationRecoveryAvailabilityV1 = z.infer<typeof WorkflowInvocationRecoveryAvailabilityV1Schema>;

export const WorkflowRunStepProgressV1Schema = lazyZodSchema(() => z.strictObject({
  completed: z.number().check(z.int(), z.nonnegative(), z.int()),
  /** Authored leaves proven skipped by settled execution; omitted history is unknown. */
  skipped: z.optional(z.number().check(z.int(), z.nonnegative())),
  total: z.number().check(z.int(), z.nonnegative(), z.int()),
  /** Accepted writers and their exact last observed facts; absence never means pending or completed. */
  destinations: z.optional(z.array((<T extends zMini.ZodMiniObject>(schema: T) => zMini.core.clone(schema, { ...schema._zod.def, catchall: zMini.never() }) as zMini.ZodMiniObject<T['shape'], zMini.core.$strict>)(zMini.extend(WorkflowDestinationsV1Schema.shape.leaves._zod.def.element, {
    observation: z.optional(z.strictObject({
      recordId: WorkflowInvocationRecordIdSchema,
      sequence: WorkflowDecimalV1Schema,
      attempt: WorkflowDecimalV1Schema,
      contentRevision: WorkflowDecimalV1Schema,
      lifecycle: WorkflowInvocationLifecycleV1Schema,
      blockKind: z.optional(WorkflowInvocationBlockKindV1Schema),
    })),
  })))),
  currentLoop: z.optional(z.strictObject({
    completed: z.number().check(z.int(), z.nonnegative(), z.int()),
    total: z.number().check(z.int(), z.nonnegative(), z.int()),
  }).check(z.refine((value) => value.completed <= value.total))),
}).check(z.refine((value) => value.completed + (value.skipped ?? 0) <= value.total)));
export type WorkflowRunStepProgressV1 = z.infer<typeof WorkflowRunStepProgressV1Schema>;

/** Existing root row observation; counts can decrease when the current attempt changes. */
export const WorkflowRunStepProgressCurrentnessV1Schema = lazyZodSchema(() => z.strictObject({
  recordId: WorkflowInvocationRecordIdSchema,
  attempt: WorkflowDecimalV1Schema,
  contentRevision: WorkflowDecimalV1Schema,
}));
export type WorkflowRunStepProgressCurrentnessV1 = z.infer<typeof WorkflowRunStepProgressCurrentnessV1Schema>;

export const WORKFLOW_RUN_MACHINE_START_CAPACITY_WAIT_V1 = 'machine_start_capacity';
export const WORKFLOW_RUN_STOPPED_BY_MACHINE_OWNER_V1 = 'stopped_by_machine_owner';

export const WorkflowRunSummaryV1Schema = lazyZodSchema(() => z.strictObject({
  /** Display-only attribution from this occurrence's opened, frozen accepted source. */
  sourceSavedBy: z.optional(WorkflowDefinitionSavedByV1Schema),
  startedBy: zMini.optional(zMini.nullable(WorkflowRunStartedByV1Schema)),
  stepProgress: z.optional(z.nullable(WorkflowRunStepProgressV1Schema)),
  stepProgressCurrentness: z.optional(z.nullable(WorkflowRunStepProgressCurrentnessV1Schema)),
  /** Opened root progress. Null clears the wait; omission supplies no root observation. */
  startWaitReason: z.optional(z.nullable(z.literal(WORKFLOW_RUN_MACHINE_START_CAPACITY_WAIT_V1))),
  /** Authorized attention-list projection; null clears a hold, omission preserves a prior observation. */
  heldStep: z.optional(z.nullable(z.union([
    z.strictObject({
      // Existing review holds have no discriminator on the wire.
      kind: z.optional(z.literal('waiting_for_review')),
      invocationId: WorkflowInvocationRecordIdSchema,
      label: z.string().check(z.minLength(1)),
      laneLabel: z.optional(z.string().check(z.minLength(1))),
    }),
    z.strictObject({
      kind: z.literal('child_session_permission'),
      invocationId: WorkflowInvocationRecordIdSchema,
      label: z.string().check(z.minLength(1)),
      laneLabel: z.optional(z.string().check(z.minLength(1))),
      sessionId: preservedBoundedNfcString(191, 'Session ids'),
    }),
  ]))),
  /** Server-indexed current review holds; omission means the operation did not read the count. */
  heldCount: z.optional(z.number().check(z.int(), z.nonnegative(), z.int())),
  /** Opened by the authorized list host; null is unreadable, omission is an operation that did not open it. */
  where: zMini.optional(zMini.nullable(WorkflowProjectTargetV1Schema)),
  /** Current server attention membership, combining the owner notice and genuine invocation holds. */
  attentionRequired: z.boolean(),
  failureUnseen: z.boolean(),
  invocationAttentionRequired: z.boolean(),
  /** Owner-private acknowledgement; non-owner projections redact it to null. */
  attentionSeenFailureAt: z.nullable(z.string().check(z.iso.datetime())),
  sourceArtifactId: zMini.nullable(WorkflowDefinitionIdV1Schema),
  ownerAccountId: preservedBoundedNfcString(191, 'Account ids'),
  visibleTeamId: zMini.nullable(preservedBoundedNfcString(191, 'Team ids')),
  id: WorkflowRunIdV1Schema,
  origin: WorkflowRunOriginV1Schema,
  /** Retained Automation scope from the Run producer; null is Account scope, omission is unread. */
  automationScopeSessionId: zMini.optional(zMini.nullable(preservedBoundedNfcString(191, 'Session ids'))),
  state: WorkflowRunStateV1Schema,
  /** Content-free refusal recorded by the existing Run terminal writer. */
  errorCode: z.optional(z.nullable(z.string().check(z.minLength(1)))),
  revision: z.number().check(z.int(), z.nonnegative(), z.int()),
  machineId: WorkflowMachineIdV1Schema,
  workflowCustodyState: z.nullable(WorkflowRunCustodyStateV1Schema),
  originDeliveryAckRevision: z.nullable(z.number().check(z.int(), z.nonnegative(), z.int())),
  availability: WorkflowRunAvailabilityV1Schema,
  createdAt: z.string().check(z.iso.datetime()),
  updatedAt: z.string().check(z.iso.datetime()),
  /**
   * When the Run reached its terminal state, as the server recorded that transition; null while it
   * has not. Unlike `updatedAt`, later custody or delivery bookkeeping never moves it.
   */
  finishedAt: z.nullable(z.string().check(z.iso.datetime())),
}));
export type WorkflowRunSummaryV1 = z.infer<typeof WorkflowRunSummaryV1Schema>;

/** Latest-started Run facts shared by Automation and selected-trigger summaries. */
export const WorkflowRunLastStartedSummaryV1Schema = lazyZodSchema(() => z.strictObject({
  ...z.pick(WorkflowRunSummaryV1Schema, { id: true, state: true, workflowCustodyState: true,
    attentionRequired: true, failureUnseen: true, invocationAttentionRequired: true, createdAt: true }).shape,
  startedAt: z.string().check(z.iso.datetime()),
}));
export type WorkflowRunLastStartedSummaryV1 = z.infer<typeof WorkflowRunLastStartedSummaryV1Schema>;

/** Public-index-only parent witness used by the exact-machine recovery reader. */
export const WorkflowRunRecoveryCandidateV1Schema = lazyZodSchema(() => z.strictObject({
  run: WorkflowRunSummaryV1Schema,
  parentAttempt: z.number().check(z.int(), z.nonnegative(), z.int()),
}));
export type WorkflowRunRecoveryCandidateV1 = z.infer<typeof WorkflowRunRecoveryCandidateV1Schema>;

export const WorkflowRunInvocationIndexV1Schema = lazyZodSchema(() => z.strictObject({
  id: WorkflowInvocationRecordIdSchema,
  runId: WorkflowRunIdV1Schema,
  sequence: WorkflowDecimalV1Schema,
  parentRecordId: zMini.nullable(WorkflowInvocationRecordIdSchema),
  memberOrdinal: WorkflowDecimalV1Schema,
  attempt: WorkflowDecimalV1Schema,
  contentRevision: WorkflowDecimalV1Schema,
  lifecycle: WorkflowInvocationLifecycleV1Schema,
  createdAt: z.string().check(z.iso.datetime()),
  updatedAt: z.string().check(z.iso.datetime()),
}));
export type WorkflowRunInvocationIndexV1 = z.infer<typeof WorkflowRunInvocationIndexV1Schema>;

/** Fact acknowledgement observes the row and parent revision in the same transaction. */
export const WorkflowInvocationFactResultV1Schema = lazyZodSchema(() => (<T extends zMini.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as zMini.ZodMiniObject<T['shape'], zMini.core.$strict>)(z.extend(WorkflowRunInvocationIndexV1Schema, {
  parentRevision: z.number().check(z.int(), z.nonnegative(), z.int()),
})));

export const WorkflowInvocationPathV1Schema = lazyZodSchema(() => z.strictObject({
  blockId: z.union([WorkflowBlockIdSchema, z.literal('$root')]),
  scope: z.array(z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('branch'), blockId: WorkflowBlockIdSchema, branchId: WorkflowBlockIdSchema }),
    z.strictObject({ kind: z.literal('iteration'), blockId: WorkflowBlockIdSchema, index: z.number().check(z.int(), z.nonnegative(), z.int()) }),
    z.strictObject({ kind: z.literal('workflow'), blockId: WorkflowBlockIdSchema }),
  ])),
}));
export type WorkflowInvocationPathV1 = z.infer<typeof WorkflowInvocationPathV1Schema>;

const WorkflowExecutionCorrespondenceBaseV1Schema = lazyZodSchema(() => z.object({
  localInputId: preservedBoundedNfcString(191, 'Execution input local ids'),
  turnId: zMini.optional(preservedBoundedNfcString(191, 'Turn ids')),
}));

/**
 * Secret-free immutable runtime selection retained with a Workflow conversation.
 *
 * This deliberately reuses the portable Session-authoring selection owner. Its
 * schema excludes workspace/conversation identity and raw environment or
 * credential material, while preserving exact Agent/model/profile/permission,
 * config, MCP and Connected Service intent. The workflow execution adapter
 * supplies the effective selection that it actually admitted.
 */
/** The retained Project address and saved-secret bindings are launch selections. */
export const WorkflowRetainedRuntimeSelectionV1Schema = lazyZodSchema(() => z.extend(
  WorkflowSessionAuthoringSelectionSchema,
  z.pick(WorkflowStepExecutionSelectionSchema, { projectContext: true, secretReferenceOverlay: true }).shape,
));
export type WorkflowRetainedRuntimeSelectionV1 = WorkflowSessionAuthoringSelection
  & Pick<WorkflowStepExecutionSelection, 'projectContext' | 'secretReferenceOverlay'>;

export function projectWorkflowRetainedRuntimeSelectionV1(
  selection: WorkflowStepExecutionSelection,
): WorkflowRetainedRuntimeSelectionV1 {
  const { conversation: _conversation, workspace: _workspace, ...runtimeSelection } = selection;
  return WorkflowRetainedRuntimeSelectionV1Schema.parse(runtimeSelection);
}

/**
 * Exact, key-order-independent equality for retained conversation reuse.
 * Invalid or missing witnesses fail closed instead of being interpreted as a
 * matching default selection.
 */
export function areWorkflowRetainedRuntimeSelectionsEqualV1(
  retained: unknown,
  requested: unknown,
): boolean {
  const retainedSelection = WorkflowRetainedRuntimeSelectionV1Schema.safeParse(retained);
  const requestedSelection = WorkflowRetainedRuntimeSelectionV1Schema.safeParse(requested);
  if (!retainedSelection.success || !requestedSelection.success) return false;
  try {
    return createCanonicalJsonSigningInput(retainedSelection.data)
      === createCanonicalJsonSigningInput(requestedSelection.data);
  } catch {
    // Optional object members may be explicitly present as `undefined` in
    // process-local callers even though that is not strict JSON. Such a witness
    // cannot prove retained runtime compatibility.
    return false;
  }
}

export const WorkflowExecutionCorrespondenceV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('session_ready'),
    sessionId: preservedBoundedNfcString(191, 'Session ids'),
  }),
  (<T extends zMini.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as zMini.ZodMiniObject<T['shape'], zMini.core.$strict>)(z.extend(WorkflowExecutionCorrespondenceBaseV1Schema, {
    kind: z.literal('action'),
    actionId: z.string().check(z.minLength(1)),
    actionRequestId: preservedBoundedNfcString(191, 'Action request ids'),
    input: z.record(z.string(), StrictJsonValueSchema),
    output: zMini.optional(ActionCompletionStateV1Schema.shape.output),
    awaitedRuns: zMini.optional(ActionCompletionStateV1Schema.shape.awaitedRuns),
    awaitedOperations: zMini.optional(ActionCompletionStateV1Schema.shape.awaitedOperations),
    awaitedWorkflows: zMini.optional(ActionCompletionStateV1Schema.shape.awaitedWorkflows),
  })),
  (<T extends zMini.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as zMini.ZodMiniObject<T['shape'], zMini.core.$strict>)(z.extend(WorkflowExecutionCorrespondenceBaseV1Schema, {
    kind: z.literal('session'),
    sessionId: preservedBoundedNfcString(191, 'Session ids'),
  })),
  (<T extends zMini.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as zMini.ZodMiniObject<T['shape'], zMini.core.$strict>)(z.extend(WorkflowExecutionCorrespondenceBaseV1Schema, {
    kind: z.literal('detached_run'),
    runId: preservedBoundedNfcString(191, 'Execution Run ids'),
    runtimeSelection: WorkflowRetainedRuntimeSelectionV1Schema,
    /**
     * First provider-owned resumable identity validated by the Execution Run
     * host for this exact detached invocation. This private correspondence is
     * the durable owner; public Run projections and activity markers are not
     * restart authority.
     */
    providerResumeIdentity: zMini.optional(ExecutionRunResumeHandleProviderSessionV1Schema),
  })),
]));
export type WorkflowExecutionCorrespondenceV1 = z.infer<typeof WorkflowExecutionCorrespondenceV1Schema>;

/** A private occurrence label uses the existing Automation display-label budget, never a JSON preview. */
export function projectWorkflowLoopItemDisplayLabelV1(value: unknown): string | undefined {
  const scalar = (candidate: unknown): string | undefined => {
    if (typeof candidate !== 'string' && typeof candidate !== 'number' && typeof candidate !== 'boolean') return undefined;
    const label = String(candidate).replace(/\s+/gu, ' ').trim().normalize('NFC');
    if (!label) return undefined;
    // A single item-name line is a projection: keep useful long values with an explicit ellipsis.
    const points = Array.from(label);
    return points.length <= MAX_AUTOMATION_SOURCE_DISPLAY_LABEL_CODE_POINTS ? label
      : points.slice(0, MAX_AUTOMATION_SOURCE_DISPLAY_LABEL_CODE_POINTS - 1).join('') + '…';
  };
  if (value === null || typeof value !== 'object') return scalar(value);
  if (Array.isArray(value)) return undefined;
  const fields = value as Record<string, unknown>;
  // Participant identity is not a name. The Run reader resolves Sessions through
  // its Home-qualified title owner; a model may already carry an authored title.
  const participant = fields.kind === 'session' || fields.kind === 'bot' || fields.kind === 'model'
    ? normalizeExecutableParticipantSelectionV1(value) : null;
  if (participant !== null) return participant.kind === 'model' ? scalar(participant.launch.title) : undefined;
  for (const key of ['title', 'displayName', 'name']) {
    const label = Object.prototype.hasOwnProperty.call(fields, key) ? scalar(fields[key]) : undefined;
    if (label !== undefined) return label;
  }
  return undefined;
}

export const WorkflowInvocationFrameV1Schema = lazyZodSchema(() => z.strictObject({
  ownerBlockId: WorkflowBlockIdSchema,
  source: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('branch'), branchId: WorkflowBlockIdSchema }),
    z.strictObject({ kind: z.literal('item'), index: WorkflowDecimalV1Schema,
      /** Frozen from the selected item value, under the same private progress binding. */
      displayLabel: zMini.optional(AutomationEventSourceDisplayLabelV1Schema) }),
    z.strictObject({ kind: z.literal('iteration'), index: WorkflowDecimalV1Schema }),
  ]),
}));
export type WorkflowInvocationFrameV1 = z.infer<typeof WorkflowInvocationFrameV1Schema>;

export const WorkflowLoopOutcomeV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('decision'), value: z.string(), reason: z.optional(z.string()) }),
  z.strictObject({ kind: z.literal('stop_condition'), arm: z.optional(z.number().check(z.int(), z.nonnegative(), z.int())) }),
  z.strictObject({ kind: z.literal('exhausted'), rounds: z.number().check(z.int(), z.positive(), z.int()) }),
]));
export type WorkflowLoopOutcomeV1 = z.infer<typeof WorkflowLoopOutcomeV1Schema>;

export const WorkflowContainerClosingV1Schema = lazyZodSchema(() => z.strictObject({
  code: preservedBoundedNfcString(191, 'Workflow container closing codes'),
  causeInvocationRecordId: zMini.optional(WorkflowInvocationRecordIdSchema),
  outcome: z.optional(WorkflowLoopOutcomeV1Schema),
}));
export type WorkflowContainerClosingV1 = z.infer<typeof WorkflowContainerClosingV1Schema>;

export const WorkflowLoopSourceSelectionV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('definition'),
    reference: z.union([
      z.strictObject({ kind: z.literal('literal'), value: StrictJsonValueSchema }),
      WorkflowInputReferenceV1Schema,
    ]),
  }),
  z.strictObject({
    kind: z.literal('result'),
    recordId: WorkflowInvocationRecordIdSchema,
    path: WorkflowResultPathSchema,
  }),
]));
export type WorkflowLoopSourceSelectionV1 = z.infer<typeof WorkflowLoopSourceSelectionV1Schema>;

const WorkflowContainerBodyProgressV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('body'),
  nextBlockOrdinal: WorkflowDecimalV1Schema,
  /** Inline Workflow admission binds once, including live context references. */
  frameInputs: zMini.optional(WorkflowResolvedInputsV1Schema),
  /** Selected project is distinct from the inline child's lazy default workspace. */
  frameProjectWorkspace: zMini.optional(WorkflowWorkspaceProgressV1Schema),
  closing: z.optional(WorkflowContainerClosingV1Schema),
}));
const WorkflowContainerParallelProgressV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('parallel'),
  nextBranchOrdinal: WorkflowDecimalV1Schema,
  closing: z.optional(WorkflowContainerClosingV1Schema),
}));
const WorkflowContainerIfProgressV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('if'),
  selected: z.enum(['then', 'otherwise']),
  nextBlockOrdinal: WorkflowDecimalV1Schema,
  closing: z.optional(WorkflowContainerClosingV1Schema),
}));
const WorkflowContainerLoopBaseV1Schema = lazyZodSchema(() => z.object({
  kind: z.literal('loop'),
  nextMemberIndex: WorkflowDecimalV1Schema,
  nextBodyBlockOrdinal: WorkflowDecimalV1Schema,
  closing: z.optional(WorkflowContainerClosingV1Schema),
}));
export const WorkflowContainerProgressV1Schema = lazyZodSchema(() => z.union([
  WorkflowContainerBodyProgressV1Schema,
  WorkflowContainerParallelProgressV1Schema,
  WorkflowContainerIfProgressV1Schema,
  (<T extends zMini.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as zMini.ZodMiniObject<T['shape'], zMini.core.$strict>)(z.extend(WorkflowContainerLoopBaseV1Schema, {
    mode: z.literal('count'),
    source: WorkflowLoopSourceSelectionV1Schema,
    count: WorkflowDecimalV1Schema,
  })),
  (<T extends zMini.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as zMini.ZodMiniObject<T['shape'], zMini.core.$strict>)(z.extend(WorkflowContainerLoopBaseV1Schema, {
    mode: z.literal('items'),
    source: WorkflowLoopSourceSelectionV1Schema,
    itemCount: WorkflowDecimalV1Schema,
  })),
  (<T extends zMini.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as zMini.ZodMiniObject<T['shape'], zMini.core.$strict>)(z.extend(WorkflowContainerLoopBaseV1Schema, { mode: z.literal('until') })),
  (<T extends zMini.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as zMini.ZodMiniObject<T['shape'], zMini.core.$strict>)(z.extend(WorkflowContainerLoopBaseV1Schema, { mode: z.literal('evaluate') })),
]));
export type WorkflowContainerProgressV1 = z.infer<typeof WorkflowContainerProgressV1Schema>;

export const WorkflowContainerResultSelectorV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('container'),
  containerRecordId: WorkflowInvocationRecordIdSchema,
}));
export type WorkflowContainerResultSelectorV1 = z.infer<typeof WorkflowContainerResultSelectorV1Schema>;

export const WorkflowAuthoredInputV1Schema = lazyZodSchema(() => z.strictObject({
  document: WorkflowStepComposerDocumentSchema,
  input: z._default(z.array(StrictJsonValueSchema), []),
  /** Producer-rendered origin input, frozen atomically with its admitting correspondence. */
  renderedText: z.optional(z.string()),
}));
export type WorkflowAuthoredInputV1 = z.infer<typeof WorkflowAuthoredInputV1Schema>;

const WorkflowRecoveryInputV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('original') }),
  z.strictObject({ kind: z.literal('replacement'), value: WorkflowAuthoredInputV1Schema }),
]));

export const WorkflowInvocationRecoveryV1Schema = lazyZodSchema(() => z.strictObject({
  conversation: z.enum(['same_conversation', 'fresh_agent']),
  input: WorkflowRecoveryInputV1Schema,
  acknowledgeUncertainPriorEffects: z.optional(z.literal(true)),
}));
export type WorkflowInvocationRecoveryV1 = z.infer<typeof WorkflowInvocationRecoveryV1Schema>;

/**
 * Exact provider-reported usage attributable to one Workflow leaf invocation.
 * Missing members mean the execution owner did not report that dimension.
 */
export const WorkflowUsageV1Schema = lazyZodSchema(() => z.strictObject({
  inputTokens: z.optional(z.number().check(z.int(), z.int(), z.nonnegative())),
  outputTokens: z.optional(z.number().check(z.int(), z.int(), z.nonnegative())),
  costUsd: z.optional(z.number().check(z.nonnegative())),
}));
export type WorkflowUsageV1 = z.infer<typeof WorkflowUsageV1Schema>;

export const WorkflowConversationRefV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('session'), machineId: WorkflowMachineIdV1Schema, sessionId: z.string().check(z.minLength(1)) }),
  z.strictObject({ kind: z.literal('detached_run'), machineId: WorkflowMachineIdV1Schema, runId: z.string().check(z.minLength(1)) }),
]));
export const WorkflowInputRefV1Schema = lazyZodSchema(() => z.strictObject({
  conversation: WorkflowConversationRefV1Schema,
  localId: z.string().check(z.minLength(1)),
  turnId: z.optional(z.string().check(z.minLength(1))),
}));

export const WorkflowReviewResultSourceV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('execution_input') }),
  z.strictObject({ kind: z.literal('published'), by: z.enum(['agent', 'user']),
    input: z.optional(WorkflowInputRefV1Schema) }),
  z.strictObject({ kind: z.literal('human'), accountId: preservedBoundedNfcString(191, 'Account ids') }),
]));
export type WorkflowReviewResultSourceV1 = z.infer<typeof WorkflowReviewResultSourceV1Schema>;
export const WorkflowReviewFollowUpV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('run_started'), runId: WorkflowRunIdV1Schema }),
  z.strictObject({ kind: z.literal('editing') }),
]));
export const WorkflowReviewDecisionV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('use_result'), requestedFromContentRevision: WorkflowDecimalV1Schema,
    followUp: z.optional(WorkflowReviewFollowUpV1Schema) }),
  z.strictObject({ kind: z.literal('generate'), requestedFromContentRevision: WorkflowDecimalV1Schema }),
]));
export const WorkflowReviewV1Schema = lazyZodSchema(() => z.strictObject({
  resultSource: z.optional(WorkflowReviewResultSourceV1Schema),
  decision: z.optional(WorkflowReviewDecisionV1Schema),
}));
export type WorkflowReviewV1 = z.infer<typeof WorkflowReviewV1Schema>;

const WorkflowResultValidationIssuesV1Schema = lazyZodSchema(() => z.array(StoredPluginJsonSchemaValueIssueSchema));

/** Condition outcome, not delivery success. Absence means it has not been observed. */
export const WorkflowNotificationConditionV1Schema = lazyZodSchema(() => z.enum(['matched', 'suppressed']));
export type WorkflowNotificationConditionV1 = z.infer<typeof WorkflowNotificationConditionV1Schema>;
export const WorkflowResultProvenanceV1Schema = lazyZodSchema(() => z.record(WorkflowInvocationRecordIdSchema,
  z.strictObject({ notificationCondition: WorkflowNotificationConditionV1Schema })));
export type WorkflowResultProvenanceV1 = z.infer<typeof WorkflowResultProvenanceV1Schema>;

export function mergeWorkflowNotificationConditionV1(
  current: WorkflowNotificationConditionV1 | undefined, incoming: WorkflowNotificationConditionV1 | undefined,
): WorkflowNotificationConditionV1 | undefined {
  return current === 'matched' || incoming === 'matched' ? 'matched' : current ?? incoming;
}

/** Several Notify me consumers may bind one physical result; a matched condition prevents quiet collapse. */
export function mergeWorkflowResultProvenanceV1(
  current: WorkflowResultProvenanceV1 | undefined, incoming: WorkflowResultProvenanceV1,
): WorkflowResultProvenanceV1 {
  const next = { ...current };
  for (const [id, fact] of Object.entries(incoming)) {
    next[id] = { notificationCondition: mergeWorkflowNotificationConditionV1(current?.[id]?.notificationCondition, fact.notificationCondition)! };
  }
  return next;
}

/** Diagnostic kinds/ids only; never raw selections, credential values or prompt content. */
export const WorkflowConversationUnavailableDetailsV1Schema = lazyZodSchema(() => z.strictObject({
  code: z.literal('workflow_conversation_unavailable'),
  reason: z.enum([
    ...zMini.keyof(WorkflowSessionAuthoringSelectionSchema).options,
    'recovery_execution_missing', 'target_kind_mismatch', 'session_unavailable', 'producer_conversation_missing',
    'origin_session_missing', 'session_identity_mismatch', 'machine_mismatch', 'workspace_mismatch', 'workspace_unavailable',
    'account_scope_unavailable', 'owner_metadata_unavailable', 'work_depth_unavailable',
  ]),
  expected: z.strictObject({ kind: z.enum(['unset', 'null', 'object', 'string', 'number', 'boolean', 'array', 'agent',
    'available', 'unavailable', 'session', 'session_ready', 'detached_run', 'action']), ids: z.optional(z.array(z.string().check(z.minLength(1)))) }),
  observed: z.strictObject({ kind: z.enum(['unset', 'null', 'object', 'string', 'number', 'boolean', 'array', 'agent',
    'available', 'unavailable', 'session', 'session_ready', 'detached_run', 'action']), ids: z.optional(z.array(z.string().check(z.minLength(1)))) }),
}));
export type WorkflowConversationUnavailableDetailsV1 = z.infer<typeof WorkflowConversationUnavailableDetailsV1Schema>;

export const WorkflowProgressEnvelopeV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('happier.workflow-progress.v1'),
  invocationPath: WorkflowInvocationPathV1Schema,
  frame: z.optional(WorkflowInvocationFrameV1Schema),
  blockKind: WorkflowInvocationBlockKindV1Schema,
  /** Executing worker's private authored-step projection, retained on the root row only. */
  stepProgress: z.optional(WorkflowRunStepProgressV1Schema),
  /** Evaluated Notify me conditions keyed by the exact physical result, retained only on the mutable root. */
  resultProvenance: z.optional(WorkflowResultProvenanceV1Schema),
  container: z.optional(WorkflowContainerProgressV1Schema),
  /** Producer-observed occurrence timing; review holds remain open and later content writes do not move a terminal finish. */
  timing: z.optional(z.strictObject({ startedAt: z.string().check(z.iso.datetime()), finishedAt: z.optional(z.string().check(z.iso.datetime())) })),
  /** Resolved loop members, counted by the same producer as the root's currentLoop view. */
  loopProgress: z.optional(z.strictObject({ completed: z.number().check(z.int(), z.nonnegative(), z.int()), total: z.number().check(z.int(), z.nonnegative(), z.int()) }).check(z.refine(value => value.completed <= value.total))),
  attempt: WorkflowDecimalV1Schema,
  input: zMini.optional(StrictJsonValueSchema),
  /** Host-resolved committed parent; never accepted from authored recovery input. */
  discussionReplyTo: z.optional(WorkflowDiscussionOriginV1Schema),
  validationIssues: z.optional(WorkflowResultValidationIssuesV1Schema),
  result: zMini.optional(StrictJsonValueSchema),
  /** Original admitted Session input outcome; selected/reviewed result text stays independent. */
  replyOutcome: z.optional(SessionMessageReplyOutcomeV1Schema),
  review: z.optional(WorkflowReviewV1Schema),
  usage: z.optional(WorkflowUsageV1Schema),
  /**
   * Private request-state projection for this exact invocation. The incumbent
   * permission owner writes this independently from the selected step result;
   * it is not a Workflow decision or a generic execution-result ledger.
   */
  interaction: zMini.optional(StrictJsonValueSchema),
  containerResult: z.optional(WorkflowContainerResultSelectorV1Schema),
  resultContract: zMini.optional(StrictJsonValueSchema),
  execution: z.optional(WorkflowExecutionCorrespondenceV1Schema),
  /** Content-free observation from the admitted Session input. */
  sessionPermissionPending: z.optional(z.boolean()),
  /** Exact admitted leaf rows; conversation targets and workspace stay leaf-owned. */
  sharedConversationInvocationRecordId: z.optional(z.strictObject({
    session: zMini.optional(WorkflowInvocationRecordIdSchema),
    detached_run: zMini.optional(WorkflowInvocationRecordIdSchema),
  })),
  observationDeadline: z.optional(z.strictObject({ kind: z.literal('at'), expiresAt: z.string().check(z.iso.datetime()) })),
  workspace: zMini.optional(WorkflowWorkspaceProgressV1Schema),
  reason: z.optional(z.strictObject({ code: z.string().check(z.minLength(1)), message: z.optional(z.string()),
    failureCause: z.optional(ActionFailureCauseV1Schema),
    details: z.optional(WorkflowConversationUnavailableDetailsV1Schema),
    /** Exact failed input's source-owned issue; no issue or reset is inferred. */
    runtimeIssueV1: z.optional(SessionRuntimeIssueV1Schema) })),
  previousAttemptRecordId: zMini.optional(WorkflowInvocationRecordIdSchema),
  recovery: z.optional(WorkflowInvocationRecoveryV1Schema),
  uncertainPriorEffects: z.optional(z.strictObject({ activity: z.literal('stopped') })),
  logicalInvocationRecordId: WorkflowInvocationRecordIdSchema,
}).check(z.superRefine((value, context) => {
  const isRoot = value.blockKind === 'root';
  if (value.loopProgress !== undefined && (value.blockKind !== 'loop' || value.frame?.ownerBlockId === value.invocationPath.blockId)) {
    context.addIssue({ code: "custom", path: ['loopProgress'], message: 'Loop progress belongs only to the loop container' });
  }
  if (value.resultProvenance !== undefined && !isRoot) {
    context.addIssue({ code: "custom", path: ['resultProvenance'],
      message: 'Result condition provenance belongs only to the root frame' });
  }
  if (value.stepProgress !== undefined && !isRoot) {
    context.addIssue({ code: "custom", path: ['stepProgress'],
      message: 'Authored Run progress belongs only to the root frame' });
  }
  if (isRoot !== (value.invocationPath.blockId === '$root')) {
    context.addIssue({
      code: "custom",
      path: ['invocationPath', 'blockId'],
      message: 'The reserved $root path belongs only to the structural root frame',
    });
  }
  if (value.result !== undefined && value.containerResult !== undefined) {
    context.addIssue({
      code: "custom",
      path: ['containerResult'],
      message: 'Workflow progress cannot store both a leaf result and a container selector',
    });
  }
  const isInitialAttempt = value.attempt === '0';
  if (isInitialAttempt && value.previousAttemptRecordId !== undefined) {
    context.addIssue({
      code: "custom",
      path: ['previousAttemptRecordId'],
      message: 'An initial Workflow attempt cannot name a previous attempt',
    });
  }
  if (!isInitialAttempt && value.previousAttemptRecordId === undefined) {
    context.addIssue({
      code: "custom",
      path: ['previousAttemptRecordId'],
      message: 'A retried Workflow attempt must name its previous physical attempt',
    });
  }
})));
export type WorkflowProgressEnvelopeV1 = z.infer<typeof WorkflowProgressEnvelopeV1Schema>;

export function classifyWorkflowHoldV1(row: Readonly<{
  isCurrent: boolean;
  lifecycle: WorkflowInvocationLifecycleV1;
  progress: Pick<WorkflowProgressEnvelopeV1, 'review'>;
}>): 'awaiting_person' | 'generate' | 'resolved' {
  if (!row.isCurrent || row.lifecycle !== 'waiting_for_review') return 'resolved';
  return row.progress.review?.decision?.kind === 'generate' ? 'generate' : 'awaiting_person';
}

/** Live execution and recovery use the same settled-input review boundary. */
export function classifyWorkflowReviewEntryV1(params: Readonly<{
  mayEnterReview: boolean;
  pauseForReview: boolean;
  isGeneration: boolean;
  inputCompleted: boolean;
  observation: Readonly<{
    kind: 'completed' | 'failed' | 'cancelled' | 'needs_attention' | 'outcome_uncertain' | 'unresolved';
    code?: string;
  }>;
  continuationRefusedBeforeAdmission?: boolean;
}>): 'waiting_for_review' | 'not_required' {
  if (!params.mayEnterReview) return 'not_required';
  if (!params.isGeneration) return params.inputCompleted && params.pauseForReview ? 'waiting_for_review' : 'not_required';
  if (params.observation.kind === 'failed'
    || params.observation.kind === 'cancelled'
    || (params.observation.kind === 'needs_attention' && params.continuationRefusedBeforeAdmission)) {
    return 'waiting_for_review';
  }
  return 'not_required';
}

/** Observation-owned fields only. Review transitions exclusively replace existing result/reason. */
export const WorkflowInvocationFactV1Schema = lazyZodSchema(() => z.strictObject({
  discussionReplyTo: z.optional(WorkflowDiscussionOriginV1Schema),
  resultProvenance: z.optional(WorkflowResultProvenanceV1Schema),
  validationIssues: z.optional(WorkflowResultValidationIssuesV1Schema),
  result: zMini.optional(StrictJsonValueSchema),
  replyOutcome: z.optional(SessionMessageReplyOutcomeV1Schema),
  resultContract: zMini.optional(StrictJsonValueSchema),
  usage: z.optional(WorkflowUsageV1Schema),
  interaction: zMini.optional(StrictJsonValueSchema),
  reason: z.optional(z.string().check(z.minLength(1))),
  reasonMessage: z.optional(z.string()),
  failureCause: z.optional(ActionFailureCauseV1Schema),
  reasonDetails: z.optional(WorkflowConversationUnavailableDetailsV1Schema),
  runtimeIssueV1: z.optional(SessionRuntimeIssueV1Schema),
  sessionPermissionPending: z.optional(z.boolean()),
  execution: z.optional(WorkflowExecutionCorrespondenceV1Schema),
  sharedConversationInvocationRecordId: z.optional(z.strictObject({
    session: zMini.optional(WorkflowInvocationRecordIdSchema), detached_run: zMini.optional(WorkflowInvocationRecordIdSchema),
  })),
  observationDeadline: z.optional(z.strictObject({ kind: z.literal('at'), expiresAt: z.string().check(z.iso.datetime()) })),
  input: zMini.optional(StrictJsonValueSchema),
  workspace: zMini.optional(WorkflowWorkspaceProgressV1Schema),
  container: z.optional(WorkflowContainerProgressV1Schema),
  containerResult: z.optional(WorkflowContainerResultSelectorV1Schema),
}));
export type WorkflowInvocationFactV1 = z.infer<typeof WorkflowInvocationFactV1Schema>;

export function applyWorkflowInvocationFactV1(
  currentProgress: WorkflowProgressEnvelopeV1,
  fact: WorkflowInvocationFactV1,
  observation?: Readonly<{
    previousLifecycle: WorkflowInvocationLifecycleV1;
    lifecycle: WorkflowInvocationLifecycleV1;
    observedAtMs: number;
  }>,
): WorkflowProgressEnvelopeV1 {
  const owned = WorkflowInvocationFactV1Schema.parse(fact);
  const { result, reason, reasonMessage, reasonDetails, failureCause, runtimeIssueV1, sharedConversationInvocationRecordId, workspace, resultProvenance, ...fields } = owned;
  // An approval hold is provisional; its lifecycle owner supplies the native
  // failure when the approved execution settles. Other retained reasons stay immutable.
  const retiresApprovalHold = observation?.previousLifecycle === 'waiting_for_approval'
    && observation.lifecycle === 'failed' && currentProgress.reason?.code === 'approval_required';
  const failureReason = (retiresApprovalHold ? undefined : currentProgress.reason) ?? (reason === undefined ? undefined : {
    code: reason, ...(reasonMessage !== undefined ? { message: reasonMessage } : {}),
    ...(reasonDetails !== undefined ? { details: reasonDetails } : {}),
    ...(failureCause !== undefined ? { failureCause } : {}),
  });
  const definedFields = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
  // The daemon and human-review writer use one timing policy. Holds are not terminal, and an
  // already-running/terminal historical row cannot acquire a fabricated boundary during bookkeeping.
  const observedAt = observation === undefined ? undefined : new Date(observation.observedAtMs).toISOString();
  const timing = currentProgress.timing ?? (observedAt !== undefined && observation
    && (observation.previousLifecycle === 'pending' || observation.previousLifecycle === 'waiting_for_capacity')
    && (observation.lifecycle === 'admitting' || observation.lifecycle === 'running' || observation.lifecycle === 'waiting_for_review')
    ? { startedAt: observedAt } : undefined);
  const terminal = observation && (observation.lifecycle === 'completed' || observation.lifecycle === 'failed' || observation.lifecycle === 'cancelled');
  const wasTerminal = observation && (observation.previousLifecycle === 'completed' || observation.previousLifecycle === 'failed' || observation.previousLifecycle === 'cancelled');
  return WorkflowProgressEnvelopeV1Schema.parse({
    ...currentProgress, ...definedFields,
    ...(observation && observation.lifecycle !== 'waiting_for_approval' && currentProgress.sessionPermissionPending
      ? { sessionPermissionPending: false } : {}),
    ...(timing ? { timing: { ...timing, ...(observedAt !== undefined && terminal && !wasTerminal && timing.finishedAt === undefined
      ? { finishedAt: observedAt } : {}) } } : {}),
    ...(resultProvenance !== undefined ? { resultProvenance: mergeWorkflowResultProvenanceV1(currentProgress.resultProvenance, resultProvenance) } : {}),
    ...(currentProgress.result === undefined && result !== undefined ? { result } : {}),
    ...(failureReason ? { reason: { ...failureReason,
      ...(failureReason.failureCause === undefined && failureCause !== undefined ? { failureCause } : {}),
      ...(currentProgress.reason?.runtimeIssueV1 === undefined && runtimeIssueV1 !== undefined ? { runtimeIssueV1 } : {}) } } : {}),
    ...(sharedConversationInvocationRecordId !== undefined ? { sharedConversationInvocationRecordId: {
      ...currentProgress.sharedConversationInvocationRecordId, ...sharedConversationInvocationRecordId,
    } } : {}),
    ...(workspace !== undefined ? { workspace: { ...currentProgress.workspace, ...workspace } } : {}),
  });
}

export const WorkflowCheckpointEnvelopeV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('happier.workflow-checkpoint.v1'),
  /** Final panel's agreed reviewed tree, present only on succeeded review Runs. */
  endFingerprint: z.optional(z.string().check(z.minLength(1))),
  rootRecordId: WorkflowInvocationRecordIdSchema,
  nextSequence: WorkflowDecimalV1Schema,
  frontier: z.strictObject({
    nextBlockOrdinal: z.number().check(z.int(), z.nonnegative(), z.int()),
    paused: z.boolean(),
    interruption: z.optional(z.string().check(z.minLength(1))),
  }),
}));
export type WorkflowCheckpointEnvelopeV1 = z.infer<typeof WorkflowCheckpointEnvelopeV1Schema>;

export const WorkflowInvocationDetailV1Schema = lazyZodSchema(() => z.strictObject({
  index: WorkflowRunInvocationIndexV1Schema,
  progress: WorkflowProgressEnvelopeV1Schema,
  parentRevision: z.number().check(z.int(), z.nonnegative(), z.int()),
  /** Exact private-evidence decision projected only after this invocation is opened. */
  recoveryAvailability: z.optional(WorkflowInvocationRecoveryAvailabilityV1Schema),
}));
export type WorkflowInvocationDetailV1 = z.infer<typeof WorkflowInvocationDetailV1Schema>;

export const WorkflowInvocationRefV1Schema = lazyZodSchema(() => z.strictObject({ recordId: WorkflowInvocationRecordIdSchema }));
export const WorkflowRecoveryChoiceV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('reattach'), invocation: WorkflowInvocationRefV1Schema }),
  z.strictObject({
    kind: z.literal('continue'), invocation: WorkflowInvocationRefV1Schema,
    conversation: z.enum(['same_conversation', 'fresh_agent']),
    input: WorkflowAuthoredInputV1Schema,
    acknowledgeUncertainPriorEffects: z.optional(z.literal(true)),
  }),
  z.strictObject({
    kind: z.literal('restore_workspace'), invocation: WorkflowInvocationRefV1Schema,
    conversation: z.enum(['same_conversation', 'fresh_agent']),
    input: WorkflowRecoveryInputV1Schema,
    acknowledgeUncertainPriorEffects: z.optional(z.literal(true)),
  }),
]));

export const WorkflowResumeInputV1Schema = lazyZodSchema(() => z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('boundary'), runId: WorkflowRunIdV1Schema, expectedRevision: z.number().check(z.int(), z.nonnegative(), z.int()) }),
  z.strictObject({
    mode: z.literal('recover'), runId: WorkflowRunIdV1Schema,
    expectedRevision: z.number().check(z.int(), z.nonnegative(), z.int()),
    invocations: z.array(WorkflowRecoveryChoiceV1Schema).check(z.minLength(1)),
  }),
]));
export type WorkflowResumeInputV1 = z.infer<typeof WorkflowResumeInputV1Schema>;

export const WorkflowInvocationRetryInputV1Schema = lazyZodSchema(() => z.strictObject({
  runId: WorkflowRunIdV1Schema,
  expectedRevision: z.number().check(z.int(), z.nonnegative(), z.int()),
  invocation: WorkflowInvocationRefV1Schema,
  causalInvocationIds: z.array(WorkflowInvocationRecordIdSchema).check(z.minLength(1)),
  conversation: z.enum(['same_conversation', 'fresh_agent']),
  input: WorkflowRecoveryInputV1Schema,
  acknowledgeUncertainPriorEffects: z.optional(z.literal(true)),
}));
export type WorkflowInvocationRetryInputV1 = z.infer<typeof WorkflowInvocationRetryInputV1Schema>;

export const AUTOMATION_EVENT_WATCHER_NOT_CURRENT = 'event_watcher_not_current';
export const AUTOMATION_EVENT_WATCHER_NOT_OWNED = 'event_watcher_not_owned';
export const WORKFLOW_STEP_PREPARATION_FAILED = 'workflow_step_preparation_failed';

const WORKFLOW_OPERATION_ERROR_CODES_WITHOUT_DETAILS_V1 = [
  AUTOMATION_EVENT_WATCHER_NOT_CURRENT,
  AUTOMATION_EVENT_WATCHER_NOT_OWNED,
  WORKFLOW_STEP_PREPARATION_FAILED,
  'not_authenticated',
  'admission_unavailable', 'invalid_token',
  'run_not_found', 'visible_team_not_granted',
  'approval_required', 'present_user_required',
  'missing_reference', 'invalid_reference_scope',
  'workflow_input_too_large', 'workflow_outcome_unresolved',
  'workflow_interaction_capacity_exceeded',
  'continuation_unavailable',
  'workflow_workspace_restore_unavailable', 'workflow_workspace_restore_failed',
  'ineligible_state', 'custody_pending', 'requester_custody_unavailable',
  'source_unavailable',
  'github_webhook_home_unreachable',
  'history_not_readable', 'encryption_setup_required', 'waiting_for_keys', 'storage_unavailable',
  'native_goal_owner', 'role_policy_unenforceable', 'session_already_started', 'pull_request_link_required',
] as const;

export const WORKFLOW_OPERATION_ERROR_CODES_V1 = [
  ...WORKFLOW_OPERATION_ERROR_CODES_WITHOUT_DETAILS_V1,
  ...AGENT_START_REFUSAL_CODES_V1,
  'invalid_input', 'currentness_conflict', 'workflow_http_error',
  'workflow_conversation_unavailable', 'workflow_wait_self_dependency',
  'content_unavailable', 'legacy_conversion_unsupported',
] as const;
export const WorkflowOperationErrorCodeV1Schema = lazyZodSchema(() => z.enum(WORKFLOW_OPERATION_ERROR_CODES_V1));
export type WorkflowOperationErrorCodeV1 = z.infer<typeof WorkflowOperationErrorCodeV1Schema>;

// The same closed meaning selects localized app copy and the Action's plain-text explanation.
const workflowProblemCopy = {
  approvalWantedBody: { key: 'workflows.run.approvalWantedBody', text: "This Action needs approval before it can continue." },
  authenticationFailed: { key: 'errors.authenticationFailed', text: "Authentication failed. Sign in to the Home again." },
  admission_unavailable: { key: 'session.startFailure.cause.admission_unavailable', text: "The requested work cannot be admitted right now." },
  subtreeDenied: { key: 'workflows.problem.subtreeDenied', text: "An agent can only start work in its own session or in sessions it leads." },
  roleTargetUnavailable: { key: 'workflows.problem.roleTargetUnavailable', text: "This role cannot be used here." },
  rolePolicyUnenforceable: { key: 'errors.rolePolicyUnenforceable', text: "The selected runtime cannot enforce this role’s policy." },
  roleRunsAsMismatch: { key: 'workflows.problem.roleRunsAsMismatch', text: "This role runs in a way this step cannot use. Choose another role or change how the step runs." },
  policyDeniedField: { key: 'workflows.problem.policyDeniedField', text: "Your agent settings do not allow the requested setting for work an agent starts." },
  permissionExceedsCeiling: { key: 'workflows.problem.permissionExceedsCeiling', text: "This needs more permission than the agent that started it has." },
  workDepthExceeded: { key: 'workflows.problem.workDepthExceeded', text: "This would go deeper than your delegation limit. Do it in this session, or raise the limit in Settings › Delegation." },
  definitionExceedsAuthority: { key: 'workflows.problem.definitionExceedsAuthority', text: "The agent cannot save a workflow that could do more than the agent itself can start." },
  needsRepair: { key: 'workflows.problem.needsRepair', text: "This workflow has settings that need repairing before it can run." },
  targetUnavailable: { key: 'workflows.problem.targetUnavailable', text: "The machine or agent this workflow needs is not available right now." },
  githubWebhookHomeUnreachable: { key: 'workflows.problem.githubWebhookHomeUnreachable', text: "GitHub can’t reach this Home. Make the Home reachable, deploy manually, or ask an agent to deploy." },
  notFound: { key: 'workflows.problem.notFound', text: "This run no longer exists." },
  accessDenied: { key: 'workflows.problem.accessDenied', text: "You don’t have access to this." },
  conflict: { key: 'workflows.problem.conflict', text: "This changed somewhere else. Refresh to see the current version; your local work is kept." },
  inputTooLarge: { key: 'workflows.problem.inputTooLarge', text: "That input is too large to send. Nothing was changed." },
  unresolvedOutcome: { key: 'workflows.problem.unresolvedOutcome', text: "Happier cannot confirm yet that the previous work stopped, so it cannot be replaced." },
  generic: { key: 'workflows.problem.generic', text: "Happier could not finish that workflow request. Your work is unaffected." },
  interactionCapacity: { key: 'workflows.problem.interactionCapacity', text: "This conversation has too much waiting on it to accept more right now." },
  conversationUnavailable: { key: 'workflows.problem.conversationUnavailable', text: "That conversation cannot be continued." },
  workspaceRestore: { key: 'workflows.problem.workspaceRestore', text: "The workspace could not be restored. Nothing was changed." },
  stepPreparation: { key: 'workflows.problem.stepPreparation', text: "Happier couldn’t prepare this step. No input was sent to the agent." },
  waitSelfDependency: { key: 'workflows.problem.waitSelfDependency', text: "This would leave the workflow waiting on the conversation that started it." },
  ineligible: { key: 'workflows.problem.ineligible', text: "This run has moved on, so that is no longer possible." },
  custodyPending: { key: 'workflows.problem.custodyPending', text: "Happier is still waiting for the machine to confirm." },
  requesterCustodyUnavailable: { key: 'workflows.problem.requesterCustodyUnavailable', text: "Re-save the schedule, or start again, on this Machine." },
  contentUnavailable: { key: 'workflows.contentUnavailable', text: "The saved Workflow content is unavailable." },
  historyBody: { key: 'workflows.readState.historyBody', text: "The Workflow history cannot be read on this device." },
  encryptionBody: { key: 'workflows.readState.encryptionBody', text: "Set up Account encryption before reading this Workflow." },
  keysBody: { key: 'workflows.readState.keysBody', text: "This device is waiting for the keys to open this Workflow." },
  storageBody: { key: 'workflows.readState.storageBody', text: "Happier could not reach Workflow storage." },
  sourceUnavailable: { key: 'workflows.problem.sourceUnavailable', text: "This workflow is unavailable, so its triggers cannot run." },
  changeUnavailable: { key: 'workflows.triggers.legacy.changeUnavailable', text: "This saved Workflow must be converted before it can be changed." },
  nativeGoalOwner: { key: 'workflows.problem.nativeGoalOwner', text: "The agent already keeps going toward goals on its own in this session." },
  sessionAlreadyStarted: { key: 'workflows.problem.sessionAlreadyStarted', text: "This session has already started. Session-start triggers can only be added when a session is created." },
  botPaused: { key: 'workflows.problem.botPaused', text: 'This Bot is paused. Resume it in its session before starting new work.' },
  presentUserRequired: { key: 'settingsActions.reasons.presentUserRequired', text: "Review and approve this Action in the Happier app." },
  eventDeclarationNotCurrent: {
    key: 'workflows.problem.eventDeclarationNotCurrent',
    text: 'The plugin declaration for this Event has changed. Update Happier and the plugin on the watcher Machine, then choose the Event again.',
  },
} as const;

export const WORKFLOW_OPERATION_PROBLEM_COPY_V1 = {
  approval_required: workflowProblemCopy.approvalWantedBody,
  not_authenticated: workflowProblemCopy.authenticationFailed,
  admission_unavailable: workflowProblemCopy.admission_unavailable,
  invalid_token: workflowProblemCopy.authenticationFailed,
  subtree_denied: workflowProblemCopy.subtreeDenied,
  role_target_unavailable: workflowProblemCopy.roleTargetUnavailable,
  role_policy_unenforceable: workflowProblemCopy.rolePolicyUnenforceable,
  role_runs_as_mismatch: workflowProblemCopy.roleRunsAsMismatch,
  policy_denied_field: workflowProblemCopy.policyDeniedField,
  permission_exceeds_ceiling: workflowProblemCopy.permissionExceedsCeiling,
  work_depth_exceeded: workflowProblemCopy.workDepthExceeded,
  definition_exceeds_authority: workflowProblemCopy.definitionExceedsAuthority,
  invalid_input: workflowProblemCopy.needsRepair,
  missing_reference: workflowProblemCopy.needsRepair,
  invalid_reference_scope: workflowProblemCopy.needsRepair,
  target_unavailable: workflowProblemCopy.targetUnavailable,
  github_webhook_home_unreachable: workflowProblemCopy.githubWebhookHomeUnreachable,
  run_not_found: workflowProblemCopy.notFound,
  run_access_denied: workflowProblemCopy.accessDenied,
  visible_team_not_granted: workflowProblemCopy.accessDenied,
  currentness_conflict: workflowProblemCopy.conflict,
  event_watcher_not_current: workflowProblemCopy.targetUnavailable,
  event_watcher_not_owned: workflowProblemCopy.accessDenied,
  workflow_input_too_large: workflowProblemCopy.inputTooLarge,
  workflow_outcome_unresolved: workflowProblemCopy.unresolvedOutcome,
  workflow_http_error: workflowProblemCopy.generic,
  workflow_interaction_capacity_exceeded: workflowProblemCopy.interactionCapacity,
  workflow_conversation_unavailable: workflowProblemCopy.conversationUnavailable,
  continuation_unavailable: workflowProblemCopy.conversationUnavailable,
  workflow_workspace_restore_unavailable: workflowProblemCopy.workspaceRestore,
  workflow_workspace_restore_failed: workflowProblemCopy.workspaceRestore,
  workflow_step_preparation_failed: workflowProblemCopy.stepPreparation,
  workflow_wait_self_dependency: workflowProblemCopy.waitSelfDependency,
  ineligible_state: workflowProblemCopy.ineligible,
  custody_pending: workflowProblemCopy.custodyPending,
  requester_custody_unavailable: workflowProblemCopy.requesterCustodyUnavailable,
  content_unavailable: workflowProblemCopy.contentUnavailable,
  history_not_readable: workflowProblemCopy.historyBody,
  encryption_setup_required: workflowProblemCopy.encryptionBody,
  waiting_for_keys: workflowProblemCopy.keysBody,
  storage_unavailable: workflowProblemCopy.storageBody,
  source_unavailable: workflowProblemCopy.sourceUnavailable,
  legacy_conversion_unsupported: workflowProblemCopy.changeUnavailable,
  native_goal_owner: workflowProblemCopy.nativeGoalOwner,
  session_already_started: workflowProblemCopy.sessionAlreadyStarted,
  bot_paused: workflowProblemCopy.botPaused,
  pull_request_link_required: workflowProblemCopy.needsRepair,
  present_user_required: workflowProblemCopy.presentUserRequired,
} as const satisfies Record<WorkflowOperationErrorCodeV1, { key: string; text: string }>;

export function readWorkflowOperationProblemCopyV1(code: WorkflowOperationErrorCodeV1, details?: unknown) {
  if (code === 'currentness_conflict' && details && typeof details === 'object' && 'reason' in details
    && details.reason === 'event_contribution_not_current') {
    return workflowProblemCopy.eventDeclarationNotCurrent;
  }
  return WORKFLOW_OPERATION_PROBLEM_COPY_V1[code];
}


/** Content-free HTTP cause only. Free-text response errors and messages are never diagnostics. */
export const WorkflowHttpErrorDetailsV1Schema = lazyZodSchema(() => z.strictObject({
  status: z.number().check(z.int(), z.minimum(100), z.maximum(599)),
  code: z.optional(z.union([WorkflowOperationErrorCodeV1Schema, z.enum([
    'FST_ERR_VALIDATION', 'credential_scope_denied',
    'automation_create_conflict', 'automation_disabled', 'automation_not_found',
    'automation_stored_content_unavailable', 'automation_template_version_conflict',
    'automation_trigger_create_conflict', 'automation_trigger_revision_conflict', 'version_mismatch',
    'event_contribution_not_current',
  ])])),
}));

export const WorkflowTargetUnavailableDetailsV1Schema = lazyZodSchema(() => z.strictObject({
  code: z.literal('target_unavailable'), reason: WorkflowTargetUnavailableReasonV1Schema,
  blockId: zMini.optional(WorkflowBlockIdSchema), agentId: z.optional(z.string().check(z.minLength(1))),
  errorCode: z.optional(z.string().check(z.minLength(1))),
  platformReason: z.optional(z.enum(['os', 'arch'])),
}));
export type WorkflowTargetUnavailableDetailsV1 = z.infer<typeof WorkflowTargetUnavailableDetailsV1Schema>;

/** Closed semantic failure returned by the Workflow Action family dependency. */
export const WorkflowActionFailureV1Schema = lazyZodSchema(() => {
  // Public Action metadata survives every Workflow consumer; semantic details
  // remain closed by the owning variant below.
  const envelope = z.omit(ActionExecuteFailureSchema, { errorCode: true, details: true });
  return z.discriminatedUnion('errorCode', [
  z.extend(envelope, {
    errorCode: z.literal('cancelled'),
  }),
  z.extend(envelope, {
    errorCode: z.literal('workflow_http_error'),
    details: WorkflowHttpErrorDetailsV1Schema,
  }),
  z.extend(envelope, {
    errorCode: z.literal('workflow_conversation_unavailable'),
    details: z.optional(WorkflowConversationUnavailableDetailsV1Schema),
  }),
  z.extend(envelope, {
    errorCode: z.literal('content_unavailable'),
    details: z.optional(z.strictObject({ reason: z.union([WorkflowDefinitionContentUnavailableReasonV1Schema,
      z.literal('account_role_overrides_unavailable')]) })),
  }),
  z.extend(envelope, {
    errorCode: z.enum(AGENT_START_REFUSAL_CODES_V1.filter((code) => code !== 'target_unavailable')),
    details: zMini.optional(AgentStartRefusalV1Schema),
  }),
  z.extend(envelope, {
    errorCode: z.literal('target_unavailable'),
    // Admission policy refusals retain their canonical ORC contract. Concrete
    // machine availability refusals use the Workflow owner's diagnostic facts.
    details: z.optional(z.union([WorkflowTargetUnavailableDetailsV1Schema, AgentStartRefusalV1Schema])),
  }),
  z.extend(envelope, {
    errorCode: z.literal('invalid_input'),
    details: z.optional(z.strictObject({
      code: z.optional(z.union([WorkflowDocumentParseFailureV1Schema.shape.code, z.enum(['invalid_input', 'invalid_trigger_target',
        'session_trigger_scope_required', 'session_trigger_kind_unsupported', 'session_trigger_source_mismatch', 'session_trigger_project_mismatch', 'session_trigger_current_turn_requires_session',
        'trigger_definition_envelope_not_allowed', 'legacy_conversion_review_invalid',
        'workflow_trigger_target_mismatch', 'inline_trigger_team_not_allowed'])])), blockId: zMini.optional(WorkflowBlockIdSchema),
      issues: z.optional(z.array(z.union([WorkflowValidationIssueV1Schema, z.strictObject({
        code: z.enum(['unknown_block_id', 'invalid_target']), path: z.tuple([z.literal('ops'), z.number().check(z.int(), z.nonnegative())]),
      })]))),
    })),
  }),
  z.extend(envelope, {
    errorCode: z.literal('legacy_conversion_unsupported'),
    details: z.strictObject({ reason: LegacyAutomationWorkflowConversionReasonV1Schema }),
  }),
  z.extend(envelope, {
    errorCode: z.literal('currentness_conflict'),
    details: z.optional(z.union([
      z.strictObject({ revision: z.number().check(z.int(), z.nonnegative(), z.int()) }),
      z.strictObject({ reason: z.literal('event_contribution_not_current') }),
    ])),
  }),
  z.extend(envelope, {
    errorCode: z.literal('workflow_wait_self_dependency'),
    details: z.strictObject({ runId: WorkflowRunIdV1Schema }),
  }),
  z.extend(envelope, {
    errorCode: z.enum(WORKFLOW_OPERATION_ERROR_CODES_WITHOUT_DETAILS_V1),
  }),
  ]);
});
export type WorkflowActionFailureV1 = z.infer<typeof WorkflowActionFailureV1Schema>;

export const WorkflowErrorV1Schema = lazyZodSchema(() => z.strictObject({
  code: WorkflowOperationErrorCodeV1Schema,
  message: z.optional(z.string()),
}));
export type WorkflowErrorV1 = z.infer<typeof WorkflowErrorV1Schema>;

export const WorkflowResultRefV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('text'), value: z.string() }),
  z.strictObject({ kind: z.literal('decision'), value: z.string() }),
  z.strictObject({ kind: z.literal('json'), value: StrictJsonValueSchema }),
]));
export type WorkflowResultRefV1 = z.infer<typeof WorkflowResultRefV1Schema>;
export const WorkflowStepObservationV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('pending'), input: WorkflowInputRefV1Schema }),
  z.strictObject({ kind: z.literal('completed'), input: WorkflowInputRefV1Schema, result: z.optional(WorkflowResultRefV1Schema) }),
  z.strictObject({ kind: z.literal('failed'), input: z.optional(WorkflowInputRefV1Schema), error: WorkflowErrorV1Schema }),
  z.strictObject({ kind: z.literal('cancelled'), input: WorkflowInputRefV1Schema }),
  z.strictObject({ kind: z.literal('outcome_uncertain'), input: z.optional(WorkflowInputRefV1Schema), error: WorkflowErrorV1Schema }),
]));
export type WorkflowStepObservationV1 = z.infer<typeof WorkflowStepObservationV1Schema>;

export const WorkflowFinalOutputSelectionV1Schema = lazyZodSchema(() => WorkflowAuthoredResultReferenceSchema);

export const WorkflowFinalResultV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('happier.workflow-final-result.v1'),
  result: WorkflowResultRefV1Schema,
  /** Exact persisted producer selected by the authored final-output binding. */
  producerInvocation: WorkflowInvocationRefV1Schema,
}));
export type WorkflowFinalResultV1 = z.infer<typeof WorkflowFinalResultV1Schema>;

/** The sole direct-delivery projection for an exact persisted Workflow result. */
export function projectWorkflowFinalResultDeliverableTextV1(
  finalResult: WorkflowFinalResultV1,
): string | null {
  switch (finalResult.result.kind) {
    case 'text':
    case 'decision':
      return finalResult.result.value;
    case 'json':
      return typeof finalResult.result.value === 'string'
        ? finalResult.result.value
        : null;
  }
}
