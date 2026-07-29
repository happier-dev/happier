import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { createProviderErrorV1 } from '@happier-dev/protocol';

import { renderScreen } from '@/dev/testkit';

const describeProviderConnections = vi.hoisted(() => vi.fn());
vi.mock('@/providers/rpc/client', () => ({
    describeProviderConnections,
    providerErrorFromRpcFailure: (_caught: unknown, context: Readonly<Record<string, unknown>>) =>
        createProviderErrorV1('provider_endpoint_unavailable', context),
}));

import { useProviderConnectionMachineViews } from './useProviderConnectionMachineViews';

describe('useProviderConnectionMachineViews', () => {
    it('projects the effective endpoint independently from each target daemon', async () => {
        describeProviderConnections.mockImplementation(async ({ machineId }: { machineId: string }) => ({
            status: 'success',
            connections: [{ connectionId: 'pc_a', endpoints: [{ baseUrl: `http://${machineId}.localhost:11434/` }] }],
        }));
        const result: { current: ReturnType<typeof useProviderConnectionMachineViews> | null } = { current: null };
        function Harness() {
            result.current = useProviderConnectionMachineViews({
                enabled: true, serverId: 'server-a', connectionId: 'pc_a', machineIds: ['machine-a', 'machine-b'],
            });
            return React.createElement('View');
        }
        await renderScreen(<Harness />);
        await act(async () => {});
        expect(result.current?.byMachineId['machine-a']).toMatchObject({
            status: 'success',
            connection: { endpoints: [{ baseUrl: 'http://machine-a.localhost:11434/' }] },
        });
        expect(result.current?.byMachineId['machine-b']).toMatchObject({
            status: 'success',
            connection: { endpoints: [{ baseUrl: 'http://machine-b.localhost:11434/' }] },
        });
    });

    it('keeps a failed machine read distinct from an absent connection', async () => {
        describeProviderConnections.mockImplementation(async ({ machineId }: { machineId: string }) => machineId === 'machine-a'
            ? { status: 'error', error: createProviderErrorV1('provider_not_enabled_on_machine', { machineId }) }
            : { status: 'success', connections: [] });
        const result: { current: ReturnType<typeof useProviderConnectionMachineViews> | null } = { current: null };
        function Harness() {
            result.current = useProviderConnectionMachineViews({
                enabled: true, serverId: 'server-a', connectionId: 'pc_a', machineIds: ['machine-a', 'machine-b'],
            });
            return React.createElement('View');
        }
        await renderScreen(<Harness />);
        await act(async () => {});
        expect(result.current?.byMachineId['machine-a']).toEqual({
            status: 'error',
            error: createProviderErrorV1('provider_not_enabled_on_machine', { machineId: 'machine-a' }),
        });
        expect(result.current?.byMachineId['machine-b']).toEqual({ status: 'success', connection: null });
    });
});
