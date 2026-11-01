import type { MachineDisplayRenderable } from '../../domains/machines/machineDisplayRenderable';
import { resolveSessionListCacheServerId } from '../../domains/session/listing/sessionListPresentation';
import {
    resolveSessionListDateGroupingAt,
    type SessionListViewItem,
} from '../../domains/session/listing/sessionListViewData';
import {
    didSessionListRenderableEmbeddedListRowFieldsChange,
    didSessionListRenderableStructuralFieldsChange,
    type SessionListRenderableSession,
} from '../../domains/session/listing/sessionListRenderable';
import {
    normalizeSessionListAttentionPromotionMode,
    normalizeSessionListWorkingPlacementMode,
    type SessionListAttentionPromotionMode,
    type SessionListWorkingPlacementMode,
} from '../../domains/session/listing/attentionPromotion/sessionListAttentionPromotionTypes';
import type { WorkspacePathDisplayModeV1 } from '../../domains/session/listing/sessionWorkspacePresentation';
import type { Machine, Session } from '../../domains/state/storageTypes';
import {
    buildSessionListViewDataWithServerScope,
} from '../buildSessionListViewDataWithServerScope';
import {
    getActiveServerIdForSessionListCache,
    setActiveServerSessionListCache,
    setServerSessionListCache,
} from '../sessionListCache';
import { areServerProfileIdentifiersEquivalent } from '../../domains/server/serverProfiles';

import {
    planSessionListRenderableMerge,
    planSessionListRenderablePatches,
    planSessionListRenderableReplacement,
    resolveSessionListRenderableRemovalWindow,
    type SessionListRenderablePatch,
    type SessionListRenderableStoreUpdatePlan,
} from './sessionListRenderableStoreUpdate';

type SessionListRenderableCommitSettings = Readonly<{
    groupInactiveSessionsByProject?: boolean;
    sessionListActiveGroupingV1?: 'project' | 'date';
    sessionListInactiveGroupingV1?: 'project' | 'date';
    sessionListSectionModeV1?: 'activity' | 'single';
    sessionListAttentionPromotionModeV1?: SessionListAttentionPromotionMode;
    sessionListWorkingPlacementModeV1?: SessionListWorkingPlacementMode;
    workspacePathDisplayModeV1?: WorkspacePathDisplayModeV1 | null;
}>;

type ProjectLookupResult = {
    key?: {
        machineId?: string | null;
        path?: string | null;
    } | null;
} | null;

export type SessionListRenderableCommitState = Readonly<{
    sessions: Record<string, Session>;
    sessionListRenderables: Record<string, SessionListRenderableSession>;
    sessionListRenderableDelta?: SessionListRenderableDelta;
    sessionListViewData: SessionListViewItem[] | null;
    sessionListViewDataByServerId: Record<string, SessionListViewItem[] | null>;
    machines: Record<string, Machine>;
    machineDisplayById: Record<string, MachineDisplayRenderable>;
    settings: SessionListRenderableCommitSettings;
    getProjectForSession?: (sessionId: string) => ProjectLookupResult;
}>;

export type SessionListRenderableDelta = Readonly<{
    revision: number;
    changedSessionIds: readonly string[];
    removedSessionIds: readonly string[];
    rebuiltSessionListViewData: boolean;
}>;

export function buildNextSessionListRenderableDelta(input: Readonly<{
    previous: SessionListRenderableDelta | undefined;
    changedSessionIds: readonly string[];
    removedSessionIds: readonly string[];
    rebuiltSessionListViewData: boolean;
}>): SessionListRenderableDelta {
    return {
        revision: (input.previous?.revision ?? 0) + 1,
        changedSessionIds: input.changedSessionIds,
        removedSessionIds: input.removedSessionIds,
        rebuiltSessionListViewData: input.rebuiltSessionListViewData,
    };
}

type MeasureListRebuild = (compute: () => SessionListViewItem[]) => SessionListViewItem[];

function normalizeTargetServerId(serverId: string | null | undefined): string | null {
    const normalized = String(serverId ?? '').trim();
    return normalized.length > 0 ? normalized : null;
}

function resolveSessionListGroupingForSettings(
    section: 'active' | 'inactive',
    settings: SessionListRenderableCommitSettings,
): 'project' | 'date' {
    if (section === 'active') {
        return settings.sessionListActiveGroupingV1 ?? 'project';
    }
    if (settings.sessionListInactiveGroupingV1) {
        return settings.sessionListInactiveGroupingV1;
    }
    return settings.groupInactiveSessionsByProject === true ? 'project' : 'date';
}

function isSessionListDateGroupingForRenderable(
    session: SessionListRenderableSession,
    settings: SessionListRenderableCommitSettings,
): boolean {
    if (settings.sessionListSectionModeV1 === 'single') {
        return resolveSessionListGroupingForSettings('active', settings) === 'date';
    }
    const section = session.active === true ? 'active' : 'inactive';
    return resolveSessionListGroupingForSettings(section, settings) === 'date';
}

