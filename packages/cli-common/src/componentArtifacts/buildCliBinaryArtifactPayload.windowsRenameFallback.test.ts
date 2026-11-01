import { existsSync } from 'node:fs';
import { copyFile, cp, mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

import cliDistBuildManifest from '../../cliDistBuildManifest.cjs';

const { renameMock, renameDelegate } = vi.hoisted(() => ({
    renameMock: vi.fn(),
    renameDelegate: { current: null as null | typeof import('node:fs/promises').rename },
}));

vi.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    renameDelegate.current = actual.rename;
    return {
        ...actual,
        rename: renameMock,
    };
});

import { buildCliBinaryArtifactPayload } from './buildCliBinaryArtifactPayload.js';
import { compileBunBinary } from './commands.js';
import { CLI_BINARY_TARGETS, resolveCurrentBinaryTarget } from './targets.js';

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'build-cli-binary-artifact-payload-win32-'));
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

describe('buildCliBinaryArtifactPayload Windows rename fallback', () => {
    afterEach(async () => {
        renameMock.mockReset();
        await Promise.all(tempDirs.splice(0).map(async (dir) => {
            await rm(dir, { recursive: true, force: true });
        }));
    });

    it('preserves Windows discovery sidecars in the compiled runner after a blocked dist rename', async () => {
        const repoRoot = await createTempDir();
        const payloadDir = join(repoRoot, 'artifacts', 'payload');
        const older = new Date('2026-04-13T18:00:00.000Z');
        const newer = new Date('2026-04-13T18:05:00.000Z');
        const cliDir = join(repoRoot, 'apps', 'cli');
        const cliDistDir = join(cliDir, 'dist');
        const abandonedSnapshotDir = join(cliDir, '.dist.hstack-snapshot-abandoned');

        if (!renameDelegate.current) {
            throw new Error('expected node:fs/promises.rename delegate to be initialized');
        }

        renameMock.mockImplementation(async (from, to) => {
            if (from === cliDistDir && String(to).includes('.dist.hstack-snapshot-')) {
                const error = new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`) as NodeJS.ErrnoException;
                error.code = 'EPERM';
                throw error;
            }
            return renameDelegate.current!(from, to);
        });

        await writeRepoFile(join(repoRoot, 'package.json'), `${JSON.stringify({ name: 'repo-root', private: true })}\n`);
        await writeRepoFile(join(repoRoot, 'yarn.lock'), '');
        await writeRepoFile(join(cliDir, 'package.json'), `${JSON.stringify({
            name: '@happier-dev/cli',
            version: '0.0.0',
            bundledDependencies: ['@happier-dev/cli-common'],
            dependencies: {
                '@happier-dev/cli-common': '0.0.0',
                '@huggingface/transformers': '0.0.0',
                'node-pty': '0.0.0',
                '@homebridge/node-pty-prebuilt-multiarch': '0.0.0',
                'ps-list': '8.1.1',
                sharp: '0.0.0',
            },
        }, null, 2)}\n`, older);
        await writeRepoFile(join(cliDir, 'src', 'index.ts'), 'export default "cli-source";\n', older);
        // The release job places the built launcher here; the payload carries it beside the
        // executable and inside the bundled cli-common that node-hosted package-dist resolves.
        const launcherRelativePath = 'native/windows/bin/windows-x64/happier-service-launcher.exe';
        await writeRepoFile(join(repoRoot, 'packages', 'cli-common', 'package.json'), `${JSON.stringify({
            name: '@happier-dev/cli-common',
            version: '0.0.0',
            type: 'module',
            main: './dist/index.js',
            exports: { '.': './dist/index.js' },
            happierWorkspaceBundleFiles: [launcherRelativePath],
        }, null, 2)}\n`, older);
        await writeRepoFile(join(repoRoot, 'packages', 'cli-common', 'dist', 'index.js'), 'export {};\n', older);
        await writeRepoFile(join(repoRoot, 'packages', 'cli-common', ...launcherRelativePath.split('/')), 'launcher fixture', older);
        await writeRepoFile(join(abandonedSnapshotDir, 'index.mjs'), 'export const abandoned = true;\n', older);
        for (const sidecarPath of [
            ['apps', 'cli', 'scripts', 'childProcessOptions.cjs'],
            ['apps', 'cli', 'scripts', 'claude_launcher_runtime.cjs'],
            ['apps', 'cli', 'scripts', 'native_process_exit.cjs'],
            ['apps', 'cli', 'scripts', 'claude_local_launcher.cjs'],
            ['apps', 'cli', 'scripts', 'claude_remote_launcher.cjs'],
            ['apps', 'cli', 'scripts', 'session_hook_forwarder.cjs'],
            ['apps', 'cli', 'scripts', 'permission_hook_forwarder.cjs'],
            ['apps', 'cli', 'scripts', 'ripgrep_launcher.cjs'],
            ['apps', 'cli', 'scripts', 'statusline_forwarder.cjs'],
            ['apps', 'cli', 'scripts', 'terminal_launch_spec_runner.cjs'],
            ['apps', 'cli', 'scripts', 'process_tree.cjs'],
            ['apps', 'cli', 'scripts', 'node_pty_relay.cjs'],
            ['apps', 'cli', 'scripts', 'runtime', 'placeholder.txt'],
            ['apps', 'cli', 'scripts', 'shims', 'placeholder.txt'],
        ]) {
            await writeRepoFile(join(repoRoot, ...sidecarPath), 'placeholder\n', older);
        }
        await writeRepoFile(join(cliDir, 'tools', 'archives', 'checksums.sha256'), '', older);
        await writeRepoFile(join(cliDir, 'scripts', 'unpack-tools.cjs'), `
const fs = require('fs');
const path = require('path');

function unpackTools(options = {}) {
    const toolsDir = options.toolsDir || path.resolve(__dirname, '..', 'tools');
    const unpackedPath = path.join(toolsDir, 'unpacked');
    fs.mkdirSync(unpackedPath, { recursive: true });
    if (!options.tools || options.tools.includes('ripgrep')) {
        fs.writeFileSync(path.join(unpackedPath, 'rg.exe'), 'ripgrep fixture\\n');
        fs.writeFileSync(path.join(unpackedPath, 'ripgrep.node'), 'legacy addon\\n');
    }
    if (!options.tools || options.tools.includes('zellij')) {
        fs.writeFileSync(path.join(unpackedPath, 'zellij.exe'), 'zellij fixture\\n');
    }
}

module.exports = { unpackTools };
`, older);

        for (const packageName of [
            '@huggingface/transformers',
            'node-pty',
            '@homebridge/node-pty-prebuilt-multiarch',
            'sharp',
            '@img/sharp-win32-x64',
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

        // Use the actual dependency and its Windows helper; only execution of the PE file is
        // controlled, so this regression also runs on non-Windows compiler hosts.
        await cp(dirname(createRequire(import.meta.url).resolve('ps-list')),
            join(repoRoot, 'node_modules', 'ps-list'), { recursive: true });
        const probe = join(cliDir, 'probe.mjs');
        await writeRepoFile(probe, `
import process from 'node:process';
import childProcess from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
if (process.argv.includes('--native')) {
    const { default: psList } = await import('ps-list');
    console.log(JSON.stringify((await psList()).some(row => row.pid === process.pid)));
} else {
Object.defineProperty(process, 'platform', { value: 'win32' });
Object.defineProperty(process, 'arch', { value: 'x64' });
// Genuine OS boundary: validate the exact executable path before returning process output.
const execute = () => {};
execute[promisify.custom] = async (command) => {
    if (!existsSync(command)) throw Object.assign(new Error('Missing Windows process-discovery helper: ' + command), { code: 'ENOENT' });
    return { stdout: '123\\t1\\tprobe.exe\\r\\n', stderr: '' };
};
childProcess.execFile = execute;
const { default: psList } = await import('ps-list');
console.log(JSON.stringify(await psList()));
}
`);
        const execute = promisify(execFile);
        const expectedProcesses = [{ pid: 123, ppid: 1, name: 'probe.exe' }];
        expect(JSON.parse((await execute(process.execPath, [probe])).stdout)).toEqual(expectedProcesses);

        await buildCliBinaryArtifactPayload({
            repoRoot,
            payloadDir,
            target: { os: 'windows', arch: 'x64', bunTarget: 'bun-windows-x64', exeExt: '.exe' },
            ensureWorkspacePackagesBuiltByName: async (_root, packageNames) => ({
                ok: true,
                built: [],
                skipped: packageNames,
            }),
            commandProbe: (command) => command === 'bun' || command === 'yarn',
            runCommand: async () => {
                const cliDistEntrypoint = join(cliDistDir, 'index.mjs');
                await writeRepoFile(cliDistEntrypoint, 'export const cli = "fresh";\n', newer);
                cliDistBuildManifest.writeCliDistBuildManifest(cliDistEntrypoint);
            },
            compileBinary: async ({ outfile, externals }) => {
                // Compile only this miniature fixture, using the production owner's external
                // policy and compiler runner. The full CLI and release archive are not built.
                await compileBunBinary({
                    entrypoint: probe,
                    outfile,
                    externals,
                    bunTarget: resolveCurrentBinaryTarget({ availableTargets: CLI_BINARY_TARGETS }).bunTarget,
                    buildRunnerEntrypoint: fileURLToPath(new URL('../../scripts/buildBunBinary.mjs', import.meta.url)),
                    autoloadDotenv: false,
                });
            },
        });

        // Source-checkout resolution must not mask a missing packaged dependency.
        await rm(join(repoRoot, 'node_modules'), { recursive: true });
        expect(JSON.parse((await execute(join(payloadDir, 'happier.exe'), [], { cwd: tmpdir() })).stdout))
            .toEqual(expectedProcesses);

        // Installed channel shortcuts are copies/hardlinks, so the physical runtime
        // root differs from the shortcut's executable directory.
        const installHome = await createTempDir();
        const shortcut = join(installHome, 'bin', 'hprev.exe');
        await mkdir(dirname(shortcut), { recursive: true });
        await copyFile(join(payloadDir, 'happier.exe'), shortcut);
        await cp(join(payloadDir, 'node_modules'), join(installHome, 'cli-preview', 'current', 'node_modules'), { recursive: true });
        expect(JSON.parse((await execute(shortcut, [], { cwd: tmpdir() })).stdout)).toEqual(expectedProcesses);

        if (process.platform !== 'win32') {
            const detached = join(installHome, 'standalone', 'happier');
            await mkdir(dirname(detached), { recursive: true });
            await copyFile(join(payloadDir, 'happier.exe'), detached);
            expect(JSON.parse((await execute(detached, ['--native'], { cwd: tmpdir() })).stdout)).toBe(true);
        }

        await expect(readFile(join(payloadDir, 'package-dist', 'index.mjs'), 'utf8')).resolves.toBe('export const cli = "fresh";\n');
        await expect(readFile(join(cliDistDir, 'index.mjs'), 'utf8')).resolves.toBe('export const cli = "fresh";\n');
        expect(existsSync(join(payloadDir, 'happier.exe'))).toBe(true);
        await expect(readFile(join(payloadDir, 'happier-service-launcher.exe'), 'utf8')).resolves.toBe('launcher fixture');
        await expect(readFile(join(
            payloadDir, 'node_modules', '@happier-dev', 'cli-common', 'native', 'windows', 'bin', 'windows-x64', 'happier-service-launcher.exe',
        ), 'utf8')).resolves.toBe('launcher fixture');
        await expect(readFile(join(payloadDir, 'node_modules', 'sharp', 'index.js'), 'utf8'))
            .resolves.toBe('module.exports = {};\n');
        await expect(readFile(join(payloadDir, 'node_modules', '@img', 'sharp-win32-x64', 'index.js'), 'utf8'))
            .resolves.toBe('module.exports = {};\n');
        await expect(readFile(join(payloadDir, 'scripts', 'process_tree.cjs'), 'utf8')).resolves.toBe('placeholder\n');
        expect(existsSync(join(payloadDir, 'tools', 'unpacked', 'rg.exe'))).toBe(true);
        expect(existsSync(join(payloadDir, 'tools', 'unpacked', 'ripgrep.node'))).toBe(false);
        expect(existsSync(join(payloadDir, 'tools', 'unpacked', 'zellij.exe'))).toBe(false);
        expect(existsSync(abandonedSnapshotDir)).toBe(false);
    }, 120_000);
});
