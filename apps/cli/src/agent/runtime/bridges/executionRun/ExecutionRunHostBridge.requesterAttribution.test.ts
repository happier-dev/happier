import { afterAll, afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fastify, { type FastifyInstance } from 'fastify';
import { configuration, reloadConfiguration } from '@/configuration';
import { ApiSessionClient } from '@/api/session/sessionClient';
import { createTestApiSessionClient } from '@/testkit/backends/createTestApiSessionClient';
import { createPlainSessionFixture } from '@/testkit/backends/sessionFixtures';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createRequesterSessionCredentialCustody, readRequesterSessionCredentialsForChild, REQUESTER_SESSION_CREDENTIAL_FILE_ENV, REQUESTER_SESSION_ID_ENV } from '@/daemon/sessionEncryption/requesterSessionCredentials';
import { createExecutionRunLiveWorkProducer } from '@/daemon/executionRunRegistry';
import { createLiveWorkProducerGroup, createManagedActivityInventory, type LiveWorkProducerV1 } from '@/daemon/lifecycle/managedActivity';
import { projectMachineWorkSummary } from '@/daemon/machines/machineWorkSummary';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { ExecutionRunGetResponseSchema, ExecutionRunStartResponseSchema, WorkflowAcceptedSnapshotV1Schema,
  openWorkflowAcceptedSnapshotStoredEnvelopeV1, sealWorkflowAcceptedSnapshotStoredEnvelopeV1 } from '@happier-dev/protocol';
import { AccountEncryptionModeResponseSchema, AccountEncryptionCurrentnessResponseSchema } from '@happier-dev/protocol/account/encryptionMode';
import { PluginAccountSettingsReadResponseV1Schema } from '@happier-dev/protocol/plugins/settings/accountSettingsV1';
import { PROMPT_LIBRARY_ROWS_ROUTE_V1, PromptLibraryRowsListResponseV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { ACP_CATALOG_ROWS_ROUTE_V1, AcpCatalogRowReadResponseV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { MCP_SERVER_CATALOG_ROWS_ROUTE_V1, McpServerCatalogRowReadResponseV1Schema } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import type { PluginDaemonModuleNamespace } from '@/plugins/runtime/types';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { writeSessionMarker, hashProcessCommand } from '@/daemon/sessionRegistry';
import { readProcessIdentityByPid } from '@/daemon/processIdentity';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createDaemonControlApp } from '@/daemon/controlServer';
import { isValidConnectedServiceRunMaterializeToken } from '@/daemon/connectedServices/runs/capabilityToken';
import { readStoredCredentials, writeCredentialsTokenOnly, writeDaemonState } from '@/persistence';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { refreshActiveAcpCatalog } from '@/agent/acp/catalog/hydrateAcpCatalog';
import { prepareActiveMcpServerCatalog } from '@/settings/mcp/hydrateMcpServerCatalog';
import { createDaemonPluginChangeService } from '@/plugins/daemon/changeService';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { createExecutionRunHostBackendFromConversationRuntime } from '@happier-dev/plugin-sdk/agents/runtime';
import type { AgentExecutionRunOpenRequest, AgentExecutionRunRuntime, AgentExecutionRunConversationEventV1,
  AgentSessionOpenRequest, AgentSessionRuntime, AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import { createProductionDaemonWorkflowRuntime } from '@/daemon/workflows/daemonRuntime';
import { createWorkflowRunStorageTestkit, type WorkflowRunStorageTestkitOperation } from '@/daemon/workflows/workflowRunStorage.testkit';
import { registerExecutionRunRpcHandlers } from '@/rpc/handlers/executionRuns/registerExecutionRunRpcHandlers';
import { registerCapabilitiesHandlers } from '@/rpc/handlers/capabilities';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';

// This is a host attribution contract, not Claude codec/process certification.
// An authored public-SDK Agent supplies the external sessions.open/send behavior;
// source admission, activation, registry, Run factory and host context stay real.
vi.mock('socket.io-client', () => ({ io: () => createApiSessionSocketStub() }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const { createBundledPluginPublicationFsFixture } = await import('@/plugins/projection/registry/builtIn/locators.testkit');
  return createBundledPluginPublicationFsFixture(actual);
});

const nativeOpen = vi.fn<(request: AgentSessionOpenRequest) => Promise<AgentSessionRuntime>>();
const nativeDetachedOpen = vi.fn<(request: AgentExecutionRunOpenRequest) => Promise<AgentExecutionRunRuntime>>();
const testAgentPlugin = definePlugin({
  id: 'test.c42.attribution', version: '0.0.0', displayName: 'Attribution test Agent',
  entrypoints: { daemon: './daemon.mjs' },
  agents: {
    agent: {
      declaration: { title: 'Attribution test Agent', runtime: { kind: 'custom' }, primary: 'sessions',
        capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true,
          executionRunContext: { versions: [1] } } } },
      factory: () => ({ sessions: { open: request => nativeOpen(request),
        executionRunContextV1: { open: request => nativeDetachedOpen(request) } } }),
      sessionRunnerFactory: { module: './agent-runtime.mjs', export: 'createRuntime', runtimeApiVersion: 1 },
    },
  },
});
const testAgentIdentity = { pluginId: testAgentPlugin.manifest.id, localId: 'agent' };
let directory: string;
let admittedRuntimeFixture: Awaited<ReturnType<typeof createAuthoredAdmittedPluginRuntimeFixture>> | undefined;
let home: FastifyInstance | undefined;
let daemon: FastifyInstance | undefined;
let restoreHttp: (() => void) | undefined;
let pluginChanges: ReturnType<typeof createDaemonPluginChangeService> | undefined;
afterAll(async () => { await admittedRuntimeFixture?.dispose(); });
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'happier-run-attribution-'));
  vi.stubEnv('HAPPIER_HOME_DIR', directory);
  reloadConfiguration();
});
afterEach(async () => {
  vi.restoreAllMocks();
  nativeOpen.mockReset();
  nativeDetachedOpen.mockReset();
  restoreHttp?.(); restoreHttp = undefined;
  await home?.close(); home = undefined;
  await daemon?.close(); daemon = undefined;
  await pluginChanges?.shutdown(); pluginChanges = undefined;
  vi.unstubAllEnvs();
  reloadConfiguration();
  rmSync(directory, { recursive: true, force: true });
});

