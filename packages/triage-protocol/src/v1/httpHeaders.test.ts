import { describe, expect, it } from 'vitest';

import { readTriageResponseHeaderV1 } from './httpHeaders.js';

describe('triage response header read', () => {
    it('reads a header whose case differs from the wanted name in either direction', () => {
        const headers = { 'Retry-After': '30', 'x-ratelimit-reset': '1754000000' };

        // The copies this replaced disagreed on which side lowercases, so both
        // directions are asserted.
        expect(readTriageResponseHeaderV1(headers, 'retry-after')).toBe('30');
        expect(readTriageResponseHeaderV1(headers, 'X-RateLimit-Reset')).toBe('1754000000');
    });

    it('reads a header present but empty as absent', () => {
        // A provider that sends `Retry-After: ` has stated no hint, and a caller
        // that received `''` would parse it as one.
        expect(readTriageResponseHeaderV1({ 'retry-after': '   ' }, 'retry-after')).toBeNull();
        expect(readTriageResponseHeaderV1({}, 'retry-after')).toBeNull();
    });

    it('trims a padded value rather than handing it to a strict parser', () => {
        expect(readTriageResponseHeaderV1({ 'retry-after': ' 30 ' }, 'retry-after')).toBe('30');
    });

    it('keeps a falsy-looking but meaningful value', () => {
        // One replaced copy used `|| null`, which turns a zero into an absent
        // header. `Retry-After: 0` means retry now.
        expect(readTriageResponseHeaderV1({ 'retry-after': '0' }, 'retry-after')).toBe('0');
    });
});
