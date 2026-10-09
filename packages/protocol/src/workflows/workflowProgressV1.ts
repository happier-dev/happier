import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';
import { ActionCompletionStateV1Schema } from '../actions/actionCompletion.js';
import { AGENT_START_REFUSAL_CODES_V1, AgentStartRefusalV1Schema } from '../account/settings/admitAgentStartV1.js';
import { LegacyAutomationWorkflowConversionReasonV1Schema } from '../automations/automationLegacyWorkflowConversionReasonV1.js';

import { createCanonicalJsonSigningInput } from '../crypto/canonicalJson.js';
import { StrictJsonValueSchema } from '../json/strictJsonValue.js';
import { AutomationRunStateV3Schema } from '../automations/automationRunStateV3.js';
import { AutomationRunCauseSchema } from '../automations/automationRunCause.js';
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
import { WorkflowResolvedInputsV1Schema, WorkflowRunStartedByV1Schema, WorkflowDefinitionContentUnavailableReasonV1Schema } from './workflowDefinitionV1.js';

export {
  WorkflowDefinitionIdV1Schema,
  WorkflowInvocationRecordIdSchema,
  WorkflowMachineIdV1Schema,
  WorkflowRunIdV1Schema,
} from './workflowIdsV1.js';
export const WorkflowDecimalV1Schema = lazyZodSchema(() => z.string().regex(/^(0|[1-9][0-9]*)$/, 'Expected a canonical nonnegative decimal string'));
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

/** Lifecycle eligibility only; the authorized host validates exact initial-input and frozen leaf evidence. */
export function isWorkflowDraftPublicationLifecycleV1(lifecycle: WorkflowInvocationLifecycleV1): boolean {
  return lifecycle === 'admitting' || lifecycle === 'running' || lifecycle === 'waiting_for_approval'
    || lifecycle === 'waiting_for_review';
}

/** Canonical actionable-row vocabulary shared by storage and presentation. */
export const WORKFLOW_ATTENTION_INVOCATION_LIFECYCLES_V1 = [
  'waiting_for_approval', 'needs_attention', 'waiting_for_review', 'cancel_requested', 'outcome_uncertain',
] as const satisfies readonly WorkflowInvocationLifecycleV1[];

export const WORKFLOW_RUN_STATES_V1 = [
  ...AutomationRunStateV3Schema.options,
  'pause_requested', 'paused', 'interrupted', 'waiting_for_review',
] as const;
export const WorkflowRunStateV1Schema = lazyZodSchema(() => z.enum(WORKFLOW_RUN_STATES_V1));
export type WorkflowRunStateV1 = z.infer<typeof WorkflowRunStateV1Schema>;

export const WorkflowControlV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('running') }).strict(),
  z.object({ kind: z.literal('pause_requested') }).strict(),
  z.object({ kind: z.literal('paused'), reason: z.literal('boundary') }).strict(),
  z.object({
    kind: z.literal('interrupted'),
    reason: z.enum(['invocation_failed', 'runtime_interrupted', 'outcome_uncertain']),
  }).strict(),
  z.object({ kind: z.literal('terminal') }).strict(),
]));
export type WorkflowControlV1 = z.infer<typeof WorkflowControlV1Schema>;

export const WorkflowRunAutomationOriginV1Schema = lazyZodSchema(() => z.object({
  kind: z.literal('automation'),
  automationId: preservedBoundedNfcString(191, 'Automation ids'),
  originSessionId: preservedBoundedNfcString(191, 'Session ids').optional(),
  /** Bounded immutable provenance; private occurrence content is never projected here. */
  cause: AutomationRunCauseSchema.optional(),
}).strict());
export const WorkflowRunDirectOriginV1Schema = lazyZodSchema(() => z.object({
  kind: z.literal('direct'),
  originSessionId: preservedBoundedNfcString(191, 'Session ids').optional(),
}).strict());
export const WorkflowRunOriginV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  WorkflowRunAutomationOriginV1Schema,
  WorkflowRunDirectOriginV1Schema,
]));
export type WorkflowRunOriginV1 = z.infer<typeof WorkflowRunOriginV1Schema>;

export const WorkflowRunCustodyStateV1Schema = lazyZodSchema(() => z.enum(['pending', 'settled']));
export type WorkflowRunCustodyStateV1 = z.infer<typeof WorkflowRunCustodyStateV1Schema>;

