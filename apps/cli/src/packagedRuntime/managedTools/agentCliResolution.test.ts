import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { createEnvKeyScope } from '../../testkit/env/envScope';
import { writeTextFileSync } from '../../testkit/fs/fileHelpers';
import { resolveSystemJavaScriptRuntimeBinary, writeExecutableShimSync } from '../../testkit/fs/executableShim';
import { createTempDirSync, removeTempDirSync } from '../../testkit/fs/tempDir';
import {
  resolveAgentCliCommand,
  resolveAgentCliManagedCommandPath,
} from './agentCliResolution';

const envKeys = [
  'HAPPIER_HOME_DIR',
  'HAPPIER_BACKEND_CLI_SOURCE_PREFERENCES_JSON',
  'HAPPIER_CODEX_PATH',
  'HAPPIER_CLAUDE_PATH',
  'HAPPIER_JS_RUNTIME_PATH',
  'HAPPIER_MANAGED_NODE_BIN',
  'HAPPIER_NODE_PATH',
  'PATH',
] as const;
const originalPath = process.env.PATH;

function makeExecutable(dir: string, name: string): string {
  const fileName = process.platform === 'win32' ? `${name}.cmd` : name;
  const content = process.platform === 'win32'
    ? '@echo off\r\necho ok\r\n'
    : '#!/bin/sh\necho ok\n';
  return writeExecutableShimSync({
    dir,
    fileName,
    contents: content,
  });
}

function writeManagedExecutable(filePath: string, contents: string): void {
  writeExecutableShimSync({
    dir: dirname(filePath),
    fileName: basename(filePath),
    contents,
  });
}

