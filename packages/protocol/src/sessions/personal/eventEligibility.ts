import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import {
  matchesPersonalFollowOnceOccurrenceV1,
  type PersonalFollowOnceOccurrenceV1,
  type SessionFollowFactsV1,
  type SessionFollowNotificationLevel,
  SessionFollowNotificationLevelSchema,
  resolveEffectiveSessionFollowNotificationLevelV1,
  resolveEffectiveAccountFollowPolicyV1,
} from '../follow/accountFollow.js';
import {
  resolveFollowDeliveryV1,
  type FollowEventV1,
  type FollowPolicyV1,
} from '../follow/sessionFollowPolicyV1.js';

/**
 * The bounded material event kinds one Account can be considered for. The
 * semantic classifier that produces them runs over authorized canonical facts;
 * this owner only decides recipient candidacy (L09B-R6/R7). Device policy,
 * quiet hours, previews, sound and channel remain the existing delivery owner's.
 */
export const SessionPersonalEventKindV1Schema = lazyZodSchema(() => z.enum([
  'assigned',
  'directly_shared',
  'discussion_mention',
  'ready',
  'failed',
  'cancelled',
  'permission_required',
  'user_action_required',
  'human_message',
  'message',
  'source_unavailable',
]));
export type SessionPersonalEventKindV1 = z.infer<typeof SessionPersonalEventKindV1Schema>;

export const SessionPersonalEventEligibilityReasonV1Schema = lazyZodSchema(() => z.enum([
  'assignment_target',
  'direct_share_target',
  'discussion_mention_target',
  'owner_important',
  'targeted_capable_action',
  'follow_important',
  'follow_all_messages',
  'follow_policy',
  'follow_once',
]));
export type SessionPersonalEventEligibilityReasonV1 = z.infer<
  typeof SessionPersonalEventEligibilityReasonV1Schema
>;

export const SessionPersonalEventEligibilityV1Schema = lazyZodSchema(() => z.strictObject({
    eligible: z.boolean(),
    reason: z.optional(SessionPersonalEventEligibilityReasonV1Schema),
  }));
export type SessionPersonalEventEligibilityV1 = Readonly<{
  eligible: boolean;
  reason?: SessionPersonalEventEligibilityReasonV1;
}>;

export const SessionEffectiveNotificationV1Schema = lazyZodSchema(() => z.strictObject({
    level: SessionFollowNotificationLevelSchema,
    source: z.enum(['preference', 'owner', 'none']),
  }));
export type SessionEffectiveNotificationV1 = Readonly<{
  level: SessionFollowNotificationLevel;
  source: 'preference' | 'owner' | 'none';
}>;

/**
 * Composes the Follow owner's level resolution with the origin a caller needs in
 * order to explain the choice. `preference` covers retained or explicit Follow
 * and explicit suppression alike. Relationship defaults arrive as admitted rule
 * policies through the canonical normalizer; responsibility grants no implicit
 * fallback here.
 */
export function resolveSessionEffectiveNotificationV1(params: Readonly<{
  facts: SessionFollowFactsV1;
  isSessionOwner: boolean;
}>): SessionEffectiveNotificationV1 {
  const level = resolveEffectiveSessionFollowNotificationLevelV1(params);
  if (params.facts.notificationLevel !== null && params.facts.notificationLevel !== undefined) {
    return { level, source: 'preference' };
  }
  return params.isSessionOwner ? { level, source: 'owner' } : { level, source: 'none' };
}

export type SessionPersonalEventEligibilityInputV1 = Readonly<{
  event: SessionPersonalEventKindV1;
  isSessionOwner: boolean;
  accessible: boolean;
  accountSuspended: boolean;
  archived: boolean;
  responsible: boolean;
  /** Owner-or-active-Follow: the gate for every *ongoing* event. */
  tracked: boolean;
  /**
   * This exact Account is the subject of a one-shot event (assignment target,
   * direct-share recipient, canonical mention target, explicit action request).
   * A one-shot fact never becomes a replayable subscription.
   */
  targeted: boolean;
  followFacts: SessionFollowFactsV1;
  /** Exact occurrence supplied by its committed producer, never a socket hint. */
  onceOccurrence?: PersonalFollowOnceOccurrenceV1;
  /** Question mode/type/handler projected by its canonical committed source. */
  followEvent?: FollowEventV1;
  /** Already matched by the authorized private-rule evaluator; never grants source access. */
  admittedRulePolicies?: readonly FollowPolicyV1[];
  capabilities: Readonly<{ canSubmitAgentInput: boolean; canApprovePermissions: boolean }>;
}>;

const INELIGIBLE: SessionPersonalEventEligibilityV1 = Object.freeze({ eligible: false });

/** Thin adapter from committed personal facts, never a second event-selection table. */
export function resolveSessionPersonalFollowEventV1(event: SessionPersonalEventKindV1): FollowEventV1 | null {
  switch (event) {
    case 'ready': return { kind: 'finished' };
    case 'failed': case 'cancelled': return { kind: 'failed_or_stopped' };
    case 'permission_required': return { kind: 'needs_you', type: 'approval' };
    case 'user_action_required': return { kind: 'needs_you', type: 'decision' };
    case 'human_message': return { kind: 'person_wrote' };
    case 'message': return { kind: 'message' };
    // Relationship changes, mentions and access-repair notices have their own
    // committed targeted producers; they are not fabricated Follow occurrences.
    default: return null;
  }
}

