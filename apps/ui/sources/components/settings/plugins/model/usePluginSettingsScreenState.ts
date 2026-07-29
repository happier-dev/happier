import * as React from 'react';

import { usePrimaryMachineFromActiveSelection } from '@/components/settings/server/hooks/usePrimaryMachineFromActiveSelection';
import {
    getMachineCapabilitiesCacheState,
    prefetchMachineCapabilities,
    useMachineCapabilitiesCache,
} from '@/hooks/server/useMachineCapabilitiesCache';
import { useMachineCapabilityInvokeWithAlerts } from '@/hooks/machine/useMachineCapabilityInvokeWithAlerts';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { getActiveServerId } from '@/sync/domains/server/serverProfiles';
import {
    machinePluginStructuredMessageActionExecute,
    publishMachineContributionRegistryProjectionInvalidation,
} from '@/sync/ops/machineContributionRegistryProjection';
import { machinePluginInstallDecision } from '@/sync/ops/machinePluginInstallDecision';
import { useEndpointStatus, useMachineCliDetectionTarget } from '@/sync/store/hooks';
import {
    machineMarketplaceSourceRegistryGet,
    machineMarketplaceSourceRegistrySet,
    machineMarketplaceIndexQuery,
    resolvePreferredMachineMarketplaceSource,
    upsertMachineMarketplaceSourceRegistrySource,
} from '@/sync/ops/machineMarketplaceSources';
import { type MarketplaceSourceRegistryV1 } from '@happier-dev/protocol';
import { t } from '@/text';
import { Modal } from '@/modal';

import { projectDaemonMarketplaceIndex, type PluginMarketplaceCatalog } from '../readPluginMarketplaceCatalog';
import { showPluginInstallationReviewDialog } from '../PluginInstallationReviewDialog';
import {
    MARKETPLACE_CAPABILITY_ID,
    readDevelopmentCreateAvailable,
    readDevelopmentPlugins,
    readInstalledPlugins,
    formatPluginInstallationReviewBody,
    isPluginMutationVisibleAfterRefresh,
    readPluginChangeKind,
    readPendingPluginChangeReview,
    resolvePluginMarketplaceErrorMessage,
    shouldShowPluginReadOnlySnapshotNotice,
    type DevelopmentPluginEntry,
    type InstalledPluginEntry,
    type PluginMarketplaceActionRequest,
    type PluginSettingsViewId,
} from './pluginMarketplaceModel';

type ConfirmedPluginChangeAction = 'update' | 'rollback' | 'uninstall' | 'forgetTrust';
type CommitIntendedPluginChangeAction = 'install' | ConfirmedPluginChangeAction;
type PluginActionCountsByAuthority = Readonly<Record<string, Readonly<Record<string, number>>>>;

function resolvePluginChangeActionLabel(action: ConfirmedPluginChangeAction): string {
    if (action === 'update') return t('common.update');
    if (action === 'rollback') return t('settingsPlugins.rollback');
    if (action === 'uninstall') return t('settingsPlugins.uninstall');
    return t('settingsPlugins.forgetTrust');
}

export type PluginSettingsScreenState = Readonly<{
    activeView: PluginSettingsViewId;
    currentDiagnostics: readonly { code: string; message: string }[];
    activeServerId: string;
    primaryMachineId: string | null;
    catalog: PluginMarketplaceCatalog | null;
    catalogError: string | null;
    catalogUrl: string;
    canLoadCatalog: boolean;
    canRunCatalogActions: boolean;
    canRefreshInstalledPlugins: boolean;
    daemonOperationsAvailable: boolean;
    developmentCreateAvailable: boolean;
    developmentPlugins: readonly DevelopmentPluginEntry[];
    installedPluginById: ReadonlyMap<string, InstalledPluginEntry>;
    installedPlugins: readonly InstalledPluginEntry[];
    isReadOnlySnapshot: boolean;
    isPluginActionInFlight: (pluginId: string) => boolean;
    loadCatalog: () => Promise<void>;
    loadedCatalogFooter: string;
    loadedCatalogTitle: string;
    loadingCatalog: boolean;
    marketplaceSourceRegistry: MarketplaceSourceRegistryV1 | null;
    pluginProjectionById: ReturnType<typeof useDaemonMergedProjectionInputs>['inputs'] extends infer TInputs
        ? TInputs extends { pluginProjectionById: infer TProjectionById }
            ? TProjectionById
            : Record<string, never>
        : Record<string, never>;
    registryDiagnostics: ReturnType<typeof useDaemonMergedProjectionInputs>['inputs'] extends infer TInputs
        ? TInputs extends { registryDiagnostics: infer TDiagnostics }
            ? TDiagnostics
            : readonly []
        : readonly [];
    resolvedCatalogUrl: string;
    runCatalogAction: (params: PluginMarketplaceActionRequest) => void;
    runDevelopmentCreate: (params: Readonly<{ targetDir: string; displayName: string; pluginId: string }>) => void;
    runDevelopmentAction: (action: 'test' | 'pack', pluginId: string) => void;
    runInstalledPluginAction: (action: 'enable' | 'disable' | 'rollback' | 'uninstall' | 'forgetTrust', pluginId: string) => void;
    runProjectedPluginAction: (pluginId: string, actionId: string) => void;
    setActiveView: (view: PluginSettingsViewId) => void;
    setCatalogUrl: (value: string) => void;
    setMarketplaceSourceProfile: (sourceId: string, profileId: string | null) => Promise<void>;
}>;

