import * as zMini from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';
import { WorkflowDestinationsV1Schema } from './workflowDestinationsV1.js';
import {
  WorkflowTriggerListRequestV1Schema, WorkflowTriggerAddRequestV1Schema,
  WorkflowTriggerUpdateRequestV1Schema, WorkflowTriggerRemoveRequestV1Schema,
  WorkflowTriggerRunNowRequestV1Schema,
  WorkflowTriggerListResultV1Schema, WorkflowTriggerWriteResultV1Schema, WorkflowTriggerRemoveResultV1Schema,
  SessionTriggerListRequestV1Schema, SessionTriggerAddRequestV1Schema,
  SessionTriggerUpdateRequestV1Schema, SessionTriggerRemoveRequestV1Schema, SessionTriggerListResultV1Schema,
  WorkflowTriggerSummaryInputV1Schema,
} from './triggers/workflowTriggerActionsV1.js';

import { OPAQUE_CURSOR_SCHEMA } from '../automations/automationActionSpecsV1.js';
import { AutomationV3RunMutationResponseSchema } from '../automations/automationApiV3.js';
import { AutomationIdV1Schema } from '../automations/automationIdV1.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
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
  WorkflowIngressSchema,
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
import { WorkflowDefinitionCaptureRequestV1Schema, WorkflowDefinitionCaptureResultV1Schema } from './workflowDiscussionCaptureV1.js';
export { WorkflowDefinitionCaptureRequestV1Schema, WorkflowDefinitionCaptureResultV1Schema } from './workflowDiscussionCaptureV1.js';
export type { WorkflowDefinitionCaptureRequestV1, WorkflowDefinitionCaptureResultV1 } from './workflowDiscussionCaptureV1.js';
import { WorkflowDocumentV1Schema, WorkflowDocumentParseFailureV1Schema } from './workflowDocumentSchemasV1.js';
import { WorkflowDefinitionRefV1StringSchema, parseWorkflowDefinitionRefV1 } from './workflowDefinitionRefV1.js';
import { WorkflowPluginSourceV1Schema } from './workflowPluginSourceContractV1.js';
import { DiscussionAddressV1Schema, DiscussionMessageIdSchema } from '../discussions/references.js';
import { WorkflowDiscussionOriginV1Schema, WorkflowRunOnCompleteV1Schema, WorkflowDiscussionResultDeliveryV1Schema } from './workflowDestinationsV1.js';
export { WorkflowDefinitionEditRequestV1Schema, WorkflowDefinitionEditResultV1Schema } from './workflowDefinitionEditV1.js';

const CursorSchema = OPAQUE_CURSOR_SCHEMA;
// Artifact cursors encode a JSON object as base64url (starting `ey`). The
// reserved phase belongs to the same list, after its Account Artifact pages.
export const WORKFLOW_DEFINITION_PLUGIN_CURSOR_PREFIX_V1 = 'plugin-workflows_';
export function workflowDefinitionListCursorPhaseV1(cursor: string | null | undefined): 'artifacts' | 'plugins-start' | 'plugins-more' {
  if (cursor === `${WORKFLOW_DEFINITION_PLUGIN_CURSOR_PREFIX_V1}0`) return 'plugins-start';
  return cursor?.startsWith(WORKFLOW_DEFINITION_PLUGIN_CURSOR_PREFIX_V1) ? 'plugins-more' : 'artifacts';
}
const PositivePagePreferenceSchema = lazyZodSchema(() => z.number().check(z.int(), z.positive(), z.int()));
const RevisionSchema = lazyZodSchema(() => z.number().check(z.int(), z.nonnegative(), z.int()));
/**
 * Action transport carries authored ingress to the one workflow normalizer.
 * Keeping the carrier non-recursive prevents the generic Zod boundary from
 * overflowing before that owner can return path-addressed typed issues.
 */
const WorkflowIngressCarrierV1Schema = lazyZodSchema(() => {
  const schema = z.strictObject({
    version: z.optional(z.literal(1)),
    inputs: z.optional(z.array(z.unknown())),
    defaults: z.optional(z.unknown()),
    roles: z.optional(z.unknown()),
    blocks: z.array(z.unknown()).check(z.minLength(1)),
    finalOutput: z.optional(z.unknown()),
  });
  // Transport remains shallow so the iterative validator owns deep diagnostics.
  // Discovery describes that owner's authored grammar, including recursive
  // blocks and shorthand, rather than advertising its transport placeholders.
  schema._zod.processJSONSchema = (context, _json, params) => {
    z.core.process(WorkflowIngressSchema, context, params);
    context.seen.get(schema)!.ref = WorkflowIngressSchema;
  };
  return schema;
});
const WorkflowInputsV1Schema = lazyZodSchema(() => z.record(z.string(), StrictJsonValueSchema).check(z.superRefine((inputs, context) => {
    for (const inputName of Object.keys(inputs)) {
      if (!WorkflowInputNameSchema.safeParse(inputName).success) {
        context.addIssue({
          code: "custom",
          path: [inputName],
          message: 'Invalid Workflow input name',
        });
      }
    }
  })));

export const WorkflowValidateRequestV1Schema = lazyZodSchema(() => z.strictObject({
  definition: WorkflowIngressCarrierV1Schema,
  inputs: z.optional(WorkflowInputsV1Schema),
  target: z.optional(z.strictObject({ machineId: WorkflowMachineIdV1Schema })),
}));
export const WorkflowValidateResultV1Schema = lazyZodSchema(() => z.strictObject({
  valid: z.boolean(), normalizedDefinition: zMini.optional(WorkflowDefinitionV1Schema),
  issues: z.array(WorkflowValidationIssueV1Schema),
  targetValidation: z.enum(['not_requested', 'checked', 'unavailable']),
}));

