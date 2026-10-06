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
    mutateAccountSettingsOnce: vi.fn(),
}));

vi.mock('@/sync/domains/state/storageStore', () => ({
    storage: {
        getState: () => ({
            settings: {
                machineAdministrationSelectionsV1: fixture.selections,
            },
        }),
    },
    getStorage: () => (
        (selector: (state: Readonly<{ settingsScope: Readonly<{ serverId: string; accountId: string }> }>) => unknown) =>
            selector({ settingsScope: { serverId: 'server-a', accountId: 'account-a' } })
    ),
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
            intentReads: [],
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
    useSettingsVersion: () => 7,
}));

vi.mock('@/sync/runtime/getSyncSingleton', () => ({
    getSyncSingleton: () => ({ mutateAccountSettingsOnce: fixture.mutateAccountSettingsOnce }),
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
            pluginExecutionOriginsByPluginId: { 'acme.plugin': selectedOrigin },
        };
        fixture.canonicalRaw = {
            unrelatedRoot: { preserved: true },
            machineAdministrationSelectionsV1: {
                v: 1,
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
        fixture.mutateAccountSettingsOnce.mockReset();
        fixture.mutateAccountSettingsOnce.mockImplementation(async (params: Readonly<{
            expectedSettingsVersion: number;
            mutate: (raw: Readonly<Record<string, unknown>>) => Readonly<{
                settings: Record<string, unknown>;
                value: undefined;
            }>;
        }>) => {
            const mutation = params.mutate(fixture.canonicalRaw);
            fixture.canonicalRaw = mutation.settings;
            return { status: 'applied', settingsVersion: 8, value: undefined };
        });
    });

    it('advances its local revision monotonically across A-to-B-to-A', async () => {
        const { advancePluginExecutionOriginSelectionRevision } = await import('./usePluginExecutionOriginSelection');
        const originB: PluginMachineExecutionOriginV1 = {
            serverIdentityId: 'srv_two',
            materializationRef: {
                machineId: 'machine-b',
                materializationId: 'mat-b',
                pluginId: 'acme.plugin',
            },
        };
        const initial = { pluginId: 'acme.plugin', origin: selectedOrigin, revision: 0 };
        const selectedB = advancePluginExecutionOriginSelectionRevision(initial, 'acme.plugin', originB);
        const selectedAAgain = advancePluginExecutionOriginSelectionRevision(
            selectedB,
            'acme.plugin',
            selectedOrigin,
        );

        expect(selectedB.revision).toBe(1);
        expect(selectedAAgain.revision).toBe(2);
    });

    afterEach(() => {
        standardCleanup();
    });

    it('projects a sole live candidate without persisting inferred preference on mount or rerender', async () => {
        fixture.selections = { v: 1, pluginExecutionOriginsByPluginId: {} };
        const { usePluginMachineExecutionOriginSelection } = await import('./usePluginExecutionOriginSelection');
        const hook = await renderHook(() => usePluginMachineExecutionOriginSelection({
            pluginId: 'acme.plugin',
            classifyRelease: () => ({ releaseContent: 'matched', validation: { kind: 'admitted' } }),
        }));
        expect(fixture.mutateAccountSettingsOnce).not.toHaveBeenCalled();
        expect(hook.getCurrent().state).toMatchObject({ kind: 'selected', selectionSource: 'soleCandidate' });
        expect(hook.getCurrent().selectedOrigin).toBeNull();
        expect(hook.getCurrent().resolveExecutionOrigin()).toBeNull();
        await hook.rerender();
        expect(fixture.mutateAccountSettingsOnce).not.toHaveBeenCalled();
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

        expect(fixture.mutateAccountSettingsOnce).toHaveBeenCalledOnce();
        expect(fixture.mutateAccountSettingsOnce.mock.calls[0]?.[0]?.expectedSettingsScope).toEqual({
            serverId: 'server-a',
            accountId: 'account-a',
        });
        expect(fixture.setSelections).not.toHaveBeenCalled();
        expect(fixture.canonicalRaw).toEqual({
            unrelatedRoot: { preserved: true },
            machineAdministrationSelectionsV1: {
                v: 1,
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

    it('returns the canonical conflict instead of hiding command settlement', async () => {
        fixture.mutateAccountSettingsOnce.mockResolvedValueOnce({
            status: 'conflict',
            currentSettingsVersion: 9,
        });
        const { usePluginMachineExecutionOriginSelection } = await import('./usePluginExecutionOriginSelection');
        const hook = await renderHook(() => usePluginMachineExecutionOriginSelection({
            pluginId: 'acme.plugin',
            classifyRelease: () => ({ releaseContent: 'matched', validation: { kind: 'admitted' } }),
        }));

        await expect(hook.getCurrent().selectOrigin(selectedOrigin)).resolves.toEqual({
            status: 'conflict',
            currentSettingsVersion: 9,
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
