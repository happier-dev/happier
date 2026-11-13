import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { accountSettingsParse, FeaturesResponseSchema, normalizeActionsSettingsV1, RoleActionOutputSchemasV1, readSessionRoleIdV1, createRoleSourceReaderV1, SessionRolesV1Schema } from '@happier-dev/protocol';
import tweetnacl from 'tweetnacl';
import { ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { verifyMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { ACCOUNT_SECURITY_PATH_V1, AccountSecurityGetResponseV1Schema } from '@happier-dev/protocol/auth/accountSecurity';
import { AccountSettingsV2GetResponseSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { decodePlainArtifactStoredContent } from '@happier-dev/protocol';
import Fastify from 'fastify';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { emptyPromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { PromptLibraryCatalogKeyV1Schema, PROMPT_LIBRARY_ROWS_ROUTE_V1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';

import { resetInMemoryAccountSettingsContextForTests } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { getActiveAccountSettingsSnapshot, readAccountRoleOverridesFromSnapshot, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { prepareRequesterSessionBootstrap } from '@/daemon/sessionEncryption/requesterSessionCredentials';
import { createCliActionExecutorFromCredentials } from './createCliActionExecutorFromCredentials';
import { buildWorkflowActionContext, createWorkflowAcceptedAuthorizationCurrentness } from '@/daemon/workflows/daemonRuntime';
import { API_TOKEN_FULL_GRANT_V1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import { resolveCliAgentStartContextV1 } from './resolveCliAgentStartContextV1';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import type { SessionActionRpcTransport } from './createCliActionDeps';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createSessionNotificationContextFixture, createCompactSessionListQueryResponseFixture, createSessionReadBatchResponseFixture } from '@/testkit/backends/sessionFixtures';
import { applyRegisteredSessionStateFieldMutationToMetadata } from '@/api/session/client/transport/mutations/applyRegisteredSessionStateFieldMutation';
import { registerSessionClientRuntimeHandlers } from '@/api/session/client/executionRuns/registerSessionClientRuntimeHandlers';
import { SessionListQueryV1Schema } from '@happier-dev/protocol/sessions/listing/query';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { readAuthoritativePluginSlotOccurrence } from '@/plugins/runtime/reload/runtimeLease';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { readEmptyPlainArtifactListFixture, registerAccountHomeHttp, registerPlainArtifactRoutes } from './widgetApproval.testkit';

const axiosGet = vi.hoisted(() => vi.fn());
const axiosPost = vi.hoisted(() => vi.fn());

vi.mock('axios', async (importOriginal) => {
  const original = await importOriginal<typeof import('axios')>();
  return { ...original, default: { ...original.default, get: axiosGet, post: axiosPost } };
});

afterEach(() => {
  resetInMemoryAccountSettingsContextForTests();
  axiosGet.mockReset();
  axiosPost.mockReset();
  vi.unstubAllEnvs();
});

describe('credentialed Action policy binding before settings bootstrap', () => {
  it('does not probe Home identity for an Account read that creates no approval origin', async () => {
    vi.stubEnv('HAPPIER_ACCOUNT_SETTINGS_MODE', 'auto');
    vi.stubEnv('HAPPIER_ACTIONS_SETTINGS_V1', '');
    const base = 'https://account-read-demand.example.invalid';
    const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'account-read-owner' })).toString('base64url')}.signature`,
      encryption: null, credentialProvenance: 'stored_session' as const };
    const paths: string[] = [];
    axiosGet.mockImplementation(async (url: string, options: { headers: Record<string, string> }) => {
      expect(new URL(url).origin).toBe(base);
      expect(options.headers.Authorization).toBe(`Bearer ${credentials.token}`);
      const path = new URL(url).pathname;
      paths.push(path);
      if (path === ACCOUNT_SECURITY_PATH_V1) return { status: 200, data: AccountSecurityGetResponseV1Schema.parse({
        v: 1, encryptionMode: 'plain', nativeEmail: null,
        password: { status: 'not_enrolled', revision: null },
      }) };
      if (path === '/v2/account/settings') return { status: 200, data: AccountSettingsV2GetResponseSchema.parse({
        version: 1, content: { t: 'plain', v: {} },
      }) };
      throw new Error(`Unexpected Account read HTTP ${path}`);
    });
    const features = vi.fn(async () => new Response(JSON.stringify(FeaturesResponseSchema.parse({ features: {},
      capabilities: { serverIdentity: { serverIdentityId: 'srv_account-read-home' } } })),
      { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', features);
    try {
      const executor = createCliActionExecutorFromCredentials({ credentials, serverId: 'account-read-profile',
        serverApiUrl: base, pluginActionExecutionOwner: 'current_process' });
      expect(await executor.execute('account.security.get', {}, { surface: 'cli', actionCaller: { kind: 'host' } }))
        .toMatchObject({ ok: true, result: { encryptionMode: 'plain' } });
      expect(features).not.toHaveBeenCalled();
      expect(paths.sort()).toEqual([ACCOUNT_SECURITY_PATH_V1, '/v2/account/settings'].sort());
      expect(axiosPost).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });

  it('does not retry another Action Home lookup after a deferred Account read on the same factory', async () => {
    vi.stubEnv('HAPPIER_ACCOUNT_SETTINGS_MODE', 'auto');
    vi.stubEnv('HAPPIER_ACTIONS_SETTINGS_V1', '');
    const base = 'https://account-read-sibling.example.invalid';
    const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'account-read-sibling' })).toString('base64url')}.signature`,
      encryption: null, credentialProvenance: 'stored_session' as const };
    axiosGet.mockImplementation(async (url: string) => {
      const path = new URL(url).pathname;
      if (path === ACCOUNT_SECURITY_PATH_V1) return { status: 200, data: AccountSecurityGetResponseV1Schema.parse({
        v: 1, encryptionMode: 'plain', nativeEmail: null,
        password: { status: 'not_enrolled', revision: null },
      }) };
      if (path === '/v2/account/settings') return { status: 200, data: AccountSettingsV2GetResponseSchema.parse({
        version: 1, content: { t: 'plain', v: { actionsSettingsV1: { v: 1,
          actions: { 'account.profile.get': { approvalRequiredSurfaces: ['cli'] } } } } },
      }) };
      throw new Error(`Unexpected sibling Action HTTP ${path}`);
    });
    const features = vi.fn(async () => new Response('{}', { status: 503 }));
    vi.stubGlobal('fetch', features);
    try {
      const executor = createCliActionExecutorFromCredentials({ credentials, serverId: 'account-sibling-profile',
        serverApiUrl: base, pluginActionExecutionOwner: 'current_process' });
      const context = { surface: 'cli' as const, actionCaller: { kind: 'host' as const } };
      expect(await executor.execute('account.security.get', {}, context)).toMatchObject({ ok: true });
      expect(features).not.toHaveBeenCalled();
      // Without a request identity the unchanged strict builder refuses the
      // proposal. Its failed eager lookup must not become a second probe.
      expect(await executor.execute('account.profile.get', {}, context))
        .toMatchObject({ ok: false, errorCode: 'approval_origin_unavailable' });
      expect(features).toHaveBeenCalledTimes(1);
      expect(axiosPost).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });

  it.each(['ready', 'cancelled', 'cancelled-bound', 'unavailable', 'eager-unavailable'] as const)('resolves authenticated Home identity at the Account read approval demand (%s)', async state => {
    vi.stubEnv('HAPPIER_ACCOUNT_SETTINGS_MODE', 'auto');
    vi.stubEnv('HAPPIER_ACTIONS_SETTINGS_V1', '');
    const base = 'https://account-approval-demand.example.invalid';
    const accountId = `account-approval-owner-${state}`;
    const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`,
      encryption: null, credentialProvenance: 'stored_session' as const };
    const app = Fastify();
    const controller = new AbortController();
    const stages: string[] = [];
    const fetchPaths: string[] = [];
    const actionId = state === 'eager-unavailable' ? 'account.profile.get' : 'account.security.get';
    let securityReads = 0;
    let createdId: string | undefined;
    const settings = accountSettingsParse({ actionsSettingsV1: { v: 1,
      actions: { [actionId]: { approvalRequiredSurfaces: ['cli'] } } } });
    const featuresSnapshot = registerAccountHomeHttp(app, { accountId,
      serverId: 'srv_account-approval-home', settings });
    const artifacts = registerPlainArtifactRoutes(app, accountId);
    app.get(ACCOUNT_SECURITY_PATH_V1, async () => {
      securityReads += 1;
      return AccountSecurityGetResponseV1Schema.parse({ v: 1,
        encryptionMode: 'plain', nativeEmail: null, password: { status: 'not_enrolled', revision: null } });
    });
    app.addHook('onRequest', async request => {
      expect(request.headers.authorization).toBe(`Bearer ${credentials.token}`);
      if (request.url === '/v2/account/settings') stages.push('settings');
    });
    app.addHook('onResponse', async request => {
      if (request.method === 'POST' && request.url === '/v1/artifacts') {
        const body = request.body as { id: string };
        createdId = body.id;
        stages.push('artifact');
      }
    });
    const restore = installAxiosFastifyAdapter({ app, origin: base });
    const originalAxios = (await vi.importActual<typeof import('axios')>('axios')).default;
    axiosGet.mockImplementation(originalAxios.get);
    axiosPost.mockImplementation(originalAxios.post);
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      const requestUrl = new URL(url);
      expect(requestUrl.origin).toBe(base);
      fetchPaths.push(requestUrl.pathname);
      if (requestUrl.pathname === '/v1/features') {
        // The Artifact reader independently consults public feature support;
        // it is not authenticated Home-identity authority.
        expect(new Headers(init.headers).get('Authorization')).toBeNull();
        return new Response(JSON.stringify(FeaturesResponseSchema.parse({ features: {} })),
          { status: 200, headers: { 'content-type': 'application/json' } });
      }
      expect(url).toBe(`${base}/v1/features/authenticated`);
      expect(init.headers).toMatchObject({ Authorization: `Bearer ${credentials.token}` });
      stages.push('features');
      if (state.startsWith('cancelled')) controller.abort();
      if (state.endsWith('unavailable')) return new Response('{}', { status: 503 });
      return new Response(JSON.stringify(featuresSnapshot), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    try {
      const executor = createCliActionExecutorFromCredentials({ credentials, serverId: 'account-approval-profile',
        serverApiUrl: base, pluginActionExecutionOwner: 'current_process' });
      const invocation = state === 'cancelled-bound' ? executor.bindInvocation(controller.signal) : executor;
      const result = await invocation.execute(actionId, {}, {
        surface: 'cli', actionCaller: { kind: 'host' }, actionRequestId: `account-read-${state}`,
        ...(state === 'cancelled-bound' ? {} : { signal: controller.signal }),
      });
      expect(securityReads).toBe(0); // Settings admit the request; disclosure waits for approval.
      expect(fetchPaths.filter(path => path === '/v1/features/authenticated')).toHaveLength(1);
      expect(fetchPaths.every(path => path === '/v1/features/authenticated' || path === '/v1/features')).toBe(true);
      if (state.startsWith('cancelled')) {
        expect(result).toMatchObject({ ok: false, errorCode: 'cancelled' });
        expect(createdId).toBeUndefined();
        expect(stages).toEqual(['settings', 'features']);
      } else {
        expect(result).toMatchObject({ ok: true, result: { kind: 'approval_request_created', actionId } });
        expect(stages, JSON.stringify(result)).toEqual(state === 'eager-unavailable'
          ? ['features', 'settings', 'artifact'] : ['settings', 'features', 'artifact']);
        const row = createdId ? artifacts.read(createdId) : undefined;
        expect(row).toBeDefined();
        const content = decodePlainArtifactStoredContent(row!.body);
        if (!content || typeof content !== 'object' || !('body' in content) || typeof content.body !== 'string') {
          throw new Error('Expected the canonical plain Artifact body envelope');
        }
        const request = ApprovalRequestV2Schema.parse(JSON.parse(content.body));
        expect(request.executionOriginV1).toMatchObject({ serverId: 'account-approval-profile',
          accountId, actionId, requestId: `account-read-${state}` });
        if (state === 'ready') expect(request.executionOriginV1.serverIdentityId).toBe('srv_account-approval-home');
        // The unchanged strict builder permits the host's profile-bound origin
        // without cryptographic Home identity, on eager and deferred paths alike.
        else expect(request.executionOriginV1).not.toHaveProperty('serverIdentityId');
      }
    } finally {
      vi.unstubAllGlobals();
      restore();
      await app.close();
    }
  });

  it.each(['api', 'plugin'] as const)('admits a genuine Workflow Run role write through the credentialed cli-global composition (%s source)', async sourceKind => {
    resetInMemoryAccountSettingsContextForTests();
    vi.stubEnv('HAPPIER_ACCOUNT_SETTINGS_MODE', 'auto');
    vi.stubEnv('HAPPIER_ACTIONS_SETTINGS_V1', '');
    const origin = 'c123456789012345678901234';
    const child = 'c123456789012345678901235';
    const homeId = 'workflow-home';
    const base = 'https://workflow-role.example.invalid';
    const signing = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(38));
    const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'workflow-role-owner', tokenEpoch: 0 })).toString('base64url')}.signature`,
      encryption: null, credentialProvenance: 'stored_session' as const };
    const pluginId = 'happier.sender-only';
    const pluginFixture = { manifest: createPluginManifestV2Fixture({ id: pluginId, entrypoints: {} }), files: {} };
    const senderRuntime = sourceKind === 'plugin'
      ? await createAuthoredAdmittedPluginRuntimeFixture({ plugins: [pluginFixture], coldStart: true }) : null;
    if (senderRuntime) onTestFinished(() => senderRuntime.dispose());
    let senderController = senderRuntime?.controller;
    const acceptedCustody = senderController && readAuthoritativePluginSlotOccurrence(pluginId, { controller: senderController })?.sourceCustody;
    if (sourceKind === 'plugin' && !acceptedCustody) throw new Error('Expected admitted sender plugin custody');
    const rawSettings = { actionsSettingsV1: { v: 1, actions: {},
      approvalWaivedSurfaces: { 'session.role.set': ['agent'], 'session.notes.set': ['agent'],
        'session.roles.apply_to_reports': ['agent'] } } };
    const settings = accountSettingsParse(rawSettings);
    const scopeKey = runWithServerHttpBaseUrl(base, () => resolveAccountSettingsScopeKey(credentials));
    setActiveAccountSettingsSnapshot({ scopeKey, source: 'network',
      settings, rawSettings, settingsVersion: 1, settingsSecretsReadKeys: [], loadedAtMs: 1,
      promptLibraryCatalog: { status: 'ready', rows: [], tombstones: [], diagnostics: [] } });
    const agentStartContext = resolveCliAgentStartContextV1({ sessionId: 'detached-step', machineId: 'machine', directory: '/repo',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' }, metadata: null,
      starterDepth: 0, turnDepth: 0, callerPermissionMode: 'default', settings, roles: {},
      runCaller: { runId: 'workflow-run', runDepth: 4, runOriginSessionId: origin } });
    if (!agentStartContext || 'ok' in agentStartContext) throw new Error('Expected host-produced originless caller');
    let metadata = createTestMetadata();
    const childMetadata = createTestMetadata();
    let authorityCurrent = true;
    let revokeOnDelivery = false;
    let revokeDuringSigning = false;
    let misbindDelivery = false;
    let reportCopyDeliveries = 0;
    const isAcceptedAuthorizationCurrent = createWorkflowAcceptedAuthorizationCurrentness({ accountId: 'workflow-role-owner',
      // The token registry is the external credential store; its canonical
      // accepted-authority evaluator remains real at the assigned Run executor.
      listAccountApiTokens: async () => ({ tokens: authorityCurrent ? [{ tokenId: 'workflow-api-token', label: 'Workflow',
        displayPrefix: 'hap_v1_test', createdAt: '2026-01-01T00:00:00.000Z', lastUsedAt: null, expiresAt: null,
        hasEncryptionAccess: false, hasUnattendedTeamAccess: false, grant: API_TOKEN_FULL_GRANT_V1,
        parentTokenId: null, activeChildCount: 0, embedConfig: null }] : [] }),
      resolveCurrentPluginOccurrenceId: async id => senderController
        ? readAuthoritativePluginSlotOccurrence(id, { controller: senderController })?.occurrenceId ?? null : null,
      isMediatedSourceCurrent: async () => false });
    const mutations: string[] = [];
    const provider = createActionSettingsProvider({ scopeKey });
    const row = (sessionId = origin) => ({ ...createSessionNotificationContextFixture(sessionId), encryptionMode: 'plain' as const,
      metadata: JSON.stringify(sessionId === child ? childMetadata : metadata),
      ...(sessionId === child ? { manager: { sessionId: origin } } : {}) });
    axiosGet.mockImplementation(async (url: string) => {
      const path = new URL(url).pathname;
      if (path === '/v1/account/encryption/currentness') {
        if (revokeDuringSigning) {
          authorityCurrent = false;
          await senderRuntime?.lease.release();
          await senderController?.shutdown();
        }
        return { status: 200, data: { mode: 'plain', version: 1,
          settingsVersion: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      }
      if (path === '/v1/artifacts') return readEmptyPlainArtifactListFixture(url, 'workflow-role-owner');
      if (path === '/v1/account/profile') return { status: 200, data: { id: 'workflow-role-owner' } };
      if (path === ACCOUNT_SECURITY_PATH_V1) return { status: 404, data: {} };
      if (path === '/v2/account/settings') return { status: 200, data: { version: 1, content: { t: 'plain', v: rawSettings } } };
      if (path === PROMPT_LIBRARY_ROWS_ROUTE_V1) return { status: 200, data: { status: 'listed', rows:
        PromptLibraryCatalogKeyV1Schema.options.map(key => ({ key, revision: 1,
          content: { t: 'plain', v: emptyPromptLibraryRecordV1(key) } })) } };
      if (path === '/v1/account/entity-rows/profiles/transfer') return { status: 200, data: { status: 'absent' } };
      if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
      if (path === `/v2/sessions/${origin}`) return { status: 200, data: { session: row() } };
      if (path === `/v2/sessions/${child}`) return { status: 200, data: { session: row(child) } };
      throw new Error(`Unexpected Workflow Role HTTP read ${path}`);
    });
    axiosPost.mockImplementation(async (url: string, body: unknown) => {
      const path = new URL(url).pathname;
      if (path === '/v2/sessions/read-batch') return { status: 200, data: createSessionReadBatchResponseFixture({ request: body, sessions: [row(), row(child)] }) };
      if (path === '/v2/sessions/query') {
        const query = SessionListQueryV1Schema.parse(body);
        return { status: 200, data: createCompactSessionListQueryResponseFixture({ sessions:
          query.storage === 'active' && query.underSessionId === origin ? [row(child)] : [],
          nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false }) };
      }
      if (path.endsWith('/execution-authorization')) {
        const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
        const actionId = decodeURIComponent(path.split('/')[3]!);
        expect(verifyMachineInstallationProof({ publicKey: encodeBase64(signing.publicKey, 'base64url'),
          proof: request.installationProof!, payload: { version: 1, accountId: 'workflow-role-owner', machineId: 'machine',
            installationId: 'installed', externalActionOrigin: { homeId, actionId, requestId: request.envelope.requestId!,
              requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope), origin: request.workflowActionOrigin! } } })).toBe(true);
        return { status: 200, data: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-signed-workflow',
          binding: { accountId: 'workflow-role-owner', custodianAccountId: 'workflow-role-owner',
            authentication: { kind: 'account', tokenEpoch: 0 }, accountEncryptionMode: 'plain', serverIdentityId: homeId,
            machineId: 'machine', installationId: 'installed', actionId, requestId: request.envelope.requestId!,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope), target: request.envelope.target,
            workflowActionOrigin: request.workflowActionOrigin } }) };
      }
      if (path.endsWith('/verify')) return { status: 200, data: { ok: true } };
      throw new Error(`Unexpected Workflow Role HTTP write ${path}`);
    });
    const sessionActionRpcTransport: SessionActionRpcTransport = async request => {
      expect(request.executionAuthorization?.binding.workflowActionOrigin?.runId).toBe('workflow-run');
      if (request.method === 'session.roles.apply_to_reports' || request.sessionId === child) reportCopyDeliveries++;
      // Home's assignment admission and the authenticated relay are real boundaries.
      if (revokeOnDelivery) return { ok: false, errorCode: 'run_access_denied', error: 'run_access_denied' };
      if (request.sessionId === child) throw new Error('Unsupported Workflow copy reached a recipient');
      return await rpc.handleRequest({ method: `${misbindDelivery ? 'wrong-session' : request.sessionId}:${request.method}`, params: request.input,
        callerAuthority: 'account_automation', callerInputAuthorization: request.executionAuthorization });
    };
    const rpc = new RpcHandlerManager({ scopePrefix: origin, encryptionMode: 'plain', logger: () => {} });
    const unexpectedTranscriptWrite = async (): Promise<never> => { throw new Error('Unexpected transcript write'); };
    // Use the real runner registration for supported Role/Notes mutations;
    // authenticated Home/Session transports are the boundaries.
    const originRegistration = registerSessionClientRuntimeHandlers({ rpcHandlerManager: rpc, sessionId: origin,
      token: credentials.token, serverId: 'workflow-home-profile', serverUrl: base,
      readOwnerAccountCredentials: async () => credentials,
      metadataPath: metadata.path, metadata, getSessionMetadata: () => metadata,
      readRoleSources: createRoleSourceReaderV1({}),
      enqueueRegisteredSessionStateFieldMutation: async mutation => {
        mutations.push(mutation.fieldId);
        metadata = applyRegisteredSessionStateFieldMutationToMetadata(metadata, mutation);
      },
      enqueueSessionUserMessage: unexpectedTranscriptWrite, enqueueUserTextMessageCommitted: unexpectedTranscriptWrite,
      enqueueAgentMessageCommitted: unexpectedTranscriptWrite, enqueueVoiceAgentTranscriptTurnCommitted: unexpectedTranscriptWrite,
      sendAgentMessageEphemeral: () => { throw new Error('Unexpected ephemeral write'); },
      getTranscriptQueryContext: () => ({ encryptionMode: 'plain' }),
      persistVoiceAgentRunMetadataFromPublicRun: () => {}, socketEmitExecutionRunUpdated: () => {},
    });
    onTestFinished(() => originRegistration.dispose());
    // HTTP and the authenticated RPC relay are genuine system boundaries; both
    // credentialed composition and receiving Role/admission/outbox owners stay real.
    const executor = createCliActionExecutorFromCredentials({ credentials,
      serverId: 'workflow-home-profile', serverApiUrl: base, serverIdentityId: homeId,
      externalActionMachineInstallationId: 'installed', externalActionMachineRequestPrivateKey: signing.secretKey,
      actionsSettingsProvider: provider, workflowAcceptedAuthorizationCurrentness: isAcceptedAuthorizationCurrent,
      sessionActionRpcTransport,
      pluginActionExecutionOwner: 'current_process', readCredentials: async () => credentials });
    const context = { ...buildWorkflowActionContext({ runId: 'workflow-run',
      authorization: { principal: sourceKind === 'plugin'
        ? { kind: 'plugin', pluginId, sourceCustody: acceptedCustody! }
        : { kind: 'api', accountId: 'workflow-role-owner', principalId: 'workflow-role-owner', credentialId: 'workflow-api-token' },
        admittedPermissionCeiling: 'default' } }),
      agentStartContext, workspaceWrites: 'allow' as const, actionRequestId: 'run-role-write' };
    const result = await executor.execute('session.role.set', { sessionId: origin, roleId: 'builder' }, context);
    expect(result).toEqual({ ok: true, result: { updated: true } });
    if (!result.ok) throw new Error('Expected admitted Workflow role write');
    expect(RoleActionOutputSchemasV1['session.role.set'].parse(result.result)).toEqual(result.result);
    expect(readSessionRoleIdV1(metadata)).toBe('builder');
    expect(await executor.execute('session.notes.set', { sessionId: origin, notes: 'Run brief' }, context))
      .toEqual({ ok: true, result: { updated: true } });
    expect(SessionRolesV1Schema.parse(metadata.work?.sessionRolesV1).notes).toBe('Run brief');
    expect(mutations).toEqual(['intent.role', 'intent.sessionRoles']);
    const beforeCopy = structuredClone(childMetadata);
    expect(await executor.execute('session.roles.apply_to_reports', { sessionId: origin }, context))
      .toMatchObject({ ok: false, errorCode: 'unsupported_action' });
    expect(reportCopyDeliveries).toBe(0);
    expect(childMetadata).toEqual(beforeCopy);
    expect(await executor.execute('session.role.set', { sessionId: origin, roleId: 'builder' }, { ...context, workspaceWrites: 'deny' }))
      .toMatchObject({ ok: false, errorCode: 'role_policy_denied' });
    const noOrigin = { ...agentStartContext, caller: { kind: 'originless' as const, runId: 'workflow-run', runDepth: 4 } };
    expect(await executor.execute('session.notes.set', { sessionId: origin, notes: 'Missing origin' }, { ...context, agentStartContext: noOrigin }))
      .toMatchObject({ ok: false, errorCode: 'subtree_denied' });
    expect(await executor.execute('session.notes.set', { sessionId: 'unrelated', notes: 'Wrong target' }, context))
      .toMatchObject({ ok: false, errorCode: 'subtree_denied' });
    misbindDelivery = true;
    expect(await executor.execute('session.notes.set', { sessionId: origin, notes: 'Wrong binding' }, context))
      .toMatchObject({ ok: false });
    misbindDelivery = false;
    revokeOnDelivery = true;
    expect(await executor.execute('session.notes.set', { sessionId: origin, notes: 'Revoked' }, context))
      .toMatchObject({ ok: false, errorCode: 'run_access_denied' });
    expect(SessionRolesV1Schema.parse(metadata.work?.sessionRolesV1).notes).toBe('Run brief');
    revokeOnDelivery = false;
    if (sourceKind === 'plugin') {
      if (context.actionCaller?.kind !== 'workflowRun') throw new Error('Expected admitted Workflow caller');
      const authorization = context.actionCaller.authorization;
      const replacementRuntime = await createAuthoredAdmittedPluginRuntimeFixture({ plugins: [pluginFixture], coldStart: true });
      onTestFinished(() => replacementRuntime.dispose());
      expect(readAuthoritativePluginSlotOccurrence(pluginId, { controller: replacementRuntime.controller })?.sourceCustody)
        .not.toEqual(acceptedCustody);
      const originalController = senderController;
      senderController = replacementRuntime.controller;
      // A changed source refuses the next admission, not work already admitted
      // under this Run's retained signed Session authority.
      expect(await isAcceptedAuthorizationCurrent({ authorization })).toBe(false);
      expect(await executor.execute('session.notes.set', { sessionId: origin, notes: 'Replaced source' }, context))
        .toEqual({ ok: true, result: { updated: true } });
      senderController = undefined;
      expect(await isAcceptedAuthorizationCurrent({ authorization })).toBe(false);
      expect(await executor.execute('session.roles.apply_to_reports', { sessionId: origin }, context))
        .toMatchObject({ ok: false, errorCode: 'unsupported_action' });
      senderController = originalController;
      revokeDuringSigning = true;
      expect(await executor.execute('session.notes.set', { sessionId: origin, notes: 'Revoked during signing' }, context))
        .toEqual({ ok: true, result: { updated: true } });
      expect(await isAcceptedAuthorizationCurrent({ authorization })).toBe(false);
      expect(SessionRolesV1Schema.parse(metadata.work?.sessionRolesV1).notes).toBe('Revoked during signing');
      expect(reportCopyDeliveries).toBe(0);
      expect(childMetadata).toEqual(beforeCopy);
    }
    await rpc.waitForIdle();
  });

  it('hydrates Role admission into the admitted requester snapshot rather than the ambient Account', async () => {
    const currentness = await createRequesterCurrentnessSocketHarness();
    onTestFinished(() => currentness.close());
    resetInMemoryAccountSettingsContextForTests();
    vi.stubEnv('HAPPIER_ACCOUNT_SETTINGS_MODE', 'auto');
    vi.stubEnv('HAPPIER_ACTIONS_SETTINGS_V1', '');
    const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'requester-role-owner' })).toString('base64url')}.signature`,
      encryption: null, credentialProvenance: 'stored_session' as const };
    const base = 'https://requester-role-home.example.invalid';
    // HTTP and installed-Machine currentness are the external boundaries;
    // requester bootstrap, captured catalogs and the Action factory stay real.
    axiosGet.mockImplementation(async (url: string) => {
      const path = new URL(url).pathname;
      if (path === ACCOUNT_SECURITY_PATH_V1) return { status: 404, data: {} };
      if (path === '/v1/account/profile') return { status: 200, data: { id: 'requester-role-owner' } };
      if (path === '/v2/account/settings') return { status: 200, data: { version: 7, content: { t: 'plain', v: {} } } };
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
        settingsVersion: 7, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (path === PROMPT_LIBRARY_ROWS_ROUTE_V1) return { status: 200, data: { status: 'listed', rows:
        PromptLibraryCatalogKeyV1Schema.options.map(key => ({ key, revision: 1, content: { t: 'plain', v:
          key === 'role-overrides' ? { key, value: { v: 1, overrides: { scout: { roleId: 'scout',
            instructionsOverride: 'Use the requester override.' } } } } : emptyPromptLibraryRecordV1(key) } })) } };
      if (path === '/v1/artifacts') return readEmptyPlainArtifactListFixture(url, 'requester-role-owner');
      if (path === '/v1/account/entity-rows/profiles/transfer') return { status: 200, data: { status: 'absent' } };
      if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
      throw new Error(`Unexpected requester Role HTTP read ${path}`);
    });
    await runWithServerHttpBaseUrl(base, async () => {
      const prepared = await prepareRequesterSessionBootstrap({ credentials,
        attribution: { serverId: 'requester-home', accountId: 'requester-role-owner', machineId: 'requester-machine', installationId: 'requester-installation' },
        boundary: { serverId: 'requester-home', serverHttpBaseUrl: base, happyHomeDir: '/tmp/cli-requester-role-fixture' },
        verifyMachineAdmissionCurrent: async () => true });
      expect(prepared).not.toBeNull();
      if (!prepared) throw new Error('Requester fixture admission failed');
      const bootstrap = prepared.admitted;
      const ambient = { scopeKey: 'another-account', source: 'network' as const, loadedAtMs: 1,
        settingsVersion: 1, settingsSecretsReadKeys: [], settings: accountSettingsParse({}) };
      setActiveAccountSettingsSnapshot(ambient);
      const installedAmbient = getActiveAccountSettingsSnapshot();
      const readSnapshot = () => {
        const snapshot = bootstrap.savedSecretOperationContext.readSnapshot();
        if (!snapshot) throw new Error('Requester snapshot retired');
        return snapshot;
      };
      try {
        const executor = createCliActionExecutorFromCredentials({ credentials, requesterSessionBootstrap: bootstrap,
          actionsSettingsProvider: {
            getActionsSettings: () => normalizeActionsSettingsV1(readSnapshot().settings.actionsSettingsV1),
            getAccountSettings: () => readSnapshot().settings,
            getAccountRoleOverrides: () => readAccountRoleOverridesFromSnapshot(readSnapshot()),
          }, readCredentials: async () => await bootstrap.isCurrent() ? credentials : null,
          pluginActionExecutionOwner: 'current_process' });
        const result = await executor.execute('roles.get', { roleId: 'scout' }, { surface: 'cli', authority: 'present_user' });
        expect(result.ok ? { ok: true } : result).toEqual({ ok: true });
        expect(result).toMatchObject({ ok: true, result: { roleId: 'scout' } });
        expect(readAccountRoleOverridesFromSnapshot(readSnapshot())).toMatchObject({ status: 'ready',
          overrides: { scout: { roleId: 'scout', instructionsOverride: 'Use the requester override.' } } });
        expect(getActiveAccountSettingsSnapshot()).toBe(installedAmbient);
      } finally { await prepared.cleanupOnFailure(); }
    });
  });
  it.each(['execute', 'prepare'] as const)('reads Account Role overrides on a cold %s invocation', async method => {
    resetInMemoryAccountSettingsContextForTests();
    vi.stubEnv('HAPPIER_ACCOUNT_SETTINGS_MODE', 'auto');
    vi.stubEnv('HAPPIER_ACTIONS_SETTINGS_V1', '');
    const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: `cold-role-${method}` })).toString('base64url')}.signature`,
      encryption: null, credentialProvenance: 'stored_session' as const };
    // Home HTTP is the boundary; bootstrap, catalog hydration, role resolution
    // and Action preparation/execution all use their real canonical owners.
    axiosGet.mockImplementation(async (url: string) => {
      const path = new URL(url).pathname;
      if (path === ACCOUNT_SECURITY_PATH_V1) return { status: 404, data: {} };
      if (path === '/v2/account/settings') return { status: 200, data: { version: 7, content: { t: 'plain', v: {} } } };
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
        settingsVersion: 7, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (path === PROMPT_LIBRARY_ROWS_ROUTE_V1) return { status: 200, data: { status: 'listed', rows:
        PromptLibraryCatalogKeyV1Schema.options.map(key => ({ key, revision: 1, content: { t: 'plain', v:
          key === 'role-overrides' ? { key, value: { v: 1, overrides: { scout: { roleId: 'scout',
            instructionsOverride: 'Use the Account override.' } } } } : emptyPromptLibraryRecordV1(key) } })) } };
      if (path === '/v1/artifacts') return readEmptyPlainArtifactListFixture(url, `cold-role-${method}`);
      if (path === '/v1/account/entity-rows/profiles/transfer') return { status: 200, data: { status: 'absent' } };
      if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
      throw new Error(`Unexpected cold Role HTTP read ${path}`);
    });
    const executor = createCliActionExecutorFromCredentials({ credentials, pluginActionExecutionOwner: 'current_process' });
    const context = { surface: 'cli', authority: 'present_user' } as const;
    const result = method === 'execute' ? await executor.execute('roles.list', {}, context)
      : await (async () => {
        const prepared = await executor.prepare('roles.list', {}, context);
        expect(prepared.kind).toBe('ready');
        return prepared.kind === 'ready' ? await prepared.invocation.run() : prepared.result;
      })();
    expect(result).toMatchObject({ ok: true, result: { items: expect.arrayContaining([
      expect.objectContaining({ roleId: 'scout' }),
    ]) } });
    // Catalog contents belong to the captured operation (covered above), not a
    // second ambient publication. Cold callers must still admit both reads.
    expect(await executor.execute('roles.get', { roleId: 'scout' }, context)).toMatchObject({ ok: true,
      result: { roleId: 'scout' } });
  });
  it.each(['execute', 'prepare'] as const)(
    'uses an explicit reviewed policy for %s without bootstrapping ambient Account settings',
    async (method) => {
      vi.stubEnv('HAPPIER_ACCOUNT_SETTINGS_MODE', 'auto');
      const executor = createCliActionExecutorFromCredentials({
        credentials: {
          token: `scoped-reviewed-policy-${method}`,
          encryption: null,
          credentialProvenance: 'stored_session',
        },
        actionsSettingsProvider: {
          getActionsSettings: () => normalizeActionsSettingsV1({
            v: 1,
            actions: { 'action.spec.get': { enabled: false } },
          }),
        },
        pluginActionExecutionOwner: 'current_process',
      });

      const result = method === 'execute'
        ? await executor.execute('action.spec.get', { id: 'session.list' }, { surface: 'cli' })
        : await executor.prepare('action.spec.get', { id: 'session.list' }, { surface: 'cli' });

      expect(result).toMatchObject(method === 'execute'
        ? { ok: false, errorCode: 'action_disabled' }
        : { kind: 'settled', result: { ok: false, errorCode: 'action_disabled' } });
      expect(axiosGet).not.toHaveBeenCalled();
    },
  );

  it.each([
    { initial: 'empty', kind: 'fixed', method: 'execute' },
    { initial: 'other_account', kind: 'fixed', method: 'prepare' },
    { initial: 'empty', kind: 'refreshing', method: 'execute' },
    { initial: 'other_account', kind: 'refreshing', method: 'prepare' },
  ] as const)('awaits $kind credential policy before $method with an initially $initial snapshot', async ({ initial, kind, method }) => {
    vi.stubEnv('HAPPIER_ACTIONS_SETTINGS_V1', '');
    vi.stubEnv('HAPPIER_ACCOUNT_SETTINGS_MODE', 'auto');
    resetInMemoryAccountSettingsContextForTests();
    const credentials = {
      token: `alice-policy-token-${kind}-${method}-${initial}`,
      encryption: null,
      credentialProvenance: 'stored_session' as const,
    };
    if (initial === 'other_account') {
      setActiveAccountSettingsSnapshot({ scopeKey: 'bob', source: 'network', loadedAtMs: Date.now(),
        settingsVersion: 1, settingsSecretsReadKeys: [], settings: accountSettingsParse({}) });
    }
    let resolvePolicyRequest!: (response: unknown) => void;
    // HTTP is the boundary. The real policy owner first reads Account Security;
    // only the Settings request is held pending by this admission fixture.
    axiosGet.mockImplementation(async (url: string) => {
      const path = new URL(url).pathname;
      if (path === ACCOUNT_SECURITY_PATH_V1) return { status: 404, data: { error: 'not_found' } };
      if (path === '/v2/account/settings') {
        return await new Promise((resolve) => { resolvePolicyRequest = resolve; });
      }
      throw new Error(`Unexpected policy fixture HTTP read ${path}`);
    });
    const executor = createCliActionExecutorFromCredentials({
      credentials,
      ...(kind === 'refreshing' ? { readCredentials: async () => credentials } : {}),
      pluginActionExecutionOwner: 'current_process',
    });

    const pending = method === 'execute'
      ? executor.execute('action.spec.get', { id: 'session.list' }, { surface: 'cli' })
      : executor.prepare('action.spec.get', { id: 'session.list' }, { surface: 'cli' });
    await vi.waitFor(() => expect(resolvePolicyRequest).toEqual(expect.any(Function)));
    let settled = false;
    void pending.finally(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    resolvePolicyRequest({ status: 200, data: { version: 2, content: { t: 'plain', v: {
      actionsSettingsV1: { v: 1, actions: { 'action.spec.get': { enabled: false } } },
    } } } });
    await vi.waitFor(() => expect(getActiveAccountSettingsSnapshot()).toMatchObject({
      scopeKey: resolveAccountSettingsScopeKey(credentials),
      settingsVersion: 2,
      settings: { actionsSettingsV1: { actions: { 'action.spec.get': { enabled: false } } } },
    }));
    await expect(pending).resolves.toMatchObject(method === 'execute'
      ? { ok: false, errorCode: 'action_disabled' }
      : { kind: 'settled', result: { ok: false, errorCode: 'action_disabled' } });
  });
});
