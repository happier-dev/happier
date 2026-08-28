import type { Machine, Session } from '../../domains/state/storageTypes';
import {
    areMachineDisplayRenderablesEqual,
    buildMachineDisplayRenderableFromMachine,
    type MachineDisplayRenderable,
} from '../../domains/machines/machineDisplayRenderable';
import type { Settings } from '../../domains/settings/settings';
import type { SessionListRenderableSession } from '../../domains/session/listing/sessionListRenderable';
import { usesProjectGroupingInSessionList } from '../../domains/session/listing/resolveSessionListGroupingModes';
import type { SessionListIndexItem } from '../../domains/sessionList/sessionListIndex';
import { resolveMachineSessionListIndexImpact } from './machineSessionListIndexImpact';
import { normalizeNonEmptyString } from '@/utils/strings/normalizeNonEmptyString';
import { buildActiveServerSessionListIndex } from '../sessionListIndex/buildSessionListIndexWithServerScope';
import { getActiveServerSnapshot } from '../../domains/server/serverRuntime';
import {
    areServerProfileIdentifiersEquivalent,
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
import { areSessionValuesDeepEqual } from './areStoredSessionsEqual';
import { areStoredMachinesEqual, hasMachineDaemonStateAdvanced } from './areStoredMachinesEqual';

import type { StoreGet, StoreSet } from './_shared';

export { resolveMachineSessionListIndexImpact } from './machineSessionListIndexImpact';

export type MachinesDomain = {
    machines: Record<string, Machine>;
    machineDisplayById: Record<string, MachineDisplayRenderable>;
    machineListByServerId: Record<string, Machine[] | null>;
    machineListStatusByServerId: Record<string, 'idle' | 'loading' | 'signedOut' | 'error'>;
    applyMachines: (machines: Machine[], replace?: boolean, options?: ApplyMachinesOptions) => void;
    replaceMachineDisplays: (machines: MachineDisplayRenderable[], options?: ApplyMachinesOptions) => void;
};

export type ApplyMachinesOptions = Readonly<{
    sourceServerId?: string | null;
}>;

type MachinesDomainDependencies = Readonly<{
    sessions: Record<string, Session>;
    sessionListRenderables: Record<string, SessionListRenderableSession>;
    getProjectForSession?: (sessionId: string) => { key?: { machineId?: string | null; rootPath?: string | null } | null } | null;
    profile: { id: string };
    settings: Settings;
    sessionListIndexByServerId: Readonly<Record<string, SessionListIndexItem[] | null | undefined>>;
}>;

function scheduleActiveWarmMachineCacheSave(
    state: Pick<MachinesDomain & MachinesDomainDependencies, 'machineDisplayById' | 'profile'>,
): void {
    const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
    if (!activeServerId) return;
    scheduleMachineDisplayWarmCacheSave({
        serverId: activeServerId,
        accountId: state.profile?.id,
        machineDisplays: state.machineDisplayById ?? {},
    });
}

function mergeMachineListById(
    current: Machine[] | null | undefined,
    incoming: Machine[],
    options: Readonly<{ replace: boolean }>,
): Machine[] {
    if (options.replace) {
        return incoming.slice();
    }
    const mergedById = new Map<string, Machine>();
    if (Array.isArray(current)) {
        for (const machine of current) {
            mergedById.set(machine.id, machine);
        }
    }
    for (const machine of incoming) {
        mergedById.set(machine.id, machine);
    }
    const merged = Array.from(mergedById.values());
    if (
        Array.isArray(current)
        && current.length === merged.length
        && current.every((machine, index) => areStoredMachinesEqual(machine, merged[index]))
    ) {
        return current;
    }
    return merged;
}

function normalizeMachineServerId(serverId: string | null | undefined): string {
    return String(serverId ?? '').trim();
}

type MachinePresence = Readonly<{
    active: boolean;
    activeAt: number;
}>;

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
}: {
    set: StoreSet<S>;
    get: StoreGet<S>;
}): MachinesDomain {
    return {
        machines: {},
        machineDisplayById: {},
        machineListByServerId: {},
        machineListStatusByServerId: {},
        applyMachines: (machines, replace = false, options) =>
            set((state) => {
                const activeServerId = normalizeMachineServerId(getActiveServerSnapshot().serverId);
                const sourceServerId = normalizeMachineServerId(options?.sourceServerId) || activeServerId;
                const shouldUpdateActiveProjection = !sourceServerId || areServerProfileIdentifiersEquivalent(sourceServerId, activeServerId);
                const currentScopedMachines = sourceServerId
                    ? state.machineListByServerId[sourceServerId]
                    : null;
                const normalizedMachines = machines.map((machine) => preserveNewestMachinePresence(machine, [
                    Array.isArray(currentScopedMachines)
                        ? currentScopedMachines.find((current) => current.id === machine.id)
                        : null,
                    shouldUpdateActiveProjection ? state.machines[machine.id] : null,
                ]));
                const machineListByServerId = sourceServerId
                    ? {
                        ...state.machineListByServerId,
                        [sourceServerId]: mergeMachineListById(
                            currentScopedMachines,
                            normalizedMachines,
                            { replace },
                        ),
                    }
                    : state.machineListByServerId;
                const machineListStatusByServerId = sourceServerId
                    ? (state.machineListStatusByServerId[sourceServerId] === 'idle'
                        ? state.machineListStatusByServerId
                        : { ...state.machineListStatusByServerId, [sourceServerId]: 'idle' as const })
                    : state.machineListStatusByServerId;

                const scopedMachines = sourceServerId ? machineListByServerId[sourceServerId] : null;
                if (!shouldUpdateActiveProjection && sourceServerId && Array.isArray(scopedMachines)) {
                    scheduleMachineListDisplayWarmCacheSave({
                        serverId: sourceServerId,
                        accountId: state.profile.id,
                        machines: scopedMachines,
                    });
                }

                if (!shouldUpdateActiveProjection) {
                    return {
                        ...state,
                        machineListByServerId,
                        machineListStatusByServerId,
                    };
                }

                let mergedMachines: Record<string, Machine>;
                let mergedMachineDisplays: Record<string, MachineDisplayRenderable>;
                const machinesWithAdvancedDaemonState = new Set<string>();

                if (replace) {
                    mergedMachines = {};
                    mergedMachineDisplays = {};
                    normalizedMachines.forEach((machine) => {
                        const previousMachine = state.machines[machine.id];
                        if (hasMachineDaemonStateAdvanced(previousMachine, machine)) {
                            machinesWithAdvancedDaemonState.add(machine.id);
                        }
                        mergedMachines[machine.id] = machine;
                        mergedMachineDisplays[machine.id] = buildMachineDisplayRenderableFromMachine(machine);
                    });
                } else {
                    mergedMachines = state.machines;
                    mergedMachineDisplays = state.machineDisplayById;
                    normalizedMachines.forEach((machine) => {
                        const previousMachine = state.machines[machine.id];
                        if (hasMachineDaemonStateAdvanced(previousMachine, machine)) {
                            machinesWithAdvancedDaemonState.add(machine.id);
                        }
                        if (!areStoredMachinesEqual(previousMachine, machine)) {
                            if (mergedMachines === state.machines) {
                                mergedMachines = { ...state.machines };
                            }
                            mergedMachines[machine.id] = machine;
                        }
                        const nextDisplay = buildMachineDisplayRenderableFromMachine(machine);
                        const previousDisplay = state.machineDisplayById[machine.id];
                        if (!areMachineDisplayRenderablesEqual(previousDisplay, nextDisplay)) {
                            if (mergedMachineDisplays === state.machineDisplayById) {
                                mergedMachineDisplays = { ...state.machineDisplayById };
                            }
                            mergedMachineDisplays[machine.id] = nextDisplay;
                        }
                    });
                }

                if (
                    mergedMachines === state.machines
                    && mergedMachineDisplays === state.machineDisplayById
                    && machineListByServerId === state.machineListByServerId
                    && machineListStatusByServerId === state.machineListStatusByServerId
                ) {
                    return state;
                }

                const previousIndexByServerId = state.sessionListIndexByServerId ?? {};
                const previousActiveIndex = activeServerId ? (previousIndexByServerId[activeServerId] ?? null) : null;
                let needsSessionListIndexRebuild = Boolean(activeServerId) && previousActiveIndex == null;
                let needsProjectManagerUpdate = false;

                if (!needsSessionListIndexRebuild) {
                    const machineImpact = resolveMachineSessionListIndexImpact({
                        sessions: Object.values(state.sessionListRenderables ?? {}),
                        previousMachineDisplays: state.machineDisplayById ?? {},
                        nextMachineDisplays: mergedMachineDisplays,
                        usesProjectGrouping: usesProjectGroupingInSessionList({
                            groupInactiveSessionsByProject: state.settings.groupInactiveSessionsByProject === true,
                            activeGroupingV1: state.settings.sessionListActiveGroupingV1,
                            inactiveGroupingV1: state.settings.sessionListInactiveGroupingV1,
                            sectionModeV1: state.settings.sessionListSectionModeV1,
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
                        sessions: state.sessionListRenderables,
                        sessionRecords: state.sessions,
                        machines: mergedMachineDisplays,
                        machineRecords: mergedMachines,
                        groupInactiveSessionsByProject: state.settings.groupInactiveSessionsByProject === true,
                        activeGroupingV1: state.settings.sessionListActiveGroupingV1,
                        inactiveGroupingV1: state.settings.sessionListInactiveGroupingV1,
                        sectionModeV1: state.settings.sessionListSectionModeV1,
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
                        // A replaced or restarted daemon is a different
                        // projection endpoint, and this is the one place that
                        // observes that transition. Advancing the incumbent
                        // projection revision is what makes every projection
                        // consumer re-describe and what lets an in-flight
                        // response recognise that it answered for the previous
                        // endpoint.
                        publishMachineContributionRegistryProjectionInvalidation({
                            serverId,
                            machineId,
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
                    machineListStatusByServerId,
                };
                if (mergedMachineDisplays !== state.machineDisplayById) {
                    scheduleActiveWarmMachineCacheSave(nextState as MachinesDomain & MachinesDomainDependencies);
                }
                return nextState;
            }),
        replaceMachineDisplays: (machines, options) =>
            set((state) => {
                const activeServerId = normalizeMachineServerId(getActiveServerSnapshot().serverId);
                const sourceServerId = normalizeMachineServerId(options?.sourceServerId) || activeServerId;
                if (sourceServerId && !areServerProfileIdentifiersEquivalent(sourceServerId, activeServerId)) {
                    return state;
                }

                const nextMachineDisplays = Object.fromEntries(machines.map((machine) => [
                    machine.id,
                    preserveNewestMachinePresence(machine, [
                        state.machineDisplayById[machine.id],
                        state.machines[machine.id],
                    ]),
                ]));
                const previousIndexByServerId = state.sessionListIndexByServerId ?? {};
                const previousActiveIndex = activeServerId ? (previousIndexByServerId[activeServerId] ?? null) : null;
                const nextSessionListIndex = activeServerId
                    ? buildActiveServerSessionListIndex({
                        sessions: state.sessionListRenderables,
                        sessionRecords: state.sessions,
                        machines: nextMachineDisplays,
                        machineRecords: state.machines,
                        groupInactiveSessionsByProject: state.settings.groupInactiveSessionsByProject === true,
                        activeGroupingV1: state.settings.sessionListActiveGroupingV1,
                        inactiveGroupingV1: state.settings.sessionListInactiveGroupingV1,
                        sectionModeV1: state.settings.sessionListSectionModeV1,
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
