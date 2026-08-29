import { AsyncLocalStorage } from 'node:async_hooks';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { JsonValue } from '@happier-dev/plugin-sdk';
import type {
    DaemonDatabaseStorageScope,
    PluginAccountStorageScope,
    StorageConsistency,
    StorageScopeService,
    StorageService,
    StorageTransaction,
} from '@happier-dev/plugin-sdk/storage';

import type { PluginStorePaths } from '@/plugins/store/paths';
import { withJsonOwnerFileLock } from '@/utils/fs/jsonOwnerFileLock';
import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';

import { PluginContextServiceError } from './errors';
import {
    createUnavailablePluginDaemonDatabaseService,
    type StablePluginDaemonDatabaseHost,
} from './daemonDatabase';
import { normalizePluginStorageNamespace } from './pluginNamespace';
import { preparePluginOwnedDataDirectoryRemoval } from './pluginOwnedDataDirectory';
import { setOwnRecordValue } from './recordOwnProperties';

type JsonObject = Record<string, unknown>;

export interface PluginStorageOwnerScope {
    get<T = unknown>(key: string): Promise<T | null>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
    listKeys(): Promise<readonly string[]>;
}

export interface PluginStorageOwner {
    readonly ephemeral: PluginStorageOwnerScope;
    readonly daemonSession: PluginStorageOwnerScope;
    readonly daemon: PluginStorageOwnerScope;
}

type AtomicStorageUpdate = <T>(
    key: string,
    operation: (current: unknown | null) => Readonly<{
        value: unknown;
        result: T;
        skipWrite?: boolean;
    }>,
) => Promise<T>;

const atomicStorageUpdates = new WeakMap<object, AtomicStorageUpdate>();
type AtomicStorageTransaction = <T>(
    operation: (transaction: StorageTransaction) => Promise<T>,
    signal?: AbortSignal,
) => Promise<T>;
const atomicStorageTransactions = new WeakMap<object, AtomicStorageTransaction>();
const pluginStorageTransactionContext = new AsyncLocalStorage<ReadonlySet<object>>();

export type PreparePluginStorageDataRemovalParams = Readonly<{
    pluginId: string;
    paths: PluginStorePaths;
    removeDirectory?: (directoryPath: string) => Promise<void>;
}>;

export type CreatePluginStorageOwnerParams = Readonly<{
    pluginId: string;
    paths: PluginStorePaths;
    sessionId?: string | (() => string | null | undefined) | null;
}>;

/**
 * The Account Data owner supplies this port once its authenticated Protocol
 * client exists. It receives the host-stamped plugin/generation lifecycle;
 * no plugin-supplied caller, Account id, writer contract, raw HTTP, or local
 * fallback crosses this seam.
 */
export type StablePluginAccountStorageHost = Readonly<{
    bind(input: Readonly<{
        pluginId: string;
        generation: string;
        signal: AbortSignal;
        /**
         * Resource admission currentness comes from the committed registry and
         * can require asynchronous confirmation. The Account owner is the
         * mutation authority, so it must re-check that live fact itself
         * before crossing its Account boundary.
         */
        isGenerationCurrent(): boolean | Promise<boolean>;
    }>): PluginAccountStorageScope | null;
}>;

export type PluginStoragePublicShareSnapshotV1 = Readonly<{
    t: 'happier_plugin_public_share_storage_snapshot_v1';
    plugins: readonly [];
}>;

type StorageFileV1 = Readonly<{
    t: 'happier_plugin_storage_scope_v1';
    values: JsonObject;
}>;

type StorageListCursorV1 = Readonly<{
    t: 'happier_plugin_storage_list_cursor_v1';
    prefix: string | null;
    after: string;
}>;

export const PLUGIN_HOST_STORAGE_KEY_PREFIX = '@happier/';
export const PLUGIN_ACCOUNT_STORAGE_UNAVAILABLE_CODE = 'plugin_account_storage_unavailable';

function createStorageFile(values: JsonObject = {}): StorageFileV1 {
    return Object.freeze({
        t: 'happier_plugin_storage_scope_v1',
        values: Object.freeze({ ...values }),
    });
}

function parseStorageFile(value: unknown, filePath: string): StorageFileV1 {
    if (!isRecord(value) || value.t !== 'happier_plugin_storage_scope_v1' || !isRecord(value.values)) {
        throw new PluginContextServiceError(
            'PLUGIN_STORAGE_FILE_INVALID',
            `Invalid plugin storage file at ${filePath}`,
        );
    }
    return createStorageFile(value.values);
}

