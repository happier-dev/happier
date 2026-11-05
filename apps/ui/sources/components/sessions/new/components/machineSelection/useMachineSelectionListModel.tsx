import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import type {
    SelectionListOption,
    SelectionListSectionDescriptor,
    SelectionListStep,
} from '@/components/ui/selectionList';
import { t } from '@/text';
import { usePreferredLanguage } from '@/text/usePreferredLanguage';
import type { Machine } from '@/sync/domains/state/storageTypes';
import type { MachineDisplayRenderable } from '@/sync/domains/machines/machineDisplayRenderable';
import { buildMachineOwnershipGroups, describeMachineSharedOwnership, describeMachineSharedGroupTitle } from '@/sync/domains/machines/machineOwnershipGroups';
import type {
    ServerScopedMachineGroup,
    ServerScopedMachinePresentation,
} from '@/components/sessions/new/hooks/machines/useServerScopedMachineOptions';

import {
    buildMachineSelectionBuckets,
    type MachineSelectionBucketId,
    type MachineSelectionFavoriteGroupPlacement,
} from './buildMachineSelectionBuckets';
import { MachinePresenceDot, MachineRowMark, MachineSelectionRowAccessory } from './MachineSelectionRowAccessory';
import { describeMachinePresenceLine, projectMachineManagedPresence } from '@/utils/sessions/machinePresenceLine';
import { formatOSPlatform } from '@/utils/sessions/sessionUtils';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { useManagedMachineInventory } from '@/components/settings/machines/managed/useManagedMachineInventory';
import {
    resolveMachinePoolRowUnavailableReason,
    resolveMachineDestinationPurposeEligibility,
    describeMachineDestinationEligibility,
    describeMachineDestinationWorkerFacts,
    type MachineDestinationPlacementFacts,
    type MachineDestinationWorkerSubject,
    type MachinePoolRowUnavailableReason,
} from './buildMachineDestinationModel';
import { resolveMachinePickerPresence } from '../resolveMachinePickerPresence';
import type { MachineReachabilityScope } from '@/sync/domains/machines/reachability/machineReachability';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import type { MachinePoolViewV1, SessionAuthoringExecutionTargetV2 } from '@happier-dev/protocol';
import type { MachineDestinationPurposeV1 } from '@happier-dev/protocol/machines/pools';
import type { MachinePoolSelectionStatus } from '@/components/sessions/new/hooks/machines/useMachinePoolSelection';
import { useMachineDestinationWorkerStatus, type MachineDestinationWorkerPlacement } from '@/components/sessions/new/hooks/machines/useMachineDestinationWorkerStatus';
import type { MachinePoolListStatus } from '@/sync/store/domains/machinePools';
import type { MachinePoolFeatureStatus } from '@/sync/engine/machines/useMachinePoolProjections';
import {
    buildMachinePoolRowPresentations,
    resolveMachinePoolEnabledMemberLabels,
} from '@/components/machines/pools/machinePoolRowPresentation';
import type { RunnerArtifactTarget } from '@happier-dev/protocol/ephemeralRunner/runnerArtifact';
import { describeRunnerArtifactTarget } from '@/components/sessions/new/hooks/temporaryComputerTargetPresentation';
import {
    temporaryComputerTargetIdentity,
    temporaryComputerTargetOptionKey,
} from './temporaryComputerTargetIdentity';
import { showTemporaryComputerExpiryModal } from './TemporaryComputerExpiryModal';
import { getMachineDisplayName, resolveMachineDisplayNames } from '@/utils/sessions/machineDisplayNames';
import { useMachinePresenceSnapshot } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';
import {
    managedMachineSelectionOptionId,
    type ManagedMachineSelectionDraft,
    type ManagedMachineSelectionOffer,
} from './managedMachineSelection';

type MachineSelectionListModel = Readonly<{
    rootStep: SelectionListStep;
    selectedOptionId: string | null;
    managedWakeByServerId: Readonly<Record<string, Readonly<Record<string, 'asleep' | 'starting'>>>>;
    /**
     * Machines whose only reason for not being selectable is that they are offline, per Home. A Machine
     * refused for locked content, pending access or a worker refusal keeps its own named reason and is
     * never listed, so a presentation that groups offline Machines cannot hide a repair reason.
     */
    offlineOnlyMachineIdsByServerId: Readonly<Record<string, ReadonlyArray<string>>>;
}>;

export type ServerScopedMachinePoolGroup = Readonly<{
    serverId: string;
    /** Exact credential Account that owns this Home projection. */
    accountId: string | null;
    serverName: string;
    pools: ReadonlyArray<MachinePoolViewV1>;
    featureStatus?: MachinePoolFeatureStatus;
    status?: MachinePoolListStatus;
    projectionReady?: boolean;
}>;

export type ServerScopedMachinePoolSelection = Readonly<{
    serverId: string;
    accountId: string;
    pool: MachinePoolViewV1;
}>;

export type TemporaryComputerSelection = Readonly<{
    serverId: string;
    /** Exact platform projected by the authenticated Home publication owner. */
    artifactTarget: RunnerArtifactTarget | null;
    selected: boolean;
    workspace: Extract<SessionAuthoringExecutionTargetV2, { kind: 'temporary_computer' }>['workspace'] | null;
    /** Committed absolute package expiry, or undefined for the default (Never). */
    packageExpiresAt?: number;
    disabled?: boolean;
    unavailableText?: string;
    onRetry?: () => void;
    onSelect: (
        workspace: Extract<SessionAuthoringExecutionTargetV2, { kind: 'temporary_computer' }>['workspace'],
        packageExpiresAt: number | undefined,
    ) => void;
}>;

/**
 * Shortcuts for the optional absolute package expiry offered beside the starting
 * folder. They are conveniences, not the range: any future local moment is
 * reachable through the shared date/time editor beside them.
 *
 * Absolute by construction: the offset is resolved to an instant at the moment
 * the author picks it, so nothing downstream has to keep counting. `undefined`
 * is Never, the default, and stays the default unless the author says otherwise.
 */
const TEMPORARY_COMPUTER_EXPIRY_OFFSETS_MS = {
    inOneDay: 24 * 60 * 60 * 1000,
    inOneWeek: 7 * 24 * 60 * 60 * 1000,
} as const;

/** A row of the list: the machine the caller supplied, scoped to the Home that listed it. */
export type ScopedSelectionMachine<TMachine extends MachineDisplayRenderable = Machine> = TMachine & ServerScopedMachinePresentation;

/**
 * A consuming domain's own decision about whether a machine row can be chosen. When given, it
 * replaces the presence default (offline → disabled); `detail` is the row's reason whenever the row
 * is disabled or the machine is not currently online.
 */
export type MachineSelectionAvailability = Readonly<{
    selectable: boolean;
    detail?: string;
}>;

export type MachineSelectionPresentation = Readonly<{
    title?: string;
    subtitle?: string;
}>;

function supportsManagedMachineSelection(purpose: MachineDestinationPurposeV1): boolean {
    return purpose === 'session' || purpose === 'finite' || purpose === 'service-start';
}

