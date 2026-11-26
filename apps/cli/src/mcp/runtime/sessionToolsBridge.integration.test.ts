import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { createEphemeralTlsServerFixture } from '../../../../../packages/tests/src/testkit/tls/ephemeralTlsServerFixture.mjs';
import { codeModeStdioServer, createCodeModePermissionFixture, openCodeModeMcpFixture } from './codeModeMcp.testkit';
import { connectSessionMcpClient } from './sessionMcpLocalClient';
import { SESSION_MCP_TOOL_SOURCES_META_KEY, SESSION_MCP_TOOL_SOURCE_META_KEY } from './sessionMcpLocalContext';
import { respondToLocalInventoryProbe, startBridgeRequestAuth, startTestMcpHttpServer } from '../bridges/remoteMcpBridge.testkit';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const bootstrapNames = ['tools_call', 'tools_describe', 'tools_search'];
const server = {
  ...codeModeStdioServer('records', ['count', 'hidden']),
  tools: { default: 'ask' as const, overrides: { hidden: 'off' as const }, loading: 'on_demand' as const },
};

describe.runIf(process.platform === 'linux')('Session tool bootstrap over the Unix socket', () => {
  it.each([undefined, false, true])('fails closed for the feature bit %s and keeps empty Sessions at zero bootstrap tools', async featureEnabled => {
    vi.stubEnv('HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT', '1');
    const fixture = await openCodeModeMcpFixture({ featureEnabled, servers: [{ ...server,
      tools: { ...server.tools, loading: 'every_turn' },
    }] });
    const connection = await connectSessionMcpClient(fixture.profile.sessionMcpContext!);
    try {
      expect(fixture.profile.mcpServers).toHaveProperty('records');
      expect((await connection.client.listTools()).tools.map(tool => tool.name)
        .filter(name => bootstrapNames.includes(name))).toEqual([]);
    } finally { await connection.close(); await fixture.close(); }
    if (featureEnabled !== true) {
      const lazy = await openCodeModeMcpFixture({ featureEnabled, servers: [server] });
      try { expect(lazy.profile.mcpServers).toHaveProperty('records'); }
      finally { await lazy.close(); }
    }
  });

  it('discovers only exposed custom tools and rejects hidden or unapproved calls over the same Session connection', async () => {
    vi.stubEnv('HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT', '1');
    const fixture = await openCodeModeMcpFixture({ featureEnabled: true, servers: [server] });
    const connection = await connectSessionMcpClient(fixture.profile.sessionMcpContext!);
    try {
      expect(fixture.profile.mcpServers).not.toHaveProperty('records');
      expect((await connection.client.listTools()).tools.map(tool => tool.name)
        .filter(name => bootstrapNames.includes(name)).sort()).toEqual(bootstrapNames);
      const invoke = (name: string, args: Record<string, unknown>) =>
        connection.client.callTool({ name, arguments: args });
      const found = await invoke('tools_search', { query: 'records' });
      expect(found.structuredContent, JSON.stringify(found)).toMatchObject({
        tools: expect.arrayContaining([expect.objectContaining({ source: 'records', tool: 'count' })]),
      });
      const byAlias = await invoke('tools_search', { query: 'session_title_set' });
      expect(byAlias.structuredContent, JSON.stringify(byAlias)).toMatchObject({
        tools: expect.arrayContaining([expect.objectContaining({ source: 'happier', tool: 'session.title.set' })]),
      });
      expect((await invoke('tools_search', { query: 'hidden' })).structuredContent).not.toMatchObject({
        tools: expect.arrayContaining([expect.objectContaining({ source: 'records', tool: 'hidden' })]),
      });
      expect((await invoke('tools_describe', { source: 'records', tool: 'count' })).structuredContent).toMatchObject({
        inputSchema: { required: ['namespace', 'key'] }, signature: expect.stringContaining('namespace'),
      });
      expect((await invoke('tools_call', { source: 'records', tool: 'hidden' })).structuredContent)
        .toMatchObject({ ok: false, errorCode: 'permission_denied' });
      expect((await invoke('tools_call', { source: 'records', tool: 'count' })).structuredContent)
        .toMatchObject({ ok: false, errorCode: 'approval_required' });
    } finally { await connection.close(); await fixture.close(); }
  });

  it('keeps deferred tools out of both discovery paths for a confined Session', async () => {
    vi.stubEnv('HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT', '1');
    const fixture = await openCodeModeMcpFixture({ featureEnabled: true, servers: [server],
      profile: { unlistedTools: 'deny', scriptRunnerEnabled: true },
    });
    const connection = await connectSessionMcpClient(fixture.profile.sessionMcpContext!);
    try {
      expect(fixture.profile.mcpServers).not.toHaveProperty('records');
      const listed = await connection.client.listTools({ _meta: { [SESSION_MCP_TOOL_SOURCES_META_KEY]: true } });
      expect(listed.tools.some(tool => bootstrapNames.includes(tool.name)
        || tool._meta?.[SESSION_MCP_TOOL_SOURCE_META_KEY] === 'records')).toBe(false);
    } finally { await connection.close(); await fixture.close(); }
  });

  it('derives unlistedTools confinement from Session metadata even without explicit profile flag and separates inner approval ids', async () => {
    vi.stubEnv('HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT', '1');
    const confined = await openCodeModeMcpFixture({ featureEnabled: true, servers: [server],
      profile: { scriptRunnerEnabled: true },
      session: { getMetadataSnapshot: () => ({ unlistedTools: 'deny' }) as never },
    });
    const confinedConn = await connectSessionMcpClient(confined.profile.sessionMcpContext!);
    try {
      expect(confined.profile.codeMode).toEqual({ bootstrap: false, scriptRunner: false });
      expect(confined.profile.agentEnvironment?.HAPPIER_CLI_BIN).toBeUndefined();
      const listed = await confinedConn.client.listTools({ _meta: { [SESSION_MCP_TOOL_SOURCES_META_KEY]: true } });
      expect(listed.tools.some(tool => bootstrapNames.includes(tool.name)
        || tool._meta?.[SESSION_MCP_TOOL_SOURCE_META_KEY] === 'records')).toBe(false);
    } finally { await confinedConn.close(); await confined.close(); }

    const handleToolCall = vi.fn(async () => ({ decision: 'approved' as const }));
    const approved = await openCodeModeMcpFixture({ featureEnabled: true, servers: [server],
      profile: { mcpPermissionHandler: { handleToolCall } as never },
    });
    const approvedConn = await connectSessionMcpClient(approved.profile.sessionMcpContext!);
    try {
      const outcome = await approvedConn.client.callTool({
        name: 'tools_call',
        arguments: { source: 'records', tool: 'count', args: { namespace: 'ns', key: 'k' } },
        _meta: { 'happier/tool-call-id': 'outer-call-1' },
      });
      expect(outcome.structuredContent).toMatchObject({ ok: true });
      expect(handleToolCall).toHaveBeenCalledTimes(1);
      const [innerRequestId, wireName] = handleToolCall.mock.calls[0] as unknown as [string, string];
      expect(wireName).toBe('mcp__records__count');
      expect(innerRequestId).not.toBe('outer-call-1');
      expect(innerRequestId).toContain('outer-call-1:');
    } finally { await approvedConn.close(); await approved.close(); }
  });

  it('uses snapshot discovery without a spawn, then retains one process across five calls without rereading Home', async () => {
    vi.stubEnv('HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT', '1');
    const root = await mkdtemp(join(tmpdir(), 'happier-session-code-mode-'));
    const spawnLog = join(root, 'spawns');
    const readExecutionSource = vi.fn(async () => ({ kind: 'local_user' as const }));
    const enqueue = vi.fn(async (_event: unknown) => ({ persisted: true, delivered: true }));
    const network = vi.spyOn(globalThis, 'fetch');
    const { permission, getActiveTurnAdmissionWitness } = createCodeModePermissionFixture();
    const fixture = await openCodeModeMcpFixture({ featureEnabled: true,
      servers: [{
        ...codeModeStdioServer('records', ['count', 'hidden'], spawnLog),
        tools: { default: 'allow_all', overrides: { hidden: 'off' }, loading: 'on_demand' },
        toolsSnapshot: { checkedAt: 1, machineId: 'fixture-machine', tools: [{ name: 'count', tokens: 100 }, { name: 'hidden', tokens: 100 }] },
      }],
      profile: { readExecutionSource, mcpPermissionHandler: permission },
      session: { getActiveTurnAdmissionWitness, enqueueSessionEventCommitted: enqueue },
    });
    const connection = await connectSessionMcpClient(fixture.profile.sessionMcpContext!);
    try {
      const found = await connection.client.callTool({ name: 'tools_search', arguments: { query: 'records', limit: 1 } });
      expect(found.structuredContent, JSON.stringify(found)).toEqual({ tools: [expect.objectContaining({ source: 'records', tool: 'count' })] });
      await expect(access(spawnLog)).rejects.toMatchObject({ code: 'ENOENT' });
      for (let count = 1; count <= 5; count++) {
        const called = await connection.client.callTool({ name: 'tools_call', arguments: { source: 'records', tool: 'count' } });
        expect(called.structuredContent).toMatchObject({ ok: true, result: { content: [{ type: 'text', text: String(count) }] } });
      }
      expect(await readFile(spawnLog, 'utf8')).toBe('spawn\n');
      expect(readExecutionSource).toHaveBeenCalledTimes(1);
      expect(network.mock.calls.filter(([target]) => String(target).includes('code-mode.example.test'))).toHaveLength(0);
      expect(enqueue.mock.calls.filter(([event]) => (event as { type?: string }).type === 'mcp-binding-usage'))
        .toHaveLength(5);
    } finally {
      await connection.close();
      await fixture.close();
      await permission.reset();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('leases and redacts HTTP credentials in process and protects the lease on refusal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-session-code-mode-remote-'));
    const tls = await createEphemeralTlsServerFixture();
    const previousCa = getCACertificates('default');
    setDefaultCACertificates([...previousCa, await readFile(tls.caCertificatePath, 'utf8')]);
    const seen: Array<{ bearer?: string; privateHeader: unknown }> = [];
    const redirectTarget = createServer((req, res) => {
      if (respondToLocalInventoryProbe(req, res)) return;
      seen.push({ bearer: req.headers.authorization, privateHeader: req.headers['x-code-mode-key'] });
      req.resume();
      res.writeHead(400).end();
    });
    await new Promise<void>(resolve => redirectTarget.listen(0, '127.0.0.1', resolve));
    const address = redirectTarget.address();
    if (!address || typeof address === 'string') throw new Error('Missing redirect endpoint');
    let reject: 'once' | 'bearer' | 'scope' | 'redirect' | undefined;
    const remote = await startTestMcpHttpServer((req, res) => {
      if (reject === 'once' || reject === 'bearer') {
        if (reject === 'once') reject = undefined;
        res.writeHead(401, { 'WWW-Authenticate': 'Bearer error="invalid_token"' }).end();
        return false;
      }
      if (reject === 'scope') {
        res.writeHead(403, { 'WWW-Authenticate': 'Bearer error="insufficient_scope", scope="read write"' }).end();
        return false;
      }
      if (reject === 'redirect') {
        res.writeHead(307, { Location: `http://127.0.0.1:${address.port}/target` }).end();
        return false;
      }
      return true;
    }, tls, req => ({
      content: [{ type: 'text', text: String(req.headers['x-code-mode-key']) }],
      structuredContent: { echoed: String(req.headers.authorization) },
    }));
    const auth = await startBridgeRequestAuth(root, remote.url, { 'x-code-mode-key': 'private-fixture-header' });
    const { permission, getActiveTurnAdmissionWitness } = createCodeModePermissionFixture();
    const fixture = await openCodeModeMcpFixture({ featureEnabled: true,
      servers: [{
        id: 'remote', name: 'remote', transport: 'http',
        remote: { url: remote.url, headers: {}, auth: { kind: 'oauth' } },
        env: {}, createdAt: 1, updatedAt: 1, tools: { default: 'allow_all', overrides: {}, loading: 'on_demand' },
      }],
      profile: { mcpPermissionHandler: permission },
      session: { getActiveTurnAdmissionWitness, getMcpRequestAuthPort: () => ({
        open: async () => ({ capabilityFile: auth.capabilityFile, resource: remote.url }),
        close: async () => undefined,
      }) },
    });
    const connection = await connectSessionMcpClient(fixture.profile.sessionMcpContext!);
    try {
      expect(fixture.profile.mcpServers).not.toHaveProperty('remote');
      expect(auth.counts()).toEqual({ reports: 0, lookups: 0 });
      const call = async () => (await connection.client.callTool({ name: 'tools_call',
        arguments: { source: 'remote', tool: 'echo', args: { text: 'hello' } } })).structuredContent;
      reject = 'once';
      const called = await call();
      expect(called).toMatchObject({ ok: true });
      expect(JSON.stringify(called)).not.toMatch(/bearer-[0-9]|private-fixture-header/i);
      expect(auth.counts().reports).toBe(1);
      reject = 'scope';
      expect(await call()).toMatchObject({ ok: false });
      expect(auth.scopes).toEqual(['read', 'write']);
      reject = 'redirect';
      expect(await call()).toMatchObject({ ok: false });
      expect(seen).toEqual([]);
      reject = 'bearer';
      expect(await call()).toMatchObject({ ok: false, errorCode: 'mcp_sign_in_required' });
    } finally {
      await connection.close();
      await fixture.close();
      await permission.reset();
      await auth.stop();
      remote.stop();
      redirectTarget.closeAllConnections();
      await new Promise<void>(resolve => redirectTarget.close(() => resolve()));
      setDefaultCACertificates(previousCa);
      await tls.cleanup();
      await rm(root, { recursive: true, force: true });
    }
  });
});
