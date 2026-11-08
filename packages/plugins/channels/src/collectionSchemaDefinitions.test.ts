import { describe, expect, it } from 'vitest';
import { compilePluginJsonSchema, isValidPluginJsonSchemaValue } from '@happier-dev/plugin-sdk/manifest';
import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';

import { shareRepeatedCollectionSchemas } from './collectionSchemaDefinitions.js';

function inlineDefinitions(schema: PluginJsonSchema): unknown {
    const definitions = schema.$defs ?? {};
    const inline = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(inline);
        if (value === null || typeof value !== 'object') return value;
        const ref = (value as { $ref?: unknown }).$ref;
        if (typeof ref === 'string' && ref.startsWith('#/$defs/')) return inline(definitions[ref.slice('#/$defs/'.length)]);
        return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, inline(child)]));
    };
    const { $defs: _definitions, ...published } = schema;
    return inline(published);
}

const name = { type: 'string', minLength: 1, maxLength: 128, description: 'A bounded display name.' } as const;
const target = {
    type: 'object', additionalProperties: false, required: ['kind', 'name'],
    properties: { kind: { type: 'string', const: 'session' }, name },
} as const;

describe('shared Collection schema definitions', () => {
    it('publishes repeated subschemas once and validates exactly like the inline document', () => {
        const authored = {
            type: 'object', additionalProperties: false, required: ['id', 'payload'],
            properties: { id: name, payload: {} },
            oneOf: [
                // Equal content authored separately is shared like a reused constant.
                { properties: { payload: { type: 'object', additionalProperties: false, properties: { target, alias: name } } } },
                { properties: { payload: { type: 'object', additionalProperties: false, properties: { target: structuredClone(target) } } } },
                // A subschema holding a pointer keeps its absolute location.
                { properties: { payload: { $defs: { inner: name }, type: 'object', additionalProperties: false,
                    properties: { pointed: { $ref: '#/oneOf/2/properties/payload/$defs/inner' } } } } },
            ],
        } as unknown as PluginJsonSchema;
        const published = shareRepeatedCollectionSchemas(authored);

        expect(inlineDefinitions(published)).toEqual(authored);
        expect(published.properties?.id).toEqual(name);
        expect(Object.keys(published.$defs ?? {})).toHaveLength(2);
        expect(JSON.stringify(published.oneOf?.[2])).toBe(JSON.stringify(authored.oneOf?.[2]));
        const before = compilePluginJsonSchema(authored);
        const after = compilePluginJsonSchema(published);
        const rows = [
            { id: 'a', payload: { target: { kind: 'session', name: 'x' }, alias: 'y' } },
            { id: 'a', payload: { target: { kind: 'session', name: '' } } },
            { id: 'a', payload: { target: { kind: 'other', name: 'x' } } },
            { id: 'a', payload: { pointed: 'z' } },
            { id: 'a', payload: { pointed: 3 } },
            { id: '', payload: {} },
        ];
        expect(rows.map(row => isValidPluginJsonSchemaValue(after, row))).toEqual(rows.map(row => isValidPluginJsonSchemaValue(before, row)));
        expect(rows.map(row => isValidPluginJsonSchemaValue(after, row))).toEqual([true, false, false, true, false, false]);
    });
});
