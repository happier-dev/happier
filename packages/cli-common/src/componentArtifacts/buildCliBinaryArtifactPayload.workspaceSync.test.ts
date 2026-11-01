import { mkdtemp, mkdir, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { afterEach, describe, expect, it } from 'vitest';

import cliDistBuildManifest from '../../cliDistBuildManifest.cjs';
import { buildCliBinaryArtifactPayload } from './buildCliBinaryArtifactPayload.js';

const tempDirs: string[] = [];
const sourceRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

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
    const cliSourceFiles = (await collectFiles(join(sourceRepoRoot, 'apps', 'cli', 'src')))
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
    if (!options.tools || options.tools.includes('ripgrep')) {
        fs.writeFileSync(path.join(unpackedPath, platformDir === 'x64-win32' ? 'rg.exe' : 'rg'), 'ripgrep for ' + platformDir + '\\n');
        fs.writeFileSync(path.join(unpackedPath, 'ripgrep.node'), 'legacy addon\\n');
    }
    if (!options.tools || options.tools.includes('zellij')) {
        const binaryName = platformDir === 'x64-win32' ? 'zellij.exe' : 'zellij';
        fs.writeFileSync(path.join(unpackedPath, binaryName), 'zellij 0.44.3 for ' + platformDir + '\\n');
    }
    if (!options.tools || options.tools.includes('difftastic')) {
        fs.writeFileSync(path.join(unpackedPath, 'difft'), 'difftastic optional runtime\\n');
    }
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

    it('rebuilds a stale-version cli dist and forwards the exact release version', async () => {
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
                sharp: '0.0.0',
            },
        }, null, 2)}\n`, older);
        const cliDistEntrypoint = join(repoRoot, 'apps', 'cli', 'dist', 'index.mjs');
        await writeRepoFile(cliDistEntrypoint, 'export default "cli-entrypoint";\n', newer);
        cliDistBuildManifest.writeCliDistBuildManifest(cliDistEntrypoint, { buildVersion: '0.2.10' });
        await writeRepoFile(join(repoRoot, 'apps', 'cli', 'src', 'index.ts'), 'export default "cli-source";\n', older);
        const staticRuntimeScriptAssets = await collectStaticRuntimeScriptAssetSegments();
        const sidecarPaths = [
            ['apps', 'cli', 'scripts', 'childProcessOptions.cjs'],
            ['apps', 'cli', 'scripts', 'claude_launcher_runtime.cjs'],
            ['apps', 'cli', 'scripts', 'claude_local_launcher.cjs'],
            ['apps', 'cli', 'scripts', 'claude_remote_launcher.cjs'],
            ['apps', 'cli', 'scripts', 'session_hook_forwarder.cjs'],
            ['apps', 'cli', 'scripts', 'permission_hook_forwarder.cjs'],
            ['apps', 'cli', 'scripts', 'ripgrep_launcher.cjs'],
            // On-disk launchers still need this packaged sidecar even when CLI consumers embed it.
            ['apps', 'cli', 'scripts', 'process_tree.cjs'],
            ...staticRuntimeScriptAssets.map((segments) => ['apps', 'cli', 'scripts', ...segments]),
            ['apps', 'cli', 'scripts', 'runtime', 'placeholder.txt'],
            ['apps', 'cli', 'scripts', 'shims', 'placeholder.txt'],
        ];
        for (const sidecarPath of new Map(sidecarPaths.map((path) => [path.join('/'), path])).values()) {
            await writeRepoFile(join(repoRoot, ...sidecarPath), 'placeholder\n', older);
        }
        // Import the real installed launcher, including its transitive native-exit dependency.
        for (const script of ['claude_launcher_runtime.cjs', 'childProcessOptions.cjs', 'native_process_exit.cjs']) {
            await writeRepoFile(join(repoRoot, 'apps', 'cli', 'scripts', script),
                await readFile(join(sourceRepoRoot, 'apps', 'cli', 'scripts', script), 'utf8'), older);
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
                './expandHomeDirPath': './expandHomeDirPath.cjs',
            },
        }, null, 2)}\n`);
        await writeRepoFile(join(repoRoot, 'packages', 'cli-common', 'README.md'), 'cli-common');
        await writeRepoFile(join(repoRoot, 'packages', 'cli-common', 'expandHomeDirPath.cjs'),
            await readFile(join(sourceRepoRoot, 'packages', 'cli-common', 'expandHomeDirPath.cjs'), 'utf8'), older);
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
                './expandHomeDirPath': './expandHomeDirPath.cjs',
            },
        }, null, 2)}\n`);
        await writeRepoFile(join(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'cli-common', 'dist', 'index.js'), 'export {};\n', older);
        await writeRepoFile(join(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'cli-common', 'dist', 'firstPartyRuntime', 'index.js'), 'export {};\n', older);
        await writeRepoFile(bundledWorkspaceInstallPath, staleBundledContent, older);
        for (const packageName of [
            '@huggingface/transformers',
            'node-pty',
            '@homebridge/node-pty-prebuilt-multiarch',
            'sharp',
            '@img/sharp-darwin-arm64',
            '@img/sharp-libvips-darwin-arm64',
        ]) {
            await writeRepoFile(
                join(repoRoot, 'node_modules', ...packageName.split('/'), 'package.json'),
                `${JSON.stringify({
                    name: packageName,
                    version: '0.0.0',
                    main: './index.js',
                }, null, 2)}\n`,
                older,
            );
            await writeRepoFile(join(repoRoot, 'node_modules', ...packageName.split('/'), 'index.js'), 'module.exports = {};\n', older);
        }

        const compileObservedContents: string[] = [];
        const buildVersions: string[] = [];
        for (const key of ['darwin-arm64', 'linux-x64', 'win32-x64']) {
            await writeRepoFile(join(repoRoot, 'node_modules', 'node-pty', 'prebuilds', key, 'pty.node'), key, older);
        }

        await buildCliBinaryArtifactPayload({
            repoRoot,
            payloadDir,
            target: { os: 'darwin', arch: 'arm64', bunTarget: 'bun-darwin-arm64', exeExt: '' },
            releaseVersion: '0.2.10-dev.61',
            ensureWorkspacePackagesBuiltByName: async (_root, packageNames) => ({
                ok: true,
                built: [],
                skipped: packageNames,
            }),
            commandProbe: (command) => command === 'bun' || command === 'yarn',
            runCommand: (_command, _args, options) => {
                buildVersions.push(String(options?.env?.HAPPIER_CLI_BUILD_VERSION ?? ''));
                mkdirSync(dirname(cliDistEntrypoint), { recursive: true });
                writeFileSync(cliDistEntrypoint, 'export default "release-cli-entrypoint";\n', 'utf8');
                cliDistBuildManifest.writeCliDistBuildManifest(cliDistEntrypoint, {
                    buildVersion: '0.2.10-dev.61',
                });
            },
            compileBinary: async ({ outfile }) => {
                compileObservedContents.push(await readFile(bundledWorkspaceInstallPath, 'utf8'));
                await writeRepoFile(outfile, 'compiled-binary');
            },
        });

        expect(buildVersions).toEqual(['0.2.10-dev.61']);
        await expect(readFile(join(payloadDir, 'node_modules', 'sharp', 'index.js'), 'utf8'))
            .resolves.toBe('module.exports = {};\n');
        await expect(readFile(join(payloadDir, 'node_modules', '@img', 'sharp-darwin-arm64', 'index.js'), 'utf8'))
            .resolves.toBe('module.exports = {};\n');
        await expect(readFile(join(payloadDir, 'node_modules', '@img', 'sharp-libvips-darwin-arm64', 'index.js'), 'utf8'))
            .resolves.toBe('module.exports = {};\n');
        expect(compileObservedContents).toEqual([currentSourceContent]);
        const requireFromPayload = createRequire(join(payloadDir, 'scripts', 'claude_remote_launcher.cjs'));
        expect(requireFromPayload('./claude_launcher_runtime.cjs')).toHaveProperty('runClaudeCli', expect.any(Function));
        expect(await readdir(join(payloadDir, 'node_modules', 'node-pty', 'prebuilds'))).toEqual(['darwin-arm64']);
        await expect(readFile(join(payloadDir, 'node_modules', '@huggingface', 'transformers', 'index.js'), 'utf8'))
            .rejects.toMatchObject({ code: 'ENOENT' });
        await expect(readFile(join(payloadDir, 'tools', 'unpacked', 'difft'), 'utf8'))
            .rejects.toMatchObject({ code: 'ENOENT' });
        await expect(readFile(join(payloadDir, 'node_modules', '@happier-dev', 'cli-common', 'dist', 'firstPartyRuntime', 'installVersionedPayload.js'), 'utf8'))
            .resolves.toBe(currentSourceContent);
        for (const segments of staticRuntimeScriptAssets) {
            await expect(readFile(join(payloadDir, 'scripts', ...segments), 'utf8'))
                .resolves.toBe('placeholder\n');
        }
        await expect(readFile(join(payloadDir, 'tools', 'unpacked', '.happier-tools-manifest.json'), 'utf8'))
            .resolves.toContain('"zellij"');
        await expect(readFile(join(payloadDir, 'tools', 'unpacked', 'rg'), 'utf8'))
            .resolves.toContain('ripgrep');
        await expect(readFile(join(payloadDir, 'tools', 'unpacked', 'zellij'), 'utf8'))
            .resolves.toContain('zellij');
        await expect(readFile(join(payloadDir, 'tools', 'unpacked', 'ripgrep.node'), 'utf8'))
            .rejects.toMatchObject({ code: 'ENOENT' });
    });

});
