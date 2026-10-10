import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { PluginMachineMaterializationAdmission } from '@/sync/domains/plugins/availability/reader';
import type { InstalledPluginEntry } from '../model/pluginMarketplaceModel';

vi.mock('@react-navigation/native', async () => (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());

type AccountSettingsOneShotMutation = Readonly<{
    expectedSettingsVersion: number;
    mutate: (raw: Readonly<Record<string, unknown>>) => {
        settings: Record<string, unknown>;
        value: unknown;
    };
}>;

const fixture = vi.hoisted(() => ({
    accountSettings: {} as Record<string, unknown>,
    installedPluginById: new Map<string, InstalledPluginEntry>(),
    materializationAdmission: null as unknown,
    selections: null as unknown,
    snapshots: [] as readonly unknown[],
}));
const mutateAccountSettingsOnceMock = vi.hoisted(() => vi.fn());
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

/** Complete current `PluginMachineMaterializationAdmission` available arm. */
function availableAdmission(
    availabilityCursor: number,
    materializations: readonly ReturnType<typeof materializationFor>[],
): PluginMachineMaterializationAdmission {
    return {
        kind: 'available',
        availabilityCursor,
        intentReads: [],
        materializations: materializations.map((row) => ({ ...row })),
        snapshots: materializations.map((row, index) => ({
            serverIdentityId: row.serverIdentityId,
            machineId: row.machineId,
            revision: index + 1,
            materializations: [{ ...row }],
        })),
    };
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
    usePathname: () => '/settings/plugins/acme.tools',
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
// Persistent storage boundary: the module's whole runtime surface is
// `storage` + `getStorage`, both backed by the canonical live store mock, so
// the real settings hooks read the fixture's selections and version.
vi.mock('@/sync/domains/state/storageStore', async () => {
    const { createLiveStorageStoreMock } = await import('@/dev/testkit/mocks/storage');
    const store = createLiveStorageStoreMock(() => ({
        settings: { machineAdministrationSelectionsV1: fixture.selections } as never,
        settingsVersion: 7,
        settingsScope: { serverId: 'server-account', accountId: 'account-origin-detail' },
    }));
    return { storage: store, getStorage: () => store };
});
vi.mock('@/sync/runtime/getSyncSingleton', () => ({
    getSyncSingleton: () => ({ mutateAccountSettingsOnce: mutateAccountSettingsOnceMock }),
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
vi.mock('./PluginDetailLeaveActions', () => ({ PluginDetailLeaveActions: 'PluginDetailLeaveActions' }));
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
        installedPlugins: [...fixture.installedPluginById.values()],
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
            description: null,
            version: '1.0.0',
            enabled: true,
            source: {
                kind: 'localPath',
                locator: '/plugins/acme.plugin',
                trustPolicy: 'trusted',
            },
            install: {
                mode: 'copy',
                manifestVersion: '1.0.0',
            },
            compatibility: { status: 'compatible', diagnostics: [] },
            diagnostics: [],
        }]]);
        fixture.selections = {
            v: 1,
            pluginExecutionOriginsByPluginId: {},
        };
        fixture.materializationAdmission = availableAdmission(1, [materializationFor(ORIGIN_A)]);
        fixture.snapshots = snapshotsFor(ORIGIN_A);
        fixture.accountSettings = {
            machineAdministrationSelectionsV1: fixture.selections,
        };
        mutateAccountSettingsOnceMock.mockReset();
        mutateAccountSettingsOnceMock.mockImplementation(async (params: AccountSettingsOneShotMutation) => {
            const mutation = params.mutate(fixture.accountSettings);
            fixture.accountSettings = mutation.settings;
            fixture.selections = mutation.settings.machineAdministrationSelectionsV1;
            return {
                status: 'applied' as const,
                settingsVersion: params.expectedSettingsVersion + 1,
                value: undefined,
            };
        });
        machineRpcWithServerScopeMock.mockReset();
        machineRpcWithServerScopeMock.mockResolvedValue(availableLogResponse());
        administrationTargetSelectorSpy.mockClear();
    });

    afterEach(() => {
        standardCleanup();
    });

    it('projects one sole origin without persisting and keeps the log reader on its exact target through an origin change', async () => {
        const { PluginDetailScreen } = await import('./PluginDetailScreen');
        const RerenderablePluginDetailScreen = PluginDetailScreen as unknown as React.ComponentType<{
            pluginId: string;
            revision: number;
        }>;
        const screen = await renderScreen(<RerenderablePluginDetailScreen pluginId="acme.plugin" revision={1} />);
        await act(async () => {
            await flushAsync();
        });

        expect(mutateAccountSettingsOnceMock).not.toHaveBeenCalled();
        expect(fixture.accountSettings).toMatchObject({ machineAdministrationSelectionsV1: { pluginExecutionOriginsByPluginId: {} } });
        await act(async () => {
            screen.tree.update(<RerenderablePluginDetailScreen pluginId="acme.plugin" revision={2} />);
            await flushAsync();
        });
        // The current-origin row names the server and, on its own line, the
        // materialized version running there.
        expect(screen.findByTestId('settings.plugins.detail.executionOrigin.current')?.props)
            .toMatchObject({ title: 'machine-a', subtitle: 'srv_a\ncommon.version 1.0.0', selected: true });
        expect(screen.findByTestId('settings.plugins.detail.acme.plugin.invocationLogs.target')?.props)
            .toMatchObject({ title: 'machine-a', subtitle: 'srv_a', selected: true });
        expect(screen.findByTestId('settings.plugins.detail.acme.plugin.accountRelease')?.props)
            .toMatchObject({
                pluginId: 'acme.plugin',
                version: '1.0.0',
                projection: null,
                daemon: { serverId: null, serverIdentityId: null, machineId: null },
            });
        await act(async () => {
            screen.pressByTestId('settings.plugins.detail.acme.plugin.invocationLogs.refresh');
            await flushAsync();
        });
        expect(machineRpcWithServerScopeMock).toHaveBeenLastCalledWith(expect.objectContaining({
            machineId: 'machine-a',
            serverId: 'server-profile-a',
        }));

        fixture.selections = {
            v: 1,
            pluginExecutionOriginsByPluginId: { 'acme.plugin': ORIGIN_B },
        };
        fixture.materializationAdmission = availableAdmission(2, [materializationFor(ORIGIN_B)]);
        fixture.snapshots = snapshotsFor(ORIGIN_B);
        await act(async () => {
            screen.tree.update(<RerenderablePluginDetailScreen pluginId="acme.plugin" revision={3} />);
            await flushAsync();
        });

        expect(mutateAccountSettingsOnceMock).not.toHaveBeenCalled();
        // The current-origin row names the server and, on its own line, the
        // materialized version running there.
        expect(screen.findByTestId('settings.plugins.detail.executionOrigin.current')?.props)
            .toMatchObject({ title: 'machine-b', subtitle: 'srv_b\ncommon.version 1.0.0', selected: true });
        expect(screen.findByTestId('settings.plugins.detail.acme.plugin.invocationLogs.target')?.props)
            .toMatchObject({ title: 'machine-b', subtitle: 'srv_b', selected: true });
        await act(async () => {
            screen.pressByTestId('settings.plugins.detail.acme.plugin.invocationLogs.refresh');
            await flushAsync();
        });
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
     * The two machine authorities on this screen are different facts: where
     * Settings, Secrets and lifecycle operations are ADMINISTERED versus where
     * the plugin EXECUTES. Two sections about different machines must not
     * share one identical "Target machine" heading, and the administration
     * target must stay ahead of the consequential controls below it.
     */
    it('names the administration-target and execution-origin sections distinctly in reading order', async () => {
        const { PluginDetailScreen } = await import('./PluginDetailScreen');
        const screen = await renderScreen(<PluginDetailScreen pluginId="acme.plugin" />);
        await act(async () => {
            await flushAsync();
        });

        // The administration target is the "Manage on [machine]" context bar:
        // its label names the fact, its chip is the canonical selector.
        expect(administrationTargetSelectorSpy).toHaveBeenCalledWith(expect.objectContaining({
            selection: administrationTargetSelection,
            presentation: 'chip',
            testIDPrefix: 'settings.plugins.detail.administration.target',
        }));
        expect(screen.findAll((node) => (
            node.props?.children === 'settingsPlugins.administrationMachineTitle'
        )).length).toBeGreaterThan(0);
        expect(screen.findAll((node) => (
            (node.type as unknown) === 'ItemGroup'
            && node.props?.title === 'settingsPlugins.executionOriginTitle'
        ))).toHaveLength(1);
        expect(screen.findAllByProps({ title: 'settingsProviders.detail.targetMachine' })).toHaveLength(0);

        // Screen-reader order: the administration context bar sits above the
        // entity header (the entity-page pattern) and so precedes the
        // execution-origin section and every consequential control after it.
        const hostNodes = screen.findAll((node) => typeof node.type === 'string');
        const headerIndex = hostNodes.findIndex((node) => (node.type as unknown) === 'PluginDetailHeader');
        const administrationIndex = hostNodes.findIndex((node) => (node.type as unknown) === 'MachineAdministrationTargetSelector');
        const executionOriginIndex = hostNodes.findIndex((node) => (
            (node.type as unknown) === 'ItemGroup' && node.props?.title === 'settingsPlugins.executionOriginTitle'
        ));
        expect(administrationIndex).toBeGreaterThanOrEqual(0);
        expect(headerIndex).toBeGreaterThan(administrationIndex);
        expect(executionOriginIndex).toBeGreaterThan(headerIndex);
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

        // The Machines summary answers it at once: where the plugin is current,
        // by name, with no disclosure to open. `findByTestId` returns null on a
        // miss, so assert the instance itself.
        expect(screen.findByTestId('settings.plugins.detail.machineMatrix.summary')?.props)
            .toMatchObject({ subtitle: 'machine-a', mode: 'info' });
    });
});
