import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react-test-renderer';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { useLocalActivityBadgeSnapshot } from '@/activity/badges/useLocalActivityBadgeSnapshot';
import { useProjects, useSession, useSessionListViewData } from '@/sync/domains/state/storage';
import { storage } from '@/sync/domains/state/storageStore';
import type { Session } from '@/sync/domains/state/storageTypes';
import { deriveSessionInputReadinessState } from '@/sync/domains/session/control/deriveSessionInputReadinessState';
import {
    deriveLatestPendingRequestObservedAtFromSession,
    derivePendingRequestFlagsFromSession,
} from '@/sync/domains/session/pending/listPendingSessionRequests';

const SESSION_ID = 's_apply_nested';

function createSession(overrides: Partial<Session> = {}): Session {
    return {
        id: SESSION_ID,
        seq: 1,
        encryptionMode: 'plain',
        createdAt: 1_000,
        updatedAt: 1_000,
        active: true,
        activeAt: 1_000,
        thinking: true,
        thinkingAt: 1_000,
        presence: 'online',
        latestTurnStatus: 'in_progress',
        latestTurnStatusObservedAt: 1_000,
        accessLevel: 'edit',
        canApprovePermissions: true,
        metadataVersion: 1,
        agentStateVersion: 1,
        metadata: { path: '/tmp/repo', host: 'localhost', machineId: 'm1' },
        agentState: {},
        ...overrides,
    } as Session;
}

function resolveAuthSwitchDisabledReason(session: Session, nowMs: number): 'active_turn' | null {
    const pendingFlags = derivePendingRequestFlagsFromSession(session);
    const inputReadiness = deriveSessionInputReadinessState({
        active: session.active,
        activeAt: session.activeAt,
        presence: session.presence,
        thinking: session.thinking,
        thinkingAt: session.thinkingAt,
        latestTurnStatus: session.latestTurnStatus,
        latestTurnStatusObservedAt: session.latestTurnStatusObservedAt,
        hasPendingPermissionRequests: pendingFlags.hasPendingPermissionRequests,
        hasPendingUserActionRequests: pendingFlags.hasPendingUserActionRequests,
        pendingRequestObservedAt: deriveLatestPendingRequestObservedAtFromSession(session),
    }, nowMs);
    return inputReadiness.isInputBusy ? 'active_turn' : null;
}

afterEach(() => {
    standardCleanup();
});

describe('applySessions nested React updates', () => {
    it('does not exceed React nested update depth on repeated socket heartbeats', async () => {
        const previousState = storage.getState();
        try {
            const observedAt = Date.now();
            storage.getState().applySessions([createSession({
                updatedAt: observedAt,
                activeAt: observedAt,
                thinkingAt: observedAt,
                latestTurnStatusObservedAt: observedAt,
            })]);

            const hook = await renderHook(() => {
                useLocalActivityBadgeSnapshot({
                    badgesEnabled: true,
                    friendRequestCount: 0,
                    hasNonNumericInboxAttention: false,
                    sessionOptions: {
                        showUnread: true,
                        showPendingPermissionRequests: true,
                        showPendingUserActionRequests: true,
                    },
                });
                useSessionListViewData();
                useProjects();
                useSession(SESSION_ID);
                // Production SessionView used Date.now() inside the zustand snapshot.
                return storage((state) => {
                    const session = state.sessions[SESSION_ID];
                    if (!session) return null;
                    return resolveAuthSwitchDisabledReason(session, Date.now());
                });
            }, {
                flushOptions: { cycles: 1, turns: 4 },
            });

            await act(async () => {
                for (let index = 0; index < 60; index += 1) {
                    const activeAt = observedAt + index;
                    storage.getState().applySessions([createSession({
                        updatedAt: activeAt,
                        activeAt,
                        thinkingAt: activeAt,
                        latestTurnStatusObservedAt: activeAt,
                    })]);
                }
            });

            expect(hook.getCurrent()).toBe('active_turn');
            await hook.unmount();
        } finally {
            storage.setState(previousState, true);
        }
    });
});
