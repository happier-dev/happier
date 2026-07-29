import type { PluginReactNativeBundleCache, PluginReactNativeCachedArtifactFile } from './bundleCache';
import type { PluginReactNativeSurfaceModule } from './PluginReactNativeSurface';
import type { PluginReactNativeBundleCacheIdentity } from '@/sync/domains/plugins/ui/reactNativeRuntime';
import { createReactNativeInstalledArtifactFileMaterializer } from './artifactFileMaterializer';
import {
    createRepackDevServerModuleLoader,
    type RepackDevServerModuleLoader,
} from './devLoader';
import { resolvePluginReactNativeExecutableExport } from './moduleNamespace';
import { resolveDefaultNativeRepackClient } from './nativeRepackClientResolver';

const REPACK_CLIENT_PACKAGE_NAME = '@callstack/repack/client';
const REPACK_UNAVAILABLE_DIAGNOSTIC = 'repack_script_manager_unavailable';
const REPACK_PACKAGE_MISSING_DIAGNOSTIC = 'repack_script_manager_package_missing';
const REPACK_API_MISSING_DIAGNOSTIC = 'repack_script_manager_api_missing';
const REPACK_INSTALLED_ARTIFACT_LOADER_MISSING_DIAGNOSTIC =
    'repack_script_manager_installed_artifact_loader_unavailable';

export type RepackScriptManagerRuntimeApi = Readonly<{
    scriptManager: Readonly<{
        addResolver: (...args: unknown[]) => unknown;
        removeResolver: (...args: unknown[]) => unknown;
        loadScript: (...args: unknown[]) => unknown;
        // RN-HARDEN: optional — only real Re.Pack ScriptManager instances expose
        // this. Used to force-evict a failed load's cached rejected promise (see
        // `createRepackInstalledArtifactModuleLoader`'s catch handler).
        invalidateScripts?: (scriptIds: readonly string[]) => unknown;
    }>;
    federated: Readonly<{
        importModule: (...args: unknown[]) => unknown;
    }>;
}>;

export type RepackInstalledArtifactModuleLoader = (input: Readonly<{
    identity: PluginReactNativeBundleCacheIdentity;
    bytes: Uint8Array;
    files?: readonly PluginReactNativeCachedArtifactFile[];
    entryRelativePath?: string;
    repack: RepackScriptManagerRuntimeApi;
    moduleReference?: RepackInstalledArtifactModuleReference;
}>) => Promise<PluginReactNativeExecutableExport>;

export type PluginReactNativeExecutableExport = (
    (...args: never[]) => unknown
) & Readonly<{
    acknowledgeHostRuntime?: PluginReactNativeSurfaceModule['acknowledgeHostRuntime'];
}>;

export type RepackInstalledArtifactModuleReference = Readonly<{
    containerName: string;
    modulePath: string;
    exportName: string;
}>;

export type RepackInstalledArtifactFileUrlResolver = (input: Readonly<{
    identity: PluginReactNativeBundleCacheIdentity;
    bytes: Uint8Array;
    scriptId: string;
    file?: PluginReactNativeCachedArtifactFile;
}>) => string | Promise<string>;

export type RepackClientResolver = () => unknown;

export type PluginReactNativeLoaderBackend = Readonly<{
    // RN-WEB-LOADER: 'reactNativeWebModule' identifies the web-target backend
    // (webLoaderBackend.web.ts) — same loader contract (loadInstalledBundle /
    // loadDevServerBundle), different underlying mechanism (in-process
    // `import()` of a Vite-built module instead of Re.Pack's ScriptManager).
    backendId: 'repackScriptManager' | 'reactNativeWebModule';
    available: boolean;
    loadInstalledBundle?: (input: Readonly<{
        identity: PluginReactNativeBundleCacheIdentity;
        bytes: Uint8Array;
        files?: readonly PluginReactNativeCachedArtifactFile[];
        entryRelativePath?: string;
        moduleReference?: RepackInstalledArtifactModuleReference;
    }>) => Promise<PluginReactNativeExecutableExport>;
    // RN-2: the dev-hot-reload LOAD path, served from a local dev-server URL with no
    // materialized artifact. Present only when the Re.Pack runtime is available.
    loadDevServerBundle?: (input: Readonly<{
        devUrl: string;
        pluginId: string;
        contributionId: string;
        moduleReference?: RepackInstalledArtifactModuleReference;
    }>) => Promise<PluginReactNativeExecutableExport>;
    unavailableReason?: string;
    diagnostics?: readonly string[];
}>;

