import { describe, expect, it, vi } from 'vitest';

import { RpcHandlerManager } from './RpcHandlerManager';
import { RPC_ERROR_CODES, RPC_ERROR_MESSAGES } from '@happier-dev/protocol/rpcErrors';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS } from '@happier-dev/protocol/socketRpc';
import { AUTOMATION_REPLY_HANDOFF_DAEMON_RPC_METHOD_V1 } from '@happier-dev/protocol/automations/event';
import { RpcError } from '@happier-dev/protocol/rpcErrors';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { decodeBase64, encodeBase64, encrypt, decrypt } from '@/api/encryption';
import type { Socket } from 'socket.io-client';
import type { RpcHandlerContext } from './types';
import { computeExternalActionSocketRpcRequestDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import type { ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { API_TOKEN_FULL_GRANT_V1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import { authorizeMachineRpcRequest, verifyMachineRpcAdmissionCurrent } from '@/api/machine/machineRpcAuthorization';
import { verifyMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { WorkspaceSyncSourceRoutingV1Schema, WorkspaceSyncSourceWriterTargetRoutingV1Schema, WorkspaceSyncTargetRoutingV1Schema } from '@happier-dev/protocol/socketRpc';
import { socketRpcCodec, type SocketRpcContent } from '@happier-dev/sync-client';
import { computeWorkspaceSyncPolicyDigest } from '@happier-dev/protocol';
import axios from 'axios';
import tweetnacl from 'tweetnacl';
import { prepareRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import type { PrepareExternalActionRequesterAccountContext } from '@/daemon/externalActions/executeExternalAction';
import { sealExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { encodeStoredCredentials, type StoredCredentials } from '@/persistence';
import { prepareAccountSettingsV2Content } from '@/settings/accountSettings/updateAccountSettingsV2WithRetry';
import { verifyExternalActionExecutionAuthorizationCurrent } from '@/api/externalActionExecutionAuthorization';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import { deriveBoxPublicKeyFromSeed, deriveBoxSecretKeyFromSeed, sealBoxBundle, openBoxBundleWithSecretKey } from '@happier-dev/protocol/crypto/boxBundle';
import * as installationStore from '@/daemon/identity/store';
import { HandoffTargetReplacementPreflightV1Schema } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { isDeepStrictEqual } from 'node:util';
import { ProviderBoundModelRefSchema } from '@happier-dev/protocol/providers/model-selection';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';

const bindingCallId = '0123456789abcdef0123456789abcdef';
const boundWorkspaceModel = ProviderBoundModelRefSchema.parse({ agentTargetKey: 'codex', providerConnectionId: null, modelId: 'bound-model' });

it.each(['ordinary Account-codec baseline', 'installation-sealed request', 'physical-parent installation-sealed request'] as const)(
  'opens an installation-sealed TARGET and binds its reply without borrowing the chosen child Account key: %s', async transport => {
  const target = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(41));
  const targetMachineId = 'chosen-target-child';
  const targetInstallationId = 'chosen-target-installation';
  const physicalParent = transport === 'physical-parent installation-sealed request';
  const recipientMachineId = physicalParent ? 'physical-target-parent' : targetMachineId;
  const recipientInstallationId = physicalParent ? 'physical-target-installation' : targetInstallationId;
  const homeId = 'srv_installed_target_home';
  const machineAdmission = { actorAccountId: 'borrower', custodianAccountId: 'target-owner', machineId: targetMachineId,
    installationId: targetInstallationId, role: 'use' as const, encryptionMode: 'e2ee' as const };
  const constraints = { models: [boundWorkspaceModel], permissionModes: null };
  // Home issuance/current grants are independently exercised by the server integration suite.
  // This owner test mocks only the Home HTTP transport and the installed-key OS reader.
  const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-issued-target-root', binding: {
    accountId: 'borrower', principalId: 'borrower', credentialId: 'pat', grant: { ...API_TOKEN_FULL_GRANT_V1, models: [boundWorkspaceModel] },
    custodianAccountId: 'source-owner', serverIdentityId: homeId, machineId: 'source-child',
    installationId: 'source-child-installation', actionId: 'session.handoff', requestId: 'workspace-operation',
    requestEnvelopeDigest: 'A'.repeat(43), target: { kind: 'machine', machineId: 'source-child' },
    handoffAdmission: { sessionId: 'source-session', sourceMachineId: 'source-child', targetMachineId,
      sourceInstallationId: 'source-child-installation', targetInstallationId },
  } });
  const source = WorkspaceSyncSourceRoutingV1Schema.parse({ v: 1, phase: 'prepare', operationId: root.binding.requestId,
    accountServerId: homeId, sourceMachineId: 'source-child', sourceRootPath: '/source/workspace', sourceSessionId: 'source-session',
    sourceContext: { machineAdmission: { actorAccountId: 'borrower', custodianAccountId: 'source-owner', machineId: 'source-child',
      installationId: 'source-child-installation', role: 'use', encryptionMode: 'e2ee' },
      callerAuthority: 'account_automation', callerInputConstraints: constraints, workspaceWrites: 'allow' } });
  const routing = WorkspaceSyncSourceWriterTargetRoutingV1Schema.parse({ v: 1,
    sourceWriter: { machineId: 'physical-source-parent', installationId: 'physical-source-installation' },
    source, target: { v: 1, phase: 'preflight', operationId: root.binding.requestId,
      accountServerId: homeId, targetMachineId, targetRootPath: '/chosen/workspace' } });
  // The second hop retains D's Home admission and original B snapshot; P2 is only the installed physical recipient.
  const targetRouting = physicalParent ? WorkspaceSyncTargetRoutingV1Schema.parse({ ...routing.target,
    targetContext: { machineAdmission, callerAuthority: 'account_automation', callerInputConstraints: constraints,
      workspaceWrites: 'allow' } }) : undefined;
  const method = `${recipientMachineId}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT}`;
  const params = HandoffTargetReplacementPreflightV1Schema.parse({ v: 1, operationId: root.binding.requestId,
    serverId: homeId, machineId: targetMachineId, targetPath: routing.target.targetRootPath });
  const identity = vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({ version: 1,
    installationId: recipientInstallationId, createdAt: 1,
    publicKey: Buffer.from(target.publicKey).toString('base64url'), privateKey: Buffer.from(target.secretKey).toString('base64url') });
  let homeVerified = false;
  const post = vi.spyOn(axios, 'post').mockImplementation(async (url, raw) => {
    expect(String(url)).toBe(`https://installed-target-home.invalid/v1/machines/${recipientMachineId}/admission/verify`);
    const body = raw as { context: typeof machineAdmission; method: string; callerInputAuthorization: typeof root;
      workspaceSyncSourceWriterTargetRouting: typeof routing; proof: Parameters<typeof verifyMachineInstallationProof>[0]['proof'] };
    expect(body.context).toEqual(machineAdmission);
    expect(body.callerInputAuthorization).toEqual(root);
    expect(body.workspaceSyncSourceWriterTargetRouting).toEqual(routing);
    if (targetRouting) expect(raw).toMatchObject({ workspaceSyncTargetRouting: targetRouting });
    const payload = { version: 1 as const, machineId: recipientMachineId, installationId: recipientInstallationId,
      accountId: 'target-owner', rpcAdmission: { context: machineAdmission, method,
        ...(targetRouting ? { workspaceSyncTargetRouting: targetRouting } : {}),
        callerInputAuthorization: root, workspaceSyncSourceWriterTargetRouting: routing } };
    expect(verifyMachineInstallationProof({ payload, proof: body.proof, publicKey: target.publicKey })).toBe(true);
    homeVerified = true;
    return { status: 200, data: { v: 1, ok: true } };
  });
  const accountKey = new Uint8Array(32).fill(17);
  const accountContent: SocketRpcContent = { mode: 'e2ee', cipher: {
    encryptRaw: async value => encodeBase64(encrypt(accountKey, 'dataKey', value)),
    decryptRaw: async value => decrypt(accountKey, 'dataKey', decodeBase64(value)),
  } };
  const rpc = new RpcHandlerManager({ scopePrefix: recipientMachineId, localMachineId: recipientMachineId,
    encryptionKey: accountKey, encryptionVariant: 'dataKey', logger: () => {},
    authorizeRequest: request => authorizeMachineRpcRequest(request, { machineId: recipientMachineId,
      resolveCustodianAccountId: async () => 'target-owner', resolveInstallationId: () => recipientInstallationId,
      verifyMachineAdmission: received => verifyMachineRpcAdmissionCurrent({ ...received, privateKey: target.secretKey,
        ...(physicalParent ? { workspaceSyncTargetReceiver: { machineId: recipientMachineId, installationId: recipientInstallationId } } : {}),
        daemonToken: 'installed-target-token', serverHttpBaseUrl: 'https://installed-target-home.invalid' }) }) });
  let observed = 0;
  rpc.registerHandler(RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT, async (input, context) => {
    expect(homeVerified).toBe(true);
    expect(input).toEqual(params);
    expect(context?.callerInputAuthorization).toEqual(root);
    expect(context?.machineAdmission).toEqual(machineAdmission);
    expect(context).toMatchObject({ workspaceSyncSourceWriterTargetRouting: routing });
    observed += 1;
    return { admitted: true, originalActor: context?.machineAdmission?.actorAccountId };
  });
  const request = { method, machineAdmission, callerAuthority: 'account_automation' as const, callerInputConstraints: constraints,
    callerInputAuthorization: root, workspaceSyncSourceWriterTargetRouting: routing,
    ...(targetRouting ? { workspaceSyncTargetRouting: targetRouting } : {}) };
  try {
    // The same Home/domain baseline must pass before any failure is attributed to cipher selection.
    const baseline = await rpc.handleRequest({ ...request,
      params: await socketRpcCodec.encodeParams(accountContent, params, { method, callId: bindingCallId }) });
    expect(await socketRpcCodec.decodeResult(accountContent, { ok: true, result: baseline }, bindingCallId))
      .toEqual({ admitted: true, originalActor: 'borrower' });
    expect(observed).toBe(1);
    const refused = async (changed: Partial<typeof request>, changedParams: unknown = params) => {
      const result = await rpc.handleRequest({ ...request, ...changed,
        params: await socketRpcCodec.encodeParams(accountContent, changedParams, { method, callId: bindingCallId }) });
      const decoded = socketRpcCodec.decodeResult(accountContent, { ok: true, result }, bindingCallId);
      if (result && typeof result === 'object' && !Array.isArray(result)
        && 'error' in result && typeof result.error === 'string'
        && 'errorCode' in result && typeof result.errorCode === 'string') {
        // A refusal before request decoding has no bound reply/call id. The public
        // codec rejects that raw typed refusal rather than treating it as a result.
        await expect(decoded).rejects.toMatchObject({ name: 'RpcError', rpcErrorCode: RPC_ERROR_CODES.FORBIDDEN });
      } else {
        expect(await decoded).toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
      }
    };
    await refused({ callerInputAuthorization: { ...root, token: 'forged-root' } });
    await refused({ workspaceSyncSourceWriterTargetRouting: { ...routing,
      sourceWriter: { ...routing.sourceWriter, installationId: 'forged-writer' } } });
    await refused({}, { ...params, targetPath: '/unrelated/root' });
    if (targetRouting) {
      await refused({ workspaceSyncTargetRouting: { ...targetRouting, operationId: 'unrelated-operation' } });
      await refused({ workspaceSyncTargetRouting: { ...targetRouting,
        targetContext: { ...targetRouting.targetContext, callerAuthority: 'present_user' } } });
    }
    expect(observed).toBe(1);
    if (transport === 'ordinary Account-codec baseline') return;

    const replySeed = tweetnacl.randomBytes(32);
    const recipient = { machineId: recipientMachineId, installationId: recipientInstallationId };
    // This is an incoming wire fixture, built with the existing canonical box primitives.
    // Its known installed fixture seed is not delegated to the production caller.
    const installedContent: SocketRpcContent = { mode: 'e2ee', cipher: {
      encryptRaw: async value => JSON.stringify({ v: 1, kind: 'workspace_sync_target_request_v1', ...recipient,
        ciphertext: Buffer.from(sealBoxBundle({ recipientPublicKey: deriveBoxPublicKeyFromSeed(target.secretKey.subarray(0, 32)),
          plaintext: new TextEncoder().encode(JSON.stringify({ v: 1, kind: 'workspace_sync_target_request_v1', ...recipient,
            method, routing, replyPublicKey: Buffer.from(deriveBoxPublicKeyFromSeed(replySeed)).toString('base64url'), rpc: value })),
          randomBytes: tweetnacl.randomBytes })).toString('base64url') }),
      decryptRaw: async ciphertext => {
        const outer: unknown = JSON.parse(ciphertext);
        if (!outer || typeof outer !== 'object' || !('ciphertext' in outer) || typeof outer.ciphertext !== 'string'
          || !('v' in outer) || outer.v !== 1 || !('kind' in outer) || outer.kind !== 'workspace_sync_target_response_v1'
          || !('machineId' in outer) || outer.machineId !== recipient.machineId
          || !('installationId' in outer) || outer.installationId !== recipient.installationId) return null;
        const opened = openBoxBundleWithSecretKey({ bundle: new Uint8Array(Buffer.from(outer.ciphertext, 'base64url')),
          recipientSecretKey: deriveBoxSecretKeyFromSeed(replySeed) });
        if (!opened) return null;
        const inner: unknown = JSON.parse(new TextDecoder().decode(opened));
        if (!inner || typeof inner !== 'object' || !('v' in inner) || inner.v !== 1
          || !('kind' in inner) || inner.kind !== 'workspace_sync_target_response_v1'
          || !('machineId' in inner) || inner.machineId !== recipient.machineId
          || !('installationId' in inner) || inner.installationId !== recipient.installationId
          || !('method' in inner) || inner.method !== method || !('routing' in inner)
          || !isDeepStrictEqual(inner.routing, routing) || !('rpc' in inner)) return null;
        return inner.rpc;
      },
    } };
    const sealed = await socketRpcCodec.encodeParams(installedContent, params, { method, callId: bindingCallId });
    const sealedFrame: unknown = JSON.parse(sealed);
    if (!sealedFrame || typeof sealedFrame !== 'object' || !('ciphertext' in sealedFrame)
      || typeof sealedFrame.ciphertext !== 'string') throw new Error('The installed request fixture was not sealed');
    const fixturePlaintext = openBoxBundleWithSecretKey({
      bundle: new Uint8Array(Buffer.from(sealedFrame.ciphertext, 'base64url')),
      recipientSecretKey: deriveBoxSecretKeyFromSeed(target.secretKey.subarray(0, 32)),
    });
    if (!fixturePlaintext) throw new Error('The installed request fixture cannot be opened by its recipient');
    expect(JSON.parse(new TextDecoder().decode(fixturePlaintext))).toMatchObject({
      method, routing, machineId: recipientMachineId, installationId: recipientInstallationId,
    });
    await expect(socketRpcCodec.decodeRequestParams(accountContent, sealed, method)).rejects.toMatchObject({ rpcErrorCode: RPC_ERROR_CODES.UPDATE_REQUIRED });
    // Unopened frames establish no V2 call id or reply recipient; only a typed refusal can leave the receiver.
    for (const changedFrame of [
      { ...sealedFrame, installationId: 'replacement-installation' },
      { ...sealedFrame, unexpected: true },
    ]) {
      const refused = await rpc.handleRequest({ ...request, params: JSON.stringify(changedFrame) });
      expect(refused).toMatchObject({ errorCode: RPC_ERROR_CODES.UPDATE_REQUIRED });
    }
    const changedRouting = await rpc.handleRequest({ ...request, params: sealed,
      workspaceSyncSourceWriterTargetRouting: { ...routing, source: { ...routing.source, sourceRootPath: '/substituted/source' } } });
    expect(changedRouting).toMatchObject({ errorCode: RPC_ERROR_CODES.UPDATE_REQUIRED });
    expect(observed).toBe(1);
    const result = await rpc.handleRequest({ ...request, params: sealed });
    expect(await socketRpcCodec.decodeResult(installedContent, { ok: true, result }, bindingCallId))
      .toEqual({ admitted: true, originalActor: 'borrower' });
    expect(observed).toBe(2);
    await expect(socketRpcCodec.decodeResult(accountContent, { ok: true, result }, bindingCallId))
      .rejects.toMatchObject({ rpcErrorCode: RPC_ERROR_CODES.UPDATE_REQUIRED });
    await expect(socketRpcCodec.decodeResult(installedContent, { ok: true, result }, 'f'.repeat(32)))
      .rejects.toMatchObject({ rpcErrorCode: RPC_ERROR_CODES.UPDATE_REQUIRED });
    await expect(socketRpcCodec.decodeResult(installedContent, { ok: true, result: sealed }, bindingCallId))
      .rejects.toMatchObject({ rpcErrorCode: RPC_ERROR_CODES.UPDATE_REQUIRED });
  } finally { post.mockRestore(); identity.mockRestore(); }
});

it.each(['scoped PAT', 'terminal', 'narrowed Account'] as const)(
  'retains the original Home handoff root through verified physical SOURCE ingress without making the parent its signer: %s', async rootKind => {
  const parent = tweetnacl.sign.keyPair();
  const machineAdmission = { actorAccountId: 'borrower', custodianAccountId: 'owner', machineId: 'source-child',
    installationId: 'source-child-installation', role: 'use' as const, encryptionMode: 'plain' as const };
  const constraints = rootKind === 'scoped PAT' ? { models: [boundWorkspaceModel], permissionModes: null } : undefined;
  const principal = rootKind === 'scoped PAT'
    ? { principalId: 'borrower', credentialId: 'pat', grant: { ...API_TOKEN_FULL_GRANT_V1, models: [boundWorkspaceModel] } }
    : { authentication: { kind: rootKind === 'terminal' ? 'terminal' as const : 'account' as const, tokenEpoch: 1 } };
  // The Home response is the network boundary; the real issuer is exercised by the server integration suite.
  const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-issued-root', binding: {
    accountId: 'borrower', ...principal,
    custodianAccountId: 'owner', serverIdentityId: 'srv_source_writer_home', machineId: 'source-child',
    installationId: 'source-child-installation', actionId: 'session.handoff', requestId: 'workspace-operation',
    requestEnvelopeDigest: 'A'.repeat(43), target: { kind: 'machine', machineId: 'source-child' },
    handoffAdmission: { sessionId: 'source-session', sourceMachineId: 'source-child', targetMachineId: 'target-child',
      sourceInstallationId: 'source-child-installation', targetInstallationId: 'target-child-installation' },
  } });
  const routing = WorkspaceSyncSourceRoutingV1Schema.parse({ v: 1, phase: 'prepare', operationId: 'workspace-operation',
    accountServerId: 'srv_source_writer_home', sourceMachineId: 'source-child', sourceRootPath: '/child/workspace',
    sourceSessionId: 'source-session', sourceContext: { machineAdmission, callerAuthority: 'account_automation',
      ...(constraints ? { callerInputConstraints: constraints } : {}), workspaceWrites: 'allow' } });
  if (!routing.sourceContext) throw new Error('SOURCE fixture requires its original context');
  const policy = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
  const params = { v: 1, phase: 'prepare', input: { operationId: routing.operationId, accountServerId: routing.accountServerId,
    sourceMachineId: routing.sourceMachineId, sourceRootPath: routing.sourceRootPath, sourceSessionId: routing.sourceSessionId,
    targetMachineId: 'target-child', targetRootPath: '/target/workspace',
    action: { kind: 'copy_once', contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) } } } };
  let verifiedParent = false;
  const post = vi.spyOn(axios, 'post').mockImplementation(async (url, raw) => {
    expect(String(url)).toBe('https://source-writer-home.invalid/v1/machines/physical-parent/admission/verify');
    const body = raw as { context: typeof machineAdmission; method: string; workspaceSyncSourceRouting: typeof routing;
      callerInputAuthorization: typeof root;
      proof: Parameters<typeof verifyMachineInstallationProof>[0]['proof'] };
    expect(body.context).toEqual(machineAdmission);
    expect(body.callerInputAuthorization).toEqual(root);
    expect(verifyMachineInstallationProof({ payload: { version: 1, machineId: 'physical-parent',
      installationId: 'physical-parent-installation', accountId: 'owner', rpcAdmission: { context: machineAdmission,
        method: body.method, workspaceSyncSourceRouting: routing, callerInputAuthorization: root } }, proof: body.proof, publicKey: parent.publicKey })).toBe(true);
    verifiedParent = true;
    return { status: 200, data: { v: 1, ok: true } };
  });
  const rpc = new RpcHandlerManager({ scopePrefix: 'physical-parent', localMachineId: 'physical-parent',
    encryptionMode: 'plain', logger: () => {}, authorizeRequest: request => authorizeMachineRpcRequest(request, {
      machineId: 'physical-parent', resolveCustodianAccountId: async () => 'owner',
      resolveInstallationId: () => 'physical-parent-installation', verifyMachineAdmission: received =>
        verifyMachineRpcAdmissionCurrent({ ...received, privateKey: parent.secretKey, daemonToken: 'installed-parent-token',
          serverHttpBaseUrl: 'https://source-writer-home.invalid',
          workspaceSyncSourceReceiver: { machineId: 'physical-parent', installationId: 'physical-parent-installation' } }),
    }) });
  let effects = 0;
  rpc.registerHandler(RPC_METHODS.DAEMON_WORKSPACE_SYNC_HANDOFF_SOURCE_PHASE, async (_params, context) => {
    effects += 1;
    expect(verifiedParent).toBe(true);
    expect(context?.callerInputAuthorization).toEqual(root);
    expect(context?.workspaceSyncSourceRouting).toEqual(routing);
    expect(context?.machineAdmission).toEqual(machineAdmission);
    expect(context?.callerAuthority).toBe('account_automation');
    return { retained: true, signerMachineId: 'physical-parent', originalMachineId: context?.callerInputAuthorization?.binding.machineId };
  });
  try {
    const request = { method: `physical-parent:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_HANDOFF_SOURCE_PHASE}`,
      params, machineAdmission, workspaceSyncSourceRouting: routing, callerAuthority: 'account_automation',
      callerInputConstraints: constraints, callerInputAuthorization: root } as const;
    await expect(rpc.handleRequest({ ...request, params: { ...params,
      input: { ...params.input, targetMachineId: 'unrelated-child' } } })).resolves.toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
    if (rootKind !== 'narrowed Account') {
      await expect(rpc.handleRequest({ ...request, callerAuthority: 'present_user', workspaceSyncSourceRouting: {
        ...routing, sourceContext: { ...routing.sourceContext, callerAuthority: 'present_user' },
      } })).resolves.toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
    }
    if (constraints) {
      const widenedConstraints = { models: null, permissionModes: null };
      await expect(rpc.handleRequest({ ...request, callerInputConstraints: widenedConstraints,
        workspaceSyncSourceRouting: { ...routing, sourceContext: { ...routing.sourceContext,
          callerInputConstraints: widenedConstraints } } })).resolves.toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
    }
    expect(effects).toBe(0);
    await expect(rpc.handleRequest(request)).resolves.toMatchObject({
        retained: true, signerMachineId: 'physical-parent', originalMachineId: 'source-child',
      });
    expect(effects).toBe(1);
  } finally { post.mockRestore(); }
});

