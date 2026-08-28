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

    it('admits the schema-derived aggregate-envelope ceiling and refuses one byte beyond it', () => {
        const jsonFramingBytes = new TextEncoder().encode('{"v":1,"cursor":""}').byteLength;
        const fittingCursor = 'x'.repeat(MAX_TRIAGE_PAGING_TOKEN_UTF8_BYTES_V1 - jsonFramingBytes);
        const fitting = encodeTriagePagingTokenV1({ v: 1, cursor: fittingCursor });
        const overflowing = encodeTriagePagingTokenV1({ v: 1, cursor: `${fittingCursor}x` });
        const validButOverBound = JSON.stringify({ v: 1, cursor: `${fittingCursor}x` });

        expect(fitting).not.toBeNull();
        expect(overflowing).toBeNull();
        expect(decodeTriagePagingTokenV1(fitting ?? '')).toEqual({ v: 1, cursor: fittingCursor });
        expect(decodeTriagePagingTokenV1(validButOverBound)).toBeNull();
    });

    it('rejects values that are not JSON objects', () => {
        expect(decodeTriagePagingTokenV1('not-json')).toBeNull();
        expect(decodeTriagePagingTokenV1('[1,2]')).toBeNull();
        expect(decodeTriagePagingTokenV1('"cursor"')).toBeNull();
        expect(decodeTriagePagingTokenV1('null')).toBeNull();
    });

    it('refuses a frontier JSON cannot represent rather than emitting undefined', () => {
        expect(encodeTriagePagingTokenV1(undefined)).toBeNull();
    });
});
