import { afterEach, describe, expect, it } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { writeExecutableShim } from '@/testkit/fs/executableShim';

import { copilotCliAuthSpec } from './copilotCliAuthSpec';

describe('copilotCliAuthSpec', () => {
  const envKeys = ['PATH', 'HOME', 'USERPROFILE', 'GH_TOKEN', 'GITHUB_TOKEN', 'COPILOT_GITHUB_TOKEN'] as const;
  let envScope = createEnvKeyScope(envKeys);

  afterEach(() => {
    envScope.restore();
    envScope = createEnvKeyScope(envKeys);
  });

  it('uses the canonical Copilot binary name for auth detection', () => {
    expect(copilotCliAuthSpec.binaryNames).toEqual(['copilot']);
  });

  it('reports logged in when a supported Copilot environment token is configured', async () => {
    process.env.COPILOT_GITHUB_TOKEN = 'copilot-token';
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;

    const detectAuthStatus = copilotCliAuthSpec.detectAuthStatus;
    expect(detectAuthStatus).toBeTypeOf('function');
    if (!detectAuthStatus) throw new Error('copilotCliAuthSpec.detectAuthStatus must be defined for this test');

    await expect(detectAuthStatus({ resolvedPath: '/usr/local/bin/copilot' })).resolves.toMatchObject({
      state: 'logged_in',
      method: 'api_key_env',
      source: 'env',
    });
  });

  it('reports logged in when gh auth token succeeds', async () => {
    await withTempDir('happier-copilot-auth-spec-', async (dir) => {
      const ghPath = await writeExecutableShim({
        dir,
        fileName: process.platform === 'win32' ? 'gh.cmd' : 'gh',
        contents: process.platform === 'win32'
          ? '@echo off\r\nif "%1"=="auth" if "%2"=="token" (\r\necho gh-token\r\nexit /b 0\r\n)\r\nexit /b 1\r\n'
          : '#!/bin/sh\nif [ "$1" = "auth" ] && [ "$2" = "token" ]; then\n  echo gh-token\n  exit 0\nfi\nexit 1\n',
      });

      envScope.patch({
        PATH: dir,
        HOME: dir,
        USERPROFILE: dir,
        COPILOT_GITHUB_TOKEN: undefined,
        GH_TOKEN: undefined,
        GITHUB_TOKEN: undefined,
      });

      expect(ghPath).toContain(dir);

      const detectAuthStatus = copilotCliAuthSpec.detectAuthStatus;
      expect(detectAuthStatus).toBeTypeOf('function');
      if (!detectAuthStatus) throw new Error('copilotCliAuthSpec.detectAuthStatus must be defined for this test');

      await expect(detectAuthStatus({ resolvedPath: '/usr/local/bin/copilot' })).resolves.toMatchObject({
        state: 'logged_in',
        method: 'oauth_cli',
        source: 'command',
      });
    });
  });

  it('reports logged out when gh is installed but not authenticated', async () => {
    await withTempDir('happier-copilot-auth-spec-logged-out-', async (dir) => {
      const ghPath = await writeExecutableShim({
        dir,
        fileName: process.platform === 'win32' ? 'gh.cmd' : 'gh',
        contents: process.platform === 'win32'
          ? '@echo off\r\nif "%1"=="auth" if "%2"=="token" (\r\necho not logged in 1>&2\r\nexit /b 1\r\n)\r\nexit /b 1\r\n'
          : '#!/bin/sh\nif [ "$1" = "auth" ] && [ "$2" = "token" ]; then\n  echo not logged in 1>&2\n  exit 1\nfi\nexit 1\n',
      });

      envScope.patch({
        PATH: dir,
        HOME: dir,
        USERPROFILE: dir,
        COPILOT_GITHUB_TOKEN: undefined,
        GH_TOKEN: undefined,
        GITHUB_TOKEN: undefined,
      });

      expect(ghPath).toContain(dir);

      const detectAuthStatus = copilotCliAuthSpec.detectAuthStatus;
      expect(detectAuthStatus).toBeTypeOf('function');
      if (!detectAuthStatus) throw new Error('copilotCliAuthSpec.detectAuthStatus must be defined for this test');

      await expect(detectAuthStatus({ resolvedPath: '/usr/local/bin/copilot' })).resolves.toMatchObject({
        state: 'logged_out',
        reason: 'missing_credentials',
        source: 'command',
      });
    });
  });
});
