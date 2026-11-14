import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';

import { createMachineFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { getStorage } from '@/sync/domains/state/storageStore';
import { RoundButton } from '@/components/ui/buttons/RoundButton';

// Modal presentation is the platform boundary.
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ renderCustomModals: true }).module);
const { ModalProvider } = await import('@/modal');
const { MachinePageHeader } = await import('./MachinePageHeader');

afterEach(() => standardCleanup());

it.each([
    { roles: ['broker'], editRoles: true },
    { roles: undefined, editRoles: false },
])('offers Edit roles only when the Machine has Sessions off ($roles)', async ({ roles, editRoles }) => {
    const homes = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://machine-roles.test', accountId: 'owner', currentAccount: true }], route: () => undefined });
    const serverId = homes.homes.a!.id;
    const store = getStorage();
    const previous = store.getState();
    const base = createMachineFixture({ id: 'parked', isShared: false });
    const machine = { ...base, metadata: { ...base.metadata!, ...(roles ? { rolesV1: { active: roles } } : {}) } };
    store.getState().applyMachines([machine], true, { sourceServerId: serverId });
    const target = { machineId: machine.id, requestedServerId: serverId, serverId, activeServerId: serverId, machine,
        machineName: 'Parked', machineSentenceName: 'Parked', isServerSwitching: false, isHydratingMachine: false, switchReady: true };
    const screen = await renderScreen(<ModalProvider>
        <MachinePageHeader target={target} managedIdentity={null} renaming={false} onRename={() => {}} />
    </ModalProvider>);
    try {
        const buttons = screen.findAllByType(RoundButton);
        const start = buttons.find(button => button.props.testID === 'machine-detail-start-session');
        const edit = buttons.find(button => button.props.testID === 'machine-detail-edit-roles');
        expect(Boolean(edit)).toBe(editRoles);
        if (editRoles) {
            expect(start?.props.disabled).toBe(true);
            expect(String(start?.props.disabledReason)).toContain('Parked');
            expect(typeof edit?.props.onPress).toBe('function');
        }
    } finally {
        await screen.unmount();
        await homes.dispose();
        store.setState(previous);
    }
});
