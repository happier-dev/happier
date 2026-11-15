import type { ResolvedCustomHappierTool, ResolvedCustomHappierToolWarning } from '@/agent/tools/happierTools/customMcp/listResolvedCustomHappierTools';
import type { callResolvedCustomHappierTool } from '@/agent/tools/happierTools/customMcp/callResolvedCustomHappierTool';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, ListToolsResultSchema, McpError, ToolSchema } from '@modelcontextprotocol/sdk/types.js';
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { RequestMeta } from '@modelcontextprotocol/sdk/types.js';
import { McpServerCatalogUnavailableError } from '@/mcp/servers/readMcpServersSettingsFromAccountSettings';
import { SESSION_MCP_TOOL_SOURCES_META_KEY, SESSION_MCP_TOOL_SOURCE_META_KEY,
  SESSION_MCP_TOOL_WARNINGS_META_KEY } from './sessionMcpLocalContext';

export { SESSION_MCP_TOOL_SOURCES_META_KEY, SESSION_MCP_TOOL_SOURCE_META_KEY,
  SESSION_MCP_TOOL_WARNINGS_META_KEY, SESSION_MCP_ACTION_REQUEST_ID_META_KEY } from './sessionMcpLocalContext';

export function readSessionMcpToolCallId(metadata: Readonly<Record<string, unknown>> | undefined, nativeKey?: string): string | undefined {
  const nativeId = nativeKey ? metadata?.[nativeKey] : undefined;
  if (typeof nativeId === 'string' && nativeId.trim()) return nativeId.trim();
  const bridgeId = metadata?.['happier/tool-call-id'];
  return typeof bridgeId === 'string' && bridgeId.trim() ? bridgeId.trim() : undefined;
}

/** Host-owned selected MCP profile. Agent clients never receive its credentials. */
export type SessionMcpCustomToolsBridge = Readonly<{
  list: (signal?: AbortSignal) => Promise<Readonly<{
    tools: readonly ResolvedCustomHappierTool[];
    warnings: readonly ResolvedCustomHappierToolWarning[];
  }>>;
  call: (input: Readonly<{ source: string; toolName: string; args: unknown; toolCallId?: string;
    requestMetadata?: RequestMeta; onprogress?: RequestOptions['onprogress'] }>, signal?: AbortSignal) => ReturnType<typeof callResolvedCustomHappierTool>;
}>;

type McpHandler = (request: unknown, extra: unknown) => unknown;

async function invokeSelectedProfile<Result>(operation: () => Promise<Result>): Promise<Result> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof McpServerCatalogUnavailableError) {
      throw new McpError(ErrorCode.InternalError, 'MCP server catalog is unavailable', { errorCode: error.code });
    }
    throw error;
  }
}

/** Extends the SDK's existing handlers, never a second registry or native catalog. */
export function sessionMcpCustomToolsHandler(input: Readonly<{
  schema: unknown; native: McpHandler; bridge: SessionMcpCustomToolsBridge;
  executionSignal?: AbortSignal; toolCallIdMetaKey?: string;
}>): McpHandler {
  if (input.schema === ListToolsRequestSchema) return async (request, extra) => {
    const parsed = ListToolsRequestSchema.parse(request);
    const marker = parsed.params?._meta?.[SESSION_MCP_TOOL_SOURCES_META_KEY];
    if (marker === undefined) return input.native(request, extra);
    if (marker !== true) throw new McpError(ErrorCode.InvalidParams, 'Invalid Session tool source selection');
    const native = ListToolsResultSchema.parse(await input.native(request, extra));
    const signal = readRequestSignal(extra);
    const custom = await invokeSelectedProfile(() => input.bridge.list(signal));
    return { ...native, tools: [...native.tools, ...custom.tools.map(tool => ToolSchema.parse({
      name: tool.name, description: tool.description, inputSchema: tool.inputSchema ?? { type: 'object' },
      _meta: { [SESSION_MCP_TOOL_SOURCE_META_KEY]: tool.source },
    }))], _meta: { ...native._meta, [SESSION_MCP_TOOL_WARNINGS_META_KEY]: custom.warnings } };
  };
  if (input.schema !== CallToolRequestSchema) return input.native;
  return async (request, extra) => {
    const parsed = CallToolRequestSchema.parse(request);
    const source = parsed.params._meta?.[SESSION_MCP_TOOL_SOURCE_META_KEY];
    if (source === undefined) return input.native(request, extra);
    if (typeof source !== 'string' || !source || source !== source.trim()) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid Session tool source');
    }
    const requestSignal = readRequestSignal(extra);
    const signal = input.executionSignal && requestSignal
      ? AbortSignal.any([input.executionSignal, requestSignal]) : input.executionSignal ?? requestSignal;
    signal?.throwIfAborted();
    const metadata = { ...parsed.params._meta };
    delete metadata[SESSION_MCP_TOOL_SOURCE_META_KEY];
    const toolCallId = readSessionMcpToolCallId(metadata, input.toolCallIdMetaKey);
    const progressToken = metadata.progressToken;
    const sendNotification = extra && typeof extra === 'object'
      && 'sendNotification' in extra && typeof extra.sendNotification === 'function'
      ? extra.sendNotification : undefined;
    const onprogress: RequestOptions['onprogress'] = sendNotification
      && (typeof progressToken === 'string' || typeof progressToken === 'number')
      ? async progress => {
        // SDK handler extras are an external boundary; retain its typed wire notification.
        await sendNotification({ method: 'notifications/progress', params: { ...progress, progressToken } });
      } : undefined;
    const outcome = source === 'happier'
      ? { ok: false as const, errorCode: 'server_not_found', error: 'Unknown MCP server source.' }
      : await invokeSelectedProfile(() => input.bridge.call({ source, toolName: parsed.params.name, args: parsed.params.arguments,
        ...(typeof toolCallId === 'string' && toolCallId.trim() ? { toolCallId: toolCallId.trim() } : {}),
        ...(Object.keys(metadata).length ? { requestMetadata: metadata } : {}),
        ...(onprogress ? { onprogress } : {}),
      }, signal));
    return { content: [{ type: 'text', text: JSON.stringify(outcome) }], structuredContent: outcome, isError: !outcome.ok };
  };
}

function readRequestSignal(extra: unknown): AbortSignal | undefined {
  return extra && typeof extra === 'object' && 'signal' in extra && extra.signal instanceof AbortSignal
    ? extra.signal : undefined;
}
