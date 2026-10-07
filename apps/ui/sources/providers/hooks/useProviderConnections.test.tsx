import * as React from 'react';
import { createProviderErrorV1 } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    createProviderConnectionsDescribeFixture,
    createProviderConnectionViewFixture,
    flushHookEffects,
    renderHook,
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';

const machineRpcWithServerScope = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope }));
installDisconnectedServerSocketBoundary();
let accountConnection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;

import { useProviderConnections } from './useProviderConnections';
import { useProviderConnectionMutation } from './useProviderConnectionMutation';

describe('useProviderConnections', () => {
    afterEach(async () => {
        standardCleanup();
        await accountConnection?.dispose();
        accountConnection = null;
    });
    beforeEach(() => { machineRpcWithServerScope.mockReset(); });

    it('refreshes visible peers after a same-route mutation and refreshes hidden projections only when revealed', async () => {
        let connectionExists = true;
        machineRpcWithServerScope.mockImplementation(async (request: { method: string; machineId: string; serverId: string }) => {
            if (request.method === RPC_METHODS.DAEMON_PROVIDERS_CONNECTION_MUTATE) {
                connectionExists = false;
                return { status: 'success', action: 'delete', deletedConnectionId: 'pc_a' };
            }
            return createProviderConnectionsDescribeFixture({
                connections: connectionExists ? [createProviderConnectionViewFixture({ connectionId: 'pc_a' })] : [],
            });
        });
        const resolveTarget = () => ({ machineId: 'machine-a', serverId: 'server-a' });
        const hook = await renderHook(({ visible }: { visible: boolean }) => {
            const list = useProviderConnections({ enabled: true, active: visible, ...resolveTarget() });
            const detail = useProviderConnections({ enabled: true, ...resolveTarget(), connectionId: 'pc_a' });
            const otherServer = useProviderConnections({ enabled: true, machineId: 'machine-a', serverId: 'server-b' });
            const otherMachine = useProviderConnections({ enabled: true, machineId: 'machine-b', serverId: 'server-a' });
            const refresh = React.useCallback(async () => { await detail.refresh(); }, [detail.refresh]);
            const mutation = useProviderConnectionMutation({ resolveTarget, refresh });
            return { list, detail, otherServer, otherMachine, mutation };
        }, { initialProps: { visible: true } });
        expect(hook.getCurrent().list.data?.connections).toHaveLength(1);
        machineRpcWithServerScope.mockClear();

        await act(async () => {
            await hook.getCurrent().mutation.run({ action: 'delete', machineId: 'machine-a', connectionId: 'pc_a' });
        });
        expect(hook.getCurrent().detail.data?.connections).toHaveLength(0);
        expect(hook.getCurrent().list.data?.connections).toHaveLength(0);
        expect(hook.getCurrent().otherServer.data?.connections).toHaveLength(1);
        expect(hook.getCurrent().otherMachine.data?.connections).toHaveLength(1);
        expect(machineRpcWithServerScope.mock.calls.map(([request]) => request)).toHaveLength(3);
        expect(machineRpcWithServerScope.mock.calls.every(([request]) => request.machineId === 'machine-a' && request.serverId === 'server-a')).toBe(true);

        await hook.rerender({ visible: false });
        connectionExists = true;
        machineRpcWithServerScope.mockClear();
        await act(async () => { await hook.getCurrent().detail.refresh(); });
        expect(machineRpcWithServerScope).toHaveBeenCalledOnce();
        expect(hook.getCurrent().list.data?.connections).toHaveLength(0);
        await hook.rerender({ visible: true });
        expect(hook.getCurrent().list.data?.connections).toHaveLength(1);
        expect(machineRpcWithServerScope).toHaveBeenCalledTimes(2);
    });

    it('performs no Provider RPC when the canonical root feature decision is disabled', async () => {
        const hook = await renderHook(() => useProviderConnections({
            enabled: false,
            machineId: 'machine-a',
            serverId: 'server-a',
        }));

        expect(hook.getCurrent()).toMatchObject({ data: null, error: null, loading: false });
        expect(machineRpcWithServerScope).not.toHaveBeenCalled();
    });

    it('does not hold the selected query refresh open while a supporting pane is still reading', async () => {
        let holdCollection = false;
        let finishCollection!: (response: ReturnType<typeof createProviderConnectionsDescribeFixture>) => void;
        machineRpcWithServerScope.mockImplementation(async (request: { payload: { connectionId?: string } }) => {
            if (holdCollection && !request.payload.connectionId) {
                return await new Promise((resolve) => { finishCollection = resolve; });
            }
            return createProviderConnectionsDescribeFixture({ connections: [] });
        });
        const hook = await renderHook(() => {
            useProviderConnections({ enabled: true, machineId: 'machine-a', serverId: 'server-a' });
            return useProviderConnections({ enabled: true, machineId: 'machine-a', serverId: 'server-a', connectionId: 'pc_a' });
        });
        holdCollection = true;
        let completed = false;
        await act(async () => {
            void hook.getCurrent().refresh().then(() => { completed = true; });
            await flushHookEffects();
        });
        try {
            expect(completed).toBe(true);
        } finally {
            await act(async () => {
                finishCollection(createProviderConnectionsDescribeFixture({ connections: [] }));
            });
        }
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

    it('never exposes a prior exact target during the render that changes machine, server, or connection', async () => {
        machineRpcWithServerScope
            .mockResolvedValueOnce(createProviderConnectionsDescribeFixture({
                connections: [createProviderConnectionViewFixture({ connectionId: 'pc_a' })],
            }))
            .mockImplementation(() => new Promise(() => undefined));
        const observations: Array<Readonly<{
            scope: string;
            connectionId: string | null;
        }>> = [];
        function Harness(props: Readonly<{ machineId: string; serverId: string; connectionId: string }>) {
            const value = useProviderConnections({ enabled: true, ...props });
            observations.push({
                scope: `${props.serverId}/${props.machineId}/${props.connectionId}`,
                connectionId: value.data?.connections[0]?.connectionId ?? null,
            });
            return React.createElement('View');
        }
        const screen = await renderScreen(
            <Harness machineId="machine-a" serverId="server-a" connectionId="pc_a" />,
        );
        expect(observations.at(-1)?.connectionId).toBe('pc_a');

        for (const next of [
            { machineId: 'machine-b', serverId: 'server-a', connectionId: 'pc_a' },
            { machineId: 'machine-b', serverId: 'server-b', connectionId: 'pc_a' },
            { machineId: 'machine-b', serverId: 'server-b', connectionId: 'pc_b' },
        ]) {
            const scope = `${next.serverId}/${next.machineId}/${next.connectionId}`;
            await screen.update(<Harness {...next} />);
            expect(observations.some((entry) => (
                entry.scope === scope && entry.connectionId === 'pc_a'
            ))).toBe(false);
        }
    });

    it('clears Account A, rejects its late read, and starts one Account B read when routing ids stay equal', async () => {
        accountConnection = await restoreServerAccountForTest({ serverUrl: 'https://provider-lifetime.test', accountId: 'account-a' });
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
            await accountConnection!.dispose();
            accountConnection = await restoreServerAccountForTest({ serverUrl: 'https://provider-lifetime.test', accountId: 'account-b' });
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

    it('retains the same-scope projection while exposing an untyped refresh transport failure', async () => {
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
            error: createProviderErrorV1('agent_error', {
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
