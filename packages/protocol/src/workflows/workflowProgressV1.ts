import * as zMini from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { WorkflowTargetUnavailableReasonV1Schema } from './workflowTargetUnavailableReasonV1.js';
export { WorkflowTargetUnavailableReasonV1Schema, type WorkflowTargetUnavailableReasonV1 } from './workflowTargetUnavailableReasonV1.js';
import { WorkflowDiscussionOriginV1Schema } from './workflowDestinationsV1.js';
import { SessionMessageReplyOutcomeV1Schema } from '../sessions/messages/sessionMessageReplyV1.js';
import { z } from 'zod/mini';
import { ActionCompletionStateV1Schema } from '../actions/actionCompletion.js';
import { AGENT_START_REFUSAL_CODES_V1, AgentStartRefusalV1Schema } from '../account/settings/admitAgentStartV1.js';
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
  WorkflowValidationIssueV1Schema,
  type WorkflowSessionAuthoringSelection,
  type WorkflowStepExecutionSelection,
} from './workflowV1.js';
import { WorkflowProjectTargetV1Schema, WorkflowWorkspaceProgressV1Schema } from './workflowWorkspaceV1.js';
import { WorkflowResolvedInputsV1Schema, WorkflowRunStartedByV1Schema, WorkflowDefinitionContentUnavailableReasonV1Schema, WorkflowDefinitionSavedByV1Schema } from './workflowDefinitionV1.js';
import { WorkflowDestinationsV1Schema } from './workflowDestinationsV1.js';
import { SessionRuntimeIssueV1Schema } from '../sessions/control/runtimeIssueV1.js';

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
}).check(z.refine((value) => value.completed <= value.total)));
export type WorkflowRunStepProgressV1 = z.infer<typeof WorkflowRunStepProgressV1Schema>;

/** Existing root row observation; counts can decrease when the current attempt changes. */
export const WorkflowRunStepProgressCurrentnessV1Schema = lazyZodSchema(() => z.strictObject({
  recordId: WorkflowInvocationRecordIdSchema,
  attempt: WorkflowDecimalV1Schema,
  contentRevision: WorkflowDecimalV1Schema,
}));
export type WorkflowRunStepProgressCurrentnessV1 = z.infer<typeof WorkflowRunStepProgressCurrentnessV1Schema>;

