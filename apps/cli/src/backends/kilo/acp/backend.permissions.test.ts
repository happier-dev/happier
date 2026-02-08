import { describe, expect, it } from 'vitest';

import type { PermissionMode } from '@/api/types';
import { createKiloBackend } from './backend';

type AcpBackendLike = {
  options: {
    env: Record<string, string>;
  };
};

function readPermissionConfig(permissionMode: PermissionMode | undefined): Record<string, string> {
  const backend = createKiloBackend({
    cwd: '/tmp',
    env: {},
    permissionMode,
  }) as unknown as AcpBackendLike;

  const raw = backend.options.env.OPENCODE_PERMISSION;
  expect(typeof raw).toBe('string');
  return JSON.parse(raw) as Record<string, string>;
}

describe('Kilo ACP backend permissions', () => {
  it.each([
    { mode: 'default', wildcard: 'ask', read: 'allow', edit: 'ask', bash: 'ask', external: 'ask' },
    { mode: 'read-only', wildcard: 'deny', read: 'allow', edit: 'deny', bash: 'deny', external: 'deny' },
    { mode: 'plan', wildcard: 'deny', read: 'allow', edit: 'deny', bash: 'deny', external: 'deny' },
    { mode: 'safe-yolo', wildcard: 'ask', read: 'allow', edit: 'allow', bash: 'ask', external: 'ask' },
    { mode: 'yolo', wildcard: 'allow', read: 'allow', edit: 'allow', bash: 'allow', external: 'allow' },
    { mode: 'bypassPermissions', wildcard: 'allow', read: 'allow', edit: 'allow', bash: 'allow', external: 'allow' },
  ])(
    'maps permissionMode="$mode" to expected OPENCODE_PERMISSION policy',
    ({ mode, wildcard, read, edit, bash, external }) => {
      const parsed = readPermissionConfig(mode as PermissionMode);
      expect(parsed['*']).toBe(wildcard);
      expect(parsed.read).toBe(read);
      expect(parsed.edit).toBe(edit);
      expect(parsed.bash).toBe(bash);
      expect(parsed.external_directory).toBe(external);
      expect(parsed.change_title).toBe('allow');
      expect(parsed.save_memory).toBe('allow');
      expect(parsed.think).toBe('allow');
    },
  );
});
