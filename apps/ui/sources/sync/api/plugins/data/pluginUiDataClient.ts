import { encodePluginCollectionIndexTuplePrefixV1, getPluginCollectionScalarKindV1, normalizePluginAccountCollectionContractV1 } from '@happier-dev/protocol/plugins/data/collectionsV1';
import { PluginAccountCollectionContributionV1Schema } from '@happier-dev/protocol/plugins/data/collectionContributionV1';
import { PluginCollectionRowIdV1Schema } from '@happier-dev/protocol/plugins/data/collectionUiQueryWireV1';
import type { PluginCollectionContractRefV1 } from '@happier-dev/protocol/plugins/data/collectionContractRefV1';
import {
    PluginError,
    type JsonValue,
} from '@happier-dev/plugin-sdk';
import { projectPluginAccountCollectionDeclaration } from '@happier-dev/plugin-sdk/collections';
import type {
    PluginAccountCollectionDefinition,
    PluginAccountCollectionForDefinition,
    PluginAccountCollectionValue,
    PluginCollectionQuery,
} from '@happier-dev/plugin-sdk/collections';
import type {
    PluginUiDataClient,
    PluginUiCollectionQueryInput,
    PluginUiCollectionQueryPager,
} from '@happier-dev/plugin-ui/data';
import type { PluginAccountStorageScope } from '@happier-dev/plugin-sdk/storage';
import { mergeAbortSignals } from '@happier-dev/plugin-sdk/async';

import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { PluginAccountAvailabilityReader } from '@/sync/domains/plugins/availability/reader';
import {
    createActivePluginAccountKvClient,
} from './activePluginAccountKvClient';
import {
    createActivePluginCollectionClientForContractRef,
    prepareCollectionOperation,
    type ActivePluginCollectionClientForContractRefOutcomeV1,
    type ActivePluginCollectionRejectedV1,
    type ActivePluginCollectionUnavailableReasonV1,
} from './activePluginCollectionClient';
import { createActivePluginCollectionUiQueryPager } from './queryPluginCollectionUiQuery';
import { captureActivePluginCollectionReadBasis, registerActivePluginCollectionChangeWatch, registerActivePluginAccountDataChangeWatch } from './pluginCollectionChangeWatch';
import { stableJsonStringify } from '@/utils/json/stableJsonStringify';
import { fetchCurrentChangesCursor } from '@/sync/api/session/apiChanges';
import { ensureActivePluginAccountCollectionContract } from '@/sync/api/plugins/availability/ensureActivePluginAccountCollectionContract';

const ACCOUNT_STORAGE_UNAVAILABLE_CODE = 'plugin_account_storage_unavailable';
const COLLECTION_UNDECLARED_CODE = 'plugin_collection_undeclared';
const COLLECTION_INVALID_VALUE_CODE = 'plugin_collection_invalid_value';
const COLLECTION_PROTOCOL_INVALID_CODE = 'plugin_collection_protocol_invalid';
const COLLECTION_CONFLICT_CODE = 'plugin_collection_conflict';
const COLLECTION_CANCELLED_CODE = 'plugin_collection_cancelled';

function dataError(
    code: string,
    message: string,
    retryable = false,
    details?: JsonValue,
): PluginError {
    return new PluginError({
        code,
        message,
        ...(retryable ? { retryable: true } : {}),
        ...(details === undefined ? {} : { details }),
    });
}

/**
 * A rejection reaches the author with the same code and detail a daemon plugin
 * receives, so a surface that sized its batch through `limits`/`measureBatch`
 * can react to the dimension the server actually enforced.
 */
function rejectedError(outcome: ActivePluginCollectionRejectedV1): PluginError {
    return dataError(
        outcome.code,
        `Plugin Account Collection rejected the operation: ${outcome.code}`,
        false,
        outcome.quotaIncompatibility
            ? {
                dimension: outcome.quotaIncompatibility.dimension,
                effectiveMaximum: outcome.quotaIncompatibility.effectiveMaximum,
            }
            : undefined,
    );
}

