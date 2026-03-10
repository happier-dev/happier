import { z } from 'zod';

import { ActionIdSchema } from '../actions/actionIds.js';

export const ApprovalRequestStatusSchema = z.enum(['open', 'approved', 'rejected', 'executed', 'failed', 'canceled']);
export type ApprovalRequestStatus = z.infer<typeof ApprovalRequestStatusSchema>;

export const ApprovalRequestCreatedBySchema = z.object({
  surface: z.enum(['voice', 'session_agent', 'mcp', 'system']),
  agentId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
}).strict();
export type ApprovalRequestCreatedBy = z.infer<typeof ApprovalRequestCreatedBySchema>;

export const ApprovalDecisionV1Schema = z.object({
  kind: z.enum(['approve', 'reject']),
  decidedAtMs: z.number().int().min(0),
}).passthrough();
export type ApprovalDecisionV1 = z.infer<typeof ApprovalDecisionV1Schema>;

export const ApprovalExecutionV1Schema = z.object({
  executedAtMs: z.number().int().min(0),
  ok: z.boolean(),
  result: z.unknown().optional(),
  errorCode: z.string().min(1).optional(),
  error: z.string().min(1).optional(),
}).passthrough();
export type ApprovalExecutionV1 = z.infer<typeof ApprovalExecutionV1Schema>;

export const ApprovalRequestV1Schema = z.object({
  v: z.literal(1),
  status: ApprovalRequestStatusSchema,
  createdAtMs: z.number().int().min(0),
  updatedAtMs: z.number().int().min(0),
  createdBy: ApprovalRequestCreatedBySchema,
  actionId: ActionIdSchema,
  actionArgs: z.unknown(),
  summary: z.string().min(1),
  preview: z.unknown().optional(),
  decision: ApprovalDecisionV1Schema.optional(),
  execution: ApprovalExecutionV1Schema.optional(),
}).passthrough().superRefine((value, ctx) => {
  const requiresDecision = value.status === 'approved'
    || value.status === 'rejected'
    || value.status === 'executed'
    || value.status === 'failed';
  const requiresExecution = value.status === 'executed' || value.status === 'failed';

  if (value.status === 'open') {
    if (value.decision != null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['decision'],
        message: 'open approval requests must not include a decision',
      });
    }
    if (value.execution != null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['execution'],
        message: 'open approval requests must not include execution metadata',
      });
    }
  }

  if (requiresDecision && value.decision == null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['decision'],
      message: `status ${value.status} requires a decision`,
    });
  }

  if (requiresExecution && value.execution == null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['execution'],
      message: `status ${value.status} requires execution metadata`,
    });
  }
});
export type ApprovalRequestV1 = z.infer<typeof ApprovalRequestV1Schema>;
