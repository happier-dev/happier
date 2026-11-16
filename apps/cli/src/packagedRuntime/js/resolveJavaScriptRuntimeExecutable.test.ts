import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';

import { runAddedHostedSession } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { createSessionHooksService } from '@/plugins/runtime/hooks/session/service';

import { resolveJavaScriptRuntimeExecutable } from './resolveJavaScriptRuntimeExecutable';
import { requireJavaScriptRuntimeExecutable } from './requireJavaScriptRuntimeExecutable';

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

  it('resolves hook forwarders and required scripts from each interleaved Session runtime environment', async () => {
    const roots = ['a', 'b'].map(id => {
      const root = createTempDirSync(`happier-js-session-${id}-`);
      tempDirs.add(root);
      const executable = join(root, process.platform === 'win32' ? 'node.cmd' : 'node');
      writeFileSync(executable, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n');
      if (process.platform !== 'win32') chmodSync(executable, 0o755);
      return { root, executable };
    });
    const values = await Promise.all(roots.map(({ root, executable }) => runAddedHostedSession({
      environment: { NODE_ENV: 'test', HAPPIER_MANAGED_NODE_BIN: `./${basename(executable)}` }, workingDirectory: root, end() {},
    }, async () => {
      await Promise.resolve();
      const hooks = createSessionHooksService({ happyHomeDir: root, hasCapability: () => true,
        addDisposable: disposable => disposable });
      const assets = await hooks.resolveForwarderAssets();
      expect(resolveJavaScriptRuntimeExecutable({ isBunRuntime: false, processEnv: {
        NODE_ENV: 'test',
        HAPPIER_MANAGED_NODE_BIN: process.execPath,
      } })).toBe(process.execPath);
      const requiredExecutable = await requireJavaScriptRuntimeExecutable({ isBunRuntime: false, targetLabel: 'Session script' });
      expect(await requireJavaScriptRuntimeExecutable({ isBunRuntime: false, targetLabel: 'Explicit script',
        processEnv: { NODE_ENV: 'test', HAPPIER_MANAGED_NODE_BIN: process.execPath } })).toBe(process.execPath);
      return [assets.nodeExecutable, requiredExecutable];
    })));
    expect(values).toEqual(roots.map(({ executable }) => [executable, executable]));
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

  it('runs Happier scripts on the Happier single executable without a managed runtime', () => {
    const happyHomeDir = createTempDirSync('happier-js-runtime-single-executable-');
    tempDirs.add(happyHomeDir);
    const executable = join(happyHomeDir, 'versions', '0.3.0', process.platform === 'win32' ? 'happier.exe' : 'happier');
    mkdirSync(join(executable, '..'), { recursive: true });
    writeFileSync(executable, process.platform === 'win32' ? '' : '#!/bin/sh\n', 'utf8');
    if (process.platform !== 'win32') chmodSync(executable, 0o755);
    envScope.patch({
      HAPPIER_MANAGED_NODE_BIN: undefined,
      HAPPIER_JS_RUNTIME_PATH: undefined,
      HAPPIER_NODE_PATH: undefined,
      HAPPIER_HOME_DIR: happyHomeDir,
      PATH: '',
    });
    const execPath = Object.getOwnPropertyDescriptor(process, 'execPath')!;
    // The running Node process is the single executable (a platform fact, not internal logic).
    Object.defineProperty(process, 'execPath', { ...execPath, value: executable });
    try {
      expect(resolveJavaScriptRuntimeExecutable({ isBunRuntime: false, processEnv: { ...process.env } })).toBe(executable);
    } finally {
      Object.defineProperty(process, 'execPath', execPath);
    }
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
