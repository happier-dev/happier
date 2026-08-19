import type {
    SessionAttentionStanding,
    SessionOrganizationFolder,
    SessionOrganizationLabel,
    SessionOrganizationOrderEntry,
    SessionOrganizationPin,
    SessionOrganizationSnapshot,
    SessionOrganizationTag,
} from '@happier-dev/protocol';

import {
    buildSessionOrganizationLabelKey,
    buildSessionOrganizationOrderScopeKey,
    buildSessionOrganizationServerKey,
} from '@/sync/domains/session/organization';
import type { SessionOrganizationSnapshotApplyOptions } from '@/sync/domains/session/organization';

import type { StoreGet, StoreSet } from './_shared';

export type SessionFolderAssignment = Readonly<{
    sessionId: string;
    folderId: string | null;
}>;

export type UiSessionOrganizationSnapshot = SessionOrganizationSnapshot;

export type SessionOrganizationOrderScopeMutation = Readonly<{
    scopeKind: SessionOrganizationOrderEntry['scopeKind'];
    scopeKey: string;
    entries: readonly SessionOrganizationOrderEntry[];
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
        | 'sessionFolderAssignmentsBySessionKey'
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
        | 'sessionFolderAssignmentsBySessionKey'
    >>;
}>;

export type SessionOrganizationDomain = {
    sessionOrganizationSchemaVersionByServerId: Record<string, number>;
    sessionOrganizationSnapshotVersionByServerId: Record<string, number>;
    sessionOrganizationPinsBySessionKey: Record<string, SessionOrganizationPin>;
    sessionOrganizationAttentionStandingsBySessionKey: Record<string, SessionAttentionStanding>;
    sessionOrganizationFoldersByFolderKey: Record<string, SessionOrganizationFolder>;
    sessionOrganizationFolderAssignmentsBySessionKey: Record<string, string | null>;
    sessionOrganizationTagsByTagKey: Record<string, SessionOrganizationTag>;
    sessionOrganizationTagAssignmentsBySessionKey: Record<string, readonly string[]>;
    sessionOrganizationOrderEntriesByScopeKey: Record<string, readonly SessionOrganizationOrderEntry[]>;
    sessionOrganizationLabelsByLabelKey: Record<string, SessionOrganizationLabel>;
    sessionOrganizationLoadingByServerId: Record<string, boolean>;
    sessionOrganizationErrorByServerId: Record<string, string | null>;
    sessionOrganizationOptimisticRecords: Record<string, SessionOrganizationOptimisticRecord>;
    sessionFolderAssignmentsBySessionKey: Record<string, string | null>;
    sessionFolderAssignmentsLoadingByServerId: Record<string, boolean>;
    applySessionOrganizationSnapshot: (serverId: string, snapshot: UiSessionOrganizationSnapshot, options?: SessionOrganizationSnapshotApplyOptions) => void;
    setSessionOrganizationLoading: (serverId: string, loading: boolean) => void;
    setSessionOrganizationError: (serverId: string, error: string | null) => void;
    setSessionPinOptimistic: (serverId: string, sessionId: string, pin: SessionOrganizationPin | null) => string;
    setSessionAttentionStandingOptimistic: (serverId: string, sessionId: string, standing: SessionAttentionStanding | null) => string;
    setSessionOrganizationFolderAssignmentOptimistic: (serverId: string, sessionId: string, folderId: string | null) => string;
    setSessionTagAssignmentsOptimistic: (serverId: string, sessionId: string, tagIds: readonly string[]) => string;
    upsertSessionOrganizationFolderOptimistic: (serverId: string, folder: SessionOrganizationFolder) => string;
    deleteSessionOrganizationFolderOptimistic: (serverId: string, folderId: string) => string;
    upsertSessionOrganizationTagOptimistic: (serverId: string, tag: SessionOrganizationTag) => string;
    deleteSessionOrganizationTagOptimistic: (serverId: string, tagId: string) => string;
    upsertSessionOrganizationLabelOptimistic: (serverId: string, label: SessionOrganizationLabel) => string;
    deleteSessionOrganizationLabelOptimistic: (serverId: string, labelKind: SessionOrganizationLabel['labelKind'], scopeKey: string) => string;
    applySessionOrganizationOrderScopeOptimistic: (serverId: string, scope: SessionOrganizationOrderScopeMutation) => string;
    applySessionOrganizationOrderEntriesOptimistic: (serverId: string, entries: readonly SessionOrganizationOrderEntry[]) => string;
    moveSessionFolderAssignmentsOptimistic: (serverId: string, fromFolderIds: readonly string[], toFolderId: string | null) => string | null;
    reconcileSessionOrganizationFolderDelete: (serverId: string, deletedFolderIds: readonly string[], assignmentTargetFolderId: string | null) => void;
    reconcileSessionOrganizationTagDelete: (serverId: string, tagId: string) => void;
    rollbackSessionOrganizationOptimistic: (recordId: string) => void;
    commitSessionOrganizationOptimistic: (recordId: string) => void;
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
    const prefix = `${String(serverId).trim()}:`;
    const next: Record<string, T> = {};
    for (const [key, value] of Object.entries(current)) {
        if (!key.startsWith(prefix)) {
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
    const prefix = `${String(serverId).trim()}:`;
    let changed = false;
    const next: Record<string, T> = {};
    for (const [key, value] of Object.entries(current)) {
        if (key.startsWith(prefix)) {
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
    current: Record<string, string | null>,
    serverId: string,
    requestedSessionIds: readonly string[] | undefined,
    requestedFolderIds: readonly string[] | undefined,
    assignments: readonly SessionFolderAssignment[],
    replaceAll: boolean | undefined,
): Record<string, string | null> {
    if (replaceAll) {
        // The server only stores rows for assigned sessions, so a full snapshot lists
        // assignments — not sessions. Dropping the omitted keys would turn "this session
        // has no folder" (information the snapshot authoritatively carries) back into
        // "never fetched", and the missing-only fetch policy in
        // `sync/ops/sessionOrganization/fetchSessionFolderAssignments.ts` would then
        // re-request every unassigned session one row at a time. Re-value the server's
        // known sessions instead: assigned ids take the snapshot's folder, every other
        // known id becomes an explicit null.
        const entries = new Map<string, string | null>(
            assignments.map((assignment) => [
                buildSessionOrganizationServerKey(serverId, assignment.sessionId),
                assignment.folderId,
            ] as const),
        );
        const serverKeyPrefix = `${String(serverId).trim()}:`;
        for (const key of Object.keys(current)) {
            if (!key.startsWith(serverKeyPrefix) || entries.has(key)) continue;
            entries.set(key, null);
        }
        return mergeRecordEntries(current, entries.entries());
    }
    const entries = new Map<string, string | null>();
    for (const sessionId of requestedSessionIds ?? []) {
        entries.set(buildSessionOrganizationServerKey(serverId, sessionId), null);
    }
    for (const assignment of assignments) {
        entries.set(buildSessionOrganizationServerKey(serverId, assignment.sessionId), assignment.folderId);
    }
    let next = mergeRecordEntries(current, entries.entries());
    const requestedFolders = new Set(
        (requestedFolderIds ?? [])
            .map((folderId) => String(folderId ?? '').trim())
            .filter(Boolean),
    );
    if (requestedFolders.size > 0) {
        const returnedKeys = new Set(assignments.map((assignment) => buildSessionOrganizationServerKey(serverId, assignment.sessionId)));
        const staleClears: Array<readonly [string, string | null]> = [];
        const prefix = `${String(serverId).trim()}:`;
        for (const [key, folderId] of Object.entries(next)) {
            if (!key.startsWith(prefix) || !folderId || !requestedFolders.has(folderId) || returnedKeys.has(key)) continue;
            staleClears.push([key, null] as const);
        }
        next = mergeRecordEntries(next, staleClears);
    }
    return next;
}

function replaceRequestedTagAssignments(
    current: Record<string, readonly string[]>,
    serverId: string,
    requestedSessionIds: readonly string[] | undefined,
    requestedTagIds: readonly string[] | undefined,
    assignments: readonly { sessionId: string; tagIds: readonly string[] }[],
    replaceAll: boolean | undefined,
): Record<string, readonly string[]> {
    if (replaceAll) {
        return replaceServerRecord(
            current,
            serverId,
            assignments.map((assignment) => [assignment.sessionId, assignment.tagIds] as const),
        );
    }
    const entries = new Map<string, readonly string[]>();
    for (const sessionId of requestedSessionIds ?? []) {
        entries.set(buildSessionOrganizationServerKey(serverId, sessionId), []);
    }
    for (const assignment of assignments) {
        entries.set(buildSessionOrganizationServerKey(serverId, assignment.sessionId), assignment.tagIds);
    }
    let next = mergeRecordEntries(current, entries.entries());
    const requestedTags = new Set(
        (requestedTagIds ?? [])
            .map((tagId) => String(tagId ?? '').trim())
            .filter(Boolean),
    );
    if (requestedTags.size > 0) {
        const returnedKeys = new Set(assignments.map((assignment) => buildSessionOrganizationServerKey(serverId, assignment.sessionId)));
        const staleUpdates: Array<readonly [string, readonly string[]]> = [];
        const prefix = `${String(serverId).trim()}:`;
        for (const [key, tagIds] of Object.entries(next)) {
            if (!key.startsWith(prefix) || returnedKeys.has(key)) continue;
            const filtered = tagIds.filter((tagId) => !requestedTags.has(tagId));
            if (filtered.length !== tagIds.length) staleUpdates.push([key, filtered] as const);
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
    const prefix = `${String(serverId).trim()}:`;
    const next: Record<string, readonly SessionOrganizationOrderEntry[]> = {};
    for (const [key, value] of Object.entries(current)) {
        if (!key.startsWith(prefix)) {
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

function rebaseRemainingOptimisticRecords<S extends SessionOrganizationDomain>(
    state: S,
    rolledBackRecord: SessionOrganizationOptimisticRecord,
    remainingRecords: Record<string, SessionOrganizationOptimisticRecord>,
): Partial<S> {
    let pins = rolledBackRecord.before.sessionOrganizationPinsBySessionKey ?? state.sessionOrganizationPinsBySessionKey;
    let attentionStandings = rolledBackRecord.before.sessionOrganizationAttentionStandingsBySessionKey ?? state.sessionOrganizationAttentionStandingsBySessionKey;
    let folders = rolledBackRecord.before.sessionOrganizationFoldersByFolderKey ?? state.sessionOrganizationFoldersByFolderKey;
    let tags = rolledBackRecord.before.sessionOrganizationTagsByTagKey ?? state.sessionOrganizationTagsByTagKey;
    let labels = rolledBackRecord.before.sessionOrganizationLabelsByLabelKey ?? state.sessionOrganizationLabelsByLabelKey;
    let orderEntries = rolledBackRecord.before.sessionOrganizationOrderEntriesByScopeKey ?? state.sessionOrganizationOrderEntriesByScopeKey;
    let tagAssignments = rolledBackRecord.before.sessionOrganizationTagAssignmentsBySessionKey ?? state.sessionOrganizationTagAssignmentsBySessionKey;
    let organizationFolderAssignments = rolledBackRecord.before.sessionOrganizationFolderAssignmentsBySessionKey ?? state.sessionOrganizationFolderAssignmentsBySessionKey;
    let legacyFolderAssignments = rolledBackRecord.before.sessionFolderAssignmentsBySessionKey ?? state.sessionFolderAssignmentsBySessionKey;

    for (const record of sortOptimisticRecords(Object.values(remainingRecords))) {
        pins = applyRecordDelta(pins, record.before.sessionOrganizationPinsBySessionKey, record.after.sessionOrganizationPinsBySessionKey);
        attentionStandings = applyRecordDelta(
            attentionStandings,
            record.before.sessionOrganizationAttentionStandingsBySessionKey,
            record.after.sessionOrganizationAttentionStandingsBySessionKey,
        );
        folders = applyRecordDelta(folders, record.before.sessionOrganizationFoldersByFolderKey, record.after.sessionOrganizationFoldersByFolderKey);
        tags = applyRecordDelta(tags, record.before.sessionOrganizationTagsByTagKey, record.after.sessionOrganizationTagsByTagKey);
        labels = applyRecordDelta(labels, record.before.sessionOrganizationLabelsByLabelKey, record.after.sessionOrganizationLabelsByLabelKey);
        orderEntries = applyRecordDelta(orderEntries, record.before.sessionOrganizationOrderEntriesByScopeKey, record.after.sessionOrganizationOrderEntriesByScopeKey);
        tagAssignments = applyRecordDelta(tagAssignments, record.before.sessionOrganizationTagAssignmentsBySessionKey, record.after.sessionOrganizationTagAssignmentsBySessionKey);
        organizationFolderAssignments = applyRecordDelta(
            organizationFolderAssignments,
            record.before.sessionOrganizationFolderAssignmentsBySessionKey,
            record.after.sessionOrganizationFolderAssignmentsBySessionKey,
        );
        legacyFolderAssignments = applyRecordDelta(
            legacyFolderAssignments,
            record.before.sessionFolderAssignmentsBySessionKey,
            record.after.sessionFolderAssignmentsBySessionKey,
        );
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
        sessionFolderAssignmentsBySessionKey: legacyFolderAssignments,
        sessionOrganizationOptimisticRecords: remainingRecords,
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
                    buildSessionOrganizationServerKey(serverId, assignment.sessionId),
                    assignment.folderId,
                ] as const),
            );
            if (nextAssignments === state.sessionOrganizationFolderAssignmentsBySessionKey) return {} as Partial<S>;
            return {
                sessionOrganizationFolderAssignmentsBySessionKey: nextAssignments,
                sessionFolderAssignmentsBySessionKey: nextAssignments,
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
        sessionFolderAssignmentsBySessionKey: {},
        sessionFolderAssignmentsLoadingByServerId: {},
        applySessionOrganizationSnapshot: (serverId, snapshot, options) => {
            set((state) => {
                const currentVersion = state.sessionOrganizationSnapshotVersionByServerId[serverId];
                if (typeof currentVersion === 'number' && snapshot.version < currentVersion) {
                    return {} as Partial<S>;
                }
                const pins = replaceServerRecord(
                    state.sessionOrganizationPinsBySessionKey,
                    serverId,
                    snapshot.pins.map((pin) => [pin.sessionId, pin] as const),
                );
                // Standings only ride along when the request asked for them, so an absent
                // array means "not fetched" and must not clear what the store already knows.
                const attentionStandings = snapshot.attentionStandings === undefined
                    ? state.sessionOrganizationAttentionStandingsBySessionKey
                    : replaceServerRecord(
                        state.sessionOrganizationAttentionStandingsBySessionKey,
                        serverId,
                        snapshot.attentionStandings.map((standing) => [standing.sessionId, standing] as const),
                    );
                const folders = options?.includeFolders === false
                    ? state.sessionOrganizationFoldersByFolderKey
                    : replaceServerRecord(
                        state.sessionOrganizationFoldersByFolderKey,
                        serverId,
                        snapshot.folders.map((folder) => [folder.folderId, folder] as const),
                    );
                const folderAssignments = replaceRequestedAssignments(
                    state.sessionOrganizationFolderAssignmentsBySessionKey,
                    serverId,
                    options?.assignmentSessionIds,
                    options?.folderIds,
                    snapshot.folderAssignments,
                    options?.includeAllFolderAssignments,
                );
                const tags = options?.includeTags === false
                    ? state.sessionOrganizationTagsByTagKey
                    : replaceServerRecord(
                        state.sessionOrganizationTagsByTagKey,
                        serverId,
                        snapshot.tags.map((tag) => [tag.tagId, tag] as const),
                    );
                const tagAssignments = replaceRequestedTagAssignments(
                    state.sessionOrganizationTagAssignmentsBySessionKey,
                    serverId,
                    options?.assignmentSessionIds,
                    options?.tagIds,
                    snapshot.tagAssignments,
                    options?.includeAllTagAssignments,
                );
                const labels = options?.includeLabels === false
                    ? state.sessionOrganizationLabelsByLabelKey
                    : replaceServerRecord(
                        state.sessionOrganizationLabelsByLabelKey,
                        serverId,
                        snapshot.labels.map((label) => [
                            `${label.labelKind}:${label.scopeKey}`,
                            label,
                        ] as const),
                    );
                const orderEntries = replaceOrderEntries(
                    state.sessionOrganizationOrderEntriesByScopeKey,
                    serverId,
                    snapshot.orderEntries,
                    options,
                );
                return {
                    sessionOrganizationSchemaVersionByServerId: {
                        ...state.sessionOrganizationSchemaVersionByServerId,
                        [serverId]: snapshot.schemaVersion,
                    },
                    sessionOrganizationSnapshotVersionByServerId: {
                        ...state.sessionOrganizationSnapshotVersionByServerId,
                        [serverId]: snapshot.version,
                    },
                    sessionOrganizationPinsBySessionKey: pins,
                    sessionOrganizationAttentionStandingsBySessionKey: attentionStandings,
                    sessionOrganizationFoldersByFolderKey: folders,
                    sessionOrganizationFolderAssignmentsBySessionKey: folderAssignments,
                    sessionFolderAssignmentsBySessionKey: folderAssignments,
                    sessionOrganizationTagsByTagKey: tags,
                    sessionOrganizationTagAssignmentsBySessionKey: tagAssignments,
                    sessionOrganizationOrderEntriesByScopeKey: orderEntries,
                    sessionOrganizationLabelsByLabelKey: labels,
                } as Partial<S>;
            });
        },
        setSessionOrganizationLoading: (serverId, loading) => {
            set((state) => ({
                sessionOrganizationLoadingByServerId: {
                    ...state.sessionOrganizationLoadingByServerId,
                    [serverId]: loading,
                },
                sessionFolderAssignmentsLoadingByServerId: {
                    ...state.sessionFolderAssignmentsLoadingByServerId,
                    [serverId]: loading,
                },
            }) as Partial<S>);
        },
        setSessionOrganizationError: (serverId, error) => {
            set((state) => ({
                sessionOrganizationErrorByServerId: {
                    ...state.sessionOrganizationErrorByServerId,
                    [serverId]: error,
                },
            }) as Partial<S>);
        },
        setSessionPinOptimistic: (serverId, sessionId, pin) => {
            const key = buildSessionOrganizationServerKey(serverId, sessionId);
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
            const key = buildSessionOrganizationServerKey(serverId, sessionId);
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
            const key = buildSessionOrganizationServerKey(serverId, sessionId);
            const state = get();
            const afterAssignments = setRecordValue(state.sessionOrganizationFolderAssignmentsBySessionKey, key, folderId);
            const record = createOptimisticRecord({
                serverId,
                before: {
                    sessionOrganizationFolderAssignmentsBySessionKey: state.sessionOrganizationFolderAssignmentsBySessionKey,
                    sessionFolderAssignmentsBySessionKey: state.sessionFolderAssignmentsBySessionKey,
                },
                after: {
                    sessionOrganizationFolderAssignmentsBySessionKey: afterAssignments,
                    sessionFolderAssignmentsBySessionKey: afterAssignments,
                },
            });
            set((current) => ({
                ...addOptimisticRecord(current, record),
                sessionOrganizationFolderAssignmentsBySessionKey: afterAssignments,
                sessionFolderAssignmentsBySessionKey: afterAssignments,
            }) as Partial<S>);
            return record.id;
        },
        setSessionTagAssignmentsOptimistic: (serverId, sessionId, tagIds) => {
            const key = buildSessionOrganizationServerKey(serverId, sessionId);
            const state = get();
            const afterTagAssignments = setRecordValue(
                state.sessionOrganizationTagAssignmentsBySessionKey,
                key,
                [...tagIds],
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
        applySessionOrganizationOrderScopeOptimistic: (serverId, scope) => {
            const state = get();
            const afterOrderEntries = replaceOrderEntries(
                state.sessionOrganizationOrderEntriesByScopeKey,
                serverId,
                scope.entries,
                { orderScopes: [{ scopeKind: scope.scopeKind, scopeKey: scope.scopeKey }] },
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
        applySessionOrganizationOrderEntriesOptimistic: (serverId, entries) => {
            if (entries[0]) {
                return get().applySessionOrganizationOrderScopeOptimistic(serverId, {
                    scopeKind: entries[0].scopeKind,
                    scopeKey: entries[0].scopeKey,
                    entries,
                });
            }
            const state = get();
            const afterOrderEntries = replaceOrderEntries(
                state.sessionOrganizationOrderEntriesByScopeKey,
                serverId,
                entries,
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
        moveSessionFolderAssignmentsOptimistic: (serverId, fromFolderIds, toFolderId) => {
            const sourceFolderIds = new Set(
                fromFolderIds.map((folderId) => String(folderId ?? '').trim()).filter(Boolean),
            );
            if (sourceFolderIds.size === 0) return null;
            const state = get();
            const prefix = `${String(serverId).trim()}:`;
            const updates: Array<readonly [string, string | null]> = [];
            for (const [key, folderId] of Object.entries(state.sessionOrganizationFolderAssignmentsBySessionKey)) {
                if (!key.startsWith(prefix) || !folderId || !sourceFolderIds.has(folderId)) continue;
                updates.push([key, toFolderId] as const);
            }
            if (updates.length === 0) return null;
            const afterAssignments = mergeRecordEntries(
                state.sessionOrganizationFolderAssignmentsBySessionKey,
                updates,
            );
            const record = createOptimisticRecord({
                serverId,
                before: {
                    sessionOrganizationFolderAssignmentsBySessionKey: state.sessionOrganizationFolderAssignmentsBySessionKey,
                    sessionFolderAssignmentsBySessionKey: state.sessionFolderAssignmentsBySessionKey,
                },
                after: {
                    sessionOrganizationFolderAssignmentsBySessionKey: afterAssignments,
                    sessionFolderAssignmentsBySessionKey: afterAssignments,
                },
            });
            set((current) => ({
                ...addOptimisticRecord(current, record),
                sessionOrganizationFolderAssignmentsBySessionKey: afterAssignments,
                sessionFolderAssignmentsBySessionKey: afterAssignments,
            }) as Partial<S>);
            return record.id;
        },
        reconcileSessionOrganizationFolderDelete: (serverId, deletedFolderIds, assignmentTargetFolderId) => {
            const deletedFolders = new Set(
                deletedFolderIds.map((folderId) => String(folderId ?? '').trim()).filter(Boolean),
            );
            if (deletedFolders.size === 0) return;
            set((state) => {
                const prefix = `${String(serverId).trim()}:`;
                const updates: Array<readonly [string, string | null]> = [];
                for (const [key, folderId] of Object.entries(state.sessionOrganizationFolderAssignmentsBySessionKey)) {
                    if (!key.startsWith(prefix) || !folderId || !deletedFolders.has(folderId)) continue;
                    updates.push([key, assignmentTargetFolderId] as const);
                }
                if (updates.length === 0) return {} as Partial<S>;
                const nextAssignments = mergeRecordEntries(state.sessionOrganizationFolderAssignmentsBySessionKey, updates);
                return {
                    sessionOrganizationFolderAssignmentsBySessionKey: nextAssignments,
                    sessionFolderAssignmentsBySessionKey: nextAssignments,
                } as Partial<S>;
            });
        },
        reconcileSessionOrganizationTagDelete: (serverId, tagId) => {
            const deletedTagId = String(tagId ?? '').trim();
            if (!deletedTagId) return;
            set((state) => {
                const prefix = `${String(serverId).trim()}:`;
                const updates: Array<readonly [string, readonly string[]]> = [];
                for (const [key, tagIds] of Object.entries(state.sessionOrganizationTagAssignmentsBySessionKey)) {
                    if (!key.startsWith(prefix) || !tagIds.includes(deletedTagId)) continue;
                    updates.push([key, tagIds.filter((candidate) => candidate !== deletedTagId)] as const);
                }
                if (updates.length === 0) return {} as Partial<S>;
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
                if (!record) return {} as Partial<S>;
                const nextRecords = { ...state.sessionOrganizationOptimisticRecords };
                delete nextRecords[recordId];
                return rebaseRemainingOptimisticRecords(state, record, nextRecords);
            });
        },
        commitSessionOrganizationOptimistic: (recordId) => {
            set((state) => {
                if (!state.sessionOrganizationOptimisticRecords[recordId]) return {} as Partial<S>;
                const nextRecords = { ...state.sessionOrganizationOptimisticRecords };
                delete nextRecords[recordId];
                return { sessionOrganizationOptimisticRecords: nextRecords } as Partial<S>;
            });
        },
        clearSessionOrganizationForServer: (serverId) => {
            set((state) => {
                const folderAssignments = removeServerRecordEntries(state.sessionOrganizationFolderAssignmentsBySessionKey, serverId);
                return {
                    sessionOrganizationSnapshotVersionByServerId: Object.fromEntries(
                        Object.entries(state.sessionOrganizationSnapshotVersionByServerId).filter(([key]) => key !== serverId),
                    ),
                    sessionOrganizationSchemaVersionByServerId: Object.fromEntries(
                        Object.entries(state.sessionOrganizationSchemaVersionByServerId).filter(([key]) => key !== serverId),
                    ),
                    sessionOrganizationPinsBySessionKey: removeServerRecordEntries(state.sessionOrganizationPinsBySessionKey, serverId),
                    sessionOrganizationAttentionStandingsBySessionKey: removeServerRecordEntries(state.sessionOrganizationAttentionStandingsBySessionKey, serverId),
                    sessionOrganizationFoldersByFolderKey: removeServerRecordEntries(state.sessionOrganizationFoldersByFolderKey, serverId),
                    sessionOrganizationFolderAssignmentsBySessionKey: folderAssignments,
                    sessionFolderAssignmentsBySessionKey: folderAssignments,
                    sessionOrganizationTagsByTagKey: removeServerRecordEntries(state.sessionOrganizationTagsByTagKey, serverId),
                    sessionOrganizationTagAssignmentsBySessionKey: removeServerRecordEntries(state.sessionOrganizationTagAssignmentsBySessionKey, serverId),
                    sessionOrganizationOrderEntriesByScopeKey: removeServerRecordEntries(state.sessionOrganizationOrderEntriesByScopeKey, serverId),
                    sessionOrganizationLabelsByLabelKey: removeServerRecordEntries(state.sessionOrganizationLabelsByLabelKey, serverId),
                    sessionOrganizationLoadingByServerId: Object.fromEntries(
                        Object.entries(state.sessionOrganizationLoadingByServerId).filter(([key]) => key !== serverId),
                    ),
                    sessionOrganizationErrorByServerId: Object.fromEntries(
                        Object.entries(state.sessionOrganizationErrorByServerId).filter(([key]) => key !== serverId),
                    ),
                    sessionFolderAssignmentsLoadingByServerId: Object.fromEntries(
                        Object.entries(state.sessionFolderAssignmentsLoadingByServerId).filter(([key]) => key !== serverId),
                    ),
                } as Partial<S>;
            });
        },
        applySessionFolderAssignments: applyFolderAssignments,
        setSessionFolderAssignmentsLoading: (serverId, loading) => {
            get().setSessionOrganizationLoading(serverId, loading);
        },
        setSessionFolderAssignmentOptimistic: (serverId, sessionId, folderId) => {
            const key = buildSessionOrganizationServerKey(serverId, sessionId);
            const previous = get().sessionOrganizationFolderAssignmentsBySessionKey[key] ?? null;
            set((state) => {
                const nextAssignments = setRecordValue(state.sessionOrganizationFolderAssignmentsBySessionKey, key, folderId);
                return {
                    sessionOrganizationFolderAssignmentsBySessionKey: nextAssignments,
                    sessionFolderAssignmentsBySessionKey: nextAssignments,
                } as Partial<S>;
            });
            return previous;
        },
        rollbackSessionFolderAssignment: (serverId, sessionId, previousFolderId) => {
            const key = buildSessionOrganizationServerKey(serverId, sessionId);
            set((state) => {
                const nextAssignments = setRecordValue(state.sessionOrganizationFolderAssignmentsBySessionKey, key, previousFolderId);
                return {
                    sessionOrganizationFolderAssignmentsBySessionKey: nextAssignments,
                    sessionFolderAssignmentsBySessionKey: nextAssignments,
                } as Partial<S>;
            });
        },
        clearSessionFolderAssignmentsForServer: (serverId) => {
            get().clearSessionOrganizationForServer(serverId);
        },
    };
}
