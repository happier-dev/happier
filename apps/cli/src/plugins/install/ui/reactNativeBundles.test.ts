import { describe, expect, it } from 'vitest';

import {
    classifyReactNativeBundleArtifactSource,
    deriveReactNativeNativeCapabilitiesDigest,
    validateInstalledReactNativeBundleArtifact,
    type ReactNativeBundleHostRuntime,
} from './reactNativeBundles';

const hostRuntime = {
    hostAppVersion: '2.0.0',
    hostUiApiVersion: '1.0.0',
    reactVersion: '19.0.0',
    reactNativeVersion: '0.83.4',
    expoRuntimeVersion: '0.2.0-native',
    hermesVersion: '0.15.0',
    platform: 'ios',
    channel: 'internal',
    availableNativeCapabilities: ['clipboard', 'haptics'],
    projectionGeneration: 12,
} as const;
const ARTIFACT_DIGEST = `sha256:${'b'.repeat(64)}`;

const artifact = {
    id: 'native-preview-ios',
    pluginId: 'acme.preview',
    contributionId: 'native-preview',
    contributionFamily: 'reactNativeBundles',
    artifactKind: 'reactNativeBundle',
    platform: 'ios',
    channel: 'internal',
    integrity: { digest: ARTIFACT_DIGEST },
    compatibility: {
        hostAppVersion: '2.0.0',
        hostUiApiVersion: '1.0.0',
        reactVersion: '19.0.0',
        reactNativeVersion: '0.83.4',
        expoRuntimeVersion: '0.2.0-native',
        hermesVersion: '0.15.0',
        supportedChannels: ['internal'],
        nativeCapabilities: ['haptics', 'clipboard'],
    },
    byteSize: 1024,
    contentType: 'application/javascript',
    assetPath: 'react-native/native-preview/ios.bundle.js',
} as const;

