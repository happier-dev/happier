import { listBuiltInHappierTools } from '@/agent/tools/happierTools/listBuiltInHappierTools';

type ToolRegistrar = Readonly<{
  registerTool: (name: string, definition: any, handler: (args: any) => Promise<any>) => void;
}>;

export function registerHappierMcpBridgeTools(
  server: ToolRegistrar,
  deps: Readonly<{
    callHttpTool: (name: string, args: unknown) => Promise<any>;
  }>,
): void {
  const forward = (name: string) => async (args: any) => {
    try {
      return await deps.callHttpTool(name, args);
    } catch (error) {
      return {
        content: [
          { type: 'text', text: `Failed to call tool ${name}: ${error instanceof Error ? error.message : String(error)}` },
        ],
        isError: true,
      };
    }
  };

  for (const tool of listBuiltInHappierTools({ surface: 'session_agent' })) {
    const meta = {
      description: tool.description,
      title: tool.title,
      inputSchema: tool.inputSchema,
    };

    server.registerTool(tool.name, meta, forward(tool.name));
  }
}
