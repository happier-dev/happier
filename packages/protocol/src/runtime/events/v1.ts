import { z } from 'zod';

import { RuntimeDescriptorV1Schema } from '../../sessionMetadata/runtimeDescriptorV1.js';
import {
  SessionIdSchema,
  SidechainIdSchema,
  SubagentIdSchema,
  TurnIdSchema,
} from '../../sessions/idsV1.js';
import {
  RuntimeStatusChangeDetailV1Schema,
} from '../../sessions/runtimeModeV1.js';
import { SessionRuntimeIssueV1Schema } from '../../sessions/control/runtimeIssueV1.js';
import {
  SubagentLifecycleDetailV1Schema,
  SubagentRefV1Schema,
  SubagentStatusV1Schema,
} from '../../sessions/subagents/subagentRefV1.js';

const RuntimeEventBaseV1Schema = z.object({
  sessionId: SessionIdSchema,
  emittedAtMs: z.number().int().nonnegative(),
  ordering: z.number().int().nonnegative().optional(),
  sidechainId: SidechainIdSchema.optional(),
}).passthrough();

const ProviderTurnIdV1Schema = z.string().trim().min(1);

const RuntimeTurnEventBaseV1Schema = RuntimeEventBaseV1Schema.extend({
  turnId: TurnIdSchema,
  providerTurnId: ProviderTurnIdV1Schema.optional(),
});

const MessageDeltaEventV1Schema = RuntimeEventBaseV1Schema.extend({
  kind: z.literal('message-delta'),
  turnId: TurnIdSchema,
  delta: z.unknown(),
});

const ToolCallEventV1Schema = RuntimeEventBaseV1Schema.extend({
  kind: z.literal('tool-call'),
  turnId: TurnIdSchema,
  toolCallId: z.string().trim().min(1),
  toolName: z.string().trim().min(1),
  toolInput: z.unknown(),
});

const ToolResultEventV1Schema = RuntimeEventBaseV1Schema.extend({
  kind: z.literal('tool-result'),
  turnId: TurnIdSchema,
  toolCallId: z.string().trim().min(1),
  output: z.unknown(),
  isError: z.boolean().optional(),
});

const ToolProgressEventV1Schema = RuntimeEventBaseV1Schema.extend({
  kind: z.literal('tool-progress'),
  turnId: TurnIdSchema,
  toolCallId: z.string().trim().min(1),
  progress: z.unknown(),
});

const TurnStartEventV1Schema = RuntimeEventBaseV1Schema.extend({
  kind: z.literal('turn-start'),
  turnId: TurnIdSchema,
  providerTurnId: ProviderTurnIdV1Schema.optional(),
  startedBy: z.string().optional(),
});

const TurnCompleteEventV1Schema = RuntimeTurnEventBaseV1Schema.extend({
  kind: z.literal('turn-complete'),
  summary: z.unknown().optional(),
});

const TurnFailedEventV1Schema = RuntimeTurnEventBaseV1Schema.extend({
  kind: z.literal('turn-failed'),
  issue: SessionRuntimeIssueV1Schema,
});

const TurnCancelledEventV1Schema = RuntimeTurnEventBaseV1Schema.extend({
  kind: z.literal('turn-cancelled'),
  reason: z.string().optional(),
});

const TurnProviderIdObservedEventV1Schema = RuntimeEventBaseV1Schema.extend({
  kind: z.literal('turn-provider-id-observed'),
  turnId: TurnIdSchema,
  providerTurnId: ProviderTurnIdV1Schema,
});

const TurnInputAppendedEventV1Schema = RuntimeTurnEventBaseV1Schema.extend({
  kind: z.literal('turn-input-appended'),
  localInputId: z.string().trim().min(1).optional(),
  userMessageSeq: z.number().int().nonnegative().optional(),
});

