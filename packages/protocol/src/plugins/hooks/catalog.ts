import { z } from 'zod';

import { ActionIdSchema } from '../../actions/actionIds.js';
import { ApprovalRequestCreatedBySchema } from '../../approvals/approvalRequestV1.js';
import { BackendTargetKeySchema } from '../../backends/targets/backendTargetRef.js';
import { BackendTargetRefV2Schema } from '../../backends/targets/backendTargetRefV2.js';
import {
  ExecutionRunClassSchema,
  ExecutionRunIntentSchema,
  ExecutionRunIoModeSchema,
  ExecutionRunRetentionPolicySchema,
} from '../../execution/runs/startRequest.js';
import {
  HookCategoryV1Schema,
  type HookCategoryV1,
} from '../../hooks/hookCategories.js';
import {
  HookExecutionKindV1Schema,
  type HookExecutionKindV1,
  resolveHookExecutionKindForCategoryV1,
} from '../../hooks/hookExecutionSemantics.js';
import { MemorySearchModeSchema } from '../../memory/memorySearch.js';
import { SubagentRefV1Schema } from '../../sessions/subagents/subagentRefV1.js';

export const PLUGIN_HOOK_IDS_V1 = [
  'session.spawned',
  'session.message.send',
  'session.input.transform',
  'executionRun.started',
  'executionRun.messageSent',
  'executionRun.stopped',
  'executionRun.completed',
  'agent.resolvePrerequisites',
  'agent.spawnEnv.augment',
  'agent.response.after',
  'agent.context.before',
  'agent.request.before',
  'agent.stream.token',
  'tool.call.before',
  'tool.result.after',
  'resource.discovery',
  'plugin.reload.before',
  'plugin.reload.after',
  'session.attached',
  'session.detached',
  'voice.session.started',
  'voice.session.ended',
  'voice.turn.started',
  'voice.turn.ended',
  'voice.transcript.partial',
  'voice.transcript.final',
  'memory.shard.generated',
  'memory.search.performed',
  'memory.index.updated',
  'memory.gc.performed',
  'automation.scheduled',
  'automation.claimed',
  'automation.run.started',
  'automation.run.succeeded',
  'automation.run.failed',
  'automation.run.expired',
  'approval.decision.made',
  'subagent.started',
  'subagent.ended',
] as const;
export const PluginHookIdV1Schema = z.enum(PLUGIN_HOOK_IDS_V1);
export type PluginHookIdV1 = z.infer<typeof PluginHookIdV1Schema>;

export const PluginHookScopeV1Schema = z.enum([
  'machine',
  'project',
  'session',
  'agent',
  'daemon',
  'tool',
  'resource',
  'plugin',
]);
export type PluginHookScopeV1 = z.infer<typeof PluginHookScopeV1Schema>;

export const PluginHookAggregationKindV1Schema = z.enum([
  'none',
  'orderedList',
  'mergeObject',
  'firstDecision',
  'allDecisions',
  'replace',
]);
export type PluginHookAggregationKindV1 = z.infer<typeof PluginHookAggregationKindV1Schema>;

export const PluginHookFailureModeV1Schema = z.enum(['bestEffort', 'failClosed']);
export type PluginHookFailureModeV1 = z.infer<typeof PluginHookFailureModeV1Schema>;

export const PluginHookPurityV1Schema = z.enum(['observer', 'participant']);
export type PluginHookPurityV1 = z.infer<typeof PluginHookPurityV1Schema>;

export const PluginHookSupportedRuntimeFamilyV1Schema = z.enum([
  'hostSession',
  'acpSession',
  'pluginSession',
  'executionRun',
]);
export type PluginHookSupportedRuntimeFamilyV1 = z.infer<typeof PluginHookSupportedRuntimeFamilyV1Schema>;

export const PluginHookDefinitionV1Schema = z.object({
  id: PluginHookIdV1Schema,
  category: HookCategoryV1Schema,
  scope: PluginHookScopeV1Schema,
  executionKind: HookExecutionKindV1Schema,
  aggregation: PluginHookAggregationKindV1Schema,
  failureMode: PluginHookFailureModeV1Schema,
  purity: PluginHookPurityV1Schema.optional(),
  supportedRuntimes: z.array(PluginHookSupportedRuntimeFamilyV1Schema).default([]),
  payloadSchema: z.record(z.string(), z.unknown()).default({}),
  resultSchema: z.record(z.string(), z.unknown()).default({}),
}).strict();
export type PluginHookDefinitionV1 = z.infer<typeof PluginHookDefinitionV1Schema>;

