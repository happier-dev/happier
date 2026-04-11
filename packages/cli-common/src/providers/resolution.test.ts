import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  isProviderCliPathRunnable,
  readBackendCliSourcePreference,
  resolveProviderCliCommand,
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
});

describe('resolveProviderCliCommand', () => {
  afterEach(() => {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    }
  });

  it('expands ~ and resolves provider override shims on Windows', () => {
    if (!originalPlatformDescriptor) {
      throw new Error('Expected process.platform to be configurable for this test');
    }
    Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: 'win32' });

    const root = join(tmpdir(), `happier-cli-common-provider-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const homeBinDir = join(root, 'home', 'bin');
    mkdirSync(homeBinDir, { recursive: true });
    const cmdShimPath = join(homeBinDir, 'codex.cmd');
    writeFileSync(cmdShimPath, '@echo off\r\n', 'utf8');
    chmodSync(cmdShimPath, 0o755);

    const resolved = resolveProviderCliCommand('codex', {
      processEnv: {
        HOME: join(root, 'home'),
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

  it('requires a bun runtime for bun-shebang provider scripts', () => {
    const root = join(tmpdir(), `happier-cli-common-provider-bun-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const binDir = join(root, 'bin');
    mkdirSync(binDir, { recursive: true });

    const providerPath = join(binDir, 'omp');
    writeFileSync(providerPath, '#!/usr/bin/env bun\nconsole.log("ok")\n', 'utf8');
    chmodSync(providerPath, 0o755);

    expect(isProviderCliPathRunnable(providerPath, { PATH: '' }, {
      isBunRuntime: false,
      currentExecPath: process.execPath,
    })).toBe(false);

    const bunPath = join(binDir, 'bun');
    writeFileSync(bunPath, '#!/bin/sh\nexit 0\n', 'utf8');
    chmodSync(bunPath, 0o755);

    expect(isProviderCliPathRunnable(providerPath, { PATH: binDir }, {
      isBunRuntime: false,
      currentExecPath: process.execPath,
    })).toBe(true);
  });

  it('accepts oh-my-pi Bun entrypoint overrides that point at the package TypeScript source', () => {
    const root = join(tmpdir(), `happier-cli-common-provider-ohmypi-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

    expect(resolveProviderCliCommand('ohMyPi', {
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

    const root = join(tmpdir(), `happier-cli-common-provider-ohmypi-win-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const cliDir = join(root, 'src');
    mkdirSync(cliDir, { recursive: true });

    const cliPath = join(cliDir, 'cli.ts');
    writeFileSync(cliPath, '#!/usr/bin/env bun\nconsole.log("ok")\n', 'utf8');
    chmodSync(cliPath, 0o755);

    expect(resolveProviderCliCommand('ohMyPi', {
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

    const root = join(tmpdir(), `happier-cli-common-provider-ohmypi-win-bun-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

    expect(resolveProviderCliCommand('ohMyPi', {
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

  it('fails closed for a Unix TypeScript override without a shebang when no JavaScript runtime is available', () => {
    if (process.platform === 'win32') return;

    const root = join(tmpdir(), `happier-cli-common-provider-ohmypi-unix-ts-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const cliDir = join(root, 'src');
    mkdirSync(cliDir, { recursive: true });

    const cliPath = join(cliDir, 'cli.ts');
    writeFileSync(cliPath, 'console.log("ok")\n', 'utf8');
    chmodSync(cliPath, 0o644);

    expect(resolveProviderCliCommand('ohMyPi', {
      processEnv: {
        PATH: '',
        HAPPIER_OHMYPI_PATH: cliPath,
      },
      isBunRuntime: true,
      currentExecPath: join(root, 'happier'),
    })).toBeNull();
  });
});
