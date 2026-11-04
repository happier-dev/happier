import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createWorkspaceSyncStatusWatchBoundary } from '@/dev/testkit/harness/workspaceSyncStatusWatchBoundary';
import { createWorkspaceSyncHarness } from '@/dev/testkit/harness/workspaceSyncHarness';

const watchBoundary = createWorkspaceSyncStatusWatchBoundary();

const { getWorkspaceSyncStatus, listWorkspaceSyncStatuses, watchWorkspaceSyncStatuses, machineRpcCalls } = vi.hoisted(() => ({
    getWorkspaceSyncStatus: vi.fn(),
    listWorkspaceSyncStatuses: vi.fn(),
    watchWorkspaceSyncStatuses: vi.fn(),
    machineRpcCalls: vi.fn(),
}));

// HTTP/Socket is the boundary; admission, cancellation and operation codecs stay real.
const workspace = createWorkspaceSyncHarness(async input => {
    machineRpcCalls(input.method);
    const scope = { serverId: workspace.serverId, controllerMachineId: input.machineId };
    if (input.method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_WATCH) {
        return await watchWorkspaceSyncStatuses({ ...scope,
            ...(input.payload as Readonly<{ sinceRevision?: number }>), signal: input.signal });
    }
    if (input.method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_LIST) return { statuses: await listWorkspaceSyncStatuses(scope) };
    if (input.method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_GET) return { status: await getWorkspaceSyncStatus({ ...scope,
        relationshipId: (input.payload as Readonly<{ relationshipId: string }>).relationshipId }) };
    throw new Error(`Unexpected RPC: ${input.method}`);
});
await workspace.ready;

const {
    applyWorkspaceSyncStatusEvent,
    getWorkspaceSyncStatusSnapshot,
    invalidateWorkspaceSyncStatuses,
    refreshWorkspaceSyncStatus,
    refreshWorkspaceSyncStatuses,
    resetWorkspaceSyncStatusStoreForTests,
    setWorkspaceSyncStatus,
    subscribeWorkspaceSyncStatus,
} = await import('./workspaceSyncStatusStore');
const { applyWorkspaceSyncRuntimeEvent } = await import('./applyWorkspaceSyncRuntimeEvent');
const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');

