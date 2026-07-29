import { describe, expect, it } from 'vitest';

import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';

import { buildActivityOverviewFromSource, buildStableActivityOverviewFingerprint } from './buildActivityOverviewFromSource';
import type { ActivityAttentionSource } from './activityAttentionSourceTypes';

function pendingAgentState(kind: 'permission' | 'user_action', createdAt = 950) {
    return {
        controlledByUser: null,
        requests: {
            request_1: {
                tool: kind === 'permission' ? 'Bash' : 'Read',
                kind,
                arguments: {},
                createdAt,
            },
        },
    };
}

function createSource(params: Readonly<{
    sessions: ReadonlyArray<ReturnType<typeof createSessionFixture>>;
    isDataReady?: boolean;
}>): ActivityAttentionSource {
    return {
        isDataReady: params.isDataReady ?? true,
        sessionsById: Object.fromEntries(params.sessions.map((session) => [session.id, session])),
        sessionListRenderablesById: Object.fromEntries(
            params.sessions.map((session) => [session.id, buildSessionListRenderableFromSession(session)]),
        ),
        sessionListIndexByServerId: {
            'server-a': params.sessions.filter((session) => session.serverId !== 'server-b').map((session) => ({
                type: 'session' as const,
                sessionId: session.id,
                serverId: 'server-a',
                serverName: 'Server A',
            })),
            'server-b': params.sessions.filter((session) => session.serverId === 'server-b').map((session) => ({
                type: 'session' as const,
                sessionId: session.id,
                serverId: 'server-b',
                serverName: 'Server B',
            })),
        },
        concurrentSessionListCacheByServerId: {},
        serverProfilesById: {
            'server-a': {
                id: 'server-a',
                name: 'Saved A',
                serverUrl: 'https://a.example.test',
                createdAt: 1,
                updatedAt: 1,
                lastUsedAt: 1,
                source: 'manual',
            },
        },
        activeServer: {
            serverId: 'server-a',
            serverUrl: 'https://a.example.test',
            generation: 1,
        },
    };
}

