import type { MachineDisplayRenderable } from '@/sync/domains/machines/machineDisplayRenderable';
import {
    readRollbackEligibleTurnStarts,
    type SessionListRenderableSession,
} from '@/sync/domains/session/listing/sessionListRenderable';
import { parseSessionRuntimeActivityProjectionFields } from '@happier-dev/protocol';

import type {
    MachineDisplayCacheEntryV1,
    SessionListCacheEntryV1,
} from './warmCachePersistence';

/**
 * The warm cache exists to paint the first screens of the session list before the
 * network answers; it is not a mirror of the account. An uncapped blob makes every cold
 * boot parse (and every save re-serialize) one entry per session the account has ever
 * had, on the boot critical path. Bound it to the rows the list can plausibly show
 * before the first fetch lands.
 *
 * The retention policy lives here rather than with storage because both the entry
 * projection and the persistence layer apply it, and it must not depend on MMKV.
 */
export const SESSION_LIST_WARM_CACHE_MAX_ENTRIES = 200;

export type WarmCacheSessionOrderingFields = Readonly<{
    meaningfulActivityAt?: number | null;
    createdAt: number;
}>;

function resolveWarmCacheOrderingActivityAt(row: WarmCacheSessionOrderingFields): number {
    return typeof row.meaningfulActivityAt === 'number' ? row.meaningfulActivityAt : row.createdAt;
}

/**
 * Single owner of the warm-cache size bound. Selects the most recent ids using the
 * server list ordering key (`meaningfulActivityAt desc, id desc`) so the cached head of
 * the list matches the head the server would return.
 *
 * Returns `null` when every id fits, so callers keep their record-identity fast paths
 * instead of rebuilding an equivalent record on every fetch.
 */
export function selectMostRecentWarmCacheSessionIds(
    rows: Readonly<Record<string, WarmCacheSessionOrderingFields>>,
    limit: number = SESSION_LIST_WARM_CACHE_MAX_ENTRIES,
): readonly string[] | null {
    const ids = Object.keys(rows);
    if (ids.length <= limit) return null;
    return ids
        .sort((leftId, rightId) => {
            const left = resolveWarmCacheOrderingActivityAt(rows[leftId]);
            const right = resolveWarmCacheOrderingActivityAt(rows[rightId]);
            if (left !== right) return right - left;
            return leftId < rightId ? 1 : leftId > rightId ? -1 : 0;
        })
        .slice(0, limit);
}

const EMPTY_WARM_CACHE_ENTRIES: Record<string, never> = {};
const EMPTY_SESSION_LIST_CACHE_ENTRIES = EMPTY_WARM_CACHE_ENTRIES as Record<string, SessionListCacheEntryV1>;
const EMPTY_MACHINE_DISPLAY_CACHE_ENTRIES = EMPTY_WARM_CACHE_ENTRIES as Record<string, MachineDisplayCacheEntryV1>;

function normalizeNonNegativeInteger(value: number | null | undefined): number | null {
    return typeof value === 'number' && Number.isSafeInteger(value)
        ? Math.max(0, value)
        : null;
}

function normalizeBoolean(value: boolean | undefined): boolean | undefined {
    return typeof value === 'boolean' ? value : undefined;
}

function normalizeNonNegativeNumber(value: number | null | undefined): number | null {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(0, Math.trunc(value))
        : null;
}

function areCacheJsonValuesEqual(next: unknown, previous: unknown): boolean {
    if (next === previous) return true;
    if ((next ?? null) === null || (previous ?? null) === null) return (next ?? null) === (previous ?? null);
    return JSON.stringify(next) === JSON.stringify(previous);
}

function toMutableNumberArray(value: readonly number[] | null): number[] | null {
    return value ? [...value] : null;
}

function hasNonEmptyString(value: string | null | undefined): boolean {
    return typeof value === 'string' && value.trim().length > 0;
}

function readRuntimeActivityProjectionFields(
    value: unknown,
): Pick<
    SessionListRenderableSession,
    | 'runtimeActivityState'
    | 'runtimeActivityActiveCount'
    | 'runtimeActivityObservedAt'
    | 'runtimeActivityRevision'
> {
    const parsed = parseSessionRuntimeActivityProjectionFields(value);
    if (parsed.kind !== 'valid') return {};
    return {
        runtimeActivityState: parsed.projection.state,
        runtimeActivityActiveCount: parsed.projection.activeCount,
        runtimeActivityObservedAt: parsed.projection.observedAt,
        runtimeActivityRevision: parsed.projection.revision,
    };
}

