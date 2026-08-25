import * as React from 'react';
import { createProviderErrorV1 } from '@happier-dev/protocol';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

const describeProviderConnectionModels = vi.hoisted(() => vi.fn());
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
vi.mock('@/providers/rpc/client', () => ({
    describeProviderConnectionModels,
    providerErrorFromRpcFailure: (_caught: unknown, context: Readonly<Record<string, unknown>>) =>
        createProviderErrorV1('provider_endpoint_unavailable', context),
}));
vi.mock('@/sync/domains/scope/activeServerAccountScope', () => ({
    captureActiveServerAccountScopeLifetime: () => activeAccountLifetime.current.value,
}));

import { useProviderConnectionModels } from './useProviderConnectionModels';

describe('useProviderConnectionModels', () => {
    afterEach(() => {
        activeAccountLifetime.current.value = null;
        describeProviderConnectionModels.mockReset();
        standardCleanup();
    });

    it('clears Account A catalog and starts one Account B read when routing ids stay equal', async () => {
        const accountA = activeAccountLifetime.create();
        const accountB = activeAccountLifetime.create();
        activeAccountLifetime.current.value = accountA.lifetime;
        let resolveA!: (value: unknown) => void;
        let resolveB!: (value: unknown) => void;
        describeProviderConnectionModels
            .mockImplementationOnce(() => new Promise((resolve) => { resolveA = resolve; }))
            .mockImplementationOnce(() => new Promise((resolve) => { resolveB = resolve; }));
        const value: { current: ReturnType<typeof useProviderConnectionModels> | null } = { current: null };
        function Harness() {
            value.current = useProviderConnectionModels({
                enabled: true, machineId: 'machine-a', serverId: 'server-a', connectionId: 'pc_a',
            });
            return React.createElement('View');
        }
        const screen = await renderScreen(<Harness />);
        const refreshFromAccountA = value.current?.refresh;
        expect(describeProviderConnectionModels).toHaveBeenCalledTimes(1);

        await act(async () => {
            activeAccountLifetime.current.value = accountB.lifetime;
            accountA.retire();
            await screen.update(<Harness />);
        });

        expect(value.current?.models).toEqual([]);
        await act(async () => {});
        expect(describeProviderConnectionModels).toHaveBeenCalledTimes(2);

        await act(async () => {
            resolveA({
                status: 'success', connectionId: 'pc_a', connectionRevision: 1,
                manualModelPolicy: 'allowed', modelLoadAction: 'available',
                models: [{ id: 'a', source: 'probe', stale: false, loadState: 'unknown', visibility: 'visible' }],
            });
        });
        expect(value.current?.models).toEqual([]);

        await act(async () => {
            resolveB({
                status: 'success', connectionId: 'pc_a', connectionRevision: 2,
                manualModelPolicy: 'allowed', modelLoadAction: 'available',
                models: [{ id: 'b', source: 'probe', stale: false, loadState: 'unknown', visibility: 'visible' }],
            });
        });
        expect(value.current?.models[0]?.id).toBe('b');

        await act(async () => { await refreshFromAccountA?.(); });
        expect(describeProviderConnectionModels).toHaveBeenCalledTimes(2);
        expect(value.current?.models[0]?.id).toBe('b');
    });

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
