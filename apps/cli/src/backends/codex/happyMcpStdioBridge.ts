/**
 * Happier MCP STDIO Bridge
 *
 * STDIO MCP server that forwards tools to an existing Happier HTTP MCP server
 * using the StreamableHTTPClientTransport.
 *
 * Configure the target HTTP MCP URL via env var `HAPPIER_HTTP_MCP_URL` or
 * via CLI flag `--url <http://127.0.0.1:PORT>`.
 *
 * Note: This process must not print to stdout as it would break MCP STDIO.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { registerHappierMcpBridgeTools } from './registerHappierMcpBridgeTools';
import { registerHappierMcpResources } from '@/mcp/resources/registerHappierMcpResources';
import { callMcpToolWithResolvedTimeout } from '@/mcp/mcpToolCallRequestOptions';
import { isActionEnabledByEnv } from '@/settings/actionsSettings';
import { withMcpTimeout } from '@/mcp/runtime/withMcpTimeout';
import { bindMcpStdioBridgeLifecycle } from '@/mcp/runtime/bindMcpStdioBridgeLifecycle';

const MCP_BRIDGE_STARTUP_TIMEOUT_MS = 60_000;

function parseArgs(argv: string[]): { url: string | null } {
  let url: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url' && i + 1 < argv.length) {
      url = argv[i + 1];
      i++;
    }
  }
  return { url };
}

async function main() {
  // Resolve target HTTP MCP URL
  const { url: urlFromArgs } = parseArgs(process.argv.slice(2));
  const baseUrl = urlFromArgs || process.env.HAPPIER_HTTP_MCP_URL || '';

  if (!baseUrl) {
    // Write to stderr; never stdout.
    process.stderr.write(
      '[happier-mcp] Missing target URL. Set HAPPIER_HTTP_MCP_URL or pass --url <http://127.0.0.1:PORT>\n'
    );
    process.exit(2);
  }

  let httpClient: Client | null = null;

  async function ensureHttpClient(): Promise<Client> {
    if (httpClient) return httpClient;
    const client = new Client(
      { name: 'happier-stdio-bridge', version: '1.0.0' },
      { capabilities: {} }
    );

    const transport = new StreamableHTTPClientTransport(new URL(baseUrl));
    try {
      await withMcpTimeout(client.connect(transport), {
        timeoutMs: MCP_BRIDGE_STARTUP_TIMEOUT_MS,
        label: 'happier_mcp_bridge_connect_timeout',
      });
      httpClient = client;
      return client;
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
  }

  // Create STDIO MCP server
  const server = new McpServer({
    name: 'Happier MCP Bridge',
    version: '1.0.0',
  });

  registerHappierMcpBridgeTools(server as any, {
    callHttpTool: async (name, args) => {
      const client = await ensureHttpClient();
      return await callMcpToolWithResolvedTimeout({ client, toolName: name, args });
    },
  });
  registerHappierMcpResources(server as any, {
    isActionEnabled: (id) => isActionEnabledByEnv(id, { surface: 'session_agent' }),
  });

  // Start STDIO transport
  const stdio = new StdioServerTransport();
  await server.connect(stdio);
  bindMcpStdioBridgeLifecycle({
    stdin: process.stdin,
    transport: stdio,
    closeServer: async () => await server.close(),
    closeUpstream: async () => await httpClient?.close(),
  });
}

// Import-only candidate validation must not start the stdio runtime.
if (process.env.HAPPIER_CLI_DIST_INTEGRITY_PROBE !== '1') {
  main().catch((err) => {
    try {
      process.stderr.write(`[happier-mcp] Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    } finally {
      process.exit(1);
    }
  });
}
