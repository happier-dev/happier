import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import { copilotCliAuthSpec } from './copilotCliAuthSpec';

describe('copilotCliAuthSpec', () => {
  const originalPath = process.env.PATH;
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const originalGhToken = process.env.GH_TOKEN;
  const originalGithubToken = process.env.GITHUB_TOKEN;
  const originalCopilotGithubToken = process.env.COPILOT_GITHUB_TOKEN;
  const tempDirs: string[] = [];

  afterEach(async () => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    if (originalGhToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = originalGhToken;
    if (originalGithubToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = originalGithubToken;
    if (originalCopilotGithubToken === undefined) delete process.env.COPILOT_GITHUB_TOKEN;
    else process.env.COPILOT_GITHUB_TOKEN = originalCopilotGithubToken;

    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
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
    const dir = await mkdtemp(join(tmpdir(), 'happier-copilot-auth-spec-'));
    tempDirs.push(dir);

    const ghPath = join(dir, process.platform === 'win32' ? 'gh.cmd' : 'gh');
    await writeFile(
      ghPath,
      process.platform === 'win32'
        ? '@echo off\r\nif "%1"=="auth" if "%2"=="token" (\r\necho gh-token\r\nexit /b 0\r\n)\r\nexit /b 1\r\n'
        : '#!/bin/sh\nif [ "$1" = "auth" ] && [ "$2" = "token" ]; then\n  echo gh-token\n  exit 0\nfi\nexit 1\n',
      'utf8',
    );
    await chmod(ghPath, 0o755);

    process.env.PATH = dir;
    process.env.HOME = dir;
    process.env.USERPROFILE = dir;
    delete process.env.COPILOT_GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;

    const detectAuthStatus = copilotCliAuthSpec.detectAuthStatus;
    expect(detectAuthStatus).toBeTypeOf('function');
    if (!detectAuthStatus) throw new Error('copilotCliAuthSpec.detectAuthStatus must be defined for this test');

    await expect(detectAuthStatus({ resolvedPath: '/usr/local/bin/copilot' })).resolves.toMatchObject({
      state: 'logged_in',
      method: 'oauth_cli',
      source: 'command',
    });
  });

  it('reports logged out when gh is installed but not authenticated', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-copilot-auth-spec-logged-out-'));
    tempDirs.push(dir);

    const ghPath = join(dir, process.platform === 'win32' ? 'gh.cmd' : 'gh');
    await writeFile(
      ghPath,
      process.platform === 'win32'
        ? '@echo off\r\nif "%1"=="auth" if "%2"=="token" (\r\necho not logged in 1>&2\r\nexit /b 1\r\n)\r\nexit /b 1\r\n'
        : '#!/bin/sh\nif [ "$1" = "auth" ] && [ "$2" = "token" ]; then\n  echo not logged in 1>&2\n  exit 1\nfi\nexit 1\n',
      'utf8',
    );
    await chmod(ghPath, 0o755);

    process.env.PATH = dir;
    process.env.HOME = dir;
    process.env.USERPROFILE = dir;
    delete process.env.COPILOT_GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;

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
