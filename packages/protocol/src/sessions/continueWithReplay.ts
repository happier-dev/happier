import { z } from 'zod';

import {
  BackendTargetRefV2Schema,
  normalizeBackendTargetRefV2InputToV2,
} from '../backends/targets/backendTargetRefV2.js';
import { LlmTaskRunnerConfigV1Schema } from '../llm/tasks/llmTaskRunnerConfigV1.js';
import { SessionModelSelectionV1Schema } from '../providers/selection/v1.js';
import {
  HappierReplayRecentMessagesCountSchema,
  HappierReplayWireMaxSeedCharsSchema,
} from './replaySeedBudget.js';

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
    recentMessagesCount: HappierReplayRecentMessagesCountSchema.optional(),
    maxSeedChars: HappierReplayWireMaxSeedCharsSchema.optional(),
    seedMode: HappierReplaySeedModeSchema.optional(),
    summaryRunner: LlmTaskRunnerConfigV1Schema.optional(),
  })
  .strict();
export type SessionContinueWithReplayRequest = z.infer<typeof SessionContinueWithReplayRequestSchema>;

export const SessionContinueWithReplayRpcParamsSchema = z
  .object({
    directory: z.string().min(1),
    backendTarget: z.preprocess(normalizeBackendTargetRefV2InputToV2, BackendTargetRefV2Schema),
    approvedNewDirectoryCreation: z.boolean().optional(),
    permissionMode: z.string().optional(),
    permissionModeUpdatedAt: z.number().finite().optional(),
    modelSelection: SessionModelSelectionV1Schema.optional(),
    replay: SessionContinueWithReplayRequestSchema,
  })
  .passthrough()
  .superRefine((value, ctx) => {
    if (typeof (value as { agent?: unknown }).agent === 'string') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'agent is a legacy compatibility carrier; use backendTarget',
        path: ['agent'],
      });
    }
  });
export type SessionContinueWithReplayRpcParams = z.infer<typeof SessionContinueWithReplayRpcParamsSchema>;

export const SessionContinueWithReplayRpcResultSchema = z.union([
  z.object({ type: z.literal('success'), sessionId: z.string().min(1) }).passthrough(),
  z.object({ type: z.literal('requestToApproveDirectoryCreation'), directory: z.string().min(1) }).passthrough(),
  z.object({ type: z.literal('error'), errorCode: z.string().min(1), errorMessage: z.string().min(1) }).passthrough(),
]);
export type SessionContinueWithReplayRpcResult = z.infer<typeof SessionContinueWithReplayRpcResultSchema>;
