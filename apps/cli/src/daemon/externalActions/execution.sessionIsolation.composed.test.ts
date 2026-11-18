import axios from 'axios';
import nacl from 'tweetnacl';
import { expect, it, onTestFinished, vi } from 'vitest';
import type { startDaemonControlServer } from '@/daemon/controlServer';
import { createInstalledProjectAgentDaemonFixture } from '@/daemon/testkit/installedProjectAgentDaemonFixture';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { configuration } from '@/configuration';
import { encodeStoredCredentials, updateSettings } from '@/persistence';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { bindExternalActionExecutionAuthorizationVerifyHttpPathV1, ExternalActionExecutionAuthorizationV1Schema, ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { sealExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { SessionSpawnNewInputV2Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { sealManagedMachinePresetContentV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import { MachinePublishedMetadataV1Schema } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import type { ApiMachineClient } from '@/api/apiMachine';
import { createMachineSessionDirectTargetTransport } from '@/rpc/handlers/sessionServerStartLifecycleAdapter';
import { createSpawnNewSessionLifecycleActionHandler } from '@/session/actions/lifecycle/createSpawnNewSessionLifecycleActionHandler';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { registerSessionCreationDirectoryPreflightRpc } from '@/session/creation/registerSessionCreationTargetPreparationRpc';
import * as machineRpc from '@/session/transport/rpc/machineRpc';
import { executeExternalAction } from './executeExternalAction';

const boundary = vi.hoisted(() => ({ control: null as Parameters<typeof startDaemonControlServer>[0] | null }));
// The listener and Home HTTP/socket are boundaries; installed factory,
// requester custody, Session policy and the managed adapter stay real.
vi.mock('@/daemon/controlServer', () => ({ startDaemonControlServer: async (input: Parameters<typeof startDaemonControlServer>[0]) => {
  boundary.control = input;
  return { port: 43129, stop: async () => {} };
} }));

// This daemon fixture stops at managed admission. The Home HTTP scenario
// exercises resource allocation and settlement with the signed member root.
it.each([
  { accountId: 'requester', role: 'manage', expectedCause: 'preset_not_found' },
  { accountId: 'member', role: 'use', expectedCause: 'admission_unavailable' },
] as const)('routes $role Session policy acquisition to the installed custodian before host launch', async ({ accountId, role, expectedCause }) => {
  onTestFinished(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); boundary.control = null; });
  const homeId = 'srv_installed_session_isolation';
  const serverUrl = 'https://session-home.test';
  const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'requester', tokenEpoch: 0,
    provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`, encryption: null };
  const requesterCredentials = accountId === 'requester' ? credentials : {
    ...credentials,
    token: `e30.${Buffer.from(JSON.stringify({ sub: accountId, tokenEpoch: 0,
      provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`,
  };
  const presetId = role === 'use' ? 'custodian-preset' : 'removed-preset';
  let machine: ApiMachineClient | undefined;
  let launches = 0;
  const transport = createMachineSessionDirectTargetTransport({ machineId: 'machine',
    readMachineMetadataSnapshot: () => {
      if (!machine) throw new Error('Missing installed Machine');
      return machine.getMachineMetadataSnapshot();
    },
    spawnLifecycleHandler: createSpawnNewSessionLifecycleActionHandler({ serverId: 'session-home', spawnSession: async () => {
      launches++;
      throw new Error('Host process launch must not precede preset admission');
    } }),
  });
  const h = await createInstalledProjectAgentDaemonFixture(() => boundary.control, undefined, true, undefined, undefined, {
    credentials, accountActionCredentials: credentials, requesterCredentials: credentials,
    externalActionAccountId: 'requester', ordinaryAccountSession: true, homeServerIdentityId: homeId,
    machineRpcMethods: [RPC_METHODS.CAPABILITIES_DETECT],
    agentIsolationEnabled: false, machineAccess: { custodianAccountId: 'requester', role: 'manage' },
    resolveSessionSpawnDirectTargetTransport: () => transport,
    resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: homeId, machineId: 'machine' }),
  });
  machine = h.machine;
  const serverId = configuration.activeServerId;
  await updateSettings(settings => ({ ...settings, servers: { ...settings.servers, [serverId]: {
    ...settings.servers?.[serverId], id: serverId, name: 'Session Home', serverUrl, webappUrl: serverUrl,
    createdAt: 1, updatedAt: 1, lastUsedAt: 1, homeConnectionDescriptorAuthority: 'exact',
    homeConnectionDescriptor: { v: 1, homeServerIdentityId: homeId, canonicalServerUrl: serverUrl, revision: 1,
      endpoints: [{ kind: 'https', url: serverUrl }] },
  } } }));
  Reflect.set(h.machine, 'socket', createApiSessionSocketStub({ connected: true, emitWithAck: (event, payload) => {
    if (event !== 'machine-update-metadata' || !payload || typeof payload !== 'object'
      || !('metadata' in payload) || !('expectedVersion' in payload) || typeof payload.expectedVersion !== 'number')
      throw new Error(`Unexpected Machine publication ${event}`);
    return { result: 'success', metadata: payload.metadata, version: payload.expectedVersion + 1 };
  } }));
  await h.machine.updateMachineMetadata(metadata => {
    if (!metadata) throw new Error('Missing installed Machine metadata');
    return MachinePublishedMetadataV1Schema.parse({ ...metadata, isolationPolicyV1: { agentNativeSandboxEnabled: false,
      configuredSandboxes: { local: { provisioner: { pluginId: 'acme.compute', localId: 'vm' }, presetId } },
      workKinds: { sessions: { kind: 'sandbox', configuredSandboxId: 'local', lifecycle: 'fresh' },
        botsChannels: { kind: 'directly' }, automationsWorkflows: { kind: 'directly' } } } });
  });
  const owner = h.daemon.externalActionIngressOwner;
  if (!owner) throw new Error('Missing installed external Action ingress');
  const manager: unknown = Reflect.get(h.machine, 'rpcHandlerManager');
  if (!(manager instanceof RpcHandlerManager)) throw new Error('Missing installed Machine RPC receiver');
  registerSessionCreationDirectoryPreflightRpc({ rpcHandlerManager: manager });
  // Route the Home socket back to the actual native receiver. Directory
  // preflight still runs its real filesystem owner before Session admission.
  const admission = { actorAccountId: accountId, custodianAccountId: 'requester',
    machineId: 'machine', installationId: h.f.installation.installationId, role, encryptionMode: 'plain' as const };
  const rpcMethods: string[] = [];
  const invokeNative = (request: Parameters<typeof machineRpc.callExactMachineRpc>[0]) => {
    rpcMethods.push(request.method);
    // The real receiver delegates installed capability discovery to the member
    // OS context. Model its completed response at the transport boundary.
    if (request.method === RPC_METHODS.CAPABILITIES_DETECT && role === 'use') {
      return Promise.resolve({ protocolVersion: 1, results: { 'cli.acme.project-launch/agent': {
        ok: false, checkedAt: 1, error: { code: 'unknown-capability', message: 'Capability is not registered' },
      } } });
    }
    return manager.invokeLocal(
    request.method, request.prepareRequest ? request.prepareRequest() : request.request, { signal: request.signal,
      verifiedPeerAuthority: 'present_user', rpcContext: { machineAdmission: admission,
        verifyMachineAdmissionCurrent: async () => h.f.isHomeCurrent() } });
  };
  vi.spyOn(machineRpc, 'callExactMachineRpc').mockImplementation(invokeNative);
  vi.spyOn(machineRpc, 'callMachineRpc').mockImplementation(invokeNative);
  const input = SessionSpawnNewInputV2Schema.parse({ creationKey: 'installed-isolation',
    executionTarget: { serverId, machineId: 'machine' }, directory: { kind: 'path', path: h.cwd },
    agentTarget: { kind: 'agent', identity: { pluginId: 'acme.project-launch', localId: 'agent' } }, memoryEnabled: false,
    configuration: { mode: { value: null, updatedAtMs: 1 }, model: { value: null, updatedAtMs: 1, selectionSource: 'inherited' },
      permissionIntent: { value: null, updatedAtMs: 1 }, options: {} } });
  const target = { kind: 'machine' as const, machineId: 'machine' };
  const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: 'installed-isolation', target, input });
  const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-admitted-session-root', binding: {
    serverIdentityId: homeId, accountId, custodianAccountId: 'requester', admittedMachineRole: role, authentication: { kind: 'account', tokenEpoch: 0 },
    accountEncryptionMode: 'plain', actionId: 'session.spawn_new', requestId: envelope.requestId,
    machineId: 'machine', installationId: h.f.installation.installationId, target,
    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
  } });
  const authorization = sealExternalActionRequesterAccountContextV1({ authorization: root, credentials: encodeStoredCredentials(requesterCredentials),
    purpose: { kind: 'external_action' }, installationPublicKey: Buffer.from(h.f.installation.publicKey, 'base64url'), randomBytes: nacl.randomBytes,
    invocation: { surface: 'ui', authority: 'present_user', caller: { kind: 'host' }, presentUserConfirmation: {
      actionId: 'session.spawn_new', requestId: envelope.requestId, accountId, serverId: homeId, target,
      inputDigest: computeActionInputApprovalDigestV1('session.spawn_new', input),
    } } });
  const post = vi.mocked(axios.post).getMockImplementation();
  if (!post) throw new Error('Missing Home boundary');
  const get = vi.mocked(axios.get).getMockImplementation();
  if (!get) throw new Error('Missing Home read boundary');
  vi.mocked(axios.get).mockImplementation(async (...args) => {
    if (new URL(String(args[0])).pathname === '/v1/account/profile'
      && args[1]?.headers?.Authorization === `Bearer ${requesterCredentials.token}`) return { status: 200, data: { id: accountId } };
    return get(...args);
  });
  const selectedPresets: unknown[] = [];
  const sessionLookupAccounts: string[] = [];
  vi.mocked(axios.post).mockImplementation(async (...args) => {
    const path = new URL(String(args[0])).pathname;
    if (path === bindExternalActionExecutionAuthorizationVerifyHttpPathV1('session.spawn_new')) return { status: 200, data: { ok: true } };
    if (path === '/v1/home/governance/get') return { status: 200, data: { homeDefaults: null } };
    if (path === '/v2/sessions/lookup-by-tags') {
      sessionLookupAccounts.push(args[2]?.headers?.Authorization === `Bearer ${requesterCredentials.token}` ? accountId : 'unexpected');
      return { status: 200, data: { sessions: [] } };
    }
    if (path === '/v1/machines/presets/get') {
      const asCustodian = args[2]?.headers?.Authorization === `Bearer ${credentials.token}`;
      selectedPresets.push({ input: args[1], asCustodian });
      if (!asCustodian || role === 'manage') {
        return { status: 404, data: { kind: 'refused', code: 'preset_not_found' } };
      }
      const launch = { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'Fixture sandbox', choices: {} };
      return { status: 200, data: { kind: 'found', preset: { id: presetId, homeId, revision: 1,
        owner: { kind: 'account', accountId: 'requester' }, controller: { machineId: 'machine', installationId: h.f.installation.installationId },
        contentEncryptionMode: 'plain', ...sealManagedMachinePresetContentV1({ presetId, mode: 'plain', content: { v: 1, name: launch.name, launch } }) } } };
    }
    return post(...args);
  });
  const result = await executeExternalAction({ ...owner, actionId: 'session.spawn_new', envelope, executionAuthorization: authorization,
    principal: { accountId, authority: 'present_user', authentication: { kind: 'account', tokenEpoch: 0 } },
    currentMachineId: 'machine', currentAccountId: 'requester', currentInstallationId: h.f.installation.installationId,
    verifyExecutionAuthorization: async () => true, machineAdmission: admission, signal: h.signal });
  expect(new Set(selectedPresets.map(preset => JSON.stringify(preset))), JSON.stringify({ result, rpcMethods }))
    .toEqual(new Set([JSON.stringify({ input: { homeId, id: presetId }, asCustodian: true })]));
  expect(sessionLookupAccounts).toContain(accountId);
  expect(h.nativeEffects()).toBe(0);
  expect(launches).toBe(0);
  expect(h.trackedSessionsByKey.size).toBe(1);
  if (result.kind !== 'response') throw new Error(JSON.stringify(result));
  const execution = result.response.execution;
  const outcome = execution.ok ? execution.result : execution.details ?? execution;
  expect(outcome).toMatchObject(execution.ok || execution.details
    ? { launchError: { code: expectedCause } } : { errorCode: expectedCause });
}, 120_000);
