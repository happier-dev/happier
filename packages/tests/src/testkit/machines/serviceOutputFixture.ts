import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { MachineReachabilityConfigureInputV1Schema, MachineReachabilityInspectInputV1Schema,
  MachineReachabilityInspectResultV1Schema, MachineServiceControlInputV1Schema,
  MachineServiceLogsReadInputV1Schema, MachineServicesListResultV1Schema,
  MachineServiceExecInputV1Schema, MachineServiceExecResultV1Schema, MachineServiceAdoptInputV1Schema,
  MachineRebootInputV1Schema, createEmptyMachineSetupDesiredV1,
  type ActionExecutorContext, type MachineMetadataFieldPortV1, type MachineMetadataFieldReadV1,
  type MachineReachabilityObservationV1 } from '@happier-dev/protocol';
import { createAdmittedPluginRuntimeFixture } from '../../../../../apps/cli/src/plugins/testkit/admittedRuntime';
import { createResolvedContributionRegistry } from '../../../../../apps/cli/src/plugins/projection/registry/createResolvedContributionRegistry';
import { pluginReloadController } from '../../../../../apps/cli/src/plugins/runtime/reload/singleton';
import { createMachineServicesRuntime } from '../../../../../apps/cli/src/daemon/local/services/launch/machineServices';
import { controlNativeServiceForHost } from '../../../../../apps/cli/src/daemon/local/services/launch/nativeServiceControl';
import { createMachineNativeEffectAdmission, machineNativeEffectAdmission } from '../../../../../apps/cli/src/daemon/local/services/launch/machineNativeEffectAdmission';
import { createMachineAdminAccessObserver } from '../../../../../apps/cli/src/machines/adminAccess/observeMachineAdminAccess';
import { createMachineAdminAccessHost } from '../../../../../apps/cli/src/machines/adminAccess/machineAdminAccessHost';
import { registerDaemonMachineAdminAccessRpcHandlers } from '../../../../../apps/cli/src/rpc/handlers/daemonMachineAdminAccess';
import { createHostActionOperationRuntime } from '../../../../../apps/cli/src/daemon/actionOperations/createHostActionOperationRuntime';
import { createDaemonAdmissionDrain } from '../../../../../apps/cli/src/daemon/lifecycle/admissionDrain';
import { createManagedActivityInventory } from '../../../../../apps/cli/src/daemon/lifecycle/managedActivity';
import { createMachineRebootAction } from '../../../../../apps/cli/src/daemon/lifecycle/machineReboot';
import { runMachineSetupEffectInternal } from '../../../../../apps/cli/src/machines/setup/effectInternal';
import type { MachineElevationSpawn } from '../../../../../apps/cli/src/machines/adminAccess/runElevatedEffect';
import { inspectMachineReachability, executeMachineReachabilityTransition,
  type MachineReachabilityHostDependencies } from '../../../../../apps/cli/src/machines/reachability/machineReachabilityHost';
