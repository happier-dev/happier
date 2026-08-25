import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

type AccountSettingsMutation = (raw: Readonly<Record<string, unknown>>) => Record<string, unknown>;

const fixture = vi.hoisted(() => ({
    accountSettings: {} as Record<string, unknown>,
    installedPluginById: new Map<string, unknown>(),
    materializationAdmission: null as unknown,
    selections: null as unknown,
    snapshots: [] as readonly unknown[],
}));
const mutateAccountSettingsMock = vi.hoisted(() => vi.fn());
const administrationTargetSelectorSpy = vi.hoisted(() => vi.fn());
/** The plugins.home administration selection: a DIFFERENT fact from the origin. */
const administrationTargetSelection = vi.hoisted(() => Object.freeze({
    candidates: [],
    pickerRows: [],
    state: { kind: 'online' as const },
    selectedTarget: { serverIdentityId: 'srv_admin', machineId: 'machine-admin' },
    canExecute: true,
    selectTarget: () => {},
    clearTarget: () => {},
    resolveExecutionTarget: () => null,
}));
const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());

const ORIGIN_A = {
    serverIdentityId: 'srv_a',
    materializationRef: {
        machineId: 'machine-a',
        materializationId: 'materialization-a',
        pluginId: 'acme.plugin',
    },
} as const;

const ORIGIN_B = {
    serverIdentityId: 'srv_b',
    materializationRef: {
        machineId: 'machine-b',
        materializationId: 'materialization-b',
        pluginId: 'acme.plugin',
    },
} as const;

function materializationFor(origin: typeof ORIGIN_A | typeof ORIGIN_B) {
    return {
        serverIdentityId: origin.serverIdentityId,
        machineId: origin.materializationRef.machineId,
        materializationId: origin.materializationRef.materializationId,
        pluginId: origin.materializationRef.pluginId,
        version: '1.0.0',
        sourceClass: 'versionedArchive',
        portableRelease: true,
        uiArtifacts: [],
        enabled: true,
        trustState: 'trusted',
        observedAt: 1,
    } as const;
}

function snapshotsFor(origin: typeof ORIGIN_A | typeof ORIGIN_B) {
    const observedAt = Date.now();
    return [{
        kind: 'resolved',
        profileId: `profile-${origin.serverIdentityId}`,
        serverIdentityId: origin.serverIdentityId,
        serverName: origin.serverIdentityId,
        observation: 'live',
        machines: [{
            id: origin.materializationRef.machineId,
            updatedAt: 1,
            active: true,
            activeAt: observedAt,
            revokedAt: null,
            metadataVersion: 1,
            metadata: null,
        }],
    }] as const;
}

function availableLogResponse() {
    return {
        version: 1 as const,
        kind: 'available' as const,
        records: [],
        cursor: 1,
        hasMore: false,
    };
}

function flushAsync(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

vi.mock('expo-router', () => ({
    Redirect: 'Redirect',
    useNavigation: () => ({ setOptions: vi.fn() }),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: React.PropsWithChildren) => React.createElement('Item', props, props.children),
}));
vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: React.PropsWithChildren) => React.createElement('ItemGroup', props, props.children),
}));
vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: (props: React.PropsWithChildren) => React.createElement('ItemList', props, props.children),
}));
vi.mock('@/components/sessions/new/components/ServerScopedMachineSelector', () => ({
    ServerScopedMachineSelector: (props: React.PropsWithChildren) => React.createElement('ServerScopedMachineSelector', props, props.children),
}));
vi.mock('@/modal', () => ({ Modal: { prompt: vi.fn() } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));

vi.mock('@/sync/domains/plugins/availability/projection', () => ({
    useActivePluginAccountAvailabilityReader: () => ({
        readCurrentSettingsDeclaration: () => ({
            kind: 'unavailable',
            code: 'account_availability_not_loaded',
        }),
        readMaterializations: () => fixture.materializationAdmission,
    }),
    useActivePluginAccountAvailabilityReleaseClassifier: () => () => ({
        releaseContent: 'matched',
        validation: { kind: 'admitted' },
    }),
}));
vi.mock('@/sync/domains/machines/useMachineInventorySnapshots', () => ({
    useAllProfileMachineInventorySnapshots: () => fixture.snapshots,
}));
vi.mock('@/sync/store/hooks', () => ({
    useSetting: () => fixture.selections,
}));
vi.mock('@/sync/runtime/getSyncSingleton', () => ({
    getSyncSingleton: () => ({ mutateAccountSettings: mutateAccountSettingsMock }),
}));
vi.mock('@/sync/domains/machines/administration/useTargetSelection', () => ({
    resolveFreshMachineAdministrationExecutionTarget: ({ serverIdentityId, machineId }: {
        serverIdentityId: string;
        machineId: string;
    }) => ({
        target: { serverIdentityId, machineId },
        serverId: serverIdentityId === 'srv_a' ? 'server-profile-a' : 'server-profile-b',
        machine: {
            id: machineId,
            daemonStateVersion: 1,
        },
    }),
}));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (...args: readonly unknown[]) => machineRpcWithServerScopeMock(...args),
}));

