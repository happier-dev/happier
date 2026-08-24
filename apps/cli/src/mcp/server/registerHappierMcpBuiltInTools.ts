import { listBuiltInHappierTools, type BuiltInHappierToolsSurface } from '@/agent/tools/happierTools/listBuiltInHappierTools';
import { dispatchBuiltInHappierTool } from '@/agent/tools/happierTools/dispatchBuiltInHappierTool';
import type { ActionsSettingsV1, ApprovalRequestOriginV1 } from '@happier-dev/protocol';
import { getEquivalentActionIdForBuiltInTool } from '@/agent/tools/happierTools/actionToolCatalog';
import { projectContextualActionToolInputSchema } from '@/agent/tools/happierTools/contextualActionToolInput';

type ToolRegistrar = Readonly<{
    registerTool: (name: string, meta: unknown, handler: (args: unknown, extra?: unknown) => Promise<unknown>) => void;
}>;

type DispatchDeps = Parameters<typeof dispatchBuiltInHappierTool>[0]['deps'];

function normalizeString(value: unknown): string | null {
    const normalized = typeof value === 'string' || typeof value === 'number'
        ? String(value).trim()
        : '';
    return normalized || null;
}

function buildApprovalOrigin(params: Readonly<{
    surface: BuiltInHappierToolsSurface;
    sessionId: string;
    toolName: string;
    extra: unknown;
}>): ApprovalRequestOriginV1 | null {
    if (params.surface !== 'session_agent') return null;
    const sessionId = params.sessionId.trim();
    if (!sessionId) return null;

    const extraRecord = params.extra && typeof params.extra === 'object' ? params.extra as Record<string, unknown> : {};
    const mcpRequestId = normalizeString(extraRecord.requestId);
    return {
        kind: 'transcript_tool_call',
        sessionId,
        ...(mcpRequestId ? { toolCallId: mcpRequestId, mcpRequestId } : {}),
        toolName: params.toolName,
    };
}

export function registerHappierMcpBuiltInTools(
    server: ToolRegistrar,
    params: Readonly<{
        sessionId: string;
        defaultSessionMachineId?: string | null;
        surface: BuiltInHappierToolsSurface;
        actionsSettings?: ActionsSettingsV1 | null;
        getActionsSettings?: (() => ActionsSettingsV1 | null) | null;
        deps: DispatchDeps;
        resolveSessionId?: (toolArgs: unknown) => string;
    }>,
): Readonly<{ toolNames: string[] }> {
    const isActionEnabled = params.deps.isActionEnabled ?? (() => true);
    const readActionsSettings = () => params.getActionsSettings?.() ?? params.actionsSettings ?? null;
    const enabledTools = listBuiltInHappierTools({
        surface: params.surface,
        isActionEnabled,
        actionsSettings: readActionsSettings(),
    });

    for (const tool of enabledTools) {
        const actionId = getEquivalentActionIdForBuiltInTool(tool.name);
        const inputSchema = projectContextualActionToolInputSchema({
            actionId,
            inputSchema: tool.inputSchema,
            context: {
                defaultSessionId: params.sessionId,
                defaultSessionMachineId: params.defaultSessionMachineId ?? null,
            },
        });
        server.registerTool(
            tool.name,
            {
                description: tool.description,
                title: tool.title,
                inputSchema,
            },
            async (args: unknown, extra?: unknown) => {
                try {
                    const sessionId = params.resolveSessionId ? params.resolveSessionId(args) : params.sessionId;
                    const approvalOrigin = buildApprovalOrigin({
                        surface: params.surface,
                        sessionId,
                        toolName: tool.name,
                        extra,
                    });
                    const result = await dispatchBuiltInHappierTool({
                        toolName: tool.name,
                        args,
                        sessionId,
                        surface: params.surface,
                        actionsSettings: readActionsSettings(),
                        getActionsSettings: readActionsSettings,
                        ...(approvalOrigin ? { approvalOrigin } : {}),
                        deps: params.deps,
                    });

                    if (result.ok) {
                        return {
                            content: [{ type: 'text' as const, text: JSON.stringify(result.result) }],
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