export const WorkflowRunSummaryV1Schema = lazyZodSchema(() => z.strictObject({
  startedBy: zMini.optional(zMini.nullable(WorkflowRunStartedByV1Schema)),
  sourceSavedBy: z.optional(WorkflowDefinitionSavedByV1Schema),
  stepProgress: z.optional(z.nullable(WorkflowRunStepProgressV1Schema)),
  stepProgressCurrentness: z.optional(z.nullable(WorkflowRunStepProgressCurrentnessV1Schema)),
  /** Authorized attention-list projection; null clears a hold, omission preserves a prior observation. */
  heldStep: z.optional(z.nullable(z.strictObject({
    invocationId: WorkflowInvocationRecordIdSchema,
    label: z.string().check(z.minLength(1)),
    laneLabel: z.optional(z.string().check(z.minLength(1))),
  }))),
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
export const WorkflowRetainedRuntimeSelectionV1Schema = lazyZodSchema(() => WorkflowSessionAuthoringSelectionSchema);
export type WorkflowRetainedRuntimeSelectionV1 = WorkflowSessionAuthoringSelection;

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
  const title = Object.prototype.hasOwnProperty.call(fields, 'title') ? scalar(fields.title) : undefined;
  if (title !== undefined) return title;
  for (const field of Object.values(fields)) {
    const label = scalar(field);
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

export const WorkflowInvocationRecoveryV1Schema = lazyZodSchema(() => z.strictObject({
  conversation: z.enum(['same_conversation', 'fresh_agent']),
  input: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('original') }),
    z.strictObject({
      kind: z.literal('replacement'),
      value: z.strictObject({
        document: WorkflowStepComposerDocumentSchema,
        input: z._default(z.array(StrictJsonValueSchema), []),
      }),
    }),
  ]),
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

const WorkflowResultValidationIssuesV1Schema = lazyZodSchema(() => z.array(z.strictObject({ pointer: z.string(), message: z.string() })));

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
  /** Exact admitted leaf rows; conversation targets and workspace stay leaf-owned. */
  sharedConversationInvocationRecordId: z.optional(z.strictObject({
    session: zMini.optional(WorkflowInvocationRecordIdSchema),
    detached_run: zMini.optional(WorkflowInvocationRecordIdSchema),
  })),
  observationDeadline: z.optional(z.strictObject({ kind: z.literal('at'), expiresAt: z.string().check(z.iso.datetime()) })),
  workspace: zMini.optional(WorkflowWorkspaceProgressV1Schema),
  reason: z.optional(z.strictObject({ code: z.string().check(z.minLength(1)), message: z.optional(z.string()),
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
  reasonDetails: z.optional(WorkflowConversationUnavailableDetailsV1Schema),
  runtimeIssueV1: z.optional(SessionRuntimeIssueV1Schema),
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
  const { result, reason, reasonMessage, reasonDetails, runtimeIssueV1, sharedConversationInvocationRecordId, workspace, resultProvenance, ...fields } = owned;
  const failureReason = currentProgress.reason ?? (reason === undefined ? undefined : {
    code: reason, ...(reasonMessage !== undefined ? { message: reasonMessage } : {}),
    ...(reasonDetails !== undefined ? { details: reasonDetails } : {}),
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
    ...(timing ? { timing: { ...timing, ...(observedAt !== undefined && terminal && !wasTerminal && timing.finishedAt === undefined
      ? { finishedAt: observedAt } : {}) } } : {}),
    ...(resultProvenance !== undefined ? { resultProvenance: mergeWorkflowResultProvenanceV1(currentProgress.resultProvenance, resultProvenance) } : {}),
    ...(currentProgress.result === undefined && result !== undefined ? { result } : {}),
    ...(failureReason ? { reason: { ...failureReason,
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

export const WorkflowAuthoredInputV1Schema = lazyZodSchema(() => z.strictObject({
  document: WorkflowStepComposerDocumentSchema,
  input: z._default(z.array(StrictJsonValueSchema), []),
  /** Producer-rendered origin input, frozen atomically with its admitting correspondence. */
  renderedText: z.optional(z.string()),
}));
export type WorkflowAuthoredInputV1 = z.infer<typeof WorkflowAuthoredInputV1Schema>;

export const WorkflowInvocationRefV1Schema = lazyZodSchema(() => z.strictObject({ recordId: WorkflowInvocationRecordIdSchema }));
const WorkflowRecoveryInputV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('original') }),
  z.strictObject({ kind: z.literal('replacement'), value: WorkflowAuthoredInputV1Schema }),
]));
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

export const WORKFLOW_OPERATION_ERROR_CODES_V1 = [
  'invalid_input', 'run_not_found', 'not_authenticated', ...AGENT_START_REFUSAL_CODES_V1,
  'currentness_conflict', 'missing_reference', 'invalid_reference_scope',
  'workflow_input_too_large', 'workflow_outcome_unresolved',
  'workflow_http_error',
  'workflow_interaction_capacity_exceeded',
  'workflow_conversation_unavailable', 'continuation_unavailable',
  'workflow_workspace_restore_unavailable', 'workflow_workspace_restore_failed',
  'workflow_wait_self_dependency',
  'ineligible_state', 'custody_pending', 'content_unavailable', 'source_unavailable', 'legacy_conversion_unsupported',
  'history_not_readable', 'encryption_setup_required', 'waiting_for_keys', 'storage_unavailable',
  'native_goal_owner', 'session_already_started',
] as const;
export const WorkflowOperationErrorCodeV1Schema = lazyZodSchema(() => z.enum(WORKFLOW_OPERATION_ERROR_CODES_V1));
export type WorkflowOperationErrorCodeV1 = z.infer<typeof WorkflowOperationErrorCodeV1Schema>;

/** Content-free HTTP cause only. Free-text response errors and messages are never diagnostics. */
export const WorkflowHttpErrorDetailsV1Schema = lazyZodSchema(() => z.strictObject({
  status: z.number().check(z.int(), z.minimum(100), z.maximum(599)),
  code: z.optional(z.union([WorkflowOperationErrorCodeV1Schema, z.enum([
    'FST_ERR_VALIDATION', 'credential_scope_denied',
    'automation_create_conflict', 'automation_disabled', 'automation_not_found',
    'automation_stored_content_unavailable', 'automation_template_version_conflict',
    'automation_trigger_create_conflict', 'automation_trigger_revision_conflict', 'version_mismatch',
  ])])),
}));

const WORKFLOW_OPERATION_ERROR_CODES_WITHOUT_DETAILS_V1 = [
  'not_authenticated',
  'run_not_found',
  'missing_reference', 'invalid_reference_scope',
  'workflow_input_too_large', 'workflow_outcome_unresolved',
  'workflow_interaction_capacity_exceeded',
  'continuation_unavailable',
  'workflow_workspace_restore_unavailable', 'workflow_workspace_restore_failed',
  'ineligible_state', 'custody_pending',
  'source_unavailable',
  'history_not_readable', 'encryption_setup_required', 'waiting_for_keys', 'storage_unavailable',
  'native_goal_owner', 'session_already_started',
] as const;

export const WorkflowTargetUnavailableDetailsV1Schema = lazyZodSchema(() => z.strictObject({
  code: z.literal('target_unavailable'), reason: WorkflowTargetUnavailableReasonV1Schema,
  blockId: zMini.optional(WorkflowBlockIdSchema), agentId: z.optional(z.string().check(z.minLength(1))),
  errorCode: z.optional(z.string().check(z.minLength(1))),
  platformReason: z.optional(z.enum(['os', 'arch'])),
}));
export type WorkflowTargetUnavailableDetailsV1 = z.infer<typeof WorkflowTargetUnavailableDetailsV1Schema>;

/** Closed semantic failure returned by the Workflow Action family dependency. */
export const WorkflowActionFailureV1Schema = lazyZodSchema(() => z.discriminatedUnion('errorCode', [
  z.strictObject({
    ok: z.literal(false), errorCode: z.literal('cancelled'), error: z.string().check(z.trim(), z.minLength(1)),
  }),
  z.strictObject({
    ok: z.literal(false), errorCode: z.literal('workflow_http_error'), error: z.string().check(z.trim(), z.minLength(1)),
    details: WorkflowHttpErrorDetailsV1Schema,
    effectAttempted: z.optional(z.boolean()),
  }),
  z.strictObject({
    ok: z.literal(false), errorCode: z.literal('workflow_conversation_unavailable'), error: z.string().check(z.trim(), z.minLength(1)),
    details: z.optional(WorkflowConversationUnavailableDetailsV1Schema),
  }),
  z.strictObject({
    ok: z.literal(false), errorCode: z.literal('content_unavailable'), error: z.string().check(z.trim(), z.minLength(1)),
    details: z.optional(z.strictObject({ reason: z.union([WorkflowDefinitionContentUnavailableReasonV1Schema,
      z.literal('account_role_overrides_unavailable')]) })),
  }),
  z.strictObject({
    ok: z.literal(false), errorCode: z.enum(AGENT_START_REFUSAL_CODES_V1.filter((code) => code !== 'target_unavailable')), error: z.string().check(z.trim(), z.minLength(1)),
    details: zMini.optional(AgentStartRefusalV1Schema),
  }),
  z.strictObject({
    ok: z.literal(false), errorCode: z.literal('target_unavailable'), error: z.string().check(z.trim(), z.minLength(1)),
    // Admission policy refusals retain their canonical ORC contract. Concrete
    // machine availability refusals use the Workflow owner's diagnostic facts.
    details: z.optional(z.union([WorkflowTargetUnavailableDetailsV1Schema, AgentStartRefusalV1Schema])),
  }),
  z.strictObject({
    ok: z.literal(false), errorCode: z.literal('invalid_input'), error: z.string().check(z.trim(), z.minLength(1)),
    details: z.optional(z.strictObject({
      code: z.optional(z.enum(['invalid_input', 'invalid_trigger_target',
        'session_trigger_scope_required', 'session_trigger_kind_unsupported', 'session_trigger_source_mismatch', 'session_trigger_project_mismatch',
        'trigger_definition_envelope_not_allowed', 'legacy_conversion_review_invalid',
        'workflow_trigger_target_mismatch', 'inline_trigger_team_not_allowed'])), blockId: zMini.optional(WorkflowBlockIdSchema),
      issues: z.optional(z.array(z.union([WorkflowValidationIssueV1Schema, z.strictObject({
        code: z.enum(['unknown_block_id', 'invalid_target']), path: z.tuple([z.literal('ops'), z.number().check(z.int(), z.nonnegative())]),
      })]))),
    })),
  }),
  z.strictObject({
    ok: z.literal(false),
    errorCode: z.literal('legacy_conversion_unsupported'),
    error: z.string().check(z.trim(), z.minLength(1)),
    details: z.strictObject({ reason: LegacyAutomationWorkflowConversionReasonV1Schema }),
  }),
  z.strictObject({
    ok: z.literal(false),
    errorCode: z.literal('currentness_conflict'),
    error: z.string().check(z.trim(), z.minLength(1)),
    details: z.optional(z.strictObject({ revision: z.number().check(z.int(), z.nonnegative(), z.int()) })),
  }),
  z.strictObject({
    ok: z.literal(false),
    errorCode: z.literal('workflow_wait_self_dependency'),
    error: z.string().check(z.trim(), z.minLength(1)),
    details: z.strictObject({ runId: WorkflowRunIdV1Schema }),
  }),
  z.strictObject({
    ok: z.literal(false),
    errorCode: z.enum(WORKFLOW_OPERATION_ERROR_CODES_WITHOUT_DETAILS_V1),
    error: z.string().check(z.trim(), z.minLength(1)),
  }),
]));
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

export const WorkflowFinalOutputSelectionV1Schema = WorkflowAuthoredResultReferenceSchema;

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
