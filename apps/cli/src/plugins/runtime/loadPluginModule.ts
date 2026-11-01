import { realpath, stat } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { createJiti } from 'jiti';

import { isCanonicalAbsolutePathInsideRoot } from '@/utils/path/expandHomeDirPath';

import type { CommittedPluginExecutionAuthorization, PluginActivationSource } from './activationSources';
import type { PluginRuntimeSourceAuthority } from './sourceAuthority';

export type PluginModuleNamespace = Readonly<Record<string, unknown>> & Readonly<{
    default?: unknown;
}>;

type NativeFileUrlMode = 'generation-keyed' | 'canonical';

type PluginModuleLoadErrorCode =
    | 'PLUGIN_DAEMON_ENTRY_MISSING'
    | 'PLUGIN_DAEMON_ENTRY_KIND_UNSUPPORTED'
    | 'PLUGIN_DAEMON_MODULE_LOAD_FAILED'
    | 'PLUGIN_DAEMON_TRUST_APPROVAL_REQUIRED';

const moduleLoadCache = new Map<string, Promise<PluginModuleNamespace>>();
const requirePluginModule = createRequire(import.meta.url);
type TypeScriptGenerationLoaderState = Readonly<{
    loader: ReturnType<typeof createJiti>;
    moduleLoadCache: Map<string, Promise<PluginModuleNamespace>>;
}>;
const typescriptGenerationLoaderStates = new WeakMap<
    object,
    TypeScriptGenerationLoaderState
>();
const SUPPORTED_DAEMON_ENTRY_EXTENSION_LIST = Object.freeze([
    '.js',
    '.mjs',
    '.cjs',
]);
const SUPPORTED_DEV_DAEMON_ENTRY_EXTENSION_LIST = Object.freeze([
    ...SUPPORTED_DAEMON_ENTRY_EXTENSION_LIST,
    '.ts',
    '.mts',
    '.cts',
]);
const SUPPORTED_DAEMON_ENTRY_EXTENSIONS = new Set(
    SUPPORTED_DAEMON_ENTRY_EXTENSION_LIST,
);
const SUPPORTED_DEV_DAEMON_ENTRY_EXTENSIONS = new Set(
    SUPPORTED_DEV_DAEMON_ENTRY_EXTENSION_LIST,
);
const TYPESCRIPT_DEV_DAEMON_ENTRY_EXTENSIONS = new Set(['.ts', '.mts', '.cts']);
const SUPPORTED_PLUGIN_AUTHOR_SOURCE_EXTENSIONS = new Set([
    '.ts',
    '.mts',
    '.js',
    '.mjs',
]);

export function isSupportedPluginAuthorSourceExtension(entryPath: string): boolean {
    return SUPPORTED_PLUGIN_AUTHOR_SOURCE_EXTENSIONS.has(
        extname(entryPath).toLowerCase(),
    );
}

async function importMutablePluginAuthorSourceModule(
    loader: ReturnType<typeof createJiti>,
    entryPath: string,
): Promise<PluginModuleNamespace> {
    const extension = extname(entryPath).toLowerCase();
    const forceTranspile = 'forceTranspile' in loader.options
        && loader.options.forceTranspile === true;
    // Patched development candidates keep recursive ESM imports in Jiti and
    // preserve top-level await. Keep the existing synchronous JavaScript path
    // for other loads and until the pinned patch is installed.
    if ((extension === '.js' || extension === '.mjs') && !forceTranspile) {
        return loader(entryPath) as PluginModuleNamespace;
    }
    return await loader.import(entryPath) as PluginModuleNamespace;
}

