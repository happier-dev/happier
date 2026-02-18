import { describe, expect, it } from 'vitest';

import { buildPiToolsForPermissionMode, createPiBackend } from './backend';

describe('pi backend argv', () => {
  it('adds --thinking when HAPPIER_PI_THINKING_LEVEL is set', () => {
    const backend = createPiBackend({
      cwd: '/tmp',
      env: { HAPPIER_PI_THINKING_LEVEL: 'high' },
      permissionMode: 'default',
    });

    const args = (backend as any).options?.args as string[] | undefined;
    expect(Array.isArray(args)).toBe(true);
    expect(args).toContain('--thinking');
    expect(args).toContain('high');
  });

  it('ignores invalid thinking levels', () => {
    const backend = createPiBackend({
      cwd: '/tmp',
      env: { HAPPIER_PI_THINKING_LEVEL: 'definitely-not-valid' },
      permissionMode: 'default',
    });

    const args = (backend as any).options?.args as string[] | undefined;
    expect(Array.isArray(args)).toBe(true);
    expect(args).not.toContain('--thinking');
  });
});

describe('buildPiToolsForPermissionMode', () => {
  it.each([
    { mode: 'plan', expected: ['read', 'grep', 'find', 'ls'] },
    { mode: 'read-only', expected: ['read', 'grep', 'find', 'ls'] },
    { mode: 'default', expected: ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'] },
    { mode: 'safe-yolo', expected: ['read', 'edit', 'write', 'grep', 'find', 'ls'] },
    { mode: 'acceptEdits', expected: ['read', 'edit', 'write', 'grep', 'find', 'ls'] },
    { mode: 'yolo', expected: ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'] },
    { mode: 'bypassPermissions', expected: ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'] },
  ] as const)('maps $mode to tools list', ({ mode, expected }) => {
    expect(buildPiToolsForPermissionMode(mode)).toEqual(expected);
  });
});
