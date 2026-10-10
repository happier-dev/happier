import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

const { getWorkspaceSyncStatus, listWorkspaceSyncStatuses } = vi.hoisted(() => ({
    getWorkspaceSyncStatus: vi.fn(),
    listWorkspaceSyncStatuses: vi.fn(),
}));

// Keep the real admitted operations and schema validation beneath the network boundary.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: async (input: Readonly<{
        serverId?: string | null; machineId: string; method: string; payload: unknown;
    }>) => {
        const scope = { serverId: input.serverId, controllerMachineId: input.machineId };
        if (input.method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_LIST) {
            return { statuses: await listWorkspaceSyncStatuses(scope) };
        }
        if (input.method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_GET) {
            return { status: await getWorkspaceSyncStatus({ ...scope,
                relationshipId: (input.payload as Readonly<{ relationshipId: string }>).relationshipId }) };
        }
        throw new Error(`Unexpected RPC: ${input.method}`);
    },
}));

import {
    applyWorkspaceSyncStatusEvent,
    getWorkspaceSyncStatusSnapshot,
    refreshWorkspaceSyncStatus,
    refreshWorkspaceSyncStatuses,
    resetWorkspaceSyncStatusStoreForTests,
    subscribeWorkspaceSyncStatus,
} from './workspaceSyncStatusStore';
import { applyWorkspaceSyncRuntimeEvent } from './applyWorkspaceSyncRuntimeEvent';