export const WorkflowRunSourceV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  (<T extends zMini.ZodMiniObject>(schema: T) => zMini.core.clone(schema, { ...schema._zod.def, catchall: zMini.never() }) as zMini.ZodMiniObject<T['shape'], zMini.core.$strict>)(zMini.extend(WorkflowAcceptedInlineSourceV1Schema, { definition: WorkflowIngressCarrierV1Schema,
    visibleTeamId: zMini.optional(preservedBoundedNfcString(191, 'Team ids')),
    /** Replay reopens this Run at the owner; the reviewed carrier cannot replace its frozen graph. */
    replay: z.optional(z.strictObject({ runId: WorkflowRunIdV1Schema,
      /** Explicit new-run continuation; the owner reads prior outcomes into the declared previousRoundContext input. */
      intent: z.optional(z.literal('another_round')),
      agentOverride: zMini.optional(WorkflowReplayAgentOverrideV1Schema) })),
  })).check(zMini.superRefine((source, context) => {
    if (source.visibleTeamId !== undefined && source.sourceArtifactId === undefined) {
      context.addIssue({ code: 'custom', path: ['visibleTeamId'], message: 'Team visibility requires an Artifact source binding' });
    }
    if (source.replay && (source.sourceArtifactId !== undefined || source.visibleTeamId !== undefined)) {
      context.addIssue({ code: 'custom', path: ['replay'], message: 'Replay retains the accepted source and Team visibility' });
    }
    if (source.replay?.intent === 'another_round' && source.replay.agentOverride !== undefined) {
      context.addIssue({ code: 'custom', path: ['replay', 'agentOverride'], message: 'Another round retains every accepted participant' });
    }
  })),
  z.strictObject({ kind: z.literal('saved'), definitionId: WorkflowDefinitionIdV1Schema, revision: WorkflowArtifactRevisionV1Schema,
    visibleTeamId: zMini.optional(preservedBoundedNfcString(191, 'Team ids')) }),
  z.strictObject({ kind: z.literal('catalog'), workflow: WorkflowDefinitionRefV1StringSchema.check(zMini.refine((ref) => parseWorkflowDefinitionRefV1(ref)?.kind !== 'artifact', 'Catalog sources must name a built-in or plugin workflow')), pluginVersion: z.optional(z.string().check(z.minLength(1))) }),
]));
export const WorkflowRunStartRequestV1Schema = lazyZodSchema(() => z.strictObject({
  runId: WorkflowDirectRunAdmissionIdV1Schema,
  source: WorkflowRunSourceV1Schema,
  /** Optional authored display metadata; admission freezes its absence as null. */
  metadata: zMini.optional(WorkflowDefinitionMetadataV1Schema),
  inputs: z.optional(WorkflowInputsV1Schema),
  executionTarget: zMini.optional(WorkflowRunExecutionTargetV1Schema),
  roleOverrides: zMini.optional(WorkflowRoleOverridesV1Schema),
  origin: z.optional(z.strictObject({ kind: z.literal('discussion'), discussion: DiscussionAddressV1Schema,
    addressingMessageId: DiscussionMessageIdSchema })),
  onComplete: z.optional(WorkflowRunOnCompleteV1Schema),
}));
export const WorkflowRunStartResultV1Schema = lazyZodSchema(() => z.strictObject({
  run: WorkflowRunSummaryV1Schema,
  admission: z.enum(['created', 'existing']),
}));
export const WorkflowRunActionResultReferenceV1Schema = lazyZodSchema(() => z.strictObject({
  runId: WorkflowRunIdV1Schema,
  origin: WorkflowRunOriginV1Schema,
}));