export const WorkflowRunAvailabilityV1Schema = lazyZodSchema(() => z.object({
  pause: z.boolean(),
  resumeBoundary: z.boolean(),
  restoreWorkspace: z.boolean(),
  cancel: z.boolean(),
  inspectExecution: z.boolean(),
  disabledReasons: z.array(z.object({ operation: z.enum([
    'pause', 'resume_boundary', 'recover_same_conversation', 'recover_fresh_agent',
    'retry', 'restore_workspace', 'cancel', 'inspect_execution',
  ]), code: z.string().min(1) }).strict()),
}).strict());
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
  z.object({ kind: z.literal('available') }).strict(),
  z.object({
    kind: z.literal('unavailable'),
    reason: WorkflowInvocationRecoveryUnavailableReasonV1Schema,
  }).strict(),
]));
export const WorkflowInvocationRetryAvailabilityV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('available'),
    causalInvocationIds: z.array(WorkflowInvocationRecordIdSchema).min(1),
  }).strict(),
  z.object({
    kind: z.literal('unavailable'),
    reason: WorkflowInvocationRecoveryUnavailableReasonV1Schema,
  }).strict(),
]));
export const WorkflowInvocationRecoveryAvailabilityV1Schema = lazyZodSchema(() => z.object({
  reattach: WorkflowInvocationRecoveryOperationAvailabilityV1Schema,
  retry: WorkflowInvocationRetryAvailabilityV1Schema,
  continueSameConversation: WorkflowInvocationRecoveryOperationAvailabilityV1Schema,
  continueFreshAgent: WorkflowInvocationRecoveryOperationAvailabilityV1Schema,
  restoreWorkspace: WorkflowInvocationRecoveryOperationAvailabilityV1Schema,
}).strict());
export type WorkflowInvocationRecoveryAvailabilityV1 = z.infer<typeof WorkflowInvocationRecoveryAvailabilityV1Schema>;

export const WorkflowRunStepProgressV1Schema = lazyZodSchema(() => z.object({
  completed: z.number().int().nonnegative().safe(),
  total: z.number().int().nonnegative().safe(),
  currentLoop: z.object({
    completed: z.number().int().nonnegative().safe(),
    total: z.number().int().nonnegative().safe(),
  }).strict().refine((value) => value.completed <= value.total).optional(),
}).strict().refine((value) => value.completed <= value.total));
export type WorkflowRunStepProgressV1 = z.infer<typeof WorkflowRunStepProgressV1Schema>;

/** Existing root row observation; counts can decrease when the current attempt changes. */
export const WorkflowRunStepProgressCurrentnessV1Schema = lazyZodSchema(() => z.object({
  recordId: WorkflowInvocationRecordIdSchema,
  attempt: WorkflowDecimalV1Schema,
  contentRevision: WorkflowDecimalV1Schema,
}).strict());
export type WorkflowRunStepProgressCurrentnessV1 = z.infer<typeof WorkflowRunStepProgressCurrentnessV1Schema>;

export const WorkflowRunSummaryV1Schema = lazyZodSchema(() => z.object({
  /** Opened private projections; null is unavailable, omission is a control-only response. */
  startedBy: WorkflowRunStartedByV1Schema.nullable().optional(),
  stepProgress: WorkflowRunStepProgressV1Schema.nullable().optional(),
  stepProgressCurrentness: WorkflowRunStepProgressCurrentnessV1Schema.nullable().optional(),
  /** Opened by the authorized list host; null is unreadable, omission is an operation that did not open it. */
  where: WorkflowProjectTargetV1Schema.nullable().optional(),
  /** Current server attention membership; absent on projections that did not read it. */
  attentionRequired: z.boolean().optional(),
  sourceArtifactId: WorkflowDefinitionIdV1Schema.nullable(),
  ownerAccountId: preservedBoundedNfcString(191, 'Account ids'),
  visibleTeamId: preservedBoundedNfcString(191, 'Team ids').nullable(),
  id: WorkflowRunIdV1Schema,
  origin: WorkflowRunOriginV1Schema,
  state: WorkflowRunStateV1Schema,
  revision: z.number().int().nonnegative().safe(),
  machineId: WorkflowMachineIdV1Schema,
  workflowCustodyState: WorkflowRunCustodyStateV1Schema.nullable(),
  originDeliveryAckRevision: z.number().int().nonnegative().safe().nullable(),
  availability: WorkflowRunAvailabilityV1Schema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  /**
   * When the Run reached its terminal state, as the server recorded that transition; null while it
   * has not. Unlike `updatedAt`, later custody or delivery bookkeeping never moves it. Absent on a
   * projection that did not read it.
   */
  finishedAt: z.string().datetime().nullable().optional(),
}).strict());
export type WorkflowRunSummaryV1 = z.infer<typeof WorkflowRunSummaryV1Schema>;

/** Public-index-only parent witness used by the exact-machine recovery reader. */
export const WorkflowRunRecoveryCandidateV1Schema = lazyZodSchema(() => z.object({
  run: WorkflowRunSummaryV1Schema,
  parentAttempt: z.number().int().nonnegative().safe(),
}).strict());
export type WorkflowRunRecoveryCandidateV1 = z.infer<typeof WorkflowRunRecoveryCandidateV1Schema>;