const NonEmptyStringSchema = z.string().min(1);
const TimestampMsSchema = z.number().int().min(0);
const RequiredUnknownSchema = z.unknown().refine((value) => value !== undefined, {
  message: 'Required',
});

export const SessionSpawnedHookPayloadV1Schema = z.object({
  sessionId: NonEmptyStringSchema,
  agentId: NonEmptyStringSchema,
  runtimeTarget: BackendTargetRefV2Schema,
  modelId: NonEmptyStringSchema.optional(),
  cwd: z.string().optional(),
  initialMessage: z.string().optional(),
  tag: z.string().optional(),
  host: z.string().optional(),
  machineId: z.string().optional(),
  timestampMs: TimestampMsSchema,
}).passthrough();

export const SessionMessageSendHookPayloadV1Schema = z.object({
  sessionId: NonEmptyStringSchema,
  text: z.string(),
  source: z.enum(['user', 'plugin', 'system']),
  turnId: z.string().optional(),
  timestampMs: TimestampMsSchema,
}).passthrough();

export const SessionInputTransformHookPayloadV1Schema = z.object({
  sessionId: NonEmptyStringSchema,
  localId: NonEmptyStringSchema.optional(),
  text: z.string(),
  meta: z.record(z.string(), z.unknown()).optional(),
  timestampMs: TimestampMsSchema,
}).passthrough();

export const ExecutionRunStartedHookPayloadV1Schema = z.object({
  sessionId: NonEmptyStringSchema.optional(),
  runId: NonEmptyStringSchema,
  intent: ExecutionRunIntentSchema,
  runtimeTargetKeys: z.array(BackendTargetKeySchema),
  permissionMode: z.string().optional(),
  retentionPolicy: ExecutionRunRetentionPolicySchema,
  runClass: ExecutionRunClassSchema,
  ioMode: ExecutionRunIoModeSchema,
  timestampMs: TimestampMsSchema,
}).passthrough();

export const ExecutionRunMessageSentHookPayloadV1Schema = z.object({
  sessionId: NonEmptyStringSchema.optional(),
  runId: NonEmptyStringSchema,
  message: z.string(),
  resume: z.boolean().optional(),
  timestampMs: TimestampMsSchema,
}).passthrough();

export const ExecutionRunStoppedHookPayloadV1Schema = z.object({
  sessionId: NonEmptyStringSchema.optional(),
  runId: NonEmptyStringSchema,
  reason: z.enum(['user', 'plugin', 'timeout', 'error']),
  timestampMs: TimestampMsSchema,
}).passthrough();

export const ExecutionRunCompletedHookPayloadV1Schema = z.object({
  sessionId: NonEmptyStringSchema.optional(),
  runId: NonEmptyStringSchema,
  status: z.enum(['succeeded', 'failed', 'canceled']),
  errorCode: z.string().optional(),
  error: z.string().optional(),
  output: z.unknown().optional(),
  timestampMs: TimestampMsSchema,
}).passthrough();

export const AgentResolvePrerequisitesHookPayloadV1Schema = z.object({
  agentId: NonEmptyStringSchema,
  runtimeTarget: BackendTargetRefV2Schema,
  sessionId: NonEmptyStringSchema.optional(),
  cwd: z.string().optional(),
  timestampMs: TimestampMsSchema,
}).passthrough();

export const AgentSpawnEnvAugmentHookPayloadV1Schema = z.object({
  agentId: NonEmptyStringSchema,
  sessionId: NonEmptyStringSchema.optional(),
  cwd: z.string().optional(),
  timestampMs: TimestampMsSchema,
}).passthrough();

export const AgentResponseAfterHookPayloadV1Schema = z.object({
  agentId: NonEmptyStringSchema,
  sessionId: NonEmptyStringSchema,
  requestId: NonEmptyStringSchema,
  status: z.enum(['ok', 'error']),
  durationMs: TimestampMsSchema,
  byteCount: TimestampMsSchema,
  timestampMs: TimestampMsSchema,
}).passthrough();

