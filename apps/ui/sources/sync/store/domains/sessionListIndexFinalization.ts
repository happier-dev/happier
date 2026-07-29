import type { Machine, Session } from '../../domains/state/storageTypes';
import type { ConcurrentSessionListCacheByServerId } from '../../domains/session/listing/concurrentSessionListCache';
import type { SessionListRenderableSession } from '../../domains/session/listing/sessionListRenderable';
import type { SessionListIndexItem } from '../../domains/sessionList/sessionListIndex';
import type { MachineDisplayRenderable } from '../../domains/machines/machineDisplayRenderable';
import {
    peekSessionListWarmCacheEntries,
    resolveWarmCacheAccountScope,
    saveSessionListWarmCacheEntries,
    type SessionListCacheEntryV1,
} from '../../domains/state/warmCachePersistence';
import { buildSessionListCacheEntriesFromRenderables } from '../../domains/state/warmCacheAdapters';
import { getActiveServerSnapshot } from '../../domains/server/serverRuntime';
import { areServerProfileIdentifiersEquivalent } from '../../domains/server/serverProfiles';
import { syncPerformanceTelemetry } from '../../runtime/syncPerformanceTelemetry';
import {
    buildActiveServerSessionListIndex,
    buildSessionListIndexWithServerScope,
} from '../sessionListIndex/buildSessionListIndexWithServerScope';
import { normalizeTrimmedString } from '@/sync/domains/session/listing/normalizeTrimmedString';
import { isUserFacingSession } from '@/sync/domains/session/listing/isUserFacingSession';

export type SessionListIndexFinalizationState = Readonly<{
    sessions: Record<string, Session>;
    sessionListRenderables: Record<string, SessionListRenderableSession>;
    sessionListRenderableDelta?: SessionListRenderableDelta;
    sessionListRowStateByServerId: Readonly<Record<string, Readonly<Record<string, SessionListRenderableSession>>>>;
    sessionListIndexByServerId: Readonly<Record<string, SessionListIndexItem[] | null | undefined>>;
    concurrentSessionListCacheByServerId: ConcurrentSessionListCacheByServerId;
    machines: Record<string, Machine>;
    machineDisplayById: Record<string, MachineDisplayRenderable>;
    profile?: { id?: string | null } | null;
    settings?: {
        groupInactiveSessionsByProject?: boolean;
        sessionListActiveGroupingV1?: 'project' | 'date';
        sessionListInactiveGroupingV1?: 'project' | 'date';
        sessionListSectionModeV1?: 'activity' | 'single';
    } | null;
    getProjectForSession?: (sessionId: string) => import('../../runtime/orchestration/projectManager').Project | null;
}>;

export type SessionListIndexFinalizationWarmCache<S extends SessionListIndexFinalizationState> = Readonly<{
    deferImmediateSaveWhenAlreadyWarm?: boolean;
    scheduleDeferredSave?: (state: S) => void;
    saveImmediately?: (
        state: S,
        previousEntries?: Record<string, SessionListCacheEntryV1>,
    ) => void;
}>;

export type SessionListRenderableDelta = Readonly<{
    revision: number;
    changedSessionIds: readonly string[];
    removedSessionIds: readonly string[];
    rebuiltSessionListIndex: boolean;
}>;

type SessionListRenderableDeltaPublication = Readonly<{
    changedSessionIds: readonly string[];
    removedSessionIds: readonly string[];
}>;

type MutableSessionListRowsByServerId = Record<string, Readonly<Record<string, SessionListRenderableSession>>>;
type MutableSessionListIndexByServerId = Record<string, SessionListIndexItem[] | null | undefined>;

function measureSessionListIndexFinalizationPhase<T>(
    name: string,
    fields: () => Record<string, number>,
    fn: () => T,
): T {
    if (!syncPerformanceTelemetry.isEnabled()) return fn();
    return syncPerformanceTelemetry.measure(name, fields(), fn);
}

export function saveWarmSessionCacheForState(
    state: SessionListIndexFinalizationState,
    previousEntries?: Record<string, SessionListCacheEntryV1>,
): void {
    const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
    const accountId = resolveWarmCacheAccountScope(state.profile?.id);
    if (!activeServerId || !accountId) return;
    const previousWarmCacheEntries = previousEntries ?? peekSessionListWarmCacheEntries(activeServerId, accountId) ?? undefined;
    const nextEntries = buildSessionListCacheEntriesFromRenderables(state.sessionListRenderables, previousWarmCacheEntries);
    if (previousWarmCacheEntries && nextEntries === previousWarmCacheEntries) return;
    saveSessionListWarmCacheEntries(
        activeServerId,
        accountId,
        nextEntries,
    );
}

