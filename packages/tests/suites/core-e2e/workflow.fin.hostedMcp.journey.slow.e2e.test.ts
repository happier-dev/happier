import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { getAgentStaticModels } from '@happier-dev/agents';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

import { buildExecutionRunProfileCatalog } from '../../../../apps/cli/src/agent/executionRuns/profiles/intentRegistry';
import { ExecutionRunHostBridge } from '../../../../apps/cli/src/agent/runtime/bridges/executionRun/ExecutionRunHostBridge';
import { createCommittedExecutionRunTranscriptPublisher } from '../../../../apps/cli/src/agent/runtime/bridges/executionRun/executionRunTranscriptPublisher';
import { createTestExecutionRunHostRuntime } from '../../../../apps/cli/src/agent/runtime/bridges/executionRun/testkit';
import { resolveCliEngineRegistry } from '../../../../apps/cli/src/agent/runtime/registry/engineRegistry';
import { createInitialHostRuntimeActivityMutation } from '../../../../apps/cli/src/agent/runtime/session/activity/createHostRuntimeActivityProjection';
import { ApiClient } from '../../../../apps/cli/src/api/api';
import { RpcHandlerManager } from '../../../../apps/cli/src/api/rpc/RpcHandlerManager';
import { createSessionRunReportPolicyReader } from '../../../../apps/cli/src/api/sessionFollowCreationPreferences';
import { readAccountIdFromToken } from '../../../../apps/cli/src/cloud/decodeJwtPayload';
import { reloadConfiguration } from '../../../../apps/cli/src/configuration';
import { readRetainedExecutionRunRecord } from '../../../../apps/cli/src/daemon/executionRunRegistry';
import { startPluginHostedMcpLoopbackServer } from '../../../../apps/cli/src/mcp/hosted/startPluginHostedMcpLoopbackServer';
import { pluginReloadController } from '../../../../apps/cli/src/plugins/runtime/reload/singleton';
import { createAdmittedPluginRuntimeFixture } from '../../../../apps/cli/src/plugins/testkit/admittedRuntime';
import { registerExecutionRunHandlers } from '../../../../apps/cli/src/rpc/handlers/executionRuns';
import { openSessionStoredContent } from '../../../../apps/cli/src/session/transport/encryption/sessionStoredContentCodec';
import { createTestMetadata } from '../../../../apps/cli/src/testkit/backends/sessionMetadata';
import { bindProcessLogger, Logger } from '../../../../apps/cli/src/ui/logger';
import { createTestAuth } from '../../src/testkit/auth';
import { startFinJourneyFixture } from '../../src/testkit/finJourney';
import { fetchJson } from '../../src/testkit/http';
import { createMachineInstallationIdentityFixture, registerMachineIdentity } from '../../src/testkit/machineIdentity';
import { createRunDirs } from '../../src/testkit/runDir';
import { fetchAllMessages, fetchAllSidechainMessages } from '../../src/testkit/sessions';
import { waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'fin-hosted-mcp' });

