import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

import {
  AttentionPreviewBehaviorSchema,
  type RemoteAlertAttentionDeliveryEventId,
} from '../account/settings/attentionDeliveryPolicy.js';
import type { SessionPersonalEventKindV1 } from '../sessions/personal/eventEligibility.js';
import {
  resolveActivityRequestEventIdentityV1,
  resolveActivitySequenceEventIdentityV1,
  resolveActivityTurnEventIdentityV1,
  resolveLegacyActivitySequenceEventIdentityV1,
} from '../activity/eventIdentity.js';
import {
  SessionDiscussionIdSchema,
  type SessionDiscussionId,
} from '../sessions/idsV1.js';

/**
 * The committed canonical reference an alert points at, never a delivery
 * receipt. Transcript-backed categories carry their committed sequence; the
 * other categories are current-state facts whose exact occurrence the native
 * consumer rechecks.
 */
export const ActivityRemoteAlertEventV1Schema = lazyZodSchema(() => z.discriminatedUnion('type', [
  z.object({
    type: z.literal('ready'),
    messageSeq: z.number().int().positive().max(2_147_483_647),
  }).strict(),
  z.object({ type: z.literal('permission_request') }).strict(),
  z.object({ type: z.literal('user_action_request') }).strict(),
  z.object({ type: z.literal('assigned') }).strict(),
  z.object({ type: z.literal('failed'), turnId: z.string().trim().min(1) }).strict(),
  z.object({ type: z.literal('cancelled'), turnId: z.string().trim().min(1) }).strict(),
  z.object({ type: z.literal('human_message'), messageSeq: z.number().int().positive().max(2_147_483_647) }).strict(),
  z.object({ type: z.literal('message'), messageSeq: z.number().int().positive().max(2_147_483_647) }).strict(),
  z.object({ type: z.literal('discussion_mention'), messageSeq: z.number().int().positive().max(2_147_483_647) }).strict(),
  z.object({ type: z.literal('source_unavailable') }).strict(),
]));
export type ActivityRemoteAlertEventV1 = z.infer<typeof ActivityRemoteAlertEventV1Schema>;

export const ActivityRemoteAlertSequenceDomainV2Schema = lazyZodSchema(() => z.enum([
  'session_transcript',
  'discussion',
]));
export type ActivityRemoteAlertSequenceDomainV2 = z.infer<typeof ActivityRemoteAlertSequenceDomainV2Schema>;

/** The Agent-allocated identity of one committed permission/user-action request. */
const ActivityRequestIdSchema = lazyZodSchema(() => z.string().trim().min(1).max(191));

const SessionTranscriptSequenceV2Schema = lazyZodSchema(() => z.object({
  sequenceDomain: z.literal('session_transcript'),
  messageSeq: z.number().int().positive().max(2_147_483_647),
}));
const DiscussionSequenceV2Schema = lazyZodSchema(() => z.object({
  sequenceDomain: z.literal('discussion'),
  discussionId: SessionDiscussionIdSchema,
  messageSeq: z.number().int().positive().max(2_147_483_647),
}));

/** Content-free committed message reference shared by Activity transports. */
export const ActivityMessageReferenceV2Schema = lazyZodSchema(() => z.discriminatedUnion('sequenceDomain', [
  SessionTranscriptSequenceV2Schema.strict(),
  DiscussionSequenceV2Schema.strict(),
]));

/**
 * Current closed event epoch.
 *
 * V1's bare `messageSeq` is ambiguous because Session transcripts and each
 * Discussion allocate independent sequences. V2 makes that routing fact and
 * the exact Discussion owner explicit, so a Discussion-local sequence can
 * never collide with another Discussion or authorize selection from the main
 * Session transcript.
 */
