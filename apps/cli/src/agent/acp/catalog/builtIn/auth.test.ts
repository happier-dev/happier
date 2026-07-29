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
    'GOOGLE_GENAI_USE_VERTEXAI',
    'GOOGLE_CLOUD_PROJECT',
    'GOOGLE_CLOUD_LOCATION',
    'COPILOT_GITHUB_TOKEN',
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'HAPPIER_COPILOT_CLI_AUTH_PROBE_TIMEOUT_MS',
    'PATH',
  ]);

  afterEach(async () => {
    envScope.restore();
    envScope = createEnvKeyScope([
      'OPENAI_API_KEY',
      'OPENAI_CODEX_OAUTH_TOKEN',
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_OAUTH_TOKEN',
      'GEMINI_API_KEY',
      'GOOGLE_GENAI_USE_VERTEXAI',
      'GOOGLE_CLOUD_PROJECT',
      'GOOGLE_CLOUD_LOCATION',
      'COPILOT_GITHUB_TOKEN',
      'GH_TOKEN',
      'GITHUB_TOKEN',
      'HAPPIER_COPILOT_CLI_AUTH_PROBE_TIMEOUT_MS',
      'PATH',
    ]);
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
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

  it('builds env-only auth probing for Gemini API-key and Vertex env only', async () => {
    envScope.patch({
      GEMINI_API_KEY: undefined,
      GOOGLE_GENAI_USE_VERTEXAI: '1',
      GOOGLE_CLOUD_PROJECT: 'happier-vertex-project',
      GOOGLE_CLOUD_LOCATION: 'us-central1',
    });

    const spec = createBuiltInCliAuthSpec('gemini');
    const detectAuthStatus = spec.detectAuthStatus;
    expect(detectAuthStatus).toBeTypeOf('function');
    if (!detectAuthStatus) throw new Error('expected detectAuthStatus');

    await expect(detectAuthStatus({ resolvedPath: '/usr/local/bin/gemini' })).resolves.toMatchObject({
      state: 'logged_in',
      method: 'api_key_env',
      source: 'env',
    });
  });

  it('detects Copilot auth from GitHub token env vars before probing gh', async () => {
    envScope.patch({
      COPILOT_GITHUB_TOKEN: undefined,
      GH_TOKEN: 'gh-token',
      GITHUB_TOKEN: undefined,
    });

    const spec = createBuiltInCliAuthSpec('copilot');
    const detectAuthStatus = spec.detectAuthStatus;
    expect(detectAuthStatus).toBeTypeOf('function');
    if (!detectAuthStatus) throw new Error('expected detectAuthStatus');

    await expect(detectAuthStatus({ resolvedPath: '/usr/local/bin/copilot' })).resolves.toMatchObject({
      state: 'logged_in',
      method: 'api_key_env',
      source: 'env',
    });
  });

  it('detects Copilot auth from the host-owned gh auth token probe', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-copilot-gh-auth-'));
    tempDirs.push(dir);

    const scriptPath = join(dir, process.platform === 'win32' ? 'gh.cmd' : 'gh');
    await writeFile(
      scriptPath,
      process.platform === 'win32'
        ? '@echo off\necho gh-oauth-token\n'
        : '#!/bin/sh\nprintf gh-oauth-token\n',
      'utf8',
    );
    await chmod(scriptPath, 0o755);
    envScope.patch({
      COPILOT_GITHUB_TOKEN: undefined,
      GH_TOKEN: undefined,
      GITHUB_TOKEN: undefined,
      HAPPIER_COPILOT_CLI_AUTH_PROBE_TIMEOUT_MS: '2_000',
      PATH: `${dir}:${process.env.PATH ?? ''}`,
    });

    const spec = createBuiltInCliAuthSpec('copilot');
    const detectAuthStatus = spec.detectAuthStatus;
    expect(detectAuthStatus).toBeTypeOf('function');
    if (!detectAuthStatus) throw new Error('expected detectAuthStatus');

    await expect(detectAuthStatus({ resolvedPath: '/usr/local/bin/copilot' })).resolves.toMatchObject({
      state: 'logged_in',
      method: 'oauth_cli',
      source: 'command',
    });
  });
});
