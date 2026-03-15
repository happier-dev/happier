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
});
