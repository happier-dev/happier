import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { accountSettingsParse } from '@happier-dev/protocol';

import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { createHappierMcpBridge } from '@/agent/runtime/createHappierMcpBridge';
import { startSessionHost } from '@/agent/runtime/lifecycle/sessionHost';
import { createDeferred } from '@/testkit/async/deferred';
import { HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY } from '@/daemon/agentRuntime/sessionBridgeAuthorization';
import { sessionMcpAgentTransport } from './sessionMcpClient.testkit';

// Daemon IPC is the external boundary; the session host, Session MCP server, holder, native
// relay (HTTP upgrade), kernel peer check and Account Action executor below it are real.
vi.mock('@/daemon/controlClient', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/daemon/controlClient')>();
  return {
    ...actual,
    readDaemonPluginCatalog: async () => ({
      kind: 'available' as const,
      plugins: [],
      tools: [],
    }),
    requestDaemonPluginActionExecution: async () => ({ matched: false }),
  };
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// Recorded live failures (READY202 Muse after Allow once; REPLAY148-EG Codex first execution;
// S1-RU2-01 Codex browser.profile.list): Account-routed native Actions over the Agent's relay.
const ACCOUNT_ACTIONS = [
  ['browser.profile.list', {}],
  ['deployments.environments.list', {}],
  ['registries.sources.list', { kind: 'app' }],
] as const;

it('serves each Agent relay tool call with its own added Session authority on a shared host', async () => {
  // The host process carries no Session authority; only the added Session's environment does.
  vi.stubEnv(HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY, '');
  const hostProcess = new EventEmitter();
  // `admitted` holds an authority path; `unadmitted` (sharing the host) holds none.
  const sessions = ['admitted', 'unadmitted'];
  const outcomes = new Map<string, string[]>();
  const bothConnected = createDeferred<void>();
  let connected = 0;
  const host = await startSessionHost({
    process: hostProcess,
    exit: () => {},
    readTrustedCallerPid: async () => process.pid,
    runSessionCommand: async ([sessionId]) => {
      const bridge = await createHappierMcpBridge(
        {
          sessionId: sessionId!,
          getServerBinding: () => ({
            serverId: 'test-home',
            serverUrl: 'https://test-home.example.test',
          }),
          rpcHandlerManager: new RpcHandlerManager({
            scopePrefix: sessionId!,
            encryptionMode: 'plain',
          }),
          updateMetadata() {},
          getMetadataSnapshot: () => ({}),
        },
        {
          accountSettings: accountSettingsParse({}),
          authorityScope: 'session',
        },
      );
      const agent = new Client({ name: 'native-agent', version: '1' });
      try {
        // The Agent and its relay are launched from the Session's work, like a native open.
        await agent.connect(
          sessionMcpAgentTransport(bridge.mcpServers.happier!),
        );
        if (++connected === sessions.length) bothConnected.resolve();
        await bothConnected.promise;
        const results: string[] = [];
        for (const [actionId, input] of ACCOUNT_ACTIONS) {
          const result = CallToolResultSchema.parse(
            await agent.callTool({
              name: 'action_execute',
              arguments: { actionId, input },
            }),
          );
          results.push(JSON.stringify(result.content));
        }
        outcomes.set(sessionId!, results);
      } finally {
        await agent.close();
        await bridge.happierMcpServer.stop();
      }
    },
  });
  try {
    expect(
      await Promise.all(
        sessions.map((sessionId) =>
          host.addSession({
            trackingKey: sessionId,
            argv: [sessionId],
            cwd: process.cwd(),
            env: {
              ...process.env,
              ...(sessionId === 'admitted'
                ? {
                    [HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY]:
                      '/authority/admitted.json',
                  }
                : {}),
            },
          }),
        ),
      ),
    ).toEqual([{ exitCode: 0 }, { exitCode: 0 }]);
    // The admitted Session's path is read; with no admitted turn the executor refuses next at
    // the witness check, before any effect. The neighbour on the same host never borrows it.
    expect(outcomes.get('admitted')).toEqual(
      ACCOUNT_ACTIONS.map(() => expect.stringContaining('turn_witness_absent')),
    );
    expect(outcomes.get('unadmitted')).toEqual(
      ACCOUNT_ACTIONS.map(() =>
        expect.stringContaining('authority_path_absent'),
      ),
    );
  } finally {
    hostProcess.emit('SIGTERM');
    await host.whenEnded;
  }
}, 60_000);
