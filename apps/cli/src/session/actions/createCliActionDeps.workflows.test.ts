import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import Fastify from 'fastify';
import { registerPlainArtifactRoutes } from './widgetApproval.testkit';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import tweetnacl from 'tweetnacl';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, createActionExecutor, encodePlainArtifactStoredContent, ExecutionRunGetResponseSchema, materializeWorkflowAcceptedSnapshotV1, sealWorkflowAcceptedSnapshotStoredEnvelopeV1, sealWorkflowCheckpointStoredEnvelopeV1, sealWorkflowProgressStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1, validateWorkflowDefinition, WorkflowActionFailureV1Schema, WorkflowRunRecipientCensusResponseV1Schema, WorkflowRunSummaryV1Schema, type ActionId } from '@happier-dev/protocol';
import { EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER,
  verifyExternalActionMachineRequestV1, type ActionExecutorContext } from '@happier-dev/protocol';
import { PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1, PluginInstallationManifestPublisherHeaderV1Schema,
  createPluginInstallationManifestPublisherSigningInputV1, stringifyPluginInstallationManifestCanonicalJsonV1 } from '@happier-dev/protocol/plugins/installations/manifests';
import { createMachineInstallationIdentityFixture } from '../../../../../packages/tests/src/testkit/machineIdentity';
import * as installation from '@/daemon/identity/currentMachineInstallation';
import { createSessionAccountActionExecutor } from '@/mcp/runtime/createSessionAccountActionExecutor';
import { createDaemonSessionAccountActionExecutor } from '@/daemon/agentRuntime/createDaemonSessionAccountActionExecutor';
import { configuration } from '@/configuration';
import { hashProcessCommand } from '@/daemon/sessionRegistry';
import { hashPrivateBearer } from '@/daemon/privateBearerFile';
import { createAgentSessionRunnerFactoryBinding } from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
import { createAgentRuntimeDaemonServiceAuthorityPath, publishAgentRuntimeDaemonServiceAuthority,
  removeAgentRuntimeDaemonServiceAuthorityIfOwned } from '@/daemon/agentRuntime/sessionBridgeAuthorization';
import { AgentRuntimeDaemonServiceRequestV1Schema, AgentRuntimeDaemonServiceResponseV1Schema } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import { WorkflowActionInputSchemasV1, WorkflowActionOutputSchemasV1 } from '@happier-dev/protocol/workflows/actionsV1';
import { AccountSettingsSchema } from '@happier-dev/protocol/account/settings/accountSettings';
import { PROMPT_LIBRARY_ROWS_ROUTE_V1, PromptLibraryRecordV1Schema, PromptLibraryRowsListResponseV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { getActiveAccountSettingsSnapshot, readAccountRoleOverridesFromSnapshot, resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createInvocationSavedSecretOperationContextV1 } from "@/settings/secrets/savedSecretOperationContext";
import { emptyPromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { PromptLibraryCatalogKeyV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { prepareExternalActionRequesterAccountAuthorization } from '@/api/externalActionExecutionAuthorization';
import { ExternalActionExecutionAuthorizationRequestV1Schema, computeExternalActionRequestEnvelopeDigestV1, type ExternalActionTargetV1 } from '@happier-dev/protocol/actions';
import { openWorkflowAcceptedSnapshotStoredEnvelopeV1, parseWorkflowStoredContentEnvelopeV1 } from '@happier-dev/protocol/workflows/workflowStoredContentV1';
import { WorkflowAcceptedSnapshotV1Schema } from '@happier-dev/protocol/workflows/workflowDefinitionV1';
import { AutomationDefinitionCreateRequestSchema, AutomationDefinitionDetailSchema } from '@happier-dev/protocol/automations/automationApiV3';

const processIdentity = vi.hoisted(() => vi.fn());
// The runner's OS process identity and daemon HTTP are external boundaries.
vi.mock('@/daemon/processIdentity', () => ({ readProcessIdentityByPid: processIdentity }));

const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(), request: vi.fn() }));
const signedRootAction = vi.hoisted(() => vi.fn());
const machineRpc = vi.hoisted(() => vi.fn());
const sessionRpc = vi.hoisted(() => vi.fn());
// Session RPC is the network boundary; keep execution-run service decoding real.
vi.mock('@/session/transport/rpc/sessionRpc', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/session/transport/rpc/sessionRpc')>(), callSessionRpc: sessionRpc,
}));

// Native machine RPC is an authenticated transport boundary; Workflow policy stays real.
vi.mock('@/session/transport/rpc/machineRpc', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/session/transport/rpc/machineRpc')>(),
  callMachineRpc: machineRpc,
  callExactMachineRpc: machineRpc,
}));

vi.mock('axios', () => ({
  default: { get: http.get, post: http.post, put: http.put, delete: http.delete, request: http.request, isAxiosError: (value: unknown) => Boolean(value && typeof value === 'object' && 'response' in value) },
}));

// The daemon control client is an authenticated HTTP boundary. Keep its
// request schema and surrounding client logic real; observe only dispatch.
vi.mock('@/daemon/controlClient', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/daemon/controlClient')>(),
  requestDaemonSignedRootActionExecution: signedRootAction,
}));

import { createCliActionDeps } from './createCliActionDeps';
import { createCliActionExecutorFromCredentials } from './createCliActionExecutorFromCredentials';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { logger } from '@/ui/logger';
import { createDeferred } from '@/testkit/async/deferred';
import { SessionTurnsProjectionV1Schema } from '@happier-dev/protocol/sessions/turns/sessionTurnV1';
import { DEFAULT_SESSION_AUTO_FOLLOW_PREFERENCES_V1, DEFAULT_SESSION_FOLLOW_CREATION_POLICIES_V1 } from '@happier-dev/protocol/sessions/follow/accountFollow';
import { createWorkflowCoordinator, type WorkflowStepExecutor } from '@/daemon/workflows/coordinator';
import { createInMemoryWorkflowCoordinatorStore } from '@/daemon/workflows/workflowCoordinator.testkit';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); resetActiveAccountSettingsSnapshotForTests(); });
afterAll(async () => {
  if (pluginReloadController.getState().activeRegistry) await pluginReloadController.shutdown();
});

