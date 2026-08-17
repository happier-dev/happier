import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderHook } from '@/dev/testkit';
import type { Session } from '@/sync/domains/state/storageTypes';
import { storage } from '@/sync/domains/state/storageStore';
import { getSessionStatus, shouldShowAbortButtonForSessionState } from '@/utils/sessions/sessionUtils';

import {
    buildSessionViewShellSessionSignature,
    selectSessionViewShellSessionForRouteState,
    useSessionViewShellSession,
    useSessionViewShellSessionSeq,
} from './sessionViewStableSession';
import { useSessionRuntimeStatusSource } from './useSessionRuntimeStatusSource';

const stableContextSnapshot = {
    v: 1 as const,
    modelId: 'gpt-5.6-sol',
    usedTokens: 8,
    windowTokens: 258_400,
    totalProcessedTokens: 3,
    baselineTokens: null,
    isAutoCompactEnabled: null,
    categories: null,
    observedAtMs: 1,
    source: 'provider_turn' as const,
};

vi.mock('@/sync/domains/server/serverProfiles', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/sync/domains/server/serverProfiles')>();
    return {
        ...original,
        areServerProfileIdentifiersEquivalent: (leftRaw: string | null | undefined, rightRaw: string | null | undefined) => {
            const left = String(leftRaw ?? '').trim();
            const right = String(rightRaw ?? '').trim();
            if (!left || !right) return false;
            if (left === right) return true;
            return [left, right].sort().join('\u0000') === ['server-actual', 'server-alias'].sort().join('\u0000');
        },
    };
});

function createSession(overrides: Partial<Session> = {}): Session {
    return {
        id: 's1',
        seq: 25,
        createdAt: 1,
        updatedAt: 100,
        active: true,
        activeAt: 100,
        thinking: true,
        thinkingAt: 100,
        presence: 'online',
        accessLevel: 'edit',
        canApprovePermissions: true,
        pendingVersion: 1,
        metadataVersion: 1,
        agentStateVersion: 1,
        latestUsage: {
            inputTokens: 1,
            outputTokens: 2,
        },
        metadata: {
            name: 'Session',
            path: '/repo',
            homeDir: '/Users/leeroy',
            host: 'mac',
            machineId: 'machine-1',
            flavor: 'codex',
            version: '0.0.0',
        },
        agentState: {},
        ...overrides,
    } as Session;
}

