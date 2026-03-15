import { z } from 'zod';

import { LlmTaskRunnerConfigV1Schema } from './llmTasks/llmTaskRunnerConfigV1.js';

export const SessionForkStrategySchema = z.enum(['auto', 'provider_native', 'acp_fork_latest', 'replay']);
export type SessionForkStrategy = z.infer<typeof SessionForkStrategySchema>;

export const SessionForkPointSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('latest') }).strict(),
  z
    .object({
      type: z.literal('seq'),
      upToSeqInclusive: z.number().int().nonnegative(),
    })
    .strict(),
]);
export type SessionForkPoint = z.infer<typeof SessionForkPointSchema>;

export const SessionForkRpcParamsSchema = z
  .object({
    v: z.literal(1),
    parentSessionId: z.string().min(1),
    forkPoint: SessionForkPointSchema,
    strategy: SessionForkStrategySchema.optional(),
    replaySummaryRunner: LlmTaskRunnerConfigV1Schema.optional(),
    replayMaxSeedChars: z.number().int().min(200).max(200_000).optional(),
  })
  .strict();
export type SessionForkRpcParams = z.infer<typeof SessionForkRpcParamsSchema>;

export const SessionForkRpcResultSchema = z.union([
  z.object({ ok: z.literal(true), childSessionId: z.string().min(1) }).passthrough(),
  z.object({ ok: z.literal(false), errorCode: z.string().min(1), errorMessage: z.string().min(1) }).passthrough(),
]);
export type SessionForkRpcResult = z.infer<typeof SessionForkRpcResultSchema>;
