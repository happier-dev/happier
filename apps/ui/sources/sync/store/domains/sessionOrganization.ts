import type {
    SessionAttentionStanding,
    SessionOrganizationDisplayState as ProtocolSessionOrganizationDisplayState,
    SessionOrganizationOrderEntry,
    SessionOrganizationPin,
    SessionOrganizationSnapshot,
} from '@happier-dev/protocol';

import {
    buildSessionOrganizationLabelKey,
    buildSessionOrganizationOrderScopeKey,
    buildSessionOrganizationSessionKey,
    buildSessionOrganizationServerKey,
    sessionOrganizationTupleKeyBelongsToServer,
} from '@/sync/domains/session/organization';
import type {
    SessionOrganizationSnapshotApplyOptions,
    SessionOrganizationDisplayState,
    SessionOrganizationFolderAssignmentEntry,
    SessionOrganizationTagAssignmentEntry,
    UiSessionOrganizationFolder,
    UiSessionOrganizationLabel,
    UiSessionOrganizationSnapshot,
    UiSessionOrganizationTag,
} from '@/sync/domains/session/organization';

import type { StoreGet, StoreSet } from './_shared';

export type SessionFolderAssignment = Readonly<{
    sessionId: string;
    folderId: string | null;
}>;

export type SessionOrganizationOptimisticRecord = Readonly<{
    id: string;
    serverId: string;
    createdAt: number;
    before: Partial<Pick<
        SessionOrganizationDomain,
        | 'sessionOrganizationPinsBySessionKey'
        | 'sessionOrganizationAttentionStandingsBySessionKey'
        | 'sessionOrganizationFoldersByFolderKey'
        | 'sessionOrganizationTagsByTagKey'
        | 'sessionOrganizationLabelsByLabelKey'
        | 'sessionOrganizationOrderEntriesByScopeKey'
        | 'sessionOrganizationTagAssignmentsBySessionKey'
        | 'sessionOrganizationFolderAssignmentsBySessionKey'
    >>;
    after: Partial<Pick<
        SessionOrganizationDomain,
        | 'sessionOrganizationPinsBySessionKey'
        | 'sessionOrganizationAttentionStandingsBySessionKey'
        | 'sessionOrganizationFoldersByFolderKey'
        | 'sessionOrganizationTagsByTagKey'
        | 'sessionOrganizationLabelsByLabelKey'
        | 'sessionOrganizationOrderEntriesByScopeKey'
        | 'sessionOrganizationTagAssignmentsBySessionKey'
        | 'sessionOrganizationFolderAssignmentsBySessionKey'
    >>;
}>;

/**
 * The record maps a server response can confirm one key of. Confirmation is per key, so a response
 * never republishes a whole map over writes that happened while it was in flight.
 */
export type SessionOrganizationConfirmableMapName =
    | 'sessionOrganizationPinsBySessionKey'
    | 'sessionOrganizationAttentionStandingsBySessionKey'
    | 'sessionOrganizationFolderAssignmentsBySessionKey'
    | 'sessionOrganizationTagAssignmentsBySessionKey';

export type SessionOrganizationDomain = {
    sessionOrganizationSchemaVersionByServerId: Record<string, number>;
    sessionOrganizationSnapshotVersionByServerId: Record<string, number>;
    sessionOrganizationPinsBySessionKey: Record<string, SessionOrganizationPin>;
    sessionOrganizationAttentionStandingsBySessionKey: Record<string, SessionAttentionStanding>;
    sessionOrganizationFoldersByFolderKey: Record<string, UiSessionOrganizationFolder>;
    sessionOrganizationFolderAssignmentsBySessionKey: Record<string, SessionOrganizationFolderAssignmentEntry>;
    sessionOrganizationTagsByTagKey: Record<string, UiSessionOrganizationTag>;
    sessionOrganizationTagAssignmentsBySessionKey: Record<string, SessionOrganizationTagAssignmentEntry>;
    sessionOrganizationOrderEntriesByScopeKey: Record<string, readonly SessionOrganizationOrderEntry[]>;
    sessionOrganizationLabelsByLabelKey: Record<string, UiSessionOrganizationLabel>;
    sessionOrganizationLoadingByServerId: Record<string, boolean>;
    sessionOrganizationErrorByServerId: Record<string, string | null>;
    sessionOrganizationOptimisticRecords: Record<string, SessionOrganizationOptimisticRecord>;
    applySessionOrganizationSnapshot: (
        serverId: string,
        snapshot: SessionOrganizationSnapshot | UiSessionOrganizationSnapshot,
        options?: SessionOrganizationSnapshotApplyOptions,
    ) => void;
    setSessionOrganizationLoading: (serverId: string, loading: boolean) => void;
    setSessionOrganizationError: (serverId: string, error: string | null) => void;
    setSessionPinOptimistic: (serverId: string, sessionId: string, pin: SessionOrganizationPin | null) => string;
    setSessionAttentionStandingOptimistic: (serverId: string, sessionId: string, standing: SessionAttentionStanding | null) => string;
    setSessionOrganizationFolderAssignmentOptimistic: (serverId: string, sessionId: string, folderId: string | null) => string;
    setSessionTagAssignmentsOptimistic: (serverId: string, sessionId: string, tagIds: readonly string[]) => string;
    upsertSessionOrganizationFolderOptimistic: (serverId: string, folder: UiSessionOrganizationFolder) => string;
    deleteSessionOrganizationFolderOptimistic: (serverId: string, folderId: string) => string;
    upsertSessionOrganizationTagOptimistic: (serverId: string, tag: UiSessionOrganizationTag) => string;
    deleteSessionOrganizationTagOptimistic: (serverId: string, tagId: string) => string;
    upsertSessionOrganizationLabelOptimistic: (serverId: string, label: UiSessionOrganizationLabel) => string;
    deleteSessionOrganizationLabelOptimistic: (serverId: string, labelKind: UiSessionOrganizationLabel['labelKind'], scopeKey: string) => string;
    applySessionOrganizationOrderEntriesOptimistic: (serverId: string, entries: readonly SessionOrganizationOrderEntry[]) => string;
    reconcileSessionOrganizationFolderDelete: (serverId: string, deletedFolderIds: readonly string[], assignmentTargetFolderId: string | null) => void;
    reconcileSessionOrganizationTagDelete: (serverId: string, tagId: string) => void;
    rollbackSessionOrganizationOptimistic: (recordId: string) => void;
    commitSessionOrganizationOptimistic: (recordId: string) => void;
    confirmSessionOrganizationOptimistic: <K extends SessionOrganizationConfirmableMapName>(
        recordId: string,
        map: K,
        key: string,
        value: SessionOrganizationDomain[K][string] | null,
    ) => void;
    clearSessionOrganizationForServer: (serverId: string) => void;
    applySessionFolderAssignments: (serverId: string, assignments: readonly SessionFolderAssignment[]) => void;
    setSessionFolderAssignmentsLoading: (serverId: string, loading: boolean) => void;
    setSessionFolderAssignmentOptimistic: (serverId: string, sessionId: string, folderId: string | null) => string | null;
    rollbackSessionFolderAssignment: (serverId: string, sessionId: string, previousFolderId: string | null) => void;
    clearSessionFolderAssignmentsForServer: (serverId: string) => void;
};

