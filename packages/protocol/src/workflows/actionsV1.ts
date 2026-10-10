import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';
import { WorkflowDestinationsV1Schema } from './workflowDestinationsV1.js';
import {
  WorkflowTriggerListRequestV1Schema, WorkflowTriggerAddRequestV1Schema,
  WorkflowTriggerUpdateRequestV1Schema, WorkflowTriggerRemoveRequestV1Schema,
  WorkflowTriggerRunNowRequestV1Schema,
  WorkflowTriggerListResultV1Schema, WorkflowTriggerWriteResultV1Schema,
  SessionTriggerListRequestV1Schema, SessionTriggerAddRequestV1Schema,
  SessionTriggerUpdateRequestV1Schema, SessionTriggerRemoveRequestV1Schema, SessionTriggerListResultV1Schema,
  WorkflowTriggerSummaryInputV1Schema,
} from './triggers/workflowTriggerActionsV1.js';

import { OPAQUE_CURSOR_SCHEMA } from '../automations/automationActionSpecsV1.js';
import { AutomationV3RunMutationResponseSchema } from '../automations/automationApiV3.js';
import {
  WORKFLOW_ACTION_IDS_V1,
  type WorkflowActionIdV1,
} from '../actions/actionIds.js';
import { StrictJsonValueSchema } from '../json/strictJsonValue.js';
import { preservedBoundedNfcString } from '../strings/preservedBoundedNfcString.js';
import {
  WorkflowDefinitionArtifactHeaderV1Schema,
  WorkflowDefinitionMetadataV1Schema,
  WorkflowDefinitionSavedByV1Schema,
  WorkflowDefinitionContentUnavailableReasonV1Schema,
  WorkflowArtifactRevisionV1Schema,
  WorkflowRunExecutionTargetV1Schema,
  WorkflowRoleOverridesV1Schema,
  WorkflowMaterializedLeafV1Schema,
  WorkflowFrozenChildrenV1Schema,
  WorkflowRunStartedByV1Schema,
  WorkflowReplayAgentOverrideV1Schema,
  WorkflowAcceptedInlineSourceV1Schema,
} from './workflowDefinitionV1.js';
import { WorkflowAcceptedWorkspaceTargetV1Schema } from './workflowWorkspaceV1.js';
import {
  WorkflowDefinitionV1Schema,
  WorkflowValidationIssueV1Schema,
} from './workflowV1.js';
export { WorkflowValidationIssueV1Schema } from './workflowV1.js';
import {
  WorkflowCheckpointEnvelopeV1Schema,
  WorkflowDecimalV1Schema,
  WorkflowInvocationRefV1Schema,
  WorkflowReviewFollowUpV1Schema,
  WorkflowInvocationDetailV1Schema,
  WorkflowInvocationLifecycleV1Schema,
  WorkflowInvocationRecordIdSchema,
  WorkflowInvocationRetryInputV1Schema,
  WorkflowMachineIdV1Schema,
  WorkflowResumeInputV1Schema,
  WorkflowRunIdV1Schema,
  WorkflowRunInvocationIndexV1Schema,
  WorkflowRunOriginV1Schema,
  WorkflowRunStateV1Schema,
  WorkflowRunSummaryV1Schema,
  WorkflowUsageV1Schema,
  WorkflowNotificationConditionV1Schema,
  WorkflowOperationErrorCodeV1Schema,
} from './workflowProgressV1.js';
import {
  WorkflowDefinitionIdV1Schema,
  WorkflowDirectRunAdmissionIdV1Schema,
} from './workflowIdsV1.js';
import { WorkflowInputNameSchema } from './workflowReferenceV1.js';
import { WorkflowDefinitionEditRequestV1Schema, WorkflowDefinitionEditResultV1Schema } from './workflowDefinitionEditV1.js';
import { WorkflowDocumentV1Schema, WorkflowDocumentParseFailureV1Schema } from './workflowDocumentSchemasV1.js';
import { WorkflowDefinitionRefV1StringSchema, parseWorkflowDefinitionRefV1 } from './workflowDefinitionRefV1.js';
import { WorkflowPluginSourceV1Schema } from './workflowPluginSourceContractV1.js';
export { WorkflowDefinitionEditRequestV1Schema, WorkflowDefinitionEditResultV1Schema } from './workflowDefinitionEditV1.js';

const CursorSchema = OPAQUE_CURSOR_SCHEMA;
// Artifact cursors encode a JSON object as base64url (starting `ey`). The
// reserved phase belongs to the same list, after its Account Artifact pages.
export const WORKFLOW_DEFINITION_PLUGIN_CURSOR_PREFIX_V1 = 'plugin-workflows_';
export function workflowDefinitionListCursorPhaseV1(cursor: string | null | undefined): 'artifacts' | 'plugins-start' | 'plugins-more' {
  if (cursor === `${WORKFLOW_DEFINITION_PLUGIN_CURSOR_PREFIX_V1}0`) return 'plugins-start';
  return cursor?.startsWith(WORKFLOW_DEFINITION_PLUGIN_CURSOR_PREFIX_V1) ? 'plugins-more' : 'artifacts';
}
const PositivePagePreferenceSchema = lazyZodSchema(() => z.number().int().positive().safe());
const RevisionSchema = lazyZodSchema(() => z.number().int().nonnegative().safe());
/**
 * Action transport carries authored ingress to the one workflow normalizer.
 * Keeping the carrier non-recursive prevents the generic Zod boundary from
 * overflowing before that owner can return path-addressed typed issues.
 */
