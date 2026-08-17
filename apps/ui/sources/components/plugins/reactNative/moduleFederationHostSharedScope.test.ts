import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import * as ReactJsxRuntime from 'react/jsx-runtime';
import * as ReactJsxDevRuntime from 'react/jsx-dev-runtime';

import { PLUGIN_UI_HOST_NATIVE_RUNTIME_EXTERNAL_SPECIFIERS } from '@happier-dev/protocol/plugins/ui';

import {
    installPluginReactNativeModuleFederationHostSharedScope,
    MODULE_FEDERATION_DEFAULT_SHARE_SCOPE,
    resetPluginReactNativeModuleFederationHostSharedScopeForTesting,
    type ModuleFederationHostRuntimeGlobalScope,
} from './moduleFederationHostSharedScope';

describe('installPluginReactNativeModuleFederationHostSharedScope', () => {
    // EU-6 / UI-D14 closure. The Re.Pack build preset externalizes every
    // specifier in the protocol-owned native closure with `import:false` — the
    // plugin bundle contains NO fallback copy — so a specifier the host does
    // not put in the share scope is a promise that can only fail on device.
    // This is the check that makes the two ends derive from one source: adding
    // a specifier to `PLUGIN_UI_HOST_NATIVE_RUNTIME_EXTERNAL_SPECIFIERS` alone
    // fails here (and at typecheck, via the host provider table's `satisfies`).
    it('publishes exactly the specifiers the native build externalizes — no more, no fewer', async () => {
        const fakeGlobal: ModuleFederationHostRuntimeGlobalScope = {};
        installPluginReactNativeModuleFederationHostSharedScope(fakeGlobal);

        await fakeGlobal.__webpack_init_sharing__?.(MODULE_FEDERATION_DEFAULT_SHARE_SCOPE);
        const scope = fakeGlobal.__webpack_share_scopes__?.[MODULE_FEDERATION_DEFAULT_SHARE_SCOPE] ?? {};

        const unprovided = PLUGIN_UI_HOST_NATIVE_RUNTIME_EXTERNAL_SPECIFIERS.filter(
            (specifier) => scope[specifier] === undefined,
        );
        expect(unprovided).toEqual([]);

        // …and nothing extra: an unlisted share-scope entry is a second,
        // undeclared closure the build never externalized.
        expect(Object.keys(scope).sort()).toEqual([...PLUGIN_UI_HOST_NATIVE_RUNTIME_EXTERNAL_SPECIFIERS].sort());
    });

    // A published KEY is not a provided module: `HOST_SHARED_MODULE_PROVIDERS`
    // maps over the specifier list, so an entry whose host namespace is missing
    // still appears in the scope and resolves to `undefined` — a remote would
    // then consume `undefined` as its React Navigation. This is the assertion
    // that actually fails when a specifier is added to the protocol list alone.
    it('resolves each externalized specifier to the host app\'s own module instance', async () => {
        const fakeGlobal: ModuleFederationHostRuntimeGlobalScope = {};
        installPluginReactNativeModuleFederationHostSharedScope(fakeGlobal);
        await fakeGlobal.__webpack_init_sharing__?.(MODULE_FEDERATION_DEFAULT_SHARE_SCOPE);
        const scope = fakeGlobal.__webpack_share_scopes__?.[MODULE_FEDERATION_DEFAULT_SHARE_SCOPE] ?? {};

        for (const specifier of PLUGIN_UI_HOST_NATIVE_RUNTIME_EXTERNAL_SPECIFIERS) {
            const versions = Object.keys(scope[specifier] ?? {});
            expect(versions).toHaveLength(1);
            const factory = await scope[specifier]?.[versions[0] as string]?.get();
            const namespace = factory?.();
            expect(namespace, `${specifier} resolved to no module namespace`).toBeTruthy();
        }

        const navigationVersions = Object.keys(scope['@react-navigation/native'] ?? {});
        const navigationFactory = await scope['@react-navigation/native']
            ?.[navigationVersions[0] as string]?.get();
        expect((navigationFactory?.() as { NavigationContainer?: unknown }).NavigationContainer).toBeDefined();

        const stackVersions = Object.keys(scope['@react-navigation/native-stack'] ?? {});
        const stackFactory = await scope['@react-navigation/native-stack']
            ?.[stackVersions[0] as string]?.get();
        expect((stackFactory?.() as { createNativeStackNavigator?: unknown }).createNativeStackNavigator)
            .toBeTypeOf('function');
    });

    // The share-scope version keys are deliberately hand-declared next to the
    // providers (Metro cannot reliably serve `<dep>/package.json` at runtime),
    // and their module doc claims they are kept in lockstep with
    // `apps/ui/package.json`. That claim had already drifted silently
    // (`react-native` was declared `0.83.5` and published here as `0.83.4`),
    // so the lockstep is asserted rather than trusted.
    it('publishes each shared module under the version apps/ui declares for it', async () => {
        const packageJson = JSON.parse(readFileSync(
            fileURLToPath(new URL('../../../../package.json', import.meta.url)),
            'utf8',
        )) as { dependencies?: Record<string, string> };
        const declared = packageJson.dependencies ?? {};

        const fakeGlobal: ModuleFederationHostRuntimeGlobalScope = {};
        installPluginReactNativeModuleFederationHostSharedScope(fakeGlobal);
        await fakeGlobal.__webpack_init_sharing__?.(MODULE_FEDERATION_DEFAULT_SHARE_SCOPE);
        const scope = fakeGlobal.__webpack_share_scopes__?.[MODULE_FEDERATION_DEFAULT_SHARE_SCOPE] ?? {};

        for (const specifier of PLUGIN_UI_HOST_NATIVE_RUNTIME_EXTERNAL_SPECIFIERS) {
            // React's JSX subpaths are the same package as `react`.
            const packageName = specifier.startsWith('react/') ? 'react' : specifier;
            const declaredRange = declared[packageName];
            expect(declaredRange, `apps/ui does not declare ${packageName} it hands to plugin bundles`)
                .toBeTypeOf('string');
            const [publishedVersion] = Object.keys(scope[specifier] ?? {});
            expect(publishedVersion, `${specifier} has no share-scope version`).toBeTypeOf('string');
            expect(
                (declaredRange as string).replace(/^[\^~]/u, ''),
                `${specifier} share-scope version drifted from apps/ui/package.json`,
            ).toBe(publishedVersion);
        }
    });

    it('installs __webpack_init_sharing__ / __webpack_share_scopes__ into an injected global scope', async () => {
        const fakeGlobal: ModuleFederationHostRuntimeGlobalScope = {};

        installPluginReactNativeModuleFederationHostSharedScope(fakeGlobal);

        expect(typeof fakeGlobal.__webpack_init_sharing__).toBe('function');
        expect(fakeGlobal.__webpack_share_scopes__).toEqual({});
    });

    it('__webpack_init_sharing__ populates the named scope with the host react/react-native singletons', async () => {
        const fakeGlobal: ModuleFederationHostRuntimeGlobalScope = {};
        installPluginReactNativeModuleFederationHostSharedScope(fakeGlobal);

        await fakeGlobal.__webpack_init_sharing__?.(MODULE_FEDERATION_DEFAULT_SHARE_SCOPE);

        const scope = fakeGlobal.__webpack_share_scopes__?.[MODULE_FEDERATION_DEFAULT_SHARE_SCOPE];
        expect(scope).toBeDefined();
        expect(Object.keys(scope ?? {})).toEqual(expect.arrayContaining([
            'react',
            'react/jsx-runtime',
            'react/jsx-dev-runtime',
            'react-native',
        ]));

        const reactVersions = Object.keys(scope?.react ?? {});
        expect(reactVersions).toHaveLength(1);
        const reactEntry = scope?.react?.[reactVersions[0] as string];
        expect(reactEntry).toMatchObject({ loaded: 1, eager: false });
        const reactFactory = await reactEntry?.get();
        const reactModule = reactFactory?.() as { createElement?: unknown };
        expect(typeof reactModule?.createElement).toBe('function');

        const jsxRuntimeEntry = scope?.['react/jsx-runtime']?.[reactVersions[0] as string];
        const jsxRuntimeFactory = await jsxRuntimeEntry?.get();
        expect(jsxRuntimeFactory?.()).toBe(ReactJsxRuntime);

        const jsxDevRuntimeEntry = scope?.['react/jsx-dev-runtime']?.[reactVersions[0] as string];
        const jsxDevRuntimeFactory = await jsxDevRuntimeEntry?.get();
        expect(jsxDevRuntimeFactory?.()).toBe(ReactJsxDevRuntime);

        const reactNativeVersions = Object.keys(scope?.['react-native'] ?? {});
        expect(reactNativeVersions).toHaveLength(1);
        const reactNativeEntry = scope?.['react-native']?.[reactNativeVersions[0] as string];
        const reactNativeFactory = await reactNativeEntry?.get();
        const reactNativeModule = reactNativeFactory?.() as { View?: unknown };
        expect(reactNativeModule?.View).toBeDefined();
    });

    it('does not reinitialize an already-initialized scope', async () => {
        const fakeGlobal: ModuleFederationHostRuntimeGlobalScope = {};
        installPluginReactNativeModuleFederationHostSharedScope(fakeGlobal);
        await fakeGlobal.__webpack_init_sharing__?.(MODULE_FEDERATION_DEFAULT_SHARE_SCOPE);
        const scope = fakeGlobal.__webpack_share_scopes__?.[MODULE_FEDERATION_DEFAULT_SHARE_SCOPE];
        // Mirror federated.js's own post-init step, which the real
        // `Federated.importModule` performs after awaiting our installed
        // `__webpack_init_sharing__`.
        (scope as Record<string, unknown>).__isInitialized = true;

        await fakeGlobal.__webpack_init_sharing__?.(MODULE_FEDERATION_DEFAULT_SHARE_SCOPE);

        expect(fakeGlobal.__webpack_share_scopes__?.[MODULE_FEDERATION_DEFAULT_SHARE_SCOPE]).toBe(scope);
    });

    it('is idempotent on the real globalThis — a second call does not replace the installed scope registry', () => {
        resetPluginReactNativeModuleFederationHostSharedScopeForTesting();
        try {
            installPluginReactNativeModuleFederationHostSharedScope();
            const first = (globalThis as unknown as ModuleFederationHostRuntimeGlobalScope).__webpack_share_scopes__;
            installPluginReactNativeModuleFederationHostSharedScope();
            const second = (globalThis as unknown as ModuleFederationHostRuntimeGlobalScope).__webpack_share_scopes__;
            expect(second).toBe(first);
        } finally {
            resetPluginReactNativeModuleFederationHostSharedScopeForTesting();
            delete (globalThis as unknown as ModuleFederationHostRuntimeGlobalScope).__webpack_share_scopes__;
            delete (globalThis as unknown as ModuleFederationHostRuntimeGlobalScope).__webpack_init_sharing__;
        }
    });
});
