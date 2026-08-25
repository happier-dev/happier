import * as React from 'react';
import { Redirect, useNavigation } from 'expo-router';
import type { PluginPortableReleaseManifestV1 } from '@happier-dev/protocol/plugins/availability';

import type { PluginProjectionEntry } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import { MachineAdministrationTargetSelector } from '@/components/settings/machines/MachineAdministrationTargetSelector';
import { PluginMachineExecutionOriginSelectorView } from '@/components/settings/machines/PluginMachineExecutionOriginSelector';
import { ItemList } from '@/components/ui/lists/ItemList';
import { usePluginMachineExecutionOriginSelection } from '@/sync/domains/machines/administration/usePluginExecutionOriginSelection';
import {
    useActivePluginAccountAvailabilityReader,
    useActivePluginAccountAvailabilityReleaseClassifier,
} from '@/sync/domains/plugins/availability/projection';
import type { PluginAccountAvailabilityReader } from '@/sync/domains/plugins/availability/reader';
import { t } from '@/text';

import { PluginDetailActionsSection } from './PluginDetailActionsSection';
import { PluginDetailContributionsSection } from './PluginDetailContributionsSection';
import { PluginDetailDiagnosticsSection } from './PluginDetailDiagnosticsSection';
import { PluginDetailGenericSettingsSection } from './PluginDetailGenericSettingsSection';
import { PluginDetailHeader, PluginDetailRecoveryHeader } from './PluginDetailHeader';
import {
    PluginDetailInvocationLogsSection,
    PluginDetailInvocationLogsUnavailableSection,
} from './PluginDetailInvocationLogsSection';
import { PluginDetailSummaryGrid } from './PluginDetailSummaryGrid';
import { PluginMachineMatrixSection } from '../machines/PluginMachineMatrixSection';
import {
    usePluginSettingsScreenState,
    type PluginSettingsScreenState,
} from '../model/usePluginSettingsScreenState';
import type { InstalledPluginEntry } from '../model/pluginMarketplaceModel';
import { PluginAccountDataEraseRecoverySection } from '../PluginAccountDataEraseRecoverySection';
import { PluginAccountReleaseSelectionSection } from '../PluginAccountReleaseSelectionSection';
import { PluginReadOnlySnapshotNotice } from '../PluginReadOnlySnapshotNotice';

type NavigationLike = Readonly<{
    setOptions?: (options: Readonly<{ headerTitle?: string }>) => void;
}>;

/**
 * One screen-owned execution-origin controller feeds both its presentation and
 * the log reader. Installed-only management stays conditional without hiding a
 * current daemon projection or inventing installed metadata for it.
 */
function PluginDetailCurrentContent(props: Readonly<{
    pluginId: string;
    installed: InstalledPluginEntry | null;
    state: PluginSettingsScreenState;
    projection: PluginProjectionEntry | null;
    accountSettingsDeclaration: PluginPortableReleaseManifestV1 | null;
    accountAvailability: PluginAccountAvailabilityReader | null;
}>) {
    const classifyRelease = useActivePluginAccountAvailabilityReleaseClassifier();
    const selection = usePluginMachineExecutionOriginSelection({
        pluginId: props.pluginId,
        classifyRelease,
    });
    const accountReleaseVersion = props.installed?.version ?? props.projection?.version ?? null;
    return (
        <ItemList style={{ paddingTop: 0 }}>
            {props.state.readOnlySnapshotNotice ? (
                <PluginReadOnlySnapshotNotice
                    testID="settings.plugins.detail.readOnlySnapshot"
                    reason={props.state.readOnlySnapshotNotice.reason}
                    onRetry={props.state.refreshPluginTruth}
                />
            ) : null}
            {/*
              * Two different facts, both true at once, and neither derivable
              * from the other: the plugin EXECUTES on the origin below, while
              * its Settings, Secrets and lifecycle operations are ADMINISTERED
              * on the machine selected here. Showing only the origin left the
              * reader editing a machine the screen never named.
              */}
            <MachineAdministrationTargetSelector
                selection={props.state.administrationTargetSelection}
                testIDPrefix="settings.plugins.detail.administration.target"
            />
            <PluginMachineExecutionOriginSelectorView
                selection={selection}
                testIDPrefix="settings.plugins.detail.executionOrigin"
            />
            {/*
              * Read-only Account-wide truth for this one plugin: where it is
              * installed and where it is missing or broken. It selects nothing
              * — the two selectors above remain the only target authorities.
              */}
            <PluginMachineMatrixSection
                pluginId={props.pluginId}
                testIDPrefix="settings.plugins.detail.machineMatrix"
            />
            {props.installed ? (
                <>
                    <PluginDetailHeader installed={props.installed} projection={props.projection} />
                    <PluginDetailSummaryGrid
                        installed={props.installed}
                        projection={props.projection}
                    />
                    <PluginDetailActionsSection
                        installed={props.installed}
                        actionInFlight={props.state.isPluginActionInFlight(props.installed.pluginId)}
                        canRunActions={props.state.canRefreshInstalledPlugins}
                        onAction={props.state.runInstalledPluginAction}
                    />
                    <PluginAccountDataEraseRecoverySection
                        pluginId={props.installed.pluginId}
                        testID={`settings.plugins.detail.${props.installed.pluginId}.accountDataErase`}
                    />
                </>
            ) : null}
            {accountReleaseVersion ? (
                <PluginAccountReleaseSelectionSection
                    pluginId={props.pluginId}
                    version={accountReleaseVersion}
                    reader={props.accountAvailability}
                    projection={props.state.pluginProjectionV2}
                    daemon={{
                        serverId: props.state.executionServerId,
                        serverIdentityId: props.state.executionServerIdentityId,
                        machineId: props.state.executionMachineId,
                    }}
                    testID={`settings.plugins.detail.${props.pluginId}.accountRelease`}
                />
            ) : null}
            <PluginDetailGenericSettingsSection
                pluginId={props.pluginId}
                projection={props.projection}
                accountSettingsDeclaration={props.accountSettingsDeclaration}
                machineId={props.state.executionMachineId}
                serverId={props.state.executionServerId}
                accountServerIdentityId={props.state.accountServerIdentityId}
                daemonServerIdentityId={props.state.executionServerIdentityId}
                perActiveServerIdentityId={props.state.selectedServerIdentityId}
                daemonOperationsAvailable={props.state.daemonOperationsAvailable}
                isDaemonTargetCurrent={props.state.isDaemonSettingsTargetCurrent}
            />
            <PluginDetailContributionsSection pluginId={props.pluginId} projection={props.projection} />
            <PluginDetailInvocationLogsSection
                pluginId={props.pluginId}
                selection={selection}
            />
            <PluginDetailDiagnosticsSection
                pluginId={props.pluginId}
                projection={props.projection}
                registryDiagnostics={props.state.registryDiagnostics}
                machineId={props.state.executionMachineId}
            />
        </ItemList>
    );
}