const WorkflowIngressCarrierV1Schema = lazyZodSchema(() => z.object({
  version: z.literal(1).optional(),
  inputs: z.array(z.unknown()).optional(),
  defaults: z.unknown().optional(),
  roles: z.unknown().optional(),
  blocks: z.array(z.unknown()).min(1),
  finalOutput: z.unknown().optional(),
}).strict());
const WorkflowInputsV1Schema = lazyZodSchema(() => z.record(z.string(), StrictJsonValueSchema).superRefine(
  (inputs, context) => {
    for (const inputName of Object.keys(inputs)) {
      if (!WorkflowInputNameSchema.safeParse(inputName).success) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [inputName],
          message: 'Invalid Workflow input name',
        });
      }
    }
  },
));

export const WorkflowValidateRequestV1Schema = lazyZodSchema(() => z.object({
  definition: WorkflowIngressCarrierV1Schema,
  inputs: WorkflowInputsV1Schema.optional(),
  target: z.object({ machineId: WorkflowMachineIdV1Schema }).strict().optional(),
}).strict());
export const WorkflowValidateResultV1Schema = lazyZodSchema(() => z.object({
  valid: z.boolean(), normalizedDefinition: WorkflowDefinitionV1Schema.optional(),
  issues: z.array(WorkflowValidationIssueV1Schema),
  targetValidation: z.enum(['not_requested', 'checked', 'unavailable']),
}).strict());

export const WorkflowRunSourceV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  WorkflowAcceptedInlineSourceV1Schema.extend({ definition: WorkflowIngressCarrierV1Schema,
    visibleTeamId: preservedBoundedNfcString(191, 'Team ids').optional(),
    /** Replay reopens this Run at the owner; the reviewed carrier cannot replace its frozen graph. */
    replay: z.object({ runId: WorkflowRunIdV1Schema,
      agentOverride: WorkflowReplayAgentOverrideV1Schema.optional() }).strict().optional(),
  }).strict().superRefine((source, context) => {
    if (source.visibleTeamId !== undefined && source.sourceArtifactId === undefined) {
      context.addIssue({ code: 'custom', path: ['visibleTeamId'], message: 'Team visibility requires an Artifact source binding' });
    }
    if (source.replay && (source.sourceArtifactId !== undefined || source.visibleTeamId !== undefined)) {
      context.addIssue({ code: 'custom', path: ['replay'], message: 'Replay retains the accepted source and Team visibility' });
    }
  }),
  z.object({ kind: z.literal('saved'), definitionId: WorkflowDefinitionIdV1Schema, revision: WorkflowArtifactRevisionV1Schema,
    visibleTeamId: preservedBoundedNfcString(191, 'Team ids').optional() }).strict(),
  z.object({ kind: z.literal('catalog'), workflow: WorkflowDefinitionRefV1StringSchema.refine(
    (ref) => parseWorkflowDefinitionRefV1(ref)?.kind !== 'artifact', 'Catalog sources must name a built-in or plugin workflow',
  ), pluginVersion: z.string().min(1).optional() }).strict(),
]));
export const WorkflowRunStartRequestV1Schema = lazyZodSchema(() => z.object({
  runId: WorkflowDirectRunAdmissionIdV1Schema,
  source: WorkflowRunSourceV1Schema,
  /** Optional authored display metadata; admission freezes its absence as null. */
  metadata: WorkflowDefinitionMetadataV1Schema.optional(),
  inputs: WorkflowInputsV1Schema.optional(),
  executionTarget: WorkflowRunExecutionTargetV1Schema.optional(),
  roleOverrides: WorkflowRoleOverridesV1Schema.optional(),
  onComplete: z.object({ kind: z.literal('originating_session') }).strict().optional(),
}).strict());
export const WorkflowRunStartResultV1Schema = lazyZodSchema(() => z.object({
  run: WorkflowRunSummaryV1Schema,
  admission: z.enum(['created', 'existing']),
}).strict());
export const WorkflowRunActionResultReferenceV1Schema = lazyZodSchema(() => z.object({
  runId: WorkflowRunIdV1Schema,
  origin: WorkflowRunOriginV1Schema,
}).strict());

const WorkflowRunStartActionSuccessEnvelopeV1Schema = lazyZodSchema(() => z.object({
  ok: z.literal(true),
  result: WorkflowRunStartResultV1Schema,
}).strict());

export function parseWorkflowRunStartActionResultReferenceV1(
  value: unknown,
): WorkflowRunActionResultReferenceV1 | null {
  const enveloped = WorkflowRunStartActionSuccessEnvelopeV1Schema.safeParse(value);
  const startResult = enveloped.success
    ? enveloped.data.result
    : WorkflowRunStartResultV1Schema.safeParse(value).data;
  return startResult
    ? { runId: startResult.run.id, origin: startResult.run.origin }
    : null;
}

