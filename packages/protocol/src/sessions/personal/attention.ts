import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import type { ViewerReadStateV1 } from './readState.js';
import { isSessionActionConfirmationRequest } from '../metadata/sessionActionConfirmationsV1.js';

export function resolvePendingRequestAttentionReasonV1(
  request: Readonly<{ kind: 'permission' | 'user_action'; source?: string }>,
): 'permission_required' | 'user_action_required' {
  return request.kind === 'user_action' && !isSessionActionConfirmationRequest(request)
    ? 'user_action_required' : 'permission_required';
}

/** The same grant policy serves summary attention, pending detail and settled landing. */
export function isPendingRequestAnswerableV1(
  request: Readonly<{ kind: 'permission' | 'user_action'; source?: string }>,
  capabilities: Readonly<{ canSubmitAgentInput: boolean; canApprovePermissions: boolean }>,
): boolean {
  return resolvePendingRequestAttentionReasonV1(request) === 'user_action_required'
    ? capabilities.canSubmitAgentInput : capabilities.canApprovePermissions;
}

/**
 * The closed set of personal attention facts (Lane 09B §4.4). Declaration order
 * is the canonical priority ladder: `reasons` keeps every concurrent fact and
 * `primary` only says which one wins one row of compact space.
 */
export const SessionPersonalAttentionReasonV1Schema = lazyZodSchema(() => z.enum([
  'failed',
  'permission_required',
  'user_action_required',
  'pending_blocked',
  'mentioned',
  'unread',
  'unread_discussion',
  'ready_after_read',
  'reminder_due',
  'manual',
]));
export type SessionPersonalAttentionReasonV1 = z.infer<
  typeof SessionPersonalAttentionReasonV1Schema
>;

export const SessionPersonalAttentionProjectionV1Schema = lazyZodSchema(() => z
  .object({
    needsAttention: z.boolean(),
    reasons: z.array(SessionPersonalAttentionReasonV1Schema).readonly(),
    primary: SessionPersonalAttentionReasonV1Schema.nullable(),
    /** `status_only` when the viewer cannot open the content (locked E2EE). */
    presentation: z.enum(['full', 'status_only']),
  })
  .strict());
export type SessionPersonalAttentionProjectionV1 = Readonly<{
  needsAttention: boolean;
  reasons: readonly SessionPersonalAttentionReasonV1[];
  primary: SessionPersonalAttentionReasonV1 | null;
  presentation: 'full' | 'status_only';
}>;

export const QUIET_SESSION_PERSONAL_ATTENTION_V1: SessionPersonalAttentionProjectionV1 =
  Object.freeze({
    needsAttention: false,
    reasons: Object.freeze([]) as readonly SessionPersonalAttentionReasonV1[],
    primary: null,
    presentation: 'full',
  });

/**
 * Content-free attention inputs.
 *
 * `hasPrimarySessionFailure` is the canonical parsed primary runtime issue, not
 * "any non-empty issue string" — the badge derivation used the looser rule and
 * disagreed with the list. `visibleSessionSeq` and `latestReadyEventSeq` are
 * already clamped to the viewer-visible publication ceiling by the caller.
 */
export type SessionPersonalAttentionInputV1 = Readonly<{
  /** Owner-or-active-Follow. Without it there is no ongoing personal attention. */
  tracked: boolean;
  accessible: boolean;
  accountSuspended: boolean;
  contentAvailable: boolean;
  visibleSessionSeq: number;
  /** Authorized linked external-session owner snapshot; absent for Home fact loaders. */
  externalSessionHasUnread?: boolean;
  readState: ViewerReadStateV1;
  latestReadyEventSeq: number | null;
  hasPrimarySessionFailure: boolean;
  pendingBlockedCount: number;
  pendingPermissionRequestCount: number;
  pendingUserActionRequestCount: number;
  capabilities: Readonly<{ canSubmitAgentInput: boolean; canApprovePermissions: boolean }>;
  responsible: boolean;
  discussion: Readonly<{ hasUnread: boolean; hasMention: boolean }>;
  attentionStanding: 'none' | 'positive' | 'negative';
  reminderDue: boolean;
}>;

function count(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * The one viewer-aware attention derivation shared by list confirmation,
 * awareness composition, badge counting, Activity, Inbox and event admission
 * (L09B-R5). Operational Session state stays visible through the 09A projection
 * even when this resolver is quiet; the two are composed beside each other.
 */
export function resolveSessionPersonalAttentionV1(
  input: SessionPersonalAttentionInputV1,
): SessionPersonalAttentionProjectionV1 {
  // Storage selection is caller-owned. An explicitly archived list composes
  // this decision beneath its archived base; active-only surfaces exclude
  // archived rows before calling this resolver.
  if (!input.accessible || input.accountSuspended) {
    return QUIET_SESSION_PERSONAL_ATTENTION_V1;
  }
  // A due reminder is the sole exception to owner-or-Follow tracking. It may
  // return an unfollowed Session to personal attention, but it must not make
  // unrelated operational, discussion, unread, or manual facts actionable.
  if (!input.tracked) {
    return input.reminderDue
      ? {
          needsAttention: true,
          reasons: ['reminder_due'],
          primary: 'reminder_due',
          presentation: input.contentAvailable ? 'full' : 'status_only',
        }
      : QUIET_SESSION_PERSONAL_ATTENTION_V1;
  }

  const canAct = input.capabilities.canSubmitAgentInput || input.responsible;
  const canApprove = input.capabilities.canApprovePermissions || input.responsible;
  const cursor = input.readState.state === 'tracking' ? input.readState.lastViewedSessionSeq : null;

  const reasons: SessionPersonalAttentionReasonV1[] = [];
  if (input.hasPrimarySessionFailure) reasons.push('failed');
  const pendingCapabilities = { canSubmitAgentInput: canAct, canApprovePermissions: canApprove };
  if (count(input.pendingPermissionRequestCount) > 0 && isPendingRequestAnswerableV1({ kind: 'permission' }, pendingCapabilities)) reasons.push('permission_required');
  if (count(input.pendingUserActionRequestCount) > 0 && isPendingRequestAnswerableV1({ kind: 'user_action' }, pendingCapabilities)) reasons.push('user_action_required');
  if (count(input.pendingBlockedCount) > 0 && canAct) reasons.push('pending_blocked');
  if (input.discussion.hasMention) reasons.push('mentioned');
  if (input.externalSessionHasUnread ?? (cursor !== null && count(input.visibleSessionSeq) > cursor)) {
    reasons.push('unread');
  }
  if (input.discussion.hasUnread) reasons.push('unread_discussion');
  if (
    cursor !== null
    && typeof input.latestReadyEventSeq === 'number'
    && input.latestReadyEventSeq > cursor
    && !reasons.includes('unread')
  ) {
    reasons.push('ready_after_read');
  }
  if (input.reminderDue) reasons.push('reminder_due');
  if (input.attentionStanding === 'positive') reasons.push('manual');

  if (reasons.length === 0) return QUIET_SESSION_PERSONAL_ATTENTION_V1;
  return {
    needsAttention: true,
    reasons,
    primary: reasons[0] ?? null,
    presentation: input.contentAvailable ? 'full' : 'status_only',
  };
}
