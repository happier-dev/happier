import * as React from 'react';
import { View } from 'react-native';
import { usePathname, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useDestinationGlobalParamsSelector } from '@/components/appShell/workspace/DestinationInstanceHost';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { destinationRowTestId, useColumnDestinationEntries } from '@/components/appShell/destinations/ColumnDestinationRows';
import { useActivateAppDestination, type ActivateAppDestination } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import { PluginAppPagesMenu } from '@/components/appShell/destinations/PluginAppPagesMenu';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import {
    CollectionList,
    CollectionListGroupLabel,
    CollectionNavigationRow,
} from '@/components/ui/lists/collection/CollectionList';
import { STORE_KIND_ORDER } from '@/components/store/catalog/storeKinds';
import { STORE_KIND_GLYPHS } from '@/components/store/catalog/StoreItemMark';
import { useStoreUpdatesCount } from '@/components/store/updates/storeUpdatesSummary';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { t } from '@/text';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { listPluginsDeveloperLinks } from './model/pluginsDeveloperLinks';
import { buildPluginsHomeRoute, PLUGINS_APP_ROUTE } from './model/pluginsSurfaceRoutes';
import { useStoreMachineScope } from './model/useStoreMachineScope';
import type { QualifiedMachineV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { useStoreProjectScope } from './model/useStoreProjectScope';
import type { QualifiedProjectKeyV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';

type NavigationHref = Parameters<ReturnType<typeof useRouter>['replace']>[0];

const STORE_KINDS = STORE_KIND_ORDER;
type ComposedKind = typeof STORE_KINDS[number];
type StoreColumnView = 'discover' | 'installed' | 'updates' | ComposedKind;

function storeKindTitle(kind: ComposedKind): string {
    switch (kind) {
        case 'app': return t('capabilities.store.kinds.app.title');
        case 'browserExtension': return t('capabilities.store.kinds.browserExtension.title');
        case 'software': return t('capabilities.store.kinds.software.title');
        case 'mcpServer': return t('capabilities.store.kinds.mcpServer.title');
        case 'skill': return t('capabilities.store.kinds.skill.title');
        case 'agent': return t('capabilities.store.kinds.agent.title');
        case 'provider': return t('capabilities.store.kinds.provider.title');
        case 'plugin': return t('capabilities.store.kinds.plugin.title');
        case 'starter': return t('capabilities.store.kinds.starter.title');
    }
}

/** The Store page a column row opens. The Plugins kind keeps the existing Plugins browse page. */
function storeColumnRoute(entry: StoreColumnView, project: QualifiedProjectKeyV1 | null, machine: QualifiedMachineV1 | null) {
    if (entry === 'discover') return buildPluginsHomeRoute('app', { view: 'discover', project, machine });
    if (entry === 'installed') return buildPluginsHomeRoute('app', { view: 'installed', project, machine });
    if (entry === 'updates') return buildPluginsHomeRoute('app', { view: 'updates', project, machine });
    if (entry === 'plugin') return buildPluginsHomeRoute('app', { view: 'browse', project, machine });
    return buildPluginsHomeRoute('app', { view: 'kind', kind: entry, project, machine });
}

/** Which column row the current Store page belongs to: Discover owns its jobs, categories and search. */
function currentStoreColumnView(params: Readonly<{ view?: string; kind?: string; plugin?: string }>): StoreColumnView | null {
    switch (params.view) {
        case 'installed': return 'installed';
        case 'updates': return 'updates';
        case 'browse': return 'plugin';
        case 'kind': return STORE_KINDS.find(kind => kind === params.kind) ?? null;
        case 'discover': case 'jobs': case 'job': case 'category': case 'search': return 'discover';
        case undefined: return params.plugin === undefined ? 'discover' : 'plugin';
        default: return null;
    }
}

const selectStoreColumnParams = (params: Readonly<Record<string, string | string[] | undefined>>) => ({
    view: typeof params.view === 'string' ? params.view : undefined,
    kind: typeof params.kind === 'string' ? params.kind : undefined,
    plugin: typeof params.plugin === 'string' ? params.plugin : undefined,
});

/**
 * The Store column (S10 "The Store page"): Discover and Installed, then the kinds it browses, then the pages
 * plugins placed here, with Sources and developers at its foot. Each row is a destination; the column holds no
 * inventory, search, selection or contribution-projection read of its own.
 */
export const PluginsNavigationColumn = React.memo(function PluginsNavigationColumn() {
    const pathname = usePathname().replace(/\/+$/, '');
    // A Store search rewrites `q` per keystroke; the column reads only the view facts it selects.
    const params = useDestinationGlobalParamsSelector(selectStoreColumnParams);
    const { project } = useStoreProjectScope();
    const machine = useStoreMachineScope();
    // Typing in a Store search rewrites the route's `q`; the rows below depend on this one fact, not on the params.
    const current = pathname === PLUGINS_APP_ROUTE ? currentStoreColumnView(params) : null;
    // Route readers live here, where the params already re-render: the router and the destination activation owner
    // read the route context, so the memoized rows receive invocation-time callbacks that keep their identity.
    const router = useRouter();
    const latestRouter = React.useRef(router);
    latestRouter.current = router;
    const open = React.useCallback((entry: StoreColumnView) => {
        const result = runGuardedNavigation(() => latestRouter.current.replace(storeColumnRoute(entry, project, machine) as NavigationHref));
        if (result !== true) fireAndForget(result, { tag: 'PluginsNavigationColumn.open' });
    }, [project, machine]);
    const activate = useActivateAppDestination();
    return <StoreColumnBody current={current} project={project} machine={machine} open={open} activate={activate} />;
});

const StoreColumnBody = React.memo(function StoreColumnBody(props: Readonly<{
    current: StoreColumnView | null;
    project: QualifiedProjectKeyV1 | null;
    machine: QualifiedMachineV1 | null;
    open: (entry: StoreColumnView) => void;
    activate: ActivateAppDestination;
}>) {
    const styles = stylesheet;
    const { current, project, machine, open, activate } = props;
    // Entries other destinations placed in this column, under its header (design §3.1).
    const placed = useColumnDestinationEntries('plugins');
    // The last complete Updates check, only once there is one; unknown (null) and nothing waiting (0) draw no badge.
    const waiting = useStoreUpdatesCount(useAccountSettingsScope());
    const row = (entry: StoreColumnView, title: string, icon: IconName, count?: number | null) => (
        <CollectionNavigationRow
            rowRole="item"
            key={entry}
            href={storeColumnRoute(entry, project, machine)}
            testID={`plugins-column:${entry}`}
            title={title}
            icon={<Icon name={icon} />}
            selected={current === entry}
            count={count || null}
            onPress={() => open(entry)}
        />
    );

    return (
        <View testID="plugins-column" style={styles.column}>
            <CollectionList
                testID="plugins-column:list"
                surface="plane"
                title={t('settingsPlugins.surfaces.storeTitle')}
            >
                {row('discover', t('capabilities.store.discover.title'), 'globe')}
                {row('installed', t('settingsPlugins.surfaces.installed'), 'check')}
                {row('updates', t('capabilities.store.updates.title'), 'arrow-up', waiting)}
                <CollectionListGroupLabel testID="plugins-column:group:browse" title={t('capabilities.store.discover.browseGroup')} />
                {STORE_KINDS.map(kind => row(kind, storeKindTitle(kind), STORE_KIND_GLYPHS[kind]))}
                {placed.destinations.map((destination) => (
                    <CollectionNavigationRow
                        rowRole="item"
                        key={destination.id}
                        href={destination.activation === 'navigate' ? destination.routePath : null}
                        testID={destinationRowTestId(destination)}
                        title={destination.title}
                        icon={<Icon name={destination.icon} />}
                        selected={destination.id === placed.currentId}
                        // An unavailable page still opens: its route says why.
                        onPress={() => activate(destination)}
                    />
                ))}
                <PluginAppPagesMenu />
            </CollectionList>
            <PluginsDeveloperMenu />
        </View>
    );
});

/** "Sources and developers", pinned at the column's foot: where things come from and the developer pages, in a menu. */
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
                        rowRole="item"
                        testID="plugins-column:developers.trigger"
                        title={t('capabilities.store.discover.sourcesAndDevelopers')}
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
