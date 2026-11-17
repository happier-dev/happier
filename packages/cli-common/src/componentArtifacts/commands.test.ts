import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnMock, execFileSyncMock } = vi.hoisted(() => ({
    spawnMock: vi.fn(),
    execFileSyncMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
    spawn: spawnMock,
    execFileSync: execFileSyncMock,
}));

import { compileBunBinary, execOrThrow, resolveBunCommand, resolveBunCompilerCommand, resolvePnpmCommand } from './commands.js';
import { compilePrismaMigrateBinary } from './compilePrismaMigrateBinary.js';
import { SERVER_BINARY_TARGETS } from './targets.js';
import { buildServerRuntimeSupportPayload } from './buildServerBinaryArtifactPayload.js';
import { SERVER_PRISMA_CLIENT_QUERY_COMPILER_FILE } from '../firstPartyRuntime/serverRuntimeArtifactLayout.js';

describe('resolvePnpmCommand', () => {
    it('uses pnpm directly when its executable is available', () => {
        expect(resolvePnpmCommand({ commandProbe: command => command === 'pnpm' }))
            .toEqual({ cmd: 'pnpm', args: [] });
    });

    it('requires pnpm even when Corepack or Yarn is available', () => {
        expect(() => resolvePnpmCommand({ commandProbe: command => command === 'corepack' || command === 'yarn' }))
            .toThrow(/requires pnpm/);
    });
});

