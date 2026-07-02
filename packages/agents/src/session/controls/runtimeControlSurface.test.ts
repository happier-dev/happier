import { describe, expect, it } from 'vitest';

import { resolveAgentRuntimeControlSurfaceForSession } from './runtimeControlSurface.js';

describe('runtimeControlSurface', () => {
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

  it('derives the Codex app-server runtime surface from legacy MCP account settings', () => {
    expect(resolveAgentRuntimeControlSurfaceForSession({
      agentId: 'codex',
      metadata: {},
      accountSettings: { codexBackendMode: 'mcp' },
    })).toMatchObject({
      sessionCapabilities: {
        sessionFork: { conversation: 'supported' },
        sessionRollback: { conversation: 'supported' },
      },
      localControl: { supported: true, topology: 'exclusive', attachStrategy: 'terminal_host' },
    });
  });

  it('returns the base Claude session surface even without a provider session-control adapter', () => {
    expect(resolveAgentRuntimeControlSurfaceForSession({
      agentId: 'claude',
      metadata: {},
      accountSettings: null,
    })).toMatchObject({
      sessionStorage: { direct: true, persisted: true },
      handoff: { vendorStateTransfer: 'supported' },
      localControl: { supported: true, topology: 'exclusive', attachStrategy: 'terminal_host' },
    });
  });
});
