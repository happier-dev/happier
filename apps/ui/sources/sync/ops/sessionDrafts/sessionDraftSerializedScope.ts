import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';
import { getSessionDraftDocumentField } from './sessionDraftDocumentFields';

type SerializedSessionDraftScope = Readonly<Record<string, unknown> & { v: 1 | 2; replicas: Record<string, unknown> }>;

function sessionDraftJsonValuesEqual(left: unknown, right: unknown): boolean {
    if (left === right) return true;
    if (left === undefined || right === undefined) return false;
    return pluginJsonValuesEqual(left, right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The same envelope reader owns repository hydration and transactional browser updates. */
export function parseSerializedSessionDraftScope(raw: string): SerializedSessionDraftScope | null {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || (parsed.v !== 1 && parsed.v !== 2) || !isRecord(parsed.replicas)) return null;
    return { ...parsed, v: parsed.v, replicas: parsed.replicas };
}

function expandReplica(value: unknown, version: 1 | 2): unknown {
    if (!isRecord(value) || version === 1) return value;
    const expanded = { ...value };
    if ('localRawDocument' in value && !Object.prototype.hasOwnProperty.call(value, 'baseRawDocument')) {
        expanded.baseRawDocument = value.localRawDocument;
    }
    if (Array.isArray(value.pendingFieldMutations)) {
        expanded.pendingFieldMutations = value.pendingFieldMutations.map((mutation: unknown) => {
            if (!isRecord(mutation) || Object.prototype.hasOwnProperty.call(mutation, 'field')) return mutation;
            const field = getSessionDraftDocumentField(value.localRawDocument, mutation.path);
            return field === undefined ? mutation : { ...mutation, field };
        });
    }
    return expanded;
}

function compactReplica(value: unknown): unknown {
    if (!isRecord(value)) return value;
    const compact = { ...value };
    if (Object.prototype.hasOwnProperty.call(value, 'baseRawDocument')
        && sessionDraftJsonValuesEqual(value.baseRawDocument, value.localRawDocument)) {
        delete compact.baseRawDocument;
    }
    if (Array.isArray(value.pendingFieldMutations)) {
        compact.pendingFieldMutations = value.pendingFieldMutations.map((mutation: unknown) => {
            if (!isRecord(mutation) || !Object.prototype.hasOwnProperty.call(mutation, 'field')) return mutation;
            const field = getSessionDraftDocumentField(value.localRawDocument, mutation.path);
            if (field === undefined || !sessionDraftJsonValuesEqual(mutation.field, field)) return mutation;
            const { field: _omittedDuplicate, ...rest } = mutation;
            return rest;
        });
    }
    return compact;
}

/** V2 removes only exact duplicate values; repository writes and merged records share this owner. */
export function serializeSessionDraftReplica(replica: unknown): string {
    return JSON.stringify(compactReplica(replica));
}

/**
 * Drafts persist one record per replica: `<scope record key>/<canonical replica key>`. A keystroke
 * rewrites only its own draft. The scope record itself keeps only envelope fields (`v: 3`), and is
 * absent when there are none.
 */
export function sessionDraftRowKey(scopeRecordKey: string, replicaKey: string): string {
    return `${scopeRecordKey}/${replicaKey}`;
}

/** Envelope fields of a row-layout scope record; null when the bytes are not one. */
export function parseSessionDraftScopeEnvelope(raw: string): Readonly<Record<string, unknown>> | null {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.v !== 3 || 'replicas' in parsed) return null;
    const { v: _version, ...fields } = parsed;
    return fields;
}

/** A whole-scope record written by 0.2 or an earlier 0.3 build (`v: 1 | 2` with every replica inline). */
export function isLegacySessionDraftScopeRecord(raw: string | undefined): raw is string {
    if (raw === undefined) return false;
    try {
        return parseSerializedSessionDraftScope(raw) !== null;
    } catch {
        return false;
    }
}

/** Row keys a legacy whole-scope record moves into. */
export function legacySessionDraftRowKeys(scopeRecordKey: string, legacyRaw: string): string[] {
    const legacy = parseSerializedSessionDraftScope(legacyRaw);
    if (!legacy) throw new Error('Unrecognized draft storage format. Stored drafts were preserved.');
    return Object.keys(legacy.replicas).map((replicaKey) => sessionDraftRowKey(scopeRecordKey, replicaKey));
}

function legacyReplicaRow(replica: unknown, version: 1 | 2): string {
    // Rows use v2 semantics, where an omitted base means "equal to the local document".
    // A v1 replica without a base had none, so keep that explicit.
    if (version === 1 && isRecord(replica) && 'localRawDocument' in replica
        && !Object.prototype.hasOwnProperty.call(replica, 'baseRawDocument')) {
        return JSON.stringify({ ...replica, baseRawDocument: null });
    }
    return JSON.stringify(replica);
}

/** Stored draft bytes are equal when they decode to the same replica (v2 duplicate omission aside). */
export function sessionDraftStoredRecordsEqual(left: string | undefined, right: string | undefined): boolean {
    if (left === right) return true;
    if (left === undefined || right === undefined) return false;
    try {
        return sessionDraftJsonValuesEqual(expandReplica(JSON.parse(left), 2), expandReplica(JSON.parse(right), 2));
    } catch {
        return false;
    }
}

/**
 * The one migration from the whole-scope layout into per-draft rows. Returns the record changes
 * (undefined = delete), or null when it refuses: an existing row holds a different draft, a row
 * could not be read in the same snapshot (`read` returns `unread`), or the scope record is in an
 * unknown format. A refusal changes nothing; every caller keeps the whole-scope record, so only
 * that scope reads as unreadable retained custody and both copies stay stored.
 */
export const SESSION_DRAFT_RECORD_UNREAD = Symbol('session draft record not read');
export function migrateLegacySessionDraftScope(
    scopeRecordKey: string,
    legacyRaw: string,
    read: (key: string) => string | undefined | typeof SESSION_DRAFT_RECORD_UNREAD,
): Map<string, string | undefined> | null {
    const legacy = parseSerializedSessionDraftScope(legacyRaw);
    if (!legacy) throw new Error('Unrecognized draft storage format. Stored drafts were preserved.');
    const changes = new Map<string, string | undefined>();
    for (const [replicaKey, replica] of Object.entries(legacy.replicas)) {
        const rowKey = sessionDraftRowKey(scopeRecordKey, replicaKey);
        const row = legacyReplicaRow(replica, legacy.v);
        const existing = read(rowKey);
        if (existing === SESSION_DRAFT_RECORD_UNREAD) return null;
        if (existing === undefined) changes.set(rowKey, row);
        else if (!sessionDraftStoredRecordsEqual(existing, row)) return null;
    }
    const { v: _version, replicas: _replicas, ...legacyFields } = legacy;
    const current = read(scopeRecordKey);
    if (current === SESSION_DRAFT_RECORD_UNREAD) return null;
    let currentFields: Readonly<Record<string, unknown>> | null = {};
    if (current !== undefined && !isLegacySessionDraftScopeRecord(current)) {
        try {
            currentFields = parseSessionDraftScopeEnvelope(current);
        } catch {
            currentFields = null;
        }
    }
    if (currentFields === null) return null;
    const fields = { ...legacyFields, ...currentFields };
    changes.set(scopeRecordKey, Object.keys(fields).length === 0 ? undefined : JSON.stringify({ ...fields, v: 3 }));
    return changes;
}
