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
    it('keeps every exported MCP tool input non-recursive and within provider enum thresholds', () => {
        const offenders = HAPPIER_BUILT_IN_TOOLS.flatMap(tool => {
            const schema = zodSchemaToJsonSchemaObject(toMcpToolObjectSchema(tool.inputSchema, 'inputSchema'));
            return [...oversizedEnums(schema), ...recursiveReferences(schema)].map(offender => `${tool.name} ${offender}`);
        });
        const native = resolveSessionNativeToolDescriptors({ accountSettings: {}, sessionId: 'enum-session',
            happierToolsEnabled: true, memoryRecallGuidanceEnabled: true, sessionMemoryEnabled: true,
            isServerFeatureEnabled: () => true });
        expect(native.length).toBeGreaterThan(0);
        offenders.push(...native.flatMap(tool => [...oversizedEnums(tool.inputSchema), ...recursiveReferences(tool.inputSchema)].map(offender => `native:${tool.name} ${offender}`)));
        expect(offenders).toEqual([]);
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
