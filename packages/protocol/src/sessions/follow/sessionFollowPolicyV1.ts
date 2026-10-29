import { z } from 'zod/mini';

import { lazyZodSchema } from '../../lazyZodSchema.js';
import type { SessionFollowSelectedDeliveryV1 } from './sessionFollowSelectedDeliveryV1.js';
import { defineStoredReadProjection } from '../../json/storedReadSchema.js';
import type { SessionQuestionContextV1, SessionQuestionHandlerV1 } from '../permissions/questionV1.js';
import { classifyWorkerUpdateEventV1, type WorkerUpdateV1 } from '../relations/workerUpdateV1.js';
import type { DiscussionAddressingV1 } from '../../discussions/references.js';
import type { DiscussionMessageV1 } from '../../discussions/models.js';
import type { SessionMessageReplyAdmissionV1 } from '../messages/sessionMessageReplyV1.js';
import type { SessionPersonalAttentionProjectionV1, SessionPersonalAttentionReasonV1 } from '../personal/attention.js';
import type { PersonalFollowOnceOccurrenceV1 } from './accountFollow.js';

export const FOLLOW_EVENT_KINDS_V1 = [
  'needs_you', 'finished', 'failed_or_stopped', 'stalled', 'update_posted', 'person_wrote', 'goal_changed', 'message',
] as const;
export const FollowEventKindV1Schema = lazyZodSchema(() => z.enum(FOLLOW_EVENT_KINDS_V1));
export type FollowEventKindV1 = z.infer<typeof FollowEventKindV1Schema>;
export const FOLLOW_POLICY_PRESET_KINDS_V1 = ['everything', 'important', 'quiet'] as const;

export const FollowNeedsYouTypeV1Schema = lazyZodSchema(() => z.enum(['decision', 'approval', 'blocked']));
export type FollowEventDeliveryV1 = { delivery: 'off' | 'quiet' | 'interrupt'; voice?: boolean };
export type FollowEventMapV1 = Partial<Record<Exclude<FollowEventKindV1, 'needs_you'>, FollowEventDeliveryV1>> & {
  needs_you?: Partial<Record<'decision' | 'approval' | 'blocked', FollowEventDeliveryV1>>;
};
export type FollowPolicyV1 =
  | { preset: 'everything' | 'important' | 'quiet'; voice?: boolean }
  | { preset: 'custom'; events: FollowEventMapV1 };
const FollowEventDeliveryV1Schema = lazyZodSchema(() => z.strictObject({
  delivery: z.enum(['off', 'quiet', 'interrupt']),
  voice: z.optional(z.boolean()),
}));
const FollowEventMapV1Schema = lazyZodSchema(() => z.strictObject({
  needs_you: z.optional(z.strictObject({
    decision: z.optional(FollowEventDeliveryV1Schema),
    approval: z.optional(FollowEventDeliveryV1Schema),
    blocked: z.optional(FollowEventDeliveryV1Schema),
  })),
  finished: z.optional(FollowEventDeliveryV1Schema),
  failed_or_stopped: z.optional(FollowEventDeliveryV1Schema),
  stalled: z.optional(FollowEventDeliveryV1Schema),
  update_posted: z.optional(FollowEventDeliveryV1Schema),
  person_wrote: z.optional(FollowEventDeliveryV1Schema),
  goal_changed: z.optional(FollowEventDeliveryV1Schema),
  message: z.optional(FollowEventDeliveryV1Schema),
}));

/** Closed mutation policy. Unselected Custom events are off. */
export const FollowPolicyV1Schema: z.ZodMiniType<FollowPolicyV1, FollowPolicyV1> = lazyZodSchema(() => z.discriminatedUnion('preset', [
  z.strictObject({ preset: z.enum(FOLLOW_POLICY_PRESET_KINDS_V1), voice: z.optional(z.boolean()) }),
  z.strictObject({ preset: z.literal('custom'), events: FollowEventMapV1Schema }),
]));
defineStoredReadProjection(FollowPolicyV1Schema, () => FollowPolicyV1Schema);

/** Schema-order serialization makes policy currentness independent of input key order. */
export function serializeFollowPolicyV1(policy: FollowPolicyV1): string {
  return JSON.stringify(FollowPolicyV1Schema.parse(policy));
}

export function isFollowPolicyEqualV1(left: FollowPolicyV1, right: FollowPolicyV1): boolean {
  return serializeFollowPolicyV1(left) === serializeFollowPolicyV1(right);
}

export const FollowEventV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({
    kind: z.literal('needs_you'),
    type: FollowNeedsYouTypeV1Schema,
    mode: z.optional(z.enum(['wait', 'continue'])),
    /** The request owner decides this at raise/pass-up time. */
    handling: z.optional(z.enum(['person', 'manager'])),
  }),
  z.strictObject({ kind: z.enum([
    'finished', 'failed_or_stopped', 'stalled', 'update_posted', 'person_wrote', 'goal_changed', 'message',
  ]) }),
]));
export type FollowEventV1 = z.infer<typeof FollowEventV1Schema>;
export { SessionFollowSelectedDeliveryV1Schema, type SessionFollowSelectedDeliveryV1 } from './sessionFollowSelectedDeliveryV1.js';

