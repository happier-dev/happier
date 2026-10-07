import {
    PluginAccountKvRowError,
    PluginAccountStorageMutationRequestV1Schema,
    PluginAccountStorageMutationResponseV1Schema,
    PluginAccountStorageReadResponseV1Schema,
    PluginAccountStorageRowV1Schema,
    PluginAccountStorageUnavailableV1Schema,
    assertPluginAccountKvExpectedVersionV1,
    assertPluginAccountStorageEnvelopeForModeV1,
    clonePluginAccountKvRowV1,
    commitPluginAccountKvMutationV1,
    createEmptyPluginAccountKvRowV1,
    deletePluginAccountKvEntryV1,
    listPluginAccountKvEntriesV1,
    normalizePluginAccountKvLogicalKeyV1,
    openPluginAccountStoragePrivatePayloadV1,
    projectPluginAccountKvEntryV1,
    readPluginAccountKvEntryV1,
    sealPluginAccountStoragePrivatePayloadV1,
    setPluginAccountKvEntryV1,
    type PluginAccountStorageRowV1,
} from '@happier-dev/protocol/plugins/data/accountKvV1';
import { PluginError, type JsonValue } from '@happier-dev/plugin-sdk';
import { mergeAbortSignals } from '@happier-dev/plugin-sdk/async';
import type {
    AccountKvEntry,
    AccountKvListItem,
    AccountKvService,
    AccountKvTransaction,
} from '@happier-dev/plugin-sdk/storage';

import { getRandomBytes } from '@/platform/cryptoRandom';
import type { PluginAccountAvailabilityReader } from '@/sync/domains/plugins/availability/reader';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

import {
    getPreparedCollectionOperationCurrentness,
    prepareCollectionOperation,
    requestCollectionOperation,
    type ActivePluginCollectionOperationOptionsV1,
    type ActivePluginCollectionUnavailableReasonV1,
    type PreparedCollectionOperation,
} from './activePluginCollectionClient';

const ACCOUNT_STORAGE_UNAVAILABLE_CODE = 'plugin_account_storage_unavailable';
const ACCOUNT_KV_INVALID_CODE = 'plugin_account_kv_invalid';
const PROTOCOL_INVALID_CODE = 'plugin_collection_protocol_invalid';
const CANCELLED_CODE = 'plugin_collection_cancelled';

function kvError(code: string, message: string, retryable = false): PluginError {
    return new PluginError({
        code,
        message,
        ...(retryable ? { retryable: true } : {}),
    });
}

function unavailableError(reason: ActivePluginCollectionUnavailableReasonV1): PluginError {
    switch (reason) {
        case 'mutation-outcome-unknown':
            return kvError('plugin_account_storage_outcome_unknown', 'Account KV mutation outcome is unknown');
        case 'operation-cancelled':
            return kvError(CANCELLED_CODE, 'Plugin Account KV operation was cancelled');
        case 'request-not-serializable':
            return kvError(ACCOUNT_KV_INVALID_CODE, 'Account KV row cannot be serialized by this runtime');
        case 'transport-unavailable':
            return kvError(ACCOUNT_STORAGE_UNAVAILABLE_CODE, 'Plugin Account KV transport is unavailable', true);
        default:
            return kvError(
                ACCOUNT_STORAGE_UNAVAILABLE_CODE,
                'Plugin Account KV is unavailable for the current Account',
            );
    }
}

/**
 * Every logical-key rule comes from the Protocol Account KV owner; this adapter
 * only translates its typed failures into the author-facing error vocabulary the
 * daemon runtime already uses, so the same plugin code sees the same codes in
 * both realms.
 */
function inRowAlgebra<T>(operation: () => T): T {
    try {
        return operation();
    } catch (error) {
        if (error instanceof PluginAccountKvRowError) {
            throw kvError(error.code, error.message);
        }
        throw error;
    }
}

async function inRowAlgebraAsync<T>(operation: () => Promise<T>): Promise<T> {
    try {
        return await operation();
    } catch (error) {
        if (error instanceof PluginAccountKvRowError) {
            throw kvError(error.code, error.message);
        }
        throw error;
    }
}

function accountKvPath(pluginId: string): string {
    return `/v1/account/plugin-storage/${encodeURIComponent(pluginId)}`;
}

type AccountKvSnapshot = Readonly<{
    row: PluginAccountStorageRowV1;
    expectedRevision: number | 'absent';
}>;

async function prepare(
    accountLifetime: ActiveServerAccountScopeLifetime,
    options?: ActivePluginCollectionOperationOptionsV1,
): Promise<PreparedCollectionOperation> {
    const outcome = await prepareCollectionOperation(options, accountLifetime);
    if (outcome.status !== 'ready') throw unavailableError(outcome.reason);
    return outcome.operation;
}

