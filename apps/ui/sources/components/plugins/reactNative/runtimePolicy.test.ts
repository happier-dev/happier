import { describe, expect, it } from 'vitest';

import { resolvePluginReactNativeRuntimePolicy } from './runtimePolicy';

describe('React Native runtime policy', () => {
    it('allows installed artifacts only when feature, channel, build, platform, loader, and compatibility gates allow it', () => {
        expect(resolvePluginReactNativeRuntimePolicy({
            source: { kind: 'installedArtifact' },
            featureEnabled: true,
            devHotReloadEnabled: false,
            pluginSource: 'internal',
            buildChannel: 'internal',
            platform: 'ios',
            loaderBackendAvailable: true,
            compatibilityState: 'load',
            fallbackRequired: false,
        })).toEqual({
            canLoad: true,
            canHotReload: false,
            diagnostics: [],
        });
    });

    it('fails closed for remote URLs, store channel policy, missing backend, and fallback-required state', () => {
        expect(resolvePluginReactNativeRuntimePolicy({
            source: { kind: 'remoteUrl' },
            featureEnabled: true,
            devHotReloadEnabled: false,
            pluginSource: 'internal',
            buildChannel: 'internal',
            platform: 'ios',
            loaderBackendAvailable: true,
            compatibilityState: 'load',
            fallbackRequired: false,
        }).diagnostics).toContain('remote_url_unsupported');

        expect(resolvePluginReactNativeRuntimePolicy({
            source: { kind: 'installedArtifact' },
            featureEnabled: true,
            devHotReloadEnabled: false,
            pluginSource: 'marketplace',
            buildChannel: 'store',
            platform: 'ios',
            loaderBackendAvailable: true,
            compatibilityState: 'load',
            fallbackRequired: false,
        }).diagnostics).toContain('channel_denied');

        expect(resolvePluginReactNativeRuntimePolicy({
            source: { kind: 'installedArtifact' },
            featureEnabled: true,
            devHotReloadEnabled: false,
            pluginSource: 'internal',
            buildChannel: 'internal',
            platform: 'ios',
            loaderBackendAvailable: false,
            compatibilityState: 'load',
            fallbackRequired: false,
        }).diagnostics).toContain('repack_script_manager_unavailable');

        expect(resolvePluginReactNativeRuntimePolicy({
            source: { kind: 'installedArtifact' },
            featureEnabled: true,
            devHotReloadEnabled: false,
            pluginSource: 'internal',
            buildChannel: 'internal',
            platform: 'ios',
            loaderBackendAvailable: true,
            compatibilityState: 'blocked',
            fallbackRequired: true,
        }).diagnostics).toContain('fallback_required');
    });

    it('permits dev hot reload only for local development plugins behind the dev gate', () => {
        expect(resolvePluginReactNativeRuntimePolicy({
            source: { kind: 'devHotReload' },
            featureEnabled: true,
            devHotReloadEnabled: true,
            pluginSource: 'local',
            buildChannel: 'development',
            platform: 'ios',
            loaderBackendAvailable: true,
            compatibilityState: 'load',
            fallbackRequired: false,
        })).toMatchObject({
            canLoad: true,
            canHotReload: true,
        });

        expect(resolvePluginReactNativeRuntimePolicy({
            source: { kind: 'devHotReload' },
            featureEnabled: true,
            devHotReloadEnabled: true,
            pluginSource: 'marketplace',
            buildChannel: 'development',
            platform: 'ios',
            loaderBackendAvailable: true,
            compatibilityState: 'load',
            fallbackRequired: false,
        }).diagnostics).toContain('dev_hot_reload_denied');
    });
});