it.each(['protected child', 'ordinary accepted marker', 'legacy metadata only'] as const)(
  'carries protected child admission through actual Session Run startup into the sole inventory without metadata inference (%s)',
  runRequesterAttributionCase,
);

it('carries admitted Bob Workflow custody through its real detached Action child Run into the sole inventory', async () => {
  await runRequesterAttributionCase('admitted Workflow');
});

async function runRequesterAttributionCase(source: 'protected child' | 'ordinary accepted marker' | 'legacy metadata only' | 'admitted Workflow') {
  vi.stubEnv('HAPPIER_FEATURE_EXECUTION_RUNS__ENABLED', '1');
  const origin = 'http://run-requester-home.test';
  vi.stubEnv('HAPPIER_SERVER_URL', origin);
  reloadConfiguration();
  const accountId = source === 'ordinary accepted marker' ? 'alice' : 'bob';
  // A released terminal-session credential is what ordinary CLI sign-in stores;
  // sub-only legacy Account bearers are intentionally invalidated by its reader.
  const token = `header.${Buffer.from(JSON.stringify({ sub: accountId, session: 'run-attribution-terminal' })).toString('base64url')}.signature`;
  const attribution = { serverId: configuration.activeServerId, accountId, machineId: 'admitted-machine', installationId: 'admitted-installation' };
  const workflowRunId = '7be4d65c-d3b7-4868-a416-b18d9ee29c1c';
  const workflowDefinition = { version: 1 as const, inputs: [],
    defaults: { agentTarget: { kind: 'agent' as const, identity: testAgentIdentity },
      permissionMode: 'read-only', conversation: { kind: 'fresh' as const } },
    blocks: [{ kind: 'step' as const, id: 'inspect', document: { text: 'Inspect.', references: [], attachments: [] },
      input: [], result: { kind: 'text' as const } }] };
  const accepted = source === 'admitted Workflow' ? WorkflowAcceptedSnapshotV1Schema.parse({ startedBy: 'user', definition: workflowDefinition,
    authoredDefinition: workflowDefinition, workDepth: 0, metadata: { title: 'Inspect workspace' }, frozenChildren: {}, inputs: {},
    machineId: attribution.machineId, materializedLeaves: [{ sourceKey: '$root', blockId: 'inspect', kind: 'step',
      selection: workflowDefinition.defaults, executionTarget: { kind: 'detached_run' }, authoredWorkspace: { kind: 'inherit' } }],
    source: { kind: 'inline' }, executionTarget: { kind: 'detached_run' },
    workspaceTarget: { project: { machineId: attribution.machineId, directory, checkoutRootPath: directory } },
    origin: { kind: 'direct' }, authorization: { principal: { kind: 'host' }, admittedPermissionCeiling: 'read-only' } }) : undefined;
  let acceptedEnvelope: string | undefined;
  if (accepted) {
    const binding = { v: 1 as const, purpose: 'accepted_snapshot' as const, accountId, runId: workflowRunId };
    const sealed = sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain', binding, acceptedSnapshot: accepted });
    if (sealed.t !== 'plain' || !sealed.v || typeof sealed.v !== 'object' || Array.isArray(sealed.v)) {
      throw new Error('Missing canonical plain Workflow payload');
    }
    // The server storage boundary retains opaque bytes from another writer.
    // Only its tolerant stored reader sees this future display-metadata field;
    // the accepted-intent writer above remains strict and cannot author it.
    const persisted = { ...sealed, v: { ...sealed.v, content: { ...accepted, metadata: { ...accepted.metadata,
      requesterWorkAttributionV1: { ...attribution, accountId: 'alice', machineId: 'authored-decoy-machine' } } } } };
    expect(openWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain', binding, envelope: persisted }))
      .toEqual({ kind: 'available', content: accepted });
    acceptedEnvelope = JSON.stringify(persisted);
  }
  const workflowStorage = acceptedEnvelope ? createWorkflowRunStorageTestkit({ accountId, runId: workflowRunId, machineId: attribution.machineId,
    origin: { kind: 'direct' }, acceptedEnvelope }) : undefined;
  // The actual Session registrar resolves Account settings before Run admission.
  // Native invocation settings read their separate Account plugin record and
  // explicit Account mode through this same authenticated Home boundary.
  home = fastify();
  home.addHook('preHandler', async (request, reply) => {
    if (request.headers.authorization !== `Bearer ${token}`) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
  });
  home.get('/v2/account/settings', async () => ({ content: { t: 'plain', v: {} }, version: 1 }));
  home.get('/v1/account/plugin-settings/:pluginId', async () =>
    PluginAccountSettingsReadResponseV1Schema.parse({ status: 'absent' }));
  home.get('/v1/account/encryption', async () =>
    AccountEncryptionModeResponseSchema.parse({ mode: 'plain', updatedAt: 1 }));
  // Every executable catalog row admits the persisted Account mode/currentness,
  // including ordinary Session startup, before opening its plain content.
  home.get('/v1/account/encryption/currentness', async () => AccountEncryptionCurrentnessResponseSchema.parse({
    mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
  }));
  // Independent executable catalogs are observed through their Account row
  // owners, not inferred from the empty legacy Settings object or Agent id.
  home.get(ACP_CATALOG_ROWS_ROUTE_V1, async () => AcpCatalogRowReadResponseV1Schema.parse({
    status: 'present', revision: 1, content: { t: 'plain', v: { v: 1, definitions: [] } },
  }));
  home.get(MCP_SERVER_CATALOG_ROWS_ROUTE_V1, async () => McpServerCatalogRowReadResponseV1Schema.parse({
    status: 'present', revision: 1, content: { t: 'plain', v: { v: 1, servers: [], bindings: [] } },
  }));
  if (source === 'admitted Workflow') {
    // Fresh host Agent-start admission reads real Account Role sources and
    // their canonical private catalog before supplying the detached context.
    home.get('/v1/artifacts', async () => []);
    home.get(PROMPT_LIBRARY_ROWS_ROUTE_V1, async () => PromptLibraryRowsListResponseV1Schema.parse({
      status: 'listed', rows: [{ key: 'role-overrides', revision: 1,
        content: { t: 'plain', v: { key: 'role-overrides', value: { v: 1, overrides: {} } } } }],
    }));
    home.post<{ Body: WorkflowRunStorageTestkitOperation }>('/v3/automations/runs/workflow-storage', async request =>
      await workflowStorage!.execute(request.body));
  }
  await home.ready();
  restoreHttp = installAxiosFastifyAdapter({ app: home, origin });
  // Run admission uses the real local daemon HTTP owner and scoped capability.
  // Child spawning/tracking are OS boundaries unused by this Session-owned Run.
  const controlToken = 'run-attribution-test-control';
  pluginChanges = createDaemonPluginChangeService({
    prepare: async () => { throw new Error('Unexpected plugin installation'); },
  });
  daemon = createDaemonControlApp({
    getChildren: () => [], machineId: 'admitted-machine', controlToken,
    stopSession: async () => ({ status: 'not_found' as const }),
    spawnSession: async () => { throw new Error('Unexpected child spawn'); },
    requestShutdown: () => undefined, onHappySessionWebhook: () => undefined,
    verifyRunMaterializeToken: provided => isValidConnectedServiceRunMaterializeToken(provided, controlToken),
    pluginChangeService: pluginChanges,
  });
  await daemon.listen({ host: '127.0.0.1', port: 0 });
  const daemonAddress = daemon.server.address();
  if (!daemonAddress || typeof daemonAddress === 'string') throw new Error('Missing test daemon TCP address');
  writeDaemonState({ pid: process.pid, httpPort: daemonAddress.port, startedAt: Date.now(),
    startedWithCliVersion: '0.0.0-test', controlToken });
  let credentials: import('@/persistence').StoredCredentials = { token, encryption: null };
  if (source === 'protected child') {
    const custody = await createRequesterSessionCredentialCustody({ happyHomeDir: directory, sessionId: 'admitted-session', attribution, credentials });
    vi.stubEnv(REQUESTER_SESSION_ID_ENV, 'admitted-session');
    vi.stubEnv(REQUESTER_SESSION_CREDENTIAL_FILE_ENV, custody.path);
    const child = await readRequesterSessionCredentialsForChild(custody.path);
    if (!child) throw new Error('Missing exact protected child custody');
    credentials = child;
  } else {
    await writeCredentialsTokenOnly({ token });
    if (source === 'ordinary accepted marker') {
      const identity = await readProcessIdentityByPid(process.pid);
      if (identity?.processStartTimeMs === undefined) throw new Error('Missing actual child process generation');
      await writeSessionMarker({ pid: process.pid, happySessionId: 'admitted-session', happyHomeDir: directory,
        createdAt: Date.now(), updatedAt: Date.now(), startedBy: 'daemon', requesterWorkAttributionV1: attribution,
        processStartTimeMs: identity.processStartTimeMs, processCommandHash: hashProcessCommand(identity.command) });
    }
  }
  expect((await readStoredCredentials())?.token).toBe(token);
  // Ordinary Session startup establishes its current Account before registering
  // Run handlers. Complete that real HTTP bootstrap rather than leaving a fast
  // refresh in flight across this fixture's Account/Home teardown.
  const accountBootstrap = await bootstrapAccountSettingsContext({ credentials, mode: 'blocking', refresh: 'force' });
  if (!accountBootstrap.scopeKey) throw new Error('Missing authenticated fixture Account settings scope');
  const accountLifetime = getActiveAccountSettingsSnapshotLifetimeToken();
  // This direct host fixture skips ordinary Session/daemon startup demand.
  // Observe executable catalog rows through the real captured Account owners
  // before passing that same admitted snapshot to the detached registrar.
  const [acpCatalog, mcpCatalog] = await Promise.all([
    refreshActiveAcpCatalog({ credentials }),
    prepareActiveMcpServerCatalog({ credentials, scopeKey: accountBootstrap.scopeKey, lifetimeToken: accountLifetime }),
  ]);
  expect(acpCatalog, `Observed ACP catalog: ${JSON.stringify(acpCatalog)}`).toMatchObject({ status: 'ready' });
  expect(mcpCatalog, `Observed MCP catalog: ${JSON.stringify(mcpCatalog)}`).toMatchObject({ status: 'ready' });
  const accountSettings = getActiveAccountSettingsSnapshot();
  if (!accountSettings || accountSettings.scopeKey !== accountBootstrap.scopeKey
    || getActiveAccountSettingsSnapshotLifetimeToken() !== accountLifetime) {
    throw new Error('Fixture Account retired during executable catalog admission');
  }
  admittedRuntimeFixture ??= await createAuthoredAdmittedPluginRuntimeFixture({
    controller: pluginReloadController,
    plugins: [{
      manifest: testAgentPlugin.manifest,
      files: {
        'agent-runtime.mjs': `let open, openDetached;
          export function configureUnitOpen(callback, detachedCallback) { open = callback; openDetached = detachedCallback; }
          export function createRuntime() { return { sessions: { open: request => open(request),
            executionRunContextV1: { open: request => openDetached(request) } } }; }`,
        'daemon.mjs': `import * as leaf from './agent-runtime.mjs';
          export function activate(api) {
            api.agents.register('agent', leaf.createRuntime, {
              sessionRunnerFactory: { module: './agent-runtime.mjs', export: 'createRuntime', runtimeApiVersion: 1 },
            });
          }
          export function createActivationUnitModule(open, openDetached) { leaf.configureUnitOpen(open, openDetached); return { activate }; }`,
      },
      // Same actual file-module callback boundary as targetAgents.testkit.ts.
      // The committed module authors registration; only its external SDK leaf is
      // supplied by the test. This does not certify callback byte behavior.
      instantiateCommittedModule(module) {
        const factory = module.createActivationUnitModule;
        if (typeof factory !== 'function') throw new Error('Missing authored SDK fixture boundary');
        const instantiated: unknown = factory((request: AgentSessionOpenRequest) => nativeOpen(request),
          (request: AgentExecutionRunOpenRequest) => nativeDetachedOpen(request));
        if (!instantiated || typeof instantiated !== 'object' || !('activate' in instantiated)) {
          throw new Error('Missing authored Agent activation');
        }
        return instantiated as PluginDaemonModuleNamespace;
      },
    }],
  });
  let resolveNativeOpened!: () => void;
  let rejectNativeStartup!: (error: Error) => void;
  const nativeStartup = new Promise<void>((resolve, reject) => {
    resolveNativeOpened = resolve;
    rejectNativeStartup = reject;
  });
  void nativeStartup.catch(() => undefined);
  let emit: ((event: AgentSessionRuntimeEvent) => void) | undefined;
  nativeOpen.mockImplementation(async (opened) => {
    resolveNativeOpened();
    return {
      watch(next) { emit = next; next({ kind: 'provider-session-id', providerSessionId: 'native-session', sequence: 1, sessionId: opened.sessionId, emittedAtMs: 1 }); return { dispose() {} }; },
      async send(request) {
        emit?.({ kind: 'turn-start', sessionId: opened.sessionId, sequence: 2, emittedAtMs: 2,
          turnId: request.delivery.turnId, startedBy: 'host' });
        return { status: 'admitted' as const };
      },
      async cancel(request) {
        emit?.({ kind: 'turn-cancelled', sessionId: opened.sessionId, sequence: 3, emittedAtMs: 3,
          turnId: request.turnId, cause: request.reason });
        return { status: 'requested' as const, turnId: request.turnId };
      },
      async dispose() {},
    };
  });
  nativeDetachedOpen.mockImplementation(async request => {
    if (request.kind === 'fork') throw new Error('The fixture does not declare detached fork support');
    // A detached Run opens a scope-neutral native conversation, never the
    // Session factory with a fabricated Session id. Keep the SDK's real Run
    // replay, admission, cancellation and terminal projection underneath it.
    let emitConversation: ((event: AgentExecutionRunConversationEventV1) => void) | undefined;
    const runtime = await createExecutionRunHostBackendFromConversationRuntime({ request,
      openConversation: () => ({
        watch(listener) { emitConversation = listener; return { dispose() {} }; },
        async send(input) {
          emitConversation?.({ kind: 'turn-start', turnId: input.delivery.turnId, startedBy: 'host' });
          return { status: 'admitted' as const };
        },
        async cancel(input) {
          emitConversation?.({ kind: 'turn-cancelled', turnId: input.turnId, cause: input.reason });
          return { status: 'requested' as const, turnId: input.turnId };
        },
        async dispose() {},
      }),
    });
    resolveNativeOpened();
    return runtime;
  });
  const session = source === 'admitted Workflow' ? undefined : createTestApiSessionClient(ApiSessionClient, token, createPlainSessionFixture({ id: 'admitted-session',
    metadata: { path: directory, host: 'host', homeDir: directory, happyHomeDir: directory, happyLibDir: directory,
      happyToolsDir: directory, flavor: 'claude', machineId: 'metadata-decoy-machine' },
  }), { metadataAuthority: { kind: 'owner', credentials, readCurrentCredentials: async () => credentials } });
  const rpc = session?.rpcHandlerManager ?? new RpcHandlerManager({ scopePrefix: attribution.machineId, encryptionMode: 'plain' });
  if (!session) {
    registerCapabilitiesHandlers(rpc);
    registerExecutionRunRpcHandlers(rpc, { sessionId: null, cwd: directory, machineId: attribution.machineId,
      runtimeAccountId: accountId, serverId: attribution.serverId, serverUrl: origin, parentProvider: 'claude',
      readPromptCredentials: async () => credentials,
      resolveAccountSettings: () => accountSettings.rawSettings ?? null,
      resolveAccountSettingsSnapshot: () => accountSettings,
      // Detached Runs have no Session transcript transport. The SDK and every
      // host owner remain real; this unused publication port is external I/O.
      sendAcp: async () => undefined,
      onExecutionRunPublicStateUpdated: state => {
        if (state.status !== 'running') rejectNativeStartup(new Error(`Actual Workflow native Run startup: ${JSON.stringify(state)}`));
      },
    });
  }
  let workflowProducer: LiveWorkProducerV1 | undefined;
  const workflowOwners = createLiveWorkProducerGroup(() => workflowProducer ? [workflowProducer] : []);
  const inventory = createManagedActivityInventory({ producers: [createExecutionRunLiveWorkProducer(),
    ...(source === 'admitted Workflow' ? [workflowOwners] : [])] });
  let runId: string | undefined;
  let stopObservingRun: (() => void) | undefined;
  let workflowExecution: Promise<unknown> | undefined;
  let lastMachineFailure: string | undefined;
  let phase = 'admission';
  let completed = false;
  const machineObservations: Array<Readonly<{ method: string; response: unknown }>> = [];
  const summarizeResponse = (method: string, response: unknown): unknown => {
    if (method !== RPC_METHODS.CAPABILITIES_DETECT || !response || typeof response !== 'object'
      || !('results' in response) || !response.results || typeof response.results !== 'object'
      || !('tool.executionRuns' in response.results)) return response;
    const tool = response.results['tool.executionRuns'];
    if (!tool || typeof tool !== 'object' || !('data' in tool) || !tool.data || typeof tool.data !== 'object') return tool;
    return { ...tool, data: Object.fromEntries(Object.entries(tool.data).filter(([key]) => key !== 'backends')) };
  };
  const workflowAbort = new AbortController();
  onTestFinished(async () => {
    if (completed) return;
    let nativeRun: unknown = null;
    try {
      if (runId) {
        const raw = await rpc.invokeLocal(SESSION_RPC_METHODS.EXECUTION_RUN_GET,
          { runId }, { verifiedPeerAuthority: 'present_user' });
        const parsed = ExecutionRunGetResponseSchema.safeParse(raw);
        nativeRun = parsed.success ? { runId: parsed.data.run.runId, status: parsed.data.run.status,
          error: parsed.data.run.error, inputTurns: parsed.data.run.inputTurns } : raw;
      }
    } catch (error) { nativeRun = { readFailure: error instanceof Error ? error.message : String(error) }; }
    console.error('Actual requester Run fixture failure phase', JSON.stringify({ source, phase, nativeRun,
      machineObservations, workflowState: workflowStorage?.run().state, lastMachineFailure }));
  });
  try {
    if (source === 'admitted Workflow') {
      // Detached dispatch must observe the selected daemon's actual V2 owner.
      // Surface that genuine prerequisite before the Action adapter deliberately
      // classifies unavailable transport as execution_run_target_unavailable.
      const capabilities = await rpc.invokeLocal(RPC_METHODS.CAPABILITIES_DETECT,
        { requests: [{ id: 'tool.executionRuns' }] });
      expect(capabilities, `Actual Workflow daemon capabilities: ${JSON.stringify(capabilities)}`)
        .toMatchObject({ results: { 'tool.executionRuns': { ok: true, data: {
          protocolVersion: 2, features: { detachedScope: true, exactInputResults: true, runScopedAgentBindings: true },
        } } } });
      const runtime = createProductionDaemonWorkflowRuntime({ credentials, accountId, serverId: attribution.serverId });
      const coordinate = runtime.createCoordinatorForMachine({ machineId: attribution.machineId,
        requesterWorkAttributionV1: attribution,
        machineAdmissionTransport: async () => { throw new Error('Detached Run must not spawn a Session'); },
        machineActionDirectTargetTransport: { machineId: attribution.machineId, invoke: async (method, request, options) => {
          try {
            const result = await rpc.invokeLocal(method, request, options);
            machineObservations.push({ method, response: summarizeResponse(method, result) });
            if (method === SESSION_RPC_METHODS.EXECUTION_RUN_START) {
              expect(result, `Actual Workflow Run admission: ${JSON.stringify(result)}`).toMatchObject({ runId: expect.any(String) });
              runId = ExecutionRunStartResponseSchema.parse(result).runId;
            }
            return result;
          } catch (error) {
            lastMachineFailure = `${method}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`;
            throw error;
          }
        } },
      });
      workflowExecution = coordinate({ runId: workflowRunId, attempt: 0, expectedRevision: 0, acceptedEnvelope,
        accountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null }, signal: workflowAbort.signal,
        registerLiveWorkProducer(producer) {
          workflowProducer = producer; workflowOwners.notifyChanged();
          return () => { workflowProducer = undefined; workflowOwners.notifyChanged(); };
        },
      });
      void workflowExecution.then(async outcome => {
        // START admission precedes asynchronous SDK provisioning. On a failed
        // observation, read the real public Run rather than infer no native Run
        // from the Workflow's terminal outcome or the callback's timing.
        const nativeResponse = runId ? await rpc.invokeLocal(SESSION_RPC_METHODS.EXECUTION_RUN_GET,
          { runId }, { verifiedPeerAuthority: 'present_user' }) : null;
        const parsedNative = ExecutionRunGetResponseSchema.safeParse(nativeResponse);
        const nativeRun = parsedNative.success ? { runId: parsedNative.data.run.runId,
          status: parsedNative.data.run.status, error: parsedNative.data.run.error,
          inputTurns: parsedNative.data.run.inputTurns } : nativeResponse;
        rejectNativeStartup(new Error(`Actual Workflow completed before native startup: ${JSON.stringify({ outcome,
          nativeRun, machineObservations, workflow: { state: workflowStorage!.run().state,
            rows: workflowStorage!.rows().map(row => ({ lifecycle: row.index.lifecycle, contentEnvelope: row.contentEnvelope })) },
        })}${lastMachineFailure ? `; ${lastMachineFailure}` : ''}`));
      }, rejectNativeStartup).catch(rejectNativeStartup);
    } else {
      const raw = await rpc.invokeLocal(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
        sessionId: 'admitted-session', intent: 'delegate', backendTarget: { kind: 'agent', identity: testAgentIdentity },
        instructions: 'Inspect.', permissionMode: 'read_only', retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response',
        requesterWorkAttributionV1: { ...attribution, accountId: 'alice', machineId: 'authored-decoy-machine' },
      }, { verifiedPeerAuthority: 'present_user' });
      expect(raw, `Actual Session Run admission: ${JSON.stringify(raw)}`).toMatchObject({
        runId: expect.any(String), callId: expect.any(String), sidechainId: expect.any(String),
      });
      const started = ExecutionRunStartResponseSchema.parse(raw);
      runId = started.runId;
      // The local Session observer sees real host updates even while Socket.IO
      // is disconnected. Read the public Run owner on those edges, including its
      // immediate snapshot, so failed provisioning cannot hide behind a wire gate.
      stopObservingRun = session!.subscribeExecutionRunActivitySnapshots(() => {
        void rpc.invokeLocal(SESSION_RPC_METHODS.EXECUTION_RUN_GET,
          { runId: started.runId }, { verifiedPeerAuthority: 'present_user' }).then(rawRun => {
          const observed = ExecutionRunGetResponseSchema.parse(rawRun);
          if (observed.run.status !== 'running') {
            rejectNativeStartup(new Error(`Actual native Run startup: ${JSON.stringify(observed)}`));
          }
        }).catch(rejectNativeStartup);
      });
    }
    phase = 'native_startup';
    await nativeStartup;
    stopObservingRun?.(); stopObservingRun = undefined;
    phase = 'inventory_observation';
    const observed = await vi.waitFor(async () => {
      expect(runId).toEqual(expect.any(String));
      const publicState = ExecutionRunGetResponseSchema.parse(await rpc.invokeLocal(
        SESSION_RPC_METHODS.EXECUTION_RUN_GET, { runId }, { verifiedPeerAuthority: 'present_user' }));
      expect(publicState.run.status).toBe('running');
      const snapshot = await inventory.read();
      expect(snapshot.coverage).toBe('complete');
      if (source === 'admitted Workflow') {
        expect(snapshot.items.filter(item => item.category === 'execution_run')).toHaveLength(1);
        expect(snapshot.items.filter(item => item.category === 'workflow_run')).toHaveLength(1);
      }
      return snapshot;
    });
    phase = 'attribution_assertion';
    expect(observed).toEqual({ coverage: 'complete', items: [
      { category: 'execution_run', ownerRef: runId,
        attribution: source === 'legacy metadata only' ? { kind: 'unknown' } : attribution, state: 'active' },
      ...(source === 'admitted Workflow' ? [{ category: 'workflow_run', ownerRef: workflowRunId, attribution, state: 'active' }] : []),
    ] });
    expect(projectMachineWorkSummary({ inventory: observed, target: attribution, custodianAccountId: 'alice',
      requesterIdentities: new Map([['bob', { accountId: 'bob', displayName: 'Bob' }]]) }))
      .toEqual(source === 'legacy metadata only' ? { kind: 'unavailable' }
        : { kind: 'current', requesters: source === 'ordinary accepted marker' ? []
          : [{ accountId: 'bob', displayName: 'Bob', sessions: 0, tasks: source === 'admitted Workflow' ? 2 : 1, terminals: 0 }] });
  } finally {
    stopObservingRun?.();
    try {
      if (runId) {
        phase = 'cleanup_run_stop';
        await rpc.invokeLocal(SESSION_RPC_METHODS.EXECUTION_RUN_STOP,
          { runId }, { verifiedPeerAuthority: 'present_user' });
        phase = 'cleanup_run_wait';
        await rpc.invokeLocal(SESSION_RPC_METHODS.EXECUTION_RUN_WAIT,
          { runId }, { verifiedPeerAuthority: 'present_user' });
      }
    } finally {
      workflowAbort.abort();
      phase = 'cleanup_workflow';
      await workflowExecution?.catch(() => undefined);
      inventory.dispose();
      workflowOwners.dispose();
      phase = 'cleanup_session';
      await session?.close();
      completed = true;
    }
  }
}