export function usePluginSettingsScreenState(): PluginSettingsScreenState {
    const primaryMachineId = usePrimaryMachineFromActiveSelection();
    const activeServerId = getActiveServerId();
    const { invokeWithAlerts } = useMachineCapabilityInvokeWithAlerts();
    const selectedMachineScopeKey = primaryMachineId ? `${activeServerId}:${primaryMachineId}` : null;
    const endpointStatus = useEndpointStatus();
    const machineCliDetectionTarget = useMachineCliDetectionTarget(primaryMachineId);
    const daemonTransportOnline = endpointStatus === 'online'
        && machineCliDetectionTarget.isOnline;
    const [daemonReconnectFreshness, setDaemonReconnectFreshness] = React.useState(() => ({
        scopeKey: selectedMachineScopeKey,
        isOnline: daemonTransportOnline,
        reconnectSequence: 0,
    }));
    if (
        daemonReconnectFreshness.scopeKey !== selectedMachineScopeKey
        || daemonReconnectFreshness.isOnline !== daemonTransportOnline
    ) {
        setDaemonReconnectFreshness({
            scopeKey: selectedMachineScopeKey,
            isOnline: daemonTransportOnline,
            reconnectSequence: daemonReconnectFreshness.scopeKey !== selectedMachineScopeKey
                ? 0
                : !daemonReconnectFreshness.isOnline && daemonTransportOnline
                    ? daemonReconnectFreshness.reconnectSequence + 1
                    : daemonReconnectFreshness.reconnectSequence,
        });
    }
    const daemonCacheFreshnessKey = `${machineCliDetectionTarget.daemonStateVersion}:${daemonReconnectFreshness.reconnectSequence}`;

    const [activeView, setActiveView] = React.useState<PluginSettingsViewId>('installed');
    const [catalogUrl, setCatalogUrlState] = React.useState('');
    const [catalog, setCatalog] = React.useState<PluginMarketplaceCatalog | null>(null);
    const [catalogAuthorityKey, setCatalogAuthorityKey] = React.useState<string | null>(null);
    const [loadingCatalog, setLoadingCatalog] = React.useState(false);
    const [catalogError, setCatalogError] = React.useState<string | null>(null);
    const [marketplaceSourceRegistry, setMarketplaceSourceRegistry] = React.useState<MarketplaceSourceRegistryV1 | null>(null);
    const [projectionRefreshKey, setProjectionRefreshKey] = React.useState(0);
    const [pluginActionCountByAuthority, setPluginActionCountByAuthority] = React.useState<PluginActionCountsByAuthority>({});
    const pluginActionCountByAuthorityRef = React.useRef<PluginActionCountsByAuthority>(
        pluginActionCountByAuthority,
    );

    const catalogRequestIdRef = React.useRef(0);
    const marketplaceSourceRegistryRequestIdRef = React.useRef(0);
    const catalogUrlTouchedRef = React.useRef(false);
    const lastSelectedMachineScopeKeyRef = React.useRef<string | null>(selectedMachineScopeKey);

    const capabilityRequest = React.useMemo(() => ({
        requests: [{ id: MARKETPLACE_CAPABILITY_ID }],
    }), []);

    const machineCapabilities = useMachineCapabilitiesCache({
        machineId: primaryMachineId ?? null,
        serverId: activeServerId,
        cacheKeySalt: daemonCacheFreshnessKey,
        enabled: Boolean(primaryMachineId) && daemonTransportOnline,
        request: capabilityRequest,
        timeoutMs: 12_000,
    });
    const daemonMergedProjection = useDaemonMergedProjectionInputs({
        machineId: primaryMachineId ?? null,
        serverId: activeServerId,
        enabled: Boolean(primaryMachineId) && daemonTransportOnline,
        refreshKey: `${projectionRefreshKey}:${daemonCacheFreshnessKey}`,
    });

    const hasCapabilitySnapshot = (
        machineCapabilities.state.status === 'loaded'
        || machineCapabilities.state.status === 'loading'
        || machineCapabilities.state.status === 'error'
    ) && machineCapabilities.state.snapshot !== undefined;
    const currentInstalledPlugins = React.useMemo(
        () => readInstalledPlugins(machineCapabilities.state),
        [machineCapabilities.state],
    );
    const lastKnownInstalledPluginsRef = React.useRef<Readonly<{
        scopeKey: string | null;
        installedPlugins: readonly InstalledPluginEntry[];
    }>>({ scopeKey: selectedMachineScopeKey, installedPlugins: currentInstalledPlugins });
    if (lastKnownInstalledPluginsRef.current.scopeKey !== selectedMachineScopeKey) {
        lastKnownInstalledPluginsRef.current = {
            scopeKey: selectedMachineScopeKey,
            installedPlugins: hasCapabilitySnapshot ? currentInstalledPlugins : [],
        };
    } else if (hasCapabilitySnapshot) {
        lastKnownInstalledPluginsRef.current = {
            scopeKey: selectedMachineScopeKey,
            installedPlugins: currentInstalledPlugins,
        };
    }
    const installedPlugins = hasCapabilitySnapshot
        ? currentInstalledPlugins
        : lastKnownInstalledPluginsRef.current.installedPlugins;
    const installedPluginById = React.useMemo(
        () => new Map(installedPlugins.map((entry) => [entry.pluginId, entry] as const)),
        [installedPlugins],
    );
    const installedPluginByIdRef = React.useRef(installedPluginById);
    installedPluginByIdRef.current = installedPluginById;
    const currentDevelopmentPlugins = React.useMemo(
        () => readDevelopmentPlugins(machineCapabilities.state, installedPlugins),
        [installedPlugins, machineCapabilities.state],
    );
    const lastKnownDevelopmentPluginsRef = React.useRef<Readonly<{
        scopeKey: string | null;
        developmentPlugins: readonly DevelopmentPluginEntry[];
    }>>({ scopeKey: selectedMachineScopeKey, developmentPlugins: currentDevelopmentPlugins });
    if (lastKnownDevelopmentPluginsRef.current.scopeKey !== selectedMachineScopeKey) {
        lastKnownDevelopmentPluginsRef.current = {
            scopeKey: selectedMachineScopeKey,
            developmentPlugins: hasCapabilitySnapshot ? currentDevelopmentPlugins : [],
        };
    } else if (hasCapabilitySnapshot) {
        lastKnownDevelopmentPluginsRef.current = {
            scopeKey: selectedMachineScopeKey,
            developmentPlugins: currentDevelopmentPlugins,
        };
    }
    const developmentPlugins = hasCapabilitySnapshot
        ? currentDevelopmentPlugins
        : lastKnownDevelopmentPluginsRef.current.developmentPlugins;
    const developmentCreateAvailable = readDevelopmentCreateAvailable(machineCapabilities.state);
    const currentDaemonCapabilitiesState = primaryMachineId
        ? getMachineCapabilitiesCacheState(
            primaryMachineId,
            activeServerId,
            daemonCacheFreshnessKey,
        )
        : null;
    const daemonOperationsAvailable = Boolean(primaryMachineId)
        && daemonTransportOnline
        && machineCapabilities.state.status === 'loaded'
        && currentDaemonCapabilitiesState === machineCapabilities.state
        && daemonMergedProjection.phase === 'ready';
    const mutationAuthorityKey = daemonOperationsAvailable && selectedMachineScopeKey
        ? `${selectedMachineScopeKey}:${daemonCacheFreshnessKey}`
        : null;
    const mutationAuthorityKeyRef = React.useRef(mutationAuthorityKey);
    mutationAuthorityKeyRef.current = mutationAuthorityKey;
    React.useEffect(() => {
        if (mutationAuthorityKey) return;
        catalogRequestIdRef.current += 1;
        setLoadingCatalog(false);
    }, [mutationAuthorityKey]);
    const lastKnownProjectionInputsRef = React.useRef<Readonly<{
        scopeKey: string | null;
        inputs: typeof daemonMergedProjection.inputs;
    }>>({ scopeKey: selectedMachineScopeKey, inputs: daemonMergedProjection.inputs });
    if (lastKnownProjectionInputsRef.current.scopeKey !== selectedMachineScopeKey) {
        lastKnownProjectionInputsRef.current = { scopeKey: selectedMachineScopeKey, inputs: null };
    } else if (daemonMergedProjection.inputs) {
        lastKnownProjectionInputsRef.current = {
            scopeKey: selectedMachineScopeKey,
            inputs: daemonMergedProjection.inputs,
        };
    }
    const projectionInputs = daemonMergedProjection.inputs ?? lastKnownProjectionInputsRef.current.inputs;
    const pluginProjectionById = projectionInputs?.pluginProjectionById ?? {};
    const registryDiagnostics = projectionInputs?.registryDiagnostics ?? [];
    const currentDiagnostics = React.useMemo(() => [
        ...registryDiagnostics,
        ...Object.values(pluginProjectionById).flatMap((plugin) => plugin.diagnostics),
    ], [pluginProjectionById, registryDiagnostics]);
    const isReadOnlySnapshot = shouldShowPluginReadOnlySnapshotNotice({
        daemonOperationsAvailable,
        hasCapabilitySnapshot,
        installedPluginCount: installedPlugins.length,
        developmentPluginCount: developmentPlugins.length,
        hasCatalog: catalog !== null,
        hasMarketplaceSourceRegistry: marketplaceSourceRegistry !== null,
        hasProjectionInputs: projectionInputs !== null,
    });
    const preferredMarketplaceSource = React.useMemo(() => {
        if (!marketplaceSourceRegistry) return null;
        return resolvePreferredMachineMarketplaceSource(marketplaceSourceRegistry);
    }, [marketplaceSourceRegistry]);
    const resolvedCatalogUrl = React.useMemo(() => {
        return catalogUrl.trim() || preferredMarketplaceSource?.sourceUrl?.trim() || '';
    }, [catalogUrl, preferredMarketplaceSource]);
    const selectedMarketplaceSource = React.useMemo(() => marketplaceSourceRegistry?.sources.find(
        (source) => source.enabled && source.sourceUrl.trim() === resolvedCatalogUrl,
    ) ?? null, [marketplaceSourceRegistry, resolvedCatalogUrl]);
    const canRefreshInstalledPlugins = daemonOperationsAvailable;
    const canRunCatalogActions = canRefreshInstalledPlugins
        && catalogAuthorityKey !== null
        && catalogAuthorityKey === mutationAuthorityKey;
    const canLoadCatalog = daemonOperationsAvailable && Boolean(selectedMarketplaceSource) && !loadingCatalog;
    const loadedCatalogTitle = catalog?.title ?? t('settingsPlugins.title');
    const loadedCatalogFooter = catalog?.description ?? t('settingsPlugins.emptySubtitle');

    React.useEffect(() => {
        if (lastSelectedMachineScopeKeyRef.current === selectedMachineScopeKey) {
            return;
        }

        lastSelectedMachineScopeKeyRef.current = selectedMachineScopeKey;
        marketplaceSourceRegistryRequestIdRef.current += 1;
        setMarketplaceSourceRegistry(null);
        if (!catalogUrlTouchedRef.current) {
            catalogRequestIdRef.current += 1;
            setLoadingCatalog(false);
            setCatalog(null);
            setCatalogAuthorityKey(null);
            setCatalogError(null);
            setCatalogUrlState('');
        }
    }, [selectedMachineScopeKey]);

    React.useEffect(() => {
        if (!daemonOperationsAvailable || !primaryMachineId) {
            marketplaceSourceRegistryRequestIdRef.current += 1;
            return;
        }

        const requestId = ++marketplaceSourceRegistryRequestIdRef.current;
        void (async () => {
            try {
                const nextRegistry = await machineMarketplaceSourceRegistryGet(primaryMachineId, {
                    serverId: activeServerId,
                });
                if (marketplaceSourceRegistryRequestIdRef.current !== requestId) return;
                setMarketplaceSourceRegistry(nextRegistry);
            } catch {
                if (marketplaceSourceRegistryRequestIdRef.current !== requestId) return;
                setMarketplaceSourceRegistry(null);
            }
        })();
    }, [activeServerId, daemonOperationsAvailable, primaryMachineId]);

    React.useEffect(() => {
        if (catalogUrlTouchedRef.current) return;
        if (!preferredMarketplaceSource?.sourceUrl) return;
        const nextUrl = preferredMarketplaceSource.sourceUrl.trim();
        if (!nextUrl || catalogUrl.trim() === nextUrl) return;
        setCatalogUrlState(nextUrl);
    }, [catalogUrl, preferredMarketplaceSource]);

    const setCatalogUrl = React.useCallback((value: string) => {
        catalogUrlTouchedRef.current = true;
        setCatalogUrlState(value);
    }, []);

    const setMarketplaceSourceProfile = React.useCallback(async (sourceId: string, profileId: string | null) => {
        if (
            !mutationAuthorityKey
            || mutationAuthorityKeyRef.current !== mutationAuthorityKey
            || !primaryMachineId
            || !marketplaceSourceRegistry
        ) {
            throw new Error('Marketplace source registry is unavailable');
        }
        const source = marketplaceSourceRegistry.sources.find((entry) => entry.id === sourceId) ?? null;
        if (!source) throw new Error('Marketplace source is unavailable');
        const next = upsertMachineMarketplaceSourceRegistrySource(marketplaceSourceRegistry, {
            sourceUrl: source.sourceUrl,
            title: source.title,
            description: source.description,
            enabled: source.enabled,
            origin: source.origin,
            registryProfileId: profileId,
        }).registry;
        const requestId = ++marketplaceSourceRegistryRequestIdRef.current;
        const saved = await machineMarketplaceSourceRegistrySet(primaryMachineId, next, { serverId: activeServerId });
        if (
            marketplaceSourceRegistryRequestIdRef.current !== requestId
            || mutationAuthorityKeyRef.current !== mutationAuthorityKey
        ) return;
        setMarketplaceSourceRegistry(saved);
    }, [activeServerId, marketplaceSourceRegistry, mutationAuthorityKey, primaryMachineId]);

    const markPluginActionStarted = React.useCallback((authorityKey: string, pluginId: string) => {
        const authorityCounts = pluginActionCountByAuthorityRef.current[authorityKey] ?? {};
        const next = {
            ...pluginActionCountByAuthorityRef.current,
            [authorityKey]: {
                ...authorityCounts,
                [pluginId]: (authorityCounts[pluginId] ?? 0) + 1,
            },
        };
        pluginActionCountByAuthorityRef.current = next;
        setPluginActionCountByAuthority(next);
    }, []);

    const markPluginActionFinished = React.useCallback((authorityKey: string, pluginId: string) => {
        const authorityCounts = pluginActionCountByAuthorityRef.current[authorityKey];
        if (!authorityCounts) return;
        const nextCount = (authorityCounts[pluginId] ?? 0) - 1;
        if (nextCount > 0) {
            const next = {
                ...pluginActionCountByAuthorityRef.current,
                [authorityKey]: {
                    ...authorityCounts,
                    [pluginId]: nextCount,
                },
            };
            pluginActionCountByAuthorityRef.current = next;
            setPluginActionCountByAuthority(next);
            return;
        }
        const nextAuthorityCounts = { ...authorityCounts };
        delete nextAuthorityCounts[pluginId];
        const nextCountsByAuthority = { ...pluginActionCountByAuthorityRef.current };
        if (Object.keys(nextAuthorityCounts).length === 0) {
            delete nextCountsByAuthority[authorityKey];
        } else {
            nextCountsByAuthority[authorityKey] = nextAuthorityCounts;
        }
        pluginActionCountByAuthorityRef.current = nextCountsByAuthority;
        setPluginActionCountByAuthority(nextCountsByAuthority);
    }, []);

    const isPluginActionInFlight = React.useCallback((pluginId: string) => {
        if (!mutationAuthorityKey) return false;
        return (pluginActionCountByAuthorityRef.current[mutationAuthorityKey]?.[pluginId] ?? 0) > 0;
    }, [mutationAuthorityKey, pluginActionCountByAuthority]);

    const runCatalogAction = React.useCallback((params: PluginMarketplaceActionRequest) => {
        if (
            !mutationAuthorityKey
            || mutationAuthorityKeyRef.current !== mutationAuthorityKey
            || !primaryMachineId
            || isPluginActionInFlight(params.pluginId)
        ) {
            return;
        }
        const installedBefore = installedPluginByIdRef.current.get(params.pluginId) ?? null;
        const catalogEntry = params.method === 'install' || params.method === 'update'
            ? catalog?.entries.find((entry) => (
                entry.id === params.pluginId && entry.sourceId === params.sourceId
            )) ?? null
            : null;
        if (
            params.method === 'rollback'
            && installedBefore?.rollbackAvailability !== 'available'
        ) {
            return;
        }
        if (params.method === 'install' || params.method === 'update') {
            const actionAvailable = params.method === 'install'
                ? catalogEntry?.installable === true && installedBefore === null
                : catalogEntry?.updateable === true
                    && installedBefore !== null
                    && catalogEntry.version !== null
                    && catalogEntry.version !== installedBefore.version;
            if (catalogAuthorityKey !== mutationAuthorityKey || !actionAvailable) {
                return;
            }
        }

        void (async () => {
            markPluginActionStarted(mutationAuthorityKey, params.pluginId);
            try {
                const commitAction: CommitIntendedPluginChangeAction | null = params.method === 'install'
                    || params.method === 'update'
                    || params.method === 'rollback'
                    || params.method === 'uninstall'
                    || params.method === 'forgetTrust'
                    ? params.method
                    : null;
                const showMutationFailure = (outcome: string) => {
                    if (!commitAction) return;
                    Modal.alert(
                        t('common.error'),
                        commitAction === 'install'
                            ? t('settingsPlugins.marketplaceInstallDecisionFailed', { outcome })
                            : t('settingsPlugins.marketplaceChangeDecisionFailed', {
                                action: resolvePluginChangeActionLabel(commitAction),
                                outcome,
                            }),
                    );
                };
                const publishPluginTruthRefresh = () => {
                    setProjectionRefreshKey((prev) => prev + 1);
                    publishMachineContributionRegistryProjectionInvalidation({
                        machineId: primaryMachineId,
                        serverId: activeServerId,
                    });
                };
                const reconcileAmbiguousMutation = async (targetVersion: string | null) => {
                    if (!commitAction) return;
                    try {
                        await prefetchMachineCapabilities({
                            machineId: primaryMachineId,
                            serverId: activeServerId,
                            cacheKeySalt: daemonCacheFreshnessKey,
                            request: {
                                ...capabilityRequest,
                                bypassCache: true,
                            },
                            timeoutMs: 12_000,
                        });
                    } catch {
                        if (mutationAuthorityKeyRef.current === mutationAuthorityKey) {
                            publishPluginTruthRefresh();
                            showMutationFailure('outcomeUnknown');
                        }
                        return;
                    }
                    if (mutationAuthorityKeyRef.current !== mutationAuthorityKey) return;

                    const refreshedState = getMachineCapabilitiesCacheState(
                        primaryMachineId,
                        activeServerId,
                        daemonCacheFreshnessKey,
                    );
                    publishPluginTruthRefresh();
                    if (refreshedState?.status !== 'loaded') {
                        showMutationFailure('outcomeUnknown');
                        return;
                    }
                    const installedAfter = readInstalledPlugins(refreshedState)
                        .find((entry) => entry.pluginId === params.pluginId) ?? null;
                    if (isPluginMutationVisibleAfterRefresh({
                        method: commitAction,
                        pluginId: params.pluginId,
                        before: installedBefore,
                        after: installedAfter,
                        targetVersion,
                    })) {
                        Modal.alert(t('common.success'), t('common.done'));
                    } else {
                        showMutationFailure('outcomeUnknown');
                    }
                };
                const response = await invokeWithAlerts({
                    machineId: primaryMachineId,
                    serverId: activeServerId,
                    request: {
                        id: MARKETPLACE_CAPABILITY_ID,
                        method: params.method,
                        params: {
                            pluginId: params.pluginId,
                            ...(params.sourceId ? { sourceId: params.sourceId } : {}),
                        },
                    },
                    timeoutMs: 5 * 60_000,
                    isAuthorityCurrent: () => mutationAuthorityKeyRef.current === mutationAuthorityKey,
                    alerts: {
                        errorTitle: t('common.error'),
                        successTitle: t('common.success'),
                        deferAmbiguousOutcomeToCaller: commitAction !== null,
                        unsupportedMessage: (reason) => reason === 'not-supported' ? t('common.unavailable') : t('common.requestFailed'),
                        successMessage: commitAction
                            ? null
                            : t('common.done'),
                    },
                });
                if (mutationAuthorityKeyRef.current !== mutationAuthorityKey) return;

                if (!('response' in response)) {
                    if (commitAction && response.reason === 'error') {
                        await reconcileAmbiguousMutation(catalogEntry?.version ?? null);
                    }
                    return;
                }
                if (!response.response.ok) {
                    if (commitAction && response.response.error.code === 'outcomeUnknown') {
                        await reconcileAmbiguousMutation(catalogEntry?.version ?? null);
                    }
                    return;
                }

                const pendingReview = params.method === 'install' || params.method === 'update'
                    ? readPendingPluginChangeReview(response.response.result, params.method, params.pluginId)
                    : null;
                if (pendingReview) {
                    const decisionResponse = await machinePluginInstallDecision(
                        primaryMachineId,
                        {
                            serverId: activeServerId,
                            timeoutMs: 5 * 60_000,
                            isAuthorityCurrent: () => mutationAuthorityKeyRef.current === mutationAuthorityKey,
                            decision: {
                                pendingChangeId: pendingReview.pendingChangeId,
                                decision: 'installAndTrust',
                                confirmPresentUser: async () => {
                                    const resolution = await showPluginInstallationReviewDialog({
                                        title: t('settingsPlugins.marketplaceInstallReviewTitle', {
                                            name: pendingReview.review.displayName,
                                            version: pendingReview.review.version,
                                        }),
                                        body: formatPluginInstallationReviewBody(pendingReview.review),
                                        optionalHostAccess: pendingReview.review.optionalHostAccess,
                                    });
                                    return resolution.approved
                                        ? resolution.optionalSelections
                                        : null;
                                },
                            },
                        },
                    );
                    if (mutationAuthorityKeyRef.current !== mutationAuthorityKey) return;
                    if (!decisionResponse.supported) {
                        if (decisionResponse.reason === 'error') {
                            await reconcileAmbiguousMutation(pendingReview.review.version);
                        } else {
                            Modal.alert(t('common.error'), t('common.unavailable'));
                        }
                        return;
                    }
                    const outcome = decisionResponse.outcome;
                    if (outcome.kind === 'committed') {
                        Modal.alert(t('common.success'), t('common.done'));
                        machineCapabilities.refresh({ bypassCache: true });
                        publishPluginTruthRefresh();
                        return;
                    }
                    if (outcome.kind === 'cancelled') {
                        return;
                    }
                    if (outcome.kind === 'outcomeUnknown') {
                        await reconcileAmbiguousMutation(pendingReview.review.version);
                    } else {
                        showMutationFailure(outcome.detail ?? outcome.kind);
                    }
                    return;
                }

                if (commitAction) {
                    const changeKind = readPluginChangeKind(response.response.result, params.method, params.pluginId);
                    if (changeKind !== 'committed') {
                        if (changeKind === 'outcomeUnknown') {
                            await reconcileAmbiguousMutation(catalogEntry?.version ?? null);
                        } else {
                            showMutationFailure(changeKind ?? 'invalid-response');
                        }
                        return;
                    }
                    Modal.alert(t('common.success'), t('common.done'));
                }
                machineCapabilities.refresh({ bypassCache: true });
                publishPluginTruthRefresh();
            } finally {
                markPluginActionFinished(mutationAuthorityKey, params.pluginId);
            }
        })();
    }, [activeServerId, capabilityRequest, catalog, catalogAuthorityKey, daemonCacheFreshnessKey, invokeWithAlerts, isPluginActionInFlight, machineCapabilities, markPluginActionFinished, markPluginActionStarted, mutationAuthorityKey, primaryMachineId]);

    const runInstalledPluginAction = React.useCallback((
        action: 'enable' | 'disable' | 'rollback' | 'uninstall' | 'forgetTrust',
        pluginId: string,
    ) => {
        const installed = installedPluginByIdRef.current.get(pluginId) ?? null;
        if (
            !installed
            || !mutationAuthorityKey
            || mutationAuthorityKeyRef.current !== mutationAuthorityKey
            || isPluginActionInFlight(pluginId)
        ) {
            return;
        }
        if (action === 'rollback' && installed.rollbackAvailability !== 'available') {
            return;
        }
        if (action === 'enable' || action === 'disable') {
            runCatalogAction({
                method: action,
                pluginId,
            });
            return;
        }
        const actionLabel = resolvePluginChangeActionLabel(action);
        void (async () => {
            const confirmed = await Modal.confirm(
                actionLabel,
                t('settingsPlugins.pluginChangeConfirmBody', {
                    action: actionLabel,
                    name: installed.title,
                }),
                {
                    confirmText: actionLabel,
                    cancelText: t('common.cancel'),
                },
            );
            if (!confirmed) return;
            runCatalogAction({
                method: action,
                pluginId,
            });
        })();
    }, [isPluginActionInFlight, mutationAuthorityKey, runCatalogAction]);

    const runDevelopmentAction = React.useCallback((action: 'test' | 'pack', pluginId: string) => {
        const development = developmentPlugins.find((entry) => entry.installed.pluginId === pluginId) ?? null;
        if (
            !mutationAuthorityKey
            || mutationAuthorityKeyRef.current !== mutationAuthorityKey
            || !primaryMachineId
            || !development
            || development.actions[action] !== true
            || isPluginActionInFlight(pluginId)
        ) {
            return;
        }

        void (async () => {
            markPluginActionStarted(mutationAuthorityKey, pluginId);
            try {
                await invokeWithAlerts({
                    machineId: primaryMachineId,
                    serverId: activeServerId,
                    request: {
                        id: MARKETPLACE_CAPABILITY_ID,
                        method: action,
                        params: { pluginId },
                    },
                    timeoutMs: 5 * 60_000,
                    isAuthorityCurrent: () => mutationAuthorityKeyRef.current === mutationAuthorityKey,
                    alerts: {
                        errorTitle: t('common.error'),
                        successTitle: t('common.success'),
                        unsupportedMessage: (reason) => reason === 'not-supported' ? t('common.unavailable') : t('common.requestFailed'),
                        successMessage: action === 'test'
                            ? t('settingsPlugins.developmentTestSucceeded')
                            : t('settingsPlugins.developmentPackSucceeded'),
                    },
                });
            } finally {
                markPluginActionFinished(mutationAuthorityKey, pluginId);
            }
        })();
    }, [activeServerId, developmentPlugins, invokeWithAlerts, isPluginActionInFlight, markPluginActionFinished, markPluginActionStarted, mutationAuthorityKey, primaryMachineId]);

    const runDevelopmentCreate = React.useCallback((params: Readonly<{
        targetDir: string;
        displayName: string;
        pluginId: string;
    }>) => {
        if (
            !mutationAuthorityKey
            || mutationAuthorityKeyRef.current !== mutationAuthorityKey
            || !developmentCreateAvailable
            || !primaryMachineId
            || isPluginActionInFlight(params.pluginId)
        ) {
            return;
        }

        void (async () => {
            markPluginActionStarted(mutationAuthorityKey, params.pluginId);
            try {
                await invokeWithAlerts({
                    machineId: primaryMachineId,
                    serverId: activeServerId,
                    request: {
                        id: MARKETPLACE_CAPABILITY_ID,
                        method: 'create',
                        params,
                    },
                    timeoutMs: 5 * 60_000,
                    isAuthorityCurrent: () => mutationAuthorityKeyRef.current === mutationAuthorityKey,
                    alerts: {
                        errorTitle: t('common.error'),
                        successTitle: t('common.success'),
                        unsupportedMessage: (reason) => reason === 'not-supported' ? t('common.unavailable') : t('common.requestFailed'),
                        successMessage: t('settingsPlugins.developmentCreateSucceeded'),
                    },
                });
            } finally {
                markPluginActionFinished(mutationAuthorityKey, params.pluginId);
            }
        })();
    }, [activeServerId, developmentCreateAvailable, invokeWithAlerts, isPluginActionInFlight, markPluginActionFinished, markPluginActionStarted, mutationAuthorityKey, primaryMachineId]);

    const runProjectedPluginAction = React.useCallback((pluginId: string, actionId: string) => {
        const projection = pluginProjectionById[pluginId] ?? null;
        const action = projection?.actions.find((entry) => entry.id === actionId) ?? null;
        if (
            !mutationAuthorityKey
            || mutationAuthorityKeyRef.current !== mutationAuthorityKey
            || !primaryMachineId
            || projection?.generation === null
            || projection?.generation === undefined
            || action?.available !== true
            || isPluginActionInFlight(pluginId)
        ) {
            return;
        }

        void (async () => {
            markPluginActionStarted(mutationAuthorityKey, pluginId);
            try {
                const result = await machinePluginStructuredMessageActionExecute(primaryMachineId, {
                    serverId: activeServerId,
                    expectedGeneration: String(projection.generation),
                    qualifiedActionId: actionId,
                    input: null,
                    executionSurface: 'ui',
                });
                if (
                    mutationAuthorityKeyRef.current === mutationAuthorityKey
                    && result.supported
                    && result.result.ok
                ) {
                    machineCapabilities.refresh({ bypassCache: true });
                    setProjectionRefreshKey((prev) => prev + 1);
                    publishMachineContributionRegistryProjectionInvalidation({
                        machineId: primaryMachineId,
                        serverId: activeServerId,
                    });
                }
            } finally {
                markPluginActionFinished(mutationAuthorityKey, pluginId);
            }
        })();
    }, [activeServerId, isPluginActionInFlight, machineCapabilities, markPluginActionFinished, markPluginActionStarted, mutationAuthorityKey, pluginProjectionById, primaryMachineId]);

    const loadCatalog = React.useCallback(async () => {
        if (
            !mutationAuthorityKey
            || mutationAuthorityKeyRef.current !== mutationAuthorityKey
            || !primaryMachineId
            || loadingCatalog
        ) {
            return;
        }

        const requestId = ++catalogRequestIdRef.current;
        setLoadingCatalog(true);
        setCatalogError(null);

        try {
            if (!selectedMarketplaceSource) {
                throw new Error('Select a configured marketplace source before loading');
            }
            const result = await machineMarketplaceIndexQuery(primaryMachineId, {
                text: '',
                cursor: null,
                limit: 100,
                filters: {
                    sourceIds: [selectedMarketplaceSource.id],
                    includeUnavailable: true,
                },
            }, {
                serverId: activeServerId,
                timeoutMs: 130_000,
            });
            const nextCatalog = projectDaemonMarketplaceIndex(result);
            if (
                catalogRequestIdRef.current !== requestId
                || mutationAuthorityKeyRef.current !== mutationAuthorityKey
            ) return;
            setCatalog(nextCatalog);
            setCatalogAuthorityKey(mutationAuthorityKey);
        } catch (error) {
            if (
                catalogRequestIdRef.current !== requestId
                || mutationAuthorityKeyRef.current !== mutationAuthorityKey
            ) return;
            setCatalogError(resolvePluginMarketplaceErrorMessage(error));
        } finally {
            if (
                catalogRequestIdRef.current === requestId
                && mutationAuthorityKeyRef.current === mutationAuthorityKey
            ) {
                setLoadingCatalog(false);
            }
        }
    }, [activeServerId, loadingCatalog, mutationAuthorityKey, primaryMachineId, selectedMarketplaceSource]);

    return {
        activeView,
        currentDiagnostics,
        activeServerId,
        primaryMachineId,
        catalog,
        catalogError,
        catalogUrl,
        canLoadCatalog,
        canRunCatalogActions,
        canRefreshInstalledPlugins,
        daemonOperationsAvailable,
        developmentCreateAvailable,
        developmentPlugins,
        installedPluginById,
        installedPlugins,
        isReadOnlySnapshot,
        isPluginActionInFlight,
        loadCatalog,
        loadedCatalogFooter,
        loadedCatalogTitle,
        loadingCatalog,
        marketplaceSourceRegistry,
        pluginProjectionById,
        registryDiagnostics,
        resolvedCatalogUrl,
        runCatalogAction,
        runDevelopmentCreate,
        runDevelopmentAction,
        runInstalledPluginAction,
        runProjectedPluginAction,
        setActiveView,
        setCatalogUrl,
        setMarketplaceSourceProfile,
    };
}
