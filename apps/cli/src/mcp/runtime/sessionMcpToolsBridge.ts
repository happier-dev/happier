import type { ResolvedCustomHappierTool, ResolvedCustomHappierToolWarning } from '@/agent/tools/happierTools/customMcp/listResolvedCustomHappierTools';
import type { callResolvedCustomHappierTool } from '@/agent/tools/happierTools/customMcp/callResolvedCustomHappierTool';
import { CallToolRequestSchema, CallToolResultSchema, ErrorCode, ListToolsRequestSchema, ListToolsResultSchema, McpError, ProgressSchema, ToolSchema } from '@modelcontextprotocol/sdk/types.js';
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { RequestMeta } from '@modelcontextprotocol/sdk/types.js';
import { McpServerCatalogUnavailableError } from '@/mcp/servers/readMcpServersSettingsFromAccountSettings';
import { CredentialRequestRedirectError } from '@happier-dev/cli-common/homeTarget';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { callMcpToolWithResolvedTimeout } from '@/mcp/mcpToolCallRequestOptions';
import { RemoteMcpAuthenticationRequiredError } from '@/mcp/bridges/remoteMcpAuthenticationFailure';
import { createSessionCustomMcpClientPool, type SessionCustomMcpConnection } from '@/agent/tools/happierTools/customMcp/sessionCustomMcpClientPool';
import { normalizeMcpServerWireKeyV1 } from '@happier-dev/protocol/mcp/servers/tools/mcpToolIdentityV1';
import { isExposedCustomMcpTool, projectDiscoveredCustomMcpTools, type CustomMcpDiscoverySettings } from '@/agent/tools/happierTools/customMcp/listResolvedCustomHappierTools';
import { mapWithConcurrency } from '@/utils/async/mapWithConcurrency';
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
  /** Computed once by the Session profile owner. */
  codeMode?: Readonly<{ bootstrap: boolean; scriptRunner: boolean }>;
  list: (signal?: AbortSignal) => Promise<Readonly<{
    tools: readonly ResolvedCustomHappierTool[];
    warnings: readonly ResolvedCustomHappierToolWarning[];
  }>>;
  describe?: (source: string, name: string, signal?: AbortSignal) => Promise<ResolvedCustomHappierTool | undefined>;
  call: (input: Readonly<{ source: string; toolName: string; args: unknown; toolCallId?: string;
    requestMetadata?: RequestMeta; onprogress?: RequestOptions['onprogress'] }>, signal?: AbortSignal) => ReturnType<typeof callResolvedCustomHappierTool>;
}>;

export type SessionCustomMcpServer = Readonly<{
  id: string;
  source: string;
  connection: SessionCustomMcpConnection;
  settings?: CustomMcpDiscoverySettings;
}>;

type CustomCallInput = Parameters<SessionMcpCustomToolsBridge['call']>[0];
type CustomCallResult = Awaited<ReturnType<SessionMcpCustomToolsBridge['call']>>;
const permissionDenied = { ok: false, errorCode: 'permission_denied', error: 'Tool execution was not approved.' } as const;
type CustomCallAdmission = Extract<CustomCallResult, { ok: false }> | Readonly<{
  ok: true;
  recordUsage?: (startMs: number, endMs: number) => void;
}>;
// Each unsnapshotted probe can open an external process. Bound the number
// opened concurrently by one discovery request.
const MCP_DISCOVERY_PROBE_CONCURRENCY = 4;

