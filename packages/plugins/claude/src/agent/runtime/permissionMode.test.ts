import { describe, expect, it } from 'vitest';

import {
    inferPermissionIntentFromClaudeArgs,
    mapToClaudePermissionMode,
    resolveClaudePermissionModeFromRuntimeMode,
} from './permissionMode.js';

describe('Claude runtime permission mode mapping', () => {
    it('maps canonical cross-provider permission modes to Claude provider modes', () => {
        expect(mapToClaudePermissionMode('yolo')).toBe('bypassPermissions');
        expect(mapToClaudePermissionMode('safe-yolo')).toBe('auto');
        expect(mapToClaudePermissionMode('read-only')).toBe('dontAsk');
    });

    it('preserves Claude-native modes and lets plan agent mode win', () => {
        expect(mapToClaudePermissionMode('acceptEdits')).toBe('acceptEdits');
        expect(resolveClaudePermissionModeFromRuntimeMode({
            permissionMode: 'safe-yolo',
            agentModeId: 'plan',
        })).toBe('plan');
    });

    it('infers canonical Happier permission intent from Claude-native CLI args', () => {
        expect(inferPermissionIntentFromClaudeArgs(['--dangerously-skip-permissions'])).toBe('yolo');
        expect(inferPermissionIntentFromClaudeArgs(['--permission-mode', 'acceptEdits'])).toBe('safe-yolo');
        expect(inferPermissionIntentFromClaudeArgs(['--permission-mode=bypassPermissions'])).toBe('yolo');
    });

    it('uses the latest recognized Claude-native permission arg and ignores malformed values', () => {
        expect(inferPermissionIntentFromClaudeArgs(['--permission-mode'])).toBeNull();
        expect(inferPermissionIntentFromClaudeArgs(['--permission-mode', '--dangerously-skip-permissions'])).toBe('yolo');
        expect(inferPermissionIntentFromClaudeArgs([
            '--permission-mode',
            'default',
            '--permission-mode',
            'invalid',
        ])).toBe('default');
    });
});
