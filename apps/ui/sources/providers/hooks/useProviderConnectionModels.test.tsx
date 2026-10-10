import * as React from 'react';
import { createProviderErrorV1 } from '@happier-dev/protocol';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { createProviderSettingsAccountHarness } from '@/dev/testkit/harness/providerSettingsHarness';

const describeProviderConnectionModels = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (request: Readonly<{ payload: unknown }>) => describeProviderConnectionModels(request.payload),
}));
const account = createProviderSettingsAccountHarness();
let serverId = '';
let otherServerId = '';

const { useProviderConnectionModels } = await import('./useProviderConnectionModels');

describe('useProviderConnectionModels', () => {
    it('issues no catalog request while inactive and preserves the last catalog on blur', async () => {
        describeProviderConnectionModels.mockResolvedValue({
            status: 'success', connectionId: 'pc_a', connectionRevision: 1,
            manualModelPolicy: 'allowed', modelLoadAction: 'descriptor_absent',
            models: [{ id: 'model-a', source: 'probe', stale: false, loadState: 'unknown', visibility: 'visible' }],
        });
        const rendered = await renderHook((props: { active: boolean }) => useProviderConnectionModels({
            enabled: true, active: props.active, machineId: 'machine-a', serverId, connectionId: 'pc_a',
        }), { initialProps: { active: false } });
        await flushHookEffects();
        expect(describeProviderConnectionModels).toHaveBeenCalledTimes(0);
        await rendered.rerender({ active: true });
        await flushHookEffects();
        expect(describeProviderConnectionModels).toHaveBeenCalledTimes(1);
        const rows = rendered.getCurrent().models;
        expect(rows[0]?.id).toBe('model-a');
        const refresh = rendered.getCurrent().refresh;
        const refreshWithResult = rendered.getCurrent().refreshWithResult;
        await rendered.rerender({ active: false });
        await act(async () => { await refresh(); await refreshWithResult(); });
        expect(describeProviderConnectionModels).toHaveBeenCalledTimes(1);
        expect(rendered.getCurrent().models).toBe(rows);
        expect(rendered.getCurrent().refresh).toBe(refresh);
        expect(rendered.getCurrent().refreshWithResult).toBe(refreshWithResult);
    });

    beforeEach(async () => {
        serverId = (await account.restore()).serverId;
        otherServerId = await account.addHome({ name: 'Other Provider Home', serverUrl: 'https://provider-settings-other.test', accountId: 'account-a', active: false });
    });
    afterEach(async () => {
        describeProviderConnectionModels.mockReset();
        standardCleanup();
        await account.reset();
    });

    it('clears Account A catalog and starts one Account B read when routing ids stay equal', async () => {
        let resolveA!: (value: unknown) => void;
        let resolveB!: (value: unknown) => void;
        describeProviderConnectionModels
            .mockImplementationOnce(() => new Promise((resolve) => { resolveA = resolve; }))
            .mockImplementationOnce(() => new Promise((resolve) => { resolveB = resolve; }));
        const value: { current: ReturnType<typeof useProviderConnectionModels> | null } = { current: null };
        function Harness() {
            value.current = useProviderConnectionModels({
                enabled: true, machineId: 'machine-a', serverId, connectionId: 'pc_a',
            });
            return React.createElement('View');
        }
        const screen = await renderScreen(<Harness />);
        const refreshFromAccountA = value.current?.refresh;
        expect(describeProviderConnectionModels).toHaveBeenCalledTimes(1);

        await act(async () => {
            await account.restore({ accountId: 'account-b' });
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
            value.current = useProviderConnectionModels({ enabled: true, machineId: props.machineId, serverId, connectionId: 'pc_a' });
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

    it('never exposes a prior catalog during the render that changes machine, server, or connection', async () => {
        describeProviderConnectionModels
            .mockResolvedValueOnce({
                status: 'success', connectionId: 'pc_a', connectionRevision: 1,
                manualModelPolicy: 'allowed', modelLoadAction: 'available',
                models: [{ id: 'model-a', source: 'probe', stale: false, loadState: 'unknown', visibility: 'visible' }],
            })
            .mockImplementation(() => new Promise(() => undefined));
        const observations: Array<Readonly<{ scope: string; modelId: string | null }>> = [];
        function Harness(props: Readonly<{ machineId: string; serverId: string; connectionId: string }>) {
            const value = useProviderConnectionModels({ enabled: true, ...props });
            observations.push({
                scope: `${props.serverId}/${props.machineId}/${props.connectionId}`,
                modelId: value.models[0]?.id ?? null,
            });
            return React.createElement('View');
        }
        const screen = await renderScreen(
            <Harness machineId="machine-a" serverId={serverId} connectionId="pc_a" />,
        );
        expect(observations.at(-1)?.modelId).toBe('model-a');

        for (const next of [
            { machineId: 'machine-b', serverId, connectionId: 'pc_a' },
            { machineId: 'machine-b', serverId: otherServerId, connectionId: 'pc_a' },
            { machineId: 'machine-b', serverId: otherServerId, connectionId: 'pc_b' },
        ]) {
            const scope = `${next.serverId}/${next.machineId}/${next.connectionId}`;
            await screen.update(<Harness {...next} />);
            expect(observations.some((entry) => (
                entry.scope === scope && entry.modelId === 'model-a'
            ))).toBe(false);
        }
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
        const screen = await renderScreen(<Harness serverId={serverId} />);
        await act(async () => {});
        expect(value.current?.models).toHaveLength(1);
        expect(value.current?.modelLoadAction).toBe('available');
        await screen.update(<Harness serverId={otherServerId} />);
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
            value.current = useProviderConnectionModels({ enabled: true, machineId: 'machine-a', serverId, connectionId: 'pc_a' });
            return React.createElement('View');
        }
        await renderScreen(<Harness />);
        await act(async () => {});
        await act(async () => { await value.current?.refresh(); });
        expect(value.current).toMatchObject({
            models: [{ id: 'a' }],
            connectionRevision: 2,
            error: createProviderErrorV1('agent_error', {
                connectionId: 'pc_a',
                machineId: 'machine-a',
            }),
            loading: false,
        });
    });
});
