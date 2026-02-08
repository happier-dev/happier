import { describe, expect, it } from 'vitest';

import { normalizePermissionModeForAgent } from '@happier-dev/agents';

describe('normalizePermissionModeForAgent', () => {
  it('maps safe-yolo to Claude acceptEdits', () => {
    expect(normalizePermissionModeForAgent({ agentId: 'claude', mode: 'safe-yolo' })).toBe('acceptEdits');
  });

  it('maps yolo to Claude bypassPermissions', () => {
    expect(normalizePermissionModeForAgent({ agentId: 'claude', mode: 'yolo' })).toBe('bypassPermissions');
  });

  it('maps bypassPermissions to opencode yolo', () => {
    expect(normalizePermissionModeForAgent({ agentId: 'opencode', mode: 'bypassPermissions' })).toBe('yolo');
  });
});
