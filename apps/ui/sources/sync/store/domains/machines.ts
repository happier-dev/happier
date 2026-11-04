import { retainMachineRecord } from './areStoredMachinesEqual';
import { indexMachineInventory } from './machines/machineInventory';
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
import { areStoredMachinesEqual, areStoredMachineSemanticsEqual, hasMachineContributionRegistryProjectionChanged, hasMachineDaemonStateAdvanced } from './areStoredMachinesEqual';
import { areSessionValuesDeepEqual } from './areStoredSessionsEqual';
import { applyWorkspaceSyncRuntimeEvent } from '../../domains/sessionHandoff/applyWorkspaceSyncRuntimeEvent';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

import type { StoreGet, StoreSet } from './_shared';

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
    replaceMachineDisplays: (machines: MachineDisplayRenderable[], options?: ApplyMachinesOptions & Readonly<{ replace?: boolean }>) => void;
    /** The owning list read has published all rows, including selective hydration. */
    markMachineListSettled: (serverId: string) => void;
    /** The Home's machine list could not be read; retained rows stay, the loading state ends. */
    markMachineListUnavailable: (serverId: string) => void;
};

export type ApplyMachinesOptions = Readonly<{
    sourceServerId?: string | null;
    sourceAccountId?: string | null;
}>;

type MachineUpdateObserver = (serverId: string, machineIds: readonly string[]) => void;
const machineUpdateObservers = new Set<MachineUpdateObserver>();

/**
 * Mounted work-summary readers use exact Machine liveness invalidations (plan 42 §8).
 * Heartbeat-only applyMachines deliberately returns the same store state and mutates
 * activeAt in place, so neither a Machine selector nor a presence selector is notified.
 * This receipt lets that reader compare liveness without waking broad projections;
 * scoped inventory, presence and the reader's pending request remain their owners.
 */
