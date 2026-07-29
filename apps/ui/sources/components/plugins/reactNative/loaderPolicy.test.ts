import { describe, expect, it } from 'vitest';

import {
    resolvePluginReactNativeLoaderPolicy,
    type PluginReactNativeLoaderPolicyInput,
} from './loaderPolicy';

describe('plugin React Native loader policy', () => {
    it('admits daemon-selected installed artifacts without recomputing daemon or backend policy', () => {
        expect(resolvePluginReactNativeLoaderPolicy({
            source: 'installedArtifact',
        })).toEqual({
            canLoad: true,
            diagnostics: [],
        });
    });

    it('loads daemon-authorized dev hot reload only when its projected URL is present', () => {
        expect(resolvePluginReactNativeLoaderPolicy({
            source: 'devHotReload',
        })).toEqual({
            canLoad: false,
            diagnostics: ['dev_hot_reload_dev_url_missing'],
        });

        expect(resolvePluginReactNativeLoaderPolicy({
            source: 'devHotReload',
            devUrl: 'http://127.0.0.1:8082/bundle',
        })).toEqual({
            canLoad: true,
            diagnostics: [],
        });
    });

    it('rejects the retired external dynamic bundle policy even when its legacy trust flags are true', () => {
        const retiredExternalPolicy = {
            source: 'externalDynamicBundle',
            dynamicLoadingEnabled: true,
            signatureVerified: true,
            channelAllowed: true,
        } as unknown as PluginReactNativeLoaderPolicyInput;

        expect(resolvePluginReactNativeLoaderPolicy(retiredExternalPolicy)).toEqual({
            canLoad: false,
            diagnostics: ['unsupported_loader_source'],
        });
    });
});
