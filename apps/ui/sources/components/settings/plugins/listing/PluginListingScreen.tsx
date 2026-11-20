import * as React from 'react';
import { useIsFocused } from '@/components/appShell/workspace/destinationRoute';
import { View } from 'react-native';
import { HappierBreadcrumb } from '@happier-dev/plugin-ui/presentation';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';

import { ActionApprovalPendingNotice } from '@/components/approvals/ActionApprovalPendingNotice';
import { useInPlaceApprovalReview } from '@/components/approvals/ApprovalReviewInPlace';
import { MachineAdministrationTargetSelector } from '@/components/settings/machines/MachineAdministrationTargetSelector';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { Icon } from '@/components/ui/icons/Icon';
import { InlineStatus } from '@/components/ui/status/InlineStatus';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemGroupColumn, ItemGroupColumns } from '@/components/ui/lists/ItemGroupColumns';
import { ItemList } from '@/components/ui/lists/ItemList';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { useLayoutMaxWidth } from '@/components/ui/layout/layout';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import { catalogReviewStatusLabel, formatCatalogEntryVersion } from '../model/pluginMarketplaceModel';
import { usePluginSettingsScreenState, type PluginSettingsScreenState } from '../model/usePluginSettingsScreenState';
import { buildPluginDetailRoute, buildPluginsHomeRoute } from '../model/pluginsSurfaceRoutes';
import { usePluginsSurfaceHost } from '../model/usePluginsSurfaceHost';
import type { PluginListingRouteParams } from '../model/pluginsSurfaceRoutes';
import { PluginMark } from '../PluginMark';
import { PluginRoutineOperationSettlementRow } from '../PluginMarketplaceSections';
import { PluginReadOnlySnapshotNotice } from '../PluginReadOnlySnapshotNotice';
import type { PluginMarketplaceCatalogEntry } from '../readPluginMarketplaceCatalog';
import { PluginListingAddsSection, PluginListingFacts } from './PluginListingFacts';
import { usePluginInstallOnMachines } from './PluginInstallOnMachines';
import { PluginProjectScopeItem } from '../detail/PluginProjectScopeItem';
import { PluginSetupSection } from '../detail/PluginSetupSection';

/**
 * A marketplace listing before install (lab PL4): identity, what it is for and what it adds; beside
 * it the one action — Install & Trust for the Machine named in the header, or Manage once installed —
 * then the facts and links.
 *
 * The listing is re-read from its exact source and pin on arrival, so a
 * reload or a deep link shows current truth, and Install acts under the same authority as a card.
 */
export const PluginListingScreen = React.memo(function PluginListingScreen(props: PluginListingRouteParams) {
    const isFocused = useIsFocused();
    const state = usePluginSettingsScreenState({ focused: isFocused, listing: props });
    return <PluginListingView {...props} state={state} presentation="page" listingRequested />;
});

/** The visible pane uses the same exact-listing operation owner as the page. */
export const PluginListingPane = React.memo(function PluginListingPane(props: PluginListingRouteParams) {
    const isFocused = useIsFocused();
    const state = usePluginSettingsScreenState({ focused: isFocused, listing: props });
    return <PluginListingView {...props} presentation="pane" state={state} listingRequested />;
});

/**
 * One listing, as its own page (`page`: breadcrumb, machine chip, re-read from its source on
 * arrival) or beside the Plugins collection (`pane`: the same exact-listing owner, without
 * narrowing the parent's Browse results or depending on a previously loaded row).
 */