it('J3 redacts a live hosted MCP bearer echoed by a provider from the transcript, logs and stored Run reads', async () => {
  const directory = run.testDir('J3-provider-echo');
  const home = await startFinJourneyFixture({ testDir: directory,
    serverEnv: { HAPPIER_FEATURE_EXECUTION__RUNS__ENABLED: '1' } });
  const cleanup: Array<() => void | Promise<void>> = [home.stop];
  try {
    const cliHome = join(directory, 'cli-home');
    await mkdir(cliHome);
    vi.stubEnv('HAPPIER_HOME_DIR', cliHome);
    vi.stubEnv('HAPPIER_SERVER_URL', home.actionServerApiUrl);
    vi.stubEnv('HAPPIER_EXPERIMENTAL_EXECUTION_RUNS', '1');
    vi.stubEnv('HAPPIER_CLAUDE_PATH', process.execPath);
    vi.stubEnv('HAPPIER_CLAUDE_DYNAMIC_MODEL_PROBE_ENABLED', '0');
    vi.stubEnv('HAPPIER_LOG_LEVEL', 'debug');
    reloadConfiguration();
    cleanup.push(() => { vi.unstubAllEnvs(); reloadConfiguration(); });

    const log = new Logger({ logFilePath: join(directory, 'run-host.log'), pruneCurrentProcessLogs: false });
    cleanup.push(bindProcessLogger(log));
    const auth = await createTestAuth(home.actionServerApiUrl);
    const accountId = readAccountIdFromToken(auth.token);
    if (!accountId) throw new Error('J3 Account identity unavailable');
    const credentials = { token: auth.token, encryption: { type: 'legacy' as const, secret: auth.accountSigningSeed } };
    const api = await ApiClient.create(credentials);
    const machine = await registerMachineIdentity({
      baseUrl: home.actionServerApiUrl, token: auth.token, installation: createMachineInstallationIdentityFixture(),
    });
    expect(machine.status).toBe(200);
    api.setLocalMachineId(machine.machineId);
    const sessionRecord = await api.getOrCreateSession({
      tag: randomUUID(), state: null,
      metadata: createTestMetadata({ path: directory, flavor: 'claude', machineId: machine.machineId }),
    });
    if (!sessionRecord || sessionRecord.encryptionMode !== 'e2ee') throw new Error('J3 encrypted Session creation failed');
    const transcriptContext = {
      mode: 'e2ee' as const,
      ctx: { encryptionKey: sessionRecord.encryptionKey, encryptionVariant: sessionRecord.encryptionVariant },
    };
    const session = api.sessionSyncClient(sessionRecord, {
      initialRegisteredSessionStateFieldMutations: [
        createInitialHostRuntimeActivityMutation({ sessionId: sessionRecord.id, agentRuntimeApplicability: 'not_applicable' }),
      ],
      durableMutationDeliveryInitiallyActive: false,
    });
    cleanup.push(() => session.close());
    await session.claimCurrentSessionPublisherAuthorityForStartup();
    await session.refreshSessionSnapshotFromServerRequired({ reason: 'startup-drain' });
    await session.activateDurableMutationDelivery();

    const hosted = await startPluginHostedMcpLoopbackServer({
      pluginId: 'fin',
      spec: {
        id: 'fin.echo', name: 'fin-echo',
        transport: { kind: 'hosted', exposure: { kind: 'loopbackHttp', requested: true } },
        hosted: { tools: [{ name: 'ext.fin.probe', inputSchema: { type: 'object' }, handler: async () => ({ content: [] }) }] },
      },
    });
    cleanup.push(hosted.dispose);
    const authorization = hosted.endpoint.headers.authorization;
    const bearer = authorization.slice('Bearer '.length);
    const visible = 'J3 provider echoed [redacted]';

    // The external provider is the fault boundary. It connects using the live
    // MCP endpoint and then returns the credential as assistant output.
    const vendor = createTestExecutionRunHostRuntime({
      async onSendPrompt() {
        const result = await fetch(hosted.endpoint.url, {
          method: 'POST',
          headers: { authorization, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
        });
        if (!result.ok || !(await result.text()).includes('ext.fin.probe')) throw new Error('J3 provider could not reach hosted MCP');
        vendor.emitMessage({ type: 'model-output',
          fullText: JSON.stringify({ summary: `J3 provider echoed ${bearer}`, deliverables: [] }) });
      },
      async onWaitForTurnCompletion() {},
    });
    const runtime = await createAdmittedPluginRuntimeFixture({
      happyHomeDir: cliHome, controller: pluginReloadController,
      runtimeOptions: { pluginIds: ['happier.agent.claude'] },
    });
    cleanup.push(runtime.dispose);
    const registry = await resolveCliEngineRegistry({ backendId: 'claude', runtimeRegistry: runtime.registry });
    const selected = await registry.resolveForBackendId('claude');
    if (!selected) throw new Error('J3 Agent runtime unavailable');
    const engine = { ...selected, engineAdapter: { ...selected.engineAdapter, runtimeCore: {
      ...selected.engineAdapter.runtimeCore, createExecutionRunBackend: () => vendor,
    } } };
    const profileCatalog = buildExecutionRunProfileCatalog();
    const manager = new ExecutionRunHostBridge({
      cwd: directory, parentProvider: 'claude',
      sendAcp: createCommittedExecutionRunTranscriptPublisher({
        enqueueAgentMessageCommitted: session.enqueueAgentMessageCommitted.bind(session),
        readParentToolNormalizationSource: () => null,
      }),
      resolveRunReportPolicy: createSessionRunReportPolicyReader({
        serverId: home.serverId, serverHttpBaseUrl: home.actionServerApiUrl, accountId,
        readCredentials: async () => credentials, isCurrent: () => true,
      }),
      resolveExecutionRunProfileCatalog: () => ({
        profileCatalog,
        engineRegistry: { ...registry, resolveForBackendId: async () => engine, resolveForAgentTarget: async () => engine },
        readNativeOfferedModel: async ({ modelId }) => ({
          id: modelId, name: modelId, capabilities: { structuredOutput: 'supported' },
        }),
      }),
    });
    cleanup.push(() => manager.dispose());
    const started = await manager.start({
      sessionId: session.sessionId, intent: 'delegate', modelSelection: null, connectedServices: null,
      modelId: getAgentStaticModels('claude', { catalogOnly: true })[0]!.id,
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, instructions: 'Describe the hosted MCP probe.',
      permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'bounded', ioMode: 'request_response',
    });
    // A new registered reader owns no live state. It must reopen the retained
    // result through the same dispatch used by the Workflow Action.
    await waitFor(async () => {
      const record = await readRetainedExecutionRunRecord(started.runId);
      if (record?.state.status === 'failed') throw new Error(`J3 Run failed: ${record.state.error?.code}`);
      return record?.state.status === 'succeeded';
    }, { context: 'J3 Run settles in the retained store', failFast: true });
    const snapshot = FeaturesResponseSchema.parse((await fetchJson<unknown>(`${home.actionServerApiUrl}/v1/features`)).data);
    const reader = new RpcHandlerManager({ scopePrefix: session.sessionId, encryptionMode: 'plain' });
    let readerManager: ExecutionRunHostBridge | undefined;
    const registration = registerExecutionRunHandlers(reader, {
      sessionId: session.sessionId, serverId: home.serverId, cwd: directory, parentProvider: 'claude',
      sendAcp: async () => {}, executionRunProfileCatalog: profileCatalog,
      getServerFeaturesSnapshot: () => ({ status: 'ready', features: snapshot }),
      onManagerCreated: manager => { readerManager = manager; },
    });
    cleanup.push(() => readerManager?.dispose(), registration.dispose);
    const opened = await reader.handleRequest({
      method: `${session.sessionId}:${SESSION_RPC_METHODS.EXECUTION_RUN_GET}`,
      params: { runId: started.runId, includeStructured: true }, callerAuthority: 'present_user',
    }, undefined, 'local_session_channel', {
      surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
      actionRequestId: randomUUID(), executionRunWorkflowRunId: randomUUID(),
    });
    const storedRunView = JSON.stringify(opened);
    expect(storedRunView.includes(bearer)).toBe(false);
    expect(storedRunView).toContain(visible);
    log.flushSync();
    const logs = await readFile(log.logFilePath, 'utf8');
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.includes(bearer)).toBe(false);
    await session.flush();
    await waitFor(async () => {
      const sheets = await Promise.all([
        fetchAllMessages(home.actionServerApiUrl, auth.token, session.sessionId),
        fetchAllSidechainMessages({
          baseUrl: home.actionServerApiUrl, token: auth.token, sessionId: session.sessionId, sidechainId: started.sidechainId,
        }),
      ]);
      const transcript = JSON.stringify(sheets.flat().map(row => openSessionStoredContent({
        ...transcriptContext, content: row.content,
      })));
      expect(transcript.includes(bearer)).toBe(false);
      return transcript.includes(visible);
    }, { context: 'J3 provider echo is redacted in the stored Session transcript', failFast: true });
  } finally {
    for (const dispose of cleanup.reverse()) await dispose();
  }
});