export const WorkflowRunAttentionFilterV1Schema = lazyZodSchema(() => z.literal('required'));
export const WorkflowRunListRequestV1Schema = lazyZodSchema(() => z.object({
  cursor: CursorSchema.optional(), limit: PositivePagePreferenceSchema.optional(),
  /**
   * Exact-Run selection for background refresh and transcript initial
   * materialization. The page stays the lean list projection — Run summaries
   * plus the sparse accepted-metadata sidecar — with zero or one rows and no
   * usage, checkpoint, definition or invocation reads. Explicit Run detail
   * keeps `workflow.run.get`.
   */
  runId: WorkflowRunIdV1Schema.optional(),
  /** Exact transcript references, batched at the Run-list owner rather than read by each message. */
  runIds: z.array(WorkflowRunIdV1Schema).optional(),
  invocationProvenance: z.array(z.object({ runId: WorkflowRunIdV1Schema,
    invocationRecordIds: z.array(WorkflowInvocationRecordIdSchema),
  }).strict()).optional(),
  sourceArtifactId: WorkflowDefinitionIdV1Schema.optional(),
  origin: z.enum(['automation', 'direct']).optional(),
  states: z.array(WorkflowRunStateV1Schema).min(1).optional(),
  attention: WorkflowRunAttentionFilterV1Schema.optional(),
  originSessionId: preservedBoundedNfcString(191, 'Session ids').optional(),
  targetSessionId: preservedBoundedNfcString(191, 'Session ids').optional(),
  automationId: preservedBoundedNfcString(191, 'Automation ids').optional(),
  machineId: WorkflowMachineIdV1Schema.optional(),
}).strict());
export const WorkflowRunPrivateMetadataV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('available'), value: WorkflowDefinitionMetadataV1Schema }).strict(),
  z.object({ kind: z.literal('unavailable'), reason: WorkflowOperationErrorCodeV1Schema }).strict(),
]));
export type WorkflowRunPrivateMetadataV1 = z.infer<typeof WorkflowRunPrivateMetadataV1Schema>;
export const WorkflowRunListResultV1Schema = lazyZodSchema(() => z.object({
  runs: z.array(WorkflowRunSummaryV1Schema),
  /** Account-private metadata opened from the accepted snapshots for this page. */
  metadataByRunId: z.record(z.string(), WorkflowRunPrivateMetadataV1Schema),
  /** Only requested private display facts; no invocation history, output or recovery content. */
  invocationProvenance: z.array(z.object({ index: WorkflowRunInvocationIndexV1Schema,
    stepOrdinal: WorkflowDecimalV1Schema.optional(),
    notificationCondition: WorkflowNotificationConditionV1Schema.optional(),
  }).strict()).optional(),
  nextCursor: CursorSchema.optional(),
}).strict().superRefine((value, context) => {
  const pageRunIds = new Set(value.runs.map((run) => run.id));
  for (const [index, fact] of (value.invocationProvenance ?? []).entries()) {
    if (!pageRunIds.has(fact.index.runId)) context.addIssue({ code: z.ZodIssueCode.custom,
      path: ['invocationProvenance', index], message: 'Provenance must belong to a Run in the same page' });
  }
  for (const runId of Object.keys(value.metadataByRunId)) {
    if (!pageRunIds.has(runId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['metadataByRunId', runId],
        message: 'Workflow Run metadata must belong to a Run in the same page',
      });
    }
  }
}));
export const WorkflowRunGetRequestV1Schema = lazyZodSchema(() => z.object({ runId: WorkflowRunIdV1Schema }).strict());
export const WorkflowRunSummariesRequestV1Schema = lazyZodSchema(() => z.object({
  sourceArtifactIds: z.array(WorkflowDefinitionIdV1Schema).superRefine((ids, context) => {
    if (new Set(ids).size !== ids.length) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Duplicate source artifacts' });
  }),
  recent: PositivePagePreferenceSchema,
}).strict());
const WorkflowRunRecentSummaryV1Schema = lazyZodSchema(() => z.object({ runId: WorkflowRunIdV1Schema, state: WorkflowRunStateV1Schema }).strict());
export const WorkflowRunSummariesResultV1Schema = lazyZodSchema(() => z.object({
  summaries: z.array(z.object({
    sourceArtifactId: WorkflowDefinitionIdV1Schema,
    lastRun: WorkflowRunRecentSummaryV1Schema.extend({ createdAt: z.string().datetime(), finishedAt: z.string().datetime().nullable() }).strict().nullable(),
    recent: z.array(WorkflowRunRecentSummaryV1Schema),
    needsYouCount: z.number().int().nonnegative().safe(),
    needsYouRunId: WorkflowRunIdV1Schema.nullable(),
  }).strict()),
  remainingSourceArtifactIds: z.array(WorkflowDefinitionIdV1Schema),
}).strict());
export type WorkflowRunSummariesResultV1 = z.infer<typeof WorkflowRunSummariesResultV1Schema>;
const WorkflowRunAcceptedAutomationSourceV1Schema = lazyZodSchema(() => z.object({
  kind: z.literal('automation'),
  automationId: preservedBoundedNfcString(191, 'Automation ids'),
  definitionId: WorkflowDefinitionIdV1Schema.optional(),
  revision: WorkflowArtifactRevisionV1Schema.optional(),
  savedBy: WorkflowDefinitionSavedByV1Schema.nullable().optional(),
}).strict());
export const WorkflowRunAcceptedContextV1Schema = lazyZodSchema(() => z.union([
  z.object({
    startedBy: WorkflowRunStartedByV1Schema,
    source: WorkflowRunAcceptedAutomationSourceV1Schema,
    metadata: WorkflowDefinitionMetadataV1Schema.optional(),
    inputs: WorkflowInputsV1Schema,
    machineId: WorkflowMachineIdV1Schema,
    executionTarget: WorkflowRunExecutionTargetV1Schema,
    roleOverrides: WorkflowRoleOverridesV1Schema.optional(),
    materializedLeaves: z.array(WorkflowMaterializedLeafV1Schema),
    frozenChildren: WorkflowFrozenChildrenV1Schema,
    workspaceTarget: WorkflowAcceptedWorkspaceTargetV1Schema,
  }).strict(),
  z.object({
    startedBy: WorkflowRunStartedByV1Schema,
    source: z.discriminatedUnion('kind', [
      WorkflowRunAcceptedAutomationSourceV1Schema,
      WorkflowAcceptedInlineSourceV1Schema,
      z.object({ kind: z.literal('saved'), definitionId: WorkflowDefinitionIdV1Schema, revision: WorkflowArtifactRevisionV1Schema,
        savedBy: WorkflowDefinitionSavedByV1Schema.nullable() }).strict(),
      z.object({ kind: z.literal('catalog'), ref: WorkflowDefinitionRefV1StringSchema,
        version: z.union([z.number().int().nonnegative().safe(), z.string().min(1)]) }).strict(),
    ]),
    metadata: WorkflowDefinitionMetadataV1Schema.optional(),
    inputs: WorkflowInputsV1Schema,
    machineId: WorkflowMachineIdV1Schema,
    executionTarget: WorkflowRunExecutionTargetV1Schema,
    roleOverrides: WorkflowRoleOverridesV1Schema.optional(),
    materializedLeaves: z.array(WorkflowMaterializedLeafV1Schema),
    frozenChildren: WorkflowFrozenChildrenV1Schema,
    workspaceTarget: WorkflowAcceptedWorkspaceTargetV1Schema,
    origin: z.object({
      kind: z.literal('direct'),
      originSessionId: preservedBoundedNfcString(191, 'Session ids').optional(),
    }).strict(),
  }).strict(),
]).superRefine((value, context) => {
  if (value.workspaceTarget.project.machineId !== value.machineId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['workspaceTarget', 'project', 'machineId'],
      message: 'Project workspace must use the immutable Run Machine',
    });
  }
}));
export type WorkflowRunAcceptedContextV1 = z.infer<typeof WorkflowRunAcceptedContextV1Schema>;
export const WorkflowRunGetResultV1Schema = lazyZodSchema(() => z.object({
  run: WorkflowRunSummaryV1Schema,
  /** Effective caller capabilities from the server's live Run access owner. */
  callerAccess: z.object({ canEdit: z.boolean() }).strict(),
  definition: WorkflowDefinitionV1Schema,
  acceptedContext: WorkflowRunAcceptedContextV1Schema,
  /** Authenticated authored source before role/selection materialization; used for semantic rejoin. */
  authoredDefinition: WorkflowDefinitionV1Schema,
  checkpoint: WorkflowCheckpointEnvelopeV1Schema.nullable(),
  result: StrictJsonValueSchema.optional(), usage: WorkflowUsageV1Schema.optional(),
  /** Authenticated exact producer record of `result`; neither field exists without the other. */
  finalOutputInvocationId: WorkflowInvocationRecordIdSchema.optional(),
}).strict().superRefine((value, context) => {
  const hasResult = value.result !== undefined;
  const hasProducer = value.finalOutputInvocationId !== undefined;
  if (hasResult === hasProducer) return;
  context.addIssue({
    code: z.ZodIssueCode.custom,
    path: [hasResult ? 'finalOutputInvocationId' : 'result'],
    message: hasResult
      ? 'Workflow Run result requires its exact producer invocation'
      : 'Workflow Run producer invocation requires a result',
  });
}));
export const WorkflowRunWaitConditionV1Schema = lazyZodSchema(() => z.enum(['terminal', 'attention', 'paused']));
export const WorkflowRunWaitConditionsV1Schema = lazyZodSchema(() => z.array(WorkflowRunWaitConditionV1Schema).min(1)
  .refine(conditions => new Set(conditions).size === conditions.length, 'Wait conditions must be unique'));
