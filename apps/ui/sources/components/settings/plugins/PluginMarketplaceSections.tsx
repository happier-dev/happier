import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import type { PluginProjectionDiagnostic } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

import { PluginDiagnosticsSection } from './diagnostics/PluginDiagnosticsSection';
import type { PluginMarketplaceCatalog } from './readPluginMarketplaceCatalog';
import { Icon } from '@/components/ui/icons/Icon';
import {
    formatCatalogEntryVersion,
    formatCatalogSubtitle,
    formatDevelopmentPluginSubtitle,
    formatInstalledSubtitle,
    formatPendingPluginChangeSubtitle,
    formatPendingPluginChangeTitle,
    projectInstalledPluginLifecycleCapabilities,
    readPendingPluginChangeListingId,
    type DevelopmentPluginEntry,
    type InstalledPluginEntry,
    type PendingPluginChangeListing,
    type PluginMarketplaceActionRequest,
} from './model/pluginMarketplaceModel';

export function InstalledPluginsSection(props: Readonly<{
    installedPlugins: readonly InstalledPluginEntry[];
    catalog: PluginMarketplaceCatalog | null;
    canRunActions: boolean;
    isPluginActionInFlight: (pluginId: string) => boolean;
    onNavigateToPlugin: (pluginId: string) => void;
    onRunAction: (action: 'enable' | 'disable', pluginId: string) => void;
}>) {
    const { theme } = useUnistyles();
    return (
        <ItemGroup title={t('deps.ui.installed')}>
            {props.installedPlugins.length > 0 ? props.installedPlugins.map((entry) => {
                const capabilities = projectInstalledPluginLifecycleCapabilities(entry);
                const toggleAction = entry.enabled ? 'disable' : 'enable';
                const canToggle = entry.enabled ? capabilities.canDisable : capabilities.canEnable;
                return (
                    <Item
                        key={entry.pluginId}
                        testID={`settings.plugins.marketplace.installed.${entry.pluginId}`}
                        title={entry.title}
                        subtitle={formatInstalledSubtitle(entry)}
                        detail={entry.version}
                        icon={<Icon name="archive" size={29} color={theme.colors.text.secondary} />}
                        onPress={() => props.onNavigateToPlugin(entry.pluginId)}
                        rightElementOutsidePressable={canToggle}
                        rightElement={canToggle ? (
                            <ItemRowActions
                                title={entry.title}
                                compactActionIds={[toggleAction]}
                                overflowTriggerTestID={`settings.plugins.marketplace.installed.${entry.pluginId}.actions.overflow`}
                                actions={[
                                    {
                                        id: toggleAction,
                                        title: entry.enabled ? t('common.disable') : t('common.enable'),
                                        subtitle: entry.enabled ? t('common.enabled') : t('common.disabled'),
                                        icon: entry.enabled ? 'x-circle' : 'check-circle',
                                        inlineTestID: `settings.plugins.marketplace.installed.${entry.pluginId}.action.${toggleAction}`,
                                        disabled: !props.canRunActions || props.isPluginActionInFlight(entry.pluginId),
                                        onPress: () => props.onRunAction(toggleAction, entry.pluginId),
                                    },
                                ]}
                            />
                        ) : null}
                    />
                );
            }) : (
                <Item
                    testID="settings.plugins.marketplace.installed.empty"
                    title={t('deps.ui.notInstalled')}
                    subtitle={t('settingsPlugins.emptySubtitle')}
                    icon={<Icon name="archive" size={29} color={theme.colors.text.secondary} />}
                    showChevron={false}
                    mode="info"
                />
            )}
        </ItemGroup>
    );
}

/**
 * The decisions this machine's daemon is holding for the present user.
 *
 * This is the app half of the agent-authored plugin loop: an Agent can prepare
 * a plugin change but cannot approve source-root or package trust, so without
 * this section its change is invisible and expires unanswered. The section is
 * rendered only when something is actually waiting, so it reads as attention
 * rather than as permanent furniture.
 */