function isRecord(value: unknown): value is JsonObject {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function createStorageListCursor(params: Readonly<{
    prefix: string | undefined;
    after: string;
}>): string {
    const cursor: StorageListCursorV1 = {
        t: 'happier_plugin_storage_list_cursor_v1',
        prefix: params.prefix ?? null,
        after: params.after,
    };
    return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function readStorageListCursor(cursor: string, expectedPrefix: string | undefined): string {
    try {
        const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        if (!isRecord(parsed)
            || parsed.t !== 'happier_plugin_storage_list_cursor_v1'
            || parsed.prefix !== (expectedPrefix ?? null)
            || typeof parsed.after !== 'string') {
            throw new Error('Invalid plugin storage cursor');
        }
        return parsed.after;
    } catch {
        throw new PluginContextServiceError('PLUGIN_STORAGE_CURSOR_INVALID', 'Plugin storage list cursor is invalid');
    }
}

function cloneJsonValue<T>(value: T): T {
    if (value === undefined) {
        return value;
    }
    return JSON.parse(JSON.stringify(value)) as T;
}

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
        throw new PluginContextServiceError('PLUGIN_STORAGE_CANCELLED', 'Plugin storage operation was cancelled');
    }
}

function createTransactionHandle(values: JsonObject, signal?: AbortSignal): Readonly<{
    transaction: StorageTransaction;
    end: () => void;
}> {
    let active = true;
    const assertActive = (operationSignal?: AbortSignal): void => {
        if (!active) {
            throw new PluginContextServiceError(
                'plugin_storage_transaction_ended',
                'Plugin storage transaction handle is no longer active',
            );
        }
        throwIfAborted(signal);
        throwIfAborted(operationSignal);
    };
    return Object.freeze({
        transaction: Object.freeze({
            async get<T extends JsonValue = JsonValue>(key: string, options?: { signal?: AbortSignal }): Promise<T | null> {
                assertActive(options?.signal);
                return Object.prototype.hasOwnProperty.call(values, key)
                    ? cloneJsonValue(values[key] as T)
                    : null;
            },
            async set(key: string, value: JsonValue, options?: { signal?: AbortSignal }): Promise<void> {
                assertActive(options?.signal);
                setOwnRecordValue(values as Record<string, JsonValue>, key, cloneJsonValue(value));
            },
            async delete(key: string, options?: { signal?: AbortSignal }): Promise<void> {
                assertActive(options?.signal);
                delete values[key];
            },
        }),
        end: () => { active = false; },
    });
}

async function runTransaction<T>(params: Readonly<{
    values: JsonObject;
    operation: (transaction: StorageTransaction) => Promise<T>;
    signal?: AbortSignal;
}>): Promise<T> {
    throwIfAborted(params.signal);
    const handle = createTransactionHandle(params.values, params.signal);
    try {
        const result = await params.operation(handle.transaction);
        throwIfAborted(params.signal);
        return result;
    } finally {
        handle.end();
    }
}

function createMemoryScope(): PluginStorageOwnerScope {
    const values = new Map<string, unknown>();
    const scope: PluginStorageOwnerScope = Object.freeze({
        async get<T = unknown>(key: string): Promise<T | null> {
            return values.has(key) ? cloneJsonValue(values.get(key) as T) : null;
        },
        async set(key: string, value: unknown): Promise<void> {
            values.set(key, cloneJsonValue(value));
        },
        async delete(key: string): Promise<void> {
            values.delete(key);
        },
        async listKeys(): Promise<readonly string[]> {
            return Object.freeze([...values.keys()].sort());
        },
    });
    let transactionTail = Promise.resolve();
    atomicStorageTransactions.set(scope, async <T>(operation: (transaction: StorageTransaction) => Promise<T>, signal?: AbortSignal) => {
        const preceding = transactionTail;
        let release!: () => void;
        transactionTail = new Promise<void>((resolve) => { release = resolve; });
        await preceding;
        try {
            const snapshot: JsonObject = {};
            for (const [key, value] of values) setOwnRecordValue(snapshot, key, cloneJsonValue(value));
            const result = await runTransaction({ values: snapshot, operation, ...(signal ? { signal } : {}) });
            values.clear();
            for (const [key, value] of Object.entries(snapshot)) values.set(key, cloneJsonValue(value));
            return result;
        } finally {
            release();
        }
    });
    return scope;
}

