import { afterEach, expect, it, vi } from 'vitest';
import axios from 'axios';
import { io } from 'socket.io-client';
import tweetnacl from 'tweetnacl';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { projectSessionAccessCapabilitiesV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { createSessionLifecycleRpcActionExecutor, registerSessionLifecycleRpcHandlers, type SessionLifecycleActionHandlers } from '@/rpc/handlers/sessionLifecycle';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { createCurrentSessionProjectionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { resetServerFeaturesClientForTests } from '@/features/serverFeaturesClient';
import { projectRequesterAccountActionAuthorization } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { computeWorkspaceSyncPolicyDigest } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';

vi.mock('socket.io-client', () => ({ io: vi.fn() }));

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); resetServerFeaturesClientForTests(); });

it.each(['destination', 'source'] as const)('reads Handoff %s with the admitted requester at Home', async phase => {
  const home = 'srv_handoff_home';
  const serverHttpBaseUrl = 'https://handoff.example.test';
  const sessionId = 'cmwagqalz008omccdtt4qggcq';
  const machineId = 'source';
  const targetMachineId = 'destination';
  const installationId = 'source-installation';
  const target = { kind: 'machine' as const, machineId };
  const credentials = { token: 'requester-fixture', encryption: null };
  const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'handoff-admission', binding: {
    actionId: 'session.handoff', accountId: 'requester', custodianAccountId: 'custodian',
    authentication: { kind: 'account', tokenEpoch: 0 }, accountEncryptionMode: 'plain',
    serverIdentityId: home, machineId, installationId, target, requestId: 'handoff-request',
    requestEnvelopeDigest: 'a'.repeat(43), handoffAdmission: { sessionId, sourceMachineId: machineId,
      sourceInstallationId: installationId, targetMachineId, targetInstallationId: 'destination-installation' },
  } });
  const currentness = { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null,
    updatedAt: 1, recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } };
  const observedSignedReads: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ features: {}, capabilities: {
    encryption: { storagePolicy: 'optional', allowAccountOptOut: true, defaultAccountMode: 'plain' } } })));
  vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
    const path = new URL(String(url)).pathname;
    if (config?.headers?.[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]) {
      observedSignedReads.push(path);
      return { status: 401, data: { error: 'invalid_token', authorizationRefusal: 'verification_purpose' } };
    }
    expect(config?.headers?.Authorization).toBe('Bearer requester-fixture');
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: currentness };
    if (path === `/v1/machines/${targetMachineId}`) return { status: 200, data: { machine: {
      id: targetMachineId, storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
    } } };
    if (path === `/v2/sessions/${sessionId}`) return { status: 200, data: { session: createCurrentSessionProjectionRecordFixture({
      id: sessionId, encryptionMode: 'plain', share: null, metadata: 'not-json',
      effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }],
        capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }) },
    }) } };
    throw new Error(`Unexpected Home read ${path}`);
  });
  vi.mocked(io).mockImplementation(() => createApiSessionSocketStub({ emitWithAck: (event, packet) => {
    expect(event).toBe(SOCKET_RPC_EVENTS.CALL);
    expect(packet).toMatchObject({ method: `${targetMachineId}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT}` });
    return { ok: true, result: { type: 'not_required' } };
  } }) as unknown as ReturnType<typeof io>);
  const admitted = await projectRequesterAccountActionAuthorization({ authorization, serverIdentityId: home, bootstrap: {
    attribution: { serverId: home, accountId: 'requester', machineId, installationId },
    credentials, serverHttpBaseUrl, isCurrent: async () => true,
  } });
  if (!admitted) throw new Error('The test requester must have admitted custody');
  const deps = createCliActionDeps({ token: credentials.token, credentials, sessionId, mode: 'plain', ctx: null,
    serverId: home, serverIdentityId: home, serverHttpBaseUrl,
    externalActionMachineInstallationId: installationId,
    externalActionMachineRequestPrivateKey: tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32)).secretKey,
    actionsSettingsProvider: createActionSettingsProvider({ accountSettings: accountSettingsParse({}) }),
  });
  const context = { surface: 'cli' as const, authority: 'present_user' as const,
    externalActionExecutionAuthorization: admitted, externalActionTarget: target };
  if (phase === 'destination') {
    const policy = { v: 1 as const, selection: 'git_worktree' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
    expect(await deps.sessionHandoffTargetReplacementApprovalPreflight!({ sessionId, targetMachineId, targetPath: '/destination',
      workspaceAction: { kind: 'copy_once', contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) } },
      serverId: home, operationId: 'handoff-request',
      effectActionId: 'session.handoff', context })).toEqual({ type: 'not_required' });
  } else {
    expect(await deps.sessionHandoffStart!({ sessionId, targetMachineId, workspaceAction: { kind: 'none' } }, context))
      .toMatchObject({ ok: false, errorCode: 'session_owner_metadata_unavailable' });
  }
  expect(observedSignedReads).toEqual([]);
});