const WorkflowRunStartActionSuccessEnvelopeV1Schema = lazyZodSchema(() => z.strictObject({
  ok: z.literal(true),
  result: WorkflowRunStartResultV1Schema,
}));

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
export const WorkflowRunListRequestV1Schema = lazyZodSchema(() => z.strictObject({
  cursor: zMini.optional(CursorSchema), limit: z.optional(PositivePagePreferenceSchema),
  /** Public attention membership only; private facts are opened when a surface demands them. */
  projection: z.optional(z.literal('membership')),
  /**
   * Exact-Run selection for background refresh and transcript initial
   * materialization. The page stays the lean list projection — Run summaries
   * plus the sparse accepted-metadata sidecar — with zero or one rows and no
   * usage, checkpoint, definition or invocation reads. Explicit Run detail
   * keeps `workflow.run.get`.
   */
  runId: zMini.optional(WorkflowRunIdV1Schema),
  /** Exact transcript references, batched at the Run-list owner rather than read by each message. */
  runIds: z.optional(z.array(WorkflowRunIdV1Schema)),
  invocationProvenance: z.optional(z.array(z.strictObject({ runId: WorkflowRunIdV1Schema,
    invocationRecordIds: z.array(WorkflowInvocationRecordIdSchema),
  }))),
  sourceArtifactId: zMini.optional(WorkflowDefinitionIdV1Schema),
  origin: z.optional(z.enum(['automation', 'direct'])),
  states: z.optional(z.array(WorkflowRunStateV1Schema).check(z.minLength(1))),
  attention: z.optional(WorkflowRunAttentionFilterV1Schema),
  originSessionId: zMini.optional(preservedBoundedNfcString(191, 'Session ids')),
  /** Private accepted-origin filter; the Action owner opens authorized pages before matching. */
  originDiscussionId: z.optional(DiscussionAddressV1Schema.shape.discussionId),
  targetSessionId: zMini.optional(preservedBoundedNfcString(191, 'Session ids')),
  /** Server-proved root and readable descendants of this managed Session. */
  underSessionId: zMini.optional(preservedBoundedNfcString(191, 'Session ids')),
  automationId: zMini.optional(asProtocolZod(AutomationIdV1Schema)),
  machineId: zMini.optional(WorkflowMachineIdV1Schema),
}).check(z.superRefine((value, context) => {
  if (value.projection !== 'membership') return;
  if (value.attention !== 'required') context.addIssue({ code: 'custom', path: ['attention'], message: 'Membership requires attention selection' });
  for (const key of ['originDiscussionId', 'targetSessionId', 'underSessionId', 'invocationProvenance'] as const) {
    if (value[key] !== undefined) context.addIssue({ code: 'custom', path: [key], message: 'Membership cannot select private facts' });
  }
})));
export const WorkflowRunPrivateMetadataV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('available'), value: WorkflowDefinitionMetadataV1Schema }),
  z.strictObject({ kind: z.literal('unavailable'), reason: WorkflowOperationErrorCodeV1Schema }),
]));
export type WorkflowRunPrivateMetadataV1 = z.infer<typeof WorkflowRunPrivateMetadataV1Schema>;
export const WorkflowRunCallerAccessV1Schema = lazyZodSchema(() => z.strictObject({ canEdit: z.boolean() }));
export const WorkflowRunListResultV1Schema = lazyZodSchema(() => z.strictObject({
  runs: z.array(WorkflowRunSummaryV1Schema),
  /** Absent means the existing complete private list projection, including readable untitled Runs. */
  projection: z.optional(z.literal('membership')),
  /** Private authored support opened with the page; this grants no start/control authority. */
  supportsAnotherRoundByRunId: z.optional(z.record(z.string(), z.boolean())),
  callerAccessByRunId: z.optional(z.record(z.string(), WorkflowRunCallerAccessV1Schema)),
  /** Account-private metadata opened from the accepted snapshots for this page. */
  metadataByRunId: z.record(z.string(), WorkflowRunPrivateMetadataV1Schema),
  /** Only requested private display facts; no invocation history, output or recovery content. */
  invocationProvenance: z.optional(z.array(z.strictObject({ index: WorkflowRunInvocationIndexV1Schema,
    stepOrdinal: zMini.optional(WorkflowDecimalV1Schema),
    notificationCondition: zMini.optional(WorkflowNotificationConditionV1Schema),
  }))),
  nextCursor: zMini.optional(CursorSchema),
}).check(z.superRefine((value, context) => {
  if (value.projection === 'membership') {
    if (Object.keys(value.metadataByRunId).length > 0 || Object.keys(value.supportsAnotherRoundByRunId ?? {}).length > 0
      || Object.keys(value.callerAccessByRunId ?? {}).length > 0 || (value.invocationProvenance?.length ?? 0) > 0) {
      context.addIssue({ code: 'custom', message: 'Membership does not carry private sidecars' });
    }
    for (const [index, run] of value.runs.entries()) {
      for (const key of ['where', 'startedBy', 'heldStep', 'stepProgress', 'stepProgressCurrentness'] as const) {
        if (run[key] !== undefined) context.addIssue({ code: 'custom', path: ['runs', index, key], message: 'Membership does not carry opened private facts' });
      }
    }
  }
  const pageRunIds = new Set(value.runs.map((run) => run.id));
  for (const [index, fact] of (value.invocationProvenance ?? []).entries()) {
    if (!pageRunIds.has(fact.index.runId)) context.addIssue({ code: "custom",
      path: ['invocationProvenance', index], message: 'Provenance must belong to a Run in the same page' });
  }
  for (const runId of Object.keys(value.metadataByRunId)) {
    if (!pageRunIds.has(runId)) {
      context.addIssue({
        code: "custom",
        path: ['metadataByRunId', runId],
        message: 'Workflow Run metadata must belong to a Run in the same page',
      });
    }
  }
  for (const runId of Object.keys(value.supportsAnotherRoundByRunId ?? {})) {
    if (!pageRunIds.has(runId)) context.addIssue({ code: 'custom', path: ['supportsAnotherRoundByRunId', runId],
      message: 'Continuation support must belong to a Run in the same page' });
  }
  for (const runId of Object.keys(value.callerAccessByRunId ?? {})) {
    if (!pageRunIds.has(runId)) context.addIssue({ code: 'custom', path: ['callerAccessByRunId', runId],
      message: 'Caller access must belong to a Run in the same page' });
  }
})));
export const WorkflowRunGetRequestV1Schema = lazyZodSchema(() => z.strictObject({
  runId: WorkflowRunIdV1Schema,
  /** Scope readers need the accepted frame, without opening usage history. */
  includeUsage: z.optional(z.boolean()),
}));
export const WorkflowRunReadStateSetRequestV1Schema = lazyZodSchema(() => z.strictObject({
  runId: WorkflowRunIdV1Schema,
  revision: z.number().check(z.int(), z.nonnegative()),
  failedAt: z.string().check(z.iso.datetime()),
}));
export const WorkflowRunReadStateSetResultV1Schema = lazyZodSchema(() => z.strictObject({
  runId: WorkflowRunIdV1Schema,
  attentionSeenFailureAt: z.nullable(z.string().check(z.iso.datetime())),
}));
export const WorkflowRunSourceSummariesRequestV1Schema = lazyZodSchema(() => z.strictObject({
  sourceArtifactIds: z.array(WorkflowDefinitionIdV1Schema).check(z.superRefine((ids, context) => {
    if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", message: 'Duplicate source artifacts' });
  })),
  recent: PositivePagePreferenceSchema,
}));
export const WorkflowRunAutomationSummariesRequestV1Schema = lazyZodSchema(() => z.strictObject({
  automationIds: z.array(asProtocolZod(AutomationIdV1Schema)).check(z.superRefine((ids, context) => {
    if (new Set(ids).size !== ids.length) context.addIssue({ code: 'custom', message: 'Duplicate Automations' });
  })),
}));
export const WorkflowRunSummariesRequestV1Schema = lazyZodSchema(() => z.union([
  WorkflowRunSourceSummariesRequestV1Schema, WorkflowRunAutomationSummariesRequestV1Schema,
]));
export type WorkflowRunSummariesRequestV1 = z.infer<typeof WorkflowRunSummariesRequestV1Schema>;
const WorkflowRunRecentSummaryV1Schema = lazyZodSchema(() => z.strictObject({
  runId: WorkflowRunIdV1Schema, state: WorkflowRunStateV1Schema,
  workflowCustodyState: WorkflowRunSummaryV1Schema.shape.workflowCustodyState,
  attentionRequired: z.boolean(), failureUnseen: z.boolean(), invocationAttentionRequired: z.boolean(),
}));
export const WorkflowRunSourceSummariesResultV1Schema = lazyZodSchema(() => z.strictObject({
  summaries: z.array(z.strictObject({
    sourceArtifactId: WorkflowDefinitionIdV1Schema,
    lastRun: z.nullable((<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(WorkflowRunRecentSummaryV1Schema, { createdAt: z.string().check(z.iso.datetime()), startedAt: z.string().check(z.iso.datetime()), finishedAt: z.nullable(z.string().check(z.iso.datetime())) }))),
    recent: z.array(WorkflowRunRecentSummaryV1Schema),
    needsYouCount: z.number().check(z.int(), z.nonnegative(), z.int()),
    needsYouRunId: zMini.nullable(WorkflowRunIdV1Schema),
  })),
  remainingSourceArtifactIds: z.array(WorkflowDefinitionIdV1Schema),
}));
export type WorkflowRunSourceSummariesResultV1 = z.infer<typeof WorkflowRunSourceSummariesResultV1Schema>;
export const WorkflowRunAutomationSummariesResultV1Schema = lazyZodSchema(() => z.strictObject({
  automationSummaries: z.array(z.strictObject({
    automationId: asProtocolZod(AutomationIdV1Schema),
    lastRun: z.nullable(z.strictObject({
      id: WorkflowRunIdV1Schema,
      state: WorkflowRunStateV1Schema,
      workflowCustodyState: WorkflowRunSummaryV1Schema.shape.workflowCustodyState,
      attentionRequired: z.boolean(),
      failureUnseen: z.boolean(),
      invocationAttentionRequired: z.boolean(),
      createdAt: z.string().check(z.iso.datetime()),
      startedAt: z.string().check(z.iso.datetime()),
    })),
  })),
  remainingAutomationIds: z.array(asProtocolZod(AutomationIdV1Schema)),
}));
export type WorkflowRunAutomationSummariesResultV1 = z.infer<typeof WorkflowRunAutomationSummariesResultV1Schema>;
export const WorkflowRunSummariesResultV1Schema = lazyZodSchema(() => z.union([
  WorkflowRunSourceSummariesResultV1Schema, WorkflowRunAutomationSummariesResultV1Schema,
]));
export type WorkflowRunSummariesResultV1 = z.infer<typeof WorkflowRunSummariesResultV1Schema>;
const WorkflowRunAcceptedAutomationSourceV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('automation'),
  automationId: asProtocolZod(AutomationIdV1Schema),
  definitionId: zMini.optional(WorkflowDefinitionIdV1Schema),
  revision: zMini.optional(WorkflowArtifactRevisionV1Schema),
  savedBy: zMini.optional(zMini.nullable(WorkflowDefinitionSavedByV1Schema)),
}));
export const WorkflowRunAcceptedContextV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({
    startedBy: WorkflowRunStartedByV1Schema,
    source: WorkflowRunAcceptedAutomationSourceV1Schema,
    metadata: zMini.optional(WorkflowDefinitionMetadataV1Schema),
    inputs: WorkflowInputsV1Schema,
    machineId: WorkflowMachineIdV1Schema,
    executionTarget: WorkflowRunExecutionTargetV1Schema,
    roleOverrides: zMini.optional(WorkflowRoleOverridesV1Schema),
    materializedLeaves: z.array(WorkflowMaterializedLeafV1Schema),
    frozenChildren: WorkflowFrozenChildrenV1Schema,
    workspaceTarget: WorkflowAcceptedWorkspaceTargetV1Schema,
  }),
  z.strictObject({
    startedBy: WorkflowRunStartedByV1Schema,
    source: z.discriminatedUnion('kind', [
      WorkflowRunAcceptedAutomationSourceV1Schema,
      WorkflowAcceptedInlineSourceV1Schema,
      z.strictObject({ kind: z.literal('saved'), definitionId: WorkflowDefinitionIdV1Schema, revision: WorkflowArtifactRevisionV1Schema,
        savedBy: zMini.nullable(WorkflowDefinitionSavedByV1Schema) }),
      z.strictObject({ kind: z.literal('catalog'), ref: WorkflowDefinitionRefV1StringSchema,
        version: z.union([z.number().check(z.int(), z.nonnegative(), z.int()), z.string().check(z.minLength(1))]) }),
    ]),
    metadata: zMini.optional(WorkflowDefinitionMetadataV1Schema),
    inputs: WorkflowInputsV1Schema,
    machineId: WorkflowMachineIdV1Schema,
    executionTarget: WorkflowRunExecutionTargetV1Schema,
    roleOverrides: zMini.optional(WorkflowRoleOverridesV1Schema),
    materializedLeaves: z.array(WorkflowMaterializedLeafV1Schema),
    frozenChildren: WorkflowFrozenChildrenV1Schema,
    workspaceTarget: WorkflowAcceptedWorkspaceTargetV1Schema,
    origin: z.strictObject({
      kind: z.literal('direct'),
      originSessionId: zMini.optional(preservedBoundedNfcString(191, 'Session ids')),
      discussion: z.optional(WorkflowDiscussionOriginV1Schema),
    }),
  }),
]).check(z.superRefine((value, context) => {
  if (value.workspaceTarget.project.machineId !== value.machineId) {
    context.addIssue({
      code: "custom",
      path: ['workspaceTarget', 'project', 'machineId'],
      message: 'Project workspace must use the immutable Run Machine',
    });
  }
})));
export type WorkflowRunAcceptedContextV1 = z.infer<typeof WorkflowRunAcceptedContextV1Schema>;
export const WorkflowRunGetResultV1Schema = lazyZodSchema(() => z.strictObject({
  run: WorkflowRunSummaryV1Schema,
  /** Effective caller capabilities from the server's live Run access owner. */
  callerAccess: WorkflowRunCallerAccessV1Schema,
  definition: WorkflowDefinitionV1Schema,
  acceptedContext: WorkflowRunAcceptedContextV1Schema,
  /** Authenticated authored source before role/selection materialization; used for semantic rejoin. */
  authoredDefinition: WorkflowDefinitionV1Schema,
  checkpoint: zMini.nullable(WorkflowCheckpointEnvelopeV1Schema),
  result: zMini.optional(StrictJsonValueSchema), usage: zMini.optional(WorkflowUsageV1Schema),
  /** Authenticated exact producer record of `result`; neither field exists without the other. */
  finalOutputInvocationId: zMini.optional(WorkflowInvocationRecordIdSchema),
}).check(z.superRefine((value, context) => {
  const hasResult = value.result !== undefined;
  const hasProducer = value.finalOutputInvocationId !== undefined;
  if (hasResult === hasProducer) return;
  context.addIssue({
    code: "custom",
    path: [hasResult ? 'finalOutputInvocationId' : 'result'],
    message: hasResult
      ? 'Workflow Run result requires its exact producer invocation'
      : 'Workflow Run producer invocation requires a result',
  });
})));
export const WorkflowRunWaitConditionV1Schema = lazyZodSchema(() => z.enum(['terminal', 'attention', 'paused']));
export const WorkflowRunWaitConditionsV1Schema = lazyZodSchema(() => z.array(WorkflowRunWaitConditionV1Schema).check(z.minLength(1), z.refine(conditions => new Set(conditions).size === conditions.length, 'Wait conditions must be unique')));
export const WorkflowRunWaitRequestV1Schema = lazyZodSchema(() => z.strictObject({
  runId: WorkflowRunIdV1Schema,
  conditions: z.optional(WorkflowRunWaitConditionsV1Schema),
  timeoutSeconds: z.optional(z.number().check(z.positive(), z.int())),
}));
/** Passive host sink: public summary only, including the canonical attention projection. */
export const WorkflowRunWaitSnapshotV1Schema = lazyZodSchema(() => z.strictObject({ run: WorkflowRunSummaryV1Schema }));
const WorkflowRunWaitResultBaseV1Schema = lazyZodSchema(() => z.strictObject({
  run: WorkflowRunSummaryV1Schema, result: zMini.optional(StrictJsonValueSchema),
}));
export const WorkflowRunWaitResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('observation', [
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(WorkflowRunWaitResultBaseV1Schema, { observation: z.literal('terminal'), matchedCondition: z.literal('terminal') })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(WorkflowRunWaitResultBaseV1Schema, { observation: z.literal('paused'), matchedCondition: z.literal('paused') })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(WorkflowRunWaitResultBaseV1Schema, { observation: z.literal('needs_attention'), matchedCondition: z.literal('attention') })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(WorkflowRunWaitResultBaseV1Schema, { observation: z.literal('timeout') })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(WorkflowRunWaitResultBaseV1Schema, { observation: z.literal('not_matched_terminal') })),
]));
export const WorkflowRunPauseRequestV1Schema = lazyZodSchema(() => z.strictObject({ runId: WorkflowRunIdV1Schema, expectedRevision: RevisionSchema }));
export const WorkflowRunCancelRequestV1Schema = WorkflowRunPauseRequestV1Schema;
export const WorkflowRunControlResultV1Schema = lazyZodSchema(() => z.strictObject({
  run: WorkflowRunSummaryV1Schema,
  intent: z.enum(['pause_requested', 'paused', 'resumed', 'recovery_required', 'unavailable', 'cancel_requested', 'cancelled']),
}));

