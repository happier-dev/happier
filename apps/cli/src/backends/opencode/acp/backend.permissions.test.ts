import { describe, expect, it } from 'vitest';

import type { PermissionMode } from '@/api/types';
import { createOpenCodeBackend } from './backend';

type AcpBackendLike = {
  options: {
    env: Record<string, string>;
  };
};

function readPermissionConfig(permissionMode: PermissionMode | undefined): Record<string, string> {
  // This test only asserts the permission policy env payload. We don’t want it to
  // depend on whether `opencode` is installed on the machine running the tests.
  const previousOpenCodePath = process.env.HAPPIER_OPENCODE_PATH;
  process.env.HAPPIER_OPENCODE_PATH = previousOpenCodePath ?? process.execPath;

  const backend = createOpenCodeBackend({
    cwd: '/tmp',
    env: {},
    permissionMode,
  }) as unknown as AcpBackendLike;

  try {
    const raw = backend.options.env.OPENCODE_PERMISSION;
    expect(typeof raw).toBe('string');
    return JSON.parse(raw) as Record<string, string>;
  } finally {
    if (previousOpenCodePath === undefined) {
      delete process.env.HAPPIER_OPENCODE_PATH;
    } else {
      process.env.HAPPIER_OPENCODE_PATH = previousOpenCodePath;
    }
  }
}

describe('OpenCode ACP backend permissions', () => {
  it.each([
    { mode: undefined, wildcard: 'ask', read: 'allow', edit: 'ask', bash: 'ask', external: 'ask' },
    { mode: 'default', wildcard: 'ask', read: 'allow', edit: 'ask', bash: 'ask', external: 'ask' },
    { mode: 'read-only', wildcard: 'deny', read: 'allow', edit: 'deny', bash: 'deny', external: 'deny' },
    { mode: 'plan', wildcard: 'deny', read: 'allow', edit: 'deny', bash: 'deny', external: 'deny' },
    { mode: 'safe-yolo', wildcard: 'ask', read: 'allow', edit: 'allow', bash: 'ask', external: 'ask' },
    { mode: 'yolo', wildcard: 'allow', read: 'allow', edit: 'allow', bash: 'allow', external: 'allow' },
    { mode: 'bypassPermissions', wildcard: 'allow', read: 'allow', edit: 'allow', bash: 'allow', external: 'allow' },
  ])(
    'maps permissionMode="$mode" to expected OPENCODE_PERMISSION policy',
    ({ mode, wildcard, read, edit, bash, external }) => {
      const parsed = readPermissionConfig(mode as PermissionMode | undefined);
      expect(parsed['*']).toBe(wildcard);
      expect(parsed.read).toBe(read);
      expect(parsed.edit).toBe(edit);
      expect(parsed.bash).toBe(bash);
      expect(parsed.external_directory).toBe(external);
      expect(parsed.change_title).toBe('allow');
      expect(parsed.session_title_set).toBe('allow');
      expect(parsed.happier_session_title_set).toBe('allow');
      expect(parsed.happier_action_execute).toBe('allow');
      expect(parsed.save_memory).toBe('allow');
      expect(parsed.think).toBe('allow');
    },
  );
});
