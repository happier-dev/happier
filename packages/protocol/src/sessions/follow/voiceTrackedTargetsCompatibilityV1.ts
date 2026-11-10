import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import { SessionFollowErrorCodeV1Schema } from './api.js';
import { VoiceTrackedSessionAddressV1Schema } from './voiceTrackedSessionAddressV1.js';
export { VoiceTrackedSessionAddressV1Schema } from './voiceTrackedSessionAddressV1.js';

const VoiceTrackedSessionCandidateV1Schema = lazyZodSchema(() => z.strictObject({
  address: VoiceTrackedSessionAddressV1Schema,
  id: z.string().check(z.trim(), z.minLength(1)),
  title: z.optional(z.string().check(z.trim(), z.minLength(1))),
  locationLabel: z.optional(z.string().check(z.trim(), z.minLength(1))),
  serverId: z.string().check(z.trim(), z.minLength(1)),
  serverName: z.optional(z.string().check(z.trim(), z.minLength(1))),
}));

// Successful/partial projections mirror the uncapped canonical Account Voice
// replace API so a complete 51+ exact-Home replacement result can settle.
const VoiceTrackedSessionProjectionV1Schema = lazyZodSchema(() => z.object({
  sessionIds: z.array(z.string().check(z.trim(), z.minLength(1))),
  sessionAddresses: z.array(VoiceTrackedSessionAddressV1Schema),
  sessions: z.array(VoiceTrackedSessionCandidateV1Schema),
}));

const VoiceTrackedSessionMutationErrorV1Schema = lazyZodSchema(() => z.strictObject({
  code: z.enum([
    'session_not_found',
    'session_ambiguous',
    'session_lookup_incomplete',
    'session_follow_unavailable',
  ]),
  message: z.string().check(z.trim(), z.minLength(1)),
  sessionTitle: z.optional(z.string().check(z.trim(), z.minLength(1))),
  sessionId: z.optional(z.string()),
  candidates: z.optional(z.array(VoiceTrackedSessionCandidateV1Schema).check(z.maxLength(50))),
}));

export const VoiceTrackedTargetsActionResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(VoiceTrackedSessionProjectionV1Schema, {
    ok: z.literal(true),
    status: z.literal('ok'),
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(VoiceTrackedSessionProjectionV1Schema, {
    ok: z.literal(false),
    status: z.literal('partial'),
    error: z.strictObject({
      code: z.literal('session_follow_partial'),
      message: z.string().check(z.trim(), z.minLength(1)),
      operation: z.enum(['include', 'exclude']),
      address: VoiceTrackedSessionAddressV1Schema,
      reason: z.union([SessionFollowErrorCodeV1Schema, z.literal('unavailable')]),
    }),
  })),
  z.strictObject({
    ok: z.literal(false),
    status: z.enum(['not_found', 'ambiguous', 'incomplete', 'unavailable']),
    error: VoiceTrackedSessionMutationErrorV1Schema,
  }),
]));

export type VoiceTrackedTargetsActionResultV1 = Readonly<
  z.infer<typeof VoiceTrackedTargetsActionResultV1Schema>
>;