describe('workspaceSyncStatusStore', () => {
    beforeEach(() => {
        getWorkspaceSyncStatus.mockReset();
        listWorkspaceSyncStatuses.mockReset();
        resetWorkspaceSyncStatusStoreForTests();
    });

    it('refreshes admitted relationship reads after a content-free Machine publication without admitting private payloads', async () => {
        const scope = { serverId: 'server-1', controllerMachineId: 'machine-1', relationshipId: 'private-relationship' };
        const status = {
            relationshipId: scope.relationshipId, controllerMachineId: scope.controllerMachineId, state: 'watching' as const,
            alphaPath: '/private/alpha', betaPath: '/private/beta', mode: 'keep_synced' as const,
            endpointStates: { alpha: null, beta: null }, conflictCount: 0, lastCycleObservedAtMs: null,
        };
        listWorkspaceSyncStatuses.mockResolvedValueOnce([status]);
        const unsubscribe = subscribeWorkspaceSyncStatus(scope, () => {});
        applyWorkspaceSyncRuntimeEvent({
            serverId: scope.serverId, machineId: scope.controllerMachineId,
            event: { v: 1, readiness: { engine: { state: 'ready' }, carrier: { state: 'ready' } } },
        });
        await vi.waitFor(() => expect(getWorkspaceSyncStatusSnapshot(scope)).toMatchObject({
            phase: 'ready', status: { alphaPath: '/private/alpha' },
        }));
        expect(listWorkspaceSyncStatuses).toHaveBeenCalledExactlyOnceWith({
            serverId: scope.serverId, controllerMachineId: scope.controllerMachineId,
        });
        expect(getWorkspaceSyncStatusSnapshot({ ...scope, serverId: 'another-home' }).status).toBeNull();
        applyWorkspaceSyncRuntimeEvent({
            serverId: scope.serverId, machineId: scope.controllerMachineId,
            event: { v: 1, readiness: { engine: { state: 'ready' }, carrier: { state: 'ready' } }, status: { ...status, alphaPath: '/forged' } },
        });
        expect(getWorkspaceSyncStatusSnapshot(scope).status?.alphaPath).toBe('/private/alpha');
        unsubscribe();
    });

    it('does not accept a relationship read begun before the next Machine invalidation', async () => {
        const scope = { serverId: 'server-1', controllerMachineId: 'machine-1', relationshipId: 'relationship-1' };
        const status = {
            relationshipId: scope.relationshipId, controllerMachineId: scope.controllerMachineId,
            state: 'watching' as const, alphaPath: '/alpha', betaPath: '/beta', mode: 'keep_synced' as const,
            endpointStates: { alpha: null, beta: null }, conflictCount: 0, lastCycleObservedAtMs: null,
        };
        let resolveStale!: (value: readonly unknown[]) => void;
        listWorkspaceSyncStatuses
            .mockImplementationOnce(() => new Promise((resolve) => { resolveStale = resolve; }))
            .mockResolvedValueOnce([{ ...status, state: 'conflicted', conflictCount: 1 }]);
        const unsubscribe = subscribeWorkspaceSyncStatus(scope, () => {});
        const readyStates: string[] = [];
        const unsubscribeObserver = subscribeWorkspaceSyncStatus(scope, () => {
            const snapshot = getWorkspaceSyncStatusSnapshot(scope);
            if (snapshot.phase === 'ready' && snapshot.status) readyStates.push(snapshot.status.state);
        });
        const input = { serverId: scope.serverId, machineId: scope.controllerMachineId,
            event: { v: 1, readiness: { engine: { state: 'ready' }, carrier: { state: 'ready' } } } };
        applyWorkspaceSyncRuntimeEvent(input);
        applyWorkspaceSyncRuntimeEvent(input);
        expect(listWorkspaceSyncStatuses).toHaveBeenCalledOnce();
        resolveStale([status]);
        await vi.waitFor(() => expect(getWorkspaceSyncStatusSnapshot(scope)).toMatchObject({
            phase: 'ready', status: { state: 'conflicted', conflictCount: 1 },
        }));
        expect(readyStates).not.toContain('watching');
        expect(listWorkspaceSyncStatuses).toHaveBeenCalledTimes(2);
        unsubscribe();
        unsubscribeObserver();
    });

    it('refreshes demanded relationships once per controller and leaves absent status unknown', async () => {
        const scopes = ['relationship-1', 'relationship-2', 'relationship-3'].map((relationshipId) => ({
            serverId: 'server-1', controllerMachineId: 'machine-1', relationshipId,
        }));
        listWorkspaceSyncStatuses.mockResolvedValueOnce([{
            relationshipId: 'relationship-2', controllerMachineId: 'machine-1', state: 'conflicted',
            alphaPath: '/alpha', betaPath: '/beta', mode: 'keep_synced',
            endpointStates: { alpha: null, beta: null }, conflictCount: 1, lastCycleObservedAtMs: null,
        }]);
        await refreshWorkspaceSyncStatuses(scopes);
        expect(listWorkspaceSyncStatuses).toHaveBeenCalledOnce();
        expect(getWorkspaceSyncStatus).not.toHaveBeenCalled();
        expect(getWorkspaceSyncStatusSnapshot(scopes[0]!)).toMatchObject({ phase: 'ready', status: null });
        expect(getWorkspaceSyncStatusSnapshot(scopes[1]!)).toMatchObject({ phase: 'ready', status: { conflictCount: 1 } });
        expect(getWorkspaceSyncStatusSnapshot(scopes[2]!)).toMatchObject({ phase: 'ready', status: null });
    });

    it('marks an unobserved cached status idle without a read and preserves it until next demand', async () => {
        const scope = { serverId: 'server-1', controllerMachineId: 'machine-1', relationshipId: 'relationship-1' };
        const status = {
            relationshipId: scope.relationshipId, controllerMachineId: scope.controllerMachineId, state: 'watching' as const,
            alphaPath: '/alpha', betaPath: '/beta', mode: 'keep_synced' as const,
            endpointStates: { alpha: null, beta: null }, conflictCount: 0, lastCycleObservedAtMs: null,
        };
        applyWorkspaceSyncStatusEvent(scope, status);
        applyWorkspaceSyncRuntimeEvent({ serverId: scope.serverId, machineId: scope.controllerMachineId,
            event: { v: 1, readiness: { engine: { state: 'ready' }, carrier: { state: 'ready' } } } });
        expect(listWorkspaceSyncStatuses).not.toHaveBeenCalled();
        expect(getWorkspaceSyncStatusSnapshot(scope)).toMatchObject({ phase: 'idle', status });
        listWorkspaceSyncStatuses.mockImplementationOnce(() => new Promise(() => {}));
        void refreshWorkspaceSyncStatuses([scope]);
        expect(getWorkspaceSyncStatusSnapshot(scope)).toMatchObject({ phase: 'refreshing', status });
    });

    it('keeps a new consumer joining an invalidated controller read from seeing its stale result', async () => {
        const scope = { serverId: 'server-1', controllerMachineId: 'machine-1', relationshipId: 'relationship-1' };
        const lateScope = { ...scope, relationshipId: 'relationship-2' };
        const status = {
            relationshipId: lateScope.relationshipId, controllerMachineId: scope.controllerMachineId, state: 'watching' as const,
            alphaPath: '/alpha', betaPath: '/beta', mode: 'keep_synced' as const,
            endpointStates: { alpha: null, beta: null }, conflictCount: 0, lastCycleObservedAtMs: null,
        };
        let resolveStale!: (value: readonly unknown[]) => void;
        listWorkspaceSyncStatuses
            .mockImplementationOnce(() => new Promise((resolve) => { resolveStale = resolve; }))
            .mockResolvedValueOnce([{ ...status, state: 'paused' }]);
        const unsubscribe = subscribeWorkspaceSyncStatus(scope, () => {});
        const pending = refreshWorkspaceSyncStatuses([scope]);
        applyWorkspaceSyncRuntimeEvent({ serverId: scope.serverId, machineId: scope.controllerMachineId,
            event: { v: 1, readiness: { engine: { state: 'ready' }, carrier: { state: 'ready' } } } });
        const observedStates: string[] = [];
        const unsubscribeLate = subscribeWorkspaceSyncStatus(lateScope, () => {
            const snapshot = getWorkspaceSyncStatusSnapshot(lateScope);
            if (snapshot.phase === 'ready' && snapshot.status) observedStates.push(snapshot.status.state);
        });
        const joined = refreshWorkspaceSyncStatuses([lateScope]);
        resolveStale([status]);
        await Promise.all([pending, joined]);
        expect(observedStates).toEqual(['paused']);
        expect(listWorkspaceSyncStatuses).toHaveBeenCalledTimes(2);
        unsubscribe();
        unsubscribeLate();
    });

    it('rejects a pending individual read after Machine invalidation refreshes its admitted controller', async () => {
        const scope = { serverId: 'server-1', controllerMachineId: 'machine-1', relationshipId: 'relationship-1' };
        const status = {
            relationshipId: scope.relationshipId, controllerMachineId: scope.controllerMachineId, state: 'watching' as const,
            alphaPath: '/alpha', betaPath: '/beta', mode: 'keep_synced' as const,
            endpointStates: { alpha: null, beta: null }, conflictCount: 0, lastCycleObservedAtMs: null,
        };
        let resolveStale!: (value: unknown) => void;
        getWorkspaceSyncStatus.mockImplementationOnce(() => new Promise((resolve) => { resolveStale = resolve; }));
        listWorkspaceSyncStatuses.mockResolvedValueOnce([{ ...status, state: 'paused' }]);
        const unsubscribe = subscribeWorkspaceSyncStatus(scope, () => {});
        const pending = refreshWorkspaceSyncStatus(scope);
        applyWorkspaceSyncRuntimeEvent({ serverId: scope.serverId, machineId: scope.controllerMachineId,
            event: { v: 1, readiness: { engine: { state: 'ready' }, carrier: { state: 'ready' } } } });
        await vi.waitFor(() => expect(getWorkspaceSyncStatusSnapshot(scope).status?.state).toBe('paused'));
        resolveStale(status);
        await pending;
        expect(getWorkspaceSyncStatusSnapshot(scope)).toMatchObject({ phase: 'ready', status: { state: 'paused' } });
        unsubscribe();
    });

    it('coalesces reads shared by Projects, sessions, and Settings and keeps the last-known status while refreshing', async () => {
        let resolveFirst!: (value: unknown) => void;
        getWorkspaceSyncStatus.mockImplementationOnce(() => new Promise((resolve) => {
            resolveFirst = resolve;
        }));
        const scope = { serverId: 'server-1', controllerMachineId: 'machine-1', relationshipId: 'relationship-1' } as const;

        const first = refreshWorkspaceSyncStatus(scope);
        const second = refreshWorkspaceSyncStatus(scope);
        expect(getWorkspaceSyncStatus).toHaveBeenCalledTimes(1);
        expect(getWorkspaceSyncStatusSnapshot(scope)).toMatchObject({ phase: 'loading', status: null });

        resolveFirst({
            relationshipId: 'relationship-1', controllerMachineId: 'machine-1', state: 'watching',
            alphaPath: '/alpha', betaPath: '/beta', mode: 'keep_synced',
            endpointStates: { alpha: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 }, beta: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 } },
            conflictCount: 0, lastCycleObservedAtMs: 1,
        });
        await Promise.all([first, second]);
        const settled = getWorkspaceSyncStatusSnapshot(scope);
        expect(settled).toMatchObject({ phase: 'ready', status: { state: 'watching' } });

        let resolveSecond!: (value: unknown) => void;
        getWorkspaceSyncStatus.mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve; }));
        const repeated = refreshWorkspaceSyncStatus(scope);
        expect(getWorkspaceSyncStatusSnapshot(scope)).toMatchObject({
            phase: 'refreshing',
            status: { state: 'watching' },
        });
        expect(getWorkspaceSyncStatusSnapshot(scope).status).toBe(settled.status);
        resolveSecond({ ...settled.status });
        expect(await repeated).toBe(settled.status);
        expect(getWorkspaceSyncStatusSnapshot(scope)).toMatchObject({ phase: 'ready' });
        expect(getWorkspaceSyncStatusSnapshot(scope).status).toBe(settled.status);
    });

    it('retains the summary status reference across repeated readiness pulses while publishing refresh phases', async () => {
        const scope = { serverId: 'server-1', controllerMachineId: 'machine-1', relationshipId: 'relationship-1' };
        const status = {
            relationshipId: scope.relationshipId, controllerMachineId: scope.controllerMachineId, state: 'watching' as const,
            alphaPath: '/alpha', betaPath: '/beta', mode: 'keep_synced' as const,
            endpointStates: { alpha: null, beta: null }, conflictCount: 0, lastCycleObservedAtMs: null,
        };
        applyWorkspaceSyncStatusEvent(scope, status);
        const unsubscribe = subscribeWorkspaceSyncStatus(scope, () => {});
        listWorkspaceSyncStatuses.mockResolvedValue([{ ...status }]);
        const input = { serverId: scope.serverId, machineId: scope.controllerMachineId,
            event: { v: 1, readiness: { engine: { state: 'ready' }, carrier: { state: 'ready' } } } };
        for (let pulse = 0; pulse < 2; pulse += 1) {
            applyWorkspaceSyncRuntimeEvent(input);
            expect(getWorkspaceSyncStatusSnapshot(scope)).toMatchObject({ phase: 'refreshing' });
            expect(getWorkspaceSyncStatusSnapshot(scope).status).toBe(status);
            await vi.waitFor(() => expect(getWorkspaceSyncStatusSnapshot(scope)).toMatchObject({ phase: 'ready' }));
            expect(getWorkspaceSyncStatusSnapshot(scope).status).toBe(status);
        }
        unsubscribe();
    });

    it('applies a daemon runtime status event only to its exact Home and controller scope', () => {
        const scope = { serverId: 'server-1', controllerMachineId: 'machine-1', relationshipId: 'relationship-1' } as const;
        applyWorkspaceSyncStatusEvent(scope, {
            relationshipId: 'relationship-1', controllerMachineId: 'machine-1', state: 'paused',
            alphaPath: '/alpha', betaPath: '/beta', mode: 'keep_synced',
            endpointStates: { alpha: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 }, beta: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 } },
            conflictCount: 0, lastCycleObservedAtMs: 1,
        });

        expect(getWorkspaceSyncStatusSnapshot(scope)).toMatchObject({ phase: 'ready', status: { state: 'paused' } });
        expect(getWorkspaceSyncStatusSnapshot({ ...scope, serverId: 'server-2' })).toMatchObject({ phase: 'idle', status: null });
        expect(getWorkspaceSyncStatusSnapshot({ ...scope, controllerMachineId: 'machine-2' })).toMatchObject({ phase: 'idle', status: null });
    });

    it('keeps a closed summary subscriber stable when a daemon repeats the same status', () => {
        const scope = { serverId: 'server-1', controllerMachineId: 'machine-1', relationshipId: 'relationship-1' } as const;
        const status = {
            relationshipId: 'relationship-1', controllerMachineId: 'machine-1', state: 'watching' as const,
            alphaPath: '/alpha', betaPath: '/beta', mode: 'keep_synced' as const,
            endpointStates: { alpha: null, beta: null }, conflictCount: 0, lastCycleObservedAtMs: null,
        };
        const listener = vi.fn();
        subscribeWorkspaceSyncStatus(scope, listener);
        applyWorkspaceSyncStatusEvent(scope, status);
        const first = getWorkspaceSyncStatusSnapshot(scope);
        applyWorkspaceSyncStatusEvent(scope, { ...status });
        expect(listener).toHaveBeenCalledOnce();
        expect(getWorkspaceSyncStatusSnapshot(scope)).toBe(first);
    });

    it('does not let an older in-flight refresh overwrite a newer runtime status event', async () => {
        let resolveRefresh!: (value: unknown) => void;
        getWorkspaceSyncStatus.mockImplementationOnce(() => new Promise((resolve) => {
            resolveRefresh = resolve;
        }));
        const scope = { serverId: 'server-1', controllerMachineId: 'machine-1', relationshipId: 'relationship-1' } as const;

        const refresh = refreshWorkspaceSyncStatus(scope);
        applyWorkspaceSyncStatusEvent(scope, {
            relationshipId: 'relationship-1', controllerMachineId: 'machine-1', state: 'paused',
            alphaPath: '/alpha', betaPath: '/beta', mode: 'keep_synced',
            endpointStates: { alpha: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 }, beta: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 } },
            conflictCount: 0, lastCycleObservedAtMs: 2,
        });
        resolveRefresh({
            relationshipId: 'relationship-1', controllerMachineId: 'machine-1', state: 'watching',
            alphaPath: '/alpha', betaPath: '/beta', mode: 'keep_synced',
            endpointStates: { alpha: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 }, beta: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 } },
            conflictCount: 0, lastCycleObservedAtMs: 1,
        });
        await refresh;

        expect(getWorkspaceSyncStatusSnapshot(scope)).toMatchObject({
            phase: 'ready',
            status: { state: 'paused', lastCycleObservedAtMs: 2 },
        });
    });
});
