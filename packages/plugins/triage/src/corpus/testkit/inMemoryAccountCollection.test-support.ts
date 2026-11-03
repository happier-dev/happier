import { PluginError, type JsonValue } from '@happier-dev/plugin-sdk';
import { compilePluginJsonSchema, isValidPluginJsonSchemaValue } from '@happier-dev/plugin-sdk/manifest';
import type {
    PluginAccountCollection,
    PluginAccountCollectionDefinition,
    PluginCollectionIndexScalarValueV1,
    PluginCollectionIndexV1,
    PluginCollectionMutation,
    PluginCollectionMutationConflictV1,
} from '@happier-dev/plugin-sdk/collections';
import { derivePluginCollectionIdentityTagV1 } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { resolveEffectivePluginCollectionLimitsV1 } from '@happier-dev/protocol/plugins/data/collectionsV1';
import type { AccountScopedCryptoMaterial } from '@happier-dev/protocol';

import type { CorpusStoredValueV1 } from '../collections/handles.js';

/**
 * An in-memory stand-in for the Account Collection boundary.
 *
 * The Collection store is a genuine system boundary — a network-backed,
 * server-authoritative store — so tests replace it here. Everything the corpus
 * itself owns still runs for real: identity tags are derived through the real
 * canonical derivation with the same host-stamped bindings, row identity comes
 * from the declared `rowIdField`, CAS revisions behave as the server's do, and
 * a deleted row becomes a tombstone that reads as `null` while still holding
 * the revision a resurrection must present.
 */

type StoredRow = {
    revision: number;
    value: Readonly<Record<string, JsonValue>>;
    deleted: boolean;
};

export type InMemoryAccountCollectionOptions = Readonly<{
    definition: PluginAccountCollectionDefinition;
    pluginId?: string;
    accountEncryptionMode?: 'plain' | 'e2ee';
    material?: AccountScopedCryptoMaterial | null;
}>;

export type InMemoryAccountCollection = Readonly<{
    /** Reads issued through `get`, so a per-row hydration budget can be asserted. */
    getCallCount: () => number;
    /** Live and tombstoned rows, for assertions the public surface deliberately hides. */
    inspect: (rowId: string) => Readonly<{ revision: number; deleted: boolean }> | null;
    seed: (value: Readonly<Record<string, JsonValue>>) => Readonly<{ rowId: string; revision: number }>;
    tombstone: (rowId: string) => void;
}>;

type ScalarValue = PluginCollectionIndexScalarValueV1;

const conflictError = (): PluginError => new PluginError({
    code: 'plugin_collection_conflict',
    message: 'Collection mutation conflicted with a newer row revision',
});

const invalidValueError = (message: string): PluginError => new PluginError({
    code: 'plugin_collection_invalid_value',
    message,
});

function readScalar(value: Readonly<Record<string, JsonValue>>, field: string): ScalarValue {
    const candidate = value[field];
    if (candidate === undefined || candidate === null) return null;
    if (typeof candidate === 'string' || typeof candidate === 'number' || typeof candidate === 'boolean') {
        return candidate;
    }
    throw invalidValueError(`Collection index field "${field}" is not a scalar`);
}

function compareScalar(left: ScalarValue, right: ScalarValue): number {
    if (left === right) return 0;
    // The server orders a missing projected value before every present one.
    if (left === null) return -1;
    if (right === null) return 1;
    if (typeof left === 'number' && typeof right === 'number') return left - right;
    if (typeof left === 'boolean' && typeof right === 'boolean') return Number(left) - Number(right);
    const leftText = String(left);
    const rightText = String(right);
    return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
}