export type BuildMachineSelectionListModelParams<TMachine extends MachineDisplayRenderable = Machine> = Readonly<{
    purpose?: MachineDestinationPurposeV1;
    workerPlacement?: MachineDestinationWorkerPlacement;
    /** What a finite/service-start row is about, so a memory refusal can name its need. */
    workerSubject?: MachineDestinationWorkerSubject;
    resolveMachinePlacementFacts?: (machine: TMachine, serverId: string) => MachineDestinationPlacementFacts;
    groups: ReadonlyArray<ServerScopedMachineGroup<ScopedSelectionMachine<TMachine>>>;
    poolGroups?: ReadonlyArray<ServerScopedMachinePoolGroup>;
    selectedMachine: TMachine | null;
    selectedServerId: string | null;
    recentMachines: ReadonlyArray<TMachine>;
    favoriteMachines: ReadonlyArray<TMachine>;
    onSelectMachine: (machine: TMachine) => void;
    onSelectScopedMachine: (machine: ScopedSelectionMachine<TMachine>) => void;
    /** Domain-owned availability; omit it to keep the canonical presence rule. */
    resolveMachineAvailability?: (machine: TMachine, serverId: string) => MachineSelectionAvailability;
    /** Domain-owned naming or detail; omitted titles retain canonical Machine naming. */
    resolveMachinePresentation?: (machine: TMachine) => MachineSelectionPresentation;
    onSelectPool?: (selection: ServerScopedMachinePoolSelection) => void;
    poolSelectionStatus?: MachinePoolSelectionStatus;
    /** Re-reads the canonical Machine/Home projection after that projection failed. */
    onRefreshMachines?: () => void;
    /** Re-reads this Home's Pool projection through the canonical refresh owner. */
    onRefreshPools?: (serverId: string) => void;
    /** Opens the existing Machine Pool settings route for the exact Pool the user activated. */
    onOpenPoolSettings?: (target: Readonly<{ serverId: string; poolId: string }>) => void;
    /** Retires the failed Pool feedback so the exact Machine rows are the next choice. */
    onDismissPoolSelection?: () => void;
    serverId?: string | null;
    onToggleFavorite?: (machine: TMachine) => void;
    showFavorites: boolean;
    showRecent: boolean;
    showSearch: boolean;
    showCliGlyphs: boolean;
    autoDetectCliGlyphs: boolean;
    /** Present only after the canonical feature/capability/artifact decision resolves enabled. */
    temporaryComputers?: readonly TemporaryComputerSelection[];
    /** Accessible presets and one-off configuration, supplied by the managed projection owner. */
    managedMachines?: readonly ManagedMachineSelectionOffer[];
    selectedManagedMachine?: ManagedMachineSelectionDraft | null;
    /** Commits local reviewed intent only; explicit admission owns resource acquisition. */
    onSelectManagedMachine?: (draft: ManagedMachineSelectionDraft) => void;
    /** Opens the Machines presets (the managed group's trailing "Presets" destination). */
    onOpenManagedPresets?: () => void;
    /** Opens the Add a machine flow: the list's last row, "Connect a computer…" (lab m-pick). */
    onConnectMachine?: () => void;
    favoriteGroupPlacement?: MachineSelectionFavoriteGroupPlacement;
    testIdPrefix?: string;
    disableOfflineMachines?: boolean;
    includeSelectedUnavailableMachineId?: string | null;
    searchPlaceholder?: string;
    emptyStateLabel?: string;
    sectionTitles?: Readonly<Partial<Record<MachineSelectionBucketId, string>>>;
}>;


/** The host, when there is one; a machine's id is never its subtitle. */
function machineSubtitle(machine: MachineDisplayRenderable): string | undefined {
    return machine.metadata?.host || undefined;
}

/**
 * The machine row's second line (K1 picker anatomy): presence first ("Online", "Offline · last seen
 * 4 days ago"), then the row's own fact when it has one (a domain's reason, the Home's detail).
 */
function machineStatusLine(machine: MachineDisplayRenderable, scope: MachineReachabilityScope | null | undefined, detail: string | undefined, managedMachine?: ManagedMachineV1): string {
    const presence = describeMachinePresenceLine(machine, undefined, projectMachineManagedPresence(machine, managedMachine), scope);
    // An online machine says what it is ("Online · Linux", lab m-pick); an offline one keeps its
    // last-seen time as its only fact, so the line stays short.
    const platform = presence.online ? formatOSPlatform(machine.metadata?.platform ?? undefined) : '';
    return [presence.label, describeMachineSharedOwnership(machine), platform, detail].filter(Boolean).join(' · ');
}

function buildOptionTestID(testIdPrefix: string | undefined, machine: MachineDisplayRenderable): string | undefined {
    const normalized = typeof testIdPrefix === 'string' ? testIdPrefix.trim() : '';
    return normalized ? `${normalized}-option:${machine.id}` : undefined;
}

function buildReadinessTestID(testIdPrefix: string | undefined, machine: MachineDisplayRenderable): string | undefined {
    const normalized = typeof testIdPrefix === 'string' ? testIdPrefix.trim() : '';
    return normalized ? `${normalized}-readiness:${machine.id}` : undefined;
}

function buildPoolOptionTestID(testIdPrefix: string | undefined, serverId: string, poolId: string): string | undefined {
    const normalized = typeof testIdPrefix === 'string' ? testIdPrefix.trim() : '';
    return normalized ? `${normalized}-pool-option:${serverId}:${poolId}` : undefined;
}

function buildPoolActionTestID(
    testIdPrefix: string | undefined,
    serverId: string,
    action: string,
): string | undefined {
    const normalized = typeof testIdPrefix === 'string' ? testIdPrefix.trim() : '';
    return normalized ? `${normalized}-pool-${action}:${serverId}` : undefined;
}

function poolMemberSummary(
    pool: MachinePoolViewV1,
    machines: ReadonlyArray<MachineDisplayRenderable>,
    options?: Readonly<{ includeAvailability?: boolean }>,
): string {
    const memberLabels = resolveMachinePoolEnabledMemberLabels(pool, machines);
    const members = memberLabels.join(', ');
    if (options?.includeAvailability === false) return members;
    const availability = pool.availability.state === 'known'
        ? t('machinePools.availabilityKnown', {
            connected: pool.availability.connectedCount,
            enabled: pool.availability.enabledCount,
        })
        : t('machinePools.availabilityUnknown');
    return members ? `${members} · ${availability}` : availability;
}

/**
 * The row's truthful current state. A retained row belonging to a loading, signed-out or failed Home
 * must never advertise its cached connection summary as a current observation.
 */
function poolRowUnavailableText(reason: MachinePoolRowUnavailableReason): string {
    switch (reason) {
        case 'homeSignedOut':
        case 'poolsSignedOut':
            return t('server.signedOut');
        case 'homeLoading':
        case 'poolsLoading':
            return t('common.loading');
        case 'homeFailed':
            return t('common.error');
        case 'poolsFailed':
            return t('machinePools.refreshFailed');
    }
}

function poolSelectionFeedback(
    status: MachinePoolSelectionStatus | undefined,
    serverId: string,
    accountId: string | null,
    poolId: string,
): string | null {
    if (
        !status
        || status.kind === 'idle'
        || status.serverId !== serverId
        || status.accountId !== accountId
        || status.poolId !== poolId
    ) return null;
    if (status.kind === 'resolving') return t('machinePools.resolvingTarget');
    if (status.kind === 'error') return t('machinePools.resolveFailed');
    switch (status.reason) {
        case 'empty': return t('machinePools.resolveEmpty');
        case 'no_available_machine': return t('machinePools.resolveNoAvailable');
        // A worker whose status cannot be read leaves the pool's availability just as unknown as presence does.
        case 'presence_unavailable':
        case 'worker_status_unavailable': return t('machinePools.resolvePresenceUnavailable');
    }
}

