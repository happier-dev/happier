import type { Machine, Session } from '../../domains/state/storageTypes';
import type { Settings } from '../../domains/settings/settings';
import type { SessionListViewItem } from '../../domains/session/listing/sessionListViewData';
import { buildSessionListViewDataWithServerScope } from '../buildSessionListViewDataWithServerScope';
import { setActiveServerSessionListCache } from '../sessionListCache';
import { getActiveServerSnapshot } from '../../domains/server/serverRuntime';
import { projectManager } from '../../runtime/orchestration/projectManager';

import type { StoreGet, StoreSet } from './_shared';

export type MachinesDomain = {
    machines: Record<string, Machine>;
    machineListByServerId: Record<string, Machine[] | null>;
    machineListStatusByServerId: Record<string, 'idle' | 'loading' | 'signedOut' | 'error'>;
    applyMachines: (machines: Machine[], replace?: boolean) => void;
};

type MachinesDomainDependencies = Readonly<{
    sessions: Record<string, Session>;
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

function getMachineProjectHeaderSubtitle(machine: Machine | undefined, machineId: string): string {
    const meta: any = machine?.metadata ?? null;
    const displayName = typeof meta?.displayName === 'string' ? meta.displayName.trim() : '';
    if (displayName) return displayName;
    const host = typeof meta?.host === 'string' ? meta.host.trim() : '';
    if (host) return host;
    return machine?.id ?? machineId;
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
        machineListByServerId: {},
        machineListStatusByServerId: {},
        applyMachines: (machines, replace = false) =>
            set((state) => {
                let mergedMachines: Record<string, Machine>;

                if (replace) {
                    mergedMachines = {};
                    machines.forEach((machine) => {
                        mergedMachines[machine.id] = machine;
                    });
                } else {
                    mergedMachines = { ...state.machines };
                    machines.forEach((machine) => {
                        mergedMachines[machine.id] = machine;
                    });
                }

                let needsSessionListViewDataRebuild = state.sessionListViewData === null;
                let needsProjectManagerUpdate = false;

                if (!needsSessionListViewDataRebuild) {
                    const activeGrouping = resolveGroupingForSection('active', state.settings);
                    const inactiveGrouping = resolveGroupingForSection('inactive', state.settings);
                    const usesProjectGrouping = activeGrouping === 'project' || inactiveGrouping === 'project';

                    if (usesProjectGrouping) {
                        const referencedMachineIds = new Set<string>();
                        for (const session of Object.values(state.sessions)) {
                            const path = String(session.metadata?.path ?? '').trim();
                            if (!path) continue;
                            const machineId = String(session.metadata?.machineId ?? '').trim() || 'unknown';
                            referencedMachineIds.add(machineId);
                        }

                        for (const machineId of referencedMachineIds) {
                            const prev = state.machines[machineId];
                            const next = mergedMachines[machineId];
                            const prevSubtitle = getMachineProjectHeaderSubtitle(prev, machineId);
                            const nextSubtitle = getMachineProjectHeaderSubtitle(next, machineId);
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
                        sessions: state.sessions,
                        machines: mergedMachines,
                        groupInactiveSessionsByProject: state.settings.groupInactiveSessionsByProject,
                        activeGroupingV1: state.settings.sessionListActiveGroupingV1,
                        inactiveGroupingV1: state.settings.sessionListInactiveGroupingV1,
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
                return {
                    ...state,
                    machines: mergedMachines,
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
            }),
    };
}
