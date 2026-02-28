import { describe, expect, it } from 'vitest';

import { resolveConnectedServiceOauthMode } from './resolveConnectedServiceOauthMode';

describe('resolveConnectedServiceOauthMode', () => {
  it('defaults to device auth for openai-codex on web', () => {
    expect(resolveConnectedServiceOauthMode({
      platformOS: 'web',
      serviceId: 'openai-codex',
      method: '',
      oauthAddActionModes: ['device', 'paste'],
    })).toBe('device');
  });

  it('uses paste mode for openai-codex on web when explicitly requested', () => {
    expect(resolveConnectedServiceOauthMode({
      platformOS: 'web',
      serviceId: 'openai-codex',
      method: 'paste',
      oauthAddActionModes: ['device', 'paste'],
    })).toBe('paste');
  });

  it('defaults to paste mode for claude-subscription on native', () => {
    expect(resolveConnectedServiceOauthMode({
      platformOS: 'ios',
      serviceId: 'claude-subscription',
      method: '',
      oauthAddActionModes: ['paste'],
    })).toBe('paste');
  });

  it('allows embedded mode for claude-subscription when explicitly requested on native', () => {
    expect(resolveConnectedServiceOauthMode({
      platformOS: 'ios',
      serviceId: 'claude-subscription',
      method: 'browser',
      oauthAddActionModes: ['paste'],
    })).toBe('embedded');
  });

  it('defaults to device auth for openai-codex on native', () => {
    expect(resolveConnectedServiceOauthMode({
      platformOS: 'ios',
      serviceId: 'openai-codex',
      method: '',
      oauthAddActionModes: ['device', 'paste'],
    })).toBe('device');
  });

  it('uses embedded mode for openai-codex when explicitly requested on native', () => {
    expect(resolveConnectedServiceOauthMode({
      platformOS: 'ios',
      serviceId: 'openai-codex',
      method: 'browser',
      oauthAddActionModes: ['device', 'paste'],
    })).toBe('embedded');
  });

  it('clamps explicit device mode to paste when the service does not expose device auth', () => {
    expect(resolveConnectedServiceOauthMode({
      platformOS: 'ios',
      serviceId: 'gemini',
      method: 'device',
      oauthAddActionModes: ['paste'],
    })).toBe('paste');
  });
});