let optimisticRecordCounter = 0;

function nextOptimisticRecordId(): string {
    optimisticRecordCounter += 1;
    return `session-organization-optimistic-${optimisticRecordCounter}`;
}

function deriveDisplayState(
    display: UiSessionOrganizationFolder['display'],
) {
    if (!display) return { status: 'available', value: null } as const;
    if (display.t === 'plain') {
        return { status: 'available', value: display.v } as const;
    }
    return {
        status: 'locked',
        reason: 'account_key_unavailable',
    } as const;
}

function normalizeDisplayState(
    display: UiSessionOrganizationFolder['display'],
    displayState: SessionOrganizationDisplayState | ProtocolSessionOrganizationDisplayState | undefined,
): SessionOrganizationDisplayState {
    if (!displayState) return deriveDisplayState(display);
    if (displayState.status === 'unavailable') {
        return {
            status: 'locked',
            reason: displayState.reason,
        };
    }
    return displayState;
}

function normalizeUiSessionOrganizationSnapshot(
    snapshot: SessionOrganizationSnapshot | UiSessionOrganizationSnapshot,
): UiSessionOrganizationSnapshot {
    return {
        ...snapshot,
        folders: snapshot.folders.map((folder) => ({
            ...folder,
            displayState: normalizeDisplayState(folder.display, folder.displayState),
        })),
        tags: snapshot.tags.map((tag) => ({
            ...tag,
            displayState: normalizeDisplayState(tag.display, tag.displayState),
        })),
        labels: snapshot.labels.map((label) => ({
            ...label,
            displayState: normalizeDisplayState(label.display, label.displayState),
        })),
    };
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(record, key);
}

function shallowEqualValue(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
    const aEntries = Object.entries(a);
    const bRecord = b as Record<string, unknown>;
    if (aEntries.length !== Object.keys(bRecord).length) return false;
    return aEntries.every(([key, value]) => bRecord[key] === value);
}

function entriesEqual<T>(a: readonly T[] | undefined, b: readonly T[]): boolean {
    if (!a || a.length !== b.length) return false;
    return a.every((entry, index) => shallowEqualValue(entry, b[index]));
}

function replaceServerRecord<T>(
    current: Record<string, T>,
    serverId: string,
    entries: Iterable<readonly [string, T]>,
): Record<string, T> {
    const next: Record<string, T> = {};
    for (const [key, value] of Object.entries(current)) {
        if (!sessionOrganizationTupleKeyBelongsToServer(key, serverId)) {
            next[key] = value;
        }
    }
    for (const [id, value] of entries) {
        next[buildSessionOrganizationServerKey(serverId, id)] = value;
    }
    if (Object.keys(next).length !== Object.keys(current).length) return next;
    for (const [key, value] of Object.entries(next)) {
        if (!shallowEqualValue(current[key], value)) return next;
    }
    return current;
}

function replaceEntityRecord<T>(
    current: Record<string, T>,
    serverId: string,
    entries: Iterable<readonly [string, T]>,
    readId: (value: T) => string,
): Record<string, T> {
    const next: Record<string, T> = {};
    for (const [key, value] of Object.entries(current)) {
        if (key !== buildSessionOrganizationServerKey(serverId, readId(value))) next[key] = value;
    }
    for (const [id, value] of entries) next[buildSessionOrganizationServerKey(serverId, id)] = value;
    if (Object.keys(next).length !== Object.keys(current).length) return next;
    for (const [key, value] of Object.entries(next)) {
        if (!shallowEqualValue(current[key], value)) return next;
    }
    return current;
}

function replaceSessionRecord<T>(
    current: Record<string, T>,
    serverId: string,
    entries: Iterable<readonly [string, T]>,
    readSessionId: (value: T) => string,
): Record<string, T> {
    const next: Record<string, T> = {};
    for (const [key, value] of Object.entries(current)) {
        if (key !== buildSessionOrganizationSessionKey(serverId, readSessionId(value))) {
            next[key] = value;
        }
    }
    for (const [sessionId, value] of entries) {
        next[buildSessionOrganizationSessionKey(serverId, sessionId)] = value;
    }
    if (Object.keys(next).length !== Object.keys(current).length) return next;
    for (const [key, value] of Object.entries(next)) {
        if (!shallowEqualValue(current[key], value)) return next;
    }
    return current;
}

function normalizeRequestedRecordIds(ids: readonly string[] | undefined): Set<string> {
    return new Set(
        (ids ?? [])
            .map((id) => String(id ?? '').trim())
            .filter(Boolean),
    );
}

function replaceRequestedServerRecord<T>(
    current: Record<string, T>,
    serverId: string,
    requestedIds: readonly string[] | undefined,
    entries: Iterable<readonly [string, T]>,
    readId: (value: T) => string,
): Record<string, T> {
    const requestedIdsSet = normalizeRequestedRecordIds(requestedIds);
    if (requestedIdsSet.size === 0) {
        return replaceEntityRecord(current, serverId, entries, readId);
    }

    const next: Record<string, T> = { ...current };
    for (const id of requestedIdsSet) {
        delete next[buildSessionOrganizationServerKey(serverId, id)];
    }
    for (const [id, value] of entries) {
        if (!requestedIdsSet.has(String(id ?? '').trim())) continue;
        next[buildSessionOrganizationServerKey(serverId, id)] = value;
    }

    if (Object.keys(next).length !== Object.keys(current).length) return next;
    for (const [key, value] of Object.entries(next)) {
        if (!shallowEqualValue(current[key], value)) return next;
    }
    return current;
}

function mergeRecordEntries<T>(
    current: Record<string, T>,
    entries: Iterable<readonly [string, T]>,
): Record<string, T> {
    let next: Record<string, T> | null = null;
    for (const [key, value] of entries) {
        if (shallowEqualValue(current[key], value)) continue;
        next ??= { ...current };
        next[key] = value;
    }
    return next ?? current;
}

