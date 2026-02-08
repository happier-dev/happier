import { describe, expect, it } from 'vitest';

import { normalizePermissionModeForGroup } from '@happier-dev/agents';

describe('normalizePermissionModeForGroup', () => {
  it('maps codex-like modes into claude modes', () => {
    expect(normalizePermissionModeForGroup('safe-yolo', 'claude')).toBe('acceptEdits');
    expect(normalizePermissionModeForGroup('yolo', 'claude')).toBe('bypassPermissions');
    expect(normalizePermissionModeForGroup('read-only', 'claude')).toBe('default');
  });

  it('maps claude modes into codex-like modes', () => {
    expect(normalizePermissionModeForGroup('acceptEdits', 'codexLike')).toBe('safe-yolo');
    expect(normalizePermissionModeForGroup('bypassPermissions', 'codexLike')).toBe('yolo');
    expect(normalizePermissionModeForGroup('plan', 'codexLike')).toBe('plan');
  });

  it('passes through already-supported modes', () => {
    expect(normalizePermissionModeForGroup('default', 'claude')).toBe('default');
    expect(normalizePermissionModeForGroup('acceptEdits', 'claude')).toBe('acceptEdits');
    expect(normalizePermissionModeForGroup('safe-yolo', 'codexLike')).toBe('safe-yolo');
    expect(normalizePermissionModeForGroup('read-only', 'codexLike')).toBe('read-only');
  });

  it('keeps unsupported mode/group pairs unchanged', () => {
    expect(normalizePermissionModeForGroup('plan', 'claude')).toBe('plan');
    expect(normalizePermissionModeForGroup('plan', 'codexLike')).toBe('plan');
    expect(normalizePermissionModeForGroup('default', 'codexLike')).toBe('default');
    expect(normalizePermissionModeForGroup('bypassPermissions', 'claude')).toBe('bypassPermissions');
  });
});
