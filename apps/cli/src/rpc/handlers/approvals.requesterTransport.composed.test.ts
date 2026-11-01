import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER,
  buildApprovalRequestArtifactHeaderV1, encodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { PENDING_INPUT_PROTOCOL_VERSION_V4 } from '@happier-dev/protocol/clientCompatibility/primitives';
import { SOCKET_RPC_EVENTS, type SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { ApprovalRequestV2Schema, buildApprovalRequesterConfirmationV1 } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildApprovalExecutionOriginV1, createActionExecutor, type ActionExecutorContext } from '@happier-dev/protocol/actions/actionExecutor';
import { computeExternalActionRequestEnvelopeDigestV1, signExternalActionApprovalInputV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { registerApprovalRpcHandlers } from './approvals';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '../../../../ui/sources/dev/testkit/harness/homeGovernanceHarness';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary,
  restoreServerAccountForTest } from '../../../../ui/sources/dev/testkit/harness/serverAccountConnectionHarness';
import { createRootLayoutFeaturesResponse } from '../../../../ui/sources/dev/testkit/fixtures/featureFixtures';
import { createActionExecutorBoundaryFixture } from '../../../../ui/sources/dev/testkit/fixtures/actionExecutorBoundary';
import { createSessionFixture } from '../../../../ui/sources/dev/testkit/fixtures/sessionFixtures';
import { installLocalStorageMock, installWebLockManagerMock } from '../../../../ui/sources/auth/storage/tokenStorage.web.testHelpers';
import { installVitestRnShim } from '../../../../ui/sources/dev/vitestRnShim';

vi.mock('socket.io-client', async importOriginal => (
  await import('../../../../ui/sources/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));
vi.mock('react-native-unistyles', async () => (
  await import('../../../../ui/sources/dev/testkit/mocks/unistyles')
).createUnistylesMock());
vi.mock('expo-updates', async () => (
  await import('../../../../ui/sources/dev/testkit/mocks/expoUpdates')
).createExpoUpdatesMock());
vi.mock('expo-file-system', async () => (
  await import('../../../../ui/sources/dev/testkit/mocks/expoFileSystem')
).createExpoFileSystemFileMock().module);
vi.mock('react-native-typography', async () => (
  await import('../../../../ui/sources/dev/testkit/mocks/reactNativeTypography')
).createReactNativeTypographyMock());
vi.mock('@shopify/react-native-skia', async () => (
  await import('../../../../ui/sources/dev/testkit/mocks/reactNativeSkia')
).createReactNativeSkiaMock());
vi.mock('../../../../ui/sources/modal', async () => (
  await import('../../../../ui/sources/dev/testkit/mocks/modal')
).createModalModuleMock().module);

installVitestRnShim();
const browserStorage = installLocalStorageMock();
afterAll(() => browserStorage.restore());
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const outgoing: SocketRpcRequestPayload[] = [];
let decisionReceiver: ((input: unknown) => Promise<unknown>) | null = null;
installDisconnectedServerSocketBoundary(socket => {
  configureConnectedServerSocketBoundary(socket);
  vi.spyOn(socket, 'timeout').mockReturnValue(socket);
  vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event: string, payload: SocketRpcRequestPayload) => {
    if (event === SOCKET_RPC_EVENTS.CALL) outgoing.push(payload);
    return { ok: true, result: decisionReceiver && event === SOCKET_RPC_EVENTS.CALL
      ? await decisionReceiver(payload.params) : { ok: true } };
  });
});

// Literal UI imports keep the actual producer visible to the canonical CLI
// test-ui typecheck partition; native setup precedes loading its runtime graph.
const { createDefaultActionExecutor } = await import('../../../../ui/sources/sync/ops/actions/defaultActionExecutor');
const { getStorage } = await import('../../../../ui/sources/sync/domains/state/storage');
type StoreState = ReturnType<ReturnType<typeof getStorage>['getState']>;
let initialState: StoreState;
let executor: ReturnType<typeof createDefaultActionExecutor>;
let homeId: string;
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>>;
let webLocks: ReturnType<typeof installWebLockManagerMock>;
const installation = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(29));

