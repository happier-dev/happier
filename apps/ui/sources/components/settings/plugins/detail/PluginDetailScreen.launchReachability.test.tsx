import * as React from 'react';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { act } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';

import { DestinationInstanceHost } from '@/components/appShell/workspace/DestinationInstanceHost';
import { readHomeShownUnavailable } from '@/components/navigation/connectionStatus/HomeReachabilityGate';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { PaneLoadingFallback } from '@/components/ui/panels/PaneLoadingFallback';
import { createDeferred, createMachineFixture, renderScreen } from '@/dev/testkit';
import { createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { CurtainProbe, startTestLaunchCurtain } from '@/dev/testkit/harness/launchCurtainHarness';
import { resolveServerScopedMachineInventoryKeys } from '@/sync/domains/machines/resolveServerScopedMachines';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';
import { storage } from '@/sync/domains/state/storageStore';
import { publishAppliedActiveServerRuntimeAvailability } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@react-navigation/native', async () => (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());

const machineId = 'plugin-launch-machine';
const machine = createMachineFixture({ id: machineId, installationId: 'plugin-launch-installation',
    activeAt: Date.now(), presenceProtocolVersion: 1 });
const row = createPlainMachineRowFixture({ id: machineId, accountId: 'account-a', machine });
const capabilityRead = createDeferred<string>();
const capabilityAnswer = createDeferred<void>();
const runtime = installSessionPaneRuntimeTestHarness({
    request: async (url, init) => {
        const path = new URL(String(url)).pathname;
        if (path === '/v1/machines') return Response.json([row]);
        if (path === '/v1/machines/read-batch') return createMachineReadBatchResponseFixture(init?.body, id => id === machineId ? row : null);
        return null;
    },
});
// Withhold the exact Machine transport response while the real administration and projection owners run.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: async (request: Readonly<{ method: string; machineId: string }>) => {
        if (request.method === RPC_METHODS.CAPABILITIES_DETECT) capabilityRead.resolve(request.machineId);
        await capabilityAnswer.promise;
        throw new Error('Test Machine transport closed');
    },
}));
const { PluginDetailRoute } = await import('./PluginDetailRoute');

it('shows the cold Plugin loading card while the retained Machine read is pending and Home reports a server error', async () => {
    const serverId = runtime.serverId;
    const authorityId = runtime.serverIdentityId;
    storage.getState().applyMachines([machine], true, { sourceServerId: authorityId });
    const { settings, settingsVersion } = storage.getState();
    if (typeof settingsVersion !== 'number') throw new Error('Expected hydrated Account Settings');
    storage.getState().applySettings({
        ...settings,
        machineAdministrationTargetsLocalV1: {
            [MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.plugins]: { serverIdentityId: authorityId, machineId },
        },
    }, settingsVersion);
    const inventoryKeys = resolveServerScopedMachineInventoryKeys({
        serverId, machineListByServerId: storage.getState().machineListStatusByServerId,
    });
    const launch = startTestLaunchCurtain();
    publishAppliedActiveServerRuntimeAvailability(true);
    storage.setState({ endpointStatus: 'online', endpointReason: null, socketStatus: 'connected', syncError: null });
    const pluginId = 'example.launch';
    const screen = await renderScreen(<runtime.Wrapper>
        <DestinationInstanceHost tabId="plugin-launch" ref={{ kind: 'plugins', params: { pluginId } }}
            pathname={`/settings/plugins/${pluginId}`} focused visible>
            <PluginDetailRoute />
        </DestinationInstanceHost>
        <CurtainProbe />
    </runtime.Wrapper>);
    const curtain = () => screen.root.findByType('CurtainProbe').props.state;
    try {
        let requestedMachine: string | undefined;
        void capabilityRead.promise.then(id => { requestedMachine = id; });
        await vi.waitFor(() => {
            expect(screen.findAllByType(PaneLoadingFallback)).toHaveLength(1);
            expect(requestedMachine).toBe(machineId);
        }, { timeout: 5000 });
        expect(readHomeShownUnavailable(serverId)).toBe(false);
        launch.releaseShell();
        await launch.paint();
        expect(curtain()).toBe('up');

        await act(async () => {
            storage.setState({
                machineListStatusByServerId: Object.fromEntries(inventoryKeys.map(key => [key, 'error' as const])),
            });
        });
        expect(readHomeShownUnavailable(serverId)).toBe(true);
        expect(screen.findAllByType(PaneLoadingFallback)).toHaveLength(1);
        await launch.paint();
        expect(curtain()).toBe('leaving');
        await act(async () => { launch.finish(); });
        expect(curtain()).toBe('gone');
        expect(screen.findAllByType(PaneLoadingFallback)).toHaveLength(1);
    } finally {
        await screen.unmount();
        capabilityAnswer.resolve();
        launch.dispose();
    }
});
