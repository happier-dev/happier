import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it, vi } from 'vitest';

const spawnSyncMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
    spawnSync: spawnSyncMock,
}));

import { compileBunBinary, execOrThrow, resolveBunCommand } from './commands.js';

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

function withWindowsPlatform<T>(fn: () => T): T {
    if (!originalPlatformDescriptor) {
        throw new Error('Expected process.platform to be configurable for this test');
    }
    Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: 'win32' });
    try {
        return fn();
    } finally {
        Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    }
}

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
    it('routes Windows cmd shims through cmd.exe before spawning', () => {
        withWindowsPlatform(() => {
            spawnSyncMock.mockReturnValue({ status: 0, stderr: '', error: undefined });

            execOrThrow('yarn.cmd', ['build', '--cwd', 'apps/cli'], {
                cwd: '/repo',
                env: {
                    PATH: '/repo/node_modules/.bin',
                    PATHEXT: '.CMD;.EXE',
                },
            });
        });

        expect(spawnSyncMock).toHaveBeenCalledTimes(1);
        expect(spawnSyncMock).toHaveBeenCalledWith(
            'cmd.exe',
            expect.arrayContaining(['/d', '/s', '/c', expect.stringContaining('yarn.cmd')]),
            expect.objectContaining({
                cwd: '/repo',
                env: expect.objectContaining({
                    PATH: '/repo/node_modules/.bin',
                    PATHEXT: '.CMD;.EXE',
                }),
                encoding: 'utf-8',
            }),
        );
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
