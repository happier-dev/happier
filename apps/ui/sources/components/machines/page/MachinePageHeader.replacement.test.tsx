import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';

import { createMachineFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { createMachineReadBatchResponseFixture, createPlainMachineRowFixture, createPlainSharedMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { getStorage } from '@/sync/domains/state/storageStore';
import { linkMachineActivity, readMachineActivity } from '@/sync/domains/machines/machineActivity';
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

it.each([
    { refusal: 'revoked', reasonKey: 'machineDetailPage.startUnavailable.removed' },
    { refusal: 'replaced', reasonKey: 'machineDetailPage.startUnavailable.replaced' },
    { refusal: 'roleInactive', reasonKey: 'machineDetailPage.startUnavailable.sessionsOff' },
] as const)('keeps the canonical $refusal reason on an offline Machine at first render and after retained updates', async ({ refusal, reasonKey }) => {
    const homes = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://machine-readiness.test',
        accountId: 'owner', currentAccount: true }] });
    const serverId = homes.homes.a!.id;
    const store = getStorage();
    const previous = store.getState();
    const machine = createMachineFixture({ id: 'source', active: false, activeAt: 1_000, isShared: false });
    const refused = createMachineFixture({ ...machine,
        ...(refusal === 'revoked' ? { revokedAt: 1 } : refusal === 'replaced' ? { replacedByMachineId: 'replacement' }
            : { metadata: { ...machine.metadata!, rolesV1: { active: ['broker'] } } }),
    });
    const publish = (current: typeof machine) => store.getState().applyMachines([current], true, { sourceServerId: serverId,
        activityUpdates: [{ id: current.id, active: false, activeAt: current.activeAt }] });
    const content = (current: typeof machine) => <ModalProvider><MachinePageHeader target={{ machineId: current.id,
        requestedServerId: serverId, serverId, activeServerId: serverId, machine: current, machineName: 'Source',
        machineSentenceName: 'Source', isServerSwitching: false, isHydratingMachine: false, switchReady: true }}
        managedIdentity={null} renaming={false} onRename={() => {}} /></ModalProvider>;
    publish(refused);
    const screen = await renderScreen(content(refused));
    const assertReason = (expected: string) => {
        const start = screen.findByTestId('machine-detail-start-session');
        expect(start?.props.accessibilityState?.disabled).toBe(true);
        expect(start?.props.accessibilityHint).toBe(expected);
    };
    try {
        assertReason(t(reasonKey, { machine: 'Source' }));
        // Clearing and republishing the refusal exercises a header that stays mounted while its row changes.
        await act(async () => { publish(machine); await screen.update(content(machine)); });
        assertReason(t('machineDetailPage.startUnavailable.offline', { machine: 'Source' }));
        await act(async () => { publish(refused); await screen.update(content(refused)); });
        assertReason(t(reasonKey, { machine: 'Source' }));
        expect(screen.findByTestId('machine-detail-edit-roles') !== null).toBe(refusal === 'roleInactive');
    } finally {
        await screen.unmount();
        await homes.dispose();
        store.setState(previous);
    }
});

it('keeps unobserved presence unknown, then follows offline and ready activity answers', async () => {
    const homes = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://machine-presence-answer.test',
        accountId: 'owner', currentAccount: true }] });
    const serverId = homes.homes.a!.id;
    const store = getStorage();
    const previous = store.getState();
    const machine = createMachineFixture({ id: 'unobserved', active: false, activeAt: 1_000, isShared: false });
    // A retained row has not received a live presence answer; applyMachines would itself answer it.
    linkMachineActivity(machine, machine);
    store.setState({ machines: { [machine.id]: machine },
        machineListByServerId: { ...previous.machineListByServerId, [serverId]: [machine] },
        machineRecordsByServerId: { ...previous.machineRecordsByServerId, [serverId]: { [machine.id]: machine } },
        machineListStatusByServerId: { ...previous.machineListStatusByServerId, [serverId]: 'idle' } });
    const screen = await renderScreen(<ModalProvider><MachinePageHeader target={{ machineId: machine.id,
        requestedServerId: serverId, serverId, activeServerId: serverId, machine, machineName: 'Source',
        machineSentenceName: 'Source', isServerSwitching: false, isHydratingMachine: false, switchReady: true }}
        managedIdentity={null} renaming={false} onRename={() => {}} /></ModalProvider>);
    try {
        expect(screen.findByTestId('machine-detail-start-session')?.props.accessibilityState?.disabled).toBe(true);
        expect(screen.findByTestId('machine-detail-start-session')?.props.accessibilityHint).toBeUndefined();
        await act(async () => store.getState().applyMachineActivityUpdates([
            { id: machine.id, active: false, activeAt: 2_000 },
        ], { sourceServerId: serverId }));
        expect(screen.findByTestId('machine-detail-start-session')?.props.accessibilityHint)
            .toBe(t('machineDetailPage.startUnavailable.offline', { machine: 'Source' }));
        await act(async () => store.getState().applyMachineActivityUpdates([
            { id: machine.id, active: true, activeAt: Date.now() },
        ], { sourceServerId: serverId }));
        expect(screen.findByTestId('machine-detail-start-session')?.props.accessibilityState?.disabled).toBe(false);
        expect(screen.findByTestId('machine-detail-start-session')?.props.accessibilityHint).toBeUndefined();
        expect(machine.active).toBe(false);
        expect(readMachineActivity(machine).active).toBe(true);
    } finally {
        await screen.unmount();
        await homes.dispose();
        store.setState(previous);
    }
});

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