it('retains admitted handoff custody through source enrichment and rejects a changed destination on replay', async () => {
  const input = {
    sessionId: 'cmwagqalz008omccdtt4qggcq',
    sourceMachineId: 'eadc2422-b42b-478d-97b1-af9b530d5f08',
    targetMachineId: '5964761d-2877-45f3-89f0-83aa71805967',
    targetSessionStorageMode: 'persisted' as const,
    workspaceAction: { kind: 'none' as const },
    accountServerId: 'srv_niq7wbpMyJviL4EtO5YlTEd0Us0Ou0nN',
    actionRequestId: 'QA-ACTION-PARITY-1109-r117-handoff-5964',
  };
  const runtime = createHostActionOperationRuntime({ machineId: input.sourceMachineId, resolveAccountId: async () => 'owner' });
  const rpc = new RpcHandlerManager({ scopePrefix: input.sourceMachineId, encryptionMode: 'plain' });
  // HTTP and the native handoff effect are boundaries. Admission, source
  // resolution, CLI enrichment, local RPC and operation reconciliation are real.
  const native = vi.fn<NonNullable<SessionLifecycleActionHandlers['session.handoff']>>(async () => (
    { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' }));
  registerSessionLifecycleRpcHandlers({ rpcHandlerManager: rpc, actionIds: ['session.handoff'],
    actionExecutor: createSessionLifecycleRpcActionExecutor({ 'session.handoff': native }), observeExecution: runtime.observeExecution });
  const session = createCurrentSessionProjectionRecordFixture({ id: input.sessionId, encryptionMode: 'plain', share: null,
    metadata: JSON.stringify({ machineId: input.sourceMachineId, path: '/repo' }),
    effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }],
      capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }) } });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ features: {}, capabilities: {
    encryption: { storagePolicy: 'optional', allowAccountOptOut: true, defaultAccountMode: 'plain' } } })));
  vi.spyOn(axios, 'get').mockImplementation(async url => String(url).includes('/v2/sessions/')
    ? { status: 200, data: { session } }
    : { status: 200, data: { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null,
      updatedAt: 1, recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } } });
  const executor = createActionExecutor(createCliActionDeps({ token: 'token', credentials: { token: 'token', encryption: null },
    sessionId: input.sessionId, mode: 'plain', ctx: null, serverId: input.accountServerId,
    serverHttpBaseUrl: 'https://handoff.example.test',
    actionsSettingsProvider: createActionSettingsProvider({ accountSettings: accountSettingsParse({}) }),
    machineActionDirectTargetTransport: { machineId: input.sourceMachineId,
      invoke: (method, request, options) => rpc.invokeLocal(method, request, options) },
  }));
  const invoke = (value = input) => executor.execute('session.handoff', value, {
    surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' },
    runActionOperation: runtime.runActionOperation,
    defaultSessionId: input.sessionId,
    serverId: input.accountServerId, actionRequestId: '3002f6fd-055e-4d16-9b11-4e2c4c655eb4',
    presentUserConfirmation: { actionId: 'session.handoff' },
  });
  const result = await invoke();
  expect(result).toMatchObject({ ok: false, errorCode: 'target_unavailable' });
  expect(native).toHaveBeenCalledOnce();
  expect(native.mock.calls[0]?.[0]).toMatchObject({ targetMachineId: input.targetMachineId, sessionStorageMode: 'persisted',
    preferredTransportStrategies: ['direct_peer', 'server_routed_stream'] });
  expect(await invoke()).toEqual(result);
  expect(native).toHaveBeenCalledOnce();
  expect(await invoke({ ...input, targetMachineId: 'ffd72b3e-40ca-4644-9bd2-46753a01d8cb' }))
    .toMatchObject({ ok: false, errorCode: 'action_request_input_conflict' });
  expect(native).toHaveBeenCalledOnce();
});