describe('buildSessionViewShellSessionSignature', () => {
    it('stays stable for timestamp-only session heartbeats', () => {
        const base = createSession({
            latestUsage: {
                inputTokens: 1,
                outputTokens: 2,
                cacheCreation: 0,
                cacheRead: 0,
                contextSize: 8,
                contextSnapshot: stableContextSnapshot,
                contextSnapshotStale: false,
                timestamp: 100,
            },
        });
        const heartbeat = createSession({
            updatedAt: 200,
            activeAt: 200,
            thinkingAt: 200,
            latestTurnStatusObservedAt: 200,
            latestUsage: {
                inputTokens: 1,
                outputTokens: 2,
                cacheCreation: 0,
                cacheRead: 0,
                contextSize: 8,
                contextSnapshot: stableContextSnapshot,
                contextSnapshotStale: false,
                timestamp: 200,
            },
        });

        expect(buildSessionViewShellSessionSignature(heartbeat)).toBe(buildSessionViewShellSessionSignature(base));
    });

    it('stays stable for transcript seq-only streaming updates after transcript history exists', () => {
        const base = createSession({ seq: 25 });
        const nextToken = createSession({ seq: 26 });

        expect(buildSessionViewShellSessionSignature(nextToken)).toBe(buildSessionViewShellSessionSignature(base));
    });

    it('changes when the session first gains transcript history', () => {
        const empty = createSession({ seq: 0 });
        const firstRecord = createSession({ seq: 1 });

        expect(buildSessionViewShellSessionSignature(firstRecord)).not.toBe(
            buildSessionViewShellSessionSignature(empty),
        );
    });

    it('stays stable for value-equivalent rollback eligibility arrays', () => {
        const base = createSession({ rollbackEligibleTurnStarts: [3, 1] });
        const refreshed = createSession({ rollbackEligibleTurnStarts: [1, 3, 3] });

        expect(buildSessionViewShellSessionSignature(refreshed)).toBe(
            buildSessionViewShellSessionSignature(base),
        );
    });

    it('changes when rollback eligibility changes', () => {
        const base = createSession({ rollbackEligibleTurnStarts: [1] });
        const changedEligibility = createSession({ rollbackEligibleTurnStarts: [1, 3] });

        const baseSignature = buildSessionViewShellSessionSignature(base);
        expect(buildSessionViewShellSessionSignature(changedEligibility)).not.toBe(baseSignature);
    });

    it('changes when pending request details hydrate at the same agent state version', () => {
        const projectedOnly = createSession({
            agentState: null,
            agentStateVersion: 6,
            pendingPermissionRequestCount: 1,
        });
        const hydrated = createSession({
            agentStateVersion: 6,
            pendingPermissionRequestCount: 1,
            agentState: {
                requests: {
                    req_1: {
                        tool: 'Bash',
                        kind: 'permission',
                        arguments: { command: 'pwd' },
                        createdAt: 10,
                    },
                },
            },
        });

        expect(buildSessionViewShellSessionSignature(hydrated)).not.toBe(
            buildSessionViewShellSessionSignature(projectedOnly),
        );
    });

    it('stays stable for pending request notification-only updates', () => {
        const base = createSession({
            agentStateVersion: 6,
            pendingPermissionRequestCount: 1,
            agentState: {
                requests: {
                    req_1: {
                        tool: 'Bash',
                        kind: 'permission',
                        arguments: { command: 'pwd' },
                        createdAt: 10,
                    },
                },
            },
        });
        const notified = createSession({
            agentStateVersion: 6,
            pendingPermissionRequestCount: 1,
            agentState: {
                requests: {
                    req_1: {
                        tool: 'Bash',
                        kind: 'permission',
                        arguments: { command: 'pwd' },
                        createdAt: 10,
                        pushNotifiedAt: 20,
                    },
                },
            },
        });

        expect(buildSessionViewShellSessionSignature(notified)).toBe(
            buildSessionViewShellSessionSignature(base),
        );
    });

    it('changes when pending request freshness timestamp changes', () => {
        const base = createSession({
            pendingUserActionRequestCount: 1,
            pendingRequestObservedAt: 1_000,
        });
        const refreshed = createSession({
            pendingUserActionRequestCount: 1,
            pendingRequestObservedAt: 5_000,
        });

        expect(buildSessionViewShellSessionSignature(refreshed)).not.toBe(
            buildSessionViewShellSessionSignature(base),
        );
    });

    it('stays stable for read-cursor-only updates while viewing the session', () => {
        const base = createSession({
            lastViewedSessionSeq: 25,
            metadata: {
                name: 'Session',
                path: '/repo',
                homeDir: '/Users/leeroy',
                host: 'mac',
                machineId: 'machine-1',
                flavor: 'codex',
                version: '0.0.0',
                readStateV1: {
                    v: 1,
                    sessionSeq: 25,
                    pendingActivityAt: 0,
                    updatedAt: 100,
                },
            },
        });
        const readCursorHeartbeat = createSession({
            lastViewedSessionSeq: 26,
            metadataVersion: 2,
            metadata: {
                name: 'Session',
                path: '/repo',
                homeDir: '/Users/leeroy',
                host: 'mac',
                machineId: 'machine-1',
                flavor: 'codex',
                version: '0.0.0',
                readStateV1: {
                    v: 1,
                    sessionSeq: 26,
                    pendingActivityAt: 0,
                    updatedAt: 200,
                },
            },
        });

        expect(buildSessionViewShellSessionSignature(readCursorHeartbeat)).toBe(
            buildSessionViewShellSessionSignature(base),
        );
    });

    it('stays stable for metadata freshness-only updates', () => {
        const createFreshMetadata = (updatedAt: number): NonNullable<Session['metadata']> => ({
            name: 'Session',
            path: '/repo',
            homeDir: '/Users/leeroy',
            host: 'mac',
            machineId: 'machine-1',
            flavor: 'codex',
            version: '0.0.0',
            summary: { text: 'Summary', updatedAt },
            sessionModesV1: {
                v: 1,
                agentId: 'codex',
                updatedAt,
                currentModeId: 'default',
                availableModes: [{ id: 'default', name: 'Default' }],
            },
            sessionModelsV1: {
                v: 1,
                agentId: 'codex',
                updatedAt,
                currentModelId: 'model-a',
                availableModels: [{ id: 'model-a', name: 'Model A' }],
            },
            sessionConfigOptionsV1: {
                v: 1,
                agentId: 'codex',
                updatedAt,
                configOptions: [{ id: 'effort', name: 'Effort', type: 'string', currentValue: 'low' }],
            },
            acpConfiguredBackendV1: {
                v: 1,
                updatedAt,
                backendId: 'appServer',
                title: 'App Server',
            },
        });
        const base = createSession({ metadata: createFreshMetadata(100) });
        const refreshed = createSession({ metadataVersion: 2, metadata: createFreshMetadata(200) });

        expect(buildSessionViewShellSessionSignature(refreshed)).toBe(
            buildSessionViewShellSessionSignature(base),
        );
    });

    it('changes when permission mode timestamp changes', () => {
        const base = createSession({
            metadata: {
                name: 'Session',
                path: '/repo',
                homeDir: '/Users/leeroy',
                host: 'mac',
                machineId: 'machine-1',
                flavor: 'codex',
                permissionMode: 'yolo',
                permissionModeUpdatedAt: 100,
            },
        });
        const refreshedPermissionMode = createSession({
            metadataVersion: 2,
            metadata: {
                name: 'Session',
                path: '/repo',
                homeDir: '/Users/leeroy',
                host: 'mac',
                machineId: 'machine-1',
                flavor: 'codex',
                permissionMode: 'yolo',
                permissionModeUpdatedAt: 200,
            },
        });

        expect(buildSessionViewShellSessionSignature(refreshedPermissionMode)).not.toBe(
            buildSessionViewShellSessionSignature(base),
        );
    });

    it('changes when shell-visible metadata values change', () => {
        const base = createSession({
            metadata: {
                name: 'Session',
                path: '/repo',
                homeDir: '/Users/leeroy',
                host: 'mac',
                machineId: 'machine-1',
                flavor: 'codex',
                sessionModesV1: {
                    v: 1,
                    agentId: 'codex',
                    updatedAt: 100,
                    currentModeId: 'default',
                    availableModes: [{ id: 'default', name: 'Default' }],
                },
            },
        });
        const changedMode = createSession({
            metadata: {
                name: 'Session',
                path: '/repo',
                homeDir: '/Users/leeroy',
                host: 'mac',
                machineId: 'machine-1',
                flavor: 'codex',
                sessionModesV1: {
                    v: 1,
                    agentId: 'codex',
                    updatedAt: 200,
                    currentModeId: 'plan',
                    availableModes: [
                        { id: 'default', name: 'Default' },
                        { id: 'plan', name: 'Plan' },
                    ],
                },
            },
        });

        expect(buildSessionViewShellSessionSignature(changedMode)).not.toBe(
            buildSessionViewShellSessionSignature(base),
        );
    });

    it('changes when shell-visible session data changes', () => {
        const base = createSession();
        const renamed = createSession({
            metadata: {
                ...base.metadata,
                path: base.metadata?.path ?? '/repo',
                host: base.metadata?.host ?? 'mac',
                name: 'Renamed',
            },
        });

        expect(buildSessionViewShellSessionSignature(renamed)).not.toBe(buildSessionViewShellSessionSignature(base));
    });

    it('changes when layout-v1 owner metadata changes while shared metadata stays stable', () => {
        const sharedMetadata = {
            v: 1,
            summary: {
                text: 'Shared title',
                updatedAt: 1,
            },
        } as never;
        const base = createSession({
            metadataLayoutVersion: 1,
            metadata: sharedMetadata,
            ownerMetadataView: {
                path: '/private/one',
                host: 'private-host',
                machineId: 'private-machine',
            },
        });
        const changedOwnerView = createSession({
            metadataLayoutVersion: 1,
            metadata: sharedMetadata,
            ownerMetadataView: {
                path: '/private/two',
                host: 'private-host',
                machineId: 'private-machine',
            },
        });

        expect(buildSessionViewShellSessionSignature(changedOwnerView)).not.toBe(
            buildSessionViewShellSessionSignature(base),
        );
    });

    it('changes when layout-v1 participant shared metadata changes without an owner view', () => {
        const base = createSession({
            metadataLayoutVersion: 1,
            accessLevel: 'view',
            metadata: {
                v: 1,
                summary: {
                    text: 'Shared title one',
                    updatedAt: 1,
                },
            } as never,
            ownerMetadataView: null,
        });
        const changedSharedMetadata = createSession({
            metadataLayoutVersion: 1,
            accessLevel: 'view',
            metadata: {
                v: 1,
                summary: {
                    text: 'Shared title two',
                    updatedAt: 2,
                },
            } as never,
            ownerMetadataView: null,
        });

        expect(buildSessionViewShellSessionSignature(changedSharedMetadata)).not.toBe(
            buildSessionViewShellSessionSignature(base),
        );
    });

    it.each([
        ['currentStorageState', 'snapshot_complete'],
        ['acceptedThroughServerSeq', 12],
        ['publishedThroughServerSeq', 12],
        ['materializedThroughSourceAt', 1_000],
        ['transcriptShareable', true],
    ] as const)('changes when transcript authority fact %s changes', (field, value) => {
        const base = createSession({
            currentStorageState: 'machine_only',
            acceptedThroughServerSeq: null,
            publishedThroughServerSeq: null,
            materializedThroughSourceAt: null,
            transcriptShareable: false,
        });
        const changed = createSession({
            currentStorageState: 'machine_only',
            acceptedThroughServerSeq: null,
            publishedThroughServerSeq: null,
            materializedThroughSourceAt: null,
            transcriptShareable: false,
            [field]: value,
        });

        expect(buildSessionViewShellSessionSignature(changed)).not.toBe(
            buildSessionViewShellSessionSignature(base),
        );
    });
});

