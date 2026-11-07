import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it, onTestFinished, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { ApprovalRequestV2Schema, decodePlainArtifactStoredContent, FeaturesResponseSchema,
  RPC_METHODS, SocketRpcMachineAdmissionContextV1Schema } from '@happier-dev/protocol';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { RpcError } from '@happier-dev/protocol/rpcErrors';
import { WorkspaceSyncSeedExportPrepareV1Schema } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { ExternalActionDaemonDispatchRequestSchema } from '@happier-dev/protocol/actions/externalActionApi';
import type { RpcRequest } from '@/api/rpc/types';
import type { SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { DirectRouteGrantRequestV2Schema, SignedDirectRouteGrantV2Schema,
  type DirectRouteGrantRequestV2 } from '@happier-dev/protocol/machines/peer/mediation/directRouteGrantV2';
import { createEphemeralPeerRouteProofHandleV2 } from '@happier-dev/protocol/machines/peer/mediation/ephemeralPeerRouteProofV2';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { ApiClient } from '@/api/api';
import { dispatchOriginalAccountAction } from '@/api/externalActionExecutionAuthorization';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { maybeStartPeerMediationLoopback } from '@/daemon/machine/bootstrapMachineSyncRuntime';
import { IROH_MACHINE_ADMISSION_PATH, IROH_MACHINE_APPLICATION_CAPABILITY_HEADER,
  IROH_MACHINE_APPLICATION_PORT_HEADER, IROH_MACHINE_REMOTE_ENDPOINT_HEADER } from '@happier-dev/iroh-native/node';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { writeStoredCredentialsForServerId } from '@/persistence';
import { logger } from '@/ui/logger';
import { readProjectAccountRows } from '@/workspaces/projectAccountRows';
import { createRequesterWorkspaceSyncFixture } from '@/daemon/startup/createRequesterWorkspaceSyncFixture.testkit';
import { workspaceCheckoutNativeBoundary as native } from '@/workspaces/activation/workspaceCheckoutNative.testkit';
import { createExternalMcpServer } from './createExternalMcpServer';
import { db } from '../../../server/sources/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '../../../server/sources/testkit/lightSqliteHarness';
import { resolveMachineAdmission } from '../../../server/sources/app/machines/machineAccess';
import { createExternalActionHomeProcessForTests, type ExternalActionHomeForTests } from '../../../server/sources/testkit/externalActionExecution.testkit.mjs';

const socketIo = vi.hoisted(() => vi.fn());
vi.mock('socket.io-client', () => ({ io: socketIo }));
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>();
  const { requesterWorkspaceSyncInstallationFilesystemBoundary } = await import('@/daemon/startup/requesterWorkspaceSyncFilesystem.testkit');
  return requesterWorkspaceSyncInstallationFilesystemBoundary(actual);
});
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  const { workspaceCheckoutFilesystemBoundary } = await import('@/workspaces/activation/workspaceCheckoutNative.testkit');
  return workspaceCheckoutFilesystemBoundary(actual);
});
vi.mock('../../../../packages/cli-common/src/process/execFileWithDeadline', async original => {
  const actual = await original<typeof import('../../../../packages/cli-common/src/process/execFileWithDeadline')>();
  const { requesterWorkspaceSyncExecBoundary } = await import('@/daemon/startup/requesterWorkspaceSyncProcess.testkit');
  return { ...actual, execFileWithDeadline: (...args: Parameters<typeof actual.execFileWithDeadline>) =>
    requesterWorkspaceSyncExecBoundary(actual, args) };
});
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>();
  const { spawnRequesterWorkspaceSyncProcessBoundary } = await import('@/daemon/startup/requesterWorkspaceSyncProcess.testkit');
  return { ...actual, spawn: (command: string, args: readonly string[], options: import('node:child_process').SpawnOptions) =>
    spawnRequesterWorkspaceSyncProcessBoundary(actual, command, args, options, false) };
});

