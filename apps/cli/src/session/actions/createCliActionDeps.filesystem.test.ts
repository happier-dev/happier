import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import * as fsPromises from 'node:fs/promises';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { registerFileSystemHandlers } from '@/rpc/handlers/fileSystem';
import type { ExternalActionIngressOwner } from '@/rpc/handlers/externalAction';
import { registerWorkspaceFileSearchHandler } from '@/rpc/handlers/workspaceFileSearch';
import { createFilesystemEffectAdmission } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';
import type { RpcHandler } from '@/api/rpc/types';
import type { RpcActionExecutorContext } from '@/rpc/handlers/_actionDispatchAdapter';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerHappierMcpBuiltInTools } from '@/mcp/server/registerHappierMcpBuiltInTools';
import { createCliActionDeps } from './createCliActionDeps';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { executeFilesystemMutationAction } from '@/rpc/handlers/fileSystem/pathMutationHandlers';
import { FILESYSTEM_MUTATION_ACTION_IDS, FilesystemCopyOutputSchema, FilesystemDownloadOutputSchema, FilesystemReadFileOutputSchema } from '@happier-dev/protocol/actions/filesystemActionFamily';
import { createCliActionExecutor } from './createCliActionExecutor';
import { createCliActionExecutorHarness } from './createCliActionExecutorHarness';
import { createCliActionExecutorFromCredentials } from './createCliActionExecutorFromCredentials';
import * as persistence from '@/persistence';
import * as serverProfiles from '@/server/serverProfiles';
import { ApiMachineClient } from '@/api/apiMachine';
import { authorizeMachineRpcRequest } from '@/api/machine/machineRpcAuthorization';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { accountSettingsParse, API_TOKEN_FULL_GRANT_V1, decodePlainArtifactStoredContent, SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import * as childProcess from 'node:child_process';
import { PassThrough } from 'node:stream';
import { basename, dirname } from 'node:path';
import { createActionOperationRunner } from '@/daemon/actionOperations/actionOperationRunner';
import { createActionOperationStore } from '@/daemon/actionOperations/actionOperationStore';
import { EventEmitter } from 'node:events';
import { socketRpcCodec } from '@happier-dev/sync-client';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { createSocketIoManagerStub } from '@/testkit/backends/apiSessionSocketHarness';
import { getSharedBlockingApprovalCoordinator } from '@happier-dev/protocol/actions/blockingApprovalCoordinator';
import { StoredApprovalRequestSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { readCarrierMutation } from '@/api/artifacts/accountArtifactStore.testkit';
import * as irohNative from '@happier-dev/iroh-native/node';
import tweetnacl from 'tweetnacl';
import { createServer } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { DirectRouteGrantRequestV2Schema, DirectRouteGrantPayloadV2Schema, createDirectRouteGrantSigningInputV2 } from '@happier-dev/protocol/machines/peer/mediation/directRouteGrantV2';
import { createTargetedActionRpcRequestV1, TargetedActionRpcRequestV1Schema } from '@happier-dev/protocol/actions/actionRpcTransport';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { createDirectTransferServerLifecycle } from '@/machines/transfer/directTransferServerLifecycle';
import { createPreparedFilesystemTransferActionExecutor, projectPreparedFilesystemActionResult } from '@/machines/transfer/createPreparedFilesystemTransferActionExecutor';
import { createPreparedFilesystemTransferClient } from '@/machines/transfer/preparedFilesystemTransferClient';
import { createActionOperationRpcHandlers } from '@/daemon/actionOperations/actionOperationRpcHandlers';
import { createActionToolExecutorBridge } from '@/agent/tools/happierTools/createActionToolExecutorBridge';
import type { ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { registerApprovalRpcHandlers } from '@/rpc/handlers/approvals';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { create as createTar } from 'tar';
import { DeploymentChildRpcV1Schema, HomeConnectionDescriptorV1Schema, IrohMachineHandshakeV1Schema,
  readDeploymentArchiveRpcEffectV1, type ActionExecutorContext } from '@happier-dev/protocol';
import { SOCKET_RPC_EVENTS, type SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { ACTION_OPERATION_RPC_METHODS_V2 } from '@happier-dev/protocol/actions/operations/v1';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import { ActionExecuteResultSchema, type ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { computeExternalActionRequestEnvelopeDigestV1, verifyExternalActionMachineRpcRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { ExternalActionExecutionAuthorizationV1Schema, ExternalActionRequestEnvelopeSchema } from '@happier-dev/protocol/actions/externalActionApi';
import { createExternalActionMachineRpcExecution, type DeploymentArchiveOriginForHost } from '@/api/externalActionExecutionAuthorization';
import { createDeploymentChildRequesterHarness } from '@/testkit/backends/deploymentChildRequesterHarness';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { createNativeComposeImageIdentity } from '@/daemon/local/services/launch/nativeComposeImageIdentity';
import { machineNativeEffectAdmission } from '@/daemon/local/services/launch/machineNativeEffectAdmission';
import { nativeRegistryPause310 } from '@/daemon/local/services/launch/nativeComposeImageRegistry.testkit';
import { adoptOwnServerImageArchives, resolveOwnServerImageArchivePathForHost } from '@/deployments/targets/ownServer/releaseProvenance';
import { resolveOwnServerDeploymentIdentityForHost } from '@/deployments/targets/ownServer/paths';
import { configuration } from '@/configuration';
import { readOrCreateInstallationIdentitySync } from '@/daemon/identity/store';
import { createDeploymentImageArchiveCopyForHost } from '@/deployments/targets/ownServer/imageArchiveCopy';
import { callExactMachineRpc } from '@/session/transport/rpc/machineRpc';
// Resolve the real API graph during collection rather than cold-transforming
// the lazy requester HTTP owner inside the finite-operation test deadline.
import '@/api/api';

const copySocketBoundary = vi.hoisted(() => ({ create: vi.fn() }));
const nativeProcessBoundary = vi.hoisted(() => ({
  spawn: vi.fn<(command: string, args?: readonly string[], options?: import('node:child_process').SpawnOptions) => import('node:child_process').ChildProcess | undefined>(),
}));
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: (...args: Parameters<typeof actual.spawn>) => nativeProcessBoundary.spawn(...args) ?? actual.spawn(...args) };
});
vi.mock('socket.io-client', async importOriginal => {
  const actual = await importOriginal<typeof import('socket.io-client')>();
  return { ...actual, io: (...args: Parameters<typeof actual.io>) => copySocketBoundary.create(...args) ?? actual.io(...args) };
});

async function createBoundFilesystemMachineClient(...args: ConstructorParameters<typeof ApiMachineClient>): Promise<ApiMachineClient> {
  const homeIdentityId = await serverProfiles.resolveServerProfileHomeIdentityId(configuration.activeServerId);
  if (!homeIdentityId) throw new Error('Missing filesystem fixture Home');
  const [token, machine, ownershipMetadata, lifecycleDependencies] = args;
  // Model the authenticated connection's held Home through its production port,
  // rather than letting a disconnected unit client discover it over real HTTP.
  return new ApiMachineClient(token, machine, ownershipMetadata, { ...lifecycleDependencies,
    resolveCurrentServerIdentityId: lifecycleDependencies?.resolveCurrentServerIdentityId ?? (() => homeIdentityId) });
}

function bindCurrentFilesystemOwner(client: ApiMachineClient, executor: ExternalActionIngressOwner['executor'], machineId = 'machine-test', serverId = 'home'): void {
  client.setRPCHandlers({
    // Unused process-lifecycle boundaries; filesystem execution remains real.
    spawnSession: async () => ({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED, errorMessage: 'Unavailable' } as const),
    stopSession: async () => true, requestShutdown: () => {},
  }, { externalActionIngressOwner: { currentServerId: serverId, executor,
    resolveTarget: async () => ({ kind: 'machine', machineId }) } });
}

/** Captured verified Home/OS ingress is the fixture boundary; the Action,
 * requester selector and physical filesystem owners below remain real. */
async function verifiedFilesystemPersonContext(actionId: import('@happier-dev/protocol').ActionId, input: unknown,
  options: Readonly<{ accountId?: string; signal?: AbortSignal; surface?: RpcActionExecutorContext['surface'];
    authority?: RpcActionExecutorContext['authority']; serverIdentityId?: string }> = {},
): Promise<RpcActionExecutorContext> {
  const accountId = options.accountId ?? 'daemon-owner';
  const installationId = readOrCreateInstallationIdentitySync().installationId;
  const target = { kind: 'machine' as const, machineId: 'machine-test' };
  const serverIdentityId = options.serverIdentityId ?? await serverProfiles.resolveServerProfileHomeIdentityId(configuration.activeServerId) ?? 'home';
  return { authority: options.authority ?? 'present_user', surface: options.surface ?? 'rpc', serverId: 'home', runtimeAccountId: accountId,
    signal: options.signal ?? new AbortController().signal, externalActionTarget: target,
    machineAdmission: { actorAccountId: accountId, custodianAccountId: accountId, machineId: 'machine-test',
      installationId, role: 'use', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true,
    callerInputAuthorization: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'fixture-person-home-admission', binding: {
      accountId, authentication: { kind: 'account', tokenEpoch: 0 }, serverIdentityId,
      machineId: 'machine-test', custodianAccountId: accountId, installationId, actionId,
      requestId: 'present-person-filesystem', target, accountEncryptionMode: 'plain',
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(ExternalActionRequestEnvelopeSchema.parse({
        v: 1, requestId: 'present-person-filesystem', target, input,
      })),
    } }),
  };
}

function createReviewedFilesystemExecutor(
  params: Parameters<typeof createCliActionDeps>[0],
  overrides?: Parameters<typeof createCliActionExecutorHarness>[1],
) {
  return createCliActionExecutorHarness({ ...params,
    actionsSettingsProvider: createActionSettingsProvider({ accountSettings: accountSettingsParse({
      actionsSettingsV1: { v: 1, actions: {}, approvalWaivedSurfaces: {
        'daemon.filesystem.createDirectory': ['rpc'], 'daemon.filesystem.rename': ['rpc'],
        'daemon.filesystem.delete': ['rpc'], 'daemon.filesystem.copy': ['rpc'],
      } },
    }) }),
  }, overrides).executor;
}

describe('exact-machine filesystem Actions', () => {
  beforeEach(async () => {
    // The unit harness owns an isolated Home. Use its real installation store,
    // and replace only the authenticated Account-profile HTTP boundary.
    readOrCreateInstallationIdentitySync();
    if (!await serverProfiles.resolveServerProfileHomeIdentityId(configuration.activeServerId)) {
      const serverUrl = configuration.serverUrl;
      await serverProfiles.adoptServerProfileHomeConnectionDescriptor({ expectedProfileId: configuration.activeServerId,
        createIfMissing: true, observation: 'exact',
        descriptor: { v: 1, homeServerIdentityId: 'srv_filesystem_owner_fixture', canonicalServerUrl: serverUrl,
          revision: 1, endpoints: [{ kind: 'https', url: serverUrl }] } });
    }
    const originalGet = axios.get.bind(axios);
    vi.spyOn(axios, 'get').mockImplementation(async (url, options) => {
      if (String(url).endsWith('/v1/account/profile')) {
        const bearer = String(options?.headers?.Authorization ?? '').replace(/^Bearer /u, '');
        let accountId = 'owner';
        try {
          const payload: unknown = JSON.parse(Buffer.from(bearer.split('.')[1] ?? '', 'base64url').toString('utf8'));
          if (payload && typeof payload === 'object' && 'sub' in payload && typeof payload.sub === 'string') accountId = payload.sub;
        } catch { /* Opaque fixture tokens have the explicit owner fixture. */ }
        return { status: 200, data: { id: accountId } };
      }
      return originalGet(url, options);
    });
  });
  afterEach(() => { vi.restoreAllMocks(); });
  it('selects filesystem Action identity once while preserving owner bytes and foreign refusal', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-filesystem-single-identity-'));
    const homeIdentityId = await serverProfiles.resolveServerProfileHomeIdentityId(configuration.activeServerId);
    if (!homeIdentityId) throw new Error('Missing filesystem fixture Home');
    const bytes = Buffer.from([0, 255, 128, 10]);
    const input = { rootPath: directory, path: 'binary' };
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'daemon-owner' })).toString('base64url')}.signature`;
    const client = await createBoundFilesystemMachineClient(token, { id: 'machine-test', encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy', metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 });
    const owner = createCliActionExecutor({ token, sessionId: '', mode: 'plain', ctx: null,
      serverId: 'home', serverHttpBaseUrl: configuration.serverUrl, pluginActionExecutionOwner: 'current_process',
      filesystemActionExecute: client.createFilesystemActionExecutor('home') });
    bindCurrentFilesystemOwner(client, owner);
    const context = await verifiedFilesystemPersonContext('daemon.filesystem.readFile', input, { serverIdentityId: homeIdentityId });
    const foreignContext: RpcActionExecutorContext = { ...context,
      machineAdmission: { actorAccountId: 'foreign-requester', custodianAccountId: 'daemon-owner', machineId: 'machine-test',
        installationId: readOrCreateInstallationIdentitySync().installationId, role: 'use', encryptionMode: 'plain' } };
    // Observe only the real OS read of this unit fixture's installation file.
    // Every read still reaches the real store/parser and filesystem Action owner.
    const installationPath = configuration.installationIdentityFile;
    const installationReads = vi.spyOn(fs, 'readFileSync');
    const readCount = () => installationReads.mock.calls.filter(([path]) => path === installationPath).length;
    try {
      await writeFile(join(directory, 'binary'), bytes);
      const beforeOwner = readCount();
      expect(await owner.execute('daemon.filesystem.readFile', input, context))
        .toEqual({ ok: true, result: { success: true, content: bytes.toString('base64') } });
      const ownerReads = readCount() - beforeOwner;
      const beforeForeign = readCount();
      expect(await owner.execute('daemon.filesystem.readFile', input, foreignContext))
        .toMatchObject({ ok: false, errorCode: 'filesystem_identity_custody_unavailable',
          details: { reason: 'requester_identity_unavailable' } });
      const foreignReads = readCount() - beforeForeign;
      expect(await readFile(join(directory, 'binary'))).toEqual(bytes);
      expect({ ownerReads, foreignReads }).toEqual({ ownerReads: 1, foreignReads: 1 });
    } finally {
      installationReads.mockRestore();
      await client.shutdown(); await rm(directory, { recursive: true, force: true });
    }
  });
  it('refuses a Session MCP explicit-root read with copied owner Agent custody at the real filesystem effect owner', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-mcp-filesystem-deputy-'));
    const sessionRoot = join(directory, 'checkout');
    const privateRoot = join(directory, 'daemon-private');
    const homeIdentityId = await serverProfiles.resolveServerProfileHomeIdentityId(configuration.activeServerId) ?? 'home';
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'daemon-owner' })).toString('base64url')}.signature`;
    const client = await createBoundFilesystemMachineClient(token, { id: 'machine-test', encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy', metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 });
    const owner = createCliActionExecutor({ token, sessionId: '', mode: 'plain', ctx: null,
      serverId: 'home', serverHttpBaseUrl: 'https://home.test', pluginActionExecutionOwner: 'current_process',
      filesystemActionExecute: client.createFilesystemActionExecutor('home') });
    bindCurrentFilesystemOwner(client, owner);
    const machineAdmission = { actorAccountId: 'daemon-owner', custodianAccountId: 'daemon-owner', machineId: 'machine-test',
      installationId: readOrCreateInstallationIdentitySync().installationId, role: 'use' as const, encryptionMode: 'plain' as const };
    const target = { kind: 'machine' as const, machineId: 'machine-test' };
    const admittedContext = (actionId: import('@happier-dev/protocol').ActionId, input: unknown,
      authority: 'present_user' | 'account_automation'): RpcActionExecutorContext => ({
      authority, surface: authority === 'present_user' ? 'cli' : 'agent', serverId: 'home',
      ...(authority === 'account_automation' ? { sessionActionOrigin: { v: 1 as const,
        caller: { kind: 'session' as const, sessionId: 'owner-session', starterDepth: 0, turnDepth: 0 },
        sourceTurnId: 'owner-agent-turn', callerPermissionMode: null, requestId: 'copied-owner-filesystem' } } : {}),
      runtimeAccountId: 'daemon-owner', externalActionTarget: target, machineAdmission,
      verifyMachineAdmissionCurrent: async () => true,
      // Captured Home admission is the network boundary. The downstream
      // Action executor, selector, filesystem policy and IO stay real.
      callerInputAuthorization: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'fixture-home-authorization', binding: {
        accountId: 'daemon-owner', authentication: { kind: 'account', tokenEpoch: 0 }, serverIdentityId: homeIdentityId,
        machineId: 'machine-test', custodianAccountId: 'daemon-owner', installationId: machineAdmission.installationId, actionId,
        requestId: 'copied-owner-filesystem', target, accountEncryptionMode: 'plain',
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(ExternalActionRequestEnvelopeSchema.parse({
          v: 1, requestId: 'copied-owner-filesystem', target, input,
        })),
      } }),
    });
    const bridge = createActionToolExecutorBridge({ surface: 'agent', defaultSessionMachineId: 'machine-test',
      defaultSessionRootPath: sessionRoot, executor: { execute: (actionId, input) =>
        owner.execute(actionId, input, admittedContext(actionId, input, 'account_automation')) } });
    const mcp = new McpServer({ name: 'filesystem-custody-contract', version: '1' });
    registerHappierMcpBuiltInTools(mcp, { sessionId: 'owner-session', workingDirectory: sessionRoot,
      sessionMachineId: 'machine-test', surface: 'agent', requiredDirectActionIds: ['daemon.filesystem.readFile'],
      deps: { executeActionByToolName: bridge.executeActionByToolName,
        changeTitle: async () => { throw new Error('Unexpected title operation'); } } });
    const mcpClient = new Client({ name: 'copied-owner-session', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await mkdir(sessionRoot); await mkdir(privateRoot);
      await writeFile(join(privateRoot, 'private.txt'), 'synthetic-private-fixture', { mode: 0o600 });
      await mcp.connect(serverTransport); await mcpClient.connect(clientTransport);
      const input = { rootPath: privateRoot, path: 'private.txt' };
      const result = await mcpClient.callTool({ name: 'action_execute', arguments: { actionId: 'daemon.filesystem.readFile', input } });
      expect(result.isError).toBe(true);
      const serialized = JSON.stringify(result);
      expect(serialized.includes('filesystem_identity_custody_unavailable')).toBe(true);
      expect(serialized.includes(Buffer.from('synthetic-private-fixture').toString('base64'))).toBe(false);
      const positive = await owner.execute('daemon.filesystem.readFile', input,
        admittedContext('daemon.filesystem.readFile', input, 'present_user'));
      expect(positive.ok && positive.result && typeof positive.result === 'object'
        && 'success' in positive.result && positive.result.success === true).toBe(true);
    } finally { await mcpClient.close(); await mcp.close(); await client.shutdown(); await rm(directory, { recursive: true, force: true }); }
  });
  it('preserves requester authority through the filesystem search transport to the physical owner', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-search-requester-'));
    const handlers = new Map<string, RpcHandler>();
    registerWorkspaceFileSearchHandler({ registerHandler: (method, handler) => { handlers.set(method, handler); } }, directory, {
      effectAdmission: createFilesystemEffectAdmission({ resolveHomeServerIdentityId: async () => 'home' }),
    });
    const deps = createCliActionDeps({ token: 'test-token', sessionId: '', mode: 'plain', ctx: null,
      machineActionDirectTargetTransport: { machineId: 'machine-test', invoke: async (method, input, options) => {
        const handler = handlers.get(method);
        if (!handler) throw new Error('Missing registered search owner');
        return await handler(input, { ...options?.rpcContext,
          signal: options?.signal ?? new AbortController().signal,
          callerAuthority: options?.localActionContext?.authority,
        });
      } },
    });
    const search = deps.workspaceFilesSearch;
    if (!search) throw new Error('Missing filesystem search dependency');
    const context: RpcActionExecutorContext = { authority: 'present_user', machineAdmission: {
      actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'machine-test', installationId: 'installation',
      role: 'use', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true };
    try {
      await writeFile(join(directory, 'ordinary.txt'), 'needle');
      const input = { machineId: 'machine-test', rootPath: directory, query: 'needle' };
      const agentContext: RpcActionExecutorContext = { ...context, authority: 'account_automation', sessionActionOrigin: { v: 1,
        caller: { kind: 'session', sessionId: 'owner-agent-session', starterDepth: 0, turnDepth: 0 },
        sourceTurnId: 'owner-agent-turn', callerPermissionMode: null, requestId: 'owner-agent-search' } };
      const agent = await search(input, agentContext);
      expect({ ok: agent.ok, code: 'code' in agent ? agent.code : undefined }).toEqual({ ok: false, code: 'root_not_allowed' });
      const owner = await search(input, context);
      expect(owner).toMatchObject({ ok: true, files: [{ path: 'ordinary.txt' }] });
      expect(await search(input, { ...context, authority: 'account_automation' }))
        .toMatchObject({ ok: true, files: [{ path: 'ordinary.txt' }] });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('keeps Agent Session reads and approval replay from acquiring person filesystem rights', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-agent-filesystem-owner-'));
    const rootPath = join(directory, '.dev', 'worktree', 'accepted');
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'daemon-owner' })).toString('base64url')}.signature`;
    const client = new ApiMachineClient(token, { id: 'machine-test', encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy', metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 });
    const ownerSettings = createActionSettingsProvider({ accountSettings: accountSettingsParse({ actionsSettingsV1: {
      v: 1, actions: {}, approvalWaivedSurfaces: { 'daemon.filesystem.writeFile': ['rpc'] },
    } }) });
    const owner = createCliActionExecutor({ token, sessionId: '', mode: 'plain', ctx: null,
      serverId: 'home', serverHttpBaseUrl: 'https://home.test', pluginActionExecutionOwner: 'current_process', actionsSettingsProvider: ownerSettings,
      filesystemActionExecute: client.createFilesystemActionExecutor('home') });
    bindCurrentFilesystemOwner(client, owner);
    const manager = new RpcHandlerManager({ scopePrefix: 'machine-test', localMachineId: 'machine-test', encryptionMode: 'plain',
      authorizeRequest: request => authorizeMachineRpcRequest(request, {
        machineId: 'machine-test', resolveCustodianAccountId: async () => 'daemon-owner',
        resolveInstallationId: () => readOrCreateInstallationIdentitySync().installationId, verifyMachineAdmission: async () => true,
        resolveHomeServerIdentityId: () => serverProfiles.resolveServerProfileHomeIdentityId(configuration.activeServerId),
      }) });
    const registration = registerFileSystemHandlers(manager, directory, { mutationMachineId: 'machine-test',
      actionExecutor: { execute: (actionId, input, context) => owner.execute(actionId, input, {
        ...context, serverId: 'home', externalActionTarget: { kind: 'machine', machineId: 'machine-test' },
      }) } });
    const approval: { request: ApprovalRequest | null } = { request: null };
    let invokes = 0;
    const callerSettings = createActionSettingsProvider({ accountSettings: accountSettingsParse({ actionsSettingsV1: {
      v: 1, actions: { 'daemon.filesystem.writeFile': { approvalRequiredSurfaces: ['agent'] } },
    } }) });
    const caller = createActionExecutor({ ...createCliActionDeps({ token, sessionId: 'session-test', mode: 'plain', ctx: null,
      serverId: 'home', serverHttpBaseUrl: 'https://home.test', actionsSettingsProvider: callerSettings,
      machineActionDirectTargetTransport: { machineId: 'machine-test', invoke: (method, params) => {
        invokes += 1;
        return manager.handleRequest({ method: `machine-test:${method}`, params,
          callerAuthority: 'account_automation', machineAdmission: { actorAccountId: 'daemon-owner',
            custodianAccountId: 'daemon-owner', machineId: 'machine-test', installationId: 'installation',
            role: 'use', encryptionMode: 'plain' } });
      } },
    }),
    approvalsCreate: async ({ request: value }) => { approval.request = value; return { artifactId: 'filesystem-approval' }; },
    approvalsGet: async () => approval.request,
    approvalsUpdate: async ({ request: value }) => { approval.request = value; return { ok: true as const }; },
    isApprovalExecutionOriginCurrent: async () => true,
    });
    const bridge = (machineId?: string) => createActionToolExecutorBridge({ surface: 'agent',
      ...(machineId ? { defaultSessionMachineId: machineId } : {}), actionsSettings: callerSettings.getActionsSettings(),
      executor: { execute: (actionId, input, context) => caller.execute(actionId, input, {
        ...context, serverId: 'home', runtimeAccountId: 'daemon-owner', actionCaller: { kind: 'host' },
      }) } });
    try {
      const sourcePath = join(directory, 'source');
      await mkdir(sourcePath);
      childProcess.execFileSync('git', ['init', sourcePath], { stdio: 'ignore' });
      childProcess.execFileSync('git', ['-C', sourcePath, '-c', 'user.name=Filesystem test', '-c', 'user.email=filesystem@example.test',
        'commit', '--allow-empty', '-m', 'Initial'], { stdio: 'ignore' });
      childProcess.execFileSync('git', ['-C', sourcePath, 'worktree', 'add', '--detach', rootPath], { stdio: 'ignore' });
      await writeFile(join(rootPath, 'README'), 'agent-readable');

      const readOutcome = await bridge('machine-test').executeActionByToolName('action_execute', {
        actionId: 'daemon.filesystem.readFile', input: { rootPath, path: 'README' },
      }, 'session-test', { actionRequestId: 'agent-read' });
      const readFailure = readOutcome.ok ? FilesystemReadFileOutputSchema.parse(readOutcome.result) : readOutcome;
      expect('errorCode' in readFailure && typeof readFailure.errorCode === 'string').toBe(true);
      expect(await bridge('machine-test').executeActionByToolName('action_execute', {
        actionId: 'daemon.filesystem.writeFile', input: { rootPath, path: 'approved', content: Buffer.from('approved').toString('base64') },
      }, 'session-test', { actionRequestId: 'agent-write' })).toMatchObject({ ok: true, result: {
        kind: 'approval_request_created', artifactId: 'filesystem-approval',
      } });
      await expect(stat(join(rootPath, 'approved'))).rejects.toMatchObject({ code: 'ENOENT' });
      if (!approval.request) throw new Error('Missing filesystem approval');
      approval.request = { ...approval.request, status: 'approved', updatedAtMs: approval.request.updatedAtMs + 1,
        decision: { kind: 'approve', decidedAtMs: approval.request.updatedAtMs + 1 } };
      registerApprovalRpcHandlers({ rpcHandlerManager: manager, actionExecutor: caller });
      const beforeReplay = invokes;
      await manager.invokeLocal(RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED, { artifactId: 'filesystem-approval' }, {
        rpcContext: { callerAuthority: 'present_user', verifyMachineAdmissionCurrent: async () => true,
          machineAdmission: { actorAccountId: 'daemon-owner', custodianAccountId: 'daemon-owner',
            machineId: 'machine-test', installationId: readOrCreateInstallationIdentitySync().installationId,
            role: 'use', encryptionMode: 'plain' } },
      });
      expect(invokes > beforeReplay).toBe(true);
      await expect(stat(join(rootPath, 'approved'))).rejects.toMatchObject({ code: 'ENOENT' });

      const beforeMiswire = invokes;
      expect(await bridge().executeActionByToolName('action_execute', {
        actionId: 'daemon.filesystem.readFile', input: { rootPath, path: 'README' },
      }, 'session-test', { actionRequestId: 'agent-miswire' })).toMatchObject({ ok: false, errorCode: 'machine_not_selected' });
      expect(invokes).toBe(beforeMiswire);
    } finally {
      await registration.dispose(); await client.shutdown(); await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(['present_user', 'account_automation'] as const)('reads, edits and cleans exact scopes as %s through CLI deps and the full Machine filesystem owner', async authority => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-rooted-action-owner-'));
    const serverHttpBaseUrl = configuration.serverUrl;
    const homeIdentityId = await serverProfiles.resolveServerProfileHomeIdentityId(configuration.activeServerId);
    if (!homeIdentityId) throw new Error('Missing filesystem fixture Home');
    const rootPath = join(directory, '.dev', 'worktree', 'accepted');
    const bytes = Buffer.from([0, 255, 128, 10]);
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'daemon-owner' })).toString('base64url')}.signature`;
    const client = await createBoundFilesystemMachineClient(token, { id: 'machine-test', encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy', metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 });
    const settings = createActionSettingsProvider({ accountSettings: accountSettingsParse({ actionsSettingsV1: {
      v: 1, actions: {}, approvalWaivedSurfaces: { 'daemon.filesystem.writeFile': ['rpc'],
        'daemon.filesystem.createDirectory': ['rpc'], 'daemon.filesystem.rename': ['rpc'], 'daemon.filesystem.delete': ['rpc'] },
    } }) });
    const owner = createCliActionExecutor({ token, sessionId: '', mode: 'plain', ctx: null,
      serverId: 'home', serverHttpBaseUrl, pluginActionExecutionOwner: 'current_process', actionsSettingsProvider: settings,
      filesystemActionExecute: client.createFilesystemActionExecutor('home') });
    bindCurrentFilesystemOwner(client, owner);
    const manager = new RpcHandlerManager({ scopePrefix: 'machine-test', localMachineId: 'machine-test', encryptionMode: 'plain',
      authorizeRequest: request => authorizeMachineRpcRequest(request, {
        machineId: 'machine-test', resolveCustodianAccountId: async () => 'daemon-owner',
        resolveInstallationId: () => readOrCreateInstallationIdentitySync().installationId, verifyMachineAdmission: async () => true,
        resolveHomeServerIdentityId: async () => homeIdentityId,
      }) });
    const registration = registerFileSystemHandlers(manager, directory, { mutationMachineId: 'machine-test',
      effectAdmission: createFilesystemEffectAdmission({
        resolveHomeServerIdentityId: async () => homeIdentityId,
        resolveHostIdentity: async () => ({ custodianAccountId: 'daemon-owner', machineId: 'machine-test',
          installationId: readOrCreateInstallationIdentitySync().installationId }),
      }),
      actionExecutor: { execute: (actionId, input, context) => owner.execute(actionId, input, {
        ...context, serverId: 'home', externalActionTarget: { kind: 'machine', machineId: 'machine-test' },
      }) } });
    const caller = createCliActionExecutor({ token,
      credentials: { token, encryption: null, credentialProvenance: 'stored_session' },
      sessionId: '', mode: 'plain', ctx: null,
      serverId: 'home', serverHttpBaseUrl, pluginActionExecutionOwner: 'current_process', actionsSettingsProvider: settings,
      machineActionDirectTargetTransport: { machineId: 'machine-test',
        // The verified transport binds the Action id, including the declared
        // predecessor listDirectory method rather than treating it as an id.
        invoke: async (method, params, options) => {
          const actionId = method === RPC_METHODS.LIST_DIRECTORY ? 'daemon.filesystem.listDirectory' : ActionIdSchema.parse(method);
          return manager.invokeLocal(method, params, { ...options,
            rpcContext: { ...await verifiedFilesystemPersonContext(actionId, params, { authority,
              serverIdentityId: homeIdentityId }), callerAuthority: authority } });
        } } });
    const context = { surface: 'rpc' as const, serverId: 'home', runtimeAccountId: 'daemon-owner', authority,
      externalActionTarget: { kind: 'machine' as const, machineId: 'machine-test' } };
    try {
      const sourcePath = join(directory, 'source');
      await mkdir(sourcePath);
      childProcess.execFileSync('git', ['init', sourcePath], { stdio: 'ignore' });
      childProcess.execFileSync('git', ['-C', sourcePath, '-c', 'user.name=Filesystem test', '-c', 'user.email=filesystem@example.test',
        'commit', '--allow-empty', '-m', 'Initial'], { stdio: 'ignore' });
      childProcess.execFileSync('git', ['-C', sourcePath, 'worktree', 'add', '--detach', rootPath], { stdio: 'ignore' });
      await writeFile(join(rootPath, 'README'), bytes);
      await writeFile(join(directory, 'outside'), 'private outside bytes');
      for (const path of ['README', join(rootPath, 'README')]) {
        expect(await caller.execute('daemon.filesystem.readFile', { rootPath, path }, context))
          .toEqual({ ok: true, result: { success: true, content: bytes.toString('base64') } });
      }
      expect(await caller.execute('daemon.filesystem.readFile', { rootPath, path: join(directory, 'outside') }, context))
        .toMatchObject({ ok: true, result: { success: false, error: expect.any(String) } });
      expect(await caller.execute('daemon.filesystem.listDirectory', { rootPath, path: '.' }, context))
        .toMatchObject({ ok: true, result: { success: true, entries: expect.arrayContaining([expect.objectContaining({ name: 'README', type: 'file' })]) } });
      expect(await caller.execute('daemon.filesystem.getDirectoryTree', { rootPath, path: '.', maxDepth: 1 }, context))
        .toMatchObject({ ok: true, result: { success: true, tree: { children: expect.arrayContaining([expect.objectContaining({ name: 'README' })]) } } });
      expect(await caller.execute('daemon.filesystem.writeFile', { rootPath, path: 'binary', content: bytes.toString('base64') }, context))
        .toMatchObject({ ok: true, result: { success: true, hash: createHash('sha256').update(bytes).digest('hex') } });
      expect(await readFile(join(rootPath, 'binary'))).toEqual(bytes);
      expect(await caller.execute('daemon.filesystem.createDirectory', { rootPath, path: 'folder' }, context))
        .toEqual({ ok: true, result: { success: true } });
      expect(await caller.execute('daemon.filesystem.rename', { rootPath, from: 'binary', to: 'folder/moved', overwrite: false }, context))
        .toEqual({ ok: true, result: { success: true } });
      expect(await readFile(join(rootPath, 'folder/moved'))).toEqual(bytes);
      expect(await caller.execute('daemon.filesystem.delete', { rootPath, path: 'folder', recursive: true }, context))
        .toEqual({ ok: true, result: { success: true } });
      await expect(stat(join(rootPath, 'folder'))).rejects.toMatchObject({ code: 'ENOENT' });
      for (const actionId of ['daemon.filesystem.listDirectory', 'daemon.filesystem.getDirectoryTree'] as const) {
        expect(await caller.execute(actionId, { rootPath, path: directory,
          ...(actionId === 'daemon.filesystem.getDirectoryTree' ? { maxDepth: 1 } : {}) }, context))
          .toMatchObject({ ok: true, result: { success: false, error: expect.any(String) } });
      }
      expect(await caller.execute('daemon.filesystem.writeFile', { rootPath, path: join(directory, 'outside'),
        content: bytes.toString('base64') }, context)).toMatchObject({ ok: true, result: { success: false, error: expect.any(String) } });
      expect(await readFile(join(directory, 'outside'), 'utf8')).toBe('private outside bytes');
      if (process.platform !== 'win32') {
        await symlink(join(directory, 'outside'), join(rootPath, 'outside-link'));
        expect(await caller.execute('daemon.filesystem.readFile', { rootPath, path: 'outside-link' }, context))
          .toMatchObject({ ok: true, result: { success: false } });
      }
      const cleanupScope = join(directory, 'empty-owned-scope');
      await mkdir(cleanupScope);
      expect(await caller.execute('daemon.filesystem.delete', { rootPath: directory, path: cleanupScope, recursive: false }, context))
        .toMatchObject({ ok: true, result: { success: false, errorCode: 'recursive_required' } });
      expect(await caller.execute('daemon.filesystem.delete', { rootPath: directory, path: cleanupScope, recursive: true }, context))
        .toEqual({ ok: true, result: { success: true } });
      await expect(stat(cleanupScope)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(join(directory, 'outside'), 'utf8')).toBe('private outside bytes');
    } finally { await registration.dispose(); await client.shutdown(); await rm(directory, { recursive: true, force: true }); }
  });
  it('projects a real prepared upload through the ApiMachine factory and full Action terminal output boundary', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'happier-upload-full-owner-'));
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'account-one' })).toString('base64url')}.signature`;
    const lifecycle = createDirectTransferServerLifecycle({ bindPort: 0, listenerClasses: ['loopback_http'] });
    const client = await createBoundFilesystemMachineClient(token, { id: 'machine-test', encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy',
      metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 }, undefined, { directPeerServerLifecycle: lifecycle });
    const owner = createCliActionExecutor({ token, sessionId: '', mode: 'plain', ctx: null, serverId: 'home',
      serverHttpBaseUrl: 'http://localhost:1', pluginActionExecutionOwner: 'current_process',
      actionsSettingsProvider: createActionSettingsProvider({ accountSettings: accountSettingsParse({ actionsSettingsV1: {
        v: 1, actions: {}, approvalWaivedSurfaces: { 'daemon.filesystem.upload': ['rpc'] },
      } }) }), filesystemActionExecute: client.createFilesystemActionExecutor('home') });
    bindCurrentFilesystemOwner(client, owner);
    const scope = { accountId: 'account-one', machineId: 'machine-test' };
    const store = createActionOperationStore();
    const runner = createActionOperationRunner({ store, generateOperationId: () => 'full-upload', resolveAction: actionId => {
      const spec = getActionSpec(ActionIdSchema.parse(actionId));
      return { actionId, title: spec.title, operation: spec.operation };
    } });
    const bytes = Buffer.from([0, 255, 128, 10]);
    try {
      await writeFile(join(rootPath, 'source.bin'), bytes);
      const transfer = createPreparedFilesystemTransferClient({
        openMachineTunnel: async () => ({ localPort: await lifecycle.ensureListening(), observedPath: 'direct', close: async () => {} }),
        executeAction: async (actionId, input, context) => runner.observe({ actionId, input, scope,
          execute: async operation => owner.execute(actionId, input, { ...context, ...operation,
            ...await verifiedFilesystemPersonContext(actionId, input, { accountId: scope.accountId,
              signal: operation.signal ?? context.signal }) }) }),
      });
      expect(await transfer.upload({ targetMachineId: scope.machineId, serverId: 'home', rootPath, path: 'destination.bin',
        sourcePath: join(rootPath, 'source.bin'), source: { sourceId: 'full-source', sizeBytes: bytes.length }, overwrite: false }))
        .toMatchObject({ success: true, status: 'completed' });
      expect(await readFile(join(rootPath, 'destination.bin'))).toEqual(bytes);
      const observation = await createActionOperationRpcHandlers({ store, runner, machineId: scope.machineId,
        resolveAccountId: async () => scope.accountId }).get({ operationId: 'full-upload', waitForTerminal: true });
      expect(observation).toMatchObject({ operation: { state: 'succeeded' } });
    } finally { await client.shutdown(); await lifecycle.stop(); await rm(rootPath, { recursive: true, force: true }); }
  });
  it('copies an older rollback archive through the installed provenance gate before accepting byte custody', async () => {
    const channel = await createRequesterCurrentnessSocketHarness();
    const directory = await mkdtemp(join(tmpdir(), 'happier-rollback-archive-owner-'));
    const environmentId = `rollback-archive-${randomUUID()}`;
    let removeArchive: (() => Promise<void>) | undefined;
    const job = DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'member', actionId: 'deployments.rollback',
      machineId: 'receiver', installationId: 'receiver-installation', phase: 'activate', deploymentId: 'rollback-operation',
      selectedDeploymentId: 'rollback-selected', actionOperationId: 'parent-operation',
      input: { serverId: 'srv_archive_home', environmentId, targetLinkId: 'link', expectedRevision: 1,
        expectedTargetLinkRevision: 1, requestKey: 'rollback-request', deploymentId: 'rollback-selected',
        contentArtifactId: 'selected-content', contentHeaderVersion: 1, contentBodyVersion: 1 } });
    if (job.kind !== 'member') throw new Error('Expected the parsed rollback member job');
    const fixture = await createDeploymentChildRequesterHarness({ job, encryptionMode: 'plain' });
    const prepared: { value?: Awaited<ReturnType<typeof fixture.prepare>> } = {};
    const clients: ApiMachineClient[] = [];
    const lifecycles = new Map<string, ReturnType<typeof createDirectTransferServerLifecycle>>();
    const networkPhases: string[] = [];
    try {
      vi.spyOn(axios, 'get').mockImplementation(async (url: string, options) => {
        networkPhases.push(new URL(url).pathname);
        if (url.endsWith('/v1/account/profile')) return { status: 200, data: {
          id: options?.headers?.Authorization === `Bearer ${fixture.ann.token}` ? 'ann' : 'bob' } };
        if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content: fixture.settingsContent, version: 1 } };
        if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: fixture.currentness };
        if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
        const path = new URL(url).pathname;
        if (path === '/v1/machines/machine-test' || path === '/v1/machines/receiver') {
          expect(options?.headers?.Authorization).toBeUndefined();
          const machineId = path.split('/').at(-1)!;
          return { status: 200, data: { machine: { id: machineId, kind: 'persistent', active: true,
            installationId: machineId === job.machineId ? fixture.installed.installationId : 'holder-installation',
            storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, revokedAt: null, replacedByMachineId: null,
            operationProtocolCapabilitiesRevision: 1,
            operationProtocolCapabilities: { irohMachineEndpoint: { protocolVersions: [1], endpointId: 'b'.repeat(64) } } } } };
        }
        throw new Error('Unexpected requester custody HTTP boundary');
      });
      const descriptor = HomeConnectionDescriptorV1Schema.parse({ v: 1, homeServerIdentityId: fixture.homeIdentityId,
        canonicalServerUrl: fixture.serverHttpBaseUrl, revision: 1, endpoints: [{ kind: 'https', url: fixture.serverHttpBaseUrl }] });
      const profile = { id: fixture.profileId, name: 'Home', serverUrl: fixture.serverHttpBaseUrl, webappUrl: fixture.serverHttpBaseUrl,
        createdAt: 0, updatedAt: 0, lastUsedAt: 0, homeConnectionDescriptor: descriptor, homeConnectionDescriptorAuthority: 'exact' as const };
      const savedSettings = await persistence.readSettings();
      vi.spyOn(persistence, 'readSettings').mockResolvedValue({ ...savedSettings, servers: { [fixture.profileId]: profile } });
      vi.spyOn(serverProfiles, 'getServerProfile').mockResolvedValue(profile);
      const { deploymentRoot, environmentInstanceId } = await resolveOwnServerDeploymentIdentityForHost({
        happierHomeDir: configuration.happyHomeDir, serverId: fixture.profileId, environmentId });
      removeArchive = () => rm(join(deploymentRoot, environmentInstanceId), { recursive: true, force: true });
      vi.spyOn(persistence, 'readStoredCredentialsForServerId').mockResolvedValue(fixture.ann);
      const issuer = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(87));
      const trustRoot = { keyId: 'archive-home', publicKey: Buffer.from(issuer.publicKey).toString('base64url') };
      const nativeFetch = globalThis.fetch;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (...args: Parameters<typeof fetch>) => {
        if (new URL(String(args[0])).pathname.startsWith('/v1/features')) return Response.json({ features: {}, capabilities: {
          serverIdentity: { serverIdentityId: fixture.homeIdentityId }, machines: { peerMediation: { grantSigningKeys: [trustRoot] } } },
          homeConnectionDescriptor: descriptor });
        return nativeFetch(...args);
      });
      vi.spyOn(axios, 'post').mockImplementation(async (url, body, options) => {
        networkPhases.push(new URL(String(url)).pathname);
        expect(new URL(String(url)).pathname).toBe('/v1/machines/peer/mediation/route-grants');
        expect(options?.headers?.Authorization).toBeUndefined();
        const { kind, ttlMs, ...binding } = DirectRouteGrantRequestV2Schema.parse(body);
        const now = Date.now();
        const payload = DirectRouteGrantPayloadV2Schema.parse({ ...binding, grantId: `archive-grant-${now}`, accountId: 'ann',
          iat: now, exp: now + ttlMs, aud: 'happier-daemon-route-grant', proofKind: kind });
        return { status: 200, data: { ok: true, grant: { payload, signature: { alg: 'Ed25519', keyId: trustRoot.keyId,
          valueBase64Url: Buffer.from(tweetnacl.sign.detached(Buffer.from(createDirectRouteGrantSigningInputV2(payload)), issuer.secretKey)).toString('base64url') } } } };
      });
      prepared.value = await fixture.prepare();
      const variant = nativeRegistryPause310.variants[0];
      const config = Buffer.from(variant.config);
      const image = { service: 'app', platform: variant.platform,
        configDigest: `sha256:${createHash('sha256').update(config).digest('hex')}`,
        manifestDigest: `sha256:${createHash('sha256').update(variant.manifest).digest('hex')}` };
      const configName = `${image.configDigest.slice(7)}.json`;
      await writeFile(join(directory, configName), config);
      await writeFile(join(directory, 'manifest.json'), JSON.stringify([{ Config: configName, Layers: [] }]));
      const engineArchive = join(directory, 'engine.tar');
      await createTar({ cwd: directory, file: engineArchive }, [configName, 'manifest.json']);
      const native = createNativeComposeImageIdentity({ directory: async () => directory, async run(args) {
        if (args[1] === 'inspect') return { stdout: JSON.stringify([{ Id: 'native-image-id' }]), exitCode: 0 };
        if (args[1] === 'tag') return { stdout: '', exitCode: 0 };
        if (args[1] === 'save') { await copyFile(engineArchive, args[args.indexOf('--output') + 1]!); return { stdout: '', exitCode: 0 }; }
        throw new Error('Unexpected native image effect');
      } });
      const keys = [{ kind: 'dockerEngine', dockerEndpoint: `archive-owner-boundary:${directory}` }] as const;
      const exported = await machineNativeEffectAdmission.run({ operation: { operationId: 'archive-export', kind: 'deployment' }, keys },
        context => native.exportImage(image, { references: ['owned:image'], ownedTag: 'owned:image', authority: { context } }));
      const [archive] = await adoptOwnServerImageArchives({ archives: [exported], serverId: fixture.homeIdentityId,
        admission: { deploymentRoot, environmentInstanceId, deploymentId: 'original-build',
          machineId: 'machine-test', installationId: 'holder-installation' },
        signal: new AbortController().signal, async assertCurrent() {} });
      if (!archive) throw new Error('Expected an actual native adopted archive');
      const origin: DeploymentArchiveOriginForHost = { environmentId, deploymentId: 'original-build',
        holderMachineId: archive.holder.machineId, holderInstallationId: archive.holder.installationId };
      const destination = resolveOwnServerImageArchivePathForHost({ deploymentRoot, environmentInstanceId,
        deploymentId: job.deploymentId }, archive.sha256);
      let sequence = 0;
      let current = true;
      let signedOrigin = origin;
      let sourcePath = archive.holder.path;
      const originalBytes = await readFile(archive.holder.path);
      const accepted: unknown[] = [];
      const terminal: unknown[] = [];
      const effects = new Map<string, ReturnType<ApiMachineClient['createFilesystemActionExecutor']>>();
      const operations = new Map<string, ReturnType<typeof createHostActionOperationRuntime>>();
      for (const machineId of [archive.holder.machineId, job.machineId]) {
        const lifecycle = createDirectTransferServerLifecycle({ bindPort: 0, listenerClasses: ['loopback_http'] });
        lifecycles.set(machineId, lifecycle);
        const client = new ApiMachineClient(fixture.ann.token, { id: machineId, encryptionKey: new Uint8Array(32),
          encryptionVariant: 'legacy', metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 },
        undefined, { directPeerServerLifecycle: lifecycle });
        clients.push(client);
        const effect = client.createFilesystemActionExecutor(fixture.profileId);
        const owner = createCliActionExecutor({ token: fixture.ann.token, sessionId: '', mode: 'plain', ctx: null,
          serverId: fixture.profileId, serverHttpBaseUrl: fixture.serverHttpBaseUrl, pluginActionExecutionOwner: 'current_process', filesystemActionExecute: effect });
        bindCurrentFilesystemOwner(client, owner, machineId, fixture.profileId);
        effects.set(machineId, effect);
        operations.set(machineId, createHostActionOperationRuntime({ serverId: fixture.homeIdentityId, machineId,
          custodyBinding: { serverId: fixture.homeIdentityId, installationId: machineId === job.machineId
            ? fixture.installed.installationId : origin.holderInstallationId }, resolveAccountId: async () => 'ann',
          generateOperationId: () => `archive-owner-${++sequence}` }));
      }
      const executePhase = async (actionId: Parameters<Parameters<typeof createPreparedFilesystemTransferClient>[0]['executeAction']>[0],
        input: unknown, context: ActionExecutorContext,
        received?: Readonly<{ packet: SocketRpcRequestPayload; params: unknown }>): Promise<ActionExecuteResult> => {
          const machineId = context.externalActionTarget?.kind === 'machine' ? context.externalActionTarget.machineId : '';
          const runtime = operations.get(machineId);
          const effect = effects.get(machineId);
          if (!runtime || !effect) throw new Error('Unexpected finite archive target');
          const method = received?.packet.method ?? `${machineId}:${actionId === 'action.operations.get' ? ACTION_OPERATION_RPC_METHODS_V2.get : actionId}`;
          const requestId = received?.packet.requestId ?? `archive-phase-${++sequence}`;
          const params = StrictJsonValueSchema.parse(received?.params ?? (actionId === 'action.operations.get' ? input
            : createTargetedActionRpcRequestV1(input, { kind: 'machine', machineId })));
          const execution = received?.packet.externalActionExecution ?? createExternalActionMachineRpcExecution({ context: { externalActionTarget: fixture.root.binding.target,
            externalActionExecutionAuthorization: fixture.root }, effectActionId: actionId,
            installationId: fixture.installed.installationId, method, requestId, params,
            deploymentChildExecution: fixture.packet, deploymentArchiveOrigin: signedOrigin, privateKey: fixture.receiver.secretKey });
          if (!execution) throw new Error('Missing receiver-signed finite archive proof');
          expect(verifyExternalActionMachineRpcRequestV1({ authorizationToken: fixture.root.token, effectActionId: actionId,
            target: fixture.root.binding.target, installationId: fixture.installed.installationId, method,
            requestId, params: received?.packet.params ?? params, deploymentChildExecution: execution.deploymentChildExecution,
            signature: execution.machineSignature, publicKey: fixture.receiver.publicKey })).toBe(true);
          // This network boundary supplies Home's admitted stamp. Independent
          // Home DB tests own immutable lineage/Team grants; the installed
          // native gate, finite operations, descriptors and bytes stay real.
          expect(execution.authorization.binding).toEqual(fixture.root.binding);
          const rpcContext = { signal: context.signal ?? new AbortController().signal, callerInputAuthorization: execution.authorization,
            workspaceSyncSourceExecution: { method, requestId, params,
              originalActionEnvelope: fixture.envelope, externalActionExecution: execution },
            machineAdmission: { actorAccountId: 'ann', custodianAccountId: 'holder-owner', machineId,
              installationId: machineId === job.machineId ? fixture.installed.installationId : origin.holderInstallationId,
              role: 'use' as const, encryptionMode: 'plain' as const }, verifyMachineAdmissionCurrent: async () => current };
          if (actionId === 'action.operations.get') {
            if (!input || typeof input !== 'object' || !('operationId' in input) || typeof input.operationId !== 'string') throw new Error('Missing finite operation');
            const result = await runtime.handlers.getV2({ operationId: input.operationId, waitForTerminal: true }, rpcContext);
            terminal.push(result);
            return { ok: true, result };
          }
          if (actionId !== 'daemon.filesystem.download' && actionId !== 'daemon.filesystem.copy') throw new Error('Unexpected finite archive phase');
          const result = await runtime.observeExecution({ actionId, input, rpcContext,
            execute: async operation => {
              const value = await effect({ actionId, input, context: { ...context, ...rpcContext, ...operation,
                serverId: fixture.profileId, runtimeAccountId: 'ann', externalActionTarget: { kind: 'machine', machineId } } });
              const execution = ActionExecuteResultSchema.safeParse(value);
              if (execution.success) return execution.data;
              return projectPreparedFilesystemActionResult(actionId === 'daemon.filesystem.download'
                ? FilesystemDownloadOutputSchema.parse(value) : FilesystemCopyOutputSchema.parse(value));
            } });
          if (result.ok) accepted.push(result.result);
          return result;
      };
      const unavailableNative = async (): Promise<never> => { throw new Error('Unexpected native archive transport operation'); };
      const nativeTransport = {
        getAvailability: () => { throw new Error('Unexpected native availability read'); },
        startHomeAcceptor: unavailableNative, stopHomeAcceptor: unavailableNative, ensureHomeTunnel: unavailableNative,
        releaseHomeTunnel: unavailableNative, getTunnelStatus: unavailableNative,
        startMachineAcceptor: unavailableNative, stopMachineAcceptor: unavailableNative, getMachineAcceptorStatus: unavailableNative,
        startMachineHttpTunnel: unavailableNative, getMachineTunnelStatus: unavailableNative,
        createEndpoint: async () => { networkPhases.push('native:createEndpoint'); return { endpointHandle: 'client', endpointId: 'a'.repeat(64), relayPolicy: 'automatic',
          relayMode: 'disabled', capProfile: 'machineBulk', relayUrls: [] } as const; },
        getEndpointStatus: async () => ({ endpointHandle: 'client', endpointId: 'a'.repeat(64), active: true,
          relayUrls: [], directAddresses: [], capProfile: 'machineBulk', relayPolicy: 'automatic', relayMode: 'disabled' } as const),
        startMachineTunnel: async (request: { handshakeJson: string }) => {
          networkPhases.push('native:startMachineTunnel');
          const handshake = IrohMachineHandshakeV1Schema.parse(JSON.parse(request.handshakeJson));
          expect(handshake.accountId).toBe('ann');
          return { machineTunnelId: `archive-tunnel-${++sequence}`, endpointHandle: 'client',
            localPort: await lifecycles.get(handshake.target.machineId)!.ensureListening(), connectionActive: true,
            remoteEndpointId: 'b'.repeat(64), observedPath: 'direct', startedAtMs: Date.now(), lastErrorCode: null } as const;
        }, stopMachineTunnel: async () => {}, shutdownEndpoint: async () => {},
      } satisfies Extract<ReturnType<typeof irohNative.loadIrohNodeNative>, { available: true }>['native'];
      vi.spyOn(irohNative, 'loadIrohNodeNative').mockReturnValue({ available: true, native: nativeTransport, addonPath: '/test/iroh.node' });
      const invocation = { signal: new AbortController().signal, originalActionEnvelope: fixture.envelope,
        externalActionExecutionAuthorization: prepared.value.authorization, externalActionTarget: fixture.root.binding.target };
      const boundaryErrors: unknown[] = [];
      channel.server.on('connection', socket => {
        if (socket.handshake.auth.token !== fixture.ann.token) return;
        socket.on(SOCKET_RPC_EVENTS.CALL, (packet: SocketRpcRequestPayload, ack: (result: unknown) => void) => {
          void (async () => {
            const decoded = await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, packet.params, packet.method);
            const machineId = packet.method.slice(0, packet.method.indexOf(':'));
            const method = packet.method.slice(packet.method.indexOf(':') + 1);
            const actionId = readDeploymentArchiveRpcEffectV1(method);
            if (!actionId) throw new Error('Unexpected archive RPC phase');
            const input = actionId === 'action.operations.get' ? decoded.params : TargetedActionRpcRequestV1Schema.parse(decoded.params).input;
            const result = await executePhase(actionId, input, { ...invocation,
              externalActionTarget: { kind: 'machine', machineId } }, { packet, params: decoded.params });
            ack({ ok: true, result: await socketRpcCodec.encodeResponse({ mode: 'plain' }, result.ok ? result.result : result, decoded.callId) });
          })().catch(error => { boundaryErrors.push(error); ack({ ok: false, error: 'Archive boundary refused' }); });
        });
      });
      const factory = createDeploymentImageArchiveCopyForHost({ credentials: fixture.ann, credentialProfileId: fixture.profileId,
        serverId: fixture.homeIdentityId, serverHttpBaseUrl: fixture.serverHttpBaseUrl,
        machineId: job.machineId, installationId: fixture.installed.installationId, deploymentRoot });
      const copyArchive = () => factory({ archive, destination, context: invocation, signal: invocation.signal, async assertCurrent() {
        if (!current) throw Object.assign(new Error('action_forbidden'), { code: 'action_forbidden' });
      } });
      const copied = await copyArchive().catch((error: unknown) => { throw new Error(JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown factory failure',
        acceptedCount: accepted.length, terminalCount: terminal.length, networkPhases,
        boundaryErrors: boundaryErrors.map(value => value instanceof Error ? { message: value.message,
          frames: value.stack?.split('\n').filter(frame => /^\s+at /u.test(frame) && /\/src\//u.test(frame)) }
          : 'Unknown boundary failure') })); });
      expect(copied).toEqual({ path: destination.path, sizeBytes: archive.sizeBytes, sha256: archive.sha256 });
      expect(boundaryErrors).toEqual([]);
      const transfer = createPreparedFilesystemTransferClient({ executeAction: executePhase,
        openMachineTunnel: async ({ targetMachineId }) => ({ localPort: await lifecycles.get(targetMachineId)!.ensureListening(),
          observedPath: 'direct', close: async () => {} }) });
      const copy = () => transfer.copy({ source: { machineId: archive.holder.machineId, rootPath: archive.holder.rootPath,
        path: sourcePath, serverId: fixture.profileId },
        destination: { ...destination, serverId: fixture.profileId, machineId: job.machineId }, overwrite: false, recursive: false });
      expect(await readFile(destination.path)).toEqual(originalBytes);
      expect(accepted).toEqual([expect.objectContaining({ status: 'accepted', entryTree: expect.any(Object) }),
        expect.objectContaining({ status: 'accepted', prepared: expect.objectContaining({ manifest: expect.any(Object) }) })]);
      const sourceReceipt = FilesystemDownloadOutputSchema.parse(accepted[0]);
      if (!sourceReceipt.success || sourceReceipt.status !== 'accepted') throw new Error('Missing accepted archive export');
      const sourceTerminal = await callExactMachineRpc({ credentials: fixture.ann, machineId: archive.holder.machineId,
        serverUrl: fixture.serverHttpBaseUrl, method: ACTION_OPERATION_RPC_METHODS_V2.get,
        request: { operationId: sourceReceipt.operationId, waitForTerminal: true }, timeoutMs: null,
        externalAction: { context: invocation, effectActionId: 'action.operations.get', installationId: fixture.installed.installationId,
          privateKey: fixture.installed.privateKey, deploymentArchiveOrigin: origin } });
      expect(sourceTerminal).toMatchObject({ operation: { actionId: 'daemon.filesystem.download', state: 'succeeded' } });
      expect(terminal).toEqual([expect.objectContaining({ operation: expect.objectContaining({ actionId: 'daemon.filesystem.copy', state: 'succeeded' }) }),
        expect.objectContaining({ operation: expect.objectContaining({ actionId: 'daemon.filesystem.download', state: 'succeeded' }) })]);
      const dial = vi.spyOn(nativeTransport, 'startMachineTunnel');
      dial.mockRejectedValueOnce(new irohNative.IrohNativeOperationError('transport-unavailable', 'Direct and relay transport unavailable'));
      await expect(copyArchive()).rejects.toMatchObject({ code: 'image_transfer_unreachable' });
      dial.mockRejectedValueOnce(new irohNative.IrohNativeOperationError('endpoint-identity-mismatch', 'Wrong authenticated endpoint'));
      await expect(copyArchive()).rejects.toMatchObject({ code: 'identity_mismatch' });
      const beforeRefusal = accepted.length;
      signedOrigin = { ...origin, deploymentId: 'unrelated-build' };
      expect(await copy()).toMatchObject({ success: false, errorCode: 'filesystem_transfer_custody_required' });
      signedOrigin = { ...origin, holderInstallationId: 'replaced-holder' };
      expect(await copy()).toMatchObject({ success: false, errorCode: 'action_forbidden' });
      signedOrigin = origin;
      sourcePath = engineArchive;
      expect(await copy()).toMatchObject({ success: false, errorCode: 'filesystem_transfer_custody_required' });
      sourcePath = archive.holder.path;
      await writeFile(archive.holder.path, 'substituted archive bytes');
      expect(await copy()).toMatchObject({ success: false, errorCode: 'native_failed' });
      await writeFile(archive.holder.path, originalBytes);
      current = false;
      fixture.setCurrent(false);
      await expect(copyArchive()).rejects.toMatchObject({ code: 'action_forbidden' });
      expect(accepted).toHaveLength(beforeRefusal);
      expect(await readFile(destination.path)).toEqual(originalBytes);
    } finally {
      await Promise.all(clients.map(client => client.shutdown()));
      await Promise.all([...lifecycles.values()].map(lifecycle => lifecycle.stop()));
      await prepared.value?.dispose(); await channel.close();
      await removeArchive?.();
      await rm(directory, { recursive: true, force: true });
      vi.restoreAllMocks();
    }
  });
  it.skipIf(process.platform !== 'linux')('retains actual local-copy recovery custody and the runner uncertain observation when native commit loses its terminal result', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'happier-copy-unknown-owner-'));
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'daemon-owner' })).toString('base64url')}.signature`;
    const client = await createBoundFilesystemMachineClient(token, { id: 'machine-test', encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy', metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 });
    const child = new childProcess.ChildProcess();
    const stdin = new PassThrough(); const stdout = new PassThrough(); const stderr = new PassThrough();
    child.stdin = stdin; child.stdout = stdout; child.stderr = stderr; child.kill = () => true;
    let writes = 0;
    stdin.on('data', () => {
      if (++writes === 1) stdout.write('{"v":1,"t":"workspace-confined-prepared"}\n');
      else { stdout.end(); stderr.end(); queueMicrotask(() => child.emit('close', 1, null)); }
    });
    // Replace only the native apply process; real admission, source capture,
    // complete manifest/blob staging, the factory and runner remain in use.
    nativeProcessBoundary.spawn.mockImplementation((_command, args) =>
      args?.[0] === 'workspace-confined-apply' ? child : undefined);
    const owner = createCliActionExecutor({ token, sessionId: '', mode: 'plain', ctx: null,
      serverId: 'home', serverHttpBaseUrl: 'http://localhost:1', pluginActionExecutionOwner: 'current_process',
      actionsSettingsProvider: createActionSettingsProvider({ accountSettings: accountSettingsParse({
        actionsSettingsV1: { v: 1, actions: {}, approvalWaivedSurfaces: { 'daemon.filesystem.copy': ['rpc'] } },
      }) }), filesystemActionExecute: client.createFilesystemActionExecutor('home'),
    });
    bindCurrentFilesystemOwner(client, owner);
    const store = createActionOperationStore();
    const runner = createActionOperationRunner({ store, generateOperationId: () => 'native-copy-unknown',
      resolveAction: actionId => ({ actionId, title: 'Copy', operation: {
        version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'current' },
      } }),
    });
    const scope = { accountId: 'daemon-owner', machineId: 'machine-test' };
    let retainedCustody: string | undefined;
    try {
      const bytes = Buffer.from([0, 255, 128]);
      await writeFile(join(rootPath, 'source.bin'), bytes);
      const result = await runner.observe({ actionId: 'daemon.filesystem.copy', scope,
        input: { rootPath, from: 'source.bin', to: 'copy.bin', overwrite: false, recursive: false },
        execute: async context => owner.execute('daemon.filesystem.copy', {
          rootPath, from: 'source.bin', to: 'copy.bin', overwrite: false, recursive: false,
        }, { ...context, ...await verifiedFilesystemPersonContext('daemon.filesystem.copy', {
          rootPath, from: 'source.bin', to: 'copy.bin', overwrite: false, recursive: false,
        }, { accountId: scope.accountId, signal: context.signal }) }),
      });
      if (!result.ok) retainedCustody = /private recovery custody is retained at (.+)$/u.exec(result.error)?.[1];
      expect(result).toMatchObject({ ok: false, errorCode: 'indeterminate' });
      expect(store.get(scope, 'native-copy-unknown')).toMatchObject({ observation: { kind: 'outcome_uncertain', code: 'indeterminate' } });
      expect(store.get(scope, 'native-copy-unknown')).not.toHaveProperty('settledAt');
      expect(retainedCustody).toBeDefined();
      if (retainedCustody) await expect(readFile(join(retainedCustody, 'stage', 'entry'))).resolves.toEqual(bytes);
      await expect(stat(join(rootPath, 'copy.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(join(rootPath, 'source.bin'))).toEqual(bytes);
    } finally {
      nativeProcessBoundary.spawn.mockReset(); await client.shutdown();
      if (retainedCustody && dirname(retainedCustody) === tmpdir() && basename(retainedCustody).startsWith('filesystem-copy-')) {
        await rm(retainedCustody, { recursive: true, force: true });
      }
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== 'linux').each(['cancel', 'retire'] as const)('keeps local cancellation distinct from finite owner retirement after staging: %s', async mode => {
    const rootPath = await mkdtemp(join(tmpdir(), 'happier-copy-cancel-owner-'));
    const client = await createBoundFilesystemMachineClient('owner-token', { id: 'machine-test', encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy', metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 });
    const controller = new AbortController();
    const child = new childProcess.ChildProcess();
    const stdin = new PassThrough(); const stdout = new PassThrough(); const stderr = new PassThrough();
    child.stdin = stdin; child.stdout = stdout; child.stderr = stderr; child.kill = () => true;
    let prepared = false;
    let retirement: Promise<void> | undefined;
    let materialPath: string | undefined;
    const decisions: string[] = [];
    stdin.on('data', chunk => {
      if (!prepared) {
        const request: unknown = JSON.parse(String(chunk));
        if (!request || typeof request !== 'object' || !('materialPath' in request) || typeof request.materialPath !== 'string')
          throw new Error('Missing native prepared copy material');
        materialPath = request.materialPath;
        prepared = true;
        if (mode === 'cancel') {
          controller.abort();
          stdout.write('{"v":1,"t":"workspace-confined-prepared"}\n');
        } else {
          // Retirement rejects new work, not this already-admitted copy.
          retirement = client.shutdown();
          void retirement.then(() => stdout.write('{"v":1,"t":"workspace-confined-prepared"}\n'),
            error => child.emit('error', error));
        }
      }
      else {
        const decision: unknown = JSON.parse(String(chunk));
        if (!decision || typeof decision !== 'object' || !('decision' in decision) || typeof decision.decision !== 'string')
          throw new Error('Missing native copy decision');
        decisions.push(decision.decision);
        void (async () => {
          if (decision.decision === 'commit') {
            if (!materialPath) throw new Error('Missing native prepared copy material');
            await copyFile(materialPath, join(rootPath, 'destination.bin'));
            stdout.write('{"v":1,"t":"workspace-confined-result","status":"installed"}\n');
          }
          stdout.end(); stderr.end(); queueMicrotask(() => child.emit('close', 0, null));
        })().catch(error => child.emit('error', error));
      }
    });
    nativeProcessBoundary.spawn.mockImplementation((_command, args) =>
      args?.[0] === 'workspace-confined-apply' ? child : undefined);
    bindCurrentFilesystemOwner(client, createActionExecutor(createCliActionDeps({ token: 'owner-token', sessionId: '', mode: 'plain', ctx: null })));
    try {
      await writeFile(join(rootPath, 'source.bin'), Buffer.from([0, 255, 128]));
      await writeFile(join(rootPath, 'destination.bin'), 'incumbent');
      const result = await client.createFilesystemActionExecutor('home')({ actionId: 'daemon.filesystem.copy',
        input: { rootPath, from: 'source.bin', to: 'destination.bin', overwrite: true, recursive: false },
        context: await verifiedFilesystemPersonContext('daemon.filesystem.copy', {
          rootPath, from: 'source.bin', to: 'destination.bin', overwrite: true, recursive: false,
        }, { accountId: 'owner', signal: controller.signal }),
      });
      if (retirement) await retirement;
      expect(prepared).toBe(true);
      if (mode === 'cancel') {
        expect(result, JSON.stringify(result)).toMatchObject({ success: false, errorCode: 'cancelled' });
        expect(decisions).toEqual(['abort']);
        expect(await readFile(join(rootPath, 'destination.bin'), 'utf8')).toBe('incumbent');
      } else {
        expect(result, JSON.stringify(result)).toEqual({ success: true });
        expect(decisions).toEqual(['commit']);
        expect(await readFile(join(rootPath, 'destination.bin'))).toEqual(Buffer.from([0, 255, 128]));
        expect(await client.createFilesystemActionExecutor('home')({ actionId: 'daemon.filesystem.copy',
          input: { rootPath, from: 'source.bin', to: 'next.bin', overwrite: false, recursive: false },
          context: await verifiedFilesystemPersonContext('daemon.filesystem.copy', {
            rootPath, from: 'source.bin', to: 'next.bin', overwrite: false, recursive: false,
          }, { accountId: 'owner' }),
        })).toMatchObject({ ok: false, errorCode: 'filesystem_action_owner_unavailable' });
        await expect(stat(join(rootPath, 'next.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
        expect(decisions).toEqual(['commit']);
      }
    } finally { nativeProcessBoundary.spawn.mockReset(); await (retirement ?? client.shutdown()); await rm(rootPath, { recursive: true, force: true }); }
  });

  it('does not substitute the host transport for an external requester whose signed Machine admission is unavailable', async () => {
    let sent = false;
    const deps = createCliActionDeps({ token: 'host-account', sessionId: '', mode: 'plain', ctx: null,
      machineActionDirectTargetTransport: { machineId: 'machine', invoke: async () => {
        sent = true;
        return { success: true };
      } },
    });
    await expect(deps.filesystemActionExecute!({ actionId: 'daemon.filesystem.delete',
      input: { rootPath: '/selected/workspace', path: 'entry', recursive: false },
      context: { surface: 'api', authority: 'account_automation',
        externalActionTarget: { kind: 'machine', machineId: 'machine' },
        externalActionCredential: { accountId: 'external-requester', principalId: 'principal',
          credentialId: 'credential', grant: API_TOKEN_FULL_GRANT_V1 },
      },
    })).rejects.toMatchObject({ code: 'not_authenticated' });
    expect(sent).toBe(false);
  });

  it('keeps a foreign requester closed at the full factory while admitted owner-local effects retain their Account identity', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'happier-filesystem-requester-'));
    const installationId = readOrCreateInstallationIdentitySync().installationId;
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'daemon-owner' })).toString('base64url')}.signature`;
    const client = await createBoundFilesystemMachineClient(token, { id: 'machine-test', encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy', metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 });
    const requesterAccounts: Array<string | undefined> = [];
    const requesterCredentials: unknown[] = [];
    const localEffects = client.createFilesystemActionExecutor('home');
    const fullOwner = createCliActionExecutor({ token, sessionId: '', mode: 'plain', ctx: null,
      serverId: 'home', serverHttpBaseUrl: 'http://localhost:1', pluginActionExecutionOwner: 'current_process',
      actionsSettingsProvider: createActionSettingsProvider({ accountSettings: accountSettingsParse({
        actionsSettingsV1: { v: 1, actions: {}, approvalWaivedSurfaces: { 'daemon.filesystem.copy': ['rpc', 'cli'] } },
      }) }),
      filesystemActionExecute: async request => {
        requesterAccounts.push(request.context.runtimeAccountId);
        requesterCredentials.push(request.context.externalActionCredential);
        return await localEffects(request);
      },
    });
    bindCurrentFilesystemOwner(client, fullOwner);
    const manager = new RpcHandlerManager({ scopePrefix: 'machine-test', localMachineId: 'machine-test', encryptionMode: 'plain',
      authorizeRequest: request => authorizeMachineRpcRequest(request, {
        machineId: 'machine-test', resolveCustodianAccountId: async () => 'daemon-owner',
        resolveInstallationId: () => installationId,
        // The Home's current Machine-admission lookup is the network boundary.
        verifyMachineAdmission: async () => true,
      }),
    });
    const registration = registerFileSystemHandlers(manager, rootPath, { actionExecutor: fullOwner, mutationMachineId: 'machine-test' });
    try {
      const bytes = Buffer.from([0, 255, 128]);
      await writeFile(join(rootPath, 'source.bin'), bytes);
      const admittedRequest = { method: 'machine-test:daemon.filesystem.copy',
        params: { rootPath, from: 'source.bin', to: 'copy.bin', overwrite: false, recursive: false },
        callerAuthority: 'account_automation', machineAdmission: { actorAccountId: 'verified-requester',
          custodianAccountId: 'daemon-owner', machineId: 'machine-test', installationId,
          role: 'use', encryptionMode: 'plain' },
      } satisfies Parameters<typeof manager.handleRequest>[0];
      expect(await manager.handleRequest({ ...admittedRequest, params: {
        ...admittedRequest.params, to: 'spoof-copy.bin', surface: 'rpc', runtimeAccountId: 'daemon-owner',
      } })).toMatchObject({ errorCode: expect.any(String) });
      await expect(stat(join(rootPath, 'spoof-copy.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await manager.handleRequest(admittedRequest)).toMatchObject({
        errorCode: expect.any(String),
      });
      expect(requesterAccounts).toEqual([]);
      await expect(stat(join(rootPath, 'copy.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await manager.invokeLocal('daemon.filesystem.copy', admittedRequest.params, {
        rpcContext: { ...await verifiedFilesystemPersonContext('daemon.filesystem.copy', admittedRequest.params),
          callerAuthority: 'present_user' },
      })).toEqual({ success: true });
      expect(requesterAccounts).toEqual(['daemon-owner']);
      expect(requesterCredentials).toEqual([undefined]);
      expect(await readFile(join(rootPath, 'copy.bin'))).toEqual(bytes);
      expect(await readFile(join(rootPath, 'source.bin'))).toEqual(bytes);
    } finally {
      await registration.dispose();
      await client.shutdown();
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it('does not borrow the daemon Account waiver or approval store for an admitted foreign requester without its Account authority', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'happier-filesystem-foreign-policy-'));
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'daemon-owner' })).toString('base64url')}.signature`;
    const client = new ApiMachineClient(token, { id: 'machine-test', encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy', metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 });
    const fullOwner = createCliActionExecutor({ token, credentials: { token, encryption: null },
      sessionId: '', mode: 'plain', ctx: null, serverId: 'home', serverHttpBaseUrl: 'http://localhost:1',
      pluginActionExecutionOwner: 'current_process', filesystemActionExecute: client.createFilesystemActionExecutor('home'),
      actionsSettingsProvider: createActionSettingsProvider({ scopeKey: resolveAccountSettingsScopeKeyForToken(token),
        accountSettings: accountSettingsParse({ actionsSettingsV1: { v: 1, actions: {},
          approvalWaivedSurfaces: { 'daemon.filesystem.copy': ['rpc', 'api'] } } }),
      }),
    });
    bindCurrentFilesystemOwner(client, fullOwner);
    const manager = new RpcHandlerManager({ scopePrefix: 'machine-test', localMachineId: 'machine-test', encryptionMode: 'plain',
      authorizeRequest: request => authorizeMachineRpcRequest(request, {
        machineId: 'machine-test', resolveCustodianAccountId: async () => 'daemon-owner', resolveInstallationId: () => 'installation',
        // Only the current Home admission lookup is a replaced network boundary.
        verifyMachineAdmission: async () => true,
      }),
    });
    const registration = registerFileSystemHandlers(manager, rootPath, { actionExecutor: fullOwner, mutationMachineId: 'machine-test' });
    const reads = vi.spyOn(axios, 'get');
    const writes = vi.spyOn(axios, 'post');
    try {
      const bytes = Buffer.from([0, 255, 128]);
      await writeFile(join(rootPath, 'source.bin'), bytes);
      const result = await manager.handleRequest({ method: 'machine-test:daemon.filesystem.copy',
        params: { rootPath, from: 'source.bin', to: 'foreign-copy.bin', overwrite: false, recursive: false },
        callerAuthority: 'account_automation', machineAdmission: { actorAccountId: 'verified-requester',
          custodianAccountId: 'daemon-owner', machineId: 'machine-test', installationId: 'installation', role: 'use', encryptionMode: 'plain' },
      });
      expect(result).toMatchObject({ errorCode: expect.any(String) });
      expect(await fullOwner.prepare('daemon.filesystem.copy', {
        rootPath, from: 'source.bin', to: 'foreign-copy.bin', overwrite: false, recursive: false,
      }, { surface: 'rpc', runtimeAccountId: 'verified-requester', authority: 'account_automation',
        externalActionTarget: { kind: 'machine', machineId: 'machine-test' },
      })).toMatchObject({ kind: 'settled', result: { ok: false, errorCode: 'filesystem_requester_account_authority_unavailable' } });
      const externalRequesterContext = { surface: 'api' as const, authority: 'account_automation' as const,
        externalActionTarget: { kind: 'machine' as const, machineId: 'machine-test' },
        externalActionCredential: { accountId: 'verified-requester', principalId: 'principal',
          credentialId: 'credential', grant: API_TOKEN_FULL_GRANT_V1 },
      };
      const externalInput = { rootPath, from: 'source.bin', to: 'foreign-api-copy.bin', overwrite: false, recursive: false };
      expect(await fullOwner.prepare('daemon.filesystem.copy', externalInput, externalRequesterContext))
        .toMatchObject({ kind: 'settled', result: { ok: false, errorCode: 'filesystem_requester_account_authority_unavailable' } });
      expect(await fullOwner.execute('daemon.filesystem.copy', externalInput, externalRequesterContext))
        .toMatchObject({ ok: false, errorCode: 'filesystem_requester_account_authority_unavailable' });
      await expect(stat(join(rootPath, 'foreign-copy.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(join(rootPath, 'foreign-api-copy.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(join(rootPath, 'source.bin'))).toEqual(bytes);
      expect(reads).not.toHaveBeenCalled();
      expect(writes).not.toHaveBeenCalled();
    } finally {
      reads.mockRestore(); writes.mockRestore();
      await registration.dispose(); await client.shutdown(); await rm(rootPath, { recursive: true, force: true });
    }
  });

  it('refuses generic MCP transfers without concrete byte custody before contacting the machine', async () => {
    // The credentialed public front door refuses absent custody before
    // approval/admission. The lower protocol executor does not own a driver.
    const requests = vi.spyOn(axios, 'request');
    const reads = vi.spyOn(axios, 'get');
    try {
      const executor = createCliActionExecutorFromCredentials({ credentials: { token: 'admitted-caller', encryption: null },
        pluginActionExecutionOwner: 'current_process' });
      const input = { rootPath: '/workspace', path: 'file', destination: { destinationId: 'arbitrary' }, asZip: false };
      const context = { surface: 'mcp' as const, authority: 'account_automation' as const,
        externalActionTarget: { kind: 'machine' as const, machineId: 'machine' } };
      expect(await executor.execute('daemon.filesystem.download', input, context))
        .toMatchObject({ ok: false, errorCode: 'filesystem_transfer_custody_required' });
      expect(await executor.prepare('daemon.filesystem.download', input, context))
        .toMatchObject({ kind: 'settled', result: { ok: false, errorCode: 'filesystem_transfer_custody_required' } });
      expect(requests).not.toHaveBeenCalled();
      expect(reads).not.toHaveBeenCalled();
    } finally {
      requests.mockRestore();
      reads.mockRestore();
    }
  });
  it('admits qualified MCP copy through canonical disabled-surface policy before any endpoint call', async () => {
    const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'account-one' })).toString('base64url')}.signature`,
      encryption: null, credentialProvenance: 'stored_session' as const } satisfies persistence.StoredCredentials;
    const stored = vi.spyOn(persistence, 'readStoredCredentialsForServerId').mockResolvedValue(credentials);
    const profiles = vi.spyOn(serverProfiles, 'getServerProfile').mockImplementation(async id => ({
      id, name: id, serverUrl: `https://${id}.example.test`, webappUrl: `https://${id}.example.test`, createdAt: 0, updatedAt: 0, lastUsedAt: 0,
    }));
    const requests = vi.spyOn(axios, 'request');
    const reads = vi.spyOn(axios, 'get');
    const network = vi.spyOn(globalThis, 'fetch');
    try {
      const executor = createCliActionExecutorFromCredentials({ credentials, serverId: 'destination', serverApiUrl: 'https://destination.example.test',
        serverIdentityId: 'destination-identity', machineId: 'destination-machine', pluginActionExecutionOwner: 'current_process',
        actionsSettingsProvider: createActionSettingsProvider({ accountSettings: accountSettingsParse({ actionsSettingsV1: {
          v: 1, actions: { 'daemon.filesystem.copy': { disabledSurfaces: ['mcp'] } },
        } }) }),
      });
      const input = { kind: 'target_copy', source: { serverId: 'source', machineId: 'source-machine', rootPath: '/source', path: 'binary' },
        destination: { serverId: 'destination', machineId: 'destination-machine', rootPath: '/destination', path: 'binary' }, overwrite: false, recursive: false };
      const context = { surface: 'mcp' as const, serverId: 'destination', externalActionTarget: { kind: 'machine' as const, machineId: 'destination-machine' } };
      expect(await executor.execute('daemon.filesystem.copy', input, context)).toMatchObject({ ok: false, errorCode: 'action_disabled' });
      expect(await executor.prepare('daemon.filesystem.copy', input, context)).toMatchObject({ kind: 'settled', result: { ok: false, errorCode: 'action_disabled' } });
      expect(requests).not.toHaveBeenCalled(); expect(reads).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
    } finally { stored.mockRestore(); profiles.mockRestore(); requests.mockRestore(); reads.mockRestore(); network.mockRestore(); }
  });

  it('cancels a prepared concrete copy invocation before remote effects', async () => {
    const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'account-one' })).toString('base64url')}.signature`,
      encryption: null, credentialProvenance: 'stored_session' as const } satisfies persistence.StoredCredentials;
    const stored = vi.spyOn(persistence, 'readStoredCredentialsForServerId').mockResolvedValue(credentials);
    const profiles = vi.spyOn(serverProfiles, 'getServerProfile').mockImplementation(async id => ({
      id, name: id, serverUrl: `https://${id}.example.test`, webappUrl: `https://${id}.example.test`, createdAt: 0, updatedAt: 0, lastUsedAt: 0,
    }));
    const requests = vi.spyOn(axios, 'request'); const reads = vi.spyOn(axios, 'get'); const network = vi.spyOn(globalThis, 'fetch');
    try {
      const executor = createCliActionExecutorFromCredentials({ credentials, serverId: 'destination', serverApiUrl: 'https://destination.example.test',
        serverIdentityId: 'destination-identity', machineId: 'destination-machine', pluginActionExecutionOwner: 'current_process',
        actionsSettingsProvider: createActionSettingsProvider({ accountSettings: accountSettingsParse({ actionsSettingsV1: {
          v: 1, actions: {}, approvalWaivedSurfaces: { 'daemon.filesystem.copy': ['mcp'] },
        } }) }),
      });
      const input = { kind: 'target_copy', source: { serverId: 'source', machineId: 'source-machine', rootPath: '/source', path: 'binary' },
        destination: { serverId: 'destination', machineId: 'destination-machine', rootPath: '/destination', path: 'binary' }, overwrite: false, recursive: false };
      const controller = new AbortController();
      const prepared = await executor.prepare('daemon.filesystem.copy', input, { surface: 'mcp', serverId: 'destination', signal: controller.signal,
        externalActionTarget: { kind: 'machine', machineId: 'destination-machine' } });
      expect(prepared.kind).toBe('ready');
      if (prepared.kind !== 'ready') throw new Error('Copy admission did not produce a concrete invocation');
      const readsBeforeCancellation = network.mock.calls.length;
      controller.abort();
      expect(await prepared.invocation.run()).toMatchObject({ ok: false, errorCode: 'cancelled' });
      expect(requests).not.toHaveBeenCalled(); expect(reads).not.toHaveBeenCalled();
      expect(network.mock.calls.length).toBe(readsBeforeCancellation);
    } finally { stored.mockRestore(); profiles.mockRestore(); requests.mockRestore(); reads.mockRestore(); network.mockRestore(); }
  });

  it('refuses PAT address-only copy without an admitted mounted operation before source or destination effects', async () => {
    const credentials = { token: 'api-token', encryption: null, credentialProvenance: 'api_token' as const } satisfies persistence.StoredCredentials;
    const requests = vi.spyOn(axios, 'request'); const reads = vi.spyOn(axios, 'get'); const network = vi.spyOn(globalThis, 'fetch');
    try {
      const executor = createCliActionExecutorFromCredentials({ credentials, pluginActionExecutionOwner: 'current_process' });
      const input = { kind: 'target_copy', source: { serverId: 'source', machineId: 'source-machine', rootPath: '/source', path: 'binary' },
        destination: { serverId: 'destination', machineId: 'destination-machine', rootPath: '/destination', path: 'binary' }, overwrite: false, recursive: false };
      expect(await executor.execute('daemon.filesystem.copy', input, { surface: 'mcp' })).toMatchObject({ ok: false, errorCode: 'filesystem_transfer_custody_required' });
      expect(await executor.prepare('daemon.filesystem.copy', input, { surface: 'agent' })).toMatchObject({ kind: 'settled', result: { ok: false, errorCode: 'filesystem_transfer_custody_required' } });
      expect(requests).not.toHaveBeenCalled(); expect(reads).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
    } finally { requests.mockRestore(); reads.mockRestore(); network.mockRestore(); }
  });
  it('cancels concrete copy custody through a real blocking approval before effects', async () => {
    const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'account-one' })).toString('base64url')}.signature`,
      encryption: null, credentialProvenance: 'stored_session' as const } satisfies persistence.StoredCredentials;
    const stored = vi.spyOn(persistence, 'readStoredCredentialsForServerId').mockResolvedValue(credentials);
    const profiles = vi.spyOn(serverProfiles, 'getServerProfile').mockImplementation(async id => ({
      id, name: id, serverUrl: `https://${id}.example.test`, webappUrl: `https://${id}.example.test`, createdAt: 0, updatedAt: 0, lastUsedAt: 0,
    }));
    let artifact: Readonly<Record<string, unknown>> | undefined;
    const paths: string[] = [];
    const eligibility = vi.spyOn(axios, 'request').mockImplementation(async config => {
      const parsed = new URL(String(config.url)); paths.push(parsed.pathname);
      expect(config.method).toBe('POST');
      expect(parsed.href).toBe('https://destination.example.test/v1/auth/api-tokens/list');
      expect(config.headers).toMatchObject({ Authorization: `Bearer ${credentials.token}` });
      return { status: 200, data: { tokens: [] } };
    });
    const reads = vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname; paths.push(path);
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
      if (path === '/v1/account/profile') return { status: 200, data: { id: 'account-one' } };
      if (artifact && path === `/v1/artifacts/${artifact.id}`) return { status: 200, data: artifact };
      if (!artifact && path.startsWith('/v1/artifacts/')) return { status: 404, data: { error: 'Artifact not found' } };
      throw new Error(`Unexpected admission HTTP read: ${path}`);
    });
    const writes = vi.spyOn(axios, 'post').mockImplementation(async (url, wire) => {
      const path = new URL(String(url)).pathname; paths.push(path);
      const input = readCarrierMutation(wire);
      if (path === '/v1/artifacts') {
        artifact = { ...input, ownerAccountId: 'account-one', access: 'owner', encryptionMode: 'plain',
          headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
        return { status: 200, data: { id: input.id, headerVersion: 1, bodyVersion: 1 } };
      }
      if (artifact && path === `/v1/artifacts/${artifact.id}`) {
        const headerVersion = Number(artifact.headerVersion) + 1; const bodyVersion = Number(artifact.bodyVersion) + 1;
        artifact = { ...artifact, ...input, headerVersion, bodyVersion };
        return { status: 200, data: { success: true, headerVersion, bodyVersion } };
      }
      throw new Error(`Unexpected admission HTTP write: ${path}`);
    });
    const networkPaths: string[] = [];
    const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
      const parsed = new URL(String(url)); networkPaths.push(parsed.pathname);
      if (parsed.origin === 'https://destination.example.test'
        && (parsed.pathname === '/v1/features' || parsed.pathname === '/v1/features/authenticated')) {
        return Response.json({ features: {}, capabilities: { serverIdentity: { serverIdentityId: 'srv_destination' } } });
      }
      throw new Error(`Unexpected copy network effect: ${parsed.pathname}`);
    });
    const socket = new EventEmitter();
    const networkSocket = Object.assign(socket, { io: createSocketIoManagerStub(), connected: false,
      connect: () => { networkSocket.connected = true; socket.emit('connect'); return networkSocket; },
      disconnect: () => { networkSocket.connected = false; return networkSocket; }, close: () => networkSocket });
    copySocketBoundary.create.mockReturnValue(networkSocket);
    const coordinator = getSharedBlockingApprovalCoordinator();
    const controller = new AbortController();
    let pending: Promise<unknown> | undefined;
    let settled: unknown;
    let artifactId: string | undefined;
    try {
      const executor = createCliActionExecutorFromCredentials({ credentials, serverId: 'destination', serverApiUrl: 'https://destination.example.test',
        serverIdentityId: 'srv_destination', machineId: 'destination-machine', pluginActionExecutionOwner: 'current_process',
        actionsSettingsProvider: createActionSettingsProvider({ accountSettings: accountSettingsParse({ actionsSettingsV1: {
          v: 1, actions: { 'daemon.filesystem.copy': { approvalRequiredSurfaces: ['mcp'] } },
        } }) }),
      });
      const input = { kind: 'target_copy', source: { serverId: 'source', machineId: 'source-machine', rootPath: '/source', path: 'binary' },
        destination: { serverId: 'destination', machineId: 'destination-machine', rootPath: '/destination', path: 'binary' }, overwrite: false, recursive: false };
      pending = executor.execute('daemon.filesystem.copy', input, { surface: 'mcp', actionRequestId: 'held-copy', signal: controller.signal, serverId: 'destination',
        externalActionTarget: { kind: 'machine', machineId: 'destination-machine' } }).then(result => { settled = result; return result; });
      await vi.waitFor(() => {
        expect(artifact, JSON.stringify(settled)).toBeDefined(); artifactId = String(artifact?.id);
        expect(coordinator.getLiveWaiterCount(artifactId)).toBe(1);
      });
      if (!artifact || !artifactId) throw new Error('Actual approval Artifact was not created');
      const content = decodePlainArtifactStoredContent(String(artifact.body));
      if (!content || typeof content !== 'object' || !('body' in content) || typeof content.body !== 'string') throw new Error('Approval body is unavailable');
      const request = StoredApprovalRequestSchema.parse(JSON.parse(content.body));
      expect(request.actionId).toBe('daemon.filesystem.copy');
      expect(paths.every(path => path === '/v1/account/encryption' || path === '/v1/account/profile' || path === '/v1/auth/api-tokens/list' || path.startsWith('/v1/artifacts'))).toBe(true);
      controller.abort();
      const result = await pending;
      expect(result, JSON.stringify({ result, paths, networkPaths,
        origin: request.v === 2 ? request.executionOriginV1 : null })).toMatchObject({ ok: false, errorCode: 'cancelled' });
      expect(paths.every(path => path === '/v1/account/encryption' || path === '/v1/account/profile' || path === '/v1/auth/api-tokens/list' || path.startsWith('/v1/artifacts'))).toBe(true);
      expect(networkPaths.every(path => path === '/v1/features' || path === '/v1/features/authenticated'), JSON.stringify(networkPaths)).toBe(true);
    } finally {
      controller.abort(); if (artifactId) coordinator.cancelApproval(artifactId);
      await pending?.catch(() => undefined);
      copySocketBoundary.create.mockReset(); stored.mockRestore(); profiles.mockRestore(); eligibility.mockRestore(); reads.mockRestore(); writes.mockRestore(); network.mockRestore();
    }
  });
  it.each(['mcp', 'agent'] as const)('uses captured Account-JWT exact Home RPC without a per-Home daemon for admitted %s copy', async surface => {
    const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'account-one' })).toString('base64url')}.signature`,
      encryption: null, credentialProvenance: 'stored_session' as const } satisfies persistence.StoredCredentials;
    const stored = vi.spyOn(persistence, 'readStoredCredentialsForServerId').mockResolvedValue(credentials);
    const profiles = vi.spyOn(serverProfiles, 'getServerProfile').mockImplementation(async id => ({
      id, name: id, serverUrl: `https://${id}.example.test`, webappUrl: `https://${id}.example.test`, createdAt: 0, updatedAt: 0, lastUsedAt: 0,
    }));
    const requests = vi.spyOn(axios, 'request');
    const reads = vi.spyOn(axios, 'get').mockImplementation(async (url, options) => {
      expect(String(url)).toBe('https://source.example.test/v1/machines/source-machine');
      expect(options?.headers).toMatchObject({ Authorization: `Bearer ${credentials.token}` });
      return { data: { machine: { id: 'source-machine', storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
        revokedAt: null, replacedByMachineId: null } } };
    });
    const socket = new EventEmitter();
    const io = createSocketIoManagerStub();
    const rpcRequests: unknown[] = [];
    const networkSocket = Object.assign(socket, { io, connected: false,
      connect: () => { networkSocket.connected = true; socket.emit('connect'); return networkSocket; },
      disconnect: () => { networkSocket.connected = false; return networkSocket; }, close: () => networkSocket,
      emitWithAck: async (_event: string, request: Readonly<{ method: string; params: unknown }>) => {
        expect(request.method).toBe('source-machine:daemon.filesystem.download');
        const opened = await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, request.params, request.method);
        rpcRequests.push(opened.params);
        return { ok: true, result: await socketRpcCodec.encodeResponse({ mode: 'plain' },
          { ok: false, errorCode: 'filesystem_requester_account_authority_unavailable', error: 'Requester authority unavailable' }, opened.callId) };
      },
    });
    // Socket.IO is the actual network boundary; transport, codec, exact target
    // lookup, policy and the byte-client admission remain real.
    copySocketBoundary.create.mockReturnValue(networkSocket);
    try {
      const executor = createCliActionExecutorFromCredentials({ credentials, serverId: 'destination', serverApiUrl: 'https://destination.example.test',
        serverIdentityId: 'destination-identity', machineId: 'destination-machine', pluginActionExecutionOwner: 'current_process',
        actionsSettingsProvider: createActionSettingsProvider({ accountSettings: accountSettingsParse({ actionsSettingsV1: {
          v: 1, actions: {}, approvalWaivedSurfaces: { 'daemon.filesystem.copy': [surface] },
        } }) }),
      });
      const input = { kind: 'target_copy', source: { serverId: 'source', machineId: 'source-machine', rootPath: '/source', path: 'binary' },
        destination: { serverId: 'destination', machineId: 'destination-machine', rootPath: '/destination', path: 'binary' }, overwrite: false, recursive: false };
      const result = await executor.execute('daemon.filesystem.copy', input, { surface, authority: 'account_automation', actionRequestId: 'copy-request',
        serverId: 'destination', externalActionTarget: { kind: 'machine', machineId: 'destination-machine' } });
      expect(result).toMatchObject({ ok: false });
      expect(rpcRequests).toEqual([{ v: 1, kind: 'targeted_action_rpc', target: { kind: 'machine', machineId: 'source-machine' },
        input: { rootPath: '/source', path: 'binary', asZip: false, format: 'entry_tree', destination: { destinationId: expect.any(String) } } }]);
      expect(copySocketBoundary.create.mock.calls[0]?.[0]).toBe('https://source.example.test');
      expect(copySocketBoundary.create.mock.calls[0]?.[1]).toMatchObject({ auth: { token: credentials.token, authorityCeiling: 'account_automation' } });
      expect(requests).not.toHaveBeenCalled();
    } finally { copySocketBoundary.create.mockReset(); stored.mockRestore(); profiles.mockRestore(); requests.mockRestore(); reads.mockRestore(); }
  });
  it.each([
    { surface: 'mcp' as const, approval: false, prepare: true, portableHomeIds: true },
    { surface: 'agent' as const, approval: false, prepare: false, portableHomeIds: false },
    { surface: 'mcp' as const, approval: true, prepare: false, portableHomeIds: true },
  ])('captures each Home credential once for public $surface binary copy despite saved-file replacement (blocking approval=$approval, portable Home IDs=$portableHomeIds)', async ({ surface, approval, prepare, portableHomeIds }) => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-public-copy-'));
    const sourceCredentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'source-account' })).toString('base64url')}.signature`,
      encryption: null, credentialProvenance: 'stored_session' as const } satisfies persistence.StoredCredentials;
    const destinationCredentials = { ...sourceCredentials, token: `header.${Buffer.from(JSON.stringify({ sub: 'destination-account' })).toString('base64url')}.signature` };
    for (const [serverId, credentials] of [['source', sourceCredentials], ['destination', destinationCredentials]] as const) {
      await serverProfiles.adoptServerProfileHomeConnectionDescriptor({ expectedProfileId: serverId, createIfMissing: true, observation: 'exact',
        descriptor: { v: 1, homeServerIdentityId: `srv_${serverId}`, canonicalServerUrl: `https://${serverId}.example.test`,
          revision: 1, endpoints: [{ kind: 'https', url: `https://${serverId}.example.test` }] } });
      await persistence.writeStoredCredentialsForServerId(serverId, credentials);
    }
    // Observe actual OS credential reads while keeping the profile, decoder,
    // transfer orchestration and receiving filesystem owners real.
    const credentialReads = vi.spyOn(fsPromises, 'readFile');
    const readHomes = () => credentialReads.mock.calls.flatMap(([path]) => {
      if (String(path) === join(configuration.serversDir, 'source', 'access.key')) return ['source'];
      if (String(path) === join(configuration.serversDir, 'destination', 'access.key')) return ['destination'];
      return [];
    });
    let credentialsReplaced = false;
    const replaceCredentials = async () => {
      if (credentialsReplaced) return;
      credentialsReplaced = true;
      for (const [serverId, credentials] of [['source', sourceCredentials], ['destination', destinationCredentials]] as const) {
        await persistence.writeStoredCredentialsForServerId(serverId, { ...credentials,
          token: `header.${Buffer.from(JSON.stringify({ sub: `${serverId}-replacement-account` })).toString('base64url')}.signature` });
      }
    };
    const reservation = createServer();
    await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const address = reservation.address(); if (!address || typeof address === 'string') throw new Error('Expected loopback port');
    await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
    const lifecycle = createDirectTransferServerLifecycle({ bindPort: address.port, listenerClasses: ['loopback_http'] });
    const effect = createPreparedFilesystemTransferActionExecutor({ lifecycle, workingDirectory: directory, accessPolicy: { kind: 'restrictedRoots', roots: [directory] } });
    const store = createActionOperationStore(); let sequence = 0;
    const runner = createActionOperationRunner({ store, generateOperationId: () => `public-copy-${++sequence}`,
      resolveAction: id => {
        const spec = getActionSpec(ActionIdSchema.parse(id));
        return { actionId: spec.id, title: spec.title, operation: spec.operation };
      } });
    const signingKey = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
    const endpointId = 'b'.repeat(64);
    const home = (url: string) => new URL(url).hostname.split('.')[0];
    const account = (id: string) => id === 'source' ? 'source-account' : 'destination-account';
    const token = (id: string) => id === 'source' ? sourceCredentials.token : destinationCredentials.token;
    const methods: string[] = [];
    let artifact: Readonly<Record<string, unknown>> | undefined;
    const eligibility = vi.spyOn(axios, 'request').mockImplementation(async config => {
      expect(config.method).toBe('POST');
      expect(config.url).toBe('https://destination.example.test/v1/auth/api-tokens/list');
      expect(config.headers).toMatchObject({ Authorization: `Bearer ${destinationCredentials.token}` });
      return { status: 200, data: { tokens: [] } };
    });
    const reads = vi.spyOn(axios, 'get').mockImplementation(async (url, options) => {
      const parsed = new URL(String(url)); const id = home(parsed.href);
      expect(options?.headers).toMatchObject({ Authorization: `Bearer ${token(id)}` });
      if (parsed.pathname === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
      if (artifact && parsed.pathname === `/v1/artifacts/${artifact.id}`) return { status: 200, data: artifact };
      // Approval publication first reads its deterministic id to join an
      // existing request; the HTTP owner returns 404 before its first create.
      if (!artifact && parsed.pathname.startsWith('/v1/artifacts/')) return { status: 404, data: { error: 'Artifact not found' } };
      if (parsed.pathname === '/v1/account/profile') return { status: 200, data: { id: account(id) } };
      if (parsed.pathname === '/v1/machines') return { status: 200, data: [{ id: `${id}-machine`, active: true, kind: 'persistent',
        revokedAt: null, replacedByMachineId: null, operationProtocolCapabilitiesRevision: 1,
        operationProtocolCapabilities: { irohMachineEndpoint: { protocolVersions: [1], endpointId } } }] };
      expect(parsed.pathname).toBe(`/v1/machines/${id}-machine`);
      return { status: 200, data: { machine: { id: `${id}-machine`, storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
        revokedAt: null, replacedByMachineId: null } } };
    });
    const writes = vi.spyOn(axios, 'post').mockImplementation(async (url, value, options) => {
      const parsed = new URL(String(url)); const id = home(parsed.href);
      expect(options?.headers).toMatchObject({ Authorization: `Bearer ${token(id)}` });
      if (parsed.pathname === '/v1/artifacts') {
        const input = readCarrierMutation(value);
        artifact = { ...input, ownerAccountId: account(id), access: 'owner', encryptionMode: 'plain',
          headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
        return { status: 200, data: { id: input.id, headerVersion: 1, bodyVersion: 1 } };
      }
      if (artifact && parsed.pathname === `/v1/artifacts/${artifact.id}`) {
        const input = readCarrierMutation(value);
        const headerVersion = Number(artifact.headerVersion) + 1; const bodyVersion = Number(artifact.bodyVersion) + 1;
        artifact = { ...artifact, ...input, headerVersion, bodyVersion };
        return { status: 200, data: { success: true, headerVersion, bodyVersion } };
      }
      expect(parsed.pathname).toBe('/v1/machines/peer/mediation/route-grants');
      const { kind, ttlMs, ...binding } = DirectRouteGrantRequestV2Schema.parse(value);
      const now = Date.now();
      const payload = DirectRouteGrantPayloadV2Schema.parse({ ...binding, accountId: account(id), grantId: `${id}-grant`,
        iat: now, exp: now + ttlMs, aud: 'happier-daemon-route-grant', proofKind: kind });
      return { status: 200, data: { ok: true, grant: { payload, signature: { alg: 'Ed25519', keyId: 'home-key',
        valueBase64Url: Buffer.from(tweetnacl.sign.detached(Buffer.from(createDirectRouteGrantSigningInputV2(payload)), signingKey.secretKey)).toString('base64url') } } } };
    });
    const nativeFetch = globalThis.fetch;
    const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === '/v1/features') return Response.json({ features: {}, capabilities: {
        serverIdentity: { serverIdentityId: `srv_${home(parsed.href)}` },
      } });
      if (parsed.pathname === '/v1/features/authenticated') {
        expect(init?.headers).toMatchObject({ Authorization: `Bearer ${token(home(parsed.href))}` });
        return Response.json({ features: {}, capabilities: { serverIdentity: { serverIdentityId: `srv_${home(parsed.href)}` }, machines: { peerMediation: { grantSigningKeys: [{ keyId: 'home-key',
          publicKey: Buffer.from(signingKey.publicKey).toString('base64url') }] } } } });
      }
      return await nativeFetch(url, init);
    });
    const unavailableNative = async (): Promise<never> => { throw new Error('Unexpected native transport operation'); };
    const native = {
      getAvailability: () => { throw new Error('Unexpected native availability read'); },
      startHomeAcceptor: unavailableNative, stopHomeAcceptor: unavailableNative, ensureHomeTunnel: unavailableNative,
      releaseHomeTunnel: unavailableNative, getTunnelStatus: unavailableNative,
      startMachineAcceptor: unavailableNative, stopMachineAcceptor: unavailableNative, getMachineAcceptorStatus: unavailableNative,
      startMachineHttpTunnel: unavailableNative, getMachineTunnelStatus: unavailableNative,
      createEndpoint: vi.fn(async (request: unknown) => { expect(request).not.toHaveProperty('keyPath'); return {
        endpointHandle: 'client', endpointId: 'a'.repeat(64), relayPolicy: 'automatic', relayMode: 'disabled', capProfile: 'machineBulk', relayUrls: [],
      } as const; }),
      getEndpointStatus: async () => ({ endpointHandle: 'client', endpointId: 'a'.repeat(64), active: true, relayUrls: [], directAddresses: [], capProfile: 'machineBulk', relayPolicy: 'automatic', relayMode: 'disabled' } as const),
      startMachineTunnel: async () => ({ machineTunnelId: `tunnel-${sequence}`, endpointHandle: 'client', localPort: await lifecycle.ensureListening(),
        connectionActive: true, remoteEndpointId: endpointId, observedPath: 'direct', startedAtMs: Date.now(), lastErrorCode: null } as const),
      stopMachineTunnel: vi.fn(async () => {}), shutdownEndpoint: vi.fn(async () => {}),
    } satisfies Extract<ReturnType<typeof irohNative.loadIrohNodeNative>, { available: true }>['native'];
    // Only the native SDK boundary is substituted; signed grant/proof checks,
    // finite runtime custody, HTTP encryption and both prepared records are real.
    const nativeBoundary = vi.spyOn(irohNative, 'loadIrohNodeNative').mockReturnValue({ available: true, native, addonPath: '/test/iroh.node' });
    copySocketBoundary.create.mockImplementation((url: string, options: Readonly<{ auth: Readonly<{ token: string }> }>) => {
      const id = home(url); expect(options.auth.token).toBe(token(id));
      const socket = new EventEmitter();
      const connected = Object.assign(socket, { io: createSocketIoManagerStub(), connected: false,
        connect: () => { connected.connected = true; socket.emit('connect'); return connected; },
        disconnect: () => { connected.connected = false; return connected; }, close: () => connected,
        emitWithAck: async (_event: string, request: Readonly<{ method: string; params: unknown }>) => {
          const decoded = await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, request.params, request.method);
          const admitted = TargetedActionRpcRequestV1Schema.parse(decoded.params);
          const actionId = id === 'source' ? 'daemon.filesystem.download' : 'daemon.filesystem.copy';
          expect(admitted.target).toEqual({ kind: 'machine', machineId: `${id}-machine` });
          expect(request.method).toBe(`${id}-machine:${getActionSpec(actionId).bindings?.rpcMethod}`); methods.push(actionId);
          if (!approval && !prepare) await replaceCredentials();
          const result = await runner.observe({ actionId, scope: { accountId: account(id), machineId: `${id}-machine` },
            execute: context => effect({ actionId, input: admitted.input, context: { ...context, runtimeAccountId: account(id), serverId: id,
              externalActionTarget: { kind: 'machine', machineId: `${id}-machine` } } }).then(projectPreparedFilesystemActionResult) });
          return { ok: true, result: await socketRpcCodec.encodeResponse({ mode: 'plain' }, result.ok ? result.result : result, decoded.callId) };
        } });
      return connected;
    });
    const controller = new AbortController();
    const coordinator = getSharedBlockingApprovalCoordinator();
    let pending: Promise<unknown> | undefined;
    let settled: unknown;
    let artifactId: string | undefined;
    try {
      const bytes = Buffer.from([0, 255, 128, 10]); await writeFile(join(directory, 'source.bin'), bytes);
      const executor = createCliActionExecutorFromCredentials({ credentials: destinationCredentials,
        readCredentials: () => persistence.readStoredCredentialsForServerId('destination'), serverId: 'destination', serverApiUrl: 'https://destination.example.test',
        serverIdentityId: 'srv_destination', machineId: 'destination-machine', pluginActionExecutionOwner: 'current_process',
        actionsSettingsProvider: createActionSettingsProvider({ accountSettings: accountSettingsParse({ actionsSettingsV1: {
          v: 1, actions: approval ? { 'daemon.filesystem.copy': { approvalRequiredSurfaces: [surface] } } : {},
          ...(approval ? {} : { approvalWaivedSurfaces: { 'daemon.filesystem.copy': [surface] } }),
        } }) }) });
      const input = { kind: 'prepared_transfer', source: { kind: 'file', serverId: portableHomeIds ? 'srv_source' : 'source', machineId: 'source-machine', rootPath: directory, path: 'source.bin',
        sourceId: 'actual-file', sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
        destination: { serverId: portableHomeIds ? 'srv_destination' : 'destination', machineId: 'destination-machine', rootPath: directory, path: 'copied.bin' }, overwrite: false, recursive: false };
      const context = { surface, authority: 'account_automation' as const, serverId: portableHomeIds ? 'srv_destination' : 'destination',
        actionRequestId: 'public-binary-copy', signal: controller.signal,
        externalActionTarget: { kind: 'machine' as const, machineId: 'destination-machine' } };
      expect(await executor.execute('daemon.filesystem.copy', { ...input,
        destination: { ...input.destination, serverId: 'srv_foreign' } }, context))
        .toMatchObject({ ok: false, errorCode: 'target_unavailable' });
      expect(await executor.execute('daemon.filesystem.copy', input, { ...context, serverId: 'srv_foreign' }))
        .toMatchObject({ ok: false, errorCode: 'target_unavailable' });
      credentialReads.mockClear();
      if (prepare) {
        const prepared = await executor.prepare('daemon.filesystem.copy', input, context);
        expect(prepared.kind).toBe('ready');
        if (prepared.kind !== 'ready') throw new Error('Copy admission did not produce a concrete invocation');
        await replaceCredentials();
        pending = prepared.invocation.run();
      } else {
        pending = executor.execute('daemon.filesystem.copy', input, context).then(result => { settled = result; return result; });
      }
      if (approval) {
        await vi.waitFor(() => {
          expect(artifact, JSON.stringify(settled)).toBeDefined(); artifactId = String(artifact?.id);
          expect(coordinator.getLiveWaiterCount(artifactId)).toBe(1);
        });
        expect(methods).toEqual([]); expect(native.createEndpoint).not.toHaveBeenCalled();
        if (!artifact || !artifactId) throw new Error('Actual blocking copy Artifact is unavailable');
        const content = decodePlainArtifactStoredContent(String(artifact.body));
        if (!content || typeof content !== 'object' || !('body' in content) || typeof content.body !== 'string') throw new Error('Approval body is unavailable');
        const request = StoredApprovalRequestSchema.parse(JSON.parse(content.body));
        await replaceCredentials();
        expect(await coordinator.resolveBlockingDecision({ artifactId, request, decision: 'approve', decisionAuthority: 'present_user' })).toEqual({ resolved: true });
      }
      const result = await pending;
      expect(readHomes().sort(), JSON.stringify(result)).toEqual(['destination', 'source']);
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { success: true, status: 'completed' } });
      expect(await readFile(join(directory, 'copied.bin'))).toEqual(bytes);
      expect(credentialsReplaced).toBe(true);
      expect(methods).toEqual(['daemon.filesystem.download', 'daemon.filesystem.copy']);
      expect(native.shutdownEndpoint).toHaveBeenCalledTimes(2);
    } finally {
      controller.abort(); if (artifactId) coordinator.cancelApproval(artifactId); await pending?.catch(() => undefined);
      copySocketBoundary.create.mockReset(); credentialReads.mockRestore(); eligibility.mockRestore(); reads.mockRestore(); writes.mockRestore(); network.mockRestore(); nativeBoundary.mockRestore();
      await lifecycle.stop(); await rm(directory, { recursive: true, force: true });
    }
  });
  it('fails closed on a predecessor method table without falling back to the unrooted alias', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'happier-filesystem-predecessor-'));
    const manager = new RpcHandlerManager({ scopePrefix: 'machine', localMachineId: 'machine', encryptionMode: 'plain' });
    // The observed predecessor only has renamePath and does not consume rootPath.
    manager.registerHandler('renamePath', async ({ from, to }: { from: string; to: string }) => {
      await rename(join(rootPath, from), join(rootPath, to));
      return { success: true };
    });
    try {
      const bytes = Buffer.from([0, 255, 128]);
      await writeFile(join(rootPath, 'source.bin'), bytes);
      const executor = createReviewedFilesystemExecutor({ token: 'admitted-daemon', sessionId: '', mode: 'plain', ctx: null,
        machineActionDirectTargetTransport: { machineId: 'machine', invoke: (method, request, options) => manager.invokeLocal(method, request, options) },
      });
      expect(await executor.execute(ActionIdSchema.parse('daemon.filesystem.rename'), {
        rootPath, from: 'source.bin', to: 'moved.bin', overwrite: false,
      }, {
        surface: 'rpc', authority: 'account_automation', externalActionTarget: { kind: 'machine', machineId: 'machine' },
      })).toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND });
      expect(await readFile(join(rootPath, 'source.bin'))).toEqual(bytes);
      await expect(stat(join(rootPath, 'moved.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it('reaches the registered daemon filesystem owner without redispatching the full executor', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'happier-filesystem-deps-'));
    const manager = new RpcHandlerManager({ scopePrefix: 'machine', localMachineId: 'machine', encryptionMode: 'plain' });
    const machineOwner = createReviewedFilesystemExecutor({ token: 'admitted-daemon', sessionId: '', mode: 'plain', ctx: null }, {
      filesystemActionExecute: request => {
        const actionId = FILESYSTEM_MUTATION_ACTION_IDS.find(id => id === request.actionId);
        if (!actionId) return Promise.resolve({ ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' });
        return executeFilesystemMutationAction({ actionId, input: request.input, workingDirectory: rootPath,
          accessPolicy: { kind: 'osUser' }, getAdditionalAllowedReadDirs: () => [], getAdditionalAllowedWriteDirs: () => [] });
      },
    });
    const registration = registerFileSystemHandlers(manager, rootPath, { mutationMachineId: 'machine', actionExecutor: {
      execute: (actionId, input, context) => machineOwner.execute(actionId, input, {
        ...context, serverId: 'home', externalActionTarget: { kind: 'machine', machineId: 'machine' },
      }),
    } });
    try {
      const bytes = Buffer.from([0, 128, 255, 10]);
      await writeFile(join(rootPath, 'source.bin'), bytes);
      const executor = createReviewedFilesystemExecutor({ token: 'admitted-daemon', sessionId: '', mode: 'plain', ctx: null,
        machineActionDirectTargetTransport: { machineId: 'machine', invoke: (method, request, options) =>
          manager.invokeLocal(method, request, options) },
      });
      expect(await executor.execute(ActionIdSchema.parse('daemon.filesystem.copy'), {
        rootPath, from: 'source.bin', to: 'copy.bin', overwrite: false, recursive: false,
      }, {
        surface: 'rpc', authority: 'account_automation', externalActionTarget: { kind: 'machine', machineId: 'machine' },
      })).toEqual({ ok: true, result: { success: true } });
      expect(await readFile(join(rootPath, 'copy.bin'))).toEqual(bytes);
      expect(await readFile(join(rootPath, 'source.bin'))).toEqual(bytes);
    } finally {
      await registration.dispose();
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it.each([
    { success: false, error: 'Destination already exists' },
    { success: false, error: 'Method not found', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND },
  ] as const)('preserves the declared root and domain failure through the admitted machine transport: %j', async result => {
    const calls: Array<Readonly<{ method: string; request: unknown }>> = [];
    const executor = createReviewedFilesystemExecutor({ token: 'admitted-daemon', sessionId: '', mode: 'plain', ctx: null,
      machineActionDirectTargetTransport: { machineId: 'machine', invoke: async (method, request) => {
        calls.push({ method, request });
        return result;
      } },
    });
    const input = { rootPath: '/selected/workspace', from: 'source.bin', to: 'target.bin', overwrite: false };
    expect(await executor.execute(ActionIdSchema.parse('daemon.filesystem.rename'), input, {
      surface: 'rpc', authority: 'account_automation', externalActionTarget: { kind: 'machine', machineId: 'machine' },
    })).toEqual({ ok: true, result });
    expect(calls).toEqual([{ method: 'daemon.filesystem.rename', request: input }]);
  });

  it('keeps malformed Machine refusals at the strict filesystem output boundary', async () => {
    const executor = createReviewedFilesystemExecutor({ token: 'admitted-daemon', sessionId: '', mode: 'plain', ctx: null,
      // Only the Machine transport is replaced; admission, refusal classification
      // and the filesystem Action's strict output schema remain real.
      machineActionDirectTargetTransport: { machineId: 'machine', invoke: async () => ({
        error: 'Method not found', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND, unexpected: true,
      }) },
    });
    expect(await executor.execute('daemon.filesystem.readFile', { rootPath: '/selected/workspace', path: 'file' }, {
      surface: 'rpc', authority: 'account_automation', externalActionTarget: { kind: 'machine', machineId: 'machine' },
    })).toMatchObject({ ok: false, errorCode: 'invalid_action_output' });
  });

  it('refuses to reuse an admitted transport for another machine', async () => {
    let sent = false;
    const executor = createReviewedFilesystemExecutor({ token: 'admitted-daemon', sessionId: '', mode: 'plain', ctx: null,
      machineActionDirectTargetTransport: { machineId: 'admitted', invoke: async () => { sent = true; return { success: true }; } },
    });
    expect(await executor.execute(ActionIdSchema.parse('daemon.filesystem.createDirectory'), { rootPath: '/selected/workspace', path: 'new' }, {
      surface: 'rpc', authority: 'account_automation', externalActionTarget: { kind: 'machine', machineId: 'different' },
    })).toMatchObject({ ok: false, errorCode: 'not_authenticated' });
    expect(sent).toBe(false);
  });
});