const AgentMessageProjectionV1Schema = z.object({
  role: z.string().trim().min(1),
  content: z.unknown(),
}).passthrough();

export const AgentContextBeforeHookPayloadV1Schema = z.object({
  sessionId: NonEmptyStringSchema,
  agentId: NonEmptyStringSchema.optional(),
  runtimeFamily: PluginHookSupportedRuntimeFamilyV1Schema,
  prompt: z.string(),
  messages: z.array(AgentMessageProjectionV1Schema),
  timestampMs: TimestampMsSchema,
}).passthrough();

export const AgentRequestBeforeHookPayloadV1Schema = z.object({
  sessionId: NonEmptyStringSchema.optional(),
  agentId: NonEmptyStringSchema.optional(),
  runtimeFamily: PluginHookSupportedRuntimeFamilyV1Schema,
  method: NonEmptyStringSchema,
  request: z.record(z.string(), z.unknown()),
  timestampMs: TimestampMsSchema,
}).passthrough();

export const AgentStreamTokenHookPayloadV1Schema = z.object({
  sessionId: NonEmptyStringSchema,
  agentId: NonEmptyStringSchema.optional(),
  runtimeFamily: PluginHookSupportedRuntimeFamilyV1Schema,
  turnId: NonEmptyStringSchema,
  tokenText: z.string(),
  streamKind: z.enum(['assistant', 'thinking', 'unknown']),
  timestampMs: TimestampMsSchema,
}).passthrough();

export const ToolCallBeforeHookPayloadV1Schema = z.object({
  toolName: NonEmptyStringSchema,
  callId: NonEmptyStringSchema,
  sessionId: NonEmptyStringSchema,
  input: RequiredUnknownSchema,
  timestampMs: TimestampMsSchema,
}).passthrough();

export const ToolResultAfterHookPayloadV1Schema = z.object({
  toolName: NonEmptyStringSchema,
  callId: NonEmptyStringSchema,
  sessionId: NonEmptyStringSchema,
  output: RequiredUnknownSchema,
  ok: z.boolean(),
  durationMs: TimestampMsSchema,
  timestampMs: TimestampMsSchema,
}).passthrough();

export const ResourceDiscoveryHookPayloadV1Schema = z.object({
  resourceKind: NonEmptyStringSchema,
  sessionId: NonEmptyStringSchema.optional(),
  context: RequiredUnknownSchema,
  timestampMs: TimestampMsSchema,
}).passthrough();

export const PluginReloadBeforeHookPayloadV1Schema = z.object({
  pluginId: NonEmptyStringSchema,
  reason: z.enum(['dev', 'manifest-change', 'user']),
  timestampMs: TimestampMsSchema,
}).passthrough();

export const PluginReloadAfterHookPayloadV1Schema = z.object({
  pluginId: NonEmptyStringSchema,
  success: z.boolean(),
  errorMessage: z.string().optional(),
  timestampMs: TimestampMsSchema,
}).passthrough();

export const SessionAttachedHookPayloadV1Schema = z.object({
  sessionId: NonEmptyStringSchema,
  clientId: NonEmptyStringSchema,
  attachMechanism: z.enum(['tmux', 'native', 'remote', 'spawn']),
  attacherCount: z.number().int().min(1),
  timestampMs: TimestampMsSchema,
  platform: z.string().optional(),
}).passthrough();

export const SessionDetachedHookPayloadV1Schema = z.object({
  sessionId: NonEmptyStringSchema,
  clientId: NonEmptyStringSchema,
  remainingAttacherCount: z.number().int().min(0),
  reason: z.enum(['user_detach', 'client_disconnect', 'session_ended', 'error']),
  timestampMs: TimestampMsSchema,
  error: z.object({
    code: NonEmptyStringSchema,
    message: z.string().optional(),
  }).passthrough().optional(),
}).passthrough();

export const VoiceSessionStartedHookPayloadV1Schema = z.object({
  sessionId: NonEmptyStringSchema,
  voiceSessionId: NonEmptyStringSchema,
  providerId: NonEmptyStringSchema,
  capability: z.enum(['stt', 'tts', 'realtime']),
  timestampMs: TimestampMsSchema,
}).passthrough();

