import type { PluginReactNativeSurfaceModule } from './PluginReactNativeSurface';
import type {
    PluginReactNativeExecutableExport,
    PluginReactNativeLoaderBackend,
    RepackInstalledArtifactModuleReference,
    RepackScriptManagerRuntimeApi,
} from './loader';
import { resolvePluginReactNativeExecutableExport } from './moduleNamespace';

/**
 * RN-2: the dev-hot-reload LOAD path. A development-channel, locally-sourced plugin
 * surface served by a local Re.Pack/Metro dev server (the `AccessEndpoint` URL the
 * cli projects as `loadPolicy.devUrl`). Unlike the installed-artifact path there is
 * NO materialized file and NO digest — the host loads straight from the dev URL with
 * `cache:false` so every mount re-fetches the freshly compiled bundle (the Re.Pack /
 * Expo `Script.shouldRefetch` pattern). Trust is the cli gate alone; this module is
 * never reachable in production/store builds.
 */

export type PluginReactNativeDevServerLoadInput = Readonly<{
    devUrl: string;
    pluginId: string;
    contributionId: string;
    moduleReference?: RepackInstalledArtifactModuleReference;
}>;

export type RepackDevServerModuleLoader = (input: Readonly<{
    devUrl: string;
    pluginId: string;
    contributionId: string;
    repack: RepackScriptManagerRuntimeApi;
    moduleReference?: RepackInstalledArtifactModuleReference;
}>) => Promise<PluginReactNativeExecutableExport>;

export type PluginReactNativeDevServerLoadResult =
    | Readonly<{ ok: true; module: PluginReactNativeSurfaceModule }>
    | Readonly<{
        ok: false;
        code:
            | 'loader_backend_unavailable'
            | 'dev_server_unreachable'
            | 'dev_server_compile_error'
            | 'dev_server_load_failed'
            | 'invalid_surface_module';
        diagnostics: readonly string[];
    }>;

export type PluginReactNativeDevServerExportLoadResult =
    | Readonly<{ ok: true; exported: PluginReactNativeExecutableExport }>
    | Readonly<{
        ok: false;
        code:
            | 'loader_backend_unavailable'
            | 'dev_server_unreachable'
            | 'dev_server_compile_error'
            | 'dev_server_load_failed'
            | 'invalid_executable_export';
        diagnostics: readonly string[];
    }>;

const DEV_HOT_RELOAD_BACKEND_UNAVAILABLE_DIAGNOSTIC = 'repack_script_manager_unavailable';

function sanitizeFederatedIdentifier(value: string): string {
    const normalized = value
        .trim()
        .replace(/[^A-Za-z0-9_$]/gu, '_')
        .replace(/^[^A-Za-z_$]+/u, '');
    return normalized || 'pluginReactNativeBundle';
}

function createDevServerScriptId(input: Readonly<{ pluginId: string; contributionId: string }>): string {
    return ['happier-dev-hot-reload', input.pluginId, input.contributionId]
        .map(encodeURIComponent)
        .join(':');
}

function createDevServerResolverKey(scriptId: string): string {
    return `happier-dev-hot-reload:${scriptId}`;
}

function resolveDefaultDevServerFederatedModule(
    input: Readonly<{ pluginId: string; contributionId: string }>,
): RepackInstalledArtifactModuleReference {
    return Object.freeze({
        containerName: sanitizeFederatedIdentifier(`${input.pluginId}_${input.contributionId}`),
        modulePath: './renderSurface',
        exportName: 'renderSurface',
    });
}

function assertDevServerUrl(url: string): void {
    if (!/^https?:\/\//u.test(url)) {
        throw new Error('Re.Pack dev-hot-reload resolver must resolve to an http(s) dev-server URL');
    }
}

/**
 * RN-2: build the Re.Pack-driven dev-server module loader. It registers a scoped
 * resolver that maps the dev script id to the projected dev URL with `cache:false`,
 * loads the script through ScriptManager, imports the federated `renderSurface`
 * container, and ALWAYS removes the resolver afterwards (so a failed compile never
 * leaves a stale resolver registered for the next mount).
 */
