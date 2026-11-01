import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import nacl from 'tweetnacl';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import {
  accountSettingsParse, normalizeActionsSettingsV1, SessionListQueryV1Schema, SessionListQueryResponseV1Schema,
  FeaturesResponseSchema, type ActionsSettingsV1,
} from '@happier-dev/protocol';
import { EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions';
import { ACCOUNT_SECURITY_PATH_V1, AccountSecurityGetResponseV1Schema } from '@happier-dev/protocol/auth/accountSecurity';
import { signExternalActionMachineRpcRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { verifyExternalActionMachineRpcExecution } from '../../../../server/sources/app/auth/externalActionExecutionAuthorization';
import { parseSessionListQueryActionResultV1 } from '@happier-dev/protocol/sessions/awareness/action';
import { emptyPromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { PromptLibraryCatalogKeyV1Schema, PromptLibraryRowsListResponseV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { createSessionOwnerMetadataV1, projectSessionSharedMetadataV1, SessionMetadataOwnerPatchV1Schema,
  SessionMetadataTuplePatchSuccessV1Schema, type SessionMetadataOwnerPatchV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { AcpCatalogRowReadResponseV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { auth } from '../../../../server/sources/app/auth/auth';
import { createAuthenticatedTestApp } from '../../../../server/sources/app/api/testkit/sqliteFastify';
import { installedSessionExternalActionStorage as storage } from '../../../../server/sources/app/api/testkit/installedSessionExternalActionStorage';
import { registerExternalActionRoutes } from '../../../../server/sources/app/api/routes/actions/registerExternalActionRoutes';
import type { Fastify } from '../../../../server/sources/app/api/types';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createAccountEncryptionCurrentnessFixture, createSessionNotificationContextFixture } from '@/testkit/backends/sessionFixtures';
import { createExternalActionAuthorizedRequestHeaders, prepareExternalActionRequesterAccountAuthorization, resolveExternalActionServerRequestHeaders } from '@/api/externalActionExecutionAuthorization';
import { createSessionListActionDeps } from '@/session/actions/sessionListActionDependency';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { createSessionFollowSourceKeyPreparationAfterSet } from '@/agent/runtime/session/follow/createSessionFollowSourceKeyPreparationAfterSet';
import { logger } from '@/ui/logger';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createDaemonSessionAccountActionExecutor } from './createDaemonSessionAccountActionExecutor';
import { AgentRuntimeDaemonServiceRequestV1Schema, type AgentRuntimeDaemonServiceRequestV1 } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import { createHappierMcpServer } from '@/mcp/createHappierMcpServer';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { configuration } from '@/configuration';
import { hashProcessCommand } from '@/daemon/sessionRegistry';
import { hashPrivateBearer } from '@/daemon/privateBearerFile';
import { createAgentSessionRunnerFactoryBinding } from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
import { createAgentRuntimeDaemonServiceAuthorityPath, publishAgentRuntimeDaemonServiceAuthority,
  removeAgentRuntimeDaemonServiceAuthorityIfOwned } from './sessionBridgeAuthorization';
import * as machineRpc from '@/session/transport/rpc/machineRpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { prepareInstalledRequesterAccountActionContext, prepareRequesterAccountActionContext } from "@/daemon/sessionEncryption/requesterAccountActionProjection";
import { readRequesterAccountActionContext } from "@/daemon/sessionEncryption/requesterAccountActionContext";
import * as installationStore from '@/daemon/identity/store';
import { createCurrentMachineExecutionOriginContextResolver } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { sealExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { encodeStoredCredentials } from '@/persistence';
import { registerSessionLifecycleRpcHandlers } from '@/rpc/handlers/sessionLifecycle';
import { createMachineSessionStopLifecycleActionExecutor } from '@/session/actions/sessionLifecycleActions';
import { MACHINE_SESSION_STOP_RPC_SCOPES } from '@/rpc/handlers/actionSpecRpcRegistration';
import type { AgentSessionRuntime, AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import { buildPluginSessionBindingInput } from '@/plugins/runtime/runtimeCore/plugin/sessionLaunch';
import { projectAgentRuntimeDaemonServiceTurnWitnessV1 } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceTurnWitness';
import { createNativeAgentRuntimeSessionPlanFixture, createNativeSessionClientTestPort,
  createExternalContributionFixtures, createLease, createSessionHostServiceOwners } from '@/agent/runtime/registry/engineRegistry/nativeAgentSession.testkit';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import type { ActionExecutorDeps } from '@happier-dev/protocol';
import { SessionSpawnNewInputV2Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { resolveBackendTargetFromSessionMetadata } from '@/session/backendTargets/resolveBackendTargetFromSessionMetadata';
import { resolveCliAgentStartContextV1 } from '@/session/actions/resolveCliAgentStartContextV1';
import { resolveRolesSnapshotV1 } from '@happier-dev/protocol/prompts/roles/resolveRoleSelectionV1';
import { inheritedCodexInput } from '@/session/actions/sessionSpawnNew.agent.testkit';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ActionCurrentSessionScopeFailureDetailsV1Schema, isLedSubtreeSessionLifecycleActionId } from '@happier-dev/protocol/actions/executor/sessionListAccess';
import { createDiscussionActionDeps } from '@/discussions/discussionActionDeps';
import { bindDiscussionDraftReply } from '@/discussions/bindDiscussionDraftReply';
import { registerAuthoredAccountActionRelease } from '@/plugins/runtime/accountPluginActions.testkit';
import { withTempDir } from '@/testkit/fs/tempDir';
import { reloadConfiguration } from '@/configuration';
import { readStoredCredentialsForServerId, writeStoredCredentialsForServerId } from '@/persistence';
import * as daemonControlHttp from '@/daemon/controlHttp';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { executeAppliedDaemonPluginActionWithController } from '@/plugins/daemon/controlRoutes';
import { createCommittedContributedActionInvoker, createCommittedContributedActionDefinitionLister,
  createCommittedContributedActionSchemaReader } from '@/plugins/runtime/invocation/actions/createCommittedContributedActionDeps';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { PLUGIN_MANIFEST as triageManifest } from '@happier-dev/plugins-triage/manifest';
import { loadCurrentBundledPluginLocatorResult } from '@/plugins/projection/registry/builtIn/locators';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createClientActionMachineRpcExecutor } from '@/plugins/runtime/invocation/actions/clientActionMachineRpc';
import { UiContributedActionExecuteRequestV1Schema } from '@happier-dev/protocol/plugins/actions/clientInvocationV1';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { resolveInvocationAuthority } from '@happier-dev/protocol/actions/invocationAuthority';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import { createCliActionDeps, type SessionActionRpcTransport } from '@/session/actions/createCliActionDeps';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { BasePermissionHandler } from '@/agent/permissions/BasePermissionHandler';

const processIdentity = vi.hoisted(() => vi.fn());
vi.mock('@/daemon/processIdentity', () => ({ readProcessIdentityByPid: processIdentity }));

// Only database I/O and HTTP delivery are substituted. Home issuance, signature
// verification, Session custody, scope admission and the transport readers run.
vi.mock('../../../../server/sources/storage/db', async importOriginal => ({
  ...await importOriginal<typeof import('../../../../server/sources/storage/db')>(),
  db: (await import('../../../../server/sources/app/api/testkit/installedSessionExternalActionStorage')).installedSessionExternalActionStorage.db,
}));

const installation = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(29));
const sessionId = 'c123456789012345678901230';
const childId = 'c123456789012345678901231';
const serverId = 'signed-session-home';
const serverHttpBaseUrl = 'https://signed-session.test';
type Operation = Extract<AgentRuntimeDaemonServiceRequestV1['operation'], { kind: 'action.execute' }>;

beforeAll(async () => {
  vi.stubEnv('HANDY_MASTER_SECRET', 'session-observation-test-secret');
  vi.stubEnv('AUTH_REQUIRED_LOGIN_PROVIDERS', '');
  await auth.init();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); resetActiveAccountSettingsSnapshotForTests(); });
afterAll(() => vi.unstubAllEnvs());

async function admittedClientActionFixture() {
  let effects = 0;
  const bundled = loadCurrentBundledPluginLocatorResult();
  const contributes = createResolvedContributionRegistry(projectLoadedPluginContributes({ loadResult: {
    loadedPlugins: bundled.loadedPlugins.filter(plugin => plugin.pluginId === triageManifest.id)
      .map(plugin => ({ ...plugin, manifest: normalizePluginManifestV2(triageManifest) })), diagnosticsByPluginId: {},
  }, provenance: 'first_party' }));
  const executeClientAction = createClientActionMachineRpcExecutor(() => ({
    hasConnectedClientRpcHandler: () => true,
    // Only the answering UI socket is substituted. Its public ingress schema,
    // Machine-side source admission, descriptor and invocation remain real.
    callConnectedClientRpc: async (_method, raw, options) => {
      UiContributedActionExecuteRequestV1Schema.parse(JSON.parse(JSON.stringify(raw)));
      options.onIssued();
      effects++;
      return { ok: true, result: { ok: true, result: { v: 1, kind: 'createTask', draftId: 'client-draft' } } };
    },
  }));
  const runtime = await createAdmittedPluginRuntimeFixture({ runtimeOptions: {
    contributes, pluginIds: [triageManifest.id], executeClientAction,
  } });
  return { runtime, action: { pluginId: triageManifest.id, localId: 'tasks/open-create-v1' }, effects: () => effects };
}

function installClientMachineControlHttp(clientAction: Pick<Awaited<ReturnType<typeof admittedClientActionFixture>>, 'runtime'>) {
  const list = createCommittedContributedActionDefinitionLister({
    tryAcquireRuntimeRegistryLease: () => clientAction.runtime.lease,
  });
  const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
    listContributedActionDefinitions: list,
    readContributedActionSchemas: createCommittedContributedActionSchemaReader(list),
    invokeContributedAction: createCommittedContributedActionInvoker({
      acquireRuntimeRegistryLease: () => clientAction.runtime.controller.acquireRuntimeRegistry(),
    }),
  });
  // Mirror only controlServer.ts's HTTP dispatch branch: its three supported
  // built-ins enter the full core executor; qualified effects use the final
  // contributed dispatcher. All metadata, admission and policy remain real.
  vi.spyOn(daemonControlHttp, 'daemonPost').mockImplementation(async (_path, body) => {
    if (!body || typeof body !== 'object' || !('actionId' in body) || typeof body.actionId !== 'string'
      || !('input' in body) || !('surface' in body)
      || (body.surface !== 'agent' && body.surface !== 'mcp' && body.surface !== 'cli')) throw new Error('Expected plugin control request');
    if (body.actionId === 'action.spec.search' || body.actionId === 'action.spec.get' || body.actionId === 'action.invoke') {
      const outcome = await executor.execute(body.actionId, body.input, {
        surface: body.surface,
        authority: resolveInvocationAuthority({ credential: 'terminal', surface: body.surface, terminalPolicy: 'allowed' }),
        actionCaller: { kind: 'host' },
        ...('defaultSessionId' in body && typeof body.defaultSessionId === 'string' ? { defaultSessionId: body.defaultSessionId } : {}),
      });
      return { matched: true, result: outcome.ok ? { ok: true, result: StrictJsonValueSchema.parse(outcome.result) }
        : { ok: false, errorCode: outcome.errorCode, error: outcome.error } };
    }
    return await executeAppliedDaemonPluginActionWithController({ actionId: body.actionId, input: body.input, surface: body.surface,
      ...('defaultSessionId' in body && typeof body.defaultSessionId === 'string' ? { defaultSessionId: body.defaultSessionId } : {}),
    }, clientAction.runtime.controller);
  });
}

async function fixture(metadataLayout: 0 | 1 = 1, observeSubtreeQuery?: () => Promise<void>, bypassActionInterception = false,
  accountRelease = false, accountCurrentProcess = true,
  clientAction?: Awaited<ReturnType<typeof admittedClientActionFixture>>) {
  storage.state.sessionId = sessionId;
  storage.state.bound = true;
  storage.state.publisherBound = true;
  storage.state.revokedAt = null;
  storage.state.publicKey = installation.publicKey;
  storage.state.sessionIds = new Set([childId]);
  storage.state.sessionAccessKeyIds = new Set();
  storage.state.directReportSessionIds = new Set([childId]);
  const token = await auth.createToken(storage.account.id, undefined, { kind: 'account', authority: 'present_user' });
  const credentials = { token, encryption: null };
  const scopeKey = runWithServerHttpBaseUrl(serverHttpBaseUrl, () => resolveAccountSettingsScopeKey(credentials));
  let rawSettings: { actionsSettingsV1?: ActionsSettingsV1 } = {};
  let authorizationStatus: 401 | 403 | 503 | undefined;
  let cancelAuthorization: (() => void) | undefined;
  let settingsVersion = 0;
  const publishSettings = () => setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse(rawSettings), rawSettings, scopeKey,
    settingsVersion: ++settingsVersion, loadedAtMs: 1, settingsSecretsReadKeys: [], promptLibraryCatalog: { status: 'loading' } });
  publishSettings();
  const actionsSettingsProvider = createActionSettingsProvider({ scopeKey });
  const app: Fastify = createAuthenticatedTestApp({ authentication: 'real' });
  app.addHook('onRequest', async (request, reply) => {
    if (accountRelease && (request.url.startsWith('/v1/artifacts') || request.url.includes('account.plugins.availability'))) {
      expect(request.headers.authorization).toBe(`Bearer ${token}`);
    }
    if (request.url.endsWith('/execution-authorization') && authorizationStatus) {
      cancelAuthorization?.();
      return reply.code(authorizationStatus).send({ error: 'private-error-body' });
    }
  });
  app.decorate('resolveCurrentSessionMachine', async () => storage.state.bound ? storage.state.machineId : null);
  registerExternalActionRoutes(app, { dispatch: async () => { throw new Error('Unexpected external dispatch'); } });
  const observations: { method: string; path: string; status: number; code?: string; signed: boolean; bearer: boolean }[] = [];
  app.addHook('onSend', async (request, reply, payload) => {
    let code: string | undefined;
    if (reply.statusCode >= 400 && typeof payload === 'string') {
      const body: unknown = JSON.parse(payload);
      const error = body && typeof body === 'object' && 'error' in body ? body.error : undefined;
      if (error === 'invalid_token' || error === 'credential_scope_denied') code = error;
    }
    observations.push({ method: request.method, path: request.url, status: reply.statusCode,
      ...(code ? { code } : {}),
      signed: typeof request.headers[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER] === 'string',
      bearer: request.headers.authorization !== undefined });
    return payload;
  });
  const members = storage.state.directReportSessionIds;
  let currentnessRefused = false;
  let subtreeRefused: false | true | 'active' | 'archived' = false;
  const nextSubtreeStatuses = new Map<'active' | 'archived', number>();
  let callerWorkspaceMissing = false;
  let inactive = false;
  const activeSessions = new Set<string>();
  const archivedSessions = new Set<string>();
  const ownerTuples = new Map<string, SessionMetadataOwnerPatchV1>();
  let nestedReportId: string | undefined;
  const lifecycleEffects: string[] = [];
  const row = (id: string) => {
    const metadata = { machineId: storage.state.machineId,
      ...(id === sessionId && callerWorkspaceMissing ? {} : { path: '/workspace' }), flavor: 'codex' };
    const owner = createSessionOwnerMetadataV1({ metadata });
    if (!owner.ok) throw new Error('Invalid caller metadata fixture');
    const tuple = ownerTuples.get(id);
    return { ...createSessionNotificationContextFixture(id), encryptionMode: 'plain' as const, share: null,
      active: !inactive || activeSessions.has(id),
      archivedAt: archivedSessions.has(id) ? 123 : null,
      ...(metadataLayout === 0 ? { metadata: JSON.stringify(metadata) } : {
        metadataLayoutVersion: 1,
        metadata: JSON.stringify(projectSessionSharedMetadataV1({ metadata })),
        ownerMetadata: { t: 'plain' as const, v: owner.ownerMetadata },
      }),
      ...(tuple ? { metadata: tuple.sharedMetadata.ciphertext, ownerMetadata: tuple.ownerMetadata,
        metadataVersion: tuple.sharedMetadata.expectedVersion + 1, agentState: tuple.agentState.ciphertext,
        agentStateVersion: tuple.agentState.expectedVersion + 1 } : {}),
      ...(id === childId ? { manager: { sessionId } }
        : id === nestedReportId ? { manager: { sessionId: childId } } : {}) };
  };
  app.get('/v1/account/encryption/currentness', { preHandler: app.authenticate }, async (_request, reply) =>
    currentnessRefused ? reply.code(401).send({ error: 'private-error-body' }) : createAccountEncryptionCurrentnessFixture());
  app.get('/v2/account/settings', { preHandler: app.authenticate }, async () => ({ version: settingsVersion, content: { t: 'plain', v: rawSettings } }));
  app.get('/v1/account/profile', { preHandler: app.authenticate }, async () => ({ id: storage.account.id }));
  if (accountRelease) app.get(ACCOUNT_SECURITY_PATH_V1, { preHandler: app.authenticate }, async () => AccountSecurityGetResponseV1Schema.parse({
    v: 1, encryptionMode: 'plain', terminalPresentUserPolicy: 'allowed', nativeEmail: null,
    password: { status: 'not_enrolled', revision: null },
  }));
  app.get('/v1/machines/:machineId', { preHandler: app.authenticate }, async request => ({
    machine: { id: (request.params as { machineId: string }).machineId },
  }));
  const authoredAccount = accountRelease ? await registerAuthoredAccountActionRelease(app, storage.account.id) : null;
  if (!authoredAccount) app.get('/v1/artifacts', { preHandler: app.authenticate }, async () => []);
  if (authoredAccount) app.get('/v1/account/encryption', { preHandler: app.authenticate }, async () => ({ mode: 'plain', updatedAt: 1 }));
  app.get('/v1/account/entity-rows/acp', { preHandler: app.authenticate }, async () =>
    AcpCatalogRowReadResponseV1Schema.parse({ status: 'present', revision: 1,
      content: { t: 'plain', v: { v: 1, definitions: [] } } }));
  app.get('/v1/account/entity-rows/prompt-library', { preHandler: app.authenticate }, async () =>
    PromptLibraryRowsListResponseV1Schema.parse({ status: 'listed', rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({
      key, revision: 1, content: { t: 'plain', v: emptyPromptLibraryRecordV1(key) },
    })) }));
  app.post('/v2/sessions/query', { preHandler: app.authenticate }, async (request, reply) => {
    const query = SessionListQueryV1Schema.parse(request.body);
    expect(query.underSessionId === undefined || query.underSessionId === sessionId
      || (members.has(childId) && query.underSessionId === childId)).toBe(true);
    await observeSubtreeQuery?.();
    const nextStatus = nextSubtreeStatuses.get(query.storage);
    if (nextStatus !== undefined) {
      nextSubtreeStatuses.delete(query.storage);
      return reply.code(nextStatus).send({ error: 'private-error-body' });
    }
    if (subtreeRefused === true) return reply.code(401).send({ error: 'private-error-body' });
    if (subtreeRefused === query.storage) return reply.code(503).send({ error: 'private-error-body' });
    const candidates = query.underSessionId === childId ? (nestedReportId ? [nestedReportId] : [])
      : [...members, ...(nestedReportId && members.has(childId) ? [nestedReportId] : [])];
    return SessionListQueryResponseV1Schema.parse({ sessions: candidates.filter(id =>
      query.storage === (archivedSessions.has(id) ? 'archived' : 'active')).map(row),
      nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false });
  });
  app.get('/v2/sessions/:sessionId', { preHandler: app.authenticate,
    config: { apiTokenSessionAction: 'session.status.get', restrictedCredentialBinding: { scope: 'session', session: 'params.sessionId' } },
  }, async request => ({ session: row((request.params as { sessionId: string }).sessionId) }));
  // Persist the native Stop owner's tuple at the HTTP/DB boundary; signing,
  // metadata projection and Stop-intent admission remain production logic.
  app.patch('/v2/sessions/:sessionId', { preHandler: app.authenticate,
    config: { restrictedCredentialBinding: { scope: 'session', session: 'params.sessionId' } },
  }, async request => {
    const patch = SessionMetadataOwnerPatchV1Schema.parse(request.body);
    ownerTuples.set((request.params as { sessionId: string }).sessionId, patch);
    return SessionMetadataTuplePatchSuccessV1Schema.parse({ success: true, metadataLayoutVersion: 1,
      sharedMetadata: { version: patch.sharedMetadata.expectedVersion + 1 },
      agentState: { version: patch.agentState.expectedVersion + 1 } });
  });
  app.get('/v1/sessions/:sessionId/messages', { preHandler: app.authenticate,
    config: { apiTokenSessionAction: 'session.messages.recent.get', restrictedCredentialBinding: { scope: 'session', session: 'params.sessionId' } },
  }, async () => ({ messages: [{ id: 'message-child', seq: 1, localId: null, sidechainId: null, createdAt: 1, updatedAt: 1,
    messageRole: 'user', content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Child ready' } } } }],
    hasMore: false, nextBeforeSeq: null, nextAfterSeq: null }));
  app.post('/v2/sessions/:sessionId/archive', { preHandler: app.authenticate,
    config: { apiTokenSessionAction: 'session.archive', restrictedCredentialBinding: { scope: 'session', session: 'params.sessionId' } },
  }, async (request, reply) => {
    if (row((request.params as { sessionId: string }).sessionId).active) {
      return reply.code(409).send({ error: 'session-active' });
    }
    lifecycleEffects.push(request.url);
    archivedSessions.add((request.params as { sessionId: string }).sessionId);
    return { success: true, archivedAt: 123 };
  });
  app.post('/v2/sessions/:sessionId/unarchive', { preHandler: app.authenticate,
    config: { apiTokenSessionAction: 'session.unarchive', restrictedCredentialBinding: { scope: 'session', session: 'params.sessionId' } },
  }, async request => {
    lifecycleEffects.push(request.url);
    archivedSessions.delete((request.params as { sessionId: string }).sessionId);
    return { success: true, archivedAt: null };
  });
  const restore = installAxiosFastifyAdapter({ app, origin: serverHttpBaseUrl });
  const prepare = async (operation: Pick<Operation, 'actionId' | 'input' | 'requestId'>,
    sessionActionOrigin: Parameters<typeof prepareExternalActionRequesterAccountAuthorization>[0]['sessionActionOrigin']) => {
    const target = { kind: 'machine' as const, machineId: storage.state.machineId };
    const authorization = await prepareExternalActionRequesterAccountAuthorization({ ...operation,
      target, machineId: storage.state.machineId, sourceMachineId: storage.state.machineId,
      accountId: storage.account.id, accountEncryptionMode: 'plain', tokenEpochHint: 1, token,
      serverId, serverIdentityId: storage.state.homeId, serverHttpBaseUrl,
      installationId: storage.state.installationId, privateKey: installation.secretKey, sessionActionOrigin });
    if (!authorization) return null;
    ExternalActionExecutionAuthorizationV1Schema.parse(authorization);
    return { authorization, target };
  };
  let sessionActionRpcTransport: SessionActionRpcTransport | undefined;
  const execute = createDaemonSessionAccountActionExecutor({ serverId, serverHttpBaseUrl, token, credentials,
    ...(accountRelease ? {} : { machineId: storage.state.machineId,
      prepareExternalActionAuthorization: ({ operation, sessionActionOrigin }: Parameters<NonNullable<Parameters<typeof createDaemonSessionAccountActionExecutor>[0]['prepareExternalActionAuthorization']>>[0]) => prepare(operation, sessionActionOrigin) }),
    createExecutor: (_depth, _current, _post, options) => {
      const executor = createCliActionExecutor({ token, credentials, sessionId: '', mode: 'plain', ctx: null,
        serverId, serverIdentityId: storage.state.homeId, serverHttpBaseUrl,
        externalActionMachineRequestPrivateKey: installation.secretKey, externalActionMachineInstallationId: storage.state.installationId,
        actionsSettingsProvider,
        ...(sessionActionRpcTransport ? { sessionActionRpcTransport } : {}),
        ...(accountRelease && accountCurrentProcess ? { pluginActionExecutionOwner: 'current_process' as const,
          invokeContributedAction: createCommittedContributedActionInvoker() } : {}),
        ...(clientAction ? {
          listContributedActionDefinitions: createCommittedContributedActionDefinitionLister({
            tryAcquireRuntimeRegistryLease: () => clientAction.runtime.lease,
          }),
          invokeContributedAction: createCommittedContributedActionInvoker({
            acquireRuntimeRegistryLease: () => clientAction.runtime.controller.acquireRuntimeRegistry(),
          }),
        } : {}),
        ...options,
      });
      return { execute: (actionId, input, context) => executor.execute(actionId, input,
        bypassActionInterception ? { ...context, bypassActionInterception: true } : context) };
    },
  });
  const operation = (actionId: Operation['actionId'], input: Operation['input']): Operation => ({ kind: 'action.execute',
    actionId, input, requestId: 'signed-observation', surface: 'agent',
    witness: { turnId: 'turn', inputId: 'input', userMessageSeq: 1, userMessageSeqs: [1], workDepth: 0, callerPermissionMode: 'default',
      agentStartCaller: { kind: 'session', sessionId, starterDepth: 0, turnDepth: 0 } } });
  return { credentials, app, observations, members, prepare, execute, operation, actionsSettingsProvider, lifecycleEffects, authoredAccount,
    setSessionActionRpcTransport: (transport: SessionActionRpcTransport) => { sessionActionRpcTransport = transport; },
    failAuthorization: (status?: 401 | 403 | 503, cancel?: () => void) => {
      authorizationStatus = status; cancelAuthorization = cancel;
    },
    setActionsSettings: (actionsSettingsV1: ActionsSettingsV1) => { rawSettings = { actionsSettingsV1 }; publishSettings(); },
    markInactive: () => { inactive = true; },
    markChildArchived: () => { archivedSessions.add(childId); },
    addNestedReport: (id: string) => { nestedReportId = id; storage.state.sessionIds.add(id); },
    markSessionActive: (id: string) => { activeSessions.add(id); },
    markSessionInactive: (id: string) => { activeSessions.delete(id); },
    refuseCurrentness: () => { currentnessRefused = true; },
    refuseSubtree: (storage?: 'active' | 'archived') => { subtreeRefused = storage ?? true; },
    allowSubtree: () => { subtreeRefused = false; },
    failNextSubtree: (storage: 'active' | 'archived', status: number) => { nextSubtreeStatuses.set(storage, status); },
    omitCallerWorkspace: () => { callerWorkspaceMissing = true; },
    close: async () => { restore(); await app.close(); } };
}

it.each(['none', 'wait', 'return'] as const)('admits a native message (%s) with the resolved receiver Session under its original Home root', async reply => {
  const f = await fixture();
  try {
    storage.state.sessionAccessKeyIds.add(childId);
    f.app.get('/v2/sessions/:sessionId/delivery-mutes', { preHandler: f.app.authenticate,
      config: { apiTokenSessionAction: 'session.delivery.mute.list', restrictedCredentialBinding: { scope: 'session', session: 'params.sessionId' } },
    }, async () => ({ scopes: [] }));
    f.app.get('/v2/sessions/:sessionId/messages/reply-capability', { preHandler: f.app.authenticate,
      config: { apiTokenSessionAction: 'session.status.get', restrictedCredentialBinding: { scope: 'session', session: 'params.sessionId' } },
    }, async () => ({ v: 1, protocolVersions: [1] }));
    const operation = f.operation('session.message.send', { sessionId: childId, message: 'Message the receiver', reply });
    const prepared = await f.prepare(operation, { v: 1, caller: operation.witness.agentStartCaller,
      sourceTurnId: 'turn', sourceInputId: 'input', callerPermissionMode: 'default', requestId: operation.requestId });
    expect(prepared).not.toBeNull();
    if (!prepared) throw new Error('Missing Home root');
    const admitted: string[] = [];
    const observer = new AbortController();
    const deps = createCliActionDeps({ token: f.credentials.token, credentials: f.credentials, sessionId: '', mode: 'plain', ctx: null,
      serverId, serverIdentityId: storage.state.homeId, serverHttpBaseUrl,
      externalActionMachineRequestPrivateKey: installation.secretKey, externalActionMachineInstallationId: storage.state.installationId,
      getCurrentTurnWorkDepth: () => 0,
      sessionActionRpcTransport: async request => {
        expect(request.sessionId).toBe(sessionId);
        expect(request.method).toBe('session.message.reply.observe.v1');
        return { v: 1, ok: true, progress: { v: 1, mode: reply === 'none' ? 'wait' : reply,
          sourceSession: { sourceSessionId: sessionId, sourceTurnId: 'turn', sourceInputId: 'input', via: 'action' }, disposition: 'released' } };
      },
      // The receiver Machine is the network boundary. Home minting, signature
      // verification, Session-key admission and the send owner remain real.
      machineAdmissionTransport: async request => {
        expect(request.content).toMatchObject({ t: 'plain', v: { meta: { happierInputRequestV1: {
          sourceSession: { sourceSessionId: sessionId, sourceTurnId: 'turn', sourceInputId: 'input', via: 'action' },
        } } } });
        admitted.push(request.sessionId);
        // The tool observer may end after durable acceptance; it must not undo
        // the input. Reply/result custody itself has its existing composed tests.
        if (reply === 'wait') observer.abort();
        return { status: 'accepted', localId: request.localId };
      },
    });
    const send = (signal?: AbortSignal) => runWithServerHttpBaseUrl(serverHttpBaseUrl, () => deps.sessionSendMessage({
      sessionId: childId, message: 'Message the receiver', reply, requestedAction: { v: 1, kind: 'enqueue' },
      ...(signal ? { signal } : {}),
      actionCaller: operation.witness.agentStartCaller, callerSurface: 'agent',
      sessionInputSource: { sourceSessionId: sessionId, sourceTurnId: 'turn', sourceInputId: 'input', via: 'action',
        causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' } },
      context: { surface: 'agent', authority: 'account_automation', serverId,
        actionCaller: operation.witness.agentStartCaller, actionRequestId: operation.requestId,
        callerPermissionMode: 'default',
        sessionInputSource: { sourceSessionId: sessionId, sourceTurnId: 'turn', sourceInputId: 'input', via: 'action' },
        externalActionExecutionAuthorization: prepared.authorization, externalActionTarget: prepared.target },
    }));
    const outcome = await send(reply === 'wait' ? observer.signal : undefined);
    expect(outcome).toMatchObject({ status: 'accepted' });
    expect(admitted).toEqual([childId]);
    expect(f.observations.filter(row => row.signed && row.status >= 400)).toEqual([]);
    storage.state.sessionAccessKeyIds.delete(childId);
    await expect(send()).rejects.toMatchObject({ code: 'not_authenticated' });
    expect(admitted).toEqual([childId]);
    if (reply === 'none') {
      storage.state.sessionAccessKeyIds.add(childId);
      storage.state.revokedAt = new Date(1);
      await expect(send()).rejects.toMatchObject({ code: 'not_authenticated' });
      expect(admitted).toEqual([childId]);
    }
  } finally { await f.close(); }
});

it.each(['bound', 'restricted', 'foreign-witness', 'wrong-handler'] as const)(
  'answers a worker question through MCP and the source daemon origin: %s', async binding => {
  const f = await fixture();
  const worker = createMutableApiSessionClientFixture({ sessionId: childId,
    serverBinding: { serverId, serverUrl: serverHttpBaseUrl },
    agentState: { requests: {}, completedRequests: {} },
    overrides: { readQuestionSessionSnapshot: async id => ({ sessionId: id, accountId: storage.account.id,
      managerSessionId: id === childId ? sessionId : null, available: true, answersWorkerQuestions: true }) },
  });
  class QuestionHandler extends BasePermissionHandler { protected getLogPrefix() { return '[C7 answer]'; } }
  new QuestionHandler(worker);
  const workerMcp = createHappierMcpServer({ ...worker,
    getWorkDepth: () => 0, getHostTurnWorkDepth: () => 0,
    getActiveTurnPermissionWitness: () => ({ turnId: 'worker-turn', inputId: 'worker-input',
      causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' } }),
  }, { authorityScope: 'session', sessionCredentials: { token: 'worker-session-token', encryption: null },
    actionsSettingsProvider: f.actionsSettingsProvider });
  const command = 'node /runtime/.runner-snapshots/manager-answer/dist/index.mjs';
  const runner = { pid: process.pid, processStartTimeMs: 23349,
    processCommandHash: hashProcessCommand(command), snapshotIdentity: 'snapshot:manager-answer' };
  processIdentity.mockResolvedValue({ ...runner, command });
  const path = await createAgentRuntimeDaemonServiceAuthorityPath(configuration);
  const authority = { happyHomeDir: configuration.happyHomeDir, publicReleaseRing: configuration.publicReleaseRing,
    path, sessionId, runner, retainedAgent: createAgentSessionRunnerFactoryBinding({
      v: 1, pluginId: 'acme.plugin', pluginVersion: '1.2.3', agentId: 'acme-agent', localAgentId: 'acme-agent',
      sourceCustody: { kind: 'managed', immutableGenerationId: `sha256:${'1'.repeat(64)}`, installSource: 'localPath' },
      locator: { module: './runtime.mjs', export: 'createRuntime', runtimeApiVersion: 1 },
      normalizedModulePath: '/immutable/acme/runtime.mjs', loadMode: 'immutable-js',
    }) };
  await publishAgentRuntimeDaemonServiceAuthority({ ...authority, httpPort: 31004, capability: 'C'.repeat(43) });
  vi.stubEnv('HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE', path);
  const witness = { turnId: 'manager-turn', inputId: 'manager-input', userMessageSeq: 1, userMessageSeqs: [1],
    callerPermissionMode: 'read-only' as const,
    causalPermissionAuthority: { kind: 'admittedSessionInputV1' as const, admittedPermissionCeiling: 'read-only' as const },
    agentStartCaller: { kind: 'session' as const,
      sessionId: binding === 'foreign-witness' ? childId : sessionId, starterDepth: 0, turnDepth: 0 } };
  // IPC and the Session socket are genuine process/network boundaries. Keep
  // daemon custody, authenticated Home reads, strict RPC and question owners real.
  vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
    const request = AgentRuntimeDaemonServiceRequestV1Schema.parse(JSON.parse(String(init?.body)));
    expect(request.context).toEqual({ token: 'C'.repeat(43), sessionId });
    if (request.operation.kind !== 'action.execute') throw new Error('Expected Action envelope');
    const outcome = await f.execute(request.operation, { sessionId, isCurrent: async () => true });
    return Response.json({ ok: true, result: { kind: 'action.execution', requestId: request.operation.requestId, outcome } });
  });
  const transport = vi.fn<SessionActionRpcTransport>(async request => {
    expect(request.origin).toMatchObject({ caller: { sessionId }, sourceTurnId: 'manager-turn',
      sourceInputId: 'manager-input', callerPermissionMode: 'read-only' });
    // Substitute the authenticated Machine→Home→Session network only. The
    // actual source origin is produced by daemon custody and the strict reader.
    return await worker.rpcHandlerManager.handleRequest({ method: `${request.sessionId}:${request.method}`,
      requestId: 'answer-receiver', params: request.input,
      callerAuthority: 'account_automation', sessionActionOrigin: request.origin,
      authorization: { kind: 'session.permission.respond', sessionId: childId,
        actor: { kind: 'accountUser', accountId: storage.account.id, relationship: 'owner' } } });
  });
  f.setSessionActionRpcTransport(transport);
  const runtime = createHappierMcpServer({ sessionId,
    getServerBinding: () => ({ serverId, serverUrl: serverHttpBaseUrl }),
    rpcHandlerManager: new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain' }),
    updateMetadata() {}, getWorkDepth: () => 0, getHostTurnWorkDepth: () => 0, getPermissionMode: () => 'read-only',
    getActiveTurnAdmissionWitness: () => witness, getActiveTurnPermissionWitness: () => witness,
  }, { credentials: f.credentials, isCredentialCurrent: async () => true,
    ...(binding === 'restricted' ? { authorityScope: 'session' as const, sessionCredentials: f.credentials } : {}),
    actionsSettingsProvider: f.actionsSettingsProvider });
  const client = new Client({ name: 'c7-manager-answer', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const workerClient = new Client({ name: 'c7-worker-question', version: '1' });
  const [workerClientTransport, workerServerTransport] = InMemoryTransport.createLinkedPair();
  try {
    await workerMcp.mcp.connect(workerServerTransport);
    await workerClient.connect(workerClientTransport);
    const raised = await workerClient.callTool({ name: 'action_execute', arguments: { actionId: 'session.needs_you.raise',
      input: { mode: 'continue', assumption: 'Proceed', lasting: false, type: 'decision',
        questions: [{ id: 'choose', prompt: 'Continue?', type: 'text' }] } } });
    const requestId = Object.keys(worker.getAgentStateSnapshot()?.requests ?? {})[0];
    expect(requestId, JSON.stringify(raised)).toBeTruthy();
    expect(worker.getAgentStateSnapshot()?.requests?.[requestId!]).toMatchObject({ currentHandler: { kind: 'session', sessionId } });
    if (binding === 'wrong-handler') worker.updateAgentState(state => ({ ...state, requests: { ...state.requests,
      [requestId!]: { ...state.requests![requestId!]!, currentHandler: { kind: 'session', sessionId: 'another-manager' } } } }));
    await runtime.mcp.connect(serverTransport);
    await client.connect(clientTransport);
    const result = CallToolResultSchema.parse(await client.callTool({ name: 'action_execute', arguments: {
      actionId: 'session.user_action.answer', input: { sessionId: childId, requestId,
        answers: [{ question: 'choose', values: ['yes'] }] },
    } }));
    if (binding === 'bound' || binding === 'restricted') {
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(worker.getAgentStateSnapshot()?.completedRequests?.[requestId!]).toMatchObject({
        answeredBy: { kind: 'session', sessionId }, structuredAnswersV1: { choose: ['yes'] } });
      expect(worker.getAgentStateSnapshot()?.requests?.[requestId!]).toBeUndefined();
      expect(f.observations).not.toContainEqual(expect.objectContaining({
        path: '/v1/actions/session.user_action.answer/execution-authorization' }));
    } else {
      expect(result).toMatchObject({ isError: true, content: [{ type: 'text', text: expect.stringContaining(
        binding === 'foreign-witness' ? 'target_unavailable' : 'present_user_required') }] });
      expect(worker.getAgentStateSnapshot()?.completedRequests?.[requestId!]).toBeUndefined();
      expect(worker.getAgentStateSnapshot()?.requests?.[requestId!]).toBeDefined();
      if (binding === 'foreign-witness') expect(transport).not.toHaveBeenCalled();
    }
  } finally {
    await client.close(); await runtime.mcp.close(); await workerClient.close(); await workerMcp.mcp.close();
    await removeAgentRuntimeDaemonServiceAuthorityIfOwned({ ...authority, capabilityDigest: hashPrivateBearer('C'.repeat(43)) });
    await f.close();
  }
});

it('admits the addressed reply policy read under its original signed Account root', async () => {
  const f = await fixture();
  const discussionId = 'addressed-discussion';
  const path = `/v1/discussions/${discussionId}/participants`;
  let answerPolicy: 'when_addressed' | 'drafts_for_approval' = 'when_addressed';
  // Only the resource database response is fixed. Authentication, Home root
  // issuance, signatures, HTTP admission and the real reply binder all run.
  f.app.get('/v1/discussions/:discussionId/participants', { preHandler: f.app.authenticate,
    config: { allowApiToken: true } }, async () => ({ discussionId, ownerAccountId: storage.account.id,
    access: 'owner', grants: [], participants: [{ participant: { kind: 'session', sessionId },
      answerPolicy, createdAt: 1 }] }));
  try {
    const input = { discussionId, localId: 'explicit-reply', replyTarget: { kind: 'message', messageId: 'question' },
      content: { v: 1, parts: [{ t: 'text', text: 'The quoted arithmetic is correct.' }] } };
    const op = f.operation('discussion.reply', input);
    const prepared = await f.prepare(op, { v: 1, caller: op.witness.agentStartCaller,
      sourceTurnId: 'turn', sourceInputId: 'input', callerPermissionMode: null, requestId: op.requestId });
    if (!prepared) throw new Error('Missing original Discussion reply root');
    const source = { sourceSessionId: sessionId, sourceTurnId: 'turn', sourceInputId: 'input', via: 'action' as const,
      discussionAddressing: { discussionId, messageId: 'question', throughSeq: 2, participantSessionId: sessionId } };
    const context = { surface: 'agent' as const, authority: 'account_automation' as const, serverId,
      defaultSessionId: sessionId, actionCaller: op.witness.agentStartCaller, sessionInputSource: source,
      externalActionExecutionAuthorization: prepared.authorization, externalActionTarget: prepared.target };
    const { discussionAction } = createDiscussionActionDeps({ credentials: f.credentials, serverId,
      serverHttpBaseUrl, serverIdentityId: storage.state.homeId,
      externalActionMachineRequestPrivateKey: installation.secretKey,
      externalActionMachineInstallationId: storage.state.installationId,
      resolveServerFeaturesSnapshot: () => ({ status: 'ready', features: FeaturesResponseSchema.parse({
        features: { sessions: { enabled: true, conversations: { enabled: true } },
          sharing: { enabled: true, session: { enabled: true } } }, capabilities: {},
      }) }),
    });
    const bound = await bindDiscussionDraftReply({ actionId: op.actionId, input, context, serverId, discussionAction });
    const reads = f.observations.filter(row => row.path === path);
    expect({ bound, reads }).toMatchObject({ bound: { actionId: 'discussion.reply', input, context },
      reads: [{ method: 'GET', path, status: 200, signed: true, bearer: false }] });
    expect(bound).not.toHaveProperty('failure');
    // The original root remains unchanged after the persisted participant
    // policy changes. A signed recheck must refuse, not normalize new operands
    // beneath the old signature or reuse the earlier policy observation.
    answerPolicy = 'drafts_for_approval';
    const changed = await bindDiscussionDraftReply({ actionId: op.actionId, input, context, serverId, discussionAction });
    expect(changed).toMatchObject({ actionId: 'discussion.reply', input, context,
      failure: { ok: false, errorCode: 'discussion_content_unavailable' } });
    expect(f.observations.filter(row => row.path === path)).toEqual([
      { method: 'GET', path, status: 200, signed: true, bearer: false },
      { method: 'GET', path, status: 200, signed: true, bearer: false },
    ]);
  } finally { await f.close(); }
});

it('classifies the actual contributed Account definition before requiring Machine authorization at the capability receiver', async () => {
  const f = await fixture(1, undefined, false, true, false);
  vi.stubGlobal('fetch', async () => Response.json(FeaturesResponseSchema.parse({ features: { sessions: { enabled: true } },
    capabilities: { serverIdentity: { serverIdentityId: storage.state.homeId } } })));
  try {
    const outcome = await f.execute(f.operation('action.invoke', {
      action: { pluginId: f.authoredAccount!.pluginId, localId: 'echo' }, input: { key: 'receiver' },
    }), { sessionId, isCurrent: async () => true });
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ ok: true, result: { key: 'receiver', surface: 'agent' } });
    expect(f.observations.some(observation => observation.path.includes('action.invoke/execution-authorization'))).toBe(false);
  } finally { await f.close(); }
});

it('reads the enabled Account Action descriptor through the current-process capability factory', async () => {
  const f = await fixture(1, undefined, false, true);
  try {
    const id = `${f.authoredAccount!.pluginId}/actions/echo`;
    const outcome = await f.execute(f.operation('action.spec.get', { id }), { sessionId, isCurrent: async () => true });
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ ok: true, result: { actionSpec: { id, executionPlacement: 'account' } } });
  } finally { await f.close(); }
});

