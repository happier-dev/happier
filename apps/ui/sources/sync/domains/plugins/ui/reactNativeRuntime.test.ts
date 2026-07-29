import { describe, expect, it } from 'vitest';

import {
    derivePluginReactNativeBundleCacheIdentity,
    derivePluginReactNativeBundleCacheKey,
    resolvePluginReactNativeBundleRuntimeDecision,
} from './reactNativeRuntime';

const host = {
    hostAppVersion: '2.0.0',
    hostUiApiVersion: '1.0.0',
    reactVersion: '19.0.0',
    reactNativeVersion: '0.83.4',
    expoRuntimeVersion: '0.2.0-native',
    hermesVersion: '0.15.0',
    platform: 'ios',
    channel: 'internal',
    availableNativeCapabilities: ['clipboard'],
    featureState: 'enabled',
    crashThreshold: 3,
} as const;

const bundle = {
    pluginId: 'acme.preview',
    contributionId: 'native-preview',
    artifactDigest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    compatibility: {
        hostUiApiVersion: '1.0.0',
        reactVersion: '19.0.0',
        reactNativeVersion: '0.83.4',
        expoRuntimeVersion: '0.2.0-native',
        hermesVersion: '0.15.0',
        supportedPlatforms: ['ios'],
        supportedChannels: ['internal'],
        requiredNativeCapabilities: ['clipboard'],
    },
    fallback: { kind: 'hostedWeb', contributionId: 'preview-web' },
} as const;

describe('React Native runtime sync domain', () => {
    it('resolves fail-closed runtime decisions from projection state', () => {
        expect(resolvePluginReactNativeBundleRuntimeDecision({
            host,
            bundle,
            previousCrashCount: 0,
        })).toMatchObject({ state: 'load', reason: 'compatible' });

        expect(resolvePluginReactNativeBundleRuntimeDecision({
            host: { ...host, channel: 'store' },
            bundle,
            previousCrashCount: 0,
        })).toMatchObject({ state: 'fallback', reason: 'channel_policy_denied' });
    });

    it('derives cache identity from plugin, artifact, host runtime, platform, channel, and capabilities digest', () => {
        const identity = derivePluginReactNativeBundleCacheIdentity({
            host,
            bundle,
            nativeCapabilitiesDigest: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
            projectionGeneration: 12,
        });

        expect(identity).toEqual({
            pluginId: 'acme.preview',
            contributionId: 'native-preview',
            artifactDigest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            hostAppVersion: '2.0.0',
            hostUiApiVersion: '1.0.0',
            reactVersion: '19.0.0',
            reactNativeVersion: '0.83.4',
            expoRuntimeVersion: '0.2.0-native',
            hermesVersion: '0.15.0',
            platform: 'ios',
            channel: 'internal',
            nativeCapabilitiesDigest: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
            projectionGeneration: 12,
        });
        expect(derivePluginReactNativeBundleCacheKey(identity)).toContain('sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc');
        expect(derivePluginReactNativeBundleCacheKey(identity)).toContain(':12');
    });
});
