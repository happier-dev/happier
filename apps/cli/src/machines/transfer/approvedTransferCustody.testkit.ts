import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import axios from 'axios';
import { expect, vi } from 'vitest';
import { EXTERNAL_ACTION_EFFECT_ACTION_HEADER, EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, ExternalActionExecutionAuthorizationV1Schema, ExternalActionServerPrincipalV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { ProjectSourcesListOutputV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { sealExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { ACTION_OPERATION_RPC_METHODS_V1, ACTION_OPERATION_RPC_METHODS_V2, ActionOperationGetV1ResponseSchema, ActionOperationListV1ResponseSchema } from '@happier-dev/protocol/actions/operations/v1';
import { ApiMachineClient } from '@/api/apiMachine';
import { readCarrierMutation } from '@/api/artifacts/accountArtifactStore.testkit';
import { createRequesterSessionControlRuntimeFixture } from '@/daemon/testkit/requesterSessionControlRuntimeFixture';
import { ConnectedServiceRuntimeRegistry } from '@/daemon/connectedServices/runtimeRegistry/registry';
import { executeExternalAction } from '@/daemon/externalActions/executeExternalAction';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { writeStoredCredentialsForServerId } from '@/persistence';
import { readOrCreateInstallationIdentity } from '@/daemon/identity/store';
import { createDirectTransferServerLifecycle } from './directTransferServerLifecycle';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { createTargetedActionRpcRequestV1 } from '@happier-dev/protocol/actions/actionRpcTransport';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { DaemonPluginStructuredMessageActionExecuteRequestSchema, DaemonPluginStructuredMessageActionExecuteResponseSchema } from '@happier-dev/protocol';
import { prepareWorkspaceFileExport } from './prepareWorkspaceFileExport';
import type { ActionOperationRpcContext } from '@/daemon/actionOperations/actionOperationRpcHandlers';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import type { StablePluginConnectedAccountsOwner } from '@/plugins/runtime/invocation/services/connectedAccounts';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { defineProtocolObject, FileDownloadDestinationV1ProtocolSchema, FileDownloadResultV1ProtocolSchema } from '@happier-dev/plugin-sdk/protocol';

const boundary = vi.hoisted(() => ({ home: '' }));
vi.mock('@/configuration', async importOriginal => {
  const original = await importOriginal<typeof import('@/configuration')>();
  return { ...original, configuration: { ...original.configuration,
    get happyHomeDir() { return boundary.home; }, set happyHomeDir(value: string) { boundary.home = value; },
    get logsDir() { return join(boundary.home, 'logs'); },
  } };
});
// The daemon's physical listener is replaced; installed Action admission/replay stays real.
vi.mock('@/daemon/controlServer', () => ({ startDaemonControlServer: async () => ({ port: 44322, stop: async () => {} }) }));

export const DOWNLOAD_PLUGIN_ID = 'external.deferred-download';
export const transferRootToken = (accountId: string, actionId: string, requestId: string) => `transfer-root:${accountId}:${actionId}:${requestId}`;

export async function setup(approvalRequired: boolean, providerDownload = false, postDownloadRead = false,
  providerPlugin?: Parameters<typeof createAuthoredAdmittedPluginRuntimeFixture>[0]['plugins'][number],
  resolveContributes?: Parameters<typeof createAuthoredAdmittedPluginRuntimeFixture>[0]['resolveContributes'],
  connectedAccounts?: StablePluginConnectedAccountsOwner) {
  boundary.home = await mkdtemp(join(tmpdir(), 'happier-approved-transfer-'));
  const directory = boundary.home;
  const env = createEnvKeyScope(['HAPPIER_MACHINE_RPC_WORKING_DIRECTORY']);
  env.patch({ HAPPIER_MACHINE_RPC_WORKING_DIRECTORY: directory });
  const homeId = 'srv_transfer_custody';
  const endpoint = 'https://transfer-custody.test';
  const token = (accountId: string, terminal = false) => `fixture.${Buffer.from(JSON.stringify({ sub: accountId, tokenEpoch: 0,
    provenance: { v: 1, kind: terminal ? 'terminal' : 'account', authority: terminal ? 'account_automation' : 'present_user' } })).toString('base64url')}.signature`;
  const credentials = { token: token('alice', true), encryption: null };
  const currentness = await createRequesterCurrentnessSocketHarness();
  const lifecycle = createDirectTransferServerLifecycle({ bindPort: 0, listenerClasses: ['loopback_http'] });
  const settings = { actionsSettingsV1: { v: 1, ...(approvalRequired
    ? { actions: { 'daemon.filesystem.download': { approvalRequiredSurfaces: ['ui'] } } }
    : { approvalWaivedSurfaces: { 'daemon.filesystem.download': ['ui'] } }) } };
  let artifact: Record<string, unknown> | undefined;
  let requesterRevoked = false;
  let originalRootVerifications = 0;
  const rootAccounts = new Map<string, string>();
  const postDownloadReadRoots: string[] = [];
  let notifyApproval!: () => void;
  const approvalCreated = new Promise<void>(resolve => { notifyApproval = resolve; });
  const cancellation = new AbortController();
  const nativeFetch = globalThis.fetch;
  // Home HTTP is the external boundary. Artifact mode parsing, CAS transitions,
  // requester rehydration, approval execution and operation ownership remain real.
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url, options) => {
    const target = new URL(String(url));
    if (target.origin !== endpoint) return nativeFetch(url, options);
    if (target.pathname === '/v1/account/profile') return Response.json({ id: [credentials.token, token('alice')]
      .some(value => new Headers(options?.headers).get('authorization')?.includes(value)) ? 'alice' : 'bob' });
    if (target.pathname === '/v1/features' || target.pathname === '/v1/features/authenticated') return Response.json({ features: {},
      capabilities: { serverIdentity: { serverIdentityId: homeId } } });
    throw new Error(`Unexpected Home fetch: ${target.pathname}`);
  }));
  vi.spyOn(axios, 'get').mockImplementation(async (url, options) => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/profile') {
      const accountId = [credentials.token, token('alice')].some(value => String(options?.headers?.Authorization).includes(value)) ? 'alice' : 'bob';
      return { status: 200, data: { id: accountId } };
    }
    if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } } };
    if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: settings }, version: 1 } };
    if (path === '/v1/artifacts') return { status: 200, data: artifact ? [artifact] : [] };
    if (artifact && path === `/v1/artifacts/${artifact.id}`) return { status: 200, data: artifact };
    throw new Error(`Unexpected Home read: ${path}`);
  });
  vi.spyOn(axios, 'request').mockImplementation(async options => {
    const path = new URL(String(options.url)).pathname;
    if (path !== '/v1/projects/sources' || options.method !== 'GET') throw new Error(`Unexpected Home request: ${path}`);
    const root = options.headers?.[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER];
    if (typeof root !== 'string' || !rootAccounts.has(root)) return { status: 403, data: { error: 'invalid_execution_authorization' } };
    if (options.headers?.[EXTERNAL_ACTION_EFFECT_ACTION_HEADER] === 'projects.sources.list') {
      postDownloadReadRoots.push(root);
      // Observe the real payload disposal (including its requester release),
      // not merely the receiver ACK, before the handler's next service call.
      if (postDownloadReadRoots.length === 1) await new Promise<void>((resolve, reject) => {
        let unsubscribe = () => {};
        const check = async () => {
          try {
            if ((await lifecycle.activity.read()).items.length !== 0) return;
            unsubscribe();
            resolve();
          } catch (error) {
            unsubscribe();
            reject(error);
          }
        };
        unsubscribe = lifecycle.activity.subscribe(() => { void check(); });
        void check();
      });
    }
    return { status: 200, data: ProjectSourcesListOutputV1Schema.parse({ ok: true, sources: [], coverage: { complete: true, nextCursor: null } }) };
  });
  vi.spyOn(axios, 'post').mockImplementation(async (url, body, options) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/execution-authorization/verify')) {
      if (path === '/v1/actions/action.invoke/execution-authorization/verify') {
        originalRootVerifications += 1;
        if (requesterRevoked) return { status: 403, data: {} };
      }
      return { status: 200, data: { ok: true } };
    }
    if (path === '/v1/artifacts') {
      const value = readCarrierMutation(body);
      const ownerAccountId = [credentials.token, token('alice')].some(value => String(options?.headers?.Authorization).includes(value)) ? 'alice' : 'bob';
      artifact = { ...value, ownerAccountId, access: 'owner', encryptionMode: 'plain',
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
      notifyApproval();
      return { status: 200, data: { id: value.id, headerVersion: 1, bodyVersion: 1 } };
    }
    if (artifact && path === `/v1/artifacts/${artifact.id}`) {
      const value = readCarrierMutation(body);
      expect(value.expectedHeaderVersion).toBe(artifact.headerVersion);
      expect(value.expectedBodyVersion).toBe(artifact.bodyVersion);
      artifact = { ...artifact, ...value, headerVersion: Number(artifact.headerVersion) + 1, bodyVersion: Number(artifact.bodyVersion) + 1 };
      return { status: 200, data: { success: true, headerVersion: artifact.headerVersion, bodyVersion: artifact.bodyVersion } };
    }
    throw new Error(`Unexpected Home write: ${path}`);
  });
  const createProvider = async () => providerDownload || providerPlugin ? await createAuthoredAdmittedPluginRuntimeFixture({
    happyHomeDir: directory,
    controller: pluginReloadController,
    ...(resolveContributes ? { resolveContributes } : {}),
    plugins: providerPlugin ? [providerPlugin] : [{ manifest: createPluginManifestV2Fixture({ id: DOWNLOAD_PLUGIN_ID, contributes: { actions: [{
      id: 'download', title: 'Download provider bytes', scopes: ['global'], surfaces: ['ui', 'agent', 'mcp'],
      dangerLevel: 'writesLocal', execution: { target: 'daemon' }, placementBindings: [],
      confirmation: { title: 'Download provider bytes?' }, confirmationWhen: { presentUserUi: false },
      operation: { version: 1, visibility: 'activity', progress: 'indeterminate', presentation: { onStart: 'activity' } },
      inputSchema: defineProtocolObject({ destination: FileDownloadDestinationV1ProtocolSchema }, { policy: 'closed' }).jsonSchema,
      resultSchema: FileDownloadResultV1ProtocolSchema.jsonSchema,
    }] } }), files: { 'daemon.mjs': `export function activate(api) {
      api.actions.register('download', async (input, context) => {
        const completed = await context.services.fs.prepareDownload({
          name: 'provider.bin', bytes: new Uint8Array([0, 255, 137, 80]), destination: input.destination,
        }, { signal: new AbortController().signal });
        ${postDownloadRead ? `if (completed.success) { await context.services.actions.execute('projects.sources.list', { serverId: ${JSON.stringify(homeId)} }, { signal: context.signal }); await context.services.actions.execute('projects.sources.list', { serverId: ${JSON.stringify(homeId)} }, { signal: context.signal }); }` : ''}
        return completed;
      });
    }` } }],
    runtimeOptions: { ...(connectedAccounts ? { connectedAccounts } : {}), ...(postDownloadRead ? { scopedActionRuntime: { credentials,
      actionsSettingsProvider: createActionSettingsProvider({ getAccountSettings: () => accountSettingsParse(settings), allowEnvironmentOverride: false }) } } : {}),
      resolveCurrentMachineId: () => 'machine',
      resolveCurrentMachineExecutionOriginContext: async () => ({ machineId: 'machine', serverIdentityId: homeId }) },
  }) : null;
  let provider: Awaited<ReturnType<typeof createProvider>> = null;
  let machine!: ApiMachineClient;
  const installed = await createRequesterSessionControlRuntimeFixture({ happyHomeDir: directory,
    activeServerDir: join(directory, 'servers', homeId), serverId: homeId, serverHttpBaseUrl: endpoint,
    machineId: 'machine', custodianAccountId: 'alice', credentials,
    connectedServicesMaterializationBaseDir: join(directory, 'connected-services'), registry: new ConnectedServiceRuntimeRegistry(),
    trackedSessions: new Map(), getRequester: () => null, resolveQualifiedConnectedAccountV4Support: () => 'advertised',
    getApiMachineForSessions: () => machine,
    beforeStartup: async () => {
      // The registry captures this real Home configuration at construction.
      provider = await createProvider();
      await writeStoredCredentialsForServerId(homeId, credentials);
      await readOrCreateInstallationIdentity();
      machine = new ApiMachineClient(credentials.token, { id: 'machine', encryptionMode: 'plain', encryptionKey: new Uint8Array(32),
        encryptionVariant: 'legacy', metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 }, undefined,
      { directPeerServerLifecycle: lifecycle });
    },
    startup: { ...(providerDownload || providerPlugin ? { pluginRuntimeController: pluginReloadController } : {}),
      resolveCurrentMachineExecutionOriginContext: async () => ({ machineId: 'machine', serverIdentityId: homeId }) },
  });
  const installation = installed.installation!;
  const ingress = installed.runtime.externalActionIngressOwner!;
  machine.setRPCHandlers({ spawnSession: async () => ({ type: 'error', errorMessage: 'Unexpected launch' }),
    stopSession: async () => false, requestShutdown: () => {}, directTransferExport: {
      prepareExportSession: async request => {
        if (request.t !== 'workspace_file_download_v1') throw new Error('Unexpected non-file export');
        return prepareWorkspaceFileExport({ lifecycle, request, accessPolicy: { kind: 'restrictedRoots', roots: [directory] } });
      },
      releaseExportSession: transferId => { lifecycle.clearPublishedTransfer(transferId); },
    },
  }, { externalActionIngressOwner: ingress });
  const context: ActionOperationRpcContext = { machineAdmission: { actorAccountId: 'bob', custodianAccountId: 'alice', machineId: 'machine',
    installationId: installation.installationId, role: 'use', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true };
  const invoke = async (actionId: 'daemon.filesystem.download' | 'approval.request.decide' | 'action.invoke', input: unknown, requestId: string, rpc = false,
    actorAccountId = 'bob', surface: 'ui' | 'agent' = 'ui') => {
    const target = { kind: 'machine' as const, machineId: 'machine' };
    const envelope = { v: 1 as const, requestId, target, input };
    const authority = surface === 'agent' ? 'account_automation' as const : 'present_user' as const;
    const authentication = { kind: surface === 'agent' ? 'terminal' as const : 'account' as const, tokenEpoch: 0 };
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: transferRootToken(actorAccountId, actionId, requestId), binding: {
      accountId: actorAccountId, custodianAccountId: 'alice', authentication, accountEncryptionMode: 'plain', machineId: 'machine',
      installationId: installation.installationId, serverIdentityId: homeId, actionId, requestId,
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), target } });
    rootAccounts.set(authorization.token, authorization.binding.accountId);
    const boxed = sealExternalActionRequesterAccountContextV1({ authorization, purpose: { kind: 'external_action' },
      invocation: { caller: { kind: 'host' }, surface, authority }, installationPublicKey: decodeBase64(installation.publicKey, 'base64url'),
      credentials: { token: token(actorAccountId, surface === 'agent') }, randomBytes: length => new Uint8Array(randomBytes(length)) });
    if (rpc) {
      const prepared = await ingress.prepareRequesterAccountContext!({ authorization: boxed });
      if (!prepared) throw new Error('Requester RPC custody was not admitted');
      try {
        const options = { rpcContext: { ...context, signal: cancellation.signal,
            transportRequestId: requestId, callerAuthority: 'present_user', callerInputAuthorization: prepared.authorization },
          localActionContext: { surface: 'ui', authority: 'present_user', actionRequestId: requestId } } as const;
        if (actionId === 'action.invoke') {
          const invocation = getActionSpec('action.invoke').inputSchema.parse(input);
          const result = DaemonPluginStructuredMessageActionExecuteResponseSchema.parse(await machine.invokeLocalMachineAction(
            RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE,
            DaemonPluginStructuredMessageActionExecuteRequestSchema.parse({ machineId: 'machine', requestId,
              qualifiedActionId: buildQualifiedPluginContributionKey(invocation.action),
              expectedContributorOccurrenceId: provider?.registry.readPluginOccurrenceId?.(invocation.action.pluginId),
              input: invocation.input, executionSurface: 'ui' }), options));
          return result.ok ? { ok: true as const, result: result.result }
            : ActionExecuteFailureSchema.parse({ ok: false, errorCode: result.code, error: result.code });
        }
        const result = await machine.invokeLocalMachineAction(RPC_METHODS.DAEMON_FILESYSTEM_DOWNLOAD,
          createTargetedActionRpcRequestV1(input, target), options);
        const failure = ActionExecuteFailureSchema.safeParse(result);
        return failure.success ? failure.data : { ok: true as const, result };
      } finally { await prepared.dispose(); }
    }
    const outcome = await executeExternalAction({ actionId, envelope, surface, signal: cancellation.signal,
      principal: ExternalActionServerPrincipalV1Schema.parse({ accountId: actorAccountId, authentication, authority }),
      currentMachineId: 'machine', currentServerId: homeId, currentServerHttpBaseUrl: endpoint, currentInstallationId: installation.installationId,
      executionAuthorization: boxed, externalActionMachineRequestPrivateKey: decodeBase64(installation.privateKey, 'base64url'),
      verifyExecutionAuthorization: async () => true, prepareRequesterAccountContext: ingress.prepareRequesterAccountContext,
      resolveTarget: ingress.resolveTarget, resolveEncryption: ingress.resolveEncryption, executor: ingress.executor });
    if (outcome.kind !== 'response') throw new Error(`Unexpected ingress result: ${JSON.stringify(outcome)}`);
    return outcome.response.execution;
  };
  const list = async (requester: boolean | string = true) => ActionOperationListV1ResponseSchema.parse(await machine.invokeLocalMachineAction(
    ACTION_OPERATION_RPC_METHODS_V2.list, {}, requester ? { rpcContext: typeof requester === 'string'
      ? { ...context, machineAdmission: { ...context.machineAdmission!, actorAccountId: requester } } : context } : undefined));
  return { directory, lifecycle, invoke, approvalCreated, list,
    readProviderActivationFacts: () => provider?.registry.targetActivationFacts ?? [],
    approvalOwnerAccountId: () => artifact?.ownerAccountId,
    revokeRequester: () => { requesterRevoked = true; },
    originalRootVerifications: () => originalRootVerifications,
    postDownloadReadRoots: () => [...postDownloadReadRoots],
    publishWithoutRequester: (runtimeAccountId = 'caller-authored-account') => machine.createFileDownloadPublisher(homeId, {
      serverId: homeId, runtimeAccountId, externalActionTarget: { kind: 'machine', machineId: 'machine' },
    })({ name: 'asset.bin', bytes: new Uint8Array([0, 255]), destination: { destinationId: 'caller-authored-destination' } }, {
      retirementSignal: new AbortController().signal, isOccurrenceCurrent: () => true,
    }),
    approve: async (actorAccountId = 'bob') => invoke('approval.request.decide', { artifactId: artifact?.id, decision: 'approve' }, 'approve-download', false, actorAccountId),
    read: async (operationId: string, waitForTerminal = true) => ActionOperationGetV1ResponseSchema.parse(await machine.invokeLocalMachineAction(
      ACTION_OPERATION_RPC_METHODS_V2.get, { operationId, ...(waitForTerminal ? { waitForTerminal: true } : {}) }, { rpcContext: context })),
    cancel: (operationId: string) => machine.invokeLocalMachineAction(
      ACTION_OPERATION_RPC_METHODS_V1.cancel, { operationId }, { rpcContext: context }),
    close: async () => { cancellation.abort(); try { await lifecycle.stop(); await installed.dispose(); await machine.shutdown(); await currentness.close(); await provider?.dispose(); }
      finally { env.restore(); await rm(directory, { recursive: true, force: true }); } },
  };
}
