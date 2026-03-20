import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import { codexCliAuthSpec } from './codexCliAuthSpec';

describe('codexCliAuthSpec', () => {
  const originalPath = process.env.PATH;
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const originalPnpmBin = process.env.HAPPIER_PNPM_BIN;
  const originalCodexAuthProbeTimeout = process.env.HAPPIER_CODEX_CLI_AUTH_PROBE_TIMEOUT_MS;
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
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    if (originalPnpmBin === undefined) delete process.env.HAPPIER_PNPM_BIN;
    else process.env.HAPPIER_PNPM_BIN = originalPnpmBin;
    if (originalCodexAuthProbeTimeout === undefined) delete process.env.HAPPIER_CODEX_CLI_AUTH_PROBE_TIMEOUT_MS;
    else process.env.HAPPIER_CODEX_CLI_AUTH_PROBE_TIMEOUT_MS = originalCodexAuthProbeTimeout;

    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('reports logged out for JS-backed codex overrides without credentials', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-codex-auth-spec-'));
    tempDirs.push(dir);

    const scriptPath = join(dir, 'fake-codex.js');
    await writeFile(
      scriptPath,
      [
        '#!/usr/bin/env node',
        'const args = process.argv.slice(2);',
        'if (args[0] === "login" && args[1] === "status") process.exit(1);',
        'if (args[0] === "--version" || args[0] === "version" || args[0] === "-v") {',
        '  console.log("codex 0.0.0-fake");',
        '  process.exit(0);',
        '}',
        'process.exit(1);',
      ].join('\n'),
      'utf8',
    );
    await chmod(scriptPath, 0o755);

    process.env.PATH = '';
    process.env.HOME = dir;
    process.env.USERPROFILE = dir;
    delete process.env.OPENAI_API_KEY;
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

    const detectAuthStatus = codexCliAuthSpec.detectAuthStatus;
    expect(detectAuthStatus).toBeTypeOf('function');
    if (!detectAuthStatus) {
      throw new Error('codexCliAuthSpec.detectAuthStatus must be defined for this test');
    }

    await expect(detectAuthStatus({ resolvedPath: scriptPath })).resolves.toMatchObject({
      state: 'logged_out',
      reason: 'missing_credentials',
    });
  });

  it('preserves accountLabel when login status succeeds and auth file contains tokens', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-codex-auth-spec-'));
    tempDirs.push(dir);

    const scriptPath = join(dir, 'fake-codex.js');
    await writeFile(
      scriptPath,
      [
        '#!/usr/bin/env node',
        'const args = process.argv.slice(2);',
        'if (args[0] === "login" && args[1] === "status") process.exit(0);',
        'if (args[0] === "--version" || args[0] === "version" || args[0] === "-v") {',
        '  console.log("codex 0.0.0-fake");',
        '  process.exit(0);',
        '}',
        'process.exit(1);',
      ].join('\n'),
      'utf8',
    );
    await chmod(scriptPath, 0o755);

    process.env.PATH = '';
    process.env.HOME = dir;
    process.env.USERPROFILE = dir;

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

    const authDir = join(dir, '.codex');
    await mkdir(authDir, { recursive: true });
    await writeFile(
      join(authDir, 'auth.json'),
      JSON.stringify({
        tokens: {
          id_token: [
            Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
            Buffer.from(JSON.stringify({ email: 'fake-codex@example.test' })).toString('base64url'),
            'signature',
          ].join('.'),
        },
      }),
      'utf8',
    );

    const detectAuthStatus = codexCliAuthSpec.detectAuthStatus;
    expect(detectAuthStatus).toBeTypeOf('function');
    if (!detectAuthStatus) throw new Error('codexCliAuthSpec.detectAuthStatus must be defined for this test');

    await expect(detectAuthStatus({ resolvedPath: scriptPath })).resolves.toMatchObject({
      state: 'logged_in',
      method: 'oauth_cli',
      source: 'command',
      accountLabel: 'fake-codex@example.test',
    });
  });

  it('waits long enough for slower successful login status checks', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-codex-auth-spec-'));
    tempDirs.push(dir);

    const scriptPath = join(dir, 'fake-codex.js');
    await writeFile(
      scriptPath,
      [
        '#!/usr/bin/env node',
        'const args = process.argv.slice(2);',
        'if (args[0] === "login" && args[1] === "status") {',
        '  setTimeout(() => process.exit(0), 1_600);',
        '  return;',
        '}',
        'if (args[0] === "--version" || args[0] === "version" || args[0] === "-v") {',
        '  console.log("codex 0.0.0-fake");',
        '  process.exit(0);',
        '}',
        'process.exit(1);',
      ].join('\n'),
      'utf8',
    );
    await chmod(scriptPath, 0o755);

    process.env.PATH = '';
    process.env.HOME = dir;
    process.env.USERPROFILE = dir;
    process.env.HAPPIER_CODEX_CLI_AUTH_PROBE_TIMEOUT_MS = '3_000';

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

    const detectAuthStatus = codexCliAuthSpec.detectAuthStatus;
    expect(detectAuthStatus).toBeTypeOf('function');
    if (!detectAuthStatus) throw new Error('codexCliAuthSpec.detectAuthStatus must be defined for this test');

    await expect(detectAuthStatus({ resolvedPath: scriptPath })).resolves.toMatchObject({
      state: 'logged_in',
      method: 'oauth_cli',
      source: 'command',
    });
  });

  it('does not treat stale auth.json tokens as logged in when codex login status exits non-zero', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-codex-auth-spec-'));
    tempDirs.push(dir);

    const scriptPath = join(dir, 'fake-codex.js');
    await writeFile(
      scriptPath,
      [
        '#!/usr/bin/env node',
        'const args = process.argv.slice(2);',
        'if (args[0] === "login" && args[1] === "status") process.exit(1);',
        'if (args[0] === "--version" || args[0] === "version" || args[0] === "-v") {',
        '  console.log("codex 0.0.0-fake");',
        '  process.exit(0);',
        '}',
        'process.exit(1);',
      ].join('\n'),
      'utf8',
    );
    await chmod(scriptPath, 0o755);

    process.env.PATH = '';
    process.env.HOME = dir;
    process.env.USERPROFILE = dir;
    delete process.env.OPENAI_API_KEY;

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

    const authDir = join(dir, '.codex');
    await mkdir(authDir, { recursive: true });
    await writeFile(
      join(authDir, 'auth.json'),
      JSON.stringify({
        tokens: {
          id_token: [
            Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
            Buffer.from(JSON.stringify({ email: 'stale-codex@example.test' })).toString('base64url'),
            'signature',
          ].join('.'),
        },
      }),
      'utf8',
    );

    const detectAuthStatus = codexCliAuthSpec.detectAuthStatus;
    expect(detectAuthStatus).toBeTypeOf('function');
    if (!detectAuthStatus) throw new Error('codexCliAuthSpec.detectAuthStatus must be defined for this test');

    await expect(detectAuthStatus({ resolvedPath: scriptPath })).resolves.toMatchObject({
      state: 'logged_out',
      reason: 'missing_credentials',
    });
  });

  it('prefers OPENAI_API_KEY env auth over stale auth.json tokens when login status exits non-zero', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-codex-auth-spec-'));
    tempDirs.push(dir);

    const scriptPath = join(dir, 'fake-codex.js');
    await writeFile(
      scriptPath,
      [
        '#!/usr/bin/env node',
        'const args = process.argv.slice(2);',
        'if (args[0] === "login" && args[1] === "status") process.exit(1);',
        'if (args[0] === "--version" || args[0] === "version" || args[0] === "-v") {',
        '  console.log("codex 0.0.0-fake");',
        '  process.exit(0);',
        '}',
        'process.exit(1);',
      ].join('\n'),
      'utf8',
    );
    await chmod(scriptPath, 0o755);

    process.env.PATH = '';
    process.env.HOME = dir;
    process.env.USERPROFILE = dir;
    process.env.OPENAI_API_KEY = 'sk-test-codex';

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

    const authDir = join(dir, '.codex');
    await mkdir(authDir, { recursive: true });
    await writeFile(
      join(authDir, 'auth.json'),
      JSON.stringify({
        tokens: {
          id_token: [
            Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
            Buffer.from(JSON.stringify({ email: 'stale-codex@example.test' })).toString('base64url'),
            'signature',
          ].join('.'),
        },
      }),
      'utf8',
    );

    const detectAuthStatus = codexCliAuthSpec.detectAuthStatus;
    expect(detectAuthStatus).toBeTypeOf('function');
    if (!detectAuthStatus) throw new Error('codexCliAuthSpec.detectAuthStatus must be defined for this test');

    await expect(detectAuthStatus({ resolvedPath: scriptPath })).resolves.toMatchObject({
      state: 'logged_in',
      method: 'api_key_env',
      source: 'env',
    });
  });
});
