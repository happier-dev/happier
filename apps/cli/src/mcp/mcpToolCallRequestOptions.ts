import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

import { configuration } from '@/configuration';

const MAX_SAFE_NODE_TIMEOUT_MS = 2_147_000_000;
const EXECUTION_RUN_START_TOOL_NAME = 'execution_run_start';
const EXECUTION_RUN_WAIT_TOOL_NAME = 'execution_run_wait';

export { DEFAULT_MCP_TOOL_CALL_TIMEOUT_MS } from '@/configuration';

export type McpToolCallRequestOptions = Readonly<{
  timeout: number;
  signal?: AbortSignal;
}>;

type McpCallToolClient = Pick<Client, 'callTool'>;

export function normalizeMcpToolArguments(args: unknown): Record<string, unknown> | undefined {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined;
  return args as Record<string, unknown>;
}

function isExecutionRunWaitToolName(toolName: string): boolean {
  return toolName === EXECUTION_RUN_WAIT_TOOL_NAME || toolName.endsWith(`__${EXECUTION_RUN_WAIT_TOOL_NAME}`);
}

function isExecutionRunStartToolName(toolName: string): boolean {
  return toolName === EXECUTION_RUN_START_TOOL_NAME || toolName.endsWith(`__${EXECUTION_RUN_START_TOOL_NAME}`);
}

function readTimeoutSeconds(args: unknown): number | null {
  const record = normalizeMcpToolArguments(args);
  const timeoutSeconds = record?.timeoutSeconds;
  if (typeof timeoutSeconds !== 'number' || !Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    return null;
  }
  return timeoutSeconds;
}

function readExecutionRunStartWaitTimeoutSeconds(args: unknown): number | null {
  const record = normalizeMcpToolArguments(args);
  if (record?.waitForCompletion !== true) return null;
  const timeoutSeconds = record.waitTimeoutSeconds;
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
  const timeoutSeconds = isExecutionRunWaitToolName(params.toolName)
    ? readTimeoutSeconds(params.args)
    : isExecutionRunStartToolName(params.toolName)
      ? readExecutionRunStartWaitTimeoutSeconds(params.args)
      : null;
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
  signal?: AbortSignal;
}>): ReturnType<Client['callTool']> {
  const requestOptions = resolveMcpToolCallRequestOptions({
    toolName: params.toolName,
    args: params.args,
  });
  return await params.client.callTool(
    { name: params.toolName, arguments: normalizeMcpToolArguments(params.args) },
    undefined,
    params.signal === undefined
      ? requestOptions
      : { ...requestOptions, signal: params.signal },
  );
}
