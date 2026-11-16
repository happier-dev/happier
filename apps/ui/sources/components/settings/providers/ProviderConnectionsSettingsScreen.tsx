import * as React from 'react';
import type { ProviderDiscoveryCandidateV1 } from '@happier-dev/protocol/providers/detection/v1';
import { usePathname, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { ItemList } from '@/components/ui/lists/ItemList';
import { CollectionIndexRow } from '@/components/ui/lists/collection/CollectionIndexRow';
import { CollectionLandingState } from '@/components/ui/lists/collection/CollectionLandingState';
import { Typography } from '@/constants/Typography';
import {
    MachineAdministrationTargetSelector,
    presentMachineAdministrationTargetState,
} from '@/components/settings/machines/MachineAdministrationTargetSelector';
import { ProviderErrorItems } from '@/components/settings/providers/ProviderErrorItems';
import { SettingsCollectionPage } from '@/components/settings/shell/SettingsCollectionPage';
import { SettingAnchor, SettingSection, useSettingRevealRequested } from '@/components/settings/shell/SettingRow';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { PROVIDER_CONNECTION_COLLECTION_STATUS, PROVIDER_CONNECTION_STATUS_KEY, type ProviderConnectionPresentationStatus } from '@/providers/connection/presentation';
import { ProviderIcon } from '@/providers/connection/ProviderIcon';
import { useProviderSettingsTarget } from '@/providers/hooks/targetMachine';
import { useProviderConnections, type ProviderConnectionRefreshScope } from '@/providers/hooks/useProviderConnections';
import { useProviderCatalogCounts } from '@/providers/hooks/useProviderCatalogCounts';
import { t } from '@/text';
import { useNavigationFocusReturn } from '@/utils/navigation/useNavigationFocusReturn';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { TeamCredentialCatalogSettingsGroup } from '@/components/settings/teams/credentials/TeamCredentialCatalogSettingsGroup';
import { teamCredentialDetailPath } from '@/components/settings/teams/teamsRoutes';
import { useHomeTeamCredentialModelCatalog } from '@/hooks/teams/useHomeTeamCredentialModelCatalog';
import {
    ProviderFeatureAvailabilityNotice,
    useProviderFeatureAvailability,
} from './ProviderFeatureAvailability';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { openProviderAddModal } from './add/openProviderAddModal';
import { useProviderFoundContinuation } from './collection/useProviderFoundContinuation';
import { ProviderCollectionInvitation } from './collection/ProviderCollectionInvitation';
import { ProviderConnectShelf, ProviderSettingsHome } from './collection/ProviderSettingsHome';
import { PROVIDERS_SETTINGS } from './providersSettings';
import { useCollectionDraftTitle } from '@/components/ui/lists/collection/CollectionDraftTitle';
import {
    buildProviderCollection,
    filterProviderCollection,
    newProviderRoute,
    type ProviderCollectionConnectionRow,
    type ProviderCollectionFoundRow,
} from './collection/providerCollectionModel';
import { CollectionDraftRow, CollectionList, CollectionListGroupLabel, CollectionSkeletonRows, collectionListStyles } from '@/components/ui/lists/collection/CollectionList';
import { CollectionViewSwitch, type CollectionView } from '@/components/ui/lists/collection/CollectionViewSwitch';
import { HappierCollectionListMark } from '@happier-dev/plugin-ui/presentation';
import { CollectionStatusLine } from '@/components/ui/lists/collection/CollectionStatusGlyph';
import { useSettingsColumnFilter } from '@/components/settings/shell/useSettingsColumnFilter';
import { providerColumnAdapter, providerConnectionColumnFacts, providerFoundColumnFacts } from './collection/providerColumnAdapter';
import { useClaimProviderCollectionPane } from './ProviderSettingsLayout';

/** The collection offers a search field only once it no longer fits at a glance. */
const SEARCH_THRESHOLD = 8;
export const PROVIDERS_COLLECTION_ROUTE = '/settings/providers';
export const NEW_PROVIDER_ROUTE = '/settings/providers/new';

function candidatePort(candidate: ProviderDiscoveryCandidateV1): string {
    const endpoint = new URL(candidate.normalizedEndpointUrl);
    if (endpoint.port) return endpoint.port;
    return endpoint.protocol === 'https:' ? '443' : '80';
}

/** One status line; quiet about health unless something needs the user. */
function resolveConnectionRowSubtitle(row: ProviderCollectionConnectionRow): string {
    // A gateway is set up where its subscriptions live (its group says so once); it has no key or provenance of its own.
    if (row.gateway) return row.needsAccount ? t('settingsProvidersCollection.gateway.needsAccountStatus') : '';
    // Healthy is quiet: the connection's provenance and credential kind, never an untested status.
    return [row.provenance, row.keySaved ? t('settingsProviders.authoring.apiKey') : null].filter(Boolean).join(' · ');
}

/**
 * The Providers collection: the connections this Account has, augmented by
 * the local model servers found on a selected machine. `rail` is the narrow list beside a connection's
 * detail; `page` is the same list as the page where no rail shows. Selection comes from the route.
 */
export const ProviderConnectionsSettingsScreen = React.memo(function ProviderConnectionsSettingsScreen(props: Readonly<{
    variant?: 'rail' | 'page' | 'home';
    active?: boolean;
    selectedConnectionId?: string | null;
}>) {
    const variant = props.variant ?? 'page';
    const rail = variant === 'rail';
    const home = variant === 'home';
    const active = props.active ?? true;
    const router = useRouter();
    const pathname = usePathname().replace(/\/+$/, '');
    const { theme } = useUnistyles();
    const { enabled, presentation: availabilityPresentation } = useProviderFeatureAvailability();
    const localDiscoveryEnabled = useFeatureEnabled('providers.localDiscovery');
    const providerTarget = useProviderSettingsTarget();
    const { machineId, machineRows, accountServerId: serverId, accountAddressAvailable } = providerTarget;
    const teamCredentialResourcesEnabled = useFeatureEnabled('teams.credentialResources', {
        scopeKind: 'spawn',
        serverId: serverId ?? undefined,
    });
    const teamCredentialCatalog = useHomeTeamCredentialModelCatalog({
        serverId,
        machineId,
        enabled: active && accountAddressAvailable && teamCredentialResourcesEnabled,
    });
    const { data, error, machineError, loading, refresh, declarationContext } = useProviderConnections({
        enabled: enabled && accountAddressAvailable, active, machineId, serverId,
    });
    const catalogCounts = useProviderCatalogCounts(serverId, declarationContext);
    const captureNavigationFocusReturn = useNavigationFocusReturn({
        ready: active && pathname === PROVIDERS_COLLECTION_ROUTE
            && (!enabled || (!loading && (data !== null || error !== null || machineId === null))),
    });
    // Beside a detail, opening another item replaces the shown detail instead of stacking history.
    const besideDetail = rail && pathname.startsWith(`${PROVIDERS_COLLECTION_ROUTE}/`);
    const navigate = React.useCallback((href: string) => {
        const result = runGuardedNavigation(() => captureNavigationFocusReturn(() => {
            if (besideDetail) router.replace(href as never);
            else router.push(href as never);
        }));
        if (result !== true) fireAndForget(result, { tag: 'ProviderConnectionsSettingsScreen.navigate' });
    }, [besideDetail, captureNavigationFocusReturn, router]);
    const refreshConnections = React.useCallback(async (scope?: ProviderConnectionRefreshScope): Promise<void> => {
        await refresh(scope);
    }, [refresh]);
    const { mutation, selectionError: discoverySelectionError, connectDetectedCandidate, startLocalInstallation } = useProviderFoundContinuation({
        target: providerTarget, refresh: refreshConnections, navigate,
    });
    const [searchQuery, setSearchQuery] = React.useState('');
    // Search revealing a local-server setting opens the view that holds it.
    const localRevealRequested = useSettingRevealRequested([PROVIDERS_SETTINGS.settings.local]);
    const [railView, setRailView] = React.useState<CollectionView>(localRevealRequested ? 'found' : 'all');
    React.useEffect(() => { if (localRevealRequested) setRailView('found'); }, [localRevealRequested]);
    const heldCollection = React.useMemo(() => buildProviderCollection({
        data, query: '', localDiscoveryEnabled, catalogCounts, declarationContext,
    }), [catalogCounts, data, declarationContext, localDiscoveryEnabled]);
    const collection = React.useMemo(() => filterProviderCollection(heldCollection, searchQuery), [heldCollection, searchQuery]);
    const filterFacts = React.useMemo(() => [
        ...heldCollection.connections.map(row => providerConnectionColumnFacts(row, resolveConnectionRowSubtitle(row))),
        ...heldCollection.found.map(row => providerFoundColumnFacts(row, null)),
    ], [heldCollection]);
    const filterFields = React.useMemo(() => {
        const sourceNames = new Map<string, string>();
        for (const connection of data?.connections ?? []) {
            if (connection.contributionKey) sourceNames.set(connection.contributionKey, connection.providerName);
        }
        for (const row of heldCollection.found) {
            const source = row.kind === 'candidate' ? row.candidate : row.installation;
            sourceNames.set(source.contributionKey, source.providerName);
        }
        return {
            status: { label: t('sessionsList.filtersStatus'), icon: 'circle-half' as const,
                valueLabel: (value: string) => {
                    const key = PROVIDER_CONNECTION_STATUS_KEY[value as ProviderConnectionPresentationStatus];
                    return key ? t(key) : value;
                } },
            source: { label: t('sessionsList.filtersSource'), icon: 'cloud' as const, valueLabel: (value: string) => sourceNames.get(value) ?? value },
        };
    }, [heldCollection.found, data]);
    const filter = useSettingsColumnFilter({ column: 'providers', presented: active && !home,
        search: { value: searchQuery, set: setSearchQuery },
        testIDPrefix: 'settings-providers', adapter: providerColumnAdapter, fields: filterFields, facts: filterFacts });
    const shownConnections = React.useMemo(() => collection.connections.filter(row => filter.matches(row.connectionId)),
        [collection.connections, filter.matches]);
    const shownFound = React.useMemo(() => collection.found.filter(row => filter.matches(row.key)),
        [collection.found, filter.matches]);
    const searchable = collection.total > SEARCH_THRESHOLD || searchQuery.trim().length > 0;
    const noMatches = collection.total > 0 && shownConnections.length === 0 && shownFound.length === 0;
    const machineLabel = machineId
        ? machineRows.find((row) => row.target.machineId === machineId)?.displayName ?? null
        : null;
    const foundTitle = machineLabel
        ? t('settingsProvidersCollection.onMachine', { machine: machineLabel })
        : t('settingsProvidersCollection.foundOnThisMachine');

    const openTeamResource = React.useCallback((resource: Readonly<{ teamId: string; id: string }>) => {
        if (!serverId) return;
        const result = runGuardedNavigation(() => captureNavigationFocusReturn(() => {
            router.push(teamCredentialDetailPath({ serverId, teamId: resource.teamId }, resource.id) as never);
        }));
        if (result !== true) fireAndForget(result, { tag: 'ProviderConnectionsSettingsScreen.openTeamResource' });
    }, [captureNavigationFocusReturn, router, serverId]);

    const renderConnectionRow = (row: ProviderCollectionConnectionRow) => {
        const selected = row.connectionId === props.selectedConnectionId;
        const status = PROVIDER_CONNECTION_COLLECTION_STATUS[row.status];
        return (
            <Item
                rowRole="catalogRow"
                key={row.connectionId}
                testID={`settings-provider-connection:${row.connectionId}`}
                title={row.title}
                titleMeta={row.catalogCount === null ? undefined : t('settingsProvidersCollection.modelsSaved', row.catalogCount)}
                // A state other than healthy leads line 2 in words (lab t:providers), before the connection's provenance.
                subtitle={status ? <CollectionStatusLine status={status}
                    label={t(PROVIDER_CONNECTION_STATUS_KEY[row.status])}
                    description={resolveConnectionRowSubtitle(row)}
                    testID={`settings-provider-connection-status:${row.connectionId}`} /> : resolveConnectionRowSubtitle(row)}
                icon={(
                    <HappierCollectionListMark rowRole="catalogRow" dimmed={row.off}>
                        <ProviderIcon contributionKey={row.contributionKey} icon={row.icon} size={20} color={theme.colors.text.secondary} />
                    </HappierCollectionListMark>
                )}
                titleStyle={row.off ? collectionListStyles.dimmedTitle : undefined}
                selected={rail ? selected : undefined}
                accessibilityCurrent={rail && selected ? 'page' : undefined}
                density="compact"
                showChevron={false}
                pressableStyle={collectionListStyles.row}
                onPress={() => navigate(row.detailRoute)}
            />
        );
    };

    const renderFoundRow = (row: ProviderCollectionFoundRow) => {
        const pending = mutation.isPending(row.pendingKey);
        if (row.kind === 'candidate') {
            const candidate = row.candidate;
            const evidenceLabel = candidate.evidence.kind === 'attributed_listener'
                ? t('settingsProviders.local.detectedAtPort', { port: candidatePort(candidate) })
                : t('settingsProviders.local.possibleAtPort', { provider: candidate.providerName, port: candidatePort(candidate) });
            return (
                <Item
                    rowRole="catalogRow"
                    key={row.key}
                    testID={`settings-provider-found:${row.key}`}
                    title={row.title}
                    subtitle={evidenceLabel}
                    icon={<HappierCollectionListMark rowRole="catalogRow"><ProviderIcon contributionKey={candidate.contributionKey} icon={row.icon} size={20} color={theme.colors.text.secondary} /></HappierCollectionListMark>}
                    mode="info"
                    density="compact"
                    pressableStyle={collectionListStyles.row}
                    showChevron={false}
                    rightElement={pending ? <ActivitySpinner size="small" /> : (
                        <RoundButton
                            testID={`settings-provider-found-connect:${row.key}`}
                            size="small"
                            display="secondary"
                            title={t('settingsProvidersCollection.connect')}
                            accessibilityLabel={`${t('settingsProvidersCollection.connect')}: ${candidate.providerName}, ${candidate.normalizedEndpointUrl}`}
                            onPress={() => { void connectDetectedCandidate(candidate); }}
                        />
                    )}
                    rightElementOutsidePressable
                />
            );
        }
        const installation = row.installation;
        // Its state leads line 2 in words, as its found peers' evidence does; Start, when offered, is the row's action.
        const status = <CollectionStatusLine status="off"
            label={installation.status === 'app_running_server_off'
                ? t('settingsProviders.local.appRunningServerOff') : t('settingsProviders.local.installedNotRunning')}
            testID={`settings-provider-found-status:${row.key}`} />;
        return (
            <Item
                rowRole="catalogRow"
                key={row.key}
                testID={`settings-provider-found:${row.key}`}
                title={row.title}
                subtitle={status}
                icon={<HappierCollectionListMark><ProviderIcon contributionKey={installation.contributionKey} icon={row.icon} size={20} color={theme.colors.text.secondary} /></HappierCollectionListMark>}
                mode="info"
                density="compact"
                pressableStyle={collectionListStyles.row}
                showChevron={false}
                rightElement={installation.managedStartAvailable ? (
                    pending ? <ActivitySpinner size="small" /> : (
                        <RoundButton
                            testID={`settings-provider-found-start:${row.key}`}
                            size="small"
                            display="secondary"
                            title={t('settingsProvidersCollection.start')}
                            accessibilityLabel={t('settingsProviders.local.startManaged', { provider: installation.providerName })}
                            onPress={() => { void startLocalInstallation(installation); }}
                        />
                    )
                ) : undefined}
                rightElementOutsidePressable={installation.managedStartAvailable}
            />
        );
    };

    // A home row (lab `cr` crProv): mark · name · its key and models · On or Off, opening the provider.
    const renderHomeConnectionRow = (row: ProviderCollectionConnectionRow) => {
        const status = PROVIDER_CONNECTION_COLLECTION_STATUS[row.status];
        const facts = [
            resolveConnectionRowSubtitle(row) || null,
            row.catalogCount === null ? null : t('settingsProvidersCollection.modelsSaved', row.catalogCount),
        ].filter(Boolean).join(' · ');
        return (
            <Item
                key={row.connectionId}
                testID={`settings-provider-connection:${row.connectionId}`}
                title={row.title}
                // On or Off is the row's one trailing word; only trouble takes over the fact line, in words.
                subtitle={status && row.trouble ? <CollectionStatusLine status={status}
                    label={t(PROVIDER_CONNECTION_STATUS_KEY[row.status])}
                    description={facts}
                    testID={`settings-provider-connection-status:${row.connectionId}`} />
                    // A gateway with no account behind it needs the person: the amber sign-in voice, then its fix.
                    : row.needsAccount ? <CollectionStatusLine status="signIn"
                        label={t('common.off')}
                        description={t('settingsProvidersCollection.gateway.needsAccountStatus')}
                        testID={`settings-provider-connection-status:${row.connectionId}`} />
                    : facts || undefined}
                icon={<ProviderIcon contributionKey={row.contributionKey} icon={row.icon} size={20} color={theme.colors.text.secondary} />}
                detail={row.trouble || row.needsAccount ? undefined : row.off ? t('common.off') : t('common.on')}
                onPress={() => navigate(row.detailRoute)}
            />
        );
    };
    const homeProviders = shownConnections.filter(row => !row.gateway);
    const homeHasGateways = shownConnections.some(row => row.gateway);

    const failure = error || mutation.error || discoverySelectionError ? (() => {
        const providerFailure = mutation.error
            ? { error: mutation.error, retry: mutation.retry, reviewCurrentState: refreshConnections }
            : error
                ? { error, retry: refreshConnections }
                : { error: discoverySelectionError };
        return (
            <ProviderErrorItems
                size="line"
                error={providerFailure.error}
                retry={providerFailure.retry}
                reviewCurrentState={'reviewCurrentState' in providerFailure
                    ? providerFailure.reviewCurrentState
                    : undefined}
            />
        );
    })() : null;

    // A computer only adds what runs on it (local model servers); the list itself never waits for one.
    const notice = availabilityPresentation
        ? <ProviderFeatureAvailabilityNotice presentation={availabilityPresentation} />
        : null;
    const localScopeShown = (localDiscoveryEnabled || Boolean(machineError)) && !availabilityPresentation;
    const machineState = providerTarget.selection.state;
    const firstLoad = !availabilityPresentation && loading && !data;
    const empty = !availabilityPresentation && data !== null && collection.total === 0;
    // A revealed page owns its controls; populated homes retain the column's single filter owner.
    useClaimProviderCollectionPane(rail ? null : !home || Boolean(availabilityPresentation) || empty || (!data && Boolean(error) && !loading));
    const draftOpen = pathname === NEW_PROVIDER_ROUTE;
    const openAdd = () => { openProviderAddModal({ onAdd: navigate }); };
    const addMenu = (
        <SettingAnchor setting={PROVIDERS_SETTINGS.settings.add}>
            <SettingAnchor setting={PROVIDERS_SETTINGS.settings.custom}>
                <IconButton testID="settings-providers-add" iconName="plus" variant="plain"
                    accessibilityLabel={t('settingsProvidersCollection.addProvider')}
                    disabled={Boolean(availabilityPresentation)} onPress={openAdd} />
            </SettingAnchor>
        </SettingAnchor>
    );
    const search = {
        testID: 'settings-providers-search',
        value: searchQuery,
        onChangeText: setSearchQuery,
        placeholder: t('settingsProviders.searchPlaceholder'),
    };

    // Two views of one column (P8 `sfcols:provFound`): the providers you added, and the model servers found
    // on your machines, behind the shared view switch instead of a section mixed into the list.
    const foundViewAvailable = collection.found.length > 0 || localScopeShown || Boolean(machineError);
    const showFound = foundViewAvailable && railView === 'found';
    const shownCount = showFound ? shownFound.length : shownConnections.length;
    const filters = foundViewAvailable ? {
        targetCount: Math.max(collection.total, 1),
        content: (
            <CollectionViewSwitch
                view={showFound ? 'found' : 'all'}
                foundCount={collection.found.length}
                foundLabel={foundTitle}
                onChange={setRailView}
                testIDPrefix="settings-providers-view"
            />
        ),
    } : null;
    // The column's rows, one list for the rail and for a phone's page.
    const rows = showFound ? (
        <SettingAnchor setting={PROVIDERS_SETTINGS.settings.local}>
            <>
                {shownFound.map(renderFoundRow)}
                {machineError ? <ProviderErrorItems size="line" error={machineError} retry={refreshConnections} /> : null}
                {localScopeShown && machineState.kind !== 'online' ? (
                    <ProviderRailLocalScope selection={providerTarget.selection} first />
                ) : null}
                {failure}
            </>
        </SettingAnchor>
    ) : (
        <>
            {draftOpen ? <ProviderDraftRow /> : null}
            {/* Beside the rail the detail pane says what is missing and leads to it; a phone's page says it here. */}
            {!rail && notice ? notice : null}
            {firstLoad ? <ProviderRailSkeleton /> : null}
            {empty && !draftOpen ? <Item mode="info" title={t('settingsProviders.emptyTitle')} /> : null}
            {noMatches ? <Item mode="info" title={t('settingsProviders.searchEmptyTitle')} /> : null}
            <SettingAnchor setting={PROVIDERS_SETTINGS.settings.connections}>
                <>{shownConnections.filter(row => !row.gateway).map(renderConnectionRow)}</>
            </SettingAnchor>
            {shownConnections.some(row => row.gateway) ? (
                <CollectionListGroupLabel
                    title={t('settingsProvidersCollection.gateway.railGroup')}
                    count={shownConnections.filter(row => row.gateway).length}
                    first={!draftOpen && shownConnections.every(row => row.gateway)}
                />
            ) : null}
            {shownConnections.filter(row => row.gateway).map(renderConnectionRow)}
            {!rail && shownConnections.some(row => row.gateway) ? (
                <Item
                    testID="settings-providers-gateway-note"
                    mode="info"
                    title={t('settingsProvidersCollection.gateway.managedFromConnectedServices')}
                    titleStyle={styles.railScopeText}
                    titleLines={0}
                    density="compact"
                    pressableStyle={collectionListStyles.row}
                    showChevron={false}
                />
            ) : null}
            <TeamCredentialCatalogSettingsGroup
                variant="rail"
                title={t('teams.credentials.providedByTeams')}
                sourceKind="provider"
                catalog={teamCredentialCatalog}
                onRetry={teamCredentialCatalog.reload}
                onOpen={openTeamResource}
            />
            {failure}
        </>
    );

    if (rail) {
        return (
            <CollectionList
                testID="settings-providers-screen"
                title={t('settingsProviders.title')}
                count={data ? shownCount : null}
                headerAction={collection.total > 0 && !searchable ? <>{filter.filterButton}{addMenu}</> : addMenu}
                strip={filter.tokenRow}
                search={searchable ? { ...search, trailing: filter.filterButton, anchorRef: filter.searchAnchorRef } : null}
                filters={filters}
            >
                <CollectionIndexRow testID="settings-providers-all"
                    selected={pathname === PROVIDERS_COLLECTION_ROUTE}
                    onPress={() => { setRailView('all'); navigate('/(app)/settings/providers'); }} />
                {rows}
                {filter.editorOverlay}
            </CollectionList>
        );
    }

    if (home && firstLoad) return <CollectionLandingState testID="settings-providers-loading" kind="loading" title={t('common.loading')} />;

    // Nothing to list: the same invitation as beside the rail (lab PI1p), owning the page.
    if (empty) {
        return (
            <ItemList testID="settings-providers-screen" containerStyle={styles.centeredPane}>
                <SettingSection section={PROVIDERS_SETTINGS.sectionRefs.connections}
                    answersFor={[PROVIDERS_SETTINGS.sectionRefs.local]}>
                    <ProviderCollectionInvitation available={data?.available ?? []} onAdd={openAdd} />
                </SettingSection>
                <TeamCredentialCatalogSettingsGroup
                    title={t('teams.credentials.providedByTeams')}
                    sourceKind="provider"
                    catalog={teamCredentialCatalog}
                    onRetry={teamCredentialCatalog.reload}
                    onOpen={openTeamResource}
                />
                {failure ? <ItemGroup>{failure}</ItemGroup> : null}
            </ItemList>
        );
    }

    // Beside the column, the root is a home (lab t:providers, S30 §6.2): purpose, the page's Add, the existing
    // connected/found sections and the providers to connect. A notice or a failure keeps the page below.
    if (home && data && !notice && !failure) {
        return (
            <ProviderSettingsHome
                available={data.available}
                targetChip={localScopeShown ? (
                    <MachineAdministrationTargetSelector
                        selection={providerTarget.selection}
                        presentation="chip"
                        testIDPrefix="settings.providers.administration.target"
                    />
                ) : null}
                onAdd={openAdd}
                onConnect={(contributionKey) => navigate(newProviderRoute(contributionKey))}
            >
                <SettingSection section={PROVIDERS_SETTINGS.sectionRefs.connections}
                    answersFor={[PROVIDERS_SETTINGS.sectionRefs.local]}>
                    {/* The overview (lab crProv-home): each provider with its state, then gateways, then what Teams share. */}
                    {homeProviders.length > 0 ? (
                        <ItemGroup
                            testID="settings-providers-home.providers"
                            title={t('settingsProviders.configuredTitle')}
                            description={t('settingsProviders.configuredFooter')}
                        >
                            {homeProviders.map(renderHomeConnectionRow)}
                        </ItemGroup>
                    ) : null}
                </SettingSection>
                {homeHasGateways ? (
                    <ItemGroup
                        testID="settings-providers-home.gateways"
                        title={t('settingsProvidersCollection.gateway.railGroup')}
                        description={t('settingsProvidersCollection.gatewaysDescription')}
                        // Gateways are set up where their accounts live: the section leads there, once.
                        action={(
                            <SectionActionButton
                                testID="settings-providers-home.gateways.credentials"
                                destination
                                title={t('settingsProvidersCollection.openCredentials')}
                                onPress={() => navigate('/(app)/settings/connected-services')}
                            />
                        )}
                    >
                        {/* The column names them; here each says its state and what it needs (lab crProv-home). */}
                        {shownConnections.filter(row => row.gateway).map(renderHomeConnectionRow)}
                    </ItemGroup>
                ) : null}
                <TeamCredentialCatalogSettingsGroup
                    title={t('teams.credentials.providedByTeams')}
                    sourceKind="provider"
                    catalog={teamCredentialCatalog}
                    onRetry={teamCredentialCatalog.reload}
                    onOpen={openTeamResource}
                />
            </ProviderSettingsHome>
        );
    }

    // Standalone, the collection is a Settings page (R6, phone-system lab p4 provA): the page's tools, then each
    // provider as a row of its section's sheet, as on the home beside the rail. The machine chip says which machine
    // "On machines" reads, so it stays reachable where no rail shows. The found view keeps the column's rows.
    const pageSections = showFound ? rows : (
        <>
            {draftOpen ? <ProviderDraftRow /> : null}
            {notice}
            {firstLoad ? <ProviderRailSkeleton /> : null}
            {noMatches ? <Item mode="info" title={t('settingsProviders.searchEmptyTitle')} /> : null}
            {homeProviders.length > 0 ? (
                <SettingAnchor setting={PROVIDERS_SETTINGS.settings.connections}>
                    <ItemGroup testID="settings-providers-page.providers" title={t('settingsProviders.configuredTitle')}>
                        {homeProviders.map(renderHomeConnectionRow)}
                    </ItemGroup>
                </SettingAnchor>
            ) : null}
            {homeHasGateways ? (
                <ItemGroup
                    testID="settings-providers-page.gateways"
                    title={t('settingsProvidersCollection.gateway.railGroup')}
                    description={t('settingsProvidersCollection.gateway.managedFromConnectedServices')}
                >
                    {shownConnections.filter(row => row.gateway).map(renderHomeConnectionRow)}
                </ItemGroup>
            ) : null}
            <TeamCredentialCatalogSettingsGroup
                title={t('teams.credentials.providedByTeams')}
                sourceKind="provider"
                catalog={teamCredentialCatalog}
                onRetry={teamCredentialCatalog.reload}
                onOpen={openTeamResource}
            />
            {failure}
        </>
    );
    return (
        <SettingsCollectionPage
            testID="settings-providers-page"
            headerTestID="settings-providers-header"
            count={data ? shownCount : null}
            actions={(
                <View style={styles.headerActions}>
                    {localScopeShown ? (
                        <MachineAdministrationTargetSelector
                            selection={providerTarget.selection}
                            presentation="chip"
                            testIDPrefix="settings.providers.administration.target"
                        />
                    ) : null}
                    {!home && collection.total > 0 && !searchable ? filter.filterButton : null}
                    {addMenu}
                </View>
            )}
        >
            <SettingSection section={PROVIDERS_SETTINGS.sectionRefs.connections}
                answersFor={[PROVIDERS_SETTINGS.sectionRefs.local]}>
                <CollectionList
                    testID="settings-providers-screen"
                    strip={home ? null : filter.tokenRow}
                    search={!home && searchable ? { ...search, trailing: filter.filterButton, anchorRef: filter.searchAnchorRef } : null}
                    filters={filters}
                    scrollContent={<>{pageSections}{home ? null : filter.editorOverlay}</>}
                />
            </SettingSection>
            {/* Where no home stands beside a rail, the page still invites the providers to connect (lab tp:providers). */}
            {data && data.available.length > 0 && !showFound && !noMatches ? (
                <ProviderConnectShelf
                    available={data.available}
                    onAdd={openAdd}
                    onConnect={(contributionKey) => navigate(newProviderRoute(contributionKey))}
                />
            ) : null}
        </SettingsCollectionPage>
    );
});

/** "On MacBook Pro" for the chosen computer, whatever its state; "On a computer" before one is chosen. */
function presentLocalScopeTitle(state: ReturnType<typeof useProviderSettingsTarget>['selection']['state']): string {
    return state.kind === 'unselected'
        ? t('settingsProvidersCollection.onAComputerTitle')
        : t('settingsProvidersCollection.onMachine', { machine: presentMachineAdministrationTargetState(state).title });
}

/**
 * The rail's local-servers group when no online machine can be asked: what a machine is needed
 * for, or that the chosen one is offline. It is a summary only: the rail always sits beside a
 * detail whose "On this machine" section carries the one machine control for this page (both
 * read and write the same Providers target selection).
 */
const ProviderRailLocalScope = React.memo(function ProviderRailLocalScope(props: Readonly<{
    selection: ReturnType<typeof useProviderSettingsTarget>['selection'];
    first: boolean;
}>) {
    const state = props.selection.state;
    const sentence = state.kind === 'unselected'
        ? t('settingsProvidersCollection.localNoComputer')
        : state.kind === 'offline'
            ? `${t('settingsMachines.scopeOffline', { machine: presentMachineAdministrationTargetState(state).title })} ${t('settingsProvidersCollection.localOfflineDetail')}`
            : [presentMachineAdministrationTargetState(state).title, presentMachineAdministrationTargetState(state).detail].filter(Boolean).join(' · ');
    return (
        <>
            <CollectionListGroupLabel title={presentLocalScopeTitle(state)} first={props.first} />
            <Item
                testID="settings-providers-local-scope"
                mode="info"
                title={sentence}
                titleStyle={styles.railScopeText}
                titleLines={0}
                density="compact"
                pressableStyle={collectionListStyles.row}
                showChevron={false}
            />
        </>
    );
});

/** The provider being added in the detail pane, at the top of the rail, titled as it is typed. */
const ProviderDraftRow = React.memo(function ProviderDraftRow() {
    const providerDraftTitle = useCollectionDraftTitle();
    const { theme } = useUnistyles();
    return (
        <CollectionDraftRow
            rowRole="item"
            testID="settings-providers-draft"
            titles={providerDraftTitle}
            placeholder={t('settingsProvidersCollection.newTitle')}
            mark={<HappierCollectionListMark><ProviderIcon icon={null} size={20} color={theme.colors.text.secondary} /></HappierCollectionListMark>}
        />
    );
});

/** First load: rows the size of the real ones, so nothing moves when they arrive. */
function ProviderRailSkeleton() {
    return (
        <View testID="settings-providers-skeleton">
            <CollectionSkeletonRows count={3} rowRole="catalogRow" />
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    centeredPane: {
        flexGrow: 1,
        justifyContent: 'center',
    },
    headerActions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s4,
    },
    railScopeText: {
        ...Typography.default(),
        color: theme.colors.text.secondary,
    },
}));
