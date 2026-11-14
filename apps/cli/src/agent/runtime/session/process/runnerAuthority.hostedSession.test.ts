import { EventEmitter, once } from 'node:events';
import { captureProcessBirthWitness } from '@/daemon/processIdentity';
import { createServer } from 'node:http';
import { rm } from 'node:fs/promises';
import { afterAll, afterEach, expect, it, vi } from 'vitest';

const home = vi.hoisted(() => {
  const directory = `${process.env.TMPDIR ?? '/tmp'}/happier-runner-authority-scope-${process.pid}-${Date.now()}`;
  process.env.HAPPIER_HOME_DIR = directory;
  return directory;
});
const osIdentity = vi.hoisted(() => vi.fn());
vi.mock('@/daemon/processIdentity', async importOriginal => ({
  ...await importOriginal<typeof import('@/daemon/processIdentity')>(),
  readProcessIdentityByPid: osIdentity,
}));

import { configuration } from '@/configuration';
import { AccountSettingsSchema, FeaturesResponseSchema } from '@happier-dev/protocol';
import { createDeferred } from '@/testkit/async/deferred';
import { hashProcessCommand } from '@/daemon/sessionRegistry';
import { startSessionHost } from '@/agent/runtime/lifecycle/sessionHost';
import { projectRequesterAgentStartPolicyV1 } from '@/daemon/sessionEncryption/requesterAgentStartPolicy';
import { createRunnerReviewHostPluginAuthorityReader } from '@/agent/executionRuns/profiles/review/pluginAuthority';
import { createAgentRuntimeDaemonServiceAuthorityFixture } from './agentRuntimeDaemonServiceAuthority.testkit';
import { HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY,
  publishAgentRuntimeDaemonServiceAuthority } from '@/daemon/agentRuntime/sessionBridgeAuthorization';
import { AGENT_RUNTIME_DAEMON_SERVICES_PATH, AgentRuntimeDaemonServiceRequestV1Schema,
  AgentRuntimeDaemonServiceResponseV1Schema } from './agentRuntimeDaemonServiceProtocol';
import { readCurrentRunnerAgentStartPolicyV1 } from './agentRuntimeDaemonServiceAuthorityClient';
import { ApiSessionClient } from '@/api/session/sessionClient';
import { createPlainSessionFixture } from '@/testkit/backends/sessionFixtures';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createSocketTransportAdapter } from '@happier-dev/sync-client';
import { registerHappierSessionAgentToolRpc, startHappyServer } from '@/mcp/startHappyServer';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { sessionMcpTestTransport } from '@/mcp/runtime/sessionMcpClient.testkit';
import { writeDaemonState } from '@/persistence';
import { fetchServerFeaturesSnapshot } from '@/features/serverFeaturesClient';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
afterAll(() => rm(home, { recursive: true, force: true }));

