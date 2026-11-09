import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import {
  createEmptyMachineSetupDesiredV1, getMachineSetupDesiredV1,
  MachineSetupApplyInputV1Schema, MachineSetupPlanInputV1Schema, MachineSetupPlanResultV1Schema,
  MachineSetupRemoveInputV1Schema, MachineAdminAccessSetInputV1Schema,
  MachineServiceControlInputV1Schema, MachineServiceExecInputV1Schema, MachineRebootInputV1Schema,
  FeaturesResponseSchema,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { DaemonAgentInstallStartRequestSchema } from '@happier-dev/protocol/daemon/agent-install-jobs';
import { DaemonLocalServiceActionExecuteRequestV1Schema } from '@happier-dev/protocol/local/services/actions/v1';
import { MachinePublishedMetadataV1Schema } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import { encodePlainMachineStoredContent } from '@happier-dev/protocol/machines/machineStoredContent';
import { MachineOperationProtocolCapabilitiesV1Schema } from '@happier-dev/protocol/machines/operationProtocolCapabilitiesV1';
import { createInstalledFilesystemMachineFixture } from '@/daemon/testkit/installedFilesystemMachineFixture';
import { createInstalledMachineRpcDatabaseBoundary, createInstalledMachineRpcRelay } from '@/daemon/testkit/installedMachineRpcRelay.testkit';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { prepareMachineSetupPlanV1 } from '@/machines/setup/prepareMachineSetupPlan';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createLocalServiceActionRoutes } from '@/daemon/local/services/actions/routes';
import { createLocalServiceInventoryRegistry } from '@/daemon/local/services/inventory/registry';
import { createDaemonMachineAdminAccessRoutes } from '@/machines/adminAccess/createDaemonMachineAdminAccessRoutes';
import { createLocalServicesDaemonRuntimeActionExecutor } from '@/daemon/local/services/actions/runtimeActionExecutor';
import { createLocalServicesDaemonFeatureGate } from '@/daemon/local/services/featureGate';

const installedDatabase = vi.hoisted(() => ({ current: null as ReturnType<typeof createInstalledMachineRpcDatabaseBoundary> | null }));
// Home derives current access from persisted Machine and grant facts. Neither
// its admission decision nor the receiving handlers are substituted.
vi.mock('../../../server/sources/storage/db', () => ({
  db: {
    machine: {
      findFirst: (...args: Parameters<ReturnType<typeof createInstalledMachineRpcDatabaseBoundary>['db']['machine']['findFirst']>) => installedDatabase.current!.db.machine.findFirst(...args),
      findUnique: (...args: Parameters<ReturnType<typeof createInstalledMachineRpcDatabaseBoundary>['db']['machine']['findUnique']>) => installedDatabase.current!.db.machine.findUnique(...args),
      findMany: (...args: Parameters<ReturnType<typeof createInstalledMachineRpcDatabaseBoundary>['db']['machine']['findMany']>) => installedDatabase.current!.db.machine.findMany(...args),
    },
    $transaction: <T>(operation: (tx: ReturnType<typeof createInstalledMachineRpcDatabaseBoundary>['db']) => Promise<T>) => installedDatabase.current!.db.$transaction(operation),
  },
  getDbProviderFromEnv: () => 'postgres',
}));

