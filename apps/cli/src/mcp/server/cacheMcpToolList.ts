import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { sessionMcpCustomToolsHandler, type SessionMcpCustomToolsBridge } from '@/mcp/runtime/sessionMcpToolsBridge';
import { unknownBuiltInHappierToolFailure } from '@/agent/tools/happierTools/dispatchBuiltInHappierTool';
import { formatHappierMcpToolFailure } from './registerHappierMcpBuiltInTools';

type McpRequestHandler = (request: unknown, extra: unknown) => unknown;

/** Install before registering tools; the SDK owns both the inventory and its change signal. */
export function cacheMcpToolList(server: McpServer, options?: Readonly<{
  sessionToolsBridge?: SessionMcpCustomToolsBridge; executionSignal?: AbortSignal; toolCallIdMetaKey?: string;
  getRegisteredToolNames?: () => readonly string[];
}>): void {
  // The SDK's generic handler signature cannot be re-declared by a wrapper; it is typed at this boundary only.
  const setRequestHandler = server.server.setRequestHandler.bind(server.server) as (schema: unknown, handler: McpRequestHandler) => void;
  let invalidate = () => {};
  server.server.setRequestHandler = ((schema: unknown, handler: McpRequestHandler) => {
    const register = (native: McpRequestHandler) => {
      const registered = schema === CallToolRequestSchema && options?.getRegisteredToolNames
        ? (request: unknown, extra: unknown) => {
          const parsed = CallToolRequestSchema.parse(request);
          return options.getRegisteredToolNames!().includes(parsed.params.name)
            ? native(request, extra)
            : formatHappierMcpToolFailure(unknownBuiltInHappierToolFailure(parsed.params.name));
        } : native;
      setRequestHandler(schema, options?.sessionToolsBridge
        ? sessionMcpCustomToolsHandler({ schema, native: registered, bridge: options.sessionToolsBridge,
          executionSignal: options.executionSignal, toolCallIdMetaKey: options.toolCallIdMetaKey }) : registered);
    };
    if (schema !== ListToolsRequestSchema) {
      register(handler);
      return;
    }
    let cached: unknown;
    invalidate = () => { cached = undefined; };
    // SDK 1.25.3 projects its live registered tools synchronously here. A
    // failed projection throws before assignment and is not cached.
    register((request, extra) => cached ??= handler(request, extra));
  }) as typeof server.server.setRequestHandler;
  const sendToolListChanged = server.sendToolListChanged.bind(server);
  server.sendToolListChanged = () => {
    invalidate();
    sendToolListChanged();
  };
}
