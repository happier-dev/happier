import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    PluginUiArtifactsManifestV1Schema,
    computePluginUiArtifactFileSetSha256DigestV1,
} from '@happier-dev/protocol/plugins/ui';

import { defineHostedWebViteBuildPreset } from '../hostedWebBuild.js';
import { defineReactNativeRepackBuildPreset } from '../reactNativeBuild.js';
import { defineReactNativeWebViteBuildPreset } from '../reactNativeWebBuild.js';
import { containsUnsafeGuardedRequireAssignment } from '../reactNativeRepackStrictSafety.js';
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
    vi.unstubAllEnvs();
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
        expect(manifest.entries[0]?.files).toEqual([
            {
                relativePath: 'hosted-web/examples.reviewWeb/index.html',
                digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
                byteSize: indexHtml.byteLength,
            },
            {
                relativePath: 'hosted-web/examples.reviewWeb/assets/index.js',
                digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
                byteSize: appJs.byteLength,
            },
        ]);

        // (c) digest equals a recomputation over the bytes the executor wrote (not author-supplied)
        const recomputed = computePluginUiArtifactFileSetSha256DigestV1(emitted);
        expect(manifest.entries[0]?.digest).toBe(recomputed);
        expect(result.manifest.entries[0]?.digest).toBe(recomputed);
        expect(result.artifactsRoot).toBe(artifactRoot);
    });

    it('publishes into the workspace staged dist instead of mutating the live package dist', async () => {
        const stagedDist = join(projectRoot, '.workspace-staged-dist');
        vi.stubEnv('HAPPIER_WORKSPACE_DIST_OUTPUT_DIR', stagedDist);

        const result = await buildUiArtifacts({
            projectRoot,
            surfaces: [hostedWebSurface],
            runBundler: bundlerEmitting([{
                relativePath: 'hosted-web/examples.reviewWeb/index.html',
                bytes: encode('<!doctype html>'),
            }]),
        });

        expect(result.artifactsRoot).toBe(join(stagedDist, 'happier-plugin-ui'));
        await expect(
            readFile(join(stagedDist, 'happier-plugin-ui/ui-artifacts.json'), 'utf8'),
        ).resolves.toContain('"version": 1');
        await expect(
            access(join(projectRoot, 'dist/happier-plugin-ui')),
        ).rejects.toThrow();
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
            module: {
                containerName: 'examples_review_native',
                modulePath: './PluginPanel',
                exportName: 'PluginPanel',
            },
            repackVersion: '5.0.0',
            hostUiApiVersion,
            compatibility: {
                reactVersion,
                reactNativeVersion: '0.83.4',
            },
        });
        const bundle = encode('module.exports = {};');
        const emitted = [
            { relativePath: 'react-native/examples.reviewNative/ios/ios.bundle.js', bytes: bundle },
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
        expect(entry?.repack).toEqual({
            containerName: 'examples_review_native',
            modulePath: './PluginPanel',
            exportName: 'PluginPanel',
        });
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

    it('lets one reactNative plugin ship ios + android + web siblings in the same build', async () => {
        const iosPreset = defineReactNativeRepackBuildPreset({
            contributionId: 'examples.reviewNative',
            platform: 'ios',
            sourceEntry: 'ui/reviewPanel.tsx',
            module: {
                containerName: 'examples_review_native',
                modulePath: './renderSurface',
                exportName: 'renderSurface',
            },
            repackVersion: '5.0.0',
            hostUiApiVersion,
            compatibility: { reactVersion, reactNativeVersion: '0.83.4' },
        });
        const androidPreset = defineReactNativeRepackBuildPreset({
            contributionId: 'examples.reviewNative',
            platform: 'android',
            sourceEntry: 'ui/reviewPanel.tsx',
            module: {
                containerName: 'examples_review_native',
                modulePath: './renderSurface',
                exportName: 'renderSurface',
            },
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
                    preset: iosPreset,
                    hostUiApiVersion,
                    compatibility: { reactVersion, reactNativeVersion: '0.83.4' },
                },
                {
                    kind: 'reactNative',
                    preset: androidPreset,
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

        expect(result.manifest.entries).toHaveLength(3);
        expect(result.manifest.entries.map((e) => e.platform).sort()).toEqual(['android', 'ios', 'web']);
    });

    it('publishes a complete replacement tree and prunes files omitted by the next build', async () => {
        const artifactRoot = join(projectRoot, 'dist/happier-plugin-ui');
        const entryPath = 'hosted-web/examples.reviewWeb/index.html';
        const stalePath = 'hosted-web/examples.reviewWeb/assets/stale.js';

        await buildUiArtifacts({
            projectRoot,
            surfaces: [hostedWebSurface],
            runBundler: bundlerEmitting([
                { relativePath: entryPath, bytes: encode('first') },
                { relativePath: stalePath, bytes: encode('stale') },
            ]),
        });
        await buildUiArtifacts({
            projectRoot,
            surfaces: [hostedWebSurface],
            runBundler: bundlerEmitting([{ relativePath: entryPath, bytes: encode('second') }]),
        });

        await expect(readFile(join(artifactRoot, entryPath), 'utf8')).resolves.toBe('second');
        await expect(access(join(artifactRoot, stalePath))).rejects.toThrow();
    });

    it('keeps the previous complete tree when staging the replacement fails', async () => {
        const artifactRoot = join(projectRoot, 'dist/happier-plugin-ui');
        const entryPath = 'hosted-web/examples.reviewWeb/index.html';
        await buildUiArtifacts({
            projectRoot,
            surfaces: [hostedWebSurface],
            runBundler: bundlerEmitting([{ relativePath: entryPath, bytes: encode('known-good') }]),
        });

        await expect(buildUiArtifacts({
            projectRoot,
            surfaces: [hostedWebSurface],
            runBundler: bundlerEmitting([
                { relativePath: entryPath, bytes: encode('replacement') },
                { relativePath: `${entryPath}/cannot-be-written.js`, bytes: encode('collision') },
            ]),
        })).rejects.toThrow();

        await expect(readFile(join(artifactRoot, entryPath), 'utf8')).resolves.toBe('known-good');
        const manifest = JSON.parse(await readFile(join(artifactRoot, 'ui-artifacts.json'), 'utf8')) as {
            entries: readonly { digest: string }[];
        };
        expect(manifest.entries[0]?.digest).toBe(
            computePluginUiArtifactFileSetSha256DigestV1([{ relativePath: entryPath, bytes: encode('known-good') }]),
        );
    });

    it('strict-safes Re.Pack guardedRequire before digesting and publishing native bytes', async () => {
        const nativePreset = defineReactNativeRepackBuildPreset({
            contributionId: 'examples.reviewNative',
            platform: 'ios',
            sourceEntry: 'ui/reviewPanel.native.tsx',
            module: {
                containerName: 'examples_review_native',
                modulePath: './PluginPanel',
                exportName: 'PluginPanel',
            },
            repackVersion: '5.2.5',
            hostUiApiVersion,
            compatibility: { reactVersion, reactNativeVersion: '0.83.4' },
        });
        const relativePath = 'react-native/examples.reviewNative/ios/ios.bundle.js';
        const unsafe = 'guardedWebpackRequire[key] = originalWebpackRequire[key];';

        const result = await buildUiArtifacts({
            projectRoot,
            surfaces: [{
                kind: 'reactNative',
                preset: nativePreset,
                hostUiApiVersion,
                compatibility: { reactVersion, reactNativeVersion: '0.83.4' },
            }],
            runBundler: bundlerEmitting([{ relativePath, bytes: encode(`before;${unsafe};after`) }]),
        });

        const published = await readFile(join(projectRoot, 'dist/happier-plugin-ui', relativePath));
        expect(containsUnsafeGuardedRequireAssignment(published.toString('utf8'))).toBe(false);
        expect(published.toString('utf8')).toContain('try { guardedWebpackRequire[key]');
        expect(result.manifest.entries[0]?.files[0]).toMatchObject({
            relativePath,
            byteSize: published.byteLength,
        });
        expect(result.manifest.entries[0]?.digest).toBe(computePluginUiArtifactFileSetSha256DigestV1([
            { relativePath, bytes: published },
        ]));
    });
});