const TranscriptUserTextEventV1Schema = RuntimeEventBaseV1Schema.extend({
  kind: z.literal('transcript-user-text'),
  text: z.string(),
  localId: z.string().trim().min(1).optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

const TranscriptAgentMessageCommittedEventV1Schema = RuntimeEventBaseV1Schema.extend({
  kind: z.literal('transcript-agent-message-committed'),
  provider: z.string().trim().min(1),
  localId: z.string().trim().min(1),
  body: z.unknown(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

const TurnRollbackBoundaryObservedEventV1Schema = RuntimeTurnEventBaseV1Schema.extend({
  kind: z.literal('turn-rollback-boundary-observed'),
  startUserMessageSeq: z.number().int().nonnegative().optional(),
  startSeqInclusive: z.number().int().nonnegative().optional(),
  endSeqInclusive: z.number().int().nonnegative().nullable().optional(),
  providerRollbackOrdinal: z.number().int().nonnegative().optional(),
});

const TurnRollbackAppliedEventV1Schema = RuntimeTurnEventBaseV1Schema.extend({
  kind: z.literal('turn-rollback-applied'),
  restoredToTurnId: TurnIdSchema,
  providerRollbackOrdinal: z.number().int().nonnegative().optional(),
});

const SessionEndedEventV1Schema = RuntimeEventBaseV1Schema.extend({
  kind: z.literal('session-ended'),
  providerSessionId: z.string().trim().min(1).optional(),
  reason: z.string().trim().min(1).optional(),
});

const RuntimeStatusChangeEventV1Schema = RuntimeEventBaseV1Schema.extend({
  kind: z.literal('runtime-status-change'),
  status: z.string().trim().min(1),
  detail: RuntimeStatusChangeDetailV1Schema.optional(),
});

const SessionIdPublishEventV1Schema = RuntimeEventBaseV1Schema.extend({
  kind: z.literal('session-id-publish'),
  publishedSessionId: SessionIdSchema,
  source: z.string().trim().min(1),
});

const DescriptorUpdateEventV1Schema = RuntimeEventBaseV1Schema.extend({
  kind: z.literal('descriptor-update'),
  descriptor: RuntimeDescriptorV1Schema,
});

const DiffEmitEventV1Schema = RuntimeEventBaseV1Schema.extend({
  kind: z.literal('diff-emit'),
  diff: z.unknown(),
  origin: z.string().optional(),
});

const BackendErrorEventV1Schema = RuntimeEventBaseV1Schema.extend({
  kind: z.literal('backend-error'),
  error: z.object({
    message: z.string(),
    code: z.string().optional(),
    cause: z.unknown().optional(),
  }).passthrough(),
});

const TokenCountEventV1Schema = RuntimeEventBaseV1Schema.extend({
  kind: z.literal('token-count'),
  source: z.string().trim().min(1),
  scope: z.string().trim().min(1),
  totals: z.record(z.string(), z.number()),
});

const CONTEXT_COMPACTION_FORBIDDEN_WRITER_FIELDS = [
  'status',
  'presentation',
  'summary',
  'summaryPreview',
  'providerSummary',
  'providerSummaryPreview',
  'provider',
] as const;

const ContextCompactionForbiddenWriterFieldSchemas = Object.fromEntries(
  CONTEXT_COMPACTION_FORBIDDEN_WRITER_FIELDS.map((field) => [field, z.never().optional()]),
) as Record<(typeof CONTEXT_COMPACTION_FORBIDDEN_WRITER_FIELDS)[number], z.ZodOptional<z.ZodNever>>;

const ContextCompactionEventV1Schema = RuntimeEventBaseV1Schema.extend({
  kind: z.literal('context-compaction'),
  phase: z.enum(['started', 'progress', 'completed', 'failed', 'cancelled']),
  lifecycleId: z.string().trim().min(1).optional(),
  source: z.enum([
    'provider-event',
    'provider-status',
    'provider-hook',
    'transcript-inference',
    'runtime',
    'user-command',
  ]),
  trigger: z.enum(['manual', 'auto', 'threshold', 'overflow', 'unknown']).optional(),
  backendId: z.string().trim().min(1).optional(),
  agentId: z.string().trim().min(1).optional(),
  providerEventId: z.string().trim().min(1).optional(),
  providerSessionId: z.string().trim().min(1).optional(),
  turnId: TurnIdSchema.optional(),
  tokenCountBefore: z.number().finite().nonnegative().optional(),
  tokenCountAfter: z.number().finite().nonnegative().optional(),
  tokenCountSource: z.string().trim().min(1).optional(),
  retryAttempt: z.number().int().nonnegative().optional(),
  errorCode: z.string().trim().min(1).optional(),
  sanitizedErrorPreview: z.string().trim().min(1).optional(),
  ...ContextCompactionForbiddenWriterFieldSchemas,
});

const SubagentStartEventV1Schema = RuntimeEventBaseV1Schema.extend({
  kind: z.literal('subagent-start'),
  subagent: SubagentRefV1Schema,
});

const SubagentStatusChangeEventV1Schema = RuntimeEventBaseV1Schema.extend({
  kind: z.literal('subagent-status-change'),
  subagentId: SubagentIdSchema,
  status: SubagentStatusV1Schema,
  lifecycleDetail: SubagentLifecycleDetailV1Schema.optional(),
});

const SubagentEndEventV1Schema = RuntimeEventBaseV1Schema.extend({
  kind: z.literal('subagent-end'),
  subagentId: SubagentIdSchema,
  outcome: z.unknown().optional(),
});

export const RuntimeEventV1Schema = z.discriminatedUnion('kind', [
  MessageDeltaEventV1Schema,
  ToolCallEventV1Schema,
  ToolResultEventV1Schema,
  ToolProgressEventV1Schema,
  TurnStartEventV1Schema,
  TurnCompleteEventV1Schema,
  TurnFailedEventV1Schema,
  TurnCancelledEventV1Schema,
  TurnProviderIdObservedEventV1Schema,
  TurnInputAppendedEventV1Schema,
  TranscriptUserTextEventV1Schema,
  TranscriptAgentMessageCommittedEventV1Schema,
  TurnRollbackBoundaryObservedEventV1Schema,
  TurnRollbackAppliedEventV1Schema,
  SessionEndedEventV1Schema,
  RuntimeStatusChangeEventV1Schema,
  SessionIdPublishEventV1Schema,
  DescriptorUpdateEventV1Schema,
  DiffEmitEventV1Schema,
  BackendErrorEventV1Schema,
  TokenCountEventV1Schema,
  ContextCompactionEventV1Schema,
  SubagentStartEventV1Schema,
  SubagentStatusChangeEventV1Schema,
  SubagentEndEventV1Schema,
]);
export type RuntimeEventV1 = z.infer<typeof RuntimeEventV1Schema>;
export type RuntimeEventKindV1 = RuntimeEventV1['kind'];

export const RUNTIME_EVENT_KINDS_V1 = [
  'message-delta',
  'tool-call',
  'tool-result',
  'tool-progress',
  'turn-start',
  'turn-complete',
  'turn-failed',
  'turn-cancelled',
  'turn-provider-id-observed',
  'turn-input-appended',
  'transcript-user-text',
  'transcript-agent-message-committed',
  'turn-rollback-boundary-observed',
  'turn-rollback-applied',
  'session-ended',
  'runtime-status-change',
  'session-id-publish',
  'descriptor-update',
  'diff-emit',
  'backend-error',
  'token-count',
  'context-compaction',
  'subagent-start',
  'subagent-status-change',
  'subagent-end',
] as const satisfies readonly RuntimeEventKindV1[];

export type RuntimeEventEnvelopeV1 = Readonly<{
  type: 'event';
  name: 'runtime.event';
  payload: RuntimeEventV1;
}>;
