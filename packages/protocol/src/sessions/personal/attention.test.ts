import { describe, expect, it } from 'vitest';

import {
  QUIET_SESSION_PERSONAL_ATTENTION_V1,
  type SessionPersonalAttentionInputV1,
  resolveSessionPersonalAttentionV1,
} from './attention.js';

const TRACKED_CAUGHT_UP: SessionPersonalAttentionInputV1 = {
  tracked: true,
  accessible: true,
  accountSuspended: false,
  contentAvailable: true,
  visibleSessionSeq: 5,
  readState: { state: 'tracking', lastViewedSessionSeq: 5, unreadSince: null },
  latestReadyEventSeq: null,
  latestFailureSeq: null,
  hasPrimarySessionFailure: false,
  pendingBlockedCount: 0,
  pendingPermissionRequestCount: 0,
  pendingUserActionRequestCount: 0,
  capabilities: { canSubmitAgentInput: true, canApprovePermissions: true },
  responsible: false,
  discussion: { hasUnread: false, hasMention: false },
  attentionStanding: 'none',
  reminderDue: false,
};

describe('resolveSessionPersonalAttentionV1', () => {
  it('keeps only the accepted one-shot source in attention without ongoing tracking', () => {
    expect(resolveSessionPersonalAttentionV1({ ...TRACKED_CAUGHT_UP, tracked: false,
      pendingPermissionRequestCount: 5, hasPrimarySessionFailure: true,
      onceDelivery: { event: 'ready', turnId: 'turn-a', agentStateVersion: 3 },
    })).toMatchObject({ needsAttention: true, reasons: ['ready_after_read'] });
    expect(resolveSessionPersonalAttentionV1({ ...TRACKED_CAUGHT_UP, tracked: false,
      onceDelivery: { event: 'user_action_required', requestId: 'request-a', agentStateVersion: 3 },
    }).needsAttention).toBe(false);
    expect(resolveSessionPersonalAttentionV1({ ...TRACKED_CAUGHT_UP, tracked: false,
      onceDelivery: { event: 'user_action_required', requestId: 'request-a', agentStateVersion: 3 },
      currentRequestIds: ['request-a'],
    }).primary).toBe('user_action_required');
  });
  it('uses authorized external-session unread facts without bypassing personal tracking', () => {
    const external = { ...TRACKED_CAUGHT_UP, externalSessionHasUnread: true };
    expect(resolveSessionPersonalAttentionV1(external).reasons).toEqual(['unread']);
    expect(resolveSessionPersonalAttentionV1({ ...external, tracked: false }).needsAttention).toBe(false);
    expect(resolveSessionPersonalAttentionV1({
      ...TRACKED_CAUGHT_UP, visibleSessionSeq: 20, externalSessionHasUnread: false,
    }).needsAttention).toBe(false);
  });

  it('is quiet for a caught-up tracked viewer', () => {
    expect(resolveSessionPersonalAttentionV1(TRACKED_CAUGHT_UP))
      .toEqual(QUIET_SESSION_PERSONAL_ATTENTION_V1);
  });

  it('acknowledges only the fixed committed primary failure sequence through the viewer cursor', () => {
    const failure = { ...TRACKED_CAUGHT_UP, hasPrimarySessionFailure: true, latestFailureSeq: 6, visibleSessionSeq: 6 };
    expect(resolveSessionPersonalAttentionV1(failure).reasons).toContain('failed');
    const read = { ...failure, readState: { state: 'tracking' as const, lastViewedSessionSeq: 6, unreadSince: null } };
    expect(resolveSessionPersonalAttentionV1(read).reasons).not.toContain('failed');
    expect(resolveSessionPersonalAttentionV1({ ...read, visibleSessionSeq: 9 }).reasons).toEqual(['unread']);
    expect(resolveSessionPersonalAttentionV1({ ...read, latestFailureSeq: 10, visibleSessionSeq: 10 }).reasons).toContain('failed');
    expect(resolveSessionPersonalAttentionV1(failure).reasons).toContain('failed');
    expect(resolveSessionPersonalAttentionV1({ ...failure, latestFailureSeq: null }).reasons).not.toContain('failed');
    expect(resolveSessionPersonalAttentionV1({ ...failure, readState: { state: 'not_started' } }).reasons).not.toContain('failed');
  });

  it('never reports ongoing attention for an untracked viewer with raw unread facts', () => {
    expect(resolveSessionPersonalAttentionV1({
      ...TRACKED_CAUGHT_UP,
      tracked: false,
      readState: { state: 'not_started' },
      visibleSessionSeq: 42,
      pendingPermissionRequestCount: 3,
      hasPrimarySessionFailure: true,
    })).toEqual(QUIET_SESSION_PERSONAL_ATTENTION_V1);
  });

  it('does not turn an absent read row into historical unread', () => {
    expect(resolveSessionPersonalAttentionV1({
      ...TRACKED_CAUGHT_UP,
      readState: { state: 'not_started' },
      visibleSessionSeq: 42,
    })).toEqual(QUIET_SESSION_PERSONAL_ATTENTION_V1);
  });

  it('reports unread behind the visible ceiling', () => {
    expect(resolveSessionPersonalAttentionV1({
      ...TRACKED_CAUGHT_UP,
      visibleSessionSeq: 9,
      readState: { state: 'tracking', lastViewedSessionSeq: 4, unreadSince: 1_700 },
    })).toEqual({
      needsAttention: true,
      reasons: ['unread'],
      primary: 'unread',
      presentation: 'full',
    });
  });

  it('reports ready-after-read, which the badge derivation currently drops', () => {
    expect(resolveSessionPersonalAttentionV1({
      ...TRACKED_CAUGHT_UP,
      latestReadyEventSeq: 5,
      readState: { state: 'tracking', lastViewedSessionSeq: 4, unreadSince: null },
      visibleSessionSeq: 4,
    })).toEqual({
      needsAttention: true,
      reasons: ['ready_after_read'],
      primary: 'ready_after_read',
      presentation: 'full',
    });
  });

  it('reports blocked pending delivery, which the list derivation currently drops', () => {
    expect(resolveSessionPersonalAttentionV1({
      ...TRACKED_CAUGHT_UP,
      pendingBlockedCount: 1,
    })).toEqual({
      needsAttention: true,
      reasons: ['pending_blocked'],
      primary: 'pending_blocked',
      presentation: 'full',
    });
  });

  it('orders concurrent reasons with failure first', () => {
    expect(resolveSessionPersonalAttentionV1({
      ...TRACKED_CAUGHT_UP,
      hasPrimarySessionFailure: true,
      latestFailureSeq: 8,
      pendingPermissionRequestCount: 1,
      visibleSessionSeq: 9,
      readState: { state: 'tracking', lastViewedSessionSeq: 4, unreadSince: 1_700 },
    })).toEqual({
      needsAttention: true,
      reasons: ['failed', 'permission_required', 'unread'],
      primary: 'failed',
      presentation: 'full',
    });
  });

  it('offers action-required only to an Account that can act or is responsible', () => {
    const incapable: SessionPersonalAttentionInputV1 = {
      ...TRACKED_CAUGHT_UP,
      pendingUserActionRequestCount: 1,
      pendingPermissionRequestCount: 1,
      pendingBlockedCount: 1,
      capabilities: { canSubmitAgentInput: false, canApprovePermissions: false },
    };
    expect(resolveSessionPersonalAttentionV1(incapable)).toEqual(QUIET_SESSION_PERSONAL_ATTENTION_V1);
    expect(resolveSessionPersonalAttentionV1({ ...incapable, responsible: true }).reasons)
      .toEqual(['permission_required', 'user_action_required', 'pending_blocked']);
  });

  it('coalesces transcript and discussion reasons onto one Session decision', () => {
    expect(resolveSessionPersonalAttentionV1({
      ...TRACKED_CAUGHT_UP,
      discussion: { hasUnread: true, hasMention: true },
    })).toEqual({
      needsAttention: true,
      reasons: ['mentioned', 'unread_discussion'],
      primary: 'mentioned',
      presentation: 'full',
    });
  });

  it('adds manual only for an explicit positive standing on an already tracked Session', () => {
    expect(resolveSessionPersonalAttentionV1({ ...TRACKED_CAUGHT_UP, attentionStanding: 'positive' }))
      .toEqual({
        needsAttention: true,
        reasons: ['manual'],
        primary: 'manual',
        presentation: 'full',
      });
    expect(resolveSessionPersonalAttentionV1({
      ...TRACKED_CAUGHT_UP,
      tracked: false,
      attentionStanding: 'positive',
    })).toEqual(QUIET_SESSION_PERSONAL_ATTENTION_V1);
  });

  it('lets a due explicit reminder return an unfollowed session without creating unread', () => {
    expect(resolveSessionPersonalAttentionV1({
      ...TRACKED_CAUGHT_UP,
      tracked: false,
      readState: { state: 'not_started' },
      reminderDue: true,
    })).toEqual({
      needsAttention: true,
      reasons: ['reminder_due'],
      primary: 'reminder_due',
      presentation: 'full',
    });
  });

  it('keeps a due reminder as the only reason when the viewer is not tracked', () => {
    expect(resolveSessionPersonalAttentionV1({
      ...TRACKED_CAUGHT_UP,
      tracked: false,
      readState: { state: 'not_started' },
      reminderDue: true,
      hasPrimarySessionFailure: true,
      pendingBlockedCount: 1,
      pendingPermissionRequestCount: 1,
      pendingUserActionRequestCount: 1,
      discussion: { hasUnread: true, hasMention: true },
      attentionStanding: 'positive',
    })).toMatchObject({
      needsAttention: true,
      reasons: ['reminder_due'],
      primary: 'reminder_due',
    });
  });

  it('removes the manual contribution for an explicit negative standing', () => {
    expect(resolveSessionPersonalAttentionV1({
      ...TRACKED_CAUGHT_UP,
      attentionStanding: 'negative',
      visibleSessionSeq: 9,
      readState: { state: 'tracking', lastViewedSessionSeq: 4, unreadSince: 1_700 },
    }).reasons).toEqual(['unread']);
  });

  it('keeps a locked E2EE Session attention-eligible but status-only', () => {
    expect(resolveSessionPersonalAttentionV1({
      ...TRACKED_CAUGHT_UP,
      contentAvailable: false,
      visibleSessionSeq: 9,
      readState: { state: 'tracking', lastViewedSessionSeq: 4, unreadSince: 1_700 },
    })).toEqual({
      needsAttention: true,
      reasons: ['unread'],
      primary: 'unread',
      presentation: 'status_only',
    });
  });

  it('stops attention on lost access and suspension', () => {
    const unread: SessionPersonalAttentionInputV1 = {
      ...TRACKED_CAUGHT_UP,
      visibleSessionSeq: 9,
      readState: { state: 'tracking', lastViewedSessionSeq: 4, unreadSince: 1_700 },
    };
    expect(resolveSessionPersonalAttentionV1({ ...unread, accessible: false }))
      .toEqual(QUIET_SESSION_PERSONAL_ATTENTION_V1);
    expect(resolveSessionPersonalAttentionV1({ ...unread, accountSuspended: true }))
      .toEqual(QUIET_SESSION_PERSONAL_ATTENTION_V1);
  });

});
