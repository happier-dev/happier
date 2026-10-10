import * as React from 'react';
import { View } from 'react-native';
import { useGlobalSearchParams, usePathname, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { destinationRowTestId, useColumnDestinations } from '@/components/appShell/destinations/ColumnDestinationRows';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon } from '@/components/ui/icons/Icon';
import {
    CollectionList,
    CollectionNavigationRow,
} from '@/components/ui/lists/collection/CollectionList';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { t } from '@/text';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';

import {
    createPluginSettingsViews,
    readInstalledPlugins,
} from './model/pluginMarketplaceModel';
import { listPluginsDeveloperLinks } from './model/pluginsDeveloperLinks';
import { usePluginsAdministrationTarget } from './model/usePluginsAdministrationTarget';
import { buildPluginsHomeRoute, PLUGINS_APP_ROUTE } from './model/pluginsSurfaceRoutes';

type NavigationHref = Parameters<ReturnType<typeof useRouter>['replace']>[0];

/**
 * Installed and Browse drive the page's single Collection; the column owns destination
 * navigation, not a second inventory, search, selection or contribution-projection read.
 */
export const PluginsNavigationColumn = React.memo(function PluginsNavigationColumn() {
    const styles = stylesheet;
    const router = useRouter();
    const pathname = usePathname().replace(/\/+$/, '');
    const { view } = useGlobalSearchParams<{ view?: string }>();
    const target = usePluginsAdministrationTarget();
    const installedPlugins = readInstalledPlugins(target.machineCapabilities.state);
    // The count is the machine's answer (or its last-known snapshot); never a "0" while it is asked.
    const countKnown = installedPlugins.length > 0 || target.machineCapabilities.state.status === 'loaded';
    const views = createPluginSettingsViews(t);
    // Entries other destinations placed in this column, under its header (design §3.1).
    const placed = useColumnDestinations('plugins');
    const onHome = pathname === PLUGINS_APP_ROUTE;
    const openView = React.useCallback((next: 'installed' | 'browse') => {
        const result = runGuardedNavigation(() => router.replace(buildPluginsHomeRoute('app', { view: next }) as NavigationHref));
        if (result !== true) fireAndForget(result, { tag: 'PluginsNavigationColumn.openView' });
    }, [router]);

    return (
        <View testID="plugins-column" style={styles.column}>
            <CollectionList
                testID="plugins-column:list"
                surface="plane"
                title={t('settingsPlugins.surfaces.navigationTitle')}
            >
                {placed.destinations.map((destination) => (
                    <CollectionNavigationRow
                        key={destination.id}
                        href={destination.activation === 'navigate' ? destination.routePath : null}
                        testID={destinationRowTestId(destination)}
                        title={destination.title}
                        icon={<Icon name={destination.icon} />}
                        selected={destination.id === placed.currentId}
                        // An unavailable page still opens: its route says why.
                        onPress={() => placed.activate(destination)}
                    />
                ))}
                {views.map((entry) => {
                    const browse = entry.id === 'discover';
                    return (
                        <CollectionNavigationRow
                            key={entry.id}
                            href={buildPluginsHomeRoute('app', { view: browse ? 'browse' : 'installed' })}
                            testID={`plugins-column:${entry.id}`}
                            title={entry.label}
                            icon={<Icon name={browse ? 'globe' : 'check'} />}
                            detail={browse || !countKnown ? undefined : String(installedPlugins.length)}
                            selected={onHome && (browse ? view === 'browse' : view !== 'browse')}
                            onPress={() => openView(browse ? 'browse' : 'installed')}
                        />
                    );
                })}
            </CollectionList>
            <PluginsDeveloperMenu />
        </View>
    );
});

/** "For developers", pinned at the column's foot: the developer pages in a menu. */
const PluginsDeveloperMenu = React.memo(function PluginsDeveloperMenu() {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const router = useRouter();
    const [open, setOpen] = React.useState(false);
    const webhooksAvailable = useFeatureEnabled('plugins.webhooks');
    const links = listPluginsDeveloperLinks({ webhooksAvailable });
    const items = links.map((link): DropdownMenuItem => ({ id: link.testID, testID: `plugins-column:developer:${link.testID}`, title: t(link.setting.titleKey) }));
    return (
        <View style={styles.foot}>
            <DropdownMenu
                testID="plugins-column:developers"
                open={open}
                onOpenChange={setOpen}
                items={items}
                onSelect={(id) => {
                    setOpen(false);
                    const link = links.find((candidate) => candidate.testID === id);
                    if (!link) return;
                    const result = runGuardedNavigation(() => router.push(link.route as never));
                    if (result !== true) fireAndForget(result, { tag: 'PluginsNavigationColumn.developers' });
                }}
                placement="top"
                variant="slim"
                matchTriggerWidth={false}
                popoverPortalWebTarget="body"
                trigger={({ toggle }) => (
                    <CollectionNavigationRow
                        testID="plugins-column:developers.trigger"
                        title={t('settingsPlugins.surfaces.forDevelopers')}
                        icon={<Icon name="wrench" color={theme.colors.text.secondary} />}
                        selected={false}
                        onPress={toggle}
                    />
                )}
            />
        </View>
    );
});

const stylesheet = StyleSheet.create(() => ({
    column: {
        flex: 1,
        minHeight: 0,
    },
    foot: {
        paddingBottom: 8,
    },
}));