export const WorkflowRunInvocationIndexV1Schema = lazyZodSchema(() => z.object({
  id: WorkflowInvocationRecordIdSchema,
  runId: WorkflowRunIdV1Schema,
  sequence: WorkflowDecimalV1Schema,
  parentRecordId: WorkflowInvocationRecordIdSchema.nullable(),
  memberOrdinal: WorkflowDecimalV1Schema,
  attempt: WorkflowDecimalV1Schema,
  contentRevision: WorkflowDecimalV1Schema,
  lifecycle: WorkflowInvocationLifecycleV1Schema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict());
export type WorkflowRunInvocationIndexV1 = z.infer<typeof WorkflowRunInvocationIndexV1Schema>;

/** Fact acknowledgement observes the row and parent revision in the same transaction. */
export const WorkflowInvocationFactResultV1Schema = lazyZodSchema(() => WorkflowRunInvocationIndexV1Schema.extend({
  parentRevision: z.number().int().nonnegative().safe(),
}).strict());

export const WorkflowInvocationPathV1Schema = lazyZodSchema(() => z.object({
  blockId: z.union([WorkflowBlockIdSchema, z.literal('$root')]),
  scope: z.array(z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('branch'), blockId: WorkflowBlockIdSchema, branchId: WorkflowBlockIdSchema }).strict(),
    z.object({ kind: z.literal('iteration'), blockId: WorkflowBlockIdSchema, index: z.number().int().nonnegative().safe() }).strict(),
    z.object({ kind: z.literal('workflow'), blockId: WorkflowBlockIdSchema }).strict(),
  ])),
}).strict());
export type WorkflowInvocationPathV1 = z.infer<typeof WorkflowInvocationPathV1Schema>;

const WorkflowExecutionCorrespondenceBaseV1Schema = lazyZodSchema(() => z.object({
  localInputId: preservedBoundedNfcString(191, 'Execution input local ids'),
  turnId: preservedBoundedNfcString(191, 'Turn ids').optional(),
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
export const WorkflowRetainedRuntimeSelectionV1Schema = WorkflowSessionAuthoringSelectionSchema;
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
  z.object({
    kind: z.literal('session_ready'),
    sessionId: preservedBoundedNfcString(191, 'Session ids'),
  }).strict(),
  WorkflowExecutionCorrespondenceBaseV1Schema.extend({
    kind: z.literal('action'),
    actionId: z.string().min(1),
    actionRequestId: preservedBoundedNfcString(191, 'Action request ids'),
    input: z.record(z.string(), StrictJsonValueSchema),
    output: ActionCompletionStateV1Schema.shape.output.optional(),
    awaitedRuns: ActionCompletionStateV1Schema.shape.awaitedRuns.optional(),
    awaitedOperations: ActionCompletionStateV1Schema.shape.awaitedOperations.optional(),
  }).strict(),
  WorkflowExecutionCorrespondenceBaseV1Schema.extend({
    kind: z.literal('session'),
    sessionId: preservedBoundedNfcString(191, 'Session ids'),
  }).strict(),
  WorkflowExecutionCorrespondenceBaseV1Schema.extend({
    kind: z.literal('detached_run'),
    runId: preservedBoundedNfcString(191, 'Execution Run ids'),
    runtimeSelection: WorkflowRetainedRuntimeSelectionV1Schema,
    /**
     * First provider-owned resumable identity validated by the Execution Run
     * host for this exact detached invocation. This private correspondence is
     * the durable owner; public Run projections and activity markers are not
     * restart authority.
     */
    providerResumeIdentity: ExecutionRunResumeHandleProviderSessionV1Schema.optional(),
  }).strict(),
]));
export type WorkflowExecutionCorrespondenceV1 = z.infer<typeof WorkflowExecutionCorrespondenceV1Schema>;

export const WorkflowInvocationFrameV1Schema = lazyZodSchema(() => z.object({
  ownerBlockId: WorkflowBlockIdSchema,
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('branch'), branchId: WorkflowBlockIdSchema }).strict(),
    z.object({ kind: z.literal('item'), index: WorkflowDecimalV1Schema }).strict(),
    z.object({ kind: z.literal('iteration'), index: WorkflowDecimalV1Schema }).strict(),
  ]),
}).strict());
export type WorkflowInvocationFrameV1 = z.infer<typeof WorkflowInvocationFrameV1Schema>;

export const WorkflowLoopOutcomeV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('decision'), value: z.string(), reason: z.string().optional() }).strict(),
  z.object({ kind: z.literal('stop_condition'), arm: z.number().int().nonnegative().safe().optional() }).strict(),
  z.object({ kind: z.literal('exhausted'), rounds: z.number().int().positive().safe() }).strict(),
]));
export type WorkflowLoopOutcomeV1 = z.infer<typeof WorkflowLoopOutcomeV1Schema>;

