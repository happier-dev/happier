import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { legacyCustomAcpCompat } from '@happier-dev/agents';

import {
  isAgentCliPathRunnable,
  readBackendCliSourcePreferenceForAgent,
  readBackendCliSourcePreference,
  type AgentCliRuntimeDescriptor,
  resolveAgentCliCommand,
  resolveAgentCliCommandForRuntime,
} from './resolution';

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

describe('readBackendCliSourcePreference', () => {
  it('prefers target-keyed preferences from the env map', () => {
    expect(readBackendCliSourcePreference('codex', {
      HAPPIER_BACKEND_CLI_SOURCE_PREFERENCES_JSON: JSON.stringify({
        'agent:codex': 'managed-first',
        codex: 'system-first',
      }),
    } as NodeJS.ProcessEnv)).toBe('managed-first');
  });

  it('falls back to legacy id-keyed preferences when target-keyed entries are absent', () => {
    expect(readBackendCliSourcePreference('codex', {
      HAPPIER_BACKEND_CLI_SOURCE_PREFERENCES_JSON: JSON.stringify({
        codex: 'managed-first',
      }),
    } as NodeJS.ProcessEnv)).toBe('managed-first');
  });

  it('accepts additive v2 backend target keys from the env map', () => {
    expect(readBackendCliSourcePreference('codex', {
      HAPPIER_BACKEND_CLI_SOURCE_PREFERENCES_JSON: JSON.stringify({
        'backend:codex': 'managed-first',
      }),
    } as NodeJS.ProcessEnv)).toBe('managed-first');
  });

  it('falls back to the default source preference for compatibility-only agent ids', () => {
    expect(readBackendCliSourcePreferenceForAgent('customAcp', 'system-first', {} as NodeJS.ProcessEnv)).toBe('system-first');
  });
});

