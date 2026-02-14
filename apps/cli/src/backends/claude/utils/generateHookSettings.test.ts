import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import { cleanupHookSettingsFile, generateHookSettingsFile } from './generateHookSettings';

describe('generateHookSettingsFile', () => {
  const createdFiles: string[] = [];

  afterEach(() => {
    for (const filePath of createdFiles.splice(0, createdFiles.length)) {
      cleanupHookSettingsFile(filePath);
    }
  });

  it('creates SessionStart hook settings by default', () => {
    const filePath = generateHookSettingsFile(43123);
    createdFiles.push(filePath);

    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as any;
    expect(parsed.hooks?.SessionStart?.[0]?.hooks?.[0]?.command).toContain('session_hook_forwarder.cjs');
    expect(parsed.hooks?.PermissionRequest).toBeUndefined();
  });

  it('adds PermissionRequest hook when local permission bridge is enabled', () => {
    const filePath = generateHookSettingsFile(43124, {
      enableLocalPermissionBridge: true,
      permissionHookSecret: 'test-secret-123',
    });
    createdFiles.push(filePath);

    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as any;
    const permissionCommand = parsed.hooks?.PermissionRequest?.[0]?.hooks?.[0]?.command as string;
    expect(permissionCommand).toContain('permission_hook_forwarder.cjs');
    expect(permissionCommand).toContain('test-secret-123');
  });
});
