import { Client } from '@modelcontextprotocol/sdk/client/index.js';

import type { McpServerConfig } from '@/agent';
import { callMcpToolWithResolvedTimeout } from '@/mcp/mcpToolCallRequestOptions';
import { createCustomMcpClientTransport } from './createCustomMcpClientTransport';
import { McpServerCatalogUnavailableError } from '@/mcp/servers/readMcpServersSettingsFromAccountSettings';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';

export async function callResolvedCustomHappierTool(params: Readonly<{
  source: string;
  toolName: string;
  args: unknown;
  mcpServers: Record<string, McpServerConfig>;
  operationContext: Readonly<Pick<SavedSecretOperationContextV1, 'isCurrent'>>;
  processEnv?: NodeJS.ProcessEnv;
}>): Promise<{ ok: true; result: unknown } | { ok: false; errorCode: string; error: string }> {
  const config = params.mcpServers[params.source];
  if (!config) {
    return { ok: false, errorCode: 'server_not_found', error: `Unknown MCP server source: ${params.source}` };
  }

  const client = new Client({ name: 'happier-tools-call', version: '1.0.0' }, { capabilities: {} });

  try {
    if (!await params.operationContext.isCurrent()) throw new McpServerCatalogUnavailableError('scope-retired');
    const transport = createCustomMcpClientTransport(config, params.processEnv ?? process.env);
    await client.connect(transport);
    if (!await params.operationContext.isCurrent()) throw new McpServerCatalogUnavailableError('scope-retired');
    const result = await callMcpToolWithResolvedTimeout({
      client,
      toolName: params.toolName,
      args: params.args,
    });
    return { ok: true, result };
  } catch (error) {
    return {
      ok: false,
      errorCode: 'tool_call_failed',
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await client.close().catch(() => {});
  }
}
