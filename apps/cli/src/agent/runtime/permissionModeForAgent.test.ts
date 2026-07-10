import { describe, expect, it } from 'vitest';

import { normalizePermissionModeForAgent } from '@happier-dev/agents';

describe('normalizePermissionModeForAgent', () => {
  it('keeps Claude permission state provider-agnostic until provider adaptation', () => {
    expect(normalizePermissionModeForAgent({ agentId: 'claude', mode: 'safe-yolo' })).toBe('safe-yolo');
    expect(normalizePermissionModeForAgent({ agentId: 'claude', mode: 'yolo' })).toBe('yolo');
  });

  it('normalizes legacy Claude-native permission labels into canonical intent', () => {
    expect(normalizePermissionModeForAgent({ agentId: 'claude', mode: 'acceptEdits' })).toBe('safe-yolo');
    expect(normalizePermissionModeForAgent({ agentId: 'claude', mode: 'bypassPermissions' })).toBe('yolo');
  });

  it('maps bypassPermissions to opencode yolo', () => {
    expect(normalizePermissionModeForAgent({ agentId: 'opencode', mode: 'bypassPermissions' })).toBe('yolo');
  });

  it('fails plan closed to read-only intent for every agent', () => {
    expect(normalizePermissionModeForAgent({ agentId: 'claude', mode: 'plan' })).toBe('read-only');
    expect(normalizePermissionModeForAgent({ agentId: 'opencode', mode: 'plan' })).toBe('read-only');
  });
});
