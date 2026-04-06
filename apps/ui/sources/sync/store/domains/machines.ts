import type { Machine, Session } from '../../domains/state/storageTypes';
import {
    buildMachineDisplayRenderableFromMachine,
    type MachineDisplayRenderable,
} from '../../domains/machines/machineDisplayRenderable';
import type { Settings } from '../../domains/settings/settings';
import type { SessionListViewItem } from '../../domains/session/listing/sessionListViewData';
import type { SessionListRenderableSession } from '../../domains/session/listing/sessionListRenderable';
import type { ServerScopedSessionListCache } from '../../domains/session/listing/serverScopedSessionListCache';
import { resolveMachineSessionListViewDataImpact } from './machineSessionListViewDataImpact';
import { normalizeNonEmptyString } from '@/utils/strings/normalizeNonEmptyString';
import { resolveActiveServerSessionListState } from '../resolveActiveServerSessionListState';
import { getActiveServerSnapshot } from '../../domains/server/serverRuntime';
import { projectManager } from '../../runtime/orchestration/projectManager';
import { invalidateCachedTransferRoutesForMachine } from '../../domains/transfers/runtime/transferRouteCache';
import {
    resolveWarmCacheAccountScope,
    type MachineDisplayCacheEntryV1,
    saveMachineDisplayWarmCacheEntries,
} from '../../domains/state/warmCachePersistence';
import { buildMachineDisplayCacheEntriesFromRenderables } from '../../domains/state/warmCacheAdapters';

import type { StoreGet, StoreSet } from './_shared';

export { resolveMachineSessionListViewDataImpact } from './machineSessionListViewDataImpact';

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
    getProjectForSession?: (sessionId: string) => { key?: { machineId?: string | null; rootPath?: string | null } | null } | null;
    profile: { id: string };
    settings: Settings;
    sessionListViewData: SessionListViewItem[] | null;
    sessionListViewDataByServerId: ServerScopedSessionListCache;
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
        applyMachines: (machines, replace = false) =>
            set((state) => {
                let mergedMachines: Record<string, Machine>;
                let mergedMachineDisplays: Record<string, MachineDisplayRenderable>;
                const machinesWithAdvancedDaemonState = new Set<string>();

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
                        const previousMachine = state.machines[machine.id];
                        if (
                            typeof machine.daemonStateVersion === 'number'
                            && machine.daemonStateVersion > (previousMachine?.daemonStateVersion ?? 0)
                        ) {
                            machinesWithAdvancedDaemonState.add(machine.id);
                        }
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
                    const machineImpact = resolveMachineSessionListViewDataImpact({
                        sessions: Object.values(state.sessionListRenderables ?? {}),
                        previousMachineDisplays: state.machineDisplayById ?? {},
                        nextMachineDisplays: mergedMachineDisplays,
                        usesProjectGrouping,
                    });
                    if (machineImpact.needsSessionListViewDataRebuild) {
                        needsSessionListViewDataRebuild = true;
                    }
                    if (machineImpact.needsProjectManagerUpdate) {
                        needsProjectManagerUpdate = true;
                    }
                }

                const rebuiltListState = resolveActiveServerSessionListState({
                    state: {
                        ...state,
                        machines: mergedMachines,
                        machineDisplayById: mergedMachineDisplays,
                    },
                    shouldRebuild: needsSessionListViewDataRebuild,
                });

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
                for (const machineId of machinesWithAdvancedDaemonState) {
                    const serverIds = resolveServerIdsForMachineTransferRouteInvalidation(state, machineId, activeServerId);
                    for (const serverId of serverIds) {
                        invalidateCachedTransferRoutesForMachine({
                            serverId,
                            remoteMachineId: machineId,
                        });
                    }
                }
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
                    sessionListViewData: rebuiltListState.sessionListViewData,
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
                const rebuiltListState = resolveActiveServerSessionListState({
                    state: {
                        ...state,
                        machineDisplayById: nextMachineDisplays,
                    },
                    shouldRebuild: true,
                });
                const nextState = {
                    ...state,
                    machineDisplayById: nextMachineDisplays,
                    sessionListViewData: rebuiltListState.sessionListViewData,
                };
                saveWarmMachineCacheForState(nextState as MachinesDomain & MachinesDomainDependencies, previousEntries);
                return nextState;
            }),
    };
}