it('keeps a real client descriptor readable without granting client invocation Account placement', async () => {
  const clientAction = await admittedClientActionFixture();
  const f = await fixture(1, undefined, false, true, true, clientAction);
  vi.stubGlobal('fetch', async () => Response.json(FeaturesResponseSchema.parse({ features: { sessions: { enabled: true } },
    capabilities: { serverIdentity: { serverIdentityId: storage.state.homeId } } })));
  try {
    const id = `${clientAction.action.pluginId}/actions/${clientAction.action.localId}`;
    const descriptor = await f.execute(f.operation('action.spec.get', { id }), { sessionId, isCurrent: async () => true });
    expect(descriptor, JSON.stringify(descriptor)).toMatchObject({ ok: true, result: { actionSpec: { id, executionPlacement: 'client' } } });
    expect(await f.execute(f.operation('action.invoke', { action: clientAction.action, input: {} }),
      { sessionId, isCurrent: async () => true }))
      .toMatchObject({ ok: false, errorCode: 'target_unavailable', details: { reason: 'external_authorization_missing' } });
    expect(clientAction.effects()).toBe(0);
  } finally { await clientAction.runtime.dispose(); await f.close(); }
});

it('preserves an existing client Action at the credentialed native Agent entry', async () => {
  await withTempDir('credentialed-agent-client-', async homeDir => {
    const previousEnv = process.env;
    process.env = { ...previousEnv, HAPPIER_HOME_DIR: homeDir };
    reloadConfiguration();
    const clientAction = await admittedClientActionFixture();
    const f = await fixture(1, undefined, false, true, true, clientAction);
    await writeStoredCredentialsForServerId(serverId, f.credentials);
    const credentials = await readStoredCredentialsForServerId(serverId);
    if (!credentials) throw new Error('Missing captured Account credentials');
    installClientMachineControlHttp(clientAction);
    const features = FeaturesResponseSchema.parse({ features: { sessions: { enabled: true } },
      capabilities: { serverIdentity: { serverIdentityId: storage.state.homeId } } });
    vi.stubGlobal('fetch', async () => Response.json(features));
    const witness = { turnId: 'native-client-turn', callerPermissionMode: 'default',
      causalPermissionAuthority: { kind: 'admittedSessionInputV1' as const, admittedPermissionCeiling: 'default' } };
    const runtime = createHappierMcpServer({ sessionId,
      getServerBinding: () => ({ serverId, serverUrl: serverHttpBaseUrl }),
      getServerFeaturesSnapshot: () => ({ status: 'ready', provenance: 'authenticated', features }),
      rpcHandlerManager: new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain' }), updateMetadata() {},
      getWorkDepth: () => 0, getHostTurnWorkDepth: () => 0, getPermissionMode: () => 'default',
      getActiveTurnPermissionWitness: () => witness,
    }, { credentials, actionsSettingsProvider: f.actionsSettingsProvider, pluginToolCatalog: [] });
    try {
      const outcome = await runtime.executeTool({ toolName: 'action_execute', args: {
        actionId: 'action.invoke', input: { action: clientAction.action, input: {} },
      } });
      expect(outcome, JSON.stringify(outcome)).toMatchObject({ ok: true, result: { v: 1, kind: 'createTask', draftId: 'client-draft' } });
      expect(clientAction.effects()).toBe(1);
    } finally {
      await runtime.mcp.close(); await clientAction.runtime.dispose(); await f.close();
      process.env = previousEnv; reloadConfiguration();
    }
  });
});

