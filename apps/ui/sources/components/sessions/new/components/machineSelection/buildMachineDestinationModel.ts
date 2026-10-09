import type { MachinePoolViewV1, ProjectWorkerStatusResultV1 } from '@happier-dev/protocol';
import type { MachineDestinationPurposeV1 } from '@happier-dev/protocol/machines/pools';

import type { Machine } from '@/sync/domains/state/storageTypes';
import type { MachineDisplayRenderable } from '@/sync/domains/machines/machineDisplayRenderable';
import type { MachinePoolListStatus } from '@/sync/store/domains/machinePools';
import type { MachinePoolFeatureStatus } from '@/sync/engine/machines/useMachinePoolProjections';
import type { TemporaryComputerDestinationProjectionState } from '@/components/sessions/new/hooks/useTemporaryComputerAvailability';

import {
    buildMachineSelectionBuckets,
    type MachineSelectionFavoriteGroupPlacement,
} from './buildMachineSelectionBuckets';
import { resolveMachinePickerPresence } from '../resolveMachinePickerPresence';
import { t } from '@/text';
import { describeMachineLockedReason } from '@/utils/sessions/machineDisplayNames';
import { formatByteSize } from '@/utils/files/formatByteSize';
import type { ManagedMachineDestinationProjection } from './managedMachineSelection';

/** Current admitted projection facts, supplied on demand; never inferred from CPU or Session count. */
export type MachineDestinationPlacementFacts = Readonly<{
    ownership: 'owned' | 'shared';
    worker?: ProjectWorkerStatusResultV1;
    /** The demanded status read failed; still not eligibility, but no longer "checking". */
    workerStatusFailed?: boolean;
}>;

/** Purpose admission is shared by shortcut, list and dropdown; a presentation override cannot widen it. */
export function resolveMachineDestinationPurposeEligibility(
    purpose: MachineDestinationPurposeV1,
    facts?: MachineDestinationPlacementFacts,
    machine?: MachineDisplayRenderable,
): Readonly<{ eligible: true; worker?: Extract<ProjectWorkerStatusResultV1, { eligible: true }> }>
    | Readonly<{ eligible: false; reason: 'shared_unsupported' | 'access_unavailable' | 'content_unavailable' | 'machine_unavailable' | 'worker_status_unavailable' | 'worker_refused'; worker?: ProjectWorkerStatusResultV1; statusFailed?: true }> {
    const shared = machine?.isShared === true || facts?.ownership === 'shared';
    if (shared && (
        purpose === 'workflow' || purpose === 'trigger' || purpose === 'background' || purpose === 'boards'
    )) return { eligible: false, reason: 'shared_unsupported' };
    // Boards retain owned unreadable items; they do not dispatch work or disclose locked content.
    if (purpose !== 'boards' && machine?.availability?.kind === 'locked') {
        return { eligible: false, reason: 'content_unavailable' };
    }
    if (machine?.isShared === true && machine.access?.accessState !== 'ready') {
        return { eligible: false, reason: 'access_unavailable' };
    }
    if (shared && machine?.metadata === null) return { eligible: false, reason: 'content_unavailable' };
    if (shared && machine && !resolveMachinePickerPresence(machine).selectable) return { eligible: false, reason: 'machine_unavailable' };
    if (purpose === 'finite' || purpose === 'service-start') {
        if (!facts?.worker) return { eligible: false, reason: 'worker_status_unavailable', ...(facts?.workerStatusFailed ? { statusFailed: true as const } : {}) };
        if (!facts.worker.eligible) return { eligible: false, reason: 'worker_refused', worker: facts.worker };
        return { eligible: true, worker: facts.worker };
    }
    return { eligible: true };
}

/** What a Project-work row is about: the script (or service) and its reviewed memory need, when declared. */
export type MachineDestinationWorkerSubject = Readonly<{ scriptName?: string; memoryDemandBytes?: number }>;

/**
 * The exact current worker fact for a finite/service-start row (30 §2): known load, unknown load
 * (never zero), a pending or failed status read, or the target's named refusal. Undefined when the
 * row's eligibility carries no worker fact. Counts come only from the status producer.
 */
