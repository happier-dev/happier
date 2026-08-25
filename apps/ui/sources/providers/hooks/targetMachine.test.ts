import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    createMachineAdministrationTargetSelectionMock,
    renderHook,
    standardCleanup,
} from '@/dev/testkit';

type TestAccountLifetime = Readonly<{
    scope: Readonly<{ serverId: string; accountId: string }>;
    isCurrent(): boolean;
    onRetire(cancel: () => void): Readonly<{ dispose(): void }>;
}>;

/**
 * A controllable stand-in for the sole active-Account lifetime. Mocking the
 * canonical scope owner is the only way to drive a same-server Account switch
 * from a hook test; everything below it is the real Provider target owner.
 */
function createTestAccountLifetime(accountId: string) {
    let retired = false;
    const cancellations = new Set<() => void>();
    const lifetime: TestAccountLifetime = {
        scope: { serverId: 'server-a', accountId },
        isCurrent: () => !retired,
        onRetire(cancel: () => void) {
            if (retired) {
                cancel();
                return { dispose() {} };
            }
            cancellations.add(cancel);
            return { dispose() { cancellations.delete(cancel); } };
        },
    };
    return {
        lifetime,
        retire() {
            if (retired) return;
            retired = true;
            for (const cancel of [...cancellations]) cancel();
            cancellations.clear();
        },
    };
}

const activeAccountLifetime: { value: TestAccountLifetime | null } = { value: null };

async function importTargetHook(
    mock: ReturnType<typeof createMachineAdministrationTargetSelectionMock>,
) {
    vi.resetModules();
    vi.doMock('@/sync/domains/machines/administration/useTargetSelection', () => mock.module);
    vi.doMock('@/sync/domains/scope/activeServerAccountScope', () => ({
        captureActiveServerAccountScopeLifetime: () => activeAccountLifetime.value,
    }));
    return (await import('./targetMachine')).useProviderSettingsTarget;
}

describe('useProviderSettingsTarget', () => {
    afterEach(() => {
        activeAccountLifetime.value = null;
        standardCleanup();
    });

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

    it('refuses a captured resolver once the same machine id is selected on another Account', async () => {
        // A machine id is unique only inside one server identity. A resolver
        // captured while srv_a/machine-shared was the target must not authorize
        // a later effect after the selection moved to the OTHER Account's
        // machine of the same id: the machine id still matches, so only the
        // identity half of the check can refuse it.
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
        const resolveOnAccountA = rendered.getCurrent().resolveCurrentTarget;
        expect(resolveOnAccountA()).toEqual({ machineId: 'machine-shared', serverId: 'server-a' });

        await act(async () => { mock.controller.select('machine-shared', 'srv_b'); });

        expect(resolveOnAccountA()).toBeNull();
        expect(rendered.getCurrent().resolveCurrentTarget()).toEqual({
            machineId: 'machine-shared',
            serverId: 'server-b',
        });
    });

    it('refuses a captured resolver once its Account lifetime retires on the same server and machine', async () => {
        // The canonical reset retires the Account lifetime and clears live
        // inventory, then Account B restores the SAME server identity and
        // machine. Only the Account lifetime distinguishes A's captured
        // resolver from B's, so a machine/server comparison cannot refuse it.
        const accountA = createTestAccountLifetime('account-a');
        activeAccountLifetime.value = accountA.lifetime;
        const mock = createMachineAdministrationTargetSelectionMock({
            machines: [{ machineId: 'machine-shared' }],
            selectedMachineId: 'machine-shared',
        });
        const useProviderSettingsTarget = await importTargetHook(mock);
        const rendered = await renderHook(() => useProviderSettingsTarget());
        const resolveOnAccountA = rendered.getCurrent().resolveCurrentTarget;
        expect(resolveOnAccountA()).toEqual({ machineId: 'machine-shared', serverId: 'server-a' });

        const accountB = createTestAccountLifetime('account-b');
        await act(async () => {
            accountA.retire();
            activeAccountLifetime.value = accountB.lifetime;
        });
        await rendered.rerender();

        expect(resolveOnAccountA()).toBeNull();
        // Positive twin: Account B's own render still addresses the machine.
        expect(rendered.getCurrent().resolveCurrentTarget()).toEqual({
            machineId: 'machine-shared',
            serverId: 'server-a',
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
