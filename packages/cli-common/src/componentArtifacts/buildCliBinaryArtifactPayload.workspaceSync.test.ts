import { mkdtemp, mkdir, readFile, readdir, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { buildCliBinaryArtifactPayload } from './buildCliBinaryArtifactPayload.js';
import { parseWorkspaceLockLeaseValue } from '../../workspaceLockLease.mjs';

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

async function collectFiles(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
        const entryPath = join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...await collectFiles(entryPath));
            continue;
        }
        if (entry.isFile()) {
            files.push(entryPath);
        }
    }
    return files;
}

async function collectStaticRuntimeScriptAssetSegments(): Promise<string[][]> {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
    const packagedRuntimeAssetOwnerDirs = [
        join(repoRoot, 'apps', 'cli', 'src', 'plugins', 'runtime', 'hooks'),
        join(repoRoot, 'apps', 'cli', 'src', 'integrations'),
        join(repoRoot, 'apps', 'cli', 'src', 'terminal', 'pty'),
        join(repoRoot, 'apps', 'cli', 'src', 'daemon', 'voiceInference'),
        join(repoRoot, 'apps', 'cli', 'src', 'daemon', 'memory', 'deepIndex', 'embeddings'),
    ];
    const cliSourceFiles = (await Promise.all(packagedRuntimeAssetOwnerDirs.map(async (dir) => collectFiles(dir))))
        .flat()
        .filter((file) => file.endsWith('.ts') || file.endsWith('.tsx'));
    const assetKeys = new Set<string>();

    for (const file of cliSourceFiles) {
        const source = await readFile(file, 'utf8');
        const matches = source.matchAll(/resolveCliRuntimeAssetPath\(\s*['"]scripts['"]\s*,\s*([\s\S]*?)\)/g);
        for (const match of matches) {
            const argsSource = String(match[1] ?? '');
            const segments = [...argsSource.matchAll(/['"]([^'"]+)['"]/g)].map((segmentMatch) => String(segmentMatch[1] ?? ''));
            const leftover = argsSource
                .replaceAll(/['"][^'"]+['"]/g, '')
                .replaceAll(/[\s,]/g, '');
            if (segments.length > 0 && !leftover) {
                assetKeys.add(segments.join('/'));
            }
        }
    }

    return [...assetKeys]
        .sort()
        .map((assetKey) => assetKey.split('/'));
}

async function writeCliToolUnpackFixture(repoRoot: string, timestamp: Date): Promise<void> {
    await writeRepoFile(join(repoRoot, 'apps', 'cli', 'tools', 'archives', 'checksums.sha256'), '', timestamp);
    await writeRepoFile(
        join(repoRoot, 'apps', 'cli', 'tools', 'archives', 'zellij-no-web-x86_64-unknown-linux-musl.tar.gz'),
        'fake zellij archive\n',
        timestamp,
    );
    await writeRepoFile(join(repoRoot, 'apps', 'cli', 'tools', 'archives', 'zellij-LICENSE'), 'fake zellij license\n', timestamp);
    await writeRepoFile(join(repoRoot, 'apps', 'cli', 'scripts', 'unpack-tools.cjs'), `
const fs = require('fs');
const path = require('path');

async function unpackTools(options = {}) {
    const platformDir = options.platformDir || 'unknown';
    const toolsDir = options.toolsDir || path.resolve(__dirname, '..', 'tools');
    const unpackedPath = path.join(toolsDir, 'unpacked');
    fs.mkdirSync(unpackedPath, { recursive: true });
    const binaryName = platformDir === 'x64-win32' ? 'zellij.exe' : 'zellij';
    fs.writeFileSync(path.join(unpackedPath, binaryName), 'zellij 0.44.3 for ' + platformDir + '\\n');
    fs.writeFileSync(path.join(unpackedPath, '.happier-tools-manifest.json'), JSON.stringify({
        platformDir,
        tools: { zellij: { version: '0.44.3' } },
    }, null, 2) + '\\n');
    return { success: true, alreadyUnpacked: false };
}

module.exports = { unpackTools };
`, timestamp);
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
                '@huggingface/transformers': '0.0.0',
                'ffmpeg-static': '0.0.0',
                'sherpa-onnx-node': '0.0.0',
                'node-pty': '0.0.0',
                '@homebridge/node-pty-prebuilt-multiarch': '0.0.0',
            },
        }, null, 2)}\n`, older);
        await writeRepoFile(join(repoRoot, 'apps', 'cli', 'dist', 'index.mjs'), 'export default "cli-entrypoint";\n', newer);
        await writeRepoFile(join(repoRoot, 'apps', 'cli', 'src', 'index.ts'), 'export default "cli-source";\n', older);
        const staticRuntimeScriptAssets = await collectStaticRuntimeScriptAssetSegments();
        const sidecarPaths = [
            ['apps', 'cli', 'scripts', 'childProcessOptions.cjs'],
            ['apps', 'cli', 'scripts', 'claude_version_utils.cjs'],
            ['apps', 'cli', 'scripts', 'claude_local_launcher.cjs'],
            ['apps', 'cli', 'scripts', 'claude_remote_launcher.cjs'],
            ['apps', 'cli', 'scripts', 'session_hook_forwarder.cjs'],
            ['apps', 'cli', 'scripts', 'permission_hook_forwarder.cjs'],
            ['apps', 'cli', 'scripts', 'ripgrep_launcher.cjs'],
            ['apps', 'cli', 'scripts', 'ripgrep_runtime_paths.cjs'],
            ['apps', 'cli', 'scripts', 'statusline_forwarder.cjs'],
            ['apps', 'cli', 'scripts', 'terminal_launch_spec_runner.cjs'],
            ...staticRuntimeScriptAssets.map((segments) => ['apps', 'cli', 'scripts', ...segments]),
            ['apps', 'cli', 'scripts', 'runtime', 'placeholder.txt'],
            ['apps', 'cli', 'scripts', 'shims', 'placeholder.txt'],
        ];
        for (const sidecarPath of new Map(sidecarPaths.map((path) => [path.join('/'), path])).values()) {
            await writeRepoFile(join(repoRoot, ...sidecarPath), 'placeholder\n', older);
        }
        await writeCliToolUnpackFixture(repoRoot, older);

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
        const compileObservedExternals: string[][] = [];
        const prebuiltManagedRuntimePath = join(repoRoot, 'prebuilt', 'happier-cliproxyapi-managed');
        await writeRepoFile(prebuiltManagedRuntimePath, 'signed managed runtime\n', older);
        await writeRepoFile(
            join(repoRoot, 'packages', 'plugins', 'cliproxyapi', 'managed-runtime', 'licenses', 'CLIProxyAPI-LICENSE'),
            'CLIProxyAPI license\n',
            older,
        );
        await writeRepoFile(
            join(repoRoot, 'packages', 'plugins', 'cliproxyapi', 'managed-runtime', 'licenses', 'THIRD-PARTY-NOTICES'),
            'CLIProxyAPI third-party notices\n',
            older,
        );

        await buildCliBinaryArtifactPayload({
            repoRoot,
            payloadDir,
            externals: ['fixture-external', 'pino', 'fixture-external'],
            cliProxyApiManagedRuntimeExecutablePath: prebuiltManagedRuntimePath,
            ensureWorkspacePackagesBuiltByName: async (_root, packageNames) => ({
                ok: true,
                built: [],
                skipped: packageNames,
            }),
            commandProbe: (command) => command === 'bun' || command === 'yarn',
            runCommand: () => {
                throw new Error('buildCliBinaryArtifactPayload should not rebuild the cli dist in this scenario');
            },
            compileBinary: async ({ outfile, externals }) => {
                compileObservedContents.push(await readFile(bundledWorkspaceInstallPath, 'utf8'));
                compileObservedExternals.push(externals ?? []);
                await writeRepoFile(join(payloadDir, 'tools', 'js-runtime', 'bin', 'node'), 'managed runtime\n');
                await writeRepoFile(outfile, 'compiled-binary');
            },
        });

        expect(compileObservedContents).toEqual([currentSourceContent]);
        expect(compileObservedExternals).toEqual([[
            '@huggingface/transformers',
            'ffmpeg-static',
            'sherpa-onnx-node',
            'node-pty',
            '@homebridge/node-pty-prebuilt-multiarch',
            'pino',
            'thread-stream',
            'fixture-external',
        ]]);
        await expect(readFile(join(payloadDir, 'node_modules', '@happier-dev', 'cli-common', 'dist', 'firstPartyRuntime', 'installVersionedPayload.js'), 'utf8'))
            .resolves.toBe(currentSourceContent);
        for (const segments of staticRuntimeScriptAssets) {
            await expect(readFile(join(payloadDir, 'scripts', ...segments), 'utf8'))
                .resolves.toBe('placeholder\n');
        }
        await expect(readFile(join(payloadDir, 'scripts', 'terminal_launch_spec_runner.cjs'), 'utf8'))
            .resolves.toBe('placeholder\n');
        await expect(readFile(join(payloadDir, 'scripts', 'ripgrep_runtime_paths.cjs'), 'utf8'))
            .resolves.toBe('placeholder\n');
        await expect(readFile(join(payloadDir, 'tools', 'unpacked', '.happier-tools-manifest.json'), 'utf8'))
            .resolves.toContain('"zellij"');
        await expect(readFile(join(payloadDir, 'tools', 'js-runtime', 'bin', 'node'), 'utf8'))
            .resolves.toBe('managed runtime\n');
        await expect(readFile(join(payloadDir, 'tools', 'unpacked', 'happier-cliproxyapi-managed'), 'utf8'))
            .resolves.toBe('signed managed runtime\n');
        await expect(readFile(join(payloadDir, 'tools', 'unpacked', 'CLIProxyAPI-LICENSE'), 'utf8'))
            .resolves.toBe('CLIProxyAPI license\n');
        await expect(readFile(join(payloadDir, 'tools', 'unpacked', 'CLIProxyAPI-THIRD-PARTY-NOTICES'), 'utf8'))
            .resolves.toBe('CLIProxyAPI third-party notices\n');
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
                '@huggingface/transformers': '0.0.0',
                'ffmpeg-static': '0.0.0',
                'sherpa-onnx-node': '0.0.0',
                'node-pty': '0.0.0',
                '@homebridge/node-pty-prebuilt-multiarch': '0.0.0',
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
            ['apps', 'cli', 'scripts', 'ripgrep_runtime_paths.cjs'],
            ['apps', 'cli', 'scripts', 'statusline_forwarder.cjs'],
            ['apps', 'cli', 'scripts', 'terminal_launch_spec_runner.cjs'],
            ['apps', 'cli', 'scripts', 'node_pty_relay.cjs'],
            ['apps', 'cli', 'scripts', 'runtime', 'placeholder.txt'],
            ['apps', 'cli', 'scripts', 'shims', 'placeholder.txt'],
        ]) {
            await writeRepoFile(join(repoRoot, ...sidecarPath), 'placeholder\n', older);
        }
        await writeCliToolUnpackFixture(repoRoot, older);

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

        const runCommandCalls: Array<{
            cmd: string;
            args: string[];
            options?: { env?: NodeJS.ProcessEnv };
        }> = [];
        const compiledEntrypoints: string[] = [];
        const prebuiltManagedRuntimePath = join(repoRoot, 'prebuilt', 'happier-cliproxyapi-managed');
        await writeRepoFile(prebuiltManagedRuntimePath, 'signed managed runtime\n', older);
        await writeRepoFile(
            join(repoRoot, 'packages', 'plugins', 'cliproxyapi', 'managed-runtime', 'licenses', 'CLIProxyAPI-LICENSE'),
            'CLIProxyAPI license\n',
            older,
        );
        await writeRepoFile(
            join(repoRoot, 'packages', 'plugins', 'cliproxyapi', 'managed-runtime', 'licenses', 'THIRD-PARTY-NOTICES'),
            'CLIProxyAPI third-party notices\n',
            older,
        );
        const previousWorkspaceDistOutputDir = process.env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR;
        const previousMixedCaseWorkspaceDistOutputDir =
            process.env.Happier_Workspace_Dist_Output_Dir;
        const previousMixedCaseWorkspaceLockLease =
            process.env.Happier_Workspace_Dist_Build_Lock_Held;
        process.env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR = join(repoRoot, '.dist.parent-stage');
        process.env.Happier_Workspace_Dist_Output_Dir = join(repoRoot, '.dist.mixed-case-parent-stage');
        process.env.Happier_Workspace_Dist_Build_Lock_Held = 'mixed-case-parent-lease';

        try {
            await buildCliBinaryArtifactPayload({
                repoRoot,
                payloadDir,
                cliProxyApiManagedRuntimeExecutablePath: prebuiltManagedRuntimePath,
                ensureWorkspacePackagesBuiltByName: async (_root, packageNames) => ({
                    ok: true,
                    built: [],
                    skipped: packageNames,
                }),
                commandProbe: (command) => command === 'bun' || command === 'yarn',
                runCommand: async (cmd, args, options) => {
                    runCommandCalls.push({ cmd, args, options });
                    await writeRepoFile(join(repoRoot, 'apps', 'cli', 'dist', 'index.mjs'), rebuiltEntrypointContent, newer);
                },
                compileBinary: async ({ entrypoint, outfile }) => {
                    compiledEntrypoints.push(await readFile(entrypoint, 'utf8'));
                    await writeRepoFile(outfile, 'compiled-binary');
                },
            });
        } finally {
            if (previousWorkspaceDistOutputDir === undefined) {
                delete process.env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR;
            } else {
                process.env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR = previousWorkspaceDistOutputDir;
            }
            if (previousMixedCaseWorkspaceDistOutputDir === undefined) {
                delete process.env.Happier_Workspace_Dist_Output_Dir;
            } else {
                process.env.Happier_Workspace_Dist_Output_Dir =
                    previousMixedCaseWorkspaceDistOutputDir;
            }
            if (previousMixedCaseWorkspaceLockLease === undefined) {
                delete process.env.Happier_Workspace_Dist_Build_Lock_Held;
            } else {
                process.env.Happier_Workspace_Dist_Build_Lock_Held =
                    previousMixedCaseWorkspaceLockLease;
            }
        }

        expect(runCommandCalls).toHaveLength(1);
        expect(runCommandCalls[0]?.options?.env?.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR).toBeUndefined();
        expect(runCommandCalls[0]?.options?.env?.Happier_Workspace_Dist_Output_Dir).toBeUndefined();
        expect(runCommandCalls[0]?.options?.env?.Happier_Workspace_Dist_Build_Lock_Held).toBeUndefined();
        const canonicalRepoRoot = await realpath(repoRoot);
        expect(
            parseWorkspaceLockLeaseValue(
                runCommandCalls[0]?.options?.env?.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD,
            ),
        ).toMatchObject({
            path: join(canonicalRepoRoot, '.project', 'tmp', 'cli-dist-build.lock'),
        });
        expect(compiledEntrypoints).toEqual([rebuiltEntrypointContent]);
    });
});
