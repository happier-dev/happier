import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    ACTIVITY_REMOTE_ALERT_EVENT_TYPES_V1,
    type ActivityRemoteAlertV2,
} from '@happier-dev/protocol/push/activityRemoteAlert';

import {
    parseActivityRemoteAlertData,
    resolveActivityRemoteAlertTarget,
    resolveIncomingActivityRemoteAlert,
} from './activityRemoteAlertRouting';

const serverProfiles = await import('@/sync/domains/server/serverProfiles');

const routingCases = {
    ready: {
        event: { type: 'ready', sequenceDomain: 'session_transcript', messageSeq: 42 },
        expectedEvent: 'ready',
        expectedIdentity: 'message-seq:session_transcript:42',
    },
    permission_request: {
        event: { type: 'permission_request' },
        expectedEvent: 'permission_required',
        expectedIdentity: undefined,
    },
    user_action_request: {
        event: { type: 'user_action_request' },
        expectedEvent: 'user_action_required',
        expectedIdentity: undefined,
    },
    assigned: {
        event: { type: 'assigned' },
        expectedEvent: 'assigned',
        expectedIdentity: undefined,
    },
    failed: {
        event: { type: 'failed', turnId: 'turn-failed' },
        expectedEvent: 'failed',
        expectedIdentity: 'turn:turn-failed',
    },
    cancelled: {
        event: { type: 'cancelled', turnId: 'turn-cancelled' },
        expectedEvent: 'cancelled',
        expectedIdentity: 'turn:turn-cancelled',
    },
    human_message: {
        event: { type: 'human_message', sequenceDomain: 'session_transcript', messageSeq: 43 },
        expectedEvent: 'human_message',
        expectedIdentity: 'message-seq:session_transcript:43',
    },
    message: {
        event: { type: 'message', sequenceDomain: 'discussion', discussionId: 'discussion-a', messageSeq: 44 },
        expectedEvent: 'message',
        expectedIdentity: 'message-seq:discussion:discussion-a:44',
    },
    discussion_mention: {
        event: { type: 'discussion_mention', sequenceDomain: 'discussion', discussionId: 'discussion-b', messageSeq: 45 },
        expectedEvent: 'discussion_mention',
        expectedIdentity: 'message-seq:discussion:discussion-b:45',
    },
    source_unavailable: {
        event: { type: 'source_unavailable' },
        expectedEvent: 'source_unavailable',
        expectedIdentity: undefined,
    },
} as const satisfies Record<
    ActivityRemoteAlertV2['event']['type'],
    Readonly<{
        event: ActivityRemoteAlertV2['event'];
        expectedEvent: string;
        expectedIdentity?: string;
    }>
>;

function alert(overrides: Record<string, unknown> = {}) {
    return {
        type: 'activity_alert',
        v: 2,
        serverId: 'srv_acme',
        sessionId: 'session-1',
        accountId: 'account-1',
        event: { type: 'ready', sequenceDomain: 'session_transcript', messageSeq: 42 },
        previewBehavior: 'status_only',
        ...overrides,
    };
}

async function clearProfiles(): Promise<void> {
    for (const profile of serverProfiles.listServerProfiles()) {
        await serverProfiles.removeServerProfile(profile.id);
    }
}

beforeEach(clearProfiles);
afterEach(clearProfiles);

describe('parseActivityRemoteAlertData', () => {
    it('admits only the canonical committed event reference', () => {
        expect(parseActivityRemoteAlertData(alert())).toMatchObject({
            event: { type: 'ready', sequenceDomain: 'session_transcript', messageSeq: 42 },
        });
        expect(parseActivityRemoteAlertData(alert({ event: { type: 'permission_request' } }))).not.toBeNull();
        // A badge refresh, a rich owner push and an unknown category are not alerts.
        expect(parseActivityRemoteAlertData({ type: 'badge_refresh' })).toBeNull();
        expect(parseActivityRemoteAlertData({ sessionId: 'session-1', serverId: 'srv_acme' })).toBeNull();
        expect(parseActivityRemoteAlertData(alert({ event: { type: 'human_message' } }))).toBeNull();
        // `ready` without its published sequence is not a usable reference, and
        // extra top-level fields are rejected rather than carried along.
        expect(parseActivityRemoteAlertData(alert({ event: { type: 'ready' } }))).toBeNull();
        expect(parseActivityRemoteAlertData(alert({
            event: { type: 'discussion_mention', sequenceDomain: 'discussion', messageSeq: 1 },
        }))).toBeNull();
        expect(parseActivityRemoteAlertData(alert({
            event: { type: 'discussion_mention', sequenceDomain: 'discussion', discussionId: ' ', messageSeq: 1 },
        }))).toBeNull();
        expect(parseActivityRemoteAlertData(alert({ title: 'Private title' }))).toBeNull();
    });
});