function bucketTitle(bucketId: MachineSelectionBucketId): string {
    switch (bucketId) {
        case 'recent':
            return t('newSession.machinePicker.recentTitle');
        case 'favorites':
            return t('newSession.machinePicker.favoritesTitle');
        case 'all':
            // The person's own machines (lab m-pick): shared ones have their own section.
            return t('machines.destinations.yours');
        case 'shared':
            return describeMachineSharedGroupTitle(undefined);
    }
}


/**
 * Presence is the Machine's only blocker: it is offline and nothing else (content, access, a worker's
 * own refusal) stands between it and the destination. The one decision both the row reason and the
 * offline grouping read.
 */
function isBlockedOnlyByPresence(
    eligibility: ReturnType<typeof resolveMachineDestinationPurposeEligibility>,
    presence: ReturnType<typeof resolveMachinePickerPresence>,
): boolean {
    if (presence.status !== 'offline') return false;
    return eligibility.eligible ? !eligibility.managedWake : eligibility.reason === 'worker_status_unavailable';
}

/**
 * Whether a row can be chosen, and the reason it shows. Presence is the default; a consuming domain's
 * decision replaces it, and its reason is shown whenever the row is disabled or the machine is not
 * online, so an offline row the domain keeps selectable still says why.
 */
function resolveRowAvailability<TMachine extends MachineDisplayRenderable>(
    machine: TMachine,
    serverId: string,
    resolveMachineAvailability: BuildMachineSelectionListModelParams<TMachine>['resolveMachineAvailability'],
    purpose: MachineDestinationPurposeV1,
    resolveMachinePlacementFacts: BuildMachineSelectionListModelParams<TMachine>['resolveMachinePlacementFacts'],
    workerSubject: MachineDestinationWorkerSubject | undefined,
    scope: MachineReachabilityScope | null | undefined,
): Readonly<{ selectable: boolean; reason?: string }> {
    const eligibility = resolveMachineDestinationPurposeEligibility(purpose, resolveMachinePlacementFacts?.(machine, serverId), machine, scope);
    const presence = resolveMachinePickerPresence(machine, undefined, scope);
    if (!eligibility.eligible) {
        // An offline machine answers no worker status; its presence line already says why it can't be chosen.
        return { selectable: false, reason: isBlockedOnlyByPresence(eligibility, presence) ? undefined : describeMachineDestinationEligibility(eligibility, machine, workerSubject, purpose) };
    }
    const decided = resolveMachineAvailability?.(machine, serverId);
    // An eligible worker row says its current load (or that it is unknown), never a guessed zero.
    if (!decided) return { selectable: presence.selectable || !!eligibility.managedWake, reason: describeMachineDestinationWorkerFacts(eligibility, workerSubject, purpose, getMachineDisplayName(machine) ?? machine.id) };
    return {
        selectable: decided.selectable,
        reason: !decided.selectable || !presence.selectable ? decided.detail : undefined,
    };
}