it('retains original Home authorization and direct committed execution for an actual Machine Action', async () => {
  const f = await fixture(1, undefined, false, true);
  vi.stubGlobal('fetch', async () => Response.json(FeaturesResponseSchema.parse({ features: { sessions: { enabled: true } },
    capabilities: { serverIdentity: { serverIdentityId: storage.state.homeId } } })));
  const pluginId = f.authoredAccount!.pluginId;
  const machine = await createAuthoredAdmittedPluginRuntimeFixture({ plugins: [{
    manifest: createPluginManifestV2Fixture({ id: pluginId, contributes: { actions: [{ id: 'echo', title: 'Machine echo',
      scopes: ['global'], surfaces: ['agent', 'cli'], dangerLevel: 'safe', execution: { target: 'daemon' },
      inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: false },
      inputHints: { fields: [{ path: 'key', title: 'Key', widget: 'select', options: [{ value: 'machine', label: 'Machine' }] }] },
    }] } }),
    files: { 'daemon.mjs': `let effects = 0;
export function activate(api) {
  api.actions.register('echo', async (input, context) => ({ key: input.key, surface: context.surface, effects: ++effects }));
}` },
  }] });
  const list = createCommittedContributedActionDefinitionLister({ tryAcquireRuntimeRegistryLease: () => machine.lease });
  const invoke = createCommittedContributedActionInvoker({ acquireRuntimeRegistryLease: () => machine.controller.acquireRuntimeRegistry() });
  const createExecutor = (options?: Readonly<{ accountPluginActions: true }>,
    pluginActionExecutionOwner: 'current_process' | 'daemon_control' = 'current_process') => createCliActionExecutor({
    token: f.credentials.token, credentials: f.credentials, sessionId: '', mode: 'plain', ctx: null,
    serverId, serverIdentityId: storage.state.homeId, serverHttpBaseUrl,
    externalActionMachineRequestPrivateKey: installation.secretKey, externalActionMachineInstallationId: storage.state.installationId,
    actionsSettingsProvider: f.actionsSettingsProvider, pluginActionExecutionOwner,
    listContributedActionDefinitions: list, invokeContributedAction: invoke, ...options,
  });
  const receiver = (authorized: boolean) => createDaemonSessionAccountActionExecutor({ serverId, serverHttpBaseUrl,
    credentials: f.credentials, token: f.credentials.token, machineId: storage.state.machineId,
    ...(authorized ? { prepareExternalActionAuthorization: ({ operation, sessionActionOrigin }: Parameters<NonNullable<Parameters<typeof createDaemonSessionAccountActionExecutor>[0]['prepareExternalActionAuthorization']>>[0]) => f.prepare(operation, sessionActionOrigin) } : {}),
    createExecutor: (_depth, _current, _post, options) => createExecutor(options),
  });
  const operation = f.operation('action.invoke', { action: { pluginId, localId: 'echo' }, input: { key: 'machine' } });
  try {
    expect(await f.execute(f.operation('action.spec.get', { id: `${pluginId}/actions/echo` }),
      { sessionId, isCurrent: async () => true })).toMatchObject({ ok: true, result: { actionSpec: { executionPlacement: 'account' } } });
    // A real Account selection can disappear after classification while an
    // independently admitted Machine handler still owns the same public id.
    f.authoredAccount!.setBundledFallback();
    expect(await createExecutor({ accountPluginActions: true }).execute('action.invoke', operation.input,
      { surface: 'agent', authority: 'account_automation', defaultSessionId: sessionId }))
      .toMatchObject({ ok: false, errorCode: 'plugin_action_execution_placement_unavailable' });
    expect(await receiver(false)(operation, { sessionId, isCurrent: async () => true }))
      .toMatchObject({ ok: false, errorCode: 'target_unavailable', details: { reason: 'external_authorization_missing' } });
    const outcome = await receiver(true)(operation, { sessionId, isCurrent: async () => true });
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ ok: true, result: { key: 'machine', surface: 'agent', effects: 1 } });
    installClientMachineControlHttp({ runtime: machine });
    const choices = await createExecutor(undefined, 'daemon_control').execute('action.options.resolve', {
      actionId: `${pluginId}/actions/echo`, fieldPath: 'key',
    }, { surface: 'agent', defaultSessionId: sessionId });
    expect(choices, JSON.stringify(choices)).toMatchObject({ ok: true, result: {
      actionId: `${pluginId}/actions/echo`, fieldPath: 'key', options: [{ value: 'machine', label: 'Machine' }],
    } });
  } finally { await machine.dispose(); await f.close(); }
});