export const WorkflowRunWaitRequestV1Schema = lazyZodSchema(() => z.object({
  runId: WorkflowRunIdV1Schema,
  conditions: WorkflowRunWaitConditionsV1Schema.optional(),
  timeoutSeconds: z.number().positive().safe().optional(),
}).strict());
/** Passive host sink: public summary only, including the canonical attention projection. */
export const WorkflowRunWaitSnapshotV1Schema = lazyZodSchema(() => z.object({ run: WorkflowRunSummaryV1Schema }).strict());
const WorkflowRunWaitResultBaseV1Schema = lazyZodSchema(() => z.object({
  run: WorkflowRunSummaryV1Schema, result: StrictJsonValueSchema.optional(),
}).strict());
export const WorkflowRunWaitResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('observation', [
  WorkflowRunWaitResultBaseV1Schema.extend({ observation: z.literal('terminal'), matchedCondition: z.literal('terminal') }).strict(),
  WorkflowRunWaitResultBaseV1Schema.extend({ observation: z.literal('paused'), matchedCondition: z.literal('paused') }).strict(),
  WorkflowRunWaitResultBaseV1Schema.extend({ observation: z.literal('needs_attention'), matchedCondition: z.literal('attention') }).strict(),
  WorkflowRunWaitResultBaseV1Schema.extend({ observation: z.literal('timeout') }).strict(),
  WorkflowRunWaitResultBaseV1Schema.extend({ observation: z.literal('not_matched_terminal') }).strict(),
]));
export const WorkflowRunPauseRequestV1Schema = lazyZodSchema(() => z.object({ runId: WorkflowRunIdV1Schema, expectedRevision: RevisionSchema }).strict());
export const WorkflowRunCancelRequestV1Schema = WorkflowRunPauseRequestV1Schema;
export const WorkflowRunControlResultV1Schema = lazyZodSchema(() => z.object({
  run: WorkflowRunSummaryV1Schema,
  intent: z.enum(['pause_requested', 'paused', 'resumed', 'recovery_required', 'unavailable', 'cancel_requested', 'cancelled']),
}).strict());

