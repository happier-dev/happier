import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { getDefaultClaudeCodePath, getDefaultClaudeCodePathForAgentSdk } from './utils';

const originalEnv = { ...process.env };

function makeTempDir(prefix: string): string {
    return mkdtempSync(join(tmpdir(), prefix));
}

function makeUnixExecutable(params: { dir: string; name: string; stdout: string }): string {
    const filePath = join(params.dir, params.name);
    writeFileSync(filePath, `#!/bin/sh\n${params.stdout}\n`, 'utf8');
    chmodSync(filePath, 0o755);
    return filePath;
}

function makeWindowsCmd(params: { dir: string; name: string; stdout: string }): string {
    const filePath = join(params.dir, `${params.name}.cmd`);
    writeFileSync(filePath, `@echo off\r\necho ${params.stdout}\r\n`, 'utf8');
    return filePath;
}

describe('Claude SDK utils - getDefaultClaudeCodePath', () => {
    let workDir: string;
    let homeDir: string;
    let binDir: string;
    const originalPlatform = process.platform;

    beforeEach(() => {
        for (const key of Object.keys(process.env)) delete process.env[key];
        Object.assign(process.env, originalEnv);
        delete process.env.HAPPIER_CLAUDE_PATH;
        delete process.env.HAPPIER_USE_BUNDLED_CLAUDE;
        delete process.env.HAPPIER_USE_GLOBAL_CLAUDE;

        workDir = makeTempDir('happier-claude-sdk-utils-');
        homeDir = join(workDir, 'home');
        binDir = join(workDir, 'bin');
        mkdirSync(homeDir, { recursive: true });
        mkdirSync(binDir, { recursive: true });

        process.env.HOME = homeDir;
        process.env.USERPROFILE = homeDir;
        process.env.PATH = binDir;
    });

    afterEach(() => {
        Object.defineProperty(process, 'platform', { value: originalPlatform });
        for (const key of Object.keys(process.env)) delete process.env[key];
        Object.assign(process.env, originalEnv);
        if (workDir) rmSync(workDir, { recursive: true, force: true });
    });

    it('returns ~/.local/bin/claude when installed via native installer but not on PATH', () => {
        // Make PATH empty so we do not accidentally pick up a real global install on the machine.
        process.env.PATH = join(workDir, 'empty-path');
        mkdirSync(process.env.PATH, { recursive: true });

        const localBin = join(homeDir, '.local', 'bin');
        mkdirSync(localBin, { recursive: true });

        if (process.platform === 'win32') {
            // On Windows, native installer is expected to drop a real binary; this unit test focuses on Unix layout.
            // Still ensure we don't throw due to test setup.
            expect(() => getDefaultClaudeCodePath()).toThrow();
            return;
        }

        const nativeClaudePath = makeUnixExecutable({
            dir: localBin,
            name: 'claude',
            stdout: 'echo "2.0.0 (Claude Code)"',
        });

        expect(getDefaultClaudeCodePath()).toBe(nativeClaudePath);
    });

    it('throws a helpful error when no Claude Code installation is found', () => {
        // Ensure PATH has no claude.
        process.env.PATH = join(workDir, 'empty-path-2');
        mkdirSync(process.env.PATH, { recursive: true });

        expect(() => getDefaultClaudeCodePath()).toThrow(/Claude Code.*not installed/i);
    });

    it('returns %USERPROFILE%/.local/bin/claude.exe when installed there on Windows', () => {
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

        // Ensure PATH has no claude.
        process.env.PATH = join(workDir, 'empty-path-win');
        mkdirSync(process.env.PATH, { recursive: true });

        const localBin = join(homeDir, '.local', 'bin');
        mkdirSync(localBin, { recursive: true });
        const nativeClaudePath = join(localBin, 'claude.exe');
        writeFileSync(nativeClaudePath, 'MZ', 'utf8');

        expect(getDefaultClaudeCodePath()).toBe(nativeClaudePath);
    });

    it('prefers HAPPIER_CLAUDE_PATH when set', () => {
        if (process.platform === 'win32') {
            const cmdPath = makeWindowsCmd({ dir: binDir, name: 'claude', stdout: '2.0.0 (Claude Code)' });
            process.env.HAPPIER_CLAUDE_PATH = cmdPath;
            expect(getDefaultClaudeCodePath()).toBe(cmdPath);
            return;
        }

        const explicitPath = makeUnixExecutable({ dir: binDir, name: 'explicit-claude', stdout: 'echo "2.0.0 (Claude Code)"' });
        process.env.HAPPIER_CLAUDE_PATH = explicitPath;
        expect(getDefaultClaudeCodePath()).toBe(explicitPath);
    });
});