describe('resolveActivityRemoteAlertTarget', () => {
    it('routes to the exact Home that owns the alert, not the active Home', async () => {
        const acme = await serverProfiles.upsertServerProfile({ serverUrl: 'https://acme.example.test', name: 'Acme' });
        const personal = await serverProfiles.upsertServerProfile({ serverUrl: 'https://personal.example.test', name: 'Personal' });
        await serverProfiles.setServerProfileIdentityForUrl(acme.serverUrl, 'srv_acme');
        await serverProfiles.setServerProfileIdentityForUrl(personal.serverUrl, 'srv_personal');
        await serverProfiles.setActiveServerId(personal.id, { scope: 'device' });

        const parsed = parseActivityRemoteAlertData(alert());
        expect(parsed).not.toBeNull();
        expect(resolveActivityRemoteAlertTarget(parsed!)).toMatchObject({
            address: { serverId: acme.id, sessionId: 'session-1' },
            serverUrl: 'https://acme.example.test',
            event: 'ready',
            eventIdentity: 'message-seq:session_transcript:42',
        });
    });

    it('maps every strict remote category to its device-local event and stable committed identity', async () => {
        const acme = await serverProfiles.upsertServerProfile({ serverUrl: 'https://acme.example.test', name: 'Acme' });
        await serverProfiles.setServerProfileIdentityForUrl(acme.serverUrl, 'srv_acme');

        expect(Object.keys(routingCases)).toEqual(ACTIVITY_REMOTE_ALERT_EVENT_TYPES_V1);
        for (const { event, expectedEvent, expectedIdentity } of Object.values(routingCases)) {
            const parsed = parseActivityRemoteAlertData(alert({ event }));
            expect(parsed).not.toBeNull();
            const target = resolveActivityRemoteAlertTarget(parsed!);
            expect(target?.event).toBe(expectedEvent);
            expect(target?.eventIdentity).toBe(expectedIdentity);
        }
    });

    it('keeps equal sequences in two Discussions distinct', async () => {
        const acme = await serverProfiles.upsertServerProfile({ serverUrl: 'https://acme.example.test', name: 'Acme' });
        await serverProfiles.setServerProfileIdentityForUrl(acme.serverUrl, 'srv_acme');
        const first = parseActivityRemoteAlertData(alert({ event: {
            type: 'discussion_mention', sequenceDomain: 'discussion', discussionId: 'discussion-a', messageSeq: 1,
        } }));
        const second = parseActivityRemoteAlertData(alert({ event: {
            type: 'discussion_mention', sequenceDomain: 'discussion', discussionId: 'discussion-b', messageSeq: 1,
        } }));
        expect(first).not.toBeNull();
        expect(second).not.toBeNull();
        expect(resolveActivityRemoteAlertTarget(first!)?.eventIdentity)
            .toBe('message-seq:discussion:discussion-a:1');
        expect(resolveActivityRemoteAlertTarget(second!)?.eventIdentity)
            .toBe('message-seq:discussion:discussion-b:1');
    });

    it('fails closed on an unknown Home instead of using the active Home', async () => {
        const personal = await serverProfiles.upsertServerProfile({ serverUrl: 'https://personal.example.test', name: 'Personal' });
        await serverProfiles.setServerProfileIdentityForUrl(personal.serverUrl, 'srv_personal');
        await serverProfiles.setActiveServerId(personal.id, { scope: 'device' });
        // The alert names a Home this device has not saved; the active Home is
        // never substituted, and no session route is produced for it.
        expect(resolveIncomingActivityRemoteAlert(alert())).toEqual({ kind: 'unroutable' });
    });

    it('keeps a released ambiguous v1 sequence routable without granting it a current-domain identity', async () => {
        const acme = await serverProfiles.upsertServerProfile({ serverUrl: 'https://acme.example.test', name: 'Acme' });
        await serverProfiles.setServerProfileIdentityForUrl(acme.serverUrl, 'srv_acme');
        const parsed = parseActivityRemoteAlertData({
            ...alert(),
            v: 1,
            event: { type: 'human_message', messageSeq: 43 },
        });
        expect(parsed).not.toBeNull();
        expect(resolveActivityRemoteAlertTarget(parsed!)?.eventIdentity).toBe('legacy-message-seq:43');
    });
});
