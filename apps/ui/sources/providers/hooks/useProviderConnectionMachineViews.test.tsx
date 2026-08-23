import { afterEach, describe, expect, it } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import {
    createProviderConnectionViewFixture,
    createProviderConnectionsDescribeFixture,
    createProviderSettingsHarness,
    flushHookEffects,
    installProviderSettingsRpcBoundary,
    renderHook,
    standardCleanup,
} from '@/dev/testkit';
import type { ProviderSettingsMachineRowV1 } from '@/providers/hooks/targetMachine';

const providerHarness = createProviderSettingsHarness();
installProviderSettingsRpcBoundary(providerHarness);

function row(
    serverIdentityId: string,
    machineId: string,
    serverId: string,
): ProviderSettingsMachineRowV1 {
    return { target: { serverIdentityId, machineId }, serverId, displayName: machineId, online: true };
}

describe('useProviderConnectionMachineViews', () => {
    afterEach(() => {
        providerHarness.reset();
        standardCleanup();
    });

    it('reads each machine through its own server profile when two profiles share a machine id', async () => {
        // The same machine id exists on two server profiles. Routing both rows
        // through one server would answer for the wrong daemon's Account.
        providerHarness.intercept(RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE, async (request) => (
            createProviderConnectionsDescribeFixture({
                connections: [createProviderConnectionViewFixture({
                    connectionId: 'pc_a',
                    displayName: `on ${request.serverId}`,
                })],
            })
        ));
        const { useProviderConnectionMachineViews } = await import('./useProviderConnectionMachineViews');
        const targets = [
            row('srv_a', 'machine-shared', 'server-a'),
            row('srv_b', 'machine-shared', 'server-b'),
        ];
        const rendered = await renderHook(() => useProviderConnectionMachineViews({
            enabled: true,
            connectionId: 'pc_a',
            targets,
        }));
        await flushHookEffects({ cycles: 2, turns: 3 });

        const requestedServerIds = providerHarness.state.requests
            .filter((request) => request.method === RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE)
            .map((request) => request.serverId)
            .sort();
        expect(requestedServerIds).toEqual(['server-a', 'server-b']);

        const byTargetKey = rendered.getCurrent().byTargetKey;
        expect(Object.keys(byTargetKey).sort()).toEqual([
            'srv_a\u0000machine-shared',
            'srv_b\u0000machine-shared',
        ]);
        const first = byTargetKey['srv_a\u0000machine-shared'];
        const second = byTargetKey['srv_b\u0000machine-shared'];
        expect(first?.status === 'success' ? first.connection?.displayName : null).toBe('on server-a');
        expect(second?.status === 'success' ? second.connection?.displayName : null).toBe('on server-b');
    });

    it('issues no read and holds no rows when there is no addressable machine', async () => {
        const { useProviderConnectionMachineViews } = await import('./useProviderConnectionMachineViews');
        const rendered = await renderHook(() => useProviderConnectionMachineViews({
            enabled: true,
            connectionId: 'pc_a',
            targets: [],
        }));
        await flushHookEffects({ cycles: 2, turns: 3 });

        expect(providerHarness.state.requests).toEqual([]);
        expect(rendered.getCurrent().byTargetKey).toEqual({});
    });
});
