import {
    normalizePluginAccountCollectionContractV1,
    PluginAccountCollectionContributionV1Schema,
    type PluginCollectionContractRefV1,
} from '@happier-dev/protocol';
import {
    projectPluginAccountCollectionDeclaration,
    PluginError,
    type JsonValue,
} from '@happier-dev/plugin-sdk';
import type {
    PluginAccountCollectionDefinition,
    PluginAccountCollectionValue,
} from '@happier-dev/plugin-sdk/collections';
import type {
    PluginUiAccountCollectionForDefinition,
    PluginUiDataClient,
    PluginUiCollectionQueryInput,
    PluginUiCollectionQueryPager,
} from '@happier-dev/plugin-ui/data';

import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { PluginAccountAvailabilityReader } from '@/sync/domains/plugins/availability/reader';
import {
    createActivePluginAccountKvClient,
} from './activePluginAccountKvClient';
import {
    createActivePluginCollectionClientForContractRef,
    type ActivePluginCollectionClientForContractRefOutcomeV1,
    type ActivePluginCollectionRejectedV1,
    type ActivePluginCollectionUnavailableReasonV1,
} from './activePluginCollectionClient';
import { createActivePluginCollectionUiQueryPager } from './queryPluginCollectionUiQuery';

const ACCOUNT_STORAGE_UNAVAILABLE_CODE = 'plugin_account_storage_unavailable';
const COLLECTION_UNDECLARED_CODE = 'plugin_collection_undeclared';
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
 */