describe('workspaceSyncStatusStore', () => {
    beforeEach(async () => {
        await workspace.reset();
        getWorkspaceSyncStatus.mockReset();
        listWorkspaceSyncStatuses.mockReset();
        machineRpcCalls.mockReset();
        resetWorkspaceSyncStatusStoreForTests();
        watchBoundary.reset();
        watchWorkspaceSyncStatuses.mockReset().mockImplementation(input => watchBoundary.watch(input));
    });

    afterEach(async () => {
        resetWorkspaceSyncStatusStoreForTests();
        watchBoundary.reset();
        vi.useRealTimers();
        await workspace.dispose();
    });

    it('does zero settled status RPC re-arms over ten visible idle minutes', async () => {
        vi.useFakeTimers();
        const scope = { serverId: workspace.serverId, controllerMachineId: 'machine-a', relationshipId: 'relationship-1' };
        const status = {
            relationshipId: scope.relationshipId, controllerMachineId: scope.controllerMachineId,
            state: 'watching' as const, alphaPath: '/alpha', betaPath: '/beta', mode: 'keep_synced' as const,
            endpointStates: { alpha: null, beta: null }, conflictCount: 0, lastCycleObservedAtMs: null,
        };
        setWorkspaceSyncStatus(scope, status);
        listWorkspaceSyncStatuses.mockResolvedValue([status]);
        watchBoundary.publish([status]);
        await vi.advanceTimersByTimeAsync(600_000);
        expect(machineRpcCalls).not.toHaveBeenCalled();

        const unsubscribe = subscribeWorkspaceSyncStatus(scope, () => {});
        try {
            // Settle admission before measuring steady-state watch renewals.
            await vi.waitFor(() => expect(watchBoundary.parkedCount()).toBe(1));
            machineRpcCalls.mockClear();
            await vi.advanceTimersByTimeAsync(600_000);
            expect(machineRpcCalls).not.toHaveBeenCalled();
            expect(listWorkspaceSyncStatuses).not.toHaveBeenCalled();
        } finally {
            unsubscribe();
        }
        const callsAfterClose = machineRpcCalls.mock.calls.length;
        await vi.advanceTimersByTimeAsync(600_000);
        expect(machineRpcCalls).toHaveBeenCalledTimes(callsAfterClose);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('observes engine changes once per demanded controller and does zero reads for ten undemanded minutes', async () => {
        vi.useFakeTimers();
        const scopes = ['relationship-1', 'relationship-2'].map(relationshipId => ({
            serverId: workspace.serverId, controllerMachineId: 'machine-a', relationshipId,
        }));
        let statuses = scopes.map(scope => ({
            relationshipId: scope.relationshipId, controllerMachineId: scope.controllerMachineId,
            state: 'watching' as 'watching' | 'disconnected', alphaPath: '/alpha', betaPath: '/beta', mode: 'keep_synced' as const,
            endpointStates: { alpha: null, beta: null }, conflictCount: 0, lastCycleObservedAtMs: null,
        }));
        statuses.forEach((status, index) => setWorkspaceSyncStatus(scopes[index]!, status));
        listWorkspaceSyncStatuses.mockImplementation(async () => statuses);
        watchBoundary.publish(statuses);
        await vi.advanceTimersByTimeAsync(600_000);
        expect(listWorkspaceSyncStatuses).not.toHaveBeenCalled();

        const firstListener = vi.fn();
        const secondListener = vi.fn();
        const unsubscribeFirst = subscribeWorkspaceSyncStatus(scopes[0]!, firstListener);
        const unsubscribeSecond = subscribeWorkspaceSyncStatus(scopes[1]!, secondListener);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(listWorkspaceSyncStatuses).not.toHaveBeenCalled();
        expect(watchBoundary.parkedCount()).toBe(1);
        expect(firstListener).not.toHaveBeenCalled();
        expect(secondListener).not.toHaveBeenCalled();

        statuses = statuses.map((status, index) => index === 1 ? { ...status, state: 'disconnected' as const } : status);
        watchBoundary.publish(statuses);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(listWorkspaceSyncStatuses).not.toHaveBeenCalled();
        expect(getWorkspaceSyncStatusSnapshot(scopes[1]!).status?.state).toBe('disconnected');
        expect(secondListener).toHaveBeenCalledTimes(1);
        expect(firstListener).not.toHaveBeenCalled();

        unsubscribeFirst();
        await vi.advanceTimersByTimeAsync(1_000);
        expect(watchBoundary.parkedCount()).toBe(1);
        unsubscribeSecond();
        await vi.advanceTimersByTimeAsync(600_000);
        expect(listWorkspaceSyncStatuses).not.toHaveBeenCalled();
        expect(getWorkspaceSyncStatus).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('retains the displayed status on a watch failure and revalidates unchanged status on transport recovery without a retry timer', async () => {
        vi.useFakeTimers();
        const scope = { serverId: workspace.serverId, controllerMachineId: 'machine-a', relationshipId: 'relationship-1' };
        const status = {
            relationshipId: scope.relationshipId, controllerMachineId: scope.controllerMachineId,
            state: 'watching' as const, alphaPath: '/alpha', betaPath: '/beta', mode: 'keep_synced' as const,
            endpointStates: { alpha: null, beta: null }, conflictCount: 0, lastCycleObservedAtMs: null,
        };
        setWorkspaceSyncStatus(scope, status);
        watchBoundary.publish([status]);
        const failure = new Error('daemon unavailable');
        const unsubscribe = subscribeWorkspaceSyncStatus(scope, () => {});
        await vi.advanceTimersByTimeAsync(1_000);
        watchBoundary.fail(failure);
        await vi.advanceTimersByTimeAsync(0);
        expect(getWorkspaceSyncStatusSnapshot(scope)).toMatchObject({ phase: 'error', status, error: failure });
        const failedCalls = watchWorkspaceSyncStatuses.mock.calls.length;
        await vi.advanceTimersByTimeAsync(600_000);
        expect(watchWorkspaceSyncStatuses).toHaveBeenCalledTimes(failedCalls);
        publishHomeAccountChange(scope.serverId, undefined, { source: 'connected' });
        await vi.advanceTimersByTimeAsync(0);
        expect(getWorkspaceSyncStatusSnapshot(scope)).toMatchObject({ phase: 'ready', status, error: null });
        expect(listWorkspaceSyncStatuses).not.toHaveBeenCalled();
        unsubscribe();
    });

    it('refreshes admitted relationship reads after a content-free Machine publication without admitting private payloads', async () => {
        const scope = { serverId: workspace.serverId, controllerMachineId: 'machine-a', relationshipId: 'private-relationship' };
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
        const scope = { serverId: workspace.serverId, controllerMachineId: 'machine-a', relationshipId: 'relationship-1' };
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
        await vi.waitFor(() => expect(listWorkspaceSyncStatuses).toHaveBeenCalledOnce());
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
            serverId: workspace.serverId, controllerMachineId: 'machine-a', relationshipId,
        }));
        listWorkspaceSyncStatuses.mockResolvedValueOnce([{
            relationshipId: 'relationship-2', controllerMachineId: 'machine-a', state: 'conflicted',
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
        const scope = { serverId: workspace.serverId, controllerMachineId: 'machine-a', relationshipId: 'relationship-1' };
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
        const pending = refreshWorkspaceSyncStatuses([scope]);
        expect(getWorkspaceSyncStatusSnapshot(scope)).toMatchObject({ phase: 'refreshing', status });
        const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        resetWorkspaceSyncStatusStoreForTests();
        await cancelled;
    });

    it('keeps a new consumer joining an invalidated controller read from seeing its stale result', async () => {
        const scope = { serverId: workspace.serverId, controllerMachineId: 'machine-a', relationshipId: 'relationship-1' };
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
        const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        await vi.waitFor(() => expect(listWorkspaceSyncStatuses).toHaveBeenCalledOnce());
        applyWorkspaceSyncRuntimeEvent({ serverId: scope.serverId, machineId: scope.controllerMachineId,
            event: { v: 1, readiness: { engine: { state: 'ready' }, carrier: { state: 'ready' } } } });
        const observedStates: string[] = [];
        const unsubscribeLate = subscribeWorkspaceSyncStatus(lateScope, () => {
            const snapshot = getWorkspaceSyncStatusSnapshot(lateScope);
            if (snapshot.phase === 'ready' && snapshot.status) observedStates.push(snapshot.status.state);
        });
        const joined = refreshWorkspaceSyncStatuses([lateScope]);
        resolveStale([status]);
        await Promise.all([cancelled, joined]);
        expect(observedStates).toEqual(['paused']);
        expect(listWorkspaceSyncStatuses).toHaveBeenCalledTimes(2);
        unsubscribe();
        unsubscribeLate();
    });

    it('rejects a pending individual read after Machine invalidation refreshes its admitted controller', async () => {
        const scope = { serverId: workspace.serverId, controllerMachineId: 'machine-a', relationshipId: 'relationship-1' };
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
        await vi.waitFor(() => expect(getWorkspaceSyncStatus).toHaveBeenCalledOnce());
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
        const scope = { serverId: workspace.serverId, controllerMachineId: 'machine-a', relationshipId: 'relationship-1' } as const;

        const first = refreshWorkspaceSyncStatus(scope);
        const second = refreshWorkspaceSyncStatus(scope);
        await vi.waitFor(() => expect(getWorkspaceSyncStatus).toHaveBeenCalledTimes(1));
        expect(getWorkspaceSyncStatusSnapshot(scope)).toMatchObject({ phase: 'loading', status: null });

        resolveFirst({
            relationshipId: 'relationship-1', controllerMachineId: 'machine-a', state: 'watching',
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
        await vi.waitFor(() => expect(getWorkspaceSyncStatus).toHaveBeenCalledTimes(2));
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
        const scope = { serverId: workspace.serverId, controllerMachineId: 'machine-a', relationshipId: 'relationship-1' };
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
        const scope = { serverId: workspace.serverId, controllerMachineId: 'machine-a', relationshipId: 'relationship-1' } as const;
        applyWorkspaceSyncStatusEvent(scope, {
            relationshipId: 'relationship-1', controllerMachineId: 'machine-a', state: 'paused',
            alphaPath: '/alpha', betaPath: '/beta', mode: 'keep_synced',
            endpointStates: { alpha: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 }, beta: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 } },
            conflictCount: 0, lastCycleObservedAtMs: 1,
        });

        expect(getWorkspaceSyncStatusSnapshot(scope)).toMatchObject({ phase: 'ready', status: { state: 'paused' } });
        expect(getWorkspaceSyncStatusSnapshot({ ...scope, serverId: 'server-2' })).toMatchObject({ phase: 'idle', status: null });
        expect(getWorkspaceSyncStatusSnapshot({ ...scope, controllerMachineId: 'machine-2' })).toMatchObject({ phase: 'idle', status: null });
    });

    it('keeps a closed summary subscriber stable when a daemon repeats the same status', () => {
        const scope = { serverId: workspace.serverId, controllerMachineId: 'machine-a', relationshipId: 'relationship-1' } as const;
        const status = {
            relationshipId: 'relationship-1', controllerMachineId: 'machine-a', state: 'watching' as const,
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

    it('retains an already idle snapshot across repeated unobserved invalidations', () => {
        const scope = { serverId: workspace.serverId, controllerMachineId: 'machine-a', relationshipId: 'relationship-1' };
        const initial = getWorkspaceSyncStatusSnapshot(scope);
        invalidateWorkspaceSyncStatuses(scope);
        invalidateWorkspaceSyncStatuses(scope);
        expect(getWorkspaceSyncStatusSnapshot(scope)).toBe(initial);
        expect(listWorkspaceSyncStatuses).not.toHaveBeenCalled();
    });

    it('reconciles status endpoints at publication while keeping freshness and recovery observable', async () => {
        const scope = { serverId: workspace.serverId, controllerMachineId: 'machine-a', relationshipId: 'relationship-1' };
        const status = {
            relationshipId: scope.relationshipId, controllerMachineId: scope.controllerMachineId, state: 'watching' as const,
            alphaPath: '/alpha', betaPath: '/beta', mode: 'keep_synced' as const,
            endpointStates: { alpha: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 }, beta: null },
            conflictCount: 0, lastCycleObservedAtMs: 1,
        };
        applyWorkspaceSyncStatusEvent(scope, status);
        const listener = vi.fn();
        subscribeWorkspaceSyncStatus(scope, listener);
        const failure = new Error('daemon unavailable');
        getWorkspaceSyncStatus.mockRejectedValueOnce(failure);
        await expect(refreshWorkspaceSyncStatus(scope)).rejects.toBeInstanceOf(Error);
        expect(getWorkspaceSyncStatusSnapshot(scope)).toMatchObject({ phase: 'error', status });
        applyWorkspaceSyncStatusEvent(scope, { ...status, endpointStates: { ...status.endpointStates, alpha: { ...status.endpointStates.alpha } } });
        const recovered = getWorkspaceSyncStatusSnapshot(scope);
        expect(recovered).toMatchObject({ phase: 'ready', error: null });
        expect(recovered.status).toBe(status);
        expect(listener).toHaveBeenCalledTimes(3);
        applyWorkspaceSyncStatusEvent(scope, { ...status, lastCycleObservedAtMs: 2,
            endpointStates: { ...status.endpointStates, alpha: { ...status.endpointStates.alpha } } });
        const fresh = getWorkspaceSyncStatusSnapshot(scope);
        expect(fresh.status?.lastCycleObservedAtMs).toBe(2);
        expect(fresh.status?.endpointStates).toBe(status.endpointStates);
        expect(listener).toHaveBeenCalledTimes(4);
    });

    it('does not let an older in-flight refresh overwrite a newer runtime status event', async () => {
        let resolveRefresh!: (value: unknown) => void;
        getWorkspaceSyncStatus.mockImplementationOnce(() => new Promise((resolve) => {
            resolveRefresh = resolve;
        }));
        const scope = { serverId: workspace.serverId, controllerMachineId: 'machine-a', relationshipId: 'relationship-1' } as const;

        const refresh = refreshWorkspaceSyncStatus(scope);
        await vi.waitFor(() => expect(getWorkspaceSyncStatus).toHaveBeenCalledOnce());
        applyWorkspaceSyncStatusEvent(scope, {
            relationshipId: 'relationship-1', controllerMachineId: 'machine-a', state: 'paused',
            alphaPath: '/alpha', betaPath: '/beta', mode: 'keep_synced',
            endpointStates: { alpha: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 }, beta: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 } },
            conflictCount: 0, lastCycleObservedAtMs: 2,
        });
        resolveRefresh({
            relationshipId: 'relationship-1', controllerMachineId: 'machine-a', state: 'watching',
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
