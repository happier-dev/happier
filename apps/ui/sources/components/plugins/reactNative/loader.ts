import type { PluginReactNativeBundleCache } from './bundleCache';
import { createPluginUiCommonJsLoaderBackend } from './commonJsLoaderBackend';
import type { PluginReactNativeSurfaceModule } from './PluginReactNativeSurface';
import type { PluginReactNativeBundleCacheIdentity } from '@/sync/domains/plugins/ui/reactNativeRuntime';

export type PluginReactNativeExecutableExport = (...args: never[]) => unknown;
export type PluginReactNativeExecutableModuleReference = Readonly<{ exportName: string }>;

export type PluginReactNativeLoaderBackend = Readonly<{
    backendId: 'commonJs';
    available: boolean;
    loadInstalledBundle?: (input: Readonly<{
        identity: PluginReactNativeBundleCacheIdentity;
        bytes: Uint8Array;
        moduleReference?: PluginReactNativeExecutableModuleReference;
        /** The byte owner's per-digest compiled program slot (compiles on first use). */
        readProgram?: <TProgram>(compile: (bytes: Uint8Array) => TProgram) => TProgram | null;
    }>) => Promise<PluginReactNativeExecutableExport>;
    unavailableReason?: string;
    diagnostics?: readonly string[];
}>;

export type PluginReactNativeLoaderResult =
    | Readonly<{ ok: true; module: PluginReactNativeSurfaceModule }>
    | Readonly<{ ok: false; code: 'loader_backend_unavailable' | 'artifact_cache_miss' | 'invalid_surface_module' | 'platform_mismatch'; diagnostics: readonly string[] }>;

export type PluginReactNativeExportLoaderResult =
    | Readonly<{ ok: true; exported: PluginReactNativeExecutableExport }>
    | Readonly<{ ok: false; code: 'loader_backend_unavailable' | 'artifact_cache_miss' | 'invalid_executable_export' | 'platform_mismatch'; diagnostics: readonly string[] }>;

export async function loadPluginReactNativeBundleModule(params: Readonly<{
    cache: PluginReactNativeBundleCache;
    identity: PluginReactNativeBundleCacheIdentity;
    moduleReference?: PluginReactNativeExecutableModuleReference;
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
    return Object.freeze({
        ok: true,
        module: Object.freeze({
            renderSurface: result.exported as PluginReactNativeSurfaceModule['renderSurface'],
        }),
    });
}

export async function loadPluginReactNativeBundleExport(params: Readonly<{
    cache: PluginReactNativeBundleCache;
    identity: PluginReactNativeBundleCacheIdentity;
    moduleReference?: PluginReactNativeExecutableModuleReference;
    backend?: PluginReactNativeLoaderBackend;
    hostPlatform?: string;
}>): Promise<PluginReactNativeExportLoaderResult> {
    const backend = params.backend ?? createPluginUiCommonJsLoaderBackend();
    if (!backend.available || typeof backend.loadInstalledBundle !== 'function') {
        return Object.freeze({
            ok: false,
            code: 'loader_backend_unavailable',
            diagnostics: Object.freeze([...(backend.diagnostics ?? ['commonjs_evaluator_unavailable'])]),
        });
    }
    if (params.hostPlatform !== undefined && params.identity.platform !== params.hostPlatform) {
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
    const exported = await backend.loadInstalledBundle({
        identity: params.identity,
        bytes: cached.bytes,
        ...(params.moduleReference ? { moduleReference: params.moduleReference } : {}),
        readProgram: (compile) => params.cache.readInstalledProgram(params.identity, compile),
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
