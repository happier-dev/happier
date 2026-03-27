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
                const sessionId = params.resolveSessionId ? params.resolveSessionId(args) : params.sessionId;
                const result = await dispatchBuiltInHappierTool({
                    toolName: tool.name,
                    args,
                    sessionId,
                    surface: params.surface,
                    deps: params.deps,
                });

                return result.ok
                    ? {
                          content: [{ type: 'text' as const, text: JSON.stringify(result.result) }],
                          isError: false as const,
                      }
                    : {
                          content: [{ type: 'text' as const, text: JSON.stringify({ errorCode: result.errorCode, error: result.error }) }],
                          isError: true as const,
                      };
            },
        );
    }

    return { toolNames: enabledTools.map((tool) => tool.name) };
}
