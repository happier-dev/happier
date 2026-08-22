import { describe, expect, it } from 'vitest';
import {
    compilePluginJsonSchema,
    isValidPluginJsonSchemaValue,
} from '@happier-dev/protocol/plugins/manifest';

import {
    defineProtocolJsonValue,
    defineProtocolObject,
} from './protocol/index.js';

describe('defineProtocolJsonValue', () => {
    it('is a public protocol-authoring value leaf with one bounded JSON projection', () => {
        const closed = defineProtocolObject({
            providerConfig: defineProtocolJsonValue(),
        }, { policy: 'closed' });
        const preserve = defineProtocolObject({
            checkpointAfterBatch: defineProtocolJsonValue(),
        }, { policy: 'additive-open/preserve' });
        const validates = compilePluginJsonSchema(closed.jsonSchema);
        const providerConfig: {
            endpoint: string;
            filters: [boolean, null, { cursor: number }];
        } = {
            endpoint: 'wss://provider.example.test/socket',
            filters: [true, null, { cursor: 4 }],
        };

        const parsed = closed.safeParse({ providerConfig });
        expect(parsed).toEqual({ success: true, data: { providerConfig } });
        if (!parsed.success) throw new Error('expected a bounded JSON value to parse');
        expect(parsed.data.providerConfig).not.toBe(providerConfig);
        providerConfig.filters[2].cursor = 5;
        expect(parsed.data).toEqual({
            providerConfig: {
                endpoint: 'wss://provider.example.test/socket',
                filters: [true, null, { cursor: 4 }],
            },
        });
        expect(isValidPluginJsonSchemaValue(validates, parsed.data)).toBe(true);
        for (const value of [null, false, 4, 'ready', ['nested', 4], { nested: { ready: true } }]) {
            expect(closed.safeParse({ providerConfig: value })).toEqual({
                success: true,
                data: { providerConfig: value },
            });
            expect(isValidPluginJsonSchemaValue(validates, { providerConfig: value })).toBe(true);
        }
        expect(closed.jsonSchema).toEqual({
            $schema: 'http://json-schema.org/draft-07/schema#',
            type: 'object',
            properties: { providerConfig: {} },
            required: ['providerConfig'],
            additionalProperties: false,
        });

        expect(preserve.safeParse({
            checkpointAfterBatch: { offset: '43' },
            futurePresentationFact: true,
        })).toEqual({
            success: true,
            data: {
                checkpointAfterBatch: { offset: '43' },
                futurePresentationFact: true,
            },
        });
    });

    it('rejects non-ordinary JSON values through the canonical strict clone boundary', () => {
        const schema = defineProtocolObject({
            providerConfig: defineProtocolJsonValue(),
        }, { policy: 'closed' });
        const validates = compilePluginJsonSchema(schema.jsonSchema);
        const accessorBacked = { stable: true } as Record<string, unknown>;
        let accessorReads = 0;
        Object.defineProperty(accessorBacked, 'secret', {
            enumerable: true,
            get() {
                accessorReads += 1;
                return 'must-not-read';
            },
        });
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        const invalidValues = [
            accessorBacked,
            cyclic,
            new Date(),
            undefined,
            Number.NaN,
            Number.POSITIVE_INFINITY,
            BigInt(1),
            () => undefined,
            Symbol('not-json'),
        ];

        for (const providerConfig of invalidValues) {
            const value = { providerConfig };
            expect(schema.safeParse(value).success).toBe(false);
            expect(isValidPluginJsonSchemaValue(validates, value)).toBe(false);
        }
        expect(accessorReads).toBe(0);
    });

    it('accepts deep ordinary JSON without a public traversal quota', () => {
        const schema = defineProtocolObject({
            providerConfig: defineProtocolJsonValue(),
        }, { policy: 'closed' });
        const validates = compilePluginJsonSchema(schema.jsonSchema);
        let deepValue: unknown = 'leaf';
        for (let index = 0; index < 12_000; index += 1) {
            deepValue = { next: deepValue };
        }

        expect(defineProtocolJsonValue().safeParse(deepValue).success).toBe(true);
        const parsed = schema.safeParse({ providerConfig: deepValue });
        expect(parsed.success).toBe(true);
        expect(isValidPluginJsonSchemaValue(validates, { providerConfig: deepValue })).toBe(true);
        if (!parsed.success) return;

        let terminal: unknown = parsed.data.providerConfig;
        for (let index = 0; index < 12_000; index += 1) {
            terminal = (terminal as { next: unknown }).next;
        }
        expect(terminal).toBe('leaf');
    });

    it('keeps lone-surrogate JSON authoring and host validation aligned', () => {
        const providerConfig = { '\uD800': '\uDC00' };
        const serializedBytes = new TextEncoder().encode(JSON.stringify(providerConfig)).byteLength;
        const schema = defineProtocolObject({
            providerConfig: defineProtocolJsonValue({ maxSerializedUtf8Bytes: serializedBytes }),
        }, { policy: 'closed' });
        const validates = compilePluginJsonSchema(schema.jsonSchema);

        expect(schema.safeParse({ providerConfig })).toEqual({
            success: true,
            data: { providerConfig },
        });
        expect(isValidPluginJsonSchemaValue(validates, { providerConfig })).toBe(true);

        const tooSmall = defineProtocolObject({
            providerConfig: defineProtocolJsonValue({ maxSerializedUtf8Bytes: serializedBytes - 1 }),
        }, { policy: 'closed' });
        expect(tooSmall.safeParse({ providerConfig }).success).toBe(false);
        expect(isValidPluginJsonSchemaValue(
            compilePluginJsonSchema(tooSmall.jsonSchema),
            { providerConfig },
        )).toBe(false);
    });

    it('projects an owner-declared serialized UTF-8 ceiling into the host compiler', () => {
        const maximumBytes = 48 * 1024;
        const schema = defineProtocolObject({
            providerConfig: defineProtocolJsonValue({ maxSerializedUtf8Bytes: maximumBytes }),
        }, { policy: 'closed' });
        const validates = compilePluginJsonSchema(schema.jsonSchema);
        const asciiAtLimit = 'x'.repeat(maximumBytes - 2);
        const asciiOverLimit = 'x'.repeat(maximumBytes - 1);
        const multibyteAtLimit = `😀${'x'.repeat(maximumBytes - 6)}`;
        const multibyteOverLimit = `😀${'x'.repeat(maximumBytes - 5)}`;
        const nestedEmpty = { nested: { value: '' } };
        const nestedFixedBytes = new TextEncoder().encode(JSON.stringify(nestedEmpty)).byteLength;
        const nestedAtLimit = { nested: { value: 'x'.repeat(maximumBytes - nestedFixedBytes) } };
        const nestedOverLimit = { nested: { value: 'x'.repeat(maximumBytes - nestedFixedBytes + 1) } };

        for (const providerConfig of [asciiAtLimit, multibyteAtLimit, nestedAtLimit]) {
            expect(schema.safeParse({ providerConfig }).success).toBe(true);
            expect(isValidPluginJsonSchemaValue(validates, { providerConfig })).toBe(true);
        }
        for (const providerConfig of [asciiOverLimit, multibyteOverLimit, nestedOverLimit]) {
            expect(schema.safeParse({ providerConfig }).success).toBe(false);
            expect(isValidPluginJsonSchemaValue(validates, { providerConfig })).toBe(false);
        }
        expect(schema.jsonSchema).toEqual({
            $schema: 'http://json-schema.org/draft-07/schema#',
            type: 'object',
            properties: {
                providerConfig: { 'x-happier-max-serialized-utf8-bytes': maximumBytes },
            },
            required: ['providerConfig'],
            additionalProperties: false,
        });
    });

    it('accepts and enforces a safe owner-declared ceiling above four MiB', () => {
        const maximumBytes = (4 * 1024 * 1024) + 17;
        const schema = defineProtocolObject({
            providerConfig: defineProtocolJsonValue({ maxSerializedUtf8Bytes: maximumBytes }),
        }, { policy: 'closed' });
        const atLimit = 'x'.repeat(maximumBytes - 2);
        const overLimit = 'x'.repeat(maximumBytes - 1);

        expect(schema.safeParse({ providerConfig: atLimit }).success).toBe(true);
        expect(schema.safeParse({ providerConfig: overLimit }).success).toBe(false);
    });

});