export const WorkflowContainerClosingV1Schema = lazyZodSchema(() => z.object({
  code: preservedBoundedNfcString(191, 'Workflow container closing codes'),
  causeInvocationRecordId: WorkflowInvocationRecordIdSchema.optional(),
  outcome: WorkflowLoopOutcomeV1Schema.optional(),
}).strict());
export type WorkflowContainerClosingV1 = z.infer<typeof WorkflowContainerClosingV1Schema>;

export const WorkflowLoopSourceSelectionV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('definition'),
    reference: z.union([
      z.object({ kind: z.literal('literal'), value: StrictJsonValueSchema }).strict(),
      z.object({ kind: z.literal('input'), name: WorkflowInputNameSchema }).strict(),
    ]),
  }).strict(),
  z.object({
    kind: z.literal('result'),
    recordId: WorkflowInvocationRecordIdSchema,
    path: WorkflowResultPathSchema,
  }).strict(),
]));
export type WorkflowLoopSourceSelectionV1 = z.infer<typeof WorkflowLoopSourceSelectionV1Schema>;

const WorkflowContainerBodyProgressV1Schema = lazyZodSchema(() => z.object({
  kind: z.literal('body'),
  nextBlockOrdinal: WorkflowDecimalV1Schema,
  /** Inline Workflow admission binds once, including live context references. */
  frameInputs: WorkflowResolvedInputsV1Schema.optional(),
  /** Selected project is distinct from the inline child's lazy default workspace. */
  frameProjectWorkspace: WorkflowWorkspaceProgressV1Schema.optional(),
  closing: WorkflowContainerClosingV1Schema.optional(),
}).strict());
const WorkflowContainerParallelProgressV1Schema = lazyZodSchema(() => z.object({
  kind: z.literal('parallel'),
  nextBranchOrdinal: WorkflowDecimalV1Schema,
  closing: WorkflowContainerClosingV1Schema.optional(),
}).strict());
const WorkflowContainerIfProgressV1Schema = lazyZodSchema(() => z.object({
  kind: z.literal('if'),
  selected: z.enum(['then', 'otherwise']),
  nextBlockOrdinal: WorkflowDecimalV1Schema,
  closing: WorkflowContainerClosingV1Schema.optional(),
}).strict());
const WorkflowContainerLoopBaseV1Schema = lazyZodSchema(() => z.object({
  kind: z.literal('loop'),
  nextMemberIndex: WorkflowDecimalV1Schema,
  nextBodyBlockOrdinal: WorkflowDecimalV1Schema,
  closing: WorkflowContainerClosingV1Schema.optional(),
}));
export const WorkflowContainerProgressV1Schema = lazyZodSchema(() => z.union([
  WorkflowContainerBodyProgressV1Schema,
  WorkflowContainerParallelProgressV1Schema,
  WorkflowContainerIfProgressV1Schema,
  WorkflowContainerLoopBaseV1Schema.extend({
    mode: z.literal('count'),
    source: WorkflowLoopSourceSelectionV1Schema,
    count: WorkflowDecimalV1Schema,
  }).strict(),
  WorkflowContainerLoopBaseV1Schema.extend({
    mode: z.literal('items'),
    source: WorkflowLoopSourceSelectionV1Schema,
    itemCount: WorkflowDecimalV1Schema,
  }).strict(),
  WorkflowContainerLoopBaseV1Schema.extend({ mode: z.literal('until') }).strict(),
  WorkflowContainerLoopBaseV1Schema.extend({ mode: z.literal('evaluate') }).strict(),
]));
export type WorkflowContainerProgressV1 = z.infer<typeof WorkflowContainerProgressV1Schema>;

export const WorkflowContainerResultSelectorV1Schema = lazyZodSchema(() => z.object({
  kind: z.literal('container'),
  containerRecordId: WorkflowInvocationRecordIdSchema,
}).strict());
export type WorkflowContainerResultSelectorV1 = z.infer<typeof WorkflowContainerResultSelectorV1Schema>;

export const WorkflowInvocationRecoveryV1Schema = lazyZodSchema(() => z.object({
  conversation: z.enum(['same_conversation', 'fresh_agent']),
  input: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('original') }).strict(),
    z.object({
      kind: z.literal('replacement'),
      value: z.object({
        document: WorkflowStepComposerDocumentSchema,
        input: z.array(StrictJsonValueSchema).default([]),
      }).strict(),
    }).strict(),
  ]),
  acknowledgeUncertainPriorEffects: z.literal(true).optional(),
}).strict());
export type WorkflowInvocationRecoveryV1 = z.infer<typeof WorkflowInvocationRecoveryV1Schema>;

