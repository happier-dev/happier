import * as React from 'react';

import {
    getMachineCapabilitiesCacheState,
    prefetchMachineCapabilities,
    useMachineCapabilitiesCache,
} from '@/hooks/server/useMachineCapabilitiesCache';
import { useMachineCapabilityInvokeWithAlerts } from '@/hooks/machine/useMachineCapabilityInvokeWithAlerts';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import {
    MACHINE_ADMINISTRATION_SELECTION_KEYS_V1,
} from '@/sync/domains/machines/administration/selectionPreferences';
import type {
    FreshMachineAdministrationExecutionTargetV1,
    MachineAdministrationTargetSelectionV1,
} from '@/sync/domains/machines/administration/useTargetSelection';
import {
    useScopedPluginSettingsDaemonTargetBinding,
} from '@/sync/domains/machines/administration/scopedPluginSettingsTarget';
import {
    publishMachineContributionRegistryProjectionInvalidation,
} from '@/sync/ops/machineContributionRegistryProjection';
import {
    machinePluginInstallDecision,
    type MachinePluginInstallDecisionOutcome,
    type MachinePluginInstallDecisionResult,
} from '@/sync/ops/machinePluginInstallDecision';
import { resolveScopedPluginSettingsServerIdentity } from '@/sync/domains/plugins/settings/scopedPluginSettingsRuntime';
import type { ScopedPluginSettingsTarget } from '@/sync/domains/plugins/settings/scopedPluginSettingsAdapter';
import {
    machineMarketplaceSourceRegistryGet,
    machineMarketplaceSourceRegistrySet,
    machineMarketplaceIndexQuery,
    resolvePreferredMachineMarketplaceSource,
    upsertMachineMarketplaceSourceRegistrySource,
} from '@/sync/ops/machineMarketplaceSources';
import { type PluginProjectionV2, type PluginScaffoldUiMode } from '@happier-dev/protocol';
import type { MarketplaceSourceRegistryV1 } from '@happier-dev/protocol/marketplace';
import { t } from '@/text';
import { Modal } from '@/modal';

import { projectDaemonMarketplaceIndex, type PluginMarketplaceCatalog } from '../readPluginMarketplaceCatalog';
import { showPluginInstallationReviewDialog } from '../PluginInstallationReviewDialog';
import {
    MARKETPLACE_CAPABILITY_ID,
    readDevelopmentCreateAvailable,
    readDevelopmentSourceInstallAvailable,
    readDevelopmentPlugins,
    readInstalledPlugins,
    formatPluginInstallationReviewBody,
    isPluginMutationVisibleAfterRefresh,
    readPluginChangeKind,
    readPendingPluginChangeDecision,
    readPendingPluginChangeDecisionId,
    readPendingPluginChangeListingId,
    readPendingPluginChanges,
    readPendingPluginChangeReview,
    readPendingPluginChangeStatus,
    readPluginDevelopChange,
    readPluginInstallationReviewChange,
    resolvePluginMarketplaceErrorMessage,
    resolvePluginReadOnlySnapshotNotice,
    type DevelopmentPluginEntry,
    type InstalledPluginEntry,
    type PendingPluginChangeDecision,
    type PendingPluginChangeListing,
    type PendingPluginChangeReview,
    type PendingPluginDevelopmentSourceRootReview,
    type PluginMarketplaceActionRequest,
    type PluginReadOnlySnapshotNoticeState,
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
    administrationTargetSelection: MachineAdministrationTargetSelectionV1;
    currentDiagnostics: readonly { code: string; message: string }[];
    accountServerIdentityId: string | null;
    executionServerIdentityId: string | null;
    executionServerId: string | null;
    executionMachineId: string | null;
    /** Rejects renderer-originated writes once this exact daemon target retires. */
    isDaemonSettingsTargetCurrent: (target: Extract<ScopedPluginSettingsTarget, { kind: 'daemon' }>) => boolean;
    catalog: PluginMarketplaceCatalog | null;
    catalogError: string | null;
    catalogUrl: string;
    canLoadCatalog: boolean;
    canRunCatalogActions: boolean;
    canRefreshInstalledPlugins: boolean;
    daemonOperationsAvailable: boolean;
    developmentCreateAvailable: boolean;
    developmentSourceInstallAvailable: boolean;
    developmentPlugins: readonly DevelopmentPluginEntry[];
    installedPluginById: ReadonlyMap<string, InstalledPluginEntry>;
    installedPlugins: readonly InstalledPluginEntry[];
    /** Daemon-held changes — including ones an Agent prepared — awaiting this user. */
    pendingPluginChanges: readonly PendingPluginChangeListing[];
    decidePendingPluginChange: (pendingChangeId: string, decision: 'approve' | 'reject') => void;
    readOnlySnapshotNotice: PluginReadOnlySnapshotNoticeState | null;
    refreshPluginTruth: () => void;
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
    /** Current exact daemon projection only; stale cache never authorizes execution. */
    pluginProjectionV2: PluginProjectionV2 | null;
    registryDiagnostics: ReturnType<typeof useDaemonMergedProjectionInputs>['inputs'] extends infer TInputs
        ? TInputs extends { registryDiagnostics: infer TDiagnostics }
            ? TDiagnostics
            : readonly []
        : readonly [];
    resolvedCatalogUrl: string;
    runCatalogAction: (params: PluginMarketplaceActionRequest) => void;
    runDevelopmentCreate: (params: Readonly<{ targetDir: string; displayName: string; pluginId: string; ui?: PluginScaffoldUiMode }>) => void;
    runDevelopmentSourceInstall: (sourceRootPath: string) => void;
    runDevelopmentAction: (action: 'test' | 'pack', pluginId: string) => void;
    runInstalledPluginAction: (action: 'enable' | 'disable' | 'rollback' | 'uninstall' | 'forgetTrust', pluginId: string) => void;
    setActiveView: (view: PluginSettingsViewId) => void;
    setCatalogUrl: (value: string) => void;
    setMarketplaceSourceProfile: (sourceId: string, profileId: string | null) => Promise<void>;
}>;

