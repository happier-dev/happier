import { describe, expect, it, vi } from 'vitest';

import { TRIAGE_SINGLE_LINE_STRING_PATTERN_V1 } from '../../v1/constants.js';
import { triagePagingTokenUtf8BytesForFieldBytesV1 } from '../../v1/listSourceSchemas.js';
import { TRIAGE_LIST_SORT_FIELDS_V1, TriageListSortFieldsV1Schema } from '../../v1/sorting.js';
import { buildMaximalSchemaString, buildMaximalSchemaValue, encodedJsonBytes } from './maximumEncodedValue.js';

describe('maximum encoded schema derivation cost', () => {
    it('measures each closed unique-array member once and selects the longest admitted subset', () => {
        const encode = vi.spyOn(TextEncoder.prototype, 'encode');
        try {
            const value = buildMaximalSchemaValue({
                ...TriageListSortFieldsV1Schema.jsonSchema,
                maxItems: 2,
            }, 'sortFields');
            const encodings = encode.mock.calls.length;
            expect(value).toHaveLength(2);
            expect(TriageListSortFieldsV1Schema.parse(value)).toEqual(value);
            expect(encodings).toBe(TRIAGE_LIST_SORT_FIELDS_V1.length);
            // Brackets + the longest two encodings + one separator. The other
            // equally long field, created, cannot increase the byte maximum.
            expect(encodedJsonBytes(value)).toBe(2 + encodedJsonBytes('repository') + encodedJsonBytes('updated') + 1);
        } finally {
            encode.mockRestore();
        }
    });

    it('keeps string-fill encoding work independent of the scan frontier byte length', () => {
        const encode = TextEncoder.prototype.encode;
        let encodings = 0;
        // Count the real platform encoder without retaining millions of spy
        // call records when the old per-character search regresses.
        TextEncoder.prototype.encode = function (value) {
            encodings += 1;
            return encode.call(this, value);
        };
        try {
            const fieldBytes = 1024; // The allocation owner's adjacent sample.
            const work = [fieldBytes, triagePagingTokenUtf8BytesForFieldBytesV1(fieldBytes)].map((bytes) => {
                encodings = 0;
                const fill = buildMaximalSchemaString({
                    type: 'string', minLength: 1,
                    'x-happier-max-utf8-bytes': bytes,
                    pattern: TRIAGE_SINGLE_LINE_STRING_PATTERN_V1,
                }, 'triageListAllocation.continuation.token');
                const count = encodings;
                expect(encodedJsonBytes(fill)).toBe(bytes * 2 + 2);
                return count;
            });
            expect(work[1]).toBe(work[0]);
        } finally {
            TextEncoder.prototype.encode = encode;
        }
    });

    it('derives an equal string fill once rather than once per projected field', () => {
        // TextEncoder is the real platform boundary used to measure candidate
        // fills. Retain its implementation and observe work, not wall time.
        const encode = vi.spyOn(TextEncoder.prototype, 'encode');
        const field = { type: 'string', maxLength: 16 } as const;
        try {
            const single = buildMaximalSchemaValue({
                type: 'object', additionalProperties: false, properties: { text: field },
            }, 'single');
            const singleFillWork = encode.mock.calls.length;
            encode.mockClear();
            const repeated = buildMaximalSchemaValue({
                type: 'object', additionalProperties: false,
                properties: Object.fromEntries(Array.from({ length: 20 }, (_, index) => [String(index), { ...field }])),
            }, 'repeated');
            expect(Object.values(repeated as Record<string, unknown>)).toEqual(
                Array.from({ length: 20 }, () => (single as { text: string }).text),
            );
            expect(encode.mock.calls.length).toBe(singleFillWork);
            const widened = buildMaximalSchemaValue({
                type: 'object', additionalProperties: false,
                properties: { text: { ...field, maxLength: field.maxLength + 1 } },
            }, 'widened');
            expect(encodedJsonBytes(widened)).toBeGreaterThan(encodedJsonBytes(single));
        } finally {
            encode.mockRestore();
        }
    });
});
