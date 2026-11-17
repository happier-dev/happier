import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

import {
  BackendTargetRefV2Schema,
  normalizeBackendTargetRefV2InputToV2,
} from '../backends/targets/backendTargetRefV2.js';
import { LlmTaskRunnerConfigV1Schema } from '../llm/tasks/llmTaskRunnerConfigV1.js';
import { SessionModelSelectionSchema } from '../providers/selection/v2.js';
import { ApprovalProfileIdV1Schema } from '../actions/approvalProfiles.js';
import {
  HappierReplayRecentMessagesCountSchema,
  HappierReplayWireMaxSeedCharsSchema,
} from './replaySeedBudget.js';

export const HappierReplayStrategySchema = lazyZodSchema(() => z.enum(['recent_messages', 'summary_plus_recent']));
export type HappierReplayStrategy = z.infer<typeof HappierReplayStrategySchema>;

export const HappierReplayDialogItemSchema = lazyZodSchema(() => z.strictObject({
    role: z.enum(['User', 'Assistant']),
    createdAt: z.number(),
    text: z.string().check(z.minLength(1), z.maxLength(50_000)),
  }));
export type HappierReplayDialogItem = z.infer<typeof HappierReplayDialogItemSchema>;

export const HappierReplaySeedModeSchema = lazyZodSchema(() => z.enum(['draft', 'daemon_initial_prompt']));
export type HappierReplaySeedMode = z.infer<typeof HappierReplaySeedModeSchema>;

export const SessionContinueWithReplayRequestSchema = lazyZodSchema(() => z.strictObject({
    previousSessionId: z.string().check(z.minLength(1)),
    strategy: z.optional(HappierReplayStrategySchema),
    recentMessagesCount: z.optional(HappierReplayRecentMessagesCountSchema),
    maxSeedChars: z.optional(HappierReplayWireMaxSeedCharsSchema),
    seedMode: z.optional(HappierReplaySeedModeSchema),
    summaryRunner: z.optional(LlmTaskRunnerConfigV1Schema),
  }));
export type SessionContinueWithReplayRequest = z.infer<typeof SessionContinueWithReplayRequestSchema>;

export const SessionContinueWithReplayRpcParamsSchema = lazyZodSchema(() => z.looseObject({
    directory: z.string().check(z.minLength(1)),
    backendTarget: (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform(normalizeBackendTargetRefV2InputToV2), BackendTargetRefV2Schema),
    approvedNewDirectoryCreation: z.optional(z.boolean()),
    permissionMode: z.optional(z.string()),
    permissionModeUpdatedAt: z.optional(z.number()),
    modelSelection: z.optional(SessionModelSelectionSchema),
    approvalProfileId: z.optional(z.nullable(ApprovalProfileIdV1Schema)),
    replay: SessionContinueWithReplayRequestSchema,
  }).check(z.superRefine((value, ctx) => {
    if (typeof (value as { agent?: unknown }).agent === 'string') {
      ctx.addIssue({
        code: "custom",
        message: 'agent is a legacy compatibility carrier; use backendTarget',
        path: ['agent'],
      });
    }
  })));
export type SessionContinueWithReplayRpcParams = z.infer<typeof SessionContinueWithReplayRpcParamsSchema>;

export const SessionContinueWithReplayRpcResultSchema = lazyZodSchema(() => z.union([
  z.looseObject({ type: z.literal('success'), sessionId: z.string().check(z.minLength(1)) }),
  z.looseObject({ type: z.literal('requestToApproveDirectoryCreation'), directory: z.string().check(z.minLength(1)) }),
  z.looseObject({ type: z.literal('error'), errorCode: z.string().check(z.minLength(1)), errorMessage: z.string().check(z.minLength(1)) }),
]));
export type SessionContinueWithReplayRpcResult = z.infer<typeof SessionContinueWithReplayRpcResultSchema>;