function partitionSessionListRenderablesByOwnerServer(params: Readonly<{
    sessions: Record<string, Session>;
    sessionListRenderables: Record<string, SessionListRenderableSession>;
    concurrentSessionListCacheByServerId: ConcurrentSessionListCacheByServerId;
    activeServerId: string;
}>): Readonly<{
    activeServerRenderables: Record<string, SessionListRenderableSession>;
    foreignServerRenderablesByServerId: Record<string, Record<string, SessionListRenderableSession>>;
}> {
    let nextActiveServerRenderables = params.sessionListRenderables;
    let activeServerRenderablesMutated = false;
    let foreignServerRenderablesByServerId: Record<string, Record<string, SessionListRenderableSession>> | null = null;

    for (const sessionId in params.sessionListRenderables) {
        const renderable = params.sessionListRenderables[sessionId];
        const ownerServerId = normalizeTrimmedString(params.sessions[sessionId]?.serverId);
        if (!ownerServerId || areServerProfileIdentifiersEquivalent(ownerServerId, params.activeServerId)) {
            continue;
        }

        if (!activeServerRenderablesMutated) {
            nextActiveServerRenderables = { ...params.sessionListRenderables };
            activeServerRenderablesMutated = true;
        }
        delete nextActiveServerRenderables[sessionId];

        const concurrentRows = params.concurrentSessionListCacheByServerId?.[ownerServerId]?.sessions ?? null;
        const existingRows = foreignServerRenderablesByServerId?.[ownerServerId];
        const nextRows = existingRows
            ?? (concurrentRows && typeof concurrentRows === 'object'
                ? { ...concurrentRows }
                : {});
        nextRows[sessionId] = renderable;

        if (!foreignServerRenderablesByServerId) {
            foreignServerRenderablesByServerId = {};
        }
        foreignServerRenderablesByServerId[ownerServerId] = nextRows;
    }

    return {
        activeServerRenderables: nextActiveServerRenderables,
        foreignServerRenderablesByServerId: foreignServerRenderablesByServerId ?? {},
    };
}

function hasRecordEntries<T>(record: Record<string, T> | null | undefined): record is Record<string, T> {
    return Boolean(record && Object.keys(record).length > 0);
}

function areSessionListRowsProjectionCurrent(
    expectedRows: Readonly<Record<string, SessionListRenderableSession>>,
    actualRows: Readonly<Record<string, SessionListRenderableSession>> | null | undefined,
): boolean {
    if (actualRows === expectedRows) {
        return true;
    }
    if (!actualRows || typeof actualRows !== 'object') {
        return Object.keys(expectedRows).length === 0;
    }

    const expectedIds = Object.keys(expectedRows);
    const actualIds = Object.keys(actualRows);
    if (expectedIds.length !== actualIds.length) {
        return false;
    }
    for (const sessionId of expectedIds) {
        if (actualRows[sessionId] !== expectedRows[sessionId]) {
            return false;
        }
    }
    return true;
}

function isSessionListIndexProjectionCurrent(
    expectedRows: Readonly<Record<string, SessionListRenderableSession>>,
    actualIndex: ReadonlyArray<SessionListIndexItem> | null | undefined,
): boolean {
    if (!Array.isArray(actualIndex)) {
        return false;
    }

    const expectedUserFacingSessionIds = new Set<string>();
    for (const sessionId of Object.keys(expectedRows)) {
        const row = expectedRows[sessionId];
        if (row && isUserFacingSession(row)) {
            expectedUserFacingSessionIds.add(sessionId);
        }
    }

    let actualSessionCount = 0;
    for (const item of actualIndex) {
        if (item?.type !== 'session') {
            continue;
        }
        actualSessionCount += 1;
        if (!expectedUserFacingSessionIds.has(item.sessionId)) {
            return false;
        }
    }

    return actualSessionCount === expectedUserFacingSessionIds.size;
}

export function doesActiveSessionListProjectionNeedRepair(
    state: SessionListIndexFinalizationState,
): boolean {
    const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
    if (!activeServerId) {
        return false;
    }

    const { activeServerRenderables } = partitionSessionListRenderablesByOwnerServer({
        sessions: state.sessions,
        sessionListRenderables: state.sessionListRenderables,
        concurrentSessionListCacheByServerId: state.concurrentSessionListCacheByServerId,
        activeServerId,
    });
    const activeRows = state.sessionListRowStateByServerId?.[activeServerId] ?? null;
    if (!areSessionListRowsProjectionCurrent(activeServerRenderables, activeRows)) {
        return true;
    }

    return !isSessionListIndexProjectionCurrent(
        activeServerRenderables,
        state.sessionListIndexByServerId?.[activeServerId],
    );
}

