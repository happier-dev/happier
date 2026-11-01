import { describe, expect, it } from 'vitest';

import {
  getAgentRuntimeKindsManifest,
  resolveAgentRuntimeControlSurface,
  resolveDefaultAgentRuntimeKind,
} from './runtimeKinds.js';

describe('runtimeKinds', () => {
  it('replaces compaction descriptors atomically for the selected runtime kind', () => {
    expect(resolveAgentRuntimeControlSurface('claude', 'agentSdk')?.sessionCapabilities.compaction).toEqual({
      events: true, manual: true, idle: { mode: 'host', defaultEnabled: true, defaultMinContextTokens: 200000 },
    });
    expect(resolveAgentRuntimeControlSurface('claude', 'unifiedTerminal')?.sessionCapabilities.compaction).toEqual({
      events: true, idle: { mode: 'native', defaultEnabled: true, defaultMinContextTokens: 200000, nativeHonorsMinimum: true },
    });
    expect(resolveAgentRuntimeControlSurface('codex', 'mcp')?.sessionCapabilities.compaction).toBeNull();
    expect(resolveAgentRuntimeControlSurface('codex', 'acp')?.sessionCapabilities.compaction).toBeNull();
    expect(resolveAgentRuntimeControlSurface('opencode', 'acp')?.sessionCapabilities.compaction).toBeNull();
  });
  it('exposes Codex and OpenCode runtime kind manifests from the shared catalog', () => {
    expect(getAgentRuntimeKindsManifest('codex')).toMatchObject({ defaultKind: 'appServer' });
    expect(getAgentRuntimeKindsManifest('opencode')).toMatchObject({ defaultKind: 'server' });
    expect(resolveDefaultAgentRuntimeKind('codex')).toBe('appServer');
    expect(resolveDefaultAgentRuntimeKind('opencode')).toBe('server');
    expect(resolveDefaultAgentRuntimeKind('claude')).toBe('agentSdk');
  });

  it('resolves effective Codex runtime capabilities by deep-merging the base agent entry and runtime-kind overrides', () => {
    expect(resolveAgentRuntimeControlSurface('codex', 'appServer')).toMatchObject({
      resume: { vendorResume: 'experimental' },
      sessionCapabilities: {
        sessionFork: { conversation: 'supported', fromMessage: 'unsupported' },
        sessionRollback: { conversation: 'supported' },
        usageLimitRecovery: { checkNow: 'supported' },
        usageReporting: 'supported',
      },
      handoff: { vendorStateTransfer: 'experimental', requiresExplicitSessionId: true },
      localControl: { supported: true },
    });

    expect(resolveAgentRuntimeControlSurface('codex', 'mcp')).toMatchObject({
      resume: { vendorResume: 'unsupported' },
      sessionCapabilities: {
        sessionFork: { conversation: 'unsupported', fromMessage: 'unsupported' },
        sessionRollback: { conversation: 'unsupported' },
        usageLimitRecovery: { checkNow: 'unsupported' },
        usageReporting: 'unsupported',
      },
      handoff: { vendorStateTransfer: 'unsupported', requiresExplicitSessionId: true },
      localControl: null,
    });
  });

  it('resolves effective OpenCode runtime capabilities from the same shared shapes', () => {
    expect(resolveAgentRuntimeControlSurface('opencode', 'server')).toMatchObject({
      sessionStorage: { direct: true, persisted: true },
      sessionCapabilities: {
        sessionFork: { conversation: 'unsupported', fromMessage: 'unsupported' },
        usageLimitRecovery: { checkNow: 'unsupported' },
      },
      localControl: { supported: true },
    });

    expect(resolveAgentRuntimeControlSurface('opencode', 'acp')).toMatchObject({
      sessionStorage: { direct: false, persisted: true },
      sessionCapabilities: {
        sessionFork: { conversation: 'unsupported', fromMessage: 'unsupported' },
        usageLimitRecovery: { checkNow: 'unsupported' },
      },
      localControl: null,
    });
  });

  it('exposes provider-declared runtime input capabilities through the shared runtime surface', () => {
    expect(resolveAgentRuntimeControlSurface('pi', null)).toMatchObject({
      runtimeInput: {
        inFlightSteerSupported: true,
      },
    });
  });

  it('does not promise usage reporting for unverified Codex runtime modes or generic ACP Agents', () => {
    expect(resolveAgentRuntimeControlSurface('codex', 'mcp')?.sessionCapabilities.usageReporting).toBe('unsupported');
    expect(resolveAgentRuntimeControlSurface('codex', 'acp')?.sessionCapabilities.usageReporting).toBe('unsupported');
    expect(resolveAgentRuntimeControlSurface('gemini', null)?.sessionCapabilities.usageReporting).toBeUndefined();
  });
});
