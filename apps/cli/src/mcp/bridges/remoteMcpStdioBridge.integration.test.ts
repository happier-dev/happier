import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod/mini';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { resolveNodeBackedMcpServerCommand } from '@/mcp/runtime/resolveNodeBackedMcpServerCommand';
import { createDaemonControlApp } from '@/daemon/controlServer';
import { createConnectedAccountRequestAuthService } from '@/daemon/connectedServices/requestAuth/ConnectedAccountRequestAuthService';
import { parseHttpHeadersRequestAuthMaterial } from '@/daemon/connectedServices/requestAuth/parseHttpHeadersRequestAuthMaterial';
import { createConnectedAccountRequestAuthSubjectRegistry } from '@/daemon/connectedServices/requestAuth/ConnectedAccountRequestAuthSubjectRegistry';
import { CONNECTED_ACCOUNT_REQUEST_AUTH_LOOKUP_PATH } from '@happier-dev/protocol/connect/connected-account-request-auth';
import { HOST_CONNECTED_ACCOUNT_SERVICE_REF_V1 } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import { MCP_REQUEST_AUTH_PURPOSE } from '@/mcp/runtime/mcpRequestAuth';
import { createEphemeralTlsServerFixture, type EphemeralTlsServerFixture } from '../../../../../packages/tests/src/testkit/tls/ephemeralTlsServerFixture.mjs';
import { McpServerCatalogEntryV1Schema, McpServersSettingsV1Schema, projectMcpServerMaterializationV1,
  resolveSessionCapabilitiesV1, sealSavedSecretResourceStoredContentV1, SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol';
import { createSavedSecretMaterializerV1 } from '@/settings/secrets/savedSecretCatalog';
import { materializeMcpServerConfigRecord } from '@/mcp/servers/materializeMcpServerConfigRecord';
import { publishAgentLaunchMaterials } from '@/daemon/agentIsolation/agentLaunchShim';

const bridgePurpose = MCP_REQUEST_AUTH_PURPOSE;

async function startBridgeRequestAuth(root: string, resource: string, credentialHeaders: Readonly<Record<string, string>> = {}) {
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

function resolveEnvRecord(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

async function resolveRemoteBridgeInvocation(): Promise<{
  command: string;
  args: string[];
  env?: Record<string, string>;
}> {
  const invocation = await resolveNodeBackedMcpServerCommand({
    distEntrypointSegments: ['mcp', 'bridges', 'remoteMcpStdioBridge.mjs'],
    sourceEntrypointSegments: ['mcp', 'bridges', 'remoteMcpStdioBridge.ts'],
    preferSourceEntrypoint: true,
  });
  return { ...invocation, args: ['--conditions=happier-source', ...invocation.args] };
}

async function waitForJsonRpcResponse(
  child: ChildProcessWithoutNullStreams,
  id: number,
  // Source startup shares the integration lane's 60-second budget.
  timeoutMs = 60_000,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let buffer = '';
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for JSON-RPC response ${id}`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off('data', onData);
      child.off('exit', onExit);
      child.off('error', onError);
    };
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        try {
          const message = JSON.parse(line) as Readonly<{ id?: unknown }>;
          if (message.id === id) {
            cleanup();
            resolve();
            return;
          }
        } catch {
          // Keep reading until a complete JSON-RPC response arrives.
        }
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`Bridge exited before JSON-RPC response ${id}: ${code ?? signal ?? 'unknown'}`));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    child.stdout.on('data', onData);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

async function waitForChildExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs = 3_000,
): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  return await new Promise<number | null>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for remote MCP bridge process to exit'));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      child.off('exit', onExit);
      child.off('error', onError);
    };
    const onExit = (code: number | null) => {
      cleanup();
      resolve(code);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

function respondToLocalInventoryProbe(request: IncomingMessage, response: ServerResponse): boolean {
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

async function startTestMcpHttpServer(onRequest?: (req: IncomingMessage, res: ServerResponse) => boolean, tls?: EphemeralTlsServerFixture, toolResult?: (request: IncomingMessage) => CallToolResult): Promise<{ url: string; stop: () => void }> {
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

async function startTestMcpSseServer(tls?: EphemeralTlsServerFixture, observe?: (request: IncomingMessage) => void, endpoint = '/message', onRequest?: (request: IncomingMessage, response: ServerResponse) => boolean): Promise<{ url: string; stop: () => void }> {
  const transportsBySessionId = new Map<string, { transport: SSEServerTransport; mcp: McpServer }>();

  const server = tls ? createSecureServer({ key: await readFile(tls.privateKeyPath), cert: await readFile(tls.leafCertificatePath) }) : createServer();
  server.on('request', async (req, res) => {
    if (respondToLocalInventoryProbe(req, res)) return;
    observe?.(req);
    if (onRequest && !onRequest(req, res)) return;
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = url.pathname;

    if (req.method === 'GET' && pathname === '/sse') {
      if (endpoint !== '/message') {
        // The SDK server strips the origin from absolute endpoints. Exercise
        // an untrusted peer's actual advertised bytes at the HTTP boundary.
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.write(`event: endpoint\ndata: ${endpoint}\n\n`);
        return;
      }
      const mcp = new McpServer({ name: 'test-mcp-sse', version: '1.0.0' });
      mcp.registerTool(
        'echo',
        {
          description: 'Echo',
          inputSchema: z.looseObject({ text: z.string() }),
          outputSchema: z.object({ echoed: z.string() }),
          annotations: { readOnlyHint: true },
          _meta: { 'acme.example/source': 'sse-integration-test' },
        } as any,
        async (args: any) => ({
          content: [{ type: 'text' as const, text: String(args?.text ?? '') }],
          structuredContent: { echoed: String(args?.text ?? '') },
          isError: false as const,
        }),
      );

      const transport = new SSEServerTransport(endpoint, res);
      transportsBySessionId.set(transport.sessionId, { transport, mcp });

      res.once('close', () => {
        transportsBySessionId.delete(transport.sessionId);
        transport.close().catch(() => {});
        Promise.resolve(mcp.close()).catch(() => {});
      });

      await mcp.connect(transport);
      return;
    }

    if (req.method === 'POST' && pathname === '/message') {
      const sessionId = url.searchParams.get('sessionId') ?? '';
      const entry = transportsBySessionId.get(sessionId) ?? null;
      if (!entry) {
        res.writeHead(404).end('unknown session');
        return;
      }
      await entry.transport.handlePostMessage(req as any, res);
      return;
    }

    res.writeHead(404).end();
  });

  const baseUrl = await new Promise<URL>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve(new URL(`${tls ? 'https' : 'http'}://127.0.0.1:${addr.port}`));
    });
  });

  return { url: new URL('/sse', baseUrl).toString(), stop: () => server.close() };
}

