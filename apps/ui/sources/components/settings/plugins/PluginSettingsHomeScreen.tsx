import * as React from 'react';
import { useIsFocused } from '@/components/appShell/workspace/destinationRoute';
import { Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useLocalSearchParams, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

import { DetailsPaneHost } from '@/components/appShell/panes/details/DetailsPaneHost';
import { useDetailsPaneAvailable } from '@/components/appShell/panes/details/detailsPaneAvailability';
import { useAppShellColumn } from '@/components/navigation/shell/appRail/appShellColumnContext';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { resolveItemGroupContentHorizontalInsetPx } from '@/components/ui/lists/itemGroupSpacing';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { CompactSearchField } from '@/components/ui/forms/CompactSearchField';
import { ToolbarSelect } from '@/components/ui/forms/ToolbarSelect';
import { Icon } from '@/components/ui/icons/Icon';
import { useLayoutMaxWidthStyle } from '@/components/ui/layout/layout';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useLocalSettingMutable } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { MachineAdministrationTargetSelector } from '@/components/settings/machines/MachineAdministrationTargetSelector';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { SettingAnchor } from '@/components/settings/shell/SettingRow';

import {
    DiscoverListingsSection,
    DiscoverStatusSummary,
    InstalledPluginsSection,
    PendingPluginChangesSection,
    PluginRoutineOperationSettlementRow,
    type PluginsCollectionPresentation,
} from './PluginMarketplaceSections';
import { PluginDetailView } from './detail/PluginDetailScreen';
import { listPluginsDeveloperLinks, type PluginsDeveloperRoute } from './model/pluginsDeveloperLinks';
import { resolvePluginMachineCoverageLabels } from './machines/pluginMachineCoverage';
import { usePluginMachineMatrix } from './machines/usePluginMachineMatrix';
import { PluginListingView } from './listing/PluginListingScreen';
import { PLUGIN_CARD_MIN_WIDTH_PX } from './collection/PluginCardStatus';
import {
    createPluginSettingsViews,
    filterInstalledPlugins,
    type InstalledPluginStatusFilter,
    type PluginSettingsViewId,
} from './model/pluginMarketplaceModel';
import { resolvePluginsCollectionState } from './model/pluginsCollectionState';
import { usePluginSettingsScreenState } from './model/usePluginSettingsScreenState';
import { usePluginsOpenItem } from './model/usePluginsOpenItem';
import { setPluginsInstalledQuery, usePluginsInstalledQuery } from './model/pluginsInstalledSearch';
import {
    buildPluginDetailRoute,
    buildPluginListingRoute,
    pluginsHomeTitleKey,
    usePluginsSurfaceHost,
} from './model/pluginsSurfaceRoutes';
import { PluginReadOnlySnapshotNotice } from './PluginReadOnlySnapshotNotice';
import { NativeAppPluginPanelsSettingsEntry } from './NativeAppPluginPanelsSettingsEntry';
import { PluginAppPagesSettingsEntry } from './PluginAppPagesSettingsEntry';
import { PluginUpdateReviewSettingsEntry } from './PluginUpdateReviewSettingsEntry';

/**
 * The aggregate "All sources" choice. It is a presentation id for "no source filter", which the
 * state owner models as `null`; it is deliberately not a source id so it can never collide with one
 * the machine actually has configured.
 */
const DISCOVER_ALL_SOURCES_ID = 'all';

/**
 * The page's own minimum beside an open plugin: two card columns with the page's side insets and the
 * gap between them. Widening the details pane past it turns the pane into an overlay rather than
 * leaving a one-column grid.
 */
const PLUGINS_PAGE_MIN_WIDTH_PX = PLUGIN_CARD_MIN_WIDTH_PX * 2 + 16 * 2 + 12;

