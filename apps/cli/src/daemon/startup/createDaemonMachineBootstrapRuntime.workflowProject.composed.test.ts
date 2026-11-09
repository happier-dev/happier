import axios from 'axios';
import { chmod, copyFile, mkdir, readFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { afterAll, afterEach, expect, it, onTestFailed, onTestFinished, vi } from 'vitest';
import { ApiClient } from '@/api/api';
import { ApiMachineClient } from '@/api/apiMachine';
import { createInstalledProjectAgentLaunchFixture } from '@/daemon/testkit/installedProjectAgentLaunchFixture';
import { createDaemonMachineBootstrapRuntime } from './createDaemonMachineBootstrapRuntime';
import { createProductionWorkflowRunCoordinator, resolveWorkflowTriggerClaimSource } from '@/daemon/workflows/production';
import { createAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { buildWorkflowActionContext, createCredentialedWorkflowAcceptedAuthorizationCurrentness } from '@/daemon/workflows/daemonRuntime';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { createWorkflowRunStorageTestkit, createPlainWorkflowRunKeyCensusFixture } from '@/daemon/workflows/workflowRunStorage.testkit';
import { materializeWorkflowAcceptedSnapshotV1, serializeWorkflowStoredContentEnvelopeV1, sealWorkflowAcceptedSnapshotStoredEnvelopeV1,
  FeaturesResponseSchema, WorkflowDefinitionV1Schema, WorkflowProgressEnvelopeV1Schema, openWorkflowProgressStoredEnvelopeV1,
  parseWorkflowStoredContentEnvelopeV1, DEFAULT_AUTOMATION_V3_MAX_ACTIVE_RUNS_PER_MACHINE, DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1 } from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createAdmittedPluginRuntimeFixture, createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { AutomationV3WorkerClaimResponseSchema } from '@happier-dev/protocol/automations/automationApiV3';
import { ACP_CATALOG_ROWS_ROUTE_V1, AcpCatalogRecordV1Schema, AcpCatalogRowReadResponseV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1 } from '@happier-dev/protocol/agents/executionTargetV1';
import { writeDaemonState } from '@/persistence';
import { ExecutionRunGetResponseSchema, ExecutionRunStartResponseSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';

const pluginFixtures: Array<Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>>> = [];
afterAll(async () => { for (const fixture of pluginFixtures.reverse()) await fixture.dispose(); });

afterEach(async () => {
  // Retire the fixture lease without shutting down the process-wide controller
  // needed by the next case. Actual Run leases are closed by their own owner.
  for (const fixture of pluginFixtures) await fixture.lease.release();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
});

it.each(['kilo', 'acp', 'acp-failure', 'external', 'foreign'] as const)('carries the claimed Workflow %s Account through installed dispatch into Project launch', async scenario => {
  const configuredAcp = scenario === 'acp' || scenario === 'acp-failure';
  const accountId = scenario === 'foreign' ? 'foreign' : 'requester';
  const token = `e30.${Buffer.from(JSON.stringify({ sub: accountId,
    provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } })).toString('base64url')}.signature`;
  const homeServerIdentityId = 'workflow-project-home';
  const h = await createInstalledProjectAgentLaunchFixture({ accountActionCredentials: { token, encryption: null }, homeServerIdentityId });
  const credentials = h.installedCredentials!;
  // Never invoke an ambient vendor binary or borrow a developer's login.
  vi.stubEnv('HAPPIER_KILO_PATH', process.execPath);
  const machineId = 'machine';
  const runId = '7be4d65c-d3b7-4868-a416-b18d9ee29c1c';
  const currentness = { mode: 'plain' as const, version: 1, contentKeyFingerprint: null };
  const receipt = join(h.f.directory, 'native-project.json');
  const inputsReceipt = join(h.f.directory, 'native-workflow-inputs.json');
  const acpScript = configuredAcp ? writeAcpTestAgentScript({ dir: h.f.directory, fileName: 'judge.mjs', source: `
    import { createInterface } from 'node:readline';
    import { appendFileSync, writeFileSync } from 'node:fs';
    let selectedMode = 'fixture-default';
    for await (const line of createInterface({ input: process.stdin })) {
      const r = JSON.parse(line);
      if (r.id === undefined) continue;
      const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\\n');
      if (r.method === 'session/new') {
        writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ native: process.env.NATIVE, cwd: process.cwd() }));
        appendFileSync(${JSON.stringify(inputsReceipt + '.conversations')}, 'opened\\n');
      }
      if (r.method === 'session/set_config_option' && r.params.configId === 'reasoning_effort') {
        send({ id: r.id, error: { code: -32602, message: 'unknown config option reasoning_effort' } }); continue;
      }
      if (r.method === 'session/set_mode') selectedMode = r.params.modeId;
      if (r.method === 'session/set_model') {
        send({ id: r.id, result: { models: { currentModelId: r.params.modelId,
          availableModels: [{ modelId: r.params.modelId, name: r.params.modelId }] } } }); continue;
      }
      if (r.method === 'session/prompt') {
        const text = r.params.prompt.filter(part => part.type === 'text').map(part => part.text).join('\\n');
        appendFileSync(${JSON.stringify(inputsReceipt)}, JSON.stringify(text) + '\\n');
        appendFileSync(${JSON.stringify(inputsReceipt + '.modes')}, JSON.stringify(selectedMode) + '\\n');
        const reply = text.includes('FX44_PRODUCE') ? '{"name":"FX44_NAMED_VALUE"}'
          : text.includes('FX44_CONSUME') ? (text.includes('FX44_NAMED_VALUE') ? 'FX44_CONSUMED' : 'FX44_MISSING_VALUE')
          : 'CONFIGURED JUDGE DONE';
        send({ method: 'session/update', params: { sessionId: r.params.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply } } } });
      }
      send({ id: r.id, result: r.method === 'initialize' ? { protocolVersion: 1, agentCapabilities: {} }
        : r.method === 'session/new' ? { sessionId: 'native-workflow-judge', modes: {
          currentModeId: selectedMode, availableModes: [{ id: 'fixture-default', name: 'Default' },
            { id: 'fixture-read-only', name: 'Read only' }] } }
        : r.method === 'session/prompt' ? { stopReason: 'end_turn' } : {} });
    }
  ` }) : undefined;
  if (scenario === 'kilo' || scenario === 'foreign') {
    const bin = join(h.f.directory, 'bin');
    await mkdir(bin);
    const command = process.platform === 'win32' ? 'kilo.exe' : 'kilo';
    await copyFile(process.execPath, join(bin, command));
    if (process.platform !== 'win32') await chmod(join(bin, command), 0o755);
    vi.stubEnv('PATH', `${bin}${delimiter}${process.env.PATH ?? ''}`);
  }
  if (scenario === 'external') {
    const bin = join(h.f.directory, 'bin');
    await mkdir(bin);
    const tool = process.platform === 'win32' ? 'fixture-project-agent.exe' : 'fixture-project-agent';
    await copyFile(process.execPath, join(bin, tool));
    if (process.platform !== 'win32') await chmod(join(bin, tool), 0o755);
    vi.stubEnv('PATH', `${bin}${delimiter}${process.env.PATH ?? ''}`);
    pluginFixtures.push(await createAuthoredAdmittedPluginRuntimeFixture({ happyHomeDir: h.f.directory, controller: pluginReloadController,
      plugins: [{ manifest: createPluginManifestV2Fixture({ id: 'acme.workflow-project',
        hostAccess: { required: [{ id: 'process', capability: 'process', reason: 'Launch the fixture Agent',
          scope: { executables: [{ kind: 'systemTool', id: 'fixture' }] } },
          { id: 'workspace', capability: 'filesystem', reason: 'Use the admitted Project directory',
            scope: { locations: [{ root: 'workspace' }], access: ['read'] } }], optional: [] },
        contributes: { agents: [{ id: 'agent', title: 'Workflow Project Agent', runtime: { kind: 'custom' }, primary: 'sessions',
          capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true, executionRunContext: { versions: [1] } } } }],
          systemTools: [{ id: 'fixture', title: 'Fixture Agent', executableNames: [tool] }] } }),
        files: { 'daemon.mjs': `import { factory } from './agent.mjs';
          export function activate(api) { api.agents.register('agent', factory, {
            sessionRunnerFactory: { module: './agent.mjs', export: 'factory', runtimeApiVersion: 1 } }); }`,
          'agent.mjs': `export function factory() { async function openRun(request, context) {
            await context.services.exec.run({ executable: { kind: 'systemTool', id: 'fixture' },
              args: ['-e', ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ native: process.env.NATIVE, cwd: process.cwd() }));`)}],
              cwd: { root: 'workspace', relativePath: '' } }, { nativeLaunch: context.executionRun.services.nativeLaunch });
            throw new Error('fixture_vendor_unavailable');
          } return { sessions: { async open() { throw new Error('Unexpected Session'); },
            executionRunContextV1: { open: openRun, openConversation: openRun } } }; }` } }] }));
  } else {
    pluginFixtures.push(await createAdmittedPluginRuntimeFixture({ happyHomeDir: h.f.directory,
      controller: pluginReloadController, runtimeOptions: { pluginIds: [configuredAcp ? 'happier.agent.custom-acp' : 'happier.agent.kilo'] } }));
  }
  const agentTarget = configuredAcp ? { kind: 'agent' as const, identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1, definitionId: 'workflow-judge' }
    : { kind: 'agent' as const, identity: scenario === 'external' ? { pluginId: 'acme.workflow-project', localId: 'agent' }
      : { pluginId: 'happier.agent.kilo', localId: 'kilo' } };
  let definition = WorkflowDefinitionV1Schema.parse({ version: 1,
    defaults: { agentTarget, permissionMode: 'read_only',
      ...(configuredAcp ? { modelSelection: { v: 1, updatedAt: 0, ref: {
        agentTargetKey: 'agent:happier.agent.custom-acp/custom-acp:definition:workflow-judge',
        providerConnectionId: null, modelId: 'opencode/glm-5.3-flash-free' } } } : {}),
      ...(scenario === 'acp-failure' ? { sessionConfigOptionOverrides: { v: 1, updatedAt: 0,
        overrides: { reasoning_effort: { value: 'low', updatedAt: 0 } } } } : {}),
    }, blocks: scenario === 'acp' ? [
      { kind: 'step', id: 'first', document: { text: 'FX44_FIRST', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
      { kind: 'step', id: 'producer', document: { text: 'FX44_PRODUCE', references: [], attachments: [] }, input: [],
        result: { kind: 'json', schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false } } },
      { kind: 'step', id: 'consumer', document: { text: 'FX44_CONSUME', references: [], attachments: [] },
        input: [{ kind: 'result', producer: { blockId: 'producer', scope: { kind: 'current' } }, path: ['name'] }], result: { kind: 'text' } },
    ] : [{ kind: 'step', id: configuredAcp ? 'judge' : 'background',
      document: { text: 'Run the background check.', references: [], attachments: [] }, input: [], result: { kind: 'text' } }] });
  const definitionId = '44114411-4411-4411-8411-441144114411';
  if (scenario === 'acp') {
    let artifact: Record<string, unknown> = {};
    const get = vi.mocked(axios.get).getMockImplementation()!;
    const post = vi.mocked(axios.post).getMockImplementation()!;
    vi.spyOn(axios, 'post').mockImplementation(async (url, body, options) => {
      if (!String(url).endsWith('/v1/artifacts')) return await post(url, body, options);
      if (!body || typeof body !== 'object') throw new Error('Invalid Artifact HTTP write');
      artifact = { ...body, id: definitionId, ownerAccountId: accountId, access: 'owner', encryptionMode: 'plain',
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
      return { status: 200, data: artifact };
    });
    vi.spyOn(axios, 'get').mockImplementation(async (url, options) => {
      if (String(url).endsWith(`/v1/artifacts/${definitionId}/access/recipients`)) return { status: 200, data: {
        artifactId: definitionId, ownerAccountId: accountId, access: 'owner', encryptionMode: 'plain',
        dataEncryptionKey: null, callerDataEncryptionKey: null, recipients: [] } };
      if (String(url).endsWith(`/v1/artifacts/${definitionId}`)) return { status: 200, data: artifact };
      return await get(url, options);
    });
    await createAccountArtifactStore({ credentials, getAccountEncryptionMode: async () => 'plain' }).create({
      artifactId: definitionId, header: { kind: 'workflow-definition.v1', definitionId,
        revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: 'QA44 saved three-step Workflow' } },
      savedBy: { kind: 'person', accountId }, body: JSON.stringify({ kind: 'workflow-definition.v1', definition }),
    });
    const saved = await resolveWorkflowTriggerClaimSource({ target: { kind: 'workflow', ref: definitionId }, credentials,
      encryption: { kind: 'available', witness: currentness } });
    expect(saved).toMatchObject({ kind: 'saved', definitionId });
    if (!saved) throw new Error('Saved Workflow unavailable');
    definition = saved.definition;
  }
  const accepted = await materializeWorkflowAcceptedSnapshotV1({ definition,
    context: { source: { kind: 'automation', automationId: 'automation-project', ...(scenario === 'acp' ? { definitionId,
        revision: { headerVersion: 1, bodyVersion: 1 }, savedBy: { kind: 'person' as const, accountId } } : {}) }, inputs: {}, machineId,
      executionTarget: { kind: 'detached_run' }, workspaceTarget: { project: { machineId, directory: h.cwd, checkoutRootPath: h.cwd } },
      authorization: { principal: { kind: 'host' } } }, admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true } });
  if (!accepted.ok) throw new Error(accepted.error.code);
  const envelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
    binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot: accepted.snapshot }));
  const storage = createWorkflowRunStorageTestkit({ runId, machineId, origin: { kind: 'automation', automationId: 'automation-project' },
    acceptedEnvelope: envelope, state: 'claimed', keyCensus: { ...createPlainWorkflowRunKeyCensusFixture({ runId, accountId }),
      ownerAccountCurrentness: currentness } });
  let projectRequester: string | undefined;
  const machine = new ApiMachineClient(token, { id: machineId, encryptionMode: 'plain', metadata: null, metadataVersion: 0,
    daemonState: null, daemonStateVersion: 0, dataEncryptionKey: 'plain' }, undefined, {
      createProjectFiniteRuntime: async (ports, ingress) => {
        const runtime = await h.finite(ports, ingress);
        projectRequester = runtime?.accountId;
        return runtime;
    } });
  onTestFinished(() => machine.shutdown());
  const registration = machine.setRPCHandlers({ spawnSession: async () => { throw new Error('Unexpected Session'); },
    stopSession: async () => true, requestShutdown() {} }, { workingDirectory: h.cwd });
  onTestFinished(() => registration.dispose());
  // ApiClient and its installed Machine client are real; only the Home socket
  // and HTTP responses are boundaries. Use the actual registered dispatcher.
  const api = await ApiClient.create(credentials);
  const calls: Array<{ method: string; code?: string; error?: string; hasRequester?: boolean; hasWorkflow?: boolean }> = [];
  const startedRuns = new Set<string>();
  const stopStartedRuns = async () => {
    for (const startedRunId of startedRuns) await machine.invokeLocalMachineAction(SESSION_RPC_METHODS.EXECUTION_RUN_STOP, { runId: startedRunId });
  };
  onTestFinished(stopStartedRuns);
  onTestFailed(async () => { console.error('Workflow Project boundary observations', { scenario, calls,
    nativePrompts: await readFile(inputsReceipt, 'utf8').catch(() => 'unavailable') }); });
  vi.spyOn(api, 'machineSyncClient').mockReturnValue(machine);
  const invoke = machine.invokeLocalMachineAction.bind(machine);
  vi.spyOn(machine, 'invokeLocalMachineAction').mockImplementation(async (method, request, options) => {
    try { const result = await invoke(method, request, options);
      if (method === SESSION_RPC_METHODS.EXECUTION_RUN_START) {
        const started = ExecutionRunStartResponseSchema.safeParse(result);
        if (started.success) startedRuns.add(started.data.runId);
      }
      const observed = ExecutionRunGetResponseSchema.safeParse(result);
      calls.push({ method, hasRequester: Boolean(options?.rpcContext?.requesterSessionBootstrap),
        hasWorkflow: Boolean(options?.localActionContext?.executionRunWorkflowRunId),
        ...(observed.success ? { code: observed.data.run.error?.code,
          error: observed.data.run.error?.message?.replaceAll(token, '[redacted]') } : {}),
        ...(result && typeof result === 'object' && 'errorCode' in result ? { code: String(result.errorCode),
          ...('error' in result && typeof result.error === 'string' ? { error: result.error.replaceAll(token, '[redacted]') } : {}) } : {}) });
      return result;
    } catch (error) { calls.push({ method, error: error instanceof Error ? error.message : 'unknown' }); throw error; }
  });
  const baseGet = vi.mocked(axios.get).getMockImplementation()!;
  vi.spyOn(axios, 'get').mockImplementation(async (url, options) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/worker/assignments')) return { status: 200, data: { assignments: [],
      settings: { maxActiveRunsPerMachine: DEFAULT_AUTOMATION_V3_MAX_ACTIVE_RUNS_PER_MACHINE } } };
    if (path.endsWith('/worker/run-lifecycle')) return { status: 200, data: { sources: [] } };
    if (path.endsWith('/connected-accounts/purposes')) return { status: 200, data: { status: 'present', revision: 1,
      content: { t: 'plain', v: { key: 'purposes', value: { v: 1, bindings: [] } } } } };
    if (path === ACP_CATALOG_ROWS_ROUTE_V1) return { status: 200, data: AcpCatalogRowReadResponseV1Schema.parse({ status: 'present', revision: 1,
      content: { t: 'plain', v: AcpCatalogRecordV1Schema.parse({ v: 1, definitions: [{ id: 'workflow-judge', name: 'workflow-judge', title: 'Judge',
        launch: { kind: 'command', command: process.execPath, args: acpScript ? [acpScript] : [] },
        runtime: { permissionModeMapping: { default: null, yolo: null, plan: 'fixture-read-only', 'safe-yolo': null, 'read-only': 'fixture-read-only' } },
        createdAt: 1, updatedAt: 1 }] }) } }) };
    return await baseGet(url, options);
  });
  let claimed = false;
  const basePost = vi.mocked(axios.post).getMockImplementation()!;
  vi.spyOn(axios, 'post').mockImplementation(async (url, body, options) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/runs/claim')) {
      if (claimed) return { data: { run: null, automation: null, accountCurrentness: null } };
      claimed = true;
      return { data: AutomationV3WorkerClaimResponseSchema.parse({ run: { id: runId, automationId: 'automation-project', attempt: 1, leaseExpiresAt: Date.now() + 120_000, revision: 0,
        recipeKind: 'workflow-v2', triggerId: null, triggerRetired: false, cause: { kind: 'manual', invokedAt: Date.now() },
        executionInputEnvelope: '{}', automationEvidenceEnvelope: null, workflowAcceptedSnapshotEnvelope: envelope },
        automation: { id: 'automation-project', name: 'Judge', enabled: true }, accountCurrentness: currentness }) };
    }
    if (path.endsWith('/heartbeat') || path.endsWith('/fail')) return { data: { ok: true } };
    return await basePost(url, body, options);
  });
  const baseFetch = globalThis.fetch;
  writeDaemonState({ pid: process.pid, httpPort: 43130, startedAt: Date.now(), startedWithCliVersion: 'fixture', controlToken: 'fixture-control' });
  vi.stubGlobal('fetch', async (url: Parameters<typeof fetch>[0], options?: RequestInit) => {
    if (new URL(String(url)).pathname === '/execution-run/admission') return Response.json({ admitted: true });
    if (new URL(String(url)).pathname === '/v1/features') return Response.json(FeaturesResponseSchema.parse({
      features: { automations: { enabled: true }, workflows: { enabled: true } }, capabilities: {} }));
    return await baseFetch(url, options);
  });
  vi.stubEnv('HAPPIER_FEATURE_AUTOMATIONS__ENABLED', '1');
  vi.stubEnv('HAPPIER_FEATURE_EXECUTION_RUNS__ENABLED', '1');
  let result: unknown;
  let failure: unknown;
  let coordinating: Promise<unknown> | undefined;
  const bootstrap = createDaemonMachineBootstrapRuntime({ api, credentials, controlPort: 43129, requesterServerId: 'session-home',
    resolveCurrentServerIdentityId: () => homeServerIdentityId,
    runtimeId: 'workflow-project', publicReleaseChannel: 'dev', startupSource: 'manual', serviceLabel: undefined,
    transferRuntimeStatePublisher: null, spawnSessionForInternalResume: async () => { throw new Error('Unexpected Session'); },
    spawnSession: async () => { throw new Error('Unexpected Session'); }, stopSession: async () => true,
    awaitAgentSessionOpen: async () => { throw new Error('Unexpected Session'); }, isSessionAlreadyRunning: async () => false,
    loadLocalSessionMetadataForHandoff: async () => null, beforeShutdown: async () => {}, requestShutdown() {},
    directPeerServerLifecycle: null, directTransferRegistryHost: {} as never, daemonServerWorkScheduler: {} as never,
    setDaemonServerWorkOnline() {}, onMachineConnectionOnline: async () => {}, reconcileConnectedServicesProjection: async () => {},
    isShuttingDown: () => false, isWorkflowFeatureEnabled: () => true,
    createWorkflowRunCoordinatorForMachine(input) {
      const authorizationCurrentness = createCredentialedWorkflowAcceptedAuthorizationCurrentness({ credentials, accountId });
      const executor = createCliActionExecutorFromCredentials({ credentials, serverId: 'session-home', serverApiUrl: 'https://session-home.test',
        machineId, machineActionDirectTargetTransport: input.machineActionDirectTargetTransport,
        workflowAcceptedAuthorizationCurrentness: authorizationCurrentness });
      const context = () => ({ ...buildWorkflowActionContext({ runId, authorization: accepted.snapshot.authorization, workspace: { machineId } },
        input.requesterWorkAttributionV1), sessionAgentSpawnPolicyV1: DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1,
        agentStartContext: { caller: { kind: 'originless' as const, runId, runDepth: accepted.snapshot.workDepth },
          baseline: { machineId, directory: h.cwd }, ledSubtreeSessionIds: [], roles: {},
          callerPermissionCeiling: accepted.snapshot.authorization.admittedPermissionCeiling, workDepthLimit: 4 } });
      const coordinate = createProductionWorkflowRunCoordinator({ token, accountId, machineId, storage,
        resolveAccountEncryption: async () => ({ kind: 'available', witness: currentness }),
        resolveControllerContext: async () => context(), isAcceptedAuthorizationCurrent: authorizationCurrentness,
        onCommittedTransition() {}, workspaceScm: { realizeWorktree: async () => { throw new Error('Unexpected worktree'); },
          inspectLocation: async () => null, verifyRecordedWorkspace: async () => 'available' },
        execution: { credentials, serverId: 'session-home', machineAdmissionTransport: input.machineAdmissionTransport,
          resolveExistingSessionConversation: async () => null, detachedRun: { actionExecutor: executor, buildActionContext: context } } });
      return async claim => { try { const pending = coordinate(claim); coordinating = pending; const completed = await pending; result = completed; return completed; }
        catch (error) { failure = error; throw error; } };
    } });
  await bootstrap.createConnectedApiMachine({ id: machineId, encryptionMode: 'plain', metadata: null, metadataVersion: 0,
    daemonState: null, daemonStateVersion: 0, dataEncryptionKey: 'plain' });
  const worker = await bootstrap.startAutomationWorkerForMachine(machineId);
  onTestFinished(() => worker?.stop());
  await worker?.refreshAssignments();
  worker?.handleServerUpdate({ id: 'workflow-project-wake', seq: 1, createdAt: Date.now(), body: {
    t: 'automation-run-updated', runId, automationId: 'automation-project', state: 'queued', scheduledAt: Date.now(), startedAt: null,
    finishedAt: null, updatedAt: Date.now(), machineId: null, targetMachineId: machineId } });
  if (accountId === 'requester') {
    await vi.waitFor(() => {
      expect(claimed).toBe(true);
      expect(projectRequester, JSON.stringify({ result, failure, calls })).toBe('requester');
      expect(h.nativeEffects()).toBeGreaterThan(0);
      if (scenario === 'external') return readFile(receipt, 'utf8').then(content => {
        expect(JSON.parse(content)).toEqual({ native: 'active', cwd: h.cwd });
      });
    }, { timeout: 30_000 });
  }
  if (accountId === 'foreign') {
    await vi.waitFor(() => expect(result ?? failure).toBeDefined(), { timeout: 30_000 });
    expect(result ?? failure).toMatchObject({ reason: 'project_requester_credentials_unavailable' });
    expect(projectRequester).toBeUndefined();
    expect(h.nativeEffects()).toBe(0);
    expect(calls.some(call => call.method === SESSION_RPC_METHODS.EXECUTION_RUN_START)).toBe(false);
  }
  if (configuredAcp) {
    await vi.waitFor(() => expect(result ?? failure, JSON.stringify(calls)).toBeDefined(), { timeout: 30_000 });
    await coordinating;
    expect(JSON.parse(await readFile(receipt, 'utf8'))).toEqual({ native: 'active', cwd: h.cwd });
    expect(storage.rows().some(row => row.index.lifecycle === (scenario === 'acp' ? 'completed' : 'failed'))).toBe(true);
    for (const startedRunId of startedRuns) {
      const observed = ExecutionRunGetResponseSchema.parse(await machine.invokeLocalMachineAction(SESSION_RPC_METHODS.EXECUTION_RUN_GET,
        { runId: startedRunId, includeStructured: true }));
      const nativePrompts = await readFile(inputsReceipt, 'utf8').catch(() => 'unavailable');
      expect(observed.run.inputTurns?.current).toBeUndefined();
      expect(observed.run.turnInFlight).not.toBe(true);
      expect(observed.run.inputTurns?.last?.state, JSON.stringify({ observed, nativePrompts })).toBe(scenario === 'acp' ? 'completed' : 'failed');
      if (scenario === 'acp') expect(observed.run.inputTurns?.last?.state).toBe('completed');
      else {
        expect(observed.run.status).toBe('failed');
        expect(observed.run.error?.code).toBe('acp_configuration_update_failed');
        expect(observed.run.error?.message).toContain('reasoning_effort');
      }
    }
    if (scenario === 'acp') {
      expect(result).toMatchObject({ state: 'succeeded' });
      const prompts = (await readFile(inputsReceipt, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string);
      expect(prompts).toEqual([expect.stringContaining('FX44_FIRST'), expect.stringContaining('FX44_PRODUCE'),
        expect.stringContaining('FX44_CONSUME')]);
      expect(prompts[2]).toContain('FX44_NAMED_VALUE');
      expect((await readFile(inputsReceipt + '.conversations', 'utf8')).trim().split('\n')).toEqual(['opened']);
      expect((await readFile(inputsReceipt + '.modes', 'utf8')).trim().split('\n').map(line => JSON.parse(line)))
        .toEqual(['fixture-read-only', 'fixture-read-only', 'fixture-read-only']);
      const progress = storage.rows().map(row => {
        const index = row.index;
        const opened = openWorkflowProgressStoredEnvelopeV1({ mode: 'plain', binding: { v: 1, purpose: 'invocation_progress',
          accountId, runId, recordId: index.id, sequence: index.sequence, parentRecordId: index.parentRecordId,
          memberOrdinal: index.memberOrdinal, attempt: index.attempt }, envelope: parseWorkflowStoredContentEnvelopeV1(row.contentEnvelope) });
        if (opened.kind !== 'available') throw new Error('Workflow progress unavailable');
        return { lifecycle: index.lifecycle, ...WorkflowProgressEnvelopeV1Schema.parse(opened.content) };
      });
      expect(progress.find(row => row.invocationPath.blockId === 'first')).toMatchObject({ lifecycle: 'completed', result: 'CONFIGURED JUDGE DONE' });
      expect(progress.find(row => row.invocationPath.blockId === 'producer')).toMatchObject({ lifecycle: 'completed', result: { name: 'FX44_NAMED_VALUE' } });
      expect(progress.find(row => row.invocationPath.blockId === 'consumer')).toMatchObject({ lifecycle: 'completed', result: 'FX44_CONSUMED' });
    }
  }
  await stopStartedRuns();
  worker?.stop();
  await coordinating?.catch(() => undefined);
}, 120_000);
