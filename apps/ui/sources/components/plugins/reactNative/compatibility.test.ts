import { describe, expect, it } from 'vitest';

import { resolvePluginReactNativeBundleCompatibility } from './compatibility';

const host = {
    hostAppVersion: '2.0.0',
    hostUiApiVersion: '1.0.0',
    reactVersion: '19.0.0',
    reactNativeVersion: '0.79.0',
    expoRuntimeVersion: '1.0.0',
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
    artifactDigest: 'sha256:bundle',
    compatibility: {
        hostUiApiVersion: '1.0.0',
        reactVersion: '19.0.0',
        reactNativeVersion: '0.79.0',
        expoRuntimeVersion: '1.0.0',
        hermesVersion: '0.15.0',
        supportedPlatforms: ['ios'],
        supportedChannels: ['internal'],
        requiredNativeCapabilities: ['clipboard'],
    },
    fallback: { kind: 'hostedWeb', contributionId: 'preview-web' },
} as const;

describe('plugin React Native compatibility decisions', () => {
    it('loads only when runtime, channel, platform, capabilities, feature state, and crash state match', () => {
        expect(resolvePluginReactNativeBundleCompatibility({
            host,
            bundle,
            previousCrashCount: 0,
            revokedDigests: new Set(),
        })).toMatchObject({ state: 'load', reason: 'compatible' });
    });

    it('resolves fallback for channel policy, missing native capability, revoked artifact, and crash threshold failures', () => {
        expect(resolvePluginReactNativeBundleCompatibility({
            host: { ...host, channel: 'store' },
            bundle,
            previousCrashCount: 0,
            revokedDigests: new Set(),
        })).toMatchObject({ state: 'fallback', reason: 'channel_policy_denied' });

        expect(resolvePluginReactNativeBundleCompatibility({
            host: { ...host, availableNativeCapabilities: [] },
            bundle,
            previousCrashCount: 0,
            revokedDigests: new Set(),
        })).toMatchObject({ state: 'fallback', reason: 'missing_native_capability' });

        expect(resolvePluginReactNativeBundleCompatibility({
            host,
            bundle,
            previousCrashCount: 0,
            revokedDigests: new Set(['sha256:bundle']),
        })).toMatchObject({ state: 'blocked', reason: 'artifact_revoked' });

        expect(resolvePluginReactNativeBundleCompatibility({
            host,
            bundle,
            previousCrashCount: 3,
            revokedDigests: new Set(),
        })).toMatchObject({ state: 'disabled', reason: 'crash_disabled' });
    });
});