function normalizeCollectionDefinitionRef(
    pluginId: string,
    definition: PluginAccountCollectionDefinition,
): PluginCollectionContractRefV1 | null {
    const contribution = PluginAccountCollectionContributionV1Schema.safeParse(
        projectPluginAccountCollectionDeclaration(definition.id, definition),
    );
    if (!contribution.success) return null;
    try {
        const contract = normalizePluginAccountCollectionContractV1({
            pluginId,
            contribution: contribution.data,
        });
        return {
            pluginId: contract.pluginId,
            collectionId: contract.collectionId,
            schemaVersion: contract.schemaVersion,
            contractDigest: contract.contractDigest,
        };
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

/**
 * The RN/RNW direct Data adapter for one mounted surface. Availability admits
 * only an immutable current-release ref, the existing Data client reads that
 * ref through its authenticated route, and all row/query semantics remain in
 * the Data owner. This adapter keeps neither a contract cache nor an Account
 * epoch; every operation rechecks the captured lifetime and current admission.
 */
export function createPluginUiDataClient(input: Readonly<{
    pluginId: string;
    accountLifetime: ActiveServerAccountScopeLifetime;
    availabilityReader: PluginAccountAvailabilityReader;
}>): PluginUiDataClient {
    const resolve = async <TValue extends PluginAccountCollectionValue<PluginAccountCollectionDefinition>>(
        requested: PluginCollectionContractRefV1,
        signal?: AbortSignal,
    ) => {
        assertCurrent(input.accountLifetime, signal);
        const admission = input.availabilityReader.readCurrentCollectionContract({
            pluginId: requested.pluginId,
            collectionId: requested.collectionId,
        });
        if (admission.kind !== 'available') {
            const code = admission.code === 'account_availability_not_loaded'
                || admission.code === 'account_availability_scope_mismatch'
                ? ACCOUNT_STORAGE_UNAVAILABLE_CODE
                : COLLECTION_UNDECLARED_CODE;
            throw dataError(
                code,
                code === ACCOUNT_STORAGE_UNAVAILABLE_CODE
                    ? 'Plugin Account Collection availability is not loaded for this Account'
                    : 'The requested Account Collection is not admitted by the current release',
                code === ACCOUNT_STORAGE_UNAVAILABLE_CODE,
            );
        }
        if (
            admission.ref.pluginId !== requested.pluginId
            || admission.ref.collectionId !== requested.collectionId
            || admission.ref.schemaVersion !== requested.schemaVersion
            || admission.ref.contractDigest !== requested.contractDigest
        ) {
            throw dataError(COLLECTION_UNDECLARED_CODE, 'The requested Account Collection is not admitted by the current release');
        }
        const outcome = await createActivePluginCollectionClientForContractRef<TValue>({
            ref: admission.ref,
            ...(signal ? { options: { signal } } : {}),
            accountLifetime: input.accountLifetime,
        });
        assertCurrent(input.accountLifetime, signal);
        return resolvedClient(outcome);
    };

    const collection = <TDefinition extends PluginAccountCollectionDefinition>(
        definition: TDefinition,
    ): PluginUiAccountCollectionForDefinition<TDefinition> => {
        const requested = normalizeCollectionDefinitionRef(input.pluginId, definition);
        if (!requested) {
            throw dataError(COLLECTION_UNDECLARED_CODE, 'The requested Account Collection is not declared');
        }
        return Object.freeze({
            async get(rowId, options) {
                const active = await resolve<PluginAccountCollectionValue<TDefinition>>(requested, options?.signal);
                const outcome = await active.client.get(rowId, options);
                assertCurrent(input.accountLifetime, options?.signal);
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
                assertCurrent(input.accountLifetime, options.signal);
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
                assertCurrent(input.accountLifetime, options.signal);
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
            async query(request, options) {
                const active = await resolve<PluginAccountCollectionValue<TDefinition>>(requested, options?.signal);
                const outcome = await active.client.query({
                    indexId: request.index,
                    ...(request.prefix ? { prefix: request.prefix } : {}),
                    ...(request.range ? { range: request.range } : {}),
                    order: request.order,
                    ...(request.cursor ? { cursor: request.cursor } : {}),
                    ...(request.limit ? { limit: request.limit } : {}),
                }, options);
                assertCurrent(input.accountLifetime, options?.signal);
                if (outcome.status === 'ready') {
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
            },
            async batch(operations, options) {
                const active = await resolve<PluginAccountCollectionValue<TDefinition>>(requested, options?.signal);
                const outcome = await active.client.mutate(operations, options);
                assertCurrent(input.accountLifetime, options?.signal);
                if (outcome.status === 'updated' || outcome.status === 'conflict') return outcome;
                if (outcome.status === 'rejected') {
                    throw rejectedError(outcome);
                }
                throw unavailableError(outcome.reason);
            },
            async limits(options) {
                const active = await resolve<PluginAccountCollectionValue<TDefinition>>(requested, options?.signal);
                const outcome = await active.client.limits(options);
                assertCurrent(input.accountLifetime, options?.signal);
                if (outcome.status === 'ready') return outcome.limits;
                throw unavailableError(outcome.reason);
            },
            async measureBatch(operations, options) {
                const active = await resolve<PluginAccountCollectionValue<TDefinition>>(requested, options?.signal);
                const outcome = await active.client.measureBatch(operations, options);
                assertCurrent(input.accountLifetime, options?.signal);
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
        const admission = input.availabilityReader.readCurrentCollectionContract({
            pluginId: input.pluginId,
            collectionId: query.collectionId,
        });
        if (admission.kind !== 'available') {
            throw dataError(COLLECTION_UNDECLARED_CODE, 'The requested Account Collection is not admitted by the current release');
        }
        const active = await resolve<PluginAccountCollectionValue<PluginAccountCollectionDefinition>>(admission.ref, query.signal);
        const descriptors = active.contract.uiQueries.filter((candidate) => candidate.id === query.uiQueryId);
        if (descriptors.length !== 1) {
            throw dataError(
                COLLECTION_UNDECLARED_CODE,
                'The requested Account Collection UI query is not declared',
            );
        }
        assertCurrent(input.accountLifetime, query.signal);
        return createActivePluginCollectionUiQueryPager({
            descriptor: descriptors[0]!,
            request: {
                pluginId: input.pluginId,
                collectionId: query.collectionId,
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
        accountKv: createActivePluginAccountKvClient({
            pluginId: input.pluginId,
            accountLifetime: input.accountLifetime,
        }),
    });
}
