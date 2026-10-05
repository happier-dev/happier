import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, win32 } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { legacyCustomAcpCompat } from '@happier-dev/agents';

import {
  isAgentCliPathRunnable,
  readBackendCliSourcePreferenceForAgent,
  readBackendCliSourcePreference,
  type AgentCliRuntimeDescriptor,
  resolveAgentCliCommand,
  resolveAgentCliCommandForRuntime,
  resolveAgentCliManagedCommandPath,
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

  it('honors the canonical qualified bundled Agent target key emitted by current UI', () => {
    expect(readBackendCliSourcePreference('codex', {
      HAPPIER_BACKEND_CLI_SOURCE_PREFERENCES_JSON: JSON.stringify({
        'agent:happier.agent.codex/codex': 'managed-first',
        'backend:codex': 'system-first',
      }),
    } as NodeJS.ProcessEnv)).toBe('managed-first');
  });

  it('falls back to the default source preference for compatibility-only agent ids', () => {
    expect(readBackendCliSourcePreferenceForAgent('customAcp', 'system-first', {} as NodeJS.ProcessEnv)).toBe('system-first');
  });
});

describe('resolveAgentCliManagedCommandPath', () => {
  it('prefers a complete active managed release over the retained legacy current install on POSIX', () => {
    if (process.platform === 'win32') return;

    const root = mkdtempSync(join(tmpdir(), 'happier-agent-active-release-'));
    const happyHomeDir = join(root, 'home');
    const installRoot = join(happyHomeDir, 'tools', 'providers', 'codex');
    const activeReleaseDir = join(installRoot, '.releases', 'release-one');
    const activeCommandPath = join(activeReleaseDir, 'bin', 'codex');
    const legacyCommandPath = join(installRoot, 'current', 'bin', 'codex');
    try {
      mkdirSync(join(activeReleaseDir, 'bin'), { recursive: true });
      writeFileSync(activeCommandPath, '#!/bin/sh\nexit 0\n', 'utf8');
      chmodSync(activeCommandPath, 0o755);
      mkdirSync(join(installRoot, 'current', 'bin'), { recursive: true });
      writeFileSync(legacyCommandPath, '#!/bin/sh\nexit 0\n', 'utf8');
      chmodSync(legacyCommandPath, 0o755);
      symlinkSync(join('.releases', 'release-one'), join(installRoot, 'active'));

      expect(resolveAgentCliManagedCommandPath('codex', { happyHomeDir })).toBe(
        join(installRoot, 'active', 'bin', 'codex'),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

  it('finds the Pi vendor launcher outside the inherited PATH and preserves source policy', () => {
    if (process.platform === 'win32') return;

    const root = mkdtempSync(join(tmpdir(), 'happier-pi-vendor-launcher-'));
    const homeDir = join(root, 'home');
    const happyHomeDir = join(root, 'happier');
    const defaultLauncher = join(homeDir, '.pi', 'agent', 'bin', 'pi');
    const configuredLauncher = join(homeDir, 'configured-pi', 'bin', 'pi');
    const pathLauncher = join(root, 'path-bin', 'pi');
    const env = { HOME: homeDir, HAPPIER_HOME_DIR: happyHomeDir, PATH: '' };
    const managedLauncher = resolveAgentCliManagedCommandPath('pi', { processEnv: env });
    const writeLauncher = (path: string, executable = true) => {
      mkdirSync(dirname(path), { recursive: true });
      // The vendor launcher owns its pinned release and Node PATH, so the host executes the shell launcher itself.
      writeFileSync(path, '#!/bin/sh\nexit 0\n', 'utf8');
      chmodSync(path, executable ? 0o755 : 0o644);
    };
    try {
      writeLauncher(defaultLauncher);
      expect(resolveAgentCliCommand('pi', { processEnv: env })).toEqual({ source: 'system', command: defaultLauncher });
      writeLauncher(configuredLauncher);
      const configuredEnv = { ...env, PI_CODING_AGENT_DIR: '~/configured-pi' };
      expect(resolveAgentCliCommand('pi', { processEnv: configuredEnv })).toEqual({ source: 'system', command: configuredLauncher });
      expect(resolveAgentCliCommand('pi', { processEnv: { ...env, PI_CODING_AGENT_DIR: '~\\configured-pi' } })).toEqual({ source: 'system', command: configuredLauncher });
      writeLauncher(pathLauncher);
      expect(resolveAgentCliCommand('pi', { processEnv: { ...configuredEnv, PATH: dirname(pathLauncher) } })).toEqual({ source: 'system', command: pathLauncher });
      expect(resolveAgentCliCommand('pi', { processEnv: { ...configuredEnv, HAPPIER_PI_PATH: join(root, 'missing-pi') } })).toBeNull();
      writeLauncher(configuredLauncher, false);
      expect(resolveAgentCliCommand('pi', { processEnv: configuredEnv })).toEqual({ source: 'system', command: defaultLauncher });
      expect(resolveAgentCliCommand('pi', { processEnv: { ...env, PI_CODING_AGENT_DIR: join(root, 'missing-root') } })).toEqual({ source: 'system', command: defaultLauncher });
      writeLauncher(managedLauncher);
      expect(resolveAgentCliCommand('pi', { processEnv: { ...configuredEnv, HAPPIER_BACKEND_CLI_SOURCE_PREFERENCES_JSON: JSON.stringify({ pi: 'managed-first' }) } })).toEqual({ source: 'managed', command: managedLauncher });
      expect(resolveAgentCliCommand('pi', { processEnv: configuredEnv, sourcePolicy: 'managed_only' })).toEqual({ source: 'managed', command: managedLauncher });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

  it('resolves a configured install root declared by an external Agent without a bundled catalog lookup', () => {
    const root = mkdtempSync(join(tmpdir(), 'happier-agent-configured-bin-'));
    const command = join(root, 'configured', 'bin', process.platform === 'win32' ? 'custom-agent.cmd' : 'custom-agent');
    mkdirSync(dirname(command), { recursive: true });
    writeFileSync(command, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\nexit 0\n', 'utf8');
    chmodSync(command, 0o755);
    const runtimeSpec = {
      id: 'customAgent', title: 'Custom Agent CLI', binaryName: 'custom-agent',
      knownEnvironmentBinDirs: [{ envVar: 'CUSTOM_AGENT_DIR', relativeDir: 'bin' }],
      sourcePreferenceDefault: 'system-first', managedInstall: null,
      manualInstallKind: 'none', manualInstallRecipes: null, acceptsJavaScriptFileOverride: false,
    } satisfies AgentCliRuntimeDescriptor;
    try {
      expect(resolveAgentCliCommandForRuntime(runtimeSpec, {
        processEnv: { HOME: root, USERPROFILE: root, PATH: '', CUSTOM_AGENT_DIR: '~/configured' },
      })).toEqual({ source: 'system', command });
      expect(resolveAgentCliCommandForRuntime(runtimeSpec, {
        processEnv: { HOME: root, USERPROFILE: root, PATH: '', CUSTOM_AGENT_DIR: '~/missing' },
      })).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

describe('resolveAgentCliCommand managed_only source policy', () => {
  function createManagedOnlyFixture(): Readonly<{
    root: string;
    happyHomeDir: string;
    managedPath: string;
    systemPath: string;
    overridePath: string;
    systemBinDir: string;
  }> {
    const root = mkdtempSync(join(tmpdir(), 'happier-cli-common-agent-managed-only-'));
    const happyHomeDir = join(root, 'home');
    const managedPath = join(happyHomeDir, 'tools', 'providers', 'ohMyPi', 'current', 'bin', 'omp');
    const systemBinDir = join(root, 'system-bin');
    const systemPath = join(systemBinDir, 'omp');
    const overrideDir = join(root, 'override-bin');
    const overridePath = join(overrideDir, 'omp');
    for (const path of [managedPath, systemPath, overridePath]) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, '#!/bin/sh\nexit 0\n', 'utf8');
      chmodSync(path, 0o755);
    }
    return { root, happyHomeDir, managedPath, systemPath, overridePath, systemBinDir };
  }

  it('ignores an override and a system install and answers the activation-local managed install', () => {
    if (process.platform === 'win32') return;

    const fixture = createManagedOnlyFixture();
    try {
      const processEnv = {
        HAPPIER_HOME_DIR: fixture.happyHomeDir,
        PATH: fixture.systemBinDir,
        HAPPIER_OHMYPI_PATH: fixture.overridePath,
        HAPPIER_BACKEND_CLI_SOURCE_PREFERENCES_JSON: JSON.stringify({ ohMyPi: 'system-first' }),
      } as NodeJS.ProcessEnv;

      expect(resolveAgentCliCommand('ohMyPi', {
        processEnv,
        isBunRuntime: false,
        currentExecPath: process.execPath,
      })).toEqual({ source: 'override', command: fixture.overridePath });

      expect(resolveAgentCliCommand('ohMyPi', {
        processEnv,
        sourcePolicy: 'managed_only',
        isBunRuntime: false,
        currentExecPath: process.execPath,
      })).toEqual({ source: 'managed', command: fixture.managedPath });
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('answers null when only override and system installs exist', () => {
    if (process.platform === 'win32') return;

    const fixture = createManagedOnlyFixture();
    try {
      rmSync(join(fixture.happyHomeDir, 'tools'), { recursive: true, force: true });
      const processEnv = {
        HAPPIER_HOME_DIR: fixture.happyHomeDir,
        PATH: fixture.systemBinDir,
        HAPPIER_OHMYPI_PATH: fixture.overridePath,
      } as NodeJS.ProcessEnv;

      expect(resolveAgentCliCommand('ohMyPi', {
        processEnv,
        sourcePolicy: 'managed_only',
        isBunRuntime: false,
        currentExecPath: process.execPath,
      })).toBeNull();
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
