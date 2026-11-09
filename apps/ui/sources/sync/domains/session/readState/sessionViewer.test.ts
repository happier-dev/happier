import { describe, expect, it } from 'vitest';
import { resolveSessionPersonalAttentionForViewer } from './sessionViewerAttention';
import { createSessionFixture, createSessionAccessFixture, createSessionViewerFixture } from '@/dev/testkit/fixtures/sessionFixtures';

it('admits only the fulfilled one-shot request still present at the real request owner', () => {
    const session = createSessionFixture({ active: true, access: createSessionAccessFixture('edit'),
        viewer: createSessionViewerFixture({ follow: { follows: false, notificationLevel: 'none',
            onceDelivery: { event: 'user_action_required', requestId: 'once-request', agentStateVersion: 1 } } }),
        agentState: { requests: { 'once-request': { kind: 'user_action', tool: 'AskUserQuestion', arguments: {}, createdAt: 1 } } },
    });
    expect(resolveSessionPersonalAttentionForViewer(session, 2).primary).toBe('user_action_required');
    expect(isSessionPersonallyTrackedForViewer(session)).toBe(false);
    expect(resolveSessionPersonalAttentionForViewer({ ...session, agentState: { requests: {
        'later-request': { kind: 'user_action', tool: 'AskUserQuestion', arguments: {}, createdAt: 2 },
    } } }, 3).needsAttention).toBe(false);
});

import {
    hasUnreadActivityForSessionViewer,
    isSessionPersonallyTrackedForViewer,
    normalizeSessionViewerCompatibility,
    resolveSessionViewerProjectionUpdate,
} from './sessionViewer';

import type { NormalizedSessionAccessProjection } from '@/sync/engine/sessions/normalizeSessionAccessProjection';
import type { SessionPersonalAttentionReasonV1} from '@happier-dev/protocol/sessions/personal/attention';
import type { SessionViewerProjectionV1 } from '@happier-dev/protocol/sessions/personal/viewer';

function accessFor(role: 'owner' | 'recipient'): NormalizedSessionAccessProjection {
    return {
        role,
        level: role === 'owner' ? 'owner' : 'view',
        sources: [role === 'owner' ? { kind: 'owner' } : { kind: 'direct', shareId: 'share-1' }],
        capabilities: {
            readTranscript: true,
            submitAgentInput: role === 'owner',
            editSessionRecords: role === 'owner',
            approveRuntimePermissions: role === 'owner',
            manageAccess: role === 'owner',
            managePermissionDelegation: role === 'owner',
            managePublicLink: role === 'owner',
            archiveSession: role === 'owner',
            renameSession: role === 'owner',
            assignResponsibility: role === 'owner',
            stopSession: role === 'owner',
            deleteSession: role === 'owner',
        },
    };
}

function trackedViewerWithReasons(
    reasons: readonly SessionPersonalAttentionReasonV1[],
): SessionViewerProjectionV1 {
    return {
        latestFailureSeq: null,
        readState: { state: 'tracking', lastViewedSessionSeq: 2, unreadSince: 3 },
        relevance: { relevant: true, reasons: [] },
        attention: {
            needsAttention: reasons.length > 0,
            reasons,
            primary: reasons[0] ?? null,
            presentation: 'full',
        },
        follow: { follows: false, notificationLevel: null },
        notification: { level: 'none', source: 'none' },
    };
}

describe('isSessionPersonallyTrackedForViewer', () => {
    it('projects additive retained viewer facts without treating them as malformed or relaxing fresh updates', () => {
        const viewer = trackedViewerWithReasons(['unread']);
        const retained = {
            ...viewer,
            retiredViewerField: true,
            follow: { ...viewer.follow, retiredFollowField: true },
            attention: { ...viewer.attention, retiredAttentionField: true },
        };
        expect(normalizeSessionViewerCompatibility({ viewer: retained, access: accessFor('owner') }))
            .toEqual({ kind: 'current', viewer });
        expect(resolveSessionViewerProjectionUpdate(retained, undefined)).toBeUndefined();
        expect(normalizeSessionViewerCompatibility({
            viewer: { ...retained, follow: { follows: 'yes', notificationLevel: null } },
        })).toEqual({ kind: 'untracked' });
    });

    it('keeps the released owner/access-level fallback only when normalized access is absent', () => {
        expect(isSessionPersonallyTrackedForViewer({})).toBe(true);
        expect(isSessionPersonallyTrackedForViewer({ accessLevel: 'view' })).toBe(false);
    });

    it('fails closed when a malformed current access projection was normalized to null', () => {
        expect(isSessionPersonallyTrackedForViewer({
            access: null,
            accessLevel: undefined,
        })).toBe(false);
    });

    it('does not enroll a non-Follower in the owner unread state because a cursor row exists', () => {
        // The Home tracks owner-or-Follow; a retained read cursor is the cursor
        // fact, never tracking authority.
        expect(isSessionPersonallyTrackedForViewer({
            access: accessFor('recipient'),
            viewer: trackedViewerWithReasons(['unread']),
        })).toBe(false);
        expect(isSessionPersonallyTrackedForViewer({
            access: accessFor('recipient'),
            viewer: {
                ...trackedViewerWithReasons(['unread']),
                follow: { follows: true, notificationLevel: 'none' },
            },
        })).toBe(true);
        expect(isSessionPersonallyTrackedForViewer({
            access: accessFor('owner'),
            viewer: {
                ...trackedViewerWithReasons([]),
                readState: { state: 'not_started' },
            },
        })).toBe(true);
    });

    it('does not treat a current sourced owner projection with a missing viewer as pre-viewer', () => {
        expect(isSessionPersonallyTrackedForViewer({
            access: {
                role: 'owner',
                level: 'owner',
                sources: [{ kind: 'owner' }],
                capabilities: {
                    readTranscript: true,
                    submitAgentInput: true,
                    editSessionRecords: true,
                    approveRuntimePermissions: true,
                    manageAccess: true,
                    managePermissionDelegation: true,
                    managePublicLink: true,
                    archiveSession: true,
                    renameSession: true,
                    assignResponsibility: true,
                    stopSession: true,
                    deleteSession: true,
                },
            },
        })).toBe(false);
    });
});

describe('hasUnreadActivityForSessionViewer', () => {
    it('counts Discussion unread and a mention of the viewer as unread, like Activity and Inbox', () => {
        expect(hasUnreadActivityForSessionViewer(trackedViewerWithReasons(['unread']))).toBe(true);
        expect(hasUnreadActivityForSessionViewer(trackedViewerWithReasons(['unread_discussion']))).toBe(true);
        expect(hasUnreadActivityForSessionViewer(trackedViewerWithReasons(['mentioned']))).toBe(true);
    });

    it('stays quiet for attention reasons that are not new unread content', () => {
        expect(hasUnreadActivityForSessionViewer(trackedViewerWithReasons([]))).toBe(false);
        expect(hasUnreadActivityForSessionViewer(trackedViewerWithReasons(['reminder_due']))).toBe(false);
        expect(hasUnreadActivityForSessionViewer(trackedViewerWithReasons(['ready_after_read']))).toBe(false);
    });

    it('stays quiet for an untracked viewer whatever the reasons say', () => {
        const untracked: SessionViewerProjectionV1 = {
            ...trackedViewerWithReasons(['unread_discussion']),
            readState: { state: 'not_started' },
        };
        expect(hasUnreadActivityForSessionViewer(untracked)).toBe(false);
    });
});
