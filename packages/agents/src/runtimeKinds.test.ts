import { describe, expect, it } from 'vitest';

import {
  getAgentRuntimeKindsManifest,
  resolveAgentRuntimeControlSurface,
  resolveDefaultAgentRuntimeKind,
} from './runtimeKinds.js';

describe('runtimeKinds', () => {
  it('exposes Codex and OpenCode runtime kind manifests from the shared catalog', () => {
    expect(getAgentRuntimeKindsManifest('codex')).toMatchObject({ defaultKind: 'appServer' });
    expect(getAgentRuntimeKindsManifest('opencode')).toMatchObject({ defaultKind: 'server' });
    expect(resolveDefaultAgentRuntimeKind('codex')).toBe('appServer');
    expect(resolveDefaultAgentRuntimeKind('opencode')).toBe('server');
    expect(resolveDefaultAgentRuntimeKind('claude')).toBeNull();
  });

  it('resolves effective Codex runtime capabilities by deep-merging the base agent entry and runtime-kind overrides', () => {
    expect(resolveAgentRuntimeControlSurface('codex', 'appServer')).toMatchObject({
      resume: { vendorResume: 'experimental' },
      sessionCapabilities: {
        sessionFork: { conversation: 'supported', fromMessage: 'unsupported' },
        sessionRollback: { conversation: 'supported' },
      },
      handoff: { vendorStateTransfer: 'experimental', requiresExplicitSessionId: true },
      localControl: { supported: true },
    });

    expect(resolveAgentRuntimeControlSurface('codex', 'mcp')).toMatchObject({
      resume: { vendorResume: 'unsupported' },
      sessionCapabilities: {
        sessionFork: { conversation: 'unsupported', fromMessage: 'unsupported' },
        sessionRollback: { conversation: 'unsupported' },
      },
      handoff: { vendorStateTransfer: 'unsupported', requiresExplicitSessionId: true },
      localControl: null,
    });
  });

  it('resolves effective OpenCode runtime capabilities from the same shared shapes', () => {
    expect(resolveAgentRuntimeControlSurface('opencode', 'server')).toMatchObject({
      sessionStorage: { direct: true, persisted: true },
      sessionCapabilities: { sessionFork: { conversation: 'supported', fromMessage: 'supported' } },
      localControl: { supported: true },
    });

    expect(resolveAgentRuntimeControlSurface('opencode', 'acp')).toMatchObject({
      sessionStorage: { direct: false, persisted: true },
      sessionCapabilities: { sessionFork: { conversation: 'supported', fromMessage: 'unsupported' } },
      localControl: null,
    });
  });
});
