import * as React from 'react';

import {
    getMachineCapabilitiesCacheState,
    prefetchMachineCapabilities,
} from '@/hooks/server/useMachineCapabilitiesCache';
import { useMachineCapabilityInvokeWithAlerts } from '@/hooks/machine/useMachineCapabilityInvokeWithAlerts';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { MARKETPLACE_CAPABILITY_REQUEST, usePluginsAdministrationTarget } from './usePluginsAdministrationTarget';
import {
    resolveMachineAdministrationTargetLabel,
} from '@/sync/domains/machines/administration/targetSelection';
import type {
    FreshMachineAdministrationExecutionTargetV1,
    MachineAdministrationTargetSelectionV1,
} from '@/sync/domains/machines/administration/useTargetSelection';
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
import { captureActiveServerAccountScopeCurrentness } from '@/sync/domains/scope/activeServerAccountScope';
import { reviewManagedResourceRemoval } from '@/components/settings/machines/managed/reviewManagedResourceRemoval';
import type { ManagedResourceDispositionV1 } from '@happier-dev/protocol/machines/managed/managedDependencyV1';
import {
    machineMarketplaceIndexQuery,
} from '@/sync/ops/machineMarketplaceSources';
import { type PluginProjectionV2, type PluginScaffoldUiMode } from '@happier-dev/protocol';
import {
    COMMUNITY_NPM_MARKETPLACE_SOURCE_ID_V1,
    type MarketplaceSourceRegistryV1,
    type PluginUpdatePolicyV1,
} from '@happier-dev/protocol/marketplace';
import { t } from '@/text';
import { Modal } from '@/modal';

import {
    mergeDiscoverEntries,
    mergeDiscoverNonInstallableListings,
    projectDaemonMarketplaceIndexPage,
    type PluginMarketplaceCatalogEntry,
    type PluginMarketplaceCatalogSourceKind,
    type PluginMarketplaceDiscoverDiagnostic,
    type PluginMarketplaceDiscoverSourceStatus,
    type PluginMarketplaceNonInstallableListing,
} from '../readPluginMarketplaceCatalog';
import { showPluginInstallationReviewDialog } from '../PluginInstallationReviewDialog';
import { showPluginRegistryProfileSelectionDialog } from '../PluginRegistryProfileSelectionDialog';
import {
    useMarketplaceSourceRegistryAdministration,
    type MarketplaceSourceRegistryAdministrationV1,
} from './useMarketplaceSourceRegistryAdministration';
import {
    buildDiscoverQueryFilters,
    MARKETPLACE_CAPABILITY_ID,
    readDevelopmentCreateAvailable,
    readDevelopmentSourceInstallAvailable,
    readDevelopmentPlugins,
    readInstalledPlugins,
    isPluginMutationVisibleAfterRefresh,
    readPluginChangeKind,
    readPluginManagedResourceRemovalReview,
    isPluginDisableNoopResult,
    readPluginCreateResult,
    readPluginEditTargetResult,
    readPendingPluginChangeDecision,
    readPendingPluginChangeDecisionId,
    readPendingPluginChangeListingId,
    readPendingPluginChanges,
    resolvePluginDaemonOperationsAvailability,
    readPendingPluginChangeReview,
    readPendingPluginChangeStatus,
    readPluginDevelopChange,
    readPluginInstallationReviewChange,
    readPluginRegistryProfileRequirement,
    resolvePluginReadOnlySnapshotNotice,
    resolvePluginTruthReadState,
    type DevelopmentPluginEntry,
    projectInstalledPluginLifecycleCapabilities,
    type InstalledPluginEntry,
    type PendingPluginChangeDecision,
    type PendingPluginChangeListing,
    type PendingPluginChangeReview,
    type PendingPluginDevelopmentProjectTrustReview,
    type PluginMarketplaceActionRequest,
    type PluginReadOnlySnapshotNoticeState,
    type PluginSettingsViewId,
} from './pluginMarketplaceModel';

/**
 * The synthesized community npm discovery source.
 *
 * It is not a configurable index and never appears in a machine's persisted
 * marketplace source registry, whose sources are only `user` or `curated`.
 */
const COMMUNITY_NPM_DISCOVER_SOURCE_ID = COMMUNITY_NPM_MARKETPLACE_SOURCE_ID_V1;

/** One aggregate index page; the caller advances the cursor for the next. */
const DISCOVER_PAGE_SIZE = 50;

/**
 * The lifecycle actions an installed row or its detail screen may run.
 *
 * `update` belongs here rather than only on a marketplace listing: the daemon
 * update owner reads the installed record's own trusted channel, so whether a
 * Discover listing happens to be on screen has nothing to do with whether the
 * user can update what they already have.
 */
export type InstalledPluginActionId =
    | 'enable'
    | 'disable'
    | 'update'
    | 'rollback'
    | 'uninstall'
    | 'forgetTrust';

type ConfirmedPluginChangeAction = 'update' | 'rollback' | 'uninstall' | 'forgetTrust';
type CommitIntendedPluginChangeAction = 'install' | 'disable' | ConfirmedPluginChangeAction;
type PluginActionCountsByAuthority = Readonly<Record<string, Readonly<Record<string, number>>>>;
type DiscoverQueryIntent = Readonly<{
    cursor: string | null;
    mode: 'refresh' | 'more';
    text: string;
    sourceId: string | null;
    /** A listing page resolves exactly this source-qualified listing through the same query. */
    pluginId?: string | null;
}>;

export type PluginRoutineOperationSettlement = Readonly<{
    scope: 'installed' | 'discover' | 'pending' | 'development';
    message: string;
    detail?: string;
}>;

export type DevelopmentCreateSettlement =
    | Readonly<{
        status: 'success';
        created: Readonly<{ pluginId: string; sourceRootPath: string }>;
    }>
    | Readonly<{
        status: 'unavailable';
        reason: 'operationUnavailable' | 'authorityChanged' | 'requestFailed' | 'invalidResult';
    }>;

export type DevelopmentEditTargetSettlement =
    | Readonly<{
        status: 'success';
        target: Readonly<{ pluginId: string; sourceRootPath: string; sessionDirectory: string }>;
    }>
    | Readonly<{
        status: 'unavailable';
        reason: 'operationUnavailable' | 'authorityChanged' | 'requestFailed' | 'invalidResult';
    }>;

function resolvePluginChangeActionLabel(action: CommitIntendedPluginChangeAction): string {
    if (action === 'install') return t('common.install');
    if (action === 'update') return t('common.update');
    if (action === 'rollback') return t('settingsPlugins.rollback');
    if (action === 'uninstall') return t('settingsPlugins.uninstall');
    if (action === 'disable') return t('common.disable');
    return t('settingsPlugins.forgetTrust');
}