export function doesActiveSessionListIndexProjectionNeedRepair(
    state: SessionListIndexFinalizationState,
): boolean {
    const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
    if (!activeServerId) {
        return false;
    }

    const { activeServerRenderables } = partitionSessionListRenderablesByOwnerServer({
        sessions: state.sessions,
        sessionListRenderables: state.sessionListRenderables,
        concurrentSessionListCacheByServerId: state.concurrentSessionListCacheByServerId,
        activeServerId,
    });

    return !isSessionListIndexProjectionCurrent(
        activeServerRenderables,
        state.sessionListIndexByServerId?.[activeServerId],
    );
}

function buildNextSessionListRenderableDelta(input: Readonly<{
    previous: SessionListRenderableDelta | undefined;
    changedSessionIds: readonly string[];
    removedSessionIds: readonly string[];
    rebuiltSessionListIndex: boolean;
}>): SessionListRenderableDelta {
    return {
        revision: (input.previous?.revision ?? 0) + 1,
        changedSessionIds: input.changedSessionIds,
        removedSessionIds: input.removedSessionIds,
        rebuiltSessionListIndex: input.rebuiltSessionListIndex,
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
    const previousIndexByServerId = nextStateBase.sessionListIndexByServerId ?? state.sessionListIndexByServerId ?? {};
    const {
        activeServerRenderables,
        foreignServerRenderablesByServerId,
    } = partitionSessionListRenderablesByOwnerServer({
        sessions: nextStateBase.sessions,
        sessionListRenderables: nextStateBase.sessionListRenderables,
        concurrentSessionListCacheByServerId: nextStateBase.concurrentSessionListCacheByServerId,
        activeServerId,
    });
    const previousActiveIndex = activeServerId
        ? (previousIndexByServerId[activeServerId] ?? null)
        : null;
    const extraFields = telemetry?.fields?.() ?? {};
    const getProjectForSession = nextStateBase.getProjectForSession;
    const settings = nextStateBase.settings ?? {};
    const machineRecordsForTargetResolution = hasRecordEntries(nextStateBase.machines)
        ? nextStateBase.machines
        : undefined;
    const nextActiveIndex = needsSessionListIndexRebuild && activeServerId
        ? measureSessionListIndexFinalizationPhase(
            telemetry?.indexRebuildEventName ?? 'sync.store.sessions.apply.indexRebuild',
            () => ({
                renderables: Object.keys(activeServerRenderables).length,
                ...extraFields,
            }),
            () => buildActiveServerSessionListIndex({
                sessions: activeServerRenderables,
                sessionRecords: nextStateBase.sessions,
                machines: nextStateBase.machineDisplayById,
                machineRecords: machineRecordsForTargetResolution,
                groupInactiveSessionsByProject: settings.groupInactiveSessionsByProject === true,
                activeGroupingV1: settings.sessionListActiveGroupingV1,
                inactiveGroupingV1: settings.sessionListInactiveGroupingV1,
                sectionModeV1: settings.sessionListSectionModeV1,
                getProjectForSession,
                previousIndex: previousActiveIndex,
            }),
        )
        : previousActiveIndex;

    const previousRowStateByServerId = nextStateBase.sessionListRowStateByServerId ?? state.sessionListRowStateByServerId ?? {};
    let nextSessionListRowStateByServerId = previousRowStateByServerId as MutableSessionListRowsByServerId;
    let nextSessionListIndexByServerId = previousIndexByServerId as MutableSessionListIndexByServerId;
    let didSessionListIndexChange = false;

    const writeServerScopedRows = (
        serverId: string,
        renderables: Record<string, SessionListRenderableSession>,
    ): void => {
        if (nextSessionListRowStateByServerId[serverId] !== renderables) {
            if (nextSessionListRowStateByServerId === previousRowStateByServerId) {
                nextSessionListRowStateByServerId = { ...previousRowStateByServerId };
            }
            nextSessionListRowStateByServerId[serverId] = renderables;
        }
    };

    const writeServerScopedIndex = (
        serverId: string,
        index: SessionListIndexItem[] | null | undefined,
    ): void => {
        if (nextSessionListIndexByServerId[serverId] !== index) {
            if (nextSessionListIndexByServerId === previousIndexByServerId) {
                nextSessionListIndexByServerId = { ...previousIndexByServerId };
            }
            nextSessionListIndexByServerId[serverId] = index;
            didSessionListIndexChange = true;
        }
    };

    const deleteServerScopedProjection = (serverId: string): void => {
        if (serverId in nextSessionListRowStateByServerId) {
            if (nextSessionListRowStateByServerId === previousRowStateByServerId) {
                nextSessionListRowStateByServerId = { ...previousRowStateByServerId };
            }
            delete nextSessionListRowStateByServerId[serverId];
        }
        if (serverId in nextSessionListIndexByServerId) {
            if (nextSessionListIndexByServerId === previousIndexByServerId) {
                nextSessionListIndexByServerId = { ...previousIndexByServerId };
            }
            delete nextSessionListIndexByServerId[serverId];
            didSessionListIndexChange = true;
        }
    };

    if (activeServerId) {
        writeServerScopedRows(activeServerId, activeServerRenderables);
        writeServerScopedIndex(activeServerId, nextActiveIndex);
    }

    for (const serverId in foreignServerRenderablesByServerId) {
        const renderables = foreignServerRenderablesByServerId[serverId];
        const concurrentEntry = nextStateBase.concurrentSessionListCacheByServerId?.[serverId];
        writeServerScopedRows(serverId, renderables);
        writeServerScopedIndex(serverId, buildSessionListIndexWithServerScope({
            sessions: renderables,
            sessionRecords: nextStateBase.sessions,
            machines: nextStateBase.machineDisplayById,
            machineRecords: machineRecordsForTargetResolution,
            groupInactiveSessionsByProject: settings.groupInactiveSessionsByProject === true,
            activeGroupingV1: settings.sessionListActiveGroupingV1,
            inactiveGroupingV1: settings.sessionListInactiveGroupingV1,
            sectionModeV1: settings.sessionListSectionModeV1,
            getProjectForSession,
            previousIndex: previousIndexByServerId[serverId] ?? null,
            serverScope: {
                serverId,
                serverName: concurrentEntry?.serverName ?? null,
            },
        }));
    }

    const candidateServerIds = new Set<string>([
        ...Object.keys(previousRowStateByServerId),
        ...Object.keys(previousIndexByServerId),
    ]);
    for (const serverId of candidateServerIds) {
        if (!serverId || serverId === activeServerId) {
            continue;
        }
        if (activeServerId && areServerProfileIdentifiersEquivalent(serverId, activeServerId)) {
            deleteServerScopedProjection(serverId);
            continue;
        }
        if (serverId in foreignServerRenderablesByServerId) {
            continue;
        }
        const concurrentRows = nextStateBase.concurrentSessionListCacheByServerId?.[serverId]?.sessions ?? null;
        if (concurrentRows && typeof concurrentRows === 'object') {
            continue;
        }
        deleteServerScopedProjection(serverId);
    }

    const nextState = {
        ...nextStateBase,
        ...(renderableDelta
            ? {
                sessionListRenderableDelta: buildNextSessionListRenderableDelta({
                    previous: state.sessionListRenderableDelta,
                    changedSessionIds: renderableDelta.changedSessionIds,
                    removedSessionIds: renderableDelta.removedSessionIds,
                    rebuiltSessionListIndex: didSessionListIndexChange,
                }),
            }
            : {}),
        sessionListRowStateByServerId: nextSessionListRowStateByServerId,
        sessionListIndexByServerId: nextSessionListIndexByServerId,
    };

    if (didAnyImmediateWarmCacheRelevantRenderableChange) {
        const previousRenderableCount = Object.keys(state.sessionListRenderables).length;
        if (
            warmCache?.deferImmediateSaveWhenAlreadyWarm === true
            && previousRenderableCount > 0
            && typeof warmCache.scheduleDeferredSave === 'function'
        ) {
            const deferredWarmCacheEventName = telemetry?.warmCacheEventName
                ? `${telemetry.warmCacheEventName}.deferred`
                : 'sync.store.sessions.apply.warmCache.deferred';
            syncPerformanceTelemetry.count(deferredWarmCacheEventName, {
                renderables: Object.keys(nextState.sessionListRenderables).length,
                ...extraFields,
                immediate: 1,
            });
            warmCache.scheduleDeferredSave(nextState as S);
        } else {
            measureSessionListIndexFinalizationPhase(
                telemetry?.warmCacheEventName ?? 'sync.store.sessions.apply.warmCache',
                () => ({
                    renderables: Object.keys(nextState.sessionListRenderables).length,
                    ...extraFields,
                }),
                () => (warmCache?.saveImmediately ?? saveWarmSessionCacheForState)(nextState),
            );
        }
    } else if (didAnyDeferredWarmCacheRelevantRenderableChange && typeof warmCache?.scheduleDeferredSave === 'function') {
        const deferredWarmCacheEventName = telemetry?.warmCacheEventName
            ? `${telemetry.warmCacheEventName}.deferred`
            : 'sync.store.sessions.apply.warmCache.deferred';
        syncPerformanceTelemetry.count(deferredWarmCacheEventName, {
            renderables: Object.keys(nextState.sessionListRenderables).length,
            ...extraFields,
        });
        warmCache.scheduleDeferredSave(nextState as S);
    }

    return nextState as S;
}
