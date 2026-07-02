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
                provider: 'codex',
                updatedAt,
                currentModeId: 'default',
                availableModes: [{ id: 'default', name: 'Default' }],
            },
            sessionModelsV1: {
                v: 1,
                provider: 'codex',
                updatedAt,
                currentModelId: 'model-a',
                availableModels: [{ id: 'model-a', name: 'Model A' }],
            },
            sessionConfigOptionsV1: {
                v: 1,
                provider: 'codex',
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
                    provider: 'codex',
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
                    provider: 'codex',
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
});

describe('useSessionViewShellSession', () => {
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

    it('keeps the shell session reference stable while runtime status follows fresh activity fields', async () => {
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
            expect(getSessionStatus(hook.getCurrent().runtimeStatusSource!, 1_000_000, 0).state).toBe('waiting');
            expect(shouldShowAbortButtonForSessionState(
                getSessionStatus(hook.getCurrent().runtimeStatusSource!, 1_000_000, 0).state,
            )).toBe(false);

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
