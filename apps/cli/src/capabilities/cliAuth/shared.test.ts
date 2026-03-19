import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import { runCliCommandBestEffort } from './shared';

describe('runCliCommandBestEffort', () => {
  const originalPath = process.env.PATH;
  const originalPnpmBin = process.env.HAPPIER_PNPM_BIN;
  const originalJsRuntimePath = process.env.HAPPIER_JS_RUNTIME_PATH;
  const originalManagedNodeBin = process.env.HAPPIER_MANAGED_NODE_BIN;
  const originalNodePath = process.env.HAPPIER_NODE_PATH;
  const tempDirs: string[] = [];

  function resolveSystemJavaScriptRuntimeBinary(): string {
    const output = process.platform === 'win32'
      ? execFileSync('cmd.exe', ['/d', '/s', '/c', 'where bun || where node'], {
          encoding: 'utf8',
          env: { ...process.env, PATH: originalPath ?? process.env.PATH ?? '' },
        })
      : execFileSync('/bin/sh', ['-lc', 'command -v bun || command -v node'], {
          encoding: 'utf8',
          env: { ...process.env, PATH: originalPath ?? process.env.PATH ?? '' },
        });
    const [first] = output
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean);
    if (!first) throw new Error('missing JavaScript runtime binary for test');
    return first;
  }

  afterEach(async () => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalPnpmBin === undefined) delete process.env.HAPPIER_PNPM_BIN;
    else process.env.HAPPIER_PNPM_BIN = originalPnpmBin;
    if (originalJsRuntimePath === undefined) delete process.env.HAPPIER_JS_RUNTIME_PATH;
    else process.env.HAPPIER_JS_RUNTIME_PATH = originalJsRuntimePath;
    if (originalManagedNodeBin === undefined) delete process.env.HAPPIER_MANAGED_NODE_BIN;
    else process.env.HAPPIER_MANAGED_NODE_BIN = originalManagedNodeBin;
    if (originalNodePath === undefined) delete process.env.HAPPIER_NODE_PATH;
    else process.env.HAPPIER_NODE_PATH = originalNodePath;

    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('executes JavaScript CLIs through the current runtime when PATH does not contain node', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-cli-auth-js-'));
    tempDirs.push(dir);

    const scriptPath = join(dir, 'fake-cli.js');
    await writeFile(
      scriptPath,
      '#!/usr/bin/env node\nprocess.stdout.write(process.argv.slice(2).join(\" \"));\n',
      'utf8',
    );
    await chmod(scriptPath, 0o755);

    process.env.PATH = '';
    const runtimeBinary = resolveSystemJavaScriptRuntimeBinary();
    const pnpmPath = join(dir, process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm');
    await writeFile(
      pnpmPath,
      process.platform === 'win32'
        ? `@echo off\r\nif "%1"=="node" (\r\n  shift\r\n  "${runtimeBinary}" %*\r\n  exit /b %errorlevel%\r\n)\r\nexit /b 1\r\n`
        : `#!/bin/sh\nif [ \"$1\" = \"node\" ]; then\n  shift\n  exec \"${runtimeBinary}\" \"$@\"\nfi\nexit 1\n`,
      'utf8',
    );
    await chmod(pnpmPath, 0o755);
    process.env.HAPPIER_PNPM_BIN = pnpmPath;

    const result = await runCliCommandBestEffort({
      resolvedPath: scriptPath,
      args: ['login', 'status'],
      timeoutMs: 2_000,
    });

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('login status');
  });

  it('preserves non-zero exit codes for JavaScript CLIs bootstrapped through the managed runtime', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-cli-auth-js-exit-'));
    tempDirs.push(dir);

    const scriptPath = join(dir, 'fake-cli.js');
    await writeFile(
      scriptPath,
      '#!/usr/bin/env node\nprocess.exit(1);\n',
      'utf8',
    );
    await chmod(scriptPath, 0o755);

    process.env.PATH = '';
    const runtimeBinary = resolveSystemJavaScriptRuntimeBinary();
    const pnpmPath = join(dir, process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm');
    await writeFile(
      pnpmPath,
      process.platform === 'win32'
        ? `@echo off\r\nif "%1"=="node" (\r\n  shift\r\n  "${runtimeBinary}" %*\r\n  exit /b %errorlevel%\r\n)\r\nexit /b 1\r\n`
        : `#!/bin/sh\nif [ \"$1\" = \"node\" ]; then\n  shift\n  exec \"${runtimeBinary}\" \"$@\"\nfi\nexit 1\n`,
      'utf8',
    );
    await chmod(pnpmPath, 0o755);
    process.env.HAPPIER_PNPM_BIN = pnpmPath;

    const result = await runCliCommandBestEffort({
      resolvedPath: scriptPath,
      args: ['login', 'status'],
      timeoutMs: 2_000,
    });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  it.skipIf(process.platform === 'win32')(
    'executes node-shebang CLIs without a file extension through the managed runtime when PATH does not contain node',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'happier-cli-auth-node-shebang-'));
      tempDirs.push(dir);

      const scriptPath = join(dir, 'fake-cli');
      await writeFile(
        scriptPath,
        '#!/usr/bin/env node\nprocess.stdout.write(process.argv.slice(2).join(\" \"));\n',
        'utf8',
      );
      await chmod(scriptPath, 0o755);

      process.env.PATH = '';
      const runtimeBinary = resolveSystemJavaScriptRuntimeBinary();
      const pnpmPath = join(dir, process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm');
      await writeFile(
        pnpmPath,
        process.platform === 'win32'
          ? `@echo off\r\nif \"%1\"==\"node\" (\r\n  shift\r\n  \"${runtimeBinary}\" %*\r\n  exit /b %errorlevel%\r\n)\r\nexit /b 1\r\n`
          : `#!/bin/sh\nif [ \"$1\" = \"node\" ]; then\n  shift\n  exec \"${runtimeBinary}\" \"$@\"\nfi\nexit 1\n`,
        'utf8',
      );
      await chmod(pnpmPath, 0o755);
      process.env.HAPPIER_PNPM_BIN = pnpmPath;
      delete process.env.HAPPIER_JS_RUNTIME_PATH;
      delete process.env.HAPPIER_MANAGED_NODE_BIN;
      delete process.env.HAPPIER_NODE_PATH;

      const result = await runCliCommandBestEffort({
        resolvedPath: scriptPath,
        args: ['auth', 'list'],
        timeoutMs: 2_000,
      });

      expect(result.ok).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('auth list');
    },
  );
});
