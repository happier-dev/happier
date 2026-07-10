import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  sanitizeRetainedClaudeMaterializedHome,
  stripClaudeRefreshTokenFields,
} from './retainedHomeHygiene.js';

describe('stripClaudeRefreshTokenFields', () => {
  it('removes camel, snake, and short refresh-token fields from the claudeAiOauth envelope', () => {
    expect(stripClaudeRefreshTokenFields({
      claudeAiOauth: {
        accessToken: 'access-placeholder',
        refreshToken: 'camel-refresh',
        refresh_token: 'snake-refresh',
        RT: 'short-refresh',
        expiresAt: 123,
        scopes: ['user:inference'],
      },
    })).toEqual({
      claudeAiOauth: {
        accessToken: 'access-placeholder',
        expiresAt: 123,
        scopes: ['user:inference'],
      },
    });
  });

  it('returns null when there is no refresh-token field to strip', () => {
    expect(stripClaudeRefreshTokenFields({ claudeAiOauth: { accessToken: 'a' } })).toBeNull();
    expect(stripClaudeRefreshTokenFields({ other: true })).toBeNull();
    expect(stripClaudeRefreshTokenFields(null)).toBeNull();
  });
});

describe('sanitizeRetainedClaudeMaterializedHome', () => {
  let homeRoot: string;

  beforeEach(async () => {
    homeRoot = await mkdtemp(join(tmpdir(), 'claude-retained-home-'));
  });

  afterEach(async () => {
    await rm(homeRoot, { recursive: true, force: true });
  });

  it('strips refresh tokens from the retained credential file in place', async () => {
    const credentialPath = join(homeRoot, 'claude', '.credentials.json');
    await mkdir(join(homeRoot, 'claude'), { recursive: true });
    await writeFile(credentialPath, `${JSON.stringify({
      claudeAiOauth: {
        accessToken: 'access-placeholder',
        refreshToken: 'camel-refresh',
        refresh_token: 'snake-refresh',
        RT: 'short-refresh',
        expiresAt: 123,
        scopes: ['user:inference'],
      },
    })}\n`);

    await sanitizeRetainedClaudeMaterializedHome(homeRoot);

    expect(JSON.parse(await readFile(credentialPath, 'utf8'))).toEqual({
      claudeAiOauth: {
        accessToken: 'access-placeholder',
        expiresAt: 123,
        scopes: ['user:inference'],
      },
    });
  });

  it('is a no-op when the credential file is absent', async () => {
    await expect(sanitizeRetainedClaudeMaterializedHome(homeRoot)).resolves.toBeUndefined();
  });
});
