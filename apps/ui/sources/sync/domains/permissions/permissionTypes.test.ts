import { describe, expect, it } from 'vitest';
import type { PermissionMode } from './permissionTypes';
import {
    isModelMode,
    isPermissionMode,
    normalizeProfileDefaultPermissionMode,
} from './permissionTypes';

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
