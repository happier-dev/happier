import { describe, expect, it } from 'vitest';

import { QWEN_PERMISSION_MODE_ARGV } from './approvalMode.js';

describe('Qwen ACP approval mode argv', () => {
  it('omits approval mode argv for source-real default modes', () => {
    expect(QWEN_PERMISSION_MODE_ARGV.flag).toBe('--approval-mode');
    expect(QWEN_PERMISSION_MODE_ARGV.map.default).toBeNull();
    expect(QWEN_PERMISSION_MODE_ARGV.map.ask).toBeNull();
    expect(QWEN_PERMISSION_MODE_ARGV.map.prompt).toBeNull();
    expect(QWEN_PERMISSION_MODE_ARGV.map.normal).toBeNull();
  });

  it('preserves the complete Qwen explicit approval mode alias map', () => {
    expect(QWEN_PERMISSION_MODE_ARGV.map).toEqual({
      default: null,
      ask: null,
      prompt: null,
      normal: null,
      plan: 'plan',
      'read-only': 'plan',
      read_only: 'plan',
      readonly: 'plan',
      read: 'plan',
      ro: 'plan',
      acceptEdits: 'auto-edit',
      'accept-edits': 'auto-edit',
      'safe-yolo': 'auto-edit',
      safeyolo: 'auto-edit',
      safe: 'auto-edit',
      'workspace-write': 'auto-edit',
      workspace: 'auto-edit',
      'auto-edit': 'auto-edit',
      auto: 'auto-edit',
      yolo: 'yolo',
      bypassPermissions: 'yolo',
      'bypass-permissions': 'yolo',
      bypass: 'yolo',
      full: 'yolo',
      'full-access': 'yolo',
      dontask: 'yolo',
      'dont-ask': 'yolo',
      danger: 'yolo',
      'danger-full-access': 'yolo',
    });
  });
});
