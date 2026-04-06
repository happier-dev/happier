import { describe, expect, it } from 'vitest';

import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { buildActivityOverviewSnapshot } from '@/activity/attention/buildActivityOverviewSnapshot';
import { resolveActivitySurfacePolicy } from '@/activity/attention/resolveActivitySurfacePolicy';

import { createLiveActivitySelectionSpec, createWidgetSelectionSpec } from './activitySurfaceSelectionTypes';
import { resolveActivitySurfaceSlots } from './resolveActivitySurfaceSlots';

describe('resolveActivitySurfaceSlots', () => {
    it('keeps only one live activity in dynamic-primary mode and reports overflow', () => {
        const overview = buildActivityOverviewSnapshot({
            sessions: [
                createSessionFixture({
                    id: 'permission',
                    active: true,
                    presence: 'online',
                    pendingPermissionRequestCount: 1,
                    metadata: {
                        path: '/Users/tester/project/permission',
                        host: 'tester.local',
                        homeDir: '/Users/tester',
                        summary: { text: 'Permission work', updatedAt: 3 },
                    },
                }),
                createSessionFixture({
                    id: 'action',
                    active: true,
                    presence: 'online',
                    pendingUserActionRequestCount: 1,
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

    it('keeps the preferred primary session in focused pinned-primary mode when it is still eligible', () => {
        const overview = buildActivityOverviewSnapshot({
            sessions: [
                createSessionFixture({
                    id: 'permission',
                    active: true,
                    presence: 'online',
                    pendingPermissionRequestCount: 1,
                    metadata: {
                        path: '/Users/tester/project/permission',
                        host: 'tester.local',
                        homeDir: '/Users/tester',
                        summary: { text: 'Permission work', updatedAt: 3 },
                    },
                }),
                createSessionFixture({
                    id: 'action',
                    active: true,
                    presence: 'online',
                    pendingUserActionRequestCount: 1,
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
            preferredPrimarySessionId: 'action',
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
                    metadata: {
                        path: '/Users/tester/project/permission',
                        host: 'tester.local',
                        homeDir: '/Users/tester',
                        summary: { text: 'Permission work', updatedAt: 3 },
                    },
                }),
                createSessionFixture({
                    id: 'thinking',
                    active: true,
                    presence: 'online',
                    thinking: true,
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
                    lastViewedSessionSeq: 1,
                    metadata: {
                        path: '/Users/tester/project/unread',
                        host: 'tester.local',
                        homeDir: '/Users/tester',
                        summary: { text: 'Unread work', updatedAt: 1 },
                    },
                }),
            ],
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
                surfaceId: 'desktop_overlay',
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