export function usePluginSettingsScreenState(): PluginSettingsScreenState {
    const activeServer = useActiveServerSnapshot();
    // The one administration-target owner. It supplies the selection, the exact
    // Settings/Secrets record target, and the single currentness fence every
    // asynchronous write re-checks — shared with the deep-linked Settings page
    // screen so the two cannot disagree about which machine is being edited.
    const administration = useScopedPluginSettingsDaemonTargetBinding(
        MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.plugins,
    );
    const administrationTargetSelection = administration.selection;
    const accountServerIdentityId = React.useMemo(
        () => resolveScopedPluginSettingsServerIdentity(activeServer.serverId),
        [activeServer.serverId],
    );
    const executionTarget = administration.executionTarget;
    const executionMachineId = executionTarget?.machine.id ?? null;
    const executionServerId = executionTarget?.serverId ?? null;
    const executionServerIdentityId = executionTarget?.target.serverIdentityId ?? null;
    const { invokeWithAlerts } = useMachineCapabilityInvokeWithAlerts();
    /**
     * This is a cache identity only. It deliberately uses the portable target,
     * so an offline exact selection retains its own last-known snapshot without
     * falling back to the active server or another machine.
     */
    const selectedMachineScopeKey = administrationTargetSelection.selectedTarget
        ? `${administrationTargetSelection.selectedTarget.serverIdentityId}:${administrationTargetSelection.selectedTarget.machineId}`
        : null;
    const daemonTransportOnline = executionTarget !== null;
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
    const daemonCacheFreshnessKey = `${executionTarget?.machine.daemonStateVersion ?? 0}:${daemonReconnectFreshness.reconnectSequence}`;

    /**
     * Every asynchronous daemon boundary re-resolves the portable target. A
     * rendered target is presentation state; this guard rejects a stale or
     * retired target before it can route an effect or mutation.
     */
    const resolveCurrentExecutionTarget = administration.resolveCurrentExecutionTarget;
    const isDaemonSettingsTargetCurrent = administration.isTargetCurrent;

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
        machineId: executionMachineId,
        serverId: executionServerId,
        cacheKeySalt: daemonCacheFreshnessKey,
        enabled: executionTarget !== null,
        request: capabilityRequest,
        timeoutMs: 12_000,
    });
    const daemonMergedProjection = useDaemonMergedProjectionInputs({
        machineId: executionMachineId,
        serverId: executionServerId,
        enabled: executionTarget !== null,
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
    /**
     * Deliberately not retained across machines like the installed list is: a
     * pending decision belongs to exactly one daemon lifetime, and offering a
     * stale one would invite the user to answer a change that no longer exists.
     */
    const pendingPluginChanges = React.useMemo(
        () => readPendingPluginChanges(machineCapabilities.state),
        [machineCapabilities.state],
    );
    const developmentCreateAvailable = readDevelopmentCreateAvailable(machineCapabilities.state);
    const developmentSourceInstallAvailable = readDevelopmentSourceInstallAvailable(machineCapabilities.state);
    const currentDaemonCapabilitiesState = executionMachineId && executionServerId
        ? getMachineCapabilitiesCacheState(
            executionMachineId,
            executionServerId,
            daemonCacheFreshnessKey,
        )
        : null;
    const daemonOperationsAvailable = executionTarget !== null
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
    // Account release selection may use an exact Account-hosted source while
    // offline. A daemon execution path, however, is valid only from the live
    // raw projection for this exact administration target.
    const pluginProjectionV2 = daemonOperationsAvailable
        ? daemonMergedProjection.inputs?.pluginProjectionV2 ?? null
        : null;
    const registryDiagnostics = projectionInputs?.registryDiagnostics ?? [];
    const currentDiagnostics = React.useMemo(() => [
        ...registryDiagnostics,
        ...Object.values(pluginProjectionById).flatMap((plugin) => plugin.diagnostics),
    ], [pluginProjectionById, registryDiagnostics]);
    const readOnlySnapshotNotice = resolvePluginReadOnlySnapshotNotice({
        daemonOperationsAvailable,
        daemonTransportOnline,
        projectionPhase: daemonMergedProjection.phase,
        hasCapabilitySnapshot,
        installedPluginCount: installedPlugins.length,
        developmentPluginCount: developmentPlugins.length,
        hasCatalog: catalog !== null,
        hasMarketplaceSourceRegistry: marketplaceSourceRegistry !== null,
        hasProjectionInputs: projectionInputs !== null,
    });
    /**
     * Re-reads daemon-owned plugin truth: the projection cache holds a failure
     * until something invalidates it, so both a completed mutation and the
     * projection-failure notice's retry go through this one owner.
     */
    const refreshPluginTruth = React.useCallback(() => {
        setProjectionRefreshKey((prev) => prev + 1);
        const currentTarget = resolveCurrentExecutionTarget(executionTarget);
        if (!currentTarget) return;
        publishMachineContributionRegistryProjectionInvalidation({
            machineId: currentTarget.machine.id,
            serverId: currentTarget.serverId,
        });
    }, [executionTarget, resolveCurrentExecutionTarget]);
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
        const requestedTarget = resolveCurrentExecutionTarget(executionTarget);
        if (!daemonOperationsAvailable || !requestedTarget) {
            marketplaceSourceRegistryRequestIdRef.current += 1;
            return;
        }

        const requestId = ++marketplaceSourceRegistryRequestIdRef.current;
        void (async () => {
            try {
                const nextRegistry = await machineMarketplaceSourceRegistryGet(requestedTarget.machine.id, {
                    serverId: requestedTarget.serverId,
                });
                if (
                    marketplaceSourceRegistryRequestIdRef.current !== requestId
                    || !resolveCurrentExecutionTarget(requestedTarget)
                ) return;
                setMarketplaceSourceRegistry(nextRegistry);
            } catch {
                if (
                    marketplaceSourceRegistryRequestIdRef.current !== requestId
                    || !resolveCurrentExecutionTarget(requestedTarget)
                ) return;
                setMarketplaceSourceRegistry(null);
            }
        })();
    }, [daemonOperationsAvailable, executionTarget, resolveCurrentExecutionTarget]);

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
        const currentTarget = resolveCurrentExecutionTarget(executionTarget);
        if (
            !mutationAuthorityKey
            || mutationAuthorityKeyRef.current !== mutationAuthorityKey
            || !currentTarget
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
        const saved = await machineMarketplaceSourceRegistrySet(currentTarget.machine.id, next, {
            serverId: currentTarget.serverId,
        });
        if (
            marketplaceSourceRegistryRequestIdRef.current !== requestId
            || mutationAuthorityKeyRef.current !== mutationAuthorityKey
            || !resolveCurrentExecutionTarget(currentTarget)
        ) return;
        setMarketplaceSourceRegistry(saved);
    }, [executionTarget, marketplaceSourceRegistry, mutationAuthorityKey, resolveCurrentExecutionTarget]);

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

    /**
     * Asks the present user the install-and-trust question and answers the
     * daemon with their decision.
     *
     * Every caller that reaches an install review — a marketplace install, a
     * local folder adopted from this screen, and a change some other client
     * prepared — goes through this one step, so the dialog a user sees and the
     * evidence the daemon receives cannot drift apart per entry point. Outcome
     * policy stays with the caller: only the caller knows what it was trying
     * to achieve.
     */
    const decidePluginInstallationReviewAsPresentUser = React.useCallback(async (params: Readonly<{
        target: FreshMachineAdministrationExecutionTargetV1;
        isAuthorityCurrent: () => boolean;
        installationReview: PendingPluginChangeReview;
    }>): Promise<MachinePluginInstallDecisionResult> => await machinePluginInstallDecision(params.target.machine.id, {
        serverId: params.target.serverId,
        timeoutMs: 5 * 60_000,
        isAuthorityCurrent: params.isAuthorityCurrent,
        decision: {
            pendingChangeId: params.installationReview.pendingChangeId,
            decision: 'installAndTrust',
            confirmPresentUser: async () => {
                const resolution = await showPluginInstallationReviewDialog({
                    title: t('settingsPlugins.marketplaceInstallReviewTitle', {
                        name: params.installationReview.review.displayName,
                        version: params.installationReview.review.version,
                    }),
                    body: formatPluginInstallationReviewBody(params.installationReview.review),
                    optionalHostAccess: params.installationReview.review.optionalHostAccess,
                });
                return resolution.approved ? resolution.optionalSelections : null;
            },
        },
    }), []);

    /**
     * Asks the present user to trust a development source root.
     *
     * The locator is the entire security payload of this decision — the daemon
     * has not been allowed to read that folder yet, so there is no package
     * identity to show — and it is therefore echoed verbatim.
     */
    const decidePluginSourceRootTrustAsPresentUser = React.useCallback(async (params: Readonly<{
        target: FreshMachineAdministrationExecutionTargetV1;
        isAuthorityCurrent: () => boolean;
        sourceRootReview: PendingPluginDevelopmentSourceRootReview;
    }>): Promise<MachinePluginInstallDecisionResult> => await machinePluginInstallDecision(params.target.machine.id, {
        serverId: params.target.serverId,
        timeoutMs: 10 * 60_000,
        isAuthorityCurrent: params.isAuthorityCurrent,
        decision: {
            pendingChangeId: params.sourceRootReview.pendingChangeId,
            decision: 'trustSourceRoot',
            confirmPresentUser: async () => await Modal.confirm(
                t('settingsPlugins.developmentTrustSourceRootTitle'),
                t('settingsPlugins.developmentTrustSourceRootBody', {
                    path: params.sourceRootReview.review.source.locator,
                }),
                {
                    confirmText: t('settingsPlugins.developmentTrustSourceRootConfirm'),
                    cancelText: t('common.cancel'),
                },
            ),
        },
    }), []);

    /**
     * Carries one pending change from wherever it currently is to a terminal
     * outcome, asking the present user each question the daemon still has.
     *
     * The daemon may answer a source-root trust with the ordinary
     * install-and-trust review, so this follows that continuation instead of
     * treating the second review as an unrelated change. Both halves of the
     * agent-authored loop end here: a change this screen started, and a change
     * an Agent prepared that only a present user can decide.
     */
    const decidePendingPluginChangeAsPresentUser = React.useCallback(async (params: Readonly<{
        target: FreshMachineAdministrationExecutionTargetV1;
        isAuthorityCurrent: () => boolean;
        decision: PendingPluginChangeDecision;
        successMessage: string;
        formatFailure: (outcome: string) => string;
    }>): Promise<void> => {
        let stage: PendingPluginChangeDecision | null = params.decision;
        while (stage !== null) {
            // Both bindings are annotated: the loop reassigns `stage` from a
            // value derived from `stage` itself, and inference alone would make
            // that circular.
            const current: PendingPluginChangeDecision = stage;
            const response: MachinePluginInstallDecisionResult = current.kind === 'sourceRootReviewRequired'
                ? await decidePluginSourceRootTrustAsPresentUser({
                    target: params.target,
                    isAuthorityCurrent: params.isAuthorityCurrent,
                    sourceRootReview: current.sourceRootReview,
                })
                : await decidePluginInstallationReviewAsPresentUser({
                    target: params.target,
                    isAuthorityCurrent: params.isAuthorityCurrent,
                    installationReview: current.installationReview,
                });
            if (!params.isAuthorityCurrent()) return;
            if (!response.supported) {
                Modal.alert(t('common.error'), t('common.unavailable'));
                return;
            }
            const outcome: MachinePluginInstallDecisionOutcome = response.outcome;
            if (outcome.kind === 'cancelled') return;
            if (outcome.kind === 'committed') {
                Modal.alert(t('common.success'), params.successMessage);
                machineCapabilities.refresh({ bypassCache: true });
                refreshPluginTruth();
                return;
            }
            const continuation: PendingPluginChangeDecision | null = outcome.kind === 'reviewRequired'
                ? readPendingPluginChangeDecision(outcome.change)
                : null;
            if (!continuation) {
                Modal.alert(
                    t('common.error'),
                    params.formatFailure(outcome.detail ?? outcome.kind),
                );
                machineCapabilities.refresh({ bypassCache: true });
                refreshPluginTruth();
                return;
            }
            stage = continuation;
        }
    }, [
        decidePluginInstallationReviewAsPresentUser,
        decidePluginSourceRootTrustAsPresentUser,
        machineCapabilities,
        refreshPluginTruth,
    ]);

    const runCatalogAction = React.useCallback((params: PluginMarketplaceActionRequest) => {
        const initialTarget = resolveCurrentExecutionTarget(executionTarget);
        if (
            !mutationAuthorityKey
            || mutationAuthorityKeyRef.current !== mutationAuthorityKey
            || !initialTarget
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
                const isAuthorityCurrent = () => (
                    mutationAuthorityKeyRef.current === mutationAuthorityKey
                    && resolveCurrentExecutionTarget(initialTarget) !== null
                );
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
                const reconcileAmbiguousMutation = async (targetVersion: string | null) => {
                    if (!commitAction) return;
                    try {
                        await prefetchMachineCapabilities({
                            machineId: initialTarget.machine.id,
                            serverId: initialTarget.serverId,
                            cacheKeySalt: daemonCacheFreshnessKey,
                            request: {
                                ...capabilityRequest,
                                bypassCache: true,
                            },
                            timeoutMs: 12_000,
                        });
                    } catch {
                        if (isAuthorityCurrent()) {
                            refreshPluginTruth();
                            showMutationFailure('outcomeUnknown');
                        }
                        return;
                    }
                    if (!isAuthorityCurrent()) return;

                    const refreshedState = getMachineCapabilitiesCacheState(
                        initialTarget.machine.id,
                        initialTarget.serverId,
                        daemonCacheFreshnessKey,
                    );
                    refreshPluginTruth();
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
                    machineId: initialTarget.machine.id,
                    serverId: initialTarget.serverId,
                    request: {
                        id: MARKETPLACE_CAPABILITY_ID,
                        method: params.method,
                        params: {
                            pluginId: params.pluginId,
                            ...(params.sourceId ? { sourceId: params.sourceId } : {}),
                        },
                    },
                    timeoutMs: 5 * 60_000,
                    isAuthorityCurrent,
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
                if (!isAuthorityCurrent()) return;

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
                    const decisionResponse = await decidePluginInstallationReviewAsPresentUser({
                        target: initialTarget,
                        isAuthorityCurrent,
                        installationReview: pendingReview,
                    });
                    if (!isAuthorityCurrent()) return;
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
                        refreshPluginTruth();
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
                refreshPluginTruth();
            } finally {
                markPluginActionFinished(mutationAuthorityKey, params.pluginId);
            }
        })();
    }, [capabilityRequest, catalog, catalogAuthorityKey, daemonCacheFreshnessKey, decidePluginInstallationReviewAsPresentUser, executionTarget, invokeWithAlerts, isPluginActionInFlight, machineCapabilities, markPluginActionFinished, markPluginActionStarted, mutationAuthorityKey, refreshPluginTruth, resolveCurrentExecutionTarget]);

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
        const initialTarget = resolveCurrentExecutionTarget(executionTarget);
        if (
            !mutationAuthorityKey
            || mutationAuthorityKeyRef.current !== mutationAuthorityKey
            || !initialTarget
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
                    machineId: initialTarget.machine.id,
                    serverId: initialTarget.serverId,
                    request: {
                        id: MARKETPLACE_CAPABILITY_ID,
                        method: action,
                        params: { pluginId },
                    },
                    timeoutMs: 5 * 60_000,
                    isAuthorityCurrent: () => (
                        mutationAuthorityKeyRef.current === mutationAuthorityKey
                        && resolveCurrentExecutionTarget(initialTarget) !== null
                    ),
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
    }, [developmentPlugins, executionTarget, invokeWithAlerts, isPluginActionInFlight, markPluginActionFinished, markPluginActionStarted, mutationAuthorityKey, resolveCurrentExecutionTarget]);

    const runDevelopmentCreate = React.useCallback((params: Readonly<{
        targetDir: string;
        displayName: string;
        pluginId: string;
        ui?: PluginScaffoldUiMode;
    }>) => {
        const initialTarget = resolveCurrentExecutionTarget(executionTarget);
        if (
            !mutationAuthorityKey
            || mutationAuthorityKeyRef.current !== mutationAuthorityKey
            || !developmentCreateAvailable
            || !initialTarget
            || isPluginActionInFlight(params.pluginId)
        ) {
            return;
        }

        void (async () => {
            markPluginActionStarted(mutationAuthorityKey, params.pluginId);
            try {
                await invokeWithAlerts({
                    machineId: initialTarget.machine.id,
                    serverId: initialTarget.serverId,
                    request: {
                        id: MARKETPLACE_CAPABILITY_ID,
                        method: 'create',
                        params,
                    },
                    timeoutMs: 5 * 60_000,
                    isAuthorityCurrent: () => (
                        mutationAuthorityKeyRef.current === mutationAuthorityKey
                        && resolveCurrentExecutionTarget(initialTarget) !== null
                    ),
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
    }, [developmentCreateAvailable, executionTarget, invokeWithAlerts, isPluginActionInFlight, markPluginActionFinished, markPluginActionStarted, mutationAuthorityKey, resolveCurrentExecutionTarget]);

    /**
     * Adopts a local folder as a development source.
     *
     * Two authorizations happen, in this order, and neither is ever answered on
     * the user's behalf: first the **source root** — the daemon is not allowed
     * to read, install dependencies in, or evaluate code from that folder until
     * the user has seen the exact path — and only then the ordinary
     * install-and-trust review for the plugin the daemon derived from it. The
     * daemon may answer the first decision with the second, so the two steps
     * share one pending change and one authority fence.
     */
    const runDevelopmentSourceInstall = React.useCallback((sourceRootPath: string) => {
        const trimmedSourceRootPath = sourceRootPath.trim();
        const initialTarget = resolveCurrentExecutionTarget(executionTarget);
        if (
            !mutationAuthorityKey
            || mutationAuthorityKeyRef.current !== mutationAuthorityKey
            || !initialTarget
            || !trimmedSourceRootPath
            || isPluginActionInFlight(trimmedSourceRootPath)
        ) {
            return;
        }

        void (async () => {
            markPluginActionStarted(mutationAuthorityKey, trimmedSourceRootPath);
            try {
                const isAuthorityCurrent = () => (
                    mutationAuthorityKeyRef.current === mutationAuthorityKey
                    && resolveCurrentExecutionTarget(initialTarget) !== null
                );

                const response = await invokeWithAlerts({
                    machineId: initialTarget.machine.id,
                    serverId: initialTarget.serverId,
                    request: {
                        id: MARKETPLACE_CAPABILITY_ID,
                        method: 'develop',
                        params: { sourceRootPath: trimmedSourceRootPath },
                    },
                    timeoutMs: 5 * 60_000,
                    isAuthorityCurrent,
                    alerts: {
                        errorTitle: t('common.error'),
                        successTitle: t('common.success'),
                        unsupportedMessage: (reason) => reason === 'not-supported' ? t('common.unavailable') : t('common.requestFailed'),
                        successMessage: null,
                    },
                });
                if (!isAuthorityCurrent() || !('response' in response) || !response.response.ok) return;

                const developChange = readPluginDevelopChange(response.response.result);
                if (!developChange) return;
                if (developChange.kind === 'committed') {
                    // The daemon commits without a review only when both the root
                    // and the derived plugin were already trusted.
                    Modal.alert(t('common.success'), t('settingsPlugins.developmentSourceInstallSucceeded'));
                    machineCapabilities.refresh({ bypassCache: true });
                    refreshPluginTruth();
                    return;
                }
                await decidePendingPluginChangeAsPresentUser({
                    target: initialTarget,
                    isAuthorityCurrent,
                    decision: developChange,
                    successMessage: t('settingsPlugins.developmentSourceInstallSucceeded'),
                    formatFailure: (outcome) => t('settingsPlugins.developmentSourceInstallFailed', { outcome }),
                });
            } finally {
                markPluginActionFinished(mutationAuthorityKey, trimmedSourceRootPath);
            }
        })();
    }, [decidePendingPluginChangeAsPresentUser, executionTarget, invokeWithAlerts, isPluginActionInFlight, machineCapabilities, markPluginActionFinished, markPluginActionStarted, mutationAuthorityKey, refreshPluginTruth, resolveCurrentExecutionTarget]);

    /**
     * Answers a change the daemon is holding that this screen did not start.
     *
     * An Agent may prepare a plugin change, but approving one is not delegable:
     * source-root trust and package trust are the present user's decisions. The
     * Agent's issued id therefore has to be findable and answerable here, or the
     * change it prepared simply expires unseen.
     *
     * The listing snapshot is a projection, so the change is re-read at its
     * owner first. That read — and not the stale row — decides what the user is
     * asked, and it is the only place the honest "still applying", "already
     * expired" and "the daemon that held it is gone" arms exist.
     */
    const decidePendingPluginChange = React.useCallback((
        pendingChangeId: string,
        decision: 'approve' | 'reject',
    ) => {
        const trimmedPendingChangeId = pendingChangeId.trim();
        const initialTarget = resolveCurrentExecutionTarget(executionTarget);
        if (
            !mutationAuthorityKey
            || mutationAuthorityKeyRef.current !== mutationAuthorityKey
            || !initialTarget
            || !trimmedPendingChangeId
            || isPluginActionInFlight(trimmedPendingChangeId)
        ) {
            return;
        }

        void (async () => {
            markPluginActionStarted(mutationAuthorityKey, trimmedPendingChangeId);
            try {
                const isAuthorityCurrent = () => (
                    mutationAuthorityKeyRef.current === mutationAuthorityKey
                    && resolveCurrentExecutionTarget(initialTarget) !== null
                );
                const reportOutcome = (message: string) => {
                    Modal.alert(t('common.error'), message);
                    machineCapabilities.refresh({ bypassCache: true });
                    refreshPluginTruth();
                };

                const response = await invokeWithAlerts({
                    machineId: initialTarget.machine.id,
                    serverId: initialTarget.serverId,
                    request: {
                        id: MARKETPLACE_CAPABILITY_ID,
                        method: 'changeStatus',
                        params: { pendingChangeId: trimmedPendingChangeId },
                    },
                    timeoutMs: 60_000,
                    isAuthorityCurrent,
                    alerts: {
                        errorTitle: t('common.error'),
                        successTitle: t('common.success'),
                        unsupportedMessage: (reason) => reason === 'not-supported' ? t('common.unavailable') : t('common.requestFailed'),
                        successMessage: null,
                    },
                });
                if (!isAuthorityCurrent() || !('response' in response) || !response.response.ok) return;

                const status = readPendingPluginChangeStatus(response.response.result);
                if (!status) {
                    reportOutcome(t('common.requestFailed'));
                    return;
                }
                if (status.kind === 'applying') {
                    Modal.alert(t('common.success'), t('settingsPlugins.pendingChangeApplying'));
                    machineCapabilities.refresh({ bypassCache: true });
                    refreshPluginTruth();
                    return;
                }
                if (status.kind === 'expired') {
                    reportOutcome(t('settingsPlugins.pendingChangeExpired'));
                    return;
                }
                if (status.kind === 'daemonUnavailable') {
                    reportOutcome(t('common.unavailable'));
                    return;
                }
                if (status.kind === 'terminal') {
                    reportOutcome(t('settingsPlugins.pendingChangeFailed', { outcome: status.outcome }));
                    return;
                }

                if (decision === 'reject') {
                    const confirmed = await Modal.confirm(
                        t('approvals.reject'),
                        t('settingsPlugins.pendingChangeConfirmRejectBody'),
                        { confirmText: t('approvals.reject'), cancelText: t('common.cancel'), destructive: true },
                    );
                    if (!confirmed || !isAuthorityCurrent()) return;
                    const rejection = await machinePluginInstallDecision(initialTarget.machine.id, {
                        serverId: initialTarget.serverId,
                        timeoutMs: 60_000,
                        isAuthorityCurrent,
                        decision: {
                            pendingChangeId: readPendingPluginChangeDecisionId(status),
                            decision: 'cancel',
                        },
                    });
                    if (!isAuthorityCurrent()) return;
                    if (!rejection.supported) {
                        Modal.alert(t('common.error'), t('common.unavailable'));
                        return;
                    }
                    if (rejection.outcome.kind === 'cancelled' || rejection.outcome.kind === 'expired') {
                        Modal.alert(t('common.success'), t('settingsPlugins.pendingChangeRejected'));
                    } else {
                        Modal.alert(
                            t('common.error'),
                            t('settingsPlugins.pendingChangeFailed', {
                                outcome: rejection.outcome.detail ?? rejection.outcome.kind,
                            }),
                        );
                    }
                    machineCapabilities.refresh({ bypassCache: true });
                    refreshPluginTruth();
                    return;
                }

                await decidePendingPluginChangeAsPresentUser({
                    target: initialTarget,
                    isAuthorityCurrent,
                    decision: status,
                    successMessage: t('common.done'),
                    formatFailure: (outcome) => t('settingsPlugins.pendingChangeFailed', { outcome }),
                });
            } finally {
                markPluginActionFinished(mutationAuthorityKey, trimmedPendingChangeId);
            }
        })();
    }, [decidePendingPluginChangeAsPresentUser, executionTarget, invokeWithAlerts, isPluginActionInFlight, machineCapabilities, markPluginActionFinished, markPluginActionStarted, mutationAuthorityKey, refreshPluginTruth, resolveCurrentExecutionTarget]);

    const loadCatalog = React.useCallback(async () => {
        const initialTarget = resolveCurrentExecutionTarget(executionTarget);
        if (
            !mutationAuthorityKey
            || mutationAuthorityKeyRef.current !== mutationAuthorityKey
            || !initialTarget
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
            const result = await machineMarketplaceIndexQuery(initialTarget.machine.id, {
                text: '',
                cursor: null,
                limit: 100,
                filters: {
                    sourceIds: [selectedMarketplaceSource.id],
                    includeUnavailable: true,
                },
            }, {
                serverId: initialTarget.serverId,
                timeoutMs: 130_000,
            });
            const nextCatalog = projectDaemonMarketplaceIndex(result);
            if (
                catalogRequestIdRef.current !== requestId
                || mutationAuthorityKeyRef.current !== mutationAuthorityKey
                || !resolveCurrentExecutionTarget(initialTarget)
            ) return;
            setCatalog(nextCatalog);
            setCatalogAuthorityKey(mutationAuthorityKey);
        } catch (error) {
            if (
                catalogRequestIdRef.current !== requestId
                || mutationAuthorityKeyRef.current !== mutationAuthorityKey
                || !resolveCurrentExecutionTarget(initialTarget)
            ) return;
            setCatalogError(resolvePluginMarketplaceErrorMessage(error));
        } finally {
            if (
                catalogRequestIdRef.current === requestId
                && mutationAuthorityKeyRef.current === mutationAuthorityKey
                && resolveCurrentExecutionTarget(initialTarget) !== null
            ) {
                setLoadingCatalog(false);
            }
        }
    }, [executionTarget, loadingCatalog, mutationAuthorityKey, resolveCurrentExecutionTarget, selectedMarketplaceSource]);

    return {
        activeView,
        administrationTargetSelection,
        currentDiagnostics,
        accountServerIdentityId,
        executionServerIdentityId,
        executionServerId,
        executionMachineId,
        isDaemonSettingsTargetCurrent,
        catalog,
        catalogError,
        catalogUrl,
        canLoadCatalog,
        canRunCatalogActions,
        canRefreshInstalledPlugins,
        daemonOperationsAvailable,
        developmentCreateAvailable,
        developmentSourceInstallAvailable,
        developmentPlugins,
        installedPluginById,
        installedPlugins,
        pendingPluginChanges,
        decidePendingPluginChange,
        readOnlySnapshotNotice,
        refreshPluginTruth,
        isPluginActionInFlight,
        loadCatalog,
        loadedCatalogFooter,
        loadedCatalogTitle,
        loadingCatalog,
        marketplaceSourceRegistry,
        pluginProjectionById,
        pluginProjectionV2,
        registryDiagnostics,
        resolvedCatalogUrl,
        runCatalogAction,
        runDevelopmentCreate,
        runDevelopmentSourceInstall,
        runDevelopmentAction,
        runInstalledPluginAction,
        setActiveView,
        setCatalogUrl,
        setMarketplaceSourceProfile,
    };
}
