import { describe, expect, it } from 'vitest';
import * as ReactJsxRuntime from 'react/jsx-runtime';
import * as ReactJsxDevRuntime from 'react/jsx-dev-runtime';

import {
    installPluginReactNativeModuleFederationHostSharedScope,
    MODULE_FEDERATION_DEFAULT_SHARE_SCOPE,
    resetPluginReactNativeModuleFederationHostSharedScopeForTesting,
    type ModuleFederationHostRuntimeGlobalScope,
} from './moduleFederationHostSharedScope';

describe('installPluginReactNativeModuleFederationHostSharedScope', () => {
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
