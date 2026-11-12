import axios from 'axios';
import nacl from 'tweetnacl';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, onTestFailed, onTestFinished, vi } from 'vitest';
import type { startDaemonControlServer } from '@/daemon/controlServer';
import { createInstalledProjectAgentDaemonFixture } from '@/daemon/testkit/installedProjectAgentDaemonFixture';
import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createConnectedAccountRequestAuthSubjectRegistry } from '@/daemon/connectedServices/requestAuth/ConnectedAccountRequestAuthSubjectRegistry';
import { createManagedProviderOperationAuthority } from '@/daemon/connectedServices/purposeBindings/managedProviderOperationAuthority';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import { prepareRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { createDaemonExternalActionTargetResolver } from './daemonExternalActionTargetResolver';
import { executeExternalAction } from './executeExternalAction';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { ApiMachineClient } from '@/api/apiMachine';
import * as installationStore from '@/daemon/identity/store';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createMachineSetupAction, createMachineSetupPlanAction } from '@/machines/setup/machineSetupAction';
import { configuration } from '@/configuration';
import { verifyExternalActionExecutionAuthorizationCurrent } from '@/api/externalActionExecutionAuthorization';
import { encodeStoredCredentials, updateSettings } from '@/persistence';
import { ManagedAcquireInputV1Schema, MachineSetupApplyResultV1Schema, MachineSetupReportInputV1Schema,
  MachineSetupResolveResultV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import type { MachineSetupSourceV1 } from '@happier-dev/protocol/machines/setup/machineSetupSourcesV1';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { buildManagedConfigurationFactsV1 } from '@happier-dev/protocol/machines/managed/managedConfigurationV1';
import { PluginJsonValueV2Schema } from '@happier-dev/protocol/plugins/contributions/jsonSchema';
import { ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationV1Schema,
  ExternalActionRequestEnvelopeV1Schema, ExternalActionResponseEnvelopeV1Schema,
  projectExternalActionDeploymentPreparationEnvelopeAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { sealExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { ACTION_OPERATION_RPC_METHODS_V2, ACTION_OPERATION_REVISION_EPHEMERAL_EVENT_V1,
  ActionOperationRevisionEphemeralV1Schema, type ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';

const boundary = vi.hoisted(() => ({ control: null as Parameters<typeof startDaemonControlServer>[0] | null }));
// The private listener is an OS boundary; the installed ingress/factory and
// managed adapter/driver beneath it are production implementations.
vi.mock('@/daemon/controlServer', () => ({ startDaemonControlServer: async (input: Parameters<typeof startDaemonControlServer>[0]) => {
  boundary.control = input;
  return { port: 43129, stop: async () => {} };
} }));

it.each([false, true])('continues normal UI Create confirmation without a review digest through the installed daemon and real guest Setup/Session receivers (setup=%s)', async withSetup => {
  onTestFinished(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); boundary.control = null; });
  const homeId = 'srv_managed_confirmed';
  const serverUrl = 'https://session-home.test';
  const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'requester', tokenEpoch: 0,
    provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`, encryption: null };
  const installedCredentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'requester', tokenEpoch: 0,
    provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } })).toString('base64url')}.signature`, encryption: null };
  const unavailable = async (): Promise<never> => { throw new Error('No provider credential is needed to rejoin this enrolled guest'); };
  const providerAuthority = createManagedProviderOperationAuthority({ materializationBaseDir: '/unused-managed-credential-boundary',
    purposeBindingOwner: createConnectedAccountPurposeBindingOwner({
      store: { read: async () => ({ v: 1, bindings: [] }), update: unavailable, subscribe: () => ({ dispose() {} }) },
      selectTarget: unavailable, resolveTarget: unavailable, materializeAccount: unavailable,
      projectTargetAccounts: unavailable, assertTargetAccountMaterializable: unavailable,
    }), requestAuthRegistry: createConnectedAccountRequestAuthSubjectRegistry(), resolveRequestAuthHttpPort: () => 43123,
    createRedactionLease: () => ({ add() {}, close() {} }) });
  const h = await createInstalledProjectAgentDaemonFixture(() => boundary.control, undefined, true, undefined, undefined, {
    credentials: installedCredentials, accountActionCredentials: installedCredentials, requesterCredentials: installedCredentials,
    externalActionAccountId: 'requester', ordinaryAccountSession: true, homeServerIdentityId: homeId,
    machineAccess: { custodianAccountId: 'requester', role: 'manage' }, managedProviderOperationAuthority: providerAuthority,
    resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: homeId, machineId: 'machine' }),
  });
  const serverId = configuration.activeServerId;
  const lifetime = new AbortController();
  const signal = AbortSignal.any([h.signal, lifetime.signal]);
  onTestFailed(() => lifetime.abort());
  onTestFinished(() => lifetime.abort());
  await updateSettings(settings => ({ ...settings, servers: { ...settings.servers, [serverId]: {
    ...settings.servers?.[serverId], id: serverId, name: 'Managed Home', serverUrl, webappUrl: serverUrl,
    createdAt: 1, updatedAt: 1, lastUsedAt: 1, homeConnectionDescriptorAuthority: 'exact',
    homeConnectionDescriptor: { v: 1, homeServerIdentityId: homeId, canonicalServerUrl: serverUrl, revision: 1,
      endpoints: [{ kind: 'https', url: serverUrl }] },
  } } }));
  const owner = h.daemon.externalActionIngressOwner;
  if (!owner) throw new Error('The installed daemon must expose its actual native ingress');
  const guestKeys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(73));
  const guestInstallation = { version: 1 as const, installationId: 'guest-installation', createdAt: 1,
    publicKey: Buffer.from(guestKeys.publicKey).toString('base64url'), privateKey: Buffer.from(guestKeys.secretKey).toString('base64url') };
  const installation = new AsyncLocalStorage<typeof guestInstallation>();
  const readInstalledIdentity = installationStore.readInstallationIdentityIfExistsSync;
  // Installation files are the OS boundary for two physical daemon fixtures.
  vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockImplementation(() => installation.getStore() ?? readInstalledIdentity());
  const marker = join(h.f.directory, 'setup-effect-marker');
  const setup = { scripts: [{ body: `printf 'setup\\n' >> ${JSON.stringify(marker)}`, affects: 'none' as const }] };
  const sources: MachineSetupSourceV1 = [{ kind: 'accountPreset', presetId: 'preset', presetRevision: 1, setup }, { kind: 'direct', setup: {} }];
  let parentPublished!: (snapshot: ActionOperationSnapshotV1) => void;
  const parentPublication = new Promise<ActionOperationSnapshotV1>(resolve => { parentPublished = resolve; });
  let setupPublished!: (snapshot: ActionOperationSnapshotV1) => void;
  const setupPublication = new Promise<ActionOperationSnapshotV1>(resolve => { setupPublished = resolve; });
  const observePublication = (machineId: string, event: string, [payload]: unknown[]) => {
    if (event !== ACTION_OPERATION_REVISION_EPHEMERAL_EVENT_V1) return;
    const publication = ActionOperationRevisionEphemeralV1Schema.parse(payload);
    expect(publication.machineId).toBe(machineId);
    if (publication.content.t !== 'plain' || publication.content.v.state !== 'succeeded') return;
    const snapshot = publication.content.v;
    if (machineId === 'machine' && snapshot.actionId === 'machines.managed.acquire') parentPublished(snapshot);
    if (machineId === 'guest' && snapshot.actionId === 'machines.setup.apply') setupPublished(snapshot);
  };
  // These are the actual Machine producers' network boundaries. Waiting for
  // their terminal push retains fixture credentials until publication settles.
  Reflect.set(h.machine, 'socket', createApiSessionSocketStub({ connected: true,
    emit: (event, args) => observePublication('machine', event, args) }));
  const guestMachine = installation.run(guestInstallation, () => {
    const machine = new ApiMachineClient(installedCredentials.token, { id: 'guest', encryptionMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
      metadataVersion: 0, daemonStateVersion: 0, daemonState: null, metadata: { host: 'guest', platform: 'linux', homeDir: h.f.directory,
        happyHomeDir: h.f.directory, happyCliVersion: 'test', setup: { version: 1, revision: 3, sources, exclusions: [] } } }, undefined,
      { resolveCurrentServerIdentityId: () => homeId });
    Reflect.set(machine, 'socket', createApiSessionSocketStub({ connected: true,
      emit: (event, args) => observePublication('guest', event, args) }));
    machine.setRPCHandlers({ spawnSession: unavailable, stopSession: async () => true, requestShutdown() {} });
    return machine;
  });
  onTestFinished(() => guestMachine.shutdown());
  const guestRpc: unknown = Reflect.get(guestMachine, 'rpcHandlerManager');
  if (!(guestRpc instanceof RpcHandlerManager)) throw new Error('Missing actual guest native handlers');
  let nativeStarts = 0;
  const artifacts: string[] = [];
  const dispatched: string[] = [];
  const setupReports: string[] = [];
  let setupOperationId: string | undefined;
  const nativeTerminalOutcomes: unknown[] = [];
  const childResults: unknown[] = [];
  const homeRequests: string[] = [];
  let rejectChildFailure!: (error: Error) => void;
  const childFailure = new Promise<never>((_resolve, reject) => { rejectChildFailure = reject; });
  void childFailure.catch(() => {});
  onTestFailed(() => console.error('Managed acquire boundary outcomes', JSON.stringify({ dispatched, childResults, homeRequests, setupReports, nativeStarts, artifacts })));
  onTestFailed(() => console.error('Managed acquire native terminal outcomes', JSON.stringify(nativeTerminalOutcomes)));
  const guest = createCliActionExecutorHarness({ token: credentials.token, credentials, sessionId: '',
    mode: 'plain', ctx: null, serverId, serverIdentityId: homeId, serverHttpBaseUrl: serverUrl,
    machineActionDirectTargetTransport: { machineId: 'guest', invoke: (method, request, options) => guestRpc.invokeLocal(method, request, options),
      machineSetupApply: async request => {
        const target = request.input.targets[0];
        expect(request.input.targets).toHaveLength(1);
        if (!target) throw new Error('The actual managed continuation must have one guest Setup target');
        // Match the installed daemon's native-leaf port. Generic Machine RPC
        // is a separate authenticated ingress, not this already admitted leaf.
        const result = await createMachineSetupAction({ apiMachine: guestMachine, machineId: 'guest', homeId, installation: guestInstallation })({ ...request, input: target });
        const terminals = guestMachine.getFiniteTerminalSessions();
        nativeTerminalOutcomes.push(...(terminals?.list().map(terminal => ({ ...terminal,
          output: terminals.read({ terminalId: terminal.terminalId, cursor: 0, maxBytes: 4096, maxEvents: 20 }),
        })) ?? []));
        return result;
      },
    },
  }, {
    runActionOperation: request => guestMachine.runActionOperation(request),
    machineSetupPlan: createMachineSetupPlanAction({ apiMachine: guestMachine, machineId: 'guest', homeId, installation: guestInstallation }),
    approvalsCreate: async ({ request }) => { artifacts.push(request.actionId); return { artifactId: 'unexpected-child-ask' }; },
    // This is the guest's native Agent-process boundary, not a child Action.
    sessionSpawnNew: async request => {
      nativeStarts++;
      expect(request.executionTarget.machineId).toBe('guest');
      return { type: 'success', disposition: 'created', sessionId: 'new-session', executionTarget: request.executionTarget,
        organizationPlacement: { folderId: null, tagIds: [] }, initialInput: { status: 'notRequested' } };
    },
  }).executor;
  const launch = { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'enrolled', choices: {} };
  const acquisition = ManagedAcquireInputV1Schema.parse({ enrollmentIdentity: { kind: 'existingUser', role: 'adopted' },
    ...(withSetup ? { selection: { kind: 'preset', homeId, id: 'preset', revision: 1 },
      controller: { machineId: 'machine', installationId: h.f.installation.installationId }, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
      // The original confirmation must review the same saved Setup the guest will apply.
      reviewedFacts: buildManagedConfigurationFactsV1({ choicesSchema: PluginJsonValueV2Schema, launch,
        controller: { machineId: 'machine', installationId: h.f.installation.installationId },
        optionStatus: 'current', billing: { location: 'unknown', stoppedBilling: 'unknown' }, prerequisites: [],
        retentionCapabilities: { supportedIntents: ['start', 'delete'] }, setup,
        preset: { id: 'preset', revision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } }) }
      : { selection: { kind: 'one-off', homeId, controller: { machineId: 'machine', installationId: h.f.installation.installationId },
      launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'enrolled', choices: {} },
      retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } }),
    agentStart: { directory: { kind: 'managed' }, agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } },
  });
  let enrolled = ManagedMachineV1Schema.parse({ id: 'managed', homeId, custodianAccountId: 'requester', launch,
    ...(withSetup ? { preset: { id: 'preset', revision: 1 }, machineSetup: { state: 'pending', setup } } : {}),
    controller: { machineId: 'machine', installationId: h.f.installation.installationId },
    allocation: 'bound', resource: { contributionRef: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, value: { id: 'existing' } },
    creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 0, enrolledMachineId: 'guest',
    retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
  const target = { kind: 'machine' as const, machineId: 'machine' };
  const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: 'confirmed-acquire', target, input: acquisition });
  const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'native-acquire-root', binding: {
    serverIdentityId: homeId, accountId: 'requester', custodianAccountId: 'requester', authentication: { kind: 'account', tokenEpoch: 0 },
    accountEncryptionMode: 'plain', actionId: 'machines.managed.acquire', requestId: envelope.requestId,
    machineId: 'machine', installationId: h.f.installation.installationId, target,
    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
  } });
  const authorization = sealExternalActionRequesterAccountContextV1({ authorization: root, credentials: encodeStoredCredentials(credentials),
    purpose: { kind: 'external_action' }, installationPublicKey: Buffer.from(h.f.installation.publicKey, 'base64url'), randomBytes: nacl.randomBytes,
    invocation: { surface: 'ui', authority: 'present_user', caller: { kind: 'host' }, presentUserConfirmation: {
      actionId: 'machines.managed.acquire', requestId: envelope.requestId, accountId: 'requester', serverId: homeId, target,
      inputDigest: computeActionInputApprovalDigestV1('machines.managed.acquire', acquisition),
    } } });
  const readHome = vi.mocked(axios.get).getMockImplementation();
  const writeHome = vi.mocked(axios.post).getMockImplementation();
  if (!readHome || !writeHome) throw new Error('Missing installed Home HTTP boundary');
  vi.mocked(axios.get).mockImplementation(async (...args) => {
    const path = new URL(String(args[0])).pathname;
    homeRequests.push(`GET ${path}`);
    if (path === '/v1/machines/guest') return { status: 200, data: { machine: {
      id: 'guest', installationId: guestInstallation.installationId, dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
      access: { custodian: { accountId: 'requester', displayName: 'Requester' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' },
      metadataVersion: 0, daemonStateVersion: 0, daemonState: null,
      metadata: encodePlainMachineStoredContent({ host: 'guest', platform: 'linux', homeDir: h.f.directory,
        happyHomeDir: h.f.directory, happyCliVersion: 'test', setup: { version: 1, revision: 3, sources, exclusions: [] } }),
    } } };
    return readHome(...args);
  });
  vi.mocked(axios.post).mockImplementation(async (...args) => {
    const path = new URL(String(args[0])).pathname;
    homeRequests.push(`POST ${path}`);
    if (path.endsWith('/verify')) return { status: 200, data: { ok: true } };
    if (path === '/v1/machines/managed/controller/admit') return { status: 200, data: { machine: enrolled, replayed: true } };
    if (path === '/v1/machines/managed/controller/current') return { status: 200, data: { machine: enrolled } };
    if (path === '/v1/machines/managed/controller/context') return { status: 200, data: { requestId: envelope.requestId,
      enrollmentInstallation: { machineId: 'guest', installationId: 'guest-installation',
        installationPublicKey: Buffer.from(guestKeys.publicKey).toString('base64url') } } };
    if (path === '/v1/machines/setup/resolve') return { status: 200, data: MachineSetupResolveResultV1Schema.parse({ sources,
      creation: { managedId: enrolled.id, preset: enrolled.preset } }) };
    if (path === '/v1/machines/setup/report') {
      const report = MachineSetupReportInputV1Schema.parse(args[1]);
      setupReports.push(report.state);
      enrolled = ManagedMachineV1Schema.parse({ ...enrolled, machineSetup: { setup, state: report.state, operation: report.operation,
        ...(report.errorCode ? { errorCode: report.errorCode } : {}) } });
      return { status: 200, data: { ok: true } };
    }
    if (path === '/v1/actions/session.spawn_new' || path === '/v1/actions/machines.setup.plan' || path === '/v1/actions/machines.setup.apply') {
      const childAction = path === '/v1/actions/session.spawn_new' ? 'session.spawn_new'
        : path === '/v1/actions/machines.setup.plan' ? 'machines.setup.plan' : 'machines.setup.apply';
      dispatched.push(childAction);
      const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(args[1]);
      if (!request.managedContinuation) throw new Error('The actual factory must retain its creation continuation');
      const child = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'guest-child', binding: { ...root.binding,
        actionId: childAction, target: request.envelope.target, machineId: 'guest', installationId: 'guest-installation',
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
        deploymentPreparationAdmission: projectExternalActionDeploymentPreparationEnvelopeAdmissionV1({
          actionId: childAction, envelope: request.envelope }),
        managedContinuation: { ...request.managedContinuation, controller: enrolled.controller,
          acquireRequestEnvelopeDigest: root.binding.requestEnvelopeDigest } } });
      const result = await installation.run(guestInstallation, () => executeExternalAction({ actionId: childAction, envelope: request.envelope, executionAuthorization: child,
        principal: { accountId: 'requester', authority: 'present_user', authentication: { kind: 'account', tokenEpoch: 0 } },
        currentMachineId: 'guest', currentAccountId: 'requester', currentServerId: serverId, currentServerHttpBaseUrl: serverUrl,
        currentInstallationId: 'guest-installation', externalActionMachineRequestPrivateKey: guestKeys.secretKey,
        verifyExecutionAuthorization: async () => true, resolveTarget: createDaemonExternalActionTargetResolver({ credentials }), executor: guest,
        prepareRequesterAccountContext: request => prepareRequesterAccountActionContext({ authorization: request.authorization,
          purpose: { kind: 'external_action' }, machineId: 'guest', installationId: 'guest-installation', installationPrivateKey: guestKeys.secretKey,
          serverId, serverIdentityId: homeId, serverHttpBaseUrl: serverUrl, ownCredentials: credentials,
          isCurrent: async () => true, createExecutor: () => guest }), signal,
        machineAdmission: { actorAccountId: 'requester', custodianAccountId: 'requester', machineId: 'guest',
          installationId: guestInstallation.installationId, role: 'manage', encryptionMode: 'plain' },
      }));
      childResults.push(result.kind === 'response' ? result.response : result);
      if (result.kind !== 'response' || !result.response.execution.ok) {
        rejectChildFailure(new Error(`Actual guest child failed: ${JSON.stringify(result.kind === 'response' ? result.response : result)}`));
      }
      expect(result, JSON.stringify(result)).toMatchObject({ kind: 'response', response: { execution: { ok: true,
        ...(childAction === 'session.spawn_new' ? { result: { type: 'success' } } : {}) } } });
      if (result.kind !== 'response') throw new Error('The real guest receiver refused the continuation');
      if (childAction === 'machines.setup.apply') {
        const response = ExternalActionResponseEnvelopeV1Schema.parse(result.response);
        if (!response.execution.ok) throw new Error('Setup did not accept the actual guest operation');
        const operation = MachineSetupApplyResultV1Schema.parse(response.execution.result);
        setupOperationId = operation.operationId;
        const manager: unknown = Reflect.get(guestMachine, 'rpcHandlerManager');
        if (!(manager instanceof RpcHandlerManager)) throw new Error('Missing guest Setup operation owner');
        // The HTTP boundary may deliver acceptance after native settlement;
        // wait on the actual operation, never substitute its child result.
        const settled = await installation.run(guestInstallation, () => manager.invokeLocal(ACTION_OPERATION_RPC_METHODS_V2.get,
          { operationId: operation.operationId, waitForTerminal: true }, { signal, callerAuthority: 'present_user',
            machineAdmission: { actorAccountId: 'requester', custodianAccountId: 'requester', machineId: 'guest',
              installationId: guestInstallation.installationId, role: 'manage', encryptionMode: 'plain' },
            verifyMachineAdmissionCurrent: async () => true }));
        childResults.push({ setupOperation: settled });
        expect(settled, JSON.stringify(settled)).toMatchObject({ kind: 'found', operation: { state: 'succeeded' } });
      }
      return { status: 200, data: result.response };
    }
    return writeHome(...args);
  });
  const result = await executeExternalAction({ ...owner, actionId: 'machines.managed.acquire', envelope, executionAuthorization: authorization,
    principal: { accountId: 'requester', authority: 'present_user', authentication: { kind: 'account', tokenEpoch: 0 } },
    currentMachineId: 'machine', currentAccountId: 'requester', currentInstallationId: h.f.installation.installationId,
    verifyExecutionAuthorization: request => verifyExternalActionExecutionAuthorizationCurrent({ ...request,
      privateKey: h.f.installation.privateKey, installationId: h.f.installation.installationId, serverHttpBaseUrl: serverUrl }),
    signal });
  expect(result, JSON.stringify(result)).toMatchObject({ kind: 'response', response: { execution: { ok: true, result: { managedId: 'managed' } } } });
  if (result.kind !== 'response') throw new Error('The actual source factory did not accept acquisition');
  const response = ExternalActionResponseEnvelopeV1Schema.parse(result.response);
  if (!response.execution.ok) throw new Error('The actual source factory refused acquisition');
  const accepted = response.execution.result;
  if (!accepted || typeof accepted !== 'object' || Array.isArray(accepted) || !('operation' in accepted)
    || !accepted.operation || typeof accepted.operation !== 'object' || Array.isArray(accepted.operation)
    || !('operationId' in accepted.operation)) throw new Error('Missing actual operation acceptance');
  const manager: unknown = Reflect.get(h.machine, 'rpcHandlerManager');
  if (!(manager instanceof RpcHandlerManager)) throw new Error('Missing installed operation observer');
  const settled = await Promise.race([childFailure, manager.invokeLocal(ACTION_OPERATION_RPC_METHODS_V2.get, { operationId: accepted.operation.operationId, waitForTerminal: true }, {
    signal, callerAuthority: 'present_user', machineAdmission: { actorAccountId: 'requester', custodianAccountId: 'requester',
      machineId: 'machine', installationId: h.f.installation.installationId, role: 'manage', encryptionMode: 'plain' },
    verifyMachineAdmissionCurrent: async () => h.f.isHomeCurrent(),
  })]);
  expect(settled, JSON.stringify({ settled, dispatched, childResults, setupReports, nativeStarts })).toMatchObject({ kind: 'found', operation: { state: 'succeeded' } });
  expect(nativeStarts).toBe(1);
  expect(artifacts).toEqual([]);
  expect(dispatched).toEqual(withSetup ? ['machines.setup.plan', 'machines.setup.plan', 'machines.setup.apply', 'session.spawn_new'] : ['session.spawn_new']);
  const publishedParent = await Promise.race([parentPublication, childFailure]);
  expect(publishedParent).toMatchObject({ operationId: accepted.operation.operationId, state: 'succeeded' });
  if (settled && typeof settled === 'object' && 'operation' in settled && settled.operation && typeof settled.operation === 'object') {
    expect(publishedParent.revision).toBe(Reflect.get(settled.operation, 'revision'));
  }
  if (withSetup) expect(await Promise.race([setupPublication, childFailure])).toMatchObject({ operationId: setupOperationId, state: 'succeeded' });
  expect(setupReports).toEqual(withSetup ? ['running', 'succeeded'] : []);
  if (withSetup) expect(await readFile(marker, 'utf8')).toBe('setup\n');
}, 120_000);
