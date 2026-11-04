import { maxCodeUnits } from '../strings/maxCodeUnits.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';
import { createStoredReadSchema } from '../json/storedReadSchema.js';
import { sameStrictJsonValue } from '../json/strictJsonValue.js';

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

const boundedId = z.string().check(z.trim(), z.minLength(1), maxCodeUnits(EXECUTION_RUN_HOST_ACTION_APPROVAL_LIMITS_V1.idUtf16Units));

const ExecutionRunHostActionProposalPreviewV1Schema = lazyZodSchema(() => z.strictObject({
  findingId: z.optional(boundedId),
  pathLabel: z.string().check(z.trim(), z.minLength(1), z.maxLength(512)),
  pathSha256: z.string().check(z.regex(/^[a-f0-9]{64}$/)),
  startLine: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(Number.MAX_SAFE_INTEGER))),
  endLine: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(Number.MAX_SAFE_INTEGER))),
  severity: z.optional(z.enum(['info', 'warning', 'error', 'critical'])),
  bodySha256: z.string().check(z.regex(/^[a-f0-9]{64}$/)),
  bodyPreview: z.string().check(z.trim(), z.minLength(1), z.maxLength(1_024)),
}).check(z.superRefine((value, ctx) => {
  if ((value.startLine === undefined) !== (value.endLine === undefined)) {
    ctx.addIssue({ code: 'custom', message: 'proposal preview line range must be complete' });
  }
  if (value.startLine !== undefined && value.endLine !== undefined && value.endLine < value.startLine) {
    ctx.addIssue({ code: 'custom', message: 'proposal preview endLine must be greater than or equal to startLine' });
  }
})));

export const ExecutionRunHostActionApprovalRequestV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  kind: z.literal('execution_run_host_action'),
  status: ApprovalRequestStatusSchema,
  createdAtMs: z.number().check(z.int(), z.minimum(0)),
  updatedAtMs: z.number().check(z.int(), z.minimum(0)),
  createdBy: ApprovalRequestCreatedBySchema,
  requestedSurface: z.string().check(z.trim(), z.minLength(1), maxCodeUnits(EXECUTION_RUN_HOST_ACTION_APPROVAL_LIMITS_V1.surfaceUtf16Units)),
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
  proposalCount: z.number().check(z.int(), z.minimum(1), z.maximum(200)),
  proposalPreview: z.array(ExecutionRunHostActionProposalPreviewV1Schema).check(z.maxLength(20)),
  subjectFingerprint: z.string().check(z.regex(/^[a-f0-9]{64}$/)),
  summary: z.string().check(z.trim(), z.minLength(1), maxCodeUnits(EXECUTION_RUN_HOST_ACTION_APPROVAL_LIMITS_V1.summaryUtf16Units)),
  decision: z.optional(ApprovalDecisionV1Schema),
}).check(z.superRefine((value, ctx) => {
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
})));

export type ExecutionRunHostActionApprovalRequestV1 = z.infer<typeof ExecutionRunHostActionApprovalRequestV1Schema>;
export const StoredExecutionRunHostActionApprovalRequestV1Schema = createStoredReadSchema(ExecutionRunHostActionApprovalRequestV1Schema);

/** The ordinary Action RPC returns this inner settlement, not an executor envelope. */
export const ExecutionRunHostActionApprovalSettlementV1Schema = lazyZodSchema(() => z.strictObject({
  ok: z.literal(true),
  status: z.enum(['approved', 'rejected', 'canceled']),
}));

/** Status and decision are observations; every other admitted field binds the live subject. */
export function executionRunHostActionApprovalSubjectsEqual(left: ExecutionRunHostActionApprovalRequestV1, right: ExecutionRunHostActionApprovalRequestV1): boolean {
  const { status: _leftStatus, updatedAtMs: _leftUpdated, decision: _leftDecision, ...leftSubject } = left;
  const { status: _rightStatus, updatedAtMs: _rightUpdated, decision: _rightDecision, ...rightSubject } = right;
  return sameStrictJsonValue(leftSubject, rightSubject);
}