export function describeMachineDestinationWorkerFacts(
    eligibility: ReturnType<typeof resolveMachineDestinationPurposeEligibility>,
    subject?: MachineDestinationWorkerSubject,
    purpose: MachineDestinationPurposeV1 = 'finite',
): string | undefined {
    if (!eligibility.eligible && eligibility.reason === 'worker_status_unavailable') {
        return eligibility.statusFailed ? t('projectWorkers.statusUnavailable') : t('projectWorkers.loading');
    }
    const worker = eligibility.worker;
    if (!worker) return undefined;
    if (worker.eligible) {
        if (worker.load.kind === 'unknown') return t('projectWorkers.loadUnknown');
        const { running, queued, runAtMost } = worker.load;
        if (running === 0 && queued === 0) return t('projectWorkers.free');
        // Only a finite run waits for "Run at most"; a service start holds no finite slot (31/32).
        const full = purpose === 'finite' && runAtMost !== null && running >= runAtMost;
        return [
            t('projectWorkers.runningCount', { count: running }),
            queued > 0 ? t('projectWorkers.queuedCount', { count: queued }) : null,
            full ? t('projectWorkers.waitsThere') : null,
        ].filter(Boolean).join(' · ');
    }
    switch (worker.explanation) {
        case 'not_accepting': return t('projectWorkers.notAccepting');
        case 'draining': return t('projectWorkers.draining');
        case 'policy_unavailable': return t('projectWorkers.policyUnavailable');
        case 'forbidden': return t('projectWorkers.accessRefused');
        case 'workspace_unavailable': return t('projectWorkers.workspaceUnavailable');
        case 'unsupported':
        case 'capability_unknown': return t('projectWorkers.unsupported');
        case 'memory_unavailable': return t('projectWorkers.memoryUnavailable');
        case 'memory_insufficient':
            return subject?.scriptName && subject.memoryDemandBytes !== undefined
                ? t('projectWorkers.tooSmall', { script: subject.scriptName, need: formatByteSize(subject.memoryDemandBytes),
                    ...(worker.observedMemory ? { available: formatByteSize(worker.observedMemory.totalBytes) } : {}) })
                : t('projectWorkers.tooSmallGeneric');
        case 'unavailable': return t('projectWorkers.statusUnavailable');
    }
}

/** The same explanatory reason is used by list and dropdown presentations. */
export function describeMachineDestinationEligibility(
    eligibility: ReturnType<typeof resolveMachineDestinationPurposeEligibility>,
    machine: Readonly<Pick<MachineDisplayRenderable, 'access' | 'availability' | 'metadata'>>,
    subject?: MachineDestinationWorkerSubject,
    purpose?: MachineDestinationPurposeV1,
): string | undefined {
    if (eligibility.eligible) return undefined;
    if (eligibility.reason === 'shared_unsupported') return t('machines.destinations.sharedPurposeUnsupported');
    if (eligibility.reason === 'worker_status_unavailable' || eligibility.reason === 'worker_refused') {
        return describeMachineDestinationWorkerFacts(eligibility, subject, purpose);
    }
    if (machine.access?.accessState === 'key_pending') return t('machines.destinations.pendingKey');
    return describeMachineLockedReason(machine) ?? t('common.unavailable');
}

/**
 * The Home-currentness facts a Pool group carries from the canonical projection owner. They are
 * structural on purpose: the presentation host and this destination owner must read the same values
 * rather than each re-deriving Pool currentness from rows or a failed resolve.
 */
type MachinePoolGroupCurrentness = Readonly<{
    serverId: string;
    pools: ReadonlyArray<MachinePoolViewV1>;
    featureStatus?: MachinePoolFeatureStatus;
    status?: MachinePoolListStatus;
    projectionReady?: boolean;
}>;

type MachineGroupCurrentness = Readonly<{
    loading: boolean;
    signedOut: boolean;
    error?: boolean;
}>;

/**
 * The minimum a Home group must expose to be counted. Structural on purpose so route, Simple and
 * Wizard hosts can feed their existing group shapes without casting.
 */
type DestinationHomeGroup = MachineGroupCurrentness & Readonly<{
    serverId: string;
    machines: ReadonlyArray<Machine>;
}>;

/**
 * Why a visible Pool row cannot be activated right now.
 *
 * Every reason is a Home-currentness fact. A cached zero-connected summary is deliberately absent:
 * only the authoritative resolve can learn that a member reconnected without any `machinePool`
 * mutation, so a stale count must never become permanent admission denial.
 */
export type MachinePoolRowUnavailableReason =
    | 'homeLoading'
    | 'homeSignedOut'
    | 'homeFailed'
    | 'poolsLoading'
    | 'poolsSignedOut'
    | 'poolsFailed';

/** The one rule for whether a rendered Pool row may invoke the read-only resolve. `null` = it may. */
export function resolveMachinePoolRowUnavailableReason(params: Readonly<{
    group?: MachineGroupCurrentness | null;
    poolGroup: MachinePoolGroupCurrentness;
}>): MachinePoolRowUnavailableReason | null {
    if (params.group?.signedOut) return 'homeSignedOut';
    if (params.group?.error) return 'homeFailed';
    if (params.group?.loading) return 'homeLoading';
    switch (params.poolGroup.status) {
        case 'signedOut': return 'poolsSignedOut';
        case 'error': return 'poolsFailed';
        case 'loading': return 'poolsLoading';
        default: break;
    }
    if (params.poolGroup.projectionReady === false) return 'poolsLoading';
    return null;
}

export type MachineDestinationModel = Readonly<{
    /** Every destination row the picker renders, including published artifacts and managed recipes. */
    destinationRowCount: number;
    machineRowCount: number;
    poolRowCount: number;
    temporaryComputerRowCount: number;
    managedMachineRowCount: number;
    /**
     * Every scoped Home settled its Machine list and Pool answer, and artifact/recipe
     * availability is known. Until then the rendered choice set is incomplete and no automatic
     * single-destination shortcut may be taken.
     */
    destinationSetSettled: boolean;
    /**
     * The only destination a user could pick, and only when the complete choice set holds exactly
     * one admissible row. `null` whenever the set is unsettled, larger, or not selectable.
     */
    soleSelectableDestination: Readonly<{ serverId: string; machine: Machine }> | null;
}>;

