import type { Machine, Session } from '../../domains/state/storageTypes';
import { isPersistentMachine } from '@happier-dev/protocol/machines/machineKind';
import {
    areMachineDisplaySemanticsEqual,
    buildMachineDisplayRenderableFromMachine,
    type MachineDisplayRenderable,
} from '../../domains/machines/machineDisplayRenderable';
import type { Settings } from '../../domains/settings/settings';
import type { SessionListRenderableSession } from '../../domains/session/listing/sessionListRenderable';
import { usesProjectGroupingInSessionList } from '../../domains/session/listing/resolveSessionListGroupingMode';
import type { SessionListIndexItem } from '../../domains/sessionList/sessionListIndex';
import { resolveMachineSessionListIndexImpact } from './machineSessionListIndexImpact';
import { normalizeNonEmptyString } from '@/utils/strings/normalizeNonEmptyString';
import { buildActiveServerSessionListIndex } from '../sessionListIndex/buildSessionListIndexWithServerScope';
import { getActiveServerSnapshot } from '../../domains/server/serverRuntime';
import {
    areServerProfileIdentifiersEquivalent,
    resolveServerProfileScopeIdForIdentifier,
} from '../../domains/server/serverProfiles';
import { projectManager } from '../../runtime/orchestration/projectManager';
import { invalidateCachedTransferRoutesForMachine } from '../../domains/transfers/runtime/transferRouteCache';
import {
    publishMachineContributionRegistryProjectionInvalidation,
} from '../../ops/machineContributionRegistryProjectionRevision';
import {
    scheduleMachineDisplayWarmCacheSave,
    scheduleMachineListDisplayWarmCacheSave,
} from '../../domains/state/machineDisplayWarmCacheWriter';
import { retainMachineRecord, hasMachineContributionRegistryProjectionChanged, hasMachineDaemonStateAdvanced } from './areStoredMachinesEqual';
import { areSessionValuesDeepEqual } from './areStoredSessionsEqual';
import { applyWorkspaceSyncRuntimeEvent } from '../../domains/sessionHandoff/applyWorkspaceSyncRuntimeEvent';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { buildMachineActivityPlaceholder, publishMachineActivities, readMachineActivity, type MachineActivityPublication, type MachineActivityUpdate } from '@/sync/domains/machines/machineActivity';

import type { StoreGet, StoreSet } from './_shared';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { indexMachineInventory, mergeMachineInventory } from './machines/machineInventory';

export { resolveMachineSessionListIndexImpact } from './machineSessionListIndexImpact';

export type MachinesDomain = {
    machines: Record<string, Machine>;
    machineDisplayById: Record<string, MachineDisplayRenderable>;
    machinePresenceById: Record<string, MachinePresence>;
    machinePresenceByServerId: Record<string, Record<string, MachinePresence>>;
    machineListByServerId: Record<string, Machine[] | null>;
    /** Exact rows for Home-scoped reads; published with the ordered inventory. */
    machineRecordsByServerId: Record<string, Record<string, Machine>>;
    machineListStatusByServerId: Record<string, 'idle' | 'loading' | 'signedOut' | 'error'>;
    applyMachines: (machines: Machine[], replace?: boolean, options?: ApplyMachinesOptions) => void;
    applyMachineActivityUpdates: (updates: readonly MachineActivityUpdate[], options?: ApplyMachinesOptions) => void;
    replaceMachineDisplays: (machines: MachineDisplayRenderable[], options?: ApplyMachinesOptions & Readonly<{ replace?: boolean }>) => void;
    /** The owning list read has published all rows, including selective hydration. */
    markMachineListSettled: (serverId: string) => void;
    /** The Home's machine list could not be read; retained rows stay, the loading state ends. */
    markMachineListUnavailable: (serverId: string) => void;
};

export type ApplyMachinesOptions = Readonly<{
    sourceServerId?: string | null;
    sourceAccountId?: string | null;
    /** Liveness captured alongside these admitted rows, not content authority. */
    activityUpdates?: readonly MachineActivityUpdate[];
}>;

type MachineUpdateObserver = (serverId: string, machineIds: readonly string[], facts?: Readonly<{ workSummaryChanged: true }>) => void;
const machineUpdateObservers = new Map<MachineUpdateObserver, Readonly<{ workSummary?: true }>>();

/**
 * Exact Machine receipts share one subscription owner. Work-summary facts are
 * opt-in demand; ordinary presence never supplies a work-summary invalidation.
 */
