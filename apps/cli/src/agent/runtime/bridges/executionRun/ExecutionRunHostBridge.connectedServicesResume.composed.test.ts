import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import axios from 'axios';
import { afterAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { createExecutionRunHostBackendFromConversationRuntime,
  type AgentExecutionRunConversationEventV1, type AgentExecutionRunConversationRuntimeV1, type AgentExecutionRunOpenRequest,
  type AgentExecutionRunRuntime, type AgentSessionOpenRequest,
  type AgentSessionRuntime, type AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import type { SessionExecutionRunBrokerAuthorityResponseV1 } from '@happier-dev/protocol';
import type { PluginDaemonModuleNamespace } from '@/plugins/runtime/types';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { resolveCliEngineRegistry } from '@/agent/runtime/registry/engineRegistry';
import { listExecutionRunMarkersForRehydration } from '@/daemon/executionRunRegistry';
import { ExecutionRunHostBridge } from './ExecutionRunHostBridge';
import { reloadConfiguration } from '@/configuration';
import { resolveCliVoicePromptPreparation } from '@/agent/prompts/library/resolveCliVoicePromptStackBlocks';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { ProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/handler';
import { createExecutionRunRuntime } from './runtime/create';
// Resolve the real native owner during collection, as its existing owner tests
// do, instead of charging its first source transform to the behavior deadline.
import '@/agent/runtime/registry/engineRegistry/runtimeCore';

const { directory, originalHome } = await vi.hoisted(async () => {
  const [{ mkdtemp }, { tmpdir }, { join }] = await Promise.all([
    import('node:fs/promises'), import('node:os'), import('node:path'),
  ]);
  const directory = await mkdtemp(join(tmpdir(), 'happier-connected-run-resume-'));
  const originalHome = process.env.HAPPIER_HOME_DIR;
  process.env.HAPPIER_HOME_DIR = directory;
  return { directory, originalHome };
});

const transport = vi.hoisted(() => ({ materialize: vi.fn(), release: vi.fn(async () => ({ ok: true, released: true })) }));
// Only the runner-to-daemon transport is doubled. Source admission, registry,
// selection, Run lifecycle and broker authority remain real.
vi.mock('@/daemon/controlClient', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/daemon/controlClient')>(),
  requestExecutionRunConnectedServicesMaterialization: transport.materialize,
  releaseExecutionRunConnectedServices: transport.release,
}));
// The current Session service is authenticated by the persisted Account
// boundary. Never read a developer's credentials from this fixture.
vi.mock('@/persistence', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/persistence')>(),
  readStoredCredentials: async () => ({ token: 'connected-resume-fixture', encryption: null }),
}));