export function PendingPluginChangesSection(props: Readonly<{
    pendingChanges: readonly PendingPluginChangeListing[];
    canRunActions: boolean;
    isPluginActionInFlight: (pendingChangeId: string) => boolean;
    onDecide: (pendingChangeId: string, decision: 'approve' | 'reject') => void;
}>) {
    const { theme } = useUnistyles();
    if (props.pendingChanges.length === 0) return null;
    return (
        <View
            testID="settings.plugins.management.pendingChanges"
            accessibilityLiveRegion="polite"
        >
            <ItemGroup
                title={t('settingsPlugins.pendingChangesTitle')}
                footer={t('settingsPlugins.pendingChangesFooter')}
            >
                {props.pendingChanges.map((entry) => {
                    const pendingChangeId = readPendingPluginChangeListingId(entry);
                    const busy = props.isPluginActionInFlight(pendingChangeId);
                    const decidable = entry.kind !== 'applying';
                    return (
                        <Item
                            key={pendingChangeId}
                            testID={`settings.plugins.management.pendingChanges.${pendingChangeId}`}
                            title={formatPendingPluginChangeTitle(entry)}
                            subtitle={formatPendingPluginChangeSubtitle(entry)}
                            subtitleLines={0}
                            icon={<Icon
                                name={decidable ? 'shield-check' : 'arrow-clockwise'}
                                size={29}
                                color={decidable ? theme.colors.accent.indigo : theme.colors.text.secondary}
                            />}
                            showChevron={false}
                            mode="info"
                            rightElementOutsidePressable
                            rightElement={decidable ? (
                                <ItemRowActions
                                    title={formatPendingPluginChangeTitle(entry)}
                                    compactActionIds={['approve', 'reject']}
                                    overflowTriggerTestID={`settings.plugins.management.pendingChanges.${pendingChangeId}.actions.overflow`}
                                    actions={[
                                        {
                                            id: 'approve',
                                            title: t('approvals.approve'),
                                            subtitle: t('settingsPlugins.pendingChangesReviewHint'),
                                            icon: 'check-circle',
                                            inlineTestID: `settings.plugins.management.pendingChanges.${pendingChangeId}.action.approve`,
                                            disabled: !props.canRunActions || busy,
                                            onPress: () => props.onDecide(pendingChangeId, 'approve'),
                                        },
                                        {
                                            id: 'reject',
                                            title: t('approvals.reject'),
                                            subtitle: t('settingsPlugins.pendingChangeConfirmRejectBody'),
                                            icon: 'x-circle',
                                            destructive: true,
                                            inlineTestID: `settings.plugins.management.pendingChanges.${pendingChangeId}.action.reject`,
                                            disabled: !props.canRunActions || busy,
                                            onPress: () => props.onDecide(pendingChangeId, 'reject'),
                                        },
                                    ]}
                                />
                            ) : undefined}
                        />
                    );
                })}
            </ItemGroup>
        </View>
    );
}

export function RegistryDiagnosticsSection(props: Readonly<{
    diagnostics: readonly PluginProjectionDiagnostic[];
}>) {
    return (
        <PluginDiagnosticsSection
            title={t('settingsPlugins.registryDiagnosticsTitle')}
            diagnostics={props.diagnostics}
            testIDPrefix="settings.plugins.registryDiagnostic"
        />
    );
}