export function createInMemoryAccountCollection<TDefinition extends PluginAccountCollectionDefinition>(
    options: InMemoryAccountCollectionOptions & Readonly<{ definition: TDefinition }>,
): Readonly<{
    collection: PluginAccountCollection<CorpusStoredValueV1>;
    control: InMemoryAccountCollection;
}> {
    const definition = options.definition;
    const pluginId = options.pluginId ?? 'happier.triage';
    const accountEncryptionMode = options.accountEncryptionMode ?? 'plain';
    const material = options.material ?? null;
    const rowIdField = (definition as Readonly<{ rowIdField?: string }>).rowIdField ?? 'id';
    const indexes = (definition as Readonly<{ indexes: readonly PluginCollectionIndexV1[] }>).indexes;
    // Mirrors the host exactly: the admitted contract's `identityFields` is the
    // only declaration of which fields carry a mode-derived identity, so a
    // testkit that accepted the wider row-id-plus-index set would pass a
    // derivation the real host rejects.
    const declaredIdentityFields = new Set<string>(
        (definition as Readonly<{ identityFields?: readonly string[] }>).identityFields ?? [],
    );

    const rows = new Map<string, StoredRow>();
    let changeCursor = 0;
    let getCallCount = 0;
    type Selection = Parameters<PluginAccountCollection<CorpusStoredValueV1>['watch']>[0];
    type WatchListener = Parameters<PluginAccountCollection<CorpusStoredValueV1>['watch']>[1];
    const watchers = new Set<Readonly<{ selection: Selection; listener: WatchListener }>>();

    function admitSelection(selection: Parameters<PluginAccountCollection<CorpusStoredValueV1>['query']>[0]) {
        const index = indexes.find(candidate => candidate.id === selection.index);
        if (!index) throw invalidValueError('Collection query names an undeclared index');
        if ((selection.prefix?.length ?? 0) > index.fields.length) throw invalidValueError('Collection query prefix is too long');
        return index;
    }

    function matchesSelection(value: CorpusStoredValueV1, selection: Selection): boolean {
        if ('kind' in selection) return selection.kind === 'collection' || rowIdOf(value) === selection.rowId;
        if (selection.prefixes !== undefined) return selection.prefixes.some(prefix => matchesSelection(value,
            { ...selection, prefix, prefixes: undefined }));
        const index = admitSelection(selection);
        const prefix = selection.prefix ?? [];
        for (const [position, expected] of prefix.entries()) {
            const field = index.fields[position];
            if (!field || compareScalar(readScalar(value, field.field), expected) !== 0) return false;
        }
        const rangeField = index.fields[prefix.length];
        if (selection.range && rangeField) {
            const actual = readScalar(value, rangeField.field);
            if (selection.range.lower !== undefined && compareScalar(actual, selection.range.lower) < 0) return false;
            if (selection.range.upper !== undefined && compareScalar(actual, selection.range.upper) > 0) return false;
        }
        return true;
    }

    function publishChanges(values: readonly CorpusStoredValueV1[]) {
        for (const watcher of watchers) {
            if (values.some(value => matchesSelection(value, watcher.selection))) {
                watcher.listener({ kind: 'changed', changeCursor });
            }
        }
    }

    // The real host refuses a value its admitted schema does not describe, so a
    // corpus row shape that outgrew its declaration must fail here too.
    const declaredSchema = definition.schema;
    const validate = compilePluginJsonSchema(
        'jsonSchema' in declaredSchema ? declaredSchema.jsonSchema : declaredSchema,
    );

    const rowIdOf = (value: Readonly<Record<string, JsonValue>>): string => {
        const candidate = value[rowIdField];
        if (typeof candidate !== 'string' || candidate.length === 0) {
            throw invalidValueError('Collection row identity must be a non-empty string');
        }
        return candidate;
    };

    const conflictFor = (rowId: string, expectedRevision: number | 'absent'): PluginCollectionMutationConflictV1 | null => {
        const stored = rows.get(rowId);
        if (expectedRevision === 'absent') {
            // A tombstone keeps its revision, so re-creating a deleted row is a
            // conditional put against that exact revision rather than an
            // ordinary absent write.
            return stored ? { rowId, revision: stored.revision, deleted: stored.deleted } : null;
        }
        if (!stored || stored.revision !== expectedRevision) {
            return { rowId, revision: stored?.revision ?? null, deleted: stored?.deleted ?? false };
        }
        return null;
    };

    const applyOperation = (
        operation: PluginCollectionMutation<Readonly<Record<string, JsonValue>>>,
    ): Readonly<{ rowId: string; revision: number; deleted: boolean }> => {
        if (operation.kind === 'assert') {
            const stored = rows.get(operation.rowId);
            return { rowId: operation.rowId, revision: stored?.revision ?? 0, deleted: stored?.deleted ?? false };
        }
        if (operation.kind === 'delete') {
            const stored = rows.get(operation.rowId);
            const revision = (stored?.revision ?? 0) + 1;
            // Deleting erases content, projections and index entries; the row
            // identity and its revision survive as a tombstone.
            rows.set(operation.rowId, { revision, value: {}, deleted: true });
            return { rowId: operation.rowId, revision, deleted: true };
        }
        const rowId = rowIdOf(operation.value);
        const revision = (rows.get(rowId)?.revision ?? 0) + 1;
        rows.set(rowId, { revision, value: operation.value, deleted: false });
        return { rowId, revision, deleted: false };
    };

    const collection = {
        async identityTag(request: Readonly<{ field: string; components: readonly string[] }>): Promise<string> {
            if (!declaredIdentityFields.has(request.field)) {
                throw invalidValueError('Collection identity tag names a field the admitted contract does not declare');
            }
            return derivePluginCollectionIdentityTagV1({
                accountEncryptionMode,
                material,
                pluginId,
                collectionId: String((definition as Readonly<{ id: string }>).id),
                field: request.field,
                components: request.components,
            });
        },
        async get(rowId: string) {
            getCallCount += 1;
            const stored = rows.get(rowId);
            // A plugin cannot see its own tombstone.
            if (!stored || stored.deleted) return null;
            return { rowId, revision: stored.revision, value: stored.value };
        },
        async put(
            value: Readonly<Record<string, JsonValue>>,
            putOptions: Readonly<{ expectedRevision: number | 'absent' }>,
        ) {
            const rowId = rowIdOf(value);
            if (conflictFor(rowId, putOptions.expectedRevision)) throw conflictError();
            const previous = rows.get(rowId);
            const applied = applyOperation({ kind: 'put', value, expectedRevision: putOptions.expectedRevision });
            changeCursor += 1;
            publishChanges([...(previous && !previous.deleted ? [previous.value] : []), value]);
            return { rowId: applied.rowId, revision: applied.revision, value };
        },
        async delete(rowId: string, deleteOptions: Readonly<{ expectedRevision: number }>) {
            if (conflictFor(rowId, deleteOptions.expectedRevision)) throw conflictError();
            const previous = rows.get(rowId);
            const applied = applyOperation({ kind: 'delete', rowId, expectedRevision: deleteOptions.expectedRevision });
            changeCursor += 1;
            if (previous && !previous.deleted) publishChanges([previous.value]);
            return Object.freeze({ rowId: applied.rowId, revision: applied.revision, deleted: true as const });
        },
        async forget(rowId: string, forgetOptions: Readonly<{ expectedRevision: number }>) {
            const stored = rows.get(rowId);
            if (!stored || !stored.deleted || stored.revision !== forgetOptions.expectedRevision) {
                throw conflictError();
            }
            rows.delete(rowId);
            changeCursor += 1;
            return Object.freeze({ rowId, forgotten: true as const });
        },
        async query(request: Readonly<{
            index: string;
            prefix?: readonly ScalarValue[];
            prefixes?: readonly (readonly ScalarValue[])[];
            range?: Readonly<{ lower?: ScalarValue; upper?: ScalarValue }>;
            order: 'asc' | 'desc';
            cursor?: string;
            limit?: number;
        }>) {
            const index = admitSelection(request);
            const live = [...rows.entries()]
                .filter(([, stored]) => !stored.deleted)
                .map(([rowId, stored]) => ({ rowId, stored }));
            const matching = live.filter(({ stored }) => matchesSelection(stored.value, request));
            matching.sort((left, right) => {
                for (const field of index.fields) {
                    const comparison = compareScalar(
                        readScalar(left.stored.value, field.field),
                        readScalar(right.stored.value, field.field),
                    ) * (field.direction === 'desc' ? -1 : 1);
                    if (comparison !== 0) return comparison;
                }
                // The final row-id tie-breaker makes every stored index entry total.
                return left.rowId < right.rowId ? -1 : left.rowId > right.rowId ? 1 : 0;
            });
            const ordered = request.order === 'desc' ? [...matching].reverse() : matching;
            const start = request.cursor ? Number(request.cursor) : 0;
            const limit = request.limit ?? ordered.length;
            const page = ordered.slice(start, start + limit);
            const nextIndex = start + page.length;
            return {
                rows: page.map(({ rowId, stored }) => ({ rowId, revision: stored.revision, value: stored.value })),
                ...(nextIndex < ordered.length ? { nextCursor: String(nextIndex) } : {}),
                changeCursor,
            };
        },
        async batch(operations: readonly PluginCollectionMutation<Readonly<Record<string, JsonValue>>>[]) {
            if (operations.length === 0 || operations.length > 100) {
                throw invalidValueError('Collection batch must contain between one and one hundred operations');
            }
            const conflicts: PluginCollectionMutationConflictV1[] = [];
            for (const operation of operations) {
                if (operation.kind === 'put' && !isValidPluginJsonSchemaValue(validate, operation.value)) {
                    throw invalidValueError('Collection value does not satisfy its admitted schema');
                }
                const rowId = operation.kind === 'put' ? rowIdOf(operation.value) : operation.rowId;
                const conflict = conflictFor(rowId, operation.expectedRevision);
                if (conflict) conflicts.push(conflict);
            }
            // A batch is atomic on conflict: if one operation conflicts, none of
            // the request applies and the complete conflict set is returned.
            if (conflicts.length > 0) return { status: 'conflict' as const, conflicts };
            const changedValues = operations.flatMap(operation => {
                if (operation.kind === 'assert') return [];
                const previous = rows.get(operation.kind === 'put' ? rowIdOf(operation.value) : operation.rowId);
                return [...(previous && !previous.deleted ? [previous.value] : []), ...(operation.kind === 'put' ? [operation.value] : [])];
            });
            const results = operations.map((operation) => applyOperation(operation));
            changeCursor += 1;
            publishChanges(changedValues);
            return { status: 'updated' as const, results, changeCursor };
        },
        async limits() {
            // The corpus never plans multi-batch work, so this boundary reports
            // the canonical effective default policy narrowed by this exact
            // admitted Collection quota, just like the real host boundary.
            return resolveEffectivePluginCollectionLimitsV1({
                deployment: undefined,
                quota: definition.quota,
            });
        },
        async measureBatch(operations: readonly PluginCollectionMutation<Readonly<Record<string, JsonValue>>>[]) {
            if (operations.length === 0) {
                throw invalidValueError('Collection batch measurement requires at least one operation');
            }
            const encodedBytes = (value: unknown): number => (
                new TextEncoder().encode(JSON.stringify(value)).byteLength
            );
            return {
                overheadEncodedBytes: encodedBytes({ pluginId, collectionId: definition.id, operations: [] }),
                operationEncodedBytes: operations.map((operation) => 1 + encodedBytes(operation)),
            };
        },
        watch(selection, listener) {
            if (!('kind' in selection)) admitSelection(selection);
            const watcher = { selection, listener };
            watchers.add(watcher);
            return { dispose: () => { watchers.delete(watcher); } };
        },
    } satisfies PluginAccountCollection<CorpusStoredValueV1>;

    const control: InMemoryAccountCollection = {
        getCallCount: () => getCallCount,
        inspect: (rowId) => {
            const stored = rows.get(rowId);
            return stored ? { revision: stored.revision, deleted: stored.deleted } : null;
        },
        seed: (value) => {
            const rowId = rowIdOf(value);
            const previous = rows.get(rowId);
            const revision = (rows.get(rowId)?.revision ?? 0) + 1;
            rows.set(rowId, { revision, value, deleted: false });
            if (watchers.size > 0) {
                changeCursor += 1;
                publishChanges([...(previous && !previous.deleted ? [previous.value] : []), value]);
            }
            return { rowId, revision };
        },
        tombstone: (rowId) => {
            const previous = rows.get(rowId);
            const revision = (rows.get(rowId)?.revision ?? 0) + 1;
            rows.set(rowId, { revision, value: {}, deleted: true });
            if (watchers.size > 0 && previous && !previous.deleted) {
                changeCursor += 1;
                publishChanges([previous.value]);
            }
        },
    };

    return { collection, control };
}
