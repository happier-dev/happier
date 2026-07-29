import { describe, expect, it } from 'vitest';

import { normalizePermissionModeForGroup } from '@happier-dev/agents';

describe('normalizePermissionModeForGroup', () => {
  it('normalizes legacy provider-native labels into provider-agnostic intents', () => {
    expect(normalizePermissionModeForGroup('acceptEdits', 'claude')).toBe('safe-yolo');
    expect(normalizePermissionModeForGroup('bypassPermissions', 'claude')).toBe('yolo');
    expect(normalizePermissionModeForGroup('acceptEdits', 'codexLike')).toBe('safe-yolo');
    expect(normalizePermissionModeForGroup('bypassPermissions', 'codexLike')).toBe('yolo');
  });

  it('fails the agent-behavior plan mode closed to read-only intent', () => {
    expect(normalizePermissionModeForGroup('plan', 'claude')).toBe('read-only');
    expect(normalizePermissionModeForGroup('plan', 'codexLike')).toBe('read-only');
  });

  it('passes through canonical provider-agnostic intents for every provider group', () => {
    expect(normalizePermissionModeForGroup('default', 'claude')).toBe('default');
    expect(normalizePermissionModeForGroup('read-only', 'claude')).toBe('read-only');
    expect(normalizePermissionModeForGroup('safe-yolo', 'claude')).toBe('safe-yolo');
    expect(normalizePermissionModeForGroup('yolo', 'claude')).toBe('yolo');
    expect(normalizePermissionModeForGroup('default', 'codexLike')).toBe('default');
    expect(normalizePermissionModeForGroup('read-only', 'codexLike')).toBe('read-only');
    expect(normalizePermissionModeForGroup('safe-yolo', 'codexLike')).toBe('safe-yolo');
    expect(normalizePermissionModeForGroup('yolo', 'codexLike')).toBe('yolo');
  });
});
