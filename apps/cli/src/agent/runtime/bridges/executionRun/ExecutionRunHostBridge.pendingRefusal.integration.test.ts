import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import axios from 'axios';
import { definePlugin } from '@happier-dev/plugin-sdk';
import type { AgentSessionOpenRequest, AgentSessionRuntime, AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import { ExecutionRunGetResponseSchema, QualifiedConnectedAccountListResponseV4Schema, type SessionInputAdmissionResultV1 } from '@happier-dev/protocol';
import { getAgentStaticModels } from '@happier-dev/agents';
import { ExecutionRunHostBridge } from './ExecutionRunHostBridge';
import type { ExecutionRunState } from './executionRunTypes';
import { resolveCliEngineRegistry } from '@/agent/runtime/registry/engineRegistry';
import type { ResolvedCliEngineRegistry } from '@/agent/runtime/registry/engineRegistryTypes';
import type { PluginDaemonModuleNamespace } from '@/plugins/runtime/types';
import type { ExecutionRunProfileContributionCatalog } from '@/agent/executionRuns/profiles/intentRegistry';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { reloadConfiguration } from '@/configuration';
import { captureScmComparison } from '@/scm/comparisons/captureScmComparison';
import { scmDiffSummaryResultStore } from '@/agent/executionRuns/tasks/scmDiffSummary/results/resultStore';
import type { ExecutionRunAdmittedPendingInputV1, ExecutionRunPendingInputBinding } from '@/api/session/client/transport/sessionClientInteractionApi';
import type { SessionProviderInputOutcome } from '@/agent/runtime/session/input/providerInputOutcome';
import type { ExecutionRunBackendController } from '@/agent/executionRuns/controllers/types';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { ProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/handler';
import { createExecutionRunTranscriptCustodyError } from './executionRunTranscriptPublisher';
import { createExecutionRunRpcActionDeps } from '@/rpc/handlers/executionRuns/dispatchExecutionRunRpcAction';
import { ApiClient } from '@/api/api';
import type { Credentials } from '@/persistence';
import { createForegroundPurposeOwnerFixture } from '@/daemon/agentRuntime/prepareForegroundAdmission.connectedServices.testkit';
import { withAgentPreflightCatalog } from '@/capabilities/probes/withAgentPreflightCatalog';
import { invokeCliPreflightMethod } from '@/capabilities/probes/agentPreflight';
import { readNativeExecutionRunOfferedModel } from './structuredOutputAdmission';

const materialize = vi.hoisted(() => vi.fn());
// Only daemon transport, external Agent process and persisted credentials are doubled.
vi.mock('@/daemon/controlClient', async original => ({
  ...await original<typeof import('@/daemon/controlClient')>(),
  requestExecutionRunConnectedServicesMaterialization: materialize,
  releaseExecutionRunConnectedServices: async () => ({ ok: true, released: true }),
}));
vi.mock('@/persistence', async original => ({
  ...await original<typeof import('@/persistence')>(),
  readStoredCredentials: async () => ({ token: 'pending-run-fixture', encryption: null }),
}));
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>();
  const { createBundledPluginPublicationFsFixture } = await import('@/plugins/projection/registry/builtIn/locators.testkit');
  return createBundledPluginPublicationFsFixture(actual);
});

const TEST_BACKEND_ID = 'test.pending-refusal/agent' as never;
let directory: string;
let admittedFixture: Awaited<ReturnType<typeof createAuthoredAdmittedPluginRuntimeFixture>> | undefined;
let openNativeSession: (request: AgentSessionOpenRequest) => Promise<AgentSessionRuntime>;
const bridges: ExecutionRunHostBridge[] = [];
const parentSessions: Pick<ReturnType<typeof createMutableApiSessionClientFixture>, 'close'>[] = [];
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'happier-run-refusal-'));
});
beforeEach(() => {
  vi.stubEnv('HAPPIER_HOME_DIR', directory);
  reloadConfiguration();
});
afterEach(async () => {
  await Promise.all(bridges.splice(0).map(manager => manager.dispose()));
  await Promise.all(parentSessions.splice(0).map(session => session.close()));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  reloadConfiguration();
});
afterAll(async () => {
  // Model admission and the bridge must observe the same authoritative controller.
  // Its fixture owns shutdown once, after every table row has released its Runs.
  try { await admittedFixture?.dispose(); }
  finally { rmSync(directory, { recursive: true, force: true }); }
});