export function subscribeMachineUpdates(observer: MachineUpdateObserver, demand: Readonly<{ workSummary?: true }> = {}): () => void {
    machineUpdateObservers.set(observer, demand);
    return () => { machineUpdateObservers.delete(observer); };
}

/** Socket ingress carries the inventory producer's fact without changing content or liveness. */
export function publishMachineWorkSummaryChanged(serverId: string, machineId: string): void {
    for (const [observer, demand] of [...machineUpdateObservers]) {
        if (demand.workSummary) observer(serverId, [machineId], { workSummaryChanged: true });
    }
}

type MachinesDomainDependencies = Readonly<{
    sessions: Record<string, Session>;
    sessionListRowsByServerId: Readonly<Record<string, Readonly<Record<string, SessionListRenderableSession>>>>;
    ordinarySessionListMembershipByServerId: Readonly<Record<string, readonly string[] | undefined>>;
    getProjectForSession?: (sessionId: string) => { key?: { machineId?: string | null; rootPath?: string | null } | null } | null;
    profile: { id: string };
    profileScope?: ServerAccountScope | null;
    settings: Settings;
    sessionListIndexByServerId: Readonly<Record<string, SessionListIndexItem[] | null | undefined>>;
}>;

function readOrdinaryRowsForServer(
    state: MachinesDomainDependencies,
    serverId: string,
): Record<string, SessionListRenderableSession> {
    const rows = state.sessionListRowsByServerId[serverId] ?? {};
    return Object.fromEntries((state.ordinarySessionListMembershipByServerId[serverId] ?? []).flatMap((sessionId) => {
        const row = rows[sessionId];
        return row ? [[sessionId, row] as const] : [];
    }));
}

function scheduleActiveWarmMachineCacheSave(
    state: Pick<MachinesDomain & MachinesDomainDependencies, 'machineDisplayById' | 'profileScope'>,
): void {
    const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
    const scope = state.profileScope;
    if (!activeServerId || !scope || !areServerProfileIdentifiersEquivalent(scope.serverId, activeServerId)) return;
    scheduleMachineDisplayWarmCacheSave({
        serverId: activeServerId,
        accountId: scope.accountId,
        machineDisplays: state.machineDisplayById ?? {},
    });
}

function shouldRetainOmittedMachine(machine: Pick<Machine, 'kind'>): boolean {
    // Complete, current discovery can withdraw access by omission. Exact
    // Session-bound rows are outside that census and outlive discovery.
    return !isPersistentMachine(machine);
}

function normalizeMachineServerId(serverId: string | null | undefined): string {
    return resolveServerProfileScopeIdForIdentifier(serverId);
}

function resolveMachinePublicationScope(state: MachinesDomainDependencies, options?: ApplyMachinesOptions) {
    const activeServerId = normalizeMachineServerId(getActiveServerSnapshot().serverId);
    const sourceServerId = normalizeMachineServerId(options?.sourceServerId) || activeServerId;
    const sourceAccountId = normalizeNonEmptyString(options?.sourceAccountId);
    const updatesActiveProjection = !sourceServerId || areServerProfileIdentifiersEquivalent(sourceServerId, activeServerId);
    if (sourceAccountId && updatesActiveProjection) {
        const scope = state.profileScope;
        if (!scope || !areServerProfileIdentifiersEquivalent(scope.serverId, sourceServerId)
            || scope.accountId !== sourceAccountId) return null;
    }
    return { activeServerId, sourceServerId, sourceAccountId, updatesActiveProjection };
}

export type MachinePresence = Readonly<{
    active: boolean;
    activeAt: number;
    updatedAt: number;
}>;

function readMachinePresence(machine: MachinePresence): MachinePresence {
    return { active: machine.active, activeAt: machine.activeAt, updatedAt: machine.updatedAt };
}

function retainMachinePresence(
    previous: MachinePresence | undefined,
    next: MachinePresence,
    contentUnchanged: boolean,
): MachinePresence {
    const nowMs = Date.now();
    if (previous && contentUnchanged && previous.active === next.active
        && isMachineOnline(previous, nowMs) === isMachineOnline(next, nowMs)) return previous;
    return previous?.active === next.active && previous.activeAt === next.activeAt
        && previous.updatedAt === next.updatedAt ? previous : next;
}

