import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import type {
    SelectionListOption,
    SelectionListSectionDescriptor,
    SelectionListStep,
} from '@/components/ui/selectionList';
import { t } from '@/text';
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
import { MachinePresenceDot, MachineSelectionRowAccessory } from './MachineSelectionRowAccessory';
import { describeMachinePresenceLine } from '@/utils/sessions/machinePresenceLine';
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
import { Icon, type IconName } from '@/components/ui/icons/Icon';
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
import { resolveMachineDisplayNames } from '@/utils/sessions/machineDisplayNames';
import {
    managedMachineSelectionOptionId,
    type ManagedMachineSelectionDraft,
    type ManagedMachineSelectionOffer,
} from './managedMachineSelection';

type MachineSelectionListModel = Readonly<{
    rootStep: SelectionListStep;
    selectedOptionId: string | null;
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
    title: string;
    subtitle?: string;
}>;

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
    /** Domain-owned row naming, for domains that must not disclose opaque machine ids. */
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
function machineStatusLine(machine: MachineDisplayRenderable, detail: string | undefined): string {
    return [describeMachinePresenceLine(machine).label, describeMachineSharedOwnership(machine), detail].filter(Boolean).join(' · ');
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
        case 'presence_unavailable': return t('machinePools.resolvePresenceUnavailable');
    }
}

function bucketTitle(bucketId: MachineSelectionBucketId): string {
    switch (bucketId) {
        case 'recent':
            return t('newSession.machinePicker.recentTitle');
        case 'favorites':
            return t('newSession.machinePicker.favoritesTitle');
        case 'all':
            return t('newSession.machinePicker.allTitle');
        case 'shared':
            return describeMachineSharedGroupTitle(undefined);
    }
}

function bucketIconName(bucketId: MachineSelectionBucketId): IconName {
    return bucketId === 'recent' ? 'clock' : 'desktop';
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
    workerSubject?: MachineDestinationWorkerSubject,
): Readonly<{ selectable: boolean; reason?: string }> {
    const eligibility = resolveMachineDestinationPurposeEligibility(purpose, resolveMachinePlacementFacts?.(machine, serverId), machine);
    if (!eligibility.eligible) return { selectable: false, reason: describeMachineDestinationEligibility(eligibility, machine, workerSubject, purpose) };
    const presence = resolveMachinePickerPresence(machine);
    const decided = resolveMachineAvailability?.(machine, serverId);
    // An eligible worker row says its current load (or that it is unknown), never a guessed zero.
    if (!decided) return { selectable: presence.selectable, reason: describeMachineDestinationWorkerFacts(eligibility, workerSubject, purpose) };
    return {
        selectable: decided.selectable,
        reason: !decided.selectable || !presence.selectable ? decided.detail : undefined,
    };
}