export async function loadPluginAuthorSourceModule(
    entryPath: string,
    options: Readonly<{
        aliases?: Readonly<Record<string, string>>;
    }> = {},
): Promise<PluginModuleNamespace> {
    const resolvedEntryPath = resolve(entryPath);
    const extension = extname(resolvedEntryPath).toLowerCase();
    if (!isSupportedPluginAuthorSourceExtension(resolvedEntryPath)) {
        throw createModuleLoadError(
            'PLUGIN_DAEMON_ENTRY_KIND_UNSUPPORTED',
            `Unsupported plugin author source extension '${extension || '<none>'}' for '${resolvedEntryPath}'`,
        );
    }
    const entryStats = await stat(resolvedEntryPath).catch((cause: unknown) => {
        throw createModuleLoadError(
            'PLUGIN_DAEMON_ENTRY_MISSING',
            `Plugin author source entry is unavailable: '${resolvedEntryPath}'`,
            cause,
        );
    });
    if (!entryStats.isFile()) {
        throw createModuleLoadError(
            'PLUGIN_DAEMON_ENTRY_MISSING',
            `Plugin author source entry is not a regular file: '${resolvedEntryPath}'`,
        );
    }
    const loader = createJiti(import.meta.url, {
        // Jiti validates transforms against current source bytes. This cache
        // saves compilation without changing module identity or eviction.
        fsCache: true,
        moduleCache: true,
        interopDefault: false,
        ...(options.aliases && Object.keys(options.aliases).length > 0
            ? { alias: { ...options.aliases } }
            : {}),
    });
    return await importMutablePluginAuthorSourceModule(loader, resolvedEntryPath);
}

export function resolvePluginModuleLoadMode(input: Readonly<{
    entryPath: string;
    useDevelopmentEntry: boolean;
}>): 'immutable-js' | 'source-ts' {
    return input.useDevelopmentEntry
        && TYPESCRIPT_DEV_DAEMON_ENTRY_EXTENSIONS.has(
            extname(input.entryPath).toLowerCase(),
        )
        ? 'source-ts'
        : 'immutable-js';
}

export function resolvePluginModuleCandidatePaths(input: Readonly<{
    candidateBase: string;
    loadMode: 'immutable-js' | 'source-ts';
}>): readonly string[] {
    const extension = extname(input.candidateBase).toLowerCase();
    if (extension) {
        const sourceExtension = input.loadMode === 'source-ts'
            ? ({ '.js': '.ts', '.mjs': '.mts', '.cjs': '.cts' } as const)[
                extension as '.js' | '.mjs' | '.cjs'
            ]
            : undefined;
        if (sourceExtension) {
            return Object.freeze([
                input.candidateBase,
                `${input.candidateBase.slice(0, -extension.length)}${sourceExtension}`,
            ]);
        }
        return Object.freeze([input.candidateBase]);
    }
    const extensions = input.loadMode === 'source-ts'
        ? SUPPORTED_DEV_DAEMON_ENTRY_EXTENSION_LIST
        : SUPPORTED_DAEMON_ENTRY_EXTENSION_LIST;
    return Object.freeze([
        input.candidateBase,
        ...extensions.map((extension) => `${input.candidateBase}${extension}`),
        ...extensions.map((extension) => resolve(
            input.candidateBase,
            `index${extension}`,
        )),
    ]);
}
function createModuleLoadError(code: PluginModuleLoadErrorCode, message: string, cause?: unknown): Error {
    const error = new Error(message) as Error & { code?: PluginModuleLoadErrorCode; cause?: unknown };
    error.code = code;
    if (cause !== undefined) {
        error.cause = cause;
    }
    return error;
}

function stableCacheKey(cacheKey: string | undefined, fallback: string): string {
    return cacheKey && cacheKey.trim().length > 0 ? cacheKey.trim() : fallback;
}

function buildFileBackedCacheKey(params: Readonly<{
    entryPath: string;
    cacheKey: string;
    nativeFileUrlMode: NativeFileUrlMode;
}>): string {
    return `file:${params.entryPath}::${params.nativeFileUrlMode}::${params.cacheKey}`;
}

