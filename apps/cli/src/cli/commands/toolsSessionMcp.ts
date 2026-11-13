import { CallToolResultSchema, McpError, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod/mini';
import type { ActionExecutorContext } from '@happier-dev/protocol';

import { callMcpToolWithResolvedTimeout } from '@/mcp/mcpToolCallRequestOptions';
import { connectSessionMcpClient, readSessionMcpContextFromEnvironment } from '@/mcp/runtime/sessionMcpLocalClient';
import { SESSION_MCP_CONTEXT_FILE_ENV } from '@/mcp/runtime/sessionMcpLocalContext';
import { SESSION_MCP_ACTION_REQUEST_ID_META_KEY, SESSION_MCP_TOOL_SOURCES_META_KEY, SESSION_MCP_TOOL_SOURCE_META_KEY, SESSION_MCP_TOOL_WARNINGS_META_KEY } from '@/mcp/runtime/sessionMcpToolsBridge';

const failureSchema = z.object({ ok: z.literal(false), errorCode: z.string(), error: z.string(),
  details: z.optional(z.unknown()), candidates: z.optional(z.array(z.string())) });
const customResultSchema = z.union([z.object({ ok: z.literal(true), result: z.unknown() }), failureSchema]);
const warningsSchema = z.array(z.object({ source: z.string(), error: z.string() }));

type ToolFailure = z.infer<typeof failureSchema>;
type ToolResult = Readonly<{ ok: true; result: unknown }> | ToolFailure;

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
  return { ok: false, errorCode: code, error: code };
}

async function withSessionMcp<Result>(operation: (connection: Awaited<ReturnType<typeof connectSessionMcpClient>>) => Promise<Result>, signal?: AbortSignal): Promise<Result | ToolFailure> {
  let context;
  try { context = await readSessionMcpContextFromEnvironment(); }
  catch { return { ok: false, errorCode: 'not_authenticated', error: 'Authenticated Session MCP context is required.' }; }
  let connection: Awaited<ReturnType<typeof connectSessionMcpClient>> | undefined;
  try {
    connection = await connectSessionMcpClient(context, signal);
    return await operation(connection);
  } catch (error) { return transportFailure(error); }
  finally { await connection?.close(); }
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
}>): Promise<ToolResult> {
  return await withSessionMcp(async ({ client }) => {
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
  }, input.signal);
}

export async function listSessionMcpTools(signal?: AbortSignal): Promise<ToolFailure | Readonly<{
  ok: true; sources: Record<string, Tool[]>; warnings: z.infer<typeof warningsSchema>;
}>> {
  return await withSessionMcp(async ({ client }) => {
    const sources: Record<string, Tool[]> = { happier: [] };
    const warnings: z.infer<typeof warningsSchema> = [];
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
