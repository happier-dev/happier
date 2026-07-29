import { describe, expect, it } from 'vitest';

import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { resolveActivitySurfacePolicy } from '@/activity/attention/resolveActivitySurfacePolicy';

import { resolveLiveActivityReconciliationState } from './resolveLiveActivityReconciliationState';

describe('resolveLiveActivityReconciliationState', () => {
    it('keeps the current dynamic primary within the dwell window while it remains eligible', () => {
        const policy = resolveActivitySurfacePolicy({
            liveActivitiesMode: 'attention',
            liveActivitiesStrategy: 'dynamic_primary',
        });

        const firstPass = resolveLiveActivityReconciliationState({
            sessions: [
                createSessionFixture({
                    id: 'permission',
                    serverId: 'server-a',
                    updatedAt: 20,
                    active: true,
                    presence: 'online',
                    pendingUserActionRequestCount: 1,
                    pendingRequestObservedAt: 950,
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
                    updatedAt: 10,
                    active: true,
                    presence: 'online',
                    pendingUserActionRequestCount: 1,
                    pendingRequestObservedAt: 950,
                    metadata: {
                        path: '/Users/tester/project/action',
                        host: 'tester.local',
                        homeDir: '/Users/tester',
                        summary: { text: 'Action work', updatedAt: 2 },
                    },
                }),
            ],
            policy,
            nowMs: 1_000,
        });

        expect(firstPass.snapshots.map((snapshot) => snapshot.sessionId)).toEqual(['permission']);
        expect(firstPass.preferredPrimaryActivityInstanceKey).toBe('server-a:HappierFocusLiveActivity:permission');

        const withinDwell = resolveLiveActivityReconciliationState({
            sessions: [
                createSessionFixture({
                    id: 'permission',
                    serverId: 'server-a',
                    updatedAt: 25,
                    active: true,
                    presence: 'online',
                    pendingUserActionRequestCount: 1,
                    pendingRequestObservedAt: 30_950,
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
                    updatedAt: 50,
                    active: true,
                    presence: 'online',
                    pendingUserActionRequestCount: 1,
                    pendingRequestObservedAt: 30_950,
                    metadata: {
                        path: '/Users/tester/project/action',
                        host: 'tester.local',
                        homeDir: '/Users/tester',
                        summary: { text: 'Action work', updatedAt: 2 },
                    },
                }),
            ],
            policy,
            currentPreferredPrimaryActivityInstanceKey: firstPass.preferredPrimaryActivityInstanceKey,
            currentPreferredPrimaryChangedAtMs: firstPass.preferredPrimaryChangedAtMs,
            nowMs: 31_000,
        });

        expect(withinDwell.snapshots.map((snapshot) => snapshot.sessionId)).toEqual(['permission']);
        expect(withinDwell.preferredPrimaryChangedAtMs).toBe(firstPass.preferredPrimaryChangedAtMs);

        const afterDwell = resolveLiveActivityReconciliationState({
            sessions: [
                createSessionFixture({
                    id: 'permission',
                    serverId: 'server-a',
                    updatedAt: 25,
                    active: true,
                    presence: 'online',
                    pendingUserActionRequestCount: 1,
                    pendingRequestObservedAt: 121_950,
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
                    updatedAt: 50,
                    active: true,
                    presence: 'online',
                    pendingUserActionRequestCount: 1,
                    pendingRequestObservedAt: 121_950,
                    metadata: {
                        path: '/Users/tester/project/action',
                        host: 'tester.local',
                        homeDir: '/Users/tester',
                        summary: { text: 'Action work', updatedAt: 2 },
                    },
                }),
            ],
            policy,
            currentPreferredPrimaryActivityInstanceKey: firstPass.preferredPrimaryActivityInstanceKey,
            currentPreferredPrimaryChangedAtMs: firstPass.preferredPrimaryChangedAtMs,
            nowMs: 122_000,
        });

        expect(afterDwell.snapshots.map((snapshot) => snapshot.sessionId)).toEqual(['action']);
        expect(afterDwell.preferredPrimaryActivityInstanceKey).toBe('server-a:HappierFocusLiveActivity:action');
        expect(afterDwell.preferredPrimaryChangedAtMs).toBe(122_000);
    });

    it('persists the pinned primary session across reconciliations while it remains eligible', () => {
        const policy = resolveActivitySurfacePolicy({
            liveActivitiesMode: 'attention',
            liveActivitiesStrategy: 'pinned_primary',
            liveActivitiesMaxConcurrent: 2,
        });

        const firstPass = resolveLiveActivityReconciliationState({
            sessions: [
                createSessionFixture({
                    id: 'permission',
                    updatedAt: 20,
                    active: true,
                    presence: 'online',
                    pendingUserActionRequestCount: 1,
                    pendingRequestObservedAt: 950,
                    metadata: {
                        path: '/Users/tester/project/permission',
                        host: 'tester.local',
                        homeDir: '/Users/tester',
                        summary: { text: 'Permission work', updatedAt: 3 },
                    },
                }),
                createSessionFixture({
                    id: 'action',
                    updatedAt: 10,
                    active: true,
                    presence: 'online',
                    pendingUserActionRequestCount: 1,
                    pendingRequestObservedAt: 950,
                    metadata: {
                        path: '/Users/tester/project/action',
                        host: 'tester.local',
                        homeDir: '/Users/tester',
                        summary: { text: 'Action work', updatedAt: 2 },
                    },
                }),
            ],
            policy,
            nowMs: 1_000,
        });

        expect(firstPass.snapshots.map((snapshot) => snapshot.sessionId)).toEqual(['permission']);
        expect(firstPass.preferredPrimarySessionId).toBe('permission');

        const secondPass = resolveLiveActivityReconciliationState({
            sessions: [
                createSessionFixture({
                    id: 'permission',
                    updatedAt: 25,
                    active: true,
                    presence: 'online',
                    pendingUserActionRequestCount: 1,
                    pendingRequestObservedAt: 950,
                    metadata: {
                        path: '/Users/tester/project/permission',
                        host: 'tester.local',
                        homeDir: '/Users/tester',
                        summary: { text: 'Permission work', updatedAt: 3 },
                    },
                }),
                createSessionFixture({
                    id: 'action',
                    updatedAt: 50,
                    active: true,
                    presence: 'online',
                    pendingPermissionRequestCount: 1,
                    pendingRequestObservedAt: 950,
                    metadata: {
                        path: '/Users/tester/project/action',
                        host: 'tester.local',
                        homeDir: '/Users/tester',
                        summary: { text: 'Action work', updatedAt: 2 },
                    },
                }),
            ],
            policy,
            currentPreferredPrimarySessionId: firstPass.preferredPrimarySessionId,
            nowMs: 1_000,
        });

        expect(secondPass.snapshots.map((snapshot) => snapshot.sessionId)).toEqual(['permission']);
        expect(secondPass.preferredPrimarySessionId).toBe('permission');
    });

    it('uses the shared live activity dwell window when deciding whether to hold the dynamic primary', () => {
        const policy = resolveActivitySurfacePolicy({
            liveActivitiesMode: 'attention',
            liveActivitiesStrategy: 'dynamic_primary',
        });

        const firstPass = resolveLiveActivityReconciliationState({
            sessions: [
                createSessionFixture({
                    id: 'permission',
                    serverId: 'server-a',
                    updatedAt: 20,
                    active: true,
                    presence: 'online',
                    pendingPermissionRequestCount: 1,
                    pendingRequestObservedAt: 950,
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
                    updatedAt: 10,
                    active: true,
                    presence: 'online',
                    pendingPermissionRequestCount: 1,
                    pendingRequestObservedAt: 950,
                    metadata: {
                        path: '/Users/tester/project/action',
                        host: 'tester.local',
                        homeDir: '/Users/tester',
                        summary: { text: 'Action work', updatedAt: 2 },
                    },
                }),
            ],
            policy,
            dwellMs: 500,
            nowMs: 1_000,
        });

        const afterSharedDwell = resolveLiveActivityReconciliationState({
            sessions: [
                createSessionFixture({
                    id: 'permission',
                    serverId: 'server-a',
                    updatedAt: 25,
                    active: true,
                    presence: 'online',
                    pendingPermissionRequestCount: 1,
                    pendingRequestObservedAt: 1_550,
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
                    updatedAt: 50,
                    active: true,
                    presence: 'online',
                    pendingPermissionRequestCount: 1,
                    pendingRequestObservedAt: 1_550,
                    metadata: {
                        path: '/Users/tester/project/action',
                        host: 'tester.local',
                        homeDir: '/Users/tester',
                        summary: { text: 'Action work', updatedAt: 2 },
                    },
                }),
            ],
            policy,
            dwellMs: 500,
            currentPreferredPrimaryActivityInstanceKey: firstPass.preferredPrimaryActivityInstanceKey,
            currentPreferredPrimaryChangedAtMs: firstPass.preferredPrimaryChangedAtMs,
            nowMs: 1_600,
        });

        expect(afterSharedDwell.snapshots.map((snapshot) => snapshot.sessionId)).toEqual(['action']);
    });
});
