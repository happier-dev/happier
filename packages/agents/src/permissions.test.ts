import { describe, expect, it } from 'vitest';

import { getAgentSessionModeDescriptor } from './sessionModes.js';
import {
  normalizePermissionModeForGroup,
  parsePermissionIntentAlias,
  resolvePermissionModeGroupForAgent,
  resolveProviderNativePermissionModeForAgent,
} from './permissions/index.js';

describe('permissions', () => {
  it('derives permission mode groups from shared session-mode descriptor metadata', async () => {
    const permissions = await import('./permissions/index.js');
    const helper = (permissions as Record<string, unknown>).resolvePermissionModeGroupForSessionModeDescriptor;

    expect(typeof helper).toBe('function');

    const resolvePermissionModeGroupForSessionModeDescriptor = helper as (
      descriptor: ReturnType<typeof getAgentSessionModeDescriptor>,
    ) => string;

    expect(resolvePermissionModeGroupForSessionModeDescriptor(getAgentSessionModeDescriptor('claude'))).toBe('claude');
    expect(resolvePermissionModeGroupForSessionModeDescriptor(getAgentSessionModeDescriptor('codex'))).toBe('codexLike');
    expect(resolvePermissionModeGroupForAgent('claude')).toBe(
      resolvePermissionModeGroupForSessionModeDescriptor(getAgentSessionModeDescriptor('claude')),
    );
    expect(resolvePermissionModeGroupForAgent('codex')).toBe(
      resolvePermissionModeGroupForSessionModeDescriptor(getAgentSessionModeDescriptor('codex')),
    );
  });

  it('maps canonical permission modes to Claude provider-native labels', () => {
    expect(resolveProviderNativePermissionModeForAgent({ agentId: 'claude', mode: 'yolo' })).toBe('bypassPermissions');
    expect(resolveProviderNativePermissionModeForAgent({ agentId: 'claude', mode: 'safe-yolo' })).toBe('auto');
    expect(resolveProviderNativePermissionModeForAgent({ agentId: 'claude', mode: 'read-only' })).toBe('dontAsk');
    expect(resolveProviderNativePermissionModeForAgent({ agentId: 'claude', mode: 'acceptEdits' })).toBe('auto');
    expect(resolveProviderNativePermissionModeForAgent({ agentId: 'claude', mode: 'bypassPermissions' })).toBe('bypassPermissions');
    expect(resolveProviderNativePermissionModeForAgent({ agentId: 'codex', mode: 'safe-yolo' })).toBe('safe-yolo');
  });

  it('normalizes provider-agnostic permission intent before provider-native adaptation', () => {
    expect(normalizePermissionModeForGroup('plan', 'codexLike')).toBe('read-only');
    expect(normalizePermissionModeForGroup('plan', 'claude')).toBe('read-only');

    expect(normalizePermissionModeForGroup('read-only', 'claude')).toBe('read-only');
    expect(normalizePermissionModeForGroup('safe-yolo', 'claude')).toBe('safe-yolo');
    expect(normalizePermissionModeForGroup('yolo', 'claude')).toBe('yolo');

    expect(normalizePermissionModeForGroup('acceptEdits', 'claude')).toBe('safe-yolo');
    expect(normalizePermissionModeForGroup('bypassPermissions', 'claude')).toBe('yolo');
  });

  it.each([
    { raw: 'read_only', intent: 'read-only' },
    { raw: 'no_tools', intent: 'read-only' },
    { raw: 'workspace_write', intent: 'safe-yolo' },
  ])('parses public action permission alias $raw', ({ raw, intent }) => {
    expect(parsePermissionIntentAlias(raw)).toBe(intent);
  });
});
