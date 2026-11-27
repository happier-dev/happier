import * as z from 'zod/mini';
import { describe, expect, it } from 'vitest';

import { AttentionDeliveryEventIdSchema } from '../account/settings/attentionDeliveryPolicy.js';
import { resolveActivityRequestEventIdentityV1 } from '../activity/eventIdentity.js';
import { SessionPersonalEventEphemeralV1Schema } from '../updates/index.js';
import { isSessionFollowStalledOccurrenceCurrentV1 } from '../sessions/follow/sessionFollowSourceOccurrenceV1.js';

import {
  ACTIVITY_REMOTE_ALERT_EVENT_TYPES_V1,
  ACTIVITY_REMOTE_ALERT_POLICY_EVENT_V1,
  ActivityRemoteAlertEventV1Schema,
  ActivityRemoteAlertV1Schema,
  ActivityRemoteAlertEventV2Schema,
  ActivityRemoteAlertSchema,
  ActivityRemoteAlertV2Schema,
  resolveActivityRemoteAlertEventIdentity,
  resolveActivityRemoteAlertEventForPersonalEventV2,
} from './activityRemoteAlert.js';

describe('ActivityRemoteAlertV1', () => {
  it('preserves the exact committed stalled witness on existing personal and remote source-state carriers', () => {
    const stalledOccurrence = { turnId: 'in-flight-turn', publisherFence: 123 };
    const source = { active: false, latestTurnId: 'in-flight-turn', latestTurnStatus: 'in_progress', activeAt: 123 };
    expect(isSessionFollowStalledOccurrenceCurrentV1(stalledOccurrence, source)).toBe(true);
    for (const change of [{ active: true }, { activeAt: 124 }, { latestTurnId: 'replacement' },
      { latestTurnStatus: 'completed' }, { archivedAt: 124 }]) {
      expect(isSessionFollowStalledOccurrenceCurrentV1(stalledOccurrence, { ...source, ...change })).toBe(false);
    }
    const event = { type: 'source_unavailable', stalledOccurrence };
    expect(ActivityRemoteAlertEventV2Schema.safeParse(event).success).toBe(true);
    expect(SessionPersonalEventEphemeralV1Schema.safeParse({ type: 'session-personal-event',
      sessionId: 'source', eventId: 'committed-stall', event: 'source_unavailable', stalledOccurrence }).success).toBe(true);
    expect(ActivityRemoteAlertEventV2Schema.safeParse({ ...event,
      stalledOccurrence: { ...stalledOccurrence, publisherFence: -1 } }).success).toBe(false);
    expect(ActivityRemoteAlertEventV2Schema.safeParse({ ...event,
      stalledOccurrence: { ...stalledOccurrence, text: 'private' } }).success).toBe(false);
    expect(resolveActivityRemoteAlertEventIdentity({ type: 'activity_alert', v: 2, serverId: 'home',
      sessionId: 'source', accountId: 'viewer', previewBehavior: 'status_only',
      event: ActivityRemoteAlertEventV2Schema.parse(event) })).toBe('stalled:in-flight-turn:123');
  });

  const alert = {
    type: 'activity_alert', v: 1,
    serverId: 'home-a', sessionId: 'session-a', accountId: 'account-b',
    event: { type: 'ready', messageSeq: 17 },
    previewBehavior: 'title_only',
  };

  it('publishes the complete strict event vocabulary for native capability consumers', () => {
    const schemaEventTypes = ActivityRemoteAlertEventV1Schema._zod.def.options.map(
      (option) => option.shape.type._zod.def.values[0],
    );
    expect([...ACTIVITY_REMOTE_ALERT_EVENT_TYPES_V1].sort()).toEqual(schemaEventTypes.sort());
  });

  it('accepts a content-free committed reference and rejects injected content, credential destinations and unknown event claims', () => {
    expect(ActivityRemoteAlertV1Schema.parse(alert)).toEqual(alert);
    for (const extra of [
      { serverUrl: 'https://other.invalid' },
      { token: 'a-bearer' },
      { title: 'Private title' },
      { event: { ...alert.event, content: 'Private content' } },
      { event: { type: 'human_message' } },
      { event: { type: 'ready', messageSeq: 17.5 } },
    ]) {
      expect(ActivityRemoteAlertV1Schema.safeParse({ ...alert, ...extra }).success).toBe(false);
    }
  });

  it('carries the remaining C5b-supported categories without a sequence claim they do not own', () => {
    for (const event of [
      { type: 'permission_request' },
      { type: 'user_action_request' },
      { type: 'assigned' },
      { type: 'source_unavailable' },
    ]) {
      expect(ActivityRemoteAlertV1Schema.parse({ ...alert, event })).toEqual({ ...alert, event });
      expect(ActivityRemoteAlertV1Schema.safeParse({ ...alert, event: { ...event, messageSeq: 3 } }).success).toBe(false);
    }
  });

  it('maps every supported alert category onto exactly one existing policy event family', () => {
    expect(ACTIVITY_REMOTE_ALERT_POLICY_EVENT_V1).toEqual({
      ready: 'ready',
      permission_request: 'permission_request',
      user_action_request: 'user_action_request',
      // The reconciled assignment reason is metadata; it does not add a global setting.
      assigned: 'follow_update',
      failed: 'task_failed',
      cancelled: 'follow_update',
      human_message: 'follow_update',
      message: 'follow_update',
      discussion_mention: 'follow_update',
      source_unavailable: 'follow_update',
    });
    for (const policyEvent of Object.values(ACTIVITY_REMOTE_ALERT_POLICY_EVENT_V1)) {
      expect(AttentionDeliveryEventIdSchema.safeParse(policyEvent).success).toBe(true);
    }
  });

  it('uses a new closed wire epoch to distinguish transcript and Discussion sequences', () => {
    const mainHuman = resolveActivityRemoteAlertEventForPersonalEventV2(
      'human_message',
      { domain: 'session_transcript', seq: 21 },
    );
    const discussionHuman = resolveActivityRemoteAlertEventForPersonalEventV2(
      'human_message',
      { domain: 'discussion', discussionId: 'discussion-a', seq: 21 },
    );
    const mention = resolveActivityRemoteAlertEventForPersonalEventV2(
      'discussion_mention',
      { domain: 'discussion', discussionId: 'discussion-b', seq: 22 },
    );

    expect(mainHuman).toEqual({
      type: 'human_message', sequenceDomain: 'session_transcript', messageSeq: 21,
    });
    expect(discussionHuman).toEqual({
      type: 'human_message', sequenceDomain: 'discussion', discussionId: 'discussion-a', messageSeq: 21,
    });
    expect(mention).toEqual({
      type: 'discussion_mention', sequenceDomain: 'discussion', discussionId: 'discussion-b', messageSeq: 22,
    });
    expect(resolveActivityRemoteAlertEventForPersonalEventV2(
      'discussion_mention',
      { domain: 'session_transcript', seq: 22 },
    )).toBeNull();
    expect(resolveActivityRemoteAlertEventForPersonalEventV2(
      'ready',
      { domain: 'discussion', discussionId: 'discussion-c', seq: 23 },
    )).toBeNull();
    expect(resolveActivityRemoteAlertEventForPersonalEventV2('ready')).toBeNull();
    expect(resolveActivityRemoteAlertEventForPersonalEventV2('permission_required'))
      .toEqual({ type: 'permission_request' });
    // The committed request id is the cross-leg identity a device uses to show
    // one alert per request, so the writer carries it and the reader names it
    // exactly as the device-local notification leg does.
    expect(resolveActivityRemoteAlertEventForPersonalEventV2(
      'permission_required', undefined, undefined, 'req-9',
    )).toEqual({ type: 'permission_request', requestId: 'req-9' });
    expect(resolveActivityRemoteAlertEventForPersonalEventV2(
      'user_action_required', undefined, undefined, 'req-10',
    )).toEqual({ type: 'user_action_request', requestId: 'req-10' });
    expect(resolveActivityRemoteAlertEventForPersonalEventV2(
      'permission_required', undefined, undefined, '  ',
    )).toBeNull();
    expect(resolveActivityRemoteAlertEventIdentity({
      type: 'activity_alert', v: 2,
      serverId: 'home-a', sessionId: 'session-a', accountId: 'account-b',
      event: { type: 'permission_request', requestId: 'req-9' },
      previewBehavior: 'title_only',
    })).toBe(resolveActivityRequestEventIdentityV1('req-9'));
    // A category without a committed request stays grouped, never collapsed
    // onto an invented identity.
    expect(resolveActivityRemoteAlertEventIdentity({
      type: 'activity_alert', v: 2,
      serverId: 'home-a', sessionId: 'session-a', accountId: 'account-b',
      event: { type: 'permission_request' },
      previewBehavior: 'title_only',
    })).toBeUndefined();
    expect(resolveActivityRemoteAlertEventForPersonalEventV2('user_action_required'))
      .toEqual({ type: 'user_action_request' });
    expect(resolveActivityRemoteAlertEventForPersonalEventV2('assigned'))
      .toEqual({ type: 'assigned' });
    for (const kind of ['failed', 'cancelled'] as const) {
      expect(resolveActivityRemoteAlertEventForPersonalEventV2(kind, undefined, 'turn-21'))
        .toEqual({ type: kind, turnId: 'turn-21' });
      expect(resolveActivityRemoteAlertEventForPersonalEventV2(kind)).toBeNull();
    }
    expect(resolveActivityRemoteAlertEventForPersonalEventV2('directly_shared')).toBeNull();
    expect(resolveActivityRemoteAlertEventForPersonalEventV2('source_unavailable'))
      .toEqual({ type: 'source_unavailable' });

    const base = {
      type: 'activity_alert', serverId: 'home-a', sessionId: 'session-a',
      accountId: 'account-b', previewBehavior: 'include_preview',
    } as const;
    expect(ActivityRemoteAlertV2Schema.parse({ ...base, v: 2, event: mainHuman })).toMatchObject({ v: 2 });
    expect(ActivityRemoteAlertEventV2Schema.safeParse({
      type: 'human_message', messageSeq: 21,
    }).success).toBe(false);
    expect(ActivityRemoteAlertEventV2Schema.safeParse({
      type: 'discussion_mention', sequenceDomain: 'session_transcript', messageSeq: 22,
    }).success).toBe(false);
    expect(ActivityRemoteAlertEventV2Schema.safeParse({
      type: 'discussion_mention', sequenceDomain: 'discussion', messageSeq: 22,
    }).success).toBe(false);
    expect(ActivityRemoteAlertEventV2Schema.safeParse({
      type: 'discussion_mention', sequenceDomain: 'discussion', discussionId: ' ', messageSeq: 22,
    }).success).toBe(false);
    expect(ActivityRemoteAlertEventV2Schema.safeParse({
      type: 'human_message', sequenceDomain: 'session_transcript', discussionId: 'discussion-a', messageSeq: 21,
    }).success).toBe(false);
    expect(ActivityRemoteAlertV2Schema.safeParse({
      ...base, v: 2, event: { ...mainHuman, unexpected: true },
    }).success).toBe(false);
  });

  it('derives one canonical presentation identity for current committed event references', () => {
    const base = {
      type: 'activity_alert', v: 2, serverId: 'home-a', sessionId: 'session-a',
      accountId: 'account-b', previewBehavior: 'title_only',
    } as const;
    expect(resolveActivityRemoteAlertEventIdentity({ ...base, event: {
      type: 'ready', sequenceDomain: 'session_transcript', messageSeq: 21,
    } })).toBe('message-seq:session_transcript:21');
    expect(resolveActivityRemoteAlertEventIdentity({ ...base, event: {
      type: 'discussion_mention', sequenceDomain: 'discussion', discussionId: 'discussion-a', messageSeq: 21,
    } })).toBe('message-seq:discussion:discussion-a:21');
    expect(resolveActivityRemoteAlertEventIdentity({ ...base, event: {
      type: 'discussion_mention', sequenceDomain: 'discussion', discussionId: 'discussion-b', messageSeq: 21,
    } })).toBe('message-seq:discussion:discussion-b:21');
    expect(resolveActivityRemoteAlertEventIdentity({ ...base, event: { type: 'failed', turnId: 'turn-21' } }))
      .toBe('turn:turn-21');
    expect(resolveActivityRemoteAlertEventIdentity({ ...base, event: { type: 'permission_request' } }))
      .toBeUndefined();
  });

  it('retains captured request turns in the current Home wire reference and presentation identity', () => {
    for (const [kind, type] of [['permission_required', 'permission_request'], ['user_action_required', 'user_action_request']] as const) {
      const event = resolveActivityRemoteAlertEventForPersonalEventV2(kind, undefined, 'turn-a', 'req:😀');
      expect(event).toEqual({ type, requestId: 'req:😀', turnId: 'turn-a' });
      const alert = ActivityRemoteAlertV2Schema.parse({ type: 'activity_alert', v: 2, serverId: 'home-a',
        sessionId: 'session-a', accountId: 'account-a', previewBehavior: 'title_only', event });
      expect(resolveActivityRemoteAlertEventIdentity(alert)).toBe('request-turn:6:req:😀:6:turn-a');
      expect(resolveActivityRemoteAlertEventIdentity({ ...alert,
        event: ActivityRemoteAlertEventV2Schema.parse({ type, requestId: 'req:😀', turnId: 'turn-b' }),
      })).not.toBe(resolveActivityRemoteAlertEventIdentity(alert));
      expect(resolveActivityRemoteAlertEventIdentity({ ...alert, event: { type, requestId: 'req:😀' } }))
        .toBe('request:req:😀');
      expect(ActivityRemoteAlertEventV2Schema.safeParse({ type, requestId: 'req:😀', turnId: ' ' }).success).toBe(false);
    }
  });

  it('retains the released v1 reader shape as an explicitly ambiguous compatibility input', () => {
    const legacy = {
      type: 'activity_alert', v: 1,
      serverId: 'home-a', sessionId: 'session-a', accountId: 'account-b',
      event: { type: 'human_message', messageSeq: 21 },
      previewBehavior: 'include_preview',
    };
    expect(ActivityRemoteAlertSchema.parse(legacy)).toEqual(legacy);
    expect(ActivityRemoteAlertV1Schema.parse(legacy)).toEqual(legacy);
    expect(ActivityRemoteAlertV2Schema.safeParse(legacy).success).toBe(false);
    expect(resolveActivityRemoteAlertEventIdentity(legacy))
      .toBe('legacy-message-seq:21');
  });
});
