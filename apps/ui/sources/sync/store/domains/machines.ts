import type { Machine, Session } from '../../domains/state/storageTypes';
import {
    buildMachineDisplayRenderableFromMachine,
    getMachineDisplaySubtitle,
    type MachineDisplayRenderable,
} from '../../domains/machines/machineDisplayRenderable';
import { resolveCanonicalMachineId } from '../../domains/machines/identity/resolveCanonicalMachineId';
import type { Settings } from '../../domains/settings/settings';
import type { SessionListViewItem } from '../../domains/session/listing/sessionListViewData';
import type { SessionListRenderableSession } from '../../domains/session/listing/sessionListRenderable';
import { resolveSessionProjectGroupingKeyParts } from '../../domains/session/listing/sessionListProjectGroupingKeys';
import {
    buildSessionListViewDataWithServerScope,
} from '../buildSessionListViewDataWithServerScope';
import { setActiveServerSessionListCache } from '../sessionListCache';
import { getActiveServerSnapshot } from '../../domains/server/serverRuntime';
import { areServerProfileIdentifiersEquivalent } from '../../domains/server/serverProfiles';
import { projectManager } from '../../runtime/orchestration/projectManager';
import {
    readPersistedMachineDisplayWarmCacheEntries,
    resolveWarmCacheAccountScope,
    saveMachineDisplayWarmCacheEntries,
} from '../../domains/state/warmCachePersistence';
import { buildMachineDisplayCacheEntriesFromRenderables } from '../../domains/state/warmCacheAdapters';
import { syncPerformanceTelemetry } from '../../runtime/syncPerformanceTelemetry';

import type { StoreGet, StoreSet } from './_shared';
import {
    createWarmCacheSaveScheduler,
    WARM_CACHE_PROGRESS_SAVE_DEBOUNCE_MS,
} from './warmCacheSaveScheduler';

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

function resolveMachineGroupId(
    parts: ReturnType<typeof resolveSessionProjectGroupingKeyParts>,
    machinesById: Record<string, MachineDisplayRenderable>,
): string {
    if (!parts.machineId) return 'unknown';
    // Called once per renderable session by `collectReferencedProjectMachineGroupIds`; the record
    // is already the id index the resolution needs, so it is passed through rather than flattened.
    const canonical = resolveCanonicalMachineId(parts.machineId, machinesById);
    const machineId = canonical?.reason === 'missingReplacementTarget'
        ? parts.machineId
        : canonical?.machineId ?? parts.machineId;
    return machineId ? `id:${machineId}` : 'unknown';
}

function isKnownMachineGroupId(
    groupId: string,
    machinesById: Record<string, MachineDisplayRenderable>,
): boolean {
    if (!groupId.startsWith('id:')) return false;
    return Boolean(machinesById[groupId.slice('id:'.length)]);
}

function collectReferencedProjectMachineGroupIds(
    sessions: Record<string, SessionListRenderableSession>,
    machinesById: Record<string, MachineDisplayRenderable>,
): Set<string> {
    const groupIds = new Set<string>();
    const knownGroupIdsByPath = new Map<string, Set<string>>();
    const usages: Array<Readonly<{ groupId: string; pathKey: string; known: boolean }>> = [];

    for (const session of Object.values(sessions ?? {})) {
        const parts = resolveSessionProjectGroupingKeyParts(session.metadata ?? null);
        if (!parts.pathKey) continue;
        const groupId = resolveMachineGroupId(parts, machinesById);
        const known = isKnownMachineGroupId(groupId, machinesById);
        groupIds.add(groupId);
        usages.push({ groupId, pathKey: parts.pathKey, known });
        if (!known) continue;
        const bucket = knownGroupIdsByPath.get(parts.pathKey) ?? new Set<string>();
        bucket.add(groupId);
        knownGroupIdsByPath.set(parts.pathKey, bucket);
    }

    for (const usage of usages) {
        if (usage.known) continue;
        const candidates = knownGroupIdsByPath.get(usage.pathKey);
        if (!candidates || candidates.size !== 1) continue;
        groupIds.add(Array.from(candidates)[0]);
    }

    return groupIds;
}

function areStringSetsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
    if (left.size !== right.size) return false;
    for (const value of left) {
        if (!right.has(value)) return false;
    }
    return true;
}

