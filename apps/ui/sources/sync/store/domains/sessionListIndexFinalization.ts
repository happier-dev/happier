import type { Machine, Session } from '../../domains/state/storageTypes';
import type { SessionListRenderableSession } from '../../domains/session/listing/sessionListRenderable';
import type { SessionListIndexItem } from '../../domains/sessionList/sessionListIndex';
import type { MachineDisplayRenderable } from '../../domains/machines/machineDisplayRenderable';
import {
    peekSessionListWarmCacheEntries,
    resolveWarmCacheAccountScope,
    saveSessionListWarmCacheEntries,
    type SessionListCacheEntryV1,
} from '../../domains/state/warmCachePersistence';
import { buildPersistedSessionListCacheEntriesFromRenderables } from '../../domains/state/warmCacheAdapters';
import { getActiveServerSnapshot } from '../../domains/server/serverRuntime';
import { syncPerformanceTelemetry } from '../../runtime/syncPerformanceTelemetry';
import { buildActiveServerSessionListIndex } from '../sessionListIndex/buildSessionListIndexWithServerScope';
import { isUserFacingSession } from '@/sync/domains/session/listing/isUserFacingSession';
import { publishSessionRelations, type SessionRelationsByServerId } from './sessionRelations';

export type SessionListIndexFinalizationState = Readonly<{
    sessions: Record<string, Session>;
    sessionListRenderableDelta?: SessionListRenderableDelta;
    sessionListRowsByServerId: Readonly<Record<string, Readonly<Record<string, SessionListRenderableSession>>>>;
    sessionRelationsByServerId?: SessionRelationsByServerId;
    ordinarySessionListMembershipByServerId?: Readonly<Record<string, readonly string[] | undefined>>;
    sessionListIndexByServerId: Readonly<Record<string, SessionListIndexItem[] | null | undefined>>;
    machines: Record<string, Machine>;
    machineDisplayById: Record<string, MachineDisplayRenderable>;
    profile?: { id?: string | null } | null;
    settings?: {
        sessionListLayoutV1?: 'projects' | 'recent_activity';
    } | null;
    getProjectForSession?: (sessionId: string) => import('../../runtime/orchestration/projectManager').Project | null;
}>;

export type SessionListIndexFinalizationWarmCache<S extends SessionListIndexFinalizationState> = Readonly<{
    deferImmediateSaveWhenAlreadyWarm?: boolean;
    scheduleDeferredSave?: (state: S) => void;
    saveImmediately?: (state: S, previousEntries?: Record<string, SessionListCacheEntryV1>) => void;
}>;

export type SessionListRenderableDelta = Readonly<{
    revision: number;
    changedSessionIds: readonly string[];
    removedSessionIds: readonly string[];
    hydratedSessionIds?: readonly string[];
    rebuiltSessionListIndex: boolean;
    /** Ephemeral exact-Home membership facts from the writer; absent means a full read is required. */
    ordinaryMembershipChanges?: readonly OrdinarySessionMembershipChange[];
}>;

export type OrdinarySessionMembershipChange = Readonly<{
    serverId: string;
    addedSessionIds: readonly string[];
    removedSessionIds: readonly string[];
}>;

type SessionListRenderableDeltaPublication = Readonly<{
    changedSessionIds: readonly string[];
    removedSessionIds: readonly string[];
    hydratedSessionIds?: readonly string[];
    ordinaryMembershipChanges?: readonly OrdinarySessionMembershipChange[];
}>;

function measureSessionListIndexFinalizationPhase<T>(
    name: string,
    fields: () => Record<string, number>,
    fn: () => T,
): T {
    if (!syncPerformanceTelemetry.isEnabled()) return fn();
    return syncPerformanceTelemetry.measure(name, fields(), fn);
}

function readOrdinaryRowsForServer(
    state: SessionListIndexFinalizationState,
    serverId: string,
): Record<string, SessionListRenderableSession> {
    const rows = state.sessionListRowsByServerId?.[serverId] ?? {};
    const membership = state.ordinarySessionListMembershipByServerId?.[serverId] ?? [];
    return Object.fromEntries(membership.flatMap((sessionId) => {
        const row = rows[sessionId];
        return row ? [[sessionId, row] as const] : [];
    }));
}