it('executes an authored Account Action through restricted Agent capability custody without a selected Machine', async () => {
  await withTempDir('restricted-agent-account-', async homeDir => {
    const previousEnv = process.env;
    process.env = { ...previousEnv, HAPPIER_HOME_DIR: homeDir };
    reloadConfiguration();
    const clientAction = await admittedClientActionFixture();
    const f = await fixture(1, undefined, false, true, true, clientAction);
    const command = 'node /runtime/.runner-snapshots/restricted-account/dist/index.mjs';
    const runner = { pid: process.pid, processStartTimeMs: 23349,
      processCommandHash: hashProcessCommand(command), snapshotIdentity: 'snapshot:restricted-account' };
    processIdentity.mockResolvedValue({ pid: runner.pid, processStartTimeMs: runner.processStartTimeMs, command });
    const path = await createAgentRuntimeDaemonServiceAuthorityPath(configuration);
    const authority = { happyHomeDir: configuration.happyHomeDir, publicReleaseRing: configuration.publicReleaseRing,
      path, sessionId, runner, retainedAgent: createAgentSessionRunnerFactoryBinding({
        v: 1, pluginId: 'acme.plugin', pluginVersion: '1.2.3', agentId: 'acme-agent', localAgentId: 'acme-agent',
        sourceCustody: { kind: 'managed', immutableGenerationId: `sha256:${'1'.repeat(64)}`, installSource: 'localPath' },
        locator: { module: './runtime.mjs', export: 'createRuntime', runtimeApiVersion: 1 },
        normalizedModulePath: '/immutable/acme/runtime.mjs', loadMode: 'immutable-js',
      }) };
    await publishAgentRuntimeDaemonServiceAuthority({ ...authority, httpPort: 31002, capability: 'B'.repeat(43) });
    process.env.HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE = path;
    await writeStoredCredentialsForServerId(serverId, f.credentials);
    const runnerCredentials = { token: await auth.createToken(storage.account.id, { sessionId },
      { kind: 'ephemeral_session_runner', authority: 'session_runtime' }), encryption: null };
    // The daemon-control HTTP boundary exposes only its actual Machine catalog:
    // this external plugin is enabled in Home, not installed on a Machine.
    installClientMachineControlHttp(clientAction);
    let current = true;
    const capabilities: AgentRuntimeDaemonServiceRequestV1[] = [];
    const features = FeaturesResponseSchema.parse({ features: { sessions: { enabled: true } },
      capabilities: { serverIdentity: { serverIdentityId: storage.state.homeId } } });
    vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
      if (!init?.body) return Response.json(features);
      const request = AgentRuntimeDaemonServiceRequestV1Schema.parse(JSON.parse(String(init.body)));
      capabilities.push(request);
      expect(request.context).toEqual({ token: 'B'.repeat(43), sessionId });
      if (request.operation.kind !== 'action.execute') throw new Error('Expected Action capability');
      const outcome = await f.execute(request.operation, { sessionId, isCurrent: async () => current });
      return Response.json({ ok: true, result: { kind: 'action.execution', requestId: request.operation.requestId, outcome } });
    });
    const witness = { turnId: 'turn', inputId: 'input', userMessageSeq: 1, userMessageSeqs: [1], callerPermissionMode: 'default',
      causalPermissionAuthority: { kind: 'admittedSessionInputV1' as const, admittedPermissionCeiling: 'default' },
      agentStartCaller: { kind: 'session' as const, sessionId, starterDepth: 0, turnDepth: 0 } };
    const runtime = createHappierMcpServer({ sessionId,
      getServerBinding: () => ({ serverId, serverUrl: serverHttpBaseUrl }),
      getServerFeaturesSnapshot: () => ({ status: 'ready', provenance: 'authenticated', features }),
      rpcHandlerManager: new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain' }),
      updateMetadata() {}, getWorkDepth: () => 0, getHostTurnWorkDepth: () => 0, getPermissionMode: () => 'default',
      getActiveTurnAdmissionWitness: () => witness, getActiveTurnPermissionWitness: () => witness,
    }, { authorityScope: 'session', sessionCredentials: runnerCredentials, actionsSettingsProvider: f.actionsSettingsProvider });
    try {
      const invoke = () => runtime.executeTool({ toolName: 'action_execute', args: {
        actionId: 'action.invoke', input: { action: { pluginId: f.authoredAccount!.pluginId, localId: 'echo' }, input: { key: 'restricted' } },
      } });
      const outcome = await invoke();
      expect(capabilities[0]?.operation).toMatchObject({ kind: 'action.execute', actionId: 'action.spec.get' });
      expect(outcome, JSON.stringify(outcome)).toMatchObject({ ok: true, result: { key: 'restricted', surface: 'agent' } });
      expect(capabilities.some(request => request.operation.kind === 'action.execute' && request.operation.actionId === 'action.invoke')).toBe(true);
      expect(f.observations.some(observation => observation.path.includes('action.invoke/execution-authorization'))).toBe(false);
      const clientStart = capabilities.length;
      const clientOutcome = await runtime.executeTool({ toolName: 'action_execute', args: {
        actionId: 'action.invoke', input: { action: clientAction.action, input: {} },
      } });
      expect(clientOutcome, JSON.stringify(clientOutcome)).toMatchObject({ ok: true, result: { v: 1, kind: 'createTask', draftId: 'client-draft' } });
      expect(clientAction.effects()).toBe(1);
      expect(capabilities.slice(clientStart).every(request => request.operation.kind === 'action.execute'
        && request.operation.actionId === 'action.spec.get')).toBe(true);
      current = false;
      expect(await invoke()).toMatchObject({ ok: false, errorCode: 'target_unavailable' });
    } finally {
      await runtime.mcp.close();
      await removeAgentRuntimeDaemonServiceAuthorityIfOwned({ ...authority, capabilityDigest: hashPrivateBearer('B'.repeat(43)) });
      await clientAction.runtime.dispose();
      await f.close();
      process.env = previousEnv;
      reloadConfiguration();
    }
  });
});