describe('React Native bundle install validation', () => {
    it('accepts digest-bound installed plain-JS artifacts and derives the full runtime cache identity', () => {
        const result = validateInstalledReactNativeBundleArtifact({
            artifact,
            expectedPluginId: 'acme.preview',
            expectedContributionId: 'native-preview',
            hostRuntime,
        });

        expect(result).toMatchObject({
            ok: true,
            cacheIdentity: {
                pluginId: 'acme.preview',
                contributionId: 'native-preview',
                artifactDigest: ARTIFACT_DIGEST,
                hostAppVersion: '2.0.0',
                hostUiApiVersion: '1.0.0',
                reactVersion: '19.0.0',
                reactNativeVersion: '0.83.4',
                expoRuntimeVersion: '0.2.0-native',
                hermesVersion: '0.15.0',
                platform: 'ios',
                channel: 'internal',
                nativeCapabilitiesDigest: deriveReactNativeNativeCapabilitiesDigest(['clipboard', 'haptics']),
                projectionGeneration: 12,
            },
        });
        expect(result.ok && result.cacheKey).toContain('2.0.0');
    });

    it('accepts a platform:web installed artifact through the same integrity and compatibility pipeline', () => {
        const webArtifact = {
            ...artifact,
            id: 'native-preview-web',
            platform: 'web',
            compatibility: {
                hostAppVersion: '2.0.0',
                hostUiApiVersion: '1.0.0',
                reactVersion: '19.0.0',
                reactNativeVersion: '0.83.4',
                supportedChannels: ['internal'],
                nativeCapabilities: [],
            },
            assetPath: 'react-native-web/native-preview/entry.mjs',
        } as const;

        expect(validateInstalledReactNativeBundleArtifact({
            artifact: webArtifact,
            expectedPluginId: 'acme.preview',
            expectedContributionId: 'native-preview',
            hostRuntime: {
                ...hostRuntime,
                platform: 'web',
                availableNativeCapabilities: [],
                expoRuntimeVersion: undefined,
                hermesVersion: undefined,
            },
        })).toMatchObject({
            ok: true,
            cacheIdentity: { platform: 'web', artifactDigest: ARTIFACT_DIGEST },
        });
    });

    it('fails closed for remote URLs, dev-server artifacts, Hermes bytecode, runtime mismatch, and missing capabilities', () => {
        const validate = (
            candidate: unknown,
            runtime: ReactNativeBundleHostRuntime = hostRuntime,
        ) =>
            validateInstalledReactNativeBundleArtifact({
                artifact: candidate,
                expectedPluginId: 'acme.preview',
                expectedContributionId: 'native-preview',
                hostRuntime: runtime,
            });

        expect(validate({
            ...artifact,
            assetPath: undefined,
            url: 'https://example.test/native.bundle.js',
        })).toEqual({ ok: false, code: 'remote_url_unsupported' });
        expect(validate({
            ...artifact,
            integrity: undefined,
            channel: 'development',
            assetPath: undefined,
            devUrl: 'http://127.0.0.1:8082/native.bundle.js',
        }, {
            ...hostRuntime,
            channel: 'development',
        })).toEqual({ ok: false, code: 'dev_hot_reload_not_installable' });
        expect(validate({
            ...artifact,
            contentType: 'application/x-hermes-bytecode',
            assetPath: 'react-native/native-preview/ios.hbc',
        })).toEqual({ ok: false, code: 'hermes_bytecode_unsupported' });
        expect(validate(artifact, {
            ...hostRuntime,
            reactNativeVersion: '0.82.0',
        })).toEqual({ ok: false, code: 'runtime_mismatch' });
        expect(validate(artifact, {
            ...hostRuntime,
            availableNativeCapabilities: ['clipboard'],
        })).toEqual({ ok: false, code: 'missing_native_capability' });
    });

    it('uses supportedChannels as the sole channel-compatibility authority', () => {
        const developmentResult = validateInstalledReactNativeBundleArtifact({
            artifact: {
                ...artifact,
                compatibility: {
                    ...artifact.compatibility,
                    supportedChannels: ['internal', 'development'],
                },
            },
            expectedPluginId: 'acme.preview',
            expectedContributionId: 'native-preview',
            hostRuntime: { ...hostRuntime, channel: 'development' },
        });
        const internalResult = validateInstalledReactNativeBundleArtifact({
            artifact: {
                ...artifact,
                compatibility: {
                    ...artifact.compatibility,
                    supportedChannels: ['internal', 'development'],
                },
            },
            expectedPluginId: 'acme.preview',
            expectedContributionId: 'native-preview',
            hostRuntime,
        });
        expect(developmentResult).toMatchObject({ ok: true, cacheIdentity: { channel: 'development' } });
        expect(internalResult).toMatchObject({ ok: true, cacheIdentity: { channel: 'internal' } });
        expect(developmentResult.ok && internalResult.ok && developmentResult.cacheKey)
            .not.toBe(internalResult.ok ? internalResult.cacheKey : null);

        expect(validateInstalledReactNativeBundleArtifact({
            artifact,
            expectedPluginId: 'acme.preview',
            expectedContributionId: 'native-preview',
            hostRuntime: { ...hostRuntime, channel: 'development' },
        })).toEqual({ ok: false, code: 'channel_unsupported' });

        const { supportedChannels: _supportedChannels, ...compatibilityWithoutChannels } = artifact.compatibility;
        void _supportedChannels;
        expect(validateInstalledReactNativeBundleArtifact({
            artifact: { ...artifact, compatibility: compatibilityWithoutChannels },
            expectedPluginId: 'acme.preview',
            expectedContributionId: 'native-preview',
            hostRuntime,
        })).toEqual({ ok: false, code: 'channel_unsupported' });
    });

    it('classifies dev hot reload as local development only and never as installed loading', () => {
        expect(classifyReactNativeBundleArtifactSource({
            ...artifact,
            channel: 'development',
            devUrl: 'http://127.0.0.1:8082/native.bundle.js',
        })).toEqual({ kind: 'devHotReload' });
        expect(classifyReactNativeBundleArtifactSource({
            ...artifact,
            url: 'https://example.test/native.bundle.js',
            assetPath: undefined,
        })).toEqual({ kind: 'remoteUnsupported' });
        expect(classifyReactNativeBundleArtifactSource(artifact)).toEqual({ kind: 'installedArtifact' });
    });
});
