import { afterEach, describe, expect, it, vi } from 'vitest';

import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createOpenCodeBackend } from './backend';

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
  },
}));

type AcpBackendLike = {
  options: {
    command: string;
    args: string[];
    env: Record<string, string>;
  };
};

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeUnixExecutable(params: { dir: string; name: string; content: string }): string {
  const filePath = join(params.dir, params.name);
  writeFileSync(filePath, params.content, 'utf8');
  chmodSync(filePath, 0o755);
  return filePath;
}

function makeWindowsCmdExecutable(params: { dir: string; name: string; content: string }): string {
  const filePath = join(params.dir, `${params.name}.cmd`);
  writeFileSync(filePath, params.content, 'utf8');
  return filePath;
}

function expectDefaultAcpArgs(args: string[]): void {
  expect(args[0]).toBe('acp');
  expect(args).toContain('--print-logs');
  const logLevelIdx = args.indexOf('--log-level');
  expect(logLevelIdx).toBeGreaterThanOrEqual(0);
  expect(args[logLevelIdx + 1]).toBe('ERROR');
}

describe('createOpenCodeBackend command resolution', () => {
  const originalHappyHomeDir = process.env.HAPPIER_HOME_DIR;
  const originalHome = process.env.HOME;
  const originalOpenCodePath = process.env.HAPPIER_OPENCODE_PATH;
  const originalPath = process.env.PATH;
  const originalPrintLogs = process.env.HAPPIER_OPENCODE_ACP_PRINT_LOGS;
  const originalLogLevel = process.env.HAPPIER_OPENCODE_ACP_LOG_LEVEL;
  const tempDirs: string[] = [];

  afterEach(() => {
    if (originalHappyHomeDir === undefined) delete process.env.HAPPIER_HOME_DIR;
    else process.env.HAPPIER_HOME_DIR = originalHappyHomeDir;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalOpenCodePath === undefined) delete process.env.HAPPIER_OPENCODE_PATH;
    else process.env.HAPPIER_OPENCODE_PATH = originalOpenCodePath;
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;

    if (originalPrintLogs === undefined) delete process.env.HAPPIER_OPENCODE_ACP_PRINT_LOGS;
    else process.env.HAPPIER_OPENCODE_ACP_PRINT_LOGS = originalPrintLogs;

    if (originalLogLevel === undefined) delete process.env.HAPPIER_OPENCODE_ACP_LOG_LEVEL;
    else process.env.HAPPIER_OPENCODE_ACP_LOG_LEVEL = originalLogLevel;

    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    {
      label: 'unset override',
      override: undefined,
      expectedMessage: /Opencode CLI \(opencode\) is not available from any configured source/,
    },
    {
      label: 'whitespace override',
      override: '   ',
      expectedMessage: /Opencode CLI \(opencode\) is not available from any configured source/,
    },
    {
      label: 'non-existent override',
      override: join(tmpdir(), 'definitely-missing-opencode-binary'),
      expectedMessage: /HAPPIER_OPENCODE_PATH is set but does not point to a supported CLI entrypoint/,
    },
  ])('fails closed for $label when OpenCode is not resolvable', ({ override, expectedMessage }) => {
    const happyHomeDir = makeTempDir('happier-opencode-home-');
    tempDirs.push(happyHomeDir);
    process.env.HAPPIER_HOME_DIR = happyHomeDir;
    process.env.HOME = happyHomeDir;
    process.env.PATH = '';
    if (override === undefined) delete process.env.HAPPIER_OPENCODE_PATH;
    else process.env.HAPPIER_OPENCODE_PATH = override;

    expect(() => createOpenCodeBackend({ cwd: tmpdir(), env: {} })).toThrow(
      expectedMessage,
    );
  });

  it('handles non-executable override paths with explicit platform semantics', () => {
    const happyHomeDir = makeTempDir('happier-opencode-home-');
    tempDirs.push(happyHomeDir);
    process.env.HAPPIER_HOME_DIR = happyHomeDir;
    process.env.HOME = happyHomeDir;
    process.env.PATH = '';
    const workDir = makeTempDir('happier-opencode-backend-');
    tempDirs.push(workDir);
    const binDir = join(workDir, 'bin');
    mkdirSync(binDir, { recursive: true });
    const nonExecutablePath = join(binDir, process.platform === 'win32' ? 'opencode.txt' : 'opencode');
    writeFileSync(nonExecutablePath, '#!/bin/sh\necho "ok"\n', 'utf8');

    process.env.HAPPIER_OPENCODE_PATH = nonExecutablePath;

    const factory = () => createOpenCodeBackend({ cwd: workDir, env: {} }) as unknown as AcpBackendLike;
    if (process.platform === 'win32') {
      const backend = factory();
      expect(backend.options.command).toBe(nonExecutablePath);
      expectDefaultAcpArgs(backend.options.args);
      return;
    }
    expect(factory).toThrow(/HAPPIER_OPENCODE_PATH is set but does not point to a supported CLI entrypoint/);
  });

  it('uses HAPPIER_OPENCODE_PATH when it points to an existing executable', () => {
    const workDir = makeTempDir('happier-opencode-backend-');
    tempDirs.push(workDir);
    const binDir = join(workDir, 'bin');
    mkdirSync(binDir, { recursive: true });

    const opencodePath = process.platform === 'win32'
      ? makeWindowsCmdExecutable({
        dir: binDir,
        name: 'opencode',
        content: ['@echo off', 'echo ok', ''].join('\r\n'),
      })
      : makeUnixExecutable({
        dir: binDir,
        name: 'opencode',
        content: ['#!/bin/sh', 'echo "ok"', ''].join('\n'),
      });

    process.env.HAPPIER_OPENCODE_PATH = opencodePath;

    const backend = createOpenCodeBackend({ cwd: workDir, env: {} }) as unknown as AcpBackendLike;
    expect(backend.options.command).toBe(opencodePath);
    expectDefaultAcpArgs(backend.options.args);
    expect(backend.options.env.NODE_ENV).toBe('production');
    expect(backend.options.env.DEBUG).toBe('');
  });
});