it.each([503, 401, 403] as const)('keeps Home mint availability distinct from authorization denial (%s), then recovers', async status => {
  const f = await fixture();
  f.markInactive();
  try {
    f.setActionsSettings(normalizeActionsSettingsV1({ v: 1, actions: { 'session.archive': { disabledSurfaces: [] } } }));
    f.failAuthorization(status);
    const outcome = await f.execute(f.operation('session.archive', { sessionId: childId }), { sessionId, isCurrent: async () => true });
    expect(outcome).toMatchObject(status === 503
      ? { ok: false, errorCode: 'project_requester_home_unavailable' }
      : { ok: false, errorCode: 'target_unavailable', details: { reason: 'external_authorization_refused' } });
    expect(ActionExecuteFailureSchema.parse(outcome)).toEqual(outcome);
    expect(f.lifecycleEffects).toEqual([]);
    f.failAuthorization();
    expect(await f.execute(f.operation('session.archive', { sessionId: childId }), { sessionId, isCurrent: async () => true }))
      .toMatchObject({ ok: true });
  } finally { await f.close(); }
});

it('keeps cancellation distinct when Home authorization becomes unavailable', async () => {
  const f = await fixture();
  const controller = new AbortController();
  try {
    f.failAuthorization(503, () => controller.abort());
    expect(await f.execute(f.operation('session.archive', { sessionId: childId }), {
      sessionId, signal: controller.signal, isCurrent: async () => true,
    })).toMatchObject({ ok: false, errorCode: 'cancelled' });
    expect(f.lifecycleEffects).toEqual([]);
  } finally { await f.close(); }
});

it('admits cont6 inherited spawn through MCP, daemon custody and signed Home minting', async () => {
  const f = await fixture();
  const command = 'node /runtime/.runner-snapshots/inherited-spawn/dist/index.mjs';
  const runner = { pid: process.pid, processStartTimeMs: 23348,
    processCommandHash: hashProcessCommand(command), snapshotIdentity: 'snapshot:inherited-spawn' };
  processIdentity.mockResolvedValue({ pid: runner.pid, processStartTimeMs: runner.processStartTimeMs, command });
  const path = await createAgentRuntimeDaemonServiceAuthorityPath(configuration);
  const authority = { happyHomeDir: configuration.happyHomeDir, publicReleaseRing: configuration.publicReleaseRing,
    path, sessionId, runner, retainedAgent: createAgentSessionRunnerFactoryBinding({
      v: 1, pluginId: 'acme.plugin', pluginVersion: '1.2.3', agentId: 'acme-agent', localAgentId: 'acme-agent',
      sourceCustody: { kind: 'managed', immutableGenerationId: `sha256:${'1'.repeat(64)}`, installSource: 'localPath' },
      locator: { module: './runtime.mjs', export: 'createRuntime', runtimeApiVersion: 1 },
      normalizedModulePath: '/immutable/acme/runtime.mjs', loadMode: 'immutable-js',
    }) };
  await publishAgentRuntimeDaemonServiceAuthority({ ...authority, httpPort: 31002, capability: 'B'.repeat(43) });
  const previousAuthorityPath = process.env.HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE;
  process.env.HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE = path;
  const startContext = resolveCliAgentStartContextV1({ sessionId, machineId: storage.state.machineId,
    directory: '/tmp', backendTarget: resolveBackendTargetFromSessionMetadata({ flavor: 'codex' }),
    metadata: {}, starterDepth: 0, turnDepth: 0, callerPermissionMode: 'default', settings: accountSettingsParse({}),
    roles: resolveRolesSnapshotV1({ defaultEngine: { agentTargetKey: inheritedCodexInput.modelSelection.ref.agentTargetKey,
      modelId: inheritedCodexInput.modelSelection.ref.modelId } }),
  });
  if (!startContext) throw new Error('Missing real CLI caller facts');
  // Native process creation is the effect boundary. Keep both parsers, caller
  // projection, admission, requester producer and actual Home authorization real.
  const spawn = vi.fn<ActionExecutorDeps['sessionSpawnNew']>(async () => ({
    type: 'pending', retryWithSameCreationKey: true, outcome: 'accepted',
  }));
  const execute = createDaemonSessionAccountActionExecutor({ serverId, serverHttpBaseUrl,
    token: f.credentials.token, machineId: storage.state.machineId,
    prepareExternalActionAuthorization: ({ operation, sessionActionOrigin }) => f.prepare(operation, sessionActionOrigin),
    createExecutor: () => {
      const executor = createActionExecutor({ sessionSpawnNew: spawn, observeActionExecution: async () => {} } as unknown as ActionExecutorDeps);
      return { execute: (actionId, input, context) => executor.execute(actionId, input, {
        ...context, runtimeAccountId: storage.account.id, agentStartContext: startContext,
      }) };
    },
  });
  vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
    const request = AgentRuntimeDaemonServiceRequestV1Schema.parse(JSON.parse(String(init?.body)));
    expect(request.context).toEqual({ token: 'B'.repeat(43), sessionId });
    if (request.operation.kind === 'agent_start.policy.read') {
      // The runner-hosted MCP reads the requester's Account start policy from the daemon.
      const settings = accountSettingsParse({});
      return Response.json({ ok: true, result: { kind: 'agent_start.policy', policy: { workDepthLimit: settings.workDepthLimit,
        sessionAgentStartAllowListsV1: settings.sessionAgentStartAllowListsV1,
        sessionAgentSpawnPolicyV1: settings.sessionAgentSpawnPolicyV1 } } });
    }
    if (request.operation.kind !== 'action.execute') throw new Error('Expected Action envelope');
    const outcome = await execute(request.operation, { sessionId, isCurrent: async () => true });
    return Response.json({ ok: true, result: { kind: 'action.execution', requestId: request.operation.requestId, outcome } });
  });
  const witness = { turnId: 'turn', inputId: 'input', userMessageSeq: 1, userMessageSeqs: [1], callerPermissionMode: 'default',
    causalPermissionAuthority: { kind: 'admittedSessionInputV1' as const, admittedPermissionCeiling: 'default' },
    agentStartCaller: { kind: 'session' as const, sessionId, starterDepth: 0, turnDepth: 0 } };
  const runtime = createHappierMcpServer({ sessionId,
    getServerBinding: () => ({ serverId, serverUrl: serverHttpBaseUrl }),
    rpcHandlerManager: new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain' }),
    updateMetadata() {}, getWorkDepth: () => 0, getHostTurnWorkDepth: () => 0, getPermissionMode: () => 'default',
    getActiveTurnAdmissionWitness: () => witness, getActiveTurnPermissionWitness: () => witness,
  }, { authorityScope: 'session', actionsSettingsProvider: f.actionsSettingsProvider });
  const client = new Client({ name: 'inherited-spawn', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await runtime.mcp.connect(serverTransport);
    await client.connect(clientTransport);
    const response = CallToolResultSchema.parse(await client.callTool({ name: 'action_execute',
      arguments: { actionId: 'session.spawn_new', input: inheritedCodexInput } }));
    const content = response.content.find(block => block.type === 'text');
    if (content?.type !== 'text') throw new Error('Missing MCP result');
    expect(response.isError, content.text).not.toBe(true);
    expect(JSON.parse(content.text)).toMatchObject({ type: 'pending', outcome: 'accepted' });
    const child = spawn.mock.calls[0]?.[0];
    expect(SessionSpawnNewInputV2Schema.safeParse({ ...inheritedCodexInput, executionTarget: child?.executionTarget,
      agentTarget: child?.agentTarget, manager: child?.manager }).success).toBe(true);
    expect(child).toMatchObject({ executionTarget: { serverId, machineId: storage.state.machineId },
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } }, manager: { sessionId } });
    expect(f.observations).toContainEqual(expect.objectContaining({
      path: '/v1/actions/session.spawn_new/execution-authorization', status: 200,
    }));
    expect(f.observations).toContainEqual(expect.objectContaining({
      path: '/v1/actions/session.spawn_new/execution-authorization/verify', signed: true, bearer: false, status: 200,
    }));
  } finally {
    await client.close(); await runtime.mcp.close();
    await removeAgentRuntimeDaemonServiceAuthorityIfOwned({ ...authority, capabilityDigest: hashPrivateBearer('B'.repeat(43)) });
    if (previousAuthorityPath === undefined) delete process.env.HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE;
    else process.env.HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE = previousAuthorityPath;
    await f.close();
  }
});

it('reuses admitted Stop custody for signed observations and freshly verifies the native effect', async () => {
  const f = await fixture();
  const channel = await createRequesterCurrentnessSocketHarness();
  const installed = { version: 1 as const, installationId: storage.state.installationId, createdAt: 1,
    publicKey: Buffer.from(installation.publicKey).toString('base64url'),
    privateKey: Buffer.from(installation.secretKey).toString('base64url') };
  const localInstallation = vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue(installed);
  // Home feature delivery and installation storage are system boundaries.
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(FeaturesResponseSchema.parse({
    features: {}, capabilities: { serverIdentity: { serverIdentityId: storage.state.homeId } },
  })));
  let prepared: Awaited<ReturnType<typeof prepareInstalledRequesterAccountActionContext>> = null;
  try {
    const op = f.operation('session.stop', { sessionId: childId });
    const original = await f.prepare(op, { v: 1, caller: op.witness.agentStartCaller,
      sourceTurnId: 'turn', callerPermissionMode: null, requestId: op.requestId });
    if (!original) throw new Error('Missing original Stop root');
    const purpose = { kind: 'machine_rpc', method: RPC_METHODS.STOP_SESSION, params: { sessionId: childId } } as const;
    const sealed = sealExternalActionRequesterAccountContextV1({ authorization: original.authorization, purpose,
      credentials: encodeStoredCredentials(f.credentials), installationPublicKey: installation.publicKey, randomBytes: nacl.randomBytes });
    const admissionStart = f.observations.length;
    prepared = await prepareInstalledRequesterAccountActionContext({ authorization: sealed, purpose,
      machineId: storage.state.machineId, serverId, serverHttpBaseUrl,
      resolveCurrentMachineExecutionOriginContext: createCurrentMachineExecutionOriginContextResolver({
        serverUrl: serverHttpBaseUrl, resolveCurrentMachineId: () => storage.state.machineId,
      }),
      createExecutor: admitted => createCliActionExecutorFromCredentials({ credentials: admitted.credentials,
        serverId, serverApiUrl: serverHttpBaseUrl, serverIdentityId: storage.state.homeId, machineId: storage.state.machineId,
        pluginActionExecutionOwner: 'current_process', savedSecretOperationContext: admitted.savedSecretOperationContext }),
    });
    const custody = readRequesterAccountActionContext(prepared?.authorization);
    const http = prepared?.authorization.requesterHttpProjection;
    if (!prepared || !custody || !http) throw new Error('Missing installed Stop custody');
    const verifyReads = () => f.observations.slice(admissionStart).filter(row => row.path.endsWith('/execution-authorization/verify')).length;
    expect(verifyReads()).toBe(1);
    const query = { v: 1 as const, storage: 'active' as const, includeInactive: true, scope: 'all_accessible' as const,
      attention: 'any' as const, audiences: [], tagIds: [], underSessionId: sessionId };
    const headers = await http.createRequestHeaders({ effectActionId: 'session.stop', method: 'POST', path: '/v2/sessions/query', body: query });
    if (!headers) throw new Error('Missing signed subtree request');
    expect((await f.app.inject({ method: 'POST', url: '/v2/sessions/query', headers, payload: query })).statusCode).toBe(200);
    expect(verifyReads()).toBe(1);
    expect(await custody.isCurrent()).toBe(true);
    expect(verifyReads()).toBe(2);
    // Home revocation still denies both a freshly checked native effect and
    // an already-signed observation; admitted local custody cannot grant either.
    storage.state.bound = false;
    expect(await custody.isCurrent()).toBe(false);
    expect((await f.app.inject({ method: 'POST', url: '/v2/sessions/query', headers, payload: query })).statusCode).toBe(401);
    localInstallation.mockReturnValue({ ...installed, installationId: 'replaced' });
    expect(await http.createRequestHeaders({ effectActionId: 'session.stop', method: 'POST', path: '/v2/sessions/query', body: query })).toBeNull();
    localInstallation.mockReturnValue(installed);
    await channel.push(storage.account.id, { ...createAccountEncryptionCurrentnessFixture(), mode: 'e2ee' });
    expect(await http.createRequestHeaders({ effectActionId: 'session.stop', method: 'POST', path: '/v2/sessions/query', body: query })).toBeNull();
    await prepared.dispose();
    expect(await custody.isCurrent()).toBe(false);
  } finally { await prepared?.dispose(); await channel.close(); await f.close(); }
});