function removeServerRecordEntries<T>(current: Record<string, T>, serverId: string): Record<string, T> {
    let changed = false;
    const next: Record<string, T> = {};
    for (const [key, value] of Object.entries(current)) {
        if (sessionOrganizationTupleKeyBelongsToServer(key, serverId)) {
            changed = true;
            continue;
        }
        next[key] = value;
    }
    return changed ? next : current;
}

function removeSessionRecordEntries<T>(
    current: Record<string, T>,
    serverId: string,
    readSessionId: (value: T) => string,
): Record<string, T> {
    let changed = false;
    const next: Record<string, T> = {};
    for (const [key, value] of Object.entries(current)) {
        if (key === buildSessionOrganizationSessionKey(serverId, readSessionId(value))) {
            changed = true;
            continue;
        }
        next[key] = value;
    }
    return changed ? next : current;
}

function removeEntityRecordEntries<T>(
    current: Record<string, T>,
    serverId: string,
    readId: (value: T) => string,
): Record<string, T> {
    let changed = false;
    const next: Record<string, T> = {};
    for (const [key, value] of Object.entries(current)) {
        if (key === buildSessionOrganizationServerKey(serverId, readId(value))) {
            changed = true;
            continue;
        }
        next[key] = value;
    }
    return changed ? next : current;
}

function removeRecordKeys<T>(current: Record<string, T>, keys: readonly string[]): Record<string, T> {
    let next: Record<string, T> | null = null;
    for (const key of keys) {
        if (!hasOwn(current, key)) continue;
        next ??= { ...current };
        delete next[key];
    }
    return next ?? current;
}

function setRecordValue<T>(current: Record<string, T>, key: string, value: T | undefined): Record<string, T> {
    if (value === undefined) {
        if (!hasOwn(current, key)) return current;
        const next = { ...current };
        delete next[key];
        return next;
    }
    if (shallowEqualValue(current[key], value)) return current;
    return { ...current, [key]: value };
}

function replaceRequestedAssignments(
    current: Record<string, SessionOrganizationFolderAssignmentEntry>,
    serverId: string,
    requestedSessionIds: readonly string[] | undefined,
    requestedFolderIds: readonly string[] | undefined,
    assignments: readonly SessionFolderAssignment[],
    replaceAll: boolean | undefined,
): Record<string, SessionOrganizationFolderAssignmentEntry> {
    if (replaceAll) {
        // A full snapshot lists ASSIGNMENTS, not sessions: a session with no folder simply has
        // no row server-side. Pruning this server's other known keys would erase the negative
        // cache `filterMissingAssignmentSessionIds` reads, so every full snapshot would re-arm
        // an O(sessions) single-id refetch. Re-value the known keys instead of dropping them.
        const entries = new Map<string, SessionOrganizationFolderAssignmentEntry>();
        for (const [key, assignment] of Object.entries(current)) {
            if (key === buildSessionOrganizationSessionKey(serverId, assignment.sessionId)) {
                entries.set(key, { sessionId: assignment.sessionId, folderId: null });
            }
        }
        for (const assignment of assignments) {
            entries.set(buildSessionOrganizationSessionKey(serverId, assignment.sessionId), assignment);
        }
        return mergeRecordEntries(current, entries.entries());
    }
    const entries = new Map<string, SessionOrganizationFolderAssignmentEntry>();
    for (const sessionId of requestedSessionIds ?? []) {
        entries.set(buildSessionOrganizationSessionKey(serverId, sessionId), { sessionId, folderId: null });
    }
    for (const assignment of assignments) {
        entries.set(buildSessionOrganizationSessionKey(serverId, assignment.sessionId), assignment);
    }
    let next = mergeRecordEntries(current, entries.entries());
    const requestedFolders = new Set(
        (requestedFolderIds ?? [])
            .map((folderId) => String(folderId ?? '').trim())
            .filter(Boolean),
    );
    if (requestedFolders.size > 0) {
        const returnedKeys = new Set(assignments.map((assignment) => buildSessionOrganizationSessionKey(serverId, assignment.sessionId)));
        const staleClears: Array<readonly [string, SessionOrganizationFolderAssignmentEntry]> = [];
        for (const [key, assignment] of Object.entries(next)) {
            if (key !== buildSessionOrganizationSessionKey(serverId, assignment.sessionId)
                || !assignment.folderId
                || !requestedFolders.has(assignment.folderId)
                || returnedKeys.has(key)) continue;
            staleClears.push([key, { sessionId: assignment.sessionId, folderId: null }] as const);
        }
        next = mergeRecordEntries(next, staleClears);
    }
    return next;
}

function replaceRequestedTagAssignments(
    current: Record<string, SessionOrganizationTagAssignmentEntry>,
    serverId: string,
    requestedSessionIds: readonly string[] | undefined,
    requestedTagIds: readonly string[] | undefined,
    assignments: readonly { sessionId: string; tagIds: readonly string[] }[],
    replaceAll: boolean | undefined,
): Record<string, SessionOrganizationTagAssignmentEntry> {
    if (replaceAll) {
        return replaceSessionRecord(
            current,
            serverId,
            assignments.map((assignment) => [assignment.sessionId, assignment] as const),
            (assignment) => assignment.sessionId,
        );
    }
    const entries = new Map<string, SessionOrganizationTagAssignmentEntry>();
    for (const sessionId of requestedSessionIds ?? []) {
        entries.set(buildSessionOrganizationSessionKey(serverId, sessionId), { sessionId, tagIds: [] });
    }
    for (const assignment of assignments) {
        entries.set(buildSessionOrganizationSessionKey(serverId, assignment.sessionId), assignment);
    }
    let next = mergeRecordEntries(current, entries.entries());
    const requestedTags = new Set(
        (requestedTagIds ?? [])
            .map((tagId) => String(tagId ?? '').trim())
            .filter(Boolean),
    );
    if (requestedTags.size > 0) {
        const returnedKeys = new Set(assignments.map((assignment) => buildSessionOrganizationSessionKey(serverId, assignment.sessionId)));
        const staleUpdates: Array<readonly [string, SessionOrganizationTagAssignmentEntry]> = [];
        for (const [key, assignment] of Object.entries(next)) {
            if (key !== buildSessionOrganizationSessionKey(serverId, assignment.sessionId) || returnedKeys.has(key)) continue;
            const filtered = assignment.tagIds.filter((tagId) => !requestedTags.has(tagId));
            if (filtered.length !== assignment.tagIds.length) {
                staleUpdates.push([key, { sessionId: assignment.sessionId, tagIds: filtered }] as const);
            }
        }
        next = mergeRecordEntries(next, staleUpdates);
    }
    return next;
}