describe('Claude SDK utils - getDefaultClaudeCodePathForAgentSdk', () => {
    let workDir: string;
    let homeDir: string;
    let binDir: string;

    beforeEach(() => {
        for (const key of Object.keys(process.env)) delete process.env[key];
        Object.assign(process.env, originalEnv);
        delete process.env.HAPPIER_CLAUDE_PATH;

        workDir = makeTempDir('happier-claude-agent-sdk-utils-');
        homeDir = join(workDir, 'home');
        binDir = join(workDir, 'bin');
        mkdirSync(homeDir, { recursive: true });
        mkdirSync(binDir, { recursive: true });

        process.env.HOME = homeDir;
        process.env.USERPROFILE = homeDir;
        process.env.PATH = binDir;
    });

    afterEach(() => {
        for (const key of Object.keys(process.env)) delete process.env[key];
        Object.assign(process.env, originalEnv);
        if (workDir) rmSync(workDir, { recursive: true, force: true });
    });

    it('returns the absolute path to the claude executable (not the literal command name)', () => {
        if (process.platform === 'win32') {
            // Windows resolution for Agent SDK requires a real .exe path; skip this Unix-oriented test.
            return;
        }

        const jsClaude = join(binDir, 'claude');
        writeFileSync(jsClaude, '#!/usr/bin/env node\nconsole.log(\"2.0.0 (Claude Code)\")\n', 'utf8');
        chmodSync(jsClaude, 0o755);

        expect(getDefaultClaudeCodePathForAgentSdk()).toBe(jsClaude);
    });

    it('rejects a non-executable .cjs entrypoint for Agent SDK (SDK may try to execute it directly)', () => {
        if (process.platform === 'win32') {
            return;
        }

        const cjsPath = join(binDir, 'fake-claude.cjs');
        writeFileSync(cjsPath, 'console.log("hello")\n', 'utf8');
        process.env.HAPPIER_CLAUDE_PATH = cjsPath;

        expect(() => getDefaultClaudeCodePathForAgentSdk()).toThrow(/unsupported/i);
    });

    it('accepts shell wrapper scripts on PATH even when a versioned native binary is available', () => {
        if (process.platform === 'win32') {
            return;
        }

        const wrapperPath = makeUnixExecutable({ dir: binDir, name: 'claude', stdout: 'echo \"wrapper\"' });

        const versionsDir = join(homeDir, '.local', 'share', 'claude', 'versions', '2.0.0');
        mkdirSync(versionsDir, { recursive: true });
        const nativeClaudePath = join(versionsDir, 'claude');
        writeFileSync(nativeClaudePath, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]));
        chmodSync(nativeClaudePath, 0o755);

        expect(getDefaultClaudeCodePathForAgentSdk()).toBe(wrapperPath);
    });

    it('prefers a PATH entrypoint when both PATH and a versioned install are present', () => {
        if (process.platform === 'win32') {
            return;
        }

        const jsClaude = join(binDir, 'claude');
        writeFileSync(jsClaude, '#!/usr/bin/env node\nconsole.log(\"2.0.0 (Claude Code)\")\n', 'utf8');
        chmodSync(jsClaude, 0o755);

        const versionsDir = join(homeDir, '.local', 'share', 'claude', 'versions', '2.0.0');
        mkdirSync(versionsDir, { recursive: true });
        const nativeClaudePath = join(versionsDir, 'claude');
        writeFileSync(nativeClaudePath, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]));
        chmodSync(nativeClaudePath, 0o755);

        expect(getDefaultClaudeCodePathForAgentSdk()).toBe(jsClaude);
    });
});