afterEach(() => { installedDatabase.current = null; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('refuses Can-use Machine administration through real Home before installed effects', async () => {
  const f = await createInstalledFilesystemMachineFixture();
  const runtime = await createAdmittedPluginRuntimeFixture({ happyHomeDir: f.directory, controller: pluginReloadController,
    runtimeOptions: { contributes: createResolvedContributionRegistry({}), pluginIds: [] } });
  onTestFinished(() => runtime.dispose());
  const executorParams = { credentials: f.bootstrap.credentials, token: f.bootstrap.credentials.token,
    sessionId: '', mode: 'plain', ctx: null, serverId: f.serverId,
    serverIdentityId: f.homeServerIdentityId, serverHttpBaseUrl: f.serverHttpBaseUrl,
    machineActionDirectTargetTransport: { machineId: f.machineId,
      invoke: (method, request, options) => f.machine.invokeLocalMachineAction(method, request, options) },
  } satisfies Parameters<typeof createCliActionExecutor>[0];
  const executor = createCliActionExecutor(executorParams);
  f.machine.setRPCHandlers({ spawnSession: async () => { throw new Error('No Session spawn expected'); },
    stopSession: async () => true, requestShutdown() {} }, { externalActionIngressOwner: {
      currentServerId: f.serverId, executor, resolveTarget: async () => ({ kind: 'machine', machineId: f.machineId }),
    } });
  const serviceActions = createLocalServiceActionRoutes({ machineId: f.machineId,
    inventoryRegistry: createLocalServiceInventoryRegistry(), projectManagedServices: runtime.registry.projectManagedServices });
  // The authenticated server feature snapshot is the boundary; the feature
  // decision and receiving native service dispatcher remain the real owners.
  const serviceGate = createLocalServicesDaemonFeatureGate({ env: {}, resolveServerFeaturesSnapshot: () => ({
    status: 'ready', features: FeaturesResponseSchema.parse({ features: { localServices: {
      enabled: true, actions: { enabled: true }, managed: { enabled: true },
    } } }),
  }) });
  await serviceGate.refresh();
  f.machine.registerLocalServicesRoutes({ machineId: f.machineId, serverId: f.serverId, accountId: 'requester',
    projectManagedServices: runtime.registry.projectManagedServices,
    localServicesActions: serviceActions,
    resolveLauncherActionExecutor: ({ ingress }) => createCliActionExecutor({ ...executorParams,
      runtimeActionExecute: createLocalServicesDaemonRuntimeActionExecutor({ featureGate: serviceGate, ingress,
        routes: { actionRoutes: serviceActions } }),
    }) });
  f.machine.registerMachineAdminAccessRoutes(createDaemonMachineAdminAccessRoutes({
    target: () => ({ serverId: f.serverId, machineId: f.machineId, installationId: f.installation.installationId,
      custodianAccountId: 'requester' }), getMachineClient: () => f.machine,
  }));
  installedDatabase.current = createInstalledMachineRpcDatabaseBoundary({ machineId: f.machineId,
    ownerAccountId: 'requester', installation: f.installation,
    members: [{ accountId: 'member-use', accessLevel: 'view' }, { accountId: 'member-manage', accessLevel: 'admin' }] });
  installedDatabase.current.machine.metadata = encodePlainMachineStoredContent(MachinePublishedMetadataV1Schema.parse({
    host: 'manage-access-host', platform: 'linux', happyCliVersion: 'test', homeDir: '/home/fixture', happyHomeDir: '/home/fixture/.happier',
  }));
  // The installed receiver enforces requester execution custody. Advertise that
  // current ingress support so an old-daemon refusal cannot mask a missing role
  // floor. This does not claim native identities or setup are effective.
  Object.assign(installedDatabase.current.machine, { operationProtocolCapabilities: MachineOperationProtocolCapabilitiesV1Schema.parse({
    requesterExecutionIsolation: { protocolVersions: [1] },
  }), operationProtocolCapabilitiesRevision: 1 });

  const target = { homeId: f.homeServerIdentityId, machineId: f.machineId };
  const currentSetup = createEmptyMachineSetupDesiredV1();
  const planInput = MachineSetupPlanInputV1Schema.parse({ ...target, mode: 'effects', sources: currentSetup.sources });
  // Produce the reviewed Apply operands through the same Plan owner as setup
  // callers; no scalar legacy Apply or hand-authored effect digest is used.
  const current = await getMachineSetupDesiredV1({ read: async () => ({ status: 'ready', metadataVersion: 0,
    metadata: { setup: currentSetup } }), compareAndSwap: async () => { throw new Error('Plan cannot publish'); } });
  const plan = MachineSetupPlanResultV1Schema.parse(await prepareMachineSetupPlanV1({ input: planInput, current }));
  const apply = MachineSetupApplyInputV1Schema.parse({ ...target, targets: [{ ...target,
    sources: plan.sources, desiredRevision: plan.desiredRevision, recipePlans: plan.recipePlans ?? [],
    exclusions: plan.exclusions, removalPlans: plan.removalPlans ?? [] }] });
  const remove = MachineSetupRemoveInputV1Schema.parse({ ...target, sources: plan.sources,
    desiredRevision: plan.desiredRevision, removeItemKeys: [], removalPlans: [] });
  const machine = { serverId: f.serverId, machineId: f.machineId };
  const legacyControl = DaemonLocalServiceActionExecuteRequestV1Schema.parse({ requestId: 'manage-access-control',
    target: { kind: 'managed_service', machineId: f.machineId, managedServiceId: 'missing-managed-service' }, action: 'stop_managed' });
  const requests: Readonly<{ name: string; method: string; request: unknown }>[] = [
    { name: 'raw Machine shell argv', method: RPC_METHODS.BASH, request: { argv: [process.execPath, '-e', ''], cwd: f.directory } },
    { name: 'raw Machine shell script', method: RPC_METHODS.BASH, request: { command: 'echo manage-access-fixture', cwd: f.directory } },
    { name: 'Machine setup Plan', method: RPC_METHODS.MACHINE_SETUP_PLAN, request: planInput },
    { name: 'Machine setup Apply', method: 'machines.setup.apply', request: apply },
    { name: 'Machine setup Remove', method: RPC_METHODS.MACHINE_SETUP_REMOVE, request: remove },
    { name: 'configured Agent install', method: RPC_METHODS.DAEMON_AGENTS_INSTALL_START,
      request: DaemonAgentInstallStartRequestSchema.parse({ agentId: 'unavailable-agent', definitionId: 'unavailable-definition',
        expectedDefinitionVersion: '1', intent: 'install', consent: { vendorRecipe: true } }) },
    { name: 'semantic service Exec', method: RPC_METHODS.MACHINES_SERVICE_EXEC,
      request: MachineServiceExecInputV1Schema.parse({ ...machine, mode: 'exec', argv: ['manage-access-no-effect'],
        target: { kind: 'current', serviceId: 'missing-service', expectedGeneration: 'missing-generation' } }) },
    { name: 'semantic service control', method: RPC_METHODS.MACHINES_SERVICE_CONTROL,
      request: MachineServiceControlInputV1Schema.parse({ ...machine, serviceId: 'missing-service',
        expectedGeneration: 'missing-generation', operation: 'stop' }) },
    { name: 'raw aggregate service control', method: RPC_METHODS.DAEMON_LOCAL_SERVICES_ACTIONS_EXECUTE, request: legacyControl },
    { name: 'Machine reboot', method: RPC_METHODS.MACHINES_REBOOT,
      request: MachineRebootInputV1Schema.parse({ ...machine, expectedInstallationId: f.installation.installationId }) },
    { name: 'administrator elevation policy', method: RPC_METHODS.MACHINE_ADMIN_ACCESS_SET,
      request: MachineAdminAccessSetInputV1Schema.parse({ ...machine, expectedMetadataVersion: 0,
        expectedAdminAccess: { version: 1, mode: 'none' }, adminAccess: { version: 1, mode: 'none' }, comparison: 'field' }) },
  ];
  const relay = await createInstalledMachineRpcRelay({ manager: f.rpcHandlerManager, machineId: f.machineId,
    transportOwnerAccountId: 'requester', ui: { installation: f.installation },
    methods: [...requests.map(request => request.method), RPC_METHODS.MACHINES_AGENT_ISOLATION_STATUS] });
  // Keep one legitimate member read on this exact Home/grant fixture, so a
  // blanket authentication or publication failure cannot pass every denial.
  expect(await relay.invokeUi(RPC_METHODS.MACHINES_AGENT_ISOLATION_STATUS, machine, { actorAccountId: 'member-use' }))
    .toEqual({ protection: 'unavailable', status: { kind: 'unavailable', code: 'metadata_unavailable' } });
  for (const { name, method, request } of requests) {
    expect.soft(await relay.invokeUiRaw(method, request, { actorAccountId: 'member-use' }), name)
      .toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN });
  }
});
