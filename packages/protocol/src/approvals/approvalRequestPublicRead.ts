import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { ActionIdSchema } from '../actions/actionIds.js';
import { RETIRED_DEPLOYMENT_PUBLISH_ACTION_ID_V1, deploymentOperationForRootActionV1 } from '../deployments/deploymentActionIdsV1.js';
import { DeploymentIdentifierV1Schema } from '../deployments/deploymentIdentifiersV1.js';
import { DeploymentReceiptAcceptedResultV1Schema } from '../deployments/deploymentReceiptResultV1.js';
import { DeploymentReceiptMetadataV1Schema } from '../deployments/deploymentActionsV1.js';
import { StrictJsonValueSchema } from '../json/strictJsonValue.js';
import {
  ApprovalDecisionV1Schema,
  ApprovalDecisionV2Schema,
  ApprovalExecutionOriginV1Schema,
  ApprovalExecutionV1Schema,
  ApprovalExecutionV2Schema,
  ApprovalRequestOriginV1Schema,
  ApprovalRequestV1Schema,
  ApprovalRequestV2Schema,
  ApprovalRequestV2StatusSchema,
} from './approvalRequestV1.js';
import { ApprovalStaleFailureDetailsSchema } from './approvalStaleReason.js';
import { TargetActionApprovalRequestV1Schema } from './targetActionApprovalRequestV1.js';
import { ApprovalAutomaticChecksV1Schema, ApprovalAutomaticSelectedTriggerV1Schema } from './approvalAutomaticChecks.js';

/** Matches projectApprovalRequestForPublicRead; never accepts private replay custody. */
const ApprovalPublicExecutionOriginV1Schema = lazyZodSchema(() => {
  const { externalActionExecutionAuthorization: _authorization, externalActionInputSignature: _signature,
    originalActionEnvelope: _envelope, ...shape } = ApprovalExecutionOriginV1Schema.shape;
  return z.strictObject(shape);
});

const HistoricalPublishPublicExecutionOriginV1Schema = lazyZodSchema(() => z.strictObject({
  ...ApprovalPublicExecutionOriginV1Schema.shape,
  actionId: z.literal(RETIRED_DEPLOYMENT_PUBLISH_ACTION_ID_V1),
}));

const ApprovalPublicOriginV1Schema = lazyZodSchema(() => {
  const { toolInput: _input, ...shape } = ApprovalRequestOriginV1Schema.shape;
  return z.strictObject(shape);
});

const ApprovalPublicDecisionV1Schema = lazyZodSchema(() => z.strictObject(ApprovalDecisionV1Schema.shape));
const ApprovalPublicDecisionV2Schema = lazyZodSchema(() => z.strictObject({
  ...ApprovalPublicDecisionV1Schema.shape,
  authority: ApprovalDecisionV2Schema.shape.authority,
  decidedVia: ApprovalDecisionV2Schema.shape.decidedVia,
  narrowedInput: ApprovalDecisionV2Schema.shape.narrowedInput,
}));
const ApprovalPublicExecutionV1Schema = lazyZodSchema(() => z.strictObject({
  ...ApprovalExecutionV1Schema.shape,
  result: z.optional(StrictJsonValueSchema),
}));
const ApprovalPublicExecutionV2Schema = lazyZodSchema(() => z.strictObject({
  ...ApprovalExecutionV2Schema.shape,
  result: z.optional(StrictJsonValueSchema),
  details: z.optional(StrictJsonValueSchema),
}));
const ApprovalPublicTargetExecutionV1Schema = lazyZodSchema(() => {
  const { details: _details, ...shape } = ApprovalPublicExecutionV2Schema.shape;
  return z.strictObject({ ...shape, details: z.optional(ApprovalStaleFailureDetailsSchema) });
});
const ApprovalPublicAutomaticChecksV1Schema = lazyZodSchema(() => {
  const { subjects: _subjects, ...shape } = ApprovalAutomaticChecksV1Schema.shape;
  const { subject: _subject, ...selectedShape } = ApprovalAutomaticSelectedTriggerV1Schema.shape;
  return z.strictObject({ ...shape, selected: z.array(z.strictObject(selectedShape)),
    humanDecision: z.optional(ApprovalPublicDecisionV2Schema) });
});

const ApprovalPublicRequestV2Schema = lazyZodSchema(() => z.strictObject({
  ...ApprovalRequestV2Schema.shape,
  actionArgs: StrictJsonValueSchema,
  preview: z.optional(StrictJsonValueSchema),
  origin: z.optional(ApprovalPublicOriginV1Schema),
  executionOriginV1: ApprovalPublicExecutionOriginV1Schema,
  decision: z.optional(ApprovalPublicDecisionV2Schema),
  automaticChecks: z.optional(ApprovalPublicAutomaticChecksV1Schema),
  execution: z.optional(ApprovalPublicExecutionV2Schema),
}));

