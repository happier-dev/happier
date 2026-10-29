import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { ActionIdSchema } from '../actions/actionIds.js';
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
import { TargetActionApprovalRequestV1Schema } from './targetActionApprovalRequestV1.js';

/** Matches projectApprovalRequestForPublicRead; never accepts private replay custody. */
const ApprovalPublicExecutionOriginV1Schema = lazyZodSchema(() => {
  const { externalActionExecutionAuthorization: _authorization, externalActionInputSignature: _signature,
    originalActionEnvelope: _envelope, ...shape } = ApprovalExecutionOriginV1Schema.shape;
  return z.strictObject(shape);
});

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
  return z.strictObject(shape);
});

/** Read projection only: the private request schemas retain all replay/lifecycle validation. */
export const ApprovalRequestPublicReadSchema = lazyZodSchema(() => z.union([
  z.strictObject({
    ...ApprovalRequestV1Schema.shape,
    actionArgs: StrictJsonValueSchema,
    preview: z.optional(StrictJsonValueSchema),
    origin: z.optional(ApprovalPublicOriginV1Schema),
    decision: z.optional(ApprovalPublicDecisionV2Schema),
    execution: z.optional(ApprovalPublicExecutionV1Schema),
  }),
  z.strictObject({
    ...ApprovalRequestV2Schema.shape,
    actionArgs: StrictJsonValueSchema,
    preview: z.optional(StrictJsonValueSchema),
    origin: z.optional(ApprovalPublicOriginV1Schema),
    executionOriginV1: ApprovalPublicExecutionOriginV1Schema,
    decision: z.optional(ApprovalPublicDecisionV2Schema),
    execution: z.optional(ApprovalPublicExecutionV2Schema),
  }),
  z.strictObject({
    ...TargetActionApprovalRequestV1Schema.shape,
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
  actionId: ActionIdSchema,
  summary: z.string(),
  sessionId: z.optional(z.string()),
  serverId: z.optional(z.string()),
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

export const ApprovalRequestGetResultV1Schema = lazyZodSchema(() => z.strictObject({
  artifactId: z.string(),
  request: ApprovalRequestPublicReadSchema,
  queryPlan: z.strictObject({
    kind: z.literal('approval_artifact_id_lookup'),
    backingStore: z.literal('ArtifactStore'),
    boundedBy: z.string(),
    hydratedTranscripts: z.literal(false),
  }),
}));
export type ApprovalRequestGetResultV1 = z.infer<typeof ApprovalRequestGetResultV1Schema>;