/**
 * Plugins: the selected machine's plugins (Installed) and the marketplace (Browse), in the Settings
 * shell and as the main sidebar's page (one screen, two hosts).
 *
 * Top to bottom: the page header with the machine chip, decisions waiting on the user, the toolbar
 * (Installed | Browse, search, a filter, Grid | List), the collection, then the Account update
 * preference, app surfaces, and one quiet row of developer destinations.
 *
 * Opening a plugin names it in the route (`usePluginsOpenItem`, shared with the Plugins column) and
 * shows its detail in the app's details pane (`DetailsPaneHost`: full height, resizable, an overlay
 * when the page would drop below two card columns); where there is no side pane (phones) it pushes
 * the plugin's own page. Closing the detail returns to the same collection, filters and scroll: the
 * collection never unmounts.
 */
export const PluginSettingsHomeScreen = React.memo(function PluginSettingsHomeScreen() {
    const isFocused = useIsFocused();
    const router = useRouter();
    // Settings or the app page: a listing or a plugin's page opens within the host this page is shown in.
    const host = usePluginsSurfaceHost();
    const appShellColumn = useAppShellColumn();
    const viewChoiceInColumn = host === 'app' && appShellColumn.columnVisible;
    const state = usePluginSettingsScreenState({ focused: isFocused });
    // The webhook administration screen and its account API are both behind the
    // server's public-webhook feature, so the entry only exists where it leads
    // somewhere the server will answer.
    const webhooksAvailable = useFeatureEnabled('plugins.webhooks');
    // Names the source a running search is narrowed to, so the pane's single
    // status line can say what is being searched instead of a generic spinner.
    const selectedDiscoverSourceTitle = state.selectedDiscoverSourceId === null
        ? null
        : state.discoverSources.find((source) => source.id === state.selectedDiscoverSourceId)?.title ?? null;
    const noTarget = state.administrationTargetSelection.state.kind === 'unselected';

    // `?view=browse` (the listing page's breadcrumb, a deep link, the Plugins column) opens the Browse
    // view, and `?view=installed` (the Plugins column) the Installed one.
    const { view: requestedView } = useLocalSearchParams<{ view?: string }>();
    const { setActiveView } = state;
    React.useEffect(() => {
        if (requestedView === 'browse') setActiveView('discover');
        else if (requestedView === 'installed') setActiveView('installed');
    }, [requestedView, setActiveView]);

    // Grid | List, remembered per view on this device.
    const [presentationByView, setPresentationByView] = useLocalSettingMutable('pluginsCollectionViewV1');
    const presentationKey = state.activeView === 'installed' ? 'installed' : 'discover';
    const presentation: PluginsCollectionPresentation = presentationByView?.[presentationKey] ?? 'grid';
    const setPresentation = React.useCallback((next: PluginsCollectionPresentation) => {
        setPresentationByView({ ...(presentationByView ?? {}), [presentationKey]: next });
    }, [presentationByView, presentationKey, setPresentationByView]);

    // Installed search and status filter narrow the machine's list locally; Browse searches every source.
    // The installed query is the one the Plugins column's search writes (one query, one control on
    // screen): beside the column the page shows no field of its own.
    const installedQuery = usePluginsInstalledQuery();
    const [installedStatus, setInstalledStatus] = React.useState<InstalledPluginStatusFilter>('all');
    const visibleInstalledPlugins = React.useMemo(
        () => filterInstalledPlugins(state.installedPlugins, { query: installedQuery, status: installedStatus }),
        [installedQuery, installedStatus, state.installedPlugins],
    );
    const installedCollectionState = resolvePluginsCollectionState({
        noTarget,
        noticeReason: state.readOnlySnapshotNotice?.reason ?? null,
        listRead: state.installedPluginsRead,
        itemCount: state.installedPlugins.length,
        visibleCount: visibleInstalledPlugins.length,
        filtering: installedQuery.trim().length > 0 || installedStatus !== 'all',
    });
    // Where each plugin runs across the Account, from the one plugin/machine matrix owner.
    const machineMatrix = usePluginMachineMatrix();
    const machineCoverageByPluginId = React.useMemo(
        () => resolvePluginMachineCoverageLabels(machineMatrix),
        [machineMatrix],
    );
    const clearInstalledFilters = React.useCallback(() => {
        setPluginsInstalledQuery('');
        setInstalledStatus('all');
    }, []);

    // The detail beside the collection, in the app's details pane; without one, its own page.
    const besidePage = useDetailsPaneAvailable();
    const { openItem, open: setOpenItem, close: closePane } = usePluginsOpenItem();
    // A selected detail stays in the existing pane instance while the layout owner recomposes
    // it into a full-width overlay. Availability chooses where a NEW open goes, not what to retain.
    const paneOpen = openItem !== null;
    const openPlugin = React.useCallback((pluginId: string) => {
        if (besidePage) {
            setOpenItem({ kind: 'installed', pluginId });
            return;
        }
        router.push(buildPluginDetailRoute(host, pluginId));
    }, [besidePage, host, router, setOpenItem]);
    const openListing = React.useCallback((entry: Readonly<{ id: string; sourceId: string }>) => {
        if (besidePage) {
            setOpenItem({ kind: 'listing', sourceId: entry.sourceId, pluginId: entry.id });
            return;
        }
        router.push(buildPluginListingRoute(host, { sourceId: entry.sourceId, pluginId: entry.id }));
    }, [besidePage, host, router, setOpenItem]);
    const openPluginSources = React.useCallback(() => router.push(SETTINGS_ROUTES.pluginSources), [router]);
    const openSelectionAsPage = React.useCallback(() => {
        if (!openItem) return;
        router.push(openItem.kind === 'installed'
            ? buildPluginDetailRoute(host, openItem.pluginId)
            : buildPluginListingRoute(host, { sourceId: openItem.sourceId, pluginId: openItem.pluginId }));
    }, [host, router, openItem]);
    // A listing belongs to Browse: switching to Installed closes it. An installed plugin stays open
    // in either view (Browse marks it too).
    const { activeView } = state;
    const previousActiveViewRef = React.useRef(activeView);
    React.useEffect(() => {
        if (previousActiveViewRef.current === activeView) return;
        previousActiveViewRef.current = activeView;
        if (activeView === 'installed' && openItem?.kind === 'listing') closePane();
    }, [activeView, closePane, openItem]);

    const installedCount = state.installedPluginsRead ? state.installedPlugins.length : null;
    const views = createPluginSettingsViews((key) => t(key)).map((view) => (
        view.id === 'installed' && installedCount !== null ? { ...view, label: `${view.label} ${installedCount}` } : view
    ));
    // The read-failed state card carries its own Retry; the banner would repeat it.
    const showSnapshotNotice = state.readOnlySnapshotNotice !== null
        && !noTarget
        && !(state.activeView === 'installed' && installedCollectionState === 'readFailed');
    const styles = stylesheet;

    const pageHeader = (
        <>
        <SettingsPageHeader
            title={t(pluginsHomeTitleKey(host))}
            description={t('settingsPlugins.surfaces.purpose')}
            actions={(
                /*
                  * Every consequential action on this page — including the
                  * approve/reject decisions below — routes to the exact server
                  * and machine named here.
                  */
                <MachineAdministrationTargetSelector
                    presentation="chip"
                    selection={state.administrationTargetSelection}
                    testIDPrefix="settings.plugins.administration.target"
                    groupTitle={t('settingsPlugins.administrationMachineTitle')}
                />
            )}
        />

        {/*
          * First after the target it acts on: a change waiting on this user
          * is attention, not one view's content, and a change an Agent
          * prepared has no other route into the app at all.
          */}
        <PendingPluginChangesSection
            pendingChanges={state.pendingPluginChanges}
            canRunActions={state.daemonOperationsAvailable}
            isPluginActionInFlight={state.isPluginActionInFlight}
            onDecide={state.decidePendingPluginChange}
        />
        <PluginRoutineOperationSettlementRow
            settlement={state.routineOperationSettlement}
            scope="pending"
        />
        {showSnapshotNotice && state.readOnlySnapshotNotice ? (
            <PluginReadOnlySnapshotNotice
                testID="settings.plugins.marketplace.readOnlySnapshot"
                reason={state.readOnlySnapshotNotice.reason}
                onRetry={state.refreshPluginTruth}
            />
        ) : null}

        <PluginsToolbar
            // Beside the app rail the Plugins column owns Installed | Browse (lab `xrail-R1p`).
            views={viewChoiceInColumn ? null : views}
            activeView={state.activeView}
            onSelectView={state.setActiveView}
            presentation={presentation}
            onSelectPresentation={setPresentation}
            installed={state.activeView === 'installed' ? {
                // Beside the rail the Plugins column holds the search over this query.
                query: viewChoiceInColumn ? null : installedQuery,
                onChangeQuery: setPluginsInstalledQuery,
                status: installedStatus,
                onSelectStatus: setInstalledStatus,
            } : null}
            discover={state.activeView === 'discover' ? {
                searchText: state.discoverSearchText,
                searchable: state.daemonOperationsAvailable,
                onChangeSearchText: state.setDiscoverSearchText,
                onSubmitSearch: state.canRefreshDiscover ? state.refreshDiscover : undefined,
                sources: state.discoverSources,
                selectedSourceId: state.selectedDiscoverSourceId,
                onSelectSource: state.setSelectedDiscoverSourceId,
            } : null}
        />
        </>
    );
    const pageFooter = (
        <>
        <PluginUpdateReviewSettingsEntry />
        <NativeAppPluginPanelsSettingsEntry />
        <PluginAppPagesSettingsEntry />

        {/* Beside the rail the Plugins column pins these at its foot. */}
        {viewChoiceInColumn ? null : <PluginsDeveloperLinks
            webhooksAvailable={webhooksAvailable}
            inSettingsFromApp={host === 'app'}
            onOpen={(route) => router.push(route)}
        />}
        </>
    );

    return (
        <DetailsPaneHost
            testID="settings.plugins.detailPane"
            mainMinWidthPx={PLUGINS_PAGE_MIN_WIDTH_PX}
            onCloseDetails={closePane}
            details={openItem && paneOpen ? {
                header: {
                    title: openItem.kind === 'installed'
                        ? t('settingsPlugins.surfaces.detailInstalledLabel')
                        : t('settingsPlugins.surfaces.detailListingLabel'),
                    actions: (
                        <IconButton
                            testID="settings.plugins.detailPane.openAsPage"
                            iconName="arrow-square-out"
                            accessibilityLabel={t('settingsPlugins.surfaces.openAsPage')}
                            tooltip={t('settingsPlugins.surfaces.openAsPage')}
                            variant="plain"
                            onPress={openSelectionAsPage}
                        />
                    ),
                },
                content: openItem.kind === 'installed' ? (
                    <PluginDetailView
                        key={openItem.pluginId}
                        pluginId={openItem.pluginId}
                        state={state}
                        presentation="pane"
                    />
                ) : (
                    <PluginListingView
                        key={`${openItem.sourceId}:${openItem.pluginId}`}
                        sourceId={openItem.sourceId}
                        pluginId={openItem.pluginId}
                        state={state}
                        presentation="pane"
                    />
                ),
            } : null}
            main={(
            <View testID="settings.plugins.page" style={styles.page}>
                {/*
                  * One page-sized Collection is the page: this header, the plugins (the one grid or
                  * list, Installed and Browse alike) and the entries below scroll together, in one
                  * reading and focus order.
                  */}
                {state.activeView === 'installed' ? (
                    <InstalledPluginsSection
                        header={(
                            <>
                                {pageHeader}
                                <PluginRoutineOperationSettlementRow
                                    settlement={state.routineOperationSettlement}
                                    scope="installed"
                                />
                            </>
                        )}
                        footer={pageFooter}
                        collectionState={installedCollectionState}
                        installedPlugins={visibleInstalledPlugins}
                        presentation={presentation}
                        selectedPluginId={openItem?.kind === 'installed' && paneOpen ? openItem.pluginId : null}
                        searchText={installedQuery.trim() || installedStatusFilterTitle(installedStatus)}
                        filtering={installedQuery.trim().length > 0 || installedStatus !== 'all'}
                        projectionByPluginId={state.pluginProjectionById}
                        machineCoverageByPluginId={machineCoverageByPluginId}
                        onClearSearch={clearInstalledFilters}
                        onDiscover={() => state.setActiveView('discover')}
                        onRetry={state.refreshPluginTruth}
                        canRunActions={state.canRefreshInstalledPlugins}
                        isPluginActionInFlight={state.isPluginActionInFlight}
                        onNavigateToPlugin={openPlugin}
                        onClosePlugin={closePane}
                        onRunAction={state.runInstalledPluginAction}
                    />
                ) : (
                    <DiscoverListingsSection
                        header={(
                            <>
                                {pageHeader}
                                {/*
                                  * One status region for the whole pane. Results, source
                                  * health, index diagnostics and listings this machine
                                  * cannot install are all facts about the same search, so
                                  * they are announced once, together, in that order.
                                  */}
                                <DiscoverStatusSummary
                                    loading={state.loadingDiscover}
                                    error={state.discoverError}
                                    stale={state.discoverStale}
                                    entryCount={state.discoverEntries.length}
                                    sourceStatuses={state.discoverSourceStatuses}
                                    diagnostics={state.discoverDiagnostics}
                                    nonInstallable={state.discoverNonInstallable}
                                    selectedSourceTitle={selectedDiscoverSourceTitle}
                                    noTarget={noTarget}
                                    // The query the shown results answer, not the draft typed since.
                                    searchText={state.discoverResultsSearchText}
                                    onClearSearch={state.clearDiscoverSearch}
                                    onRetry={state.canRefreshDiscover ? state.refreshDiscover : undefined}
                                    onOpenSources={openPluginSources}
                                />
                                <PluginRoutineOperationSettlementRow
                                    settlement={state.routineOperationSettlement}
                                    scope="discover"
                                />
                            </>
                        )}
                        footer={pageFooter}
                        entries={state.discoverEntries}
                        presentation={presentation}
                        selectedListing={openItem?.kind === 'listing' && paneOpen ? openItem : null}
                        loading={state.loadingDiscover}
                        loadingMore={state.loadingMoreDiscover}
                        canLoadMore={state.discoverNextCursor !== null}
                        installedPluginById={state.installedPluginById}
                        projectionByPluginId={state.pluginProjectionById}
                        canRunActions={state.canRunDiscoverActions}
                        isPluginActionInFlight={state.isPluginActionInFlight}
                        onAction={state.runCatalogAction}
                        onLoadMore={state.loadMoreDiscover}
                        onNavigateToPlugin={openPlugin}
                        onOpenListing={openListing}
                        onCloseListing={closePane}
                    />
                )}
            </View>
            )}
        />
    );
});

