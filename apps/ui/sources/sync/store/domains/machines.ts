import type { Machine, Session } from '../../domains/state/storageTypes';
import {
    buildMachineDisplayRenderableFromMachine,
    getMachineDisplaySubtitle,
    type MachineDisplayRenderable,
} from '../../domains/machines/machineDisplayRenderable';
import type { Settings } from '../../domains/settings/settings';
import type { SessionListViewItem } from '../../domains/session/listing/sessionListViewData';
import type { SessionListRenderableSession } from '../../domains/session/listing/sessionListRenderable';
import {
    applyReachableTargetsToSessionListRenderables,
    buildSessionListViewDataWithServerScope,
} from '../buildSessionListViewDataWithServerScope';
import { setActiveServerSessionListCache } from '../sessionListCache';
import { getActiveServerSnapshot } from '../../domains/server/serverRuntime';
import { projectManager } from '../../runtime/orchestration/projectManager';
import {
    resolveWarmCacheAccountScope,
    type MachineDisplayCacheEntryV1,
    saveMachineDisplayWarmCacheEntries,
} from '../../domains/state/warmCachePersistence';
import { buildMachineDisplayCacheEntriesFromRenderables } from '../../domains/state/warmCacheAdapters';

import type { StoreGet, StoreSet } from './_shared';

export type MachinesDomain = {
    machines: Record<string, Machine>;
    machineDisplayById: Record<string, MachineDisplayRenderable>;
    machineListByServerId: Record<string, Machine[] | null>;
    machineListStatusByServerId: Record<string, 'idle' | 'loading' | 'signedOut' | 'error'>;
    applyMachines: (machines: Machine[], replace?: boolean) => void;
    replaceMachineDisplays: (machines: MachineDisplayRenderable[]) => void;
};

type MachinesDomainDependencies = Readonly<{
    sessions: Record<string, Session>;
    sessionListRenderables: Record<string, SessionListRenderableSession>;
    getProjectForSession?: (sessionId: string) => { key?: { machineId?: string | null; path?: string | null } | null } | null;
    profile: { id: string };
    settings: Settings;
    sessionListViewData: SessionListViewItem[] | null;
    sessionListViewDataByServerId: Record<string, SessionListViewItem[] | null>;
}>;

function resolveGroupingForSection(
    section: 'active' | 'inactive',
    settings: Settings,
): 'project' | 'date' {
    if (section === 'active') {
        return settings.sessionListActiveGroupingV1 ?? 'project';
    }
    if (settings.sessionListInactiveGroupingV1) return settings.sessionListInactiveGroupingV1;
    return settings.groupInactiveSessionsByProject ? 'project' : 'date';
}

