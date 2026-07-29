import { listBuiltInHappierTools } from '@/agent/tools/happierTools/listBuiltInHappierTools';
import { z } from 'zod';

// Tool registration for the host-owned Happier MCP bridge.
type ToolRegistrar = Readonly<{
  registerTool: (
    name: string,
    definition: any,
    handler: (args: any, extra?: { signal?: AbortSignal }) => Promise<any>,
  ) => void;
}>;

function toBridgeSchema(schema: unknown): z.ZodType {
  if (schema instanceof z.ZodType) {
    return schema;
  }
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return z.object({}).passthrough();
  }

  // MCP discovery returns JSON Schema while the high-level MCP server accepts
  // Zod registrations. This proxy deliberately validates permissively and
  // preserves the discovered schema for presentation; the remote server is
  // the authoritative validation and execution owner.
  const adapter = z.object({}).passthrough();
  adapter._zod.processJSONSchema = (_ctx, json) => {
    Object.assign(json, schema);
  };
  return adapter;
}

export function registerHappierBridgeTools(
  server: ToolRegistrar,
  deps: Readonly<{
    callHttpTool: (
      name: string,
      args: unknown,
      options?: Readonly<{ signal?: AbortSignal }>,
    ) => Promise<any>;
    tools?: readonly Readonly<{
      name: string;
      title?: string;
      description?: string;
      inputSchema?: unknown;
      outputSchema?: unknown;
      annotations?: unknown;
      _meta?: Record<string, unknown>;
    }>[];
  }>,
): void {
  const forward = (name: string) => async (
    args: any,
    extra?: Readonly<{ signal?: AbortSignal }>,
  ) => {
    try {
      return extra?.signal === undefined
        ? await deps.callHttpTool(name, args)
        : await deps.callHttpTool(name, args, { signal: extra.signal });
    } catch (error) {
      if (extra?.signal?.aborted === true) {
        throw error;
      }
      return {
        content: [
          { type: 'text', text: `Failed to call tool ${name}: ${error instanceof Error ? error.message : String(error)}` },
        ],
        isError: true,
      };
    }
  };

  const tools = deps.tools ?? listBuiltInHappierTools({ surface: 'agent' });
  for (const tool of tools) {
    const meta = {
      description: tool.description ?? tool.title ?? tool.name,
      title: tool.title ?? tool.name,
      inputSchema: toBridgeSchema(tool.inputSchema),
      ...(tool.outputSchema === undefined ? {} : { outputSchema: toBridgeSchema(tool.outputSchema) }),
      ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
      ...(tool._meta === undefined ? {} : { _meta: tool._meta }),
    };

    server.registerTool(tool.name, meta, forward(tool.name));
  }
}