beforeEach(async () => {
  webLocks = installWebLockManagerMock();
  installHomeGovernanceBoundaries(homes);
  const { setRuntimeFetch } = await import('../../../../ui/sources/utils/system/runtimeFetch');
  setRuntimeFetch(homes.request);
  const { loadSyncSingletonForTests } = await import('../../../../ui/sources/dev/testkit/harness/syncSingletonLoader');
  await loadSyncSingletonForTests();
  initialState = getStorage().getState();
  homeId = await homes.addHome({ name: 'Requester Approval Home', serverUrl: 'https://requester-approval.test',
    serverIdentityId: 'srv_approval_home', accountId: 'account-a', currentAccount: true });
  const baseFeatures = createRootLayoutFeaturesResponse();
  const features = createRootLayoutFeaturesResponse({ capabilities: { session: {
    ...baseFeatures.capabilities.session, pendingInput: { protocolVersion: PENDING_INPUT_PROTOCOL_VERSION_V4 },
  } } });
  homes.answer(homeId, '/v1/features', { body: features });
  homes.answer(homeId, '/v1/features/authenticated', { body: features });
  homes.answer(homeId, '/v2/cursor', { body: { cursor: '0' } });
  const token = homes.findByServerUrl('https://requester-approval.test')?.token;
  if (!token) throw new Error('missing_current_account_credential');
  connection = await restoreServerAccountForTest({ serverUrl: 'https://requester-approval.test',
    serverIdentityId: 'srv_approval_home', accountId: 'account-a', request: homes.request, credentials: { token } });
  getStorage().getState().applySettingsForScope({ serverId: connection.serverId, accountId: 'account-a' }, getStorage().getState().settings, 0);
  getStorage().setState({ sessions: { s1: createSessionFixture({ id: 's1', serverId: connection.serverId, active: true }) } });
  executor = createDefaultActionExecutor({ resolveServerIdForSessionId: () => homeId });
  outgoing.length = 0;
  decisionReceiver = null;
});

