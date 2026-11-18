import { describe, expect, it, vi } from 'vitest';
import axios, { AxiosHeaders } from 'axios';
import tweetnacl from 'tweetnacl';
import {
  API_TOKEN_FULL_GRANT_V1, MACHINE_PLAIN_DATA_KEY_MARKER,
  ExternalActionMachineRpcExecutionV1Schema, ExternalActionExecutionAuthorizationV1Schema, SessionInputRequestV1Schema,
  SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1, SessionPendingEnqueueByMachineRequestV1Schema,
  settleSessionInputRequestV1, verifyExternalActionMachineRpcRequestV1,
  verifyExternalActionMachineRequestV1, type SessionInputAuthorityV1,
} from '@happier-dev/protocol';
import {
  createActionExecutor, computeExternalActionRequestEnvelopeDigestV1,
  decodeExternalActionResolvedTargetV1, EXTERNAL_ACTION_EFFECT_ACTION_HEADER,
  EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER,
  EXTERNAL_ACTION_RESOLVED_TARGET_HEADER,
} from '@happier-dev/protocol/actions';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import {
  sealExternalActionRequesterAccountContextV1,
  openExternalActionRequesterAccountContextV1,
  type ExternalActionRequesterInvocationV1,
} from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { ApiMachineClient } from '@/api/apiMachine';
import { verifyExternalActionExecutionAuthorizationCurrent } from '@/api/externalActionExecutionAuthorization';
import { configuration } from '@/configuration';
import { resetServerFeaturesClientForTests } from '@/features/serverFeaturesClient';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { withTempDir } from '@/testkit/fs/tempDir';
import { prepareRequesterAccountActionContext } from '../sessionEncryption/requesterAccountActionProjection';
import { createDaemonExternalActionTargetResolver } from './daemonExternalActionTargetResolver';
import { executeExternalAction } from './executeExternalAction';

const boundary = vi.hoisted(() => ({
  io: vi.fn(),
  identity: null as import('@happier-dev/protocol').MachineInstallationIdentityV1 | null,
  credentials: null as import('@/persistence').StoredCredentials | null,
}));
// Device credential persistence is an OS boundary, isolated from real daemon files.
vi.mock('@/persistence', async importOriginal => ({
  ...await importOriginal<typeof import('@/persistence')>(),
  readStoredCredentials: async () => boundary.credentials,
}));
vi.mock('socket.io-client', () => ({ io: boundary.io }));
// The installation keystore is an OS boundary; its signer and protocol remain real.
vi.mock('@/daemon/identity/store', async importOriginal => ({
  ...await importOriginal<typeof import('@/daemon/identity/store')>(),
  readInstallationIdentityIfExistsSync: () => boundary.identity,
}));

