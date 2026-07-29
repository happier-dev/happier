import type { Machine, Session } from '../../domains/state/storageTypes';
import {
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
import { areServerProfileIdentifiersEquivalent } from '../../domains/server/serverProfiles';
import { projectManager } from '../../runtime/orchestration/projectManager';
import { invalidateCachedTransferRoutesForMachine } from '../../domains/transfers/runtime/transferRouteCache';
import {
    resolveWarmCacheAccountScope,
    type MachineDisplayCacheEntryV1,
    saveMachineDisplayWarmCacheEntries,
} from '../../domains/state/warmCachePersistence';
import { buildMachineDisplayCacheEntriesFromRenderables } from '../../domains/state/warmCacheAdapters';
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

let pendingWarmMachineCacheSave: {
    activeServerId: string;
    accountId: string;
    entries: Record<string, MachineDisplayCacheEntryV1>;
} | null = null;
let pendingWarmMachineCacheSaveTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleWarmMachineCacheSave(
    state: MachinesDomain & MachinesDomainDependencies,
    previousEntries?: Record<string, MachineDisplayCacheEntryV1>,
): void {
    const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
    const accountId = resolveWarmCacheAccountScope(state.profile?.id);
    if (!activeServerId || !accountId) return;
    pendingWarmMachineCacheSave = {
        activeServerId,
        accountId,
        entries: buildMachineDisplayCacheEntriesFromRenderables(state.machineDisplayById ?? {}, previousEntries),
    };
    if (pendingWarmMachineCacheSaveTimer) return;
    pendingWarmMachineCacheSaveTimer = setTimeout(() => {
        pendingWarmMachineCacheSaveTimer = null;
        const pending = pendingWarmMachineCacheSave;
        pendingWarmMachineCacheSave = null;
        if (!pending) return;
        saveMachineDisplayWarmCacheEntries(pending.activeServerId, pending.accountId, pending.entries);
    }, 0);
}

function areMachineDisplaysEqual(
    previous: MachineDisplayRenderable | null | undefined,
    next: MachineDisplayRenderable | null | undefined,
): boolean {
    if (previous === next) return true;
    if (!previous || !next) return previous === next;
    return previous.id === next.id
        && previous.updatedAt === next.updatedAt
        && previous.active === next.active
        && previous.activeAt === next.activeAt
        && (previous.revokedAt ?? null) === (next.revokedAt ?? null)
        && previous.metadataVersion === next.metadataVersion
        && (previous.replacedByMachineId ?? null) === (next.replacedByMachineId ?? null)
        && (previous.replacedAt ?? null) === (next.replacedAt ?? null)
        && (previous.replacementReason ?? null) === (next.replacementReason ?? null)
        && (previous.replacementSource ?? null) === (next.replacementSource ?? null)
        && (previous.replacementActorUserId ?? null) === (next.replacementActorUserId ?? null)
        && areSessionValuesDeepEqual(previous.metadata ?? null, next.metadata ?? null);
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
                const machineListByServerId = sourceServerId
                    ? {
                        ...state.machineListByServerId,
                        [sourceServerId]: mergeMachineListById(
                            state.machineListByServerId[sourceServerId],
                            machines,
                            { replace },
                        ),
                    }
                    : state.machineListByServerId;
                const machineListStatusByServerId = sourceServerId
                    ? (state.machineListStatusByServerId[sourceServerId] === 'idle'
                        ? state.machineListStatusByServerId
                        : { ...state.machineListStatusByServerId, [sourceServerId]: 'idle' as const })
                    : state.machineListStatusByServerId;

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
                    machines.forEach((machine) => {
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
                    machines.forEach((machine) => {
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
                        if (!areMachineDisplaysEqual(previousDisplay, nextDisplay)) {
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
                    scheduleWarmMachineCacheSave(nextState as MachinesDomain & MachinesDomainDependencies);
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

                const nextMachineDisplays = Object.fromEntries(machines.map((machine) => [machine.id, machine]));
                const previousEntries = buildMachineDisplayCacheEntriesFromRenderables(state.machineDisplayById ?? {});
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
                scheduleWarmMachineCacheSave(nextState as MachinesDomain & MachinesDomainDependencies, previousEntries);
                return nextState;
            }),
    };
}