/**
 * Exact provider-reported usage attributable to one Workflow leaf invocation.
 * Missing members mean the execution owner did not report that dimension.
 */
export const WorkflowUsageV1Schema = lazyZodSchema(() => z.object({
  inputTokens: z.number().int().safe().nonnegative().optional(),
  outputTokens: z.number().int().safe().nonnegative().optional(),
  costUsd: z.number().finite().nonnegative().optional(),
}).strict());
export type WorkflowUsageV1 = z.infer<typeof WorkflowUsageV1Schema>;

export const WorkflowConversationRefV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('session'), machineId: WorkflowMachineIdV1Schema, sessionId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('detached_run'), machineId: WorkflowMachineIdV1Schema, runId: z.string().min(1) }).strict(),
]));
export const WorkflowInputRefV1Schema = lazyZodSchema(() => z.object({
  conversation: WorkflowConversationRefV1Schema,
  localId: z.string().min(1),
  turnId: z.string().min(1).optional(),
}).strict());

export const WorkflowReviewResultSourceV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('execution_input') }).strict(),
  z.object({ kind: z.literal('published'), by: z.enum(['agent', 'user']),
    input: WorkflowInputRefV1Schema.optional() }).strict(),
  z.object({ kind: z.literal('human'), accountId: preservedBoundedNfcString(191, 'Account ids') }).strict(),
]));
export type WorkflowReviewResultSourceV1 = z.infer<typeof WorkflowReviewResultSourceV1Schema>;
export const WorkflowReviewFollowUpV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('run_started'), runId: WorkflowRunIdV1Schema }).strict(),
  z.object({ kind: z.literal('editing') }).strict(),
]));
export const WorkflowReviewDecisionV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('use_result'), requestedFromContentRevision: WorkflowDecimalV1Schema,
    followUp: WorkflowReviewFollowUpV1Schema.optional() }).strict(),
  z.object({ kind: z.literal('generate'), requestedFromContentRevision: WorkflowDecimalV1Schema }).strict(),
]));
export const WorkflowReviewV1Schema = lazyZodSchema(() => z.object({
  resultSource: WorkflowReviewResultSourceV1Schema.optional(),
  decision: WorkflowReviewDecisionV1Schema.optional(),
}).strict());
export type WorkflowReviewV1 = z.infer<typeof WorkflowReviewV1Schema>;

const WorkflowResultValidationIssuesV1Schema = lazyZodSchema(() => z.array(z.object({ pointer: z.string(), message: z.string() }).strict()));

/** Condition outcome, not delivery success. Absence means it has not been observed. */
export const WorkflowNotificationConditionV1Schema = lazyZodSchema(() => z.enum(['matched', 'suppressed']));
export type WorkflowNotificationConditionV1 = z.infer<typeof WorkflowNotificationConditionV1Schema>;
export const WorkflowResultProvenanceV1Schema = lazyZodSchema(() => z.record(WorkflowInvocationRecordIdSchema,
  z.object({ notificationCondition: WorkflowNotificationConditionV1Schema }).strict()));
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

