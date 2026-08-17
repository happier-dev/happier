import * as React from 'react';
import * as ReactJsxRuntime from 'react/jsx-runtime';
import * as ReactJsxDevRuntime from 'react/jsx-dev-runtime';
import * as ReactNative from 'react-native';
import * as ReactNativeReanimated from 'react-native-reanimated';
import * as ReactNavigationNative from '@react-navigation/native';
import * as ReactNavigationNativeStack from '@react-navigation/native-stack';

import {
    PLUGIN_UI_HOST_NATIVE_RUNTIME_EXTERNAL_SPECIFIERS,
    type PluginUiHostNativeRuntimeExternalModulesV1,
    type PluginUiHostNativeRuntimeExternalSpecifierV1,
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
//
// EU-6: the lockstep is now ENFORCED rather than aspirational —
// `moduleFederationHostSharedScope.test.ts` reads `apps/ui/package.json` and
// fails when a declared range no longer admits the version below. It had
// already drifted silently (`react-native` was pinned here at `0.83.4` while
// the app declared `0.83.5`).
const HOST_SHARED_MODULE_VERSIONS = Object.freeze({
    react: '19.2.0',
    'react-native': '0.83.5',
    'react-native-reanimated': '4.3.0',
    '@react-navigation/native': '7.2.4',
    '@react-navigation/native-stack': '7.14.5',
} as const);

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
 * see `packages/plugin-sdk/src/ui/reactNativeBuild.ts`'s builder-owned
 * `createReactNativeRepackSharedModules()` map).
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
 * installer: the SAME exact module namespaces the host app itself renders with
 * are handed to remote containers, so a plugin's React, navigation and
 * animation surfaces share one closure across the module-federation boundary.
 *
 * EU-6: the specifier list is NOT decided here. It is
 * `PLUGIN_UI_HOST_NATIVE_RUNTIME_EXTERNAL_SPECIFIERS`
 * (`packages/protocol/src/plugins/ui/hostRuntimeExternals.ts`), the same owner
 * `packages/plugin-sdk`'s Re.Pack build preset derives its `external` list and
 * `import:false` Module Federation `shared` map from. Adding a module to that
 * list alone breaks this file's `satisfies` — which is the point: the two ends
 * previously drifted (UI-D14) and shipped externalized Reanimated/React
 * Navigation the host never provided. Only the share-scope VERSION keys are
 * owned here, in lockstep with `apps/ui/package.json`.
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

/**
 * EU-6 closure: every specifier the Re.Pack build preset externalizes with
 * `import:false` resolves HERE, to the host app's own module instance. The
 * `satisfies` binds this table to the protocol-owned specifier list, so adding
 * a specifier to `PLUGIN_UI_HOST_NATIVE_RUNTIME_EXTERNAL_SPECIFIERS` alone
 * fails to compile here instead of shipping an unprovidable promise (UI-D14).
 */
const HOST_NATIVE_RUNTIME_MODULES = Object.freeze({
    react: React,
    'react/jsx-runtime': ReactJsxRuntime,
    'react/jsx-dev-runtime': ReactJsxDevRuntime,
    'react-native': ReactNative,
    'react-native-reanimated': ReactNativeReanimated,
    '@react-navigation/native': ReactNavigationNative,
    '@react-navigation/native-stack': ReactNavigationNativeStack,
} satisfies PluginUiHostNativeRuntimeExternalModulesV1);

/**
 * The share-scope version key each specifier is published under. React's three
 * runtime subpaths are one package, so they share React's version.
 */
function readHostSharedModuleVersion(specifier: PluginUiHostNativeRuntimeExternalSpecifierV1): string {
    switch (specifier) {
        case 'react':
        case 'react/jsx-runtime':
        case 'react/jsx-dev-runtime':
            return HOST_SHARED_MODULE_VERSIONS.react;
        default:
            return HOST_SHARED_MODULE_VERSIONS[specifier];
    }
}

const HOST_SHARED_MODULE_PROVIDERS: readonly HostSharedModuleProvider[] = Object.freeze(
    PLUGIN_UI_HOST_NATIVE_RUNTIME_EXTERNAL_SPECIFIERS.map((name) => Object.freeze({
        name,
        version: readHostSharedModuleVersion(name),
        getModule: () => HOST_NATIVE_RUNTIME_MODULES[name],
    })),
);

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
