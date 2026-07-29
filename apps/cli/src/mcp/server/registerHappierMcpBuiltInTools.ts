import { listBuiltInHappierTools, type BuiltInHappierToolsSurface } from '@/agent/tools/happierTools/listBuiltInHappierTools';
import { dispatchBuiltInHappierTool } from '@/agent/tools/happierTools/dispatchBuiltInHappierTool';
import {
    actionAcceptsContextualSessionId,
    createPluginJsonSchemaZodObjectAdapter,
    type ActionsSettingsV1,
    type ApprovalRequestOriginV1,
} from '@happier-dev/protocol';
import { createActionToolNameToIdMap } from '@/agent/tools/happierTools/actionToolCatalog';
import type { HappierBuiltInToolDefinition } from '@/agent/tools/happierTools/types';
import { z } from 'zod';
import type { ProjectedPluginToolCatalogEntry } from '@/plugins/runtime/toolCatalog';

type ToolRegistrar = Readonly<{
    registerTool: (name: string, meta: unknown, handler: (args: unknown, extra?: unknown) => Promise<unknown>) => void;
}>;

type DispatchDeps = Parameters<typeof dispatchBuiltInHappierTool>[0]['deps'];

function buildSessionAgentApprovalOrigin(params: Readonly<{
    surface: BuiltInHappierToolsSurface;
    sessionId: string;
    toolName: string;
    extra: unknown;
}>): ApprovalRequestOriginV1 | null {
    if (params.surface !== 'agent') return null;
    const rawRequestId = (params.extra as { requestId?: unknown } | null | undefined)?.requestId;
    const requestId =
        typeof rawRequestId === 'string' || typeof rawRequestId === 'number'
            ? String(rawRequestId).trim()
            : '';
    return {
        kind: 'transcript_tool_call',
        sessionId: params.sessionId,
        ...(requestId ? { toolCallId: requestId, mcpRequestId: requestId } : {}),
        toolName: params.toolName,
    };
}

function withOptionalContextualSessionIdInputSchema(actionId: string | null | undefined, inputSchema: unknown): unknown {
    if (!actionId || !actionAcceptsContextualSessionId(actionId) || !(inputSchema instanceof z.ZodObject)) {
        return inputSchema;
    }

    const shape = inputSchema.shape as Record<string, z.ZodTypeAny>;
    if (!Object.prototype.hasOwnProperty.call(shape, 'sessionId')) {
        return inputSchema;
    }

    return inputSchema.safeExtend({
        sessionId: shape.sessionId.optional(),
    });
}

function toMcpToolInputSchema(actionId: string | null | undefined, inputSchema: unknown): z.ZodType {
    const contextualInputSchema = withOptionalContextualSessionIdInputSchema(actionId, inputSchema);
    return toMcpToolObjectSchema(contextualInputSchema, 'inputSchema');
}

function toMcpToolObjectSchema(schema: unknown, field: 'inputSchema' | 'outputSchema'): z.ZodType {
    if (schema instanceof z.ZodType) {
        return schema;
    }
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
        throw new Error(`Plugin tool ${field} must be a JSON Schema object`);
    }

    // External plugin declarations use the protocol-owned bounded JSON Schema
    // vocabulary. The MCP SDK accepts Zod at registration, so use the protocol
    // owner's presentation adapter; daemon action execution remains the
    // authoritative validation and dispatch owner.
    return createPluginJsonSchemaZodObjectAdapter(schema);
}

function buildPluginToolMcpMeta(tool: HappierBuiltInToolDefinition): Record<string, unknown> | undefined {
    if (!tool.toolId || !tool.actionId || !tool.safety) return undefined;
    return {
        'happier.dev/pluginTool': {
            toolId: tool.toolId,
            actionId: tool.actionId,
            safety: tool.safety,
            ...(tool.inputHints === undefined ? {} : { inputHints: tool.inputHints }),
            ...(tool.examples === undefined ? {} : { examples: tool.examples }),
            ...(tool.promptSnippet === undefined ? {} : { promptSnippet: tool.promptSnippet }),
            ...(tool.promptGuidelines === undefined ? {} : { promptGuidelines: tool.promptGuidelines }),
            ...(tool.availability === undefined ? {} : { availability: tool.availability }),
        },
    };
}