export function createRepackDevServerModuleLoader(params?: Readonly<{
    resolveFederatedModule?: (
        input: Readonly<{ pluginId: string; contributionId: string }>,
    ) => RepackInstalledArtifactModuleReference;
}>): RepackDevServerModuleLoader {
    return async ({ devUrl, pluginId, contributionId, repack, moduleReference: inputModuleReference }) => {
        assertDevServerUrl(devUrl);
        const scriptId = createDevServerScriptId({ pluginId, contributionId });
        const resolverKey = createDevServerResolverKey(scriptId);
        const resolver = async (requestedScriptId: unknown) => {
            if (requestedScriptId !== scriptId) {
                return undefined;
            }
            return Object.freeze({
                url: devUrl,
                absolute: true,
                cache: false,
            });
        };
        repack.scriptManager.addResolver(resolver, {
            key: resolverKey,
            priority: 0,
        });

        try {
            await repack.scriptManager.loadScript(scriptId);
            const moduleReference =
                inputModuleReference
                ?? params?.resolveFederatedModule?.({ pluginId, contributionId })
                ?? resolveDefaultDevServerFederatedModule({ pluginId, contributionId });
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

function readErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    if (typeof error === 'string') {
        return error;
    }
    return '';
}

/**
 * RN-2: classify a dev-server load failure into a host-loader state. A network/fetch
 * failure means the dev server is `down`; a syntax/transform failure means a `compile`
 * error; anything else is a generic load `error`. The code surfaces through the React
 * Native surface's diagnostics so the unavailable pane explains why the surface did
 * not mount.
 */
function classifyDevServerLoadError(error: unknown):
    | 'dev_server_unreachable'
    | 'dev_server_compile_error'
    | 'dev_server_load_failed' {
    const message = readErrorMessage(error).toLowerCase();
    if (
        message.includes('network request failed')
        || message.includes('failed to fetch')
        || message.includes('econnrefused')
        || message.includes('econnreset')
        || message.includes('enotfound')
        || message.includes('etimedout')
        || message.includes('timed out')
        || message.includes('connection refused')
    ) {
        return 'dev_server_unreachable';
    }
    if (
        message.includes('syntaxerror')
        || message.includes('unexpected token')
        || message.includes('transform')
        || message.includes('compil')
    ) {
        return 'dev_server_compile_error';
    }
    return 'dev_server_load_failed';
}

function devServerError(
    code: Extract<PluginReactNativeDevServerLoadResult, { ok: false }>['code'],
    diagnostics: readonly string[],
): PluginReactNativeDevServerLoadResult {
    return Object.freeze({
        ok: false,
        code,
        diagnostics: Object.freeze([...diagnostics]),
    });
}

function devServerExportError(
    code: Extract<PluginReactNativeDevServerExportLoadResult, { ok: false }>['code'],
    diagnostics: readonly string[],
): PluginReactNativeDevServerExportLoadResult {
    return Object.freeze({
        ok: false,
        code,
        diagnostics: Object.freeze([...diagnostics]),
    });
}

export async function loadPluginReactNativeDevServerExport(params: Readonly<{
    devUrl: string;
    pluginId: string;
    contributionId: string;
    moduleReference?: RepackInstalledArtifactModuleReference;
    backend: PluginReactNativeLoaderBackend;
}>): Promise<PluginReactNativeDevServerExportLoadResult> {
    const backend = params.backend;
    if (!backend.available || typeof backend.loadDevServerBundle !== 'function') {
        return devServerExportError('loader_backend_unavailable', [
            ...(backend.diagnostics?.length
                ? backend.diagnostics
                : [DEV_HOT_RELOAD_BACKEND_UNAVAILABLE_DIAGNOSTIC]),
        ]);
    }

    let exported: PluginReactNativeExecutableExport;
    try {
        exported = await backend.loadDevServerBundle({
            devUrl: params.devUrl,
            pluginId: params.pluginId,
            contributionId: params.contributionId,
            ...(params.moduleReference ? { moduleReference: params.moduleReference } : {}),
        });
    } catch (error: unknown) {
        const code = classifyDevServerLoadError(error);
        return devServerExportError(code, [code]);
    }

    if (typeof exported !== 'function') {
        return devServerExportError('invalid_executable_export', ['invalid_executable_export']);
    }
    return Object.freeze({ ok: true, exported });
}

/**
 * RN-2: load a dev-hot-reload surface module through the shared Re.Pack backend.
 * Fail-closed when the backend (or its dev-server loader) is unavailable, and map a
 * load failure to a typed compile/down/error host-loader state.
 */
export async function loadPluginReactNativeDevServerModule(params: Readonly<{
    devUrl: string;
    pluginId: string;
    contributionId: string;
    moduleReference?: RepackInstalledArtifactModuleReference;
    backend: PluginReactNativeLoaderBackend;
}>): Promise<PluginReactNativeDevServerLoadResult> {
    const loaded = await loadPluginReactNativeDevServerExport(params);
    if (!loaded.ok) {
        if (loaded.code === 'invalid_executable_export') {
            return devServerError('invalid_surface_module', ['invalid_surface_module']);
        }
        return devServerError(loaded.code, loaded.diagnostics);
    }
    const acknowledgeHostRuntime = loaded.exported.acknowledgeHostRuntime;
    return Object.freeze({
        ok: true,
        module: Object.freeze({
            renderSurface: loaded.exported as PluginReactNativeSurfaceModule['renderSurface'],
            ...(acknowledgeHostRuntime ? { acknowledgeHostRuntime } : {}),
        }),
    });
}
