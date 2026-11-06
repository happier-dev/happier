import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import axios from 'axios';
import nacl from 'tweetnacl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { API_TOKEN_FULL_GRANT_V1 } from '@happier-dev/protocol';
import { createActionExecutor, type ActionExecutorContext } from '@happier-dev/protocol/actions';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER,
  ExternalActionExecutionAuthorizationV1Schema, ExternalActionExecutionAuthorizationRequestV1Schema,
  projectExternalActionPendingResetStartAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { projectExternalActionHttpError } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1, verifyExternalActionMachineRequestV1, verifyExternalActionMachineRpcRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import * as executionAuthorizationOwner from './externalActionExecutionAuthorization';
import { openExternalActionRequestV2, sealExternalActionRequestV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { deriveAccountMachineKeyFromRecoverySecret, openAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { executeExternalAction } from '@/daemon/externalActions/executeExternalAction';
import { createDaemonExternalActionTargetResolver } from '@/daemon/externalActions/daemonExternalActionTargetResolver';
import { prepareExternalActionRequesterAccountAuthorization, verifyExternalActionExecutionAuthorizationCurrent } from './externalActionExecutionAuthorization';
import { MachineInstallationProofV1Schema, verifyMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { SessionActionRpcOriginV1Schema, SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { logger } from '@/ui/logger';

const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(18));
// Only the Home HTTP boundary is mocked; exercise the real local provenance reader.
const encodeTokenPart = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const accountToken = `${encodeTokenPart({ alg: 'none' })}.${encodeTokenPart({
  sub: 'bob', tokenEpoch: 7, provenance: { v: 1, kind: 'account', authority: 'present_user' },
})}.signature`;
const target = { kind: 'machine' as const, machineId: 'alice-machine' };
const envelope = { v: 1 as const, requestId: 'bob-open', target, input: { message: 'Opened' } };
const principal = { accountId: 'bob', principalId: 'bob', credentialId: 'bob-service',
  grant: API_TOKEN_FULL_GRANT_V1, authority: 'account_automation' as const };
const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({
  v: 1, token: 'bob-home-proof', binding: {
    accountId: 'bob', principalId: 'bob', credentialId: 'bob-service', grant: principal.grant,
    serverIdentityId: 'srv_bob_home', machineId: target.machineId, custodianAccountId: 'alice',
    installationId: 'alice-installation', actionId: 'notifications.notify_me', requestId: envelope.requestId,
    target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), accountEncryptionMode: 'plain',
  },
});

describe('requester HTTP authority on the existing external Action carrier', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(['action_not_admitted', 'action_outcome_unknown'] as const)('preserves original Account correlation for %s and refuses a mismatched reply', async code => {
    const machine = { id: target.machineId, kind: 'persistent', active: true, installationId: 'installation',
      revokedAt: null, replacedByMachineId: null, dataEncryptionKey: null, runnerContentKeyBinding: null,
      access: { custodian: { accountId: 'bob', displayName: 'Bob' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } };
    vi.spyOn(axios, 'get').mockImplementation(async url => url.endsWith('/v1/account/encryption')
      ? { status: 200, data: { mode: 'plain', updatedAt: 1 } } : { status: 200, data: [machine] });
    const response = (id: string) => {
      const refusal = projectExternalActionHttpError(code, id);
      return { status: refusal.statusCode, data: refusal.payload };
    };
    vi.spyOn(axios, 'post').mockResolvedValueOnce(response(envelope.requestId)).mockResolvedValueOnce(response('other-request'));
    const request = { actionId: 'notifications.notify_me', input: envelope.input, requestId: envelope.requestId,
      target, credentials: { token: accountToken, encryption: null, credentialProvenance: 'stored_session' as const },
      serverHttpBaseUrl: 'https://home.example', serverIdentityId: 'srv_bob_home' };
    expect(await executionAuthorizationOwner.dispatchOriginalAccountAction(request))
      .toMatchObject({ ok: false, errorCode: code, details: { requestId: envelope.requestId } });
    expect(await executionAuthorizationOwner.dispatchOriginalAccountAction(request))
      .toMatchObject({ ok: false, errorCode: 'invalid_action_output' });
  });

  it('preserves retryable Home mint transport failure during requester preparation', async () => {
    const post = vi.spyOn(axios, 'post').mockRejectedValue(Object.assign(new Error('private connection detail'), { code: 'ECONNRESET' }));
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'bob', tokenEpoch: 7,
      provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
    const outcome = await prepareExternalActionRequesterAccountAuthorization({
      actionId: 'session.archive', input: { sessionId: 'session' }, requestId: 'mint-transport',
      target, machineId: target.machineId, accountId: 'bob', accountEncryptionMode: 'plain', tokenEpochHint: 7,
      token, serverId: 'home', serverIdentityId: 'srv_bob_home', serverHttpBaseUrl: 'https://home.test',
      installationId: 'installation', privateKey: keys.secretKey,
    }).catch((error: unknown) => error);
    expect(post).toHaveBeenCalled();
    expect(outcome).toMatchObject({ code: 'project_requester_home_unavailable', retryable: true });
  });

  it.each([503, 'ECONNRESET'] as const)('preserves unavailable Home evidence (%s) instead of rejecting the signed root', async failure => {
    const post = vi.spyOn(axios, 'post');
    if (typeof failure === 'number') post.mockResolvedValue({ status: failure, data: { error: 'database_connection_unavailable' } });
    else post.mockRejectedValue(Object.assign(new Error('private connection detail'), { code: failure }));
    await expect(verifyExternalActionExecutionAuthorizationCurrent({ authorization, effectActionId: authorization.binding.actionId,
      target, privateKey: keys.secretKey, installationId: authorization.binding.installationId,
      serverHttpBaseUrl: 'https://home.test' })).rejects.toMatchObject({ code: 'project_requester_home_unavailable', retryable: true });
  });

  it.each([401, 403])('keeps a definitive Home refusal (%s) closed', async status => {
    const log = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
    const requestId = '70cc64d3-0386-4914-b7d8-713b7879e99f';
    const nativeAuthorization = ExternalActionExecutionAuthorizationV1Schema.parse({ ...authorization,
      binding: { ...authorization.binding, actionId: 'session.message.send', requestId } });
    vi.spyOn(axios, 'post').mockResolvedValue({ status, data: { error: 'invalid_token' } });
    await expect(verifyExternalActionExecutionAuthorizationCurrent({ authorization: nativeAuthorization, effectActionId: nativeAuthorization.binding.actionId,
      target, privateKey: keys.secretKey, installationId: authorization.binding.installationId,
      serverHttpBaseUrl: 'https://home.test' })).resolves.toBe(false);
    expect(log).toHaveBeenCalledWith('[external-action-phase]', expect.objectContaining({
      phase: 'signed_root_http_status', httpStatus: status, requestId, actionId: 'session.message.send',
    }));
    expect(JSON.stringify(log.mock.calls)).not.toContain(authorization.token);
  });

  it('preserves an authenticated authorization scope refusal instead of reporting an invalid token', async () => {
    vi.spyOn(axios, 'post').mockResolvedValue({ status: 403, data: { error: 'credential_scope_denied' } });
    await expect(executionAuthorizationOwner.mintExternalActionExecutionAuthorization({
      actionId: 'approval.request.decide', machineId: target.machineId, envelope,
      pat: 'terminal-credential', serverHttpBaseUrl: 'https://home.test',
    })).resolves.toEqual({ ok: false, code: 'credential_scope_denied' });
  });

  it('preserves a typed Machine admission refusal instead of reporting unavailable authentication', async () => {
    const refusal = projectExternalActionHttpError('target_unavailable');
    const post = vi.spyOn(axios, 'post').mockResolvedValue({ status: refusal.statusCode, data: refusal.payload });
    await expect(executionAuthorizationOwner.mintExternalActionExecutionAuthorization({
      actionId: 'providers.models.projection', machineId: target.machineId, envelope,
      pat: 'terminal-credential', serverHttpBaseUrl: 'https://home.test',
    })).resolves.toEqual({ ok: false, code: 'target_unavailable' });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403])('correlates a native Home mint refusal (%s) without disclosing its proof or response', async status => {
    const log = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
    const requestId = '45ee9e08-acd9-4df7-a899-426badc7e635';
    vi.spyOn(axios, 'post').mockResolvedValue({ status, data: { error: 'invalid_token', privateDetail: 'private-refusal-body' } });
    expect(await executionAuthorizationOwner.mintExternalActionExecutionAuthorization({
      actionId: 'session.message.send', machineId: target.machineId, envelope: { ...envelope, requestId },
      pat: 'private-original-credential', serverHttpBaseUrl: 'https://home.test',
    })).toEqual({ ok: false, code: 'invalid_token' });
    expect(log).toHaveBeenCalledWith('[external-action-phase]', expect.objectContaining({
      phase: 'authorization_mint_http_status', httpStatus: status, requestId, actionId: 'session.message.send',
    }));
    expect(JSON.stringify(log.mock.calls)).not.toContain('private-original-credential');
    expect(JSON.stringify(log.mock.calls)).not.toContain('private-refusal-body');
  });

  it.each(['plain', 'e2ee'] as const)('prepares signed fresh-reset admission from exactly the %s input', async mode => {
    const reset = { source: { bindingKind: 'account' as const, ref: { service: { pluginId: 'example.usage', localId: 'quota' }, accountId: 'connected' } },
      recordId: 'paug_v1_abcdefgh', meterId: 'weekly', witness: { id: 'accepted', observedAtMs: 100 } };
    const resetTarget = { kind: 'machine' as const, machineId: target.machineId };
    const resetInput = { sessionId: 'session', localId: 'prepared', reset,
      initialInput: { content: mode === 'plain' ? { t: 'plain', v: { private: 'prepared work' } } : { t: 'encrypted', c: 'session-ciphertext' } } };
    const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(19) };
    vi.spyOn(axios, 'post').mockImplementation(async (_url, body) => {
      if (String(_url).endsWith('/verify')) return { status: 200, data: { ok: true } };
      const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
      const admission = projectExternalActionPendingResetStartAdmissionV1(resetInput);
      if (request.envelope.v === 2) {
        expect(request.envelope).toMatchObject({ pendingResetStartAdmission: admission });
        expect(JSON.stringify(request.envelope)).not.toContain('session-ciphertext');
        expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: request.envelope, material, binding: {
          serverIdentityId: 'srv_bob_home', accountId: 'bob', authentication: { kind: 'account', tokenEpoch: 7 },
          actionId: 'session.pending.resetStart.set', requestId: 'reset-request', target: resetTarget,
        } })).toEqual({ input: resetInput });
      } else expect(request.envelope.input).toEqual(resetInput);
      return { status: 200, data: { v: 1, token: 'reset-proof', binding: {
        accountId: 'bob', authentication: { kind: 'account', tokenEpoch: 7 },
        serverIdentityId: 'srv_bob_home', machineId: target.machineId, custodianAccountId: 'bob',
        installationId: 'alice-installation', actionId: 'session.pending.resetStart.set', requestId: 'reset-request', target: resetTarget,
        accountEncryptionMode: mode, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
        pendingResetStartAdmission: admission,
      } } };
    });
    const request = { actionId: 'session.pending.resetStart.set', input: resetInput,
      requestId: 'reset-request', target: resetTarget, machineId: target.machineId, accountId: 'bob', accountEncryptionMode: mode,
      tokenEpochHint: 7, token: accountToken, serverId: 'bob-profile', serverIdentityId: 'srv_bob_home',
      serverHttpBaseUrl: 'https://bob-home.test', installationId: 'alice-installation', privateKey: keys.secretKey,
      ...(mode === 'e2ee' ? { material } : {}) };
    const prepared = await prepareExternalActionRequesterAccountAuthorization(request);
    expect(prepared).toMatchObject({ binding: { pendingResetStartAdmission: projectExternalActionPendingResetStartAdmissionV1(resetInput) } });
    if (!prepared?.requesterHttpProjection) throw new Error('Fresh-reset preparation did not admit requester signing');
    const path = `/v4/connect/qualified/provider-account-usage/history?${new URLSearchParams({ query: JSON.stringify({ recordId: reset.recordId, witness: reset.witness }) })}`;
    const headers = await prepared.requesterHttpProjection.createRequestHeaders({ effectActionId: request.actionId, method: 'GET', path });
    expect(headers?.[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]).toBe('reset-proof');
    const signature = headers?.[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER];
    if (!signature) throw new Error('Fresh-reset preparation did not sign its exact witness read');
    expect(verifyExternalActionMachineRequestV1({ authorizationToken: 'reset-proof', effectActionId: request.actionId,
      target: resetTarget, installationId: request.installationId, requestId: request.requestId, method: 'GET', path,
      signature, publicKey: keys.publicKey })).toBe(true);
    const accepted = prepared;
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      if (String(url).endsWith('/verify')) return { status: 200, data: { ok: true } };
      const issued = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
      return { status: 200, data: { v: 1, token: accepted.token, binding: { ...accepted.binding,
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(issued.envelope),
        pendingResetStartAdmission: projectExternalActionPendingResetStartAdmissionV1({ ...resetInput, reset: { ...reset, meterId: 'substituted' } }) } } };
    });
    expect(await prepareExternalActionRequesterAccountAuthorization(request)).toBeNull();
    expect(await prepareExternalActionRequesterAccountAuthorization({ ...request,
      input: { ...resetInput, reset: { ...reset, witness: { id: 'accepted', observedAtMs: -1 } } } })).toBeNull();
  });

  it('derives read-only handoff preflight without custody and rejects a changed root digest', async () => {
    const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'original-root', binding: {
      accountId: 'bob', authentication: { kind: 'account', tokenEpoch: 7 }, serverIdentityId: 'srv_bob_home',
      machineId: 'source', custodianAccountId: 'alice', installationId: 'source-installation', actionId: 'session.handoff',
      requestId: 'original-request', requestEnvelopeDigest: 'a'.repeat(43), target: { kind: 'machine', machineId: 'source' },
      handoffAdmission: { sessionId: 'same-session', sourceMachineId: 'source', targetMachineId: 'target',
        sourceInstallationId: 'source-installation', targetInstallationId: 'target-installation' },
    } });
    let changeRoot = false;
    vi.spyOn(axios, 'post').mockImplementation(async (url, body, config) => {
      const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
      expect(request.handoffPreflight).toEqual({ authorization: root });
      expect(request.handoffContinuation).toBeUndefined();
      expect(config?.headers).not.toHaveProperty('Authorization');
      expect(verifyExternalActionMachineRequestV1({ authorizationToken: root.token, effectActionId: 'session.handoff',
        target: root.binding.target, installationId: 'source-installation', requestId: root.binding.requestId,
        method: 'POST', path: new URL(String(url)).pathname, body, publicKey: keys.publicKey,
        signature: String(config?.headers?.[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]) })).toBe(true);
      return { status: 200, data: { v: 1, token: 'preflight-child', binding: { ...root.binding,
        machineId: 'target', installationId: 'target-installation', target: request.envelope.target,
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
        handoffPreflight: { rootRequestId: root.binding.requestId,
          rootRequestEnvelopeDigest: changeRoot ? 'b'.repeat(43) : root.binding.requestEnvelopeDigest },
      } } };
    });
    const prepare = Reflect.get(executionAuthorizationOwner, 'prepareExternalActionHandoffPreflightAuthorization');
    expect(typeof prepare).toBe('function');
    if (typeof prepare !== 'function') return;
    const input = { authorization: root, input: { sessionId: 'same-session', sourceMachineId: 'source', targetMachineId: 'target' },
      machineId: 'target', sourceMachineId: 'source', sourceInstallationId: 'source-installation',
      privateKey: keys.secretKey, serverHttpBaseUrl: 'https://bob-home.test' };
    expect(await prepare(input)).toMatchObject({ token: 'preflight-child' });
    changeRoot = true;
    expect(await prepare(input)).toBeNull();
  });

  it('derives a handoff child from the retained exact root after Session quiescence and refuses a changed root binding', async () => {
    const origin = SessionActionRpcOriginV1Schema.parse({ v: 1,
      caller: { kind: 'session', sessionId: 'same-session', starterDepth: 1, turnDepth: 2 },
      sourceTurnId: 'original-turn', callerPermissionMode: 'default', requestId: 'original-request' });
    const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'original-root', binding: {
      accountId: 'bob', authentication: { kind: 'account', tokenEpoch: 7 }, serverIdentityId: 'srv_bob_home',
      machineId: 'source', custodianAccountId: 'alice', installationId: 'source-installation', actionId: 'session.handoff',
      requestId: origin.requestId, requestEnvelopeDigest: 'a'.repeat(43), target: { kind: 'machine', machineId: 'source' },
      sessionActionOrigin: origin, sessionActionSource: { machineId: 'source', installationId: 'source-installation' },
      handoffAdmission: { sessionId: 'same-session', sourceMachineId: 'source', targetMachineId: 'target',
        sourceInstallationId: 'source-installation', targetInstallationId: 'target-installation' },
    } });
    let changeRoot = false;
    const network = vi.spyOn(axios, 'post').mockImplementation(async (url, body, config) => {
      const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
      expect(request.handoffContinuation).toEqual({ authorization: root, handoffId: 'handoff' });
      expect(config?.headers).not.toHaveProperty('Authorization');
      expect(verifyExternalActionMachineRequestV1({ authorizationToken: root.token, effectActionId: 'session.handoff',
        target: root.binding.target, installationId: 'source-installation', requestId: root.binding.requestId,
        method: 'POST', path: new URL(String(url)).pathname, body, publicKey: keys.publicKey,
        signature: String(config?.headers?.[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]) })).toBe(true);
      return { status: 200, data: { v: 1, token: 'handoff-child', binding: { ...root.binding,
        machineId: 'target', installationId: 'target-installation', target: request.envelope.target,
        actionId: 'session.handoff.status.get', requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
        handoffContinuation: { rootRequestId: origin.requestId,
          rootRequestEnvelopeDigest: changeRoot ? 'b'.repeat(43) : root.binding.requestEnvelopeDigest, handoffId: 'handoff' },
      } } };
    });
    const prepare = Reflect.get(executionAuthorizationOwner, 'prepareExternalActionHandoffContinuationAuthorization');
    expect(typeof prepare).toBe('function');
    if (typeof prepare !== 'function') return;
    const input = { authorization: root, handoffId: 'handoff', actionId: 'session.handoff.status.get',
      input: { handoffId: 'handoff' }, machineId: 'target', sourceMachineId: 'source',
      sourceInstallationId: 'source-installation', privateKey: keys.secretKey, serverHttpBaseUrl: 'https://bob-home.test' };
    expect(await prepare(input)).toMatchObject({ token: 'handoff-child', binding: { sessionActionOrigin: origin,
      handoffContinuation: { handoffId: 'handoff', rootRequestId: origin.requestId } } });
    changeRoot = true;
    expect(await prepare(input)).toBeNull();
    expect(network).toHaveBeenCalledTimes(2);
  });

  it('signs the exact destination RPC with the explicitly admitted original source installation rather than impersonating the destination', async () => {
    const destination = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(29));
    const origin = SessionActionRpcOriginV1Schema.parse({ v: 1,
      caller: { kind: 'session', sessionId: 'lead', starterDepth: 1, turnDepth: 2 },
      sourceTurnId: 'turn-2', callerPermissionMode: 'read-only', causalPermissionAuthority: null, requestId: 'move' });
    const args = { actionId: 'projects.open', input: { workspace: { serverId: 'bob-profile',
      workspaceId: 'workspace', machineId: target.machineId, rootPath: '/destination' } }, requestId: 'move',
      sessionActionOrigin: origin, sourceMachineId: 'source-machine', target, machineId: target.machineId,
      accountId: 'bob', accountEncryptionMode: 'plain' as const, tokenEpochHint: 7, token: accountToken,
      serverId: 'bob-profile', serverIdentityId: 'srv_bob_home', serverHttpBaseUrl: 'https://bob-home.test',
      installationId: 'source-installation', privateKey: keys.secretKey };
    const events: string[] = [];
    let current = true;
    let retireDuringMint = false;
    // Currentness may read Home. Keep its real asynchronous boundary so this
    // distinguishes duplicate reads around purely local envelope construction.
    vi.spyOn(axios, 'get').mockImplementation(async () => {
      events.push('currentness');
      await new Promise(resolve => setTimeout(resolve, 20));
      return { status: 200, data: { current } };
    });
    const isCurrent = async () => (await axios.get<{ current: boolean }>('https://bob-home.test/currentness')).data.current;
    vi.spyOn(axios, 'post').mockImplementation(async (_url, body) => {
      events.push('mint');
      if (retireDuringMint) current = false;
      const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
      return { status: 200, data: { v: 1, token: 'original-source-proof', binding: {
        accountId: args.accountId, authentication: { kind: 'account', tokenEpoch: 7 },
        serverIdentityId: args.serverIdentityId, machineId: target.machineId, custodianAccountId: 'alice',
        installationId: 'destination-installation', actionId: args.actionId, requestId: args.requestId, target,
        accountEncryptionMode: 'plain', requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
        sessionActionOrigin: origin, sessionActionSource: { machineId: args.sourceMachineId, installationId: args.installationId },
      } } };
    });
    const admitted = await prepareExternalActionRequesterAccountAuthorization({ ...args, isCurrent });
    expect(admitted).not.toBeNull();
    expect(events).toEqual(['currentness', 'mint', 'currentness']);
    if (!admitted) throw new Error('Original source authorization was not admitted');
    expect(admitted?.requesterHttpProjection).toBeUndefined();
    const createSourceExecution = Reflect.get(executionAuthorizationOwner, 'createExternalActionSourceMachineRpcExecution');
    expect(typeof createSourceExecution).toBe('function');
    if (typeof createSourceExecution !== 'function') return;
    const rpc = { authorization: admitted, effectActionId: args.actionId, target,
      sourceMachineId: args.sourceMachineId, sourceInstallationId: args.installationId,
      method: `${target.machineId}:${RPC_METHODS.PROJECTS_OPEN}`, requestId: 'rpc-move', params: { sealed: 'ciphertext' },
      privateKey: keys.secretKey };
    const execution = createSourceExecution(rpc);
    expect(execution).toMatchObject({ authorization: admitted, installationId: 'destination-installation' });
    if (!execution) throw new Error('Original source execution was not signed');
    const verification = { authorizationToken: admitted!.token, effectActionId: args.actionId, target,
      installationId: 'destination-installation', event: SOCKET_RPC_EVENTS.CALL, method: rpc.method,
      requestId: rpc.requestId, params: rpc.params, signature: execution.machineSignature };
    expect(verifyExternalActionMachineRpcRequestV1({ ...verification, publicKey: keys.publicKey })).toBe(true);
    expect(verifyExternalActionMachineRpcRequestV1({ ...verification, publicKey: destination.publicKey })).toBe(false);
    expect(createSourceExecution({ ...rpc, sourceMachineId: 'different-source' })).toBeNull();
    expect(createSourceExecution({ ...rpc, sourceInstallationId: 'retired-installation' })).toBeNull();
    events.length = 0;
    current = false;
    expect(await prepareExternalActionRequesterAccountAuthorization({ ...args, isCurrent })).toBeNull();
    expect(events).toEqual(['currentness']);
    events.length = 0;
    current = true;
    retireDuringMint = true;
    expect(await prepareExternalActionRequesterAccountAuthorization({ ...args, isCurrent })).toBeNull();
    expect(events).toEqual(['currentness', 'mint', 'currentness']);
    events.length = 0;
    expect(await prepareExternalActionRequesterAccountAuthorization({ ...args, isCurrent, signal: AbortSignal.abort() })).toBeNull();
    expect(events).toEqual([]);
  });

  it.each(['current', 'changed-origin'] as const)('authenticates the admitted Session origin with the incumbent installation proof and refuses %s mint substitution', async (resultKind) => {
    const sessionActionOrigin = SessionActionRpcOriginV1Schema.parse({ v: 1,
      caller: { kind: 'session', sessionId: 'lead', starterDepth: 1, turnDepth: 2 },
      sourceTurnId: 'turn-2', callerPermissionMode: 'yolo', causalPermissionAuthority: null, requestId: 'session-acquire' });
    const args = { actionId: 'machines.managed.acquire', input: { selection: { kind: 'one-off',
      homeId: 'srv_bob_home', controller: { machineId: target.machineId, installationId: 'alice-installation' },
      launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'guest', choices: {} },
      retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } },
      requestId: sessionActionOrigin.requestId, sessionActionOrigin, sourceMachineId: target.machineId, target, machineId: target.machineId,
      accountId: 'bob', accountEncryptionMode: 'plain' as const, tokenEpochHint: 7, token: accountToken,
      serverId: 'bob-profile', serverIdentityId: 'srv_bob_home', serverHttpBaseUrl: 'https://bob-home.test',
      installationId: 'alice-installation', privateKey: keys.secretKey };
    let authenticatedOrigin = false;
    vi.spyOn(axios, 'post').mockImplementation(async (url, body, config) => {
      if (String(url).endsWith('/verify')) return { status: 200, data: { ok: true } };
      expect(config?.headers).toMatchObject({ Authorization: `Bearer ${args.token}` });
      const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
      expect(body).toMatchObject({ sessionActionOrigin, sessionActionSource: { machineId: args.sourceMachineId, installationId: args.installationId } });
      // The intercepted HTTP body is unknown transport data; parse the real
      // proof schema before using it at the installation authentication boundary.
      if (!body || typeof body !== 'object') throw new Error('Missing installation-authenticated HTTP carrier');
      const proof = MachineInstallationProofV1Schema.parse(Reflect.get(body, 'installationProof'));
      const payload = { version: 1 as const, machineId: args.machineId, installationId: args.installationId, accountId: args.accountId,
        externalActionOrigin: { homeId: args.serverIdentityId, actionId: args.actionId, requestId: args.requestId,
          requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope), origin: sessionActionOrigin } };
      authenticatedOrigin = verifyMachineInstallationProof({ payload, proof, publicKey: keys.publicKey });
      expect(authenticatedOrigin).toBe(true);
      expect(verifyMachineInstallationProof({ payload: { ...payload, externalActionOrigin: {
        ...payload.externalActionOrigin, origin: { ...sessionActionOrigin, sourceTurnId: 'other-turn' },
      } }, proof, publicKey: keys.publicKey })).toBe(false);
      return { status: 200, data: { v: 1, token: 'session-origin-proof', binding: {
        accountId: args.accountId, authentication: { kind: 'account', tokenEpoch: args.tokenEpochHint },
        serverIdentityId: args.serverIdentityId, machineId: args.machineId, custodianAccountId: 'alice',
        installationId: args.installationId, actionId: args.actionId, requestId: args.requestId, target,
        accountEncryptionMode: 'plain', requestEnvelopeDigest: payload.externalActionOrigin.requestEnvelopeDigest,
        sessionActionOrigin: resultKind === 'current' ? sessionActionOrigin : { ...sessionActionOrigin, sourceTurnId: 'other-turn' },
        sessionActionSource: { machineId: args.sourceMachineId, installationId: args.installationId },
      } } };
    });
    const prepared = await prepareExternalActionRequesterAccountAuthorization(args);
    if (resultKind === 'changed-origin') expect(prepared).toBeNull();
    else expect(prepared).toMatchObject({ token: 'session-origin-proof', binding: { sessionActionOrigin },
      requesterHttpProjection: { accountId: 'bob' } });
    expect(authenticatedOrigin).toBe(true);
  });

  it('mounts exact Home signing ports at real ingress without custodian bearer or private Account material', async () => {
    const network = vi.spyOn(axios, 'post').mockImplementation(async (url) => {
      expect(url).toBe('https://bob-home.test/v1/actions/notifications.notify_me/execution-authorization/verify');
      return { status: 200, data: { ok: true } };
    });
    let captured: ActionExecutorContext | undefined;
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
      notificationsNotifyMe: async (_input, context) => {
        captured = context;
        const projection = context.externalActionExecutionAuthorization?.requesterHttpProjection;
        const headers = await projection?.createRequestHeaders({ effectActionId: 'notifications.notify_me',
          method: 'POST', path: '/v1/projects/account-rows/list', body: {} });
        expect(headers).not.toHaveProperty('Authorization');
        expect(headers?.[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]).toBe(authorization.token);
        const signature = headers?.[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER];
        const valid = signature && verifyExternalActionMachineRequestV1({
          authorizationToken: authorization.token, effectActionId: 'notifications.notify_me', target,
          installationId: 'alice-installation', requestId: envelope.requestId,
          method: 'POST', path: '/v1/projects/account-rows/list', body: {}, publicKey: keys.publicKey, signature,
        });
        return { attemptedChannels: 1, deliveredChannels: valid ? 1 : 0 };
      },
    });
    const result = await executeExternalAction({ actionId: 'notifications.notify_me', envelope, principal,
      currentMachineId: target.machineId, currentServerId: 'bob-profile', currentServerHttpBaseUrl: 'https://bob-home.test',
      currentInstallationId: 'alice-installation', executionAuthorization: authorization,
      externalActionMachineRequestPrivateKey: keys.secretKey,
      verifyExecutionAuthorization: (input) => verifyExternalActionExecutionAuthorizationCurrent({ ...input,
        installationId: 'alice-installation', privateKey: keys.secretKey, serverHttpBaseUrl: 'https://bob-home.test' }),
      resolveTarget: createDaemonExternalActionTargetResolver({ credentials: { token: 'alice-daemon', encryption: null } }), executor,
    });
    expect(result).toMatchObject({ kind: 'response', response: { execution: {
      ok: true, result: { attemptedChannels: 1, deliveredChannels: 1 },
    } } });
    expect(captured?.externalActionExecutionAuthorization?.requesterHttpProjection).toMatchObject({
      accountId: 'bob', serverId: 'bob-profile', serverIdentityId: 'srv_bob_home',
      serverHttpBaseUrl: 'https://bob-home.test', accountEncryptionMode: 'plain',
    });
    expect(captured?.externalActionExecutionAuthorization?.requesterAccountProjection).toBeUndefined();
    expect(JSON.stringify(captured?.externalActionExecutionAuthorization)).not.toContain('requesterHttpProjection');
    expect(network).toHaveBeenCalled();
  });

  it('withholds headers when Home authorization is retired while the currentness response awaits', async () => {
    let retired = false;
    vi.spyOn(axios, 'post').mockImplementation(async () => ({ status: retired ? 403 : 200,
      data: retired ? {} : { ok: true } }));
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
      notificationsNotifyMe: async (_input, context) => {
        const projection = context.externalActionExecutionAuthorization?.requesterHttpProjection;
        expect(projection).toBeDefined();
        vi.spyOn(axios, 'post').mockImplementation(async () => {
          const status = retired ? 403 : 200;
          retired = true;
          return { status, data: { ok: true } };
        });
        const headers = await projection!.createRequestHeaders({ effectActionId: 'notifications.notify_me',
          method: 'POST', path: '/v1/projects/account-rows/list', body: {} });
        expect(headers).toBeNull();
        expect(headers?.[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]).toBeUndefined();
        return { attemptedChannels: 1, deliveredChannels: 0 };
      },
    });
    await executeExternalAction({ actionId: 'notifications.notify_me', envelope, principal,
      currentMachineId: target.machineId, currentServerId: 'bob-profile', currentServerHttpBaseUrl: 'https://bob-home.test',
      currentInstallationId: 'alice-installation', executionAuthorization: authorization,
      externalActionMachineRequestPrivateKey: keys.secretKey,
      verifyExecutionAuthorization: (input) => verifyExternalActionExecutionAuthorizationCurrent({ ...input,
        installationId: 'alice-installation', privateKey: keys.secretKey, serverHttpBaseUrl: 'https://bob-home.test' }),
      resolveTarget: createDaemonExternalActionTargetResolver({ credentials: { token: 'alice-daemon', encryption: null } }), executor,
    });
    expect(retired).toBe(true);
  });

  it.each(['plain', 'e2ee', 'legacy'] as const)('prepares original %s Account authority through the existing Home minter', async (credentialKind) => {
    const accountEncryptionMode = credentialKind === 'plain' ? 'plain' as const : 'e2ee' as const;
    const recoverySecret = new Uint8Array(32).fill(21);
    const material = { type: 'dataKey' as const, machineKey: credentialKind === 'legacy'
      ? deriveAccountMachineKeyFromRecoverySecret(recoverySecret) : recoverySecret };
    const args = { actionId: 'notifications.notify_me', input: envelope.input, requestId: envelope.requestId,
      target, machineId: target.machineId, accountId: 'bob', accountEncryptionMode, tokenEpochHint: 7,
      token: accountToken, ...(accountEncryptionMode === 'e2ee' ? { material } : {}),
      serverId: 'bob-profile', serverIdentityId: 'srv_bob_home', serverHttpBaseUrl: 'https://bob-home.test',
      installationId: 'alice-installation', privateKey: keys.secretKey };
    vi.spyOn(axios, 'post').mockImplementation(async (url, body, config) => {
      if (String(url).endsWith('/verify')) return { status: 200, data: { ok: true } };
      const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
      expect(config?.headers).toMatchObject({ Authorization: `Bearer ${args.token}` });
      expect(request.envelope.v).toBe(accountEncryptionMode === 'e2ee' ? 2 : 1);
      if (request.envelope.v === 2) {
        if (credentialKind === 'legacy') {
          expect(openAccountScopedBlobCiphertext({ kind: 'external_action_transport',
            material: { type: 'legacy', secret: recoverySecret }, ciphertext: request.envelope.payload.c })?.value)
            .toMatchObject({ input: envelope.input, authentication: { kind: 'account', tokenEpoch: 7 } });
        }
        expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: request.envelope, material,
          binding: { serverIdentityId: args.serverIdentityId, accountId: args.accountId,
            authentication: { kind: 'account', tokenEpoch: args.tokenEpochHint }, actionId: args.actionId,
            requestId: args.requestId, target } })?.input).toEqual(envelope.input);
        expect(JSON.stringify(body)).not.toContain('Opened');
      }
      return { status: 200, data: { v: 1, token: 'bob-original-proof', binding: {
        serverIdentityId: args.serverIdentityId, accountId: args.accountId,
        authentication: { kind: 'account', tokenEpoch: args.tokenEpochHint }, actionId: args.actionId,
        requestId: args.requestId, target, machineId: target.machineId, custodianAccountId: 'alice',
        installationId: args.installationId, accountEncryptionMode,
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
      } } };
    });
    if (accountEncryptionMode === 'e2ee') {
      // Exercise fixture sealing outside the owner's fail-closed catch so a
      // malformed crypto fixture reports its actual canonical schema failure.
      sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: { serverIdentityId: args.serverIdentityId, accountId: args.accountId,
        authentication: { kind: 'account', tokenEpoch: args.tokenEpochHint }, actionId: args.actionId,
        requestId: args.requestId, target }, input: args.input, material,
        randomBytes: (length) => new Uint8Array(length).fill(19) });
    }
    const prepared = await prepareExternalActionRequesterAccountAuthorization(args);
    expect(prepared).toMatchObject({ token: 'bob-original-proof', requesterHttpProjection: {
      accountId: 'bob', serverId: 'bob-profile', accountEncryptionMode,
    } });
  });

  it.each(['profile', 'epoch', 'proof'] as const)('refuses original Account %s mismatch without producing HTTP authority', async (mismatch) => {
    const args = { actionId: 'notifications.notify_me', input: envelope.input, requestId: envelope.requestId,
      target, machineId: target.machineId, accountId: 'bob', accountEncryptionMode: 'e2ee' as const,
      tokenEpochHint: 7, token: accountToken,
      material: { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(21) },
      serverId: 'bob-profile', serverIdentityId: 'srv_bob_home', serverHttpBaseUrl: 'https://bob-home.test',
      installationId: 'alice-installation', privateKey: keys.secretKey };
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      if (String(url).endsWith('/verify')) return { status: 200, data: { ok: true } };
      const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
      return { status: 200, data: { v: 1, token: 'mismatched-proof', binding: {
        serverIdentityId: args.serverIdentityId, accountId: mismatch === 'profile' ? 'mallory' : args.accountId,
        authentication: { kind: 'account', tokenEpoch: mismatch === 'epoch' ? 8 : args.tokenEpochHint },
        actionId: args.actionId, requestId: args.requestId, target, machineId: target.machineId,
        custodianAccountId: 'alice', installationId: args.installationId, accountEncryptionMode: 'e2ee',
        requestEnvelopeDigest: mismatch === 'proof' ? 'a'.repeat(43)
          : computeExternalActionRequestEnvelopeDigestV1(request.envelope),
      } } };
    });
    expect(await prepareExternalActionRequesterAccountAuthorization(args)).toBeNull();
  });

  it('does not downgrade E2EE without material, or retain authority when custody expires during mint', async () => {
    let current = true;
    const args = { actionId: 'notifications.notify_me', input: envelope.input, requestId: envelope.requestId,
      target, machineId: target.machineId, accountId: 'bob', accountEncryptionMode: 'e2ee' as const,
      tokenEpochHint: 7, token: accountToken, serverId: 'bob-profile', serverIdentityId: 'srv_bob_home',
      serverHttpBaseUrl: 'https://bob-home.test', installationId: 'alice-installation', privateKey: keys.secretKey,
      isCurrent: async () => current };
    const network = vi.spyOn(axios, 'post').mockImplementation(async (_url, body) => {
      const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
      current = false;
      return { status: 200, data: { v: 1, token: 'retired-proof', binding: {
        serverIdentityId: args.serverIdentityId, accountId: args.accountId,
        authentication: { kind: 'account', tokenEpoch: args.tokenEpochHint }, actionId: args.actionId,
        requestId: args.requestId, target, machineId: target.machineId, custodianAccountId: 'alice',
        installationId: args.installationId, accountEncryptionMode: args.accountEncryptionMode,
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
      } } };
    });
    expect(await prepareExternalActionRequesterAccountAuthorization(args)).toBeNull();
    expect(network).not.toHaveBeenCalled();
    expect(await prepareExternalActionRequesterAccountAuthorization({ ...args,
      material: { type: 'dataKey', machineKey: new Uint8Array(32).fill(21) } })).toBeNull();
    expect(current).toBe(false);
  });
});
