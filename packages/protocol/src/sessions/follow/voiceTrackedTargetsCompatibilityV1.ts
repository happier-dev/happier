import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import { SessionFollowErrorCodeV1Schema } from './api.js';

export const VoiceTrackedSessionAddressV1Schema = lazyZodSchema(() => z.object({
  serverId: z.string().trim().min(1),
  sessionId: z.string().trim().min(1),
}).strict());

const VoiceTrackedSessionCandidateV1Schema = lazyZodSchema(() => z.object({
  address: VoiceTrackedSessionAddressV1Schema,
  id: z.string().trim().min(1),
  title: z.string().trim().min(1).optional(),
  locationLabel: z.string().trim().min(1).optional(),
  serverId: z.string().trim().min(1),
  serverName: z.string().trim().min(1).optional(),
}).strict());

// Successful/partial projections mirror the uncapped canonical Account Voice
// replace API so a complete 51+ exact-Home replacement result can settle.
const VoiceTrackedSessionProjectionV1Schema = lazyZodSchema(() => z.object({
  sessionIds: z.array(z.string().trim().min(1)),
  sessionAddresses: z.array(VoiceTrackedSessionAddressV1Schema),
  sessions: z.array(VoiceTrackedSessionCandidateV1Schema),
}));

const VoiceTrackedSessionMutationErrorV1Schema = lazyZodSchema(() => z.object({
  code: z.enum([
    'session_not_found',
    'session_ambiguous',
    'session_lookup_incomplete',
    'session_follow_unavailable',
  ]),
  message: z.string().trim().min(1),
  sessionTitle: z.string().trim().min(1).optional(),
  sessionId: z.string().optional(),
  candidates: z.array(VoiceTrackedSessionCandidateV1Schema).max(50).optional(),
}).strict());

export const VoiceTrackedTargetsActionResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  VoiceTrackedSessionProjectionV1Schema.extend({
    ok: z.literal(true),
    status: z.literal('ok'),
  }).strict(),
  VoiceTrackedSessionProjectionV1Schema.extend({
    ok: z.literal(false),
    status: z.literal('partial'),
    error: z.object({
      code: z.literal('session_follow_partial'),
      message: z.string().trim().min(1),
      operation: z.enum(['include', 'exclude']),
      address: VoiceTrackedSessionAddressV1Schema,
      reason: z.union([SessionFollowErrorCodeV1Schema, z.literal('unavailable')]),
    }).strict(),
  }).strict(),
  z.object({
    ok: z.literal(false),
    status: z.enum(['not_found', 'ambiguous', 'incomplete', 'unavailable']),
    error: VoiceTrackedSessionMutationErrorV1Schema,
  }).strict(),
]));

export type VoiceTrackedTargetsActionResultV1 = Readonly<
  z.infer<typeof VoiceTrackedTargetsActionResultV1Schema>
>;
