import * as React from 'react';
import { createProviderErrorV1, type ProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import type { ProviderDiscoveryCandidateV1 } from '@happier-dev/protocol/providers/detection/v1';
import { usePathname, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { ShimmerView } from '@/components/ui/feedback/ShimmerView';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Icon } from '@/components/ui/icons/Icon';
import { CompactSearchField } from '@/components/ui/forms/CompactSearchField';
import { MachineAdministrationTargetSelector } from '@/components/settings/machines/MachineAdministrationTargetSelector';
import { ProviderErrorItems } from '@/components/settings/providers/ProviderErrorItems';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { randomUUID } from '@/platform/randomUUID';
import { PROVIDER_CONNECTION_STATUS_KEY } from '@/providers/connection/presentation';
import { ProviderIcon } from '@/providers/connection/ProviderIcon';
import { useProviderSettingsTarget } from '@/providers/hooks/targetMachine';
import { useProviderConnectionMutation } from '@/providers/hooks/useProviderConnectionMutation';
import { useProviderConnections } from '@/providers/hooks/useProviderConnections';
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
import { AddProviderMenu, newProviderRoute } from './collection/AddProviderMenu';
import { providerDraftTitle } from './collection/providerDraftTitle';
import {
    buildProviderCollection,
    type ProviderCollectionConnectionRow,
    type ProviderCollectionFoundRow,
} from './collection/providerCollectionModel';
import { CollectionDraftRow, CollectionList, CollectionListGroupLabel, collectionListStyles } from '@/components/ui/lists/collection/CollectionList';
import { HappierCollectionListMark } from '@happier-dev/plugin-ui/presentation';

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
    if (row.trouble || row.off) return t(PROVIDER_CONNECTION_STATUS_KEY[row.status]);
    const modelCount = row.modelCount === null ? null : t('settingsProviders.detail.modelCount', { count: row.modelCount });
    return [row.provenance, modelCount].filter(Boolean).join(' · ') || t(PROVIDER_CONNECTION_STATUS_KEY[row.status]);
}

/**
 * The Providers collection, read from the managed machine: the connections this Account has, then
 * the local model servers found on the machine. `rail` is the narrow list beside a connection's
 * detail; `page` is the same list as the page where no rail shows. Selection comes from the route.
 */
