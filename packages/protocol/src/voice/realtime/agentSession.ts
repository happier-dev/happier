import { z } from 'zod';

import { PluginContributionIdentityV1Schema } from '../../plugins/contributionIdentity.js';

export const AGENT_SESSION_REALTIME_SDP_MAX_BYTES = 64 * 1024;

const boundedUtf8String = (maxBytes: number) => z.string().refine(
  (value) => new TextEncoder().encode(value).byteLength <= maxBytes,
  `Value must be at most ${maxBytes} UTF-8 bytes.`,
);

const AgentSessionRealtimeSelectionV1Schema = z.object({
  v: z.literal(1),
  provider: PluginContributionIdentityV1Schema,
}).strict();

const AgentSessionRealtimeAttemptSelectionV1Schema =
  AgentSessionRealtimeSelectionV1Schema.extend({
    applicationAttemptId: z.string().min(1).max(256),
  }).strict();

const AgentSessionRealtimeUnavailableV1Schema = z.object({
  ok: z.literal(false),
  status: z.literal('unavailable'),
  code: z.string().min(1).max(128),
  message: z.string().min(1).max(4096),
  reason: z.enum([
    'authentication_required',
    'session_unavailable',
    'unsupported_runtime',
    'update_required',
    'feature_unavailable',
  ]).optional(),
}).strict();

const AgentSessionRealtimeFailedV1Schema =
  AgentSessionRealtimeUnavailableV1Schema.extend({
    status: z.literal('failed'),
    reason: z.never().optional(),
  }).strict();

export const AgentSessionRealtimeInspectRequestV1Schema =
  AgentSessionRealtimeSelectionV1Schema;
export type AgentSessionRealtimeInspectRequestV1 = z.infer<
  typeof AgentSessionRealtimeInspectRequestV1Schema
>;

export const AgentSessionRealtimeStartRequestV1Schema =
  AgentSessionRealtimeAttemptSelectionV1Schema.extend({
    transport: z.object({
      kind: z.literal('webrtc'),
      offerSdp: boundedUtf8String(AGENT_SESSION_REALTIME_SDP_MAX_BYTES),
    }).strict(),
  }).strict();
export type AgentSessionRealtimeStartRequestV1 = z.infer<
  typeof AgentSessionRealtimeStartRequestV1Schema
>;

export const AgentSessionRealtimeStopRequestV1Schema =
  AgentSessionRealtimeAttemptSelectionV1Schema;
export type AgentSessionRealtimeStopRequestV1 = z.infer<
  typeof AgentSessionRealtimeStopRequestV1Schema
>;

export const AgentSessionRealtimeWatchRequestV1Schema =
  AgentSessionRealtimeAttemptSelectionV1Schema;
export type AgentSessionRealtimeWatchRequestV1 = z.infer<
  typeof AgentSessionRealtimeWatchRequestV1Schema
>;

export const AgentSessionRealtimeInspectResultV1Schema = z.union([
  z.object({
    ok: z.literal(true),
    status: z.literal('available'),
    transport: z.literal('webrtc'),
  }).strict(),
  AgentSessionRealtimeUnavailableV1Schema,
]);
export type AgentSessionRealtimeInspectResultV1 = z.infer<
  typeof AgentSessionRealtimeInspectResultV1Schema
>;

export const AgentSessionRealtimeStartResultV1Schema = z.union([
  z.object({
    ok: z.literal(true),
    status: z.literal('started'),
    transport: z.object({
      kind: z.literal('webrtc'),
      answerSdp: boundedUtf8String(AGENT_SESSION_REALTIME_SDP_MAX_BYTES),
    }).strict(),
  }).strict(),
  z.object({
    ok: z.literal(true),
    status: z.enum(['busy', 'aborted']),
  }).strict(),
  AgentSessionRealtimeUnavailableV1Schema,
  AgentSessionRealtimeFailedV1Schema,
]);
export type AgentSessionRealtimeStartResultV1 = z.infer<
  typeof AgentSessionRealtimeStartResultV1Schema
>;

export const AgentSessionRealtimeStopResultV1Schema = z.union([
  z.object({
    ok: z.literal(true),
    status: z.enum(['stopped', 'already_stopped', 'aborted']),
  }).strict(),
  AgentSessionRealtimeUnavailableV1Schema,
]);
export type AgentSessionRealtimeStopResultV1 = z.infer<
  typeof AgentSessionRealtimeStopResultV1Schema
>;

export const AgentSessionRealtimeWatchResultV1Schema = z.union([
  z.object({
    ok: z.literal(true),
    status: z.literal('terminal'),
    event: z.object({
      kind: z.literal('terminal'),
      reason: z.enum([
        'stopped',
        'upstream_closed',
        'agent_session_disposed',
        'aborted',
        'error',
      ]),
      diagnostic: z.object({
        code: z.string().min(1).max(128),
        severity: z.enum(['info', 'warning', 'error']),
        message: z.string().min(1).max(4096).optional(),
      }).strict().optional(),
    }).strict(),
  }).strict(),
  AgentSessionRealtimeUnavailableV1Schema,
]);
export type AgentSessionRealtimeWatchResultV1 = z.infer<
  typeof AgentSessionRealtimeWatchResultV1Schema
>;
