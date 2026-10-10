import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PluginManifestV2Schema } from '@happier-dev/protocol';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { PluginDetailScreen } from './PluginDetailScreen';

vi.mock('@react-navigation/native', async () => (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());

const PLUGIN_ID = 'example.tasks';

const declaration = PluginManifestV2Schema.parse({
    schemaVersion: 2,
    id: PLUGIN_ID,
    version: '2.0.0',
    displayName: 'Tasks',
    engines: { happier: '^1.0.0' },
    runtime: { apiVersion: 1 },
    contributes: {},
});

const accountAvailabilityReader = vi.hoisted(() => ({
    readCurrentSettingsDeclaration: vi.fn(() => ({
        kind: 'unavailable' as const,
        code: 'account_availability_not_loaded' as const,
    })),
    readMaterializations: vi.fn(() => ({
        kind: 'unavailable' as const,
        code: 'account_availability_not_loaded' as const,
    })),
}));
const pluginSettingsState = vi.hoisted(() => ({ pluginTruthSettled: true, refreshing: false, failed: false }));

vi.mock('expo-router', () => ({
    Redirect: 'Redirect',
    useNavigation: () => ({ setOptions: vi.fn() }),
    usePathname: () => '/settings/plugins/acme.tools',
}));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/components/ui/lists/Item', () => ({ Item: 'Item' }));
vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: React.PropsWithChildren) => React.createElement('ItemGroup', props, props.children),
}));
vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: (props: React.PropsWithChildren) => React.createElement('ItemList', props, props.children),
}));
vi.mock('@/components/ui/panels/PaneLoadingFallback', () => ({
    PaneLoadingFallback: 'PaneLoadingFallback',
}));
vi.mock('@/modal', () => ({ Modal: { prompt: vi.fn(), confirm: vi.fn(), alert: vi.fn() } }));
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@/components/settings/machines/MachineAdministrationTargetSelector', () => ({
    MachineAdministrationTargetSelector: 'MachineAdministrationTargetSelector',
}));
vi.mock('@/components/settings/machines/PluginMachineExecutionOriginSelector', () => ({
    PluginMachineExecutionOriginSelectorView: 'PluginMachineExecutionOriginSelectorView',
}));
vi.mock('@/sync/domains/machines/administration/usePluginExecutionOriginSelection', () => ({
    usePluginMachineExecutionOriginSelection: () => ({ candidates: [], selectedTarget: null }),
}));
vi.mock('@/sync/domains/plugins/availability/projection', () => ({
    useActivePluginAccountAvailabilityReader: () => accountAvailabilityReader,
    useActivePluginAccountAvailabilityReleaseClassifier: () => () => ({
        releaseContent: 'unknown',
        validation: { kind: 'rejected', reason: 'unknown' },
    }),
}));

