import { join } from 'node:path';
import { onTestFinished, vi } from 'vitest';
import { AGENT_RUNTIME_DAEMON_SERVICES_PATH, AgentRuntimeDaemonServiceRequestV1Schema, type AgentRuntimeDaemonServiceRequestV1 } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import { createDaemonControlApp, type startDaemonControlServer } from '@/daemon/controlServer';
import * as daemonControlHttp from '@/daemon/controlHttp';
import type { notifyDaemonConnectedServiceTurnLifecycle } from '@/daemon/controlClient';
import { ConnectedServiceTurnLifecycleResultSchema } from '@/daemon/connectedServices/connectedServiceTurnLifecycleContract';
import { createAgentRuntimeDaemonServiceAuthorityPath, publishAgentRuntimeDaemonServiceAuthority } from '@/daemon/agentRuntime/sessionBridgeAuthorization';
import { createRunnerAgentSessionRuntimeSource } from '@/agent/runtime/session/process/runnerAgentSessionRuntimeSource';
import { resolveBackendEngineAdapterResolution } from '@/agent/runtime/registry/engineRegistry';
import { isHostSessionRuntimePlan } from '@/agent/runtime/session/loop/plan';
import { runHostSessionRuntime } from '@/agent/runtime/session/loop/runHostSessionRuntime';
import { configuration } from '@/configuration';
import { hashProcessCommand, writeSessionMarker } from '@/daemon/sessionRegistry';
import * as processIdentity from '@/daemon/processIdentity';
import { ApiClient } from '@/api/api';
import type { UserMessage } from '@/api/types';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { createDeferred } from '@/testkit/async/deferred';
import { SessionTurnMutationV1Schema, type SessionTurnMutationV1 } from '@happier-dev/protocol/sessions/turns/sessionTurnMutationV1';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import type { InstalledProjectAgentDaemonFixture } from './installedProjectAgentDaemonFixture';

/** The installed first-conversation test's real runner/engine/parent composition.
 * Session transport and process census are the only replaced boundaries. */