export type PluginSettingsScreenState = Readonly<{
    activeView: PluginSettingsViewId;
    administrationTargetSelection: MachineAdministrationTargetSelectionV1;
    administrationTargetLabel: Readonly<{ machine: string; server: string }> | null;
    currentDiagnostics: readonly { code: string; message: string }[];
    accountServerIdentityId: string | null;
    selectedServerIdentityId: string | null;
    executionServerIdentityId: string | null;
    executionServerId: string | null;
    executionMachineId: string | null;
    /**
     * The selected machine's reported home directory, so a canonical
     * development root can be shown `~`-relative exactly as an ordinary Session
     * working directory is. Absent home simply shows the absolute root.
     */
    executionMachineHomeDir: string | null;
    /** Rejects renderer-originated writes once this exact daemon target retires. */
    isDaemonSettingsTargetCurrent: (target: Extract<ScopedPluginSettingsTarget, { kind: 'daemon' }>) => boolean;
    discoverError: string | null;
    /** Draft search text for the aggregate Discover query. */
    discoverSearchText: string;
    /** The query the shown results answer; null until a query returns, not an empty result. */
    discoverResultsSearchText: string | null;
    /** Empties the search and shows every listing again (the "no match" Clear). */
    clearDiscoverSearch: () => void;
    canRefreshDiscover: boolean;
    canRunDiscoverActions: boolean;
    canRefreshInstalledPlugins: boolean;
    daemonOperationsAvailable: boolean;
    /** Exact daemon administration RPCs; independent of contribution projection readiness. */
    daemonAdministrationAvailable: boolean;
    developmentCreateAvailable: boolean;
    developmentSourceInstallAvailable: boolean;
    developmentPlugins: readonly DevelopmentPluginEntry[];
    discoverEntries: readonly PluginMarketplaceCatalogEntry[];
    discoverNextCursor: string | null;
    /** Selectable source chips beside All: enabled configured sources plus community npm. */
    discoverSources: readonly Readonly<{ id: string; title: string; kind: PluginMarketplaceCatalogSourceKind }>[];
    /** Per-source freshness the daemon actually had when it served the shown page. */
    discoverSourceStatuses: readonly PluginMarketplaceDiscoverSourceStatus[];
    /** Index-wide diagnostics for the shown page; never collapsed into one failure. */
    discoverDiagnostics: readonly PluginMarketplaceDiscoverDiagnostic[];
    /** Listings the daemon returned that this machine cannot install right now. */
    discoverNonInstallable: readonly PluginMarketplaceNonInstallableListing[];
    /** The shown list answers an earlier query than the controls now describe. */
    discoverStale: boolean;
    installedPluginById: ReadonlyMap<string, InstalledPluginEntry>;
    installedPlugins: readonly InstalledPluginEntry[];
    /** `null` is aggregate All: the query carries no source filter at all. */
    selectedDiscoverSourceId: string | null;
    loadingMoreDiscover: boolean;
    /** Daemon-held changes — including ones an Agent prepared — awaiting this user. */
    pendingPluginChanges: readonly PendingPluginChangeListing[];
    routineOperationSettlement: PluginRoutineOperationSettlement | null;
    decidePendingPluginChange: (pendingChangeId: string, decision: 'approve' | 'reject') => void;
    readOnlySnapshotNotice: PluginReadOnlySnapshotNoticeState | null;
    refreshPluginTruth: () => void;
    isPluginActionInFlight: (pluginId: string) => boolean;
    refreshDiscover: () => void;
    loadingDiscover: boolean;
    marketplaceSourceRegistry: MarketplaceSourceRegistryV1 | null;
    marketplaceSourceRegistryLoading: boolean;
    marketplaceSourceRegistryLoadError: boolean;
    marketplaceSourceRegistryMutationInFlight: boolean;
    marketplaceSourceRegistryMutationOutcomeUnknown: boolean;
    refreshMarketplaceSourceRegistry: () => void;
    upsertMarketplaceSource: MarketplaceSourceRegistryAdministrationV1['upsertSource'];
    setMarketplaceSourceEnabled: MarketplaceSourceRegistryAdministrationV1['setSourceEnabled'];
    removeMarketplaceSource: MarketplaceSourceRegistryAdministrationV1['removeSource'];
    pluginProjectionById: ReturnType<typeof useDaemonMergedProjectionInputs>['inputs'] extends infer TInputs
        ? TInputs extends { pluginProjectionById: infer TProjectionById }
            ? TProjectionById
            : Record<string, never>
        : Record<string, never>;
    /** Current exact daemon projection only; stale cache never authorizes execution. */
    pluginProjectionV2: PluginProjectionV2 | null;
    /** True only when the selected daemon has authoritatively answered both installed and projected plugin truth. */
    pluginTruthSettled: boolean;
    /**
     * Whether the selected machine has answered what it has installed. The Installed list waits on
     * this read alone (not on the contribution projection, which only enriches a plugin's detail),
     * so a slow or failed projection never leaves the list loading.
     */
    installedPluginsRead: boolean;
    registryDiagnostics: ReturnType<typeof useDaemonMergedProjectionInputs>['inputs'] extends infer TInputs
        ? TInputs extends { registryDiagnostics: infer TDiagnostics }
            ? TDiagnostics
            : readonly []
        : readonly [];
    runCatalogAction: (params: PluginMarketplaceActionRequest) => void;
    runDevelopmentCreate: (params: Readonly<{
        targetDir: string;
        displayName: string;
        pluginId: string;
        ui?: PluginScaffoldUiMode;
    }>) => Promise<DevelopmentCreateSettlement>;
    resolveDevelopmentEditTarget: (pluginId: string) => Promise<DevelopmentEditTargetSettlement>;
    runDevelopmentSourceInstall: (sourceRootPath: string) => void;
    runDevelopmentAction: (action: 'test' | 'pack' | 'unregister', pluginId: string) => void;
    runInstalledPluginAction: (action: InstalledPluginActionId, pluginId: string) => void;
    setInstalledPluginUpdatePolicy: (pluginId: string, policy: PluginUpdatePolicyV1) => void;
    setActiveView: (view: PluginSettingsViewId) => void;
    setDiscoverSearchText: (value: string) => void;
    setSelectedDiscoverSourceId: (sourceId: string | null) => void;
    /**
     * Acquires one exact source-qualified listing (a listing page, a deep link) through the one
     * Discover query, so its Install acts under the same authority as a Browse card's.
     */
    openDiscoverListing: (listing: Readonly<{ sourceId: string; pluginId: string }>) => void;
    loadMoreDiscover: () => void;
    setMarketplaceSourceProfile: MarketplaceSourceRegistryAdministrationV1['setSourceRegistryProfile'];
}>;