function assertStillCurrent(operation: PreparedCollectionOperation): void {
    const currentness = getPreparedCollectionOperationCurrentness(operation);
    if (currentness) throw unavailableError(currentness);
}

function assertSignalActive(signal?: AbortSignal): void {
    if (signal?.aborted) throw unavailableError('operation-cancelled');
}

async function readSnapshot(input: Readonly<{
    pluginId: string;
    operation: PreparedCollectionOperation;
    options?: ActivePluginCollectionOperationOptionsV1;
}>): Promise<AccountKvSnapshot> {
    const response = await requestCollectionOperation({
        operation: input.operation,
        path: accountKvPath(input.pluginId),
        method: 'GET',
        ...(input.options ? { options: input.options } : {}),
    });
    if (response.status !== 'response') throw unavailableError(response.reason);
    if (!response.ok) {
        throw PluginAccountStorageUnavailableV1Schema.safeParse(response.body).success
            ? kvError(ACCOUNT_STORAGE_UNAVAILABLE_CODE, 'Account KV is unavailable on this server')
            : kvError(ACCOUNT_STORAGE_UNAVAILABLE_CODE, 'Account KV read is unavailable', true);
    }
    const parsed = PluginAccountStorageReadResponseV1Schema.safeParse(response.body);
    if (!parsed.success) {
        throw kvError(PROTOCOL_INVALID_CODE, 'Account KV read response is invalid');
    }
    if (parsed.data.status === 'absent') {
        return Object.freeze({
            row: createEmptyPluginAccountKvRowV1(),
            expectedRevision: 'absent' as const,
        });
    }
    if (parsed.data.status === 'deleted') {
        return Object.freeze({
            row: createEmptyPluginAccountKvRowV1(),
            expectedRevision: parsed.data.revision,
        });
    }
    let row: PluginAccountStorageRowV1 | null = null;
    try {
        const envelope = assertPluginAccountStorageEnvelopeForModeV1(
            parsed.data.content,
            input.operation.encryptionMode,
        );
        row = envelope.t === 'plain'
            ? envelope.v
            : input.operation.material
                ? openPluginAccountStoragePrivatePayloadV1({
                    material: input.operation.material,
                    ciphertext: envelope.c,
                })
                : null;
    } catch {
        row = null;
    }
    if (!row) {
        throw kvError(
            PROTOCOL_INVALID_CODE,
            'Account KV content does not match the current Account mode',
        );
    }
    return Object.freeze({ row, expectedRevision: parsed.data.revision });
}

async function writeSnapshot(input: Readonly<{
    pluginId: string;
    operation: PreparedCollectionOperation;
    snapshot: AccountKvSnapshot;
    row: PluginAccountStorageRowV1;
    options?: ActivePluginCollectionOperationOptionsV1;
}>): Promise<'updated' | 'conflict'> {
    let content: unknown;
    try {
        content = Object.keys(input.row.values).length === 0
            ? null
            : input.operation.encryptionMode === 'plain'
                ? { t: 'plain' as const, v: PluginAccountStorageRowV1Schema.parse(input.row) }
                : {
                    t: 'encrypted' as const,
                    c: sealPluginAccountStoragePrivatePayloadV1({
                        material: input.operation.material ?? (() => {
                            throw kvError(
                                ACCOUNT_STORAGE_UNAVAILABLE_CODE,
                                'Account encryption material is unavailable',
                            );
                        })(),
                        payload: PluginAccountStorageRowV1Schema.parse(input.row),
                        randomBytes: getRandomBytes,
                    }),
                };
    } catch (error) {
        if (error instanceof PluginError) throw error;
        throw kvError(ACCOUNT_KV_INVALID_CODE, 'Account KV row exceeds its published bounds');
    }
    const body = PluginAccountStorageMutationRequestV1Schema.safeParse({
        expectedRevision: input.snapshot.expectedRevision,
        content,
    });
    if (!body.success) {
        throw kvError(ACCOUNT_KV_INVALID_CODE, 'Account KV mutation does not satisfy the wire contract');
    }
    const response = await requestCollectionOperation({
        operation: input.operation,
        path: accountKvPath(input.pluginId),
        body: body.data,
        kind: 'mutation',
        ...(input.options ? { options: input.options } : {}),
    });
    if (response.status !== 'response') throw unavailableError(response.reason);
    if (!response.ok) {
        throw PluginAccountStorageUnavailableV1Schema.safeParse(response.body).success
            ? kvError(ACCOUNT_STORAGE_UNAVAILABLE_CODE, 'Account KV is unavailable on this server')
            : unavailableError('mutation-outcome-unknown');
    }
    const parsed = PluginAccountStorageMutationResponseV1Schema.safeParse(response.body);
    if (!parsed.success) {
        throw unavailableError('mutation-outcome-unknown');
    }
    if (parsed.data.status === 'conflict') {
        return 'conflict';
    }
    return 'updated';
}