export const PluginListingView = React.memo(function PluginListingView(props: Readonly<{
    sourceId: string;
    pluginId: string;
    itemId?: string;
    version?: string;
    state: PluginSettingsScreenState;
    presentation: 'page' | 'pane';
    /** The page has asked its source for this listing (a pane shows the page's loaded results). */
    listingRequested?: boolean;
}>) {
    const router = useRouter();
    const { theme } = useUnistyles();
    // The crumbs lead back within the host this listing is shown in (Settings or the app page).
    const host = usePluginsSurfaceHost();
    const styles = stylesheet;
    const { state } = props;
    const pane = props.presentation === 'pane';
    // Its own page is a wide page (an action column beside the published facts). The crumbs, the header and the
    // columns all stand on that one column, so the title block starts on the crumbs' and the sheets' edge.
    const pageMaxWidth = useLayoutMaxWidth('wide');
    const maxWidthStyle = React.useMemo(() => ({ maxWidth: pageMaxWidth }), [pageMaxWidth]);
    const noTarget = state.administrationTargetSelection.state.kind === 'unselected';
    // A machine that is chosen but cannot answer (offline, projection failed) is explained, with
    // its recovery, instead of an endless loading row. "Refreshing" is transient and stays loading.
    const notice = !noTarget && state.readOnlySnapshotNotice?.reason !== 'refreshing'
        ? state.readOnlySnapshotNotice
        : null;
    const listingRequested = pane || props.listingRequested === true;

    const entry = state.discoverEntries.find((candidate) => (
        candidate.id === props.pluginId && candidate.sourceId === props.sourceId
    )) ?? null;
    const installed = state.installedPluginById.has(props.pluginId);
    const title = entry?.title ?? props.pluginId;
    // Install's evaluated review opens here, where it was pressed; its outcome stays under the action.
    const approvalReview = useInPlaceApprovalReview(state.pluginActionApproval);
    // Installing on several Machines is its own combined review, opened only by the person's tap.
    const installOnMachines = usePluginInstallOnMachines(state, entry);
    const outcome = (
        <>
            {approvalReview.waiting ? (
                <ActionApprovalPendingNotice
                    testID="settings.plugins.listing.approvalWaiting"
                    message={t('approvals.waitingForYou')}
                    summary={state.pluginActionApproval.approvalSummary}
                    onOpenApproval={approvalReview.reopen}
                />
            ) : null}
            <PluginRoutineOperationSettlementRow settlement={state.routineOperationSettlement} scope="discover" />
        </>
    );

    const install = entry && !installed ? (
        <ListingInstall
            entry={entry}
            disabled={!state.canRunDiscoverActions || state.loadingDiscover || state.isPluginActionInFlight(entry.id)}
            pending={state.isPluginActionInFlight(entry.id)}
            targetMachine={state.administrationTargetLabel?.machine ?? null}
            onInstall={() => state.runCatalogAction({ method: 'install', pluginId: entry.id, sourceId: entry.sourceId })}
            onInstallOnMachines={installOnMachines.available ? installOnMachines.open : undefined}
            // The target is a row in the install block (lab scene 2, pane and page alike): the same Machine
            // selection the page chip owns.
            target={(
                <MachineAdministrationTargetSelector
                    presentation="value"
                    selection={state.administrationTargetSelection}
                    testIDPrefix="settings.plugins.listing.installOn"
                    groupTitle={t('settingsPlugins.surfaces.installOnTitle')}
                />
            )}
        />
    ) : null;
    // Once installed the listing reads as the installed plugin: what it still needs, then who can use it and the
    // way into its full management.
    const installedSetup = entry && installed ? (
        <>
            <PluginSetupSection
                pluginId={props.pluginId}
                title={title}
                host={host}
                projection={state.pluginProjectionV2}
                machineId={state.executionMachineId}
                serverId={state.executionServerId}
                testID="settings.plugins.listing.setup"
            />
            <ItemGroup>
                <PluginProjectScopeItem pluginId={props.pluginId} testID="settings.plugins.listing.projectScope" />
                <Item
                    testID="settings.plugins.listing.manage"
                    title={t('settingsPlugins.managePlugin')}
                    onPress={() => router.push(buildPluginDetailRoute(host, entry.id))}
                />
            </ItemGroup>
        </>
    ) : null;
    const installedStatus = entry && installed ? (
        // Outside a Collection, the app's inline status opens the plugin-ui scope it draws in.
        <InlineStatus testID="settings.plugins.listing.installedStatus" label={t('settingsPlugins.surfaces.installed')}
            tone="secondary" indicator={false} />
    ) : null;

    return (
        <ItemList style={{ paddingTop: 0 }} testID="settings.plugins.listing" {...(pane ? {} : { pageColumn: 'wide' as const })}>
            {pane ? null : <HappierBreadcrumb style={[styles.crumbs, maxWidthStyle]} accessibilityRole="toolbar"
                separator={<Icon name="caret-right" size={12} color={styles.crumbSeparator.color} />}
                colors={{ focus: theme.colors.border.focus, hover: theme.colors.surface.hover }}
                // Plugins › <name> (lab detail-page): back to Browse, then where you are.
                items={[
                    { key: 'browse', label: t('capabilities.store.kinds.plugin.title'), onPress: () => router.dismissTo(buildPluginsHomeRoute(host, { view: 'browse' })), testID: 'settings.plugins.listing.crumb.browse' },
                    { key: 'listing', label: title, testID: 'settings.plugins.listing.crumb.current' },
                ]}
                renderLabel={(item) => <Text style={styles.crumb}>{item.label}</Text>}
            />}
            <PageHeader
                testID="settings.plugins.listing.header"
                alwaysShowTitle
                title={title}
                // The name sits beside the mark on its title line; the purpose and facts start at the mark's edge
                // (lab detail-pane and detail-page alike).
                markSpan="title"
                leading={<PluginMark title={title} pluginId={props.pluginId} iconAgentId={state.pluginProjectionById[props.pluginId]?.iconAgentId ?? null} size="page"
                    installedPackage={state.pluginProjectionById[props.pluginId]?.installedPackage} machineId={state.executionMachineId} serverId={state.executionServerId} />}
                {...(entry?.description ? { description: entry.description } : {})}
                meta={entry ? [
                    ...(entry.publisher.displayName ? [{ key: 'publisher', text: entry.publisher.displayName }] : []),
                    ...(entry.version ? [{ key: 'version', text: formatCatalogEntryVersion(entry.version) ?? entry.version }] : []),
                    { key: 'source', text: entry.sourceTitle },
                    ...(entry.reviewStatus !== null ? [{ key: 'review', text: catalogReviewStatusLabel(entry), testID: 'settings.plugins.listing.reviewStatus' }] : []),
                ] : []}
                actions={pane ? installedStatus ?? undefined : (
                    <>
                        {installedStatus}
                        {/* Before install the target is the Install on row; once installed the header names it. */}
                        {installed ? <MachineAdministrationTargetSelector
                            presentation="chip"
                            selection={state.administrationTargetSelection}
                            testIDPrefix="settings.plugins.listing.target"
                            groupTitle={t('settingsPlugins.administrationMachineTitle')}
                        /> : null}
                    </>
                )}
            />
            {notice && !pane ? (
                <PluginReadOnlySnapshotNotice
                    testID="settings.plugins.listing.readOnlySnapshot"
                    reason={notice.reason}
                    onRetry={state.refreshPluginTruth}
                />
            ) : null}
            {entry && pane ? (
                // Beside the page: the one action right under the identity, then what it adds, then the facts.
                <>
                    {install}
                    {outcome}
                    {installedSetup}
                    <PluginListingAddsSection entry={entry} />
                    <PluginListingFacts entry={entry} />
                </>
            ) : entry ? (
                // Its own page: the action and what it adds lead; the published facts sit beside them.
                <ItemGroupColumns columns={3} minColumnWidthPx={260} columnGap={24} paddingHorizontal={0}
                    // On the header's column, so the action and facts share its edges.
                    style={[styles.pageColumns, maxWidthStyle]}>
                    <ItemGroupColumn span={2}>
                        {install}
                        {outcome}
                        {installedSetup}
                        <PluginListingAddsSection entry={entry} />
                    </ItemGroupColumn>
                    <ItemGroupColumn span={1}>
                        <PluginListingFacts entry={entry} />
                    </ItemGroupColumn>
                </ItemGroupColumns>
            ) : pane && state.loadingDiscover ? (
                <ItemGroup>
                    <Item testID="settings.plugins.listing.loading" title={t('common.loading')} loading mode="info" showChevron={false} />
                </ItemGroup>
            ) : pane ? (
                // Beside Browse the listing comes from the page's own results; when they no longer
                // carry it (a new search, another source), say so rather than wait for it.
                <SurfaceStateCard
                    testID="settings.plugins.listing.missing"
                    kind="unavailable"
                    title={t('settingsPlugins.surfaces.listingNotFoundTitle')}
                    reason={t('settingsPlugins.surfaces.listingNotFoundBody')}
                    action={{ label: t('settingsPlugins.catalog.browse'),
                        onPress: () => router.dismissTo(buildPluginsHomeRoute(host, { view: 'browse', sourceId: props.sourceId })) }}
                />
            ) : state.loadingDiscover || !listingRequested ? (
                <ItemGroup>
                    <Item testID="settings.plugins.listing.loading" title={t('common.loading')} loading mode="info" showChevron={false} />
                </ItemGroup>
            ) : (
                <SurfaceStateCard
                    testID="settings.plugins.listing.missing"
                    kind="unavailable"
                    title={t('settingsPlugins.surfaces.listingNotFoundTitle')}
                    reason={t('settingsPlugins.surfaces.listingNotFoundBody')}
                    action={{
                        label: state.unresolvedListing ? t('settingsPlugins.catalog.browse') : t('common.retry'),
                        onPress: state.unresolvedListing
                            ? () => router.dismissTo(buildPluginsHomeRoute(host, { view: 'browse', sourceId: props.sourceId }))
                            : state.refreshDiscover,
                    }}
                />
            )}
        </ItemList>
    );
});

