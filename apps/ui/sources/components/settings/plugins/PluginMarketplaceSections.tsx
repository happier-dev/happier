import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import type { PluginProjectionDiagnostic } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { t } from '@/text';

import { PluginDiagnosticsSection } from './diagnostics/PluginDiagnosticsSection';
import type { PluginMarketplaceCatalog } from './readPluginMarketplaceCatalog';
import {
    formatCatalogEntryVersion,
    formatCatalogSubtitle,
    formatInstalledSubtitle,
    isUpdateAvailable,
    readInstalledPluginCatalogVersion,
    type InstalledPluginEntry,
    type PluginMarketplaceActionRequest,
} from './model/pluginMarketplaceModel';

export function InstalledPluginsSection(props: Readonly<{
    installedPlugins: readonly InstalledPluginEntry[];
    catalog: PluginMarketplaceCatalog | null;
    canRunActions: boolean;
    isPluginActionInFlight: (pluginId: string) => boolean;
    onNavigateToPlugin: (pluginId: string) => void;
    onRunAction: (action: 'reload' | 'update' | 'enable' | 'disable', pluginId: string) => void;
}>) {
    const { theme } = useUnistyles();
    return (
        <ItemGroup title={t('deps.ui.installed')}>
            {props.installedPlugins.length > 0 ? props.installedPlugins.map((entry) => (
                <Item
                    key={entry.pluginId}
                    testID={`settings.plugins.marketplace.installed.${entry.pluginId}`}
                    title={entry.title}
                    subtitle={formatInstalledSubtitle(entry)}
                    detail={entry.version}
                    icon={<Ionicons name="archive-outline" size={29} color={theme.colors.textSecondary} />}
                    onPress={() => props.onNavigateToPlugin(entry.pluginId)}
                    rightElement={(
                        <ItemRowActions
                            title={entry.title}
                            compactActionIds={['reload', entry.enabled ? 'disable' : 'enable']}
                            overflowTriggerTestID={`settings.plugins.marketplace.installed.${entry.pluginId}.actions.overflow`}
                            actions={[
                                {
                                    id: 'reload',
                                    title: t('settingsPlugins.reloadAction'),
                                    subtitle: t('settingsPlugins.reloadSubtitle'),
                                    icon: 'refresh-outline',
                                    inlineTestID: `settings.plugins.marketplace.installed.${entry.pluginId}.action.reload`,
                                    disabled: !props.canRunActions || props.isPluginActionInFlight(entry.pluginId),
                                    onPress: () => props.onRunAction('reload', entry.pluginId),
                                },
                                ...(entry.source.kind === 'catalog' ? [{
                                    id: 'update',
                                    title: t('common.update'),
                                    subtitle: (
                                        readInstalledPluginCatalogVersion(entry, props.catalog)
                                            ? t('deps.ui.installedUpdateAvailable', {
                                                installedVersion: entry.version,
                                                latestVersion: readInstalledPluginCatalogVersion(entry, props.catalog) ?? entry.version,
                                            })
                                            : entry.source.locator
                                    ),
                                    icon: 'cloud-download-outline' as const,
                                    inlineTestID: `settings.plugins.marketplace.installed.${entry.pluginId}.action.update`,
                                    disabled: !props.canRunActions || props.isPluginActionInFlight(entry.pluginId),
                                    onPress: () => props.onRunAction('update', entry.pluginId),
                                }] : []),
                                {
                                    id: entry.enabled ? 'disable' : 'enable',
                                    title: entry.enabled ? t('common.disable') : t('common.enable'),
                                    subtitle: entry.enabled ? t('common.enabled') : t('common.disabled'),
                                    icon: entry.enabled ? 'close-circle-outline' : 'checkmark-circle-outline',
                                    inlineTestID: `settings.plugins.marketplace.installed.${entry.pluginId}.action.${entry.enabled ? 'disable' : 'enable'}`,
                                    disabled: !props.canRunActions || props.isPluginActionInFlight(entry.pluginId),
                                    onPress: () => props.onRunAction(entry.enabled ? 'disable' : 'enable', entry.pluginId),
                                },
                            ]}
                        />
                    )}
                />
            )) : (
                <Item
                    testID="settings.plugins.marketplace.installed.empty"
                    title={t('deps.ui.notInstalled')}
                    subtitle={t('settingsPlugins.emptySubtitle')}
                    icon={<Ionicons name="archive-outline" size={29} color={theme.colors.textSecondary} />}
                    showChevron={false}
                    mode="info"
                />
            )}
        </ItemGroup>
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

export function CatalogEntriesSection(props: Readonly<{
    catalog: PluginMarketplaceCatalog | null;
    loadingCatalog: boolean;
    resolvedCatalogUrl: string;
    loadedCatalogTitle: string;
    loadedCatalogFooter: string;
    installedPluginById: ReadonlyMap<string, InstalledPluginEntry>;
    canRefreshInstalledPlugins: boolean;
    isPluginActionInFlight: (pluginId: string) => boolean;
    onAction: (request: PluginMarketplaceActionRequest) => void;
}>) {
    const { theme } = useUnistyles();

    const renderCatalogEntryActionRows = (catalogEntry: PluginMarketplaceCatalog['entries'][number]) => {
        const installed = props.installedPluginById.get(catalogEntry.id) ?? null;

        if (!installed) {
            return (
                <Item
                    testID={`settings.plugins.marketplace.action.install.${catalogEntry.id}`}
                    title={t('common.install')}
                    subtitle={catalogEntry.description ?? t('deps.ui.notInstalled')}
                    icon={<Ionicons name="download-outline" size={29} color={theme.colors.textSecondary} />}
                    onPress={() => props.onAction({
                        method: 'install',
                        pluginId: catalogEntry.id,
                        sourceUrl: props.resolvedCatalogUrl,
                    })}
                    disabled={!props.canRefreshInstalledPlugins || props.isPluginActionInFlight(catalogEntry.id) || props.loadingCatalog}
                    showChevron={false}
                />
            );
        }

        const actionRows: React.ReactNode[] = [];
        if (isUpdateAvailable(installed, props.catalog)) {
            actionRows.push(
                <Item
                    key="update"
                    testID={`settings.plugins.marketplace.action.update.${catalogEntry.id}`}
                    title={t('common.update')}
                    subtitle={catalogEntry.description ?? t('deps.ui.installed')}
                    icon={<Ionicons name="refresh-outline" size={29} color={theme.colors.textSecondary} />}
                    onPress={() => props.onAction({
                        method: 'update',
                        pluginId: catalogEntry.id,
                        sourceUrl: props.resolvedCatalogUrl,
                    })}
                    disabled={!props.canRefreshInstalledPlugins || props.isPluginActionInFlight(catalogEntry.id) || props.loadingCatalog}
                    showChevron={false}
                />,
            );
        }

        actionRows.push(
            <Item
                key={installed.enabled ? 'disable' : 'enable'}
                testID={`settings.plugins.marketplace.action.${installed.enabled ? 'disable' : 'enable'}.${catalogEntry.id}`}
                title={installed.enabled ? t('common.disable') : t('common.enable')}
                subtitle={installed.enabled ? t('common.enabled') : t('common.disabled')}
                icon={<Ionicons name={installed.enabled ? 'close-circle-outline' : 'checkmark-circle-outline'} size={29} color={theme.colors.textSecondary} />}
                onPress={() => props.onAction({
                    method: installed.enabled ? 'disable' : 'enable',
                    pluginId: catalogEntry.id,
                })}
                disabled={!props.canRefreshInstalledPlugins || props.isPluginActionInFlight(catalogEntry.id) || props.loadingCatalog}
                showChevron={false}
            />,
        );

        return actionRows;
    };

    return (
        <ItemGroup title={props.loadedCatalogTitle} footer={props.loadedCatalogFooter}>
            {props.loadingCatalog ? (
                <Item
                    testID="settings.plugins.marketplace.catalog.loading"
                    title={t('common.loading')}
                    subtitle={props.resolvedCatalogUrl || t('settingsPlugins.emptySubtitle')}
                    icon={<Ionicons name="refresh-outline" size={29} color={theme.colors.textSecondary} />}
                    showChevron={false}
                />
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
                                icon={<Ionicons name="albums-outline" size={29} color={theme.colors.textSecondary} />}
                                showChevron={false}
                                mode="info"
                            />
                            {renderCatalogEntryActionRows(entry)}
                        </React.Fragment>
                    );
                }) : (
                    <Item
                        testID="settings.plugins.marketplace.catalog.empty"
                        title={t('settingsPlugins.emptySubtitle')}
                        subtitle={props.catalog.description ?? props.catalog.sourceUrl ?? null}
                        icon={<Ionicons name="albums-outline" size={29} color={theme.colors.textSecondary} />}
                        showChevron={false}
                        mode="info"
                    />
                )
            ) : !props.loadingCatalog ? (
                <Item
                    testID="settings.plugins.marketplace.catalog.unavailable"
                    title={t('common.unavailable')}
                    subtitle={props.resolvedCatalogUrl || t('settingsPlugins.emptySubtitle')}
                    icon={<Ionicons name="albums-outline" size={29} color={theme.colors.textSecondary} />}
                    showChevron={false}
                    mode="info"
                />
            ) : null}
        </ItemGroup>
    );
}
