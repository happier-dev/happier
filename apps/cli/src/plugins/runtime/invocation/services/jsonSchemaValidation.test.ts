import { describe, expect, it } from 'vitest';

import {
    compilePluginJsonSchema,
    isValidPluginJsonSchemaValue,
} from './jsonSchemaValidation';

describe('plugin JSON Schema validation policy', () => {
    it('validates nested null-prototype enum and const values with JSON semantics', () => {
        const validate = compilePluginJsonSchema({
            allOf: [
                { enum: [{ valueOf: 'literal', nested: [{ enabled: true }], amount: 4 }] },
                { const: { amount: 4, nested: [{ enabled: true }], valueOf: 'literal' } },
            ],
        });
        const value = Object.assign(Object.create(null) as Record<string, unknown>, {
            amount: 4,
            nested: [Object.assign(Object.create(null) as Record<string, unknown>, { enabled: true })],
            valueOf: 'literal',
        });

        expect(isValidPluginJsonSchemaValue(validate, value)).toBe(true);
    });

    it('rejects accessor-backed values without invoking accessors', () => {
        const validate = compilePluginJsonSchema({ const: { valueOf: 'literal', enabled: true } });
        let reads = 0;
        const value = { enabled: true } as Record<string, unknown>;
        Object.defineProperty(value, 'valueOf', {
            enumerable: true,
            get() {
                reads += 1;
                throw new Error('accessor must not execute');
            },
        });

        expect(isValidPluginJsonSchemaValue(validate, value)).toBe(false);
        expect(reads).toBe(0);
    });

    it('rejects semantically duplicate enum declarations independent of key order', () => {
        expect(() => compilePluginJsonSchema({ enum: [{ first: 1, second: 2 }, { second: 2, first: 1 }] }))
            .toThrow(/enum values must be unique/i);
    });

    it('compiles distinct enum values with own valueOf data properties', () => {
        const validate = compilePluginJsonSchema({
            enum: [
                { valueOf: 'first', enabled: true },
                { valueOf: 'second', enabled: true },
            ],
        });

        expect(isValidPluginJsonSchemaValue(validate, { enabled: true, valueOf: 'second' })).toBe(true);
    });

    it('rejects malformed schemas before compilation', () => {
        expect(() => compilePluginJsonSchema({ anyOf: [] })).toThrow();
    });

    it('rejects accessor-backed schemas without invoking accessors', () => {
        let reads = 0;
        const variants: unknown[] = [];
        Object.defineProperty(variants, '0', {
            enumerable: true,
            get() {
                reads += 1;
                throw new Error('schema accessor must not execute');
            },
        });
        variants.length = 1;

        expect(() => compilePluginJsonSchema({ anyOf: variants })).toThrow();
        expect(reads).toBe(0);
    });

    it('rejects accessor-backed instance properties without invoking accessors', () => {
        const validate = compilePluginJsonSchema({
            type: 'object',
            required: ['name'],
            properties: { name: { type: 'string' } },
        });
        let reads = 0;
        const value: Record<string, unknown> = {};
        Object.defineProperty(value, 'name', {
            enumerable: true,
            get() {
                reads += 1;
                throw new Error('instance accessor must not execute');
            },
        });

        expect(isValidPluginJsonSchemaValue(validate, value)).toBe(false);
        expect(reads).toBe(0);
    });

    it('does not treat inherited instance properties as JSON object properties', () => {
        const validate = compilePluginJsonSchema({
            type: 'object',
            required: ['name'],
            properties: { name: { type: 'string' } },
        });
        const value = Object.create({ name: 'inherited' }) as Record<string, unknown>;

        expect(isValidPluginJsonSchemaValue(validate, value)).toBe(false);
    });

    it('rejects schema keywords outside the public plugin vocabulary', () => {
        expect(() => compilePluginJsonSchema({
            type: 'string',
            $id: 'https://happier.dev/plugin-test-schema',
        })).toThrow();
        expect(() => compilePluginJsonSchema({ type: 'string', format: 'email' })).toThrow();
        expect(() => compilePluginJsonSchema({ type: 'string', customConstraint: true })).toThrow();
    });

    it('bounds cyclic and deeply nested schema and instance data', () => {
        const cyclicSchema: Record<string, unknown> = { type: 'object' };
        cyclicSchema.properties = { self: cyclicSchema };
        expect(() => compilePluginJsonSchema(cyclicSchema)).toThrow();

        let deepSchema: Record<string, unknown> = { type: 'string' };
        for (let depth = 0; depth < 100; depth += 1) {
            deepSchema = { allOf: [deepSchema] };
        }
        expect(() => compilePluginJsonSchema(deepSchema)).toThrow();

        const validate = compilePluginJsonSchema({ type: 'object' });
        const cyclicValue: Record<string, unknown> = {};
        cyclicValue.self = cyclicValue;
        expect(isValidPluginJsonSchemaValue(validate, cyclicValue)).toBe(false);
    });
});
