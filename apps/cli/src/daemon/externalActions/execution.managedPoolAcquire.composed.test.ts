import axios from 'axios';
import nacl from 'tweetnacl';
import { expect, it, onTestFinished, vi } from 'vitest';
import type { startDaemonControlServer } from '@/daemon/controlServer';
import { createInstalledProjectAgentDaemonFixture } from '@/daemon/testkit/installedProjectAgentDaemonFixture';
import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createConnectedAccountRequestAuthSubjectRegistry } from '@/daemon/connectedServices/requestAuth/ConnectedAccountRequestAuthSubjectRegistry';
import { createManagedProviderOperationAuthority } from '@/daemon/connectedServices/purposeBindings/managedProviderOperationAuthority';
import { executeExternalAction } from './executeExternalAction';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { configuration } from '@/configuration';
import { updateSettings } from '@/persistence';
import { ManagedAcquireInputV1Schema, ManagedControllerReportV1Schema, ManagedControllerSubmitInputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { createManagedMachinePresetAcquireOverrideV1, openManagedMachinePresetContentV1, projectManagedMachinePresetForRecipientV1,
  sealManagedMachinePresetContentV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import { ManagedMachinePresetGetResultV1Schema } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { resetServerFeaturesClientForTests } from '@/features/serverFeaturesClient';
import { readBundledPluginAvailabilityHttpFixture } from '@/plugins/testkit/bundledPluginAvailabilityHttpFixture';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { fixture as nativeFixture, roleResult } from '@/plugins/runtime/invocation/actions/managedCustody.testkit';
import { ExternalActionExecutionAuthorizationV1Schema, ExternalActionRequestEnvelopeV1Schema,
  ExternalActionResponseEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { sealManagedControllerActionCodecV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { ACTION_OPERATION_RPC_METHODS_V2 } from '@happier-dev/protocol/actions/operations/v1';
import { AUTOMATION_ACTION_INDEX_HTTP_PATH_V1, ActionAutomationIndexV1Schema } from '@happier-dev/protocol/automations/automationActionTriggerV1';

const boundary = vi.hoisted(() => ({ control: null as Parameters<typeof startDaemonControlServer>[0] | null }));
// The private listener is an OS boundary; the installed ingress/factory and
// managed adapter/driver beneath it are production implementations.
vi.mock('@/daemon/controlServer', () => ({ startDaemonControlServer: async (input: Parameters<typeof startDaemonControlServer>[0]) => {
  boundary.control = input;
  return { port: 43129, stop: async () => {} };
} }));

it('gives the provider the same-host identity for a member acquisition on the Pool-selected controller', async () => {
  resetServerFeaturesClientForTests();
  onTestFinished(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); boundary.control = null; resetServerFeaturesClientForTests(); });
  const homeId = 'srv_managed_session_identity';
  const serverUrl = 'https://session-home.test';
  const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'controller-owner', tokenEpoch: 0,
    provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } })).toString('base64url')}.signature`, encryption: null };
  const unavailable = async (): Promise<never> => { throw new Error('The local provisioner does not need connected Account material'); };
  const providerAuthority = createManagedProviderOperationAuthority({ materializationBaseDir: '/unused-managed-session-identity',
    purposeBindingOwner: createConnectedAccountPurposeBindingOwner({
      store: { read: async () => ({ v: 1, bindings: [] }), update: unavailable, subscribe: () => ({ dispose() {} }) },
      selectTarget: unavailable, resolveTarget: unavailable, materializeAccount: unavailable,
      projectTargetAccounts: unavailable, assertTargetAccountMaterializable: unavailable,
    }), requestAuthRegistry: createConnectedAccountRequestAuthSubjectRegistry(), resolveRequestAuthHttpPort: () => 43123,
    createRedactionLease: () => ({ add() {}, close() {} }) });
  const pluginId = 'acme.project-launch';
  const native = nativeFixture({ credentialPurposes: [] });
  const nativeManifest = native.manifest;
  native.retire();
  const provisioner = nativeManifest.contributes.machineProvisioners[0]!;
  const authoredPlugin = {
    manifest: createPluginManifestV2Fixture({ id: pluginId, contributes: {
      agents: [{ id: 'agent', title: 'Fixture Agent', runtime: { kind: 'custom' }, primary: 'sessions',
        capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } } }],
      machineProvisioners: [{ ...provisioner, billing: { location: 'local', stoppedBilling: 'not-billed' } }],
      actions: nativeManifest.contributes.actions,
    } }), files: {
      'agent.mjs': 'export function factory() { throw new Error("No Agent start in the acquisition fixture"); }',
      'daemon.mjs': `import { factory } from './agent.mjs';
        export function activate(api) {
          api.agents.register('agent', factory, { sessionRunnerFactory: { module: './agent.mjs', export: 'factory', runtimeApiVersion: 1 } });
          ${nativeManifest.contributes.actions.map(({ id }) => `api.actions.register(${JSON.stringify(id)}, async input => ${id === 'acquire'
            ? `({ kind: 'rejected', code: input.guestHome?.hostIdentity?.homeMachineHost === 'Controller' &&
                input.guestHome?.hostIdentity?.controllerMachineHost === 'controller.local' ? 'provider_unavailable' : 'invalid_request' })`
            : `(${JSON.stringify(roleResult(id))})`});`).join('\n')}
        }`,
    },
  };
  const h = await createInstalledProjectAgentDaemonFixture(() => boundary.control, undefined, true, authoredPlugin, undefined, {
    credentials, accountActionCredentials: credentials, requesterCredentials: credentials,
    externalActionAccountId: 'controller-owner', ordinaryAccountSession: true, homeServerIdentityId: homeId,
    machineAccess: { custodianAccountId: 'controller-owner', role: 'manage' }, managedProviderOperationAuthority: providerAuthority,
    accountSettings: { actionsSettingsV1: { v: 1, actions: {
      'machines.managed.acquire': { approvalRequiredSurfaces: ['agent'] },
    } } },
    resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: homeId, machineId: 'machine' }),
    currentMachineHost: 'controller.local', resolveServerFeaturesSnapshot: () => ({ status: 'ready',
      provenance: 'authenticated', features: FeaturesResponseSchema.parse({ features: {},
        capabilities: { serverIdentity: { serverIdentityId: homeId } },
        homeHostFact: { kind: 'known', machineName: 'Controller', platform: 'linux', mobility: 'stationary' } }) }),
  });
  const fixtureFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(input) === `${serverUrl}/v1/features`) return Promise.resolve(Response.json({ capabilities: {
      guestCli: { source: 'public-release', line: '0.3', channel: 'stable' },
    } }));
    return fixtureFetch(input, init);
  });
  const serverId = configuration.activeServerId;
  await updateSettings(settings => ({ ...settings, servers: { ...settings.servers, [serverId]: {
    ...settings.servers?.[serverId], id: serverId, name: 'Managed Session Home', serverUrl, webappUrl: serverUrl,
    createdAt: 1, updatedAt: 1, lastUsedAt: 1, homeConnectionDescriptorAuthority: 'exact',
    homeConnectionDescriptor: { v: 1, homeServerIdentityId: homeId, canonicalServerUrl: serverUrl, revision: 1,
      endpoints: [{ kind: 'https', url: serverUrl }] },
  } } }));
  const owner = h.daemon.externalActionIngressOwner;
  if (!owner) throw new Error('Missing installed external Action ingress');
  const target = { kind: 'machine' as const, machineId: 'machine' };
  const controller = { machineId: target.machineId, installationId: h.f.installation.installationId };
  const preset = { id: 'delegated-preset', revision: 1 };
  const launch = { provider: { pluginId, localId: provisioner.id }, schemaVersion: 1, name: 'Pool guest', choices: {} };
  const presetContent = sealManagedMachinePresetContentV1({ presetId: preset.id, mode: 'plain', content: { v: 1, name: 'Pool preset', launch } });
  const presetContentOverride = createManagedMachinePresetAcquireOverrideV1({ presetId: preset.id, mode: 'plain',
    projection: projectManagedMachinePresetForRecipientV1({ ...presetContent, recipientAccountId: 'team-member' }),
    enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' } });
  if (!presetContentOverride) throw new Error('Missing private enrollment choice');
  // The Home Pool selector has already bound this controller before signing the Action.
  const input = ManagedAcquireInputV1Schema.parse({ selection: { kind: 'preset', homeId, ...preset }, controller, presetContentOverride });
  const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: 'member-session-acquire', target, input });
  const sessionActionOrigin = { v: 1 as const,
    caller: { kind: 'session' as const, sessionId: 'member-session', starterDepth: 0, turnDepth: 0 },
    sourceTurnId: 'member-turn', requestId: envelope.requestId!, callerPermissionMode: 'default' as const };
  const principal = { accountId: 'team-member', authority: 'account_automation' as const,
    authentication: { kind: 'account' as const, tokenEpoch: 0 }, sessionActionOrigin };
  const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-admitted-member-session-acquire', binding: {
    serverIdentityId: homeId, accountId: principal.accountId, authentication: principal.authentication,
    sessionActionOrigin, custodianAccountId: 'controller-owner',
    sessionActionSource: { machineId: 'source-machine', installationId: 'source-installation' },
    accountEncryptionMode: 'plain', actionId: 'machines.managed.acquire', requestId: envelope.requestId,
    machineId: 'machine', installationId: h.f.installation.installationId, target, admittedMachineRole: 'use', managedAcquireDelegation: true,
    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
  } });
  const authorization = sealManagedControllerActionCodecV1({ authorization: root,
    material: { type: 'dataKey', machineKey: new Uint8Array(32).fill(41) },
    installationPublicKey: Buffer.from(h.f.installation.publicKey, 'base64url'), randomBytes: nacl.randomBytes });
  const writeHome = vi.mocked(axios.post).getMockImplementation();
  if (!writeHome) throw new Error('Missing canonical Home HTTP boundary');
  const homePaths: string[] = [];
  const readHome = vi.mocked(axios.get).getMockImplementation();
  if (!readHome) throw new Error('Missing canonical Home read boundary');
  vi.mocked(axios.get).mockImplementation(async (...args) => {
    const path = new URL(String(args[0])).pathname;
    homePaths.push(`GET ${path}`);
    if (path === AUTOMATION_ACTION_INDEX_HTTP_PATH_V1)
      return { status: 200, data: ActionAutomationIndexV1Schema.parse({ v: 1, rows: [] }) };
    if (path === '/v1/account/profile') return { status: 200, data: { id: 'controller-owner' } };
    // A controller credential cannot read the member's source Session policy.
    if (path === '/v2/sessions/member-session') return { status: 403, data: { error: 'forbidden' } };
    return readHome(...args);
  });
  let retainedContent = presetContent.content;
  let managed = ManagedMachineV1Schema.parse({ id: 'pool-guest', homeId, custodianAccountId: 'controller-owner',
    preset: { ...preset, contentEncryptionMode: 'plain' },
    controller, allocation: 'unsubmitted', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 0,
    retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
  const nativeReports: unknown[] = [];
  vi.mocked(axios.post).mockImplementation(async (...args) => {
    const path = new URL(String(args[0])).pathname;
    homePaths.push(`POST ${path}`);
    const availability = readBundledPluginAvailabilityHttpFixture(path, args[1]);
    if (availability !== undefined) return { status: 200, data: availability };
    if (path.endsWith('/verify')) return { status: 200, data: { ok: true } };
    if (path === '/v1/machines/presets/get') return { status: 200,
      data: ManagedMachinePresetGetResultV1Schema.parse({ kind: 'found', preset: { ...preset, homeId,
        owner: { kind: 'team', teamId: 'team' }, controllerPoolId: '11111111-1111-4111-8111-111111111111',
        teamAcquireDelegated: true, contentEncryptionMode: 'plain', ...presetContent,
        retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } }) };
    if (path.endsWith('/controller/admit')) return { status: 200, data: { machine: managed, presetContent,
      presetContentOverride, replayed: false } };
    if (path.endsWith('/controller/current')) return { status: 200, data: { machine: managed } };
    if (path.endsWith('/controller/context')) return { status: 200, data: { machine: managed, requestId: envelope.requestId,
      presetContent: { ...presetContent, content: retainedContent } } };
    if (path.endsWith('/controller/submit')) {
      const submitted = ManagedControllerSubmitInputV1Schema.parse(args[1]);
      if (submitted.presetContent) retainedContent = submitted.presetContent;
      managed = ManagedMachineV1Schema.parse({ ...managed, allocation: 'may-exist' });
      return { status: 200, data: { machine: managed, submitted: true } };
    }
    if (path.endsWith('/controller/report')) {
      const report = ManagedControllerReportV1Schema.parse(args[1]);
      if ('presetContent' in report) nativeReports.push(openManagedMachinePresetContentV1({
        presetId: preset.id, mode: 'plain', content: report.presetContent,
      })?.nativeResult);
      return { status: 200, data: { machine: managed } };
    }
    return writeHome(...args);
  });
  const result = await executeExternalAction({ ...owner,
    actionId: 'machines.managed.acquire', envelope, executionAuthorization: authorization, principal,
    currentMachineId: 'machine', currentAccountId: 'controller-owner', currentInstallationId: h.f.installation.installationId,
    verifyExecutionAuthorization: async () => true, signal: h.signal });
  expect(result, JSON.stringify({ result, homePaths })).toMatchObject({ kind: 'response', response: { execution: {
    ok: true, result: { status: 'accepted' },
  } } });
  if (result.kind !== 'response') throw new Error('The installed ingress did not accept delegated compute');
  const response = ExternalActionResponseEnvelopeV1Schema.parse(result.response);
  if (!response.execution.ok) throw new Error('The installed executor refused delegated compute');
  const accepted = response.execution.result;
  if (!accepted || typeof accepted !== 'object' || Array.isArray(accepted)
    || !('operationId' in accepted)) throw new Error('Missing installed operation acceptance');
  const manager: unknown = Reflect.get(h.machine, 'rpcHandlerManager');
  if (!(manager instanceof RpcHandlerManager)) throw new Error('Missing installed operation observer');
  // Observe through the real read handler in the same member scope Home admitted.
  // Foreign requester operations are not published to the custodian's socket.
  const terminal = await manager.invokeLocal(ACTION_OPERATION_RPC_METHODS_V2.get,
    { operationId: accepted.operationId, waitForTerminal: true }, { signal: h.signal,
      rpcContext: { machineAdmission: { actorAccountId: root.binding.accountId, custodianAccountId: root.binding.custodianAccountId,
        machineId: root.binding.machineId, installationId: root.binding.installationId, role: 'use', encryptionMode: 'plain' },
        verifyMachineAdmissionCurrent: async () => h.f.isHomeCurrent() },
    });
  expect(nativeReports, JSON.stringify({ homePaths, terminal })).toContainEqual({ kind: 'rejected', code: 'provider_unavailable' });
}, 120_000);
