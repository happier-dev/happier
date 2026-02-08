/**
 * Unit tests for tmux utilities
 *
 * NOTE: These are pure unit tests that test parsing and validation logic.
 * They do NOT require tmux to be installed on the system.
 * All tests mock environment variables and test string parsing only.
 */
import { describe, expect, it } from 'vitest';
import {
    normalizeExitCode,
    parseTmuxSessionIdentifier,
    formatTmuxSessionIdentifier,
    validateTmuxSessionIdentifier,
    buildTmuxSessionIdentifier,
    TmuxSessionIdentifierError,
    extractSessionAndWindow,
    type TmuxSessionIdentifier,
} from './index';

describe('normalizeExitCode', () => {
    it('treats signal termination (null) as non-zero', () => {
        expect(normalizeExitCode(null)).toBe(1);
    });

    it('preserves normal exit codes', () => {
        expect(normalizeExitCode(0)).toBe(0);
        expect(normalizeExitCode(2)).toBe(2);
    });
});

describe('parseTmuxSessionIdentifier', () => {
    it('should parse session-only identifier', () => {
        const result = parseTmuxSessionIdentifier('my-session');
        expect(result).toEqual({
            session: 'my-session'
        });
    });

    it('should parse session:window identifier', () => {
        const result = parseTmuxSessionIdentifier('my-session:window-1');
        expect(result).toEqual({
            session: 'my-session',
            window: 'window-1'
        });
    });

    it('should parse session:window.pane identifier', () => {
        const result = parseTmuxSessionIdentifier('my-session:window-1.2');
        expect(result).toEqual({
            session: 'my-session',
            window: 'window-1',
            pane: '2'
        });
    });

    it('should handle session names with dots, hyphens, and underscores', () => {
        const result = parseTmuxSessionIdentifier('my.test_session-1');
        expect(result).toEqual({
            session: 'my.test_session-1'
        });
    });

    it('should handle window names with hyphens and underscores', () => {
        const result = parseTmuxSessionIdentifier('session:my_test-window-1');
        expect(result).toEqual({
            session: 'session',
            window: 'my_test-window-1'
        });
    });

    it('should throw on empty string', () => {
        expect(() => parseTmuxSessionIdentifier('')).toThrow(TmuxSessionIdentifierError);
        expect(() => parseTmuxSessionIdentifier('')).toThrow('Session identifier must be a non-empty string');
    });

    it('should throw on null/undefined', () => {
        expect(() => parseTmuxSessionIdentifier(null as unknown as string)).toThrow(TmuxSessionIdentifierError);
        expect(() => parseTmuxSessionIdentifier(undefined as unknown as string)).toThrow(TmuxSessionIdentifierError);
    });

    it('should allow session names with spaces', () => {
        const result = parseTmuxSessionIdentifier('my session:window-1');
        expect(result).toEqual({
            session: 'my session',
            window: 'window-1',
        });
    });

    it('should throw on special characters in session name', () => {
        expect(() => parseTmuxSessionIdentifier('session@name')).toThrow(TmuxSessionIdentifierError);
        expect(() => parseTmuxSessionIdentifier('session#name')).toThrow(TmuxSessionIdentifierError);
        expect(() => parseTmuxSessionIdentifier('session$name')).toThrow(TmuxSessionIdentifierError);
    });

    it('should throw on invalid window name characters', () => {
        expect(() => parseTmuxSessionIdentifier('session:invalid@window')).toThrow(TmuxSessionIdentifierError);
        expect(() => parseTmuxSessionIdentifier('session:invalid@window')).toThrow('Only alphanumeric characters');
    });

    it('should throw on non-numeric pane identifier', () => {
        expect(() => parseTmuxSessionIdentifier('session:window.abc')).toThrow(TmuxSessionIdentifierError);
        expect(() => parseTmuxSessionIdentifier('session:window.abc')).toThrow('Only numeric values are allowed');
    });

    it('should throw on pane identifier with special characters', () => {
        expect(() => parseTmuxSessionIdentifier('session:window.1a')).toThrow(TmuxSessionIdentifierError);
        expect(() => parseTmuxSessionIdentifier('session:window.-1')).toThrow(TmuxSessionIdentifierError);
    });

    it('should trim whitespace from components', () => {
        const result = parseTmuxSessionIdentifier('session : window . 2');
        expect(result).toEqual({
            session: 'session',
            window: 'window',
            pane: '2'
        });
    });
});