function saveWarmMachineCacheForState(
    state: MachinesDomain & MachinesDomainDependencies,
    previousEntries?: Record<string, MachineDisplayCacheEntryV1>,
): void {
    const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
    const accountId = resolveWarmCacheAccountScope(state.profile?.id);
    if (!activeServerId || !accountId) return;
    saveMachineDisplayWarmCacheEntries(
        activeServerId,
        accountId,
        buildMachineDisplayCacheEntriesFromRenderables(state.machineDisplayById ?? {}, previousEntries),
    );
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
    return Array.from(mergedById.values());
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
        applyMachines: (machines, replace = false) =>
            set((state) => {
                let mergedMachines: Record<string, Machine>;
                let mergedMachineDisplays: Record<string, MachineDisplayRenderable>;

                if (replace) {
                    mergedMachines = {};
                    mergedMachineDisplays = {};
                    machines.forEach((machine) => {
                        mergedMachines[machine.id] = machine;
                        mergedMachineDisplays[machine.id] = buildMachineDisplayRenderableFromMachine(machine);
                    });
                } else {
                    mergedMachines = { ...state.machines };
                    mergedMachineDisplays = { ...state.machineDisplayById };
                    machines.forEach((machine) => {
                        mergedMachines[machine.id] = machine;
                        mergedMachineDisplays[machine.id] = buildMachineDisplayRenderableFromMachine(machine);
                    });
                }

                let needsSessionListViewDataRebuild = state.sessionListViewData === null;
                let needsProjectManagerUpdate = false;

                if (!needsSessionListViewDataRebuild) {
                    const activeGrouping = resolveGroupingForSection('active', state.settings);
                    const inactiveGrouping = resolveGroupingForSection('inactive', state.settings);
                    const usesProjectGrouping = activeGrouping === 'project' || inactiveGrouping === 'project';

                    if (usesProjectGrouping) {
                        const reachableRenderables = applyReachableTargetsToSessionListRenderables({
                            sessions: state.sessionListRenderables ?? {},
                            sessionRecords: state.sessions ?? {},
                            machines: mergedMachineDisplays,
                            machineRecords: mergedMachines,
                            getProjectForSession: state.getProjectForSession ?? undefined,
                        });
                        const referencedMachineIds = new Set<string>();
                        for (const session of Object.values(reachableRenderables)) {
                            const path = String(session.metadata?.path ?? '').trim();
                            if (!path) continue;
                            const machineId = String(session.metadata?.machineId ?? '').trim() || 'unknown';
                            referencedMachineIds.add(machineId);
                        }

                        for (const machineId of referencedMachineIds) {
                            const prev = state.machineDisplayById[machineId];
                            const next = mergedMachineDisplays[machineId];
                            const prevSubtitle = getMachineDisplaySubtitle(prev, machineId);
                            const nextSubtitle = getMachineDisplaySubtitle(next, machineId);
                            if (prevSubtitle !== nextSubtitle) {
                                needsSessionListViewDataRebuild = true;
                                needsProjectManagerUpdate = true;
                                break;
                            }
                        }
                    }
                }

                const sessionListViewData = needsSessionListViewDataRebuild
                    ? buildSessionListViewDataWithServerScope({
                        sessions: state.sessionListRenderables ?? {},
                        sessionRecords: state.sessions ?? {},
                        machines: mergedMachineDisplays,
                        machineRecords: mergedMachines,
                        groupInactiveSessionsByProject: state.settings.groupInactiveSessionsByProject,
                        activeGroupingV1: state.settings.sessionListActiveGroupingV1,
                        inactiveGroupingV1: state.settings.sessionListInactiveGroupingV1,
                        getProjectForSession: state.getProjectForSession ?? undefined,
                    })
                    : state.sessionListViewData;

                if (needsProjectManagerUpdate) {
                    const machineMetadataMap = new Map<string, any>();
                    Object.values(mergedMachines).forEach((machine) => {
                        if (machine.metadata) {
                            machineMetadataMap.set(machine.id, machine.metadata);
                        }
                    });
                    projectManager.updateSessions(Object.values(state.sessions), machineMetadataMap);
                }

                const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
                const nextActiveServerMachines = activeServerId
                    ? mergeMachineListById(
                        state.machineListByServerId[activeServerId],
                        machines,
                        { replace },
                    )
                    : null;
                const nextState = {
                    ...state,
                    machines: mergedMachines,
                    machineDisplayById: mergedMachineDisplays,
                    sessionListViewData,
                    sessionListViewDataByServerId: needsSessionListViewDataRebuild && sessionListViewData
                        ? setActiveServerSessionListCache(
                            state.sessionListViewDataByServerId,
                            sessionListViewData,
                        )
                        : state.sessionListViewDataByServerId,
                    machineListByServerId: activeServerId
                        ? { ...state.machineListByServerId, [activeServerId]: nextActiveServerMachines }
                        : state.machineListByServerId,
                    machineListStatusByServerId: activeServerId
                        ? { ...state.machineListStatusByServerId, [activeServerId]: 'idle' }
                        : state.machineListStatusByServerId,
                };
                saveWarmMachineCacheForState(nextState as MachinesDomain & MachinesDomainDependencies);
                return nextState;
            }),
        replaceMachineDisplays: (machines) =>
            set((state) => {
                const nextMachineDisplays = Object.fromEntries(machines.map((machine) => [machine.id, machine]));
                const previousEntries = buildMachineDisplayCacheEntriesFromRenderables(state.machineDisplayById ?? {});
                const sessionListViewData = buildSessionListViewDataWithServerScope({
                    sessions: state.sessionListRenderables ?? {},
                    machines: nextMachineDisplays,
                    groupInactiveSessionsByProject: state.settings.groupInactiveSessionsByProject,
                    activeGroupingV1: state.settings.sessionListActiveGroupingV1,
                    inactiveGroupingV1: state.settings.sessionListInactiveGroupingV1,
                });
                const nextState = {
                    ...state,
                    machineDisplayById: nextMachineDisplays,
                    sessionListViewData,
                    sessionListViewDataByServerId: setActiveServerSessionListCache(
                        state.sessionListViewDataByServerId,
                        sessionListViewData,
                    ),
                };
                saveWarmMachineCacheForState(nextState as MachinesDomain & MachinesDomainDependencies, previousEntries);
                return nextState;
            }),
    };
}
