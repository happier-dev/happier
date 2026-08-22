import { describe, expect, it } from 'vitest';

import type { PluginUiArtifactsManifestEntryV1 } from '@happier-dev/protocol/plugins/ui';
import { PUBLIC_TOOLCHAIN_COMPATIBILITY_V1 } from '@happier-dev/plugin-sdk/browser';

import { generatedUiArtifactDefaultHostCompatibilityFailure } from './artifactCompatibility';

describe('generated UI artifact default host compatibility', () => {
    it('accepts a framework-free hosted artifact without consulting a React runtime', () => {
        const entry = {
            contributionId: 'plain-dom-panel',
            tier: 'hostedWeb',
            platform: 'web',
            entry: 'hosted-web/plain-dom-panel/index.html',
            files: [{
                relativePath: 'hosted-web/plain-dom-panel/index.html',
                digest: `sha256:${'a'.repeat(64)}`,
                byteSize: 1,
            }],
            digest: `sha256:${'b'.repeat(64)}`,
            builtWith: { bundler: 'vite', version: PUBLIC_TOOLCHAIN_COMPATIBILITY_V1.framework.vite },
            hostUiApiVersion: PUBLIC_TOOLCHAIN_COMPATIBILITY_V1.ui.hostApiVersion,
            compat: {},
        } satisfies PluginUiArtifactsManifestEntryV1;

        expect(generatedUiArtifactDefaultHostCompatibilityFailure(entry)).toBeNull();
    });

    it('accepts a native artifact built with the generated public React Native runtime', () => {
        const entry = {
            contributionId: 'native-panel',
            tier: 'reactNative',
            platform: 'ios',
            entry: 'react-native/native-panel/ios/ios.bundle',
            files: [{
                relativePath: 'react-native/native-panel/ios/ios.bundle',
                digest: `sha256:${'a'.repeat(64)}`,
                byteSize: 1,
            }],
            digest: `sha256:${'b'.repeat(64)}`,
            builtWith: { bundler: 'repack', version: PUBLIC_TOOLCHAIN_COMPATIBILITY_V1.framework.repack },
            repack: {
                containerName: 'native_panel',
                modulePath: './renderSurface',
                exportName: 'renderSurface',
            },
            hostUiApiVersion: PUBLIC_TOOLCHAIN_COMPATIBILITY_V1.ui.hostApiVersion,
            compat: {
                react: PUBLIC_TOOLCHAIN_COMPATIBILITY_V1.framework.react,
                reactNative: PUBLIC_TOOLCHAIN_COMPATIBILITY_V1.framework.reactNative,
            },
        } satisfies PluginUiArtifactsManifestEntryV1;

        expect(generatedUiArtifactDefaultHostCompatibilityFailure(entry)).toBeNull();
    });
    it('rejects a native artifact pinning an Expo runtime this host cannot confirm', () => {
        const entry = {
            contributionId: 'native-panel',
            tier: 'reactNative',
            platform: 'ios',
            entry: 'react-native/native-panel/ios/ios.bundle',
            files: [{
                relativePath: 'react-native/native-panel/ios/ios.bundle',
                digest: `sha256:${'a'.repeat(64)}`,
                byteSize: 1,
            }],
            digest: `sha256:${'b'.repeat(64)}`,
            builtWith: { bundler: 'repack', version: PUBLIC_TOOLCHAIN_COMPATIBILITY_V1.framework.repack },
            repack: {
                containerName: 'native_panel',
                modulePath: './renderSurface',
                exportName: 'renderSurface',
            },
            hostUiApiVersion: PUBLIC_TOOLCHAIN_COMPATIBILITY_V1.ui.hostApiVersion,
            compat: {
                react: PUBLIC_TOOLCHAIN_COMPATIBILITY_V1.framework.react,
                reactNative: PUBLIC_TOOLCHAIN_COMPATIBILITY_V1.framework.reactNative,
                expoRuntime: '52.0.0',
            },
        } satisfies PluginUiArtifactsManifestEntryV1;

        expect(generatedUiArtifactDefaultHostCompatibilityFailure(entry))
            .toBe('generated_react_native_runtime_mismatch');
    });

    it('rejects a native artifact pinning a Hermes runtime this host cannot confirm', () => {
        const entry = {
            contributionId: 'native-panel',
            tier: 'reactNative',
            platform: 'android',
            entry: 'react-native/native-panel/android/android.bundle',
            files: [{
                relativePath: 'react-native/native-panel/android/android.bundle',
                digest: `sha256:${'a'.repeat(64)}`,
                byteSize: 1,
            }],
            digest: `sha256:${'b'.repeat(64)}`,
            builtWith: { bundler: 'repack', version: PUBLIC_TOOLCHAIN_COMPATIBILITY_V1.framework.repack },
            repack: {
                containerName: 'native_panel',
                modulePath: './renderSurface',
                exportName: 'renderSurface',
            },
            hostUiApiVersion: PUBLIC_TOOLCHAIN_COMPATIBILITY_V1.ui.hostApiVersion,
            compat: {
                react: PUBLIC_TOOLCHAIN_COMPATIBILITY_V1.framework.react,
                reactNative: PUBLIC_TOOLCHAIN_COMPATIBILITY_V1.framework.reactNative,
                hermes: '0.12.0',
            },
        } satisfies PluginUiArtifactsManifestEntryV1;

        expect(generatedUiArtifactDefaultHostCompatibilityFailure(entry))
            .toBe('generated_react_native_runtime_mismatch');
    });

    it('rejects a native artifact built against a different React runtime', () => {
        const entry = {
            contributionId: 'native-panel',
            tier: 'reactNative',
            platform: 'ios',
            entry: 'react-native/native-panel/ios/ios.bundle',
            files: [{
                relativePath: 'react-native/native-panel/ios/ios.bundle',
                digest: `sha256:${'a'.repeat(64)}`,
                byteSize: 1,
            }],
            digest: `sha256:${'b'.repeat(64)}`,
            builtWith: { bundler: 'repack', version: PUBLIC_TOOLCHAIN_COMPATIBILITY_V1.framework.repack },
            repack: {
                containerName: 'native_panel',
                modulePath: './renderSurface',
                exportName: 'renderSurface',
            },
            hostUiApiVersion: PUBLIC_TOOLCHAIN_COMPATIBILITY_V1.ui.hostApiVersion,
            compat: {
                react: '18.0.0',
                reactNative: PUBLIC_TOOLCHAIN_COMPATIBILITY_V1.framework.reactNative,
            },
        } satisfies PluginUiArtifactsManifestEntryV1;

        expect(generatedUiArtifactDefaultHostCompatibilityFailure(entry))
            .toBe('generated_ui_react_runtime_mismatch');
    });

    it('rejects an artifact built against a different host UI API version', () => {
        const entry = {
            contributionId: 'plain-dom-panel',
            tier: 'hostedWeb',
            platform: 'web',
            entry: 'hosted-web/plain-dom-panel/index.html',
            files: [{
                relativePath: 'hosted-web/plain-dom-panel/index.html',
                digest: `sha256:${'a'.repeat(64)}`,
                byteSize: 1,
            }],
            digest: `sha256:${'b'.repeat(64)}`,
            builtWith: { bundler: 'vite', version: PUBLIC_TOOLCHAIN_COMPATIBILITY_V1.framework.vite },
            hostUiApiVersion: '999.0.0',
            compat: {},
        } satisfies PluginUiArtifactsManifestEntryV1;

        expect(generatedUiArtifactDefaultHostCompatibilityFailure(entry))
            .toBe('generated_ui_host_api_mismatch');
    });
});
