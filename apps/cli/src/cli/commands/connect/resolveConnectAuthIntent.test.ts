import { describe, expect, it } from 'vitest';

import { resolveConnectAuthIntent } from './resolveConnectAuthIntent';

describe('resolveConnectAuthIntent', () => {
  it('defaults Claude to setup-token', () => {
    const res = resolveConnectAuthIntent({
      targetId: 'claude',
      options: {
        profileId: 'default',
        paste: false,
        device: false,
        noOpen: false,
        timeoutSeconds: null,
        setupToken: false,
        oauth: false,
        apiKey: false,
      },
    });
    expect(res).toEqual({ kind: 'token', serviceId: 'claude-subscription', tokenKind: 'setup-token' });
  });

  it('allows Claude OAuth (stored as claude-subscription)', () => {
    const res = resolveConnectAuthIntent({
      targetId: 'claude',
      options: {
        profileId: 'default',
        paste: false,
        device: false,
        noOpen: false,
        timeoutSeconds: null,
        setupToken: false,
        oauth: true,
        apiKey: false,
      },
    });
    expect(res).toEqual({ kind: 'oauth', serviceId: 'claude-subscription' });
  });

  it('accepts explicit Claude setup-token flag', () => {
    const res = resolveConnectAuthIntent({
      targetId: 'claude',
      options: {
        profileId: 'default',
        paste: false,
        device: false,
        noOpen: false,
        timeoutSeconds: null,
        setupToken: true,
        oauth: false,
        apiKey: false,
      },
    });
    expect(res).toEqual({ kind: 'token', serviceId: 'claude-subscription', tokenKind: 'setup-token' });
  });

  it('allows Anthropic API key for Claude via --api-key (stored as anthropic)', () => {
    const res = resolveConnectAuthIntent({
      targetId: 'claude',
      options: {
        profileId: 'default',
        paste: false,
        device: false,
        noOpen: false,
        timeoutSeconds: null,
        setupToken: false,
        oauth: false,
        apiKey: true,
      },
    });
    expect(res).toEqual({ kind: 'token', serviceId: 'anthropic', tokenKind: 'api-key' });
  });

  it('rejects --device for Claude', () => {
    expect(() => resolveConnectAuthIntent({
      targetId: 'claude',
      options: {
        profileId: 'default',
        paste: false,
        device: true,
        noOpen: false,
        timeoutSeconds: null,
        setupToken: false,
        oauth: false,
        apiKey: false,
      },
    })).toThrow(/device/i);
  });
});
