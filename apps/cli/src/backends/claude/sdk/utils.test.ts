import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { getProviderCliRuntimeSpec } from '@happier-dev/agents';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { writeExecutableShimSync } from '@/testkit/fs/executableShim';
import { writeTextFileSync } from '@/testkit/fs/fileHelpers';
import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';

import { getDefaultClaudeCodePath, getDefaultClaudeCodePathForAgentSdk } from './utils';

const envKeys = [
  'HOME',
  'PATH',
  'USERPROFILE',
  'HAPPIER_CLAUDE_PATH',
  'HAPPIER_USE_BUNDLED_CLAUDE',
  'HAPPIER_USE_GLOBAL_CLAUDE',
] as const;
const TEMP_DIRS = new Set<string>();
const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
let envScope = createEnvKeyScope(envKeys);

function createTempRoot(prefix: string): string {
  const dir = createTempDirSync(prefix);
  TEMP_DIRS.add(dir);
  return dir;
}

function createUnixExecutable(params: { dir: string; name: string; body: string }): string {
  return writeExecutableShimSync({
    dir: params.dir,
    fileName: params.name,
    contents: `#!/bin/sh\n${params.body}\n`,
  });
}

function createWindowsCommand(params: { dir: string; name: string; stdout: string }): string {
  return writeExecutableShimSync({
    dir: params.dir,
    fileName: `${params.name}.cmd`,
    contents: `@echo off\r\necho ${params.stdout}\r\n`,
  });
}

afterEach(() => {
  if (originalPlatformDescriptor) {
    Object.defineProperty(process, 'platform', originalPlatformDescriptor);
  }
  envScope.restore();
  envScope = createEnvKeyScope(envKeys);
  for (const dir of TEMP_DIRS) removeTempDirSync(dir);
  TEMP_DIRS.clear();
});

describe('Claude SDK utils - getDefaultClaudeCodePath', () => {
  let workDir: string;
  let homeDir: string;
  let binDir: string;

  beforeEach(() => {
    workDir = createTempRoot('happier-claude-sdk-utils-');
    homeDir = join(workDir, 'home');
    binDir = join(workDir, 'bin');
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });

    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    process.env.PATH = binDir;
    delete process.env.HAPPIER_CLAUDE_PATH;
    delete process.env.HAPPIER_USE_BUNDLED_CLAUDE;
    delete process.env.HAPPIER_USE_GLOBAL_CLAUDE;
  });

  it('returns ~/.local/bin/claude when installed via native installer but not on PATH', () => {
    process.env.PATH = join(workDir, 'empty-path');
    mkdirSync(process.env.PATH, { recursive: true });

    const localBin = join(homeDir, '.local', 'bin');
    mkdirSync(localBin, { recursive: true });

    if (process.platform === 'win32') {
      expect(() => getDefaultClaudeCodePath()).toThrow();
      return;
    }

    const nativeClaudePath = createUnixExecutable({
      dir: localBin,
      name: 'claude',
      body: 'echo "2.0.0 (Claude Code)"',
    });

    expect(getDefaultClaudeCodePath()).toBe(nativeClaudePath);
  });

  it('throws a helpful error when no Claude Code installation is found', () => {
    process.env.PATH = join(workDir, 'empty-path-2');
    mkdirSync(process.env.PATH, { recursive: true });

    const runtimeSpec = getProviderCliRuntimeSpec('claude');
    const installGuideUrl = runtimeSpec.installGuideUrl ?? runtimeSpec.docsUrl ?? '';
    const unixRecipe = runtimeSpec.manualInstallRecipes?.linux?.[0];
    const windowsRecipe = runtimeSpec.manualInstallRecipes?.win32?.[0];

    expect(() => getDefaultClaudeCodePath()).toThrowError(
      expect.objectContaining({
        message: expect.stringContaining(`Setup guide: ${installGuideUrl}`),
      }),
    );
    expect(() => getDefaultClaudeCodePath()).toThrowError(
      expect.objectContaining({
        message: expect.stringContaining('HAPPIER_CLAUDE_PATH'),
      }),
    );

    if (unixRecipe?.cmd === 'bash' && unixRecipe.args[0] === '-lc' && typeof unixRecipe.args[1] === 'string') {
      expect(() => getDefaultClaudeCodePath()).toThrowError(
        expect.objectContaining({
          message: expect.stringContaining(unixRecipe.args[1]),
        }),
      );
    }

    if (
      windowsRecipe?.cmd === 'powershell'
      && windowsRecipe.args[0] === '-NoProfile'
      && windowsRecipe.args[1] === '-ExecutionPolicy'
      && windowsRecipe.args[2] === 'Bypass'
      && windowsRecipe.args[3] === '-Command'
      && typeof windowsRecipe.args[4] === 'string'
    ) {
      expect(() => getDefaultClaudeCodePath()).toThrowError(
        expect.objectContaining({
          message: expect.stringContaining(windowsRecipe.args[4]),
        }),
      );
    }
  });

  it('returns %USERPROFILE%/.local/bin/claude.exe when installed there on Windows', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    process.env.PATH = join(workDir, 'empty-path-win');
    mkdirSync(process.env.PATH, { recursive: true });

    const localBin = join(homeDir, '.local', 'bin');
    mkdirSync(localBin, { recursive: true });
    const nativeClaudePath = join(localBin, 'claude.exe');
    writeTextFileSync(nativeClaudePath, 'MZ');

    expect(getDefaultClaudeCodePath()).toBe(nativeClaudePath);
  });

  it('prefers HAPPIER_CLAUDE_PATH when set', () => {
    if (process.platform === 'win32') {
      const cmdPath = createWindowsCommand({ dir: binDir, name: 'claude', stdout: '2.0.0 (Claude Code)' });
      process.env.HAPPIER_CLAUDE_PATH = cmdPath;
      expect(getDefaultClaudeCodePath()).toBe(cmdPath);
      return;
    }

    const explicitPath = createUnixExecutable({
      dir: binDir,
      name: 'explicit-claude',
      body: 'echo "2.0.0 (Claude Code)"',
    });
    process.env.HAPPIER_CLAUDE_PATH = explicitPath;
    expect(getDefaultClaudeCodePath()).toBe(explicitPath);
  });
});

