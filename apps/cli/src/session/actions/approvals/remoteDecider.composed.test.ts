import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import axios from 'axios';
import { AccountSettingsSchema, ApprovalRequestV2Schema, FeaturesResponseSchema,
  buildApprovalRequestArtifactHeaderV1, createActionExecutor, type ApprovalRequest } from '@happier-dev/protocol';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, decodePlainArtifactStoredContent,
  encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { decideApprovalRequestTransition } from '@happier-dev/protocol/approvals/approvalRequestTransition';
import { createBlockingApprovalCoordinator } from '@happier-dev/protocol/actions/blockingApprovalCoordinator';
import { TargetActionApprovalRequestV1Schema } from '@happier-dev/protocol/approvals/targetActionApprovalRequestV1';
import { createTargetActionApprovalDecision } from '@happier-dev/protocol/actions/targetActionApprovalDecision';
import { admitTargetActionApprovalTransition } from '@happier-dev/protocol/approvals/targetActionApprovalRequestTransition';
import { createTargetActionCurrentIntentAdapter } from './targetActionCurrentIntent';
import { buildTargetActionApprovalArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { ACTION_API_SERVER_ORIGIN, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1, EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER,
  EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER, ExternalActionExecutionAuthorizationRequestV1Schema,
  ExternalActionExecutionAuthorizationV1Schema, parseExternalActionDaemonDispatchResult,
  projectExternalActionApprovalDecisionAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1, verifyExternalActionMachineRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { decodeBase64, encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { configuration } from '@/configuration';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { registerApprovalRpcHandlers } from '@/rpc/handlers/approvals';
import { registerExternalActionRpcHandler } from '@/rpc/handlers/externalAction';
import { readOrCreateInstallationIdentity } from '@/daemon/identity/store';
import { createDaemonExternalActionTargetResolver } from '@/daemon/externalActions/daemonExternalActionTargetResolver';
import type { VerifyExternalActionExecutionAuthorization } from '@/daemon/externalActions/executeExternalAction';
import { prepareRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { verifyExternalActionExecutionAuthorizationCurrent } from '@/api/externalActionExecutionAuthorization';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { createClientActionReverseDispatcher } from '../clientActionReverseDispatch';
import { SessionMessageContentSchema, UserMessageSchema } from '@/api/types';
import { UiActionDispatchRequestV1Schema } from '@happier-dev/protocol/actions/clientDispatchV1';
import { createCliActionExecutorFromCredentials } from '../createCliActionExecutorFromCredentials';

// Replace network transport only. The credentialed deciding factory, Artifact
// codecs/CAS, registered daemon replay and Session Action executor stay real.
const transport = vi.hoisted(() => vi.fn());
vi.mock('@/session/transport/rpc/machineRpc', async importOriginal => ({
  ...await importOriginal<typeof import('@/session/transport/rpc/machineRpc')>(), callExactMachineRpc: transport,
}));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); transport.mockReset(); resetActiveAccountSettingsSnapshotForTests(); });

const managerSessionId = 'c123456789012345678901234';

describe('remote person approval through credentialed CLI and registered daemon replay', () => {
  async function approveGoal(externalActionClient: boolean, scenario: 'goal' | 'missing_client' | 'missing_app_live' | 'missing_app_plugin_live' | 'background_plugin_post' | 'background_plugin_refusal' | 'target_live' | 'mcp_client' = 'goal', decision: 'approve' | 'reject' = 'approve') {
    const missingClientPort = scenario === 'missing_client';
    const mcpClient = scenario === 'mcp_client';
    const missingAppWaiter = scenario === 'missing_app_live' || scenario === 'missing_app_plugin_live';
    const backgroundPluginPost = scenario === 'background_plugin_post' || scenario === 'background_plugin_refusal';
    const refusedOriginDelivery = scenario === 'background_plugin_refusal';
    return await withConfiguredDaemonTestHome({ prefix: 'happier-remote-decider-', env: {
      HAPPIER_SERVER_URL: 'https://approval.test', HAPPIER_WEBAPP_URL: 'https://approval.test',
      HAPPIER_TOKEN: undefined, HAPPIER_SESSION_REQUESTER_CREDENTIAL_FILE: undefined,
      HAPPIER_ACCOUNT_SETTINGS_MODE: 'auto', HAPPIER_ACTIONS_SETTINGS_V1: undefined,
    } }, async () => {
      const serverId = configuration.activeServerId;
      const requesterAccountId = scenario === 'target_live' && !externalActionClient ? 'guest' : 'owner';
      const token = `fixture.${Buffer.from(JSON.stringify({ sub: requesterAccountId, tokenEpoch: 1, provenance: {
        v: 1, kind: 'account', authority: 'present_user',
      } })).toString('base64url')}.signature`;
      const credentials = { token, encryption: null, credentialProvenance: 'stored_session' as const };
      const installation = await readOrCreateInstallationIdentity();
      const privateKey = decodeBase64(installation.privateKey, 'base64url');
      const publicKey = decodeBase64(installation.publicKey, 'base64url');
      const currentnessChannel = await createRequesterCurrentnessSocketHarness();
      onTestFinished(() => currentnessChannel.close());
      const settings = AccountSettingsSchema.parse({});
      setActiveAccountSettingsSnapshot({ source: 'network', scopeKey: resolveAccountSettingsScopeKeyForToken(token)!,
        loadedAtMs: 1, settingsVersion: 1, settingsSecretsReadKeys: [], settings });
      const features = FeaturesResponseSchema.parse({ features: {}, capabilities: { serverIdentity: { serverIdentityId: 'srv_home' } } });
      const currentness = createAccountEncryptionCurrentnessFixture({ mode: 'plain' });
      let stored: ApprovalRequest | null = null;
      let approvalCreates = 0;
      let waiterAdmissions = 0;
      let signedAdmissions = 0;
      let signedDeliveries = 0;
      const dispatchCount = () => transport.mock.calls.length + signedDeliveries;
      const executionCounts = () => ({ rpc: transport.mock.calls.length, admissions: signedAdmissions,
        deliveries: signedDeliveries, effects: effects.length });
      const issuedAuthorizations = new Map<string, ReturnType<typeof ExternalActionExecutionAuthorizationV1Schema.parse>>();
      const targetLifetime = new AbortController();
      onTestFinished(() => targetLifetime.abort());
      let target: ReturnType<typeof TargetActionApprovalRequestV1Schema.parse> | null = null;
      const updateTarget = async ({ request }: { request: NonNullable<typeof target> }) => {
        if (!target) throw new Error('Missing target approval');
        const transition = admitTargetActionApprovalTransition(target, request);
        if (transition.ok) target = request;
        return transition;
      };
      let targetReady!: () => void;
      const targetWaiting = new Promise<void>(resolve => { targetReady = resolve; });
      const targetAdapter = createTargetActionCurrentIntentAdapter({
        read: async () => target,
        update: updateTarget,
        create: async request => { target = request; return { artifactId: 'approval', request }; },
        subscribeChanges: () => { targetReady(); return { dispose() {} }; },
      });
      const targetInvocation = scenario === 'target_live' ? targetAdapter({
        action: { qualifiedId: 'acme.alpha/actions/run', pluginId: 'acme.alpha', localId: 'run', occurrenceId: 'alpha',
          sourceCustody: { kind: 'development', registeredRootId: 'fixture-root' }, dangerLevel: 'writesRemote',
          scopes: ['global'], surfaces: ['cli'], hostAccess: [], input: {},
          policyFingerprint: 'a'.repeat(64), confirmation: { title: 'Review private operation' } },
        fingerprint: 'b'.repeat(64), surface: 'cli', approvalInputCustody: 'live_only', signal: targetLifetime.signal,
        replayPlacement: { serverId, machineId: 'origin-machine' },
        executionOriginV1: { v: 1, authority: 'account_automation', surface: 'agent',
          caller: { kind: 'session', sessionId: managerSessionId, starterDepth: 0, turnDepth: 0 },
          serverId, serverIdentityId: 'srv_home', accountId: requesterAccountId, machineId: 'origin-machine',
          actionId: 'action.invoke', requestId: 'target-live' },
      }) : null;
      if (targetInvocation) await targetWaiting;
      const effects: unknown[] = [];
      const publications = new Map<string, string>();
      const publicationRequests: string[] = [];
      const managerSession = createSessionRecordFixture({ id: managerSessionId, active: true,
        encryptionMode: 'plain', share: null, metadata: JSON.stringify({ machineId: 'origin-machine' }) });
      const http: string[] = [];
      const coordinator = createBlockingApprovalCoordinator();
      onTestFinished(() => coordinator.dispose());
      const lifetime = new AbortController();
      onTestFinished(() => lifetime.abort());
      let waiterReady!: () => void;
      const waiting = new Promise<void>(resolve => { waiterReady = resolve; });
      const daemon = createActionExecutor({
        ...(scenario === 'target_live' ? { targetActionApprovalReplay: createTargetActionApprovalDecision({
          read: async () => target, update: updateTarget,
        }) } : {}),
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
        ...(mcpClient ? { clientActionExecute: createClientActionReverseDispatcher(() => ({
          hasConnectedClientRpcHandler: () => true,
          callConnectedClientRpc: async (method, raw, options) => {
            // The person approves elsewhere, without viewing the Agent's Session.
            // The App advertises its Account handler, not that Session's room.
            if (method !== RPC_METHODS.UI_ACTION_EXECUTE) return { ok: false, errorCode: 'RPC_CLIENT_NOT_AVAILABLE' };
            effects.push(UiActionDispatchRequestV1Schema.parse(raw));
            options.onIssued();
            return { ok: true, result: { v: 1, execution: { ok: true, result: { ok: true } } } };
          },
        })) } : {}),
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
      });
      const originContext = { surface: 'agent' as const, authority: 'account_automation' as const, serverId, serverIdentityId: 'srv_home', runtimeAccountId: 'owner',
        defaultSessionId: managerSessionId, defaultSessionMachineId: 'origin-machine', actionRequestId: 'goal-request',
        actionCaller: { kind: 'session' as const, sessionId: managerSessionId, starterDepth: 0, turnDepth: 0 } };
      const pluginCaller = { kind: 'plugin' as const, pluginId: 'acme.channels', contributionLocalId: 'ingress',
        occurrenceId: 'channels-occurrence', originSurface: 'background' as const,
        sourceCustody: { kind: 'development' as const, registeredRootId: 'channels-root' },
        materialization: { machineId: 'origin-machine', materializationId: 'channels-materialization', pluginId: 'acme.channels' } };
      const originalInvocation = backgroundPluginPost ? daemon.execute('discussion.post', {
        discussionId: 'discussion', localId: 'plugin-post',
        content: { v: 1, parts: [{ t: 'text', text: 'Background publication' }] },
      }, { surface: 'plugin', authority: 'account_automation', serverId, serverIdentityId: 'srv_home',
        runtimeAccountId: 'owner', actionRequestId: 'background-post', signal: lifetime.signal, actionCaller: pluginCaller })
        : null;
      if (originalInvocation) onTestFinished(async () => { lifetime.abort(); coordinator.dispose(); await originalInvocation; });
      if (backgroundPluginPost) await waiting;
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
      else if (mcpClient) expect(await daemon.execute('session.connected_services_auth.set', {
        sessionId: managerSessionId, agentId: 'codex', machineId: 'origin-machine',
        bindings: { v: 2, bindingsByServiceId: { 'happier.agent.codex/openai-codex': {
          source: 'connected', selection: 'profile', profileId: 'profile' } } },
      }, { ...originContext, surface: 'mcp', actionCaller: { kind: 'host' },
        externalActionTarget: { kind: 'session', sessionId: managerSessionId } }))
        .toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
      else if (!target) expect(await daemon.execute('approval.request.create', {
        ...(missingClientPort ? { actionId: 'file.editor.save', actionArgs: {} }
          : { actionId: 'session.goal.set', actionArgs: { sessionId: managerSessionId, objective: 'Ship goal controls', resumeInactiveWithInitialGoal: false } }),
        summary: 'Set manager goal', createdBy: { surface: 'agent' },
      }, originContext)).toMatchObject({ ok: true, result: { artifactId: 'approval' } });
      if (mcpClient) {
        const request = ApprovalRequestV2Schema.parse(stored);
        expect(request.executionOriginV1).toMatchObject({ machineId: 'origin-machine',
          target: { kind: 'session', sessionId: managerSessionId } });
        expect(request.executionOriginV1.externalActionExecutionAuthorization).toBeUndefined();
      }
      let artifact = { id: 'approval', ownerAccountId: requesterAccountId, access: 'owner', encryptionMode: 'plain',
        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        header: encodePlainArtifactStoredContent(target ? buildTargetActionApprovalArtifactHeaderV1(target)
          : buildApprovalRequestArtifactHeaderV1(ApprovalRequestV2Schema.parse(stored))),
        body: encodePlainArtifactStoredContent({ body: JSON.stringify(target ?? stored) }),
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
      const rpc = new RpcHandlerManager({ scopePrefix: 'origin-machine', encryptionMode: 'plain', logger: () => {} });
      registerApprovalRpcHandlers({ rpcHandlerManager: rpc, actionExecutor: daemon });
      const verifyExecutionAuthorization: VerifyExternalActionExecutionAuthorization = input =>
        verifyExternalActionExecutionAuthorizationCurrent({ ...input, privateKey, installationId: installation.installationId,
          serverHttpBaseUrl: 'https://approval.test' });
      registerExternalActionRpcHandler(rpc, {
        machineId: 'origin-machine', currentServerId: serverId, currentServerHttpBaseUrl: 'https://approval.test',
        resolveAccountId: async () => 'owner', resolveInstallationId: () => installation.installationId,
        externalActionMachineRequestPrivateKey: privateKey,
        verifyExecutionAuthorization,
        resolveTarget: createDaemonExternalActionTargetResolver({ credentials, serverApiUrl: 'https://approval.test' }),
        executor: daemon,
        prepareRequesterAccountContext: input => prepareRequesterAccountActionContext({ ...input,
          purpose: input.purpose ?? { kind: 'external_action' }, machineId: 'origin-machine',
          installationId: installation.installationId, installationPrivateKey: privateKey,
          serverId, serverIdentityId: 'srv_home', serverHttpBaseUrl: 'https://approval.test',
          isCurrent: () => verifyExecutionAuthorization({ authorization: input.authorization,
            effectActionId: input.authorization.binding.actionId, target: input.authorization.binding.target,
            ...(input.signal ? { signal: input.signal } : {}) }),
          isCustodyCurrent: async () => !lifetime.signal.aborted,
          // The same daemon executor retains the original waiter and client port.
          createExecutor: () => daemon,
        }),
      });
      let originRefusalPending = refusedOriginDelivery;
      transport.mockImplementation(async (input: { machineId: string; method: string; request: unknown }) => {
        expect(input.machineId).toBe('origin-machine');
        expect(input.method).toBe(backgroundPluginPost || target ? RPC_METHODS.APPROVAL_REQUEST_DECIDE : RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED);
        if (originRefusalPending) {
          originRefusalPending = false;
          expect(stored).toMatchObject({ status: 'approved', decision: { kind: 'approve', authority: 'present_user' } });
          return { ok: false, errorCode: 'approval_origin_unavailable', error: 'approval_origin_unavailable', effectAttempted: false };
        }
        if (target) return { ok: false, errorCode: 'RPC_FORBIDDEN', error: 'custodian_only' };
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
        if (path === '/v1/machines/origin-machine') return { status: 200, data: { machine: {
          id: 'origin-machine', kind: 'persistent', active: true, installationId: installation.installationId,
          installationPublicKey: encodeBase64(publicKey, 'base64'),
          revokedAt: null, replacedByMachineId: null, storageMode: 'plain',
          access: { custodian: { accountId: 'owner', displayName: 'Owner' }, role: 'manage',
            resourceMode: 'plain', accessState: 'ready' },
        } } };
        if (path === `/v2/sessions/${managerSessionId}`) return { status: 200, data: { session: managerSession } };
        if (path === '/v1/account/profile') return { status: 200, data: { id: requesterAccountId } };
        if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
        if (path === '/v1/account/encryption/currentness') return { status: 200, data: currentness };
        if (path === '/v1/account/settings' || path === '/v2/account/settings') return { status: 200, data: { version: 1, content: { t: 'plain', v: settings } } };
        if (path === '/v1/artifacts/approval') {
          if (target) return { status: 200, data: { ...artifact,
            header: encodePlainArtifactStoredContent(buildTargetActionApprovalArtifactHeaderV1(target)),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(target) }) } };
          const request = ApprovalRequestV2Schema.parse(stored);
          return { status: 200, data: { ...artifact, header: encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(request)),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(request) }) } };
        }
        throw new Error(`Unexpected HTTP read: ${path}`);
      });
      vi.spyOn(axios, 'post').mockImplementation(async (url, input, config) => {
        const path = new URL(String(url)).pathname;
        http.push(`POST ${path}`);
        if (path === `/v2/sessions/${managerSessionId}/pending`) {
          // Plain host result publication uses authenticated Account Pending
          // ingress. reply:none observes no socket; the server retains localId.
          expect(config?.headers?.Authorization).toBe(`Bearer ${token}`);
          expect(input).toMatchObject({ localId: 'approval-result:approval', messageRole: 'user',
            requestedAction: { v: 1, kind: 'enqueue' } });
          const content = SessionMessageContentSchema.parse(input.content);
          if (content.t !== 'plain') throw new Error('Expected plain result publication');
          const authored = UserMessageSchema.parse(content.v);
          const localId = String(input.localId);
          publicationRequests.push(localId);
          const existing = publications.get(localId);
          if (existing !== undefined) expect(authored.content.text).toBe(existing);
          else publications.set(localId, authored.content.text);
          return { status: 200, data: { didWrite: existing === undefined, terminal: false } };
        }
        if (path === '/v1/actions/approval.request.decide/execution-authorization') {
          expect(config?.headers?.Authorization).toBe(`Bearer ${token}`);
          const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(input);
          expect(request.machineId).toBe('origin-machine');
          if (request.envelope.v !== 1 || !request.envelope.target) throw new Error('Expected plain decision envelope');
          const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1,
            token: `approval-admission-${++signedAdmissions}`, binding: {
              serverIdentityId: 'srv_home', accountId: requesterAccountId, custodianAccountId: 'owner',
              authentication: { kind: 'account', tokenEpoch: 1 }, accountEncryptionMode: 'plain',
              machineId: 'origin-machine', installationId: installation.installationId,
              actionId: 'approval.request.decide', requestId: request.envelope.requestId,
              target: request.envelope.target,
              requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
              approvalDecisionAdmission: projectExternalActionApprovalDecisionAdmissionV1(request.envelope.input),
            } });
          issuedAuthorizations.set(authorization.token, authorization);
          return { status: 200, data: authorization };
        }
        if (path === '/v1/actions/approval.request.decide/execution-authorization/verify') {
          const authorization = issuedAuthorizations.get(String(config?.headers?.[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]));
          if (!authorization) throw new Error('Unknown decision admission');
          expect(verifyExternalActionMachineRequestV1({ authorizationToken: authorization.token,
            effectActionId: authorization.binding.actionId, target: authorization.binding.target,
            installationId: installation.installationId, requestId: authorization.binding.requestId,
            method: 'POST', path, body: input, publicKey,
            signature: String(config?.headers?.[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]),
          })).toBe(true);
          return { status: 200, data: { ok: true } };
        }
        if (path === '/v1/actions/approval.request.decide') {
          const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(input);
          const authorization = request.executionAuthorization;
          if (!authorization) throw new Error('Missing decision admission');
          expect(issuedAuthorizations.get(authorization.token)?.binding).toEqual(authorization.binding);
          signedDeliveries++;
          let execution;
          if (originRefusalPending) {
            originRefusalPending = false;
            expect(stored).toMatchObject({ status: 'approved', decision: { kind: 'approve', authority: 'present_user' } });
            execution = { ok: false, errorCode: 'approval_origin_unavailable', error: 'approval_origin_unavailable', effectAttempted: false };
          } else {
            const relayed = parseExternalActionDaemonDispatchResult(await rpc.handleRequest({
              method: `origin-machine:${EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1}`,
              authorization: ACTION_API_SERVER_ORIGIN,
              params: { actionId: 'approval.request.decide', envelope: request.envelope,
                executionAuthorization: authorization,
                principal: { accountId: requesterAccountId, authority: 'present_user', authentication: { kind: 'account', tokenEpoch: 1 } },
                placement: { machineId: 'origin-machine', target: { kind: 'machine', machineId: 'origin-machine' } } },
            }, undefined, 'authenticated_home_socket'));
            if (!relayed || relayed.kind !== 'response') throw new Error(`Invalid daemon response: ${JSON.stringify(relayed)}`);
            return { status: 200, data: relayed.prepared.response };
          }
          return { status: 200, data: { v: 1, actionId: 'approval.request.decide',
            requestId: request.envelope.requestId, execution } };
        }
        expect(path).toBe('/v1/artifacts/approval');
        expect(input.expectedHeaderVersion).toBe(artifact.headerVersion);
        const body = decodePlainArtifactStoredContent(input.body);
        if (!body || typeof body !== 'object' || !('body' in body) || typeof body.body !== 'string') throw new Error('invalid approval body');
        const next = ApprovalRequestV2Schema.parse(JSON.parse(body.body));
        if (!stored) throw new Error('missing approval');
        expect(decideApprovalRequestTransition(stored, next)).toMatchObject({ ok: true });
        stored = next;
        // The remote Artifact write is pushed back to the original host.
        // Rejection is durable settlement; only approval needs live ingress.
        // A refused origin receives its definitive failed receipt, after the
        // decision owner settles it; consent alone never reaches that waiter.
        if (backgroundPluginPost && (!refusedOriginDelivery || next.status === 'failed')) {
          coordinator.notifyApprovalUpdated({ artifactId: 'approval', request: next });
        }
        artifact = { ...artifact, header: input.header, body: input.body,
          headerVersion: artifact.headerVersion + 1, bodyVersion: artifact.bodyVersion + 1 };
        return { status: 200, data: { success: true, headerVersion: artifact.headerVersion, bodyVersion: artifact.bodyVersion } };
      });
      const executor = createCliActionExecutorFromCredentials({ credentials, readCredentials: async () => credentials,
        serverId, serverIdentityId: 'srv_home', serverApiUrl: 'https://approval.test',
        onRequesterSessionCredentialDisclosure: async () => true,
        machineId: 'controller-machine', ...(externalActionClient ? { externalActionClient: true } : {}),
      });
      const decide = () => executor.execute('approval.request.decide', { artifactId: 'approval', decision }, {
        surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' },
      });
      const result = await decide();
      if (refusedOriginDelivery) {
        expect(result).toMatchObject({ ok: true, result: { status: 'failed', execution: {
          ok: false, errorCode: 'approval_origin_unavailable', effectAttempted: false,
        } } });
        expect(stored).toMatchObject({ status: 'failed', decision: { kind: 'approve', authority: 'present_user' },
          execution: { ok: false, errorCode: 'approval_origin_unavailable', effectAttempted: false } });
        expect(await originalInvocation).toMatchObject({ ok: false,
          errorCode: 'approval_origin_unavailable', effectAttempted: false });
        expect(await decide()).toMatchObject({ ok: true, result: { status: 'failed' } });
        expect(effects).toEqual([]);
        expect(coordinator.getLiveWaiterCount('approval')).toBe(0);
        expect(approvalCreates).toBe(1);
        expect(waiterAdmissions).toBe(1);
        expect(signedAdmissions).toBe(1);
        expect(signedDeliveries).toBe(1);
        expect(transport).not.toHaveBeenCalled();
        const counts: Record<string, number> = {};
        return { first: { http: counts, ...executionCounts() }, replay: { http: counts, ...executionCounts() } };
      }
      if (backgroundPluginPost) {
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
        if (decision === 'reject') {
          expect(result).toMatchObject({ result: { status: 'rejected' } });
          expect(await originalInvocation).toMatchObject({ ok: false, errorCode: 'approval_rejected' });
          expect(stored).toMatchObject({ status: 'rejected', decision: { kind: 'reject', authority: 'present_user' } });
          expect(await decide()).toMatchObject({ ok: true, result: { status: 'rejected' } });
          expect(transport).not.toHaveBeenCalled();
          expect(signedDeliveries).toBe(0);
          expect(effects).toEqual([]);
          const http: Record<string, number> = {};
          return { first: { http, ...executionCounts() }, replay: { http, ...executionCounts() } };
        }
        expect(await originalInvocation).toMatchObject({ ok: true, result: { messageSeq: 1 } });
        expect(await decide()).toMatchObject({ ok: true, result: { status: 'executed' } });
        expect(dispatchCount()).toBe(1);
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
        return { first: { http, ...executionCounts() }, replay: { http, ...executionCounts() } };
      }
      if (target) {
        expect(dispatchCount(), JSON.stringify(result)).toBe(1);
        expect(result).toMatchObject({ ok: true, result: { status: 'approved' } });
        const admitted = await targetInvocation;
        expect(admitted).toMatchObject({ status: 'approved' });
        if (admitted?.status !== 'approved' || !admitted.settleExecution) throw new Error('Missing target receipt');
        effects.push('nested effect on origin-machine');
        await admitted.settleExecution({ artifactId: 'approval', execution: { ok: true, effectAttempted: true } });
        expect(await decide()).toMatchObject({ ok: true, result: { status: 'executed' } });
        expect(effects).toHaveLength(1);
        expect(transport).not.toHaveBeenCalled();
        const http: Record<string, number> = {};
        return { first: { http, ...executionCounts() }, replay: { http, ...executionCounts() } };
      }
      if (mcpClient) {
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { status: 'executed' } });
        expect(await decide()).toMatchObject({ ok: true, result: { status: 'executed' } });
        expect(effects).toHaveLength(1);
        expect(effects[0]).toMatchObject({ input: { sessionId: managerSessionId },
          actionId: 'session.connected_services_auth.set' });
        expect(transport).not.toHaveBeenCalled();
        expect(signedAdmissions).toBe(1);
        expect(signedDeliveries).toBe(1);
        expect(approvalCreates).toBe(1);
        const counts: Record<string, number> = {};
        return { first: { http: counts, ...executionCounts() }, replay: { http: counts, ...executionCounts() } };
      }
      if (missingClientPort) {
        expect(result).toMatchObject({ ok: true, result: { status: 'failed', execution: {
          ok: false, errorCode: 'unsupported_action',
        } } });
        expect(stored).toMatchObject({ status: 'failed', execution: {
          ok: false, errorCode: 'unsupported_action',
        } });
        expect(await decide()).toMatchObject({ ok: true, result: { status: 'failed', execution: {
          ok: false, errorCode: 'unsupported_action',
        } } });
        expect(transport).not.toHaveBeenCalled();
        expect(signedAdmissions).toBe(1);
        expect(signedDeliveries).toBe(1);
        expect(effects).toEqual([]);
        expect(publications.size).toBe(1);
        expect(publicationRequests).toEqual(['approval-result:approval', 'approval-result:approval']);
        expect(JSON.parse(publications.get('approval-result:approval')!)).toMatchObject({
          artifactId: 'approval', actionId: 'file.editor.save', status: 'failed',
          execution: { ok: false, errorCode: 'unsupported_action' },
        });
        const http: Record<string, number> = {};
        return { first: { http, ...executionCounts() }, replay: { http, ...executionCounts() } };
      }
      if (missingAppWaiter) {
        expect(transport).not.toHaveBeenCalled();
        expect(signedDeliveries).toBe(0);
        expect(result, JSON.stringify(result)).toMatchObject({ ok: false, errorCode: 'approval_origin_unavailable' });
        expect(effects).toEqual([]);
        const http: Record<string, number> = {};
        return { first: { http, ...executionCounts() }, replay: { http, ...executionCounts() } };
      }
      const first = {
        http: Object.fromEntries([...new Set(http)].map(route => [route, http.filter(value => value === route).length])),
        rpc: transport.mock.calls.length, admissions: signedAdmissions, deliveries: signedDeliveries, effects: effects.length };
      console.info('FLOWBUDGET_APPROVE', JSON.stringify({ externalActionClient, ...first }));
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
      http.length = 0;
      expect(await decide()).toMatchObject({ ok: true, result: { status: 'executed' } });
      const replay = {
        http: Object.fromEntries([...new Set(http)].map(route => [route, http.filter(value => value === route).length])),
        rpc: transport.mock.calls.length, admissions: signedAdmissions, deliveries: signedDeliveries, effects: effects.length };
      console.info('FLOWBUDGET_APPROVE_REPLAY', JSON.stringify({ externalActionClient, ...replay }));
      expect(effects).toEqual([expect.objectContaining({ sessionId: managerSessionId, objective: 'Ship goal controls' })]);
      expect(dispatchCount()).toBe(1);
      expect(publications.size).toBe(1);
      expect(publicationRequests).toEqual(['approval-result:approval', 'approval-result:approval']);
      expect(JSON.parse(publications.get('approval-result:approval')!)).toMatchObject({
        artifactId: 'approval', actionId: 'session.goal.set', status: 'executed', execution: { ok: true },
      });
      return { first, replay };
    });
  }

  it.each([true, false])('FLOWBUDGET executes the original Goal once (externalActionClient=%s)', async externalActionClient => {
    await approveGoal(externalActionClient);
  });

  it('replays a deferred MCP Session-targeted client switch once through the original executor', async () => {
    await approveGoal(false, 'mcp_client');
  });

  it('records a failed client effect when the originating daemon lacks a client port', async () => {
    await approveGoal(false, 'missing_client');
  });

  it('refuses human-only token creation before an Agent approval or secret effect', async () => {
    let approvalCreates = 0;
    let tokenCreates = 0;
    const executor = createActionExecutor({
      approvalsCreate: async () => { approvalCreates++; return { artifactId: 'approval' }; },
      accountApiTokensCreateAction: async () => { tokenCreates++; throw new Error('Unexpected token creation'); },
    });
    // The canonical Action excludes Agent/MCP bearer creation. Retained live
    // approvals remain covered by background plugin and target invocations.
    expect(await executor.execute('account.apiTokens.create', {
      tokenId: 'dd03e74b-4aae-4a0a-81ee-1c23ddc4525d', label: 'Fixture',
    }, { surface: 'agent', authority: 'account_automation', serverId: 'home',
      serverIdentityId: 'srv_home', runtimeAccountId: 'owner',
      defaultSessionId: managerSessionId, defaultSessionMachineId: 'origin-machine',
      actionCaller: { kind: 'session', sessionId: managerSessionId, starterDepth: 0, turnDepth: 0 },
    })).toMatchObject({ ok: false, errorCode: 'action_disabled', details: { reason: 'unsupported_surface' } });
    expect(approvalCreates).toBe(0);
    expect(tokenCreates).toBe(0);
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

  it('settles a definitive pre-effect origin refusal for the retained background plugin invocation', async () => {
    await approveGoal(false, 'background_plugin_refusal');
  });

  it.each([false, true])('forwards a live target approval through signed requester custody (owner=%s)', async owner => {
    await approveGoal(owner, 'target_live');
  });

  // An already-executed decision needs one current resource read in this request;
  // the next request still acquires fresh authority. No cross-request cache.
  it.each([true, false])('FLOWBUDGET reads a settled approval once per repeated decision (externalActionClient=%s)', async externalActionClient => {
    const { replay } = await approveGoal(externalActionClient);
    expect(replay.http['GET /v1/artifacts/approval']).toBe(1);
    expect(replay.http['GET /v1/account/encryption']).toBe(1);
  });
});