function replaceOrderEntries(
    current: Record<string, readonly SessionOrganizationOrderEntry[]>,
    serverId: string,
    entries: readonly SessionOrganizationOrderEntry[],
    options?: SessionOrganizationSnapshotApplyOptions,
): Record<string, readonly SessionOrganizationOrderEntry[]> {
    const grouped = new Map<string, SessionOrganizationOrderEntry[]>();
    for (const entry of entries) {
        const key = buildSessionOrganizationOrderScopeKey({ serverId, scopeKind: entry.scopeKind, scopeKey: entry.scopeKey });
        const group = grouped.get(key) ?? [];
        group.push(entry);
        grouped.set(key, group);
    }
    if (options?.orderScopes && options.orderScopes.length > 0) {
        let next = current;
        for (const scope of options.orderScopes) {
            const key = buildSessionOrganizationOrderScopeKey({ serverId, scopeKind: scope.scopeKind, scopeKey: scope.scopeKey });
            const value = grouped.get(key) ?? [];
            if (!entriesEqual(next[key], value)) {
                next = { ...next, [key]: value };
            }
        }
        return next;
    }
    const next: Record<string, readonly SessionOrganizationOrderEntry[]> = {};
    for (const [key, value] of Object.entries(current)) {
        if (!sessionOrganizationTupleKeyBelongsToServer(key, serverId)) {
            next[key] = value;
        }
    }
    for (const [key, value] of grouped.entries()) {
        next[key] = value;
    }
    if (Object.keys(next).length !== Object.keys(current).length) return next;
    for (const [key, value] of Object.entries(next)) {
        if (!entriesEqual(current[key], value)) return next;
    }
    return current;
}

function createOptimisticRecord(params: Readonly<{
    serverId: string;
    before: SessionOrganizationOptimisticRecord['before'];
    after?: SessionOrganizationOptimisticRecord['after'];
}>): SessionOrganizationOptimisticRecord {
    return {
        id: nextOptimisticRecordId(),
        serverId: params.serverId,
        createdAt: Date.now(),
        before: params.before,
        after: params.after ?? {},
    };
}

function addOptimisticRecord<S extends SessionOrganizationDomain>(
    state: S,
    record: SessionOrganizationOptimisticRecord,
): Pick<S, 'sessionOrganizationOptimisticRecords'> {
    return {
        sessionOrganizationOptimisticRecords: {
            ...state.sessionOrganizationOptimisticRecords,
            [record.id]: record,
        },
    } as Pick<S, 'sessionOrganizationOptimisticRecords'>;
}

function readOptimisticRecordSequence(record: SessionOrganizationOptimisticRecord): number {
    const sequence = Number(record.id.split('-').at(-1));
    return Number.isFinite(sequence) ? sequence : 0;
}

function sortOptimisticRecords(records: Iterable<SessionOrganizationOptimisticRecord>): SessionOrganizationOptimisticRecord[] {
    return Array.from(records).sort((left, right) => (
        left.createdAt - right.createdAt
        || readOptimisticRecordSequence(left) - readOptimisticRecordSequence(right)
        || left.id.localeCompare(right.id)
    ));
}

function applyRecordDelta<T>(
    current: Record<string, T>,
    before: Record<string, T> | undefined,
    after: Record<string, T> | undefined,
): Record<string, T> {
    if (!before || !after) return current;
    let next = current;
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of keys) {
        const hasAfter = hasOwn(after as Record<string, unknown>, key);
        const afterValue = after[key];
        if (hasAfter && shallowEqualValue(before[key], afterValue)) continue;
        next = setRecordValue(next, key, hasAfter ? afterValue : undefined);
    }
    return next;
}

/**
 * Undo one record's own keys, and only while it still owns them. A key a later write already
 * replaced — a newer optimistic change, or a confirmed server response — belongs to that write,
 * not to the failure being rolled back, so reverting it would erase newer local truth.
 */
function undoRecordDelta<T>(
    current: Record<string, T>,
    before: Record<string, T> | undefined,
    after: Record<string, T> | undefined,
): Record<string, T> {
    if (!before || !after) return current;
    let next = current;
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of keys) {
        const hasAfter = hasOwn(after as Record<string, unknown>, key);
        const ownedValue = hasAfter ? after[key] : undefined;
        if (!shallowEqualValue(next[key], ownedValue)) continue;
        const hasBefore = hasOwn(before as Record<string, unknown>, key);
        if (hasBefore && shallowEqualValue(before[key], ownedValue)) continue;
        next = setRecordValue(next, key, hasBefore ? before[key] : undefined);
    }
    return next;
}

