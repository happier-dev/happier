import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';

import { createMachineFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { createMachineReadBatchResponseFixture, createPlainMachineRowFixture, createPlainSharedMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { getStorage } from '@/sync/domains/state/storageStore';
import { readMachineActivity } from '@/sync/domains/machines/machineActivity';
import { t } from '@/text';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';

// Modal presentation is the platform boundary; its picker and Action confirmation stay real.
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
    renderCustomModals: true, confirmResult: true,
}).module);
const { ModalProvider } = await import('@/modal');
const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
const { MachinePageHeader } = await import('./MachinePageHeader');
const { MachineDetailsSection } = await import('../details/MachineDetailsSection');
const { MachineWindowsLaunchSection } = await import('../windows/MachineWindowsLaunchSection');

afterEach(() => standardCleanup());

it.each(['use', 'manage', 'owner', 'unknown'] as const)('shows Machine administration controls only with Manage: %s', async role => {
    const allowed = role === 'manage' || role === 'owner';
    const homes = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://machine-access.test',
        accountId: role === 'owner' ? 'owner' : 'viewer', currentAccount: true }] });
    const serverId = homes.homes.a!.id;
    const store = getStorage();
    const previous = store.getState();
    const shared = createPlainSharedMachineRowFixture({ id: 'source', custodianAccountId: 'owner',
        role: role === 'use' ? 'use' : 'manage' });
    const machine = createMachineFixture({ id: 'source', isShared: role !== 'owner', access: role === 'unknown' || role === 'owner' ? undefined : shared.access,
        metadata: { host: 'test', platform: 'win32', happyCliVersion: 'test', happyHomeDir: 'C:\\happier', homeDir: 'C:\\Users\\test' } });
    store.getState().applyMachines([machine, createMachineFixture({ id: 'candidate', isShared: false })], true, { sourceServerId: serverId });
    const target = { machineId: machine.id, requestedServerId: serverId, serverId, activeServerId: serverId, machine,
        machineName: 'Source', machineSentenceName: 'Source', isServerSwitching: false, isHydratingMachine: false, switchReady: true };
    const content = (current: typeof machine) => <ModalProvider>
        <MachinePageHeader target={{ ...target, machine: current }} managedIdentity={null} renaming={false} onRename={() => {}} />
        <MachineDetailsSection machine={current} serverId={serverId} />
        <MachineWindowsLaunchSection machine={current} serverId={serverId} windowsTerminalAvailable />
    </ModalProvider>;
    const screen = await renderScreen(content(machine));
    try {
        const menu = screen.findAllByType(DropdownMenu).find(menu => menu.props.testID === 'machine-detail-menu');
        const ids = menu?.props.items.map((item: { id: string }) => item.id) ?? [];
        for (const id of ['rename', 'environment-apply', 'replace']) expect.soft(ids.includes(id), id).toBe(allowed);
        expect.soft(screen.findAllByTestId('machine-detail-remove').length > 0).toBe(allowed);
        expect.soft(screen.findAllByType(ItemGroup).some(group => group.props.title === t('machine.windows.title'))).toBe(allowed);
        // Late replacement and access publications update the retained header; no remount or presence change is needed.
        await screen.update(content({ ...machine, replacedByMachineId: 'candidate' }));
        const replacedMenu = screen.findAllByType(DropdownMenu).find(menu => menu.props.testID === 'machine-detail-menu');
        expect.soft(replacedMenu?.props.items.some((item: { id: string }) => item.id === 'undo-replacement') ?? false).toBe(allowed);
        await screen.update(content({ ...machine, access: { ...shared.access!, role: allowed ? 'use' : 'manage' } }));
        const updatedMenu = screen.findAllByType(DropdownMenu).find(menu => menu.props.testID === 'machine-detail-menu');
        expect(updatedMenu?.props.items.some((item: { id: string }) => item.id === 'rename') ?? false).toBe(!allowed);
    } finally {
        await screen.unmount();
        await homes.dispose();
        store.setState(previous);
    }
});

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
