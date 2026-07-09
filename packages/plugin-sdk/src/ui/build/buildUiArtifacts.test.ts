import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    PluginUiArtifactsManifestV1Schema,
    computePluginUiArtifactFileSetSha256DigestV1,
} from '@happier-dev/protocol/plugins/ui';

import { defineHostedWebViteBuildPreset } from '../hostedWebBuild.js';
import { defineReactNativeRepackBuildPreset } from '../reactNativeBuild.js';
import { defineReactNativeWebViteBuildPreset } from '../reactNativeWebBuild.js';
import {
    buildUiArtifacts,
    type PluginUiBundlerRunnerV1,
    type PluginUiBuildSurfaceV1,
} from './buildUiArtifacts.js';

const hostUiApiVersion = '1.0.0';
const reactVersion = '19.2.0';

let projectRoot: string;

function encode(text: string): Uint8Array {
    return new TextEncoder().encode(text);
}

const hostedWebPreset = defineHostedWebViteBuildPreset({
    contributionId: 'examples.reviewWeb',
    sourceEntry: 'ui/reviewPanel.web.tsx',
    viteVersion: '7.0.0',
    hostUiApiVersion,
    reactVersion,
});

const hostedWebSurface: PluginUiBuildSurfaceV1 = {
    kind: 'hostedWeb',
    preset: hostedWebPreset,
    hostUiApiVersion,
    reactVersion,
};

function bundlerEmitting(
    files: readonly Readonly<{ relativePath: string; bytes: Uint8Array }>[],
): PluginUiBundlerRunnerV1 {
    return async () => Object.freeze({ files: Object.freeze([...files]) });
}

beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-build-ui-'));
});

afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
});