export const VoiceSessionEndedHookPayloadV1Schema = z.object({
  sessionId: NonEmptyStringSchema,
  voiceSessionId: NonEmptyStringSchema,
  reason: z.enum(['user_ended', 'timeout', 'error', 'session_ended']),
  durationMs: TimestampMsSchema,
  timestampMs: TimestampMsSchema,
}).passthrough();

export const VoiceTurnStartedHookPayloadV1Schema = z.object({
  sessionId: NonEmptyStringSchema,
  voiceTurnId: NonEmptyStringSchema,
  speakerRole: z.enum(['user', 'assistant']),
  timestampMs: TimestampMsSchema,
}).passthrough();

export const VoiceTurnEndedHookPayloadV1Schema = z.object({
  sessionId: NonEmptyStringSchema,
  voiceTurnId: NonEmptyStringSchema,
  durationMs: TimestampMsSchema,
  timestampMs: TimestampMsSchema,
}).passthrough();

export const VoiceTranscriptPartialHookPayloadV1Schema = z.object({
  sessionId: NonEmptyStringSchema,
  voiceTurnId: NonEmptyStringSchema,
  speakerRole: z.enum(['user', 'assistant']),
  text: z.string(),
  confidence: z.number().min(0).max(1).optional(),
  languageCode: z.string().optional(),
  timestampMs: TimestampMsSchema,
}).passthrough();

export const VoiceTranscriptFinalHookPayloadV1Schema = VoiceTranscriptPartialHookPayloadV1Schema;

export const MemoryShardGeneratedHookPayloadV1Schema = z.object({
  sessionId: NonEmptyStringSchema.optional(),
  shardId: NonEmptyStringSchema,
  kind: z.enum(['hints', 'deep']),
  summaryCharCount: TimestampMsSchema,
  seqFrom: TimestampMsSchema,
  seqTo: TimestampMsSchema,
  timestampMs: TimestampMsSchema,
}).passthrough();

export const MemorySearchPerformedHookPayloadV1Schema = z.object({
  sessionId: NonEmptyStringSchema.optional(),
  query: z.string(),
  mode: MemorySearchModeSchema,
  resultCount: TimestampMsSchema,
  durationMs: TimestampMsSchema,
  timestampMs: TimestampMsSchema,
}).passthrough();

export const MemoryIndexUpdatedHookPayloadV1Schema = z.object({
  indexerId: NonEmptyStringSchema,
  sessionsIndexed: TimestampMsSchema,
  shardsAdded: TimestampMsSchema,
  shardsUpdated: TimestampMsSchema,
  shardsRemoved: TimestampMsSchema,
  timestampMs: TimestampMsSchema,
}).passthrough();

export const MemoryGcPerformedHookPayloadV1Schema = z.object({
  indexerId: NonEmptyStringSchema,
  reason: z.enum(['disk_budget', 'manual', 'retention_policy']),
  bytesReclaimed: TimestampMsSchema,
  shardsEvicted: TimestampMsSchema,
  timestampMs: TimestampMsSchema,
}).passthrough();

export const AutomationScheduledHookPayloadV1Schema = z.object({
  automationId: NonEmptyStringSchema,
  scheduleKind: z.enum(['cron', 'interval', 'manual', 'event-triggered']),
  nextFireAtMs: TimestampMsSchema.optional(),
  timestampMs: TimestampMsSchema,
}).passthrough();

export const AutomationClaimedHookPayloadV1Schema = z.object({
  automationId: NonEmptyStringSchema,
  runId: NonEmptyStringSchema,
  claimedBy: NonEmptyStringSchema,
  leaseExpiresAtMs: TimestampMsSchema,
  timestampMs: TimestampMsSchema,
}).passthrough();

export const AutomationRunStartedHookPayloadV1Schema = z.object({
  automationId: NonEmptyStringSchema,
  runId: NonEmptyStringSchema,
  targetType: NonEmptyStringSchema,
  sessionId: z.string().optional(),
  templateDigest: NonEmptyStringSchema,
  timestampMs: TimestampMsSchema,
}).passthrough();

