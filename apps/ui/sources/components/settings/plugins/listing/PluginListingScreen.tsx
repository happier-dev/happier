import * as React from 'react';
import { useIsFocused } from '@/components/appShell/workspace/destinationRoute';
import { Platform, View } from 'react-native';
import { HappierBreadcrumb, joinHappierFacts } from '@happier-dev/plugin-ui/presentation';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';

import { MachineAdministrationTargetSelector } from '@/components/settings/machines/MachineAdministrationTargetSelector';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SurfaceCard } from '@/components/ui/cards/SurfaceCard';
import { Icon } from '@/components/ui/icons/Icon';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
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
import { Modal } from '@/modal';
import { t } from '@/text';
import { openExternalUrl } from '@/utils/url/openExternalUrl';

import { catalogReviewStatusLabel, formatCatalogEntryVersion } from '../model/pluginMarketplaceModel';
import { usePluginSettingsScreenState, type PluginSettingsScreenState } from '../model/usePluginSettingsScreenState';
import { buildPluginDetailRoute, buildPluginsHomeRoute, pluginsHomeTitleKey, usePluginsSurfaceHost } from '../model/pluginsSurfaceRoutes';
import { PluginMark } from '../PluginMark';
import { PluginReadOnlySnapshotNotice } from '../PluginReadOnlySnapshotNotice';
import type { PluginMarketplaceCatalogEntry } from '../readPluginMarketplaceCatalog';

function realmLabels(entry: PluginMarketplaceCatalogEntry): readonly string[] {
    return entry.executableRealms.map((realm) => {
        if (realm === 'daemon') return t('settingsPlugins.discover.executableRealm.daemon');
        if (realm === 'client') return t('settingsPlugins.discover.executableRealm.client');
        return t('settingsPlugins.discover.executableRealm.hostedWeb');
    });
}

function platformLabels(entry: PluginMarketplaceCatalogEntry): readonly string[] {
    return entry.platforms.map((platform) => {
        if (platform === 'darwin') return t('settingsPlugins.discover.platform.darwin');
        if (platform === 'linux') return t('settingsPlugins.discover.platform.linux');
        if (platform === 'windows') return t('settingsPlugins.discover.platform.windows');
        if (platform === 'web') return t('settingsPlugins.discover.platform.web');
        if (platform === 'ios') return t('settingsPlugins.discover.platform.ios');
        return t('settingsPlugins.discover.platform.android');
    });
}

/** A fact value from lower-case catalog fragments ("background service · app"). */
function describeCatalogFacts(values: readonly string[]): string {
    const joined = joinHappierFacts(...values);
    if (!joined) return t('settingsPlugins.installReviewSections.none');
    return joined.charAt(0).toLocaleUpperCase() + joined.slice(1);
}

/**
 * A marketplace listing before install (lab PL4): identity, what it is for and what it adds; beside
 * it the one action — Install & Trust on the machine named in the header, or Manage once installed —
 * then the facts and links. The install review that follows stays the security gate.
 *
 * The listing is re-read from its exact source through the one Discover query on arrival, so a
 * reload or a deep link shows current truth, and Install acts under the same authority as a card.
 */
export const PluginListingScreen = React.memo(function PluginListingScreen(props: Readonly<{
    sourceId: string;
    pluginId: string;
}>) {
    const isFocused = useIsFocused();
    const state = usePluginSettingsScreenState({ focused: isFocused });
    const targetKey = JSON.stringify([state.executionServerId, state.executionServerIdentityId, state.executionMachineId]);
    // The request this page last made; until it exists for the current target, the page is loading.
    const [requestedKey, setRequestedKey] = React.useState<string | null>(null);
    const requestKey = `${targetKey}|${props.sourceId}|${props.pluginId}`;
    const { openDiscoverListing } = state;
    // Declared after the state owner's own effects, so this request is made after the owner has
    // settled the machine scope for this mount; made earlier, the scope reset would drop it.
    React.useEffect(() => {
        if (!state.daemonOperationsAvailable || requestedKey === requestKey) return;
        setRequestedKey(requestKey);
        openDiscoverListing({ sourceId: props.sourceId, pluginId: props.pluginId });
    }, [openDiscoverListing, props.pluginId, props.sourceId, requestKey, requestedKey, state.daemonOperationsAvailable]);
    return (
        <PluginListingView
            sourceId={props.sourceId}
            pluginId={props.pluginId}
            state={state}
            presentation="page"
            listingRequested={requestedKey === requestKey}
        />
    );
});

