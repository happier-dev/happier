import { describe, it, expect } from 'vitest';
import { getErrorMessage } from './getErrorMessage';

describe('getErrorMessage', () => {
    it('returns message for Error', () => {
        expect(getErrorMessage(new Error('boom'))).toBe('boom');
    });

    it('falls back to String(error) when Error has empty message', () => {
        expect(getErrorMessage(new Error(''))).toBe('Error');
    });

    it('returns message field for plain object', () => {
        expect(getErrorMessage({ message: 'nope' })).toBe('nope');
    });

    it('returns string input as-is', () => {
        expect(getErrorMessage('oops')).toBe('oops');
    });

    it('handles nullish values', () => {
        expect(getErrorMessage(null)).toBe('');
        expect(getErrorMessage(undefined)).toBe('');
    });
});

