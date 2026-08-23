import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    createMachineAdministrationTargetSelectionMock,
    renderHook,
    standardCleanup,
} from '@/dev/testkit';

async function importTargetHook(
    mock: ReturnType<typeof createMachineAdministrationTargetSelectionMock>,
) {
    vi.resetModules();
    vi.doMock('@/sync/domains/machines/administration/useTargetSelection', () => mock.module);
    return (await import('./targetMachine')).useProviderSettingsTarget;
}

describe('useProviderSettingsTarget', () => {
    afterEach(standardCleanup);

    it('addresses the exact selected machine and follows a later selection', async () => {
        const mock = createMachineAdministrationTargetSelectionMock({
            machines: [{ machineId: 'machine-a' }, { machineId: 'machine-b' }],
            selectedMachineId: 'machine-a',
        });
        const useProviderSettingsTarget = await importTargetHook(mock);
        const rendered = await renderHook(() => useProviderSettingsTarget());

        expect(rendered.getCurrent().machineId).toBe('machine-a');
        expect(rendered.getCurrent().serverId).toBe('server-a');
        expect(rendered.getCurrent().resolveCurrentTarget()).toEqual({
            machineId: 'machine-a',
            serverId: 'server-a',
        });

        await act(async () => { mock.controller.select('machine-b'); });

        expect(rendered.getCurrent().machineId).toBe('machine-b');
        expect(rendered.getCurrent().resolveCurrentTarget()?.machineId).toBe('machine-b');
    });

    it('refuses to address a selected machine that is no longer reachable', async () => {
        const mock = createMachineAdministrationTargetSelectionMock({
            machines: [{ machineId: 'machine-a', availability: 'offline' }],
            selectedMachineId: 'machine-a',
        });
        const useProviderSettingsTarget = await importTargetHook(mock);
        const rendered = await renderHook(() => useProviderSettingsTarget());

        // The selected target stays the user's choice, but no Provider RPC may
        // be issued against a machine the canonical presence owner calls offline.
        expect(rendered.getCurrent().selection.selectedTarget?.machineId).toBe('machine-a');
        expect(rendered.getCurrent().machineId).toBeNull();
        expect(rendered.getCurrent().serverId).toBeNull();
        expect(rendered.getCurrent().resolveCurrentTarget()).toBeNull();
        expect(rendered.getCurrent().machineRows).toEqual([]);
    });

    it('marks only reachable machines addressable while still projecting the rest', async () => {
        const mock = createMachineAdministrationTargetSelectionMock({
            machines: [
                { machineId: 'machine-a' },
                { machineId: 'machine-offline', availability: 'offline' },
                { machineId: 'machine-revoked', availability: 'revoked' },
                { machineId: 'machine-stale', observation: 'stale' },
            ],
            selectedMachineId: 'machine-a',
        });
        const useProviderSettingsTarget = await importTargetHook(mock);
        const rendered = await renderHook(() => useProviderSettingsTarget());

        expect(rendered.getCurrent().machineRows.filter((row) => row.online).map((row) => row.target.machineId))
            .toEqual(['machine-a']);
        expect(rendered.getCurrent().machineRows.map((row) => row.target.machineId)).toEqual([
            'machine-a', 'machine-offline', 'machine-revoked', 'machine-stale',
        ]);
    });

    it('keeps each machine row on its own server profile instead of the selected routing id', async () => {
        // Two server profiles expose the same machine id. A row that collapses
        // to a bare machine id would let a read for the other Account's machine
        // be routed to the selected profile's daemon.
        const mock = createMachineAdministrationTargetSelectionMock({
            serverId: 'server-a',
            serverIdentityId: 'srv_a',
            machines: [
                { machineId: 'machine-shared', displayName: 'Studio on A' },
                {
                    machineId: 'machine-shared',
                    displayName: 'Studio on B',
                    serverIdentityId: 'srv_b',
                    serverId: 'server-b',
                },
            ],
            selectedMachineId: 'machine-shared',
            selectedServerIdentityId: 'srv_a',
        });
        const useProviderSettingsTarget = await importTargetHook(mock);
        const rendered = await renderHook(() => useProviderSettingsTarget());

        expect(rendered.getCurrent().machineRows).toEqual([{
            target: { serverIdentityId: 'srv_a', machineId: 'machine-shared' },
            serverId: 'server-a',
            displayName: 'Studio on A',
            online: true,
        }]);
        expect(rendered.getCurrent().serverId).toBe('server-a');
    });

    it('follows the selected server identity when the same machine id is chosen on another profile', async () => {
        const mock = createMachineAdministrationTargetSelectionMock({
            serverId: 'server-a',
            serverIdentityId: 'srv_a',
            machines: [
                { machineId: 'machine-shared', displayName: 'Studio on A' },
                {
                    machineId: 'machine-shared',
                    displayName: 'Studio on B',
                    serverIdentityId: 'srv_b',
                    serverId: 'server-b',
                },
            ],
            selectedMachineId: 'machine-shared',
            selectedServerIdentityId: 'srv_b',
        });
        const useProviderSettingsTarget = await importTargetHook(mock);
        const rendered = await renderHook(() => useProviderSettingsTarget());

        expect(rendered.getCurrent().serverId).toBe('server-b');
        expect(rendered.getCurrent().machineRows.map((row) => row.serverId)).toEqual(['server-b']);
        expect(rendered.getCurrent().resolveCurrentTarget()).toEqual({
            machineId: 'machine-shared',
            serverId: 'server-b',
        });
    });

    it('stops authorizing work once the selected machine goes offline mid-session', async () => {
        const mock = createMachineAdministrationTargetSelectionMock({
            machines: [{ machineId: 'machine-a' }],
            selectedMachineId: 'machine-a',
        });
        const useProviderSettingsTarget = await importTargetHook(mock);
        const rendered = await renderHook(() => useProviderSettingsTarget());
        const resolveBeforeLoss = rendered.getCurrent().resolveCurrentTarget;
        expect(resolveBeforeLoss()).not.toBeNull();

        await act(async () => {
            mock.controller.setMachines([{ machineId: 'machine-a', availability: 'offline' }]);
        });

        // A callback captured while the machine was reachable must not
        // authorize a later effect against it.
        expect(resolveBeforeLoss()).toBeNull();
        expect(rendered.getCurrent().machineId).toBeNull();
    });
});