function assertCurrent(
    lifetime: ActiveServerAccountScopeLifetime,
    signal?: AbortSignal,
): void {
    if (signal?.aborted) {
        throw dataError(COLLECTION_CANCELLED_CODE, 'Plugin Account Collection operation was cancelled');
    }
    if (!lifetime.isCurrent()) {
        throw dataError(
            ACCOUNT_STORAGE_UNAVAILABLE_CODE,
            'Plugin Account Collection is unavailable for the current Account',
        );
    }
}

function unavailableError(reason: ActivePluginCollectionUnavailableReasonV1): PluginError {
    switch (reason) {
        case 'mutation-outcome-unknown':
            return dataError('plugin_collection_outcome_unknown', 'Collection mutation outcome is unknown');
        case 'operation-cancelled':
            return dataError(COLLECTION_CANCELLED_CODE, 'Plugin Account Collection operation was cancelled');
        case 'collection-unavailable':
            return dataError(COLLECTION_UNDECLARED_CODE, 'The requested Account Collection is not admitted');
        case 'response-invalid':
        case 'account-content-mismatch':
            return dataError(
                COLLECTION_PROTOCOL_INVALID_CODE,
                'Plugin Account Collection returned an invalid current-Account response',
            );
        case 'request-not-serializable':
            return dataError(
                COLLECTION_INVALID_VALUE_CODE,
                'Collection request cannot be serialized by this runtime',
            );
        case 'transport-unavailable':
            return dataError(
                ACCOUNT_STORAGE_UNAVAILABLE_CODE,
                'Plugin Account Collection transport is unavailable',
                true,
            );
        default:
            return dataError(
                ACCOUNT_STORAGE_UNAVAILABLE_CODE,
                'Plugin Account Collection is unavailable for the current Account',
            );
    }
}

/**
 * The SDK's declaration projector is the one owner that turns an executable
 * author definition into its static manifest shape — it strips the executable
 * schema surface AND the migration callbacks a declaration may carry. The
 * daemon binds its declared collections through exactly this call, so a surface
 * and its daemon side resolve the same contract digest for the same value.
 *
 * A definition is a plugin module's static value: plugins call
 * `collection(DEFINITION)` per operation from a fresh binding per Action
 * invocation, and each normalization digests the whole contract. So the
 * result is held per definition object, as the daemon's binding does
 * (`accountPluginDataStorage.ts`, `admitted.definitions`). Admission still
 * checks the ref against the current release on every operation.
 *
 * The hosted-web bridge parses the declaration out of each message, so its
 * objects are never reused. Those also hit by content: one entry per plugin
 * Collection, keyed by the projected declaration's JSON text (a walk, not the
 * contract digest). A changed declaration replaces the entry.
 */
type PreparedCollectionDefinition = ReturnType<typeof prepareCollectionDefinition>;
const normalizedDefinitions = new WeakMap<object, Map<string, PreparedCollectionDefinition>>();
const declaredDefinitions = new Map<string, Readonly<{ text: string; prepared: PreparedCollectionDefinition }>>();

function normalizeCollectionDefinition(
    pluginId: string,
    definition: PluginAccountCollectionDefinition,
) {
    let byPlugin = normalizedDefinitions.get(definition);
    if (!byPlugin) {
        byPlugin = new Map();
        normalizedDefinitions.set(definition, byPlugin);
    }
    if (!byPlugin.has(pluginId)) byPlugin.set(pluginId, prepareDeclaredCollectionDefinition(pluginId, definition));
    return byPlugin.get(pluginId)!;
}

function prepareDeclaredCollectionDefinition(
    pluginId: string,
    definition: PluginAccountCollectionDefinition,
): PreparedCollectionDefinition {
    const declaration = projectPluginAccountCollectionDeclaration(definition.id, definition);
    let text: string;
    try {
        text = JSON.stringify(declaration);
    } catch {
        return prepareCollectionDefinition(pluginId, declaration);
    }
    const key = JSON.stringify([pluginId, String(definition.id)]);
    const held = declaredDefinitions.get(key);
    if (held?.text === text) return held.prepared;
    const prepared = prepareCollectionDefinition(pluginId, declaration);
    declaredDefinitions.set(key, { text, prepared });
    return prepared;
}