vi.mock('./PluginDetailActionsSection', () => ({ PluginDetailActionsSection: 'PluginDetailActionsSection' }));
vi.mock('./PluginDetailContributionsSection', () => ({ PluginDetailContributionsSection: 'PluginDetailContributionsSection' }));
vi.mock('./PluginDetailDiagnosticsSection', () => ({ PluginDetailDiagnosticsSection: 'PluginDetailDiagnosticsSection' }));
vi.mock('./PluginDetailGenericSettingsSection', () => ({ PluginDetailGenericSettingsSection: 'PluginDetailGenericSettingsSection' }));
vi.mock('./PluginDetailHeader', () => ({
    PluginDetailHeader: 'PluginDetailHeader',
    PluginDetailRecoveryHeader: 'PluginDetailRecoveryHeader',
}));
vi.mock('./PluginDetailInvocationLogsSection', () => ({
    PluginDetailInvocationLogsSection: 'PluginDetailInvocationLogsSection',
    PluginDetailInvocationLogsUnavailableSection: 'PluginDetailInvocationLogsUnavailableSection',
}));
vi.mock('./PluginDetailSummaryGrid', () => ({ PluginDetailSummaryGrid: 'PluginDetailSummaryGrid' }));
vi.mock('../machines/PluginMachineMatrixSection', () => ({ PluginMachineMatrixSection: 'PluginMachineMatrixSection' }));
vi.mock('../PluginAccountDataEraseRecoverySection', () => ({ PluginAccountDataEraseRecoverySection: 'PluginAccountDataEraseRecoverySection' }));
vi.mock('./PluginDetailLeaveActions', () => ({ PluginDetailLeaveActions: 'PluginDetailLeaveActions' }));
vi.mock('../PluginAccountReleaseSelectionSection', () => ({ PluginAccountReleaseSelectionSection: 'PluginAccountReleaseSelectionSection' }));
vi.mock('../PluginReadOnlySnapshotNotice', () => ({ PluginReadOnlySnapshotNotice: 'PluginReadOnlySnapshotNotice' }));
vi.mock('../model/usePluginSettingsScreenState', () => ({
    usePluginSettingsScreenState: () => ({
        accountServerIdentityId: null,
        administrationTargetSelection: {},
        canRefreshInstalledPlugins: false,
        daemonOperationsAvailable: false,
        executionMachineId: null,
        executionServerId: null,
        executionServerIdentityId: null,
        installedPluginById: new Map(),
        installedPlugins: [],
        installedPluginsRead: !pluginSettingsState.failed,
        isDaemonSettingsTargetCurrent: () => true,
        isPluginActionInFlight: () => false,
        pluginProjectionById: {},
        pluginProjectionV2: null,
        pluginTruthSettled: pluginSettingsState.pluginTruthSettled,
        readOnlySnapshotNotice: pluginSettingsState.failed ? { reason: 'projectionUnavailable' }
            : pluginSettingsState.refreshing ? { reason: 'refreshing' } : null,
        refreshPluginTruth: vi.fn(),
        registryDiagnostics: [],
        runInstalledPluginAction: vi.fn(),
        selectedServerIdentityId: null,
    }),
}));

afterEach(() => {
    standardCleanup();
    pluginSettingsState.pluginTruthSettled = true;
    pluginSettingsState.refreshing = false;
    pluginSettingsState.failed = false;
    accountAvailabilityReader.readCurrentSettingsDeclaration.mockReturnValue({
        kind: 'unavailable',
        code: 'account_availability_not_loaded',
    });
});

describe('PluginDetailScreen Account hosting reachability', () => {
    it('keeps a cold deep link in place until the selected machine truth settles', async () => {
        pluginSettingsState.pluginTruthSettled = false;
        pluginSettingsState.refreshing = true;
        const screen = await renderScreen(<PluginDetailScreen pluginId={PLUGIN_ID} />);

        expect(screen.findAllByType('Redirect')).toHaveLength(0);
        expect(screen.findAllByType('PaneLoadingFallback')).toHaveLength(1);
    });

    it('does not claim an installation is missing when the settled machine read failed', async () => {
        pluginSettingsState.failed = true;
        const screen = await renderScreen(<PluginDetailScreen pluginId={PLUGIN_ID} />);
        expect(screen.findAllByType('PluginReadOnlySnapshotNotice')).toHaveLength(1);
        expect(screen.findByTestId(`settings.plugins.detail.${PLUGIN_ID}.notInstalled`)).toBeNull();
    });

    it('keeps the Account hosting lifecycle reachable when no machine holds the plugin', async () => {
        // The Account-hosted archive is exactly what a reader still needs to
        // inspect, disable, remove or uncache while every daemon that once
        // installed this plugin is offline or has uninstalled it.
        accountAvailabilityReader.readCurrentSettingsDeclaration.mockReturnValue({
            kind: 'available',
            availabilityCursor: 7,
            declaration,
        } as never);
        const screen = await renderScreen(<PluginDetailScreen pluginId={PLUGIN_ID} />);

        expect(screen.findAllByType('Redirect')).toHaveLength(0);
        expect(screen.findByTestId(`settings.plugins.detail.${PLUGIN_ID}.accountRelease`)?.props)
            .toMatchObject({
                pluginId: PLUGIN_ID,
                version: null,
                projection: null,
                daemon: { serverId: null, serverIdentityId: null, machineId: null },
            });
    });
});
