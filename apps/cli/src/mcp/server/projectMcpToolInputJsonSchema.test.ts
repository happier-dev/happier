import Ajv from 'ajv';
import { z } from 'zod/mini';
import { describe, expect, it } from 'vitest';
import { zodSchemaToJsonSchemaObject } from '@happier-dev/protocol/actions/actionInputJsonSchema';
import { createActionExecutor } from '@happier-dev/protocol';
import { HAPPIER_BUILT_IN_TOOLS } from '@/agent/tools/happierTools/catalog';
import { createActionToolExecutorBridge } from '@/agent/tools/happierTools/createActionToolExecutorBridge';
import { dispatchBuiltInHappierTool } from '@/agent/tools/happierTools/dispatchBuiltInHappierTool';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { resolveSessionNativeToolDescriptors } from '@/agent/tools/happierTools/resolveSessionNativeToolBridge';
import { toMcpToolObjectSchema } from './toolSchemas';
import { projectMcpToolInputJsonSchema } from './projectMcpToolInputJsonSchema';

function oversizedEnums(value: unknown, path = '#'): string[] {
    if (!value || typeof value !== 'object') return [];
    if (Array.isArray(value)) return value.flatMap((child, index) => oversizedEnums(child, `${path}/${index}`));
    const schema = value as Record<string, unknown>;
    const values = schema.enum;
    const chars = Array.isArray(values) ? values.reduce((sum, item) => sum + (typeof item === 'string' ? item.length : 0), 0) : 0;
    return [
        ...(Array.isArray(values) && (values.length > 250 || chars > 15_000) ? [`${path}: values=${values.length} chars=${chars}`] : []),
        ...Object.entries(schema).filter(([key]) => !['enum', 'const', 'default', 'examples'].includes(key))
            .flatMap(([key, child]) => oversizedEnums(child, `${path}/${key}`)),
    ];
}