describe('resolveAgentCliCommand', () => {
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

  it('prefers the system-installed CLI by default when both system and managed installs exist', () => {
    const root = createTempDirSync('happier-managed-cli-resolution-', tmpdir());
    tempDirs.add(root);
    process.env.HAPPIER_HOME_DIR = join(root, 'home');
    mkdirSync(process.env.HAPPIER_HOME_DIR, { recursive: true });

    const systemBin = join(root, 'system-bin');
    mkdirSync(systemBin, { recursive: true });
    const systemPath = makeExecutable(systemBin, 'codex');
    process.env.PATH = systemBin;

    const managedPath = resolveAgentCliManagedCommandPath('codex', { happyHomeDir: process.env.HAPPIER_HOME_DIR });
    mkdirSync(join(root, 'home', '.noop'), { recursive: true });
    writeManagedExecutable(managedPath, process.platform === 'win32' ? '@echo off\r\necho ok\r\n' : '#!/bin/sh\necho ok\n');

    expect(resolveAgentCliCommand('codex')).toEqual(
      expect.objectContaining({
        source: 'system',
        command: systemPath,
      }),
    );
  });

  it('falls back to the managed CLI when the system install is missing', () => {
    const root = createTempDirSync('happier-managed-cli-resolution-', tmpdir());
    tempDirs.add(root);
    process.env.HAPPIER_HOME_DIR = join(root, 'home');
    mkdirSync(process.env.HAPPIER_HOME_DIR, { recursive: true });
    process.env.PATH = join(root, 'empty-path');
    mkdirSync(process.env.PATH, { recursive: true });

    const managedPath = resolveAgentCliManagedCommandPath('codex', { happyHomeDir: process.env.HAPPIER_HOME_DIR });
    writeManagedExecutable(managedPath, process.platform === 'win32' ? '@echo off\r\necho ok\r\n' : '#!/bin/sh\necho ok\n');

    expect(resolveAgentCliCommand('codex')).toEqual(
      expect.objectContaining({
        source: 'managed',
        command: managedPath,
      }),
    );
  });

  it('ignores a non-executable managed CLI on Unix', () => {
    if (process.platform === 'win32') return;

    const root = createTempDirSync('happier-managed-cli-resolution-', tmpdir());
    tempDirs.add(root);
    process.env.HAPPIER_HOME_DIR = join(root, 'home');
    mkdirSync(process.env.HAPPIER_HOME_DIR, { recursive: true });
    process.env.PATH = join(root, 'empty-path');
    mkdirSync(process.env.PATH, { recursive: true });

    const managedPath = resolveAgentCliManagedCommandPath('codex', { happyHomeDir: process.env.HAPPIER_HOME_DIR });
    writeTextFileSync(managedPath, '#!/bin/sh\necho ok\n');
    chmodSync(managedPath, 0o644);

    expect(resolveAgentCliCommand('codex')).toBeNull();
  });

  it('honors managed-first source preferences for backend CLIs', () => {
    const root = createTempDirSync('happier-managed-cli-resolution-', tmpdir());
    tempDirs.add(root);
    process.env.HAPPIER_HOME_DIR = join(root, 'home');
    mkdirSync(process.env.HAPPIER_HOME_DIR, { recursive: true });

    const systemBin = join(root, 'system-bin');
    mkdirSync(systemBin, { recursive: true });
    makeExecutable(systemBin, 'codex');
    process.env.PATH = systemBin;

    const managedPath = resolveAgentCliManagedCommandPath('codex', { happyHomeDir: process.env.HAPPIER_HOME_DIR });
    writeManagedExecutable(managedPath, process.platform === 'win32' ? '@echo off\r\necho ok\r\n' : '#!/bin/sh\necho ok\n');

    process.env.HAPPIER_BACKEND_CLI_SOURCE_PREFERENCES_JSON = JSON.stringify({ codex: 'managed-first' });

    expect(resolveAgentCliCommand('codex')).toEqual(
      expect.objectContaining({
        source: 'managed',
        command: managedPath,
      }),
    );
  });

  it('lets explicit path overrides win over every other source', () => {
    const root = createTempDirSync('happier-managed-cli-resolution-', tmpdir());
    tempDirs.add(root);
    const overrideDir = join(root, 'override');
    mkdirSync(overrideDir, { recursive: true });
    const overridePath = makeExecutable(overrideDir, 'codex');
    process.env.HAPPIER_CODEX_PATH = overridePath;

    expect(resolveAgentCliCommand('codex')).toEqual(
      expect.objectContaining({
        source: 'override',
        command: overridePath,
      }),
    );
  });

  it('fails closed when an explicit override is set but does not point to an executable', () => {
    const root = createTempDirSync('happier-managed-cli-resolution-', tmpdir());
    tempDirs.add(root);
    process.env.HAPPIER_HOME_DIR = join(root, 'home');
    mkdirSync(process.env.HAPPIER_HOME_DIR, { recursive: true });

    const systemBin = join(root, 'system-bin');
    mkdirSync(systemBin, { recursive: true });
    makeExecutable(systemBin, 'codex');
    process.env.PATH = systemBin;

    process.env.HAPPIER_CODEX_PATH = join(root, 'missing-codex');

    expect(resolveAgentCliCommand('codex')).toBeNull();
  });

  it('fails closed for a Claude JavaScript override when the explicit JS runtime override is invalid', () => {
    if (process.platform === 'win32') return;

    const root = createTempDirSync('happier-managed-cli-resolution-', tmpdir());
    tempDirs.add(root);
    const overrideDir = join(root, 'override');
    mkdirSync(overrideDir, { recursive: true });
    const overridePath = join(overrideDir, 'claude.js');
    writeTextFileSync(overridePath, 'import "./entry.cjs";\n');
    chmodSync(overridePath, 0o644);
    process.env.HAPPIER_CLAUDE_PATH = overridePath;
    process.env.HAPPIER_JS_RUNTIME_PATH = join(root, 'missing-runtime', 'node');

    expect(resolveAgentCliCommand('claude')).toBeNull();
  });

  it('accepts a Claude JavaScript override entrypoint even when the file is not directly executable on Unix', () => {
    const root = createTempDirSync('happier-managed-cli-resolution-', tmpdir());
    tempDirs.add(root);
    const overrideDir = join(root, 'override');
    mkdirSync(overrideDir, { recursive: true });
    const overridePath = join(overrideDir, 'claude.js');
    writeTextFileSync(overridePath, 'import "./entry.cjs";\n');
    if (process.platform !== 'win32') chmodSync(overridePath, 0o644);
    process.env.HAPPIER_CLAUDE_PATH = overridePath;
    process.env.HAPPIER_JS_RUNTIME_PATH = resolveSystemJavaScriptRuntimeBinary(originalPath);

    expect(resolveAgentCliCommand('claude')).toEqual(
      expect.objectContaining({
        source: 'override',
        command: overridePath,
      }),
    );
  });

  it('fails closed for a system node-shebang agent script under bun when no JavaScript runtime is available', () => {
    if (process.platform === 'win32') return;

    const root = createTempDirSync('happier-managed-cli-resolution-', tmpdir());
    tempDirs.add(root);
    process.env.HAPPIER_HOME_DIR = join(root, 'home');
    mkdirSync(process.env.HAPPIER_HOME_DIR, { recursive: true });
    const systemBin = join(root, 'system-bin');
    mkdirSync(systemBin, { recursive: true });
    const systemPath = join(systemBin, 'gemini');
    writeTextFileSync(systemPath, '#!/usr/bin/env node\nconsole.log("ok");\n');
    chmodSync(systemPath, 0o755);
    process.env.PATH = systemBin;
    delete process.env.HAPPIER_JS_RUNTIME_PATH;
    delete process.env.HAPPIER_MANAGED_NODE_BIN;
    delete process.env.HAPPIER_NODE_PATH;

    expect(
      resolveAgentCliCommand('gemini', {
        isBunRuntime: true,
        currentExecPath: join(root, 'happier'),
      }),
    ).toBeNull();
  });

  it('accepts a system node-shebang agent script under bun when a JavaScript runtime override is configured', () => {
    if (process.platform === 'win32') return;

    const root = createTempDirSync('happier-managed-cli-resolution-', tmpdir());
    tempDirs.add(root);
    process.env.HAPPIER_HOME_DIR = join(root, 'home');
    mkdirSync(process.env.HAPPIER_HOME_DIR, { recursive: true });
    const systemBin = join(root, 'system-bin');
    mkdirSync(systemBin, { recursive: true });
    const systemPath = join(systemBin, 'gemini');
    writeTextFileSync(systemPath, '#!/usr/bin/env node\nconsole.log("ok");\n');
    chmodSync(systemPath, 0o755);
    process.env.PATH = systemBin;
    process.env.HAPPIER_JS_RUNTIME_PATH = resolveSystemJavaScriptRuntimeBinary(originalPath);

    expect(
      resolveAgentCliCommand('gemini', {
        isBunRuntime: true,
        currentExecPath: join(root, 'happier'),
      }),
    ).toEqual(
      expect.objectContaining({
        source: 'system',
        command: systemPath,
      }),
    );
  });

  it('falls back to the managed oh-my-pi binary when the system install is a bun script but bun is unavailable', () => {
    if (process.platform === 'win32') return;

    const root = createTempDirSync('happier-managed-cli-resolution-', tmpdir());
    tempDirs.add(root);
    process.env.HAPPIER_HOME_DIR = join(root, 'home');
    mkdirSync(process.env.HAPPIER_HOME_DIR, { recursive: true });

    const systemBin = join(root, 'system-bin');
    mkdirSync(systemBin, { recursive: true });
    const systemPath = join(systemBin, 'omp');
    writeTextFileSync(systemPath, '#!/usr/bin/env bun\nconsole.log("ok");\n');
    chmodSync(systemPath, 0o755);
    process.env.PATH = systemBin;

    const managedPath = resolveAgentCliManagedCommandPath('ohMyPi', { happyHomeDir: process.env.HAPPIER_HOME_DIR });
    writeManagedExecutable(managedPath, '#!/bin/sh\necho ok\n');

    expect(
      resolveAgentCliCommand('ohMyPi', {
        isBunRuntime: false,
        currentExecPath: join(root, 'happier'),
      }),
    ).toEqual(
      expect.objectContaining({
        source: 'managed',
        command: managedPath,
      }),
    );
    expect(systemPath).not.toBe(managedPath);
  });
});
