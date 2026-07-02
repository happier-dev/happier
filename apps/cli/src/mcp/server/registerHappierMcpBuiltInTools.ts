import { listBuiltInHappierTools, type BuiltInHappierToolsSurface } from '@/agent/tools/happierTools/listBuiltInHappierTools';
import { dispatchBuiltInHappierTool } from '@/agent/tools/happierTools/dispatchBuiltInHappierTool';
import type { ActionsSettingsV1, ApprovalRequestOriginV1 } from '@happier-dev/protocol';

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
    if (params.surface !== 'session_agent') return null;
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

export function registerHappierMcpBuiltInTools(
    server: ToolRegistrar,
    params: Readonly<{
        sessionId: string;
        surface: BuiltInHappierToolsSurface;
        actionsSettings?: ActionsSettingsV1 | null;
        deps: DispatchDeps;
        resolveSessionId?: (toolArgs: unknown) => string;
    }>,
): Readonly<{ toolNames: string[] }> {
    // This registrar intentionally exposes first-party built-in Happier tools.
    // Plugin-contributed direct tools use the ActionSpec/tool projection path.
    const enabledTools = listBuiltInHappierTools({
        surface: params.surface,
        isActionEnabled: params.deps.isActionEnabled ?? (() => true),
        actionsSettings: params.actionsSettings ?? null,
    });

    for (const tool of enabledTools) {
        server.registerTool(
            tool.name,
            {
                description: tool.description,
                title: tool.title,
                inputSchema: tool.inputSchema,
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
                    const result = await dispatchBuiltInHappierTool({
                        toolName: tool.name,
                        args,
                        sessionId,
                        surface: params.surface,
                        actionsSettings: params.actionsSettings ?? null,
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
                        content: [{ type: 'text' as const, text: JSON.stringify({ errorCode: result.errorCode, error: result.error }) }],
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