/**
 * Install, before the plugin is on the machine (lab ideas-1118-platform scene 2): one line saying where it goes and
 * that pressing Install & Trust is the consent, then the quiet "several machines" door on the left and the one
 * primary action on the right edge. No card: it is the page's lead action, not a separate object.
 */
function ListingInstall(props: Readonly<{
    entry: PluginMarketplaceCatalogEntry;
    disabled: boolean;
    /** The press is in flight: the button says what is happening, not only that it is unavailable. */
    pending: boolean;
    targetMachine: string | null;
    onInstall: () => void;
    /** Present when the plugin can go to several of the person's Machines at once. */
    onInstallOnMachines?: () => void;
    /** The Machine control, as a row with its compact value, where the page header's chip is not in reach. */
    target?: React.ReactNode;
}>) {
    const styles = stylesheet;
    const { entry } = props;
    if (!entry.installable) return null;
    return (
        <>
        {props.target ? (
            <ItemGroup>
                {/* The machine name is never cut: on a row too narrow for both, the value moves beneath its label. */}
                <Item testID="settings.plugins.listing.installOn" title={t('settingsPlugins.surfaces.installOnTitle')}
                    rightElement={props.target} accessoryLayout="adaptive" showChevron={false} mode="info" />
            </ItemGroup>
        ) : null}
        <View style={styles.install}>
            <Text style={styles.installNote}>
                {props.targetMachine
                    ? t('settingsPlugins.surfaces.listingInstallsOn', { machine: props.targetMachine })
                    : t('settingsPlugins.surfaces.listingChooseMachine')}
            </Text>
            {entry.registrySelectionOrigin !== null ? (
                <Text testID="settings.plugins.listing.registrySelection" style={styles.installNote}>
                    {t('settingsPlugins.discover.registrySelectionRequired', { origin: entry.registrySelectionOrigin })}
                </Text>
            ) : null}
            <View style={styles.installRow}>
                {props.onInstallOnMachines ? (
                    <TextLinkButton testID="settings.plugins.listing.installOnMachines" size="meta"
                        label={t('settingsPlugins.installOnMachines')} disabled={props.disabled} onPress={props.onInstallOnMachines} />
                ) : <View />}
                <RoundButton size="normal" titleNumberOfLines="complete"
                    testID="settings.plugins.listing.install"
                    title={props.pending && props.targetMachine
                        ? t('settingsPlugins.surfaces.installingOn', { machine: props.targetMachine })
                        : t('settingsPlugins.installAndTrust')}
                    disabled={props.disabled}
                    onPress={props.onInstall} />
            </View>
        </View>
        </>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    // On the page header's text edge, so the trail reads as part of the header.
    crumbs: {
        width: '100%',
        alignSelf: 'center',
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s6,
        paddingHorizontal: PAGE_LIST_METRICS.pageTextInsetPx,
        paddingTop: theme.space.s20,
        marginBottom: -16,
        // The header below is pulled up under this row; keep the crumbs above it so they stay pressable.
        zIndex: 1,
    },
    crumb: {
        ...Typography.variant('body'),
        color: theme.colors.text.secondary,
    },
    crumbSeparator: {
        color: theme.colors.text.tertiary,
    },
    pageColumns: {
        width: '100%',
        alignSelf: 'center',
    },
    // On the section edge, so the note and the button line up with the sheets below.
    install: {
        paddingHorizontal: PAGE_LIST_METRICS.pageTextInsetPx,
        paddingTop: theme.space.s8,
        paddingBottom: theme.space.s8,
        gap: theme.space.s12,
    },
    installRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: theme.space.s12,
    },
    installNote: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
    },
}));