export function subscribeMachineUpdates(observer: MachineUpdateObserver): () => void {
    machineUpdateObservers.add(observer);
    return () => { machineUpdateObservers.delete(observer); };
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

function mergeMachineListById(
    current: Machine[] | null | undefined,
    incoming: Machine[],
    options: Readonly<{ replace: boolean }>,
): Machine[] {
    const currentById = new Map((current ?? []).map((machine) => [machine.id, machine]));
    const mergedById = options.replace ? new Map<string, Machine>() : new Map(currentById);
    for (const machine of incoming) {
        const previous = currentById.get(machine.id);
        mergedById.set(machine.id, retainMachineForPresenceOnly(previous, machine));
    }
    const merged = Array.from(mergedById.values());
    if (
        Array.isArray(current)
        && current.length === merged.length
        && current.every((machine, index) => machine === merged[index])
    ) {
        return current;
    }
    return merged;
}

function normalizeMachineServerId(serverId: string | null | undefined): string {
    return resolveServerProfileScopeIdForIdentifier(serverId);
}

export type MachinePresence = Readonly<{
    active: boolean;
    activeAt: number;
    updatedAt: number;
}>;

function readMachinePresence(machine: MachinePresence): MachinePresence {
    return { active: machine.active, activeAt: machine.activeAt, updatedAt: machine.updatedAt };
}

function retainMachinePresenceForHeartbeat(
    previous: MachinePresence | undefined,
    next: MachinePresence,
): MachinePresence {
    if (!previous || previous.active !== next.active) return next;
    // A fresh heartbeat after grace expiry is a semantic recovery, even when
    // the server's active bit never changed. Publish that edge to re-arm readers.
    const nowMs = Date.now();
    if (isMachineOnline(previous, nowMs) !== isMachineOnline(next, nowMs)) return next;
    Object.assign(previous, { activeAt: next.activeAt, updatedAt: next.updatedAt });
    return previous;
}

function retainMachineForPresenceOnly(previous: Machine | undefined, next: Machine): Machine {
    if (!previous) return next;
    if (areStoredMachineSemanticsEqual(previous, next)) {
        previous.updatedAt = next.updatedAt;
        previous.activeAt = next.activeAt;
        return previous;
    }
    return retainMachineRecord(previous, next);
}

function retainMachineDisplayForPresenceOnly(
    previous: MachineDisplayRenderable | undefined,
    next: MachineDisplayRenderable,
): MachineDisplayRenderable {
    if (!previous) return next;
    if (areMachineDisplaySemanticsEqual(previous, next)) {
        previous.updatedAt = next.updatedAt;
        previous.activeAt = next.activeAt;
        return previous;
    }
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
    let newestCurrent: MachinePresence | null = null;
    for (const current of currentValues) {
        if (
            current
            && Number.isFinite(current.activeAt)
            && (!newestCurrent || current.activeAt > newestCurrent.activeAt)
        ) {
            newestCurrent = current;
        }
    }
    if (!newestCurrent || newestCurrent.activeAt <= incoming.activeAt) {
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
        applyMachines: (machines, replace = false, options) => {
            const activeServerId = normalizeMachineServerId(getActiveServerSnapshot().serverId);
            const sourceServerId = normalizeMachineServerId(options?.sourceServerId) || activeServerId;
            const sourceAccountId = normalizeNonEmptyString(options?.sourceAccountId);
            if (sourceAccountId && areServerProfileIdentifiersEquivalent(sourceServerId, activeServerId)) {
                const scope = get().profileScope;
                if (!scope || !areServerProfileIdentifiersEquivalent(scope.serverId, sourceServerId)
                    || scope.accountId !== sourceAccountId) return;
            }
            const changedMachineIds = new Set<string>();
            set((state) => {
                const shouldUpdateActiveProjection = !sourceServerId || areServerProfileIdentifiersEquivalent(sourceServerId, activeServerId);
                const currentScopedMachines = sourceServerId
                    ? state.machineListByServerId[sourceServerId]
                    : null;
                // A full ordinary inventory omits Session-bound computers. It
                // cannot invalidate exact rows already hydrated for a Session.
                const currentMachineRecords = Array.isArray(currentScopedMachines)
                    ? currentScopedMachines
                    : shouldUpdateActiveProjection ? Object.values(state.machines) : [];
                const currentMachineById = new Map(currentMachineRecords.map(machine => [machine.id, machine]));
                const incomingIds = new Set(machines.map((machine) => machine.id));
                const incomingMachines = replace
                    ? [...machines, ...currentMachineRecords.filter((machine) => (
                        !isPersistentMachine(machine) && !incomingIds.has(machine.id)
                    ))]
                    : machines;
                const normalizedMachines = incomingMachines.map((machine) => preserveNewestMachinePresence(machine, [
                    Array.isArray(currentScopedMachines)
                        ? currentMachineById.get(machine.id)
                        : null,
                    shouldUpdateActiveProjection ? state.machines[machine.id] : null,
                ]));
                for (const machine of normalizedMachines) {
                    if (!areStoredMachinesEqual(currentMachineById.get(machine.id), machine)) changedMachineIds.add(machine.id);
                }
                if (replace) {
                    const retainedIds = new Set(normalizedMachines.map(machine => machine.id));
                    for (const id of currentMachineById.keys()) if (!retainedIds.has(id)) changedMachineIds.add(id);
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
                    for (const machine of normalizedMachines) {
                        const previous = previousPresence[machine.id];
                        const presence = retainMachinePresenceForHeartbeat(previous, readMachinePresence(machine));
                        if (presence === previous) continue;
                        if (nextPresence === previousPresence) nextPresence = { ...previousPresence };
                        nextPresence[machine.id] = presence;
                    }
                    if (nextPresence !== previousPresence) {
                        machinePresenceByServerId = { ...state.machinePresenceByServerId, [sourceServerId]: nextPresence };
                    }
                }
                const nextScopedMachines = sourceServerId
                    ? mergeMachineListById(currentScopedMachines, normalizedMachines, { replace })
                    : currentScopedMachines;
                const machineListByServerId = sourceServerId && nextScopedMachines !== currentScopedMachines
                    ? {
                        ...state.machineListByServerId,
                        [sourceServerId]: nextScopedMachines ?? null,
                    }
                    : state.machineListByServerId;
                const machineRecordsByServerId = sourceServerId
                    && (nextScopedMachines !== currentScopedMachines || !state.machineRecordsByServerId[sourceServerId])
                    ? { ...state.machineRecordsByServerId, [sourceServerId]: indexMachineInventory(nextScopedMachines) }
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
                            ? currentMachineById.get(machine.id)
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
                        ? currentMachineById.get(machine.id)
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
                for (const machine of normalizedMachines) {
                    const previous = state.machinePresenceById[machine.id];
                    const presence = retainMachinePresenceForHeartbeat(previous, readMachinePresence(machine));
                    if (presence === previous) continue;
                    if (machinePresenceById === state.machinePresenceById) machinePresenceById = { ...state.machinePresenceById };
                    machinePresenceById[machine.id] = presence;
                }

                let mergedMachines = state.machines;
                let mergedMachineDisplays = state.machineDisplayById;
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
                        if (mergedMachineDisplays === state.machineDisplayById) mergedMachineDisplays = { ...state.machineDisplayById };
                        delete mergedMachineDisplays[id];
                    }
                }
                normalizedMachines.forEach((machine) => {
                    const previousMachine = state.machines[machine.id];
                    if (hasMachineDaemonStateAdvanced(previousMachine, machine)) {
                        machinesWithAdvancedDaemonState.add(machine.id);
                    }
                    const retainedMachine = retainMachineForPresenceOnly(previousMachine, machine);
                    if (retainedMachine !== previousMachine) {
                        if (mergedMachines === state.machines) {
                            mergedMachines = { ...state.machines };
                        }
                        mergedMachines[machine.id] = retainedMachine;
                    }
                    const nextDisplay = buildMachineDisplayRenderableFromMachine(machine);
                    const previousDisplay = state.machineDisplayById[machine.id];
                    const retainedDisplay = retainMachineDisplayForPresenceOnly(previousDisplay, nextDisplay);
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
                const activeSessionListRows = activeServerId ? readOrdinaryRowsForServer(state, activeServerId) : {};
                let needsSessionListIndexRebuild = Boolean(activeServerId) && previousActiveIndex == null;
                let needsProjectManagerUpdate = false;

                if (!needsSessionListIndexRebuild) {
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
                if (mergedMachineDisplays !== state.machineDisplayById) {
                    scheduleActiveWarmMachineCacheSave(nextState as MachinesDomain & MachinesDomainDependencies);
                }
                return nextState;
            });
            if (sourceServerId && machineUpdateObservers.size > 0 && changedMachineIds.size > 0) {
                const machineIds = [...changedMachineIds];
                for (const observer of [...machineUpdateObservers]) observer(sourceServerId, machineIds);
            }
        },
        replaceMachineDisplays: (machines, options) =>
            set((state) => {
                const activeServerId = normalizeMachineServerId(getActiveServerSnapshot().serverId);
                const sourceServerId = normalizeMachineServerId(options?.sourceServerId) || activeServerId;
                if (sourceServerId && !areServerProfileIdentifiersEquivalent(sourceServerId, activeServerId)) {
                    return state;
                }

                const incomingDisplayIds = new Set(machines.map((machine) => machine.id));
                const displays = [...machines, ...Object.values(state.machineDisplayById).filter((machine) => (
                    (options?.replace === false || !isPersistentMachine(machine)) && !incomingDisplayIds.has(machine.id)
                ))];
                const nextMachineDisplays = Object.fromEntries(displays.map((machine) => {
                    const nextDisplay = preserveNewestMachinePresence(machine, [
                        state.machineDisplayById[machine.id],
                        state.machines[machine.id],
                    ]);
                    const previousDisplay = state.machineDisplayById[machine.id];
                    return [machine.id, retainMachineDisplayForPresenceOnly(previousDisplay, nextDisplay)];
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
                scheduleActiveWarmMachineCacheSave(nextState as MachinesDomain & MachinesDomainDependencies);
                return nextState;
            }),
    };
}