const workflowAccountPersonToken = `fixture.${Buffer.from(JSON.stringify({ sub: 'account-1', tokenEpoch: 0,
  provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;

describe('createCliActionDeps workflow boundary', () => {

  it.each(['plain', 'unknown'] as const)('keeps an admitted approval mode %s when Home mode changes before the Artifact write', async admittedAccountEncryptionMode => {
    const credentials = { token: workflowAccountPersonToken, encryption: null, credentialProvenance: 'stored_session' as const };
    const modeReads: string[] = [];
    http.get.mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/encryption')) { modeReads.push(url); return { status: 200, data: { mode: 'e2ee', updatedAt: 2 } }; }
      if (new URL(url).pathname.startsWith('/v1/artifacts/')) return { status: 404, data: { error: 'artifact_not_found' } };
      throw new Error(`Unexpected admitted approval read ${url}`);
    });
    const writes: unknown[] = [];
    http.post.mockImplementation(async (url: string, input: Record<string, unknown>) => {
      if (new URL(url).pathname !== '/v1/artifacts') throw new Error(`Unexpected admitted approval write ${url}`);
      writes.push(input);
      return { status: 400, data: { error: 'artifact_account_mode_mismatch' } };
    });
    const params = { token: credentials.token, credentials, sessionId: 'cli-global', mode: 'plain' as const, ctx: null,
      admittedAccountEncryptionMode };
    const deps = createCliActionDeps(params);
    await expect(deps.approvalsCreate!({ request: { v: 1, actionId: 'session.message.send', status: 'open',
      summary: 'Approve a message', createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'cli', sessionId: 's1' }, actionArgs: { sessionId: 's1', message: 'hello' } }, serverId: null }))
      .rejects.toMatchObject({ code: admittedAccountEncryptionMode === 'plain'
        ? 'artifact_account_mode_mismatch' : 'account_encryption_mode_unavailable' });
    expect(modeReads).toEqual([]);
    expect(writes).toEqual(admittedAccountEncryptionMode === 'plain'
      ? [expect.objectContaining({ dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER })] : []);
  });

  it('refuses a missing daemon runtime before Workflow materialization or storage', async () => {
    expect(pluginReloadController.getState().activeRegistry).toBeNull();
    const token = `e30.${Buffer.from(JSON.stringify({ sub: 'account-1' })).toString('base64url')}.signature`;
    const deps = createCliActionDeps({ token, credentials: { token, encryption: null,
      credentialProvenance: 'stored_session' }, sessionId: 'cli-global', mode: 'plain', ctx: null,
      resolveServerFeaturesSnapshot: () => enabledFeatures });
    const beforeHttp = http.get.mock.calls.length + http.post.mock.calls.length + machineRpc.mock.calls.length;
    const result = await createActionExecutor(deps).execute('workflow.run.start', {
      runId: '77777777-7777-4777-8777-777777777778',
      source: { kind: 'catalog', workflow: 'builtin:fresh-opinions' },
      inputs: { question: 'Review this', participants: [
        { kind: 'session', session: { serverId: 'home', sessionId: 'a' } },
        { kind: 'session', session: { serverId: 'home', sessionId: 'b' } },
      ] },
    }, { surface: 'cli', authority: 'present_user', externalActionTarget: { kind: 'machine', machineId: 'machine-1',
      project: { machineId: 'machine-1', directory: tmpdir() } } });
    expect(WorkflowActionFailureV1Schema.parse(result)).toMatchObject({ ok: false,
      errorCode: 'target_unavailable', details: { code: 'target_unavailable',
        reason: 'requester_runtime_unavailable', errorCode: 'PLUGIN_DAEMON_RUNTIME_UNAVAILABLE' } });
    expect(http.get.mock.calls.length + http.post.mock.calls.length + machineRpc.mock.calls.length).toBe(beforeHttp);
  });

  it.each([401, 403, 400])('keeps permanent feature HTTP %s refusal out of storage retry', async httpStatus => {
    const token = `e30.${Buffer.from(JSON.stringify({ sub: 'account-1' })).toString('base64url')}.signature`;
    const deps = createCliActionDeps({ token, credentials: { token, encryption: null,
      credentialProvenance: 'stored_session' }, sessionId: 'cli-global', mode: 'plain', ctx: null,
      resolveServerFeaturesSnapshot: async () => ({ status: 'error', reason: 'response_status', httpStatus }) });
    const result = await createActionExecutor(deps).execute('workflow.run.get', {
      runId: '77777777-7777-4777-8777-777777777778',
    }, { surface: 'cli' });
    expect(WorkflowActionFailureV1Schema.parse(result)).toMatchObject({ ok: false, errorCode: 'content_unavailable' });
  });
  it.each(['timeout', 'missing'] as const)('keeps a %s feature observation out of the content-unavailable arm', async reason => {
    const token = `e30.${Buffer.from(JSON.stringify({ sub: 'account-1' })).toString('base64url')}.signature`;
    const deps = createCliActionDeps({ token, credentials: { token, encryption: null,
      credentialProvenance: 'stored_session' }, sessionId: 'cli-global', mode: 'plain', ctx: null,
      resolveServerFeaturesSnapshot: async () => reason === 'missing' ? undefined : ({ status: 'error', reason }) });
    const result = await createActionExecutor(deps).execute('workflow.run.start', {
      runId: '77777777-7777-4777-8777-777777777778',
      source: { kind: 'inline', definition: { version: 1, inputs: [], defaults: {}, blocks: [
        { kind: 'wait', id: 'wait', document: { text: 'Continue', references: [], attachments: [] } },
      ] } },
    }, { surface: 'cli', externalActionTarget: { kind: 'machine', machineId: 'machine-1',
      project: { machineId: 'machine-1', directory: tmpdir() } } });
    expect(WorkflowActionFailureV1Schema.parse(result)).toMatchObject({ ok: false, errorCode: 'storage_unavailable' });
  });
  it.each([
    { surface: 'ui', authority: 'present_user', originless: false },
    { surface: 'cli', authority: 'account_automation', originless: false },
    { surface: 'voice', authority: 'account_automation', originless: false },
    { surface: 'cli', authority: 'account_automation', originless: true },
  ] as const)('freezes completion and origin selection for a $surface Panel (originless: $originless)', async ({ surface, authority, originless }) => {
    const lease = await pluginReloadController.acquireRuntimeRegistry({
      resolveRuntimeRegistry: () => resolveExecutablePluginRuntimeRegistry({ contributes: createResolvedContributionRegistry({}) }),
    });
    await lease.release();
    const token = `e30.${Buffer.from(JSON.stringify({ sub: 'account-1' })).toString('base64url')}.signature`;
    const credentials = { token, encryption: null, credentialProvenance: 'stored_session' as const };
    const sessionId = 'c123456789012345678901234';
    const connectedServices = { v: 2 as const, bindingsByServiceId: {
      'happier.agent.codex/openai-codex': { source: 'connected' as const, selection: 'profile' as const, profileId: 'origin-account' },
    } };
    const baseGet = http.get.getMockImplementation()!;
    http.get.mockImplementation(async (url: string) => {
      if (url.endsWith('/v2/account/settings')) return { status: 200, data: { version: 1, content: { t: 'plain', v: {} } } };
      if (url.endsWith('/v2/account/settings/history')) return { status: 200, data: { snapshots: [] } };
      if (url.includes('/v1/artifacts?')) return { status: 200, data: [] };
      if (url.endsWith(PROMPT_LIBRARY_ROWS_ROUTE_V1)) return { status: 200, data: PromptLibraryRowsListResponseV1Schema.parse({
        status: 'listed', rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({ key, revision: 1,
          content: { t: 'plain', v: emptyPromptLibraryRecordV1(key) } })),
      }) };
      if (url.endsWith(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session: createSessionRecordFixture({
        id: sessionId, active: true, encryptionMode: 'plain', metadata: JSON.stringify({ machineId: 'machine-1', path: tmpdir(),
          flavor: 'codex', modelOverrideV1: { v: 1, modelId: 'parent-model', updatedAt: 1 }, connectedServices }),
      }) } };
      return baseGet(url);
    });
    const deps = createCliActionDeps({ token, credentials, serverId: 'profile', serverHttpBaseUrl: 'https://panel-origin.test',
      serverIdentityId: 'srv_panel_home', resolveServerFeaturesSnapshot: () => enabledFeatures as never,
      sessionId: 'cli-global', mode: 'plain', ctx: null,
      machineActionDirectTargetTransport: { machineId: 'machine-1', invoke: async method => {
        if (method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) return {
          protocolVersion: 1, projection: { v: 2, generation: 1, agentsById: { codex: {
            id: 'codex', identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
            capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
          }, opencode: {
            id: 'opencode', identity: { pluginId: 'happier.agent.opencode', localId: 'opencode' },
            capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
          } } },
        };
        if (method === RPC_METHODS.CAPABILITIES_DETECT) return { protocolVersion: 1, results: {
          'cli.codex': { ok: true, data: { installed: true, version: '1', latestVersion: null,
            update: { supported: false, command: null }, signIn: { status: 'signedOut', loginSupport: 'unsupported' },
            platform: { supported: true }, install: { available: false, mode: 'none', sizeBytes: null, guideUrl: null }, dependencies: [] } },
          'cli.opencode': { ok: true, data: { installed: true, version: '1', latestVersion: null,
            update: { supported: false, command: null }, signIn: { status: 'signedOut', loginSupport: 'unsupported' },
            platform: { supported: true }, install: { available: false, mode: 'none', sizeBytes: null, guideUrl: null }, dependencies: [] } },
          'tool.executionRuns': { ok: true, data: { available: true, features: { detachedScope: true },
            backends: { codex: { available: true }, opencode: { available: true } } } },
        } };
        throw new Error(`Unexpected Panel Machine RPC ${method}`);
      } },
    });
    const executor = createActionExecutor(deps);
    signedRootAction.mockImplementation(async request => executor.execute(request.actionId, request.input, { surface: 'cli' }));
    const engines = ['agent:happier.agent.codex/codex', 'agent:happier.agent.opencode/opencode'];
    const plannerTargets = [
      { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
      { kind: 'agent', identity: { pluginId: 'happier.agent.opencode', localId: 'opencode' } },
    ];
    const previousRoundContext = { document: 'Previous round evidence' };
    const result = await executor.execute('workflow.run.start', {
      runId: '77777777-7777-4777-8777-777777777778', source: { kind: 'catalog', workflow: 'builtin:plan-with-a-panel' },
      inputs: { request: 'Plan the change', engines, previousRoundContext },
      roleOverrides: originless ? [{ roleId: 'planner', engine: { agentTargetKey: 'agent:happier.agent.opencode/opencode' } }] : [],
    }, { surface, authority, serverId: 'profile', ...(originless ? {} : { defaultSessionId: sessionId }),
      externalActionTarget: { kind: 'machine', machineId: 'machine-1', project: { machineId: 'machine-1', directory: tmpdir() } } });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { admission: 'created' } });
    const admission = http.post.mock.calls.find(([, body]) => body.operation === 'admit')?.[1];
    expect(admission).toBeDefined();
    const accepted = openWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId: admission.runId },
      envelope: parseWorkflowStoredContentEnvelopeV1(admission.acceptedEnvelope),
    });
    expect(accepted.kind).toBe('available');
    if (accepted.kind !== 'available') throw new Error('accepted_snapshot_unavailable');
    const planner = accepted.content.materializedLeaves.find(leaf => leaf.blockId === 'plan');
    expect(planner).toMatchObject({ kind: 'step', executionTarget: { kind: 'detached_run' },
      engineBindings: { reference: { kind: 'item', field: 'value' }, selections: plannerTargets.map(agentTarget => ({
        value: { agentTarget }, executionTarget: { kind: 'detached_run' }, selection: {
          agentTarget, permissionMode: 'read-only',
        },
      })) } });
    const synthesis = accepted.content.materializedLeaves.find(leaf => leaf.blockId === 'synthesis');
    expect(synthesis?.kind).toBe('step');
    if (synthesis?.kind !== 'step') throw new Error('synthesis_step_unavailable');
    // The origin has Connected authentication but no Launch Profile. Its frozen
    // selection must survive strict stored-envelope serialization with that field absent.
    if (!originless) {
      expect(planner?.selection).not.toHaveProperty('profileId');
      expect(synthesis.selection).not.toHaveProperty('profileId');
    }
    if (!originless) expect(synthesis.selection).toMatchObject({
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
      modelSelection: { ref: { modelId: 'parent-model' } }, connectedServices,
    });
    if (!originless) return;
    expect(accepted.content.origin).toEqual({ kind: 'direct', actionPolicy: { surface, authority } });
    expect(synthesis.selection).toMatchObject({
      agentTarget: plannerTargets[1],
      permissionMode: 'read-only',
    });
    // Native start/terminal observation and Agent execution are process boundaries.
    // CLI admission, discovery, materialization, completion and input binding stay real.
    const store = createInMemoryWorkflowCoordinatorStore();
    const terminals = engines.map(() => createDeferred<void>());
    const plannerSteps: Parameters<WorkflowStepExecutor>[0][] = [];
    const synthesisSteps: Parameters<WorkflowStepExecutor>[0][] = [];
    const coordinator = createWorkflowCoordinator({ store,
      isAcceptedAuthorizationCurrent: async () => true,
      resolveWorkspace: async () => ({ ok: true, workspace: accepted.content.workspaceTarget.project }),
      executeStep: async step => {
        if (step.step.id === 'synthesis') {
          synthesisSteps.push(step);
          return { kind: 'completed', result: { document: 'Synthesized terminal evidence' }, resultEncoding: 'typed' };
        }
        if (step.step.id !== 'plan') throw new Error(`Unexpected Panel step ${step.step.id}`);
        plannerSteps.push(step);
        const index = step.item!.index;
        await terminals[index]!.promise;
        return index === 0 ? { kind: 'failed', code: 'native_plan_failed' }
          : { kind: 'completed', result: 'terminal plan' };
      },
    });
    const running = coordinator.run({ ...accepted.content, runId: admission.runId });
    try {
      await vi.waitFor(() => expect(plannerSteps).toHaveLength(2));
      expect(plannerSteps.map(step => ({ engine: step.item?.value, target: step.execution.agentTarget,
        executionTarget: step.executionTarget, permissionMode: step.execution.permissionMode, values: step.input.values })))
        .toEqual(expect.arrayContaining(engines.map((engine, index) => ({ engine, target: plannerTargets[index],
          executionTarget: { kind: 'detached_run' }, permissionMode: 'read-only', values: ['Plan the change', previousRoundContext] }))));
      expect(synthesisSteps).toEqual([]);
      terminals[0]!.resolve();
      await vi.waitFor(() => expect(store.list().find(row => row.blockId === 'plan' && row.lifecycle === 'failed'))
        .toMatchObject({ reason: 'native_plan_failed' }));
      // One terminal failure cannot release synthesis while its peer is still observing.
      expect(synthesisSteps).toEqual([]);
    } finally { terminals.forEach(terminal => terminal.resolve()); await running; }
    expect(await running).toMatchObject({ state: 'waiting_for_review' });
    expect(synthesisSteps).toHaveLength(1);
    expect(synthesisSteps[0]!.execution).toMatchObject(synthesis.selection);
    expect(synthesisSteps[0]!.input.values).toEqual(['Plan the change', previousRoundContext, [
      { index: 0, status: 'failed', reason: 'native_plan_failed' },
      { index: 1, status: 'completed', results: { plan: 'terminal plan' } },
    ]]);
    expect(store.list().filter(row => row.blockId === 'plan')).toEqual(expect.arrayContaining([
      expect.objectContaining({ lifecycle: 'failed', reason: 'native_plan_failed' }),
      expect.objectContaining({ lifecycle: 'completed', result: 'terminal plan' }),
    ]));
    expect(store.list().find(row => row.blockId === 'synthesis')).toMatchObject({ lifecycle: 'waiting_for_review',
      result: { document: 'Synthesized terminal evidence' }, resultContract: { kind: 'json' } });
  });
  it.each([
    { pendingMaintenance: false, discussionOrigin: false },
    { pendingMaintenance: true, discussionOrigin: false },
    { pendingMaintenance: false, discussionOrigin: true },
  ])('keeps fresh Workflow materialization in the admitted Account holder (maintenance pending: $pendingMaintenance, Discussion: $discussionOrigin)', async ({ pendingMaintenance, discussionOrigin }) => {
    // Real daemon publication with no SCM plugin: a plain directory is valid.
    const lease = await pluginReloadController.acquireRuntimeRegistry({
      resolveRuntimeRegistry: () => resolveExecutablePluginRuntimeRegistry({ contributes: createResolvedContributionRegistry({}) }),
    });
    await lease.release();
    const token = `e30.${Buffer.from(JSON.stringify({ sub: 'account-1' })).toString('base64url')}.signature`;
    const credentials = { token, encryption: null, credentialProvenance: 'stored_session' as const };
    const rawSettings = { workDepthLimit: 2 };
    const source = { source: 'network' as const, scopeKey: resolveAccountSettingsScopeKeyForToken(token),
      settings: AccountSettingsSchema.parse(rawSettings), rawSettings, settingsVersion: 1, settingsSecretsReadKeys: [], loadedAtMs: 1 };
    // Account currentness and HTTP are external boundaries. The captured holder,
    // factory, catalog hydration and fresh materializer remain real.
    const operationContext = createInvocationSavedSecretOperationContextV1({ credentials, snapshot: source,
      serverHttpBaseUrl: 'https://workflow-custody.example.invalid', isCurrent: async () => true });
    setActiveAccountSettingsSnapshot({ ...source, scopeKey: 'other-account' });
    const ambient = getActiveAccountSettingsSnapshot();
    const maintenance = createDeferred<void>();
    const maintenanceIssued = createDeferred<void>();
    let destinationsObserved = false;
    const post = http.post.getMockImplementation()!;
    http.post.mockImplementation(async (url: string, body: Readonly<Record<string, unknown>>) =>
      url.endsWith('/v2/sessions/lookup-by-tags')
        ? { status: 200, data: { sessions: [] } } : post(url, body));
    const get = http.get.getMockImplementation()!;
    http.get.mockImplementation(async (url: string) => {
      const path = new URL(url).pathname;
      if (path === '/v2/sessions' || path === '/v2/sessions/archived') {
        return { status: 200, data: { sessions: [], nextCursor: null, hasNext: false } };
      }
      if (url.endsWith('/v2/account/settings')) {
        if (destinationsObserved) {
          maintenanceIssued.resolve();
          if (pendingMaintenance) await maintenance.promise;
        }
        return { status: 200, data: { version: 1, content: { t: 'plain', v: rawSettings } } };
      }
      if (url.includes('/v1/artifacts?')) return { status: 200, data: [] };
      if (url.endsWith(PROMPT_LIBRARY_ROWS_ROUTE_V1)) {
        destinationsObserved = true;
        return { status: 200, data: PromptLibraryRowsListResponseV1Schema.parse({
          status: 'listed', rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({ key, revision: 1, content: { t: 'plain', v:
            key === 'role-overrides' ? { key, value: { v: 1, overrides: { scout: { roleId: 'scout',
              instructionsOverride: 'Use the admitted Workflow Account.' } } } } : emptyPromptLibraryRecordV1(key) } })),
        }) };
      }
      return get(url);
    });
    if (discussionOrigin) {
      // Real Discussion metadata/key/message codecs; only Home HTTP is supplied.
      http.request.mockImplementation(async (request: { url: string }) => {
        const content = { t: 'plain', v: { v: 1, parts: [{ t: 'text', text: 'Review this answer' }] } };
        const message = { id: 'question-1', discussionId: 'discussion-1', localId: 'question-local', seq: 2,
          authorAccountId: 'account-1', accountActor: { v: 1, accountId: 'account-1', profile: null },
          producerV1: null, content, mentionedAccountIds: [], createdAt: 1 };
        if (new URL(request.url).pathname === '/v1/discussions/discussion-1') return { status: 200, data: { discussion: {
          id: 'discussion-1', ownerAccountId: 'account-1', encryptionMode: 'plain', anchor: null,
          access: 'owner', keyReadiness: true, dataEncryptionKey: null, creationLocalId: 'create-local',
          titleContent: { t: 'plain', v: { v: 1, title: 'Review' } }, latestMessage: {
            id: message.id, localId: message.localId, seq: message.seq, authorAccountId: message.authorAccountId,
            accountActor: message.accountActor, producerV1: message.producerV1, createdAt: message.createdAt,
          },
          messageSeq: 2, lastReadSeq: 0, unreadCount: 1, unreadMentionCount: 0, recentAuthorAccountIds: ['account-1'],
          archivedAt: null, capabilities: { postMessages: true, rename: true, archive: true, restore: false,
            askAgent: true, sendToSession: true, manageAccess: true, leave: false },
        } } };
        if (new URL(request.url).pathname === '/v1/discussions/discussion-1/messages') return { status: 200,
          data: { messages: [message], hasMoreOlder: false, messageSeq: 2 } };
        throw new Error('unexpected_discussion_http');
      });
    }
    const features = discussionOrigin ? { ...enabledFeatures, features: FeaturesResponseSchema.parse({
      ...enabledFeatures.features, features: { ...enabledFeatures.features.features,
        sessions: { enabled: true, conversations: { enabled: true } }, sharing: { enabled: true, session: { enabled: true } } },
    }) } : enabledFeatures;
    const deps = createCliActionDeps({ token, credentials, savedSecretOperationContext: operationContext,
      serverId: 'profile', serverHttpBaseUrl: operationContext.serverHttpBaseUrl, resolveServerFeaturesSnapshot: () => features as never,
      ...(discussionOrigin ? { serverIdentityId: 'srv_fresh_home' } : {}),
      sessionId: 'cli-global', mode: 'plain', ctx: null });
    let admissionCompleted = false;
    const admission = deps.workflowAction!({ actionId: 'workflow.run.start', input: {
      runId: '77777777-7777-4777-8777-777777777777', source: { kind: 'inline', definition: { version: 1,
        defaults: { engine: { role: 'scout' } }, roles: [{ roleId: 'scout', runsAs: { kind: 'session' },
          engine: { agentTargetKey: 'agent:happier.agent.codex/codex' } }],
        blocks: [{ kind: 'wait', id: 'review', document: { text: 'Review', references: [], attachments: [] } }] } },
      ...(discussionOrigin ? { origin: { kind: 'discussion' as const,
        discussion: { serverId: 'srv_fresh_home', discussionId: 'discussion-1' }, addressingMessageId: 'question-1' },
        onComplete: { kind: 'originating_discussion' as const } } : {}),
    }, context: { serverId: 'profile', surface: 'ui', authority: 'present_user', callerPermissionMode: 'default', externalActionTarget: { kind: 'machine', machineId: 'machine-1',
      project: { machineId: 'machine-1', directory: tmpdir() } } } })
      .then(result => { admissionCompleted = true; return result; });
    try {
      if (pendingMaintenance) {
        await maintenanceIssued.promise;
        await vi.waitFor(() => expect(admissionCompleted).toBe(true));
      }
      expect(await admission, JSON.stringify({ result: await admission, requests: http.request.mock.calls.map(([request]) =>
        ({ method: request.method, path: new URL(request.url).pathname })),
        gets: http.get.mock.calls.map(([url]) => url) })).toMatchObject({ admission: 'created' });
    } finally { maintenance.resolve(); await admission; }
    expect(getActiveAccountSettingsSnapshot()).toBe(ambient);
    const captured = operationContext.readSnapshot();
    expect(captured).not.toBeNull();
    if (!captured) throw new Error('Workflow holder retired');
    expect(readAccountRoleOverridesFromSnapshot(captured)).toMatchObject({ status: 'ready', overrides: {
      scout: { roleId: 'scout', instructionsOverride: 'Use the admitted Workflow Account.' },
    } });
    const admitted = http.post.mock.calls.find(([, body]) => body.operation === 'admit')?.[1];
    expect(admitted).toBeDefined();
    const accepted = openWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId: admitted.runId },
      envelope: parseWorkflowStoredContentEnvelopeV1(admitted.acceptedEnvelope),
    });
    expect(accepted.kind).toBe('available');
    if (accepted.kind !== 'available') throw new Error('accepted_snapshot_unavailable');
    expect(accepted.content.materializedLeaves).toMatchObject([{ role: { roleId: 'scout',
      instructions: 'Use the admitted Workflow Account.', engine: { agentTargetKey: 'agent:happier.agent.codex/codex' } } }]);
    // An originless Account start has no bound Session. Resolving cli-global
    // as a tag scans the Account's Session history and cannot supply defaults.
    expect(http.post.mock.calls.filter(([url]) => String(url).includes('/v2/sessions/'))).toEqual([]);
    expect(http.get.mock.calls.filter(([url]) => String(url).includes('/v2/sessions'))).toEqual([]);
    WorkflowActionOutputSchemasV1['workflow.run.start'].parse(await admission);
    if (discussionOrigin) {
      expect(admitted).toMatchObject({ origin: { kind: 'direct', discussion: {
        discussion: { serverId: 'srv_fresh_home', discussionId: 'discussion-1' }, messageId: 'question-1', throughSeq: 2,
      } } });
    }
  });
  it.each([true, false])('requires readable Account role overrides only when Start consumes a Role (consumed: %s)', async (consumed) => {
    const lease = await pluginReloadController.acquireRuntimeRegistry({
      resolveRuntimeRegistry: () => resolveExecutablePluginRuntimeRegistry({ contributes: createResolvedContributionRegistry({}) }),
    });
    await lease.release();
    const diagnostic = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
    const get = http.get.getMockImplementation()!;
    let catalogRead = false;
    http.get.mockImplementation(async (url: string) => {
      if (url.endsWith('/v2/account/settings')) return { status: 200, data: { version: 1, content: { t: 'plain', v: {} } } };
      if (url.includes('/v1/artifacts?')) return { status: 200, data: [] };
      if (url.endsWith(PROMPT_LIBRARY_ROWS_ROUTE_V1)) {
        catalogRead = true;
        return { status: 200, data: PromptLibraryRowsListResponseV1Schema.parse({ status: 'unavailable', reason: 'invalid-stored-content' }) };
      }
      return get(url);
    });
    const deps = createCliActionDeps({ token: 'token', credentials: { token: 'token', encryption: null },
      resolveServerFeaturesSnapshot: () => enabledFeatures as never, sessionId: 'cli-global', mode: 'plain', ctx: null });
    const actions = createActionExecutor({ ...deps, isActionApprovalRequired: () => false });
    const result = await actions.execute('workflow.run.start', {
      runId: '11111111-1111-4111-8111-111111111111', source: { kind: 'inline', definition: {
        version: 1, defaults: consumed ? { engine: { role: 'scout' } } : {},
        ...(consumed ? { roles: [{ roleId: 'scout', runsAs: { kind: 'session' },
          engine: { agentTargetKey: 'agent:happier.agent.codex/codex' } }] } : {}), blocks: [{ kind: 'wait', id: 'wait',
          document: { text: 'Continue', references: [], attachments: [] } }],
      } },
    }, { surface: 'ui', authority: 'present_user', externalActionTarget: { kind: 'machine', machineId: 'machine-1',
      project: { machineId: 'machine-1', directory: tmpdir() } } });
    expect(catalogRead, JSON.stringify(result)).toBe(consumed);
    if (!consumed) {
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { admission: 'created' } });
      expect(http.post.mock.calls.some(([, body]) => body.operation === 'admit')).toBe(true);
      expect(diagnostic.mock.calls.some(([message]) => String(message).includes('workflow_action_failure'))).toBe(false);
      return;
    }
    expect(WorkflowActionFailureV1Schema.parse(result)).toMatchObject({ ok: false, errorCode: 'content_unavailable',
      details: { reason: 'account_role_overrides_unavailable' } });
    expect(http.post.mock.calls.some(([, body]) => body.operation === 'admit')).toBe(false);
    const events = diagnostic.mock.calls.flatMap(([message]) => {
      try { const parsed: unknown = JSON.parse(message); return parsed && typeof parsed === 'object'
        && 'event' in parsed && parsed.event === 'workflow_action_failure' ? [parsed] : []; }
      catch { return []; }
    });
    expect(events).toEqual([{ event: 'workflow_action_failure', errorCode: 'content_unavailable',
      originalCode: 'account_role_overrides_unavailable', httpStatus: null, operation: 'workflow.run.start', durationMs: expect.any(Number) }]);
  });

  it('retains the original storage cause in one content-free daemon diagnostic', async () => {
    const diagnostic = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
    http.post.mockRejectedValue(Object.assign(new Error('private SQL, token and prompt'), {
      code: 'ERR_BAD_RESPONSE', response: { status: 503, data: { error: 'private database body' } },
      config: { headers: { Authorization: 'private-token' } },
    }));
    const deps = createCliActionDeps({ token: 'token', credentials: { token: 'token', encryption: null },
      resolveServerFeaturesSnapshot: () => enabledFeatures as never, sessionId: 'cli-global', mode: 'plain', ctx: null });
    const result = await deps.workflowAction!({ actionId: 'workflow.run.cancel',
      input: { runId: '11111111-1111-4111-8111-111111111111', expectedRevision: 0 }, context: { surface: 'cli' } });
    expect(result).toMatchObject({ ok: false, errorCode: 'storage_unavailable' });
    const events = diagnostic.mock.calls.flatMap(([message]) => {
      try { const parsed = JSON.parse(message); return parsed.event === 'workflow_action_failure' ? [parsed] : []; }
      catch { return []; }
    });
    expect(events).toEqual([{ event: 'workflow_action_failure', errorCode: 'storage_unavailable',
      originalCode: 'ERR_BAD_RESPONSE', httpStatus: 503, operation: 'cancel', durationMs: expect.any(Number) }]);
    expect(events[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(events)).not.toMatch(/private/);
  });
  const enabledFeatures = {
    status: 'ready' as const,
    provenance: 'authenticated' as const,
    features: FeaturesResponseSchema.parse({
      features: { automations: { enabled: true }, workflows: { enabled: true } },
      capabilities: {},
    }),
  };
  beforeEach(() => {
    machineRpc.mockReset();
    sessionRpc.mockReset();
    http.request.mockReset();
    http.put.mockReset();
    http.delete.mockReset();
    signedRootAction.mockReset().mockResolvedValue({ ok: true, result: {} });
    http.get.mockReset().mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'account-1' } };
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null,
        updatedAt: 1, recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' },
      } };
      throw new Error(`unexpected_get:${url}`);
    });
    http.post.mockReset().mockImplementation(async (_url: string, body: Readonly<Record<string, unknown>>) => {
      if (body.operation === 'get') throw Object.assign(new Error('not found'), { response: { status: 404 } });
      if (body.operation === 'admit') return { data: { kind: 'created', run: { sourceArtifactId: null, ownerAccountId: 'account-1', visibleTeamId: null,
        id: body.runId, origin: { kind: 'direct', originSessionId: 'session-1' }, state: 'queued', revision: 0,
        machineId: 'machine-1', workflowCustodyState: 'pending', originDeliveryAckRevision: null,
        availability: { pause: true, resumeBoundary: false,
           restoreWorkspace: false, cancel: true, inspectExecution: false, disabledReasons: [] },
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      } } };
      throw new Error(`unexpected_post:${String(body.operation)}`);
    });
  });

  it.each(['machine', 'exact'] as const)('lists a retained Run through Project-scoped CLI Action wiring (%s selection)', async selection => {
    const runId = '11111111-1111-4111-8111-111111111111';
    const project = { machineId: 'machine-1', directory: '/repo' };
    const accepted = await materializeWorkflowAcceptedSnapshotV1({ definition: { version: 1, defaults: {},
      blocks: [{ kind: 'wait', id: 'review', document: { text: 'Review', references: [], attachments: [] } }] },
      context: { source: { kind: 'inline' }, inputs: {}, machineId: project.machineId, executionTarget: { kind: 'session' },
        workspaceTarget: { project: { ...project, checkoutRootPath: project.directory } },
        origin: { kind: 'direct' }, authorization: { principal: { kind: 'host' } } },
      admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true } });
    if (!accepted.ok) throw new Error(`snapshot_fixture_failed:${accepted.error.code}`);
    const snapshot = {
      run: WorkflowRunSummaryV1Schema.parse({ sourceArtifactId: null, ownerAccountId: 'account-1', visibleTeamId: null,
        id: runId, origin: { kind: 'direct' }, state: 'queued', revision: 0, machineId: project.machineId,
        workflowCustodyState: 'pending', originDeliveryAckRevision: null,
        availability: { pause: true, resumeBoundary: false, restoreWorkspace: false, cancel: true, inspectExecution: false, disabledReasons: [] },
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }),
      acceptedEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
        mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId }, acceptedSnapshot: accepted.snapshot })),
      checkpointEnvelope: null, resultEnvelope: null,
      keyCensus: WorkflowRunRecipientCensusResponseV1Schema.parse({ runId, ownerAccountId: 'account-1', visibleTeamId: null,
        encryptionMode: 'plain', access: 'owner', ownerAccountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null },
        dataEncryptionKey: null, callerDataEncryptionKey: null, recipients: [] }),
    };
    const requests: unknown[] = [];
    http.post.mockImplementation(async (_url: string, body: Readonly<Record<string, unknown>>) => {
      if (body.operation === 'get') return { data: snapshot };
      if (body.operation === 'invocations.list') return { data: { invocations: [] } };
      if (body.operation !== 'list') throw new Error(`unexpected:${String(body.operation)}`);
      requests.push(body.request);
      return { data: { runs: [snapshot.run], acceptedEnvelopesByRunId: { [runId]: snapshot.acceptedEnvelope },
        keyCensusByRunId: { [runId]: snapshot.keyCensus } } };
    });
    const deps = createCliActionDeps({ token: 'token', credentials: { token: 'token', encryption: null },
      resolveServerFeaturesSnapshot: () => enabledFeatures as never, sessionId: 'cli-global', mode: 'plain', ctx: null });
    const actions = createActionExecutor({ ...deps, isActionApprovalRequired: () => false });
    const context = { surface: 'cli' as const, authority: 'present_user' as const,
      externalActionTarget: { kind: 'machine' as const, machineId: project.machineId, project } };
    await expect(actions.execute('workflow.run.get', { runId }, context))
      .resolves.toMatchObject({ ok: true, result: { run: { id: runId } } });
    const input = selection === 'machine' ? { machineId: project.machineId } : { runIds: [runId] };
    const listed = await actions.execute('workflow.run.list', input, context);
    expect(listed).toMatchObject({ ok: true, result: { runs: [{ id: runId, where: project }] } });
    if (!listed.ok) throw new Error(listed.errorCode);
    WorkflowActionOutputSchemasV1['workflow.run.list'].parse(listed.result);
    expect(requests).toEqual([{ ...input, machineId: project.machineId }]);
    if (selection === 'machine') {
      const get = http.get.getMockImplementation()!;
      http.get.mockImplementation(async (url: string) => {
        if (url.endsWith('/v1/account/encryption/currentness')) {
          throw Object.assign(new Error('request timed out'), { code: 'ECONNABORTED' });
        }
        return get(url);
      });
      await expect(actions.execute('workflow.run.get', { runId }, context))
        .resolves.toMatchObject({ ok: false, errorCode: 'storage_unavailable' });
    }
  });

  it.each(['session', 'detached', 'wrong_run', 'invalid_response', 'transport_failure', 'wrong_machine'] as const)(
    'arms an exact-output trigger through production Run observation (%s)', async (scenario) => {
    const sessionId = 'c' + '2'.repeat(24);
    const runId = 'run-observed';
    const baseGet = http.get.getMockImplementation()!;
    http.get.mockImplementation(async (url: string) => {
      if (url.includes(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session: createSessionRecordFixture({
        id: sessionId, active: true, encryptionMode: 'plain', metadata: JSON.stringify({ machineId: 'machine-1', path: '/repo' }),
      }) } };
      if (url.includes('/v3/automations?')) return { status: 200, data: { automations: [], nextCursor: null } };
      return baseGet(url);
    });
    const runResponse = ExecutionRunGetResponseSchema.parse({ run: {
      runId: scenario === 'wrong_run' ? 'another-run' : runId, callId: 'call', sidechainId: 'sidechain', intent: 'scm_diff_summary',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, permissionMode: 'no_tools', retentionPolicy: 'resumable',
      runClass: 'long_lived', ioMode: 'streaming', status: 'running', startedAtMs: 1,
      lifecycle: { v: 1, state: 'current' },
    } });
    const observe = async () => {
      if (scenario === 'transport_failure') return { ok: false, errorCode: 'execution_run_target_unavailable' };
      return scenario === 'invalid_response' ? { run: {} } : runResponse;
    };
    sessionRpc.mockImplementation(observe);
    machineRpc.mockImplementation(observe);
    http.request.mockImplementation(async ({ data }: { data: unknown }) => {
      const input = AutomationDefinitionCreateRequestSchema.parse(data);
      return { status: 200, data: AutomationDefinitionDetailSchema.parse({
        id: input.automationId, name: input.name, description: input.description ?? null, enabled: input.enabled,
        targetType: null, existingSessionId: null, templateVersion: 1, lastRunAt: null, createdAt: 1, updatedAt: 1,
        workflowDefinitionId: null, scopeSessionId: null, executionRecipe: input.executionRecipe,
        assignments: input.assignments?.map(assignment => ({ ...assignment, enabled: assignment.enabled ?? true,
          priority: assignment.priority ?? 0, updatedAt: 1 })) ?? [],
        triggers: input.triggers.map(item => ({ ...item.trigger, id: item.triggerId, revision: 0,
          createdAt: 1, updatedAt: 1, remainingOccurrences: 1, status: { state: 'waiting', runId: null }, triggerDefinitionEnvelope: null })),
      }) };
    });
    const deps = createCliActionDeps({ token: 'token', credentials: { token: 'token', encryption: null },
      resolveServerFeaturesSnapshot: () => enabledFeatures as never, sessionId: 'cli-global', mode: 'plain', ctx: null });
    const actions = createActionExecutor({ ...deps, isActionApprovalRequired: () => false });
    const result = await actions.execute('workflow.trigger.add', {
      project: { machineId: 'machine-1', directory: '/repo' },
      target: { kind: 'inline', definition: { version: 1, blocks: [{ kind: 'action', id: 'notify', actionId: 'notifications.notify_me',
        input: { message: { kind: 'literal', value: 'Walkthrough complete' } } }] } },
      trigger: { kind: 'runLifecycle', enabled: true, condition: 'terminal', source: { kind: 'execution_run',
        machineId: scenario === 'wrong_machine' ? 'foreign-machine' : 'machine-1', runId,
        ...(scenario === 'detached' ? {} : { sessionId }), observation: { kind: 'scm_diff_summary', comparisonId: 'comparison',
          resultId: 'result', output: 'walkthrough', afterRevision: 0 } } },
    }, { surface: 'ui', authority: 'present_user' });
    if (scenario === 'session' || scenario === 'detached') {
      expect(result).toMatchObject({ ok: true, result: { set: { health: 'available', triggers: [{ kind: 'runLifecycle',
        source: { runId, observation: { output: 'walkthrough', resultId: 'result' } } }] } } });
      expect(http.request).toHaveBeenCalled();
    } else {
      expect(result).toMatchObject({ ok: false, errorCode: 'source_unavailable' });
      expect(http.request).not.toHaveBeenCalled();
    }
  });

  it.each([
    { hasSigner: true, viaSession: false, machineRouted: false, freshWait: false, unavailableWorkspace: false },
    { hasSigner: false, viaSession: false, machineRouted: false, freshWait: false, unavailableWorkspace: false },
    { hasSigner: true, viaSession: true, machineRouted: false, freshWait: false, unavailableWorkspace: false },
    { hasSigner: true, viaSession: true, machineRouted: true, freshWait: false, unavailableWorkspace: false },
    { hasSigner: true, viaSession: true, machineRouted: true, freshWait: true, unavailableWorkspace: false, credentialedFactory: true },
    { hasSigner: true, viaSession: true, machineRouted: true, freshWait: true, unavailableWorkspace: true, credentialedFactory: true },
    { hasSigner: true, viaSession: true, machineRouted: true, freshWait: true, unavailableWorkspace: false, credentialedFactory: true, missingBackend: true },
    { hasSigner: true, viaSession: true, machineRouted: true, freshWait: true, unavailableWorkspace: false, credentialedFactory: true, nullCallerPermission: true },
  ])('starts or rejoins a Session Workflow with its exact installed signer ($hasSigner, Session channel: $viaSession, Machine routed: $machineRouted, fresh Wait: $freshWait, unavailable workspace: $unavailableWorkspace, missing backend: $missingBackend, null caller permission: $nullCallerPermission)', async ({ hasSigner, viaSession, machineRouted, freshWait, unavailableWorkspace, credentialedFactory, missingBackend, nullCallerPermission }) => {
    const sessionId = 'c' + '1'.repeat(24);
    const runId = '11111111-1111-4111-8111-111111111111';
    const directory = unavailableWorkspace ? '/missing-workflow-start-diag-workspace' : freshWait ? tmpdir() : '/repo';
    const diagnostic = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
    if (freshWait && !unavailableWorkspace) {
      // Real daemon publication with no SCM plugin: a plain directory is valid.
      const lease = await pluginReloadController.acquireRuntimeRegistry({
        resolveRuntimeRegistry: () => resolveExecutablePluginRuntimeRegistry({ contributes: createResolvedContributionRegistry({}) }),
      });
      await lease.release();
    }
    const identity = createMachineInstallationIdentityFixture();
    vi.spyOn(installation, 'readCurrentMachineInstallation').mockResolvedValue({ machineId: 'machine-1', identity: {
      version: 1, installationId: identity.installationId, createdAt: 0,
      publicKey: identity.publicKeyBase64, privateKey: identity.privateKeyBase64,
    } });
    const credentials = { token: viaSession
      ? `fixture.${Buffer.from(JSON.stringify({ sub: 'account-1', tokenEpoch: 0,
        provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`
      : 'restricted-session-token', encryption: null };
    let target: ExternalActionTargetV1 = { kind: 'machine' as const, machineId: 'machine-1',
      ...(machineRouted ? {} : { project: { machineId: 'machine-1', directory: '/repo' } }) };
    // The Home-minted authorization is an external boundary fact; signing and
    // verifying every actual storage request stays with the canonical owners.
    let currentAuthorization: NonNullable<ActionExecutorContext['externalActionExecutionAuthorization']> = {
      v: 1, token: 'home-execution-proof', binding: {
        serverIdentityId: 'home', accountId: 'account-1', custodianAccountId: 'account-1',
        authentication: { kind: 'account', tokenEpoch: 0 }, installationId: identity.installationId,
        machineId: 'machine-1', actionId: 'workflow.run.start', requestId: 'request-1',
        requestEnvelopeDigest: 'd'.repeat(43), target,
        sessionActionOrigin: { v: 1, caller: { kind: 'session', sessionId, starterDepth: 0, turnDepth: 0 },
          sourceTurnId: 'turn-1', callerPermissionMode: 'default', causalPermissionAuthority: null, requestId: 'request-1' },
        sessionActionSource: { machineId: 'machine-1', installationId: identity.installationId },
      },
    };
    const context: ActionExecutorContext = {
      surface: 'agent', authority: 'account_automation', defaultSessionId: sessionId,
      actionCaller: { kind: 'session', sessionId, starterDepth: 0, turnDepth: 0 },
      callerPermissionMode: 'default', externalActionTarget: target,
      get externalActionExecutionAuthorization() { return currentAuthorization; },
    };
    const definition = validateWorkflowDefinition({ version: 1,
      defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
      blocks: freshWait ? [{ kind: 'wait', id: 'review', document: { text: 'Review', references: [], attachments: [] } }] : ['work'],
    }).normalizedDefinition!;
    const origin = { kind: 'direct' as const, originSessionId: sessionId };
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId },
      acceptedSnapshot: { definition, authoredDefinition: definition, startedBy: 'agent', workDepth: 1,
        metadata: null, frozenChildren: {}, materializedLeaves: [], source: { kind: 'inline' }, inputs: {},
        machineId: 'machine-1', executionTarget: { kind: 'session' }, workspaceTarget: { project: {
          machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo',
        } }, origin, resultDelivery: { kind: 'originating_session', originSessionId: sessionId },
        authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'session', sessionId } },
      },
    }));
    const keyCensus = WorkflowRunRecipientCensusResponseV1Schema.parse({ runId, ownerAccountId: 'account-1', encryptionMode: 'plain',
      access: 'owner', dataEncryptionKey: null, callerDataEncryptionKey: null, recipients: [], visibleTeamId: null,
      ownerAccountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null },
    });
    const authenticatedReads: string[] = [];
    const get = http.get.getMockImplementation()!;
    http.get.mockImplementation(async (url: string, options: { headers: Record<string, string> }) => {
      if (url.endsWith('/v2/account/session-follow-preferences')) {
        // Fresh Session-channel admission already opens the exact requester's
        // Account custody. A Run does not grant a restricted Session this read.
        expect(url).toBe('https://session-home.test/v2/account/session-follow-preferences');
        expect(options.headers.Authorization).toBe(`Bearer ${credentials.token}`);
        expect(options.headers[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]).toBeUndefined();
        return { status: 200, data: { ...DEFAULT_SESSION_AUTO_FOLLOW_PREFERENCES_V1,
          ...DEFAULT_SESSION_FOLLOW_CREATION_POLICIES_V1, runReportPolicy: { preset: 'quiet' } } };
      }
      if (viaSession && url.includes('/v1/artifacts?')) {
        const artifacts = Fastify();
        registerPlainArtifactRoutes(artifacts, 'account-1');
        try {
          const requestUrl = new URL(url);
          const response = await artifacts.inject({ method: 'GET', url: requestUrl.pathname + requestUrl.search });
          return { status: response.statusCode, data: response.json() };
        } finally { await artifacts.close(); }
      }
      if (url.includes(`/v2/sessions/${sessionId}`)) return { status: 200,
        data: { session: createSessionRecordFixture({ id: sessionId, share: null, encryptionMode: 'plain',
          metadata: JSON.stringify({ path: directory, machineId: 'machine-1', ...(missingBackend ? {} : { flavor: 'claude' }) }) }) } };
      if (url.endsWith('/v1/account/encryption/currentness')) {
        expect(url).toBe('https://session-home.test/v1/account/encryption/currentness');
        const authorization = context.externalActionExecutionAuthorization!;
        if (viaSession && !options.headers[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]) return await get(url);
        if (options.headers[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER] !== authorization.token
          || !verifyExternalActionMachineRequestV1({ authorizationToken: authorization.token, effectActionId: 'workflow.run.start',
            target, installationId: identity.installationId, requestId: authorization.binding.requestId,
            method: 'GET', path: '/v1/account/encryption/currentness', publicKey: identity.publicKeyBase64,
            signature: options.headers[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER] ?? '',
          })) throw Object.assign(new Error('restricted_account_currentness'), { response: { status: 401, data: null } });
        expect(options.headers.Authorization).toBeUndefined();
      }
      return await get(url);
    });
    http.post.mockImplementation(async (url: string, body: Record<string, unknown>, options: { headers: Record<string, string> }) => {
      if (machineRouted && url.endsWith('/execution-authorization')) {
        const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
        if (!request.envelope.target) throw new Error('Missing Workflow authorization target');
        currentAuthorization = { v: 1, token: 'home-execution-proof', binding: {
          ...context.externalActionExecutionAuthorization!.binding, target: request.envelope.target,
          accountEncryptionMode: 'plain', sessionActionOrigin: request.sessionActionOrigin,
          requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
        } };
        return { status: 200, data: context.externalActionExecutionAuthorization };
      }
      if (machineRouted && url.endsWith('/execution-authorization/verify')) {
        const authorization = context.externalActionExecutionAuthorization!;
        const path = new URL(url).pathname;
        expect(body).toEqual({ v: 1 });
        expect(options.headers.Authorization).toBeUndefined();
        expect(verifyExternalActionMachineRequestV1({ authorizationToken: authorization.token,
          effectActionId: 'workflow.run.start', target, installationId: identity.installationId,
          requestId: authorization.binding.requestId, method: 'POST', path, body,
          publicKey: identity.publicKeyBase64,
          signature: options.headers[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER] ?? '' })).toBe(true);
        return { status: 200, data: { ok: true } };
      }
      const headers = options.headers;
      const authorization = context.externalActionExecutionAuthorization!;
      const path = '/v3/automations/runs/workflow-storage';
      expect(url).toBe(`https://session-home.test${path}`);
      // Same admission boundary as registerWorkflowRunStorageRoutes: a
      // restricted Session token alone cannot read Account workflow storage.
      if (headers[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER] !== authorization.token
        || body.publisherMachineId !== 'machine-1'
        || !headers[PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]
        || !verifyExternalActionMachineRequestV1({ authorizationToken: authorization.token, effectActionId: 'workflow.run.start',
          target, installationId: identity.installationId, requestId: authorization.binding.requestId,
          method: 'POST', path, body, publicKey: identity.publicKeyBase64,
          signature: headers[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER] ?? '',
        })) throw Object.assign(new Error('restricted_account_read'), { response: { status: 401, data: null } });
      expect(headers.Authorization).toBeUndefined();
      // Check the real Protocol proof at the HTTP boundary; the Server's
      // integration test independently owns persisted publisher admission.
      const { proof } = PluginInstallationManifestPublisherHeaderV1Schema.parse(JSON.parse(Buffer.from(
        headers[PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]!, 'base64url').toString('utf8')));
      expect(proof).toMatchObject({ machineId: 'machine-1', installationId: identity.installationId, method: 'POST', path,
        bodySha256Base64Url: createHash('sha256').update(stringifyPluginInstallationManifestCanonicalJsonV1(body)).digest('base64url') });
      const { signatureBase64Url, ...unsigned } = proof;
      expect(tweetnacl.sign.detached.verify(createPluginInstallationManifestPublisherSigningInputV1({ proof: unsigned }),
        Buffer.from(signatureBase64Url, 'base64url'), Buffer.from(identity.publicKeyBase64, 'base64url'))).toBe(true);
      authenticatedReads.push(String(body.operation));
      if (body.operation === 'run-key.census') return { data: keyCensus };
      if (freshWait && body.operation === 'get') throw Object.assign(new Error('not found'), { response: { status: 404 } });
      if (freshWait && body.operation === 'admit') {
        // Read real producer bytes through the coordinator's stored reader,
        // then validate the accepted value against the canonical strict schema.
        const accepted = openWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
          binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId },
          envelope: parseWorkflowStoredContentEnvelopeV1(body.acceptedEnvelope) });
        expect(accepted).toMatchObject({ kind: 'available', content: { startedBy: 'agent', workDepth: 1,
          workspaceTarget: { project: { machineId: 'machine-1', directory } },
          materializedLeaves: [{ kind: 'wait', blockId: 'review' }],
          resultDelivery: { reportPolicy: { preset: 'quiet' } },
        } });
        if (accepted.kind !== 'available') throw new Error('accepted_snapshot_unavailable');
        WorkflowAcceptedSnapshotV1Schema.parse(accepted.content);
        return { data: { kind: 'created', run: { sourceArtifactId: null, ownerAccountId: 'account-1', visibleTeamId: null,
          id: runId, origin, state: 'queued', revision: 0, machineId: 'machine-1', workflowCustodyState: 'pending',
          originDeliveryAckRevision: null,
          availability: { pause: true, resumeBoundary: false, restoreWorkspace: false, cancel: true, inspectExecution: false, disabledReasons: [] },
          createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' } } };
      }
      if (body.operation === 'get') return { data: { acceptedEnvelope, checkpointEnvelope: null, resultEnvelope: null, keyCensus,
        run: { sourceArtifactId: null, ownerAccountId: 'account-1', visibleTeamId: null, id: runId, origin, state: 'queued', revision: 0,
          machineId: 'machine-1', workflowCustodyState: 'pending', originDeliveryAckRevision: null,
          availability: { pause: true, resumeBoundary: false, restoreWorkspace: false, cancel: true, inspectExecution: false, disabledReasons: [] },
          createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
      } };
      throw new Error(`unexpected_effect:${String(body.operation)}`);
    });
    if (viaSession) setActiveAccountSettingsSnapshot({ source: 'network', settings: AccountSettingsSchema.parse({}),
      rawSettings: {}, settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [],
      scopeKey: runWithServerHttpBaseUrl('https://session-home.test', () => resolveAccountSettingsScopeKeyForToken(credentials.token)),
      promptLibraryCatalog: { status: 'ready', rows: [{ revision: 1,
        record: PromptLibraryRecordV1Schema.parse({ key: 'role-overrides', value: { v: 1, overrides: {} } }) }],
        tombstones: [], diagnostics: [] },
    });
    const deps = createCliActionDeps({ token: credentials.token, credentials,
      serverId: 'profile', serverIdentityId: 'home', serverHttpBaseUrl: 'https://session-home.test',
      sessionId: machineRouted ? 'cli-global' : sessionId,
      ...(machineRouted ? {} : { rawSession: { path: '/repo', machineId: 'machine-1' } }),
      getCurrentSessionBackendTarget: () => ({ kind: 'backend', backendId: 'claude', sourceKind: 'built_in' }),
      resolveServerFeaturesSnapshot: () => enabledFeatures as never, mode: 'plain', ctx: null,
      ...(hasSigner ? { externalActionMachineRequestPrivateKey: identity.privateKeyBase64,
        externalActionMachineInstallationId: identity.installationId } : {}),
    });
    const input = WorkflowActionInputSchemasV1['workflow.run.start'].parse({
      runId, source: { kind: 'inline', definition }, executionTarget: { kind: 'session' }, onComplete: { kind: 'originating_session' },
    });
    const result = await (async () => {
      if (!viaSession) return await deps.workflowAction!({ actionId: 'workflow.run.start', input, context });
      const command = 'node /runtime/.runner-snapshots/workflow-start/dist/index.mjs';
      const runner = { pid: process.pid, processStartTimeMs: 23_346,
        processCommandHash: hashProcessCommand(command), snapshotIdentity: 'snapshot:workflow-start' };
      processIdentity.mockResolvedValue({ pid: process.pid, processStartTimeMs: runner.processStartTimeMs, command });
      const path = await createAgentRuntimeDaemonServiceAuthorityPath(configuration);
      const authority = { happyHomeDir: configuration.happyHomeDir, publicReleaseRing: configuration.publicReleaseRing,
        path, sessionId, runner,
        retainedAgent: createAgentSessionRunnerFactoryBinding({ v: 1, pluginId: 'acme.plugin', pluginVersion: '1.2.3',
          agentId: 'acme-agent', localAgentId: 'acme-agent', sourceCustody: { kind: 'managed',
            immutableGenerationId: `sha256:${'1'.repeat(64)}`, installSource: 'localPath' },
          locator: { module: './runtime.mjs', export: 'createRuntime', runtimeApiVersion: 1 },
          normalizedModulePath: '/immutable/acme/runtime.mjs', loadMode: 'immutable-js' }) };
      const capability = 'A'.repeat(43);
      await publishAgentRuntimeDaemonServiceAuthority({ ...authority, httpPort: 31_001, capability });
      vi.stubEnv('HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE', path);
      const daemon = createDaemonSessionAccountActionExecutor({ serverId: 'profile', serverHttpBaseUrl: 'https://session-home.test',
        token: credentials.token, credentials, machineId: 'machine-1',
        prepareExternalActionAuthorization: async ({ sessionActionOrigin, operation, workflowTarget, isCallerCurrent }) => {
          if (machineRouted) {
            // Mirror startup's canonical Machine fallback. Omitting workspace
            // wiring must reach the real Workflow owner, not a fixture refusal.
            target = workflowTarget ?? { kind: 'machine', machineId: 'machine-1' };
            const authorization = await prepareExternalActionRequesterAccountAuthorization({ actionId: operation.actionId,
              input: operation.input, requestId: operation.requestId, target, machineId: 'machine-1', sourceMachineId: 'machine-1',
              accountId: 'account-1', accountEncryptionMode: 'plain', tokenEpochHint: 0, token: credentials.token,
              serverId: 'profile', serverIdentityId: 'home', serverHttpBaseUrl: 'https://session-home.test',
              installationId: identity.installationId, privateKey: identity.privateKeyBase64, sessionActionOrigin, isCurrent: isCallerCurrent });
            return authorization ? { target, authorization } : null;
          }
          return { target, authorization: {
          ...context.externalActionExecutionAuthorization!, binding: {
            ...context.externalActionExecutionAuthorization!.binding, sessionActionOrigin,
          } } };
        },
        createExecutor: () => credentialedFactory ? createCliActionExecutorFromCredentials({
          credentials, serverId: 'profile', serverApiUrl: 'https://session-home.test', serverIdentityId: 'home',
          machineId: 'machine-1', pluginActionExecutionOwner: 'current_process',
          externalActionMachineRequestPrivateKey: identity.privateKeyBase64,
          externalActionMachineInstallationId: identity.installationId,
          resolveServerFeaturesSnapshot: () => enabledFeatures,
        }) : createActionExecutor(deps),
      });
      const transportErrors: unknown[] = [];
      vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
        try {
          const request = AgentRuntimeDaemonServiceRequestV1Schema.parse(JSON.parse(String(init?.body)));
          expect(request.context).toEqual({ token: capability, sessionId });
          if (request.operation.kind !== 'action.execute') throw new Error('unexpected daemon operation');
          const operation = request.operation;
          // Startup's withSessionAccountHome scopes the entire daemon call,
          // including the global executor's later caller metadata lookup.
          const outcome = await runWithServerHttpBaseUrl('https://session-home.test', () => daemon(operation,
            { sessionId: request.context.sessionId, isCurrent: async () => true }));
          return Response.json(AgentRuntimeDaemonServiceResponseV1Schema.parse({ ok: true,
            result: { kind: 'action.execution', requestId: operation.requestId, outcome } }));
        } catch (error) { transportErrors.push(error); throw error; }
      });
      try {
        const session = createSessionAccountActionExecutor({
          base: createActionExecutor(createCliActionDeps({ token: '', sessionId, mode: 'plain', ctx: null })),
          client: { sessionId, getServerBinding: () => ({ serverId: 'profile', serverUrl: 'https://session-home.test' }),
            rpcHandlerManager: { invokeLocal: async () => null, registerHandler() {} }, updateMetadata() {},
            getActiveTurnAdmissionWitness: () => ({ turnId: 'turn-1', inputId: 'input-1', userMessageSeq: 1, userMessageSeqs: [1],
              agentStartCaller: { kind: 'session', sessionId, starterDepth: 0, turnDepth: 0 }, callerPermissionMode: nullCallerPermission ? null : 'default',
              causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' } }),
          },
        });
        const response = await session.execute('workflow.run.start', input, { surface: 'agent', actionRequestId: 'request-1' });
        expect(transportErrors).toEqual([]);
        if (missingBackend) {
          expect(WorkflowActionFailureV1Schema.parse(response)).toMatchObject({ ok: false, errorCode: 'target_unavailable',
            details: { code: 'target_unavailable', reason: 'agent_start_context_unavailable' } });
          expect(diagnostic.mock.calls).toContainEqual([expect.any(String), expect.objectContaining({
            reason: 'action_executor_refused', requestId: 'request-1', errorCode: 'target_unavailable',
            refusalPhase: 'agent_start_context', refusalReason: 'caller_agent_unavailable',
            elapsedSubphasesMs: expect.objectContaining({ cli_context: expect.any(Number),
              caller_session: expect.any(Number), role_sources: expect.any(Number), agent_inventory: expect.any(Number) }),
          })]);
          expect(JSON.stringify(diagnostic.mock.calls)).not.toMatch(/home-execution-proof|Bearer|\/repo/);
          expect(authenticatedReads).not.toContain('admit');
          return response;
        }
        if (unavailableWorkspace) {
          expect(WorkflowActionFailureV1Schema.parse(response)).toMatchObject({ ok: false, errorCode: 'target_unavailable',
            details: { reason: 'workspace_unavailable' } });
          expect(diagnostic.mock.calls).toContainEqual([expect.any(String), expect.objectContaining({
            reason: 'action_executor_refused', errorCode: 'target_unavailable', refusalCode: 'target_unavailable',
            refusalPhase: 'workflow_workspace', refusalReason: 'workspace_unavailable',
            elapsedSubphasesMs: expect.objectContaining({ workflow_workspace: expect.any(Number),
              workflow_materialization_context: expect.any(Number) }),
          })]);
          expect(JSON.stringify(diagnostic.mock.calls)).not.toMatch(/home-execution-proof|missing-workflow-start-diag-workspace/);
          expect(authenticatedReads).not.toContain('admit');
          return response;
        }
        expect(response).toEqual({ ok: true, result: expect.objectContaining({ admission: freshWait ? 'created' : 'existing' }) });
        if (!response.ok) return response;
        return WorkflowActionOutputSchemasV1['workflow.run.start'].parse(response.result);
      } finally {
        await removeAgentRuntimeDaemonServiceAuthorityIfOwned({ ...authority, capabilityDigest: hashPrivateBearer(capability) });
      }
    })();
    if (unavailableWorkspace || missingBackend) return;
    if (!hasSigner) {
      expect(result).toMatchObject({ ok: false, errorCode: 'not_authenticated' });
      expect(http.post).not.toHaveBeenCalled();
      return;
    }
    expect(result).toMatchObject({ admission: freshWait ? 'created' : 'existing', run: { id: runId, state: 'queued' } });
    if (nullCallerPermission) expect(context.externalActionExecutionAuthorization!.binding.sessionActionOrigin?.callerPermissionMode).toBeNull();
    if (machineRouted) expect(context.externalActionExecutionAuthorization!.binding.target).toEqual({
      kind: 'machine', machineId: 'machine-1', project: { machineId: 'machine-1', directory },
    });
    expect(authenticatedReads).toContain('get');
  });

  it.each(['detached_run', 'session'] as const)('offers %s recovery from the exact current native turn and capability, never a recorded recovery choice', async (targetKind) => {
    const runId = '11111111-1111-4111-8111-111111111111';
    const recordId = '33333333-3333-4333-8333-333333333333';
    const rootId = '44444444-4444-4444-8444-444444444444';
    const timestamp = '2026-01-01T00:00:00.000Z';
    const sessionId = 'c' + 'a'.repeat(24);
    const run = { sourceArtifactId: null, ownerAccountId: 'account-1', visibleTeamId: null, id: runId, origin: { kind: 'direct' }, state: 'interrupted', revision: 2,
      machineId: 'machine-1', workflowCustodyState: 'pending', originDeliveryAckRevision: null,
      availability: { pause: false, resumeBoundary: false,
         restoreWorkspace: false, cancel: true, inspectExecution: true, disabledReasons: [] },
      createdAt: timestamp, updatedAt: timestamp };
    const definition = validateWorkflowDefinition({ version: 1,
      defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } }, blocks: ['work'] }).normalizedDefinition!;
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId },
      acceptedSnapshot: { definition, authoredDefinition: definition, startedBy: 'user', workDepth: 0, metadata: null, frozenChildren: {},
        materializedLeaves: [{ sourceKey: '$root', blockId: definition.blocks[0]!.id, kind: 'step',
          selection: definition.defaults ?? {}, authoredWorkspace: { kind: 'inherit' }, executionTarget: { kind: targetKind } }],
        source: { kind: 'inline' }, inputs: {}, machineId: 'machine-1',
        executionTarget: { kind: targetKind }, workspaceTarget: { project: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } },
        origin: { kind: 'direct' }, authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } } },
    }));
    const index = { id: recordId, runId, sequence: '1', parentRecordId: rootId, memberOrdinal: '0', attempt: '0', contentRevision: '0',
      lifecycle: 'failed', createdAt: timestamp, updatedAt: timestamp };
    const contentEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'invocation_progress', accountId: 'account-1', runId, recordId,
        sequence: '1', parentRecordId: rootId, memberOrdinal: '0', attempt: '0' },
      progress: { kind: 'happier.workflow-progress.v1', blockKind: 'step', invocationPath: { blockId: definition.blocks[0]!.id, scope: [] },
        attempt: '0', logicalInvocationRecordId: recordId,
        workspace: { descriptor: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } },
        execution: targetKind === 'detached_run' ? { kind: 'detached_run', runId: 'native-run', localInputId: 'input-1', runtimeSelection: {} }
          : { kind: 'session', sessionId, localInputId: 'input-1' },
        recovery: { conversation: 'same_conversation', input: { kind: 'original' } } },
    }));
    const rootIndex = { ...index, id: rootId, sequence: '0', parentRecordId: null, lifecycle: 'needs_attention' };
    const rootContentEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'invocation_progress', accountId: 'account-1', runId, recordId: rootId,
        sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0' },
      progress: { kind: 'happier.workflow-progress.v1', blockKind: 'root', invocationPath: { blockId: '$root', scope: [] },
        attempt: '0', logicalInvocationRecordId: rootId },
    }));
    const checkpointEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowCheckpointStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'checkpoint', accountId: 'account-1', runId },
      checkpoint: { kind: 'happier.workflow-checkpoint.v1', rootRecordId: rootId,
        nextSequence: '2', frontier: { nextBlockOrdinal: 0, paused: false } },
    }));
    let checkpointAvailable = true;
    const keyCensus = WorkflowRunRecipientCensusResponseV1Schema.parse({
      runId, ownerAccountId: 'account-1', encryptionMode: 'plain', access: 'owner',
      dataEncryptionKey: null, callerDataEncryptionKey: null, recipients: [], visibleTeamId: null,
      ownerAccountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null },
    });
    http.post.mockImplementation(async (_url: string, body: Readonly<Record<string, unknown>>) => {
      if (body.operation === 'get') return { data: { run, acceptedEnvelope,
        checkpointEnvelope: checkpointAvailable ? checkpointEnvelope : null, resultEnvelope: null, keyCensus } };
      if (body.operation === 'run-key.census') return { data: keyCensus };
      if (body.operation === 'invocations.get') return { data: { invocation: body.invocationId === recordId
        ? { index, contentEnvelope, parentRevision: 2 }
        : body.invocationId === rootId
          ? { index: rootIndex, contentEnvelope: rootContentEnvelope, parentRevision: 2 } : null } };
      if (body.operation === 'invocations.list') return { data: {
        invocations: [rootIndex, index], parentRevision: 2, keyCensus } };
      throw new Error(`unexpected_effect:${String(body.operation)}`);
    });
    let replyCustodyUnavailable = false;
    if (targetKind === 'session') {
      const baseGet = http.get.getMockImplementation()!;
      const input = { id: 'input-row', seq: 7, localId: 'input-1', createdAt: 1, updatedAt: 1,
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Work' } } } };
      http.get.mockImplementation(async (url: string) => {
        if (url.endsWith(`/v1/sessions/${sessionId}/turns`)) return { status: 200,
          data: SessionTurnsProjectionV1Schema.parse({ v: 1, sessionId, updatedAt: 2, latestTurnId: 'turn-1', turns: [{
            turnId: 'turn-1', agentId: 'codex', status: 'completed', startedAt: 1, updatedAt: 2, terminalAt: 2,
            transcriptAnchors: { startUserMessageSeq: 7, userMessageSeqs: [7], startSeqInclusive: 7,
              endSeqInclusive: 9, finalAssistantMessageSeq: null },
          }] }),
        };
        if (url.endsWith('/reply')) return { status: 200, data: { v: 1, status: replyCustodyUnavailable ? 'unavailable' : 'none' } };
        if (url.includes('/messages/by-local-id/')) return { status: 200, data: { message: input } };
        if (url.includes('/messages?')) return { status: 200, data: { messages: [input,
          { id: 'started', seq: 8, localId: null, createdAt: 2, content: { t: 'plain', v: { role: 'agent',
            content: { type: 'acp', data: { type: 'task_started', id: 'turn-1' } } } } },
          { id: 'settled', seq: 9, localId: null, createdAt: 2, content: { t: 'plain', v: { role: 'agent',
            content: { type: 'acp', data: { type: 'task_complete', id: 'turn-1' } } } } },
        ] } };
        if (url.endsWith('/pending')) return { status: 200, data: { pending: [] } };
        if (url.includes(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session: createSessionRecordFixture({
          id: sessionId, active: true, encryptionMode: 'plain', metadata: JSON.stringify({ machineId: 'machine-1', path: '/repo', flavor: 'codex' }),
        }) } };
        return await baseGet(url);
      });
    }
    machineRpc.mockImplementation(async (input) => {
      if (input.method === RPC_METHODS.SESSION_CONTINUATION_INSPECT) return { type: 'available', protocolVersion: 1, sameSessionTransition: false };
      if (input.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) return { protocolVersion: 1,
        projection: { v: 2, generation: 1, agentsById: { codex: { id: 'codex',
          capabilities: { sessions: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: true } } } }, familiesById: {} } };
      return { run: { runId: 'native-run', callId: 'call', sidechainId: 'sidechain', intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, permissionMode: 'default', retentionPolicy: 'resumable',
      runClass: 'long_lived', ioMode: 'streaming', status: 'running', startedAtMs: 1,
      inputTurns: { occurrenceId: 'occurrence', current: { turnId: 'turn', inputIds: ['input-1'], state: 'failed' } },
      interaction: { kind: 'retained_agent_session.v1', capabilities: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: true } },
      lifecycle: { v: 1, state: 'current' } } };
    });
    const deps = createCliActionDeps({ token: 'token', credentials: { token: 'token', encryption: null },
      sessionId: 'cli-global', mode: 'plain', ctx: null, resolveServerFeaturesSnapshot: () => enabledFeatures as never });
    const inspected = await deps.workflowAction!({ actionId: 'workflow.run.invocations.get', input: { runId, invocationId: recordId }, context: {} });
    expect(inspected, JSON.stringify(inspected))
      .toMatchObject({ invocation: { recoveryAvailability: { retry: { kind: 'available' }, continueSameConversation: { kind: 'available' } } } });
    if (targetKind === 'session') {
      // An unreadable original obligation cannot borrow the later transcript's completion.
      replyCustodyUnavailable = true;
      expect(await deps.workflowAction!({ actionId: 'workflow.run.invocations.get', input: { runId, invocationId: recordId }, context: {} }))
        .toMatchObject({ invocation: { recoveryAvailability: { retry: { kind: 'unavailable' }, continueSameConversation: { kind: 'unavailable' } } } });
      replyCustodyUnavailable = false;
    }
    expect(machineRpc.mock.calls.every(([input]) => input.machineId === 'machine-1')).toBe(true);
    expect(await deps.workflowAction!({ actionId: 'workflow.run.invocations.list', input: { runId }, context: {} }))
      .toEqual({ invocations: [rootIndex, index], parentRevision: 2 });
    if (targetKind === 'detached_run') {
      index.lifecycle = 'running';
      machineRpc.mockResolvedValue({ run: { runId: 'native-run', callId: 'call', sidechainId: 'sidechain', intent: 'delegate',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, permissionMode: 'default', retentionPolicy: 'resumable',
        runClass: 'long_lived', ioMode: 'streaming', status: 'running', startedAtMs: 1,
        inputTurns: { occurrenceId: 'occurrence', current: { turnId: 'turn', inputIds: ['input-1'], state: 'active' } } } });
      const nativeReadsBefore = machineRpc.mock.calls.length;
      expect(await deps.workflowAction!({ actionId: 'workflow.run.resume', input: { mode: 'recover', runId, expectedRevision: 2,
        invocations: [{ kind: 'reattach', invocation: { recordId } }] }, context: {} }))
        .toMatchObject({ run: { id: runId, state: 'interrupted', revision: 2 }, intent: 'recovery_required' });
      expect([...new Set(machineRpc.mock.calls.slice(nativeReadsBefore).map(([input]) => input.method))])
        .toEqual([SESSION_RPC_METHODS.EXECUTION_RUN_GET]);
      expect(http.post.mock.calls.some(([, body]) => ['invocations.admit', 'invocations.recover', 'invocations.fact', 'initialize'].includes(body.operation))).toBe(false);
      const activeNative = ExecutionRunGetResponseSchema.parse(await machineRpc.mock.results.at(-1)?.value);
      machineRpc.mockResolvedValueOnce(activeNative).mockResolvedValueOnce({ ...activeNative, run: { ...activeNative.run,
        inputTurns: { occurrenceId: 'occurrence', current: { turnId: 'turn', inputIds: ['input-1'], state: 'completed',
          result: { kind: 'text', value: 'Done' } } },
      } });
      // Separate negative: without a checkpoint, reconciliation has no authoritative structural root. A settled native result
      // must not claim reconciliation when the frozen lexical binding is absent.
      checkpointAvailable = false;
      await expect(deps.workflowAction!({ actionId: 'workflow.run.resume', input: { mode: 'recover', runId, expectedRevision: 2,
        invocations: [{ kind: 'reattach', invocation: { recordId } }] }, context: {} }))
        .resolves.toMatchObject({ ok: false, errorCode: 'workflow_outcome_unresolved' });
    }
  });

  it('shares an opened plain Workflow through the credentialed Action host with a key-free storage write', async () => {
    const grants = { artifactId: 'definition-1', ownerAccountId: 'account-1', access: 'owner', grants: [], changed: true };
    http.get.mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (url.endsWith('/v1/artifacts/definition-1')) return { status: 200, data: {
        id: 'definition-1', ownerAccountId: 'account-1', access: 'owner', encryptionMode: 'plain',
        header: encodePlainArtifactStoredContent({ kind: 'workflow-definition.v1', definitionId: 'definition-1', revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: 'Shared' } }),
        body: encodePlainArtifactStoredContent({ body: '{}' }), headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
      } };
      if (url.endsWith('/access/recipients')) return { status: 200, data: {
        artifactId: 'definition-1', ownerAccountId: 'account-1', access: 'owner', encryptionMode: 'plain', dataEncryptionKey: null, callerDataEncryptionKey: null, recipients: [],
      } };
      throw new Error(`unexpected_get:${url}`);
    });
    http.put.mockResolvedValue({ status: 200, data: grants });
    const deps = createCliActionDeps({ token: 'token', credentials: { token: 'token', encryption: null }, sessionId: 'session-1', mode: 'plain', ctx: null });
    const input = { artifactId: 'definition-1', principal: { kind: 'team', teamId: 'team-1' }, accessLevel: 'edit' };
    await expect(createActionExecutor(deps).execute('artifact.access.grants.set' as ActionId, input, {
      surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' }, bypassApprovals: true,
    })).resolves.toEqual({ ok: true, result: grants });
    expect(http.put).toHaveBeenCalledWith(expect.stringContaining('/v1/artifacts/definition-1/access/grants'), input, expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer token' }) }));
    expect(http.post).not.toHaveBeenCalled();
  });

  it('normalizes a prompt-only Workflow from the trusted calling Session context', async () => {
    const deps = createCliActionDeps({
      token: 'token', credentials: { token: 'token', encryption: null }, sessionId: 'session-1',
      rawSession: { path: process.cwd(), machineId: 'machine-1' },
      getCurrentSessionBackendTarget: () => ({ kind: 'backend', backendId: 'codex', sourceKind: 'built_in' }),
      resolveServerFeaturesSnapshot: () => enabledFeatures as never,
      mode: 'plain', ctx: null,
    });
    const result = await deps.workflowAction!({
      actionId: 'workflow.validate',
      input: { definition: { blocks: ['work'] } },
      context: { defaultSessionId: 'session-1' },
    });

    expect(result).toMatchObject({
      valid: true,
      normalizedDefinition: {
        defaults: {
          agentTarget: {
            kind: 'agent',
            identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
          },
        },
      },
    });
    // Caller authorization may read currentness and the authenticated Session
    // index; normalization never fetches saved Workflow content or starts work.
    expect(http.get.mock.calls.every(([url]) => typeof url === 'string'
      && url.endsWith('/v1/account/encryption/currentness'))).toBe(true);
    expect(http.post.mock.calls.every(([url, input]) => typeof url === 'string'
      && url.endsWith('/v2/sessions/lookup-by-tags')
      && JSON.stringify(input) === JSON.stringify({ tags: ['session-1'] }))).toBe(true);
    expect(http.put).not.toHaveBeenCalled();
    expect(http.delete).not.toHaveBeenCalled();
  });

  it('records Account cancellation without resolving a local execution machine', async () => {
    const runId = '11111111-1111-4111-8111-111111111111';
    http.post.mockResolvedValue({ data: { run: { sourceArtifactId: null, ownerAccountId: 'account-1', visibleTeamId: null,
      id: runId, origin: { kind: 'direct' }, state: 'cancelled', revision: 1,
      machineId: 'offline-machine', workflowCustodyState: 'settled', originDeliveryAckRevision: null,
      availability: { pause: false, resumeBoundary: false, restoreWorkspace: false, cancel: false,
        inspectExecution: false, disabledReasons: [] },
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:01.000Z',
    }, intent: 'cancelled' } });
    const deps = createCliActionDeps({
      token: 'token', credentials: { token: 'token', encryption: null },
      resolveServerFeaturesSnapshot: () => enabledFeatures as never,
      sessionId: 'cli-global',
      mode: 'plain', ctx: null,
    });
    await expect(deps.workflowAction!({
      actionId: 'workflow.run.cancel', input: { runId, expectedRevision: 0 }, context: { surface: 'cli' },
    })).resolves.toMatchObject({ run: { id: runId, state: 'cancelled' }, intent: 'cancelled' });
    expect(http.post.mock.calls[0]?.[1]).toEqual({ operation: 'cancel', runId, expectedRevision: 0 });
    expect(http.get).not.toHaveBeenCalled();
  });

  it('does not fabricate Session ingress defaults for a non-Session caller', async () => {
    const deps = createCliActionDeps({
      token: 'token', credentials: { token: 'token', encryption: null }, sessionId: 'session-1',
      rawSession: { path: process.cwd(), machineId: 'machine-1' },
      getCurrentSessionBackendTarget: () => ({ kind: 'backend', backendId: 'codex', sourceKind: 'built_in' }),
      resolveServerFeaturesSnapshot: () => enabledFeatures as never,
      mode: 'plain', ctx: null,
    });

    await expect(deps.workflowAction!({
      actionId: 'workflow.validate',
      input: { definition: { blocks: ['work'] } },
      context: { surface: 'cli' },
    })).resolves.toMatchObject({ valid: false });
    expect(http.get).not.toHaveBeenCalled();
    expect(http.post).not.toHaveBeenCalled();
  });

  it('reports transport unavailable without promoting a session caller to signed-root authority', async () => {
    const deps = createCliActionDeps({
      token: 'token',
      sessionId: 'session-1',
      rawSession: { path: process.cwd(), machineId: 'machine-1' },
      getCurrentSessionBackendTarget: () => ({ kind: 'backend', backendId: 'codex', sourceKind: 'built_in' }),
      mode: 'plain',
      ctx: null,
    });
    const execute = deps.workflowAction;
    expect(execute).toBeDefined();
    if (!execute) throw new Error('expected Workflow Action boundary');

    await expect(execute({
      actionId: 'workflow.run.get',
      input: { runId: '33333333-3333-4333-8333-333333333333' },
      context: { surface: 'agent', defaultSessionId: 'session-1' },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'target_unavailable',
      error: 'target_unavailable',
    });
    const executor = createActionExecutor({ ...deps, isActionApprovalRequired: () => false });
    await expect(executor.execute('workflow.run.get', {
      runId: '33333333-3333-4333-8333-333333333333',
    }, {
      surface: 'agent', defaultSessionId: 'session-1',
    })).resolves.toEqual({ ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' });
    expect(signedRootAction).not.toHaveBeenCalled();
    expect(http.get).not.toHaveBeenCalled();
    expect(http.post).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', { status: 'ready', provenance: 'authenticated', features: { features: { automations: { enabled: true } }, capabilities: {} } }],
    ['malformed', { status: 'ready', provenance: 'authenticated', features: { features: { automations: { enabled: true }, workflows: { enabled: 'yes' } }, capabilities: {} } }],
    ['disabled', { status: 'ready', provenance: 'authenticated', features: { features: { automations: { enabled: true }, workflows: { enabled: false } }, capabilities: {} } }],
  ])('fails %s workflow availability before any storage effect', async (_name, snapshot) => {
    const deps = createCliActionDeps({
      token: 'token', credentials: { token: 'token', encryption: null }, sessionId: 'session-1',
      rawSession: { path: process.cwd(), machineId: 'machine-1' },
      getCurrentSessionBackendTarget: () => ({ kind: 'backend', backendId: 'codex', sourceKind: 'built_in' }),
      resolveServerFeaturesSnapshot: () => snapshot as never,
      mode: 'plain', ctx: null,
    });

    await expect(deps.workflowAction!({
      actionId: 'workflow.run.start',
      input: { runId: '33333333-3333-4333-8333-333333333333', source: { kind: 'inline', definition: { blocks: ['work'] } } },
      context: { surface: 'agent', defaultSessionId: 'session-1' },
    })).resolves.toMatchObject({ ok: false, errorCode: 'content_unavailable' });
    expect(http.get).not.toHaveBeenCalled();
    expect(http.post).not.toHaveBeenCalled();
  });
});
