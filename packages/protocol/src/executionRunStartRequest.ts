import { z } from 'zod';

import { BackendTargetRefSchema } from './backendTargets/backendTargetRef.js';
import { ConnectedServiceBindingsV1Schema } from './connect/connectedServiceBindings.js';
import { HappierReplayStrategySchema } from './sessionContinueWithReplay.js';
import { LlmTaskRunnerConfigV1Schema } from './llmTasks/llmTaskRunnerConfigV1.js';
import { AcpConfigOptionOverridesV1Schema } from './sessionMetadata/metadataOverridesV1.js';
import {
  HappierReplayRecentMessagesCountSchema,
  HappierReplayWireMaxSeedCharsSchema,
} from './replaySeedBudget.js';

export const ExecutionRunIntentSchema = z.enum([
  'review',
  'plan',
  'delegate',
  'voice_agent',
  'memory_hints',
]);
export type ExecutionRunIntent = z.infer<typeof ExecutionRunIntentSchema>;

export const ExecutionRunRetentionPolicySchema = z.enum(['ephemeral', 'resumable']);
export type ExecutionRunRetentionPolicy = z.infer<typeof ExecutionRunRetentionPolicySchema>;

export const ExecutionRunClassSchema = z.enum(['bounded', 'long_lived']);
export type ExecutionRunClass = z.infer<typeof ExecutionRunClassSchema>;

export const ExecutionRunIoModeSchema = z.enum(['request_response', 'streaming']);
export type ExecutionRunIoMode = z.infer<typeof ExecutionRunIoModeSchema>;

export function normalizeLegacyExecutionRunBackendTargetInput(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  if (record.backendTarget !== undefined) {
    return value;
  }
  const legacyBackendId = typeof record.backendId === 'string' ? record.backendId.trim() : '';
  if (!legacyBackendId) {
    return value;
  }
  return {
    ...record,
    backendTarget: {
      kind: 'builtInAgent',
      agentId: legacyBackendId,
    },
  };
}

const ExecutionRunResumeHandleVendorSessionV1SchemaCore = z.object({
  kind: z.literal('vendor_session.v1'),
  backendTarget: BackendTargetRefSchema,
  vendorSessionId: z.string().min(1),
}).passthrough();
export const ExecutionRunResumeHandleVendorSessionV1Schema = z.preprocess(
  normalizeLegacyExecutionRunBackendTargetInput,
  ExecutionRunResumeHandleVendorSessionV1SchemaCore,
);
export type ExecutionRunResumeHandleVendorSessionV1 = z.infer<typeof ExecutionRunResumeHandleVendorSessionV1Schema>;

const ExecutionRunResumeHandleVoiceAgentSessionsV1SchemaCore = z.object({
  kind: z.literal('voice_agent_sessions.v1'),
  backendTarget: BackendTargetRefSchema,
  chatVendorSessionId: z.string().min(1),
  commitVendorSessionId: z.string().min(1),
}).passthrough();
export const ExecutionRunResumeHandleVoiceAgentSessionsV1Schema = z.preprocess(
  normalizeLegacyExecutionRunBackendTargetInput,
  ExecutionRunResumeHandleVoiceAgentSessionsV1SchemaCore,
);
export type ExecutionRunResumeHandleVoiceAgentSessionsV1 = z.infer<typeof ExecutionRunResumeHandleVoiceAgentSessionsV1Schema>;

const ExecutionRunResumeHandleSchemaCore = z.discriminatedUnion('kind', [
  ExecutionRunResumeHandleVendorSessionV1SchemaCore,
  ExecutionRunResumeHandleVoiceAgentSessionsV1SchemaCore,
]);
export const ExecutionRunResumeHandleSchema = z.preprocess(
  normalizeLegacyExecutionRunBackendTargetInput,
  ExecutionRunResumeHandleSchemaCore,
);
export type ExecutionRunResumeHandle = z.infer<typeof ExecutionRunResumeHandleSchema>;

