import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod/mini';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createDaemonControlApp } from '@/daemon/controlServer';
import { createConnectedAccountRequestAuthService } from '@/daemon/connectedServices/requestAuth/ConnectedAccountRequestAuthService';
import { parseHttpHeadersRequestAuthMaterial } from '@/daemon/connectedServices/requestAuth/parseHttpHeadersRequestAuthMaterial';
import { createConnectedAccountRequestAuthSubjectRegistry } from '@/daemon/connectedServices/requestAuth/ConnectedAccountRequestAuthSubjectRegistry';
import { CONNECTED_ACCOUNT_REQUEST_AUTH_LOOKUP_PATH } from '@happier-dev/protocol/connect/connected-account-request-auth';
import { HOST_CONNECTED_ACCOUNT_SERVICE_REF_V1 } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import { MCP_REQUEST_AUTH_PURPOSE } from '@/mcp/runtime/mcpRequestAuth';
import { SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol';
import type { EphemeralTlsServerFixture } from '../../../../../packages/tests/src/testkit/tls/ephemeralTlsServerFixture.mjs';

const bridgePurpose = MCP_REQUEST_AUTH_PURPOSE;

export async function startBridgeRequestAuth(root: string, resource: string, credentialHeaders: Readonly<Record<string, string>> = {}) {
  let revision = 0;
  let reports = 0;
  let lookups = 0;
  let active = true;
  const scopes: string[] = [];
  const account = { service: HOST_CONNECTED_ACCOUNT_SERVICE_REF_V1, accountId: 'server-one' };
  const binding = { purpose: bridgePurpose, target: { kind: 'account' as const, account } };
  const use = { purpose: bridgePurpose, materialization: { kind: 'httpHeaders' as const, origin: new URL(resource).origin,
    headerNames: ['authorization', ...Object.keys(credentialHeaders).map(name => name.toLowerCase())] } };
  const registry = createConnectedAccountRequestAuthSubjectRegistry();
  const owner = createConnectedAccountRequestAuthService({
    resolveCurrentBinding: () => ({ account, credentialRevision: `csr_${String(revision).padStart(24, '0')}` }),
    materializeHeaders: async () => parseHttpHeadersRequestAuthMaterial(use.materialization,
      { kind: 'httpHeaders', headers: { authorization: `Bearer bearer-${revision}`, ...credentialHeaders } }),
    refreshAfterAuthFailure: async () => { reports++; revision++; return { status: 'current_changed' }; },
    reportQuotaFailure: async () => ({ status: 'denied' }),
    reportScopeFailure: async ({ failure }) => { scopes.push(...failure.requiredScopes); return { status: 'current_unchanged' }; },
  });
  const app = createDaemonControlApp({
    getChildren: () => [], machineId: 'test-machine',
    stopSession: async () => ({ status: 'not_found' }),
    spawnSession: async () => ({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED, errorMessage: 'unused' }),
    requestShutdown: () => undefined, onHappySessionWebhook: () => undefined,
    controlToken: 'test-control',
    connectedAccountRequestAuth: { authenticate: registry.authenticate, ...owner },
  });
  app.addHook('onRequest', async (request) => { if (request.url === CONNECTED_ACCOUNT_REQUEST_AUTH_LOOKUP_PATH) lookups++; });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('request_auth_address_unavailable');
  const descriptor = await registry.activate({
    subject: { subjectId: 'bridge-operation', parentSessionId: 'parent-session', isCurrent: () => active,
      registerRedaction: () => undefined, resolvePurposeUse: () => ({ binding, use }), listPurposeUses: () => [{ binding, use }] },
    materializedRootDir: root, materializationId: 'server-one', httpPort: address.port,
  });
  return { capabilityFile: descriptor.path, rotate: () => { revision++; },
    revoke: () => { active = false; },
    counts: () => ({ reports, lookups }), scopes,
    stop: async () => { await registry.retire(descriptor); await app.close(); } };
}

export function respondToLocalInventoryProbe(request: IncomingMessage, response: ServerResponse): boolean {
  // A running daemon's local-service inventory probes newly opened loopback
  // ports (daemon/local/services/inventory/endpoint.ts). This is not MCP traffic.
  // Match only that exact credential-free HEAD signature; never hide a bearer
  // or any custom header, even on an otherwise matching request.
  if (request.method !== 'HEAD' || request.url !== '/'
    || request.headers.accept !== 'text/html,application/xhtml+xml,*/*;q=0.1'
    || request.headers.connection !== 'close'
    || Object.keys(request.headers).some(name => !['host', 'accept', 'connection'].includes(name))) return false;
  response.writeHead(204).end();
  return true;
}

export async function startTestMcpHttpServer(onRequest?: (req: IncomingMessage, res: ServerResponse) => boolean, tls?: EphemeralTlsServerFixture, toolResult?: (request: IncomingMessage) => CallToolResult): Promise<{ url: string; stop: () => void }> {
  const server = tls ? createSecureServer({ key: await readFile(tls.privateKeyPath), cert: await readFile(tls.leafCertificatePath) }) : createServer();
  server.on('request', async (req, res) => {
    if (respondToLocalInventoryProbe(req, res)) return;
    if (onRequest && !onRequest(req, res)) return;
    const mcp = new McpServer({ name: 'test-mcp', version: '1.0.0' });
    mcp.registerTool(
      'echo',
      {
        description: 'Echo',
        inputSchema: z.looseObject({ text: z.string() }),
        outputSchema: z.looseObject({ echoed: z.string() }),
        annotations: { readOnlyHint: true },
        _meta: { 'acme.example/source': 'integration-test' },
      } as any,
      async (args: any) => toolResult ? toolResult(req) : ({
        content: [{ type: 'text' as const, text: String(args?.text ?? '') }],
        structuredContent: { echoed: String(args?.text ?? '') },
        isError: false as const,
      }),
    );

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    res.once('close', () => {
      transport.close().catch(() => {});
      Promise.resolve(mcp.close()).catch(() => {});
    });

    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  });

  const baseUrl = await new Promise<URL>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve(new URL(`${tls ? 'https' : 'http'}://127.0.0.1:${addr.port}`));
    });
  });

  return { url: baseUrl.toString(), stop: () => server.close() };
}