export function useMachineSelectionListModel<TMachine extends MachineDisplayRenderable = Machine>(
    params: BuildMachineSelectionListModelParams<TMachine>,
): MachineSelectionListModel {
    const language = usePreferredLanguage();
    const purpose = params.purpose ?? 'session';
    const managedHomes = React.useMemo(() => params.groups.map(group => group.serverId), [params.groups]);
    const bindings = useServerCredentialAccountScopeBindings(managedHomes);
    const scopeForServer = React.useCallback((serverId: string) => {
        const binding = bindings.get(resolveServerProfileScopeIdForIdentifier(serverId));
        return binding?.isCurrent() ? binding.scope : null;
    }, [bindings]);
    const { machinesByEnrolledMachineIdByServerId, entries: managedEntries } = useManagedMachineInventory(managedHomes);
    const managedEntry = params.workerPlacement ? managedEntries[params.workerPlacement.workspace.serverId] : undefined;
    const demandedWorkerFacts = useMachineDestinationWorkerStatus({ purpose, workerPlacement: params.workerPlacement, groups: params.groups,
        managedMachines: managedEntry?.status === 'ready' ? managedEntry.machines : undefined });
    const resolveMachinePlacementFacts = params.workerPlacement && (purpose === 'finite' || purpose === 'service-start')
        ? demandedWorkerFacts : params.resolveMachinePlacementFacts;
    const { theme } = useUnistyles();
    const readPresenceMachines = React.useCallback(() => params.groups.flatMap(group => group.machines), [params.groups]);
    const readPresence = React.useCallback((nowMs: number) => JSON.stringify(params.groups.map(group =>
        group.machines.map(machine => describeMachinePresenceLine(machine, nowMs, undefined, scopeForServer(group.serverId))),
    )), [params.groups, scopeForServer]);
    // The same owner that admits requests wakes the row's label, disabled state
    // and buckets on recovery/withdrawal/expiry without rebuilding on heartbeats.
    const presenceTargets = React.useMemo(() => params.groups.map(group => ({ serverId: group.serverId,
        machineIds: group.machines.map(machine => machine.id) })), [params.groups]);
    const presenceKey = useMachinePresenceSnapshot(readPresenceMachines, readPresence, presenceTargets);

    // The row handlers are BEHAVIOUR, not data, so they are held in a ref and
    // invoked through stable wrappers instead of being memo dependencies.
    //
    // The machine popover builds its content through
    // `renderContent({ requestClose, maxHeight })`, which the floating overlay
    // re-invokes with fresh inline arrows on every render while the popover is
    // open (at minimum once more when the measured placement lands). With the
    // raw handlers in the dependency list, each of those passes rebuilt the
    // whole step tree — every option object plus its `icon` and
    // `rightAccessory` elements — so React lost element identity for every row
    // and re-rendered each row's Phosphor icon, readiness accessory and CLI
    // glyphs subtree instead of skipping them. Only the DATA inputs below may
    // invalidate the model; a replaced handler is picked up through the ref on
    // the next activation.
    const handlersRef = React.useRef({
        purpose,
        onSelectMachine: params.onSelectMachine,
        onSelectScopedMachine: params.onSelectScopedMachine,
        onSelectPool: params.onSelectPool,
        onToggleFavorite: params.onToggleFavorite,
        temporaryComputers: params.temporaryComputers,
        managedMachines: params.managedMachines,
        onSelectManagedMachine: params.onSelectManagedMachine,
        onOpenManagedPresets: params.onOpenManagedPresets,
        onConnectMachine: params.onConnectMachine,
        onRefreshMachines: params.onRefreshMachines,
        onRefreshPools: params.onRefreshPools,
        onOpenPoolSettings: params.onOpenPoolSettings,
        onDismissPoolSelection: params.onDismissPoolSelection,
    });
    React.useEffect(() => {
        handlersRef.current = {
            purpose,
            onSelectMachine: params.onSelectMachine,
            onSelectScopedMachine: params.onSelectScopedMachine,
            onSelectPool: params.onSelectPool,
            onToggleFavorite: params.onToggleFavorite,
            temporaryComputers: params.temporaryComputers,
            managedMachines: params.managedMachines,
            onSelectManagedMachine: params.onSelectManagedMachine,
            onOpenManagedPresets: params.onOpenManagedPresets,
            onConnectMachine: params.onConnectMachine,
            onRefreshMachines: params.onRefreshMachines,
            onRefreshPools: params.onRefreshPools,
            onOpenPoolSettings: params.onOpenPoolSettings,
            onDismissPoolSelection: params.onDismissPoolSelection,
        };
    });
    const selectMachine = React.useCallback((machine: TMachine) => {
        handlersRef.current.onSelectMachine(machine);
    }, []);
    const selectScopedMachine = React.useCallback((machine: ScopedSelectionMachine<TMachine>) => {
        handlersRef.current.onSelectScopedMachine(machine);
    }, []);
    const toggleFavorite = React.useCallback((machine: TMachine) => {
        handlersRef.current.onToggleFavorite?.(machine);
    }, []);
    const selectPool = React.useCallback((selection: ServerScopedMachinePoolSelection) => {
        handlersRef.current.onSelectPool?.(selection);
    }, []);
    const refreshMachines = React.useCallback(() => {
        handlersRef.current.onRefreshMachines?.();
    }, []);
    const refreshPools = React.useCallback((serverId: string) => {
        handlersRef.current.onRefreshPools?.(serverId);
    }, []);
    const openPoolSettings = React.useCallback((target: Readonly<{ serverId: string; poolId: string }>) => {
        handlersRef.current.onOpenPoolSettings?.(target);
    }, []);
    const dismissPoolSelection = React.useCallback(() => {
        handlersRef.current.onDismissPoolSelection?.();
    }, []);
    const openManagedPresets = React.useCallback(() => {
        handlersRef.current.onOpenManagedPresets?.();
    }, []);
    const connectMachine = React.useCallback(() => {
        handlersRef.current.onConnectMachine?.();
    }, []);
    const selectManagedMachine = React.useCallback((offerId: string) => {
        if (!supportsManagedMachineSelection(handlersRef.current.purpose)) return;
        const offer = handlersRef.current.managedMachines?.find((candidate) => candidate.id === offerId);
        if (!offer || offer.disabled) return;
        if (offer.draft) handlersRef.current.onSelectManagedMachine?.(offer.draft);
        else offer.onSelect?.();
    }, []);
    // Pending expiry choice for the target the user is currently configuring.
    // It never survives a different target: an expiry is meaningful only
    // together with the platform and folder it is committed with. The write here
    // and the read in `selectTemporaryComputer` go through the one canonical
    // target identity, because two hand-rolled joins already drifted apart once
    // and silently threw the author's chosen expiry away on commit.
    const [pendingExpiry, setPendingExpiry] = React.useState<Readonly<{
        identity: string;
        /** Which offered shortcut produced `expiresAt`, or `null` for Never or a custom instant. */
        offset: string | null;
        expiresAt: number | undefined;
    }> | null>(null);
    const selectTemporaryComputer = React.useCallback((
        serverId: string,
        artifactTarget: RunnerArtifactTarget,
        workspace: Extract<SessionAuthoringExecutionTargetV2, { kind: 'temporary_computer' }>['workspace'],
    ) => {
        const candidate = handlersRef.current.temporaryComputers?.find((entry) => (
            entry.serverId === serverId && entry.artifactTarget === artifactTarget
        ));
        if (!candidate) return;
        const identity = temporaryComputerTargetIdentity(serverId, artifactTarget);
        candidate.onSelect(
            workspace,
            pendingExpiry?.identity === identity ? pendingExpiry.expiresAt : candidate.packageExpiresAt,
        );
    }, [pendingExpiry]);
    // Presence (not identity) of the favorite handler is a real render input:
    // `MachineSelectionRowAccessory` only paints the star when it receives one.
    const favoriteToggle = typeof params.onToggleFavorite === 'function'
        ? toggleFavorite
        : undefined;
    // Presence (not identity) of each recovery handler is a real render input: the picker only
    // offers an action a host can actually perform.
    const hasRefreshMachines = typeof params.onRefreshMachines === 'function';
    const hasRefreshPools = typeof params.onRefreshPools === 'function';
    const hasOpenPoolSettings = typeof params.onOpenPoolSettings === 'function';
    const hasDismissPoolSelection = typeof params.onDismissPoolSelection === 'function';
    const hasSelectManagedMachine = typeof params.onSelectManagedMachine === 'function';
    const hasOpenManagedPresets = typeof params.onOpenManagedPresets === 'function';
    const hasConnectMachine = typeof params.onConnectMachine === 'function';

    const model = React.useMemo(() => {
        const inputPlaceholder = params.showSearch
            ? params.searchPlaceholder ?? t('newSession.machinePicker.searchPlaceholder')
            : undefined;

        /**
         * One Pool-section builder for both presentations. Recovery lives beside the row that
         * failed, and every action is a direct call into an existing owner — the canonical Pool
         * refresh, the Machine Pool settings route, or clearing the pending selection — rather than
         * a recovery queue, backoff timer or second status store.
         */
        const buildPoolSectionOptions = (
            poolGroup: ServerScopedMachinePoolGroup,
            group: ServerScopedMachineGroup<ScopedSelectionMachine<TMachine>>,
            iconSize: number,
        ): SelectionListOption[] => {
            // A settled feature-off Home has no Pool destinations and no Pool
            // operation to offer, exactly as Machine Pool Settings decides for the
            // same state. Advertising a permanently dead section — on every
            // supported older Home and every operator opt-out — would regress the
            // exact-Machine picker and contradict the sibling surface.
            if (poolGroup.featureStatus === 'disabled') return [];
            const unavailableReason = resolveMachinePoolRowUnavailableReason({ group, poolGroup });
            // Feedback belongs to exactly one activated row on one Home; every other row keeps its
            // own state, so a pending or failed selection never repaints an unrelated Home.
            const selection = params.poolSelectionStatus;
            const status = selection
                && selection.kind !== 'idle'
                && selection.serverId === poolGroup.serverId
                && selection.accountId === poolGroup.accountId
                ? selection
                : null;
            const options: SelectionListOption[] = buildMachinePoolRowPresentations(
                poolGroup.pools,
                (pool) => poolMemberSummary(pool, group.machines),
            ).map(({ view: pool, identityDetail, accessibilityName }) => {
                const resolving = status?.kind === 'resolving' && status.poolId === pool.pool.id;
                // A non-current Home reports why, instead of repeating a retained connection count
                // as though it were observed just now.
                const summary = unavailableReason === null
                    ? poolMemberSummary(pool, group.machines)
                    : [poolMemberSummary(pool, group.machines, { includeAvailability: false }), poolRowUnavailableText(unavailableReason)]
                        .filter(Boolean).join(' · ');
                const feedback = poolSelectionFeedback(
                    status ?? undefined,
                    poolGroup.serverId,
                    poolGroup.accountId,
                    pool.pool.id,
                );
                return {
                    id: `pool:${poolGroup.serverId}:${pool.pool.id}`,
                    testID: buildPoolOptionTestID(params.testIdPrefix, poolGroup.serverId, pool.pool.id),
                    label: pool.pool.name,
                    subtitle: feedback ?? [summary, identityDetail].filter(Boolean).join(' · '),
                    accessibilityLabel: [
                        accessibilityName,
                        feedback ?? summary,
                        params.groups.length > 1 ? poolGroup.serverName : null,
                    ].filter(Boolean).join('. '),
                    icon: <Icon name="desktop" size={iconSize} color={theme.colors.text.secondary} />,
                    loading: resolving,
                    disabled: unavailableReason !== null || resolving || !poolGroup.accountId,
                    onSelect: () => {
                        if (unavailableReason !== null) return;
                        if (!poolGroup.accountId) return;
                        selectPool({ serverId: poolGroup.serverId, accountId: poolGroup.accountId, pool });
                    },
                } satisfies SelectionListOption;
            });

            // Status rows explain why this exact Home currently contributes no Pool destinations.
            // They are deliberately ordinary disabled options: the shared destination-count owner
            // continues to count only actual Machines, Pools and Temporary computers.
            // A settled feature-off Home already returned above, so this only explains an error. A still-loading
            // answer adds no row: a section whose existence is unknown never heads the list (most Accounts have no
            // Pools, so it would vanish a moment later).
            const readFailedWithNoPools = poolGroup.pools.length === 0
                && (poolGroup.featureStatus === 'error' || poolGroup.status === 'error');
            if (hasOpenPoolSettings && status?.kind === 'unavailable' && status.reason === 'empty') {
                options.push({
                    id: `pool-settings:${poolGroup.serverId}`,
                    testID: buildPoolActionTestID(params.testIdPrefix, poolGroup.serverId, 'settings'),
                    label: t('machinePools.openSettings'),
                    icon: <Icon name="gear" size={iconSize} color={theme.colors.text.secondary} />,
                    onSelect: () => openPoolSettings({ serverId: poolGroup.serverId, poolId: status.poolId }),
                });
            }
            const refreshOwner = unavailableReason === 'homeFailed'
                ? (hasRefreshMachines ? 'machines' : null)
                : hasRefreshPools && (
                    readFailedWithNoPools
                    || unavailableReason === 'poolsFailed'
                    || status?.kind === 'error'
                    || (status?.kind === 'unavailable' && status.reason !== 'empty')
                )
                    ? 'pools'
                    : null;
            // One cause, one row: what failed in words, and Retry at the row's end; the whole row retries.
            const refreshFailed = readFailedWithNoPools || unavailableReason === 'poolsFailed' || unavailableReason === 'homeFailed';
            if (refreshOwner) {
                options.push({
                    id: `pool-refresh:${poolGroup.serverId}`,
                    testID: buildPoolActionTestID(params.testIdPrefix, poolGroup.serverId, 'refresh'),
                    label: refreshFailed ? t('machinePools.refreshFailed') : t('common.refresh'),
                    ...(refreshFailed ? {
                        accessibilityLabel: `${t('machinePools.refreshFailed')} ${t('common.retry')}`,
                        rightAccessory: <Text variant="label" style={{ color: theme.colors.text.primary }}>{t('common.retry')}</Text>,
                    } : {}),
                    icon: <Icon name={refreshFailed ? 'desktop' : 'arrow-clockwise'} size={iconSize} color={theme.colors.text.secondary} />,
                    onSelect: refreshOwner === 'machines'
                        ? refreshMachines
                        : () => refreshPools(poolGroup.serverId),
                });
            } else if (readFailedWithNoPools) {
                options.push({
                    id: `pool-status:${poolGroup.serverId}`,
                    testID: buildPoolActionTestID(params.testIdPrefix, poolGroup.serverId, 'status'),
                    label: t('machinePools.refreshFailed'),
                    accessibilityLabel: t('machinePools.refreshFailed'),
                    disabled: true,
                    icon: <Icon name="desktop" size={iconSize} color={theme.colors.text.secondary} />,
                });
            }
            if (hasDismissPoolSelection
                && status?.kind === 'unavailable'
                && status.reason === 'no_available_machine') {
                options.push({
                    id: `pool-pick-machine:${poolGroup.serverId}`,
                    testID: buildPoolActionTestID(params.testIdPrefix, poolGroup.serverId, 'pick-machine'),
                    label: t('machinePools.pickSpecificMachine'),
                    icon: <Icon name="desktop" size={iconSize} color={theme.colors.text.secondary} />,
                    onSelect: () => dismissPoolSelection(),
                });
            }
            return options;
        };
        const poolGroups = params.poolGroups ?? [];
        const hasPools = poolGroups.some((group) => group.pools.length > 0);
        const temporaryComputers = purpose === 'session' ? params.temporaryComputers ?? [] : [];
        const managedMachines = supportsManagedMachineSelection(purpose) ? params.managedMachines ?? [] : [];
        const managedOptionId = supportsManagedMachineSelection(purpose) && params.selectedManagedMachine
            ? managedMachineSelectionOptionId(params.selectedManagedMachine.selection)
            : null;
        // "Connect a computer…" closes the New machine group (lab m-pick): the other way to add a machine.
        const connectMachineOption: SelectionListOption | null = purpose === 'session' && hasConnectMachine
            ? {
                id: 'connect-machine',
                testID: params.testIdPrefix ? `${params.testIdPrefix}-connect-machine` : undefined,
                label: t('managedMachines.picker.connectComputer'),
                subtitle: t('managedMachines.picker.connectComputerHelp'),
                icon: <Icon name="plus" size={24} color={theme.colors.text.secondary} />,
                onSelect: connectMachine,
            }
            : null;
        const managedMachineSection: SelectionListSectionDescriptor | null = managedMachines.length > 0 || connectMachineOption
            ? {
                kind: 'static',
                id: 'managed-machines',
                title: t('newSession.managedMachine.title'),
                ...(hasOpenManagedPresets && managedMachines.length > 0 ? { action: {
                    label: t('machinePresets.short'), onPress: openManagedPresets,
                    testID: params.testIdPrefix ? `${params.testIdPrefix}-managed-presets` : undefined,
                } } : {}),
                options: [...managedMachines.map((offer) => ({
                    id: offer.id,
                    testID: params.testIdPrefix ? `${params.testIdPrefix}-${offer.id}` : undefined,
                    label: offer.title,
                    subtitle: offer.unavailableText ?? (purpose === 'finite'
                        ? [offer.subtitle, t('managedMachines.picker.createdOnRun')].filter(Boolean).join(' · ')
                        : offer.subtitle),
                    // A preset carries its provider's mark; "One-off machine…" reads as making a new one.
                    icon: offer.mark ?? <Icon name={offer.kind === 'one-off' ? 'plus-circle' : 'stack'} size={24} color={theme.colors.text.secondary} />,
                    disabled: offer.disabled === true || (offer.draft
                        ? !hasSelectManagedMachine
                        : !offer.onSelect),
                    onSelect: () => selectManagedMachine(offer.id),
                } satisfies SelectionListOption)), ...(connectMachineOption ? [connectMachineOption] : [])],
            }
            : null;
        const temporaryComputer = temporaryComputers.find((candidate) => candidate.selected) ?? null;
        const temporaryComputerRowKey = (candidate: TemporaryComputerSelection): string => (
            candidate.artifactTarget ?? 'unavailable'
        );
        const temporaryComputerOptionId = temporaryComputer?.disabled
            ? `temporary-computer:${temporaryComputer.serverId}:${temporaryComputerRowKey(temporaryComputer)}`
            : temporaryComputer?.workspace
            ? `temporary-computer-workspace:${temporaryComputer.serverId}:${temporaryComputerRowKey(temporaryComputer)}:${temporaryComputer.workspace.kind}`
            : null;
        const temporaryComputerExpirySection = (
            candidate: TemporaryComputerSelection & { artifactTarget: RunnerArtifactTarget },
        ): SelectionListSectionDescriptor => {
            const identity = temporaryComputerTargetIdentity(candidate.serverId, candidate.artifactTarget);
            const optionKey = temporaryComputerTargetOptionKey(candidate.serverId, candidate.artifactTarget);
            const pending = pendingExpiry?.identity === identity ? pendingExpiry : null;
            const current = pending ? pending.expiresAt : candidate.packageExpiresAt;
            const optionId = (suffix: string) => `temporary-computer-expiry:${optionKey}:${suffix}`;
            return {
                kind: 'static',
                id: 'expiry',
                title: t('newSession.temporaryComputer.expiry.title'),
                // The one rendered indicator of what is currently chosen. Options
                // carry no `selected` flag because `SelectionListOption` has none
                // and nothing reads one — a per-row marker there was never shown.
                resultHint: current === undefined
                    ? t('newSession.temporaryComputer.expiry.never')
                    : t('newSession.temporaryComputer.expiry.expiresAt', { date: new Date(current).toLocaleString() }),
                options: [{
                    id: optionId('never'),
                    label: t('newSession.temporaryComputer.expiry.never'),
                    subtitle: t('newSession.temporaryComputer.expiry.neverDetail'),
                    icon: <Icon name="infinity" size={24} color={theme.colors.text.secondary} />,
                    onSelect: () => setPendingExpiry({ identity, offset: null, expiresAt: undefined }),
                }, ...Object.entries(TEMPORARY_COMPUTER_EXPIRY_OFFSETS_MS).map(([offset, offsetMs]) => ({
                    id: optionId(offset),
                    label: t(`newSession.temporaryComputer.expiry.${offset}` as Parameters<typeof t>[0]),
                    icon: <Icon name="clock" size={24} color={theme.colors.text.secondary} />,
                    // Resolved to an absolute instant here, once, by the author.
                    // Nothing downstream counts anything down.
                    onSelect: () => setPendingExpiry({ identity, offset, expiresAt: Date.now() + offsetMs }),
                } satisfies SelectionListOption)), {
                    // The shortcuts are conveniences; this is the actual contract —
                    // an optional expiry the author states exactly, in their own
                    // local time, with no ceiling and nothing counting down.
                    id: optionId('custom'),
                    label: t('newSession.temporaryComputer.expiry.custom'),
                    subtitle: current !== undefined && pending?.offset == null
                        ? t('newSession.temporaryComputer.expiry.expiresAt', { date: new Date(current).toLocaleString() })
                        : undefined,
                    icon: <Icon name="calendar" size={24} color={theme.colors.text.secondary} />,
                    onSelect: () => {
                        void (async () => {
                            const chosen = await showTemporaryComputerExpiryModal({
                                nowMs: Date.now(),
                                ...(current !== undefined ? { currentExpiresAt: current } : {}),
                            });
                            // Backing out of the editor is not a change of mind
                            // about the expiry that was already chosen.
                            if (chosen === null) return;
                            setPendingExpiry({ identity, offset: null, expiresAt: chosen });
                        })();
                    },
                } satisfies SelectionListOption],
            };
        };
        const buildTemporaryComputerWorkspaceStep = (
            candidate: TemporaryComputerSelection & { artifactTarget: RunnerArtifactTarget },
        ): SelectionListStep => ({
            id: `temporary-computer-workspace:${temporaryComputerTargetOptionKey(candidate.serverId, candidate.artifactTarget)}`,
            title: t('newSession.temporaryComputer.workspace.title'),
            sections: [temporaryComputerExpirySection(candidate), {
                kind: 'static',
                id: 'workspace',
                // The folder belongs to the endpoint, not to the author: the
                // generic working-directory copy read as if the creator were
                // picking their own, on the one screen where the distinction
                // decides who chooses.
                title: t('newSession.temporaryComputer.workspace.title'),
                // Same contract as the expiry section above — one rendered
                // indicator of the committed answer, because `SelectionListOption`
                // carries no per-row selected flag.
                ...(candidate.workspace === null ? {} : {
                    resultHint: candidate.workspace.kind === 'endpoint_home'
                        ? t('newSession.temporaryComputer.target.workspaceHome')
                        : t('newSession.temporaryComputer.target.workspaceChoose'),
                }),
                options: [{
                    id: `temporary-computer-workspace:${candidate.serverId}:${candidate.artifactTarget}:choose_on_endpoint`,
                    label: t('newSession.temporaryComputer.target.workspaceChoose'),
                    subtitle: t('newSession.temporaryComputer.workspace.chooseRecommended'),
                    icon: <Icon name="folder" size={24} color={theme.colors.text.secondary} />,
                    onSelect: () => selectTemporaryComputer(
                        candidate.serverId,
                        candidate.artifactTarget,
                        { kind: 'choose_on_endpoint' },
                    ),
                }, {
                    id: `temporary-computer-workspace:${candidate.serverId}:${candidate.artifactTarget}:endpoint_home`,
                    label: t('newSession.temporaryComputer.target.workspaceHome'),
                    subtitle: t('newSession.temporaryComputer.workspace.homeDetail'),
                    icon: <Icon name="house" size={24} color={theme.colors.text.secondary} />,
                    onSelect: () => selectTemporaryComputer(
                        candidate.serverId,
                        candidate.artifactTarget,
                        { kind: 'endpoint_home' },
                    ),
                }],
            }],
        });
        const temporaryComputerOptions: SelectionListOption[] = temporaryComputers.map((candidate) => {
            const rowKey = temporaryComputerRowKey(candidate);
            const id = `temporary-computer:${candidate.serverId}:${rowKey}`;
            const artifactTarget = candidate.artifactTarget;
            const selectable = candidate.disabled !== true && artifactTarget !== null;
            return {
                id,
                testID: params.testIdPrefix
                    ? `${params.testIdPrefix}-temporary-computer:${candidate.serverId}:${rowKey}`
                    : undefined,
                // A platform row names the platform a person recognizes, never the
                // wire identifier: `darwin-arm64` is an artifact target, not a
                // destination anybody asked for.
                label: temporaryComputers.length === 1 || candidate.artifactTarget === null
                    ? t('newSession.temporaryComputer.title')
                    : describeRunnerArtifactTarget(candidate.artifactTarget),
                // An explained row keeps its explanation as the subtitle: the
                // reason a destination cannot be used is the most useful thing
                // the row can say, whether the block is eligibility or readiness.
                subtitle: candidate.unavailableText
                    ?? (temporaryComputers.length === 1
                        ? t('newSession.temporaryComputer.subtitle')
                        : t('newSession.temporaryComputer.platformSubtitle')),
                accessibilityLabel: artifactTarget
                    ? `${t('newSession.temporaryComputer.title')}. ${describeRunnerArtifactTarget(artifactTarget)}`
                    : t('newSession.temporaryComputer.title'),
                icon: <Icon name="desktop" size={24} color={theme.colors.text.secondary} />,
                disabled: !selectable,
                ...(selectable && artifactTarget !== null
                    ? { openStep: buildTemporaryComputerWorkspaceStep({ ...candidate, artifactTarget }) }
                    : {}),
            } satisfies SelectionListOption;
        });
        // The retry belongs to whichever row is currently unusable, not only to a
        // row the draft already selected: an unavailable destination the user has
        // never chosen still needs a way back.
        const temporaryComputerRetrySource = temporaryComputers.find((candidate) => (
            candidate.disabled === true && candidate.onRetry !== undefined
        )) ?? null;
        // One failure, one row: the failed row says why, and Retry is the section's action (as Presets
        // is New machine's) rather than a second option row (DRA D13).
        const temporaryComputerRetry = temporaryComputerRetrySource?.onRetry
            ? {
                label: t('common.retry'),
                onPress: temporaryComputerRetrySource.onRetry,
                ...(params.testIdPrefix
                    ? { testID: `${params.testIdPrefix}-temporary-computer-retry:${temporaryComputerRetrySource.serverId}` }
                    : {}),
            }
            : null;
        const temporaryComputerSection: SelectionListSectionDescriptor | null = temporaryComputers.length > 0
            ? {
                kind: 'static',
                id: 'temporary-computer',
                title: t('newSession.temporaryComputer.publishedTitle'),
                ...(temporaryComputerRetry ? { action: temporaryComputerRetry } : {}),
                options: temporaryComputers.length === 1
                    ? temporaryComputerOptions
                    : [{
                        id: 'temporary-computer',
                        label: t('newSession.temporaryComputer.publishedTitle'),
                        subtitle: t('newSession.temporaryComputer.subtitle'),
                        icon: <Icon name="desktop" size={24} color={theme.colors.text.secondary} />,
                        openStep: {
                            id: 'temporary-computer-platform',
                            title: t('newSession.temporaryComputer.choosePlatform'),
                            sections: [{ kind: 'static', id: 'platforms', options: temporaryComputerOptions }],
                        },
                    }],
            }
            : null;
        if (params.groups.length === 0 && !hasPools) {
            return {
                selectedOptionId: managedOptionId ?? (temporaryComputer?.selected ? temporaryComputerOptionId : null),
                rootStep: {
                    id: 'machine-root',
                    inputPlaceholder,
                    emptyStateLabel: params.emptyStateLabel ?? t('newSession.noMachinesFound'),
                    sections: [managedMachineSection, temporaryComputerSection].filter(
                        (section) => section !== null,
                    ),
                },
            };
        }

        if (params.groups.length === 1 && !params.groups[0]!.loading && !params.groups[0]!.signedOut) {
            const group = params.groups[0]!;
            const machineNames = resolveMachineDisplayNames(group.machines);
            const bucketModel = buildMachineSelectionBuckets<TMachine>({
                scope: scopeForServer(group.serverId),
                machines: group.machines,
                recentMachines: params.recentMachines,
                favoriteMachines: params.favoriteMachines,
                showFavorites: params.showFavorites,
                showRecent: params.showRecent,
                disableOfflineMachines: params.disableOfflineMachines ?? true,
                favoriteGroupPlacement: params.favoriteGroupPlacement,
                includeSelectedUnavailableMachineId: params.includeSelectedUnavailableMachineId,
            });

            const sections: SelectionListSectionDescriptor[] = bucketModel.buckets.map((bucket) => ({
                kind: 'static',
                id: bucket.key ?? bucket.id,
                title: bucket.id === 'shared'
                    ? describeMachineSharedGroupTitle(bucket.custodian)
                    : params.sectionTitles?.[bucket.id] ?? bucketTitle(bucket.id),
                options: bucket.machines.map((machine) => {
                    const availability = resolveRowAvailability(machine, group.serverId, params.resolveMachineAvailability, purpose, resolveMachinePlacementFacts, params.workerSubject, scopeForServer(group.serverId));
                    const presentation = params.resolveMachinePresentation?.(machine);
                    return {
                        id: machine.id,
                        testID: buildOptionTestID(params.testIdPrefix, machine),
                        label: presentation?.title ?? machineNames.get(machine.id) ?? machine.id,
                        labelEllipsizeMode: 'middle',
                        subtitle: machineStatusLine(machine, scopeForServer(group.serverId), availability.reason ?? presentation?.subtitle,
                            machinesByEnrolledMachineIdByServerId[group.serverId]?.[machine.id]),
                        subtitleLeading: (
                            <MachinePresenceDot
                                machine={machine}
                                serverId={group.serverId}
                                readinessTestID={buildReadinessTestID(params.testIdPrefix, machine)}
                            />
                        ),
                        icon: (
                            <MachineRowMark
                                machineId={machine.id}
                                serverId={group.serverId}
                                managedMachine={machinesByEnrolledMachineIdByServerId[group.serverId]?.[machine.id]}
                                size={24}
                            />
                        ),
                        disabled: !availability.selectable,
                        rightAccessory: (
                            <MachineSelectionRowAccessory
                                machine={machine}
                                serverId={params.serverId}
                                showCliGlyphs={params.showCliGlyphs}
                                autoDetectCliGlyphs={params.autoDetectCliGlyphs}
                                showFavoriteToggle={params.showFavorites}
                                isFavorite={bucketModel.favoriteMachineIdSet.has(machine.id)}
                                onToggleFavorite={favoriteToggle}
                            />
                        ),
                        onSelect: () => {
                            if (!resolveRowAvailability(machine, group.serverId, params.resolveMachineAvailability, purpose, resolveMachinePlacementFacts, params.workerSubject, scopeForServer(group.serverId)).selectable) return;
                            selectMachine(machine);
                        },
                    } satisfies SelectionListOption;
                }),
            }));
            const poolGroup = poolGroups.find((candidate) => candidate.serverId === group.serverId);
            const poolOptions = poolGroup ? buildPoolSectionOptions(poolGroup, group, 24) : [];
            if (poolOptions.length > 0) {
                sections.unshift({
                    kind: 'static',
                    id: 'machine-pools',
                    title: t('machinePools.title'),
                    options: poolOptions,
                });
            }
            // Machines that exist come first; machines that don't exist yet follow: New machine
            // (presets, a one-off, connecting one), then a Temporary computer (lab m-pick).
            if (managedMachineSection) sections.push(managedMachineSection);
            if (temporaryComputerSection) sections.push(temporaryComputerSection);

            return {
                selectedOptionId: managedOptionId ?? (temporaryComputer?.selected
                    ? temporaryComputerOptionId
                    : params.selectedMachine?.id ?? null),
                rootStep: {
                    id: 'machine-root',
                    inputPlaceholder,
                    emptyStateLabel: params.emptyStateLabel ?? t('newSession.noMachinesFound'),
                    sections,
                },
            };
        }

        const sections: SelectionListSectionDescriptor[] = params.groups.flatMap((group) => {
            let options: SelectionListOption[];
            if (group.loading) {
                options = [{
                    id: `server:${group.serverId}:loading`,
                    label: t('common.loading'),
                    disabled: true,
                }];
            } else if (group.signedOut) {
                options = [{
                    id: `server:${group.serverId}:signed-out`,
                    label: t('server.signedOut'),
                    disabled: true,
                }];
            } else if (group.machines.length === 0) {
                options = [{
                    id: `server:${group.serverId}:empty`,
                    label: t('newSession.noMachinesFound'),
                    disabled: true,
                }];
            } else {
                const machineNames = resolveMachineDisplayNames(group.machines);
                options = group.machines.map((machine) => {
                    const availability = resolveRowAvailability(machine, group.serverId, params.resolveMachineAvailability, purpose, resolveMachinePlacementFacts, params.workerSubject, scopeForServer(group.serverId));
                    const presentation = params.resolveMachinePresentation?.(machine);
                    return {
                        id: `${group.serverId}::${machine.id}`,
                        testID: buildOptionTestID(params.testIdPrefix, machine),
                        label: presentation?.title ?? machineNames.get(machine.id) ?? machine.id,
                        labelEllipsizeMode: 'middle',
                        subtitle: machineStatusLine(
                            machine,
                            scopeForServer(group.serverId),
                            availability.reason ?? (presentation ? presentation.subtitle : machineSubtitle(machine)),
                            machinesByEnrolledMachineIdByServerId[group.serverId]?.[machine.id],
                        ),
                        subtitleLeading: (
                            <MachinePresenceDot
                                machine={machine}
                                serverId={group.serverId}
                                readinessTestID={buildReadinessTestID(params.testIdPrefix, machine)}
                            />
                        ),
                        icon: (
                            <MachineRowMark
                                machineId={machine.id}
                                serverId={group.serverId}
                                managedMachine={machinesByEnrolledMachineIdByServerId[group.serverId]?.[machine.id]}
                                size={20}
                            />
                        ),
                        disabled: !availability.selectable,
                        onSelect: () => {
                            if (!resolveRowAvailability(machine, group.serverId, params.resolveMachineAvailability, purpose, resolveMachinePlacementFacts, params.workerSubject, scopeForServer(group.serverId)).selectable) return;
                            selectScopedMachine(machine);
                        },
                    } satisfies SelectionListOption;
                });
            }

            const machineSection: SelectionListSectionDescriptor = {
                kind: 'static',
                id: `server:${group.serverId}`,
                title: group.serverName,
                count: group.machines.length,
                options,
            };
            const ownershipGroups = !group.loading && !group.signedOut && group.machines.length > 0
                ? buildMachineOwnershipGroups(group.machines)
                : [];
            const optionsById = new Map(options.map((option) => [option.id, option]));
            const machineSections: SelectionListSectionDescriptor[] = ownershipGroups.some((ownership) => ownership.key.startsWith('shared:'))
                ? ownershipGroups.map((ownership) => ({
                    kind: 'static',
                    id: `server:${group.serverId}:${ownership.key}`,
                    title: `${group.serverName} · ${ownership.key.startsWith('shared:')
                        ? describeMachineSharedGroupTitle(ownership.custodian)
                        : t('machines.destinations.yours')}`,
                    count: ownership.machines.length,
                    options: ownership.machines.flatMap((machine) => {
                        const option = optionsById.get(`${group.serverId}::${machine.id}`);
                        return option ? [option] : [];
                    }),
                }))
                : [machineSection];
            const poolGroup = poolGroups.find((candidate) => candidate.serverId === group.serverId);
            if (!poolGroup) return machineSections;
            const poolOptions = buildPoolSectionOptions(poolGroup, group, 20);
            if (poolOptions.length === 0) return machineSections;
            const poolSection: SelectionListSectionDescriptor = {
                kind: 'static',
                id: `server:${group.serverId}:machine-pools`,
                title: `${group.serverName} · ${t('machinePools.title')}`,
                count: poolGroup.pools.length,
                options: poolOptions,
            };
            return [poolSection, ...machineSections];
        });
        if (managedMachineSection) sections.push(managedMachineSection);
        if (temporaryComputerSection) sections.push(temporaryComputerSection);

        const selectedOptionId = managedOptionId ?? (temporaryComputer?.selected
            ? temporaryComputerOptionId
            : params.selectedServerId && params.selectedMachine
                ? `${params.selectedServerId}::${params.selectedMachine.id}`
                : null);

        return {
            selectedOptionId,
            rootStep: {
                id: 'machine-root',
                inputPlaceholder,
                emptyStateLabel: params.emptyStateLabel ?? t('newSession.noMachinesFound'),
                sections,
            },
        };
    }, [
        params.autoDetectCliGlyphs,
        presenceKey,
        purpose,
        resolveMachinePlacementFacts,
        params.workerSubject?.scriptName,
        params.workerSubject?.memoryDemandBytes,
        params.favoriteGroupPlacement,
        params.favoriteMachines,
        params.groups,
        params.poolGroups,
        params.poolSelectionStatus,
        favoriteToggle,
        hasDismissPoolSelection,
        hasOpenPoolSettings,
        hasRefreshMachines,
        hasRefreshPools,
        dismissPoolSelection,
        openPoolSettings,
        refreshMachines,
        refreshPools,
        selectMachine,
        selectScopedMachine,
        selectPool,
        selectManagedMachine,
        openManagedPresets,
        connectMachine,
        hasConnectMachine,
        selectTemporaryComputer,
        params.recentMachines,
        params.resolveMachineAvailability,
        params.resolveMachinePresentation,
        params.selectedMachine,
        params.selectedServerId,
        params.serverId,
        params.showCliGlyphs,
        params.showFavorites,
        params.showRecent,
        params.showSearch,
        params.testIdPrefix,
        params.disableOfflineMachines,
        params.includeSelectedUnavailableMachineId,
        params.searchPlaceholder,
        params.emptyStateLabel,
        params.sectionTitles,
        params.temporaryComputers,
        params.managedMachines,
        machinesByEnrolledMachineIdByServerId,
        params.selectedManagedMachine,
        hasSelectManagedMachine,
        hasOpenManagedPresets,
        pendingExpiry,
        theme.colors.text.secondary,
        scopeForServer,
        language,
    ]);
    const managedWakeByServerId = React.useMemo(() => Object.fromEntries(params.groups.map(group => [group.serverId,
        Object.fromEntries(group.machines.flatMap(machine => {
            const eligibility = resolveMachineDestinationPurposeEligibility(purpose, resolveMachinePlacementFacts?.(machine, group.serverId), machine, scopeForServer(group.serverId));
            return eligibility.eligible && eligibility.managedWake ? [[machine.id, eligibility.managedWake]] : [];
        })),
    ])), [params.groups, purpose, resolveMachinePlacementFacts, presenceKey, scopeForServer]);
    const offlineOnlyMachineIdsByServerId = React.useMemo(() => Object.fromEntries(params.groups.map(group => [group.serverId,
        group.machines.filter(machine => isBlockedOnlyByPresence(
            resolveMachineDestinationPurposeEligibility(purpose, resolveMachinePlacementFacts?.(machine, group.serverId), machine, scopeForServer(group.serverId)),
            resolveMachinePickerPresence(machine, undefined, scopeForServer(group.serverId)),
        )).map(machine => machine.id),
    ])),
    // Request reachability changes presence without any Machine row change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [params.groups, purpose, resolveMachinePlacementFacts, presenceKey, scopeForServer]);
    return { ...model, managedWakeByServerId, offlineOnlyMachineIdsByServerId };
}
