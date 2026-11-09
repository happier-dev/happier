import { describe, expect, it } from 'vitest';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { SessionViewerProjectionV1Schema } from '../personal/viewer.js';
import { DEFAULT_SESSION_FOLLOW_CREATION_POLICIES_V1, PersonalFollowOnceV1Schema, matchesPersonalFollowOnceOccurrenceV1, projectPersonalFollowCustodyV1 } from './accountFollow.js';
import { resolveSessionFollowActionRequest } from './actionTransport.js';
import { SetSessionAutoFollowPreferencesRequestSchema } from './api.js';
import type { FollowPolicyV1 } from './sessionFollowPolicyV1.js';

describe('personal Follow one-shot occurrence', () => {
  it('keeps stored delivery and policy authority closed while dropping unrelated retired viewer presentation', () => {
    const viewer = {
      latestFailureSeq: null,
      readState: { state: 'not_started' }, relevance: { relevant: false, reasons: [] },
      attention: { needsAttention: false, primary: null, reasons: [], presentation: 'full' },
      follow: { follows: false, notificationLevel: 'none' }, notification: { level: 'none', source: 'none' },
    };
    const read = createStoredReadSchema(SessionViewerProjectionV1Schema);
    expect(read.safeParse({ ...viewer, retiredPresentation: true }).success).toBe(true);
    for (const authority of [
      { policy: { preset: 'important', receiverAccountId: 'other' } },
      { policy: { preset: 'custom', events: { finished: { delivery: 'quiet', targetSessionId: 'other' } } } },
      { once: { kind: 'first_needs_you', requestId: 'unproven' } },
      { onceDelivery: { event: 'ready', turnId: 'turn', agentStateVersion: 1, sourceAccountId: 'other' } },
    ]) expect(read.safeParse({ ...viewer, follow: { ...viewer.follow, ...authority } }).success).toBe(false);
  });
  it('carries a one-shot-only Action to HTTP and rejects an empty Action mutation', () => {
    const pair = { receiver: { kind: 'account' }, source: { kind: 'session', sessionId: 'session-1' } };
    expect(resolveSessionFollowActionRequest('follow.set', { ...pair, once: null }))
      .toEqual({ path: '/v2/sessions/session-1/follow', method: 'PUT', body: { once: null } });
    expect(() => resolveSessionFollowActionRequest('follow.set', pair)).toThrow();
    expect(() => resolveSessionFollowActionRequest('follow.set', { ...pair, includeInVoice: true })).toThrow();
  });
  it('fails a malformed stored explicit policy closed rather than falling back to Important', () => {
    for (const followPolicy of ['{broken', '']) {
      expect(projectPersonalFollowCustodyV1({ followPolicy })).toEqual({ policy: { preset: 'custom', events: {} } });
    }
  });
  const baseline = { transcriptSeq: 10, readyEventSeq: 2, agentStateVersion: 4, turn: null };
  it('selects only the captured turn terminal outcome, including failure and stop', () => {
    const once = { kind: 'turn_finished', sourceTurnId: 'turn-a' } as const;
    expect(PersonalFollowOnceV1Schema.parse(once)).toEqual(once);
    for (const status of ['completed', 'failed', 'cancelled'] as const) {
      expect(matchesPersonalFollowOnceOccurrenceV1({ once, baseline, occurrence: {
        event: status === 'completed' ? 'ready' : status, turnId: 'turn-a', agentStateVersion: 5,
      } })).toBe(true);
      expect(matchesPersonalFollowOnceOccurrenceV1({ once, baseline, occurrence: {
        event: status === 'completed' ? 'ready' : status, turnId: 'turn-b', agentStateVersion: 5,
      } })).toBe(false);
    }
    expect(matchesPersonalFollowOnceOccurrenceV1({ once, baseline, occurrence: {
      event: 'message', turnId: 'turn-a', agentStateVersion: 5,
    } })).toBe(false);
  });
  it('requires a real needs-you request after the intent frontier', () => {
    const once = { kind: 'first_needs_you' } as const;
    expect(matchesPersonalFollowOnceOccurrenceV1({ once, baseline, occurrence: {
      event: 'user_action_required', requestId: 'request-a', agentStateVersion: 4,
    } })).toBe(false);
    expect(matchesPersonalFollowOnceOccurrenceV1({ once, baseline, occurrence: {
      event: 'user_action_required', requestId: 'request-b', agentStateVersion: 5,
    } })).toBe(true);
    expect(matchesPersonalFollowOnceOccurrenceV1({ once, baseline, occurrence: {
      event: 'permission_required', agentStateVersion: 5,
    } })).toBe(false);
  });
});

