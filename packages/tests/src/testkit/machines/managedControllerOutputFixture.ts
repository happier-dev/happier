import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ApprovalRequestPublicSettlementSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { ACTION_OPERATION_RPC_METHODS_V2, ActionOperationGetV1ResponseSchema,
  type ManagedMachineBootstrapPromptV1 } from '@happier-dev/protocol/actions/operations/v1';
import { ManagedMachineActionIdV1Schema, ManagedMachineActionInputSchemasV1,
  ManagedMachineActionOutputSchemasV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ManagedMachineFullV1Schema, type ManagedMachineFullV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { ConnectedPurposeCatalogV1Schema } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { resolveHomeTargetFromDescriptor } from '@happier-dev/cli-common/homeTarget';
import { createAdmittedPluginRuntimeFixture } from '../../../../../apps/cli/src/plugins/testkit/admittedRuntime';
import { createManagedMachineAcquisitionDriver } from '../../../../../apps/cli/src/machines/managed/acquire';
import { createManagedProviderOperationAuthority } from '../../../../../apps/cli/src/daemon/connectedServices/purposeBindings/managedProviderOperationAuthority';
import { createConnectedAccountPurposeBindingOwner } from '../../../../../apps/cli/src/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createHostActionOperationRuntime } from '../../../../../apps/cli/src/daemon/actionOperations/createHostActionOperationRuntime';
import { createCliActionExecutorFromCredentials } from '../../../../../apps/cli/src/session/actions/createCliActionExecutorFromCredentials';
import type { ApiMachineClient } from '../../../../../apps/cli/src/api/apiMachine';
import { getLiveSystemTasksRunnerAdapter } from '../../../../../apps/cli/src/capabilities/systemTasks/liveSystemTasksRunner';
import { projectManagedMachineBootstrapPrompt } from '../../../../../apps/cli/src/machines/managed/enrollment';
import { limaAcquisitionResource, LIMA_PLUGIN_ID, LIMA_PROVISIONER_ID } from '../../../../plugins/machine-lima/src/machine/provider';
import { DEVCONTAINER_PLUGIN_ID, DEVCONTAINER_PROVISIONER_ID } from '../../../../plugins/devcontainer/src/machine/provider';
import { nativeOutputTarget } from './nativeOutputFixture';

const target = nativeOutputTarget;
const controller = { machineId: target.machineId, installationId: target.installationId };
const lima = { pluginId: LIMA_PLUGIN_ID, localId: LIMA_PROVISIONER_ID };
const container = { pluginId: DEVCONTAINER_PLUGIN_ID, localId: DEVCONTAINER_PROVISIONER_ID };

/** The real credential custody owner with an ephemeral settings persistence boundary.
 * These local provisioners declare no connected-account purposes. */
export function createLocalManagedOutputCredentialAuthority() {
  let catalog = ConnectedPurposeCatalogV1Schema.parse({ v: 1, bindings: [] });
  const unavailable = async (): Promise<never> => { throw new Error('Local provisioner unexpectedly requested an Account credential'); };
  return createManagedProviderOperationAuthority({ purposeBindingOwner: createConnectedAccountPurposeBindingOwner({
    store: { read: async () => catalog, update: async mutate => catalog = mutate(catalog), subscribe: () => ({ dispose() {} }) },
    selectTarget: unavailable, resolveTarget: unavailable, materializeAccount: unavailable,
    projectTargetAccounts: unavailable, assertTargetAccountMaterializable: unavailable,
  }) });
}

/** Real controller reconciliation and contributed Lima SDK Actions. The external
 * Home transport supplies retained admission facts; executable discovery and Lima
 * process observations are confined to this fixture's own directory. */
export async function createManagedControllerOutputFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'machines-output-managed-'));
  const tools = join(directory, 'tools');
  await mkdir(tools);
  const launch = { store: join(directory, 'lima'), image: 'https://example.test/ubuntu.img',
    arch: 'x86_64' as const, vmType: 'qemu' as const, cpus: 2, memoryGiB: 4, diskGiB: 20, mounts: [] };
  const resource = limaAcquisitionResource(launch, 'output-managed-inspect');
  const nativeRow = { name: resource.instance, dir: join(resource.store, resource.instance), status: 'Stopped',
    vmType: resource.vmType, arch: resource.arch, cpus: resource.cpus, memory: resource.memoryBytes, disk: resource.diskBytes,
    config: { images: [{ location: resource.image, arch: resource.arch }], mounts: [],
      ssh: { forwardAgent: false }, containerd: { user: false, system: false } } };
  await writeFile(join(tools, 'limactl'), `#!${process.execPath}
const args=process.argv.slice(2);
if(args[0]==='--version')process.stdout.write('limactl version 2.2.1');
else if(args[0]==='info')process.stdout.write(JSON.stringify({hostOS:'linux',hostArch:'x86_64',vmTypes:['qemu']}));
else if(args[0]==='list')process.stdout.write(JSON.stringify(${JSON.stringify(nativeRow)})+'\\n');
else process.exit(23);
`, { mode: 0o700 });
  await writeFile(join(tools, 'qemu-system-x86_64'), `#!${process.execPath}\nprocess.stdout.write('QEMU emulator version 9.2.0');\n`, { mode: 0o700 });
  const base = { homeId: target.serverId, custodianAccountId: target.custodianAccountId,
    controller, launch: { provider: lima, schemaVersion: 1, name: 'Contract guest', choices: launch },
    creationState: 'active', allocation: 'bound', desired: 'start', desiredWhen: 'now', intentRevision: 1,
    retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } as const;
  const inspected = ManagedMachineFullV1Schema.parse({ ...base, id: 'output-managed-inspect',
    resource: { contributionRef: lima, schemaVersion: 1, value: resource },
    enrolledMachineId: 'output-managed-enrolled', bootstrapInstalled: true });
  const terminal = ManagedMachineFullV1Schema.parse({ ...base, id: 'output-managed-terminal',
    allocation: 'confirmed-absent', creationState: 'canceled', desired: 'delete' });
  const digest = 'a'.repeat(64);
  const rebuildLaunch = { runtime: 'docker', configuration: { kind: 'image', image: 'example/guest:1' } };
  const rebuilt = ManagedMachineFullV1Schema.parse({ ...base, id: 'output-managed-rebuild', desired: 'rebuild',
    launch: { provider: container, schemaVersion: 1, name: 'Rebuilt guest', choices: rebuildLaunch },
    resource: { contributionRef: container, schemaVersion: 1, value: { ...rebuildLaunch,
      reviewedEffectDigest: digest, managedMachineId: 'output-managed-rebuild', containerId: 'b'.repeat(64),
      user: 'happier', workspaceRoot: '/workspace', storage: { kind: 'child', childPath: '/workspace' }, volumes: [] } } });
  let machine: ManagedMachineFullV1 = inspected;
  const home = createServer((request, response) => {
    void (async () => {
      if (request.method !== 'POST') { response.writeHead(404).end(); return; }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body: Record<string, unknown> = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      let output: unknown;
      switch (request.url) {
        case '/v1/machines/managed/controller/admit': output = { machine, replayed: true }; break;
        case '/v1/machines/managed/controller/admit-control': {
          const resizeProvisioner = body.action === 'machines.managed.resize'
            ? plugins?.registry.contributes.machineProvisioners?.find(candidate =>
              candidate.identity.pluginId === lima.pluginId && candidate.identity.localId === lima.localId)?.definition : undefined;
          output = { machine, replayed: true, ...(resizeProvisioner ? { resizeProvisioner } : {}) }; break;
        }
        case '/v1/machines/managed/controller/context': output = { machine, requestId: 'output-retained-creation',
          ...(body.includeNativeCredentialBindings ? { nativeCredentialBindings: [], nativeCredentialDesiredBindingKeys: [] } : {}) }; break;
        case '/v1/machines/managed/controller/current': output = { machine }; break;
        case '/v1/machines/managed/controller/submit-intent': output = { machine, submitted: false }; break;
        case '/v1/machines/managed/controller/report':
        case '/v1/machines/managed/controller/report-resize':
          // Retain the native observation actually computed by the SDK producer.
          machine = ManagedMachineFullV1Schema.parse({ ...machine, ...(body.observation ? { observation: body.observation } : {}) });
          output = { machine }; break;
        case '/v1/machines/managed/actions/get': output = machine; break;
        default: throw new Error(`Unexpected managed Home boundary: ${request.url}`);
      }
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(output));
    })().catch(error => response.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String(error) })));
  });
  home.listen(0, '127.0.0.1');
  await once(home, 'listening');
  const address = home.address();
  if (!address || typeof address === 'string') throw new Error('Managed Home boundary did not bind');
  const serverUrl = `http://127.0.0.1:${address.port}`;
  const credentials = { token: `fixture.${Buffer.from(JSON.stringify({ sub: target.custodianAccountId })).toString('base64url')}.signature`,
    encryption: null, credentialProvenance: 'stored_session' as const };
  const homeTarget = resolveHomeTargetFromDescriptor({ authority: 'trusted_enrollment', descriptor: { v: 1,
    homeServerIdentityId: target.serverId, canonicalServerUrl: serverUrl, revision: 1,
    endpoints: [{ kind: 'https', url: serverUrl }] } });
  let plugins: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | undefined;
  const operations = createHostActionOperationRuntime({ serverId: target.serverId, machineId: target.machineId,
    custodyBinding: { serverId: target.serverId, installationId: target.installationId },
    resolveAccountId: async () => target.custodianAccountId });
  let closed = false;
  async function invoke(actionId: ActionId, value: unknown): Promise<unknown> {
    const action = ManagedMachineActionIdV1Schema.parse(actionId);
    const input = ManagedMachineActionInputSchemasV1[action].parse(value);
    machine = action === 'machines.managed.acquire' || action === 'machines.managed.bootstrap.retry' ? terminal
      : action === 'machines.managed.rebuild' ? rebuilt : inspected;
    const previousPath = process.env.PATH, previousNodeOptions = process.env.NODE_OPTIONS;
    process.env.PATH = `${tools}${delimiter}${previousPath ?? ''}`;
    process.env.NODE_OPTIONS = '';
    try {
      plugins ??= await createAdmittedPluginRuntimeFixture({ happyHomeDir: join(directory, 'plugins'),
        runtimeOptions: { pluginIds: [LIMA_PLUGIN_ID, DEVCONTAINER_PLUGIN_ID],
          // Local native provisioners have no Account census or persisted credentials.
          accountStorageDependencies: { readCredentials: async () => null } } });
      const driver = createManagedMachineAcquisitionDriver({ token: credentials.token, credentials, serverUrl,
        homeId: target.serverId, controller, homeTarget, runtimeRegistry: plugins.registry,
        managedProviderOperationAuthority: createLocalManagedOutputCredentialAuthority() });
      const result = await operations.observeExecution({ actionId: action, input, actionRequestId: randomUUID(),
        execute: async operation => ({ ok: true, result: ManagedMachineActionOutputSchemasV1[action].parse(await driver.execute(action, input, {
          requestId: randomUUID(), signal: operation.signal,
          context: { surface: 'cli', authority: 'present_user', serverId: target.serverId,
            runtimeAccountId: target.custodianAccountId, signal: operation.signal,
            operationAcceptance: operation.operationAcceptance, operationOwnerUpdate: operation.operationOwnerUpdate },
        })) }) });
      if (!result.ok) throw new Error(`Managed output producer refused: ${result.errorCode}`);
      return result.result;
    } finally {
      if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
      if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previousNodeOptions;
    }
  }
  return { target: { serverId: target.serverId, machineId: target.machineId }, homeId: target.serverId,
    controller, launch, terminal, rebuilt, digest, invoke,
    async close() {
      if (closed) return; closed = true;
      try { await plugins?.dispose(); }
      finally {
        await new Promise<void>((resolve, reject) => home.close(error => error ? reject(error) : resolve()));
        await rm(directory, { recursive: true, force: true });
      }
    } };
}