type InstalledToolbarState = Readonly<{
    /** `null` where the Plugins column shows the search over the same query. */
    query: string | null;
    onChangeQuery: (text: string) => void;
    status: InstalledPluginStatusFilter;
    onSelectStatus: (status: InstalledPluginStatusFilter) => void;
}>;

type DiscoverToolbarState = Readonly<{
    searchText: string;
    searchable: boolean;
    onChangeSearchText: (text: string) => void;
    onSubmitSearch: (() => void) | undefined;
    sources: ReadonlyArray<Readonly<{ id: string; title: string }>>;
    selectedSourceId: string | null;
    onSelectSource: (sourceId: string | null) => void;
}>;

const INSTALLED_STATUS_FILTERS = ['all', 'enabled', 'disabled', 'attention'] as const satisfies readonly InstalledPluginStatusFilter[];

function installedStatusFilterTitle(status: InstalledPluginStatusFilter): string {
    switch (status) {
        case 'all': return t('settingsPlugins.surfaces.statusAll');
        case 'enabled': return t('settingsPlugins.surfaces.statusEnabled');
        case 'disabled': return t('settingsPlugins.surfaces.statusDisabled');
        case 'attention': return t('settingsPlugins.surfaces.statusAttention');
    }
}

/**
 * One line: Installed | Browse, the view's search, its filter (status on Installed, source on
 * Browse) and Grid | List. On narrow widths the controls wrap beneath the view switch rather than
 * squeezing the field.
 */
