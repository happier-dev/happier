import { afterEach, describe, expect, it } from 'vitest';

import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { buildActivityOverviewSnapshot } from '@/activity/attention/buildActivityOverviewSnapshot';
import { resolveActivitySurfacePolicy } from '@/activity/attention/resolveActivitySurfacePolicy';

import {
    ACTIVITY_SURFACE_SELECTION_IDS,
    createLiveActivitySelectionSpec,
    createWidgetSelectionSpec,
} from './activitySurfaceSelectionTypes';
import { resolveActivitySurfaceSlots } from './resolveActivitySurfaceSlots';
import { sessionRuntimeObservations } from '@/sync/domains/session/sessionRuntimeObservation';
import { projectUiSessionAwareness } from '@/sync/domains/session/awareness/sessionAwareness';

afterEach(() => sessionRuntimeObservations.clear());

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

describe('resolveActivitySurfaceSlots', () => {
    it.each(['runtime', 'content', 'stale'] as const)('keeps dwell recency separate from runtime freshness: %s', (recency) => {
        const now = 1_000_000;
        const previous = createSessionFixture({ id: 'previous-dwell', serverId: 'server-a',
            active: true, activeAt: 1, presence: 'online', thinking: false, thinkingAt: 1,
            updatedAt: recency === 'content' ? now : 1,
            pendingUserActionRequestCount: 1, agentState: pendingAgentState('user_action') });
        const next = createSessionFixture({ id: 'next-dwell', serverId: 'server-a',
            active: true, presence: 'online', updatedAt: now,
            pendingPermissionRequestCount: 1, agentState: pendingAgentState('permission') });
        sessionRuntimeObservations.observe({ serverId: 'server-a', sessionId: previous.id }, {
            active: true, thinking: false, activeAt: recency === 'runtime' ? now : 1, presence: 'online',
        });
        const overview = buildActivityOverviewSnapshot({ sessions: [next, previous], nowMs: now });
        const slots = resolveActivitySurfaceSlots({ overview, nowMs: now,
            previousPrimaryAddress: { serverId: 'server-a', sessionId: previous.id },
            previousPrimaryChangedAtMs: now - 1_000,
            selection: { ...createLiveActivitySelectionSpec(resolveActivitySurfacePolicy({
                liveActivitiesMode: 'attention', liveActivitiesStrategy: 'dynamic_primary',
            })), dwellMs: 90_000, staleAfterMs: 120_000 },
        });
        const expectedPrimary = recency === 'stale' ? next.id : previous.id;
        expect(slots.selectionReason).toBe('dynamic_primary');
        expect(slots.selectedSessions.map((candidate) => candidate.sessionId)).toEqual([expectedPrimary]);
        expect(slots.primarySession?.sessionId).toBe(expectedPrimary);
        expect(projectUiSessionAwareness(previous, now).freshness).toBe(recency === 'runtime' ? 'live' : 'stale');
    });
    it('excludes ready unread sessions from focused live-activity selection when includeReady is disabled', () => {
        const overview = buildActivityOverviewSnapshot({
            sessions: [
                createSessionFixture({
                    id: 'unread',
                    seq: 5,
                    lastViewedSessionSeq: 2,
                    metadata: {
                        path: '/Users/tester/project/unread',
                        host: 'tester.local',
                        homeDir: '/Users/tester',
                        summary: { text: 'Unread work', updatedAt: 3 },
                    },
                }),
                createSessionFixture({
                    id: 'thinking',
                    seq: 1,
                    lastViewedSessionSeq: 1,
                    active: true,
                    presence: 'online',
                    thinking: true,
                    thinkingAt: 950,
                    metadata: {
                        path: '/Users/tester/project/thinking',
                        host: 'tester.local',
                        homeDir: '/Users/tester',
                        summary: { text: 'Thinking work', updatedAt: 2 },
                    },
                }),
            ],
            nowMs: 1_000,
        });

        const slots = resolveActivitySurfaceSlots({
            overview,
            selection: createLiveActivitySelectionSpec(resolveActivitySurfacePolicy({
                liveActivitiesMode: 'focused',
                liveActivitiesIncludeReady: false,
                liveActivitiesIncludeThinking: true,
            })),
        });

        expect(slots.selectedSessions.map((candidate) => candidate.sessionId)).toEqual(['thinking']);
        expect(slots.eligibleSessions.map((candidate) => candidate.sessionId)).toEqual(['thinking']);
    });

    it('keeps only one live activity in dynamic-primary mode and reports overflow', () => {
        const overview = buildActivityOverviewSnapshot({
            sessions: [
                createSessionFixture({
                    id: 'permission',
                    active: true,
                    presence: 'online',
                    pendingPermissionRequestCount: 1,
                    agentState: pendingAgentState('permission'),
                    metadata: {
                        path: '/Users/tester/project/permission',
                        host: 'tester.local',
                        homeDir: '/Users/tester',
                        summary: { text: 'Permission work', updatedAt: 3 },
                    },
                }),
                createSessionFixture({
                    id: 'action',
                    serverId: 'server-a',
                    active: true,
                    presence: 'online',
                    pendingUserActionRequestCount: 1,
                    agentState: pendingAgentState('user_action'),
                    metadata: {
                        path: '/Users/tester/project/action',
                        host: 'tester.local',
                        homeDir: '/Users/tester',
                        summary: { text: 'Action work', updatedAt: 2 },
                    },
                }),
            ],
            nowMs: 1_000,
        });

        const slots = resolveActivitySurfaceSlots({
            overview,
            selection: createLiveActivitySelectionSpec(resolveActivitySurfacePolicy({
                liveActivitiesMode: 'attention',
                liveActivitiesMaxConcurrent: 2,
                liveActivitiesStrategy: 'dynamic_primary',
            })),
        });

        expect(slots.selectionReason).toBe('dynamic_primary');
        expect(slots.selectedSessions.map((candidate) => candidate.sessionId)).toEqual(['permission']);
        expect(slots.overflowCount).toBe(1);
    });

    it('switches the dynamic primary after dwell elapses', () => {
        const overview = buildActivityOverviewSnapshot({
            sessions: [
                createSessionFixture({
                    id: 'permission',
                    active: true,
                    presence: 'online',
                    pendingPermissionRequestCount: 1,
                    agentState: pendingAgentState('permission'),
                    updatedAt: 2_000,
                }),
                createSessionFixture({
                    id: 'action',
                    serverId: 'server-a',
                    active: true,
                    presence: 'online',
                    pendingUserActionRequestCount: 1,
                    agentState: pendingAgentState('user_action'),
                    updatedAt: 1_000,
                }),
            ],
            nowMs: 3_500,
        });
        const params = {
            overview,
            previousPrimaryAddress: { serverId: 'server-a', sessionId: 'action' },
            previousPrimaryChangedAtMs: 2_000,
            nowMs: 3_500,
            selection: {
                ...createLiveActivitySelectionSpec(resolveActivitySurfacePolicy({
                    liveActivitiesMode: 'attention',
                    liveActivitiesStrategy: 'dynamic_primary',
                })),
                dwellMs: 1_000,
                staleAfterMs: 5_000,
            },
        };

        const slots = resolveActivitySurfaceSlots(params);

        expect(slots.selectedSessions.map((candidate) => candidate.sessionId)).toEqual(['permission']);
        expect(slots.primarySession?.sessionId).toBe('permission');
    });

    it('keeps the preferred primary session in focused pinned-primary mode when it is still eligible', () => {
        const overview = buildActivityOverviewSnapshot({
            sessions: [
                createSessionFixture({
                    id: 'permission',
                    active: true,
                    presence: 'online',
                    pendingPermissionRequestCount: 1,
                    agentState: pendingAgentState('permission'),
                    metadata: {
                        path: '/Users/tester/project/permission',
                        host: 'tester.local',
                        homeDir: '/Users/tester',
                        summary: { text: 'Permission work', updatedAt: 3 },
                    },
                }),
                createSessionFixture({
                    id: 'action',
                    serverId: 'server-a',
                    active: true,
                    presence: 'online',
                    pendingUserActionRequestCount: 1,
                    agentState: pendingAgentState('user_action'),
                    metadata: {
                        path: '/Users/tester/project/action',
                        host: 'tester.local',
                        homeDir: '/Users/tester',
                        summary: { text: 'Action work', updatedAt: 2 },
                    },
                }),
            ],
            nowMs: 1_000,
        });

        const slots = resolveActivitySurfaceSlots({
            overview,
            preferredPrimaryAddress: { serverId: 'server-a', sessionId: 'action' },
            selection: createLiveActivitySelectionSpec(resolveActivitySurfacePolicy({
                liveActivitiesMode: 'focused',
                liveActivitiesMaxConcurrent: 2,
                liveActivitiesStrategy: 'pinned_primary',
            })),
        });

        expect(slots.selectionReason).toBe('pinned_primary');
        expect(slots.selectedSessions.map((candidate) => candidate.sessionId)).toEqual(['action']);
        expect(slots.primarySession?.sessionId).toBe('action');
        expect(slots.overflowCount).toBe(1);
    });

    it('filters widget candidates by the configured widget mode', () => {
        const overview = buildActivityOverviewSnapshot({
            sessions: [
                createSessionFixture({
                    id: 'permission',
                    active: true,
                    presence: 'online',
                    pendingPermissionRequestCount: 1,
                    agentState: pendingAgentState('permission'),
                    metadata: {
                        path: '/Users/tester/project/permission',
                        host: 'tester.local',
                        homeDir: '/Users/tester',
                        summary: { text: 'Permission work', updatedAt: 3 },
                    },
                }),
                createSessionFixture({
                    id: 'thinking',
                    seq: 2,
                    lastViewedSessionSeq: 2,
                    active: true,
                    presence: 'online',
                    thinking: true,
                    thinkingAt: 950,
                    metadata: {
                        path: '/Users/tester/project/thinking',
                        host: 'tester.local',
                        homeDir: '/Users/tester',
                        summary: { text: 'Thinking work', updatedAt: 2 },
                    },
                }),
                createSessionFixture({
                    id: 'unread',
                    seq: 4,
                    latestReadyEventSeq: 4,
                    lastViewedSessionSeq: 1,
                    metadata: {
                        path: '/Users/tester/project/unread',
                        host: 'tester.local',
                        homeDir: '/Users/tester',
                        summary: { text: 'Unread work', updatedAt: 1 },
                    },
                }),
            ],
            nowMs: 1_000,
        });

        const slots = resolveActivitySurfaceSlots({
            overview,
            selection: createWidgetSelectionSpec(resolveActivitySurfacePolicy({
                homeScreenWidgetsMode: 'attention',
            })),
        });

        expect(slots.selectionReason).toBe('all_eligible');
        expect(slots.selectedSessions.map((candidate) => candidate.sessionId)).toEqual(['permission', 'unread']);
        expect(slots.primarySession?.sessionId).toBe('permission');
        expect(slots.overflowCount).toBe(0);
    });

    it('can include quiet active sessions without forcing in attention-required sessions', () => {
        const overview = buildActivityOverviewSnapshot({
            sessions: [
                createSessionFixture({
                    id: 'permission',
                    active: true,
                    presence: 'online',
                    pendingPermissionRequestCount: 1,
                    agentState: pendingAgentState('permission'),
                }),
                createSessionFixture({
                    id: 'quiet-active',
                    seq: 2,
                    lastViewedSessionSeq: 2,
                    active: true,
                    presence: 'online',
                    metadata: {
                        path: '/Users/tester/project/quiet-active',
                        host: 'tester.local',
                        homeDir: '/Users/tester',
                        summary: { text: 'Quiet active work', updatedAt: 2 },
                    },
                }),
                createSessionFixture({
                    id: 'quiet-inactive',
                    seq: 1,
                    lastViewedSessionSeq: 1,
                    active: false,
                    presence: 1,
                    metadata: {
                        path: '/Users/tester/project/quiet-inactive',
                        host: 'tester.local',
                        homeDir: '/Users/tester',
                        summary: { text: 'Quiet inactive work', updatedAt: 1 },
                    },
                }),
            ],
            nowMs: 1_000,
        });

        const slots = resolveActivitySurfaceSlots({
            overview,
            selection: {
                surfaceId: ACTIVITY_SURFACE_SELECTION_IDS.desktopOverlay,
                enabled: true,
                mode: 'running',
                selectionReason: 'all_eligible',
                maxSelected: null,
                includeUrgent: false,
                includeReady: false,
                includeThinking: false,
                includeQuietActive: true,
                activeOnly: true,
            },
        });

        expect(slots.selectedSessions.map((candidate) => candidate.sessionId)).toEqual(['quiet-active']);
        expect(slots.primarySession?.sessionId).toBe('quiet-active');
    });
});
