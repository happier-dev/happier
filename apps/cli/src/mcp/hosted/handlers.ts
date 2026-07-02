import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AnySchema, ZodRawShapeCompat } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type {
    McpHostedToolDefinitionV1,
    McpHostedToolResultV1,
    McpServerSpecV1,
} from '@happier-dev/plugin-sdk';
import Ajv, { type ValidateFunction } from 'ajv';
import { z } from 'zod';

import { assertHostedMcpServerRegistration } from './validation';

type SdkToolSchema = AnySchema | ZodRawShapeCompat;
type HostedInputSchemaResolution = Readonly<{
    schema: SdkToolSchema;
    native: boolean;
    validateJsonSchema?: ValidateFunction;
    invalidJsonSchema?: boolean;
}>;
type HostedOutputSchemaResolution = Readonly<{
    schema?: SdkToolSchema;
    native: boolean;
    validateJsonSchema?: ValidateFunction;
    invalidJsonSchema?: boolean;
}>;
type JsonSchemaCompilation = Readonly<{
    validateJsonSchema?: ValidateFunction;
    invalidJsonSchema?: boolean;
}>;

const HOSTED_INPUT_SCHEMA_META_KEY = 'happier.dev/hostedInputSchema';
const HOSTED_OUTPUT_SCHEMA_META_KEY = 'happier.dev/hostedOutputSchema';
const ajv = new Ajv({
    allErrors: false,
    strict: false,
});

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isZodSchemaLike(value: unknown): value is AnySchema {
    if (!isRecord(value)) {
        return false;
    }
    return '_def' in value
        || '_zod' in value
        || typeof value.parse === 'function'
        || typeof value.safeParse === 'function';
}

function isZodRawShapeLike(value: unknown): value is ZodRawShapeCompat {
    if (!isRecord(value)) {
        return false;
    }
    const fields = Object.values(value);
    return fields.length > 0 && fields.every(isZodSchemaLike);
}

function isSdkToolSchema(value: unknown): value is SdkToolSchema {
    return isZodSchemaLike(value) || isZodRawShapeLike(value);
}

function readTrimmedString(value: string | null | undefined): string | undefined {
    const trimmed = value?.trim() ?? '';
    return trimmed.length > 0 ? trimmed : undefined;
}

export function assertHostedMcpHandlerSpec(params: Readonly<{
    pluginId: string;
    spec: McpServerSpecV1;
}>): void {
    assertHostedMcpServerRegistration(params.spec, { pluginId: params.pluginId });
}

function compileJsonSchema(schema: Record<string, unknown>): JsonSchemaCompilation {
    try {
        return { validateJsonSchema: ajv.compile(schema) };
    } catch {
        return { invalidJsonSchema: true };
    }
}

function resolveInputSchema(schema: unknown): HostedInputSchemaResolution {
    if (schema === undefined) {
        return { schema: z.any(), native: false };
    }
    if (isSdkToolSchema(schema)) {
        return { schema, native: true };
    }
    if (isRecord(schema) && schema.type === 'object') {
        return {
            schema: z.object({}).passthrough(),
            native: false,
            ...compileJsonSchema(schema),
        };
    }
    return { schema: z.any(), native: false, invalidJsonSchema: true };
}

function resolveOutputSchema(schema: unknown): HostedOutputSchemaResolution {
    if (schema === undefined) {
        return { native: false };
    }
    if (isSdkToolSchema(schema)) {
        return { schema, native: true };
    }
    if (isRecord(schema) && schema.type === 'object') {
        return {
            native: false,
            ...compileJsonSchema(schema),
        };
    }
    return { native: false, invalidJsonSchema: true };
}

function mergeHostedToolMeta(tool: McpHostedToolDefinitionV1, params: Readonly<{
    inputSchemaIsNative: boolean;
    outputSchemaIsNative: boolean;
}>): Record<string, unknown> | undefined {
    const meta: Record<string, unknown> = {
        ...(tool._meta ?? {}),
    };
    if (tool.inputSchema !== undefined && !params.inputSchemaIsNative) {
        meta[HOSTED_INPUT_SCHEMA_META_KEY] = tool.inputSchema;
    }
    if (tool.outputSchema !== undefined && !params.outputSchemaIsNative) {
        meta[HOSTED_OUTPUT_SCHEMA_META_KEY] = tool.outputSchema;
    }
    return Object.keys(meta).length > 0 ? meta : undefined;
}

function sanitizeHostedToolFailure(): McpHostedToolResultV1 {
    return {
        content: [{ type: 'text', text: 'Hosted MCP tool failed' }],
        isError: true,
    };
}

function resolveToolAnnotations(tool: McpHostedToolDefinitionV1): ToolAnnotations | undefined {
    return tool.annotations ? { ...tool.annotations } : undefined;
}

function readHostedResultMeta(meta: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
    return meta ? { ...meta } : undefined;
}

function toSdkToolResult(result: McpHostedToolResultV1): CallToolResult {
    return {
        content: result.content.map((entry) => {
            return {
                type: 'text' as const,
                text: entry.text,
                ...(isRecord(entry.annotations) ? { annotations: { ...entry.annotations } } : {}),
                ...(entry._meta ? { _meta: { ...entry._meta } } : {}),
            };
        }),
        ...(isRecord(result.structuredContent) ? { structuredContent: { ...result.structuredContent } } : {}),
        ...(result.isError !== undefined ? { isError: result.isError } : {}),
        ...(result._meta ? { _meta: readHostedResultMeta(result._meta) } : {}),
    };
}

function invalidHostedToolInput(): McpHostedToolResultV1 {
    return {
        content: [{ type: 'text', text: 'Invalid MCP tool input' }],
        isError: true,
    };
}

function invalidHostedToolOutput(): McpHostedToolResultV1 {
    return {
        content: [{ type: 'text', text: 'Invalid MCP tool output' }],
        isError: true,
    };
}

export function registerHostedMcpHandlers(params: Readonly<{
    server: McpServer;
    pluginId: string;
    spec: McpServerSpecV1;
    signal: AbortSignal;
}>): void {
    assertHostedMcpHandlerSpec(params);
    for (const tool of params.spec.hosted?.tools ?? []) {
        const input = resolveInputSchema(tool.inputSchema);
        const output = resolveOutputSchema(tool.outputSchema);
        params.server.registerTool(
            tool.name,
            {
                title: readTrimmedString(tool.title),
                description: readTrimmedString(tool.description),
                inputSchema: input.schema,
                ...(output.schema ? { outputSchema: output.schema } : {}),
                annotations: resolveToolAnnotations(tool),
                _meta: mergeHostedToolMeta(tool, {
                    inputSchemaIsNative: input.native,
                    outputSchemaIsNative: output.native,
                }),
            },
            async (args: unknown) => {
                if (input.invalidJsonSchema || (input.validateJsonSchema && !input.validateJsonSchema(args ?? {}))) {
                    return toSdkToolResult(invalidHostedToolInput());
                }
                if (output.invalidJsonSchema) {
                    return toSdkToolResult(invalidHostedToolOutput());
                }
                try {
                    const result = await tool.handler(args, {
                        pluginId: params.pluginId,
                        serverId: params.spec.id,
                        toolName: tool.name,
                        signal: params.signal,
                    });
                    if (
                        !result.isError
                        && output.validateJsonSchema
                        && !output.validateJsonSchema(result.structuredContent ?? {})
                    ) {
                        return toSdkToolResult(invalidHostedToolOutput());
                    }
                    return toSdkToolResult(result);
                } catch {
                    return toSdkToolResult(sanitizeHostedToolFailure());
                }
            },
        );
    }
}