const accountId = 'switch-requester';
const sessionId = 'c123456789012345678901234';
const machineId = 'switch-controller';
const installationId = 'switch-installed';
const actionId = 'session.agent.transition';
const homeId = 'srv_switch';
const homeUrl = 'https://switch-home.test';
const token = `fixture.${Buffer.from(JSON.stringify({ sub: accountId, tokenEpoch: 7,
  provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
const installation = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(23));
const target = { kind: 'machine' as const, machineId };

type Variant = 'present-user' | 'settings-only' | 'inherited-plugin' | 'constraint-only-plugin' | 'escalating-plugin' | 'missing' | 'forged'
  | 'pat-default' | 'pat-read-only' | 'pat-ordered-read-only' | 'pat-yolo' | 'pat-fork-inaccessible';

async function runAdmittedSwitch(variant: Variant) {
  return await withTempDir('happier-admitted-switch-', async activeServerDir => {
    const previousIdentity = boundary.identity;
    boundary.identity = { version: 1, installationId, createdAt: 1,
      publicKey: Buffer.from(installation.publicKey).toString('base64url'),
      privateKey: Buffer.from(installation.secretKey).toString('base64url') };
    const previousDirectory = configuration.activeServerDir;
    Reflect.set(configuration, 'activeServerDir', activeServerDir);
    resetServerFeaturesClientForTests();
    const apiToken = variant.startsWith('pat-');
    boundary.credentials = { token: apiToken ? 'api-switch-credential' : token, encryption: null };
    const apiPrincipal = { accountId, principalId: 'switch-principal', credentialId: 'switch-credential',
      authority: 'account_automation' as const, grant: { ...API_TOKEN_FULL_GRANT_V1,
        ...(variant === 'pat-fork-inaccessible' ? { targets: { sessions: [sessionId], machines: [machineId] } } : {}),
        permissionModes: variant === 'pat-ordered-read-only' ? ['yolo', 'read-only']
          : [variant === 'pat-read-only' ? 'read-only' : 'default'] } };
    const inputMeta: Record<string, string> = variant === 'inherited-plugin' || variant === 'constraint-only-plugin' || variant === 'pat-read-only' || variant === 'pat-ordered-read-only'
      ? { trace: 'authored-meta' }
      : { trace: 'authored-meta', permissionMode: variant === 'pat-default' || variant === 'pat-fork-inaccessible' ? 'default' : 'yolo' };
    const requestInput = { localId: `switch-${variant}`, text: 'Continue with this exact input', meta: inputMeta };
    const envelope = { v: 1 as const, requestId: `request-${variant}`, target,
      input: { sessionId, expectedCurrentAgentId: 'claude', selection: { v: 1, agentId: 'codex' },
        ...(variant === 'settings-only' ? {} : { input: requestInput }) } };
    const invocation: ExternalActionRequesterInvocationV1 | undefined = variant === 'missing' ? undefined
      : variant.includes('plugin') ? { caller: { kind: 'plugin', pluginId: 'acme.switch', contributionLocalId: 'switch' },
        surface: 'plugin', authority: 'account_automation',
        ...(variant === 'constraint-only-plugin' ? {} : { callerPermissionMode: 'read-only' }),
        callerInputConstraints: { models: null, permissionModes: ['read-only'] } }
      : { caller: { kind: 'host' }, surface: 'ui', authority: 'present_user' };
    const authorization = apiToken ? ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'original-switch-root', binding: {
      accountId, principalId: apiPrincipal.principalId, credentialId: apiPrincipal.credentialId, grant: apiPrincipal.grant,
      custodianAccountId: accountId, accountEncryptionMode: 'plain', serverIdentityId: homeId, machineId, installationId,
      actionId, requestId: envelope.requestId, target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
    } }) : sealExternalActionRequesterAccountContextV1({ authorization: { v: 1, token: 'original-switch-root', binding: {
      accountId, custodianAccountId: accountId, authentication: { kind: 'account', tokenEpoch: 7 },
      accountEncryptionMode: 'plain', serverIdentityId: homeId, machineId, installationId,
      actionId, requestId: envelope.requestId, target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
    } }, credentials: { token }, ...(invocation ? { invocation } : {}), purpose: { kind: 'external_action' },
      installationPublicKey: installation.publicKey, randomBytes: tweetnacl.randomBytes });
    if (variant === 'forged' && authorization.requesterAccountContext) {
      const ciphertext = authorization.requesterAccountContext.ciphertext;
      authorization.requesterAccountContext.ciphertext = `${ciphertext.startsWith('A') ? 'B' : 'A'}${ciphertext.slice(1)}`;
    }
    const effects: string[] = [];
    const violations: string[] = [];
    const reads: string[] = [];
    const admitted: { content?: unknown; authority?: SessionInputAuthorityV1 } = {};
    let metadata: Record<string, unknown> = { machineId, flavor: 'claude', path: activeServerDir, permissionMode: 'yolo' };
    if (variant === 'pat-fork-inaccessible') metadata.forkV1 = { v: 1, parentSessionId: 'c223456789012345678901234',
      parentCutoffSeqInclusive: 0, createdAtMs: 1, strategy: 'replay' };
    let metadataVersion = 1;
    const row = () => ({ id: sessionId, machineId, seq: 0, createdAt: 1, updatedAt: 1,
      active: false, activeAt: 1, encryptionMode: 'plain', metadata: JSON.stringify(metadata), metadataVersion,
      metadataLayoutVersion: 0, agentState: null, agentStateVersion: 0, dataEncryptionKey: null,
      latestTurnStatus: 'completed', pendingCount: 0, pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 0 });
    const rejectProof = (message: string) => { violations.push(message); throw new Error(message); };
    const verifyHttp = (method: string, path: string, body: unknown, headers: unknown, allowMachineTarget = false) => {
      const read = AxiosHeaders.from(headers as Parameters<typeof AxiosHeaders.from>[0]);
      const resolved = decodeExternalActionResolvedTargetV1(String(read.get(EXTERNAL_ACTION_RESOLVED_TARGET_HEADER) ?? ''));
      const effectActionId = String(read.get(EXTERNAL_ACTION_EFFECT_ACTION_HEADER) ?? '');
      if (!resolved || read.get(EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER) !== authorization.token
        || effectActionId !== actionId || !verifyExternalActionMachineRequestV1({ authorizationToken: authorization.token,
          effectActionId, target: resolved, installationId, requestId: envelope.requestId, method, path,
          ...(body === undefined ? {} : { body }), publicKey: installation.publicKey,
          signature: String(read.get(EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER) ?? '') })) rejectProof(`missing signed root: ${method} ${path}`);
      expect(resolved).toEqual(allowMachineTarget && resolved?.kind === 'machine' ? target : { kind: 'session', sessionId });
    };
    const verifySocket = (event: string, method: string, requestId: string, params: unknown, proof: unknown) => {
      const parsed = ExternalActionMachineRpcExecutionV1Schema.safeParse(proof);
      if (!parsed.success) return rejectProof(`missing signed root: ${method}`);
      const signed = parsed.data;
      try {
        expect(signed.authorization.token).toBe(authorization.token);
        expect(signed.authorization.binding).toEqual(authorization.binding);
        expect(signed.target).toEqual({ kind: 'session', sessionId });
        expect(signed.installationId).toBe(installationId);
        expect(signed.effectActionId).toBe(event === SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1 ? 'session.message.send'
          : method.endsWith(`:${RPC_METHODS.STOP_SESSION}`) ? 'session.stop' : actionId);
      } catch (error) { rejectProof(error instanceof Error ? error.message : 'wrong signed root binding'); }
      if (!verifyExternalActionMachineRpcRequestV1({ authorizationToken: signed.authorization.token,
        ...(signed.authorization.requesterAccountContext ? { requesterAccountContext: signed.authorization.requesterAccountContext } : {}),
        effectActionId: signed.effectActionId, target: signed.target, installationId: signed.installationId,
        event, method, requestId, params, signature: signed.machineSignature, publicKey: installation.publicKey })) {
        rejectProof(`invalid signed root: ${method}`);
      }
    };
    const rpcBoundary = (event: string, args: unknown[]) => {
      if (event !== SOCKET_RPC_EVENTS.CALL) return;
      const [raw, ack] = args;
      const call = raw as { method: string; requestId: string; params: Record<string, unknown>; externalActionExecution?: unknown };
      const callback = ack as (result: unknown) => void;
      verifySocket(event, call.method, call.requestId, call.params, call.externalActionExecution);
      const method = call.method.slice(call.method.indexOf(':') + 1);
      if (method === RPC_METHODS.STOP_SESSION || method === RPC_METHODS.SPAWN_HAPPY_SESSION) {
        const signed = ExternalActionMachineRpcExecutionV1Schema.parse(call.externalActionExecution);
        if (apiToken) {
          try { expect(signed.authorization.requesterAccountContext).toBeUndefined(); }
          catch (error) { rejectProof(error instanceof Error ? error.message : 'PAT borrowed Account custody'); }
        } else {
          const opened = openExternalActionRequesterAccountContextV1({ authorization: signed.authorization,
            purpose: { kind: 'machine_rpc', method, params: call.params }, machineId, installationId,
            serverIdentityId: homeId, installationPrivateKey: installation.secretKey, includeInvocation: true });
          try { expect(opened?.invocation, 'native Machine effect must retain private invocation').toEqual(invocation); }
          catch (error) { rejectProof(error instanceof Error ? error.message : 'missing private invocation'); }
        }
      }
      if (method === SESSION_RPC_METHODS.SESSION_PROVIDER_INPUT_ADMISSION) {
        effects.push(`fence:${call.params.action}`);
        callback({ ok: true, result: { status: call.params.action === 'enforce' ? 'enforced' : 'cleared' } });
      } else if (method === RPC_METHODS.STOP_SESSION) {
        effects.push('stop'); callback({ ok: true, result: { status: 'stopped' } });
      } else if (method === RPC_METHODS.SPAWN_HAPPY_SESSION) {
        effects.push('activate');
        try {
          expect(call.params.sessionId).toBe(sessionId);
          // This layout-0 Session has no qualified creation correspondence;
          // the real inactive-resume owner retains its canonical builtin carrier.
          expect(call.params.backendTarget, JSON.stringify(call.params)).toEqual({ kind: 'backend', backendId: 'codex', sourceKind: 'built_in' });
          if (apiToken || invocation?.authority === 'account_automation') {
            expect(call.params.executionAuthorization, 'automation resume must not claim a human request').toBeUndefined();
          } else {
            expect(call.params.executionAuthorization).toEqual({ provenance: 'user_request', requestId: requestInput.localId });
          }
        } catch (error) { rejectProof(error instanceof Error ? error.message : 'invalid activation target'); }
        callback({ ok: true, result: { type: 'success', sessionId } });
      } else rejectProof(`unexpected RPC ${method}`);
    };
    const makeSocket = () => createApiSessionSocketStub({ emit: rpcBoundary,
      emitWithAck: (event, payload) => new Promise(resolve => rpcBoundary(event, [payload, resolve])),
    });
    boundary.io.mockImplementation(makeSocket);
    const pendingBoundary = (event: string, args: unknown[]) => {
      if (event !== SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1) return rejectProof(`unexpected Machine event ${event}`);
      const parsed = SessionPendingEnqueueByMachineRequestV1Schema.parse(args[0]);
      const { externalAction, ...unsigned } = parsed;
      verifySocket(event, event, envelope.requestId, unsigned, externalAction);
      expect(parsed.localId).toBe(requestInput.localId);
      expect(parsed.sessionId).toBe(sessionId);
      expect(parsed.content.t).toBe('plain');
      if (parsed.content.t !== 'plain') throw new Error('Expected plain input');
      admitted.content = parsed.content.v;
      const content = parsed.content.v as { meta: Record<string, unknown> };
      admitted.authority = settleSessionInputRequestV1({ request: SessionInputRequestV1Schema.parse(content.meta.happierInputRequestV1),
        currentSessionPermissionCeiling: metadata.permissionMode,
        inputAdmissionReceipt: { v: 1, issuer: 'authenticatedMachine', admittedTarget: {
          homeId, accountId, sessionId, machineId, installationId } } });
      effects.push('input');
      (args[1] as (result: unknown) => void)({ v: 1, result: { status: 'accepted', localId: parsed.localId } });
    };
    const machineSocket = createApiSessionSocketStub({ connected: true, emit: pendingBoundary,
      emitWithAck: (event, payload) => new Promise(resolve => pendingBoundary(event, [payload, resolve])),
    });
    const machine = new ApiMachineClient('custodian-token', { id: machineId, encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy', metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 });
    Reflect.set(machine, 'socket', machineSocket);
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({
      features: { sessions: { enabled: true, agentSwitching: { enabled: true } } }, capabilities: { serverIdentity: { serverIdentityId: homeId } } }));
    const get = vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
      if (apiToken) expect(config?.headers?.Authorization).not.toBe(`Bearer ${token}`);
      const path = new URL(String(url)).pathname;
      reads.push(path);
      if (path === '/v1/account/profile') return { status: 200, data: { id: accountId } };
      if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: {
        actionsSettingsV1: { v: 1, actions: {}, approvalWaivedSurfaces: { [actionId]: ['ui', 'plugin'] } },
      } }, version: 1 } };
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (path === '/v1/account/entity-rows/connected-accounts/purposes') return { status: 200, data: { status: 'deleted', revision: 1 } };
      if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
      if (path === `/v2/sessions/${sessionId}`) return { status: 200, data: { session: row() } };
      if (path === '/v2/sessions/c223456789012345678901234') return { status: 403, data: { error: 'Forbidden' } };
      if (path === `/v1/machines/${machineId}`) return { status: 200, data: { machine: {
        id: machineId, installationId, installationPublicKey: Buffer.from(installation.publicKey).toString('base64'),
        dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, storageMode: 'plain' } } };
      if (path === `/v2/sessions/${sessionId}/messages` || path === `/v1/sessions/${sessionId}/messages`) {
        return { status: 200, data: { messages: [], hasMore: false, activity: {
          pendingCount: 0, pendingBlockedCount: 0, pendingBlockedNoEffectCount: 0,
          pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 0, latestTurnStatus: 'completed',
        } } };
      }
      return rejectProof(`Unexpected requester GET ${path}`);
    });
    const post = vi.spyOn(axios, 'post').mockImplementation(async (url, body, config) => {
      if (apiToken) expect(config?.headers?.Authorization).not.toBe(`Bearer ${token}`);
      const path = new URL(String(url)).pathname;
      if (path === `/v1/actions/${actionId}/execution-authorization/verify`) {
        verifyHttp('POST', path, body, config?.headers, true);
        return { status: 200, data: { ok: true } };
      }
      if (path === `/v2/sessions/${sessionId}/agent-transition/cutover`) {
        verifyHttp('POST', path, body, config?.headers);
        const cutover = body as { currentView: { kind: string; metadataCiphertext: string }; divider: unknown };
        expect(cutover.currentView.kind).toBe('legacy_v0');
        metadata = JSON.parse(cutover.currentView.metadataCiphertext) as Record<string, unknown>;
        metadataVersion++; effects.push('cutover');
        return { status: 200, data: { success: true, dividerSeq: 1 } };
      }
      return rejectProof(`Unexpected requester POST ${path}`);
    });
    try {
      const result = await executeExternalAction({ actionId, envelope, executionAuthorization: authorization,
        principal: apiToken ? apiPrincipal : { accountId, authority: 'present_user', authentication: { kind: 'account', tokenEpoch: 7 } },
        currentMachineId: machineId, currentServerId: 'profile', currentServerHttpBaseUrl: homeUrl,
        currentInstallationId: installationId, externalActionMachineRequestPrivateKey: installation.secretKey,
        verifyExecutionAuthorization: request => verifyExternalActionExecutionAuthorizationCurrent({ ...request,
          privateKey: installation.secretKey, installationId, serverHttpBaseUrl: homeUrl }),
        resolveTarget: createDaemonExternalActionTargetResolver({ credentials: { token: apiToken ? 'api-switch-credential' : token, encryption: null } }),
        executor: apiToken ? createCliActionExecutor({ token: 'api-switch-credential', credentials: { token: 'api-switch-credential', encryption: null }, sessionId: '',
          serverId: 'profile', serverHttpBaseUrl: homeUrl, mode: 'plain', ctx: null,
          externalActionMachineRequestPrivateKey: installation.secretKey, externalActionMachineInstallationId: installationId,
          machineAdmissionTransport: (request, options) => machine.enqueueSessionPendingByMachine(request, options),
          actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({ v: 1, actions: {},
            approvalWaivedSurfaces: { [actionId]: ['api'] } }) },
        }) : createActionExecutor(createUnavailableActionTransportDeps()),
        ...(apiToken ? {} : { prepareRequesterAccountContext: (request: { authorization: typeof authorization }) => prepareRequesterAccountActionContext({ authorization: request.authorization,
          purpose: { kind: 'external_action' }, machineId, installationId, installationPrivateKey: installation.secretKey,
          serverId: 'profile', serverIdentityId: homeId, serverHttpBaseUrl: homeUrl, isCurrent: async () => true,
          createExecutor: admittedRequester => createCliActionExecutorFromCredentials({ credentials: admittedRequester.credentials,
            serverId: 'profile', serverApiUrl: homeUrl, serverIdentityId: homeId, machineId,
            externalActionMachineRequestPrivateKey: installation.secretKey, externalActionMachineInstallationId: installationId,
            machineAdmissionTransport: (request, options) => machine.enqueueSessionPendingByMachine(request, options),
            actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1(admittedRequester.accountSettingsContext.settings.actionsSettingsV1),
              getAccountSettings: () => admittedRequester.accountSettingsContext.settings },
          }),
        }) }),
      });
      return { result, effects, violations, metadata, admitted, requestInput, reads, socketConnections: boundary.io.mock.calls.length };
    } finally {
      get.mockRestore(); post.mockRestore(); fetch.mockRestore(); Reflect.set(configuration, 'activeServerDir', previousDirectory);
      boundary.identity = previousIdentity; boundary.io.mockReset(); resetServerFeaturesClientForTests();
      boundary.credentials = null;
    }
  });
}

describe('admitted Account-machine Agent transition composition', () => {
  it('commits a settings-only transition using the admitted Action identity without input custody', async () => {
    const observed = await runAdmittedSwitch('settings-only');
    expect(observed.violations).toEqual([]);
    expect(observed.result).toMatchObject({ kind: 'response', response: { execution: {
      ok: true, result: { type: 'accepted', localId: 'request-settings-only' },
    } } });
    expect(observed.metadata.flavor).toBe('codex');
    expect(observed.effects).toEqual(['fence:enforce', 'stop', 'cutover', 'fence:clear']);
    expect(observed.admitted.content).toBeUndefined();
  });

  it.each(['present-user', 'inherited-plugin', 'constraint-only-plugin', 'pat-default', 'pat-read-only', 'pat-ordered-read-only'] as const)(
    'completes %s through real owners and signed source effects', async variant => {
    const observed = await runAdmittedSwitch(variant);
    expect(observed.violations).toEqual([]);
    expect(observed.admitted.authority, JSON.stringify({ result: observed.result, effects: observed.effects })).toMatchObject({ caller: { kind: variant.includes('plugin') ? 'plugin' : 'host' },
      permission: { admittedPermissionCeiling: variant === 'present-user' ? 'yolo' : variant === 'pat-default' ? 'default' : 'read-only',
        ...(variant === 'constraint-only-plugin' || variant === 'pat-read-only' || variant === 'pat-ordered-read-only' ? { requestedPermissionCeiling: 'read-only' } : {}) } });
    expect(observed.result, JSON.stringify({ result: observed.result, reads: observed.reads, effects: observed.effects, socketConnections: observed.socketConnections })).toMatchObject({ kind: 'response', response: { execution: {
      ok: true, result: { type: 'accepted', localId: observed.requestInput.localId },
    } } });
    expect(observed.metadata.flavor).toBe('codex');
    expect(observed.metadata.machineId).toBe(machineId);
    expect(observed.effects).toEqual(['fence:enforce', 'stop', 'cutover', 'fence:clear', 'input', 'activate']);
    expect(observed.admitted.content).toMatchObject({ role: 'user', content: { type: 'text', text: observed.requestInput.text },
      meta: observed.requestInput.meta });
  });

  it.each(['escalating-plugin', 'missing', 'forged', 'pat-yolo', 'pat-fork-inaccessible'] as const)('refuses %s before source effects', async variant => {
    const observed = await runAdmittedSwitch(variant);
    expect(observed.effects).toEqual([]);
    expect(observed.violations).toEqual([]);
    expect(observed.metadata.flavor).toBe('claude');
    if (variant === 'forged') {
      expect(observed.result).toMatchObject({ kind: 'invalid_request', errorCode: 'invalid_envelope' });
      return;
    }
    expect(observed.result).toMatchObject({ kind: 'response', response: { execution: variant === 'missing'
      ? { ok: false, errorCode: 'forbidden' }
      : { ok: true, result: { type: 'rejected', code: 'forbidden', sourceEffect: 'none' } } } });
  });
});
