import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import axios from 'axios';
import { AccountSettingsSchema, ApprovalRequestV2Schema, FeaturesResponseSchema,
  buildApprovalRequestArtifactHeaderV1, createActionExecutor, type ApprovalRequest } from '@happier-dev/protocol';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, decodePlainArtifactStoredContent,
  encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { decideApprovalRequestTransition } from '@happier-dev/protocol/approvals/approvalRequestTransition';
import { createBlockingApprovalCoordinator } from '@happier-dev/protocol/actions/blockingApprovalCoordinator';
import { API_TOKEN_FULL_GRANT_V1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import { TargetActionApprovalRequestV1Schema } from '@happier-dev/protocol/approvals/targetActionApprovalRequestV1';
import { buildTargetActionApprovalArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { configuration } from '@/configuration';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { registerApprovalRpcHandlers } from '@/rpc/handlers/approvals';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { createCliActionExecutorFromCredentials } from '../createCliActionExecutorFromCredentials';

// Replace network transport only. The credentialed deciding factory, Artifact
// codecs/CAS, registered daemon replay and Session Action executor stay real.
const transport = vi.hoisted(() => vi.fn());
vi.mock('@/session/transport/rpc/machineRpc', async importOriginal => ({
  ...await importOriginal<typeof import('@/session/transport/rpc/machineRpc')>(), callExactMachineRpc: transport,
}));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); transport.mockReset(); resetActiveAccountSettingsSnapshotForTests(); });

