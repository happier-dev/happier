import { describe, it, expect } from 'vitest';
import { extractTmuxWindowIndexConflict, isTmuxWindowIndexConflict } from './env';

describe('isTmuxWindowIndexConflict', () => {
    it('returns true for tmux index conflict messages', () => {
        expect(isTmuxWindowIndexConflict('create window failed: index 0 in use.')).toBe(true);
        expect(isTmuxWindowIndexConflict('create window failed: index 1 in use.')).toBe(true);
        expect(isTmuxWindowIndexConflict('create window failed: index 42 in use.')).toBe(true);
    });

    it('returns true regardless of case', () => {
        expect(isTmuxWindowIndexConflict('INDEX 5 IN USE')).toBe(true);
        expect(isTmuxWindowIndexConflict('Index 5 In Use')).toBe(true);
    });

    it('returns false for non-conflict messages', () => {
        expect(isTmuxWindowIndexConflict('session not found')).toBe(false);
        expect(isTmuxWindowIndexConflict('no server running')).toBe(false);
        expect(isTmuxWindowIndexConflict('')).toBe(false);
    });

    it('returns false for undefined', () => {
        expect(isTmuxWindowIndexConflict(undefined)).toBe(false);
    });
});

describe('extractTmuxWindowIndexConflict', () => {
    it('extracts window index from tmux error messages', () => {
        expect(extractTmuxWindowIndexConflict('create window failed: index 0 in use.')).toBe(0);
        expect(extractTmuxWindowIndexConflict('create window failed: index 1 in use.')).toBe(1);
        expect(extractTmuxWindowIndexConflict('create window failed: index 42 in use.')).toBe(42);
    });

    it('extracts index regardless of case', () => {
        expect(extractTmuxWindowIndexConflict('INDEX 5 IN USE')).toBe(5);
        expect(extractTmuxWindowIndexConflict('Index 5 In Use')).toBe(5);
    });

    it('returns null for non-conflict messages', () => {
        expect(extractTmuxWindowIndexConflict('session not found')).toBeNull();
        expect(extractTmuxWindowIndexConflict('no server running')).toBeNull();
        expect(extractTmuxWindowIndexConflict('')).toBeNull();
    });

    it('returns null for undefined', () => {
        expect(extractTmuxWindowIndexConflict(undefined)).toBeNull();
    });

    it('handles extra whitespace', () => {
        expect(extractTmuxWindowIndexConflict('create window failed: index   3   in use.')).toBe(3);
    });
});