function createFileScope(filePath: string): PluginStorageOwnerScope {
    async function readValues(): Promise<JsonObject> {
        try {
            const raw = await readFile(filePath, 'utf8');
            const parsed = JSON.parse(raw) as unknown;
            return { ...parseStorageFile(parsed, filePath).values };
        } catch (error) {
            if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
                return {};
            }
            throw error;
        }
    }

    async function writeValues(values: JsonObject): Promise<void> {
        await writeJsonAtomic(filePath, createStorageFile(values));
    }

    async function mutateValues<T>(
        operation: (values: JsonObject) => Promise<T> | T,
        shouldWrite: (result: T) => boolean = () => true,
    ): Promise<T> {
        return await withJsonOwnerFileLock({
            lockPath: `${filePath}.lock`,
            timeoutMs: 5_000,
            staleAfterMs: 30_000,
            errorCode: 'PLUGIN_STORAGE_LOCK_UNAVAILABLE',
        }, async () => {
            const values = await readValues();
            const result = await operation(values);
            if (shouldWrite(result)) await writeValues(values);
            return result;
        });
    }

    const scope: PluginStorageOwnerScope = Object.freeze({
        async get<T = unknown>(key: string): Promise<T | null> {
            const values = await readValues();
            return Object.prototype.hasOwnProperty.call(values, key)
                ? cloneJsonValue(values[key] as T)
                : null;
        },
        async set(key: string, value: unknown): Promise<void> {
            await mutateValues((values) => {
                setOwnRecordValue(values, key, cloneJsonValue(value));
            });
        },
        async delete(key: string): Promise<void> {
            await mutateValues((values) => {
                delete values[key];
            });
        },
        async listKeys(): Promise<readonly string[]> {
            return Object.freeze(Object.keys(await readValues()).sort());
        },
    });
    atomicStorageUpdates.set(scope, async <T>(key: string, operation: (
        current: unknown | null,
    ) => Readonly<{
        value: unknown;
        result: T;
        skipWrite?: boolean;
    }>): Promise<T> => {
        const next = await mutateValues((values) => {
            const current = Object.prototype.hasOwnProperty.call(values, key)
                ? cloneJsonValue(values[key])
                : null;
            const next = operation(current);
            if (next.skipWrite !== true) setOwnRecordValue(values, key, cloneJsonValue(next.value));
            return next;
        }, (result) => result.skipWrite !== true);
        return next.result;
    });
    atomicStorageTransactions.set(scope, async <T>(operation: (transaction: StorageTransaction) => Promise<T>, signal?: AbortSignal) => (
        await mutateValues(async (values) => await runTransaction({
            values,
            operation,
            ...(signal ? { signal } : {}),
        }))
    ));
    return scope;
}

export async function updatePluginStorageScopeValueAtomically<T>(params: Readonly<{
    scope: PluginStorageOwnerScope;
    key: string;
    operation: (current: unknown | null) => Readonly<{
        value: unknown;
        result: T;
        skipWrite?: boolean;
    }>;
}>): Promise<T> {
    const update = atomicStorageUpdates.get(params.scope);
    if (!update) {
        throw new PluginContextServiceError(
            'PLUGIN_STORAGE_ATOMIC_UPDATE_UNAVAILABLE',
            'Plugin storage scope does not support atomic updates',
        );
    }
    return await update(params.key, params.operation);
}

function readSessionId(sessionId: CreatePluginStorageOwnerParams['sessionId']): string | null {
    const value = typeof sessionId === 'function' ? sessionId() : sessionId;
    const trimmed = typeof value === 'string' ? value.trim() : '';
    return trimmed.length > 0 ? trimmed : null;
}

function createDaemonSessionFileScope(params: Readonly<{
    paths: PluginStorePaths;
    pluginNamespace: string;
    sessionId: CreatePluginStorageOwnerParams['sessionId'];
}>): PluginStorageOwnerScope {
    function resolveFilePath(): string {
        const sessionId = readSessionId(params.sessionId);
        if (!sessionId) {
            throw new PluginContextServiceError(
                'PLUGIN_STORAGE_SESSION_UNAVAILABLE',
                'ctx.storage.daemonSession is unavailable until the host binds a Session identity',
            );
        }
        const sessionNamespace = normalizePluginStorageNamespace(sessionId);
        return join(params.paths.storageDir, params.pluginNamespace, 'sessions', sessionNamespace, 'session.v1.json');
    }

    const scope: PluginStorageOwnerScope = Object.freeze({
        async get<T = unknown>(key: string): Promise<T | null> {
            return await createFileScope(resolveFilePath()).get<T>(key);
        },
        async set(key: string, value: unknown): Promise<void> {
            await createFileScope(resolveFilePath()).set(key, value);
        },
        async delete(key: string): Promise<void> {
            await createFileScope(resolveFilePath()).delete(key);
        },
        async listKeys(): Promise<readonly string[]> {
            return await createFileScope(resolveFilePath()).listKeys();
        },
    });
    atomicStorageTransactions.set(scope, async <T>(operation: (transaction: StorageTransaction) => Promise<T>, signal?: AbortSignal) => {
        const resolved = createFileScope(resolveFilePath());
        const transaction = atomicStorageTransactions.get(resolved);
        if (!transaction) throw new Error('Plugin daemonSession storage transaction owner is unavailable');
        return await transaction(operation, signal);
    });
    return scope;
}

