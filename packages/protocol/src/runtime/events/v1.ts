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
  startedBy: z.string().optional(),
});

const TurnCompleteEventV1Schema = RuntimeEventBaseV1Schema.extend({
  kind: z.literal('turn-complete'),
  turnId: TurnIdSchema,
  summary: z.unknown().optional(),
});

const TurnAbortedEventV1Schema = RuntimeEventBaseV1Schema.extend({
  kind: z.literal('turn-aborted'),
  turnId: TurnIdSchema,
  reason: z.string().optional(),
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
  TurnAbortedEventV1Schema,
  RuntimeStatusChangeEventV1Schema,
  SessionIdPublishEventV1Schema,
  DescriptorUpdateEventV1Schema,
  DiffEmitEventV1Schema,
  BackendErrorEventV1Schema,
  TokenCountEventV1Schema,
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
  'turn-aborted',
  'runtime-status-change',
  'session-id-publish',
  'descriptor-update',
  'diff-emit',
  'backend-error',
  'token-count',
  'subagent-start',
  'subagent-status-change',
  'subagent-end',
] as const satisfies readonly RuntimeEventKindV1[];

export type RuntimeEventEnvelopeV1 = Readonly<{
  type: 'event';
  name: 'runtime.event';
  payload: RuntimeEventV1;
}>;
