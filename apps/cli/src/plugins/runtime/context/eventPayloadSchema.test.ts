import { describe, expect, it } from 'vitest';

import { validatePluginEventPayloadSchema } from './eventPayloadSchema';

describe('validatePluginEventPayloadSchema JSON equality', () => {
    it('accepts nested null-prototype enum and const values independent of key order', () => {
        const payload = Object.assign(Object.create(null) as Record<string, unknown>, {
            amount: 4,
            nested: [Object.assign(Object.create(null) as Record<string, unknown>, { enabled: true })],
            valueOf: 'literal',
        });
        const expected = { valueOf: 'literal', nested: [{ enabled: true }], amount: 4 };

        expect(validatePluginEventPayloadSchema({
            payloadSchema: { enum: [expected], const: expected },
            payload,
        })).toEqual({ success: true });
    });

    it('rejects accessor-backed values without invoking the accessor', () => {
        let reads = 0;
        const payload = { enabled: true } as Record<string, unknown>;
        Object.defineProperty(payload, 'valueOf', {
            enumerable: true,
            get() {
                reads += 1;
                throw new Error('accessor must not execute');
            },
        });

        expect(validatePluginEventPayloadSchema({
            payloadSchema: { const: { valueOf: 'literal', enabled: true } },
            payload,
        })).toMatchObject({ success: false });
        expect(reads).toBe(0);
    });

    it('rejects accessor-backed object properties without invoking the accessor', () => {
        let reads = 0;
        const payload: Record<string, unknown> = {};
        Object.defineProperty(payload, 'name', {
            enumerable: true,
            get() {
                reads += 1;
                throw new Error('accessor must not execute');
            },
        });

        expect(validatePluginEventPayloadSchema({
            payloadSchema: {
                type: 'object',
                required: ['name'],
                properties: { name: { type: 'string' } },
            },
            payload,
        })).toMatchObject({ success: false });
        expect(reads).toBe(0);
    });

    it('rejects non-JSON object prototypes and cyclic payloads', () => {
        expect(validatePluginEventPayloadSchema({
            payloadSchema: { type: 'object' },
            payload: new Date(),
        })).toMatchObject({ success: false });

        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        expect(validatePluginEventPayloadSchema({
            payloadSchema: { type: 'object' },
            payload: cyclic,
        })).toMatchObject({ success: false });
    });
});
