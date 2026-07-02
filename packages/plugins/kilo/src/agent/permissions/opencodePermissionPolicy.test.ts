import { describe, expect, it } from 'vitest';

import {
  buildKiloOpenCodePermissionEnv,
  resolveKiloOpenCodePermissionPolicy,
} from './opencodePermissionPolicy.js';

describe('Kilo OpenCode permission policy', () => {
  it.each([
    { mode: 'default', wildcard: 'ask', read: 'allow', edit: 'ask', bash: 'ask', external: 'ask' },
    { mode: 'read-only', wildcard: 'deny', read: 'allow', edit: 'deny', bash: 'deny', external: 'deny' },
    { mode: 'plan', wildcard: 'deny', read: 'allow', edit: 'deny', bash: 'deny', external: 'deny' },
    { mode: 'safe-yolo', wildcard: 'ask', read: 'allow', edit: 'allow', bash: 'ask', external: 'ask' },
    { mode: 'acceptEdits', wildcard: 'ask', read: 'allow', edit: 'allow', bash: 'ask', external: 'ask' },
    { mode: 'yolo', wildcard: 'allow', read: 'allow', edit: 'allow', bash: 'allow', external: 'allow' },
    { mode: 'bypassPermissions', wildcard: 'allow', read: 'allow', edit: 'allow', bash: 'allow', external: 'allow' },
  ])('maps permissionMode="$mode" to the source-equivalent OPENCODE_PERMISSION policy', ({
    mode,
    wildcard,
    read,
    edit,
    bash,
    external,
  }) => {
    const parsed = resolveKiloOpenCodePermissionPolicy(mode);
    expect(parsed['*']).toBe(wildcard);
    expect(parsed.read).toBe(read);
    expect(parsed.edit).toBe(edit);
    expect(parsed.bash).toBe(bash);
    expect(parsed.external_directory).toBe(external);
    expect(parsed.change_title).toBe('allow');
    expect(parsed.save_memory).toBe('allow');
    expect(parsed.think).toBe('allow');
  });

  it('does not overwrite caller-provided OPENCODE_PERMISSION', () => {
    expect(buildKiloOpenCodePermissionEnv({
      env: { OPENCODE_PERMISSION: '{"custom":"allow"}' },
      permissionMode: 'read-only',
    })).toEqual({});
  });
});
