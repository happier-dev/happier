import * as React from 'react';
import { useActivePluginAccountAvailabilityReader } from '@/sync/domains/plugins/availability/projection';

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
import { resolveScopedPluginSettingsServerIdentity } from '@/sync/domains/plugins/settings/scopedPluginSettingsRuntime';
import type { ScopedPluginSettingsTarget } from '@/sync/domains/plugins/settings/scopedPluginSettingsAdapter';
import { captureActiveServerAccountScopeCurrentness } from '@/sync/domains/scope/activeServerAccountScope';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { isActionApprovalDeclinedErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { CapabilitiesInvokeResponse } from '@happier-dev/protocol/capabilities';
import type { PluginDevLoopActionIdV1 } from '@happier-dev/protocol';
import { reviewManagedResourceRemoval } from '@/components/settings/machines/managed/reviewManagedResourceRemoval';
import type { ManagedResourceDispositionV1 } from '@happier-dev/protocol/machines/managed/managedDependencyV1';
import { useRegistryItems } from '@/registries/useRegistryItems';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { REGISTRY_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/registries';
import { type PluginProjectionV2, type PluginScaffoldUiMode } from '@happier-dev/protocol';
import {
    type PluginUpdatePolicyV1,
} from '@happier-dev/protocol/marketplace';
import { t } from '@/text';
import { presentActionTurnedOffNoticeIfOff } from '@/sync/ops/actions/actionTurnedOffNotice';
import { Modal } from '@/modal';

import {
    mergeDiscoverEntries,
    mergeDiscoverNonInstallableListings,
    projectRegistryMarketplacePage,
    registryPluginSourceKind,
    type PluginMarketplaceCatalogEntry,
    type PluginMarketplaceCatalogSourceKind,
    type PluginMarketplaceDiscoverDiagnostic,
    type PluginMarketplaceDiscoverSourceStatus,
    type PluginMarketplaceNonInstallableListing,
} from '../readPluginMarketplaceCatalog';
import { showPluginRegistryProfileSelectionDialog } from '../PluginRegistryProfileSelectionDialog';
import {
    usePluginRegistrySourceAdministration,
    type PluginRegistrySourceAdministrationV1,
    type MarketplaceSourceRegistryPresentationV1,
} from './usePluginRegistrySourceAdministration';
import {
    MARKETPLACE_CAPABILITY_ID,
    readDevelopmentCreateAvailable,
    readDevelopmentSourceInstallAvailable,
    readDevelopmentPlugins,
    readInstalledPlugins,
    projectAccountInstalledPlugins,
    isPluginMutationVisibleAfterRefresh,
    readPluginChangeFailureReason,
    readPluginChangeKind,
    projectPluginInstallActionResult,
    readPluginManagedResourceRemovalReview,
    isPluginDisableNoopResult,
    readPluginCreateResult,
    readPluginEditTargetResult,
    readPendingPluginChanges,
    resolvePluginDaemonOperationsAvailability,
    readPluginInstallationReviewChange,
    readPluginRegistryProfileRequirement,
    resolvePluginReadOnlySnapshotNotice,
    resolvePluginTruthReadState,
    type DevelopmentPluginEntry,
    projectInstalledPluginLifecycleCapabilities,
    type InstalledPluginEntry,
    type PendingPluginChangeListing,
    type PluginMarketplaceActionRequest,
    type PluginReadOnlySnapshotNoticeState,
    type PluginSettingsViewId,
} from './pluginMarketplaceModel';

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
    text: string;
    sourceId: string | null;
    /** A listing page resolves exactly this source-qualified listing through the same query. */
    pluginId?: string | null;
}>;
const EMPTY_DISCOVER_VALUES: readonly never[] = [];

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

function resolvePluginChangeActionLabel(action: PluginMarketplaceActionRequest['method']): string {
    if (action === 'install') return t('common.install');
    if (action === 'update' || action === 'setUpdatePolicy') return t('common.update');
    if (action === 'enable') return t('common.enable');
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
    marketplaceSourceRegistry: MarketplaceSourceRegistryPresentationV1 | null;
    marketplaceSourceRegistryAvailable: boolean;
    marketplaceSourceRegistryScopeKey: string | null;
    marketplaceSourceRegistryLoading: boolean;
    marketplaceSourceRegistryLoadError: boolean;
    marketplaceSourceRegistryMutationInFlight: boolean;
    marketplaceSourceRegistryMutationOutcomeUnknown: boolean;
    refreshMarketplaceSourceRegistry: () => void;
    upsertMarketplaceSource: PluginRegistrySourceAdministrationV1['upsertSource'];
    setMarketplaceSourceEnabled: PluginRegistrySourceAdministrationV1['setSourceEnabled'];
    removeMarketplaceSource: PluginRegistrySourceAdministrationV1['removeSource'];
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
    runDevelopmentAction: (action: 'test' | 'pack' | 'unregister', sourceRootPath: string) => void;
    runInstalledPluginAction: (action: InstalledPluginActionId, pluginId: string, scope?: 'account' | 'machine') => void;
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
    setMarketplaceSourceProfile: PluginRegistrySourceAdministrationV1['setSourceRegistryProfile'];
}>;

export function usePluginSettingsScreenState(params: Readonly<{ focused?: boolean }> = {}): PluginSettingsScreenState {
    const activeServer = useActiveServerSnapshot();
    const discoverExecution = useMountedActionExecution(activeServer.serverId, { openOnRequest: true });
    const discoverAccountKey = discoverExecution.binding ? JSON.stringify([
        discoverExecution.binding.scope.serverId, discoverExecution.binding.scope.accountId,
    ]) : null;
    const availabilityReader = useActivePluginAccountAvailabilityReader();
    const accountInstalledAdmission = React.useMemo(() => availabilityReader?.readInstalledPlugins() ?? null, [availabilityReader]);
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
    // Installed controls belong to the selected Machine's Home, which may
    // differ from the Account currently supplying Discover's registry reads.
    const installedExecution = useMountedActionExecution(executionTarget?.serverId, { openOnRequest: true });
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
    const [desiredDiscoverQuery, setDesiredDiscoverQuery] = React.useState<DiscoverQueryIntent | null>(null);
    const registryBrowse = useRegistryItems({ kind: 'plugin',
        ...(desiredDiscoverQuery?.sourceId ? { sourceIds: [desiredDiscoverQuery.sourceId] } : {}),
        query: desiredDiscoverQuery?.text.trim() ?? '',
    }, desiredDiscoverQuery !== null && discoverExecution.ready);
    // Rich cards are a projection of one Account/source snapshot, not authority
    // to keep a removed or retired source actionable while its replacement fails.
    const discoverDataKey = discoverAccountKey === null ? null
        : JSON.stringify([discoverAccountKey, registryBrowse.sourceRevision]);
    const [acquiredDiscoverQuery, setAcquiredDiscoverQuery] = React.useState<Readonly<{
        text: string;
        sourceId: string | null;
    }> | null>(null);
    const [discoverEntries, setDiscoverEntries] = React.useState<readonly PluginMarketplaceCatalogEntry[]>([]);
    const [discoverNextCursor, setDiscoverNextCursor] = React.useState<string | null>(null);
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
    const administeredInstalledPlugins = hasCapabilitySnapshot
        ? currentInstalledPlugins
        : lastKnownInstalledPluginsRef.current.installedPlugins;
    const installedPlugins = React.useMemo(() => projectAccountInstalledPlugins(administeredInstalledPlugins, accountInstalledAdmission), [accountInstalledAdmission, administeredInstalledPlugins]);
    const installedPluginById = React.useMemo(
        () => new Map(administeredInstalledPlugins.map((entry) => [entry.pluginId, entry] as const)),
        [administeredInstalledPlugins],
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
    // An asynchronous decision names the EXACT target it routes to, which is
    // the resolved execution target rather than whatever is selected when the
    // daemon finally asks. The inventory still owns the naming.
    const administrationCandidatesRef = React.useRef(administrationTargetSelection.candidates);
    administrationCandidatesRef.current = administrationTargetSelection.candidates;
    const currentDevelopmentPlugins = React.useMemo(
        () => readDevelopmentPlugins(machineCapabilities.state, administeredInstalledPlugins),
        [administeredInstalledPlugins, machineCapabilities.state],
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
    const daemonOperationsAvailableRef = React.useRef(daemonOperationsAvailable);
    daemonOperationsAvailableRef.current = daemonOperationsAvailable;
    // Readiness admits a new operation; refreshing its projection does not
    // retire an issued operation on the same selected daemon.
    const mutationAuthorityKey = executionTarget && selectedMachineScopeKey
        ? JSON.stringify([selectedMachineScopeKey, daemonCacheFreshnessKey,
            executionTarget.machine.installationId, executionTarget.selectionRevision])
        : null;
    const mutationAuthorityKeyRef = React.useRef(mutationAuthorityKey);
    mutationAuthorityKeyRef.current = mutationAuthorityKey;
    const installLifetime = React.useMemo(() => ({ controller: new AbortController() }), [mutationAuthorityKey]);
    React.useEffect(() => {
        if (installLifetime.controller.signal.aborted) installLifetime.controller = new AbortController();
        const controller = installLifetime.controller;
        return () => controller.abort();
    }, [installLifetime]);
    const reconciliationLifetime = React.useMemo(() => ({ controller: new AbortController() }), [installLifetime, params.focused]);
    React.useEffect(() => {
        if (params.focused === false) { reconciliationLifetime.controller.abort(); return; }
        if (reconciliationLifetime.controller.signal.aborted) reconciliationLifetime.controller = new AbortController();
        const controller = reconciliationLifetime.controller;
        return () => controller.abort();
    }, [params.focused, reconciliationLifetime]);
    /**
     * The machine's configured marketplace sources, read through the one
     * registry owner this screen shares with the Sources & registries
     * administration screen. Discover only reads it; every write to it is
     * issued through the same owner — from that screen, or from the registry
     * selection an install owes, which binds the listing's source there.
     */
    const marketplaceSourceRegistryAdministration = usePluginRegistrySourceAdministration({
        scopeKey: selectedMachineScopeKey,
        enabled: discoverExecution.ready,
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
    const { pluginTruthSettled, targetResolving, installedPluginsRead: administeredInstalledPluginsRead } = resolvePluginTruthReadState({
        targetOnline: administrationTargetSelection.state.kind === 'online',
        hasExecutionTarget: executionTarget !== null,
        capabilitiesLoaded: machineCapabilities.state.status === 'loaded',
        daemonAdministrationAvailable,
        projectionPhase: daemonMergedProjection.phase,
    });
    const installedPluginsRead = accountInstalledAdmission?.kind === 'available'
        || (executionTarget !== null && administeredInstalledPluginsRead);
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
        // Account registry reads are current independently of the selected daemon.
        hasCatalog: false,
        hasMarketplaceSourceRegistry: false,
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
                signal: reconciliationLifetime.controller.signal,
                request: {
                    ...capabilityRequest,
                    bypassCache: true,
                },
            });
        } catch {
            if (!reconciliationLifetime.controller.signal.aborted && params.isAuthorityCurrent()) {
                refreshPluginTruth();
                showUnresolvedOutcome();
            }
            return;
        }
        if (reconciliationLifetime.controller.signal.aborted || !params.isAuthorityCurrent()) return;

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
    }, [capabilityRequest, daemonCacheFreshnessKey, reconciliationLifetime, refreshPluginTruth]);
    /** Source chips are the enabled Account union, including built-ins. */
    const discoverSources = React.useMemo(() => marketplaceSourceRegistryAdministration.sources
        .filter(source => source.enabled)
        .map(source => ({ id: source.id, title: source.title, kind: registryPluginSourceKind(source) })),
        [marketplaceSourceRegistryAdministration.sources]);
    const canRefreshInstalledPlugins = daemonOperationsAvailable;
    const canRunDiscoverActions = canRefreshInstalledPlugins && discoverAuthorityKey !== null
        && discoverAuthorityKey === discoverDataKey;
    const canRefreshDiscover = discoverExecution.ready && !loadingDiscover && !registryBrowse.loading && !loadingMoreDiscover;
    const discoverStale = registryBrowse.stale || acquiredDiscoverQuery !== null
        && (acquiredDiscoverQuery.text !== discoverSearchText.trim()
            || acquiredDiscoverQuery.sourceId !== selectedDiscoverSourceId);

    // Discovery is Account-owned and survives a selected install-machine change.
    React.useEffect(() => {
        discoverRequestIdRef.current += 1;
        setLoadingDiscover(false); setLoadingMoreDiscover(false);
        setDiscoverEntries([]); setDiscoverNextCursor(null); setDiscoverSourceStatuses([]);
        setDiscoverDiagnostics([]); setDiscoverNonInstallable([]); setAcquiredDiscoverQuery(null);
        setSelectedDiscoverSourceIdState(null); setDesiredDiscoverQuery(null);
        setDiscoverAuthorityKey(null); setDiscoverError(null); setHasLoadedDiscoverForScope(null);
    }, [discoverAccountKey]);

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

    const runCatalogAction = React.useCallback((params: PluginMarketplaceActionRequest) => {
        const initialTarget = resolveCurrentExecutionTarget(executionTarget);
        const accountCurrentness = captureActiveServerAccountScopeCurrentness();
        if (
            !daemonOperationsAvailableRef.current
            || !mutationAuthorityKey
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
                discoverAuthorityKey !== discoverDataKey
                || exactInstallEntry?.installable !== true
                || !exactInstallEntry.version
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
                const showMutationFailure = (outcome: string, reason: string | null) => {
                    const action = resolvePluginChangeActionLabel(params.method);
                    Modal.alert(
                        t('common.error'),
                        reason
                            ? params.method === 'install'
                                ? t('settingsPlugins.marketplaceInstallRefused', { reason })
                                : t('settingsPlugins.marketplaceChangeRefused', { action, reason })
                            : params.method === 'install'
                                ? t('settingsPlugins.marketplaceInstallDecisionFailed', { outcome })
                                : t('settingsPlugins.marketplaceChangeDecisionFailed', { action, outcome }),
                    );
                };
                const isMutationOutcomeUnknown = (code: string | undefined) => code === 'outcomeUnknown' || code === 'outcome_uncertain';
                /**
                 * Reconciliation could not establish whether the change landed.
                 * That is not the same fact as "it failed": the daemon may have
                 * committed it. The shared reconciler re-reads only the exact
                 * original target and answers with success or the truthful
                 * unresolved copy — never a false failure, never an invitation
                 * to retry a change that may have committed.
                 */
                const reconcileAmbiguousMutation = async (targetVersion: string | null) => {
                    await reconcileCommitIntendedMutation({
                        target: initialTarget,
                        isAuthorityCurrent,
                        settlementScope: params.method === 'install' ? 'discover' : 'installed',
                        successMessage: t('common.done'),
                        actionLabel: resolvePluginChangeActionLabel(params.method),
                        name: installedBefore?.title ?? exactInstallEntry?.title ?? params.pluginId,
                        probe: commitAction ? {
                            method: commitAction,
                            pluginId: params.pluginId,
                            before: installedBefore,
                            targetVersion,
                        } : null,
                    });
                };
                const requestChange = async (managedResourceDispositions?: readonly ManagedResourceDispositionV1[]): Promise<
                    | { supported: false; reason: 'cancelled' }
                    | { supported: true; response: CapabilitiesInvokeResponse }
                > => {
                    const actionFailure = (execution: ActionExecuteFailure, actionId: PluginDevLoopActionIdV1) => {
                        if (isActionApprovalDeclinedErrorCode(execution.errorCode) || !isAuthorityCurrent()) {
                            return { supported: false as const, reason: 'cancelled' as const };
                        }
                        if (!presentActionTurnedOffNoticeIfOff(execution, actionId)
                            && !isMutationOutcomeUnknown(execution.errorCode)) Modal.alert(t('common.error'), execution.error);
                        return { supported: true as const, response: { ok: false as const,
                            error: { code: execution.errorCode, message: execution.error } } };
                    };
                    try {
                        if (params.method === 'install' || params.method === 'update') {
                            const actionInput = params.method === 'install' && exactInstallEntry?.version
                                ? {
                                    machineId: initialTarget.machine.id,
                                    source: { kind: 'marketplace' as const, sourceId: exactInstallEntry.sourceId,
                                        pluginId: exactInstallEntry.id, version: exactInstallEntry.version,
                                        packageName: exactInstallEntry.packageName },
                                }
                                : params.method === 'update'
                                    ? { machineId: initialTarget.machine.id, source: { kind: 'installed' as const, pluginId: params.pluginId } }
                                    : null;
                            if (!actionInput) return { supported: true as const, response: {
                                ok: false as const, error: { code: 'install_unavailable', message: t('common.unavailable') },
                            } };
                            const execute = params.method === 'install' ? discoverExecution.execute : installedExecution.execute;
                            const execution = await execute('plugins.install', actionInput,
                                { signal: installLifetime.controller.signal });
                            if (!execution.ok) return actionFailure(execution, 'plugins.install');
                            const result = execution.result;
                            // `plugins.install` resumes only after its ordinary
                            // approval Artifact settles. Project that terminal
                            // Action outcome into the existing mutation reader;
                            // daemon review ids never become a second UI decision.
                            return { supported: true as const, response: { ok: true as const,
                                result: projectPluginInstallActionResult(result, params.method, params.pluginId),
                            } };
                        }
                        const actionId = {
                            enable: 'plugins.enable', disable: 'plugins.disable', rollback: 'plugins.rollback',
                            uninstall: 'plugins.uninstall', forgetTrust: 'plugins.trust.forget', setUpdatePolicy: 'plugins.update_policy.set',
                        } as const;
                        const execution = await installedExecution.execute(actionId[params.method], {
                            machineId: initialTarget.machine.id,
                            pluginId: params.pluginId,
                            ...(params.scope ? { scope: params.scope } : {}),
                            ...(params.policy ? { policy: params.policy } : {}),
                            ...(managedResourceDispositions ? { managedResourceDispositions } : {}),
                        }, { signal: installLifetime.controller.signal });
                        if (!execution.ok) return actionFailure(execution, actionId[params.method]);
                        return { supported: true as const, response: { ok: true as const, result: execution.result } };
                    } catch {
                        if (installLifetime.controller.signal.aborted || !isAuthorityCurrent()) {
                            return { supported: false, reason: 'cancelled' };
                        }
                        // A lost response may follow an issued mutation. Reuse
                        // exact-target reconciliation; never replay the effect.
                        return { supported: true as const, response: { ok: false as const,
                            error: { code: 'outcomeUnknown', message: t('common.requestFailed') } } };
                    }
                };
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
                    return;
                }
                if (!response.response.ok) {
                    if (isMutationOutcomeUnknown(response.response.error.code)) {
                        await reconcileAmbiguousMutation(exactInstallEntry?.version ?? null);
                    }
                    return;
                }

                const changeKind = readPluginChangeKind(response.response.result, params.method, params.pluginId);
                if (changeKind === 'cancelled') return;
                const disabledNoop = params.method === 'disable'
                    && isPluginDisableNoopResult(response.response.result, params.pluginId);
                if (changeKind !== 'committed' && !disabledNoop) {
                    if (changeKind === 'outcomeUnknown') {
                        await reconcileAmbiguousMutation(exactInstallEntry?.version ?? null);
                    } else {
                        showMutationFailure(
                            changeKind ?? 'invalid-response',
                            readPluginChangeFailureReason(response.response.result, params.method, params.pluginId),
                        );
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
                machineCapabilities.refresh({ bypassCache: true });
                refreshPluginTruth();
            } finally {
                markPluginActionFinished(mutationAuthorityKey, params.pluginId);
            }
        })();
    }, [administrationTargetSelection, daemonAdministrationAvailable, discoverDataKey, discoverAuthorityKey, discoverEntries, discoverExecution.execute, executionTarget, installedExecution.execute, installLifetime, isPluginActionInFlight, machineCapabilities, markPluginActionFinished, markPluginActionStarted, marketplaceSourceRegistryAdministration.refresh, mutationAuthorityKey, reconcileCommitIntendedMutation, refreshPluginTruth, resolveCurrentExecutionTarget, selectedMachineScopeKey]);

    const runInstalledPluginAction = React.useCallback((
        action: InstalledPluginActionId,
        pluginId: string,
        scope?: 'account' | 'machine',
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
        const capabilities = projectInstalledPluginLifecycleCapabilities(installed, scope);
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
        // Action policy owns confirmation. Retained-resource responsibility is
        // a distinct daemon-issued review handled by the mutation loop above.
        runCatalogAction({ method: action, pluginId, ...(scope ? { scope } : {}) });
    }, [isPluginActionInFlight, mutationAuthorityKey, runCatalogAction]);

    const setInstalledPluginUpdatePolicy = React.useCallback((
        pluginId: string,
        policy: PluginUpdatePolicyV1,
    ) => {
        runCatalogAction({ method: 'setUpdatePolicy', pluginId, policy });
    }, [runCatalogAction]);

    const executeDevelopmentAction = React.useMemo(() => createFrontDoorActionExecute(), []);
    const invokeDevelopmentAction = React.useCallback(async (
        actionId: PluginDevLoopActionIdV1,
        input: unknown,
        target: FreshMachineAdministrationExecutionTargetV1,
        isAuthorityCurrent: () => boolean,
    ): Promise<boolean> => {
        if (!isAuthorityCurrent()) return false;
        try {
            const response = await executeDevelopmentAction(actionId, input, {
                surface: 'ui',
                serverId: target.serverId,
                executionRunTargetMachineId: target.machine.id,
            });
            if (!isAuthorityCurrent()) return false;
            if (!response.ok) {
                Modal.alert(t('common.error'), response.error);
                return false;
            }
            const result = response.result;
            if (result && typeof result === 'object' && 'ok' in result && result.ok === true
                && 'kind' in result && result.kind === actionId.replaceAll('.', '_')) return true;
            if (result && typeof result === 'object' && 'ok' in result && result.ok === false) {
                const messages = 'diagnostics' in result && Array.isArray(result.diagnostics)
                    ? result.diagnostics.flatMap((diagnostic: unknown) => (
                        diagnostic && typeof diagnostic === 'object' && 'message' in diagnostic
                            && typeof diagnostic.message === 'string' ? [diagnostic.message] : []
                    ))
                    : [];
                Modal.alert(t('common.error'), messages.join('\n') || t('common.requestFailed'));
            }
            // A queued approval belongs to the canonical Actions approval UI.
            // It is pending, not a completed development operation.
            return false;
        } catch (error) {
            if (isAuthorityCurrent()) {
                Modal.alert(t('common.error'), error instanceof Error ? error.message : t('common.requestFailed'));
            }
            return false;
        }
    }, [executeDevelopmentAction]);

    // Keyed by the source root: a source the daemon could not load has no installed plugin.
    // The root also keys its in-flight marker.
    const runDevelopmentAction = React.useCallback((action: 'test' | 'pack' | 'unregister', sourceRootPath: string) => {
        const development = developmentPlugins.find((entry) => entry.sourceRootPath === sourceRootPath) ?? null;
        const initialTarget = resolveCurrentExecutionTarget(executionTarget);
        if (
            !daemonOperationsAvailableRef.current
            || !mutationAuthorityKey
            || mutationAuthorityKeyRef.current !== mutationAuthorityKey
            || !initialTarget
            || !development
            || development.actions[action] !== true
            || isPluginActionInFlight(sourceRootPath)
        ) {
            return;
        }

        void (async () => {
            markPluginActionStarted(mutationAuthorityKey, sourceRootPath);
            try {
                const succeeded = await invokeDevelopmentAction(
                    action === 'pack' ? 'plugins.pack' : action === 'test' ? 'plugins.dev.test' : 'plugins.dev.unregister',
                    action === 'pack' ? { locator: development.sourceRootPath } : { projectRoot: development.sourceRootPath },
                    initialTarget,
                    () => mutationAuthorityKeyRef.current === mutationAuthorityKey
                        && resolveCurrentExecutionTarget(initialTarget) !== null,
                );
                if (succeeded) {
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
                    && succeeded
                ) {
                    machineCapabilities.refresh({ bypassCache: true });
                    refreshPluginTruth();
                }
            } finally {
                markPluginActionFinished(mutationAuthorityKey, sourceRootPath);
            }
        })();
    }, [developmentPlugins, executionTarget, invokeDevelopmentAction, isPluginActionInFlight, machineCapabilities, markPluginActionFinished, markPluginActionStarted, mutationAuthorityKey, refreshPluginTruth, resolveCurrentExecutionTarget]);

    const resolveDevelopmentEditTarget = React.useCallback((
        pluginId: string,
    ): Promise<DevelopmentEditTargetSettlement> => {
        const initialTarget = resolveCurrentExecutionTarget(executionTarget);
        if (
            !daemonOperationsAvailableRef.current
            || !mutationAuthorityKey
            || mutationAuthorityKeyRef.current !== mutationAuthorityKey
            || !initialTarget
            || !developmentPlugins.some((entry) => entry.installed?.pluginId === pluginId)
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
            !daemonOperationsAvailableRef.current
            || !mutationAuthorityKey
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
                const execution = await installedExecution.execute('plugins.scaffold', {
                    machineId: initialTarget.machine.id,
                    targetDir: params.targetDir,
                    name: params.displayName,
                    id: params.pluginId,
                    ...(params.ui ? { ui: params.ui } : {}),
                }, { signal: installLifetime.controller.signal });
                if (!isAuthorityCurrent()) {
                    return { status: 'unavailable', reason: 'authorityChanged' };
                }
                if (!execution.ok) {
                    if (!isActionApprovalDeclinedErrorCode(execution.errorCode)
                        && !presentActionTurnedOffNoticeIfOff(execution, 'plugins.scaffold')) Modal.alert(t('common.error'), execution.error);
                    return { status: 'unavailable', reason: 'requestFailed' };
                }
                const result = execution.result;
                const created = result && typeof result === 'object' && 'kind' in result && result.kind === 'plugins_scaffold'
                    && 'ok' in result && result.ok === true
                    && 'plugin' in result && result.plugin && typeof result.plugin === 'object' && 'pluginId' in result.plugin
                    && 'createdPaths' in result && result.createdPaths && typeof result.createdPaths === 'object' && 'targetDir' in result.createdPaths
                    ? readPluginCreateResult({ action: 'create', pluginId: result.plugin.pluginId, sourceRootPath: result.createdPaths.targetDir })
                    : null;
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
    }, [developmentCreateAvailable, executionTarget, installedExecution.execute, installLifetime, isPluginActionInFlight, markPluginActionFinished, markPluginActionStarted, mutationAuthorityKey, resolveCurrentExecutionTarget]);

    /** Adopts an explicit source through the same development Action used by the CLI and Agents. */
    const runDevelopmentSourceInstall = React.useCallback((sourceRootPath: string) => {
        const trimmedSourceRootPath = sourceRootPath.trim();
        const initialTarget = resolveCurrentExecutionTarget(executionTarget);
        if (
            !daemonOperationsAvailableRef.current
            || !mutationAuthorityKey
            || mutationAuthorityKeyRef.current !== mutationAuthorityKey
            || !initialTarget
            || !trimmedSourceRootPath
            || !developmentSourceInstallAvailable
            || isPluginActionInFlight(trimmedSourceRootPath)
        ) return;

        void (async () => {
            markPluginActionStarted(mutationAuthorityKey, trimmedSourceRootPath);
            try {
                const succeeded = await invokeDevelopmentAction(
                    'plugins.dev.submit',
                    { projectRoot: trimmedSourceRootPath },
                    initialTarget,
                    () => mutationAuthorityKeyRef.current === mutationAuthorityKey
                        && resolveCurrentExecutionTarget(initialTarget) !== null,
                );
                if (!succeeded) return;
                setRoutineOperationSettlement({
                    scope: 'development',
                    message: t('settingsPlugins.developmentSourceInstallSucceeded'),
                    detail: trimmedSourceRootPath,
                });
                machineCapabilities.refresh({ bypassCache: true });
                refreshPluginTruth();
            } finally {
                markPluginActionFinished(mutationAuthorityKey, trimmedSourceRootPath);
            }
        })();
    }, [developmentSourceInstallAvailable, executionTarget, invokeDevelopmentAction, isPluginActionInFlight, machineCapabilities, markPluginActionFinished, markPluginActionStarted, mutationAuthorityKey, refreshPluginTruth, resolveCurrentExecutionTarget]);
    // Pending trust questions are approval Artifacts in Inbox. This screen only
    // projects daemon-owned applying rows, so it intentionally has no decision
    // transport of its own.
    const decidePendingPluginChange = React.useCallback(() => {}, []);

    // Registry pages own source cursors and placement. This effect obtains the
    // published detail needed by the retained cards; install admission stays on
    // the currently selected machine's existing review pipeline.
    React.useEffect(() => {
        const requestId = ++discoverRequestIdRef.current;
        if (!desiredDiscoverQuery || !discoverAccountKey || !discoverExecution.ready
            || registryBrowse.loading || registryBrowse.stale) return;
        const query = desiredDiscoverQuery;
        setLoadingDiscover(true);
        void (async () => {
            try {
                if (registryBrowse.error) throw new Error(registryBrowse.error);
                const outcomes = await Promise.allSettled(registryBrowse.items.map(async summary => {
                    const result = await discoverExecution.execute('registries.items.read', {
                        kind: 'plugin', sourceId: summary.sourceId, itemId: summary.itemId,
                        ...(summary.version ? { version: summary.version } : {}),
                    });
                    if (!result.ok) throw Object.assign(new Error(result.error), { code: result.errorCode });
                    return REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.read'].parse(result.result).item;
                }));
                if (requestId !== discoverRequestIdRef.current || !discoverExecution.isCurrent()) return;
                const items = outcomes.flatMap(outcome => outcome.status === 'fulfilled' ? [outcome.value] : []);
                const readFailures: PluginMarketplaceDiscoverDiagnostic[] = outcomes.flatMap((outcome, index) => {
                    if (outcome.status === 'fulfilled') return [];
                    const summary = registryBrowse.items[index]!;
                    const source = marketplaceSourceRegistryAdministration.sources.find(source => source.id === summary.sourceId);
                    return [{ id: 'read:' + summary.sourceId + ':' + summary.itemId, sourceId: summary.sourceId,
                        sourceTitle: source?.title ?? null, code: 'registry_item_unavailable',
                        message: t('settingsPlugins.discover.diagnostic.recovery') }];
                });
                const page = projectRegistryMarketplacePage({ items, pages: registryBrowse.pages,
                    sources: marketplaceSourceRegistryAdministration.sources });
                setDiscoverDiagnostics([...page.diagnostics, ...readFailures]);
                setDiscoverSourceStatuses(page.sources);
                if (items.length === 0 && registryBrowse.items.length > 0) throw new Error('registry_item_unavailable');
                setDiscoverAuthorityKey(discoverDataKey);
                setDiscoverNextCursor(page.nextCursor);
                setAcquiredDiscoverQuery({ text: query.text.trim(), sourceId: query.sourceId });
                setDiscoverEntries(mergeDiscoverEntries([], query.pluginId
                    ? page.entries.filter(entry => entry.id === query.pluginId) : page.entries));
                setDiscoverNonInstallable(mergeDiscoverNonInstallableListings([], query.pluginId
                    ? page.nonInstallable.filter(entry => entry.pluginId === query.pluginId) : page.nonInstallable));
                setDiscoverError(null);
            } catch {
                if (requestId === discoverRequestIdRef.current && discoverExecution.isCurrent()) {
                    setDiscoverError(t('settingsPlugins.discover.diagnostic.recovery'));
                }
            } finally {
                if (requestId === discoverRequestIdRef.current && discoverExecution.isCurrent()) setLoadingDiscover(false);
            }
        })();
        return () => { discoverRequestIdRef.current += 1; };
    }, [desiredDiscoverQuery, discoverAccountKey, discoverDataKey, discoverExecution.execute, discoverExecution.isCurrent, discoverExecution.ready,
        registryBrowse.items, registryBrowse.pages, registryBrowse.loading, registryBrowse.stale, registryBrowse.error,
        marketplaceSourceRegistryAdministration.sources]);

    const requestDiscoverQuery = React.useCallback((query: DiscoverQueryIntent) => {
        setDiscoverNextCursor(null);
        setDesiredDiscoverQuery(query);
        if (desiredDiscoverQuery?.text === query.text && desiredDiscoverQuery.sourceId === query.sourceId
            && desiredDiscoverQuery.pluginId === query.pluginId) void registryBrowse.refresh();
    }, [desiredDiscoverQuery, registryBrowse.refresh]);
    const refreshDiscover = React.useCallback(() => {
        requestDiscoverQuery({ text: discoverSearchText, sourceId: selectedDiscoverSourceId });
    }, [discoverSearchText, selectedDiscoverSourceId, requestDiscoverQuery]);
    const setSelectedDiscoverSourceId = React.useCallback((sourceId: string | null) => {
        setSelectedDiscoverSourceIdState(sourceId);
        requestDiscoverQuery({ text: discoverSearchText, sourceId });
    }, [discoverSearchText, requestDiscoverQuery]);
    const clearDiscoverSearch = React.useCallback(() => {
        setDiscoverSearchText('');
        requestDiscoverQuery({ text: '', sourceId: selectedDiscoverSourceId });
    }, [requestDiscoverQuery, selectedDiscoverSourceId]);
    const openDiscoverListing = React.useCallback((listing: Readonly<{ sourceId: string; pluginId: string }>) => {
        setSelectedDiscoverSourceIdState(listing.sourceId);
        requestDiscoverQuery({ text: '', sourceId: listing.sourceId, pluginId: listing.pluginId });
    }, [requestDiscoverQuery]);
    const loadMoreDiscover = React.useCallback(() => {
        if (!registryBrowse.hasNextPage || registryBrowse.loading || loadingMoreDiscover) return;
        setLoadingMoreDiscover(true);
        void registryBrowse.nextPage().catch(() => {
            if (discoverExecution.isCurrent()) setDiscoverError(t('settingsPlugins.discover.diagnostic.recovery'));
        }).finally(() => { if (discoverExecution.isCurrent()) setLoadingMoreDiscover(false); });
    }, [registryBrowse.hasNextPage, registryBrowse.loading, registryBrowse.nextPage, loadingMoreDiscover, discoverExecution.isCurrent]);
    React.useEffect(() => {
        if (activeView !== 'discover' || !discoverExecution.ready || !discoverAccountKey) return;
        if (hasLoadedDiscoverForScope === discoverAccountKey) return;
        setHasLoadedDiscoverForScope(discoverAccountKey);
        refreshDiscover();
    }, [activeView, discoverExecution.ready, discoverAccountKey, hasLoadedDiscoverForScope, refreshDiscover]);

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
        discoverEntries: discoverExecution.ready && discoverAuthorityKey === discoverDataKey ? discoverEntries : EMPTY_DISCOVER_VALUES,
        discoverNextCursor: discoverExecution.ready && discoverAuthorityKey === discoverDataKey ? discoverNextCursor : null,
        discoverSources,
        discoverSourceStatuses: discoverExecution.ready && discoverAuthorityKey === discoverDataKey ? discoverSourceStatuses : EMPTY_DISCOVER_VALUES,
        discoverDiagnostics: discoverExecution.ready && discoverAuthorityKey === discoverDataKey ? discoverDiagnostics : EMPTY_DISCOVER_VALUES,
        discoverNonInstallable: discoverExecution.ready && discoverAuthorityKey === discoverDataKey ? discoverNonInstallable : EMPTY_DISCOVER_VALUES,
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
        loadingDiscover: loadingDiscover || registryBrowse.loading,
        marketplaceSourceRegistry,
        marketplaceSourceRegistryAvailable: marketplaceSourceRegistryAdministration.available,
        marketplaceSourceRegistryScopeKey: discoverAccountKey,
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