let sqlite: LightSqliteHarness;
beforeAll(async () => { sqlite = await createLightSqliteHarness({ tempDirPrefix: 'happier-mcp-requester-',
  initAuth: false, initEncrypt: false, initFiles: false }); }, 120_000);
afterAll(async () => { if (sqlite) await sqlite.close(); vi.unstubAllGlobals(); });
beforeEach(async () => { native.reset(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  // This harness owns the disposable SQLite boundary for each entry journey.
  await db.machineAccountGrant.deleteMany(); await db.machine.deleteMany(); await db.account.deleteMany();
});

it.skipIf(process.platform !== 'linux').each(['create', 'retire', 'retire-owner', 'terminate'] as const)('approves standalone MCP worker %s with original requester custody', async cleanup => {
  const rawTargetAdmissions: unknown[] = [];
  const machineTransports: unknown[] = [];
  const homeResponses: Array<Readonly<{ path: string; status: number; code?: string }>> = [];
  const homeMachineCalls: Array<Readonly<{ senderMachineId: string; method: string; ok: boolean }>> = [];
  const homeGrants: Array<Readonly<{ status: number; flowKind: string; operationKind: string; ok: boolean; reasonCode?: string }>> = [];
  const nativeAdmissions: Array<Readonly<{ status: number; actorAccountId: string; operationId: string }>> = [];
  const nativeScopeRefusals: Array<Readonly<{ kind: string; code?: string | null }>> = [];
  let targetInstalledGraphReads = 0;
  const nativeFetch = globalThis.fetch;
  let originalHome: ExternalActionHomeForTests | undefined;
  let carrierApi: ApiClient | undefined;
  let carrierGrantRequest: DirectRouteGrantRequestV2 | undefined;
  const warning = vi.spyOn(logger, 'warnLocalFile');
  let nativeTarget: Awaited<ReturnType<typeof maybeStartPeerMediationLoopback>> = null;
  const machineReceivers = new Map<string, (packet: RpcRequest) => Promise<unknown>>();
  const targetCustodian = 'target-custodian';
  const sourceCustodian = cleanup === 'create' || cleanup === 'retire-owner' ? 'member-a' : 'source-custodian';
  const setup = await createRequesterWorkspaceSyncFixture({ role: 'manage', socketIo,
    sourceCustodianAccountId: sourceCustodian, targetCustodianAccountId: targetCustodian,
    remoteTarget: true, workerCleanCopy: true, remoteSeed: true, originalActionHomeHttp: true,
    nativeCarrierHome: {
      resolveTrustRoots: () => originalHome?.peerMediationGrantSigningKeys ?? [],
      // Remote Machine publication is the network boundary. Home independently
      // checks these exact endpoint identities against its actual SQLite rows.
      readTargetMachine: async id => ({ id, operationProtocolCapabilitiesRevision: 1,
        operationProtocolCapabilities: { irohMachineEndpoint: { protocolVersions: [1],
          endpointId: (id === 'target-parent' ? 'b' : 'a').repeat(64), directAddresses: ['127.0.0.1:7777'] } } }),
      mintGrant: async (request, signal) => {
        if (!carrierApi) throw new Error('Home carrier API is unavailable');
        carrierGrantRequest = request;
        return carrierApi.mintPeerMediationRouteGrant(request, signal ? { signal } : undefined);
      },
      admitNativeTunnel: async ({ handshake, authenticatedRemoteEndpointId }) => {
        const target = setup.fixture.targetParent;
        const machineIrohRuntime = setup.fixture.nativeCarrierRuntimes.get('target-parent');
        if (!target || !setup.targetMachine || !machineIrohRuntime || !originalHome
          || handshake.flow !== 'workspace_sync' || handshake.initiator.kind !== 'machine') {
          throw new Error('Native target fixture is unavailable');
        }
        // These daemons share a test process. At the native process boundary,
        // load B's actual HTTP rows so A's last publication cannot stand in for
        // B's installed Account graph. The prepared endpoint belongs to A.
        const installedTarget = await readProjectAccountRows({ credentials: setup.fixture.targetCredentials,
          serverId: setup.installed.homeServerIdentityId, publication: 'installed' });
        targetInstalledGraphReads++;
        expect(installedTarget.workspaceRefs.map(ref => ref.id)).toEqual(['target-custodian-private-ref']);
        expect(installedTarget.workspaceRefs.some(ref => ref.id === setup.targetRef.id)).toBe(false);
        const ingressRequest = { operationId: handshake.operationId,
          sourceMachineId: handshake.initiator.machineId, targetMachineId: handshake.target.machineId,
          actorAccountId: handshake.accountId };
        // The prepared TARGET owner must reject another actor on this actual
        // retained job, and must not fall through to B's installed authority.
        const tryIngress = async (request: typeof ingressRequest) => {
          try {
            const admitted = await target.acquireWorkspaceSyncMachineIngress(request);
            await admitted.close();
            return { kind: 'admitted' } as const;
          } catch (error) {
            const refusal = error as { code?: unknown; workspaceSyncIngressRefusal?: unknown };
            return { kind: 'refused', code: refusal.code,
              workspaceSyncIngressRefusal: refusal.workspaceSyncIngressRefusal } as const;
          }
        };
        for (const request of [{ ...ingressRequest, actorAccountId: 'unrelated-account' },
          { ...ingressRequest, operationId: 'unrelated-operation' }]) {
          const result = await tryIngress(request);
          nativeScopeRefusals.push(result);
          expect(result).toEqual({ kind: 'refused', code: 'peer_unavailable',
            workspaceSyncIngressRefusal: request.operationId === ingressRequest.operationId
              ? 'retained_actor_mismatch' : 'rehydration_actor_mismatch' });
        }
        if (!nativeTarget) {
          nativeTarget = await maybeStartPeerMediationLoopback({
            config: { accountId: targetCustodian, serverFeatures: FeaturesResponseSchema.parse({ features: {},
              capabilities: { machines: { peerMediation: { grantSigningKeys: originalHome.peerMediationGrantSigningKeys } } },
            }) }, connectedApiMachine: setup.targetMachine, machineId: 'target-parent',
            machine: { id: 'target-parent', encryptionMode: 'plain', metadata: null, metadataVersion: 0,
              daemonState: null, daemonStateVersion: 0 },
            machineIrohRuntime, directPeerServerLifecycle: null,
            // Production supplies the daemon's authenticated Home trust roots here.
            resolvePeerMediationTrustRoots: () => originalHome!.peerMediationGrantSigningKeys
              .map(key => ({ keyId: key.keyId, publicKey: key.publicKey, expiresAt: key.expiresAt })),
            acquireWorkspaceSyncMachineIngress: target.acquireWorkspaceSyncMachineIngress,
          });
          if (!nativeTarget) throw new Error('Native target acceptor is unavailable');
          onTestFinished(() => nativeTarget!.stop());
          // A real Home grant authenticates A but does not invent a prepared
          // target. Exercise the refusal through the same signed acceptor as
          // the successful worker, and retain its secret-free owner reason.
          if (!carrierApi || !carrierGrantRequest || carrierGrantRequest.scope.kind !== 'machine_rpc') {
            throw new Error('Native carrier grant fixture is unavailable');
          }
          const proof = createEphemeralPeerRouteProofHandleV2({ randomBytes });
          try {
            const grant = SignedDirectRouteGrantV2Schema.parse(await carrierApi.mintPeerMediationRouteGrant(
              DirectRouteGrantRequestV2Schema.parse({ ...carrierGrantRequest,
                ephemeralPublicKeyBase64Url: proof.publicKeyBase64Url,
                scope: { ...carrierGrantRequest.scope, rpcScopeId: 'unrelated-operation' } })));
            const refused = await nativeFetch(new URL(IROH_MACHINE_ADMISSION_PATH, nativeTarget.endpoint.url), {
              method: 'POST', headers: { 'content-type': 'application/json',
                [IROH_MACHINE_REMOTE_ENDPOINT_HEADER]: authenticatedRemoteEndpointId },
              body: JSON.stringify({ ...handshake, operationId: 'unrelated-operation', grant, proof: proof.sign(grant) }),
            });
            expect(refused.status).toBe(403);
            expect(warning.mock.calls).toContainEqual(['[PeerMediation] Machine stream admission refused', {
              reason: 'target_failed', flow: 'workspace_sync', errorCode: 'peer_unavailable',
              workspaceSyncIngressRefusal: 'rehydration_actor_mismatch',
            }]);
          } finally { proof.dispose(); }
        }
        // The substituted native C ABI forwards the signed handshake to the
        // real acceptor and exposes only its admitted local application port.
        const response = await nativeFetch(new URL(IROH_MACHINE_ADMISSION_PATH, nativeTarget.endpoint.url), {
          method: 'POST', headers: { 'content-type': 'application/json',
            [IROH_MACHINE_REMOTE_ENDPOINT_HEADER]: authenticatedRemoteEndpointId }, body: JSON.stringify(handshake),
        });
        nativeAdmissions.push({ status: response.status, actorAccountId: handshake.accountId, operationId: handshake.operationId });
        if (response.status !== 204) throw new Error(`Native target admission refused (HTTP ${response.status})`);
        const localCapability = response.headers.get(IROH_MACHINE_APPLICATION_CAPABILITY_HEADER);
        if (!localCapability) throw new Error('Native target omitted its application capability');
        return { port: Number(response.headers.get(IROH_MACHINE_APPLICATION_PORT_HEADER)), localCapability };
      },
    },
    forwardHomeRpc: async (payload, receive) => {
      if (!originalHome || !payload || typeof payload !== 'object' || !('method' in payload)
        || typeof payload.method !== 'string' || !('params' in payload)) throw new Error('Incomplete Home socket request');
      // This fixture substitutes a remote socket only. The child receives and
      // admits the original signed payload before the real native receiver runs.
      const packet = payload as SocketRpcRequestPayload;
      machineReceivers.set(packet.method, receive);
      const senderMachineId = 'workspaceSyncSeedRouting' in packet ? 'target-parent' : setup.installed.machineId;
      try {
        const response = await originalHome.forwardMachineRpc(senderMachineId, packet);
        homeMachineCalls.push({ senderMachineId, method: packet.method,
          ok: Boolean(response && typeof response === 'object' && 'ok' in response && response.ok === true) });
        return response;
      }
      finally { machineReceivers.delete(packet.method); }
    },
    readHomePost: async (url, body, config) => {
      const path = new URL(url).pathname;
      if (!path.startsWith('/v1/actions/')
        && path !== '/v1/machines/peer/mediation/route-grants') return undefined;
      if (!originalHome) throw new Error('Original Home is not ready');
      const headers = Object.fromEntries(Object.entries(config?.headers ?? {})
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
      const response = await originalHome.request('POST', path, body, headers);
      const responseCode = response.data && typeof response.data === 'object' && 'code' in response.data
        && typeof response.data.code === 'string' ? response.data.code : undefined;
      homeResponses.push({ path, status: response.status, ...(responseCode ? { code: responseCode } : {}) });
      if (path.endsWith('/route-grants')) {
        const request = DirectRouteGrantRequestV2Schema.parse(body);
        if (!request.iroh) throw new Error('Native grant omitted its transport binding');
        const result = response.data && typeof response.data === 'object' ? response.data : {};
        homeGrants.push({ status: response.status, flowKind: request.flowKind, operationKind: request.iroh.operationKind,
          ok: 'ok' in result && result.ok === true,
          ...('reasonCode' in result && typeof result.reasonCode === 'string' ? { reasonCode: result.reasonCode } : {}) });
      }
      if (response.status === 200 && path.endsWith('/execution-authorization')) setup.adoptHomeAuthorization(response.data);
      return response;
    },
    readRawMachineAdmission: async payload => {
      const method = payload.method.slice(payload.machineId.length + 1);
      const actorAccountId = payload.token ? readAccountIdFromToken(payload.token) : null;
      if (!actorAccountId) throw new Error('Machine transport credential has no Account');
      const admission = await resolveMachineAdmission({ actorAccountId, machineId: payload.machineId,
        rpcMethod: method, requireOnline: true, callerAuthority: 'present_user' });
      machineTransports.push({ machineId: payload.machineId, method, actorAccountId, admission });
      if (payload.machineId === 'target-parent') rawTargetAdmissions.push({ method, admission });
      if (admission.kind !== 'admitted') throw new RpcError(admission.code, 'RPC_FORBIDDEN');
      const { kind: _admitted, ...context } = admission;
      return SocketRpcMachineAdmissionContextV1Schema.parse(context);
    } });
  originalHome = await createExternalActionHomeProcessForTests({
    serverIdentityId: setup.installed.homeServerIdentityId, accountId: sourceCustodian,
    ...(sourceCustodian !== 'member-a' ? { manageGranteeAccountId: 'member-a' } : {}),
    machineId: setup.installed.machineId, installationId: setup.installed.installation.installationId,
    installationPublicKey: Buffer.from(setup.installed.installation.publicKey, 'base64url'),
    workspaceSyncTarget: { accountId: targetCustodian, machineId: 'target-parent',
      installationId: setup.targetInstallation.installationId,
      installationPublicKey: Buffer.from(setup.targetInstallation.publicKey, 'base64url') },
    dispatch: async (packet, { signal }) => {
      const receive = machineReceivers.get(packet.method);
      if (receive) return receive({ ...packet, signal });
      setup.homeActionRequests.push(ExternalActionDaemonDispatchRequestSchema.parse(packet.params));
      return setup.installed.rpcHandlerManager.handleRequest({ ...packet, signal });
    },
  });
  onTestFinished(() => originalHome!.close());
  const requesterToken = originalHome.manageGrantee?.token ?? originalHome.token;
  carrierApi = await ApiClient.create({ ...setup.credentials, token: requesterToken });
  await db.account.createMany({ data: [...new Set(['member-a', sourceCustodian, targetCustodian])].map(id => ({ id, encryptionMode: 'plain' })) });
  await db.machine.create({ data: { id: 'target-parent', accountId: targetCustodian, active: true,
    installationId: setup.targetInstallation.installationId,
    operationProtocolCapabilities: { requesterExecutionIsolation: { protocolVersions: [1] } }, operationProtocolCapabilitiesRevision: 1,
    metadata: encodePlainMachineStoredContent({ host: 'target', platform: 'linux', happyCliVersion: 'test',
      homeDir: '/target', happyHomeDir: '/target/.happier' }), dataEncryptionKey: Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64') } });
  await db.machine.create({ data: { id: setup.installed.machineId, accountId: sourceCustodian, active: true,
    installationId: setup.installed.installation.installationId,
    metadata: encodePlainMachineStoredContent({ host: 'source', platform: 'linux', happyCliVersion: 'test',
      homeDir: '/source', happyHomeDir: '/source/.happier' }), dataEncryptionKey: Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64') } });
  await db.machineAccountGrant.create({ data: { machineId: 'target-parent', accountId: 'member-a',
    accessLevel: 'admin', createdByAccountId: targetCustodian } });
  if (sourceCustodian !== 'member-a') await db.machineAccountGrant.create({ data: {
    machineId: setup.installed.machineId, accountId: 'member-a', accessLevel: 'admin', createdByAccountId: sourceCustodian } });
  for (const method of [RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_PREPARE,
    RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_RELEASE]) {
    expect(await resolveMachineAdmission({ actorAccountId: 'member-a', machineId: 'target-parent',
      rpcMethod: method, requireOnline: true, callerAuthority: 'present_user' }))
      .toEqual({ kind: 'denied', code: 'custodian_only' });
  }
  await writeFile(join(setup.targetPath, 'target-only.txt'), 'requires replacement approval');
  await setup.prepareActionIngress();
  const targetRowsBefore = structuredClone(setup.targetAccountRows);
  const targetReadsBefore = setup.targetAccountRowRequests.length;
  // Original issuance, signed control RPCs and carrier grants use real Home
  // HTTP/socket admission. Finite seed transfer keeps its canonical listener boundary.
  const features = FeaturesResponseSchema.parse({ features: { sessions: { enabled: true, board: { enabled: true } } },
    capabilities: { serverIdentity: { serverIdentityId: setup.installed.homeServerIdentityId } } });
  const fixtureFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return new URL(url).pathname === '/v1/features' ? Response.json(features) : await fixtureFetch(input, init);
  });
  await writeStoredCredentialsForServerId(setup.installed.serverId, setup.installed.bootstrap.credentials);
  const { mcp } = runWithServerHttpBaseUrl(setup.installed.serverHttpBaseUrl, () => createExternalMcpServer({
    credentials: { ...setup.credentials, token: requesterToken }, machineId: 'current-client-machine', daemonControlTarget: null,
    serverFeaturesSnapshot: { status: 'ready', features } }));
  const client = new Client({ name: 'worker-approval', version: '1' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await mcp.connect(serverTransport); await client.connect(clientTransport);
  try {
    // Foreign-controller setup requires the existing explicit human credential
    // disclosure. Cleanup itself still enters standalone MCP below.
    const seeded = sourceCustodian !== 'member-a' ? await dispatchOriginalAccountAction({
      actionId: 'workspace.sync.relationship.create', input: setup.request.actionInput,
      requestId: setup.request.operationId, target: { kind: 'machine', machineId: setup.installed.machineId },
      credentials: { ...setup.credentials, token: requesterToken }, serverHttpBaseUrl: setup.installed.serverHttpBaseUrl,
      serverIdentityId: setup.installed.homeServerIdentityId,
      invocation: { surface: 'ui', authority: 'present_user', caller: { kind: 'host' } }, authority: 'present_user',
      onRequesterSessionCredentialDisclosure: () => true,
    }) : null;
    const reply = CallToolResultSchema.parse(seeded ? { content: [{ type: 'text', text: JSON.stringify(
      seeded.ok ? seeded.result : seeded) }], isError: !seeded.ok }
      : await client.callTool({ name: 'action_execute', arguments: {
        actionId: 'workspace.sync.relationship.create', input: setup.request.actionInput } }));
    expect(reply.isError, JSON.stringify({ reply, homeResponses, homeMachineCalls, rawTargetAdmissions, diagnostics: setup.rpcDiagnostics,
      homePlacements: setup.homeActionRequests.map(request => ({ actionId: request.actionId, placement: request.placement })) })).not.toBe(true);
    const text = reply.content.find(entry => entry.type === 'text');
    const proposed = text?.type === 'text' ? JSON.parse(text.text) : null;
    expect(proposed).toMatchObject({ kind: 'approval_request_created', artifactId: expect.any(String) });
    expect(homeMachineCalls).toContainEqual({ senderMachineId: setup.installed.machineId,
      method: `target-parent:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT}`, ok: true });
    const readApproval = () => {
      const artifact = setup.approvalArtifacts.get(proposed.artifactId);
      const body = decodePlainArtifactStoredContent(String(artifact?.body));
      if (!body || typeof body !== 'object' || !('body' in body) || typeof body.body !== 'string') throw new Error('Missing approval body');
      return ApprovalRequestV2Schema.parse(JSON.parse(body.body));
    };
    expect(readApproval()).toMatchObject({ status: 'open', executionOriginV1: { machineId: setup.installed.machineId,
      target: { kind: 'machine', machineId: setup.installed.machineId } } });
    await client.close(); await mcp.close();
    const home = setup.homeActionRequests[0];
    const invocation = await setup.prepareInvocation({ v: 1,
      operationId: readApproval().executionOriginV1!.requestId, actionInput: setup.request.actionInput },
      home?.executionAuthorization ? { envelope: home.envelope, authorization: home.executionAuthorization } : undefined);
    const decided = await setup.executeApprovalDecision(proposed.artifactId, invocation);
    expect(decided, JSON.stringify({ decided, homeGrants, nativeAdmissions, nativeScopeRefusals, rawTargetAdmissions, machineTransports,
      nativeIngressRefusals: warning.mock.calls.filter(([message]) => message === '[PeerMediation] Machine stream admission refused')
        .map(([, reason]) => reason),
      target: setup.targetRpcDiagnostics, source: setup.rpcDiagnostics }))
      .toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
    expect(readApproval()).toMatchObject({ status: 'executed' });
    expect(homeGrants).toContainEqual({ status: 200, flowKind: 'machine_rpc', operationKind: 'workspace_sync', ok: true });
    expect(nativeAdmissions).toContainEqual({ status: 204, actorAccountId: 'member-a', operationId: expect.any(String) });
    expect(home?.placement.machineId).toBe(setup.installed.machineId);
    expect(await readFile(join(setup.targetPath, 'payload.txt'), 'utf8')).toBe('before quiesce');
    expect(homeMachineCalls).toContainEqual({ senderMachineId: 'target-parent',
      method: `${setup.installed.machineId}:${RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE}`, ok: true });
    expect(rawTargetAdmissions).toEqual([]);
    expect(machineTransports).toEqual([]);
    const seed = setup.seedRequests[0];
    if (!seed) throw new Error('Missing admitted SOURCE seed request');
    expect(await setup.authorizeSourceRequest({ ...seed,
      params: { ...WorkspaceSyncSeedExportPrepareV1Schema.parse(seed.params), operationId: 'unrelated-operation' },
    }, 'authenticated_home_socket')).toMatchObject({ ok: false, errorCode: 'RPC_FORBIDDEN' });
    expect(setup.rows.find(row => row.key.kind === 'relationship-graph')?.content).toMatchObject({ t: 'plain',
      v: { value: { relationships: expect.arrayContaining([expect.objectContaining({
        controllerMachineId: setup.installed.machineId, provenance: expect.objectContaining({ kind: 'worker_clean_copy',
          sourceWorkspaceRefId: setup.sourceRef.id, targetWorkspaceRefId: setup.targetRef.id }),
      })]) } } });
    expect(setup.targetAccountRows).toEqual(targetRowsBefore);
    expect(setup.targetAccountRowRequests).toHaveLength(targetReadsBefore + targetInstalledGraphReads);
    expect(setup.targetRpcDiagnostics).toContainEqual({ message: 'Target receiver input', data: expect.objectContaining({
      method: `target-parent:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_PREPARE}`, targetRootMatches: true }) });
    if (cleanup !== 'create') {
      const custody = setup.fixture.parent.handoffAdapter.listPrivateExecutions?.()[0]?.execution.accountRowsCustody;
      if (!custody) throw new Error('Requester relationship custody is unavailable');
      const snapshot = await readProjectAccountRows({ credentials: setup.credentials,
        sessionCustody: custody, serverId: setup.installed.homeServerIdentityId,
        selection: { kinds: ['workspace-ref', 'relationship-graph'] } });
      const relationship = snapshot.relationships[0];
      if (!relationship) throw new Error('Created relationship is unavailable');
      const actionId = cleanup === 'terminate' ? 'workspace.sync.relationship.terminate' : 'projects.worker.copy.retire';
      const input = cleanup !== 'terminate' ? { workspace: { serverId: setup.installed.homeServerIdentityId, refId: setup.sourceRef.id },
        machineId: setup.installed.machineId, expectedRelationship: relationship }
        : { controllerMachineId: setup.installed.machineId, relationshipId: relationship.relationshipId };
      const next = runWithServerHttpBaseUrl(setup.installed.serverHttpBaseUrl, () => createExternalMcpServer({
        credentials: { ...setup.credentials, token: requesterToken }, machineId: setup.installed.machineId, daemonControlTarget: null,
        serverFeaturesSnapshot: { status: 'ready', features } }));
      const nextClient = new Client({ name: 'worker-cleanup', version: '1' });
      const [nextServer, nextTransport] = InMemoryTransport.createLinkedPair();
      await next.mcp.connect(nextServer); await nextClient.connect(nextTransport);
      try {
        const reply = CallToolResultSchema.parse(await nextClient.callTool({ name: 'action_execute', arguments: { actionId, input } }));
        const body = reply.content.find(entry => entry.type === 'text');
        const proposal = body?.type === 'text' ? JSON.parse(body.text) : null;
        expect(proposal, JSON.stringify({ reply, homeResponses, homeMachineCalls })).toMatchObject({ kind: 'approval_request_created', artifactId: expect.any(String) });
        const cli = createCliActionExecutorFromCredentials({
          credentials: { ...setup.credentials, token: requesterToken }, serverId: setup.installed.serverId,
          serverApiUrl: setup.installed.serverHttpBaseUrl, machineId: setup.installed.machineId,
          resolveServerFeaturesSnapshot: () => ({ status: 'ready', features, provenance: 'authenticated' }),
          onRequesterSessionCredentialDisclosure: () => true,
        });
        const decision = await cli.execute('approval.request.decide', { artifactId: proposal.artifactId, decision: 'approve' }, {
          surface: 'cli', authority: 'present_user', serverId: setup.installed.serverId,
          actionCaller: { kind: 'host' }, actionRequestId: `approve-${cleanup}` });
        expect(decision, JSON.stringify({ decision, input, rowRequests: setup.requesterRowRequests.slice(-5),
          diagnostics: setup.rpcDiagnostics })).toMatchObject({ ok: true,
          result: { status: 'executed', execution: { ok: true, result: cleanup !== 'terminate'
            ? { status: 'retired' } : { terminated: true, relationshipId: relationship.relationshipId } } } });
        const after = await readProjectAccountRows({ credentials: setup.credentials,
          sessionCustody: custody, serverId: setup.installed.homeServerIdentityId,
          selection: { kinds: ['workspace-ref', 'relationship-graph'] } });
        expect(after.relationships).toEqual([]);
        const statuses = await setup.fixture.parent.workspaceSync.controller.list();
        expect(statuses.filter(status => status.relationshipId === relationship.relationshipId && status.state === 'watching')).toEqual([]);
        // A retired durable link cannot be reused merely because its old native
        // copy still exists. Enter Move through MCP, as in the live continuation.
        const workspace = { serverId: setup.installed.homeServerIdentityId, refId: setup.sourceRef.id };
        const destination = { kind: 'workers', destination: { kind: 'machine', machineId: 'target-parent' } };
        const moveReply = CallToolResultSchema.parse(await nextClient.callTool({ name: 'action_execute', arguments: {
          actionId: 'projects.service.relocate', input: { workspace, serviceName: 'worker', requestId: `move-after-${cleanup}`,
            sourceMachineId: setup.installed.machineId, currentTarget: { kind: 'managed_service', managedServiceId: 'source-service',
              machineId: setup.installed.machineId, workspaceId: setup.sourceRef.id, cwd: setup.sourcePath,
              declaration: { workspaceRefId: setup.sourceRef.id, selection: { kind: 'manifest', name: 'worker' } } },
            destination, selectedTarget: { machineId: 'target-parent' }, desiredPlacement: { workspace, serviceName: 'worker',
              expectedRevision: 'absent', expected: { kind: 'absent' }, value: { runsOn: destination, unavailable: 'fail' } } } } }));
        const moveBody = moveReply.content.find(entry => entry.type === 'text');
        expect(moveBody?.type === 'text' ? JSON.parse(moveBody.text) : null, JSON.stringify(moveReply))
          .toMatchObject({ errorCode: 'worker_copy_missing' });
        if (sourceCustodian !== 'member-a') expect(setup.custodianRows).toEqual(setup.custodianBefore);
        expect(setup.targetAccountRows).toEqual(targetRowsBefore);
      } finally { await nextClient.close(); await next.mcp.close(); }
    }
  } finally { await client.close(); await mcp.close(); }
}, 120_000);
