import { afterEach, describe, expect, it } from 'vitest';

import type { PermissionMode } from '@/api/types';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { writeExecutableShimSync } from '@/testkit/fs/executableShim';
import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';
import { createKiloBackend } from './backend';

type AcpBackendLike = {
  options: {
    env: Record<string, string>;
  };
};

const envKeys = ['PATH', 'HAPPIER_KILO_PATH'] as const;
const tempDirs = new Set<string>();
let envScope = createEnvKeyScope(envKeys);

function createFakeBin(name: string): string {
  const dir = createTempDirSync('happier-kilo-backend-');
  tempDirs.add(dir);
  const isWindows = process.platform === 'win32';
  return writeExecutableShimSync({
    dir,
    fileName: isWindows ? `${name}.cmd` : name,
    contents: isWindows ? '@echo off\r\necho ok\r\n' : '#!/bin/sh\necho ok\n',
  });
}

afterEach(() => {
  envScope.restore();
  envScope = createEnvKeyScope(envKeys);
  for (const dir of tempDirs) removeTempDirSync(dir);
  tempDirs.clear();
});

function readPermissionConfig(permissionMode: PermissionMode | undefined): Record<string, string> {
  process.env.PATH = '';
  process.env.HAPPIER_KILO_PATH = createFakeBin('kilo');
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
  it('fails closed when the Kilo CLI is unavailable', () => {
    process.env.PATH = '';
    delete process.env.HAPPIER_KILO_PATH;

    expect(() => createKiloBackend({ cwd: '/tmp', env: {} })).toThrow(/Kilo CLI \(kilo\).*available/i);
  });

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
