import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderHook, standardCleanup } from '@/dev/testkit';
import type { Session } from '@/sync/domains/state/storageTypes';
import { storage } from '@/sync/domains/state/storageStore';

import {
    buildSessionViewShellSessionSignature,
    selectSessionViewShellSessionForRouteState,
    useSessionViewShellSession,
    useSessionViewShellSessionSeq,
} from './sessionViewStableSession';

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

afterEach(() => {
    standardCleanup();
});

describe('buildSessionViewShellSessionSignature', () => {
    it('stays stable for timestamp-only session heartbeats', () => {
        const base = createSession();
        const heartbeat = createSession({
            updatedAt: 200,
            activeAt: 200,
            thinkingAt: 200,
            latestTurnStatusObservedAt: 200,
            latestUsage: {
                inputTokens: 2,
                outputTokens: 4,
                cacheCreation: 0,
                cacheRead: 0,
                contextSize: 8,
                timestamp: 200,
            },
        });

        expect(buildSessionViewShellSessionSignature(heartbeat)).toBe(buildSessionViewShellSessionSignature(base));
    });

    it('stays stable for an exact duplicate explicit runtime-activity projection', () => {
        const base = createSession({
            runtimeActivityState: 'active',
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: 200,
            runtimeActivityRevision: 7,
        });
        const duplicate = createSession({
            runtimeActivityState: 'active',
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: 200,
            runtimeActivityRevision: 7,
        });

        expect(buildSessionViewShellSessionSignature(duplicate)).toBe(
            buildSessionViewShellSessionSignature(base),
        );
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

    it('changes when server-owned rollback eligibility changes without a transcript seq change', () => {
        const unavailable = createSession({
            seq: 5,
            rollbackEligibleTurnStarts: [],
        });
        const eligible = createSession({
            seq: 5,
            rollbackEligibleTurnStarts: [4],
        });

        expect(buildSessionViewShellSessionSignature(eligible)).not.toBe(
            buildSessionViewShellSessionSignature(unavailable),
        );
    });

    it('changes when the latest turn advances ahead of detailed rollback hydration', () => {
        const stale = createSession({ latestTurnId: 'turn-1' });
        const advanced = createSession({ latestTurnId: 'turn-2' });

        expect(buildSessionViewShellSessionSignature(advanced)).not.toBe(
            buildSessionViewShellSessionSignature(stale),
        );
    });

    it('changes when detailed rollback turns hydrate after the flattened starts are already current', () => {
        const firstTurn = {
            turnId: 'turn-1',
            status: 'completed' as const,
            startedAt: 1,
            updatedAt: 2,
            terminalAt: 2,
            transcriptAnchors: { startUserMessageSeq: 1, userMessageSeqs: [1], startSeqInclusive: 1, endSeqInclusive: 2 },
            rollback: { state: 'eligible' as const, updatedAt: 2 },
        };
        const projected = createSession({
            rollbackEligibleTurnStarts: [1, 4],
            sessionTurns: { v: 1, sessionId: 's1', latestTurnId: 'turn-1', updatedAt: 2, turns: [firstTurn] },
        });
        const hydrated = createSession({
            rollbackEligibleTurnStarts: [1, 4],
            sessionTurns: {
                v: 1,
                sessionId: 's1',
                latestTurnId: 'turn-2',
                updatedAt: 4,
                turns: [firstTurn, {
                    ...firstTurn,
                    turnId: 'turn-2',
                    updatedAt: 4,
                    terminalAt: 4,
                    transcriptAnchors: { startUserMessageSeq: 4, userMessageSeqs: [4], startSeqInclusive: 3, endSeqInclusive: 5 },
                    rollback: { state: 'eligible', updatedAt: 4 },
                }],
            },
        });

        expect(buildSessionViewShellSessionSignature(hydrated)).not.toBe(
            buildSessionViewShellSessionSignature(projected),
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
            sessionListViewDataByServerId: {},
        }, 'session-1', 'server-a');
        const second = selectSessionViewShellSessionForRouteState({
            sessions: { 'session-1': serverBSession },
            sessionListViewDataByServerId: {},
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
            sessionListViewDataByServerId: {},
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
                    s1: createSession({ id: 's1' }),
                },
                sessionListViewDataByServerId: {},
            }));

            const hook = await renderHook(() => ({
                unscoped: useSessionViewShellSession('s1'),
                scoped: useSessionViewShellSession('s1', 'server-a'),
            }), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent().unscoped?.id).toBe('s1');
            expect(hook.getCurrent().scoped).toBeNull();
            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('keeps the shell session reference stable for heartbeat and seq-only updates', async () => {
        const previousState = storage.getState();
        try {
            storage.setState((state) => ({
                ...state,
                sessions: {
                    ...state.sessions,
                    s1: createSession({
                        seq: 25,
                        updatedAt: 100,
                        activeAt: 100,
                        thinkingAt: 100,
                        latestTurnStatusObservedAt: 100,
                        runtimeActivityState: 'active',
                        runtimeActivityActiveCount: 1,
                        runtimeActivityObservedAt: 90,
                        runtimeActivityRevision: 7,
                    }),
                },
            }));

            const shellHook = await renderHook(() => useSessionViewShellSession('s1'), {
                flushOptions: { cycles: 1, turns: 4 },
            });
            const seqHook = await renderHook(() => useSessionViewShellSessionSeq('s1'), {
                flushOptions: { cycles: 1, turns: 4 },
            });
            const firstShellSession = shellHook.getCurrent();

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessions: {
                        ...state.sessions,
                        s1: createSession({
                            seq: 26,
                            updatedAt: 200,
                            activeAt: 200,
                            thinkingAt: 200,
                            latestTurnStatusObservedAt: 200,
                            runtimeActivityState: 'active',
                            runtimeActivityActiveCount: 1,
                            runtimeActivityObservedAt: 90,
                            runtimeActivityRevision: 7,
                        }),
                    },
                }));
            });

            expect(shellHook.getCurrent()).toBe(firstShellSession);
            expect(seqHook.getCurrent()).toBe(26);

            await shellHook.unmount();
            await seqHook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });
});
