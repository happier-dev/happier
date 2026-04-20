import { stat } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { ExtensionSourceTrustPolicyV1 } from '@happier-dev/protocol';

import type { ExtensionActivationSource } from './activationSources';

export type ExtensionModuleNamespace = Readonly<Record<string, unknown>> & Readonly<{
    default?: unknown;
}>;

type ExtensionModuleLoadErrorCode =
    | 'PLUGIN_DAEMON_ENTRY_MISSING'
    | 'PLUGIN_DAEMON_ENTRY_KIND_UNSUPPORTED'
    | 'PLUGIN_DAEMON_MODULE_LOAD_FAILED'
    | 'PLUGIN_DAEMON_TRUST_APPROVAL_REQUIRED'
    | 'PLUGIN_DAEMON_TRUST_UNTRUSTED';

const moduleLoadCache = new Map<string, Promise<ExtensionModuleNamespace>>();
const SUPPORTED_DAEMON_ENTRY_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);

function createModuleLoadError(code: ExtensionModuleLoadErrorCode, message: string, cause?: unknown): Error {
    const error = new Error(message) as Error & { code?: ExtensionModuleLoadErrorCode; cause?: unknown };
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

function assertTrusted(trustPolicy: ExtensionSourceTrustPolicyV1 | undefined): void {
    if (trustPolicy !== 'local_trusted') {
        if (trustPolicy === 'untrusted') {
            throw createModuleLoadError(
                'PLUGIN_DAEMON_TRUST_UNTRUSTED',
                'Refusing to load executable plugin daemon entry from an untrusted source',
            );
        }
        throw createModuleLoadError(
            'PLUGIN_DAEMON_TRUST_APPROVAL_REQUIRED',
            'Plugin executable load requires explicit trust approval before loading daemon code',
        );
    }
}

async function loadFileBackedModule(params: Readonly<{
    entryPath: string;
    trustPolicy: ExtensionSourceTrustPolicyV1 | undefined;
    cacheKey?: string;
}>): Promise<ExtensionModuleNamespace> {
    assertTrusted(params.trustPolicy);

    const resolvedEntryPath = resolve(params.entryPath);
    const extension = extname(resolvedEntryPath).toLowerCase();
    if (!SUPPORTED_DAEMON_ENTRY_EXTENSIONS.has(extension)) {
        throw createModuleLoadError(
            'PLUGIN_DAEMON_ENTRY_KIND_UNSUPPORTED',
            `Unsupported plugin daemon entry extension '${extension || '<none>'}' for '${resolvedEntryPath}'`,
        );
    }

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
    const moduleUrl = pathToFileURL(resolvedEntryPath);
    moduleUrl.searchParams.set(
        'happier_plugin_cache_key',
        `${params.cacheKey ?? 'path'}:${fingerprint}`,
    );
    const modulePromise = import(moduleUrl.href) as Promise<ExtensionModuleNamespace>;
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

async function loadBundledModule<TModule extends ExtensionModuleNamespace>(params: Readonly<{
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
    const modulePromise = params.load() as Promise<ExtensionModuleNamespace>;
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

export async function loadExtensionModule<TModule extends ExtensionModuleNamespace>(params: Readonly<{
    source: ExtensionActivationSource<TModule>;
    cacheKey?: string;
}>): Promise<TModule> {
    if (params.source.kind === 'file_backed') {
        return await loadFileBackedModule({
            entryPath: params.source.entryPath,
            trustPolicy: params.source.trustPolicy,
            cacheKey: params.cacheKey,
        }) as TModule;
    }

    return await loadBundledModule({
        moduleId: params.source.moduleId,
        load: params.source.load,
        cacheKey: params.cacheKey,
    });
}