function createHarness(detached = false, checkConnectedServicesGenerationCurrent?: ConstructorParameters<typeof ExecutionRunHostBridge>[0]['checkConnectedServicesGenerationCurrent'],
  resolution?: { engineRegistry: ResolvedCliEngineRegistry; profileCatalog: ExecutionRunProfileContributionCatalog;
    readNativeOfferedModel?: NonNullable<Parameters<ExecutionRunHostBridge['start']>[0]['readNativeOfferedModel']> }) {
  let consume: ExecutionRunPendingInputBinding['consume'] | undefined;
  const acceptedInputs = new Set<string>();
  const rejectedInputs = new Set<string>();
  const settlements: SessionProviderInputOutcome[] = [];
  const enqueueSessionUserMessageWithDisposition = vi.fn<(input: { text: string; localId: string }) => Promise<SessionInputAdmissionResultV1>>(
    async (input) => ({ status: 'accepted', localId: input.localId }));
  let observeFirstEnqueuedInput: () => void = () => undefined;
  const firstEnqueuedInput = new Promise<void>(resolve => { observeFirstEnqueuedInput = resolve; });
  const listExecutionRunPendingDeliveryStatuses = vi.fn(async () => [
    { localId: 'queued-1', status: 'queued' as const, deliveryStatus: { status: 'queued' as const } },
    { localId: 'blocked-1', status: 'blocked' as const, deliveryStatus: { status: 'blocked' as const, reason: 'session_input_target_unavailable' as const } },
  ]);
  const blockExecutionRunPendingDelivery = vi.fn(async () => true);
  const enqueueAgentMessageCommitted = vi.fn(async () => ({ persisted: true, delivered: false }));
  const sendAcp = vi.fn<ConstructorParameters<typeof ExecutionRunHostBridge>[0]['sendAcp']>(async () => undefined);
  const parentSession = createMutableApiSessionClientFixture({ sessionId: 'session-1', metadata: createTestMetadata({ path: directory }) });
  parentSessions.push(parentSession);
  const permissionHandler = new ProviderEnforcedPermissionHandler(parentSession, { logPrefix: '[Run refusal fixture]' });
  const manager = new ExecutionRunHostBridge({
    // External Account preference input for this admission fixture.
    resolveRunReportPolicy: async () => ({ preset: 'important' }),
    parentProvider: TEST_BACKEND_ID,
    cwd: detached ? directory : process.cwd(),
    sendAcp,
    checkConnectedServicesGenerationCurrent,
    ...(resolution ? { resolveExecutionRunProfileCatalog: async () => resolution } : {}),
    ...(!detached ? { sessionInteractionHost: {
      // Parent Agent configuration is an external runtime observation; child selection stays real.
      readAppliedChildSelection: async () => ({ status: 'applied' as const, backendTarget: { kind: 'builtInAgent' as const, agentId: 'claude' },
        modelId: getAgentStaticModels('claude', { catalogOnly: true })[0]!.id, connectedServices: null }),
      session: Object.assign(parentSession, {
        sessionId: 'session-1',
        enqueueAgentMessageCommitted,
        enqueueSessionUserMessageWithDisposition: async (input: Parameters<typeof enqueueSessionUserMessageWithDisposition>[0]) => {
          const disposition = await enqueueSessionUserMessageWithDisposition(input);
          observeFirstEnqueuedInput();
          return disposition;
        },
        bindExecutionRunPendingInput: (binding: ExecutionRunPendingInputBinding) => {
          consume = input => {
            const admitted = binding.consume(input);
            binding.wake?.();
            return admitted;
          };
          return { getMetadataSnapshot: () => null, waitForMetadataUpdate: async () => await new Promise<boolean>(() => undefined),
            shouldAttemptPendingMaterialization: () => false, reconcilePendingProviderInputCustodyBeforeMaterialization: async () => true,
            materializeNextPendingMessageSafely: async () => ({ type: 'no_pending' as const }),
            observeProviderInputSettlement: async (outcome: SessionProviderInputOutcome) => {
              settlements.push(outcome);
              if (outcome.kind === 'accepted') acceptedInputs.add(outcome.localId);
              if (outcome.kind === 'rejected_before_effect') rejectedInputs.add(outcome.localId);
              return true;
            },
            readDurableProviderInputAcceptanceV1: async (localId: string) => acceptedInputs.has(localId) ? 'accepted' as const
              : rejectedInputs.has(localId) ? 'not_accepted' as const : 'unknown' as const,
            dispose() {} };
        },
        listExecutionRunPendingDeliveryStatuses,
        blockExecutionRunPendingDelivery,
      }),
      machineId: 'machine-1',
      permissionHandler,
    } } : {}),
  });
  bridges.push(manager);
  const runs = (manager as unknown as { runs: Map<string, ExecutionRunState> }).runs;
  const controllers = (manager as unknown as { controllers: Map<string, unknown> }).controllers;
  return {
    manager,
    runs,
    controllers,
    listExecutionRunPendingDeliveryStatuses,
    blockExecutionRunPendingDelivery,
    enqueueAgentMessageCommitted,
    enqueueSessionUserMessageWithDisposition,
    firstEnqueuedInput,
    settlements,
    sendAcp,
    consume: (input: ExecutionRunAdmittedPendingInputV1) => consume?.(input),
  };
}