export const ActivityRemoteAlertEventV2Schema = lazyZodSchema(() => z.union([
  SessionTranscriptSequenceV2Schema.extend({ type: z.literal('ready') }).strict(),
  z.union([
    SessionTranscriptSequenceV2Schema.extend({ type: z.literal('human_message') }).strict(),
    DiscussionSequenceV2Schema.extend({ type: z.literal('human_message') }).strict(),
  ]),
  z.union([
    SessionTranscriptSequenceV2Schema.extend({ type: z.literal('message') }).strict(),
    DiscussionSequenceV2Schema.extend({ type: z.literal('message') }).strict(),
  ]),
  DiscussionSequenceV2Schema.extend({ type: z.literal('discussion_mention') }).strict(),
  // The Agent-allocated request id is the cross-leg identity of one committed
  // request. It is optional only because a producer without a committed request
  // in hand must still be able to describe the category.
  z.object({ type: z.literal('permission_request'), requestId: ActivityRequestIdSchema.optional() }).strict(),
  z.object({ type: z.literal('user_action_request'), requestId: ActivityRequestIdSchema.optional() }).strict(),
  z.object({ type: z.literal('assigned') }).strict(),
  z.object({ type: z.literal('failed'), turnId: z.string().trim().min(1) }).strict(),
  z.object({ type: z.literal('cancelled'), turnId: z.string().trim().min(1) }).strict(),
  z.object({ type: z.literal('source_unavailable') }).strict(),
]));
export type ActivityRemoteAlertEventV2 = z.infer<typeof ActivityRemoteAlertEventV2Schema>;

/**
 * The canonical event vocabulary advertised by native enrichment consumers.
 *
 * Platform-native Swift/Kotlin parsers mirror this closed wire union and are
 * checked against it at build time; TypeScript consumers import this tuple
 * directly instead of maintaining another same-concept registry.
 */
export const ACTIVITY_REMOTE_ALERT_EVENT_TYPES_V1: readonly ActivityRemoteAlertEventV1['type'][] =
  ActivityRemoteAlertEventV1Schema.options.map((option) => option.shape.type.value);

/** The reference is the committed ready SessionMessage, never a delivery receipt. */
export const ActivityRemoteAlertV1Schema = lazyZodSchema(() => z.object({
  type: z.literal('activity_alert'),
  v: z.literal(1),
  serverId: z.string().trim().min(1),
  sessionId: z.string().trim().min(1),
  accountId: z.string().trim().min(1),
  event: ActivityRemoteAlertEventV1Schema,
  previewBehavior: AttentionPreviewBehaviorSchema,
}).strict());

export type ActivityRemoteAlertV1 = z.infer<typeof ActivityRemoteAlertV1Schema>;

export const ActivityRemoteAlertV2Schema = lazyZodSchema(() => z.object({
  type: z.literal('activity_alert'),
  v: z.literal(2),
  serverId: z.string().trim().min(1),
  sessionId: z.string().trim().min(1),
  accountId: z.string().trim().min(1),
  event: ActivityRemoteAlertEventV2Schema,
  previewBehavior: AttentionPreviewBehaviorSchema,
}).strict());
export type ActivityRemoteAlertV2 = z.infer<typeof ActivityRemoteAlertV2Schema>;

/**
 * Supported reader epochs. V1 is retained only as a released compatibility
 * input; consumers must not use its ambiguous sequence to fetch preview text.
 */
export const ActivityRemoteAlertSchema = lazyZodSchema(() => z.discriminatedUnion('v', [
  ActivityRemoteAlertV1Schema,
  ActivityRemoteAlertV2Schema,
]));
export type ActivityRemoteAlert = z.infer<typeof ActivityRemoteAlertSchema>;

/**
 * Derive the device-local identity of a committed remote Activity event.
 *
 * This is a presentation-suppression identity, never a delivery receipt. V1
 * references retain a distinct compatibility namespace because their bare
 * message sequence is ambiguous across the Session transcript and Discussions.
 */
export function resolveActivityRemoteAlertEventIdentity(
  alert: ActivityRemoteAlert,
): string | undefined {
  if (alert.v === 1) {
    const event = alert.event;
    if (
      event.type === 'ready'
      || event.type === 'human_message'
      || event.type === 'message'
      || event.type === 'discussion_mention'
    ) {
      return resolveLegacyActivitySequenceEventIdentityV1(event.messageSeq);
    }
    if (event.type === 'failed' || event.type === 'cancelled') {
      return resolveActivityTurnEventIdentityV1(event.turnId);
    }
    return undefined;
  }
  return resolveActivityEventIdentityV2(alert.event);
}

