import { describe, expect, it } from 'vitest';

import { buildAuggiePermissionArgs } from './permissionArgs.js';

describe('Auggie permission args', () => {
  it('normalizes workspace-write aliases through the shared ACP permission intent parser', () => {
    const args = buildAuggiePermissionArgs('workspace_write');

    expect(args).toContain('save-file:allow');
    expect(args).toContain('apply_patch:allow');
    expect(args).toContain('web-search:ask-user');
  });
});