import { FEATURE_CATALOG, isFeatureId } from '../../features/catalog.js';
import { FeaturesResponseSchema } from '../../features/payload/featuresResponseSchema.js';
import { readServerEnabledBit } from '../../features/serverEnabledBit.js';
import {
  ACCOUNT_SESSION_FOLLOW_CHANGE_ENTITY_ID,
  AccountSessionFollowCapabilitiesV1Schema,
  AccountSessionFollowV1Schema,
  GetSessionFollowResponseSchema,
  RemoveSessionFollowResponseSchema,
  ReplaceSessionVoiceInclusionsRequestSchema,
  SESSION_FOLLOW_ERROR_CODES_V1,
  SessionAutoFollowPreferencesV1Schema,
  SessionFollowChangeHintV1Schema,
  SessionFollowNotificationLevelSchema,
  SetSessionFollowRequestSchema,
  SetSessionFollowResponseSchema,
  VoiceTrackedTargetsActionResultV1Schema,
  buildSessionFollowChangeHintV1,
  projectAccountSessionFollowEditorStateV1,
  readSessionFollowChangeHintV1,
  resolveEffectiveSessionFollowNotificationLevelV1,
  projectSessionFollowFactsV1,
} from './index.js';

describe('Account Follow protocol contract', () => {
  it('normalizes canonical defaultRules and legacy preferences to the same persisted operational choices', () => {
    const defaults = { assigned: true, direct: false, team: true, group: false };
    const canonical = { defaultRules: defaults, managerPolicy: { preset: 'quiet' } };
    const legacy = { ...defaults, managerPolicy: { preset: 'quiet' } };
    expect(SetSessionAutoFollowPreferencesRequestSchema.safeParse(canonical)).toMatchObject({ success: true, data: legacy });
    expect(SetSessionAutoFollowPreferencesRequestSchema.parse(legacy)).toEqual(legacy);
    expect(resolveSessionFollowActionRequest('follow.preferences.set', legacy)).toEqual({
      method: 'PUT', path: '/v2/account/session-follow-preferences', body: canonical,
    });
    expect(SetSessionAutoFollowPreferencesRequestSchema.safeParse({ ...canonical, assigned: false }).success).toBe(false);
    expect(SetSessionAutoFollowPreferencesRequestSchema.safeParse({ defaultRules: { ...defaults, accountId: 'other' } }).success).toBe(false);
  });

  it('defaults new Discussion participants to Quiet while manager and Run reports stay Important', () => {
    expect(DEFAULT_SESSION_FOLLOW_CREATION_POLICIES_V1).toEqual({
      managerPolicy: { preset: 'important' },
      runReportPolicy: { preset: 'important' },
      discussionReceivePolicy: { preset: 'quiet' },
    });
  });

  it('projects Voice from the explicit event policy while preserving legacy inclusion ingress', () => {
    const project = (policy?: FollowPolicyV1, includeInVoice = false) =>
      projectAccountSessionFollowEditorStateV1({ isSessionOwner: false, follow: {
        sessionId: 'source', following: true, notificationLevel: 'none', includeInVoice,
        ...(policy ? { policy } : {}),
      } }).includeInVoice;
    expect(project({ preset: 'important', voice: true })).toBe(true);
    expect(project({ preset: 'important' }, true)).toBe(false);
    expect(project({ preset: 'custom', events: { finished: { delivery: 'quiet', voice: true } } })).toBe(true);
    expect(project({ preset: 'custom', events: { finished: { delivery: 'off', voice: true } } })).toBe(true);
    expect(project(undefined, true)).toBe(true);
    for (const policy of [
      { preset: 'important', voice: true },
      { preset: 'custom', events: { finished: { delivery: 'off' } } },
    ] satisfies FollowPolicyV1[]) {
      const expected = policy.preset === 'important';
      expect(projectSessionFollowFactsV1({ following: true, notificationLevel: 'important', includeInVoice: !expected, policy }))
        .toMatchObject({ includeInVoice: expected });
      expect(projectSessionFollowFactsV1({ following: true, notificationLevel: 'important', includeInVoice: !expected,
        followPolicy: JSON.stringify(policy) })).toMatchObject({ includeInVoice: expected });
    }
    expect(projectSessionFollowFactsV1({ following: true, notificationLevel: 'important', includeInVoice: true, followPolicy: '{broken' }))
      .toMatchObject({ includeInVoice: false });
  });
  it('projects Include in Voice and notification breadth from the current policy', () => {
    expect(projectSessionFollowFactsV1({
      following: true,
      notificationLevel: 'important',
      includeInVoice: true,
      policy: { preset: 'important', voice: true },
    })).toEqual({ follows: true, notificationLevel: 'important', includeInVoice: true, policy: { preset: 'important', voice: true } });
    expect(projectSessionFollowFactsV1({
      following: true,
      followPolicy: JSON.stringify({ preset: 'important' }),
    })).toEqual({ follows: true, notificationLevel: 'important', includeInVoice: false, policy: { preset: 'important' } });
  });

  it('closes the notification vocabulary at none | important | all_messages', () => {
    expect(SessionFollowNotificationLevelSchema.options).toEqual([
      'none',
      'important',
      'all_messages',
    ]);
    expect(SessionFollowNotificationLevelSchema.safeParse('muted').success).toBe(false);
    expect(SessionFollowNotificationLevelSchema.safeParse('important').success).toBe(true);
  });

  it('rejects unknown fields and persisted frontier leakage on the human projection', () => {
    const projection = AccountSessionFollowV1Schema.parse({
      sessionId: 'session-1',
      following: true,
      notificationLevel: 'important',
      includeInVoice: false,
    });
    expect(projection).toEqual({
      sessionId: 'session-1',
      following: true,
      notificationLevel: 'important',
      includeInVoice: false,
    });

    expect(AccountSessionFollowV1Schema.safeParse({
      sessionId: 'session-1',
      following: true,
      notificationLevel: 'important',
      includeInVoice: false,
      voiceDeliveredFrontier: 'anything',
    }).success).toBe(false);

    expect(AccountSessionFollowV1Schema.safeParse({
      sessionId: 'session-1',
      following: true,
      notificationLevel: 'important',
      includeInVoice: false,
      deliveryAccountId: 'account-2',
    }).success).toBe(false);
  });

  it('exposes exactly one Follow capability bit', () => {
    expect(AccountSessionFollowCapabilitiesV1Schema.parse({ manageFollow: true }))
      .toEqual({ manageFollow: true });
    expect(AccountSessionFollowCapabilitiesV1Schema.safeParse({ manageFollow: true, view: true }).success)
      .toBe(false);
  });

  it('requires all four auto-follow Booleans on a replacement write', () => {
    expect(SessionAutoFollowPreferencesV1Schema.parse({
      assigned: true,
      direct: false,
      team: false,
      group: false,
    })).toEqual({ assigned: true, direct: false, team: false, group: false });

    expect(SessionAutoFollowPreferencesV1Schema.safeParse({ assigned: true }).success).toBe(false);
    expect(SessionAutoFollowPreferencesV1Schema.safeParse({
      assigned: true,
      direct: false,
      team: false,
      group: false,
      everything: true,
    }).success).toBe(false);
  });

  it('replaces both per-session preferences on set and never accepts a following flag', () => {
    expect(SetSessionFollowRequestSchema.parse({
      notificationLevel: 'all_messages',
      includeInVoice: true,
    })).toEqual({ notificationLevel: 'all_messages', includeInVoice: true });

    expect(SetSessionFollowRequestSchema.safeParse({ notificationLevel: 'important' }).success).toBe(false);
    expect(SetSessionFollowRequestSchema.safeParse({
      notificationLevel: 'important',
      includeInVoice: false,
      following: false,
    }).success).toBe(false);
  });

  it('projects null for an absent Follow and reports capability beside it', () => {
    expect(GetSessionFollowResponseSchema.parse({
      follow: null,
      isSessionOwner: false,
      capabilities: { manageFollow: false },
      voiceInitialSnapshotPending: false,
    })).toEqual({
      follow: null,
      isSessionOwner: false,
      capabilities: { manageFollow: false },
      voiceInitialSnapshotPending: false,
    });

    expect(SetSessionFollowResponseSchema.parse({
      changed: true,
      follow: {
        sessionId: 'session-1',
        following: true,
        notificationLevel: 'important',
        includeInVoice: false,
      },
      voiceInitialSnapshotPending: false,
    }).changed).toBe(true);

    expect(RemoveSessionFollowResponseSchema.parse({ changed: false })).toEqual({ changed: false });
  });

  it('invalidates Follow configuration through one coarse consumed account-kind hint', () => {
    const relationship = buildSessionFollowChangeHintV1();
    expect(relationship).toEqual({ sessionFollows: true, full: true });
    expect(SessionFollowChangeHintV1Schema.safeParse(relationship).success).toBe(true);
    expect(readSessionFollowChangeHintV1(relationship)).toEqual(relationship);

    expect(SessionFollowChangeHintV1Schema.safeParse({ sessionFollows: true, preferences: true }).success)
      .toBe(false);

    expect(ACCOUNT_SESSION_FOLLOW_CHANGE_ENTITY_ID).toBe('session-follows');
    expect(SessionFollowChangeHintV1Schema.safeParse({ sessionFollows: true, reason: 'ready' }).success)
      .toBe(false);
    // No reader narrows by Session id, so the shape is not admitted either.
    expect(SessionFollowChangeHintV1Schema.safeParse({ sessionFollows: true, sessionIds: ['session-1'] }).success)
      .toBe(false);
  });

  it('resolves effective notification level from the Follow row, then owner default, then none', () => {
    expect(resolveEffectiveSessionFollowNotificationLevelV1({
      facts: { follows: true, notificationLevel: 'all_messages' },
      isSessionOwner: false,
    })).toBe('all_messages');

    expect(resolveEffectiveSessionFollowNotificationLevelV1({
      facts: { follows: false, notificationLevel: 'none' },
      isSessionOwner: true,
    })).toBe('none');

    expect(resolveEffectiveSessionFollowNotificationLevelV1({
      facts: { follows: false, notificationLevel: null },
      isSessionOwner: true,
    })).toBe('important');

    expect(resolveEffectiveSessionFollowNotificationLevelV1({
      facts: { follows: false, notificationLevel: null },
      isSessionOwner: false,
    })).toBe('none');
  });

  it('projects effective editor state for an owner, a follower and an explicit unfollow', () => {
    expect(projectAccountSessionFollowEditorStateV1({ follow: null, isSessionOwner: true }))
      .toEqual({ tracked: true, suppressed: false, notificationLevel: 'important', includeInVoice: false, policy: { preset: 'important' } });

    expect(projectAccountSessionFollowEditorStateV1({ follow: null, isSessionOwner: false }))
      .toEqual({ tracked: false, suppressed: false, notificationLevel: 'none', includeInVoice: false, policy: null });

    // An owner override is a real row and wins over the owner default.
    expect(projectAccountSessionFollowEditorStateV1({
      follow: { sessionId: 'session-1', following: true, notificationLevel: 'none', includeInVoice: true },
      isSessionOwner: true,
    })).toEqual({ tracked: true, suppressed: false, notificationLevel: 'none', includeInVoice: true, policy: null });

    // Explicit Unfollow carries no Voice inclusion and no notifications.
    expect(projectAccountSessionFollowEditorStateV1({
      follow: { sessionId: 'session-1', following: false, notificationLevel: 'none', includeInVoice: false },
      isSessionOwner: false,
    })).toEqual({ tracked: false, suppressed: true, notificationLevel: 'none', includeInVoice: false, policy: null });
  });

  it('publishes the closed Follow error vocabulary', () => {
    expect([...SESSION_FOLLOW_ERROR_CODES_V1]).toEqual([
      'invalid_parameters',
      'feature_unavailable',
      'session_not_found',
      'source_not_found',
      'source_unavailable',
      'account_inactive',
      'session_archived',
    ]);
  });

  it('keeps a partial released Voice tracked-set settlement distinct from full success', () => {
    const partial = VoiceTrackedTargetsActionResultV1Schema.parse({
      ok: false,
      status: 'partial',
      sessionIds: ['session-1'],
      sessionAddresses: [{ serverId: 'home-1', sessionId: 'session-1' }],
      sessions: [{
        address: { serverId: 'home-1', sessionId: 'session-1' },
        id: 'session-1',
        serverId: 'home-1',
      }],
      error: {
        code: 'session_follow_partial',
        message: 'Retry the remaining operation.',
        operation: 'include',
        address: { serverId: 'home-1', sessionId: 'session-2' },
        reason: 'unavailable',
      },
    });

    expect(partial).toMatchObject({ ok: false, status: 'partial' });
    expect(VoiceTrackedTargetsActionResultV1Schema.safeParse({
      ...partial,
      ok: true,
    }).success).toBe(false);
  });

  it('accepts more than 50 targets in successful and partial Voice tracked-set projections', () => {
    const sessionAddresses = Array.from({ length: 51 }, (_, index) => ({
      serverId: 'home-1',
      sessionId: `session-${index}`,
    }));
    const sessionIds = sessionAddresses.map(address => address.sessionId);

    expect(VoiceTrackedTargetsActionResultV1Schema.parse({
      ok: true,
      status: 'ok',
      sessionIds,
      sessionAddresses,
      sessions: [],
    })).toEqual({ ok: true, status: 'ok', sessionIds, sessionAddresses, sessions: [] });

    const partial = VoiceTrackedTargetsActionResultV1Schema.parse({
      ok: false,
      status: 'partial',
      sessionIds,
      sessionAddresses,
      sessions: [],
      error: {
        code: 'session_follow_partial',
        message: 'Retry the remaining operation.',
        operation: 'include',
        address: sessionAddresses[50],
        reason: 'unavailable',
      },
    });
    expect(partial).toMatchObject({ ok: false, status: 'partial' });
  });

  it('accepts an Account Voice replacement with more than 100 Session ids', () => {
    const sessionIds = Array.from({ length: 101 }, (_, index) => `session-${index}`);
    expect(ReplaceSessionVoiceInclusionsRequestSchema.parse({ sessionIds })).toEqual({ sessionIds });
  });
});

describe('sessions.following feature contract', () => {
  it('is a fail-closed server feature that depends only on sessions', () => {
    expect(isFeatureId('sessions.following')).toBe(true);
    expect(FEATURE_CATALOG['sessions.following']).toMatchObject({
      representation: 'server',
      dependencies: ['sessions'],
      defaultFailMode: 'fail_closed',
    });
  });

  it('treats a missing or malformed bit as disabled and ignores daemon capability', () => {
    const missing = FeaturesResponseSchema.parse({ features: {}, capabilities: {} });
    expect(readServerEnabledBit(missing, 'sessions.following')).toBe(false);

    const malformed = {
      features: { sessions: { enabled: true, following: { enabled: 'yes' } } },
      capabilities: { session: { follow: { contextVersion: 1 } } },
    } as unknown as Parameters<typeof readServerEnabledBit>[0];
    expect(readServerEnabledBit(malformed, 'sessions.following') === true).toBe(false);

    const enabled = FeaturesResponseSchema.parse({
      features: { sessions: { enabled: true, following: { enabled: true } } },
      capabilities: {},
    });
    expect(readServerEnabledBit(enabled, 'sessions.following')).toBe(true);
  });
});