import { projectMachineReachabilityObservation } from '../../../../../apps/cli/src/machines/reachability/readMachineReachability';
import { createNativeOutputRpcManager, invokeNativeOutput, nativeOutputTarget } from './nativeOutputFixture';
import { withFiniteComposeFixture } from '../../../../../apps/cli/src/daemon/local/services/launch/serviceExec.testkit';
import { produceEnvironmentProjectServices } from '../../../../../apps/cli/src/daemon/local/services/launch/projectDeclarations';
import { tryAcquireAuthoritativePluginRuntimeRegistryLease } from '../../../../../apps/cli/src/plugins/runtime/reload/runtimeLease';
import { createCliProjectAdmission } from '../../../../../apps/cli/src/session/actions/cliActionDeps/projectAdmission';
import { createCliMachineResourceActionDeps } from '../../../../../apps/cli/src/session/actions/cliActionDeps/machineResources';
import { createCliDeploymentActionDeps } from '../../../../../apps/cli/src/deployments/createCliDeploymentActionDeps';
import { prepareServiceAdoptionForHost } from '../../../../../apps/cli/src/deployments/serviceAdoptionForHost';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { DeploymentEnvironmentAccessInputV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import type { RpcActionExecutorContext } from '../../../../../apps/cli/src/rpc/handlers/_actionDispatchAdapter';

const target = nativeOutputTarget;
const inputTarget = { serverId: target.serverId, machineId: target.machineId };
const none = { version: 1, mode: 'none' } as const;
const posture = { revision: 0, management: { providers: [],
  publicSsh: { kind: 'open', port: 22, sourceCidrs: ['192.0.2.0/24'] } },
  defaultServiceIngress: { kind: 'none' } } as const;

type FiniteComposeFixture = Parameters<Parameters<typeof withFiniteComposeFixture>[0]>[0];

/** Keep the canonical finite Compose testkit alive between case input and execution. */
async function createFiniteExecOutputFixture() {
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  let ready!: (fixture: FiniteComposeFixture) => void;
  let fail!: (error: unknown) => void;
  const available = new Promise<FiniteComposeFixture>((resolve, reject) => { ready = resolve; fail = reject; });
  const lifetime = withFiniteComposeFixture(async fixture => { ready(fixture); await released; }, {
    machineId: target.machineId, installationId: target.installationId,
  });
  void lifetime.catch(fail);
  const fixture = await available;
  const cleanup: (() => Promise<void>)[] = [async () => { release(); await lifetime; }];
  const close = async () => {
    const failures: unknown[] = [];
    for (const dispose of cleanup.splice(0).reverse()) { try { await dispose(); } catch (error) { failures.push(error); } }
    if (failures.length) throw new AggregateError(failures, 'Finite Compose fixture cleanup failed');
  };
  try {
    const lease = tryAcquireAuthoritativePluginRuntimeRegistryLease();
    if (!lease) throw new Error('Finite Compose runtime is unavailable');
    cleanup.push(() => lease.release());
    const home = createServer((request, response) => {
      void (async () => {
        if (request.method !== 'POST' || request.url !== '/v1/deployments/environments/access'
          || request.headers.authorization !== `Bearer ${credentials.token}`) { response.writeHead(403).end(); return; }
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = DeploymentEnvironmentAccessInputV1Schema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        if (body.serverId !== target.serverId || body.environmentIds.length !== 1
          || body.environmentIds[0] !== fixture.source.environmentId) { response.writeHead(400).end(); return; }
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true,
          items: [{ environmentId: fixture.source.environmentId, read: true, deploy: true }] }));
      })().catch(() => { response.writeHead(500).end(); });
    });
    const credentials = { token: `fixture.${Buffer.from(JSON.stringify({ sub: target.custodianAccountId })).toString('base64url')}.signature`,
      encryption: null, credentialProvenance: 'stored_session' as const };
    cleanup.push(async () => {
      if (home.listening) await new Promise<void>((resolve, reject) => home.close(error => error ? reject(error) : resolve()));
    });
    const rendered = await fixture.project.render();
    const activated = await machineNativeEffectAdmission.run({ operation: { operationId: randomUUID(), kind: 'deploy' },
      keys: rendered.keys, settleNative: fixture.project.settleNative },
    context => fixture.project.activate({ render: rendered, context }));
    cleanup.push(() => activated.dispose());
    await fixture.source.commit();
    const handles = await produceEnvironmentProjectServices({ owner: lease.registry.projectManagedServices,
      serverId: target.serverId, release: fixture.source, specIdentity: 'output-finite-command',
      isCurrent: () => true, nativeEffects: { keys: rendered.keys, settleNative: fixture.project.settleNative },
      io: fixture.io, project: activated });
    cleanup.push(async () => { for (const mounted of handles) await mounted.dispose(); });
    const handle = handles[0];
    if (!handle) throw new Error('Finite Compose service was not mounted');
    home.listen(0, '127.0.0.1');
    await once(home, 'listening');
    const address = home.address();
    if (!address || typeof address === 'string') throw new Error('Home HTTP fixture did not bind');
    const serverHttpBaseUrl = `http://127.0.0.1:${address.port}`;
    const failure = (errorCode: string) => ({ ok: false as const, errorCode, error: errorCode });
    const admission = createCliProjectAdmission({ credentials, serverId: target.serverId,
      serverIdentityId: target.serverId, serverHttpBaseUrl }, {
      projectHomeId: target.serverId, actionHomeId: target.serverId, executionRunActionFailure: failure });
    const deployment = createCliDeploymentActionDeps({ serverHttpBaseUrl, admitAccount: admission.projectAccountAdmission,
      resolveRequestHeaders: async () => ({ Authorization: `Bearer ${credentials.token}` }),
      async dispatchReceipt() { throw new Error('Finite service Exec must not dispatch a Deployment'); } });
    const deps = createCliMachineResourceActionDeps({ credentials, token: credentials.token,
      serverIdentityId: target.serverId, serverHttpBaseUrl, isCredentialCurrent: async () => true,
      machineActionDirectTargetTransport: { machineId: target.machineId,
        async invoke() { throw new Error('Finite service Exec must remain on its native Machine'); } },
    }, { ...admission, projectHomeId: target.serverId, readEnvironmentAccess: deployment.readEnvironmentAccess,
      observeEnvironmentAccessChanges: deployment.observeEnvironmentAccessChanges,
      async callMachineAction() { throw new Error('Finite service Exec must remain on its native Machine'); },
      executionRunActionFailure: failure });
    const execute = deps.machineServiceExec;
    if (!execute) throw new Error('Machine service Exec producer is absent');
    const operations = createHostActionOperationRuntime({ serverId: target.serverId, machineId: target.machineId,
      custodyBinding: { serverId: target.serverId, installationId: target.installationId },
      resolveAccountId: async () => target.custodianAccountId });
    return {
      handle,
      input: { ...inputTarget, mode: 'exec' as const, argv: ['read-token'], target: {
        kind: 'current' as const, serviceId: handle.serviceId, expectedGeneration: handle.instanceId } },
      async invoke(value: unknown) {
        const input = MachineServiceExecInputV1Schema.parse(value);
        const result = await operations.observeExecution({ actionId: 'machines.services.exec', input, actionRequestId: randomUUID(),
          execute: async operation => {
            const context: RpcActionExecutorContext = { serverId: target.serverId, runtimeAccountId: target.custodianAccountId,
              authenticatedLocalRootCustody: { serverIdentityId: target.serverId, accountId: target.custodianAccountId,
                machineId: target.machineId, installationId: target.installationId },
              authority: 'present_user', signal: operation.signal, operationAcceptance: operation.operationAcceptance,
              operationOwnerUpdate: operation.operationOwnerUpdate };
            const raw = await execute({ input, approvalScope: { kind: 'environment', environmentId: fixture.source.environmentId },
              signal: operation.signal, context });
            const denied = ActionExecuteFailureSchema.safeParse(raw);
            return denied.success ? denied.data : { ok: true, result: MachineServiceExecResultV1Schema.parse(raw) };
          } });
        if (!result.ok) throw new Error(`Finite service Exec refused: ${result.errorCode}`);
        return result.result;
      },
      close,
    };
  } catch (error) { await close(); throw error; }
}