export function isSessionListCacheEntryMetadataUsable(entry: SessionListCacheEntryV1 | undefined): entry is SessionListCacheEntryV1 {
    if (!entry) return false;
    return hasNonEmptyString(entry.name)
        || hasNonEmptyString(entry.path)
        || hasNonEmptyString(entry.host)
        || hasNonEmptyString(entry.machineId)
        || hasNonEmptyString(entry.flavor)
        || entry.directSessionV1 != null
        || entry.hiddenSystemSession === true;
}

function areDirectSessionCacheEntriesEqual(
    next: SessionListCacheEntryV1['directSessionV1'],
    previous: SessionListCacheEntryV1['directSessionV1'],
): boolean {
    if (next === previous) return true;
    if (!next || !previous) return (next ?? null) === (previous ?? null);
    return next.v === previous.v && next.providerId === previous.providerId;
}

function areSessionListCacheEntriesEqual(
    nextEntry: SessionListCacheEntryV1,
    previousEntry: SessionListCacheEntryV1,
): boolean {
    return (
        nextEntry.seq === previousEntry.seq
        && nextEntry.metadataVersion === previousEntry.metadataVersion
        && nextEntry.agentStateVersion === previousEntry.agentStateVersion
        && nextEntry.updatedAt === previousEntry.updatedAt
        && (nextEntry.meaningfulActivityAt ?? null) === (previousEntry.meaningfulActivityAt ?? null)
        && nextEntry.createdAt === previousEntry.createdAt
        && nextEntry.active === previousEntry.active
        && nextEntry.activeAt === previousEntry.activeAt
        && nextEntry.archivedAt === previousEntry.archivedAt
        && nextEntry.lastViewedSessionSeq === previousEntry.lastViewedSessionSeq
        && nextEntry.pendingCount === previousEntry.pendingCount
        && nextEntry.pendingBlockedCount === previousEntry.pendingBlockedCount
        && nextEntry.pendingVersion === previousEntry.pendingVersion
        && areCacheJsonValuesEqual(nextEntry.pendingActivationAuthorization ?? null, previousEntry.pendingActivationAuthorization ?? null)
        && (nextEntry.latestTurnId ?? null) === (previousEntry.latestTurnId ?? null)
        && (nextEntry.latestTurnStatus ?? null) === (previousEntry.latestTurnStatus ?? null)
        && (nextEntry.latestTurnStatusObservedAt ?? null) === (previousEntry.latestTurnStatusObservedAt ?? null)
        && areCacheJsonValuesEqual(nextEntry.lastRuntimeIssue ?? null, previousEntry.lastRuntimeIssue ?? null)
        && (nextEntry.runtimeActivityState ?? null) === (previousEntry.runtimeActivityState ?? null)
        && (nextEntry.runtimeActivityActiveCount ?? null) === (previousEntry.runtimeActivityActiveCount ?? null)
        && (nextEntry.runtimeActivityObservedAt ?? null) === (previousEntry.runtimeActivityObservedAt ?? null)
        && (nextEntry.runtimeActivityRevision ?? null) === (previousEntry.runtimeActivityRevision ?? null)
        && areCacheJsonValuesEqual(nextEntry.rollbackEligibleTurnStarts ?? null, previousEntry.rollbackEligibleTurnStarts ?? null)
        && (nextEntry.latestReadyEventSeq ?? null) === (previousEntry.latestReadyEventSeq ?? null)
        && (nextEntry.latestReadyEventAt ?? null) === (previousEntry.latestReadyEventAt ?? null)
        && (nextEntry.pendingRequestObservedAt ?? null) === (previousEntry.pendingRequestObservedAt ?? null)
        && nextEntry.accessLevel === previousEntry.accessLevel
        && nextEntry.canApprovePermissions === previousEntry.canApprovePermissions
        && nextEntry.name === previousEntry.name
        && nextEntry.summaryText === previousEntry.summaryText
        && nextEntry.path === previousEntry.path
        && nextEntry.homeDir === previousEntry.homeDir
        && nextEntry.host === previousEntry.host
        && nextEntry.machineId === previousEntry.machineId
        && nextEntry.flavor === previousEntry.flavor
        && areDirectSessionCacheEntriesEqual(nextEntry.directSessionV1, previousEntry.directSessionV1)
        && nextEntry.hiddenSystemSession === previousEntry.hiddenSystemSession
        && nextEntry.hasPendingPermissionRequests === previousEntry.hasPendingPermissionRequests
        && nextEntry.hasPendingUserActionRequests === previousEntry.hasPendingUserActionRequests
        && nextEntry.hasUnreadMessages === previousEntry.hasUnreadMessages
        && (nextEntry.unreadSince ?? null) === (previousEntry.unreadSince ?? null)
    );
}

