import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { sessionProcessEnvironment } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import type { PrepareMcpStdioTransport } from '@/mcp/runtime/supervisedStdioTransport';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import type { McpServerConfig } from '@/agent';
import { callMcpToolWithResolvedTimeout } from '@/mcp/mcpToolCallRequestOptions';
import { createCustomMcpClientTransport } from './createCustomMcpClientTransport';
import { McpServerCatalogUnavailableError } from '@/mcp/servers/readMcpServersSettingsFromAccountSettings';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { RequestMeta } from '@modelcontextprotocol/sdk/types.js';

export async function callResolvedCustomHappierTool(params: Readonly<{
  source: string;
  toolName: string;
  args: unknown;
  mcpServers: Record<string, McpServerConfig>;
  operationContext: Readonly<Pick<SavedSecretOperationContextV1, 'isCurrent'>>;
  processEnv?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  prepareTransport?: PrepareMcpStdioTransport;
  requestMetadata?: RequestMeta;
  onprogress?: RequestOptions['onprogress'];
}>): Promise<{ ok: true; result: unknown } | { ok: false; errorCode: string; error: string }> {
  const config = Object.hasOwn(params.mcpServers, params.source) ? params.mcpServers[params.source] : undefined;
  if (!config) {
    return { ok: false, errorCode: 'server_not_found', error: `Unknown MCP server source: ${params.source}` };
  }

  const client = new Client({ name: 'happier-tools-call', version: '1.0.0' }, { capabilities: {} });
  let transport: Transport | undefined;

  try {
    if (!await params.operationContext.isCurrent()) throw new McpServerCatalogUnavailableError('scope-retired');
    transport = await createCustomMcpClientTransport(config, params.processEnv ?? sessionProcessEnvironment(),
      { signal: params.signal, prepareTransport: params.prepareTransport });
    await client.connect(transport, params.signal ? { signal: params.signal } : undefined);
    if (!await params.operationContext.isCurrent()) throw new McpServerCatalogUnavailableError('scope-retired');
    const result = await callMcpToolWithResolvedTimeout({
      client,
      toolName: params.toolName,
      args: params.args,
      ...(params.signal ? { signal: params.signal } : {}),
      ...(params.requestMetadata ? { requestMetadata: params.requestMetadata } : {}),
      ...(params.onprogress ? { onprogress: params.onprogress } : {}),
    });
    return { ok: true, result };
  } catch (error) {
    params.signal?.throwIfAborted();
    if (error instanceof PluginError) throw error;
    return {
      ok: false,
      errorCode: 'tool_call_failed',
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    try { await client.close(); } finally { await transport?.close(); }
  }
}
