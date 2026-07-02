import { describe, expect, it } from 'vitest';

import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { resolveActivitySurfacePolicy } from '@/activity/attention/resolveActivitySurfacePolicy';

import { resolveIosActivitySurfacePolicies } from '../runtime/resolveIosActivitySurfacePolicies';
import {
    buildLiveActivitySnapshots,
    buildStableLiveActivitySnapshotFingerprint,
    resolveLiveActivitySnapshotFreshness,
} from './buildLiveActivitySnapshots';

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

describe('buildLiveActivitySnapshots', () => {
    it('does not promote ready unread sessions into focused live activities when includeReady is disabled', () => {
        const snapshots = buildLiveActivitySnapshots({
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
            policy: resolveActivitySurfacePolicy({
                liveActivitiesMode: 'focused',
                liveActivitiesIncludeReady: false,
                liveActivitiesIncludeThinking: true,
            }),
            nowMs: 1_000,
        });

        expect(snapshots.map((snapshot) => snapshot.sessionId)).toEqual(['thinking']);
    });

    it('builds one live activity entry per selected session', () => {
        const snapshots = buildLiveActivitySnapshots({
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
                createSessionFixture({
                    id: 'thinking',
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
            policy: resolveActivitySurfacePolicy({
                liveActivitiesMode: 'attention',
                liveActivitiesMaxConcurrent: 2,
                liveActivitiesIncludeThinking: false,
                activitySurfaceTapTarget: 'open_sessions',
                activitySurfacePrivacyMode: 'include_preview',
            }),
            nowMs: 1_000,
        });

        expect(snapshots).toHaveLength(2);
        expect(snapshots.map((snapshot) => snapshot.sessionId)).toEqual(['permission', 'action']);
        expect(snapshots[0]).toMatchObject({
            overflowCount: 0,
            defaultTarget: 'open-inbox',
            previewText: 'Permission work',
        });
        expect(snapshots[1]).toMatchObject({
            overflowCount: 0,
            defaultTarget: 'open-inbox',
            previewText: 'Action work',
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
                    agentState: pendingAgentState('permission'),
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

    it('pins the preferred primary session even in focused mode when pinned-primary strategy is requested', () => {
        const snapshots = buildLiveActivitySnapshots({
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
            policy: resolveActivitySurfacePolicy({
                liveActivitiesMode: 'focused',
                liveActivitiesMaxConcurrent: 2,
                liveActivitiesStrategy: 'pinned_primary',
            }),
            preferredPrimarySessionId: 'action',
            nowMs: 1_000,
        });

        expect(snapshots.map((snapshot) => snapshot.sessionId)).toEqual(['action']);
        expect(snapshots[0]?.overflowCount).toBe(1);
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

    it('drops live-activity preview text when previews are disabled while preserving status text', () => {
        const snapshots = buildLiveActivitySnapshots({
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
                        summary: { text: 'Need your approval', updatedAt: 3 },
                    },
                }),
            ],
            policy: resolveActivitySurfacePolicy({
                activitySurfacePrivacyMode: 'include_preview',
                liveActivitiesShowPreviewText: false,
            }),
            nowMs: 1_000,
        });

        expect(snapshots[0]?.previewText).toBeNull();
        expect(snapshots[0]?.statusText).toBeTruthy();
    });

    it('adds a stale timestamp to live activity snapshots', () => {
        const snapshots = buildLiveActivitySnapshots({
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
            ],
            policy: resolveActivitySurfacePolicy({}),
            nowMs: 1_000,
        });

        expect(snapshots[0]?.staleAt).toBe(1_801_000);
    });

    it('uses the shared live activity stale window for snapshot stale timestamps', () => {
        const snapshots = buildLiveActivitySnapshots({
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
            ],
            policy: resolveActivitySurfacePolicy({}),
            staleAfterMs: 60_000,
            nowMs: 1_000,
        });

        expect(snapshots[0]?.staleAt).toBe(61_000);
    });

    it('uses status-only privacy for lock-screen live activity snapshots by default', () => {
        const { liveActivityPolicy } = resolveIosActivitySurfacePolicies({
            localSettings: {},
        });
        const snapshots = buildLiveActivitySnapshots({
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
            ],
            policy: liveActivityPolicy,
            nowMs: 1_000,
        });

        expect(snapshots[0]?.title).not.toBe('Permission work');
        expect(snapshots[0]?.previewText).toBeNull();
        expect(snapshots[0]?.statusText).toBeNull();
    });

    it('keeps private E2EE transcript details out of remote Live Activity snapshots', () => {
        const privateTranscriptSummary = 'SECRET_E2EE_APPROVAL_CONTEXT';
        const { liveActivityPolicy } = resolveIosActivitySurfacePolicies({
            localSettings: {
                activitySurfacePrivacyMode: 'status_only',
                liveActivitiesShowPreviewText: true,
            },
        });
        const snapshots = buildLiveActivitySnapshots({
            sessions: [
                createSessionFixture({
                    id: 'private-session',
                    active: true,
                    presence: 'online',
                    pendingPermissionRequestCount: 1,
                    agentState: pendingAgentState('permission'),
                    metadata: {
                        path: '/Users/tester/project/private',
                        host: 'tester.local',
                        homeDir: '/Users/tester',
                        summary: { text: privateTranscriptSummary, updatedAt: 3 },
                    },
                }),
            ],
            policy: liveActivityPolicy,
            nowMs: 1_000,
        });

        expect(JSON.stringify(snapshots)).not.toContain(privateTranscriptSummary);
        expect(snapshots[0]?.previewText).toBeNull();
        expect(snapshots[0]?.statusText).toBeNull();
    });

    it('classifies snapshots as stale only after their stale timestamp has elapsed', () => {
        const snapshot = buildLiveActivitySnapshots({
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
            ],
            policy: resolveActivitySurfacePolicy({}),
            nowMs: 1_000,
        })[0]!;

        expect(resolveLiveActivitySnapshotFreshness(snapshot, 1_800_999)).toBe('fresh');
        expect(resolveLiveActivitySnapshotFreshness(snapshot, 1_801_000)).toBe('stale');
    });

    it('classifies quiet and urgent snapshots with the Live Activity template metadata', () => {
        const snapshots = buildLiveActivitySnapshots({
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
            policy: resolveActivitySurfacePolicy({
                liveActivitiesMode: 'running',
                liveActivitiesStrategy: 'session_specific',
                liveActivitiesMaxConcurrent: 2,
                liveActivitiesIncludeThinking: true,
            }),
            nowMs: 1_000,
        });

        expect(snapshots.map((snapshot) => ({
            sessionId: snapshot.sessionId,
            presentationTemplate: snapshot.presentationTemplate,
            apnsPriority: snapshot.apnsPriority,
            relevanceScore: snapshot.relevanceScore,
        }))).toEqual([
            {
                sessionId: 'permission',
                presentationTemplate: 'urgentAttention',
                apnsPriority: 10,
                relevanceScore: 100,
            },
            {
                sessionId: 'thinking',
                presentationTemplate: 'quietFocus',
                apnsPriority: 5,
                relevanceScore: 50,
            },
        ]);
    });

    it('includes a server-scoped live activity identity key', () => {
        const snapshots = buildLiveActivitySnapshots({
            sessions: [
                createSessionFixture({
                    id: 'permission',
                    serverId: 'server-a',
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
            ],
            policy: resolveActivitySurfacePolicy({}),
            nowMs: 1_000,
        });

        expect(snapshots[0]).toMatchObject({
            serverId: 'server-a',
            activityName: 'HappierFocusLiveActivity',
            activityInstanceKey: 'server-a:HappierFocusLiveActivity:permission',
            defaultTarget: 'open-session:permission?serverId=server-a',
            sessionTarget: 'open-session:permission?serverId=server-a',
        });
    });

    it('builds a stable fingerprint that ignores generated time', () => {
        const session = createSessionFixture({
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
        });
        const first = buildLiveActivitySnapshots({
            sessions: [session],
            policy: resolveActivitySurfacePolicy({}),
            nowMs: 1_000,
        });
        const second = buildLiveActivitySnapshots({
            sessions: [session],
            policy: resolveActivitySurfacePolicy({}),
            nowMs: 2_000,
        });

        expect(buildStableLiveActivitySnapshotFingerprint(first[0]!))
            .toBe(buildStableLiveActivitySnapshotFingerprint(second[0]!));
    });
});