export type BuildMachineDestinationModelParams = Readonly<{
    purpose?: MachineDestinationPurposeV1;
    /** Optional current worker facts; ownership also comes from the admitted Machine projection. */
    resolveMachinePlacementFacts?: (machine: Machine, serverId: string) => MachineDestinationPlacementFacts;
    groups: ReadonlyArray<DestinationHomeGroup>;
    poolGroups?: ReadonlyArray<MachinePoolGroupCurrentness>;
    temporaryComputerProjection?: Readonly<{
        state: TemporaryComputerDestinationProjectionState;
        rowCount: number;
    }>;
    managedMachineProjection?: ManagedMachineDestinationProjection;
    recentMachines?: ReadonlyArray<Machine>;
    favoriteMachines?: ReadonlyArray<Machine>;
    showFavorites?: boolean;
    showRecent?: boolean;
    favoriteGroupPlacement?: MachineSelectionFavoriteGroupPlacement;
}>;

/**
 * The one owner of *how many* destinations the New Session picker offers and whether that set is
 * complete.
 *
 * `useMachineSelectionListModel` renders those rows, the route picker decides its single-destination
 * shortcut from them, and the Wizard derives its adaptive presentation from them. Keeping the count
 * here is what stops a Machine-only visibility predicate from disagreeing with the list the user
 * actually sees once Pools, Temporary computers or a non-current Home are involved.
 */
export function buildMachineDestinationModel(
    params: BuildMachineDestinationModelParams,
): MachineDestinationModel {
    const purpose = params.purpose ?? 'session';
    const poolGroups = params.poolGroups ?? [];
    const poolProjectionIsPartOfDestinationSet = params.poolGroups !== undefined;
    // Mirrors the list model's presentation switch so the count can never describe a different list.
    const useBuckets = params.groups.length === 1
        && !params.groups[0]!.loading
        && !params.groups[0]!.signedOut;

    let machineRowCount = 0;
    let poolRowCount = 0;
    let selectableDestination: Readonly<{ serverId: string; machine: Machine }> | null = null;
    let selectableMachineCount = 0;
    let destinationSetSettled = purpose !== 'session' || (
        params.temporaryComputerProjection?.state !== 'pending'
        && params.managedMachineProjection !== undefined
        && params.managedMachineProjection.state !== 'pending'
    );

    for (const group of params.groups) {
        const poolGroup = poolGroups.find((candidate) => candidate.serverId === group.serverId);
        poolRowCount += poolGroup?.pools.length ?? 0;
        if (
            group.loading
            || group.error
            || (poolProjectionIsPartOfDestinationSet && !poolGroup)
            || (poolGroup && resolveMachinePoolRowUnavailableReason({ group, poolGroup }) !== null)
        ) {
            destinationSetSettled = false;
        }
        if (group.loading || group.signedOut) continue;

        const machineRows: ReadonlyArray<Machine> = useBuckets
            ? buildMachineSelectionBuckets({
                machines: group.machines,
                recentMachines: params.recentMachines,
                favoriteMachines: params.favoriteMachines,
                showFavorites: params.showFavorites,
                showRecent: params.showRecent,
                disableOfflineMachines: true,
                favoriteGroupPlacement: params.favoriteGroupPlacement,
            }).buckets.flatMap((bucket) => bucket.machines)
            : group.machines;

        machineRowCount += machineRows.length;
        for (const row of machineRows) {
            if (!resolveMachineDestinationPurposeEligibility(purpose, params.resolveMachinePlacementFacts?.(row, group.serverId), row).eligible) continue;
            if (!resolveMachinePickerPresence(row).selectable) continue;
            selectableMachineCount += 1;
            // Recent/favorite rows can be plain Machine records, so the Home-qualified candidate is
            // resolved from this group's own list instead of trusting the rendered row's shape.
            const owned = group.machines.find((candidate) => candidate.id === row.id);
            selectableDestination = owned ? { serverId: group.serverId, machine: owned } : null;
        }
    }

    const temporaryComputerRowCount = purpose === 'session' && params.temporaryComputerProjection?.state === 'available'
        ? params.temporaryComputerProjection.rowCount
        : 0;
    const managedMachineRowCount = purpose === 'session' && params.managedMachineProjection?.state === 'available'
        ? params.managedMachineProjection.rowCount
        : 0;
    const destinationRowCount = machineRowCount + poolRowCount + temporaryComputerRowCount + managedMachineRowCount;
    return {
        destinationRowCount,
        machineRowCount,
        poolRowCount,
        temporaryComputerRowCount,
        managedMachineRowCount,
        destinationSetSettled,
        soleSelectableDestination: destinationSetSettled
            && destinationRowCount === 1
            && selectableMachineCount === 1
            ? selectableDestination
            : null,
    };
}
