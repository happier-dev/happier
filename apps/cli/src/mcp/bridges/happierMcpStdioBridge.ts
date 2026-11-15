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
 *
 * This is host MCP bridge infrastructure, not provider runtime behavior.
 */

import '../../configureZodLocale';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { runMcpStdioBridgeLifecycle } from '@/mcp/runtime/runMcpStdioBridgeLifecycle';
import { createForwardingMcpServer } from './forwardingMcpServer';

function parseArgs(argv: string[]): { url: string | null; toolNameMaxLength?: number } {
  let url: string | null = null;
  let toolNameMaxLength: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url' && i + 1 < argv.length) {
      url = argv[i + 1];
      i++;
    } else if (a === '--tool-name-max-length') {
      toolNameMaxLength = Number(argv[++i]);
    }
  }
  return { url, ...(toolNameMaxLength === undefined ? {} : { toolNameMaxLength }) };
}

async function main() {
  // Session Agents launch the native `happier-session-holder mcp-relay`; this bridge serves
  // the public `happier-mcp --url` entry point only.
  const { url: urlFromArgs, toolNameMaxLength } = parseArgs(process.argv.slice(2));
  const baseUrl = urlFromArgs || process.env.HAPPIER_HTTP_MCP_URL || '';

  if (!baseUrl) {
    // Write to stderr; never stdout.
    process.stderr.write(
      '[happier-mcp] Missing target URL. Set HAPPIER_HTTP_MCP_URL or pass --url <http://127.0.0.1:PORT>\n'
    );
    process.exit(2);
  }

  let httpClient: Client | null = null;
  let httpClientPromise: Promise<Client> | null = null;

  async function ensureHttpClient(): Promise<Client> {
    if (httpClient) return httpClient;
    if (httpClientPromise) return await httpClientPromise;
    const pending = (async () => {
      const client = new Client(
        { name: 'happier-stdio-bridge', version: '1.0.0' },
        { capabilities: {} }
      );
      const transport = new StreamableHTTPClientTransport(new URL(baseUrl));
      try {
        await client.connect(transport);
        httpClient = client;
        return client;
      } catch (error) {
        await client.close().catch(() => undefined);
        throw error;
      }
    })();
    httpClientPromise = pending;
    try {
      return await pending;
    } catch (error) {
      httpClientPromise = null;
      throw error;
    }
  }

  const server = createForwardingMcpServer({
    upstream: async operation => await operation(await ensureHttpClient()),
    ...(toolNameMaxLength === undefined ? {} : { toolNameMaxLength }),
    forwardResources: true,
  });

  const requestedSignal = await runMcpStdioBridgeLifecycle({
    stdin: process.stdin,
    start: async () => {
      const stdio = new StdioServerTransport();
      await server.connect(stdio);
      return { transport: stdio };
    },
    closeServer: async () => await server.close(),
    closeUpstream: async () => {
      // Join an in-flight connection so stdio shutdown cannot orphan its socket.
      const client = await httpClientPromise?.catch(() => undefined);
      await client?.close();
    },
  });
  if (requestedSignal === 'SIGINT') process.exitCode = 130;
  if (requestedSignal === 'SIGTERM') process.exitCode = 143;
}

// Start and surface fatal errors to stderr only
main().catch((err: unknown) => {
  try {
    process.stderr.write(`[happier-mcp] Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  } finally {
    process.exit(1);
  }
});