export const WorkflowInvocationListRequestV1Schema = lazyZodSchema(() => z.strictObject({
  runId: WorkflowRunIdV1Schema, cursor: zMini.optional(CursorSchema), limit: z.optional(PositivePagePreferenceSchema),
  /** Null selects root slots; omission selects Run history. */
  parentRecordId: zMini.optional(zMini.nullable(WorkflowInvocationRecordIdSchema)),
  /** Direct-child history of the requested parents, including superseded attempts. */
  parentRecordIds: z.optional(z.array(WorkflowInvocationRecordIdSchema).check(z.minLength(1))),
  /** Exact history record, including a superseded logical attempt. */
  invocationId: z.optional(WorkflowInvocationRecordIdSchema),
  /** Newest attempt of one direct-member slot. */
  memberOrdinal: z.optional(WorkflowDecimalV1Schema),
  lifecycles: z.optional(z.array(WorkflowInvocationLifecycleV1Schema).check(z.minLength(1))),
  /** Open private progress beside the selected indices, without recovery-detail reads. */
  includeContent: z.optional(z.boolean()),
}).check(z.superRefine((value, context) => {
  if (value.memberOrdinal !== undefined && value.parentRecordId === undefined) {
    context.addIssue({ code: "custom", path: ['memberOrdinal'], message: 'A member slot requires its parent' });
  }
  if (value.parentRecordIds !== undefined && (value.parentRecordId !== undefined || value.invocationId !== undefined || value.memberOrdinal !== undefined)) {
    context.addIssue({ code: "custom", path: ['parentRecordIds'], message: 'Batched child history cannot select another window' });
  }
  if (value.invocationId !== undefined && (value.parentRecordId !== undefined || value.memberOrdinal !== undefined || value.lifecycles !== undefined)) {
    context.addIssue({ code: "custom", path: ['invocationId'], message: 'An exact record cannot select a member window or lifecycle' });
  }
})));
export const WorkflowInvocationListResultV1Schema = lazyZodSchema(() => z.strictObject({
  invocations: z.array(WorkflowRunInvocationIndexV1Schema), nextCursor: zMini.optional(CursorSchema), parentRevision: RevisionSchema,
  /** Present only when requested; one opened detail for each index on this page. */
  invocationDetails: z.optional(z.array(WorkflowInvocationDetailV1Schema)),
}));
export const WorkflowInvocationGetRequestV1Schema = lazyZodSchema(() => z.strictObject({ runId: WorkflowRunIdV1Schema, invocationId: WorkflowInvocationRecordIdSchema }));
export const WorkflowInvocationGetResultV1Schema = lazyZodSchema(() => z.strictObject({
  invocation: WorkflowInvocationDetailV1Schema,
  /** Opened from this Run's accepted snapshot, never inferred from origin or caller content. */
  discussionResultDelivery: z.optional(WorkflowDiscussionResultDeliveryV1Schema),
}));
export const WorkflowInvocationRetryResultV1Schema = lazyZodSchema(() => z.strictObject({
  run: WorkflowRunSummaryV1Schema, invocation: WorkflowRunInvocationIndexV1Schema,
  disposition: z.enum(['accepted', 'ineligible', 'conflict']),
}));
const WorkflowReviewTargetV1Shape = {
  runId: WorkflowRunIdV1Schema,
  invocation: WorkflowInvocationRefV1Schema,
  expectedContentRevision: WorkflowDecimalV1Schema,
};
export const WorkflowInvocationPublishDraftRequestV1Schema = lazyZodSchema(() => z.strictObject({
  ...WorkflowReviewTargetV1Shape, value: StrictJsonValueSchema,
}));
export const WorkflowInvocationPublishDraftResultV1Schema = WorkflowInvocationGetResultV1Schema;
export const WorkflowInvocationCompleteReviewRequestV1Schema = lazyZodSchema(() => z.discriminatedUnion('mode', [
  z.strictObject({ ...WorkflowReviewTargetV1Shape, mode: z.literal('use_result'),
    value: zMini.optional(StrictJsonValueSchema), followUp: zMini.optional(WorkflowReviewFollowUpV1Schema) }),
  z.strictObject({ ...WorkflowReviewTargetV1Shape, mode: z.literal('generate'),
    acknowledgeUncertainPriorEffects: z.optional(z.literal(true)) }),
]));
export const WorkflowInvocationCompleteReviewResultV1Schema = lazyZodSchema(() => z.strictObject({
  run: WorkflowRunSummaryV1Schema, invocation: WorkflowRunInvocationIndexV1Schema,
  disposition: z.enum(['completed', 'generation_requested']),
}));
export const WorkflowRunDeleteRequestV1Schema = WorkflowRunPauseRequestV1Schema;
export const WorkflowRunDeleteResultV1Schema = lazyZodSchema(() => z.strictObject({ deleted: z.literal(true), runId: WorkflowRunIdV1Schema }));

