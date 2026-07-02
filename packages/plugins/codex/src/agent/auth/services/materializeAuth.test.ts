import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildCodexMaterializedAuthPlan } from './materializeAuth.js';

describe('buildCodexMaterializedAuthPlan', () => {
  it('treats rootDir as the materialized Codex home for auth file paths and environment', () => {
    const rootDir = join('/tmp', 'happier-openai-codex-root', 'codex-home');

    const plan = buildCodexMaterializedAuthPlan({
      rootDir,
      accessToken: 'access',
      refreshToken: 'refresh',
      idToken: 'id',
      accountId: 'chatgpt-account',
      lastRefreshIso: '2026-06-06T00:00:00.000Z',
    });

    expect(plan.codexHome).toBe(rootDir);
    expect(plan.authFilePath).toBe(join(rootDir, 'auth.json'));
    expect(plan.env).toEqual({ CODEX_HOME: rootDir });
    expect(plan.authFile).toMatchObject({
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      access_token: 'access',
      refresh_token: 'refresh',
      id_token: 'id',
      account_id: 'chatgpt-account',
      last_refresh: '2026-06-06T00:00:00.000Z',
    });
  });
});