describe('Claude SDK utils - getDefaultClaudeCodePathForAgentSdk', () => {
  let workDir: string;
  let homeDir: string;
  let binDir: string;

  beforeEach(() => {
    workDir = createTempRoot('happier-claude-agent-sdk-utils-');
    homeDir = join(workDir, 'home');
    binDir = join(workDir, 'bin');
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });

    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    process.env.PATH = binDir;
    delete process.env.HAPPIER_CLAUDE_PATH;
  });

  it('returns the absolute path to the claude executable (not the literal command name)', () => {
    if (process.platform === 'win32') {
      return;
    }

    const jsClaude = createUnixExecutable({
      dir: binDir,
      name: 'claude',
      body: 'echo "2.0.0 (Claude Code)"',
    });

    expect(getDefaultClaudeCodePathForAgentSdk()).toBe(jsClaude);
  });

  it('rejects a non-executable .cjs entrypoint for Agent SDK (SDK may try to execute it directly)', () => {
    if (process.platform === 'win32') {
      return;
    }

    const cjsPath = join(binDir, 'fake-claude.cjs');
    writeTextFileSync(cjsPath, 'console.log("hello")\n');
    process.env.HAPPIER_CLAUDE_PATH = cjsPath;

    expect(() => getDefaultClaudeCodePathForAgentSdk()).toThrow(/unsupported/i);
  });

  it('accepts shell wrapper scripts on PATH even when a versioned native binary is available', () => {
    if (process.platform === 'win32') {
      return;
    }

    const wrapperPath = createUnixExecutable({
      dir: binDir,
      name: 'claude',
      body: 'echo "wrapper"',
    });

    const versionsDir = join(homeDir, '.local', 'share', 'claude', 'versions', '2.0.0');
    mkdirSync(versionsDir, { recursive: true });
    const nativeClaudePath = join(versionsDir, 'claude');
    writeFileSync(nativeClaudePath, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]));

    expect(getDefaultClaudeCodePathForAgentSdk()).toBe(wrapperPath);
  });

  it('prefers a PATH entrypoint when both PATH and a versioned install are present', () => {
    if (process.platform === 'win32') {
      return;
    }

    const jsClaude = createUnixExecutable({
      dir: binDir,
      name: 'claude',
      body: 'echo "2.0.0 (Claude Code)"',
    });

    const versionsDir = join(homeDir, '.local', 'share', 'claude', 'versions', '2.0.0');
    mkdirSync(versionsDir, { recursive: true });
    const nativeClaudePath = join(versionsDir, 'claude');
    writeFileSync(nativeClaudePath, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]));

    expect(getDefaultClaudeCodePathForAgentSdk()).toBe(jsClaude);
  });
});