export const WorkflowDefinitionListRequestV1Schema = lazyZodSchema(() => z.strictObject({ cursor: zMini.optional(CursorSchema), limit: z.optional(PositivePagePreferenceSchema) }));
const WorkflowDefinitionLibraryHeaderV1Schema = lazyZodSchema(() => (<T extends zMini.ZodMiniObject>(schema: T) => zMini.core.clone(schema, { ...schema._zod.def, catchall: zMini.never() }) as zMini.ZodMiniObject<T['shape'], zMini.core.$strict>)(zMini.extend(WorkflowDefinitionArtifactHeaderV1Schema, {
  ownerAccountId: z.optional(z.string().check(z.minLength(1))), access: zMini.optional(ArtifactCallerAccessV1Schema),
  /** Opened owner-private provenance, never attribution from the stored shared header. */
  savedBy: zMini.optional(WorkflowDefinitionSavedByV1Schema),
  /** Ordering fact from the admitted Artifact page; never requires a detail read. */
  updatedAt: z.optional(z.number().check(z.int(), z.nonnegative())),
  triggers: z.array(WorkflowTriggerSummaryInputV1Schema),
  /** Summary enrichment failed; empty trigger facts are unknown, not proof of no triggers. */
  triggerSummaryErrorCode: z.optional(WorkflowOperationErrorCodeV1Schema),
  /** Earliest enabled occurrence supplied by the Automation scheduler, never calculated by a reader. */
  nextRunAt: z.nullable(z.number().check(z.int(), z.nonnegative(), z.int())),
})));
export const WorkflowDefinitionListResultV1Schema = lazyZodSchema(() => z.strictObject({ definitions: z.array(z.discriminatedUnion('contentStatus', [
  (<T extends zMini.ZodMiniObject>(schema: T) => zMini.core.clone(schema, { ...schema._zod.def, catchall: zMini.never() }) as zMini.ZodMiniObject<T['shape'], zMini.core.$strict>)(zMini.extend(WorkflowDefinitionLibraryHeaderV1Schema, { contentStatus: z.literal('available'), stepCount: z.number().check(z.int(), z.nonnegative(), z.int()), destinations: zMini.optional(WorkflowDestinationsV1Schema) })),
  (<T extends zMini.ZodMiniObject>(schema: T) => zMini.core.clone(schema, { ...schema._zod.def, catchall: zMini.never() }) as zMini.ZodMiniObject<T['shape'], zMini.core.$strict>)(zMini.extend(WorkflowDefinitionLibraryHeaderV1Schema, { contentStatus: z.literal('unavailable'), stepCount: z.null(),
    revision: zMini.nullable(WorkflowArtifactRevisionV1Schema), metadata: zMini.nullable(WorkflowDefinitionMetadataV1Schema),
    contentUnavailableReason: WorkflowDefinitionContentUnavailableReasonV1Schema })),
])), pluginWorkflows: z.optional(z.array(WorkflowPluginSourceV1Schema)), nextCursor: zMini.optional(CursorSchema) }));
export const WorkflowDefinitionGetRequestV1Schema = lazyZodSchema(() => z.strictObject({ definitionId: WorkflowDefinitionIdV1Schema }));
export const WorkflowDefinitionGetResultV1Schema = lazyZodSchema(() => z.strictObject({ definitionId: WorkflowDefinitionIdV1Schema, revision: WorkflowArtifactRevisionV1Schema, definition: WorkflowDefinitionV1Schema, destinations: zMini.optional(WorkflowDestinationsV1Schema), metadata: WorkflowDefinitionMetadataV1Schema, access: ArtifactCallerAccessV1Schema, savedBy: zMini.optional(WorkflowDefinitionSavedByV1Schema) }));
// New definitions use the Artifact creation identity contract; readers retain the broader stored-id schema.
export const WorkflowDefinitionCreateRequestV1Schema = lazyZodSchema(() => z.strictObject({ definitionId: z.string().check(z.uuid()), definition: WorkflowIngressCarrierV1Schema, metadata: WorkflowDefinitionMetadataV1Schema }));
export const WorkflowDefinitionCreateResultV1Schema = WorkflowDefinitionGetResultV1Schema;
export const WorkflowDefinitionUpdateRequestV1Schema = lazyZodSchema(() => z.strictObject({ definitionId: WorkflowDefinitionIdV1Schema, expectedRevision: WorkflowArtifactRevisionV1Schema, definition: WorkflowIngressCarrierV1Schema, metadata: WorkflowDefinitionMetadataV1Schema }));
export const WorkflowDefinitionUpdateResultV1Schema = WorkflowDefinitionGetResultV1Schema;
export const WorkflowDefinitionDeleteRequestV1Schema = lazyZodSchema(() => z.strictObject({ definitionId: WorkflowDefinitionIdV1Schema }));
export const WorkflowDefinitionDeleteResultV1Schema = lazyZodSchema(() => z.strictObject({ deleted: z.literal(true), definitionId: WorkflowDefinitionIdV1Schema }));
export const WorkflowDefinitionImportRequestV1Schema = lazyZodSchema(() => z.strictObject({ json: z.string() }));
export const WorkflowDefinitionImportResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), classification: z.literal('unsaved_definition'), document: WorkflowDocumentV1Schema }),
  WorkflowDocumentParseFailureV1Schema,
]));
export const WorkflowDefinitionExportRequestV1Schema = WorkflowDefinitionGetRequestV1Schema;
export const WorkflowDefinitionExportResultV1Schema = lazyZodSchema(() => z.strictObject({
  definitionId: WorkflowDefinitionIdV1Schema, revision: WorkflowArtifactRevisionV1Schema,
  metadata: WorkflowDefinitionMetadataV1Schema, document: WorkflowDocumentV1Schema, json: z.string(),
}));

