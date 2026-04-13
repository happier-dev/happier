import { z } from 'zod';

import {
  BackendTargetRefV2Schema,
  normalizeBackendTargetRefV2InputToV2,
} from './backendTargets/backendTargetRefV2.js';
import { LlmTaskRunnerConfigV1Schema } from './llmTasks/llmTaskRunnerConfigV1.js';

export const HappierReplayStrategySchema = z.enum(['recent_messages', 'summary_plus_recent']);
export type HappierReplayStrategy = z.infer<typeof HappierReplayStrategySchema>;

export const HappierReplayDialogItemSchema = z
  .object({
    role: z.enum(['User', 'Assistant']),
    createdAt: z.number().finite(),
    text: z.string().min(1).max(50_000),
  })
  .strict();
export type HappierReplayDialogItem = z.infer<typeof HappierReplayDialogItemSchema>;

export const HappierReplaySeedModeSchema = z.enum(['draft', 'daemon_initial_prompt']);
export type HappierReplaySeedMode = z.infer<typeof HappierReplaySeedModeSchema>;

export const SessionContinueWithReplayRequestSchema = z
  .object({
    previousSessionId: z.string().min(1),
    strategy: HappierReplayStrategySchema.optional(),
    recentMessagesCount: z.number().int().min(1).max(500).optional(),
    maxSeedChars: z.number().int().min(200).max(200_000).optional(),
    seedMode: HappierReplaySeedModeSchema.optional(),
    summaryRunner: LlmTaskRunnerConfigV1Schema.optional(),
  })
  .strict();
export type SessionContinueWithReplayRequest = z.infer<typeof SessionContinueWithReplayRequestSchema>;

export const SessionContinueWithReplayRpcParamsSchema = z
  .object({
    directory: z.string().min(1),
    agent: z.string().min(1).optional(),
    backendTarget: z.preprocess(normalizeBackendTargetRefV2InputToV2, BackendTargetRefV2Schema.optional()),
    approvedNewDirectoryCreation: z.boolean().optional(),
    permissionMode: z.string().optional(),
    permissionModeUpdatedAt: z.number().finite().optional(),
    modelId: z.string().optional(),
    modelUpdatedAt: z.number().finite().optional(),
    replay: SessionContinueWithReplayRequestSchema,
  })
  .superRefine((value, ctx) => {
    if (!value.agent && !value.backendTarget) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'agent or backendTarget is required',
        path: ['agent'],
      });
      return;
    }

    if (value.backendTarget && (value.backendTarget.backendId === 'customAcp' || value.backendTarget.configuredBackendId === 'customAcp')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'backendTarget must identify a concrete backend; use kind=configuredAcpBackend for configured ACP backends',
        path: ['backendTarget'],
      });
      return;
    }

    if (value.agent === 'customAcp' && !value.backendTarget) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'backendTarget is required for customAcp',
        path: ['backendTarget'],
      });
      return;
    }

    if (value.agent && value.backendTarget) {
      const expectedAgent = value.backendTarget.backendId;
      if (value.agent !== expectedAgent) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'agent must match backendTarget when both are provided',
          path: ['agent'],
        });
      }
    }
  })
  .strict();
export type SessionContinueWithReplayRpcParams = z.infer<typeof SessionContinueWithReplayRpcParamsSchema>;

export const SessionContinueWithReplayRpcResultSchema = z.union([
  z.object({ type: z.literal('success'), sessionId: z.string().min(1) }).passthrough(),
  z.object({ type: z.literal('requestToApproveDirectoryCreation'), directory: z.string().min(1) }).passthrough(),
  z.object({ type: z.literal('error'), errorCode: z.string().min(1), errorMessage: z.string().min(1) }).passthrough(),
]);
export type SessionContinueWithReplayRpcResult = z.infer<typeof SessionContinueWithReplayRpcResultSchema>;