/**
 * The direct Plugin UI Account KV client for one mounted surface.
 *
 * It is the UI-realm sibling of the daemon runtime's Account KV scope, not a
 * second implementation: key normalization, per-key versions, conditional
 * writes, tombstones, and list paging all come from the Protocol row owner, and
 * transport/currentness/encryption reuse the shared direct-UI Data operation.
 */
export function createActivePluginAccountKvClient(input: Readonly<{
    pluginId: string;
    accountLifetime: ActiveServerAccountScopeLifetime;
    readAvailability: () => PluginAccountAvailabilityReader;
}>): AccountKvService {
    const assertAccountKvAdmitted = (): void => {
        const admission = input.readAvailability().readCurrentAccountKvCapability({
            pluginId: input.pluginId,
        });
        if (admission.kind !== 'available') {
            throw kvError(
                ACCOUNT_STORAGE_UNAVAILABLE_CODE,
                'Plugin Account KV is not admitted by the current Account release',
            );
        }
    };

    // transaction() itself is non-reentrant. Service set/delete calls remain
    // separate logical mutations while a callback is pending, so they advance
    // the same physical row: a transaction that loses its one CAS reports a
    // typed conflict for the author to retry rather than being replayed.
    let explicitTransactionOpen = false;

    const mutate = async <T>(
        operation: (transaction: AccountKvTransaction) => Promise<T>,
        options?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<T> => {
        assertAccountKvAdmitted();
        const prepared = await prepare(input.accountLifetime, options);
        try {
            const snapshot = await readSnapshot({
                pluginId: input.pluginId,
                operation: prepared,
                ...(options ? { options } : {}),
            });
            assertStillCurrent(prepared);
            assertAccountKvAdmitted();
            const row = clonePluginAccountKvRowV1(snapshot.row);
            const transactionSignals = new Set<AbortSignal>();
            let active = true;
            let mutated = false;
            const assertActive = (signal?: AbortSignal): void => {
                if (!active) {
                    throw kvError(
                        ACCOUNT_KV_INVALID_CODE,
                        'Account KV transaction handle is no longer active',
                    );
                }
                assertSignalActive(options?.signal);
                assertSignalActive(signal);
                if (signal) transactionSignals.add(signal);
                assertStillCurrent(prepared);
                assertAccountKvAdmitted();
            };
            const transaction: AccountKvTransaction = Object.freeze({
                async get<TValue extends JsonValue = JsonValue>(
                    key: string,
                    getOptions?: Readonly<{ signal?: AbortSignal }>,
                ): Promise<AccountKvEntry<TValue> | null> {
                    assertActive(getOptions?.signal);
                    const normalized = inRowAlgebra(() => normalizePluginAccountKvLogicalKeyV1(key));
                    const entry = readPluginAccountKvEntryV1(row, normalized);
                    return entry
                        ? inRowAlgebra(() => projectPluginAccountKvEntryV1<TValue>(entry)) as AccountKvEntry<TValue>
                        : null;
                },
                async set(
                    key: string,
                    value: JsonValue,
                    setOptions: Readonly<{ expectedVersion: number | 'absent'; signal?: AbortSignal }>,
                ): Promise<Readonly<{ version: number }>> {
                    assertActive(setOptions.signal);
                    const normalized = inRowAlgebra(() => normalizePluginAccountKvLogicalKeyV1(key));
                    const previous = inRowAlgebra(() => assertPluginAccountKvExpectedVersionV1(
                        row,
                        normalized,
                        setOptions.expectedVersion,
                    ));
                    const version = inRowAlgebra(
                        () => setPluginAccountKvEntryV1(row, normalized, value, previous),
                    );
                    mutated = true;
                    return Object.freeze({ version });
                },
                async delete(
                    key: string,
                    deleteOptions: Readonly<{ expectedVersion: number; signal?: AbortSignal }>,
                ): Promise<Readonly<{ version: number; deleted: true }>> {
                    assertActive(deleteOptions.signal);
                    const normalized = inRowAlgebra(() => normalizePluginAccountKvLogicalKeyV1(key));
                    const previous = inRowAlgebra(() => assertPluginAccountKvExpectedVersionV1(
                        row,
                        normalized,
                        deleteOptions.expectedVersion,
                    ));
                    if (!previous) {
                        throw kvError('plugin_account_kv_conflict', 'Account KV key is absent');
                    }
                    const version = inRowAlgebra(
                        () => deletePluginAccountKvEntryV1(row, normalized, previous),
                    );
                    mutated = true;
                    return Object.freeze({ version, deleted: true as const });
                },
            });
            try {
                const result = await operation(transaction);
                const mergedSignal = mergeAbortSignals([
                    options?.signal,
                    ...transactionSignals,
                ]);
                try {
                    assertSignalActive(mergedSignal.signal);
                    assertStillCurrent(prepared);
                    assertAccountKvAdmitted();
                    if (mutated) {
                        const commitOptions = mergedSignal.signal
                            ? { signal: mergedSignal.signal }
                            : undefined;
                        await inRowAlgebraAsync(async () => await commitPluginAccountKvMutationV1({
                            snapshot,
                            pendingRow: row,
                            assertCurrent: () => {
                                assertSignalActive(mergedSignal.signal);
                                assertStillCurrent(prepared);
                                assertAccountKvAdmitted();
                            },
                            write: async (currentSnapshot, currentRow) => await writeSnapshot({
                                pluginId: input.pluginId,
                                operation: prepared,
                                snapshot: currentSnapshot,
                                row: currentRow,
                                ...(commitOptions ? { options: commitOptions } : {}),
                            }),
                        }));
                    }
                    return result;
                } finally {
                    mergedSignal.dispose();
                }
            } finally {
                active = false;
            }
        } finally {
            await prepared.release();
        }
    };

    const explicitTransaction = async <T>(
        operation: (transaction: AccountKvTransaction) => Promise<T>,
        options?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<T> => {
        if (explicitTransactionOpen) {
            throw kvError(
                ACCOUNT_KV_INVALID_CODE,
                'Nested Account KV transactions are unavailable',
            );
        }
        explicitTransactionOpen = true;
        try {
            return await mutate(operation, options);
        } finally {
            explicitTransactionOpen = false;
        }
    };

    return Object.freeze({
        async get<TValue extends JsonValue = JsonValue>(
            key: string,
            options?: Readonly<{ signal?: AbortSignal }>,
        ) {
            const normalized = inRowAlgebra(() => normalizePluginAccountKvLogicalKeyV1(key));
            assertAccountKvAdmitted();
            const prepared = await prepare(input.accountLifetime, options);
            try {
                const snapshot = await readSnapshot({
                    pluginId: input.pluginId,
                    operation: prepared,
                    ...(options ? { options } : {}),
                });
                assertAccountKvAdmitted();
                const entry = readPluginAccountKvEntryV1(snapshot.row, normalized);
                return entry
                    ? inRowAlgebra(() => projectPluginAccountKvEntryV1<TValue>(entry)) as AccountKvEntry<TValue>
                    : null;
            } finally {
                await prepared.release();
            }
        },
        async set(
            key: string,
            value: JsonValue,
            options: Readonly<{ expectedVersion: number | 'absent'; signal?: AbortSignal }>,
        ): Promise<Readonly<{ version: number }>> {
            return await mutate(
                async (transaction) => await transaction.set(key, value, options),
                options.signal ? { signal: options.signal } : undefined,
            );
        },
        async delete(
            key: string,
            options: Readonly<{ expectedVersion: number; signal?: AbortSignal }>,
        ): Promise<Readonly<{ version: number; deleted: true }>> {
            return await mutate(
                async (transaction) => await transaction.delete(key, options),
                options.signal ? { signal: options.signal } : undefined,
            );
        },
        async list(options: Readonly<{
            cursor?: string;
            limit?: number;
            prefix?: string;
            signal?: AbortSignal;
        }> = {}) {
            // Validate the request shape before spending a read, exactly as the
            // daemon scope does, so an invalid prefix or limit costs no transport.
            inRowAlgebra(() => listPluginAccountKvEntriesV1({
                row: createEmptyPluginAccountKvRowV1(),
                revision: -1,
                ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
                ...(options.limit === undefined ? {} : { limit: options.limit }),
            }));
            assertAccountKvAdmitted();
            const prepared = await prepare(input.accountLifetime, options);
            try {
                const snapshot = await readSnapshot({
                    pluginId: input.pluginId,
                    operation: prepared,
                    options,
                });
                assertAccountKvAdmitted();
                return inRowAlgebra(() => listPluginAccountKvEntriesV1({
                    row: snapshot.row,
                    revision: snapshot.expectedRevision === 'absent' ? -1 : snapshot.expectedRevision,
                    ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
                    ...(options.limit === undefined ? {} : { limit: options.limit }),
                    ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
                })) as Readonly<{
                    items: readonly AccountKvListItem[];
                    nextCursor?: string;
                }>;
            } finally {
                await prepared.release();
            }
        },
        async transaction<T>(
            operation: (transaction: AccountKvTransaction) => Promise<T>,
            options?: Readonly<{ signal?: AbortSignal }>,
        ) {
            return await explicitTransaction(operation, options);
        },
    });
}