describe('buildActivityOverviewFromSource', () => {
    it('builds a deterministic multi-server attention overview from normalized session indexes', () => {
        const permission = createSessionFixture({
            id: 'permission',
            active: true,
            presence: 'online',
            seq: 1,
            lastViewedSessionSeq: 1,
            pendingPermissionRequestCount: 1,
            pendingRequestObservedAt: 950,
            agentState: pendingAgentState('permission'),
            updatedAt: 20,
        });
        const thinking = createSessionFixture({
            id: 'thinking',
            seq: 2,
            lastViewedSessionSeq: 2,
            active: true,
            presence: 'online',
            thinking: true,
            thinkingAt: 950,
            updatedAt: 30,
        });
        const unread = createSessionFixture({
            id: 'unread',
            seq: 12,
            latestReadyEventSeq: 12,
            lastViewedSessionSeq: 1,
            updatedAt: 40,
        });

        const overview = buildActivityOverviewFromSource({
            source: createSource({ sessions: [unread, thinking, permission] }),
            nowMs: 1_000,
        });

        expect(overview.counts).toMatchObject({
            unread: 1,
            permissionRequired: 1,
            thinking: 1,
            totalAttention: 3,
        });
        expect(overview.candidates.map((candidate) => candidate.sessionId)).toEqual([
            'permission',
            'thinking',
            'unread',
        ]);
    });

    it('carries target, server profile, direct-action, stale, dwell, and stable fingerprint facts on source candidates', () => {
        const overview = buildActivityOverviewFromSource({
            source: createSource({
                sessions: [
                    createSessionFixture({
                        id: 'permission',
                        pendingPermissionRequestCount: 1,
                        agentState: pendingAgentState('permission'),
                        serverId: 'server-b',
                        updatedAt: 20,
                    }),
                ],
            }),
            nowMs: 1_000,
            activityName: 'HappierFocusLiveActivity',
            directActionsEnabled: true,
        });

        expect(overview.fingerprint).toBe(buildStableActivityOverviewFingerprint(overview));
        expect(overview.candidates[0]).toMatchObject({
            sessionId: 'permission',
            serverId: 'server-b',
            serverUrl: null,
            serverName: 'Server B',
            route: '/session/permission?serverId=server-b',
            target: 'open-session:permission?serverId=server-b',
            activityName: 'HappierFocusLiveActivity',
            activityInstanceKey: 'server-b:HappierFocusLiveActivity:permission',
            serverFacts: {
                isKnown: true,
                isSaved: false,
                isActiveLocal: false,
            },
            directActionCapability: {
                canExecute: false,
                reason: 'server_not_saved',
            },
            surfaceTiming: {
                desktopOverlay: {
                    staleAfterMs: 120_000,
                    dwellMs: 90_000,
                },
                liveActivity: {
                    staleAfterMs: 1_800_000,
                    dwellMs: 90_000,
                },
                homeWidget: {
                    staleAfterMs: 1_800_000,
                    dwellMs: 90_000,
                },
            },
        });
    });

    it('preserves stale-while-revalidate behavior by keeping no candidates until source data is ready', () => {
        const overview = buildActivityOverviewFromSource({
            source: createSource({
                isDataReady: false,
                sessions: [
                    createSessionFixture({
                        id: 'unread',
                        seq: 12,
                        lastViewedSessionSeq: 1,
                    }),
                ],
            }),
            nowMs: 1_000,
        });

        expect(overview.counts.totalAttention).toBe(0);
        expect(overview.candidates).toEqual([]);
    });

    it('includes unread sessions that only exist in the concurrent server row cache', () => {
        const overview = buildActivityOverviewFromSource({
            source: {
                ...createSource({ sessions: [] }),
                sessionsById: {},
                sessionListRenderablesById: {},
                sessionListIndexByServerId: {},
                concurrentSessionListCacheByServerId: {
                    'server-b': {
                        serverName: 'Server B',
                        sessions: {
                            'concurrent-unread': {
                                id: 'concurrent-unread',
                                seq: 5,
                                lastViewedSessionSeq: 1,
                                createdAt: 1,
                                updatedAt: 50,
                                active: false,
                                activeAt: 1,
                                archivedAt: null,
                                metadataVersion: 1,
                                agentStateVersion: 0,
                                metadata: { path: '/repo', host: 'remote' },
                                thinking: false,
                                thinkingAt: 0,
                                presence: 1,
                                hasUnreadMessages: true,
                            },
                        },
                    },
                },
            },
            nowMs: 1_000,
            directActionsEnabled: true,
        });

        expect(overview.counts.unread).toBe(1);
        expect(overview.candidates[0]).toMatchObject({
            sessionId: 'concurrent-unread',
            serverId: 'server-b',
            serverName: 'Server B',
            route: '/session/concurrent-unread?serverId=server-b',
            target: 'open-session:concurrent-unread?serverId=server-b',
        });
    });

    it('does not treat stale cached-row thinking as activity after a completed primary turn projection', () => {
        const staleCompleted = buildSessionListRenderableFromSession(Object.assign(createSessionFixture({
            id: 'stale-completed',
            active: true,
            presence: 'online',
            thinking: true,
            thinkingAt: 1_000,
            seq: 2,
            lastViewedSessionSeq: 2,
        }), {
            latestTurnStatus: 'completed' as const,
            latestTurnStatusObservedAt: 2_000,
        }));

        const overview = buildActivityOverviewFromSource({
            source: {
                ...createSource({ sessions: [] }),
                sessionsById: {},
                sessionListRenderablesById: {},
                sessionListIndexByServerId: {},
                concurrentSessionListCacheByServerId: {
                    'server-b': {
                        serverName: 'Server B',
                        sessions: {
                            [staleCompleted.id]: staleCompleted,
                        },
                    },
                },
            },
            nowMs: 2_100,
        });

        expect(overview.counts.thinking).toBe(0);
        expect(overview.counts.totalAttention).toBe(0);
        expect(overview.candidates[0]).toMatchObject({
            sessionId: 'stale-completed',
            attentionState: 'quiet',
            hasAttention: false,
        });
    });

    it('does not promote provider runtime activity when hydrating a cached renderable row', () => {
        const nowMs = 1_000_000;
        const renderable = buildSessionListRenderableFromSession(createSessionFixture({
            id: 'provider-runtime',
            active: true,
            activeAt: nowMs - 20_000,
            presence: 'online',
            runtimeActivityState: 'active',
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: nowMs - 1_000,
            runtimeActivityRevision: nowMs + 60_000,
        }));

        const overview = buildActivityOverviewFromSource({
            source: {
                ...createSource({ sessions: [] }),
                sessionsById: {},
                sessionListRenderablesById: {},
                sessionListIndexByServerId: {},
                concurrentSessionListCacheByServerId: {
                    'server-b': {
                        serverName: 'Server B',
                        sessions: {
                            [renderable.id]: renderable,
                        },
                    },
                },
            },
            nowMs,
        });

        expect(overview.counts.thinking).toBe(0);
        expect(overview.candidates[0]).toMatchObject({
            sessionId: 'provider-runtime',
            attentionState: 'quiet',
            hasAttention: false,
        });
    });

    it('surfaces and clears same-seq newer permission summaries without inventing request identity', () => {
        const canonicalSession = createSessionFixture({
            id: 'hidden-summary-permission',
            serverId: 'server-a',
            seq: 4,
            lastViewedSessionSeq: 4,
            active: true,
            presence: 'online',
            agentStateVersion: 6,
            agentState: null,
            metadata: {
                path: '/tmp/hidden-summary-permission',
                host: 'test-host',
                systemSessionV1: { v: 1, key: 'voice_conversation_retired', hidden: true },
            },
        });
        const source = createSource({ sessions: [canonicalSession] });
        const pendingRenderable = {
            ...source.sessionListRenderablesById[canonicalSession.id]!,
            agentStateVersion: 7,
            hasPendingPermissionRequests: true,
            hasPendingUserActionRequests: false,
            pendingRequestObservedAt: 975,
        };

        const pendingOverview = buildActivityOverviewFromSource({
            source: {
                ...source,
                sessionListRenderablesById: {
                    [canonicalSession.id]: pendingRenderable,
                },
            },
            nowMs: 1_000,
            directActionsEnabled: true,
        });

        expect(pendingOverview.counts.permissionRequired).toBe(1);
        expect(pendingOverview.candidates).toHaveLength(1);
        expect(pendingOverview.candidates[0]).toMatchObject({
            sessionId: canonicalSession.id,
            attentionState: 'permission_required',
            route: `/session/${canonicalSession.id}?serverId=server-a`,
        });
        expect(pendingOverview.candidates[0]!.session.agentState).toBeNull();

        const clearedOverview = buildActivityOverviewFromSource({
            source: {
                ...source,
                sessionListRenderablesById: {
                    [canonicalSession.id]: {
                        ...pendingRenderable,
                        agentStateVersion: 8,
                        hasPendingPermissionRequests: false,
                        pendingRequestObservedAt: null,
                    },
                },
            },
            nowMs: 1_000,
            directActionsEnabled: true,
        });

        expect(clearedOverview.counts.permissionRequired).toBe(0);
        expect(clearedOverview.candidates).toEqual([]);
    });

    it('counts blocked pending delivery as action-required source activity', () => {
        const overview = buildActivityOverviewFromSource({
            source: createSource({
                sessions: [
                    createSessionFixture({
                        id: 'blocked-pending',
                        pendingCount: 1,
                        pendingBlockedCount: 1,
                        updatedAt: 20,
                    }),
                ],
            }),
            nowMs: 1_000,
        });

        expect(overview.counts.actionRequired).toBe(1);
        expect(overview.candidates[0]).toMatchObject({
            sessionId: 'blocked-pending',
            reasons: {
                hasBlockedPendingDelivery: true,
            },
        });
    });

    it('discovers Voice custody from canonical sessions even though hidden sessions are absent from the user-facing index', () => {
        const hiddenPermission = createSessionFixture({
            id: 'hidden-unindexed-permission',
            active: true,
            presence: 'online',
            seq: 2,
            lastViewedSessionSeq: 2,
            pendingPermissionRequestCount: 1,
            pendingRequestObservedAt: 975,
            agentState: pendingAgentState('permission', 975),
            updatedAt: 45,
            serverId: 'server-a',
            metadata: {
                path: '/tmp/hidden-unindexed-permission',
                host: 'test-host',
                systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
            },
        });
        const hiddenLateResult = createSessionFixture({
            id: 'hidden-unindexed-late-result',
            seq: 4,
            latestReadyEventSeq: 4,
            lastViewedSessionSeq: 1,
            updatedAt: 40,
            serverId: 'server-a',
            metadata: {
                path: '/tmp/hidden-unindexed-late-result',
                host: 'test-host',
                systemSessionV1: { v: 1, key: 'voice_conversation_retired', hidden: true },
            },
        });
        const source = createSource({
            sessions: [hiddenPermission, hiddenLateResult],
        });

        const overview = buildActivityOverviewFromSource({
            source: {
                ...source,
                // The canonical session list intentionally excludes hidden system
                // sessions. Activity custody must therefore discover these records
                // from the hydrated canonical session map rather than the list index.
                sessionListIndexByServerId: {
                    'server-a': [],
                },
            },
            nowMs: 1_000,
            directActionsEnabled: true,
        });

        expect(overview.candidates.map((candidate) => candidate.sessionId)).toEqual([
            'hidden-unindexed-permission',
            'hidden-unindexed-late-result',
        ]);
        expect(overview.counts).toMatchObject({
            unread: 1,
            permissionRequired: 1,
            totalAttention: 2,
        });
        expect(overview.candidates[0]).toMatchObject({
            route: '/session/hidden-unindexed-permission?serverId=server-a',
            directActionCapability: { canExecute: true, reason: 'allowed' },
        });
    });

    it('keeps quiet hidden system sessions out while surfacing hidden pending permissions and late results', () => {
        const visible = createSessionFixture({
            id: 'visible-unread',
            seq: 4,
            latestReadyEventSeq: 4,
            lastViewedSessionSeq: 1,
            updatedAt: 30,
        });
        const hidden = createSessionFixture({
            id: 'hidden-late-result',
            seq: 4,
            latestReadyEventSeq: 4,
            lastViewedSessionSeq: 1,
            updatedAt: 40,
            metadata: {
                path: '/tmp/hidden-system',
                host: 'test-host',
                systemSessionV1: { v: 1, key: 'voice_carrier', hidden: true },
            },
        });
        const hiddenPermission = createSessionFixture({
            id: 'hidden-permission',
            active: true,
            presence: 'online',
            seq: 2,
            lastViewedSessionSeq: 2,
            pendingPermissionRequestCount: 1,
            pendingRequestObservedAt: 975,
            agentState: pendingAgentState('permission', 975),
            updatedAt: 45,
            metadata: {
                path: '/tmp/hidden-permission',
                host: 'test-host',
                systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
            },
        });
        const hiddenQuiet = createSessionFixture({
            id: 'hidden-quiet',
            seq: 4,
            lastViewedSessionSeq: 4,
            updatedAt: 35,
            metadata: {
                path: '/tmp/hidden-quiet',
                host: 'test-host',
                systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
            },
        });
        const unrelatedHiddenPermission = createSessionFixture({
            id: 'voice-transcript-history',
            active: true,
            presence: 'online',
            seq: 5,
            latestReadyEventSeq: 5,
            lastViewedSessionSeq: 1,
            pendingPermissionRequestCount: 1,
            pendingRequestObservedAt: 980,
            agentState: pendingAgentState('permission', 980),
            updatedAt: 55,
            metadata: {
                path: '/tmp/voice-transcript-history',
                host: 'test-host',
                systemSessionV1: { v: 1, key: 'voice_transcript_history', hidden: true },
            },
        });
        const unavailable = {
            ...buildSessionListRenderableFromSession(createSessionFixture({
                id: 'metadata-unavailable',
                seq: 4,
                lastViewedSessionSeq: 1,
                updatedAt: 50,
            })),
            metadata: null,
            metadataUnavailable: true,
            hasUnreadMessages: true,
        };

        const overview = buildActivityOverviewFromSource({
            source: {
                ...createSource({ sessions: [visible, hidden, hiddenPermission, hiddenQuiet, unrelatedHiddenPermission] }),
                sessionListRenderablesById: {
                    [visible.id]: buildSessionListRenderableFromSession(visible),
                    [hidden.id]: buildSessionListRenderableFromSession(hidden),
                    [hiddenPermission.id]: buildSessionListRenderableFromSession(hiddenPermission),
                    [hiddenQuiet.id]: buildSessionListRenderableFromSession(hiddenQuiet),
                    [unrelatedHiddenPermission.id]: buildSessionListRenderableFromSession(unrelatedHiddenPermission),
                    [unavailable.id]: unavailable,
                },
                sessionListIndexByServerId: {
                    'server-a': [
                        { type: 'session', sessionId: visible.id, serverId: 'server-a', serverName: 'Server A' },
                        { type: 'session', sessionId: hidden.id, serverId: 'server-a', serverName: 'Server A' },
                        { type: 'session', sessionId: hiddenPermission.id, serverId: 'server-a', serverName: 'Server A' },
                        { type: 'session', sessionId: hiddenQuiet.id, serverId: 'server-a', serverName: 'Server A' },
                        { type: 'session', sessionId: unrelatedHiddenPermission.id, serverId: 'server-a', serverName: 'Server A' },
                        { type: 'session', sessionId: unavailable.id, serverId: 'server-a', serverName: 'Server A' },
                    ],
                },
            },
            nowMs: 1_000,
            directActionsEnabled: true,
        });

        expect(overview.candidates.map((candidate) => candidate.sessionId)).toEqual([
            'hidden-permission',
            'hidden-late-result',
            'visible-unread',
        ]);
        expect(overview.counts).toMatchObject({
            unread: 2,
            permissionRequired: 1,
            totalAttention: 3,
        });
        expect(overview.candidates[0]).toMatchObject({
            sessionId: 'hidden-permission',
            route: '/session/hidden-permission?serverId=server-a',
            target: 'open-session:hidden-permission?serverId=server-a',
            directActionCapability: {
                canExecute: true,
                reason: 'allowed',
            },
        });
    });

    it('keeps permission and late-result custody reachable after a Voice session is retired and attention freshness expires', () => {
        const retiredPermission = createSessionFixture({
            id: 'retired-permission',
            active: true,
            presence: 'online',
            seq: 2,
            lastViewedSessionSeq: 2,
            pendingPermissionRequestCount: 1,
            pendingRequestObservedAt: 975,
            agentState: pendingAgentState('permission', 975),
            updatedAt: 45,
            metadata: {
                path: '/tmp/retired-permission',
                host: 'test-host',
                systemSessionV1: { v: 1, key: 'voice_conversation_retired', hidden: true },
            },
        });
        const retiredLateResult = createSessionFixture({
            id: 'retired-late-result',
            seq: 4,
            latestReadyEventSeq: 4,
            lastViewedSessionSeq: 1,
            updatedAt: 40,
            metadata: {
                path: '/tmp/retired-late-result',
                host: 'test-host',
                systemSessionV1: { v: 1, key: 'voice_conversation_retired', hidden: true },
            },
        });
        const retiredQuiet = createSessionFixture({
            id: 'retired-quiet',
            seq: 4,
            lastViewedSessionSeq: 4,
            updatedAt: 35,
            metadata: {
                path: '/tmp/retired-quiet',
                host: 'test-host',
                systemSessionV1: { v: 1, key: 'voice_conversation_retired', hidden: true },
            },
        });

        const overview = buildActivityOverviewFromSource({
            source: createSource({
                sessions: [retiredPermission, retiredLateResult, retiredQuiet],
            }),
            nowMs: 200_000,
            directActionsEnabled: true,
        });

        expect(overview.candidates.map((candidate) => candidate.sessionId)).toEqual([
            'retired-permission',
            'retired-late-result',
        ]);
        expect(overview.counts).toMatchObject({
            unread: 1,
            permissionRequired: 1,
            totalAttention: 2,
        });
        expect(overview.candidates[0]).toMatchObject({
            route: '/session/retired-permission?serverId=server-a',
            directActionCapability: { canExecute: true, reason: 'allowed' },
        });
    });

    it('builds a stable fingerprint that ignores generated time fields outside visible meaning', () => {
        const source = createSource({
            sessions: [
                createSessionFixture({
                    id: 'permission',
                    pendingPermissionRequestCount: 1,
                    agentState: pendingAgentState('permission'),
                    updatedAt: 20,
                }),
            ],
        });

        const first = buildActivityOverviewFromSource({ source, nowMs: 1_000 });
        const second = buildActivityOverviewFromSource({ source, nowMs: 2_000 });

        expect(buildStableActivityOverviewFingerprint(first)).toBe(buildStableActivityOverviewFingerprint(second));
    });
});