describe('formatTmuxSessionIdentifier', () => {
    it('should format session-only identifier', () => {
        const identifier: TmuxSessionIdentifier = { session: 'my-session' };
        expect(formatTmuxSessionIdentifier(identifier)).toBe('my-session');
    });

    it('should format session:window identifier', () => {
        const identifier: TmuxSessionIdentifier = {
            session: 'my-session',
            window: 'window-1'
        };
        expect(formatTmuxSessionIdentifier(identifier)).toBe('my-session:window-1');
    });

    it('should format session:window.pane identifier', () => {
        const identifier: TmuxSessionIdentifier = {
            session: 'my-session',
            window: 'window-1',
            pane: '2'
        };
        expect(formatTmuxSessionIdentifier(identifier)).toBe('my-session:window-1.2');
    });

    it('should ignore pane when window is not provided', () => {
        const identifier: TmuxSessionIdentifier = {
            session: 'my-session',
            pane: '2'
        };
        expect(formatTmuxSessionIdentifier(identifier)).toBe('my-session');
    });

    it('should throw when session is missing', () => {
        const identifier: TmuxSessionIdentifier = { session: '' };
        expect(() => formatTmuxSessionIdentifier(identifier)).toThrow(TmuxSessionIdentifierError);
        expect(() => formatTmuxSessionIdentifier(identifier)).toThrow('Session identifier must have a session name');
    });

    it('should handle complex valid names', () => {
        const identifier: TmuxSessionIdentifier = {
            session: 'my.test_session-1',
            window: 'my_test-window-2',
            pane: '3'
        };
        expect(formatTmuxSessionIdentifier(identifier)).toBe('my.test_session-1:my_test-window-2.3');
    });
});

describe('validateTmuxSessionIdentifier', () => {
    it('should return valid:true for valid session-only identifier', () => {
        const result = validateTmuxSessionIdentifier('my-session');
        expect(result).toEqual({ valid: true });
    });

    it('should return valid:true for valid session:window identifier', () => {
        const result = validateTmuxSessionIdentifier('my-session:window-1');
        expect(result).toEqual({ valid: true });
    });

    it('should return valid:true for valid session:window.pane identifier', () => {
        const result = validateTmuxSessionIdentifier('my-session:window-1.2');
        expect(result).toEqual({ valid: true });
    });

    it('should return valid:false for empty string', () => {
        const result = validateTmuxSessionIdentifier('');
        expect(result.valid).toBe(false);
        expect(result.error).toBeDefined();
    });

    it('should return valid:false for invalid session characters', () => {
        const result = validateTmuxSessionIdentifier('invalid@session');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('Only alphanumeric characters');
    });

    it('should return valid:false for invalid window characters', () => {
        const result = validateTmuxSessionIdentifier('session:invalid@window');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('Only alphanumeric characters');
    });

    it('should return valid:false for invalid pane identifier', () => {
        const result = validateTmuxSessionIdentifier('session:window.abc');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('Only numeric values are allowed');
    });

    it('should handle complex valid identifiers', () => {
        const result = validateTmuxSessionIdentifier('my.test_session-1:my_test-window-2.3');
        expect(result).toEqual({ valid: true });
    });

    it('should not throw exceptions', () => {
        expect(() => validateTmuxSessionIdentifier('')).not.toThrow();
        expect(() => validateTmuxSessionIdentifier('invalid@session')).not.toThrow();
        expect(() => validateTmuxSessionIdentifier(null as unknown as string)).not.toThrow();
    });
});

