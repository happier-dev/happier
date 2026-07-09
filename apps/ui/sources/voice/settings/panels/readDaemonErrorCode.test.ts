import { describe, expect, it } from 'vitest';

import { readDaemonErrorCode } from './readDaemonErrorCode';

type Code = 'feature_disabled' | 'request_timeout' | 'internal_error';
const KNOWN: ReadonlySet<Code> = new Set<Code>([
    'feature_disabled',
    'request_timeout',
    'internal_error',
]);

describe('readDaemonErrorCode', () => {
    it('returns a recognized code unchanged', () => {
        expect(readDaemonErrorCode({ code: 'request_timeout' }, KNOWN, 'internal_error')).toBe(
            'request_timeout',
        );
    });

    it('collapses an unrecognized code to the fallback (never leaks a non-union string)', () => {
        expect(readDaemonErrorCode({ code: 'totally_unknown' }, KNOWN, 'internal_error')).toBe(
            'internal_error',
        );
    });

    it('collapses a missing/empty code to the fallback', () => {
        expect(readDaemonErrorCode({ code: '' }, KNOWN, 'internal_error')).toBe('internal_error');
        expect(readDaemonErrorCode({}, KNOWN, 'internal_error')).toBe('internal_error');
    });

    it('collapses non-object errors to the fallback', () => {
        expect(readDaemonErrorCode('boom', KNOWN, 'internal_error')).toBe('internal_error');
        expect(readDaemonErrorCode(null, KNOWN, 'internal_error')).toBe('internal_error');
        expect(readDaemonErrorCode(undefined, KNOWN, 'internal_error')).toBe('internal_error');
    });
});