describe('retained Run provider-effect refusal', () => {
  it.each(['missing_requester', 'native_unavailable', 'native_input_too_large', 'followup_unavailable', 'async_native_refused', 'initial', 'followup', 'publication_failed', 'active_host_refused', 'active_native_refused', 'active_unknown'] as const)(
    'settles refused inputs and failed prior publication through the admitted Agent, saved SCM result and strict public consumer (%s)', async phase => {
    const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
    const sent = vi.fn<AgentSessionRuntime['send']>(async () => ({ status: 'admitted' }));
    let emit: ((event: AgentSessionRuntimeEvent) => void) | undefined;
    let nativeSessionId = '';
    const open = async (request: AgentSessionOpenRequest): Promise<AgentSessionRuntime> => ({
      watch(next) { nativeSessionId = request.sessionId; emit = next; next({ kind: 'provider-session-id', providerSessionId: 'refusal-provider-session',
        sessionId: request.sessionId, sequence: 1, emittedAtMs: 1 }); return { dispose() {} }; },
      send: sent, async dispose() {},
    });
    const plugin = definePlugin({ id: 'test.pending-refusal', version: '0.0.0', displayName: 'Refusal fixture',
      hostAccess: { required: [{ id: 'session-runtime', capability: 'sessions', reason: 'Use the current Session.',
        scope: { access: ['read', 'write', 'control'] } }], optional: [] }, entrypoints: { daemon: './daemon.mjs' },
      agents: { agent: { declaration: { title: 'Refusal Agent', runtime: { kind: 'custom' }, primary: 'sessions',
        connectedAccounts: [{ purpose: 'primary', service }], capabilities: { sessions: {
          open: ['create', 'resume'], delivery: ['newTurn', 'steer'], cancel: false, workspaceWrites: 'deny' } } },
        factory: () => ({ sessions: { open } }),
        preflightSessionControls: { probeModels: () => [{ id: 'fixture-model', name: 'Fixture model', capabilities: { structuredOutput: 'supported' } }] },
        sessionRunnerFactory: { module: './agent.mjs', export: 'createRuntime', runtimeApiVersion: 1 } } } });
    const agent = { pluginId: plugin.manifest.id, localId: 'agent' };
    const agentId = `${agent.pluginId}/${agent.localId}`;
    const credentials: Credentials = { token: randomUUID(), encryption: { type: 'legacy', secret: randomBytes(32) } };
    const api = await ApiClient.create(credentials);
    const requester = createForegroundPurposeOwnerFixture({ consumer: agent, service, accountId: 'fixture-profile',
      materializeAccount: async () => { throw new Error('This Agent declares no Account launch material'); } });
    // Only Home HTTP is substituted. Selection, purpose activation and preflight
    // materialization use the same owners as the requester-bound daemon reader.
    const accounts = QualifiedConnectedAccountListResponseV4Schema.parse({ service, accounts: [{
      ref: { service, accountId: 'fixture-profile' }, authenticationModeId: 'oauth', status: 'connected',
      revisionSemantics: 'revisioned', credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
      configurationReady: true, configurationRevision: null, scopes: [],
    }] });
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      if (new URL(String(url)).pathname === '/v4/connect/qualified/accounts') return { status: 200, data: accounts };
      throw new Error('Unexpected requester Home read');
    });
    openNativeSession = open;
    const fixture = admittedFixture ??= await createAuthoredAdmittedPluginRuntimeFixture({ happyHomeDir: directory, controller: pluginReloadController,
      plugins: [{ manifest: plugin.manifest, files: {
        'agent.mjs': `let open; export function configure(callback) { open = callback; }
          export function createRuntime() { return { sessions: { open: request => open(request) } }; }`,
        'daemon.mjs': `import * as leaf from './agent.mjs';
          export function activate(api) { api.agents.register('agent', leaf.createRuntime, {
            sessionRunnerFactory: { module: './agent.mjs', export: 'createRuntime', runtimeApiVersion: 1 },
            preflightSessionControls: { probeModels: () => [{ id: 'fixture-model', name: 'Fixture model', capabilities: { structuredOutput: 'supported' } }] } }); }
          export function configureUnitLeaf(open) { leaf.configure(open); return { activate }; }`,
      }, instantiateCommittedModule(module) {
        if (typeof module.configureUnitLeaf !== 'function') throw new Error('Missing external Agent boundary');
        const configured: unknown = module.configureUnitLeaf((request: AgentSessionOpenRequest) => openNativeSession(request));
        if (!configured || typeof configured !== 'object' || !('activate' in configured)
          || typeof configured.activate !== 'function') throw new Error('Missing external Agent activation');
        return configured as PluginDaemonModuleNamespace;
      } }] });
    let manager: ExecutionRunHostBridge | undefined;
    try {
      const engineRegistry = await resolveCliEngineRegistry({ runtimeRegistry: fixture.registry });
      const profileCatalog = await engineRegistry.resolveExecutionRunProfileCatalog({ resolveAgentIdentity: () => agent });
      const sourceCustody = fixture.registry.readPluginSourceCustody?.(agent.pluginId);
      if (!sourceCustody) throw new Error('Missing admitted Agent source');
      materialize.mockImplementation(async (request: { runId: string; connectedServices: unknown }) => ({ ok: true, result: {
        activationId: '11111111-1111-4111-8111-111111111111', env: {}, connectedServicesBindings: request.connectedServices,
        registration: { v: 1, activationId: '11111111-1111-4111-8111-111111111111', runKey: request.runId, agentId,
          agentContribution: { ...agent, sourceCustody }, materializationKey: request.runId,
          connectedServicesBindings: request.connectedServices, connectedServiceSelectionsEnv: {}, sessionDirectory: directory, materializedRoot: null },
      } }));
      sent.mockClear();
      sent.mockImplementation(async () => ({ status: 'admitted' }));
      let current = true;
      const generationSignals: (AbortSignal | undefined)[] = [];
      const readNativeOfferedModel: NonNullable<Parameters<ExecutionRunHostBridge['start']>[0]['readNativeOfferedModel']>
        = request => withAgentPreflightCatalog({ agentId }, context => readNativeExecutionRunOfferedModel({
          ...request, ...context, ...(phase === 'missing_requester' ? {} : { promptCredentials: credentials }), accountSettings: {},
          preflightDependencies: { createApiClient: async () => api,
            activatePurposeBindings: requester.owner.activatePurposeBindings, connectedAccountsOwner: requester.owner },
        }));
      const harness = createHarness(false, async ({ signal }) => {
        generationSignals.push(signal);
        if (!current) throw new Error('Generation transport unavailable');
        return { current: true };
      }, { engineRegistry, profileCatalog, readNativeOfferedModel });
      manager = harness.manager;
      const comparison = await captureScmComparison({ cwd: directory, source: { kind: 'workingTree' }, sessionId: 'session-1' });
      if (phase === 'missing_requester') {
        // Missing requester credentials must fail closed before any native send.
        const response = await withAgentPreflightCatalog({ agentId }, context => invokeCliPreflightMethod(agentId, 'probeModels', {
          backendTarget: { kind: 'builtInAgent', agentId }, cwd: directory,
          connectedServices: { v: 2, bindingsByServiceId: { [`${service.pluginId}/${service.localId}`]: {
            source: 'connected', selection: 'profile', profileId: 'fixture-profile' } } },
        }, { agentCatalogEntry: context.catalogEntry, agentRegistrySnapshot: context.registrySnapshot,
          createAgentInvocationServices: context.createAgentInvocationServices, isAgentRegistryCurrent: context.isCurrent,
          createApiClient: async () => api, activatePurposeBindings: requester.owner.activatePurposeBindings,
          connectedAccountsOwner: requester.owner,
        }, {}));
        expect(response).toMatchObject({ ok: false, error: { code: 'connected-service-preflight-failed' } });
      }
      const start = harness.manager.start({ sessionId: 'session-1', cwd: directory, intent: 'scm_diff_summary',
        backendTarget: { kind: 'builtInAgent', agentId }, initialInput: { kind: 'deferred_session_pending' },
        modelId: 'fixture-model',
        permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming',
        connectedServices: { v: 2, bindingsByServiceId: { [`${service.pluginId}/${service.localId}`]: {
          source: 'connected', selection: 'profile', profileId: 'fixture-profile' } } },
        intentInput: { cwd: directory, source: comparison.comparison.source, comparisonId: comparison.comparison.id, outputs: ['commitPlan'] } });
      if (phase === 'missing_requester') {
        await expect(start).rejects.toMatchObject({ code: 'model_catalog_unavailable',
          details: { executionRunStart: { runCreation: 'noRunCreated' } } });
        expect(sent).not.toHaveBeenCalled();
        return;
      }
      const started = await start;
      while (harness.manager.getPublic(started.runId)?.status === 'running'
        && !harness.manager.getPublic(started.runId)?.interaction) {
        await harness.manager.waitForRunStateChange(started.runId);
      }
      const provisioned = harness.manager.getPublic(started.runId);
      expect(provisioned, JSON.stringify(provisioned)).toMatchObject({ status: 'running',
        interaction: { kind: 'retained_agent_session.v1' } });
      const runtimeSignal = (harness.controllers.get(started.runId) as ExecutionRunBackendController).backend.getRuntimeLifetimeSignal();
      const resultId = (harness.runs.get(started.runId)!.intentInput as { resultId: string }).resultId;
      const scope = { cwd: directory, sessionId: 'session-1', resultId };
      const input = (localId: string): ExecutionRunAdmittedPendingInputV1 => ({ role: 'user', content: { type: 'text', text: 'Generate the plan.' },
        localId, authorAccountId: 'account-1', inputAdmissionReceipt: null, pendingProviderAction: 'send' });
      const priorPlan = { groups: [{ id: 'preserved', message: 'fix: retained output', rationale: 'Already analysed.', changeRefs: [] }], leftOutChangeRefs: [] };
      const hasPriorOutput = phase !== 'initial' && phase !== 'native_unavailable' && phase !== 'native_input_too_large' && phase !== 'async_native_refused';
      if (hasPriorOutput) {
        expect(harness.consume(input(`initial:${started.runId}`))).toBe(true);
        await vi.waitFor(() => expect(sent).toHaveBeenCalledOnce());
        const request = sent.mock.calls[0]![0];
        if (request.delivery.kind !== 'newTurn') throw new Error('Expected native turn');
        let observePublicationFailure!: () => void;
        const publicationFailed = new Promise<void>(resolve => { observePublicationFailure = resolve; });
        if (phase === 'publication_failed') harness.sendAcp.mockImplementation(async (_provider, body, opts) => {
          if (body.type === 'message' && opts?.meta?.happier) {
            observePublicationFailure();
            throw createExecutionRunTranscriptCustodyError();
          }
        });
        emit!({ kind: 'input-accepted', sessionId: nativeSessionId, sequence: 2, emittedAtMs: 2, inputIds: request.inputIds, delivery: request.delivery });
        emit!({ kind: 'turn-start', sessionId: nativeSessionId, sequence: 3, emittedAtMs: 3, turnId: request.delivery.turnId, startedBy: 'host' });
        if (phase.startsWith('active_')) {
          if (phase === 'active_host_refused') current = false;
          if (phase === 'active_native_refused') sent.mockImplementation(async () => ({ status: 'rejected', retryable: true,
            diagnostic: { code: 'native_steer_refused', severity: 'error' } }));
          if (phase === 'active_unknown') sent.mockImplementation(async () => { throw new Error('Native steer response lost'); });
          expect(harness.consume({ ...input('active-steer'), pendingProviderAction: 'steer' })).toBe(true);
          if (phase === 'active_host_refused') {
            await vi.waitFor(() => expect(harness.settlements).toContainEqual(expect.objectContaining({
              kind: 'rejected_before_effect', localId: 'active-steer' })));
            expect(sent).toHaveBeenCalledOnce();
          } else {
            await vi.waitFor(() => expect(sent).toHaveBeenCalledTimes(2));
            if (phase === 'active_native_refused') await vi.waitFor(() => expect(harness.settlements).toContainEqual(expect.objectContaining({
              kind: 'rejected_before_effect', localId: 'active-steer' })));
          }
          const controller = harness.controllers.get(started.runId) as ExecutionRunBackendController;
          expect(controller.turnInFlight).toBe(true);
          expect(harness.manager.getPublic(started.runId)).toMatchObject({ status: 'running' });
          emit!({ kind: 'message-delta', sessionId: nativeSessionId, sequence: 4, emittedAtMs: 4, turnId: request.delivery.turnId,
            channel: 'assistant', text: JSON.stringify({ commitPlan: priorPlan }) });
          if (phase === 'active_unknown') {
            // The actual native dispatch installed an unresolved custody fence.
            const uncertain = controller.pendingInputAcceptance!;
            let settled = false;
            void uncertain.then(() => { settled = true; });
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(settled).toBe(false);
            expect(controller.buffer).toBe('');
            const steered = sent.mock.calls[1]![0];
            emit!({ kind: 'input-accepted', sessionId: nativeSessionId, sequence: 5, emittedAtMs: 5,
              inputIds: steered.inputIds, delivery: steered.delivery });
          }
          emit!({ kind: 'turn-complete', sessionId: nativeSessionId, sequence: 6, emittedAtMs: 6, turnId: request.delivery.turnId });
          await vi.waitFor(async () => expect(await scmDiffSummaryResultStore.read(scope), phase).toMatchObject({ success: true,
            result: { output: { outputs: { commitPlan: { state: 'complete', value: priorPlan } } } } }));
          await harness.manager.dispose();
          return;
        }
        emit!({ kind: 'message-delta', sessionId: nativeSessionId, sequence: 4, emittedAtMs: 4, turnId: request.delivery.turnId,
          channel: 'assistant', text: JSON.stringify({ commitPlan: priorPlan }) });
        emit!({ kind: 'turn-complete', sessionId: nativeSessionId, sequence: 5, emittedAtMs: 5, turnId: request.delivery.turnId });
        if (phase === 'publication_failed') {
          await publicationFailed;
          const controller = harness.controllers.get(started.runId) as ExecutionRunBackendController;
          await expect(controller.pendingHostBarrier).rejects.toMatchObject({ code: 'execution_run_transcript_custody_unavailable' });
          harness.sendAcp.mockImplementation(async () => undefined);
        }
        await vi.waitFor(async () => expect(await scmDiffSummaryResultStore.read(scope)).toMatchObject({ success: true,
          result: { output: { outputs: { commitPlan: { state: 'complete', value: priorPlan } } } } }));
        const saved = await scmDiffSummaryResultStore.read(scope);
        if (!saved.success) throw new Error(saved.error);
        await scmDiffSummaryResultStore.publishProgress({ ...scope, expectedRevision: saved.result.revision,
          output: { ...saved.result.output, outputs: { commitPlan: { state: 'partial', value: priorPlan } } } });
      }
      const nativeUnavailable = phase === 'native_unavailable' || phase === 'followup_unavailable';
      const sizeRefusal = phase === 'native_input_too_large';
      const nativeRefusal = nativeUnavailable || sizeRefusal || phase === 'async_native_refused';
      current = nativeRefusal;
      if (nativeUnavailable) sent.mockImplementation(async () => ({ status: 'unavailable', retryable: true,
        diagnostic: { code: 'native_terminal_host_unavailable', severity: 'error', message: 'Terminal host unavailable' } }));
      if (sizeRefusal) sent.mockImplementation(async () => ({ status: 'rejected', retryable: false,
        diagnostic: { code: 'provider_input_too_large', severity: 'error', message: 'Input exceeds native character limit' } }));
      const failureCode = sizeRefusal ? 'provider_input_too_large'
        : nativeRefusal ? 'native_terminal_host_unavailable' : 'execution_run_connected_service_generation_refresh_required';
      const refusedInputId = !hasPriorOutput ? `initial:${started.runId}` : 'followup-refused';
      if (phase === 'async_native_refused') {
        // Direct Run send has a completion waiter but no claimed Pending row.
        // Its dispatch ACK can precede a correlated native rejection.
        expect(await harness.manager.send(started.runId, { message: 'Generate the plan.', localInputId: refusedInputId }))
          .toMatchObject({ ok: true });
        await vi.waitFor(() => expect(sent).toHaveBeenCalledOnce());
        const controller = harness.controllers.get(started.runId) as ExecutionRunBackendController;
        await vi.waitFor(() => expect(controller.turnInFlight).toBe(true));
        const request = sent.mock.calls[0]![0];
        emit!({ kind: 'input-rejected', sessionId: nativeSessionId, sequence: 2, emittedAtMs: 2,
          inputIds: request.inputIds, diagnostic: { code: failureCode, severity: 'error', message: 'Terminal host unavailable' }, retryable: true });
      } else {
        expect(harness.consume(input(refusedInputId))).toBe(true);
      }
      if (phase !== 'async_native_refused') await vi.waitFor(() => expect(harness.settlements).toContainEqual(expect.objectContaining({
        kind: 'rejected_before_effect', localId: refusedInputId, diagnostic: { code: failureCode,
          message: expect.any(String), severity: 'error' }, retryable: !sizeRefusal,
      })));
      await vi.waitFor(() => expect(harness.manager.get(started.runId)).toMatchObject({ status: 'failed',
        error: { code: phase === 'publication_failed' ? 'execution_run_transcript_custody_unavailable'
          : failureCode } }));
      await harness.manager.waitForTerminal(started.runId);
      expect(generationSignals.length).toBeGreaterThan(0);
      expect(generationSignals.every(signal => signal === runtimeSignal)).toBe(true);
      const rpc = createExecutionRunRpcActionDeps({ manager: harness.manager, context: { sessionId: 'session-1', cwd: directory },
        isExecutionRunsEnabled: () => true, policy: { maxConcurrentRuns: null, boundedTimeoutMs: null,
          reviewBoundedTimeoutMs: null, maxTurns: null, allowIoModes: new Set(['streaming', 'request_response']) } });
      expect(ExecutionRunGetResponseSchema.parse(await rpc.executionRunGet!('session-1', { runId: started.runId, includeStructured: true })))
        .toMatchObject({ run: { status: 'failed', lifecycle: { state: 'recoverable' } }, structuredMeta: { kind: 'scm_diff_summary.v1',
          payload: { outputs: { commitPlan: { state: hasPriorOutput ? 'partial' : 'failed',
            ...(sizeRefusal ? { reason: 'Input exceeds native character limit', reasonCode: 'provider_input_too_large' } : {}), ...(hasPriorOutput ? { value: priorPlan } : {}) } } } } });
      expect(await scmDiffSummaryResultStore.read(scope)).toMatchObject({ success: true,
        result: { output: { outputs: { commitPlan: { state: hasPriorOutput ? 'partial' : 'failed',
          ...(sizeRefusal ? { reason: 'Input exceeds native character limit', reasonCode: 'provider_input_too_large' } : {}), ...(hasPriorOutput ? { value: priorPlan } : {}) } } } } });
      const sentBeforeRetry = (hasPriorOutput ? 1 : 0) + (nativeRefusal ? 1 : 0);
      expect(sent).toHaveBeenCalledTimes(sentBeforeRetry);
      current = true;
      sent.mockImplementation(async () => ({ status: 'admitted' }));
      expect(await harness.manager.ensure(started.runId, { resume: true })).toMatchObject({ ok: true });
      expect(harness.manager.getPublic(started.runId)).toMatchObject({ status: 'running', lifecycle: { state: 'current' } });
      expect(harness.consume(input('explicit-retry'))).toBe(true);
      await vi.waitFor(() => expect(sent).toHaveBeenCalledTimes(sentBeforeRetry + 1));
      const retried = sent.mock.calls.at(-1)![0];
      if (retried.delivery.kind !== 'newTurn') throw new Error('Expected an explicit recovery turn');
      emit!({ kind: 'input-accepted', sessionId: nativeSessionId, sequence: 6, emittedAtMs: 6,
        inputIds: retried.inputIds, delivery: retried.delivery });
      emit!({ kind: 'turn-start', sessionId: nativeSessionId, sequence: 7, emittedAtMs: 7, turnId: retried.delivery.turnId, startedBy: 'host' });
      emit!({ kind: 'message-delta', sessionId: nativeSessionId, sequence: 8, emittedAtMs: 8, turnId: retried.delivery.turnId,
        channel: 'assistant', text: JSON.stringify({ commitPlan: priorPlan }) });
      emit!({ kind: 'turn-complete', sessionId: nativeSessionId, sequence: 9, emittedAtMs: 9, turnId: retried.delivery.turnId });
      await vi.waitFor(async () => expect(await scmDiffSummaryResultStore.read(scope)).toMatchObject({ success: true,
        result: { output: { outputs: { commitPlan: { state: 'complete', value: priorPlan } } } } }));
      await harness.manager.dispose();
    } finally { await manager?.dispose(); }
  });
});