export const AutomationRunSucceededHookPayloadV1Schema = z.object({
  automationId: NonEmptyStringSchema,
  runId: NonEmptyStringSchema,
  durationMs: TimestampMsSchema,
  result: z.unknown().optional(),
  timestampMs: TimestampMsSchema,
}).passthrough();

export const AutomationRunFailedHookPayloadV1Schema = z.object({
  automationId: NonEmptyStringSchema,
  runId: NonEmptyStringSchema,
  durationMs: TimestampMsSchema,
  errorCode: NonEmptyStringSchema,
  error: NonEmptyStringSchema,
  timestampMs: TimestampMsSchema,
}).passthrough();

export const AutomationRunExpiredHookPayloadV1Schema = z.object({
  automationId: NonEmptyStringSchema,
  runId: NonEmptyStringSchema,
  leaseExpiredAtMs: TimestampMsSchema,
  timestampMs: TimestampMsSchema,
}).passthrough();

export const ApprovalDecisionMadeHookPayloadV1Schema = z.object({
  requestId: NonEmptyStringSchema,
  actionId: ActionIdSchema,
  decision: z.enum(['approved', 'rejected']),
  decidedAtMs: TimestampMsSchema,
  createdBy: ApprovalRequestCreatedBySchema,
  reason: z.string().optional(),
  timestampMs: TimestampMsSchema,
}).passthrough();

export const SubagentStartedHookPayloadV1Schema = z.object({
  subagentRef: SubagentRefV1Schema,
  timestampMs: TimestampMsSchema.optional(),
}).passthrough();
export type SubagentStartedHookPayloadV1 = z.infer<typeof SubagentStartedHookPayloadV1Schema>;

export const SubagentEndedHookPayloadV1Schema = z.object({
  subagentRef: SubagentRefV1Schema,
  outcome: RequiredUnknownSchema,
  timestampMs: TimestampMsSchema.optional(),
}).passthrough();
export type SubagentEndedHookPayloadV1 = z.infer<typeof SubagentEndedHookPayloadV1Schema>;

export const PLUGIN_HOOK_PAYLOAD_SCHEMAS_BY_ID_V1 = Object.freeze({
  'session.spawned': SessionSpawnedHookPayloadV1Schema,
  'session.message.send': SessionMessageSendHookPayloadV1Schema,
  'session.input.transform': SessionInputTransformHookPayloadV1Schema,
  'executionRun.started': ExecutionRunStartedHookPayloadV1Schema,
  'executionRun.messageSent': ExecutionRunMessageSentHookPayloadV1Schema,
  'executionRun.stopped': ExecutionRunStoppedHookPayloadV1Schema,
  'executionRun.completed': ExecutionRunCompletedHookPayloadV1Schema,
  'agent.resolvePrerequisites': AgentResolvePrerequisitesHookPayloadV1Schema,
  'agent.spawnEnv.augment': AgentSpawnEnvAugmentHookPayloadV1Schema,
  'agent.response.after': AgentResponseAfterHookPayloadV1Schema,
  'agent.context.before': AgentContextBeforeHookPayloadV1Schema,
  'agent.request.before': AgentRequestBeforeHookPayloadV1Schema,
  'agent.stream.token': AgentStreamTokenHookPayloadV1Schema,
  'tool.call.before': ToolCallBeforeHookPayloadV1Schema,
  'tool.result.after': ToolResultAfterHookPayloadV1Schema,
  'resource.discovery': ResourceDiscoveryHookPayloadV1Schema,
  'plugin.reload.before': PluginReloadBeforeHookPayloadV1Schema,
  'plugin.reload.after': PluginReloadAfterHookPayloadV1Schema,
  'session.attached': SessionAttachedHookPayloadV1Schema,
  'session.detached': SessionDetachedHookPayloadV1Schema,
  'voice.session.started': VoiceSessionStartedHookPayloadV1Schema,
  'voice.session.ended': VoiceSessionEndedHookPayloadV1Schema,
  'voice.turn.started': VoiceTurnStartedHookPayloadV1Schema,
  'voice.turn.ended': VoiceTurnEndedHookPayloadV1Schema,
  'voice.transcript.partial': VoiceTranscriptPartialHookPayloadV1Schema,
  'voice.transcript.final': VoiceTranscriptFinalHookPayloadV1Schema,
  'memory.shard.generated': MemoryShardGeneratedHookPayloadV1Schema,
  'memory.search.performed': MemorySearchPerformedHookPayloadV1Schema,
  'memory.index.updated': MemoryIndexUpdatedHookPayloadV1Schema,
  'memory.gc.performed': MemoryGcPerformedHookPayloadV1Schema,
  'automation.scheduled': AutomationScheduledHookPayloadV1Schema,
  'automation.claimed': AutomationClaimedHookPayloadV1Schema,
  'automation.run.started': AutomationRunStartedHookPayloadV1Schema,
  'automation.run.succeeded': AutomationRunSucceededHookPayloadV1Schema,
  'automation.run.failed': AutomationRunFailedHookPayloadV1Schema,
  'automation.run.expired': AutomationRunExpiredHookPayloadV1Schema,
  'approval.decision.made': ApprovalDecisionMadeHookPayloadV1Schema,
  'subagent.started': SubagentStartedHookPayloadV1Schema,
  'subagent.ended': SubagentEndedHookPayloadV1Schema,
} satisfies Readonly<Record<PluginHookIdV1, z.ZodType<unknown>>>);

