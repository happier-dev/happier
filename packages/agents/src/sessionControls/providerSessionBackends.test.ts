import { describe, expect, it } from 'vitest';

import { resolveAgentRuntimeControlSurfaceForSession, resolveCodexSessionBackendMode } from './providerSessionBackends.js';

describe('providerSessionBackends', () => {
  it('defaults the configured Codex backend mode to appServer when no override is present', () => {
    expect(resolveCodexSessionBackendMode({
      metadata: null,
      accountSettings: null,
    })).toBe('appServer');
  });

  it('resolves the effective OpenCode runtime surface from legacy backend metadata', () => {
    expect(resolveAgentRuntimeControlSurfaceForSession({
      agentId: 'opencode',
      metadata: { opencodeBackendMode: 'acp' },
      accountSettings: { opencodeBackendMode: 'server' },
    })).toMatchObject({
      sessionStorage: { direct: false, persisted: true },
      sessionCapabilities: {
        sessionFork: { conversation: 'supported', fromMessage: 'unsupported' },
      },
      localControl: null,
    });
  });

  it('uses the configured OpenCode runtime surface when no persisted runtime identity is present', () => {
    expect(resolveAgentRuntimeControlSurfaceForSession({
      agentId: 'opencode',
      metadata: {},
      accountSettings: { opencodeBackendMode: 'server' },
    })).toMatchObject({
      sessionStorage: { direct: true, persisted: true },
      sessionCapabilities: {
        sessionFork: { conversation: 'supported', fromMessage: 'supported' },
      },
      localControl: { supported: true, topology: 'shared', attachStrategy: 'provider_attach' },
    });
  });

  it('derives the OpenCode runtime surface from account settings when no persisted runtime identity exists', () => {
    expect(resolveAgentRuntimeControlSurfaceForSession({
      agentId: 'opencode',
      metadata: {},
      accountSettings: { opencodeBackendMode: 'acp' },
    })).toMatchObject({
      sessionStorage: { direct: false, persisted: true },
      sessionCapabilities: {
        sessionFork: { conversation: 'supported', fromMessage: 'unsupported' },
      },
      localControl: null,
    });
  });

  it('derives the Codex runtime surface from account settings when no persisted runtime identity exists', () => {
    expect(resolveAgentRuntimeControlSurfaceForSession({
      agentId: 'codex',
      metadata: {},
      accountSettings: { codexBackendMode: 'mcp' },
    })).toMatchObject({
      sessionCapabilities: {
        sessionFork: { conversation: 'unsupported' },
        sessionRollback: { conversation: 'unsupported' },
      },
      localControl: null,
    });
  });
});
