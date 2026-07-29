import { readFile, stat } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createJiti } from 'jiti';

import { isPluginTrustRecordAuthorized } from '@/plugins/store/install/trustIdentity';

import type { CommittedPluginExecutionAuthorization, PluginActivationSource } from './activationSources';

export type PluginModuleNamespace = Readonly<Record<string, unknown>> & Readonly<{
    default?: unknown;
}>;

type PluginModuleLoadErrorCode =
    | 'PLUGIN_DAEMON_ENTRY_MISSING'
    | 'PLUGIN_DAEMON_ENTRY_KIND_UNSUPPORTED'
    | 'PLUGIN_DAEMON_MODULE_LOAD_FAILED'
    | 'PLUGIN_DAEMON_TRUST_APPROVAL_REQUIRED';

const moduleLoadCache = new Map<string, Promise<PluginModuleNamespace>>();
const SUPPORTED_DAEMON_ENTRY_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);
const SUPPORTED_DEV_DAEMON_ENTRY_EXTENSIONS = new Set([
    ...SUPPORTED_DAEMON_ENTRY_EXTENSIONS,
    '.ts',
    '.mts',
    '.cts',
    '.tsx',
]);
const TYPESCRIPT_DEV_DAEMON_ENTRY_EXTENSIONS = new Set(['.ts', '.mts', '.cts', '.tsx']);
function createModuleLoadError(code: PluginModuleLoadErrorCode, message: string, cause?: unknown): Error {
    const error = new Error(message) as Error & { code?: PluginModuleLoadErrorCode; cause?: unknown };
    error.code = code;
    if (cause !== undefined) {
        error.cause = cause;
    }
    return error;
}

function buildDaemonEntryFingerprint(stats: Readonly<{ size: number; mtimeMs: number; ctimeMs: number }>): string {
    // mtime can be preserved by archive extraction. ctime is updated when the file is replaced
    // (even if mtime is preserved), so include it to avoid stale daemon module caching.
    const roundedMtimeMs = Math.round(stats.mtimeMs);
    const roundedCtimeMs = Math.round(stats.ctimeMs);
    return `${stats.size}:${roundedMtimeMs}:${roundedCtimeMs}`;
}

function stableCacheKey(cacheKey: string | undefined, fallback: string): string {
    return cacheKey && cacheKey.trim().length > 0 ? cacheKey.trim() : fallback;
}

function buildFileBackedCacheKey(params: Readonly<{
    entryPath: string;
    fingerprint: string;
    cacheKey?: string;
}>): string {
    return `file:${params.entryPath}::${stableCacheKey(params.cacheKey, 'path-fingerprint')}::${params.fingerprint}`;
}

function buildBundledCacheKey(params: Readonly<{ moduleId: string; cacheKey?: string }>): string {
    return `bundled:${params.moduleId}::${stableCacheKey(params.cacheKey, 'module-id')}`;
}

function evictCacheByPrefix(prefix: string, preserveKey: string): void {
    for (const key of moduleLoadCache.keys()) {
        if (key !== preserveKey && key.startsWith(prefix)) {
            moduleLoadCache.delete(key);
        }
    }
}

async function assertTrusted(
    committedAuthorization: CommittedPluginExecutionAuthorization | undefined,
): Promise<void> {
    if (committedAuthorization) {
        const authorized = committedAuthorization.admittedIntegrity === committedAuthorization.packageDigest
            && isPluginTrustRecordAuthorized(committedAuthorization.trust, {
                pluginId: committedAuthorization.pluginId,
                distribution: committedAuthorization.distribution,
                realm: 'daemon',
            });
        if (!authorized) {
            throw createModuleLoadError(
                'PLUGIN_DAEMON_TRUST_APPROVAL_REQUIRED',
                'Committed plugin execution authorization does not match the reviewed distribution and immutable generation',
            );
        }
        if (!(await committedAuthorization.isCurrent())) {
            throw createModuleLoadError(
                'PLUGIN_DAEMON_TRUST_APPROVAL_REQUIRED',
                `Committed plugin execution authorization is stale for generation '${committedAuthorization.immutableGenerationId}'`,
            );
        }
        return;
    }
    throw createModuleLoadError(
        'PLUGIN_DAEMON_TRUST_APPROVAL_REQUIRED',
        'Plugin executable load requires a reviewed, committed, current daemon generation',
    );
}

