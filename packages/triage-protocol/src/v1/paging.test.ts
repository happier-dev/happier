import { describe, expect, it } from 'vitest';

import { MAX_TRIAGE_PAGING_TOKEN_UTF8_BYTES_V1 } from './bounds.js';
import { decodeTriagePagingTokenV1, encodeTriagePagingTokenV1 } from './paging.js';

describe('triage paging token envelope', () => {
    it('round-trips a source frontier record', () => {
        const token = encodeTriagePagingTokenV1({ v: 1, cursor: 'ts:0:0', lanes: [1, 2] });

        expect(token).not.toBeNull();
        expect(decodeTriagePagingTokenV1(token ?? '')).toEqual({
            v: 1,
            cursor: 'ts:0:0',
            lanes: [1, 2],
        });
    });

    it('refuses to mint a token wider than the bound instead of emitting one', () => {
        // The whole point: an over-bound token rejects the ENTIRE scan result at the
        // Action boundary, so the walk must end here and settle a truthful partial.
        const wide = encodeTriagePagingTokenV1({
            v: 1,
            cursor: 'x'.repeat(MAX_TRIAGE_PAGING_TOKEN_UTF8_BYTES_V1),
        });

        expect(wide).toBeNull();
        // One byte under the bound still mints, so the refusal is the bound and not
        // a rounded-down guess about it.
        const fits = encodeTriagePagingTokenV1({
            c: 'x'.repeat(MAX_TRIAGE_PAGING_TOKEN_UTF8_BYTES_V1 - 12),
        });
        expect(fits).not.toBeNull();
        expect(new TextEncoder().encode(fits ?? '').byteLength)
            .toBeLessThanOrEqual(MAX_TRIAGE_PAGING_TOKEN_UTF8_BYTES_V1);
    });

    it('measures the bound in UTF-8 bytes rather than code units', () => {
        // A multi-byte cursor is where a `length` check silently admits four times
        // the bytes the contract allows.
        const multiByte = '\u{1F600}'.repeat(MAX_TRIAGE_PAGING_TOKEN_UTF8_BYTES_V1 / 4);

        expect(multiByte.length).toBeLessThan(MAX_TRIAGE_PAGING_TOKEN_UTF8_BYTES_V1);
        expect(encodeTriagePagingTokenV1({ cursor: multiByte })).toBeNull();
    });

    it('rejects bytes that are not a bounded JSON object', () => {
        expect(decodeTriagePagingTokenV1('not-json')).toBeNull();
        expect(decodeTriagePagingTokenV1('[1,2]')).toBeNull();
        expect(decodeTriagePagingTokenV1('"cursor"')).toBeNull();
        expect(decodeTriagePagingTokenV1('null')).toBeNull();
        expect(decodeTriagePagingTokenV1(
            JSON.stringify({ c: 'x'.repeat(MAX_TRIAGE_PAGING_TOKEN_UTF8_BYTES_V1) }),
        )).toBeNull();
    });

    it('refuses a frontier JSON cannot represent rather than emitting undefined', () => {
        expect(encodeTriagePagingTokenV1(undefined)).toBeNull();
    });
});