function rebaseRemainingOptimisticRecords<S extends SessionOrganizationDomain>(
    state: S,
    rolledBackRecord: SessionOrganizationOptimisticRecord,
    remainingRecords: Record<string, SessionOrganizationOptimisticRecord>,
): Partial<S> {
    // Undo only the keys this record actually changed. Restoring its whole `before` map would
    // also erase every write that committed after it — a failed mutation on one Session would
    // roll back an unrelated Session's confirmed pin, folder, tag, order or reminder.
    const pins = undoRecordDelta(
        state.sessionOrganizationPinsBySessionKey,
        rolledBackRecord.before.sessionOrganizationPinsBySessionKey,
        rolledBackRecord.after.sessionOrganizationPinsBySessionKey,
    );
    const attentionStandings = undoRecordDelta(
        state.sessionOrganizationAttentionStandingsBySessionKey,
        rolledBackRecord.before.sessionOrganizationAttentionStandingsBySessionKey,
        rolledBackRecord.after.sessionOrganizationAttentionStandingsBySessionKey,
    );
    const folders = undoRecordDelta(
        state.sessionOrganizationFoldersByFolderKey,
        rolledBackRecord.before.sessionOrganizationFoldersByFolderKey,
        rolledBackRecord.after.sessionOrganizationFoldersByFolderKey,
    );
    const tags = undoRecordDelta(
        state.sessionOrganizationTagsByTagKey,
        rolledBackRecord.before.sessionOrganizationTagsByTagKey,
        rolledBackRecord.after.sessionOrganizationTagsByTagKey,
    );
    const labels = undoRecordDelta(
        state.sessionOrganizationLabelsByLabelKey,
        rolledBackRecord.before.sessionOrganizationLabelsByLabelKey,
        rolledBackRecord.after.sessionOrganizationLabelsByLabelKey,
    );
    const orderEntries = undoRecordDelta(
        state.sessionOrganizationOrderEntriesByScopeKey,
        rolledBackRecord.before.sessionOrganizationOrderEntriesByScopeKey,
        rolledBackRecord.after.sessionOrganizationOrderEntriesByScopeKey,
    );
    const tagAssignments = undoRecordDelta(
        state.sessionOrganizationTagAssignmentsBySessionKey,
        rolledBackRecord.before.sessionOrganizationTagAssignmentsBySessionKey,
        rolledBackRecord.after.sessionOrganizationTagAssignmentsBySessionKey,
    );
    const organizationFolderAssignments = undoRecordDelta(
        state.sessionOrganizationFolderAssignmentsBySessionKey,
        rolledBackRecord.before.sessionOrganizationFolderAssignmentsBySessionKey,
        rolledBackRecord.after.sessionOrganizationFolderAssignmentsBySessionKey,
    );

    // Later writes already own their visible values. Replaying them here could overwrite a
    // still newer confirmed value. Only remove the failed write from their rollback baselines,
    // otherwise a later failure would resurrect this failed write.
    const records = { ...remainingRecords };
    for (const record of Object.values(records)) {
        if (readOptimisticRecordSequence(record) <= readOptimisticRecordSequence(rolledBackRecord)) continue;
        const before = { ...record.before };
        const after = { ...record.after };
        const rebaseMap = <K extends keyof SessionOrganizationOptimisticRecord['before']>(key: K) => {
            const originalBefore = record.before[key];
            const originalAfter = record.after[key];
            if (!originalBefore || !originalAfter) return;
            const rebasedBefore = undoRecordDelta<unknown>(originalBefore, rolledBackRecord.before[key], rolledBackRecord.after[key]);
            // Both maps retain the same K's values; the generic delta functions change keys only.
            before[key] = rebasedBefore as SessionOrganizationOptimisticRecord['before'][K];
            after[key] = applyRecordDelta<unknown>(rebasedBefore, originalBefore, originalAfter) as SessionOrganizationOptimisticRecord['after'][K];
        };
        rebaseMap('sessionOrganizationPinsBySessionKey');
        rebaseMap('sessionOrganizationAttentionStandingsBySessionKey');
        rebaseMap('sessionOrganizationFoldersByFolderKey');
        rebaseMap('sessionOrganizationTagsByTagKey');
        rebaseMap('sessionOrganizationLabelsByLabelKey');
        rebaseMap('sessionOrganizationOrderEntriesByScopeKey');
        rebaseMap('sessionOrganizationTagAssignmentsBySessionKey');
        rebaseMap('sessionOrganizationFolderAssignmentsBySessionKey');
        records[record.id] = { ...record, before, after };
    }

    return {
        sessionOrganizationPinsBySessionKey: pins,
        sessionOrganizationAttentionStandingsBySessionKey: attentionStandings,
        sessionOrganizationFoldersByFolderKey: folders,
        sessionOrganizationTagsByTagKey: tags,
        sessionOrganizationLabelsByLabelKey: labels,
        sessionOrganizationOrderEntriesByScopeKey: orderEntries,
        sessionOrganizationTagAssignmentsBySessionKey: tagAssignments,
        sessionOrganizationFolderAssignmentsBySessionKey: organizationFolderAssignments,
        sessionOrganizationOptimisticRecords: records,
    } as Partial<S>;
}

