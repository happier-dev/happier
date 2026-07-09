import { describe, expect, it } from 'vitest';
import type { PluginUiArtifactRevocationV1 } from '@happier-dev/protocol';

import { createPluginUiArtifactRevocationState } from '@/plugins/install/ui/revocation';

import { resolveReactNativeBundleRuntimeProjection } from './reactNativeRuntime';

const bundle = {
    id: 'reactNativeBundle:acme.preview:native-preview',
    pluginId: 'acme.preview',
    contributionKind: 'reactNativeBundle',
    contributionId: 'native-preview',
    bundle: {
        platform: 'ios',
        channel: 'internal',
        integrity: { digest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
    },
    compatibility: {
        hostUiApiVersion: '1.0.0',
        reactVersion: '19.0.0',
        reactNativeVersion: '0.83.4',
        supportedPlatforms: ['ios'],
        supportedChannels: ['internal'],
        requiredNativeCapabilities: ['clipboard'],
    },
    fallback: { kind: 'hostedWeb', contributionId: 'preview-web' },
} as const;

const artifact = {
    id: 'native-preview-ios',
    pluginId: 'acme.preview',
    contributionId: 'native-preview',
    contributionFamily: 'reactNativeBundles',
    artifactKind: 'reactNativeBundle',
    platform: 'ios',
    channel: 'internal',
    integrity: { digest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
    compatibility: {
        hostAppVersion: '2.0.0',
        hostUiApiVersion: '1.0.0',
        reactVersion: '19.0.0',
        reactNativeVersion: '0.83.4',
        // RN-HARDEN item 2: the channel-gate authority (channel above is provenance).
        supportedChannels: ['internal'],
        nativeCapabilities: ['clipboard'],
    },
    byteSize: 1024,
    contentType: 'application/javascript',
    assetPath: 'react-native/native-preview/ios.bundle.js',
} as const;

const hostRuntime = {
    hostAppVersion: '2.0.0',
    hostUiApiVersion: '1.0.0',
    reactVersion: '19.0.0',
    reactNativeVersion: '0.83.4',
    platform: 'ios',
    channel: 'internal',
    availableNativeCapabilities: ['clipboard'],
    projectionGeneration: 12,
} as const;

describe('React Native runtime projection', () => {
    it('projects loadability only when policy, artifact validation, and loader backend are all available', () => {
        expect(resolveReactNativeBundleRuntimeProjection({
            bundle,
            artifact,
            hostRuntime,
            featureEnabled: true,
            loaderBackendAvailable: true,
            revokedDigests: new Set(),
            crashDisabled: false,
            executionTrust: { kind: 'trustedSource', reason: 'local_trusted' } as const,
        })).toMatchObject({
            state: 'loadable',
            diagnostics: [],
            loadPolicy: {
                source: 'installedArtifact',
                featureEnabled: true,
                loaderBackendAvailable: true,
            },
        });
    });

    it('does not project loadability until executable artifact trust is proven', () => {
        expect(resolveReactNativeBundleRuntimeProjection({
            bundle,
            artifact,
            hostRuntime,
            featureEnabled: true,
            loaderBackendAvailable: true,
            revokedDigests: new Set(),
            crashDisabled: false,
        })).toEqual({
            state: 'fallback',
            diagnostics: ['execution_trust_unverified'],
        });
    });

    it('keeps Re.Pack dependency absence explicit and falls back before loader side effects', () => {
        expect(resolveReactNativeBundleRuntimeProjection({
            bundle,
            artifact,
            hostRuntime,
            featureEnabled: true,
            loaderBackendAvailable: false,
            revokedDigests: new Set(),
            crashDisabled: false,
            executionTrust: { kind: 'trustedSource', reason: 'local_trusted' } as const,
        })).toMatchObject({
            state: 'fallback',
            diagnostics: ['repack_script_manager_unavailable'],
            loadPolicy: {
                source: 'installedArtifact',
                featureEnabled: true,
                loaderBackendAvailable: false,
            },
        });
    });

    it('preserves the exact loader backend blocker diagnostics before projecting loadability', () => {
        expect(resolveReactNativeBundleRuntimeProjection({
            bundle,
            artifact,
            hostRuntime,
            featureEnabled: true,
            loaderBackendAvailable: false,
            loaderBackendDiagnostics: [
                'repack_script_manager_unavailable',
                'repack_script_manager_runtime_not_integrated',
            ],
            revokedDigests: new Set(),
            crashDisabled: false,
            executionTrust: { kind: 'trustedSource', reason: 'local_trusted' } as const,
        })).toMatchObject({
            state: 'fallback',
            diagnostics: [
                'repack_script_manager_unavailable',
                'repack_script_manager_runtime_not_integrated',
            ],
        });
    });

    it('uses non-digest artifact revocation scopes before projecting loadability', () => {
        const params = {
            bundle,
            artifact: {
                ...artifact,
                integrity: { ...artifact.integrity, signingKeyId: 'rn-key-1' },
            },
            hostRuntime,
            featureEnabled: true,
            loaderBackendAvailable: true,
            revokedDigests: new Set<string>(),
            revocationState: createPluginUiArtifactRevocationState({
                revocations: [
                    {
                        id: 'revoke-rn-key',
                        scope: { kind: 'signingKey', signingKeyId: 'rn-key-1' },
                        reason: 'compromised',
                        revokedAt: '2026-06-15T00:00:00.000Z',
                    } satisfies PluginUiArtifactRevocationV1,
                ],
            }),
            crashDisabled: false,
            executionTrust: { kind: 'trustedSource', reason: 'local_trusted' } as const,
        };

        expect(resolveReactNativeBundleRuntimeProjection(params)).toEqual({
            state: 'fallback',
            diagnostics: ['artifact_revoked'],
        });
    });

    // Phase 6.3 — dev-hot-reload author affordance.
    const devArtifact = {
        ...artifact,
        channel: 'development',
        devUrl: 'http://127.0.0.1:8082/index.bundle?platform=ios',
        assetPath: undefined,
    } as const;
    const devHostRuntime = { ...hostRuntime, channel: 'development' } as const;

    it('projects a local development-channel dev-server bundle as loadable when the devHotReload gate is on', () => {
        expect(resolveReactNativeBundleRuntimeProjection({
            bundle,
            artifact: devArtifact,
            hostRuntime: devHostRuntime,
            featureEnabled: true,
            loaderBackendAvailable: true,
            revokedDigests: new Set(),
            crashDisabled: false,
            devHotReloadEnabled: true,
            pluginSource: 'local',
        })).toEqual({
            state: 'loadable',
            diagnostics: [],
            loadPolicy: {
                source: 'devHotReload',
                devUrl: 'http://127.0.0.1:8082/index.bundle?platform=ios',
                featureEnabled: true,
                loaderBackendAvailable: true,
            },
        });
    });

    it('denies dev hot reload when the author gate is off', () => {
        expect(resolveReactNativeBundleRuntimeProjection({
            bundle,
            artifact: devArtifact,
            hostRuntime: devHostRuntime,
            featureEnabled: true,
            loaderBackendAvailable: true,
            revokedDigests: new Set(),
            crashDisabled: false,
            devHotReloadEnabled: false,
            pluginSource: 'local',
        })).toEqual({
            state: 'fallback',
            diagnostics: ['dev_hot_reload_denied'],
        });
    });

    it('denies dev hot reload for a non-local plugin source even on the development channel', () => {
        expect(resolveReactNativeBundleRuntimeProjection({
            bundle,
            artifact: devArtifact,
            hostRuntime: devHostRuntime,
            featureEnabled: true,
            loaderBackendAvailable: true,
            revokedDigests: new Set(),
            crashDisabled: false,
            devHotReloadEnabled: true,
            pluginSource: 'marketplace',
        })).toEqual({
            state: 'fallback',
            diagnostics: ['dev_hot_reload_denied'],
        });
    });

    it('denies dev hot reload off the development channel', () => {
        expect(resolveReactNativeBundleRuntimeProjection({
            bundle,
            artifact: { ...devArtifact, channel: 'internal' },
            hostRuntime,
            featureEnabled: true,
            loaderBackendAvailable: true,
            revokedDigests: new Set(),
            crashDisabled: false,
            devHotReloadEnabled: true,
            pluginSource: 'local',
        })).toEqual({
            state: 'fallback',
            diagnostics: ['dev_hot_reload_denied'],
        });
    });
});