function retainMachineDisplay(
    previous: MachineDisplayRenderable | undefined,
    next: MachineDisplayRenderable,
): MachineDisplayRenderable {
    if (!previous) return next;
    if (areMachineDisplaySemanticsEqual(previous, next)) return previous;
    const retained = {
        ...next,
        metadata: areSessionValuesDeepEqual(previous.metadata, next.metadata) ? previous.metadata : next.metadata,
        ...(next.availability !== undefined ? { availability: areSessionValuesDeepEqual(previous.availability, next.availability) ? previous.availability : next.availability } : {}),
        ...(next.access !== undefined ? { access: areSessionValuesDeepEqual(previous.access, next.access) ? previous.access : next.access } : {}),
    };
    return retained;
}

function preserveNewestMachinePresence<T extends MachinePresence>(
    incoming: T,
    currentValues: readonly (MachinePresence | null | undefined)[],
): T {
    // A captured admitted row already owns its live activity slice. An unchanged
    // inventory must not turn that separate clock back into a structural write.
    if (currentValues.some(current => current === incoming)) return incoming;
    let newestCurrent: MachinePresence | null = null;
    for (const current of currentValues) {
        const activity = current ? readMachineActivity(current) : null;
        if (
            current
            && typeof activity?.activeAt === 'number' && Number.isFinite(activity.activeAt)
            && (!newestCurrent || activity.activeAt > newestCurrent.activeAt
                || activity.activeAt === newestCurrent.activeAt && !activity.active)
        ) {
            newestCurrent = { active: activity.active, activeAt: activity.activeAt, updatedAt: current.updatedAt };
        }
    }
    if (!newestCurrent || newestCurrent.activeAt < incoming.activeAt
        || newestCurrent.activeAt === incoming.activeAt && (newestCurrent.active || !incoming.active)) {
        return incoming;
    }
    return {
        ...incoming,
        active: newestCurrent.active,
        activeAt: newestCurrent.activeAt,
    };
}

function resolveServerIdsForMachineTransferRouteInvalidation(
    state: Pick<MachinesDomain, 'machineListByServerId'>,
    machineId: string,
    activeServerId: string,
): readonly string[] {
    const scopedServerIds = Object.entries(state.machineListByServerId ?? {})
        .flatMap(([serverId, machines]) => {
            const normalizedServerId = normalizeNonEmptyString(serverId);
            if (!normalizedServerId || !Array.isArray(machines)) return [];
            return machines.some((machine) => machine.id === machineId) ? [normalizedServerId] : [];
        });

    if (scopedServerIds.length > 0) {
        return Array.from(new Set(scopedServerIds));
    }

    return activeServerId ? [activeServerId] : [];
}

