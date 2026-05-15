import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { repoRootDir } from './paths';

export type McpToolCallResult = Readonly<{
  content?: readonly Readonly<{ text?: unknown }>[];
}>;

export type ExternalMcpTransport = Readonly<{
  stderr?: {
    on(event: 'data', listener: (chunk: Buffer) => void): void;
  };
  close(): Promise<void>;
}>;

export type ExternalMcpClient = Readonly<{
  connect(transport: ExternalMcpTransport): Promise<void>;
  close(): Promise<void>;
  listTools(): Promise<{ tools: readonly Readonly<{ name: string }>[] }>;
  callTool(request: { name: string; arguments?: Record<string, unknown> }): Promise<McpToolCallResult>;
}>;

export async function connectExternalMcp(params: Readonly<{
  cliEntrypoint: string;
  sessionId: string;
  cliHome: string;
  serverBaseUrl: string;
}>): Promise<Readonly<{
  client: ExternalMcpClient;
  transport: ExternalMcpTransport;
  stderrLines: string[];
}>> {
  const sdkClientIndexPath = resolve(repoRootDir(), 'apps/cli/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
  const sdkClientStdioPath = resolve(repoRootDir(), 'apps/cli/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js');
  const { Client } = await import(pathToFileURL(sdkClientIndexPath).href) as {
    Client: new (params: { name: string; version: string }) => ExternalMcpClient;
  };
  const { StdioClientTransport } = await import(pathToFileURL(sdkClientStdioPath).href) as {
    StdioClientTransport: new (params: {
      command: string;
      args: string[];
      env: Record<string, string | undefined>;
      stderr: 'pipe';
    }) => ExternalMcpTransport;
  };

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [params.cliEntrypoint, 'mcp', 'serve', '--session', params.sessionId],
    env: {
      ...process.env,
      CI: '1',
      HAPPIER_HOME_DIR: params.cliHome,
      HAPPIER_SERVER_URL: params.serverBaseUrl,
    },
    stderr: 'pipe',
  });

  const stderrLines: string[] = [];
  transport.stderr?.on('data', (chunk: Buffer) => {
    stderrLines.push(chunk.toString('utf8'));
  });

  const client = new Client({ name: 'happier-e2e', version: '0.0.0' });
  await client.connect(transport);
  return { client, transport, stderrLines };
}

export function parseToolJson<T = Record<string, unknown>>(call: McpToolCallResult): T {
  return JSON.parse(String(call.content?.[0]?.text ?? '')) as T;
}