vi.mock('@/components/settings/machines/MachineAdministrationTargetSelector', () => ({
    MachineAdministrationTargetSelector: (props: Readonly<Record<string, unknown>>) => {
        administrationTargetSelectorSpy(props);
        return React.createElement('MachineAdministrationTargetSelector');
    },
}));

vi.mock('./PluginDetailActionsSection', () => ({ PluginDetailActionsSection: 'PluginDetailActionsSection' }));
vi.mock('./PluginDetailContributionsSection', () => ({ PluginDetailContributionsSection: 'PluginDetailContributionsSection' }));
vi.mock('./PluginDetailDiagnosticsSection', () => ({ PluginDetailDiagnosticsSection: 'PluginDetailDiagnosticsSection' }));
vi.mock('./PluginDetailGenericSettingsSection', () => ({ PluginDetailGenericSettingsSection: 'PluginDetailGenericSettingsSection' }));
vi.mock('./PluginDetailHeader', () => ({
    PluginDetailHeader: 'PluginDetailHeader',
    PluginDetailRecoveryHeader: 'PluginDetailRecoveryHeader',
}));
vi.mock('./PluginDetailSummaryGrid', () => ({ PluginDetailSummaryGrid: 'PluginDetailSummaryGrid' }));
vi.mock('../PluginAccountDataEraseRecoverySection', () => ({ PluginAccountDataEraseRecoverySection: 'PluginAccountDataEraseRecoverySection' }));
vi.mock('../PluginAccountReleaseSelectionSection', () => ({ PluginAccountReleaseSelectionSection: 'PluginAccountReleaseSelectionSection' }));
vi.mock('../PluginReadOnlySnapshotNotice', () => ({ PluginReadOnlySnapshotNotice: 'PluginReadOnlySnapshotNotice' }));
vi.mock('../model/usePluginSettingsScreenState', () => ({
    usePluginSettingsScreenState: () => ({
        accountServerIdentityId: null,
        selectedServerIdentityId: administrationTargetSelection.selectedTarget?.serverIdentityId ?? null,
        canRefreshInstalledPlugins: false,
        daemonOperationsAvailable: false,
        executionMachineId: null,
        executionServerId: null,
        executionServerIdentityId: null,
        installedPluginById: fixture.installedPluginById,
        isPluginActionInFlight: () => false,
        isDaemonSettingsTargetCurrent: () => true,
        administrationTargetSelection,
        pluginProjectionById: {},
        pluginProjectionV2: null,
        readOnlySnapshotNotice: null,
        refreshPluginTruth: vi.fn(),
        registryDiagnostics: [],
        runInstalledPluginAction: vi.fn(),
    }),
}));

