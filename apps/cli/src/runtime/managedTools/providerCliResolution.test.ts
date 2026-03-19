import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  resolveProviderCliCommand,
  resolveProviderCliManagedCommandPath,
} from './providerCliResolution';

const ORIGINAL_ENV = {
  HAPPIER_HOME_DIR: process.env.HAPPIER_HOME_DIR,
  HAPPIER_BACKEND_CLI_SOURCE_PREFERENCES_JSON: process.env.HAPPIER_BACKEND_CLI_SOURCE_PREFERENCES_JSON,
  HAPPIER_CODEX_PATH: process.env.HAPPIER_CODEX_PATH,
  HAPPIER_JS_RUNTIME_PATH: process.env.HAPPIER_JS_RUNTIME_PATH,
  HAPPIER_MANAGED_NODE_BIN: process.env.HAPPIER_MANAGED_NODE_BIN,
  HAPPIER_NODE_PATH: process.env.HAPPIER_NODE_PATH,
  PATH: process.env.PATH,
};

function makeExecutable(dir: string, name: string): string {
  const path = join(dir, process.platform === 'win32' ? `${name}.cmd` : name);
  const content = process.platform === 'win32'
    ? '@echo off\r\necho ok\r\n'
    : '#!/bin/sh\necho ok\n';
  writeFileSync(path, content, 'utf8');
  if (process.platform !== 'win32') chmodSync(path, 0o755);
  return path;
}

function resolveSystemJavaScriptRuntimeBinary(pathOverride?: string | undefined): string {
  const output = process.platform === 'win32'
    ? execFileSync('cmd.exe', ['/d', '/s', '/c', 'where bun || where node'], {
        encoding: 'utf8',
        env: { ...process.env, PATH: pathOverride ?? process.env.PATH ?? '' },
      })
    : execFileSync('/bin/sh', ['-lc', 'command -v bun || command -v node'], {
        encoding: 'utf8',
        env: { ...process.env, PATH: pathOverride ?? process.env.PATH ?? '' },
      });
  const [first] = String(output)
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  if (!first) throw new Error('missing JavaScript runtime binary for test');
  return first;
}