export type PluginReactNativeLoaderResult =
    | Readonly<{ ok: true; module: PluginReactNativeSurfaceModule }>
    | Readonly<{
        ok: false;
        code: 'loader_backend_unavailable' | 'artifact_cache_miss' | 'invalid_surface_module' | 'platform_mismatch';
        diagnostics: readonly string[];
    }>;

export type PluginReactNativeExportLoaderResult =
    | Readonly<{ ok: true; exported: PluginReactNativeExecutableExport }>
    | Readonly<{
        ok: false;
        code: 'loader_backend_unavailable' | 'artifact_cache_miss' | 'invalid_executable_export' | 'platform_mismatch';
        diagnostics: readonly string[];
    }>;

export function createFailClosedRepackScriptManagerBackend(
    unavailableReason: string,
    diagnostics: readonly string[] = [REPACK_UNAVAILABLE_DIAGNOSTIC],
): PluginReactNativeLoaderBackend {
    return Object.freeze({
        backendId: 'repackScriptManager',
        available: false,
        unavailableReason,
        diagnostics: Object.freeze([...diagnostics]),
    });
}

function createRepackClientPackageMissingBackend(): PluginReactNativeLoaderBackend {
    return createFailClosedRepackScriptManagerBackend(
        `${REPACK_CLIENT_PACKAGE_NAME} is not installed in this checkout`,
        [REPACK_UNAVAILABLE_DIAGNOSTIC, REPACK_PACKAGE_MISSING_DIAGNOSTIC],
    );
}

function defaultResolveRepackClient(): unknown {
    return resolveDefaultNativeRepackClient();
}

export function createDefaultRepackScriptManagerBackend(params?: Readonly<{
    resolveClient?: RepackClientResolver;
    loadInstalledBundle?: RepackInstalledArtifactModuleLoader;
    loadDevServerBundle?: RepackDevServerModuleLoader;
}>): PluginReactNativeLoaderBackend {
    const client = (params?.resolveClient ?? defaultResolveRepackClient)();
    if (!client) {
        return createRepackClientPackageMissingBackend();
    }
    const loadInstalledBundle = params?.loadInstalledBundle
        ?? createRepackInstalledArtifactModuleLoader({
            resolveInstalledArtifactFileUrl: createReactNativeInstalledArtifactFileMaterializer(),
        });
    return createRepackScriptManagerBackendFromClient({
        client,
        loadInstalledBundle,
        ...(params?.loadDevServerBundle ? { loadDevServerBundle: params.loadDevServerBundle } : {}),
    });
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Readonly<Record<string, unknown>>
        : null;
}

// Re.Pack 5 exports `ScriptManager` as a CLASS — `typeof value === 'function'` —
// whose `init`/`shared` members are statics. Containers we read members off must
// therefore accept both plain objects and class constructors.
function asMemberContainer(value: unknown): Readonly<Record<string, unknown>> | null {
    if (!value) return null;
    if (typeof value === 'function') return value as unknown as Readonly<Record<string, unknown>>;
    return asRecord(value);
}

function readBoundFunction(
    record: Readonly<Record<string, unknown>> | null,
    key: string,
): ((...args: unknown[]) => unknown) | null {
    const value = record?.[key];
    return typeof value === 'function'
        ? (...args: unknown[]) => Reflect.apply(value, record, args) as unknown
        : null;
}

function readRepackScriptManagerRuntime(
    client: unknown,
): RepackScriptManagerRuntimeApi | null {
    const clientRecord = asRecord(client);
    const scriptManagerRecord = asMemberContainer(clientRecord?.ScriptManager);
    const sharedRecord = asRecord(scriptManagerRecord?.shared);
    const federatedRecord = asRecord(clientRecord?.Federated);
    const addResolver = readBoundFunction(sharedRecord, 'addResolver');
    const removeResolver = readBoundFunction(sharedRecord, 'removeResolver');
    const loadScript = readBoundFunction(sharedRecord, 'loadScript');
    const importModule = readBoundFunction(federatedRecord, 'importModule');
    if (!addResolver || !removeResolver || !loadScript || !importModule) {
        return null;
    }
    // Optional: only real Re.Pack ScriptManager instances expose this.
    const invalidateScripts = readBoundFunction(sharedRecord, 'invalidateScripts');

    return Object.freeze({
        scriptManager: Object.freeze({
            addResolver,
            removeResolver,
            loadScript,
            ...(invalidateScripts ? { invalidateScripts } : {}),
        }),
        federated: Object.freeze({
            importModule,
        }),
    });
}

