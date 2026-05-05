import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';

import { resolveJavaScriptRuntimeExecutable } from './resolveJavaScriptRuntimeExecutable';

const envKeys = [
  'HAPPIER_MANAGED_NODE_BIN',
  'HAPPIER_JS_RUNTIME_PATH',
  'HAPPIER_NODE_PATH',
  'HAPPIER_HOME_DIR',
  'PATH',
] as const;

describe('resolveJavaScriptRuntimeExecutable', () => {
  const tempDirs = new Set<string>();
  let envScope = createEnvKeyScope(envKeys);

  afterEach(() => {
    envScope.restore();
    envScope = createEnvKeyScope(envKeys);
    for (const dir of tempDirs) {
      removeTempDirSync(dir);
    }
    tempDirs.clear();
  });

  it('prefers an explicit managed node override', () => {
    const happyHomeDir = createTempDirSync('happier-js-runtime-override-');
    tempDirs.add(happyHomeDir);
    const overridePath = join(happyHomeDir, process.platform === 'win32' ? 'managed-node.cmd' : 'managed-node');
    writeFileSync(overridePath, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n', 'utf8');
    if (process.platform !== 'win32') chmodSync(overridePath, 0o755);

    envScope.patch({ HAPPIER_MANAGED_NODE_BIN: overridePath });

    expect(resolveJavaScriptRuntimeExecutable({ isBunRuntime: false })).toBe(overridePath);
  });

  it('falls back to process.execPath under the node runtime', () => {
    envScope.patch({
      HAPPIER_MANAGED_NODE_BIN: undefined,
      HAPPIER_JS_RUNTIME_PATH: undefined,
      HAPPIER_NODE_PATH: undefined,
      HAPPIER_HOME_DIR: undefined,
    });

    expect(resolveJavaScriptRuntimeExecutable({ isBunRuntime: false })).toBe(process.execPath);
  });

  it('prefers an installed managed JavaScript runtime wrapper under bun', () => {
    const happyHomeDir = createTempDirSync('happier-js-runtime-');
    tempDirs.add(happyHomeDir);
    const wrapperPath = join(happyHomeDir, 'tools', 'js-runtime', 'current', 'bin', 'happier-js-runtime');
    const runtimeBinaryPath =
      process.platform === 'win32'
        ? join(happyHomeDir, 'tools', 'js-runtime', 'current', 'runtime', 'node.exe')
        : join(happyHomeDir, 'tools', 'js-runtime', 'current', 'runtime', 'bin', 'node');
    mkdirSync(join(happyHomeDir, 'tools', 'js-runtime', 'current', 'bin'), { recursive: true });
    mkdirSync(join(runtimeBinaryPath, '..'), { recursive: true });
    writeFileSync(wrapperPath, '#!/bin/sh\n', 'utf8');
    writeFileSync(runtimeBinaryPath, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n', 'utf8');
    if (process.platform !== 'win32') chmodSync(wrapperPath, 0o755);
    if (process.platform !== 'win32') chmodSync(runtimeBinaryPath, 0o755);

    envScope.patch({
      HAPPIER_MANAGED_NODE_BIN: undefined,
      HAPPIER_JS_RUNTIME_PATH: undefined,
      HAPPIER_NODE_PATH: undefined,
      HAPPIER_HOME_DIR: happyHomeDir,
      PATH: '',
    });

    expect(resolveJavaScriptRuntimeExecutable({
      isBunRuntime: true,
      currentExecPath: '/tmp/happier',
      processEnv: { ...process.env },
    })).toBe(wrapperPath);
  });

  it('uses the current bun executable under the direct bun runtime', () => {
    envScope.patch({
      HAPPIER_MANAGED_NODE_BIN: undefined,
      HAPPIER_JS_RUNTIME_PATH: undefined,
      HAPPIER_NODE_PATH: undefined,
      HAPPIER_HOME_DIR: undefined,
      PATH: '',
    });

    expect(resolveJavaScriptRuntimeExecutable({ isBunRuntime: true, currentExecPath: '/opt/homebrew/bin/bun' })).toBe('/opt/homebrew/bin/bun');
  });

  it('fails closed (returns null) under bundled bun when no managed runtime is available', () => {
    const happyHomeDir = createTempDirSync('happier-js-runtime-missing-');
    tempDirs.add(happyHomeDir);

    envScope.patch({
      HAPPIER_MANAGED_NODE_BIN: undefined,
      HAPPIER_JS_RUNTIME_PATH: undefined,
      HAPPIER_NODE_PATH: undefined,
      HAPPIER_HOME_DIR: happyHomeDir,
      PATH: '',
    });

    expect(resolveJavaScriptRuntimeExecutable({
      isBunRuntime: true,
      currentExecPath: '/tmp/happier',
      processEnv: { ...process.env },
    })).toBe(null);
  });

  it('fails closed for a non-executable managed node override instead of falling back', () => {
    if (process.platform === 'win32') {
      return;
    }

    const happyHomeDir = createTempDirSync('happier-js-runtime-override-nonexec-');
    tempDirs.add(happyHomeDir);
    const overridePath = join(happyHomeDir, 'managed-node');
    writeFileSync(overridePath, '#!/bin/sh\n', 'utf8');

    envScope.patch({
      HAPPIER_MANAGED_NODE_BIN: overridePath,
      HAPPIER_JS_RUNTIME_PATH: undefined,
      HAPPIER_NODE_PATH: undefined,
      HAPPIER_HOME_DIR: undefined,
    });

    expect(resolveJavaScriptRuntimeExecutable({ isBunRuntime: false })).toBe(null);
  });
});