function countOwnEntries(record: Record<string, unknown> | null | undefined): number {
    return record ? Object.keys(record).length : 0;
}

function areMachineDisplayMetadataEqual(
    left: MachineDisplayRenderable['metadata'],
    right: MachineDisplayRenderable['metadata'],
): boolean {
    if (left === right) return true;
    if (!left || !right) return left == null && right == null;
    return (left.displayName ?? null) === (right.displayName ?? null)
        && (left.host ?? null) === (right.host ?? null)
        && (left.homeDir ?? null) === (right.homeDir ?? null);
}

function areMachineDisplaysEqual(
    left: MachineDisplayRenderable | undefined,
    right: MachineDisplayRenderable | undefined,
): boolean {
    if (left === right) return true;
    if (!left || !right) return false;
    return left.id === right.id
        && left.updatedAt === right.updatedAt
        && left.active === right.active
        && left.activeAt === right.activeAt
        && (left.revokedAt ?? null) === (right.revokedAt ?? null)
        && (left.replacedByMachineId ?? null) === (right.replacedByMachineId ?? null)
        && (left.replacedAt ?? null) === (right.replacedAt ?? null)
        && (left.replacementReason ?? null) === (right.replacementReason ?? null)
        && (left.replacementSource ?? null) === (right.replacementSource ?? null)
        && (left.replacementActorUserId ?? null) === (right.replacementActorUserId ?? null)
        && left.metadataVersion === right.metadataVersion
        && areMachineDisplayMetadataEqual(left.metadata, right.metadata);
}

function areMachinesEqual(left: Machine | undefined, right: Machine | undefined): boolean {
    if (left === right) return true;
    if (!left || !right) return false;
    return left.id === right.id
        && left.seq === right.seq
        && left.createdAt === right.createdAt
        && left.updatedAt === right.updatedAt
        && left.active === right.active
        && left.activeAt === right.activeAt
        && (left.revokedAt ?? null) === (right.revokedAt ?? null)
        && (left.replacedByMachineId ?? null) === (right.replacedByMachineId ?? null)
        && (left.replacedAt ?? null) === (right.replacedAt ?? null)
        && (left.replacementReason ?? null) === (right.replacementReason ?? null)
        && (left.replacementSource ?? null) === (right.replacementSource ?? null)
        && (left.replacementActorUserId ?? null) === (right.replacementActorUserId ?? null)
        && left.metadataVersion === right.metadataVersion
        && left.metadata === right.metadata
        && left.daemonStateVersion === right.daemonStateVersion
        && left.daemonState === right.daemonState;
}

function areMachineArraysEqual(left: readonly Machine[], right: readonly Machine[]): boolean {
    if (left === right) return true;
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
        if (!areMachinesEqual(left[index], right[index])) return false;
    }
    return true;
}

function areMachineDisplayRecordsEqual(
    left: Record<string, MachineDisplayRenderable>,
    right: Record<string, MachineDisplayRenderable>,
): boolean {
    const leftCount = countOwnEntries(left);
    const rightCount = countOwnEntries(right);
    if (leftCount !== rightCount) return false;
    for (const machineId in left) {
        if (
            Object.prototype.hasOwnProperty.call(left, machineId)
            && !areMachineDisplaysEqual(left[machineId], right[machineId])
        ) {
            return false;
        }
    }
    return true;
}

function resolveProjectMachineGroupSubtitle(
    groupId: string,
    machinesById: Record<string, MachineDisplayRenderable>,
): string {
    if (groupId.startsWith('id:')) {
        const machineId = groupId.slice('id:'.length);
        return getMachineDisplaySubtitle(machinesById[machineId], machineId);
    }
    return 'unknown';
}

/**
 * Diffs against what the warm-cache key is known to hold rather than against a
 * reconstruction of the previous renderables. Boot hydration therefore produces the
 * record that is already on disk and writes nothing, and steady-state saves skip both
 * the serialization and the storage write when nothing the cache keeps has changed.
 */
function saveWarmMachineCacheForState(
    state: MachinesDomain & MachinesDomainDependencies,
): void {
    const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
    const accountId = resolveWarmCacheAccountScope(state.profile?.id);
    if (!activeServerId || !accountId) return;
    const previousEntries = readPersistedMachineDisplayWarmCacheEntries(activeServerId, accountId);
    const nextEntries = buildMachineDisplayCacheEntriesFromRenderables(state.machineDisplayById ?? {}, previousEntries);
    if (previousEntries && nextEntries === previousEntries) return;
    saveMachineDisplayWarmCacheEntries(activeServerId, accountId, nextEntries);
}