export const ExecutionRunDisplaySchema = z.object({
  /**
   * Optional user-facing label/title for the run (used for future group chat + participant labeling).
   */
  title: z.string().min(1).max(200).optional(),
  /**
   * Optional short participant label (e.g. "Reviewer A") for merged/group views.
   */
  participantLabel: z.string().min(1).max(80).optional(),
  /**
   * Optional group ID used to render multiple runs as a logical "group chat" in UI.
   */
  groupId: z.string().min(1).max(120).optional(),
}).passthrough();
export type ExecutionRunDisplay = z.infer<typeof ExecutionRunDisplaySchema>;

export const ExecutionRunReplaySeedRequestSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('voice_session.v1'),
    previousSessionId: z.string().min(1),
    transcriptEpoch: z.number().int().min(0),
    strategy: HappierReplayStrategySchema.optional(),
    recentMessagesCount: HappierReplayRecentMessagesCountSchema.optional(),
    maxSeedChars: HappierReplayWireMaxSeedCharsSchema.optional(),
    summaryRunner: LlmTaskRunnerConfigV1Schema.optional(),
    // CL-2: passthrough like every sibling wire schema in this file — a newer peer adding a replay
    // field must not make an older daemon reject the ENTIRE run-start request.
  }).passthrough(),
]);
export type ExecutionRunReplaySeedRequest = z.infer<typeof ExecutionRunReplaySeedRequestSchema>;

export const ExecutionRunStartRequestSchema = z.object({
  intent: ExecutionRunIntentSchema,
  backendTarget: BackendTargetRefSchema,
  instructions: z.string().optional(),
  display: ExecutionRunDisplaySchema.optional(),
  permissionMode: z.string().min(1),
  retentionPolicy: ExecutionRunRetentionPolicySchema,
  runClass: ExecutionRunClassSchema,
  ioMode: ExecutionRunIoModeSchema,
  initialContextMode: z.enum(['bootstrap', 'first_turn']).optional(),
  /**
   * Optional model selection for the run's backend, using the SAME canonical shape as session
   * spawn (`session.spawn_new`'s `modelId`). Threaded to the spawned backend exactly like a
   * session spawn's model. Omit to use the backend's default model.
   */
  modelId: z.string().min(1).optional(),
  /**
   * Optional per-run config-option overrides using the SAME canonical vocabulary as session spawn
   * (`sessionConfigOptionOverrides`). Reasoning effort is the `reasoning_effort` option here. The
   * agent-friendly `configOptions` shorthand is normalized/merged into this canonical shape at the
   * action boundary. Omit to keep the backend's configured defaults.
   */
  sessionConfigOptionOverrides: AcpConfigOptionOverridesV1Schema.optional(),
  resumeHandle: ExecutionRunResumeHandleSchema.nullable().optional(),
  replay: ExecutionRunReplaySeedRequestSchema.optional(),
  /**
   * Optional per-target connected-services selection for the run (profile|group per serviceId).
   * Absent means the run defaults exactly like session spawn defaulting (account defaults).
   */
  connectedServices: ConnectedServiceBindingsV1Schema.optional(),
  /**
   * Bare per-service default tokens (RO-F5): serviceIds asking for their STORED account default. Set by
   * the action boundary alongside `connectedServices` so the run-start owner resolves each named
   * service's stored default and merges it UNDER explicit pins. Mixed bare+explicit thus resolves
   * instead of failing closed. Missing stored default fails closed at the run-start owner.
   */
  connectedServicesDefaultServiceIds: z.array(z.string()).optional(),
}).passthrough();
export type ExecutionRunStartRequest = z.infer<typeof ExecutionRunStartRequestSchema>;

export const ExecutionRunStartResponseSchema = z.object({
  runId: z.string().min(1),
  callId: z.string().min(1),
  sidechainId: z.string().min(1),
}).passthrough();
export type ExecutionRunStartResponse = z.infer<typeof ExecutionRunStartResponseSchema>;
