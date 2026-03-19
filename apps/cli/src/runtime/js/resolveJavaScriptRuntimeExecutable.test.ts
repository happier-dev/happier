import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveJavaScriptRuntimeExecutable } from './resolveJavaScriptRuntimeExecutable';

describe('resolveJavaScriptRuntimeExecutable', () => {
  const originalManagedNode = process.env.HAPPIER_MANAGED_NODE_BIN;
  const originalRuntimePath = process.env.HAPPIER_JS_RUNTIME_PATH;
  const originalNodePath = process.env.HAPPIER_NODE_PATH;
  const originalHappyHomeDir = process.env.HAPPIER_HOME_DIR;

  afterEach(() => {
    if (originalManagedNode === undefined) delete process.env.HAPPIER_MANAGED_NODE_BIN;
    else process.env.HAPPIER_MANAGED_NODE_BIN = originalManagedNode;
    if (originalRuntimePath === undefined) delete process.env.HAPPIER_JS_RUNTIME_PATH;
    else process.env.HAPPIER_JS_RUNTIME_PATH = originalRuntimePath;
    if (originalNodePath === undefined) delete process.env.HAPPIER_NODE_PATH;
    else process.env.HAPPIER_NODE_PATH = originalNodePath;
    if (originalHappyHomeDir === undefined) delete process.env.HAPPIER_HOME_DIR;
    else process.env.HAPPIER_HOME_DIR = originalHappyHomeDir;
  });

  it('prefers an explicit managed node override', () => {
    const happyHomeDir = join(tmpdir(), `happier-js-runtime-override-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const overridePath = join(happyHomeDir, process.platform === 'win32' ? 'managed-node.cmd' : 'managed-node');
    mkdirSync(happyHomeDir, { recursive: true });
    writeFileSync(overridePath, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n', 'utf8');
    if (process.platform !== 'win32') chmodSync(overridePath, 0o755);
    process.env.HAPPIER_MANAGED_NODE_BIN = overridePath;
    try {
      expect(resolveJavaScriptRuntimeExecutable({ isBunRuntime: false })).toBe(overridePath);
    } finally {
      rmSync(happyHomeDir, { recursive: true, force: true });
    }
  });

  it('falls back to process.execPath under the node runtime', () => {
    delete process.env.HAPPIER_MANAGED_NODE_BIN;
    delete process.env.HAPPIER_JS_RUNTIME_PATH;
    delete process.env.HAPPIER_NODE_PATH;
    delete process.env.HAPPIER_HOME_DIR;
    expect(resolveJavaScriptRuntimeExecutable({ isBunRuntime: false })).toBe(process.execPath);
  });

  it('prefers an installed managed JavaScript runtime wrapper under bun', () => {
    delete process.env.HAPPIER_MANAGED_NODE_BIN;
    delete process.env.HAPPIER_JS_RUNTIME_PATH;
    delete process.env.HAPPIER_NODE_PATH;
    const happyHomeDir = join(tmpdir(), `happier-js-runtime-${Date.now()}-${Math.random().toString(16).slice(2)}`);
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
    process.env.HAPPIER_HOME_DIR = happyHomeDir;
    try {
      expect(resolveJavaScriptRuntimeExecutable({ isBunRuntime: true, currentExecPath: '/tmp/happier' })).toBe(wrapperPath);
    } finally {
      rmSync(happyHomeDir, { recursive: true, force: true });
    }
  });

  it('uses the current bun executable under the direct bun runtime', () => {
    delete process.env.HAPPIER_MANAGED_NODE_BIN;
    delete process.env.HAPPIER_JS_RUNTIME_PATH;
    delete process.env.HAPPIER_NODE_PATH;
    delete process.env.HAPPIER_HOME_DIR;
    expect(resolveJavaScriptRuntimeExecutable({ isBunRuntime: true, currentExecPath: '/opt/homebrew/bin/bun' })).toBe('/opt/homebrew/bin/bun');
  });

  it('fails closed (returns null) under bundled bun when no managed runtime is available', () => {
    delete process.env.HAPPIER_MANAGED_NODE_BIN;
    delete process.env.HAPPIER_JS_RUNTIME_PATH;
    delete process.env.HAPPIER_NODE_PATH;
    delete process.env.HAPPIER_HOME_DIR;
    expect(resolveJavaScriptRuntimeExecutable({ isBunRuntime: true, currentExecPath: '/tmp/happier' })).toBe(null);
  });

  it('fails closed for a non-executable managed node override instead of falling back', () => {
    if (process.platform === 'win32') {
      return;
    }
    const happyHomeDir = join(tmpdir(), `happier-js-runtime-override-nonexec-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const overridePath = join(happyHomeDir, 'managed-node');
    mkdirSync(happyHomeDir, { recursive: true });
    writeFileSync(overridePath, '#!/bin/sh\n', 'utf8');
    process.env.HAPPIER_MANAGED_NODE_BIN = overridePath;
    delete process.env.HAPPIER_JS_RUNTIME_PATH;
    delete process.env.HAPPIER_NODE_PATH;
    delete process.env.HAPPIER_HOME_DIR;
    try {
      expect(resolveJavaScriptRuntimeExecutable({ isBunRuntime: false })).toBe(null);
    } finally {
      rmSync(happyHomeDir, { recursive: true, force: true });
    }
  });
});