export type PluginHookPayloadSchemaMapV1 = typeof PLUGIN_HOOK_PAYLOAD_SCHEMAS_BY_ID_V1;

export function validatePluginHookPayloadV1(params: Readonly<{
  hookId: string;
  payload: unknown;
}>): Readonly<
  | { success: true; payload: unknown }
  | { success: false; message: string }
> {
  const hookId = PluginHookIdV1Schema.safeParse(params.hookId);
  if (!hookId.success) {
    return {
      success: false,
      message: `Unsupported plugin hook id '${params.hookId}'`,
    };
  }
  const schema = PLUGIN_HOOK_PAYLOAD_SCHEMAS_BY_ID_V1[hookId.data];
  const parsed = schema.safeParse(params.payload);
  if (parsed.success) {
    return {
      success: true,
      payload: parsed.data,
    };
  }
  return {
    success: false,
    message: `Invalid payload for plugin hook '${hookId.data}': ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
  };
}

function definePluginHookDefinitionV1(input: Readonly<{
  id: PluginHookIdV1;
  category: HookCategoryV1;
  scope: PluginHookScopeV1;
  aggregation: PluginHookAggregationKindV1;
  failureMode: PluginHookFailureModeV1;
  purity?: PluginHookPurityV1;
  supportedRuntimes?: readonly PluginHookSupportedRuntimeFamilyV1[];
  payloadSchema?: Record<string, unknown>;
  resultSchema?: Record<string, unknown>;
}>): PluginHookDefinitionV1 {
  const executionKind = resolveHookExecutionKindForCategoryV1(input.category) as HookExecutionKindV1;
  return PluginHookDefinitionV1Schema.parse({
    ...input,
    executionKind,
    supportedRuntimes: input.supportedRuntimes ?? [],
    payloadSchema: input.payloadSchema ?? {},
    resultSchema: input.resultSchema ?? {},
  });
}

const lifecycle = (params: Readonly<{
  id: PluginHookIdV1;
  scope: PluginHookScopeV1;
  purity?: PluginHookPurityV1;
  supportedRuntimes?: readonly PluginHookSupportedRuntimeFamilyV1[];
}>): PluginHookDefinitionV1 => definePluginHookDefinitionV1({
  id: params.id,
  category: 'lifecycle',
  scope: params.scope,
  aggregation: 'orderedList',
  failureMode: 'bestEffort',
  ...(params.purity ? { purity: params.purity } : {}),
  ...(params.supportedRuntimes ? { supportedRuntimes: params.supportedRuntimes } : {}),
});

export const PLUGIN_HOOK_CATALOG_V1 = [
  lifecycle({ id: 'session.spawned', scope: 'session' }),
  lifecycle({ id: 'session.message.send', scope: 'session' }),
  definePluginHookDefinitionV1({
    id: 'session.input.transform',
    category: 'augmentation',
    scope: 'session',
    aggregation: 'replace',
    failureMode: 'bestEffort',
    supportedRuntimes: ['hostSession'],
  }),
  lifecycle({ id: 'executionRun.started', scope: 'session' }),
  lifecycle({ id: 'executionRun.messageSent', scope: 'session' }),
  lifecycle({ id: 'executionRun.stopped', scope: 'session' }),
  lifecycle({ id: 'executionRun.completed', scope: 'session' }),
  definePluginHookDefinitionV1({
    id: 'agent.resolvePrerequisites',
    category: 'decision',
    scope: 'agent',
    aggregation: 'firstDecision',
    failureMode: 'failClosed',
  }),
  definePluginHookDefinitionV1({
    id: 'agent.spawnEnv.augment',
    category: 'augmentation',
    scope: 'daemon',
    aggregation: 'mergeObject',
    failureMode: 'bestEffort',
  }),
  lifecycle({ id: 'agent.response.after', scope: 'agent' }),
  definePluginHookDefinitionV1({
    id: 'agent.context.before',
    category: 'augmentation',
    scope: 'agent',
    aggregation: 'replace',
    failureMode: 'bestEffort',
    supportedRuntimes: ['hostSession'],
  }),
  definePluginHookDefinitionV1({
    id: 'agent.request.before',
    category: 'augmentation',
    scope: 'agent',
    aggregation: 'replace',
    failureMode: 'bestEffort',
    supportedRuntimes: ['acpSession'],
  }),
  lifecycle({
    id: 'agent.stream.token',
    scope: 'agent',
    purity: 'observer',
    supportedRuntimes: ['hostSession'],
  }),
  definePluginHookDefinitionV1({
    id: 'tool.call.before',
    category: 'decision',
    scope: 'tool',
    aggregation: 'firstDecision',
    failureMode: 'failClosed',
  }),
  lifecycle({ id: 'tool.result.after', scope: 'tool' }),
  definePluginHookDefinitionV1({
    id: 'resource.discovery',
    category: 'augmentation',
    scope: 'resource',
    aggregation: 'mergeObject',
    failureMode: 'bestEffort',
  }),
  lifecycle({ id: 'plugin.reload.before', scope: 'plugin' }),
  lifecycle({ id: 'plugin.reload.after', scope: 'plugin' }),
  lifecycle({ id: 'session.attached', scope: 'session' }),
  lifecycle({ id: 'session.detached', scope: 'session' }),
  lifecycle({ id: 'voice.session.started', scope: 'session' }),
  lifecycle({ id: 'voice.session.ended', scope: 'session' }),
  lifecycle({ id: 'voice.turn.started', scope: 'session' }),
  lifecycle({ id: 'voice.turn.ended', scope: 'session' }),
  lifecycle({ id: 'voice.transcript.partial', scope: 'session' }),
  lifecycle({ id: 'voice.transcript.final', scope: 'session' }),
  lifecycle({ id: 'memory.shard.generated', scope: 'project' }),
  lifecycle({ id: 'memory.search.performed', scope: 'project' }),
  lifecycle({ id: 'memory.index.updated', scope: 'project' }),
  lifecycle({ id: 'memory.gc.performed', scope: 'project' }),
  lifecycle({ id: 'automation.scheduled', scope: 'project' }),
  lifecycle({ id: 'automation.claimed', scope: 'project' }),
  lifecycle({ id: 'automation.run.started', scope: 'project' }),
  lifecycle({ id: 'automation.run.succeeded', scope: 'project' }),
  lifecycle({ id: 'automation.run.failed', scope: 'project' }),
  lifecycle({ id: 'automation.run.expired', scope: 'project' }),
  lifecycle({ id: 'approval.decision.made', scope: 'session', purity: 'observer' }),
  lifecycle({ id: 'subagent.started', scope: 'session', purity: 'observer' }),
  lifecycle({ id: 'subagent.ended', scope: 'session', purity: 'observer' }),
] as const satisfies readonly PluginHookDefinitionV1[];

const PLUGIN_HOOK_CATALOG_BY_ID_V1: ReadonlyMap<string, PluginHookDefinitionV1> = new Map(
  PLUGIN_HOOK_CATALOG_V1.map((entry) => [entry.id, entry]),
);

export function getPluginHookDefinitionV1(id: string): PluginHookDefinitionV1 | null {
  return PLUGIN_HOOK_CATALOG_BY_ID_V1.get(id) ?? null;
}