export function saveWarmSessionCacheForState(
    state: SessionListIndexFinalizationState,
    previousEntries?: Record<string, SessionListCacheEntryV1>,
): void {
    const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
    const accountId = resolveWarmCacheAccountScope(state.profile?.id);
    if (!activeServerId || !accountId) return;
    const previousWarmCacheEntries = previousEntries ?? peekSessionListWarmCacheEntries(activeServerId, accountId) ?? undefined;
    const nextEntries = buildPersistedSessionListCacheEntriesFromRenderables(
        readOrdinaryRowsForServer(state, activeServerId),
        previousWarmCacheEntries,
    );
    if (previousWarmCacheEntries && nextEntries === previousWarmCacheEntries) return;
    saveSessionListWarmCacheEntries(activeServerId, accountId, nextEntries);
}

function isSessionListIndexProjectionCurrent(
    expectedRows: Readonly<Record<string, SessionListRenderableSession>>,
    actualIndex: ReadonlyArray<SessionListIndexItem> | null | undefined,
): boolean {
    if (!Array.isArray(actualIndex)) return false;
    const expectedUserFacingSessionIds = new Set<string>();
    for (const [sessionId, row] of Object.entries(expectedRows)) {
        if (row && isUserFacingSession(row)) expectedUserFacingSessionIds.add(sessionId);
    }
    let actualSessionCount = 0;
    for (const item of actualIndex) {
        if (item?.type !== 'session') continue;
        actualSessionCount += 1;
        if (!expectedUserFacingSessionIds.has(item.sessionId)) return false;
    }
    return actualSessionCount === expectedUserFacingSessionIds.size;
}

export function doesActiveSessionListProjectionNeedRepair(state: SessionListIndexFinalizationState): boolean {
    return doesActiveSessionListIndexProjectionNeedRepair(state);
}

export function doesActiveSessionListIndexProjectionNeedRepair(state: SessionListIndexFinalizationState): boolean {
    const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
    if (!activeServerId) return false;
    return !isSessionListIndexProjectionCurrent(
        readOrdinaryRowsForServer(state, activeServerId),
        state.sessionListIndexByServerId?.[activeServerId],
    );
}

function buildNextSessionListRenderableDelta(input: Readonly<{
    previous: SessionListRenderableDelta | undefined;
    changedSessionIds: readonly string[];
    removedSessionIds: readonly string[];
    hydratedSessionIds?: readonly string[];
    rebuiltSessionListIndex: boolean;
    ordinaryMembershipChanges?: readonly OrdinarySessionMembershipChange[];
}>): SessionListRenderableDelta {
    return {
        revision: (input.previous?.revision ?? 0) + 1,
        changedSessionIds: input.changedSessionIds,
        removedSessionIds: input.removedSessionIds,
        ...(() => {
            // Only hydrations the row lists do not already name; an empty list is omitted.
            const changed = new Set(input.changedSessionIds);
            const hydrated = input.hydratedSessionIds?.filter(sessionId => !changed.has(sessionId)) ?? [];
            return hydrated.length > 0 ? { hydratedSessionIds: hydrated } : {};
        })(),
        rebuiltSessionListIndex: input.rebuiltSessionListIndex,
        ...(input.ordinaryMembershipChanges ? { ordinaryMembershipChanges: input.ordinaryMembershipChanges } : {}),
    };
}

export function finalizeSessionListIndexUpdate<S extends SessionListIndexFinalizationState>(
    state: S,
    nextStateBase: S,
    needsSessionListIndexRebuild: boolean,
    didAnyImmediateWarmCacheRelevantRenderableChange: boolean,
    didAnyDeferredWarmCacheRelevantRenderableChange: boolean,
    telemetry?: Readonly<{
        indexRebuildEventName?: string;
        warmCacheEventName?: string;
        fields?: () => Record<string, number>;
    }>,
    warmCache?: SessionListIndexFinalizationWarmCache<S>,
    renderableDelta?: SessionListRenderableDeltaPublication,
): S {
    const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
    const activeServerRenderables = activeServerId ? readOrdinaryRowsForServer(nextStateBase, activeServerId) : {};
    const previousIndexByServerId = nextStateBase.sessionListIndexByServerId ?? state.sessionListIndexByServerId ?? {};
    const previousActiveIndex = activeServerId ? previousIndexByServerId[activeServerId] ?? null : null;
    const extraFields = telemetry?.fields?.() ?? {};
    const settings = nextStateBase.settings ?? {};
    const nextActiveIndex = needsSessionListIndexRebuild && activeServerId
        ? measureSessionListIndexFinalizationPhase(
            telemetry?.indexRebuildEventName ?? 'sync.store.sessions.apply.indexRebuild',
            () => ({ renderables: Object.keys(activeServerRenderables).length, ...extraFields }),
            () => buildActiveServerSessionListIndex({
                sessions: activeServerRenderables,
                sessionRecords: nextStateBase.sessions,
                machines: nextStateBase.machineDisplayById,
                machineRecords: Object.keys(nextStateBase.machines).length > 0 ? nextStateBase.machines : undefined,
                layoutV1: settings.sessionListLayoutV1,
                getProjectForSession: nextStateBase.getProjectForSession,
                previousIndex: previousActiveIndex,
            }),
        )
        : previousActiveIndex;
    const didSessionListIndexChange = Boolean(activeServerId) && nextActiveIndex !== previousActiveIndex;
    const sessionListIndexByServerId = didSessionListIndexChange
        ? { ...previousIndexByServerId, [activeServerId]: nextActiveIndex }
        : previousIndexByServerId;
    const nextState = {
        ...nextStateBase,
        sessionListIndexByServerId,
    };

    return finalizeSessionListRenderablePublication(
        state,
        nextState as S,
        didSessionListIndexChange,
        didAnyImmediateWarmCacheRelevantRenderableChange,
        didAnyDeferredWarmCacheRelevantRenderableChange,
        telemetry,
        warmCache,
        renderableDelta,
    );
}

