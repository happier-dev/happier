import { describe, expect, it } from 'vitest';

import {
  detectOpenCodeCliAuthStatus,
  extractOpenCodeCliAuthAccountLabel,
  resolveOpenCodeCliAuthProbeTimeoutMs,
} from './auth.js';

describe('OpenCode CLI auth helpers', () => {
  it('extracts account labels from auth list output', () => {
    expect(extractOpenCodeCliAuthAccountLabel('OpenAI alice@example.com oauth')).toBe('alice@example.com');
    expect(extractOpenCodeCliAuthAccountLabel('logged in as bob@example.test')).toBe('bob@example.test');
    expect(extractOpenCodeCliAuthAccountLabel('no account')).toBeNull();
  });

  it('fails closed when command auth succeeds but refresh-token probing is invalid', async () => {
    await expect(detectOpenCodeCliAuthStatus({
      runAuthList: async () => ({ ok: true, stdout: 'OpenAI alice@example.com oauth' }),
      readOauthRefreshToken: async () => 'refresh-token',
      probeOauthRefreshToken: async () => 'invalid',
    })).resolves.toEqual({
      state: 'logged_out',
      reason: 'probe_failed',
      source: 'mixed',
      method: 'oauth_cli',
      accountLabel: 'alice@example.com',
    });
  });

  it('keeps command auth logged in when token probing is unavailable', async () => {
    await expect(detectOpenCodeCliAuthStatus({
      runAuthList: async () => ({ ok: true, stdout: 'OpenAI alice@example.com oauth' }),
      readOauthRefreshToken: async () => 'refresh-token',
      probeOauthRefreshToken: async () => 'unknown',
    })).resolves.toMatchObject({
      state: 'logged_in',
      method: 'oauth_cli',
      source: 'command',
      accountLabel: 'alice@example.com',
    });
  });

  it('reports missing credentials when auth list output is empty', async () => {
    await expect(detectOpenCodeCliAuthStatus({
      runAuthList: async () => ({ ok: true, stdout: '   ' }),
      readOauthRefreshToken: async () => null,
      probeOauthRefreshToken: async () => 'unknown',
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
      readOauthRefreshToken: async () => null,
      probeOauthRefreshToken: async () => 'unknown',
    })).resolves.toEqual({
      state: 'logged_out',
      reason: 'missing_credentials',
      source: 'command',
      method: 'oauth_cli',
      accountLabel: null,
    });
  });

  it('normalizes probe timeout from env with a safe lower bound', () => {
    expect(resolveOpenCodeCliAuthProbeTimeoutMs({
      HAPPIER_OPENCODE_CLI_AUTH_PROBE_TIMEOUT_MS: '50',
    })).toBe(250);
    expect(resolveOpenCodeCliAuthProbeTimeoutMs({
      HAPPIER_OPENCODE_CLI_AUTH_PROBE_TIMEOUT_MS: '2500',
    })).toBe(2500);
  });
});
