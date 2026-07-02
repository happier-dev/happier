import { describe, expect, it } from 'vitest';

import {
  buildOpenCodePermissionEnv,
  buildOpenCodeSessionPermissionRuleset,
  resolveOpenCodePermissionConfig,
} from './policy.js';

describe('OpenCode permission policy', () => {
  it('keeps read-only intent fail-closed while preserving safe aliases', () => {
    const config = resolveOpenCodePermissionConfig('read-only');

    expect(config['*']).toBe('deny');
    expect(config.read).toBe('allow');
    expect(config.edit).toBe('deny');
    expect(config.write).toBe('deny');
    expect(config.change_title).toBe('allow');
    expect(config.session_title_set).toBe('allow');
    expect(config.happier_action_execute).toBe('allow');
  });

  it('promotes safe-yolo intent to allow edit aliases in the emitted session ruleset', () => {
    const ruleset = buildOpenCodeSessionPermissionRuleset('safe-yolo');
    const byPermission = new Map(ruleset.map((entry) => [entry.permission, entry.action] as const));

    expect(byPermission.get('*')).toBe('ask');
    expect(byPermission.get('read')).toBe('allow');
    expect(byPermission.get('edit')).toBe('allow');
    expect(byPermission.get('write')).toBe('allow');
    expect(byPermission.get('mcp__happier__action_execute')).toBe('allow');
  });

  it('serializes OpenCode permission env from the canonical policy', () => {
    expect(JSON.parse(buildOpenCodePermissionEnv('plan').OPENCODE_PERMISSION)).toMatchObject({
      '*': 'deny',
      read: 'allow',
      write: 'deny',
    });
  });
});