afterEach(async () => {
  decisionReceiver = null;
  await connection.dispose();
  const { serverScopedRpcSocketPool } = await import('../../../../ui/sources/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
  const { resetScopedMachineTransportCacheForTests } = await import('../../../../ui/sources/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool');
  await serverScopedRpcSocketPool.stopAll();
  resetScopedMachineTransportCacheForTests();
  await homes.reset();
  const { resetRuntimeFetch } = await import('../../../../ui/sources/utils/system/runtimeFetch');
  resetRuntimeFetch();
  getStorage().setState(initialState, true);
  vi.restoreAllMocks();
  webLocks.restore();
});

describe('authenticated requester approval transport from the app to its original Bot', () => {
  it.each([
    { decision: 'approve', surface: 'ui' }, { decision: 'reject', surface: 'ui' }, { decision: 'cancel', surface: 'ui' },
    { decision: 'approve', surface: 'voice' }, { decision: 'reject', surface: 'voice' },
  ] as const)('settles $surface $decision without editing the viewer Artifact or replacing requester custody', async ({ decision, surface }) => {
    const actionId = 'session.message.send';
    const actionArgs = { sessionId: 'destination', message: 'exact preview' };
    const caller = { kind: 'session' as const, sessionId: 's1', starterDepth: 0, turnDepth: 0 };
    const target = { kind: 'session' as const, sessionId: 'destination' };
    const causalPermissionAuthority = { kind: 'admittedSessionInputV1' as const, admittedPermissionCeiling: 'yolo' as const };
    const sourceContext: ActionExecutorContext = {
      surface: 'agent', authority: 'account_automation', serverId: homeId,
      serverIdentityId: 'srv_approval_home', runtimeAccountId: 'bot-owner', actionRequestId: 'bot-request',
      actionCaller: caller, defaultSessionId: 's1', callerPermissionMode: 'yolo', causalPermissionAuthority,
      sessionInputSource: { sourceSessionId: 's1', sourceTurnId: 'turn-1', via: 'action' },
      actionRequestAttributionV1: { requestRef: 'request-from-bob', requester: { serverId: homeId, accountId: 'account-a' },
        persona: { serverId: homeId, sessionId: 'original-manager-on-other-machine' }, origin: null },
      externalActionTarget: target,
      externalActionExecutionAuthorization: { v: 1, token: 'original-bot-source', binding: {
        serverIdentityId: 'srv_approval_home', accountId: 'bot-owner', custodianAccountId: 'bot-owner',
        machineId: 'original-machine', installationId: 'installation-1', actionId, requestId: 'bot-request', target,
        authentication: { kind: 'account', tokenEpoch: 0 },
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1({ v: 1, requestId: 'bot-request', target, input: actionArgs }),
        sessionActionOrigin: { v: 1, caller, sourceTurnId: 'turn-1', callerPermissionMode: 'yolo', causalPermissionAuthority, requestId: 'bot-request' },
        sessionActionSource: { machineId: 'original-machine', installationId: 'installation-1' },
      } },
      signExternalActionApprovalInput: args => signExternalActionApprovalInputV1({ authorizationToken: args.authorization.token,
        actionId: args.actionId, target: args.target, input: args.input, privateKey: installation.secretKey,
        requesterConfirmation: args.requesterConfirmation, sessionTargetsV1: args.sessionTargetsV1 }),
    };
    const requesterConfirmation = buildApprovalRequesterConfirmationV1({ context: sourceContext, actionId, input: actionArgs });
    if (!requesterConfirmation) throw new Error('Expected admitted requester subject');
    const executionOriginV1 = buildApprovalExecutionOriginV1({ actionId, input: actionArgs,
      targetSessionId: 'destination', requesterConfirmation, context: sourceContext });
    if (!executionOriginV1) throw new Error('Expected signed requester preview');
    const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'agent', sessionId: 's1' }, requestedSurface: 'agent', summary: 'Send exact preview',
      actionId, actionArgs, executionOriginV1, requesterConfirmation });
    const response = await homes.artifacts(homeId).handle('/v1/artifacts', { method: 'POST', body: JSON.stringify({
      id: 'requester-preview', header: encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(request)),
      body: encodePlainArtifactStoredContent({ body: JSON.stringify(request) }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
    }) });
    expect(response?.ok).toBe(true);
    const { apiSocket } = await import('../../../../ui/sources/sync/api/session/apiSocket');
    await new Promise<void>(resolve => {
      const unsubscribe = apiSocket.onStatusChange(status => {
        if (status === 'connected') queueMicrotask(() => { unsubscribe(); resolve(); });
      });
    });
    const originalBody = homes.artifacts(homeId).readPlainBody('requester-preview');
    homes.requests.length = 0;
    outgoing.length = 0;
    let remoteStored = request;
    const remote = createActionExecutor(createActionExecutorBoundaryFixture({
      approvalsGet: async () => remoteStored,
      approvalsUpdate: async ({ request: next }) => {
        remoteStored = ApprovalRequestV2Schema.parse(JSON.parse(JSON.stringify(next)));
        return { ok: true };
      },
      isApprovalExecutionOriginCurrent: async () => true,
      sessionSendMessage: async ({ context }) => {
        expect(context?.runtimeAccountId).toBe('bot-owner');
        return { status: 'accepted', localId: 'same-bot-effect' };
      },
    }));
    const ingress = new RpcHandlerManager({ scopePrefix: 'original-machine', encryptionMode: 'plain', logger: () => {},
      resolveSessionDecisionContext: async () => ({ content: { mode: 'plain' }, isCurrent: async () => true }) });
    registerApprovalRpcHandlers({ rpcHandlerManager: ingress, actionExecutor: remote });
    // Only the authenticated relay is replaced; all receiving admission,
    // registration, Action orchestration and persistence readers remain real.
    decisionReceiver = params => ingress.handleRequest({ method: 's1:' + RPC_METHODS.APPROVAL_REQUEST_DECIDE,
      params, callerAuthority: 'present_user', authorization: { kind: 'session.permission.respond', sessionId: 's1',
        authentication: { tokenEpoch: 1 }, actor: { kind: 'accountUser', accountId: 'account-a', relationship: 'sharedApprover' } } });
    const settled = await executor.execute('approval.request.decide', { artifactId: 'requester-preview', decision }, { surface, serverId: homeId });
    expect(settled, JSON.stringify(settled)).toMatchObject({ ok: true,
      result: { status: decision === 'approve' ? 'executed' : decision === 'reject' ? 'rejected' : 'canceled' } });
    expect(outgoing).toEqual([expect.objectContaining({ method: 's1:' + RPC_METHODS.APPROVAL_REQUEST_DECIDE,
      params: { artifactId: 'requester-preview', sessionId: 's1', decision,
        ...(surface === 'voice' ? { decisionSource: 'voice' } : {}) } })]);
    expect(homes.artifacts(homeId).readPlainBody('requester-preview')).toBe(originalBody);
    expect(homes.requestsFor('/v1/artifacts/requester-preview')).toHaveLength(1);
    expect(remoteStored.executionOriginV1).toEqual(executionOriginV1);
    expect(remoteStored.requesterConfirmation).toEqual(requesterConfirmation);
    if (decision !== 'cancel') expect(remoteStored.decision).toMatchObject({ kind: decision, decidingAccountId: 'account-a',
      ...(surface === 'voice' ? { decidedVia: 'voice' } : {}) });
    if (decision === 'cancel') expect(remoteStored.decision).toBeUndefined();
    else if (surface === 'ui') expect(remoteStored.decision).not.toHaveProperty('decidedVia');
  });
});
