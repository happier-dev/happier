import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { io } from 'socket.io-client';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import type { DaemonMcpServersDetectRequest, DaemonMcpServersDetectResponse } from '@happier-dev/protocol';
import { DaemonMcpServersDetectResponseSchema } from '@happier-dev/protocol/mcp/servers/daemonRpcV1';
import { socketRpcCodec, type SocketRpcContent } from '@happier-dev/sync-client';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import type { RpcRequest } from '@/api/rpc/types';
import { createEncryptedRpcTestClient } from '@/rpc/handlers/encryptedRpc.testkit';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { authorizeMachineRpcRequest } from './machineRpcAuthorization';

import { registerMachineMcpServersRpcHandlers } from './rpcHandlers.mcpServers';
import { createMcpOwnerRpcContext, MCP_TEST_HOME_ID } from './mcpServers.testkit';
import { createEnvKeyScope } from '@/testkit/env/envScope';

describe('rpcHandlers.mcpServers (detect)', () => {
  let runtime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>>;
  beforeAll(async () => {
    runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
      runtimeOptions: { pluginIds: ['happier.agent.codex', 'happier.agent.claude', 'happier.agent.opencode'] } });
    // File discovery is the contract here, not cold graph transformation under
    // the discovery deadline. Activate the actual admitted declarations first.
    await runtime.registry.activateContributionsOnDemand((runtime.registry.contributes.mcpDiscoverySources ?? []).flatMap(source =>
      source.pluginId ? [{ pluginId: source.pluginId, family: 'mcp.discoverySources' as const, localId: source.definition.id }] : []));
  });
  afterAll(async () => { await runtime?.dispose(); });

  function createDetectionManager(encryptionKey?: Uint8Array) {
    const admission = createMcpOwnerRpcContext().machineAdmission!;
    return new RpcHandlerManager({ scopePrefix: 'm1', localMachineId: 'm1',
      ...(encryptionKey ? { encryptionKey, encryptionVariant: 'legacy' as const } : { encryptionMode: 'plain' as const }),
      authorizeRequest: request => authorizeMachineRpcRequest(request, { machineId: admission.machineId,
        resolveCustodianAccountId: async () => admission.custodianAccountId,
        resolveInstallationId: () => admission.installationId,
        resolveHomeServerIdentityId: async () => MCP_TEST_HOME_ID,
        // The fixture Home verifies its authenticated Machine admission.
        verifyMachineAdmission: async () => true,
      }) });
  }

  function createDetectionClient(env?: NodeJS.ProcessEnv) {
    const admission = createMcpOwnerRpcContext();
    const encryptionKey = new Uint8Array(32).fill(7);
    return createEncryptedRpcTestClient({ scopePrefix: 'm1',
      manager: createDetectionManager(encryptionKey), encryptionKey,
      callerAuthority: admission.callerAuthority, machineAdmission: admission.machineAdmission,
      registerHandlers: manager => registerMachineMcpServersRpcHandlers({ rpcHandlerManager: manager,
        deps: { env, hostHomeServerIdentityId: MCP_TEST_HOME_ID } }),
    });
  }

  it('composes real plugin discovery, native files and registered RPC over HTTP/Socket.IO into the consumer schema', async () => {
    const environment = createEnvKeyScope(['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME']);
    const home = await mkdtemp(join(tmpdir(), 'happier-native-mcp-rpc-'));
    const http = createServer();
    const sockets = new Server(http);
    const manager = createDetectionManager();
    registerMachineMcpServersRpcHandlers({ rpcHandlerManager: manager,
      deps: { hostHomeServerIdentityId: MCP_TEST_HOME_ID } });
    sockets.use((socket, next) => socket.handshake.auth.fixture === 'native-discovery' ? next() : next(new Error('Unauthorized')));
    sockets.on('connection', socket => socket.on('rpc-request', (request: RpcRequest, reply: (value: unknown) => void) => {
      const admission = createMcpOwnerRpcContext();
      void manager.handleRequest({ ...request, callerAuthority: admission.callerAuthority,
        machineAdmission: admission.machineAdmission }).then(reply, error => reply({ errorCode: 'internal_error', error: String(error) }));
    }));
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('Expected HTTP listener');
    const client = io(`http://127.0.0.1:${address.port}`, { transports: ['websocket'], auth: { fixture: 'native-discovery' }, reconnection: false });
    try {
      environment.patch({ CODEX_HOME: join(home, 'codex'), CLAUDE_CONFIG_DIR: join(home, 'claude'), XDG_CONFIG_HOME: join(home, 'xdg') });
      await mkdir(join(home, 'codex'));
      await mkdir(join(home, 'claude'));
      await mkdir(join(home, 'xdg', 'opencode'), { recursive: true });
      await writeFile(join(home, 'codex', 'config.toml'), '[mcp_servers.native]\ncommand = "bridge"\nargs = ["--stdio"]\nenv = { API_KEY = "private-native-value" }\n[mcp_servers.disabled]\nurl = "https://example.test/mcp"\nenabled = false\nhttp_headers = { Authorization = "private-native-value" }\n');
      await writeFile(join(home, 'claude', '.claude.json'), JSON.stringify({ mcpServers: { native: { type: 'sse', url: 'https://example.test/sse', headers: { Authorization: 'private-native-value' } } } }));
      await writeFile(join(home, 'xdg', 'opencode', 'opencode.json'), JSON.stringify({ mcp: { native: { type: 'local', command: ['bridge', '--stdio'], environment: { TOKEN: 'private-native-value' } } } }));
      await new Promise<void>((resolve, reject) => { if (client.connected) resolve(); else { client.once('connect', resolve); client.once('connect_error', reject); } });
      const content: SocketRpcContent = { mode: 'plain' };
      const method = `m1:${RPC_METHODS.DAEMON_MCP_SERVERS_DETECT}`;
      const callId = '1'.repeat(32);
      const params = await socketRpcCodec.encodeParams(content, { machineId: 'm1', providers: ['codex', 'claude', 'opencode'] }, { method, callId });
      const response: unknown = await client.emitWithAck('rpc-request', { method, params });
      const result = DaemonMcpServersDetectResponseSchema.parse(await socketRpcCodec.decodeResult(content, { ok: true, result: response }, callId));
      expect(result).toMatchObject({ ok: true });
      if (!result.ok) throw new Error(result.error);
      expect(result.warnings ?? []).toEqual([]);
      expect(result.servers).toHaveLength(4);
      expect(result.servers).toEqual(expect.arrayContaining([
        expect.objectContaining({ provider: 'codex', name: 'native', transport: 'stdio', envKeys: ['API_KEY'], loadedInHappierSessions: false, source: { kind: 'user', path: join(home, 'codex', 'config.toml') } }),
        expect.objectContaining({ provider: 'codex', name: 'disabled', enabled: false, remote: { url: 'https://example.test/mcp', headers: ['Authorization'] } }),
        expect.objectContaining({ provider: 'claude', transport: 'sse', remote: { url: 'https://example.test/sse', headers: ['Authorization'] }, loadedInHappierSessions: true }),
        expect.objectContaining({ provider: 'opencode', transport: 'stdio', stdio: { command: 'bridge', args: ['--stdio'] }, envKeys: ['TOKEN'], loadedInHappierSessions: true }),
      ]));
      expect(JSON.stringify(result)).not.toContain('private-native-value');
      manager.unregisterHandler(RPC_METHODS.DAEMON_MCP_SERVERS_DETECT);
      expect(await client.emitWithAck('rpc-request', { method, params })).toMatchObject({ errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND });
    } finally {
      client.disconnect();
      await new Promise<void>(resolve => sockets.close(() => resolve()));
      environment.restore();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('detects Codex MCP servers from CODEX_HOME config.toml without returning secrets', async () => {
    const prevCodexHome = process.env.CODEX_HOME;
    const dir = await mkdtemp(join(tmpdir(), 'happier-mcp-detect-'));
    try {
      process.env.CODEX_HOME = dir;
      await writeFile(
        join(dir, 'config.toml'),
        [
          '[mcp_servers.context7]',
          'command = "npx"',
          'args = ["-y","@context7/mcp"]',
          'enabled = true',
          '',
          '[mcp_servers.playwright]',
          'command = "node"',
          'args = ["server.js"]',
          'enabled = false',
          '',
        ].join('\n'),
        'utf8',
      );

      const { call } = createDetectionClient({ ...process.env, HAPPIER_MCP_DISCOVERY_PROVIDER_TIMEOUT_MS: '1234' });
      const out = await call<DaemonMcpServersDetectResponse, DaemonMcpServersDetectRequest>(
        RPC_METHODS.DAEMON_MCP_SERVERS_DETECT, { machineId: 'm1', providers: ['codex'] },
      );
      expect(out.ok).toBe(true);
      expect(out.warnings ?? []).toEqual([]);

      if (!out.ok) throw new Error(out.error);
      const servers = out.servers;
      expect(servers.length).toBeGreaterThan(0);

      const ctx7 = servers.find((s) => s.provider === 'codex' && s.name === 'context7');
      expect(ctx7).toBeTruthy();
      if (!ctx7) throw new Error('Expected current Agent discovery result');
      expect(ctx7.transport).toBe('stdio');
      expect(ctx7.stdio).toEqual({ command: 'npx', args: ['-y', '@context7/mcp'] });
      expect(ctx7.envKeys).toEqual([]);
      expect(ctx7.remote).toBeUndefined();
    } finally {
      if (typeof prevCodexHome === 'string') process.env.CODEX_HOME = prevCodexHome;
      else delete process.env.CODEX_HOME;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('detects Claude MCP servers from CLAUDE_CONFIG_DIR .claude.json without returning secrets', async () => {
    const prevClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    const dir = await mkdtemp(join(tmpdir(), 'happier-mcp-claude-detect-'));
    try {
      process.env.CLAUDE_CONFIG_DIR = dir;
      await writeFile(
        join(dir, '.claude.json'),
        JSON.stringify(
          {
            mcpServers: {
              context7: {
                command: 'npx',
                args: ['-y', '@context7/mcp'],
                env: { API_KEY: 'supersecret' },
              },
            },
          },
          null,
          2,
        ),
        'utf8',
      );

      const { call } = createDetectionClient({ ...process.env, HAPPIER_MCP_DISCOVERY_PROVIDER_TIMEOUT_MS: '1234' });
      const out = await call<DaemonMcpServersDetectResponse, DaemonMcpServersDetectRequest>(
        RPC_METHODS.DAEMON_MCP_SERVERS_DETECT, { machineId: 'm1', providers: ['claude'] },
      );
      expect(out.ok).toBe(true);

      if (!out.ok) throw new Error(out.error);
      const servers = out.servers;
      const ctx7 = servers.find((s) => s.provider === 'claude' && s.name === 'context7');
      expect(ctx7).toBeTruthy();
      if (!ctx7) throw new Error('Expected the discovered Context7 server');
      expect(ctx7.transport).toBe('stdio');
      expect(ctx7.stdio).toEqual({ command: 'npx', args: ['-y', '@context7/mcp'] });
      expect(ctx7.envKeys).toEqual(['API_KEY']);
      expect(JSON.stringify(ctx7)).not.toContain('supersecret');
    } finally {
      if (typeof prevClaudeConfigDir === 'string') process.env.CLAUDE_CONFIG_DIR = prevClaudeConfigDir;
      else delete process.env.CLAUDE_CONFIG_DIR;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('detects OpenCode MCP servers from XDG_CONFIG_HOME config without returning secrets', async () => {
    const prevXdgConfigHome = process.env.XDG_CONFIG_HOME;
    const dir = await mkdtemp(join(tmpdir(), 'happier-mcp-opencode-detect-'));
    try {
      process.env.XDG_CONFIG_HOME = dir;
      const cfgDir = join(dir, 'opencode');
      await mkdir(cfgDir, { recursive: true });
      await writeFile(
        join(cfgDir, 'opencode.json'),
        JSON.stringify(
          {
            mcp: {
              localtool: {
                type: 'local',
                command: ['node', 'server.js'],
                environment: { TOKEN: 'supersecret' },
              },
            },
          },
          null,
          2,
        ),
        'utf8',
      );

      const { call } = createDetectionClient({ ...process.env, HAPPIER_MCP_DISCOVERY_PROVIDER_TIMEOUT_MS: '1234' });
      const out = await call<DaemonMcpServersDetectResponse, DaemonMcpServersDetectRequest>(
        RPC_METHODS.DAEMON_MCP_SERVERS_DETECT, { machineId: 'm1', providers: ['opencode'] },
      );
      expect(out.ok).toBe(true);

      if (!out.ok) throw new Error(out.error);
      const servers = out.servers;
      const s = servers.find((entry) => entry.provider === 'opencode' && entry.name === 'localtool');
      expect(s).toBeTruthy();
      if (!s) throw new Error('Expected current Agent discovery result');
      expect(s.transport).toBe('stdio');
      expect(s.stdio).toEqual({ command: 'node', args: ['server.js'] });
      expect(s.envKeys).toEqual(['TOKEN']);
      expect(JSON.stringify(s)).not.toContain('supersecret');
    } finally {
      if (typeof prevXdgConfigHome === 'string') process.env.XDG_CONFIG_HOME = prevXdgConfigHome;
      else delete process.env.XDG_CONFIG_HOME;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
