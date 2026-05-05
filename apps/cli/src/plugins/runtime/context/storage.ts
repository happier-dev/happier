import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { PluginStorageScopeServiceV1, PluginStorageServiceV1 } from '@happier-dev/plugin-sdk';

import type { PluginStorePaths } from '@/plugins/store/paths';
import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';

import { PluginContextServiceError } from './errors';
import { normalizePluginStorageNamespace } from './pluginNamespace';

type JsonObject = Record<string, unknown>;

export type PluginSyncedStorageAdapter = PluginStorageScopeServiceV1;

export type AccountSettingsBackedPluginStorageScopeParams = Readonly<{
    pluginId: string;
    getSettings: () => Readonly<Record<string, unknown>> | null;
    updateSettings: (
        mutate: (settings: Readonly<Record<string, unknown>>) => Record<string, unknown>,
    ) => Promise<Readonly<Record<string, unknown>>>;
}>;

export type CreatePluginStorageServiceParams = Readonly<{
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

function readSyncedStorageRoot(settings: Readonly<Record<string, unknown>> | null): Record<string, Record<string, unknown>> {
    const root = settings?.[SYNCED_STORAGE_SETTINGS_KEY];
    if (!isRecord(root) || root.v !== 1 || !isRecord(root.plugins)) {
        return {};
    }
    const plugins: Record<string, Record<string, unknown>> = {};
    for (const [pluginNamespace, rawValues] of Object.entries(root.plugins)) {
        if (isRecord(rawValues)) {
            plugins[pluginNamespace] = cloneJsonValue(rawValues);
        }
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

function createMemoryScope(): PluginStorageScopeServiceV1 {
    const values = new Map<string, unknown>();
    return Object.freeze({
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
}

function createFileScope(filePath: string): PluginStorageScopeServiceV1 {
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

    return Object.freeze({
        async get<T = unknown>(key: string): Promise<T | null> {
            const values = await readValues();
            return Object.prototype.hasOwnProperty.call(values, key)
                ? cloneJsonValue(values[key] as T)
                : null;
        },
        async set(key: string, value: unknown): Promise<void> {
            const values = await readValues();
            values[key] = cloneJsonValue(value);
            await writeValues(values);
        },
        async delete(key: string): Promise<void> {
            const values = await readValues();
            delete values[key];
            await writeValues(values);
        },
        async listKeys(): Promise<readonly string[]> {
            return Object.freeze(Object.keys(await readValues()).sort());
        },
    });
}

function readSessionId(sessionId: CreatePluginStorageServiceParams['sessionId']): string | null {
    const value = typeof sessionId === 'function' ? sessionId() : sessionId;
    const trimmed = typeof value === 'string' ? value.trim() : '';
    return trimmed.length > 0 ? trimmed : null;
}

function createSessionFileScope(params: Readonly<{
    paths: PluginStorePaths;
    pluginNamespace: string;
    sessionId: CreatePluginStorageServiceParams['sessionId'];
}>): PluginStorageScopeServiceV1 {
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

    return Object.freeze({
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
}

function createUnavailableSyncedScope(): PluginStorageScopeServiceV1 {
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
): PluginStorageScopeServiceV1 {
    const pluginNamespace = normalizePluginStorageNamespace(params.pluginId);

    async function mutatePluginValues(
        mutate: (values: Record<string, unknown>) => Record<string, unknown>,
    ): Promise<void> {
        await params.updateSettings((settings) => {
            const plugins = readSyncedStorageRoot(settings);
            plugins[pluginNamespace] = mutate({ ...(plugins[pluginNamespace] ?? {}) });
            return writeSyncedStorageRoot(settings, plugins);
        });
    }

    return Object.freeze({
        async get<T = unknown>(key: string): Promise<T | null> {
            const plugins = readSyncedStorageRoot(params.getSettings());
            const values = plugins[pluginNamespace] ?? {};
            return Object.prototype.hasOwnProperty.call(values, key)
                ? cloneJsonValue(values[key] as T)
                : null;
        },
        async set(key: string, value: unknown): Promise<void> {
            await mutatePluginValues((values) => {
                values[key] = cloneJsonValue(value);
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
}

export function createPluginStorageService(params: CreatePluginStorageServiceParams): PluginStorageServiceV1 {
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