export async function runInstalledFirstConversationRuntime(input: Readonly<{
  fixture: InstalledProjectAgentDaemonFixture;
  homeServerIdentityId: string;
  control?: Parameters<typeof startDaemonControlServer>[0];
  initialMessage?: UserMessage;
  persistTurnMutation?: (mutation: SessionTurnMutationV1) => Promise<void>;
  beforeDaemonHttpRequest?: (operation: AgentRuntimeDaemonServiceRequestV1['operation']) => Promise<void>;
}>) {
  const { fixture: h, homeServerIdentityId: home, initialMessage } = input;
  const credentials = h.installedCredentials;
  if (!credentials) throw new Error('Installed runtime omitted ordinary owner custody');
  const snapshot = await bootstrapAccountSettingsContext({ credentials, mode: 'blocking', refresh: 'force', honorAccountSettingsModeEnv: false });
  const command = `${process.execPath} ${join(h.f.directory, '.runner-snapshots', 'conversation-runner', 'index.mjs')}`;
  Object.assign(h.runner, { snapshotIdentity: 'snapshot:conversation-runner', processCommandHash: hashProcessCommand(command) });
  h.tracked.processCommandHash = h.runner.processCommandHash;
  vi.spyOn(processIdentity, 'readProcessIdentityByPid').mockResolvedValue({ pid: process.pid, processStartTimeMs: h.runner.processStartTimeMs, command });
  const authorityFilePath = await createAgentRuntimeDaemonServiceAuthorityPath({ happyHomeDir: h.f.directory, publicReleaseRing: configuration.publicReleaseRing });
  const authority = await publishAgentRuntimeDaemonServiceAuthority({ happyHomeDir: h.f.directory, publicReleaseRing: configuration.publicReleaseRing,
    path: authorityFilePath, sessionId: h.sessionId, runner: h.runner, retainedAgent: h.retainedAgent, httpPort: 43129 });
  h.tracked.agentRuntimeDaemonServiceAuthorityFilePath = authorityFilePath;
  if (input.control) h.tracked.agentRuntimeDaemonServiceCapabilityHash = authority.capabilityDigest;
  await writeSessionMarker({ trackingKey: h.tracked.trackingKey, pid: h.runner.pid, happySessionId: h.sessionId, startedBy: 'daemon', cwd: h.cwd,
    processStartTimeMs: h.runner.processStartTimeMs, processCommandHash: h.runner.processCommandHash,
    runnerAgentSourceCustodyV1: h.retainedAgent.sourceCustody, agentRuntimeDaemonServiceAuthorityFilePath: authorityFilePath });
  const readDaemonHttp = daemonControlHttp.readDaemonControlHttpResponse;
  const app = input.control ? createDaemonControlApp({ ...input.control, controlToken: 'first-conversation-control' }) : null;
  if (app) onTestFinished(() => app.close());
  // Daemon control HTTP owns its Undici client, independently of global fetch.
  // Replace only that network boundary; decoding, route admission and dispatch stay real.
  vi.spyOn(daemonControlHttp, 'readDaemonControlHttpResponse').mockImplementation(async params => {
    if (params.path !== AGENT_RUNTIME_DAEMON_SERVICES_PATH) return await readDaemonHttp(params);
    const request = AgentRuntimeDaemonServiceRequestV1Schema.parse(params.body);
    await input.beforeDaemonHttpRequest?.(request.operation);
    if (!app) {
      const result = await h.dispatch(request.operation, request.context.executionRunSnapshotId);
      return { ok: true, status: 200, body: JSON.stringify(result) };
    }
    const response = await app.inject({ method: 'POST', url: params.path,
      // The real transport sends exactly this JSON text with its JSON content type.
      headers: params.headers, payload: JSON.stringify(params.body) });
    return { ok: response.statusCode >= 200 && response.statusCode < 300,
      status: response.statusCode, body: response.body };
  });
  const source = await createRunnerAgentSessionRuntimeSource({ happyHomeDir: h.f.directory, publicReleaseRing: configuration.publicReleaseRing,
    authorityFilePath, expectedSessionId: h.sessionId });
  if (!source) throw new Error('The installed daemon did not issue a current Session runner source');
  onTestFinished(() => source.retire?.());
  const resolution = await resolveBackendEngineAdapterResolution(h.retainedAgent.agentId, {
    runtimeRegistry: h.plugin.registry, runnerAgentSessionRuntimeSource: source, requireRunnerAgentSessionRuntimeSource: true,
    happyHomeDir: h.f.directory,
  });
  if (!resolution) throw new Error('Real native Session engine resolution failed');
  const plan = await resolution.engineAdapter.runtimeCore.createSessionRuntime({ credentials, directory: h.cwd,
    happyHomeDir: h.f.directory, startedBy: 'daemon', existingSessionId: h.sessionId,
    backendTarget: { kind: 'agent', identity: { pluginId: 'acme.project-launch', localId: 'agent' } } });
  if (!isHostSessionRuntimePlan(plan)) throw new Error('Native engine did not produce the canonical parent runtime plan');
  const answered = createDeferred<void>();
  const completed = createDeferred<void>();
  const failed = createDeferred<void>();
  const turns: SessionTurnMutationV1[] = [];
  let stop: (() => Promise<void>) | undefined;
  const assistant: string[] = [];
  const transcriptSequences = new Map<string, number>();
  const session = createMutableApiSessionClientFixture({ sessionId: h.sessionId,
    serverBinding: { serverId: h.f.bootstrap.attribution.serverId, serverUrl: 'https://session-home.test' },
    metadata: createTestMetadata({ path: h.cwd, machineId: 'machine', permissionMode: 'default',
      mcpSelectionV1: { v: 1, managedServersEnabled: true, forceIncludeServerIds: [], forceExcludeServerIds: [] } }),
    overrides: {
      getServerIdentityId: () => home,
      getServerFeaturesSnapshot: () => ({ status: 'ready', features: FeaturesResponseSchema.parse({
        features: { sessions: { enabled: true, autonomousExchange: { enabled: true } } },
      }) }),
      claimCurrentSessionPublisherAuthorityForStartup: async () => ({ status: 'claimed' }),
      activateDurableMutationDelivery: async () => undefined, deactivateDurableMutationDelivery: () => undefined,
      enqueueSessionTurnMutation: async value => {
        const mutation = SessionTurnMutationV1Schema.parse(value);
        await input.persistTurnMutation?.(mutation);
        turns.push(mutation);
        if (mutation.action === 'complete') completed.resolve();
        if (mutation.action === 'fail') failed.resolve();
      },
      enqueueRegisteredSessionStateFieldMutation: async () => undefined,
      enqueueSessionEventCommitted: async () => ({ persisted: true, delivered: true }),
      enqueueAgentMessageCommitted: async (_provider, message, options) => {
        if (message.type === 'message') {
          assistant.push(message.message); answered.resolve();
        }
        let committedSequence = transcriptSequences.get(options.localId);
        if (committedSequence === undefined) {
          committedSequence = transcriptSequences.size + 2;
          transcriptSequences.set(options.localId, committedSequence);
        }
        return { persisted: true, delivered: true, committedSequence };
      },
      onUserMessage: handler => {
        // A real first Send is already pending when the lazy parent installs
        // its input consumer; it does not wait for native startup to deliver it.
        if (initialMessage) handler(initialMessage);
      },
      hasPendingProviderInput: localId => initialMessage !== undefined && localId === initialMessage.localId,
      getCommittedUserMessageSeq: localId => initialMessage !== undefined && localId === initialMessage.localId ? 1 : null,
      getPendingQueueState: () => ({ known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 0 }),
      shouldAttemptPendingMaterialization: () => false,
      subscribeExecutionRunActivitySnapshots: () => () => undefined, setOwnerActivityDelivery: () => undefined,
      setSessionRuntimeControls: () => undefined, readRolePromptOrganization: async () => ({}),
    },
  });
  const api = await ApiClient.create(credentials);
  const outcome = runHostSessionRuntime({ ...plan.opts, accountSettingsContext: { ...snapshot, whenRefreshed: null } }, {
    ...plan.config, pluginRuntimeRegistryLease: h.plugin.lease,
    processLifecycleOwnership: 'caller',
    // The inputless startup-refusal probe explicitly opens the native runtime.
    ...(initialMessage ? {} : { startRuntimeBeforeFirstPrompt: true }),
    loadTerminalDisplay: async () => () => null, shouldRenderTerminalDisplay: () => false,
    onRuntimeStopReady: requestStop => { stop = requestStop; },
  }, { ...plan.deps,
    ...(app ? { sessionLoopLifecycleDeps: { ...plan.deps?.sessionLoopLifecycleDeps, notifyDaemonConnectedServiceTurnLifecycleFn: (async body => {
      const response = await app.inject({ method: 'POST', url: '/connected-service-turn-lifecycle',
        headers: { 'x-happier-daemon-token': 'first-conversation-control' }, payload: body });
      const result: unknown = response.json();
      if (response.statusCode !== 200 || !result || typeof result !== 'object' || !('result' in result)) {
        throw new Error('Daemon lifecycle request failed');
      }
      return ConnectedServiceTurnLifecycleResultSchema.parse(result.result);
    }) satisfies typeof notifyDaemonConnectedServiceTurnLifecycle } } : {}),
    initializeBackendApiContextFn: async () => ({ api, machineId: 'machine' }),
    initializeBackendRunSessionFn: async () => ({ session, reconnectionHandle: null,
      reportedSessionId: h.sessionId, attachedToExistingSession: true }),
  });
  void outcome.catch(() => undefined);
  return { outcome, answered, completed, failed, turns, assistant, stop: async () => {
    // Construction can publish a failure before installing a live Stop
    // delegate. The runtime's terminal outcome also proves it has stopped.
    await Promise.race([stop?.(), outcome.then(() => undefined, () => undefined)]);
  } };
}