describe('connected execution-run resume custody', () => {
  afterAll(async () => {
    if (originalHome === undefined) delete process.env.HAPPIER_HOME_DIR;
    else process.env.HAPPIER_HOME_DIR = originalHome;
    reloadConfiguration();
    await rm(directory, { recursive: true, force: true });
  });
  it('attests backend and voice resumes and publishes only their successfully resumed registrations', async () => {
    let intent: 'agent' | 'voice_agent' = 'agent';
    transport.materialize.mockClear();
    // This authenticated fixture has no Home data to fetch. Every transport
    // outside its daemon/provider boundary fails immediately, never reaching
    // a live Account with the fixture token.
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => { throw new Error('Unexpected fixture Home request'); }));
    vi.spyOn(axios, 'get').mockRejectedValue(new Error('Unexpected fixture Home request'));
    vi.spyOn(axios, 'post').mockRejectedValue(new Error('Unexpected fixture Home request'));
    const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
    const disclosedMember = { service, accountId: 'member' };
    let failLoad = false;
    let loadGate: Promise<void> | null = null;
    let loadEntered: (() => void) | null = null;
    let emitCheckpoint: (() => void) | null = null;
    const providerRequests: Array<AgentExecutionRunOpenRequest | AgentSessionOpenRequest> = [];
    let resolveProviderOpened!: () => void;
    let providerOpened = new Promise<void>((resolve) => { resolveProviderOpened = resolve; });
    // The authored public-SDK leaf stands in for the external provider process.
    // Its canonical SDK conversation adapter and every host owner remain real.
    const openProvider = async (request: AgentExecutionRunOpenRequest): Promise<AgentExecutionRunRuntime> => {
      providerRequests.push(request);
      if (request.kind === 'fork') throw new Error('Fixture does not support fork');
      if (request.kind === 'resume') {
        loadEntered?.();
        await loadGate;
        if (failLoad) throw new Error('Provider refused resume');
      }
      let emit: ((event: AgentExecutionRunConversationEventV1) => void) | null = null;
      const runtime = await createExecutionRunHostBackendFromConversationRuntime({ request,
        readCheckpointId: (event) => event.kind === 'turn-start' ? 'provider-thread' : null,
        openConversation: () => ({
          watch(listener) {
            emit = listener;
            emitCheckpoint = () => emit?.({ kind: 'turn-start', turnId: 'checkpoint', startedBy: 'host' });
            return { dispose() { emit = null; } };
          },
          async send(input) {
            emit?.({ kind: 'turn-start', turnId: input.delivery.turnId, startedBy: 'host' });
            return { status: 'admitted' };
          },
          async cancel(input) {
            emit?.({ kind: 'turn-cancelled', turnId: input.turnId, cause: input.reason });
            return { status: 'requested', turnId: input.turnId };
          },
          async dispose() {},
        }),
      });
      resolveProviderOpened();
      return runtime;
    };
    // Retained Runs open the conversation facet; finite open terminalizes after
    // one turn and cannot supply the retained handle this test exercises.
    const openConversation = async (request: AgentExecutionRunOpenRequest): Promise<AgentExecutionRunConversationRuntimeV1> => {
      providerRequests.push(request);
      if (request.kind === 'fork') throw new Error('Fixture does not support fork');
      if (request.kind === 'resume') {
        loadEntered?.();
        await loadGate;
        if (failLoad) throw new Error('Provider refused resume');
      }
      let emit: ((event: AgentExecutionRunConversationEventV1) => void) | null = null;
      resolveProviderOpened();
      return {
        watch(listener) {
          emit = listener;
          emitCheckpoint = () => emit?.({ kind: 'provider-session-id', providerSessionId: 'provider-thread', emittedAtMs: 1 });
          emitCheckpoint();
          return { dispose() { emit = null; } };
        },
        async send(input) {
          emit?.({ kind: 'input-accepted', inputIds: input.inputIds, delivery: input.delivery, emittedAtMs: 1 });
          emit?.({ kind: 'turn-start', turnId: input.delivery.turnId, startedBy: 'host', emittedAtMs: 1 });
          return { status: 'admitted' };
        },
        async cancel(input) {
          emit?.({ kind: 'turn-cancelled', turnId: input.turnId, cause: input.reason, emittedAtMs: 1 });
          return { status: 'requested', turnId: input.turnId };
        },
        async dispose() { emit = null; },
      };
    };
    // Session-owned Voice uses the ordinary public Session facet, not the
    // detached executionRunContext facet. This mirrors the successful native
    // Voice fixture's external provider boundary.
    const openSession = async (request: AgentSessionOpenRequest): Promise<AgentSessionRuntime> => {
      providerRequests.push(request);
      // The external provider sees the selected profile's materialized auth,
      // not just a selection recorded on the host's launch projection.
      expect(request.launchEnvironment?.values.HAPPIER_TEST_AUTH).toBe('voice-profile-credential');
      if (request.kind === 'fork') throw new Error('Fixture does not support fork');
      if (request.kind === 'resume') {
        loadEntered?.();
        await loadGate;
        if (failLoad) throw new Error('Provider refused resume');
      }
      let listener: ((event: AgentSessionRuntimeEvent) => void) | null = null;
      let sequence = 0;
      const runtime: AgentSessionRuntime = {
        watch(next) {
          listener = next;
          emitCheckpoint = () => listener?.({ kind: 'provider-session-id', providerSessionId: 'provider-thread',
            sessionId: request.sessionId, sequence: ++sequence, emittedAtMs: sequence });
          emitCheckpoint();
          return { dispose() { listener = null; } };
        },
        async send() { return { status: 'admitted' }; },
        async cancel({ turnId }) { return { status: 'requested', turnId }; },
        async dispose() { listener = null; },
      };
      resolveProviderOpened();
      return runtime;
    };
    const plugin = definePlugin({ id: 'test.connected-resume', version: '0.0.0', displayName: 'Resume boundary Agent',
      // Claude's supported Session-owned Voice runtime declares this same
      // current-Session authority; connected account purposes do not imply it.
      hostAccess: { required: [{ id: 'session-runtime', capability: 'sessions',
        reason: 'Use the authenticated current Session for retained Voice.',
        scope: { access: ['read', 'write', 'control'] } }], optional: [] },
      entrypoints: { daemon: './daemon.mjs' }, agents: { agent: {
        declaration: { title: 'Resume boundary Agent', runtime: { kind: 'custom' }, primary: 'sessions',
          connectedAccounts: [{ purpose: 'primary', service }],
          capabilities: { sessions: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: true,
            executionRunContext: { versions: [1] } } } },
        factory: () => ({ sessions: { open: openSession,
          executionRunContextV1: { open: openProvider, openConversation } } }),
        sessionRunnerFactory: { module: './agent-runtime.mjs', export: 'createRuntime', runtimeApiVersion: 1 },
      } } });
    const agent = { pluginId: plugin.manifest.id, localId: 'agent' };
    const agentId = `${agent.pluginId}/${agent.localId}`;
    const fixture = await createAuthoredAdmittedPluginRuntimeFixture({ controller: pluginReloadController, happyHomeDir: directory,
      plugins: [{ manifest: plugin.manifest, files: {
        'agent-runtime.mjs': `let open, openSession, openConversation; export function configure(callback, sessionCallback, conversationCallback) { open = callback; openSession = sessionCallback; openConversation = conversationCallback; }
          export function createRuntime() { return { sessions: {
            open: request => openSession(request),
            executionRunContextV1: { open: request => open(request), openConversation: request => openConversation(request) } } }; }`,
        'daemon.mjs': `import * as leaf from './agent-runtime.mjs';
          export function activate(api) { api.agents.register('agent', leaf.createRuntime, {
            sessionRunnerFactory: { module: './agent-runtime.mjs', export: 'createRuntime', runtimeApiVersion: 1 } }); }
          export function configureUnitLeaf(open, openSession, openConversation) { leaf.configure(open, openSession, openConversation); return { activate }; }`,
      }, instantiateCommittedModule(module) {
        const configure = module.configureUnitLeaf;
        if (typeof configure !== 'function') throw new Error('Missing provider boundary fixture');
        const configured: unknown = configure(openProvider, openSession, openConversation);
        if (!configured || typeof configured !== 'object' || !('activate' in configured)) throw new Error('Missing activation');
        return configured as PluginDaemonModuleNamespace;
      } }] });
    let bridge: ExecutionRunHostBridge | null = null;
    const parentSession = createMutableApiSessionClientFixture({ sessionId: 'voice-parent-session',
      metadata: createTestMetadata({ path: fixture.happyHomeDir }) });
    const parentPermissions = new ProviderEnforcedPermissionHandler(parentSession, { logPrefix: '[Voice fixture]' });
    let phase = 'admitted runtime resolution';
    let completed = false;
    onTestFinished(() => {
      if (!completed) console.error('Actual connected Run fixture failure phase', phase,
        { materializations: transport.materialize.mock.calls.length, providerOpens: providerRequests.map((request) => request.kind) });
    });
    try {
      const engineRegistry = await resolveCliEngineRegistry({ runtimeRegistry: fixture.registry });
      phase = 'admitted profile catalog resolution';
      const profileCatalog = await engineRegistry.resolveExecutionRunProfileCatalog({ resolveAgentIdentity: () => agent });
      phase = 'admitted native runtime resolution';
      const engine = await engineRegistry.resolveForBackendId(agentId);
      expect(engine?.agent.identity).toEqual(agent);
      const sourceCustody = fixture.registry.readPluginSourceCustody?.(agent.pluginId);
      if (!sourceCustody) throw new Error('Missing admitted source custody');
      // Authored launch values keep this fixture independent of the runner's
      // environment. The targeted gate also supplies these same inherited
      // values, exercising the real plugin-engine isolation bundle without
      // mutating process.env. Both reach the public native launch schema.
      phase = 'selected-purpose execution-run environment';
      for (const connected of [true, false]) {
        transport.materialize.mockImplementation(async (request: { runId: string; connectedServices: unknown }) => {
          const activationId = randomUUID();
          return { ok: true, result: { activationId, env: {},
            unsetEnvKeys: ['AGY_ACP_CCPA_BASE_URL', 'AGY_ACP_CCPA_PROJECT'],
            connectedServicesBindings: request.connectedServices,
            registration: { v: 1, activationId, runKey: request.runId, agentId,
              agentContribution: { ...agent, sourceCustody }, materializationKey: request.runId,
              connectedServicesBindings: request.connectedServices, connectedServiceSelectionsEnv: {},
              sessionDirectory: fixture.happyHomeDir, materializedRoot: `${fixture.happyHomeDir}/environment-home` } } };
        });
        const run = createExecutionRunRuntime({
          engineRegistry, happyHomeDir: fixture.happyHomeDir, cwd: fixture.happyHomeDir,
          backendId: agentId, backendTarget: { kind: 'builtInAgent', agentId },
          scope: 'detached', permissionMode: 'read_only', runId: `environment-${connected}`,
          start: { intent: 'agent', profileId: 'agent' },
          secretReferenceEnvironment: { AGY_ACP_CCPA_BASE_URL: 'https://native.example',
            agy_acp_ccpa_project: 'native-project' },
          connectedServices: { v: 2, bindingsByServiceId: { [`${service.pluginId}/${service.localId}`]: connected
            ? { source: 'connected', selection: 'profile', profileId: 'environment-profile' }
            : { source: 'native' } } },
        });
        try {
          await expect(run.provisionRuntime({ initialPrompt: 'Check the selected launch environment.' }))
            .resolves.toMatchObject({ runtimeId: expect.any(String) });
          const launch = providerRequests.at(-1)?.launchEnvironment;
          if (!launch) throw new Error('Actual external provider launch environment unavailable');
          if (connected) {
            expect(launch.values).not.toHaveProperty('AGY_ACP_CCPA_BASE_URL');
            expect(launch.values).not.toHaveProperty('agy_acp_ccpa_project');
            expect(launch.unset).toEqual(['AGY_ACP_CCPA_BASE_URL', 'AGY_ACP_CCPA_PROJECT']);
          } else {
            expect(launch.values).toMatchObject({ AGY_ACP_CCPA_BASE_URL: 'https://native.example',
              agy_acp_ccpa_project: 'native-project' });
            expect(launch.unset).toEqual([]);
          }
        } finally { await run.dispose(); }
      }
      providerRequests.length = 0;
      transport.materialize.mockClear();
      const queries: SessionExecutionRunBrokerAuthorityResponseV1[] = [];
      const activations: string[] = [];
      transport.materialize.mockImplementation(async (request: { runId: string; connectedServices: unknown }) => {
        if (intent === 'agent') {
        const authority = bridge!.resolveLiveBrokerAuthority({ v: 1, executionRunId: request.runId,
          expectedOccurrenceId: null, expectedDirectMaterialUse: { resourceId: 'direct-resource',
            slot: { kind: 'connected_service_purpose', purpose: { consumer: agent, purpose: 'primary' } }, disclosedMember } });
        queries.push(authority);
        if (authority.status !== 'current') return { ok: false, error: 'Run broker authority is not current' };
        }
        const activationId = randomUUID();
        activations.push(activationId);
        return { ok: true, result: { activationId,
          env: intent === 'voice_agent' ? { HAPPIER_TEST_AUTH: 'voice-profile-credential' } : {},
          connectedServicesBindings: request.connectedServices,
          registration: { v: 1, activationId, runKey: request.runId, agentId,
            agentContribution: { ...agent, sourceCustody }, materializationKey: request.runId,
            connectedServicesBindings: request.connectedServices, connectedServiceSelectionsEnv: {},
            sessionDirectory: fixture.happyHomeDir, materializedRoot: `${fixture.happyHomeDir}/durable-home` } } };
      });
      for (const runIntent of ['agent', 'voice_agent'] as const) {
      intent = runIntent;
      failLoad = false;
      loadGate = null;
      loadEntered = null;
      emitCheckpoint = null;
      providerRequests.length = 0;
      queries.length = 0;
      activations.length = 0;
      providerOpened = new Promise<void>((resolve) => { resolveProviderOpened = resolve; });
      bridge = new ExecutionRunHostBridge({ parentProvider: 'codex', cwd: fixture.happyHomeDir,
        resolveRunReportPolicy: async () => ({ preset: 'important' }),
        happyHomeDir: fixture.happyHomeDir, sendAcp: async () => {}, getNowMs: () => 1_700_000_000_000,
        sessionInteractionHost: { session: parentSession, machineId: 'fixture-machine', permissionHandler: parentPermissions },
        // Prepare the actual, empty attached Session prompt sources through the
        // real prompt owner; this fixture has no network-owned Account overlays.
        resolveVoicePromptPreparation: async (args) => await resolveCliVoicePromptPreparation({ ...args,
          sessionMetadata: parentSession.getMetadataSnapshot(), accountEntries: [], profileEntries: [],
          directory: args.workingDirectory ?? undefined }),
        // This is the same daemon generation-check transport boundary as materialization.
        checkConnectedServicesGenerationCurrent: async ({ registration }) => ({
          current: registration.activationId === activations.at(-1),
        }),
        resolveExecutionRunProfileCatalog: async () => ({ profileCatalog, engineRegistry }) });
      phase = 'initial provider startup';
      const started = await bridge.start({ sessionId: intent === 'voice_agent' ? 'voice-parent-session' : null, intent,
        backendTarget: { kind: 'builtInAgent', agentId }, instructions: 'Wait for input.',
        permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived',
        ioMode: intent === 'voice_agent' ? 'streaming' : 'request_response',
        ...(intent === 'voice_agent' ? { bootstrapMode: 'none' as const, initialContextMode: 'first_turn' as const,
          chatModelId: 'voice-model', commitModelId: 'default' } : {}),
        connectedServices: { v: 2, bindingsByServiceId: { [`${service.pluginId}/${service.localId}`]: {
          ...(intent === 'agent'
            ? { source: 'team_resource' as const, resourceId: 'direct-resource', deliveryMode: 'direct' as const, disclosedMember }
            : { source: 'connected' as const, selection: 'profile' as const, profileId: 'voice-profile' }),
        } } } });
      await providerOpened;
      phase = 'initial provider checkpoint';
      await vi.waitFor(() => {
        emitCheckpoint?.();
        expect(bridge!.get(started.runId), JSON.stringify({
          status: bridge!.get(started.runId)?.status, resumeHandle: bridge!.get(started.runId)?.resumeHandle,
          error: bridge!.get(started.runId)?.error, queries: queries.map((query) => query.status),
          providerRequests: providerRequests.map((request) => request.kind),
        })).toMatchObject({
          // The commit role is lazy; both this native Voice and detached Agent
          // have exactly one opened provider Session at this boundary.
          status: 'running', resumeHandle: { kind: 'provider_session.v1' },
        });
      });
      expect(queries).toEqual(intent === 'agent' ? [expect.objectContaining({ status: 'current' })] : []);
      if (intent === 'voice_agent') expect(bridge.get(started.runId)?.launch?.connectedServicesSelection)
        .toMatchObject({ bindingsByServiceId: { [`${service.pluginId}/${service.localId}`]: {
          source: 'connected', selection: 'profile', profileId: 'voice-profile',
        } } });
      await bridge.stop(started.runId);
      await bridge.waitForTerminal(started.runId);
      phase = 'successful resume';
      await expect(bridge.ensure(started.runId, { resume: true })).resolves.toEqual({ ok: true });
      expect(queries).toHaveLength(intent === 'agent' ? 2 : 0);
      const registration = bridge.get(started.runId)?.launch?.connectedServicesRegistration;
      expect(registration?.activationId).toBe(activations.at(-1));
      expect((await listExecutionRunMarkersForRehydration()).find((marker) => marker.runId === started.runId))
        .toMatchObject({ status: 'running', executionRunConnectedServicesCleanupReceiptV1: { activationId: activations.at(-1) } });

      await bridge.stop(started.runId);
      await bridge.waitForTerminal(started.runId);
      // The evolved recovery owner deliberately omits transient registrations.
      // Failure must preserve that actual retained launch, not resurrect an
      // already-released runtime registration from the preceding occurrence.
      await bridge.recoverRetainedRuns();
      const retainedLaunch = bridge.get(started.runId)?.launch;
      const retainedStatus = bridge.get(started.runId)?.status;
      const terminalMarker = (await listExecutionRunMarkersForRehydration()).find((marker) => marker.runId === started.runId);
      phase = 'failed provider load';
      failLoad = true;
      await expect(bridge.ensure(started.runId, { resume: true })).resolves.toMatchObject({ ok: false });
      expect(bridge.get(started.runId)?.launch).toEqual(retainedLaunch);
      expect(bridge.get(started.runId)?.status).toBe(retainedStatus);
      expect((await listExecutionRunMarkersForRehydration()).find((marker) => marker.runId === started.runId)).toEqual(terminalMarker);

      failLoad = false;
      let releaseLoad!: () => void;
      loadGate = new Promise<void>((resolve) => { releaseLoad = resolve; });
      const enteringLoad = new Promise<void>((resolve) => { loadEntered = resolve; });
      phase = 'stop during provider provisioning';
      const resuming = bridge.ensure(started.runId, { resume: true });
      await enteringLoad;
      expect(bridge.get(started.runId)?.status).toBe('running');
      expect(bridge.get(started.runId)?.launch?.connectedServicesRegistration).toEqual(retainedLaunch?.connectedServicesRegistration);
      expect((await listExecutionRunMarkersForRehydration()).find((marker) => marker.runId === started.runId)).toEqual(terminalMarker);
      const stopping = bridge.stop(started.runId);
      await vi.waitFor(() => expect(bridge!.get(started.runId)?.status).toBe('cancelled'));
      releaseLoad();
      await stopping;
      await expect(resuming).resolves.toMatchObject({ ok: false });
      expect(bridge.get(started.runId)?.status).toBe('cancelled');
      expect(bridge.get(started.runId)?.launch?.connectedServicesRegistration).toEqual(retainedLaunch?.connectedServicesRegistration);
      await bridge.dispose();
      bridge = null;
      }
      completed = true;
    } finally {
      await bridge?.dispose();
      await parentSession.close();
      await fixture.dispose();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });
});
