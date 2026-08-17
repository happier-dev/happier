import { z } from 'zod';
import { ApprovalDecisionV1Schema, ApprovalExecutionV1Schema, ApprovalRequestCreatedBySchema, ApprovalRequestStatusSchema } from './approvalRequestV1.js';
import { AgentRuntimeJsonValueV1Schema } from '../runtime/agentSessionV1.js';

export const TARGET_ACTION_APPROVAL_LIMITS_V1 = Object.freeze({
  artifactJsonBytes: 64 * 1024,
  idUtf16Units: 512,
  surfaceUtf16Units: 64,
  summaryUtf16Units: 1_024,
  detailUtf16Units: 4_096,
});

const boundedId = z.string().min(1).max(TARGET_ACTION_APPROVAL_LIMITS_V1.idUtf16Units);

export const TargetActionApprovalRequestV1Schema = z.object({
  v: z.literal(1), kind: z.literal('plugin_target_action'), status: ApprovalRequestStatusSchema,
  createdAtMs: z.number().int().min(0), updatedAtMs: z.number().int().min(0),
  createdBy: ApprovalRequestCreatedBySchema,
  requestedSurface: z.string().min(1).max(TARGET_ACTION_APPROVAL_LIMITS_V1.surfaceUtf16Units),
  qualifiedActionId: z.string().max(TARGET_ACTION_APPROVAL_LIMITS_V1.idUtf16Units).regex(/^[a-z0-9][a-z0-9._-]*\/actions\/[a-z0-9][a-z0-9/-]*$/),
  input: AgentRuntimeJsonValueV1Schema, accountId: boundedId.optional(), resourceId: boundedId.optional(),
  generation: boundedId, policyFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  subjectFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  summary: z.string().min(1).max(TARGET_ACTION_APPROVAL_LIMITS_V1.summaryUtf16Units),
  detail: z.string().min(1).max(TARGET_ACTION_APPROVAL_LIMITS_V1.detailUtf16Units).optional(),
  decision: ApprovalDecisionV1Schema.optional(), execution: ApprovalExecutionV1Schema.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.status === 'open' && (value.decision || value.execution)) ctx.addIssue({ code: 'custom', message: 'open target-action approval cannot contain a decision or execution' });
  if ((value.status === 'approved' || value.status === 'executed' || value.status === 'failed') && value.decision?.kind !== 'approve') ctx.addIssue({ code: 'custom', message: `${value.status} target-action approval requires approve` });
  if (value.status === 'rejected' && value.decision?.kind !== 'reject') ctx.addIssue({ code: 'custom', message: 'rejected target-action approval requires reject' });
  if (value.status === 'canceled' && value.decision) ctx.addIssue({ code: 'custom', message: 'canceled target-action approval cannot contain a decision' });
  if ((value.status === 'executed' || value.status === 'failed') !== Boolean(value.execution)) ctx.addIssue({ code: 'custom', message: 'target-action approval execution/status mismatch' });
  const strictJson = AgentRuntimeJsonValueV1Schema.safeParse(value);
  if (!strictJson.success) {
    ctx.addIssue({ code: 'custom', message: 'target-action approval artifact must be strict JSON' });
  } else if (new TextEncoder().encode(JSON.stringify(strictJson.data)).byteLength > TARGET_ACTION_APPROVAL_LIMITS_V1.artifactJsonBytes) {
    ctx.addIssue({ code: 'custom', message: 'target-action approval artifact byte limit exceeded' });
  }
});
export type TargetActionApprovalRequestV1 = z.infer<typeof TargetActionApprovalRequestV1Schema>;