describe('repository compiler admission', () => {
    it('compiles Prisma with the pinned home Bun when PATH is stale', async () => {
        const repoRoot = mkdtempSync(join(tmpdir(), 'cli-common-prisma-bun-selection-'));
        try {
            const provision = join(repoRoot, 'apps', 'stack', 'scripts', 'provision');
            const home = join(repoRoot, 'home');
            const bin = join(home, '.bun', 'bin');
            const compiler = join(bin, process.platform === 'win32' ? 'bun.exe' : 'bun');
            mkdirSync(provision, { recursive: true });
            mkdirSync(bin, { recursive: true });
            writeFileSync(join(provision, '.bun-version'), '1.4.4\n');
            writeFileSync(compiler, '', { mode: 0o755 });
            execFileSyncMock.mockImplementation((command: string) => command === compiler ? '1.4.4\n' : '1.3.5\n');
            const outfile = join(repoRoot, 'runtime', 'prisma-migrate');

            await compilePrismaMigrateBinary({
                repoRoot, target: SERVER_BINARY_TARGETS[0]!, outfile,
                env: { HOME: home, USERPROFILE: home }, commandProbe: () => true,
                runCommand: async (command) => {
                    expect(command).toBe(compiler);
                    writeFileSync(outfile, 'compiled');
                },
            });
            expect(existsSync(outfile)).toBe(true);
        } finally {
            rmSync(repoRoot, { recursive: true, force: true });
            execFileSyncMock.mockReset();
        }
    });

    it('enforces this checkout pin when the caller omits repoRoot', async () => {
        execFileSyncMock.mockReturnValue('0.0.0\n');
        try {
            await expect(compileBunBinary({
                bunCommand: 'bun', entrypoint: 'index.mjs', outfile: 'happier',
                bunTarget: 'bun-linux-x64-baseline',
                runCommand: () => { throw new Error('Compiler ran before admission'); },
            })).rejects.toThrow(/requires Bun/);
        } finally {
            execFileSyncMock.mockReset();
        }
    });

    it.each(['compiler', 'server-runtime-support'] as const)('refuses an unpinned Prisma compiler through %s', async (entrypoint) => {
        const repoRoot = mkdtempSync(join(tmpdir(), 'cli-common-prisma-bun-pin-'));
        try {
            const provision = join(repoRoot, 'apps', 'stack', 'scripts', 'provision');
            mkdirSync(provision, { recursive: true });
            writeFileSync(join(provision, '.bun-version'), '1.4.4\n');
            execFileSyncMock.mockReturnValue('1.3.11\n');

            const target = SERVER_BINARY_TARGETS[0]!;
            const runCommand = () => { throw new Error('Prisma compiler ran before admission'); };
            if (entrypoint === 'compiler') {
                await expect(compilePrismaMigrateBinary({
                    repoRoot, bunCommand: 'bun', target,
                    outfile: join(repoRoot, 'runtime', 'prisma-migrate'), runCommand,
                })).rejects.toThrow(/requires Bun 1\.4\.4/);
            } else {
                const client = join(repoRoot, 'client');
                mkdirSync(client);
                writeFileSync(join(client, SERVER_PRISMA_CLIENT_QUERY_COMPILER_FILE), 'compiler');
                await expect(buildServerRuntimeSupportPayload({
                    repoRoot, target, payloadDir: join(repoRoot, 'payload'), buildDbProviders: 'postgresql',
                    entries: [
                        { sourcePath: client, targetPath: join('node_modules', '.prisma', 'client') },
                        { sourcePath: client, targetPath: join('generated', 'postgresql-client') },
                    ],
                    commandProbe: command => command === 'bun', runCommand,
                })).rejects.toThrow(/requires Bun 1\.4\.4/);
            }
        } finally {
            rmSync(repoRoot, { recursive: true, force: true });
            execFileSyncMock.mockReset();
        }
    });

    it.each(['1.3.11', '1.4.2', 'not-a-version'])('rejects compiler %s before building a repository pinned to 1.4.4', async (version) => {
        const repoRoot = mkdtempSync(join(tmpdir(), 'cli-common-bun-pin-'));
        try {
            const provision = join(repoRoot, 'apps', 'stack', 'scripts', 'provision');
            mkdirSync(provision, { recursive: true });
            writeFileSync(join(provision, '.bun-version'), '1.4.4\n');
            execFileSyncMock.mockReturnValue(`${version}\n`);

            await expect(compileBunBinary({
                repoRoot, bunCommand: 'bun', entrypoint: join(repoRoot, 'index.mjs'),
                outfile: join(repoRoot, 'happier'), bunTarget: 'bun-linux-x64-baseline',
                runCommand: async () => { throw new Error('Compiler ran before admission'); },
            })).rejects.toThrow(/requires Bun 1\.4\.4/);
        } finally {
            rmSync(repoRoot, { recursive: true, force: true });
            execFileSyncMock.mockReset();
        }
    });

    it('admits the pinned explicit compiler', async () => {
        const repoRoot = mkdtempSync(join(tmpdir(), 'cli-common-bun-pin-'));
        try {
            const provision = join(repoRoot, 'apps', 'stack', 'scripts', 'provision');
            const bunPath = join(repoRoot, process.platform === 'win32' ? 'bun.exe' : 'bun');
            mkdirSync(provision, { recursive: true });
            writeFileSync(join(provision, '.bun-version'), '1.4.4\n');
            writeFileSync(bunPath, '', { mode: 0o755 });
            execFileSyncMock.mockReturnValue('1.4.4\n');

            const outfile = join(repoRoot, 'happier');
            await compileBunBinary({
                repoRoot, bunCommand: bunPath, entrypoint: join(repoRoot, 'index.mjs'),
                outfile, bunTarget: 'bun-linux-x64-baseline',
                // Compilation is the external process boundary; retain real admission and output validation.
                runCommand: async () => { writeFileSync(outfile, 'compiled'); },
            });
            expect(existsSync(outfile)).toBe(true);
        } finally {
            rmSync(repoRoot, { recursive: true, force: true });
            execFileSyncMock.mockReset();
        }
    });
});