export async function preparePluginStorageDataRemoval(
    params: PreparePluginStorageDataRemovalParams,
): Promise<Readonly<{
    hadDaemonData: boolean;
    removeDaemon: () => Promise<void>;
}>> {
    const daemon = await preparePluginOwnedDataDirectoryRemoval({
        pluginId: params.pluginId,
        rootDir: params.paths.storageDir,
        errorCode: 'PLUGIN_STORAGE_DATA_PATH_INVALID',
        ...(params.removeDirectory ? { removeDirectory: params.removeDirectory } : {}),
    });
    return Object.freeze({
        hadDaemonData: daemon.existed,
        removeDaemon: daemon.remove,
    });
}

export function createPluginStorageOwner(params: CreatePluginStorageOwnerParams): PluginStorageOwner {
    const pluginNamespace = normalizePluginStorageNamespace(params.pluginId);
    const pluginStorageDir = join(params.paths.storageDir, pluginNamespace);

    return Object.freeze({
        ephemeral: createMemoryScope(),
        daemonSession: createDaemonSessionFileScope({
            paths: params.paths,
            pluginNamespace,
            sessionId: params.sessionId,
        }),
        daemon: createFileScope(join(pluginStorageDir, 'daemon.v1.json')),
    });
}

function createStableStorageScope(params: Readonly<{
    scope: PluginStorageOwnerScope;
    consistency: StorageConsistency;
    signal: AbortSignal;
    isGenerationCurrent: () => boolean;
}>): StorageScopeService {
    const scopeIdentity = Object.freeze({});
    const assertUsable = (signal?: AbortSignal): void => {
        throwIfAborted(params.signal);
        throwIfAborted(signal);
        if (!params.isGenerationCurrent()) {
            throw new PluginContextServiceError('plugin_generation_stale', 'Plugin storage invocation generation is stale');
        }
    };
    const assertMutationNotReentrant = (): void => {
        if (pluginStorageTransactionContext.getStore()?.has(scopeIdentity)) {
            throw new PluginContextServiceError(
                'plugin_storage_transaction_reentry',
                'Plugin storage mutation must use the active transaction handle',
            );
        }
    };
    const assertTransactionNotNested = (): void => {
        if ((pluginStorageTransactionContext.getStore()?.size ?? 0) > 0) {
            throw new PluginContextServiceError(
                'plugin_storage_transaction_reentry',
                'Nested plugin storage transactions are unavailable',
            );
        }
    };
    const assertPublicKey = (key: string): void => {
        if (key.startsWith(PLUGIN_HOST_STORAGE_KEY_PREFIX)) {
            throw new PluginContextServiceError(
                'plugin_storage_reserved_key',
                `Plugin storage key '${key}' is reserved for the host`,
            );
        }
    };
    const publicTransaction = (transaction: StorageTransaction): StorageTransaction => Object.freeze({
        async get<T extends JsonValue = JsonValue>(key: string, options?: { signal?: AbortSignal }): Promise<T | null> {
            assertPublicKey(key);
            return await transaction.get<T>(key, options);
        },
        async set(key: string, value: JsonValue, options?: { signal?: AbortSignal }): Promise<void> {
            assertPublicKey(key);
            await transaction.set(key, value, options);
        },
        async delete(key: string, options?: { signal?: AbortSignal }): Promise<void> {
            assertPublicKey(key);
            await transaction.delete(key, options);
        },
    });
    const mutateAtomically = async <T>(
        operation: (transaction: StorageTransaction) => Promise<T>,
        signal?: AbortSignal,
    ): Promise<T> => {
        assertUsable(signal);
        const transaction = atomicStorageTransactions.get(params.scope);
        if (!transaction) {
            throw new PluginContextServiceError(
                'PLUGIN_STORAGE_ATOMIC_UPDATE_UNAVAILABLE',
                'Plugin storage scope does not support atomic transactions',
            );
        }
        return await transaction(async (handle) => {
            const result = await operation(handle);
            assertUsable(signal);
            return result;
        }, signal ?? params.signal);
    };
    return Object.freeze({
        consistency: () => params.consistency,
        async get<T extends JsonValue = JsonValue>(key: string, options?: { signal?: AbortSignal }): Promise<T | null> {
            assertPublicKey(key);
            assertUsable(options?.signal);
            return await params.scope.get<T>(key);
        },
        async set(key: string, value: JsonValue, options?: { signal?: AbortSignal }): Promise<void> {
            assertPublicKey(key);
            assertMutationNotReentrant();
            await mutateAtomically(async (transaction) => await transaction.set(key, value, options), options?.signal);
        },
        async delete(key: string, options?: { signal?: AbortSignal }): Promise<void> {
            assertPublicKey(key);
            assertMutationNotReentrant();
            await mutateAtomically(async (transaction) => await transaction.delete(key, options), options?.signal);
        },
        async list(options: { cursor?: string; limit?: number; prefix?: string; signal?: AbortSignal } = {}) {
            if (options.prefix !== undefined) assertPublicKey(options.prefix);
            assertUsable(options.signal);
            const limit = Math.min(Math.max(options.limit ?? 100, 1), 1_000);
            const after = options.cursor === undefined
                ? null
                : readStorageListCursor(options.cursor, options.prefix);
            const keys = (await params.scope.listKeys())
                .filter((key) => !key.startsWith(PLUGIN_HOST_STORAGE_KEY_PREFIX))
                .filter((key) => options.prefix === undefined || key.startsWith(options.prefix))
                .sort();
            const remaining = after === null ? keys : keys.filter((key) => key > after);
            const selected = remaining.slice(0, limit);
            const lastSelected = selected[selected.length - 1];
            return Object.freeze({
                items: Object.freeze(selected.map((key) => Object.freeze({ key }))),
                ...(selected.length < remaining.length && lastSelected !== undefined
                    ? { nextCursor: createStorageListCursor({ prefix: options.prefix, after: lastSelected }) }
                    : {}),
            });
        },
        async transaction<T>(operation: (transaction: StorageTransaction) => Promise<T>, options?: { signal?: AbortSignal }): Promise<T> {
            assertTransactionNotNested();
            const result = await mutateAtomically(
                async (transaction) => await pluginStorageTransactionContext.run(
                    new Set([scopeIdentity]),
                    async () => await operation(publicTransaction(transaction)),
                ),
                options?.signal,
            );
            assertUsable(options?.signal);
            return result;
        },
    });
}

