import { AsyncLocalStorage } from 'node:async_hooks';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginStorageConsistency, PluginStorageScopeService, PluginStorageService, PluginStorageTransaction } from '@happier-dev/plugin-sdk/runtime';

import type { PluginStorePaths } from '@/plugins/store/paths';
import { withJsonOwnerFileLock } from '@/utils/fs/jsonOwnerFileLock';
import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';

import { PluginContextServiceError } from './errors';
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
    readonly session: PluginStorageOwnerScope;
    readonly local: PluginStorageOwnerScope;
    readonly synced: PluginStorageOwnerScope;
}

type AtomicStorageUpdate = <T>(
    key: string,
    operation: (current: unknown | null) => Readonly<{ value: unknown; result: T }>,
) => Promise<T>;

const atomicStorageUpdates = new WeakMap<object, AtomicStorageUpdate>();
type AtomicStorageTransaction = <T>(
    operation: (transaction: PluginStorageTransaction) => Promise<T>,
    signal?: AbortSignal,
) => Promise<T>;
const atomicStorageTransactions = new WeakMap<object, AtomicStorageTransaction>();
const pluginStorageTransactionContext = new AsyncLocalStorage<ReadonlySet<object>>();

export type PluginSyncedStorageAdapter = PluginStorageOwnerScope;

export type AccountSettingsBackedPluginStorageScopeParams = Readonly<{
    pluginId: string;
    getSettings: () => Readonly<Record<string, unknown>> | null;
    updateSettings: (
        mutate: (settings: Readonly<Record<string, unknown>>) => Record<string, unknown>,
    ) => Promise<Readonly<Record<string, unknown>>>;
}>;

export type PluginSyncedStorageRemovalAdapter = Omit<
    AccountSettingsBackedPluginStorageScopeParams,
    'pluginId'
>;

export type PreparePluginStorageDataRemovalParams = Readonly<{
    pluginId: string;
    paths: PluginStorePaths;
    synced: PluginSyncedStorageRemovalAdapter | null;
    removeDirectory?: (directoryPath: string) => Promise<void>;
}>;

export type CreatePluginStorageOwnerParams = Readonly<{
    pluginId: string;
    paths: PluginStorePaths;
    sessionId?: string | (() => string | null | undefined) | null;
    synced?: PluginSyncedStorageAdapter | null;
}>;

export type CopyPluginSessionStorageForForkParams = Readonly<{
    paths: PluginStorePaths;
    sourceSessionId: string;
    targetSessionId: string;
}>;

export type PluginStoragePublicShareSnapshotV1 = Readonly<{
    t: 'happier_plugin_public_share_storage_snapshot_v1';
    plugins: readonly [];
}>;

type StorageFileV1 = Readonly<{
    t: 'happier_plugin_storage_scope_v1';
    values: JsonObject;
}>;

const SYNCED_STORAGE_SETTINGS_KEY = 'pluginStorageSyncedV1';
export const PLUGIN_HOST_STORAGE_KEY_PREFIX = '@happier/';

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
    transaction: PluginStorageTransaction;
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
    operation: (transaction: PluginStorageTransaction) => Promise<T>;
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

function readSyncedStorageRoot(settings: Readonly<Record<string, unknown>> | null): Record<string, Record<string, unknown>> {
    const root = settings?.[SYNCED_STORAGE_SETTINGS_KEY];
    if (!isRecord(root) || root.v !== 1 || !isRecord(root.plugins)) {
        return {};
    }
    const plugins: Record<string, Record<string, unknown>> = {};
    for (const [pluginNamespace, rawValues] of Object.entries(root.plugins)) {
        if (isRecord(rawValues)) {
            setOwnRecordValue(plugins, pluginNamespace, cloneJsonValue(rawValues));
        }
    }
    return plugins;
}

function readSyncedStorageRootForRemoval(
    settings: Readonly<Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
    const root = settings[SYNCED_STORAGE_SETTINGS_KEY];
    if (root === undefined) return {};
    if (!isRecord(root) || root.v !== 1 || !isRecord(root.plugins)) {
        throw new PluginContextServiceError(
            'PLUGIN_STORAGE_SYNCED_STATE_INVALID',
            'Synced plugin storage has an unsupported persisted shape',
        );
    }
    const plugins: Record<string, Record<string, unknown>> = {};
    for (const [pluginNamespace, rawValues] of Object.entries(root.plugins)) {
        if (!isRecord(rawValues)) {
            throw new PluginContextServiceError(
                'PLUGIN_STORAGE_SYNCED_STATE_INVALID',
                'Synced plugin storage contains an invalid plugin namespace',
            );
        }
        setOwnRecordValue(plugins, pluginNamespace, cloneJsonValue(rawValues));
    }
    return plugins;
}

