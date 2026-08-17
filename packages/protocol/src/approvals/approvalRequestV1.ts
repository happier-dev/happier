import { z } from 'zod';
import { asProtocolZod } from "../plugins/actions/internalProtocolZodAdapter.js";

import { ActionApprovalSchema } from '../actions/actionApprovalMetadata.js';
import { ActionIdSchema } from '../actions/actionIds.js';
import { PluginContributionLocalIdSchema } from '../plugins/contributionIdentity.js';
import { PluginIdSchema } from '../plugins/pluginId.js';
import {
  SessionCreationDirectoryApprovalV1Schema,
} from '../sessions/creation/sessionCreationTargetPreparationV1.js';

export const ApprovalRequestStatusSchema = z.enum(['open', 'approved', 'rejected', 'executed', 'failed', 'canceled']);
export type ApprovalRequestStatus = z.infer<typeof ApprovalRequestStatusSchema>;

const ApprovalRequestedSurfaceSchema = z.string().min(1);

export const ApprovalRequestOriginV1Schema = z.object({
  kind: z.literal('transcript_tool_call'),
  sessionId: z.string().min(1),
  messageId: z.string().min(1).optional(),
  parentMessageId: z.string().min(1).optional(),
  toolCallId: z.string().min(1).optional(),
  mcpRequestId: z.string().min(1).optional(),
  toolName: z.string().min(1).optional(),
  toolInput: z.unknown().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.messageId || value.parentMessageId || value.toolCallId || value.toolName) {
    return;
  }
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: ['origin'],
    message: 'transcript tool-call approval origins require a messageId, parentMessageId, toolCallId, or toolName',
  });
});
export type ApprovalRequestOriginV1 = z.infer<typeof ApprovalRequestOriginV1Schema>;

export const ApprovalRequestCreatedBySchema = z.object({
  surface: z.enum(['voice', 'agent', 'session_agent', 'mcp', 'cli', 'system']),
  agentId: z.string().min(1).optional(),
  pluginId: asProtocolZod(PluginIdSchema).optional(),
  contributionLocalId: asProtocolZod(PluginContributionLocalIdSchema).optional(),
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
  requestedSurface: ApprovalRequestedSurfaceSchema.optional(),
  origin: ApprovalRequestOriginV1Schema.optional(),
  approval: ActionApprovalSchema.optional(),
  actionId: ActionIdSchema,
  actionArgs: z.unknown(),
  summary: z.string().min(1),
  preview: z.unknown().optional(),
  /**
   * Host-stamped target evidence for a deferred `session.spawn_new` directory
   * creation approval. It is not Action input and cannot authorize another
   * Action family.
   */
  sessionCreationDirectoryApproval: SessionCreationDirectoryApprovalV1Schema.optional(),
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

  if (!requiresExecution && value.execution != null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['execution'],
      message: `status ${value.status} must not include execution metadata`,
    });
  }

  if ((value.status === 'approved' || value.status === 'executed' || value.status === 'failed')
    && value.decision?.kind !== 'approve') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['decision'],
      message: `status ${value.status} requires an approve decision`,
    });
  }

  if (value.status === 'rejected' && value.decision?.kind !== 'reject') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['decision'],
      message: 'status rejected requires a reject decision',
    });
  }

  if (value.status === 'canceled' && value.decision != null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['decision'],
      message: 'canceled approval requests must not include a decision',
    });
  }

  if (value.status === 'executed' && value.execution?.ok !== true) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['execution'],
      message: 'status executed requires a successful execution result',
    });
  }

  if (value.status === 'failed' && value.execution?.ok !== false) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['execution'],
      message: 'status failed requires a failed execution result',
    });
  }

  if (value.sessionCreationDirectoryApproval !== undefined && value.actionId !== 'session.spawn_new') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['sessionCreationDirectoryApproval'],
      message: 'Directory creation approval evidence belongs only to session.spawn_new.',
    });
  }
});
export type ApprovalRequestV1 = z.infer<typeof ApprovalRequestV1Schema>;