describe('resolveAgentCliCommand', () => {
  const originalCwd = process.cwd();

  afterEach(() => {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    }
    process.chdir(originalCwd);
  });

  it('expands ~ and resolves agent CLI override shims on Windows', () => {
    if (!originalPlatformDescriptor) {
      throw new Error('Expected process.platform to be configurable for this test');
    }
    Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: 'win32' });

    const root = join(tmpdir(), `happier-cli-common-agent-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(root, { recursive: true });
    const isWindowsHost = originalPlatformDescriptor.value === 'win32';
    const windowsHome = isWindowsHost ? win32.join(root, 'home') : 'C:\\Users\\happier-test';
    const cmdShimPath = win32.join(windowsHome, 'bin', 'codex.cmd');
    if (isWindowsHost) {
      mkdirSync(win32.dirname(cmdShimPath), { recursive: true });
    } else {
      process.chdir(root);
    }
    writeFileSync(cmdShimPath, '@echo off\r\n', 'utf8');
    chmodSync(cmdShimPath, 0o755);

    const resolved = resolveAgentCliCommand('codex', {
      processEnv: {
        USERPROFILE: windowsHome,
        PATH: '',
        HAPPIER_CODEX_PATH: '~/bin/codex',
      },
      isBunRuntime: false,
      currentExecPath: process.execPath,
    });

    expect(resolved).toEqual({
      source: 'override',
      command: expect.any(String),
    });
    expect(resolved?.command.toLowerCase()).toBe(cmdShimPath.toLowerCase());
  });

  it('requires a bun runtime for bun-shebang agent scripts', () => {
    const root = join(tmpdir(), `happier-cli-common-agent-bun-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const binDir = join(root, 'bin');
    mkdirSync(binDir, { recursive: true });

    const agentCliPath = join(binDir, 'omp');
    writeFileSync(agentCliPath, '#!/usr/bin/env bun\nconsole.log("ok")\n', 'utf8');
    chmodSync(agentCliPath, 0o755);

    expect(isAgentCliPathRunnable(agentCliPath, { PATH: '' }, {
      isBunRuntime: false,
      currentExecPath: process.execPath,
    })).toBe(false);

    const bunPath = join(binDir, 'bun');
    writeFileSync(bunPath, '#!/bin/sh\nexit 0\n', 'utf8');
    chmodSync(bunPath, 0o755);

    expect(isAgentCliPathRunnable(agentCliPath, { PATH: binDir }, {
      isBunRuntime: false,
      currentExecPath: process.execPath,
    })).toBe(true);
  });

  it('rejects POSIX relative agent CLI override paths before launch resolution', () => {
    if (process.platform === 'win32') return;

    const root = join(tmpdir(), `happier-cli-common-agent-relative-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const binDir = join(root, 'bin');
    mkdirSync(binDir, { recursive: true });
    const cursorPath = join(binDir, 'cursor');
    writeFileSync(cursorPath, '#!/bin/sh\nexit 0\n', 'utf8');
    chmodSync(cursorPath, 0o755);
    process.chdir(root);

    expect(resolveAgentCliCommand('cursor', {
      processEnv: {
        PATH: '',
        HAPPIER_CURSOR_PATH: 'bin/cursor',
      },
      isBunRuntime: false,
      currentExecPath: process.execPath,
    })).toBeNull();
  });

  it('prefers agent-declared known user install locations over PATH wrappers', () => {
    if (process.platform === 'win32') return;

    const root = join(tmpdir(), `happier-cli-common-agent-known-user-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const wrapperBinDir = join(root, 'wrapper-bin');
    const homeDir = join(root, 'home');
    const knownUserBinDir = join(homeDir, '.local', 'bin');
    mkdirSync(wrapperBinDir, { recursive: true });
    mkdirSync(knownUserBinDir, { recursive: true });

    const wrapperPath = join(wrapperBinDir, 'claude');
    writeFileSync(wrapperPath, '#!/bin/sh\necho wrapper\n', 'utf8');
    chmodSync(wrapperPath, 0o755);

    const knownInstallPath = join(knownUserBinDir, 'claude');
    writeFileSync(knownInstallPath, '#!/bin/sh\necho native\n', 'utf8');
    chmodSync(knownInstallPath, 0o755);

    expect(resolveAgentCliCommand('claude', {
      processEnv: {
        HOME: homeDir,
        PATH: wrapperBinDir,
      },
      isBunRuntime: false,
      currentExecPath: process.execPath,
    })).toEqual({
      source: 'system',
      command: knownInstallPath,
    });
  });

  it('honors agent-owned known-user-first system resolution without branching on the agent id', () => {
    if (process.platform === 'win32') return;

    const root = join(tmpdir(), `happier-cli-common-agent-owned-policy-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const wrapperBinDir = join(root, 'wrapper-bin');
    const homeDir = join(root, 'home');
    const knownUserBinDir = join(homeDir, '.local', 'bin');
    mkdirSync(wrapperBinDir, { recursive: true });
    mkdirSync(knownUserBinDir, { recursive: true });

    const wrapperPath = join(wrapperBinDir, 'custom-agent');
    writeFileSync(wrapperPath, '#!/bin/sh\necho wrapper\n', 'utf8');
    chmodSync(wrapperPath, 0o755);

    const knownInstallPath = join(knownUserBinDir, 'custom-agent');
    writeFileSync(knownInstallPath, '#!/bin/sh\necho native\n', 'utf8');
    chmodSync(knownInstallPath, 0o755);

    const runtimeSpec = {
      id: 'customAgent',
      title: 'Custom Agent CLI',
      binaryName: 'custom-agent',
      knownUserBinDirSuffixes: ['.local/bin'],
      sourcePreferenceDefault: 'system-first',
      managedInstall: null,
      manualInstallKind: 'none',
      manualInstallRecipes: null,
      acceptsJavaScriptFileOverride: false,
      systemCommandResolutionStrategy: 'known-user-first-runnable',
    } satisfies AgentCliRuntimeDescriptor;

    expect(resolveAgentCliCommandForRuntime(runtimeSpec, {
      processEnv: {
        HOME: homeDir,
        PATH: wrapperBinDir,
      },
      isBunRuntime: false,
      currentExecPath: process.execPath,
    })).toEqual({
      source: 'system',
      command: knownInstallPath,
    });
  });

  it('accepts oh-my-pi Bun entrypoint overrides that point at the package TypeScript source', () => {
    const root = join(tmpdir(), `happier-cli-common-agent-ohmypi-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const bunRoot = join(root, '.bun');
    const cliDir = join(bunRoot, 'install', 'global', 'node_modules', '@oh-my-pi', 'pi-coding-agent', 'src');
    const bunBinDir = join(bunRoot, 'bin');
    mkdirSync(cliDir, { recursive: true });
    mkdirSync(bunBinDir, { recursive: true });

    const cliPath = join(cliDir, 'cli.ts');
    writeFileSync(cliPath, '#!/usr/bin/env bun\nconsole.log("ok")\n', 'utf8');
    chmodSync(cliPath, 0o755);

    const bunPath = join(bunBinDir, 'bun');
    writeFileSync(bunPath, '#!/bin/sh\nexit 0\n', 'utf8');
    chmodSync(bunPath, 0o755);

    expect(resolveAgentCliCommand('ohMyPi', {
      processEnv: {
        PATH: '',
        HAPPIER_OHMYPI_PATH: cliPath,
      },
      isBunRuntime: false,
      currentExecPath: process.execPath,
    })).toEqual({
      source: 'override',
      command: cliPath,
    });
  });

  it('does not treat Windows TypeScript overrides as directly runnable without Bun', () => {
    if (!originalPlatformDescriptor) {
      throw new Error('Expected process.platform to be configurable for this test');
    }
    Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: 'win32' });

    const root = join(tmpdir(), `happier-cli-common-agent-ohmypi-win-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const cliDir = join(root, 'src');
    mkdirSync(cliDir, { recursive: true });

    const cliPath = join(cliDir, 'cli.ts');
    writeFileSync(cliPath, '#!/usr/bin/env bun\nconsole.log("ok")\n', 'utf8');
    chmodSync(cliPath, 0o755);

    expect(resolveAgentCliCommand('ohMyPi', {
      processEnv: {
        PATH: '',
        HAPPIER_OHMYPI_PATH: cliPath,
      },
      isBunRuntime: false,
      currentExecPath: process.execPath,
    })).toBeNull();
  });

  it('accepts Windows TypeScript overrides when a Bun runtime is available', () => {
    if (!originalPlatformDescriptor) {
      throw new Error('Expected process.platform to be configurable for this test');
    }
    Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: 'win32' });

    const root = join(tmpdir(), `happier-cli-common-agent-ohmypi-win-bun-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const bunRoot = join(root, '.bun');
    const cliDir = join(bunRoot, 'install', 'global', 'node_modules', '@oh-my-pi', 'pi-coding-agent', 'src');
    const bunBinDir = join(bunRoot, 'bin');
    mkdirSync(cliDir, { recursive: true });
    mkdirSync(bunBinDir, { recursive: true });

    const cliPath = join(cliDir, 'cli.ts');
    writeFileSync(cliPath, '#!/usr/bin/env bun\nconsole.log("ok")\n', 'utf8');
    chmodSync(cliPath, 0o755);

    const bunPath = join(bunBinDir, 'bun.exe');
    writeFileSync(bunPath, '@echo off\r\n', 'utf8');
    chmodSync(bunPath, 0o755);

    expect(resolveAgentCliCommand('ohMyPi', {
      processEnv: {
        PATH: '',
        HAPPIER_OHMYPI_PATH: cliPath,
      },
      isBunRuntime: false,
      currentExecPath: process.execPath,
    })).toEqual({
      source: 'override',
      command: cliPath,
    });
  });

  it('does not throw for compatibility-only customAcp resolution when no backend target preference exists', () => {
    expect(resolveAgentCliCommandForRuntime(legacyCustomAcpCompat.getLegacyCustomAcpAgentCliRuntimeSpec(), {
      processEnv: {
        PATH: '',
      },
      isBunRuntime: false,
      currentExecPath: process.execPath,
    })).toBeNull();
  });

  it('falls back to the Windows npm user bin for opencode when PATH is missing the binary', () => {
    if (!originalPlatformDescriptor) {
      throw new Error('Expected process.platform to be configurable for this test');
    }
    Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: 'win32' });

    const root = join(tmpdir(), `happier-cli-common-agent-opencode-win-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const npmDir = join(root, 'AppData', 'Roaming', 'npm');
    mkdirSync(npmDir, { recursive: true });

    const opencodeCmdPath = join(npmDir, 'opencode.CMD');
    writeFileSync(opencodeCmdPath, '@echo off\r\n', 'utf8');
    chmodSync(opencodeCmdPath, 0o755);

    expect(resolveAgentCliCommand('opencode', {
      processEnv: {
        HOME: root,
        PATH: '',
      },
      isBunRuntime: false,
      currentExecPath: process.execPath,
    })).toEqual({
      source: 'system',
      command: opencodeCmdPath,
    });
  });

  it('fails closed for a Unix TypeScript override without a shebang when no JavaScript runtime is available', () => {
    if (process.platform === 'win32') return;

    const root = join(tmpdir(), `happier-cli-common-agent-ohmypi-unix-ts-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const cliDir = join(root, 'src');
    mkdirSync(cliDir, { recursive: true });

    const cliPath = join(cliDir, 'cli.ts');
    writeFileSync(cliPath, 'console.log("ok")\n', 'utf8');
    chmodSync(cliPath, 0o644);

    expect(resolveAgentCliCommand('ohMyPi', {
      processEnv: {
        PATH: '',
        HAPPIER_OHMYPI_PATH: cliPath,
      },
      isBunRuntime: true,
      currentExecPath: join(root, 'happier'),
    })).toBeNull();
  });
});