describe.each(['linux', 'win32'] as const)('resolveBunCompilerCommand (%s)', (platform) => {
    let repoRoot: string;
    let homeBun: string;
    let installBun: string;
    let processEnv: NodeJS.ProcessEnv;

    beforeEach(() => {
        repoRoot = mkdtempSync(join(tmpdir(), 'cli-common-bun-selection-'));
        const provision = join(repoRoot, 'apps', 'stack', 'scripts', 'provision');
        mkdirSync(provision, { recursive: true });
        writeFileSync(join(provision, '.bun-version'), '1.4.4\n');
        const home = join(repoRoot, 'home');
        const install = join(repoRoot, 'custom-install');
        const executable = platform === 'win32' ? 'bun.exe' : 'bun';
        homeBun = join(home, '.bun', 'bin', executable);
        installBun = join(install, 'bin', executable);
        for (const candidate of [homeBun, installBun]) {
            mkdirSync(join(candidate, '..'), { recursive: true });
            writeFileSync(candidate, '', { mode: 0o755 });
        }
        processEnv = { HOME: home, USERPROFILE: home, BUN_INSTALL: install };
    });

    afterEach(() => {
        rmSync(repoRoot, { recursive: true, force: true });
        execFileSyncMock.mockReset();
    });

    it('prefers the pinned home compiler over stale PATH and a matching BUN_INSTALL', () => {
        execFileSyncMock.mockImplementation((command: string) => command === 'bun' ? '1.3.5\n' : '1.4.4\n');

        expect(resolveBunCompilerCommand({
            repoRoot, platform, processEnv, commandProbe: () => true,
        })).toBe(homeBun);
        // Stop probing as soon as the required compiler is found.
        expect(execFileSyncMock).toHaveBeenCalledTimes(2);
    });

    it('keeps a pinned PATH compiler without launching fallback probes', () => {
        execFileSyncMock.mockReturnValue('1.4.4\n');

        expect(resolveBunCompilerCommand({
            repoRoot, platform, processEnv, commandProbe: () => true,
        })).toBe('bun');
        expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    });

    it('continues to BUN_INSTALL when PATH and home are both stale', () => {
        execFileSyncMock.mockImplementation((command: string) => command === installBun ? '1.4.4\n' : '1.3.5\n');

        expect(resolveBunCompilerCommand({
            repoRoot, platform, processEnv, commandProbe: () => true,
        })).toBe(installBun);
    });

    it('also checks candidates when a builder passes its discovered PATH command', () => {
        execFileSyncMock.mockImplementation((command: string) => command === homeBun ? '1.4.4\n' : '1.3.5\n');

        expect(resolveBunCompilerCommand({
            repoRoot, platform, processEnv, bunCommand: 'bun', commandProbe: () => true,
        })).toBe(homeBun);
    });

    it('rejects a mismatched explicit environment override despite a pinned home compiler', () => {
        execFileSyncMock.mockImplementation((command: string) => command === homeBun ? '1.4.4\n' : '1.3.5\n');

        expect(() => resolveBunCompilerCommand({
            repoRoot, platform, processEnv: { ...processEnv, HAPPIER_BUN_PATH: installBun },
            commandProbe: () => true,
        })).toThrow(/requires Bun 1\.4\.4/);
        expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    });

    it('preserves mismatch rejection when no candidate matches', () => {
        execFileSyncMock.mockReturnValue('1.3.5\n');

        expect(() => resolveBunCompilerCommand({
            repoRoot, platform, processEnv, commandProbe: () => true,
        })).toThrow(/requires Bun 1\.4\.4; selected bun reports 1\.3\.5/);
    });

    it('refuses an exact running compiler even when an environment override matches', () => {
        execFileSyncMock.mockImplementation((command: string) => command === homeBun ? '1.4.4\n' : '1.3.5\n');

        expect(() => resolveBunCompilerCommand({
            repoRoot, platform, bunCommand: installBun,
            processEnv: { ...processEnv, HAPPIER_BUN_PATH: homeBun }, commandProbe: () => true,
        })).toThrow(/requires Bun 1\.4\.4/);
        expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    });
});