export function didSessionListRenderableListViewFieldsChangeForSettings(
    previous: SessionListRenderableSession | undefined,
    next: SessionListRenderableSession,
    settings: SessionListRenderableCommitSettings,
): boolean {
    if (didSessionListRenderableStructuralFieldsChange(previous, next)) {
        return true;
    }
    if (!previous) {
        return true;
    }
    if (resolveSessionListDateGroupingAt(previous) === resolveSessionListDateGroupingAt(next)) {
        return false;
    }
    return isSessionListDateGroupingForRenderable(previous, settings)
        || isSessionListDateGroupingForRenderable(next, settings);
}

export function refreshSessionListViewDataRowsForRenderables(input: Readonly<{
    sessionListViewData: SessionListViewItem[] | null;
    renderables: Record<string, SessionListRenderableSession>;
    sessionIds: readonly string[];
}>): SessionListViewItem[] | null {
    if (!input.sessionListViewData || input.sessionIds.length === 0) {
        return input.sessionListViewData;
    }
    const ids = new Set(input.sessionIds);
    let changed = false;
    const next = input.sessionListViewData.map((item) => {
        if (item.type !== 'session') return item;
        const sessionId = String(item.session.id ?? '').trim();
        if (!sessionId || !ids.has(sessionId)) return item;
        const renderable = input.renderables[sessionId];
        if (!renderable || renderable === item.session) return item;
        changed = true;
        return {
            ...item,
            session: renderable,
        };
    });
    return changed ? next : input.sessionListViewData;
}

export function shouldRebuildOnSessionPlacementFieldsChange(settings: SessionListRenderableCommitSettings): boolean {
    return normalizeSessionListAttentionPromotionMode(settings.sessionListAttentionPromotionModeV1) !== 'off'
        || normalizeSessionListWorkingPlacementMode(settings.sessionListWorkingPlacementModeV1) !== 'off';
}

export function buildSessionListViewDataForRenderableState(
    state: SessionListRenderableCommitState,
    options?: Readonly<{ serverId?: string | null }>,
): SessionListViewItem[] {
    return buildSessionListViewDataWithServerScope({
        sessions: state.sessionListRenderables,
        sessionRecords: state.sessions,
        machines: state.machineDisplayById,
        machineRecords: state.machines,
        serverId: options?.serverId,
        groupInactiveSessionsByProject: state.settings.groupInactiveSessionsByProject === true,
        activeGroupingV1: state.settings.sessionListActiveGroupingV1,
        inactiveGroupingV1: state.settings.sessionListInactiveGroupingV1,
        sectionModeV1: state.settings.sessionListSectionModeV1,
        workspacePathDisplayModeV1: state.settings.workspacePathDisplayModeV1,
        getProjectForSession: state.getProjectForSession,
    });
}

export function planSessionListRenderableReplacementCommit(input: Readonly<{
    state: SessionListRenderableCommitState;
    incomingRenderables: ReadonlyArray<SessionListRenderableSession>;
    coversWholeList?: boolean;
}>): SessionListRenderableStoreUpdatePlan {
    // An empty partial response covers no ordered range. Reuse the merge planner so
    // retained rows survive; only proven whole-list coverage can evict every row.
    if (input.coversWholeList !== true && input.incomingRenderables.length === 0) {
        return planSessionListRenderableMergeCommit(input);
    }
    return planSessionListRenderableReplacement({
        previousRenderables: input.state.sessionListRenderables ?? {},
        incomingRenderables: input.incomingRenderables,
        // A replacement response replaces the range it covers, not the whole store: rows
        // the user paged in below that range survive the refresh. A response with no further
        // page covers the whole list, so every row it omits is gone (archived or deleted).
        removalWindow: input.coversWholeList
            ? null
            : resolveSessionListRenderableRemovalWindow(input.incomingRenderables),
        isSessionListViewDataUninitialized: input.state.sessionListViewData === null,
        rebuildOnAttentionPromotionFieldsChange:
            shouldRebuildOnSessionPlacementFieldsChange(input.state.settings),
        didListViewFieldsChange: (previous, next) =>
            didSessionListRenderableListViewFieldsChangeForSettings(previous, next, input.state.settings),
        didListViewRowFieldsChange: didSessionListRenderableEmbeddedListRowFieldsChange,
    });
}

export function planSessionListRenderableMergeCommit(input: Readonly<{
    state: SessionListRenderableCommitState;
    incomingRenderables: ReadonlyArray<SessionListRenderableSession>;
}>): SessionListRenderableStoreUpdatePlan {
    return planSessionListRenderableMerge({
        previousRenderables: input.state.sessionListRenderables ?? {},
        incomingRenderables: input.incomingRenderables,
        isSessionListViewDataUninitialized: input.state.sessionListViewData === null,
        rebuildOnAttentionPromotionFieldsChange:
            shouldRebuildOnSessionPlacementFieldsChange(input.state.settings),
        didListViewFieldsChange: (previous, next) =>
            didSessionListRenderableListViewFieldsChangeForSettings(previous, next, input.state.settings),
        didListViewRowFieldsChange: didSessionListRenderableEmbeddedListRowFieldsChange,
    });
}

