import { describe, expect, it } from 'vitest';

import { PluginUiArtifactDigestV1Schema } from '@happier-dev/protocol/plugins/ui';

import {
    defineHostedWebRuntimeMode,
    defineUiArtifactsManifest,
} from './hostedWebRuntime';

describe('hosted web UI runtime SDK helpers', () => {
    const digest = (character: string) => PluginUiArtifactDigestV1Schema.parse(
        `sha256:${character.repeat(64)}`,
    );
    const file = (relativePath: string) => ({
        relativePath,
        digest: digest('a'),
        byteSize: 1,
    });
    it('validates static and session-endpoint runtime modes', () => {
        expect(defineHostedWebRuntimeMode({
            kind: 'installedStaticAssets',
            artifactId: 'artifact-1',
            assetRootId: 'assets-1',
        })).toMatchObject({ kind: 'installedStaticAssets' });

        expect(defineHostedWebRuntimeMode({
            kind: 'registeredSessionEndpoint',
            endpointIdPath: '/ui/endpoint',
        })).toMatchObject({ kind: 'registeredSessionEndpoint' });
    });

    it('accepts only hosted-static directories and universal executable artifacts', () => {
        const manifest = defineUiArtifactsManifest({
            version: 2,
            entries: [
                {
                    artifactId: 'preview-web',
                    tier: 'hostedWeb',
                    entry: 'hosted-web/preview-web/index.html',
                    files: [file('hosted-web/preview-web/index.html'), file('hosted-web/preview-web/assets/index.js')],
                    digest: digest('f'),
                    builtWith: { staging: 'staticDirectory' },
                    hostUiApiRange: '^1.0.0',
                },
                {
                    artifactId: 'native-preview',
                    tier: 'reactNative',
                    entry: 'react-native/native-preview/entry.cjs.bundle',
                    files: [file('react-native/native-preview/entry.cjs.bundle')],
                    digest: digest('d'),
                    builtWith: { bundler: 'esbuild', version: '0.27.4' },
                    executable: { exports: ['renderSurface'] },
                    hostUiApiRange: '^1.0.0',
                },
            ],
        });

        expect(manifest.entries).toHaveLength(2);
        expect(() => defineUiArtifactsManifest({
            version: 2,
            entries: [
                {
                    artifactId: 'native-preview',
                    tier: 'reactNative',
                    entry: 'react-native/native-preview/entry.cjs.bundle',
                    files: [file('react-native/native-preview/entry.cjs.bundle')],
                    digest: digest('d'),
                    // @ts-expect-error Deliberately invalid bundler exercises runtime manifest validation.
                    builtWith: { bundler: 'vite', version: '6.0.0' },
                    executable: { exports: ['renderSurface'] },
                    hostUiApiRange: '^1.0.0',
                },
            ],
        })).toThrow();
    });
});
