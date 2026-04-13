import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
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
const originalExecPathDescriptor = Object.getOwnPropertyDescriptor(process, 'execPath');
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

// Stub process.execPath to an empty sandbox directory so findClaudeInNpmGlobalModules()
// cannot accidentally resolve to the host's real npm global install while tests run.
function stubExecPathToEmptySandbox(workDir: string): void {
  const sandboxNodeDir = join(workDir, 'sandbox-node');
  mkdirSync(sandboxNodeDir, { recursive: true });
  const sandboxNode = join(sandboxNodeDir, process.platform === 'win32' ? 'node.exe' : 'node');
  writeTextFileSync(sandboxNode, '');
  Object.defineProperty(process, 'execPath', { value: sandboxNode, configurable: true });
}

afterEach(() => {
  if (originalPlatformDescriptor) {
    Object.defineProperty(process, 'platform', originalPlatformDescriptor);
  }
  if (originalExecPathDescriptor) {
    Object.defineProperty(process, 'execPath', originalExecPathDescriptor);
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

    stubExecPathToEmptySandbox(workDir);

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

  it('resolves a versioned Claude JS entrypoint without requiring node on PATH', () => {
    process.env.PATH = join(workDir, 'empty-path-versioned');
    mkdirSync(process.env.PATH, { recursive: true });

    const versionedDir = join(homeDir, '.local', 'share', 'claude', 'versions', '2.0.0');
    mkdirSync(versionedDir, { recursive: true });
    const versionedClaudePath = join(versionedDir, 'cli.js');
    writeTextFileSync(versionedClaudePath, 'console.log("claude");\n');

    expect(getDefaultClaudeCodePath()).toBe(versionedClaudePath);
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

  it('expands ~/ in HAPPIER_CLAUDE_PATH for the default Claude Code path', () => {
    if (process.platform === 'win32') {
      return;
    }

    const localBin = join(homeDir, '.local', 'bin');
    mkdirSync(localBin, { recursive: true });
    const explicitPath = createUnixExecutable({
      dir: localBin,
      name: 'claude',
      body: 'echo "2.0.0 (Claude Code)"',
    });

    process.env.HAPPIER_CLAUDE_PATH = '~/.local/bin/claude';

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

    stubExecPathToEmptySandbox(workDir);

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

  it('preserves a PATH symlink entrypoint so Claude auto-updates can retarget it without pinning an old version path', () => {
    if (process.platform === 'win32') {
      return;
    }

    const realDir = join(workDir, 'real-bin');
    mkdirSync(realDir, { recursive: true });
    const realClaude = createUnixExecutable({
      dir: realDir,
      name: 'claude',
      body: 'echo "2.0.0 (Claude Code)"',
    });
    const symlinkPath = join(binDir, 'claude');
    symlinkSync(realClaude, symlinkPath);

    expect(getDefaultClaudeCodePathForAgentSdk()).toBe(symlinkPath);
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

  it('expands ~/ in HAPPIER_CLAUDE_PATH for the Agent SDK Claude entrypoint', () => {
    if (process.platform === 'win32') {
      return;
    }

    const localBin = join(homeDir, '.local', 'bin');
    mkdirSync(localBin, { recursive: true });
    const explicitPath = createUnixExecutable({
      dir: localBin,
      name: 'claude',
      body: 'echo "2.0.0 (Claude Code)"',
    });

    process.env.HAPPIER_CLAUDE_PATH = '~/.local/bin/claude';

    expect(getDefaultClaudeCodePathForAgentSdk()).toBe(explicitPath);
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

  it('does not pick a project-local node_modules/.bin/claude when a global install is available', () => {
    if (process.platform === 'win32') {
      return;
    }

    const originalCwd = process.cwd();
    const projectRoot = createTempRoot('happier-claude-sdk-project-root-');
    const projectNodeBin = join(projectRoot, 'node_modules', '.bin');
    mkdirSync(projectNodeBin, { recursive: true });
    const localClaude = createUnixExecutable({
      dir: projectNodeBin,
      name: 'claude',
      body: 'echo "local claude"',
    });

    const globalClaude = createUnixExecutable({
      dir: binDir,
      name: 'claude',
      body: 'echo "global claude"',
    });

    process.env.PATH = `${projectNodeBin}:${binDir}`;

    try {
      process.chdir(projectRoot);
      expect(getDefaultClaudeCodePathForAgentSdk()).toBe(globalClaude);
      expect(getDefaultClaudeCodePathForAgentSdk()).not.toBe(localClaude);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('resolves the npm global cli.js entrypoint from process.execPath on Unix when PATH is empty', () => {
    if (process.platform === 'win32') {
      return;
    }

    process.env.PATH = join(workDir, 'empty-path-npm-global-unix');
    mkdirSync(process.env.PATH, { recursive: true });

    // Simulate an npm global layout: <prefix>/bin/node and <prefix>/lib/node_modules/...
    const prefixDir = join(workDir, 'npm-prefix');
    const nodeBinDir = join(prefixDir, 'bin');
    mkdirSync(nodeBinDir, { recursive: true });
    const fakeNode = createUnixExecutable({
      dir: nodeBinDir,
      name: 'node',
      body: 'exit 0',
    });

    const globalCliDir = join(prefixDir, 'lib', 'node_modules', '@anthropic-ai', 'claude-code');
    mkdirSync(globalCliDir, { recursive: true });
    const globalCliJs = join(globalCliDir, 'cli.js');
    writeTextFileSync(globalCliJs, 'console.log("claude");\n');

    Object.defineProperty(process, 'execPath', { value: fakeNode, configurable: true });

    expect(getDefaultClaudeCodePathForAgentSdk()).toBe(globalCliJs);
  });

  it('resolves the npm global cli.js entrypoint from process.execPath on Windows when PATH is empty', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    process.env.PATH = join(workDir, 'empty-path-npm-global-win');
    mkdirSync(process.env.PATH, { recursive: true });

    // Simulate the Windows npm layout: <execDir>/node.exe + <execDir>/node_modules/...
    const nodeDir = join(workDir, 'nodejs');
    mkdirSync(nodeDir, { recursive: true });
    const fakeNode = join(nodeDir, 'node.exe');
    writeTextFileSync(fakeNode, 'MZ');

    const globalCliDir = join(nodeDir, 'node_modules', '@anthropic-ai', 'claude-code');
    mkdirSync(globalCliDir, { recursive: true });
    const globalCliJs = join(globalCliDir, 'cli.js');
    writeTextFileSync(globalCliJs, 'console.log("claude");\n');

    Object.defineProperty(process, 'execPath', { value: fakeNode, configurable: true });

    expect(getDefaultClaudeCodePathForAgentSdk()).toBe(globalCliJs);
  });
});
