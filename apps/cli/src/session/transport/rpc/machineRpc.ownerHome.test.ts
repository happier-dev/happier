import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { afterEach, describe, expect, it } from 'vitest';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { RPC_ERROR_CODES, RPC_ERROR_MESSAGES } from '@happier-dev/protocol/rpcErrors';

import type { ClientToServerEvents, ServerToClientEvents } from '@/api/types';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { callMachineRpc } from './machineRpc';
import nacl from 'tweetnacl';
import { projectRequesterAccountActionAuthorization } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { projectExternalActionRequesterHttpAuthorization } from '@/api/externalActionExecutionAuthorization';
import { ExternalActionExecutionAuthorizationV1Schema, ExternalActionRequestEnvelopeSchema, projectDeploymentPreparationAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { SESSION_AGENT_READINESS_CHILDREN_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { getActionSpec, projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import { sealExternalActionRequestV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { readRequesterAccountActionContext, rebindRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { createHostReviewedChildPortV1, invokeHostReviewedChildV1 } from '@happier-dev/protocol/actions/executor/deploymentRoleChild';
import { BACKUP_RECEIVER_SETUP_CHILDREN_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { projectDeploymentNativeAdmissionV1 } from '@happier-dev/protocol/deployments/deploymentCandidatePublicationV1';
import { createCliMachineActionTransport } from '@/session/actions/cliActionDeps/machineTransport';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { socketRpcCodec, type SocketRpcContent } from '@happier-dev/sync-client';
import { createMachineContentCodec } from '@/api/machine/machineStoredContent';
import { MachineSetupApplyInputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';

const homes: Array<Readonly<{ close(): Promise<void> }>> = [];
afterEach(async () => { await Promise.all(homes.splice(0).map(home => home.close())); });

async function createHome(ownerToken: string | null, installationPublicKey?: string, secret?: Uint8Array, peerCustodian?: string,
  /** Home admits the reviewed receiver read; its credential is the server tests' concern (7ca17357b47). */ reviewedPeerRead = false) {
  const accountMode = secret ? 'e2ee' : 'plain';
  const codec = secret ? createMachineContentCodec({ encryptionKey: secret, encryptionVariant: 'legacy' }) : null;
  const content: SocketRpcContent = codec?.mode === 'e2ee' ? { mode: 'e2ee', cipher: {
    encryptRaw: async value => codec.encodeRpc(value), decryptRaw: async value => codec.decodeRpc(value),
  } } : { mode: 'plain' };
  const requests: Array<Readonly<{ path: string | undefined; authorization: string | undefined }>> = [];
  const calls: string[] = [];
  const socketTokens: unknown[] = [];
  const http = createServer((request, response) => {
    requests.push({ path: request.url, authorization: request.headers.authorization });
    response.setHeader('Content-Type', 'application/json');
    const signedReviewedRead = reviewedPeerRead && request.url === '/v1/machines/peer';
    if (signedReviewedRead) {
      response.end(JSON.stringify({ machine: { id: 'peer', installationId: 'peer-installation', installationPublicKey,
        access: { custodian: { accountId: peerCustodian, displayName: '' }, role: 'manage', resourceMode: accountMode, accessState: 'ready' },
        storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER } }));
    } else if (ownerToken === null || request.headers.authorization !== `Bearer ${ownerToken}`) {
      response.writeHead(401).end('{}');
    } else if (request.url === '/v1/account/encryption/currentness') {
      response.end(JSON.stringify({ mode: accountMode, version: 1, signingKeyFingerprint: null,
        contentKeyFingerprint: null, updatedAt: 1 }));
    } else if (request.url === '/v1/account/encryption') {
      response.end(JSON.stringify({ mode: accountMode, updatedAt: 1 }));
    } else if (request.url === '/v1/machines?includeRevoked=true') {
      response.end(JSON.stringify([{ id: 'old', replacedByMachineId: 'current' }, { id: 'current' }]));
    } else if (request.url === '/v1/machines/old' || request.url === '/v1/machines/current') {
      response.end(JSON.stringify({ machine: { id: request.url.endsWith('/old') ? 'old' : 'current',
        ...(installationPublicKey ? { installationId: 'installation', installationPublicKey } : {}),
        access: { custodian: { accountId: 'session-account', displayName: '' }, role: 'manage', resourceMode: accountMode, accessState: 'ready' },
        ...(secret ? { dataEncryptionKey: null } : { storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER }) } }));
    } else if (request.url === '/v1/machines/peer' && peerCustodian && installationPublicKey) {
      response.end(JSON.stringify({ machine: { id: 'peer', installationId: 'peer-installation', installationPublicKey,
        access: { custodian: { accountId: peerCustodian, displayName: '' }, role: 'manage', resourceMode: accountMode, accessState: 'ready' },
        storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER } }));
    } else { response.writeHead(404).end('{}'); }
  });
  const socketServer = new Server<ClientToServerEvents, ServerToClientEvents>(http, { path: '/v1/updates' });
  socketServer.use((socket, next) => {
    const token: unknown = socket.handshake.auth.token;
    socketTokens.push(token);
    next(ownerToken !== null && token === ownerToken ? undefined : new Error('Unauthorized fixture Account'));
  });
  socketServer.on('connection', socket => {
    socket.on(SOCKET_RPC_EVENTS.CALL, async (request, acknowledge) => {
      calls.push(request.method);
      const opened = await socketRpcCodec.decodeRequestParams(content, request.params, request.method);
      acknowledge(request.method === 'old:status'
        ? { ok: false, error: RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE, errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE }
        : { ok: true, result: await socketRpcCodec.encodeResponse(content, { status: 'running' }, opened.callId) });
    });
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture Home address');
  const home = { url: `http://127.0.0.1:${address.port}`, requests, calls, socketTokens,
    close: () => new Promise<void>(resolve => socketServer.close(() => resolve())) };
  homes.push(home);
  return home;
}

describe('Machine RPC replacement Home custody', () => {
  it('keeps an Apply nested opaque-preset Plan on the captured requester Home', async () => {
    const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'session-account' })).toString('base64url')}.signature`, encryption: null } as const;
    const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(23));
    const owner = await createHome(credentials.token, Buffer.from(keys.publicKey).toString('base64'));
    const focused = await createHome(null);
    // The same authenticated HTTP/socket boundary accepts this Account first.
    expect(await callMachineRpc({ credentials, serverUrl: owner.url, machineId: 'current', method: 'status', request: {} }))
      .toEqual({ status: 'running' });
    const target = { kind: 'machine' as const, machineId: 'current' };
    const input = MachineSetupApplyInputV1Schema.parse({ homeId: 'srv_setup_home', machineId: 'current', targets: [{
      homeId: 'srv_setup_home', machineId: 'current', desiredRevision: 1, recipePlans: [], exclusions: [], sources: [
        { kind: 'direct', setup: {} },
        { kind: 'accountPresetOpaque', presetId: 'saved', presetRevision: 1, setupRevision: 3, contentEncryptionMode: 'plain' },
      ],
    }] });
    const envelope = { v: 1 as const, requestId: 'setup-apply', target, input };
    const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-setup-root', binding: {
      accountId: 'session-account', custodianAccountId: 'session-account', authentication: { kind: 'account', tokenEpoch: 0 },
      accountEncryptionMode: 'plain', serverIdentityId: input.homeId, machineId: 'current', installationId: 'installation',
      actionId: 'machines.setup.apply', requestId: envelope.requestId, target,
      deploymentPreparationAdmission: projectDeploymentPreparationAdmissionV1('machines.setup.apply', input),
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
    } });
    const authorization = await projectRequesterAccountActionAuthorization({ authorization: root, serverIdentityId: input.homeId,
      bootstrap: { credentials, serverHttpBaseUrl: owner.url, isCurrent: async () => true,
        attribution: { accountId: 'session-account', serverId: input.homeId, machineId: 'current', installationId: 'installation' } } });
    if (!authorization) throw new Error('Expected admitted Setup requester custody');
    const transport = createCliMachineActionTransport({ credentials: { token: 'foreign-daemon', encryption: null },
      serverId: input.homeId, serverIdentityId: input.homeId, serverHttpBaseUrl: owner.url,
      externalActionMachineInstallationId: 'installation', externalActionMachineRequestPrivateKey: keys.secretKey });
    const reviewed = input.targets[0]!;
    const result = await runWithServerHttpBaseUrl(focused.url, () => transport.callMachineAction({ machineId: 'current',
      method: RPC_METHODS.MACHINE_SETUP_PLAN, exactMachine: true, effectActionId: 'machines.setup.plan',
      request: { homeId: input.homeId, machineId: 'current', sources: reviewed.sources, exclusions: reviewed.exclusions, mode: 'effects' },
      context: { surface: 'ui', authority: 'present_user', runtimeAccountId: 'session-account', serverId: input.homeId,
        externalActionExecutionAuthorization: authorization, externalActionTarget: target, originalActionEnvelope: envelope } }));
    expect(result).toEqual({ status: 'running' });
    expect(focused.requests).toEqual([]);
    expect(focused.socketTokens).toEqual([]);
    expect(owner.calls).toEqual(['current:status', `current:${RPC_METHODS.MACHINE_SETUP_PLAN}`]);
    expect(owner.socketTokens).toEqual([credentials.token, credentials.token]);
  });
  // A Setup Plan child carries the requester's sealed sign-in to its reviewed
  // target, whoever holds that Machine (owner ruling 2026-11-23).
  it.each([['own', 'session-account'], ['foreign', 'bob']] as const)('seals a Setup Plan child to its reviewed target Machine whoever holds it (%s peer)', async (_case, peerCustodian) => {
    const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'session-account' })).toString('base64url')}.signature`, encryption: null } as const;
    const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(23));
    const owner = await createHome(credentials.token, Buffer.from(keys.publicKey).toString('base64'), undefined, peerCustodian);
    const target = { kind: 'machine' as const, machineId: 'current' };
    const setup = (machineId: string) => ({ homeId: 'srv_setup_home', machineId, desiredRevision: 1, recipePlans: [], exclusions: [],
      sources: [{ kind: 'direct' as const, setup: {} }] });
    const input = MachineSetupApplyInputV1Schema.parse({ homeId: 'srv_setup_home', machineId: 'current',
      targets: [setup('current'), setup('peer')] });
    const envelope = ExternalActionRequestEnvelopeSchema.parse({ v: 1, requestId: 'setup-apply-peer', target, input });
    const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-setup-root', binding: {
      accountId: 'session-account', custodianAccountId: 'session-account', authentication: { kind: 'account', tokenEpoch: 0 },
      accountEncryptionMode: 'plain', serverIdentityId: input.homeId, machineId: 'current', installationId: 'installation',
      actionId: 'machines.setup.apply', requestId: envelope.requestId, target,
      deploymentPreparationAdmission: projectDeploymentPreparationAdmissionV1('machines.setup.apply', input),
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
    } });
    const authorization = await projectRequesterAccountActionAuthorization({ authorization: root, serverIdentityId: input.homeId,
      bootstrap: { credentials, serverHttpBaseUrl: owner.url, isCurrent: async () => true,
        attribution: { accountId: 'session-account', serverId: input.homeId, machineId: 'current', installationId: 'installation' } } });
    if (!authorization) throw new Error('Expected admitted Setup requester custody');
    const transport = createCliMachineActionTransport({ credentials: { token: 'foreign-daemon', encryption: null },
      serverId: input.homeId, serverIdentityId: input.homeId, serverHttpBaseUrl: owner.url,
      externalActionMachineInstallationId: 'installation', externalActionMachineRequestPrivateKey: keys.secretKey });
    const reviewed = input.targets[1]!;
    const result = runWithServerHttpBaseUrl(owner.url, () => transport.callMachineAction({ machineId: 'peer',
      method: RPC_METHODS.MACHINE_SETUP_PLAN, exactMachine: true, effectActionId: 'machines.setup.plan',
      request: { homeId: input.homeId, machineId: 'peer', sources: reviewed.sources, exclusions: reviewed.exclusions, mode: 'effects' },
      context: { surface: 'ui', authority: 'present_user', runtimeAccountId: 'session-account', serverId: input.homeId,
        externalActionExecutionAuthorization: authorization, externalActionTarget: target, originalActionEnvelope: envelope } }));
    await expect(result).resolves.toEqual({ status: 'running' });
    expect(owner.calls).toEqual([`peer:${RPC_METHODS.MACHINE_SETUP_PLAN}`]);
  });
  // A Backup configure root reaches only the receiver its own review named (owner ruling 2026-11-23: whoever holds it).
  it.each([['named', 'peer'], ['not named', 'elsewhere']] as const)('seals a Backup receiver Setup Plan child only to the receiver its review named (%s)', async (_case, receiverMachineId) => {
    const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'session-account' })).toString('base64url')}.signature`, encryption: null } as const;
    const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(23));
    const owner = await createHome(credentials.token, Buffer.from(keys.publicKey).toString('base64'), undefined, 'bob', true);
    const homeId = 'srv_backup_home';
    const target = { kind: 'machine' as const, machineId: 'current' };
    const rootInput = { serverId: homeId, environmentId: 'environment', expectedRevision: 3, intent: 'test' as const,
      destinationSetup: { kind: 'anotherMachine' as const, machineId: receiverMachineId, expectedInstallationId: 'peer-installation', receiverInputs: {} },
      configuration: { configRevision: 1, destinationRef: { pluginId: 'happier.backup.local', localId: 'open' }, occurrenceId: 'destination',
        config: { path: '/private/repository' }, credentialBindings: [],
        sources: [{ kind: 'dump' as const, sourceId: 'database', service: 'postgres', consistency: 'logical' as const }],
        ownership: { environmentId: 'environment', prefix: 'owner-prefix' }, retention: { kind: 'keepEverything' as const } } };
    const envelope = { v: 1 as const, requestId: 'backup-configure', target, input: rootInput };
    const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-backup-root', binding: {
      accountId: 'session-account', custodianAccountId: 'session-account', authentication: { kind: 'account', tokenEpoch: 0 },
      accountEncryptionMode: 'plain', serverIdentityId: homeId, machineId: 'current', installationId: 'installation',
      actionId: 'deployments.backups.configure', requestId: envelope.requestId, target, environmentId: 'environment',
      deploymentNativeAdmission: projectDeploymentNativeAdmissionV1('deployments.backups.configure', rootInput),
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
    } });
    const authorization = await projectRequesterAccountActionAuthorization({ authorization: root, serverIdentityId: homeId,
      bootstrap: { credentials, serverHttpBaseUrl: owner.url, isCurrent: async () => true,
        attribution: { accountId: 'session-account', serverId: homeId, machineId: 'current', installationId: 'installation' } } });
    if (!authorization) throw new Error('Expected admitted Backup requester custody');
    const transport = createCliMachineActionTransport({ credentials: { token: 'foreign-daemon', encryption: null },
      serverId: homeId, serverIdentityId: homeId, serverHttpBaseUrl: owner.url,
      externalActionMachineInstallationId: 'installation', externalActionMachineRequestPrivateKey: keys.secretKey });
    const context = { surface: 'ui' as const, authority: 'present_user' as const, runtimeAccountId: 'session-account', serverId: homeId,
      externalActionExecutionAuthorization: authorization, externalActionTarget: target, originalActionEnvelope: envelope };
    // The host issuer's ordinary reviewed-child port produces the reviewed child; only Home is a boundary fixture.
    const declared = Object.values(BACKUP_RECEIVER_SETUP_CHILDREN_V1).map(child => ({ ...child, scopeInput: { homeId, machineId: 'peer' } }));
    const port = createHostReviewedChildPortV1({ actionId: 'deployments.backups.configure', input: rootInput, context,
      plan: { children: declared }, reviewAdmitted: true,
      policies: declared.map(child => ({ action: child.action, role: child.role, surface: 'ui' as const })),
      execute: async (input, childContext) => ({ ok: true, result: await runWithServerHttpBaseUrl(owner.url, () => transport.callMachineAction({
        machineId: 'peer', method: RPC_METHODS.MACHINE_SETUP_PLAN, exactMachine: true, effectActionId: 'machines.setup.plan',
        request: input, context: childContext })) }) });
    const result = port.invoke({ ...BACKUP_RECEIVER_SETUP_CHILDREN_V1.plan, input: { homeId, machineId: 'peer' } });
    if (receiverMachineId === 'peer') {
      await expect(result).resolves.toEqual({ ok: true, result: { status: 'running' } });
      expect(owner.calls).toEqual([`peer:${RPC_METHODS.MACHINE_SETUP_PLAN}`]);
    } else {
      // The issuer and the sender refuse a Machine the root's review did not name; nothing is dispatched.
      await expect(result).rejects.toBeDefined();
      expect(owner.calls).toEqual([]);
    }
  });
  it.each([
    { foreignRuntime: false, accountMode: 'plain' as const },
    { foreignRuntime: true, accountMode: 'plain' as const },
    { foreignRuntime: true, accountMode: 'e2ee' as const },
  ])('executes a reviewed Session readiness inventory with its original issuer Account custody ($accountMode, foreign runtime: $foreignRuntime)', async ({ foreignRuntime, accountMode }) => {
    const secret = new Uint8Array(32).fill(43);
    const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'session-account' })).toString('base64url')}.signature`, encryption: accountMode === 'plain' ? null : { type: 'legacy' as const, secret } };
    const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(23));
    const owner = await createHome(credentials.token, Buffer.from(keys.publicKey).toString('base64'), accountMode === 'e2ee' ? secret : undefined);
    // Same real loopback path supplies a known-good ordinary control first.
    expect(await callMachineRpc({ credentials, serverUrl: owner.url, machineId: 'current', method: 'status', request: {} }))
      .toEqual({ status: 'running' });
    const input = getActionSpec('session.spawn_new').inputSchema.parse({
      executionTarget: { serverId: 'srv_readiness_home', machineId: 'current' }, directory: { kind: 'path', path: '/project' },
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
      organizationPlacement: { sectionId: 'section', tagIds: [] },
    });
    const encryptionBinding = { serverIdentityId: 'srv_readiness_home', accountId: 'session-account', actionId: 'session.spawn_new' as const,
      authentication: { kind: 'account' as const, tokenEpoch: 0 }, requestId: 'session-spawn',
      target: { kind: 'machine' as const, machineId: 'current' } };
    const envelope = accountMode === 'plain'
      ? { v: 1 as const, requestId: encryptionBinding.requestId, target: encryptionBinding.target, input }
      : sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
        binding: encryptionBinding, input, material: { type: 'dataKey', machineKey: deriveAccountMachineKeyFromRecoverySecret(secret) },
        randomBytes: nacl.randomBytes });
    const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-root', binding: {
      accountId: 'session-account', custodianAccountId: 'session-account', authentication: { kind: 'account', tokenEpoch: 0 },
      accountEncryptionMode: accountMode, serverIdentityId: 'srv_readiness_home', machineId: 'current', installationId: 'installation',
      actionId: 'session.spawn_new', requestId: envelope.requestId, target: envelope.target,
      ...(envelope.v === 2 ? { machineRuntimeDemand: envelope.machineRuntimeDemand } : {}),
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
      sessionActionSource: { machineId: 'current', installationId: 'installation' },
      sessionActionOrigin: { v: 1, caller: { kind: 'session', sessionId: 'parent', starterDepth: 0, turnDepth: 0 },
        requestId: envelope.requestId, sourceTurnId: 'turn', callerPermissionMode: null },
    } });
    let live = true;
    const projected = await projectRequesterAccountActionAuthorization({ authorization: root, serverIdentityId: 'srv_readiness_home',
      bootstrap: { credentials, serverHttpBaseUrl: owner.url,
        attribution: { accountId: 'session-account', serverId: 'srv_readiness_home', machineId: 'current', installationId: 'installation' },
        getBoundSessionId: () => 'parent', isCurrent: async () => live } });
    if (!projected) throw new Error('Expected original Session Account projection');
    const rebound = rebindRequesterAccountActionContext(projected, projected);
    expect(readRequesterAccountActionContext(rebound)).toBeNull();
    const authorization = await projectExternalActionRequesterHttpAuthorization({ authorization: rebound,
      serverId: 'srv_readiness_home', serverIdentityId: 'srv_readiness_home', serverHttpBaseUrl: owner.url, target: envelope.target,
      installationId: 'installation', privateKey: keys.secretKey, rootAdmitted: true });
    if (!authorization) throw new Error('Expected original Home HTTP projection');
    const transport = createCliMachineActionTransport({ credentials: foreignRuntime ? { token: 'foreign-daemon', encryption: null } : credentials,
      serverId: 'srv_readiness_home', serverIdentityId: 'srv_readiness_home', serverHttpBaseUrl: owner.url,
      externalActionMachineInstallationId: 'installation', externalActionMachineRequestPrivateKey: keys.secretKey });
    const child = SESSION_AGENT_READINESS_CHILDREN_V1.inventory;
    const childInput = getActionSpec(child.action).inputSchema.parse({ machineId: 'current', serverId: 'srv_readiness_home', agentId: 'codex', refresh: true });
    const invoke = () => invokeHostReviewedChildV1({ parent: { actionId: 'session.spawn_new', input },
      context: { surface: 'agent', authority: 'account_automation', runtimeAccountId: 'session-account',
        externalActionExecutionAuthorization: authorization, externalActionTarget: envelope.target, originalActionEnvelope: envelope },
      reviewAdmitted: true, child: { action: child.action, role: child.role, input: childInput },
      execute: async (_input, context) => ({ ok: true, result: await runWithServerHttpBaseUrl(owner.url, () => transport.callMachineAction({
        machineId: 'current', method: RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE,
        request: { machineId: 'current', selection: 'agents' }, context, effectActionId: child.action })) }),
    });
    await expect(invoke()).resolves.toEqual({ ok: true, result: { status: 'running' } });
    expect(owner.socketTokens).toEqual([credentials.token, credentials.token]);
    expect(owner.calls).toEqual(['current:status', `current:${RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE}`]);
    expect(JSON.stringify(authorization)).not.toContain(credentials.token);
    live = false;
    await expect(invoke()).rejects.toMatchObject({ code: 'machine_target_not_current', reason: 'requester_not_current' });
    expect(owner.calls).toHaveLength(2);
  });
  it('keeps the replacement lookup and successful retry on the captured Home', async () => {
    const credentials = { token: 'captured-owner-account', encryption: null } as const;
    const owner = await createHome(credentials.token);
    const focused = await createHome(null);
    const result = await runWithServerHttpBaseUrl(focused.url, async () => await callMachineRpc({
      credentials, machineId: 'old', serverUrl: owner.url, method: 'status', request: { ping: true },
    }).catch((error: unknown) => error));

    expect(focused.requests).toEqual([]);
    expect(focused.socketTokens).toEqual([]);
    expect(result).toEqual({ status: 'running' });
    expect(owner.requests).toEqual(['/v1/machines/old', '/v1/machines?includeRevoked=true', '/v1/machines/current']
      .map(path => ({ path, authorization: `Bearer ${credentials.token}` })));
    expect(owner.calls).toEqual(['old:status', 'current:status']);
    expect(owner.socketTokens).toEqual([credentials.token, credentials.token]);
  });
});