it.each(['plain', 'e2ee'] as const)('admits arbitrary %s requester custody through the existing RPC carrier and real credential factory', async mode => {
  const installation = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(18));
  const machineKey = new Uint8Array(32).fill(7);
  const credentials: StoredCredentials = { token: 'bob-private', encryption: mode === 'plain' ? null
    : { type: 'legacy', secret: new Uint8Array(32).fill(29) } };
  const method = 'machine:machines.managed.list';
  const params = { homeId: 'home' };
  const authorization: ExternalActionExecutionAuthorizationV1 = { v: 1, token: 'home-root', binding: {
    accountId: 'bob', custodianAccountId: 'alice', authentication: { kind: 'account', tokenEpoch: 1 },
    accountEncryptionMode: mode, serverIdentityId: 'home', machineId: 'machine', installationId: 'installation',
    actionId: 'machines.managed.list', requestId: 'original-request', requestEnvelopeDigest: 'a'.repeat(43),
    target: { kind: 'machine', machineId: 'machine' },
  } };
  const seal = (root = authorization, payload = params) => sealExternalActionRequesterAccountContextV1({ authorization: root,
    credentials: encodeStoredCredentials(credentials), purpose: { kind: 'machine_rpc', method, params: payload },
    installationPublicKey: installation.publicKey, randomBytes: tweetnacl.randomBytes });
  const settings = prepareAccountSettingsV2Content({ credentials, raw: {}, envelopeKind: mode === 'plain' ? 'plain' : 'encrypted' });
  let current = true;
  let retired: (() => Promise<boolean>) | undefined;
  const get = vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
    expect(config?.headers?.Authorization).toBe('Bearer bob-private');
    if (String(url).endsWith('/v1/account/profile')) return { status: 200, data: { id: 'bob' } };
    if (String(url).endsWith('/v2/account/settings')) return { status: 200, data: { content: settings, version: 1 } };
    if (String(url).endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
      mode, version: 1, signingKeyFingerprint: mode === 'plain' ? null : 'signing',
      contentKeyFingerprint: credentials.encryption?.type === 'legacy' ? computeContentPublicKeyFingerprint(
        tweetnacl.box.keyPair.fromSecretKey(deriveAccountMachineKeyFromRecoverySecret(credentials.encryption.secret)).publicKey) : null, updatedAt: 1,
    } };
    throw new Error('Unexpected requester HTTP read');
  });
  const post = vi.spyOn(axios, 'post').mockImplementation(async url => {
    expect(String(url)).toContain('/execution-authorization/verify');
    return { status: current ? 200 : 403, data: { ok: current } };
  });
  const prepare: PrepareExternalActionRequesterAccountContext = async ({ authorization: root, purpose, signal }) =>
    prepareRequesterAccountActionContext({ authorization: root, purpose: purpose ?? { kind: 'external_action' },
      machineId: 'machine', installationId: 'installation', installationPrivateKey: installation.secretKey,
      serverId: 'profile', serverIdentityId: 'home', serverHttpBaseUrl: 'https://bob-home.test', signal,
      isCurrent: () => verifyExternalActionExecutionAuthorizationCurrent({ authorization: root,
        effectActionId: root.binding.actionId, target: root.binding.target, installationId: 'installation',
        privateKey: installation.secretKey, serverHttpBaseUrl: 'https://bob-home.test', signal }),
      createExecutor: admitted => {
        retired = admitted.isCurrent;
        return createCliActionExecutorFromCredentials({ credentials: admitted.credentials, serverId: 'profile',
          serverApiUrl: 'https://bob-home.test', serverIdentityId: 'home', machineId: 'machine',
          externalActionMachineInstallationId: 'installation', externalActionMachineRequestPrivateKey: installation.secretKey,
          readCredentials: async () => await admitted.isCurrent() ? admitted.credentials : null,
          actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1(admitted.accountSettingsContext.settings.actionsSettingsV1),
            getAccountSettings: () => admitted.accountSettingsContext.settings },
          // Native managed provider delivery is the external boundary; real policy and custody stay active.
          managedMachineAction: async request => {
            expect(request.context.externalActionExecutionAuthorization?.requesterAccountProjection?.accountId).toBe('bob');
            expect(request.context.externalActionExecutionAuthorization?.requesterHttpProjection?.accountId).toBe('bob');
            return { machines: [] };
          },
        });
      },
    });
  const config = { scopePrefix: 'machine', localMachineId: 'machine', logger: () => {},
    ...(mode === 'plain' ? { encryptionMode: 'plain' as const } : { encryptionKey: machineKey, encryptionVariant: 'dataKey' as const }),
    // Authenticated Home Machine admission is the network boundary; private Home root currentness stays real above.
    authorizeRequest: async () => ({ ok: true as const }), prepareRequesterAccountContext: prepare };
  const rpc = new RpcHandlerManager(config);
  rpc.registerHandler('machines.managed.list', async (args, context) => {
    const root = context?.callerInputAuthorization;
    if (!root?.requesterAccountExecutor) throw new Error('Missing admitted requester executor');
    return await root.requesterAccountExecutor.execute('machines.managed.list', args, { surface: 'ui',
      authority: context?.callerAuthority, serverId: 'profile', runtimeAccountId: 'bob',
      externalActionExecutionAuthorization: root, externalActionTarget: root.binding.target, actionRequestId: root.binding.requestId });
  });
  const machineAdmission = { actorAccountId: 'bob', custodianAccountId: 'alice', machineId: 'machine',
    installationId: 'installation', role: 'manage' as const, encryptionMode: mode };
  const run = async (root = seal(), payload = params) => {
    const response = await rpc.handleRequest({ method, params: mode === 'plain' ? payload : await sealRpcRequest(machineKey, method, payload),
      requestId: 'relay-request', machineAdmission, callerAuthority: 'present_user', callerInputAuthorization: root });
    return mode === 'plain' ? response : await openRpcResponse(machineKey, response);
  };
  try {
    expect(await run()).toMatchObject({ ok: true, result: { machines: [] } });
    expect(await retired?.()).toBe(false);
    expect(await run(seal(), { homeId: 'other' })).toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
    expect(await run({ ...seal(), token: 'swapped-root' })).toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
    current = false;
    expect(await run()).toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
  } finally { get.mockRestore(); post.mockRestore(); }
});

