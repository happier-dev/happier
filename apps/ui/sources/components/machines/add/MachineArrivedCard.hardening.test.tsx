import * as React from 'react';
import { afterEach, expect, it } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createHydratedPlainMachineFixture, createMachineMetadataFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import { installMachinesSettingsCommonModuleMocks } from '@/components/settings/machines/machinesSettingsTestHelpers';
import { ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { MachineSetupPlanInputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';

installMachinesSettingsCommonModuleMocks();
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { MachineArrivedCard } = await import('./MachineAddPanes');
const { AppShellPluginUiProjectionValueProvider } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
const { EMPTY_PLUGIN_UI_PROJECTION } = await import('@/sync/domains/plugins/ui/projection');
const { storage } = await import('@/sync/domains/state/storageStore');
const baseline = storage.getState();

afterEach(async () => {
    standardCleanup();
    await homes.reset();
    storage.setState(baseline, true);
});

it.each(['review', 'skip', 'attached', 'other-platform'] as const)('offers hardening on arrival only when applicable (%s)', async choice => {
    const homeId = 'srv_arrival_hardening';
    const machineId = 'new-linux';
    const serverId = await homes.addHome({ name: 'Arrival', serverUrl: 'https://arrival.test',
        serverIdentityId: homeId, accountId: 'arrival-owner', currentAccount: true });
    const machine = createHydratedPlainMachineFixture({ id: machineId, accountId: 'arrival-owner', machine: {
        activeAt: Date.now(), metadata: createMachineMetadataFixture({ platform: choice === 'other-platform' ? 'darwin' : 'linux' }),
    } });
    const scope = { serverId, accountId: 'arrival-owner' };
    storage.setState({ settingsScope: scope });
    await publishMachineInventoryForTest(scope, [machine]);
    homes.answer(serverId, `/v1/machines/${machineId}`, { body: {
        machine: createPlainMachineRowFixture({ id: machineId, accountId: scope.accountId, machine }),
    } });
    const pluginId = 'happier.machine.recipes';
    const presetId = 'secure-web-host-v1';
    const id = `${pluginId}/${presetId}`;
    const presetSource = { kind: 'bundledPreset', ref: { pluginId, localId: presetId, revision: '1' }, setup: { items: [] } } as const;
    const direct = { kind: 'direct', setup: {} } as const;
    const projection = { ...EMPTY_PLUGIN_UI_PROJECTION, machineSetupPresetsById: {
        [id]: { id, pluginId, pluginVersion: '1', occurrenceId: 'recipes',
            definition: { id: presetId, revision: '1', title: 'Secure web host', setup: { items: [] } } },
    } };
    homes.answer(serverId, '/v1/actions/machines.setup.plan', { select: body => {
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse(body);
        const input = MachineSetupPlanInputV1Schema.parse(envelope.input);
        return { body: { v: 1, actionId: 'machines.setup.plan', requestId: envelope.requestId, execution: {
            ok: true, result: { desiredRevision: 0, sources: input.sources ?? (choice === 'attached' ? [presetSource, direct] : [direct]),
                exclusions: [], support: [], recipePlans: [],
                ...(input.mode === 'effects' ? { review: { target: { homeId, machineId }, administratorRequired: false, downtime: 'none' } } : {}),
            },
        } } };
    } });
    const screen = await renderScreen(
        <AppShellPluginUiProjectionValueProvider value={{
            pluginUiProjection: projection, pluginBrowserProjection: null, phase: 'current',
            interactionEnabled: true, machineId, serverId, platform: 'web', accountLifetime: null,
            clientExecutableActivation: { status: 'ready' }, reloadClientExecutables: () => {},
            reloadConnectedAccountProjection: () => {},
        }}>
            <MachineArrivedCard testID="arrived" machineId={machineId} serverId={serverId}
                name="New Linux" facts="Linux" onStartSession={() => {}} onAddAnother={() => {}} />
        </AppShellPluginUiProjectionValueProvider>,
    );
    try {
        const callsTo = (action: string) => homes.requests.filter(request => request.path === `/v1/actions/${action}`);
        if (choice === 'other-platform' || choice === 'attached') {
            if (choice === 'attached') await waitForHomeGovernance(() => expect(callsTo('machines.setup.plan')).toHaveLength(1));
            expect(screen.findByTestId('arrived.hardening.review')).toBeNull();
            expect(callsTo('machines.setup.plan')).toHaveLength(choice === 'attached' ? 1 : 0);
            return;
        }
        await waitForHomeGovernance(() => expect({
            setupReads: callsTo('machines.setup.plan').length,
            offer: screen.findByTestId('arrived.hardening.review') !== null,
        }).toEqual({ setupReads: 1, offer: true }));
        if (choice === 'review') {
            await screen.pressByTestIdAsync('arrived.hardening.review');
            await waitForHomeGovernance(() => expect(screen.findByTestId('machine-setup-plan-review')).toBeTruthy());
            expect(callsTo('machines.setup.plan')).toHaveLength(2);
            expect(callsTo('machines.setup.apply')).toHaveLength(0);
            await screen.pressByTestIdAsync('machine-setup-review-cancel');
            expect(screen.findByTestId('arrived.hardening.review')).toBeTruthy();
            return;
        }
        await screen.pressByTestIdAsync('arrived.hardening.skip');
        expect(screen.findByTestId('arrived.hardening.review')).toBeNull();
        expect(screen.findByTestId('arrived.startSession')).toBeTruthy();
    } finally {
        await screen.unmount();
    }
});
