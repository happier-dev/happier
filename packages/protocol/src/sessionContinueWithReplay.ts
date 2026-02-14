import { z } from 'zod';

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
    recentMessagesCount: z.number().int().min(1).max(100).optional(),
    seedMode: HappierReplaySeedModeSchema.optional(),
  })
  .strict();
export type SessionContinueWithReplayRequest = z.infer<typeof SessionContinueWithReplayRequestSchema>;

export const SessionContinueWithReplayRpcParamsSchema = z
  .object({
    directory: z.string().min(1),
    agent: z.string().min(1),
    approvedNewDirectoryCreation: z.boolean().optional(),
    permissionMode: z.string().optional(),
    permissionModeUpdatedAt: z.number().finite().optional(),
    modelId: z.string().optional(),
    modelUpdatedAt: z.number().finite().optional(),
    replay: SessionContinueWithReplayRequestSchema,
  })
  .strict();
export type SessionContinueWithReplayRpcParams = z.infer<typeof SessionContinueWithReplayRpcParamsSchema>;

export const SessionContinueWithReplayRpcResultSchema = z.union([
  z.object({ type: z.literal('success'), sessionId: z.string().min(1), seedDraft: z.string().min(1) }).passthrough(),
  z.object({ type: z.literal('requestToApproveDirectoryCreation'), directory: z.string().min(1) }).passthrough(),
  z.object({ type: z.literal('error'), errorCode: z.string().min(1), errorMessage: z.string().min(1) }).passthrough(),
]);
export type SessionContinueWithReplayRpcResult = z.infer<typeof SessionContinueWithReplayRpcResultSchema>;