export function DevelopmentPluginsSection(props: Readonly<{
    developmentPlugins: readonly DevelopmentPluginEntry[];
    createAvailable: boolean;
    sourceInstallAvailable: boolean;
    canRunActions: boolean;
    isPluginActionInFlight: (pluginId: string) => boolean;
    onCreate: () => void;
    onDevelopSourceRoot: () => void;
    onRunAction: (action: 'test' | 'pack', pluginId: string) => void;
}>) {
    const { theme } = useUnistyles();
    return (
        <ItemGroup title={t('settingsPlugins.developmentTitle')} footer={t('settingsPlugins.developmentFooter')}>
            <Item
                testID="settings.plugins.management.development.action.create"
                title={t('settingsPlugins.developmentCreate')}
                subtitle={t('settingsPlugins.developmentCreateSubtitle')}
                icon={<Icon name="plus-circle" size={29} color={theme.colors.text.secondary} />}
                onPress={props.onCreate}
                disabled={!props.canRunActions || !props.createAvailable}
                showChevron={false}
            />
            <Item
                testID="settings.plugins.management.development.action.develop"
                title={t('settingsPlugins.developmentSourceInstall')}
                subtitle={t('settingsPlugins.developmentSourceInstallSubtitle')}
                subtitleLines={0}
                icon={<Icon name="folder" size={29} color={theme.colors.text.secondary} />}
                onPress={props.onDevelopSourceRoot}
                disabled={!props.canRunActions || !props.sourceInstallAvailable}
                showChevron={false}
            />
            {props.developmentPlugins.length > 0 ? props.developmentPlugins.map((entry) => (
                <React.Fragment key={entry.installed.pluginId}>
                    <Item
                        testID={`settings.plugins.management.development.${entry.installed.pluginId}`}
                        title={entry.installed.title}
                        subtitle={(
                            <Text
                                testID={`settings.plugins.management.development.${entry.installed.pluginId}.details`}
                                selectable
                            >
                                {formatDevelopmentPluginSubtitle(entry)}
                                {' | '}
                                {t('settingsPlugins.developmentWatchConfigured')}
                                {' | '}
                                {entry.reload.state === 'clear'
                                    ? t('settingsPlugins.developmentReloadClear')
                                    : t('settingsPlugins.developmentReloadAttention')}
                            </Text>
                        )}
                        detail={entry.installed.version}
                        icon={<Icon name="code" size={29} color={theme.colors.text.secondary} />}
                        showChevron={false}
                        mode="info"
                    />
                    <Item
                        testID={`settings.plugins.management.development.${entry.installed.pluginId}.action.test`}
                        title={t('settingsPlugins.developmentTest')}
                        subtitle={t('settingsPlugins.developmentTestSubtitle')}
                        icon={<Icon name="checks" size={29} color={theme.colors.text.secondary} />}
                        onPress={() => props.onRunAction('test', entry.installed.pluginId)}
                        disabled={!props.canRunActions || !entry.actions.test || props.isPluginActionInFlight(entry.installed.pluginId)}
                        showChevron={false}
                    />
                    <Item
                        testID={`settings.plugins.management.development.${entry.installed.pluginId}.action.pack`}
                        title={t('settingsPlugins.developmentPack')}
                        subtitle={t('settingsPlugins.developmentPackSubtitle')}
                        icon={<Icon name="cube" size={29} color={theme.colors.text.secondary} />}
                        onPress={() => props.onRunAction('pack', entry.installed.pluginId)}
                        disabled={!props.canRunActions || !entry.actions.pack || props.isPluginActionInFlight(entry.installed.pluginId)}
                        showChevron={false}
                    />
                </React.Fragment>
            )) : (
                <Item
                    testID="settings.plugins.management.development.empty"
                    title={t('settingsPlugins.developmentEmpty')}
                    subtitle={t('settingsPlugins.developmentEmptySubtitle')}
                    icon={<Icon name="code" size={29} color={theme.colors.text.secondary} />}
                    showChevron={false}
                    mode="info"
                />
            )}
        </ItemGroup>
    );
}