export const WorkflowInvocationListRequestV1Schema = lazyZodSchema(() => z.object({
  runId: WorkflowRunIdV1Schema, cursor: CursorSchema.optional(), limit: PositivePagePreferenceSchema.optional(),
  parentRecordId: WorkflowInvocationRecordIdSchema.optional(),
  lifecycles: z.array(WorkflowInvocationLifecycleV1Schema).min(1).optional(),
  /** Open private progress beside the same history page, without individual detail reads. */
  includeContent: z.boolean().optional(),
}).strict().superRefine((value, context) => {
  if (value.includeContent === true && value.parentRecordId !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['includeContent'],
      message: 'Invocation content is available on history pages only' });
  }
}));
export const WorkflowInvocationListResultV1Schema = lazyZodSchema(() => z.object({
  invocations: z.array(WorkflowRunInvocationIndexV1Schema), nextCursor: CursorSchema.optional(), parentRevision: RevisionSchema,
  /** Present only when requested; one opened detail for each index on this page. */
  invocationDetails: z.array(WorkflowInvocationDetailV1Schema).optional(),
}).strict());
export const WorkflowInvocationGetRequestV1Schema = lazyZodSchema(() => z.object({ runId: WorkflowRunIdV1Schema, invocationId: WorkflowInvocationRecordIdSchema }).strict());
export const WorkflowInvocationGetResultV1Schema = lazyZodSchema(() => z.object({ invocation: WorkflowInvocationDetailV1Schema }).strict());
export const WorkflowInvocationRetryResultV1Schema = lazyZodSchema(() => z.object({
  run: WorkflowRunSummaryV1Schema, invocation: WorkflowRunInvocationIndexV1Schema,
  disposition: z.enum(['accepted', 'ineligible', 'conflict']),
}).strict());
const WorkflowReviewTargetV1Shape = {
  runId: WorkflowRunIdV1Schema,
  invocation: WorkflowInvocationRefV1Schema,
  expectedContentRevision: WorkflowDecimalV1Schema,
};
export const WorkflowInvocationPublishDraftRequestV1Schema = lazyZodSchema(() => z.object({
  ...WorkflowReviewTargetV1Shape, value: StrictJsonValueSchema,
}).strict());
export const WorkflowInvocationPublishDraftResultV1Schema = WorkflowInvocationGetResultV1Schema;
export const WorkflowInvocationCompleteReviewRequestV1Schema = lazyZodSchema(() => z.discriminatedUnion('mode', [
  z.object({ ...WorkflowReviewTargetV1Shape, mode: z.literal('use_result'),
    value: StrictJsonValueSchema.optional(), followUp: WorkflowReviewFollowUpV1Schema.optional() }).strict(),
  z.object({ ...WorkflowReviewTargetV1Shape, mode: z.literal('generate'),
    acknowledgeUncertainPriorEffects: z.literal(true).optional() }).strict(),
]));
export const WorkflowInvocationCompleteReviewResultV1Schema = lazyZodSchema(() => z.object({
  run: WorkflowRunSummaryV1Schema, invocation: WorkflowRunInvocationIndexV1Schema,
  disposition: z.enum(['completed', 'generation_requested']),
}).strict());
export const WorkflowRunDeleteRequestV1Schema = WorkflowRunPauseRequestV1Schema;
export const WorkflowRunDeleteResultV1Schema = lazyZodSchema(() => z.object({ deleted: z.literal(true), runId: WorkflowRunIdV1Schema }).strict());

