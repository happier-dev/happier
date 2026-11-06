import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import axios from 'axios';
import nacl from 'tweetnacl';
import { afterEach, expect, it, vi } from 'vitest';
import { ExternalActionExecutionAuthorizationV1Schema, ExternalActionExecutionAuthorizationRequestV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1, verifyExternalActionMachineRpcRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { dispatchOriginalAccountAction } from './externalActionExecutionAuthorization';
import { SessionSpawnNewInputV2Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { SessionTeamCredentialBindingIntentV1Schema } from '@happier-dev/protocol/teams/credentials/sessionBindingIntentV1';
import { sealExternalActionRequestV2, openExternalActionRequestV2, prepareExternalActionResponseV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { prepareRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { createActionExecutor } from '@happier-dev/protocol/actions';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { updateSettings } from '@/persistence';
import { createTeamCredentialNativeProviderSourceFixture } from '@/providers/broker/teamCredentialNativeProviderSource.testkit';
import { TeamCredentialProviderModelCatalogEntryV1Schema } from '@happier-dev/protocol/teams/credentials/resourceV1';
import { openManagedControllerActionCodecV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { createDaemonSessionTeamCredentialNativeOpen } from '@/daemon/providers/sessionTeamCredentialProviderBindingComposition';
import { commitDaemonLaunchSession } from '@/daemon/spawn/commitDaemonLaunchSession';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { releaseDaemonSessionTeamCredentialNativeBindings } from '@/daemon/providers/sessionTeamCredentialNativeLifetime';
import { createOnChildExited } from '@/daemon/sessions/onChildExited';
import type { TrackedSession } from '@/daemon/types';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import { libsodiumPublicKeyFromSecretKey } from '@/api/encryption';

const birthTransport = vi.hoisted(() => ({ fetchSessionByIdCompat: vi.fn() }));
vi.mock('@/session/transport/http/sessionsHttp', async importOriginal => ({
  ...(await importOriginal<typeof import('@/session/transport/http/sessionsHttp')>()),
  fetchSessionByIdCompat: birthTransport.fetchSessionByIdCompat,
}));

afterEach(() => vi.restoreAllMocks());

it.each(['plain', 'e2ee'] as const)('carries only the exact source-signed %s spawn child through ordinary controller-codec admission', async mode => {
  const currentness = await createRequesterCurrentnessSocketHarness();
  const source = await createTeamCredentialNativeProviderSourceFixture();
  const prepared: NonNullable<Awaited<ReturnType<typeof prepareRequesterAccountActionContext>>>[] = [];
  try {
  const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(71));
  const projected = await source.services.projectModels(source.request);
  if (projected.status !== 'success') throw new Error('Expected real source catalog');
  const group = projected.groups[0];
  const row = group?.rows[0];
  if (!group?.sourceRevision || !row?.nativeSource || !row.application) throw new Error('Expected native model source');
  const target = { kind: 'machine' as const, machineId: 'guest' };
  const nativeDelivery = { managedId: 'managed', controllerInstallationId: 'controller-installation',
    guestInstallationId: 'guest-installation', bindingKey: 'binding', placeholderRef: 'opaque-placeholder',
    sourceRevision: group.sourceRevision, providerTicket: row.nativeSource.providerTicket };
  const agentTargetKey = source.agentTargetKey;
  const bornBinding = SessionTeamCredentialBindingIntentV1Schema.parse({ v: 1, slot: { kind: 'provider_model' },
    resourceId: 'team-resource', teamId: 'team', expectedResourceRevision: 3, deliveryMode: 'vendor-native',
    providerModelSelection: { agentTargetKey, modelId: row.ref.modelId, executionMachineId: 'guest',
      application: row.application, nativeSource: { sourceRevision: nativeDelivery.sourceRevision,
      providerTicket: nativeDelivery.providerTicket } }, nativeDelivery });
  if (bornBinding.resourceId === null) throw new Error('Expected native Team binding');
  const { nativeDelivery: _bornFacet, ...selectedBinding } = bornBinding;
  const spawnInput = SessionSpawnNewInputV2Schema.parse({ directory: { kind: 'path', path: '/repo' },
    executionTarget: { serverId: 'home', machineId: 'guest' },
    agentTarget: { kind: 'agent', identity: { pluginId: 'acme.managed-run', localId: 'agent' } },
    modelSelection: { v: 1, updatedAt: 1, ref: { agentTargetKey, modelId: row.ref.modelId, providerConnectionId: null } },
    teamCredentialBindings: [selectedBinding] });
  const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(72) };
  const encryptionBinding = { serverIdentityId: 'srv_home', accountId: 'member', authentication: { kind: 'account' as const, tokenEpoch: 2 },
    actionId: 'session.spawn_new', requestId: 'spawn-request', target };
  const originalActionEnvelope = mode === 'plain' ? { v: 1 as const, requestId: 'spawn-request', target, input: StrictJsonValueSchema.parse(spawnInput) }
    : sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: encryptionBinding, material, input: spawnInput, randomBytes: nacl.randomBytes });
  const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'approved-spawn', binding: {
    serverIdentityId: 'srv_home', accountId: 'member', authentication: { kind: 'account', tokenEpoch: 2 },
    actionId: 'session.spawn_new', requestId: originalActionEnvelope.requestId,
    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(originalActionEnvelope),
    machineId: 'guest', installationId: 'guest-installation', custodianAccountId: 'member', target,
    accountEncryptionMode: mode,
  } });
  const machine = ManagedMachineV1Schema.parse({ id: 'managed', homeId: 'srv_home', custodianAccountId: 'company',
    enrollmentAccountId: 'member', controller: { machineId: 'controller', installationId: 'controller-installation' },
    controllerAccess: { custodian: { accountId: 'company' }, installationPublicKey: Buffer.from(keys.publicKey).toString('base64url') },
    enrolledMachineId: 'guest', launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'guest', choices: {} },
    allocation: 'bound', resource: { contributionRef: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, value: {} },
    creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 0,
    retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const token = `${encode({ alg: 'none' })}.${encode({ sub: 'member', tokenEpoch: 2,
    provenance: { v: 1, kind: 'account', authority: 'present_user' } })}.signature`;
  let mintBody: unknown;
  let installed = false;
  let installs = 0;
  let releases = 0;
  let releasing = false;
  let unavailable = false;
  let accountControlled = false;
  let refuseRemoval = false;
  let loseRemovalAcknowledgement = false;
  let removalGate: Promise<void> | undefined;
  const model = TeamCredentialProviderModelCatalogEntryV1Schema.parse({ selection: { kind: 'team_credential_provider_model',
    resourceId: bornBinding.resourceId, teamId: 'team', expectedResourceRevision: 3, deliveryMode: 'vendor-native',
    agentTargetKey, modelId: row.ref.modelId }, descriptor: row.descriptor, application: row.application,
    sourceFacts: row.sourceFacts, sourceRevision: group.sourceRevision, nativeSource: { providerTicket: row.nativeSource.providerTicket },
    availability: 'available' });
  const credentials = mode === 'plain' ? { token, encryption: null } : { token, encryption: {
    ...material, publicKey: libsodiumPublicKeyFromSecretKey(material.machineKey),
  } };
  await updateSettings(settings => ({ ...settings, servers: { ...settings.servers,
    home: { id: 'home', name: 'Home', serverUrl: 'https://home.example', webappUrl: 'https://home.example',
      createdAt: 1, updatedAt: 1, lastUsedAt: 1, homeConnectionDescriptorAuthority: 'exact',
      homeConnectionDescriptor: { v: 1, homeServerIdentityId: 'srv_home', canonicalServerUrl: 'https://home.example', revision: 1,
        endpoints: [{ kind: 'https', url: 'https://home.example' }] } },
  } }));
  const read = vi.spyOn(axios, 'get').mockImplementation(async url => {
    if (String(url).endsWith('/v1/account/profile')) return { status: 200, data: { id: 'member' } };
    if (String(url).endsWith('/v2/account/settings')) return { status: 200, data: { content: null, version: 0 } };
    if (String(url).endsWith('/v1/account/encryption/currentness')) return { status: 200, data: { mode, version: 1, settingsVersion: 0,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    expect(String(url)).toBe('https://home.example/v1/account/encryption');
    return { status: 200, data: { mode, updatedAt: 1 } };
  });
  const post = vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
    if (String(url).endsWith('/verify')) return { status: 200, data: { ok: true } };
    if (String(url).endsWith('/get')) return { status: 200, data: accountControlled
      ? { ...machine, controller: undefined, controllerAccess: undefined } : machine };
    if (String(url).endsWith('/direct-material')) return { status: 200, data: Reflect.get(body as object, 'bindingKey') === 'withdrawn-peer'
      ? { status: 'prepared', binding: { ...nativeDelivery, bindingKey: 'withdrawn-peer', placeholderRef: 'peer-placeholder' } } : unavailable
      ? { status: 'unavailable', reason: 'binding_unavailable' } : installed
      ? { status: 'ready', binding: nativeDelivery, model, endpoint: row.nativeSource!.endpoint,
        credentialTransport: row.nativeSource!.credentialTransport, placeholder: 'native-placeholder' }
      : { status: 'prepared', binding: nativeDelivery } };
    if (String(url).endsWith('/v1/actions/machines.managed.credentials.install')) {
      const carrier = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
      const authorization = carrier.executionAuthorization;
      if (!authorization) throw new Error('Expected native install authority');
      const codec = openManagedControllerActionCodecV1({ authorization,
        machineId: 'controller', installationId: 'controller-installation', serverIdentityId: 'srv_home', installationPrivateKey: keys.secretKey });
      expect(codec).not.toBeNull();
      if (!codec) throw new Error('Expected exact controller codec');
      const binding = authorization.binding;
      if (releasing) {
        releases++;
        await removalGate;
        if (!refuseRemoval) installed = false;
        if (loseRemovalAcknowledgement) throw new Error('Synthetic network failure after controller policy removal');
      }
      else { installs++; installed = true; }
      const execution = { ok: true as const, result: refuseRemoval
        ? { kind: 'unknown', code: 'action_outcome_unknown' }
        : { kind: 'confirmed', binding: nativeDelivery } };
      const expectedInput = releasing ? { ...input, operation: 'release' } : input;
      if (carrier.envelope.v === 2) {
        const responseBinding = { ...encryptionBinding, actionId: binding.actionId, requestId: binding.requestId, target: binding.target };
        expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: carrier.envelope, binding: responseBinding, material: codec })?.input).toEqual(expectedInput);
        return { status: 200, data: prepareExternalActionResponseV2({ request: carrier.envelope, binding: responseBinding,
          material: codec, executedMachineId: 'controller', randomBytes: nacl.randomBytes, execution }).response };
      }
      expect(carrier.envelope.input).toEqual(expectedInput);
      return { status: 200, data: { v: 1, actionId: binding.actionId, requestId: binding.requestId, execution } };
    }
    mintBody = body;
    const envelope = (body as { envelope: typeof originalActionEnvelope }).envelope;
    return { status: 200, data: { v: 1, token: 'native-install', binding: { ...root.binding,
      machineId: 'controller', installationId: 'controller-installation', custodianAccountId: 'company',
      target: { kind: 'machine', machineId: 'controller' }, actionId: 'machines.managed.credentials.install', requestId: envelope.requestId,
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
      ...(!releasing ? { nativeCredentialSpawnChild: { requestId: root.binding.requestId, requestEnvelopeDigest: root.binding.requestEnvelopeDigest } } : {}),
      managedAdmission: { actionId: 'machines.managed.credentials.install', input: {
        homeId: machine.homeId, managedId: machine.id, sessionId: 'spawned-session', bindingKey: 'binding',
        expectedResourceRevision: 3, expectedSourceRevision: nativeDelivery.sourceRevision, expectedProviderTicket: nativeDelivery.providerTicket,
        ...(releasing ? { operation: 'release' } : {}) } } } } };
  });
  let live = true;
  const admit = async (authorization: typeof root) => {
    const context = await prepareRequesterAccountActionContext({ authorization, purpose: { kind: 'external_action' },
      machineId: 'guest', installationId: 'guest-installation', installationPrivateKey: keys.secretKey,
      serverId: 'home', serverIdentityId: 'srv_home', serverHttpBaseUrl: 'https://home.example',
      ownCredentials: credentials, isCurrent: async () => live,
      createExecutor: () => createActionExecutor(createUnavailableActionTransportDeps()) });
    expect(context).not.toBeNull();
    if (!context) throw new Error('Expected admitted source custody');
    prepared.push(context);
    return context.authorization;
  };
  const admitted = await admit(root);
  const input = { homeId: machine.homeId, managedId: machine.id, sessionId: 'spawned-session', bindingKey: 'binding',
    expectedResourceRevision: 3, expectedSourceRevision: nativeDelivery.sourceRevision, expectedProviderTicket: nativeDelivery.providerTicket };
  const request = { actionId: 'machines.managed.credentials.install', input, requestId: 'install-request',
    target: { kind: 'machine' as const, machineId: 'controller' }, credentials,
    serverHttpBaseUrl: 'https://home.example', serverIdentityId: machine.homeId, authority: 'account_automation',
    nativeCredentialSpawnChild: { context: { externalActionExecutionAuthorization: admitted, externalActionTarget: target,
      originalActionEnvelope }, machineId: 'guest', installationId: 'guest-installation', privateKey: keys.secretKey,
      binding: bornBinding, agentTargetKey, modelId: row.ref.modelId },
  } as const;
  const open = createDaemonSessionTeamCredentialNativeOpen({ machineId: 'guest', accountId: 'member', credentials,
    serverHttpBaseUrl: 'https://home.example', installationIdentity: { installationId: 'guest-installation', privateKey: keys.secretKey },
    resolveCurrentMachineExecutionOriginContext: async () => ({ machineId: 'guest', serverIdentityId: 'srv_home' }),
    spawnActionContext: request.nativeCredentialSpawnChild.context });
  const nativeInput = { consumer: { kind: 'session' as const, sessionId: 'spawned-session' }, agentTargetKey,
    modelId: row.ref.modelId, binding: bornBinding, signal: new AbortController().signal };
  const preparedOpen: { value?: Awaited<ReturnType<typeof open>> } = {};
  if (mode === 'plain') {
    const phases: string[] = [];
    birthTransport.fetchSessionByIdCompat.mockImplementation(async () => ({ id: 'spawned-session', seq: 0,
      encryptionMode: 'plain', metadata: JSON.stringify({ path: '/repo', host: 'guest' }), metadataVersion: 1,
      agentState: null, agentStateVersion: 0, dataEncryptionKey: null, acceptedTeamCredentialBinding: bornBinding }));
    const operations = createHostActionOperationRuntime({ serverId: 'home', machineId: 'guest', resolveAccountId: async () => 'member' });
    const result = await operations.observeExecution({ actionId: 'session.spawn_new',
      input: { ...spawnInput, creationKey: 'native-birth', observeSessionCommit: true }, execute: async operation => {
        const committed = await commitDaemonLaunchSession({ api: { getOrCreateSession: async () => {
          phases.push('born'); return { id: 'spawned-session', metadata: { path: '/repo', host: 'guest' },
            sessionCreationOutcome: { disposition: 'created', organizationPlacement: { folderId: null, tagIds: [] } } };
        } } as never, credentials, accountSettings: {}, directory: '/repo',
        options: { directory: '/repo', teamCredentialBindings: [selectedBinding], projectSetupOperation: operation },
        prepareNativeTeamCredentialBinding: async accepted => {
          expect(accepted).toEqual({ sessionId: 'spawned-session', created: true, binding: bornBinding });
          preparedOpen.value = await open(nativeInput);
          phases.push('installed');
          return async () => { await preparedOpen.value?.cleanup(); };
        } });
        if (!committed.ok) throw new Error('Expected committed native birth');
        return { ok: true, result: { type: 'success', disposition: 'created', sessionId: committed.session.sessionId,
          executionTarget: spawnInput.executionTarget, organizationPlacement: { folderId: null, tagIds: [] },
          initialInput: { status: 'accepted', localId: 'original-input' } } };
      } });
    phases.push('observed');
    expect(result).toMatchObject({ ok: true });
    expect(phases).toEqual(['born', 'installed', 'observed']);
  } else preparedOpen.value = await open(nativeInput);
  const opened = preparedOpen.value;
  if (!opened) throw new Error('Native first use must precede committed acceptance');
  expect(opened.placeholder).toBe('native-placeholder');
  await opened.cleanup();
  const borrowed = await open({ consumer: { kind: 'execution_run', executionRunId: 'attached-recovery' },
    sessionId: 'spawned-session', agentTargetKey,
    modelId: row.ref.modelId, binding: bornBinding, signal: new AbortController().signal });
  expect(borrowed.placeholder).toBe(opened.placeholder);
  await borrowed.cleanup();
  expect(installs).toBe(1);
  expect(mintBody).toMatchObject({ nativeCredentialSpawnChild: { originalActionEnvelope,
    method: 'controller:machines.managed.credentials.install', requestId: expect.any(String), ...(mode === 'plain' ? { params: input } : {}),
    externalActionExecution: { authorization: root, managedAdmission: { actionId: 'machines.managed.credentials.install', input } } } });
  const packet = Reflect.get(mintBody as object, 'nativeCredentialSpawnChild');
  expect(verifyExternalActionMachineRpcRequestV1({ authorizationToken: root.token,
    effectActionId: packet.externalActionExecution.effectActionId, target,
    installationId: 'guest-installation', event: SOCKET_RPC_EVENTS.CALL, method: packet.method,
    requestId: packet.requestId, params: packet.params, managedAdmission: packet.externalActionExecution.managedAdmission,
    signature: packet.externalActionExecution.machineSignature, publicKey: keys.publicKey })).toBe(true);
  expect(JSON.stringify(mintBody)).not.toContain(Buffer.from(keys.secretKey).toString('base64'));
  expect(JSON.stringify(mintBody)).not.toContain('native-source-secret');
  expect(read.mock.calls.some(([url]) => String(url).includes('/v1/machines'))).toBe(false);
  for (const binding of [
    { ...bornBinding, resourceId: 'other-resource' },
    { ...bornBinding, expectedResourceRevision: 4 },
    { ...bornBinding, providerModelSelection: { ...bornBinding.providerModelSelection!, modelId: 'other-model' } },
    { ...bornBinding, nativeDelivery: { ...nativeDelivery, sourceRevision: 'changed' } },
  ]) {
    const before = post.mock.calls.length;
    expect(await dispatchOriginalAccountAction({ ...request, nativeCredentialSpawnChild: { ...request.nativeCredentialSpawnChild, binding } }))
      .toMatchObject({ ok: false, errorCode: 'admission_unavailable' });
    expect(post.mock.calls.length).toBe(before);
  }
  const { teamCredentialBindings: _selected, ...withoutTeam } = spawnInput;
  const absentEnvelope = mode === 'plain' ? { v: 1 as const, requestId: 'spawn-request', target, input: StrictJsonValueSchema.parse(withoutTeam) }
    : sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: encryptionBinding, material, input: withoutTeam, randomBytes: nacl.randomBytes });
  const absentAuthorization = await admit({ ...root, binding: { ...root.binding,
    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(absentEnvelope) } });
  const beforeAbsent = post.mock.calls.length;
  expect(await dispatchOriginalAccountAction({ ...request, nativeCredentialSpawnChild: { ...request.nativeCredentialSpawnChild,
    context: { ...request.nativeCredentialSpawnChild.context, externalActionExecutionAuthorization: absentAuthorization,
      originalActionEnvelope: absentEnvelope } } })).toMatchObject({ ok: false, errorCode: 'admission_unavailable' });
  expect(post.mock.calls.length).toBe(beforeAbsent);
  const lifetime = { machineId: 'guest', credentials, serverHttpBaseUrl: 'https://home.example', homeServerIdentityId: 'srv_home',
    installationIdentity: { installationId: 'guest-installation', privateKey: keys.secretKey },
    resolveCurrentMachineExecutionOriginContext: async () => ({ machineId: 'guest', serverIdentityId: 'srv_home' }) };
  const releaseInput = { sessionId: 'spawned-session', owningAccountId: 'member', bindings: [bornBinding] };
  accountControlled = true;
  unavailable = true;
  const beforeAccountRelease = post.mock.calls.length;
  await expect(releaseDaemonSessionTeamCredentialNativeBindings(releaseInput, lifetime))
    .rejects.toMatchObject({ code: 'team_credential_provider_selection_not_current' });
  expect(post.mock.calls.slice(beforeAccountRelease).some(([url]) => String(url).includes('/v1/actions/'))).toBe(false);
  accountControlled = false;
  unavailable = false;
  live = false;
  const before = post.mock.calls.length;
  // E2EE custody cannot reopen the reviewed input after retirement; Plain
  // reaches the dispatch lifetime refusal. Neither path may submit an effect.
  expect(await dispatchOriginalAccountAction(request)).toMatchObject({ ok: false,
    errorCode: mode === 'e2ee' ? 'admission_unavailable' : 'target_unavailable' });
  expect(post.mock.calls.length).toBe(before);
  releasing = true;
  const beforeWrongOwner = post.mock.calls.length;
  await expect(releaseDaemonSessionTeamCredentialNativeBindings({ ...releaseInput, owningAccountId: 'other-account' }, lifetime))
    .rejects.toMatchObject({ code: 'team_credential_provider_selection_not_current' });
  expect(post.mock.calls.length).toBe(beforeWrongOwner);
  const tracked: TrackedSession = { pid: 2147482912, startedBy: 'daemon', happySessionId: releaseInput.sessionId };
  const sessions = new Map([[tracked.pid, tracked]]);
  const withdrawnPeer = { ...bornBinding, nativeDelivery: { ...nativeDelivery,
    bindingKey: 'withdrawn-peer', placeholderRef: 'peer-placeholder' } };
  let settleRemoval!: () => void;
  removalGate = new Promise<void>(resolve => { settleRemoval = resolve; });
  const finalizeMachineSessionTerminal = vi.fn(async ({ sessionId }: { sessionId: string }) => ({
    v: 1 as const, status: 'closed' as const, sessionId }));
  const onExit = createOnChildExited({ pidToTrackedSession: sessions, spawnResourceCleanupByPid: new Map(),
    sessionAttachCleanupByPid: new Map(), removeSessionMarkerFn: async () => {},
    getApiMachineForSessions: () => ({ enqueueDaemonTerminalExactTurnEnd: async () => undefined,
      captureMachineSessionTerminal: async sessionId => ({ v: 1 as const, status: 'captured' as const,
        sessionId, authority: { kind: 'generation' as const, publisherGeneration: '1' } }), finalizeMachineSessionTerminal }),
    releaseSessionOwnedNativeBindings: async sessionId => await releaseDaemonSessionTeamCredentialNativeBindings({
      ...releaseInput, sessionId, bindings: [withdrawnPeer, bornBinding] }, lifetime) });
  const exiting = onExit(tracked.pid, { reason: 'process-exited', code: 0, signal: null });
  try {
    await vi.waitFor(() => expect(releases).toBe(1));
    expect(finalizeMachineSessionTerminal).not.toHaveBeenCalled();
    expect(sessions.get(tracked.pid)).toBe(tracked);
    settleRemoval();
    await exiting;
    expect(finalizeMachineSessionTerminal).toHaveBeenCalledOnce();
    expect(sessions.size).toBe(0);
  } finally { settleRemoval(); await exiting; removalGate = undefined; }
  expect(releases).toBe(1);
  expect(mintBody).not.toHaveProperty('nativeCredentialSpawnChild');
  // An exact Home proof of no submitted effect is quiet but is not cached as
  // confirmed removal. Generic unavailability still owes the release Action.
  expect(await releaseDaemonSessionTeamCredentialNativeBindings(releaseInput, lifetime)).toBe(false);
  expect(releases).toBe(1);
  unavailable = true;
  refuseRemoval = true;
  await expect(releaseDaemonSessionTeamCredentialNativeBindings(releaseInput, lifetime))
    .rejects.toMatchObject({ code: 'action_outcome_unknown' });
  expect(releases).toBe(2);
  // A missing transport acknowledgement cannot turn an already executed
  // controller effect into a definite selection refusal or successful cleanup.
  refuseRemoval = false;
  loseRemovalAcknowledgement = true;
  await expect(releaseDaemonSessionTeamCredentialNativeBindings(releaseInput, lifetime))
    .rejects.toMatchObject({ code: 'action_outcome_unknown' });
  expect(installed).toBe(false);
  expect(releases).toBe(3);
  expect(installs).toBe(1);
  } finally {
    await Promise.all(prepared.map(context => context.dispose()));
    await source.cleanup();
    await currentness.close();
  }
});
