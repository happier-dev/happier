import { describe, expect, it } from 'vitest';

import { createPluginReactNativeBundleCache } from './bundleCache';
import { applyPluginReactNativeHotReloadInvalidation } from './hotReload';

const identity = {
    pluginId: 'acme.preview',
    contributionId: 'native-preview',
    artifactDigest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    hostAppVersion: '2.0.0',
    hostUiApiVersion: '1.0.0',
    reactVersion: '19.0.0',
    reactNativeVersion: '0.83.4',
    platform: 'ios',
    channel: 'development',
    nativeCapabilitiesDigest: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    projectionGeneration: 12,
} as const;

describe('React Native dev hot reload invalidation', () => {
    it('evicts installed executable bytes only for local development plugins behind the dev gate', () => {
        const cache = createPluginReactNativeBundleCache();
        cache.putInstalledArtifact({
            identity,
            bytes: new Uint8Array([47, 47, 32, 98, 117, 110, 100, 108, 101]),
            format: 'plainJs',
        });

        expect(applyPluginReactNativeHotReloadInvalidation({
            cache,
            identity,
            devHotReloadEnabled: true,
            pluginSource: 'local',
            channel: 'development',
        })).toEqual({
            invalidated: true,
            diagnostics: [],
        });
        expect(cache.readInstalledArtifact(identity)).toBeNull();
    });

    it('denies marketplace hot reload without evicting a valid installed artifact', () => {
        const cache = createPluginReactNativeBundleCache();
        cache.putInstalledArtifact({
            identity,
            bytes: new Uint8Array([47, 47, 32, 98, 117, 110, 100, 108, 101]),
            format: 'plainJs',
        });

        expect(applyPluginReactNativeHotReloadInvalidation({
            cache,
            identity,
            devHotReloadEnabled: true,
            pluginSource: 'marketplace',
            channel: 'development',
        })).toEqual({
            invalidated: false,
            diagnostics: ['dev_hot_reload_denied'],
        });
        expect(cache.readInstalledArtifact(identity)).not.toBeNull();
    });
});