function sanitizeFederatedIdentifier(value: string): string {
    const normalized = value
        .trim()
        .replace(/[^A-Za-z0-9_$]/g, '_')
        .replace(/^[^A-Za-z_$]+/, '');
    return normalized || 'pluginReactNativeBundle';
}

export function derivePluginUiFederatedContainerName(input: Readonly<{
    pluginId: string;
    contributionId: string;
}>): string {
    return sanitizeFederatedIdentifier(`${input.pluginId}_${input.contributionId}`);
}

function createInstalledArtifactScriptId(identity: PluginReactNativeBundleCacheIdentity): string {
    return [
        'happier-installed-artifact',
        identity.pluginId,
        identity.contributionId,
        identity.platform,
        identity.channel,
        identity.artifactDigest,
        String(identity.projectionGeneration),
    ].map(encodeURIComponent).join(':');
}

function createInstalledArtifactResolverKey(scriptId: string): string {
    return `happier-installed-artifact:${scriptId}`;
}

function readFileName(relativePath: string): string {
    return relativePath.split(/[\\/]/u).filter(Boolean).pop() ?? relativePath;
}

function createChunkScriptIdCandidates(file: PluginReactNativeCachedArtifactFile): readonly string[] {
    const fileName = readFileName(file.relativePath);
    if (fileName.endsWith('.map')) {
        return Object.freeze([]);
    }
    const candidates = new Set<string>([file.relativePath, fileName]);
    const withoutBundle = fileName.replace(/\.bundle$/u, '');
    candidates.add(withoutBundle);
    if (fileName.endsWith('.chunk.bundle')) {
        candidates.add(fileName.slice(0, -'.chunk.bundle'.length));
    }
    if (withoutBundle.startsWith('chunk-')) {
        candidates.add(withoutBundle.slice('chunk-'.length));
    }
    return Object.freeze([...candidates].filter(Boolean));
}

function requestedScriptMatchesFile(input: Readonly<{
    file: PluginReactNativeCachedArtifactFile;
    requestedScriptId: string;
    caller?: string;
}>): boolean {
    const candidates = createChunkScriptIdCandidates(input.file);
    if (candidates.includes(input.requestedScriptId)) {
        return true;
    }
    if (!input.caller) {
        return false;
    }
    return candidates.some((candidate) =>
        input.requestedScriptId === `${input.caller}_${candidate}`
        || input.requestedScriptId === `${input.caller}:${candidate}`
        || input.requestedScriptId === `${input.caller}/${candidate}`
    );
}

function resolveDefaultFederatedModule(
    identity: PluginReactNativeBundleCacheIdentity,
): RepackInstalledArtifactModuleReference {
    return Object.freeze({
        containerName: derivePluginUiFederatedContainerName(identity),
        modulePath: './renderSurface',
        exportName: 'renderSurface',
    });
}