function resolveSelectedEntryPath(params: Readonly<{
    entryPath: string;
    devEntryPath?: string | null;
    useDevelopmentEntry?: boolean;
}>): Readonly<{ entryPath: string; isDevEntry: boolean }> {
    const devEntryPath = params.devEntryPath?.trim();
    if (params.useDevelopmentEntry === true) {
        if (!devEntryPath) {
            throw createModuleLoadError(
                'PLUGIN_DAEMON_ENTRY_MISSING',
                'Plugin development execution was selected without a development entrypoint',
            );
        }
        return { entryPath: devEntryPath, isDevEntry: true };
    }
    return { entryPath: params.entryPath, isDevEntry: false };
}

function assertSupportedEntryExtension(params: Readonly<{
    extension: string;
    resolvedEntryPath: string;
    isDevEntry: boolean;
}>): void {
    const supportedExtensions = params.isDevEntry
        ? SUPPORTED_DEV_DAEMON_ENTRY_EXTENSIONS
        : SUPPORTED_DAEMON_ENTRY_EXTENSIONS;
    if (supportedExtensions.has(params.extension)) {
        return;
    }

    throw createModuleLoadError(
        'PLUGIN_DAEMON_ENTRY_KIND_UNSUPPORTED',
        `Unsupported plugin daemon ${params.isDevEntry ? 'dev ' : ''}entry extension '${params.extension || '<none>'}' for '${params.resolvedEntryPath}'`,
    );
}

async function importFileBackedModule(params: Readonly<{
    resolvedEntryPath: string;
    fingerprint: string;
    cacheKey?: string;
    isTypeScriptDevEntry: boolean;
}>): Promise<PluginModuleNamespace> {
    if (params.isTypeScriptDevEntry) {
        // A development generation owns its whole TypeScript module graph. Creating
        // Jiti here prevents a transitive import cached by one generation from
        // leaking into its replacement; moduleLoadCache still joins repeated loads
        // of the same immutable generation key.
        const generationLoader = createJiti(import.meta.url, {
            fsCache: false,
            moduleCache: false,
            interopDefault: false,
        });
        const source = await readFile(params.resolvedEntryPath, 'utf8');
        return await generationLoader.evalModule(source, {
            filename: params.resolvedEntryPath,
            async: true,
        }) as PluginModuleNamespace;
    }

    const moduleUrl = pathToFileURL(params.resolvedEntryPath);
    moduleUrl.searchParams.set(
        'happier_plugin_cache_key',
        `${params.cacheKey ?? 'path'}:${params.fingerprint}`,
    );
    return await import(moduleUrl.href) as PluginModuleNamespace;
}

