import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

const { spawnMock } = vi.hoisted(() => ({
    spawnMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
    spawn: spawnMock,
}));

import { compileBunBinary, execOrThrow, resolveBunCommand } from './commands.js';

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
            const yarnShimPath = join(shimDir, 'yarn.cmd');
            mkdirSync(shimDir, { recursive: true });
            writeFileSync(yarnShimPath, '@echo off\r\n', 'utf8');
            arrangeCompletion();

            await execOrThrow('yarn', ['--cwd', 'apps/cli', 'build'], {
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
            expect(String(args[3]).toLowerCase()).toContain(yarnShimPath.toLowerCase());
            expect(String(args[3])).toContain('--cwd');
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
                    args: ['build', '--compile', '--no-cache', '--target=bun-windows-x64', entrypoint, '--outfile', outfile],
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
