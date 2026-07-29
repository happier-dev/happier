import { describe, expect, it } from 'vitest';

import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { resolveActivitySurfacePolicy } from '@/activity/attention/resolveActivitySurfacePolicy';

import { buildActivitySurfaceSnapshot } from './activitySurfaceSnapshot';

describe('buildActivitySurfaceSnapshot', () => {
    it('selects the highest-priority session as the focus candidate and preserves overview counts', () => {
        const snapshot = buildActivitySurfaceSnapshot({
            sessions: [
                createSessionFixture({
                    id: 'unread',
                    seq: 5,
                    latestReadyEventSeq: 5,
                    lastViewedSessionSeq: 2,
                    metadata: {
                        path: '/Users/tester/project/unread',
                        host: 'tester.local',
                        homeDir: '/Users/tester',
                        summary: { text: 'Unread work', updatedAt: 1 },
                    },
                }),
                createSessionFixture({
                    id: 'permission',
                    seq: 10,
                    lastViewedSessionSeq: 10,
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
                                createdAt: 950,
                            },
                        },
                    },
                    metadata: {
                        path: '/Users/tester/project/permission',
                        host: 'tester.local',
                        homeDir: '/Users/tester',
                        summary: { text: 'Permission work', updatedAt: 1 },
                    },
                }),
                createSessionFixture({
                    id: 'thinking',
                    seq: 11,
                    lastViewedSessionSeq: 11,
                    active: true,
                    presence: 'online',
                    thinking: true,
                    thinkingAt: 950,
                    metadata: {
                        path: '/Users/tester/project/thinking',
                        host: 'tester.local',
                        homeDir: '/Users/tester',
                        summary: { text: 'Thinking work', updatedAt: 1 },
                    },
                }),
            ],
            policy: resolveActivitySurfacePolicy({}),
            nowMs: 1_000,
        });

        expect(snapshot.version).toBe(1);
        expect(snapshot.primary?.sessionId).toBe('permission');
        expect(snapshot.primary?.title).toBe('Permission work');
        expect(snapshot.primary?.attentionState).toBe('permission_required');
        expect(snapshot.sessions.map((entry) => entry.sessionId)).toEqual([
            'permission',
            'thinking',
            'unread',
        ]);
        expect(snapshot.counts).toMatchObject({
            unread: 1,
            permissionRequired: 1,
            actionRequired: 0,
            queuedInput: 0,
            thinking: 1,
            totalAttention: 3,
        });
        expect(snapshot.summaryCounts).toEqual({
            attentionCount: 3,
            runningCount: 1,
            permissionCount: 1,
        });
    });

    it('returns an empty primary candidate when there are no sessions', () => {
        const snapshot = buildActivitySurfaceSnapshot({
            sessions: [],
            policy: resolveActivitySurfacePolicy({}),
            nowMs: 1_000,
        });

        expect(snapshot.primary).toBeNull();
        expect(snapshot.sessions).toEqual([]);
        expect(snapshot.counts).toMatchObject({
            unread: 0,
            permissionRequired: 0,
            actionRequired: 0,
            queuedInput: 0,
            thinking: 0,
            totalAttention: 0,
        });
    });

    it('filters widget sessions by the configured widget mode and hides machine paths when disabled', () => {
        const snapshot = buildActivitySurfaceSnapshot({
            sessions: [
                createSessionFixture({
                    id: 'permission',
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
                                createdAt: 950,
                            },
                        },
                    },
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
                    lastViewedSessionSeq: 1,
                    thinking: false,
                    metadata: {
                        path: '/Users/tester/project/thinking',
                        host: 'tester.local',
                        homeDir: '/Users/tester',
                        summary: { text: 'Thinking work', updatedAt: 2 },
                    },
                }),
            ],
            policy: resolveActivitySurfacePolicy({
                homeScreenWidgetsMode: 'attention',
                homeScreenWidgetsShowMachinePath: false,
            }),
            nowMs: 1_000,
        });

        expect(snapshot.sessions.map((entry) => entry.sessionId)).toEqual(['permission']);
        expect(snapshot.primary?.subtitle).toBeNull();
    });

    it('removes preview text from widget snapshots when previews are disabled but keeps status text', () => {
        const snapshot = buildActivitySurfaceSnapshot({
            sessions: [
                createSessionFixture({
                    id: 'permission',
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
                                createdAt: 950,
                            },
                        },
                    },
                    metadata: {
                        path: '/Users/tester/project/permission',
                        host: 'tester.local',
                        homeDir: '/Users/tester',
                        summary: { text: 'Need your approval', updatedAt: 3 },
                    },
                }),
            ],
            policy: resolveActivitySurfacePolicy({
                activitySurfacePrivacyMode: 'include_preview',
                homeScreenWidgetsShowPreviewText: false,
            }),
            nowMs: 1_000,
        });

        expect(snapshot.primary?.previewText).toBeNull();
        expect(snapshot.primary?.statusText).toBeTruthy();
    });

    it('routes widget default taps to inbox when the shared tap target is configured for the sessions list', () => {
        const snapshot = buildActivitySurfaceSnapshot({
            sessions: [
                createSessionFixture({
                    id: 'permission',
                    active: true,
                    presence: 'online',
                    pendingPermissionRequestCount: 1,
                    pendingRequestObservedAt: 950,
                    metadata: {
                        path: '/Users/tester/project/permission',
                        host: 'tester.local',
                        homeDir: '/Users/tester',
                        summary: { text: 'Need your approval', updatedAt: 3 },
                    },
                }),
            ],
            policy: resolveActivitySurfacePolicy({
                activitySurfaceTapTarget: 'open_sessions',
            }),
            nowMs: 1_000,
        });

        expect(snapshot.defaultTarget).toBe('open-inbox');
        expect(snapshot.primary?.target).toBe('open-session:permission');
    });
});