export function createSessionOrganizationDomain<S extends SessionOrganizationDomain>({
    set,
    get,
}: {
    set: StoreSet<S>;
    get: StoreGet<S>;
}): SessionOrganizationDomain {
    const applyFolderAssignments = (serverId: string, assignments: readonly SessionFolderAssignment[]) => {
        set((state) => {
            const nextAssignments = mergeRecordEntries(
                state.sessionOrganizationFolderAssignmentsBySessionKey,
                assignments.map((assignment) => [
                    buildSessionOrganizationSessionKey(serverId, assignment.sessionId),
                    assignment,
                ] as const),
            );
            if (nextAssignments === state.sessionOrganizationFolderAssignmentsBySessionKey) return state;
            return {
                sessionOrganizationFolderAssignmentsBySessionKey: nextAssignments,
            } as Partial<S>;
        });
    };

    return {
        sessionOrganizationSnapshotVersionByServerId: {},
        sessionOrganizationSchemaVersionByServerId: {},
        sessionOrganizationPinsBySessionKey: {},
        sessionOrganizationAttentionStandingsBySessionKey: {},
        sessionOrganizationFoldersByFolderKey: {},
        sessionOrganizationFolderAssignmentsBySessionKey: {},
        sessionOrganizationTagsByTagKey: {},
        sessionOrganizationTagAssignmentsBySessionKey: {},
        sessionOrganizationOrderEntriesByScopeKey: {},
        sessionOrganizationLabelsByLabelKey: {},
        sessionOrganizationLoadingByServerId: {},
        sessionOrganizationErrorByServerId: {},
        sessionOrganizationOptimisticRecords: {},
        applySessionOrganizationSnapshot: (serverId, snapshot, options) => {
            const uiSnapshot =
                normalizeUiSessionOrganizationSnapshot(snapshot);
            set((state) => {
                const currentVersion = state.sessionOrganizationSnapshotVersionByServerId[serverId];
                if (typeof currentVersion === 'number' && uiSnapshot.version < currentVersion) {
                    return state;
                }
                const pins = replaceSessionRecord(
                    state.sessionOrganizationPinsBySessionKey,
                    serverId,
                    uiSnapshot.pins.map((pin) => [pin.sessionId, pin] as const),
                    (pin) => pin.sessionId,
                );
                // Standings only ride along when the request asked for them, so an absent
                // array means "not fetched" and must not clear what the store already knows.
                const attentionStandings = uiSnapshot.attentionStandings === undefined
                    ? state.sessionOrganizationAttentionStandingsBySessionKey
                    : replaceSessionRecord(
                        state.sessionOrganizationAttentionStandingsBySessionKey,
                        serverId,
                        uiSnapshot.attentionStandings.map((entry) => [entry.sessionId, entry] as const),
                        (entry) => entry.sessionId,
                    );
                const folders = options?.includeFolders === false
                    ? state.sessionOrganizationFoldersByFolderKey
                    : replaceRequestedServerRecord(
                        state.sessionOrganizationFoldersByFolderKey,
                        serverId,
                        options?.folderIds,
                        uiSnapshot.folders.map((folder) => [folder.folderId, folder] as const),
                        (folder) => folder.folderId,
                    );
                const folderAssignments = replaceRequestedAssignments(
                    state.sessionOrganizationFolderAssignmentsBySessionKey,
                    serverId,
                    options?.assignmentSessionIds,
                    options?.folderIds,
                    uiSnapshot.folderAssignments,
                    options?.includeAllFolderAssignments,
                );
                const tags = options?.includeTags === false
                    ? state.sessionOrganizationTagsByTagKey
                    : replaceRequestedServerRecord(
                        state.sessionOrganizationTagsByTagKey,
                        serverId,
                        options?.tagIds,
                        uiSnapshot.tags.map((tag) => [tag.tagId, tag] as const),
                        (tag) => tag.tagId,
                    );
                const tagAssignments = replaceRequestedTagAssignments(
                    state.sessionOrganizationTagAssignmentsBySessionKey,
                    serverId,
                    options?.assignmentSessionIds,
                    options?.tagIds,
                    uiSnapshot.tagAssignments,
                    options?.includeAllTagAssignments,
                );
                const labels = options?.includeLabels === false
                    ? state.sessionOrganizationLabelsByLabelKey
                    : replaceServerRecord(
                        state.sessionOrganizationLabelsByLabelKey,
                        serverId,
                        uiSnapshot.labels.map((label) => [
                            `${label.labelKind}:${label.scopeKey}`,
                            label,
                        ] as const),
                    );
                const orderEntries = replaceOrderEntries(
                    state.sessionOrganizationOrderEntriesByScopeKey,
                    serverId,
                    uiSnapshot.orderEntries,
                    options,
                );
                return {
                    sessionOrganizationSchemaVersionByServerId: {
                        ...state.sessionOrganizationSchemaVersionByServerId,
                        [serverId]: uiSnapshot.schemaVersion,
                    },
                    sessionOrganizationSnapshotVersionByServerId: {
                        ...state.sessionOrganizationSnapshotVersionByServerId,
                        [serverId]: uiSnapshot.version,
                    },
                    sessionOrganizationPinsBySessionKey: pins,
                    sessionOrganizationAttentionStandingsBySessionKey: attentionStandings,
                    sessionOrganizationFoldersByFolderKey: folders,
                    sessionOrganizationFolderAssignmentsBySessionKey: folderAssignments,
                    sessionOrganizationTagsByTagKey: tags,
                    sessionOrganizationTagAssignmentsBySessionKey: tagAssignments,
                    sessionOrganizationOrderEntriesByScopeKey: orderEntries,
                    sessionOrganizationLabelsByLabelKey: labels,
                } as Partial<S>;
            });
        },
        setSessionOrganizationLoading: (serverId, loading) => {
            set((state) => {
                const nextLoading = setRecordValue(state.sessionOrganizationLoadingByServerId, serverId, loading);
                if (nextLoading === state.sessionOrganizationLoadingByServerId) return state;
                return { sessionOrganizationLoadingByServerId: nextLoading } as Partial<S>;
            });
        },
        setSessionOrganizationError: (serverId, error) => {
            set((state) => {
                const errors = setRecordValue(state.sessionOrganizationErrorByServerId, serverId, error);
                if (errors === state.sessionOrganizationErrorByServerId) return state;
                return { sessionOrganizationErrorByServerId: errors } as Partial<S>;
            });
        },
        setSessionPinOptimistic: (serverId, sessionId, pin) => {
            const key = buildSessionOrganizationSessionKey(serverId, sessionId);
            const state = get();
            const afterPins = setRecordValue(state.sessionOrganizationPinsBySessionKey, key, pin ?? undefined);
            const record = createOptimisticRecord({
                serverId,
                before: { sessionOrganizationPinsBySessionKey: state.sessionOrganizationPinsBySessionKey },
                after: { sessionOrganizationPinsBySessionKey: afterPins },
            });
            set((current) => ({
                ...addOptimisticRecord(current, record),
                sessionOrganizationPinsBySessionKey: afterPins,
            }) as Partial<S>);
            return record.id;
        },
        setSessionAttentionStandingOptimistic: (serverId, sessionId, standing) => {
            const key = buildSessionOrganizationSessionKey(serverId, sessionId);
            const state = get();
            const afterStandings = setRecordValue(state.sessionOrganizationAttentionStandingsBySessionKey, key, standing ?? undefined);
            const record = createOptimisticRecord({
                serverId,
                before: { sessionOrganizationAttentionStandingsBySessionKey: state.sessionOrganizationAttentionStandingsBySessionKey },
                after: { sessionOrganizationAttentionStandingsBySessionKey: afterStandings },
            });
            set((current) => ({
                ...addOptimisticRecord(current, record),
                sessionOrganizationAttentionStandingsBySessionKey: afterStandings,
            }) as Partial<S>);
            return record.id;
        },
        setSessionOrganizationFolderAssignmentOptimistic: (serverId, sessionId, folderId) => {
            const key = buildSessionOrganizationSessionKey(serverId, sessionId);
            const state = get();
            const afterAssignments = setRecordValue(
                state.sessionOrganizationFolderAssignmentsBySessionKey,
                key,
                { sessionId, folderId },
            );
            const record = createOptimisticRecord({
                serverId,
                before: {
                    sessionOrganizationFolderAssignmentsBySessionKey: state.sessionOrganizationFolderAssignmentsBySessionKey,
                },
                after: {
                    sessionOrganizationFolderAssignmentsBySessionKey: afterAssignments,
                },
            });
            set((current) => ({
                ...addOptimisticRecord(current, record),
                sessionOrganizationFolderAssignmentsBySessionKey: afterAssignments,
            }) as Partial<S>);
            return record.id;
        },
        setSessionTagAssignmentsOptimistic: (serverId, sessionId, tagIds) => {
            const key = buildSessionOrganizationSessionKey(serverId, sessionId);
            const state = get();
            const afterTagAssignments = setRecordValue(
                state.sessionOrganizationTagAssignmentsBySessionKey,
                key,
                { sessionId, tagIds: [...tagIds] },
            );
            const record = createOptimisticRecord({
                serverId,
                before: { sessionOrganizationTagAssignmentsBySessionKey: state.sessionOrganizationTagAssignmentsBySessionKey },
                after: { sessionOrganizationTagAssignmentsBySessionKey: afterTagAssignments },
            });
            set((current) => ({
                ...addOptimisticRecord(current, record),
                sessionOrganizationTagAssignmentsBySessionKey: afterTagAssignments,
            }) as Partial<S>);
            return record.id;
        },
        upsertSessionOrganizationFolderOptimistic: (serverId, folder) => {
            const key = buildSessionOrganizationServerKey(serverId, folder.folderId);
            const state = get();
            const afterFolders = setRecordValue(state.sessionOrganizationFoldersByFolderKey, key, folder);
            const record = createOptimisticRecord({
                serverId,
                before: { sessionOrganizationFoldersByFolderKey: state.sessionOrganizationFoldersByFolderKey },
                after: { sessionOrganizationFoldersByFolderKey: afterFolders },
            });
            set((current) => ({
                ...addOptimisticRecord(current, record),
                sessionOrganizationFoldersByFolderKey: afterFolders,
            }) as Partial<S>);
            return record.id;
        },
        deleteSessionOrganizationFolderOptimistic: (serverId, folderId) => {
            const key = buildSessionOrganizationServerKey(serverId, folderId);
            const state = get();
            const afterFolders = removeRecordKeys(state.sessionOrganizationFoldersByFolderKey, [key]);
            const record = createOptimisticRecord({
                serverId,
                before: { sessionOrganizationFoldersByFolderKey: state.sessionOrganizationFoldersByFolderKey },
                after: { sessionOrganizationFoldersByFolderKey: afterFolders },
            });
            set((current) => ({
                ...addOptimisticRecord(current, record),
                sessionOrganizationFoldersByFolderKey: afterFolders,
            }) as Partial<S>);
            return record.id;
        },
        upsertSessionOrganizationTagOptimistic: (serverId, tag) => {
            const key = buildSessionOrganizationServerKey(serverId, tag.tagId);
            const state = get();
            const afterTags = setRecordValue(state.sessionOrganizationTagsByTagKey, key, tag);
            const record = createOptimisticRecord({
                serverId,
                before: { sessionOrganizationTagsByTagKey: state.sessionOrganizationTagsByTagKey },
                after: { sessionOrganizationTagsByTagKey: afterTags },
            });
            set((current) => ({
                ...addOptimisticRecord(current, record),
                sessionOrganizationTagsByTagKey: afterTags,
            }) as Partial<S>);
            return record.id;
        },
        deleteSessionOrganizationTagOptimistic: (serverId, tagId) => {
            const key = buildSessionOrganizationServerKey(serverId, tagId);
            const state = get();
            const afterTags = removeRecordKeys(state.sessionOrganizationTagsByTagKey, [key]);
            const record = createOptimisticRecord({
                serverId,
                before: { sessionOrganizationTagsByTagKey: state.sessionOrganizationTagsByTagKey },
                after: { sessionOrganizationTagsByTagKey: afterTags },
            });
            set((current) => ({
                ...addOptimisticRecord(current, record),
                sessionOrganizationTagsByTagKey: afterTags,
            }) as Partial<S>);
            return record.id;
        },
        upsertSessionOrganizationLabelOptimistic: (serverId, label) => {
            const key = buildSessionOrganizationLabelKey({
                serverId,
                labelKind: label.labelKind,
                scopeKey: label.scopeKey,
            });
            const state = get();
            const afterLabels = setRecordValue(state.sessionOrganizationLabelsByLabelKey, key, label);
            const record = createOptimisticRecord({
                serverId,
                before: { sessionOrganizationLabelsByLabelKey: state.sessionOrganizationLabelsByLabelKey },
                after: { sessionOrganizationLabelsByLabelKey: afterLabels },
            });
            set((current) => ({
                ...addOptimisticRecord(current, record),
                sessionOrganizationLabelsByLabelKey: afterLabels,
            }) as Partial<S>);
            return record.id;
        },
        deleteSessionOrganizationLabelOptimistic: (serverId, labelKind, scopeKey) => {
            const key = buildSessionOrganizationLabelKey({ serverId, labelKind, scopeKey });
            const state = get();
            const afterLabels = removeRecordKeys(state.sessionOrganizationLabelsByLabelKey, [key]);
            const record = createOptimisticRecord({
                serverId,
                before: { sessionOrganizationLabelsByLabelKey: state.sessionOrganizationLabelsByLabelKey },
                after: { sessionOrganizationLabelsByLabelKey: afterLabels },
            });
            set((current) => ({
                ...addOptimisticRecord(current, record),
                sessionOrganizationLabelsByLabelKey: afterLabels,
            }) as Partial<S>);
            return record.id;
        },
        applySessionOrganizationOrderEntriesOptimistic: (serverId, entries) => {
            const state = get();
            const afterOrderEntries = replaceOrderEntries(
                state.sessionOrganizationOrderEntriesByScopeKey,
                serverId,
                entries,
                { orderScopes: entries[0] ? [{ scopeKind: entries[0].scopeKind, scopeKey: entries[0].scopeKey }] : [] },
            );
            const record = createOptimisticRecord({
                serverId,
                before: { sessionOrganizationOrderEntriesByScopeKey: state.sessionOrganizationOrderEntriesByScopeKey },
                after: { sessionOrganizationOrderEntriesByScopeKey: afterOrderEntries },
            });
            set((current) => ({
                ...addOptimisticRecord(current, record),
                sessionOrganizationOrderEntriesByScopeKey: afterOrderEntries,
            }) as Partial<S>);
            return record.id;
        },
        reconcileSessionOrganizationFolderDelete: (serverId, deletedFolderIds, assignmentTargetFolderId) => {
            const deletedFolders = new Set(
                deletedFolderIds.map((folderId) => String(folderId ?? '').trim()).filter(Boolean),
            );
            if (deletedFolders.size === 0) return;
            set((state) => {
                const updates: Array<readonly [string, SessionOrganizationFolderAssignmentEntry]> = [];
                for (const [key, assignment] of Object.entries(state.sessionOrganizationFolderAssignmentsBySessionKey)) {
                    if (key !== buildSessionOrganizationSessionKey(serverId, assignment.sessionId)
                        || !assignment.folderId
                        || !deletedFolders.has(assignment.folderId)) continue;
                    updates.push([key, { sessionId: assignment.sessionId, folderId: assignmentTargetFolderId }] as const);
                }
                if (updates.length === 0) return state;
                const nextAssignments = mergeRecordEntries(state.sessionOrganizationFolderAssignmentsBySessionKey, updates);
                return {
                    sessionOrganizationFolderAssignmentsBySessionKey: nextAssignments,
                } as Partial<S>;
            });
        },
        reconcileSessionOrganizationTagDelete: (serverId, tagId) => {
            const deletedTagId = String(tagId ?? '').trim();
            if (!deletedTagId) return;
            set((state) => {
                const updates: Array<readonly [string, SessionOrganizationTagAssignmentEntry]> = [];
                for (const [key, assignment] of Object.entries(state.sessionOrganizationTagAssignmentsBySessionKey)) {
                    if (key !== buildSessionOrganizationSessionKey(serverId, assignment.sessionId)
                        || !assignment.tagIds.includes(deletedTagId)) continue;
                    updates.push([key, {
                        sessionId: assignment.sessionId,
                        tagIds: assignment.tagIds.filter((candidate) => candidate !== deletedTagId),
                    }] as const);
                }
                if (updates.length === 0) return state;
                return {
                    sessionOrganizationTagAssignmentsBySessionKey: mergeRecordEntries(
                        state.sessionOrganizationTagAssignmentsBySessionKey,
                        updates,
                    ),
                } as Partial<S>;
            });
        },
        rollbackSessionOrganizationOptimistic: (recordId) => {
            set((state) => {
                const record = state.sessionOrganizationOptimisticRecords[recordId];
                if (!record) return state;
                const nextRecords = { ...state.sessionOrganizationOptimisticRecords };
                delete nextRecords[recordId];
                return rebaseRemainingOptimisticRecords(state, record, nextRecords);
            });
        },
        commitSessionOrganizationOptimistic: (recordId) => {
            set((state) => {
                if (!state.sessionOrganizationOptimisticRecords[recordId]) return state;
                const nextRecords = { ...state.sessionOrganizationOptimisticRecords };
                delete nextRecords[recordId];
                return { sessionOrganizationOptimisticRecords: nextRecords } as Partial<S>;
            });
        },
        confirmSessionOrganizationOptimistic: (recordId, map, key, value) => {
            set((state) => {
                const record = state.sessionOrganizationOptimisticRecords[recordId];
                if (!record) return state;
                const nextRecords = { ...state.sessionOrganizationOptimisticRecords };
                delete nextRecords[recordId];
                // A later pending write must roll back to this server-confirmed value,
                // rather than resurrecting the optimistic value it replaced.
                for (const [id, later] of Object.entries(nextRecords)) {
                    if (readOptimisticRecordSequence(later) <= readOptimisticRecordSequence(record)) continue;
                    const before = later.before[map];
                    const after = later.after[map];
                    if (!before || !shallowEqualValue(before[key], record.after[map]?.[key])) continue;
                    nextRecords[id] = {
                        ...later,
                        before: { ...later.before, [map]: setRecordValue<unknown>(before, key, value ?? undefined) },
                        after: after && shallowEqualValue(after[key], before[key])
                            ? { ...later.after, [map]: setRecordValue<unknown>(after, key, value ?? undefined) }
                            : later.after,
                    };
                }
                // A response confirms the write it belongs to and nothing else. It is applied only
                // while this record's own value is still the current one for that key: a newer
                // mutation or an authoritative snapshot that already replaced it is never
                // overwritten by an older response, whatever order the responses settle in.
                const optimistic = record?.after[map];
                const stillCurrent = optimistic !== undefined && shallowEqualValue(state[map][key], optimistic[key]);
                if (!stillCurrent) return { sessionOrganizationOptimisticRecords: nextRecords } as Partial<S>;
                return {
                    sessionOrganizationOptimisticRecords: nextRecords,
                    [map]: setRecordValue<SessionOrganizationDomain[SessionOrganizationConfirmableMapName][string]>(
                        state[map], key, value ?? undefined,
                    ),
                } as Partial<S>;
            });
        },
        clearSessionOrganizationForServer: (serverId) => {
            set((state) => {
                const folderAssignments = removeSessionRecordEntries(
                    state.sessionOrganizationFolderAssignmentsBySessionKey,
                    serverId,
                    (assignment) => assignment.sessionId,
                );
                return {
                    sessionOrganizationSnapshotVersionByServerId: Object.fromEntries(
                        Object.entries(state.sessionOrganizationSnapshotVersionByServerId).filter(([key]) => key !== serverId),
                    ),
                    sessionOrganizationSchemaVersionByServerId: Object.fromEntries(
                        Object.entries(state.sessionOrganizationSchemaVersionByServerId).filter(([key]) => key !== serverId),
                    ),
                    sessionOrganizationPinsBySessionKey: removeSessionRecordEntries(
                        state.sessionOrganizationPinsBySessionKey,
                        serverId,
                        (pin) => pin.sessionId,
                    ),
                    sessionOrganizationAttentionStandingsBySessionKey: removeSessionRecordEntries(
                        state.sessionOrganizationAttentionStandingsBySessionKey,
                        serverId,
                        (standing) => standing.sessionId,
                    ),
                    sessionOrganizationFoldersByFolderKey: removeEntityRecordEntries(
                        state.sessionOrganizationFoldersByFolderKey,
                        serverId,
                        (folder) => folder.folderId,
                    ),
                    sessionOrganizationFolderAssignmentsBySessionKey: folderAssignments,
                    sessionOrganizationTagsByTagKey: removeEntityRecordEntries(
                        state.sessionOrganizationTagsByTagKey,
                        serverId,
                        (tag) => tag.tagId,
                    ),
                    sessionOrganizationTagAssignmentsBySessionKey: removeSessionRecordEntries(
                        state.sessionOrganizationTagAssignmentsBySessionKey,
                        serverId,
                        (assignment) => assignment.sessionId,
                    ),
                    sessionOrganizationOrderEntriesByScopeKey: removeServerRecordEntries(state.sessionOrganizationOrderEntriesByScopeKey, serverId),
                    sessionOrganizationLabelsByLabelKey: removeServerRecordEntries(state.sessionOrganizationLabelsByLabelKey, serverId),
                    sessionOrganizationLoadingByServerId: Object.fromEntries(
                        Object.entries(state.sessionOrganizationLoadingByServerId).filter(([key]) => key !== serverId),
                    ),
                    sessionOrganizationErrorByServerId: Object.fromEntries(
                        Object.entries(state.sessionOrganizationErrorByServerId).filter(([key]) => key !== serverId),
                    ),
                } as Partial<S>;
            });
        },
        applySessionFolderAssignments: applyFolderAssignments,
        setSessionFolderAssignmentsLoading: (serverId, loading) => {
            get().setSessionOrganizationLoading(serverId, loading);
        },
        setSessionFolderAssignmentOptimistic: (serverId, sessionId, folderId) => {
            const key = buildSessionOrganizationSessionKey(serverId, sessionId);
            const previous = get().sessionOrganizationFolderAssignmentsBySessionKey[key]?.folderId ?? null;
            set((state) => {
                const nextAssignments = setRecordValue(
                    state.sessionOrganizationFolderAssignmentsBySessionKey,
                    key,
                    { sessionId, folderId },
                );
                return {
                    sessionOrganizationFolderAssignmentsBySessionKey: nextAssignments,
                } as Partial<S>;
            });
            return previous;
        },
        rollbackSessionFolderAssignment: (serverId, sessionId, previousFolderId) => {
            const key = buildSessionOrganizationSessionKey(serverId, sessionId);
            set((state) => {
                const nextAssignments = setRecordValue(
                    state.sessionOrganizationFolderAssignmentsBySessionKey,
                    key,
                    { sessionId, folderId: previousFolderId },
                );
                return {
                    sessionOrganizationFolderAssignmentsBySessionKey: nextAssignments,
                } as Partial<S>;
            });
        },
        clearSessionFolderAssignmentsForServer: (serverId) => {
            get().clearSessionOrganizationForServer(serverId);
        },
    };
}