const ACTION_CLASS_EVENTS: ReadonlySet<SessionPersonalEventKindV1> = new Set([
  'permission_required',
  'user_action_required',
]);

function subscriptionReason(
  notification: SessionEffectiveNotificationV1,
): SessionPersonalEventEligibilityReasonV1 | null {
  if (notification.level === 'none') return null;
  if (notification.level === 'all_messages') return 'follow_all_messages';
  return notification.source === 'owner' ? 'owner_important' : 'follow_important';
}

function selectedSubscriptionReason(input: SessionPersonalEventEligibilityInputV1): SessionPersonalEventEligibilityReasonV1 | null {
  const policy = resolveEffectiveAccountFollowPolicyV1({ facts: input.followFacts, isSessionOwner: input.isSessionOwner });
  const rules = !input.followFacts.follows && input.followFacts.notificationLevel === 'none'
    ? [] : input.admittedRulePolicies ?? [];
  const policies = [...(policy ? [policy] : []), ...rules];
  if (policies.length === 0) return null;
  const event = input.followEvent ?? resolveSessionPersonalFollowEventV1(input.event);
  if (event && !resolveFollowDeliveryV1({ policies, event }).selected) return null;
  return input.followFacts.policy || rules.length > 0 ? 'follow_policy'
    : subscriptionReason(resolveSessionEffectiveNotificationV1({ facts: input.followFacts, isSessionOwner: input.isSessionOwner }));
}

/**
 * Recipient/event eligibility for one Account (L09B-R6). It runs BEFORE the
 * existing delivery-policy owner and never learns Team membership, device
 * policy or quiet hours. Broad synchronization fanout is a different contract
 * and never reaches this function.
 */
export function resolveSessionPersonalEventEligibilityV1(
  input: SessionPersonalEventEligibilityInputV1,
): SessionPersonalEventEligibilityV1 {
  if (!input.accessible || input.accountSuspended || input.archived) return INELIGIBLE;
  // Native user-action transport also carries host Action confirmations. Its
  // source-owned semantic type, not the RPC carrier, establishes candidacy.
  const sourceEvent = input.followEvent?.kind === 'needs_you' && input.followEvent.type === 'approval'
    && input.event === 'user_action_required' ? 'permission_required' : input.event;
  const occurrence = input.onceOccurrence;
  const delivered = input.followFacts.onceDelivery;
  // The original source transaction may already have accepted Inbox custody.
  // Only its explicitly targeted, exact retained occurrence can continue to
  // transport; a fulfilled record never becomes a replayable subscription.
  const acceptedOnce = input.targeted && occurrence?.event === sourceEvent && delivered
    && delivered.event === occurrence.event && delivered.turnId === occurrence.turnId
    && delivered.requestId === occurrence.requestId && delivered.agentStateVersion === occurrence.agentStateVersion
    && delivered.transcriptSeq === occurrence.transcriptSeq;
  const onceSelected = acceptedOnce || input.followFacts.once && input.onceOccurrence?.event === sourceEvent
    && input.followFacts.onceAfterAgentStateVersion !== undefined
    && matchesPersonalFollowOnceOccurrenceV1({ once: input.followFacts.once,
      baseline: { agentStateVersion: input.followFacts.onceAfterAgentStateVersion }, occurrence: input.onceOccurrence });

  if (input.event === 'assigned') {
    if (!input.targeted || !input.tracked) return INELIGIBLE;
    // Assignment remains a targeted in-app fact, while an OS alert is admitted
    // only through the assignee's effective Follow policy. Default rules are
    // normalized at the recipient owner, never enrolled by assignment; disabling
    // the default or explicit Unfollow cannot be bypassed by responsibility alone.
    return selectedSubscriptionReason(input)
      ? { eligible: true, reason: 'assignment_target' }
      : INELIGIBLE;
  }
  if (input.event === 'directly_shared') {
    return input.targeted ? { eligible: true, reason: 'direct_share_target' } : INELIGIBLE;
  }
  if (input.event === 'discussion_mention') {
    return input.targeted ? { eligible: true, reason: 'discussion_mention_target' } : INELIGIBLE;
  }

  if (ACTION_CLASS_EVENTS.has(input.event)) {
    const capable = sourceEvent === 'permission_required'
      ? input.capabilities.canApprovePermissions || input.responsible
      : input.capabilities.canSubmitAgentInput || input.responsible;
    if (!capable) return INELIGIBLE;
    if (onceSelected) return { eligible: true, reason: 'follow_once' };
    if (input.targeted) return { eligible: true, reason: 'targeted_capable_action' };
    if (!input.tracked && !input.admittedRulePolicies?.length) return INELIGIBLE;
    const reason = selectedSubscriptionReason(input);
    return reason ? { eligible: true, reason } : INELIGIBLE;
  }

  if (onceSelected) return { eligible: true, reason: 'follow_once' };
  if (!input.tracked && !input.admittedRulePolicies?.length) return INELIGIBLE;
  const reason = selectedSubscriptionReason(input);
  if (!reason) return INELIGIBLE;
  return { eligible: true, reason };
}