export function useMachineSelectionListModel<TMachine extends MachineDisplayRenderable = Machine>(
    params: BuildMachineSelectionListModelParams<TMachine>,
): MachineSelectionListModel {
    const purpose = params.purpose ?? 'session';
    const demandedWorkerFacts = useMachineDestinationWorkerStatus({ purpose, workerPlacement: params.workerPlacement, groups: params.groups });
    const resolveMachinePlacementFacts = params.workerPlacement && (purpose === 'finite' || purpose === 'service-start')
        ? demandedWorkerFacts : params.resolveMachinePlacementFacts;
    const { theme } = useUnistyles();

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
    const selectManagedMachine = React.useCallback((offerId: string) => {
        if (handlersRef.current.purpose !== 'session') return;
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

    return React.useMemo(() => {
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
            if (poolGroup.pools.length === 0) {
                // A settled feature-off Home already returned above, so this row only
                // ever explains an error or a still-loading projection.
                const statusLabel = poolGroup.featureStatus === 'error' || poolGroup.status === 'error'
                    ? t('machinePools.refreshFailed')
                    : poolGroup.featureStatus === 'loading'
                        || poolGroup.status === 'loading'
                        || poolGroup.projectionReady === false
                        ? t('common.loading')
                        : null;
                if (statusLabel) {
                    options.push({
                        id: `pool-status:${poolGroup.serverId}`,
                        testID: buildPoolActionTestID(params.testIdPrefix, poolGroup.serverId, 'status'),
                        label: statusLabel,
                        accessibilityLabel: statusLabel,
                        disabled: true,
                        icon: <Icon name="desktop" size={iconSize} color={theme.colors.text.secondary} />,
                    });
                }
            }

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
                    unavailableReason === 'poolsFailed'
                    || status?.kind === 'error'
                    || (status?.kind === 'unavailable' && status.reason !== 'empty')
                )
                    ? 'pools'
                    : null;
            if (refreshOwner) {
                options.push({
                    id: `pool-refresh:${poolGroup.serverId}`,
                    testID: buildPoolActionTestID(params.testIdPrefix, poolGroup.serverId, 'refresh'),
                    label: unavailableReason === 'poolsFailed' || unavailableReason === 'homeFailed'
                        ? t('common.retry')
                        : t('common.refresh'),
                    subtitle: unavailableReason === 'poolsFailed'
                        ? t('machinePools.refreshFailed')
                        : unavailableReason === 'homeFailed'
                            ? t('common.error')
                            : undefined,
                    icon: <Icon name="arrow-clockwise" size={iconSize} color={theme.colors.text.secondary} />,
                    onSelect: refreshOwner === 'machines'
                        ? refreshMachines
                        : () => refreshPools(poolGroup.serverId),
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
        const managedMachines = purpose === 'session' ? params.managedMachines ?? [] : [];
        const managedOptionId = purpose === 'session' && params.selectedManagedMachine
            ? managedMachineSelectionOptionId(params.selectedManagedMachine.selection)
            : null;
        const managedMachineSection: SelectionListSectionDescriptor | null = managedMachines.length > 0
            ? {
                kind: 'static',
                id: 'managed-machines',
                title: t('newSession.managedMachine.title'),
                ...(hasOpenManagedPresets ? { action: {
                    label: t('machinePresets.short'), onPress: openManagedPresets,
                    testID: params.testIdPrefix ? `${params.testIdPrefix}-managed-presets` : undefined,
                } } : {}),
                options: managedMachines.map((offer) => ({
                    id: offer.id,
                    testID: params.testIdPrefix ? `${params.testIdPrefix}-${offer.id}` : undefined,
                    label: offer.title,
                    subtitle: offer.unavailableText ?? offer.subtitle,
                    // A preset reads as a saved recipe; "One-off machine…" as making a new one.
                    icon: <Icon name={offer.kind === 'one-off' ? 'plus' : 'stack'} size={24} color={theme.colors.text.secondary} />,
                    disabled: offer.disabled === true || (offer.draft
                        ? !hasSelectManagedMachine
                        : !offer.onSelect),
                    onSelect: () => selectManagedMachine(offer.id),
                } satisfies SelectionListOption)),
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
        const temporaryComputerRetry = temporaryComputerRetrySource?.onRetry
            ? {
                id: `temporary-computer-retry:${temporaryComputerRetrySource.serverId}`,
                label: t('common.retry'),
                icon: <Icon name="arrow-clockwise" size={24} color={theme.colors.text.secondary} />,
                onSelect: temporaryComputerRetrySource.onRetry,
            } satisfies SelectionListOption
            : null;
        const temporaryComputerSection: SelectionListSectionDescriptor | null = temporaryComputers.length > 0
            ? {
                kind: 'static',
                id: 'temporary-computer',
                title: t('newSession.temporaryComputer.publishedTitle'),
                options: temporaryComputers.length === 1
                    ? [...temporaryComputerOptions, ...(temporaryComputerRetry ? [temporaryComputerRetry] : [])]
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
                    sections: [temporaryComputerSection, managedMachineSection].filter(
                        (section): section is SelectionListSectionDescriptor => section !== null,
                    ),
                },
            };
        }

        if (params.groups.length === 1 && !params.groups[0]!.loading && !params.groups[0]!.signedOut) {
            const group = params.groups[0]!;
            const machineNames = resolveMachineDisplayNames(group.machines);
            const bucketModel = buildMachineSelectionBuckets<TMachine>({
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
                    const availability = resolveRowAvailability(machine, group.serverId, params.resolveMachineAvailability, purpose, resolveMachinePlacementFacts, params.workerSubject);
                    const presentation = params.resolveMachinePresentation?.(machine);
                    return {
                        id: machine.id,
                        testID: buildOptionTestID(params.testIdPrefix, machine),
                        label: presentation?.title ?? machineNames.get(machine.id) ?? machine.id,
                        subtitle: machineStatusLine(machine, availability.reason ?? presentation?.subtitle),
                        subtitleLeading: (
                            <MachinePresenceDot
                                machine={machine}
                                readinessTestID={buildReadinessTestID(params.testIdPrefix, machine)}
                            />
                        ),
                        icon: (
                            <Icon
                                name={bucketIconName(bucket.id)}
                                size={24}
                                color={theme.colors.text.secondary}
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
                            if (!resolveRowAvailability(machine, group.serverId, params.resolveMachineAvailability, purpose, resolveMachinePlacementFacts, params.workerSubject).selectable) return;
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
            if (temporaryComputerSection) sections.unshift(temporaryComputerSection);
            if (managedMachineSection) sections.push(managedMachineSection);

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
                    const availability = resolveRowAvailability(machine, group.serverId, params.resolveMachineAvailability, purpose, resolveMachinePlacementFacts, params.workerSubject);
                    const presentation = params.resolveMachinePresentation?.(machine);
                    return {
                        id: `${group.serverId}::${machine.id}`,
                        testID: buildOptionTestID(params.testIdPrefix, machine),
                        label: presentation?.title ?? machineNames.get(machine.id) ?? machine.id,
                        subtitle: machineStatusLine(
                            machine,
                            availability.reason ?? (presentation ? presentation.subtitle : machineSubtitle(machine)),
                        ),
                        subtitleLeading: (
                            <MachinePresenceDot
                                machine={machine}
                                readinessTestID={buildReadinessTestID(params.testIdPrefix, machine)}
                            />
                        ),
                        icon: (
                            <Icon
                                name="desktop"
                                size={20}
                                color={theme.colors.text.secondary}
                            />
                        ),
                        disabled: !availability.selectable,
                        onSelect: () => {
                            if (!resolveRowAvailability(machine, group.serverId, params.resolveMachineAvailability, purpose, resolveMachinePlacementFacts, params.workerSubject).selectable) return;
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
        if (temporaryComputerSection) sections.unshift(temporaryComputerSection);
        if (managedMachineSection) sections.push(managedMachineSection);

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
        params.selectedManagedMachine,
        hasSelectManagedMachine,
        hasOpenManagedPresets,
        pendingExpiry,
        theme.colors.text.secondary,
    ]);
}
