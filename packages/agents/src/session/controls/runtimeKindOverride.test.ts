import { describe, expect, it } from 'vitest';

import {
  applyAgentRuntimeKindOverrideToAccountSettings,
  normalizeAgentRuntimeKindOverride,
  resolveAgentConfiguredRuntimeKind,
} from './runtimeKindOverride.js';

describe('runtimeKindOverride', () => {
  it('resolves the configured runtime kind for runtime-kind capable agents', () => {
    expect(resolveAgentConfiguredRuntimeKind({ agentId: 'codex', accountSettings: null })).toBe('appServer');
    expect(resolveAgentConfiguredRuntimeKind({
      agentId: 'codex',
      // Legacy toggle should not override the default backend mode now that `codexBackendMode`
      // exists and defaults to appServer.
      accountSettings: { experimentalCodexAcp: true },
    })).toBe('appServer');
    expect(resolveAgentConfiguredRuntimeKind({ agentId: 'codex', accountSettings: { codexBackendMode: 'mcp' } })).toBe('appServer');
    expect(resolveAgentConfiguredRuntimeKind({ agentId: 'opencode', accountSettings: { opencodeBackendMode: 'acp' } })).toBe('acp');
    expect(resolveAgentConfiguredRuntimeKind({ agentId: 'claude', accountSettings: { anything: 'x' } })).toBeNull();
  });

  it('normalizes agent runtime-kind overrides for supported agents only', () => {
    expect(normalizeAgentRuntimeKindOverride({ agentId: 'codex', value: 'appServer' })).toBe('appServer');
    expect(normalizeAgentRuntimeKindOverride({ agentId: 'codex', value: 'acp' })).toBe('acp');
    expect(normalizeAgentRuntimeKindOverride({ agentId: 'codex', value: '  mcp_resume  ' })).toBe('acp');
    expect(normalizeAgentRuntimeKindOverride({ agentId: 'opencode', value: 'server' })).toBe('server');
    expect(normalizeAgentRuntimeKindOverride({ agentId: 'opencode', value: 'acp' })).toBe('acp');

    expect(normalizeAgentRuntimeKindOverride({ agentId: 'opencode', value: 'appServer' })).toBeNull();
    expect(normalizeAgentRuntimeKindOverride({ agentId: 'codex', value: 'server' })).toBeNull();
    expect(normalizeAgentRuntimeKindOverride({ agentId: 'claude', value: 'acp' })).toBeNull();
    expect(normalizeAgentRuntimeKindOverride({ agentId: 'codex', value: null })).toBeNull();
  });

  it('applies normalized runtime-kind overrides to account settings for supported agents', () => {
    expect(applyAgentRuntimeKindOverrideToAccountSettings({
      agentId: 'codex',
      accountSettings: { codexBackendMode: 'mcp', other: 'x' },
      runtimeKindOverride: 'appServer',
    })).toEqual({ codexBackendMode: 'appServer', other: 'x' });

    expect(applyAgentRuntimeKindOverrideToAccountSettings({
      agentId: 'opencode',
      accountSettings: { opencodeBackendMode: 'acp', other: 'y' },
      runtimeKindOverride: 'server',
    })).toEqual({ opencodeBackendMode: 'server', other: 'y' });
  });

  it('ignores invalid runtime-kind overrides when applying to account settings', () => {
    expect(applyAgentRuntimeKindOverrideToAccountSettings({
      agentId: 'codex',
      accountSettings: { codexBackendMode: 'appServer' },
      runtimeKindOverride: 'server',
    })).toEqual({ codexBackendMode: 'appServer' });
  });
});
