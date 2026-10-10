import { describe, expect, it, onTestFinished, vi } from 'vitest';
import tweetnacl from 'tweetnacl';
import axios, { AxiosHeaders } from 'axios';
import { socketRpcCodec } from '@happier-dev/sync-client';
import { MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent } from '@happier-dev/protocol/machines/machineStoredContent';
import { MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1, MachineUpdateOperationProtocolCapabilitiesRequestV1Schema,
  MachineUpdateOperationProtocolCapabilitiesResponseV1Schema } from '@happier-dev/protocol/machines/operationProtocolCapabilitiesV1';
import { verifyMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { SOCKET_RPC_EVENTS, WorkspaceSyncSourceRoutingV1Schema, WorkspaceSyncSourceWriterTargetRoutingV1Schema, WorkspaceSyncTargetRoutingV1Schema, type SessionActionRpcOriginV1, type WorkspaceSyncTargetRoutingV1 } from '@happier-dev/protocol/socketRpc';
import { HandoffTargetReplacementPreflightV1Schema, WorkspaceSyncHandoffSourcePhaseRequestV1Schema } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { authorizeMachineRpcRequest, verifyMachineRpcAdmissionCurrent } from '@/api/machine/machineRpcAuthorization';
import { buildActionExecutorContextForRpc } from '@/rpc/handlers/_actionDispatchAdapter';
import { createWorkspaceSyncTargetContent } from '@/api/rpc/workspaceSyncTargetContent';
import { configuration, reloadConfiguration } from '@/configuration';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { adoptServerProfileHomeConnectionDescriptor, setServerProfileEndpointsById } from '@/server/serverProfiles';
import { resolveCliHomeTarget } from '@/server/homeTarget';
import { composeBindChildSourcePhaseTestRuntime, composeInstalledBindTargetTransport } from '@/daemon/startup/createProductionDaemonWorkspaceSyncRuntime.testkit';
import { createTrackedSessionHandoffCoordinator } from '@/daemon/actionOperations/createTrackedSessionHandoffCoordinator';
import { registerMachineSessionHandoffRpcHandlers } from '@/api/machine/sessionHandoff/handlers';
import { V2SessionByIdResponseSchema } from '@happier-dev/protocol/sessions/control/contract';
import { createPlainSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { SessionHandoffStartRequestSchema } from '@happier-dev/protocol/sessions/control/handoff/handoffSchemas';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readStoredCredentials, writeCredentialsTokenOnlyForServerId } from '@/persistence';
import { AuthTokenProvenanceSchema } from '@happier-dev/protocol/auth/authToken';
import { resolveHomeTargetFromDescriptor } from '@happier-dev/cli-common/homeTarget';
import { registerMachineWorkspaceSyncRpcHandlers } from '@/api/machine/rpcHandlers.workspaceSync';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { getActiveProjectAccountRowsSnapshot, readProjectAccountRows } from '@/workspaces/projectAccountRows';
import { createProjectAccountRowCipherV1 } from '@happier-dev/protocol/projects/projectAccountRowCipherV1';
import { ProjectAccountRowV1Schema, ProjectAccountRowMutationRequestV1Schema, type ProjectAccountRowV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';

const { socketIo } = vi.hoisted(() => ({ socketIo: vi.fn() }));
vi.mock('socket.io-client', () => ({ io: socketIo }));

import {
  SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1,
  SessionInputAdmissionResultV1Schema,
  SessionPendingEnqueueByMachineRequestV1Schema,
  type SessionInputAdmissionResultV1,
  type SessionPendingEnqueueByMachineRequestV1,
  SessionPendingExecutionRunEnqueueByMachineRequestV2Schema,
  SESSION_PENDING_EXECUTION_RUN_ENQUEUE_BY_MACHINE_EVENT_V2,
  API_TOKEN_FULL_GRANT_V1,
  ExternalActionMachineRpcExecutionV1Schema,
  ExternalActionExecutionAuthorizationV1Schema,
  verifyExternalActionMachineRpcRequestV1,
  computeWorkspaceSyncPolicyDigest,
} from '@happier-dev/protocol';
import type { Machine } from '@/api/types';

import { ApiMachineClient } from './apiMachine';

const identityStore = vi.hoisted(() => ({ identity: null as import('@happier-dev/protocol').MachineInstallationIdentityV1 | null }));
const workspaceTransportHomeId = 'srv_api_workspace_transport_home';

function installWorkspaceHomeFeaturesBoundary(homeId: string): void {
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json({ features: {},
    capabilities: { serverIdentity: { serverIdentityId: homeId } } })));
}
// Installation key material is the OS boundary, not an alternate signer implementation.
vi.mock('@/daemon/identity/store', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/daemon/identity/store')>(),
  readInstallationIdentityIfExistsSync: () => identityStore.identity,
}));

function createMachine(): Machine {
  return {
    id: 'machine-1',
    encryptionKey: new Uint8Array(32).fill(1),
    encryptionVariant: 'legacy',
    metadata: null,
    metadataVersion: 0,
    daemonState: null,
    daemonStateVersion: 0,
  };
}

async function enqueueMachineAdmissionWithCancellation(
  client: ApiMachineClient,
  request: SessionPendingEnqueueByMachineRequestV1,
  signal: AbortSignal,
): Promise<SessionInputAdmissionResultV1> {
  return SessionInputAdmissionResultV1Schema.parse(await client.enqueueSessionPendingByMachine(
    request,
    { signal },
  ));
}