export type ManagedControllerOutputFixture = Awaited<ReturnType<typeof createManagedControllerOutputFixture>>;
type ControllerCase = Readonly<{ input(fixture: ManagedControllerOutputFixture): unknown | Promise<unknown>;
  execute?(fixture: ManagedControllerOutputFixture, input: unknown): Promise<unknown> }>;
export const managedControllerOutputCases = new Map<ActionId, ControllerCase>([
  ['machines.provisioners.list', { input: f => ({ homeId: f.homeId, controller: f.controller }) }],
  ['machines.provisioners.check', { input: f => ({ homeId: f.homeId, controller: f.controller, contribution: lima }) }],
  ['machines.provisioners.options', { input: f => ({ homeId: f.homeId, controller: f.controller, contribution: lima, selectors: f.launch }) }],
  // Real reconciliation terminal branch: canceled/confirmed-absent admission replay.
  ['machines.managed.acquire', { input: f => ({ selection: { kind: 'one-off', homeId: f.homeId,
    controller: f.controller, launch: { provider: lima, schemaVersion: 1, name: 'Contract guest', choices: f.launch },
    retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false }, enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' } }) }],
  ['machines.managed.bootstrap.retry', { input: f => ({ homeId: f.homeId, managedId: f.terminal.id, expectedIntentRevision: f.terminal.intentRevision }) }],
  ['machines.managed.inspect', { input: f => ({ homeId: f.homeId, managedId: 'output-managed-inspect' }) }],
  // Real controller capability branch after retained credential context: no native source preparer.
  ['machines.managed.credentials.install', { input: f => ({ homeId: f.homeId, managedId: 'output-managed-inspect',
    sessionId: 'output-session', bindingKey: 'output-binding', expectedResourceRevision: 1,
    expectedSourceRevision: 'output-source', expectedProviderTicket: 'output-ticket' }) }],
  // Real Devcontainer intent owner: Home retains settlement of this same rebuild revision.
  ['machines.managed.rebuild', { input: f => ({ homeId: f.homeId, managedMachineId: f.rebuilt.id,
    expectedRevision: f.rebuilt.intentRevision, kind: 'rebuild', reviewedEffectDigest: f.digest }) }],
  ['machines.managed.retention.update', { input: f => ({ homeId: f.homeId, managedId: 'output-managed-inspect',
    expectedIntentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false }) }],
  ['machines.managed.controller.update', { input: f => ({ homeId: f.homeId, managedId: 'output-managed-inspect',
    expectedIntentRevision: 1, controller: f.controller, reviewedPendingEffects: true }) }],
  ['machines.managed.retire', { input: f => ({ homeId: f.homeId, managedId: 'output-managed-inspect',
    expectedIntentRevision: 1, manualResponsibility: true }) }],
  // The real Lima resize producer inspects the native guest and rejects disk
  // shrink as its declared unsupported result, without mutating a real VM.
  ['machines.managed.resize', { input: f => ({ homeId: f.homeId, managedId: 'output-managed-inspect',
    size: { diskBytes: (f.launch.diskGiB - 1) * 1024 ** 3 } }), execute: async (f, input) => {
      const output = await f.invoke('machines.managed.resize', input);
      const resize = ManagedMachineActionOutputSchemasV1['machines.managed.resize'].parse(output);
      if (resize.result.kind !== 'unsupported' || resize.result.dimension !== 'diskBytes'
        || resize.result.code !== 'lima_disk_shrink_unsupported') {
        throw new Error('Lima did not reach its native disk-shrink output producer');
      }
      return output;
    } }],
]);

type ManagedHomeOptions = Readonly<{ baseUrl: string; homeId: string; ownerToken: string; ownerAccountId: string;
  machineId: string; installationId: string;
  createOutputManagedMachine(input: { id: string; setupGuestId?: string; boundResource?: boolean }): Promise<{ managedId: string; intentRevision: number }> }>;

/** CLI Account adapter against the aggregate's real SQLite Home routes. */
export async function createManagedHomeOutputFixture(options: ManagedHomeOptions) {
  const credentials = { token: options.ownerToken, encryption: null, credentialProvenance: 'stored_session' as const };
  const executor = createCliActionExecutorFromCredentials({ credentials, readCredentials: async () => credentials,
    serverId: options.homeId, serverIdentityId: options.homeId, serverApiUrl: options.baseUrl });
  return { homeId: options.homeId, target: { serverId: options.homeId, machineId: options.machineId },
    seed: (id: string) => options.createOutputManagedMachine({ id: `${id}-${randomUUID()}`, boundResource: true }),
    async invoke(actionId: ActionId, input: unknown) {
      const action = ManagedMachineActionIdV1Schema.parse(actionId);
      const context = { surface: 'cli' as const, authority: 'present_user' as const, actionCaller: { kind: 'host' as const },
        serverId: options.homeId, serverIdentityId: options.homeId, runtimeAccountId: options.ownerAccountId };
      let execution = await executor.execute(action, ManagedMachineActionInputSchemasV1[action].parse(input),
        { ...context, actionRequestId: randomUUID() });
      const approval = execution.ok ? ActionApprovalRequestCreatedResultSchema.safeParse(execution.result) : null;
      if (approval?.success) {
        // Explicit fixture consent follows the same public CLI approval path as
        // the enrollment journey; only the settled producer output is inspected.
        const approved = await executor.execute('approval.request.decide', { artifactId: approval.data.artifactId, decision: 'approve' },
          { ...context, actionRequestId: randomUUID() });
        if (!approved.ok) throw new Error(`Managed Home approval refused: ${approved.errorCode}`);
        const read = await executor.execute('approval.request.get', { artifactId: approval.data.artifactId },
          { ...context, actionRequestId: randomUUID() });
        if (!read.ok) throw new Error(`Managed Home approval read refused: ${read.errorCode}`);
        const outputSchema = getActionSpec('approval.request.get').outputSchema;
        if (!outputSchema) throw new Error('Canonical approval read output schema missing');
        const stored = outputSchema.parse(read.result);
        if (!stored || typeof stored !== 'object' || !('request' in stored)) throw new Error('Managed Home approval settlement missing');
        const settlement = ApprovalRequestPublicSettlementSchema.parse(stored.request);
        execution = settlement.execution;
      }
      if (!execution.ok) throw new Error(`Managed Home Action refused: ${execution.errorCode}`);
      return ManagedMachineActionOutputSchemasV1[action].parse(execution.result);
    }, async close() {} };
}
export type ManagedHomeOutputFixture = Awaited<ReturnType<typeof createManagedHomeOutputFixture>>;
type HomeCase = Readonly<{ input(fixture: ManagedHomeOutputFixture): unknown | Promise<unknown>;
  execute?(fixture: ManagedHomeOutputFixture, input: unknown): Promise<unknown> }>;
export const managedHomeOutputCases = new Map<ActionId, HomeCase>([
  ['machines.managed.power.set', { input: async f => { const row = await f.seed('power');
    return { homeId: f.homeId, managedId: row.managedId, when: 'after-idle', intent: 'stop' }; } }],
  ['machines.managed.delete', { input: async f => { const row = await f.seed('delete');
    return { homeId: f.homeId, managedId: row.managedId, when: 'after-idle', intent: 'delete', reviewedDependencies: true }; } }],
]);

/** Simulate the native installer's trust question only. The installed receiver's
 * actual operation owner, task runner, prompt lifecycle and RPC respond producer
 * remain real; this prepares a response contract, not an acquisition journey. */
export async function createManagedBootstrapResponseOutputFixture(options: ManagedHomeOptions & Readonly<{
  receiver: ApiMachineClient;
}>) {
  const seeded = await options.createOutputManagedMachine({ id: `bootstrap-response-${randomUUID()}`,
    setupGuestId: options.machineId });
  const response = await fetch(`${options.baseUrl}/v1/machines/managed/actions/get`, { method: 'POST',
    headers: { Authorization: `Bearer ${options.ownerToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ homeId: options.homeId, managedId: seeded.managedId }) });
  if (!response.ok) throw new Error(`Bootstrap response fixture read failed: HTTP ${response.status}`);
  const machine = ManagedMachineFullV1Schema.parse(await response.json());
  const tasks = getLiveSystemTasksRunnerAdapter();
  let taskId: string | undefined;
  let operationId: string | undefined;
  let ready!: () => void;
  let failed!: (error: unknown) => void;
  const promptReady = new Promise<void>((resolve, reject) => { ready = resolve; failed = reject; });
  const execution = options.receiver.observeActionExecution({ actionId: 'machines.managed.bootstrap.retry',
    input: { homeId: options.homeId, managedId: machine.id, expectedIntentRevision: machine.intentRevision },
    actionRequestId: randomUUID(), onOperation: operation => { operationId = operation.operationId; },
    execute: async context => {
      if (!context.operationAcceptance) throw new Error('Bootstrap response fixture needs an admitted operation');
      const publish = (id: string, prompt: ManagedMachineBootstrapPromptV1 | null) =>
        context.operationOwnerUpdate.update({ domainRef: { kind: 'managedMachine', id: machine.id,
          controller: machine.controller, resource: machine.resource,
          bootstrapTask: { id, taskKind: 'remote.ssh.bootstrapMachine.v1', ...(prompt ? { prompt } : {}) } } });
      const task = await tasks.startAdmitted({ run: async native => {
        await native.prompt({ kind: 'ssh.trustHost', message: 'Trust the disposable native guest',
          data: { kind: 'ssh.trustHost', host: 'output-contract-host', fingerprint: 'SHA256:fixture',
            keyType: 'ssh-ed25519', existingFingerprint: null } });
        return { answered: true };
      } }, 'remote.ssh.bootstrapMachine.v1', {
        started: task => { taskId = task.taskId; publish(task.taskId, null); },
        prompt: (task, prompt) => {
          publish(task.taskId, prompt ? projectManagedMachineBootstrapPrompt(prompt) : null);
          if (prompt) ready();
        },
      });
      await tasks.wait(task);
      return { ok: true, result: { managedId: machine.id } };
    } });
  void execution.then(() => failed(new Error('Native installer settled before its prompt was answered')), failed);
  try {
    await promptReady;
    if (!operationId) throw new Error('Native installer operation did not publish its identity');
    const found = ActionOperationGetV1ResponseSchema.parse(await options.receiver.invokeLocalMachineAction(
      ACTION_OPERATION_RPC_METHODS_V2.get, { operationId }));
    if (found.kind !== 'found') throw new Error('Native installer operation could not be read');
    return { machine, operation: found.operation, async close() {
      if (taskId) { await tasks.cancel({ taskId }); await tasks.wait({ taskId }); }
      await execution;
    } };
  } catch (error) {
    if (taskId) { await tasks.cancel({ taskId }); await tasks.wait({ taskId }); }
    await execution.catch(() => {});
    throw error;
  }
}