export const WorkflowDefinitionListRequestV1Schema = lazyZodSchema(() => z.object({ cursor: CursorSchema.optional(), limit: PositivePagePreferenceSchema.optional() }).strict());
const WorkflowDefinitionLibraryHeaderV1Schema = lazyZodSchema(() => WorkflowDefinitionArtifactHeaderV1Schema.extend({
  ownerAccountId: z.string().min(1).optional(), access: ArtifactCallerAccessV1Schema.optional(),
  /** Opened owner-private provenance, never attribution from the stored shared header. */
  savedBy: WorkflowDefinitionSavedByV1Schema.optional(),
  triggers: z.array(WorkflowTriggerSummaryInputV1Schema),
  /** Earliest enabled occurrence supplied by the Automation scheduler, never calculated by a reader. */
  nextRunAt: z.number().int().nonnegative().safe().nullable(),
}).strict());
export const WorkflowDefinitionListResultV1Schema = lazyZodSchema(() => z.object({ definitions: z.array(z.discriminatedUnion('contentStatus', [
  WorkflowDefinitionLibraryHeaderV1Schema.extend({ contentStatus: z.literal('available'), stepCount: z.number().int().nonnegative().safe(), destinations: WorkflowDestinationsV1Schema.optional() }).strict(),
  WorkflowDefinitionLibraryHeaderV1Schema.extend({ contentStatus: z.literal('unavailable'), stepCount: z.null(),
    revision: WorkflowArtifactRevisionV1Schema.nullable(), metadata: WorkflowDefinitionMetadataV1Schema.nullable(),
    contentUnavailableReason: WorkflowDefinitionContentUnavailableReasonV1Schema }).strict(),
])), pluginWorkflows: z.array(WorkflowPluginSourceV1Schema).optional(), nextCursor: CursorSchema.optional() }).strict());
export const WorkflowDefinitionGetRequestV1Schema = lazyZodSchema(() => z.object({ definitionId: WorkflowDefinitionIdV1Schema }).strict());
export const WorkflowDefinitionGetResultV1Schema = lazyZodSchema(() => z.object({ definitionId: WorkflowDefinitionIdV1Schema, revision: WorkflowArtifactRevisionV1Schema, definition: WorkflowDefinitionV1Schema, destinations: WorkflowDestinationsV1Schema.optional(), metadata: WorkflowDefinitionMetadataV1Schema, access: ArtifactCallerAccessV1Schema, savedBy: WorkflowDefinitionSavedByV1Schema.optional() }).strict());
export const WorkflowDefinitionCreateRequestV1Schema = lazyZodSchema(() => z.object({ definitionId: WorkflowDefinitionIdV1Schema, definition: WorkflowIngressCarrierV1Schema, metadata: WorkflowDefinitionMetadataV1Schema }).strict());
export const WorkflowDefinitionCreateResultV1Schema = WorkflowDefinitionGetResultV1Schema;
export const WorkflowDefinitionUpdateRequestV1Schema = lazyZodSchema(() => z.object({ definitionId: WorkflowDefinitionIdV1Schema, expectedRevision: WorkflowArtifactRevisionV1Schema, definition: WorkflowIngressCarrierV1Schema, metadata: WorkflowDefinitionMetadataV1Schema }).strict());
export const WorkflowDefinitionUpdateResultV1Schema = WorkflowDefinitionGetResultV1Schema;
export const WorkflowDefinitionDeleteRequestV1Schema = lazyZodSchema(() => z.object({ definitionId: WorkflowDefinitionIdV1Schema }).strict());
export const WorkflowDefinitionDeleteResultV1Schema = lazyZodSchema(() => z.object({ deleted: z.literal(true), definitionId: WorkflowDefinitionIdV1Schema }).strict());
export const WorkflowDefinitionImportRequestV1Schema = lazyZodSchema(() => z.object({ json: z.string() }).strict());
export const WorkflowDefinitionImportResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), classification: z.literal('unsaved_definition'), document: WorkflowDocumentV1Schema }).strict(),
  WorkflowDocumentParseFailureV1Schema,
]));
export const WorkflowDefinitionExportRequestV1Schema = WorkflowDefinitionGetRequestV1Schema;
export const WorkflowDefinitionExportResultV1Schema = lazyZodSchema(() => z.object({
  definitionId: WorkflowDefinitionIdV1Schema, revision: WorkflowArtifactRevisionV1Schema,
  metadata: WorkflowDefinitionMetadataV1Schema, document: WorkflowDocumentV1Schema, json: z.string(),
}).strict());

export { WORKFLOW_ACTION_IDS_V1, type WorkflowActionIdV1 };

