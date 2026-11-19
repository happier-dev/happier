import * as React from 'react';
import { StoreProjectScopeChip } from '@/components/store/StoreProjectScopeChip';
import { useIsFocused } from '@/components/appShell/workspace/destinationRoute';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useLocalSearchParams, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { DetailsPaneOpenAsPageButton } from '@happier-dev/plugin-ui/components';
import { CorePluginUiPresentationScope } from '@/components/plugins/surfaces/CorePluginUiPresentationScope';

import { DetailsPaneHost } from '@/components/appShell/panes/details/DetailsPaneHost';
import { useDetailsPaneAvailable } from '@/components/appShell/panes/details/detailsPaneAvailability';
import { useAppShellColumn } from '@/components/navigation/shell/appRail/appShellColumnContext';
import { resolveItemGroupContentHorizontalInsetPx } from '@/components/ui/lists/itemGroupSpacing';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { CompactSearchField } from '@/components/ui/forms/CompactSearchField';
import { SelectionListFilterChip } from '@/components/ui/selectionList';
import { Icon } from '@/components/ui/icons/Icon';
import { useLayoutMaxWidthStyle } from '@/components/ui/layout/layout';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useDeviceType } from '@/utils/platform/responsive';
import { useLocalSettingMutable } from '@/sync/store/hooks';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { t } from '@/text';
import { MachineAdministrationTargetSelector } from '@/components/settings/machines/MachineAdministrationTargetSelector';
import { ActionApprovalPendingNotice } from '@/components/approvals/ActionApprovalPendingNotice';
import { useInPlaceApprovalReview } from '@/components/approvals/ApprovalReviewInPlace';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { openPluginAddModal } from './add/openPluginAddModal';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { SettingAnchor } from '@/components/settings/shell/SettingRow';
import { useSettingsColumnFilter } from '@/components/settings/shell/useSettingsColumnFilter';
import { defineSettingsCollectionAdapter } from '@/components/settings/shell/settingsCollectionAdapter';

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
import { PluginListingPane } from './listing/PluginListingScreen';
import { PLUGIN_CARD_MIN_WIDTH_PX } from './collection/PluginsPageCollection';
import {
    createPluginSettingsViews,
    filterInstalledPlugins,
    installedPluginFilterStatus,
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
    buildPluginsHomeRoute,
    readPluginsOpenItem,
    readStoreProjectRoute,
    pluginsHomeTitleKey,
    PLUGINS_SURFACE_ICON,
} from './model/pluginsSurfaceRoutes';
import { usePluginsSurfaceHost } from './model/usePluginsSurfaceHost';
import { PluginReadOnlySnapshotNotice } from './PluginReadOnlySnapshotNotice';
import { NativeAppPluginPanelsSettingsEntry } from './NativeAppPluginPanelsSettingsEntry';
import { PluginUpdateReviewSettingsEntry } from './PluginUpdateReviewSettingsEntry';
import { PLUGINS_SETTINGS } from './pluginsSettings';

/**
 * The aggregate "All sources" choice. It is a presentation id for "no source filter", which the
 * state owner models as `null`; it is deliberately not a source id so it can never collide with one
 * the machine actually has configured.
 */
const DISCOVER_ALL_SOURCES_ID = 'all';
const installedColumnAdapter = defineSettingsCollectionAdapter(['status']);
const INSTALLED_STATED_FIELDS = ['status'] as const;

/**
 * The page's own minimum beside an open plugin: two card columns with the page's side insets and the
 * gap between them. Widening the details pane past it turns the pane into an overlay rather than
 * leaving a one-column grid.
 */
const PLUGINS_PAGE_MIN_WIDTH_PX = PLUGIN_CARD_MIN_WIDTH_PX * 2 + 16 * 2 + 12;

