import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  CallToolRequestSchema, ListToolsRequestSchema,
  ListResourcesRequestSchema, ReadResourceRequestSchema, ListResourceTemplatesRequestSchema,
  SubscribeRequestSchema, UnsubscribeRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { forwardHappierBridgeTool } from './registerHappierBridgeTools';
import { callMcpToolWithResolvedTimeout } from '@/mcp/mcpToolCallRequestOptions';
import { isMcpToolNameAlias, projectMcpToolNames } from '@/mcp/runtime/projectMcpToolNames';

/** `call` executes a tool (it inherits turn cancellation); `read` is discovery or resources. */
export type ForwardingMcpUpstreamKind = 'call' | 'read';
/** Runs one upstream operation; the owner decides whether the upstream is shared or per request. */
export type ForwardingMcpUpstream = <T>(operation: (client: Client) => Promise<T>, kind: ForwardingMcpUpstreamKind) => Promise<T>;

/**
 * The MCP server an Agent talks to, forwarding discovery and calls to the Session's upstream
 * MCP server: the public `happier-mcp --url` bridge (HTTP upstream) and the session host's
 * relay endpoint (in-process upstream). Tool names are projected to the Agent's name budget
 * (`toolNameMaxLength`) and aliases resolved back here, so the upstream keeps real names.
 */
export function createForwardingMcpServer(input: Readonly<{
  upstream: ForwardingMcpUpstream;
  toolNameMaxLength?: number;
  /** Forward resources to the upstream (the Session owns its catalog and subscriptions). */
  forwardResources: boolean;
}>): McpServer {
  const { upstream, toolNameMaxLength } = input;
  if (toolNameMaxLength !== undefined) projectMcpToolNames([], toolNameMaxLength);
  const server = new McpServer({ name: 'Happier MCP Bridge', version: '1.0.0' });
  // Initialize without an upstream round trip; discovery and execution still go upstream.
  server.server.registerCapabilities({ tools: { listChanged: false } });
  server.server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
    const result = await upstream(client => client.listTools(request.params, { signal: extra.signal }), 'read');
    const names = projectMcpToolNames(result.tools.map(tool => tool.name), toolNameMaxLength);
    return { ...result, tools: result.tools.map((tool, index) => ({ ...tool, name: names[index]!.projectedName })) };
  });
  server.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    let originalName = request.params.name;
    if (toolNameMaxLength !== undefined && isMcpToolNameAlias(originalName)) {
      const originalNames = await upstream(async client => {
        const names: string[] = [];
        let cursor: string | undefined;
        do {
          const page = await client.listTools(cursor === undefined ? {} : { cursor }, { signal: extra.signal });
          names.push(...page.tools.map(tool => tool.name));
          cursor = page.nextCursor;
        } while (cursor !== undefined);
        return names;
      }, 'read');
      const match = projectMcpToolNames(originalNames, toolNameMaxLength).find(tool => tool.projectedName === request.params.name);
      if (!match) throw new Error('MCP transport tool is no longer advertised');
      originalName = match.originalName;
    }
    return await forwardHappierBridgeTool(originalName, request.params.arguments, extra,
      async (name, args, options) => await upstream(client => callMcpToolWithResolvedTimeout({
        client,
        toolName: name,
        args,
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
        ...(options?.requestMetadata === undefined ? {} : { requestMetadata: options.requestMetadata }),
        ...(options?.onprogress === undefined ? {} : { onprogress: options.onprogress }),
      }), 'call'));
  });
  if (input.forwardResources) {
    server.server.registerCapabilities({ resources: { subscribe: true, listChanged: true } });
    server.server.setRequestHandler(ListResourcesRequestSchema, async (request, extra) =>
      await upstream(client => client.listResources(request.params, { signal: extra.signal }), 'read'));
    server.server.setRequestHandler(ReadResourceRequestSchema, async (request, extra) =>
      await upstream(client => client.readResource(request.params, { signal: extra.signal }), 'read'));
    server.server.setRequestHandler(ListResourceTemplatesRequestSchema, async (request, extra) =>
      await upstream(client => client.listResourceTemplates(request.params, { signal: extra.signal }), 'read'));
    server.server.setRequestHandler(SubscribeRequestSchema, async (request, extra) =>
      await upstream(client => client.subscribeResource(request.params, { signal: extra.signal }), 'read'));
    server.server.setRequestHandler(UnsubscribeRequestSchema, async (request, extra) =>
      await upstream(client => client.unsubscribeResource(request.params, { signal: extra.signal }), 'read'));
  }
  return server;
}