function resolveMcpToolAnnotations(tool: HappierBuiltInToolDefinition): unknown {
    if (tool.annotations !== undefined) {
        return tool.annotations;
    }
    return tool.safety === undefined
        ? undefined
        : { destructiveHint: tool.safety === 'danger' };
}

function stringifyMcpToolTextPayload(value: unknown): string {
    const text = JSON.stringify(value);
    return typeof text === 'string' ? text : 'null';
}

export function registerHappierMcpBuiltInTools(
    server: ToolRegistrar,
    params: Readonly<{
        sessionId: string;
        surface: BuiltInHappierToolsSurface;
        actionsSettings?: ActionsSettingsV1 | null;
        getActionsSettings?: (() => ActionsSettingsV1 | null) | null;
        pluginToolCatalog?: readonly ProjectedPluginToolCatalogEntry[];
        deps: DispatchDeps;
        resolveSessionId?: (toolArgs: unknown) => string;
    }>,
): Readonly<{ toolNames: string[] }> {
    // This registrar intentionally exposes first-party built-in Happier tools.
    // Plugin-contributed direct tools use the ActionSpec/tool projection path.
    const isActionEnabled = params.deps.isActionEnabled ?? (() => true);
    const readActionsSettings = () => params.getActionsSettings?.() ?? params.actionsSettings ?? null;
    const actionsSettings = readActionsSettings();
    const enabledTools = listBuiltInHappierTools({
        surface: params.surface,
        isActionEnabled,
        actionsSettings,
        pluginToolCatalog: params.pluginToolCatalog,
    });
    const actionToolNameToId = createActionToolNameToIdMap({
        surface: params.surface,
        isActionEnabled,
        actionsSettings,
        pluginToolCatalog: params.pluginToolCatalog,
    });

    for (const tool of enabledTools) {
        const actionId = actionToolNameToId.get(tool.name) ?? null;
        const pluginToolMcpMeta = buildPluginToolMcpMeta(tool);
        const annotations = resolveMcpToolAnnotations(tool);
        server.registerTool(
            tool.name,
            {
                description: tool.description,
                title: tool.title,
                inputSchema: toMcpToolInputSchema(actionId, tool.inputSchema),
                ...(tool.outputSchema === undefined ? {} : {
                    outputSchema: toMcpToolObjectSchema(tool.outputSchema, 'outputSchema'),
                }),
                ...(annotations === undefined ? {} : { annotations }),
                ...(pluginToolMcpMeta === undefined ? {} : { _meta: pluginToolMcpMeta }),
            },
            async (args: unknown, extra?: unknown) => {
                try {
                    const sessionId = params.resolveSessionId ? params.resolveSessionId(args) : params.sessionId;
                    const approvalOrigin = buildSessionAgentApprovalOrigin({
                        surface: params.surface,
                        sessionId,
                        toolName: tool.name,
                        extra,
                    });
                    const currentActionsSettings = readActionsSettings();
                    const result = await dispatchBuiltInHappierTool({
                        toolName: tool.name,
                        args,
                        sessionId,
                        surface: params.surface,
                        actionsSettings: currentActionsSettings,
                        getActionsSettings: readActionsSettings,
                        pluginToolCatalog: params.pluginToolCatalog,
                        ...(approvalOrigin ? { approvalOrigin } : {}),
                        deps: params.deps,
                    });

                    if (result.ok) {
                        return {
                            content: [{ type: 'text' as const, text: stringifyMcpToolTextPayload(result.result) }],
                            ...(tool.outputSchema === undefined ? {} : { structuredContent: result.result }),
                            isError: false as const,
                        };
                    }

                    return {
                        content: [{
                            type: 'text' as const,
                            text: JSON.stringify({
                                errorCode: result.errorCode,
                                error: result.error,
                                ...(result.details === undefined ? {} : { details: result.details }),
                            }),
                        }],
                        isError: true as const,
                    };
                } catch (error) {
                    const errorText = error instanceof Error ? error.message : String(error);
                    let payload = '{"errorCode":"tool_failed","error":"tool_failed"}';
                    try {
                        payload = JSON.stringify({ errorCode: 'tool_failed', error: errorText });
                    } catch {
                        // ignore
                    }
                    return {
                        content: [{ type: 'text' as const, text: payload }],
                        isError: true as const,
                    };
                }
            },
        );
    }

    return { toolNames: enabledTools.map((tool) => tool.name) };
}