export function usePluginSettingsScreenState(params: Readonly<{ focused?: boolean }> = {}): PluginSettingsScreenState {
    const activeServer = useActiveServerSnapshot();
    // The one administration-target owner. It supplies the selection, the exact
    // Settings/Secrets record target, and the single currentness fence every
    // asynchronous write re-checks — shared with the deep-linked Settings page
    // screen so the two cannot disagree about which machine is being edited.
    const {
        administration,
        selectedMachineScopeKey,
        daemonTransportOnline,
        daemonCacheFreshnessKey,
        machineCapabilities,
    } = usePluginsAdministrationTarget();
    const capabilityRequest = MARKETPLACE_CAPABILITY_REQUEST;
    const administrationTargetSelection = administration.selection;
    const accountServerIdentityId = React.useMemo(
        () => resolveScopedPluginSettingsServerIdentity(activeServer.serverId),
        [activeServer.serverId],
    );
    const executionTarget = administration.executionTarget;
    const selectedServerIdentityId = administration.selectedServerIdentityId;
    const executionMachineId = executionTarget?.machine.id ?? null;
    const executionMachineHomeDir = executionTarget?.machine.metadata?.homeDir ?? null;
    const executionServerId = executionTarget?.serverId ?? null;
    const executionServerIdentityId = executionTarget?.target.serverIdentityId ?? null;
    const { invokeWithAlerts } = useMachineCapabilityInvokeWithAlerts();

    /**
     * Every asynchronous daemon boundary re-resolves the portable target. A
     * rendered target is presentation state; this guard rejects a stale or
     * retired target before it can route an effect or mutation.
     */
    const resolveCurrentExecutionTarget = administration.resolveCurrentExecutionTarget;
    const isDaemonSettingsTargetCurrent = administration.isTargetCurrent;

    const [activeView, setActiveView] = React.useState<PluginSettingsViewId>('installed');
    /**
     * The Discover controls, split into the draft the user is editing and the
     * query the shown list actually answers.
     *
     * They are separate on purpose: typing must not re-query, and the list on
     * screen must be able to say honestly which text and which source it came
     * from even after the user has changed the controls again.
     */
    const [discoverSearchText, setDiscoverSearchText] = React.useState('');
    // `null` is aggregate All. Discover opens on All and stays there until the
    // user picks a chip; no configured "preferred" source silently narrows it.
    const [selectedDiscoverSourceId, setSelectedDiscoverSourceIdState] = React.useState<string | null>(null);
    const [acquiredDiscoverQuery, setAcquiredDiscoverQuery] = React.useState<Readonly<{
        text: string;
        sourceId: string | null;
    }> | null>(null);
    const [discoverEntries, setDiscoverEntries] = React.useState<readonly PluginMarketplaceCatalogEntry[]>([]);
    const [discoverNextCursor, setDiscoverNextCursor] = React.useState<string | null>(null);
    const [discoverRevision, setDiscoverRevision] = React.useState<number | null>(null);
    const [discoverSourceStatuses, setDiscoverSourceStatuses] = React.useState<
        readonly PluginMarketplaceDiscoverSourceStatus[]
    >([]);
    const [discoverDiagnostics, setDiscoverDiagnostics] = React.useState<
        readonly PluginMarketplaceDiscoverDiagnostic[]
    >([]);
    const [discoverNonInstallable, setDiscoverNonInstallable] = React.useState<
        readonly PluginMarketplaceNonInstallableListing[]
    >([]);
    const [discoverAuthorityKey, setDiscoverAuthorityKey] = React.useState<string | null>(null);
    const [loadingDiscover, setLoadingDiscover] = React.useState(false);
    const [loadingMoreDiscover, setLoadingMoreDiscover] = React.useState(false);
    const [discoverError, setDiscoverError] = React.useState<string | null>(null);
    const [hasLoadedDiscoverForScope, setHasLoadedDiscoverForScope] = React.useState<string | null>(null);
    const [projectionRefreshKey, setProjectionRefreshKey] = React.useState(0);
    const [pluginActionCountByAuthority, setPluginActionCountByAuthority] = React.useState<PluginActionCountsByAuthority>({});
    const [routineOperationSettlement, setRoutineOperationSettlement] = React.useState<PluginRoutineOperationSettlement | null>(null);
    const pluginActionCountByAuthorityRef = React.useRef<PluginActionCountsByAuthority>(
        pluginActionCountByAuthority,
    );

    const discoverRequestIdRef = React.useRef(0);
    const discoverQueryInFlightRef = React.useRef(false);
    const queuedDiscoverRefreshRef = React.useRef<DiscoverQueryIntent | null>(null);
    const runDiscoverQueryRef = React.useRef<(intent: DiscoverQueryIntent) => void>(() => {});
    const lastSelectedMachineScopeKeyRef = React.useRef<string | null>(selectedMachineScopeKey);
    const lastDiscoverMutationAuthorityKeyRef = React.useRef<string | null>(null);

    React.useEffect(() => {
        setRoutineOperationSettlement(null);
    }, [selectedMachineScopeKey]);

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
    /**
     * The exact machine and server a plugin change would land on. A plugin is
     * installed on ONE machine reached through ONE server, so a confirmation
     * that omits them describes a different action than the one it performs.
     * Naming stays with the Administration selection owner.
     */
    const selectedAdministrationTargetLabel = React.useMemo(() => (
        resolveMachineAdministrationTargetLabel({
            target: administrationTargetSelection.selectedTarget,
            candidates: administrationTargetSelection.candidates,
        })
    ), [administrationTargetSelection.candidates, administrationTargetSelection.selectedTarget]);
    const selectedAdministrationTargetLabelRef = React.useRef(selectedAdministrationTargetLabel);
    selectedAdministrationTargetLabelRef.current = selectedAdministrationTargetLabel;
    // An asynchronous decision names the EXACT target it routes to, which is
    // the resolved execution target rather than whatever is selected when the
    // daemon finally asks. The inventory still owns the naming.
    const administrationCandidatesRef = React.useRef(administrationTargetSelection.candidates);
    administrationCandidatesRef.current = administrationTargetSelection.candidates;
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
    const daemonOperationAvailability = resolvePluginDaemonOperationsAvailability({
        hasExactExecutionTarget: executionTarget !== null,
        daemonTransportOnline,
        capabilityStateIsCurrent: currentDaemonCapabilitiesState === machineCapabilities.state,
        capabilityState: machineCapabilities.state,
        projectionPhase: daemonMergedProjection.phase,
    });
    const daemonAdministrationAvailable = daemonOperationAvailability.administration;
    const daemonOperationsAvailable = daemonOperationAvailability.projection;
    const mutationAuthorityKey = daemonOperationsAvailable && selectedMachineScopeKey
        ? `${selectedMachineScopeKey}:${daemonCacheFreshnessKey}`
        : null;
    const mutationAuthorityKeyRef = React.useRef(mutationAuthorityKey);
    mutationAuthorityKeyRef.current = mutationAuthorityKey;
    React.useEffect(() => {
        if (lastDiscoverMutationAuthorityKeyRef.current === mutationAuthorityKey) return;
        lastDiscoverMutationAuthorityKeyRef.current = mutationAuthorityKey;
        discoverRequestIdRef.current += 1;
        discoverQueryInFlightRef.current = false;
        queuedDiscoverRefreshRef.current = null;
        setLoadingDiscover(false);
        setLoadingMoreDiscover(false);
    }, [mutationAuthorityKey]);
    /**
     * The machine's configured marketplace sources, read through the one
     * registry owner this screen shares with the Sources & registries
     * administration screen. Discover only reads it; every write to it is
     * issued through the same owner — from that screen, or from the registry
     * selection an install owes, which binds the listing's source there.
     */
    const marketplaceSourceRegistryAdministration = useMarketplaceSourceRegistryAdministration({
        scopeKey: selectedMachineScopeKey,
        enabled: daemonAdministrationAvailable,
        focused: params.focused ?? true,
        executionTarget,
        resolveCurrentExecutionTarget,
    });
    const marketplaceSourceRegistry = marketplaceSourceRegistryAdministration.registry;
    const setMarketplaceSourceProfile = marketplaceSourceRegistryAdministration.setSourceRegistryProfile;
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
    const { pluginTruthSettled, targetResolving, installedPluginsRead } = resolvePluginTruthReadState({
        targetOnline: administrationTargetSelection.state.kind === 'online',
        hasExecutionTarget: executionTarget !== null,
        capabilitiesLoaded: machineCapabilities.state.status === 'loaded',
        daemonAdministrationAvailable,
        projectionPhase: daemonMergedProjection.phase,
    });
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
        hasCatalog: discoverEntries.length > 0,
        hasMarketplaceSourceRegistry: marketplaceSourceRegistry !== null,
        hasProjectionInputs: projectionInputs !== null,
        targetResolving,
        capabilityReadFailed: machineCapabilities.state.status === 'error'
            || machineCapabilities.state.status === 'not-supported'
            || (machineCapabilities.state.status === 'loaded'
                && currentDaemonCapabilitiesState === machineCapabilities.state
                && !daemonAdministrationAvailable),
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
        if (readOnlySnapshotNotice?.reason === 'installationUnavailable') {
            machineCapabilities.refresh({ bypassCache: true });
        }
        publishMachineContributionRegistryProjectionInvalidation({
            machineId: currentTarget.machine.id,
            serverId: currentTarget.serverId,
        });
    }, [executionTarget, machineCapabilities.refresh, readOnlySnapshotNotice?.reason, resolveCurrentExecutionTarget]);
    /**
     * Reconciles one commit-intended mutation whose outcome the daemon could
     * not confirm, against the exact original target only.
     *
     * The refresh re-reads the ORIGINAL target the user acted on — never
     * another machine, so an ambiguous install cannot be answered by whatever
     * a different machine happens to have. When the refresh proves the change
     * landed the user gets the success answer; otherwise they get the truthful
     * unresolved copy naming the exact machine and server, never a false
     * failure and never an invitation to retry a change that may have
     * committed. `probe` is null when no caller-known installed identity
     * exists (a project-source trust), so the refresh itself is all the
     * reconciliation that can be offered.
     */
    const reconcileCommitIntendedMutation = React.useCallback(async (params: Readonly<{
        target: FreshMachineAdministrationExecutionTargetV1;
        isAuthorityCurrent: () => boolean;
        settlementScope: PluginRoutineOperationSettlement['scope'];
        successMessage: string;
        actionLabel: string;
        name: string;
        probe: Readonly<{
            method: 'install' | 'update' | 'rollback' | 'uninstall' | 'forgetTrust' | 'disable';
            pluginId: string;
            before: InstalledPluginEntry | null;
            targetVersion: string | null;
        }> | null;
    }>): Promise<void> => {
        const showUnresolvedOutcome = () => {
            const label = resolveMachineAdministrationTargetLabel({
                target: params.target.target,
                candidates: administrationCandidatesRef.current,
            }) ?? { machine: params.target.machine.id, server: params.target.serverId };
            Modal.alert(
                t('settingsPlugins.pluginChangeOutcomeUnknownTitle'),
                t('settingsPlugins.pluginChangeOutcomeUnknownBody', {
                    action: params.actionLabel,
                    name: params.name,
                    machine: label.machine,
                    server: label.server,
                }),
            );
        };
        try {
            await prefetchMachineCapabilities({
                machineId: params.target.machine.id,
                serverId: params.target.serverId,
                cacheKeySalt: daemonCacheFreshnessKey,
                request: {
                    ...capabilityRequest,
                    bypassCache: true,
                },
            });
        } catch {
            if (params.isAuthorityCurrent()) {
                refreshPluginTruth();
                showUnresolvedOutcome();
            }
            return;
        }
        if (!params.isAuthorityCurrent()) return;

        const refreshedState = getMachineCapabilitiesCacheState(
            params.target.machine.id,
            params.target.serverId,
            daemonCacheFreshnessKey,
        );
        refreshPluginTruth();
        const probe = params.probe;
        if (refreshedState?.status !== 'loaded' || probe === null) {
            showUnresolvedOutcome();
            return;
        }
        const installedAfter = readInstalledPlugins(refreshedState)
            .find((entry) => entry.pluginId === probe.pluginId) ?? null;
        if (isPluginMutationVisibleAfterRefresh({
            method: probe.method,
            pluginId: probe.pluginId,
            before: probe.before,
            after: installedAfter,
            targetVersion: probe.targetVersion,
        })) {
            setRoutineOperationSettlement({
                scope: params.settlementScope,
                message: params.successMessage,
            });
        } else {
            showUnresolvedOutcome();
        }
    }, [capabilityRequest, daemonCacheFreshnessKey, refreshPluginTruth]);
    /**
     * Source chips beside All: every enabled configured source, plus the
     * synthesized community npm discovery source.
     *
     * A persisted registry source is `user` or `curated`; community npm is not
     * a configurable index at all, which is why it is named here rather than
     * expected to appear in the machine's registry. A registry that nonetheless
     * carries that id is the same one built-in source, so it is dropped rather
     * than shown a second time under a duplicate filter id.
     */
    const discoverSources = React.useMemo(() => {
        const configured: readonly Readonly<{
            id: string;
            title: string;
            kind: PluginMarketplaceCatalogSourceKind;
        }>[] = (marketplaceSourceRegistry?.sources ?? [])
            .filter((source) => source.enabled && source.id !== COMMUNITY_NPM_DISCOVER_SOURCE_ID)
            .map((source) => ({ id: source.id, title: source.title, kind: source.origin }));
        return [
            ...configured,
            {
                id: COMMUNITY_NPM_DISCOVER_SOURCE_ID,
                title: t('settingsPlugins.communityNpmSourceTitle'),
                kind: 'community-npm' as const,
            },
        ];
    }, [marketplaceSourceRegistry]);
    const canRefreshInstalledPlugins = daemonOperationsAvailable;
    const canRunDiscoverActions = canRefreshInstalledPlugins
        && discoverAuthorityKey !== null
        && discoverAuthorityKey === mutationAuthorityKey;
    const canRefreshDiscover = daemonOperationsAvailable && !loadingDiscover && !loadingMoreDiscover;
    /**
     * Whether the list on screen still answers the controls above it. A search
     * the user has retyped, or a source chip they have since changed, must not
     * be presented as the result of what the controls currently say.
     */
    const discoverStale = acquiredDiscoverQuery !== null
        && (acquiredDiscoverQuery.text !== discoverSearchText.trim()
            || acquiredDiscoverQuery.sourceId !== selectedDiscoverSourceId);

    React.useEffect(() => {
        if (lastSelectedMachineScopeKeyRef.current === selectedMachineScopeKey) {
            return;
        }

        lastSelectedMachineScopeKeyRef.current = selectedMachineScopeKey;
        discoverRequestIdRef.current += 1;
        discoverQueryInFlightRef.current = false;
        queuedDiscoverRefreshRef.current = null;
        setLoadingDiscover(false);
        setLoadingMoreDiscover(false);
        setDiscoverEntries([]);
        setDiscoverNextCursor(null);
        setDiscoverRevision(null);
        setDiscoverSourceStatuses([]);
        setDiscoverDiagnostics([]);
        setDiscoverNonInstallable([]);
        setAcquiredDiscoverQuery(null);
        setSelectedDiscoverSourceIdState(null);
        setDiscoverAuthorityKey(null);
        setDiscoverError(null);
        setHasLoadedDiscoverForScope(null);
    }, [selectedMachineScopeKey]);

    const markPluginActionStarted = React.useCallback((authorityKey: string, pluginId: string) => {
        setRoutineOperationSettlement(null);
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
        timeoutMs: null,
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
                    review: params.installationReview.review,
                    reason: params.installationReview.reason,
                    currentVersion: params.installationReview.currentVersion,
                    authorityExpansion: params.installationReview.authorityExpansion,
                    target: resolveMachineAdministrationTargetLabel({
                        target: params.target.target,
                        candidates: administrationCandidatesRef.current,
                    }) ?? {
                        machine: params.target.machine.id,
                        server: params.target.serverId,
                    },
                });
                return resolution.approved ? resolution.optionalSelections : null;
            },
        },
    }), []);

    /**
     * Asks the present user to trust a development project source.
     *
     * The locator is the entire security payload of this decision — the daemon
     * has not been allowed to read that folder yet, so there is no package
     * identity to show — and it is therefore echoed verbatim. A locator is a
     * location on ONE machine reached through ONE server, so it is named beside
     * the target the same Administration owner supplies to every other
     * machine-scoped confirmation on this screen.
     */
    const decidePluginProjectTrustAsPresentUser = React.useCallback(async (params: Readonly<{
        target: FreshMachineAdministrationExecutionTargetV1;
        isAuthorityCurrent: () => boolean;
        projectTrustReview: PendingPluginDevelopmentProjectTrustReview;
    }>): Promise<MachinePluginInstallDecisionResult> => await machinePluginInstallDecision(params.target.machine.id, {
        serverId: params.target.serverId,
        timeoutMs: null,
        isAuthorityCurrent: params.isAuthorityCurrent,
        decision: {
            pendingChangeId: params.projectTrustReview.pendingChangeId,
            decision: 'installAndTrust',
            confirmPresentUser: async () => await Modal.confirm(
                    t('settingsPlugins.developmentTrustProjectSourceTitle'),
                    t('settingsPlugins.developmentTrustProjectSourceBody', {
                        path: params.projectTrustReview.review.source.locator,
                        ...(resolveMachineAdministrationTargetLabel({
                            target: params.target.target,
                            candidates: administrationCandidatesRef.current,
                        }) ?? {
                            machine: params.target.machine.id,
                            server: params.target.serverId,
                        }),
                    }),
                    {
                        confirmText: t('settingsPlugins.developmentTrustProjectSourceConfirm'),
                        cancelText: t('common.cancel'),
                    },
                ) ? [] : null,
        },
    }), []);

    /** Answers one daemon review with one present-user decision. */
    const decidePendingPluginChangeAsPresentUser = React.useCallback(async (params: Readonly<{
        target: FreshMachineAdministrationExecutionTargetV1;
        isAuthorityCurrent: () => boolean;
        decision: PendingPluginChangeDecision;
        settlementScope: PluginRoutineOperationSettlement['scope'];
        successMessage: string;
        formatFailure: (outcome: string) => string;
    }>): Promise<void> => {
        let current = params.decision;
        while (true) {
            const response: MachinePluginInstallDecisionResult = current.kind === 'projectTrust'
                ? await decidePluginProjectTrustAsPresentUser({
                    target: params.target,
                    isAuthorityCurrent: params.isAuthorityCurrent,
                    projectTrustReview: current.projectTrustReview,
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
            if (outcome.kind === 'committed' || outcome.kind === 'projectTrustAccepted') {
                setRoutineOperationSettlement({
                    scope: params.settlementScope,
                    message: params.successMessage,
                });
                machineCapabilities.refresh({ bypassCache: true });
                refreshPluginTruth();
                return;
            }
            if (outcome.kind === 'reviewRequired') {
                const continuation = readPendingPluginChangeDecision(outcome.change);
                if (
                    current.kind === 'projectTrust'
                    && continuation?.kind === 'installation'
                    && continuation.installationReview.reason === 'authorityExpansion'
                    && continuation.installationReview.authorityExpansion.length > 0
                ) {
                    current = continuation;
                    continue;
                }
            }
            if (outcome.kind === 'outcomeUnknown') {
                // Approving is commit-intended: the daemon may have applied the
                // change after the decision left this device. Reconcile against
                // the exact original target instead of presenting a false failure.
                if (current.kind === 'installation') {
                    const review = current.installationReview.review;
                    const before = installedPluginByIdRef.current.get(review.pluginId) ?? null;
                    await reconcileCommitIntendedMutation({
                        target: params.target,
                        isAuthorityCurrent: params.isAuthorityCurrent,
                        settlementScope: params.settlementScope,
                        successMessage: params.successMessage,
                        actionLabel: t('settingsPlugins.installAndTrust'),
                        name: review.displayName,
                        probe: {
                            method: before === null ? 'install' : 'update',
                            pluginId: review.pluginId,
                            before,
                            targetVersion: review.version,
                        },
                    });
                } else {
                    // Project trust has no caller-known plugin identity yet, so
                    // refresh is the only available reconciliation.
                    await reconcileCommitIntendedMutation({
                        target: params.target,
                        isAuthorityCurrent: params.isAuthorityCurrent,
                        settlementScope: params.settlementScope,
                        successMessage: params.successMessage,
                        actionLabel: t('settingsPlugins.developmentTrustProjectSourceConfirm'),
                        name: current.projectTrustReview.review.source.locator,
                        probe: null,
                    });
                }
                return;
            }
            Modal.alert(
                t('common.error'),
                params.formatFailure(outcome.kind === 'reviewRequired' ? outcome.kind : outcome.detail ?? outcome.kind),
            );
            machineCapabilities.refresh({ bypassCache: true });
            refreshPluginTruth();
            return;
        }
    }, [
        decidePluginInstallationReviewAsPresentUser,
        decidePluginProjectTrustAsPresentUser,
        machineCapabilities,
        reconcileCommitIntendedMutation,
        refreshPluginTruth,
    ]);

    const runCatalogAction = React.useCallback((params: PluginMarketplaceActionRequest) => {
        const initialTarget = resolveCurrentExecutionTarget(executionTarget);
        const accountCurrentness = captureActiveServerAccountScopeCurrentness();
        if (
            !mutationAuthorityKey
            || mutationAuthorityKeyRef.current !== mutationAuthorityKey
            || !initialTarget
            || isPluginActionInFlight(params.pluginId)
        ) {
            return;
        }
        const installedBefore = installedPluginByIdRef.current.get(params.pluginId) ?? null;
        // Only an exact catalog install is answerable from a listing. An update is
        // answered by the installed record at its canonical owner, so the listing
        // never becomes that action's authority or its success target.
        const exactInstallEntry = params.method === 'install'
            ? discoverEntries.find((entry) => (
                entry.id === params.pluginId && entry.sourceId === params.sourceId
            )) ?? null
            : null;
        if (
            params.method === 'rollback'
            && installedBefore?.rollbackAvailability !== 'available'
        ) {
            return;
        }
        if (params.method === 'install') {
            if (
                discoverAuthorityKey !== mutationAuthorityKey
                || exactInstallEntry?.installable !== true
                || installedBefore !== null
            ) {
                return;
            }
        }
        if (params.method === 'update' && installedBefore === null) {
            return;
        }
        if (
            params.method === 'setUpdatePolicy'
            && (
                installedBefore === null
                || params.policy === undefined
                || installedBefore.install.updatePolicy === params.policy
            )
        ) {
            return;
        }

        void (async () => {
            markPluginActionStarted(mutationAuthorityKey, params.pluginId);
            try {
                const isAuthorityCurrent = () => (
                    accountCurrentness.isCurrent()
                    && mutationAuthorityKeyRef.current === mutationAuthorityKey
                    && resolveCurrentExecutionTarget(initialTarget) !== null
                );
                const commitAction: CommitIntendedPluginChangeAction | null = params.method === 'install'
                    || params.method === 'update'
                    || params.method === 'rollback'
                    || params.method === 'uninstall'
                    || params.method === 'disable'
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
                /**
                 * Reconciliation could not establish whether the change landed.
                 * That is not the same fact as "it failed": the daemon may have
                 * committed it. The shared reconciler re-reads only the exact
                 * original target and answers with success or the truthful
                 * unresolved copy — never a false failure, never an invitation
                 * to retry a change that may have committed.
                 */
                const reconcileAmbiguousMutation = async (targetVersion: string | null) => {
                    if (!commitAction) return;
                    await reconcileCommitIntendedMutation({
                        target: initialTarget,
                        isAuthorityCurrent,
                        settlementScope: params.method === 'install' ? 'discover' : 'installed',
                        successMessage: t('common.done'),
                        actionLabel: resolvePluginChangeActionLabel(commitAction),
                        name: installedBefore?.title ?? exactInstallEntry?.title ?? params.pluginId,
                        probe: {
                            method: commitAction,
                            pluginId: params.pluginId,
                            before: installedBefore,
                            targetVersion,
                        },
                    });
                };
                const requestChange = (managedResourceDispositions?: readonly ManagedResourceDispositionV1[]) => invokeWithAlerts({
                    machineId: initialTarget.machine.id,
                    serverId: initialTarget.serverId,
                    request: {
                        id: MARKETPLACE_CAPABILITY_ID,
                        method: params.method,
                        params: {
                            pluginId: params.pluginId,
                            ...(params.sourceId ? { sourceId: params.sourceId } : {}),
                            ...(params.policy ? { policy: params.policy } : {}),
                            ...(managedResourceDispositions ? { managedResourceDispositions } : {}),
                            // The npm package name of the exact listing this
                            // action was raised from. It comes from the entry
                            // this hook already resolved and validated, never
                            // from the caller and never derived from the
                            // plugin id, which an npm package need not match.
                            ...(exactInstallEntry ? { packageName: exactInstallEntry.packageName } : {}),
                        },
                    },
                    timeoutMs: null,
                    isAuthorityCurrent,
                    alerts: {
                        errorTitle: t('common.error'),
                        successTitle: t('common.success'),
                        deferAmbiguousOutcomeToCaller: commitAction !== null,
                        unsupportedMessage: (reason) => reason === 'not-supported' ? t('common.unavailable') : t('common.requestFailed'),
                        successMessage: null,
                    },
                });
                let response = await requestChange();
                if (!isAuthorityCurrent()) return;
                while ((params.method === 'disable' || params.method === 'uninstall')
                    && 'response' in response && response.response.ok) {
                    const resources = readPluginManagedResourceRemovalReview(response.response.result, params.method, params.pluginId);
                    if (!resources) break;
                    const dispositions = await reviewManagedResourceRemoval(resources);
                    if (!dispositions || !isAuthorityCurrent()) return;
                    // A renewed daemon census is a new consent question, never a replay of older acknowledgments.
                    response = await requestChange(dispositions);
                    if (!isAuthorityCurrent()) return;
                }
                // A registry selection the daemon names is answered by the
                // present user through the existing profile administration,
                // then the same change is requested again: the daemon either
                // prepares the Install and Trust review or names what is still
                // missing. Cancel ends the action with nothing fetched.
                while (
                    (params.method === 'install' || params.method === 'update')
                    && 'response' in response
                    && response.response.ok
                ) {
                    const registryRequirement = readPluginRegistryProfileRequirement(
                        response.response.result,
                        params.method,
                        params.pluginId,
                    );
                    if (!registryRequirement) break;
                    const proceed = await showPluginRegistryProfileSelectionDialog({
                        requirement: registryRequirement,
                        pluginName: installedBefore?.title ?? exactInstallEntry?.title ?? params.pluginId,
                        sourceId: params.sourceId ?? null,
                        target: resolveMachineAdministrationTargetLabel({
                            target: initialTarget.target,
                            candidates: administrationCandidatesRef.current,
                        }) ?? {
                            machine: initialTarget.machine.id,
                            server: initialTarget.serverId,
                        },
                        daemonOperationsAvailable: daemonAdministrationAvailable,
                        targetSelection: administrationTargetSelection,
                        sourceRegistry: {
                            scopeKey: selectedMachineScopeKey,
                            executionTarget: initialTarget,
                            resolveCurrentExecutionTarget,
                        },
                    });
                    // The selection may have rebound this machine's source; the
                    // screen's own registry read is refreshed either way.
                    marketplaceSourceRegistryAdministration.refresh();
                    if (!proceed || !isAuthorityCurrent()) return;
                    response = await requestChange();
                    if (!isAuthorityCurrent()) return;
                }

                if (!('response' in response)) {
                    if (commitAction && response.reason === 'error') {
                        await reconcileAmbiguousMutation(exactInstallEntry?.version ?? null);
                    }
                    return;
                }
                if (!response.response.ok) {
                    if (commitAction && response.response.error.code === 'outcomeUnknown') {
                        await reconcileAmbiguousMutation(exactInstallEntry?.version ?? null);
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
                        setRoutineOperationSettlement({
                            scope: params.method === 'install' ? 'discover' : 'installed',
                            message: t('common.done'),
                        });
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
                    const disabledNoop = params.method === 'disable'
                        && isPluginDisableNoopResult(response.response.result, params.pluginId);
                    if (changeKind !== 'committed' && !disabledNoop) {
                        if (changeKind === 'outcomeUnknown') {
                            await reconcileAmbiguousMutation(exactInstallEntry?.version ?? null);
                        } else {
                            showMutationFailure(changeKind ?? 'invalid-response');
                            if (changeKind === 'dataRemovalPartial') {
                                machineCapabilities.refresh({ bypassCache: true });
                                refreshPluginTruth();
                            }
                        }
                        return;
                    }
                    setRoutineOperationSettlement({
                        scope: params.method === 'install' ? 'discover' : 'installed',
                        message: t('common.done'),
                    });
                } else {
                    setRoutineOperationSettlement({
                        scope: params.method === 'install' ? 'discover' : 'installed',
                        message: t('common.done'),
                    });
                }
                machineCapabilities.refresh({ bypassCache: true });
                refreshPluginTruth();
            } finally {
                markPluginActionFinished(mutationAuthorityKey, params.pluginId);
            }
        })();
    }, [administrationTargetSelection, capabilityRequest, daemonAdministrationAvailable, decidePluginInstallationReviewAsPresentUser, discoverAuthorityKey, discoverEntries, executionTarget, invokeWithAlerts, isPluginActionInFlight, machineCapabilities, markPluginActionFinished, markPluginActionStarted, marketplaceSourceRegistryAdministration.refresh, mutationAuthorityKey, reconcileCommitIntendedMutation, refreshPluginTruth, resolveCurrentExecutionTarget, selectedMachineScopeKey]);

    const runInstalledPluginAction = React.useCallback((
        action: InstalledPluginActionId,
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
        const capabilities = projectInstalledPluginLifecycleCapabilities(installed);
        if (
            (action === 'enable' && !capabilities.canEnable)
            || (action === 'disable' && !capabilities.canDisable)
            || (action === 'update' && !capabilities.canUpdate)
            || (action === 'rollback' && !capabilities.canRollback)
            || (action === 'uninstall' && !capabilities.canUninstall)
            || (action === 'forgetTrust' && !capabilities.canForgetTrust)
        ) {
            return;
        }
        // Update is the same canonical daemon action wherever it is started
        // from, so it goes straight to its owner: the daemon either commits it
        // under the installed record's policy or hands back the install-and-trust
        // review this screen already knows how to present. A second local
        // confirmation before that review would ask the same question twice.
        if (action === 'enable' || action === 'disable' || action === 'update') {
            runCatalogAction({
                method: action,
                pluginId,
            });
            return;
        }
        const actionLabel = resolvePluginChangeActionLabel(action);
        const target = selectedAdministrationTargetLabelRef.current;
        if (!target) return;
        void (async () => {
            const confirmed = await Modal.confirm(
                actionLabel,
                t('settingsPlugins.pluginChangeConfirmBody', {
                    action: actionLabel,
                    name: installed.title,
                    machine: target.machine,
                    server: target.server,
                }),
                {
                    confirmText: actionLabel,
                    cancelText: t('common.cancel'),
                    // Uninstall and forgetting trust discard state this screen
                    // cannot restore; rollback moves between versions it can.
                    destructive: action === 'uninstall' || action === 'forgetTrust',
                },
            );
            if (!confirmed) return;
            runCatalogAction({
                method: action,
                pluginId,
            });
        })();
    }, [isPluginActionInFlight, mutationAuthorityKey, runCatalogAction]);

    const setInstalledPluginUpdatePolicy = React.useCallback((
        pluginId: string,
        policy: PluginUpdatePolicyV1,
    ) => {
        runCatalogAction({ method: 'setUpdatePolicy', pluginId, policy });
    }, [runCatalogAction]);

    const runDevelopmentAction = React.useCallback((action: 'test' | 'pack' | 'unregister', pluginId: string) => {
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
                const response = await invokeWithAlerts({
                    machineId: initialTarget.machine.id,
                    serverId: initialTarget.serverId,
                    request: {
                        id: MARKETPLACE_CAPABILITY_ID,
                        method: action === 'unregister' ? 'unregisterDevelopment' : action,
                        params: action === 'unregister'
                            ? { sourceRootPath: development.sourceRootPath }
                            : { pluginId },
                    },
                    timeoutMs: null,
                    isAuthorityCurrent: () => (
                        mutationAuthorityKeyRef.current === mutationAuthorityKey
                        && resolveCurrentExecutionTarget(initialTarget) !== null
                    ),
                    alerts: {
                        errorTitle: t('common.error'),
                        successTitle: t('common.success'),
                        unsupportedMessage: (reason) => reason === 'not-supported' ? t('common.unavailable') : t('common.requestFailed'),
                        successMessage: null,
                    },
                });
                if (
                    response.supported
                    && 'response' in response
                    && response.response.ok
                    && mutationAuthorityKeyRef.current === mutationAuthorityKey
                    && resolveCurrentExecutionTarget(initialTarget) !== null
                ) {
                    setRoutineOperationSettlement({
                        scope: 'development',
                        message: action === 'test'
                            ? t('settingsPlugins.developmentTestSucceeded')
                            : action === 'pack'
                                ? t('settingsPlugins.developmentPackSucceeded')
                                : t('common.done'),
                    });
                }
                if (
                    action === 'unregister'
                    && response.supported
                    && 'response' in response
                    && response.response.ok
                ) {
                    machineCapabilities.refresh({ bypassCache: true });
                    refreshPluginTruth();
                }
            } finally {
                markPluginActionFinished(mutationAuthorityKey, pluginId);
            }
        })();
    }, [developmentPlugins, executionTarget, invokeWithAlerts, isPluginActionInFlight, machineCapabilities, markPluginActionFinished, markPluginActionStarted, mutationAuthorityKey, refreshPluginTruth, resolveCurrentExecutionTarget]);

    const resolveDevelopmentEditTarget = React.useCallback((
        pluginId: string,
    ): Promise<DevelopmentEditTargetSettlement> => {
        const initialTarget = resolveCurrentExecutionTarget(executionTarget);
        if (
            !mutationAuthorityKey
            || mutationAuthorityKeyRef.current !== mutationAuthorityKey
            || !initialTarget
            || !developmentPlugins.some((entry) => entry.installed.pluginId === pluginId)
        ) {
            return Promise.resolve({ status: 'unavailable', reason: 'operationUnavailable' });
        }

        return (async (): Promise<DevelopmentEditTargetSettlement> => {
            const isAuthorityCurrent = () => (
                mutationAuthorityKeyRef.current === mutationAuthorityKey
                && resolveCurrentExecutionTarget(initialTarget) !== null
            );
            const response = await invokeWithAlerts({
                machineId: initialTarget.machine.id,
                serverId: initialTarget.serverId,
                request: {
                    id: MARKETPLACE_CAPABILITY_ID,
                    method: 'edit',
                    params: { pluginId },
                },
                isAuthorityCurrent,
                alerts: {
                    errorTitle: t('common.error'),
                    successTitle: t('common.success'),
                    unsupportedMessage: (reason) => reason === 'not-supported'
                        ? t('common.unavailable')
                        : t('common.requestFailed'),
                    successMessage: null,
                },
            });
            if (!isAuthorityCurrent()) {
                return { status: 'unavailable', reason: 'authorityChanged' };
            }
            if (!('response' in response) || !response.response.ok) {
                return { status: 'unavailable', reason: 'requestFailed' };
            }
            const target = readPluginEditTargetResult(response.response.result, pluginId);
            if (!target) {
                Modal.alert(t('common.error'), t('common.requestFailed'));
                return { status: 'unavailable', reason: 'invalidResult' };
            }
            return { status: 'success', target };
        })();
    }, [developmentPlugins, executionTarget, invokeWithAlerts, mutationAuthorityKey, resolveCurrentExecutionTarget]);

    const runDevelopmentCreate = React.useCallback((params: Readonly<{
        targetDir: string;
        displayName: string;
        pluginId: string;
        ui?: PluginScaffoldUiMode;
    }>): Promise<DevelopmentCreateSettlement> => {
        const initialTarget = resolveCurrentExecutionTarget(executionTarget);
        if (
            !mutationAuthorityKey
            || mutationAuthorityKeyRef.current !== mutationAuthorityKey
            || !developmentCreateAvailable
            || !initialTarget
            || isPluginActionInFlight(params.pluginId)
        ) {
            return Promise.resolve({ status: 'unavailable', reason: 'operationUnavailable' });
        }

        return (async (): Promise<DevelopmentCreateSettlement> => {
            markPluginActionStarted(mutationAuthorityKey, params.pluginId);
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
                        method: 'create',
                        params: {
                            targetDir: params.targetDir,
                            displayName: params.displayName,
                            pluginId: params.pluginId,
                            ...(params.ui ? { ui: params.ui } : {}),
                        },
                    },
                    timeoutMs: null,
                    isAuthorityCurrent,
                    alerts: {
                        errorTitle: t('common.error'),
                        successTitle: t('common.success'),
                        unsupportedMessage: (reason) => reason === 'not-supported' ? t('common.unavailable') : t('common.requestFailed'),
                        successMessage: null,
                    },
                });
                if (!isAuthorityCurrent()) {
                    return { status: 'unavailable', reason: 'authorityChanged' };
                }
                if (!('response' in response) || !response.response.ok) {
                    return { status: 'unavailable', reason: 'requestFailed' };
                }
                const created = readPluginCreateResult(response.response.result);
                // Only the daemon's returned source root seeds a follow-on
                // flow; an unparseable result never falls back to the folder
                // the prompt collected.
                if (!created) {
                    Modal.alert(t('common.error'), t('common.requestFailed'));
                    return { status: 'unavailable', reason: 'invalidResult' };
                }
                return { status: 'success', created };
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
                    timeoutMs: null,
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
                    setRoutineOperationSettlement({
                        scope: 'development',
                        message: t('settingsPlugins.developmentSourceInstallSucceeded'),
                        detail: trimmedSourceRootPath,
                    });
                    machineCapabilities.refresh({ bypassCache: true });
                    refreshPluginTruth();
                    return;
                }
                await decidePendingPluginChangeAsPresentUser({
                    target: initialTarget,
                    isAuthorityCurrent,
                    decision: developChange,
                    settlementScope: 'development',
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
     * project-source trust and any authority expansion are the present user's decisions. The
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
                    timeoutMs: null,
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
                    setRoutineOperationSettlement({
                        scope: 'pending',
                        message: t('settingsPlugins.pendingChangeApplying'),
                    });
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
                    if (status.outcome === 'committed') {
                        // The change owner answered `committed` — possibly a
                        // decision another client already made. The applied
                        // state is the success answer; re-presenting it as a
                        // failure would be untrue.
                        setRoutineOperationSettlement({
                            scope: 'pending',
                            message: t('settingsPlugins.pendingChangeCommitted'),
                        });
                        machineCapabilities.refresh({ bypassCache: true });
                        refreshPluginTruth();
                        return;
                    }
                    if (status.outcome === 'outcomeUnknown') {
                        // The change is terminal but its outcome could not be
                        // confirmed. Reconcile the exact original target's own
                        // installed truth before anything is shown; an
                        // unproven landing stays the truthful unresolved copy,
                        // never a false "was not applied".
                        const probePluginId = status.pluginId;
                        await reconcileCommitIntendedMutation({
                            target: initialTarget,
                            isAuthorityCurrent,
                            settlementScope: 'pending',
                            successMessage: t('settingsPlugins.pendingChangeCommitted'),
                            actionLabel: t('settingsPlugins.installAndTrust'),
                            name: probePluginId ?? trimmedPendingChangeId,
                            probe: probePluginId === null ? null : {
                                method: installedPluginByIdRef.current.has(probePluginId) ? 'update' : 'install',
                                pluginId: probePluginId,
                                before: installedPluginByIdRef.current.get(probePluginId) ?? null,
                                targetVersion: null,
                            },
                        });
                        return;
                    }
                    reportOutcome(t('settingsPlugins.pendingChangeFailed', { outcome: status.outcome }));
                    return;
                }

                if (decision === 'reject') {
                    // A rejection is a consequential machine-scoped operation,
                    // so its confirmation names the exact server and machine
                    // the prepared change would be discarded on — the same
                    // Administration-owned facts every other confirmation on
                    // this screen carries.
                    const label = resolveMachineAdministrationTargetLabel({
                        target: initialTarget.target,
                        candidates: administrationCandidatesRef.current,
                    }) ?? { machine: initialTarget.machine.id, server: initialTarget.serverId };
                    const confirmed = await Modal.confirm(
                        t('approvals.reject'),
                        t('settingsPlugins.pendingChangeConfirmRejectBody', {
                            machine: label.machine,
                            server: label.server,
                        }),
                        { confirmText: t('approvals.reject'), cancelText: t('common.cancel'), destructive: true },
                    );
                    if (!confirmed || !isAuthorityCurrent()) return;
                    const rejection = await machinePluginInstallDecision(initialTarget.machine.id, {
                        serverId: initialTarget.serverId,
                        timeoutMs: null,
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
                        setRoutineOperationSettlement({
                            scope: 'pending',
                            message: t('settingsPlugins.pendingChangeRejected'),
                        });
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
                    settlementScope: 'pending',
                    successMessage: t('common.done'),
                    formatFailure: (outcome) => t('settingsPlugins.pendingChangeFailed', { outcome }),
                });
            } finally {
                markPluginActionFinished(mutationAuthorityKey, trimmedPendingChangeId);
            }
        })();
    }, [decidePendingPluginChangeAsPresentUser, executionTarget, invokeWithAlerts, isPluginActionInFlight, machineCapabilities, markPluginActionFinished, markPluginActionStarted, mutationAuthorityKey, reconcileCommitIntendedMutation, refreshPluginTruth, resolveCurrentExecutionTarget]);

    /**
     * The one Discover query: an aggregate marketplace index query with real
     * search text over every enabled source, or narrowed to the selected source
     * chip before acquisition through the daemon's own query filter.
     *
     * The text and source are passed in rather than read from the closure, so a
     * chip press queries the source it just selected instead of the previous
     * one. Last-known-good entries stay on screen through a refresh and through
     * a failure — a page that never arrived does not make what the user was
     * already reading untrue — and a continuation page whose revision differs
     * from the loaded one is discarded with its cursor rather than mixing
     * revisions into the list.
     */
    const runDiscoverQuery = React.useCallback(async (params: DiscoverQueryIntent) => {
        if (discoverQueryInFlightRef.current) {
            // Source/search refreshes are user intent, so retain exactly the
            // latest one while the current acquisition settles. Continuation
            // requests are never queued behind another page.
            if (params.mode === 'refresh') queuedDiscoverRefreshRef.current = params;
            return;
        }
        const initialTarget = resolveCurrentExecutionTarget(executionTarget);
        if (
            !mutationAuthorityKey
            || mutationAuthorityKeyRef.current !== mutationAuthorityKey
            || !initialTarget
        ) {
            return;
        }

        discoverQueryInFlightRef.current = true;
        const requestId = ++discoverRequestIdRef.current;
        if (params.mode === 'more') {
            setLoadingMoreDiscover(true);
        } else {
            setLoadingDiscover(true);
        }
        if (params.mode === 'refresh') setDiscoverError(null);

        const trimmedText = params.text.trim();
        try {
            const result = await machineMarketplaceIndexQuery(initialTarget.machine.id, {
                text: trimmedText,
                cursor: params.cursor,
                limit: DISCOVER_PAGE_SIZE,
                filters: buildDiscoverQueryFilters(params),
            }, {
                serverId: initialTarget.serverId,
                timeoutMs: null,
            });
            if (
                discoverRequestIdRef.current !== requestId
                || mutationAuthorityKeyRef.current !== mutationAuthorityKey
                || !resolveCurrentExecutionTarget(initialTarget)
            ) return;
            // A revision change invalidates the cursor chain: keep the
            // last-known-good rows but discard this page together with its
            // cursor, so the stale list cannot request another continuation
            // from an incompatible revision. A fresh query from cursor null
            // (search/refresh) may establish the new revision.
            if (params.mode === 'more' && discoverRevision !== null && result.revision !== discoverRevision) {
                setDiscoverNextCursor(null);
                setDiscoverError(t('settingsPlugins.discoverRevisionChanged'));
                return;
            }
            const page = projectDaemonMarketplaceIndexPage(result);
            setDiscoverAuthorityKey(mutationAuthorityKey);
            setDiscoverRevision(page.revision);
            setDiscoverNextCursor(page.nextCursor);
            setAcquiredDiscoverQuery({ text: trimmedText, sourceId: params.sourceId });
            setDiscoverEntries((previous) => (
                params.mode === 'more'
                    ? mergeDiscoverEntries(previous, page.entries)
                    : mergeDiscoverEntries([], page.entries)
            ));
            // Source truth follows the page it describes: a following page
            // re-reports the same sources, so replacing is correct and keeps a
            // retired source from lingering in the status strip.
            setDiscoverSourceStatuses(page.sources);
            setDiscoverDiagnostics(page.diagnostics);
            setDiscoverNonInstallable((previous) => (
                params.mode === 'more'
                    ? mergeDiscoverNonInstallableListings(previous, page.nonInstallable)
                    : mergeDiscoverNonInstallableListings([], page.nonInstallable)
            ));
        } catch {
            if (
                discoverRequestIdRef.current !== requestId
                || mutationAuthorityKeyRef.current !== mutationAuthorityKey
                || !resolveCurrentExecutionTarget(initialTarget)
            ) return;
            setDiscoverError(t('settingsPlugins.discover.diagnostic.recovery'));
        } finally {
            if (
                discoverRequestIdRef.current === requestId
                && mutationAuthorityKeyRef.current === mutationAuthorityKey
                && resolveCurrentExecutionTarget(initialTarget) !== null
            ) {
                discoverQueryInFlightRef.current = false;
                setLoadingDiscover(false);
                setLoadingMoreDiscover(false);
                const queuedRefresh = queuedDiscoverRefreshRef.current;
                queuedDiscoverRefreshRef.current = null;
                if (queuedRefresh) runDiscoverQueryRef.current(queuedRefresh);
            }
        }
    }, [discoverRevision, executionTarget, mutationAuthorityKey, resolveCurrentExecutionTarget]);
    runDiscoverQueryRef.current = (intent) => { void runDiscoverQuery(intent); };

    /**
     * Re-acquires the aggregate list for whatever the controls now say.
     *
     * The current entries are deliberately left on screen: this is a refresh of
     * a list the user is already reading, and blanking it would flash an empty
     * Discover every time someone pressed Search.
     */
    const refreshDiscover = React.useCallback(() => {
        setDiscoverNextCursor(null);
        setDiscoverRevision(null);
        void runDiscoverQuery({
            cursor: null,
            mode: 'refresh',
            text: discoverSearchText,
            sourceId: selectedDiscoverSourceId,
        });
    }, [discoverSearchText, runDiscoverQuery, selectedDiscoverSourceId]);

    /**
     * A source chip is a filter applied before acquisition, so selecting one is
     * itself the refresh intent. Selecting All returns to the unfiltered
     * aggregate query rather than to some previously preferred source.
     */
    const setSelectedDiscoverSourceId = React.useCallback((sourceId: string | null) => {
        setSelectedDiscoverSourceIdState(sourceId);
        setDiscoverNextCursor(null);
        setDiscoverRevision(null);
        void runDiscoverQuery({
            cursor: null,
            mode: 'refresh',
            text: discoverSearchText,
            sourceId,
        });
    }, [discoverSearchText, runDiscoverQuery]);

    const clearDiscoverSearch = React.useCallback(() => {
        setDiscoverSearchText('');
        setDiscoverNextCursor(null);
        setDiscoverRevision(null);
        void runDiscoverQuery({
            cursor: null,
            mode: 'refresh',
            text: '',
            sourceId: selectedDiscoverSourceId,
        });
    }, [runDiscoverQuery, selectedDiscoverSourceId]);

    const openDiscoverListing = React.useCallback((listing: Readonly<{ sourceId: string; pluginId: string }>) => {
        setDiscoverNextCursor(null);
        setDiscoverRevision(null);
        void runDiscoverQuery({
            cursor: null,
            mode: 'refresh',
            text: '',
            sourceId: listing.sourceId,
            pluginId: listing.pluginId,
        });
    }, [runDiscoverQuery]);

    const loadMoreDiscover = React.useCallback(() => {
        if (!discoverNextCursor || loadingMoreDiscover || loadingDiscover) return;
        // Paging continues the query the shown list was acquired with, never
        // the draft the user may have typed since.
        void runDiscoverQuery({
            cursor: discoverNextCursor,
            mode: 'more',
            text: acquiredDiscoverQuery?.text ?? discoverSearchText,
            sourceId: acquiredDiscoverQuery?.sourceId ?? selectedDiscoverSourceId,
        });
    }, [
        acquiredDiscoverQuery,
        discoverNextCursor,
        discoverSearchText,
        loadingDiscover,
        loadingMoreDiscover,
        runDiscoverQuery,
        selectedDiscoverSourceId,
    ]);

    // The first entry into Discover (or the first reconnect while it is open)
    // loads the aggregate page once; afterwards the user owns refreshes.
    React.useEffect(() => {
        if (activeView !== 'discover' || !daemonOperationsAvailable) return;
        if (hasLoadedDiscoverForScope === mutationAuthorityKey) return;
        setHasLoadedDiscoverForScope(mutationAuthorityKey);
        refreshDiscover();
    }, [activeView, daemonOperationsAvailable, hasLoadedDiscoverForScope, mutationAuthorityKey, refreshDiscover]);

    return {
        activeView,
        administrationTargetSelection,
        administrationTargetLabel: selectedAdministrationTargetLabel,
        currentDiagnostics,
        accountServerIdentityId,
        selectedServerIdentityId,
        executionServerIdentityId,
        executionServerId,
        executionMachineId,
        executionMachineHomeDir,
        isDaemonSettingsTargetCurrent,
        discoverEntries,
        discoverNextCursor,
        discoverSources,
        discoverSourceStatuses,
        discoverDiagnostics,
        discoverNonInstallable,
        discoverStale,
        selectedDiscoverSourceId,
        loadingMoreDiscover,
        discoverError,
        discoverSearchText,
        discoverResultsSearchText: acquiredDiscoverQuery?.text ?? null,
        clearDiscoverSearch,
        canRefreshDiscover,
        canRunDiscoverActions,
        canRefreshInstalledPlugins,
        daemonOperationsAvailable,
        daemonAdministrationAvailable,
        developmentCreateAvailable,
        developmentSourceInstallAvailable,
        developmentPlugins,
        installedPluginById,
        installedPlugins,
        pendingPluginChanges,
        routineOperationSettlement,
        decidePendingPluginChange,
        readOnlySnapshotNotice,
        refreshPluginTruth,
        isPluginActionInFlight,
        refreshDiscover,
        loadMoreDiscover,
        openDiscoverListing,
        loadingDiscover,
        marketplaceSourceRegistry,
        marketplaceSourceRegistryLoading: marketplaceSourceRegistryAdministration.loading,
        marketplaceSourceRegistryLoadError: marketplaceSourceRegistryAdministration.loadError,
        marketplaceSourceRegistryMutationInFlight: marketplaceSourceRegistryAdministration.mutationInFlight,
        marketplaceSourceRegistryMutationOutcomeUnknown: marketplaceSourceRegistryAdministration.mutationOutcomeUnknown,
        pluginProjectionById,
        pluginProjectionV2,
        pluginTruthSettled,
        installedPluginsRead,
        registryDiagnostics,
        runCatalogAction,
        runDevelopmentCreate,
        resolveDevelopmentEditTarget,
        runDevelopmentSourceInstall,
        runDevelopmentAction,
        runInstalledPluginAction,
        setInstalledPluginUpdatePolicy,
        setActiveView,
        setDiscoverSearchText,
        setSelectedDiscoverSourceId,
        setMarketplaceSourceProfile,
        refreshMarketplaceSourceRegistry: marketplaceSourceRegistryAdministration.refresh,
        upsertMarketplaceSource: marketplaceSourceRegistryAdministration.upsertSource,
        setMarketplaceSourceEnabled: marketplaceSourceRegistryAdministration.setSourceEnabled,
        removeMarketplaceSource: marketplaceSourceRegistryAdministration.removeSource,
    };
}