export function finalizeSessionListRenderablePublication<S extends SessionListIndexFinalizationState>(
    state: S,
    nextStateBase: S,
    didSessionListIndexChange: boolean,
    didAnyImmediateWarmCacheRelevantRenderableChange: boolean,
    didAnyDeferredWarmCacheRelevantRenderableChange: boolean,
    telemetry?: Readonly<{
        warmCacheEventName?: string;
        fields?: () => Record<string, number>;
    }>,
    warmCache?: SessionListIndexFinalizationWarmCache<S>,
    renderableDelta?: SessionListRenderableDeltaPublication,
): S {
    const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
    const activeServerRenderables = activeServerId ? readOrdinaryRowsForServer(nextStateBase, activeServerId) : {};
    const extraFields = telemetry?.fields?.() ?? {};
    const nextState = {
        ...nextStateBase,
        sessionRelationsByServerId: publishSessionRelations(state, nextStateBase, renderableDelta
            ? [...renderableDelta.changedSessionIds, ...renderableDelta.removedSessionIds, ...(renderableDelta.hydratedSessionIds ?? [])]
            : undefined),
        ...(renderableDelta ? {
            sessionListRenderableDelta: buildNextSessionListRenderableDelta({
                previous: state.sessionListRenderableDelta,
                changedSessionIds: renderableDelta.changedSessionIds,
                removedSessionIds: renderableDelta.removedSessionIds,
                hydratedSessionIds: renderableDelta.hydratedSessionIds,
                rebuiltSessionListIndex: didSessionListIndexChange,
                ordinaryMembershipChanges: renderableDelta.ordinaryMembershipChanges
                    ?? (state.ordinarySessionListMembershipByServerId === nextStateBase.ordinarySessionListMembershipByServerId ? [] : undefined),
            }),
        } : {}),
    };

    const previousRenderableCount = activeServerId ? Object.keys(readOrdinaryRowsForServer(state, activeServerId)).length : 0;
    const nextRenderableCount = Object.keys(activeServerRenderables).length;
    if (didAnyImmediateWarmCacheRelevantRenderableChange) {
        if (
            warmCache?.deferImmediateSaveWhenAlreadyWarm === true
            && previousRenderableCount > 0
            && typeof warmCache.scheduleDeferredSave === 'function'
        ) {
            const eventName = telemetry?.warmCacheEventName
                ? `${telemetry.warmCacheEventName}.deferred`
                : 'sync.store.sessions.apply.warmCache.deferred';
            syncPerformanceTelemetry.count(eventName, { renderables: nextRenderableCount, ...extraFields, immediate: 1 });
            warmCache.scheduleDeferredSave(nextState as S);
        } else {
            measureSessionListIndexFinalizationPhase(
                telemetry?.warmCacheEventName ?? 'sync.store.sessions.apply.warmCache',
                () => ({ renderables: nextRenderableCount, ...extraFields }),
                () => (warmCache?.saveImmediately ?? saveWarmSessionCacheForState)(nextState),
            );
        }
    } else if (didAnyDeferredWarmCacheRelevantRenderableChange && typeof warmCache?.scheduleDeferredSave === 'function') {
        const eventName = telemetry?.warmCacheEventName
            ? `${telemetry.warmCacheEventName}.deferred`
            : 'sync.store.sessions.apply.warmCache.deferred';
        syncPerformanceTelemetry.count(eventName, { renderables: nextRenderableCount, ...extraFields });
        warmCache.scheduleDeferredSave(nextState as S);
    }
    return nextState as S;
}
