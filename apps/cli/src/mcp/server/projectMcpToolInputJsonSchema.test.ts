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

describe('MCP provider enum projection', () => {
    it('keeps every exported MCP tool input within the provider enum thresholds', () => {
        const offenders = HAPPIER_BUILT_IN_TOOLS.flatMap(tool => {
            const schema = zodSchemaToJsonSchemaObject(toMcpToolObjectSchema(tool.inputSchema, 'inputSchema'));
            return oversizedEnums(schema).map(offender => `${tool.name} ${offender}`);
        });
        const native = resolveSessionNativeToolDescriptors({ accountSettings: {}, sessionId: 'enum-session',
            happierToolsEnabled: true, memoryRecallGuidanceEnabled: true, sessionMemoryEnabled: true,
            isServerFeatureEnabled: () => true });
        expect(native.length).toBeGreaterThan(0);
        offenders.push(...native.flatMap(tool => oversizedEnums(tool.inputSchema).map(offender => `native:${tool.name} ${offender}`)));
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