// Count schema levels, following local refs at the use site (not JSON containers).
function schemaDepth(document: unknown, value: unknown = document): number {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return 0;
    const node = value as Record<string, unknown>;
    let depth = 1;
    if (typeof node.$ref === 'string' && node.$ref.startsWith('#/')) {
        let target: unknown = document;
        for (const part of node.$ref.slice(2).split('/')) {
            target = target && typeof target === 'object'
                ? (target as Record<string, unknown>)[part.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined;
        }
        depth = Math.max(depth, schemaDepth(document, target));
    }
    for (const [key, child] of Object.entries(node)) {
        if (['properties', 'patternProperties', 'dependentSchemas', 'definitions', '$defs'].includes(key)) {
            for (const entry of Object.values(child as Record<string, unknown>)) depth = Math.max(depth, 1 + schemaDepth(document, entry));
        } else if (['items', 'additionalProperties', 'propertyNames', 'not', 'contains', 'if', 'then', 'else', 'unevaluatedProperties', 'unevaluatedItems', 'anyOf', 'oneOf', 'allOf', 'prefixItems'].includes(key)) {
            for (const entry of Array.isArray(child) ? child : [child]) depth = Math.max(depth, 1 + schemaDepth(document, entry));
        }
    }
    return depth;
}

function recursiveReferences(document: unknown): string[] {
    const active = new Set<object>();
    const done = new Set<object>();
    const failures: string[] = [];
    function visit(value: unknown, path: string): void {
        if (!value || typeof value !== 'object') return;
        if (active.has(value)) { failures.push(path); return; }
        if (done.has(value)) return;
        active.add(value);
        if (Array.isArray(value)) value.forEach((child, i) => visit(child, `${path}/${i}`));
        else {
            const node = value as Record<string, unknown>;
            if (typeof node.$ref === 'string' && node.$ref.startsWith('#')) {
                let target: unknown = document;
                for (const part of node.$ref.slice(2).split('/').filter(() => node.$ref !== '#')) {
                    target = target && typeof target === 'object'
                        ? (target as Record<string, unknown>)[part.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined;
                }
                visit(target, `${path} -> ${node.$ref}`);
            }
            for (const [key, child] of Object.entries(node)) {
                if (!['const', 'enum', 'default', 'examples'].includes(key)) visit(child, `${path}/${key}`);
            }
        }
        active.delete(value);
        done.add(value);
    }
    visit(document, '#');
    return failures;
}

describe('MCP provider input projection', () => {
    it('advertises draft-7 tuples as homogeneous items while retaining references and server tuple validation', () => {
        const parser = z.object({ executionRunContext: z.object({ versions: z.tuple([z.literal(1)]) }) });
        const source = zodSchemaToJsonSchemaObject(parser, { target: 'draft-7' });
        const schema = { ...source, definitions: { pair: { type: 'array', items: [{ type: 'string' }, { type: 'number' }], additionalItems: false } },
            properties: { ...source.properties as Record<string, unknown>, label: { $ref: '#/definitions/pair/items/0' },
                count: { $ref: '#/properties/open/additionalItems' },
                open: { type: 'array', items: [{ type: 'string' }], additionalItems: { $ref: '#/definitions/pair/items/1' } } },
            default: { items: [{ const: 'literal data' }] } };
        const projected = projectMcpToolInputJsonSchema(schema);
        expect(projected).toMatchObject({ properties: {
            executionRunContext: { properties: { versions: { items: { anyOf: [{ type: 'number', const: 1 }, false] } } } },
            label: { $ref: '#/definitions/pair/items/anyOf/0' },
            count: { $ref: '#/properties/open/items/anyOf/1' },
            open: { items: { anyOf: [{ type: 'string' }, { $ref: '#/definitions/pair/items/anyOf/1' }] } },
        }, default: schema.default });
        const validate = new Ajv({ strict: false }).compile(projected);
        expect(validate({ executionRunContext: { versions: [1] }, label: 'ok', count: 2, open: ['a', 2] })).toBe(true);
        expect(validate({ executionRunContext: { versions: [2] }, label: 42 })).toBe(false);
        expect(parser.safeParse({ executionRunContext: { versions: [2] } }).success).toBe(false);
        expect(schema.definitions.pair.items).toHaveLength(2);
    });
    it('keeps every exported MCP tool input non-recursive and within provider enum and depth thresholds', () => {
        const offenders = HAPPIER_BUILT_IN_TOOLS.flatMap(tool => {
            const schema = zodSchemaToJsonSchemaObject(toMcpToolObjectSchema(tool.inputSchema, 'inputSchema'));
            return [...oversizedEnums(schema), ...recursiveReferences(schema),
                ...(schemaDepth(schema) > 10 ? ['depth=' + schemaDepth(schema)] : [])].map(offender => `${tool.name} ${offender}`);
        });
        const native = resolveSessionNativeToolDescriptors({ accountSettings: {}, sessionId: 'enum-session',
            happierToolsEnabled: true, memoryRecallGuidanceEnabled: true, sessionMemoryEnabled: true,
            isServerFeatureEnabled: () => true });
        expect(native.length).toBeGreaterThan(0);
        offenders.push(...native.flatMap(tool => [...oversizedEnums(tool.inputSchema), ...recursiveReferences(tool.inputSchema),
            ...(schemaDepth(tool.inputSchema) > 10 ? ['depth=' + schemaDepth(tool.inputSchema)] : [])].map(offender => `native:${tool.name} ${offender}`)));
        expect(offenders).toEqual([]);
    });

    it('bounds expanded reference depth while preserving boundary leaves and opaque discovery guidance', () => {
        const nest = (levels: number): Record<string, unknown> => levels === 1
            ? { type: 'string', enum: ['ok'] }
            : { type: 'object', properties: { child: nest(levels - 1) } };
        const schema = { type: 'object', properties: {
            boundary: nest(9), deep: nest(10), referenced: { $ref: '#/definitions/deep' },
        }, definitions: { deep: nest(11) }, default: { properties: { literal: true } } };
        const projected = projectMcpToolInputJsonSchema(schema);
        expect(schemaDepth(projected)).toBeLessThanOrEqual(10);
        expect(projected.properties).toMatchObject({ boundary: nest(9) });
        let node = (projected.properties as Record<string, unknown>).deep as Record<string, unknown>;
        for (let level = 2; level < 10; level++) node = (node.properties as Record<string, unknown>).child as Record<string, unknown>;
        expect(node).toMatchObject({ type: 'object', description: expect.stringContaining('action_spec_get') });
        expect(node.properties).toBeUndefined();
        expect(new Ajv({ strict: false }).compile(projected)({ deep: {}, referenced: {} })).toBe(true);
        expect(schemaDepth(schema)).toBe(12);
        expect(projected.default).toEqual(schema.default);
    });

    it('projects large string enums in nested schemas without changing small enums or literal data', () => {
        const small = Array.from({ length: 250 }, (_, i) => `id${i}`);
        const large = [...small, 'last'];
        const schema = { type: 'object', properties: {
            atLength: { type: 'string', enum: ['x'.repeat(15_000)] },
            small: { type: 'string', enum: small },
            many: { type: 'array', items: { type: 'string', enum: large, description: 'Exact id.' } },
            long: { type: 'string', enum: ['x'.repeat(15_001)] },
        }, definitions: { id: { type: 'string', enum: large } },
        default: { enum: large } };
        const projected = projectMcpToolInputJsonSchema(schema);
        expect(oversizedEnums(projected)).toEqual([]);
        expect(projected).toMatchObject({ properties: {
            small: { enum: small },
            atLength: { enum: ['x'.repeat(15_000)] },
            many: { items: { type: 'string', description: expect.stringContaining('action_spec_search') } },
            long: { type: 'string' },
        }, default: { enum: large } });
        expect(schema.properties.many.items.enum).toEqual(large);
    });

    it('breaks root, indirect and escaped definition cycles while keeping shared references and literal data', () => {
        const schema = { type: 'object', properties: {
            tupleBranch: { $ref: '#/$defs/union/anyOf/0' }, child: { $ref: '#' }, first: { $ref: '#/$defs/a~1b' }, second: { $ref: '#/$defs/label' },
        }, $defs: {
            'a/b': { type: 'object', properties: { next: { $ref: '#/$defs/indirect' } } },
            indirect: { type: 'array', items: { $ref: '#/$defs/a~1b' } },
            label: { type: 'string' },
            union: { anyOf: [{ type: 'object', properties: { child: { $ref: '#/$defs/union/anyOf/0' } } }] },
        }, default: { $ref: '#' } };
        expect(recursiveReferences(schema).length).toBeGreaterThan(0);
        const projected = projectMcpToolInputJsonSchema(schema);
        expect(recursiveReferences(projected)).toEqual([]);
        expect(projected).toMatchObject({ properties: {
            child: { type: 'object', description: expect.stringContaining('action_spec_get') },
            second: { $ref: '#/$defs/label' },
        }, default: { $ref: '#' } });
        expect(new Ajv({ strict: false }).compile(projected)({ child: { child: {} }, first: { next: [{ next: [] }] }, second: 'label' })).toBe(true);
    });

    it('preserves recursive JSON values including primitive and nested array values', () => {
        const schema = { type: 'object', properties: { value: { $ref: '#/definitions/json' } }, definitions: {
            json: { anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'null' },
                { type: 'object', additionalProperties: { $ref: '#/definitions/json' } },
                { type: 'array', items: { $ref: '#/definitions/json' } }] },
        } };
        const projected = projectMcpToolInputJsonSchema(schema);
        expect(recursiveReferences(projected)).toEqual([]);
        const validate = new Ajv({ strict: false }).compile(projected);
        for (const value of ['text', 42, null, [[1, { nested: ['ok'] }]], { nested: { child: [] } }]) {
            expect(validate({ value })).toBe(true);
        }
    });

    it('preserves recursive widget input parsing and the existing invalid_parameters refusal', async () => {
        const tool = HAPPIER_BUILT_IN_TOOLS.find(tool => tool.name === 'widgets_definition_create')!;
        expect(tool.inputSchema).toBeInstanceOf(z.core.$ZodType);
        if (!(tool.inputSchema instanceof z.core.$ZodType)) throw new Error('Expected canonical Zod input');
        const args = { account: { serverId: 'home', accountId: 'owner' },
            artifactId: '49cc4eca-1ed6-4abe-bf70-e3be06cb0730', definition: {
                name: 'Checks', sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' },
                body: { kind: 'declarative', document: { version: 1, root: { kind: 'stack',
                    children: [{ kind: 'stack', children: [{ kind: 'text', text: 'Checks' }] }] } } },
                inputs: { fields: [] }, inputSchema: { type: 'object', additionalProperties: false },
            } };
        expect(tool.inputSchema.safeParse(args).success).toBe(true);
        const advertised = zodSchemaToJsonSchemaObject(toMcpToolObjectSchema(tool.inputSchema, 'inputSchema'));
        expect(new Ajv({ strict: false, validateFormats: false }).compile(advertised)(args)).toBe(true);
        const executor = createActionExecutor(createUnavailableActionTransportDeps());
        const invalid = { ...args, definition: { ...args.definition, body: { kind: 'declarative',
            document: { version: 1, root: { kind: 'stack', children: [{ kind: 'text', text: 42 }] } } } } };
        expect(tool.inputSchema.safeParse(invalid).success).toBe(false);
        const result = await executor.execute('widgets.definition.create', invalid, { surface: 'mcp', defaultSessionId: 'schema-session' });
        expect(result).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    });

    it('retains the existing unknown Action refusal after advertising ids as strings', async () => {
        const executor = createActionExecutor(createUnavailableActionTransportDeps());
        const bridge = createActionToolExecutorBridge({ executor, surface: 'agent' });
        const result = await dispatchBuiltInHappierTool({ toolName: 'action_spec_get',
            args: { id: 'definitely.invalid.action' }, sessionId: 'enum-session',
            deps: { changeTitle: async () => ({ success: true }), executeActionByToolName: bridge.executeActionByToolName } });
        expect(result).toMatchObject({ ok: false, errorCode: 'invalid_parameters', details: {
            issues: expect.arrayContaining([expect.objectContaining({ code: 'unknown_action', path: ['id'] })]),
        } });
    });
});