/** The actual installed Compose adapter captures a value-free adoption review;
 * only its Docker process and installation-identity read are substituted. */
async function createAdoptionOutputFixture(directory: string) {
  const composePath = join(directory, 'adopt-compose.json');
  const dockerPath = join(directory, 'docker');
  const model = { name: 'output-existing', services: { worker: { image: 'example/worker:1' } } };
  const containerId = 'a'.repeat(64);
  await writeFile(composePath, JSON.stringify(model));
  await writeFile(dockerPath, `#!${process.execPath}
const args=process.argv.slice(2),id=${JSON.stringify(containerId)};
if(args.includes('info'))process.stdout.write(args.includes('{{.ID}}')?'output-engine':JSON.stringify({ID:'output-engine',OSType:'linux',Architecture:'x86_64'}));
else if(args[0]==='ps')process.stdout.write(id);
else if(args[0]==='inspect')process.stdout.write(JSON.stringify([{Id:id,Image:'sha256:'+'b'.repeat(64),Config:{Labels:{'com.docker.compose.project':'output-existing','com.docker.compose.service':'worker','com.docker.compose.oneoff':'False','com.docker.compose.project.working_dir':${JSON.stringify(directory)},'com.docker.compose.project.config_files':${JSON.stringify(composePath)}}},State:{Status:'running'},Mounts:[],NetworkSettings:{Ports:{}}}]));
else if(args.includes('config'))process.stdout.write(JSON.stringify(args.includes('--variables')?{}:${JSON.stringify(model)}));
else process.exit(23);
`, { mode: 0o700 });
  const previousPath = process.env.PATH, previousNodeOptions = process.env.NODE_OPTIONS;
  process.env.PATH = `${directory}${delimiter}${previousPath ?? ''}`;
  process.env.NODE_OPTIONS = '';
  const restoreEnvironment = () => {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previousNodeOptions;
  };
  let plugins: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | undefined;
  try {
    plugins = await createAdmittedPluginRuntimeFixture({ happyHomeDir: join(directory, 'adopt-home'),
      runtimeOptions: { pluginIds: ['happier.machine.services'],
        // Native observation has no Account scope; never acquire ambient stored credentials.
        accountStorageDependencies: { readCredentials: async () => null } } });
    const watch = { v: 1 as const, watchId: 'output-adoption-watch', name: 'Existing Compose project',
      adapter: { pluginId: 'happier.machine.services', localId: 'compose' },
      nativeResourceId: JSON.stringify(['output-engine', 'output-existing']), lifecyclePurpose: 'deployment' as const };
    const selected = await plugins.registry.resolveProjectNativeAdapter(watch.adapter, 'nativeServiceLifecycle');
    if (selected.kind !== 'ready') throw new Error(`Installed Compose adapter is unavailable: ${selected.code}`);
    const captured = selected.lease.captureNativeServiceLifecycle(watch, { machine: inputTarget });
    if (captured.kind !== 'ready') throw new Error('Installed Compose observation is unavailable');
    const handle = await plugins.registry.projectManagedServices.superviseMachine({ ...inputTarget, watch,
      lifecycle: captured.lifecycle, isCurrent: () => selected.lease.isCurrent(), releaseObservation: captured.release,
      ...(captured.launchServiceExec ? { launchServiceExec: captured.launchServiceExec } : {}) });
    const runtime = plugins;
    let closed = false;
    return {
      input: { ...inputTarget, mode: 'review' as const, serviceId: handle.serviceId, expectedGeneration: handle.instanceId,
        requestKey: randomUUID(), profiles: [] },
      async invoke(value: unknown, context: ActionExecutorContext) {
        const input = MachineServiceAdoptInputV1Schema.parse(value);
        const preparation = await prepareServiceAdoptionForHost({ actionId: 'machines.services.adopt', input, context }, {
          ...inputTarget, acquirePluginRuntimeRegistryLease: () => runtime.controller.acquireRuntimeRegistry({
            resolveRuntimeRegistry: async () => runtime.registry }),
          readInstallation: async () => target.installationId,
          // These apply-only dependencies are unreachable in a review. Fail loudly if that contract changes.
          async prepareCreate() { throw new Error('Adoption review must not prepare an Environment mutation'); },
          async readEnvironment() { throw new Error('Adoption review must not open an Environment'); },
        });
        if ('errorCode' in preparation) throw new Error(`Adoption review refused: ${preparation.errorCode}`);
        if (!preparation.executeAdmittedAction) throw new Error('Adoption review has no continuation');
        const result = await preparation.executeAdmittedAction({ actionId: 'machines.services.adopt', input, context,
          async execute() { throw new Error('Adoption review owns its continuation without another executor'); } });
        if (!result.ok) throw new Error(`Adoption review execution refused: ${result.errorCode}`);
        return result.result;
      },
      async close() {
        if (closed) return;
        closed = true;
        try { try { await handle.dispose(); } finally { await runtime.dispose(); } } finally { restoreEnvironment(); }
      },
    };
  } catch (error) { try { await plugins?.dispose(); } finally { restoreEnvironment(); } throw error; }
}