export function planSessionListRenderablePatchesCommit(input: Readonly<{
    state: SessionListRenderableCommitState;
    patches: ReadonlyArray<SessionListRenderablePatch>;
}>): SessionListRenderableStoreUpdatePlan {
    return planSessionListRenderablePatches({
        previousRenderables: input.state.sessionListRenderables ?? {},
        patches: input.patches,
        isSessionListViewDataUninitialized: input.state.sessionListViewData === null,
        rebuildOnAttentionPromotionFieldsChange:
            shouldRebuildOnSessionPlacementFieldsChange(input.state.settings),
        didListViewFieldsChange: (previous, next) =>
            didSessionListRenderableListViewFieldsChangeForSettings(previous, next, input.state.settings),
        didListViewRowFieldsChange: didSessionListRenderableEmbeddedListRowFieldsChange,
    });
}

export function applySessionListRenderableCommitPlan<S extends SessionListRenderableCommitState>(input: Readonly<{
    state: S;
    plan: SessionListRenderableStoreUpdatePlan;
    targetServerId?: string | null;
    measureListRebuild?: MeasureListRebuild;
}>): S {
    if (input.plan.noop) {
        return input.state;
    }

    const nextStateBase = {
        ...input.state,
        sessionListRenderables: input.plan.nextRenderables,
        sessionListRenderableDelta: buildNextSessionListRenderableDelta({
            previous: input.state.sessionListRenderableDelta,
            changedSessionIds: input.plan.changedSessionIds,
            removedSessionIds: input.plan.removedSessionIds,
            rebuiltSessionListViewData: input.plan.needsSessionListViewDataRebuild,
        }),
    };
    const targetServerId = normalizeTargetServerId(input.targetServerId);
    const activeServerId = getActiveServerIdForSessionListCache();
    const shouldUpdateActiveView = targetServerId === null
        || areServerProfileIdentifiersEquivalent(targetServerId, activeServerId);
    const build = () => buildSessionListViewDataForRenderableState(nextStateBase, {
        serverId: targetServerId,
    });
    const rebuiltSessionListViewData = input.plan.needsSessionListViewDataRebuild
        ? input.measureListRebuild
            ? input.measureListRebuild(build)
            : build()
        : null;
    const sessionListViewData = input.plan.needsSessionListViewDataRebuild
        ? shouldUpdateActiveView
            ? rebuiltSessionListViewData
            : input.state.sessionListViewData
        : shouldUpdateActiveView
            ? refreshSessionListViewDataRowsForRenderables({
                sessionListViewData: input.state.sessionListViewData,
                renderables: input.plan.nextRenderables,
                sessionIds: input.plan.listViewRowRefreshSessionIds,
            })
            : input.state.sessionListViewData;
    const cacheServerId = targetServerId ?? activeServerId;
    const previousCacheServerId = cacheServerId
        ? resolveSessionListCacheServerId(input.state.sessionListViewDataByServerId, cacheServerId)
        : null;
    const previousCachedSessionListViewData = previousCacheServerId
        ? input.state.sessionListViewDataByServerId[previousCacheServerId] ?? null
        : null;
    const canReuseUpdatedActiveViewForCache = shouldUpdateActiveView
        && previousCachedSessionListViewData === input.state.sessionListViewData;
    const refreshedCachedSessionListViewData = input.plan.needsSessionListViewDataRebuild
        ? rebuiltSessionListViewData
        : canReuseUpdatedActiveViewForCache
            ? sessionListViewData
        : refreshSessionListViewDataRowsForRenderables({
            sessionListViewData: previousCachedSessionListViewData,
            renderables: input.plan.nextRenderables,
            sessionIds: input.plan.listViewRowRefreshSessionIds,
        });
    const didRefreshCachedSessionListViewData = refreshedCachedSessionListViewData !== previousCachedSessionListViewData;
    const didRefreshActiveSessionListViewData = sessionListViewData !== input.state.sessionListViewData;
    let sessionListViewDataByServerId = input.state.sessionListViewDataByServerId;
    if (input.plan.needsSessionListViewDataRebuild && rebuiltSessionListViewData) {
        sessionListViewDataByServerId = targetServerId
            ? setServerSessionListCache(
                input.state.sessionListViewDataByServerId,
                targetServerId,
                rebuiltSessionListViewData,
            )
            : setActiveServerSessionListCache(
                input.state.sessionListViewDataByServerId,
                rebuiltSessionListViewData,
        );
    } else if (cacheServerId && didRefreshCachedSessionListViewData && refreshedCachedSessionListViewData) {
        sessionListViewDataByServerId = setServerSessionListCache(
            input.state.sessionListViewDataByServerId,
            cacheServerId,
            refreshedCachedSessionListViewData,
        );
    } else if (shouldUpdateActiveView && didRefreshActiveSessionListViewData && sessionListViewData) {
        sessionListViewDataByServerId = setActiveServerSessionListCache(
            input.state.sessionListViewDataByServerId,
            sessionListViewData,
        );
    }

    return {
        ...nextStateBase,
        sessionListViewData,
        sessionListViewDataByServerId,
    };
}
