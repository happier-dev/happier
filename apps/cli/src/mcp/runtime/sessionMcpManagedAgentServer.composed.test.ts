import { describe, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol';

import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { createHappierMcpBridge } from '@/agent/runtime/createHappierMcpBridge';
import { SESSION_MCP_BEARER_ENV } from '@/mcp/runtime/sessionMcpLocalContext';
import {
  createStablePluginExecService,
  installManagedProcessCustodyForHost,
} from '@/plugins/runtime/invocation/services/exec';

const daemonCatalogBoundary = vi.hoisted(() => ({
  read: vi.fn(async () => ({
    kind: 'available' as const,
    plugins: [],
    tools: [],
  })),
}));

// Daemon IPC is the external boundary; the Session MCP server, managed Exec spawn, holder relay
// and kernel peer check below it are real.
vi.mock('@/daemon/controlClient', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/daemon/controlClient')>();
  return {
    ...actual,
    readDaemonPluginCatalog: daemonCatalogBoundary.read,
    requestDaemonPluginActionExecution: async () => ({ matched: false }),
  };
});

const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'managed-agent-server', version: '1' },
  },
});

/**
 * The managed Agent server (OpenCode server mode) launches the Session MCP relay from the config
 * the runner registered with it, as its own child, then initializes MCP over the relay's stdio.
 */
function managedServerScript(
  config: Readonly<{
    command: string;
    args?: readonly string[];
    env?: Readonly<Record<string, string>>;
  }>,
): string {
  return (
    `const r=require('node:child_process').spawn(${JSON.stringify(config.command)},${JSON.stringify(config.args ?? [])},` +
    `{env:{...process.env,...${JSON.stringify(config.env ?? {})}},stdio:['pipe','pipe','ignore']});let out='';let done=false;` +
    `const finish=v=>{if(done)return;done=true;process.stdout.write(v);r.kill();};` +
    `r.stdout.on('data',d=>{out+=d;if(out.includes('\\n'))finish(out.includes('"result"')?'initialized':'refused');});` +
    `r.on('exit',()=>finish('refused'));r.stdin.write(${JSON.stringify(INITIALIZE)}+'\\n');`
  );
}

describe('Session MCP from a Session-owned managed Agent server', () => {
  it.runIf(process.platform !== 'win32')(
    'admits the relay its managed server launches and refuses a managed process no Session owns',
    async () => {
      const bridge = await createHappierMcpBridge(
        {
          sessionId: 'session-managed-server',
          getServerBinding: () => ({
            serverId: 'test-home',
            serverUrl: 'https://test-home.example.test',
          }),
          rpcHandlerManager: new RpcHandlerManager({
            scopePrefix: 'session-managed-server',
            encryptionMode: 'plain',
          }),
          updateMetadata() {},
          getMetadataSnapshot: () => ({}),
        },
        { accountSettings: accountSettingsParse({}) },
      );
      const config = bridge.mcpServers.happier;
      if (!config) throw new Error('missing Session MCP relay config');
      // Exercise kernel peer custody for both processes, without bearer admission.
      const peerEnvironment = { ...config.env };
      delete peerEnvironment[SESSION_MCP_BEARER_ENV];
      const peerConfig = { ...config, env: peerEnvironment };
      const service = createStablePluginExecService({
        signal: new AbortController().signal,
        isOccurrenceCurrent: () => true,
        resolveExecutable: async () => ({ command: process.execPath }),
        resolvePath: async () => process.cwd(),
      });
      const runManaged = async (
        owner: Parameters<typeof installManagedProcessCustodyForHost>[4],
      ) => {
        const request = {
          executable: { kind: 'systemTool', id: 'fixture.node' } as const,
          args: ['-e', managedServerScript(peerConfig)],
        };
        const custody = installManagedProcessCustodyForHost(
          service,
          request,
          null,
          undefined,
          owner,
        );
        try {
          const handle = await service.spawn(request);
          try {
            return Buffer.from((await handle.wait()).stdout).toString('utf8');
          } finally {
            await handle.dispose();
          }
        } finally {
          custody.dispose();
        }
      };
      try {
        expect(
          await runManaged({
            kind: 'service',
            serviceId: 'opencode-server',
            sessionId: 'session-managed-server',
          }),
        ).toBe('initialized');
        expect(
          await runManaged({ kind: 'service', serviceId: 'machine-service' }),
        ).toBe('refused');
      } finally {
        await bridge.happierMcpServer.stop();
      }
    },
    120_000,
  );
});
