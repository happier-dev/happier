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
import { SurfaceCard } from '@/components/ui/cards/SurfaceCard';
import { Icon } from '@/components/ui/icons/Icon';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemGroupColumn, ItemGroupColumns } from '@/components/ui/lists/ItemGroupColumns';
import { ItemList } from '@/components/ui/lists/ItemList';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { useLayoutMaxWidthStyle } from '@/components/ui/layout/layout';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import { catalogReviewStatusLabel, formatCatalogEntryVersion } from '../model/pluginMarketplaceModel';
import { usePluginSettingsScreenState, type PluginSettingsScreenState } from '../model/usePluginSettingsScreenState';
import { buildPluginDetailRoute, buildPluginsHomeRoute, pluginsHomeTitleKey } from '../model/pluginsSurfaceRoutes';
import { usePluginsSurfaceHost } from '../model/usePluginsSurfaceHost';
import type { PluginListingRouteParams } from '../model/pluginsSurfaceRoutes';
import { PluginMark } from '../PluginMark';
import { PluginRoutineOperationSettlementRow } from '../PluginMarketplaceSections';
import { PluginReadOnlySnapshotNotice } from '../PluginReadOnlySnapshotNotice';
import type { PluginMarketplaceCatalogEntry } from '../readPluginMarketplaceCatalog';
import { PluginListingAddsSection, PluginListingFacts } from './PluginListingFacts';
import { usePluginInstallOnMachines } from './PluginInstallOnMachines';

