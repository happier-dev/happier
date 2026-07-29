import * as React from 'react';
import { createProviderErrorV1 } from '@happier-dev/protocol';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

const describeProviderConnectionModels = vi.hoisted(() => vi.fn());
vi.mock('@/providers/rpc/client', () => ({
    describeProviderConnectionModels,
    providerErrorFromRpcFailure: (_caught: unknown, context: Readonly<Record<string, unknown>>) =>
        createProviderErrorV1('provider_endpoint_unavailable', context),
}));

import { useProviderConnectionModels } from './useProviderConnectionModels';

describe('useProviderConnectionModels', () => {
    it('drops a delayed catalog from the previous machine', async () => {
        let resolveA!: (value: unknown) => void;
        describeProviderConnectionModels
            .mockImplementationOnce(() => new Promise((resolve) => { resolveA = resolve; }))
            .mockResolvedValueOnce({
                status: 'success', connectionId: 'pc_a', connectionRevision: 2, manualModelPolicy: 'allowed', modelLoadAction: 'descriptor_absent',
                models: [{ id: 'b', source: 'probe', stale: false, loadState: 'unknown', visibility: 'visible' }],
            });
        const value: { current: ReturnType<typeof useProviderConnectionModels> | null } = { current: null };
        function Harness(props: { machineId: string }) {
            value.current = useProviderConnectionModels({ enabled: true, machineId: props.machineId, serverId: 'server', connectionId: 'pc_a' });
            return React.createElement('View');
        }
        const screen = await renderScreen(<Harness machineId="machine-a" />);
        await screen.update(<Harness machineId="machine-b" />);
        await act(async () => {});
        expect(value.current?.models[0]?.id).toBe('b');
        await act(async () => resolveA({
            status: 'success', connectionId: 'pc_a', connectionRevision: 1, manualModelPolicy: 'allowed', modelLoadAction: 'descriptor_absent',
            models: [{ id: 'a', source: 'probe', stale: false, loadState: 'unknown', visibility: 'visible' }],
        }));
        expect(value.current?.models[0]?.id).toBe('b');
    });

    it('clears the last catalog when the machine/server scope changes', async () => {
        describeProviderConnectionModels
            .mockResolvedValueOnce({
                status: 'success', connectionId: 'pc_a', connectionRevision: 2, manualModelPolicy: 'allowed', modelLoadAction: 'available',
                models: [{ id: 'a', source: 'probe', stale: false, loadState: 'unknown', visibility: 'visible' }],
            })
            .mockRejectedValueOnce(new Error('offline'));
        const value: { current: ReturnType<typeof useProviderConnectionModels> | null } = { current: null };
        function Harness(props: { serverId: string }) {
            value.current = useProviderConnectionModels({
                enabled: true, machineId: 'machine-a', serverId: props.serverId, connectionId: 'pc_a',
            });
            return React.createElement('View');
        }
        const screen = await renderScreen(<Harness serverId="server-a" />);
        await act(async () => {});
        expect(value.current?.models).toHaveLength(1);
        expect(value.current?.modelLoadAction).toBe('available');
        await screen.update(<Harness serverId="server-b" />);
        await act(async () => {});
        expect(value.current).toMatchObject({ models: [], connectionRevision: null, manualModelPolicy: null, modelLoadAction: null, loading: false });
    });

    it('retains the last catalog when a same-scope refresh fails', async () => {
        describeProviderConnectionModels
            .mockResolvedValueOnce({
                status: 'success', connectionId: 'pc_a', connectionRevision: 2, manualModelPolicy: 'allowed', modelLoadAction: 'available',
                models: [{ id: 'a', source: 'probe', stale: false, loadState: 'unknown', visibility: 'visible' }],
            })
            .mockRejectedValueOnce(new Error('offline'));
        const value: { current: ReturnType<typeof useProviderConnectionModels> | null } = { current: null };
        function Harness() {
            value.current = useProviderConnectionModels({ enabled: true, machineId: 'machine-a', serverId: 'server-a', connectionId: 'pc_a' });
            return React.createElement('View');
        }
        await renderScreen(<Harness />);
        await act(async () => {});
        await act(async () => { await value.current?.refresh(); });
        expect(value.current).toMatchObject({
            models: [{ id: 'a' }],
            connectionRevision: 2,
            error: createProviderErrorV1('provider_endpoint_unavailable', {
                connectionId: 'pc_a',
                machineId: 'machine-a',
            }),
            loading: false,
        });
    });
});
