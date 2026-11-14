import { EventEmitter, once } from 'node:events';
import { captureProcessBirthWitness } from '@/daemon/processIdentity';
import { createServer } from 'node:http';
import { rm } from 'node:fs/promises';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { createSocketTransportAdapter } from '@happier-dev/sync-client';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import type { AgentSessionRuntime, AgentSessionRuntimeContext, AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';

const home = vi.hoisted(() => {
  const directory = `${process.env.TMPDIR ?? '/tmp'}/happier-lifecycle-scope-${process.pid}-${Date.now()}`;
  process.env.HAPPIER_HOME_DIR = directory;
  return directory;
});

import { startSessionHost } from '@/agent/runtime/lifecycle/sessionHost';
import { createNativeAgentSessionOperations } from '@/agent/runtime/registry/engineRegistry/nativeAgentSession';
import { createPermissionModeQueueState } from '@/agent/runtime/createPermissionModeQueueState';
import { createProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/createHandler';
import { ApiSessionClient } from '@/api/session/sessionClient';
import { createDeferred } from '@/testkit/async/deferred';
import { createPlainSessionFixture } from '@/testkit/backends/sessionFixtures';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY, serializeConnectedServiceChildSelectionValues } from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import { ConnectedServiceTurnLifecycleRequestBodySchema, connectedServiceTurnLifecycleContinue, type ConnectedServiceTurnLifecycleRequestBody } from '@/daemon/connectedServices/connectedServiceTurnLifecycleContract';
import { fetchServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { writeDaemonState } from '@/persistence';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { runSessionLoopLifecycle, type SessionLoopLifecycleParams } from './lifecycle';

afterEach(() => vi.unstubAllEnvs());
afterAll(() => rm(home, { recursive: true, force: true }));

it('uses each added Session selection for provider-started turn custody on a shared host', async () => {
  const requests: ConnectedServiceTurnLifecycleRequestBody[] = [];
  const features = FeaturesResponseSchema.parse({ features: {}, capabilities: { session: {
    pendingInput: { protocolVersion: 1 }, runtimeActivity: { protocolVersion: 2 }, publisherAuthority: { protocolVersion: 1 },
  } } });
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/connected-service-turn-lifecycle') {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = ConnectedServiceTurnLifecycleRequestBodySchema.parse(JSON.parse(Buffer.concat(chunks).toString()));
      requests.push(body);
      response.end(JSON.stringify({ ok: true, result: connectedServiceTurnLifecycleContinue({ status: 'recorded', activeTurnId: body.event === 'task_started' ? body.turnId ?? null : null }) }));
    } else {
      response.end(JSON.stringify(request.url?.startsWith('/v1/features') ? features : {}));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing HTTP endpoint');
  const serverUrl = `http://127.0.0.1:${address.port}`;
  const snapshot = await fetchServerFeaturesSnapshot({ serverUrl, token: 'synthetic-owner-token' });
  expect(snapshot.status).toBe('ready');
  writeDaemonState({ pid: process.pid, httpPort: address.port, startedAt: Date.now(), startedWithCliVersion: 'test', controlToken: 'synthetic-daemon-token' });
  vi.stubEnv(HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY, '');
  const selections = ['profile-a', 'profile-b'].map(profileId => serializeConnectedServiceChildSelectionValues([
    { kind: 'profile', serviceId: 'happier.agent.codex/openai-codex', profileId },
  ])!);
  const bothPrepared = createDeferred<void>();
  const finishPresentation = createDeferred<void>();
  const publishers = new Map<string, (event: AgentSessionRuntimeEvent) => void>();
  const stops: Array<() => Promise<void>> = [];
  const clients: ApiSessionClient[] = [];
  const errors: unknown[] = [];
  const hostProcess = new EventEmitter();
  const host = await startSessionHost({ process: hostProcess, exit: () => {}, readTrustedCaller: () => captureProcessBirthWitness(process.pid),
    runSessionCommand: async argv => {
      try {
        const sessionId = argv[0]!;
        const fixture = createPlainSessionFixture({ id: sessionId });
        const socket = createApiSessionSocketStub({ connected: false });
        const client = new ApiSessionClient('synthetic-owner-token', fixture, {
          getServerFeaturesSnapshot: () => snapshot,
          metadataAuthority: { kind: 'shared_editor' }, durableMutationDeliveryInitiallyActive: false,
          transport: { serverId: 'fixture-home', serverUrl,
            createSessionSocketTransport: () => ({ socket: socket as never, transport: createSocketTransportAdapter(socket as never) }) },
        });
        clients.push(client);
        // The provider transport is the external boundary; all host event admission stays real.
        const native: AgentSessionRuntime = {
          send: async () => { throw new Error('Provider-started fixture sends no host input'); },
          watch(listener) { publishers.set(sessionId, listener); return { dispose() { publishers.delete(sessionId); } }; },
          dispose: async () => {},
        };
        const runtime = createNativeAgentSessionOperations(native, sessionId, undefined, undefined, undefined, undefined, undefined, {
          // No native controls are declared or invoked by this provider-started turn fixture.
          context: { agent: { id: 'fixture-agent' }, signal: new AbortController().signal } as AgentSessionRuntimeContext,
          cwd: home, connectedAccounts: [],
          capabilities: { open: ['create'], delivery: ['newTurn'], cancel: false },
          cancellation: { declared: false }, configuration: { declared: false }, compaction: { capability: null },
        });
        const permissionModeState = createPermissionModeQueueState({ session: client, agentTargetKey: 'fixture-agent', initialPermissionMode: 'default' });
        const params: SessionLoopLifecycleParams = {
          opts: { credentials: { token: 'synthetic-owner-token', encryption: { type: 'legacy', secret: new Uint8Array() } }, startedBy: 'daemon' },
          config: {
            flavor: 'default', policyAgentId: 'fixture-agent', backendDisplayName: 'Fixture Agent', uiLogPrefix: '[Fixture]',
            providerName: 'Fixture Agent', waitingForCommandLabel: 'Fixture Agent', agentMessageType: 'fixture-agent',
            runtimeActivityApplicability: 'not_applicable',
            machineMetadata: { host: 'fixture-host', platform: 'linux', happyCliVersion: 'test', homeDir: home, happyHomeDir: home },
            loadTerminalDisplay: async () => () => null, shouldRenderTerminalDisplay: () => false,
            formatPromptErrorMessage: String, processLifecycleOwnership: 'caller', onRuntimeStopReady: stop => { stops.push(stop); },
          },
          api: { push: () => null }, session: client, runtime, hookRuntime: runtime,
          registerProviderAcceptedEffect: () => { throw new Error('Provider turn needs no queued input effect'); },
          prepareStartupPresentation: async () => {
            if (publishers.size === 2) bothPrepared.resolve();
            await finishPresentation.promise;
            return { terminalRemoteModeLoop: null, ownsCurrentTerminalDisplay: false };
          },
          messageBuffer: new MessageBuffer(),
          permissionHandler: createProviderEnforcedPermissionHandler({ session: client, logPrefix: '[Fixture]' }),
          permissionModeState,
          sessionSwapStrategy: { requestSessionSwap: async () => { throw new Error('No Session swap requested'); } },
          runtimeDirectory: home, runtimeMetadata: fixture.metadata, machineId: 'fixture-machine', memoryRecallGuidanceEnabled: false,
          policyAgentId: 'fixture-agent', setActiveAgentCompositionToolSelection: () => {}, happyMcpServerStop: () => {},
          reconnectionHandle: null, startupCoordinator: null, runtimeState: { thinking: false }, setAbortRequestedCallback: () => {},
          transitionModelSelection: async () => { throw new Error('No model transition requested'); }, deps: {}, initialResumeId: '',
        };
        await runSessionLoopLifecycle(params);
      } catch (error) { errors.push(error); throw error; }
    },
  });
  const added = selections.map((selection, index) => host.addSession({ trackingKey: `session-${index}`,
    argv: [`session-${index}`, '--started-by', 'daemon'], cwd: home, env: { [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: selection },
  }));
  let exitResults: Readonly<{ exitCode: number }>[] = [];
  try {
    await vi.waitFor(() => { expect(errors).toEqual([]); expect(publishers.size).toBe(2); expect(stops).toHaveLength(2); }, { timeout: 10_000 });
    await bothPrepared.promise;
    // A native callback can arrive outside either Session's async context.
    for (const [sessionId, publish] of publishers) publish({
      kind: 'turn-start', sessionId, sequence: 1, emittedAtMs: Date.now(), turnId: `turn-${sessionId}`, startedBy: 'provider',
    });
    await vi.waitFor(() => expect(requests).toHaveLength(2), { timeout: 10_000 });
    expect(requests).toEqual(expect.arrayContaining(selections.map((selection, index) => ({
      sessionId: `session-${index}`, event: 'task_started', turnId: `turn-session-${index}`, connectedServiceSelectionsEnvRaw: selection,
    }))));
  } finally {
    finishPresentation.resolve();
    await Promise.all(stops.map(stop => stop()));
    exitResults = await Promise.all(added);
    await Promise.all(clients.map(client => client.close()));
    hostProcess.emit('SIGTERM');
    await host.whenEnded;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  expect(errors).toEqual([]);
  expect(exitResults).toEqual([{ exitCode: 0 }, { exitCode: 0 }]);
  expect(requests).toEqual(expect.arrayContaining(selections.map((selection, index) => ({
    sessionId: `session-${index}`, event: 'turn_cancelled', turnId: `turn-session-${index}`, connectedServiceSelectionsEnvRaw: selection,
  }))));
});
