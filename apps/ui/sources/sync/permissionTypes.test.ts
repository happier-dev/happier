import { describe, expect, it } from 'vitest';
import type { PermissionMode } from './permissionTypes';
import {
    isModelMode,
    isPermissionMode,
    getNextPermissionModeForGroup,
    normalizePermissionModeForGroup,
    normalizeProfileDefaultPermissionMode,
} from './permissionTypes';

describe('normalizePermissionModeForGroup', () => {
    it('fails closed plan mode to read-only for codexLike', () => {
        expect(normalizePermissionModeForGroup('plan', 'codexLike')).toBe('read-only');
    });

    it('preserves read-only intent for claude', () => {
        expect(normalizePermissionModeForGroup('read-only', 'claude')).toBe('read-only');
    });

    it('preserves codex-like modes for codexLike', () => {
        expect(normalizePermissionModeForGroup('safe-yolo', 'codexLike')).toBe('safe-yolo');
        expect(normalizePermissionModeForGroup('yolo', 'codexLike')).toBe('yolo');
    });

    it('preserves claude modes for claude', () => {
        expect(normalizePermissionModeForGroup('default', 'claude')).toBe('default');
        expect(normalizePermissionModeForGroup('read-only', 'claude')).toBe('read-only');
        expect(normalizePermissionModeForGroup('safe-yolo', 'claude')).toBe('safe-yolo');
        expect(normalizePermissionModeForGroup('yolo', 'claude')).toBe('yolo');
        expect(normalizePermissionModeForGroup('plan', 'claude')).toBe('plan');
        expect(normalizePermissionModeForGroup('acceptEdits', 'claude')).toBe('safe-yolo');
        expect(normalizePermissionModeForGroup('bypassPermissions', 'claude')).toBe('yolo');
    });
});

describe('isPermissionMode', () => {
    it('returns true for valid permission modes', () => {
        expect(isPermissionMode('default')).toBe(true);
        expect(isPermissionMode('read-only')).toBe(true);
        expect(isPermissionMode('plan')).toBe(true);
    });

    it('returns false for invalid values', () => {
        expect(isPermissionMode('bogus')).toBe(false);
        expect(isPermissionMode(null)).toBe(false);
        expect(isPermissionMode(123)).toBe(false);
    });
});

describe('getNextPermissionModeForGroup', () => {
    it('cycles through codex-like modes and clamps invalid current modes', () => {
        expect(getNextPermissionModeForGroup('default', 'codexLike')).toBe('read-only');
        expect(getNextPermissionModeForGroup('read-only', 'codexLike')).toBe('safe-yolo');
        expect(getNextPermissionModeForGroup('safe-yolo', 'codexLike')).toBe('yolo');
        expect(getNextPermissionModeForGroup('yolo', 'codexLike')).toBe('default');

        // If a claude-only mode slips in, treat it as default before cycling.
        expect(getNextPermissionModeForGroup('plan', 'codexLike')).toBe('read-only');
    });

    it('cycles through claude intents and clamps invalid current modes', () => {
        expect(getNextPermissionModeForGroup('default', 'claude')).toBe('safe-yolo');
        expect(getNextPermissionModeForGroup('safe-yolo', 'claude')).toBe('yolo');
        expect(getNextPermissionModeForGroup('yolo', 'claude')).toBe('plan');
        expect(getNextPermissionModeForGroup('plan', 'claude')).toBe('default');

        // If a codex-like mode slips in, treat it as default before cycling.
        expect(getNextPermissionModeForGroup('read-only', 'claude')).toBe('safe-yolo');
    });

    it('normalizes claude legacy tokens when cycling', () => {
        expect(getNextPermissionModeForGroup('acceptEdits', 'claude')).toBe('yolo');
        expect(getNextPermissionModeForGroup('bypassPermissions', 'claude')).toBe('plan');
    });
});

describe('normalizeProfileDefaultPermissionMode', () => {
    it('preserves codex-like modes for profile defaultPermissionMode', () => {
        expect(normalizeProfileDefaultPermissionMode('read-only')).toBe('read-only');
        expect(normalizeProfileDefaultPermissionMode('safe-yolo')).toBe('safe-yolo');
        expect(normalizeProfileDefaultPermissionMode('yolo')).toBe('yolo');
    });
});

describe('isModelMode', () => {
    it('returns true for non-empty strings', () => {
        expect(isModelMode('default')).toBe(true);
        expect(isModelMode('adaptiveUsage')).toBe(true);
        expect(isModelMode('gemini-2.5-pro')).toBe(true);
        expect(isModelMode('bogus')).toBe(true);
    });

    it('returns false for empty or non-string values', () => {
        expect(isModelMode('')).toBe(false);
        expect(isModelMode(null)).toBe(false);
    });
});
