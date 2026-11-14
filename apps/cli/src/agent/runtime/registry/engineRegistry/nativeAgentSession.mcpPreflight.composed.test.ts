import { describe, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol';

import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { createHappierMcpBridge } from '@/agent/runtime/createHappierMcpBridge';
import { createHappierMcpToolNamingResolver } from '@/mcp/runtime/projectMcpToolNames';
import { resolveAgentSessionMcpLaunchConfigs } from './nativeAgentSession';

const daemonCatalogBoundary = vi.hoisted(() => ({
  read: vi.fn(async () => ({
    kind: 'available' as const,
    plugins: [],
    tools: [],
  })),
}));

// Daemon IPC is the external boundary; the Session MCP server, relay endpoint, kernel peer
// admission and the native preflight below it are real.
vi.mock('@/daemon/controlClient', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/daemon/controlClient')>();
  return {
    ...actual,
    readDaemonPluginCatalog: daemonCatalogBoundary.read,
    requestDaemonPluginActionExecution: async () => ({ matched: false }),
  };
});

describe('native Agent MCP preflight for the Session-owned Happier server', () => {
  // J65: Codex with a deny-by-default tool policy preflights each MCP server's catalog before launch.
  // The Session relay admits only this Session's Agent tree, so a probe spawned by the host itself
  // is refused (MCP -32000 Connection closed -> mcp_tool_catalog_unavailable). The host owns that catalog.
  it.runIf(process.platform !== 'win32')(
    'reads the Happier catalog from its host owner, and the relay still refuses out-of-tree callers',
    async () => {
      const bridge = await createHappierMcpBridge(
        {
          sessionId: 'session-mcp-preflight',
          getServerBinding: () => ({
            serverId: 'test-home',
            serverUrl: 'https://test-home.example.test',
          }),
          rpcHandlerManager: new RpcHandlerManager({
            scopePrefix: 'session-mcp-preflight',
            encryptionMode: 'plain',
          }),
          updateMetadata() {},
          getMetadataSnapshot: () => ({}),
        },
        { accountSettings: accountSettingsParse({}) },
      );
      try {
        const happier = bridge.mcpServers.happier!;
        expect(happier.command).toMatch(/happier-session-holder/u);
        const policy = {
          unlistedTools: 'deny' as const,
          allowedTools: ['mcp__happier__action_spec_get'],
        };
        // The same owner production wires (resolveRunnerMcpServers): the host's admitted inventory.
        const resolveToolNaming = createHappierMcpToolNamingResolver(
          happier,
          bridge.happierMcpServer.readToolNames,
        );

        const resolved = await resolveAgentSessionMcpLaunchConfigs(
          bridge.mcpServers,
          policy,
          undefined,
          resolveToolNaming,
        );
        expect(resolved?.happier?.enabledTools).toEqual(['action_spec_get']);
        expect(resolved?.happier?.command).toBe(happier.command);

        // Peer admission is unchanged: without the host owner, a host-spawned probe is still refused.
        await expect(
          resolveAgentSessionMcpLaunchConfigs(bridge.mcpServers, policy),
        ).rejects.toMatchObject({
          name: 'McpServerProbeError',
          code: 'mcp_tool_catalog_unavailable',
        });
      } finally {
        await bridge.happierMcpServer.stop();
      }
    },
    60_000,
  );
});
