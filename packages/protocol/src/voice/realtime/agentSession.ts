import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import { PluginContributionIdentityV1Schema } from '../../plugins/contributionIdentity.js';
import {
  defineProtocolLiteral,
  defineProtocolObject,
  defineProtocolString,
  defineProtocolUtf8String,
  type ProtocolComposableSchema,
} from '../../plugins/actions/protocolComposableSchema.js';

export const AGENT_SESSION_REALTIME_SDP_MAX_BYTES = 64 * 1024;

const boundedUtf8String = (maxBytes: number) => z.string().check(z.refine((value) => new TextEncoder().encode(value).byteLength <= maxBytes, `Value must be at most ${maxBytes} UTF-8 bytes.`));

const agentSessionRealtimeSelectionV1Shape = {
  v: defineProtocolLiteral(1),
  provider: PluginContributionIdentityV1Schema,
};

const AgentSessionRealtimeSelectionV1Schema = defineProtocolObject(
  agentSessionRealtimeSelectionV1Shape,
  { policy: 'closed' },
);

const agentSessionRealtimeAttemptSelectionV1Shape = {
  ...agentSessionRealtimeSelectionV1Shape,
  applicationAttemptId: defineProtocolString({ minLength: 1, maxLength: 256 }),
};

const AgentSessionRealtimeAttemptSelectionV1Schema = defineProtocolObject(
  agentSessionRealtimeAttemptSelectionV1Shape,
  { policy: 'closed' },
);

const AgentSessionRealtimeUnavailableV1Schema = lazyZodSchema(() => z.strictObject({
  ok: z.literal(false),
  status: z.literal('unavailable'),
  code: z.string().check(z.minLength(1), z.maxLength(128)),
  message: z.string().check(z.minLength(1), z.maxLength(4096)),
  reason: z.optional(z.enum([
    'authentication_required',
    'session_unavailable',
    'unsupported_runtime',
    'update_required',
    'feature_unavailable',
  ])),
}));

const AgentSessionRealtimeFailedV1Schema =
  lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(AgentSessionRealtimeUnavailableV1Schema, {
    status: z.literal('failed'),
    reason: z.optional(z.never()),
  })));

export const AgentSessionRealtimeInspectRequestV1Schema =
  AgentSessionRealtimeSelectionV1Schema;
export type AgentSessionRealtimeInspectRequestV1 = ReturnType<
  typeof AgentSessionRealtimeInspectRequestV1Schema.parse
>;

export type AgentSessionRealtimeStartRequestV1 = {
  v: 1;
  provider: {
    pluginId: string;
    localId: string;
  };
  applicationAttemptId: string;
  transport: {
    kind: 'webrtc';
    offerSdp: string;
  };
};

export const AgentSessionRealtimeStartRequestV1Schema: ProtocolComposableSchema<
  AgentSessionRealtimeStartRequestV1
> = defineProtocolObject({
  ...agentSessionRealtimeAttemptSelectionV1Shape,
  transport: defineProtocolObject({
    kind: defineProtocolLiteral('webrtc'),
    offerSdp: defineProtocolUtf8String({
      maxUtf8Bytes: AGENT_SESSION_REALTIME_SDP_MAX_BYTES,
    }),
  }, { policy: 'closed' }),
}, { policy: 'closed' });

export const AgentSessionRealtimeStopRequestV1Schema =
  AgentSessionRealtimeAttemptSelectionV1Schema;
export type AgentSessionRealtimeStopRequestV1 = ReturnType<
  typeof AgentSessionRealtimeStopRequestV1Schema.parse
>;

export const AgentSessionRealtimeWatchRequestV1Schema =
  AgentSessionRealtimeAttemptSelectionV1Schema;
export type AgentSessionRealtimeWatchRequestV1 = ReturnType<
  typeof AgentSessionRealtimeWatchRequestV1Schema.parse
>;

export const AgentSessionRealtimeInspectResultV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({
    ok: z.literal(true),
    status: z.literal('available'),
    transport: z.literal('webrtc'),
  }),
  AgentSessionRealtimeUnavailableV1Schema,
]));
export type AgentSessionRealtimeInspectResultV1 = z.infer<
  typeof AgentSessionRealtimeInspectResultV1Schema
>;

export const AgentSessionRealtimeStartResultV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({
    ok: z.literal(true),
    status: z.literal('started'),
    preparedInstructionsFor: z.optional(z.strictObject({
      serverId: z.string().check(z.minLength(1)),
      sessionId: z.string().check(z.trim(), z.minLength(1)),
    })),
    transport: z.strictObject({
      kind: z.literal('webrtc'),
      answerSdp: boundedUtf8String(AGENT_SESSION_REALTIME_SDP_MAX_BYTES),
    }),
  }),
  z.strictObject({
    ok: z.literal(true),
    status: z.enum(['busy', 'aborted']),
  }),
  AgentSessionRealtimeUnavailableV1Schema,
  AgentSessionRealtimeFailedV1Schema,
]));
export type AgentSessionRealtimeStartResultV1 = z.infer<
  typeof AgentSessionRealtimeStartResultV1Schema
>;

export const AgentSessionRealtimeStopResultV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({
    ok: z.literal(true),
    status: z.enum(['stopped', 'already_stopped', 'aborted']),
  }),
  AgentSessionRealtimeUnavailableV1Schema,
]));
export type AgentSessionRealtimeStopResultV1 = z.infer<
  typeof AgentSessionRealtimeStopResultV1Schema
>;

export const AgentSessionRealtimeWatchResultV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({
    ok: z.literal(true),
    status: z.literal('terminal'),
    event: z.strictObject({
      kind: z.literal('terminal'),
      reason: z.enum([
        'stopped',
        'upstream_closed',
        'agent_session_disposed',
        'aborted',
        'error',
      ]),
      diagnostic: z.optional(z.strictObject({
        code: z.string().check(z.minLength(1), z.maxLength(128)),
        severity: z.enum(['info', 'warning', 'error']),
        message: z.optional(z.string().check(z.minLength(1), z.maxLength(4096))),
      })),
    }),
  }),
  AgentSessionRealtimeUnavailableV1Schema,
]));
export type AgentSessionRealtimeWatchResultV1 = z.infer<
  typeof AgentSessionRealtimeWatchResultV1Schema
>;