/**
 * Settings is the selected machine's management home; the app host also offers marketplace Browse.
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
    const layoutPresented = useLayoutPresentationActive();
    const router = useRouter();
    // Settings or the app page: a listing or a plugin's page opens within the host this page is shown in.
    const host = usePluginsSurfaceHost();
    const appShellColumn = useAppShellColumn();
    const viewChoiceInColumn = host === 'app' && appShellColumn.columnVisible;
    const routeParams = useLocalSearchParams<{ view?: string; kind?: string; source?: string; plugin?: string; itemId?: string; version?: string; project?: string }>();
    const { source: requestedSource, plugin: requestedPlugin } = routeParams;
    // The Store's Plugins kind page (`view=kind&kind=plugin`) is this page's Browse view.
    const requestedView = routeParams.view === 'kind' && routeParams.kind === 'plugin' ? 'browse' : routeParams.view;
    const settingsHost = host === 'settings';
    const legacyDiscoveryHandoff = settingsHost && requestedView === 'browse';
    const addressedItem = readPluginsOpenItem(routeParams);
    const state = usePluginSettingsScreenState({ focused: isFocused && !legacyDiscoveryHandoff,
        ...(legacyDiscoveryHandoff ? { management: false } : addressedItem ? { management: true }
            : requestedView === 'browse' ? { management: false } : {}),
        ...(requestedView === 'browse' ? { initialView: 'discover' } : {}),
        initialCatalogSourceId: requestedView === 'browse' && !requestedPlugin && typeof requestedSource === 'string' ? requestedSource : undefined });
    const activeView = settingsHost ? 'installed' : state.activeView;
    // A card's Install or a plugin's Update opens its evaluated review here, where it was pressed.
    const approvalReview = useInPlaceApprovalReview(state.pluginActionApproval);
    const approvalWaiting = approvalReview.waiting ? (
        <ActionApprovalPendingNotice
            testID="settings.plugins.approvalWaiting"
            message={t('approvals.waitingForYou')}
            summary={state.pluginActionApproval.approvalSummary}
            onOpenApproval={approvalReview.reopen}
        />
    ) : null;
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
    const { setActiveView } = state;
    React.useEffect(() => {
        if (settingsHost && requestedView === 'browse') {
            router.replace(buildPluginsHomeRoute('app', { view: 'browse', open: readPluginsOpenItem(routeParams),
                ...(typeof requestedSource === 'string' ? { sourceId: requestedSource } : {}) }));
        }
        else if (!settingsHost && requestedView === 'browse') setActiveView('discover');
        else if (requestedView === 'installed') setActiveView('installed');
    }, [settingsHost, requestedView, requestedSource, requestedPlugin, routeParams.itemId, routeParams.version, setActiveView, router]);

    // Grid | List, remembered per view on this device.
    const [presentationByView, setPresentationByView] = useLocalSettingMutable('pluginsCollectionViewV1');
    const presentationKey = activeView === 'installed' ? 'installed' : 'discover';
    // A phone reads plugins as rows (lab ideas-1118-platform scene 1 at 390) until the person picks a layout.
    const phone = useDeviceType() === 'phone';
    const presentation: PluginsCollectionPresentation = presentationByView?.[presentationKey] ?? (phone ? 'list' : 'grid');
    const setPresentation = React.useCallback((next: PluginsCollectionPresentation) => {
        setPresentationByView({ ...(presentationByView ?? {}), [presentationKey]: next });
    }, [presentationByView, setPresentationByView, presentationKey]);

    // Installed search and status filter narrow the machine's list locally; Browse searches every source.
    // The page owns the collection's one search control; the column only chooses the destination.
    const installedQuery = usePluginsInstalledQuery();
    const installedFacts = React.useMemo(() => state.installedPlugins.map(entry => {
        const status = installedPluginFilterStatus(entry);
        return { key: entry.pluginId, title: entry.title, context: entry.description ?? null,
            status, fields: { status: [status] } };
    }), [state.installedPlugins]);
    const installedFilterFields = React.useMemo(() => ({ status: {
        label: t('settingsPlugins.surfaces.statusFilterLabel'), icon: 'circle-half' as const, valueLabel: installedStatusFilterTitle,
    } }), []);
    const installedFilter = useSettingsColumnFilter({
        column: 'plugins', presented: isFocused && activeView === 'installed',
        testIDPrefix: 'settings.plugins.marketplace.installed', adapter: installedColumnAdapter,
        // The Installed tab's own status control already says this filter.
        statedFields: INSTALLED_STATED_FIELDS,
        fields: installedFilterFields, facts: installedFacts,
        search: { value: installedQuery, set: setPluginsInstalledQuery },
    });
    const statusSelection = installedFilter.filters.status;
    const installedStatus = !statusSelection || (statusSelection.include.length === 0 && statusSelection.exclude.length === 0)
        ? 'all' : statusSelection.include.length === 1 && statusSelection.exclude.length === 0
            && (statusSelection.include[0] === 'enabled' || statusSelection.include[0] === 'disabled' || statusSelection.include[0] === 'attention')
            ? statusSelection.include[0] : null;
    const setInstalledStatus = React.useCallback((status: InstalledPluginStatusFilter) => {
        installedFilter.setFilters(status === 'all' ? {} : { status: { include: [status], exclude: [] } });
    }, [installedFilter.setFilters]);
    const visibleInstalledPlugins = React.useMemo(
        () => {
            const queried = filterInstalledPlugins(state.installedPlugins, { query: installedQuery, status: 'all' });
            return installedFilter.active ? queried.filter(entry => installedFilter.matches(entry.pluginId)) : queried;
        },
        [installedQuery, installedFilter.active, installedFilter.matches, state.installedPlugins],
    );
    const installedCollectionState = resolvePluginsCollectionState({
        noTarget,
        noticeReason: null,
        listRead: state.installedPluginsRead,
        itemCount: state.installedPlugins.length,
        visibleCount: visibleInstalledPlugins.length,
        filtering: installedQuery.trim().length > 0 || installedFilter.active,
    });
    // Where each plugin runs across the Account, from the one plugin/machine matrix owner.
    const machineMatrix = usePluginMachineMatrix();
    const machineCoverageByPluginId = React.useMemo(
        () => resolvePluginMachineCoverageLabels(machineMatrix),
        [machineMatrix],
    );
    const clearInstalledFilters = React.useCallback(() => {
        setPluginsInstalledQuery('');
        installedFilter.clearFilters();
    }, [installedFilter.clearFilters]);

    // The detail beside the collection, in the app's details pane; without one, its own page.
    const besidePage = useDetailsPaneAvailable();
    const { openItem, open: setOpenItem, close: closePane } = usePluginsOpenItem();
    // A selected detail stays in the existing pane instance while the layout owner recomposes
    // it into a full-width overlay. Availability chooses where a NEW open goes, not what to retain.
    const paneOpen = openItem !== null;
    const installedPaneOpen = openItem?.kind === 'installed';
    const openPlugin = React.useCallback((pluginId: string) => {
        if (besidePage) {
            setOpenItem({ kind: 'installed', pluginId });
            return;
        }
        router.push(buildPluginDetailRoute(host, pluginId, readStoreProjectRoute(routeParams)));
    }, [besidePage, host, router, setOpenItem, routeParams.project]);
    const openListing = React.useCallback((entry: Readonly<{ id: string; sourceId: string; itemId?: string; version?: string | null }>) => {
        const listing = { sourceId: entry.sourceId, pluginId: entry.id,
            ...(entry.itemId ? { itemId: entry.itemId } : {}), ...(entry.version ? { version: entry.version } : {}) };
        if (besidePage) {
            setOpenItem({ kind: 'listing', ...listing });
            return;
        }
        router.push(buildPluginListingRoute(host, listing, readStoreProjectRoute(routeParams)));
    }, [besidePage, host, router, setOpenItem, routeParams.project]);
    const openPluginSources = React.useCallback(() => router.push(SETTINGS_ROUTES.pluginSources), [router]);
    const openSelectionAsPage = React.useCallback(() => {
        if (!openItem) return;
        router.push(openItem.kind === 'installed'
            ? buildPluginDetailRoute(host, openItem.pluginId, readStoreProjectRoute(routeParams))
            : buildPluginListingRoute(host, openItem, readStoreProjectRoute(routeParams)));
    }, [host, router, openItem, routeParams.project]);
    // A listing belongs to Browse: switching to Installed closes it. An installed plugin stays open
    // in either view (Browse marks it too).
    const previousActiveViewRef = React.useRef(activeView);
    React.useEffect(() => {
        if (previousActiveViewRef.current === activeView) return;
        previousActiveViewRef.current = activeView;
        if (activeView === 'installed' && openItem?.kind === 'listing') closePane();
    }, [activeView, closePane, openItem]);

    // The count belongs to the list beside it: with no machine chosen that list says to choose one.
    const installedCount = state.installedPluginsRead && !noTarget ? state.installedPlugins.length : null;
    const views = createPluginSettingsViews((key) => t(key)).map((view) => (
        view.id === 'installed' && installedCount !== null ? { ...view, label: `${view.label} ${installedCount}` } : view
    ));
    // The read-failed state card carries its own Retry; the banner would repeat it.
    const showSnapshotNotice = state.readOnlySnapshotNotice !== null
        && state.readOnlySnapshotNotice.reason !== 'refreshing'
        && !noTarget
        && !(activeView === 'installed' && installedCollectionState === 'readFailed');
    const styles = stylesheet;

    const storePluginsKind = host === 'app' && activeView === 'discover';
    const pageHeader = (
        <>
        <SettingsPageHeader
            // In the Store, Browse is the Plugins kind page: it is named for its kind, like the other kind pages.
            title={storePluginsKind ? t('capabilities.store.kinds.plugin.title') : t(pluginsHomeTitleKey(host))}
            description={storePluginsKind ? t('capabilities.store.kinds.plugin.description') : t('settingsPlugins.surfaces.purpose')}
            actions={(
                <>
                {host === 'app' ? <StoreProjectScopeChip /> : null}
                <MachineAdministrationTargetSelector
                    presentation="chip"
                    selection={state.administrationTargetSelection}
                    testIDPrefix="settings.plugins.administration.target"
                    groupTitle={t('settingsPlugins.administrationMachineTitle')}
                />
                {/* Adding installs on the chosen Machine: until one is chosen the chip is the page's one ask. */}
                {noTarget ? null : <RoundButton testID="settings.plugins.add" title={t('common.add')}
                    leading={<AddGlyph />}
                    onPress={() => openPluginAddModal({ host, onInstallGit: state.runGitSourceInstall })} />}
                </>
            )}
        />

        {/* What blocks use comes first, directly under the Machine chip it is about. */}
        {showSnapshotNotice && state.readOnlySnapshotNotice ? (
            <PluginReadOnlySnapshotNotice
                testID="settings.plugins.marketplace.readOnlySnapshot"
                reason={state.readOnlySnapshotNotice.reason}
                onRetry={state.refreshPluginTruth}
            />
        ) : null}
        {/*
          * Next after the target it acts on: a change waiting on this user
          * is attention, not one view's content, and a change an Agent
          * prepared has no other route into the app at all.
          */}
        <PendingPluginChangesSection
            pendingChanges={state.pendingPluginChanges}
            active={isFocused && layoutPresented && !legacyDiscoveryHandoff && activeView === 'installed'}
            target={state.administrationTargetSelection.selectedTarget ? {
                serverId: state.administrationTargetSelection.selectedTarget.serverIdentityId,
                machineId: state.administrationTargetSelection.selectedTarget.machineId,
            } : null}
        />
        <PluginRoutineOperationSettlementRow
            settlement={state.routineOperationSettlement}
            scope="pending"
        />

        <PluginsToolbar
            // Beside the app rail the Plugins column owns Installed | Browse (lab `xrail-R1p`).
            views={settingsHost || viewChoiceInColumn ? null : views}
            activeView={activeView}
            onSelectView={state.setActiveView}
            presentation={activeView === 'installed' && noTarget ? null : presentation}
            onSelectPresentation={setPresentation}
            // With no Machine chosen there is no list to search, filter or lay out: the section says to choose one.
            installed={activeView === 'installed' && !noTarget ? {
                // Beside the rail the Plugins column holds the search over this query.
                query: installedQuery,
                onChangeQuery: setPluginsInstalledQuery,
                status: installedStatus,
                conditionWords: installedFilter.conditionWords,
                onSelectStatus: setInstalledStatus,
                // The status filter earns its place only when it could change the list.
                statusFilterUseful: installedFilter.active || state.installedPlugins.some((entry) => (
                    filterInstalledPlugins([entry], { query: '', status: 'enabled' }).length === 0)),
            } : null}
            // My plugins manages; discovery is the Store, one quiet door beside the search (lab t:plugins).
            store={settingsHost ? () => router.push(buildPluginsHomeRoute('app', { view: 'browse' })) : null}
            discover={activeView === 'discover' ? {
                searchText: state.discoverSearchText,
                searchable: state.canRunDiscoverActions,
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
        {/* The Store's Plugins kind page is a browse page: the update preference and developer tools are Settings and
            the Store column's Sources and developers, never furniture under the catalog (TASTE-S4060 D11). */}
        {storePluginsKind ? null : <PluginUpdateReviewSettingsEntry />}
        <NativeAppPluginPanelsSettingsEntry />

        {/* Beside the rail the Plugins column pins these at its foot. */}
        {viewChoiceInColumn || storePluginsKind ? null : <PluginsDeveloperLinks
            webhooksAvailable={webhooksAvailable}
            inSettingsFromApp={host === 'app'}
            onOpen={(route) => router.push(route)}
        />}
        </>
    );

    return (
        <ListPresentationProvider value="page" pageNoticeActive={showSnapshotNotice}>
        <DetailsPaneHost
            testID="settings.plugins.detailPane"
            mainColumn={{
                hideLabel: t('panes.mainColumn.hidePage', { title: t(pluginsHomeTitleKey(host)) }),
                showLabel: t('panes.mainColumn.showPage', { title: t(pluginsHomeTitleKey(host)) }),
                identity: { name: t(pluginsHomeTitleKey(host)) },
            }}
            mainMinWidthPx={PLUGINS_PAGE_MIN_WIDTH_PX}
            onCloseDetails={closePane}
            details={openItem && paneOpen ? {
                header: {
                    title: openItem.kind === 'installed'
                        ? t('settingsPlugins.surfaces.detailInstalledLabel')
                        : t('settingsPlugins.surfaces.detailListingLabel'),
                    actions: (
                        <CorePluginUiPresentationScope><DetailsPaneOpenAsPageButton
                            testID="settings.plugins.detailPane.openAsPage"
                            accessibilityLabel={t('settingsPlugins.surfaces.openAsPage')}
                            onPress={openSelectionAsPage}
                        /></CorePluginUiPresentationScope>
                    ),
                },
                content: openItem.kind === 'installed' ? (
                    <PluginDetailView
                        key={openItem.pluginId}
                        pluginId={openItem.pluginId}
                        state={state}
                        presentation="pane"
                        approvalReview={approvalReview}
                    />
                ) : (
                    <PluginListingPane
                        key={`${openItem.sourceId}:${openItem.pluginId}`}
                        sourceId={openItem.sourceId}
                        pluginId={openItem.pluginId}
                        itemId={openItem.itemId}
                        version={openItem.version}
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
                {activeView === 'installed' ? (
                    <InstalledPluginsSection
                        // A registry or snapshot notice means the machine could not say what was added.
                        // A background refresh keeps the machine's answer standing; only a real notice withholds it.
                        machineAnswered={state.readOnlySnapshotNotice === null
                            || state.readOnlySnapshotNotice.reason === 'refreshing'}
                        header={(
                            <>
                                {pageHeader}
                                {/* An open plugin's pane is where its Update was pressed: its waiting line and outcome show there. */}
                                {installedPaneOpen ? null : (
                                    <>
                                        {approvalWaiting}
                                        <PluginRoutineOperationSettlementRow
                                            settlement={state.routineOperationSettlement}
                                            scope="installed"
                                        />
                                    </>
                                )}
                            </>
                        )}
                        footer={pageFooter}
                        collectionState={installedCollectionState}
                        installedPlugins={visibleInstalledPlugins}
                        presentation={presentation}
                        selectedPluginId={openItem?.kind === 'installed' && paneOpen ? openItem.pluginId : null}
                        searchText={installedQuery.trim() || installedFilter.conditionWords}
                        filtering={installedQuery.trim().length > 0 || installedStatus !== 'all'}
                        projectionByPluginId={state.pluginProjectionById}
                        machineId={state.executionMachineId}
                        serverId={state.executionServerId}
                        machineCoverageByPluginId={machineCoverageByPluginId}
                        onClearSearch={clearInstalledFilters}
                        onDiscover={() => settingsHost ? openPluginAddModal({ host, onInstallGit: state.runGitSourceInstall }) : state.setActiveView('discover')}
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
                                    failureStatus={state.discoverFailureStatus}
                                    sources={state.discoverSources}
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
                                {approvalWaiting}
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
                        machineId={state.executionMachineId}
                        serverId={state.executionServerId}
                        canRunActions={state.canRunDiscoverActions}
                        installDisabledReason={state.discoverInstallDisabledReason}
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
        </ListPresentationProvider>
    );
});

type InstalledToolbarState = Readonly<{
    /** `null` where the Plugins column shows the search over the same query. */
    query: string | null;
    onChangeQuery: (text: string) => void;
    status: InstalledPluginStatusFilter | null;
    conditionWords: string;
    onSelectStatus: (status: InstalledPluginStatusFilter) => void;
    /** Some plugin is disabled or needs attention, or a status is already chosen. */
    statusFilterUseful: boolean;
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

function installedStatusFilterTitle(status: string): string {
    switch (status) {
        case 'all': return t('settingsPlugins.surfaces.statusAll');
        case 'enabled': return t('settingsPlugins.surfaces.statusEnabled');
        case 'disabled': return t('settingsPlugins.surfaces.statusDisabled');
        case 'attention': return t('settingsPlugins.surfaces.statusAttention');
        default: return status;
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
    /** Grid | List, or `null` while there is nothing to lay out (no Machine chosen). */
    presentation: PluginsCollectionPresentation | null;
    onSelectPresentation: (presentation: PluginsCollectionPresentation) => void;
    installed: InstalledToolbarState | null;
    discover: DiscoverToolbarState | null;
    /** Settings' My plugins: the secondary door into the Store's Plugins (S30-R19); Add stays the header's. */
    store: (() => void) | null;
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
                    // The page owns the toolbar's width, so the platform floor costs a
                    // wider track rather than an undersized target.
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
                    </>
                ) : null}
                <View style={styles.viewControls}>
                    {props.installed?.statusFilterUseful ? <SelectionListFilterChip filter={{
                        id: 'plugins-installed-status',
                        testID: 'settings.plugins.marketplace.installed.statusFilter',
                        label: t('settingsPlugins.surfaces.statusFilterLabel'),
                        options: [
                            ...INSTALLED_STATUS_FILTERS.map((status) => ({ id: status, label: installedStatusFilterTitle(status) })),
                            ...(props.installed.status === null ? [{ id: 'conditions', label: props.installed.conditionWords }] : []),
                        ],
                        selectedId: props.installed.status ?? 'conditions',
                        onChange: (id) => {
                            const status = INSTALLED_STATUS_FILTERS.find((candidate) => candidate === id);
                            if (status && props.installed) props.installed.onSelectStatus(status);
                        },
                    }} /> : null}
                    {props.discover ? (
                        // This narrows the aggregate query; it never creates a second index.
                        <SelectionListFilterChip filter={{
                            id: 'plugins-discover-source',
                            testID: 'settings.plugins.marketplace.sourceFilter',
                            label: t('settingsPlugins.discoverSourceFilterLabel'),
                            options: [
                                { id: DISCOVER_ALL_SOURCES_ID, label: t('settingsPlugins.surfaces.allSources') },
                                ...props.discover.sources.map((source) => ({ id: source.id, label: source.title })),
                            ],
                            selectedId: props.discover.selectedSourceId ?? DISCOVER_ALL_SOURCES_ID,
                            onChange: (id) => props.discover?.onSelectSource(id === DISCOVER_ALL_SOURCES_ID ? null : id),
                        }} />
                    ) : null}
                {props.presentation ? <SettingAnchor setting={PLUGINS_SETTINGS.settings.collectionView}><SegmentedTabBar
                    tabs={presentationTabs}
                    activeTabId={props.presentation}
                    onSelectTab={props.onSelectPresentation}
                    testIDPrefix="settings.plugins.collectionView"
                    accessibilityLabel={t('settingsPlugins.surfaces.viewLabel')}
                    segmentSizing="content"
                /></SettingAnchor> : null}
                {props.store ? (
                    <RoundButton
                        testID="settings.plugins.browseInStore"
                        size="normal"
                        display="secondary"
                        title={t(pluginsHomeTitleKey('app'))}
                        leading={<Icon name={PLUGINS_SURFACE_ICON} size={14} color={theme.colors.text.secondary} />}
                        onPress={props.store}
                    />
                ) : null}
                </View>
            </View>
        </View>
    );
}

/** The header Add's plus, in the primary button's tint. */
function AddGlyph() {
    const { theme } = useUnistyles();
    return <Icon name="plus" size={16} color={theme.colors.button.primary.tint} />;
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
        columnGap: theme.space.s10,
        rowGap: theme.space.s10,
        paddingHorizontal: resolveItemGroupContentHorizontalInsetPx(),
        paddingTop: theme.space.s16,
        paddingBottom: theme.space.s4,
    },
    controls: {
        flexGrow: 1,
        flexShrink: 1,
        flexBasis: 320,
        minWidth: 0,
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: theme.space.s10,
    },
    // On a phone the search keeps a usable width: the filter and Grid | List wrap under it
    // rather than squeezing it to a sliver (lab P1).
    search: {
        flexGrow: 1,
        flexShrink: 1,
        flexBasis: 220,
        minWidth: 0,
    },
    viewControls: {
        flexDirection: 'row',
        alignItems: 'center',
        alignSelf: 'flex-start',
        gap: theme.space.s10,
    },
    developer: {
        width: '100%',
        alignSelf: 'center',
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        columnGap: 14,
        rowGap: theme.space.s4,
        paddingHorizontal: resolveItemGroupContentHorizontalInsetPx() + PAGE_LIST_METRICS.headingOpticalInsetPx,
        paddingTop: theme.space.s20,
        paddingBottom: 28,
    },
    developerLabel: {
        ...Typography.variant('meta'),
        color: theme.colors.text.tertiary,
    },
    developerLink: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s2,
    },
    developerLinkText: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
    },
}));

export default PluginSettingsHomeScreen;
