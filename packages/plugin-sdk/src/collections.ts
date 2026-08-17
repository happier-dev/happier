/** @moduleRealm daemon */
import {
    PluginMachineExecutionOriginV1JsonSchema,
} from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import type {
    NormalizedPluginCollectionUiQueryDescriptorV1,
    PluginAccountCollectionContributionV1,
    PluginCollectionIndexScalarValueV1,
    PluginCollectionIndexV1,
    PluginCollectionMutationConflictV1,
    PluginCollectionMutationErrorV1,
    PluginCollectionMutationResultV1,
    PluginCollectionUiQueryParameterV1,
    PluginCollectionUiQueryRequestV1,
    PluginCollectionUiQueryErrorV1,
    PluginCollectionUiQueryResultV1,
    PluginCollectionUiQueryValueV1,
} from '@happier-dev/protocol';

import type { JsonValue, PluginJsonSchema } from './identity.js';
import type { Disposable, PluginCancellationOptions } from './lifecycle.js';
import type { ProtocolComposableSchema, ProtocolSchemaOutput } from './protocol/protocolFacade.js';

/**
 * Target-artifact code for one static Collection migration identity. The host
 * supplies only an opened, source-contract-validated value; an author cannot
 * name Account, collection, contract, storage, or writer authority here.
 */
export type PluginAccountCollectionMigration<
    TSource extends Readonly<Record<string, JsonValue>> = Readonly<Record<string, JsonValue>>,
    TTarget extends Readonly<Record<string, JsonValue>> = Readonly<Record<string, JsonValue>>,
> = Readonly<{
    id: string;
    fromSchemaVersion: number;
    toSchemaVersion: number;
    migrate: (value: TSource) => TTarget | Promise<TTarget>;
}>;

/**
 * Static, manifest-validated identity used when the host projects Collection
 * migration callbacks. Its migrations stay opaque here because the canonical
 * manifest parser has already validated their static shape.
 */
export type PluginAccountCollectionDeclaration = Readonly<{
    id: string;
    migrations?: unknown;
}>;

/**
 * Canonical reusable JSON-schema fragment for a Collection field that stores
 * an Account-portable machine execution origin.
 */
export { PluginMachineExecutionOriginV1JsonSchema };

/**
 * Account Collection declarations are raw, readonly author data. The manifest
 * parser remains the canonical JSON-schema validator and normalizer. Passing
 * the executable composable schema preserves the typed Collection row shape;
 * its plain JSON-schema projection carries no inference evidence.
 */
export type PluginAccountCollectionDefinition<
    TValue extends Readonly<Record<string, JsonValue>> = Readonly<Record<string, JsonValue>>,
    TIndexes extends PluginCollectionIndexV1[] = PluginCollectionIndexV1[],
> = Readonly<Omit<
    PluginAccountCollectionContributionV1,
    'schema' | 'indexes' | 'rowIdField' | 'uiQueries' | 'relations' | 'migrations'
>> & Readonly<Partial<Pick<
    PluginAccountCollectionContributionV1,
    'rowIdField' | 'uiQueries' | 'relations'
>>> & Readonly<{
    schema: ProtocolComposableSchema<TValue, TValue> | PluginJsonSchema;
    indexes: TIndexes;
    migrations?: readonly PluginAccountCollectionMigration<
        Readonly<Record<string, JsonValue>>,
        TValue
    >[];
}>;

export type PluginAccountCollectionValue<
    TDefinition extends PluginAccountCollectionDefinition,
> = TDefinition extends Readonly<{ schema: infer TSchema }>
    ? TSchema extends ProtocolComposableSchema<unknown, unknown>
        ? ProtocolSchemaOutput<TSchema> extends Readonly<Record<string, JsonValue>>
            ? ProtocolSchemaOutput<TSchema>
            : Readonly<Record<string, JsonValue>>
        : Readonly<Record<string, JsonValue>>
    : Readonly<Record<string, JsonValue>>;