function buildBundledCacheKey(params: Readonly<{ moduleId: string; cacheKey?: string }>): string {
    return `bundled:${params.moduleId}::${stableCacheKey(params.cacheKey, 'module-id')}`;
}

function evictCacheByPrefix(
    cache: Map<string, Promise<PluginModuleNamespace>>,
    prefix: string,
    preserveKey: string,
): void {
    for (const key of cache.keys()) {
        if (key !== preserveKey && key.startsWith(prefix)) {
            cache.delete(key);
        }
    }
}

function resolveTypeScriptGenerationLoaderState(
    generationScope: object,
): TypeScriptGenerationLoaderState {
    const current = typescriptGenerationLoaderStates.get(generationScope);
    if (current) return current;
    const created = Object.freeze({
        loader: createJiti(import.meta.url, {
            fsCache: true,
            moduleCache: true,
            interopDefault: false,
        }),
        moduleLoadCache: new Map<string, Promise<PluginModuleNamespace>>(),
    });
    typescriptGenerationLoaderStates.set(generationScope, created);
    return created;
}

export function createPluginTypeScriptGenerationScope(options: Readonly<{
    aliases?: Readonly<Record<string, string>>;
}> = {}): object {
    const generationScope = Object.freeze({});
    typescriptGenerationLoaderStates.set(generationScope, Object.freeze({
        loader: createJiti(import.meta.url, {
            fsCache: true,
            moduleCache: true,
            interopDefault: false,
            ...(options.aliases && Object.keys(options.aliases).length > 0
                ? { alias: { ...options.aliases } }
                : {}),
        }),
        moduleLoadCache: new Map<string, Promise<PluginModuleNamespace>>(),
    }));
    return generationScope;
}

/**
 * Creates a fresh evaluation scope for mutable trusted development bytes.
 * Jiti shares Node's module cache even across loader instances, so evict only
 * modules physically owned by this author root before the candidate starts.
 */
export async function createPluginTypeScriptCandidateScope(options: Readonly<{
    rootPath: string;
    aliases?: Readonly<Record<string, string>>;
}>): Promise<object> {
    const canonicalRoot = await realpath(resolve(options.rootPath));
    const candidateScope = createPluginTypeScriptGenerationScope({
        ...(options.aliases ? { aliases: options.aliases } : {}),
    });
    const state = resolveTypeScriptGenerationLoaderState(candidateScope);
    // Only the pinned Jiti patch declares this default-off instance option.
    // Unpatched installs retain their current evaluation behavior.
    if ('forceTranspile' in state.loader.options) {
        state.loader.options.forceTranspile = true;
    }
    for (const cachedPath of Object.keys(state.loader.cache)) {
        const absoluteCachedPath = resolve(cachedPath);
        if (
            absoluteCachedPath === canonicalRoot
            || isCanonicalAbsolutePathInsideRoot(canonicalRoot, absoluteCachedPath)
        ) {
            delete state.loader.cache[cachedPath];
        }
    }
    return candidateScope;
}

async function assertTrusted(
    committedAuthorization: CommittedPluginExecutionAuthorization | undefined,
    sourceAuthority?: PluginRuntimeSourceAuthority,
): Promise<void> {
    if (committedAuthorization) return;
    if (sourceAuthority?.kind === 'development') return;
    if (sourceAuthority?.kind === 'account_release') return;
    if (sourceAuthority?.kind === 'bundled_first_party') return;
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
    if (supportedExtensions.has(params.extension)
        || params.resolvedEntryPath.endsWith('.cjs.bundle')) {
        return;
    }

    throw createModuleLoadError(
        'PLUGIN_DAEMON_ENTRY_KIND_UNSUPPORTED',
        `Unsupported plugin daemon ${params.isDevEntry ? 'dev ' : ''}entry extension '${params.extension || '<none>'}' for '${params.resolvedEntryPath}'`,
    );
}

