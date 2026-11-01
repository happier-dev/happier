import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

describe('resolveWindowsCommandInvocation', () => {
    const tempDirs = new Set<string>();

    // npm cmd-shim 7.0.0's no-shebang template; Claude Code 2.1.270 declares
    // bin/claude.exe and its postinstall replaces that placeholder with native PE.
    const nativeNpmShim = [
        '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b',
        ':start', 'SETLOCAL', 'CALL :find_dp0',
        '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*', '',
    ].join('\r\n');

    it('discovers a native npm target and preserves arguments beyond the cmd.exe limit', async () => {
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
        const root = mkdtempSync(join(tmpdir(), 'happier-native-npm-'));
        tempDirs.add(root);
        const target = join(root, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
        mkdirSync(join(target, '..'), { recursive: true });
        writeFileSync(target, Buffer.from([0x4d, 0x5a, 0x90, 0]));
        const shim = join(root, 'claude.cmd');
        writeFileSync(shim, nativeNpmShim);
        const env = { PATH: root, PATHEXT: '.CMD;.EXE' };
        const { resolveWindowsCommandOnPath, resolveWindowsCommandPath, resolveWindowsCommandInvocation } = await import('./resolveWindowsCommandInvocation.js');
        expect(resolveWindowsCommandOnPath('claude', env)).toBe(target);
        expect(resolveWindowsCommandPath(shim, env)).toBe(target);
        const args = ['--append-system-prompt', 'x'.repeat(12_000), 'spaces & "quotes" %PATH% !literal!'];
        for (const command of ['claude', shim]) {
            expect(resolveWindowsCommandInvocation({ command, args, env })).toEqual({ command: target, args });
        }
    });

    it.each(['custom-command', 'environment', 'extra-args', 'javascript', 'placeholder', 'missing'] as const)(
        'preserves shell execution when native npm delegation is unproven (%s)', async (kind) => {
            Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
            const root = mkdtempSync(join(tmpdir(), 'happier-preserved-npm-'));
            tempDirs.add(root);
            const target = join(root, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
            mkdirSync(join(target, '..'), { recursive: true });
            if (kind !== 'missing') writeFileSync(target, kind === 'placeholder' ? 'install the native package' : Buffer.from([0x4d, 0x5a, 0x90, 0]));
            let script = nativeNpmShim;
            if (kind === 'custom-command') script += 'echo additional work\r\n';
            if (kind === 'environment') script = script.replace('CALL :find_dp0', 'CALL :find_dp0\r\nSET CUSTOM_AUTH=selected');
            if (kind === 'extra-args') script = script.replace('%*', '--custom-flag %*');
            if (kind === 'javascript') script = script.replace('"%dp0%\\node_modules', 'node "%dp0%\\node_modules').replace('claude.exe', 'cli.js');
            const shim = join(root, 'claude.cmd');
            writeFileSync(shim, script);
            const env = { PATH: root, PATHEXT: '.CMD;.EXE' };
            const { resolveWindowsCommandOnPath, resolveWindowsCommandInvocation } = await import('./resolveWindowsCommandInvocation.js');
            expect(resolveWindowsCommandOnPath('claude', env)).toBe(shim);
            expect(resolveWindowsCommandInvocation({ command: shim, args: ['test'], env }).command).toBe('cmd.exe');
        },
    );

    afterEach(() => {
        if (originalPlatformDescriptor) {
            Object.defineProperty(process, 'platform', originalPlatformDescriptor);
        }
        for (const dir of tempDirs) {
            rmSync(dir, { recursive: true, force: true });
        }
        tempDirs.clear();
    });

    it('prefers PATHEXT-resolved commands over extensionless files when both exist on PATH', async () => {
        if (!originalPlatformDescriptor) {
            throw new Error('Expected process.platform to be configurable for this test');
        }
        Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: 'win32' });

        const root = mkdtempSync(join(tmpdir(), 'happier-cli-common-win32-path-'));
        tempDirs.add(root);
        const binDir = join(root, 'bin');
        mkdirSync(binDir, { recursive: true });

        const extensionlessPath = join(binDir, 'codex');
        const cmdShimPath = join(binDir, 'codex.cmd');
        writeFileSync(extensionlessPath, '', 'utf8');
        writeFileSync(cmdShimPath, '@echo off\r\necho ok\r\n', 'utf8');

        const { resolveWindowsCommandOnPath } = await import('./resolveWindowsCommandInvocation.js');

        expect(resolveWindowsCommandOnPath('codex', {
            PATH: binDir,
            PATHEXT: '.CMD;.EXE',
        })?.toLowerCase()).toBe(cmdShimPath.toLowerCase());
    });

    it('detects PATHEXT commands directly from the supplied Windows PATH', async () => {
        if (!originalPlatformDescriptor) {
            throw new Error('Expected process.platform to be configurable for this test');
        }
        Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: 'win32' });

        const root = mkdtempSync(join(tmpdir(), 'happier-cli-common-win32-command-exists-'));
        tempDirs.add(root);
        const binDir = join(root, 'bin');
        mkdirSync(binDir, { recursive: true });
        const executablePath = join(binDir, 'powershell.exe');
        writeFileSync(executablePath, '', 'utf8');

        const { commandExistsOnPath } = await import('../commandExists.js');

        expect(commandExistsOnPath('powershell', {
            env: {
                PATH: binDir,
                PATHEXT: '.EXE;.CMD',
            },
        })).toBe(true);
    });

    it('normalizes full command paths without an extension to the matching .cmd shim', async () => {
        if (!originalPlatformDescriptor) {
            throw new Error('Expected process.platform to be configurable for this test');
        }
        Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: 'win32' });

        const root = mkdtempSync(join(tmpdir(), 'happier-cli-common-win32-invocation-'));
        tempDirs.add(root);
        const binDir = join(root, 'bin');
        mkdirSync(binDir, { recursive: true });

        const extensionlessPath = join(binDir, 'codex');
        const cmdShimPath = join(binDir, 'codex.cmd');
        writeFileSync(extensionlessPath, '', 'utf8');
        writeFileSync(cmdShimPath, '@echo off\r\necho ok\r\n', 'utf8');

        const { resolveWindowsCommandInvocation } = await import('./resolveWindowsCommandInvocation.js');

        const invocation = resolveWindowsCommandInvocation({
            command: extensionlessPath,
            args: ['app-server'],
            env: {
                PATH: binDir,
                PATHEXT: '.CMD;.EXE',
            },
        });

        expect(invocation.command).toBe('cmd.exe');
        expect(invocation.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
        expect(invocation.args[3]?.toLowerCase()).toContain(cmdShimPath.toLowerCase());
        expect(invocation.windowsVerbatimArguments).toBe(true);
    });

    it('resolves cmd.exe through COMSPEC when the command is not available on PATH', async () => {
        if (!originalPlatformDescriptor) {
            throw new Error('Expected process.platform to be configurable for this test');
        }
        Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: 'win32' });

        const { resolveWindowsCommandInvocation } = await import('./resolveWindowsCommandInvocation.js');

        const invocation = resolveWindowsCommandInvocation({
            command: 'cmd.exe',
            args: ['/c', 'npm install -g opencode-ai'],
            env: {
                PATH: '',
                PATHEXT: '.EXE;.CMD;.BAT;.COM',
                COMSPEC: 'C:\\WINDOWS\\system32\\cmd.exe',
            },
        });

        expect(invocation).toEqual({
            command: 'C:\\WINDOWS\\system32\\cmd.exe',
            args: ['/c', 'npm install -g opencode-ai'],
        });
    });
});
