import * as React from 'react';
import { useIsFocused } from '@/components/appShell/workspace/destinationRoute';
import { Redirect } from '@/components/appShell/workspace/destinationRoute';
import type { PluginPortableReleaseManifestV1 } from '@happier-dev/protocol/plugins/availability';

import type { PluginProjectionEntry } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import { MachineAdministrationContextBar } from '@/components/settings/machines/MachineAdministrationContextBar';
import { PluginMachineExecutionOriginSelectorView } from '@/components/settings/machines/PluginMachineExecutionOriginSelector';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Item } from '@/components/ui/lists/Item';
import { usePageNoticeActive } from '@/components/ui/lists/listPresentation';
import { PaneLoadingFallback } from '@/components/ui/panels/PaneLoadingFallback';
import type { PageHeaderMenuAction } from '@/components/ui/layout/PageHeaderEntityParts';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { usePluginSurfaceExecutionOrigin } from '@/components/plugins/surfaces/pluginSurfaceExecutionOrigin';
import { useAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import {
    useActivePluginAccountAvailabilityReader,
} from '@/sync/domains/plugins/availability/projection';
import type { PluginAccountAvailabilityReader } from '@/sync/domains/plugins/availability/reader';
import { t } from '@/text';

import { PluginDetailContributionsSection } from './PluginDetailContributionsSection';
import { PluginDetailDiagnosticsSection } from './PluginDetailDiagnosticsSection';
import { PluginDetailGenericSettingsSection } from './PluginDetailGenericSettingsSection';
import { PluginDetailHeader, PluginDetailRecoveryHeader } from './PluginDetailHeader';
import {
    PluginDetailInvocationLogsSection,
    PluginDetailInvocationLogsUnavailableSection,
} from './PluginDetailInvocationLogsSection';
import { PluginDetailLeaveActions } from './PluginDetailLeaveActions';
import { PluginMachineMatrixSection } from '../machines/PluginMachineMatrixSection';
import {
    usePluginSettingsScreenState,
    type InstalledPluginActionId,
    type PluginSettingsScreenState,
} from '../model/usePluginSettingsScreenState';
import { buildPluginsHomeRoute, usePluginsSurfaceHost } from '../model/pluginsSurfaceRoutes';
import {
    projectInstalledPluginLifecycleCapabilities,
    type InstalledPluginEntry,
} from '../model/pluginMarketplaceModel';
import { PluginAccountReleaseSelectionSection } from '../PluginAccountReleaseSelectionSection';
import { PluginReadOnlySnapshotNotice } from '../PluginReadOnlySnapshotNotice';
import { PluginUpdatePolicySection } from './PluginUpdatePolicySection';
import { PluginRoutineOperationSettlementRow } from '../PluginMarketplaceSections';

/**
 * One screen-owned execution-origin controller feeds both its presentation and
 * the log reader. Installed-only management stays conditional without hiding a
 * current daemon projection or inventing installed metadata for it.
 *
 * Reading order: the machine this page manages, the plugin's identity with its
 * state switch and rare operations, anything blocking it, its settings, where it
 * runs and how it updates, what it adds and reports, and finally the actions
 * that remove it.
 */
function PluginDetailCurrentContent(props: Readonly<{
    pluginId: string;
    presentation: PluginDetailPresentation;
    installed: InstalledPluginEntry | null;
    state: PluginSettingsScreenState;
    projection: PluginProjectionEntry | null;
    accountSettingsDeclaration: PluginPortableReleaseManifestV1 | null;
    accountAvailability: PluginAccountAvailabilityReader | null;
}>) {
    const appProjection = useAppShellPluginUiProjection();
    const { selection } = usePluginSurfaceExecutionOrigin({
        pluginId: props.pluginId, projection: appProjection.pluginUiProjection, enabled: true,
    });
    const { installed, state } = props;
    const accountReleaseVersion = installed?.version ?? props.projection?.version ?? null;
    const capabilities = installed ? projectInstalledPluginLifecycleCapabilities(installed) : null;
    const actionsDisabled = !state.canRefreshInstalledPlugins
        || (installed ? state.isPluginActionInFlight(installed.pluginId) : true);
    const toggleAction = installed?.enabled ? 'disable' : 'enable';
    const canToggle = installed?.enabled ? capabilities?.canDisable === true : capabilities?.canEnable === true;
    const runAction = (action: InstalledPluginActionId) => {
        if (installed) state.runInstalledPluginAction(action, installed.pluginId);
    };
    const menuActions: PageHeaderMenuAction[] = [
        ...(capabilities?.canUpdate ? [{
            id: 'update',
            title: t('common.update'),
            testID: `settings.plugins.detail.${props.pluginId}.action.update`,
            disabled: actionsDisabled,
            onSelect: () => runAction('update'),
        }] : []),
        ...(capabilities?.canRollback ? [{
            id: 'rollback',
            title: t('settingsPlugins.rollback'),
            testID: `settings.plugins.detail.${props.pluginId}.action.rollback`,
            disabled: actionsDisabled,
            onSelect: () => runAction('rollback'),
        }] : []),
    ];
    return (
        <ItemList style={{ paddingTop: 0 }}>
            {/*
              * Two different facts, both true at once: the plugin EXECUTES on the
              * origin chosen under "Run on", while its settings, secrets and
              * lifecycle operations are ADMINISTERED on the machine named here.
              * Beside the Plugins page the page's own chip names that machine.
              */}
            {props.presentation === 'page' ? (
                <MachineAdministrationContextBar
                    label={t('settingsPlugins.administrationMachineTitle')}
                    selection={state.administrationTargetSelection}
                    testIDPrefix="settings.plugins.detail.administration.target"
                />
            ) : null}
            <PluginDetailHeader
                pluginId={props.pluginId}
                installed={installed}
                projection={props.projection}
                machineId={state.executionMachineId}
                serverId={state.executionServerId}
                enabled={installed ? {
                    value: installed.enabled,
                    disabled: !canToggle || actionsDisabled,
                    testID: `settings.plugins.detail.${props.pluginId}.action.${toggleAction}`,
                    onChange: () => runAction(toggleAction),
                } : null}
                menuActions={menuActions}
            />
            {props.presentation === 'page' && state.readOnlySnapshotNotice ? (
                <PluginReadOnlySnapshotNotice
                    testID="settings.plugins.detail.readOnlySnapshot"
                    reason={state.readOnlySnapshotNotice.reason}
                    onRetry={state.refreshPluginTruth}
                />
            ) : null}
            <PluginRoutineOperationSettlementRow
                settlement={state.routineOperationSettlement}
                scope="installed"
            />
            <PluginDetailGenericSettingsSection
                pluginId={props.pluginId}
                projection={props.projection}
                accountSettingsDeclaration={props.accountSettingsDeclaration}
                machineId={state.executionMachineId}
                serverId={state.executionServerId}
                accountServerIdentityId={state.accountServerIdentityId}
                daemonServerIdentityId={state.executionServerIdentityId}
                perActiveServerIdentityId={state.selectedServerIdentityId}
                daemonOperationsAvailable={state.daemonOperationsAvailable}
                isDaemonTargetCurrent={state.isDaemonSettingsTargetCurrent}
            />
            <PluginMachineExecutionOriginSelectorView
                selection={selection}
                machineCandidates={state.administrationTargetSelection.candidates}
                groupTitle={t('settingsPlugins.executionOriginTitle')}
                testIDPrefix="settings.plugins.detail.executionOrigin"
            />
            {installed ? (
                <PluginUpdatePolicySection
                    installed={installed}
                    targetLabel={state.administrationTargetLabel}
                    disabled={
                        !state.daemonOperationsAvailable
                        || state.isPluginActionInFlight(installed.pluginId)
                    }
                    onSelect={(policy) => state.setInstalledPluginUpdatePolicy(
                        installed.pluginId,
                        policy,
                    )}
                />
            ) : null}
            {accountReleaseVersion || props.accountAvailability ? (
                <PluginAccountReleaseSelectionSection
                    pluginId={props.pluginId}
                    version={accountReleaseVersion}
                    reader={props.accountAvailability}
                    projection={state.pluginProjectionV2}
                    daemon={{
                        serverId: state.executionServerId,
                        serverIdentityId: state.executionServerIdentityId,
                        machineId: state.executionMachineId,
                    }}
                    testID={`settings.plugins.detail.${props.pluginId}.accountRelease`}
                />
            ) : null}
            <PluginDetailContributionsSection pluginId={props.pluginId} projection={props.projection} />
            {/*
              * Read-only Account-wide truth for this one plugin: where it is
              * installed and where it is missing or broken. It selects nothing
              * — the machine chip and "Run on" remain the only target authorities.
              */}
            <PluginMachineMatrixSection
                pluginId={props.pluginId}
                includedWithHappier={installed?.source.kind === 'bundled'}
                testIDPrefix="settings.plugins.detail.machineMatrix"
            />
            <PluginDetailInvocationLogsSection
                pluginId={props.pluginId}
                selection={selection}
            />
            <PluginDetailDiagnosticsSection
                pluginId={props.pluginId}
                projection={props.projection}
                registryDiagnostics={state.registryDiagnostics}
                machineId={state.executionMachineId}
            />
            {installed ? (
                <PluginDetailLeaveActions
                    pluginId={installed.pluginId}
                    uninstall={capabilities?.canUninstall ? {
                        disabled: actionsDisabled,
                        onPress: () => runAction('uninstall'),
                    } : null}
                    forgetTrust={capabilities?.canForgetTrust ? {
                        disabled: actionsDisabled,
                        onPress: () => runAction('forgetTrust'),
                    } : null}
                />
            ) : null}
        </ItemList>
    );
}

/** A plugin's own page (`page`), or its detail beside the Plugins page (`pane`). */
export type PluginDetailPresentation = 'page' | 'pane';

export const PluginDetailScreen = React.memo(function PluginDetailScreen(props: Readonly<{
    pluginId: string | null;
}>) {
    const isFocused = useIsFocused();
    // Settings or the app page: a missing plugin falls back to the Plugins home of the same host.
    const host = usePluginsSurfaceHost();
    const state = usePluginSettingsScreenState({ focused: isFocused });
    if (!props.pluginId) {
        return <Redirect href={buildPluginsHomeRoute(host)} />;
    }
    return <PluginDetailView pluginId={props.pluginId} state={state} presentation="page" />;
});

/**
 * One installed plugin's detail, for its own page and for the pane beside the Plugins page: the
 * pane passes the page's screen state, so opening a plugin reads nothing twice.
 */
export const PluginDetailView = React.memo(function PluginDetailView(props: Readonly<{
    pluginId: string;
    state: PluginSettingsScreenState;
    presentation: PluginDetailPresentation;
}>) {
    const host = usePluginsSurfaceHost();
    const { state } = props;
    const pageNoticeActive = usePageNoticeActive();
    const accountAvailability = useActivePluginAccountAvailabilityReader();
    const installed = state.installedPlugins.find(entry => entry.pluginId === props.pluginId) ?? null;
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

    if (!installed && !projection && !accountRecoveryPluginId) {
        if (state.readOnlySnapshotNotice && state.readOnlySnapshotNotice.reason !== 'refreshing') return (
            <ItemList style={{ paddingTop: 0 }}>
                {pageNoticeActive ? <Item
                    testID="settings.plugins.detail.noSnapshot"
                    title={t('settingsPlugins.surfaces.noSavedDetails')}
                    mode="info"
                    showChevron={false}
                /> : <PluginReadOnlySnapshotNotice
                    testID="settings.plugins.detail.readOnlySnapshot"
                    reason={state.readOnlySnapshotNotice.reason}
                    onRetry={state.refreshPluginTruth}
                />}
            </ItemList>
        );
        if (!state.pluginTruthSettled) return <PaneLoadingFallback />;
    }

    if (!installed && !projection && !accountRecoveryPluginId) {
        /*
         * Truth has settled and this plugin is not here — uninstalled, never
         * installed on the selected machine, or removed from the Account. The
         * predecessor redirected to the Plugins home, which silently discarded
         * the deep link the reader followed and left them to work out what had
         * happened. The tombstone keeps the route and the plugin id, names what
         * changed, and offers only what is actually true right now: re-read the
         * selected machine, choose a different one, or go back.
         */
        return (
            <ItemList style={{ paddingTop: 0 }}>
                {props.presentation === 'page' ? (
                    <MachineAdministrationContextBar
                        label={t('settingsPlugins.administrationMachineTitle')}
                        selection={state.administrationTargetSelection}
                        testIDPrefix="settings.plugins.detail.missing.target"
                    />
                ) : null}
                <PluginDetailRecoveryHeader pluginId={props.pluginId} title={headerTitle} />
                <SurfaceStateCard
                    testID={`settings.plugins.detail.${props.pluginId}.missing`}
                    kind="unavailable"
                    title={t('settingsPlugins.detailMissingTitle')}
                    reason={t('settingsPlugins.detailMissingBody', { pluginId: props.pluginId })}
                    action={{
                        label: t('settingsPlugins.detailMissingRetry'),
                        onPress: state.refreshPluginTruth,
                    }}
                />
                {/*
                  * "Is it somewhere else?" is the reader's next question, and
                  * this is the one Account-wide answer. Read-only, as on every
                  * other plugin route.
                  */}
                <PluginMachineMatrixSection
                    pluginId={props.pluginId}
                    testIDPrefix="settings.plugins.detail.machineMatrix"
                />
            </ItemList>
        );
    }

    if (installed || projection) {
        return (
            <PluginDetailCurrentContent
                pluginId={props.pluginId}
                presentation={props.presentation}
                installed={installed}
                state={state}
                projection={projection}
                accountSettingsDeclaration={accountSettingsDeclaration}
                accountAvailability={accountAvailability}
            />
        );
    }

    const recoveryPluginId = accountRecoveryPluginId;
    if (!recoveryPluginId) return <Redirect href={buildPluginsHomeRoute(host)} />;
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
            {/*
              * Account-hosted UI artifacts outlive every machine installation
              * — hosting exists precisely so this release still loads when no
              * daemon offers it. Their status, opt-out, removal and local cache
              * clear therefore stay reachable on this Account-only route; the
              * section hides itself when no hosting fact is current.
              */}
            <PluginAccountReleaseSelectionSection
                pluginId={recoveryPluginId}
                version={null}
                reader={accountAvailability}
                projection={null}
                daemon={{ serverId: null, serverIdentityId: null, machineId: null }}
                testID={`settings.plugins.detail.${recoveryPluginId}.accountRelease`}
            />
            <PluginDetailInvocationLogsUnavailableSection pluginId={recoveryPluginId} />
            <PluginDetailLeaveActions pluginId={recoveryPluginId} />
        </ItemList>
    );
});

export default PluginDetailScreen;