function prepareCollectionDefinition(
    pluginId: string,
    declaration: ReturnType<typeof projectPluginAccountCollectionDeclaration>,
) {
    const contribution = PluginAccountCollectionContributionV1Schema.safeParse(declaration);
    if (!contribution.success) return null;
    try {
        const contract = normalizePluginAccountCollectionContractV1({
            pluginId,
            contribution: contribution.data,
        });
        return { contract, ref: {
            pluginId: contract.pluginId,
            collectionId: contract.collectionId,
            schemaVersion: contract.schemaVersion,
            contractDigest: contract.contractDigest,
        } satisfies PluginCollectionContractRefV1 };
    } catch {
        return null;
    }
}

function resolvePutRowId(
    value: PluginAccountCollectionValue<PluginAccountCollectionDefinition>,
    rowIdField: string,
): string | null {
    const candidate = value[rowIdField];
    return typeof candidate === 'string' ? candidate : null;
}

function resolvedClient<TValue extends PluginAccountCollectionValue<PluginAccountCollectionDefinition>>(
    outcome: ActivePluginCollectionClientForContractRefOutcomeV1<TValue>,
): Extract<ActivePluginCollectionClientForContractRefOutcomeV1<TValue>, Readonly<{ status: 'ready' }>> {
    if (outcome.status === 'ready') return outcome;
    if (outcome.status === 'rejected') throw rejectedError(outcome);
    throw unavailableError(outcome.reason);
}

type ResolvedCollection<TValue extends PluginAccountCollectionValue<PluginAccountCollectionDefinition>> = Extract<
    ActivePluginCollectionClientForContractRefOutcomeV1<TValue>, Readonly<{ status: 'ready' }>
>;

/**
 * The RN/RNW direct Data adapter for a surface or Account Action. Availability admits
 * only an immutable current-release ref, the existing Data client reads that
 * ref through its authenticated route, and all row/query semantics remain in
 * the Data owner. This adapter keeps neither a contract cache nor an Account
 * epoch; every operation rechecks the captured lifetime and current admission.
 */
type PluginUiDataBindingInput = Readonly<{
    pluginId: string;
    accountLifetime: ActiveServerAccountScopeLifetime;
    readAvailability: () => PluginAccountAvailabilityReader;
    signal?: AbortSignal;
    isCurrent?: () => boolean;
}>;

