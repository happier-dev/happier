import { z } from 'zod';

import { LlmTaskRunnerConfigV1Schema } from '../llm/tasks/llmTaskRunnerConfigV1.js';
import { SessionForkPointSchema, type SessionForkPoint } from './forkPoint.js';
import { HappierReplayWireMaxSeedCharsSchema } from './replaySeedBudget.js';

/**
 * The cutoff is owned by the zero-dependency `./forkPoint.js` module, but this
 * stays its canonical import site so existing importers and the protocol index
 * entry are unchanged. One import, one re-export — no duplicate module
 * specifier for tooling to trip on.
 */
export { SessionForkPointSchema, type SessionForkPoint };

/**
 * `native` is the generic user intent: "fork natively, and do NOT silently fall
 * back to Replay". The lifecycle owner maps it onto its existing
 * provider-native / ACP-native attempts and returns the existing unsupported
 * result when no native path is usable; the UI does not reproduce that policy.
 *
 * `auto`, `provider_native`, and `acp_fork_latest` remain as compatibility and
 * diagnostic strategies for existing non-UI callers.
 *
 * Mixed-version note: this enum sits inside a `.strict()` params object, so a
 * daemon that predates `native` REJECTS the whole request rather than
 * downgrading it to `auto` and risking an unrequested Replay fork. Clients gate
 * the Native card locally, on `resolveSessionForkStrategyAvailability`, which is
 * strictly tighter than Agent capability alone: it also requires a usable fork
 * point and excludes Provider-bound Sessions, whose fork lifecycle refuses every
 * non-replay strategy.
 */
export const SessionForkStrategySchema = z.enum([
  'auto',
  'native',
  'provider_native',
  'acp_fork_latest',
  'replay',
]);
export type SessionForkStrategy = z.infer<typeof SessionForkStrategySchema>;

export const SessionForkRpcParamsSchema = z
  .object({
    v: z.literal(1),
    parentSessionId: z.string().min(1),
    forkPoint: SessionForkPointSchema,
    strategy: SessionForkStrategySchema.optional(),
    replaySummaryRunner: LlmTaskRunnerConfigV1Schema.optional(),
    replayMaxSeedChars: HappierReplayWireMaxSeedCharsSchema.optional(),
    /**
     * Stable idempotency key for the fork request. Retries of the SAME user
     * action (e.g. transport-timeout retries inside the machine RPC layer)
     * MUST reuse it so the daemon can coalesce them onto the in-flight fork
     * instead of committing a second provider-side fork.
     *
     * Ported from the predecessor tree, which already ships it. Until this
     * lands, a predecessor client sending `requestId` is rejected outright by
     * this `.strict()` schema; accepting it is a compatibility repair, and no
     * caller is required to send it.
     */
    requestId: z.string().min(1).max(128).refine((value) => value.trim().length > 0).optional(),
  })
  .strict();
export type SessionForkRpcParams = z.infer<typeof SessionForkRpcParamsSchema>;

export const SessionForkRpcResultSchema = z.union([
  z.object({ ok: z.literal(true), childSessionId: z.string().min(1) }).strict(),
  z.object({ ok: z.literal(false), errorCode: z.string().min(1), errorMessage: z.string().min(1) }).strict(),
]);
export type SessionForkRpcResult = z.infer<typeof SessionForkRpcResultSchema>;
