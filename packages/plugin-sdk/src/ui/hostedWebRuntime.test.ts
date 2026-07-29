import { describe, expect, it } from 'vitest';

import {
    defineHostedWebRuntimeMode,
    defineUiArtifactsManifest,
} from './hostedWebRuntime';

describe('hosted web UI runtime SDK helpers', () => {
    const file = (relativePath: string) => ({
        relativePath,
        digest: `sha256:${'a'.repeat(64)}`,
        byteSize: 1,
    });
    it('validates static, managed-service, and session-endpoint runtime modes', () => {
        expect(defineHostedWebRuntimeMode({
            kind: 'installedStaticAssets',
            artifactId: 'artifact-1',
            assetRootId: 'assets-1',
        })).toMatchObject({ kind: 'installedStaticAssets' });

        expect(defineHostedWebRuntimeMode({
            kind: 'managedLocalService',
            localServiceId: 'service-1',
        })).toMatchObject({ kind: 'managedLocalService' });

        expect(defineHostedWebRuntimeMode({
            kind: 'registeredSessionEndpoint',
            endpointIdPath: '/ui/endpoint',
        })).toMatchObject({ kind: 'registeredSessionEndpoint' });
    });

    it('requires web artifacts to use Vite and RN artifacts to use Re.Pack with platform compatibility', () => {
        const manifest = defineUiArtifactsManifest({
            version: 1,
            entries: [
                {
                    contributionId: 'preview-web',
                    tier: 'hostedWeb',
                    entry: 'dist/index.html',
                    files: [file('dist/index.html'), file('dist/assets/index.js')],
                    digest: 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
                    builtWith: { bundler: 'vite', version: '6.0.0' },
                    hostUiApiVersion: '1.0.0',
                    compat: { react: '19.0.0' },
                },
                {
                    contributionId: 'native-preview',
                    tier: 'reactNative',
                    platform: 'ios',
                    entry: 'dist/ios.bundle',
                    files: [file('dist/ios.bundle')],
                    digest: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
                    builtWith: { bundler: 'repack', version: '5.0.0' },
                    repack: {
                        containerName: 'native_preview',
                        modulePath: './renderSurface',
                        exportName: 'renderSurface',
                    },
                    hostUiApiVersion: '1.0.0',
                    compat: {
                        react: '19.0.0',
                        reactNative: '0.79.0',
                    },
                },
            ],
        });

        expect(manifest.entries).toHaveLength(2);
        expect(() => defineUiArtifactsManifest({
            version: 1,
            entries: [
                {
                    contributionId: 'native-preview',
                    tier: 'reactNative',
                    entry: 'dist/native.bundle',
                    files: [file('dist/native.bundle')],
                    digest: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
                    builtWith: { bundler: 'vite', version: '6.0.0' },
                    hostUiApiVersion: '1.0.0',
                    compat: { react: '19.0.0' },
                },
            ],
        })).toThrow();
    });
});
