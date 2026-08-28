import { describe, expect, it } from 'vitest';

import { resolveAgentRuntimeControlSurfaceForSession } from './runtimeControlSurface.js';

describe('runtimeControlSurface', () => {
  it('resolves the effective OpenCode runtime surface from legacy backend metadata', () => {
    expect(resolveAgentRuntimeControlSurfaceForSession({
      agentId: 'opencode',
      metadata: { opencodeBackendMode: 'acp' },
    })).toMatchObject({
      sessionStorage: { direct: false, persisted: true },
      sessionCapabilities: {
        sessionFork: { conversation: 'supported', fromMessage: 'unsupported' },
      },
      localControl: null,
    });
  });

  it('uses the declared OpenCode default when no persisted runtime identity exists', () => {
    expect(resolveAgentRuntimeControlSurfaceForSession({
      agentId: 'opencode',
      metadata: {},
    })).toMatchObject({
      sessionStorage: { direct: true, persisted: true },
      sessionCapabilities: {
        sessionFork: { conversation: 'supported', fromMessage: 'supported' },
      },
      localControl: { supported: true, topology: 'shared', attachStrategy: 'provider_attach' },
    });
  });

  it('uses the declared Codex default rather than parsing UI Account settings', () => {
    expect(resolveAgentRuntimeControlSurfaceForSession({
      agentId: 'codex',
      metadata: {},
    })).toMatchObject({
      sessionCapabilities: {
        sessionFork: { conversation: 'supported' },
        sessionRollback: { conversation: 'supported' },
      },
      localControl: { supported: true, topology: 'exclusive', attachStrategy: 'terminal_host' },
    });
  });

  it('fails closed rather than interpreting an Agent-owned current runtime descriptor', () => {
    expect(resolveAgentRuntimeControlSurfaceForSession({
      agentId: 'codex',
      metadata: {
        runtimeDescriptorV1: {
          v: 1,
          agentId: 'codex',
          agent: { backendMode: 'acp' },
        },
      },
    })).toBeNull();
  });

  it('returns the base Claude session surface even without a provider session-control adapter', () => {
    expect(resolveAgentRuntimeControlSurfaceForSession({
      agentId: 'claude',
      metadata: {},
    })).toMatchObject({
      sessionStorage: { direct: true, persisted: true },
      handoff: { vendorStateTransfer: 'supported' },
      localControl: { supported: true, topology: 'exclusive', attachStrategy: 'terminal_host' },
    });
  });
});
