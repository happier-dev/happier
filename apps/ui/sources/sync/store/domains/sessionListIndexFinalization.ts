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
import { publishSessionListBotSelection, type SessionListBotRowsByServerId } from './sessionListBotSelection';
import { publishSessionRelations, type SessionRelationsByServerId } from './sessionRelations';

export type SessionListIndexFinalizationState = Readonly<{
    sessions: Record<string, Session>;
    sessionListRenderableDelta?: SessionListRenderableDelta;
    sessionListRowsByServerId: Readonly<Record<string, Readonly<Record<string, SessionListRenderableSession>>>>;
    sessionListBotRowsByServerId?: SessionListBotRowsByServerId;
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
    /** Sessions whose direct record was hydrated without a list-row change (a fallback reader's input). */
    hydratedSessionIds?: readonly string[];
    /**
     * The active Session list index projection changed. Row lists above are exhaustive whether or not
     * it did: row readers reconcile them per row, and only index readers react to this flag. A row
     * change without a published delta (no revision step) is the structural case that needs a full read.
     */
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
    /** Hydrated admission can change a manager fallback without changing the admitted list row. */
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

type OrdinaryRowsState = Pick<SessionListIndexFinalizationState, 'sessionListRowsByServerId' | 'ordinarySessionListMembershipByServerId'>;

/** Ordinary list rows: the membership, in order, restricted to loaded rows. O(membership). */
export function pickOrdinarySessionListRows(
    rows: Readonly<Record<string, SessionListRenderableSession>>,
    membership: readonly string[],
): Record<string, SessionListRenderableSession> {
    return Object.fromEntries(membership.flatMap((sessionId) => {
        const row = rows[sessionId];
        return row ? [[sessionId, row] as const] : [];
    }));
}

export function readOrdinarySessionListRowsForServer(
    state: OrdinaryRowsState,
    serverId: string,
): Record<string, SessionListRenderableSession> {
    return pickOrdinarySessionListRows(
        state.sessionListRowsByServerId?.[serverId] ?? {},
        state.ordinarySessionListMembershipByServerId?.[serverId] ?? [],
    );
}

function hasOrdinaryRowsForServer(state: OrdinaryRowsState, serverId: string): boolean {
    const rows = state.sessionListRowsByServerId?.[serverId];
    if (!rows) return false;
    return (state.ordinarySessionListMembershipByServerId?.[serverId] ?? []).some(sessionId => rows[sessionId] !== undefined);
}

function countOrdinaryRowsForServer(state: OrdinaryRowsState, serverId: string): number {
    const rows = state.sessionListRowsByServerId?.[serverId];
    if (!rows) return 0;
    let count = 0;
    for (const sessionId of state.ordinarySessionListMembershipByServerId?.[serverId] ?? []) if (rows[sessionId]) count += 1;
    return count;
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
        readOrdinarySessionListRowsForServer(state, activeServerId),
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

/**
 * Rows objects already proven to match their Home's index under one membership. The store keeps an
 * unchanged rows object, membership and index by identity, so a later publication that changed only
 * named rows re-checks those rows instead of the whole membership.
 */
const currentProjectionByRows = new WeakMap<object, Readonly<{
    membership: readonly string[] | undefined;
    index: ReadonlyArray<SessionListIndexItem>;
}>>();

function isProjectionProvenCurrent(
    rows: object | undefined,
    membership: readonly string[] | undefined,
    index: ReadonlyArray<SessionListIndexItem>,
): boolean {
    const proven = rows ? currentProjectionByRows.get(rows) : undefined;
    return proven !== undefined && proven.membership === membership && proven.index === index;
}

function isUserFacingRow(row: SessionListRenderableSession | undefined): boolean {
    return row !== undefined && isUserFacingSession(row);
}

export type SessionListProjectionRepairBaseline = Readonly<{
    /** The state the publication started from. */
    state: SessionListIndexFinalizationState;
    /** Every Session whose list row may differ between `state` and the checked state. */
    changedSessionIds: Iterable<string>;
}>;

export function doesActiveSessionListProjectionNeedRepair(
    state: SessionListIndexFinalizationState,
    baseline?: SessionListProjectionRepairBaseline,
): boolean {
    return doesActiveSessionListIndexProjectionNeedRepair(state, baseline);
}

/**
 * Whether the active Home's index no longer covers exactly its user-facing ordinary rows. With a
 * baseline already proven current under the same membership and index, only the named rows can
 * move the answer; anything else (no proof, membership or index moved) is checked in full.
 */
export function doesActiveSessionListIndexProjectionNeedRepair(
    state: SessionListIndexFinalizationState,
    baseline?: SessionListProjectionRepairBaseline,
): boolean {
    const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
    if (!activeServerId) return false;
    const index = state.sessionListIndexByServerId?.[activeServerId];
    if (!Array.isArray(index)) return true;
    const rows = state.sessionListRowsByServerId?.[activeServerId];
    const membership = state.ordinarySessionListMembershipByServerId?.[activeServerId];
    if (isProjectionProvenCurrent(rows, membership, index)) return false;
    const previousRows = baseline?.state.sessionListRowsByServerId?.[activeServerId];
    if (
        rows
        && baseline
        && baseline.state.ordinarySessionListMembershipByServerId?.[activeServerId] === membership
        && baseline.state.sessionListIndexByServerId?.[activeServerId] === index
        && isProjectionProvenCurrent(previousRows, membership, index)
    ) {
        for (const sessionId of baseline.changedSessionIds) {
            if (isUserFacingRow(previousRows?.[sessionId]) === isUserFacingRow(rows[sessionId])) continue;
            if (membership?.includes(sessionId)) return true;
        }
        currentProjectionByRows.set(rows, { membership, index });
        return false;
    }
    const current = isSessionListIndexProjectionCurrent(readOrdinarySessionListRowsForServer(state, activeServerId), index);
    if (current && rows) currentProjectionByRows.set(rows, { membership, index });
    return !current;
}

export function buildNextSessionListRenderableDelta(input: Readonly<{
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
    const previousIndexByServerId = nextStateBase.sessionListIndexByServerId ?? state.sessionListIndexByServerId ?? {};
    const previousActiveIndex = activeServerId ? previousIndexByServerId[activeServerId] ?? null : null;
    const extraFields = telemetry?.fields?.() ?? {};
    const settings = nextStateBase.settings ?? {};
    // Only a rebuild reads the whole ordinary list; a row-level publication keeps the index.
    const activeServerRenderables = needsSessionListIndexRebuild && activeServerId
        ? readOrdinarySessionListRowsForServer(nextStateBase, activeServerId) : {};
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
    const extraFields = telemetry?.fields?.() ?? {};
    const nextState = {
        ...nextStateBase,
        sessionRelationsByServerId: publishSessionRelations(state, nextStateBase, renderableDelta
            ? [...renderableDelta.changedSessionIds, ...renderableDelta.removedSessionIds, ...(renderableDelta.hydratedSessionIds ?? [])]
            : undefined),
        sessionListBotRowsByServerId: publishSessionListBotSelection(
            state.sessionListRowsByServerId,
            nextStateBase.sessionListRowsByServerId,
            state.sessionListBotRowsByServerId,
            renderableDelta ? [...renderableDelta.changedSessionIds, ...renderableDelta.removedSessionIds] : undefined,
        ),
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

    // Telemetry counts are read only when telemetry is on; the save decision needs only "already warm".
    const readNextRenderableCount = () => activeServerId ? countOrdinaryRowsForServer(nextStateBase, activeServerId) : 0;
    if (didAnyImmediateWarmCacheRelevantRenderableChange) {
        if (
            warmCache?.deferImmediateSaveWhenAlreadyWarm === true
            && activeServerId
            && hasOrdinaryRowsForServer(state, activeServerId)
            && typeof warmCache.scheduleDeferredSave === 'function'
        ) {
            const eventName = telemetry?.warmCacheEventName
                ? `${telemetry.warmCacheEventName}.deferred`
                : 'sync.store.sessions.apply.warmCache.deferred';
            syncPerformanceTelemetry.countLazy(eventName, () => ({ renderables: readNextRenderableCount(), ...extraFields, immediate: 1 }));
            warmCache.scheduleDeferredSave(nextState as S);
        } else {
            measureSessionListIndexFinalizationPhase(
                telemetry?.warmCacheEventName ?? 'sync.store.sessions.apply.warmCache',
                () => ({ renderables: readNextRenderableCount(), ...extraFields }),
                () => (warmCache?.saveImmediately ?? saveWarmSessionCacheForState)(nextState),
            );
        }
    } else if (didAnyDeferredWarmCacheRelevantRenderableChange && typeof warmCache?.scheduleDeferredSave === 'function') {
        const eventName = telemetry?.warmCacheEventName
            ? `${telemetry.warmCacheEventName}.deferred`
            : 'sync.store.sessions.apply.warmCache.deferred';
        syncPerformanceTelemetry.countLazy(eventName, () => ({ renderables: readNextRenderableCount(), ...extraFields }));
        warmCache.scheduleDeferredSave(nextState as S);
    }
    return nextState as S;
}
