import { describe, expect, it } from 'vitest';

import {
  detectOpenCodeCliAuthStatus,
  extractOpenCodeCliAuthAccountLabel,
} from './auth.js';

describe('OpenCode CLI auth helpers', () => {
  it('extracts account labels from auth list output', () => {
    expect(extractOpenCodeCliAuthAccountLabel('OpenAI alice@example.com oauth')).toBe('alice@example.com');
    expect(extractOpenCodeCliAuthAccountLabel('logged in as bob@example.test')).toBe('bob@example.test');
    expect(extractOpenCodeCliAuthAccountLabel('no account')).toBeNull();
  });

  it('interprets a successful bounded auth-list command without raw credential fallback', async () => {
    await expect(detectOpenCodeCliAuthStatus({
      runAuthList: async () => ({ ok: true, stdout: 'OpenAI alice@example.com oauth' }),
    })).resolves.toEqual({
      state: 'logged_in',
      method: 'oauth_cli',
      source: 'command',
      accountLabel: 'alice@example.com',
    });
  });

  it('reports missing credentials when auth list output is empty', async () => {
    await expect(detectOpenCodeCliAuthStatus({
      runAuthList: async () => ({ ok: true, stdout: '   ' }),
    })).resolves.toEqual({
      state: 'logged_out',
      reason: 'missing_credentials',
      source: 'command',
      method: 'oauth_cli',
      accountLabel: null,
    });
  });

  it('reports missing credentials when auth list command fails', async () => {
    await expect(detectOpenCodeCliAuthStatus({
      runAuthList: async () => ({ ok: false, stdout: '' }),
    })).resolves.toEqual({
      state: 'logged_out',
      reason: 'missing_credentials',
      source: 'command',
      method: 'oauth_cli',
      accountLabel: null,
    });
  });

});
