import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildCliBinaryArtifactPayload } from './buildCliBinaryArtifactPayload.js';

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'build-cli-binary-artifact-payload-'));
    tempDirs.push(dir);
    return dir;
}

async function writeRepoFile(path: string, content: string, timestamp?: Date): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, 'utf8');
    if (timestamp) {
        await utimes(path, timestamp, timestamp);
    }
}

describe('buildCliBinaryArtifactPayload bundled workspace sync', () => {
    afterEach(async () => {
        await Promise.all(tempDirs.splice(0).map(async (dir) => {
            await rm(dir, { recursive: true, force: true });
        }));
    });

    it('rejects cross-target builds before copying host-native runtime sidecars', async () => {
        const repoRoot = await createTempDir();
        const payloadDir = join(repoRoot, 'artifacts', 'payload');

        await writeRepoFile(join(repoRoot, 'package.json'), `${JSON.stringify({ name: 'repo-root', private: true })}\n`);
        await writeRepoFile(join(repoRoot, 'apps', 'cli', 'package.json'), `${JSON.stringify({
            name: '@happier-dev/cli',
            version: '0.0.0',
            bundledDependencies: [],
            dependencies: {},
        }, null, 2)}\n`);

        const mismatchedTarget = process.platform === 'win32'
            ? { bunTarget: 'bun-linux-x64-baseline', os: 'linux', arch: 'x64', exeExt: '' }
            : { bunTarget: 'bun-windows-x64', os: 'windows', arch: 'x64', exeExt: '.exe' };

        await expect(buildCliBinaryArtifactPayload({
            repoRoot,
            payloadDir,
            target: mismatchedTarget,
            commandProbe: (command) => command === 'bun',
        })).rejects.toThrow(/host-native runtime packages require a matching host target/i);
    });

    it('refreshes bundled workspace packages in apps/cli/node_modules before compiling a reused cli dist snapshot', async () => {
        const repoRoot = await createTempDir();
        const payloadDir = join(repoRoot, 'artifacts', 'payload');
        const older = new Date('2026-04-13T18:00:00.000Z');
        const newer = new Date('2026-04-13T18:05:00.000Z');
        const currentSourceContent = 'export const installVersionedPayload = "fresh";\n';
        const staleBundledContent = 'export const installVersionedPayload = "stale";\n';
        const sourceWorkspaceInstallPath = join(
            repoRoot,
            'packages',
            'cli-common',
            'dist',
            'firstPartyRuntime',
            'installVersionedPayload.js',
        );
        const bundledWorkspaceInstallPath = join(
            repoRoot,
            'apps',
            'cli',
            'node_modules',
            '@happier-dev',
            'cli-common',
            'dist',
            'firstPartyRuntime',
            'installVersionedPayload.js',
        );

        await writeRepoFile(join(repoRoot, 'package.json'), `${JSON.stringify({ name: 'repo-root', private: true })}\n`);
        await writeRepoFile(join(repoRoot, 'yarn.lock'), '');

        await writeRepoFile(join(repoRoot, 'apps', 'cli', 'package.json'), `${JSON.stringify({
            name: '@happier-dev/cli',
            version: '0.0.0',
            bundledDependencies: ['@happier-dev/cli-common'],
            dependencies: {
                '@happier-dev/cli-common': '0.0.0',
            },
        }, null, 2)}\n`, older);
        await writeRepoFile(join(repoRoot, 'apps', 'cli', 'dist', 'index.mjs'), 'export default "cli-entrypoint";\n', newer);
        await writeRepoFile(join(repoRoot, 'apps', 'cli', 'src', 'index.ts'), 'export default "cli-source";\n', older);
        for (const sidecarPath of [
            ['apps', 'cli', 'scripts', 'childProcessOptions.cjs'],
            ['apps', 'cli', 'scripts', 'claude_version_utils.cjs'],
            ['apps', 'cli', 'scripts', 'claude_local_launcher.cjs'],
            ['apps', 'cli', 'scripts', 'claude_remote_launcher.cjs'],
            ['apps', 'cli', 'scripts', 'session_hook_forwarder.cjs'],
            ['apps', 'cli', 'scripts', 'permission_hook_forwarder.cjs'],
            ['apps', 'cli', 'scripts', 'ripgrep_launcher.cjs'],
            ['apps', 'cli', 'scripts', 'runtime', 'placeholder.txt'],
            ['apps', 'cli', 'scripts', 'shims', 'placeholder.txt'],
        ]) {
            await writeRepoFile(join(repoRoot, ...sidecarPath), 'placeholder\n', older);
        }

        await writeRepoFile(join(repoRoot, 'packages', 'cli-common', 'package.json'), `${JSON.stringify({
            name: '@happier-dev/cli-common',
            version: '0.0.0',
            type: 'module',
            main: './dist/index.js',
            exports: {
                '.': './dist/index.js',
                './firstPartyRuntime': './dist/firstPartyRuntime/index.js',
            },
        }, null, 2)}\n`);
        await writeRepoFile(join(repoRoot, 'packages', 'cli-common', 'README.md'), 'cli-common');
        await writeRepoFile(join(repoRoot, 'packages', 'cli-common', 'dist', 'index.js'), 'export {};\n', older);
        await writeRepoFile(join(repoRoot, 'packages', 'cli-common', 'dist', 'firstPartyRuntime', 'index.js'), 'export {};\n', older);
        await writeRepoFile(sourceWorkspaceInstallPath, currentSourceContent, older);

        await writeRepoFile(join(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'cli-common', 'package.json'), `${JSON.stringify({
            name: '@happier-dev/cli-common',
            version: '0.0.0',
            type: 'module',
            main: './dist/index.js',
            exports: {
                '.': './dist/index.js',
                './firstPartyRuntime': './dist/firstPartyRuntime/index.js',
            },
        }, null, 2)}\n`);
        await writeRepoFile(join(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'cli-common', 'dist', 'index.js'), 'export {};\n', older);
        await writeRepoFile(join(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'cli-common', 'dist', 'firstPartyRuntime', 'index.js'), 'export {};\n', older);
        await writeRepoFile(bundledWorkspaceInstallPath, staleBundledContent, older);
        for (const packageName of [
            '@huggingface/transformers',
            'ffmpeg-static',
            'sherpa-onnx-node',
            'node-pty',
            '@homebridge/node-pty-prebuilt-multiarch',
        ]) {
            const packageJson = packageName === 'sherpa-onnx-node'
                ? {
                    name: packageName,
                    version: '0.0.0',
                    main: './index.js',
                    optionalDependencies: {
                        'sherpa-onnx-linux-x64': '0.0.0',
                    },
                }
                : {
                    name: packageName,
                    version: '0.0.0',
                    main: './index.js',
                };
            await writeRepoFile(
                join(repoRoot, 'node_modules', ...packageName.split('/'), 'package.json'),
                `${JSON.stringify(packageJson, null, 2)}\n`,
                older,
            );
            await writeRepoFile(join(repoRoot, 'node_modules', ...packageName.split('/'), 'index.js'), 'module.exports = {};\n', older);
            if (packageName === 'ffmpeg-static') {
                await writeRepoFile(join(repoRoot, 'node_modules', 'ffmpeg-static', 'ffmpeg'), '#!/bin/sh\nexit 0\n', older);
            }
            if (packageName === 'sherpa-onnx-node') {
                await writeRepoFile(
                    join(repoRoot, 'node_modules', 'sherpa-onnx-linux-x64', 'package.json'),
                    `${JSON.stringify({ name: 'sherpa-onnx-linux-x64', version: '0.0.0', main: './index.js' }, null, 2)}\n`,
                    older,
                );
                await writeRepoFile(join(repoRoot, 'node_modules', 'sherpa-onnx-linux-x64', 'index.js'), 'module.exports = {};\n', older);
            }
        }

        const compileObservedContents: string[] = [];

        await buildCliBinaryArtifactPayload({
            repoRoot,
            payloadDir,
            commandProbe: (command) => command === 'bun' || command === 'yarn',
            runCommand: () => {
                throw new Error('buildCliBinaryArtifactPayload should not rebuild the cli dist in this scenario');
            },
            compileBinary: async ({ outfile }) => {
                compileObservedContents.push(await readFile(bundledWorkspaceInstallPath, 'utf8'));
                await writeRepoFile(outfile, 'compiled-binary');
            },
        });

        expect(compileObservedContents).toEqual([currentSourceContent]);
        await expect(readFile(join(payloadDir, 'node_modules', '@happier-dev', 'cli-common', 'dist', 'firstPartyRuntime', 'installVersionedPayload.js'), 'utf8'))
            .resolves.toBe(currentSourceContent);
    });

    it('rebuilds the cli dist snapshot when tracked inputs are newer than the cli dist entrypoint', async () => {
        const repoRoot = await createTempDir();
        const payloadDir = join(repoRoot, 'artifacts', 'payload');
        const older = new Date('2026-04-13T18:00:00.000Z');
        const newer = new Date('2026-04-13T18:05:00.000Z');
        const rebuiltEntrypointContent = 'export default "rebuilt-cli-entrypoint";\n';

        await writeRepoFile(join(repoRoot, 'package.json'), `${JSON.stringify({ name: 'repo-root', private: true })}\n`);
        await writeRepoFile(join(repoRoot, 'yarn.lock'), '');

        await writeRepoFile(join(repoRoot, 'apps', 'cli', 'package.json'), `${JSON.stringify({
            name: '@happier-dev/cli',
            version: '0.0.0',
            bundledDependencies: ['@happier-dev/cli-common'],
            dependencies: {
                '@happier-dev/cli-common': '0.0.0',
            },
        }, null, 2)}\n`, older);
        await writeRepoFile(join(repoRoot, 'apps', 'cli', 'dist', 'index.mjs'), 'export default "stale-cli-entrypoint";\n', older);
        await writeRepoFile(join(repoRoot, 'apps', 'cli', 'src', 'index.ts'), 'export default "newer-cli-source";\n', newer);
        for (const sidecarPath of [
            ['apps', 'cli', 'scripts', 'childProcessOptions.cjs'],
            ['apps', 'cli', 'scripts', 'claude_version_utils.cjs'],
            ['apps', 'cli', 'scripts', 'claude_local_launcher.cjs'],
            ['apps', 'cli', 'scripts', 'claude_remote_launcher.cjs'],
            ['apps', 'cli', 'scripts', 'session_hook_forwarder.cjs'],
            ['apps', 'cli', 'scripts', 'permission_hook_forwarder.cjs'],
            ['apps', 'cli', 'scripts', 'ripgrep_launcher.cjs'],
            ['apps', 'cli', 'scripts', 'runtime', 'placeholder.txt'],
            ['apps', 'cli', 'scripts', 'shims', 'placeholder.txt'],
        ]) {
            await writeRepoFile(join(repoRoot, ...sidecarPath), 'placeholder\n', older);
        }

        await writeRepoFile(join(repoRoot, 'packages', 'cli-common', 'package.json'), `${JSON.stringify({
            name: '@happier-dev/cli-common',
            version: '0.0.0',
            type: 'module',
            main: './dist/index.js',
            exports: {
                '.': './dist/index.js',
                './firstPartyRuntime': './dist/firstPartyRuntime/index.js',
            },
        }, null, 2)}\n`);
        await writeRepoFile(join(repoRoot, 'packages', 'cli-common', 'README.md'), 'cli-common');
        await writeRepoFile(join(repoRoot, 'packages', 'cli-common', 'dist', 'index.js'), 'export {};\n', older);
        await writeRepoFile(join(repoRoot, 'packages', 'cli-common', 'dist', 'firstPartyRuntime', 'index.js'), 'export {};\n', older);
        await writeRepoFile(join(repoRoot, 'packages', 'cli-common', 'dist', 'firstPartyRuntime', 'installVersionedPayload.js'), 'export {};\n', older);

        await writeRepoFile(join(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'cli-common', 'package.json'), `${JSON.stringify({
            name: '@happier-dev/cli-common',
            version: '0.0.0',
            type: 'module',
            main: './dist/index.js',
            exports: {
                '.': './dist/index.js',
                './firstPartyRuntime': './dist/firstPartyRuntime/index.js',
            },
        }, null, 2)}\n`);
        await writeRepoFile(join(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'cli-common', 'dist', 'index.js'), 'export {};\n', older);
        await writeRepoFile(join(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'cli-common', 'dist', 'firstPartyRuntime', 'index.js'), 'export {};\n', older);
        await writeRepoFile(join(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'cli-common', 'dist', 'firstPartyRuntime', 'installVersionedPayload.js'), 'export {};\n', older);
        for (const packageName of [
            '@huggingface/transformers',
            'ffmpeg-static',
            'sherpa-onnx-node',
            'node-pty',
            '@homebridge/node-pty-prebuilt-multiarch',
        ]) {
            const packageJson = packageName === 'sherpa-onnx-node'
                ? {
                    name: packageName,
                    version: '0.0.0',
                    main: './index.js',
                    optionalDependencies: {
                        'sherpa-onnx-linux-x64': '0.0.0',
                    },
                }
                : {
                    name: packageName,
                    version: '0.0.0',
                    main: './index.js',
                };
            await writeRepoFile(
                join(repoRoot, 'node_modules', ...packageName.split('/'), 'package.json'),
                `${JSON.stringify(packageJson, null, 2)}\n`,
                older,
            );
            await writeRepoFile(join(repoRoot, 'node_modules', ...packageName.split('/'), 'index.js'), 'module.exports = {};\n', older);
            if (packageName === 'ffmpeg-static') {
                await writeRepoFile(join(repoRoot, 'node_modules', 'ffmpeg-static', 'ffmpeg'), '#!/bin/sh\nexit 0\n', older);
            }
            if (packageName === 'sherpa-onnx-node') {
                await writeRepoFile(
                    join(repoRoot, 'node_modules', 'sherpa-onnx-linux-x64', 'package.json'),
                    `${JSON.stringify({ name: 'sherpa-onnx-linux-x64', version: '0.0.0', main: './index.js' }, null, 2)}\n`,
                    older,
                );
                await writeRepoFile(join(repoRoot, 'node_modules', 'sherpa-onnx-linux-x64', 'index.js'), 'module.exports = {};\n', older);
            }
        }

        const runCommandCalls: Array<{ cmd: string; args: string[] }> = [];
        const compiledEntrypoints: string[] = [];

        await buildCliBinaryArtifactPayload({
            repoRoot,
            payloadDir,
            commandProbe: (command) => command === 'bun' || command === 'yarn',
            runCommand: async (cmd, args) => {
                runCommandCalls.push({ cmd, args });
                await writeRepoFile(join(repoRoot, 'apps', 'cli', 'dist', 'index.mjs'), rebuiltEntrypointContent, newer);
            },
            compileBinary: async ({ entrypoint, outfile }) => {
                compiledEntrypoints.push(await readFile(entrypoint, 'utf8'));
                await writeRepoFile(outfile, 'compiled-binary');
            },
        });

        expect(runCommandCalls).toHaveLength(1);
        expect(compiledEntrypoints).toEqual([rebuiltEntrypointContent]);
    });
});
