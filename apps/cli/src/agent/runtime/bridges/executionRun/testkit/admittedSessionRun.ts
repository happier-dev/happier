import { afterEach, beforeEach, expect, onTestFinished, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { mkdir, readFile } from 'node:fs/promises';
import fastify, { type FastifyInstance } from 'fastify';
import { Server as SocketIoServer } from 'socket.io';
import { createSessionRuntimeActivityHomeStub, createSessionTranscriptHomeStub } from '@/testkit/backends/apiSessionSocketHarness';
import { configuration, reloadConfiguration } from '@/configuration';
import { ApiSessionClient } from '@/api/session/sessionClient';
import { createTestApiSessionClient } from '@/testkit/backends/createTestApiSessionClient';
import { createPlainSessionFixture } from '@/testkit/backends/sessionFixtures';
import { createRequesterSessionCredentialCustody, readRequesterSessionCredentialsForChild, REQUESTER_SESSION_CREDENTIAL_FILE_ENV, REQUESTER_SESSION_ID_ENV } from '@/daemon/sessionEncryption/requesterSessionCredentials';
import { createExecutionRunLiveWorkProducer } from '@/daemon/executionRunRegistry';
import { createLiveWorkProducerGroup, createManagedActivityInventory, type LiveWorkProducerV1 } from '@/daemon/lifecycle/managedActivity';
import { projectMachineWorkSummary } from '@/daemon/machines/machineWorkSummary';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { CURRENT_PENDING_INPUT_PROTOCOL_VERSION, SESSION_SYNC_PROTOCOL_VERSION_RUNTIME_ACTIVITY } from '@happier-dev/protocol/clientCompatibility/primitives';
import { ExecutionRunGetResponseSchema, ExecutionRunStartResponseSchema, FeaturesResponseSchema, WorkflowAcceptedSnapshotV1Schema,
  openWorkflowAcceptedSnapshotStoredEnvelopeV1, sealWorkflowAcceptedSnapshotStoredEnvelopeV1, type HookEventEnvelopeV1 } from '@happier-dev/protocol';
import { AccountEncryptionModeResponseSchema, AccountEncryptionCurrentnessResponseSchema } from '@happier-dev/protocol/account/encryptionMode';
import { AccountProfileResponseSchema } from '@happier-dev/protocol/account/profile';
import { ChangesResponseSchema } from '@happier-dev/protocol/changes';
import { PluginAccountSettingsReadResponseV1Schema } from '@happier-dev/protocol/plugins/settings/accountSettingsV1';
import { PROMPT_LIBRARY_ROWS_ROUTE_V1, PromptLibraryRowsListResponseV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { ACP_CATALOG_ROWS_ROUTE_V1, AcpCatalogRecordV1Schema, AcpCatalogRowReadResponseV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { MCP_SERVER_CATALOG_ROWS_ROUTE_V1, McpServerCatalogRowReadResponseV1Schema } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import type { PluginDaemonModuleNamespace } from '@/plugins/runtime/types';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { writeSessionMarker, hashProcessCommand, updateSessionMarkerAgentRuntimeDaemonServiceAuthorityPath } from '@/daemon/sessionRegistry';
import * as processIdentity from '@/daemon/processIdentity';
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
import type { ExecutionRunManagerStartParams } from '../executionRunTypes';
import { createExecutionRunHostBackendFromConversationRuntime } from '@happier-dev/plugin-sdk/agents/runtime';
import type { AgentExecutionRunOpenRequest, AgentExecutionRunRuntime, AgentExecutionRunConversationEventV1,
  AgentExecutionRunConversationRuntimeV1,
  AgentSessionOpenRequest, AgentSessionRuntime, AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import { createProductionDaemonWorkflowRuntime } from '@/daemon/workflows/daemonRuntime';
import { createWorkflowRunStorageTestkit, type WorkflowRunStorageTestkitOperation } from '@/daemon/workflows/workflowRunStorage.testkit';
import { registerExecutionRunRpcHandlers } from '@/rpc/handlers/executionRuns/registerExecutionRunRpcHandlers';
import { registerCapabilitiesHandlers } from '@/rpc/handlers/capabilities';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { createSkillStore } from '@/prompts/skills/store/skillStore';
import { captureSessionLaunchControlMetadata, createSessionMetadata } from '@/agent/runtime/createSessionMetadata';
import { emptyPromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { PromptLibraryCatalogKeyV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createRunnerExecutionRunSnapshots } from '@/daemon/agentRuntime/runnerExecutionRunSnapshots';
import { createRunnerDaemonPluginServicesHost, type RunnerDaemonCurrentGlobalActionExecutor } from '@/daemon/agentRuntime/runnerDaemonPluginServicesHost';
import { authorizeTrackedRunnerAgentDaemonServiceOperation } from '@/daemon/agentRuntime/authorizeTrackedRunnerAgentDaemonServiceOperation';
import { createAgentRuntimeDaemonServiceAuthorityPath, publishAgentRuntimeDaemonServiceAuthority,
  HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY } from '@/daemon/agentRuntime/sessionBridgeAuthorization';
import type { TrackedSession } from '@/daemon/types';
import { readBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { resolveRunnerAgentSessionDescriptorForLease } from '@/daemon/spawn/prepareAgentRuntimeSessionBridge';
import { RunnerDaemonPluginServiceOperationV1Schema } from '@/agent/runtime/session/process/agentRuntimeDaemonPluginServicesProtocol';
import { indexAgentRoutingIdsByContributionIdentity, readAgentRoutingIdForContributionIdentity } from '@/plugins/projection/registry/agentRoutingIdentity';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1, ProjectAccountRowListResponseV1Schema } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { dispatchPluginHookEvent } from '@/plugins/runtime/hooks/execution/dispatchPluginHookEvent';
import { resolveAgentCompositionThroughRuntimeRegistry, resolvePluginToolPromptContributionsThroughRuntimeRegistry,
  transformAgentRequestThroughRuntimeRegistry } from '@/plugins/runtime/hooks/execution/dispatchAgentTurnHooks';
import { AgentRuntimeDaemonTurnContributionsResultV1Schema } from '@/agent/runtime/session/process/agentRuntimeRunnerProtocol';
import { createProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/createHandler';
import { createInitialHostRuntimeActivityMutation } from '@/agent/runtime/session/activity/createHostRuntimeActivityProjection';
import { ExecutionRunHostBridge } from '../ExecutionRunHostBridge';
import { createRunnerExecutionRunSnapshotResolver } from '@/agent/runtime/session/process/runnerExecutionRunSnapshot';
import { createExecutionRunTranscriptCustodyError } from '../executionRunTranscriptPublisher';
import { randomUUID } from 'node:crypto';
import { recordTrackedRunnerAgentSessionOpenAttestation } from '@/daemon/agentRuntime/runnerAgentSessionOpenAttestation';
import { prepareProjectAgentLaunch } from '@/workspaces/projectSetup/projectAgentLaunch';
import { resolveCliVoicePromptPreparation } from '@/agent/prompts/library/resolveCliVoicePromptStackBlocks';
import type { HostAgentNativeLaunchPreparation } from '@/plugins/runtime/invocation/services/exec';
import { createSessionRunReportPolicyReader } from '@/api/sessionFollowCreationPreferences';
import { SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1 } from '@happier-dev/protocol/sessions/messages/transcriptObservationV1';

// This is a host attribution contract, not Claude codec/process certification.
// An authored public-SDK Agent supplies the external sessions.open/send behavior;
// source admission, activation, registry, Run factory and host context stay real.

const nativeOpen = vi.fn<(request: AgentSessionOpenRequest) => Promise<AgentSessionRuntime>>();
const nativeDetachedOpen = vi.fn<(request: AgentExecutionRunOpenRequest) => Promise<AgentExecutionRunRuntime>>();
const nativeConversationOpen = vi.fn<(request: AgentExecutionRunOpenRequest) => Promise<AgentExecutionRunConversationRuntimeV1>>();
type AdmittedSessionRunOptions = Readonly<{
  resume?: boolean;
  profile?: boolean;
  directOwner?: boolean;
  runReportPolicy?: import('@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1').FollowPolicyV1;
  runReportPreferencesUnavailable?: boolean;
  beforeRunReportPreferencesRead?: () => Promise<void>;
  beforeTranscriptAck?: () => Promise<void>;
  runtimePluginIds?: readonly string[];
  acpCatalog?(directory: string): ReturnType<typeof AcpCatalogRecordV1Schema.parse>;
  run(fixture: AdmittedSessionRunFixture): Promise<void>;
}>;

export type AdmittedSessionRunFixture = Readonly<{
  rpc: RpcHandlerManager;
  session: ApiSessionClient;
  trackedSessions: readonly TrackedSession[];
  directory: string;
  agentIdentity: Readonly<{ pluginId: string; localId: string }>;
  nativeOpen: typeof nativeOpen;
  bridge?: ExecutionRunHostBridge;
  lifecycleEvents: readonly HookEventEnvelopeV1[];
  activationDisposals: readonly string[];
  admittedRuntime: Awaited<ReturnType<typeof createAuthoredAdmittedPluginRuntimeFixture>>;
  replaceAgent(options: Readonly<{ profile?: boolean; resume?: boolean }>): Promise<void>;
  start(input?: Partial<ExecutionRunManagerStartParams>): Promise<ReturnType<typeof ExecutionRunStartResponseSchema.parse>>;
}>;

const createTestAgentPlugin = (skills: boolean, options?: AdmittedSessionRunOptions) => definePlugin({
  id: skills ? 'test.skills.own-set' : 'test.c42.attribution', version: '0.0.0', displayName: 'Attribution test Agent',
  entrypoints: { daemon: './daemon.mjs' },
  ...(options?.profile ? {
    executionRunProfiles: { memory: { id: 'memory', intent: 'memory_hints', title: 'Admitted memory policy',
      promptAsset: 'memory-prompt', compatibleAgents: ['agent'],
      defaults: { retention: 'ephemeral', runClass: 'bounded', io: 'streaming' } } },
    resources: { 'memory-prompt-resource': { kind: 'prompt', path: './resources/memory.md', contentType: 'text/markdown' } },
    promptAssets: { 'memory-prompt': { kind: 'systemPrompt', resource: 'memory-prompt-resource', target: { kind: 'agent', agent: 'agent' } } },
  } as const : {}),
  agents: {
    agent: {
      declaration: { title: 'Attribution test Agent', runtime: { kind: 'custom' }, primary: 'sessions',
        capabilities: { sessions: { open: options?.resume ? ['create', 'resume'] : ['create'], delivery: ['newTurn'], cancel: true,
          // This external SDK leaf emits observations only; it has no workspace effects.
          workspaceWrites: 'deny',
          executionRunContext: { versions: [1] } }, skills: {
            delivery: skills ? 'session_dir' : 'none', nativeDisable: 'unsupported', liveReload: 'unsupported',
          } } },
      factory: () => ({ sessions: { open: request => nativeOpen(request),
        executionRunContextV1: { open: request => nativeDetachedOpen(request), openConversation: request => nativeConversationOpen(request) } } }),
      sessionRunnerFactory: { module: './agent-runtime.mjs', export: 'createRuntime', runtimeApiVersion: 1 },
    },
  },
});
const testAgentPlugin = createTestAgentPlugin(false);
const skillsAgentPlugin = createTestAgentPlugin(true);
const testAgentIdentity = { pluginId: testAgentPlugin.manifest.id, localId: 'agent' };
let directory: string;
let admittedRuntimeFixture: Awaited<ReturnType<typeof createAuthoredAdmittedPluginRuntimeFixture>> | undefined;
let home: FastifyInstance | undefined;
let socketHome: SocketIoServer | undefined;
let daemon: FastifyInstance | undefined;
let restoreHttp: (() => void) | undefined;
let pluginChanges: ReturnType<typeof createDaemonPluginChangeService> | undefined;
let skillStore: ReturnType<typeof createSkillStore> | undefined;
let runnerSnapshots: ReturnType<typeof createRunnerExecutionRunSnapshots> | undefined;
let runnerServices: ReturnType<typeof createRunnerDaemonPluginServicesHost> | undefined;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'happier-run-attribution-'));
  vi.stubEnv('HAPPIER_HOME_DIR', directory);
  reloadConfiguration();
});
afterEach(async () => {
  vi.restoreAllMocks();
  nativeOpen.mockReset();
  nativeDetachedOpen.mockReset();
  nativeConversationOpen.mockReset();
  restoreHttp?.(); restoreHttp = undefined;
  if (socketHome) await new Promise<void>(resolve => socketHome!.close(() => resolve()));
  socketHome = undefined;
  await home?.close(); home = undefined;
  await daemon?.close(); daemon = undefined;
  await runnerServices?.dispose(); runnerServices = undefined;
  await runnerSnapshots?.dispose(); runnerSnapshots = undefined;
  await admittedRuntimeFixture?.dispose(); admittedRuntimeFixture = undefined;
  await pluginChanges?.shutdown(); pluginChanges = undefined;
  await skillStore?.releaseSkillSessionDirs('admitted-session');
  await skillStore?.collectSkillCache({ libraryDigests: [] });
  skillStore = undefined;
  vi.unstubAllEnvs();
  reloadConfiguration();
  rmSync(directory, { recursive: true, force: true });
});

export async function withAdmittedSessionRun(options: AdmittedSessionRunOptions): Promise<void> {
  await runRequesterAttributionCase('ordinary accepted marker', false, options);
}

export async function runRequesterAttributionCase(source: 'protected child' | 'ordinary accepted marker' | 'legacy metadata only' | 'admitted Workflow', skillsScenario = false, options?: AdmittedSessionRunOptions) {
  vi.stubEnv('HAPPIER_FEATURE_EXECUTION_RUNS__ENABLED', '1');
  home = fastify();
  await new Promise<void>(resolve => home!.server.listen(0, '127.0.0.1', resolve));
  const homeAddress = home.server.address();
  if (!homeAddress || typeof homeAddress === 'string') throw new Error('Missing composed Home address');
  const origin = `http://127.0.0.1:${homeAddress.port}`;
  vi.stubEnv('HAPPIER_SERVER_URL', origin);
  reloadConfiguration();
  const accountId = source === 'ordinary accepted marker' ? 'alice' : 'bob';
  // A released terminal-session credential is what ordinary CLI sign-in stores;
  // sub-only legacy Account bearers are intentionally invalidated by its reader.
  const token = `header.${Buffer.from(JSON.stringify({ sub: accountId, session: 'run-attribution-terminal' })).toString('base64url')}.signature`;
  const attribution = { serverId: configuration.activeServerId, accountId, machineId: 'admitted-machine', installationId: 'admitted-installation' };
  const agentPlugin = options ? createTestAgentPlugin(skillsScenario, options) : skillsScenario ? skillsAgentPlugin : testAgentPlugin;
  const agentIdentity = { pluginId: agentPlugin.manifest.id, localId: 'agent' };
  // Vitest is not a Session runner. Substitute only that OS observation while
  // retaining its real PID and process generation for authority and markers.
  const actualIdentity = await processIdentity.readProcessIdentityByPid(process.pid);
  if (actualIdentity?.processStartTimeMs === undefined) throw new Error('Missing actual fixture process generation');
  const command = 'node /runtime/.runner-snapshots/requester-attribution/dist/index.mjs';
  vi.spyOn(processIdentity, 'readProcessIdentityByPid').mockResolvedValue({ ...actualIdentity, command });
  const runDirectory = skillsScenario ? join(directory, 'child-workspace') : directory;
  if (skillsScenario) await mkdir(runDirectory);
  const artifacts = ['parent', 'child'].map(name => ({ id: `skill-${name}`, ownerAccountId: accountId,
    access: 'owner', publicAudience: 'none', encryptionMode: 'plain',
    header: encodePlainArtifactStoredContent({ v: 1, kind: 'prompt_bundle.v2', title: name, bundleSchemaId: 'skills.skill_md_v1' }),
    body: encodePlainArtifactStoredContent({ body: JSON.stringify({ v: 1, createdAtMs: 1, updatedAtMs: 1, entries: [
      { path: 'SKILL.md', contentKind: 'utf8', contentBase64: Buffer.from(`---\nname: ${name}\ndescription: ${name} only\n---\nPrivate body`).toString('base64') },
      { path: 'references/note.md', contentKind: 'utf8', contentBase64: Buffer.from(`${name} supporting file`).toString('base64') },
    ] }) }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 }));
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
  const lifecycleEvents: HookEventEnvelopeV1[] = [];
  const activationDisposals: string[] = [];
  const activityHome = createSessionRuntimeActivityHomeStub({ machineId: attribution.machineId });
  const transcriptHome = createSessionTranscriptHomeStub();
  socketHome = new SocketIoServer(home.server, { path: '/v1/updates/' });
  socketHome.use((socket, next) => next(socket.handshake.auth.token === token ? undefined : new Error('Unauthorized fixture socket')));
  socketHome.on('connection', socket => {
    socket.onAny(async (event: string, ...args: unknown[]) => {
      if (event === SOCKET_RPC_EVENTS.REGISTER) {
        const registration = args[0];
        if (registration && typeof registration === 'object' && 'method' in registration
          && typeof registration.method === 'string'
          && registration.method.startsWith('admitted-session:')) {
          socket.emit(SOCKET_RPC_EVENTS.REGISTERED, { method: registration.method });
        }
        return;
      }
      const callback = args.at(-1);
      const answer = activityHome.answer(event, args[0]) ?? transcriptHome.answer(event, args[0]);
      if (event === SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1) await options?.beforeTranscriptAck?.();
      if (answer !== null && typeof callback === 'function') callback(answer);
    });
  });
  home.addHook('preHandler', async (request, reply) => {
    if (request.url === '/v1/features') return;
    if (request.headers.authorization !== `Bearer ${token}`) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
  });
  const features = FeaturesResponseSchema.parse({ features: { execution: { enabled: true, runs: { enabled: true } } },
    capabilities: { session: { runtimeActivity: { protocolVersion: SESSION_SYNC_PROTOCOL_VERSION_RUNTIME_ACTIVITY },
      pendingInput: { protocolVersion: CURRENT_PENDING_INPUT_PROTOCOL_VERSION },
      publisherAuthority: { protocolVersion: 1 } } },
  });
  home.get('/v1/features', async () => features);
  home.get('/v1/features/authenticated', async () => features);
  home.get('/v1/account/profile', async () => AccountProfileResponseSchema.parse({ id: accountId }));
  // This owned Session starts with no queued inputs. Child input enters through
  // the real Run RPC, not a fabricated pending row or provider admission.
  home.get('/v2/sessions/admitted-session/pending', async () => ({ pending: [], pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 0 }));
  home.get<{ Querystring: { sessionAccessSessionId?: string } }>('/v2/changes', async (request, reply) => {
    const sessionId = request.query.sessionAccessSessionId;
    if (sessionId && sessionId !== 'admitted-session') return reply.code(404).send({ error: 'session-not-found' });
    return ChangesResponseSchema.parse({ changes: [], nextCursor: 0,
      ...(sessionId ? { sessionAccessProbe: { v: 1, sessionId, throughCursor: 0, status: 'available' } } : {}),
    });
  });
  home.get('/v2/account/settings', async () => ({ content: { t: 'plain', v: {} }, version: 1 }));
  home.get('/v2/account/session-follow-preferences', async (_request, reply) => {
    await options?.beforeRunReportPreferencesRead?.();
    return options?.runReportPreferencesUnavailable
      ? reply.code(503).send({ error: 'preferences_unavailable' })
      : { assigned: true, direct: false, team: false, group: false,
        managerPolicy: { preset: 'important' }, runReportPolicy: options?.runReportPolicy ?? { preset: 'important' },
        discussionReceivePolicy: { preset: 'important' } };
  });
  home.get('/v1/account/plugin-settings/:pluginId', async () =>
    PluginAccountSettingsReadResponseV1Schema.parse({ status: 'absent' }));
  home.get('/v1/account/encryption', async () =>
    AccountEncryptionModeResponseSchema.parse({ mode: 'plain', updatedAt: 1 }));
  // Every executable catalog row admits the persisted Account mode/currentness,
  // including ordinary Session startup, before opening its plain content.
  home.get('/v1/account/encryption/currentness', async () => AccountEncryptionCurrentnessResponseSchema.parse({
    mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
  }));
  // The ordinary Account transport connects with its exact local Machine's
  // control binding. This opaque control key is separate from E2EE material.
  home.get('/v1/access-keys/admitted-session/admitted-machine', async () => ({
    accessKey: { id: 'admitted-session-machine-control' },
  }));
  // Independent executable catalogs are observed through their Account row
  // owners, not inferred from the empty legacy Settings object or Agent id.
  const acpRecord = options?.acpCatalog?.(directory) ?? { v: 1, definitions: [] };
  home.get(ACP_CATALOG_ROWS_ROUTE_V1, async () => AcpCatalogRowReadResponseV1Schema.parse({
    status: 'present', revision: 1, content: { t: 'plain', v: acpRecord },
  }));
  home.get(MCP_SERVER_CATALOG_ROWS_ROUTE_V1, async () => McpServerCatalogRowReadResponseV1Schema.parse({
    status: 'present', revision: 1, content: { t: 'plain', v: { v: 1, servers: [], bindings: [] } },
  }));
  // This Account has no Project association. Skills must observe that actual
  // Home response rather than treating an unsupported Project route as empty.
  const projectRows = ProjectAccountRowListResponseV1Schema.parse({ status: 'listed', rows: [], coverage: 'complete' });
  home.post(`${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`, async () => projectRows);
  {
    // Fresh host Agent-start admission reads real Account Role sources and
    // their canonical private catalog before supplying the child context.
    home.get('/v1/artifacts', async () => skillsScenario ? artifacts : []);
    if (skillsScenario) home.get<{ Params: { id: string } }>('/v1/artifacts/:id', async request =>
      artifacts.find(artifact => artifact.id === request.params.id));
    home.get(PROMPT_LIBRARY_ROWS_ROUTE_V1, async () => PromptLibraryRowsListResponseV1Schema.parse({
      status: 'listed', rows: skillsScenario ? PromptLibraryCatalogKeyV1Schema.options.map(key => ({ key, revision: 1,
        content: { t: 'plain', v: key === 'skill-rules' ? { key, value: { v: 1, rules: [
          { id: 'parent', skillId: 'skill-parent', target: { t: 'allMachines' }, agentId: 'claude', enabled: true, createdAt: 1, updatedAt: 1 },
          { id: 'child', skillId: 'skill-child', target: { t: 'workspace', machineId: attribution.machineId, workspaceRoot: runDirectory },
            agentId: `${agentIdentity.pluginId}/${agentIdentity.localId}`, enabled: true, createdAt: 1, updatedAt: 1 },
        ] } } : emptyPromptLibraryRecordV1(key) } })) : [{ key: 'role-overrides', revision: 1,
        content: { t: 'plain', v: { key: 'role-overrides', value: { v: 1, overrides: {} } } } }],
    }));
    if (workflowStorage) home.post<{ Body: WorkflowRunStorageTestkitOperation }>('/v3/automations/runs/workflow-storage', async request =>
      await workflowStorage.execute(request.body));
  }
  await home.ready();
  restoreHttp = installAxiosFastifyAdapter({ app: home, origin });
  // Run admission uses the real local daemon HTTP owner and scoped capability.
  // Child process spawning is an OS boundary unused by this Session-owned Run.
  const controlToken = 'run-attribution-test-control';
  pluginChanges = createDaemonPluginChangeService({
    prepare: async () => { throw new Error('Unexpected plugin installation'); },
  });
  skillStore = skillsScenario ? createSkillStore({ happyHomeDir: directory }) : undefined;
  const tracked: TrackedSession[] = [];
  runnerSnapshots = createRunnerExecutionRunSnapshots({ machineId: attribution.machineId, controller: pluginReloadController });
  const snapshots = runnerSnapshots;
  runnerServices = createRunnerDaemonPluginServicesHost({ createInvocation: async input => {
    const parent = tracked.find(session => session.happySessionId === input.sessionId);
    const retained = input.executionRunSnapshotId && input.runnerRetainedAgent
      ? snapshots.read(input.executionRunSnapshotId, { sessionId: input.sessionId,
        runner: input.runner, retainedAgent: input.runnerRetainedAgent }) : null;
    if (!parent || !retained || !input.executionRunCwd
      || !isDeepStrictEqual(retained.projection.agent?.binding, input.retainedAgent)) {
      throw new Error('Missing retained Run service custody');
    }
    const authorizeOperation = (witness: Parameters<typeof authorizeTrackedRunnerAgentDaemonServiceOperation>[0]['witness']) =>
      snapshots.read(input.executionRunSnapshotId!, { sessionId: input.sessionId, runner: input.runner,
        retainedAgent: input.runnerRetainedAgent! }) === retained
      && authorizeTrackedRunnerAgentDaemonServiceOperation({ tracked: parent, sessionId: input.sessionId,
        runner: input.runner, retainedAgent: input.runnerRetainedAgent!, witness, allowIdleCurrentGeneration: true });
    const registry = retained.snapshot.runtimeRegistry;
    const createServices = registry.createRetainedRunnerAgentInvocationServices;
    if (!createServices || !authorizeOperation(undefined)) throw new Error('Missing exact Run invocation authority');
    const projection = await createServices({ binding: input.retainedAgent, runnerSnapshotIdentity: input.runner.snapshotIdentity,
      sessionId: input.sessionId, correlationId: input.invocationId, cwd: input.executionRunCwd,
      environment: {}, providerBindingActive: false, signal: input.signal,
      isOccurrenceCurrent: () => authorizeOperation(undefined) });
    // The real Actions service validates action-specific input at this wire boundary.
    const executeAction = projection.services.actions.execute as (
      action: Parameters<RunnerDaemonCurrentGlobalActionExecutor>[0], value: unknown,
      options: Parameters<RunnerDaemonCurrentGlobalActionExecutor>[2],
    ) => Promise<unknown>;
    // This Home has no accepted Project rows. Resolve that fact through the
    // real launch owner before the real Exec host admits the ACP subprocess.
    const prepareAgentNativeLaunch: HostAgentNativeLaunchPreparation = async (signal, _cwd, environment) => {
        const prepared = await prepareProjectAgentLaunch({ cwd: input.executionRunCwd!,
          machineId: attribution.machineId, serverId: attribution.serverId, serverHttpBaseUrl: origin,
          account: { credentials, sessionCustody: { serverId: attribution.serverId, accountId,
            serverHttpBaseUrl: origin, isCurrent: async () => authorizeOperation(undefined) } }, signal,
          ...(environment ? { configEnvironment: environment } : {}) });
        expect(prepared).toEqual({ kind: 'notAssociated' });
        return undefined;
    };
    return { ...projection, authorizeOperation, dispose() {}, prepareAgentNativeLaunch,
      executeCurrentGlobalAction: (action, value, options) => executeAction(action, value, options),
      currentGlobalMcp: projection.services.mcp, currentGlobalExternalSessions: projection.services.sessions.external };
  } });
  const services = runnerServices;
  daemon = createDaemonControlApp({
    ...(skillStore ? { skillStore } : {}),
    getChildren: () => tracked, machineId: 'admitted-machine', controlToken,
    agentRuntimeDaemonServices: { dispatch: async (request, context) => {
      if (request.operation.kind === 'session.open.attest') {
        const tracked = context.trackedSession;
        const attestation = tracked && await recordTrackedRunnerAgentSessionOpenAttestation({ tracked,
          retainedAgent: context.retainedAgent, runner: context.runner, phase: request.operation.phase,
          request: request.operation.request, providerSessionId: request.operation.providerSessionId });
        if (!attestation) throw new Error('The exact runner Session-open attestation was refused');
        return { ok: true as const, result: { kind: 'session.open.attestation' as const,
          status: request.operation.phase === 'prepare' ? 'accepted' as const : 'recorded' as const } };
      }
      if (request.operation.kind === 'turn_contributions.resolve') {
        const retained = request.context.executionRunSnapshotId
          ? snapshots.read(request.context.executionRunSnapshotId, context) : null;
        if (!await context.isCurrent()) throw new Error('The fixture runner is no longer current');
        const lease = retained?.snapshot.runtimeRegistryLease
          ?? await acquireAuthoritativePluginRuntimeRegistryLease({ controller: pluginReloadController });
        const operation = request.operation.request;
        const agentId = retained?.projection.agent?.descriptor.agentId ?? context.retainedAgent.agentId;
        if (operation.kind === 'lifecycleHook') lifecycleEvents.push(operation.event);
        try {
          if (operation.kind === 'transformAgentRequest') {
            const payload = await transformAgentRequestThroughRuntimeRegistry(lease.registry, {
              ...operation.payload, sessionId: context.sessionId, agentId,
              runtimeFamily: 'acpSession', method: 'session/prompt', timestampMs: Date.now(),
            }, context.signal ? { signal: context.signal } : undefined);
            return { ok: true as const, result: { kind: 'turn_contributions' as const, status: 'resolved' as const,
              contributions: AgentRuntimeDaemonTurnContributionsResultV1Schema.parse({ kind: operation.kind, payload }) } };
          }
          const contributions = operation.kind === 'lifecycleHook'
            ? { kind: 'lifecycleHook' as const, result: await dispatchPluginHookEvent({ runtimeRegistry: lease.registry, event: operation.event }) }
            : operation.kind === 'composition'
              ? { kind: 'composition' as const, ...await resolveAgentCompositionThroughRuntimeRegistry(lease.registry, {
                sessionId: context.sessionId, agentId, runtimeFamily: operation.runtimeFamily,
                ...(operation.machineId ? { machineId: operation.machineId } : {}),
                ...(operation.featureIds ? { featureIds: operation.featureIds } : {}),
                ...(context.signal ? { signal: context.signal } : {}),
              }) }
              : operation.kind === 'prompt'
                ? { kind: 'prompt' as const, promptAssetBlocks: await lease.registry.resolvePromptAssetBlocks({
                  sessionId: context.sessionId, agentId,
                  ...(operation.selectedAsset ? { selectedAsset: operation.selectedAsset } : {}),
                  ...(operation.machineId ? { machineId: operation.machineId } : {}),
                  ...(operation.featureIds ? { featureIds: operation.featureIds } : {}),
                  ...(operation.excludePluginIds ? { excludePluginIds: operation.excludePluginIds } : {}),
                  ...(context.signal ? { signal: context.signal } : {}),
                }), toolPromptContributions: resolvePluginToolPromptContributionsThroughRuntimeRegistry(lease.registry,
                  operation.excludePluginIds ? { excludePluginIds: operation.excludePluginIds } : undefined)
                  .map(({ pluginId: _pluginId, ...contribution }) => contribution) }
                : null;
          if (!contributions) throw new Error(`Unexpected fixture turn contribution: ${operation.kind}`);
          return { ok: true as const, result: { kind: 'turn_contributions' as const, status: 'resolved' as const,
            contributions: AgentRuntimeDaemonTurnContributionsResultV1Schema.parse(contributions) } };
        } finally {
          if (!retained) await lease.release();
        }
      }
      if (request.operation.kind.startsWith('execution_run.')) return await snapshots.dispatch(request, context);
      const serviceOperation = RunnerDaemonPluginServiceOperationV1Schema.safeParse(request.operation);
      if (serviceOperation.success) {
        const closesPluginServices = serviceOperation.data.kind === 'plugin_services.close_v1';
        const retained = request.context.executionRunSnapshotId && !closesPluginServices
          ? snapshots.read(request.context.executionRunSnapshotId, context) : null;
        if ((!closesPluginServices && !retained?.projection.agent) || !await context.isCurrent()) throw new Error('Missing retained Run snapshot');
        const serviceRequest = { ...context, operation: serviceOperation.data,
          retainedAgent: retained?.projection.agent?.binding ?? context.retainedAgent, runnerRetainedAgent: context.retainedAgent,
          executionRunSnapshotId: request.context.executionRunSnapshotId };
        return { ok: true as const, result: await services.dispatch(serviceRequest) };
      }
      throw new Error(`Unexpected runner operation: ${request.operation.kind}`);
    } },
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
      const identity = await processIdentity.readProcessIdentityByPid(process.pid);
      if (identity?.processStartTimeMs === undefined) throw new Error('Missing actual child process generation');
      await writeSessionMarker({ pid: process.pid, happySessionId: 'admitted-session',
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
  const admitAgent = (plugin: ReturnType<typeof createTestAgentPlugin>, replaceExisting = false) => createAuthoredAdmittedPluginRuntimeFixture({
    happyHomeDir: directory,
    controller: pluginReloadController,
    ...(options?.runtimePluginIds ? { runtimeOptions: { pluginIds: [plugin.manifest.id, ...options.runtimePluginIds] } } : {}),
    plugins: [{
      manifest: plugin.manifest,
      replaceExisting,
      files: {
        ...(plugin.manifest.contributes?.executionRunProfiles?.length ? { 'resources/memory.md': 'Contributed memory policy' } : {}),
        'agent-runtime.mjs': `let open, openDetached, openConversation;
          export function configureUnitOpen(callback, detachedCallback, conversationCallback) {
            open = callback; openDetached = detachedCallback; openConversation = conversationCallback; }
          export function createRuntime() { return { sessions: { open: request => open(request),
            executionRunContextV1: { open: request => openDetached(request), openConversation: request => openConversation(request) } } }; }`,
        'daemon.mjs': `import * as leaf from './agent-runtime.mjs'; let onDispose;
          export function activate(api) {
            api.agents.register('agent', leaf.createRuntime, {
              sessionRunnerFactory: { module: './agent-runtime.mjs', export: 'createRuntime', runtimeApiVersion: 1 },
            });
            return () => onDispose();
          }
          export function createActivationUnitModule(open, openDetached, openConversation, dispose) { onDispose = dispose;
            leaf.configureUnitOpen(open, openDetached, openConversation); return { activate }; }`,
      },
      // Same actual file-module callback boundary as targetAgents.testkit.ts.
      // The committed module authors registration; only its external SDK leaf is
      // supplied by the test. This does not certify callback byte behavior.
      instantiateCommittedModule(module) {
        const factory = module.createActivationUnitModule;
        if (typeof factory !== 'function') throw new Error('Missing authored SDK fixture boundary');
        const instantiated: unknown = factory((request: AgentSessionOpenRequest) => nativeOpen(request),
          (request: AgentExecutionRunOpenRequest) => nativeDetachedOpen(request),
          (request: AgentExecutionRunOpenRequest) => nativeConversationOpen(request),
          () => { activationDisposals.push(plugin.manifest.id); });
        if (!instantiated || typeof instantiated !== 'object' || !('activate' in instantiated)) {
          throw new Error('Missing authored Agent activation');
        }
        return instantiated as PluginDaemonModuleNamespace;
      },
    }],
  });
  const admittedFixture = await admitAgent(agentPlugin);
  admittedRuntimeFixture = admittedFixture;
  if (source !== 'admitted Workflow') {
    const backendId = readAgentRoutingIdForContributionIdentity(
      indexAgentRoutingIdsByContributionIdentity(admittedFixture.registry.contributes.agents), agentIdentity);
    if (!backendId) throw new Error('Missing admitted Agent routing identity');
    const descriptor = await resolveRunnerAgentSessionDescriptorForLease({
      target: readBackendTargetRefV2({ kind: 'backend', backendId }), lease: admittedFixture.lease });
    const binding = descriptor && admittedFixture.registry.agentRuntimesByAgentId.get(descriptor.agentId)?.sessionRunnerFactoryBinding;
    if (!binding) throw new Error('Missing admitted Session runner factory');
    const runner = { pid: process.pid, processStartTimeMs: actualIdentity.processStartTimeMs,
      processCommandHash: hashProcessCommand(command), snapshotIdentity: 'snapshot:requester-attribution' };
    const path = await createAgentRuntimeDaemonServiceAuthorityPath(configuration);
    const published = await publishAgentRuntimeDaemonServiceAuthority({ ...configuration, path,
      sessionId: 'admitted-session', runner, retainedAgent: binding, httpPort: daemonAddress.port });
    tracked.push({ startedBy: 'daemon', happySessionId: 'admitted-session', ...runner,
      agentRuntimeDaemonServiceAuthorityFilePath: path, agentRuntimeDaemonServiceCapabilityHash: published.capabilityDigest,
      runnerAgentSourceCustodyV1: binding.sourceCustody,
      runnerAgentInvocationContext: { cwd: directory, environment: {}, providerBindingActive: false } });
    vi.stubEnv(HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY, path);
    if (source === 'ordinary accepted marker') {
      expect(await updateSessionMarkerAgentRuntimeDaemonServiceAuthorityPath({ pid: process.pid,
        sessionId: 'admitted-session', processCommandHash: hashProcessCommand(command),
        processStartTimeMs: actualIdentity.processStartTimeMs, authorityFilePath: path })).toBe(true);
    }
  }
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
        emit?.({ kind: 'input-accepted', sessionId: opened.sessionId, sequence: 2, emittedAtMs: 2,
          inputIds: request.inputIds, delivery: request.delivery });
        emit?.({ kind: 'turn-start', sessionId: opened.sessionId, sequence: 3, emittedAtMs: 3,
          turnId: request.delivery.turnId, startedBy: 'host' });
        return { status: 'admitted' as const };
      },
      async cancel(request) {
        emit?.({ kind: 'turn-cancelled', sessionId: opened.sessionId, sequence: 4, emittedAtMs: 4,
          turnId: request.turnId, cause: request.reason });
        return { status: 'requested' as const, turnId: request.turnId };
      },
      async dispose() {},
    };
  });
  nativeConversationOpen.mockImplementation(async request => {
    if (request.kind === 'fork') throw new Error('The fixture does not declare detached fork support');
    // A detached Run opens a scope-neutral native conversation, never the
    // Session factory with a fabricated Session id. Keep the SDK's real Run
    // replay, admission, cancellation and terminal projection underneath it.
    let emitConversation: ((event: AgentExecutionRunConversationEventV1) => void) | undefined;
    const conversation: AgentExecutionRunConversationRuntimeV1 = {
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
      };
    resolveNativeOpened();
    return conversation;
  });
  nativeDetachedOpen.mockImplementation(async request => {
    if (request.kind === 'fork') throw new Error('The fixture does not declare detached fork support');
    return await createExecutionRunHostBackendFromConversationRuntime({
      request, openConversation: () => nativeConversationOpen(request) });
  });
  const parentProcessIdentity = skillsScenario ? await processIdentity.readProcessIdentityByPid(process.pid) : null;
  if (skillsScenario && parentProcessIdentity?.processStartTimeMs === undefined) {
    throw new Error('Missing actual parent process generation for Session-owned Run');
  }
  const parentMetadata = skillsScenario ? createSessionMetadata({
    flavor: 'claude', machineId: attribution.machineId, directory, startedBy: 'daemon',
    hostProcessStartTimeMs: parentProcessIdentity?.processStartTimeMs,
    launchControlMetadata: captureSessionLaunchControlMetadata({ processEnvironment: {} }),
    augmentMetadata: metadata => ({ ...metadata, homeDir: directory }),
  }).metadata : { path: directory, host: 'host', homeDir: directory, happyHomeDir: directory, happyLibDir: directory,
    happyToolsDir: directory, flavor: 'claude', machineId: 'metadata-decoy-machine' };
  const session = source === 'admitted Workflow' ? undefined : createTestApiSessionClient(ApiSessionClient, token, createPlainSessionFixture({ id: 'admitted-session',
    metadata: parentMetadata,
  }), { localMachineId: attribution.machineId,
    initialRegisteredSessionStateFieldMutations: [createInitialHostRuntimeActivityMutation({
      sessionId: 'admitted-session', agentRuntimeApplicability: 'not_applicable' })],
    metadataAuthority: { kind: 'owner', credentials, readCurrentCredentials: async () => credentials } });
  let parentPermissionHandler: ReturnType<typeof createProviderEnforcedPermissionHandler> | undefined;
  if (session) {
    // Ordinary host startup installs this real permission owner before child
    // admission. Explicit child selections need no fabricated parent model.
    const permissionHandler = createProviderEnforcedPermissionHandler({ session,
      logPrefix: '[admitted-session-test]', getAccountSettings: () => accountSettings.settings });
    permissionHandler.setPermissionMode('read-only');
    parentPermissionHandler = permissionHandler;
    session.setSessionRuntimeControls({ readPermissionHandler: () => permissionHandler });
  }
  const rpc = session?.rpcHandlerManager ?? new RpcHandlerManager({ scopePrefix: attribution.machineId, encryptionMode: 'plain' });
  if (!session) {
    registerCapabilitiesHandlers(rpc);
    registerExecutionRunRpcHandlers(rpc, { sessionId: null, cwd: directory, machineId: attribution.machineId,
      runtimeAccountId: accountId, serverId: attribution.serverId, serverUrl: origin, parentProvider: 'claude',
      readPromptCredentials: async () => credentials,
      resolveAccountSettings: () => accountSettings.rawSettings ?? null,
      resolveAccountSettingsSnapshot: async () => accountSettings,
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
  const bridge = options?.directOwner && session && parentPermissionHandler ? new ExecutionRunHostBridge({
    parentProvider: readAgentRoutingIdForContributionIdentity(indexAgentRoutingIdsByContributionIdentity(
      admittedFixture.registry.contributes.agents), agentIdentity)!,
    cwd: directory, machineId: attribution.machineId,
    resolveExecutionRunProfileCatalog: createRunnerExecutionRunSnapshotResolver({ sessionId: session.sessionId,
      machineId: attribution.machineId }),
    resolveAccountSettings: () => accountSettings.rawSettings ?? null,
    resolveRunReportPolicy: createSessionRunReportPolicyReader({ serverId: attribution.serverId, serverHttpBaseUrl: origin,
      accountId, readCredentials: async () => credentials, isCurrent: () => true }),
    resolveAccountSettingsSnapshot: async () => accountSettings,
    // This authored fixture has no prompt-library or Project entries. Bind
    // the real Voice owner to its genuine parent and Account credentials.
    resolveVoicePromptPreparation: async args => await resolveCliVoicePromptPreparation({ ...args, credentials,
      serverId: attribution.serverId, sessionMetadata: parentMetadata, machineId: attribution.machineId,
      directory, accountEntries: [], profileEntries: [], projectEntries: [] }),
    sessionInteractionHost: { session, machineId: attribution.machineId, permissionHandler: parentPermissionHandler },
    sendAcp: async (provider, body, opts) => {
      const admission = await session.enqueueAgentMessageCommitted(provider, body, {
        localId: 'id' in body && typeof body.id === 'string' ? body.id : randomUUID(),
        ...(opts?.meta ? { meta: opts.meta } : {}),
        provenance: { kind: 'non_dependent', source: 'sidechain' },
      });
      if (!admission.persisted) throw createExecutionRunTranscriptCustodyError();
    },
  }) : undefined;
  onTestFinished(async () => {
    if (completed) return;
    let nativeRun: unknown = null;
    try {
      if (runId) {
        const raw = await rpc.invokeLocal(SESSION_RPC_METHODS.EXECUTION_RUN_GET,
          { runId }, { verifiedPeerAuthority: 'present_user' });
        const parsed = ExecutionRunGetResponseSchema.safeParse(raw);
        nativeRun = parsed.success ? { runId: parsed.data.run.runId, status: parsed.data.run.status,
          error: parsed.data.run.error, inputTurns: parsed.data.run.inputTurns } : JSON.stringify(raw);
      }
    } catch (error) { nativeRun = { readFailure: error instanceof Error ? error.message : JSON.stringify(error) }; }
    console.error('Actual requester Run fixture failure phase', JSON.stringify({ source, phase, nativeRun,
      nativeOpenCount: nativeOpen.mock.calls.length,
      machineObservations, workflowState: workflowStorage?.run().state, lastMachineFailure }));
  });
  try {
    if (options) {
      if (!session) throw new Error('The composed Session Run fixture requires a real Session');
      await options.run({ rpc, session, trackedSessions: tracked, directory, agentIdentity, nativeOpen, bridge, lifecycleEvents, activationDisposals,
        get admittedRuntime() { return admittedRuntimeFixture!; },
        async replaceAgent(selection) {
          const previous = admittedRuntimeFixture;
          admittedRuntimeFixture = await admitAgent(createTestAgentPlugin(skillsScenario, { ...options, ...selection }), true);
          await previous?.dispose();
        },
        async start(input = {}) {
          phase = 'registry_start';
          if (bridge) {
            const agentId = readAgentRoutingIdForContributionIdentity(indexAgentRoutingIdsByContributionIdentity(
              admittedFixture.registry.contributes.agents), agentIdentity);
            if (!agentId) throw new Error('Missing admitted direct-owner Agent identity');
            const started = await bridge.start({ sessionId: session.sessionId, intent: 'delegate',
              backendTarget: { kind: 'builtInAgent', agentId }, instructions: 'Inspect.', permissionMode: 'read_only',
              retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response', modelSelection: null,
              connectedServices: null, promptCredentials: credentials, ...input });
            runId = started.runId;
            return started;
          }
          const raw = await rpc.invokeLocal(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
            sessionId: session.sessionId, intent: 'delegate', backendTarget: { kind: 'agent', identity: agentIdentity },
            instructions: 'Inspect.', permissionMode: 'read_only', retentionPolicy: 'ephemeral',
            runClass: 'bounded', ioMode: 'request_response', modelSelection: null, connectedServices: null,
            ...input,
          }, { verifiedPeerAuthority: 'present_user' });
          expect(raw, `Actual public Run admission: ${JSON.stringify(raw)}`).toMatchObject({ runId: expect.any(String) });
          const started = ExecutionRunStartResponseSchema.parse(raw);
          runId = started.runId;
          phase = 'registry_started';
          return started;
        },
      });
      return;
    }
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
        sessionId: 'admitted-session', intent: 'delegate', backendTarget: { kind: 'agent', identity: agentIdentity },
        ...(skillsScenario ? { cwd: runDirectory } : {}),
        instructions: 'Inspect.', permissionMode: 'read_only', retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response',
        modelSelection: null, connectedServices: null,
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
    if (skillsScenario) {
      const opened = nativeOpen.mock.calls[0]?.[0];
      expect(opened?.cwd).toBe(runDirectory);
      expect(opened?.skills?.pluginRoot).toBe(join(directory, 'skills', 'sessions', 'admitted-session', 'runs', runId!));
      expect(opened?.skills?.items).toEqual([expect.objectContaining({ skillId: 'skill-child', name: 'child' })]);
      expect(await readFile(join(opened!.skills!.skillsRoot, 'child', 'references', 'note.md'), 'utf8')).toBe('child supporting file');
    }
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
        if (bridge) await bridge.stop(runId);
        else await rpc.invokeLocal(SESSION_RPC_METHODS.EXECUTION_RUN_STOP,
          { runId }, { verifiedPeerAuthority: 'present_user' });
        phase = 'cleanup_run_wait';
        if (bridge) await bridge.waitForTerminal(runId);
        else await rpc.invokeLocal(SESSION_RPC_METHODS.EXECUTION_RUN_WAIT,
          { runId }, { verifiedPeerAuthority: 'present_user' });
      }
    } finally {
      workflowAbort.abort();
      await bridge?.dispose();
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