describe('resolveProviderCliCommand', () => {
  const tempDirs = new Set<string>();

  afterEach(() => {
    for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.clear();
  });

  it('prefers the system-installed CLI by default when both system and managed installs exist', () => {
    const root = mkdtempSync(join(tmpdir(), 'happier-managed-cli-resolution-'));
    tempDirs.add(root);
    process.env.HAPPIER_HOME_DIR = join(root, 'home');
    mkdirSync(process.env.HAPPIER_HOME_DIR, { recursive: true });

    const systemBin = join(root, 'system-bin');
    mkdirSync(systemBin, { recursive: true });
    const systemPath = makeExecutable(systemBin, 'codex');
    process.env.PATH = systemBin;

    const managedPath = resolveProviderCliManagedCommandPath('codex', { happyHomeDir: process.env.HAPPIER_HOME_DIR });
    mkdirSync(join(root, 'home', '.noop'), { recursive: true });
    mkdirSync(join(managedPath, '..'), { recursive: true });
    writeFileSync(managedPath, process.platform === 'win32' ? '@echo off\r\necho ok\r\n' : '#!/bin/sh\necho ok\n', 'utf8');
    if (process.platform !== 'win32') chmodSync(managedPath, 0o755);

    expect(resolveProviderCliCommand('codex')).toEqual(
      expect.objectContaining({
        source: 'system',
        command: systemPath,
      }),
    );
  });

  it('falls back to the managed CLI when the system install is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'happier-managed-cli-resolution-'));
    tempDirs.add(root);
    process.env.HAPPIER_HOME_DIR = join(root, 'home');
    mkdirSync(process.env.HAPPIER_HOME_DIR, { recursive: true });
    process.env.PATH = join(root, 'empty-path');
    mkdirSync(process.env.PATH, { recursive: true });

    const managedPath = resolveProviderCliManagedCommandPath('codex', { happyHomeDir: process.env.HAPPIER_HOME_DIR });
    mkdirSync(join(managedPath, '..'), { recursive: true });
    writeFileSync(managedPath, process.platform === 'win32' ? '@echo off\r\necho ok\r\n' : '#!/bin/sh\necho ok\n', 'utf8');
    if (process.platform !== 'win32') chmodSync(managedPath, 0o755);

    expect(resolveProviderCliCommand('codex')).toEqual(
      expect.objectContaining({
        source: 'managed',
        command: managedPath,
      }),
    );
  });

  it('ignores a non-executable managed CLI on Unix', () => {
    if (process.platform === 'win32') return;

    const root = mkdtempSync(join(tmpdir(), 'happier-managed-cli-resolution-'));
    tempDirs.add(root);
    process.env.HAPPIER_HOME_DIR = join(root, 'home');
    mkdirSync(process.env.HAPPIER_HOME_DIR, { recursive: true });
    process.env.PATH = join(root, 'empty-path');
    mkdirSync(process.env.PATH, { recursive: true });

    const managedPath = resolveProviderCliManagedCommandPath('codex', { happyHomeDir: process.env.HAPPIER_HOME_DIR });
    mkdirSync(join(managedPath, '..'), { recursive: true });
    writeFileSync(managedPath, '#!/bin/sh\necho ok\n', 'utf8');
    chmodSync(managedPath, 0o644);

    expect(resolveProviderCliCommand('codex')).toBeNull();
  });

  it('honors managed-first source preferences for backend CLIs', () => {
    const root = mkdtempSync(join(tmpdir(), 'happier-managed-cli-resolution-'));
    tempDirs.add(root);
    process.env.HAPPIER_HOME_DIR = join(root, 'home');
    mkdirSync(process.env.HAPPIER_HOME_DIR, { recursive: true });

    const systemBin = join(root, 'system-bin');
    mkdirSync(systemBin, { recursive: true });
    makeExecutable(systemBin, 'codex');
    process.env.PATH = systemBin;

    const managedPath = resolveProviderCliManagedCommandPath('codex', { happyHomeDir: process.env.HAPPIER_HOME_DIR });
    mkdirSync(join(managedPath, '..'), { recursive: true });
    writeFileSync(managedPath, process.platform === 'win32' ? '@echo off\r\necho ok\r\n' : '#!/bin/sh\necho ok\n', 'utf8');
    if (process.platform !== 'win32') chmodSync(managedPath, 0o755);

    process.env.HAPPIER_BACKEND_CLI_SOURCE_PREFERENCES_JSON = JSON.stringify({ codex: 'managed-first' });

    expect(resolveProviderCliCommand('codex')).toEqual(
      expect.objectContaining({
        source: 'managed',
        command: managedPath,
      }),
    );
  });

  it('lets explicit path overrides win over every other source', () => {
    const root = mkdtempSync(join(tmpdir(), 'happier-managed-cli-resolution-'));
    tempDirs.add(root);
    const overrideDir = join(root, 'override');
    mkdirSync(overrideDir, { recursive: true });
    const overridePath = makeExecutable(overrideDir, 'codex');
    process.env.HAPPIER_CODEX_PATH = overridePath;

    expect(resolveProviderCliCommand('codex')).toEqual(
      expect.objectContaining({
        source: 'override',
        command: overridePath,
      }),
    );
  });

  it('fails closed when an explicit override is set but does not point to an executable', () => {
    const root = mkdtempSync(join(tmpdir(), 'happier-managed-cli-resolution-'));
    tempDirs.add(root);
    process.env.HAPPIER_HOME_DIR = join(root, 'home');
    mkdirSync(process.env.HAPPIER_HOME_DIR, { recursive: true });

    const systemBin = join(root, 'system-bin');
    mkdirSync(systemBin, { recursive: true });
    makeExecutable(systemBin, 'codex');
    process.env.PATH = systemBin;

    process.env.HAPPIER_CODEX_PATH = join(root, 'missing-codex');

    expect(resolveProviderCliCommand('codex')).toBeNull();
  });

  it('fails closed for a Claude JavaScript override when the explicit JS runtime override is invalid', () => {
    if (process.platform === 'win32') return;

    const root = mkdtempSync(join(tmpdir(), 'happier-managed-cli-resolution-'));
    tempDirs.add(root);
    const overrideDir = join(root, 'override');
    mkdirSync(overrideDir, { recursive: true });
    const overridePath = join(overrideDir, 'claude.js');
    writeFileSync(overridePath, 'import "./entry.cjs";\n', 'utf8');
    chmodSync(overridePath, 0o644);
    process.env.HAPPIER_CLAUDE_PATH = overridePath;
    process.env.HAPPIER_JS_RUNTIME_PATH = join(root, 'missing-runtime', 'node');

    expect(resolveProviderCliCommand('claude')).toBeNull();
  });

  it('accepts a Claude JavaScript override entrypoint even when the file is not directly executable on Unix', () => {
    const root = mkdtempSync(join(tmpdir(), 'happier-managed-cli-resolution-'));
    tempDirs.add(root);
    const overrideDir = join(root, 'override');
    mkdirSync(overrideDir, { recursive: true });
    const overridePath = join(overrideDir, 'claude.js');
    writeFileSync(overridePath, 'import "./entry.cjs";\n', 'utf8');
    if (process.platform !== 'win32') chmodSync(overridePath, 0o644);
    process.env.HAPPIER_CLAUDE_PATH = overridePath;
    process.env.HAPPIER_JS_RUNTIME_PATH = resolveSystemJavaScriptRuntimeBinary(ORIGINAL_ENV.PATH);

    expect(resolveProviderCliCommand('claude')).toEqual(
      expect.objectContaining({
        source: 'override',
        command: overridePath,
      }),
    );
  });

  it('fails closed for a system node-shebang provider script under bun when no JavaScript runtime is available', () => {
    if (process.platform === 'win32') return;

    const root = mkdtempSync(join(tmpdir(), 'happier-managed-cli-resolution-'));
    tempDirs.add(root);
    process.env.HAPPIER_HOME_DIR = join(root, 'home');
    mkdirSync(process.env.HAPPIER_HOME_DIR, { recursive: true });
    const systemBin = join(root, 'system-bin');
    mkdirSync(systemBin, { recursive: true });
    const systemPath = join(systemBin, 'gemini');
    writeFileSync(systemPath, '#!/usr/bin/env node\nconsole.log("ok");\n', 'utf8');
    chmodSync(systemPath, 0o755);
    process.env.PATH = systemBin;
    delete process.env.HAPPIER_JS_RUNTIME_PATH;
    delete process.env.HAPPIER_MANAGED_NODE_BIN;
    delete process.env.HAPPIER_NODE_PATH;

    expect(
      resolveProviderCliCommand('gemini', {
        isBunRuntime: true,
        currentExecPath: join(root, 'happier'),
      }),
    ).toBeNull();
  });

  it('accepts a system node-shebang provider script under bun when a JavaScript runtime override is configured', () => {
    if (process.platform === 'win32') return;

    const root = mkdtempSync(join(tmpdir(), 'happier-managed-cli-resolution-'));
    tempDirs.add(root);
    process.env.HAPPIER_HOME_DIR = join(root, 'home');
    mkdirSync(process.env.HAPPIER_HOME_DIR, { recursive: true });
    const systemBin = join(root, 'system-bin');
    mkdirSync(systemBin, { recursive: true });
    const systemPath = join(systemBin, 'gemini');
    writeFileSync(systemPath, '#!/usr/bin/env node\nconsole.log("ok");\n', 'utf8');
    chmodSync(systemPath, 0o755);
    process.env.PATH = systemBin;
    process.env.HAPPIER_JS_RUNTIME_PATH = resolveSystemJavaScriptRuntimeBinary(ORIGINAL_ENV.PATH);

    expect(
      resolveProviderCliCommand('gemini', {
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
});
