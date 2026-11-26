import axios from 'axios';
import nacl from 'tweetnacl';
import { expect, it, onTestFinished, vi } from 'vitest';
import type { Socket } from 'socket.io';
import {
  ExternalActionExecutionAuthorizationRequestV1Schema,
  ExternalActionExecutionAuthorizationV1Schema,
  bindExternalActionExecutionAuthorizationHttpPathV1,
  bindExternalActionExecutionAuthorizationVerifyHttpPathV1,
} from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1, verifyExternalActionMachineRpcRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import {
  ACTION_OPERATION_RPC_METHODS_V2,
  ActionOperationSnapshotV1Schema,
} from '@happier-dev/protocol/actions/operations/v1';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { verifyMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { SOCKET_RPC_EVENTS, type SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { socketRpcCodec } from '@happier-dev/sync-client';
import type { startDaemonControlServer } from '@/daemon/controlServer';
import { createInstalledProjectAgentDaemonFixture } from '@/daemon/testkit/installedProjectAgentDaemonFixture';
import { writeDaemonSettingsFixture } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { reloadConfiguration } from '@/configuration';
import { logger } from '@/ui/logger';

const boundary = vi.hoisted(() => ({ control: null as Parameters<typeof startDaemonControlServer>[0] | null }));
// Only the private HTTP listener is substituted. The installed Session source,
// requester runtime, actual factory and remote Machine publisher remain real.
vi.mock('@/daemon/controlServer', () => ({
  startDaemonControlServer: async (input: Parameters<typeof startDaemonControlServer>[0]) => {
    boundary.control = input;
    return { port: 43129, stop: async () => {} };
  },
}));

it('dispatches installed Session action.operations.get across Team Machines via actionOperations.get.v2 RPC and fails closed on unauthorized or retired callers', async () => {
  onTestFinished(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    boundary.control = null;
  });
  const refusalLog = vi.spyOn(logger, 'warnLocalFile');
  const home = `srv_${'b'.repeat(32)}`;
  const credentials = {
    token: `e30.${Buffer.from(JSON.stringify({
      sub: 'requester',
      tokenEpoch: 0,
      provenance: { v: 1, kind: 'terminal', authority: 'account_automation' },
    })).toString('base64url')}.signature`,
    encryption: null,
  };
  // Team leg: installed daemon custodian and Session requester are distinct Accounts.
  const custodianCredentials = {
    token: `e30.${Buffer.from(JSON.stringify({
      sub: 'custodian',
      tokenEpoch: 0,
      provenance: { v: 1, kind: 'terminal', authority: 'account_automation' },
    })).toString('base64url')}.signature`,
    encryption: null,
  };
  const h = await createInstalledProjectAgentDaemonFixture(() => boundary.control, undefined, true, undefined, undefined, {
    credentials: custodianCredentials,
    accountActionCredentials: credentials,
    requesterCredentials: credentials,
    homeServerIdentityId: home,
    machineAccess: { custodianAccountId: 'custodian', role: 'use' },
    resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: home, machineId: 'machine' }),
  });
  const serverId = h.f.bootstrap.attribution.serverId;
  await writeDaemonSettingsFixture(h.f.directory, {
    activeServerId: serverId,
    servers: {
      [serverId]: {
        id: serverId,
        name: 'Session Home',
        serverUrl: 'https://session-home.test',
        webappUrl: 'https://session-home.test',
        createdAt: 0,
        updatedAt: 0,
        lastUsedAt: 0,
        homeConnectionDescriptorAuthority: 'exact',
        homeConnectionDescriptor: {
          v: 1,
          homeServerIdentityId: home,
          canonicalServerUrl: 'https://session-home.test',
          revision: 1,
          endpoints: [{ kind: 'https', url: 'https://session-home.test' }],
        },
      },
    },
    machineIdByServerId: { [serverId]: 'machine' },
    lastTokenSubByServerId: { [serverId]: 'requester' },
  });
  reloadConfiguration();

  const address = { serverId, machineId: 'remote-controller', operationId: 'pending-operation' };
  const destination = { installationId: 'remote-installation', key: nacl.sign.keyPair() };
  const operationSnapshot = ActionOperationSnapshotV1Schema.parse({
    version: 1,
    operationId: address.operationId,
    revision: 2,
    actionId: 'machines.reachability.inspect',
    state: 'succeeded',
    scope: { accountId: 'requester', machineId: address.machineId },
    title: 'Inspect Machine reachability',
    createdAt: 1,
    startedAt: 2,
    settledAt: 3,
    result: { ok: true },
    cancellation: 'unsupported',
  });

  const homeRead = vi.mocked(axios.get).getMockImplementation();
  const homeWrite = vi.mocked(axios.post).getMockImplementation();
  if (!homeRead || !homeWrite) throw new Error('Missing canonical Home network fixture');

  let minted: ReturnType<typeof ExternalActionExecutionAuthorizationV1Schema.parse> | undefined;
  let mintRequests = 0;
  let refuseMintAsUnavailable = false;
  const homeRelayCalls: string[] = [];

  vi.mocked(axios.get).mockImplementation(async (...args) => {
    if (new URL(String(args[0])).pathname === `/v1/machines/${address.machineId}`) {
      return {
        status: 200,
        data: {
          machine: {
            id: address.machineId,
            kind: 'persistent',
            revokedAt: null,
            replacedByMachineId: null,
            storageMode: 'plain',
            dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
            installationId: destination.installationId,
            installationPublicKey: Buffer.from(destination.key.publicKey).toString('base64'),
            access: {
              custodian: { accountId: 'remote-custodian', displayName: 'Controller' },
              role: 'use',
              resourceMode: 'plain',
              accessState: 'ready',
            },
          },
        },
      };
    }
    return homeRead(...args);
  });

  vi.mocked(axios.post).mockImplementation(async (...args) => {
    const path = new URL(String(args[0])).pathname;
    if (path === '/v1/actions/action.operations.get') {
      homeRelayCalls.push(path);
      // Mirrors Home readAdmittedRootRelay rejecting member != custodian on admitted root relay.
      return { status: 403, data: { error: 'credential_scope_denied' } };
    }
    if (path === bindExternalActionExecutionAuthorizationVerifyHttpPathV1('action.operations.get')) {
      return { status: 200, data: { ok: true } };
    }
    if (path !== bindExternalActionExecutionAuthorizationHttpPathV1('action.operations.get')) {
      return homeWrite(...args);
    }
    mintRequests += 1;
    if (refuseMintAsUnavailable) {
      return { status: 409, data: { error: 'invalid_request', code: 'target_unavailable' } };
    }
    if (!h.f.isHomeCurrent()) return { status: 403, data: { error: 'access_denied' } };
    const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(args[1]);
    if (!request.sessionActionOrigin || !request.sessionActionSource || !request.installationProof) {
      throw new Error('Missing installed Session root proof');
    }
    expect(request.sessionActionOrigin.caller).toMatchObject({ kind: 'session', sessionId: h.sessionId });
    expect(request.sessionActionSource).toEqual({ machineId: 'machine', installationId: h.f.installation.installationId });
    expect(verifyMachineInstallationProof({
      publicKey: h.f.installation.publicKey,
      proof: request.installationProof,
      payload: {
        version: 1,
        accountId: 'requester',
        ...request.sessionActionSource,
        externalActionOrigin: {
          homeId: home,
          actionId: 'action.operations.get',
          requestId: request.envelope.requestId!,
          requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
          origin: request.sessionActionOrigin,
        },
      },
    })).toBe(true);
    minted = ExternalActionExecutionAuthorizationV1Schema.parse({
      v: 1,
      token: `session-get-root-${mintRequests}`,
      binding: {
        accountId: 'requester',
        authentication: { kind: 'terminal', tokenEpoch: 0 },
        serverIdentityId: home,
        machineId: address.machineId,
        custodianAccountId: 'remote-custodian',
        installationId: destination.installationId,
        actionId: 'action.operations.get',
        requestId: request.envelope.requestId,
        target: request.envelope.target,
        accountEncryptionMode: 'plain',
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
        sessionActionOrigin: request.sessionActionOrigin,
        sessionActionSource: request.sessionActionSource,
      },
    });
    return { status: 200, data: minted };
  });

  const published: SocketRpcRequestPayload[] = [];
  const observeSocket = (socket: Socket) => socket.on(
    SOCKET_RPC_EVENTS.CALL,
    (packet: SocketRpcRequestPayload, acknowledge: (result: unknown) => void) => {
      published.push(packet);
      acknowledge({ ok: true, result: { kind: 'found', operation: operationSnapshot } });
    },
  );
  for (const socket of h.f.channel.server.sockets.sockets.values()) observeSocket(socket);
  h.f.channel.server.on('connection', observeSocket);

  const invoke = (options?: Readonly<{
    sessionId?: string;
    surface?: 'agent' | 'mcp';
    waitForTerminal?: boolean;
  }>) => h.dispatch({
    kind: 'action.execute',
    surface: options?.surface ?? 'agent',
    actionId: 'action.operations.get',
    requestId: h.operationBase().requestId,
    input: {
      ...address,
      ...(options?.waitForTerminal ? { waitForTerminal: true } : {}),
    },
    witness: {
      turnId: 'get-turn',
      inputId: 'get-input',
      userMessageSeq: 1,
      userMessageSeqs: [1],
      workDepth: 0,
      agentStartCaller: { kind: 'session', sessionId: options?.sessionId ?? h.sessionId, starterDepth: 0, turnDepth: 0 },
      callerPermissionMode: 'default',
    },
  });

  // Negative leg 1: wrong Session caller is refused before minting or publishing any RPC.
  const wrongSession = await invoke({ sessionId: 'another-session' });
  expect(wrongSession).toMatchObject({ ok: true, result: { kind: 'action.execution', outcome: { ok: false } } });
  expect(published).toHaveLength(0);
  expect(homeRelayCalls).toHaveLength(0);

  // Negative leg 2: unauthorized / revoked / unavailable target fails closed at mint with target_unavailable.
  refuseMintAsUnavailable = true;
  const unauthorized = await invoke({ surface: 'mcp' });
  expect(unauthorized).toMatchObject({
    ok: true,
    result: { kind: 'action.execution', outcome: { ok: false, errorCode: 'target_unavailable' } },
  });
  expect(published).toHaveLength(0);
  expect(homeRelayCalls).toHaveLength(0);
  refuseMintAsUnavailable = false;

  // Positive Team leg (agent surface): publishes actionOperations.get.v2 with raw operand, never hits Home relay.
  const positiveLogStart = refusalLog.mock.calls.length;
  const agentResult = await invoke({ surface: 'agent' });
  const safeCode = agentResult.ok && agentResult.result.kind === 'action.execution' && !agentResult.result.outcome.ok
    ? agentResult.result.outcome.errorCode
    : 'none';
  const diagnostic = {
    code: safeCode,
    mintRequests,
    rootMinted: minted !== undefined,
    published: published.length,
    homeRelayCalls: homeRelayCalls.length,
    refusalLogCount: refusalLog.mock.calls.length - positiveLogStart,
  };
  expect(agentResult, `Installed Session action.operations.get (agent): ${JSON.stringify(diagnostic)}`).toMatchObject({
    ok: true,
    result: { kind: 'action.execution', outcome: { ok: true, result: { kind: 'found', operation: operationSnapshot } } },
  });
  expect(homeRelayCalls).toHaveLength(0);
  expect(published).toHaveLength(1);
  const agentPacket = published[0];
  const agentMinted = minted;
  if (!agentPacket || !agentMinted) throw new Error('Missing actual Session action.operations.get publication');
  expect(agentPacket.method).toBe(`${address.machineId}:${ACTION_OPERATION_RPC_METHODS_V2.get}`);
  expect(agentPacket.requestId).toBe(agentMinted.binding.requestId);
  // Server socket admission (registerSocketRpcHandlers.ts) rejects originalActionEnvelope on actionOperations.get.v2.
  expect(agentPacket.originalActionEnvelope).toBeUndefined();
  expect(agentPacket.externalActionExecution).toMatchObject({
    effectActionId: 'action.operations.get',
    installationId: destination.installationId,
    target: { kind: 'machine', machineId: address.machineId },
  });
  expect(agentPacket.externalActionExecution?.authorization.token === agentMinted.token, 'same source-admitted root').toBe(true);
  expect(agentPacket.externalActionExecution?.authorization.requesterAccountContext).toBeDefined();
  expect(verifyExternalActionMachineRpcRequestV1({
    authorizationToken: agentPacket.externalActionExecution!.authorization.token,
    requesterAccountContext: agentPacket.externalActionExecution!.authorization.requesterAccountContext,
    effectActionId: agentPacket.externalActionExecution!.effectActionId,
    target: agentPacket.externalActionExecution!.target,
    installationId: agentPacket.externalActionExecution!.installationId,
    requestId: agentPacket.requestId!,
    method: agentPacket.method,
    params: agentPacket.params,
    publicKey: h.f.installation.publicKey,
    signature: agentPacket.externalActionExecution!.machineSignature,
  })).toBe(true);
  const decodedAgent = await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, agentPacket.params, agentPacket.method);
  expect(decodedAgent.params).toEqual({ operationId: address.operationId });

  // Positive Team leg (mcp surface with waitForTerminal): preserves raw operand and still avoids Home relay.
  const mcpResult = await invoke({ surface: 'mcp', waitForTerminal: true });
  expect(mcpResult).toMatchObject({
    ok: true,
    result: { kind: 'action.execution', outcome: { ok: true, result: { kind: 'found', operation: operationSnapshot } } },
  });
  expect(homeRelayCalls).toHaveLength(0);
  expect(published).toHaveLength(2);
  const mcpPacket = published[1];
  const mcpMinted = minted;
  if (!mcpPacket || !mcpMinted) throw new Error('Missing MCP Session action.operations.get publication');
  expect(mcpPacket.method).toBe(`${address.machineId}:${ACTION_OPERATION_RPC_METHODS_V2.get}`);
  expect(mcpPacket.requestId).toBe(mcpMinted.binding.requestId);
  expect(mcpPacket.originalActionEnvelope).toBeUndefined();
  expect(mcpPacket.externalActionExecution?.authorization.token === mcpMinted.token, 'same source-admitted root').toBe(true);
  const decodedMcp = await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, mcpPacket.params, mcpPacket.method);
  expect(decodedMcp.params).toEqual({ operationId: address.operationId, waitForTerminal: true });

  // Negative leg 3: after source runtime retires, subsequent call fails closed without publishing any RPC.
  h.f.retire();
  expect(await invoke({ surface: 'mcp' })).toMatchObject({
    ok: true,
    result: { kind: 'action.execution', outcome: { ok: false } },
  });
  expect(published).toHaveLength(2);
  expect(homeRelayCalls).toHaveLength(0);
}, 60_000);
