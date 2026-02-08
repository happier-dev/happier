import { describe, expect, it } from 'vitest';

import { inferPermissionIntentFromClaudeArgs } from './inferPermissionIntentFromArgs';

describe('inferPermissionIntentFromClaudeArgs', () => {
  it('maps --dangerously-skip-permissions to yolo intent', () => {
    expect(inferPermissionIntentFromClaudeArgs(['--dangerously-skip-permissions'])).toBe('yolo');
  });

  it('maps --permission-mode acceptEdits to safe-yolo intent', () => {
    expect(inferPermissionIntentFromClaudeArgs(['--permission-mode', 'acceptEdits'])).toBe('safe-yolo');
  });

  it('maps --permission-mode bypassPermissions to yolo intent', () => {
    expect(inferPermissionIntentFromClaudeArgs(['--permission-mode', 'bypassPermissions'])).toBe('yolo');
  });

  it('passes through --permission-mode default as default intent', () => {
    expect(inferPermissionIntentFromClaudeArgs(['--permission-mode', 'default'])).toBe('default');
  });

  it('returns null when args do not specify a known permission mode', () => {
    expect(inferPermissionIntentFromClaudeArgs(['--permission-mode', 'nope'])).toBe(null);
  });

  it('uses the last recognized permission flag when multiple flags are present', () => {
    expect(
      inferPermissionIntentFromClaudeArgs([
        '--permission-mode',
        'acceptEdits',
        '--dangerously-skip-permissions',
      ]),
    ).toBe('yolo');

    expect(
      inferPermissionIntentFromClaudeArgs([
        '--dangerously-skip-permissions',
        '--permission-mode',
        'default',
      ]),
    ).toBe('default');
  });

  it('ignores --permission-mode when the value is missing', () => {
    expect(inferPermissionIntentFromClaudeArgs(['--permission-mode'])).toBe(null);
    expect(inferPermissionIntentFromClaudeArgs(['--permission-mode', '--dangerously-skip-permissions'])).toBe('yolo');
  });

  it('accepts repeated --permission-mode and uses the latest valid alias', () => {
    expect(
      inferPermissionIntentFromClaudeArgs([
        '--permission-mode',
        'default',
        '--permission-mode',
        'acceptEdits',
      ]),
    ).toBe('safe-yolo');

    expect(
      inferPermissionIntentFromClaudeArgs([
        '--permission-mode',
        'default',
        '--permission-mode',
        'invalid',
      ]),
    ).toBe('default');
  });
});
