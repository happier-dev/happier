import type { ActionExecutorContext } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionSurfaceSchema } from '@happier-dev/protocol/actions/metadata';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import axios from 'axios';
import nacl from 'tweetnacl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createActionExecutor, encodeV2SessionListCursorV2, API_TOKEN_FULL_GRANT_V1, normalizeActionsSettingsV1, wrapApiTokenEncryptionAccessV1,
  deriveAccountMachineKeyFromRecoverySecret, sealAccountScopedBlobCiphertext, SessionMetadataTuplePatchV1Schema, FeaturesResponseSchema,
  type V2SessionRecord } from '@happier-dev/protocol';
import { formatAccountApiTokenCredentialV1 } from '@happier-dev/protocol/auth/accountApiTokens';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { createPlainSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { sealSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';
import { encryptSessionPayload } from '@/session/transport/encryption/sessionEncryptionContext';
import { EXTERNAL_ACTION_EFFECT_ACTION_HEADER, ExternalActionExecutionAuthorizationV1Schema, ExternalActionRequestEnvelopeSchema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { AccountSettingsV2GetResponseSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { createAccountEncryptionCurrentnessFixture, createSessionNotificationContextFixture, createSessionRecordFixture, createSessionRuntimeManagedSubtreeRecordFixture, createCompactSessionListRowFixture, createCompactSessionListQueryResponseFixture, createSessionReadBatchResponseFixture } from '@/testkit/backends/sessionFixtures';
import { SessionRuntimeManagedSubtreeListResponseV1Schema } from '@happier-dev/protocol/sessions/listing/response';
import { SESSION_LIST_PAGE_MAX_LIMIT, SessionListQueryV1Schema, type SessionListQueryV1 } from '@happier-dev/protocol/sessions/listing/query';
import { normalizeSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { projectSessionAccessCapabilitiesV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { getSessionStatus } from '@/session/services/getSessionStatus';
import * as sessionSockets from '@/api/session/sockets';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createCliActionDeps } from './createCliActionDeps';
import { createCliActionExecutor } from './createCliActionExecutor';
import { createSessionFollowActionDeps } from '@/api/sessionFollowActionDeps';
import { createCliActionExecutorFromCredentials } from './createCliActionExecutorFromCredentials';
import { executeExternalAction } from '@/daemon/externalActions/executeExternalAction';
import { createDaemonExternalActionTargetResolver } from '@/daemon/externalActions/daemonExternalActionTargetResolver';
import { admitRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { seedTestServerProfile } from '@/testkit/serverProfiles';
import { createCliActionExecutorHarness } from './createCliActionExecutorHarness';
import { createRestrictedCurrentSessionListActionDependency } from './sessionListActionDependency';
import { createSessionAccountActionExecutor } from '@/mcp/runtime/createSessionAccountActionExecutor';
import { resolveActionCurrentSessionScopeFailure } from '@happier-dev/protocol/actions/executor/sessionListAccess';
import { createHappierMcpServer } from '@/mcp/createHappierMcpServer';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { createSessionDaemonAuthorityFixture } from '@/mcp/runtime/sessionDaemonAuthority.testkit';
import { createDaemonSessionAccountActionExecutor } from '@/daemon/agentRuntime/createDaemonSessionAccountActionExecutor';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createPluginInvocationActionsService } from '@/plugins/runtime/invocation/services/actions';
import { createPluginActionCallerMaterializationFixture } from '@/plugins/runtime/invocation/services/actionCaller.testkit';
import { resetServerFeaturesClientForTests } from '@/features/serverFeaturesClient';
import { createProjectAccountRowCipherV1 } from '@happier-dev/protocol/projects/projectAccountRowCipherV1';
import { ApprovalRequestV2Schema, type ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { decideApprovalRequestTransition } from '@happier-dev/protocol/approvals/approvalRequestTransition';
import { executeSessionDelete } from '@happier-dev/protocol/actions/executor/session/delete';
import { createAccountServerActionDeps } from '@/api/accountServerActionDeps';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('CLI Session target composition', () => {
  const home = 'https://session-target-home.test';
  const sessionId = 'c111111111111111111111111';
  const managerId = 'c222222222222222222222222';
  const context = { surface: 'cli', authority: 'present_user', serverId: 'srv_target_home' } as const;

  it('resolves restricted native targets only through the server-proved own subtree', async () => {
    const credentials = { token: 'restricted-runtime', encryption: null };
    const parent = createSessionRuntimeManagedSubtreeRecordFixture({ id: sessionId, encryptionMode: 'plain' });
    const child = createSessionRuntimeManagedSubtreeRecordFixture({ id: managerId, encryptionMode: 'plain', manager: { sessionId } });
    let detached = false;
    const queries: SessionListQueryV1[] = [];
    vi.spyOn(axios, 'get').mockImplementation(async () => { throw new Error('No Account or foreign detail authority'); });
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      if (String(url).endsWith('/v2/sessions/read-batch')) {
        expect(body).toMatchObject({ underSessionId: sessionId });
        return { status: 200, data: createSessionReadBatchResponseFixture({ request: body, sessions: [
          parent, ...(!detached ? [child] : []),
        ] }) };
      }
      expect(String(url)).toBe(`${home}/v2/sessions/query`);
      const query = SessionListQueryV1Schema.parse(body);
      queries.push(query);
      expect(query.underSessionId).toBe(sessionId);
      return { status: 200, data: SessionRuntimeManagedSubtreeListResponseV1Schema.parse({ sessions: query.storage === 'archived' ? [] : [
        createCompactSessionListRowFixture(parent),
        ...(!detached ? [createCompactSessionListRowFixture(child)] : []),
      ], nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false }) };
    });
    const sessionList = createRestrictedCurrentSessionListActionDependency({ credentials, sessionId,
      serverId: context.serverId, serverHttpBaseUrl: home, material: { mode: 'plain' } });
    const harness = createCliActionExecutorHarness({ token: credentials.token, sessionId, mode: 'plain', ctx: null,
      serverId: context.serverId, serverHttpBaseUrl: home,
      getCurrentSessionMetadata: () => ({ machineId: 'machine', path: '/repo' }),
      getCurrentSessionBackendTarget: () => ({ kind: 'backend', backendId: 'codex', sourceKind: 'built_in' }),
    }, { sessionList });
    const executor = createSessionAccountActionExecutor({ base: harness.executor, client: {
      sessionId, getServerBinding: () => ({ serverId: context.serverId, serverUrl: home }), updateMetadata() {},
      rpcHandlerManager: { invokeLocal: async () => null, registerHandler() {} },
    } });
    const nativeContext = { surface: 'agent', authority: 'account_automation', defaultSessionId: sessionId,
      sessionListAccess: 'current_session', actionCaller: { kind: 'session', sessionId, starterDepth: 0, turnDepth: 0 },
      callerPermissionMode: 'default',
    } as const;
    const callerContext = { ...nativeContext, agentStartContext: {
      caller: nativeContext.actionCaller, baseline: { machineId: 'machine', directory: '/repo' }, roles: {},
      ledSubtreeSessionIds: [], workDepthLimit: 4, callerPermissionCeiling: 'default' as const,
    } };
    await expect(executor.execute('session.list', { underSessionId: sessionId }, nativeContext))
      .resolves.toMatchObject({ ok: true, result: { sessions: [{ id: sessionId }, { id: managerId }] } });
    // Exercise the actual native composition, including its dependency overrides
    // and caller stamping; the harness-only owner path above cannot prove those.
    const runtime = createHappierMcpServer({ sessionId,
      getServerBinding: () => ({ serverId: context.serverId, serverUrl: home }),
      rpcHandlerManager: new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain' }),
      updateMetadata() {}, getMetadataSnapshot: () => createTestMetadata({ machineId: 'machine', path: '/repo', flavor: 'codex' }),
      getBackendTarget: () => ({ kind: 'backend', backendId: 'codex', sourceKind: 'built_in' }),
      getPermissionMode: () => 'default',
      getWorkDepth: () => 0, getHostTurnWorkDepth: () => 0,
      getActiveTurnPermissionWitness: () => ({ turnId: 'target-turn', causalPermissionAuthority: {
        kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default',
      } }),
    }, { authorityScope: 'session', sessionCredentials: credentials, sessionList });
    const mcpClient = new Client({ name: 'native-target-composition', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await runtime.mcp.connect(serverTransport);
      await mcpClient.connect(clientTransport);
      const listing = await runtime.executeTool({ toolName: 'action_execute', args: {
        actionId: 'session.list', input: { underSessionId: sessionId },
      } });
      expect(listing, JSON.stringify(listing)).toMatchObject({ ok: true, result: { sessions: [{ id: sessionId }, { id: managerId }] } });
      for (const target of [{ selector: 'workers', of: sessionId }, managerId, { selector: 'self', of: managerId }]) {
        const response = CallToolResultSchema.parse(await mcpClient.callTool({ name: 'action_execute', arguments: {
          actionId: 'session.targets.resolve', input: { actionId: 'session.goal.get', target },
        } }));
        const content = response.content.find(entry => entry.type === 'text');
        if (content?.type !== 'text') throw new Error('Missing native target response');
        expect.soft(JSON.parse(content.text), content.text).toMatchObject({ coverage: 'complete',
          addresses: [{ serverId: context.serverId, sessionId: managerId }] });
      }
    } finally { await mcpClient.close(); await runtime.mcp.close(); }
    const beforeForeignList = queries.length;
    for (const input of [{ underSessionId: managerId }, { query: {
      v: 1, storage: 'active', includeInactive: true, scope: 'all_accessible', attention: 'any',
      audiences: [], tagIds: [], underSessionId: managerId,
    } }]) {
      await expect(executor.execute('session.list', input, nativeContext))
        .resolves.toMatchObject({ ok: false, errorCode: 'unsupported_action' });
    }
    expect(queries).toHaveLength(beforeForeignList);
    for (const target of [managerId, { selector: 'workers' }] as const) {
      await expect(executor.execute('session.targets.resolve', { actionId: 'session.goal.get', target }, {
        ...nativeContext, agentStartContext: { ...callerContext.agentStartContext,
          caller: { ...nativeContext.actionCaller, sessionId: 'foreign-session' } },
      })).resolves.toMatchObject({ ok: true, result: { coverage: 'unavailable', addresses: [] } });
    }
    expect(queries).toHaveLength(beforeForeignList);
    for (const target of [{ selector: 'workers' }, managerId, { selector: 'self', of: managerId }] as const) {
      await expect.soft(executor.execute('session.targets.resolve', { actionId: 'session.goal.get', target }, nativeContext))
        .resolves.toMatchObject({ ok: true, result: { coverage: 'complete', addresses: [{ serverId: context.serverId, sessionId: managerId }] } });
    }
    // START authority remains current-Session-only. READ membership comes from
    // the fresh restricted subtree proof, not the empty captured start corpus.
    await expect.soft(resolveActionCurrentSessionScopeFailure('session.activity.get', { sessionId: managerId },
      callerContext, { sessionId: 'current_session' }, harness.deps)).resolves.toBeNull();
    await expect.soft(executor.execute('session.targets.resolve', { actionId: 'session.goal.get',
      target: { selector: 'manager', of: managerId } }, nativeContext))
      .resolves.toMatchObject({ ok: true, result: { coverage: 'complete', addresses: [{ sessionId }] } });
    // Private rule membership cannot be declared complete from subtree facts.
    await expect(executor.execute('session.targets.resolve', { actionId: 'session.goal.get',
      target: { selector: 'followers', of: managerId } }, nativeContext))
      .resolves.toMatchObject({ ok: true, result: { coverage: 'unavailable', addresses: [] } });
    await expect(executor.execute('session.targets.resolve', { actionId: 'session.goal.get',
      target: { selector: 'self', of: 'foreign-session' } }, nativeContext))
      .resolves.toMatchObject({ ok: true, result: { coverage: 'unavailable', addresses: [] } });
    await expect(createActionExecutor(harness.deps).execute('session.targets.resolve', { actionId: 'session.goal.get',
      target: managerId }, { ...nativeContext, serverId: 'other-home' }))
      .resolves.toMatchObject({ ok: true, result: { coverage: 'unavailable', addresses: [] } });
    detached = true;
    await expect(executor.execute('session.targets.resolve', { actionId: 'session.goal.get',
      target: managerId }, nativeContext))
      .resolves.toMatchObject({ ok: true, result: { coverage: 'unavailable', addresses: [] } });
    await expect(resolveActionCurrentSessionScopeFailure('session.activity.get', { sessionId: managerId },
      callerContext, { sessionId: 'current_session' }, harness.deps))
      .resolves.toMatchObject({ ok: false, details: { cause: 'target_outside_led_subtree' } });
    expect.soft(queries.length).toBeGreaterThan(0);
  });

  it('evaluates one Follow source without reading the corpus, preserving match, miss and unknown', async () => {
    const { deps } = setup(null);
    const post = vi.spyOn(axios, 'post').mockImplementation(async () => { throw new Error('No corpus access'); });
    const filter = normalizeSessionListFilterV1({ homeServerIds: [context.serverId], show: 'sessions',
      startedBy: ['you', 'agents', 'triggers'], scope: 'all_accessible' });
    const read = (value: typeof filter) => deps.sessionFollowPreview!({ context, sourceSessionId: sessionId,
      input: { receiver: { kind: 'session', sessionId: managerId }, filter: value } });
    expect(await read(filter)).toMatchObject({ coverage: 'complete', matches: [{ source: { kind: 'session', sessionId } }] });
    expect(await read({ ...filter, homeServerIds: ['different-home'] })).toMatchObject({ coverage: 'complete', matches: [] });
    expect(await read({ ...filter, underSessionId: managerId })).toMatchObject({ coverage: 'partial', matches: [],
      unavailable: [{ source: { kind: 'session', sessionId } }] });
    expect(post).not.toHaveBeenCalled();
  });

  it('previews targets through native MCP and signed daemon reads under the preview root', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'native-target-preview-root-' }, async () => {
      const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(23));
      const { deps, credentials, session, get } = setup(null, { privateKey: keys.secretKey, installationId: 'installation' });
      const childId = 'c666666666666666666666666';
      const child = { ...createSessionNotificationContextFixture(childId), ...session, id: childId, manager: { sessionId } };
      const homeGet = get.getMockImplementation()!;
      const rejectedEffects: unknown[] = [];
      // Home HTTP is the boundary: signed read effects must retain the admitted
      // root (verifyCommon's effect_family), not impersonate the previewed Action.
      get.mockImplementation(async (url, config) => {
        const effect = config?.headers?.[EXTERNAL_ACTION_EFFECT_ACTION_HEADER];
        if (effect && effect !== 'session.targets.resolve') {
          rejectedEffects.push(effect);
          throw Object.assign(new Error('Signed root mismatch'), { response: { status: 401 } });
        }
        if (String(url).endsWith(`/v2/sessions/${childId}`)) return { status: 200, data: { session: child } };
        return homeGet(url, config);
      });
      vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
        if (String(url).endsWith('/v2/sessions/read-batch')) return { status: 200, data: createSessionReadBatchResponseFixture({ request: body, sessions: [child] }) };
        expect(String(url)).toBe(`${home}/v2/sessions/query`);
        const query = SessionListQueryV1Schema.parse(body);
        return { status: 200, data: createCompactSessionListQueryResponseFixture({
          sessions: query.storage === 'active' ? [child] : [], nextCursor: null, hasNext: false,
          attentionNextCursor: null, attentionHasNext: false,
        }) };
      });
      const daemon = createDaemonSessionAccountActionExecutor({ serverId: context.serverId,
        serverHttpBaseUrl: home, token: credentials.token, credentials,
        createExecutor: () => createActionExecutor(deps),
        prepareExternalActionAuthorization: async ({ operation }) => {
          const target = { kind: 'machine' as const, machineId: 'machine-selected' };
          return { target, authorization: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'native-preview-proof', binding: {
            accountId: 'account-1', authentication: { kind: 'account', tokenEpoch: 1 }, accountEncryptionMode: 'plain',
            serverIdentityId: context.serverId, custodianAccountId: 'account-1', machineId: target.machineId,
            installationId: 'installation', actionId: operation.actionId, requestId: operation.requestId, target,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(ExternalActionRequestEnvelopeSchema.parse({ v: 1, target,
              requestId: operation.requestId, input: operation.input })),
          } }) };
        },
      });
      const authority = await createSessionDaemonAuthorityFixture({ sessionId,
        execute: operation => daemon(operation, { sessionId, isCurrent: async () => true }),
      });
      const witness = { turnId: 'preview-turn', inputId: 'preview-input', userMessageSeq: 1, userMessageSeqs: [1],
        agentStartCaller: { kind: 'session' as const, sessionId, starterDepth: 0, turnDepth: 0 } };
      const runtime = createHappierMcpServer({ sessionId,
        getServerBinding: () => ({ serverId: context.serverId, serverUrl: home }),
        rpcHandlerManager: new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain' }),
        updateMetadata() {}, getWorkDepth: () => 0, getHostTurnWorkDepth: () => 0,
        getActiveTurnAdmissionWitness: () => witness,
        getActiveTurnPermissionWitness: () => ({ ...witness, causalPermissionAuthority: {
          kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default',
        } }),
      }, { credentials, actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({ v: 1 }) } });
      const mcpClient = new Client({ name: 'signed-native-target-composition', version: '1' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      try {
        await runtime.mcp.connect(serverTransport);
        await mcpClient.connect(clientTransport);
        for (const target of [childId, { selector: 'workers', of: sessionId }, { selector: 'self', of: childId }]) {
          const response = CallToolResultSchema.parse(await mcpClient.callTool({ name: 'action_execute', arguments: {
            actionId: 'session.targets.resolve', input: { actionId: 'session.goal.get', target },
          } }));
          const content = response.content.find(entry => entry.type === 'text');
          if (content?.type !== 'text') throw new Error('Missing signed native target response');
          expect.soft(JSON.parse(content.text), JSON.stringify({ target, response: content.text })).toMatchObject({ coverage: 'complete',
            addresses: [{ serverId: context.serverId, sessionId: childId }] });
        }
        expect.soft(rejectedEffects).toEqual([]);
      } finally { await mcpClient.close(); await runtime.mcp.close(); await authority.close(); }
    });
  });

  it('reads Following and private rules through the portable Home of a fixed local profile', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'follow-portable-home-' }, async () => {
      const profileId = 'stack_agent-qa-coord-n1__id_default';
      await seedTestServerProfile({ id: profileId, homeId: context.serverId, serverUrl: home });
      const { credentials } = setup(null);
      const params = { token: credentials.token, credentials, sessionId, mode: 'plain' as const, ctx: null,
        serverId: profileId, serverIdentityId: context.serverId, serverHttpBaseUrl: home };
      const executor = createCliActionExecutor(params);
      const follow = createSessionFollowActionDeps(params);
      const sourceId = 'c333333333333333333333333';
      vi.spyOn(axios, 'request').mockImplementation(async config => {
        if (config.url === `${home}/v2/account/session-follow-rules`) return { status: 200, data: { rules: [] } };
        if (config.url === `${home}/v2/sessions/${sessionId}/follows/sessions`) return { status: 200,
          data: { sources: [{ sourceSessionId: sourceId, destinationSessionId: sessionId,
            relation: 'follower', policy: { preset: 'quiet' }, deliveryState: 'eligible', hasPendingUpdates: false }] } };
        throw new Error(`Unexpected Follow read: ${config.url}`);
      });
      await expect.soft(follow.readSessionFollowRules!({ context, serverId: context.serverId }))
        .resolves.toEqual({ kind: 'complete', rules: [] });
      await expect(executor.execute('session.targets.resolve', {
        target: { selector: 'following', of: sessionId }, actionId: 'session.message.send',
      }, context)).resolves.toMatchObject({ ok: true, result: { coverage: 'complete',
        addresses: [{ serverId: context.serverId, sessionId: sourceId }], error: null } });
      await expect(follow.readSessionFollowRules!({ context, serverId: 'srv_other_home' }))
        .resolves.toEqual({ kind: 'unavailable' });
      await expect(follow.readSessionFollowRules!({ context: { ...context, serverId: 'srv_other_home' }, serverId: profileId }))
        .resolves.toEqual({ kind: 'unavailable' });
      await expect(follow.sessionFollowAction!({ context: { ...context, serverId: 'srv_other_home' }, serverId: profileId,
        actionId: 'follow.list', input: { direction: 'following', receiver: { kind: 'session', sessionId } } }))
        .resolves.toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
    });
  });

  it('uses portable Home Project facts for preview, Matching and direct Project listing from a local profile', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'preview-portable-home-' }, async () => {
      const profileId = 'stack_agent-qa-coord-n1__id_default';
      await seedTestServerProfile({ id: profileId, homeId: context.serverId, serverUrl: home });
      const { credentials, session } = setup(null);
      const candidate = { ...createSessionNotificationContextFixture(sessionId), ...session };
      const deps = createCliActionDeps({ token: credentials.token, credentials, sessionId, mode: 'plain', ctx: null,
        serverId: profileId, serverIdentityId: context.serverId, serverHttpBaseUrl: home });
      const ref = { id: 'checkout', serverId: context.serverId, machineId: 'machine-selected', rootPath: '/repo',
        projectKey: 'qa-project', createdAtMs: 1 };
      const key = { kind: 'workspace-ref', serverId: context.serverId, id: ref.id };
      const previewQueries: SessionListQueryV1[] = [];
      vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
        if (String(url).endsWith('/v2/sessions/read-batch')) return { status: 200, data: createSessionReadBatchResponseFixture({ request: body, sessions: [candidate] }) };
        if (String(url).endsWith('/v1/account/project-rows/list')) return { status: 200,
          data: { status: 'listed', coverage: 'complete', rows: [{ key, revision: 0, content: { t: 'plain', v: { key, value: ref } } }] } };
        if (String(url).endsWith('/v2/sessions/query')) {
          previewQueries.push(SessionListQueryV1Schema.parse(body));
          return { status: 200,
          data: createCompactSessionListQueryResponseFixture({ sessions: [candidate], nextCursor: null, hasNext: false,
            attentionNextCursor: null, attentionHasNext: false }) };
        }
        throw new Error(`Unexpected Project/Session read: ${url}`);
      });
      const project = { serverId: context.serverId, projectKey: 'qa-project' };
      const filter = normalizeSessionListFilterV1({ homeServerIds: [context.serverId], show: 'sessions', scope: 'all_accessible',
        startedBy: ['you', 'agents', 'triggers'], projects: { include: [project], exclude: [] } });
      await expect(deps.sessionFollowPreview!({ context, serverId: context.serverId,
        input: { receiver: { kind: 'account' }, filter } })).resolves.toMatchObject({ coverage: 'complete', matchCount: 1,
          matches: [{ serverId: context.serverId, source: { kind: 'session', sessionId } }], unavailable: [] });
      await expect(deps.sessionFollowPreview!({ context: { ...context, serverId: profileId }, serverId: profileId,
        input: { receiver: { kind: 'account' }, filter: { ...filter, homeServerIds: [profileId],
          projects: { include: [{ ...project, serverId: profileId }], exclude: [] } } } }))
        .resolves.toMatchObject({ coverage: 'complete', matchCount: 1,
          matches: [{ serverId: context.serverId, source: { kind: 'session', sessionId } }], unavailable: [] });
      await expect(createActionExecutor(deps).execute('session.targets.resolve', {
        target: { selector: 'matching', filter }, actionId: 'session.message.send',
      }, context)).resolves.toMatchObject({ ok: true, result: { coverage: 'complete',
        addresses: [{ serverId: context.serverId, sessionId }], error: null } });
      expect(previewQueries).toHaveLength(3);
      for (const query of previewQueries) expect(query).toMatchObject({ limit: SESSION_LIST_PAGE_MAX_LIMIT,
        includeInactive: true, includeAttention: false });
      await expect(deps.sessionList({ context, project, query: { v: 1, storage: 'active', includeInactive: true,
        scope: 'all_accessible', attention: 'any', audiences: [], tagIds: [] } }))
        .resolves.toMatchObject({ sessions: [{ id: sessionId }] });
      await expect(deps.sessionList({ context, serverId: 'srv_other_home' }))
        .resolves.toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
    });
  });

  it.each([
    ['advertised', 'plain'], ['advertised', 'e2ee'], ['older', 'plain'], ['malformed', 'plain'],
    ['disabled', 'plain'], ['unavailable', 'plain'],
  ] as const)(
    'selects Project preview candidates before document hydration only with exact Home support (%s, %s)', async (support, mode) => {
      await withConfiguredDaemonTestHome({ prefix: 'preview-project-selection-' }, async () => {
        resetServerFeaturesClientForTests();
        const { deps, session, credentials } = runWithServerHttpBaseUrl('https://construction-home.test', () => setup(null, mode === 'e2ee' ? {
          privateKey: nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(23)).secretKey,
          installationId: 'installation', secret: new Uint8Array(32).fill(17),
        } : undefined, home));
        const invocationHome = 'https://unselected-ambient-home.test';
        const ref = { id: 'checkout', serverId: context.serverId, machineId: 'machine-selected', rootPath: '/repo',
          projectKey: 'qa-project', createdAtMs: 1 };
        const key = { kind: 'workspace-ref' as const, serverId: context.serverId, id: ref.id };
        const projectContent = createProjectAccountRowCipherV1({ mode, material: credentials.encryption,
          randomBytes: nacl.randomBytes }).seal({ key, value: ref });
        const rows: V2SessionRecord[] = [
          ...Array.from({ length: 2_448 }, (_, index) => ({ ...createSessionNotificationContextFixture(`unrelated-${index}`),
            ...session, id: `unrelated-${index}`, projectKey: 'other-project' })),
          ...['matching-one', 'matching-two'].map(id => ({ ...createSessionNotificationContextFixture(id),
            ...session, id, projectKey: ref.projectKey })),
        ];
        const featureReads: string[] = [];
        vi.stubGlobal('fetch', async (url: string | URL | Request) => {
          featureReads.push(String(url));
          expect(new URL(String(url)).origin).toBe(home);
          if (support === 'unavailable') throw new TypeError('Home feature observation unavailable');
          const payload = { features: { sessions: { enabled: true, filteredListing: { enabled: support !== 'disabled',
            ...(support === 'older' ? {} : { projectSelectorVersion: support === 'malformed' ? 'invalid' : 1 }),
          } } }, capabilities: {} };
          return Response.json(support === 'malformed' ? payload : FeaturesResponseSchema.parse(payload));
        });
        const queries: SessionListQueryV1[] = [];
        const hydratedIds: string[] = [];
        vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
          expect(new URL(String(url)).origin).toBe(home);
          if (String(url).endsWith('/v1/account/project-rows/list')) return { status: 200,
            data: { status: 'listed', coverage: 'complete', rows: [{ key, revision: 0, content: projectContent }] } };
          if (String(url).endsWith('/v2/sessions/read-batch')) {
            const response = createSessionReadBatchResponseFixture({ request: body, sessions: rows });
            hydratedIds.push(...response.results.map(result => result.sessionId));
            return { status: 200, data: response };
          }
          expect(String(url)).toBe(`${home}/v2/sessions/query`);
          const query = SessionListQueryV1Schema.parse(body);
          queries.push(query);
          const selector = query.projectKeys;
          const selected = selector ? rows.filter(row => row.projectKey == null
            || (selector.include.length === 0 || selector.include.includes(row.projectKey))
              && !selector.exclude.includes(row.projectKey)) : rows;
          const previousId = query.cursor ? rows.find(row => encodeV2SessionListCursorV2({ sessionId: row.id,
            meaningfulActivityAt: 1 }) === query.cursor)?.id : undefined;
          const offset = previousId === undefined ? 0 : selected.findIndex(row => row.id === previousId) + 1;
          const page = selected.slice(offset, offset + SESSION_LIST_PAGE_MAX_LIMIT);
          const hasNext = offset + page.length < selected.length;
          return { status: 200, data: createCompactSessionListQueryResponseFixture({ sessions: page,
            nextCursor: hasNext ? encodeV2SessionListCursorV2({ sessionId: page.at(-1)!.id, meaningfulActivityAt: 1 }) : null,
            hasNext, attentionNextCursor: null, attentionHasNext: false }) };
        });
        const filter = normalizeSessionListFilterV1({ homeServerIds: [context.serverId], show: 'sessions', scope: 'all_accessible',
          startedBy: ['you', 'agents', 'triggers'], projects: { include: [{ serverId: context.serverId, projectKey: ref.projectKey }], exclude: [] } });
        await expect(runWithServerHttpBaseUrl(invocationHome, () => deps.sessionList({ context: {
          ...context, sessionListAccess: 'current_session', defaultSessionId: sessionId,
        } }))).resolves.toMatchObject({ sessions: [{ id: sessionId }] });
        await expect(runWithServerHttpBaseUrl(invocationHome, () => deps.sessionFollowPreview!({ context,
          input: { receiver: { kind: 'account' }, filter } })))
          .resolves.toMatchObject({ coverage: 'complete', matchCount: 2,
            matches: ['matching-one', 'matching-two'].map(id => ({ source: { kind: 'session', sessionId: id } })) });
        expect(hydratedIds).toHaveLength(support === 'advertised' ? 2 : rows.length);
        expect(queries).toHaveLength(support === 'advertised' ? 1 : Math.ceil(rows.length / SESSION_LIST_PAGE_MAX_LIMIT));
        if (support === 'advertised') {
          expect(queries[0]?.projectKeys).toEqual({ include: [ref.id, ref.projectKey], exclude: [] });
          expect(hydratedIds).toEqual(['matching-one', 'matching-two']);
        } else for (const query of queries) expect(query).not.toHaveProperty('projectKeys');
        expect(featureReads.length).toBeGreaterThan(0);
        rows[0]!.projectKey = ref.projectKey;
        rows.push({ ...createSessionNotificationContextFixture('unpublished'), ...session, id: 'unpublished', projectKey: null });
        hydratedIds.length = 0;
        queries.length = 0;
        const result = await runWithServerHttpBaseUrl(invocationHome, () => createActionExecutor(deps).execute('session.targets.resolve', {
          target: { selector: 'matching', filter }, actionId: 'session.message.send',
        }, context));
        expect(result).toMatchObject({ ok: true, result: { coverage: 'complete', addresses: [
          { serverId: context.serverId, sessionId: rows[0]!.id },
          ...['matching-one', 'matching-two', 'unpublished'].map(id => ({ serverId: context.serverId, sessionId: id })),
        ] } });
        expect(hydratedIds).toHaveLength(support === 'advertised' ? 4 : rows.length);
        expect(queries).toHaveLength(support === 'advertised' ? 1 : Math.ceil(rows.length / SESSION_LIST_PAGE_MAX_LIMIT));
      });
    },
  );

  function setup(manager: string | null = managerId, requester?: Readonly<{ privateKey: Uint8Array; installationId: string; secret?: Uint8Array }>,
    serverHttpBaseUrl: string | null = home) {
    const secret = requester?.secret;
    const encryption = secret ? { type: 'legacy' as const, secret } : null;
    const credentials = { token: 'token', encryption };
    const material = secret ? { mode: 'e2ee' as const, ctx: { encryptionKey: secret, encryptionVariant: 'legacy' as const } }
      : { mode: 'plain' as const, ctx: null };
    const mode = material.mode;
    const ownerMetadata = { v: 1 as const, workspace: { path: '/repo', host: 'host', machineId: 'machine-selected' } };
    const session = createSessionRecordFixture({ id: sessionId, encryptionMode: mode, metadataLayoutVersion: 1,
      share: null, dataEncryptionKey: null, metadata: secret
        ? encryptSessionPayload({ ctx: { encryptionKey: secret, encryptionVariant: 'legacy' }, payload: { v: 1 } })
        : JSON.stringify({ v: 1 }),
      ownerMetadata: encryption ? sealSessionOwnerMetadataEnvelopeV1({ material: encryption, ownerMetadata, randomBytes: nacl.randomBytes })
        : createPlainSessionOwnerMetadataEnvelopeV1(ownerMetadata),
      ...(manager ? { manager: { sessionId: manager } } : {}),
    });
    const records: V2SessionRecord[] = [session];
    const patchedSessionIds: string[] = [];
    // Only Home HTTP is substituted; reference resolution, currentness,
    // access projection, Action dispatch and status projection stay real.
    const get = vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
      expect(new URL(String(url)).origin).toBe(home);
      if (!requester) expect(config?.headers).toMatchObject({ Authorization: 'Bearer token' });
      if (String(url).endsWith('/v1/account/encryption/currentness')) return { status: 200,
        data: createAccountEncryptionCurrentnessFixture({ mode }) };
      if (String(url).endsWith('/v1/account/encryption')) return { status: 200, data: { mode, updatedAt: 0 } };
      if (requester && String(url).endsWith('/v1/account/profile')) return { status: 200, data: { id: 'account-1' } };
      const record = records.find(row => String(url) === `${home}/v2/sessions/${row.id}`);
      if (record) return { status: 200, data: { session: record } };
      if (String(url).endsWith('/v2/account/settings')) return { status: 200,
        data: AccountSettingsV2GetResponseSchema.parse({ content: encryption
          ? { t: 'encrypted', c: sealAccountScopedBlobCiphertext({ kind: 'account_settings', material: encryption, payload: {}, randomBytes: nacl.randomBytes }) }
          : { t: 'plain', v: {} }, version: 1 }) };
      throw new Error(`Unexpected Home read: ${url}`);
    });
    // This fake Home owns the real tuple CAS boundary too: maintenance must
    // persist its projection, rather than retry an unhandled network write.
    vi.spyOn(axios, 'patch').mockImplementation(async (url, body, config) => {
      expect(config?.headers).toMatchObject({ Authorization: 'Bearer token' });
      const record = records.find(row => String(url) === `${home}/v2/sessions/${row.id}`);
      if (!record) throw new Error(`Unexpected Home write: ${url}`);
      const patch = SessionMetadataTuplePatchV1Schema.parse(body);
      if (patch.mode !== 'owner' || !patch.displayProjectionV1) throw new Error('Expected owner display maintenance');
      expect(patch).toMatchObject({ sharedMetadata: { ciphertext: record.metadata, expectedVersion: record.metadataVersion },
        ownerMetadata: record.ownerMetadata, agentState: { ciphertext: record.agentState, expectedVersion: record.agentStateVersion } });
      expect(patch.displayProjectionV1).toMatchObject({ metadataLayoutVersion: 1, sourceMetadataVersion: record.metadataVersion + 1 });
      record.metadataVersion += 1;
      record.displayProjectionV1 = patch.displayProjectionV1;
      patchedSessionIds.push(record.id);
      return { status: 200, data: { success: true, metadataLayoutVersion: 1,
        sharedMetadata: { version: record.metadataVersion }, agentState: { version: record.agentStateVersion } } };
    });
    const deps = createCliActionDeps({ token: 'token', credentials,
      sessionId, ...material, serverIdentityId: 'srv_target_home',
      ...(serverHttpBaseUrl ? { serverId: 'srv_target_home', serverHttpBaseUrl } : { serverId: undefined, serverHttpBaseUrl: undefined }),
      ...(requester ? { externalActionMachineRequestPrivateKey: requester.privateKey,
        externalActionMachineInstallationId: requester.installationId } : {}),
    });
    return { deps, get, session, credentials, records, patchedSessionIds };
  }

  it.each(['plain', 'e2ee'] as const)('recovers an absent admitted native Delete without resolving another Session tag (%s)', async mode => {
    const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(37));
    const signer = { privateKey: keys.secretKey, installationId: 'delete-installation',
      ...(mode === 'e2ee' ? { secret: new Uint8Array(32).fill(38) } : {}) };
    const { deps, get, credentials } = setup(null, signer);
    const reads: string[] = [];
    const read = get.getMockImplementation()!;
    get.mockImplementation(async (url, config) => {
      reads.push(new URL(String(url)).pathname);
      if (String(url).endsWith(`/v2/sessions/${sessionId}`)) return { status: 404, data: { error: 'Session not found' } };
      return read(url, config);
    });
    const tagLookup = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { sessions: [
      createSessionRecordFixture({ id: managerId, encryptionMode: 'plain', metadata: '{}' }),
    ] } });
    const deletions: string[] = [];
    vi.spyOn(axios, 'request').mockImplementation(async request => {
      expect(request.method).toBe('DELETE');
      deletions.push(String(request.url));
      return { status: 404, data: { error: 'Session not found or not owned by user' } };
    });
    const input = { sessionId };
    const target = { kind: 'machine' as const, machineId: 'machine-selected' };
    const requestId = 'already-absent-delete';
    // Home authorization is the external boundary; native resolution and idempotent recovery stay real.
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'admitted-delete', binding: {
      accountId: 'account-1', authentication: { kind: 'account', tokenEpoch: 1 }, accountEncryptionMode: mode,
      serverIdentityId: context.serverId, custodianAccountId: 'account-1', machineId: target.machineId,
      installationId: signer.installationId, actionId: 'session.delete', requestId, target,
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(ExternalActionRequestEnvelopeSchema.parse({
        v: 1, target, requestId, input })),
    } });
    const homeDeps = createAccountServerActionDeps({ token: credentials.token, credentials,
      serverId: context.serverId, serverIdentityId: context.serverId, serverHttpBaseUrl: home,
      externalActionMachineRequestPrivateKey: signer.privateKey, externalActionMachineInstallationId: signer.installationId });
    expect(await executeSessionDelete({ input,
      context: { ...context, actionRequestId: requestId, externalActionTarget: target,
        externalActionExecutionAuthorization: authorization },
      deps: { ...deps, homeDomainAction: homeDeps.homeDomainAction }, isDeferredApprovalResult: () => false,
    })).toMatchObject({ ok: true, result: { success: true } });
    expect(reads.sort()).toEqual(['/v1/account/encryption/currentness', `/v2/sessions/${sessionId}`].sort());
    expect(tagLookup).not.toHaveBeenCalled();
    expect(deletions).toEqual([`${home}/v1/sessions/${sessionId}`]);
  });

  it('binds the canonical reference resolver and manager read to the exact Home', async () => {
    const { deps } = setup();
    const signal = new AbortController().signal;
    expect(await deps.resolveSessionReference!({ sessionId, context, actionId: 'session.status.get', signal }))
      .toEqual({ kind: 'unique', address: { serverId: 'srv_target_home', sessionId } });
    expect(await deps.readSessionManager!({ address: { serverId: 'srv_target_home', sessionId },
      context, actionId: 'session.status.get', signal }))
      .toEqual({ kind: 'manager', address: { serverId: 'srv_target_home', sessionId: managerId } });
    const result = await createActionExecutor(deps).execute('session.status.get', { sessionId, live: false }, context);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { ok: true, session: { id: sessionId } } });
  });

  it('refuses a prefix that resolves outside an exact Session routing address without changing legacy omission', async () => {
    const { deps } = setup();
    const prefix = sessionId.slice(0, 8);
    const listedSession = createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain', metadata: '{}', dataEncryptionKey: null });
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      if (String(url).endsWith('/v2/sessions/read-batch')) return { status: 200,
        data: createSessionReadBatchResponseFixture({ request: body, sessions: [listedSession] }) };
      expect(String(url)).toBe(`${home}/v2/sessions/lookup-by-tags`);
      return { status: 200, data: { sessions: [] } };
    });
    const get = vi.mocked(axios.get);
    const read = get.getMockImplementation()!;
    get.mockImplementation(async (url, config) => {
      const pathname = new URL(String(url)).pathname;
      if (['/v2/sessions', '/v2/sessions/archived'].includes(pathname)) {
        expect(new URL(String(url)).origin).toBe(home);
        return { status: 200, data: { sessions: pathname.endsWith('/archived') ? [] : [createCompactSessionListRowFixture(listedSession)], nextCursor: null, hasNext: false } };
      }
      if (String(url) === `${home}/v1/machines/machine-selected`) {
        expect(config?.headers).toMatchObject({ Authorization: 'Bearer token' });
        return { status: 200, data: { machine: { id: 'machine-selected', active: true,
          kind: 'persistent', revokedAt: null, replacedByMachineId: null, managedMachineRef: null } } };
      }
      return read(url, config);
    });
    const sent: string[] = [];
    const pluginId = 'example.exact-session-author';
    const service = createPluginInvocationActionsService({
      seed: { plugin: { id: pluginId, version: '1.0.0' },
        contribution: { id: 'send', qualifiedId: `${pluginId}/actions/send` },
        occurrenceId: 'exact-session-author-current', sourceCustody: { kind: 'development', registeredRootId: 'exact-session-author-root' },
        resolveCurrentPluginMaterializationRef: createPluginActionCallerMaterializationFixture(pluginId).resolveCurrentPluginMaterializationRef,
        surface: 'background', signal: new AbortController().signal, isOccurrenceCurrent: () => true,
        approvalContext: { serverId: context.serverId, runtimeAccountId: 'account-1' } },
      actionExecutor: createActionExecutor({
    readActionsSettings: (context: ActionExecutorContext) => ActionsSettingsV1Schema.parse({ v: 1, ...context.actionsSettings, approvalWaivedSurfaces: {"session.message.send": Object.keys(ActionSurfaceSchema.shape), ...context.actionsSettings?.approvalWaivedSurfaces} }), ...deps,
        // Only the actual input writer is substituted. Home HTTP and canonical
        // CLI reference/prefix resolution remain real above this boundary.
        sessionSendMessage: async request => { sent.push(request.sessionId); return { status: 'accepted', localId: 'exact-send' }; },
      }),
      invokeContributedAction: async () => { throw new Error('Unexpected contributed Action'); },
    });
    const input = { sessionId: prefix, message: 'Exact routing', idempotencyKey: 'exact-send' };
    expect(await deps.resolveSessionReference!({ sessionId: prefix, context, actionId: 'session.message.send' }))
      .toEqual({ kind: 'unique', address: { serverId: context.serverId, sessionId } });
    await expect(service.execute('session.message.send', input,
      { sessionAddress: { serverId: context.serverId, sessionId: prefix } }))
      .rejects.toMatchObject({ code: 'session_target_unavailable' });
    expect(sent).toEqual([]);
    await expect(service.execute('session.message.send', { ...input, sessionId },
      { sessionAddress: { serverId: context.serverId, sessionId } })).resolves.toMatchObject({ status: 'accepted' });
    await expect(service.execute('session.message.send', input)).resolves.toMatchObject({ status: 'accepted' });
    expect(sent).toEqual([sessionId, prefix]);
  });

  it('does not retarget an admitted exact Session when the real writer later resolves its id as another Session tag', async () => {
    const { get, session, credentials } = setup();
    const originalRead = get.getMockImplementation()!;
    let exactReads = 0;
    const replacement = { ...session, id: managerId, active: true };
    get.mockImplementation(async (url, config) => {
      if (String(url).endsWith(`/v2/sessions/${sessionId}`)) {
        exactReads++;
        return exactReads === 1 ? { status: 200, data: { session: { ...session, active: true } } }
          : { status: 404, data: { error: 'Session not found' } };
      }
      return originalRead(url, config);
    });
    const tagLookups: unknown[] = [];
    const written: string[] = [];
    vi.spyOn(axios, 'post').mockImplementation(async (url, input) => {
      expect(String(url)).toBe(`${home}/v2/sessions/lookup-by-tags`);
      tagLookups.push(input);
      return { status: 200, data: { sessions: [replacement] } };
    });
    const deps = createCliActionDeps({ token: credentials.token, credentials, mode: 'plain', ctx: null,
      sessionId: 'cli-global', serverId: context.serverId, serverIdentityId: context.serverId, serverHttpBaseUrl: home,
      // Protected plugin input reaches its actual authenticated Machine seam.
      machineAdmissionTransport: async request => { written.push(request.sessionId); return { status: 'accepted', localId: request.localId }; },
    });
    let requireApproval = false;
    let approval: ApprovalRequest | null = null;
    const executor = createActionExecutor({ ...deps,
      readActionsSettings: () => ActionsSettingsV1Schema.parse({ v: 1, actions: { ['session.message.send']: { approvalRequiredSurfaces: (requireApproval) ? Object.keys(ActionSurfaceSchema.shape) : [] } } }),
      // Artifact persistence and host origin-currentness are genuine boundaries;
      // canonical capture, lifecycle transition and replay stay real.
      isApprovalExecutionOriginCurrent: async () => true,
      approvalsCreate: async ({ request }) => {
        approval = ApprovalRequestV2Schema.parse(request);
        return { artifactId: 'reviewed-session-approval' };
      },
      approvalsGet: async () => approval,
      approvalsUpdate: async ({ request }) => {
        if (!approval) throw new Error('Missing reviewed Session approval');
        const transition = decideApprovalRequestTransition(approval, request);
        if (!transition.ok) return transition;
        approval = ApprovalRequestV2Schema.parse(request);
        return { ok: true };
      },
    });
    const pluginId = 'example.reviewed-session-author';
    const service = createPluginInvocationActionsService({
      seed: { plugin: { id: pluginId, version: '1.0.0' },
        contribution: { id: 'send', qualifiedId: `${pluginId}/actions/send` },
        occurrenceId: 'reviewed-session-author-current', sourceCustody: { kind: 'development', registeredRootId: 'reviewed-session-author-root' },
        correlationId: 'reviewed-session-source-invocation',
        resolveCurrentPluginMaterializationRef: createPluginActionCallerMaterializationFixture(pluginId).resolveCurrentPluginMaterializationRef,
        surface: 'background', signal: new AbortController().signal, isOccurrenceCurrent: () => true,
        approvalContext: { serverId: context.serverId, serverIdentityId: context.serverId, runtimeAccountId: 'account-1' } },
      actionExecutor: executor,
      invokeContributedAction: async () => { throw new Error('Unexpected contributed Action'); },
    });
    const input = { sessionId, message: 'Only the reviewed Session', idempotencyKey: 'reviewed-session-send' };
    const exactResult = await runWithServerHttpBaseUrl(home, () => service.execute('session.message.send', input,
      { sessionAddress: { serverId: context.serverId, sessionId } }));
    expect(written, JSON.stringify({ exactResult, exactReads, tagLookups })).toEqual([]);
    expect(exactResult).toMatchObject({ status: 'rejected', code: 'session_input_target_unavailable' });
    expect(exactReads).toBeGreaterThanOrEqual(2);
    expect(written).toEqual([]);
    // Omission intentionally retains the ordinary CLI reference/tag contract.
    await expect(runWithServerHttpBaseUrl(home, () => service.execute('session.message.send', input)))
      .resolves.toMatchObject({ status: 'accepted' });
    expect(tagLookups).toContainEqual({ tags: [sessionId] });
    expect(written).toEqual([managerId]);
    written.length = 0;
    exactReads = 0;
    requireApproval = true;
    const proposal = await runWithServerHttpBaseUrl(home, () => service.execute('session.message.send',
      { ...input, idempotencyKey: 'reviewed-session-replay' }, { sessionAddress: { serverId: context.serverId, sessionId } }));
    expect(proposal, JSON.stringify(proposal)).toMatchObject({ kind: 'approval_request_created' });
    expect(approval).toMatchObject({ executionOriginV1: { sessionTargetsV1: {
      targets: [{ serverId: context.serverId, sessionId }],
    } } });
    expect(written).toEqual([]);
    const replay = await runWithServerHttpBaseUrl(home, () => executor.execute('approval.request.decide',
      { artifactId: 'reviewed-session-approval', decision: 'approve' }, { ...context,
        serverIdentityId: context.serverId, runtimeAccountId: 'account-1', actionCaller: { kind: 'host' } }));
    expect(written, JSON.stringify(replay)).toEqual([]);
    expect(replay, JSON.stringify(replay)).toMatchObject({ ok: true });
    expect(ApprovalRequestV2Schema.parse(approval).execution).toMatchObject({ result: {
      status: 'rejected', code: 'session_input_target_unavailable',
    } });
  });

  it.each(['session.status.get', 'session.open'] as const)('retains the admitted exact Session through the real %s reader', async actionId => {
    const { deps, get, session } = setup();
    const read = get.getMockImplementation()!;
    let exactReads = 0;
    get.mockImplementation(async (url, config) => {
      if (String(url).endsWith(`/v2/sessions/${sessionId}`)) {
        exactReads++;
        return exactReads === 1 ? { status: 200, data: { session: { ...session, active: true } } }
          : { status: 404, data: { error: 'Session not found' } };
      }
      return read(url, config);
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, input) => {
      expect(String(url)).toBe(`${home}/v2/sessions/lookup-by-tags`);
      expect(input).toEqual({ tags: [sessionId] });
      return { status: 200, data: { sessions: [{ ...session, id: managerId, active: true }] } };
    });
    const pluginId = 'example.exact-session-reader';
    const service = createPluginInvocationActionsService({
      seed: { plugin: { id: pluginId, version: '1.0.0' },
        contribution: { id: 'read', qualifiedId: `${pluginId}/actions/read` },
        occurrenceId: 'exact-session-reader-current', sourceCustody: { kind: 'development', registeredRootId: 'exact-session-reader-root' },
        resolveCurrentPluginMaterializationRef: createPluginActionCallerMaterializationFixture(pluginId).resolveCurrentPluginMaterializationRef,
        surface: 'background', signal: new AbortController().signal, isOccurrenceCurrent: () => true,
        approvalContext: { serverId: context.serverId, runtimeAccountId: 'account-1' } },
      actionExecutor: createActionExecutor(deps),
      invokeContributedAction: async () => { throw new Error('Unexpected contributed Action'); },
    });
    const input = actionId === 'session.status.get' ? { sessionId, live: false, includeAcceptedWorkspace: true }
      : { sessionId, serverId: context.serverId, intent: 'resume' as const };
    const exact = await runWithServerHttpBaseUrl(home, () => service.execute(actionId, input,
      { sessionAddress: { serverId: context.serverId, sessionId } })).catch((error: unknown) => error);
    expect(exact, JSON.stringify(exact)).toMatchObject({ code: 'session_not_found' });
    expect(exactReads).toBeGreaterThanOrEqual(2);
    const legacy = await runWithServerHttpBaseUrl(home, () => service.execute(actionId, input));
    expect(legacy).toMatchObject(actionId === 'session.status.get' ? { ok: true, session: { id: managerId } }
      : { ok: true, sessionId: managerId });
  });

  it('distinguishes a successful no-manager read from unavailable current access', async () => {
    const { deps, get } = setup(null);
    const request = { address: { serverId: 'srv_target_home', sessionId }, context, actionId: 'session.status.get' as const };
    expect(await deps.readSessionManager!(request)).toEqual({ kind: 'manager', address: null });
    get.mockRejectedValue(new Error('Home unavailable'));
    expect(await deps.readSessionManager!(request)).toEqual({ kind: 'unavailable' });
    expect(await deps.resolveSessionReference!({ sessionId, context, actionId: 'session.status.get' }))
      .toEqual({ kind: 'incomplete' });
  });

  it('refuses another Home and cancellation before any transport read', async () => {
    const { deps, get } = setup();
    const foreign = { ...context, serverId: 'foreign-home' };
    expect(await deps.resolveSessionReference!({ sessionId, context: foreign, actionId: 'session.status.get' }))
      .toEqual({ kind: 'incomplete' });
    expect(await deps.readSessionManager!({ address: { serverId: 'foreign-home', sessionId },
      context, actionId: 'session.status.get' })).toEqual({ kind: 'unavailable' });
    expect(await deps.sessionStatusGet!({ sessionId, serverId: 'foreign-home', context, live: false }))
      .toMatchObject({ ok: false, errorCode: 'server_scope_mismatch' });
    const controller = new AbortController();
    controller.abort(new Error('cancel target resolution'));
    await expect(deps.resolveSessionReference!({ sessionId, context, actionId: 'session.status.get', signal: controller.signal }))
      .rejects.toThrow('cancel target resolution');
    await expect(deps.sessionStatusGet!({ sessionId, context, live: false, signal: controller.signal }))
      .rejects.toThrow('cancel target resolution');
    expect(get).not.toHaveBeenCalled();
  });

  it('keeps externally authorized live status on its admitted HTTP snapshot', async () => {
    const { deps, get } = setup();
    const socket = vi.spyOn(sessionSockets, 'createSessionScopedSocket').mockImplementation(() => {
      throw new Error('Own Account socket must not replace external authority');
    });
    const externalActionExecutionAuthorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'admitted', binding: {
      accountId: 'requester', authentication: { kind: 'account', tokenEpoch: 1 }, accountEncryptionMode: 'plain',
      serverIdentityId: 'srv_target_home', custodianAccountId: 'owner', machineId: 'machine', installationId: 'installation',
      actionId: 'session.status.get', requestId: 'status-request', target: { kind: 'session', sessionId },
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1({ v: 1, requestId: 'status-request',
        target: { kind: 'session', sessionId }, input: { sessionId, live: true } }),
    } });
    const result = await runWithServerHttpBaseUrl(home, () => getSessionStatus({
      credentials: { token: 'token', encryption: null }, idOrPrefix: sessionId, live: true,
      authorization: externalActionExecutionAuthorization,
      resolveAuthorizationHeaders: () => ({ Authorization: 'Bearer token' }),
    }));
    expect(result).toMatchObject({ ok: true, session: { id: sessionId } });
    expect(socket).not.toHaveBeenCalled();
    // These deps have no Machine signer for this external authorization. Both
    // selector reads must fail closed before using the host's Account token.
    get.mockClear();
    const externalContext = { ...context, externalActionExecutionAuthorization,
      externalActionTarget: { kind: 'session' as const, sessionId } };
    expect(await deps.readSessionManager!({ address: { serverId: 'srv_target_home', sessionId },
      context: externalContext, actionId: 'session.status.get' })).toEqual({ kind: 'unavailable' });
    expect(await deps.resolveSessionReference!({ sessionId, context: externalContext, actionId: 'session.status.get' }))
      .toEqual({ kind: 'incomplete' });
    expect(get).not.toHaveBeenCalled();
  });

  it('resolves 50 workers in a 1000-Session Account with two subtree pages and no worker detail reads', async () => {
    const { deps, get, session } = setup();
    const rows = Array.from({ length: 1000 }, (_, index) => {
      const id = `c${String(index).padStart(23, '0')}`;
      return { ...createSessionNotificationContextFixture(id), ...session, id,
        manager: index < 50 ? { sessionId } : undefined };
    });
    const queries: SessionListQueryV1[] = [];
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      if (String(url).endsWith('/v2/sessions/read-batch')) return { status: 200, data: createSessionReadBatchResponseFixture({ request: body, sessions: rows }) };
      expect(String(url)).toBe(`${home}/v2/sessions/query`);
      const query = SessionListQueryV1Schema.parse(body);
      queries.push(query);
      expect(query).toMatchObject({ underSessionId: sessionId, includeInactive: true, scope: 'all_accessible' });
      return { status: 200, data: createCompactSessionListQueryResponseFixture({
        sessions: query.storage === 'active' ? rows.filter(row => row.manager?.sessionId === query.underSessionId) : [],
        nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false,
      }) };
    });
    get.mockClear();
    const result = await createActionExecutor(deps).execute('session.targets.resolve', {
      actionId: 'session.status.get', target: { selector: 'workers' },
    }, { ...context, defaultSessionId: sessionId });
    expect(result).toMatchObject({ ok: true, result: { coverage: 'complete',
      addresses: rows.slice(0, 50).map(row => ({ serverId: context.serverId, sessionId: row.id })) } });
    expect(queries.map(query => query.storage)).toEqual(['active', 'archived']);
    expect(get.mock.calls.map(([url]) => new URL(String(url)).pathname)
      .filter(path => path.startsWith('/v2/sessions/'))).toEqual([`/v2/sessions/${sessionId}`]);
  });

  it('uses the real paged query and summary projection for direct and recursive workers', async () => {
    const { deps, get, session, records, patchedSessionIds } = setup();
    const childId = 'c333333333333333333333333';
    const grandchildId = 'c444444444444444444444444';
    const archivedChildId = 'c555555555555555555555555';
    const child = { ...createSessionNotificationContextFixture(childId), ...session, id: childId, manager: { sessionId } };
    const grandchild = { ...createSessionNotificationContextFixture(grandchildId), ...session, id: grandchildId, manager: { sessionId: childId } };
    const archivedChild = { ...createSessionNotificationContextFixture(archivedChildId), ...session,
      id: archivedChildId, archivedAt: 5, manager: { sessionId } };
    records.push(child, grandchild, archivedChild);
    const currentGet = get.getMockImplementation()!;
    get.mockImplementation(async (url, config) => {
      const row = [child, grandchild, archivedChild].find(candidate => String(url).endsWith(`/v2/sessions/${candidate.id}`));
      return row ? { status: 200, data: { session: row } } : currentGet(url, config);
    });
    const cursor = encodeV2SessionListCursorV2({ sessionId: childId, meaningfulActivityAt: 1 });
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      if (String(url).endsWith('/v2/sessions/read-batch')) return { status: 200, data: createSessionReadBatchResponseFixture({ request: body, sessions: [child, grandchild, archivedChild] }) };
      expect(String(url)).toBe(`${home}/v2/sessions/query`);
      expect(body).toMatchObject({ underSessionId: sessionId, includeInactive: true, scope: 'all_accessible' });
      const query = SessionListQueryV1Schema.parse(body);
      if (query.storage === 'archived') return { status: 200, data: createCompactSessionListQueryResponseFixture({
        sessions: [archivedChild], nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false,
      }) };
      const next = query.cursor === cursor;
      return { status: 200, data: createCompactSessionListQueryResponseFixture({ sessions: [next ? grandchild : child],
        nextCursor: next ? null : cursor, hasNext: !next, attentionNextCursor: null, attentionHasNext: false }) };
    });
    const executor = createActionExecutor(deps);
    const direct = await runWithServerHttpBaseUrl(home, () => executor.execute('session.status.get',
      { sessionId: { selector: 'workers' }, live: false }, { ...context, defaultSessionId: sessionId }));
    expect(direct, JSON.stringify(direct)).toMatchObject({ ok: true, result: { kind: 'fanout', results: [
      { target: { sessionId: childId }, result: { ok: true, result: { session: { id: childId } } } },
      { target: { sessionId: archivedChildId }, result: { ok: true, result: { session: { id: archivedChildId } } } },
    ] } });
    const recursive = await runWithServerHttpBaseUrl(home, () => executor.execute('session.status.get',
      { sessionId: { selector: 'workers', recursive: true }, live: false }, { ...context, defaultSessionId: sessionId }));
    expect(recursive, JSON.stringify(recursive)).toMatchObject({ ok: true, result: { kind: 'fanout', results: [
      { target: { sessionId: childId } }, { target: { sessionId: grandchildId } }, { target: { sessionId: archivedChildId } },
    ] } });
    expect(patchedSessionIds).toEqual([childId, archivedChildId, grandchildId]);
  });

  it.each(['complete', 'private_facts_unavailable', 'repeated_cursor'] as const)(
    'resolves matching from the complete authorized corpus (%s)', async coverage => {
      const { deps, get, session, records, patchedSessionIds } = setup();
      const ids = ['c666666666666666666666666', 'c777777777777777777777777', 'c888888888888888888888888'] as const;
      const rows = ids.map((id, index) => {
        const row = { ...createSessionNotificationContextFixture(id), ...session, id };
        if (coverage !== 'private_facts_unavailable' || index !== 1) return row;
        const { ownerMetadata: _private, ...recipient } = row;
        const share = { accessLevel: 'view' as const, canApprovePermissions: false };
        return { ...recipient, share, effectiveAccess: { v: 1 as const, level: 'view' as const,
          sources: [{ kind: 'direct' as const, shareId: 'shared-session' }],
          capabilities: projectSessionAccessCapabilitiesV1({ owner: false, grants: [share] }),
        } };
      });
      records.push(...rows);
      const leafReads: string[] = [];
      const currentGet = get.getMockImplementation()!;
      get.mockImplementation(async (url, config) => {
        const row = rows.find(candidate => String(url).endsWith(`/v2/sessions/${candidate.id}`));
        if (!row) return currentGet(url, config);
        leafReads.push(row.id);
        return { status: 200, data: { session: row } };
      });
      const cursor = encodeV2SessionListCursorV2({ sessionId: ids[0], meaningfulActivityAt: 1 });
      const attentionCursor = encodeV2SessionListCursorV2({ sessionId: ids[2], meaningfulActivityAt: 1 });
      vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
        if (String(url).endsWith('/v2/sessions/read-batch')) return { status: 200, data: createSessionReadBatchResponseFixture({ request: body, sessions: rows }) };
        expect(String(url)).toBe(`${home}/v2/sessions/query`);
        expect(body).toMatchObject({ underSessionId: sessionId, includeInactive: true, scope: 'all_accessible' });
        const query = SessionListQueryV1Schema.parse(body);
        const attention = query.attentionCursor === attentionCursor;
        const next = query.cursor === cursor;
        return { status: 200, data: createCompactSessionListQueryResponseFixture({
          sessions: [rows[attention ? 2 : next ? 1 : 0]],
          nextCursor: attention || next && coverage !== 'repeated_cursor' ? null : cursor,
          hasNext: !attention && (!next || coverage === 'repeated_cursor'),
          attentionNextCursor: attention ? null : attentionCursor, attentionHasNext: !attention,
        }) };
      });
      const filter = normalizeSessionListFilterV1({
          homeServerIds: ['srv_target_home'], show: 'sessions', scope: 'all_accessible',
          startedBy: ['you', 'triggers', 'agents'], source: 'persisted', underSessionId: sessionId,
      });
      if (coverage === 'private_facts_unavailable') {
        await expect(deps.sessionFollowPreview!({ context: { ...context, defaultSessionId: sessionId },
          input: { receiver: { kind: 'session', sessionId }, filter },
        })).resolves.toMatchObject({ coverage: 'partial', unavailable: [
          { serverId: 'srv_target_home', source: { kind: 'session', sessionId: ids[1] } },
        ] });
      }
      const result = await createActionExecutor(deps).execute('session.status.get', {
        sessionId: { selector: 'matching', filter }, live: false,
      }, { ...context, defaultSessionId: sessionId });
      if (coverage === 'complete') {
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { kind: 'fanout', results: ids.map(id => ({
          target: { serverId: 'srv_target_home', sessionId: id }, result: { ok: true, result: { session: { id } } },
        })) } });
        expect(leafReads).toEqual(ids);
        expect(patchedSessionIds).toEqual(ids);
      } else {
        expect(result, JSON.stringify(result)).toMatchObject({ ok: false, errorCode: 'session_target_unavailable' });
        expect(leafReads).toEqual([]);
        expect(patchedSessionIds).toEqual([]);
      }
    },
  );

  it.each(['plain', 'encrypted'] as const)('carries root selectors through transport and ingress into the real target resolver and native refusal (%s)', async mode => {
    await withConfiguredDaemonTestHome({ prefix: 'happier-root-session-target-' }, async () => {
      const currentnessChannel = await createRequesterCurrentnessSocketHarness();
      try {
        const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(23));
        const secret = mode === 'encrypted' ? new Uint8Array(32).fill(17) : undefined;
        const { deps, session, credentials } = setup(managerId, { privateKey: keys.secretKey, installationId: 'installation', secret });
        const childId = 'c666666666666666666666666';
        const child = { ...createSessionNotificationContextFixture(childId), ...session, id: childId, manager: { sessionId } };
        const currentGet = vi.mocked(axios.get).getMockImplementation()!;
        vi.mocked(axios.get).mockImplementation(async (url, config) => String(url).endsWith(`/v2/sessions/${childId}`)
          ? { status: 200, data: { session: child } } : currentGet(url, config));
        vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
          if (String(url).endsWith('/v2/sessions/read-batch')) return { status: 200, data: createSessionReadBatchResponseFixture({ request: body, sessions: [child] }) };
          expect(String(url)).toBe(`${home}/v2/sessions/query`);
          return { status: 200, data: createCompactSessionListQueryResponseFixture({ sessions: [child],
            nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false }) };
        });
        const receiver = createActionExecutor(deps);
        const resolveTarget = createDaemonExternalActionTargetResolver({ credentials, serverApiUrl: home });
        let wrongMachine = false;
        const tokenId = '123e4567-e89b-42d3-a456-426614174000';
        const bearer = `hap_v1_${tokenId}_${encodeBase64(new Uint8Array(32).fill(8), 'base64url')}`;
        const material = { type: 'dataKey' as const, machineKey: secret
          ? deriveAccountMachineKeyFromRecoverySecret(secret) : new Uint8Array(32).fill(17) };
        const wrappingSecret = new Uint8Array(32).fill(7);
        const pins = { serverIdentityId: 'srv_target_home', accountId: 'account-1', tokenId,
          contentPublicKey: encodeBase64(nacl.box.keyPair.fromSecretKey(material.machineKey).publicKey, 'base64') };
        const encryptionAccess = wrapApiTokenEncryptionAccessV1({ context: pins, wrappingSecret, contentPrivateKey: material.machineKey,
          randomBytes: length => new Uint8Array(length).fill(3) });
        const token = mode === 'plain' ? bearer : formatAccountApiTokenCredentialV1({ bearer,
          serverIdentityId: pins.serverIdentityId, accountId: pins.accountId, contentPublicKey: pins.contentPublicKey,
          wrappingSecret: encodeBase64(wrappingSecret, 'base64url') });
        // Only the Home HTTP relay/authentication boundary is substituted. The
        // credential factory, SDK codec, ingress, resolver, reads and send stay real.
        vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
          if (String(url).endsWith('/v1/machines')) return new Response(JSON.stringify([
            { id: 'machine-selected', kind: 'persistent', active: true, revokedAt: null, replacedByMachineId: null },
          ]), { status: 200 });
          if (String(url).endsWith('/encryption-access')) return new Response(JSON.stringify({
            v: 1, accountId: pins.accountId, tokenId, encryptionAccess,
          }), { status: 200 });
          const actionId = decodeURIComponent(String(url).split('/').at(-1)!);
          const envelope: unknown = JSON.parse(String(init?.body));
          const parsedEnvelope = ExternalActionRequestEnvelopeSchema.parse(envelope);
          const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-admitted-proof', binding: {
            accountId: pins.accountId, principalId: 'principal-1', credentialId: tokenId, grant: API_TOKEN_FULL_GRANT_V1,
            accountEncryptionMode: secret ? 'e2ee' : 'plain',
            serverIdentityId: pins.serverIdentityId, custodianAccountId: pins.accountId, machineId: 'machine-selected',
            installationId: 'installation', actionId, requestId: parsedEnvelope.requestId ?? 'home-read-request', target: parsedEnvelope.target,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(parsedEnvelope),
          } });
          const admitted = await admitRequesterAccountActionContext({ authorization, credentials,
            serverId: 'srv_target_home', serverIdentityId: pins.serverIdentityId, serverHttpBaseUrl: home, isCurrent: async () => true });
          if (!admitted) throw new Error('Expected authenticated Home requester custody');
          try {
          const result = await executeExternalAction({ actionId, envelope,
            currentMachineId: wrongMachine ? 'misbound-machine' : 'machine-selected', currentServerId: 'srv_target_home',
            currentInstallationId: 'installation', externalActionMachineRequestPrivateKey: keys.secretKey,
            executionAuthorization: admitted.authorization, verifyExecutionAuthorization: async () => true,
            principal: { accountId: pins.accountId, principalId: 'principal-1', credentialId: tokenId,
              grant: API_TOKEN_FULL_GRANT_V1, authority: 'account_automation' },
            resolveEncryption: async () => ({ serverIdentityId: pins.serverIdentityId, material }),
            resolveTarget,
            executor: receiver,
          });
          if (wrongMachine && result.kind === 'invalid_request') {
            return new Response(JSON.stringify({ error: result.errorCode }), { status: 400 });
          }
          expect(result.kind).toBe('response');
          if (result.kind !== 'response') throw new Error('Expected an admitted Action response');
          return new Response(JSON.stringify(result.response), { status: 200 });
          } finally { await admitted.dispose(); }
        }));
        const root = createCliActionExecutorFromCredentials({ credentials: {
          token,
          encryption: null, credentialProvenance: 'api_token',
        }, serverId: 'srv_target_home', serverApiUrl: home, machineId: 'machine-selected' });
        const exactRoot = createCliActionExecutorFromCredentials({ credentials: {
          token, encryption: null, credentialProvenance: 'api_token',
        }, serverId: 'srv_target_home', serverApiUrl: home });
        for (const recipient of [
          { kind: 'agent_team_member' as const, teamId: 'native-team', memberId: 'native-member' },
          { kind: 'agent_team_broadcast' as const, teamId: 'native-team' },
        ]) {
          const refusal = await exactRoot.execute('session.message.send', {
            sessionId: childId, message: 'Must not reach primary', recipient, wait: false,
          }, { surface: 'cli' });
          expect(refusal, JSON.stringify(refusal)).toMatchObject({ ok: true, result: {
            status: 'rejected', code: 'session_input_target_update_required',
          } });
        }
        const filter = normalizeSessionListFilterV1({ homeServerIds: ['srv_target_home'], show: 'sessions',
          scope: 'all_accessible', startedBy: ['you', 'triggers', 'agents'], source: 'persisted', underSessionId: sessionId });
        for (const of of [undefined, sessionId]) {
          const target = { selector: 'matching' as const, filter, ...(of ? { of } : {}) };
          const status = await root.execute('session.status.get', { sessionId: target, live: false }, { surface: 'cli' });
          expect(status, JSON.stringify(status)).toMatchObject({ ok: true, result: { kind: 'fanout', results: [
            { target: { sessionId: childId }, result: { ok: true, result: { session: { id: childId } } } },
          ] } });
          expect(getActionSpec('session.status.get').outputSchema!.safeParse(status.ok ? status.result : null).success).toBe(true);
          const send = await root.execute('session.message.send', { sessionId: target, message: 'Must not reach primary',
            recipient: { kind: 'agent_team_broadcast', teamId: 'native-team' }, wait: false }, { surface: 'cli' });
          expect(send, JSON.stringify(send)).toMatchObject({ ok: true, result: { kind: 'fanout', results: [
            { target: { sessionId: childId }, result: { ok: true, result: {
              status: 'rejected', code: 'session_input_target_update_required',
            } } },
          ] } });
        }
        const self = await root.execute('session.status.get', { sessionId: 'self', live: false },
          { surface: 'cli', defaultSessionId: childId });
        expect(self, JSON.stringify(self)).toMatchObject({ ok: true, result: { session: { id: childId } } });
        wrongMachine = true;
        await expect(root.execute('session.status.get', { sessionId: { selector: 'matching', filter }, live: false }, { surface: 'cli' }))
          .rejects.toThrow();
      } finally { await currentnessChannel.close(); }
    });
  });
});