export { WORKFLOW_ACTION_IDS_V1, type WorkflowActionIdV1 };

export const WorkflowActionInputSchemasV1 = {
  'workflow.validate': WorkflowValidateRequestV1Schema,
  'workflow.run.start': WorkflowRunStartRequestV1Schema,
  'workflow.run.list': WorkflowRunListRequestV1Schema,
  'workflow.run.summaries': WorkflowRunSummariesRequestV1Schema,
  'workflow.run.get': WorkflowRunGetRequestV1Schema,
  'workflow.run.read_state.set': WorkflowRunReadStateSetRequestV1Schema,
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
  'workflow.definition.capture': WorkflowDefinitionCaptureRequestV1Schema,
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
} as const satisfies Record<WorkflowActionIdV1, z.ZodMiniType>;

export const WorkflowActionOutputSchemasV1: {
  readonly 'workflow.validate': typeof WorkflowValidateResultV1Schema;
  readonly 'workflow.run.start': typeof WorkflowRunStartResultV1Schema;
  readonly 'workflow.run.list': typeof WorkflowRunListResultV1Schema;
  readonly 'workflow.run.summaries': typeof WorkflowRunSummariesResultV1Schema;
  readonly 'workflow.run.get': typeof WorkflowRunGetResultV1Schema;
  readonly 'workflow.run.read_state.set': typeof WorkflowRunReadStateSetResultV1Schema;
  readonly 'workflow.run.wait': typeof WorkflowRunWaitResultV1Schema;
  readonly 'workflow.run.pause': typeof WorkflowRunControlResultV1Schema;
  readonly 'workflow.run.resume': typeof WorkflowRunControlResultV1Schema;
  readonly 'workflow.run.cancel': typeof WorkflowRunControlResultV1Schema;
  readonly 'workflow.run.invocations.list': typeof WorkflowInvocationListResultV1Schema;
  readonly 'workflow.run.invocations.get': typeof WorkflowInvocationGetResultV1Schema;
  readonly 'workflow.run.invocations.retry': typeof WorkflowInvocationRetryResultV1Schema;
  readonly 'workflow.run.invocations.publish_draft': typeof WorkflowInvocationPublishDraftResultV1Schema;
  readonly 'workflow.run.invocations.complete_review': typeof WorkflowInvocationCompleteReviewResultV1Schema;
  readonly 'workflow.run.delete': typeof WorkflowRunDeleteResultV1Schema;
  readonly 'workflow.definition.list': typeof WorkflowDefinitionListResultV1Schema;
  readonly 'workflow.definition.get': typeof WorkflowDefinitionGetResultV1Schema;
  readonly 'workflow.definition.create': typeof WorkflowDefinitionCreateResultV1Schema;
  readonly 'workflow.definition.update': typeof WorkflowDefinitionUpdateResultV1Schema;
  readonly 'workflow.definition.edit': typeof WorkflowDefinitionEditResultV1Schema;
  readonly 'workflow.definition.delete': typeof WorkflowDefinitionDeleteResultV1Schema;
  readonly 'workflow.definition.import': typeof WorkflowDefinitionImportResultV1Schema;
  readonly 'workflow.definition.capture': typeof WorkflowDefinitionCaptureResultV1Schema;
  readonly 'workflow.definition.export': typeof WorkflowDefinitionExportResultV1Schema;
  readonly 'workflow.trigger.list': typeof WorkflowTriggerListResultV1Schema;
  readonly 'workflow.trigger.add': typeof WorkflowTriggerWriteResultV1Schema;
  readonly 'workflow.trigger.update': typeof WorkflowTriggerWriteResultV1Schema;
  readonly 'workflow.trigger.remove': typeof WorkflowTriggerRemoveResultV1Schema;
  readonly 'workflow.trigger.run_now': typeof AutomationV3RunMutationResponseSchema;
  readonly 'session.trigger.list': typeof SessionTriggerListResultV1Schema;
  readonly 'session.trigger.add': typeof WorkflowTriggerWriteResultV1Schema;
  readonly 'session.trigger.update': typeof WorkflowTriggerWriteResultV1Schema;
  readonly 'session.trigger.remove': typeof WorkflowTriggerWriteResultV1Schema;
} = {
  'workflow.validate': WorkflowValidateResultV1Schema,
  'workflow.run.start': WorkflowRunStartResultV1Schema,
  'workflow.run.list': WorkflowRunListResultV1Schema,
  'workflow.run.summaries': WorkflowRunSummariesResultV1Schema,
  'workflow.run.get': WorkflowRunGetResultV1Schema,
  'workflow.run.read_state.set': WorkflowRunReadStateSetResultV1Schema,
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
  'workflow.definition.capture': WorkflowDefinitionCaptureResultV1Schema,
  'workflow.definition.export': WorkflowDefinitionExportResultV1Schema,
  'workflow.trigger.list': WorkflowTriggerListResultV1Schema,
  'workflow.trigger.add': WorkflowTriggerWriteResultV1Schema,
  'workflow.trigger.update': WorkflowTriggerWriteResultV1Schema,
  'workflow.trigger.remove': WorkflowTriggerRemoveResultV1Schema,
  'workflow.trigger.run_now': AutomationV3RunMutationResponseSchema,
  'session.trigger.list': SessionTriggerListResultV1Schema,
  'session.trigger.add': WorkflowTriggerWriteResultV1Schema,
  'session.trigger.update': WorkflowTriggerWriteResultV1Schema,
  'session.trigger.remove': WorkflowTriggerWriteResultV1Schema,
} as const satisfies Record<WorkflowActionIdV1, z.ZodMiniType>;

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