function mergeMachineListById(
    current: Machine[] | null | undefined,
    incoming: Machine[],
    options: Readonly<{ replace: boolean }>,
): Machine[] {
    if (options.replace) {
        const next = incoming.slice();
        return current && areMachineArraysEqual(current, next) ? current : next;
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
    const next = Array.from(mergedById.values());
    return current && areMachineArraysEqual(current, next) ? current : next;
}

function normalizeMachineServerId(serverId: string | null | undefined): string {
    return String(serverId ?? '').trim();
}

export function createMachinesDomain<S extends MachinesDomain & MachinesDomainDependencies>({
    set,
    get,
}: {
    set: StoreSet<S>;
    get: StoreGet<S>;
}): MachinesDomain {
    let warmCacheSaveScheduler: ReturnType<typeof createWarmCacheSaveScheduler<
        MachinesDomain & MachinesDomainDependencies
    >> | null = null;
    const getWarmCacheSaveScheduler = () => {
        if (!warmCacheSaveScheduler) {
            warmCacheSaveScheduler = createWarmCacheSaveScheduler<
                MachinesDomain & MachinesDomainDependencies
            >({
                get,
                save: saveWarmMachineCacheForState,
                delayMs: WARM_CACHE_PROGRESS_SAVE_DEBOUNCE_MS,
                onSchedule: ({ state, coalesced }) => {
                    syncPerformanceTelemetry.countLazy('sync.store.machines.warmCache.schedule', () => ({
                        coalesced: coalesced ? 1 : 0,
                        renderables: Object.keys(state.machineDisplayById ?? {}).length,
                        scheduled: coalesced ? 0 : 1,
                    }));
                },
                onFlush: (currentState, flush) => {
                    syncPerformanceTelemetry.measure(
                        'sync.store.machines.warmCache.flush',
                        { renderables: Object.keys(currentState.machineDisplayById ?? {}).length },
                        flush,
                    );
                },
            });
        }
        return warmCacheSaveScheduler;
    };
    const scheduleWarmMachineCacheSave = (state: MachinesDomain & MachinesDomainDependencies): void => {
        getWarmCacheSaveScheduler().schedule(state);
    };

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
                const currentServerMachineList = sourceServerId
                    ? state.machineListByServerId[sourceServerId]
                    : undefined;
                const nextServerMachineList = sourceServerId
                    ? mergeMachineListById(currentServerMachineList, machines, { replace })
                    : currentServerMachineList;
                const machineListByServerId = sourceServerId && nextServerMachineList !== currentServerMachineList
                    ? {
                        ...state.machineListByServerId,
                        [sourceServerId]: nextServerMachineList,
                    }
                    : state.machineListByServerId;
                const currentServerMachineListStatus = sourceServerId
                    ? state.machineListStatusByServerId[sourceServerId]
                    : undefined;
                const machineListStatusByServerId = sourceServerId && currentServerMachineListStatus !== 'idle'
                    ? { ...state.machineListStatusByServerId, [sourceServerId]: 'idle' as const }
                    : state.machineListStatusByServerId;
                const didScopedMachineListChange = machineListByServerId !== state.machineListByServerId
                    || machineListStatusByServerId !== state.machineListStatusByServerId;

                if (!shouldUpdateActiveProjection) {
                    return didScopedMachineListChange ? {
                        ...state,
                        machineListByServerId,
                        machineListStatusByServerId,
                    } : state;
                }

                let mergedMachines: Record<string, Machine>;
                let mergedMachineDisplays: Record<string, MachineDisplayRenderable>;

                if (replace) {
                    const nextMachines: Record<string, Machine> = {};
                    const nextMachineDisplays: Record<string, MachineDisplayRenderable> = {};
                    machines.forEach((machine) => {
                        nextMachines[machine.id] = machine;
                        nextMachineDisplays[machine.id] = buildMachineDisplayRenderableFromMachine(machine);
                    });
                    const machinesAreUnchanged = countOwnEntries(state.machines) === machines.length
                        && machines.every((machine) => areMachinesEqual(state.machines[machine.id], machine));
                    mergedMachines = machinesAreUnchanged ? state.machines : nextMachines;
                    mergedMachineDisplays = areMachineDisplayRecordsEqual(state.machineDisplayById ?? {}, nextMachineDisplays)
                        ? state.machineDisplayById
                        : nextMachineDisplays;
                } else {
                    mergedMachines = state.machines;
                    mergedMachineDisplays = state.machineDisplayById;
                    machines.forEach((machine) => {
                        if (!areMachinesEqual(state.machines[machine.id], machine)) {
                            if (mergedMachines === state.machines) {
                                mergedMachines = { ...state.machines };
                            }
                            mergedMachines[machine.id] = machine;
                        }

                        const nextDisplay = buildMachineDisplayRenderableFromMachine(machine);
                        if (!areMachineDisplaysEqual(state.machineDisplayById[machine.id], nextDisplay)) {
                            if (mergedMachineDisplays === state.machineDisplayById) {
                                mergedMachineDisplays = { ...state.machineDisplayById };
                            }
                            mergedMachineDisplays[machine.id] = nextDisplay;
                        }
                    });
                }

                const didActiveProjectionChange = mergedMachines !== state.machines
                    || mergedMachineDisplays !== state.machineDisplayById;
                if (!didActiveProjectionChange) {
                    return didScopedMachineListChange ? {
                        ...state,
                        machineListByServerId,
                        machineListStatusByServerId,
                    } : state;
                }

                let needsSessionListViewDataRebuild = state.sessionListViewData === null;
                let needsProjectManagerUpdate = false;

                if (!needsSessionListViewDataRebuild) {
                    const activeGrouping = resolveGroupingForSection('active', state.settings);
                    const inactiveGrouping = resolveGroupingForSection('inactive', state.settings);
                    const usesProjectGrouping = activeGrouping === 'project' || inactiveGrouping === 'project';

                    if (usesProjectGrouping) {
                        const previousGroupIds = collectReferencedProjectMachineGroupIds(
                            state.sessionListRenderables ?? {},
                            state.machineDisplayById ?? {},
                        );
                        const nextGroupIds = collectReferencedProjectMachineGroupIds(
                            state.sessionListRenderables ?? {},
                            mergedMachineDisplays,
                        );

                        if (!areStringSetsEqual(previousGroupIds, nextGroupIds)) {
                            needsSessionListViewDataRebuild = true;
                            needsProjectManagerUpdate = true;
                        }

                        const referencedGroupIds = new Set([...previousGroupIds, ...nextGroupIds]);
                        for (const groupId of referencedGroupIds) {
                            const prevSubtitle = resolveProjectMachineGroupSubtitle(groupId, state.machineDisplayById ?? {});
                            const nextSubtitle = resolveProjectMachineGroupSubtitle(groupId, mergedMachineDisplays);
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
                        sessionRecords: state.sessions,
                        machines: mergedMachineDisplays,
                        machineRecords: mergedMachines,
                        groupInactiveSessionsByProject: state.settings.groupInactiveSessionsByProject,
                        activeGroupingV1: state.settings.sessionListActiveGroupingV1,
                        inactiveGroupingV1: state.settings.sessionListInactiveGroupingV1,
                        sectionModeV1: state.settings.sessionListSectionModeV1,
                        workspacePathDisplayModeV1: state.settings.workspacePathDisplayModeV1,
                        getProjectForSession: state.getProjectForSession,
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
                if (areMachineDisplayRecordsEqual(state.machineDisplayById ?? {}, nextMachineDisplays)) {
                    return state;
                }

                const sessionListViewData = buildSessionListViewDataWithServerScope({
                    sessions: state.sessionListRenderables ?? {},
                    sessionRecords: state.sessions,
                    machines: nextMachineDisplays,
                    machineRecords: state.machines,
                    groupInactiveSessionsByProject: state.settings.groupInactiveSessionsByProject,
                    activeGroupingV1: state.settings.sessionListActiveGroupingV1,
                    inactiveGroupingV1: state.settings.sessionListInactiveGroupingV1,
                    sectionModeV1: state.settings.sessionListSectionModeV1,
                    workspacePathDisplayModeV1: state.settings.workspacePathDisplayModeV1,
                    getProjectForSession: state.getProjectForSession,
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
                scheduleWarmMachineCacheSave(nextState as MachinesDomain & MachinesDomainDependencies);
                return nextState;
            }),
    };
}