export const WorkflowProgressEnvelopeV1Schema = lazyZodSchema(() => z.object({
  kind: z.literal('happier.workflow-progress.v1'),
  invocationPath: WorkflowInvocationPathV1Schema,
  frame: WorkflowInvocationFrameV1Schema.optional(),
  blockKind: z.enum(['root', 'step', 'action', 'wait', 'workflow', 'parallel', 'loop', 'if']),
  /** Executing worker's private authored-step projection, retained on the root row only. */
  stepProgress: WorkflowRunStepProgressV1Schema.optional(),
  /** Evaluated Notify me conditions keyed by the exact physical result, retained only on the mutable root. */
  resultProvenance: WorkflowResultProvenanceV1Schema.optional(),
  container: WorkflowContainerProgressV1Schema.optional(),
  attempt: WorkflowDecimalV1Schema,
  input: StrictJsonValueSchema.optional(),
  validationIssues: WorkflowResultValidationIssuesV1Schema.optional(),
  result: StrictJsonValueSchema.optional(),
  review: WorkflowReviewV1Schema.optional(),
  usage: WorkflowUsageV1Schema.optional(),
  /**
   * Private request-state projection for this exact invocation. The incumbent
   * permission owner writes this independently from the selected step result;
   * it is not a Workflow decision or a generic execution-result ledger.
   */
  interaction: StrictJsonValueSchema.optional(),
  containerResult: WorkflowContainerResultSelectorV1Schema.optional(),
  resultContract: StrictJsonValueSchema.optional(),
  execution: WorkflowExecutionCorrespondenceV1Schema.optional(),
  /** Exact admitted leaf rows; conversation targets and workspace stay leaf-owned. */
  sharedConversationInvocationRecordId: z.object({
    session: WorkflowInvocationRecordIdSchema.optional(),
    detached_run: WorkflowInvocationRecordIdSchema.optional(),
  }).strict().optional(),
  observationDeadline: z.object({ kind: z.literal('at'), expiresAt: z.string().datetime() }).strict().optional(),
  workspace: WorkflowWorkspaceProgressV1Schema.optional(),
  reason: z.object({ code: z.string().min(1), message: z.string().optional() }).strict().optional(),
  previousAttemptRecordId: WorkflowInvocationRecordIdSchema.optional(),
  recovery: WorkflowInvocationRecoveryV1Schema.optional(),
  uncertainPriorEffects: z.object({ activity: z.literal('stopped') }).strict().optional(),
  logicalInvocationRecordId: WorkflowInvocationRecordIdSchema,
}).strict().superRefine((value, context) => {
  const isRoot = value.blockKind === 'root';
  if (value.resultProvenance !== undefined && !isRoot) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['resultProvenance'],
      message: 'Result condition provenance belongs only to the root frame' });
  }
  if (value.stepProgress !== undefined && !isRoot) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['stepProgress'],
      message: 'Authored Run progress belongs only to the root frame' });
  }
  if (isRoot !== (value.invocationPath.blockId === '$root')) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['invocationPath', 'blockId'],
      message: 'The reserved $root path belongs only to the structural root frame',
    });
  }
  if (value.result !== undefined && value.containerResult !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['containerResult'],
      message: 'Workflow progress cannot store both a leaf result and a container selector',
    });
  }
  const isInitialAttempt = value.attempt === '0';
  if (isInitialAttempt && value.previousAttemptRecordId !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['previousAttemptRecordId'],
      message: 'An initial Workflow attempt cannot name a previous attempt',
    });
  }
  if (!isInitialAttempt && value.previousAttemptRecordId === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['previousAttemptRecordId'],
      message: 'A retried Workflow attempt must name its previous physical attempt',
    });
  }
}));
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
export const WorkflowInvocationFactV1Schema = lazyZodSchema(() => z.object({
  resultProvenance: WorkflowResultProvenanceV1Schema.optional(),
  validationIssues: WorkflowResultValidationIssuesV1Schema.optional(),
  result: StrictJsonValueSchema.optional(),
  resultContract: StrictJsonValueSchema.optional(),
  usage: WorkflowUsageV1Schema.optional(),
  interaction: StrictJsonValueSchema.optional(),
  reason: z.string().min(1).optional(),
  reasonMessage: z.string().optional(),
  execution: WorkflowExecutionCorrespondenceV1Schema.optional(),
  sharedConversationInvocationRecordId: z.object({
    session: WorkflowInvocationRecordIdSchema.optional(), detached_run: WorkflowInvocationRecordIdSchema.optional(),
  }).strict().optional(),
  observationDeadline: z.object({ kind: z.literal('at'), expiresAt: z.string().datetime() }).strict().optional(),
  input: StrictJsonValueSchema.optional(),
  workspace: WorkflowWorkspaceProgressV1Schema.optional(),
  container: WorkflowContainerProgressV1Schema.optional(),
  containerResult: WorkflowContainerResultSelectorV1Schema.optional(),
}).strict());
export type WorkflowInvocationFactV1 = z.infer<typeof WorkflowInvocationFactV1Schema>;

export function applyWorkflowInvocationFactV1(
  currentProgress: WorkflowProgressEnvelopeV1,
  fact: WorkflowInvocationFactV1,
): WorkflowProgressEnvelopeV1 {
  const owned = WorkflowInvocationFactV1Schema.parse(fact);
  const { result, reason, reasonMessage, sharedConversationInvocationRecordId, workspace, resultProvenance, ...fields } = owned;
  const definedFields = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
  return WorkflowProgressEnvelopeV1Schema.parse({
    ...currentProgress, ...definedFields,
    ...(resultProvenance !== undefined ? { resultProvenance: mergeWorkflowResultProvenanceV1(currentProgress.resultProvenance, resultProvenance) } : {}),
    ...(currentProgress.result === undefined && result !== undefined ? { result } : {}),
    ...(currentProgress.reason === undefined && reason !== undefined
      ? { reason: { code: reason, ...(reasonMessage !== undefined ? { message: reasonMessage } : {}) } } : {}),
    ...(sharedConversationInvocationRecordId !== undefined ? { sharedConversationInvocationRecordId: {
      ...currentProgress.sharedConversationInvocationRecordId, ...sharedConversationInvocationRecordId,
    } } : {}),
    ...(workspace !== undefined ? { workspace: { ...currentProgress.workspace, ...workspace } } : {}),
  });
}