export const PluginDetailScreen = React.memo(function PluginDetailScreen(props: Readonly<{
    pluginId: string | null;
}>) {
    const navigation = useNavigation() as NavigationLike;
    const state = usePluginSettingsScreenState();
    const accountAvailability = useActivePluginAccountAvailabilityReader();
    const installed = props.pluginId ? (state.installedPluginById.get(props.pluginId) ?? null) : null;
    const projection = props.pluginId ? (state.pluginProjectionById[props.pluginId] ?? null) : null;
    const accountSettingsDeclaration = React.useMemo(() => {
        if (projection || !props.pluginId || !accountAvailability) return null;
        const admission = accountAvailability.readCurrentSettingsDeclaration({ pluginId: props.pluginId });
        return admission.kind === 'available' ? admission.declaration : null;
    }, [accountAvailability, projection, props.pluginId]);
    const accountRecoveryPluginId = React.useMemo(() => {
        if (installed || projection || !props.pluginId) return null;
        if (!accountAvailability) return null;
        const admission = accountAvailability.readMaterializations();
        return accountSettingsDeclaration !== null
            || (
                admission.kind === 'available'
                && admission.materializations.some((materialization) => materialization.pluginId === props.pluginId)
            )
            ? props.pluginId
            : null;
    }, [accountAvailability, accountSettingsDeclaration, installed, projection, props.pluginId]);
    const headerTitle = projection?.title
        ?? installed?.title
        ?? (typeof accountSettingsDeclaration?.displayName === 'string'
            ? accountSettingsDeclaration.displayName
            : accountSettingsDeclaration?.displayName?.fallback ?? accountRecoveryPluginId ?? '');

    React.useLayoutEffect(() => {
        if (headerTitle) navigation.setOptions?.({ headerTitle });
    }, [headerTitle, navigation]);

    if (!props.pluginId || (!installed && !projection && !accountRecoveryPluginId)) {
        return <Redirect href="/settings/plugins" />;
    }

    if (installed || projection) {
        return (
            <PluginDetailCurrentContent
                pluginId={props.pluginId}
                installed={installed}
                state={state}
                projection={projection}
                accountSettingsDeclaration={accountSettingsDeclaration}
                accountAvailability={accountAvailability}
            />
        );
    }

    const recoveryPluginId = accountRecoveryPluginId;
    if (!recoveryPluginId) return <Redirect href="/settings/plugins" />;
    return (
        <ItemList style={{ paddingTop: 0 }}>
            <PluginDetailRecoveryHeader
                pluginId={recoveryPluginId}
                title={headerTitle}
            />
            <PluginReadOnlySnapshotNotice
                testID={`settings.plugins.detail.${recoveryPluginId}.accountRecovery`}
                reason="accountRecovery"
            />
            {/*
              * This route is reached precisely because the selected machine has
              * no installation for a plugin the Account still holds elsewhere,
              * so "which machine actually has it?" is the reader's whole
              * question here. Same read-only Account-wide section as the
              * installed route; it still selects and mutates nothing.
              */}
            <PluginMachineMatrixSection
                pluginId={recoveryPluginId}
                testIDPrefix="settings.plugins.detail.machineMatrix"
            />
            {accountSettingsDeclaration ? (
                <PluginDetailGenericSettingsSection
                    pluginId={recoveryPluginId}
                    projection={null}
                    accountSettingsDeclaration={accountSettingsDeclaration}
                    machineId={null}
                    serverId={null}
                    accountServerIdentityId={state.accountServerIdentityId}
                    daemonServerIdentityId={null}
                    perActiveServerIdentityId={state.selectedServerIdentityId}
                    daemonOperationsAvailable={false}
                />
            ) : null}
            <PluginAccountDataEraseRecoverySection
                pluginId={recoveryPluginId}
                testID={`settings.plugins.detail.${recoveryPluginId}.accountDataErase`}
            />
            <PluginDetailInvocationLogsUnavailableSection pluginId={recoveryPluginId} />
        </ItemList>
    );
});

export default PluginDetailScreen;
