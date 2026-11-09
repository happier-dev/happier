import { describe, expect, it } from 'vitest';

import {
    deriveExternalSessionAttentionHasUnread,
    readExternalSessionAttentionV1} from '@happier-dev/protocol/sessions/external/linked-metadata';
import {
    resolveSessionPersonalAttentionV1,
} from '@happier-dev/protocol/sessions/personal/attention';

function externalAttention(metadata: unknown): boolean | null {
    return deriveExternalSessionAttentionHasUnread(
        readExternalSessionAttentionV1(
            (metadata as { externalSessionAttentionV1?: unknown } | null | undefined)?.externalSessionAttentionV1,
        ),
    );
}

function trackedAttention(overrides: Record<string, unknown> = {}) {
    return resolveSessionPersonalAttentionV1({
        tracked: true,
        accessible: true,
        accountSuspended: false,
        contentAvailable: true,
        visibleSessionSeq: 0,
        readState: { state: 'tracking', lastViewedSessionSeq: 0, unreadSince: null },
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
        ...overrides,
    } as Parameters<typeof resolveSessionPersonalAttentionV1>[0]);
}

describe('sessionAttention canonical owners (direct sessions)', () => {
    it('treats a tracked primary failure as personal attention, while untracked stays quiet', () => {
        const failed = trackedAttention({ hasPrimarySessionFailure: true, latestFailureSeq: 1 });
        expect(failed.needsAttention).toBe(true);
        expect(failed.reasons).toContain('failed');

        const untracked = resolveSessionPersonalAttentionV1({
            tracked: false,
            accessible: true,
            accountSuspended: false,
            contentAvailable: true,
            visibleSessionSeq: 3,
            readState: { state: 'not_started' },
            latestReadyEventSeq: null,
            latestFailureSeq: null,
            hasPrimarySessionFailure: true,
            pendingBlockedCount: 0,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
            capabilities: { canSubmitAgentInput: true, canApprovePermissions: true },
            responsible: false,
            discussion: { hasUnread: false, hasMention: false },
            attentionStanding: 'none',
            reminderDue: false,
        });
        expect(untracked.needsAttention).toBe(false);
    });

    it('treats a tracked frontier advance as unread, while untracked Team access stays quiet', () => {
        const tracked = trackedAttention({
            visibleSessionSeq: 3,
            readState: { state: 'tracking', lastViewedSessionSeq: 2, unreadSince: null },
        });
        expect(tracked.needsAttention).toBe(true);
        expect(tracked.reasons).toContain('unread');

        const untracked = resolveSessionPersonalAttentionV1({
            tracked: false,
            accessible: true,
            accountSuspended: false,
            contentAvailable: true,
            visibleSessionSeq: 3,
            readState: { state: 'not_started' },
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
        });
        expect(untracked.needsAttention).toBe(false);
    });
});

describe('sessionAttention canonical owners (linked direct sessions)', () => {
    it('treats linked direct sessions with a newer observed token as unread', () => {
        expect(externalAttention({
            externalSessionAttentionV1: {
                v: 1,
                observedProgressToken: 'marker-2',
                viewedProgressToken: 'marker-1',
            },
        })).toBe(true);
    });

    it('treats linked direct sessions with only an observed token as unread', () => {
        expect(externalAttention({
            externalSessionAttentionV1: {
                v: 1,
                observedProgressToken: 'marker-1',
            },
        })).toBe(true);
    });

    it('treats linked direct sessions with matching observed and viewed timestamps as read', () => {
        expect(externalAttention({
            externalSessionAttentionV1: {
                v: 1,
                observedAtMs: 100,
                viewedAtMs: 100,
            },
        })).toBe(false);
    });

    it('returns no external decision from follow policy alone', () => {
        expect(externalAttention({
            externalSessionV1: {
                v: 1,
                agentId: 'codex',
                machineId: 'machine-1',
                remoteSessionId: 'remote-1',
                source: { kind: 'codexHome', home: 'user' },
                followPolicyV1: { v: 1, policy: 'background_follow' },
            },
        })).toBeNull();
    });

    it('returns no external decision when markers are absent', () => {
        expect(externalAttention({
            externalSessionV1: {
                v: 1,
                agentId: 'codex',
                machineId: 'machine-1',
                remoteSessionId: 'remote-1',
                source: { kind: 'codexHome', home: 'user' },
            },
        })).toBeNull();
    });
});