function areMachineDisplayCacheEntriesEqual(
    nextEntry: MachineDisplayCacheEntryV1,
    previousEntry: MachineDisplayCacheEntryV1,
): boolean {
    return (
        nextEntry.metadataVersion === previousEntry.metadataVersion
        && nextEntry.updatedAt === previousEntry.updatedAt
        && nextEntry.active === previousEntry.active
        && nextEntry.activeAt === previousEntry.activeAt
        && nextEntry.revokedAt === previousEntry.revokedAt
        && nextEntry.displayName === previousEntry.displayName
        && nextEntry.host === previousEntry.host
        && nextEntry.homeDir === previousEntry.homeDir
    );
}

function countOwnEntries(record: Readonly<Record<string, unknown>> | null | undefined): number {
    let count = 0;
    const source = record ?? {};
    for (const key in source) {
        if (Object.prototype.hasOwnProperty.call(source, key)) {
            count += 1;
        }
    }
    return count;
}

export function buildSessionListRenderableFromCacheEntry(entry: SessionListCacheEntryV1): SessionListRenderableSession {
    const metadataUsable = isSessionListCacheEntryMetadataUsable(entry);
    return {
        id: entry.sessionId,
        seq: normalizeNonNegativeInteger(entry.seq) ?? 0,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        meaningfulActivityAt: entry.meaningfulActivityAt ?? entry.createdAt,
        active: entry.active,
        activeAt: entry.activeAt,
        archivedAt: entry.archivedAt,
        pendingCount: entry.pendingCount,
        pendingBlockedCount: entry.pendingBlockedCount,
        pendingVersion: entry.pendingVersion,
        pendingActivationAuthorization: entry.pendingActivationAuthorization ?? null,
        lastViewedSessionSeq: normalizeNonNegativeInteger(entry.lastViewedSessionSeq),
        metadataVersion: entry.metadataVersion,
        agentStateVersion: entry.agentStateVersion,
        metadata: metadataUsable ? {
            name: entry.name,
            summaryText: entry.summaryText ?? null,
            path: entry.path,
            homeDir: entry.homeDir ?? null,
            host: entry.host ?? null,
            machineId: entry.machineId ?? null,
            flavor: entry.flavor ?? null,
            directSessionV1: entry.directSessionV1 ?? null,
            hiddenSystemSession: entry.hiddenSystemSession === true,
        } : null,
        thinking: false,
        thinkingAt: 0,
        presence: entry.active ? 'online' : entry.activeAt,
        latestTurnId: entry.latestTurnId ?? null,
        latestTurnStatus: entry.latestTurnStatus ?? null,
        latestTurnStatusObservedAt: normalizeNonNegativeNumber(entry.latestTurnStatusObservedAt),
        lastRuntimeIssue: entry.lastRuntimeIssue ?? null,
        ...readRuntimeActivityProjectionFields(entry),
        rollbackEligibleTurnStarts: readRollbackEligibleTurnStarts(entry.rollbackEligibleTurnStarts),
        latestReadyEventSeq: normalizeNonNegativeInteger(entry.latestReadyEventSeq),
        latestReadyEventAt: normalizeNonNegativeNumber(entry.latestReadyEventAt),
        accessLevel: entry.accessLevel,
        canApprovePermissions: entry.canApprovePermissions,
        // `keepVisibleWhenInactive` is transient client placement state: every commit
        // re-derives it from the previous renderable, so a cached value can never
        // survive hydration. It is therefore not persisted at all.
        // Pending flags stay verbatim (including absent) so a warm row reports
        // "not hydrated yet" rather than claiming there are no pending requests,
        // and so entry -> renderable -> entry is lossless.
        hasPendingPermissionRequests: entry.hasPendingPermissionRequests,
        hasPendingUserActionRequests: entry.hasPendingUserActionRequests,
        pendingRequestObservedAt: normalizeNonNegativeNumber(entry.pendingRequestObservedAt),
        hasUnreadMessages: normalizeBoolean(entry.hasUnreadMessages),
        // Restoring the unread entry fact is what keeps the attention lane ordered
        // by a durable server fact instead of a per-boot, per-device one.
        unreadSince: entry.unreadSince ?? null,
        metadataUnavailable: !metadataUsable,
    };
}

