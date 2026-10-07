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

function readScope(raw: string | undefined): SerializedSessionDraftScope {
    if (raw === undefined) return { v: 2, replicas: {} };
    const parsed = parseSerializedSessionDraftScope(raw);
    if (!parsed) throw new Error('Unrecognized draft storage format. Stored drafts were preserved.');
    return parsed;
}

/**
 * Applies only the caller's changed replicas to transaction-current storage. A concurrent change
 * to the same replica is a visible persistence failure; unrelated tab drafts remain untouched.
 */
export function mergeSerializedSessionDraftScope(
    current: string | undefined,
    previousRequested: string | undefined,
    nextRequested: string | undefined,
): string | undefined {
    const currentScope = readScope(current);
    const previousScope = readScope(previousRequested);
    const nextScope = readScope(nextRequested);
    const currentReplicas = new Map(Object.entries(currentScope.replicas));
    const previousReplicas = new Map(Object.entries(previousScope.replicas));
    const nextReplicas = new Map(Object.entries(nextScope.replicas));
    const merged = new Map([...currentReplicas].map(([key, value]) => [key, expandReplica(value, currentScope.v)]));
    let changed = false;
    for (const key of new Set([...previousReplicas.keys(), ...nextReplicas.keys()])) {
        const previous = expandReplica(previousReplicas.get(key), previousScope.v);
        const next = expandReplica(nextReplicas.get(key), nextScope.v);
        if (sessionDraftJsonValuesEqual(previous, next)) continue;
        const stored = expandReplica(currentReplicas.get(key), currentScope.v);
        if (!sessionDraftJsonValuesEqual(stored, previous) && !sessionDraftJsonValuesEqual(stored, next)) {
            throw new Error('This draft changed in another tab. Stored drafts and your unsaved edits were preserved.');
        }
        changed = true;
        if (nextReplicas.has(key)) merged.set(key, next);
        else merged.delete(key);
    }
    const metadataEntries = (scope: SerializedSessionDraftScope) => Object.entries(scope).filter(([key]) => key !== 'v' && key !== 'replicas');
    const metadata = new Map(metadataEntries(currentScope));
    const previousMetadata = new Map(metadataEntries(previousScope));
    const nextMetadata = new Map(metadataEntries(nextScope));
    // A reader that does not own an envelope field can omit it without erasing another writer's
    // value. An explicit scope deletion removes only metadata the caller actually observed.
    const metadataKeys = nextRequested === undefined
        ? new Set([...previousMetadata.keys(), ...nextMetadata.keys()])
        : nextMetadata.keys();
    for (const key of metadataKeys) {
        const previous = previousMetadata.get(key);
        const next = nextMetadata.get(key);
        if (sessionDraftJsonValuesEqual(previous, next)) continue;
        const stored = metadata.get(key);
        if (!sessionDraftJsonValuesEqual(stored, previous) && !sessionDraftJsonValuesEqual(stored, next)) {
            throw new Error('Draft selection changed in another tab. Stored drafts were preserved.');
        }
        changed = true;
        if (nextMetadata.has(key)) metadata.set(key, next);
        else metadata.delete(key);
    }
    if (!changed) return current;
    if (merged.size === 0 && metadata.size === 0 && nextRequested === undefined) return undefined;
    return JSON.stringify({
        ...Object.fromEntries(metadata),
        v: 2,
        replicas: Object.fromEntries([...merged].map(([key, value]) => [key, compactReplica(value)])),
    });
}
