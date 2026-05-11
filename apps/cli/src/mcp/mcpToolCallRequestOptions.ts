import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { RequestMeta } from '@modelcontextprotocol/sdk/types.js';

import { configuration } from '@/configuration';

const MAX_SAFE_NODE_TIMEOUT_MS = 2_147_000_000;
const EXECUTION_RUN_WAIT_TOOL_NAME = 'execution_run_wait';

export { DEFAULT_MCP_TOOL_CALL_TIMEOUT_MS } from '@/configuration';

export type McpToolCallRequestOptions = Readonly<{
  timeout: number;
}>;

type McpCallToolClient = Pick<Client, 'callTool'>;

export function normalizeMcpToolArguments(args: unknown): Record<string, unknown> | undefined {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined;
  return args as Record<string, unknown>;
}

function isExecutionRunWaitToolName(toolName: string): boolean {
  return toolName === EXECUTION_RUN_WAIT_TOOL_NAME || toolName.endsWith(`__${EXECUTION_RUN_WAIT_TOOL_NAME}`);
}

function readTimeoutSeconds(args: unknown): number | null {
  const record = normalizeMcpToolArguments(args);
  const timeoutSeconds = record?.timeoutSeconds;
  if (typeof timeoutSeconds !== 'number' || !Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    return null;
  }
  return timeoutSeconds;
}

export function resolveMcpToolCallDefaultTimeoutMs(): number {
  return configuration.mcpToolCallTimeoutMs;
}

export function resolveExecutionRunWaitMcpTimeoutGraceMs(): number {
  return configuration.mcpExecutionRunWaitTimeoutGraceMs;
}

export function resolveMcpToolCallRequestTimeoutMs(params: Readonly<{
  toolName: string;
  args: unknown;
}>): number {
  const timeoutSeconds = isExecutionRunWaitToolName(params.toolName) ? readTimeoutSeconds(params.args) : null;
  if (timeoutSeconds != null) {
    const requestedWaitMs = Math.max(1, Math.floor(timeoutSeconds * 1_000));
    return Math.min(
      requestedWaitMs + resolveExecutionRunWaitMcpTimeoutGraceMs(),
      MAX_SAFE_NODE_TIMEOUT_MS,
    );
  }
  return resolveMcpToolCallDefaultTimeoutMs();
}

export function resolveMcpToolCallRequestOptions(params: Readonly<{
  toolName: string;
  args: unknown;
}>): McpToolCallRequestOptions {
  return { timeout: resolveMcpToolCallRequestTimeoutMs(params) };
}

export async function callMcpToolWithResolvedTimeout(params: Readonly<{
  client: McpCallToolClient;
  toolName: string;
  args: unknown;
  requestMetadata?: RequestMeta;
  onprogress?: RequestOptions['onprogress'];
}>): ReturnType<Client['callTool']> {
  return await params.client.callTool(
    {
      name: params.toolName,
      arguments: normalizeMcpToolArguments(params.args),
      ...(params.requestMetadata === undefined ? {} : { _meta: params.requestMetadata }),
    },
    undefined,
    {
      ...resolveMcpToolCallRequestOptions({
        toolName: params.toolName,
        args: params.args,
      }),
      ...(params.onprogress === undefined ? {} : { onprogress: params.onprogress }),
    },
  );
}