function shouldPreserveSessionMetadataFromPreviousEntry(
    session: SessionListRenderableSession,
    previousEntry: SessionListCacheEntryV1 | undefined,
): previousEntry is SessionListCacheEntryV1 {
    return session.metadata == null
        && session.metadataUnavailable !== true
        && isSessionListCacheEntryMetadataUsable(previousEntry);
}

function shouldPreserveSessionAgentStateFromPreviousEntry(
    session: SessionListRenderableSession,
    previousEntry: SessionListCacheEntryV1 | undefined,
): previousEntry is SessionListCacheEntryV1 {
    return (
        typeof session.hasPendingPermissionRequests !== 'boolean'
        && typeof session.hasPendingUserActionRequests !== 'boolean'
        && Boolean(previousEntry)
    );
}

function shouldPreserveSessionReadStateFromPreviousEntry(
    session: SessionListRenderableSession,
    previousEntry: SessionListCacheEntryV1 | undefined,
): previousEntry is SessionListCacheEntryV1 {
    return (
        typeof session.lastViewedSessionSeq !== 'number'
        && typeof session.hasUnreadMessages !== 'boolean'
        && Boolean(previousEntry)
    );
}

export function buildSessionListCacheEntryFromRenderable(
    session: SessionListRenderableSession,
    previousEntry?: SessionListCacheEntryV1,
): SessionListCacheEntryV1 {
    const preserveMetadata = shouldPreserveSessionMetadataFromPreviousEntry(session, previousEntry);
    const preserveAgentState = shouldPreserveSessionAgentStateFromPreviousEntry(session, previousEntry);
    const preserveReadState = shouldPreserveSessionReadStateFromPreviousEntry(session, previousEntry);

    const nextEntry: SessionListCacheEntryV1 = {
        sessionId: session.id,
        seq: preserveReadState ? previousEntry.seq : normalizeNonNegativeInteger(session.seq) ?? 0,
        metadataVersion: preserveMetadata ? previousEntry.metadataVersion : session.metadataVersion,
        agentStateVersion: preserveAgentState ? previousEntry.agentStateVersion : session.agentStateVersion,
        updatedAt: session.updatedAt,
        meaningfulActivityAt: session.meaningfulActivityAt ?? null,
        createdAt: session.createdAt,
        active: session.active,
        activeAt: session.activeAt,
        archivedAt: session.archivedAt ?? null,
        lastViewedSessionSeq: preserveReadState
            ? previousEntry.lastViewedSessionSeq ?? null
            : normalizeNonNegativeInteger(session.lastViewedSessionSeq),
        pendingCount: session.pendingCount,
        pendingBlockedCount: session.pendingBlockedCount,
        pendingVersion: session.pendingVersion,
        pendingActivationAuthorization: session.pendingActivationAuthorization ?? null,
        latestTurnId: session.latestTurnId ?? null,
        latestTurnStatus: session.latestTurnStatus ?? null,
        latestTurnStatusObservedAt: normalizeNonNegativeNumber(session.latestTurnStatusObservedAt),
        lastRuntimeIssue: session.lastRuntimeIssue ?? null,
        ...readRuntimeActivityProjectionFields(session),
        rollbackEligibleTurnStarts: toMutableNumberArray(readRollbackEligibleTurnStarts(session.rollbackEligibleTurnStarts)),
        latestReadyEventSeq: normalizeNonNegativeInteger(session.latestReadyEventSeq),
        latestReadyEventAt: normalizeNonNegativeNumber(session.latestReadyEventAt),
        pendingRequestObservedAt: normalizeNonNegativeNumber(session.pendingRequestObservedAt),
        accessLevel: session.accessLevel,
        canApprovePermissions: session.canApprovePermissions,
        name: preserveMetadata ? previousEntry.name : session.metadata?.name,
        summaryText: preserveMetadata ? previousEntry.summaryText ?? null : session.metadata?.summaryText ?? null,
        path: preserveMetadata ? previousEntry.path : session.metadata?.path ?? '',
        homeDir: preserveMetadata ? previousEntry.homeDir ?? null : session.metadata?.homeDir ?? null,
        host: preserveMetadata ? previousEntry.host ?? null : session.metadata?.host ?? null,
        machineId: preserveMetadata ? previousEntry.machineId ?? null : session.metadata?.machineId ?? null,
        flavor: preserveMetadata ? previousEntry.flavor ?? null : session.metadata?.flavor ?? null,
        directSessionV1: preserveMetadata ? previousEntry.directSessionV1 ?? null : session.metadata?.directSessionV1 ?? null,
        hiddenSystemSession: preserveMetadata
            ? previousEntry.hiddenSystemSession === true
            : session.metadata?.hiddenSystemSession === true,
        hasPendingPermissionRequests: preserveAgentState
            ? previousEntry.hasPendingPermissionRequests
            : typeof session.hasPendingPermissionRequests === 'boolean'
                ? session.hasPendingPermissionRequests
                : undefined,
        hasPendingUserActionRequests: preserveAgentState
            ? previousEntry.hasPendingUserActionRequests
            : typeof session.hasPendingUserActionRequests === 'boolean'
                ? session.hasPendingUserActionRequests
                : undefined,
        hasUnreadMessages: preserveReadState
            ? normalizeBoolean(previousEntry.hasUnreadMessages)
            : normalizeBoolean(session.hasUnreadMessages),
        // Part of read state: it must travel with `hasUnreadMessages`, or a
        // not-yet-hydrated row would drop the entry fact of the unread state it
        // is still reporting.
        unreadSince: preserveReadState
            ? previousEntry.unreadSince ?? null
            : normalizeNonNegativeNumber(session.unreadSince),
    };

    return previousEntry && areSessionListCacheEntriesEqual(nextEntry, previousEntry) ? previousEntry : nextEntry;
}