describe('resolveBunCommand', () => {
    it('expands ~/ explicit bun overrides against HOME', () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'cli-common-bun-override-'));
        try {
            const homeDir = join(tempRoot, 'home');
            const bunPath = join(homeDir, 'custom-tools', 'bun', process.platform === 'win32' ? 'bun.exe' : 'bun');
            mkdirSync(join(homeDir, 'custom-tools', 'bun'), { recursive: true });
            writeFileSync(bunPath, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n', {
                mode: 0o755,
            });

            expect(resolveBunCommand({
                processEnv: {
                    HOME: homeDir,
                    USERPROFILE: homeDir,
                    HAPPIER_BUN_PATH: `~/custom-tools/bun/${process.platform === 'win32' ? 'bun.exe' : 'bun'}`,
                },
                commandProbe: () => false,
            })).toBe(bunPath);
        } finally {
            rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('resolves bun from BUN_INSTALL when bun is not on PATH', () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'cli-common-bun-install-'));
        try {
            const bunInstallDir = join(tempRoot, '.bun');
            const bunBinDir = join(bunInstallDir, 'bin');
            const bunPath = join(bunBinDir, process.platform === 'win32' ? 'bun.exe' : 'bun');
            mkdirSync(bunBinDir, { recursive: true });
            writeFileSync(bunPath, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n', {
                mode: 0o755,
            });

            expect(resolveBunCommand({
                processEnv: {
                    BUN_INSTALL: bunInstallDir,
                },
                commandProbe: () => false,
            })).toBe(bunPath);
        } finally {
            rmSync(tempRoot, { recursive: true, force: true });
        }
    });
});