it.each(['start-policy', 'review-authority', 'registered-agent-tool', 'mcp-http'] as const)(
  'uses each added Session authority for %s on one shared host', async operation => {
    const command = `${process.execPath} /fixture/.runner-snapshots/runner-a/index.mjs daemon start-sync`;
    const runner = { pid: process.pid, processStartTimeMs: 1_717_171_717_000,
      processCommandHash: hashProcessCommand(command), snapshotIdentity: 'snapshot:runner-a' };
    osIdentity.mockResolvedValue({ pid: runner.pid, processStartTimeMs: runner.processStartTimeMs, command });
    const authorities = await Promise.all(['session-a', 'session-b'].map(async sessionId => ({
      ...await createAgentRuntimeDaemonServiceAuthorityFixture({ happyHomeDir: configuration.happyHomeDir, runner }), sessionId,
    })));
    const policies = [3, 7].map(workDepthLimit => projectRequesterAgentStartPolicyV1(AccountSettingsSchema.parse({ workDepthLimit })));
    const reviewAuthorities = authorities.map((authority, index) => ({
      sourceCustody: { ...authority.retainedAgent.sourceCustody, immutableGenerationId: `sha256:${String(index + 1).repeat(64)}` },
      caller: null,
    }));
    // The daemon HTTP endpoint is the external boundary; the real client transport,
    // file publication, parsing, admission and host Session binding remain real.
    const policyRequests: string[] = [];
    const server = createServer(async (incoming, outgoing) => {
      outgoing.setHeader('content-type', 'application/json');
      if (incoming.url?.startsWith('/plugins/catalog/read')) {
        outgoing.end(JSON.stringify({ kind: 'available', plugins: [], tools: [] }));
        return;
      }
      if (incoming.url?.startsWith('/v1/features')) {
        outgoing.end(JSON.stringify(FeaturesResponseSchema.parse({ features: {}, capabilities: {} })));
        return;
      }
      if (incoming.method !== 'POST' || incoming.url !== AGENT_RUNTIME_DAEMON_SERVICES_PATH) {
        outgoing.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const request = AgentRuntimeDaemonServiceRequestV1Schema.parse(JSON.parse(Buffer.concat(chunks).toString()));
      const index = authorities.findIndex(authority => authority.sessionId === request.context.sessionId);
      if (index < 0) throw new Error('Unexpected Session');
      if (request.operation.kind === 'agent_start.policy.read') policyRequests.push(request.context.sessionId);
      const result = request.operation.kind === 'agent_start.policy.read'
        ? { kind: 'agent_start.policy', policy: policies[index] }
        : { kind: 'execution_run.review_plugin_authority', authority: reviewAuthorities[index] };
      outgoing.setHeader('content-type', 'application/json');
      outgoing.end(JSON.stringify(AgentRuntimeDaemonServiceResponseV1Schema.parse({ ok: true, result })));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing HTTP port');
    await Promise.all(authorities.map((authority, index) => publishAgentRuntimeDaemonServiceAuthority({
      ...authority, httpPort: address.port, capability: String.fromCharCode(65 + index).repeat(43),
    })));
    const snapshot = await fetchServerFeaturesSnapshot({ serverUrl: 'http://127.0.0.1:' + address.port, token: 'synthetic-owner-token' });
    expect(snapshot.status).toBe('ready');
    writeDaemonState({ pid: process.pid, httpPort: address.port, startedAt: Date.now(),
      startedWithCliVersion: 'test', controlToken: 'synthetic-daemon-token' });
    vi.stubEnv(HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY, '');
    const hostProcess = new EventEmitter();
    const bothAdded = createDeferred<void>();
    const callbacksFinished = createDeferred<void>();
    const clients = new Map<string, ApiSessionClient>();
    const mcpServers = new Map<string, Awaited<ReturnType<typeof startHappyServer>>>();
    const mcpClients: Client[] = [];
    const delayedCallback = operation === 'registered-agent-tool' || operation === 'mcp-http';
    let started = 0;
    const results = new Map<string, unknown>();
    const errors: unknown[] = [];
    const host = await startSessionHost({ process: hostProcess, exit: () => {}, readTrustedCaller: () => captureProcessBirthWitness(process.pid),
      runSessionCommand: async argv => {
        try {
          const sessionId = argv[0]!;
          if (delayedCallback) {
            const socket = createApiSessionSocketStub({ connected: false });
            const client = new ApiSessionClient('synthetic-owner-token', createPlainSessionFixture({ id: sessionId }), {
              getServerFeaturesSnapshot: () => snapshot,
              metadataAuthority: { kind: 'shared_editor' }, durableMutationDeliveryInitiallyActive: false,
              transport: { serverId: 'fixture-home', serverUrl: 'http://127.0.0.1:' + address.port,
                createSessionSocketTransport: () => ({ socket: socket as never, transport: createSocketTransportAdapter(socket as never) }) },
            });
            clients.set(sessionId, client);
            const options = { happierToolsEnabled: true, authorityScope: 'session' as const,
              sessionCredentials: { token: 'synthetic-owner-token', encryption: null }, accountSettings: AccountSettingsSchema.parse({}) };
            if (operation === 'registered-agent-tool') registerHappierSessionAgentToolRpc(client, options);
            else mcpServers.set(sessionId, await startHappyServer(client, options));
          }
          if (++started === 2) bothAdded.resolve();
          await bothAdded.promise;
          if (delayedCallback) await callbacksFinished.promise;
          else results.set(sessionId, operation === 'start-policy' ? await readCurrentRunnerAgentStartPolicyV1(sessionId)
            : await createRunnerReviewHostPluginAuthorityReader(sessionId)('acme.plugin'));
        } catch (error) { errors.push(error); throw error; }
      },
    });
    try {
      const addedSessions = Promise.all(authorities.map(authority => host.addSession({ trackingKey: authority.sessionId,
        argv: [authority.sessionId], cwd: home,
        env: { [HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY]: authority.path },
      })));
      await bothAdded.promise;
      if (delayedCallback) {
        try {
          // Invoke real callbacks outside either originating Session scope. No admitted turn
          // is installed, so the Action still refuses effects after reading its Session policy.
          const outcomes = operation === 'registered-agent-tool'
            ? await Promise.all([...clients.values()].map(client => client.rpcHandlerManager.invokeLocal(
              SESSION_RPC_METHODS.SESSION_AGENT_TOOL_CALL_V1,
              { toolName: 'action_execute', args: { actionId: 'session.spawn_new', input: {} } },
            )))
            : await Promise.all([...mcpServers.values()].map(async server => {
              const sdk = new Client({ name: 'hosted-scope-fixture', version: '1.0.0' });
              mcpClients.push(sdk);
              await sdk.connect(sessionMcpTestTransport(server));
              return await sdk.callTool({ name: 'action_execute', arguments: { actionId: 'session.spawn_new', input: {} } });
            }));
          expect(policyRequests.sort(), JSON.stringify(outcomes)).toEqual(['session-a', 'session-b']);
          if (operation === 'registered-agent-tool') expect(outcomes).toEqual([expect.objectContaining({ ok: false, errorCode: 'target_unavailable' }),
            expect.objectContaining({ ok: false, errorCode: 'target_unavailable' })]);
        } finally { callbacksFinished.resolve(); }
      }
      expect(await addedSessions).toEqual([{ exitCode: 0 }, { exitCode: 0 }]);
      expect(errors).toEqual([]);
      if (!delayedCallback) expect([...results.entries()].sort()).toEqual(authorities.map((authority, index) => [authority.sessionId,
        operation === 'start-policy' ? policies[index] : reviewAuthorities[index]]));
    } finally {
      callbacksFinished.resolve();
      await Promise.all(mcpClients.map(client => client.close()));
      await Promise.all([...mcpServers.values()].map(server => server.stop()));
      await Promise.all([...clients.values()].map(client => client.close()));
      hostProcess.emit('SIGTERM');
      await host.whenEnded;
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  },
);