/**
 * Projects every renderable into its cache entry. Used both as the in-memory metadata
 * fallback for a session-list fetch and, through
 * `buildPersistedSessionListCacheEntriesFromRenderables`, as the persisted warm cache.
 */
export function buildSessionListCacheEntriesFromRenderables(
    sessions: Record<string, SessionListRenderableSession>,
    previousEntries?: Record<string, SessionListCacheEntryV1>,
): Record<string, SessionListCacheEntryV1> {
    return buildSessionListCacheEntries(sessions, previousEntries, null);
}

/**
 * The persisted warm cache keeps only the most recent rows by the server list ordering
 * key, so a long-lived account cannot grow an unbounded blob that every boot must parse
 * and every save must re-serialize. The in-memory projection above stays complete.
 */
export function buildPersistedSessionListCacheEntriesFromRenderables(
    sessions: Record<string, SessionListRenderableSession>,
    previousEntries?: Record<string, SessionListCacheEntryV1>,
): Record<string, SessionListCacheEntryV1> {
    return buildSessionListCacheEntries(sessions, previousEntries, selectMostRecentWarmCacheSessionIds(sessions));
}

function buildSessionListCacheEntries(
    sessions: Record<string, SessionListRenderableSession>,
    previousEntries: Record<string, SessionListCacheEntryV1> | undefined,
    cappedSessionIds: readonly string[] | null,
): Record<string, SessionListCacheEntryV1> {
    const sessionIds = cappedSessionIds ?? Object.keys(sessions);
    if (sessionIds.length === 0) {
        return previousEntries && countOwnEntries(previousEntries) === 0 ? previousEntries : EMPTY_SESSION_LIST_CACHE_ENTRIES;
    }

    if (!previousEntries) {
        const nextEntries: Record<string, SessionListCacheEntryV1> = {};
        for (const sessionId of sessionIds) {
            const session = sessions[sessionId];
            nextEntries[sessionId] = buildSessionListCacheEntryFromRenderable(session);
        }
        return nextEntries;
    }

    let nextEntries = previousEntries;
    let didChange = false;
    let addedCount = 0;

    for (const sessionId of sessionIds) {
        const session = sessions[sessionId];
        const previousEntry = previousEntries[sessionId];
        if (!previousEntry) {
            addedCount += 1;
        }
        const nextEntry = buildSessionListCacheEntryFromRenderable(session, previousEntry);
        if (!previousEntry || nextEntry !== previousEntry) {
            if (!didChange) {
                nextEntries = { ...previousEntries };
                didChange = true;
            }
            nextEntries[sessionId] = nextEntry;
        }
    }

    // Equal counts alone do not imply equal membership once entries can both enter and
    // leave the retained window, so only skip the eviction scan when nothing was added
    // AND the counts already match — which together prove the previous record is exactly
    // the retained set.
    if (addedCount > 0 || countOwnEntries(previousEntries) !== sessionIds.length) {
        const retainedSessionIds = cappedSessionIds ? new Set(cappedSessionIds) : null;
        for (const previousSessionId in previousEntries) {
            if (!Object.prototype.hasOwnProperty.call(previousEntries, previousSessionId)) continue;
            const isRetained = retainedSessionIds
                ? retainedSessionIds.has(previousSessionId)
                : sessions[previousSessionId] !== undefined;
            if (isRetained) continue;
            if (!didChange) {
                nextEntries = { ...previousEntries };
                didChange = true;
            }
            delete nextEntries[previousSessionId];
        }
    }

    return didChange ? nextEntries : previousEntries;
}