describe('buildUiArtifacts', () => {
    it('writes the dist tree + ui-artifacts.json with a digest computed from emitted bytes', async () => {
        const indexHtml = encode('<!doctype html><html><body>hi</body></html>');
        const appJs = encode('console.log("plugin ui");');
        const emitted = [
            { relativePath: 'hosted-web/examples.reviewWeb/index.html', bytes: indexHtml },
            { relativePath: 'hosted-web/examples.reviewWeb/assets/index.js', bytes: appJs },
        ];

        const result = await buildUiArtifacts({
            projectRoot,
            surfaces: [hostedWebSurface],
            runBundler: bundlerEmitting(emitted),
        });

        const artifactRoot = join(projectRoot, 'dist/happier-plugin-ui');

        // (a) dist files written byte-for-byte
        await expect(
            readFile(join(artifactRoot, 'hosted-web/examples.reviewWeb/index.html')),
        ).resolves.toEqual(Buffer.from(indexHtml));
        await expect(
            readFile(join(artifactRoot, 'hosted-web/examples.reviewWeb/assets/index.js')),
        ).resolves.toEqual(Buffer.from(appJs));

        // (b) manifest parses under the canonical schema
        const manifestRaw = await readFile(join(artifactRoot, 'ui-artifacts.json'), 'utf8');
        const manifest = PluginUiArtifactsManifestV1Schema.parse(JSON.parse(manifestRaw));
        expect(manifest.entries).toHaveLength(1);

        // (c) digest equals a recomputation over the bytes the executor wrote (not author-supplied)
        const recomputed = computePluginUiArtifactFileSetSha256DigestV1(emitted);
        expect(manifest.entries[0]?.digest).toBe(recomputed);
        expect(result.manifest.entries[0]?.digest).toBe(recomputed);
        expect(result.artifactsRoot).toBe(artifactRoot);
    });

    it('refuses to escape the artifact root via a traversing emitted path', async () => {
        await expect(buildUiArtifacts({
            projectRoot,
            surfaces: [hostedWebSurface],
            runBundler: bundlerEmitting([
                { relativePath: '../../../etc/passwd', bytes: encode('x') },
            ]),
        })).rejects.toThrow();
    });

    it('fails closed when the bundler emits no files', async () => {
        await expect(buildUiArtifacts({
            projectRoot,
            surfaces: [hostedWebSurface],
            runBundler: bundlerEmitting([]),
        })).rejects.toThrow();
    });

    it('builds a react-native surface with the file-set digest and repack bundler tag', async () => {
        const nativePreset = defineReactNativeRepackBuildPreset({
            contributionId: 'examples.reviewNative',
            platform: 'ios',
            sourceEntry: 'ui/reviewPanel.native.tsx',
            repackVersion: '5.0.0',
            hostUiApiVersion,
            compatibility: {
                reactVersion,
                reactNativeVersion: '0.83.4',
            },
        });
        const bundle = encode('module.exports = {};');
        const emitted = [
            { relativePath: 'react-native/examples.reviewNative/ios.bundle.js', bytes: bundle },
        ];

        const result = await buildUiArtifacts({
            projectRoot,
            surfaces: [{
                kind: 'reactNative',
                preset: nativePreset,
                hostUiApiVersion,
                compatibility: { reactVersion, reactNativeVersion: '0.83.4' },
            }],
            runBundler: bundlerEmitting(emitted),
        });

        const entry = result.manifest.entries[0];
        expect(entry?.tier).toBe('reactNative');
        expect(entry?.platform).toBe('ios');
        expect(entry?.builtWith.bundler).toBe('repack');
        expect(entry?.digest).toBe(computePluginUiArtifactFileSetSha256DigestV1(emitted));
    });

    it('builds a react-native web (RN-web) surface with the Vite bundler tag (LEDGER DEC-6)', async () => {
        const webPreset = defineReactNativeWebViteBuildPreset({
            contributionId: 'examples.reviewNative',
            sourceEntry: 'ui/reviewPanel.tsx',
            viteVersion: '7.3.1',
            hostUiApiVersion,
            compatibility: { reactVersion, reactNativeVersion: '0.83.4' },
        });
        const bundle = encode('export function renderSurface() {}');
        const emitted = [
            { relativePath: 'react-native-web/examples.reviewNative/entry.mjs', bytes: bundle },
        ];

        const result = await buildUiArtifacts({
            projectRoot,
            surfaces: [{
                kind: 'reactNative',
                preset: webPreset,
                hostUiApiVersion,
                compatibility: { reactVersion, reactNativeVersion: '0.83.4' },
            }],
            runBundler: bundlerEmitting(emitted),
        });

        const entry = result.manifest.entries[0];
        expect(entry?.tier).toBe('reactNative');
        expect(entry?.platform).toBe('web');
        expect(entry?.builtWith.bundler).toBe('vite');
        expect(entry?.digest).toBe(computePluginUiArtifactFileSetSha256DigestV1(emitted));
    });

    it('lets one reactNative plugin ship ios + web surfaces in the same build without a duplicate-surface collision', async () => {
        const nativePreset = defineReactNativeRepackBuildPreset({
            contributionId: 'examples.reviewNative',
            platform: 'ios',
            sourceEntry: 'ui/reviewPanel.tsx',
            repackVersion: '5.0.0',
            hostUiApiVersion,
            compatibility: { reactVersion, reactNativeVersion: '0.83.4' },
        });
        const webPreset = defineReactNativeWebViteBuildPreset({
            contributionId: 'examples.reviewNative',
            sourceEntry: 'ui/reviewPanel.tsx',
            viteVersion: '7.3.1',
            hostUiApiVersion,
            compatibility: { reactVersion, reactNativeVersion: '0.83.4' },
        });

        const result = await buildUiArtifacts({
            projectRoot,
            surfaces: [
                {
                    kind: 'reactNative',
                    preset: nativePreset,
                    hostUiApiVersion,
                    compatibility: { reactVersion, reactNativeVersion: '0.83.4' },
                },
                {
                    kind: 'reactNative',
                    preset: webPreset,
                    hostUiApiVersion,
                    compatibility: { reactVersion, reactNativeVersion: '0.83.4' },
                },
            ],
            runBundler: async (surface) => Object.freeze({
                files: Object.freeze([{ relativePath: surface.preset.output.entry, bytes: encode(surface.preset.output.entry) }]),
            }),
        });

        expect(result.manifest.entries).toHaveLength(2);
        expect(result.manifest.entries.map((e) => e.platform).sort()).toEqual(['ios', 'web']);
    });
});