export const WorkflowActionInputSchemasV1 = {
  'workflow.validate': WorkflowValidateRequestV1Schema,
  'workflow.run.start': WorkflowRunStartRequestV1Schema,
  'workflow.run.list': WorkflowRunListRequestV1Schema,
  'workflow.run.summaries': WorkflowRunSummariesRequestV1Schema,
  'workflow.run.get': WorkflowRunGetRequestV1Schema,
  'workflow.run.wait': WorkflowRunWaitRequestV1Schema,
  'workflow.run.pause': WorkflowRunPauseRequestV1Schema,
  'workflow.run.resume': WorkflowResumeInputV1Schema,
  'workflow.run.cancel': WorkflowRunCancelRequestV1Schema,
  'workflow.run.invocations.list': WorkflowInvocationListRequestV1Schema,
  'workflow.run.invocations.get': WorkflowInvocationGetRequestV1Schema,
  'workflow.run.invocations.retry': WorkflowInvocationRetryInputV1Schema,
  'workflow.run.invocations.publish_draft': WorkflowInvocationPublishDraftRequestV1Schema,
  'workflow.run.invocations.complete_review': WorkflowInvocationCompleteReviewRequestV1Schema,
  'workflow.run.delete': WorkflowRunDeleteRequestV1Schema,
  'workflow.definition.list': WorkflowDefinitionListRequestV1Schema,
  'workflow.definition.get': WorkflowDefinitionGetRequestV1Schema,
  'workflow.definition.create': WorkflowDefinitionCreateRequestV1Schema,
  'workflow.definition.update': WorkflowDefinitionUpdateRequestV1Schema,
  'workflow.definition.edit': WorkflowDefinitionEditRequestV1Schema,
  'workflow.definition.delete': WorkflowDefinitionDeleteRequestV1Schema,
  'workflow.definition.import': WorkflowDefinitionImportRequestV1Schema,
  'workflow.definition.export': WorkflowDefinitionExportRequestV1Schema,
  'workflow.trigger.list': WorkflowTriggerListRequestV1Schema,
  'workflow.trigger.add': WorkflowTriggerAddRequestV1Schema,
  'workflow.trigger.update': WorkflowTriggerUpdateRequestV1Schema,
  'workflow.trigger.remove': WorkflowTriggerRemoveRequestV1Schema,
  'workflow.trigger.run_now': WorkflowTriggerRunNowRequestV1Schema,
  'session.trigger.list': SessionTriggerListRequestV1Schema,
  'session.trigger.add': SessionTriggerAddRequestV1Schema,
  'session.trigger.update': SessionTriggerUpdateRequestV1Schema,
  'session.trigger.remove': SessionTriggerRemoveRequestV1Schema,
} as const satisfies Record<WorkflowActionIdV1, z.ZodTypeAny>;

export const WorkflowActionOutputSchemasV1 = {
  'workflow.validate': WorkflowValidateResultV1Schema,
  'workflow.run.start': WorkflowRunStartResultV1Schema,
  'workflow.run.list': WorkflowRunListResultV1Schema,
  'workflow.run.summaries': WorkflowRunSummariesResultV1Schema,
  'workflow.run.get': WorkflowRunGetResultV1Schema,
  'workflow.run.wait': WorkflowRunWaitResultV1Schema,
  'workflow.run.pause': WorkflowRunControlResultV1Schema,
  'workflow.run.resume': WorkflowRunControlResultV1Schema,
  'workflow.run.cancel': WorkflowRunControlResultV1Schema,
  'workflow.run.invocations.list': WorkflowInvocationListResultV1Schema,
  'workflow.run.invocations.get': WorkflowInvocationGetResultV1Schema,
  'workflow.run.invocations.retry': WorkflowInvocationRetryResultV1Schema,
  'workflow.run.invocations.publish_draft': WorkflowInvocationPublishDraftResultV1Schema,
  'workflow.run.invocations.complete_review': WorkflowInvocationCompleteReviewResultV1Schema,
  'workflow.run.delete': WorkflowRunDeleteResultV1Schema,
  'workflow.definition.list': WorkflowDefinitionListResultV1Schema,
  'workflow.definition.get': WorkflowDefinitionGetResultV1Schema,
  'workflow.definition.create': WorkflowDefinitionCreateResultV1Schema,
  'workflow.definition.update': WorkflowDefinitionUpdateResultV1Schema,
  'workflow.definition.edit': WorkflowDefinitionEditResultV1Schema,
  'workflow.definition.delete': WorkflowDefinitionDeleteResultV1Schema,
  'workflow.definition.import': WorkflowDefinitionImportResultV1Schema,
  'workflow.definition.export': WorkflowDefinitionExportResultV1Schema,
  'workflow.trigger.list': WorkflowTriggerListResultV1Schema,
  'workflow.trigger.add': WorkflowTriggerWriteResultV1Schema,
  'workflow.trigger.update': WorkflowTriggerWriteResultV1Schema,
  'workflow.trigger.remove': WorkflowTriggerWriteResultV1Schema,
  'workflow.trigger.run_now': AutomationV3RunMutationResponseSchema,
  'session.trigger.list': SessionTriggerListResultV1Schema,
  'session.trigger.add': WorkflowTriggerWriteResultV1Schema,
  'session.trigger.update': WorkflowTriggerWriteResultV1Schema,
  'session.trigger.remove': WorkflowTriggerWriteResultV1Schema,
} as const satisfies Record<WorkflowActionIdV1, z.ZodTypeAny>;