/**
 * A marketplace listing before install (lab PL4): identity, what it is for and what it adds; beside
 * it the one action — Install & Trust on the machine named in the header, or Manage once installed —
 * then the facts and links. The install review that follows stays the security gate.
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
    const maxWidthStyle = useLayoutMaxWidthStyle();
    const { state } = props;
    const pane = props.presentation === 'pane';
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

    return (
        <ItemList style={{ paddingTop: 0 }} testID="settings.plugins.listing">
            {pane ? null : <HappierBreadcrumb style={[styles.crumbs, maxWidthStyle]} accessibilityRole="toolbar"
                separator={<Icon name="caret-right" size={12} color={styles.crumbSeparator.color} />}
                colors={{ focus: theme.colors.border.focus, hover: theme.colors.surface.hover }}
                items={[
                    { key: 'plugins', label: t(pluginsHomeTitleKey(host)), onPress: () => router.dismissTo(buildPluginsHomeRoute(host)), testID: 'settings.plugins.listing.crumb.plugins' },
                    { key: 'browse', label: t('settingsPlugins.catalog.browse'), onPress: () => router.dismissTo(buildPluginsHomeRoute(host, { view: 'browse' })), testID: 'settings.plugins.listing.crumb.browse' },
                ]}
                renderLabel={(item) => <Text style={styles.crumb}>{item.label}</Text>}
            />}
            <PageHeader
                testID="settings.plugins.listing.header"
                alwaysShowTitle
                title={title}
                leading={<PluginMark title={title} pluginId={props.pluginId} iconAgentId={state.pluginProjectionById[props.pluginId]?.iconAgentId ?? null} size="page"
                    installedPackage={state.pluginProjectionById[props.pluginId]?.installedPackage} machineId={state.executionMachineId} serverId={state.executionServerId} />}
                meta={entry ? [
                    { key: 'publisher', text: entry.publisher.displayName },
                    { key: 'review', text: catalogReviewStatusLabel(entry), testID: 'settings.plugins.listing.reviewStatus' },
                    ...(entry.version ? [{ key: 'version', text: formatCatalogEntryVersion(entry.version) ?? entry.version }] : []),
                ] : []}
                actions={pane ? undefined : (
                    <MachineAdministrationTargetSelector
                        presentation="chip"
                        selection={state.administrationTargetSelection}
                        testIDPrefix="settings.plugins.listing.target"
                        groupTitle={t('settingsPlugins.administrationMachineTitle')}
                    />
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
                // Beside the page: the install card comes right under the identity, then the rest.
                <>
                    <ListingActionCard
                        entry={entry}
                        installed={installed}
                        disabled={!state.canRunDiscoverActions || state.loadingDiscover || state.isPluginActionInFlight(entry.id)}
                        targetMachine={state.administrationTargetLabel?.machine ?? null}
                        onInstall={() => state.runCatalogAction({ method: 'install', pluginId: entry.id, sourceId: entry.sourceId })}
                        onInstallOnMachines={installOnMachines.available ? installOnMachines.open : undefined}
                        onManage={() => router.push(buildPluginDetailRoute(host, entry.id))}
                    />
                    {outcome}
                    {entry.description ? <Text style={styles.description}>{entry.description}</Text> : null}
                    <PluginListingAddsSection entry={entry} />
                    <PluginListingFacts entry={entry} />
                </>
            ) : entry ? (
                <ItemGroupColumns columns={3} minColumnWidthPx={260} columnGap={24} paddingHorizontal={0}>
                    <ItemGroupColumn span={2}>
                        {entry.description ? <Text style={styles.description}>{entry.description}</Text> : null}
                        <PluginListingAddsSection entry={entry} />
                    </ItemGroupColumn>
                    <ItemGroupColumn span={1}>
                        <ListingActionCard
                            entry={entry}
                            installed={installed}
                            disabled={!state.canRunDiscoverActions || state.loadingDiscover || state.isPluginActionInFlight(entry.id)}
                            targetMachine={state.administrationTargetLabel?.machine ?? null}
                            onInstall={() => state.runCatalogAction({ method: 'install', pluginId: entry.id, sourceId: entry.sourceId })}
                            onInstallOnMachines={installOnMachines.available ? installOnMachines.open : undefined}
                            onManage={() => router.push(buildPluginDetailRoute(host, entry.id))}
                        />
                        {outcome}
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

function ListingActionCard(props: Readonly<{
    entry: PluginMarketplaceCatalogEntry;
    installed: boolean;
    disabled: boolean;
    targetMachine: string | null;
    onInstall: () => void;
    /** Present when the plugin can go to several of the person's Machines at once. */
    onInstallOnMachines?: () => void;
    onManage: () => void;
}>) {
    const styles = stylesheet;
    const { entry } = props;
    if (!props.installed && !entry.installable) return null;
    return (
        <SurfaceCard padding="md" style={styles.actionCard}>
            <RoundButton size="normal" titleNumberOfLines="complete"
                testID={props.installed ? 'settings.plugins.listing.manage' : 'settings.plugins.listing.install'}
                title={props.installed ? t('settingsPlugins.managePlugin') : t('settingsPlugins.installAndTrust')}
                disabled={!props.installed && props.disabled}
                onPress={props.installed ? props.onManage : props.onInstall} />
            {props.installed ? (
                <StatusPill variant="success" labelVariant="phrase" label={t('settingsPlugins.surfaces.installed')} />
            ) : (
                <Text style={styles.actionNote}>
                    {props.targetMachine
                        ? t('settingsPlugins.surfaces.listingInstallsOn', { machine: props.targetMachine })
                        : t('settingsPlugins.surfaces.listingChooseMachine')}
                </Text>
            )}
            {!props.installed && props.onInstallOnMachines ? (
                <TextLinkButton testID="settings.plugins.listing.installOnMachines" size="meta"
                    label={t('settingsPlugins.installOnMachines')} disabled={props.disabled} onPress={props.onInstallOnMachines} />
            ) : null}
            {!props.installed && entry.registrySelectionOrigin !== null ? (
                <Text testID="settings.plugins.listing.registrySelection" style={styles.actionNote}>
                    {t('settingsPlugins.discover.registrySelectionRequired', { origin: entry.registrySelectionOrigin })}
                </Text>
            ) : null}
        </SurfaceCard>
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
    description: {
        ...Typography.variant('reading'),
        color: theme.colors.text.primary,
        paddingHorizontal: 18,
        paddingTop: theme.space.s8,
        paddingBottom: theme.space.s4,
    },
    actionCard: {
        marginTop: theme.space.s8,
        width: 'auto',
        marginHorizontal: theme.space.s16,
        gap: theme.space.s10,
    },
    actionNote: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
    },
}));
