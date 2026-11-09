import axios from 'axios';
import nacl from 'tweetnacl';
import { expect, it, onTestFinished, vi } from 'vitest';
import type { Socket } from 'socket.io';
import { ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationV1Schema, ExternalActionRequestEnvelopeSchema,
  bindExternalActionExecutionAuthorizationHttpPathV1, bindExternalActionExecutionAuthorizationVerifyHttpPathV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { ACTION_OPERATION_RPC_METHODS_V1 } from '@happier-dev/protocol/actions/operations/v1';
import { normalizeActionsSettingsV1, setActionApprovalOverride } from '@happier-dev/protocol/actions/actionSettings';
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
vi.mock('@/daemon/controlServer', () => ({ startDaemonControlServer: async (input: Parameters<typeof startDaemonControlServer>[0]) => {
  boundary.control = input;
  return { port: 43129, stop: async () => {} };
} }));

it('publishes installed Session cancellation through the incumbent operand mapper after source currentness', async () => {
  onTestFinished(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); boundary.control = null; });
  const refusalLog = vi.spyOn(logger, 'warnLocalFile');
  const home = `srv_${'a'.repeat(32)}`;
  const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'requester', tokenEpoch: 0,
    provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } })).toString('base64url')}.signature`, encryption: null };
  // The installed daemon and the retained Session requester are distinct
  // Accounts. The real ingress factory reads its custodian's terminal identity.
  const custodianCredentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'custodian', tokenEpoch: 0,
    provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } })).toString('base64url')}.signature`, encryption: null };
  const h = await createInstalledProjectAgentDaemonFixture(() => boundary.control, undefined, true, undefined, undefined, {
    credentials: custodianCredentials, accountActionCredentials: credentials, requesterCredentials: credentials,
    homeServerIdentityId: home, machineAccess: { custodianAccountId: 'custodian', role: 'use' },
    resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: home, machineId: 'machine' }),
    accountSettings: { actionsSettingsV1: setActionApprovalOverride({ settings: normalizeActionsSettingsV1(),
      actionId: 'action.operations.cancel', surface: 'agent', approvalRequired: false }) },
  });
  const serverId = h.f.bootstrap.attribution.serverId;
  await writeDaemonSettingsFixture(h.f.directory, { activeServerId: serverId, servers: { [serverId]: {
    id: serverId, name: 'Session Home', serverUrl: 'https://session-home.test', webappUrl: 'https://session-home.test',
    createdAt: 0, updatedAt: 0, lastUsedAt: 0, homeConnectionDescriptorAuthority: 'exact', homeConnectionDescriptor: {
      v: 1, homeServerIdentityId: home, canonicalServerUrl: 'https://session-home.test', revision: 1,
      endpoints: [{ kind: 'https', url: 'https://session-home.test' }] },
  } }, machineIdByServerId: { [serverId]: 'machine' }, lastTokenSubByServerId: { [serverId]: 'requester' } });
  reloadConfiguration();
  const address = { serverId, machineId: 'remote-controller', operationId: 'pending-operation' };
  const destination = { installationId: 'remote-installation', key: nacl.sign.keyPair() };
  const homeRead = vi.mocked(axios.get).getMockImplementation();
  const homeWrite = vi.mocked(axios.post).getMockImplementation();
  if (!homeRead || !homeWrite) throw new Error('Missing canonical Home network fixture');
  let minted: ReturnType<typeof ExternalActionExecutionAuthorizationV1Schema.parse> | undefined;
  let mintRequests = 0;
  vi.mocked(axios.get).mockImplementation(async (...args) => {
    if (new URL(String(args[0])).pathname === `/v1/machines/${address.machineId}`) return { status: 200, data: { machine: {
      id: address.machineId, kind: 'persistent', revokedAt: null, replacedByMachineId: null, storageMode: 'plain',
      dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, installationId: destination.installationId,
      installationPublicKey: Buffer.from(destination.key.publicKey).toString('base64'),
      access: { custodian: { accountId: 'remote-custodian', displayName: 'Controller' },
        role: 'use', resourceMode: 'plain', accessState: 'ready' },
    } } };
    return homeRead(...args);
  });
  vi.mocked(axios.post).mockImplementation(async (...args) => {
    const path = new URL(String(args[0])).pathname;
    if (path === bindExternalActionExecutionAuthorizationVerifyHttpPathV1('action.operations.cancel')) return { status: 200, data: { ok: true } };
    if (path !== bindExternalActionExecutionAuthorizationHttpPathV1('action.operations.cancel')) return homeWrite(...args);
    mintRequests += 1;
    // Home owns fresh Session-source Machine admission on every new mint.
    if (!h.f.isHomeCurrent()) return { status: 403, data: { error: 'access_denied' } };
    const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(args[1]);
    if (!request.sessionActionOrigin || !request.sessionActionSource || !request.installationProof) throw new Error('Missing installed Session root proof');
    expect(request.sessionActionOrigin.caller).toMatchObject({ kind: 'session', sessionId: h.sessionId });
    expect(request.sessionActionSource).toEqual({ machineId: 'machine', installationId: h.f.installation.installationId });
    expect(verifyMachineInstallationProof({ publicKey: h.f.installation.publicKey, proof: request.installationProof,
      payload: { version: 1, accountId: 'requester', ...request.sessionActionSource,
        externalActionOrigin: { homeId: home, actionId: 'action.operations.cancel', requestId: request.envelope.requestId!,
          requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope), origin: request.sessionActionOrigin } } })).toBe(true);
    minted = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'session-cancel-root', binding: {
      accountId: 'requester', authentication: { kind: 'terminal', tokenEpoch: 0 }, serverIdentityId: home,
      machineId: address.machineId, custodianAccountId: 'remote-custodian', installationId: destination.installationId,
      actionId: 'action.operations.cancel', requestId: request.envelope.requestId, target: request.envelope.target,
      accountEncryptionMode: 'plain', requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
      sessionActionOrigin: request.sessionActionOrigin, sessionActionSource: request.sessionActionSource,
    } });
    return { status: 200, data: minted };
  });
  const published: SocketRpcRequestPayload[] = [];
  const observeSocket = (socket: Socket) => socket.on(SOCKET_RPC_EVENTS.CALL,
    (packet: SocketRpcRequestPayload, acknowledge: (result: unknown) => void) => {
      published.push(packet);
      acknowledge({ ok: true, result: { kind: 'requested' } });
    });
  for (const socket of h.f.channel.server.sockets.sockets.values()) observeSocket(socket);
  h.f.channel.server.on('connection', observeSocket);
  const invoke = (sessionId = h.sessionId) => h.dispatch({ kind: 'action.execute', surface: 'agent', actionId: 'action.operations.cancel',
    requestId: h.operationBase().requestId, input: address,
    witness: { turnId: 'cancel-turn', inputId: 'cancel-input', userMessageSeq: 1, userMessageSeqs: [1], workDepth: 0,
      agentStartCaller: { kind: 'session', sessionId, starterDepth: 0, turnDepth: 0 }, callerPermissionMode: 'default' } });
  const wrongSession = await invoke('another-session');
  expect(wrongSession).toMatchObject({ ok: true, result: { kind: 'action.execution', outcome: { ok: false } } });
  expect(published).toHaveLength(0);
  const positiveLogStart = refusalLog.mock.calls.length;
  const result = await invoke();
  const safeCode = result.ok && result.result.kind === 'action.execution' && !result.result.outcome.ok ? result.result.outcome.errorCode : 'none';
  // Read only closed producer phase/cause identifiers from the real file logger;
  // never serialize its messages, root, operands or credential-bearing fields.
  const refusalReasons = new Set(['runtime_authority_unavailable', 'caller_witness_invalid', 'session_owner_missing',
    'session_not_owner', 'session_owner_read_failed', 'session_action_origin_invalid', 'external_authorization_refused',
    'external_authorization_missing', 'external_authorization_binding_mismatch', 'external_authorization_preparation_failed',
    'action_executor_refused']);
  const refusalPhases = new Set(['requester_runtime', 'credentialed_factory', 'machine_origin',
    'requester_preparation_root', 'requester_preparation_currentness', 'signed_root_http_request',
    'signed_root_http_response', 'signed_root_http_status', 'target_binding_mismatch']);
  const refusals = refusalLog.mock.calls.slice(positiveLogStart).flatMap(([message, data]) => {
    if ((message !== '[Session Account Action] Refused' && message !== '[external-action-phase]')
      || !data || typeof data !== 'object') return [];
    const row = data as Record<string, unknown>;
    return [{ ...(typeof row.reason === 'string' && refusalReasons.has(row.reason) ? { reason: row.reason } : {}),
      ...(typeof row.phase === 'string' && refusalPhases.has(row.phase) ? { phase: row.phase } : {}),
      ...(typeof row.refusalPhase === 'string' && refusalPhases.has(row.refusalPhase) ? { refusalPhase: row.refusalPhase } : {}) }];
  });
  const diagnostic = { code: safeCode, mintRequests, rootMinted: minted !== undefined, published: published.length, refusals };
  expect(result, `Installed Session cancellation: ${JSON.stringify(diagnostic)}`).toMatchObject({ ok: true,
    result: { kind: 'action.execution', outcome: { ok: true, result: { kind: 'requested' } } } });
  expect(published).toHaveLength(1);
  const packet = published[0];
  if (!packet || !minted) throw new Error('Missing actual Session cancellation publication');
  h.f.retire();
  expect(await invoke()).toMatchObject({ ok: true, result: { kind: 'action.execution', outcome: { ok: false } } });
  expect(published).toHaveLength(1);
  expect(packet.method).toBe(`${address.machineId}:${ACTION_OPERATION_RPC_METHODS_V1.cancel}`);
  expect(packet.externalActionExecution?.authorization.token === minted.token, 'same source-admitted root').toBe(true);
  const decoded = await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, packet.params, packet.method);
  expect(decoded.params).toEqual({ operationId: address.operationId });
  expect(packet.originalActionEnvelope?.requestId, `Session cancellation carrier: ${JSON.stringify({
    hasEnvelope: packet.originalActionEnvelope !== undefined,
    rawOperationOperand: typeof decoded.params === 'object' && decoded.params !== null && 'operationId' in decoded.params,
  })}`).toBe(minted.binding.requestId);
  expect(computeExternalActionRequestEnvelopeDigestV1(ExternalActionRequestEnvelopeSchema.parse(packet.originalActionEnvelope)))
    .toBe(minted.binding.requestEnvelopeDigest);
}, 120_000);
