import { CallToolResultSchema, McpError, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod/mini';
import type { ActionExecutorContext } from '@happier-dev/protocol';
import { SESSION_TOOLS_CALL_ACTION_ID_V1, SESSION_TOOLS_DESCRIBE_ACTION_ID_V1, SESSION_TOOLS_SEARCH_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { SessionToolsCallOutputV1Schema, SessionToolsSearchOutputV1Schema } from '@happier-dev/protocol/actions/specs/sessionTools';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';

import { callMcpToolWithResolvedTimeout } from '@/mcp/mcpToolCallRequestOptions';
import { logger } from '@/ui/logger';
import type { connectSessionMcpClient } from '@/mcp/runtime/sessionMcpLocalClient';
import { SESSION_MCP_CONTEXT_FILE_ENV, sessionActionTransportUnavailable, SessionMcpUnavailableError, type SessionMcpAgentContext,
  SESSION_MCP_ACTION_REQUEST_ID_META_KEY, SESSION_MCP_TOOL_SOURCES_META_KEY,
  SESSION_MCP_CODE_MODE_CAPABILITY, SESSION_MCP_TOOL_SOURCE_META_KEY, SESSION_MCP_TOOL_WARNINGS_META_KEY } from '@/mcp/runtime/sessionMcpLocalContext';
import type { ScriptToolOperation } from './toolsRun';

const failureSchema = z.object({ ...ActionExecuteFailureSchema.shape,
  candidates: z.optional(z.array(z.string())) });
const customResultSchema = z.union([z.object({ ok: z.literal(true), result: z.unknown() }), failureSchema]);
const warningsSchema = z.array(z.object({ source: z.string(), error: z.string() }));

type ToolFailure = z.infer<typeof failureSchema>;
type ToolResult = Readonly<{ ok: true; result: unknown }> | ToolFailure;
type SessionMcpConnection = Awaited<ReturnType<typeof connectSessionMcpClient>>;

export const SESSION_TOOL_OPERATION_IDS = {
  search: SESSION_TOOLS_SEARCH_ACTION_ID_V1,
  describe: SESSION_TOOLS_DESCRIBE_ACTION_ID_V1,
  call: SESSION_TOOLS_CALL_ACTION_ID_V1,
} as const;

export function unwrapSessionToolCall(outcome: ToolResult): ToolResult {
  if (!outcome.ok) return outcome;
  const result = SessionToolsCallOutputV1Schema.parse(outcome.result);
  return result.ok ? result : { ok: false, errorCode: result.errorCode, error: result.errorCode,
    ...(result.refusalCause ? { failureCause: result.refusalCause } : {}) };
}

/** Detection selects transport only; the Session MCP owner decides authority. */
export function hasSessionMcpContext(): boolean {
  return Boolean(process.env[SESSION_MCP_CONTEXT_FILE_ENV]);
}

export function executeSessionMcpAction(
  actionId: string,
  input: unknown,
  context?: Pick<ActionExecutorContext, 'signal' | 'actionRequestId'>,
): Promise<ToolResult> {
  return callSessionMcpTool({ source: 'happier', toolName: 'action_execute', args: { actionId, input },
    ...(context?.signal ? { signal: context.signal } : {}),
    ...(typeof context?.actionRequestId === 'string' ? { actionRequestId: context.actionRequestId } : {}),
  });
}

function transportFailure(error: unknown): ToolFailure {
  if (error instanceof McpError && error.data && typeof error.data === 'object'
    && 'errorCode' in error.data && error.data.errorCode === 'mcp_catalog_unavailable') {
    return { ok: false, errorCode: 'mcp_catalog_unavailable', error: 'MCP server catalog is unavailable.' };
  }
  const code = error && typeof error === 'object' && 'code' in error && error.code === 'not_authenticated'
    ? 'not_authenticated' : 'mcp_socket_access_unavailable';
  if (error instanceof SessionMcpUnavailableError && error.socketFailure) {
    const { errno, reason } = error.socketFailure;
    return {
      ok: false, errorCode: code,
      error: reason === 'socket_denied'
        ? "The Agent's sandbox blocked the Session connection, so use the Agent's native Happier tool or run the Action from a shell without the sandbox."
        : code,
      failureCause: { phase: 'session_mcp.connect', errorClass: 'Error', errorCode: errno,
        nativeErrorReason: reason, httpStatus: null },
    };
  }
  return { ok: false, errorCode: code, error: code };
}

async function withSessionMcp<Result>(operation: (connection: Awaited<ReturnType<typeof connectSessionMcpClient>>) => Promise<Result>, signal?: AbortSignal, sessionContext?: SessionMcpAgentContext): Promise<Result | ToolFailure> {
  const { connectSessionMcpClient, readSessionMcpContextFromEnvironment } = await import('@/mcp/runtime/sessionMcpLocalClient');
  let context = sessionContext;
  try { context ??= await readSessionMcpContextFromEnvironment(); }
  catch { return sessionActionTransportUnavailable(); }
  let connection: Awaited<ReturnType<typeof connectSessionMcpClient>> | undefined;
  try {
    connection = await connectSessionMcpClient(context, signal);
    return await operation(connection);
  } catch (error) { return transportFailure(error); }
  finally {
    try { await connection?.close(); }
    catch { logger.debug('[tools] Session connection cleanup failed'); }
  }
}

function readToolPayload(value: unknown): unknown {
  const result = CallToolResultSchema.parse(value);
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = result.content.find(entry => entry.type === 'text');
  if (text?.type !== 'text') return result.content;
  try { return JSON.parse(text.text); } catch { return text.text; }
}

export async function callSessionMcpTool(input: Readonly<{
  source: string; toolName: string; args: unknown; toolCallId?: string; actionRequestId?: string; signal?: AbortSignal;
  sessionContext?: SessionMcpAgentContext;
}>): Promise<ToolResult> {
  return await withSessionMcp(({ client }) => callConnectedTool(client, input), input.signal, input.sessionContext);
}

async function callConnectedTool(client: SessionMcpConnection['client'], input: Parameters<typeof callSessionMcpTool>[0]): Promise<ToolResult> {
    const metadata = {
      ...(input.source !== 'happier' ? { [SESSION_MCP_TOOL_SOURCE_META_KEY]: input.source } : {}),
      ...(input.toolCallId ? { 'happier/tool-call-id': input.toolCallId } : {}),
      ...(input.actionRequestId !== undefined ? { [SESSION_MCP_ACTION_REQUEST_ID_META_KEY]: input.actionRequestId } : {}),
    };
    const called = await callMcpToolWithResolvedTimeout({ client, toolName: input.toolName, args: input.args,
      ...(Object.keys(metadata).length ? { requestMetadata: metadata } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const payload = readToolPayload(called);
    if (input.source !== 'happier') return z.parse(customResultSchema, payload);
    if (!called.isError) return { ok: true as const, result: payload };
    const failure = failureSchema.safeParse(payload && typeof payload === 'object' ? { ...payload, ok: false } : null);
    return failure.success ? failure.data : { ok: false as const, errorCode: 'tool_failed', error: 'Session tool failed.' };
}

function sessionToolOperationInput(operation: ScriptToolOperation, args: Record<string, unknown>, signal?: AbortSignal, toolCallId?: string) {
  return { source: 'happier', toolName: getActionSpec(SESSION_TOOL_OPERATION_IDS[operation]).bindings!.mcpToolName!,
    args, signal, toolCallId };
}

export function callSessionMcpToolByTarget(input: Parameters<typeof callSessionMcpTool>[0], useQualifiedTarget: boolean): Promise<ToolResult> {
  return withSessionMcp(async ({ client }) => {
    const codeMode = client.getServerCapabilities()?.experimental?.[SESSION_MCP_CODE_MODE_CAPABILITY];
    if (!codeMode || !useQualifiedTarget) return callConnectedTool(client, input);
    const args = { source: input.source, tool: input.toolName, args: input.args };
    return unwrapSessionToolCall(await callConnectedTool(client,
      sessionToolOperationInput('call', args, input.signal, input.toolCallId)));
  }, input.signal, input.sessionContext);
}

export async function callSessionToolOperation(operation: ScriptToolOperation, args: Record<string, unknown>,
  signal?: AbortSignal, toolCallId?: string): Promise<ToolResult> {
  const outcome = await callSessionMcpTool(sessionToolOperationInput(operation, args, signal, toolCallId));
  return operation === 'call' ? unwrapSessionToolCall(outcome) : outcome;
}

export async function connectSessionToolScript(signal: AbortSignal) {
  const { connectSessionMcpClient, readSessionMcpContextFromEnvironment } = await import('@/mcp/runtime/sessionMcpLocalClient');
  let context: SessionMcpAgentContext;
  try { context = await readSessionMcpContextFromEnvironment(); }
  catch { return sessionActionTransportUnavailable(); }
  let connection: SessionMcpConnection;
  try { connection = await connectSessionMcpClient(context, signal); }
  catch (error) {
    signal.throwIfAborted();
    return transportFailure(error);
  }
  const supported = connection.client.getServerCapabilities()?.experimental?.[SESSION_MCP_CODE_MODE_CAPABILITY]?.scriptRunner === true;
  return { ok: true as const, supported, close: connection.close,
    execute: async (operation: ScriptToolOperation, args: Record<string, unknown>, signal: AbortSignal) => {
      try {
        const outcome = await callConnectedTool(connection.client, sessionToolOperationInput(operation, args, signal));
        return operation === 'call' ? unwrapSessionToolCall(outcome) : outcome;
      } catch (error) {
        signal.throwIfAborted();
        return transportFailure(error);
      }
    },
  };
}

export async function listSessionMcpTools(signal?: AbortSignal): Promise<ToolFailure | Readonly<{
  ok: true; sources: Record<string, Tool[]>; warnings: z.infer<typeof warningsSchema>;
}>> {
  return await withSessionMcp(async ({ client }) => {
    const sources: Record<string, Tool[]> = { happier: [] };
    const warnings: z.infer<typeof warningsSchema> = [];
    if (client.getServerCapabilities()?.experimental?.[SESSION_MCP_CODE_MODE_CAPABILITY]) {
      const outcome = await callConnectedTool(client, sessionToolOperationInput('search', {}, signal));
      if (!outcome.ok) return outcome;
      const parsed = SessionToolsSearchOutputV1Schema.parse(outcome.result);
      for (const { source, tool, description } of parsed.tools) {
        (sources[source] ??= []).push({ name: tool, description, inputSchema: { type: 'object' } });
      }
      if (parsed.warnings?.length) warnings.push(...parsed.warnings);
      return { ok: true as const, sources, warnings };
    }
    let cursor: string | undefined;
    do {
      const page = await client.listTools({ ...(cursor ? { cursor } : {}), _meta: { [SESSION_MCP_TOOL_SOURCES_META_KEY]: true } },
        signal ? { signal } : undefined);
      for (const tool of page.tools) {
        const source = tool._meta?.[SESSION_MCP_TOOL_SOURCE_META_KEY];
        const key = typeof source === 'string' && source.length > 0 ? source : 'happier';
        (sources[key] ??= []).push(tool);
      }
      const parsed = warningsSchema.safeParse(page._meta?.[SESSION_MCP_TOOL_WARNINGS_META_KEY]);
      if (parsed.success) warnings.push(...parsed.data);
      cursor = page.nextCursor;
    } while (cursor);
    return { ok: true as const, sources, warnings };
  }, signal);
}