export type PluginAccountCollectionIndexes<
    TDefinition extends PluginAccountCollectionDefinition,
> = TDefinition extends PluginAccountCollectionDefinition<Readonly<Record<string, JsonValue>>, infer TIndexes>
    ? TIndexes
    : readonly PluginCollectionIndexV1[];

export type PluginCollectionIndexId<
    TIndexes extends readonly PluginCollectionIndexV1[],
> = TIndexes[number] extends Readonly<{ id: infer TId extends string }>
    ? TId
    : string;

export type PluginCollectionRow<TValue extends Readonly<Record<string, JsonValue>>> = Readonly<{
    rowId: string;
    revision: number;
    value: TValue;
}>;

/** One bounded keyset query against one statically declared collection index. */
export type PluginCollectionQuery<TIndexId extends string = string> = Readonly<{
    index: TIndexId;
    prefix?: readonly PluginCollectionIndexScalarValueV1[];
    range?: Readonly<{
        lower?: PluginCollectionIndexScalarValueV1;
        upper?: PluginCollectionIndexScalarValueV1;
    }>;
    order: 'asc' | 'desc';
    cursor?: string;
    limit?: number;
}>;

export type PluginCollectionPage<TValue extends Readonly<Record<string, JsonValue>>> = Readonly<{
    rows: readonly PluginCollectionRow<TValue>[];
    nextCursor?: string;
    /** AccountChange cursor, not a page or row revision. */
    changeCursor: number;
}>;

export type PluginCollectionPutMutation<TValue extends Readonly<Record<string, JsonValue>>> = Readonly<{
    kind: 'put';
    value: TValue;
    expectedRevision: number | 'absent';
}>;

export type PluginCollectionDeleteMutation = Readonly<{
    kind: 'delete';
    rowId: string;
    expectedRevision: number;
}>;

/** An exact-currentness precondition for a currently live row in an atomic batch. */
export type PluginCollectionBatchAssert = Readonly<{
    kind: 'assert';
    rowId: string;
    expectedRevision: number;
}>;

export type PluginCollectionMutation<TValue extends Readonly<Record<string, JsonValue>>> =
    | PluginCollectionPutMutation<TValue>
    | PluginCollectionDeleteMutation
    | PluginCollectionBatchAssert;

/** Server-authoritative updated/conflict outcome for a bounded atomic batch. */
export type PluginCollectionBatchResult<_TValue extends Readonly<Record<string, JsonValue>>> =
    | Readonly<Omit<Extract<
        PluginCollectionMutationResultV1,
        Readonly<{ status: 'updated' }>
    >, 'results'> & Readonly<{
        results: readonly Extract<
            PluginCollectionMutationResultV1,
            Readonly<{ status: 'updated' }>
        >['results'][number][];
    }>>
    | Readonly<Omit<Extract<
        PluginCollectionMutationResultV1,
        Readonly<{ status: 'conflict' }>
    >, 'conflicts'> & Readonly<{
        conflicts: readonly Extract<
            PluginCollectionMutationResultV1,
            Readonly<{ status: 'conflict' }>
        >['conflicts'][number][];
    }>>;

export type PluginCollectionMutationConflict = PluginCollectionMutationConflictV1;
export type PluginCollectionMutationError = PluginCollectionMutationErrorV1;

/**
 * Watches are content-free, level-triggered invalidations. Consumers reread
 * after a change or reset rather than treating this as a FIFO row stream.
 */
export type PluginCollectionInvalidation = Readonly<{
    kind: 'changed' | 'reset';
    /** AccountChange cursor, not a page or row revision. */
    changeCursor: number;
}>;

export type PluginCollectionWatchQuery<
    TIndexes extends readonly PluginCollectionIndexV1[],
> = PluginCollectionQuery<PluginCollectionIndexId<TIndexes>>
    | Readonly<{ kind: 'collection' }>;

