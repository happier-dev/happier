import * as React from 'react';
import { createProviderErrorV1 } from '@happier-dev/protocol';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    createProviderConnectionsDescribeFixture,
    createProviderConnectionViewFixture,
    renderHook,
    standardCleanup,
} from '@/dev/testkit';

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
            const cancellations = new Set<() => void>();
            const lifetime: TestAccountLifetime = {
                isCurrent: () => !retired,
                onRetire(cancel) {
                    if (retired) {
                        cancel();
                        return { dispose() {} };
                    }
                    cancellations.add(cancel);
                    return { dispose: () => cancellations.delete(cancel) };
                },
            };
            return {
                lifetime,
                retire() {
                    if (retired) return;
                    retired = true;
                    for (const cancel of [...cancellations]) cancel();
                    cancellations.clear();
                },
            };
        },
    };
});
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope }));
vi.mock('@/sync/domains/scope/activeServerAccountScope', () => ({
    captureActiveServerAccountScopeLifetime: () => activeAccountLifetime.current.value,
}));

import { useProviderConnections } from './useProviderConnections';

describe('useProviderConnections', () => {
    afterEach(() => {
        activeAccountLifetime.current.value = null;
        standardCleanup();
    });
    beforeEach(() => machineRpcWithServerScope.mockReset());

    it('performs no Provider RPC when the canonical root feature decision is disabled', async () => {
        const hook = await renderHook(() => useProviderConnections({
            enabled: false,
            machineId: 'machine-a',
            serverId: 'server-a',
        }));

        expect(hook.getCurrent()).toMatchObject({ data: null, error: null, loading: false });
        expect(machineRpcWithServerScope).not.toHaveBeenCalled();
    });

    it('clears machine A projection before awaiting machine B', async () => {
        machineRpcWithServerScope.mockResolvedValueOnce(createProviderConnectionsDescribeFixture({
            connections: [createProviderConnectionViewFixture({ connectionId: 'pc_a' })],
        }));
        machineRpcWithServerScope.mockImplementationOnce(() => new Promise(() => undefined));
        const hook = await renderHook(
            ({ machineId }: { machineId: string }) => useProviderConnections({
                enabled: true, machineId, serverId: 'server-a',
            }),
            { initialProps: { machineId: 'machine-a' } },
        );
        expect(hook.getCurrent().data?.connections[0]?.connectionId).toBe('pc_a');

        await hook.rerender({ machineId: 'machine-b' });
        expect(hook.getCurrent().data).toBeNull();
    });

    it('clears Account A, rejects its late read, and starts one Account B read when routing ids stay equal', async () => {
        const accountA = activeAccountLifetime.create();
        const accountB = activeAccountLifetime.create();
        activeAccountLifetime.current.value = accountA.lifetime;
        let resolveA!: (value: unknown) => void;
        let resolveB!: (value: unknown) => void;
        machineRpcWithServerScope
            .mockImplementationOnce(() => new Promise((resolve) => { resolveA = resolve; }))
            .mockImplementationOnce(() => new Promise((resolve) => { resolveB = resolve; }));
        const hook = await renderHook(() => useProviderConnections({
            enabled: true,
            machineId: 'machine-a',
            serverId: 'server-a',
        }));
        const refreshFromAccountA = hook.getCurrent().refresh;
        expect(machineRpcWithServerScope).toHaveBeenCalledTimes(1);

        await act(async () => {
            activeAccountLifetime.current.value = accountB.lifetime;
            accountA.retire();
            await hook.rerender();
        });

        expect(hook.getCurrent().data).toBeNull();
        await act(async () => {});
        expect(machineRpcWithServerScope).toHaveBeenCalledTimes(2);

        await act(async () => {
            resolveA(createProviderConnectionsDescribeFixture({
                connections: [createProviderConnectionViewFixture({ connectionId: 'pc_a' })],
            }));
        });
        expect(hook.getCurrent().data).toBeNull();

        await act(async () => {
            resolveB(createProviderConnectionsDescribeFixture({
                connections: [createProviderConnectionViewFixture({ connectionId: 'pc_b' })],
            }));
        });
        expect(hook.getCurrent().data?.connections[0]?.connectionId).toBe('pc_b');

        await act(async () => { await refreshFromAccountA(); });
        expect(machineRpcWithServerScope).toHaveBeenCalledTimes(2);
        expect(hook.getCurrent().data?.connections[0]?.connectionId).toBe('pc_b');
    });

    it('retains the same-scope projection while exposing a refresh transport failure', async () => {
        machineRpcWithServerScope
            .mockResolvedValueOnce(createProviderConnectionsDescribeFixture({
                connections: [createProviderConnectionViewFixture({ connectionId: 'pc_a' })],
            }))
            .mockRejectedValueOnce(new Error('offline'));
        const hook = await renderHook(() => useProviderConnections({
            enabled: true, machineId: 'machine-a', serverId: 'server-a',
        }));
        await act(async () => { await hook.getCurrent().refresh(); });
        expect(hook.getCurrent()).toMatchObject({
            data: { connections: [{ connectionId: 'pc_a' }] },
            error: createProviderErrorV1('provider_machine_unavailable', {
                machineId: 'machine-a',
            }),
            loading: false,
        });
    });

    it('reports a successful transport with an invalid response as a contract failure, not an unreachable endpoint', async () => {
        machineRpcWithServerScope.mockResolvedValueOnce({
            ...createProviderConnectionsDescribeFixture({ connections: [] }),
            rawSecret: 'must-not-surface',
        });

        const hook = await renderHook(() => useProviderConnections({
            enabled: true, machineId: 'machine-a', serverId: 'server-a',
        }));

        expect(hook.getCurrent()).toMatchObject({
            data: null,
            error: {
                v: 1,
                code: 'provider_rpc_response_invalid',
                machineId: 'machine-a',
                retryable: true,
                action: 'retry',
            },
            loading: false,
        });
        expect(hook.getCurrent().error?.code).not.toBe('provider_endpoint_unavailable');
    });
});