/** Only the elevation process is substituted. The real root entry parses the
 * request and produces its CHECK result. Its unsupported OS has no native effects. */
const checkOnlySpawn: MachineElevationSpawn = invocation => {
  const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
  const lifetime = new AbortController();
  const settled = runMachineSetupEffectInternal(invocation.args.slice(invocation.args.indexOf('effect-internal') + 1), {
    stdin, stdout, signal: lifetime.signal, readUid: () => 0, platform: 'win32',
    runNative: async () => { throw new Error('Unsupported-OS CHECK must not execute a native command'); },
  }).then(code => { stdout.end(); stderr.end(); return { code, signal: null }; });
  return { stdin, stdout, stderr, settled, async terminate() { lifetime.abort(); stdin.end(); await settled; } };
};

export type ServiceOutputFixture = Awaited<ReturnType<typeof createServiceOutputFixture>>;

/** Real metadata, service projection, observation, lifecycle and operation
 * owners. Only native OS observations and the Home metadata transport are fake. */
export async function createServiceOutputFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'machines-output-services-'));
  const cleanup: (() => void | Promise<void>)[] = [() => rm(directory, { recursive: true, force: true })];
  try {
    const plugins = await createAdmittedPluginRuntimeFixture({ happyHomeDir: directory, controller: pluginReloadController,
      runtimeOptions: { pluginIds: [], contributes: createResolvedContributionRegistry({}) } });
    cleanup.push(() => plugins.dispose());
    const watch = { v: 1 as const, watchId: 'output-service-watch', name: 'Native observation',
      adapter: { pluginId: 'fixture.uninstalled-native', localId: 'service' }, nativeResourceId: 'fixture/worker',
      lifecyclePurpose: 'infrastructure' as const };
    let snapshot: MachineMetadataFieldReadV1 = { status: 'ready', metadataVersion: 1, metadata: {
      adminAccess: none, serviceWatchesV1: { v: 1, watches: [watch] },
      reachabilityPosture: posture, setup: createEmptyMachineSetupDesiredV1(),
    } };
    const port: MachineMetadataFieldPortV1 = {
      read: async () => snapshot,
      compareAndSwap: async request => {
        if (snapshot.status !== 'ready') return snapshot;
        if (request.expectedMetadataVersion !== snapshot.metadataVersion) return { ...snapshot, status: 'conflict' };
        snapshot = { status: 'ready', metadataVersion: snapshot.metadataVersion + 1, metadata: request.metadata };
        return { ...snapshot, status: 'applied' };
      },
    };
    const services = createMachineServicesRuntime({ target: inputTarget, readMetadata: () => snapshot, captureMetadataPort: () => port });
    cleanup.push(() => services.dispose());
    const operations = createHostActionOperationRuntime({ serverId: target.serverId, machineId: target.machineId,
      custodyBinding: { serverId: target.serverId, installationId: target.installationId },
      resolveAccountId: async () => target.custodianAccountId });
    const context = (): ActionExecutorContext => ({ surface: 'cli', authority: 'present_user',
      serverId: target.serverId, serverIdentityId: target.serverId, runtimeAccountId: target.custodianAccountId,
      actionRequestId: randomUUID(), signal: new AbortController().signal });
    const observer = createMachineAdminAccessObserver({ platform: 'linux',
      execFile: async (file, args) => {
        if (file === 'id') return { stdout: args[0] === '-u' ? '1001\n'
          : args[0] === '-un' ? 'fixture-daemon\n' : 'fixture-daemon\n' };
        if (file === 'sudo') return { stdout: '' };
        if (file === 'getent') return { stdout: 'fixture-daemon:x:1001:1001::/fixture:/usr/sbin/nologin\n' };
        if (file === 'passwd') return { stdout: 'fixture-daemon L 2026-01-01 0 99999 7 -1\n' };
        throw Object.assign(new Error('Native tool absent from fixture'), { code: 'ENOENT' });
      },
      fileSystem: {
        lstat: async () => { throw Object.assign(new Error('No sudoers drop-in in fixture'), { code: 'ENOENT' }); },
        readFile: async () => '',
      },
      onChanged: async () => {} });
    const elevation = { installationId: target.installationId, installedCli: join(directory, 'installed-happier'),
      readPolicy: async () => ({ version: 1, mode: 'preauthorized' } as const),
      observe: async () => (await observer.inspect()).observation, spawn: checkOnlySpawn };
    const adminHost = createMachineAdminAccessHost(elevation);
    const manager = createNativeOutputRpcManager();
    registerDaemonMachineAdminAccessRpcHandlers(manager, { target: () => target, observer,
      captureMetadataPort: () => port, reconcile: adminHost.reconcile, runActionOperation: operations.runActionOperation });

    const drain = createDaemonAdmissionDrain();
    drain.beginTemporaryDrain();
    const inventory = createManagedActivityInventory({ producers: [] });
    cleanup.push(() => inventory.dispose());
    const reboot = createMachineRebootAction({ routes: { target: () => target, admissionDrain: drain,
      inventory, nativeAdmission: createMachineNativeEffectAdmission(),
      vitals: { host: () => { throw new Error('Draining reboot must settle before native host inspection'); } },
      readServiceFacts: request => plugins.registry.projectManagedServices.readMachineRebootServices(request),
    }, operations, captureElevation: () => elevation });
    let observation: MachineReachabilityObservationV1 | undefined;
    const reachability = (actionContext: ActionExecutorContext): MachineReachabilityHostDependencies => ({
      target, port, context: actionContext, runtimeRegistry: plugins.registry, isCurrent: async () => true,
      agentIsolation: { read: () => ({ enabled: false, status: { kind: 'disabled' } }) },
      happyHomeDir: directory, elevation, nativeEffects: { userHomeDirectory: directory,
        hostEnvironment: {}, environmentIo: { run: async () => { throw new Error('Unchanged posture has no native effect'); } } },
      publish: async candidate => { observation = projectMachineReachabilityObservation(observation, candidate); return observation; },
    });
    const invoke = async (actionId: ActionId, input: unknown): Promise<unknown> => {
      if (actionId === 'machines.setup.adminAccess.inspect' || actionId === 'machines.setup.adminAccess.set')
        return invokeNativeOutput(manager, actionId, input);
      if (actionId === 'machines.reboot') return reboot({ input: MachineRebootInputV1Schema.parse(input),
        context: { ...context(), machineAdmission: { ...target, actorAccountId: target.custodianAccountId,
          role: 'manage', encryptionMode: 'plain' } } });
      if (actionId === 'machines.reachability.inspect')
        return inspectMachineReachability(MachineReachabilityInspectInputV1Schema.parse(input), reachability(context()));
      if (actionId === 'machines.reachability.configure') {
        const request = MachineReachabilityConfigureInputV1Schema.parse(input);
        return operations.observeExecution({ actionId, input: request, actionRequestId: randomUUID(),
          rpcContext: context(), execute: async operation => ({ ok: true, result:
            await executeMachineReachabilityTransition(request, reachability({ ...context(), ...operation })) }) })
          .then(result => { if (!result.ok) throw new Error(result.error); return result.result; });
      }
      if (actionId === 'machines.services.list' || actionId === 'machines.services.detail'
        || actionId === 'machines.services.discovery' || actionId === 'machines.services.watch' || actionId === 'machines.services.unwatch')
        return services.execute({ actionId, input: getActionSpec(actionId).inputSchema.parse(input), context: context() });
      throw new Error(`Service output fixture has no producer for ${actionId}`);
    };
    let finite: Promise<Awaited<ReturnType<typeof createFiniteExecOutputFixture>>> | undefined;
    let finiteControl: Promise<Awaited<ReturnType<typeof createFiniteExecOutputFixture>>> | undefined;
    let adoption: Promise<Awaited<ReturnType<typeof createAdoptionOutputFixture>>> | undefined;
    return { target: inputTarget, installationId: target.installationId, invoke, port, services,
      finite: () => finite ??= createFiniteExecOutputFixture().then(value => { cleanup.push(value.close); return value; }),
      finiteControl: () => finiteControl ??= createFiniteExecOutputFixture().then(value => { cleanup.push(value.close); return value; }),
      adoption: () => adoption ??= createAdoptionOutputFixture(directory).then(value => { cleanup.push(value.close); return value; }),
      async list() { return MachineServicesListResultV1Schema.parse(await invoke('machines.services.list', inputTarget)); },
      async reviewReachability() { return MachineReachabilityInspectResultV1Schema.parse(await invoke('machines.reachability.inspect', {
        ...inputTarget, change: { kind: 'posture', posture } })); },
      async nativeHandle() { return plugins.registry.projectManagedServices.superviseMachine({ ...inputTarget, watch,
        isCurrent: () => true, releaseObservation: async () => {},
        lifecycle: { inspect: async () => ({ phase: 'running', readiness: 'not_reported', endpoint: null }) } }); },
      context,
      close: async () => { for (const release of cleanup.splice(0).reverse()) await release(); },
    };
  } catch (error) { for (const release of cleanup.splice(0).reverse()) await release(); throw error; }
}