/**
 * One listing, as its own page (`page`: breadcrumb, machine chip, re-read from its source on
 * arrival) or beside the Plugins Browse view (`pane`: the page's own results, chip and state — the
 * listing is already loaded there, and re-reading it would narrow the page's results to it).
 */
export const PluginListingView = React.memo(function PluginListingView(props: Readonly<{
    sourceId: string;
    pluginId: string;
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

    return (
        <ItemList style={{ paddingTop: 0 }} testID="settings.plugins.listing">
            {pane ? null : <HappierBreadcrumb style={[styles.crumbs, maxWidthStyle]} accessibilityRole="toolbar"
                separator={<Icon name="caret-right" size={12} color={styles.crumbSeparator.color} />}
                colors={{ focus: theme.colors.border.focus, hover: theme.colors.surface.pressed }}
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
                        onManage={() => router.push(buildPluginDetailRoute(host, entry.id))}
                    />
                    {entry.description ? <Text style={styles.description}>{entry.description}</Text> : null}
                    {entry.contributions.length > 0 ? (
                        <ItemGroup title={t('settingsPlugins.catalog.adds')}>
                            <Item title={entry.contributions.join(', ')} titleLines={0} mode="info" showChevron={false} />
                        </ItemGroup>
                    ) : null}
                    <ListingFacts entry={entry} />
                </>
            ) : entry ? (
                <ItemGroupColumns columns={3} minColumnWidthPx={260} columnGap={24} paddingHorizontal={0}>
                    <ItemGroupColumn span={2}>
                        {entry.description ? <Text style={styles.description}>{entry.description}</Text> : null}
                        {entry.contributions.length > 0 ? (
                            <ItemGroup title={t('settingsPlugins.catalog.adds')}>
                                <Item title={entry.contributions.join(', ')} titleLines={0} mode="info" showChevron={false} />
                            </ItemGroup>
                        ) : null}
                    </ItemGroupColumn>
                    <ItemGroupColumn span={1}>
                        <ListingActionCard
                            entry={entry}
                            installed={installed}
                            disabled={!state.canRunDiscoverActions || state.loadingDiscover || state.isPluginActionInFlight(entry.id)}
                            targetMachine={state.administrationTargetLabel?.machine ?? null}
                            onInstall={() => state.runCatalogAction({ method: 'install', pluginId: entry.id, sourceId: entry.sourceId })}
                            onManage={() => router.push(buildPluginDetailRoute(host, entry.id))}
                        />
                        <ListingFacts entry={entry} />
                    </ItemGroupColumn>
                </ItemGroupColumns>
            ) : pane ? (
                // Beside Browse the listing comes from the page's own results; when they no longer
                // carry it (a new search, another source), say so rather than wait for it.
                <SurfaceStateCard
                    testID="settings.plugins.listing.missing"
                    kind="unavailable"
                    title={t('settingsPlugins.surfaces.listingNotFoundTitle')}
                    reason={t('settingsPlugins.surfaces.listingNotFoundBody')}
                />
            ) : noTarget ? (
                <ItemGroup>
                    <Item testID="settings.plugins.listing.noTarget" title={t('settingsPlugins.surfaces.listingChooseMachine')} mode="info" showChevron={false} />
                </ItemGroup>
            ) : notice ? null : state.loadingDiscover || !listingRequested ? (
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
                        label: t('common.retry'),
                        onPress: () => state.openDiscoverListing({ sourceId: props.sourceId, pluginId: props.pluginId }),
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
    onManage: () => void;
}>) {
    const styles = stylesheet;
    const { entry } = props;
    if (!props.installed && !entry.installable) return null;
    return (
        <SurfaceCard padding="md" style={styles.actionCard}>
            <RoundButton size="normal" titleNumberOfLines="complete"
                style={{ minHeight: resolveMinimumInteractiveTargetSize(Platform.OS) }}
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
            {!props.installed && entry.registrySelectionOrigin !== null ? (
                <Text testID="settings.plugins.listing.registrySelection" style={styles.actionNote}>
                    {t('settingsPlugins.discover.registrySelectionRequired', { origin: entry.registrySelectionOrigin })}
                </Text>
            ) : null}
        </SurfaceCard>
    );
}

function ListingFacts(props: Readonly<{ entry: PluginMarketplaceCatalogEntry }>) {
    const { theme } = useUnistyles();
    const { entry } = props;
    const links = [
        { id: 'homepage', title: t('settingsPlugins.catalog.homepage'), url: entry.links.homepage },
        { id: 'repository', title: t('settingsPlugins.catalog.repository'), url: entry.links.repository },
        { id: 'support', title: t('settingsPlugins.catalog.support'), url: entry.links.support },
        { id: 'universal', title: t('settingsPlugins.catalog.pluginPage'), url: entry.links.universal },
    ].filter((link): link is typeof link & { url: string } => Boolean(link.url));
    return (
        <>
            <ItemGroup title={t('common.details')}>
                <Item title={t('settingsPlugins.surfaces.listingRunsIn')} detail={describeCatalogFacts(realmLabels(entry))} mode="info" showChevron={false} />
                <Item title={t('settingsPlugins.surfaces.listingPlatforms')} detail={describeCatalogFacts(platformLabels(entry))} mode="info" showChevron={false} />
                <Item title={t('settingsPlugins.surfaces.listingSource')} detail={entry.sourceTitle} mode="info" showChevron={false} />
                {entry.categories.length > 0 ? (
                    <Item title={t('settingsPlugins.surfaces.listingCategories')} detail={entry.categories.join(', ')} mode="info" showChevron={false} />
                ) : null}
            </ItemGroup>
            {links.length > 0 ? (
                <ItemGroup title={t('settingsPlugins.catalog.links')}>
                    {links.map((link) => <Item key={link.id} title={link.title}
                        testID={`settings.plugins.listing.link.${link.id}`}
                        rightElement={<Icon name="arrow-square-out" size={16} color={theme.colors.text.secondary} />}
                        showChevron={false}
                        onPress={async () => {
                            if (!await openExternalUrl(link.url)) Modal.alert(t('common.error'), t('common.requestFailed'));
                        }} />)}
                </ItemGroup>
            ) : null}
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
        gap: 6,
        paddingHorizontal: PAGE_LIST_METRICS.pageTextInsetPx,
        paddingTop: 20,
        marginBottom: -16,
        // The header below is pulled up under this row; keep the crumbs above it so they stay pressable.
        zIndex: 1,
    },
    crumb: {
        ...Typography.default(),
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.text.secondary,
    },
    crumbSeparator: {
        color: theme.colors.text.tertiary,
    },
    description: {
        ...Typography.default(),
        fontSize: 14.5,
        lineHeight: 22,
        color: theme.colors.text.primary,
        paddingHorizontal: 18,
        paddingTop: 8,
        paddingBottom: 4,
    },
    actionCard: {
        marginTop: 8,
        width: 'auto',
        marginHorizontal: 16,
        gap: 10,
    },
    actionNote: {
        ...Typography.default(),
        fontSize: 12.5,
        lineHeight: 18,
        color: theme.colors.text.secondary,
    },
}));