type ApprovalPublicRequestV1Shape = Omit<typeof ApprovalRequestV1Schema.shape,
  'actionArgs' | 'preview' | 'origin' | 'decision' | 'execution'> & {
  actionArgs: typeof StrictJsonValueSchema;
  preview: z.ZodMiniOptional<typeof StrictJsonValueSchema>;
  origin: z.ZodMiniOptional<typeof ApprovalPublicOriginV1Schema>;
  decision: z.ZodMiniOptional<typeof ApprovalPublicDecisionV2Schema>;
  execution: z.ZodMiniOptional<typeof ApprovalPublicExecutionV1Schema>;
};
type HistoricalPublishPublicRequestV2Shape = Omit<typeof ApprovalPublicRequestV2Schema.shape,
  'actionId' | 'executionOriginV1'> & {
  actionId: z.ZodMiniLiteral<typeof RETIRED_DEPLOYMENT_PUBLISH_ACTION_ID_V1>;
  executionOriginV1: typeof HistoricalPublishPublicExecutionOriginV1Schema;
};
type ApprovalPublicTargetRequestV1Shape = Omit<typeof TargetActionApprovalRequestV1Schema.shape,
  'executionOriginV1' | 'decision' | 'execution' | 'automaticChecks'> & {
  executionOriginV1: z.ZodMiniOptional<typeof ApprovalPublicExecutionOriginV1Schema>;
  decision: z.ZodMiniOptional<z.ZodMiniObject<typeof ApprovalPublicDecisionV1Schema.shape & {
    decidedVia: typeof ApprovalDecisionV2Schema.shape.decidedVia;
  }, z.core.$strict>>;
  execution: z.ZodMiniOptional<typeof ApprovalPublicTargetExecutionV1Schema>;
  automaticChecks: z.ZodMiniOptional<typeof ApprovalPublicAutomaticChecksV1Schema>;
};
export type ApprovalRequestPublicReadSchemaType = z.ZodMiniUnion<[
  z.ZodMiniObject<ApprovalPublicRequestV1Shape, z.core.$strict>,
  typeof ApprovalPublicRequestV2Schema,
  z.ZodMiniObject<HistoricalPublishPublicRequestV2Shape, z.core.$strict>,
  z.ZodMiniObject<ApprovalPublicTargetRequestV1Shape, z.core.$strict>,
]>;

/** Read projection only: the private request schemas retain all replay/lifecycle validation. */
export const ApprovalRequestPublicReadSchema: ApprovalRequestPublicReadSchemaType = lazyZodSchema(() => z.union([
  z.strictObject({
    ...ApprovalRequestV1Schema.shape,
    actionArgs: StrictJsonValueSchema,
    preview: z.optional(StrictJsonValueSchema),
    origin: z.optional(ApprovalPublicOriginV1Schema),
    decision: z.optional(ApprovalPublicDecisionV2Schema),
    execution: z.optional(ApprovalPublicExecutionV1Schema),
  }),
  ApprovalPublicRequestV2Schema,
  z.strictObject({
    ...ApprovalPublicRequestV2Schema.shape,
    actionId: z.literal(RETIRED_DEPLOYMENT_PUBLISH_ACTION_ID_V1),
    executionOriginV1: HistoricalPublishPublicExecutionOriginV1Schema,
  }),
  z.strictObject({
    ...TargetActionApprovalRequestV1Schema.shape,
    automaticChecks: z.optional(ApprovalPublicAutomaticChecksV1Schema),
    executionOriginV1: z.optional(ApprovalPublicExecutionOriginV1Schema),
    decision: z.optional(z.strictObject({ ...ApprovalPublicDecisionV1Schema.shape,
      decidedVia: ApprovalDecisionV2Schema.shape.decidedVia })),
    execution: z.optional(ApprovalPublicTargetExecutionV1Schema),
  }),
]));
export type ApprovalRequestPublicRead = z.infer<typeof ApprovalRequestPublicReadSchema>;

export const ApprovalQueueListItemV1Schema = lazyZodSchema(() => z.strictObject({
  artifactId: z.string(),
  status: ApprovalRequestV2StatusSchema,
  actionId: z.union([ActionIdSchema, z.literal(RETIRED_DEPLOYMENT_PUBLISH_ACTION_ID_V1)]),
  summary: z.string(),
  sessionId: z.optional(z.string()),
  serverId: z.optional(z.string()),
  /** The list facts the Inbox and Discussion lists group by (the header's `approvalListFacts`). */
  automationId: z.optional(z.string()),
  discussionId: z.optional(z.string()),
  updatedAtMs: z.number(),
}));
export type ApprovalQueueListItemV1 = Readonly<z.infer<typeof ApprovalQueueListItemV1Schema>>;

