import { z } from 'zod';

import {
  ApprovalDecisionV1Schema,
  ApprovalRequestCreatedBySchema,
  ApprovalRequestStatusSchema,
} from './approvalRequestV1.js';
export const EXECUTION_RUN_HOST_ACTION_APPROVAL_LIMITS_V1 = Object.freeze({
  artifactJsonBytes: 64 * 1024,
  idUtf16Units: 512,
  summaryUtf16Units: 1_024,
  surfaceUtf16Units: 64,
});

const boundedId = z.string().trim().min(1).max(EXECUTION_RUN_HOST_ACTION_APPROVAL_LIMITS_V1.idUtf16Units);

const ExecutionRunHostActionProposalPreviewV1Schema = z.object({
  findingId: boundedId.optional(),
  pathLabel: z.string().trim().min(1).max(512),
  pathSha256: z.string().regex(/^[a-f0-9]{64}$/),
  startLine: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  endLine: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  severity: z.enum(['info', 'warning', 'error', 'critical']).optional(),
  bodySha256: z.string().regex(/^[a-f0-9]{64}$/),
  bodyPreview: z.string().trim().min(1).max(1_024),
}).strict().superRefine((value, ctx) => {
  if ((value.startLine === undefined) !== (value.endLine === undefined)) {
    ctx.addIssue({ code: 'custom', message: 'proposal preview line range must be complete' });
  }
  if (value.startLine !== undefined && value.endLine !== undefined && value.endLine < value.startLine) {
    ctx.addIssue({ code: 'custom', message: 'proposal preview endLine must be greater than or equal to startLine' });
  }
});

export const ExecutionRunHostActionApprovalRequestV1Schema = z.object({
  v: z.literal(1),
  kind: z.literal('execution_run_host_action'),
  status: ApprovalRequestStatusSchema,
  createdAtMs: z.number().int().min(0),
  updatedAtMs: z.number().int().min(0),
  createdBy: ApprovalRequestCreatedBySchema,
  requestedSurface: z.string().trim().min(1).max(EXECUTION_RUN_HOST_ACTION_APPROVAL_LIMITS_V1.surfaceUtf16Units),
  actionId: z.literal('reviews.comments.create'),
  sessionId: boundedId,
  runId: boundedId,
  callId: boundedId,
  profileId: boundedId,
  pluginId: boundedId,
  agentId: boundedId,
  projectId: boundedId,
  workspaceId: boundedId,
  serverId: boundedId,
  proposalCount: z.number().int().min(1).max(200),
  proposalPreview: z.array(ExecutionRunHostActionProposalPreviewV1Schema).max(20),
  subjectFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  summary: z.string().trim().min(1).max(EXECUTION_RUN_HOST_ACTION_APPROVAL_LIMITS_V1.summaryUtf16Units),
  decision: ApprovalDecisionV1Schema.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.status === 'open' && value.decision) {
    ctx.addIssue({ code: 'custom', message: 'open execution-run host-action approval cannot contain a decision' });
  }
  if (value.status === 'approved' && value.decision?.kind !== 'approve') {
    ctx.addIssue({ code: 'custom', message: 'approved execution-run host-action approval requires approve' });
  }
  if (value.status === 'rejected' && value.decision?.kind !== 'reject') {
    ctx.addIssue({ code: 'custom', message: 'rejected execution-run host-action approval requires reject' });
  }
  if (value.status === 'canceled' && value.decision) {
    ctx.addIssue({ code: 'custom', message: 'canceled execution-run host-action approval cannot contain a decision' });
  }
  if (value.status === 'executed' || value.status === 'failed') {
    ctx.addIssue({ code: 'custom', message: 'execution-run host-action approval records current intent, not execution state' });
  }
  const encodedBytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  if (encodedBytes > EXECUTION_RUN_HOST_ACTION_APPROVAL_LIMITS_V1.artifactJsonBytes) {
    ctx.addIssue({ code: 'custom', message: 'execution-run host-action approval artifact byte limit exceeded' });
  }
});

export type ExecutionRunHostActionApprovalRequestV1 = z.infer<typeof ExecutionRunHostActionApprovalRequestV1Schema>;