describe('remoteMcpStdioBridge', () => {
  it.each([
    ['http', 302, 'lease'], ['http', 307, 'lease'], ['http', 308, 'lease'],
    ['sse', 302, 'lease'], ['sse', 307, 'lease'], ['sse', 308, 'lease'],
    ['http', 302, 'static'], ['sse', 307, 'static'],
  ] as const)('keeps declared request-auth credentials off a cross-origin %s %i redirect (%s)', async (transport, status, source) => {
    const tls = await createEphemeralTlsServerFixture();
    const forwarded: Array<{ privateCredential: boolean; authorization: boolean; publicHeader: boolean }> = [];
    const other = createServer((request, response) => {
      if (respondToLocalInventoryProbe(request, response)) return;
      forwarded.push({ privateCredential: request.headers['x-mcp-declared-credential'] !== undefined,
        authorization: request.headers.authorization !== undefined,
        publicHeader: request.headers.accept !== undefined });
      request.resume();
      response.writeHead(400).end();
    });
    await new Promise<void>(resolve => other.listen(0, '127.0.0.1', resolve));
    const otherAddress = other.address();
    if (!otherAddress || typeof otherAddress === 'string') throw new Error('Other origin unavailable');
    let initialCredentialReceived = false;
    const remote = await startTestMcpHttpServer((request, response) => {
      initialCredentialReceived ||= request.headers['x-mcp-declared-credential'] === 'fixture-mcp-credential';
      request.resume();
      response.writeHead(status, { Location: `http://127.0.0.1:${otherAddress.port}/target` }).end();
      return false;
    }, tls);
    const root = await mkdtemp(join(tmpdir(), 'happier-mcp-auth-redirect-'));
    const credentialHeaders = { 'X-Mcp-Declared-Credential': 'fixture-mcp-credential' };
    const auth = source === 'lease' ? await startBridgeRequestAuth(root, remote.url, credentialHeaders) : undefined;
    const client = new Client({ name: 'auth-redirect-test', version: '1' });
    try {
      const invocation = await resolveRemoteBridgeInvocation();
      const configPath = join(root, 'bridge.json');
      await writeFile(configPath, JSON.stringify({ transport, url: remote.url,
        headers: source === 'static' ? credentialHeaders : {},
        ...(auth ? { auth: { capabilityFile: auth.capabilityFile, resource: remote.url } } : {}) }), { mode: 0o600 });
      await expect(client.connect(new StdioClientTransport({ ...invocation, stderr: 'pipe', env: {
        ...resolveEnvRecord(), ...invocation.env, NODE_EXTRA_CA_CERTS: tls.caCertificatePath,
        HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE: configPath,
      } }))).rejects.toThrow();
      expect(initialCredentialReceived).toBe(true);
      // Streamable HTTP's 307/308 POST body is refused by the shared policy.
      // SSE GETs and HTTP's body-dropping 302 must actually reach the other origin.
      if (transport === 'sse' || status === 302) expect(forwarded.length).toBeGreaterThan(0);
      expect(forwarded.some(request => request.privateCredential)).toBe(false);
      expect(forwarded.every(request => !request.authorization && request.publicHeader)).toBe(true);
    } finally {
      await client.close().catch(() => undefined);
      await auth?.stop(); remote.stop();
      other.closeAllConnections(); await new Promise<void>(resolve => other.close(() => resolve()));
      await rm(root, { recursive: true, force: true }); await tls.cleanup();
    }
  });

  it.each([
    ['http', 'lease'], ['sse', 'lease'], ['http', 'static'], ['sse', 'static'],
  ] as const)('preserves declared request-auth credentials through a same-origin %s redirect (%s)', async (transport, source) => {
    const tls = await createEphemeralTlsServerFixture();
    const received: boolean[] = [];
    const intercept = (request: IncomingMessage, response: ServerResponse) => {
      received.push(request.headers['x-mcp-declared-credential'] === 'fixture-mcp-credential'
        && (source === 'static' || request.headers.authorization === 'Bearer bearer-0'));
      if (request.url === '/redirect') {
        request.resume();
        response.writeHead(307, { Location: transport === 'http' ? '/mcp' : '/sse' }).end();
        return false;
      }
      return true;
    };
    const remote = transport === 'http' ? await startTestMcpHttpServer(intercept, tls)
      : await startTestMcpSseServer(tls, undefined, '/message', intercept);
    const resource = new URL('/redirect', remote.url).href;
    const root = await mkdtemp(join(tmpdir(), 'happier-mcp-auth-same-origin-'));
    const credentialHeaders = { 'X-Mcp-Declared-Credential': 'fixture-mcp-credential' };
    const auth = source === 'lease' ? await startBridgeRequestAuth(root, resource, credentialHeaders) : undefined;
    const client = new Client({ name: 'auth-same-origin-test', version: '1' });
    try {
      const invocation = await resolveRemoteBridgeInvocation();
      const configPath = join(root, 'bridge.json');
      await writeFile(configPath, JSON.stringify({ transport, url: resource,
        headers: source === 'static' ? credentialHeaders : {},
        ...(auth ? { auth: { capabilityFile: auth.capabilityFile, resource } } : {}) }), { mode: 0o600 });
      await client.connect(new StdioClientTransport({ ...invocation, stderr: 'pipe', env: {
        ...resolveEnvRecord(), ...invocation.env, NODE_EXTRA_CA_CERTS: tls.caCertificatePath,
        HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE: configPath,
      } }));
      const result = await client.callTool({ name: 'echo', arguments: { text: 'same-origin' } });
      expect(result.structuredContent).toEqual({ echoed: 'same-origin' });
      expect(received.length).toBeGreaterThan(1);
      expect(received.every(Boolean)).toBe(true);
    } finally {
      await client.close().catch(() => undefined); await auth?.stop(); remote.stop();
      await rm(root, { recursive: true, force: true }); await tls.cleanup();
    }
  });

  it('uses the frame-selected OAuth capability through the actual bridge after the daemon file becomes inaccessible', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-mcp-native-oauth-'));
    const issuerRoot = join(root, 'issuer');
    const agentHome = join(root, 'agent');
    await mkdir(issuerRoot, { mode: 0o700 });
    await mkdir(agentHome, { mode: 0o700 });
    const tls = await createEphemeralTlsServerFixture();
    const received: string[] = [];
    const remote = await startTestMcpHttpServer(request => {
      received.push(String(request.headers.authorization ?? ''));
      return true;
    }, tls);
    const auth = await startBridgeRequestAuth(issuerRoot, remote.url);
    const client = new Client({ name: 'selected-native-oauth', version: '1' });
    let projected: Awaited<ReturnType<typeof materializeMcpServerConfigRecord>> | undefined;
    let retainedIssuerFile = false;
    const retainedPath = `${auth.capabilityFile}.retained`;
    try {
      const settings = McpServersSettingsV1Schema.parse({ v: 1, strictMode: true,
        servers: [{ id: 'oauth', name: 'oauth', transport: 'http',
          remote: { url: remote.url, headers: {}, auth: { kind: 'oauth' } }, env: {}, createdAt: 1, updatedAt: 1 }],
        bindings: [{ id: 'on', serverId: 'oauth', enabled: true, target: { t: 'allMachines' }, createdAt: 1, updatedAt: 1 }] });
      const runtimeHome = join(agentHome, 'runtime', 'session');
      const invocation = await resolveRemoteBridgeInvocation();
      projected = await materializeMcpServerConfigRecord({
        resolved: projectMcpServerMaterializationV1(resolveSessionCapabilitiesV1({
          context: { machineId: 'machine', directory: root, machinePlatform: null, projectKey: null, agentId: null },
          mcp: settings, skills: null, selection: {}, agentAcceptsUserMcp: true,
        }), root),
        tmpDir: null, processEnv: {}, agentLaunchTarget: { runtimeHome },
        requestAuthByServerId: { oauth: { capabilityFile: auth.capabilityFile, resource: remote.url } },
        deps: { resolveRemoteBridgeCommand: () => invocation },
      });
      const launch = projected.mcpServers.oauth!;
      await publishAgentLaunchMaterials({ v: 1, executable: launch.command, args: launch.args ?? [], cwd: root,
        runtimeHome, environment: launch.env ?? {}, selectedMaterials: projected.selectedMaterials ?? [] }, agentHome);
      await rename(auth.capabilityFile, retainedPath); retainedIssuerFile = true;
      await client.connect(new StdioClientTransport({ ...launch, env: { ...resolveEnvRecord(), ...launch.env,
        NODE_EXTRA_CA_CERTS: tls.caCertificatePath } }));
      expect((await client.listTools()).tools.map(tool => tool.name)).toContain('echo');
      const called = await client.callTool({ name: 'echo', arguments: { text: 'selected-capability' } });
      expect(called.isError).not.toBe(true);
      expect(called.structuredContent).toEqual({ echoed: 'selected-capability' });
      expect(received.length > 0 && received.every(header => header === 'Bearer bearer-0')).toBe(true);
      expect(auth.counts().lookups).toBeGreaterThan(0);
    } finally {
      try { await client.close(); }
      finally {
        try {
          projected?.cleanup();
          if (retainedIssuerFile) await rename(retainedPath, auth.capabilityFile);
        } finally {
          try { await auth.stop(); }
          finally {
            remote.stop();
            try { await rm(root, { recursive: true, force: true }); }
            finally { await tls.cleanup(); }
          }
        }
      }
    }
  });

  it.each(['http', 'sse'] as const)('keeps static-header credentials private when a redirected %s bridge cannot initialize', async transport => {
    let requests = 0;
    let redirectedRequests = 0;
    let redirectedCredential = false;
    const upstream = createServer((request, response) => {
      request.resume();
      if (request.url?.startsWith('/redirected')) {
        redirectedRequests += 1;
        redirectedCredential ||= request.headers.authorization !== undefined;
        response.end('{}');
      } else {
        requests += 1;
        const address = upstream.address();
        if (!address || typeof address === 'string') throw new Error('Missing server address');
        response.writeHead(transport === 'http' ? 307 : 302, { location: `http://localhost:${address.port}/redirected?private=hidden` });
        response.end();
      }
    });
    await new Promise<void>(resolve => upstream.listen(0, resolve));
    const root = await mkdtemp(join(tmpdir(), 'happier-mcp-redirect-'));
    let child: ChildProcessWithoutNullStreams | undefined;
    try {
      const address = upstream.address();
      if (!address || typeof address === 'string') throw new Error('Missing server address');
      const configPath = join(root, 'bridge.json');
      await writeFile(configPath, JSON.stringify({ transport, url: `http://127.0.0.1:${address.port}/mcp`,
        headers: { authorization: 'Bearer static-test-authority' } }), { mode: 0o600 });
      const invocation = await resolveRemoteBridgeInvocation();
      child = spawn(invocation.command, invocation.args, { env: { ...resolveEnvRecord(), ...invocation.env,
        HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE: configPath }, stdio: ['pipe', 'pipe', 'pipe'] });
      let diagnostic = '';
      child.stderr.on('data', chunk => { diagnostic += String(chunk); });
      await expect(waitForChildExit(child, 60_000)).resolves.toBe(1);
      if (transport === 'http') {
        expect(diagnostic).toContain('credential_request_redirect_refused');
        expect(diagnostic).toContain('retryable=false');
      }
      expect(diagnostic).not.toContain('private=hidden');
      expect(diagnostic).not.toContain('static-test-authority');
      expect(requests).toBe(1);
      expect(redirectedRequests).toBe(transport === 'http' ? 0 : 1);
      expect(redirectedCredential).toBe(false);
    } finally {
      if (child && child.exitCode === null) {
        child.kill('SIGKILL');
        await waitForChildExit(child).catch(() => undefined);
      }
      upstream.closeAllConnections();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }, 90_000);

  it('initializes before discovering tools and preserves upstream tool pages and metadata through stdio', async () => {
    const cursors: Array<string | undefined> = [];
    let initialized = false;
    const upstream = createServer(async (request, response) => {
      const server = new Server({ name: 'upstream-pagination-fixture', version: '7.2.1' }, {
        capabilities: { tools: {} }, instructions: 'Use the upstream instructions.',
      });
      server.setRequestHandler(ListToolsRequestSchema, async message => {
        if (!initialized) throw new Error('Tool discovery must follow the downstream initialize response');
        cursors.push(message.params?.cursor);
        return message.params?.cursor === undefined
          ? { tools: [{ name: 'first', inputSchema: { type: 'object' as const } }], nextCursor: 'page-two' }
          : { tools: [{ name: 'second', inputSchema: { type: 'object' as const } }] };
      });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      response.once('close', () => { void transport.close(); void server.close(); });
      await server.connect(transport);
      await transport.handleRequest(request, response);
    });
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const root = await mkdtemp(join(tmpdir(), 'happier-mcp-bridge-pages-'));
    const client = new Client({ name: 'paginated-bridge-consumer', version: '1' });
    try {
      const address = upstream.address();
      if (!address || typeof address === 'string') throw new Error('Upstream address unavailable');
      const configPath = join(root, 'bridge.json');
      await writeFile(configPath, JSON.stringify({ transport: 'http', url: `http://127.0.0.1:${address.port}/mcp` }), { mode: 0o600 });
      const invocation = await resolveRemoteBridgeInvocation();
      await client.connect(new StdioClientTransport({ ...invocation,
        env: { ...resolveEnvRecord(), ...invocation.env, HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE: configPath } }));
      initialized = true;
      expect(cursors).toEqual([]);
      const first = await client.listTools();
      const second = await client.listTools({ cursor: first.nextCursor });
      expect.soft([...first.tools, ...second.tools].map(tool => tool.name)).toEqual(['first', 'second']);
      expect.soft(cursors).toEqual([undefined, 'page-two']);
      expect.soft(client.getServerVersion()).toEqual({ name: 'upstream-pagination-fixture', version: '7.2.1' });
      expect.soft(client.getInstructions()).toBe('Use the upstream instructions.');
    } finally {
      await client.close().catch(() => undefined);
      upstream.closeAllConnections();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });
  it('keeps a materialized URL template secret private through real transport failures and tool output', async () => {
    const secret = 'saved-url-template-key';
    const tls = await createEphemeralTlsServerFixture();
    let failTransport = false;
    let receivedKey = '';
    const remote = await startTestMcpHttpServer((request, response) => {
      receivedKey = new URL(request.url ?? '/', 'https://fixture.test').searchParams.get('api_key') ?? '';
      if (!failTransport) return true;
      response.writeHead(500, { 'Content-Type': 'text/plain' }).end(`Remote failure for ${receivedKey}`);
      return false;
    }, tls, () => ({ content: [{ type: 'text', text: `Tool failure for ${receivedKey}` }],
      structuredContent: { echoed: receivedKey }, isError: true }));
    const root = await mkdtemp(join(tmpdir(), 'happier-mcp-url-template-redaction-'));
    const client = new Client({ name: 'url-template-bridge-test', version: '1' });
    let materialized: Awaited<ReturnType<typeof materializeMcpServerConfigRecord>> | undefined;
    try {
      const config = McpServerCatalogEntryV1Schema.parse({ id: 'remote', name: 'remote', transport: 'http',
        remote: { url: remote.url, headers: {}, urlTemplate: { t: 'template', template: `${remote.url}?api_key={key}`,
          vars: { key: { t: 'savedSecret', secretId: 'happier:shared-secret:v1:url-key' } } } },
        env: {}, createdAt: 1, updatedAt: 1 });
      const invocation = await resolveRemoteBridgeInvocation();
      materialized = await materializeMcpServerConfigRecord({
        resolved: { strictMode: true, directory: root, serversByName: { remote: {
          enabled: true, serverId: 'remote', name: 'remote', bindingId: 'on', config,
        } } }, tmpDir: root, processEnv: {}, deps: { resolveRemoteBridgeCommand: () => invocation },
        savedSecretMaterializer: createSavedSecretMaterializerV1({ accountSettings: {}, settingsSecretsReadKeys: [],
          resourceCatalogState: 'ready', resources: [{ resourceId: 'url-key', ownerAccountId: 'owner', displayName: 'key',
            kind: 'token', encryptionMode: 'plain', revision: 1, materialStatus: 'ready',
            storedContent: sealSavedSecretResourceStoredContentV1({ resourceId: 'url-key', mode: 'plain',
              content: { v: 1, name: 'key', kind: 'token', value: secret } }) }] }),
      });
      expect(JSON.stringify(materialized.mcpServers)).not.toContain(secret);
      const bridge = materialized.mcpServers.remote!;
      await client.connect(new StdioClientTransport({ command: bridge.command, args: bridge.args,
        env: { ...resolveEnvRecord(), ...bridge.env, NODE_EXTRA_CA_CERTS: tls.caCertificatePath } }));
      const result = await client.callTool({ name: 'echo', arguments: { text: 'ordinary argument' } });
      expect(receivedKey).toBe(secret);
      expect(result.content).toEqual([{ type: 'text', text: 'Tool failure for [REDACTED]' }]);
      expect(result.structuredContent).toEqual({ echoed: '[REDACTED]' });
      failTransport = true;
      const failure = await client.callTool({ name: 'echo', arguments: { text: 'ordinary argument' } });
      expect(failure.isError).toBe(true);
      expect(JSON.stringify(failure)).toContain('Remote failure for [REDACTED]');
      expect(JSON.stringify(failure)).not.toContain(secret);
    } finally {
      await client.close().catch(() => undefined); materialized?.cleanup(); remote.stop();
      await rm(root, { recursive: true, force: true }); await tls.cleanup();
    }
  });
  it('redacts a saved static API-key header echoed in a fatal HTTPS transport error', async () => {
    const secret = 'saved-static-api-key';
    const tls = await createEphemeralTlsServerFixture();
    const remote = await startTestMcpHttpServer((request, response) => {
      response.writeHead(500, { 'Content-Type': 'text/plain' }).end(`Remote failure for ${String(request.headers['x-api-key'])}`);
      return false;
    }, tls);
    const root = await mkdtemp(join(tmpdir(), 'happier-mcp-static-fatal-redaction-'));
    let child: ChildProcessWithoutNullStreams | null = null;
    try {
      const invocation = await resolveRemoteBridgeInvocation();
      const configPath = join(root, 'bridge.json');
      await writeFile(configPath, JSON.stringify({ transport: 'http', url: remote.url, headers: { 'X-Api-Key': secret } }), { mode: 0o600 });
      child = spawn(invocation.command, invocation.args, { env: { ...resolveEnvRecord(), ...invocation.env, NODE_EXTRA_CA_CERTS: tls.caCertificatePath, HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE: configPath }, stdio: ['pipe', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += String(chunk); });
      expect(await waitForChildExit(child, 30_000)).not.toBe(0);
      expect(stderr).toContain('Remote failure for');
      expect(stderr).not.toContain(secret);
      expect(stderr).toContain('[REDACTED]');
    } finally {
      if (child && child.exitCode === null) { child.kill('SIGKILL'); await waitForChildExit(child).catch(() => undefined); }
      remote.stop(); await rm(root, { recursive: true, force: true }); await tls.cleanup();
    }
  });

  it.each([
    { name: 'API-key', header: 'X-Api-Key', value: 'result', echoed: 'result', forms: ['result'] },
    { name: 'Bearer', header: 'Authorization', value: 'Bearer text', echoed: 'text', forms: ['Bearer text', 'text'] },
    { name: 'Basic', header: 'Authorization', value: `Basic ${Buffer.from('ordinary-user:content').toString('base64')}`, echoed: 'content',
      forms: [`Basic ${Buffer.from('ordinary-user:content').toString('base64')}`, Buffer.from('ordinary-user:content').toString('base64'), 'ordinary-user:content', 'content'] },
  ])('redacts a saved static $name credential echoed in a forwarded MCP tool error', async ({ header, value, echoed, forms }) => {
    const tls = await createEphemeralTlsServerFixture();
    let receivedValue = '';
    const remote = await startTestMcpHttpServer(request => {
      receivedValue = String(request.headers[header.toLowerCase()] ?? '');
      return true;
    }, tls, () => ({
      content: [{ type: 'text', text: `Tool failure for ${echoed}` }],
      structuredContent: { echoed, [echoed]: 'ordinary value', nested: { [echoed]: forms }, username: 'ordinary-user' },
      _meta: { [echoed]: value },
      isError: true,
    }));
    const root = await mkdtemp(join(tmpdir(), 'happier-mcp-static-tool-redaction-'));
    const client = new Client({ name: 'static-redaction-bridge-test', version: '1' });
    try {
      const invocation = await resolveRemoteBridgeInvocation();
      const configPath = join(root, 'bridge.json');
      await writeFile(configPath, JSON.stringify({ transport: 'http', url: remote.url, headers: { [header]: value } }), { mode: 0o600 });
      await client.connect(new StdioClientTransport({ ...invocation, env: { ...resolveEnvRecord(), ...invocation.env, NODE_EXTRA_CA_CERTS: tls.caCertificatePath, HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE: configPath } }));
      const result = await client.callTool({ name: 'echo', arguments: { text: 'ordinary argument' } });
      expect(receivedValue).toBe(value);
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([{ type: 'text', text: 'Tool failure for [REDACTED]' }]);
      expect(result.structuredContent).toEqual({
        echoed: '[REDACTED]', '[REDACTED]': 'ordinary value',
        nested: { '[REDACTED]': forms.map(() => '[REDACTED]') }, username: 'ordinary-user',
      });
      expect(result._meta).toEqual({ '[REDACTED]': '[REDACTED]' });
    } finally { await client.close().catch(() => undefined); remote.stop(); await rm(root, { recursive: true, force: true }); await tls.cleanup(); }
  });

  it('redacts a known OAuth bearer echoed in a fatal HTTPS transport error', async () => {
    const tls = await createEphemeralTlsServerFixture();
    const remote = await startTestMcpHttpServer((request, response) => {
      response.writeHead(500, { 'Content-Type': 'text/plain' }).end(`Remote failure for ${String(request.headers.authorization).slice(7)}`);
      return false;
    }, tls);
    const root = await mkdtemp(join(tmpdir(), 'happier-mcp-fatal-redaction-'));
    const auth = await startBridgeRequestAuth(root, remote.url);
    let child: ChildProcessWithoutNullStreams | null = null;
    try {
      const invocation = await resolveRemoteBridgeInvocation();
      const configPath = join(root, 'bridge.json');
      await writeFile(configPath, JSON.stringify({ transport: 'http', url: remote.url, auth: { capabilityFile: auth.capabilityFile, resource: remote.url } }), { mode: 0o600 });
      child = spawn(invocation.command, invocation.args, { env: { ...resolveEnvRecord(), ...invocation.env, NODE_EXTRA_CA_CERTS: tls.caCertificatePath, HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE: configPath }, stdio: ['pipe', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += String(chunk); });
      expect(await waitForChildExit(child, 30_000)).not.toBe(0);
      expect(stderr).toContain('Remote failure for');
      expect(stderr).not.toContain('bearer-0');
      expect(stderr).toContain('[REDACTED]');
    } finally {
      if (child && child.exitCode === null) { child.kill('SIGKILL'); await waitForChildExit(child).catch(() => undefined); }
      await auth.stop(); remote.stop(); await rm(root, { recursive: true, force: true }); await tls.cleanup();
    }
  });

  it('redacts known OAuth bearers in forwarded transport and MCP tool error results', async () => {
    const tls = await createEphemeralTlsServerFixture();
    let transportError = false;
    const remote = await startTestMcpHttpServer((request, response) => {
      if (!transportError) return true;
      response.writeHead(500, { 'Content-Type': 'text/plain' }).end(`Remote failure for ${String(request.headers.authorization).slice(7)}`);
      return false;
    }, tls, request => ({ content: [{ type: 'text', text: `Tool failure for ${String(request.headers.authorization).slice(7)}` }], structuredContent: { echoed: String(request.headers.authorization).slice(7) }, isError: true }));
    const root = await mkdtemp(join(tmpdir(), 'happier-mcp-tool-redaction-'));
    const auth = await startBridgeRequestAuth(root, remote.url);
    const client = new Client({ name: 'redaction-bridge-test', version: '1' });
    try {
      const invocation = await resolveRemoteBridgeInvocation();
      const configPath = join(root, 'bridge.json');
      await writeFile(configPath, JSON.stringify({ transport: 'http', url: remote.url, auth: { capabilityFile: auth.capabilityFile, resource: remote.url } }), { mode: 0o600 });
      const transport = new StdioClientTransport({ ...invocation, stderr: 'pipe', env: { ...resolveEnvRecord(), ...invocation.env, NODE_EXTRA_CA_CERTS: tls.caCertificatePath, HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE: configPath } });
      let stderr = '';
      transport.stderr?.on('data', chunk => { stderr += String(chunk); });
      await client.connect(transport);
      const toolError = await client.callTool({ name: 'echo', arguments: { text: 'ordinary argument' } });
      expect(toolError.isError).toBe(true);
      expect(JSON.stringify(toolError)).not.toContain('bearer-0');
      expect(toolError.structuredContent).toEqual({ echoed: '[REDACTED]' });
      auth.rotate();
      transportError = true;
      const httpError = await client.callTool({ name: 'echo', arguments: { text: 'ordinary argument' } });
      expect(httpError.isError).toBe(true);
      expect(JSON.stringify(httpError)).not.toContain('bearer-1');
      expect(JSON.stringify(httpError)).toContain('[REDACTED]');
      expect(stderr).not.toContain('bearer-0');
      expect(stderr).not.toContain('bearer-1');
    } finally { await client.close().catch(() => undefined); await auth.stop(); remote.stop(); await rm(root, { recursive: true, force: true }); await tls.cleanup(); }
  });
  it('refuses a different configured resource before requesting a bearer or reaching the MCP server', async () => {
    const tls = await createEphemeralTlsServerFixture();
    const remoteRequests: Array<{ method: string | undefined; path: string | undefined; accept: string | undefined; authorization: string | undefined; connection: string | undefined }> = [];
    const remote = await startTestMcpHttpServer(request => {
      remoteRequests.push({ method: request.method, path: request.url, accept: request.headers.accept,
        authorization: request.headers.authorization, connection: request.headers.connection });
      return true;
    }, tls);
    const root = await mkdtemp(join(tmpdir(), 'happier-mcp-resource-'));
    const auth = await startBridgeRequestAuth(root, remote.url);
    const invocation = await resolveRemoteBridgeInvocation();
    const configPath = join(root, 'bridge.json');
    await writeFile(configPath, JSON.stringify({ transport: 'http', url: remote.url, auth: { capabilityFile: auth.capabilityFile, resource: new URL('/different', remote.url).href } }), { mode: 0o600 });
    const client = new Client({ name: 'wrong-resource-test', version: '1' });
    try {
      await expect(client.connect(new StdioClientTransport({ ...invocation, env: { ...resolveEnvRecord(), ...invocation.env, NODE_EXTRA_CA_CERTS: tls.caCertificatePath, HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE: configPath } }))).rejects.toThrow();
      expect(remoteRequests).toEqual([]);
      expect(auth.counts().lookups).toBe(0);
    } finally { await client.close().catch(() => undefined); await auth.stop(); remote.stop(); await rm(root, { recursive: true, force: true }); await tls.cleanup(); }
  });
  it('looks up a bearer for every HTTP request and reports only one 401 before retrying', async () => {
    const tls = await createEphemeralTlsServerFixture();
    const received: string[] = [];
    let rejectNext = false;
    let rejectAll = false;
    let redirect = false;
    const remote = await startTestMcpHttpServer((request, response) => {
      received.push(String(request.headers.authorization ?? ''));
      if (redirect) {
        if (request.url === '/other-resource') response.writeHead(404).end();
        else response.writeHead(302, { Location: '/other-resource' }).end();
        return false;
      }
      if (rejectNext || rejectAll) { rejectNext = false; response.writeHead(401, { 'WWW-Authenticate': 'Bearer error="invalid_token"' }).end(); return false; }
      return true;
    }, tls);
    const root = await mkdtemp(join(tmpdir(), 'happier-mcp-oauth-'));
    const auth = await startBridgeRequestAuth(root, remote.url);
    const invocation = await resolveRemoteBridgeInvocation();
    const configPath = join(root, 'bridge.json');
    await writeFile(configPath, JSON.stringify({ transport: 'http', url: remote.url, auth: { capabilityFile: auth.capabilityFile, resource: remote.url } }), { mode: 0o600 });
    const client = new Client({ name: 'oauth-bridge-test', version: '1' });
    try {
      await client.connect(new StdioClientTransport({ ...invocation, env: { ...resolveEnvRecord(), ...invocation.env, NODE_EXTRA_CA_CERTS: tls.caCertificatePath, HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE: configPath } }));
      await client.listTools();
      received.splice(0);
      auth.rotate();
      const first = await client.callTool({ name: 'echo', arguments: { text: 'fresh' } });
      expect(first.isError).not.toBe(true);
      expect(received).toEqual(['Bearer bearer-1']);
      received.splice(0);
      rejectNext = true;
      const recovered = await client.callTool({ name: 'echo', arguments: { text: 'retry' } });
      expect(recovered.isError).not.toBe(true);
      expect(received).toEqual(['Bearer bearer-1', 'Bearer bearer-2']);
      expect(auth.counts().reports).toBe(1);
      expect(auth.counts().lookups).toBeGreaterThanOrEqual(received.length);
      received.splice(0);
      rejectAll = true;
      expect((await client.callTool({ name: 'echo', arguments: { text: 'still-invalid' } })).isError).toBe(true);
      expect(received).toEqual(['Bearer bearer-2', 'Bearer bearer-3']);
      expect(auth.counts().reports).toBe(2);
      rejectAll = false;
      received.splice(0);
      redirect = true;
      expect((await client.callTool({ name: 'echo', arguments: { text: 'redirect' } })).isError).toBe(true);
      expect(received).toEqual(['Bearer bearer-3', 'Bearer bearer-3']);
      redirect = false;
      received.splice(0);
      expect((await client.callTool({ name: 'echo', arguments: { text: 'after-redirect' } })).isError).not.toBe(true);
      expect(received).toEqual(['Bearer bearer-3']);
      received.splice(0);
      auth.revoke();
      expect((await client.callTool({ name: 'echo', arguments: { text: 'signed-out' } })).isError).toBe(true);
      expect(received).toEqual([]);
    } finally { await client.close().catch(() => undefined); await auth.stop(); remote.stop(); await rm(root, { recursive: true, force: true }); await tls.cleanup(); }
  });

  it('accepts the OAuth SSE same-origin message endpoint with the bearer still bound to its initial resource', async () => {
    const tls = await createEphemeralTlsServerFixture();
    const received: Array<{ method: string | undefined; path: string; authorization: string; accept: string | undefined; connection: string | undefined }> = [];
    const remote = await startTestMcpSseServer(tls, request => received.push({ method: request.method,
      path: request.url ?? '', authorization: String(request.headers.authorization ?? ''),
      accept: request.headers.accept, connection: request.headers.connection }));
    const root = await mkdtemp(join(tmpdir(), 'happier-mcp-sse-resource-'));
    const auth = await startBridgeRequestAuth(root, remote.url);
    const invocation = await resolveRemoteBridgeInvocation();
    const configPath = join(root, 'bridge.json');
    await writeFile(configPath, JSON.stringify({ transport: 'sse', url: remote.url,
      auth: { capabilityFile: auth.capabilityFile, resource: remote.url } }), { mode: 0o600 });
    const client = new Client({ name: 'sse-resource-test', version: '1' });
    try {
      await client.connect(new StdioClientTransport({ ...invocation, env: { ...resolveEnvRecord(), ...invocation.env, NODE_EXTRA_CA_CERTS: tls.caCertificatePath, HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE: configPath } }));
      expect(await client.callTool({ name: 'echo', arguments: { text: 'same-origin' } })).toMatchObject({ isError: false });
      expect(received[0]).toMatchObject({ path: '/sse', authorization: 'Bearer bearer-0' });
      expect(received.some(request => request.path.startsWith('/message?sessionId='))).toBe(true);
      expect(received.every(request => request.authorization === 'Bearer bearer-0')).toBe(true);
      expect(auth.counts().reports).toBe(0);
    } finally { await client.close().catch(() => undefined); await auth.stop(); remote.stop(); await rm(root, { recursive: true, force: true }); await tls.cleanup(); }
  });

  it('refuses a cross-origin OAuth SSE advertised message endpoint before sending a bearer there', async () => {
    const tls = await createEphemeralTlsServerFixture();
    const crossOriginRequests: string[] = [];
    const other = createServer((request, response) => {
      if (respondToLocalInventoryProbe(request, response)) return;
      crossOriginRequests.push(request.headers.authorization ?? '');
      response.writeHead(404).end();
    });
    await new Promise<void>(resolve => other.listen(0, '127.0.0.1', resolve));
    const otherAddress = other.address();
    if (!otherAddress || typeof otherAddress === 'string') throw new Error('Other origin unavailable');
    const received: Array<{ path: string; authorization: string }> = [];
    const remote = await startTestMcpSseServer(tls,
      request => received.push({ path: request.url ?? '', authorization: String(request.headers.authorization ?? '') }),
      `http://127.0.0.1:${otherAddress.port}/message`);
    const root = await mkdtemp(join(tmpdir(), 'happier-mcp-sse-origin-'));
    const auth = await startBridgeRequestAuth(root, remote.url);
    const invocation = await resolveRemoteBridgeInvocation();
    const configPath = join(root, 'bridge.json');
    await writeFile(configPath, JSON.stringify({ transport: 'sse', url: remote.url,
      auth: { capabilityFile: auth.capabilityFile, resource: remote.url } }), { mode: 0o600 });
    const client = new Client({ name: 'sse-origin-test', version: '1' });
    try {
      await expect(client.connect(new StdioClientTransport({ ...invocation, env: { ...resolveEnvRecord(), ...invocation.env,
        NODE_EXTRA_CA_CERTS: tls.caCertificatePath, HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE: configPath } }))).rejects.toThrow();
      expect(received).toEqual([{ path: '/sse', authorization: 'Bearer bearer-0' }]);
      expect(crossOriginRequests).toEqual([]);
      expect(auth.counts().lookups).toBe(1);
    } finally {
      await client.close().catch(() => undefined); await auth.stop(); remote.stop();
      other.closeAllConnections(); await new Promise<void>(resolve => other.close(() => resolve()));
      await rm(root, { recursive: true, force: true }); await tls.cleanup();
    }
  });

  it('reports a scope challenge and returns a tool error without refreshing or retrying', async () => {
    const tls = await createEphemeralTlsServerFixture();
    let challenge = false;
    let challengedRequests = 0;
    const remote = await startTestMcpHttpServer((_request, response) => {
      if (challenge) { challengedRequests++; response.writeHead(403, { 'WWW-Authenticate': 'Bearer error="insufficient_scope", scope="write read"' }).end(); return false; }
      return true;
    }, tls);
    const root = await mkdtemp(join(tmpdir(), 'happier-mcp-scope-'));
    const auth = await startBridgeRequestAuth(root, remote.url);
    const invocation = await resolveRemoteBridgeInvocation();
    const configPath = join(root, 'bridge.json');
    await writeFile(configPath, JSON.stringify({ transport: 'http', url: remote.url, auth: { capabilityFile: auth.capabilityFile, resource: remote.url } }), { mode: 0o600 });
    const client = new Client({ name: 'scope-bridge-test', version: '1' });
    try {
      await client.connect(new StdioClientTransport({ ...invocation, env: { ...resolveEnvRecord(), ...invocation.env, NODE_EXTRA_CA_CERTS: tls.caCertificatePath, HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE: configPath } }));
      await client.listTools();
      challenge = true;
      const result = await client.callTool({ name: 'echo', arguments: { text: 'write' } });
      expect(result.isError).toBe(true);
      expect(auth.scopes).toEqual(['write', 'read']);
      expect(auth.counts().reports).toBe(0);
      expect(challengedRequests).toBe(1);
    } finally { challenge = false; await client.close().catch(() => undefined); await auth.stop(); remote.stop(); await rm(root, { recursive: true, force: true }); await tls.cleanup(); }
  });
  it('proxies listTools/callTool over streamable http via stdio', async () => {
    const httpServer = await startTestMcpHttpServer();
    const tmp = await mkdtemp(join(tmpdir(), 'happier-mcp-bridge-it-'));
    try {
      const configPath = join(tmp, 'happier-mcp-remote-bridge.it.json');
      await writeFile(
        configPath,
        JSON.stringify({
          transport: 'http',
          url: httpServer.url,
          headers: { 'X-Test': randomUUID() },
        }),
        { mode: 0o600 },
      );

      const bridgeInvocation = await resolveRemoteBridgeInvocation();

      const transport = new StdioClientTransport({
        command: bridgeInvocation.command,
        args: bridgeInvocation.args,
        env: {
          ...resolveEnvRecord(),
          ...(bridgeInvocation.env ?? {}),
          HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE: configPath,
        },
      });

      const client = new Client({ name: 'bridge-test', version: '1.0.0' }, { capabilities: {} });
      await client.connect(transport);

      const tools = await client.listTools(undefined, { timeout: 180_000 });
      const names = (tools.tools ?? []).map((t: any) => String(t.name));
      expect(names).toContain('echo');
      expect(tools.tools.find((tool) => tool.name === 'echo')?.inputSchema).toMatchObject({
        type: 'object',
        properties: {
          text: { type: 'string' },
        },
        required: ['text'],
      });
      expect(tools.tools.find((tool) => tool.name === 'echo')).toMatchObject({
        outputSchema: {
          type: 'object',
          properties: {
            echoed: { type: 'string' },
          },
          required: ['echoed'],
        },
        annotations: { readOnlyHint: true },
        _meta: { 'acme.example/source': 'integration-test' },
      });

      const res = await client.callTool(
        { name: 'echo', arguments: { text: 'hi' } },
        undefined,
        { timeout: 180_000 },
      );
      const text = String((res as any)?.content?.[0]?.text ?? '');
      expect(text).toBe('hi');
      expect(res.structuredContent).toEqual({ echoed: 'hi' });

      await client.close();

      const relaunchedTransport = new StdioClientTransport({
        command: bridgeInvocation.command,
        args: bridgeInvocation.args,
        env: {
          ...resolveEnvRecord(),
          ...(bridgeInvocation.env ?? {}),
          HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE: configPath,
        },
      });
      const relaunchedClient = new Client({ name: 'bridge-relaunch-test', version: '1.0.0' }, { capabilities: {} });
      try {
        await relaunchedClient.connect(relaunchedTransport);
        expect((await relaunchedClient.listTools(undefined, { timeout: 180_000 })).tools.map((tool) => tool.name)).toContain('echo');
      } finally {
        await relaunchedClient.close().catch(() => undefined);
      }
    } finally {
      httpServer.stop();
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('supports SSE transport via stdio bridge', async () => {
    const sseServer = await startTestMcpSseServer();
    const tmp = await mkdtemp(join(tmpdir(), 'happier-mcp-bridge-it-'));
    try {
      const configPath = join(tmp, 'bridge.json');
      await writeFile(
        configPath,
        JSON.stringify({
          transport: 'sse',
          url: sseServer.url,
          headers: {},
        }),
        { mode: 0o600 },
      );

      const bridgeInvocation = await resolveRemoteBridgeInvocation();

      const transport = new StdioClientTransport({
        command: bridgeInvocation.command,
        args: bridgeInvocation.args,
        env: {
          ...resolveEnvRecord(),
          ...(bridgeInvocation.env ?? {}),
          HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE: configPath,
        },
      });

      const client = new Client({ name: 'bridge-test-sse', version: '1.0.0' }, { capabilities: {} });
      await client.connect(transport);

      const tools = await client.listTools(undefined, { timeout: 180_000 });
      expect(tools.tools.find((tool) => tool.name === 'echo')).toMatchObject({
        inputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string' },
          },
          required: ['text'],
        },
        outputSchema: {
          type: 'object',
          properties: {
            echoed: { type: 'string' },
          },
          required: ['echoed'],
        },
        annotations: { readOnlyHint: true },
        _meta: { 'acme.example/source': 'sse-integration-test' },
      });

      const res = await client.callTool(
        { name: 'echo', arguments: { text: 'hi' } },
        undefined,
        { timeout: 180_000 },
      );
      const text = String((res as any)?.content?.[0]?.text ?? '');
      expect(text).toBe('hi');
      expect(res.structuredContent).toEqual({ echoed: 'hi' });

      await client.close();
    } finally {
      sseServer.stop();
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('closes the remote SSE client and exits when the controlling stdio stream ends', async () => {
    const sseServer = await startTestMcpSseServer();
    const tmp = await mkdtemp(join(tmpdir(), 'happier-mcp-bridge-it-'));
    let child: ChildProcessWithoutNullStreams | null = null;
    try {
      const configPath = join(tmp, 'happier-mcp-remote-bridge.it.json');
      await writeFile(
        configPath,
        JSON.stringify({
          transport: 'sse',
          url: sseServer.url,
          headers: {},
        }),
        { mode: 0o600 },
      );
      const bridgeInvocation = await resolveRemoteBridgeInvocation();
      child = spawn(bridgeInvocation.command, bridgeInvocation.args, {
        env: {
          ...resolveEnvRecord(),
          ...(bridgeInvocation.env ?? {}),
          HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE: configPath,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'bridge-eof-test', version: '1.0.0' },
        },
      })}\n`);
      await waitForJsonRpcResponse(child, 1);

      child.stdin.end();

      await expect(waitForChildExit(child)).resolves.toBe(0);
    } finally {
      if (child && child.exitCode === null) {
        child.kill('SIGKILL');
        await waitForChildExit(child).catch(() => undefined);
      }
      sseServer.stop();
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('preserves the config file when startup fails before the remote connect succeeds', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'happier-mcp-bridge-it-'));
    try {
      const configPath = join(tmp, 'happier-mcp-remote-bridge.it.json');
      await writeFile(
        configPath,
        JSON.stringify({
          transport: 'http',
          url: 'http://127.0.0.1:9',
          headers: { Authorization: 'Bearer SHOULD_NOT_PERSIST' },
        }),
        { mode: 0o600 },
      );

      const bridgeInvocation = await resolveRemoteBridgeInvocation();
      const child = spawn(bridgeInvocation.command, bridgeInvocation.args, {
        env: {
          ...resolveEnvRecord(),
          ...(bridgeInvocation.env ?? {}),
          HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE: configPath,
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      });

      const exitCode = await new Promise<number>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => resolve(code ?? -1));
      });

      expect(exitCode).not.toBe(0);
      await expect(access(configPath)).resolves.toBeUndefined();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
