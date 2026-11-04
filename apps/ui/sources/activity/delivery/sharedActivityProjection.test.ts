import { describe, expect, it } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';

import { buildSessionActivityAttention } from '@/activity/attention/buildSessionActivityAttention';
import { resolveActivitySurfacePolicy } from '@/activity/attention/resolveActivitySurfacePolicy';
import { createSessionFixture, createSessionViewerFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { buildSharedActivityProjection } from './sharedActivityProjection';
import { resolveActivitySurfaceDeliveryAdmission } from './resolveActivitySurfaceDeliveryAdmission';

const nowMs = 4_000;
const policy = resolveActivitySurfacePolicy({ activitySurfacePrivacyMode: 'include_preview' });

function candidate(id: string, overrides: Parameters<typeof createSessionFixture>[0] = {}) {
    const session = createSessionFixture({ id, serverId: 'home-a', encryptionMode: 'plain',
        active: true, presence: 'online', activeAt: nowMs, ...overrides });
    return buildSessionActivityAttention({ session, nowMs });
}

function admit(candidates: ReturnType<typeof candidate>[], muted = false) {
    const scope = { serverId: 'home-a', accountId: 'account-a' };
    return resolveActivitySurfaceDeliveryAdmission({ candidates, surface: 'desktop_overlay',
        now: new Date(nowMs), localSettings: {}, resolveAccountSettings: () => accountSettingsParse({}),
        audienceScopes: new Map([['home-a', scope]]),
        accountDeliveryMutesByServerId: { 'home-a': { scope, scopes: muted
            ? [{ kind: 'sender_session', sessionId: candidates[0]!.sessionId }] : [] } },
    });
}

describe('shared admitted island and pet activity', () => {
    it.each([false, true])('a Bot or non-Bot ask lifts rest (Bot=%s)', bot => {
        const ask = candidate('ask', { metadata: { path: '/work', host: 'machine',
            ...(bot ? { bot: { kind: 'bot' as const } } : {}) }, pendingPermissionRequestCount: 1,
            agentState: { requests: { 'ask-1': { kind: 'permission', tool: 'Bash', arguments: {}, createdAt: 3_000 } } },
        });
        const result = buildSharedActivityProjection({ admission: admit([ask]), policy });
        expect(result.visible).toBe(true);
        expect(result.entries[0]?.activity).toBe('needsYou');
        expect(result.tray[0]?.activity).toBe('needsYou');
        expect(result.word).not.toBe('');
    });

    it('keeps non-Bot work and unread completion quiet at rest while preserving opened entries', () => {
        const working = candidate('work', { thinking: true, thinkingAt: nowMs });
        const done = candidate('done', { latestTurnStatus: 'completed', latestTurnStatusObservedAt: 3_500,
            seq: 2, lastViewedSessionSeq: 0, viewer: createSessionViewerFixture({
                follow: { follows: true, notificationLevel: 'all_messages', policy: { preset: 'everything' } },
                attention: { needsAttention: true, primary: 'ready_after_read', reasons: ['ready_after_read'], presentation: 'full' },
            }) });
        const result = buildSharedActivityProjection({ admission: admit([working, done]), policy });
        expect(result.visible).toBe(false);
        expect(result.entries.map(entry => entry.activity)).toEqual(['working', 'quiet']);
        expect(result.tray.map(entry => entry.activity)).toEqual(['working']);
        expect(result.word).not.toBe('');
        const quiet = buildSharedActivityProjection({ admission: admit([done]), policy });
        expect(quiet).toMatchObject({ visible: false, word: '', tray: [] });
    });

    it.each(['quiet', 'working'] as const)('selected %s faces lift rest without an ask', activity => {
        const result = buildSharedActivityProjection({ admission: admit([]), policy,
            selectedFaces: [{ activity }] });
        expect(result.visible).toBe(true);
    });

    it('honors exact-Home delivery mute and leaves no prohibited tray copy', () => {
        const privateSession = candidate('private', { thinking: true, thinkingAt: nowMs,
            metadata: { path: '/private', host: 'private-host', name: 'Prohibited title' } });
        expect(buildSharedActivityProjection({ admission: admit([privateSession], true), policy }))
            .toMatchObject({ visible: false, word: '', entries: [], tray: [] });
    });

    it('privacy filters title and context once, and later asks have independent dismissal identities', () => {
        const ask = (requestId: string) => candidate('ask', { metadata: { path: '/secret', host: 'secret-host', name: 'Private name' },
            pendingPermissionRequestCount: 1, agentState: { requests: {
                [requestId]: { kind: 'permission', tool: 'Bash', arguments: {}, createdAt: 3_000 },
            } },
        });
        const first = buildSharedActivityProjection({ admission: admit([ask('first')]),
            policy: resolveActivitySurfacePolicy({ activitySurfacePrivacyMode: 'status_only' }) });
        expect(JSON.stringify(first)).not.toContain('Private name');
        expect(JSON.stringify(first)).not.toContain('/secret');
        const next = buildSharedActivityProjection({ admission: admit([ask('next')]), policy });
        expect(next.tray[0]?.dismissKey).not.toBe(first.tray[0]?.dismissKey);
    });

    it('a later count-only request is not hidden by an earlier request dismissal', () => {
        const project = (pendingRequestObservedAt: number) => buildSharedActivityProjection({
            admission: admit([candidate('count-only', { pendingPermissionRequestCount: 1, pendingRequestObservedAt })]),
            policy,
        });
        expect(project(4_000).tray[0]?.dismissKey).not.toBe(project(3_000).tray[0]?.dismissKey);
    });
});
