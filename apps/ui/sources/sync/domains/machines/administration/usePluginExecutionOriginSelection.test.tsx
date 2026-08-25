import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
    MachineAdministrationSelectionsV1,
    PluginMachineExecutionOriginV1,
} from '@happier-dev/protocol';

import { renderHook, standardCleanup } from '@/dev/testkit';

const fixture = vi.hoisted(() => ({
    selections: null as MachineAdministrationSelectionsV1 | null,
    canonicalRaw: {} as Record<string, unknown>,
    setSelections: vi.fn(),
    mutateAccountSettings: vi.fn(),
}));

vi.mock('@/sync/domains/state/storageStore', () => ({
    storage: {
        getState: () => ({
            settings: {
                machineAdministrationSelectionsV1: fixture.selections,
            },
        }),
    },
}));

const selectedOrigin: PluginMachineExecutionOriginV1 = {
    serverIdentityId: 'srv_one',
    materializationRef: {
        machineId: 'machine-a',
        materializationId: 'mat-a',
        pluginId: 'acme.plugin',
    },
};

vi.mock('@/sync/domains/plugins/availability/projection', () => ({
    useActivePluginAccountAvailabilityReader: () => ({
        readMaterializations: () => ({
            kind: 'available',
            availabilityCursor: 1,
            materializations: [{
                serverIdentityId: 'srv_one',
                machineId: 'machine-a',
                materializationId: 'mat-a',
                pluginId: 'acme.plugin',
                version: '1.0.0',
                sourceClass: 'registryPackage',
                portableRelease: true,
                uiArtifacts: [],
                enabled: true,
                trustState: 'trusted',
                observedAt: 100,
            }],
        }),
    }),
}));

vi.mock('@/sync/domains/machines/useMachineInventorySnapshots', () => ({
    useAllProfileMachineInventorySnapshots: () => [{
        kind: 'resolved',
        profileId: 'local-one',
        serverIdentityId: 'srv_one',
        serverName: 'Server One',
        observation: 'live',
        machines: [{
            id: 'machine-a',
            updatedAt: 100,
            active: true,
            activeAt: Date.now(),
            revokedAt: null,
            metadataVersion: 1,
            metadata: null,
        }],
    }],
}));

vi.mock('@/sync/store/hooks', () => ({
    useSettingMutable: () => [fixture.selections, fixture.setSelections],
    useSetting: () => fixture.selections,
}));

vi.mock('@/sync/runtime/getSyncSingleton', () => ({
    getSyncSingleton: () => ({ mutateAccountSettings: fixture.mutateAccountSettings }),
}));

vi.mock('./useTargetSelection', () => ({
    resolveFreshMachineAdministrationExecutionTarget: (target: { serverIdentityId: string; machineId: string } | null) => (
        target
            ? {
                target,
                serverId: 'local-one',
                machine: { id: target.machineId, daemonStateVersion: 1 },
            }
            : null
    ),
}));

describe('usePluginMachineExecutionOriginSelection', () => {
    beforeEach(() => {
        fixture.selections = {
            v: 1,
            targetsByKey: {},
            pluginExecutionOriginsByPluginId: { 'acme.plugin': selectedOrigin },
        };
        fixture.canonicalRaw = {
            unrelatedRoot: { preserved: true },
            machineAdministrationSelectionsV1: {
                v: 1,
                targetsByKey: {
                    agents: { serverIdentityId: 'srv_two', machineId: 'machine-b' },
                },
                pluginExecutionOriginsByPluginId: {
                    'other.plugin': {
                        serverIdentityId: 'srv_two',
                        materializationRef: {
                            machineId: 'machine-b',
                            materializationId: 'mat-b',
                            pluginId: 'other.plugin',
                        },
                    },
                },
            },
        };
        fixture.setSelections.mockReset();
        fixture.mutateAccountSettings.mockReset();
        fixture.mutateAccountSettings.mockImplementation(async (
            mutate: (raw: Readonly<Record<string, unknown>>) => Record<string, unknown>,
        ) => {
            fixture.canonicalRaw = mutate(fixture.canonicalRaw);
        });
    });

    afterEach(() => {
        standardCleanup();
    });

    it('replays one exact origin mutation against the canonical Account Settings winner', async () => {
        const { usePluginMachineExecutionOriginSelection } = await import('./usePluginExecutionOriginSelection');
        const hook = await renderHook(() => usePluginMachineExecutionOriginSelection({
            pluginId: 'acme.plugin',
            classifyRelease: () => ({ releaseContent: 'matched', validation: { kind: 'admitted' } }),
        }));

        await act(async () => {
            await hook.getCurrent().selectOrigin(selectedOrigin);
        });

        expect(fixture.mutateAccountSettings).toHaveBeenCalledOnce();
        expect(fixture.setSelections).not.toHaveBeenCalled();
        expect(fixture.canonicalRaw).toEqual({
            unrelatedRoot: { preserved: true },
            machineAdministrationSelectionsV1: {
                v: 1,
                targetsByKey: {
                    agents: { serverIdentityId: 'srv_two', machineId: 'machine-b' },
                },
                pluginExecutionOriginsByPluginId: {
                    'other.plugin': {
                        serverIdentityId: 'srv_two',
                        materializationRef: {
                            machineId: 'machine-b',
                            materializationId: 'mat-b',
                            pluginId: 'other.plugin',
                        },
                    },
                    'acme.plugin': selectedOrigin,
                },
            },
        });
        await hook.unmount();
    });

    it('re-reads the execution-origin preference when the callback is invoked', async () => {
        const { usePluginMachineExecutionOriginSelection } = await import('./usePluginExecutionOriginSelection');
        const hook = await renderHook(() => usePluginMachineExecutionOriginSelection({
            pluginId: 'acme.plugin',
            classifyRelease: () => ({ releaseContent: 'matched', validation: { kind: 'admitted' } }),
        }));
        fixture.selections = {
            ...fixture.selections!,
            pluginExecutionOriginsByPluginId: {},
        };

        expect(hook.getCurrent().resolveExecutionOrigin()).toBeNull();
        await hook.unmount();
    });
});
