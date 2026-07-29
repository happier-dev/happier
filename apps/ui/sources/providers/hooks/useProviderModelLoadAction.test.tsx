import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProviderErrorV1 } from '@happier-dev/protocol';

import { renderScreen, standardCleanup } from '@/dev/testkit';

const machineRpcWithServerScope = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope }));

import { useProviderModelLoadAction } from './useProviderModelLoadAction';

function createDeferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((next) => { resolve = next; });
    return { promise, resolve };
}

describe('useProviderModelLoadAction', () => {
    afterEach(standardCleanup);
    beforeEach(() => machineRpcWithServerScope.mockReset());

    it('keeps mounted load state functional through the StrictMode effect replay', async () => {
        let resolveLoad!: (value: { status: 'loaded'; source: 'requested' }) => void;
        machineRpcWithServerScope.mockReturnValueOnce(new Promise((resolve) => { resolveLoad = resolve; }));
        const value: { current: ReturnType<typeof useProviderModelLoadAction> | null } = { current: null };
        function Harness() {
            value.current = useProviderModelLoadAction({
                machineId: 'machine-a', serverId: 'server-a', refresh: async () => true,
            });
            return React.createElement('View');
        }
        await renderScreen(<React.StrictMode><Harness /></React.StrictMode>);

        let pending!: Promise<unknown>;
        await act(async () => {
            pending = value.current!.load('pc_a', 'model-a');
            await Promise.resolve();
        });
        expect(value.current?.loadingModelKey).toBe(JSON.stringify(['provider-model', 'pc_a', 'model-a']));

        await act(async () => {
            resolveLoad({ status: 'loaded', source: 'requested' });
            await pending;
        });
        expect(value.current?.loadingModelKey).toBeNull();
    });

    it('refreshes the catalog only after a confirmed loaded result', async () => {
        machineRpcWithServerScope.mockResolvedValueOnce({ status: 'loaded', source: 'requested' });
        const refresh = vi.fn(async () => true);
        const value: { current: ReturnType<typeof useProviderModelLoadAction> | null } = { current: null };
        function Harness() {
            value.current = useProviderModelLoadAction({ machineId: 'machine-a', serverId: 'server-a', refresh });
            return React.createElement('View');
        }
        await renderScreen(<Harness />);
        let result: unknown;
        await act(async () => { result = await value.current?.load('pc_a', 'model-a'); });
        expect(result).toEqual({ status: 'loaded', source: 'requested' });
        expect(refresh).toHaveBeenCalledTimes(1);
        expect(value.current?.loadingModelKey).toBeNull();
    });

    it('cancels the exact active load, stops local waiting, and reports Provider continuation truthfully', async () => {
        const loadNeverSettles = new Promise<never>(() => {});
        machineRpcWithServerScope
            .mockReturnValueOnce(loadNeverSettles)
            .mockResolvedValueOnce({ status: 'cancelled', providerMayContinue: true });
        const refresh = vi.fn(async () => false);
        const value: { current: ReturnType<typeof useProviderModelLoadAction> | null } = { current: null };
        function Harness() {
            value.current = useProviderModelLoadAction({ machineId: 'machine-a', serverId: 'server-a', refresh });
            return React.createElement('View');
        }
        await renderScreen(<Harness />);

        let pending!: Promise<unknown>;
        await act(async () => {
            pending = value.current!.load('pc_a', 'model-a');
            await Promise.resolve();
        });
        const loadSignal = machineRpcWithServerScope.mock.calls[0]?.[0]?.signal as AbortSignal | undefined;
        expect(loadSignal?.aborted).toBe(false);

        let cancelResult: unknown;
        await act(async () => {
            cancelResult = await value.current!.cancel();
        });
        await expect(pending).resolves.toEqual({ status: 'cancelled', providerMayContinue: true });
        expect(cancelResult).toEqual({ status: 'cancelled', providerMayContinue: true });
        expect(loadSignal?.aborted).toBe(true);
        expect(machineRpcWithServerScope.mock.calls[1]?.[0]?.payload).toEqual({
            action: 'cancel',
            connectionId: 'pc_a',
            machineId: 'machine-a',
            modelId: 'model-a',
        });
        expect(refresh).not.toHaveBeenCalled();
        expect(value.current?.loadingModelKey).toBeNull();
        expect(value.current?.cancelledProviderMayContinue).toBe(true);
    });

    it('reconciles an unknown transport outcome as loaded without replaying the mutation', async () => {
        machineRpcWithServerScope.mockRejectedValueOnce(new Error('acknowledgement lost after dispatch'));
        const refresh = vi.fn(async () => true);
        const value: { current: ReturnType<typeof useProviderModelLoadAction> | null } = { current: null };
        function Harness() {
            value.current = useProviderModelLoadAction({ machineId: 'machine-a', serverId: 'server-a', refresh });
            return React.createElement('View');
        }
        await renderScreen(<Harness />);
        let result: unknown;
        await act(async () => { result = await value.current?.load('pc_a', 'model-a'); });
        expect(result).toEqual({ status: 'loaded', source: 'reconciled' });
        expect(machineRpcWithServerScope).toHaveBeenCalledOnce();
        expect(refresh).toHaveBeenCalledOnce();
        expect(value.current?.loadingModelKey).toBeNull();
    });

    it('preserves an unknown outcome when the uncancelled load can commit after an unloaded reconciliation', async () => {
        const daemonCommit = createDeferred<void>();
        let committed = false;
        const originalLoad = daemonCommit.promise.then(() => {
            committed = true;
            return { status: 'loaded' as const, source: 'requested' as const };
        });
        const clientVisibleLoad = Promise.race([
            originalLoad,
            Promise.reject(new Error('client timeout while daemon load remains in flight')),
        ]);
        void clientVisibleLoad.catch(() => undefined);
        machineRpcWithServerScope.mockReturnValueOnce(clientVisibleLoad);
        const refresh = vi.fn(async () => false);
        const value: { current: ReturnType<typeof useProviderModelLoadAction> | null } = { current: null };
        function Harness() {
            value.current = useProviderModelLoadAction({ machineId: 'machine-a', serverId: 'server-a', refresh });
            return React.createElement('View');
        }
        await renderScreen(<Harness />);
        let result: unknown;
        await act(async () => { result = await value.current?.load('pc_a', 'model-a'); });
        expect(result).toEqual({
            status: 'error',
            error: createProviderErrorV1('provider_rpc_mutation_outcome_unknown', {
                connectionId: 'pc_a',
                machineId: 'machine-a',
            }),
        });
        expect(machineRpcWithServerScope).toHaveBeenCalledOnce();
        expect(refresh).toHaveBeenCalledOnce();
        expect(committed).toBe(false);
        daemonCommit.resolve();
        await expect(originalLoad).resolves.toEqual({ status: 'loaded', source: 'requested' });
        expect(committed).toBe(true);
    });

    it('preserves an acknowledged loaded result when the presentation refresh fails', async () => {
        machineRpcWithServerScope.mockResolvedValueOnce({ status: 'loaded', source: 'requested' });
        const refresh = vi.fn(async () => { throw new Error('refresh offline'); });
        const value: { current: ReturnType<typeof useProviderModelLoadAction> | null } = { current: null };
        function Harness() {
            value.current = useProviderModelLoadAction({ machineId: 'machine-a', serverId: 'server-a', refresh });
            return React.createElement('View');
        }
        await renderScreen(<Harness />);
        let result: unknown;
        await act(async () => { result = await value.current?.load('pc_a', 'model-a'); });
        expect(result).toEqual({ status: 'loaded', source: 'requested' });
        expect(refresh).toHaveBeenCalledTimes(1);
    });

    it('preserves an acknowledged loaded result when the presentation refresh is not yet current', async () => {
        machineRpcWithServerScope.mockResolvedValueOnce({ status: 'loaded', source: 'requested' });
        const refresh = vi.fn(async () => false);
        const value: { current: ReturnType<typeof useProviderModelLoadAction> | null } = { current: null };
        function Harness() {
            value.current = useProviderModelLoadAction({ machineId: 'machine-a', serverId: 'server-a', refresh });
            return React.createElement('View');
        }
        await renderScreen(<Harness />);
        let result: unknown;
        await act(async () => { result = await value.current?.load('pc_a', 'model-a'); });
        expect(result).toEqual({ status: 'loaded', source: 'requested' });
    });
});