it('stops a led child through the real requester RPC receiver and preserves receiver refusals', async () => {
  const f = await fixture();
  const channel = await createRequesterCurrentnessSocketHarness();
  const effects: string[] = [];
  const receiverResults: unknown[] = [];
  const requesterResults: unknown[] = [];
  const rpc = new RpcHandlerManager({ scopePrefix: storage.state.machineId, localMachineId: storage.state.machineId,
    encryptionMode: 'plain', logger: () => {},
    // Home signature admission is exercised at the transport boundary below.
    authorizeRequest: async () => ({ ok: true }),
    prepareRequesterAccountContext: request => prepareRequesterAccountActionContext({ ...request,
      purpose: request.purpose ?? { kind: 'external_action' },
      machineId: storage.state.machineId, installationId: storage.state.installationId,
      installationPrivateKey: installation.secretKey, serverId, serverIdentityId: storage.state.homeId,
      serverHttpBaseUrl, isCurrent: async () => storage.state.bound,
      createExecutor: admitted => {
        const executor = createCliActionExecutorFromCredentials({ credentials: admitted.credentials,
          serverId, serverApiUrl: serverHttpBaseUrl, serverIdentityId: storage.state.homeId, machineId: storage.state.machineId,
          pluginActionExecutionOwner: 'current_process',
          readCredentials: async () => await admitted.isCurrent() ? admitted.credentials : null,
          savedSecretOperationContext: admitted.savedSecretOperationContext,
          actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1(admitted.accountSettingsContext.settings.actionsSettingsV1),
            getAccountSettings: () => admitted.accountSettingsContext.settings },
          externalActionMachineRequestPrivateKey: installation.secretKey,
          externalActionMachineInstallationId: storage.state.installationId,
          // Use the installed Machine transport, rather than replacing the
          // Session Stop service. Only physical process delivery is substituted.
          machineActionDirectTargetTransport: { machineId: storage.state.machineId,
            invoke: async (method, request) => {
              expect(method).toBe(RPC_METHODS.STOP_SESSION);
              const receiver = createMachineSessionStopLifecycleActionExecutor({ stopSession: async target => {
                effects.push(target); f.markInactive(); return { status: 'stopped' };
              } });
              const result = await receiver.execute('session.stop', request);
              if (!result.ok) throw new Error(result.errorCode);
              return result.result;
            },
          },
        });
        return { execute: async (id, input, context) => {
          const result = await executor.execute(id, input, context);
          requesterResults.push(result);
          return result;
        } };
      },
    }),
  });
  registerSessionLifecycleRpcHandlers({ rpcHandlerManager: rpc, scopes: MACHINE_SESSION_STOP_RPC_SCOPES,
    actionExecutor: createMachineSessionStopLifecycleActionExecutor({ stopSession: async target => {
      effects.push(target); f.markInactive(); return { status: 'stopped' };
    } }),
  });
  let receiverDisabled = false;
  let receiverMembershipLost = false;
  const transport = vi.spyOn(machineRpc, 'callMachineRpc').mockImplementation(async request => {
    if (transport.mock.calls.length > 1) throw new Error('Stop recursively redispatched to its receiver');
    const external = request.externalAction;
    if (!external) throw new Error('Missing original stop authority');
    const authorization = external.context.externalActionExecutionAuthorization;
    if (!authorization) throw new Error('Missing original stop root');
    if (!(external.privateKey instanceof Uint8Array)) throw new Error('Expected fixture installation key');
    const method = `${request.machineId}:${request.method}`;
    const execution = { v: 1 as const, authorization, effectActionId: external.effectActionId,
      target: authorization.binding.target, installationId: external.installationId,
      machineSignature: signExternalActionMachineRpcRequestV1({ authorizationToken: authorization.token,
        effectActionId: external.effectActionId, target: authorization.binding.target,
        installationId: external.installationId, method, requestId: 'stop-receiver', params: request.request,
        privateKey: external.privateKey }) };
    expect(await verifyExternalActionMachineRpcExecution(execution, { method, params: request.request,
      requestId: 'stop-receiver', resolveCurrentSessionMachine: async () => storage.state.machineId })).not.toBeNull();
    const root = sealExternalActionRequesterAccountContextV1({ authorization,
      credentials: encodeStoredCredentials(f.credentials), purpose: { kind: 'machine_rpc', method: request.method, params: request.request },
      installationPublicKey: installation.publicKey, randomBytes: nacl.randomBytes });
    if (receiverDisabled) f.setActionsSettings(normalizeActionsSettingsV1({ v: 1,
      actions: { 'session.stop': { disabledSurfaces: ['agent'] } } }));
    if (receiverMembershipLost) f.members.clear();
    const result = await rpc.handleRequest({ method, params: request.request, requestId: 'stop-receiver',
      callerInputAuthorization: root, sessionActionOrigin: authorization.binding.sessionActionOrigin,
      callerAuthority: 'account_automation', machineAdmission: { actorAccountId: storage.account.id,
        custodianAccountId: storage.account.id, machineId: storage.state.machineId,
        installationId: storage.state.installationId, role: 'use', encryptionMode: 'plain' } });
    receiverResults.push(result);
    return result;
  });
  const run = () => f.execute(f.operation('session.stop', { sessionId: childId }), { sessionId, isCurrent: async () => true });
  const enable = () => f.setActionsSettings(normalizeActionsSettingsV1({ v: 1, actions: { 'session.stop': { disabledSurfaces: [] } } }));
  try {
    expect(await run()).toMatchObject({ ok: false, errorCode: 'action_disabled' });
    expect(effects).toEqual([]);
    enable();
    expect(await run(), JSON.stringify({ receiverResults, requesterResults })).toMatchObject({ ok: true, result: { stopped: true } });
    expect(effects).toEqual([childId]);
    expect(requesterResults).toContainEqual({ ok: true, result: { ok: true, sessionId: childId, stopped: true } });
    receiverDisabled = true;
    transport.mockClear();
    expect(await run()).toMatchObject({ ok: false, errorCode: 'action_disabled' });
    expect(effects).toEqual([childId]);
    receiverDisabled = false;
    receiverMembershipLost = true;
    enable();
    transport.mockClear();
    expect(await run()).toMatchObject({ ok: false, errorCode: 'unsupported_action', details: { cause: 'target_outside_led_subtree' } });
    expect(effects).toEqual([childId]);
  } finally { await channel.close(); await f.close(); }
});

it.each(['session.stop', 'session.archive', 'session.unarchive'] as const)(
  'admits only fresh led lifecycle targets through MCP and signed Home admission: %s', async actionId => {
  const f = await fixture();
  f.markInactive();
  const lifecycleDiagnostics = vi.spyOn(logger, 'warnLocalFile');
  if (actionId === 'session.unarchive') f.markChildArchived();
  // Defaults stay disabled. Only this isolated in-memory Account fixture opts in.
  expect(await f.execute(f.operation(actionId, { sessionId: childId }), { sessionId, isCurrent: async () => true }))
    .toMatchObject({ ok: false, errorCode: 'action_disabled' });
  f.setActionsSettings(normalizeActionsSettingsV1({ v: 1, actions: { [actionId]: { disabledSurfaces: [] } } }));
  const command = 'node /runtime/.runner-snapshots/signed-lifecycle/dist/index.mjs';
  const runner = { pid: process.pid, processStartTimeMs: 23347,
    processCommandHash: hashProcessCommand(command), snapshotIdentity: 'snapshot:signed-lifecycle' };
  processIdentity.mockResolvedValue({ pid: runner.pid, processStartTimeMs: runner.processStartTimeMs, command });
  const path = await createAgentRuntimeDaemonServiceAuthorityPath(configuration);
  const authority = { happyHomeDir: configuration.happyHomeDir, publicReleaseRing: configuration.publicReleaseRing,
    path, sessionId, runner, retainedAgent: createAgentSessionRunnerFactoryBinding({
      v: 1, pluginId: 'acme.plugin', pluginVersion: '1.2.3', agentId: 'acme-agent', localAgentId: 'acme-agent',
      sourceCustody: { kind: 'managed', immutableGenerationId: `sha256:${'1'.repeat(64)}`, installSource: 'localPath' },
      locator: { module: './runtime.mjs', export: 'createRuntime', runtimeApiVersion: 1 },
      normalizedModulePath: '/immutable/acme/runtime.mjs', loadMode: 'immutable-js',
    }) };
  await publishAgentRuntimeDaemonServiceAuthority({ ...authority, httpPort: 31002, capability: 'B'.repeat(43) });
  const previousAuthorityPath = process.env.HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE;
  process.env.HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE = path;
  const stop = vi.spyOn(machineRpc, 'callMachineRpc').mockResolvedValue({ status: 'not_found' });
  vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
    const request = AgentRuntimeDaemonServiceRequestV1Schema.parse(JSON.parse(String(init?.body)));
    expect(request.context).toEqual({ token: 'B'.repeat(43), sessionId });
    if (request.operation.kind !== 'action.execute') throw new Error('Expected Action envelope');
    const outcome = await f.execute(request.operation, { sessionId, isCurrent: async () => true });
    return Response.json({ ok: true, result: { kind: 'action.execution', requestId: request.operation.requestId, outcome } });
  });
  const witness = { turnId: 'turn', inputId: 'input', userMessageSeq: 1, userMessageSeqs: [1],
    callerPermissionMode: 'default',
    causalPermissionAuthority: { kind: 'admittedSessionInputV1' as const, admittedPermissionCeiling: 'default' },
    agentStartCaller: { kind: 'session' as const, sessionId, starterDepth: 0, turnDepth: 0 } };
  const runtime = createHappierMcpServer({ sessionId,
    getServerBinding: () => ({ serverId, serverUrl: serverHttpBaseUrl }),
    rpcHandlerManager: new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain' }),
    updateMetadata() {}, getWorkDepth: () => 0, getHostTurnWorkDepth: () => 0,
    getPermissionMode: () => 'default',
    getActiveTurnAdmissionWitness: () => witness,
    getActiveTurnPermissionWitness: () => witness,
  }, { authorityScope: 'session', actionsSettingsProvider: f.actionsSettingsProvider });
  const client = new Client({ name: 'signed-lifecycle', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const invoke = async (target: string, alsoArchiveReports?: boolean) => {
    const result = CallToolResultSchema.parse(await client.callTool({ name: 'action_execute',
      arguments: { actionId, input: { sessionId: target, ...(alsoArchiveReports === undefined ? {} : { alsoArchiveReports }) } } }));
    const content = result.content.find(block => block.type === 'text');
    if (content?.type !== 'text') throw new Error('Missing MCP result');
    return { failed: result.isError === true, value: JSON.parse(content.text) as unknown };
  };
  const effectCount = () => stop.mock.calls.length + f.lifecycleEffects.length;
  try {
    await runtime.mcp.connect(serverTransport);
    await client.connect(clientTransport);
    expect(effectCount()).toBe(0);
    const admissionStart = f.observations.length;
    if (actionId === 'session.archive') {
      f.markSessionActive(sessionId);
      const selfArchive = await invoke(sessionId);
      expect(selfArchive, JSON.stringify({ selfArchive, observations: f.observations.slice(-10) }))
        .toMatchObject({ failed: true, value: { errorCode: 'unsupported_action', error: 'self_stop_forbidden' } });
      expect(effectCount()).toBe(0);
      f.markSessionInactive(sessionId);
      const grandchildId = 'c123456789012345678901232';
      f.addNestedReport(grandchildId);
      f.markSessionActive(grandchildId);
      const stopAdmissions: Array<{ root: string; effect: string; admitted: boolean }> = [];
      stop.mockImplementation(async request => {
        if (request.method !== RPC_METHODS.STOP_SESSION) throw new Error('Unexpected cascade machine request');
        const external = request.externalAction;
        const authorization = external?.context.externalActionExecutionAuthorization;
        if (!external || !authorization || !(external.privateKey instanceof Uint8Array)) throw new Error('Missing cascade Stop root');
        const method = `${request.machineId}:${request.method}`;
        const requestId = 'archive-cascade-stop';
        const execution = { v: 1 as const, authorization, effectActionId: external.effectActionId,
          target: authorization.binding.target, installationId: external.installationId,
          machineSignature: signExternalActionMachineRpcRequestV1({ authorizationToken: authorization.token,
            effectActionId: external.effectActionId, target: authorization.binding.target,
            installationId: external.installationId, method, requestId, params: request.request,
            privateKey: external.privateKey }) };
        const admitted = await verifyExternalActionMachineRpcExecution(execution, { method, params: request.request,
          requestId, resolveCurrentSessionMachine: async () => storage.state.machineId });
        stopAdmissions.push({ root: authorization.binding.actionId, effect: external.effectActionId, admitted: admitted !== null });
        expect(admitted).not.toBeNull();
        f.markSessionInactive(grandchildId);
        return { status: 'stopped' };
      });
      const readEdges = storage.db.sessionFollowEdge.findMany;
      // Extend only the real database boundary: recursive membership stays with
      // the Home's canonical subtree reader, including this second-level edge.
      vi.spyOn(storage.db.sessionFollowEdge, 'findMany').mockImplementation(async query => {
        const existing = await readEdges(query);
        return query.where.relation === 'manager' && query.where.destinationSessionId.in.includes(childId)
          ? [...existing, { sourceSessionId: grandchildId }] : existing;
      });
      const cascade = await invoke(sessionId, true);
      expect(cascade, JSON.stringify(cascade)).toMatchObject({ failed: false, value: { success: true, sessionId,
        reports: [{ sessionId: childId, status: 'archived' }] } });
      expect(getActionSpec('session.archive').outputSchema.parse(cascade.value)).toEqual(cascade.value);
      expect(f.lifecycleEffects).not.toContain(`/v2/sessions/${grandchildId}/archive`);
      const nestedCascade = await invoke(childId, true);
      expect(nestedCascade, JSON.stringify({ nestedCascade, observations: f.observations.slice(-12), stopAdmissions })).toMatchObject({ failed: false, value: { success: true, sessionId: childId,
        reports: [{ sessionId: grandchildId, status: 'archived' }] } });
      expect(getActionSpec('session.archive').outputSchema.parse(nestedCascade.value)).toEqual(nestedCascade.value);
      expect(stopAdmissions).toEqual([{ root: 'session.archive', effect: 'session.stop', admitted: true }]);
      expect(f.lifecycleEffects).toContain(`/v2/sessions/${grandchildId}/archive`);
    }
    for (const target of actionId === 'session.stop' ? [childId] : [sessionId, childId]) {
      const result = await invoke(target);
      expect(result.failed, JSON.stringify({ result, diagnostics: lifecycleDiagnostics.mock.calls,
        observations: f.observations.slice(-8) })).toBe(false);
      expect(result.value).toMatchObject(actionId === 'session.stop'
        ? { ok: true, sessionId: target, stopOutcome: { status: 'already_stopped' } }
        : actionId === 'session.archive' ? { success: true, sessionId: target, archivedAt: 123 }
        : { ok: true, sessionId: target, archivedAt: null });
    }
    expect(lifecycleDiagnostics.mock.calls).toEqual(expect.arrayContaining([
      ['[external-action-stage]', expect.objectContaining({ actionId,
        stage: 'action_execution.phase', phase: 'caller_session', elapsedMs: expect.any(Number) })],
      ['[external-action-stage]', expect.objectContaining({ actionId, stage: 'session_action.execute.end' })],
      ['[external-action-stage]', expect.objectContaining({ actionId,
        stage: actionId === 'session.stop' ? 'stop.owner_rpc.end' : 'session_archive.http.end' })],
    ]));
    // Lifecycle scope needs fresh caller/subtree facts, not Role authoring or
    // Agent launch catalogs. Each catalog read fans out through requester custody.
    expect(f.observations.slice(admissionStart).filter(row =>
      row.path === '/v1/artifacts' || row.path === '/v1/account/entity-rows/acp'
      || row.path === '/v1/account/entity-rows/prompt-library')).toEqual([]);
    const signed = f.observations.filter(row => row.signed);
    expect(signed.some(row => row.path === '/v2/sessions/query')).toBe(true);
    expect(signed.every(row => !row.bearer && (row.status === 200
      || actionId === 'session.archive' && row.path.endsWith('/archive') && row.status === 409)), JSON.stringify(signed)).toBe(true);
    const targetReads = f.observations.filter(row => row.path === `/v2/sessions/${childId}`);
    expect(targetReads.length).toBeGreaterThan(0);
    expect(targetReads.every(row => row.signed && !row.bearer)).toBe(true);
    if (actionId === 'session.stop') {
      expect(stop).toHaveBeenCalledWith(expect.objectContaining({ method: RPC_METHODS.STOP_SESSION,
        request: { sessionId: childId }, externalAction: expect.objectContaining({ effectActionId: actionId }) }));
    } else {
      expect(f.observations).toContainEqual(expect.objectContaining({ path: `/v2/sessions/${childId}/${actionId === 'session.archive' ? 'archive' : 'unarchive'}`,
        status: 200, signed: true, bearer: false }));
    }
    const effects = effectCount();
    f.members.clear();
    expect(await invoke(childId)).toMatchObject({ failed: true, value: { errorCode: 'unsupported_action', details: { cause: 'target_outside_led_subtree' } } });
    expect(await invoke('c123456789012345678901239')).toMatchObject({ failed: true, value: { errorCode: 'unsupported_action' } });
    expect(effectCount()).toBe(effects);
    f.members.add(childId);
    f.setActionsSettings(normalizeActionsSettingsV1({ v: 1,
      actions: { [actionId]: { approvalRequiredSurfaces: ['agent'] } } }));
    expect(await invoke(childId)).toMatchObject({ failed: true });
    expect(effectCount()).toBe(effects);
    f.setActionsSettings(normalizeActionsSettingsV1({ v: 1, actions: { [actionId]: { disabledSurfaces: [] } } }));
    storage.state.bound = false;
    expect(await invoke(childId)).toMatchObject({ failed: true });
    expect(effectCount()).toBe(effects);
  } finally {
    await client.close();
    await runtime.mcp.close();
    await removeAgentRuntimeDaemonServiceAuthorityIfOwned({ ...authority, capabilityDigest: hashPrivateBearer('B'.repeat(43)) });
    if (previousAuthorityPath === undefined) delete process.env.HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE;
    else process.env.HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE = previousAuthorityPath;
    await f.close();
  }
});

