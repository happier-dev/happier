import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import * as childProcess from 'node:child_process';

// Observe the OS spawn boundary while still launching the real fixture processes.
vi.mock('node:child_process', async importOriginal => {
    const actual = await importOriginal<typeof import('node:child_process')>();
    return { ...actual, spawn: vi.fn(actual.spawn) };
});

it.each(['before-start', 'during-setup'] as const)('does not spawn local Claude when cancelled %s', async phase => {
    vi.resetModules();
    const directory = mkdtempSync(join(tmpdir(), 'happier-claude-local-cancel-'));
    const executable = join(directory, 'provider.cjs');
    const env = createEnvKeyScope(['HAPPIER_CLAUDE_PATH', 'CLAUDE_CONFIG_DIR']);
    const stdinWasPaused = process.stdin.isPaused();
    writeFileSync(executable, 'process.exit(0);\n');
    env.patch({ HAPPIER_CLAUDE_PATH: executable, CLAUDE_CONFIG_DIR: join(directory, 'config') });
    const abort = new AbortController();
    if (phase === 'before-start') abort.abort();
    try {
        const { claudeLocal } = await import('./claudeLocal');
        vi.mocked(childProcess.spawn).mockClear();
        await claudeLocal({ abort: abort.signal, sessionId: null, path: directory,
            onSessionFound: () => { if (phase === 'during-setup') abort.abort(); } });
        expect(vi.mocked(childProcess.spawn).mock.calls.length).toBe(0);
    } finally {
        env.restore();
        if (stdinWasPaused) process.stdin.pause();
        rmSync(directory, { recursive: true, force: true });
    }
});

it.each([
    { kind: 'native', callbackFails: false },
    { kind: 'javascript', callbackFails: false },
    { kind: 'native', callbackFails: true },
] as const)('qualifies the real local $kind provider exit (callback fails: $callbackFails)', async ({ kind, callbackFails }) => {
    if (process.platform === 'win32' && kind === 'native') return; // Shebang executable is a POSIX OS fixture.
    vi.resetModules();
    const directory = mkdtempSync(join(tmpdir(), 'happier-claude-local-exit-'));
    const executable = join(directory, kind === 'javascript' ? 'provider.cjs' : 'provider');
    const env = createEnvKeyScope(['HAPPIER_CLAUDE_PATH', 'CLAUDE_CONFIG_DIR']);
    const stdinWasPaused = process.stdin.isPaused();
    writeFileSync(executable, `${kind === 'native' ? `#!${process.execPath}\n` : ''}process.exit(0);\n`, { mode: 0o700 });
    env.patch({ HAPPIER_CLAUDE_PATH: executable, CLAUDE_CONFIG_DIR: join(directory, 'config') });
    const exits: Array<Readonly<{ providerStopped: boolean }>> = [];
    try {
        const { claudeLocal } = await import('./claudeLocal');
        const failure = new Error('Exit observer failed');
        const launch = claudeLocal({ abort: new AbortController().signal, sessionId: null, path: directory,
            onSessionFound: () => {}, onProcessExit: result => { exits.push(result); if (callbackFails) throw failure; } });
        if (callbackFails) await expect(launch).rejects.toBe(failure);
        else await launch;
        expect(exits).toEqual([{ providerStopped: true }]);
    } finally {
        env.restore();
        if (stdinWasPaused) process.stdin.pause();
        rmSync(directory, { recursive: true, force: true });
    }
});

it('reports an actual command-wrapper exit without claiming native provider stop', async () => {
    if (process.platform === 'win32') return; // POSIX OS executable models the Windows shell boundary.
    vi.resetModules();
    const directory = mkdtempSync(join(tmpdir(), 'happier-claude-local-wrapper-'));
    const executable = join(directory, 'claude.cmd');
    const shell = join(directory, 'cmd.exe');
    const env = createEnvKeyScope(['HAPPIER_CLAUDE_PATH', 'CLAUDE_CONFIG_DIR', 'COMSPEC']);
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const stdinWasPaused = process.stdin.isPaused();
    writeFileSync(executable, '@echo off\r\n');
    writeFileSync(shell, `#!${process.execPath}\nprocess.exit(0);\n`, { mode: 0o700 });
    env.patch({ HAPPIER_CLAUDE_PATH: executable, CLAUDE_CONFIG_DIR: join(directory, 'config'), COMSPEC: shell });
    const exits: Array<Readonly<{ providerStopped: boolean }>> = [];
    try {
        const { claudeLocal } = await import('./claudeLocal');
        Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
        await claudeLocal({ abort: new AbortController().signal, sessionId: null, path: directory,
            onSessionFound: () => {}, onProcessExit: result => { exits.push(result); } });
        expect(exits).toEqual([{ providerStopped: false }]);
    } finally {
        Object.defineProperty(process, 'platform', platform);
        env.restore();
        if (stdinWasPaused) process.stdin.pause();
        rmSync(directory, { recursive: true, force: true });
    }
});
