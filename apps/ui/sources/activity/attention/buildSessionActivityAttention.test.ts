import { describe, expect, it } from 'vitest';

import { createSessionFixture, createSessionViewerFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import type { Session } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';

import { buildSessionActivityAttention } from './buildSessionActivityAttention';

function createMetadata(overrides: Partial<NonNullable<Session['metadata']>> = {}): NonNullable<Session['metadata']> {
    return {
        path: '/Users/tester/project',
        host: 'tester.local',
        homeDir: '/Users/tester',
        machineId: 'machine-1',
        ...overrides,
    };
}

describe('buildSessionActivityAttention', () => {
    it('projects canonical successful Turn completion without a transcript fallback watermark', () => {
        const base = createSessionFixture({ latestTurnId: 'canonical-turn', lastTurnCompletedAt: null,
            latestTurnStatus: 'in_progress', latestTurnStatusObservedAt: 900 });
        for (const status of ['in_progress', 'failed', 'cancelled'] as const) {
            expect(buildSessionActivityAttention({ session: { ...base, latestTurnStatus: status }, nowMs: 1_000 }).lastTurnCompletedAt).toBeNull();
        }
        const completed = { ...base, latestTurnStatus: 'completed' as const, latestTurnStatusObservedAt: 980 };
        expect(buildSessionActivityAttention({ session: completed, nowMs: 1_000 }).lastTurnCompletedAt).toBe(980);
        // A later Ready publication is the same completion, not a second answer.
        expect(buildSessionActivityAttention({ session: { ...completed, latestReadyEventAt: 990, latestReadyEventSeq: 2 }, nowMs: 1_000 }).lastTurnCompletedAt).toBe(980);
    });
    it('does not resurrect an acknowledged failure from the operational history', () => {
        const session = createSessionFixture({ active: true, activeAt: 1_000, encryptionMode: 'plain',
            latestTurnStatus: 'failed', metadata: createMetadata(),
            viewer: { latestFailureSeq: null, readState: { state: 'tracking', lastViewedSessionSeq: 20, unreadSince: null },
                relevance: { relevant: true, reasons: ['owned_by_me'] },
                follow: { follows: false, notificationLevel: null }, notification: { level: 'important', source: 'owner' },
                attention: { needsAttention: false, reasons: [], primary: null, presentation: 'full' } },
        });
        const result = buildSessionActivityAttention({ session, nowMs: 1_000 });
        expect(result.hasAttention).toBe(false);
        expect(result.attentionState).not.toBe('failed');
    });
    it('classifies a working Session for summaries without reading private display details', () => {
        const session = createSessionFixture({ active: true, presence: 'online', thinking: true, thinkingAt: 950,
            encryptionMode: 'plain', metadata: createMetadata() });
        if (!session.metadata) throw new Error('Missing fixture metadata');
        Object.defineProperty(session.metadata, 'name', { get: () => { throw new Error('Summary read private display details'); } });
        const input = { session, nowMs: 1_000, presentation: 'summary' as const };
        expect(buildSessionActivityAttention(input)).toMatchObject({ reasons: { isThinking: true }, title: '', subtitle: '' });
    });

    it('does not expose retained metadata when E2EE availability is unknown', () => {
        const session = createSessionFixture({
            encryptionMode: 'e2ee',
            encryptedContentAvailability: undefined,
            metadata: createMetadata({
                name: 'Private retained title',
                path: '/private/retained/path',
            }),
            viewer: {
                latestFailureSeq: null,
                readState: { state: 'tracking', lastViewedSessionSeq: 0, unreadSince: 1 },
                relevance: { relevant: true, reasons: ['owned_by_me'] },
                follow: { follows: false, notificationLevel: null },
                notification: { level: 'important', source: 'owner' },
                attention: { needsAttention: true, reasons: ['unread'], primary: 'unread', presentation: 'full' },
            },
        });

        const attention = buildSessionActivityAttention({ session, nowMs: 1_000 });

        expect(attention.title).not.toContain('Private retained title');
        expect(attention.subtitle).not.toContain('/private/retained/path');
    });

    it('names a Session whose content this device cannot read the way every other Session surface does', () => {
        const session = createSessionFixture({ encryptionMode: 'e2ee', encryptedContentAvailability: 'encrypted_content_unavailable', metadata: null });

        expect(buildSessionActivityAttention({ session, nowMs: 1_000 }).title).toBe(t('session.access.lockedTitleFallback'));
    });

    it('names a Session this device opened even when its Home cannot vouch for notification content', () => {
        // `status_only` is the Home's notification-preview ceiling (it sees no recipient envelope,
        // e.g. a Session the owner opens through the historical owner key). This device opened the
        // content, so in-app rows name it; off-app surfaces keep the ceiling.
        const session = createSessionFixture({
            encryptionMode: 'e2ee',
            encryptedContentAvailability: 'ready',
            metadata: createMetadata({ name: 'Readable owner session' }),
            viewer: {
                latestFailureSeq: null,
                readState: { state: 'tracking', lastViewedSessionSeq: 0, unreadSince: 1 },
                relevance: { relevant: true, reasons: ['owned_by_me'] },
                follow: { follows: false, notificationLevel: null },
                notification: { level: 'important', source: 'owner' },
                attention: { needsAttention: true, reasons: ['unread'], primary: 'unread', presentation: 'status_only' },
            },
        });

        const attention = buildSessionActivityAttention({ session, nowMs: 1_000 });

        expect(attention.title).toBe('Readable owner session');
    });

    it('preserves linked external progress unread only for a tracked owner', () => {
        const session = createSessionFixture({ seq: 1, lastViewedSessionSeq: 1,
            metadata: { ...createMetadata(),
                externalSessionV1: { v: 1, agentId: 'codex', machineId: 'machine-1', remoteSessionId: 'remote-1', source: { kind: 'codexHome', home: 'user' } },
                externalSessionAttentionV1: { v: 1, observedProgressToken: 'new', viewedProgressToken: 'old' },
            },
        });
        expect(buildSessionActivityAttention({ session }).reasons.hasUnread).toBe(true);
        expect(buildSessionActivityAttention({ session: { ...session, owner: 'another-account', accessLevel: 'view' } }).hasAttention).toBe(false);
    });

    it('does not invent unread attention when a pre-viewer Home has no released read cursor', () => {
        const session = createSessionFixture({
            seq: 8,
            lastViewedSessionSeq: undefined,
            metadata: createMetadata(),
            pendingBlockedCount: 0,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
            latestReadyEventSeq: null,
        });

        const attention = buildSessionActivityAttention({ session, nowMs: 1_000 });

        expect(attention.hasAttention).toBe(false);
        expect(attention.reasons.hasUnread).toBe(false);
    });

    it('uses viewer attention instead of raw unread or permission facts', () => {
        const session = Object.assign(createSessionFixture({
            encryptionMode: 'plain',
            seq: 20,
            lastViewedSessionSeq: 0,
            active: true,
            presence: 'online',
            pendingPermissionRequestCount: 1,
            pendingRequestObservedAt: 990,
        }), {
            viewer: {
                latestFailureSeq: null,
                readState: { state: 'not_started' },
                relevance: { relevant: true, reasons: ['responsible_for_me'] },
                follow: { follows: false, notificationLevel: 'none' },
                notification: { level: 'none', source: 'preference' },
                attention: { needsAttention: false, reasons: [], primary: null, presentation: 'full' },
            },
        } as const);
        const attention = buildSessionActivityAttention({ session, nowMs: 1_000 });
        expect(attention.hasAttention).toBe(false);
        expect(attention.reasons.hasUnread).toBe(false);
        expect(attention.reasons.hasPendingPermissionRequests).toBe(false);
    });

    it('uses the session-list operational projection before viewer unread while work is active', () => {
        const session = Object.assign(createSessionFixture({
            encryptionMode: 'plain',
            active: true,
            presence: 'online',
            latestTurnStatus: 'in_progress',
        }), {
            viewer: {
                latestFailureSeq: null,
                readState: { state: 'tracking', lastViewedSessionSeq: 1, unreadSince: 2 },
                relevance: { relevant: true, reasons: ['owned_by_me'] },
                follow: { follows: false, notificationLevel: null },
                notification: { level: 'important', source: 'owner' },
                attention: { needsAttention: true, reasons: ['unread'], primary: 'unread', presentation: 'full' },
            },
        } as const);

        const attention = buildSessionActivityAttention({ session, nowMs: 1_000 });

        expect(attention.hasAttention).toBe(true);
        expect(attention.personalAttention.reasons).toEqual(['unread']);
        expect(attention.awareness.operational.reasons).toContain('working');
        expect(attention.attentionState).toBe('thinking');
    });

    it('surfaces canonical discussion attention without inventing transcript unread', () => {
        const session = Object.assign(createSessionFixture({ active: true, activeAt: 1_000, presence: 'online', seq: 20, lastViewedSessionSeq: 20 }), {
            viewer: {
                latestFailureSeq: null,
                readState: { state: 'tracking', lastViewedSessionSeq: 20, unreadSince: null },
                relevance: { relevant: true, reasons: ['followed_by_me'] },
                follow: { follows: true, notificationLevel: 'none' },
                notification: { level: 'none', source: 'preference' },
                attention: { needsAttention: true, reasons: ['unread_discussion'], primary: 'unread_discussion', presentation: 'full' },
            },
        } as const);
        const attention = buildSessionActivityAttention({ session, nowMs: 1_000 });
        expect(attention.hasAttention).toBe(true);
        expect(attention.attentionState).toBe('unread');
        expect(attention.personalAttention.reasons).toEqual(['unread_discussion']);
        expect(attention.reasons.hasUnread).toBe(true);
    });

    it('counts a mention of the viewer as unread content, like the Session row', () => {
        const session = Object.assign(createSessionFixture({ seq: 20, lastViewedSessionSeq: 20 }), {
            viewer: {
                latestFailureSeq: null,
                readState: { state: 'tracking', lastViewedSessionSeq: 20, unreadSince: null },
                relevance: { relevant: true, reasons: ['followed_by_me'] },
                follow: { follows: true, notificationLevel: 'none' },
                notification: { level: 'none', source: 'preference' },
                attention: { needsAttention: true, reasons: ['mentioned'], primary: 'mentioned', presentation: 'full' },
            },
        } as const);
        // One derivation of "new content this viewer has not seen" feeds the row,
        // the Inbox and this overview count; a mention must not be unread in one
        // and quiet in another.
        expect(buildSessionActivityAttention({ session, nowMs: 1_000 }).reasons.hasUnread).toBe(true);
    });

    it.each(['manual', 'reminder_due'] as const)(
        'presents canonical %s attention without mislabeling it as unread',
        (reason) => {
            const session = Object.assign(createSessionFixture({ active: true, activeAt: 1_000, presence: 'online', seq: 20, lastViewedSessionSeq: 20 }), {
                viewer: {
                    latestFailureSeq: null,
                    readState: { state: 'tracking', lastViewedSessionSeq: 20, unreadSince: null },
                    relevance: { relevant: true, reasons: ['followed_by_me'] },
                    follow: { follows: true, notificationLevel: 'none' },
                    notification: { level: 'none', source: 'preference' },
                    attention: { needsAttention: true, reasons: [reason], primary: reason, presentation: 'full' },
                },
            } as const);

            expect(buildSessionActivityAttention({ session, nowMs: 1_000 })).toMatchObject({
                hasAttention: true,
                attentionState: 'unread',
                reasons: { hasUnread: false },
            });
        },
    );

    it.each(['manual', 'reminder_due'] as const)(
        'preserves canonical %s presentation when the operational projection is ready',
        (reason) => {
            const session = Object.assign(createSessionFixture({
                active: true, activeAt: 1_000, presence: 'online',
                latestTurnStatus: 'completed',
                lastTurnCompletedAt: 900,
            }), {
                viewer: {
                    latestFailureSeq: null,
                    readState: { state: 'tracking', lastViewedSessionSeq: 20, unreadSince: null },
                    relevance: { relevant: true, reasons: ['followed_by_me'] },
                    follow: { follows: true, notificationLevel: 'none' },
                    notification: { level: 'none', source: 'preference' },
                    attention: { needsAttention: true, reasons: [reason], primary: reason, presentation: 'full' },
                },
            } as const);

            expect(buildSessionActivityAttention({ session, nowMs: 1_000 }).attentionState).toBe('unread');
        },
    );

    it('prioritizes permission-required sessions above unread sessions', () => {
        const attention = buildSessionActivityAttention({
            session: createSessionFixture({
                encryptionMode: 'plain',
                id: 'session-permission',
                active: true,
                presence: 'online',
                pendingPermissionRequestCount: 1,
                agentState: {
                    controlledByUser: null,
                    requests: {
                        permission_1: {
                            tool: 'Bash',
                            kind: 'permission',
                            arguments: { command: 'deploy' },
                            createdAt: Date.now(),
                        },
                    },
                },
                seq: 3,
                lastViewedSessionSeq: 3,
                metadata: createMetadata({
                    summary: { text: 'Review deploy', updatedAt: 1 },
                }),
            }),
        });

        expect(attention).toMatchObject({
            sessionId: 'session-permission',
            title: 'Review deploy',
            attentionState: 'permission_required',
            hasAttention: true,
            reasons: {
                hasPendingPermissionRequests: true,
                hasPendingUserActionRequests: false,
            },
        });
        expect(attention.priority).toBeGreaterThan(0);
    });

    it('keeps permission attention while the runtime is live, however long the request has waited', () => {
        const attention = buildSessionActivityAttention({
            session: createSessionFixture({
                encryptionMode: 'plain',
                id: 'session-expired-permission',
                active: true,
                presence: 'online',
                pendingPermissionRequestCount: 1,
                pendingRequestObservedAt: 1_000,
                agentState: {
                    controlledByUser: null,
                    requests: { permission_1: { tool: 'Bash', kind: 'permission', arguments: { command: 'deploy' }, createdAt: 1_000 } },
                },
                seq: 3,
                lastViewedSessionSeq: 3,
                metadata: createMetadata(),
            }),
            nowMs: 121_001,
        });

        expect(attention.awareness.operational.primary).toBe('permission_required');
        expect(attention.attentionState).toBe('permission_required');
        expect(attention.hasAttention).toBe(true);
        expect(attention.reasons.hasPendingPermissionRequests).toBe(true);
    });

    it('does not surface inactive permission counts as permission-required attention', () => {
        const attention = buildSessionActivityAttention({
            session: createSessionFixture({
                encryptionMode: 'plain',
                id: 'session-inactive',
                active: false,
                presence: 'online',
                pendingPermissionRequestCount: 2,
                pendingUserActionRequestCount: 1,
                seq: 1,
                lastViewedSessionSeq: 1,
                pendingCount: 0,
                metadata: createMetadata(),
            }),
        });

        expect(attention).toMatchObject({
            sessionId: 'session-inactive',
            attentionState: 'waiting',
            hasAttention: false,
            reasons: {
                hasPendingPermissionRequests: false,
                hasPendingUserActionRequests: false,
            },
        });
        expect(attention.priority).toBe(0);
    });

    it('does not treat queued user input as attention', () => {
        const attention = buildSessionActivityAttention({
            session: createSessionFixture({
                encryptionMode: 'plain',
                id: 'session-pending',
                active: true,
                activeAt: 1_000,
                presence: 'online',
                pendingCount: 2,
                pendingPermissionRequestCount: 0,
                pendingUserActionRequestCount: 0,
                lastViewedSessionSeq: 1,
                metadata: createMetadata({
                    path: '/Users/tester/project/packages/app',
                }),
            }),
            nowMs: 1_000,
        });

        expect(attention).toMatchObject({
            sessionId: 'session-pending',
            attentionState: 'pending_input',
            hasAttention: false,
            reasons: {
                hasQueuedUserInput: true,
            },
            subtitle: '~/project/packages/app',
        });
    });

    it('treats fresh optimistic queued user input as working attention', () => {
        const attention = buildSessionActivityAttention({
            session: createSessionFixture({
                encryptionMode: 'plain',
                id: 'session-pending-working',
                active: true,
                presence: 'online',
                thinking: false,
                thinkingAt: 1,
                pendingCount: 1,
                pendingPermissionRequestCount: 0,
                pendingUserActionRequestCount: 0,
                optimisticThinkingAt: 1_000,
                metadata: createMetadata(),
            }),
            nowMs: 1_100,
        });

        expect(attention).toMatchObject({
            sessionId: 'session-pending-working',
            attentionState: 'thinking',
            hasAttention: false,
            reasons: {
                hasQueuedUserInput: true,
                isThinking: true,
            },
        });
    });

    it('surfaces a recent explicit turn completion as ready attention', () => {
        const attention = buildSessionActivityAttention({
            session: Object.assign(createSessionFixture({
                encryptionMode: 'plain',
                id: 'session-turn-complete',
                active: false,
                presence: 900,
                seq: 5,
                lastViewedSessionSeq: 5,
                metadata: createMetadata(),
            }), {
                lastTurnCompletedAt: 980,
            }),
            nowMs: 1_000,
        });

        expect(attention).toMatchObject({
            sessionId: 'session-turn-complete',
            attentionState: 'disconnected',
            hasAttention: false,
            lastTurnCompletedAt: 980,
            reasons: {
                hasQueuedUserInput: false,
                hasPendingPermissionRequests: false,
                hasPendingUserActionRequests: false,
                isThinking: false,
            },
        });
    });

    it('keeps stale explicit turn completion timestamps without surfacing attention', () => {
        const attention = buildSessionActivityAttention({
            session: Object.assign(createSessionFixture({
                encryptionMode: 'plain',
                id: 'session-stale-turn-complete',
                active: false,
                presence: 1,
                seq: 5,
                lastViewedSessionSeq: 5,
                metadata: createMetadata(),
            }), {
                lastTurnCompletedAt: 1_000,
            }),
            nowMs: 31_001,
        });

        expect(attention).toMatchObject({
            sessionId: 'session-stale-turn-complete',
            attentionState: 'disconnected',
            hasAttention: false,
            lastTurnCompletedAt: 1_000,
        });
    });

    it('surfaces failed primary-session runtime issues through activity attention', () => {
        const attention = buildSessionActivityAttention({
            session: Object.assign(createSessionFixture({
                encryptionMode: 'plain',
                id: 'session-runtime-failed',
                viewer: createSessionViewerFixture({ attention: { needsAttention: true, reasons: ['failed'], primary: 'failed', presentation: 'full' } }),
                active: false,
                presence: 'online',
                seq: 5,
                lastViewedSessionSeq: 5,
                metadata: createMetadata(),
            }), {
                latestTurnStatus: 'failed',
                lastRuntimeIssue: {
                    v: 1,
                    scope: 'primary_session',
                    status: 'failed',
                    code: 'agent_status_error',
                    source: 'agent_status_error',
                    occurredAt: 100,
                    sanitizedPreview: 'Provider reported an error',
                },
            }),
        });

        expect(attention).toMatchObject({
            sessionId: 'session-runtime-failed',
            attentionState: 'failed',
            hasAttention: true,
        });
        expect(attention.priority).toBeGreaterThan(0);
    });

    it('keeps same-id pending requests fresh when completed request arguments differ', () => {
        const attention = buildSessionActivityAttention({
            session: createSessionFixture({
                encryptionMode: 'plain',
                id: 'session-permission-retry',
                active: true,
                presence: 'online',
                pendingPermissionRequestCount: 1,
                pendingRequestObservedAt: null,
                agentState: {
                    controlledByUser: null,
                    requests: {
                        permission_retry: {
                            tool: 'Bash',
                            kind: 'permission',
                            arguments: { command: 'git status' },
                            createdAt: 12_345,
                        },
                    },
                    completedRequests: {
                        permission_retry: {
                            tool: 'Bash',
                            kind: 'permission',
                            arguments: { command: 'git diff' },
                            completedAt: 12_500,
                            status: 'approved',
                        },
                    },
                },
                metadata: createMetadata({
                    summary: { text: 'Retry permission', updatedAt: 1 },
                }),
            }),
            nowMs: 12_600,
        });

        expect(attention).toMatchObject({
            sessionId: 'session-permission-retry',
            attentionState: 'permission_required',
            hasAttention: true,
            reasons: {
                hasPendingPermissionRequests: true,
            },
        });
    });
});
