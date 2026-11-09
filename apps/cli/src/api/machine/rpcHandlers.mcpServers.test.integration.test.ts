import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { accountSettingsParse } from '@happier-dev/protocol';

import { registerMachineMcpServersRpcHandlers } from './rpcHandlers.mcpServers';
import type { RpcHandler, RpcHandlerContext } from '@/api/rpc/types';
import { createMcpOwnerRpcContext, MCP_TEST_HOME_ID } from './mcpServers.testkit';

describe('rpcHandlers.mcpServers (test)', () => {
  it.each(['draft', 'byId'] as const)('admits custodian Account automation to the existing %s credential source', async t => {
    const handlers = new Map<string, RpcHandler<unknown, unknown>>();
    const readCredentials = vi.fn(async () => null);
    registerMachineMcpServersRpcHandlers({
      rpcHandlerManager: { registerHandler(method: string, handler: RpcHandler<unknown, unknown>) { handlers.set(method, handler); } } as never,
      deps: { readCredentials, hostHomeServerIdentityId: MCP_TEST_HOME_ID },
    });
    const context: RpcHandlerContext = { ...createMcpOwnerRpcContext(), callerAuthority: 'account_automation' };
    const request = t === 'byId'
      ? { t, machineId: 'm1', directory: process.cwd(), serverId: 'owner-server' }
      : { t, machineId: 'm1', directory: process.cwd(), binding: null, server: {
        id: 'owner-server', name: 'owner-server', transport: 'stdio',
        stdio: { command: process.execPath, args: ['-e', 'throw new Error("unexpected child")'] },
        env: {}, createdAt: 1, updatedAt: 1,
      } };
    const result = await handlers.get(RPC_METHODS.DAEMON_MCP_SERVERS_TEST)!(request, context);
    expect(result).toMatchObject({ ok: false, errorCode: 'missing_credentials' });
    expect(readCredentials).toHaveBeenCalledTimes(1);
  });
  it.each(['draft', 'byId'] as const)('refuses member %s before borrowing the custodian catalog or launching stdio', async t => {
    const handlers = new Map<string, RpcHandler<unknown, unknown>>();
    const readCredentials = vi.fn(async () => null);
    registerMachineMcpServersRpcHandlers({
      rpcHandlerManager: { registerHandler(method: string, handler: RpcHandler<unknown, unknown>) { handlers.set(method, handler); } } as never,
      deps: { readCredentials, hostHomeServerIdentityId: MCP_TEST_HOME_ID },
    });
    const context: RpcHandlerContext = {
      signal: new AbortController().signal,
      callerAuthority: 'present_user',
      machineAdmission: { actorAccountId: 'member', custodianAccountId: 'owner', machineId: 'm1',
        installationId: 'install', encryptionMode: 'plain', role: 'manage' },
      verifyMachineAdmissionCurrent: async () => true,
    };
    const request = t === 'byId'
      ? { t, machineId: 'm1', directory: process.cwd(), serverId: 'custodian-only-server' }
      : { t, machineId: 'm1', directory: process.cwd(), binding: null, server: {
        id: 'member-server', name: 'member-server', transport: 'stdio',
        stdio: { command: process.execPath, args: ['-e', 'throw new Error("unexpected child")'] },
        env: {}, createdAt: 1, updatedAt: 1,
      } };
    const result = await Promise.resolve(handlers.get(RPC_METHODS.DAEMON_MCP_SERVERS_TEST)!(request, context)).catch(error => error);
    expect(readCredentials).not.toHaveBeenCalled();
    expect(result).toMatchObject({ code: 'agent_isolation_unavailable', retryable: false });
  });

  it.each(['member-use', 'member-manage', 'session-origin', 'copied-local-session', 'retired'] as const)(
    'does not confuse protected requester custody with owned Account automation (%s)', async kind => {
      const handlers = new Map<string, RpcHandler<unknown, unknown>>();
      const readCredentials = vi.fn(async () => null);
      registerMachineMcpServersRpcHandlers({
        rpcHandlerManager: { registerHandler(method: string, handler: RpcHandler<unknown, unknown>) { handlers.set(method, handler); } } as never,
        deps: { readCredentials, hostHomeServerIdentityId: MCP_TEST_HOME_ID },
      });
      const caller = { kind: 'session' as const, sessionId: 'owner-agent', starterDepth: 0, turnDepth: 0 };
      const context: RpcHandlerContext = { ...createMcpOwnerRpcContext(), callerAuthority: 'account_automation',
        ...(kind.startsWith('member-') ? { machineAdmission: {
          actorAccountId: 'member', custodianAccountId: 'owner', machineId: 'm1', installationId: 'install',
          encryptionMode: 'plain' as const, role: kind === 'member-use' ? 'use' as const : 'manage' as const,
        } } : {}),
        ...(kind === 'session-origin' ? { sessionActionOrigin: { v: 1, caller,
          sourceTurnId: 'agent-turn', callerPermissionMode: null, requestId: 'agent-request' } } : {}),
        ...(kind === 'copied-local-session' ? { localActionContext: { actionCaller: caller } } : {}),
        ...(kind === 'retired' ? { verifyMachineAdmissionCurrent: async () => false } : {}),
      };
      await expect(handlers.get(RPC_METHODS.DAEMON_MCP_SERVERS_TEST)!({ t: 'byId', machineId: 'm1',
        directory: process.cwd(), serverId: 'owner-server' }, context))
        .rejects.toMatchObject({ code: 'agent_isolation_unavailable', retryable: false });
      expect(readCredentials).not.toHaveBeenCalled();
    });

  it.each(['present_user', 'account_automation'] as const)('lists draft stdio tools for the Machine custodian (%s)', async callerAuthority => {
    const baseDir = join(process.cwd(), '.project', 'tmp');
    await mkdir(baseDir, { recursive: true });
    const root = await mkdtemp(join(baseDir, 'happier-mcp-test-rpc-'));
    try {
      const serverPath = join(root, 'fixture.mjs');
      await writeFile(
        serverPath,
        [
          "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';",
          "import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';",
          "import { z } from 'zod/mini';",
          '',
          "const server = new McpServer({ name: 'Fixture', version: '1.0.0' });",
          "server.registerTool('echo', { title: 'Echo', inputSchema: z.object({ text: z.string() }) }, async (args) => {",
          "  return { content: [{ type: 'text', text: String(args?.text ?? '') }] };",
          '});',
          'await server.connect(new StdioServerTransport());',
          '',
        ].join('\n'),
        'utf8',
      );

      const handlers = new Map<string, RpcHandler<unknown, unknown>>();
      const rpcHandlerManager = {
        registerHandler: (method: string, handler: RpcHandler<unknown, unknown>) => {
          handlers.set(method, handler);
        },
      } as any;

      const credentials = {
        token: 'tok_test',
        encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) },
      };

      registerMachineMcpServersRpcHandlers({
        rpcHandlerManager,
        deps: {
          hostHomeServerIdentityId: MCP_TEST_HOME_ID,
          readCredentials: async () => credentials as any,
          bootstrapAccountSettingsContext: async () => ({
            source: 'none',
            settings: accountSettingsParse({}),
            settingsVersion: 0,
            loadedAtMs: 0,
            whenRefreshed: null,
          }),
        },
      } as any);

      const handler = handlers.get(RPC_METHODS.DAEMON_MCP_SERVERS_TEST);
      expect(handler).toBeTruthy();

      const out = (await handler!({
        t: 'draft',
        machineId: 'm1',
        directory: root,
        server: {
          id: 'srv_1',
          name: 'fixture',
          transport: 'stdio',
          stdio: { command: process.execPath, args: [serverPath] },
          env: {},
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        binding: null,
      }, { ...createMcpOwnerRpcContext(), callerAuthority })) as any;

      expect(out.ok).toBe(true);
      expect(out.toolCount).toBeGreaterThan(0);
      expect(out.toolNamesSample).toContain('echo');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