export function createMachinesDomain<S extends MachinesDomain & MachinesDomainDependencies>({
    set,
    get,
}: {
    set: StoreSet<S>;
    get: StoreGet<S>;
}): MachinesDomain {
    function* reconcileActivityUpdates(
        updates: readonly MachineActivityUpdate[],
        scope: NonNullable<ReturnType<typeof resolveMachinePublicationScope>>,
        changedRows: Machine[],
        changedMachineIds: string[],
    ): Generator<MachineActivityPublication> {
        const { sourceServerId, updatesActiveProjection } = scope;
        for (const update of updates) {
            const state = get();
            const activeMachine = updatesActiveProjection ? state.machines[update.id] : undefined;
            const machine = activeMachine ?? state.machineListByServerId[sourceServerId]?.find(machine => machine.id === update.id);
            if (!machine) { changedRows.push(buildMachineActivityPlaceholder(update)); continue; }
            const presence = state.machinePresenceByServerId[sourceServerId]?.[update.id];
            const activePresence = updatesActiveProjection ? state.machinePresenceById[update.id] : undefined;
            const display = updatesActiveProjection ? state.machineDisplayById[update.id] : undefined;
            const activity = readMachineActivity(machine);
            const newestActiveAt = Math.max(activity.activeAt ?? 0,
                presence ? readMachineActivity(presence).activeAt ?? 0 : 0,
                activePresence ? readMachineActivity(activePresence).activeAt ?? 0 : 0);
            if (update.activeAt < newestActiveAt) continue;
            // Timeout retains the last observation's clock. A held active
            // row at that same clock cannot undo its inactive transition.
            if (update.activeAt === newestActiveAt && update.active && !activity.active) continue;
            if (machine.active !== update.active || (display && display.active !== update.active)
                || !isMachineOnline(activePresence ?? presence ?? machine) && isMachineOnline(update)) {
                changedRows.push({ ...machine, active: update.active, activeAt: update.activeAt });
                continue;
            }
            if (update.activeAt === activity.activeAt) continue;
            // The bulk publisher commits each yield before requesting the next,
            // so repeated ids reconcile against the preceding admitted clock.
            yield { machine, activity: update, projections: [activeMachine, display, presence, activePresence] };
            changedMachineIds.push(update.id);
        }
    }

    return {
        machines: {},
        machineDisplayById: {},
        machinePresenceById: {},
        machinePresenceByServerId: {},
        machineListByServerId: {},
        machineRecordsByServerId: {},
        machineListStatusByServerId: {},
        markMachineListSettled: (serverIdRaw) =>
            set((state) => {
                const serverId = normalizeMachineServerId(serverIdRaw);
                if (!serverId || state.machineListStatusByServerId[serverId] === 'idle') return state;
                return {
                    ...state,
                    machineListStatusByServerId: { ...state.machineListStatusByServerId, [serverId]: 'idle' },
                };
            }),
        markMachineListUnavailable: (serverIdRaw) =>
            set((state) => {
                const serverId = normalizeMachineServerId(serverIdRaw);
                if (!serverId || state.machineListStatusByServerId[serverId] === 'error') return state;
                return {
                    ...state,
                    machineListStatusByServerId: { ...state.machineListStatusByServerId, [serverId]: 'error' },
                };
            }),
        applyMachineActivityUpdates: (updates, options) => {
            const scope = resolveMachinePublicationScope(get(), options);
            if (!scope || updates.length === 0) return;
            const { sourceServerId } = scope;
            const changedMachineIds: string[] = [];
            const changedRows: Machine[] = [];
            publishMachineActivities(reconcileActivityUpdates(updates, scope, changedRows, changedMachineIds));
            if (changedRows.length > 0) get().applyMachines(changedRows, false,
                { sourceServerId, sourceAccountId: scope.sourceAccountId });
            if (sourceServerId && changedMachineIds.length > 0) {
                for (const observer of [...machineUpdateObservers.keys()]) observer(sourceServerId, changedMachineIds);
            }
        },
        applyMachines: (machines, replace = false, options) => {
            const scope = resolveMachinePublicationScope(get(), options);
            if (!scope) return;
            const { activeServerId, sourceServerId, sourceAccountId } = scope;
            const changedMachineIds = new Set<string>();
            const changedMachines: Machine[] = [];
            let activityUpdates: MachineActivityUpdate[] = [];
            set((state) => {
                const shouldUpdateActiveProjection = !sourceServerId || areServerProfileIdentifiersEquivalent(sourceServerId, activeServerId);
                const currentScopedMachines = sourceServerId
                    ? state.machineListByServerId[sourceServerId]
                    : null;
                // The census owner admits replacement freshness. Omission can
                // withdraw persistent access without Machine-wide revocation.
                const currentMachineRecords = Array.isArray(currentScopedMachines)
                    ? currentScopedMachines
                    : shouldUpdateActiveProjection ? Object.values(state.machines) : [];
                const currentMachineById = (sourceServerId ? state.machineRecordsByServerId[sourceServerId] : undefined)
                    ?? indexMachineInventory(currentMachineRecords);
                const incomingIds = new Set(machines.map((machine) => machine.id));
                const incomingMachines = replace
                    ? [...machines, ...currentMachineRecords.filter((machine) => (
                        shouldRetainOmittedMachine(machine) && !incomingIds.has(machine.id)
                    ))]
                    : machines;
                const normalizedMachines = incomingMachines.map((machine) => {
                    return preserveNewestMachinePresence(machine, [
                        Array.isArray(currentScopedMachines) ? currentMachineById[machine.id] : null,
                        shouldUpdateActiveProjection ? state.machines[machine.id] : null,
                        shouldUpdateActiveProjection ? state.machineDisplayById[machine.id] : null,
                    ]);
                });
                if (replace) {
                    const retainedIds = new Set(normalizedMachines.map(machine => machine.id));
                    for (const id of Object.keys(currentMachineById)) if (!retainedIds.has(id)) changedMachineIds.add(id);
                }
                // Retain once, then publish that exact record to both projections.
                // Two independent reconciliations can create distinct retained
                // copies, forcing liveness to search and patch both inventories.
                const retainedMachines = normalizedMachines.map(machine => retainMachineRecord(
                    shouldUpdateActiveProjection ? state.machines[machine.id] ?? currentMachineById[machine.id]
                        : currentMachineById[machine.id], machine,
                ));
                activityUpdates = normalizedMachines.flatMap((machine, index) => {
                    const activity = readMachineActivity(retainedMachines[index]);
                    return activity.active === machine.active && activity.activeAt === machine.activeAt ? []
                        : [{ id: machine.id, active: machine.active, activeAt: machine.activeAt }];
                });
                for (const machine of retainedMachines) {
                    if (machine !== currentMachineById[machine.id]) {
                        changedMachineIds.add(machine.id);
                        changedMachines.push(machine);
                    }
                }
                let machinePresenceByServerId = state.machinePresenceByServerId;
                let machinePresenceById = state.machinePresenceById;
                if (sourceServerId) {
                    const previousPresence = state.machinePresenceByServerId[sourceServerId] ?? {};
                    let nextPresence = previousPresence;
                    if (replace) {
                        const retainedIds = new Set(normalizedMachines.map((machine) => machine.id));
                        for (const id of Object.keys(previousPresence)) {
                            if (retainedIds.has(id)) continue;
                            if (nextPresence === previousPresence) nextPresence = { ...previousPresence };
                            delete nextPresence[id];
                        }
                    }
                    for (const [index, machine] of normalizedMachines.entries()) {
                        const previous = previousPresence[machine.id];
                        const previousMachine = shouldUpdateActiveProjection
                            ? state.machines[machine.id] ?? currentMachineById[machine.id]
                            : currentMachineById[machine.id];
                        const presence = retainMachinePresence(previous, readMachinePresence(machine), retainedMachines[index] === previousMachine);
                        if (presence === previous) continue;
                        if (nextPresence === previousPresence) nextPresence = { ...previousPresence };
                        nextPresence[machine.id] = presence;
                    }
                    if (nextPresence !== previousPresence) {
                        machinePresenceByServerId = { ...state.machinePresenceByServerId, [sourceServerId]: nextPresence };
                    }
                }
                const nextInventory = sourceServerId
                    ? mergeMachineInventory(currentScopedMachines, currentMachineById, retainedMachines, replace)
                    : null;
                const nextScopedMachines = nextInventory?.machines ?? currentScopedMachines;
                const machineListByServerId = sourceServerId && nextScopedMachines !== currentScopedMachines
                    ? {
                        ...state.machineListByServerId,
                        [sourceServerId]: nextScopedMachines ?? null,
                    }
                    : state.machineListByServerId;
                const machineRecordsByServerId = sourceServerId && nextInventory
                    && nextInventory.byId !== state.machineRecordsByServerId[sourceServerId]
                    ? { ...state.machineRecordsByServerId, [sourceServerId]: nextInventory.byId }
                    : state.machineRecordsByServerId;
                // Socket/exact rows and warm hydration are not a completed list.
                // Only the list reader settles it; incremental rows preserve a
                // completed read or its failure until that owner reports recovery.
                const machineListStatusByServerId = sourceServerId && state.machineListStatusByServerId[sourceServerId] === undefined
                    ? { ...state.machineListStatusByServerId, [sourceServerId]: 'loading' as const }
                    : state.machineListStatusByServerId;

                const scopedMachines = sourceServerId ? machineListByServerId[sourceServerId] : null;
                const scopedMachinesWithAdvancedDaemonState = normalizedMachines.filter((machine) => (
                    hasMachineDaemonStateAdvanced(
                        Array.isArray(currentScopedMachines)
                            ? currentMachineById[machine.id]
                            : undefined,
                        machine,
                    )
                ));
                for (const machine of scopedMachinesWithAdvancedDaemonState) {
                    if (!shouldUpdateActiveProjection && sourceServerId) {
                        invalidateCachedTransferRoutesForMachine({
                            serverId: sourceServerId,
                            remoteMachineId: machine.id,
                        });
                    }
                    const previous = Array.isArray(currentScopedMachines)
                        ? currentMachineById[machine.id]
                        : shouldUpdateActiveProjection ? state.machines[machine.id] : undefined;
                    if (sourceServerId && hasMachineContributionRegistryProjectionChanged(previous, machine)) {
                        publishMachineContributionRegistryProjectionInvalidation({
                            serverId: sourceServerId,
                            machineId: machine.id,
                        });
                    }
                    applyWorkspaceSyncRuntimeEvent({
                        serverId: sourceServerId,
                        machineId: machine.id,
                        event: machine.daemonState?.workspaceSync,
                    });
                }
                if (!shouldUpdateActiveProjection && sourceServerId && sourceAccountId && Array.isArray(scopedMachines)
                    && scopedMachines !== currentScopedMachines) {
                    scheduleMachineListDisplayWarmCacheSave({
                        serverId: sourceServerId,
                        accountId: sourceAccountId,
                        machines: scopedMachines,
                    });
                }

                if (!shouldUpdateActiveProjection) {
                    if (machineListByServerId === state.machineListByServerId
                        && machineRecordsByServerId === state.machineRecordsByServerId
                        && machineListStatusByServerId === state.machineListStatusByServerId
                        && machinePresenceByServerId === state.machinePresenceByServerId) return state;
                    return {
                        ...state,
                        machineListByServerId,
                        machineRecordsByServerId,
                        machineListStatusByServerId,
                        machinePresenceByServerId,
                    };
                }

                if (replace) {
                    const retainedIds = new Set(normalizedMachines.map((machine) => machine.id));
                    for (const id of Object.keys(state.machinePresenceById)) {
                        if (retainedIds.has(id)) continue;
                        if (machinePresenceById === state.machinePresenceById) machinePresenceById = { ...state.machinePresenceById };
                        delete machinePresenceById[id];
                    }
                }
                for (const [index, machine] of normalizedMachines.entries()) {
                    const previous = state.machinePresenceById[machine.id];
                    const previousMachine = state.machines[machine.id] ?? currentMachineById[machine.id];
                    const presence = retainMachinePresence(previous, readMachinePresence(machine), retainedMachines[index] === previousMachine);
                    if (presence === previous) continue;
                    if (machinePresenceById === state.machinePresenceById) machinePresenceById = { ...state.machinePresenceById };
                    machinePresenceById[machine.id] = presence;
                }

                let mergedMachines = state.machines;
                let mergedMachineDisplays = state.machineDisplayById;
                let hasDisplaySemanticChanges = false;
                const machinesWithAdvancedDaemonState = new Set<string>();

                if (replace) {
                    const retainedIds = new Set(normalizedMachines.map((machine) => machine.id));
                    for (const id of Object.keys(mergedMachines)) {
                        if (retainedIds.has(id)) continue;
                        if (mergedMachines === state.machines) mergedMachines = { ...state.machines };
                        delete mergedMachines[id];
                    }
                    for (const id of Object.keys(mergedMachineDisplays)) {
                        if (retainedIds.has(id)) continue;
                        hasDisplaySemanticChanges = true;
                        if (mergedMachineDisplays === state.machineDisplayById) mergedMachineDisplays = { ...state.machineDisplayById };
                        delete mergedMachineDisplays[id];
                    }
                }
                retainedMachines.forEach((machine) => {
                    const previousMachine = state.machines[machine.id];
                    if (hasMachineDaemonStateAdvanced(previousMachine, machine)) {
                        machinesWithAdvancedDaemonState.add(machine.id);
                    }
                    const retainedMachine = machine;
                    if (retainedMachine !== previousMachine) {
                        if (mergedMachines === state.machines) {
                            mergedMachines = { ...state.machines };
                        }
                        mergedMachines[machine.id] = retainedMachine;
                    }
                    const nextDisplay = buildMachineDisplayRenderableFromMachine(machine);
                    const previousDisplay = state.machineDisplayById[machine.id];
                    if (!areMachineDisplaySemanticsEqual(previousDisplay, nextDisplay)) hasDisplaySemanticChanges = true;
                    const retainedDisplay = retainMachineDisplay(previousDisplay, nextDisplay);
                    if (retainedDisplay !== previousDisplay) {
                        if (mergedMachineDisplays === state.machineDisplayById) {
                            mergedMachineDisplays = { ...state.machineDisplayById };
                        }
                        mergedMachineDisplays[machine.id] = retainedDisplay;
                    }
                });

                if (
                    mergedMachines === state.machines
                    && mergedMachineDisplays === state.machineDisplayById
                    && machineListByServerId === state.machineListByServerId
                    && machineRecordsByServerId === state.machineRecordsByServerId
                    && machineListStatusByServerId === state.machineListStatusByServerId
                    && machinePresenceById === state.machinePresenceById
                    && machinePresenceByServerId === state.machinePresenceByServerId
                ) {
                    return state;
                }

                const previousIndexByServerId = state.sessionListIndexByServerId ?? {};
                const previousActiveIndex = activeServerId ? (previousIndexByServerId[activeServerId] ?? null) : null;
                const activeSessionListRows = activeServerId && (hasDisplaySemanticChanges || previousActiveIndex == null)
                    ? readOrdinaryRowsForServer(state, activeServerId) : {};
                let needsSessionListIndexRebuild = Boolean(activeServerId) && previousActiveIndex == null;
                let needsProjectManagerUpdate = false;

                if (!needsSessionListIndexRebuild && hasDisplaySemanticChanges) {
                    const machineImpact = resolveMachineSessionListIndexImpact({
                        sessions: Object.values(activeSessionListRows),
                        previousMachineDisplays: state.machineDisplayById ?? {},
                        nextMachineDisplays: mergedMachineDisplays,
                        usesProjectGrouping: usesProjectGroupingInSessionList({
                            layoutV1: state.settings.sessionListLayoutV1,
                        }),
                    });
                    if (machineImpact.needsSessionListIndexRebuild) {
                        needsSessionListIndexRebuild = true;
                    }
                    if (machineImpact.needsProjectManagerUpdate) {
                        needsProjectManagerUpdate = true;
                    }
                }

                const nextSessionListIndex = needsSessionListIndexRebuild && activeServerId
                    ? buildActiveServerSessionListIndex({
                        sessions: activeSessionListRows,
                        sessionRecords: state.sessions,
                        machines: mergedMachineDisplays,
                        machineRecords: mergedMachines,
                        layoutV1: state.settings.sessionListLayoutV1,
                        getProjectForSession: state.getProjectForSession,
                        previousIndex: previousActiveIndex,
                    })
                    : previousActiveIndex;

                if (needsProjectManagerUpdate) {
                    const machineMetadataMap = new Map<string, any>();
                    Object.values(mergedMachines).forEach((machine) => {
                        if (machine.metadata) {
                            machineMetadataMap.set(machine.id, machine.metadata);
                        }
                    });
                    projectManager.updateSessions(Object.values(state.sessions), machineMetadataMap);
                }

                for (const machineId of machinesWithAdvancedDaemonState) {
                    const serverIds = resolveServerIdsForMachineTransferRouteInvalidation(state, machineId, activeServerId);
                    for (const serverId of serverIds) {
                        invalidateCachedTransferRoutesForMachine({
                            serverId,
                            remoteMachineId: machineId,
                        });
                    }
                }
                const nextSessionListIndexByServerId = activeServerId
                    ? (previousIndexByServerId[activeServerId] === nextSessionListIndex
                        ? previousIndexByServerId
                        : { ...previousIndexByServerId, [activeServerId]: nextSessionListIndex })
                    : previousIndexByServerId;
                const nextState = {
                    ...state,
                    machines: mergedMachines,
                    machineDisplayById: mergedMachineDisplays,
                    sessionListIndexByServerId: nextSessionListIndexByServerId,
                    machineListByServerId,
                    machineRecordsByServerId,
                    machineListStatusByServerId,
                    machinePresenceById,
                    machinePresenceByServerId,
                };
                if (hasDisplaySemanticChanges) {
                    scheduleActiveWarmMachineCacheSave(nextState as MachinesDomain & MachinesDomainDependencies);
                }
                return nextState;
            });
            const published = get();
            const changedActivityRows: Machine[] = [];
            const changedActivityIds: string[] = [];
            if (options?.activityUpdates?.length) {
                const admittedIds = new Set(machines.map(machine => machine.id));
                activityUpdates.push(...options.activityUpdates.filter(update => admittedIds.has(update.id)));
            }
            // Full rows and their captured hydration clocks are one arrival.
            publishMachineActivities((function* (): Generator<MachineActivityPublication> {
                for (const machine of changedMachines) {
                    const projections = [
                        scope.updatesActiveProjection ? published.machineDisplayById[machine.id] : null,
                        scope.updatesActiveProjection ? published.machinePresenceById[machine.id] : null,
                        published.machinePresenceByServerId[sourceServerId]?.[machine.id],
                    ];
                    const activity = readMachineActivity(machine);
                    if (projections.some(projection => {
                        const current = projection ? readMachineActivity(projection) : null;
                        return current && (current.active !== activity.active || current.activeAt !== activity.activeAt);
                    })) yield { machine, activity: { active: activity.active, activeAt: activity.activeAt }, projections };
                }
                yield* reconcileActivityUpdates(activityUpdates, scope, changedActivityRows, changedActivityIds);
            })());
            if (changedActivityRows.length > 0) get().applyMachines(changedActivityRows, false, { sourceServerId, sourceAccountId });
            for (const id of changedActivityIds) changedMachineIds.add(id);
            if (sourceServerId && machineUpdateObservers.size > 0 && changedMachineIds.size > 0) {
                const machineIds = [...changedMachineIds];
                for (const observer of [...machineUpdateObservers.keys()]) observer(sourceServerId, machineIds);
            }
        },
        replaceMachineDisplays: (machines, options) => {
            const activityUpdates: Array<{ display: MachineDisplayRenderable; activity: MachineActivityUpdate }> = [];
            set((state) => {
                const activeServerId = normalizeMachineServerId(getActiveServerSnapshot().serverId);
                const sourceServerId = normalizeMachineServerId(options?.sourceServerId) || activeServerId;
                if (sourceServerId && !areServerProfileIdentifiersEquivalent(sourceServerId, activeServerId)) {
                    return state;
                }

                const incomingDisplayIds = new Set(machines.map((machine) => machine.id));
                const displays = [...machines, ...Object.values(state.machineDisplayById).filter((machine) => (
                    (options?.replace === false || shouldRetainOmittedMachine(machine)) && !incomingDisplayIds.has(machine.id)
                ))];
                let hasDisplaySemanticChanges = displays.length !== Object.keys(state.machineDisplayById).length;
                const nextMachineDisplays = Object.fromEntries(displays.map((machine) => {
                    const nextDisplay = preserveNewestMachinePresence(machine, [
                        state.machineDisplayById[machine.id],
                        state.machines[machine.id],
                    ]);
                    const previousDisplay = state.machineDisplayById[machine.id];
                    if (!areMachineDisplaySemanticsEqual(previousDisplay, nextDisplay)) hasDisplaySemanticChanges = true;
                    const retained = retainMachineDisplay(previousDisplay, nextDisplay);
                    const activity = readMachineActivity(nextDisplay);
                    const previousActivity = previousDisplay ? readMachineActivity(previousDisplay) : null;
                    if (retained === previousDisplay && (activity.active !== previousActivity?.active
                        || activity.activeAt !== previousActivity?.activeAt)) {
                        activityUpdates.push({ display: retained,
                            activity: { id: retained.id, active: activity.active, activeAt: activity.activeAt ?? 0 } });
                    }
                    return [machine.id, retained];
                }));
                if (Object.keys(nextMachineDisplays).length === Object.keys(state.machineDisplayById).length
                    && Object.entries(nextMachineDisplays).every(([id, display]) => display === state.machineDisplayById[id])) {
                    return state;
                }
                const previousIndexByServerId = state.sessionListIndexByServerId ?? {};
                const previousActiveIndex = activeServerId ? (previousIndexByServerId[activeServerId] ?? null) : null;
                const activeSessionListRows = activeServerId ? readOrdinaryRowsForServer(state, activeServerId) : {};
                const nextSessionListIndex = activeServerId
                    ? buildActiveServerSessionListIndex({
                        sessions: activeSessionListRows,
                        sessionRecords: state.sessions,
                        machines: nextMachineDisplays,
                        machineRecords: state.machines,
                        layoutV1: state.settings.sessionListLayoutV1,
                        getProjectForSession: state.getProjectForSession,
                        previousIndex: previousActiveIndex,
                    })
                    : previousActiveIndex;
                const nextSessionListIndexByServerId = activeServerId
                    ? (previousIndexByServerId[activeServerId] === nextSessionListIndex
                        ? previousIndexByServerId
                        : { ...previousIndexByServerId, [activeServerId]: nextSessionListIndex })
                    : previousIndexByServerId;
                const nextState = {
                    ...state,
                    machineDisplayById: nextMachineDisplays,
                    sessionListIndexByServerId: nextSessionListIndexByServerId,
                };
                // Match applyMachines: immutable live heartbeats remain current, but
                // presentation persistence follows display facts, not timestamp ticks.
                if (hasDisplaySemanticChanges) {
                    scheduleActiveWarmMachineCacheSave(nextState as MachinesDomain & MachinesDomainDependencies);
                }
                return nextState;
            });
            const scope = resolveMachinePublicationScope(get(), options);
            const changedRows: Machine[] = [];
            const changedMachineIds: string[] = [];
            publishMachineActivities((function* (): Generator<MachineActivityPublication> {
                for (const { display, activity } of activityUpdates) {
                    if (get().machines[display.id]) {
                        if (scope) yield* reconcileActivityUpdates([activity], scope, changedRows, changedMachineIds);
                    } else yield { machine: display, activity, projections: [] };
                }
            })());
            if (scope && changedRows.length > 0) get().applyMachines(changedRows, false,
                { sourceServerId: scope.sourceServerId, sourceAccountId: scope.sourceAccountId });
            if (scope && changedMachineIds.length > 0) {
                for (const observer of [...machineUpdateObservers.keys()]) observer(scope.sourceServerId, changedMachineIds);
            }
        },
    };
}
