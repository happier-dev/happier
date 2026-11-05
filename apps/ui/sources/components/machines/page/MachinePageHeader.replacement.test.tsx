import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';

import { createMachineFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { getStorage } from '@/sync/domains/state/storageStore';
import { readMachineActivity } from '@/sync/domains/machines/machineActivity';

// Modal presentation is the platform boundary; its picker and Action confirmation stay real.
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
    renderCustomModals: true, confirmResult: true,
}).module);
const { ModalProvider } = await import('@/modal');
const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
const { MachinePageHeader } = await import('./MachinePageHeader');

afterEach(() => standardCleanup());

it.each([false, true])('replaces a Machine using its current active fact after a retained %s snapshot changes', async initialActive => {
    const nextActive = !initialActive;
    const machineId = 'replacement-source';
    const replacementId = 'replacement-target';
    const path = `/v1/machines/${machineId}/replacement`;
    const homes = await serveAccountHomes({
        homes: [{ key: 'a', serverUrl: 'https://replacement-presence.test', accountId: 'owner', currentAccount: true }],
        route: request => request.path === path ? Response.json({})
            : request.path === '/v1/machines/read-batch'
                ? createMachineReadBatchResponseFixture(request.body, id => createPlainMachineRowFixture({
                    id, accountId: 'owner', machine: createMachineFixture({ id }),
                })) : undefined,
    });
    const serverId = homes.homes.a!.id;
    const store = getStorage();
    const previous = store.getState();
    const machine = createMachineFixture({ id: machineId, active: initialActive, activeAt: 1_000, isShared: false });
    store.getState().applyMachines([machine, createMachineFixture({ id: replacementId, isShared: false })], true, { sourceServerId: serverId });
    const target = { machineId, requestedServerId: serverId, serverId, activeServerId: serverId, machine,
        machineName: 'Source', machineSentenceName: 'Source', isServerSwitching: false, isHydratingMachine: false, switchReady: true };
    const screen = await renderScreen(<ModalProvider>
        <MachinePageHeader target={target} managedIdentity={null} renaming={false} onRename={() => {}} />
    </ModalProvider>);
    try {
        await act(async () => store.getState().applyMachineActivityUpdates([
            { id: machineId, active: nextActive, activeAt: 2_000 },
        ], { sourceServerId: serverId }));
        expect(store.getState().machines[machineId]).toBe(machine);
        expect(machine.active).toBe(initialActive);
        expect(readMachineActivity(machine).active).toBe(nextActive);
        const menu = screen.findAllByType(DropdownMenu).find(menu => menu.props.testID === 'machine-detail-menu')!;
        await act(async () => menu.props.onSelect('replace'));
        await act(async () => screen.pressByTestId(`machine-replacement-picker-candidate:${replacementId}`));
        await vi.waitFor(() => expect(homes.requests.find(request => request.path === path)?.body).toEqual({
            replacementMachineId: replacementId, ...(nextActive ? { confirmActiveOldMachine: true } : {}),
        }));
    } finally {
        await screen.unmount();
        await homes.dispose();
        store.setState(previous);
    }
});