/** One identity projection shared by Home, rich and device-local V2 event references. */
export function resolveActivityEventIdentityV2(event: ActivityRemoteAlertEventV2): string | undefined {
  if ('sequenceDomain' in event) {
    return resolveActivitySequenceEventIdentityV1(event.sequenceDomain === 'discussion'
      ? {
          sequenceDomain: event.sequenceDomain,
          discussionId: event.discussionId,
          sequence: event.messageSeq,
        }
      : {
          sequenceDomain: event.sequenceDomain,
          sequence: event.messageSeq,
        });
  }
  if (event.type === 'failed' || event.type === 'cancelled') {
    return resolveActivityTurnEventIdentityV1(event.turnId);
  }
  if (
    (event.type === 'permission_request' || event.type === 'user_action_request')
    && 'requestId' in event
    && event.requestId !== undefined
  ) {
    return resolveActivityRequestEventIdentityV1(event.requestId);
  }
  return undefined;
}

/**
 * Each supported alert category resolves to exactly one existing attention
 * policy event. Assignment reuses the one `follow_update` family with its
 * reconciled reason as non-policy metadata, so no global setting is added per
 * semantic reason (Lane 09C §17.1).
 */
export const ACTIVITY_REMOTE_ALERT_POLICY_EVENT_V1 = {
  ready: 'ready',
  permission_request: 'permission_request',
  user_action_request: 'user_action_request',
  assigned: 'follow_update',
  failed: 'follow_update',
  cancelled: 'follow_update',
  human_message: 'follow_update',
  message: 'follow_update',
  discussion_mention: 'follow_update',
  source_unavailable: 'follow_update',
} as const satisfies Record<ActivityRemoteAlertEventV1['type'], RemoteAlertAttentionDeliveryEventId>;

export type ActivityRemoteAlertCommittedMessageV2 =
  | Readonly<{ domain: 'session_transcript'; seq: number }>
  | Readonly<{ domain: 'discussion'; discussionId: SessionDiscussionId; seq: number }>;

/**
 * The sole writer admission boundary between personal events and Home alerts.
 * Every sequence-bearing event declares its owner; V1 remains reader-only.
 */
export function resolveActivityRemoteAlertEventForPersonalEventV2(
  kind: SessionPersonalEventKindV1,
  committedMessage?: ActivityRemoteAlertCommittedMessageV2,
  committedTurnId?: string,
  committedRequestId?: string,
): ActivityRemoteAlertEventV2 | null {
  if (kind === 'ready' || kind === 'human_message' || kind === 'message' || kind === 'discussion_mention') {
    const sequenceDomain = committedMessage?.domain;
    if (kind === 'ready' && sequenceDomain !== 'session_transcript') return null;
    if (kind === 'discussion_mention' && sequenceDomain !== 'discussion') return null;
    const parsed = ActivityRemoteAlertEventV2Schema.safeParse({
      type: kind,
      sequenceDomain,
      ...(committedMessage?.domain === 'discussion'
        ? { discussionId: committedMessage.discussionId }
        : {}),
      messageSeq: committedMessage?.seq,
    });
    return parsed.success ? parsed.data : null;
  }
  if (kind === 'failed' || kind === 'cancelled') {
    const parsed = ActivityRemoteAlertEventV2Schema.safeParse({ type: kind, turnId: committedTurnId });
    return parsed.success ? parsed.data : null;
  }
  if (kind === 'permission_required' || kind === 'user_action_required') {
    const parsed = ActivityRemoteAlertEventV2Schema.safeParse({
      type: kind === 'permission_required' ? 'permission_request' : 'user_action_request',
      ...(committedRequestId === undefined ? {} : { requestId: committedRequestId }),
    });
    return parsed.success ? parsed.data : null;
  }
  if (kind === 'assigned') return { type: 'assigned' };
  if (kind === 'source_unavailable') return { type: 'source_unavailable' };
  return null;
}