it('refuses unverified physical TARGET routing before exposing the existing preflight receiver', async () => {
  const machineAdmission = { actorAccountId: 'actor', custodianAccountId: 'owner', machineId: 'target-child',
    installationId: 'target-child-installation', role: 'use' as const, encryptionMode: 'plain' as const };
  const workspaceSyncTargetRouting = { v: 1 as const, phase: 'preflight' as const, operationId: 'move-1',
    accountServerId: 'home-1', targetMachineId: 'target-child', targetRootPath: '/child/workspace',
    targetContext: { machineAdmission, callerAuthority: 'account_automation' as const, workspaceWrites: 'deny' as const } };
  const rpc = new RpcHandlerManager({ scopePrefix: 'parent', encryptionMode: 'plain', logger: () => {} });
  rpc.registerHandler(RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT, () => ({ effect: 'receiver-reached' }));
  const request = { method: `parent:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT}`,
    params: { v: 1, operationId: 'move-1', serverId: 'home-1', machineId: 'target-child', targetPath: '/child/workspace' },
    workspaceSyncTargetRouting, callerAuthority: 'account_automation' as const };
  expect(await rpc.handleRequest(request)).toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
  expect(await rpc.handleRequest({ ...request, machineAdmission })).toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
});

it('refuses the private workspace SOURCE member without Home-verified child routing before exposing its receiver', async () => {
  const method = `parent:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_HANDOFF_SOURCE_PHASE}`;
  const machineAdmission = { actorAccountId: 'actor', custodianAccountId: 'owner', machineId: 'child',
    installationId: 'child-installation', role: 'use' as const, encryptionMode: 'plain' as const };
  const workspaceSyncSourceRouting = { v: 1 as const, phase: 'prepare' as const, operationId: 'move-1',
    accountServerId: 'home-1', sourceMachineId: 'child', sourceRootPath: '/child/workspace', sourceSessionId: 'session-1' };
  const policyInput = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
  const contentPolicy = { ...policyInput, policyDigest: computeWorkspaceSyncPolicyDigest(policyInput) };
  const params = { v: 1, phase: 'prepare', input: { operationId: 'move-1', accountServerId: 'home-1',
    sourceMachineId: 'child', sourceRootPath: '/child/workspace', sourceSessionId: 'session-1',
    action: { kind: 'copy_once', contentPolicy }, targetMachineId: 'target', targetRootPath: '/target' } };
  const rpc = new RpcHandlerManager({ scopePrefix: 'parent', encryptionMode: 'plain', logger: () => {} });
  rpc.registerHandler(RPC_METHODS.DAEMON_WORKSPACE_SYNC_HANDOFF_SOURCE_PHASE, () => ({ effect: 'receiver-reached' }));
  for (const request of [
    { method, params },
    { method, params, workspaceSyncSourceRouting },
    { method, params, machineAdmission },
    { method, params, machineAdmission, workspaceSyncSourceRouting },
  ]) expect(await rpc.handleRequest(request)).toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
});

it('opens protected current-service admission on E2EE Machines and keeps its exact witness current', async () => {
  const machineAdmission = { actorAccountId: 'bob', custodianAccountId: 'alice', machineId: 'machine-a',
    installationId: 'installation-a', role: 'use' as const, encryptionMode: 'e2ee' as const };
  const authorization = { kind: 'localServices.preview.admission.serverOrigin' as const };
  let current = true;
  let admittedWitness: unknown;
  const boundary = { machineId: 'machine-a', resolveCustodianAccountId: async () => 'alice',
    resolveInstallationId: () => 'installation-a', verifyMachineAdmission: async () => current };
  const rpc = new RpcHandlerManager({ scopePrefix: 'machine-a', encryptionKey: new Uint8Array(32).fill(7),
    encryptionVariant: 'dataKey', logger: () => {}, authorizeRequest: async request => {
      admittedWitness = request.machineAdmission;
      return authorizeMachineRpcRequest(request, boundary);
    } });
  const method = 'daemon.localServices.preview.admission';
  rpc.registerHandler(method, async (params: unknown, context?: RpcHandlerContext) => {
    const sameWitness = context?.machineAdmission === admittedWitness;
    const initiallyCurrent = await context?.verifyMachineAdmissionCurrent?.();
    await Promise.resolve();
    current = false;
    return { params, sameWitness, initiallyCurrent, currentAfterAwait: await context?.verifyMachineAdmissionCurrent?.() };
  });
  const params = { v: 1, kind: 'read', target: { kind: 'managed_service', machineId: 'machine-a', managedServiceId: 'web' } };
  expect(await rpc.handleRequest({ method: `machine-a:${method}`, params, authorization, machineAdmission }))
    .toEqual({ params, sameWitness: true, initiallyCurrent: true, currentAfterAwait: false });
});