export function createStablePluginStorageService(params: CreatePluginStorageOwnerParams & Readonly<{
    generation: string;
    signal: AbortSignal;
    isGenerationCurrent: () => boolean;
    accountStorageCurrentness?: () => boolean | Promise<boolean>;
    accountStorage?: StablePluginAccountStorageHost;
    daemonDatabase?: StablePluginDaemonDatabaseHost;
}>): StorageService {
    const storage = createPluginStorageOwner(params);
    const authoritative = Object.freeze({ kind: 'authoritativeSerializable' as const });
    const account = params.accountStorage?.bind({
        pluginId: params.pluginId,
        generation: params.generation,
        signal: params.signal,
        isGenerationCurrent: params.accountStorageCurrentness ?? params.isGenerationCurrent,
    }) ?? null;
    const daemonKv = createStableStorageScope({
        scope: storage.daemon,
        consistency: authoritative,
        signal: params.signal,
        isGenerationCurrent: params.isGenerationCurrent,
    });
    const daemonDatabase = params.daemonDatabase?.bind({
        pluginId: params.pluginId,
        generation: params.generation,
        signal: params.signal,
        isGenerationCurrent: params.isGenerationCurrent,
    }) ?? createUnavailablePluginDaemonDatabaseService('daemon_database_unavailable');
    const daemon: DaemonDatabaseStorageScope = Object.freeze({
        ...daemonKv,
        database: daemonDatabase.database,
    });
    return Object.freeze({
        ephemeral: createStableStorageScope({ scope: storage.ephemeral, consistency: authoritative, signal: params.signal, isGenerationCurrent: params.isGenerationCurrent }),
        daemonSession: createStableStorageScope({ scope: storage.daemonSession, consistency: authoritative, signal: params.signal, isGenerationCurrent: params.isGenerationCurrent }),
        daemon,
        ...(account ? { account } : {}),
    });
}

export async function createPluginStoragePublicShareSnapshot(
    _params: Readonly<{ paths: PluginStorePaths }>,
): Promise<PluginStoragePublicShareSnapshotV1> {
    return Object.freeze({
        t: 'happier_plugin_public_share_storage_snapshot_v1',
        plugins: [] as const,
    });
}
