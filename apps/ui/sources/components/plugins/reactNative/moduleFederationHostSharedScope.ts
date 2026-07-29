import * as React from 'react';
import * as ReactJsxRuntime from 'react/jsx-runtime';
import * as ReactJsxDevRuntime from 'react/jsx-dev-runtime';
import * as ReactNative from 'react-native';

import {
    PLUGIN_UI_HOST_REACT_RUNTIME_EXTERNAL_SPECIFIERS,
    type PluginUiHostReactRuntimeExternalSpecifierV1,
} from '@happier-dev/protocol/plugins/ui';

// Metro's own asset graph does not reliably serve `./package.json` subpath
// imports for every dependency at RUNTIME the way Node/Vite's bundler-time
// resolvers do (verified: Vitest's JSON-import resolution for
// `react-native/package.json` fails in this workspace despite Node's own
// `require.resolve` succeeding). Pinned to apps/ui's own declared
// dependency versions (`apps/ui/package.json`) instead — MF's share-scope
// version key only needs to be a stable, unique string the host and the
// (`singleton:true`) remote agree exists; it does not need to be read from
// the package at runtime. Kept in lockstep with `package.json` intentionally
// (not derived) so a dependency bump is a visible, reviewed diff here too.
const HOST_REACT_VERSION = '19.2.0';
const HOST_REACT_NATIVE_VERSION = '0.83.4';

/**
 * RN-HARDEN (IOS-REBUILD residual — "Host MF share scope + per-artifact chunk
 * resolver are QA-only today"): productizes the Module Federation share scope
 * the native Re.Pack `ScriptManager` pipeline needs.
 *
 * `Federated.importModule` (`@callstack/repack/client`) reads two runtime
 * globals a webpack/rspack-bundled HOST app normally injects itself via
 * `ModuleFederationPlugin`'s host-side runtime code:
 * `__webpack_init_sharing__` (creates/returns a named share scope) and
 * `__webpack_share_scopes__` (the scope registry a remote container's
 * `container.init(shareScope)` consumes to resolve its own declared exact
 * React runtime closure plus `react-native` singleton against —
 * see `packages/plugins/inspector/rspack.config.mjs`'s `shared` map).
 *
 * This app's HOST bundle is built by METRO, not webpack/rspack, so neither
 * global exists natively — IOS-REBUILD's live capstone proof
 * (`federated.importModule(...)` returning a real `InspectorSurface` element)
 * only worked because that QA lane hand-injected an equivalent share scope at
 * runtime via the Metro module registry (ephemeral, gone on reload, never
 * committed). This module is that wiring, productized: a real, tested,
 * idempotent host-boot installer wired from `scriptManagerBoot.ts` (the same
 * one-time native-boot chokepoint that installs Re.Pack's own
 * `__repack__`/`__webpack_require__.repack` shared registry) instead of a
 * QA-only hack.
 *
 * Mirrors `../shared/hostRuntimeExternals.ts`'s web-loader externals
 * installer: the SAME exact React runtime namespaces and `react-native`
 * instance the host app itself renders with are handed to remote containers,
 * so a plugin's React surface shares one React closure across the
 * module-federation boundary.
 *
 * Other native host-provided modules remain additive and must be paired with
 * a real remote consumer before they are added here.
 */

export const MODULE_FEDERATION_DEFAULT_SHARE_SCOPE = 'default';

type ModuleFederationSharedModuleFactory = () => unknown;

type ModuleFederationSharedModuleVersionEntry = Readonly<{
    get: () => Promise<ModuleFederationSharedModuleFactory>;
    loaded: 1;
    eager: false;
    strategy: 'version-first';
}>;

type ModuleFederationShareScopeEntries = Record<string, Record<string, ModuleFederationSharedModuleVersionEntry>>;

type ModuleFederationShareScopeRegistry = Record<
    string,
    ModuleFederationShareScopeEntries & { __isInitialized?: boolean }
>;

export type ModuleFederationHostRuntimeGlobalScope = {
    __webpack_share_scopes__?: ModuleFederationShareScopeRegistry;
    __webpack_init_sharing__?: (scope: string) => Promise<void>;
};

type HostSharedModuleProvider = Readonly<{
    name: string;
    version: string;
    getModule: () => unknown;
}>;

const HOST_REACT_RUNTIME_MODULES = Object.freeze({
    react: React,
    'react/jsx-runtime': ReactJsxRuntime,
    'react/jsx-dev-runtime': ReactJsxDevRuntime,
} satisfies Record<PluginUiHostReactRuntimeExternalSpecifierV1, unknown>);

const HOST_SHARED_MODULE_PROVIDERS: readonly HostSharedModuleProvider[] = Object.freeze([
    ...PLUGIN_UI_HOST_REACT_RUNTIME_EXTERNAL_SPECIFIERS.map((name) => Object.freeze({
        name,
        version: HOST_REACT_VERSION,
        getModule: () => HOST_REACT_RUNTIME_MODULES[name],
    })),
    Object.freeze({ name: 'react-native', version: HOST_REACT_NATIVE_VERSION, getModule: () => ReactNative }),
]);

function createHostSharedScopeEntries(): ModuleFederationShareScopeEntries {
    const entries: Record<string, Record<string, ModuleFederationSharedModuleVersionEntry>> = {};
    for (const provider of HOST_SHARED_MODULE_PROVIDERS) {
        entries[provider.name] = {
            [provider.version]: Object.freeze({
                get: async () => () => provider.getModule(),
                loaded: 1 as const,
                eager: false as const,
                strategy: 'version-first' as const,
            }),
        };
    }
    return entries;
}

let installed = false;

function resolveRealGlobalThis(): ModuleFederationHostRuntimeGlobalScope {
    return globalThis as unknown as ModuleFederationHostRuntimeGlobalScope;
}

/**
 * Idempotent: safe to call on every ScriptManager boot. Installs
 * `__webpack_init_sharing__` / `__webpack_share_scopes__` so
 * `Federated.importModule` can initialize a share scope and a remote
 * container can resolve its declared `shared` singletons against the host's
 * own `react`/`react-native` instances.
 */
export function installPluginReactNativeModuleFederationHostSharedScope(
    globalScope: ModuleFederationHostRuntimeGlobalScope = resolveRealGlobalThis(),
): void {
    const isRealGlobalThis = globalScope === resolveRealGlobalThis();
    if (installed && isRealGlobalThis) {
        return;
    }

    if (!globalScope.__webpack_share_scopes__) {
        globalScope.__webpack_share_scopes__ = {};
    }
    const shareScopes = globalScope.__webpack_share_scopes__;

    globalScope.__webpack_init_sharing__ = async (scope: string) => {
        if (!shareScopes[scope]) {
            shareScopes[scope] = createHostSharedScopeEntries();
        }
    };

    if (isRealGlobalThis) {
        installed = true;
    }
}

/** Test-only: reset the module-level idempotency guard between specs. */
export function resetPluginReactNativeModuleFederationHostSharedScopeForTesting(): void {
    installed = false;
}
