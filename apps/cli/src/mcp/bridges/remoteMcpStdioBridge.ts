/**
 * Remote MCP STDIO Bridge
 *
 * STDIO MCP server that proxies tools to a remote MCP server over:
 * - Streamable HTTP (`transport: http`)
 * - SSE (`transport: sse`)
 *
 * Bridge config is provided via env var `HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE`.
 *
 * SECURITY: never print secrets to stdout (stdout is reserved for MCP stdio).
 */

import { readFile, unlink } from 'node:fs/promises';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { z } from 'zod';

import { callMcpToolWithResolvedTimeout } from '@/mcp/mcpToolCallRequestOptions';
import { isSafeTmpMcpConfigFilePath } from '@/mcp/runtime/isSafeTmpMcpConfigFilePath';

const REMOTE_BRIDGE_CONFIG_PREFIX = 'happier-mcp-remote-bridge';

const RemoteBridgeConfigSchema = z.object({
  transport: z.enum(['http', 'sse']),
  url: z.string().min(1),
  headers: z.record(z.string(), z.string()).optional().default({}),
});

type RemoteBridgeConfig = z.infer<typeof RemoteBridgeConfigSchema>;

function writeStderr(line: string): void {
  try {
    process.stderr.write(line.endsWith('\n') ? line : `${line}\n`);
  } catch {
    // ignore
  }
}

function parseArgsValue(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function jsonSchemaToZod(schema: unknown): z.ZodTypeAny {
  const record = asRecord(schema);
  if (!record) return z.any();

  const anyOf = Array.isArray(record.anyOf) ? record.anyOf.map((entry) => jsonSchemaToZod(entry)) : null;
  if (anyOf && anyOf.length > 0) {
    const [first, ...rest] = anyOf;
    return rest.reduce<z.ZodTypeAny>((current, entry) => z.union([current, entry]), first);
  }

  const oneOf = Array.isArray(record.oneOf) ? record.oneOf.map((entry) => jsonSchemaToZod(entry)) : null;
  if (oneOf && oneOf.length > 0) {
    const [first, ...rest] = oneOf;
    return rest.reduce<z.ZodTypeAny>((current, entry) => z.union([current, entry]), first);
  }

  if (Array.isArray(record.enum) && record.enum.length > 0) {
    const literals = record.enum.map((entry) => z.literal(entry));
    const [first, ...rest] = literals;
    return rest.reduce<z.ZodTypeAny>((current, entry) => z.union([current, entry]), first);
  }

  const typeValue = record.type;
  if (Array.isArray(typeValue) && typeValue.length > 0) {
    const entries = typeValue.map((entry) => jsonSchemaToZod({ ...record, type: entry }));
    const [first, ...rest] = entries;
    return rest.reduce<z.ZodTypeAny>((current, entry) => z.union([current, entry]), first);
  }

  switch (typeValue) {
    case 'string':
      return z.string();
    case 'number':
      return z.number();
    case 'integer':
      return z.number().int();
    case 'boolean':
      return z.boolean();
    case 'null':
      return z.null();
    case 'array': {
      return z.array(jsonSchemaToZod(record.items));
    }
    case 'object': {
      const properties = asRecord(record.properties) ?? {};
      const required = new Set(Array.isArray(record.required) ? record.required.filter((entry): entry is string => typeof entry === 'string') : []);
      const shape: Record<string, z.ZodTypeAny> = {};
      for (const [key, value] of Object.entries(properties)) {
        const propertySchema = jsonSchemaToZod(value);
        shape[key] = required.has(key) ? propertySchema : propertySchema.optional();
      }

      let objectSchema = z.object(shape);
      if (record.additionalProperties === false) return objectSchema.strict();

      const additionalProperties = asRecord(record.additionalProperties);
      if (additionalProperties) return objectSchema.catchall(jsonSchemaToZod(additionalProperties));

      return objectSchema.passthrough();
    }
    default:
      return z.any();
  }
}

function getRegisteredInputSchema(tool: unknown): z.ZodTypeAny {
  const record = asRecord(tool);
  if (!record) return z.any();
  return jsonSchemaToZod(record.inputSchema);
}

async function connectRemoteClient(config: RemoteBridgeConfig): Promise<Client> {
  const client = new Client({ name: 'happier-remote-bridge', version: '1.0.0' }, { capabilities: {} });

  const url = new URL(config.url);
  const headers = { ...config.headers };

  const transport =
    config.transport === 'http'
      ? new StreamableHTTPClientTransport(url, { requestInit: { headers } })
      : new SSEClientTransport(url, {
        requestInit: { headers },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        eventSourceInit: { headers } as any,
      });

  await client.connect(transport);
  return client;
}

async function main(): Promise<void> {
  const configPath = typeof process.env.HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE === 'string'
    ? process.env.HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE
    : '';
  if (!configPath) {
    writeStderr('[happier-mcp-remote-bridge] Missing HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE');
    process.exit(2);
  }

  let config: RemoteBridgeConfig;
  try {
    const raw = await readFile(configPath, 'utf8');
    if (isSafeTmpMcpConfigFilePath(configPath, REMOTE_BRIDGE_CONFIG_PREFIX)) {
      await unlink(configPath).catch(() => {});
    }
    config = RemoteBridgeConfigSchema.parse(JSON.parse(raw));
  } catch (err) {
    writeStderr(`[happier-mcp-remote-bridge] Failed to read config: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }

  const remoteClient = await connectRemoteClient(config);

  const toolList = await remoteClient.listTools();
  const tools = Array.isArray((toolList as any)?.tools) ? ((toolList as any).tools as any[]) : [];

  const server = new McpServer({ name: 'Happier MCP Remote Bridge', version: '1.0.0' });

  for (const tool of tools) {
    const name = typeof tool?.name === 'string' ? tool.name : '';
    if (!name) continue;

    server.registerTool(
      name,
      {
        description: typeof tool?.description === 'string' ? tool.description : undefined,
        title: typeof tool?.title === 'string' ? tool.title : undefined,
        // Preserve the remote JSON schema so downstream clients can see required
        // arguments. If the remote tool omits a usable schema, fall back to
        // permissive validation and let the remote server enforce its own rules.
        inputSchema: getRegisteredInputSchema(tool),
        _meta: tool?.inputSchema ? { remoteInputSchema: tool.inputSchema } : undefined,
      } as any,
      (async (argsOrExtra: unknown, extra?: unknown) => {
        const toolArgs = parseArgsValue(argsOrExtra) ?? parseArgsValue(extra);
        return await callMcpToolWithResolvedTimeout({ client: remoteClient, toolName: name, args: toolArgs });
      }) as any,
    );
  }

  const stdio = new StdioServerTransport();
  await server.connect(stdio);
}

main().catch((err) => {
  writeStderr(`[happier-mcp-remote-bridge] Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