export function createRepackInstalledArtifactModuleLoader(params: Readonly<{
    resolveInstalledArtifactFileUrl: RepackInstalledArtifactFileUrlResolver;
    resolveFederatedModule?: (
        identity: PluginReactNativeBundleCacheIdentity,
    ) => RepackInstalledArtifactModuleReference;
}>): RepackInstalledArtifactModuleLoader {
    return async ({
        identity,
        bytes,
        files,
        entryRelativePath,
        repack,
        moduleReference: inputModuleReference,
    }) => {
        const scriptId = createInstalledArtifactScriptId(identity);
        const resolverKey = createInstalledArtifactResolverKey(scriptId);
        const entryFile = entryRelativePath
            ? files?.find((file) => file.relativePath === entryRelativePath)
            : files?.find((file) => file.digest === identity.artifactDigest);
        if (entryRelativePath && !entryFile) {
            throw new Error('Re.Pack installed artifact graph is missing its declared entry file');
        }
        const url = await params.resolveInstalledArtifactFileUrl({
            identity,
            bytes,
            scriptId,
            ...(entryFile ? { file: entryFile } : {}),
        });
        if (!url?.startsWith('file://')) {
            throw new Error('Re.Pack installed artifact resolver must resolve to a file:// URL');
        }
        const resolver = async (requestedScriptId: unknown, caller?: unknown) => {
            if (requestedScriptId !== scriptId) {
                if (typeof requestedScriptId !== 'string') {
                    return undefined;
                }
                const callerId = typeof caller === 'string' ? caller : undefined;
                const chunkFile = files?.find((file) =>
                    file !== entryFile
                    && requestedScriptMatchesFile({ file, requestedScriptId, ...(callerId ? { caller: callerId } : {}) })
                );
                if (!chunkFile) {
                    return undefined;
                }
                const chunkUrl = await params.resolveInstalledArtifactFileUrl({
                    identity,
                    bytes: chunkFile.bytes,
                    scriptId: `${callerId ? `${callerId}:` : ''}${requestedScriptId}`,
                    file: chunkFile,
                });
                if (!chunkUrl?.startsWith('file://')) {
                    throw new Error('Re.Pack installed artifact resolver must resolve to a file:// URL');
                }
                return Object.freeze({
                    url: chunkUrl,
                    absolute: true,
                    cache: false,
                });
            }
            return Object.freeze({
                url,
                absolute: true,
                cache: false,
            });
        };
        repack.scriptManager.addResolver(resolver, {
            key: resolverKey,
            priority: 0,
        });

        try {
            try {
                await repack.scriptManager.loadScript(scriptId);
            } catch (loadError) {
                // RN-HARDEN: Re.Pack's `ScriptManager.loadScript` only clears its
                // internal `scriptsPromises[uniqueId]` cache entry in the
                // load-execution phase's own `finally` — a failure in the
                // RESOLUTION phase (our one-shot resolver above; `uniqueId` here
                // equals `scriptId` since we call `loadScript` with no `caller`)
                // leaves that promise cached and REJECTED forever, so every
                // later `loadScript(scriptId)` replays the same rejection and a
                // freshly re-registered resolver is never consulted again.
                // Force-evict via ScriptManager's own `invalidateScripts` (which
                // deletes `scriptsPromises[scriptId]` directly) before
                // rethrowing, so the next attempt always starts fresh. Best
                // effort: only real ScriptManager instances expose this, and a
                // failure here must never mask the original load error.
                try {
                    await repack.scriptManager.invalidateScripts?.([scriptId]);
                } catch {
                    // Eviction is a hygiene step, not load-critical.
                }
                throw loadError;
            }
            const moduleReference =
                inputModuleReference
                ?? params?.resolveFederatedModule?.(identity)
                ?? resolveDefaultFederatedModule(identity);
            const namespace = await repack.federated.importModule(
                moduleReference.containerName,
                moduleReference.modulePath,
            );
            return resolvePluginReactNativeExecutableExport(
                namespace,
                moduleReference.exportName,
            ) as PluginReactNativeExecutableExport;
        } finally {
            repack.scriptManager.removeResolver(resolverKey);
        }
    };
}

export function createRepackScriptManagerBackendFromClient(params: Readonly<{
    client: unknown;
    loadInstalledBundle?: RepackInstalledArtifactModuleLoader;
    loadDevServerBundle?: RepackDevServerModuleLoader;
}>): PluginReactNativeLoaderBackend {
    if (!params.client) {
        return createRepackClientPackageMissingBackend();
    }

    const repack = readRepackScriptManagerRuntime(params.client);
    if (!repack) {
        return createFailClosedRepackScriptManagerBackend(
            `${REPACK_CLIENT_PACKAGE_NAME} does not expose ScriptManager.shared and Federated.importModule`,
            [REPACK_UNAVAILABLE_DIAGNOSTIC, REPACK_API_MISSING_DIAGNOSTIC],
        );
    }

    if (!params.loadInstalledBundle) {
        return createFailClosedRepackScriptManagerBackend(
            'Re.Pack ScriptManager is installed, but the host installed-artifact module loader is not wired',
            [REPACK_UNAVAILABLE_DIAGNOSTIC, REPACK_INSTALLED_ARTIFACT_LOADER_MISSING_DIAGNOSTIC],
        );
    }

    const loadInstalledBundle = params.loadInstalledBundle;
    // RN-2: the dev-hot-reload loader rides the SAME validated Re.Pack runtime as the
    // installed-artifact loader — one ScriptManager, two source kinds.
    const loadDevServerBundle = params.loadDevServerBundle ?? createRepackDevServerModuleLoader();
    return Object.freeze({
        backendId: 'repackScriptManager',
        available: true,
        diagnostics: Object.freeze([]),
        loadInstalledBundle: async (input) => await loadInstalledBundle({
            ...input,
            repack,
        }),
        loadDevServerBundle: async (input) => await loadDevServerBundle({
            ...input,
            repack,
        }),
    });
}