describe('ApiMachineClient machine admission transport', () => {
  it('emits source settlement only for its current installed Machine lifetime', async () => {
    const previousIdentity = identityStore.identity;
    const key = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
    identityStore.identity = { version: 1, installationId: '11111111-1111-4111-8111-111111111111', createdAt: 1,
      publicKey: Buffer.from(key.publicKey).toString('base64url'), privateKey: Buffer.from(key.secretKey).toString('base64url') };
    onTestFinished(() => { identityStore.identity = previousIdentity; });
    const client = new ApiMachineClient('daemon-token', createMachine());
    const socket = createApiSessionSocketStub({ connected: true });
    Reflect.set(client, 'socket', socket);
    const wakes = () => socket.emit.mock.calls.filter(([event]) => event === 'usage-sources-invalidated').map(([, payload]) => payload);
    client.emitUsageSourcesInvalidated();
    expect(wakes()).toEqual([{ type: 'usage-sources-invalidated', machineId: 'machine-1',
      installationId: '11111111-1111-4111-8111-111111111111' }]);
    socket.emit.mockClear();
    identityStore.identity = { ...identityStore.identity, installationId: '22222222-2222-4222-8222-222222222222' };
    client.emitUsageSourcesInvalidated();
    expect(wakes()).toEqual([]);
  });
  it.each(['matching V2 target', 'changed V2 target', 'ordinary matching V2 input', 'ordinary changed V2 input'] as const)(
    'checks the original encrypted Project target at actual chosen-child admission: %s', async variant => {
      installWorkspaceHomeFeaturesBoundary(workspaceTransportHomeId);
      onTestFinished(() => vi.unstubAllGlobals());
      const [project, encryption, signing, sourcePacket, execution, accountCipher] = await Promise.all([
        import('@happier-dev/protocol/projects/openProjectV1'), import('@happier-dev/protocol/actions/externalActionEncryption'),
        import('@happier-dev/protocol/actions/externalActionExecutionAuthorization'), import('@happier-dev/protocol/socketRpc'),
        import('@/api/externalActionExecutionAuthorization'), import('@/api/encryption'),
      ]);
      const ordinary = variant.startsWith('ordinary');
      const installed = tweetnacl.sign.keyPair();
      const writer = tweetnacl.sign.keyPair();
      const machineKey = new Uint8Array(32).fill(37);
      const previousIdentity = identityStore.identity;
      identityStore.identity = { version: 1, installationId: 'project-target-installation', createdAt: 1,
        publicKey: Buffer.from(installed.publicKey).toString('base64url'), privateKey: Buffer.from(installed.secretKey).toString('base64url') };
      onTestFinished(() => { identityStore.identity = previousIdentity; });
      const token = [Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
        Buffer.from(JSON.stringify({ sub: 'target-owner' })).toString('base64url'), 'fixture-signature'].join('.');
      const machineId = 'project-target';
      const originalPath = '/project/reviewed-target';
      const contentPolicy = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
      const input = project.OpenProjectInputV1Schema.parse({ serverId: workspaceTransportHomeId, machineId,
        source: { kind: 'workspace', workspaceId: 'actor-source-ref', checkout: { serverId: workspaceTransportHomeId,
          machineId: 'source-child', workspaceId: 'actor-source-ref', rootPath: '/source/workspace' } },
        materialization: { kind: 'sync', targetPath: originalPath, workspaceAction: { kind: 'copy_once',
          contentPolicy: { ...contentPolicy, policyDigest: computeWorkspaceSyncPolicyDigest(contentPolicy) } } } });
      const encryptionBinding = { serverIdentityId: workspaceTransportHomeId, accountId: 'borrower', credentialId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        actionId: 'projects.open', requestId: 'original-project-target-request', target: { kind: 'machine' as const, machineId } };
      const envelope = encryption.sealExternalActionRequestV2({ binding: encryptionBinding, input,
        material: { type: 'dataKey', machineKey }, randomBytes: tweetnacl.randomBytes });
      const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-issued-project-target-root', binding: {
        accountId: 'borrower', principalId: 'borrower', credentialId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', grant: API_TOKEN_FULL_GRANT_V1,
        custodianAccountId: 'target-owner', serverIdentityId: workspaceTransportHomeId, machineId,
        installationId: identityStore.identity.installationId, actionId: 'projects.open', requestId: envelope.requestId,
        requestEnvelopeDigest: signing.computeExternalActionRequestEnvelopeDigestV1(envelope), target: encryptionBinding.target } });
      const constraints = { models: null, permissionModes: null };
      const source = WorkspaceSyncSourceRoutingV1Schema.parse({ v: 1, phase: 'prepare', operationId: 'project-materialization',
        accountServerId: workspaceTransportHomeId, sourceMachineId: 'source-child', sourceRootPath: '/source/workspace',
        originalActionEnvelope: envelope, sourceContext: { machineAdmission: { actorAccountId: 'borrower',
          custodianAccountId: 'source-owner', machineId: 'source-child', installationId: 'source-installation', role: 'use', encryptionMode: 'e2ee' },
          callerAuthority: 'account_automation', callerInputConstraints: constraints, workspaceWrites: 'allow' } });
      const sourceMethod = `source-parent:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_MATERIALIZE_FOR_OPEN}`;
      const installedSourceContent = createWorkspaceSyncTargetContent({ destination: { machineId: 'source-parent',
        installationId: 'writer-installation', installationPublicKey: Buffer.from(writer.publicKey).toString('base64url') },
        method: sourceMethod, routing: source });
      const sealedParams = await socketRpcCodec.encodeParams(installedSourceContent, input,
        { method: sourceMethod, callId: 'a'.repeat(32) });
      const originalExecution = execution.createExternalActionMachineRpcExecution({ context: {
        externalActionExecutionAuthorization: root, externalActionTarget: root.binding.target }, effectActionId: 'projects.open',
        installationId: root.binding.installationId, method: sourceMethod, requestId: 'source-packet-request',
        params: sealedParams, workspaceSyncSourceRouting: source, privateKey: installed.secretKey });
      const packet = sourcePacket.WorkspaceSyncSourceExecutionV1Schema.parse({ method: sourceMethod,
        requestId: 'source-packet-request', params: sealedParams, externalActionExecution: originalExecution });
      const routing = WorkspaceSyncSourceWriterTargetRoutingV1Schema.parse({ v: 1,
        sourceWriter: { machineId: 'source-parent', installationId: 'writer-installation' }, source,
        target: { v: 1, phase: 'preflight', operationId: source.operationId, accountServerId: workspaceTransportHomeId,
          targetMachineId: machineId, targetRootPath: variant === 'matching V2 target' ? originalPath : '/project/changed-target' } });
      const admission = { actorAccountId: 'borrower', custodianAccountId: 'target-owner', machineId,
        installationId: root.binding.installationId, role: 'use' as const, encryptionMode: 'e2ee' as const };
      const unprefixedMethod = ordinary ? RPC_METHODS.PROJECTS_OPEN : RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT;
      const method = `${machineId}:${unprefixedMethod}`;
      const params = ordinary ? project.OpenProjectInputV1Schema.parse(variant === 'ordinary changed V2 input'
        ? { ...input, ref: 'substituted-ref' } : input)
        : HandoffTargetReplacementPreflightV1Schema.parse({ v: 1, operationId: source.operationId,
          serverId: workspaceTransportHomeId, machineId, targetPath: routing.target.targetRootPath });
      let packetVerifiedAtHome = false;
      const get = vi.spyOn(axios, 'get').mockImplementation(async url => {
        if (!String(url).endsWith('/account/profile')) throw new Error('Project target admission cannot read another Account graph');
        return { status: 200, data: { id: 'target-owner' } };
      });
      const post = vi.spyOn(axios, 'post').mockImplementation(async (url, raw) => {
        expect(String(url)).toBe(`https://project-target-home.invalid/v1/machines/${machineId}/admission/verify`);
        const body = raw as { context: typeof admission; method: string; proof: Parameters<typeof verifyMachineInstallationProof>[0]['proof'];
          callerInputAuthorization: typeof root; workspaceSyncSourceWriterTargetRouting: typeof routing; workspaceSyncSourceExecution?: typeof packet };
        expect(body.context).toEqual(admission);
        if (ordinary) {
          // Socket independently bound this Root to its exact envelope. The
          // ordinary receiver's incumbent Home proof authenticates D itself.
          expect(body).not.toHaveProperty('workspaceSyncSourceWriterTargetRouting');
          expect(verifyMachineInstallationProof({ publicKey: installed.publicKey, proof: body.proof, payload: { version: 1,
            machineId, installationId: admission.installationId, accountId: 'target-owner', rpcAdmission: { context: admission, method } } })).toBe(true);
          return { status: 200, data: { v: 1, ok: true } };
        }
        expect(body.callerInputAuthorization).toEqual(root);
        expect(body.workspaceSyncSourceWriterTargetRouting).toEqual(routing);
        expect(verifyMachineInstallationProof({ publicKey: installed.publicKey, proof: body.proof, payload: { version: 1,
          machineId, installationId: admission.installationId, accountId: 'target-owner', rpcAdmission: { context: admission,
            method, callerInputAuthorization: root, workspaceSyncSourceWriterTargetRouting: routing,
            ...(body.workspaceSyncSourceExecution ? { workspaceSyncSourceExecution: body.workspaceSyncSourceExecution } : {}) } } })).toBe(true);
        // The Home verifier cannot admit a Project relay without its original D packet.
        // Real Root issuance and current grants are exercised by the server suite.
        if (!body.workspaceSyncSourceExecution) return { status: 403, data: { error: 'access_denied' } };
        expect(body.workspaceSyncSourceExecution).toEqual(packet);
        expect(signing.verifyExternalActionMachineRpcRequestV1({ authorizationToken: root.token, effectActionId: 'projects.open',
          target: root.binding.target, installationId: admission.installationId, event: SOCKET_RPC_EVENTS.CALL,
          method: packet.method, requestId: packet.requestId, params: packet.params, workspaceSyncSourceRouting: source,
          publicKey: installed.publicKey, signature: packet.externalActionExecution.machineSignature })).toBe(true);
        packetVerifiedAtHome = true;
        return { status: 200, data: { v: 1, ok: true } };
      });
      onTestFinished(() => { get.mockRestore(); post.mockRestore(); });
      const client = runWithServerHttpBaseUrl('https://project-target-home.invalid', () => new ApiMachineClient(token, {
        ...createMachine(), id: machineId, encryptionMode: 'e2ee', encryptionKey: machineKey, encryptionVariant: 'dataKey' }));
      const rpc = Reflect.get(client, 'rpcHandlerManager');
      if (!(rpc instanceof RpcHandlerManager)) throw new Error('Actual Project target ingress is unavailable');
      let entered = false;
      rpc.registerHandler(unprefixedMethod, async () => {
        entered = true;
        return { type: 'not_required' };
      });
      const content = ordinary ? { mode: 'e2ee' as const, cipher: {
        encryptRaw: async (value: unknown) => accountCipher.encodeBase64(accountCipher.encrypt(machineKey, 'dataKey', value)),
        decryptRaw: async (value: string) => accountCipher.decrypt(machineKey, 'dataKey', accountCipher.decodeBase64(value)),
      } } : createWorkspaceSyncTargetContent({ destination: { machineId, installationId: admission.installationId,
        installationPublicKey: identityStore.identity.publicKey }, method, routing });
      const callId = 'b'.repeat(32);
      const reply = await rpc.handleRequest({ method, params: await socketRpcCodec.encodeParams(content, params, { method, callId }),
        machineAdmission: admission, callerAuthority: 'account_automation', callerInputConstraints: constraints,
        callerInputAuthorization: root, ...(ordinary ? { originalActionEnvelope: envelope }
          : { workspaceSyncSourceWriterTargetRouting: routing, workspaceSyncSourceExecution: packet }) });
      const result = await socketRpcCodec.decodeResult(content, { ok: true, result: reply }, callId);
      if (variant === 'matching V2 target' || variant === 'ordinary matching V2 input') {
        expect(result).toEqual({ type: 'not_required' });
        if (!ordinary) expect(packetVerifiedAtHome).toBe(true);
        expect(entered).toBe(true);
      } else {
        expect(result).toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
        expect(entered).toBe(false);
      }
    });

  it.each(['bind target', 'ordinary target', 'git worktree target', 'git worktree ordinary target'] as const)(
    'emits the original chosen-child Project packet to physical SOURCE without a Session or a Parent requester box: %s', async targetKind => {
    const { logger } = await import('@/ui/logger');
    // Retain the real logging sink while observing the canonical outer owner's
    // settlement diagnostics; no adapter or domain owner is intercepted.
    const settlementLog = vi.spyOn(logger, 'warnLocalFile');
    onTestFinished(() => settlementLog.mockRestore());
    const [projectRpc, projectProtocol, requester, execution, settings, executor, signing, headers, socketSchemas] = await Promise.all([
      import('@/rpc/handlers/projects/registerProjectOpenRpcHandlers'), import('@happier-dev/protocol/projects/openProjectV1'),
      import('@/daemon/sessionEncryption/requesterAccountActionProjection'), import('@/api/externalActionExecutionAuthorization'),
      import('@/settings/accountSettings/updateAccountSettingsV2WithRetry'), import('@/session/actions/createCliActionExecutorFromCredentials'),
      import('@happier-dev/protocol/actions/externalActionExecutionAuthorization'), import('@happier-dev/protocol/actions/externalActionApi'),
      import('@happier-dev/protocol/socketRpc'),
    ]);
    const targetKey = tweetnacl.sign.keyPair();
    const parentKey = tweetnacl.sign.keyPair();
    const priorIdentity = identityStore.identity;
    const installedIdentity = (installationId: string, key: typeof targetKey) => ({ version: 1 as const, installationId, createdAt: 1,
      publicKey: Buffer.from(key.publicKey).toString('base64url'), privateKey: Buffer.from(key.secretKey).toString('base64url') });
    const targetIdentity = installedIdentity('target-child-installation', targetKey);
    const parentIdentity = installedIdentity('parent-installation', parentKey);
    identityStore.identity = targetIdentity;
    onTestFinished(() => { identityStore.identity = priorIdentity; });
    let targetTransport: Awaited<ReturnType<typeof composeInstalledBindTargetTransport>> | undefined;
    let materialization: unknown;
    const actorCredentials = { token: [Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
      Buffer.from(JSON.stringify({ sub: 'project-owner' })).toString('base64url'), 'fixture-signature'].join('.'), encryption: null };
    const actorRows: ProjectAccountRowV1[] = [];
    const writerRows: ProjectAccountRowV1[] = [];
    let root: ReturnType<typeof ExternalActionExecutionAuthorizationV1Schema.parse>;
    let sourceReceiver: RpcHandlerManager | undefined;
    let chosenRequesterPrepared = false;
    let chosenRequesterEntered = false;
    let preparingChosenRequester = false;
    const requesterAdmissionReads: Array<{ method: 'GET' | 'POST'; path: string }> = [];
    let sourcePacketReceived = false;
    let sourceHomeVerified = false;
    const sourceDiagnostics: Array<{ message: string; method?: string; error?: string }> = [];
    const forbiddenParentReads: string[] = [];
    let custodianProjectRowMutationRequests = 0;
    const custodianMutationDiagnostics: Array<{ path: string; sourcePacketReceived: boolean; signedRequester: boolean;
      workspaces: Array<{ machineId: string; rootPath: string }> }> = [];
    const settingsContent = settings.prepareAccountSettingsV2Content({ credentials: actorCredentials, raw: {}, envelopeKind: 'plain' });
    const fixture = await composeBindChildSourcePhaseTestRuntime({ socketIo, separateTargetParent: true,
      ordinaryTarget: targetKind === 'ordinary target' || targetKind === 'git worktree ordinary target',
      gitWorktreeSeed: targetKind === 'git worktree target' || targetKind === 'git worktree ordinary target',
      withTargetChildRuntime: true, projectRowsFromHttp: true, targetCredentials: actorCredentials,
      callWorkspaceTargetPhase: async (descriptor, context) => {
        if (!targetTransport) throw new Error('The actual installed target transport is not ready');
        return await targetTransport.call(descriptor, context);
      },
      callWorkspaceSeedExport: async (descriptor, context) => {
        if (!targetTransport) throw new Error('The actual installed seed transport is not ready');
        return await targetTransport.callSeed(descriptor, context);
      },
      readAdditionalHttpResponse: async (url, config) => {
        if (preparingChosenRequester) requesterAdmissionReads.push({ method: 'GET', path: new URL(url).pathname });
        if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'project-owner' } };
        if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content: settingsContent, version: 1 } };
        if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: { mode: 'plain', version: 1,
          signingKeyFingerprint: null, contentKeyFingerprint: null, settingsVersion: 1, updatedAt: 1 } };
        const http = AxiosHeaders.from(config?.headers);
        if (url.endsWith('/machines/source-parent') && (http.has(headers.EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER)
          || http.get('Authorization') === `Bearer ${actorCredentials.token}`)) {
          forbiddenParentReads.push(url);
          throw Object.assign(new Error('machine_access_denied'), { response: { status: 403, data: { error: 'machine_access_denied' } } });
        }
        if (url.endsWith('/machines/source-child') && AxiosHeaders.from(config?.headers).has(headers.EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER)) {
          return { status: 200, data: { machine: { id: 'source-child', active: true, installationId: fixture.childInstallationId,
            devcontainerChild: fixture.projection, dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
            metadataVersion: 1, daemonStateVersion: 0, daemonState: null,
            access: { custodian: { accountId: 'owner', displayName: 'Source owner' }, role: 'use', resourceMode: 'plain', accessState: 'ready' },
            metadata: encodePlainMachineStoredContent({ host: 'source-child', platform: 'linux', homeDir: '/home/coder', username: 'coder',
              happyCliVersion: 'test', happyHomeDir: '/home/coder/.happier' }) } } };
        }
        return undefined;
      },
      readAdditionalHttpPostResponse: async (url, body, config) => {
        if (preparingChosenRequester) requesterAdmissionReads.push({ method: 'POST', path: new URL(url).pathname });
        if (url.includes('/v1/account/project-rows/')) {
          const http = AxiosHeaders.from(config?.headers);
          if (url.endsWith('/mutate') && http.get('Authorization') === `Bearer ${fixture.credentials.token}`) {
            custodianProjectRowMutationRequests += 1;
            const mutation = ProjectAccountRowMutationRequestV1Schema.parse(body);
            custodianMutationDiagnostics.push({ path: new URL(url).pathname, sourcePacketReceived,
              signedRequester: http.has(headers.EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER),
              workspaces: mutation.mutations.flatMap(row => {
                if (!row.content) return [];
                const value = cipher.open(row.key, row.content).value;
                return 'machineId' in value ? [{ machineId: value.machineId, rootPath: value.rootPath }] : [];
              }) });
          }
          if (!url.endsWith('/list')) throw new Error('This fixture observes physical materialization separately from public row acceptance');
          return { status: 200, data: { status: 'listed', coverage: 'complete', rows:
            http.get(headers.EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER) === root?.token
              || http.get('Authorization') === `Bearer ${actorCredentials.token}` ? actorRows : writerRows } };
        }
        const installed = await targetTransport?.homeResponse(url, body);
        if (installed) {
          if (url.includes('/machines/source-parent/') && body && typeof body === 'object'
            && 'workspaceSyncSourceRouting' in body) sourceHomeVerified = true;
          return installed;
        }
        if (url.endsWith('/projects.open/execution-authorization/verify')) {
          const http = AxiosHeaders.from(config?.headers);
          expect(signing.verifyExternalActionMachineRequestV1({ authorizationToken: root.token, effectActionId: 'projects.open',
            target: root.binding.target, installationId: fixture.targetChildInstallationId, requestId: root.binding.requestId, method: 'POST',
            path: new URL(url).pathname, body, publicKey: targetKey.publicKey,
            signature: String(http.get(headers.EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER)) })).toBe(true);
          return { status: 200, data: headers.ExternalActionExecutionAuthorizationVerifyResponseV1Schema.parse({ ok: true }) };
        }
        if (!url.endsWith('/admission/verify')) return undefined;
        const raw = body as { context: import('@happier-dev/protocol/socketRpc').SocketRpcMachineAdmissionContextV1;
          method: string; proof: Parameters<typeof verifyMachineInstallationProof>[0]['proof'];
          workspaceSyncSourceRouting?: import('@happier-dev/protocol/socketRpc').WorkspaceSyncSourceRoutingV1;
          workspaceSyncSourceExecution?: import('@happier-dev/protocol/socketRpc').WorkspaceSyncSourceExecutionV1;
          callerInputAuthorization?: typeof root };
        const parent = url.includes('/machines/source-parent/');
        expect(verifyMachineInstallationProof({ proof: raw.proof, publicKey: parent ? parentKey.publicKey : targetKey.publicKey,
          payload: { version: 1, machineId: parent ? 'source-parent' : 'target-child', accountId: parent ? 'owner' : 'project-owner',
            installationId: parent ? 'parent-installation' : 'target-child-installation', rpcAdmission: {
              context: raw.context, method: raw.method,
              ...(raw.workspaceSyncSourceRouting ? { workspaceSyncSourceRouting: raw.workspaceSyncSourceRouting } : {}),
              ...(raw.workspaceSyncSourceExecution ? { workspaceSyncSourceExecution: raw.workspaceSyncSourceExecution } : {}),
              ...(raw.callerInputAuthorization ? { callerInputAuthorization: raw.callerInputAuthorization } : {}),
            } } })).toBe(true);
        if (parent) {
          expect(raw.callerInputAuthorization).toEqual(root);
          expect(raw.workspaceSyncSourceExecution).toBeDefined();
          sourceHomeVerified = true;
        }
        // This is the already independently verified Home response boundary;
        // genuine original-D issuance and packet validation have their SQL suite.
        return { status: 200, data: { v: 1, ok: true, ...(!parent && raw.workspaceSyncSourceRouting ? {
          destinationInstallation: { machineId: 'source-parent', installationId: parentIdentity.installationId,
            installationPublicKey: parentIdentity.publicKey } } : {}) } };
      },
      handleAdditionalSocketAck: async raw => {
        if (!raw || typeof raw !== 'object' || !('method' in raw)
          || raw.method !== `source-parent:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_MATERIALIZE_FOR_OPEN}`) return undefined;
        if (!('workspaceSyncSourceRouting' in raw) || !('externalActionExecution' in raw)
          || !('requestId' in raw) || !('params' in raw)) {
          return { ok: false, error: 'Forbidden', errorCode: RPC_ERROR_CODES.FORBIDDEN };
        }
        const routing = WorkspaceSyncSourceRoutingV1Schema.parse(raw.workspaceSyncSourceRouting);
        const signed = ExternalActionMachineRpcExecutionV1Schema.parse(raw.externalActionExecution);
        expect(signed.authorization).toEqual(root);
        expect(signed.installationId).toBe('target-child-installation');
        expect(verifyExternalActionMachineRpcRequestV1({ authorizationToken: root.token, effectActionId: 'projects.open',
          target: root.binding.target, installationId: signed.installationId, event: SOCKET_RPC_EVENTS.CALL,
          method: raw.method, requestId: String(raw.requestId), params: raw.params, workspaceSyncSourceRouting: routing,
          publicKey: targetKey.publicKey, signature: signed.machineSignature })).toBe(true);
        expect(routing.originalActionEnvelope).toEqual(envelope);
        expect(routing).not.toHaveProperty('sourceSessionId');
        expect(routing.sourceMachineId).toBe('source-child');
        expect(routing.operationId).not.toBe(root.binding.requestId);
        expect(signed.authorization).not.toHaveProperty('requesterAccountContext');
        const packet = socketSchemas.WorkspaceSyncSourceExecutionV1Schema.parse({ method: raw.method,
          requestId: raw.requestId, params: raw.params, externalActionExecution: signed });
        sourcePacketReceived = true;
        if (!sourceReceiver || !routing.sourceContext) throw new Error('The actual physical SOURCE receiver is not ready');
        targetTransport = await composeInstalledBindTargetTransport(fixture, { operationId: routing.operationId,
          originalRoot: root, sourceRouting: routing, releaseReason: 'copy_committed',
          installedIdentities: new Map([['source-parent', parentIdentity], ['target-child', targetIdentity]]) });
        return await targetTransport.withInstalledMachine('source-parent', async () => {
          await runWithServerHttpBaseUrl('https://bind-child-home.invalid', () => readProjectAccountRows({
            credentials: fixture.credentials, serverId: fixture.serverId }));
          await fixture.settleProjects();
          try {
            return { ok: true, result: await sourceReceiver!.handleRequest({ ...raw, workspaceSyncSourceExecution: packet,
              machineAdmission: routing.sourceContext!.machineAdmission, callerAuthority: routing.sourceContext!.callerAuthority,
              callerInputAuthorization: root }) };
          } finally {
            await runWithServerHttpBaseUrl('https://bind-child-home.invalid', () => readProjectAccountRows({
              credentials: actorCredentials, serverId: fixture.serverId }));
            await fixture.settleProjects();
          }
        });
      } });
    const cipher = createProjectAccountRowCipherV1({ mode: 'plain', material: null, randomBytes: n => new Uint8Array(n) });
    for (const [rows, refs] of [[writerRows, [fixture.sourceRef]], [actorRows,
      [fixture.childRef, fixture.targetChildRef, fixture.targetRef]]] as const) {
      for (const ref of new Map(refs.map(ref => [ref.id, ref])).values()) {
        const key = { kind: 'workspace-ref' as const, serverId: fixture.serverId, id: ref.id };
        rows.push(ProjectAccountRowV1Schema.parse({ key, revision: 0, content: cipher.seal({ key, value: ref }) }));
      }
    }
    const input = projectProtocol.OpenProjectInputV1Schema.parse({ serverId: fixture.serverId, machineId: fixture.targetChildRef.machineId,
      source: { kind: 'workspace', workspaceId: fixture.childRef.id, checkout: { serverId: fixture.serverId,
        workspaceId: fixture.childRef.id, machineId: fixture.childRef.machineId, rootPath: fixture.childRef.rootPath } },
      materialization: { kind: 'sync', targetPath: fixture.targetChildRef.rootPath, workspaceAction: fixture.prepareInput.action } });
    const envelope = headers.ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: 'original-public-project-open',
      target: { kind: 'machine', machineId: fixture.targetChildRef.machineId }, input });
    root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-verified-original-project-root', binding: {
      accountId: 'project-owner', custodianAccountId: 'project-owner', authentication: { kind: 'account', tokenEpoch: 1 },
      accountEncryptionMode: 'plain', serverIdentityId: fixture.serverId, machineId: fixture.targetChildRef.machineId,
      installationId: fixture.targetChildInstallationId, actionId: 'projects.open', requestId: envelope.requestId,
      requestEnvelopeDigest: signing.computeExternalActionRequestEnvelopeDigestV1(envelope), target: envelope.target } });
    const publicMethod = `${fixture.targetChildRef.machineId}:${RPC_METHODS.PROJECTS_OPEN}`;
    const { sealExternalActionRequesterAccountContextV1 } = await import('@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1');
    const { encodeStoredCredentials } = await import('@/persistence');
    const sealed = sealExternalActionRequesterAccountContextV1({ authorization: root, credentials: encodeStoredCredentials(actorCredentials),
      purpose: { kind: 'machine_rpc', method: publicMethod, params: input }, installationPublicKey: targetKey.publicKey, randomBytes: tweetnacl.randomBytes });
    const makeReceiver = (machineId: string, installationId: string, key: typeof targetKey, credentials: typeof actorCredentials) =>
      new RpcHandlerManager({ scopePrefix: machineId, localMachineId: machineId, encryptionMode: 'plain', logger: (message, fields) => {
        if (machineId !== fixture.sourceRef.machineId) return;
        const value = fields && typeof fields === 'object' ? fields : {};
        const error = 'error' in value ? value.error : undefined;
        sourceDiagnostics.push({ message, ...('method' in value && typeof value.method === 'string' ? { method: value.method } : {}),
          ...(error instanceof Error ? { error: error.message } : {}) });
      },
        authorizeRequest: request => authorizeMachineRpcRequest(request, { machineId, resolveInstallationId: () => installationId,
          resolveCustodianAccountId: async () => machineId === fixture.sourceRef.machineId ? 'owner' : 'project-owner',
          verifyMachineAdmission: ({ callerInputAuthorization, ...admitted }) => verifyMachineRpcAdmissionCurrent({ ...admitted, privateKey: key.secretKey,
            daemonToken: credentials.token, serverHttpBaseUrl: 'https://bind-child-home.invalid',
            // Ordinary chosen-child ingress verifies its Root through the real
            // requester owner below, just as ApiMachine's admission callback.
            ...(admitted.workspaceSyncSourceRouting ? { workspaceSyncSourceReceiver: fixture.controller,
              ...(callerInputAuthorization ? { callerInputAuthorization } : {}) } : {}) }) }),
        prepareRequesterAccountContext: async args => {
          const chosen = machineId === fixture.targetChildRef.machineId;
          if (chosen) { chosenRequesterEntered = true; preparingChosenRequester = true; }
          try {
          const prepared = await requester.prepareRequesterAccountActionContext({ ...args,
          purpose: args.purpose ?? { kind: 'external_action' }, machineId, installationId, installationPrivateKey: key.secretKey,
          serverId: fixture.serverId, serverIdentityId: fixture.serverId, serverHttpBaseUrl: 'https://bind-child-home.invalid',
          ownCredentials: credentials, isCurrent: () => execution.verifyExternalActionExecutionAuthorizationCurrent({ authorization: root,
            effectActionId: 'projects.open', target: root.binding.target, installationId, privateKey: key.secretKey,
            serverHttpBaseUrl: 'https://bind-child-home.invalid' }),
          createExecutor: admitted => executor.createCliActionExecutorFromCredentials({ credentials: admitted.credentials,
            serverId: fixture.serverId, serverApiUrl: admitted.serverHttpBaseUrl, machineId,
            externalActionMachineInstallationId: installationId, externalActionMachineRequestPrivateKey: key.secretKey }),
          });
          if (chosen) chosenRequesterPrepared = prepared !== null;
          return prepared;
          } finally { if (chosen) preparingChosenRequester = false; }
        } });
    sourceReceiver = makeReceiver(fixture.sourceRef.machineId, fixture.controller.installationId, parentKey, fixture.credentials);
    const chosenTarget = makeReceiver(fixture.targetChildRef.machineId, fixture.targetChildInstallationId, targetKey, actorCredentials);
    const targetClient = runWithServerHttpBaseUrl('https://bind-child-home.invalid', () =>
      new ApiMachineClient(actorCredentials.token, { ...createMachine(), id: fixture.targetChildRef.machineId, encryptionMode: 'plain' }));
    const targetSocket = socketIo();
    Reflect.set(targetSocket, 'connected', true);
    Reflect.set(targetClient, 'socket', targetSocket);
    for (const [rpc, machineId, credentials, adapter] of [
      [sourceReceiver, fixture.sourceRef.machineId, fixture.credentials, fixture.parent.handoffAdapter],
      [chosenTarget, fixture.targetChildRef.machineId, actorCredentials, fixture.targetChild!.handoffAdapter],
    ] as const) projectRpc.registerProjectOpenRpcHandlers(rpc, { serverId: fixture.serverId, machineId, runtime: {
      serverId: fixture.serverId, machineId, serverHttpBaseUrl: 'https://bind-child-home.invalid',
      accountId: machineId === fixture.sourceRef.machineId ? 'owner' : 'project-owner', readCredentials: async () => credentials,
      workspaceSyncAdapter: adapter, requesterMachineRpcSigning: { installationId: machineId === fixture.sourceRef.machineId
        ? fixture.controller.installationId : fixture.targetChildInstallationId, privateKey: machineId === fixture.sourceRef.machineId
        ? parentKey.secretKey : targetKey.secretKey },
      ...(machineId === fixture.targetChildRef.machineId ? { callWorkspaceSource: async request => {
        materialization = await targetClient.callWorkspaceSyncProjectSource({ ...request, credentials: actorCredentials });
        return materialization;
      } } : {}),
    } });
    const response = await chosenTarget.handleRequest({ method: publicMethod, requestId: 'public-project-transport', params: input,
      originalActionEnvelope: envelope, callerInputAuthorization: sealed, callerAuthority: 'present_user', machineAdmission: { actorAccountId: 'project-owner',
        custodianAccountId: 'project-owner', machineId: fixture.targetChildRef.machineId, installationId: fixture.targetChildInstallationId,
        role: 'manage', encryptionMode: 'plain' } });
    expect(chosenRequesterPrepared, JSON.stringify({ response, forbiddenParentReads,
      chosenRequesterEntered, requesterAdmissionReads })).toBe(true);
    expect(sourcePacketReceived, JSON.stringify({ response, forbiddenParentReads })).toBe(true);
    expect(sourceHomeVerified).toBe(true);
    expect(custodianProjectRowMutationRequests, JSON.stringify({ response, sourceDiagnostics, custodianMutationDiagnostics,
      target: targetTransport?.observed.rpcDiagnostics })).toBe(0);
    expect(forbiddenParentReads, JSON.stringify({ response, sourceDiagnostics,
      phaseOutcomes: targetTransport?.observed.phaseOutcomes })).toEqual([]);
    expect(materialization, JSON.stringify({ response, sourceDiagnostics, target: targetTransport?.observed.rpcDiagnostics,
      phaseOutcomes: targetTransport?.observed.phaseOutcomes,
      settlementDiagnostics: settlementLog.mock.calls.filter(([message]) => message === '[Project Open] Source Sync settlement failed') })).toEqual({ kind: 'materialized' });
    expect(targetTransport?.observed.releaseReasons).toEqual(['copy_committed']);
    expect(await readFile(join(fixture.targetPath, 'payload.txt'), 'utf8')).toBe('before quiesce');
    for (const probe of [fixture.probeSource, fixture.probeTarget]) {
      const loan = await probe();
      expect(loan).not.toHaveProperty('kind');
      if (!('kind' in loan)) await loan.release();
    }
    expect(forbiddenParentReads).toEqual([]);
    expect(await readFile(join(fixture.sourcePath, 'payload.txt'), 'utf8')).toBe('before quiesce');
  });

  it.each(['owner Account', 'shared scoped PAT'] as const)(
    'uses the admitted physical SOURCE root without a borrower box and reaches the original chosen TARGET owner: %s', async rootKind => {
    const callerAuthority = rootKind === 'owner Account' ? 'present_user' as const : 'account_automation' as const;
    const actorAccountId = rootKind === 'owner Account' ? 'owner' : 'borrower';
    const callerInputConstraints = rootKind === 'shared scoped PAT' ? { models: null, permissionModes: null } : undefined;
    const childKey = tweetnacl.sign.keyPair();
    const parentKey = tweetnacl.sign.keyPair();
    const targetKey = tweetnacl.sign.keyPair();
    const priorIdentity = identityStore.identity;
    const childIdentity = { version: 1 as const, installationId: 'child-installation', createdAt: 1,
      publicKey: Buffer.from(childKey.publicKey).toString('base64url'), privateKey: Buffer.from(childKey.secretKey).toString('base64url') };
    const parentIdentity = { version: 1 as const, installationId: 'parent-installation', createdAt: 1,
      publicKey: Buffer.from(parentKey.publicKey).toString('base64url'), privateKey: Buffer.from(parentKey.secretKey).toString('base64url') };
    identityStore.identity = childIdentity;
    onTestFinished(() => { identityStore.identity = priorIdentity; });
    const rows: ProjectAccountRowV1[] = [];
    let chosenTargetReached = false;
    let physicalTargetFallback = false;
    let sourceResponse: unknown;
    let sourceHomeVerified = false;
    let sourceNativeInspected = false;
    let root: ReturnType<typeof ExternalActionExecutionAuthorizationV1Schema.parse>;
    let parentClient: ApiMachineClient | undefined;
    let parentCredentials: import('@/persistence').StoredCredentials | undefined;
    let parentTargetFailure: unknown;
    const transportBoundaries: Array<{ boundary: 'parent-api' | 'home' | 'socket'; method: string; path?: string; phase?: string }> = [];
    const fixture = await composeBindChildSourcePhaseTestRuntime({ socketIo, separateTargetParent: true, projectRowsFromHttp: true,
      callWorkspaceTargetPhase: async (descriptor, originalContext) => {
        if (!parentClient || !parentCredentials) throw new Error('The installed SOURCE writer fixture is not ready');
        transportBoundaries.push({ boundary: 'parent-api', method: descriptor.method, phase: descriptor.routing.phase });
        expect(identityStore.identity).toEqual(parentIdentity);
        try {
          return await parentClient.callWorkspaceSyncTargetPhase({ ...descriptor,
            credentials: parentCredentials,
            context: buildActionExecutorContextForRpc({ ...originalContext, serverId: root.binding.serverIdentityId }) });
        } catch (error) {
          parentTargetFailure = error;
          throw error;
        }
      },
      readAdditionalHttpPostResponse: async (url, raw) => {
        if (url.includes('/v1/account/project-rows/')) {
          if (url.endsWith('/list')) return { status: 200, data: { status: 'listed', coverage: 'complete', rows } };
          throw new Error('An unavailable chosen target must not mutate Project rows');
        }
        if (!url.endsWith('/admission/verify')) return undefined;
        const body = raw as { context: import('@happier-dev/protocol/socketRpc').SocketRpcMachineAdmissionContextV1;
          method: string; workspaceSyncSourceRouting?: import('@happier-dev/protocol/socketRpc').WorkspaceSyncSourceRoutingV1;
          workspaceSyncSourceWriterTargetRouting?: import('@happier-dev/protocol/socketRpc').WorkspaceSyncSourceWriterTargetRoutingV1;
          callerInputAuthorization?: typeof root; proof: Parameters<typeof verifyMachineInstallationProof>[0]['proof'] };
        transportBoundaries.push({ boundary: 'home', path: new URL(url).pathname, method: body.method,
          phase: body.workspaceSyncSourceWriterTargetRouting?.target.phase ?? body.workspaceSyncSourceRouting?.phase });
        const parentReceiver = url.includes('/machines/source-parent/');
        expect(verifyMachineInstallationProof({ payload: { version: 1,
          machineId: parentReceiver ? 'source-parent' : 'source-child',
          installationId: parentReceiver ? parentIdentity.installationId : childIdentity.installationId,
          accountId: 'owner', rpcAdmission: { context: body.context, method: body.method,
            ...(body.workspaceSyncSourceRouting ? { workspaceSyncSourceRouting: body.workspaceSyncSourceRouting } : {}),
            ...(body.workspaceSyncSourceWriterTargetRouting ? { workspaceSyncSourceWriterTargetRouting: body.workspaceSyncSourceWriterTargetRouting } : {}),
            ...(body.callerInputAuthorization ? { callerInputAuthorization: body.callerInputAuthorization } : {}) } },
          proof: body.proof, publicKey: parentReceiver ? parentKey.publicKey : childKey.publicKey })).toBe(true);
        if (parentReceiver) {
          expect(body.callerInputAuthorization).toEqual(root);
          if (body.workspaceSyncSourceRouting) {
            expect(body.workspaceSyncSourceRouting).toMatchObject({ sourceMachineId: 'source-child',
              sourceContext: { callerAuthority } });
            sourceHomeVerified = true;
          } else {
            expect(body.workspaceSyncSourceWriterTargetRouting).toMatchObject({ sourceWriter: {
              machineId: 'source-parent', installationId: parentIdentity.installationId },
              target: { targetMachineId: 'target-child', targetRootPath: '/target/custom' } });
          }
        }
        // The independently admitted Home response is a network vector. Genuine
        // Root issuance/currentness is exercised by the server owner suite.
        return { status: 200, data: { v: 1, ok: true,
          ...(body.workspaceSyncSourceWriterTargetRouting ? { destinationInstallation: { machineId: 'target-child',
            installationId: 'target-child-installation', installationPublicKey: Buffer.from(targetKey.publicKey).toString('base64url') } } : {}) } };
      },
      handleAdditionalSocketAck: async raw => {
        if (!raw || typeof raw !== 'object' || !('method' in raw) || typeof raw.method !== 'string') return undefined;
        transportBoundaries.push({ boundary: 'socket', method: raw.method });
        if (raw.method === 'source-parent:machines.managed.inspect' && 'params' in raw) {
          const decoded = await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, raw.params, raw.method);
          if (decoded.params && typeof decoded.params === 'object' && 'managedId' in decoded.params
            && decoded.params.managedId === 'managed-source-child') sourceNativeInspected = true;
          return undefined;
        }
        if (raw.method.startsWith('target-parent:') && !raw.method.endsWith('machines.managed.inspect')) {
          physicalTargetFallback = true;
          throw new Error('SOURCE custody cannot authorize an ambient physical TARGET call');
        }
        if (!raw.method.startsWith('target-child:') || raw.method.endsWith('machines.managed.inspect')) return undefined;
        const purpose = WorkspaceSyncSourceWriterTargetRoutingV1Schema.parse(
          'workspaceSyncSourceWriterTargetRouting' in raw ? raw.workspaceSyncSourceWriterTargetRouting : undefined);
        expect(purpose).toMatchObject({ sourceWriter: { machineId: 'source-parent', installationId: parentIdentity.installationId },
          source: { operationId: root.binding.requestId, sourceMachineId: 'source-child', sourceSessionId: 'source-session',
            sourceContext: { callerAuthority, machineAdmission: { actorAccountId } } },
          target: { operationId: root.binding.requestId, targetMachineId: 'target-child', targetRootPath: '/target/custom' } });
        if (purpose.target.phase === 'release') {
          expect(raw).not.toHaveProperty('externalActionExecution');
        } else {
          const execution = ExternalActionMachineRpcExecutionV1Schema.parse(
            'externalActionExecution' in raw ? raw.externalActionExecution : undefined);
          expect(execution.authorization).toEqual(root);
          chosenTargetReached = true;
        }
        return { ok: false, error: 'Method not found', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND };
      } });
    const cipher = createProjectAccountRowCipherV1({ mode: 'plain', material: null, randomBytes: n => new Uint8Array(n) });
    const logicalSourceRefId = rootKind === 'shared scoped PAT' ? 'borrower-logical-source-ref' : fixture.childRef.id;
    const logicalTargetRefId = 'actor-logical-target-ref';
    // P1's real Account graph contains only its existing physical source. C1's
    // native namespace is proven by current Home/installation/bind facts, not a
    // logical child row or borrower row id in the writer's graph. Neither D nor
    // P2 is present here; source custody cannot invent target membership rows.
    for (const value of [fixture.sourceRef]) {
      const key = { kind: 'workspace-ref' as const, serverId: fixture.serverId, id: value.id };
      rows.push(ProjectAccountRowV1Schema.parse({ key, revision: 0, content: cipher.seal({ key, value }) }));
    }
    const graphKey = { kind: 'relationship-graph' as const };
    rows.push(ProjectAccountRowV1Schema.parse({ key: graphKey, revision: 0,
      content: cipher.seal({ key: graphKey, value: { relationships: [] } }) }));
    await runWithServerHttpBaseUrl('https://bind-child-home.invalid', async () =>
      await readProjectAccountRows({ credentials: fixture.credentials, serverId: fixture.serverId }));
    expect(getActiveProjectAccountRowsSnapshot()?.workspaceRefs).toEqual([fixture.sourceRef]);
    const admission = { actorAccountId, custodianAccountId: 'owner', machineId: fixture.childRef.machineId,
      installationId: childIdentity.installationId, role: rootKind === 'owner Account' ? 'manage' as const : 'use' as const,
      encryptionMode: 'plain' as const };
    root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-issued-source-custody-root', binding: {
      accountId: actorAccountId, custodianAccountId: 'owner',
      ...(rootKind === 'owner Account' ? { authentication: { kind: 'account', tokenEpoch: 1 } } : {
        principalId: actorAccountId, credentialId: 'scoped-source-pat', grant: { ...API_TOKEN_FULL_GRANT_V1,
          actions: { families: [], ids: ['session.handoff'] },
          targets: { sessions: [], machines: [fixture.childRef.machineId, fixture.targetChildRef.machineId] } } }),
      serverIdentityId: fixture.serverId, machineId: admission.machineId, installationId: admission.installationId,
      actionId: 'session.handoff', requestId: 'source-custody-operation', requestEnvelopeDigest: 'A'.repeat(43),
      target: { kind: 'machine', machineId: admission.machineId }, handoffAdmission: { sessionId: 'source-session',
        sourceMachineId: admission.machineId, sourceInstallationId: admission.installationId,
        targetMachineId: fixture.targetChildRef.machineId, targetInstallationId: fixture.targetChildInstallationId } } });
    expect(root).not.toHaveProperty('requesterAccountContext');
    const request = WorkspaceSyncHandoffSourcePhaseRequestV1Schema.parse({ v: 1, phase: 'prepare', input: {
      operationId: root.binding.requestId, accountServerId: fixture.serverId, sourceSessionId: 'source-session',
      action: fixture.prepareInput.action, sourceMachineId: fixture.childRef.machineId, sourceWorkspaceRefId: logicalSourceRefId,
      sourceRootPath: fixture.childRef.rootPath, targetMachineId: fixture.targetChildRef.machineId,
      targetWorkspaceRefId: logicalTargetRefId, targetRootPath: fixture.targetChildRef.rootPath } });
    const receiver = new RpcHandlerManager({ scopePrefix: fixture.sourceRef.machineId, localMachineId: fixture.sourceRef.machineId,
      encryptionMode: 'plain', logger: () => {}, authorizeRequest: input => authorizeMachineRpcRequest(input, {
        machineId: fixture.sourceRef.machineId, resolveInstallationId: () => parentIdentity.installationId,
        resolveCustodianAccountId: async () => 'owner', verifyMachineAdmission: input => verifyMachineRpcAdmissionCurrent({ ...input,
          privateKey: parentKey.secretKey, daemonToken: fixture.credentials.token, serverHttpBaseUrl: 'https://bind-child-home.invalid',
          workspaceSyncSourceReceiver: { machineId: fixture.sourceRef.machineId, installationId: parentIdentity.installationId } }) }) });
    registerMachineWorkspaceSyncRpcHandlers({ rpcHandlerManager: receiver, service: fixture.parent.workspaceSync });
    parentCredentials = fixture.credentials;
    parentClient = new ApiMachineClient(fixture.credentials.token,
      { ...createMachine(), id: fixture.sourceRef.machineId, encryptionMode: 'plain' });
    const parentSocket = socketIo();
    Reflect.set(parentSocket, 'connected', true);
    Reflect.set(parentClient, 'socket', parentSocket);
    const client = new ApiMachineClient(fixture.credentials.token, { ...createMachine(), id: fixture.childRef.machineId, encryptionMode: 'plain' });
    Reflect.set(client, 'socket', createApiSessionSocketStub({ connected: true, emitWithAck: async (_event, raw) => {
      if (!raw || typeof raw !== 'object' || !('method' in raw) || typeof raw.method !== 'string' || !('params' in raw)
        || !('requestId' in raw) || typeof raw.requestId !== 'string') throw new Error('Missing installed SOURCE carrier');
      expect(raw.method).toBe(`${fixture.sourceRef.machineId}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_HANDOFF_SOURCE_PHASE}`);
      const execution = ExternalActionMachineRpcExecutionV1Schema.parse('externalActionExecution' in raw ? raw.externalActionExecution : undefined);
      const routing = WorkspaceSyncSourceRoutingV1Schema.parse('workspaceSyncSourceRouting' in raw ? raw.workspaceSyncSourceRouting : undefined);
      expect((await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, raw.params, raw.method)).params).toEqual(request);
      expect(verifyExternalActionMachineRpcRequestV1({ authorizationToken: root.token, effectActionId: execution.effectActionId,
        target: execution.target, installationId: execution.installationId, event: SOCKET_RPC_EVENTS.CALL, method: raw.method,
        requestId: raw.requestId, params: raw.params,
        publicKey: childKey.publicKey, signature: execution.machineSignature })).toBe(true);
      identityStore.identity = parentIdentity;
      try {
        sourceResponse = await receiver.handleRequest({ ...raw, machineAdmission: admission,
          callerAuthority, ...(callerInputConstraints ? { callerInputConstraints } : {}),
          callerInputAuthorization: root, workspaceSyncSourceRouting: routing });
        return { ok: true, result: sourceResponse };
      } finally { identityStore.identity = childIdentity; }
    } }));
    const context = buildActionExecutorContextForRpc({ machineAdmission: admission, callerAuthority,
      ...(callerInputConstraints ? { callerInputConstraints } : {}),
      serverId: fixture.serverId, externalActionExecutionAuthorization: root,
      externalActionTarget: root.binding.target, verifyMachineAdmissionCurrent: async () =>
        await verifyMachineRpcAdmissionCurrent({ context: admission, privateKey: childKey.secretKey,
          daemonToken: fixture.credentials.token, serverHttpBaseUrl: 'https://bind-child-home.invalid',
          method: `${fixture.childRef.machineId}:${RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3}` }) });
    // Plain socket replies retain the receiver's typed refusal. The SOURCE API's
    // success parser may reject it; this assertion is on actual receiver ingress,
    // rather than treating that schema rejection as the deciding behavior.
    await client.callWorkspaceSyncHandoffSourcePhase({ machineId: fixture.sourceRef.machineId,
      credentials: fixture.credentials, context, request }).catch(error => {
      if (sourceResponse === undefined) throw error;
    });
    expect(sourceHomeVerified).toBe(true);
    expect(sourceNativeInspected).toBe(true);
    expect(await readFile(join(fixture.sourcePath, 'payload.txt'), 'utf8')).toBe('before quiesce');
    const sourceLoan = await fixture.probeSource();
    expect(sourceLoan).not.toHaveProperty('kind');
    if (!('kind' in sourceLoan)) await sourceLoan.release();
    expect(chosenTargetReached, JSON.stringify({ sourceResponse,
      parentTargetFailure: parentTargetFailure instanceof Error
        ? { message: parentTargetFailure.message,
            code: 'code' in parentTargetFailure ? parentTargetFailure.code : undefined,
            stack: parentTargetFailure.stack } : parentTargetFailure,
      transportBoundaries })).toBe(true);
    // Installed target transport preserves the genuine missing-method RpcError.
    // The SOURCE registrar/Manager projects it unchanged. This assertion is on
    // raw ingress, not a containing Session caller's readiness result.
    expect(sourceResponse, JSON.stringify(sourceResponse && typeof sourceResponse === 'object'
      ? { error: 'error' in sourceResponse ? sourceResponse.error : undefined,
          errorCode: 'errorCode' in sourceResponse ? sourceResponse.errorCode : undefined }
      : { kind: typeof sourceResponse })).toMatchObject({ errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND });
    expect(physicalTargetFallback).toBe(false);

    // Keep the original admitted request/Root unchanged: current native custody,
    // not the previous successful Home proof, decides whether Source can run again.
    fixture.driftNativeRoot();
    sourceResponse = undefined;
    sourceNativeInspected = false;
    chosenTargetReached = false;
    await client.callWorkspaceSyncHandoffSourcePhase({ machineId: fixture.sourceRef.machineId,
      credentials: fixture.credentials, context, request }).catch(error => {
      if (sourceResponse === undefined) throw error;
    });
    expect(sourceNativeInspected).toBe(true);
    expect(sourceResponse).toMatchObject({ errorCode: 'workspace_sync_child_unavailable' });
    expect(chosenTargetReached).toBe(false);
    expect(physicalTargetFallback).toBe(false);
    expect(await readFile(join(fixture.sourcePath, 'payload.txt'), 'utf8')).toBe('before quiesce');
    const releasedAfterDrift = await fixture.probeSource();
    expect(releasedAfterDrift).not.toHaveProperty('kind');
    if (!('kind' in releasedAfterDrift)) await releasedAfterDrift.release();
  });

  it.each(['ordinary Account', 'Account Root', 'scoped PAT Root'] as const)(
    'admits the public immutable Home scope through the actual child Session registrar before physical SOURCE preparation with original Root correlation: %s', async rootKind => {
    await withTempDir('happier-public-child-handoff-home-', async homeDir => {
      const environment = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL']);
      const priorIdentity = identityStore.identity;
      const key = tweetnacl.sign.keyPair();
      const guestProfileId = 'guest-handoff-profile';
      const immutableHomeId = 'srv_immutable_session_home';
      const homeUrl = 'https://public-session-home.invalid';
      const descriptor = { v: 1 as const, homeServerIdentityId: immutableHomeId, canonicalServerUrl: homeUrl, revision: 1,
        endpoints: [{ kind: 'https' as const, url: homeUrl }] };
      environment.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_ACTIVE_SERVER_ID: guestProfileId,
        HAPPIER_SERVER_URL: undefined, HAPPIER_WEBAPP_URL: undefined });
      reloadConfiguration();
      identityStore.identity = { version: 1, installationId: 'child-installation', createdAt: 1,
        publicKey: Buffer.from(key.publicKey).toString('base64url'), privateKey: Buffer.from(key.secretKey).toString('base64url') };
      let registration: ReturnType<ApiMachineClient['setRPCHandlers']> | undefined;
      try {
        await setServerProfileEndpointsById({ id: guestProfileId, serverUrl: homeUrl, webappUrl: homeUrl, use: true });
        await adoptServerProfileHomeConnectionDescriptor({ descriptor, expectedProfileId: guestProfileId, observation: 'exact' });
        reloadConfiguration();
        const guestHome = await resolveCliHomeTarget({ kind: 'saved_profile', profileRef: guestProfileId });
        const rootRequestId = 'original-home-action-request';
        const transportRequestId = 'public-home-child-handoff';
        const callerAuthority = rootKind === 'scoped PAT Root' ? 'account_automation' as const : 'present_user' as const;
        const sessionId = 'public-owned-child-session';
        const session = V2SessionByIdResponseSchema.parse({ session: { id: sessionId, seq: 0, createdAt: 1, updatedAt: 1,
          active: true, activeAt: 1, encryptionMode: 'plain', dataEncryptionKey: null, metadataVersion: 1, metadataLayoutVersion: 1,
          metadata: JSON.stringify({ v: 1 }), share: null, agentState: null, agentStateVersion: 1,
          ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1({ v: 1,
            workspace: { machineId: 'source-child', path: '/child/custom' } }) } });
        vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json({ features: {},
          capabilities: { serverIdentity: { serverIdentityId: immutableHomeId } } })));
        const fixture = await composeBindChildSourcePhaseTestRuntime({ socketIo, serverId: immutableHomeId,
          managedHomeId: immutableHomeId, homeTarget: guestHome,
          parentHomeTarget: resolveHomeTargetFromDescriptor({ descriptor, authority: 'saved_profile',
            profile: { id: 'parent-handoff-profile', serverUrl: homeUrl, webappUrl: homeUrl, homeConnectionDescriptor: descriptor } }),
          readAdditionalHttpResponse: async url => {
            if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'owner' } };
            if (url.endsWith(`/v2/sessions/${sessionId}`)) return { status: 200, data: session };
            if (url.endsWith('/account/encryption/currentness')) return { status: 200, data: { mode: 'plain', version: 1,
              signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
            return undefined;
          },
          readAdditionalHttpPostResponse: async (url, raw) => {
            if (!url.endsWith('/machines/source-child/admission/verify')) return undefined;
            const body = raw as { context: import('@happier-dev/protocol/socketRpc').SocketRpcMachineAdmissionContextV1;
              method: string; proof: Parameters<typeof verifyMachineInstallationProof>[0]['proof'];
              workspaceSyncSourceRouting?: import('@happier-dev/protocol/socketRpc').WorkspaceSyncSourceRoutingV1;
              callerInputAuthorization?: ReturnType<typeof ExternalActionExecutionAuthorizationV1Schema.parse> };
            if (body.callerInputAuthorization) {
              expect(ExternalActionExecutionAuthorizationV1Schema.parse(body.callerInputAuthorization)).toMatchObject({
                token: 'home-verified-public-handoff-root', binding: { requestId: rootRequestId, actionId: 'session.handoff',
                  machineId: 'source-child', installationId: 'child-installation' },
              });
              expect(WorkspaceSyncSourceRoutingV1Schema.parse(body.workspaceSyncSourceRouting)).toMatchObject({
                phase: 'prepare', operationId: rootRequestId, accountServerId: immutableHomeId,
                sourceMachineId: 'source-child', sourceSessionId: sessionId,
              });
            }
            expect(verifyMachineInstallationProof({ payload: { version: 1, machineId: 'source-child', installationId: 'child-installation',
              accountId: 'owner', rpcAdmission: { context: body.context, method: body.method,
                ...(body.workspaceSyncSourceRouting ? { workspaceSyncSourceRouting: body.workspaceSyncSourceRouting } : {}),
                ...(body.callerInputAuthorization ? { callerInputAuthorization: body.callerInputAuthorization } : {}) },
              }, proof: body.proof, publicKey: key.publicKey })).toBe(true);
            return { status: 200, data: { v: 1, ok: true } };
          } });
        const terminalProvenance = AuthTokenProvenanceSchema.parse({ v: 1, kind: 'terminal', authority: 'account_automation' });
        const daemonToken = [Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
          Buffer.from(JSON.stringify({ sub: 'owner', session: 'installed-daemon-terminal', provenance: terminalProvenance })).toString('base64url'),
          'fixture-signature'].join('.');
        await writeCredentialsTokenOnlyForServerId(guestProfileId, { token: daemonToken });
        expect(await readStoredCredentials()).toMatchObject({ token: daemonToken, encryption: null, credentialProvenance: 'stored_session' });
        const client = new ApiMachineClient(daemonToken,
          { ...createMachine(), id: fixture.childRef.machineId, encryptionMode: 'plain' }, undefined,
          { workspaceSyncHandoffAdapter: fixture.child.handoffAdapter });
        const root = rootKind === 'ordinary Account' ? undefined : ExternalActionExecutionAuthorizationV1Schema.parse({
          v: 1, token: 'home-verified-public-handoff-root', binding: {
            accountId: 'owner', custodianAccountId: 'owner',
            ...(rootKind === 'Account Root' ? { authentication: { kind: 'account', tokenEpoch: 1 } } : {
              principalId: 'owner', credentialId: 'public-scoped-handoff-pat', grant: { ...API_TOKEN_FULL_GRANT_V1,
                actions: { families: [], ids: ['session.handoff'] },
                targets: { sessions: [sessionId], machines: [fixture.childRef.machineId, fixture.targetRef.machineId] } } }),
            serverIdentityId: immutableHomeId, machineId: fixture.childRef.machineId, installationId: fixture.childInstallationId,
            actionId: 'session.handoff', requestId: rootRequestId, requestEnvelopeDigest: 'A'.repeat(43),
            target: { kind: 'machine', machineId: fixture.childRef.machineId },
            handoffAdmission: { sessionId, sourceMachineId: fixture.childRef.machineId,
              sourceInstallationId: fixture.childInstallationId, targetMachineId: fixture.targetRef.machineId,
              targetInstallationId: 'parent-installation' } } });
        if (root) {
          expect(root).not.toHaveProperty('requesterAccountContext');
          expect(root).not.toHaveProperty('requesterAccountProjection');
        }
        let sourcePrepared = false;
        let preparedSourceOperationId: string | undefined;
        Reflect.set(client, 'socket', createApiSessionSocketStub({ connected: true, emitWithAck: async (event, raw) => {
          if (event === 'machine-update-state') return { result: 'success', version: 1 };
          if (event === MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1) {
            expect(MachineUpdateOperationProtocolCapabilitiesRequestV1Schema.parse(raw).machineId).toBe(fixture.childRef.machineId);
            return MachineUpdateOperationProtocolCapabilitiesResponseV1Schema.parse({ v: 1, result: 'success', revision: 1 });
          }
          if (event !== SOCKET_RPC_EVENTS.CALL || !raw || typeof raw !== 'object' || !('method' in raw)
            || typeof raw.method !== 'string' || !('params' in raw)) throw new Error('Unexpected public handoff socket boundary');
          expect(raw.method).toBe(`${fixture.sourceRef.machineId}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_HANDOFF_SOURCE_PHASE}`);
          const decoded = await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, raw.params, raw.method);
          expect(decoded.params).toMatchObject({ phase: 'prepare', input: { accountServerId: immutableHomeId, sourceSessionId: sessionId,
            sourceMachineId: fixture.childRef.machineId, sourceRootPath: fixture.childRef.rootPath } });
          const phase = WorkspaceSyncHandoffSourcePhaseRequestV1Schema.parse(decoded.params);
          preparedSourceOperationId = phase.input.operationId;
          expect(raw).toMatchObject({ workspaceSyncSourceRouting: { accountServerId: immutableHomeId,
            sourceContext: { callerAuthority, machineAdmission: { actorAccountId: 'owner', machineId: fixture.childRef.machineId } } } });
          if (root) {
            const execution = ExternalActionMachineRpcExecutionV1Schema.parse(
              'externalActionExecution' in raw ? raw.externalActionExecution : undefined);
            expect(execution.authorization).toEqual(root);
            if (!('requestId' in raw) || typeof raw.requestId !== 'string') throw new Error('Missing SOURCE request correlation');
            expect(verifyExternalActionMachineRpcRequestV1({ authorizationToken: root.token,
              effectActionId: execution.effectActionId, target: execution.target, installationId: execution.installationId,
              event: SOCKET_RPC_EVENTS.CALL, method: raw.method, requestId: raw.requestId, params: raw.params,
              publicKey: key.publicKey, signature: execution.machineSignature })).toBe(true);
            expect(raw).not.toHaveProperty('sessionActionOrigin');
          }
          sourcePrepared = true;
          return { ok: false, error: 'Method not found', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND };
        } }));
        // These are the real native Session process ports, not replacements for the registrar or coordinator.
        const stopSession = vi.fn(async () => ({ status: 'stopped' as const }));
        const spawnSession = vi.fn(async () => { throw new Error('Unexpected Session spawn'); });
        registration = client.setRPCHandlers({ spawnSession, stopSession, isSessionActive: async () => true, requestShutdown() {} });
        const rpc = Reflect.get(client, 'rpcHandlerManager');
        if (!(rpc instanceof RpcHandlerManager)) throw new Error('Actual installed Machine RPC ingress is missing');
        const request = SessionHandoffStartRequestSchema.parse({ sessionId, sourceMachineId: fixture.childRef.machineId,
          targetMachineId: fixture.targetRef.machineId, targetPath: fixture.targetRef.rootPath, accountServerId: immutableHomeId,
          sessionStorageMode: 'persisted', preferredTransportStrategies: ['server_routed_stream'], workspaceAction: fixture.prepareInput.action });
        const response = await rpc.handleRequest({ method: `${fixture.childRef.machineId}:${RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3}`,
          // This is Home-verified ingress. Transport cancellation correlation is
          // intentionally not the original Action's Root request correlation.
          requestId: transportRequestId, params: request, callerAuthority,
          ...(root ? { callerInputAuthorization: root } : {}),
          machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: fixture.childRef.machineId,
            installationId: fixture.childInstallationId, role: 'manage', encryptionMode: 'plain' } });
        expect(response, JSON.stringify({ response, sourcePrepared, preparedSourceOperationId,
          rootRequestId: root?.binding.requestId, transportRequestId })).toMatchObject({ ok: false, errorCode: 'workspace_sync_update_required' });
        expect(sourcePrepared).toBe(true);
        if (root) expect(preparedSourceOperationId).toBe(root.binding.requestId);
        expect(stopSession).not.toHaveBeenCalled();
        expect(spawnSession).not.toHaveBeenCalled();
        expect(await readFile(join(fixture.sourcePath, 'payload.txt'), 'utf8')).toBe('before quiesce');
      } finally {
        await registration?.dispose();
        identityStore.identity = priorIdentity; vi.unstubAllGlobals(); environment.restore(); reloadConfiguration();
      }
    });
  });

  it.each(['old-parent', 'native-replaced', 'old-home'] as const)('refuses an owned child Session handoff through the actual registrar before quiescence: %s', async scenario => {
    const priorIdentity = identityStore.identity;
    const key = tweetnacl.sign.keyPair();
    identityStore.identity = { version: 1, installationId: 'child-installation', createdAt: 1,
      publicKey: Buffer.from(key.publicKey).toString('base64url'), privateKey: Buffer.from(key.secretKey).toString('base64url') };
    onTestFinished(() => { identityStore.identity = priorIdentity; vi.unstubAllGlobals(); });
    const sessionId = 'owned-child-session';
    const sessionResponse = V2SessionByIdResponseSchema.parse({ session: {
      id: sessionId, seq: 0, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
      encryptionMode: 'plain', dataEncryptionKey: null, metadataVersion: 1, metadataLayoutVersion: 1,
      metadata: JSON.stringify({ v: 1 }), share: null,
      ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1({ v: 1, workspace: { machineId: 'source-child', path: '/child/custom' } }),
      agentState: null, agentStateVersion: 1,
    } });
    let readSourceSession = false;
    const ownedHomeId = 'srv_owned_child_home';
    installWorkspaceHomeFeaturesBoundary(ownedHomeId);
    const fixture = await composeBindChildSourcePhaseTestRuntime({ socketIo, serverId: ownedHomeId,
      homeTarget: resolveHomeTargetFromDescriptor({ authority: 'saved_profile',
        profile: { id: configuration.activeServerId, serverUrl: 'https://owned-session-home.invalid', webappUrl: 'https://owned-session-home.invalid' },
        descriptor: { v: 1, homeServerIdentityId: ownedHomeId, canonicalServerUrl: 'https://owned-session-home.invalid', revision: 1,
          endpoints: [{ kind: 'https', url: 'https://owned-session-home.invalid' }] } }),
      readAdditionalHttpResponse: async url => {
        if (url.endsWith(`/v2/sessions/${sessionId}`)) { readSourceSession = true; return { status: 200, data: sessionResponse }; }
        if (url.endsWith('/account/encryption/currentness')) return { status: 200, data: { mode: 'plain', version: 1,
          signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
        return undefined;
      },
      readAdditionalHttpPostResponse: async (url, raw) => {
        if (!url.endsWith('/machines/source-child/admission/verify')) return undefined;
        const body = raw as { context: import('@happier-dev/protocol/socketRpc').SocketRpcMachineAdmissionContextV1;
          method: string; proof: Parameters<typeof verifyMachineInstallationProof>[0]['proof'] };
        expect(verifyMachineInstallationProof({ payload: { version: 1, machineId: 'source-child', installationId: 'child-installation',
          accountId: 'owner', rpcAdmission: { context: body.context, method: body.method } }, proof: body.proof, publicKey: key.publicKey })).toBe(true);
        // The predecessor has no admission/verify owner. Exercise the real public verifier's HTTP404 refusal.
        return scenario === 'old-home' ? { status: 404, data: {} } : { status: 200, data: { v: 1, ok: true } };
      },
    });
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json({ features: {},
      capabilities: { serverIdentity: { serverIdentityId: fixture.managedChild.homeId } } })));
    const client = new ApiMachineClient(fixture.credentials.token, { ...createMachine(), id: fixture.childRef.machineId, encryptionMode: 'plain' });
    let sourcePhaseRequested = false;
    Reflect.set(client, 'socket', createApiSessionSocketStub({ connected: true, emitWithAck: async (_event, raw) => {
      if (!raw || typeof raw !== 'object' || !('method' in raw) || typeof raw.method !== 'string' || !('params' in raw)) throw new Error('Missing private SOURCE request');
      expect(raw.method).toBe(`${fixture.sourceRef.machineId}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_HANDOFF_SOURCE_PHASE}`);
      const decoded = await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, raw.params, raw.method);
      expect(decoded.params).toMatchObject({ phase: 'prepare', input: { sourceSessionId: sessionId,
        sourceMachineId: fixture.childRef.machineId, sourceRootPath: fixture.childRef.rootPath,
        targetMachineId: fixture.targetRef.machineId, targetRootPath: fixture.targetRef.rootPath } });
      expect(raw).toMatchObject({ workspaceSyncSourceRouting: { sourceSessionId: sessionId,
        sourceContext: { callerAuthority: 'present_user', machineAdmission: { actorAccountId: 'owner', machineId: fixture.childRef.machineId } } } });
      sourcePhaseRequested = true;
      // Genuine mixed-version network boundary: this installed parent predates the exact private phase member.
      return { ok: false, error: 'Method not found', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND };
    } }));
    if (scenario === 'native-replaced') fixture.driftNativeRoot();
    const coordinate = createTrackedSessionHandoffCoordinator({ expectedAccountServerId: fixture.serverId,
      readCredentials: async () => fixture.credentials, workspaceSyncAdapter: fixture.child.handoffAdapter,
      callWorkspaceSourcePhase: async (descriptor, context) => await client.callWorkspaceSyncHandoffSourcePhase({ ...descriptor,
        context, credentials: fixture.credentials }) });
    const source = new RpcHandlerManager({ scopePrefix: fixture.childRef.machineId, encryptionMode: 'plain', logger: () => {},
      authorizeRequest: received => authorizeMachineRpcRequest(received, { machineId: fixture.childRef.machineId,
        resolveInstallationId: () => fixture.childInstallationId, resolveCustodianAccountId: async () => 'owner',
        verifyMachineAdmission: received => verifyMachineRpcAdmissionCurrent({ ...received, privateKey: key.secretKey,
          daemonToken: fixture.credentials.token, serverHttpBaseUrl: 'https://owned-session-home.invalid' }) }) });
    await withTempDir('happier-owned-child-session-handoff-', async activeServerDir => {
      // Session stop is the native process boundary; the real Agent exporter remains installed and unreachable on refusal.
      const stopSession = vi.fn(async () => 'failed' as const);
      registerMachineSessionHandoffRpcHandlers({ rpcHandlerManager: source, coordinateSessionHandoff: coordinate,
        runtimeConfig: { activeServerDir }, stopSessionForHandoff: stopSession });
      const request = SessionHandoffStartRequestSchema.parse({ sessionId, sourceMachineId: fixture.childRef.machineId,
        targetMachineId: fixture.targetRef.machineId, targetPath: fixture.targetRef.rootPath, accountServerId: fixture.serverId,
        sessionStorageMode: 'persisted', preferredTransportStrategies: ['server_routed_stream'], workspaceAction: fixture.prepareInput.action });
      const response = await source.handleRequest({ method: `${fixture.childRef.machineId}:${RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3}`,
        requestId: `owned-child-${scenario}`, params: request, callerAuthority: 'present_user',
        machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: fixture.childRef.machineId,
          installationId: fixture.childInstallationId, role: 'manage', encryptionMode: 'plain' } });
      expect(response).toMatchObject({ errorCode: scenario === 'old-parent' ? 'workspace_sync_update_required'
        : scenario === 'native-replaced' ? 'workspace_sync_child_unavailable' : RPC_ERROR_CODES.FORBIDDEN });
      if (scenario !== 'old-home') expect(response).toHaveProperty('ok', false);
      expect(readSourceSession).toBe(scenario !== 'old-home');
      expect(sourcePhaseRequested).toBe(scenario === 'old-parent');
      expect(stopSession).not.toHaveBeenCalled();
      expect(await readFile(join(fixture.sourcePath, 'payload.txt'), 'utf8')).toBe('before quiesce');
      for (const probe of [fixture.probeSource, fixture.probeTarget]) {
        const loan = await probe();
        expect(loan).not.toHaveProperty('kind');
        if (!('kind' in loan)) await loan.release();
      }
    });
  });

  it.each(['same-home', 'foreign-home'] as const)('keeps daemon-local profile qualifiers separate from the verified physical Home: %s', async scenario => {
    await withTempDir('happier-workspace-guest-profile-', async homeDir => {
      const environment = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL']);
      const priorIdentity = identityStore.identity;
      const key = tweetnacl.sign.keyPair();
      const homeId = 'srv_immutable_physical_home';
      const guestProfileId = 'guest-local-profile';
      const homeUrl = 'https://physical-home.invalid';
      environment.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_ACTIVE_SERVER_ID: guestProfileId,
        HAPPIER_SERVER_URL: undefined, HAPPIER_WEBAPP_URL: undefined });
      reloadConfiguration();
      identityStore.identity = { version: 1, installationId: 'target-child-installation', createdAt: 1,
        publicKey: Buffer.from(key.publicKey).toString('base64url'), privateKey: Buffer.from(key.secretKey).toString('base64url') };
      let parentRead = false;
      let emitted = false;
      const get = vi.spyOn(axios, 'get').mockImplementation(async url => {
        if (String(url).endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 },
          statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() } };
        parentRead = true;
        return { status: 200, data: { machine: { id: 'physical-parent', active: true, installationId: 'parent-installation',
          dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, metadata: null, metadataVersion: 0,
          daemonState: null, daemonStateVersion: 0, devcontainerChild: null } },
          statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() } };
      });
      const post = vi.spyOn(axios, 'post').mockImplementation(async (url, raw) => {
        expect(String(url)).toContain('/v1/machines/target-child/admission/verify');
        const body = raw as { context: import('@happier-dev/protocol/socketRpc').SocketRpcMachineAdmissionContextV1; method: string;
          proof: Parameters<typeof verifyMachineInstallationProof>[0]['proof'] };
        expect(verifyMachineInstallationProof({ payload: { version: 1, machineId: 'target-child', installationId: 'target-child-installation',
          accountId: 'owner', rpcAdmission: { context: body.context, method: body.method } }, proof: body.proof, publicKey: key.publicKey })).toBe(true);
        return { status: 200, data: { v: 1, ok: true }, statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() } };
      });
      vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json({ features: {},
        capabilities: { serverIdentity: { serverIdentityId: scenario === 'same-home' ? homeId : 'srv_foreign_immutable_home' } } })));
      try {
        await setServerProfileEndpointsById({ id: guestProfileId, serverUrl: homeUrl, webappUrl: homeUrl, use: true });
        await adoptServerProfileHomeConnectionDescriptor({ expectedProfileId: guestProfileId, observation: 'exact',
          descriptor: { v: 1, homeServerIdentityId: homeId, canonicalServerUrl: homeUrl, revision: 1,
            endpoints: [{ kind: 'https', url: homeUrl }] } });
        reloadConfiguration();
        const guestHome = await resolveCliHomeTarget({ kind: 'saved_profile', profileRef: guestProfileId });
        expect(guestHome).toMatchObject({ profileId: guestProfileId, homeServerIdentityId: homeId });
        const credentials = { token: [Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
          Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url'), 'fixture-signature'].join('.'), encryption: null };
        const client = new ApiMachineClient(credentials.token, { ...createMachine(), id: 'target-child', encryptionMode: 'plain' });
        const qualifier = homeId;
        const request = HandoffTargetReplacementPreflightV1Schema.parse({ v: 1, operationId: 'profile-preflight', serverId: qualifier,
          machineId: 'target-child', targetPath: '/child/workspace' });
        const routing = { v: 1, phase: 'preflight', operationId: request.operationId, accountServerId: qualifier,
          targetMachineId: request.machineId, targetRootPath: request.targetPath } satisfies Omit<WorkspaceSyncTargetRoutingV1, 'targetContext'>;
        const content = { mode: 'plain' as const };
        Reflect.set(client, 'socket', createApiSessionSocketStub({ connected: true, emitWithAck: async (_event, raw) => {
          if (!raw || typeof raw !== 'object' || !('method' in raw) || typeof raw.method !== 'string' || !('params' in raw)) throw new Error('Missing qualified TARGET request');
          expect(raw.method).toBe(`physical-parent:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT}`);
          const decoded = await socketRpcCodec.decodeRequestParams(content, raw.params, raw.method);
          expect(decoded.params).toEqual(request);
          expect(raw).toMatchObject({ workspaceSyncTargetRouting: { accountServerId: qualifier, targetMachineId: 'target-child' } });
          emitted = true;
          return { ok: true, result: await socketRpcCodec.encodeResponse(content, { type: 'not_required' }, decoded.callId) };
        } }));
        const admission = { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'target-child',
          installationId: 'target-child-installation', role: 'manage' as const, encryptionMode: 'plain' as const };
        const target = new RpcHandlerManager({ scopePrefix: 'target-child', encryptionMode: 'plain', logger: () => {},
          authorizeRequest: received => authorizeMachineRpcRequest(received, { machineId: 'target-child',
            resolveInstallationId: () => 'target-child-installation', resolveCustodianAccountId: async () => 'owner',
            verifyMachineAdmission: received => verifyMachineRpcAdmissionCurrent({ ...received, privateKey: key.secretKey,
              daemonToken: credentials.token, serverHttpBaseUrl: homeUrl }) }) });
        target.registerHandler(RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT, async (_raw, received) =>
          await client.callWorkspaceSyncTargetPhase({ machineId: 'physical-parent', credentials, request, routing,
            method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT,
            context: buildActionExecutorContextForRpc({ ...received, serverId: qualifier }) }));
        const result = target.handleRequest({ method: `target-child:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT}`,
          params: request, machineAdmission: admission, callerAuthority: 'present_user' });
        if (scenario === 'same-home') {
          await expect(result).resolves.toEqual({ type: 'not_required' });
          expect(emitted).toBe(true);
        } else {
          await expect(result).resolves.toMatchObject({ error: 'Workspace source authority is unavailable' });
          expect(parentRead).toBe(false);
          expect(emitted).toBe(false);
        }
      } finally {
        get.mockRestore(); post.mockRestore(); vi.unstubAllGlobals(); identityStore.identity = priorIdentity;
        environment.restore(); reloadConfiguration();
      }
    });
  });

  it('uses the installed target child socket for physical preflight without changing the chosen child or borrowing source Session hosting', async () => {
    installWorkspaceHomeFeaturesBoundary(workspaceTransportHomeId);
    const key = tweetnacl.sign.keyPair();
    const priorIdentity = identityStore.identity;
    identityStore.identity = { version: 1, installationId: 'target-child-installation', createdAt: 1,
      publicKey: Buffer.from(key.publicKey).toString('base64url'), privateKey: Buffer.from(key.secretKey).toString('base64url') };
    const credentials = { token: [Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
      Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url'), 'fixture-signature'].join('.'), encryption: null };
    const client = new ApiMachineClient(credentials.token, { ...createMachine(), id: 'target-child', encryptionMode: 'plain' });
    const admission = { actorAccountId: 'shared-actor', custodianAccountId: 'owner', machineId: 'target-child',
      installationId: 'target-child-installation', role: 'use' as const, encryptionMode: 'plain' as const };
    const origin = { v: 1 as const, caller: { kind: 'session' as const, sessionId: 'source-session', starterDepth: 1, turnDepth: 1 },
      sourceTurnId: 'source-turn', requestId: 'move-target', callerPermissionMode: 'read-only' as const, workspaceWrites: 'deny' as const } satisfies SessionActionRpcOriginV1;
    const request = HandoffTargetReplacementPreflightV1Schema.parse({ v: 1, operationId: 'move-target', serverId: workspaceTransportHomeId,
      machineId: 'target-child', targetPath: '/child/workspace' });
    const routing = { v: 1, phase: 'preflight', operationId: request.operationId, accountServerId: request.serverId,
      targetMachineId: request.machineId, targetRootPath: request.targetPath } satisfies Omit<WorkspaceSyncTargetRoutingV1, 'targetContext'>;
    const content = { mode: 'plain' as const };
    let emitted = false;
    const socket = createApiSessionSocketStub({ connected: true, emitWithAck: async (_event, raw) => {
      if (!raw || typeof raw !== 'object' || !('method' in raw) || typeof raw.method !== 'string' || !('params' in raw)) throw new Error('Missing TARGET socket request');
      expect(raw.method).toBe(`parent:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT}`);
      const decoded = await socketRpcCodec.decodeRequestParams(content, raw.params, raw.method);
      expect(decoded.params).toEqual(request);
      expect(raw).toMatchObject({ workspaceSyncTargetRouting: { v: 1, phase: 'preflight', operationId: 'move-target',
        accountServerId: workspaceTransportHomeId, targetMachineId: 'target-child', targetRootPath: '/child/workspace',
        targetContext: { machineAdmission: admission, callerAuthority: 'account_automation', sessionActionOrigin: origin,
          callerPermissionMode: 'read-only', workspaceWrites: 'deny' } } });
      expect(raw).not.toHaveProperty('authorization');
      expect(raw).not.toHaveProperty('sessionActionOrigin');
      expect(raw).not.toHaveProperty('machineAdmission');
      emitted = true;
      return { ok: true, result: await socketRpcCodec.encodeResponse(content, { type: 'not_required' }, decoded.callId) };
    } });
    Reflect.set(client, 'socket', socket);
    const get = vi.spyOn(axios, 'get').mockImplementation(async url => ({ status: 200,
      data: String(url).endsWith('/v1/account/encryption') ? { mode: 'plain', updatedAt: 1 }
        : { machine: { id: 'parent', active: true, installationId: 'parent-installation', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
          metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0, devcontainerChild: null } },
      statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() } }));
    const post = vi.spyOn(axios, 'post').mockImplementation(async (url, raw) => {
      expect(String(url)).toContain('/v1/machines/target-child/admission/verify');
      const body = raw as { context: typeof admission; method: string; proof: Parameters<typeof verifyMachineInstallationProof>[0]['proof'] };
      expect(body.context).toEqual(admission);
      expect(verifyMachineInstallationProof({ payload: { version: 1, machineId: 'target-child', installationId: 'target-child-installation',
        accountId: 'owner', rpcAdmission: { context: body.context, method: body.method } }, proof: body.proof, publicKey: key.publicKey })).toBe(true);
      return { status: 200, data: { v: 1, ok: true }, statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() } };
    });
    const target = new RpcHandlerManager({ scopePrefix: 'target-child', encryptionMode: 'plain', logger: () => {},
      authorizeRequest: received => authorizeMachineRpcRequest(received, { machineId: 'target-child',
        resolveInstallationId: () => 'target-child-installation', resolveCustodianAccountId: async () => 'owner',
        verifyMachineAdmission: received => verifyMachineRpcAdmissionCurrent({ ...received, privateKey: key.secretKey,
          daemonToken: credentials.token, serverHttpBaseUrl: 'https://home.invalid' }) }) });
    target.registerHandler(RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT, async (_raw, received) => {
      const context = buildActionExecutorContextForRpc({ ...received, serverId: workspaceTransportHomeId });
      return await client.callWorkspaceSyncTargetPhase({ machineId: 'parent', credentials, context, request,
        method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT,
        routing, signal: received?.signal });
    });
    try {
      await expect(target.handleRequest({ method: `target-child:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT}`,
        params: request, machineAdmission: admission, callerAuthority: 'account_automation', sessionActionOrigin: origin }))
        .resolves.toEqual({ type: 'not_required' });
      expect(emitted).toBe(true);
    } finally { get.mockRestore(); post.mockRestore(); vi.unstubAllGlobals(); identityStore.identity = priorIdentity; }
  });

  it('preserves the original SOURCE writer and verified physical endpoint through the chosen TARGET child', async () => {
    installWorkspaceHomeFeaturesBoundary(workspaceTransportHomeId);
    const child = tweetnacl.sign.keyPair();
    const parent = tweetnacl.sign.keyPair();
    const priorIdentity = identityStore.identity;
    const childIdentity = { version: 1 as const, installationId: 'chosen-child-installation', createdAt: 1,
      publicKey: Buffer.from(child.publicKey).toString('base64url'), privateKey: Buffer.from(child.secretKey).toString('base64url') };
    const parentIdentity = { version: 1 as const, installationId: 'target-parent-installation', createdAt: 1,
      publicKey: Buffer.from(parent.publicKey).toString('base64url'), privateKey: Buffer.from(parent.secretKey).toString('base64url') };
    identityStore.identity = childIdentity;
    const credentials = { token: [Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
      Buffer.from(JSON.stringify({ sub: 'target-owner' })).toString('base64url'), 'fixture-signature'].join('.'), encryption: null };
    const sourceAdmission = { actorAccountId: 'borrower', custodianAccountId: 'source-owner', machineId: 'source-child',
      installationId: 'source-child-installation', role: 'use' as const, encryptionMode: 'e2ee' as const };
    const targetAdmission = { ...sourceAdmission, custodianAccountId: 'target-owner', machineId: 'chosen-child',
      installationId: childIdentity.installationId };
    const constraints = { models: null, permissionModes: null };
    const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-issued-joint-target-boundary', binding: {
      accountId: 'borrower', principalId: 'borrower', credentialId: 'pat', grant: API_TOKEN_FULL_GRANT_V1,
      custodianAccountId: sourceAdmission.custodianAccountId, serverIdentityId: workspaceTransportHomeId,
      machineId: sourceAdmission.machineId, installationId: sourceAdmission.installationId,
      actionId: 'session.handoff', requestId: 'joint-target-operation', requestEnvelopeDigest: 'A'.repeat(43),
      target: { kind: 'machine', machineId: sourceAdmission.machineId }, handoffAdmission: { sessionId: 'source-session',
        sourceMachineId: sourceAdmission.machineId, sourceInstallationId: sourceAdmission.installationId,
        targetMachineId: targetAdmission.machineId, targetInstallationId: targetAdmission.installationId },
    } });
    const routing = WorkspaceSyncSourceWriterTargetRoutingV1Schema.parse({ v: 1,
      sourceWriter: { machineId: 'physical-source-parent', installationId: 'physical-source-installation' },
      source: { v: 1, phase: 'prepare', operationId: root.binding.requestId, accountServerId: workspaceTransportHomeId,
        sourceMachineId: sourceAdmission.machineId, sourceRootPath: '/source/workspace', sourceSessionId: 'source-session',
        sourceContext: { machineAdmission: sourceAdmission, callerAuthority: 'account_automation',
          callerInputConstraints: constraints, workspaceWrites: 'allow' } },
      target: { v: 1, phase: 'preflight', operationId: root.binding.requestId, accountServerId: workspaceTransportHomeId,
        targetMachineId: targetAdmission.machineId, targetRootPath: '/chosen/workspace' },
    });
    const targetRouting = WorkspaceSyncTargetRoutingV1Schema.parse({ ...routing.target,
      targetContext: { machineAdmission: targetAdmission, callerAuthority: 'account_automation',
        callerInputConstraints: constraints, workspaceWrites: 'allow' } });
    const physicalEndpoint = { machineId: 'target-parent', installationId: parentIdentity.installationId,
      installationPublicKey: parentIdentity.publicKey };
    const request = HandoffTargetReplacementPreflightV1Schema.parse({ v: 1, operationId: root.binding.requestId,
      serverId: workspaceTransportHomeId, machineId: targetAdmission.machineId, targetPath: routing.target.targetRootPath });
    const method = RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT;
    let forwarded = false;
    let physicalReceiverReached = false;
    // This is an already-verified Home response vector, not evidence that the
    // issuer grants this purpose. The real issuer has its own server tests.
    const post = vi.spyOn(axios, 'post').mockImplementation(async (url, raw) => {
      const body = raw as { context: typeof targetAdmission; method: string;
        callerInputAuthorization: typeof root; workspaceSyncSourceWriterTargetRouting: typeof routing;
        workspaceSyncTargetRouting?: typeof targetRouting; proof: Parameters<typeof verifyMachineInstallationProof>[0]['proof'] };
      const receivingParent = String(url).includes('/target-parent/');
      const signer = receivingParent ? { machineId: physicalEndpoint.machineId, installationId: parentIdentity.installationId }
        : { machineId: targetAdmission.machineId, installationId: childIdentity.installationId };
      expect(body.context).toEqual(targetAdmission);
      expect(body.callerInputAuthorization).toEqual(root);
      expect(body.workspaceSyncSourceWriterTargetRouting).toEqual(routing);
      expect(verifyMachineInstallationProof({ payload: { version: 1, ...signer, accountId: 'target-owner', rpcAdmission: {
        context: body.context, method: body.method, callerInputAuthorization: root,
        workspaceSyncSourceWriterTargetRouting: routing,
        ...(body.workspaceSyncTargetRouting ? { workspaceSyncTargetRouting: body.workspaceSyncTargetRouting } : {}),
      } }, proof: body.proof, publicKey: receivingParent ? parent.publicKey : child.publicKey })).toBe(true);
      if (receivingParent || body.method === `${physicalEndpoint.machineId}:${method}`) {
        expect(body.workspaceSyncTargetRouting).toEqual(targetRouting);
      }
      return { status: 200, data: { v: 1, ok: true, destinationInstallation: physicalEndpoint } };
    });
    const get = vi.spyOn(axios, 'get').mockImplementation(async () => {
      throw new Error('A chosen TARGET child must not borrow the physical parent Account codec');
    });
    const receiver = new RpcHandlerManager({ scopePrefix: physicalEndpoint.machineId, localMachineId: physicalEndpoint.machineId,
      encryptionKey: new Uint8Array(32).fill(19), encryptionVariant: 'dataKey', logger: () => {},
      authorizeRequest: received => authorizeMachineRpcRequest(received, { machineId: physicalEndpoint.machineId,
        resolveInstallationId: () => parentIdentity.installationId, resolveCustodianAccountId: async () => 'target-owner',
        verifyMachineAdmission: input => verifyMachineRpcAdmissionCurrent({ ...input, privateKey: parent.secretKey,
          workspaceSyncTargetReceiver: { machineId: physicalEndpoint.machineId, installationId: parentIdentity.installationId },
          daemonToken: credentials.token, serverHttpBaseUrl: 'https://home.invalid' }) }) });
    receiver.registerHandler(method, async (params, context) => {
      expect(params).toEqual(request);
      expect(context).toMatchObject({ machineAdmission: targetAdmission, callerInputAuthorization: root,
        workspaceSyncSourceWriterTargetRouting: routing, workspaceSyncTargetRouting: targetRouting });
      physicalReceiverReached = true;
      // The API sender must publish the independently verified recipient; the
      // endpoint cannot be guessed from an untrusted handler result.
      return { type: 'not_required' };
    });
    const client = new ApiMachineClient(credentials.token, { ...createMachine(), id: targetAdmission.machineId, encryptionMode: 'plain' });
    Reflect.set(client, 'socket', createApiSessionSocketStub({ connected: true, emitWithAck: async (_event, raw) => {
      if (!raw || typeof raw !== 'object' || !('method' in raw) || typeof raw.method !== 'string'
        || !('params' in raw) || !('requestId' in raw) || typeof raw.requestId !== 'string'
        || !('externalActionExecution' in raw)) throw new Error('The actual installed child did not sign its TARGET hop');
      expect(raw.method).toBe(`${physicalEndpoint.machineId}:${method}`);
      expect(raw).toMatchObject({ workspaceSyncSourceWriterTargetRouting: routing, workspaceSyncTargetRouting: targetRouting });
      const execution = ExternalActionMachineRpcExecutionV1Schema.parse(raw.externalActionExecution);
      expect(execution).toMatchObject({ authorization: root, installationId: childIdentity.installationId });
      expect(verifyExternalActionMachineRpcRequestV1({ authorizationToken: root.token, effectActionId: execution.effectActionId,
        target: execution.target, installationId: execution.installationId, event: SOCKET_RPC_EVENTS.CALL,
        method: raw.method, requestId: raw.requestId, params: raw.params, workspaceSyncSourceWriterTargetRouting: routing,
        publicKey: child.publicKey, signature: execution.machineSignature })).toBe(true);
      forwarded = true;
      identityStore.identity = parentIdentity;
      try {
        return { ok: true, result: await receiver.handleRequest({ ...raw, machineAdmission: targetAdmission,
          callerAuthority: 'account_automation', callerInputConstraints: constraints, callerInputAuthorization: root,
          workspaceSyncSourceWriterTargetRouting: routing, workspaceSyncTargetRouting: targetRouting }) };
      } finally { identityStore.identity = childIdentity; }
    } }));
    const chosen = new RpcHandlerManager({ scopePrefix: targetAdmission.machineId, localMachineId: targetAdmission.machineId,
      encryptionKey: new Uint8Array(32).fill(23), encryptionVariant: 'dataKey', logger: () => {},
      authorizeRequest: received => authorizeMachineRpcRequest(received, { machineId: targetAdmission.machineId,
        resolveInstallationId: () => childIdentity.installationId, resolveCustodianAccountId: async () => 'target-owner',
        verifyMachineAdmission: input => verifyMachineRpcAdmissionCurrent({ ...input, privateKey: child.secretKey,
          daemonToken: credentials.token, serverHttpBaseUrl: 'https://home.invalid' }) }) });
    chosen.registerHandler(method, async (params, context) => client.callWorkspaceSyncTargetPhase({
      machineId: physicalEndpoint.machineId, credentials, method, request: params, routing: routing.target,
      context: buildActionExecutorContextForRpc({ ...context, serverId: workspaceTransportHomeId }), signal: context?.signal,
    }));
    const incomingMethod = `${targetAdmission.machineId}:${method}`;
    const content = createWorkspaceSyncTargetContent({ destination: { machineId: targetAdmission.machineId,
      installationId: childIdentity.installationId, installationPublicKey: childIdentity.publicKey }, method: incomingMethod, routing });
    const callId = 'c'.repeat(32);
    try {
      const result = await chosen.handleRequest({ method: incomingMethod,
        params: await socketRpcCodec.encodeParams(content, request, { method: incomingMethod, callId }),
        machineAdmission: targetAdmission, callerAuthority: 'account_automation', callerInputConstraints: constraints,
        callerInputAuthorization: root, workspaceSyncSourceWriterTargetRouting: routing });
      expect(await socketRpcCodec.decodeResult(content, { ok: true, result }, callId))
        .toEqual({ type: 'not_required', physicalEndpoint });
      expect(forwarded).toBe(true);
      expect(physicalReceiverReached).toBe(true);
    } finally { get.mockRestore(); post.mockRestore(); vi.unstubAllGlobals(); identityStore.identity = priorIdentity; }
  });

  it('retains the original SOURCE root through the actual physical writer into verified TARGET ingress', async () => {
    installWorkspaceHomeFeaturesBoundary(workspaceTransportHomeId);
    const writer = tweetnacl.sign.keyPair();
    const target = tweetnacl.sign.keyPair();
    const priorIdentity = identityStore.identity;
    identityStore.identity = { version: 1, installationId: 'writer-installation', createdAt: 1,
      publicKey: Buffer.from(writer.publicKey).toString('base64url'), privateKey: Buffer.from(writer.secretKey).toString('base64url') };
    const credentials = { token: [Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
      Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url'), 'fixture-signature'].join('.'), encryption: null };
    const admission = { actorAccountId: 'borrower', custodianAccountId: 'owner', machineId: 'source-child',
      installationId: 'source-installation', role: 'use' as const, encryptionMode: 'plain' as const };
    const constraints = { models: null, permissionModes: null };
    const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-issued-original-source-root', binding: {
      accountId: 'borrower', principalId: 'borrower', credentialId: 'pat', grant: API_TOKEN_FULL_GRANT_V1,
      custodianAccountId: 'owner', serverIdentityId: workspaceTransportHomeId, machineId: admission.machineId,
      installationId: admission.installationId, actionId: 'session.handoff', requestId: 'source-writer-target-operation',
      requestEnvelopeDigest: 'A'.repeat(43), target: { kind: 'machine', machineId: admission.machineId },
      handoffAdmission: { sessionId: 'source-session', sourceMachineId: admission.machineId, targetMachineId: 'target-child',
        sourceInstallationId: admission.installationId, targetInstallationId: 'target-installation' },
    } });
    const sourceRouting = WorkspaceSyncSourceRoutingV1Schema.parse({ v: 1, phase: 'prepare', operationId: root.binding.requestId,
      accountServerId: workspaceTransportHomeId, sourceMachineId: admission.machineId, sourceRootPath: '/source/workspace',
      sourceSessionId: 'source-session', sourceContext: { machineAdmission: admission, callerAuthority: 'account_automation',
        callerInputConstraints: constraints, workspaceWrites: 'allow' } });
    const routing = WorkspaceSyncSourceWriterTargetRoutingV1Schema.parse({ v: 1, source: sourceRouting,
      sourceWriter: { machineId: 'physical-writer', installationId: 'writer-installation' },
      target: { v: 1, phase: 'preflight', operationId: root.binding.requestId, accountServerId: workspaceTransportHomeId,
        targetMachineId: 'target-child', targetRootPath: '/target/workspace' } });
    const request = HandoffTargetReplacementPreflightV1Schema.parse({ v: 1, operationId: root.binding.requestId,
      serverId: workspaceTransportHomeId, machineId: 'target-child', targetPath: routing.target.targetRootPath });
    const policy = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
    const sourceParams = { v: 1, phase: 'prepare', input: { operationId: sourceRouting.operationId,
      accountServerId: workspaceTransportHomeId, sourceMachineId: admission.machineId, sourceRootPath: sourceRouting.sourceRootPath,
      sourceSessionId: sourceRouting.sourceSessionId, targetMachineId: 'target-child', targetRootPath: '/target/workspace',
      action: { kind: 'copy_once', contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) } } } };
    let effects = 0;
    let targetVerified = false;
    // Home and Socket are genuine transport boundaries. No handler receives a fabricated admitted context.
    const post = vi.spyOn(axios, 'post').mockImplementation(async (url, raw) => {
      const body = raw as { context: typeof admission; method: string; callerInputAuthorization: typeof root;
        workspaceSyncSourceRouting?: typeof sourceRouting; workspaceSyncSourceWriterTargetRouting?: typeof routing;
        proof: Parameters<typeof verifyMachineInstallationProof>[0]['proof'] };
      const receivingTarget = String(url).includes('/target-child/');
      const signer = receivingTarget ? { machineId: 'target-child', installationId: 'target-installation' }
        : { machineId: 'physical-writer', installationId: 'writer-installation' };
      expect(body.callerInputAuthorization).toEqual(root);
      const retained = body.workspaceSyncSourceWriterTargetRouting
        ? { workspaceSyncSourceWriterTargetRouting: body.workspaceSyncSourceWriterTargetRouting }
        : { workspaceSyncSourceRouting: sourceRouting };
      expect(verifyMachineInstallationProof({ payload: { version: 1, ...signer, accountId: 'owner', rpcAdmission: {
        context: body.context, method: body.method, callerInputAuthorization: root, ...retained } },
        proof: body.proof, publicKey: receivingTarget ? target.publicKey : writer.publicKey })).toBe(true);
      if (receivingTarget) {
        expect(body.workspaceSyncSourceWriterTargetRouting).toEqual(routing);
        targetVerified = true;
      }
      return { status: 200, data: { v: 1, ok: true, destinationInstallation: { machineId: 'target-child',
        installationId: 'target-installation', installationPublicKey: Buffer.from(target.publicKey).toString('base64url') } } };
    });
    const get = vi.spyOn(axios, 'get').mockImplementation(async () => {
      throw new Error('A physical SOURCE writer must not borrow the chosen target Account key');
    });
    const receiver = new RpcHandlerManager({ scopePrefix: 'target-child', localMachineId: 'target-child', encryptionMode: 'plain',
      logger: () => {}, authorizeRequest: received => authorizeMachineRpcRequest(received, {
        machineId: 'target-child', resolveInstallationId: () => 'target-installation', resolveCustodianAccountId: async () => 'owner',
        verifyMachineAdmission: input => verifyMachineRpcAdmissionCurrent({ ...input, privateKey: target.secretKey,
          daemonToken: credentials.token, serverHttpBaseUrl: 'https://home.invalid' }),
      }) });
    receiver.registerHandler(RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT, async (params, context) => {
      expect(targetVerified).toBe(true);
      expect(params).toEqual(request);
      expect(context).toMatchObject({ callerInputAuthorization: root, workspaceSyncSourceWriterTargetRouting: routing });
      effects += 1;
      return { type: 'not_required' };
    });
    const client = new ApiMachineClient(credentials.token, { ...createMachine(), id: 'physical-writer', encryptionMode: 'plain' });
    Reflect.set(client, 'socket', createApiSessionSocketStub({ connected: true, emitWithAck: async (_event, raw) => {
      if (!raw || typeof raw !== 'object' || !('method' in raw) || typeof raw.method !== 'string'
        || !('params' in raw) || !('requestId' in raw) || typeof raw.requestId !== 'string'
        || !('externalActionExecution' in raw)) throw new Error('Missing signed physical writer request');
      const proof = ExternalActionMachineRpcExecutionV1Schema.parse(raw.externalActionExecution);
      const signature = { authorizationToken: root.token, effectActionId: proof.effectActionId, target: proof.target,
        installationId: proof.installationId, event: SOCKET_RPC_EVENTS.CALL, method: raw.method,
        requestId: raw.requestId, params: raw.params, workspaceSyncSourceWriterTargetRouting: routing,
        publicKey: writer.publicKey, signature: proof.machineSignature };
      expect(proof).toMatchObject({ authorization: root, installationId: 'writer-installation' });
      expect(raw).toMatchObject({ workspaceSyncSourceWriterTargetRouting: routing });
      expect(verifyExternalActionMachineRpcRequestV1(signature)).toBe(true);
      expect(verifyExternalActionMachineRpcRequestV1({ ...signature, workspaceSyncSourceWriterTargetRouting: {
        ...routing, sourceWriter: { ...routing.sourceWriter, installationId: 'forged-writer' } } })).toBe(false);
      expect(verifyExternalActionMachineRpcRequestV1({ ...signature, authorizationToken: 'forged-root' })).toBe(false);
      // The Home Socket boundary has verified the writer signature above and stamps the current
      // chosen-target admission. The receiver still independently proves its installed custody.
      const writerIdentity = identityStore.identity;
      identityStore.identity = { version: 1, installationId: 'target-installation', createdAt: 1,
        publicKey: Buffer.from(target.publicKey).toString('base64url'), privateKey: Buffer.from(target.secretKey).toString('base64url') };
      try {
        const result = await receiver.handleRequest({ ...raw, machineAdmission: { ...admission,
          machineId: 'target-child', installationId: 'target-installation' }, callerInputAuthorization: root,
          callerAuthority: 'account_automation', callerInputConstraints: constraints,
          workspaceSyncSourceWriterTargetRouting: routing });
        return { ok: true, result };
      } finally { identityStore.identity = writerIdentity; }
    } }));
    const source = new RpcHandlerManager({ scopePrefix: 'physical-writer', localMachineId: 'physical-writer', encryptionMode: 'plain',
      logger: () => {}, authorizeRequest: received => authorizeMachineRpcRequest(received, {
        machineId: 'physical-writer', resolveInstallationId: () => 'writer-installation', resolveCustodianAccountId: async () => 'owner',
        verifyMachineAdmission: input => verifyMachineRpcAdmissionCurrent({ ...input, privateKey: writer.secretKey,
          daemonToken: credentials.token, serverHttpBaseUrl: 'https://home.invalid',
          workspaceSyncSourceReceiver: { machineId: 'physical-writer', installationId: 'writer-installation' } }),
      }) });
    source.registerHandler(RPC_METHODS.DAEMON_WORKSPACE_SYNC_HANDOFF_SOURCE_PHASE, async (_params, context) => {
      const admitted = { ...buildActionExecutorContextForRpc({ ...context, serverId: workspaceTransportHomeId }),
        workspaceSyncSourceRouting: context?.workspaceSyncSourceRouting };
      return client.callWorkspaceSyncTargetPhase({ machineId: 'target-child', credentials, request, routing: routing.target,
        method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT, context: admitted });
    });
    try {
      const incoming = { method: `physical-writer:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_HANDOFF_SOURCE_PHASE}`, params: sourceParams,
        machineAdmission: admission, workspaceSyncSourceRouting: sourceRouting, callerInputAuthorization: root,
        callerAuthority: 'account_automation' as const, callerInputConstraints: constraints };
      await expect(source.handleRequest({ ...incoming, params: { ...sourceParams,
        input: { ...sourceParams.input, targetMachineId: 'unrelated-child' } } })).resolves.toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
      expect(effects).toBe(0);
      await expect(source.handleRequest(incoming)).resolves.toEqual({ type: 'not_required' });
      expect(effects).toBe(1);
    } finally { get.mockRestore(); post.mockRestore(); vi.unstubAllGlobals(); identityStore.identity = priorIdentity; }
  });

  it('retains the original PAT child binding while signing the actual physical SOURCE request', async () => {
    installWorkspaceHomeFeaturesBoundary(workspaceTransportHomeId);
    const key = tweetnacl.sign.keyPair();
    const priorIdentity = identityStore.identity;
    identityStore.identity = { version: 1, installationId: 'child-installation', createdAt: 1,
      publicKey: Buffer.from(key.publicKey).toString('base64url'), privateKey: Buffer.from(key.secretKey).toString('base64url') };
    const credentials = { token: [Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
      Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url'), 'fixture-signature'].join('.'), encryption: null };
    const admission = { actorAccountId: 'shared-actor', custodianAccountId: 'owner', machineId: 'child',
      installationId: 'child-installation', role: 'use' as const, encryptionMode: 'plain' as const };
    // Home issuance/current-grant verification is covered at the real server ingress; this is its transport response boundary.
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-issued-pat-boundary', binding: {
      serverIdentityId: workspaceTransportHomeId, accountId: 'shared-actor', principalId: 'shared-actor', credentialId: 'pat-credential',
      custodianAccountId: 'owner', machineId: 'child', installationId: 'child-installation',
      actionId: 'session.handoff', requestId: 'original-handoff', requestEnvelopeDigest: 'A'.repeat(43),
      target: { kind: 'machine', machineId: 'child' }, grant: API_TOKEN_FULL_GRANT_V1,
    } });
    const grant = 'grant' in authorization.binding ? authorization.binding.grant : null;
    if (!grant) throw new Error('PAT boundary must retain its canonical grant');
    const client = new ApiMachineClient(credentials.token, { ...createMachine(), id: 'child', encryptionMode: 'plain' });
    const policyInput = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
    const input = { operationId: 'signed-move', accountServerId: workspaceTransportHomeId, sourceSessionId: 'session-1',
      action: { kind: 'copy_once' as const, contentPolicy: { ...policyInput, policyDigest: computeWorkspaceSyncPolicyDigest(policyInput) } },
      sourceMachineId: 'child', sourceRootPath: '/child/workspace', targetMachineId: 'target', targetRootPath: '/target/workspace' };
    const content = { mode: 'plain' as const };
    const emittedPhases: string[] = [];
    let originalGrantCurrent = true;
    const socket = createApiSessionSocketStub({ connected: true, emitWithAck: async (_event, raw) => {
      if (!raw || typeof raw !== 'object' || !('method' in raw) || typeof raw.method !== 'string' || !('params' in raw)
        || !('requestId' in raw) || typeof raw.requestId !== 'string') throw new Error('Missing SOURCE correlation');
      expect(raw.method).toBe(`parent:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_HANDOFF_SOURCE_PHASE}`);
      expect(raw).toMatchObject({ workspaceSyncSourceRouting: { sourceContext: { machineAdmission: admission,
        callerAuthority: 'account_automation', callerInputConstraints: { models: null, permissionModes: null } } } });
      expect(raw).not.toHaveProperty('sessionActionOrigin');
      const decoded = await socketRpcCodec.decodeRequestParams(content, raw.params, raw.method);
      const phase = decoded.params as { phase: 'prepare' | 'abort'; input: typeof input };
      expect(phase.input).toEqual(input);
      if (phase.phase === 'prepare') {
        if (!('externalActionExecution' in raw)) throw new Error('Missing signed SOURCE carrier');
        const proof = ExternalActionMachineRpcExecutionV1Schema.parse(raw.externalActionExecution);
        const signatureInput = { authorizationToken: authorization.token, effectActionId: proof.effectActionId,
          target: proof.target, installationId: proof.installationId, event: SOCKET_RPC_EVENTS.CALL, method: raw.method,
          requestId: raw.requestId, params: raw.params, publicKey: key.publicKey, signature: proof.machineSignature };
        expect(proof).toMatchObject({ authorization, effectActionId: 'session.handoff', target: authorization.binding.target,
          installationId: 'child-installation' });
        expect(verifyExternalActionMachineRpcRequestV1(signatureInput)).toBe(true);
        expect(verifyExternalActionMachineRpcRequestV1({ ...signatureInput, method: `foreign:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_HANDOFF_SOURCE_PHASE}` })).toBe(false);
      } else {
        // Release uses the retained exact context, not a withdrawn borrower's effect credential.
        expect(originalGrantCurrent).toBe(false);
        expect(raw).not.toHaveProperty('externalActionExecution');
      }
      emittedPhases.push(phase.phase);
      const result = phase.phase === 'prepare' ? { v: 1, phase: 'prepared',
        prepared: { kind: 'copy_once', operationId: input.operationId, action: input.action } } : { v: 1, phase: 'aborted' };
      return { ok: true, result: await socketRpcCodec.encodeResponse(content, result, decoded.callId) };
    } });
    Reflect.set(client, 'socket', socket);
    const get = vi.spyOn(axios, 'get').mockImplementation(async url => ({ status: 200,
      data: String(url).endsWith('/v1/account/encryption') ? { mode: 'plain', updatedAt: 1 }
        : { machine: { id: 'parent', active: true, installationId: 'parent-installation', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
          metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0, devcontainerChild: null } },
      statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() } }));
    const post = vi.spyOn(axios, 'post').mockImplementation(async (_url, raw) => {
      const body = raw as { context: typeof admission; method: string; proof: Parameters<typeof verifyMachineInstallationProof>[0]['proof'] };
      expect(body.context).toEqual(admission);
      expect(verifyMachineInstallationProof({ payload: { version: 1, machineId: 'child', installationId: 'child-installation',
        accountId: 'owner', rpcAdmission: { context: body.context, method: body.method } }, proof: body.proof, publicKey: key.publicKey })).toBe(true);
      return { status: originalGrantCurrent ? 200 : 403, data: originalGrantCurrent ? { v: 1, ok: true } : { error: 'Forbidden' },
        statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() } };
    });
    const source = new RpcHandlerManager({ scopePrefix: 'child', encryptionMode: 'plain', logger: () => {},
      authorizeRequest: request => authorizeMachineRpcRequest(request, { machineId: 'child',
        resolveInstallationId: () => 'child-installation', resolveCustodianAccountId: async () => 'owner',
        verifyMachineAdmission: received => verifyMachineRpcAdmissionCurrent({ ...received, privateKey: key.secretKey,
          daemonToken: credentials.token, serverHttpBaseUrl: 'https://home.invalid' }) }) });
    source.registerHandler(RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3, async (_raw, received) => {
      const context = buildActionExecutorContextForRpc({ ...received, serverId: workspaceTransportHomeId,
        externalActionTarget: authorization.binding.target, externalActionExecutionAuthorization: authorization,
        callerInputConstraints: { models: grant.models, permissionModes: grant.permissionModes } });
      const prepared = await client.callWorkspaceSyncHandoffSourcePhase({ machineId: 'parent', credentials, context,
        request: { v: 1, phase: 'prepare', input }, signal: received?.signal });
      originalGrantCurrent = false;
      await expect(client.callWorkspaceSyncHandoffSourcePhase({ machineId: 'parent', credentials, context,
        request: { v: 1, phase: 'prepare', input }, signal: received?.signal })).rejects.toMatchObject({ code: 'peer_unavailable' });
      // Home features becoming unavailable cannot strand an already retained parent loan.
      vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => { throw new Error('Home features unavailable during release'); }));
      const aborted = await client.callWorkspaceSyncHandoffSourcePhase({ machineId: 'parent', credentials, context,
        request: { v: 1, phase: 'abort', input }, signal: new AbortController().signal });
      return { prepared, aborted };
    });
    try {
      await expect(source.handleRequest({ method: `child:${RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3}`, params: { sessionId: 'session-1' },
        machineAdmission: admission, callerAuthority: 'account_automation', authorization: { kind: 'session.write', sessionId: 'session-1' } }))
        .resolves.toMatchObject({ prepared: { phase: 'prepared' }, aborted: { phase: 'aborted' } });
      expect(emittedPhases).toEqual(['prepare', 'abort']);
    } finally { get.mockRestore(); post.mockRestore(); vi.unstubAllGlobals(); identityStore.identity = priorIdentity; }
  });

  it('uses the admitted child Machine socket for parent SOURCE phases and retains cleanup after the original request is canceled', async () => {
    installWorkspaceHomeFeaturesBoundary(workspaceTransportHomeId);
    const key = tweetnacl.sign.keyPair();
    const priorIdentity = identityStore.identity;
    identityStore.identity = { version: 1, installationId: 'child-installation', createdAt: 1,
      publicKey: Buffer.from(key.publicKey).toString('base64url'), privateKey: Buffer.from(key.secretKey).toString('base64url') };
    const credentials = { token: [Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
      Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url'), 'fixture-signature'].join('.'), encryption: null };
    const client = new ApiMachineClient(credentials.token, { ...createMachine(), id: 'child', encryptionMode: 'plain' });
    const admission = { actorAccountId: 'shared-actor', custodianAccountId: 'owner', machineId: 'child',
      installationId: 'child-installation', role: 'use' as const, encryptionMode: 'plain' as const };
    const policyInput = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
    const contentPolicy = { ...policyInput, policyDigest: computeWorkspaceSyncPolicyDigest(policyInput) };
    const input = { operationId: 'move-1', accountServerId: workspaceTransportHomeId, sourceSessionId: 'session-1',
      action: { kind: 'copy_once' as const, contentPolicy }, sourceMachineId: 'child', sourceRootPath: '/child/workspace',
      targetMachineId: 'target', targetRootPath: '/target/workspace' };
    const phases: unknown[] = [];
    const content = { mode: 'plain' as const };
    const socket = createApiSessionSocketStub({ connected: true, emitWithAck: async (_event, raw) => {
      if (!raw || typeof raw !== 'object' || !('method' in raw) || typeof raw.method !== 'string' || !('params' in raw)) {
        throw new Error('Invalid source Machine socket payload');
      }
      expect(raw.method).toBe(`parent:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_HANDOFF_SOURCE_PHASE}`);
      const decoded = await socketRpcCodec.decodeRequestParams(content, raw.params, raw.method);
      const request = decoded.params as { phase: string; input: typeof input };
      expect(request.input).toEqual(input);
      expect(raw).toMatchObject({ workspaceSyncSourceRouting: { v: 1, phase: request.phase,
        operationId: input.operationId, accountServerId: input.accountServerId, sourceMachineId: input.sourceMachineId,
        sourceRootPath: input.sourceRootPath, sourceSessionId: input.sourceSessionId,
        sourceContext: { machineAdmission: admission, callerAuthority: 'present_user' } } });
      expect(raw).not.toHaveProperty('sessionActionOrigin');
      expect(raw).not.toHaveProperty('machineAdmission');
      phases.push(request.phase);
      const result = request.phase === 'prepare'
        ? { v: 1, phase: 'prepared', prepared: { kind: 'copy_once', operationId: input.operationId, action: input.action } }
        : { v: 1, phase: 'aborted' };
      return { ok: true, result: await socketRpcCodec.encodeResponse(content, result, decoded.callId) };
    } });
    Reflect.set(client, 'socket', socket);
    const get = vi.spyOn(axios, 'get').mockImplementation(async url => ({ status: 200,
      data: String(url).endsWith('/v1/account/encryption') ? { mode: 'plain', updatedAt: 1 }
        : { machine: { id: 'parent', active: true, installationId: 'parent-installation',
          dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, metadata: null, metadataVersion: 0,
          daemonState: null, daemonStateVersion: 0, devcontainerChild: null } },
      statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() } }));
    const post = vi.spyOn(axios, 'post').mockImplementation(async (url, raw) => {
      expect(String(url)).toContain('/v1/machines/child/admission/verify');
      const body = raw as { context: typeof admission; method: string; proof: Parameters<typeof verifyMachineInstallationProof>[0]['proof'] };
      expect(body.context).toEqual(admission);
      expect(verifyMachineInstallationProof({ payload: { version: 1, machineId: 'child', installationId: 'child-installation',
        accountId: 'owner', rpcAdmission: { context: body.context, method: body.method } },
        proof: body.proof, publicKey: key.publicKey })).toBe(true);
      return { status: 200, data: { v: 1, ok: true }, statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() } };
    });
    const source = new RpcHandlerManager({ scopePrefix: 'child', encryptionMode: 'plain',
      authorizeRequest: request => authorizeMachineRpcRequest(request, { machineId: 'child',
        resolveInstallationId: () => 'child-installation', resolveCustodianAccountId: async () => 'owner',
        verifyMachineAdmission: received => verifyMachineRpcAdmissionCurrent({ ...received, privateKey: key.secretKey,
          daemonToken: credentials.token, serverHttpBaseUrl: 'https://home.invalid' }) }), logger: () => {} });
    source.registerHandler(RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3, async (_raw, received) => {
      const context = buildActionExecutorContextForRpc({ ...received, serverId: workspaceTransportHomeId, defaultSessionId: 'session-1' });
      const prepared = await client.callWorkspaceSyncHandoffSourcePhase({ machineId: 'parent', credentials, context,
        request: { v: 1, phase: 'prepare', input }, signal: received?.signal });
      source.onSocketDisconnect();
      expect(context.signal?.aborted).toBe(true);
      vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => { throw new Error('Home features unavailable during release'); }));
      const aborted = await client.callWorkspaceSyncHandoffSourcePhase({ machineId: 'parent', credentials, context,
        request: { v: 1, phase: 'abort', input }, signal: new AbortController().signal });
      return { prepared, aborted, actor: context.machineAdmission?.actorAccountId, authority: context.authority };
    });
    try {
      const result = await source.handleRequest({ method: `child:${RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3}`, params: { sessionId: 'session-1' },
        machineAdmission: admission, callerAuthority: 'present_user', authorization: { kind: 'session.write', sessionId: 'session-1' } });
      expect(result).toMatchObject({ actor: 'shared-actor', authority: 'present_user',
        prepared: { phase: 'prepared' }, aborted: { phase: 'aborted' } });
      expect(phases).toEqual(['prepare', 'abort']);
    } finally { get.mockRestore(); post.mockRestore(); vi.unstubAllGlobals(); identityStore.identity = priorIdentity; }
  });

  it.each([1, 2] as const)('signs the exact V%s machine admission payload with the original input proof', async (version) => {
    const key = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
    identityStore.identity = {
      version: 1, installationId: '11111111-1111-4111-8111-111111111111', createdAt: 1,
      publicKey: Buffer.from(key.publicKey).toString('base64url'), privateKey: Buffer.from(key.secretKey).toString('base64url'),
    };
    const authorization = { v: 1 as const, token: 'verified-home-proof', binding: {
      serverIdentityId: 'home', accountId: 'account', principalId: 'account',
      credentialId: '11111111-1111-4111-8111-111111111111', machineId: 'machine-1',
      custodianAccountId: 'account', installationId: '11111111-1111-4111-8111-111111111111',
      actionId: 'session.message.send', requestId: 'rpc-input', requestEnvelopeDigest: 'A'.repeat(43),
      target: { kind: 'session' as const, sessionId: 'session-1' }, grant: API_TOKEN_FULL_GRANT_V1,
    } };
    const request = {
      v: version, sessionId: 'session-1', targetMachineId: 'machine-1', localId: 'bound-input',
      content: { t: 'encrypted' as const, c: 'ciphertext' }, requestedAction: { v: 1 as const, kind: 'enqueue' as const },
      ...(version === 2 ? { recipient: { kind: 'execution_run' as const, runId: 'run-1' } } : {}),
    };
    const parsedRequest = version === 2
      ? SessionPendingExecutionRunEnqueueByMachineRequestV2Schema.parse(request)
      : SessionPendingEnqueueByMachineRequestV1Schema.parse(request);
    const client = new ApiMachineClient('daemon-token', createMachine());
    let emitted: unknown;
    const emitWithAck = vi.fn(async (_event: string, payload: unknown) => {
      emitted = payload;
      return { v: version, result: { status: 'accepted', localId: 'bound-input' } };
    });
    Reflect.set(client, 'socket', { connected: true, timeout: () => ({ emitWithAck }) });
    await expect(client.enqueueSessionPendingByMachine(parsedRequest, { callerInputAuthorization: authorization }))
      .resolves.toEqual({ status: 'accepted', localId: 'bound-input' });
    expect(emitted).toMatchObject({ externalAction: { authorization } });
    const proof = ExternalActionMachineRpcExecutionV1Schema.parse(
      (emitted as Record<string, unknown>).externalAction,
    );
    const event = version === 1 ? SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1 : SESSION_PENDING_EXECUTION_RUN_ENQUEUE_BY_MACHINE_EVENT_V2;
    const signatureInput = { authorizationToken: authorization.token, effectActionId: proof.effectActionId,
      target: proof.target, installationId: proof.installationId, event, method: event,
      requestId: authorization.binding.requestId, params: parsedRequest,
      publicKey: key.publicKey, signature: proof.machineSignature };
    expect(verifyExternalActionMachineRpcRequestV1(signatureInput)).toBe(true);
    expect(verifyExternalActionMachineRpcRequestV1({ ...signatureInput, params: { ...parsedRequest, localId: 'tampered' } })).toBe(false);
    identityStore.identity = null;
    emitWithAck.mockClear();
    await expect(client.enqueueSessionPendingByMachine(parsedRequest, { callerInputAuthorization: authorization }))
      .resolves.toEqual({ status: 'rejected', code: 'session_input_unauthorized' });
    expect(emitWithAck).not.toHaveBeenCalled();
  });

  it('dispatches target admission only through V2 and rejects an old acknowledgement', async () => {
    const client = new ApiMachineClient('token', createMachine());
    const emitWithAck = vi.fn().mockResolvedValue({ v: 1, result: { status: 'accepted', localId: 'target-input' } });
    Reflect.set(client, 'socket', { connected: true, timeout: () => ({ emitWithAck }) });
    const request = SessionPendingExecutionRunEnqueueByMachineRequestV2Schema.parse({
      v: 2, sessionId: 'session-1', targetMachineId: 'machine-1',
      recipient: { kind: 'execution_run', runId: 'run-a' }, localId: 'target-input',
      content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Target input' }, meta: {} } },
      requestedAction: { v: 1, kind: 'enqueue' },
    });
    await expect(client.enqueueSessionPendingByMachine(request)).resolves.toMatchObject({
      status: 'outcomeUnknown', localId: 'target-input',
    });
    expect(emitWithAck).toHaveBeenCalledWith(SESSION_PENDING_EXECUTION_RUN_ENQUEUE_BY_MACHINE_EVENT_V2, request);
    emitWithAck.mockResolvedValue({ v: 2, result: { status: 'accepted', localId: 'target-input' } });
    await expect(client.enqueueSessionPendingByMachine(request)).resolves.toEqual({ status: 'accepted', localId: 'target-input' });
  });
  it('returns a definite rejection when the socket is known disconnected before emit', async () => {
    const client = new ApiMachineClient('token', createMachine());
    const emitWithAck = vi.fn();
    Reflect.set(client, 'socket', { connected: false, emitWithAck });
    const request = SessionPendingEnqueueByMachineRequestV1Schema.parse({
      v: 1,
      sessionId: 'session-1',
      targetMachineId: 'machine-1',
      localId: 'plugin-input-v1:disconnected-before-emit',
      content: {
        t: 'plain',
        v: { role: 'user', content: { type: 'text', text: 'plugin prompt' }, meta: {} },
      },
      requestedAction: { v: 1, kind: 'steer_if_active' },
    });

    await expect(client.enqueueSessionPendingByMachine(request)).resolves.toEqual({
      status: 'rejected',
      code: 'session_input_target_unavailable',
    });
    expect(emitWithAck).not.toHaveBeenCalled();
  });

  it.each([
    ['operation has timed out', 'machine_socket_ack_timeout'],
    ['socket has been disconnected', 'machine_socket_disconnected'],
  ])('preserves uncertain custody after native ACK failure: %s', async (message, code) => {
    const client = new ApiMachineClient('token', createMachine());
    // Socket.IO is the network boundary; its native errors are not typed.
    const emitWithAck = vi.fn().mockRejectedValue(new Error(message));
    Reflect.set(client, 'socket', { connected: true, timeout: () => ({ emitWithAck }) });
    const request = SessionPendingEnqueueByMachineRequestV1Schema.parse({
      v: 1, sessionId: 'session-1', targetMachineId: 'machine-1', localId: 'first-input',
      content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'First turn' }, meta: {} } },
      requestedAction: { v: 1, kind: 'enqueue' },
    });
    await expect(client.enqueueSessionPendingByMachine(request)).resolves.toEqual({
      status: 'outcomeUnknown', localId: 'first-input', code,
    });
    expect(emitWithAck).toHaveBeenCalledTimes(1);
  });

  it('settles the socket acknowledgement on caller cancellation without serializing the signal', async () => {
    const client = new ApiMachineClient('token', createMachine());
    let acknowledge!: (value: unknown) => void;
    const emitWithAck = vi.fn((_event: string, _payload: unknown) => new Promise<unknown>((resolve) => {
      acknowledge = resolve;
    }));
    Reflect.set(client, 'socket', {
      connected: true,
      timeout: vi.fn(() => ({ emitWithAck })),
    });
    const cancellation = new AbortController();
    const request = SessionPendingEnqueueByMachineRequestV1Schema.parse({
      v: 1,
      sessionId: 'session-1',
      targetMachineId: 'machine-1',
      localId: 'plugin-input-v1:cancelled-machine-ack',
      content: {
        t: 'plain',
        v: {
          role: 'user',
          content: { type: 'text', text: 'plugin prompt' },
          meta: {},
        },
      },
      requestedAction: { v: 1, kind: 'steer_if_active' },
    });

    const pending = enqueueMachineAdmissionWithCancellation(client, request, cancellation.signal);
    await vi.waitFor(() => expect(emitWithAck).toHaveBeenCalledOnce());

    try {
      cancellation.abort();
      await expect(pending).resolves.toEqual({
        status: 'outcomeUnknown',
        localId: request.localId,
        code: 'machine_admission_cancelled_after_emit',
      });
      const [event, payload] = emitWithAck.mock.calls[0] ?? [];
      expect(event).toBe(SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1);
      expect(payload).toEqual(request);
      expect(payload).not.toHaveProperty('signal');
    } finally {
      acknowledge({
        v: 1,
        result: { status: 'accepted', localId: request.localId },
      });
      await pending.catch(() => undefined);
    }
  });

  it('rejects cancellation before emit with no possible server effect', async () => {
    const client = new ApiMachineClient('token', createMachine());
    const emitWithAck = vi.fn();
    Reflect.set(client, 'socket', {
      connected: true,
      timeout: vi.fn(() => ({ emitWithAck })),
    });
    const cancellation = new AbortController();
    cancellation.abort();
    const request = SessionPendingEnqueueByMachineRequestV1Schema.parse({
      v: 1,
      sessionId: 'session-1',
      targetMachineId: 'machine-1',
      localId: 'plugin-input-v1:cancelled-before-emit',
      content: {
        t: 'plain',
        v: { role: 'user', content: { type: 'text', text: 'plugin prompt' }, meta: {} },
      },
      requestedAction: { v: 1, kind: 'steer_if_active' },
    });

    await expect(enqueueMachineAdmissionWithCancellation(
      client,
      request,
      cancellation.signal,
    )).resolves.toEqual({
      status: 'rejected',
      code: 'session_input_cancelled',
    });
    expect(emitWithAck).not.toHaveBeenCalled();
  });
});
