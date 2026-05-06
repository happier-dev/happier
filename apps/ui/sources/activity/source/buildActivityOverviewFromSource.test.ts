import { describe, expect, it } from 'vitest';

import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';

import { buildActivityOverviewFromSource, buildStableActivityOverviewFingerprint } from './buildActivityOverviewFromSource';
import type { ActivityAttentionSource } from './activityAttentionSourceTypes';

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
            seq: 1,
            lastViewedSessionSeq: 1,
            pendingPermissionRequestCount: 1,
            updatedAt: 20,
        });
        const thinking = createSessionFixture({
            id: 'thinking',
            seq: 2,
            lastViewedSessionSeq: 2,
            thinking: true,
            updatedAt: 30,
        });
        const unread = createSessionFixture({
            id: 'unread',
            seq: 12,
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

    it('builds a stable fingerprint that ignores generated time fields outside visible meaning', () => {
        const source = createSource({
            sessions: [
                createSessionFixture({
                    id: 'permission',
                    pendingPermissionRequestCount: 1,
                    updatedAt: 20,
                }),
            ],
        });

        const first = buildActivityOverviewFromSource({ source, nowMs: 1_000 });
        const second = buildActivityOverviewFromSource({ source, nowMs: 2_000 });

        expect(buildStableActivityOverviewFingerprint(first)).toBe(buildStableActivityOverviewFingerprint(second));
    });
});