describe('buildTmuxSessionIdentifier', () => {
    it('should build session-only identifier', () => {
        const result = buildTmuxSessionIdentifier({ session: 'my-session' });
        expect(result).toEqual({
            success: true,
            identifier: 'my-session'
        });
    });

    it('should build session:window identifier', () => {
        const result = buildTmuxSessionIdentifier({
            session: 'my-session',
            window: 'window-1'
        });
        expect(result).toEqual({
            success: true,
            identifier: 'my-session:window-1'
        });
    });

    it('should build session:window.pane identifier', () => {
        const result = buildTmuxSessionIdentifier({
            session: 'my-session',
            window: 'window-1',
            pane: '2'
        });
        expect(result).toEqual({
            success: true,
            identifier: 'my-session:window-1.2'
        });
    });

    it('should return error for empty session name', () => {
        const result = buildTmuxSessionIdentifier({ session: '' });
        expect(result.success).toBe(false);
        expect(result.error).toContain('Invalid session name');
    });

    it('should return error for invalid session characters', () => {
        const result = buildTmuxSessionIdentifier({ session: 'invalid@session' });
        expect(result.success).toBe(false);
        expect(result.error).toContain('Invalid session name');
    });

    it('should return error for invalid window characters', () => {
        const result = buildTmuxSessionIdentifier({
            session: 'session',
            window: 'invalid@window'
        });
        expect(result.success).toBe(false);
        expect(result.error).toContain('Invalid window name');
    });

    it('should return error for invalid pane identifier', () => {
        const result = buildTmuxSessionIdentifier({
            session: 'session',
            window: 'window',
            pane: 'abc'
        });
        expect(result.success).toBe(false);
        expect(result.error).toContain('Invalid pane identifier');
    });

    it('should handle complex valid inputs', () => {
        const result = buildTmuxSessionIdentifier({
            session: 'my.test_session-1',
            window: 'my_test-window-2',
            pane: '3'
        });
        expect(result).toEqual({
            success: true,
            identifier: 'my.test_session-1:my_test-window-2.3'
        });
    });

    it('should not throw exceptions for invalid inputs', () => {
        expect(() => buildTmuxSessionIdentifier({ session: '' })).not.toThrow();
        expect(() => buildTmuxSessionIdentifier({ session: 'invalid@session' })).not.toThrow();
        expect(() => buildTmuxSessionIdentifier({ session: null as unknown as string })).not.toThrow();
    });
});

describe('Round-trip consistency', () => {
    it('should parse and format consistently for session-only', () => {
        const original = 'my-session';
        const parsed = parseTmuxSessionIdentifier(original);
        const formatted = formatTmuxSessionIdentifier(parsed);
        expect(formatted).toBe(original);
    });

    it('should parse and format consistently for session:window', () => {
        const original = 'my-session:window-1';
        const parsed = parseTmuxSessionIdentifier(original);
        const formatted = formatTmuxSessionIdentifier(parsed);
        expect(formatted).toBe(original);
    });

    it('should parse and format consistently for session:window.pane', () => {
        const original = 'my-session:window-1.2';
        const parsed = parseTmuxSessionIdentifier(original);
        const formatted = formatTmuxSessionIdentifier(parsed);
        expect(formatted).toBe(original);
    });

    it('should build and parse consistently', () => {
        const params = {
            session: 'my-session',
            window: 'window-1',
            pane: '2'
        };
        const built = buildTmuxSessionIdentifier(params);
        expect(built.success).toBe(true);
        const parsed = parseTmuxSessionIdentifier(built.identifier!);
        expect(parsed).toEqual(params);
    });
});

describe('extractSessionAndWindow', () => {
    it('extracts session and window names containing spaces', () => {
        const parsed = extractSessionAndWindow('my session:my window.2');
        expect(parsed).toEqual({ session: 'my session', window: 'my window' });
    });
});