/** Transient questions require current request identity, never an immutable transcript original. */
export function isMessageBackedFollowEventV1(event: FollowEventV1): boolean {
  return event.kind !== 'needs_you';
}

/** Projects request-owner facts; never chooses or authorizes a handler. */
export function resolveRequestFollowEventV1(input: Readonly<{
  requestKind: 'permission' | 'user_action';
  questionV1?: Pick<SessionQuestionContextV1, 'mode' | 'type'>;
  currentHandler?: SessionQuestionHandlerV1;
}>): Extract<FollowEventV1, { kind: 'needs_you' }> {
  if (input.requestKind === 'permission') return { kind: 'needs_you', type: 'approval' };
  return { kind: 'needs_you', type: input.questionV1?.type ?? 'decision',
    ...(input.questionV1 ? { mode: input.questionV1.mode } : {}),
    ...(input.currentHandler ? { handling: input.currentHandler.kind === 'session' ? 'manager' as const : 'person' as const } : {}),
  };
}

export type ResolveFollowDeliveryV1Params = Readonly<{
  policies: readonly FollowPolicyV1[];
  event: FollowEventV1;
  muted?: boolean;
  causalEcho?: boolean;
  /** Exact committed addressing plus C2's answer destination, never an event-only wake hint. */
  discussionInput?: Readonly<{
    addressing: DiscussionAddressingV1;
    original: Pick<DiscussionMessageV1, 'id' | 'discussionId' | 'seq' | 'addressingV1'>;
    reply: Pick<SessionMessageReplyAdmissionV1, 'mode' | 'discussion'> | null;
  }>;
}>;

export function hasDirectDiscussionAnswerObligation(input: ResolveFollowDeliveryV1Params['discussionInput']): boolean {
  if (!input || input.reply?.mode !== 'return') return false;
  const { addressing, original, reply } = input;
  const snapshot = original.addressingV1;
  const destination = reply.discussion;
  return original.id === addressing.messageId && original.discussionId === addressing.discussionId
    && original.seq === addressing.throughSeq && snapshot?.throughSeq === addressing.throughSeq
    && snapshot.participantSessionIds.includes(addressing.participantSessionId)
    && !snapshot.watcherSessionIds?.includes(addressing.participantSessionId)
    && destination?.discussionId === addressing.discussionId && destination.messageId === addressing.messageId
    && destination.throughSeq === addressing.throughSeq && destination.participantSessionId === addressing.participantSessionId;
}

export type FollowDeliveryDecisionV1 = Readonly<{
  selected: boolean;
  interrupt: boolean;
  voice: boolean;
  person: Readonly<{ inbox: boolean; push: boolean; voice: boolean }>;
  session: Readonly<{ nextTurn: boolean; wake: boolean }>;
}>;

/** C1 §4.3: one event table, projected onto either receiver's channels. */
function resolveRoute(policy: FollowPolicyV1, event: FollowEventV1) {
  if (policy.preset === 'custom') {
    return event.kind === 'needs_you'
      ? policy.events.needs_you?.[event.type]
      : policy.events[event.kind];
  }
  if (event.kind === 'message' && policy.preset !== 'everything') return { delivery: 'off' as const, voice: policy.voice };
  const urgent = event.kind === 'failed_or_stopped' || event.kind === 'stalled'
    || event.kind === 'needs_you' && event.mode !== 'continue';
  const interrupt = policy.preset === 'everything'
    ? event.kind !== 'message'
    : policy.preset === 'important' && urgent;
  return { delivery: interrupt ? 'interrupt' as const : 'quiet' as const, voice: policy.voice };
}

export function resolveFollowDeliveryV1(params: ResolveFollowDeliveryV1Params): FollowDeliveryDecisionV1 {
  let selected = false;
  let interrupt = false;
  let voice = false;
  if (!params.muted && !params.causalEcho) {
    for (const policy of params.policies) {
      const route = resolveRoute(policy, params.event);
      if (!route) continue;
      voice ||= route.voice === true;
      if (route.delivery === 'off') continue;
      selected = true;
      interrupt ||= route.delivery === 'interrupt';
    }
    // C3's concrete addressed C2 obligation is a direct ask, not an ambient
    // Follow event. Stored levels still govern informational/watch delivery.
    if (hasDirectDiscussionAnswerObligation(params.discussionInput)) {
      selected = true;
      interrupt = true;
    }
  }
  const managerHandling = params.event.kind === 'needs_you' && params.event.handling === 'manager';
  return {
    selected, interrupt, voice,
    person: { inbox: selected, push: interrupt && !managerHandling, voice: voice && !managerHandling },
    session: { nextTurn: selected && !interrupt, wake: interrupt },
  };
}