type ServiceCase = Readonly<{ input(fixture: ServiceOutputFixture): unknown | Promise<unknown>;
  execute?(fixture: ServiceOutputFixture, input: unknown): Promise<unknown> }>;
export const serviceOutputCases = new Map<ActionId, ServiceCase>([
  ['machines.services.list', { input: f => f.target }],
  ['machines.services.discovery', { input: f => f.target }],
  ['machines.services.detail', { input: f => ({ ...f.target, serviceId: 'output-service-watch' }) }],
  // Real discovery confirms an uninstalled native adapter has no such candidate.
  ['machines.services.watch', { input: f => ({ ...f.target, candidateId: JSON.stringify([
    'fixture.uninstalled-native', 'service', 'fixture/absent' ]), expectedRevision: 'not-discovered', lifecyclePurpose: 'infrastructure' }) }],
  ['machines.services.unwatch', { input: async f => {
    const list = await f.list();
    if (list.kind !== 'snapshot') throw new Error('Service watch projection is unavailable');
    const watch = list.services.find(service => service.watchId === 'output-service-watch');
    if (!watch?.watchRevision) throw new Error('Service watch revision is unavailable');
    return { ...f.target, watchId: watch.watchId, expectedRevision: watch.watchRevision };
  } }],
  // The real supervisor/log owner declares unsupported without a native log role.
  ['machines.services.logs.read', { input: f => ({ ...f.target, serviceId: 'output-service-watch' }), execute: async (f, input) => {
    MachineServiceLogsReadInputV1Schema.parse(input);
    return (await f.nativeHandle()).readLogs();
  } }],
  // Real mounted Compose control spends its admitted native coordinates against the Docker OS fixture.
  ['machines.services.control', { input: async f => { const finite = await f.finiteControl();
    return { ...f.target, serviceId: finite.handle.serviceId,
      expectedGeneration: finite.handle.instanceId, operation: 'restart' }; }, execute: async (f, input) => {
    const request = MachineServiceControlInputV1Schema.parse(input);
    const finite = await f.finiteControl();
    try { return await controlNativeServiceForHost({ handle: finite.handle, operation: request.operation,
      operationId: randomUUID(), context: f.context() }); } finally { await finite.close(); }
  } }],
  ['machines.services.exec', { input: async f => (await f.finite()).input,
    execute: async (f, input) => {
      const finite = await f.finite();
      try { return await finite.invoke(input); } finally { await finite.close(); }
    } }],
  ['machines.services.adopt', { input: async f => (await f.adoption()).input,
    execute: async (f, input) => {
      const adoption = await f.adoption();
      try { return await adoption.invoke(input, f.context()); } finally { await adoption.close(); }
    } }],
  ['machines.setup.adminAccess.inspect', { input: f => f.target }],
  // Desired none → none takes the real metadata mutation's no-effect branch.
  ['machines.setup.adminAccess.set', { input: async f => {
    const current = await f.port.read();
    if (current.status !== 'ready') throw new Error('Administrator metadata unavailable');
    return { ...f.target, expectedMetadataVersion: current.metadataVersion, expectedAdminAccess: none, adminAccess: none, comparison: 'field' };
  } }],
  // Real operation admission reaches the lifecycle owner's draining terminal branch.
  ['machines.reboot', { input: f => ({ ...f.target, expectedInstallationId: f.installationId }) }],
  ['machines.reachability.inspect', { input: f => ({ ...f.target, change: { kind: 'posture', posture } }) }],
  ['machines.reachability.configure', { input: async f => {
    const review = await f.reviewReachability();
    if (!review.plan) throw new Error('Reachability owner did not produce a reviewed plan');
    return { ...f.target, change: review.plan.basis.change,
      reviewedPlanDigest: review.plan.reviewedPlanDigest, reviewedPlanBasis: review.plan.basis };
  } }],
]);