export interface PluginAccountCollection<
    TValue extends Readonly<Record<string, JsonValue>>,
    TIndexes extends readonly PluginCollectionIndexV1[] = readonly PluginCollectionIndexV1[],
> {
    get(
        rowId: string,
        options?: PluginCancellationOptions,
    ): Promise<PluginCollectionRow<TValue> | null>;
    /**
     * Derive the Account-mode-aware identity value for one declared field of
     * this collection.
     *
     * Row ids and indexed values are plaintext server metadata even on an E2EE
     * Account, so a natural provider key must never become one directly. This is
     * a closed operation, not a key-derivation API: the handle is already bound
     * to one plugin and one admitted contract, and the mode, version, plugin,
     * collection and field are stamped by the host. A plugin supplies only the
     * identity components, and there is no parameter through which it could name
     * another plugin's, collection's, or field's derivation domain.
     *
     * `field` must be this collection's row-id field or a field of one declared
     * index; anything else is rejected rather than derived.
     */
    identityTag(
        request: Readonly<{
            field: Extract<keyof TValue, string>;
            components: readonly string[];
        }>,
        options?: PluginCancellationOptions,
    ): Promise<string>;
    put(
        value: TValue,
        options: Readonly<{
            expectedRevision: number | 'absent';
            signal?: AbortSignal;
        }>,
    ): Promise<PluginCollectionRow<TValue>>;
    delete(
        rowId: string,
        options: Readonly<{
            expectedRevision: number;
            signal?: AbortSignal;
        }>,
    ): Promise<Readonly<{
        rowId: string;
        revision: number;
        deleted: true;
    }>>;
    query<TIndexId extends PluginCollectionIndexId<TIndexes>>(
        request: PluginCollectionQuery<TIndexId>,
        options?: PluginCancellationOptions,
    ): Promise<PluginCollectionPage<TValue>>;
    batch(
        operations: readonly PluginCollectionMutation<TValue>[],
        options?: PluginCancellationOptions,
    ): Promise<PluginCollectionBatchResult<TValue>>;
    watch(
        request: PluginCollectionWatchQuery<TIndexes>,
        listener: (invalidation: PluginCollectionInvalidation) => void,
    ): Disposable;
}

export type PluginAccountCollectionForDefinition<
    TDefinition extends PluginAccountCollectionDefinition,
> = PluginAccountCollection<
    PluginAccountCollectionValue<TDefinition>,
    PluginAccountCollectionIndexes<TDefinition>
>;

/**
 * Keeps collection declarations as values for `definePlugin` while preserving
 * their schema and index inference. Manifest admission remains the sole
 * runtime validation and contract-normalization owner.
 */
export function defineAccountCollection<
    const TDefinition extends PluginAccountCollectionDefinition,
>(definition: TDefinition & Readonly<{
    schema: TDefinition extends Readonly<{ schema: infer TSchema }>
        ? TSchema extends ProtocolComposableSchema<unknown, unknown>
            ? unknown extends ProtocolSchemaOutput<TSchema>
                ? TSchema
                : ProtocolSchemaOutput<TSchema> extends Readonly<Record<string, JsonValue>>
                    ? TSchema
                    : never
            : TSchema
        : never;
}>): TDefinition {
    return definition;
}

/** Exact Data Protocol outcomes exposed by the semantic SDK leaf. */
export type {
    NormalizedPluginCollectionUiQueryDescriptorV1,
    PluginAccountCollectionContributionV1,
    PluginCollectionIndexScalarValueV1,
    PluginCollectionIndexV1,
    PluginCollectionMutationConflictV1,
    PluginCollectionMutationErrorV1,
    PluginCollectionMutationResultV1,
    PluginCollectionUiQueryParameterV1,
    PluginCollectionUiQueryRequestV1,
    PluginCollectionUiQueryErrorV1,
    PluginCollectionUiQueryResultV1,
    PluginCollectionUiQueryValueV1,
};