function PluginsToolbar(props: Readonly<{
    /** Installed | Browse, or `null` where the Plugins column beside the page offers the choice. */
    views: ReadonlyArray<Readonly<{ id: PluginSettingsViewId; label: string }>> | null;
    activeView: PluginSettingsViewId;
    onSelectView: (view: PluginSettingsViewId) => void;
    presentation: PluginsCollectionPresentation;
    onSelectPresentation: (presentation: PluginsCollectionPresentation) => void;
    installed: InstalledToolbarState | null;
    discover: DiscoverToolbarState | null;
}>) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const maxWidthStyle = useLayoutMaxWidthStyle();
    const presentationTabs = React.useMemo(() => [
        {
            id: 'grid' as const,
            label: t('settingsPlugins.surfaces.viewGrid'),
            icon: <Icon name="squares-four" size={16} color={theme.colors.text.secondary} />,
        },
        {
            id: 'list' as const,
            label: t('settingsPlugins.surfaces.viewList'),
            icon: <Icon name="list" size={16} color={theme.colors.text.secondary} />,
        },
    ], [theme.colors.text.secondary]);
    return (
        <View style={[styles.toolbar, maxWidthStyle]}>
            {props.views ? (
                <SegmentedTabBar
                    tabs={props.views}
                    activeTabId={props.activeView}
                    onSelectTab={props.onSelectView}
                    testIDPrefix="settings.plugins.management.view"
                    accessibilityLabel={t('settingsPlugins.viewSelectorLabel')}
                    segmentSizing="content"
                    slidingThumb
                    // The page owns the toolbar's width, so the platform floor costs a
                    // wider track rather than an undersized target.
                    targetSize="platform"
                />
            ) : null}
            <View style={styles.controls}>
                {props.installed ? (
                    <>
                        {props.installed.query !== null ? (
                            <CompactSearchField
                                testID="settings.plugins.marketplace.installed.search"
                                value={props.installed.query}
                                onChangeText={props.installed.onChangeQuery}
                                placeholder={t('settingsPlugins.surfaces.installedSearchPlaceholder')}
                                style={styles.search}
                            />
                        ) : null}
                        <ToolbarSelect
                            testID="settings.plugins.marketplace.installed.statusFilter"
                            label={t('settingsPlugins.surfaces.statusFilterLabel')}
                            items={INSTALLED_STATUS_FILTERS.map((status) => ({
                                id: status,
                                title: installedStatusFilterTitle(status),
                            }))}
                            selectedId={props.installed.status}
                            onSelect={(id) => {
                                const status = INSTALLED_STATUS_FILTERS.find((candidate) => candidate === id);
                                if (status && props.installed) props.installed.onSelectStatus(status);
                            }}
                        />
                    </>
                ) : null}
                {props.discover ? (
                    <>
                        <CompactSearchField
                            testID="settings.plugins.marketplace.search"
                            value={props.discover.searchText}
                            onChangeText={props.discover.onChangeSearchText}
                            onSubmitEditing={props.discover.onSubmitSearch}
                            editable={props.discover.searchable}
                            placeholder={t('settingsPlugins.discoverSearchPlaceholder')}
                            style={styles.search}
                        />
                        {/*
                          * The source filter narrows the same one aggregate query before
                          * acquisition; "All sources" sends no filter at all. It is never a
                          * second index.
                          */}
                        <ToolbarSelect
                            testID="settings.plugins.marketplace.sourceFilter"
                            label={t('settingsPlugins.discoverSourceFilterLabel')}
                            items={[
                                { id: DISCOVER_ALL_SOURCES_ID, title: t('settingsPlugins.surfaces.allSources') },
                                ...props.discover.sources.map((source) => ({ id: source.id, title: source.title })),
                            ]}
                            selectedId={props.discover.selectedSourceId ?? DISCOVER_ALL_SOURCES_ID}
                            onSelect={(id) => props.discover?.onSelectSource(id === DISCOVER_ALL_SOURCES_ID ? null : id)}
                        />
                    </>
                ) : null}
                <SegmentedTabBar
                    tabs={presentationTabs}
                    activeTabId={props.presentation}
                    onSelectTab={props.onSelectPresentation}
                    testIDPrefix="settings.plugins.collectionView"
                    accessibilityLabel={t('settingsPlugins.surfaces.viewLabel')}
                    segmentSizing="content"
                    slidingThumb
                    targetSize="platform"
                />
            </View>
        </View>
    );
}

