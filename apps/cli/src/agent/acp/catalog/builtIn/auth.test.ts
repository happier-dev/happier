import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import { createBuiltInCliAuthSpec } from './auth';
import { createEnvKeyScope } from '../../../../testkit/env/envScope';

describe('createBuiltInCliAuthSpec', () => {
  const tempDirs: string[] = [];
  let envScope = createEnvKeyScope([
    'OPENAI_API_KEY',
    'OPENAI_CODEX_OAUTH_TOKEN',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_OAUTH_TOKEN',
    'GEMINI_API_KEY',
  ]);

  afterEach(async () => {
    envScope.restore();
    envScope = createEnvKeyScope([
      'OPENAI_API_KEY',
      'OPENAI_CODEX_OAUTH_TOKEN',
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_OAUTH_TOKEN',
      'GEMINI_API_KEY',
    ]);
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('detects logged-in Kiro auth status from whoami json', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-kiro-auth-'));
    tempDirs.push(dir);

    const scriptPath = join(dir, 'kiro-cli.js');
    await writeFile(
      scriptPath,
      '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ email: "agent@example.com" }));\n',
      'utf8',
    );
    await chmod(scriptPath, 0o755);

    const spec = createBuiltInCliAuthSpec('kiro');
    const detectAuthStatus = spec.detectAuthStatus;
    expect(detectAuthStatus).toBeTypeOf('function');
    if (!detectAuthStatus) throw new Error('expected detectAuthStatus');

    await expect(detectAuthStatus({ resolvedPath: scriptPath })).resolves.toMatchObject({
      state: 'logged_in',
      method: 'oauth_cli',
      source: 'command',
      accountLabel: 'agent@example.com',
    });
  });

  it('marks Kiro as logged out when whoami exits non-zero', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-kiro-auth-fail-'));
    tempDirs.push(dir);

    const scriptPath = join(dir, 'kiro-cli.js');
    await writeFile(
      scriptPath,
      '#!/usr/bin/env node\nprocess.exit(1);\n',
      'utf8',
    );
    await chmod(scriptPath, 0o755);

    const spec = createBuiltInCliAuthSpec('kiro');
    const detectAuthStatus = spec.detectAuthStatus;
    expect(detectAuthStatus).toBeTypeOf('function');
    if (!detectAuthStatus) throw new Error('expected detectAuthStatus');

    await expect(detectAuthStatus({ resolvedPath: scriptPath })).resolves.toMatchObject({
      state: 'logged_out',
      reason: 'missing_credentials',
      source: 'command',
    });
  });

  it('builds env-only auth probing for ohMyPi', async () => {
    envScope.patch({
      OPENAI_API_KEY: undefined,
      OPENAI_CODEX_OAUTH_TOKEN: 'omp-oauth-token',
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_OAUTH_TOKEN: undefined,
      GEMINI_API_KEY: undefined,
    });

    const spec = createBuiltInCliAuthSpec('ohMyPi');
    const detectAuthStatus = spec.detectAuthStatus;
    expect(detectAuthStatus).toBeTypeOf('function');
    if (!detectAuthStatus) throw new Error('expected detectAuthStatus');

    await expect(detectAuthStatus({ resolvedPath: '/usr/local/bin/omp' })).resolves.toMatchObject({
      state: 'logged_in',
      method: 'api_key_env',
      source: 'env',
    });
  });
});
