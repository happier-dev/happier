import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it, vi } from 'vitest';

const { spawnSyncMock } = vi.hoisted(() => ({
    spawnSyncMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
    spawnSync: spawnSyncMock,
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

    afterEach(() => {
        spawnSyncMock.mockReset();
        if (originalPlatformDescriptor) {
            Object.defineProperty(process, 'platform', originalPlatformDescriptor);
        }
    });

    it('wraps Windows shell shims through cmd.exe before spawning', () => {
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
            spawnSyncMock.mockReturnValue({ status: 0, stderr: '' });

            execOrThrow('yarn', ['--cwd', 'apps/cli', 'build'], {
                cwd: 'C:\\repo',
                env: {
                    PATH: shimDir,
                    PATHEXT: '.CMD;.EXE',
                    ComSpec: 'C:\\Windows\\System32\\cmd.exe',
                } as NodeJS.ProcessEnv,
                stdio: 'pipe',
            });

            expect(spawnSyncMock).toHaveBeenCalledTimes(1);
            const [command, args, options] = spawnSyncMock.mock.calls[0] ?? [];
            expect(command).toBe('C:\\Windows\\System32\\cmd.exe');
            expect(args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
            expect(String(args[3]).toLowerCase()).toContain(yarnShimPath.toLowerCase());
            expect(String(args[3])).toContain('--cwd');
            expect(String(args[3])).toContain('apps/cli');
            expect(String(args[3])).toContain('build');
            expect(options).toEqual(expect.objectContaining({
                cwd: 'C:\\repo',
                encoding: 'utf-8',
                stdio: 'pipe',
                windowsVerbatimArguments: true,
            }));
        } finally {
            rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('forwards timeoutMs to the spawned process timeout option', () => {
        spawnSyncMock.mockReturnValue({ status: 0, stderr: '' });

        execOrThrow('tar', ['--version'], {
            cwd: process.cwd(),
            stdio: 'pipe',
            timeoutMs: 1234,
        });

        expect(spawnSyncMock).toHaveBeenCalledTimes(1);
        const [, , options] = spawnSyncMock.mock.calls[0] ?? [];
        expect(options).toEqual(expect.objectContaining({
            timeout: 1234,
            stdio: 'pipe',
            encoding: 'utf-8',
        }));
    });

    it('preserves process error code for timeout-aware callers', () => {
        const processError = Object.assign(new Error('spawnSync tar ETIMEDOUT'), { code: 'ETIMEDOUT' });
        spawnSyncMock.mockReturnValue({ error: processError });

        expect(() => execOrThrow('tar', ['-czf', 'artifact.tar.gz', 'payload'], {
            stdio: 'pipe',
            timeoutMs: 1,
        })).toThrowError(expect.objectContaining({
            code: 'ETIMEDOUT',
        }));
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
});
