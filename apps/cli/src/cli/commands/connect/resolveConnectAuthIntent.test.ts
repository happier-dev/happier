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

  it('resolves Gemini OAuth from descriptor aliases without accepting token flags', () => {
    const res = resolveConnectAuthIntent({
      targetId: 'gemini',
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
    expect(res).toEqual({ kind: 'oauth', serviceId: 'gemini' });

    expect(() => resolveConnectAuthIntent({
      targetId: 'gemini',
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
    })).toThrow(/not supported/i);
  });

  it('rejects unknown descriptor-backed connect targets', () => {
    expect(() => resolveConnectAuthIntent({
      targetId: 'unknown-target',
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
    })).toThrow(/Unsupported connect target: unknown-target/);
  });

  it('defaults GitHub to PAT token input', () => {
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
        token: false,
      },
    });

    expect(res).toEqual({ kind: 'token', serviceId: 'github', tokenKind: 'personal-access-token' });
  });

  it('accepts explicit GitHub token flag', () => {
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

    expect(res).toEqual({ kind: 'token', serviceId: 'github', tokenKind: 'personal-access-token' });
  });

  it('defaults Bitbucket to API token input', () => {
    const res = resolveConnectAuthIntent({
      targetId: 'bitbucket',
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

    expect(res).toEqual({ kind: 'token', serviceId: 'bitbucket', tokenKind: 'api-token' });
  });

  it('accepts explicit Bitbucket token flag', () => {
    const res = resolveConnectAuthIntent({
      targetId: 'bitbucket',
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

    expect(res).toEqual({ kind: 'token', serviceId: 'bitbucket', tokenKind: 'api-token' });
  });
});
