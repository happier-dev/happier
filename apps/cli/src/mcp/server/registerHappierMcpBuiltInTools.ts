import { listBuiltInHappierTools, type BuiltInHappierToolsSurface } from '@/agent/tools/happierTools/listBuiltInHappierTools';
import { dispatchBuiltInHappierTool } from '@/agent/tools/happierTools/dispatchBuiltInHappierTool';

type ToolRegistrar = Readonly<{
    registerTool: (name: string, meta: unknown, handler: (args: unknown) => Promise<unknown>) => void;
}>;

type DispatchDeps = Parameters<typeof dispatchBuiltInHappierTool>[0]['deps'];

export function registerHappierMcpBuiltInTools(
    server: ToolRegistrar,
    params: Readonly<{
        sessionId: string;
        surface: BuiltInHappierToolsSurface;
        deps: DispatchDeps;
        resolveSessionId?: (toolArgs: unknown) => string;
    }>,
): Readonly<{ toolNames: string[] }> {
  const enabledTools = listBuiltInHappierTools({ surface: params.surface });

    for (const tool of enabledTools) {
        server.registerTool(
            tool.name,
            {
                description: tool.description,
                title: tool.title,
                inputSchema: tool.inputSchema,
            } as any,
            async (args: unknown) => {
                try {
                    const sessionId = params.resolveSessionId ? params.resolveSessionId(args) : params.sessionId;
                    const result = await dispatchBuiltInHappierTool({
                        toolName: tool.name,
                        args,
                        sessionId,
                        surface: params.surface,
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
