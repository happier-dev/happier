import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProviderErrorV1 } from '@happier-dev/protocol';

import { renderScreen, standardCleanup } from '@/dev/testkit';

const machineRpcWithServerScope = vi.hoisted(() => vi.fn());
type TestAccountLifetime = Readonly<{
    isCurrent(): boolean;
    onRetire(cancel: () => void): Readonly<{ dispose(): void }>;
}>;
const activeAccountLifetime = vi.hoisted(() => {
    const current: { value: TestAccountLifetime | null } = { value: null };
    return {
        current,
        create() {
            let retired = false;
            const retirements = new Set<() => void>();
            const lifetime: TestAccountLifetime = {
                isCurrent: () => !retired,
                onRetire(cancel) {
                    if (retired) {
                        cancel();
                        return { dispose() {} };
                    }
                    retirements.add(cancel);
                    return { dispose: () => retirements.delete(cancel) };
                },
            };
            return {
                lifetime,
                retire() {
                    retired = true;
                    for (const cancel of [...retirements]) cancel();
                    retirements.clear();
                },
            };
        },
    };
});
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope }));
vi.mock('@/sync/domains/scope/activeServerAccountScope', () => ({
    captureActiveServerAccountScopeLifetime: () => activeAccountLifetime.current.value,
}));

import { useProviderModelLoadAction } from './useProviderModelLoadAction';

function createDeferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((next) => { resolve = next; });
    return { promise, resolve };
}

describe('useProviderModelLoadAction', () => {
    afterEach(() => {
        activeAccountLifetime.current.value = null;
        standardCleanup();
    });
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

    it('clears Account A model-load state and refuses its late settlement after Account B mounts', async () => {
        const accountA = activeAccountLifetime.create();
        const accountB = activeAccountLifetime.create();
        activeAccountLifetime.current.value = accountA.lifetime;
        const loadResult = createDeferred<{ status: 'loaded'; source: 'requested' }>();
        machineRpcWithServerScope.mockReturnValueOnce(loadResult.promise);
        const refresh = vi.fn(async () => true);
        const value: { current: ReturnType<typeof useProviderModelLoadAction> | null } = { current: null };
        function Harness() {
            value.current = useProviderModelLoadAction({
                machineId: 'machine-a', serverId: 'server-a', refresh,
            });
            return React.createElement('View');
        }
        const rendered = await renderScreen(<Harness />);

        let pending!: Promise<unknown>;
        await act(async () => {
            pending = value.current!.load('pc_a', 'model-a');
            await Promise.resolve();
        });
        expect(value.current?.loadingModelKey).not.toBeNull();

        let staleCancelResult: unknown;
        await act(async () => {
            activeAccountLifetime.current.value = accountB.lifetime;
            accountA.retire();
            staleCancelResult = await value.current!.cancel();
            await rendered.update(<Harness />);
        });

        expect(value.current?.loadingModelKey).toBeNull();
        expect(value.current?.cancelledProviderMayContinue).toBe(false);
        expect(staleCancelResult).toEqual({ status: 'cancelled', providerMayContinue: true });
        expect(machineRpcWithServerScope).toHaveBeenCalledTimes(1);
        await expect(pending).resolves.toEqual({ status: 'cancelled', providerMayContinue: true });

        await act(async () => loadResult.resolve({ status: 'loaded', source: 'requested' }));
        expect(refresh).not.toHaveBeenCalled();
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

    it('does not start a model load when the canonical execution target changed', async () => {
        const value: { current: ReturnType<typeof useProviderModelLoadAction> | null } = { current: null };
        function Harness() {
            value.current = useProviderModelLoadAction({
                machineId: 'machine-a',
                serverId: 'server-a',
                refresh: async () => true,
                resolveExecutionTarget: () => ({ machineId: 'machine-b', serverId: 'server-b' }),
            });
            return React.createElement('View');
        }
        await renderScreen(<Harness />);

        let result: unknown;
        await act(async () => { result = await value.current?.load('pc_a', 'model-a'); });

        expect(result).toEqual({
            status: 'error',
            error: createProviderErrorV1('provider_authorization_changed', {
                connectionId: 'pc_a',
                machineId: 'machine-a',
            }),
        });
        expect(machineRpcWithServerScope).not.toHaveBeenCalled();
    });

    it('does not fall back to the rendered target when the canonical execution target is unavailable', async () => {
        const value: { current: ReturnType<typeof useProviderModelLoadAction> | null } = { current: null };
        function Harness() {
            value.current = useProviderModelLoadAction({
                machineId: 'machine-a',
                serverId: 'server-a',
                refresh: async () => true,
                resolveExecutionTarget: () => null,
            });
            return React.createElement('View');
        }
        await renderScreen(<Harness />);

        let result: unknown;
        await act(async () => { result = await value.current?.load('pc_a', 'model-a'); });

        expect(result).toEqual({
            status: 'error',
            error: createProviderErrorV1('provider_machine_unavailable', {
                connectionId: 'pc_a',
                machineId: 'machine-a',
            }),
        });
        expect(machineRpcWithServerScope).not.toHaveBeenCalled();
    });

    it('loads through the routing id the target resolves to at effect time', async () => {
        // The device-local routing id of the selected server identity can be
        // replaced between the render that built the row and the load itself.
        // The machine did not change, so the load must follow the freshly
        // resolved routing id — the same contract every other Provider effect
        // holds — instead of reporting the endpoint unavailable.
        machineRpcWithServerScope.mockResolvedValueOnce({ status: 'loaded', source: 'requested' });
        const value: { current: ReturnType<typeof useProviderModelLoadAction> | null } = { current: null };
        function Harness() {
            value.current = useProviderModelLoadAction({
                machineId: 'machine-a',
                serverId: 'server-a',
                refresh: async () => true,
                resolveExecutionTarget: () => ({
                    machineId: 'machine-a',
                    serverId: 'server-a-reconnected',
                }),
            });
            return React.createElement('View');
        }
        await renderScreen(<Harness />);

        let result: unknown;
        await act(async () => { result = await value.current?.load('pc_a', 'model-a'); });

        expect(result).toEqual({ status: 'loaded', source: 'requested' });
        expect(machineRpcWithServerScope).toHaveBeenCalledWith(expect.objectContaining({
            serverId: 'server-a-reconnected',
        }));
    });
});