describe('execOrThrow', () => {
    const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

    function createChildProcess() {
        const child = new EventEmitter() as EventEmitter & {
            stdout: PassThrough;
            stderr: PassThrough;
            stdin: PassThrough;
            kill: ReturnType<typeof vi.fn>;
        };
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.stdin = new PassThrough();
        child.kill = vi.fn();
        return child;
    }

    function arrangeCompletion({ code = 0, stderr = '' }: { code?: number | null; stderr?: string } = {}) {
        const child = createChildProcess();
        spawnMock.mockReturnValue(child);
        queueMicrotask(() => {
            if (stderr) child.stderr.write(stderr);
            child.emit('close', code, null);
        });
        return child;
    }

    afterEach(() => {
        spawnMock.mockReset();
        if (originalPlatformDescriptor) {
            Object.defineProperty(process, 'platform', originalPlatformDescriptor);
        }
    });

    it('returns an asynchronous completion instead of blocking its owner process', async () => {
        arrangeCompletion();

        const completion = execOrThrow(process.execPath, ['--version'], { stdio: 'pipe' });

        expect(completion).toBeInstanceOf(Promise);
        await completion;
    });

    it('preserves explicit stdout and stderr modes when piping command input', async () => {
        const child = arrangeCompletion();

        await execOrThrow('minisign', ['-S'], {
            stdio: ['pipe', 'inherit', 'inherit'],
            input: 'passphrase\n',
        });

        expect(spawnMock).toHaveBeenCalledTimes(1);
        expect(spawnMock.mock.calls[0]?.[2]).toEqual(expect.objectContaining({
            stdio: ['pipe', 'inherit', 'inherit'],
        }));
        expect(child.stdin.read()).toEqual(Buffer.from('passphrase\n'));
    });

    it('wraps Windows shell shims through cmd.exe before spawning', async () => {
        if (!originalPlatformDescriptor) {
            throw new Error('Expected process.platform to be configurable for this test');
        }
        Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: 'win32' });
        const tempRoot = mkdtempSync(join(tmpdir(), 'cli-common-win32-cmd-shim-'));

        try {
            const shimDir = join(tempRoot, 'node_modules', '.bin');
            const pnpmShimPath = join(shimDir, 'pnpm.cmd');
            mkdirSync(shimDir, { recursive: true });
            writeFileSync(pnpmShimPath, '@echo off\r\n', 'utf8');
            arrangeCompletion();

            await execOrThrow('pnpm', ['--dir', 'apps/cli', 'run', 'build'], {
                cwd: 'C:\\repo',
                env: {
                    PATH: shimDir,
                    PATHEXT: '.CMD;.EXE',
                    ComSpec: 'C:\\Windows\\System32\\cmd.exe',
                } as NodeJS.ProcessEnv,
                stdio: 'pipe',
            });

            expect(spawnMock).toHaveBeenCalledTimes(1);
            const [command, args, options] = spawnMock.mock.calls[0] ?? [];
            expect(command).toBe('C:\\Windows\\System32\\cmd.exe');
            expect(args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
            expect(String(args[3]).toLowerCase()).toContain(pnpmShimPath.toLowerCase());
            expect(String(args[3])).toContain('--dir');
            expect(String(args[3])).toContain('apps/cli');
            expect(String(args[3])).toContain('build');
            expect(options).toEqual(expect.objectContaining({
                cwd: 'C:\\repo',
                stdio: 'pipe',
                windowsVerbatimArguments: true,
            }));
        } finally {
            rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('terminates and rejects a command that exceeds timeoutMs', async () => {
        const child = createChildProcess();
        spawnMock.mockReturnValue(child);

        await expect(execOrThrow('tar', ['--version'], {
            cwd: process.cwd(),
            stdio: 'pipe',
            timeoutMs: 1,
        })).rejects.toMatchObject({ code: 'ETIMEDOUT' });

        expect(spawnMock).toHaveBeenCalledTimes(1);
        expect(child.kill).toHaveBeenCalledTimes(1);
    });

    it('preserves process error code for timeout-aware callers', async () => {
        const processError = Object.assign(new Error('spawn tar ETIMEDOUT'), { code: 'ETIMEDOUT' });
        spawnMock.mockImplementationOnce(() => {
            throw processError;
        });

        await expect(execOrThrow('tar', ['-czf', 'artifact.tar.gz', 'payload'], {
            stdio: 'pipe',
            timeoutMs: 1,
        })).rejects.toMatchObject({
            code: 'ETIMEDOUT',
        });
    });
});

describe('compileBunBinary', () => {
    beforeEach(() => {
        // Compiler version probing is an OS boundary; retain the real pin reader.
        execFileSyncMock.mockReturnValue(readFileSync(new URL('../../../../apps/stack/scripts/provision/.bun-version', import.meta.url), 'utf8'));
    });

    afterEach(() => execFileSyncMock.mockReset());

    it('controls package metadata loading independently of ambient executable configuration', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'cli-common-bun-config-'));
        try {
            const entrypoint = join(tempRoot, 'index.mjs');
            const outfile = join(tempRoot, 'happier-runner');
            writeFileSync(entrypoint, 'console.log("ok");\n', 'utf8');

            const calls: Array<{ cmd: string; args: string[] }> = [];
            await compileBunBinary({
                entrypoint,
                bunTarget: 'bun-linux-x64-baseline',
                outfile,
                bunCommand: 'bun',
                autoloadDotenv: false,
                autoloadBunfig: false,
                autoloadPackageJson: true,
                defines: { 'process.env.NODE_ENV': '"production"' },
                runCommand: async (cmd, args) => {
                    calls.push({ cmd, args });
                    writeFileSync(outfile, 'compiled', 'utf8');
                },
            });

            expect(calls[0]?.args).toContain('--no-compile-autoload-dotenv');
            expect(calls[0]?.args).toContain('--no-compile-autoload-bunfig');
            expect(calls[0]?.args).toContain('--compile-autoload-package-json');
            expect(calls[0]?.args).toContain('--define=process.env.NODE_ENV="production"');
        } finally {
            rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('passes --no-cache for release binary compilation', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'cli-common-bun-compile-'));
        try {
            const entrypoint = join(tempRoot, 'index.mjs');
            const outfile = join(tempRoot, 'happier.exe');
            writeFileSync(entrypoint, 'console.log("ok");\n', 'utf8');

            const calls: Array<{ cmd: string; args: string[]; cwd?: string }> = [];
            await compileBunBinary({
                entrypoint,
                bunTarget: 'bun-windows-x64',
                outfile,
                bunCommand: 'bun',
                runCommand: async (cmd, args, options) => {
                    calls.push({ cmd, args, cwd: options?.cwd });
                    writeFileSync(outfile, 'compiled', 'utf8');
                },
            });

            expect(calls).toEqual([
                {
                    cmd: 'bun',
                    args: ['build', '--compile', '--no-cache', '--target=bun-windows-x64', entrypoint, '--outfile', outfile, '--no-compile-autoload-bunfig'],
                    cwd: process.cwd(),
                },
            ]);
        } finally {
            rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('delegates compilation to a package-owned Bun build runner when provided', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'cli-common-bun-runner-'));
        try {
            const entrypoint = join(tempRoot, 'index.mjs');
            const outfile = join(tempRoot, 'happier-server');
            const buildRunnerEntrypoint = join(tempRoot, 'build-server.mjs');
            writeFileSync(entrypoint, 'console.log("ok");\n', 'utf8');

            const calls: Array<{ cmd: string; args: string[] }> = [];
            await compileBunBinary({
                entrypoint,
                bunTarget: 'bun-linux-x64-baseline',
                outfile,
                externals: ['redis'],
                bunCommand: 'bun',
                buildRunnerEntrypoint,
                runCommand: async (cmd, args) => {
                    calls.push({ cmd, args });
                    writeFileSync(outfile, 'compiled', 'utf8');
                },
            });

            expect(calls).toEqual([{
                cmd: 'bun',
                args: [
                    buildRunnerEntrypoint,
                    '--target=bun-linux-x64-baseline',
                    `--entrypoint=${entrypoint}`,
                    `--outfile=${outfile}`,
                    '--no-compile-autoload-bunfig',
                    '--external=redis',
                ],
            }]);
        } finally {
            rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('retries and clears transient Bun executable extraction failures', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'cli-common-bun-compile-retry-'));
        const originalBunInstall = process.env.BUN_INSTALL;
        try {
            const entrypoint = join(tempRoot, 'index.mjs');
            const outfile = join(tempRoot, 'happier.exe');
            const cacheEntry = join(tempRoot, '.bun', 'install', 'cache', 'bun-windows-x64-baseline');
            mkdirSync(cacheEntry, { recursive: true });
            writeFileSync(entrypoint, 'console.log("ok");\n', 'utf8');
            writeFileSync(join(cacheEntry, 'partial'), 'broken', 'utf8');
            process.env.BUN_INSTALL = join(tempRoot, '.bun');

            const calls: Array<{ cmd: string; args: string[]; cwd?: string }> = [];
            await compileBunBinary({
                entrypoint,
                bunTarget: 'bun-windows-x64-baseline',
                outfile,
                bunCommand: 'bun',
                maxAttempts: 2,
                runCommand: (cmd, args, options) => {
                    calls.push({ cmd, args, cwd: options?.cwd });
                    if (calls.length === 1) {
                        throw new Error("Failed to extract executable for 'bun-windows-x64-baseline': download may be incomplete");
                    }
                    writeFileSync(outfile, 'compiled', 'utf8');
                },
            });

            expect(calls).toHaveLength(2);
            expect(existsSync(cacheEntry)).toBe(false);
        } finally {
            if (typeof originalBunInstall === 'string') {
                process.env.BUN_INSTALL = originalBunInstall;
            } else {
                delete process.env.BUN_INSTALL;
            }
            rmSync(tempRoot, { recursive: true, force: true });
        }
    });
});