export const ProviderConnectionsSettingsScreen = React.memo(function ProviderConnectionsSettingsScreen(props: Readonly<{
    variant?: 'rail' | 'page';
    active?: boolean;
    selectedConnectionId?: string | null;
}>) {
    const variant = props.variant ?? 'page';
    const rail = variant === 'rail';
    const active = props.active ?? true;
    const router = useRouter();
    const pathname = usePathname().replace(/\/+$/, '');
    const { theme } = useUnistyles();
    const { enabled, presentation: availabilityPresentation } = useProviderFeatureAvailability();
    const localDiscoveryEnabled = useFeatureEnabled('providers.localDiscovery');
    const providerTarget = useProviderSettingsTarget();
    const { machineId, machineRows, resolveCurrentTarget, serverId } = providerTarget;
    const teamCredentialResourcesEnabled = useFeatureEnabled('teams.credentialResources', {
        scopeKind: 'spawn',
        serverId: serverId ?? undefined,
    });
    const teamCredentialCatalog = useHomeTeamCredentialModelCatalog({
        serverId,
        enabled: active && teamCredentialResourcesEnabled,
    });
    const { data, error, loading, refresh } = useProviderConnections({
        enabled, active, machineId, serverId,
    });
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
    const refreshConnections = React.useCallback(async (): Promise<void> => {
        await refresh();
    }, [refresh]);
    const mutation = useProviderConnectionMutation({ resolveTarget: resolveCurrentTarget, refresh: refreshConnections });
    const [searchQuery, setSearchQuery] = React.useState('');
    const [discoverySelectionError, setDiscoverySelectionError] = React.useState<ProviderErrorV1 | null>(null);
    const collection = React.useMemo(() => buildProviderCollection({
        data, query: searchQuery, localDiscoveryEnabled,
    }), [data, localDiscoveryEnabled, searchQuery]);
    const searchable = collection.total > SEARCH_THRESHOLD || searchQuery.trim().length > 0;
    const noMatches = collection.total > 0 && collection.connections.length === 0 && collection.found.length === 0;
    const machineLabel = machineId
        ? machineRows.find((row) => row.target.machineId === machineId)?.displayName ?? null
        : null;
    const foundTitle = machineLabel
        ? t('settingsProvidersCollection.foundOn', { machine: machineLabel })
        : t('settingsProvidersCollection.foundOnThisMachine');

    const connectDetectedCandidate = React.useCallback(async (candidate: ProviderDiscoveryCandidateV1) => {
        if (!machineId) return;
        setDiscoverySelectionError(null);
        const candidateId = candidate.candidateId;
        if (!candidateId) {
            setDiscoverySelectionError(createProviderErrorV1('provider_authorization_changed', {
                machineId,
                ...(candidate.connection.status === 'matched'
                    ? { connectionId: candidate.connection.connectionId }
                    : {}),
            }));
            return;
        }
        const openAuthoringDraft = (displayName: string | null) => {
            const params: Array<readonly [string, string]> = [
                ['candidateId', candidateId],
            ];
            if (displayName) params.push(['displayName', displayName]);
            const queryString = params
                .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
                .join('&');
            navigate(`${newProviderRoute(candidate.contributionKey)}&${queryString}`);
        };
        if (candidate.connection.status === 'requires_named_connection') {
            openAuthoringDraft(t('settingsProviders.local.defaultConnectionName', { provider: candidate.providerName }));
            return;
        }
        const connectionId = candidate.connection.status === 'matched'
            ? candidate.connection.connectionId
            : `pc_${randomUUID()}`;
        const result = await mutation.run({
            action: 'enableDetected', machineId, connectionId,
            candidateId,
            displayName: null,
            savedSecretId: null,
        }, `detected:${candidate.contributionKey}:${candidate.normalizedEndpointUrl}`);
        if (result?.status === 'error' && result.error.code === 'provider_secret_missing') {
            if (candidate.connection.status === 'matched') {
                navigate(`/(app)/settings/providers/${candidate.connection.connectionId}`);
            } else {
                openAuthoringDraft(null);
            }
            mutation.clearError();
        }
    }, [machineId, mutation, navigate]);

    const startLocalInstallation = React.useCallback(async (installation: Readonly<{
        contributionKey: string;
    }>) => {
        if (!machineId) return;
        await mutation.run({
            action: 'startLocal',
            machineId,
            connectionId: `pc_${randomUUID()}`,
            contributionKey: installation.contributionKey,
        }, `start:${installation.contributionKey}`);
    }, [machineId, mutation]);

    const openTeamResource = React.useCallback((resource: Readonly<{ teamId: string; id: string }>) => {
        if (!serverId) return;
        const result = runGuardedNavigation(() => captureNavigationFocusReturn(() => {
            router.push(teamCredentialDetailPath({ serverId, teamId: resource.teamId }, resource.id) as never);
        }));
        if (result !== true) fireAndForget(result, { tag: 'ProviderConnectionsSettingsScreen.openTeamResource' });
    }, [captureNavigationFocusReturn, router, serverId]);

    const renderConnectionRow = (row: ProviderCollectionConnectionRow) => {
        const selected = row.connectionId === props.selectedConnectionId;
        return (
            <Item
                key={row.connectionId}
                testID={`settings-provider-connection:${row.connectionId}`}
                title={row.title}
                subtitle={resolveConnectionRowSubtitle(row)}
                subtitleLeading={row.trouble ? (
                    <View testID={`settings-provider-connection-trouble:${row.connectionId}`} style={collectionListStyles.troubleDot} />
                ) : undefined}
                icon={(
                    <HappierCollectionListMark dimmed={row.off}>
                        <ProviderIcon icon={row.icon} size={20} color={theme.colors.text.secondary} />
                    </HappierCollectionListMark>
                )}
                titleStyle={row.off ? collectionListStyles.dimmedTitle : undefined}
                selected={rail ? selected : undefined}
                accessibilityCurrent={rail && selected ? 'page' : undefined}
                density={rail ? 'compact' : undefined}
                showChevron={!rail}
                pressableStyle={rail ? collectionListStyles.row : undefined}
                onPress={() => navigate(`/(app)/settings/providers/${row.connectionId}`)}
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
                    key={row.key}
                    testID={`settings-provider-found:${row.key}`}
                    title={row.title}
                    subtitle={evidenceLabel}
                    icon={<HappierCollectionListMark><Icon name="cpu" size={20} color={theme.colors.text.secondary} /></HappierCollectionListMark>}
                    mode="info"
                    density={rail ? 'compact' : undefined}
                    pressableStyle={rail ? collectionListStyles.row : undefined}
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
        return (
            <Item
                key={row.key}
                testID={`settings-provider-found:${row.key}`}
                title={row.title}
                subtitle={installation.status === 'app_running_server_off'
                    ? t('settingsProviders.local.appRunningServerOff')
                    : t('settingsProviders.local.installedNotRunning')}
                subtitleLeading={<View style={collectionListStyles.troubleDot} />}
                icon={<HappierCollectionListMark><Icon name="cpu" size={20} color={theme.colors.text.secondary} /></HappierCollectionListMark>}
                mode="info"
                density={rail ? 'compact' : undefined}
                pressableStyle={rail ? collectionListStyles.row : undefined}
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

    const failure = error || mutation.error || discoverySelectionError ? (() => {
        const providerFailure = mutation.error
            ? { error: mutation.error, retry: mutation.retry, reviewCurrentState: refreshConnections }
            : error
                ? { error, retry: refreshConnections }
                : { error: discoverySelectionError };
        return (
            <ProviderErrorItems
                error={providerFailure.error}
                retry={providerFailure.retry}
                reviewCurrentState={'reviewCurrentState' in providerFailure
                    ? providerFailure.reviewCurrentState
                    : undefined}
            />
        );
    })() : null;

    const notice = availabilityPresentation
        ? <ProviderFeatureAvailabilityNotice presentation={availabilityPresentation} />
        : !machineId
            ? <Item testID="settings-providers-no-machine" mode="info" title={t('settingsProviders.noMachine')} subtitle={t('settingsProviders.noMachineDescription')} subtitleLines={0} />
            : null;
    const firstLoad = !availabilityPresentation && machineId !== null && loading && !data;
    const empty = !availabilityPresentation && data !== null && collection.total === 0;
    const draftOpen = pathname === NEW_PROVIDER_ROUTE;
    const addMenu = (
        <AddProviderMenu
            available={data?.available ?? []}
            disabled={Boolean(availabilityPresentation) || machineId === null}
            onAdd={navigate}
        />
    );
    const search = {
        testID: 'settings-providers-search',
        value: searchQuery,
        onChangeText: setSearchQuery,
        placeholder: t('settingsProviders.searchPlaceholder'),
    };

    if (rail) {
        return (
            <CollectionList
                testID="settings-providers-screen"
                title={t('settingsProviders.title')}
                count={data ? collection.total : null}
                headerAction={addMenu}
                search={searchable ? search : null}
            >
                {draftOpen ? <ProviderDraftRow /> : null}
                {/* No notice here: beside the rail, the detail pane says what is missing and leads to it. */}
                {firstLoad ? <ProviderRailSkeleton /> : null}
                {empty && !draftOpen ? <Item mode="info" title={t('settingsProviders.emptyTitle')} /> : null}
                {noMatches ? <Item mode="info" title={t('settingsProviders.searchEmptyTitle')} /> : null}
                {collection.connections.map(renderConnectionRow)}
                {collection.found.length > 0 ? (
                    <CollectionListGroupLabel title={foundTitle} count={collection.found.length} first={collection.connections.length === 0} />
                ) : null}
                {collection.found.map(renderFoundRow)}
                <TeamCredentialCatalogSettingsGroup
                    variant="rail"
                    title={t('teams.credentials.providedByTeams')}
                    sourceKind="provider"
                    catalog={teamCredentialCatalog}
                    onRetry={teamCredentialCatalog.reload}
                    onOpen={openTeamResource}
                />
                {failure}
            </CollectionList>
        );
    }

    return (
        <ItemList testID="settings-providers-screen">
            <SettingsPageHeader
                testID="settings-providers-header"
                description={t('settingsProvidersCollection.description')}
                actions={(
                    <View style={styles.headerActions}>
                        <MachineAdministrationTargetSelector
                            selection={providerTarget.selection}
                            presentation="chip"
                            testIDPrefix="settings.providers.administration.target"
                        />
                        {addMenu}
                    </View>
                )}
            />
            {searchable ? (
                <CompactSearchField
                    testID={search.testID}
                    value={search.value}
                    onChangeText={search.onChangeText}
                    placeholder={search.placeholder}
                    placement="page"
                />
            ) : null}
            {notice ? <ItemGroup>{notice}</ItemGroup> : null}
            {firstLoad ? <ItemGroup><ProviderRailSkeleton /></ItemGroup> : null}
            {empty ? (
                <ItemGroup>
                    <Item mode="info" title={t('settingsProviders.emptyTitle')} subtitle={t('settingsProvidersCollection.emptyDescription')} subtitleLines={0} />
                </ItemGroup>
            ) : null}
            {noMatches ? <ItemGroup><Item mode="info" title={t('settingsProviders.searchEmptyTitle')} subtitle={t('settingsProviders.searchEmptyDescription')} /></ItemGroup> : null}
            {collection.connections.length > 0 ? (
                <ItemGroup
                    title={t('settingsProviders.configuredTitle')}
                    description={t('settingsProviders.configuredFooter')}
                >
                    {collection.connections.map(renderConnectionRow)}
                </ItemGroup>
            ) : null}
            {collection.found.length > 0 ? (
                <ItemGroup title={foundTitle} description={t('settingsProviders.local.footer')}>
                    {collection.found.map(renderFoundRow)}
                </ItemGroup>
            ) : null}
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
});

/** The provider being added in the detail pane, at the top of the rail, titled as it is typed. */
const ProviderDraftRow = React.memo(function ProviderDraftRow() {
    const { theme } = useUnistyles();
    return (
        <CollectionDraftRow
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
        <View testID="settings-providers-skeleton" style={styles.skeleton}>
            {[0, 1, 2].map((index) => (
                <ShimmerView key={index} style={styles.skeletonRow}>
                    <View style={styles.skeletonFill} />
                </ShimmerView>
            ))}
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    headerActions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
    },
    skeleton: {
        gap: 6,
        paddingHorizontal: 12,
        paddingVertical: 6,
    },
    skeletonRow: {
        borderRadius: 8,
    },
    skeletonFill: {
        height: 44,
        borderRadius: 8,
        backgroundColor: theme.colors.surface.elevated,
    },
}));
