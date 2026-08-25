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
} from '@happier-dev/protocol';
import { PluginError, type JsonValue } from '@happier-dev/plugin-sdk';
import type {
    AccountKvEntry,
    AccountKvListItem,
    AccountKvService,
    AccountKvTransaction,
} from '@happier-dev/plugin-sdk/storage';

import { getRandomBytes } from '@/platform/cryptoRandom';
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
}>): Promise<void> {
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
        ...(input.options ? { options: input.options } : {}),
    });
    if (response.status !== 'response') throw unavailableError(response.reason);
    if (!response.ok) {
        throw PluginAccountStorageUnavailableV1Schema.safeParse(response.body).success
            ? kvError(ACCOUNT_STORAGE_UNAVAILABLE_CODE, 'Account KV is unavailable on this server')
            : kvError(ACCOUNT_STORAGE_UNAVAILABLE_CODE, 'Account KV write is unavailable', true);
    }
    const parsed = PluginAccountStorageMutationResponseV1Schema.safeParse(response.body);
    if (!parsed.success) {
        throw kvError(PROTOCOL_INVALID_CODE, 'Account KV mutation response is invalid');
    }
    if (parsed.data.status === 'conflict') {
        throw kvError(
            'plugin_account_kv_conflict',
            'Account KV changed before the conditional write completed',
        );
    }
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
}>): AccountKvService {
    // One in-flight read-modify-write at a time, so an author cannot mutate the
    // same row through the service while their transaction callback is open.
    let transactionOpen = false;

    const mutate = async <T>(
        operation: (transaction: AccountKvTransaction) => Promise<T>,
        options?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<T> => {
        const prepared = await prepare(input.accountLifetime, options);
        try {
            const snapshot = await readSnapshot({
                pluginId: input.pluginId,
                operation: prepared,
                ...(options ? { options } : {}),
            });
            assertStillCurrent(prepared);
            const row = clonePluginAccountKvRowV1(snapshot.row);
            let active = true;
            let mutated = false;
            const assertActive = (): void => {
                if (!active) {
                    throw kvError(
                        ACCOUNT_KV_INVALID_CODE,
                        'Account KV transaction handle is no longer active',
                    );
                }
                assertStillCurrent(prepared);
            };
            const transaction: AccountKvTransaction = Object.freeze({
                async get<TValue extends JsonValue = JsonValue>(
                    key: string,
                ): Promise<AccountKvEntry<TValue> | null> {
                    assertActive();
                    const entry = readPluginAccountKvEntryV1(
                        row,
                        inRowAlgebra(() => normalizePluginAccountKvLogicalKeyV1(key)),
                    );
                    return entry
                        ? inRowAlgebra(() => projectPluginAccountKvEntryV1<TValue>(entry)) as AccountKvEntry<TValue>
                        : null;
                },
                async set(
                    key: string,
                    value: JsonValue,
                    setOptions: Readonly<{ expectedVersion: number | 'absent' }>,
                ): Promise<Readonly<{ version: number }>> {
                    assertActive();
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
                    deleteOptions: Readonly<{ expectedVersion: number }>,
                ): Promise<Readonly<{ version: number; deleted: true }>> {
                    assertActive();
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
                assertStillCurrent(prepared);
                if (mutated) {
                    await writeSnapshot({
                        pluginId: input.pluginId,
                        operation: prepared,
                        snapshot,
                        row,
                        ...(options ? { options } : {}),
                    });
                }
                return result;
            } finally {
                active = false;
            }
        } finally {
            prepared.release();
        }
    };

    const exclusiveMutate = async <T>(
        operation: (transaction: AccountKvTransaction) => Promise<T>,
        options?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<T> => {
        if (transactionOpen) {
            throw kvError(
                ACCOUNT_KV_INVALID_CODE,
                'Account KV mutations must use the active transaction handle',
            );
        }
        transactionOpen = true;
        try {
            return await mutate(operation, options);
        } finally {
            transactionOpen = false;
        }
    };

    return Object.freeze({
        async get<TValue extends JsonValue = JsonValue>(
            key: string,
            options?: Readonly<{ signal?: AbortSignal }>,
        ) {
            const normalized = inRowAlgebra(() => normalizePluginAccountKvLogicalKeyV1(key));
            const prepared = await prepare(input.accountLifetime, options);
            try {
                const snapshot = await readSnapshot({
                    pluginId: input.pluginId,
                    operation: prepared,
                    ...(options ? { options } : {}),
                });
                const entry = readPluginAccountKvEntryV1(snapshot.row, normalized);
                return entry
                    ? inRowAlgebra(() => projectPluginAccountKvEntryV1<TValue>(entry)) as AccountKvEntry<TValue>
                    : null;
            } finally {
                prepared.release();
            }
        },
        async set(
            key: string,
            value: JsonValue,
            options: Readonly<{ expectedVersion: number | 'absent'; signal?: AbortSignal }>,
        ): Promise<Readonly<{ version: number }>> {
            return await exclusiveMutate(
                async (transaction) => await transaction.set(key, value, options),
                options.signal ? { signal: options.signal } : undefined,
            );
        },
        async delete(
            key: string,
            options: Readonly<{ expectedVersion: number; signal?: AbortSignal }>,
        ): Promise<Readonly<{ version: number; deleted: true }>> {
            return await exclusiveMutate(
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
            const prepared = await prepare(input.accountLifetime, options);
            try {
                const snapshot = await readSnapshot({
                    pluginId: input.pluginId,
                    operation: prepared,
                    options,
                });
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
                prepared.release();
            }
        },
        async transaction<T>(
            operation: (transaction: AccountKvTransaction) => Promise<T>,
            options?: Readonly<{ signal?: AbortSignal }>,
        ) {
            return await exclusiveMutate(operation, options);
        },
    });
}
