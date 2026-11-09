import { describe, expect, it } from 'vitest';

import { getAgentSessionModeDescriptor, type AgentSessionModeDescriptor } from './sessionModes.js';
import { resolvePermissionPrivilegeOrdinal } from './permissions/privilege.js';
import {
  normalizePermissionModeForSessionDescriptor,
  parsePermissionIntentAlias,
  normalizePermissionModeForAgent,
  resolveProviderNativePermissionModeForAgent,
} from './permissions/index.js';

describe('permissions', () => {
  it('preserves planning behavior only for a resolved Agent-mode descriptor (01C)', () => {
    const dynamicDescriptor = { source: 'acp', semantics: 'agent-modes', runtimeSwitch: 'acp-setSessionMode' } as const satisfies AgentSessionModeDescriptor;
    expect(normalizePermissionModeForSessionDescriptor({ mode: 'plan', descriptor: dynamicDescriptor })).toBe('plan');
    expect(resolvePermissionPrivilegeOrdinal(normalizePermissionModeForSessionDescriptor({ mode: 'plan', descriptor: dynamicDescriptor }))).toBe(0);
    expect(normalizePermissionModeForAgent({ agentId: 'claude', mode: 'plan' })).toBe('plan');
    expect(normalizePermissionModeForSessionDescriptor({ mode: 'plan', descriptor: getAgentSessionModeDescriptor('codex') })).toBe('read-only');
    expect(normalizePermissionModeForAgent({ agentId: 'acme.agent', mode: 'plan' })).toBe('read-only');
  });

  it('maps canonical permission modes to Claude provider-native labels', () => {
    expect(resolveProviderNativePermissionModeForAgent({ agentId: 'claude', mode: 'yolo' })).toBe('bypassPermissions');
    expect(resolveProviderNativePermissionModeForAgent({ agentId: 'claude', mode: 'safe-yolo' })).toBe('auto');
    expect(resolveProviderNativePermissionModeForAgent({ agentId: 'claude', mode: 'read-only' })).toBe('plan');
    expect(resolveProviderNativePermissionModeForAgent({ agentId: 'claude', mode: 'acceptEdits' })).toBe('acceptEdits');
    expect(resolveProviderNativePermissionModeForAgent({ agentId: 'claude', mode: 'bypassPermissions' })).toBe('bypassPermissions');
    expect(resolveProviderNativePermissionModeForAgent({ agentId: 'codex', mode: 'safe-yolo' })).toBe('safe-yolo');
  });

  it('normalizes provider-agnostic permission intent before provider-native adaptation', () => {
    const normalize = (mode: Parameters<typeof normalizePermissionModeForSessionDescriptor>[0]['mode']) =>
      normalizePermissionModeForSessionDescriptor({ mode, descriptor: getAgentSessionModeDescriptor('claude') });
    expect(normalize('read-only')).toBe('read-only');
    expect(normalize('safe-yolo')).toBe('safe-yolo');
    expect(normalize('yolo')).toBe('yolo');
    expect(normalize('acceptEdits')).toBe('safe-yolo');
    expect(normalize('bypassPermissions')).toBe('yolo');
  });

  it.each([
    { raw: 'read_only', intent: 'read-only' },
    { raw: 'no_tools', intent: 'read-only' },
    { raw: 'workspace_write', intent: 'safe-yolo' },
  ])('parses public action permission alias $raw', ({ raw, intent }) => {
    expect(parsePermissionIntentAlias(raw)).toBe(intent);
  });
});
