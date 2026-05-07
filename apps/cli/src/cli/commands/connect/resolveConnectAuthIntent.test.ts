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
        token: false,
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
        token: false,
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
        token: false,
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
        token: false,
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
        token: false,
      },
    })).toThrow(/device/i);
  });

  it('allows OpenAI API key for Codex via --api-key (stored as openai)', () => {
    const res = resolveConnectAuthIntent({
      targetId: 'codex',
      options: {
        profileId: 'default',
        paste: false,
        device: false,
        noOpen: false,
        timeoutSeconds: null,
        setupToken: false,
        oauth: false,
        apiKey: true,
        token: false,
      },
    });
    expect(res).toEqual({ kind: 'token', serviceId: 'openai', tokenKind: 'api-key' });
  });

  it('uses a token credential for GitHub', () => {
    const res = resolveConnectAuthIntent({
      targetId: 'github',
      options: {
        profileId: 'default',
        paste: false,
        device: false,
        noOpen: false,
        timeoutSeconds: null,
        setupToken: false,
        oauth: false,
        apiKey: false,
        token: true,
      },
    });
    expect(res).toEqual({ kind: 'token', serviceId: 'github', tokenKind: 'access-token' });
  });

  it('rejects --token for unsupported non-GitHub targets', () => {
    for (const targetId of ['claude', 'codex', 'gemini']) {
      expect(() => resolveConnectAuthIntent({
        targetId,
        options: {
          profileId: 'default',
          paste: false,
          device: false,
          noOpen: false,
          timeoutSeconds: null,
          setupToken: false,
          oauth: false,
          apiKey: false,
          token: true,
        },
      })).toThrow(/--token/i);
    }
  });
});