it.each(['active', 'archived'] as const)(
  'retains the native status Action through a transient %s subtree read inside its admitted lifetime', async storage => {
  const f = await fixture();
  const controller = new AbortController();
  f.failNextSubtree(storage, 503);
  try {
    const run = () => f.execute(f.operation('session.status.get', { sessionId: childId }),
      { sessionId, isCurrent: async () => true, signal: controller.signal });
    expect(await run()).toMatchObject({ ok: true, result: { session: { id: childId } } });
    const queries = f.observations.filter(row => row.path === '/v2/sessions/query');
    expect(queries.some(row => row.status === 503)).toBe(true);
    expect(queries.some(row => row.status === 200)).toBe(true);
    expect(queries.every(row => row.signed && !row.bearer)).toBe(true);
    // Recovery observes membership again; an earlier successful read is not a grant.
    f.members.clear();
    expect(await run()).toMatchObject({ ok: false, errorCode: 'unsupported_action',
      details: { cause: 'target_outside_led_subtree' } });
  } finally { controller.abort(); await f.close(); }
});

it('keeps definitive subtree denial terminal and honours cancellation during observation', async () => {
  const controller = new AbortController();
  const f = await fixture(1, async () => { if (cancelRead) controller.abort(); });
  let cancelRead = false;
  const run = () => f.execute(f.operation('session.status.get', { sessionId: childId }),
    { sessionId, isCurrent: async () => true, signal: controller.signal });
  try {
    f.failNextSubtree('active', 403);
    expect(await run()).toMatchObject({ ok: false, errorCode: 'unsupported_action',
      details: { cause: 'subtree_observation_unavailable' } });
    const denied = f.observations.filter(row => row.path === '/v2/sessions/query');
    expect(denied).toHaveLength(2);
    expect(denied.some(row => row.status === 403)).toBe(true);
    cancelRead = true;
    f.failNextSubtree('active', 503);
    expect(await run()).toMatchObject({ ok: false, errorCode: 'cancelled' });
    expect(f.lifecycleEffects).toEqual([]);
  } finally { controller.abort(); await f.close(); }
});

it.each([false, true])('resolves one lifecycle caller snapshot per Action while reobserving led membership (direct=%s)', async direct => {
  const f = await fixture(1, undefined, direct);
  f.markInactive();
  f.setActionsSettings(normalizeActionsSettingsV1({ v: 1,
    actions: { 'session.archive': { disabledSurfaces: [] } } }));
  const diagnostics = vi.spyOn(logger, 'warnLocalFile');
  const callerPhases = () => diagnostics.mock.calls.flatMap(([label, data]) => label === '[external-action-stage]'
    && data && typeof data === 'object' && 'phase' in data && data.phase === 'caller_session' && 'elapsedMs' in data
    ? [data.elapsedMs] : []);
  const run = () => f.execute({ ...f.operation('session.archive', { sessionId: childId }),
    requestId: '11600000-0000-4000-8000-000000000001' }, { sessionId, isCurrent: async () => true });
  try {
    expect(await run()).toMatchObject({ ok: true });
    console.info('DF116 caller snapshot elapsedMs', { direct, phases: callerPhases() });
    expect(callerPhases()).toHaveLength(1);
    expect(f.observations.filter(row => row.path === '/v2/sessions/query').length).toBeGreaterThan(2);
    f.members.clear();
    expect(await run()).toMatchObject({ ok: false, errorCode: 'unsupported_action',
      details: { cause: 'target_outside_led_subtree' } });
    expect(f.lifecycleEffects).toHaveLength(1);
    f.members.add(childId);
    f.omitCallerWorkspace();
    expect(await run()).toMatchObject({ ok: false, details: { cause: 'caller_context_unavailable' } });
    expect(f.lifecycleEffects).toHaveLength(1);
  } finally { await f.close(); }
});

it.each(['session.stop', 'session.archive', 'session.unarchive'] as const)(
  'reports unavailable lifecycle scope as retryable without authorizing an effect: %s', async actionId => {
  const f = await fixture();
  const stop = vi.spyOn(machineRpc, 'callMachineRpc').mockResolvedValue({ status: 'not_found' });
  f.markInactive();
  f.setActionsSettings(normalizeActionsSettingsV1({ v: 1, actions: { [actionId]: { disabledSurfaces: [] } } }));
  f.refuseSubtree('archived');
  try {
    const failure = ActionExecuteFailureSchema.parse(await f.execute(f.operation(actionId, { sessionId: childId }),
      { sessionId, isCurrent: async () => true }));
    expect(ActionCurrentSessionScopeFailureDetailsV1Schema.parse(failure.details))
      .toEqual({ cause: 'subtree_observation_unavailable', retryable: true });
    expect(failure)
      .toMatchObject({ ok: false, errorCode: 'target_unavailable',
        details: { cause: 'subtree_observation_unavailable', retryable: true } });
    expect(stop).not.toHaveBeenCalled();
    expect(f.lifecycleEffects).toEqual([]);
    f.allowSubtree();
    expect(await f.execute(f.operation(actionId, { sessionId: childId }), { sessionId, isCurrent: async () => true }))
      .toMatchObject({ ok: true });
  } finally { await f.close(); }
});

it('overlaps independent active and archived Home scope reads without skipping either corpus', async () => {
  let inFlight = 0;
  let maximumInFlight = 0;
  const f = await fixture(1, async () => {
    maximumInFlight = Math.max(maximumInFlight, ++inFlight);
    await new Promise(resolve => setTimeout(resolve, 20));
    inFlight--;
  });
  f.markInactive();
  f.markChildArchived();
  f.setActionsSettings(normalizeActionsSettingsV1({ v: 1,
    actions: { 'session.unarchive': { disabledSurfaces: [] } } }));
  try {
    expect(await f.execute(f.operation('session.unarchive', { sessionId: childId }), { sessionId, isCurrent: async () => true }))
      .toMatchObject({ ok: true });
    expect(maximumInFlight).toBe(2);
    expect(inFlight).toBe(0);
    expect(f.lifecycleEffects).toEqual([`/v2/sessions/${childId}/unarchive`]);
  } finally { await f.close(); }
});

it.each([
  { actionId: 'session.status.get', metadataLayout: 0 },
  { actionId: 'session.messages.recent.get', metadataLayout: 0 },
  { actionId: 'session.status.get', metadataLayout: 1 },
  { actionId: 'session.messages.recent.get', metadataLayout: 1 },
] as const)(
  'admits fresh subtree observation through real caller resolution: $actionId, layout $metadataLayout', async ({ actionId, metadataLayout }) => {
  const f = await fixture(metadataLayout);
  try {
    const run = () => f.execute(f.operation(actionId, { sessionId: childId }), { sessionId, isCurrent: async () => true });
    const result = await run();
    expect(result, JSON.stringify({ result, observations: f.observations })).toMatchObject(actionId === 'session.status.get'
      ? { ok: true, result: { session: { id: childId } } }
      : { ok: true, result: { sessionId: childId, items: [{ text: 'Child ready' }] } });
    const queries = f.observations.filter(row => row.path === '/v2/sessions/query');
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.every(row => row.status === 200 && row.signed && !row.bearer)).toBe(true);
    const diagnostics = vi.spyOn(logger, 'warnLocalFile');
    f.members.clear();
    expect(await run()).toMatchObject({ ok: false, errorCode: 'unsupported_action',
      details: { cause: 'target_outside_led_subtree' } });
    f.refuseSubtree();
    expect(await run()).toMatchObject({ ok: false, errorCode: 'unsupported_action',
      details: { cause: 'subtree_observation_unavailable' } });
    f.omitCallerWorkspace();
    expect(await run()).toMatchObject({ ok: false, errorCode: 'unsupported_action',
      details: { cause: 'caller_context_unavailable' } });
    expect(diagnostics).toHaveBeenCalledWith('[Session Account Action] Refused', expect.objectContaining({
      errorCode: 'unsupported_action', scopeFailureCause: 'caller_context_unavailable',
      refusalPhase: 'agent_start_context', refusalReason: 'caller_workspace_unavailable',
    }));
    expect(diagnostics).toHaveBeenCalledWith('[Session Account Action] Refused', expect.objectContaining({
      errorCode: 'unsupported_action', scopeFailureCause: 'subtree_observation_unavailable',
    }));
    expect(JSON.stringify(diagnostics.mock.calls)).not.toContain('private-error-body');
  } finally { await f.close(); }
});