describe('createOpenCodeBackend OPENCODE_CONFIG_CONTENT handling', () => {
  const tempDirs: string[] = [];
  const originalProcessEnv = { ...process.env };

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalProcessEnv)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(originalProcessEnv)) process.env[key] = value;

    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes through OPENCODE_CONFIG_CONTENT from process.env when set', () => {
    const workDir = makeTempDir('happier-opencode-env-');
    tempDirs.push(workDir);
    process.env.OPENCODE_CONFIG_CONTENT = '{"model":"from-process-env"}';

    const backend = createOpenCodeBackend({ cwd: workDir, env: {} }) as unknown as AcpBackendLike;
    expect(backend.options.env.OPENCODE_CONFIG_CONTENT).toBe('{"model":"from-process-env"}');
    expectDefaultAcpArgs(backend.options.args);
  });

  it('prefers options.env.OPENCODE_CONFIG_CONTENT over process.env when both are set', () => {
    const workDir = makeTempDir('happier-opencode-env-');
    tempDirs.push(workDir);
    process.env.OPENCODE_CONFIG_CONTENT = '{"model":"from-process-env"}';

    const backend = createOpenCodeBackend({
      cwd: workDir,
      env: { OPENCODE_CONFIG_CONTENT: '{"model":"from-options-env"}' },
    }) as unknown as AcpBackendLike;
    expect(backend.options.env.OPENCODE_CONFIG_CONTENT).toBe('{"model":"from-options-env"}');
    expectDefaultAcpArgs(backend.options.args);
  });

  it('does not read ~/.config/opencode/opencode.json and does not set OPENCODE_CONFIG_CONTENT when env is unset', () => {
    const homeDir = makeTempDir('happier-opencode-home-');
    tempDirs.push(homeDir);
    process.env.HOME = homeDir;
    process.env.XDG_CONFIG_HOME = join(homeDir, '.config');

    const configDir = join(homeDir, '.config', 'opencode');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'opencode.json'), '{"model":"from-disk"}', 'utf8');

    delete process.env.OPENCODE_CONFIG_CONTENT;

    const backend = createOpenCodeBackend({ cwd: homeDir, env: {} }) as unknown as AcpBackendLike;
    expect(backend.options.env.OPENCODE_CONFIG_CONTENT).toBeUndefined();
    expectDefaultAcpArgs(backend.options.args);
  });

  it('can disable stderr log printing via env', () => {
    const backend = createOpenCodeBackend({
      cwd: '/tmp',
      env: { HAPPIER_OPENCODE_ACP_PRINT_LOGS: '0' },
    }) as unknown as AcpBackendLike;
    expect(backend.options.args[0]).toBe('acp');
    expect(backend.options.args).not.toContain('--print-logs');
  });
});