export const ApprovalQueueQueryPlanV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.enum(['approval_artifact_header_scan', 'bounded_approval_artifact_header_scan', 'approval_artifact_id_lookup']),
  backingStore: z.optional(z.literal('ArtifactStore')),
  boundedBy: z.optional(z.string()),
  serverLimit: z.optional(z.number()),
  hydratedTranscripts: z.literal(false),
}));
export type ApprovalQueueQueryPlanV1 = Readonly<z.infer<typeof ApprovalQueueQueryPlanV1Schema>>;

export const ApprovalQueueListResultV1Schema = lazyZodSchema(() => z.strictObject({
  items: z.array(ApprovalQueueListItemV1Schema),
  nextCursor: z.optional(z.nullable(z.string())),
  queryPlan: ApprovalQueueQueryPlanV1Schema,
}));
export type ApprovalQueueListResultV1 = Readonly<Omit<z.infer<typeof ApprovalQueueListResultV1Schema>, 'items'> & {
  items: readonly ApprovalQueueListItemV1[];
}>;

/** A pending receipt is the existing Ask, not an execution receipt reserved before approval. */
export const DeploymentApprovalReceiptV1Schema = lazyZodSchema(() => {
  const subject = { approvalId: DeploymentIdentifierV1Schema, environmentId: z.optional(DeploymentIdentifierV1Schema),
    operation: DeploymentReceiptMetadataV1Schema.shape.operation };
  return z.union([
    z.strictObject({ ...subject, state: z.enum([...ApprovalRequestV2StatusSchema.options.filter(status => status !== 'open'),
      'waiting-for-approval']) }),
    z.strictObject({ ...subject, state: z.literal('admitted'), receipt: DeploymentReceiptAcceptedResultV1Schema }),
  ]);
});
export type DeploymentApprovalReceiptV1 = z.infer<typeof DeploymentApprovalReceiptV1Schema>;

/** Observation only: decide/replay and receipt admission remain with their existing owners. */
export function projectDeploymentApprovalReceiptV1(approvalId: string,
  request: Readonly<{ actionId?: string; status: string; actionArgs?: unknown;
    execution?: Readonly<{ ok: boolean; result?: unknown }> }>): DeploymentApprovalReceiptV1 | null {
  const operation = deploymentOperationForRootActionV1(request.actionId ?? '');
  if (!operation) return null;
  const args = request.actionArgs;
  const environmentId = args && typeof args === 'object' && 'environmentId' in args
    && typeof args.environmentId === 'string' ? args.environmentId : undefined;
  const subject = { approvalId, operation, ...(environmentId ? { environmentId } : {}) };
  if (request.status === 'executed' && request.execution?.ok) {
    const receipt = DeploymentReceiptAcceptedResultV1Schema.safeParse(request.execution.result);
    if (receipt.success) return { ...subject, state: 'admitted', receipt: receipt.data };
  }
  return DeploymentApprovalReceiptV1Schema.parse({ ...subject,
    state: request.status === 'open' ? 'waiting-for-approval' : request.status });
}

export const ApprovalRequestGetResultV1Schema: z.ZodMiniObject<{
  artifactId: z.ZodMiniString;
  request: typeof ApprovalRequestPublicReadSchema;
  canAllow: z.ZodMiniBoolean;
  deploymentReceipt: z.ZodMiniOptional<typeof DeploymentApprovalReceiptV1Schema>;
  queryPlan: z.ZodMiniObject<{
    kind: z.ZodMiniLiteral<'approval_artifact_id_lookup'>;
    backingStore: z.ZodMiniLiteral<'ArtifactStore'>;
    boundedBy: z.ZodMiniString;
    hydratedTranscripts: z.ZodMiniLiteral<false>;
  }, z.core.$strict>;
}, z.core.$strict> = lazyZodSchema(() => z.strictObject({
  artifactId: z.string(),
  request: ApprovalRequestPublicReadSchema,
  canAllow: z.boolean(),
  deploymentReceipt: z.optional(DeploymentApprovalReceiptV1Schema),
  queryPlan: z.strictObject({
    kind: z.literal('approval_artifact_id_lookup'),
    backingStore: z.literal('ArtifactStore'),
    boundedBy: z.string(),
    hydratedTranscripts: z.literal(false),
  }),
}));
export type ApprovalRequestGetResultV1 = z.infer<typeof ApprovalRequestGetResultV1Schema>;
