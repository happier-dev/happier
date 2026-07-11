import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    PluginUiArtifactsManifestV1Schema,
    computePluginUiArtifactFileSetSha256DigestV1,
} from '@happier-dev/protocol/plugins/ui';

import { defineHostedWebViteBuildPreset } from '../hostedWebBuild.js';
import { isBinDirectInvocation, runPluginBuildUiCli, type PluginBuildUiCliConfigV1 } from './bin.js';
import type { PluginUiBundlerRunnerV1, PluginUiBuildSurfaceV1 } from './buildUiArtifacts.js';

const hostUiApiVersion = '1.0.0';
const reactVersion = '19.2.0';

let projectRoot: string;

function encode(text: string): Uint8Array {
    return new TextEncoder().encode(text);
}

function surface(): PluginUiBuildSurfaceV1 {
    return {
        kind: 'hostedWeb',
        preset: defineHostedWebViteBuildPreset({
            contributionId: 'examples.reviewWeb',
            sourceEntry: 'ui/reviewPanel.web.tsx',
            viteVersion: '7.0.0',
            hostUiApiVersion,
            reactVersion,
        }),
        hostUiApiVersion,
        reactVersion,
    };
}

const emitted = [
    {
        relativePath: 'hosted-web/examples.reviewWeb/index.html',
        bytes: encode('<!doctype html><html></html>'),
    },
];

function config(runBundler: PluginUiBundlerRunnerV1): PluginBuildUiCliConfigV1 {
    return { surfaces: [surface()], runBundler };
}

beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-build-ui-cli-'));
});

afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
});

describe('runPluginBuildUiCli', () => {
    it('builds the declared surfaces and exits 0', async () => {
        const exitCode = await runPluginBuildUiCli({
            argv: ['--project-root', projectRoot],
            loadConfig: async () => config(async () => ({ files: emitted })),
        });

        expect(exitCode).toBe(0);
        const manifestRaw = await readFile(
            join(projectRoot, 'dist/happier-plugin-ui/ui-artifacts.json'),
            'utf8',
        );
        const manifest = PluginUiArtifactsManifestV1Schema.parse(JSON.parse(manifestRaw));
        expect(manifest.entries[0]?.digest).toBe(
            computePluginUiArtifactFileSetSha256DigestV1(emitted),
        );
    });

    it('exits non-zero when the bundler emits an entry mismatch', async () => {
        const exitCode = await runPluginBuildUiCli({
            argv: ['--project-root', projectRoot],
            loadConfig: async () => config(async () => ({
                files: [{ relativePath: 'hosted-web/examples.reviewWeb/other.html', bytes: encode('x') }],
            })),
        });
        expect(exitCode).not.toBe(0);
    });

    it('exits non-zero when config loading fails', async () => {
        const exitCode = await runPluginBuildUiCli({
            argv: ['--project-root', projectRoot],
            loadConfig: async () => {
                throw new Error('no config');
            },
        });
        expect(exitCode).not.toBe(0);
    });

    it('prints help and exits 0', async () => {
        const errors: string[] = [];
        const successes: string[] = [];
        const exitCode = await runPluginBuildUiCli({
            argv: ['--help'],
            onError: (message) => errors.push(message),
            onInfo: (message) => successes.push(message),
        });

        expect(exitCode).toBe(0);
        expect(errors).toEqual([]);
        expect(successes.join('\n')).toContain('happier-plugin-build-ui');
        expect(successes.join('\n')).toContain('pluginUiBuild');
        expect(successes.join('\n')).toContain('definePluginUiBuildConfig');
    });

    it('fails loudly when no config exists and names the discovered config contract', async () => {
        const errors: string[] = [];
        const exitCode = await runPluginBuildUiCli({
            argv: ['--project-root', projectRoot],
            onError: (message) => errors.push(message),
        });

        expect(exitCode).toBe(1);
        expect(errors.join('\n')).toContain('config_not_found');
        expect(errors.join('\n')).toContain('pluginUiBuild');
        expect(errors.join('\n')).toContain('definePluginUiBuildConfig');
    });

    it('discovers the SDK example config convention and supplies managed-bundler context', async () => {
        await mkdir(join(projectRoot, 'ui'), { recursive: true });
        await writeFile(
            join(projectRoot, 'pluginUiBuild.mjs'),
            [
                'export function definePluginUiBuildConfig(input) {',
                '  if (!input.exec) throw new Error("missing exec");',
                '  if (!input.emittedRoot.endsWith("dist/happier-plugin-ui")) throw new Error("bad emittedRoot");',
                '  if (typeof input.listEmittedFiles !== "function") throw new Error("missing listEmittedFiles");',
                '  return {',
                `    surfaces: ${JSON.stringify([surface()])},`,
                '    runBundler: async () => ({',
                `      files: ${JSON.stringify(emitted.map((file) => ({
                    relativePath: file.relativePath,
                    text: new TextDecoder().decode(file.bytes),
                })))}
                    .map((file) => ({ relativePath: file.relativePath, bytes: new TextEncoder().encode(file.text) })),`,
                '    }),',
                '  };',
                '}',
                '',
            ].join('\n'),
            'utf8',
        );

        const exitCode = await runPluginBuildUiCli({
            argv: ['--project-root', projectRoot],
        });

        expect(exitCode).toBe(0);
        const manifestRaw = await readFile(
            join(projectRoot, 'dist/happier-plugin-ui/ui-artifacts.json'),
            'utf8',
        );
        const manifest = PluginUiArtifactsManifestV1Schema.parse(JSON.parse(manifestRaw));
        expect(manifest.entries[0]?.contributionId).toBe('examples.reviewWeb');
    });
});

describe('isBinDirectInvocation', () => {
    // The bin is invoked through an npm `.bin` symlink AND, under a `file:`
    // dependency, through a `node_modules` package symlink into the source
    // checkout. In both cases `process.argv[1]` and the symlink-resolved
    // `import.meta.url` differ by raw path but resolve to the same real file.
    // A raw string compare silently no-ops the CLI (exit 0, zero output); the
    // check must compare canonical real paths.
    it('treats a symlinked argv entry pointing at the module file as a direct invocation', async () => {
        const realEntry = join(projectRoot, 'bin.js');
        const symlinkEntry = join(projectRoot, 'linked-bin.js');
        await writeFile(realEntry, '// bin', 'utf8');
        await symlink(realEntry, symlinkEntry);

        expect(isBinDirectInvocation({
            argvEntry: symlinkEntry,
            moduleUrl: pathToFileURL(realEntry).href,
        })).toBe(true);
    });

    it('returns false for an unrelated argv entry', () => {
        expect(isBinDirectInvocation({
            argvEntry: join(projectRoot, 'other.js'),
            moduleUrl: pathToFileURL(join(projectRoot, 'bin.js')).href,
        })).toBe(false);
    });

    it('returns false when there is no argv entry', () => {
        expect(isBinDirectInvocation({
            argvEntry: undefined,
            moduleUrl: pathToFileURL(join(projectRoot, 'bin.js')).href,
        })).toBe(false);
    });
});