async function loadFileBackedModule(params: Readonly<{
    entryPath: string;
    devEntryPath?: string | null;
    useDevelopmentEntry?: boolean;
    committedAuthorization?: CommittedPluginExecutionAuthorization;
    cacheKey?: string;
}>): Promise<PluginModuleNamespace> {
    await assertTrusted(params.committedAuthorization);

    const selectedEntry = resolveSelectedEntryPath({
        entryPath: params.entryPath,
        devEntryPath: params.devEntryPath,
        useDevelopmentEntry: params.useDevelopmentEntry,
    });
    const resolvedEntryPath = resolve(selectedEntry.entryPath);
    const extension = extname(resolvedEntryPath).toLowerCase();
    assertSupportedEntryExtension({
        extension,
        resolvedEntryPath,
        isDevEntry: selectedEntry.isDevEntry,
    });

    let daemonEntryStats: Awaited<ReturnType<typeof stat>>;
    try {
        daemonEntryStats = await stat(resolvedEntryPath);
    } catch (error) {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        if (code === 'ENOENT') {
            throw createModuleLoadError(
                'PLUGIN_DAEMON_ENTRY_MISSING',
                `Plugin daemon entry does not exist: ${resolvedEntryPath}`,
                error,
            );
        }
        throw error;
    }

    if (!daemonEntryStats.isFile()) {
        throw createModuleLoadError(
            'PLUGIN_DAEMON_ENTRY_KIND_UNSUPPORTED',
            `Plugin daemon entry must resolve to a file: ${resolvedEntryPath}`,
        );
    }

    const fingerprint = buildDaemonEntryFingerprint({
        size: daemonEntryStats.size,
        mtimeMs: daemonEntryStats.mtimeMs,
        ctimeMs: daemonEntryStats.ctimeMs,
    });
    const cacheEntryKey = buildFileBackedCacheKey({
        entryPath: resolvedEntryPath,
        fingerprint,
        cacheKey: params.cacheKey,
    });
    const cached = moduleLoadCache.get(cacheEntryKey);
    if (cached) {
        return await cached;
    }

    evictCacheByPrefix(`file:${resolvedEntryPath}::`, cacheEntryKey);
    const modulePromise = importFileBackedModule({
        resolvedEntryPath,
        fingerprint,
        cacheKey: params.cacheKey,
        isTypeScriptDevEntry: selectedEntry.isDevEntry && TYPESCRIPT_DEV_DAEMON_ENTRY_EXTENSIONS.has(extension),
    });
    moduleLoadCache.set(cacheEntryKey, modulePromise);

    try {
        return await modulePromise;
    } catch (error) {
        moduleLoadCache.delete(cacheEntryKey);
        throw createModuleLoadError(
            'PLUGIN_DAEMON_MODULE_LOAD_FAILED',
            `Failed to load plugin daemon entry '${resolvedEntryPath}': ${error instanceof Error ? error.message : 'unknown error'}`,
            error,
        );
    }
}

async function loadBundledModule<TModule extends PluginModuleNamespace>(params: Readonly<{
    moduleId: string;
    load: () => Promise<TModule>;
    cacheKey?: string;
}>): Promise<TModule> {
    const cacheEntryKey = buildBundledCacheKey({
        moduleId: params.moduleId,
        cacheKey: params.cacheKey,
    });
    const cached = moduleLoadCache.get(cacheEntryKey);
    if (cached) {
        return await (cached as Promise<TModule>);
    }

    evictCacheByPrefix(`bundled:${params.moduleId}::`, cacheEntryKey);
    const modulePromise = params.load() as Promise<PluginModuleNamespace>;
    moduleLoadCache.set(cacheEntryKey, modulePromise);
    try {
        return await (modulePromise as Promise<TModule>);
    } catch (error) {
        moduleLoadCache.delete(cacheEntryKey);
        throw createModuleLoadError(
            'PLUGIN_DAEMON_MODULE_LOAD_FAILED',
            `Failed to load bundled plugin daemon module '${params.moduleId}': ${error instanceof Error ? error.message : 'unknown error'}`,
            error,
        );
    }
}

export async function loadPluginModule<TModule extends PluginModuleNamespace>(params: Readonly<{
    source: PluginActivationSource<TModule>;
    cacheKey?: string;
}>): Promise<TModule> {
    if (params.source.kind === 'file_backed') {
        return await loadFileBackedModule({
            entryPath: params.source.entryPath,
            devEntryPath: params.source.devEntryPath,
            useDevelopmentEntry: params.source.useDevelopmentEntry,
            committedAuthorization: params.source.committedAuthorization,
            cacheKey: params.cacheKey,
        }) as TModule;
    }

    return await loadBundledModule({
        moduleId: params.source.moduleId,
        load: params.source.load,
        cacheKey: params.cacheKey,
    });
}