export const WorkflowCheckpointEnvelopeV1Schema = lazyZodSchema(() => z.object({
  kind: z.literal('happier.workflow-checkpoint.v1'),
  /** Final panel's agreed reviewed tree, present only on succeeded review Runs. */
  endFingerprint: z.string().min(1).optional(),
  rootRecordId: WorkflowInvocationRecordIdSchema,
  nextSequence: WorkflowDecimalV1Schema,
  frontier: z.object({
    nextBlockOrdinal: z.number().int().nonnegative().safe(),
    paused: z.boolean(),
    interruption: z.string().min(1).optional(),
  }).strict(),
}).strict());
export type WorkflowCheckpointEnvelopeV1 = z.infer<typeof WorkflowCheckpointEnvelopeV1Schema>;

export const WorkflowInvocationDetailV1Schema = lazyZodSchema(() => z.object({
  index: WorkflowRunInvocationIndexV1Schema,
  progress: WorkflowProgressEnvelopeV1Schema,
  parentRevision: z.number().int().nonnegative().safe(),
  /** Exact private-evidence decision projected only after this invocation is opened. */
  recoveryAvailability: WorkflowInvocationRecoveryAvailabilityV1Schema.optional(),
}).strict());
export type WorkflowInvocationDetailV1 = z.infer<typeof WorkflowInvocationDetailV1Schema>;

export const WorkflowAuthoredInputV1Schema = lazyZodSchema(() => z.object({
  document: WorkflowStepComposerDocumentSchema,
  input: z.array(StrictJsonValueSchema).default([]),
  /** Producer-rendered origin input, frozen atomically with its admitting correspondence. */
  renderedText: z.string().optional(),
}).strict());
export type WorkflowAuthoredInputV1 = z.infer<typeof WorkflowAuthoredInputV1Schema>;

export const WorkflowInvocationRefV1Schema = lazyZodSchema(() => z.object({ recordId: WorkflowInvocationRecordIdSchema }).strict());
const WorkflowRecoveryInputV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('original') }).strict(),
  z.object({ kind: z.literal('replacement'), value: WorkflowAuthoredInputV1Schema }).strict(),
]));
export const WorkflowRecoveryChoiceV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('reattach'), invocation: WorkflowInvocationRefV1Schema }).strict(),
  z.object({
    kind: z.literal('continue'), invocation: WorkflowInvocationRefV1Schema,
    conversation: z.enum(['same_conversation', 'fresh_agent']),
    input: WorkflowAuthoredInputV1Schema,
    acknowledgeUncertainPriorEffects: z.literal(true).optional(),
  }).strict(),
  z.object({
    kind: z.literal('restore_workspace'), invocation: WorkflowInvocationRefV1Schema,
    conversation: z.enum(['same_conversation', 'fresh_agent']),
    input: WorkflowRecoveryInputV1Schema,
    acknowledgeUncertainPriorEffects: z.literal(true).optional(),
  }).strict(),
]));

export const WorkflowResumeInputV1Schema = lazyZodSchema(() => z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('boundary'), runId: WorkflowRunIdV1Schema, expectedRevision: z.number().int().nonnegative().safe() }).strict(),
  z.object({
    mode: z.literal('recover'), runId: WorkflowRunIdV1Schema,
    expectedRevision: z.number().int().nonnegative().safe(),
    invocations: z.array(WorkflowRecoveryChoiceV1Schema).min(1),
  }).strict(),
]));
export type WorkflowResumeInputV1 = z.infer<typeof WorkflowResumeInputV1Schema>;

export const WorkflowInvocationRetryInputV1Schema = lazyZodSchema(() => z.object({
  runId: WorkflowRunIdV1Schema,
  expectedRevision: z.number().int().nonnegative().safe(),
  invocation: WorkflowInvocationRefV1Schema,
  causalInvocationIds: z.array(WorkflowInvocationRecordIdSchema).min(1),
  conversation: z.enum(['same_conversation', 'fresh_agent']),
  input: WorkflowRecoveryInputV1Schema,
  acknowledgeUncertainPriorEffects: z.literal(true).optional(),
}).strict());
export type WorkflowInvocationRetryInputV1 = z.infer<typeof WorkflowInvocationRetryInputV1Schema>;

