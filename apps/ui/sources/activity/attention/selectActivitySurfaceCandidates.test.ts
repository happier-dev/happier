import { describe, expect, it } from 'vitest';

import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';

import { buildActivityOverviewSnapshot } from './buildActivityOverviewSnapshot';
import { resolveActivitySurfacePolicy } from './resolveActivitySurfacePolicy';
import { selectActivitySurfaceCandidates } from './selectActivitySurfaceCandidates';

describe('selectActivitySurfaceCandidates', () => {
    it('returns only the highest-priority session in focused live activity mode', () => {
        const overview = buildActivityOverviewSnapshot({
            sessions: [
                createSessionFixture({
                    id: 'unread',
                    seq: 3,
                    lastViewedSessionSeq: 1,
                    metadata: {
                        path: '/Users/tester/project/unread',
                        host: 'tester.local',
                        homeDir: '/Users/tester',
                        summary: { text: 'Unread work', updatedAt: 1 },
                    },
                }),
                createSessionFixture({
                    id: 'permission',
                    active: true,
                    presence: 'online',
                    pendingPermissionRequestCount: 1,
                    metadata: {
                        path: '/Users/tester/project/permission',
                        host: 'tester.local',
                        homeDir: '/Users/tester',
                        summary: { text: 'Permission work', updatedAt: 1 },
                    },
                }),
            ],
        });

        const selected = selectActivitySurfaceCandidates({
            overview,
            surface: 'liveActivities',
            policy: resolveActivitySurfacePolicy({
                liveActivitiesMode: 'focused',
                liveActivitiesMaxConcurrent: 4,
            }),
        });

        expect(selected.map((candidate) => candidate.sessionId)).toEqual(['permission']);
    });

    it('filters live activities to actionable sessions in attention mode and respects the cap', () => {
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
                createSessionFixture({
                    id: 'thinking',
                    active: true,
                    presence: 'online',
                    thinking: true,
                    metadata: {
                        path: '/Users/tester/project/thinking',
                        host: 'tester.local',
                        homeDir: '/Users/tester',
                        summary: { text: 'Thinking work', updatedAt: 1 },
                    },
                }),
            ],
        });

        const selected = selectActivitySurfaceCandidates({
            overview,
            surface: 'liveActivities',
            policy: resolveActivitySurfacePolicy({
                liveActivitiesMode: 'attention',
                liveActivitiesMaxConcurrent: 2,
                liveActivitiesIncludeThinking: false,
            }),
        });

        expect(selected.map((candidate) => candidate.sessionId)).toEqual(['permission', 'action']);
    });

    it('keeps thinking sessions in running mode when thinking is enabled', () => {
        const overview = buildActivityOverviewSnapshot({
            sessions: [
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
                    id: 'permission',
                    active: true,
                    presence: 'online',
                    pendingPermissionRequestCount: 1,
                    metadata: {
                        path: '/Users/tester/project/permission',
                        host: 'tester.local',
                        homeDir: '/Users/tester',
                        summary: { text: 'Permission work', updatedAt: 1 },
                    },
                }),
            ],
        });

        const selected = selectActivitySurfaceCandidates({
            overview,
            surface: 'liveActivities',
            policy: resolveActivitySurfacePolicy({
                liveActivitiesMode: 'running',
                liveActivitiesIncludeThinking: true,
                liveActivitiesMaxConcurrent: 2,
            }),
        });

        expect(selected.map((candidate) => candidate.sessionId)).toEqual(['permission', 'thinking']);
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

        const selected = selectActivitySurfaceCandidates({
            overview,
            surface: 'widgets',
            policy: resolveActivitySurfacePolicy({
                homeScreenWidgetsMode: 'attention',
            }),
        });

        expect(selected.map((candidate) => candidate.sessionId)).toEqual(['permission', 'unread']);
    });
});
