import { describe, expect, it, vi } from 'vitest';

import { buildMaximalSchemaValue, encodedJsonBytes } from './maximumEncodedValue.js';

describe('maximum encoded schema derivation cost', () => {
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