/** Source adapters retain their own custody; event selection and wake use this one policy owner. */
export function resolveWorkerUpdateFollowDeliveryV1(params: Readonly<{
  update: WorkerUpdateV1;
  policies?: readonly FollowPolicyV1[];
  /** Actual request evidence overrides the ordinary non-approval attention projection. */
  needsYou?: Omit<Extract<FollowEventV1, { kind: 'needs_you' }>, 'kind'>;
}>): FollowDeliveryDecisionV1 | null {
  const kind = classifyWorkerUpdateEventV1(params.update);
  if (kind === null) return null;
  return resolveFollowDeliveryV1({
    policies: params.policies ?? [{ preset: 'important' }],
    event: kind === 'needs_you' ? { kind, ...(params.needsYou ?? { type: 'decision' }) } : { kind },
  });
}

export const InboxItemAttentionTypeV1Schema = lazyZodSchema(() => z.union([
  FollowNeedsYouTypeV1Schema, z.literal('update'), z.literal('mention'),
]));
export type InboxItemAttentionTypeV1 = z.infer<typeof InboxItemAttentionTypeV1Schema>;

export type SessionInboxAttentionClassificationV1 = Readonly<{
  section: 'needs_attention' | 'ready' | null;
  type: InboxItemAttentionTypeV1 | null;
  onceDelivery?: PersonalFollowOnceOccurrenceV1;
}>;

/** C1 admission over normalized owner facts; never loads requests or derives delivery policy. */
export function resolveSessionInboxAttentionV1(input: Readonly<{
  personalAttention: Pick<SessionPersonalAttentionProjectionV1, 'needsAttention' | 'reasons'>;
  hasBlockedPendingDelivery: boolean;
  working: boolean;
  ready: boolean;
  questionType?: SessionQuestionContextV1['type'];
  onceDelivery?: PersonalFollowOnceOccurrenceV1;
  onceAttentionReason?: SessionPersonalAttentionReasonV1 | null;
}>): SessionInboxAttentionClassificationV1 {
  const reasons = input.personalAttention.reasons;
  const type = reasons.includes('permission_required') ? 'approval'
    : reasons.includes('user_action_required') ? input.questionType ?? 'decision'
    : input.hasBlockedPendingDelivery ? 'blocked'
    : reasons.includes('mentioned') ? 'mention' : 'update';
  if (!input.personalAttention.needsAttention) return { section: null, type: null };

  const onceReason = input.onceAttentionReason;
  const onceDelivery = type === 'update' && onceReason && reasons.includes(onceReason) ? input.onceDelivery : undefined;
  const hasSessionReadAttention = reasons.some(isClearedBySessionManualRead);
  const hasOtherAttention = reasons.some(reason => !isClearedBySessionManualRead(reason));
  // Accepted completion custody remains attached to its original turn while newer work runs.
  const hasReadyForReviewAttention = hasSessionReadAttention
    && (onceDelivery !== undefined && onceReason === 'ready_after_read'
      || !input.working && (input.ready || reasons.includes('ready_after_read')));
  const section = hasOtherAttention ? 'needs_attention' : hasReadyForReviewAttention ? 'ready' : null;
  return { section, type: section === null ? null : type,
    ...(onceDelivery ? { onceDelivery } : {}) };
}

/** Discussion-owned news survives a Session cursor; only transcript progress is cleared there. */
function isClearedBySessionManualRead(reason: SessionPersonalAttentionReasonV1): boolean {
  switch (reason) {
    case 'unread':
    case 'ready_after_read':
      return true;
    case 'failed':
    case 'permission_required':
    case 'user_action_required':
    case 'pending_blocked':
    case 'mentioned':
    case 'unread_discussion':
    case 'reminder_due':
    case 'manual':
      return false;
  }
}

export function resolveInboxItemAttentionV1(type: InboxItemAttentionTypeV1) {
  return resolveFollowDeliveryV1({
    policies: [{ preset: 'important' }],
    event: type === 'update' || type === 'mention'
      ? { kind: 'update_posted' }
      : { kind: 'needs_you', type },
  });
}

/** One policy decision projected onto the existing Session intake boundaries. */
export function resolveSessionFollowSelectedDeliveryV1(input: ResolveFollowDeliveryV1Params): SessionFollowSelectedDeliveryV1 | null {
  const selected = resolveFollowDeliveryV1(input);
  return selected.session.wake ? 'wake' : selected.session.nextTurn ? 'next_turn' : null;
}

/** Surviving reasons coalesce without turning no-selection into a quiet vote. */
export function mergeSessionFollowSelectedDeliveriesV1(votes: Iterable<SessionFollowSelectedDeliveryV1 | null>): SessionFollowSelectedDeliveryV1 | null {
  let selected: SessionFollowSelectedDeliveryV1 | null = null;
  for (const vote of votes) {
    if (vote === 'wake') return 'wake';
    if (vote === 'next_turn') selected = vote;
  }
  return selected;
}