export async function loadPluginReactNativeBundleModule(params: Readonly<{
    cache: PluginReactNativeBundleCache;
    identity: PluginReactNativeBundleCacheIdentity;
    moduleReference?: RepackInstalledArtifactModuleReference;
    backend?: PluginReactNativeLoaderBackend;
    hostPlatform?: string;
}>): Promise<PluginReactNativeLoaderResult> {
    const result = await loadPluginReactNativeBundleExport(params);
    if (!result.ok) {
        return Object.freeze({
            ok: false,
            code: result.code === 'invalid_executable_export' ? 'invalid_surface_module' : result.code,
            diagnostics: result.code === 'invalid_executable_export'
                ? Object.freeze(['invalid_surface_module'])
                : result.diagnostics,
        });
    }
    const acknowledgeHostRuntime = result.exported.acknowledgeHostRuntime;
    return Object.freeze({
        ok: true,
        module: Object.freeze({
            renderSurface: result.exported as PluginReactNativeSurfaceModule['renderSurface'],
            ...(acknowledgeHostRuntime ? { acknowledgeHostRuntime } : {}),
        }),
    });
}

export async function loadPluginReactNativeBundleExport(params: Readonly<{
    cache: PluginReactNativeBundleCache;
    identity: PluginReactNativeBundleCacheIdentity;
    moduleReference?: RepackInstalledArtifactModuleReference;
    backend?: PluginReactNativeLoaderBackend;
    hostPlatform?: string;
}>): Promise<PluginReactNativeExportLoaderResult> {
    const backend = params.backend ?? createDefaultRepackScriptManagerBackend();
    if (!backend.available || typeof backend.loadInstalledBundle !== 'function') {
        return Object.freeze({
            ok: false,
            code: 'loader_backend_unavailable',
            diagnostics: Object.freeze([
                ...(backend.diagnostics?.length ? backend.diagnostics : [REPACK_UNAVAILABLE_DIAGNOSTIC]),
            ]),
        });
    }

    const backendPlatformMatches = backend.backendId === 'reactNativeWebModule'
        ? params.identity.platform === 'web'
        : params.identity.platform !== 'web';
    if (!backendPlatformMatches || (params.hostPlatform !== undefined && params.identity.platform !== params.hostPlatform)) {
        return Object.freeze({
            ok: false,
            code: 'platform_mismatch',
            diagnostics: Object.freeze(['artifact_platform_loader_mismatch']),
        });
    }

    const cached = params.cache.readInstalledArtifact(params.identity);
    if (!cached) {
        return Object.freeze({
            ok: false,
            code: 'artifact_cache_miss',
            diagnostics: Object.freeze(['artifact_cache_miss']),
        });
    }

    const declaredEntry = cached.entryRelativePath
        ? cached.files?.find((file) => file.relativePath === cached.entryRelativePath)
        : undefined;
    if (cached.entryRelativePath && !declaredEntry) {
        return Object.freeze({
            ok: false,
            code: 'artifact_cache_miss',
            diagnostics: Object.freeze(['declared_artifact_entry_cache_miss']),
        });
    }

    const exported = await backend.loadInstalledBundle({
        identity: params.identity,
        bytes: declaredEntry?.bytes ?? cached.bytes,
        ...(cached.files ? { files: cached.files } : {}),
        ...(cached.entryRelativePath ? { entryRelativePath: cached.entryRelativePath } : {}),
        ...(params.moduleReference ? { moduleReference: params.moduleReference } : {}),
    });
    if (typeof exported !== 'function') {
        return Object.freeze({
            ok: false,
            code: 'invalid_executable_export',
            diagnostics: Object.freeze(['invalid_executable_export']),
        });
    }

    return Object.freeze({ ok: true, exported });
}
