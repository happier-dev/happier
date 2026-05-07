import { describe, expect, it } from 'vitest';

import { getConnectedServiceRegistryEntry } from './connectedServiceRegistry';

describe('connectedServiceRegistry', () => {
  it('exposes an explicit in-app browser oauth method for openai-codex (native)', () => {
    const entry = getConnectedServiceRegistryEntry('openai-codex');
    expect(entry.supportsOauth).toBe(true);
    expect(entry.oauthAddActionModes ?? []).toContain('device');
    expect(entry.oauthAddActionModes ?? []).toContain('paste');
    expect(entry.oauthAddActionModes ?? []).toContain('browser');
  });

  it('exposes an explicit in-app browser oauth method for claude-subscription (native)', () => {
    const entry = getConnectedServiceRegistryEntry('claude-subscription');
    expect(entry.supportsOauth).toBe(true);
    expect(entry.oauthAddActionModes ?? []).toContain('paste');
    expect(entry.oauthAddActionModes ?? []).toContain('browser');
  });

  it('exposes an explicit in-app browser oauth method for gemini (native)', () => {
    const entry = getConnectedServiceRegistryEntry('gemini');
    expect(entry.supportsOauth).toBe(true);
    expect(entry.oauthAddActionModes ?? []).toContain('paste');
    expect(entry.oauthAddActionModes ?? []).toContain('browser');
  });

  it('registers GitHub as a token-based connected service with an explicit GitHub connect command', () => {
    const entry = getConnectedServiceRegistryEntry('github');
    expect(entry).toMatchObject({
      serviceId: 'github',
      connectCommand: 'happier connect github --token',
      supportsOauth: false,
      supportsToken: true,
      tokenKind: 'access-token',
    });
    expect(typeof entry.tokenSetupUrl).toBe('string');
    const tokenSetupUrl = new URL(entry.tokenSetupUrl ?? '');
    expect(tokenSetupUrl.origin).toBe('https://github.com');
    expect(tokenSetupUrl.pathname).toBe('/settings/personal-access-tokens/new');
    expect(tokenSetupUrl.searchParams.get('contents')).toBe('write');
    expect(tokenSetupUrl.searchParams.get('pull_requests')).toBe('write');
    expect(tokenSetupUrl.searchParams.get('administration')).toBe('write');
  });
});
