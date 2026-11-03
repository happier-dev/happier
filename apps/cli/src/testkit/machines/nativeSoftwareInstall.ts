import { createNativeSoftwareOsFixture, nativeTerminal, packageOs } from './nativeSoftwareOs';
import { randomBytes } from 'node:crypto';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { computeAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { sealAccountSettingsV2RawContent } from '@/settings/accountSettings/updateAccountSettingsV2WithRetry';
import axios from 'axios';
import tweetnacl from 'tweetnacl';
import { expect, onTestFailed, onTestFinished, vi } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { MachineSetupDesiredV1Schema, MachineSetupSourceV1Schema } from '@happier-dev/protocol/machines/setup/machineSetupSourcesV1';
import { ExternalActionExecutionAuthorizationV1Schema, ExternalActionDaemonDispatchRequestSchema,
  ExternalActionMachineRpcExecutionV1Schema, ExternalActionRequestEnvelopeSchema,
  EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1, parseExternalActionDaemonDispatchResultV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { verifyExternalActionMachineRpcRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { SOCKET_RPC_EVENTS, SocketRpcRequestIdSchema, type SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { AuthTokenProvenanceSchema } from '@happier-dev/protocol/auth/authToken';
import { openWorkflowProgressStoredEnvelopeV1,
  parseWorkflowStoredContentEnvelopeV1 } from '@happier-dev/protocol/workflows/workflowStoredContentV1';
import { ACTION_API_SERVER_ORIGIN } from '@happier-dev/protocol/rpc';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1,
  MachineUpdateOperationProtocolCapabilitiesRequestV1Schema, MachineUpdateOperationProtocolCapabilitiesResponseV1Schema,
  type MachineOperationProtocolCapabilitiesV1 } from '@happier-dev/protocol/machines/operationProtocolCapabilitiesV1';
import { configuration, reloadConfiguration } from '@/configuration';
import { updateSettings, sameStoredCredentials, writeDaemonState, writeStoredCredentialsForServerId, type StoredCredentials } from '@/persistence';
import type { Machine } from '@/api/types';
import { ApiMachineClient } from '@/api/apiMachine';
import type { RpcActionExecutorContext } from '@/rpc/handlers/_actionDispatchAdapter';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createMachineContentCodec } from '@/api/machine/machineStoredContent';
import { createDaemonMachineAdminAccessRoutes } from '@/machines/adminAccess/createDaemonMachineAdminAccessRoutes';
import { resolveInstalledMachineEffectCli } from '@/machines/adminAccess/runElevatedEffect';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createMachineSetupAction, createMachineSetupPlanAction, createMachineSetupRemoveAction } from '@/machines/setup/machineSetupAction';
import type { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { ACTION_OPERATION_RPC_METHODS_V1, ACTION_OPERATION_RPC_METHODS_V2, ActionOperationGetV1ResponseSchema,
  ActionOperationListV1ResponseSchema, ActionOperationCancelV1ResponseSchema } from '@happier-dev/protocol/actions/operations/v1';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import { createCurrentMachineExecutionOriginContextResolver } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';
import { ConnectedServiceRuntimeRegistry } from '@/daemon/connectedServices/runtimeRegistry/registry';
import type { createRequesterSessionControlRuntimeFixture } from '@/daemon/testkit/requesterSessionControlRuntimeFixture';
import type { ActionExecuteResult, ActionExecutorContext, ActionExecutorDeps } from '@happier-dev/protocol';
import { ExternalActionRequesterInvocationV1Schema } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { dispatchOriginalAccountAction, resolveExternalActionRootInvocationAuthority } from '@/api/externalActionExecutionAuthorization';
import { seedTestServerProfile } from '@/testkit/serverProfiles';
import { SignedRootActionIdSchema } from '@happier-dev/protocol/actions/actionSpecs';
import type { ExternalActionExecutionAuthorizationV1, ExternalActionRequestEnvelope } from '@happier-dev/protocol/actions/externalActionApi';
import type { SignedRootActionId } from '@happier-dev/protocol/actions/actionSpecs';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createProductionDaemonWorkflowRuntime } from '@/daemon/workflows/daemonRuntime';
import { createWorkflowRunStorageTestkit, type WorkflowRunStorageTestkitOperation } from '@/daemon/workflows/workflowRunStorage.testkit';
import { resolveAutomationWorkerAccountEncryption } from '@/daemon/automation/automationWorker';
import { createWorkflowRunMachineTransport } from '@/daemon/workflows/workflowMachineTransport';
import { readUnexpectedActionErrorDiagnosticV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { logger } from '@/ui/logger';

const osStore = vi.hoisted(() => ({
  identity: null as import('@happier-dev/protocol').MachineInstallationIdentityV1 | null,
  credentials: null as StoredCredentials | null,
  reads: [] as string[],
}));
export { osStore, nativeTerminal, packageOs };
// Credential files and installation key storage are the actual OS boundaries.
vi.mock('@/persistence', async importOriginal => ({
  ...await importOriginal<typeof import('@/persistence')>(),
  readStoredCredentialsForServerId: async (serverId: string) => {
    osStore.reads.push(serverId);
    return osStore.credentials;
  },
}));
vi.mock('@/daemon/identity/store', async importOriginal => ({
  ...await importOriginal<typeof import('@/daemon/identity/store')>(),
  readInstallationIdentityIfExistsSync: () => osStore.identity,
}));

export type NativeSoftwareScenario = 'brew' | 'apt' | 'apt-none' | 'first-absent' | 'first-present' | 'first-arrived' | 'first-forged-absent' | 'first-absent-e2ee' | 'remove-absent' | 'remove-absent-e2ee' | 'excluded-to-selected' | 'native-confirm';

type NativeSoftwareActionDeps = ActionExecutorDeps & Required<Pick<ActionExecutorDeps,
  'runActionOperation' | 'machineSetupPlan' | 'machineSetupApply' | 'machineSetupRemove'>>;

/** The real installed Machine/recipe/task path; only native OS and Home IO are substituted. */
export async function createNativeSoftwareInstallFixture(options: Readonly<{
  scenario: NativeSoftwareScenario;
  unprivilegedPackageFactUnavailable?: 'presence' | 'locks';
  accountEncryptionMode?: 'plain' | 'e2ee';
  agentIsolation?: import('@/api/apiMachine').ApiMachineClientLifecycleDependencies['agentIsolation'];
  machineId?: string;
  homeId?: string;
  accountId?: string;
  token?: string;
  serverId?: string;
  serverHttpBaseUrl?: string;
  installationKeyPair?: ReturnType<typeof tweetnacl.sign.keyPair>;
}>) {
  const { scenario, machineId = 'alice-machine', homeId = 'srv_home', accountId = 'alice' } = options;
  const nativeConfirmed = scenario === 'native-confirm';
  const diagnosticStartedAt = performance.now();
  const fixturePhases: Array<Readonly<{ phase: string; elapsedMs: number; status?: number }>> = [];
  const recordFixturePhase = (phase: string, status?: number) => {
    if (nativeConfirmed) fixturePhases.push({ phase, elapsedMs: Math.round(performance.now() - diagnosticStartedAt),
      ...(status === undefined ? {} : { status }) });
  };
  if (nativeConfirmed) onTestFailed(() => { console.error('Native fixture phases:', JSON.stringify(fixturePhases)); });
  const manager = scenario === 'brew' ? 'brew' : 'apt';
  const removing = scenario.startsWith('remove-');
  const firstPresence = scenario.startsWith('first-') || removing;
  const initiallyPresent = scenario === 'first-present' || scenario === 'first-forged-absent';
  const excludedToSelected = scenario === 'excluded-to-selected';
  const encryptionMode = options.accountEncryptionMode ?? (scenario.endsWith('-e2ee') ? 'e2ee' : 'plain');
  recordFixturePhase('os_fixture.begin');
  const os = await createNativeSoftwareOsFixture({ manager, initiallyPresent,
    unprivilegedPackageFactUnavailable: options.unprivilegedPackageFactUnavailable });
  recordFixturePhase('os_fixture.end');
  const { directory, statePath, rootLaunches, rootPlans, nativeCommands, runNative } = os;
  const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_ACTIVE_SERVER_ID']);
  onTestFinished(async () => {
    osStore.identity = null; osStore.credentials = null;
    await os.dispose(); env.restore(); reloadConfiguration();
  });
  env.patch({ HAPPIER_HOME_DIR: join(directory, 'happier'),
    ...(options.serverHttpBaseUrl ? { HAPPIER_SERVER_URL: options.serverHttpBaseUrl } : {}),
    ...(options.serverId ? { HAPPIER_ACTIVE_SERVER_ID: options.serverId } : {}) });
  reloadConfiguration();
  // The real elevation owner checks the managed executable before invoking
  // sudo. Its process boundary below still runs the real stdin interpreter.
  const installedCli = resolveInstalledMachineEffectCli();
  expect(installedCli.startsWith(directory + sep)).toBe(true);
  await mkdir(dirname(installedCli), { recursive: true });
  await writeFile(installedCli, `#!${process.execPath}\nprocess.exitCode = 1;\n`, { mode: 0o755 });
  recordFixturePhase('authored_runtime.begin');
  const runtime = await createAuthoredAdmittedPluginRuntimeFixture({ happyHomeDir: configuration.happyHomeDir,
    controller: pluginReloadController, plugins: os.plugins });
  recordFixturePhase('authored_runtime.end');
  onTestFinished(() => runtime.dispose());
  const pair = options.installationKeyPair ?? tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(17));
  osStore.identity = { version: 1, installationId: '11111111-1111-4111-8111-111111111111', createdAt: 1,
    publicKey: Buffer.from(pair.publicKey).toString('base64url'), privateKey: Buffer.from(pair.secretKey).toString('base64url') };
  // Publisher custody is read by the real installation/settings owners.
  recordFixturePhase('installation_settings.begin');
  await writeFile(configuration.installationIdentityFile, JSON.stringify(osStore.identity), { mode: 0o600 });
  await updateSettings(settings => ({ ...settings, machineId,
    machineIdByServerId: { ...settings.machineIdByServerId, [configuration.activeServerId]: machineId } }));
  recordFixturePhase('installation_settings.end');
  const issuerToken = options.token ?? `header.${Buffer.from(JSON.stringify({ sub: accountId,
    ...(nativeConfirmed ? { tokenEpoch: 0, provenance: { v: 1, kind: 'account', authority: 'present_user' } } : {}),
  })).toString('base64url')}.signature`;
  // Match the installed service fixture: the app retains its UI Account bearer,
  // while the daemon stores an independently issued terminal credential.
  const token = nativeConfirmed ? `header.${Buffer.from(JSON.stringify({ sub: accountId, tokenEpoch: 0,
    provenance: AuthTokenProvenanceSchema.parse({ v: 1, kind: 'terminal', authority: 'account_automation' }),
  })).toString('base64url')}.installed-signature` : issuerToken;
  const accountMachineKey = new Uint8Array(32).fill(23);
  const credentials: StoredCredentials = encryptionMode === 'plain'
    ? { token, encryption: null, credentialProvenance: 'stored_session' }
    : { token, encryption: { type: 'dataKey', machineKey: accountMachineKey,
      publicKey: tweetnacl.box.keyPair.fromSecretKey(accountMachineKey).publicKey }, credentialProvenance: 'stored_session' };
  osStore.credentials = credentials;
  const accountEncryptionCurrentness = { mode: encryptionMode, version: 1,
    signingKeyFingerprint: null, contentKeyFingerprint: encryptionMode === 'plain' ? null
      : computeAccountEncryptionMigrateKeyFingerprintV1(tweetnacl.box.keyPair.fromSecretKey(accountMachineKey).publicKey), updatedAt: 1 };
  const issuerCredentials: StoredCredentials = nativeConfirmed ? { ...credentials, token: issuerToken } : credentials;
  const sources = MachineSetupSourceV1Schema.parse([{ kind: 'direct', setup: { items: [{
    kind: 'softwareRecipe', selection: {
      ref: { pluginId: 'com.example.public-package', recipeId: 'jq', revision: '1' }, inputs: {},
    },
  }] } }]);
  const initialDesired = excludedToSelected ? MachineSetupDesiredV1Schema.parse({ version: 1, revision: 0, sources,
    exclusions: [{ ref: { pluginId: 'com.example.public-package', recipeId: 'jq', revision: '1' }, reason: 'not_selected' }],
  }) : undefined;
  const machine: Machine = { id: machineId, ...(encryptionMode === 'plain' ? { encryptionMode } : {
    encryptionMode, encryptionKey: new Uint8Array(32).fill(7), encryptionVariant: 'dataKey',
    dataEncryptionKey: Buffer.from(sealEncryptedDataKeyEnvelopeV1({ dataKey: new Uint8Array(32).fill(7),
      recipientPublicKey: tweetnacl.box.keyPair.fromSecretKey(accountMachineKey).publicKey, randomBytes })).toString('base64'),
  }), metadata: {
    host: 'worker', platform: 'linux', happyCliVersion: 'dev', homeDir: directory, happyHomeDir: configuration.happyHomeDir,
    adminAccess: { version: 1, mode: scenario === 'apt' || firstPresence || excludedToSelected || nativeConfirmed ? 'preauthorized' : 'none' },
    ...(options.agentIsolation ? { agentIsolation: { enabled: true } } : {}),
    ...(initialDesired ? { setup: initialDesired } : {}),
  }, metadataVersion: 0, daemonState: { status: 'running' }, daemonStateVersion: 0 };
  const codec = createMachineContentCodec(machine);
  const metadataWrites: unknown[] = [];
  const metadataPublications: Array<Readonly<{ version: number; changedKeys: string[];
    coordinatePhase: string; elapsedMs: number }>> = [];
  let publishedCapabilities: MachineOperationProtocolCapabilitiesV1 | undefined;
  let capabilitiesRevision = 0;
  recordFixturePhase('machine_client.begin');
  const client = new ApiMachineClient(token, machine, undefined,
    options.agentIsolation ? { agentIsolation: options.agentIsolation } : undefined);
  recordFixturePhase('machine_client.end');
  recordFixturePhase('initial_rpc_registration.begin');
  let registration = client.setRPCHandlers({ spawnSession: async () => { throw new Error('Not a Session'); },
    stopSession: async () => ({ status: 'not_found' }), requestShutdown() {} });
  recordFixturePhase('initial_rpc_registration.end');
  Reflect.set(client, 'socket', createApiSessionSocketStub({ connected: true, emitWithAck: async (event, payload) => {
    if (event === MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1) {
      const request = MachineUpdateOperationProtocolCapabilitiesRequestV1Schema.parse(payload);
      expect(request.machineId).toBe(machine.id);
      publishedCapabilities = request.capabilities;
      capabilitiesRevision += 1;
      return MachineUpdateOperationProtocolCapabilitiesResponseV1Schema.parse({ v: 1,
        result: 'success', revision: capabilitiesRevision });
    }
    if (!payload || typeof payload !== 'object') throw new Error('Machine CAS requires an object payload');
    if (event === 'machine-update-state') return {
      result: 'success', version: machine.daemonStateVersion + 1, daemonState: Reflect.get(payload, 'daemonState'),
    };
    expect(event).toBe('machine-update-metadata');
    expect(Reflect.get(payload, 'expectedDataEncryptionKey')).toBe(encryptionMode === 'plain' ? null : machine.dataEncryptionKey);
    const stored: unknown = Reflect.get(payload, 'metadata');
    if (typeof stored !== 'string') throw new Error('Metadata CAS must carry serialized content');
    const decoded = codec.decodeStored(stored);
    expect(decoded).toMatchObject({ host: 'worker', platform: 'linux' });
    if (encryptionMode === 'e2ee') expect(stored).not.toContain('machineSetup');
    if (nativeConfirmed && decoded && typeof decoded === 'object') {
      const previous = machine.metadata;
      const keys = new Set([...Object.keys(previous ?? {}), ...Object.keys(decoded ?? {})]);
      const changedKeys = new Set<string>();
      for (const key of keys) {
        if (!isDeepStrictEqual(previous && Reflect.get(previous, key), decoded && Reflect.get(decoded, key)))
          changedKeys.add(key === 'setup' || key === 'agentInventory' ? key : 'other');
      }
      metadataPublications.push({ version: machine.metadataVersion + 1, changedKeys: [...changedKeys].sort(),
        coordinatePhase, elapsedMs: Math.round(performance.now() - diagnosticStartedAt) });
    }
    metadataWrites.push(decoded);
    return { result: 'success', version: machine.metadataVersion + 1, metadata: stored };
  } }));
  client.registerMachineAdminAccessRoutes(createDaemonMachineAdminAccessRoutes({ getMachineClient: () => client,
    target: () => ({ serverId: configuration.activeServerId, machineId: machine.id,
      installationId: osStore.identity!.installationId, custodianAccountId: accountId }),
    nativeDependencies: { platform: 'linux', execFile: async (executable, args) => {
      const result = await runNative({ executable, args });
      if (result.code !== 0) throw Object.assign(new Error('Native observation unavailable'), { code: result.code ?? result.errorCode });
      return { stdout: result.stdout };
    }, fileSystem: { lstat: async () => { throw Object.assign(new Error('No managed sudoers fixture'), { code: 'ENOENT' }); },
      readFile: async () => { throw new Error('No managed sudoers fixture'); } },
    readTailscaledOperator: async () => ({ authorization: 'unknown' }),
  } }));
  const readHomeMachine = () => ({ id: machineId, accountId, active: true, activeAt: Date.now(), revokedAt: null,
    replacedByMachineId: null, kind: 'persistent', installationId: osStore.identity!.installationId,
    installationPublicKey: Buffer.from(pair.publicKey).toString('base64'),
    dataEncryptionKey: machine.dataEncryptionKey ?? (nativeConfirmed ? MACHINE_PLAIN_DATA_KEY_MARKER : null), storageMode: encryptionMode,
    ...(nativeConfirmed ? { access: { custodian: { accountId, displayName: accountId }, role: 'manage',
      resourceMode: encryptionMode, accessState: 'ready' } } : {}),
    ...(publishedCapabilities ? { operationProtocolCapabilities: publishedCapabilities,
      operationProtocolCapabilitiesRevision: capabilitiesRevision } : {}),
    metadata: codec.encodeStored(machine.metadata), metadataVersion: machine.metadataVersion,
    daemonState: machine.daemonState == null ? null : codec.encodeStored(machine.daemonState),
    daemonStateVersion: machine.daemonStateVersion });
  let additionalHomeRead: ((url: string) => Readonly<{ status: number; data: unknown }> | undefined) | undefined;
  const profile = vi.spyOn(axios, 'get').mockImplementation(async url => {
    const phase = String(url).endsWith('/v1/account/profile') ? 'home_get.profile'
      : String(url).endsWith('/v1/account/encryption/currentness') ? 'home_get.currentness'
      : /\/v[12]\/account\/settings$/u.test(String(url)) ? 'home_get.settings' : null;
    if (phase) recordFixturePhase(`${phase}.begin`);
    try {
      const response = additionalHomeRead?.(String(url)) ?? ({ status: 200,
        data: String(url).endsWith('/v1/machines') ? [readHomeMachine()]
          : String(url).endsWith(`/v1/machines/${machineId}`) ? { machine: readHomeMachine() }
          : new URL(String(url)).pathname === '/v1/artifacts' ? []
          : String(url).endsWith('/v1/account/encryption/currentness') ? accountEncryptionCurrentness
          : /\/v[12]\/account\/settings$/u.test(String(url)) ? { content: sealAccountSettingsV2RawContent({ credentials,
          raw: {}, envelopeKind: encryptionMode === 'plain' ? 'plain' : 'encrypted', randomBytes }), version: 1 }
          : String(url).endsWith('/v1/account/encryption') ? { mode: encryptionMode, updatedAt: 1 } : { id: accountId },
      });
      if (phase) recordFixturePhase(`${phase}.end`, response.status);
      return response;
    } catch (error) {
      if (phase) recordFixturePhase(`${phase}.rejected`);
      throw error;
    }
  });
  const installation = { installationId: osStore.identity.installationId, privateKey: pair.secretKey };
  const binding = { accountId: accountId, custodianAccountId: accountId, authentication: { kind: 'account', tokenEpoch: 0 },
    accountEncryptionMode: encryptionMode, serverIdentityId: homeId, machineId: machine.id,
    installationId: installation.installationId, target: { kind: 'machine', machineId: machine.id }, requestEnvelopeDigest: 'a'.repeat(43) };
  const context = (actionId: 'machines.setup.plan' | 'machines.setup.apply' | 'machines.setup.remove' | 'machines.setup.updates.apply', requestId: string = actionId): RpcActionExecutorContext => ({
    surface: 'rpc', actionRequestId: requestId, signal: new AbortController().signal,
    externalActionExecutionAuthorization: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'reviewed-software',
      binding: { ...binding, actionId, requestId } }), externalActionTarget: { kind: 'machine', machineId: machine.id },
    machineAdmission: { actorAccountId: accountId, custodianAccountId: accountId, machineId: machine.id,
      installationId: installation.installationId, role: 'manage', encryptionMode }, verifyMachineAdmissionCurrent: async () => true,
  });
  const apply = createMachineSetupAction({ apiMachine: client, machineId: machine.id, homeId: homeId, installation });
  type OperationHandlers = ReturnType<typeof createHostActionOperationRuntime>['handlers'];
  // The installed ApiMachine owns every receipt, including native tasks and
  // coordinator observations. These accessors only cross its public RPC port.
  const operations = { runActionOperation: client.runActionOperation.bind(client),
    observeExecution: client.observeActionExecution.bind(client), handlers: {
    getV2: async (input: Parameters<OperationHandlers['getV2']>[0], context?: Parameters<OperationHandlers['getV2']>[1]) =>
      ActionOperationGetV1ResponseSchema.parse(await client.invokeLocalMachineAction(ACTION_OPERATION_RPC_METHODS_V2.get, input,
        context ? { rpcContext: context, signal: context.signal } : undefined)),
    listV2: async (input: Parameters<OperationHandlers['listV2']>[0], context?: Parameters<OperationHandlers['listV2']>[1]) =>
      ActionOperationListV1ResponseSchema.parse(await client.invokeLocalMachineAction(ACTION_OPERATION_RPC_METHODS_V2.list, input,
        context ? { rpcContext: context, signal: context.signal } : undefined)),
    cancel: async (input: Parameters<OperationHandlers['cancel']>[0], context?: Parameters<OperationHandlers['cancel']>[1]) =>
      ActionOperationCancelV1ResponseSchema.parse(await client.invokeLocalMachineAction(ACTION_OPERATION_RPC_METHODS_V1.cancel, input,
        context ? { rpcContext: context, signal: context.signal } : undefined)),
  } };
  const nativeDeps: NativeSoftwareActionDeps = {
    ...createUnavailableActionTransportDeps(), runActionOperation: operations.runActionOperation,
    machineSetupPlan: createMachineSetupPlanAction({ apiMachine: client, machineId, homeId, runNative }),
    machineSetupApply: async (request: Parameters<NonNullable<import('@happier-dev/protocol').ActionExecutorDeps['machineSetupApply']>>[0]) =>
      apply({ ...request, input: request.input.targets[0]!, context: request.context }),
    machineSetupRemove: createMachineSetupRemoveAction({ apiMachine: client, machineId, homeId, installation }),
  };
  const directTransport = { machineId,
    machineSetupApply: nativeDeps.machineSetupApply, machineSetupRemove: nativeDeps.machineSetupRemove,
    invoke: (method: string, input: unknown, options?: Parameters<ApiMachineClient['invokeLocalMachineAction']>[2]) =>
      client.invokeLocalMachineAction(method, input, options) };
  // Retained for isolated owner-negative tests, never the installed full-flow caller.
  const createExecutor = (credentials: StoredCredentials, overrides?: Partial<import('@happier-dev/protocol').ActionExecutorDeps>): ReturnType<typeof createCliActionExecutorHarness>['executor'] => createCliActionExecutorHarness({ token: credentials.token,
    credentials, sessionId: '', serverId: options.serverId ?? configuration.activeServerId, serverIdentityId: homeId,
    serverHttpBaseUrl: options.serverHttpBaseUrl ?? configuration.apiServerUrl,
    // There is no Session content here; Account crypto stays in credentials.
    mode: 'plain', ctx: null,
    externalActionMachineRequestPrivateKey: pair.secretKey,
    externalActionMachineInstallationId: installation.installationId,
    machineActionDirectTargetTransport: directTransport,
  }, { runActionOperation: operations.runActionOperation, machineSetupPlan: nativeDeps.machineSetupPlan,
    ...overrides }).executor;
  let startup: Awaited<ReturnType<typeof createRequesterSessionControlRuntimeFixture>> | undefined;
  const startInstalledRuntime = async () => {
    if (!nativeConfirmed || startup) throw new Error('Native startup must be installed once');
    const serverId = options.serverId ?? configuration.activeServerId;
    recordFixturePhase('profile_credentials.begin');
    await seedTestServerProfile({ id: serverId, homeId,
      serverUrl: options.serverHttpBaseUrl ?? configuration.apiServerUrl });
    // The real operation census reads access.key, not the injected per-server
    // credential-file boundary. Persist only inside this OS fixture's Home.
    expect(configuration.serversDir).toBe(join(directory, 'happier', 'servers'));
    expect(configuration.privateKeyFile).toBe(join(directory, 'happier', 'servers', serverId, 'access.key'));
    await writeStoredCredentialsForServerId(serverId, credentials);
    recordFixturePhase('profile_credentials.end');
    recordFixturePhase('startup_module_import.begin');
    const { createRequesterSessionControlRuntimeFixture } = await import('@/daemon/testkit/requesterSessionControlRuntimeFixture');
    recordFixturePhase('startup_module_import.end');
    recordFixturePhase('installed_runtime.begin');
    startup = await createRequesterSessionControlRuntimeFixture({
      happyHomeDir: configuration.happyHomeDir, activeServerDir: configuration.activeServerDir,
      serverId: options.serverId ?? configuration.activeServerId,
      serverHttpBaseUrl: options.serverHttpBaseUrl ?? configuration.apiServerUrl,
      machineId, custodianAccountId: accountId, credentials,
      connectedServicesMaterializationBaseDir: join(directory, 'connected-services'),
      registry: new ConnectedServiceRuntimeRegistry(), trackedSessions: new Map(), getRequester: () => null,
      getApiMachineForSessions: () => client, resolveQualifiedConnectedAccountV4Support: () => 'advertised',
      startup: { pluginRuntimeController: runtime.controller,
        resolveCurrentMachineExecutionOriginContext: createCurrentMachineExecutionOriginContextResolver({
          serverUrl: options.serverHttpBaseUrl ?? configuration.apiServerUrl,
          resolveCurrentMachineId: () => machineId, resolveCurrentServerIdentityId: () => homeId,
        }) },
    });
    recordFixturePhase('installed_runtime.end');
    const owner = startup.runtime.externalActionIngressOwner;
    if (!owner) throw new Error('Native startup did not install its external Action owner');
    recordFixturePhase('installed_rpc_registration.begin');
    await registration.dispose();
    registration = client.setRPCHandlers({ spawnSession: async () => { throw new Error('Not a Session'); },
      stopSession: async () => ({ status: 'not_found' }), requestShutdown() {} }, { externalActionIngressOwner: owner });
    recordFixturePhase('installed_rpc_registration.end');
    // Local catalog reads cross the same authenticated control HTTP boundary as
    // production. This publication lives only in this fixture's temporary Home.
    writeDaemonState({ pid: process.pid, startedAt: Date.now(), startedWithCliVersion: 'test',
      httpPort: startup.runtime.controlPort, controlToken: startup.runtime.controlToken,
      machineId, accountId });
  };
  const publicExecutor = { execute: async (actionId: string, input: unknown, invocation: ActionExecutorContext = {}): Promise<ActionExecuteResult> => {
    const phase = actionId === 'machines.setup.plan' ? 'public_plan'
      : actionId === 'machines.setup.apply' ? 'public_apply' : 'public_approval_decision';
    recordFixturePhase(`${phase}.begin`);
    try { return await dispatchOriginalAccountAction({ actionId: SignedRootActionIdSchema.parse(actionId), input,
      credentials: issuerCredentials, serverHttpBaseUrl: options.serverHttpBaseUrl ?? configuration.apiServerUrl,
      serverIdentityId: homeId, requestId: invocation.actionRequestId ?? actionId,
      target: invocation.externalActionTarget ?? { kind: 'machine', machineId }, authority: 'present_user',
      invocation: ExternalActionRequesterInvocationV1Schema.parse({ caller: { kind: 'host' }, surface: 'ui', authority: 'present_user',
        ...(invocation.presentUserConfirmation ? { presentUserConfirmation: invocation.presentUserConfirmation } : {}) }),
      onRequesterSessionCredentialDisclosure: () => true,
      ...(invocation.signal ? { signal: invocation.signal } : {}),
    }); } finally { recordFixturePhase(`${phase}.end`); }
  } };
  const receive = async (request: Readonly<{ actionId: SignedRootActionId; envelope: ExternalActionRequestEnvelope;
    authorization: ExternalActionExecutionAuthorizationV1; authority?: 'present_user' | 'account_automation' }>) => {
    const binding = request.authorization.binding;
    if (!('authentication' in binding)) throw new Error('Native Store fixture expects an Account-authorized request');
    if (!startup) throw new Error('Native receiving owner has not started');
    const dispatch = ExternalActionDaemonDispatchRequestSchema.parse({ actionId: request.actionId, envelope: request.envelope,
      executionAuthorization: request.authorization,
      principal: { accountId: binding.accountId, authentication: binding.authentication, authority: request.authority ?? 'present_user' },
      placement: { machineId, target: request.envelope.target } });
    const manager: unknown = Reflect.get(client, 'rpcHandlerManager');
    if (!(manager instanceof RpcHandlerManager)) throw new Error('Expected installed native RPC owner');
    const phase = binding.workflowActionOrigin ? 'workflow_receiver' : 'ordinary_receiver';
    recordFixturePhase(`${phase}.begin`);
    let received: unknown;
    try { received = await manager.handleRequest({ method: `${machineId}:${EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1}`,
      params: dispatch, authorization: ACTION_API_SERVER_ORIGIN,
      machineAdmission: { actorAccountId: binding.accountId, custodianAccountId: accountId, machineId,
        installationId: installation.installationId, role: 'manage', encryptionMode } });
    } finally { recordFixturePhase(`${phase}.end`); }
    const outcome = parseExternalActionDaemonDispatchResultV1(received);
    if (!outcome || outcome.kind !== 'response') throw new Error('Installed native receiver refused Home delivery');
    return outcome.prepared.response;
  };
  const receiveRpc = async (packet: SocketRpcRequestPayload) => {
    if (!startup || typeof packet.method !== 'string' || !packet.method.startsWith(`${machineId}:`)
      || !Object.hasOwn(packet, 'params')) throw new Error('Invalid native Home Machine RPC request');
    const requestId = packet.requestId === undefined ? undefined : SocketRpcRequestIdSchema.parse(packet.requestId);
    const execution = packet.externalActionExecution === undefined ? undefined
      : ExternalActionMachineRpcExecutionV1Schema.parse(packet.externalActionExecution);
    const originalActionEnvelope = packet.originalActionEnvelope === undefined ? undefined
      : ExternalActionRequestEnvelopeSchema.parse(packet.originalActionEnvelope);
    if (execution) expect(verifyExternalActionMachineRpcRequestV1({
      authorizationToken: execution.authorization.token,
      requesterAccountContext: execution.authorization.requesterAccountContext,
      effectActionId: execution.effectActionId, target: execution.target, installationId: execution.installationId,
      event: SOCKET_RPC_EVENTS.CALL, method: packet.method, requestId: requestId!, params: packet.params,
      signature: execution.machineSignature, publicKey: pair.publicKey,
    })).toBe(true);
    const manager: unknown = Reflect.get(client, 'rpcHandlerManager');
    if (!(manager instanceof RpcHandlerManager)) throw new Error('Expected installed native RPC owner');
    const result = await manager.handleRequest({ method: packet.method, params: packet.params,
      ...(requestId ? { requestId } : {}),
      callerAuthority: execution ? resolveExternalActionRootInvocationAuthority(execution.authorization)
        : packet.callerAuthority === 'account_automation' ? 'account_automation' : 'present_user',
      machineAdmission: { actorAccountId: accountId, custodianAccountId: accountId, machineId,
        installationId: installation.installationId, role: 'manage', encryptionMode },
      ...(originalActionEnvelope ? { originalActionEnvelope } : {}),
      ...(execution ? { callerInputAuthorization: execution.authorization,
        ...(execution.authorization.binding.sessionActionOrigin
          ? { sessionActionOrigin: execution.authorization.binding.sessionActionOrigin } : {}) } : {}),
    });
    return { ok: true, result };
  };
  let workflowStorage: ReturnType<typeof createWorkflowRunStorageTestkit> | undefined;
  let coordinate: Promise<unknown> | undefined;
  let coordinatePhase = 'not_started';
  let coordinateState: string | undefined;
  let coordinateErrorCode: string | undefined;
  const workflowLifetime = new AbortController();
  const openStoredProgress = (row: ReturnType<ReturnType<typeof createWorkflowRunStorageTestkit>['rows']>[number]) => {
    const index = row.index;
    return openWorkflowProgressStoredEnvelopeV1({ mode: encryptionMode,
      binding: { v: 1, purpose: 'invocation_progress', accountId, runId: index.runId,
        recordId: index.id, sequence: index.sequence, parentRecordId: index.parentRecordId,
        memberOrdinal: index.memberOrdinal, attempt: index.attempt },
      envelope: parseWorkflowStoredContentEnvelopeV1(row.contentEnvelope),
    });
  };
  const readActionFailureDiagnostics = async () => {
    const childRequests = new Set((workflowStorage?.rows() ?? []).flatMap(row => {
      const opened = openStoredProgress(row);
      return opened.kind === 'available' && opened.content.execution?.kind === 'action'
        ? [opened.content.execution.actionRequestId] : [];
    }));
    logger.flushSync();
    const log = await readFile(logger.getLogPath(), 'utf8').catch(() => '');
    return log.split('\n').flatMap(line => {
      const marker = '[external-action-phase] ';
      const offset = line.indexOf(marker);
      if (offset === -1) return [];
      let record: unknown;
      try { record = JSON.parse(line.slice(offset + marker.length)); } catch { return []; }
      if (!record || typeof record !== 'object' || !('requestId' in record) || typeof record.requestId !== 'string'
        || !childRequests.has(record.requestId) || !('actionId' in record) || record.actionId !== 'machines.setup.apply'
        || !('phase' in record) || record.phase !== 'action_execution') return [];
      const errorClass = 'errorClass' in record ? record.errorClass : undefined;
      const errorCode = 'errorCode' in record ? record.errorCode : undefined;
      const diagnostic = readUnexpectedActionErrorDiagnosticV1({ name: errorClass,
        code: errorClass === 'JsonRpcApplicationError' && typeof errorCode === 'string' ? Number(errorCode) : errorCode,
        status: 'httpStatus' in record ? record.httpStatus : undefined });
      const frames = 'stackFrames' in record && Array.isArray(record.stackFrames) ? record.stackFrames : [];
      const stackFrames = frames.flatMap((frame: unknown) => {
        if (!frame || typeof frame !== 'object' || !('file' in frame) || typeof frame.file !== 'string'
          || !('line' in frame) || typeof frame.line !== 'number' || !Number.isInteger(frame.line)
          || !('column' in frame) || typeof frame.column !== 'number' || !Number.isInteger(frame.column)) return [];
        const source = /(?:^|\/)((?:apps|packages)\/[\w./@+-]+\.(?:[cm]?js|tsx?))$/u.exec(frame.file);
        return source ? [{ file: source[1]!, line: frame.line, column: frame.column }] : [];
      });
      return [{ phase: 'action_execution' as const, errorClass: diagnostic.errorClass,
        errorCode: diagnostic.errorCode, httpStatus: diagnostic.httpStatus, stackFrames }];
    });
  };
  // Only the opaque Home storage/worker-claim boundary is substituted. The
  // daemon factory owns materialization, workspace, currentness and execution.
  const respondWorkflowStorage = async (body: unknown): Promise<unknown> => {
    if (!body || typeof body !== 'object' || !('operation' in body) || typeof body.operation !== 'string')
      throw new Error('Malformed Workflow storage HTTP request');
    // This is the genuinely untyped HTTP/storage boundary; the existing
    // storage fixture rejects unsupported operations without opening content.
    const request = body as WorkflowRunStorageTestkitOperation;
    if (!workflowStorage) {
      if ((request.operation !== 'get' && request.operation !== 'admit') || typeof request.runId !== 'string')
        throw new Error('Expected an exact Workflow lookup or admission');
      workflowStorage = createWorkflowRunStorageTestkit({ runId: request.runId, machineId, accountId,
        origin: { kind: 'direct' }, onBeforeWait: async () => { await coordinate; } });
    }
    const storage = workflowStorage;
    const response = await storage.execute(request);
    if (request.operation === 'admit' && !coordinate) {
      coordinate = (async () => {
        coordinatePhase = 'account_encryption';
        const encryption = await resolveAutomationWorkerAccountEncryption({ token, credentials, signal: workflowLifetime.signal });
        if (encryption.kind !== 'available') throw new Error('Native Workflow Account currentness is unavailable');
        coordinatePhase = 'coordinator_factory';
        const runtime = createProductionDaemonWorkflowRuntime({ credentials, accountId,
          serverId: options.serverId ?? configuration.activeServerId });
        const serverId = options.serverId ?? configuration.activeServerId;
        const attribution = { serverId, accountId, machineId, installationId: installation.installationId };
        const requesterTransport = nativeConfirmed ? createWorkflowRunMachineTransport({ runId: storage.run().id,
          credentials, requesterWorkAttributionV1: attribution,
          isCurrent: async () => !workflowLifetime.signal.aborted && configuration.activeServerId === serverId
            && osStore.identity?.installationId === installation.installationId
            && sameStoredCredentials(credentials, osStore.credentials), signal: workflowLifetime.signal,
          boundary: { serverId, serverHttpBaseUrl: options.serverHttpBaseUrl ?? configuration.apiServerUrl,
            happyHomeDir: configuration.happyHomeDir, getObservedServerIdentityId: () => homeId },
          transport: { machineId, invoke: (method, input, options) => client.invokeLocalMachineAction(method, input, options) },
        }) : undefined;
        const run = runtime.createCoordinatorForMachine({ machineId,
          ...(nativeConfirmed ? { requesterWorkAttributionV1: attribution } : {}),
          machineAdmissionTransport: (request, options) => client.enqueueSessionPendingByMachine(request, options),
          machineActionDirectTargetTransport: requesterTransport?.transport ?? directTransport,
          installationIdentity: installation, serverIdentityId: homeId });
        try {
          coordinatePhase = 'run_coordinator';
          recordFixturePhase('coordinator.begin');
          const result = await run({ runId: storage.run().id, attempt: 0, expectedRevision: storage.run().revision,
            acceptedEnvelope: storage.acceptedEnvelope()!, accountCurrentness: encryption.witness,
            signal: workflowLifetime.signal });
          coordinateState = result.state;
          coordinatePhase = 'settled';
          recordFixturePhase('coordinator.settled');
          return result;
        } finally { await requesterTransport?.dispose(); }
      })().catch(error => {
        coordinatePhase = 'rejected';
        coordinateErrorCode = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
          && /^[a-zA-Z0-9_.:-]+$/u.test(error.code) ? error.code : undefined;
        throw error;
      });
      // Preserve failures for the real wait boundary without an unhandled
      // rejection while the caller is still awaiting its admission response.
      void coordinate.catch(() => {});
    }
    return response;
  };
  const workflowDiagnostic = () => {
    const manager: unknown = Reflect.get(client, 'rpcHandlerManager');
    return { coordinatePhase, coordinateState, coordinateErrorCode,
      operations: workflowStorage?.operations(), state: workflowStorage?.run().state,
      custodyState: workflowStorage?.run().workflowCustodyState,
      invocations: workflowStorage?.rows().map(row => {
        const index = row.index;
        const opened = openStoredProgress(row);
        if (opened.kind !== 'available') return { lifecycle: index.lifecycle, content: opened.kind };
        const code = opened.content.reason?.code;
        return { lifecycle: index.lifecycle, blockKind: opened.content.blockKind,
          executionKind: opened.content.execution?.kind,
          reasonCode: typeof code === 'string' && /^[a-zA-Z0-9_.:-]+$/u.test(code) ? code : undefined };
      }),
      ...(manager instanceof RpcHandlerManager ? { rpc: {
        inFlightCount: manager.getInFlightRequestCount(),
        activeHandlerMethods: manager.getActiveHandlerExecutions().map(execution => execution.method),
        capabilitiesDetectRegistered: manager.hasHandler(RPC_METHODS.CAPABILITIES_DETECT),
      } } : {}),
      metadataPublications: [...metadataPublications], rootLaunchCount: rootLaunches.length,
      rootPlanCount: rootPlans.length, elapsedMs: Math.round(performance.now() - diagnosticStartedAt),
    };
  };
  let beforeCleanup: ReturnType<typeof workflowDiagnostic> | undefined;
  const captureNativeDiagnostics = () => {
    if (nativeConfirmed && startup && !beforeCleanup) beforeCleanup = workflowDiagnostic();
  };
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    recordFixturePhase('cleanup.begin');
    captureNativeDiagnostics();
    workflowLifetime.abort();
    await coordinate?.catch(() => {});
    if (startup) await client.shutdown();
    else await registration.dispose();
    await startup?.dispose(); profile.mockRestore(); await runtime.dispose();
    recordFixturePhase('cleanup.end');
  };
  onTestFinished(dispose);
  recordFixturePhase('fixture_ready');
  return { machine, client, runtime, installation, pair, sources, context, apply, statePath, metadataWrites, rootLaunches, rootPlans, nativeCommands,
    machineSetupPlan: nativeDeps.machineSetupPlan, machineSetupApply: nativeDeps.machineSetupApply, machineSetupRemove: nativeDeps.machineSetupRemove,
    startInstalledRuntime, publicExecutor, createExecutor,
    controlHttpOrigin: () => startup ? `http://127.0.0.1:${startup.runtime.controlPort}` : null,
    setHomeRead: (read: NonNullable<typeof additionalHomeRead>) => { additionalHomeRead = read; },
    workflowDiagnostic: () => ({ ...workflowDiagnostic(), beforeCleanup }), captureNativeDiagnostics,
    recordNativePhase: recordFixturePhase,
    operations, receive, receiveRpc, nativeDeps, readHomeMachine, respondWorkflowStorage, readActionFailureDiagnostics,
    workflowStorage: () => workflowStorage,
    credentials, issuerCredentials, accountEncryptionMode: encryptionMode,
    readInstalled: async () => JSON.parse(await readFile(statePath, 'utf8')) as { installed: boolean; version: string | null; effects: string[] },
    dispose };
}