/**
 * Where plugins come from, building your own, and what the machine reports: one quiet row of links
 * at the end of the page. They are Settings pages of their own (configuration) in both hosts, never
 * a second tab bar beside Installed and Browse. Each link keeps its setting's search anchor.
 */
function PluginsDeveloperLinks(props: Readonly<{
    webhooksAvailable: boolean;
    /** The app page: these links leave for Settings, so the row says so. */
    inSettingsFromApp: boolean;
    onOpen: (route: PluginsDeveloperRoute) => void;
}>) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const maxWidthStyle = useLayoutMaxWidthStyle();
    const links = listPluginsDeveloperLinks({ webhooksAvailable: props.webhooksAvailable });
    return (
        <View style={[styles.developer, maxWidthStyle]} testID="settings.plugins.developerLinks">
            <Text style={styles.developerLabel}>{t('settingsPlugins.surfaces.forDevelopers')}</Text>
            {links.map((link) => (
                <SettingAnchor key={link.testID} setting={link.setting}>
                    <HappierPressable
                        testID={link.testID}
                        accessibilityRole="link"
                        accessibilityHint={props.inSettingsFromApp ? t('settingsPlugins.surfaces.moreDescriptionInSettings') : undefined}
                        onPress={() => props.onOpen(link.route)}
                        style={styles.developerLink}
                    >
                        <Text style={styles.developerLinkText}>{t(link.setting.titleKey)}</Text>
                        <Icon name="caret-right" size={12} color={theme.colors.text.secondary} />
                    </HappierPressable>
                </SettingAnchor>
            ))}
        </View>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    page: {
        flex: 1,
        minWidth: 0,
    },
    toolbar: {
        width: '100%',
        alignSelf: 'center',
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        columnGap: 10,
        rowGap: 10,
        paddingHorizontal: resolveItemGroupContentHorizontalInsetPx(),
        paddingTop: 16,
        paddingBottom: 4,
    },
    controls: {
        flexGrow: 1,
        flexShrink: 1,
        flexBasis: 320,
        minWidth: 0,
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 10,
    },
    // On a phone the search keeps a usable width: the filter and Grid | List wrap under it
    // rather than squeezing it to a sliver (lab P1).
    search: {
        flexGrow: 1,
        flexShrink: 1,
        flexBasis: 220,
        minWidth: 0,
    },
    developer: {
        width: '100%',
        alignSelf: 'center',
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        columnGap: 14,
        rowGap: 4,
        paddingHorizontal: resolveItemGroupContentHorizontalInsetPx() + PAGE_LIST_METRICS.headingOpticalInsetPx,
        paddingTop: 20,
        paddingBottom: 28,
    },
    developerLabel: {
        ...Typography.default(),
        fontSize: 12.5,
        lineHeight: 18,
        color: theme.colors.text.tertiary,
    },
    developerLink: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 2,
        minHeight: resolveMinimumInteractiveTargetSize(Platform.OS),
    },
    developerLinkText: {
        ...Typography.default(),
        fontSize: 12.5,
        lineHeight: 18,
        color: theme.colors.text.secondary,
    },
}));

export default PluginSettingsHomeScreen;
