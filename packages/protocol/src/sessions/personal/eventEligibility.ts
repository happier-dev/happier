import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import {
  type SessionFollowFactsV1,
  type SessionFollowNotificationLevel,
  SessionFollowNotificationLevelSchema,
  resolveEffectiveSessionFollowNotificationLevelV1,
} from '../follow/accountFollow.js';

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
]));
export type SessionPersonalEventEligibilityReasonV1 = z.infer<
  typeof SessionPersonalEventEligibilityReasonV1Schema
>;

export const SessionPersonalEventEligibilityV1Schema = lazyZodSchema(() => z
  .object({
    eligible: z.boolean(),
    reason: SessionPersonalEventEligibilityReasonV1Schema.optional(),
  })
  .strict());
export type SessionPersonalEventEligibilityV1 = Readonly<{
  eligible: boolean;
  reason?: SessionPersonalEventEligibilityReasonV1;
}>;

export const SessionEffectiveNotificationV1Schema = lazyZodSchema(() => z
  .object({
    level: SessionFollowNotificationLevelSchema,
    source: z.enum(['preference', 'owner', 'none']),
  })
  .strict());
export type SessionEffectiveNotificationV1 = Readonly<{
  level: SessionFollowNotificationLevel;
  source: 'preference' | 'owner' | 'none';
}>;

/**
 * Composes the Follow owner's level resolution with the origin a caller needs in
 * order to explain the choice. `preference` covers automatic Follow, explicit
 * Follow and explicit suppression alike — no extra stored origin is needed, and
 * responsibility deliberately has no implicit fallback here because assignment's
 * default is implemented once, as a real Follow row.
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
  capabilities: Readonly<{ canSubmitAgentInput: boolean; canApprovePermissions: boolean }>;
}>;

const INELIGIBLE: SessionPersonalEventEligibilityV1 = Object.freeze({ eligible: false });

/** Events that only an Important-or-higher subscription admits. */
const IMPORTANT_CLASS_EVENTS: ReadonlySet<SessionPersonalEventKindV1> = new Set([
  'ready',
  'failed',
  'cancelled',
  'source_unavailable',
  'human_message',
]);

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

  if (input.event === 'assigned') {
    if (!input.targeted || !input.tracked) return INELIGIBLE;
    // Assignment remains a targeted in-app fact, while an OS alert is admitted
    // only through the assignee's effective Follow. The default-on assignment
    // preference creates that Follow at the mutation owner; disabling it or an
    // explicit Unfollow therefore cannot be bypassed by responsibility alone.
    return subscriptionReason(resolveSessionEffectiveNotificationV1({
      facts: input.followFacts,
      isSessionOwner: input.isSessionOwner,
    }))
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
    const capable = input.event === 'permission_required'
      ? input.capabilities.canApprovePermissions || input.responsible
      : input.capabilities.canSubmitAgentInput || input.responsible;
    if (!capable) return INELIGIBLE;
    if (input.targeted) return { eligible: true, reason: 'targeted_capable_action' };
    if (!input.tracked) return INELIGIBLE;
    const reason = subscriptionReason(resolveSessionEffectiveNotificationV1({
      facts: input.followFacts,
      isSessionOwner: input.isSessionOwner,
    }));
    return reason ? { eligible: true, reason } : INELIGIBLE;
  }

  if (!input.tracked) return INELIGIBLE;
  const notification = resolveSessionEffectiveNotificationV1({
    facts: input.followFacts,
    isSessionOwner: input.isSessionOwner,
  });
  const reason = subscriptionReason(notification);
  if (!reason) return INELIGIBLE;
  if (!IMPORTANT_CLASS_EVENTS.has(input.event) && notification.level !== 'all_messages') {
    return INELIGIBLE;
  }
  return { eligible: true, reason };
}