export function resolveNativePluginModuleUrl(params: Readonly<{
    resolvedEntryPath: string;
    cacheKey: string;
    mode: NativeFileUrlMode;
}>): string {
    const moduleUrl = pathToFileURL(params.resolvedEntryPath);
    // Reviewed immutable roots already provide generation identity. A selected
    // runner leaf stays plain so the activation entry's relative ESM import and
    // the strict locator resolver observe the same native module object.
    if (params.mode === 'generation-keyed') {
        moduleUrl.searchParams.set(
            'happier_plugin_cache_key',
            params.cacheKey,
        );
    }
    return moduleUrl.href;
}

async function importFileBackedModule(params: Readonly<{
    resolvedEntryPath: string;
    cacheKey: string;
    isTypeScriptDevEntry: boolean;
    generationScope?: object;
    nativeFileUrlMode: NativeFileUrlMode;
}>): Promise<PluginModuleNamespace> {
    if (params.resolvedEntryPath.endsWith('.cjs.bundle')) {
        // Portable artifacts are compiler-produced, self-contained CommonJS.
        // Reuse Node's native module host after the same source admission as
        // every other executable; this owner retains generation cache identity.
        delete requirePluginModule.cache[params.resolvedEntryPath];
        return requirePluginModule(params.resolvedEntryPath) as PluginModuleNamespace;
    }
    if (params.isTypeScriptDevEntry) {
        const generationScope = params.generationScope;
        if (!generationScope) {
            throw createModuleLoadError(
                'PLUGIN_DAEMON_TRUST_APPROVAL_REQUIRED',
                'TypeScript plugin execution requires one immutable generation authorization',
            );
        }
        // Entry and runner leaf share one authorization-scoped graph. Both the
        // Jiti module graph and direct load joining retire with that authority.
        const generationState = resolveTypeScriptGenerationLoaderState(
            generationScope,
        );
        const graphModulePath = await realpath(params.resolvedEntryPath);
        const cachedModule = generationState.loader.cache[
            graphModulePath
        ];
        if (cachedModule?.loaded) {
            return cachedModule.exports as PluginModuleNamespace;
        }
        return await importMutablePluginAuthorSourceModule(
            generationState.loader,
            graphModulePath,
        );
    }

    return await import(resolveNativePluginModuleUrl({
        resolvedEntryPath: params.resolvedEntryPath,
        cacheKey: params.cacheKey,
        mode: params.nativeFileUrlMode,
    })) as PluginModuleNamespace;
}

/**
 * Canonical module evaluator for bytes whose caller has already established
 * immutable-generation authority. Admission/trust owners remain outside this
 * function; activation and runner loaders share only module identity/cache
 * semantics here.
 */