export function createSessionMcpCustomToolsBridge(input: Readonly<{
  pool: ReturnType<typeof createSessionCustomMcpClientPool>;
  readServers: () => ReadonlyMap<string, SessionCustomMcpServer>;
  authorize: (request: CustomCallInput, signal: AbortSignal) => Promise<CustomCallAdmission>;
  isConfined: () => boolean;
}>): SessionMcpCustomToolsBridge {
  const probes = new Map<string, Promise<readonly ResolvedCustomHappierTool[]>>();
  function raceSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      promise.then(
        value => { signal.removeEventListener("abort", onAbort); resolve(value); },
        error => { signal.removeEventListener("abort", onAbort); reject(error); },
      );
    });
  }
  function probe(server: SessionCustomMcpServer, signal: AbortSignal): Promise<readonly ResolvedCustomHappierTool[]> {
    let pending = probes.get(server.id);
    if (!pending) {
      const poolSignal = input.pool.signal;
      pending = (async () => {
        const entry = await input.pool.get(server.id, server.connection);
        const tools: ResolvedCustomHappierTool[] = [];
        let cursor: string | undefined;
        try {
          do {
            const result = await entry.client.listTools(cursor ? { cursor } : undefined, { signal: poolSignal });
            const exposed = result.tools.filter(tool => isExposedCustomMcpTool(server.settings?.tools, tool.name));
            const page = ListToolsResultSchema.parse(entry.redactOutput({ tools: exposed }, ListToolsResultSchema));
            tools.push(...page.tools.map(tool => ({ ...tool, source: server.source })));
            cursor = result.nextCursor;
          } while (cursor);
        } catch (error) {
          throw entry.redactError(error);
        }
        return tools;
      })();
      probes.set(server.id, pending);
      void pending.catch(() => { if (probes.get(server.id) === pending) probes.delete(server.id); });
    }
    return raceSignal(pending, signal);
  }
  const findServer = (source: string) => {
    const servers = input.readServers();
    return servers.get(source) ?? servers.get(normalizeMcpServerWireKeyV1(source));
  };
  return {
    async list(signal) {
      const active = await input.pool.admit(signal);
      if (input.isConfined()) return { tools: [], warnings: [] };
      const entries = await mapWithConcurrency([...input.readServers().values()], MCP_DISCOVERY_PROBE_CONCURRENCY, async server => {
        try {
          const tools = server.settings?.toolsSnapshot
            ? projectDiscoveredCustomMcpTools(server.source, server.settings.toolsSnapshot.tools, server.settings.tools)
            : await probe(server, active);
          return { tools };
        } catch (error) {
          active.throwIfAborted();
          if (error instanceof PluginError) throw error;
          return { warning: { source: server.source, error: error instanceof Error ? error.message : String(error) } };
        }
      });
      active.throwIfAborted();
      return {
        tools: entries.flatMap(entry => entry.tools ?? []),
        warnings: entries.flatMap(entry => entry.warning ? [entry.warning] : []),
      };
    },
    async describe(source, name, signal) {
      const active = await input.pool.admit(signal);
      const server = findServer(source);
      if (!server || input.isConfined() || !isExposedCustomMcpTool(server.settings?.tools, name)) return undefined;
      return (await probe(server, active)).find(tool => tool.name === name);
    },
    async call(request, signal) {
      const active = await input.pool.admit(signal);
      const server = findServer(request.source);
      if (!server) return { ok: false, errorCode: 'server_not_found', error: 'Unknown MCP server source.' };
      if (input.isConfined() || !isExposedCustomMcpTool(server.settings?.tools, request.toolName)) return permissionDenied;
      const admission = await input.authorize({ ...request, source: server.source }, active);
      if (!admission.ok) return admission;
      active.throwIfAborted();
      let entry: Awaited<ReturnType<typeof input.pool.get>> | undefined;
      try {
        entry = await input.pool.get(server.id, server.connection);
        const startMs = admission.recordUsage ? Date.now() : 0;
        const result = await callMcpToolWithResolvedTimeout({
          client: entry.client, toolName: request.toolName, args: request.args,
          signal: active, requestMetadata: request.requestMetadata,
          onprogress: request.onprogress && (progress => request.onprogress!(ProgressSchema.parse(entry!.redactOutput(progress, ProgressSchema)))),
        });
        admission.recordUsage?.(startMs, Date.now());
        return { ok: true, result: CallToolResultSchema.parse(entry.redactOutput(result, CallToolResultSchema)) };
      } catch (error) {
        active.throwIfAborted();
        if (error instanceof PluginError) throw error;
        const safe = entry?.redactError(error) ?? error;
        const errorCode = safe instanceof RemoteMcpAuthenticationRequiredError ? safe.data.code
          : safe instanceof CredentialRequestRedirectError ? safe.code
          : safe instanceof Error && 'code' in safe && safe.code === 'mcp_resource_mismatch' ? safe.code
          : 'tool_call_failed';
        return { ok: false, errorCode, error: safe instanceof Error ? safe.message : String(safe) };
      }
    },
  };
}

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
