import { describe, expect, it } from 'vitest';

import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { resolveActivitySurfacePolicy } from '@/activity/attention/resolveActivitySurfacePolicy';

import { buildLiveActivitySnapshots } from './buildLiveActivitySnapshots';

describe('buildLiveActivitySnapshots', () => {
    it('builds one live activity entry per selected session', () => {
        const snapshots = buildLiveActivitySnapshots({
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
            policy: resolveActivitySurfacePolicy({
                liveActivitiesMode: 'attention',
                liveActivitiesMaxConcurrent: 2,
                liveActivitiesIncludeThinking: false,
                activitySurfaceTapTarget: 'open_sessions',
            }),
            nowMs: 1_000,
        });

        expect(snapshots).toHaveLength(2);
        expect(snapshots.map((snapshot) => snapshot.sessionId)).toEqual(['permission', 'action']);
        expect(snapshots[0]).toMatchObject({
            overflowCount: 0,
            defaultTarget: 'open-inbox',
        });
        expect(snapshots[1]).toMatchObject({
            overflowCount: 0,
            defaultTarget: 'open-inbox',
        });
    });

    it('carries the action-button preference into the live activity snapshot', () => {
        const snapshots = buildLiveActivitySnapshots({
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
            ],
            policy: resolveActivitySurfacePolicy({
                liveActivitiesAllowActionButtons: false,
            }),
            nowMs: 1_000,
        });

        expect(snapshots[0]).toMatchObject({
            allowActionButtons: false,
        });
    });

    it('uses the provided clock for the rendered session status text', () => {
        const snapshots = buildLiveActivitySnapshots({
            sessions: [
                createSessionFixture({
                    id: 'thinking',
                    active: true,
                    presence: 'online',
                    thinkingGraceUntil: 1_500,
                    metadata: {
                        path: '/Users/tester/project/thinking',
                        host: 'tester.local',
                        homeDir: '/Users/tester',
                        summary: { text: 'Thinking work', updatedAt: 3 },
                    },
                }),
            ],
            policy: resolveActivitySurfacePolicy({
                liveActivitiesMode: 'running',
                liveActivitiesIncludeThinking: true,
                liveActivitiesIncludeReady: false,
            }),
            nowMs: 1_000,
        });

        expect(snapshots[0]?.statusText).not.toBe('online');
    });
});