it('refuses stamped current-service admission without Machine proof or a verifier', async () => {
  const authorization = { kind: 'localServices.preview.admission.serverOrigin' as const };
  const method = 'machine-a:daemon.localServices.preview.admission';
  const machineAdmission = { actorAccountId: 'bob', custodianAccountId: 'alice', machineId: 'machine-a',
    installationId: 'installation-a', role: 'use' as const, encryptionMode: 'plain' as const };
  const boundary = { machineId: 'machine-a', resolveCustodianAccountId: async () => 'alice',
    resolveInstallationId: () => 'installation-a', verifyMachineAdmission: async () => true };
  for (const authorizeRequest of [undefined, (request: Parameters<typeof authorizeMachineRpcRequest>[0]) => authorizeMachineRpcRequest(request, boundary)]) {
    const rpc = new RpcHandlerManager({ scopePrefix: 'machine-a', encryptionMode: 'plain', logger: () => {}, authorizeRequest });
    rpc.registerHandler('daemon.localServices.preview.admission', () => ({ kind: 'admitted' }));
    const request = { method, params: { v: 1, kind: 'read' }, authorization };
    expect(await rpc.handleRequest(request)).toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
    if (!authorizeRequest) expect(await rpc.handleRequest({ ...request, machineAdmission }))
      .toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
  }
});

it('keeps ordinary preview snapshots on the encrypted client transport', async () => {
  const key = new Uint8Array(32).fill(11);
  const rpc = new RpcHandlerManager({ scopePrefix: 'machine-a', encryptionKey: key, encryptionVariant: 'dataKey', logger: () => {} });
  rpc.registerHandler(RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_SNAPSHOT, () => ({ previews: [] }));
  const method = `machine-a:${RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_SNAPSHOT}`;
  expect(await openRpcResponse(key, await rpc.handleRequest({ method, params: await sealRpcRequest(key, method, {}) })))
    .toEqual({ previews: [] });
  expect(await openRpcResponse(key, await rpc.handleRequest({ method, params: {},
    authorization: { kind: 'localServices.preview.admission.serverOrigin' as const } })))
    .toMatchObject({ errorCode: RPC_ERROR_CODES.UPDATE_REQUIRED });
});

it('refuses current-service admission without a protected server origin before exposing the owner', async () => {
  const rpc = new RpcHandlerManager({ scopePrefix: 'machine-a', encryptionMode: 'plain', logger: () => {} });
  rpc.registerHandler('daemon.localServices.preview.admission', () => ({ kind: 'admitted' }));
  expect(await rpc.handleRequest({ method: 'machine-a:daemon.localServices.preview.admission',
    params: { v: 1, kind: 'read', target: { kind: 'managed_service', machineId: 'machine-a', managedServiceId: 'web' } } }))
    .toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
});

it('refuses Machine access-loss custody without a reserved server-origin stamp', async () => {
  const rpc = new RpcHandlerManager({ scopePrefix: 'machine-a', encryptionMode: 'plain', logger: () => {} });
  const cleanup = vi.fn(async () => ({ kind: 'settled' }));
  rpc.registerHandler('daemon.machineAccessLoss', cleanup);
  expect(await rpc.handleRequest({ method: 'machine-a:daemon.machineAccessLoss',
    params: { v: 1, subjectAccountId: 'bob' } })).toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
  expect(cleanup).not.toHaveBeenCalled();
});

it('rechecks the exact stamped Machine authority after asynchronous handler preparation', async () => {
  const machineAdmission = { actorAccountId: 'bob', custodianAccountId: 'alice', machineId: 'machine-a',
    installationId: 'installation-a', role: 'use' as const, encryptionMode: 'plain' as const };
  let current = true;
  const boundary = { machineId: machineAdmission.machineId,
    resolveCustodianAccountId: async () => 'alice', resolveInstallationId: () => 'installation-a',
    verifyMachineAdmission: async () => current };
  const rpc = new RpcHandlerManager({ scopePrefix: 'machine-a', encryptionMode: 'plain', logger: () => {},
    authorizeRequest: request => authorizeMachineRpcRequest(request, boundary) });
  rpc.registerHandler('prepare-effect', async (_params: unknown, context?: RpcHandlerContext) => {
    await Promise.resolve();
    current = false;
    return { effectAllowed: await context?.verifyMachineAdmissionCurrent?.() };
  });
  expect(await rpc.handleRequest({ method: 'machine-a:prepare-effect', params: {}, machineAdmission }))
    .toEqual({ effectAllowed: false });
});

it.each(['plain', 'e2ee'] as const)('does not disclose confidential continuation errors in %s responses or logs', async (mode) => {
  const secret = 'd26-recognizable-private-value';
  const logs: unknown[] = [];
  const key = new Uint8Array(32).fill(19);
  const rpc = new RpcHandlerManager({ scopePrefix: 'machine-a',
    ...(mode === 'plain' ? { encryptionMode: 'plain' as const } : { encryptionKey: key, encryptionVariant: 'dataKey' as const }),
    logger: (message, data) => logs.push({ message, data }) });
  const method = 'daemon.approval.request.secretContinue.v1';
  rpc.registerHandler(method, () => { throw new Error(`native input echoed ${secret}`); });
  const request = { method: `machine-a:${method}`, params: mode === 'plain'
    ? { choice: { kind: 'once', value: secret } }
    : await sealRpcRequest(key, `machine-a:${method}`, { choice: { kind: 'once', value: secret } }) };
  const response = await rpc.handleRequest(request);
  const opened = mode === 'plain' ? response : await openRpcResponse(key, response);
  expect(JSON.stringify({ opened, logs })).not.toContain(secret);
  expect(opened).toMatchObject({ errorCode: 'confidential_continuation_failed' });
});
function rpcContent(key: Uint8Array): SocketRpcContent {
  return { mode: 'e2ee', cipher: {
    encryptRaw: async value => encodeBase64(encrypt(key, 'dataKey', value)),
    decryptRaw: async value => decrypt(key, 'dataKey', decodeBase64(value)),
  } };
}
function sealRpcRequest(key: Uint8Array, method: string, value: unknown) {
  return socketRpcCodec.encodeParams(rpcContent(key), value, { method, callId: bindingCallId });
}
async function openRpcResponse(key: Uint8Array, value: unknown) {
  // Pre-admission refusals have no authenticated call id and cannot claim success.
  if (typeof value !== 'string') return value;
  return socketRpcCodec.decodeResult(rpcContent(key), { ok: true, result: value }, bindingCallId);
}

it('preserves a Home-stamped Session Action origin and rejects malformed or user-labelled origins', async () => {
  const rpc = new RpcHandlerManager({ scopePrefix: 'child', encryptionMode: 'plain', logger: () => {} });
  rpc.registerHandler('session.notes.set', (_input: unknown, context?: RpcHandlerContext) => ({
    authority: context?.callerAuthority, origin: context?.sessionActionOrigin,
  }));
  const origin = { v: 1 as const, caller: { kind: 'session' as const, sessionId: 'lead', starterDepth: 2, turnDepth: 3 },
    callerPermissionMode: 'default' as const, sourceTurnId: 'original-turn', requestId: 'original-request' };
  const request = { method: 'child:session.notes.set', params: { sessionId: 'child', notes: 'Notes' },
    callerAuthority: 'account_automation' as const, sessionActionOrigin: origin };
  expect(await rpc.handleRequest(request)).toEqual({ authority: 'account_automation', origin });
  for (const refused of [
    { ...request, callerAuthority: 'present_user' as const },
    { ...request, sessionActionOrigin: { ...origin, caller: { ...origin.caller, turnDepth: -1 } } },
    { ...request, method: 'child:session.message.send' },
  ]) expect(await rpc.handleRequest(refused)).toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
  const malformed = { ...request, sessionActionOrigin: { ...origin, caller: { kind: 'session' as const, sessionId: 'lead' } } };
  // @ts-expect-error The transport boundary must reject a Session origin without host-stamped depths.
  expect(await rpc.handleRequest(malformed)).toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
});

it('binds the Home-issued input proof to the exact opaque RPC before opening it', async () => {
  const encryptionKey = new Uint8Array(32).fill(17);
  const rpc = new RpcHandlerManager({ scopePrefix: 'session-a', localMachineId: 'machine-a',
    encryptionKey, encryptionVariant: 'dataKey', logger: () => {} });
  const effect = vi.fn(async (_input: unknown, context?: RpcHandlerContext) => ({
    proof: context?.callerInputAuthorization, constraints: context?.callerInputConstraints,
  }));
  rpc.registerHandler(SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND, effect);
  const target = { kind: 'session' as const, sessionId: 'session-a' };
  const request = { method: `session-a:${SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND}`,
    requestId: 'rpc-input-1', params: await sealRpcRequest(encryptionKey, `session-a:${SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND}`, { text: 'hello' }) };
  // The authenticated Home transport is the boundary here; downstream HTTP validates its signed token.
  const proof: ExternalActionExecutionAuthorizationV1 = { v: 1, token: 'home-issued-token', binding: {
    accountId: 'account-a', principalId: 'principal-a', credentialId: 'credential-a',
    serverIdentityId: 'server-a', machineId: 'machine-a', custodianAccountId: 'account-a',
    installationId: 'installation-a', actionId: 'session.message.send',
    requestId: request.requestId, target,
    grant: { ...API_TOKEN_FULL_GRANT_V1, permissionModes: ['read-only'] },
    requestEnvelopeDigest: computeExternalActionSocketRpcRequestDigestV1({ ...request, target }),
  } };
  const admitted = { ...request, callerInputAuthorization: proof,
    callerInputConstraints: { models: null, permissionModes: null } };
  expect(await openRpcResponse(encryptionKey, await rpc.handleRequest(admitted))).toEqual({
    proof, constraints: { models: null, permissionModes: ['read-only'] },
  });
  for (const refused of [
    { ...admitted, params: 'not-valid-ciphertext' },
    { ...admitted, requestId: 'rpc-input-2' },
    { ...admitted, callerInputAuthorization: { ...proof, binding: { ...proof.binding, target: { kind: 'session' as const, sessionId: 'session-b' } } } },
    { ...admitted, callerInputAuthorization: { ...proof, binding: { ...proof.binding, machineId: 'machine-b' } } },
    { ...admitted, callerInputAuthorization: { ...proof, binding: { ...proof.binding, actionId: 'session.goal.set' } } },
  ]) {
    expect(await openRpcResponse(encryptionKey, await rpc.handleRequest(refused)))
      .toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
  }
  expect(effect).toHaveBeenCalledOnce();
});

it('retains the Home-admitted original Session proof at exact Project Machine ingress', async () => {
  const machineAdmission = { actorAccountId: 'requester', custodianAccountId: 'custodian', machineId: 'target',
    installationId: 'target-install', role: 'use' as const, encryptionMode: 'plain' as const };
  const origin = { v: 1 as const, caller: { kind: 'session' as const, sessionId: 'source-session', starterDepth: 2, turnDepth: 3 },
    callerPermissionMode: 'default' as const, sourceTurnId: 'original-turn', requestId: 'original-request' };
  const proof: ExternalActionExecutionAuthorizationV1 = { v: 1, token: 'home-issued-token', binding: {
    accountId: 'requester', authentication: { kind: 'account', tokenEpoch: 1 }, serverIdentityId: 'home',
    machineId: 'target', custodianAccountId: 'custodian', installationId: 'target-install', actionId: 'projects.open',
    requestId: origin.requestId, requestEnvelopeDigest: 'a'.repeat(43), target: { kind: 'machine', machineId: 'target' },
    sessionActionOrigin: origin, sessionActionSource: { machineId: 'source', installationId: 'source-install' },
  } };
  const rpc = new RpcHandlerManager({ scopePrefix: 'target', localMachineId: 'target', encryptionMode: 'plain',
    authorizeRequest: async () => ({ ok: true }), logger: () => {} });
  const effect = vi.fn(async (_input: unknown, context?: RpcHandlerContext) => ({ proof: context?.callerInputAuthorization,
    origin: context?.sessionActionOrigin, authority: context?.callerAuthority }));
  rpc.registerHandler(RPC_METHODS.PROJECTS_OPEN, effect);
  // The authenticated Home is the mocked transport boundary. Its relay correlation is distinct from original Action identity.
  const request = { method: `target:${RPC_METHODS.PROJECTS_OPEN}`, requestId: 'relay-correlation', params: {},
    machineAdmission, callerAuthority: 'account_automation' as const, sessionActionOrigin: origin, callerInputAuthorization: proof };
  expect(await rpc.handleRequest(request)).toEqual({ proof, origin, authority: 'account_automation' });
  for (const binding of [
    { ...proof.binding, accountId: 'other' }, { ...proof.binding, installationId: 'retired-install' },
    { ...proof.binding, actionId: 'projects.trust.list' },
    { ...proof.binding, sessionActionOrigin: { ...origin, sourceTurnId: 'other-turn' } },
  ]) expect(await rpc.handleRequest({ ...request, callerInputAuthorization: { ...proof, binding } }))
    .toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
  expect(effect).toHaveBeenCalledOnce();
});