describe('useSessionViewShellSession', () => {
    it('replaces the cached shell session only when normalized rollback eligibility changes', () => {
        const base = createSession({ id: 'session-rollback', rollbackEligibleTurnStarts: [3, 1] });
        const equivalentRefresh = createSession({
            id: 'session-rollback',
            rollbackEligibleTurnStarts: [1, 3, 3],
        });
        const changed = createSession({
            id: 'session-rollback',
            rollbackEligibleTurnStarts: [1, 3, 5],
        });
        const routeState = {
            sessionListIndexByServerId: {},
            concurrentSessionListCacheByServerId: {},
        };

        const first = selectSessionViewShellSessionForRouteState({
            ...routeState,
            sessions: { [base.id]: base },
        }, base.id);
        const equivalent = selectSessionViewShellSessionForRouteState({
            ...routeState,
            sessions: { [equivalentRefresh.id]: equivalentRefresh },
        }, equivalentRefresh.id);
        const replacement = selectSessionViewShellSessionForRouteState({
            ...routeState,
            sessions: { [changed.id]: changed },
        }, changed.id);

        expect(first).toBe(base);
        expect(equivalent).toBe(first);
        expect(replacement).toBe(changed);
        expect(replacement).not.toBe(first);
    });

    it('replaces the cached shell session when transcript authority becomes a published snapshot', () => {
        const machineOnly = createSession({
            id: 'session-authority',
            currentStorageState: 'machine_only',
            acceptedThroughServerSeq: null,
            publishedThroughServerSeq: null,
            materializedThroughSourceAt: null,
        });
        const publishedSnapshot = createSession({
            ...machineOnly,
            currentStorageState: 'snapshot_complete',
            acceptedThroughServerSeq: 12,
            publishedThroughServerSeq: 12,
            materializedThroughSourceAt: 1_000,
        });
        const routeState = {
            sessionListIndexByServerId: {},
            concurrentSessionListCacheByServerId: {},
        };

        const first = selectSessionViewShellSessionForRouteState({
            ...routeState,
            sessions: { [machineOnly.id]: machineOnly },
        }, machineOnly.id);
        const second = selectSessionViewShellSessionForRouteState({
            ...routeState,
            sessions: { [publishedSnapshot.id]: publishedSnapshot },
        }, publishedSnapshot.id);

        expect(first).toBe(machineOnly);
        expect(second).toBe(publishedSnapshot);
        expect(second).not.toBe(first);
    });

    it('does not reuse a stable shell session across different resolved server scopes', () => {
        const serverASession = {
            ...createSession({ id: 'session-1' }),
            serverId: 'server-a',
        };
        const serverBSession = {
            ...createSession({ id: 'session-1' }),
            serverId: 'server-b',
        };

        const first = selectSessionViewShellSessionForRouteState({
            sessions: { 'session-1': serverASession },
            sessionListIndexByServerId: {},
            concurrentSessionListCacheByServerId: {},
        }, 'session-1', 'server-a');
        const second = selectSessionViewShellSessionForRouteState({
            sessions: { 'session-1': serverBSession },
            sessionListIndexByServerId: {},
            concurrentSessionListCacheByServerId: {},
        }, 'session-1', 'server-b');

        expect(first?.serverId).toBe('server-a');
        expect(second?.serverId).toBe('server-b');
        expect(second).toBe(serverBSession);
        expect(second).not.toBe(first);
    });

    it('accepts explicit server routes that alias the resolved local session scope', () => {
        const scopedSession = {
            ...createSession({ id: 'session-1' }),
            serverId: 'server-actual',
        };

        const selected = selectSessionViewShellSessionForRouteState({
            sessions: { 'session-1': scopedSession },
            sessionListIndexByServerId: {},
            concurrentSessionListCacheByServerId: {},
        }, 'session-1', 'server-alias');

        expect(selected?.serverId).toBe('server-actual');
    });

    it('fails closed for explicit server routes when local session scope is unknown', async () => {
        const previousState = storage.getState();
        try {
            storage.setState((state) => ({
                ...state,
                sessions: {
                    ...state.sessions,
                    'session-1': createSession({ id: 'session-1' }),
                },
                sessionListIndexByServerId: {},
                concurrentSessionListCacheByServerId: {},
            }));

            const hook = await renderHook(() => ({
                unscoped: useSessionViewShellSession('session-1'),
                scoped: useSessionViewShellSession('session-1', 'server-a'),
            }));

            expect(hook.getCurrent().unscoped?.id).toBe('session-1');
            expect(hook.getCurrent().scoped).toBeNull();
            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('returns null when the route expects a different server-scoped session', async () => {
        const previousState = storage.getState();
        const scopedSession = {
            ...createSession({ id: 'session-1' }),
            serverId: 'server-b',
        };
        try {
            storage.setState((state) => ({
                ...state,
                sessions: {
                    ...state.sessions,
                    'session-1': scopedSession,
                },
            }));

            const hook = await renderHook(() => ({
                matching: useSessionViewShellSession('session-1', 'server-b'),
                mismatched: useSessionViewShellSession('session-1', 'server-a'),
            }));

            expect(hook.getCurrent().matching?.id).toBe('session-1');
            expect(hook.getCurrent().mismatched).toBeNull();
            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('keeps Stop available for a projected active turn while the shell session reference stays stable', async () => {
        const previousState = storage.getState();
        const base = createSession({
            id: 'session-1',
            seq: 25,
            active: true,
            activeAt: 1,
            thinking: true,
            thinkingAt: 1,
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: 1,
            presence: 'online',
        });
        try {
            storage.setState((state) => ({
                ...state,
                sessions: {
                    ...state.sessions,
                    'session-1': base,
                },
            }));

            const hook = await renderHook(() => {
                const shellSession = useSessionViewShellSession('session-1');
                const seq = useSessionViewShellSessionSeq('session-1');
                const runtimeStatusSource = useSessionRuntimeStatusSource(shellSession);
                return { runtimeStatusSource, seq, shellSession };
            });
            const firstShellSession = hook.getCurrent().shellSession;
            expect(getSessionStatus(hook.getCurrent().runtimeStatusSource!, 1_000_000, 0).state).toBe('thinking');
            expect(shouldShowAbortButtonForSessionState(
                getSessionStatus(hook.getCurrent().runtimeStatusSource!, 1_000_000, 0).state,
            )).toBe(true);

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessions: {
                        ...state.sessions,
                        'session-1': {
                            ...base,
                            seq: 26,
                            updatedAt: 1_000_000,
                            activeAt: 1_000_000,
                            thinkingAt: 1_000_000,
                            latestTurnStatusObservedAt: 1_000_000,
                        },
                    },
                }));
            });

            const nextStatus = getSessionStatus(hook.getCurrent().runtimeStatusSource!, 1_000_000, 0);
            expect(hook.getCurrent().shellSession).toBe(firstShellSession);
            expect(hook.getCurrent().seq).toBe(26);
            expect(nextStatus.state).toBe('thinking');
            expect(shouldShowAbortButtonForSessionState(nextStatus.state)).toBe(true);
            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('uses local outbound pending timestamps for runtime status before the session row records optimistic thinking', async () => {
        const previousState = storage.getState();
        const shellSession = createSession({
            id: 'session-1',
            seq: 0,
            active: true,
            activeAt: 1_000_000,
            thinking: false,
            thinkingAt: 1,
            latestTurnStatus: null,
            latestTurnStatusObservedAt: null,
            optimisticThinkingAt: null,
            presence: 'online',
        });
        try {
            storage.setState((state) => ({
                ...state,
                sessions: {
                    ...state.sessions,
                    'session-1': shellSession,
                },
                sessionPending: {
                    ...state.sessionPending,
                    'session-1': {
                        isLoaded: true,
                        discarded: [],
                        messages: [{
                            id: 'local-1',
                            localId: 'local-1',
                            createdAt: 1_000_000,
                            updatedAt: 1_000_000,
                            source: 'local_outbound',
                            deliveryStatus: 'accepted',
                            text: 'start',
                            rawRecord: { role: 'user', content: { type: 'text', text: 'start' } },
                        }],
                    },
                },
            }));

            const hook = await renderHook(() => useSessionRuntimeStatusSource(shellSession));
            const status = getSessionStatus(hook.getCurrent()!, 1_000_100, 0);

            expect(status.state).toBe('thinking');
            expect(hook.getCurrent()?.optimisticThinkingAt).toBe(1_000_000);
            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('updates runtime status from the store when a completed turn projection lands on a stale shell session object', async () => {
        const previousState = storage.getState();
        const shellSession = createSession({
            id: 'session-1',
            seq: 25,
            active: true,
            activeAt: 1_000_000,
            thinking: true,
            thinkingAt: 1_000_000,
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: 1_000_000,
            presence: 'online',
        });
        try {
            storage.setState((state) => ({
                ...state,
                sessions: {
                    ...state.sessions,
                    'session-1': shellSession,
                },
            }));

            const hook = await renderHook(() => useSessionRuntimeStatusSource(shellSession));
            expect(getSessionStatus(hook.getCurrent()!, 1_000_000, 0).state).toBe('thinking');

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessions: {
                        ...state.sessions,
                        'session-1': {
                            ...shellSession,
                            seq: 26,
                            updatedAt: 1_000_100,
                            activeAt: 1_000_100,
                            thinking: false,
                            thinkingAt: 1_000_100,
                            latestTurnStatus: 'completed',
                            latestTurnStatusObservedAt: 1_000_100,
                        },
                    },
                }));
            });

            const nextRuntimeStatusSource = hook.getCurrent()!;
            const nextStatus = getSessionStatus(nextRuntimeStatusSource, 1_000_100, 0);
            expect(shellSession.latestTurnStatus).toBe('in_progress');
            expect(nextRuntimeStatusSource.latestTurnStatus).toBe('completed');
            expect(nextStatus.state).toBe('waiting');
            expect(shouldShowAbortButtonForSessionState(nextStatus.state)).toBe(false);
            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('includes background Activity in the composer status source without exposing foreground Stop', async () => {
        const previousState = storage.getState();
        const shellSession = createSession({
            id: 'session-1',
            thinking: false,
            latestTurnStatus: 'completed',
            runtimeActivityState: 'idle',
            runtimeActivityActiveCount: 0,
            runtimeActivityObservedAt: 1_000,
            runtimeActivityRevision: 1,
        });
        try {
            storage.setState((state) => ({
                ...state,
                sessions: {
                    ...state.sessions,
                    'session-1': shellSession,
                },
            }));

            const hook = await renderHook(() => useSessionRuntimeStatusSource(shellSession));
            const initial = hook.getCurrent();
            expect(getSessionStatus(initial!, 1_000, 0).state).toBe('waiting');

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessions: {
                        ...state.sessions,
                        'session-1': {
                            ...shellSession,
                            runtimeActivityState: 'active',
                            runtimeActivityActiveCount: 1,
                            runtimeActivityObservedAt: 2_000,
                            runtimeActivityRevision: 2,
                        },
                    },
                }));
            });

            const backgroundStatus = getSessionStatus(hook.getCurrent()!, 2_000, 0);
            expect(backgroundStatus.state).toBe('background_active');
            expect(shouldShowAbortButtonForSessionState(backgroundStatus.state)).toBe(false);
            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('keeps the shell session reference stable for seq-only streaming updates', async () => {
        const previousState = storage.getState();
        const base = createSession({ id: 'session-1', seq: 25 });
        try {
            storage.setState((state) => ({
                ...state,
                sessions: {
                    ...state.sessions,
                    'session-1': base,
                },
            }));

            const hook = await renderHook(() => ({
                session: useSessionViewShellSession('session-1'),
                seq: useSessionViewShellSessionSeq('session-1'),
            }));
            const firstSession = hook.getCurrent().session;
            expect(hook.getCurrent().seq).toBe(25);

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessions: {
                        ...state.sessions,
                        'session-1': {
                            ...base,
                            seq: 26,
                            updatedAt: 200,
                            activeAt: 200,
                        },
                    },
                }));
            });

            expect(hook.getCurrent().session).toBe(firstSession);
            expect(hook.getCurrent().seq).toBe(26);
            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });
});
