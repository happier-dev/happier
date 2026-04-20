import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';

import { claudeCliAuthSpec } from './claudeCliAuthSpec';

const envKeys = [
  'HOME',
  'USERPROFILE',
  'CLAUDE_CONFIG_DIR',
  'HAPPIER_CLAUDE_CONFIG_DIR',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
] as const;

describe('claudeCliAuthSpec', () => {
  const tempDirs: string[] = [];
  let envScope = createEnvKeyScope(envKeys);

  afterEach(async () => {
    envScope.restore();
    envScope = createEnvKeyScope(envKeys);
    await Promise.all(tempDirs.splice(0).map((dir) => removeTempDir(dir).catch(() => undefined)));
  });

  it('reads credentials from CLAUDE_CONFIG_DIR when an explicit override is set', async () => {
    const dir = await createTempDir('happier-claude-auth-spec-');
    tempDirs.push(dir);

    const overriddenConfigDir = join(dir, 'custom-claude-config');
    await mkdir(overriddenConfigDir, { recursive: true });
    await writeFile(
      join(overriddenConfigDir, '.credentials.json'),
      JSON.stringify({
        accessToken: 'claude-token',
        email: 'claude-override@example.test',
      }),
      'utf8',
    );

    envScope.patch({
      HOME: dir,
      USERPROFILE: dir,
      CLAUDE_CONFIG_DIR: overriddenConfigDir,
      HAPPIER_CLAUDE_CONFIG_DIR: undefined,
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_AUTH_TOKEN: undefined,
    });

    const detectAuthStatus = claudeCliAuthSpec.detectAuthStatus;
    expect(detectAuthStatus).toBeTypeOf('function');
    if (!detectAuthStatus) {
      throw new Error('claudeCliAuthSpec.detectAuthStatus must be defined for this test');
    }

    await expect(detectAuthStatus({ resolvedPath: '/tmp/fake-claude' })).resolves.toMatchObject({
      state: 'logged_in',
      method: 'credentials_file',
      source: 'file',
      accountLabel: 'claude-override@example.test',
    });
  });

  it('reads credentials from the current .claude.json layout', async () => {
    const dir = await createTempDir('happier-claude-auth-spec-');
    tempDirs.push(dir);

    const claudeConfigDir = join(dir, '.claude');
    await mkdir(claudeConfigDir, { recursive: true });
    await writeFile(
      join(claudeConfigDir, '.claude.json'),
      JSON.stringify({
        accessToken: 'claude-token',
        email: 'claude-json@example.test',
      }),
      'utf8',
    );

    envScope.patch({
      HOME: dir,
      USERPROFILE: dir,
      CLAUDE_CONFIG_DIR: claudeConfigDir,
      HAPPIER_CLAUDE_CONFIG_DIR: undefined,
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_AUTH_TOKEN: undefined,
    });

    const detectAuthStatus = claudeCliAuthSpec.detectAuthStatus;
    expect(detectAuthStatus).toBeTypeOf('function');
    if (!detectAuthStatus) {
      throw new Error('claudeCliAuthSpec.detectAuthStatus must be defined for this test');
    }

    await expect(detectAuthStatus({ resolvedPath: '/tmp/fake-claude' })).resolves.toMatchObject({
      state: 'logged_in',
      method: 'credentials_file',
      source: 'file',
      accountLabel: 'claude-json@example.test',
    });
  });

  it('prefers a valid current credentials file over an expired legacy credentials file', async () => {
    const dir = await createTempDir('happier-claude-auth-spec-');
    tempDirs.push(dir);

    const claudeConfigDir = join(dir, '.claude');
    await mkdir(claudeConfigDir, { recursive: true });
    await writeFile(
      join(claudeConfigDir, '.credentials.json'),
      JSON.stringify({
        accessToken: 'expired-legacy-token',
        email: 'claude-legacy@example.test',
        expiresAt: '2000-01-01T00:00:00.000Z',
      }),
      'utf8',
    );
    await writeFile(
      join(claudeConfigDir, '.claude.json'),
      JSON.stringify({
        accessToken: 'valid-current-token',
        email: 'claude-current@example.test',
      }),
      'utf8',
    );

    envScope.patch({
      HOME: dir,
      USERPROFILE: dir,
      CLAUDE_CONFIG_DIR: claudeConfigDir,
      HAPPIER_CLAUDE_CONFIG_DIR: undefined,
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_AUTH_TOKEN: undefined,
    });

    const detectAuthStatus = claudeCliAuthSpec.detectAuthStatus;
    expect(detectAuthStatus).toBeTypeOf('function');
    if (!detectAuthStatus) {
      throw new Error('claudeCliAuthSpec.detectAuthStatus must be defined for this test');
    }

    await expect(detectAuthStatus({ resolvedPath: '/tmp/fake-claude' })).resolves.toMatchObject({
      state: 'logged_in',
      method: 'credentials_file',
      source: 'file',
      accountLabel: 'claude-current@example.test',
    });
  });
});