describe('remote person approval through credentialed CLI and registered daemon replay', () => {
  async function approveGoal(externalActionClient: boolean, scenario: 'goal' | 'missing_client' | 'agent_live' | 'missing_app_live' | 'missing_app_plugin_live' | 'background_plugin_post' | 'background_plugin_resume' | 'target_live' = 'goal', decision: 'approve' | 'reject' = 'approve') {
    const missingClientPort = scenario === 'missing_client';
    const liveResult = scenario === 'agent_live';
    const missingAppWaiter = scenario === 'missing_app_live' || scenario === 'missing_app_plugin_live';
    const backgroundPluginPost = scenario === 'background_plugin_post' || scenario === 'background_plugin_resume';
    const failedFirstResumption = scenario === 'background_plugin_resume';
    return await withConfiguredDaemonTestHome({ prefix: 'happier-remote-decider-', env: {
      HAPPIER_SERVER_URL: 'https://approval.test', HAPPIER_WEBAPP_URL: 'https://approval.test',
      HAPPIER_TOKEN: undefined, HAPPIER_SESSION_REQUESTER_CREDENTIAL_FILE: undefined,
      HAPPIER_ACCOUNT_SETTINGS_MODE: 'auto', HAPPIER_ACTIONS_SETTINGS_V1: undefined,
    } }, async () => {
      const serverId = configuration.activeServerId;
      const token = `fixture.${Buffer.from(JSON.stringify({ sub: 'owner', provenance: {
        v: 1, kind: 'terminal', authority: 'account_automation',
      } })).toString('base64url')}.signature`;
      const credentials = { token, encryption: null, credentialProvenance: 'stored_session' as const };
      const settings = AccountSettingsSchema.parse({});
      setActiveAccountSettingsSnapshot({ source: 'network', scopeKey: resolveAccountSettingsScopeKeyForToken(token)!,
        loadedAtMs: 1, settingsVersion: 1, settingsSecretsReadKeys: [], settings });
      const features = FeaturesResponseSchema.parse({ features: {}, capabilities: { serverIdentity: { serverIdentityId: 'srv_home' } } });
      const currentness = createAccountEncryptionCurrentnessFixture({ mode: 'plain' });
      let stored: ApprovalRequest | null = null;
      let approvalCreates = 0;
      let waiterAdmissions = 0;
      const target = scenario === 'target_live' ? TargetActionApprovalRequestV1Schema.parse({
        v: 1, kind: 'plugin_target_action', status: 'open', createdAtMs: 1, updatedAtMs: 1,
        createdBy: { surface: 'agent' }, requestedSurface: 'agent', qualifiedActionId: 'acme.alpha/actions/run',
        input: {}, sourceCustody: { kind: 'development', registeredRootId: 'fixture-root' },
        approvalInputCustody: 'live_only', policyFingerprint: 'a'.repeat(64), subjectFingerprint: 'b'.repeat(64),
        replayPlacement: { serverId, machineId: 'origin-machine' }, summary: 'Review private operation',
        executionOriginV1: { v: 1, authority: 'account_automation', surface: 'agent',
          caller: { kind: 'session', sessionId: 'manager-1', starterDepth: 0, turnDepth: 0 },
          serverId, serverIdentityId: 'srv_home', accountId: 'owner', machineId: 'origin-machine',
          actionId: 'action.invoke', requestId: 'target-live' },
      }) : null;
      const effects: unknown[] = [];
      const http: string[] = [];
      const coordinator = createBlockingApprovalCoordinator();
      onTestFinished(() => coordinator.dispose());
      const lifetime = new AbortController();
      onTestFinished(() => lifetime.abort());
      let waiterReady!: () => void;
      const waiting = new Promise<void>(resolve => { waiterReady = resolve; });
      const bearer = `hap_v1_dd03e74b-4aae-4a0a-81ee-1c23ddc4525d_${'A'.repeat(43)}`;
      const daemon = createActionExecutor({
        ...(backgroundPluginPost ? { hostActionApprovalLifetime: { actionId: 'discussion.post' as const,
          signal: lifetime.signal, surface: 'plugin' as const, isCurrent: () => !lifetime.signal.aborted } } : {}),
        resolveSessionReference: async ({ sessionId, context }) => ({ kind: 'unique', address: { serverId: context.serverId!, sessionId: sessionId! } }),
        approvalsCreate: async ({ request }) => { approvalCreates++; stored = ApprovalRequestV2Schema.parse(request); return { artifactId: 'approval' }; },
        approvalsGet: async () => stored,
        approvalsUpdate: async ({ request }) => {
          if (!stored) throw new Error('missing approval');
          const transition = decideApprovalRequestTransition(stored, request);
          if (!transition.ok) return transition;
          stored = ApprovalRequestV2Schema.parse(request); return { ok: true };
        },
        isApprovalExecutionOriginCurrent: async ({ origin }) => origin.machineId === 'origin-machine',
        sessionGoalSet: async input => { effects.push(input); return { updated: true }; },
        discussionAction: async ({ actionId, input, context }) => {
          if (actionId !== 'discussion.post') throw new Error(`Unexpected Discussion operation: ${actionId}`);
          effects.push({ input, context });
          return { v: 1, serverId, messageSeq: 1, message: {
            id: 'published', discussionId: 'discussion', localId: 'plugin-post', seq: 1,
            authorAccountId: 'owner', accountActor: null, producerV1: null,
            content: { v: 1, parts: [{ t: 'text', text: 'Background publication' }] },
            mentionedAccountIds: [], createdAt: 1,
            messageRef: { kind: 'discussion', discussion: { serverId, discussionId: 'discussion' }, messageId: 'published' },
          } };
        },
        approvalsWaitForDecision: async args => {
          waiterAdmissions++;
          const pending = coordinator.waitForDecision(args); waiterReady();
          const result = await pending;
          return { ...result, request: ApprovalRequestV2Schema.parse(result.request) };
        },
        approvalsResolveBlockingDecision: args => coordinator.resolveBlockingDecision(args),
        accountApiTokensCreateAction: async input => {
          effects.push(input);
          return { token: bearer, apiToken: { tokenId: 'dd03e74b-4aae-4a0a-81ee-1c23ddc4525d', label: 'Fixture',
            displayPrefix: 'hap_v1_dd03e74b', createdAt: '2026-08-22T12:00:00.000Z', lastUsedAt: null,
            expiresAt: null, hasEncryptionAccess: false, hasUnattendedTeamAccess: false,
            grant: API_TOKEN_FULL_GRANT_V1, parentTokenId: null, activeChildCount: 0, embedConfig: null } };
        },
      });
      const originContext = { surface: 'agent' as const, authority: 'account_automation' as const, serverId, serverIdentityId: 'srv_home', runtimeAccountId: 'owner',
        defaultSessionId: 'manager-1', defaultSessionMachineId: 'origin-machine', actionRequestId: 'goal-request',
        actionCaller: { kind: 'session' as const, sessionId: 'manager-1', starterDepth: 0, turnDepth: 0 } };
      const pluginCaller = { kind: 'plugin' as const, pluginId: 'acme.channels', contributionLocalId: 'ingress',
        occurrenceId: 'channels-occurrence', originSurface: 'background' as const,
        sourceCustody: { kind: 'development' as const, registeredRootId: 'channels-root' },
        materialization: { machineId: 'origin-machine', materializationId: 'channels-materialization', pluginId: 'acme.channels' } };
      const originalInvocation = backgroundPluginPost ? daemon.execute('discussion.post', {
        discussionId: 'discussion', localId: 'plugin-post',
        content: { v: 1, parts: [{ t: 'text', text: 'Background publication' }] },
      }, { surface: 'plugin', authority: 'account_automation', serverId, serverIdentityId: 'srv_home',
        runtimeAccountId: 'owner', actionRequestId: 'background-post', signal: lifetime.signal, actionCaller: pluginCaller })
        : liveResult ? daemon.execute('account.apiTokens.create', {
          tokenId: 'dd03e74b-4aae-4a0a-81ee-1c23ddc4525d', label: 'Fixture' }, originContext) : null;
      if (originalInvocation) onTestFinished(async () => { lifetime.abort(); coordinator.dispose(); await originalInvocation; });
      if (liveResult || backgroundPluginPost) await waiting;
      // A prior app process is gone. Supply its schema-valid stored record at
      // the HTTP boundary; a contextual Machine never owned its private result.
      else if (missingAppWaiter) stored = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
        actionId: 'account.apiTokens.create', actionArgs: { tokenId: 'dd03e74b-4aae-4a0a-81ee-1c23ddc4525d', label: 'Fixture' },
        summary: 'Create API token', createdBy: { surface: 'system' }, approval: { flow: 'blocking', result: 'required' },
        executionOriginV1: { v: 1, authority: 'account_automation',
          surface: scenario === 'missing_app_plugin_live' ? 'plugin' : 'ui',
          caller: scenario === 'missing_app_plugin_live' ? { kind: 'plugin', pluginId: pluginCaller.pluginId,
            contributionLocalId: pluginCaller.contributionLocalId, sourceCustody: pluginCaller.sourceCustody } : { kind: 'host' },
          serverId, serverIdentityId: 'srv_home', accountId: 'owner', machineId: 'origin-machine',
          actionId: 'account.apiTokens.create', requestId: 'app-token' } });
      else if (!target) expect(await daemon.execute('approval.request.create', {
        ...(missingClientPort ? { actionId: 'file.editor.save', actionArgs: {} }
          : { actionId: 'session.goal.set', actionArgs: { sessionId: 'manager-1', objective: 'Ship goal controls', resumeInactiveWithInitialGoal: false } }),
        summary: 'Set manager goal', createdBy: { surface: 'agent' },
      }, originContext)).toMatchObject({ ok: true, result: { artifactId: 'approval' } });
      let artifact = { id: 'approval', ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain',
        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        header: encodePlainArtifactStoredContent(target ? buildTargetActionApprovalArtifactHeaderV1(target)
          : buildApprovalRequestArtifactHeaderV1(ApprovalRequestV2Schema.parse(stored))),
        body: encodePlainArtifactStoredContent({ body: JSON.stringify(target ?? stored) }),
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
      const rpc = new RpcHandlerManager({ scopePrefix: 'origin-machine', encryptionMode: 'plain', logger: () => {} });
      registerApprovalRpcHandlers({ rpcHandlerManager: rpc, actionExecutor: daemon });
      let firstResumptionUnavailable = failedFirstResumption;
      transport.mockImplementation(async (input: { machineId: string; method: string; request: unknown }) => {
        expect(input.machineId).toBe('origin-machine');
        expect(input.method).toBe(liveResult || backgroundPluginPost || target ? RPC_METHODS.APPROVAL_REQUEST_DECIDE : RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED);
        if (firstResumptionUnavailable) {
          firstResumptionUnavailable = false;
          expect(stored).toMatchObject({ status: 'approved', decision: { kind: 'approve', authority: 'present_user' } });
          return { ok: false, errorCode: 'approval_origin_unavailable', error: 'approval_origin_unavailable', effectAttempted: false };
        }
        if (target) return { ok: true, result: { artifactId: 'approval', status: 'approved' } };
        const result = await rpc.handleRequest({ method: `origin-machine:${input.method}`, params: input.request,
          callerAuthority: 'present_user' });
        return result;
      });
      vi.stubGlobal('fetch', async (input: string | URL | Request) => {
        const path = new URL(String(input)).pathname;
        http.push(`GET ${path}`);
        if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(features);
        if (path === '/v1/account/encryption/currentness') return Response.json(currentness);
        throw new Error(`Unexpected fetch: ${path}`);
      });
      vi.spyOn(axios, 'get').mockImplementation(async url => {
        const path = new URL(String(url)).pathname;
        http.push(`GET ${path}`);
        if (path === '/v1/account/profile') return { status: 200, data: { id: 'owner' } };
        if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
        if (path === '/v1/account/encryption/currentness') return { status: 200, data: currentness };
        if (path === '/v1/account/settings' || path === '/v2/account/settings') return { status: 200, data: { version: 1, content: { t: 'plain', v: settings } } };
        if (path === '/v1/artifacts/approval') {
          if (target) return { status: 200, data: artifact };
          const request = ApprovalRequestV2Schema.parse(stored);
          return { status: 200, data: { ...artifact, header: encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(request)),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(request) }) } };
        }
        throw new Error(`Unexpected HTTP read: ${path}`);
      });
      vi.spyOn(axios, 'post').mockImplementation(async (url, input) => {
        http.push(`POST ${new URL(String(url)).pathname}`);
        expect(new URL(String(url)).pathname).toBe('/v1/artifacts/approval');
        expect(input.expectedHeaderVersion).toBe(artifact.headerVersion);
        const body = decodePlainArtifactStoredContent(input.body);
        if (!body || typeof body !== 'object' || !('body' in body) || typeof body.body !== 'string') throw new Error('invalid approval body');
        const next = ApprovalRequestV2Schema.parse(JSON.parse(body.body));
        if (!stored) throw new Error('missing approval');
        expect(decideApprovalRequestTransition(stored, next)).toMatchObject({ ok: true });
        stored = next;
        // The remote Artifact write is pushed back to the original host.
        // Rejection is durable settlement; only approval needs live ingress.
        if (backgroundPluginPost) coordinator.notifyApprovalUpdated({ artifactId: 'approval', request: next });
        artifact = { ...artifact, header: input.header, body: input.body,
          headerVersion: artifact.headerVersion + 1, bodyVersion: artifact.bodyVersion + 1 };
        return { status: 200, data: { success: true, headerVersion: artifact.headerVersion, bodyVersion: artifact.bodyVersion } };
      });
      const executor = createCliActionExecutorFromCredentials({ credentials, readCredentials: async () => credentials,
        serverId, serverIdentityId: 'srv_home', serverApiUrl: 'https://approval.test',
        machineId: 'controller-machine', ...(externalActionClient ? { externalActionClient: true } : {}),
      });
      const decide = () => executor.execute('approval.request.decide', { artifactId: 'approval', decision }, {
        surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' },
      });
      let result = await decide();
      if (failedFirstResumption) {
        expect(result).toMatchObject({ ok: false, errorCode: 'approval_origin_unavailable', effectAttempted: false });
        expect(stored).toMatchObject({ status: 'approved', decision: { kind: 'approve', authority: 'present_user' } });
        expect(ApprovalRequestV2Schema.parse(stored).execution).toBeUndefined();
        expect(effects).toEqual([]);
        expect(coordinator.getLiveWaiterCount('approval')).toBe(1);
        expect(approvalCreates).toBe(1);
        expect(waiterAdmissions).toBe(1);
        expect(transport).toHaveBeenCalledOnce();
        result = await decide();
      }
      if (backgroundPluginPost) {
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
        if (decision === 'reject') {
          expect(result).toMatchObject({ result: { status: 'rejected' } });
          expect(await originalInvocation).toMatchObject({ ok: false, errorCode: 'approval_rejected' });
          expect(stored).toMatchObject({ status: 'rejected', decision: { kind: 'reject', authority: 'present_user' } });
          expect(await decide()).toMatchObject({ ok: true, result: { status: 'rejected' } });
          expect(transport).not.toHaveBeenCalled();
          expect(effects).toEqual([]);
          const http: Record<string, number> = {};
          return { first: { http, rpc: 0, effects: 0 }, replay: { http, rpc: 0, effects: 0 } };
        }
        expect(await originalInvocation).toMatchObject({ ok: true, result: { messageSeq: 1 } });
        expect(await decide()).toMatchObject({ ok: true, result: { status: 'executed' } });
        expect(transport).toHaveBeenCalledTimes(failedFirstResumption ? 2 : 1);
        expect(approvalCreates).toBe(1);
        expect(waiterAdmissions).toBe(1);
        expect(coordinator.getLiveWaiterCount('approval')).toBe(0);
        expect(effects).toEqual([expect.objectContaining({ context: expect.objectContaining({
          signal: lifetime.signal, actionCaller: pluginCaller, authority: 'account_automation',
          presentUserApproval: expect.objectContaining({ artifactId: 'approval', actionId: 'discussion.post',
            requestId: 'background-post', decidingAccountId: 'owner' }),
        }) })]);
        expect(stored).toMatchObject({ status: 'executed', execution: { ok: true } });
        const http: Record<string, number> = {};
        return { first: { http, rpc: 1, effects: 1 }, replay: { http, rpc: 1, effects: 1 } };
      }
      if (target) {
        expect(transport, JSON.stringify(result)).toHaveBeenCalledOnce();
        expect(result).toMatchObject({ ok: true, result: { status: 'approved' } });
        expect(effects).toEqual([]);
        const http: Record<string, number> = {};
        return { first: { http, rpc: 1, effects: 0 }, replay: { http, rpc: 1, effects: 0 } };
      }
      if (liveResult) {
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
        expect(transport).toHaveBeenCalledOnce();
        expect(await originalInvocation).toMatchObject({ ok: true, result: { token: bearer } });
        expect(effects).toHaveLength(1);
        expect(JSON.stringify(stored)).not.toContain(bearer);
        const http: Record<string, number> = {};
        return { first: { http, rpc: 1, effects: 1 }, replay: { http, rpc: 1, effects: 1 } };
      }
      if (missingClientPort || missingAppWaiter) {
        expect(transport).not.toHaveBeenCalled();
        expect(result).toMatchObject({ ok: false, errorCode: 'approval_origin_unavailable' });
        expect(effects).toEqual([]);
        const http: Record<string, number> = {};
        return { first: { http, rpc: 0, effects: 0 }, replay: { http, rpc: 0, effects: 0 } };
      }
      const first = {
        http: Object.fromEntries([...new Set(http)].map(route => [route, http.filter(value => value === route).length])),
        rpc: transport.mock.calls.length, effects: effects.length };
      console.info('FLOWBUDGET_APPROVE', JSON.stringify({ externalActionClient, ...first }));
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
      http.length = 0;
      expect(await decide()).toMatchObject({ ok: true, result: { status: 'executed' } });
      const replay = {
        http: Object.fromEntries([...new Set(http)].map(route => [route, http.filter(value => value === route).length])),
        rpc: transport.mock.calls.length, effects: effects.length };
      console.info('FLOWBUDGET_APPROVE_REPLAY', JSON.stringify({ externalActionClient, ...replay }));
      expect(effects).toEqual([expect.objectContaining({ sessionId: 'manager-1', objective: 'Ship goal controls' })]);
      expect(transport).toHaveBeenCalledOnce();
      return { first, replay };
    });
  }

  it.each([true, false])('FLOWBUDGET executes the original Goal once (externalActionClient=%s)', async externalActionClient => {
    await approveGoal(externalActionClient);
  });

  it('never sends a client approval to the origin daemon when the approving CLI lacks a client port', async () => {
    await approveGoal(false, 'missing_client');
  });

  it('forwards a private-result decision to the original agent invocation on its Machine', async () => {
    await approveGoal(false, 'agent_live');
  });

  it('does not infer a daemon destination from a contextual Machine on a missing app live invocation', async () => {
    await approveGoal(false, 'missing_app_live');
  });

  it('does not infer a daemon destination from a contextual Machine on a missing app plugin invocation', async () => {
    await approveGoal(false, 'missing_app_plugin_live');
  });

  it.each(['approve', 'reject'] as const)('settles a retained background plugin Discussion publication from a real person %s', async decision => {
    await approveGoal(false, 'background_plugin_post', decision);
  });

  it('preserves the original background plugin waiter after consent when its first resumption is unavailable', async () => {
    await approveGoal(false, 'background_plugin_resume');
  });

  it('forwards a live target approval to its captured Machine rather than the local target decision owner', async () => {
    await approveGoal(false, 'target_live');
  });

  // An already-executed decision needs one current resource read in this request;
  // the next request still acquires fresh authority. No cross-request cache.
  it.each([true, false])('FLOWBUDGET reads a settled approval once per repeated decision (externalActionClient=%s)', async externalActionClient => {
    const { replay } = await approveGoal(externalActionClient);
    expect(replay.http['GET /v1/artifacts/approval']).toBe(1);
    expect(replay.http['GET /v1/account/encryption']).toBe(1);
  });
});
