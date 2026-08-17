import {
    decodeWebModuleSource,
    hasForbiddenWebModuleImport,
    importWebModuleFromBytesViaBlobUrl,
    type PluginWebModuleNamespace,
} from '../shared/webModuleLoader';
import { installPluginUiHostRuntimeExternalsGlobal } from '../shared/hostRuntimeExternals';
import type {
    PluginReactNativeLoaderBackend,
    PluginReactNativeExecutableModuleReference,
} from './loader';
import type { PluginReactNativeExecutableExport } from './loader';
import { resolvePluginReactNativeExecutableExport } from './moduleNamespace';

/**
 * RN-WEB-LOADER item 4 — the web-target `reactNative` mode loader backend
 * (LEDGER DEC-6: `reactNative` mode also renders on web). Per RNWEB-SPIKE
 * §Q1(e): `nativeRepackClientResolver.ts` fails closed on web by design
 * (Re.Pack's ScriptManager is a native-JS-engine delivery mechanism with no
 * web build target); this is the WEB counterpart, selected instead of the
 * repack backend when `Platform.OS === 'web'` (see
 * `resolveDefaultReactNativeLoaderBackend.web.ts`).
 *
 * Same `PluginReactNativeLoaderBackend` contract (`loadInstalledBundle` /
 * `loadDevServerBundle` -> `PluginReactNativeSurfaceModule`), different
 * mechanism: in-process `import()` of a Vite + react-native-web-built module
 * (`reactNativeWebBuild.ts`'s preset), reusing the shared web-module
 * guard/instantiate machinery.
 *
 * Isolation note: same-realm, in-process JS — no iframe/WebView sandbox
 * boundary. This mode retains fail-closed feature and integrity checks.
 *
 * The bundle contract is identical to native Re.Pack's: the source exports the
 * manifest-configured named executable (`renderSurface` by default) — no
 * factory wrapper. Singleton sharing happens via the virtual-module host
 * runtime global (item 1), not a factory-injection parameter, so a
 * `reactNative`-mode plugin author writes ONE contract for every platform.
 */

function loaderError(code: string, diagnostics: readonly string[]): Error {
    return Object.assign(new Error(code), { code, diagnostics: Object.freeze([...diagnostics]) });
}

function resolveReactNativeWebExecutableExport(
    namespace: PluginWebModuleNamespace,
    moduleReference?: PluginReactNativeExecutableModuleReference,
): PluginReactNativeExecutableExport {
    const exportName = moduleReference?.exportName ?? 'renderSurface';
    const exported = resolvePluginReactNativeExecutableExport(namespace, exportName);
    if (exported) {
        return exported;
    }
    throw loaderError('invalid_surface_module', ['invalid_surface_module']);
}

async function instantiateReactNativeWebModule(
    bytes: Uint8Array,
    moduleReference: PluginReactNativeExecutableModuleReference | undefined,
    importModule: (url: string) => Promise<PluginWebModuleNamespace>,
): Promise<PluginReactNativeExecutableExport> {
    installPluginUiHostRuntimeExternalsGlobal();

    if (hasForbiddenWebModuleImport(decodeWebModuleSource(bytes))) {
        throw loaderError('forbidden_import', ['app_internal_or_host_external_import_denied']);
    }

    let namespace: PluginWebModuleNamespace;
    try {
        namespace = await importWebModuleFromBytesViaBlobUrl(bytes, importModule);
    } catch {
        throw loaderError('module_instantiation_failed', ['module_instantiation_failed']);
    }

    return resolveReactNativeWebExecutableExport(namespace, moduleReference);
}

export function createReactNativeWebLoaderBackend(params?: Readonly<{
    importModule?: (url: string) => Promise<PluginWebModuleNamespace>;
}>): PluginReactNativeLoaderBackend {
    const importModule = params?.importModule
        ?? ((url: string) => import(/* @vite-ignore */ /* webpackIgnore: true */ url) as Promise<PluginWebModuleNamespace>);

    if (typeof Blob === 'undefined' || typeof URL === 'undefined') {
        return Object.freeze({
            backendId: 'reactNativeWebModule',
            available: false,
            unavailableReason: 'Blob/URL module import is unavailable in this JS engine',
            diagnostics: Object.freeze(['reactnative_web_loader_backend_unavailable']),
        });
    }

    return Object.freeze({
        backendId: 'reactNativeWebModule',
        available: true,
        diagnostics: Object.freeze([]),
        loadInstalledBundle: async (input) => instantiateReactNativeWebModule(input.bytes, input.moduleReference, importModule),
        loadDevServerBundle: async (input) => {
            // Dev-hot-reload source: fetch the freshly compiled module straight
            // from the projected local dev-server URL — no materialized
            // artifact, no digest (mirrors RN native's dev-server load path;
            // trust is the CLI gate alone, per `devLoader.ts`'s doc comment).
            if (!/^https?:\/\//u.test(input.devUrl)) {
                throw loaderError('dev_server_load_failed', ['dev_server_load_failed']);
            }
            installPluginUiHostRuntimeExternalsGlobal();
            let namespace: PluginWebModuleNamespace;
            try {
                namespace = await importModule(input.devUrl);
            } catch {
                throw loaderError('dev_server_unreachable', ['dev_server_unreachable']);
            }
            return resolveReactNativeWebExecutableExport(namespace, input.moduleReference);
        },
    });
}
