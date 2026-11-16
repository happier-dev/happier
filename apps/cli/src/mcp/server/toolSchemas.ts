import { z } from 'zod/mini';
import { createPluginJsonSchemaZodObjectAdapter } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { zodSchemaToJsonSchemaObject, type JsonSchemaObject } from '@happier-dev/protocol/actions/actionInputJsonSchema';
import { projectActionOutputJsonSchema } from '@happier-dev/protocol/actions/actionCatalog';
import { projectActionSchemaForToolAdvertisement } from '@happier-dev/protocol/actions/actionSpecSections';
import { ActionApprovalRequestCreatedResultSchema, ActionOperationAcceptedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { HappierBuiltInToolDefinition } from '@/agent/tools/happierTools/types';
import { bindContextualActionToolInput, projectSessionBoundActionToolInputSchema } from '@/agent/tools/happierTools/actionToolContext';
import { projectMcpToolInputJsonSchema, rewriteMcpJsonSchemaReferences } from './projectMcpToolInputJsonSchema';
import { compactToolJsonSchema } from './compactToolJsonSchema';

const ACTION_APPROVAL_REQUEST_CREATED_RESULT_JSON_SCHEMA = zodSchemaToJsonSchemaObject(
    ActionApprovalRequestCreatedResultSchema,
    { target: 'draft-7' },
);

const ACTION_OPERATION_ACCEPTED_RESULT_JSON_SCHEMA = zodSchemaToJsonSchemaObject(
    ActionOperationAcceptedResultSchema,
    { target: 'draft-7' },
);

// Input presentation depends on the schema and supplied field names, never
// Session values. Keep static schema conversion out of subsequent Session starts.
const inputSchemas = new WeakMap<object, Map<string, z.ZodMiniType>>();

export function toMcpToolInputSchema(params: Readonly<{
    actionId: string | null | undefined;
    inputSchema: unknown;
    sessionId: string;
    sessionMachineId?: string | null;
    sessionRootPath?: string | null;
    contextualDefaults: HappierBuiltInToolDefinition['contextualDefaults'];
}>): z.ZodMiniType {
    const context = {
        defaultSessionId: params.sessionId,
        defaultSessionMachineId: params.sessionMachineId,
        defaultSessionRootPath: params.sessionRootPath,
    };
    const fields = params.actionId ? Object.keys(bindContextualActionToolInput({
        actionId: params.actionId, input: {}, context, contextualDefaults: params.contextualDefaults,
    }) as Record<string, unknown>).sort() : [];
    const key = JSON.stringify(fields);
    const cache = params.inputSchema && typeof params.inputSchema === 'object'
        ? inputSchemas.get(params.inputSchema) : undefined;
    const cached = cache?.get(key);
    if (cached) return cached;
    const contextualInputSchema = params.actionId
        ? projectSessionBoundActionToolInputSchema({
            actionId: params.actionId,
            inputSchema: params.inputSchema,
            context,
            // Plugin defaults travel with the admitted tool; first-party
            // defaults still resolve through the canonical Action owner.
            contextualDefaults: params.contextualDefaults,
        })
        : params.inputSchema;
    const result = toMcpToolObjectSchema(contextualInputSchema, 'inputSchema');
    if (params.inputSchema && typeof params.inputSchema === 'object') {
        const entries = cache ?? new Map<string, z.ZodMiniType>();
        entries.set(key, result);
        inputSchemas.set(params.inputSchema, entries);
    }
    return result;
}

export function toMcpToolObjectSchema(schema: unknown, field: 'inputSchema'): z.ZodMiniType;
export function toMcpToolObjectSchema(schema: unknown, field: 'outputSchema'): z.ZodMiniType | undefined;
export function toMcpToolObjectSchema(schema: unknown, field: 'inputSchema' | 'outputSchema'): z.ZodMiniType | undefined {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
        throw new Error(`Plugin tool ${field} must be a JSON Schema object`);
    }
    if (field === 'outputSchema') {
        const completed = schema instanceof z.core.$ZodType
            ? schema
            : createPluginJsonSchemaZodObjectAdapter(schema);
        const completedJsonSchema = projectActionOutputJsonSchema(completed, { target: 'draft-7', reused: 'ref' });
        if (completedJsonSchema === undefined) return undefined;
        const completedMcpJsonSchema = nestMcpOutputJsonSchema(projectActionSchemaForToolAdvertisement(completedJsonSchema));
        // Admission and approval creation are execution outcomes, separate from
        // completed output. Canonical dispatch decides which receipt is valid.
        const output = z.union([completed, ActionApprovalRequestCreatedResultSchema, ActionOperationAcceptedResultSchema]);
        const adapter = z.looseObject({}).check(z.superRefine((value, ctx) => {
            if (!output.safeParse(value).success) {
                ctx.addIssue({ code: 'custom', message: 'Value does not match the Action outputSchema' });
            }
        }));
        adapter._zod.processJSONSchema = (_ctx, json) => {
            Object.assign(json, compactToolJsonSchema({
                type: 'object',
                anyOf: [completedMcpJsonSchema, ACTION_APPROVAL_REQUEST_CREATED_RESULT_JSON_SCHEMA, ACTION_OPERATION_ACCEPTED_RESULT_JSON_SCHEMA],
            }));
        };
        return adapter;
    }
    const parser = schema instanceof z.core.$ZodType
        ? schema
        : createPluginJsonSchemaZodObjectAdapter(schema);
    const jsonSchema = projectMcpToolInputJsonSchema(zodSchemaToJsonSchemaObject(parser, { target: 'draft-7', reused: 'ref' }));
    // MCP SDK 1.25 recognizes an object definition before projecting discovery.
    // Parsing remains pass-through, including omitted/non-object arguments:
    // canonical Action dispatch owns validation and typed field repair.
    const adapter: z.ZodMiniType = z.looseObject({});
    adapter._zod.run = z.unknown()._zod.run;
    adapter._zod.processJSONSchema = (_ctx, json) => { Object.assign(json, jsonSchema); json.type = 'object'; };
    return adapter;
}

/** Document-local references still belong to the completed output after nesting it in anyOf. */
function nestMcpOutputJsonSchema(schema: JsonSchemaObject): JsonSchemaObject {
    return rewriteMcpJsonSchemaReferences(schema, ref => ref.startsWith('#') ? `#/anyOf/0${ref.slice(1)}` : ref);
}