describe('PluginDetailScreen execution-origin ownership', () => {
    beforeEach(() => {
        fixture.installedPluginById = new Map([['acme.plugin', {
            pluginId: 'acme.plugin',
            title: 'Acme plugin',
            version: '1.0.0',
            enabled: true,
        }]]);
        fixture.selections = {
            v: 1,
            targetsByKey: {},
            pluginExecutionOriginsByPluginId: {},
        };
        fixture.materializationAdmission = {
            kind: 'available',
            availabilityCursor: 1,
            materializations: [materializationFor(ORIGIN_A)],
        };
        fixture.snapshots = snapshotsFor(ORIGIN_A);
        fixture.accountSettings = {
            machineAdministrationSelectionsV1: fixture.selections,
        };
        mutateAccountSettingsMock.mockReset();
        mutateAccountSettingsMock.mockImplementation(async (mutate: AccountSettingsMutation) => {
            fixture.accountSettings = mutate(fixture.accountSettings);
            fixture.selections = fixture.accountSettings.machineAdministrationSelectionsV1;
        });
        machineRpcWithServerScopeMock.mockReset();
        machineRpcWithServerScopeMock.mockResolvedValue(availableLogResponse());
        administrationTargetSelectorSpy.mockClear();
    });

    afterEach(() => {
        standardCleanup();
    });

    it('initializes one sole origin and keeps the selector and log reader on its exact target through an origin change', async () => {
        const { PluginDetailScreen } = await import('./PluginDetailScreen');
        const RerenderablePluginDetailScreen = PluginDetailScreen as unknown as React.ComponentType<{
            pluginId: string;
            revision: number;
        }>;
        const screen = await renderScreen(<RerenderablePluginDetailScreen pluginId="acme.plugin" revision={1} />);
        await act(async () => {
            await flushAsync();
        });

        expect(mutateAccountSettingsMock).toHaveBeenCalledOnce();
        expect(fixture.accountSettings).toMatchObject({
            machineAdministrationSelectionsV1: {
                pluginExecutionOriginsByPluginId: { 'acme.plugin': ORIGIN_A },
            },
        });
        await act(async () => {
            screen.tree.update(<RerenderablePluginDetailScreen pluginId="acme.plugin" revision={2} />);
            await flushAsync();
        });
        expect(screen.findByTestId('settings.plugins.detail.executionOrigin.current')?.props)
            .toMatchObject({ title: 'machine-a', subtitle: 'srv_a', selected: true });
        expect(screen.findByTestId('settings.plugins.detail.acme.plugin.invocationLogs.target')?.props)
            .toMatchObject({ title: 'machine-a', subtitle: 'srv_a', selected: true });
        expect(screen.findByTestId('settings.plugins.detail.acme.plugin.accountRelease')?.props)
            .toMatchObject({
                pluginId: 'acme.plugin',
                version: '1.0.0',
                projection: null,
                daemon: { serverId: null, serverIdentityId: null, machineId: null },
            });
        expect(machineRpcWithServerScopeMock).toHaveBeenLastCalledWith(expect.objectContaining({
            machineId: 'machine-a',
            serverId: 'server-profile-a',
        }));

        fixture.selections = {
            v: 1,
            targetsByKey: {},
            pluginExecutionOriginsByPluginId: { 'acme.plugin': ORIGIN_B },
        };
        fixture.materializationAdmission = {
            kind: 'available',
            availabilityCursor: 2,
            materializations: [materializationFor(ORIGIN_B)],
        };
        fixture.snapshots = snapshotsFor(ORIGIN_B);
        await act(async () => {
            screen.tree.update(<RerenderablePluginDetailScreen pluginId="acme.plugin" revision={3} />);
            await flushAsync();
        });

        expect(mutateAccountSettingsMock).toHaveBeenCalledOnce();
        expect(screen.findByTestId('settings.plugins.detail.executionOrigin.current')?.props)
            .toMatchObject({ title: 'machine-b', subtitle: 'srv_b', selected: true });
        expect(screen.findByTestId('settings.plugins.detail.acme.plugin.invocationLogs.target')?.props)
            .toMatchObject({ title: 'machine-b', subtitle: 'srv_b', selected: true });
        expect(machineRpcWithServerScopeMock).toHaveBeenLastCalledWith(expect.objectContaining({
            machineId: 'machine-b',
            serverId: 'server-profile-b',
        }));

        // Execution origin moved A -> B, but the administration target this
        // screen's Settings, Secrets and lifecycle operations address is a
        // SEPARATE preference and must be presented as itself rather than
        // silently inherited from — or collapsed into — the origin.
        expect(administrationTargetSelectorSpy).toHaveBeenCalledWith(expect.objectContaining({
            selection: administrationTargetSelection,
            testIDPrefix: 'settings.plugins.detail.administration.target',
        }));
        expect(administrationTargetSelection.selectedTarget).not.toMatchObject({
            machineId: ORIGIN_B.materializationRef.machineId,
        });
    });

    /**
     * The Account-recovery route is entered exactly when the selected machine
     * has no installation and no projection for a plugin the Account still
     * has somewhere else. That is the one route where "which machine actually
     * has this?" is the reader's whole question, so the Account-wide matrix
     * has to be there and not only on the installed route.
     */
    it('answers where the plugin actually lives on the Account-recovery route', async () => {
        fixture.installedPluginById = new Map();
        const { PluginDetailScreen } = await import('./PluginDetailScreen');
        const screen = await renderScreen(<PluginDetailScreen pluginId="acme.plugin" />);
        await act(async () => {
            await flushAsync();
        });

        // `findByTestId` returns null on a miss, so `toBeDefined()` would pass
        // against the unwired screen. Assert the instance itself is truthy.
        expect(screen.findByTestId('settings.plugins.detail.machineMatrix.acme.plugin.summary'))
            .toBeTruthy();
        expect(screen.findByTestId('settings.plugins.detail.machineMatrix.acme.plugin.cell')?.props)
            .toMatchObject({ title: 'machine-a', mode: 'info' });
    });
});
