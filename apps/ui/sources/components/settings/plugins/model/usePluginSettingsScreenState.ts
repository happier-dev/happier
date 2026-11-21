import * as React from 'react';
import { useActivePluginAccountAvailabilityReader, usePluginAccountAvailabilityReader } from '@/sync/domains/plugins/availability/projection';

import {
    getMachineCapabilitiesCacheState,
} from '@/hooks/server/useMachineCapabilitiesCache';
import { useMachineCapabilityInvokeWithAlerts } from '@/hooks/machine/useMachineCapabilityInvokeWithAlerts';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import type { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { usePluginsAdministrationTarget } from './usePluginsAdministrationTarget';
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
import { isActionApprovalDeclinedErrorCode, isActionOutcomeUnknownErrorCodeV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { CapabilitiesInvokeResponse } from '@happier-dev/protocol/capabilities';
import type { PluginDevLoopActionIdV1 } from '@happier-dev/protocol/actions/actionIds';
import { reviewManagedResourceRemoval } from '@/components/settings/machines/managed/reviewManagedResourceRemoval';
import type { ManagedResourceDispositionV1 } from '@happier-dev/protocol/machines/managed/managedDependencyV1';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { usePluginCatalog } from './usePluginCatalog';
import { usePluginInstallReviewSet } from './usePluginInstallReviewSet';
import { buildPluginCatalogInstallInput } from './buildPluginCatalogInstallInput';
import type { PluginGitSourceV1 } from '@happier-dev/protocol/plugins/source-spec';
import { PluginGitPreviewActionOutputSchema } from '@happier-dev/protocol/actions/specs/pluginDevelopment';
import type { z } from 'zod/mini';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import type { PluginListingRouteParams } from './pluginsSurfaceRoutes';
import { type PluginProjectionV2} from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { type PluginScaffoldUiMode } from '@happier-dev/protocol/actions';
import {
    MarketplaceRegistryProfileRequirementV1Schema,
    type MarketplaceRegistryProfileRequirementV1,
    type PluginUpdatePolicyV1,
} from '@happier-dev/protocol/marketplace';
import { t } from '@/text';
import { presentActionTurnedOffNoticeIfOff } from '@/sync/ops/actions/actionTurnedOffNotice';
import { Modal } from '@/modal';

import {
    type PluginMarketplaceCatalogEntry,
    type PluginMarketplaceCatalogSourceKind,
    type PluginMarketplaceDiscoverDiagnostic,
    type PluginMarketplaceDiscoverSourceStatus,
    type PluginMarketplaceNonInstallableListing,
} from '../readPluginMarketplaceCatalog';
import { showPluginRegistryProfileSelectionDialog } from '../PluginRegistryProfileSelectionDialog';
import {
    MARKETPLACE_CAPABILITY_ID,
    readDevelopmentCreateAvailable,
    readDevelopmentSourceInstallAvailable,
    projectAccountInstalledPlugins,
    indexInstalledPluginIdsByCatalogEntry,
    projectPluginMutationResult,
    type PluginMutationResult,
    readPluginCreateResult,
    readPluginEditTargetResult,
    readPendingPluginChanges,
    resolvePluginDaemonOperationsAvailability,
    readPluginInstallationReviewChange,
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

function pluginActionKey(scopeKey: string, pluginId: string): string { return JSON.stringify([scopeKey, pluginId]); }


export type PluginRoutineOperationSettlement = Readonly<{
    scope: 'installed' | 'discover' | 'pending' | 'development';
    message: string;
    detail?: string;
    /**
     * The change did not happen (its approval was declined or withdrawn), failed, or its result could not be confirmed;
     * success is the default. An install's failure or unknown outcome shows inline where Install was pressed.
     */
    outcome?: 'withdrawn' | 'failed' | 'unknown';
    /** The catalog listing this install outcome belongs to. */
    pluginId?: string;
    sourceId?: string;
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

function describeDeclinedPluginChange(action: PluginMarketplaceActionRequest['method'], rejected: boolean): string {
    if (action === 'install') return t(rejected ? 'settingsPlugins.installDeclined' : 'settingsPlugins.installCanceled');
    if (action === 'update') return t(rejected ? 'settingsPlugins.updateDeclined' : 'settingsPlugins.updateCanceled');
    return t(rejected ? 'approvals.status.rejected' : 'approvals.status.canceled');
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
    discoverFailureStatus?: ReturnType<typeof usePluginCatalog>['discoverFailureStatus'];
    unresolvedListing: boolean;
    /** Draft search text for the aggregate Discover query. */
    discoverSearchText: string;
    /** The query the shown results answer; null until a query returns, not an empty result. */
    discoverResultsSearchText: string | null;
    /** Empties the search and shows every listing again (the "no match" Clear). */
    clearDiscoverSearch: () => void;
    canRefreshDiscover: boolean;
    canRunDiscoverActions: boolean;
    discoverInstallDisabledReason: string | null;
    canRefreshInstalledPlugins: boolean;
    daemonOperationsAvailable: boolean;
    /** Exact daemon administration RPCs; independent of contribution projection readiness. */
    daemonAdministrationAvailable: boolean;
    developmentCreateAvailable: boolean;
    developmentSourceInstallAvailable: boolean;
    developmentPlugins: readonly DevelopmentPluginEntry[];
    discoverEntries: readonly PluginMarketplaceCatalogEntry[];
    /** The browsing Account owns local drafts from catalog suggestions. */
    catalogAccountLifetime: ReturnType<typeof usePluginCatalog>['execution']['binding'];
    /** The browsing Account owns local drafts from catalog suggestions. */
    catalogAccountLifetime: ReturnType<typeof usePluginCatalog>['execution']['binding'];
    discoverNextCursor: string | null;
    /** Selectable source chips beside All: enabled configured sources plus community npm. */
    discoverSources: readonly Readonly<{ id: string; title: string; kind: PluginMarketplaceCatalogSourceKind }>[];
    /** Freshness from the Account Registry acquisition that supplied the shown page. */
    discoverSourceStatuses: readonly PluginMarketplaceDiscoverSourceStatus[];
    /** Index-wide diagnostics for the shown page; never collapsed into one failure. */
    discoverDiagnostics: readonly PluginMarketplaceDiscoverDiagnostic[];
    /** Registry-policy exclusions, separate from installable metadata. */
    discoverNonInstallable: readonly PluginMarketplaceNonInstallableListing[];
    /** The shown list answers an earlier query than the controls now describe. */
    discoverStale: boolean;
    installedPluginById: ReadonlyMap<string, InstalledPluginEntry>;
    installedPlugins: readonly InstalledPluginEntry[];
    /** `null` is aggregate All: the query carries no source filter at all. */
    selectedDiscoverSourceId: string | null;
    loadingMoreDiscover: boolean;
    /** Daemon applying facts; ordinary approval Artifacts supply the separate Review rows. */
    pendingPluginChanges: readonly PendingPluginChangeListing[];
    /** The invoking surface presents this same evaluated approval and decision owner. */
    pluginActionApproval: ReturnType<typeof useMountedActionExecution>['approval'];
    /** Exact per-Machine approval carriers; the in-place approval owner supplies facts and decisions. */
    pluginInstallReview: ReturnType<typeof usePluginInstallReviewSet>['review'];
    runCatalogInstallOnMachines: ReturnType<typeof usePluginInstallReviewSet>['run'];
    routineOperationSettlement: PluginRoutineOperationSettlement | null;
    readOnlySnapshotNotice: PluginReadOnlySnapshotNoticeState | null;
    refreshPluginTruth: () => void;
    isPluginActionInFlight: (pluginId: string, sourceId?: string) => boolean;
    refreshDiscover: () => void;
    loadingDiscover: boolean;
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
    /**
     * Browse's "+" ("Install on <machine>"): the press is the consent, as Install & Trust on the listing is (owner
     * 2026-11-19), so it installs this exact catalog release at once; its outcome settles inline on the card.
     */
    installFromBrowse: (listing: Readonly<{ pluginId: string; sourceId: string }>) => void;
    runDevelopmentCreate: (params: Readonly<{
        targetDir: string;
        displayName: string;
        pluginId: string;
        ui?: PluginScaffoldUiMode;
    }>) => Promise<DevelopmentCreateSettlement>;
    resolveDevelopmentEditTarget: (pluginId: string) => Promise<DevelopmentEditTargetSettlement>;
    runDevelopmentSourceInstall: (sourceRootPath: string) => void;
    runGitSourceInstall: (source: PluginGitSourceV1) => boolean;
    /** What a Git link resolves to on the selected Machine (`plugins.git.preview`), before Review; nothing installs. */
    previewGitSource: (source: PluginGitSourceV1) => Promise<PluginGitSourcePreviewResult | null>;
    runDevelopmentAction: (action: 'test' | 'pack' | 'unregister', sourceRootPath: string) => void;
    runInstalledPluginAction: (action: InstalledPluginActionId, pluginId: string, scope?: 'account' | 'machine') => void;
    setInstalledPluginUpdatePolicy: (pluginId: string, policy: PluginUpdatePolicyV1) => void;
    setActiveView: (view: PluginSettingsViewId) => void;
    setDiscoverSearchText: (value: string) => void;
    setSelectedDiscoverSourceId: (sourceId: string | null) => void;
    /**
     * Acquires one exact source-qualified listing through the canonical catalog owner.
     * The selected administration target, not catalog acquisition, owns install execution.
     */
    openDiscoverListing: (listing: PluginListingRouteParams) => void;
    loadMoreDiscover: () => void;
}>;

/** A Git link's preview, or why it could not be read (the Action's own error words). */
export type PluginGitSourcePreviewResult =
    | Readonly<{ kind: 'preview'; preview: z.infer<typeof PluginGitPreviewActionOutputSchema> }>
    | Readonly<{ kind: 'failed'; message: string }>;

export function usePluginSettingsScreenState(params: Readonly<{ focused?: boolean; management?: boolean; initialView?: PluginSettingsViewId; listing?: PluginListingRouteParams; initialCatalogSourceId?: string }> = {}): PluginSettingsScreenState {
    const layoutPresented = useLayoutPresentationActive();
    const presented = params.focused !== false && layoutPresented;
    const [activeView, setActiveView] = React.useState<PluginSettingsViewId>(params.initialView ?? 'installed');
    const managementDemanded = presented && (params.management ?? (activeView === 'installed' || params.listing !== undefined));
    const activeServer = useActiveServerSnapshot();
    const availabilityReader = useActivePluginAccountAvailabilityReader();
    const accountInstalledAdmission = React.useMemo(() => availabilityReader?.readInstalledPlugins() ?? null, [availabilityReader]);
    const [projectionRefreshKey, setProjectionRefreshKey] = React.useState(0);
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
        capabilitiesAccountId,
        hasCapabilitySnapshot,
        installedPlugins: administeredInstalledPlugins,
        developmentPlugins,
        daemonMergedProjection,
        projectionInputs,
    } = usePluginsAdministrationTarget({ enabled: managementDemanded, projectionRefreshKey });
    const administrationTargetSelection = administration.selection;
    const accountServerIdentityId = React.useMemo(
        () => resolveScopedPluginSettingsServerIdentity(activeServer.serverId),
        [activeServer.serverId],
    );
    const executionTarget = administration.executionTarget;
    // Installed controls belong to the selected Machine's Home, which may
    // differ from the Account currently supplying Discover's registry reads.
    const installedExecution = useMountedActionExecution(administration.selectedServerIdentityId);
    const selectedServerIdentityId = administration.selectedServerIdentityId;
    const installedAvailabilityReader = usePluginAccountAvailabilityReader(installedExecution.binding?.scope ?? null);
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

    const catalog = usePluginCatalog({ enabled: presented && (activeView === 'discover' || params.listing !== undefined), browse: activeView === 'discover',
        selection: params.listing, initialSourceId: params.initialCatalogSourceId });
    const { discoverEntries } = catalog;
    const installReviewSet = usePluginInstallReviewSet({ resolveInstallEntry: catalog.resolveInstallEntry,
        candidates: administrationTargetSelection.candidates, getSignal: installedExecution.getSignal });
    const [pluginActionsInFlight, setPluginActionsInFlight] = React.useState<ReadonlyMap<string, string | null>>(() => new Map());
    const [routineOperationSettlement, setRoutineOperationSettlement] = React.useState<PluginRoutineOperationSettlement | null>(null);
    const pluginActionsInFlightRef = React.useRef(pluginActionsInFlight);
    const selectedMachineScopeKeyRef = React.useRef(selectedMachineScopeKey);
    selectedMachineScopeKeyRef.current = selectedMachineScopeKey;

    React.useEffect(() => {
        setRoutineOperationSettlement(null);
    }, [selectedMachineScopeKey]);

    const scopedInstalledPlugins = React.useMemo(() => administeredInstalledPlugins.map(entry => {
        if (entry.machineEnabled === undefined) return entry;
        const accountEnabled = installedAvailabilityReader?.readCurrentAccountEnablement(entry.pluginId) ?? undefined;
        return accountEnabled === entry.accountEnabled ? entry : { ...entry, accountEnabled };
    }), [administeredInstalledPlugins, installedAvailabilityReader]);
    const installedPlugins = React.useMemo(() => projectAccountInstalledPlugins(scopedInstalledPlugins, accountInstalledAdmission), [accountInstalledAdmission, scopedInstalledPlugins]);
    const installedPluginById = React.useMemo(
        () => new Map(scopedInstalledPlugins.map((entry) => [entry.pluginId, entry] as const)),
        [scopedInstalledPlugins],
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
            capabilitiesAccountId,
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
        hasSelectedTarget: administrationTargetSelection.selectedTarget !== null,
        daemonOperationsAvailable,
        daemonTransportOnline,
        projectionPhase: daemonMergedProjection.phase,
        hasCapabilitySnapshot,
        installedPluginCount: installedPlugins.length,
        developmentPluginCount: developmentPlugins.length,
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
        if (!managementDemanded) return;
        const target = administrationTargetSelection.selectedTarget;
        if (!target) return;
        setProjectionRefreshKey((prev) => prev + 1);
        machineCapabilities.refresh({ bypassCache: true });
        publishMachineContributionRegistryProjectionInvalidation({
            machineId: target.machineId,
            serverId: target.serverIdentityId,
        }, 'refresh');
    }, [managementDemanded, administrationTargetSelection.selectedTarget, machineCapabilities.refresh]);
    /** An uncertain receipt stays uncertain; refreshed inventory never substitutes for its outcome. */
    const reportUnknownMutation = React.useCallback((params: Readonly<{
        target: FreshMachineAdministrationExecutionTargetV1;
        actionLabel: string;
        name: string;
    }>): void => {
        refreshPluginTruth();
        const label = resolveMachineAdministrationTargetLabel({
            target: params.target.target, candidates: administrationCandidatesRef.current,
        }) ?? { machine: params.target.machine.id, server: params.target.serverId };
        Modal.alert(t('settingsPlugins.pluginChangeOutcomeUnknownTitle'),
            t('settingsPlugins.pluginChangeOutcomeUnknownBody', {
                action: params.actionLabel, name: params.name, machine: label.machine, server: label.server,
            }));
    }, [refreshPluginTruth]);
    const canRefreshInstalledPlugins = daemonOperationsAvailable;
    const discoverInstallDisabledReason = !daemonTransportOnline
        ? t('settingsPlugins.surfaces.listingChooseMachine')
        : !catalog.current ? t('settingsPlugins.discover.status.stale') : null;
    const canRunDiscoverActions = discoverInstallDisabledReason === null;

    const markPluginActionStarted = React.useCallback((scopeKey: string, pluginId: string, sourceId: string | null = null) => {
        setRoutineOperationSettlement(null);
        const next = new Map(pluginActionsInFlightRef.current).set(pluginActionKey(scopeKey, pluginId), sourceId);
        pluginActionsInFlightRef.current = next;
        setPluginActionsInFlight(next);
    }, []);

    const markPluginActionFinished = React.useCallback((scopeKey: string, pluginId: string) => {
        const next = new Map(pluginActionsInFlightRef.current);
        next.delete(pluginActionKey(scopeKey, pluginId));
        pluginActionsInFlightRef.current = next;
        setPluginActionsInFlight(next);
    }, []);

    const isPluginActionInFlight = React.useCallback((pluginId: string, sourceId?: string) => {
        if (selectedMachineScopeKey === null) return false;
        const activeSource = pluginActionsInFlightRef.current.get(pluginActionKey(selectedMachineScopeKey, pluginId));
        // Admission stays per plugin. A listing's progress also identifies its source.
        return activeSource !== undefined && (sourceId === undefined || sourceId === activeSource);
    }, [selectedMachineScopeKey, pluginActionsInFlight]);
    // Withdrawal hides a receipt from a different Account/view; it never aborts admitted daemon work.
    const captureMutationPublication = React.useCallback(() => {
        const account = captureActiveServerAccountScopeCurrentness();
        return () => account.isCurrent() && installedExecution.isCurrent()
            && selectedMachineScopeKeyRef.current === selectedMachineScopeKey;
    }, [installedExecution.isCurrent, selectedMachineScopeKey]);

    const runCatalogAction = React.useCallback((
        params: PluginMarketplaceActionRequest,
        reviewedInstallEntry?: PluginMarketplaceCatalogEntry,
    ) => {
        const initialTarget = resolveCurrentExecutionTarget(executionTarget);
        const isAuthorityCurrent = captureMutationPublication();
        if (
            (params.method !== 'install' && !daemonOperationsAvailableRef.current)
            || !selectedMachineScopeKey
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
            ? reviewedInstallEntry ?? catalog.resolveInstallEntry(params)
            : null;
        if (
            params.method === 'rollback'
            && installedBefore?.rollbackAvailability !== 'available'
        ) {
            return;
        }
        if (params.method === 'install') {
            if (
                !exactInstallEntry
                || indexInstalledPluginIdsByCatalogEntry(installedPluginByIdRef.current)(exactInstallEntry) !== null
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
            markPluginActionStarted(selectedMachineScopeKey, params.pluginId, exactInstallEntry?.sourceId);
            try {
                // An install's outcome reads inline under the Install that was pressed (and on its card), in one
                // sentence with the next action, never as an alert carrying a raw code.
                const installMachine = resolveMachineAdministrationTargetLabel({
                    target: initialTarget.target, candidates: administrationCandidatesRef.current,
                })?.machine ?? initialTarget.machine.id;
                const settleInstall = (outcome: 'failed' | 'unknown', detail?: string | null) => setRoutineOperationSettlement({
                    scope: 'discover',
                    message: outcome === 'unknown'
                        ? t('settingsPlugins.surfaces.installOutcomeUnknown', { machine: installMachine })
                        : t('settingsPlugins.surfaces.installFailedOn', { machine: installMachine }),
                    ...(detail ? { detail } : {}),
                    outcome,
                    pluginId: params.pluginId,
                    sourceId: exactInstallEntry?.sourceId,
                });
                const showMutationFailure = (outcome: string, reason: string | null) => {
                    if (params.method === 'install') {
                        settleInstall('failed', reason);
                        return;
                    }
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
                const isMutationOutcomeUnknown = (code: string | undefined) => code === 'outcomeUnknown'
                    || code === 'plugin_change_outcomeUnknown' || isActionOutcomeUnknownErrorCodeV1(code);
                const reportAmbiguousMutation = () => {
                    if (params.method === 'install') {
                        refreshPluginTruth();
                        settleInstall('unknown');
                        return;
                    }
                    reportUnknownMutation({
                        target: initialTarget,
                        actionLabel: resolvePluginChangeActionLabel(params.method),
                        name: installedBefore?.title ?? exactInstallEntry?.title ?? params.pluginId,
                    });
                };
                const requestChange = async (managedResourceDispositions?: readonly ManagedResourceDispositionV1[]): Promise<
                    | { supported: false; reason: 'cancelled' }
                    | { supported: true; registryRequirement: MarketplaceRegistryProfileRequirementV1 }
                    | { supported: true; response: Extract<CapabilitiesInvokeResponse, { ok: false }>
                        | Readonly<{ ok: true; result: PluginMutationResult }> }
                > => {
                    const actionFailure = (execution: ActionExecuteFailure, actionId: PluginDevLoopActionIdV1) => {
                        if (!isAuthorityCurrent()) {
                            return { supported: false as const, reason: 'cancelled' as const };
                        }
                        if (actionId === 'plugins.install' && execution.errorCode === 'plugin_registry_profile_required') {
                            const requirement = MarketplaceRegistryProfileRequirementV1Schema.safeParse(execution.details);
                            if (requirement.success) {
                                return { supported: true as const, registryRequirement: requirement.data };
                            }
                        }
                        if (isActionApprovalDeclinedErrorCode(execution.errorCode)) {
                            setRoutineOperationSettlement({
                                scope: params.method === 'install' ? 'discover' : 'installed',
                                // The settlement names what did not happen, not only the approval's status.
                                message: describeDeclinedPluginChange(params.method, execution.errorCode === 'approval_rejected'),
                                outcome: 'withdrawn',
                            });
                            return { supported: false as const, reason: 'cancelled' as const };
                        }
                        if (!presentActionTurnedOffNoticeIfOff(execution, actionId)
                            && !isMutationOutcomeUnknown(execution.errorCode)) {
                            if (params.method === 'install') settleInstall('failed');
                            else Modal.alert(t('common.error'), execution.error);
                        }
                        return { supported: true as const, response: { ok: false as const,
                            error: { code: execution.errorCode, message: execution.error } } };
                    };
                    try {
                        if (params.method === 'install' || params.method === 'update') {
                            const actionInput = params.method === 'install' && exactInstallEntry
                                ? buildPluginCatalogInstallInput(exactInstallEntry, initialTarget.machine.id)
                                : params.method === 'update'
                                    ? { machineId: initialTarget.machine.id, source: { kind: 'installed' as const, pluginId: params.pluginId } }
                                    : null;
                            if (!actionInput) return { supported: true as const, response: {
                                ok: false as const, error: { code: 'install_unavailable', message: t('common.unavailable') },
                            } };
                            // Listing Install & Trust and Browse's "+" both consent to this exact release and Machine.
                            // Installed updates leave scope review to the receiver.
                            const execution = await installedExecution.execute('plugins.install', actionInput,
                                params.method === 'install' ? { confirmed: true } : undefined);
                            if (!execution.ok) return actionFailure(execution, 'plugins.install');
                            return { supported: true as const, response: { ok: true as const,
                                result: projectPluginMutationResult(execution.result, params.method,
                                    actionInput.source.kind === 'gitCatalog' ? null : params.pluginId),
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
                        });
                        if (!execution.ok) return actionFailure(execution, actionId[params.method]);
                        return { supported: true as const, response: { ok: true as const,
                            result: projectPluginMutationResult(execution.result, params.method, params.pluginId) } };
                    } catch {
                        if (!isAuthorityCurrent()) {
                            return { supported: false, reason: 'cancelled' };
                        }
                        // A lost response may follow a commit. Report uncertainty without replaying the effect.
                        return { supported: true as const, response: { ok: false as const,
                            error: { code: 'outcomeUnknown', message: t('common.requestFailed') } } };
                    }
                };
                let response = await requestChange();
                if (!isAuthorityCurrent()) return;
                while ((params.method === 'disable' || params.method === 'uninstall')
                    && 'response' in response && response.response.ok) {
                    const resources = response.response.result.managedResources;
                    if (!resources) break;
                    const dispositions = await reviewManagedResourceRemoval(resources);
                    if (!dispositions || !isAuthorityCurrent()) return;
                    // A renewed daemon census is a new consent question, never a replay of older acknowledgments.
                    response = await requestChange(dispositions);
                    if (!isAuthorityCurrent()) return;
                }
                // Profile selection supplies the prerequisite named by the daemon.
                // Continue with the original release and target after it is saved.
                while (params.method === 'install' || params.method === 'update') {
                    const registryRequirement = 'registryRequirement' in response
                        ? response.registryRequirement
                        : 'response' in response && response.response.ok
                            ? response.response.result.registryRequirement
                            : null;
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
                    });
                    // The profile dialog owns source mutation and its existing revision publication.
                    if (!proceed || !isAuthorityCurrent()) return;
                    response = await requestChange();
                    if (!isAuthorityCurrent()) return;
                }

                if (!('response' in response)) {
                    return;
                }
                if (!response.response.ok) {
                    if (isMutationOutcomeUnknown(response.response.error.code)) {
                        reportAmbiguousMutation();
                    }
                    return;
                }

                const changeKind = response.response.result.kind;
                if (changeKind === 'cancelled') return;
                const disabledNoop = params.method === 'disable'
                    && response.response.result.disabledNoop;
                if (changeKind !== 'committed' && !disabledNoop) {
                    if (changeKind === 'outcomeUnknown') {
                        reportAmbiguousMutation();
                    } else {
                        showMutationFailure(
                            changeKind ?? 'invalid-response',
                            response.response.result.failureReason,
                        );
                        if (changeKind === 'dataRemovalPartial') {
                            refreshPluginTruth();
                        }
                    }
                    return;
                }
                setRoutineOperationSettlement({
                    scope: params.method === 'install' ? 'discover' : 'installed',
                    message: t('common.done'),
                });
                refreshPluginTruth();
            } finally {
                markPluginActionFinished(selectedMachineScopeKey, params.pluginId);
            }
        })();
    }, [administrationTargetSelection, daemonAdministrationAvailable, catalog.resolveInstallEntry, executionTarget, installedExecution.execute, captureMutationPublication, isPluginActionInFlight, markPluginActionFinished, markPluginActionStarted, reportUnknownMutation, refreshPluginTruth, resolveCurrentExecutionTarget, selectedMachineScopeKey]);

    const installFromBrowse = React.useCallback((listing: Readonly<{ pluginId: string; sourceId: string }>) => {
        if (!canRunDiscoverActions) return;
        const entry = catalog.resolveInstallEntry(listing);
        if (entry) runCatalogAction({ method: 'install', ...listing }, entry);
    }, [canRunDiscoverActions, catalog.resolveInstallEntry, runCatalogAction]);

    const runInstalledPluginAction = React.useCallback((
        action: InstalledPluginActionId,
        pluginId: string,
        scope?: 'account' | 'machine',
    ) => {
        const installed = installedPluginByIdRef.current.get(pluginId) ?? null;
        if (
            !installed
            || !selectedMachineScopeKey
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
    }, [isPluginActionInFlight, selectedMachineScopeKey, runCatalogAction]);

    const setInstalledPluginUpdatePolicy = React.useCallback((
        pluginId: string,
        policy: PluginUpdatePolicyV1,
    ) => {
        runCatalogAction({ method: 'setUpdatePolicy', pluginId, policy });
    }, [runCatalogAction]);

    const invokeDevelopmentAction = React.useCallback(async (
        actionId: PluginDevLoopActionIdV1,
        input: unknown,
        target: FreshMachineAdministrationExecutionTargetV1,
        isAuthorityCurrent: () => boolean,
    ): Promise<boolean> => {
        if (!isAuthorityCurrent()) return false;
        try {
            const response = await installedExecution.execute(actionId, input, {
                executionRunTargetMachineId: target.machine.id,
            });
            if (!isAuthorityCurrent()) return false;
            if (!response.ok) {
                if (isActionApprovalDeclinedErrorCode(response.errorCode)) return false;
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
    }, [installedExecution.execute]);

    // Keyed by the source root: a source the daemon could not load has no installed plugin.
    // The root also keys its in-flight marker.
    const runDevelopmentAction = React.useCallback((action: 'test' | 'pack' | 'unregister', sourceRootPath: string) => {
        const development = developmentPlugins.find((entry) => entry.sourceRootPath === sourceRootPath) ?? null;
        const initialTarget = resolveCurrentExecutionTarget(executionTarget);
        const isAuthorityCurrent = captureMutationPublication();
        if (
            !daemonOperationsAvailableRef.current
            || !selectedMachineScopeKey
            || !initialTarget
            || !development
            || development.actions[action] !== true
            || isPluginActionInFlight(sourceRootPath)
        ) {
            return;
        }

        void (async () => {
            markPluginActionStarted(selectedMachineScopeKey, sourceRootPath);
            try {
                const succeeded = await invokeDevelopmentAction(
                    action === 'pack' ? 'plugins.pack' : action === 'test' ? 'plugins.dev.test' : 'plugins.dev.unregister',
                    action === 'pack' ? { locator: development.sourceRootPath } : { projectRoot: development.sourceRootPath },
                    initialTarget,
                    isAuthorityCurrent,
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
                    refreshPluginTruth();
                }
            } finally {
                markPluginActionFinished(selectedMachineScopeKey, sourceRootPath);
            }
        })();
    }, [developmentPlugins, executionTarget, invokeDevelopmentAction, isPluginActionInFlight, markPluginActionFinished, markPluginActionStarted, selectedMachineScopeKey, captureMutationPublication, refreshPluginTruth, resolveCurrentExecutionTarget]);

    const resolveDevelopmentEditTarget = React.useCallback((
        pluginId: string,
    ): Promise<DevelopmentEditTargetSettlement> => {
        const initialTarget = resolveCurrentExecutionTarget(executionTarget);
        const isAuthorityCurrent = captureMutationPublication();
        if (
            !daemonOperationsAvailableRef.current
            || !selectedMachineScopeKey
            || !initialTarget
            || !developmentPlugins.some((entry) => entry.installed?.pluginId === pluginId)
        ) {
            return Promise.resolve({ status: 'unavailable', reason: 'operationUnavailable' });
        }

        return (async (): Promise<DevelopmentEditTargetSettlement> => {
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
    }, [developmentPlugins, executionTarget, invokeWithAlerts, selectedMachineScopeKey, captureMutationPublication, resolveCurrentExecutionTarget]);

    const runDevelopmentCreate = React.useCallback((params: Readonly<{
        targetDir: string;
        displayName: string;
        pluginId: string;
        ui?: PluginScaffoldUiMode;
    }>): Promise<DevelopmentCreateSettlement> => {
        const initialTarget = resolveCurrentExecutionTarget(executionTarget);
        const isAuthorityCurrent = captureMutationPublication();
        if (
            !daemonOperationsAvailableRef.current
            || !selectedMachineScopeKey
            || !developmentCreateAvailable
            || !initialTarget
            || isPluginActionInFlight(params.pluginId)
        ) {
            return Promise.resolve({ status: 'unavailable', reason: 'operationUnavailable' });
        }

        return (async (): Promise<DevelopmentCreateSettlement> => {
            markPluginActionStarted(selectedMachineScopeKey, params.pluginId);
            try {
                const execution = await installedExecution.execute('plugins.scaffold', {
                    machineId: initialTarget.machine.id,
                    targetDir: params.targetDir,
                    name: params.displayName,
                    id: params.pluginId,
                    ...(params.ui ? { ui: params.ui } : {}),
                });
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
                markPluginActionFinished(selectedMachineScopeKey, params.pluginId);
            }
        })();
    }, [developmentCreateAvailable, executionTarget, installedExecution.execute, isPluginActionInFlight, markPluginActionFinished, markPluginActionStarted, selectedMachineScopeKey, captureMutationPublication, resolveCurrentExecutionTarget]);

    /** Explicit source trust and optional access use the ordinary install approval owner. */
    const runDevelopmentSourceInstall = React.useCallback((sourceRootPath: string) => {
        const trimmedSourceRootPath = sourceRootPath.trim();
        const initialTarget = resolveCurrentExecutionTarget(executionTarget);
        const isAuthorityCurrent = captureMutationPublication();
        if (
            !daemonOperationsAvailableRef.current
            || !selectedMachineScopeKey
            || !initialTarget
            || !trimmedSourceRootPath
            || !developmentSourceInstallAvailable
            || isPluginActionInFlight(trimmedSourceRootPath)
        ) return;

        void (async () => {
            markPluginActionStarted(selectedMachineScopeKey, trimmedSourceRootPath);
            try {
                const succeeded = await invokeDevelopmentAction(
                    'plugins.install',
                    { machineId: initialTarget.machine.id, path: trimmedSourceRootPath, dev: true },
                    initialTarget,
                    isAuthorityCurrent,
                );
                if (!succeeded) return;
                setRoutineOperationSettlement({
                    scope: 'development',
                    message: t('settingsPlugins.developmentSourceInstallSucceeded'),
                    detail: trimmedSourceRootPath,
                });
                refreshPluginTruth();
            } finally {
                markPluginActionFinished(selectedMachineScopeKey, trimmedSourceRootPath);
            }
        })();
    }, [developmentSourceInstallAvailable, executionTarget, invokeDevelopmentAction, isPluginActionInFlight, markPluginActionFinished, markPluginActionStarted, selectedMachineScopeKey, captureMutationPublication, refreshPluginTruth, resolveCurrentExecutionTarget]);
    const runGitSourceInstall = React.useCallback((source: PluginGitSourceV1) => {
        const target = resolveCurrentExecutionTarget(executionTarget);
        const isAuthorityCurrent = captureMutationPublication();
        if (!target || !isAuthorityCurrent() || !selectedMachineScopeKey || isPluginActionInFlight(source.locator)) return false;
        void (async () => {
            markPluginActionStarted(selectedMachineScopeKey, source.locator);
            try {
                if (await invokeDevelopmentAction('plugins.install', { machineId: target.machine.id, source: { kind: 'git', ...source } },
                    target, isAuthorityCurrent)) refreshPluginTruth();
            } finally {
                markPluginActionFinished(selectedMachineScopeKey, source.locator);
            }
        })();
        return true;
    }, [captureMutationPublication, executionTarget, invokeDevelopmentAction, isPluginActionInFlight, markPluginActionFinished,
        markPluginActionStarted, refreshPluginTruth, resolveCurrentExecutionTarget, selectedMachineScopeKey]);
    const previewGitSource = React.useCallback(async (source: PluginGitSourceV1): Promise<PluginGitSourcePreviewResult | null> => {
        const target = resolveCurrentExecutionTarget(executionTarget);
        const isAuthorityCurrent = captureMutationPublication();
        if (!target || !isAuthorityCurrent()) return null;
        const response = await installedExecution.execute('plugins.git.preview', { machineId: target.machine.id, source },
            { executionRunTargetMachineId: target.machine.id });
        if (!isAuthorityCurrent()) return null;
        if (!response.ok) return { kind: 'failed', message: response.error };
        const parsed = PluginGitPreviewActionOutputSchema.safeParse(response.result);
        return parsed.success ? { kind: 'preview', preview: parsed.data } : { kind: 'failed', message: t('common.unavailable') };
    }, [captureMutationPublication, executionTarget, installedExecution.execute, resolveCurrentExecutionTarget]);
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
        ...catalog,
        catalogAccountLifetime: catalog.execution.binding,
        catalogAccountLifetime: catalog.execution.binding,
        canRunDiscoverActions,
        discoverInstallDisabledReason,
        canRefreshInstalledPlugins,
        daemonOperationsAvailable,
        daemonAdministrationAvailable,
        developmentCreateAvailable,
        developmentSourceInstallAvailable,
        developmentPlugins,
        installedPluginById,
        installedPlugins,
        pendingPluginChanges,
        pluginActionApproval: installedExecution.approval,
        pluginInstallReview: installReviewSet.review,
        runCatalogInstallOnMachines: installReviewSet.run,
        routineOperationSettlement,
        readOnlySnapshotNotice,
        refreshPluginTruth,
        isPluginActionInFlight,
        pluginProjectionById,
        pluginProjectionV2,
        pluginTruthSettled,
        installedPluginsRead,
        registryDiagnostics,
        runCatalogAction,
        installFromBrowse,
        runDevelopmentCreate,
        resolveDevelopmentEditTarget,
        runDevelopmentSourceInstall,
        runGitSourceInstall,
        previewGitSource,
        runDevelopmentAction,
        runInstalledPluginAction,
        setInstalledPluginUpdatePolicy,
        setActiveView,
    };
}