it('admits child reads from the native factory witness through real caller resolution', async () => {
  const f = await fixture();
  const agentId = 'native-reader';
  const contributions = createExternalContributionFixtures(agentId);
  const listeners = new Set<(event: AgentSessionRuntimeEvent) => void>();
  let permissionMode: 'default' | 'read-only' | undefined = 'default';
  let sequence = 0;
  // The vendor runtime is the external boundary. Native host witness ownership,
  // daemon execution, caller reconstruction and signed Home reads remain real.
  const native: AgentSessionRuntime = {
    send: async request => {
      for (const listener of listeners) {
        listener({ kind: 'input-accepted', sessionId, sequence: ++sequence, emittedAtMs: 1,
          inputIds: request.inputIds, delivery: request.delivery });
        listener({ kind: 'turn-start', sessionId, sequence: ++sequence, emittedAtMs: 2,
          turnId: request.delivery.turnId, startedBy: 'host' });
      }
      return { status: 'admitted' };
    },
    watch: listener => { listeners.add(listener); return { dispose: () => { listeners.delete(listener); } }; },
    dispose() {},
  };
  const plan = await createNativeAgentRuntimeSessionPlanFixture({
    runtime: { sessions: { open: async () => native } },
    lease: createLease(agentId), backend: contributions.backend, agent: contributions.agent,
    createSessionHostServiceOwners,
    sessionInput: buildPluginSessionBindingInput({ credentials: f.credentials, directory: '/workspace' }),
  });
  // Canonical factory testkit supplies the process/transport shell for this host.
  const created = await plan.config.createSessionRuntime({ directory: '/workspace', metadata: {},
    machineId: storage.state.machineId, session: createNativeSessionClientTestPort(sessionId),
    transcriptSession: {}, messageBuffer: {}, mcpServers: {}, permissionHandler: {},
    getPermissionMode: () => permissionMode, setThinking() {}, memoryRecallGuidanceEnabled: false,
  } as never);
  const unsubscribe = created.operations.subscribeRuntimeEvents(() => undefined);
  try {
    await created.operations.sendTurnPrompt('Read own child', { turnId: 'native-read-turn', localId: 'native-read-input',
      userMessageSeq: 1, userMessageSeqs: [1], agentStartCaller: { kind: 'session', sessionId, starterDepth: 0, turnDepth: 0 },
      causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'read-only' } });
    const invoke = async (actionId: 'session.status.get' | 'session.messages.recent.get') => {
      const witness = created.operations.readActiveTurnAdmissionWitness?.();
      if (!witness) throw new Error('Missing active native host witness');
      return await f.execute({ ...f.operation(actionId, { sessionId: childId }),
        witness: projectAgentRuntimeDaemonServiceTurnWitnessV1(witness) }, { sessionId, isCurrent: async () => true });
    };
    const status = await invoke('session.status.get');
    expect(status, JSON.stringify(status)).toMatchObject({ ok: true, result: { session: { id: childId } } });
    permissionMode = 'read-only';
    expect(await invoke('session.messages.recent.get')).toMatchObject({ ok: true,
      result: { sessionId: childId, items: [{ text: 'Child ready' }] } });
    const queries = f.observations.filter(row => row.path === '/v2/sessions/query');
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.every(row => row.status === 200 && row.signed && !row.bearer)).toBe(true);
    f.members.clear();
    expect(await invoke('session.status.get')).toMatchObject({ ok: false, errorCode: 'unsupported_action',
      details: { cause: 'target_outside_led_subtree' } });
    f.members.add(childId);
    permissionMode = undefined;
    expect(await invoke('session.status.get')).toMatchObject({ ok: false, errorCode: 'unsupported_action',
      details: { cause: 'caller_context_unavailable' } });
  } finally {
    unsubscribe?.();
    await created.operations.resetOrDisposeRuntime();
    await f.close();
  }
});

it.each(['session.status.get', 'session.messages.recent.get', 'session.stop', 'session.archive', 'session.unarchive'] as const)(
  'signs the policy subtree read as %s at the production list owner', async actionId => {
  const f = await fixture();
  try {
    const op = f.operation(actionId, { sessionId: childId });
    const prepared = await f.prepare(op, { v: 1, caller: op.witness.agentStartCaller,
      sourceTurnId: 'turn', callerPermissionMode: null, requestId: op.requestId });
    if (!prepared) throw new Error('Missing original root');
    const { sessionList: list } = createSessionListActionDeps({ credentials: f.credentials, serverId,
      serverIdentityId: storage.state.homeId, serverHttpBaseUrl,
      resolveAccountSettings: () => accountSettingsParse({}),
      externalActionMachineRequestPrivateKey: installation.secretKey, externalActionMachineInstallationId: storage.state.installationId });
    const query = SessionListQueryV1Schema.parse({ v: 1, storage: 'active', includeInactive: true,
      scope: 'all_accessible', attention: 'any', audiences: [], tagIds: [], underSessionId: sessionId });
    const context = { surface: 'agent' as const, defaultSessionId: sessionId, serverId,
      externalActionExecutionAuthorization: prepared.authorization, externalActionTarget: prepared.target };
    const result = parseSessionListQueryActionResultV1(await list({ context, query }));
    expect(result, JSON.stringify(f.observations)).toMatchObject({ sessions: [{ id: childId }], hasNext: false });
    const signed = f.observations.filter(row => row.signed);
    expect(signed.length).toBeGreaterThan(0);
    expect(signed.every(row => row.status === 200 && !row.bearer)).toBe(true);
    for (const path of [`/v2/sessions/${childId}`,
      ...(actionId === 'session.messages.recent.get' ? [`/v1/sessions/${childId}/messages`] : [])]) {
      const authorization = resolveExternalActionServerRequestHeaders({ context, effectActionId: actionId, method: 'GET', path,
        daemonToken: f.credentials.token, serverIdentityId: storage.state.homeId,
        privateKey: installation.secretKey, installationId: storage.state.installationId });
      if (!authorization.ok) throw new Error('Missing reader signature');
      const response = await f.app.inject({ method: 'GET', url: path, headers: authorization.headers });
      expect(response.statusCode, JSON.stringify(f.observations)).toBe(200);
    }
    if (actionId === 'session.stop' || actionId === 'session.archive' || actionId === 'session.unarchive') {
      // Native Machine RPC must read its exact content codec before it can emit
      // the lifecycle effect. Use the production Machine HTTP signature producer;
      // the MCP lifecycle test substitutes that process/transport boundary.
      const readMachine = (machineId: string) => {
        const path = `/v1/machines/${encodeURIComponent(machineId)}`;
        const headers = createExternalActionAuthorizedRequestHeaders({ authorization: prepared.authorization,
          effectActionId: actionId, target: prepared.target, installationId: storage.state.installationId,
          method: 'GET', path, privateKey: installation.secretKey });
        return f.app.inject({ method: 'GET', url: path, headers });
      };
      expect((await readMachine(storage.state.machineId)).statusCode, JSON.stringify(f.observations)).toBe(200);
      expect((await readMachine('another-machine')).statusCode).toBe(401);
      storage.state.bound = false;
      expect((await readMachine(storage.state.machineId)).statusCode).toBe(401);
      storage.state.bound = true;
      const path = `/v2/sessions/${childId}/${actionId === 'session.archive' ? 'unarchive' : 'archive'}`;
      const body = {};
      const headers = resolveExternalActionServerRequestHeaders({ context, effectActionId: actionId,
        method: 'POST', path, body, daemonToken: f.credentials.token, serverIdentityId: storage.state.homeId,
        privateKey: installation.secretKey, installationId: storage.state.installationId });
      if (!headers.ok) throw new Error('Missing lifecycle signature');
      expect((await f.app.inject({ method: 'POST', url: path, payload: body, headers: headers.headers })).statusCode).toBe(401);
    }
    if (actionId === 'session.stop' || actionId === 'session.archive') {
      const method = `${storage.state.machineId}:${RPC_METHODS.STOP_SESSION}`;
      const params = { sessionId: childId };
      const execution = { v: 1 as const, authorization: prepared.authorization, effectActionId: 'session.stop',
        target: prepared.target, installationId: storage.state.installationId,
        machineSignature: signExternalActionMachineRpcRequestV1({ authorizationToken: prepared.authorization.token,
          effectActionId: 'session.stop', target: prepared.target, installationId: storage.state.installationId,
          method, requestId: op.requestId, params, privateKey: installation.secretKey }) };
      expect(await verifyExternalActionMachineRpcExecution(execution, { method, params, requestId: op.requestId,
        resolveCurrentSessionMachine: async () => storage.state.bound ? storage.state.machineId : null })).not.toBeNull();
      expect(await verifyExternalActionMachineRpcExecution(execution, { method,
        params: { sessionId: sessionId }, requestId: op.requestId,
        resolveCurrentSessionMachine: async () => storage.state.machineId })).toBeNull();
    }
    const signedQuery = async (body: unknown, effectActionId = op.actionId) => {
      const authorization = resolveExternalActionServerRequestHeaders({ context,
        effectActionId, method: 'POST', path: '/v2/sessions/query', body, daemonToken: f.credentials.token,
        serverIdentityId: storage.state.homeId, privateKey: installation.secretKey, installationId: storage.state.installationId });
      if (!authorization.ok) throw new Error('Missing query signature');
      return f.app.inject({ method: 'POST', url: '/v2/sessions/query', payload: body, headers: authorization.headers });
    };
    const { underSessionId: _root, ...unscopedQuery } = query;
    // Every root that declares a sessionTarget operand (93a9ea0340) prepares its
    // selector under the same signed root through isSessionTargetPreparationHttpPurpose,
    // so an unscoped query is admitted; native resource access and the exact effect
    // target (checked below and by the lifecycle purpose) remain independently enforced.
    expect((await signedQuery(unscopedQuery)).statusCode).toBe(200);
    if (actionId === 'session.status.get') {
      expect((await signedQuery({ ...query, underSessionId: childId })).statusCode).toBe(200);
    }
    if (isLedSubtreeSessionLifecycleActionId(actionId)) {
      // The unchanged lifecycle root may observe a still-led nested cascade.
      expect((await signedQuery({ ...query, underSessionId: childId })).statusCode).toBe(200);
      if (actionId === 'session.archive') {
        // The named Stop phase is admitted only by the narrower subtree purpose.
        expect((await signedQuery({ ...query, underSessionId: childId }, 'session.stop')).statusCode).toBe(200);
        f.members.delete(childId);
        expect((await signedQuery({ ...query, underSessionId: childId }, 'session.stop')).statusCode).toBe(401);
        f.members.add(childId);
      }
    }
    // A different effect Action never borrows the root's preparation admission.
    const refused = await signedQuery(query, 'session.list');
    expect(refused.statusCode).toBe(401);
    expect(refused.json()).toMatchObject({ error: 'invalid_token' });
    storage.state.bound = false;
    expect((await signedQuery(query)).statusCode).toBe(401);
  } finally { await f.close(); }
});

it.each(['session.spawn_new', 'follow.set', 'session.manager.set'] as const)(
  'uses the original %s root for post-commit source/destination transport reads', async actionId => {
  const f = await fixture();
  try {
    const sourceSessionId = actionId === 'session.manager.set' ? sessionId : childId;
    const destinationSessionId = actionId === 'session.manager.set' ? childId : sessionId;
    const operation = f.operation(actionId, actionId === 'session.spawn_new'
      ? { creationKey: 'signed-source-key-child', executionTarget: { serverId, machineId: storage.state.machineId },
        directory: { kind: 'path', path: '/workspace' },
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
        manager: { sessionId } }
      : actionId === 'follow.set' ? { receiver: { kind: 'session', sessionId: destinationSessionId },
        source: { kind: 'session', sessionId: sourceSessionId }, policy: { preset: 'important' } }
        : { sessionId: sourceSessionId, leadSessionId: destinationSessionId, expectedLeadSessionId: null });
    const prepared = await f.prepare(operation, { v: 1, caller: operation.witness.agentStartCaller,
      sourceTurnId: 'turn', callerPermissionMode: null, requestId: operation.requestId });
    expect(prepared, JSON.stringify(f.observations)).not.toBeNull();
    if (!prepared) throw new Error('Missing Home root');
    const context = { surface: 'agent' as const, defaultSessionId: sessionId, serverId,
      externalActionExecutionAuthorization: prepared.authorization, externalActionTarget: prepared.target };
    const preparation = createSessionFollowSourceKeyPreparationAfterSet({ credentials: f.credentials,
      effectActionId: actionId, serverHttpBaseUrl, serverIdentityId: storage.state.homeId,
      externalActionMachineRequestPrivateKey: installation.secretKey, externalActionMachineInstallationId: storage.state.installationId });
    expect(await preparation({ sourceSessionId, destinationSessionId, context }), JSON.stringify(f.observations))
      .toEqual({ kind: 'not_needed' });
    const diagnostics = vi.spyOn(logger, 'warnLocalFile');
    f.refuseCurrentness();
    expect(await preparation({ sourceSessionId, destinationSessionId, context }))
      .toEqual({ kind: 'waiting', reason: 'runner_unreachable', cause: 'source_transport_exception' });
    expect(diagnostics).toHaveBeenCalledWith('[Session Follow source-key preparation] Transport refused', {
      cause: 'source_transport_exception', httpStatus: 401, errorCode: 'not_authenticated',
    });
    expect(JSON.stringify(diagnostics.mock.calls)).not.toContain('private-error-body');
    // The root cannot be spent on unrelated Account operations or Session writes.
    for (const request of [{ method: 'GET', path: '/v2/account/settings' },
      { method: 'POST', path: `/v2/sessions/${sessionId}/archive` }]) {
      const headers = resolveExternalActionServerRequestHeaders({ context, effectActionId: actionId, ...request,
        daemonToken: f.credentials.token, serverIdentityId: storage.state.homeId,
        privateKey: installation.secretKey, installationId: storage.state.installationId });
      if (!headers.ok) throw new Error('Missing signed headers');
      const response = await f.app.inject({ method: request.method as 'GET' | 'POST', url: request.path, headers: headers.headers });
      expect(response.statusCode).toBe(401);
    }
  } finally { await f.close(); }
});