function writeSyncedStorageRoot(
    settings: Readonly<Record<string, unknown>>,
    plugins: Record<string, Record<string, unknown>>,
): Record<string, unknown> {
    return {
        ...settings,
        [SYNCED_STORAGE_SETTINGS_KEY]: {
            v: 1,
            plugins,
        },
    };
}

function writeSyncedStorageRootForRemoval(
    settings: Readonly<Record<string, unknown>>,
    plugins: Record<string, Record<string, unknown>>,
): Record<string, unknown> {
    const currentRoot = settings[SYNCED_STORAGE_SETTINGS_KEY];
    return {
        ...settings,
        [SYNCED_STORAGE_SETTINGS_KEY]: {
            ...(isRecord(currentRoot) ? cloneJsonValue(currentRoot) : {}),
            v: 1,
            plugins,
        },
    };
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
    atomicStorageTransactions.set(scope, async <T>(operation: (transaction: PluginStorageTransaction) => Promise<T>, signal?: AbortSignal) => {
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

    async function mutateValues<T>(operation: (values: JsonObject) => Promise<T> | T): Promise<T> {
        return await withJsonOwnerFileLock({
            lockPath: `${filePath}.lock`,
            timeoutMs: 5_000,
            staleAfterMs: 30_000,
            errorCode: 'PLUGIN_STORAGE_LOCK_UNAVAILABLE',
        }, async () => {
            const values = await readValues();
            const result = await operation(values);
            await writeValues(values);
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
    ) => Readonly<{ value: unknown; result: T }>): Promise<T> => await mutateValues((values) => {
        const current = Object.prototype.hasOwnProperty.call(values, key)
            ? cloneJsonValue(values[key])
            : null;
        const next = operation(current);
        setOwnRecordValue(values, key, cloneJsonValue(next.value));
        return next.result;
    }));
    atomicStorageTransactions.set(scope, async <T>(operation: (transaction: PluginStorageTransaction) => Promise<T>, signal?: AbortSignal) => (
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
    operation: (current: unknown | null) => Readonly<{ value: unknown; result: T }>;
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

function createSessionFileScope(params: Readonly<{
    paths: PluginStorePaths;
    pluginNamespace: string;
    sessionId: CreatePluginStorageOwnerParams['sessionId'];
}>): PluginStorageOwnerScope {
    function resolveFilePath(): string {
        const sessionId = readSessionId(params.sessionId);
        if (!sessionId) {
            throw new PluginContextServiceError(
                'PLUGIN_STORAGE_SESSION_UNAVAILABLE',
                'ctx.storage.session is unavailable until the host binds a session identity',
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
    atomicStorageTransactions.set(scope, async <T>(operation: (transaction: PluginStorageTransaction) => Promise<T>, signal?: AbortSignal) => {
        const resolved = createFileScope(resolveFilePath());
        const transaction = atomicStorageTransactions.get(resolved);
        if (!transaction) throw new Error('Plugin session storage transaction owner is unavailable');
        return await transaction(operation, signal);
    });
    return scope;
}

function createUnavailableSyncedScope(): PluginStorageOwnerScope {
    const unavailable = async (): Promise<never> => {
        throw new PluginContextServiceError(
            'PLUGIN_STORAGE_SYNCED_UNAVAILABLE',
            'ctx.storage.synced is unavailable because no host account settings adapter is bound',
        );
    };
    return Object.freeze({
        get: unavailable,
        set: unavailable,
        delete: unavailable,
        listKeys: unavailable,
    });
}

export function createAccountSettingsBackedPluginStorageScope(
    params: AccountSettingsBackedPluginStorageScopeParams,
): PluginStorageOwnerScope {
    const pluginNamespace = normalizePluginStorageNamespace(params.pluginId);

    async function mutatePluginValues(
        mutate: (values: Record<string, unknown>) => Record<string, unknown>,
    ): Promise<void> {
        await params.updateSettings((settings) => {
            const plugins = readSyncedStorageRoot(settings);
            setOwnRecordValue(plugins, pluginNamespace, mutate({ ...(plugins[pluginNamespace] ?? {}) }));
            return writeSyncedStorageRoot(settings, plugins);
        });
    }

    const scope: PluginStorageOwnerScope = Object.freeze({
        async get<T = unknown>(key: string): Promise<T | null> {
            const plugins = readSyncedStorageRoot(params.getSettings());
            const values = plugins[pluginNamespace] ?? {};
            return Object.prototype.hasOwnProperty.call(values, key)
                ? cloneJsonValue(values[key] as T)
                : null;
        },
        async set(key: string, value: unknown): Promise<void> {
            await mutatePluginValues((values) => {
                setOwnRecordValue(values, key, cloneJsonValue(value));
                return values;
            });
        },
        async delete(key: string): Promise<void> {
            await mutatePluginValues((values) => {
                delete values[key];
                return values;
            });
        },
        async listKeys(): Promise<readonly string[]> {
            const plugins = readSyncedStorageRoot(params.getSettings());
            return Object.freeze(Object.keys(plugins[pluginNamespace] ?? {}).sort());
        },
    });
    atomicStorageUpdates.set(scope, async <T>(key: string, operation: (
        current: unknown | null,
    ) => Readonly<{ value: unknown; result: T }>): Promise<T> => {
        let result: T | undefined;
        let operated = false;
        await params.updateSettings((settings) => {
            const plugins = readSyncedStorageRoot(settings);
            const values = { ...(plugins[pluginNamespace] ?? {}) };
            const current = Object.prototype.hasOwnProperty.call(values, key)
                ? cloneJsonValue(values[key])
                : null;
            const next = operation(current);
            setOwnRecordValue(values, key, cloneJsonValue(next.value));
            setOwnRecordValue(plugins, pluginNamespace, values);
            result = next.result;
            operated = true;
            return writeSyncedStorageRoot(settings, plugins);
        });
        if (!operated) {
            throw new PluginContextServiceError(
                'PLUGIN_STORAGE_SYNCED_UNAVAILABLE',
                'Synced plugin storage update did not reach the account settings owner',
            );
        }
        return result as T;
    });
    let transactionTail = Promise.resolve();
    atomicStorageTransactions.set(scope, async <T>(operation: (transaction: PluginStorageTransaction) => Promise<T>, signal?: AbortSignal) => {
        const preceding = transactionTail;
        let release!: () => void;
        transactionTail = new Promise<void>((resolve) => { release = resolve; });
        await preceding;
        try {
            const values = cloneJsonValue(readSyncedStorageRoot(params.getSettings())[pluginNamespace] ?? {});
            const result = await runTransaction({ values, operation, ...(signal ? { signal } : {}) });
            await mutatePluginValues(() => values);
            return result;
        } finally {
            release();
        }
    });
    return scope;
}

export async function preparePluginStorageDataRemoval(
    params: PreparePluginStorageDataRemovalParams,
): Promise<Readonly<{
    hadLocalData: boolean;
    hadSyncedData: boolean;
    removeSynced: () => Promise<void>;
    removeLocal: () => Promise<void>;
}>> {
    const local = await preparePluginOwnedDataDirectoryRemoval({
        pluginId: params.pluginId,
        rootDir: params.paths.storageDir,
        errorCode: 'PLUGIN_STORAGE_DATA_PATH_INVALID',
        ...(params.removeDirectory ? { removeDirectory: params.removeDirectory } : {}),
    });
    if (!params.synced) {
        throw new PluginContextServiceError(
            'PLUGIN_STORAGE_SYNCED_REMOVAL_UNAVAILABLE',
            'Synced plugin storage removal requires an active account-settings owner',
        );
    }
    const settings = params.synced.getSettings();
    if (!settings) {
        throw new PluginContextServiceError(
            'PLUGIN_STORAGE_SYNCED_REMOVAL_UNAVAILABLE',
            'Synced plugin storage removal requires an active account-settings snapshot',
        );
    }
    const pluginNamespace = normalizePluginStorageNamespace(params.pluginId);
    const plugins = readSyncedStorageRootForRemoval(settings);
    const hadSyncedData = Object.prototype.hasOwnProperty.call(plugins, pluginNamespace);
    return Object.freeze({
        hadLocalData: local.existed,
        hadSyncedData,
        removeSynced: async () => {
            await params.synced!.updateSettings((currentSettings) => {
                const currentPlugins = readSyncedStorageRootForRemoval(currentSettings);
                delete currentPlugins[pluginNamespace];
                return writeSyncedStorageRootForRemoval(currentSettings, currentPlugins);
            });
        },
        removeLocal: local.remove,
    });
}

export function createPluginStorageOwner(params: CreatePluginStorageOwnerParams): PluginStorageOwner {
    const pluginNamespace = normalizePluginStorageNamespace(params.pluginId);
    const pluginStorageDir = join(params.paths.storageDir, pluginNamespace);

    return Object.freeze({
        ephemeral: createMemoryScope(),
        session: createSessionFileScope({
            paths: params.paths,
            pluginNamespace,
            sessionId: params.sessionId,
        }),
        local: createFileScope(join(pluginStorageDir, 'local.v1.json')),
        synced: params.synced ?? createUnavailableSyncedScope(),
    });
}

function createStableStorageScope(params: Readonly<{
    scope: PluginStorageOwnerScope;
    consistency: PluginStorageConsistency;
    signal: AbortSignal;
    isGenerationCurrent: () => boolean;
}>): PluginStorageScopeService {
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
    const publicTransaction = (transaction: PluginStorageTransaction): PluginStorageTransaction => Object.freeze({
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
        operation: (transaction: PluginStorageTransaction) => Promise<T>,
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
            const offset = options.cursor === undefined ? 0 : Number.parseInt(options.cursor, 10);
            if (!Number.isSafeInteger(offset)
                || offset < 0
                || (options.cursor !== undefined && String(offset) !== options.cursor)) {
                throw new PluginContextServiceError('PLUGIN_STORAGE_CURSOR_INVALID', 'Plugin storage list cursor is invalid');
            }
            const keys = (await params.scope.listKeys())
                .filter((key) => !key.startsWith(PLUGIN_HOST_STORAGE_KEY_PREFIX))
                .filter((key) => options.prefix === undefined || key.startsWith(options.prefix))
                .sort();
            const selected = keys.slice(offset, offset + limit);
            const nextOffset = offset + selected.length;
            return Object.freeze({
                items: Object.freeze(selected.map((key) => Object.freeze({ key }))),
                ...(nextOffset < keys.length ? { nextCursor: String(nextOffset) } : {}),
            });
        },
        async transaction<T>(operation: (transaction: PluginStorageTransaction) => Promise<T>, options?: { signal?: AbortSignal }): Promise<T> {
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
    signal: AbortSignal;
    isGenerationCurrent: () => boolean;
}>): PluginStorageService {
    const storage = createPluginStorageOwner(params);
    const authoritative = Object.freeze({ kind: 'authoritativeSerializable' as const });
    return Object.freeze({
        ephemeral: createStableStorageScope({ scope: storage.ephemeral, consistency: authoritative, signal: params.signal, isGenerationCurrent: params.isGenerationCurrent }),
        session: createStableStorageScope({ scope: storage.session, consistency: authoritative, signal: params.signal, isGenerationCurrent: params.isGenerationCurrent }),
        local: createStableStorageScope({ scope: storage.local, consistency: authoritative, signal: params.signal, isGenerationCurrent: params.isGenerationCurrent }),
        synced: createStableStorageScope({
            scope: storage.synced,
            consistency: Object.freeze({ kind: 'localReplicaSerializable', remoteConflicts: 'hostMergeAfterCommit' }),
            signal: params.signal,
            isGenerationCurrent: params.isGenerationCurrent,
        }),
    });
}

export async function copyPluginSessionStorageForFork(params: CopyPluginSessionStorageForForkParams): Promise<void> {
    const sourceSessionNamespace = normalizePluginStorageNamespace(params.sourceSessionId);
    const targetSessionNamespace = normalizePluginStorageNamespace(params.targetSessionId);
    if (sourceSessionNamespace === targetSessionNamespace) {
        return;
    }

    let pluginNamespaces: readonly string[];
    try {
        const pluginEntries = await readdir(params.paths.storageDir, { withFileTypes: true });
        pluginNamespaces = pluginEntries
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name.toString());
    } catch (error) {
        if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
            return;
        }
        throw error;
    }

    for (const pluginNamespace of pluginNamespaces) {
        const sourcePath = join(params.paths.storageDir, pluginNamespace, 'sessions', sourceSessionNamespace, 'session.v1.json');
        const targetPath = join(params.paths.storageDir, pluginNamespace, 'sessions', targetSessionNamespace, 'session.v1.json');
        let file: StorageFileV1;
        try {
            const raw = await readFile(sourcePath, 'utf8');
            file = parseStorageFile(JSON.parse(raw) as unknown, sourcePath);
        } catch (error) {
            if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
                continue;
            }
            throw error;
        }
        await writeJsonAtomic(targetPath, createStorageFile(cloneJsonValue(file.values)));
    }
}

export async function createPluginStoragePublicShareSnapshot(
    _params: Readonly<{ paths: PluginStorePaths }>,
): Promise<PluginStoragePublicShareSnapshotV1> {
    return Object.freeze({
        t: 'happier_plugin_public_share_storage_snapshot_v1',
        plugins: [] as const,
    });
}