export async function loadVerifiedPluginModule(params: Readonly<{
    entryPath: string;
    loadMode: 'immutable-js' | 'source-ts';
    generationScope: object;
    cacheKey?: string;
    nativeFileUrlMode?: NativeFileUrlMode;
}>): Promise<PluginModuleNamespace> {
    const resolvedEntryPath = resolve(params.entryPath);
    const extension = extname(resolvedEntryPath).toLowerCase();
    const isTypeScriptDevEntry = params.loadMode === 'source-ts';
    assertSupportedEntryExtension({
        extension,
        resolvedEntryPath,
        isDevEntry: isTypeScriptDevEntry,
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

    const nativeFileUrlMode = params.nativeFileUrlMode ?? 'generation-keyed';
    const cacheKey = params.cacheKey?.trim()
        || (isTypeScriptDevEntry ? 'generation-scope' : '');
    if (!cacheKey) {
        throw createModuleLoadError(
            'PLUGIN_DAEMON_TRUST_APPROVAL_REQUIRED',
            'Immutable JavaScript plugin execution requires one opaque generation cache identity',
        );
    }
    const cacheEntryKey = buildFileBackedCacheKey({
        entryPath: resolvedEntryPath,
        cacheKey,
        nativeFileUrlMode,
    });
    const loadCache = isTypeScriptDevEntry
        ? resolveTypeScriptGenerationLoaderState(params.generationScope)
            .moduleLoadCache
        : moduleLoadCache;
    const cached = loadCache.get(cacheEntryKey);
    if (cached) {
        return await cached;
    }

    evictCacheByPrefix(
        loadCache,
        `file:${resolvedEntryPath}::`,
        cacheEntryKey,
    );
    const modulePromise = importFileBackedModule({
        resolvedEntryPath,
        cacheKey,
        isTypeScriptDevEntry,
        generationScope: params.generationScope,
        nativeFileUrlMode,
    });
    loadCache.set(cacheEntryKey, modulePromise);

    try {
        return await modulePromise;
    } catch (error) {
        loadCache.delete(cacheEntryKey);
        throw createModuleLoadError(
            'PLUGIN_DAEMON_MODULE_LOAD_FAILED',
            `Failed to load plugin daemon entry '${resolvedEntryPath}': ${error instanceof Error ? error.message : 'unknown error'}`,
            error,
        );
    }
}

async function loadFileBackedModule(params: Readonly<{
    entryPath: string;
    devEntryPath?: string | null;
    useDevelopmentEntry?: boolean;
    committedAuthorization?: CommittedPluginExecutionAuthorization;
    sourceAuthority?: PluginRuntimeSourceAuthority;
    generationScope?: object;
    nativeFileUrlMode?: NativeFileUrlMode;
    cacheKey?: string;
}>): Promise<PluginModuleNamespace> {
    await assertTrusted(params.committedAuthorization, params.sourceAuthority);

    const selectedEntry = resolveSelectedEntryPath({
        entryPath: params.entryPath,
        devEntryPath: params.devEntryPath,
        useDevelopmentEntry: params.useDevelopmentEntry,
    });
    return await loadVerifiedPluginModule({
        entryPath: selectedEntry.entryPath,
        loadMode: resolvePluginModuleLoadMode({
            entryPath: selectedEntry.entryPath,
            useDevelopmentEntry: selectedEntry.isDevEntry,
        }),
        generationScope: params.generationScope ?? params.committedAuthorization ?? params.sourceAuthority!,
        cacheKey: params.cacheKey ?? params.committedAuthorization?.immutableGenerationId ?? JSON.stringify(params.sourceAuthority),
        nativeFileUrlMode: params.nativeFileUrlMode,
    });
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

    evictCacheByPrefix(
        moduleLoadCache,
        `bundled:${params.moduleId}::`,
        cacheEntryKey,
    );
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
    nativeFileUrlMode?: NativeFileUrlMode;
}>): Promise<TModule> {
    if (params.source.kind === 'prepared') {
        await assertTrusted(params.source.committedAuthorization, params.source.sourceAuthority);
        return params.source.module;
    }
    if (params.source.kind === 'file_backed') {
        return await loadFileBackedModule({
            entryPath: params.source.entryPath,
            devEntryPath: params.source.devEntryPath,
            useDevelopmentEntry: params.source.useDevelopmentEntry,
            committedAuthorization: params.source.committedAuthorization,
            sourceAuthority: params.source.sourceAuthority,
            generationScope: params.source.generationScope,
            nativeFileUrlMode: params.nativeFileUrlMode,
            cacheKey: params.cacheKey,
        }) as TModule;
    }

    if (params.source.sourceAuthority?.kind === 'development') {
        // Mutable development graphs belong to this activation source's scope.
        // A serving registry can retain its generation across disable/enable;
        // the process-wide bundled cache would then resurrect an older graph.
        await assertTrusted(undefined, params.source.sourceAuthority);
        return await params.source.load();
    }

    return await loadBundledModule({
        moduleId: params.source.moduleId,
        load: params.source.load,
        cacheKey: params.cacheKey,
    });
}
