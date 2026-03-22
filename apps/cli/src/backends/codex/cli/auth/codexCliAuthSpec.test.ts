import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { writePnpmNodeBridge } from '@/testkit/fs/executableShim';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';

import { codexCliAuthSpec } from './codexCliAuthSpec';

const envKeys = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'HAPPIER_PNPM_BIN',
  'HAPPIER_CODEX_CLI_AUTH_PROBE_TIMEOUT_MS',
  'OPENAI_API_KEY',
] as const;

describe('codexCliAuthSpec', () => {
  const tempDirs: string[] = [];
  const systemPath = process.env.PATH;
  let envScope = createEnvKeyScope(envKeys);

  afterEach(async () => {
    envScope.restore();
    envScope = createEnvKeyScope(envKeys);
    await Promise.all(tempDirs.splice(0).map((dir) => removeTempDir(dir).catch(() => undefined)));
  });

  it('reports logged out for JS-backed codex overrides without credentials', async () => {
    const dir = await createTempDir('happier-codex-auth-spec-');
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

    envScope.patch({
      PATH: '',
      HOME: dir,
      USERPROFILE: dir,
      OPENAI_API_KEY: undefined,
    });
    process.env.HAPPIER_PNPM_BIN = await writePnpmNodeBridge({ dir, pathLookup: systemPath });

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
    const dir = await createTempDir('happier-codex-auth-spec-');
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

    envScope.patch({
      PATH: '',
      HOME: dir,
      USERPROFILE: dir,
    });
    process.env.HAPPIER_PNPM_BIN = await writePnpmNodeBridge({ dir, pathLookup: systemPath });

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
    if (!detectAuthStatus) {
      throw new Error('codexCliAuthSpec.detectAuthStatus must be defined for this test');
    }

    await expect(detectAuthStatus({ resolvedPath: scriptPath })).resolves.toMatchObject({
      state: 'logged_in',
      method: 'oauth_cli',
      source: 'command',
      accountLabel: 'fake-codex@example.test',
    });
  });

  it('waits long enough for slower successful login status checks', async () => {
    const dir = await createTempDir('happier-codex-auth-spec-');
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

    envScope.patch({
      PATH: '',
      HOME: dir,
      USERPROFILE: dir,
      HAPPIER_CODEX_CLI_AUTH_PROBE_TIMEOUT_MS: '3_000',
    });
    process.env.HAPPIER_PNPM_BIN = await writePnpmNodeBridge({ dir, pathLookup: systemPath });

    const detectAuthStatus = codexCliAuthSpec.detectAuthStatus;
    expect(detectAuthStatus).toBeTypeOf('function');
    if (!detectAuthStatus) {
      throw new Error('codexCliAuthSpec.detectAuthStatus must be defined for this test');
    }

    await expect(detectAuthStatus({ resolvedPath: scriptPath })).resolves.toMatchObject({
      state: 'logged_in',
      method: 'oauth_cli',
      source: 'command',
    });
  });

  it('does not treat stale auth.json tokens as logged in when codex login status exits non-zero', async () => {
    const dir = await createTempDir('happier-codex-auth-spec-');
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

    envScope.patch({
      PATH: '',
      HOME: dir,
      USERPROFILE: dir,
      OPENAI_API_KEY: undefined,
    });
    process.env.HAPPIER_PNPM_BIN = await writePnpmNodeBridge({ dir, pathLookup: systemPath });

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
    if (!detectAuthStatus) {
      throw new Error('codexCliAuthSpec.detectAuthStatus must be defined for this test');
    }

    await expect(detectAuthStatus({ resolvedPath: scriptPath })).resolves.toMatchObject({
      state: 'logged_out',
      reason: 'missing_credentials',
    });
  });

  it('prefers OPENAI_API_KEY env auth over stale auth.json tokens when login status exits non-zero', async () => {
    const dir = await createTempDir('happier-codex-auth-spec-');
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

    envScope.patch({
      PATH: '',
      HOME: dir,
      USERPROFILE: dir,
      OPENAI_API_KEY: 'sk-test-codex',
    });
    process.env.HAPPIER_PNPM_BIN = await writePnpmNodeBridge({ dir, pathLookup: systemPath });

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
    if (!detectAuthStatus) {
      throw new Error('codexCliAuthSpec.detectAuthStatus must be defined for this test');
    }

    await expect(detectAuthStatus({ resolvedPath: scriptPath })).resolves.toMatchObject({
      state: 'logged_in',
      method: 'api_key_env',
      source: 'env',
    });
  });
});
