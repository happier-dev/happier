import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ActionExecuteResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';

import { repoRootDir } from './paths';
import type { CliTestLaunchSpec } from './process/cliLaunchSpec';

export type McpToolCallResult = Readonly<Pick<CallToolResult, 'content' | 'isError'>>;

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
  sessionId: string;
  cliHome: string;
  serverBaseUrl: string;
} & ({ cliEntrypoint: string; cliLaunch?: never } | { cliLaunch: CliTestLaunchSpec; cliEntrypoint?: never })>): Promise<Readonly<{
  client: ExternalMcpClient;
  transport: ExternalMcpTransport;
  stderrLines: string[];
}>> {
  const launch: CliTestLaunchSpec = params.cliLaunch ?? { command: process.execPath, args: [params.cliEntrypoint!] };
  return connectStdioMcp({ command: launch.command,
    args: [...launch.args, 'mcp', 'serve', '--session', params.sessionId],
    ...(launch.cwd ? { cwd: launch.cwd } : {}),
    env: { ...process.env, ...launch.env, CI: '1', HAPPIER_HOME_DIR: params.cliHome, HAPPIER_SERVER_URL: params.serverBaseUrl } });
}

/** Connect through the exact MCP launch advertised to the external Agent. */
export async function connectStdioMcp(params: Readonly<{
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string | undefined>;
}>): Promise<Readonly<{
  client: ExternalMcpClient;
  transport: ExternalMcpTransport;
  stderrLines: string[];
}>> {
  const cliRequire = createRequire(resolve(repoRootDir(), 'apps/cli/package.json'));
  const sdkClientIndexPath = cliRequire.resolve('@modelcontextprotocol/sdk/client/index.js');
  const sdkClientStdioPath = cliRequire.resolve('@modelcontextprotocol/sdk/client/stdio.js');
  const { Client } = await import(pathToFileURL(sdkClientIndexPath).href) as {
    Client: new (params: { name: string; version: string }) => ExternalMcpClient;
  };
  const { StdioClientTransport } = await import(pathToFileURL(sdkClientStdioPath).href) as {
    StdioClientTransport: new (params: {
      command: string;
      args: string[];
      cwd?: string;
      env: Record<string, string | undefined>;
      stderr: 'pipe';
    }) => ExternalMcpTransport;
  };

  const transport = new StdioClientTransport({
    ...params,
    stderr: 'pipe',
  });

  const stderrLines: string[] = [];
  transport.stderr?.on('data', (chunk: Buffer) => {
    stderrLines.push(chunk.toString('utf8'));
  });

  const client = new Client({ name: 'happier-e2e', version: '0.0.0' });
  try {
    await client.connect(transport);
  } catch (cause) {
    await transport.close().catch(() => {});
    const stderr = stderrLines.join('');
    const codes = [...new Set(stderr.match(/\b(?:ERR_|HSTACK_|HAPPIER_)[A-Z_]+\b/g) ?? [])];
    const packages = [...stderr.matchAll(/Cannot find package '(@?[a-z0-9][a-z0-9/._-]*)'/g)].map(match => match[1]);
    throw new Error(`External MCP initialization failed (stderrBytes=${Buffer.byteLength(stderr)}, codes=${codes.join(',')}, missingPackages=${packages.join(',')})`, { cause });
  }
  return { client, transport, stderrLines };
}

export function parseToolJson<T = Record<string, unknown>>(call: McpToolCallResult): T {
  const block = call.content[0];
  return JSON.parse(block?.type === 'text' ? block.text : '') as T;
}

/** Native Action tools return the result payload, or the typed failure payload. */
export function parseMcpActionExecuteResult(call: McpToolCallResult) {
  const result = parseToolJson<unknown>(call);
  const failure = result && typeof result === 'object' ? result : {};
  return ActionExecuteResultSchema.parse(call.isError ? { ...failure, ok: false } : { ok: true, result });
}