export function buildMachineDisplayRenderableFromCacheEntry(entry: MachineDisplayCacheEntryV1): MachineDisplayRenderable {
    return {
        id: entry.machineId,
        updatedAt: entry.updatedAt,
        active: entry.active,
        activeAt: entry.activeAt,
        revokedAt: entry.revokedAt,
        metadataVersion: entry.metadataVersion,
        metadata: {
            displayName: entry.displayName ?? null,
            host: entry.host ?? null,
            homeDir: entry.homeDir ?? null,
        },
    };
}

function shouldPreserveMachineDisplayMetadataFromPreviousEntry(
    machine: MachineDisplayRenderable,
    previousEntry: MachineDisplayCacheEntryV1 | undefined,
): previousEntry is MachineDisplayCacheEntryV1 {
    return machine.metadata == null && Boolean(previousEntry);
}

export function buildMachineDisplayCacheEntryFromRenderable(
    machine: MachineDisplayRenderable,
    previousEntry?: MachineDisplayCacheEntryV1,
): MachineDisplayCacheEntryV1 {
    const preserveMetadata = shouldPreserveMachineDisplayMetadataFromPreviousEntry(machine, previousEntry);

    const nextEntry: MachineDisplayCacheEntryV1 = {
        machineId: machine.id,
        metadataVersion: preserveMetadata ? previousEntry.metadataVersion : machine.metadataVersion,
        updatedAt: machine.updatedAt,
        active: machine.active,
        activeAt: machine.activeAt,
        revokedAt: machine.revokedAt ?? null,
        displayName: preserveMetadata ? previousEntry.displayName ?? null : machine.metadata?.displayName ?? null,
        host: preserveMetadata ? previousEntry.host ?? null : machine.metadata?.host ?? null,
        homeDir: preserveMetadata ? previousEntry.homeDir ?? null : machine.metadata?.homeDir ?? null,
    };

    return previousEntry && areMachineDisplayCacheEntriesEqual(nextEntry, previousEntry) ? previousEntry : nextEntry;
}

export function buildMachineDisplayCacheEntriesFromRenderables(
    machines: Record<string, MachineDisplayRenderable>,
    previousEntries?: Record<string, MachineDisplayCacheEntryV1>,
): Record<string, MachineDisplayCacheEntryV1> {
    const machineIds = Object.keys(machines);
    if (machineIds.length === 0) {
        return previousEntries && countOwnEntries(previousEntries) === 0 ? previousEntries : EMPTY_MACHINE_DISPLAY_CACHE_ENTRIES;
    }

    if (!previousEntries) {
        const nextEntries: Record<string, MachineDisplayCacheEntryV1> = {};
        for (const machineId of machineIds) {
            const machine = machines[machineId];
            nextEntries[machineId] = buildMachineDisplayCacheEntryFromRenderable(machine);
        }
        return nextEntries;
    }

    let nextEntries = previousEntries;
    let didChange = false;

    for (const machineId of machineIds) {
        const machine = machines[machineId];
        const previousEntry = previousEntries[machineId];
        const nextEntry = buildMachineDisplayCacheEntryFromRenderable(machine, previousEntry);
        if (!previousEntry || nextEntry !== previousEntry) {
            if (!didChange) {
                nextEntries = { ...previousEntries };
                didChange = true;
            }
            nextEntries[machineId] = nextEntry;
        }
    }

    if (countOwnEntries(previousEntries) !== machineIds.length) {
        if (!didChange) {
            nextEntries = { ...previousEntries };
            didChange = true;
        }

        for (const previousMachineId in previousEntries) {
            if (
                Object.prototype.hasOwnProperty.call(previousEntries, previousMachineId)
                && machines[previousMachineId] === undefined
            ) {
                delete nextEntries[previousMachineId];
            }
        }
    }

    return didChange ? nextEntries : previousEntries;
}