export const WORKFLOW_OPERATION_ERROR_CODES_V1 = [
  'invalid_input', 'run_not_found', ...AGENT_START_REFUSAL_CODES_V1,
  'currentness_conflict', 'missing_reference', 'invalid_reference_scope',
  'workflow_input_too_large', 'workflow_outcome_unresolved',
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

const WORKFLOW_OPERATION_ERROR_CODES_WITHOUT_DETAILS_V1 = [
  'run_not_found',
  'missing_reference', 'invalid_reference_scope',
  'workflow_input_too_large', 'workflow_outcome_unresolved',
  'workflow_interaction_capacity_exceeded',
  'workflow_conversation_unavailable', 'continuation_unavailable',
  'workflow_workspace_restore_unavailable', 'workflow_workspace_restore_failed',
  'ineligible_state', 'custody_pending',
  'source_unavailable',
  'history_not_readable', 'encryption_setup_required', 'waiting_for_keys', 'storage_unavailable',
  'native_goal_owner', 'session_already_started',
] as const;

/** Closed semantic failure returned by the Workflow Action family dependency. */
export const WorkflowActionFailureV1Schema = lazyZodSchema(() => z.discriminatedUnion('errorCode', [
  z.object({
    ok: z.literal(false), errorCode: z.literal('content_unavailable'), error: z.string().trim().min(1),
    details: z.object({ reason: WorkflowDefinitionContentUnavailableReasonV1Schema }).strict().optional(),
  }).strict(),
  z.object({
    ok: z.literal(false), errorCode: z.enum(AGENT_START_REFUSAL_CODES_V1), error: z.string().trim().min(1),
    details: AgentStartRefusalV1Schema.optional(),
  }).strict(),
  z.object({
    ok: z.literal(false), errorCode: z.literal('invalid_input'), error: z.string().trim().min(1),
    details: z.object({
      code: z.literal('invalid_input').optional(), blockId: WorkflowBlockIdSchema.optional(),
      issues: z.array(z.union([WorkflowValidationIssueV1Schema, z.object({
        code: z.enum(['unknown_block_id', 'invalid_target']), path: z.tuple([z.literal('ops'), z.number().int().nonnegative()]),
      }).strict()])).optional(),
    }).strict().optional(),
  }).strict(),
  z.object({
    ok: z.literal(false),
    errorCode: z.literal('legacy_conversion_unsupported'),
    error: z.string().trim().min(1),
    details: z.object({ reason: LegacyAutomationWorkflowConversionReasonV1Schema }).strict(),
  }).strict(),
  z.object({
    ok: z.literal(false),
    errorCode: z.literal('currentness_conflict'),
    error: z.string().trim().min(1),
    details: z.object({ revision: z.number().int().nonnegative().safe() }).strict().optional(),
  }).strict(),
  z.object({
    ok: z.literal(false),
    errorCode: z.literal('workflow_wait_self_dependency'),
    error: z.string().trim().min(1),
    details: z.object({ runId: WorkflowRunIdV1Schema }).strict(),
  }).strict(),
  z.object({
    ok: z.literal(false),
    errorCode: z.enum(WORKFLOW_OPERATION_ERROR_CODES_WITHOUT_DETAILS_V1),
    error: z.string().trim().min(1),
  }).strict(),
]));
export type WorkflowActionFailureV1 = z.infer<typeof WorkflowActionFailureV1Schema>;

export const WorkflowErrorV1Schema = lazyZodSchema(() => z.object({
  code: WorkflowOperationErrorCodeV1Schema,
  message: z.string().optional(),
}).strict());
export type WorkflowErrorV1 = z.infer<typeof WorkflowErrorV1Schema>;

export const WorkflowResultRefV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), value: z.string() }).strict(),
  z.object({ kind: z.literal('decision'), value: z.string() }).strict(),
  z.object({ kind: z.literal('json'), value: StrictJsonValueSchema }).strict(),
]));
export type WorkflowResultRefV1 = z.infer<typeof WorkflowResultRefV1Schema>;
export const WorkflowStepObservationV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pending'), input: WorkflowInputRefV1Schema }).strict(),
  z.object({ kind: z.literal('completed'), input: WorkflowInputRefV1Schema, result: WorkflowResultRefV1Schema.optional() }).strict(),
  z.object({ kind: z.literal('failed'), input: WorkflowInputRefV1Schema.optional(), error: WorkflowErrorV1Schema }).strict(),
  z.object({ kind: z.literal('cancelled'), input: WorkflowInputRefV1Schema }).strict(),
  z.object({ kind: z.literal('outcome_uncertain'), input: WorkflowInputRefV1Schema.optional(), error: WorkflowErrorV1Schema }).strict(),
]));
export type WorkflowStepObservationV1 = z.infer<typeof WorkflowStepObservationV1Schema>;

export const WorkflowFinalOutputSelectionV1Schema = WorkflowAuthoredResultReferenceSchema;

export const WorkflowFinalResultV1Schema = lazyZodSchema(() => z.object({
  kind: z.literal('happier.workflow-final-result.v1'),
  result: WorkflowResultRefV1Schema,
  /** Exact persisted producer selected by the authored final-output binding. */
  producerInvocation: WorkflowInvocationRefV1Schema,
}).strict());
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
