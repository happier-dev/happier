import { describe, expect, it } from 'vitest';

import { PUBLIC_TOOLCHAIN_COMPATIBILITY_V1 } from '@happier-dev/plugin-sdk/browser';
import type { PluginUiArtifactsManifestEntryV2 } from '@happier-dev/protocol/plugins/ui';

import {
    generatedUiArtifactCompatibilityFailure,
    generatedUiArtifactDefaultHostCompatibilityFailure,
} from './artifactCompatibility';

const fileDigest = `sha256:${'a'.repeat(64)}` as const;
const artifactDigest = `sha256:${'b'.repeat(64)}` as const;

describe('generated UI artifact default host compatibility', () => {
    it.each([`^${PUBLIC_TOOLCHAIN_COMPATIBILITY_V1.ui.hostApiVersion}`, '=1.0.0', '^1.1.0'])(
        'admits a hosted-static artifact by supported Host UI API range %s', hostUiApiRange => {
        const entry = {
            artifactId: 'plain-dom-panel',
            tier: 'hostedWeb',
            entry: 'hosted-web/plain-dom-panel/index.html',
            files: [{
                relativePath: 'hosted-web/plain-dom-panel/index.html',
                digest: fileDigest,
                byteSize: 1,
            }],
            digest: artifactDigest,
            builtWith: { staging: 'staticDirectory' },
            hostUiApiRange,
        } satisfies PluginUiArtifactsManifestEntryV2;

        expect(generatedUiArtifactDefaultHostCompatibilityFailure(entry)).toBeNull();
        if (hostUiApiRange === '^1.1.0') {
            expect(generatedUiArtifactCompatibilityFailure({ entry, hostRuntime: { hostUiApiVersion: '1.0.0' } }))
                .toBe('generated_ui_host_api_mismatch');
        }
    });

    it('admits a universal executable without exact framework or engine gates', () => {
        const entry = {
            artifactId: 'native-panel',
            tier: 'reactNative',
            entry: 'react-native/native-panel/entry.cjs.bundle',
            files: [{
                relativePath: 'react-native/native-panel/entry.cjs.bundle',
                digest: fileDigest,
                byteSize: 1,
            }],
            digest: artifactDigest,
            builtWith: { bundler: 'esbuild', version: '0.25.0' },
            executable: { exports: ['renderSurface'] },
            hostUiApiRange: `^${PUBLIC_TOOLCHAIN_COMPATIBILITY_V1.ui.hostApiVersion}`,
        } satisfies PluginUiArtifactsManifestEntryV2;

        expect(generatedUiArtifactDefaultHostCompatibilityFailure(entry)).toBeNull();
    });

    it('rejects an artifact whose Host UI API range excludes this host', () => {
        const entry = {
            artifactId: 'plain-dom-panel',
            tier: 'hostedWeb',
            entry: 'hosted-web/plain-dom-panel/index.html',
            files: [{
                relativePath: 'hosted-web/plain-dom-panel/index.html',
                digest: fileDigest,
                byteSize: 1,
            }],
            digest: artifactDigest,
            builtWith: { staging: 'staticDirectory' },
            hostUiApiRange: '^999.0.0',
        } satisfies PluginUiArtifactsManifestEntryV2;

        expect(generatedUiArtifactDefaultHostCompatibilityFailure(entry))
            .toBe('generated_ui_host_api_mismatch');
    });

    it('does not opt prerelease hosts into a stable-only range', () => {
        const entry = {
            artifactId: 'native-panel',
            tier: 'reactNative',
            entry: 'react-native/native-panel/entry.cjs.bundle',
            files: [{
                relativePath: 'react-native/native-panel/entry.cjs.bundle',
                digest: fileDigest,
                byteSize: 1,
            }],
            digest: artifactDigest,
            builtWith: { bundler: 'esbuild', version: '0.25.0' },
            executable: { exports: ['renderSurface'] },
            hostUiApiRange: '>=1.0.0 <2.0.0',
        } satisfies PluginUiArtifactsManifestEntryV2;

        expect(generatedUiArtifactCompatibilityFailure({
            entry,
            hostRuntime: { hostUiApiVersion: '1.1.0-beta.1' },
        })).toBe('generated_ui_host_api_mismatch');
    });
});