it('rechecks Session transfer routing against the hosted namespace and decrypted init', async () => {
  const rpc = new RpcHandlerManager({ scopePrefix: 'session-a', encryptionMode: 'plain', logger: () => {} });
  const effect = vi.fn(async () => ({ success: true }));
  rpc.registerHandler(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT, effect);
  const transferRouting = { method: RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT, t: 'session_attachment_upload_v1' as const, sessionId: 'session-a' };
  const request = { method: `session-a:${transferRouting.method}`, transferRouting,
    params: { t: transferRouting.t, sessionId: 'session-a', fileName: 'notes.txt' } };
  expect(await rpc.handleRequest(request)).toEqual({ success: true });
  for (const refused of [
    { ...request, transferRouting: { ...transferRouting, sessionId: 'session-b' } },
    { ...request, params: { ...request.params, sessionId: 'session-b' } },
    { ...request, params: { ...request.params, t: 'session_file_upload_v1' } },
  ]) {
    expect(await rpc.handleRequest(refused)).toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
  }
  expect(effect).toHaveBeenCalledOnce();
});

function createDeferredVoid(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

it('settles an admitted held reply with its captured cipher while new requests use the adopted cipher', async () => {
  const previousKey = new Uint8Array(32).fill(11);
  const currentKey = new Uint8Array(32).fill(29);
  const rpc = new RpcHandlerManager({ scopePrefix: 'machine', encryptionKey: previousKey,
    encryptionVariant: 'dataKey', logger: () => {} });
  const admitted = createDeferredVoid();
  const release = createDeferredVoid();
  let effects = 0;
  rpc.registerHandler('held', async () => { effects += 1; admitted.resolve(); await release.promise; return { effects }; });
  rpc.registerHandler('current', () => ({ key: 'current' }));
  const oldReply = rpc.handleRequest({ method: 'machine:held', params: await sealRpcRequest(previousKey, 'machine:held', {}) });
  await admitted.promise;
  rpc.retireEncryptionContext();
  expect(await rpc.handleRequest({ method: 'machine:held', params: await sealRpcRequest(previousKey, 'machine:held', {}) }))
    .toMatchObject({ errorCode: RPC_ERROR_CODES.UPDATE_REQUIRED });
  expect(effects).toBe(1);
  rpc.adoptEncryptionContext({ encryptionKey: currentKey, encryptionVariant: 'dataKey' });
  expect(await openRpcResponse(currentKey, await rpc.handleRequest({
    method: 'machine:current', params: await sealRpcRequest(currentKey, 'machine:current', {}),
  }))).toEqual({ key: 'current' });
  release.resolve();
  expect(await openRpcResponse(previousKey, await oldReply)).toEqual({ effects: 1 });
  expect(effects).toBe(1);
});

function createSocketEventBoundary(clientType?: 'machine-scoped' | 'session-scoped') {
  const handlers = new Map<string, Array<(payload: unknown) => void>>();
  const socket = {
    auth: { clientType },
    emit: vi.fn(),
    on: vi.fn((event: string, handler: (payload: unknown) => void) => {
      const current = handlers.get(event) ?? [];
      current.push(handler);
      handlers.set(event, current);
      return socket;
    }),
  };
  return {
    // Socket.IO is the system boundary under test; only its event surface is needed here.
    socket: socket as unknown as Socket,
    emit: socket.emit,
    trigger(event: string, payload: unknown) {
      for (const handler of handlers.get(event) ?? []) {
        handler(payload);
      }
    },
  };
}

describe('RpcHandlerManager registration receipts', () => {
  it.each(['machine-scoped', 'session-scoped'] as const)(
    'publishes only handlers owned by the %s socket across connect, late registration and replay',
    async (clientType) => {
      const rpc = new RpcHandlerManager({ scopePrefix: 'owner-1', encryptionMode: 'plain', logger: () => {} });
      const sessionMethods = [
        RPC_METHODS.SESSION_AGENT_TRANSITION,
        RPC_METHODS.SESSION_FORK,
        'execution.run.start',
        'execution.run.brokerAuthority.resolve.v1',
        'session.permission.respond',
        'session.user_action.answer',
        RPC_METHODS.TRANSCRIPT_PAGE,
        'session.unlisted',
        'managedServer.endpoint.unlisted',
        'abort',
      ];
      const machineMethods = [
        RPC_METHODS.BASH,
        RPC_METHODS.STOP_SESSION,
        RPC_METHODS.SESSION_SPAWN_NEW,
        RPC_METHODS.SPAWN_HAPPY_SESSION,
        RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT,
        RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT,
      ];
      const handler = async () => ({ ok: true });
      for (const method of [...machineMethods, ...sessionMethods.slice(0, -1)]) {
        rpc.registerHandler(method, handler);
      }
      const boundary = createSocketEventBoundary(clientType);
      const publishedMethods = () => boundary.emit.mock.calls
        .filter(([event]) => event === SOCKET_RPC_EVENTS.REGISTER)
        .map(([, payload]) => payload.method);
      const allowedMethods = clientType === 'machine-scoped'
        ? machineMethods : [...machineMethods, ...sessionMethods];
      const expected = allowedMethods.map((method) => `owner-1:${method}`).sort();

      rpc.onSocketConnect(boundary.socket);
      // Late registration takes a different publication path from initial connect.
      rpc.registerHandler('abort', handler);
      expect(publishedMethods().sort()).toEqual(expected);
      boundary.emit.mockClear();
      expect([...rpc.replayUnacknowledgedHandlerRegistrations()].sort()).toEqual([...allowedMethods].sort());
      expect(publishedMethods().sort()).toEqual(expected);
      boundary.emit.mockClear();
      rpc.onSocketDisconnect();
      rpc.onSocketConnect(boundary.socket);
      expect(publishedMethods().sort()).toEqual(expected);

      // Daemon Actions still consume local handlers, even when they cannot be published.
      expect(await rpc.invokeLocal('execution.run.start', {})).toEqual({ ok: true });
      expect(await rpc.invokeLocal(RPC_METHODS.SESSION_SPAWN_NEW, {})).toEqual({ ok: true });
    },
  );

  it('logs one safe correlated rejection after repeated reconnects and retries only recoverable registrations', () => {
    const logger = vi.fn();
    const rpc = new RpcHandlerManager({ scopePrefix: 'machine-1', encryptionMode: 'plain', logger });
    rpc.registerHandler('session.unlisted', () => null);
    rpc.registerHandler('daemon.connectedAccounts.control.command', () => null);
    const boundary = createSocketEventBoundary();
    for (let reconnect = 0; reconnect < 3; reconnect++) {
      rpc.onSocketConnect(boundary.socket);
      rpc.onSocketDisconnect();
    }
    rpc.onSocketConnect(boundary.socket);
    boundary.trigger(SOCKET_RPC_EVENTS.ERROR, {
      type: 'register', method: 'machine-1:session.unlisted',
      error: 'RPC method not available', retryable: false, secret: 'must-not-log',
    });
    expect(logger.mock.calls).toEqual([['[RPC] [ERROR] Handler registration rejected', {
      method: 'machine-1:session.unlisted', error: 'RPC method not available', retryable: false,
    }]]);
    boundary.trigger(SOCKET_RPC_EVENTS.ERROR, {
      type: 'register', method: 'machine-1:daemon.connectedAccounts.control.command',
      error: 'Machine unavailable', retryable: true,
    });
    expect(rpc.replayUnacknowledgedHandlerRegistrations()).toEqual(['daemon.connectedAccounts.control.command']);
    rpc.onSocketDisconnect();
    boundary.emit.mockClear();
    rpc.onSocketConnect(boundary.socket);
    expect(boundary.emit.mock.calls.map(([, payload]) => payload.method)).toEqual([
      'machine-1:session.unlisted', 'machine-1:daemon.connectedAccounts.control.command',
    ]);
    expect(rpc.replayUnacknowledgedHandlerRegistrations()).toEqual([
      'session.unlisted', 'daemon.connectedAccounts.control.command',
    ]);
    boundary.emit.mockClear();
    rpc.registerHandler('session.unlisted', () => null);
    expect(boundary.emit.mock.calls).toEqual([[SOCKET_RPC_EVENTS.REGISTER, { method: 'machine-1:session.unlisted' }]]);
    // An older relay has no retry classification; an uncorrelated refusal
    // cannot turn a legitimate registration into a permanent denial.
    boundary.trigger(SOCKET_RPC_EVENTS.ERROR, { type: 'register', error: 'Forbidden' });
    boundary.trigger(SOCKET_RPC_EVENTS.ERROR, { type: 'register', method: 'other:session.unlisted', retryable: false, error: 'secret response' });
    expect(JSON.stringify(logger.mock.calls)).not.toContain('secret response');
    rpc.onSocketDisconnect();
    boundary.emit.mockClear();
    rpc.onSocketConnect(boundary.socket);
    expect(boundary.emit.mock.calls.map(([, payload]) => payload.method)).toEqual([
      'machine-1:session.unlisted', 'machine-1:daemon.connectedAccounts.control.command',
    ]);
  });

  it('surfaces registration errors from only the active socket epoch', () => {
    const onRegistrationError = vi.fn();
    const config = {
      scopePrefix: 'machine-1',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'dataKey' as const,
      logger: () => {},
      onRegistrationError,
    };
    const rpc = new RpcHandlerManager(config);
    const first = createSocketEventBoundary();
    const second = createSocketEventBoundary();

    rpc.onSocketConnect(first.socket);
    first.trigger(SOCKET_RPC_EVENTS.ERROR, {
      type: 'register',
      error: 'client-upgrade-required',
      requirement: { v: 1 },
    });
    rpc.onSocketConnect(second.socket);
    first.trigger(SOCKET_RPC_EVENTS.ERROR, { type: 'register', error: 'stale-error' });
    second.trigger(SOCKET_RPC_EVENTS.ERROR, { type: 'unregister', error: 'not-a-registration-error' });

    expect(onRegistrationError).toHaveBeenCalledTimes(1);
    expect(onRegistrationError).toHaveBeenCalledWith({
      type: 'register',
      error: 'client-upgrade-required',
      requirement: { v: 1 },
    });
  });

  it('reports ready only after every required handler is acknowledged on the active socket', async () => {
    const rpc = new RpcHandlerManager({
      scopePrefix: 'machine-1',
      encryptionMode: 'plain',
      logger: () => {},
    });
    rpc.registerHandler('core.spawn', async () => ({ ok: true }));
    rpc.registerHandler('core.stop', async () => ({ ok: true }));
    rpc.registerHandler('optional.status', async () => ({ ok: true }));
    const boundary = createSocketEventBoundary();

    rpc.onSocketConnect(boundary.socket);
    const readiness = rpc.waitForRegisteredHandlers(
      ['core.spawn', 'core.stop'],
      { timeoutMs: 1_000 },
    );
    boundary.trigger(SOCKET_RPC_EVENTS.REGISTERED, { method: 'machine-1:optional.status' });
    boundary.trigger(SOCKET_RPC_EVENTS.REGISTERED, { method: 'machine-1:core.spawn' });

    let settled = false;
    void readiness.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    boundary.trigger(SOCKET_RPC_EVENTS.REGISTERED, { method: 'machine-1:core.stop' });
    await expect(readiness).resolves.toEqual({ status: 'ready' });
  });

  it('disconnects old waiters and ignores stale acknowledgements after reconnect', async () => {
    const rpc = new RpcHandlerManager({
      scopePrefix: 'machine-1',
      encryptionMode: 'plain',
      logger: () => {},
    });
    rpc.registerHandler('core.spawn', async () => ({ ok: true }));
    const first = createSocketEventBoundary();
    const second = createSocketEventBoundary();

    rpc.onSocketConnect(first.socket);
    const firstReadiness = rpc.waitForRegisteredHandlers(['core.spawn'], { timeoutMs: 1_000 });
    rpc.onSocketConnect(second.socket);
    const secondReadiness = rpc.waitForRegisteredHandlers(['core.spawn'], { timeoutMs: 1_000 });

    first.trigger(SOCKET_RPC_EVENTS.REGISTERED, { method: 'machine-1:core.spawn' });
    await expect(firstReadiness).resolves.toEqual({
      status: 'disconnected',
      missingMethods: ['core.spawn'],
    });

    let secondSettled = false;
    void secondReadiness.then(() => {
      secondSettled = true;
    });
    await Promise.resolve();
    expect(secondSettled).toBe(false);

    second.trigger(SOCKET_RPC_EVENTS.REGISTERED, { method: 'machine-1:core.spawn' });
    await expect(secondReadiness).resolves.toEqual({ status: 'ready' });
  });

  it('returns the exact missing handlers when the readiness deadline expires', async () => {
    vi.useFakeTimers();
    try {
      const rpc = new RpcHandlerManager({
        scopePrefix: 'machine-1',
        encryptionMode: 'plain',
        logger: () => {},
      });
      rpc.registerHandler('core.spawn', async () => ({ ok: true }));
      rpc.registerHandler('core.stop', async () => ({ ok: true }));
      const boundary = createSocketEventBoundary();
      rpc.onSocketConnect(boundary.socket);

      const readiness = rpc.waitForRegisteredHandlers(
        ['core.spawn', 'core.stop'],
        { timeoutMs: 50 },
      );
      boundary.trigger(SOCKET_RPC_EVENTS.REGISTERED, { method: 'machine-1:core.spawn' });
      await vi.advanceTimersByTimeAsync(50);

      await expect(readiness).resolves.toEqual({
        status: 'timeout',
        missingMethods: ['core.stop'],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('replays every current unacknowledged handler when no subset is supplied', () => {
    const rpc = new RpcHandlerManager({
      scopePrefix: 'machine-1',
      encryptionMode: 'plain',
      logger: () => {},
    });
    rpc.registerHandler('core.spawn', async () => ({ ok: true }));
    rpc.registerHandler('optional.status', async () => ({ ok: true }));
    const boundary = createSocketEventBoundary();

    rpc.onSocketConnect(boundary.socket);
    boundary.trigger(SOCKET_RPC_EVENTS.REGISTERED, { method: 'machine-1:core.spawn' });
    boundary.emit.mockClear();

    expect(rpc.replayUnacknowledgedHandlerRegistrations()).toEqual(['optional.status']);
    expect(boundary.emit).toHaveBeenCalledTimes(1);
    expect(boundary.emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REGISTER, {
      method: 'machine-1:optional.status',
    });
  });
});

describe('RpcHandlerManager.invokeLocal', () => {
  it('invokes a registered handler without encryption', async () => {
    const rpc = new RpcHandlerManager({
      scopePrefix: 'sess_1',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'dataKey',
      logger: () => {},
    });

    rpc.registerHandler('demo.method', async (params: any) => {
      return { ok: true, echoed: params };
    });

    const res = await rpc.invokeLocal('demo.method', { a: 1 });
    expect(res).toEqual({ ok: true, echoed: { a: 1 } });
  });

  it('returns a method-not-found error shape when handler is missing', async () => {
    const rpc = new RpcHandlerManager({
      scopePrefix: 'sess_1',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'dataKey',
      logger: () => {},
    });

    const res = await rpc.invokeLocal('missing.method', {});
    expect(res).toEqual({ error: RPC_ERROR_MESSAGES.METHOD_NOT_FOUND, errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND });
  });

  it('passes a host-only active-turn context to a local handler', async () => {
    const rpc = new RpcHandlerManager({
      scopePrefix: 'sess_1',
      encryptionMode: 'plain',
      logger: () => {},
    });
    const causalPermissionAuthority = {
      kind: 'admittedSessionInputV1',
      admittedPermissionCeiling: 'default',
    } as const;

    rpc.registerHandler('demo.active-turn', async (_params, context) => context?.localActionContext ?? null);

    await expect(rpc.invokeLocal('demo.active-turn', {}, {
      localActionContext: {
        surface: 'agent',
        callerPermissionMode: 'yolo',
        causalPermissionAuthority,
      },
    })).resolves.toEqual({
      surface: 'agent',
      callerPermissionMode: 'yolo',
      causalPermissionAuthority,
    });
  });
});

describe('RpcHandlerManager.handleRequest (plaintext)', () => {
  it('passes plaintext params through and returns plaintext results', async () => {
    const rpc = new RpcHandlerManager({
      scopePrefix: 'sess_1',
      encryptionMode: 'plain',
      logger: () => {},
    });

    rpc.registerHandler('demo.method', async (params: any) => {
      return { ok: true, echoed: params };
    });

    const res = await rpc.handleRequest({ method: 'sess_1:demo.method', params: { a: 1 } });
    expect(res).toEqual({ ok: true, echoed: { a: 1 } });
  });

  it('retains structured error details when a plaintext handler throws', async () => {
    const logger = vi.fn();
    const rpc = new RpcHandlerManager({
      scopePrefix: 'sess_1',
      encryptionMode: 'plain',
      logger,
    });
    rpc.registerHandler('demo.failure', async () => {
      throw new Error('handler failed');
    });

    await expect(rpc.handleRequest({
      method: 'sess_1:demo.failure',
      params: {},
    })).resolves.toEqual({ error: 'handler failed' });

    const errorLog = logger.mock.calls.find(
      ([message]) => message === '[RPC] [ERROR] Error handling request',
    );
    expect(errorLog).toBeDefined();

    const serializedLogData = JSON.stringify(errorLog![1]);
    expect(serializedLogData).toContain('"name":"Error"');
    expect(serializedLogData).toContain('"message":"handler failed"');
    expect(serializedLogData).toContain('"stack":"Error: handler failed');
  });

  it('projects only explicit protocol RPC error codes into the plaintext response', async () => {
    const rpc = new RpcHandlerManager({
      scopePrefix: 'sess_1',
      encryptionMode: 'plain',
      logger: () => {},
    });
    rpc.registerHandler('demo.typedFailure', async () => {
      throw new RpcError('workspace root is unsafe', 'workspace_root_unsafe');
    });
    rpc.registerHandler('demo.filesystemFailure', async () => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    });

    await expect(rpc.handleRequest({
      method: 'sess_1:demo.typedFailure',
      params: {},
    })).resolves.toEqual({
      error: 'workspace root is unsafe',
      errorCode: 'workspace_root_unsafe',
    });
    await expect(rpc.handleRequest({
      method: 'sess_1:demo.filesystemFailure',
      params: {},
    })).resolves.toEqual({ error: 'permission denied' });
  });

  it.each(['plain', 'e2ee'] as const)('refuses an unavailable private continuation without disclosing its operand in %s replies or logs', async mode => {
    const value = 'PRIVATE-UNAVAILABLE-DAEMON-D26';
    const logs: unknown[] = [];
    const key = new Uint8Array(32).fill(19);
    const method = RPC_METHODS.APPROVAL_REQUEST_SECRET_CONTINUE;
    const params = { choice: { kind: 'once', value } };
    const rpc = new RpcHandlerManager({
      scopePrefix: 'sess_1',
      ...(mode === 'plain' ? { encryptionMode: 'plain' as const } : { encryptionKey: key, encryptionVariant: 'dataKey' as const }),
      logger: (message, data) => logs.push({ message, data }),
    });

    const res = await rpc.handleRequest({ method: `sess_1:${method}`,
      params: mode === 'plain' ? params : await sealRpcRequest(key, `sess_1:${method}`, params) });
    const opened = mode === 'plain' ? res : await openRpcResponse(key, res);
    expect(opened).toEqual({ error: RPC_ERROR_MESSAGES.METHOD_NOT_FOUND, errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND });
    expect(JSON.stringify({ res, opened, logs })).not.toContain(value);
    if (mode === 'e2ee') expect(typeof res).toBe('string');
  });

  it('passes a server-stamped permission actor to the transport handler but never fabricates one locally', async () => {
    const rpc = new RpcHandlerManager({
      scopePrefix: 'sess_1',
      encryptionMode: 'plain',
      logger: () => {},
    });
    const authorization = {
      kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_PERMISSION_RESPOND,
      sessionId: 'sess_1',
      actor: {
        kind: 'accountUser' as const,
        accountId: 'account-owner',
        relationship: 'owner' as const,
      },
    };

    rpc.registerHandler('demo.permission', async (_params, context) => context?.authorization ?? null);

    await expect(rpc.handleRequest({
      method: 'sess_1:demo.permission',
      params: {},
      authorization,
    })).resolves.toEqual(authorization);
    await expect(rpc.invokeLocal('demo.permission', {})).resolves.toBeNull();
  });
});

describe('RpcHandlerManager.handleRequest (encrypted)', () => {
  it('projects only validated server input constraints and refuses malformed constraints before dispatch', async () => {
    const encryptionKey = new Uint8Array(32).fill(26);
    const rpc = new RpcHandlerManager({ scopePrefix: 'sess_1', encryptionKey, encryptionVariant: 'dataKey', logger: () => {} });
    let executed = false;
    rpc.registerHandler('demo.constraints', async (_params, context) => {
      executed = true;
      return { constraints: context && 'callerInputConstraints' in context ? context.callerInputConstraints : null };
    });
    const params = await sealRpcRequest(encryptionKey, 'sess_1:demo.constraints', { callerInputConstraints: { models: null, permissionModes: null } });
    const decode = (result: unknown) => openRpcResponse(encryptionKey, result);
    const constraints = { models: null, permissionModes: ['read-only'] } as const;
    expect(await decode(await rpc.handleRequest({ method: 'sess_1:demo.constraints', params,
      callerInputConstraints: { ...constraints, permissionModes: [...constraints.permissionModes] },
    }))).toEqual({ constraints });
    expect(await decode(await rpc.handleRequest({ method: 'sess_1:demo.constraints', params }))).toEqual({ constraints: null });
    executed = false;
    expect(await decode(await rpc.handleRequest({ method: 'sess_1:demo.constraints', params,
      callerInputConstraints: { models: null, permissionModes: ['invalid'] },
    } as unknown as Parameters<typeof rpc.handleRequest>[0]))).toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
    expect(executed).toBe(false);
  });

  it('uses only the server authority stamp and defaults unstamped requests to automation', async () => {
    const encryptionKey = new Uint8Array(32).fill(27);
    const rpc = new RpcHandlerManager({
      scopePrefix: 'sess_1', encryptionKey, encryptionVariant: 'dataKey', logger: () => {},
    });
    rpc.registerHandler('demo.authority', async (_params, context) => ({ authority: context?.callerAuthority }));
    const params = await sealRpcRequest(encryptionKey, 'sess_1:demo.authority', { callerAuthority: 'present_user' });
    for (const callerAuthority of [undefined, 'account_automation', 'present_user'] as const) {
      const result = await rpc.handleRequest({ method: 'sess_1:demo.authority', params,
        ...(callerAuthority ? { callerAuthority } : {}),
      });
      expect(await openRpcResponse(encryptionKey, result as string)).toEqual({
        authority: callerAuthority ?? 'account_automation',
      });
    }
  });

  it('passes the reserved Session server-start envelope through raw only for its stamped server origin', async () => {
    const encryptionKey = new Uint8Array(32).fill(29);
    const rpc = new RpcHandlerManager({
      scopePrefix: 'machine-1',
      encryptionKey,
      encryptionVariant: 'dataKey',
      logger: () => {},
    });
    const serverOrigin = {
      kind: 'session.serverStart.serverOrigin',
    } as const;
    const rawEnvelope = {
      v: 1,
      kind: 'session.serverStart.dispatch',
      target: { accountId: 'account-1', machineId: 'machine-1', machineInstallationId: 'installation-1' },
      start: {
        automationId: 'automation-1',
        runId: 'run-1',
        attempt: 3,
        claimedByMachineId: 'machine-source',
        cause: { kind: 'manual', invokedAt: 1 },
        accountCurrentness: { mode: 'plain', version: 7, contentKeyFingerprint: null },
        requestEnvelope: { t: 'plain', v: { opaque: true } },
      },
    };
    const rawResult = { type: 'error', code: 'target_unavailable', retryable: true };
    const handler = vi.fn(async (params: unknown, context) => {
      expect(params).toEqual(rawEnvelope);
      expect(context?.authorization).toEqual(serverOrigin);
      return rawResult;
    });
    rpc.registerHandler('daemon.sessions.serverStart.dispatch', handler);

    await expect(rpc.handleRequest({
      method: 'machine-1:daemon.sessions.serverStart.dispatch',
      params: rawEnvelope,
      authorization: serverOrigin,
    } as Parameters<typeof rpc.handleRequest>[0])).resolves.toEqual(rawResult);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('passes the reserved external Action envelope through raw only for its stamped server origin', async () => {
    const encryptionKey = new Uint8Array(32).fill(31);
    const rpc = new RpcHandlerManager({
      scopePrefix: 'machine-1',
      encryptionKey,
      encryptionVariant: 'dataKey',
      logger: () => {},
    });
    const serverOrigin = { kind: 'action.api.serverOrigin' } as const;
    const rawEnvelope = {
      actionId: 'session.get',
      envelope: { v: 1, target: { kind: 'machine', machineId: 'machine-1' }, input: {} },
      principal: {
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: 'credential-1',
        authority: 'account_automation',
      },
      placement: {
        machineId: 'machine-1',
        target: { kind: 'machine', machineId: 'machine-1' },
      },
    };
    const rawResult = {
      v: 1,
      actionId: 'session.get',
      execution: { ok: false, errorCode: 'target_not_local', error: 'target_not_local' },
    };
    const handler = vi.fn(async (params: unknown, context) => {
      expect(params).toEqual(rawEnvelope);
      expect(context?.authorization).toEqual(serverOrigin);
      return rawResult;
    });
    rpc.registerHandler('daemon.actions.external.dispatch', handler);

    await expect(rpc.handleRequest({
      method: 'machine-1:daemon.actions.external.dispatch',
      params: rawEnvelope,
      authorization: serverOrigin,
    } as Parameters<typeof rpc.handleRequest>[0])).resolves.toEqual(rawResult);

    const missingOrigin = await rpc.handleRequest({
      method: 'machine-1:daemon.actions.external.dispatch',
      params: rawEnvelope,
    } as Parameters<typeof rpc.handleRequest>[0]);
    expect(missingOrigin).toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
    expect(await openRpcResponse(encryptionKey, missingOrigin as string)).toEqual({
      error: RPC_ERROR_MESSAGES.FORBIDDEN,
      errorCode: RPC_ERROR_CODES.FORBIDDEN,
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('passes the reserved Automation reply-handoff envelope through raw only for the stamped server origin', async () => {
    const encryptionKey = new Uint8Array(32).fill(17);
    const rpc = new RpcHandlerManager({
      scopePrefix: 'machine-1',
      encryptionKey,
      encryptionVariant: 'dataKey',
      logger: () => {},
    });
    const serverOrigin = {
      kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.AUTOMATION_REPLY_HANDOFF_SERVER_ORIGIN,
    } as const;
    const rawEnvelope = {
      v: 1,
      kind: 'automation.replyHandoff.dispatch',
      handoffId: 'handoff-1',
    };
    const rawResult = { kind: 'settled', settlement: { kind: 'accepted' } };
    const handler = vi.fn(async (params: unknown, context) => {
      expect(params).toEqual(rawEnvelope);
      expect(context?.authorization).toEqual(serverOrigin);
      return rawResult;
    });
    rpc.registerHandler(AUTOMATION_REPLY_HANDOFF_DAEMON_RPC_METHOD_V1, handler);

    const response = await rpc.handleRequest({
      method: `machine-1:${AUTOMATION_REPLY_HANDOFF_DAEMON_RPC_METHOD_V1}`,
      params: rawEnvelope,
      authorization: serverOrigin,
    } as Parameters<typeof rpc.handleRequest>[0]);

    expect(response).toEqual(rawResult);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('fails closed before the reserved handler when the server-origin stamp is absent or malformed', async () => {
    const encryptionKey = new Uint8Array(32).fill(19);
    const rpc = new RpcHandlerManager({
      scopePrefix: 'machine-1',
      encryptionKey,
      encryptionVariant: 'dataKey',
      logger: () => {},
    });
    const handler = vi.fn(async () => ({ kind: 'settled' }));
    rpc.registerHandler(AUTOMATION_REPLY_HANDOFF_DAEMON_RPC_METHOD_V1, handler);

    for (const authorization of [
      undefined,
      {
        kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.AUTOMATION_REPLY_HANDOFF_SERVER_ORIGIN,
        forged: true,
      },
    ]) {
      const response = await rpc.handleRequest({
        method: `machine-1:${AUTOMATION_REPLY_HANDOFF_DAEMON_RPC_METHOD_V1}`,
        params: { v: 1, kind: 'automation.replyHandoff.dispatch' },
        ...(authorization ? { authorization } : {}),
      } as Parameters<typeof rpc.handleRequest>[0]);

      expect(response).toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
      expect(await openRpcResponse(encryptionKey, response as string)).toEqual({
        error: RPC_ERROR_MESSAGES.FORBIDDEN,
        errorCode: RPC_ERROR_CODES.FORBIDDEN,
      });
    }

    expect(handler).not.toHaveBeenCalled();
  });

  it('keeps every other encrypted RPC encrypted even when it carries the Automation origin marker', async () => {
    const encryptionKey = new Uint8Array(32).fill(23);
    const rpc = new RpcHandlerManager({
      scopePrefix: 'machine-1',
      encryptionKey,
      encryptionVariant: 'dataKey',
      logger: () => {},
    });
    const handler = vi.fn(async () => ({ ok: true }));
    rpc.registerHandler('demo.other', handler);

    const response = await rpc.handleRequest({
      method: 'machine-1:demo.other',
      params: { raw: true },
      authorization: {
        kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.AUTOMATION_REPLY_HANDOFF_SERVER_ORIGIN,
      },
    } as Parameters<typeof rpc.handleRequest>[0]);

    expect(handler).not.toHaveBeenCalled();
    expect(response).toMatchObject({ errorCode: RPC_ERROR_CODES.UPDATE_REQUIRED });
  });

  it('wraps an encrypted result with only the requested projected transport acknowledgement', async () => {
    const encryptionKey = new Uint8Array(32).fill(13);
    const rpc = new RpcHandlerManager({
      scopePrefix: 'machine_1',
      encryptionKey,
      encryptionVariant: 'dataKey',
      logger: () => {},
      projectTransportAcknowledgement: ({ method, result }) => (
        method === 'machine_1:demo.stop'
        && result
        && typeof result === 'object'
        && (result as { status?: unknown }).status === 'stopped'
          ? { kind: 'session.stop', status: 'stopped' }
          : null
      ),
    } as ConstructorParameters<typeof RpcHandlerManager>[0]);
    rpc.registerHandler('demo.stop', async () => ({ status: 'stopped' }));

    const response = await rpc.handleRequest({
      method: 'machine_1:demo.stop',
      params: await sealRpcRequest(encryptionKey, 'machine_1:demo.stop', { sessionId: 'sess_1' }),
      transportResponseEnvelopeVersion: 1,
    } as Parameters<typeof rpc.handleRequest>[0]);

    expect(response).toMatchObject({
      v: 1,
      acknowledgement: {
        kind: 'session.stop',
        status: 'stopped',
      },
    });
    const encryptedResult = (response as { result: unknown }).result;
    expect(typeof encryptedResult).toBe('string');
    expect(
      await openRpcResponse(encryptionKey, encryptedResult as string),
    ).toEqual({ status: 'stopped' });
  });

  it('rejects encrypted requests when the authorization hook rejects', async () => {
    const encryptionKey = new Uint8Array(32).fill(11);
    const rpc = new RpcHandlerManager({
      scopePrefix: 'machine_1',
      encryptionKey,
      encryptionVariant: 'dataKey',
      authorizeRequest: async ({ method, params, authorization, transportResponseEnvelopeVersion }) => {
        expect(method).toBe('machine_1:demo.secure');
        expect(params).toEqual({ sessionId: 'sess_1' });
        expect(authorization).toEqual({ kind: 'session.write', sessionId: 'sess_1' });
        expect(transportResponseEnvelopeVersion).toBe(1);
        return {
          ok: false,
          error: RPC_ERROR_MESSAGES.FORBIDDEN,
          errorCode: RPC_ERROR_CODES.FORBIDDEN,
        };
      },
      logger: () => {},
    });
    let handlerCalled = false;
    rpc.registerHandler('demo.secure', async () => {
      handlerCalled = true;
      return { ok: true };
    });

    const res = await rpc.handleRequest({
      method: 'machine_1:demo.secure',
      params: await sealRpcRequest(encryptionKey, 'machine_1:demo.secure', { sessionId: 'sess_1' }),
      authorization: { kind: 'session.write', sessionId: 'sess_1' },
      transportResponseEnvelopeVersion: 1,
    });

    expect(handlerCalled).toBe(false);
    expect(res).toMatchObject({ v: 1 });
    const encryptedResult = (res as { result: unknown }).result;
    expect(typeof encryptedResult).toBe('string');
    expect(await openRpcResponse(encryptionKey, encryptedResult as string)).toEqual({
      error: RPC_ERROR_MESSAGES.FORBIDDEN,
      errorCode: RPC_ERROR_CODES.FORBIDDEN,
    });
  });

  it('passes encrypted undefined params through to the handler', async () => {
    const encryptionKey = new Uint8Array(32).fill(7);
    const rpc = new RpcHandlerManager({
      scopePrefix: 'sess_1',
      encryptionKey,
      encryptionVariant: 'dataKey',
      logger: () => {},
    });

    rpc.registerHandler('demo.method', async (params: unknown) => {
      return { ok: true, sawUndefined: params === undefined };
    });

    const res = await rpc.handleRequest({
      method: 'sess_1:demo.method',
      params: await sealRpcRequest(encryptionKey, 'sess_1:demo.method', undefined),
    });

    expect(typeof res).toBe('string');
    expect(
      await openRpcResponse(encryptionKey, res as string),
    ).toEqual({ ok: true, sawUndefined: true });
  });

  it('preserves undefined handler results through encrypted responses', async () => {
    const encryptionKey = new Uint8Array(32).fill(9);
    const rpc = new RpcHandlerManager({
      scopePrefix: 'sess_1',
      encryptionKey,
      encryptionVariant: 'dataKey',
      logger: () => {},
    });

    rpc.registerHandler('demo.undefined', async () => undefined);

    const res = await rpc.handleRequest({
      method: 'sess_1:demo.undefined',
      params: await sealRpcRequest(encryptionKey, 'sess_1:demo.undefined', { ok: true }),
    });

    expect(typeof res).toBe('string');
    expect(
      await openRpcResponse(encryptionKey, res as string),
    ).toBeUndefined();
  });
});

describe('RpcHandlerManager in-flight request tracking', () => {
  it('exposes only safe method timing while the actual handler is executing', async () => {
    const authorizationStarted = createDeferredVoid();
    const handlerStarted = createDeferredVoid();
    let nowMs = 1_000;

    const rpc = new RpcHandlerManager({
      scopePrefix: 'machine-secret-scope',
      encryptionMode: 'plain',
      logger: () => {},
      nowMs: () => nowMs,
      authorizeRequest: async () => {
        await authorizationStarted.promise;
        return { ok: true };
      },
    });

    rpc.registerHandler('scm.status.snapshot', async () => {
      await handlerStarted.promise;
      return { secretPayload: 'must-not-appear-in-diagnostics' };
    });

    const requestPromise = rpc.handleRequest({
      method: 'machine-secret-scope:scm.status.snapshot',
      params: { secretInput: 'must-not-appear-in-diagnostics' },
    });
    await Promise.resolve();
    expect(rpc.getActiveHandlerExecutions()).toEqual([]);

    authorizationStarted.resolve();
    await vi.waitFor(() => expect(rpc.getActiveHandlerExecutions()).toHaveLength(1));
    nowMs = 2_250;
    expect(rpc.getActiveHandlerExecutions()).toEqual([
      {
        method: 'scm.status.snapshot',
        activeForMs: 1_250,
      },
    ]);

    handlerStarted.resolve();
    await requestPromise;
    expect(rpc.getActiveHandlerExecutions()).toEqual([]);
  });

  it('tracks local handler execution without changing the caller signal', async () => {
    const handlerStarted = createDeferredVoid();
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    let nowMs = 5_000;
    const rpc = new RpcHandlerManager({
      scopePrefix: 'machine-secret-scope',
      encryptionMode: 'plain',
      logger: () => {},
      nowMs: () => nowMs,
    });
    rpc.registerHandler('workspace.favicon.resolve', async (_params, context) => {
      observedSignal = context?.signal;
      await handlerStarted.promise;
      return null;
    });

    const requestPromise = rpc.invokeLocal('workspace.favicon.resolve', {}, {
      signal: controller.signal,
    });
    await Promise.resolve();
    nowMs = 5_400;

    expect(observedSignal).toBe(controller.signal);
    expect(rpc.getActiveHandlerExecutions()).toEqual([
      { method: 'workspace.favicon.resolve', activeForMs: 400 },
    ]);

    handlerStarted.resolve();
    await requestPromise;
    expect(rpc.getActiveHandlerExecutions()).toEqual([]);
  });

  it('waits for an active request to settle before reporting idle', async () => {
    const handlerStarted = createDeferredVoid();

    const rpc = new RpcHandlerManager({
      scopePrefix: 'sess_1',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'dataKey',
      encryptionMode: 'plain',
      logger: () => {},
    });

    rpc.registerHandler('demo.slow', async () => {
      await handlerStarted.promise;
      return { ok: true };
    });

    const requestPromise = rpc.handleRequest({ method: 'sess_1:demo.slow', params: {} });
    await Promise.resolve();

    let idleResolved = false;
    const idlePromise = rpc.waitForIdle().then(() => {
      idleResolved = true;
    });

    await Promise.resolve();
    expect(idleResolved).toBe(false);

    handlerStarted.resolve();
    await requestPromise;
    await idlePromise;

    expect(idleResolved).toBe(true);
  });

  it('waits for an active local invocation to settle before reporting idle', async () => {
    const handlerStarted = createDeferredVoid();

    const rpc = new RpcHandlerManager({
      scopePrefix: 'sess_1',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'dataKey',
      encryptionMode: 'plain',
      logger: () => {},
    });

    rpc.registerHandler('demo.slowLocal', async () => {
      await handlerStarted.promise;
      return { ok: true };
    });

    const requestPromise = rpc.invokeLocal('demo.slowLocal', {});
    await Promise.resolve();

    let idleResolved = false;
    const idlePromise = rpc.waitForIdle().then(() => {
      idleResolved = true;
    });

    await Promise.resolve();
    expect(idleResolved).toBe(false);

    handlerStarted.resolve();
    await requestPromise;
    await idlePromise;

    expect(idleResolved).toBe(true);
  });
});

describe('RpcHandlerManager request lifetime', () => {
  it('aborts only the exact request correlated by a server-relayed cancellation', async () => {
    const rpc = new RpcHandlerManager({
      scopePrefix: 'sess_1', encryptionKey: new Uint8Array(32), encryptionVariant: 'dataKey',
      encryptionMode: 'plain', logger: () => {},
    });
    const boundary = createSocketEventBoundary();
    let handlerStarts = 0;
    let secondSettled = false;
    rpc.registerHandler('demo.abort', (async (_request: unknown, context?: { signal: AbortSignal }) => {
      handlerStarts += 1;
      await new Promise<void>((resolve) => context?.signal.addEventListener('abort', () => resolve(), { once: true }));
      return { aborted: context?.signal.aborted === true };
    }) as Parameters<typeof rpc.registerHandler>[1]);
    rpc.onSocketConnect(boundary.socket);

    const first = rpc.handleRequest({
      method: 'sess_1:demo.abort', params: {}, requestId: 'relay-request-a',
    } as Parameters<typeof rpc.handleRequest>[0]);
    const second = rpc.handleRequest({
      method: 'sess_1:demo.abort', params: {}, requestId: 'relay-request-b',
    } as Parameters<typeof rpc.handleRequest>[0]).finally(() => {
      secondSettled = true;
    });
    await vi.waitFor(() => expect(handlerStarts).toBe(2));

    // This is emitted only by the authenticated server relay; the target owns
    // the mapping from its stamped request id to the active AbortController.
    boundary.trigger('rpc-cancel', { requestId: 'relay-request-a' });

    const firstSettled = await Promise.race([
      first.then(
        (value) => ({ status: 'resolved' as const, value }),
        (error: unknown) => ({ status: 'rejected' as const, error }),
      ),
      new Promise<{ status: 'pending' }>((resolve) => setTimeout(() => resolve({ status: 'pending' }), 50)),
    ]);
    expect(firstSettled).toEqual({ status: 'resolved', value: { aborted: true } });
    expect(secondSettled).toBe(false);

    boundary.trigger('rpc-cancel', { requestId: 'relay-request-b' });
    const secondSettledResult = await Promise.race([
      second.then(
        (value) => ({ status: 'resolved' as const, value }),
        (error: unknown) => ({ status: 'rejected' as const, error }),
      ),
      new Promise<{ status: 'pending' }>((resolve) => setTimeout(() => resolve({ status: 'pending' }), 50)),
    ]);
    expect(secondSettledResult).toEqual({ status: 'resolved', value: { aborted: true } });
  });

  it('aborts the central handler signal when the target transport disconnects', async () => {
    const rpc = new RpcHandlerManager({
      scopePrefix: 'sess_1', encryptionKey: new Uint8Array(32), encryptionVariant: 'dataKey',
      encryptionMode: 'plain', logger: () => {},
    });
    let handlerStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => { handlerStarted = resolve; });
    rpc.registerHandler('demo.abort', (async (_request: unknown, context?: { signal: AbortSignal }) => {
      if (!context) return { aborted: false };
      const aborted = new Promise<void>((resolve) => context.signal.addEventListener('abort', () => resolve(), { once: true }));
      handlerStarted();
      await aborted;
      return { aborted: context.signal.aborted };
    }) as Parameters<typeof rpc.registerHandler>[1]);

    const pending = rpc.handleRequest({ method: 'sess_1:demo.abort', params: {} });
    await started;
    rpc.onSocketDisconnect();

    await expect(pending).resolves.toEqual({ aborted: true });
  });

  it('aborts the central handler signal at the forwarded request timeout', async () => {
    const rpc = new RpcHandlerManager({
      scopePrefix: 'sess_1', encryptionKey: new Uint8Array(32), encryptionVariant: 'dataKey',
      encryptionMode: 'plain', logger: () => {},
    });
    rpc.registerHandler('demo.timeout', (async (_request: unknown, context?: { signal: AbortSignal }) => {
      if (!context) return { aborted: false };
      await new Promise<void>((resolve) => context.signal.addEventListener('abort', () => resolve(), { once: true }));
      return { aborted: context.signal.aborted };
    }) as Parameters<typeof rpc.registerHandler>[1]);

    await expect(rpc.handleRequest({
      method: 'sess_1:demo.timeout', params: {}, timeoutMs: 5,
    } as Parameters<typeof rpc.handleRequest>[0])).resolves.toEqual({ aborted: true });
  });

  it('preserves a long forwarded handler lifetime across the Node timer boundary', async () => {
    vi.useFakeTimers();
    const rpc = new RpcHandlerManager({ scopePrefix: 'machine-long', encryptionMode: 'plain', logger: () => {} });
    const timeoutMs = 30 * 24 * 60 * 60_000;
    let settled = false;
    rpc.registerHandler('demo.long', async (_request: unknown, context?: RpcHandlerContext) => {
      if (!context) return { aborted: false };
      await new Promise<void>((resolve) => context.signal.addEventListener('abort', () => resolve(), { once: true }));
      return { aborted: context.signal.aborted };
    });
    try {
      const waiting = rpc.handleRequest({ method: 'machine-long:demo.long', params: {}, timeoutMs })
        .then((result) => { settled = true; return result; });
      await vi.advanceTimersByTimeAsync(2_147_483_647);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(timeoutMs - 2_147_483_647);
      await expect(waiting).resolves.toEqual({ aborted: true });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      rpc.onSocketDisconnect();
      vi.useRealTimers();
    }
  });
});

describe('RpcHandlerManager owned handler replacement', () => {
  it('replaces one owner atomically while preserving unrelated handlers', async () => {
    const rpc = new RpcHandlerManager({
      scopePrefix: 'machine_1',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'dataKey',
      encryptionMode: 'plain',
      logger: () => {},
    });

    rpc.replaceOwnedHandlers('machine-surface', () => {
      rpc.registerHandler('owned.keep', async () => 'old');
      rpc.registerHandler('owned.stale', async () => 'stale');
    });
    rpc.registerHandler('external.keep', async () => 'external');

    const emit = vi.fn();
    (rpc as any).socket = { emit };
    rpc.replaceOwnedHandlers('machine-surface', () => {
      expect(rpc.hasHandler('owned.keep')).toBe(false);
      rpc.registerHandler('owned.keep', async () => 'new');
    });

    await expect(rpc.invokeLocal('owned.keep', {})).resolves.toBe('new');
    await expect(rpc.invokeLocal('owned.stale', {})).resolves.toMatchObject({
      errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND,
    });
    await expect(rpc.invokeLocal('external.keep', {})).resolves.toBe('external');
    expect(emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.UNREGISTER, {
      method: 'machine_1:owned.stale',
    });
  });
});