export function PluginDiagnosticsSnapshotSection(props: Readonly<{
    diagnostics: readonly PluginProjectionDiagnostic[];
}>) {
    const { theme } = useUnistyles();
    return (
        <View
            testID="settings.plugins.management.diagnostics.live"
            accessibilityLiveRegion="polite"
        >
            {props.diagnostics.length > 0 ? (
                <RegistryDiagnosticsSection diagnostics={props.diagnostics} />
            ) : (
                <ItemGroup title={t('settingsPlugins.diagnosticsSnapshotTitle')} footer={t('settingsPlugins.diagnosticsSnapshotFooter')}>
                    <Item
                        testID="settings.plugins.management.diagnostics.empty"
                        title={t('settingsPlugins.diagnosticsSnapshotEmpty')}
                        subtitle={t('settingsPlugins.diagnosticsSnapshotEmptySubtitle')}
                        icon={<Icon name="pulse" size={29} color={theme.colors.text.secondary} />}
                        showChevron={false}
                        mode="info"
                    />
                </ItemGroup>
            )}
        </View>
    );
}

export function CatalogEntriesSection(props: Readonly<{
    catalog: PluginMarketplaceCatalog | null;
    loadingCatalog: boolean;
    resolvedCatalogUrl: string;
    loadedCatalogTitle: string;
    loadedCatalogFooter: string;
    installedPluginById: ReadonlyMap<string, InstalledPluginEntry>;
    canRunCatalogActions: boolean;
    isPluginActionInFlight: (pluginId: string) => boolean;
    onAction: (request: PluginMarketplaceActionRequest) => void;
}>) {
    const { theme } = useUnistyles();

    const renderCatalogEntryActionRows = (catalogEntry: PluginMarketplaceCatalog['entries'][number]) => {
        const installed = props.installedPluginById.get(catalogEntry.id) ?? null;

        if (!installed) {
            if (!catalogEntry.installable) return null;
            return (
                <Item
                    testID={`settings.plugins.marketplace.action.install.${catalogEntry.id}`}
                    title={t('settingsPlugins.installAndTrust')}
                    subtitle={catalogEntry.description ?? t('deps.ui.notInstalled')}
                    icon={<Icon name="download" size={29} color={theme.colors.text.secondary} />}
                    onPress={() => props.onAction({
                        method: 'install',
                        pluginId: catalogEntry.id,
                        sourceId: catalogEntry.sourceId,
                    })}
                    disabled={!catalogEntry.installable || !props.canRunCatalogActions || props.isPluginActionInFlight(catalogEntry.id) || props.loadingCatalog}
                    showChevron={false}
                />
            );
        }

        // The listing is how the user learns a newer version exists. What
        // "update" then does belongs to the installed record at its canonical
        // owner, so no catalog source travels with the request.
        const updateAvailable = catalogEntry.updateable
            && catalogEntry.version !== null
            && catalogEntry.version !== installed.version;
        const actionRows: React.ReactNode[] = [
            ...(updateAvailable ? [
                <Item
                    key="update"
                    testID={`settings.plugins.marketplace.action.update.${catalogEntry.id}`}
                    title={t('common.update')}
                    subtitle={t('settingsPlugins.marketplaceUpdateVersion', {
                        installedVersion: installed.version,
                        availableVersion: catalogEntry.version,
                    })}
                    icon={<Icon name="arrow-circle-up" size={29} color={theme.colors.text.secondary} />}
                    onPress={() => props.onAction({
                        method: 'update',
                        pluginId: catalogEntry.id,
                    })}
                    disabled={!props.canRunCatalogActions || props.isPluginActionInFlight(catalogEntry.id) || props.loadingCatalog}
                    showChevron={false}
                />,
            ] : []),
            <Item
                key={installed.enabled ? 'disable' : 'enable'}
                testID={`settings.plugins.marketplace.action.${installed.enabled ? 'disable' : 'enable'}.${catalogEntry.id}`}
                title={installed.enabled ? t('common.disable') : t('common.enable')}
                subtitle={installed.enabled ? t('common.enabled') : t('common.disabled')}
                icon={<Icon name={installed.enabled ? 'x-circle' : 'check-circle'} size={29} color={theme.colors.text.secondary} />}
                onPress={() => props.onAction({
                    method: installed.enabled ? 'disable' : 'enable',
                    pluginId: catalogEntry.id,
                })}
                disabled={!props.canRunCatalogActions || props.isPluginActionInFlight(catalogEntry.id) || props.loadingCatalog}
                showChevron={false}
            />,
        ];

        return actionRows;
    };

    return (
        <ItemGroup title={props.loadedCatalogTitle} footer={props.loadedCatalogFooter}>
            {props.loadingCatalog ? (
                <View
                    testID="settings.plugins.marketplace.catalog.loading.status"
                    accessible
                    accessibilityLiveRegion="polite"
                    accessibilityLabel={t('common.loading')}
                >
                    <Item
                        testID="settings.plugins.marketplace.catalog.loading"
                        title={t('common.loading')}
                        subtitle={props.resolvedCatalogUrl || t('settingsPlugins.emptySubtitle')}
                        icon={<Icon name="arrow-clockwise" size={29} color={theme.colors.text.secondary} />}
                        showChevron={false}
                    />
                </View>
            ) : null}
            {props.catalog ? (
                props.catalog.entries.length > 0 ? props.catalog.entries.map((entry) => {
                    const installed = props.installedPluginById.get(entry.id) ?? null;
                    return (
                        <React.Fragment key={entry.id}>
                            <Item
                                testID={`settings.plugins.marketplace.entry.${entry.id}`}
                                title={entry.title}
                                subtitle={formatCatalogSubtitle({ catalog: props.catalog as PluginMarketplaceCatalog, installed })}
                                detail={formatCatalogEntryVersion(entry.version)}
                                icon={<Icon name="stack" size={29} color={theme.colors.text.secondary} />}
                                showChevron={false}
                                mode="info"
                            />
                            {entry.warning === 'withdrawn' ? (
                                <View accessibilityLiveRegion="assertive">
                                    <Item
                                        testID={`settings.plugins.marketplace.warning.${entry.id}`}
                                        title={t('settingsPlugins.marketplaceWithdrawnTitle')}
                                        subtitle={installed
                                            ? t('settingsPlugins.marketplaceWithdrawnInstalledBody')
                                            : t('settingsPlugins.marketplaceWithdrawnBody')}
                                        subtitleLines={0}
                                        icon={<Icon name="warning" size={29} color={theme.colors.state.warning.foreground} />}
                                        showChevron={false}
                                        mode="info"
                                    />
                                </View>
                            ) : null}
                            {entry.sourceKind === 'community-npm' && entry.reviewStatus === 'unreviewed' ? (
                                <View accessibilityLiveRegion="polite">
                                    <Item
                                        testID={`settings.plugins.marketplace.unreviewed.${entry.id}`}
                                        title={t('settingsPlugins.marketplaceCommunityUnreviewedTitle')}
                                        subtitle={t('settingsPlugins.marketplaceCommunityUnreviewedBody')}
                                        subtitleLines={0}
                                        icon={<Icon name="shield" size={29} color={theme.colors.state.warning.foreground} />}
                                        showChevron={false}
                                        mode="info"
                                    />
                                </View>
                            ) : null}
                            {renderCatalogEntryActionRows(entry)}
                        </React.Fragment>
                    );
                }) : (
                    <Item
                        testID="settings.plugins.marketplace.catalog.empty"
                        title={t('settingsPlugins.emptySubtitle')}
                        subtitle={props.catalog.description ?? props.catalog.sourceUrl ?? null}
                        icon={<Icon name="stack" size={29} color={theme.colors.text.secondary} />}
                        showChevron={false}
                        mode="info"
                    />
                )
            ) : !props.loadingCatalog ? (
                <Item
                    testID="settings.plugins.marketplace.catalog.unavailable"
                    title={t('common.unavailable')}
                    subtitle={props.resolvedCatalogUrl || t('settingsPlugins.emptySubtitle')}
                    icon={<Icon name="stack" size={29} color={theme.colors.text.secondary} />}
                    showChevron={false}
                    mode="info"
                />
            ) : null}
        </ItemGroup>
    );
}