export type WorkflowValidateRequestV1 = z.infer<typeof WorkflowValidateRequestV1Schema>;
export type WorkflowValidateResultV1 = z.infer<typeof WorkflowValidateResultV1Schema>;
export type WorkflowRunStartRequestV1 = z.infer<typeof WorkflowRunStartRequestV1Schema>;
export type WorkflowRunStartResultV1 = z.infer<typeof WorkflowRunStartResultV1Schema>;
export type WorkflowRunActionResultReferenceV1 = z.infer<typeof WorkflowRunActionResultReferenceV1Schema>;
export type WorkflowRunListRequestV1 = z.infer<typeof WorkflowRunListRequestV1Schema>;
export type WorkflowRunListResultV1 = z.infer<typeof WorkflowRunListResultV1Schema>;
export type WorkflowRunGetRequestV1 = z.infer<typeof WorkflowRunGetRequestV1Schema>;
export type WorkflowRunGetResultV1 = z.infer<typeof WorkflowRunGetResultV1Schema>;
export type WorkflowRunWaitRequestV1 = z.infer<typeof WorkflowRunWaitRequestV1Schema>;
export type WorkflowRunWaitConditionV1 = z.infer<typeof WorkflowRunWaitConditionV1Schema>;
export type WorkflowRunWaitSnapshotV1 = z.infer<typeof WorkflowRunWaitSnapshotV1Schema>;
export type WorkflowRunWaitResultV1 = z.infer<typeof WorkflowRunWaitResultV1Schema>;
export type WorkflowRunPauseRequestV1 = z.infer<typeof WorkflowRunPauseRequestV1Schema>;
export type WorkflowRunCancelRequestV1 = z.infer<typeof WorkflowRunCancelRequestV1Schema>;
export type WorkflowRunControlResultV1 = z.infer<typeof WorkflowRunControlResultV1Schema>;
export type WorkflowInvocationListRequestV1 = z.infer<typeof WorkflowInvocationListRequestV1Schema>;
export type WorkflowInvocationListResultV1 = z.infer<typeof WorkflowInvocationListResultV1Schema>;
export type WorkflowInvocationGetRequestV1 = z.infer<typeof WorkflowInvocationGetRequestV1Schema>;
export type WorkflowInvocationGetResultV1 = z.infer<typeof WorkflowInvocationGetResultV1Schema>;
export type WorkflowInvocationRetryResultV1 = z.infer<typeof WorkflowInvocationRetryResultV1Schema>;
export type WorkflowInvocationPublishDraftRequestV1 = z.infer<typeof WorkflowInvocationPublishDraftRequestV1Schema>;
export type WorkflowInvocationPublishDraftResultV1 = z.infer<typeof WorkflowInvocationPublishDraftResultV1Schema>;
export type WorkflowInvocationCompleteReviewRequestV1 = z.infer<typeof WorkflowInvocationCompleteReviewRequestV1Schema>;
export type WorkflowInvocationCompleteReviewResultV1 = z.infer<typeof WorkflowInvocationCompleteReviewResultV1Schema>;
export type WorkflowRunDeleteRequestV1 = z.infer<typeof WorkflowRunDeleteRequestV1Schema>;
export type WorkflowRunDeleteResultV1 = z.infer<typeof WorkflowRunDeleteResultV1Schema>;
export type WorkflowDefinitionListRequestV1 = z.infer<typeof WorkflowDefinitionListRequestV1Schema>;
export type WorkflowDefinitionListResultV1 = z.infer<typeof WorkflowDefinitionListResultV1Schema>;
export type WorkflowDefinitionGetRequestV1 = z.infer<typeof WorkflowDefinitionGetRequestV1Schema>;
export type WorkflowDefinitionGetResultV1 = z.infer<typeof WorkflowDefinitionGetResultV1Schema>;
export type WorkflowDefinitionCreateRequestV1 = z.infer<typeof WorkflowDefinitionCreateRequestV1Schema>;
export type WorkflowDefinitionCreateResultV1 = z.infer<typeof WorkflowDefinitionCreateResultV1Schema>;
export type WorkflowDefinitionUpdateRequestV1 = z.infer<typeof WorkflowDefinitionUpdateRequestV1Schema>;
export type WorkflowDefinitionUpdateResultV1 = z.infer<typeof WorkflowDefinitionUpdateResultV1Schema>;
export type WorkflowDefinitionDeleteRequestV1 = z.infer<typeof WorkflowDefinitionDeleteRequestV1Schema>;
export type WorkflowDefinitionDeleteResultV1 = z.infer<typeof WorkflowDefinitionDeleteResultV1Schema>;
export type WorkflowDefinitionImportRequestV1 = z.infer<typeof WorkflowDefinitionImportRequestV1Schema>;
export type WorkflowDefinitionImportResultV1 = z.infer<typeof WorkflowDefinitionImportResultV1Schema>;
export type WorkflowDefinitionExportRequestV1 = z.infer<typeof WorkflowDefinitionExportRequestV1Schema>;
export type WorkflowDefinitionExportResultV1 = z.infer<typeof WorkflowDefinitionExportResultV1Schema>;
import { ArtifactCallerAccessV1Schema } from '../artifacts/artifactAccessV1.js';
