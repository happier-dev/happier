import type { Machine, Session } from '../../domains/state/storageTypes';
import {
    buildMachineDisplayRenderableFromMachine,
    getMachineDisplaySubtitle,
    resolveBestMachineDisplayRenderableForHost,
    type MachineDisplayRenderable,
} from '../../domains/machines/machineDisplayRenderable';
import type { Settings } from '../../domains/settings/settings';
import type { SessionListViewItem } from '../../domains/session/listing/sessionListViewData';
import type { SessionListRenderableSession } from '../../domains/session/listing/sessionListRenderable';
import { resolveSessionProjectGroupingKeyParts } from '../../domains/session/listing/sessionListProjectGroupingKeys';
import { normalizeNonEmptyString } from '@/utils/strings/normalizeNonEmptyString';
import {
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
    applyMachines: (machines: Machine[], replace?: boolean, options?: ApplyMachinesOptions) => void;
    replaceMachineDisplays: (machines: MachineDisplayRenderable[], options?: ApplyMachinesOptions) => void;
};

export type ApplyMachinesOptions = Readonly<{
    sourceServerId?: string | null;
}>;

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

function normalizeMachineServerId(serverId: string | null | undefined): string {
    return String(serverId ?? '').trim();
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
                const shouldUpdateActiveProjection = !sourceServerId || sourceServerId === activeServerId;
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
                    ? { ...state.machineListStatusByServerId, [sourceServerId]: 'idle' as const }
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
                        const referencedGroupIds = new Set<string>();
                        const resolveMachineGroupId = (
                            parts: ReturnType<typeof resolveSessionProjectGroupingKeyParts>,
                            machinesById: Record<string, MachineDisplayRenderable>,
                        ): string => {
                            const machine = parts.machineId ? machinesById[parts.machineId] : undefined;
                            const host = parts.host ?? normalizeNonEmptyString(machine?.metadata?.host);
                            return host ? `host:${host}` : parts.machineId ? `id:${parts.machineId}` : 'unknown';
                        };

                        for (const session of Object.values(state.sessionListRenderables ?? {})) {
                            const parts = resolveSessionProjectGroupingKeyParts(session.metadata ?? null);
                            if (!parts.pathKey) continue;
                            const prevGroupId = resolveMachineGroupId(parts, state.machineDisplayById ?? {});
                            const nextGroupId = resolveMachineGroupId(parts, mergedMachineDisplays);
                            referencedGroupIds.add(prevGroupId);
                            referencedGroupIds.add(nextGroupId);
                            if (prevGroupId !== nextGroupId) {
                                needsSessionListViewDataRebuild = true;
                                needsProjectManagerUpdate = true;
                                break;
                            }
                        }

                        const resolveSubtitleForGroup = (
                            groupId: string,
                            machinesById: Record<string, MachineDisplayRenderable>,
                        ): string => {
                            if (groupId.startsWith('host:')) {
                                const host = groupId.slice('host:'.length);
                                const machine = resolveBestMachineDisplayRenderableForHost(machinesById, host) ?? undefined;
                                return getMachineDisplaySubtitle(machine, host);
                            }
                            if (groupId.startsWith('id:')) {
                                const machineId = groupId.slice('id:'.length);
                                return getMachineDisplaySubtitle(machinesById[machineId], machineId);
                            }
                            return 'unknown';
                        };

                        for (const groupId of referencedGroupIds) {
                            const prevSubtitle = resolveSubtitleForGroup(groupId, state.machineDisplayById ?? {});
                            const nextSubtitle = resolveSubtitleForGroup(groupId, mergedMachineDisplays);
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
                        machines: mergedMachineDisplays,
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
                    machineListByServerId,
                    machineListStatusByServerId,
                };
                saveWarmMachineCacheForState(nextState as MachinesDomain & MachinesDomainDependencies);
                return nextState;
            }),
        replaceMachineDisplays: (machines, options) =>
            set((state) => {
                const activeServerId = normalizeMachineServerId(getActiveServerSnapshot().serverId);
                const sourceServerId = normalizeMachineServerId(options?.sourceServerId) || activeServerId;
                if (sourceServerId && sourceServerId !== activeServerId) {
                    return state;
                }

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