function createPluginUiDataBindings(input: PluginUiDataBindingInput) {
    // New observations start after the last snapshot acquired by this binding.
    // Incumbent observations advance only through their own matching read.
    let acquisitionCursor: number | undefined;
    const queryReadBasis = (request: PluginCollectionQuery) => {
        const { cursor: _cursor, limit: _limit, ...selection } = request;
        return { owner: input, key: stableJsonStringify({ ...selection, prefix: request.prefix ?? [] }) };
    };
    const assertBindingCurrent = (signal?: AbortSignal) => {
        assertCurrent(input.accountLifetime, input.signal);
        assertCurrent(input.accountLifetime, signal);
        if (input.isCurrent?.() === false) {
            throw dataError(ACCOUNT_STORAGE_UNAVAILABLE_CODE, 'Account storage invocation is no longer current');
        }
    };
    const admit = (requested: PluginCollectionContractRefV1, signal?: AbortSignal) => {
        assertBindingCurrent(signal);
        const admission = input.readAvailability().readCurrentCollectionContract({
            pluginId: requested.pluginId,
            collectionId: requested.collectionId,
            ref: requested,
        });
        if (admission.kind !== 'available') {
            const code = admission.code === 'account_availability_not_loaded'
                || admission.code === 'account_availability_scope_mismatch'
                ? ACCOUNT_STORAGE_UNAVAILABLE_CODE
                : COLLECTION_UNDECLARED_CODE;
            throw dataError(
                code,
                'The requested Account Collection is not admitted by the current release',
                code === ACCOUNT_STORAGE_UNAVAILABLE_CODE,
            );
        }
        if (admission.ref.pluginId !== requested.pluginId
            || admission.ref.collectionId !== requested.collectionId
            || admission.ref.schemaVersion !== requested.schemaVersion
            || admission.ref.contractDigest !== requested.contractDigest) {
            throw dataError(COLLECTION_UNDECLARED_CODE, 'The requested Account Collection is not admitted by the current release');
        }
        return admission;
    };
    const ensureCollectionAdmitted = async (
        request: Readonly<{ ref: PluginCollectionContractRefV1 }> | Readonly<{ collectionId: string }>,
        signal?: AbortSignal,
    ) => {
        assertBindingCurrent(signal);
        const cancellation = mergeAbortSignals([input.signal, signal]);
        try {
            return await ensureActivePluginAccountCollectionContract({
                ...request,
                pluginId: input.pluginId,
                accountLifetime: input.accountLifetime,
                signal: cancellation.signal,
                isCurrent: input.isCurrent,
                readAvailability: input.readAvailability,
            });
        } finally {
            cancellation.dispose();
        }
    };
    const resolve = async <TValue extends PluginAccountCollectionValue<PluginAccountCollectionDefinition>>(
        requested: PluginCollectionContractRefV1,
        signal?: AbortSignal,
        fresh = true,
    ): Promise<ResolvedCollection<TValue>> => {
        assertBindingCurrent(signal);
        await ensureCollectionAdmitted({ ref: requested }, signal);
        const admission = admit(requested, signal);
        const outcome = await createActivePluginCollectionClientForContractRef<TValue>({
            ref: admission.ref,
            ...(signal ? { options: { signal } } : {}),
            accountLifetime: input.accountLifetime,
            assertAdmitted: () => { admit(requested, signal); },
            signal: input.signal,
            fresh,
        });
        admit(requested, signal);
        return resolvedClient(outcome);
    };

    const collection = <TDefinition extends PluginAccountCollectionDefinition>(
        definition: TDefinition,
    ): PluginAccountCollectionForDefinition<TDefinition> => {
        const normalized = normalizeCollectionDefinition(input.pluginId, definition);
        if (!normalized) {
            throw dataError(COLLECTION_UNDECLARED_CODE, 'The requested Account Collection is not declared');
        }
        const requested = normalized.ref;
        return Object.freeze<PluginAccountCollectionForDefinition<TDefinition>>({
            sharing: Object.freeze<PluginAccountCollectionForDefinition<TDefinition>['sharing']>({
                async setGrant(rowId, request, options) {
                    const active = await resolve<PluginAccountCollectionValue<TDefinition>>(requested, options?.signal);
                    return await active.client.sharing.setGrant(rowId, request, options);
                },
                async listGrants(rowId, options) {
                    const active = await resolve<PluginAccountCollectionValue<TDefinition>>(requested, options?.signal, false);
                    return await active.client.sharing.listGrants(rowId, options);
                },
                async revokeGrant(rowId, request, options) {
                    const active = await resolve<PluginAccountCollectionValue<TDefinition>>(requested, options?.signal);
                    return await active.client.sharing.revokeGrant(rowId, request, options);
                },
                async sharedWithMe(request, options) {
                    const active = await resolve<PluginAccountCollectionValue<TDefinition>>(requested, options?.signal, false);
                    return await active.client.sharing.sharedWithMe(request, options);
                },
                async get(address, options) {
                    const active = await resolve<PluginAccountCollectionValue<TDefinition>>(requested, options?.signal, false);
                    return await active.client.sharing.get(address, options);
                },
                async put(request, options) {
                    const active = await resolve<PluginAccountCollectionValue<TDefinition>>(requested, options?.signal);
                    return await active.client.sharing.put(request, options);
                },
            }),
            watch(request, listener) {
                admit(requested);
                if (!('kind' in request) && !definition.indexes.some(index => index.id === request.index)) {
                    throw dataError(COLLECTION_INVALID_VALUE_CODE, 'Collection watch names an undeclared index');
                }
                const row = 'kind' in request && request.kind === 'row'
                    ? PluginCollectionRowIdV1Schema.safeParse(request.rowId) : undefined;
                if (row?.success === false) {
                    throw dataError(COLLECTION_INVALID_VALUE_CODE, 'Collection watch names an invalid row');
                }
                const indexSelection = 'kind' in request ? undefined : (() => {
                    const index = normalized.contract.indexes.find(index => index.id === request.index)!;
                    try {
                        return { indexId: index.id, prefixes: (request.prefixes ?? [request.prefix ?? []]).map(prefix => {
                            if (prefix.length > index.fields.length) throw new Error('Invalid index prefix');
                            const encoded = encodePluginCollectionIndexTuplePrefixV1({ fields: prefix.map((value, position) => {
                                const field = index.fields[position]!;
                                return { value, direction: field.direction,
                                    kind: getPluginCollectionScalarKindV1({ schema: normalized.contract.schema, field: field.field }) };
                            }) });
                            return [...encoded].map(byte => byte.toString(16).padStart(2, '0')).join('');
                        }) };
                    } catch { throw dataError(COLLECTION_INVALID_VALUE_CODE, 'Collection watch has an invalid index prefix'); }
                })();
                const controller = new AbortController();
                let disposed = false;
                let retirement: Readonly<{ dispose(): void }> | undefined;
                let watch: Readonly<{ dispose(): void }> | undefined;
                const dispose = () => {
                    if (disposed) return;
                    disposed = true;
                    controller.abort();
                    input.signal?.removeEventListener('abort', dispose);
                    watch?.dispose();
                    retirement?.dispose();
                };
                const notify = (invalidation: Parameters<typeof listener>[0]) => {
                    if (disposed) return;
                    try {
                        admit(requested);
                    } catch {
                        dispose();
                        return;
                    }
                    listener(invalidation);
                };
                watch = registerActivePluginCollectionChangeWatch({
                    pluginId: requested.pluginId,
                    collectionId: requested.collectionId,
                    contractDigest: requested.contractDigest,
                    ...(indexSelection ? { indexSelection } : {}),
                    ...(row?.success ? { rowId: row.data } : {}),
                    lifetime: input.accountLifetime,
                    ...(!('kind' in request) ? { readBasis: queryReadBasis(request) } : {}),
                    ...(acquisitionCursor === undefined ? {} : { acquisitionCursor }),
                    onInvalidated(invalidation) {
                        if (disposed) return;
                        try {
                            admit(requested);
                        } catch {
                            dispose();
                            return;
                        }
                        if (invalidation) { notify(invalidation); return; }
                        // Snapshot repair supplies a wakeup without a cursor. Read
                        // the existing authenticated cursor owner once; never
                        // manufacture an AccountChange cursor from a row revision.
                        void (async () => {
                            const prepared = await prepareCollectionOperation({ signal: controller.signal }, input.accountLifetime, input.signal);
                            if (prepared.status !== 'ready') return;
                            try {
                                const authority = prepared.operation.authority;
                                const cursor = await fetchCurrentChangesCursor({
                                    credentials: authority.context.credentials ?? { token: authority.context.token },
                                    request: (path, init) => authority.request(path, { ...init, signal: prepared.operation.signal }),
                                });
                                if (cursor.status === 'ok') notify({ kind: 'reset', changeCursor: Number(cursor.cursor) });
                            } finally { await prepared.operation.release(); }
                        })().catch(() => undefined);
                    },
                });
                retirement = input.accountLifetime.onRetire(dispose);
                input.signal?.addEventListener('abort', dispose, { once: true });
                if (input.signal?.aborted) dispose();
                if (!input.accountLifetime.isCurrent()) dispose();
                return Object.freeze({ dispose });
            },
            async identityTag(request, options) {
                const active = await resolve<PluginAccountCollectionValue<TDefinition>>(requested, options?.signal, false);
                const outcome = await active.client.identityTag(request, options);
                admit(requested, options?.signal);
                if (outcome.status === 'ready') return outcome.tag;
                if (outcome.status === 'rejected') throw rejectedError(outcome);
                throw unavailableError(outcome.reason);
            },
            async get(rowId, options) {
                const active = await resolve<PluginAccountCollectionValue<TDefinition>>(requested, options?.signal, false);
                const outcome = await active.client.get(rowId, options);
                admit(requested, options?.signal);
                if (outcome.status === 'ready') {
                    return outcome.row;
                }
                if (outcome.status === 'rejected') {
                    throw rejectedError(outcome);
                }
                throw unavailableError(outcome.reason);
            },
            async put(value, options) {
                const active = await resolve<PluginAccountCollectionValue<TDefinition>>(requested, options.signal);
                const outcome = await active.client.mutate([{
                    kind: 'put',
                    value,
                    expectedRevision: options.expectedRevision,
                }], options);
                if (outcome.status === 'conflict') {
                    throw dataError(COLLECTION_CONFLICT_CODE, 'Collection mutation conflicted with a newer row revision');
                }
                if (outcome.status === 'rejected') {
                    throw rejectedError(outcome);
                }
                if (outcome.status === 'unavailable') throw unavailableError(outcome.reason);
                const entry = outcome.results[0];
                const expectedRowId = resolvePutRowId(value, active.contract.rowIdField);
                if (!entry || entry.deleted || !expectedRowId || entry.rowId !== expectedRowId) {
                    throw dataError(
                        COLLECTION_PROTOCOL_INVALID_CODE,
                        'Collection mutation response omitted its expected updated row',
                    );
                }
                return Object.freeze({
                    rowId: entry.rowId,
                    revision: entry.revision,
                    value,
                });
            },
            async delete(rowId, options) {
                const active = await resolve<PluginAccountCollectionValue<TDefinition>>(requested, options.signal);
                const outcome = await active.client.mutate([{
                    kind: 'delete',
                    rowId,
                    expectedRevision: options.expectedRevision,
                }], options);
                if (outcome.status === 'conflict') {
                    throw dataError(COLLECTION_CONFLICT_CODE, 'Collection mutation conflicted with a newer row revision');
                }
                if (outcome.status === 'rejected') {
                    throw rejectedError(outcome);
                }
                if (outcome.status === 'unavailable') throw unavailableError(outcome.reason);
                const entry = outcome.results[0];
                if (!entry || !entry.deleted || entry.rowId !== rowId) {
                    throw dataError(
                        COLLECTION_PROTOCOL_INVALID_CODE,
                        'Collection mutation response omitted its expected deleted row',
                    );
                }
                return Object.freeze({
                    rowId: entry.rowId,
                    revision: entry.revision,
                    deleted: true as const,
                });
            },
            async forget(rowId, options) {
                const active = await resolve<PluginAccountCollectionValue<TDefinition>>(requested, options.signal);
                const outcome = await active.client.forget(rowId, options.expectedRevision, options);
                if (outcome.status === 'forgotten') return Object.freeze({ rowId, forgotten: true as const });
                if (outcome.status === 'conflict') {
                    throw dataError(COLLECTION_CONFLICT_CODE, 'Collection forget conflicted with a newer row revision');
                }
                if (outcome.status === 'rejected') throw rejectedError(outcome);
                throw unavailableError(outcome.reason);
            },
            async query(request, options) {
                const commitReadBasis = request.cursor === undefined ? captureActivePluginCollectionReadBasis({
                    pluginId: requested.pluginId, collectionId: requested.collectionId,
                    lifetime: input.accountLifetime, readBasis: queryReadBasis(request),
                }) : undefined;
                try {
                    const active = await resolve<PluginAccountCollectionValue<TDefinition>>(requested, options?.signal, false);
                    const outcome = await active.client.query({
                        indexId: request.index,
                        ...(request.prefix ? { prefix: request.prefix } : {}),
                        ...(request.prefixes === undefined ? {} : { prefixes: request.prefixes }),
                        ...(request.range ? { range: request.range } : {}),
                        order: request.order,
                        ...(request.cursor ? { cursor: request.cursor } : {}),
                        ...(request.limit ? { limit: request.limit } : {}),
                    }, options);
                    admit(requested, options?.signal);
                    if (outcome.status === 'ready') {
                        acquisitionCursor = Math.max(acquisitionCursor ?? 0, outcome.changeCursor);
                        commitReadBasis?.(outcome.changeCursor);
                        return Object.freeze({
                            rows: outcome.rows.map((row) => Object.freeze({
                                rowId: row.rowId,
                                revision: row.revision,
                                value: row.value,
                            })),
                            ...(outcome.nextCursor ? { nextCursor: outcome.nextCursor } : {}),
                            changeCursor: outcome.changeCursor,
                        });
                    }
                    if (outcome.status === 'rejected') {
                        throw rejectedError(outcome);
                    }
                    throw unavailableError(outcome.reason);
                } finally { commitReadBasis?.(); }
            },
            async batch(operations, options) {
                const active = await resolve<PluginAccountCollectionValue<TDefinition>>(requested, options?.signal);
                const outcome = await active.client.mutate(operations, options);
                if (outcome.status === 'updated' || outcome.status === 'conflict') return outcome;
                if (outcome.status === 'rejected') {
                    throw rejectedError(outcome);
                }
                throw unavailableError(outcome.reason);
            },
            async limits(options) {
                const active = await resolve<PluginAccountCollectionValue<TDefinition>>(requested, options?.signal, false);
                const outcome = await active.client.limits(options);
                admit(requested, options?.signal);
                if (outcome.status === 'ready') return outcome.limits;
                throw unavailableError(outcome.reason);
            },
            async measureBatch(operations, options) {
                const active = await resolve<PluginAccountCollectionValue<TDefinition>>(requested, options?.signal, false);
                const outcome = await active.client.measureBatch(operations, options);
                admit(requested, options?.signal);
                if (outcome.status === 'ready') return outcome.measurement;
                if (outcome.status === 'rejected') {
                    throw rejectedError(outcome);
                }
                throw unavailableError(outcome.reason);
            },
        });
    };

    const openCollectionQuery = async (
        query: PluginUiCollectionQueryInput,
    ): Promise<PluginUiCollectionQueryPager> => {
        await ensureCollectionAdmitted({ collectionId: query.collectionId }, query.signal);
        const admission = input.readAvailability().readCurrentCollectionContract({
            pluginId: input.pluginId,
            collectionId: query.collectionId,
        });
        if (admission.kind !== 'available') {
            throw dataError(COLLECTION_UNDECLARED_CODE, 'The requested Account Collection is not admitted by the current release');
        }
        const active = await resolve<PluginAccountCollectionValue<PluginAccountCollectionDefinition>>(admission.ref, query.signal, false);
        const descriptors = active.contract.uiQueries.filter((candidate) => candidate.id === query.uiQueryId);
        if (descriptors.length !== 1) {
            throw dataError(
                COLLECTION_UNDECLARED_CODE,
                'The requested Account Account Data is not declared',
            );
        }
        assertBindingCurrent(query.signal);
        return createActivePluginCollectionUiQueryPager({
            descriptor: descriptors[0]!,
            contract: active.contract,
            request: {
                pluginId: input.pluginId,
                collectionId: query.collectionId,
                readerContext: {
                    pluginId: active.contract.pluginId,
                    collectionId: active.contract.collectionId,
                    schemaVersion: active.contract.schemaVersion,
                    contractDigest: active.contract.contractDigest,
                },
                uiQueryId: query.uiQueryId,
                parameters: query.parameters,
            },
        }, {
            accountLifetime: input.accountLifetime,
            ...(query.signal ? { signal: query.signal } : {}),
        });
    };

    return Object.freeze({
        collection,
        openCollectionQuery,
        async watchAccountData(selection: Parameters<PluginUiDataClient['watchAccountData']>[0], listener: () => void, options?: Readonly<{ signal?: AbortSignal }>) {
            assertBindingCurrent(options?.signal);
            const watch = registerActivePluginAccountDataChangeWatch({ pluginId: input.pluginId, selection,
                lifetime: input.accountLifetime, onInvalidated: listener });
            const cancellation = mergeAbortSignals([input.signal, options?.signal]);
            const signal = cancellation.signal;
            const dispose = () => { watch.dispose(); signal?.removeEventListener('abort', dispose); cancellation.dispose(); };
            signal?.addEventListener('abort', dispose, { once: true });
            if (signal?.aborted) dispose();
            return Object.freeze({ dispose });
        },
        accountKv: createActivePluginAccountKvClient({
            pluginId: input.pluginId,
            accountLifetime: input.accountLifetime,
            readAvailability: input.readAvailability,
            signal: input.signal,
            isCurrent: input.isCurrent,
        }),
    });
}

/** Both surface data and Account Actions bind the same Account data owner. */
export function createPluginUiDataClient(input: PluginUiDataBindingInput): PluginUiDataClient {
    return createPluginUiDataBindings(input);
}

export function createPluginUiAccountStorageScope(input: PluginUiDataBindingInput): PluginAccountStorageScope {
    const bindings = createPluginUiDataBindings(input);
    return Object.freeze({ kv: bindings.accountKv, collection: bindings.collection });
}
