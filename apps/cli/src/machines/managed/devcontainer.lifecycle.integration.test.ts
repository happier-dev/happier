import axios from 'axios';
import tweetnacl from 'tweetnacl';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { definePlugin } from '@happier-dev/plugin-sdk';
import type { ExecService, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import { DEVCONTAINER_PLUGIN } from '@happier-dev/plugins-devcontainer';
import { defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';
import { defineMachineProvisionerSchemas, MachineProvisionerBootstrapCarrierV1Schema,
  MachineProvisionerCheckResultV1Schema, MachineProvisionerObservationV1Schema, MachineProvisionerPowerResultV1Schema,
  MachineProvisionerNativeExecResultV1Schema, MachineProvisionerPutFileResultV1Schema,
  MachineProvisionerOptionsResultV1Schema } from '@happier-dev/plugin-sdk/machine-provisioners';
import { resolveHomeTargetFromDescriptor } from '@happier-dev/cli-common/homeTarget';
import { SystemTaskExecutionError } from '@happier-dev/cli-common/systemTasks';
import { fetchGitHubReleaseByTag } from '@happier-dev/release-runtime/github';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { deriveManagedDevcontainerChildProjectionV1 } from '@happier-dev/protocol/machines/managed/devcontainerV1';
import { ManagedAdmissionInputV1Schema, ManagedEnrollmentCorrelationV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { AcquireResultV1Schema } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import { signMachineInstallationProof, verifyMachineInstallationProof, MachineInstallationProofV1Schema } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { ApiClient } from '@/api/api';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { activateContributionModule } from '@/plugins/runtime/lifecycle/activation/activateContributionModule';
import { createManagedPluginSourceCustody } from '@/plugins/runtime/lifecycle/contributions/runtimeIdentity.testkit';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import type { ResolvedActionContribution } from '@/plugins/projection/registry/types';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createTargetActionInvocationRegistry } from '@/plugins/runtime/invocation/targetActionRegistry';
import { createTargetActionHostBindingResolver } from '@/plugins/runtime/hostAccess/resolve';
import { resolveManifestHostAccessRequests } from '@/plugins/runtime/hostAccess/manifestRequests';
import { addExecServiceBinding, createLoggerAvailablePluginInvocationServiceBinding,
  createPluginInvocationServicesFactory, createUnavailablePluginServicesFactory } from '@/plugins/runtime/invocation/services/factory';
import { createUnavailableManagedServices } from '@/plugins/runtime/invocation/services/managedServicesAdapter';
import { createManagedServicesOwner } from '@/plugins/runtime/invocation/services/managedServicesOwner';
import { createManagedServiceProcessSupervisorHost } from '@/plugins/runtime/invocation/services/managedProcessSupervisor';
import { executeContributedAction } from '@/plugins/runtime/invocation/actions/executeContributedAction';
import { createManagedProviderOperationAuthority } from '@/daemon/connectedServices/purposeBindings/managedProviderOperationAuthority';
import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createConnectedAccountRequestAuthSubjectRegistry } from '@/daemon/connectedServices/requestAuth/ConnectedAccountRequestAuthSubjectRegistry';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createManagedMachineAcquisitionDriver, createManagedMachineControllerClient } from './acquire';
import { createManagedNativeInvocation } from './reconcile';
import { runManagedMachineEnrollment } from './enrollment';

const homeId = 'srv_public_child_lifecycle';
const origin = 'https://managed-child.example.test';
const controller = { machineId: 'physical-controller', installationId: 'physical-installation' };
const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
const descriptor = { v: 1 as const, homeServerIdentityId: homeId, canonicalServerUrl: origin, revision: 1,
  endpoints: [{ kind: 'https' as const, url: origin }] };
const target = resolveHomeTargetFromDescriptor({ descriptor, authority: 'trusted_enrollment' });
const nativeSchema = defineProtocolObject({ name: defineProtocolString({ minLength: 1 }) }, { policy: 'closed' });
const schemas = defineMachineProvisionerSchemas({ launch: nativeSchema, resource: nativeSchema });
const pluginId = 'examples.child-lifecycle';
const contributionRef = { pluginId, localId: 'child' };
function resource(name: string) {
  return { contributionRef, schemaVersion: 1, value: { name }, devcontainerObservation: {
    nativeResourceId: name, user: 'custom-user', workspaceFolder: '/work/custom',
    storage: { kind: 'bind' as const, hostPath: '/host/project', childPath: '/work/custom' },
  } };
}

/** An external author's native resource simulator. Host admission, catalog,
 * activation, dispatch, correlation and ordinary Machine registration stay real. */
async function lifecycleFixture(root: string, onTestFinished: (cleanup: () => void | Promise<void>) => void,
  firstPartyNativeRun?: ExecService['run']) {
  const effects: string[] = [];
  const pluginId = firstPartyNativeRun ? DEVCONTAINER_PLUGIN.manifest.id : 'examples.child-lifecycle';
  const contributionRef = { pluginId, localId: firstPartyNativeRun ? 'devcontainer' : 'child' };
  const author = firstPartyNativeRun ? DEVCONTAINER_PLUGIN : definePlugin({ id: pluginId, version: '1.0.0',
    machineProvisioners: { child: { title: 'Child', icon: 'machine', resourceKind: 'devcontainer', schemaVersion: 1,
      launchSchema: nativeSchema.jsonSchema, resourceSchema: nativeSchema.jsonSchema, platforms: ['linux'], prerequisites: [],
      billing: { location: 'local', stoppedBilling: 'not-billed' }, retention: { supportedIntents: ['rebuild'] },
      actions: { check: 'check', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', rebuild: 'rebuild', destroy: 'destroy' },
      bootstrapTransport: { kind: 'native', exec: 'exec', putFile: 'put-file' } } },
    actions: {
      check: { title: 'Check', surfaces: ['plugin'], dangerLevel: 'safe', execution: { target: 'daemon' },
        inputSchema: schemas.checkInput, resultSchema: MachineProvisionerCheckResultV1Schema, run: async () => ({ available: true }) },
      acquire: { title: 'Acquire', surfaces: ['plugin'], dangerLevel: 'safe', execution: { target: 'daemon' },
        inputSchema: schemas.acquireInput, resultSchema: schemas.acquireResult,
        run: async input => { effects.push('acquire'); return { kind: 'bound', resource: resource(input.launch.name) }; } },
      bootstrap: { title: 'Bootstrap', surfaces: ['plugin'], dangerLevel: 'safe', execution: { target: 'daemon' },
        inputSchema: schemas.bootstrapInput, resultSchema: MachineProvisionerBootstrapCarrierV1Schema,
        run: async () => ({ kind: 'native', transport: { contributionRef, schemaVersion: 1 } }) },
      inspect: { title: 'Inspect', surfaces: ['plugin'], dangerLevel: 'safe', execution: { target: 'daemon' },
        inputSchema: schemas.resourceInput, resultSchema: MachineProvisionerObservationV1Schema,
        run: async () => ({ observedAt: 1, availability: 'present', power: 'running' }) },
      rebuild: { title: 'Rebuild', surfaces: ['plugin'], dangerLevel: 'safe', execution: { target: 'daemon' },
        inputSchema: schemas.rebuildInput, resultSchema: schemas.rebuildResult,
        run: async input => { effects.push('rebuild'); return { kind: 'bound', resource: resource(`${input.resource.name}-replacement`) }; } },
      destroy: { title: 'Destroy', surfaces: ['plugin'], dangerLevel: 'safe', execution: { target: 'daemon' },
        inputSchema: schemas.resourceInput, resultSchema: MachineProvisionerPowerResultV1Schema,
        run: async () => ({ kind: 'confirmed' }) },
      exec: { title: 'Native exec', surfaces: ['plugin'], dangerLevel: 'safe', execution: { target: 'daemon' },
        inputSchema: schemas.execInput, resultSchema: MachineProvisionerNativeExecResultV1Schema,
        run: async () => { throw new Error('Default fixture must stop before native installation'); } },
      'put-file': { title: 'Native file', surfaces: ['plugin'], dangerLevel: 'safe', execution: { target: 'daemon' },
        inputSchema: schemas.putFileInput, resultSchema: MachineProvisionerPutFileResultV1Schema,
        run: async () => { throw new Error('Default fixture must stop before payload delivery'); } },
    },
  });
  const manifest = normalizePluginManifestV2(author.manifest);
  const occurrenceId = createPluginRuntimeOccurrenceId(pluginId);
  const activated = await activateContributionModule({ pluginId, occurrenceId, manifest, moduleNamespace: author,
    isOccurrenceCurrent: () => true });
  onTestFinished(() => activated.dispose());
  expect(activated.status).toBe('active');
  const registrations = activated.registrations.flatMap(registration => {
    if (registration.family !== 'actions') return [];
    const action = manifest.contributes.actions.find(action => action.id === registration.localId)!;
    return [{ pluginId, pluginVersion: manifest.version, occurrenceId, sourceCustody: createManagedPluginSourceCustody('child-lifecycle'),
      localId: registration.localId, definition: { ...action,
        hostAccessRequests: resolveManifestHostAccessRequests({ manifest, pluginId,
          contribution: { family: 'actions', localId: registration.localId }, ...(action.hostAccess ? { requestIds: action.hostAccess } : {}) }),
      }, handler: registration.value }];
  });
  const unavailableManaged = createUnavailableManagedServices();
  const managedServices = firstPartyNativeRun ? createManagedServicesOwner({
    processSupervisorHost: createManagedServiceProcessSupervisorHost({}),
    resolveScope: seed => seed,
    // Installed native tool availability is the external OS boundary. Service
    // scope, binding, currentness and supervision remain with the real owner.
    dependencies: { ...unavailableManaged.dependencies, status: async id => {
      expect(manifest.contributes.managedDependencies.some(dependency => dependency.id === id)).toBe(true);
      return { state: 'ready', id, version: '1.0.0', sourceId: 'system',
        executable: { kind: 'managedDependency', id: { pluginId, localId: id } } };
    } },
  }) : undefined;
  if (managedServices) onTestFinished(() => managedServices.dispose());
  const invocationServices = firstPartyNativeRun
    ? createPluginInvocationServicesFactory({ loggerSink: { write() {} }, managedServices,
      exec: {
        // The fixture's run port below supplies native process IO. No other
        // process operation may escape into the test host's installed tools.
        resolveExecutable: async () => { throw new Error('Unexpected native executable resolution outside the run boundary'); },
        resolvePath: async () => { throw new Error('Unexpected native path resolution outside the run boundary'); },
      },
    }) : createUnavailablePluginServicesFactory();
  const invocations = createTargetActionInvocationRegistry({ actions: registrations, readCurrentPluginOccurrenceId: () => occurrenceId,
    resolveAuthorizationFacts: () => ({ generation: { targetGeneration: occurrenceId, desiredGeneration: occurrenceId, appliedGeneration: occurrenceId },
      resourceSelections: [], scopedGrants: [], operatingSystemAuthorization: [] }),
    resolveHostBinding: createTargetActionHostBindingResolver(firstPartyNativeRun ? {
      createServiceBinding: (occurrence, id, requests) => addExecServiceBinding(
        createLoggerAvailablePluginInvocationServiceBinding(occurrence, id), requests ?? [], true),
    } : undefined),
    createServices(seed, binding) {
      const services = invocationServices(seed, binding);
      if (!firstPartyNativeRun) return services;
      // Only installed-tool availability and native process IO are simulated;
      // the actual public author, HostAccess policy and custody dispatcher run.
      return { ...services, exec: { ...services.exec, run: firstPartyNativeRun } };
    } });
  onTestFinished(() => invocations.dispose());
  const contributes = createResolvedContributionRegistry({ occurrenceIdsByPluginId: { [pluginId]: occurrenceId },
    activationTargets: [{ pluginId, manifest, provenance: 'external', source: { kind: 'path' }, manifestPath: join(root, 'plugin.json'),
      daemonEntryPath: null, sourceSpec: { kind: 'path', path: root } }],
    machineProvisioners: manifest.contributes.machineProvisioners.map(definition => ({ pluginId, identity: { pluginId, localId: definition.id }, definition })),
    actions: manifest.contributes.actions.map((action): ResolvedActionContribution => ({ pluginId, provenance: 'external', source: { kind: 'path' },
      definition: { id: action.id, title: action.id, description: null, kindVersion: 1, placements: [], slash: null, bindings: null, examples: null,
        surfaces: { plugin: action.surfaces.includes('plugin'), cli: action.surfaces.includes('cli'), ui: false, voice: false, agent: false, mcp: false, rpc: false, api: false },
        inputHints: null, inputSchema: action.inputSchema, execution: { target: 'daemon' }, safety: 'safe', dangerLevel: action.dangerLevel } })),
  });
  // The genuinely activated external module replaces only filesystem module loading.
  const runtimeRegistry = { contributes, targetActionInvocations: invocations, readPluginOccurrenceId: () => occurrenceId } as unknown as ResolvedExecutablePluginRuntimeRegistry;
  const unavailable = async (): Promise<never> => { throw new Error('This native fixture consumes no upstream Account credential'); };
  const authority = createManagedProviderOperationAuthority({ materializationBaseDir: root,
    purposeBindingOwner: createConnectedAccountPurposeBindingOwner({ store: { read: async () => ({ v: 1, bindings: [] }), update: unavailable },
      selectTarget: unavailable, resolveTarget: unavailable, materializeAccount: unavailable,
      projectTargetAccounts: unavailable, assertTargetAccountMaterializable: unavailable }),
    requestAuthRegistry: createConnectedAccountRequestAuthSubjectRegistry(), resolveRequestAuthHttpPort: () => 43123,
    createRedactionLease: () => ({ add() {}, close() {} }) });
  const input = { token, serverUrl: origin, homeId, controller, runtimeRegistry, credentials: { token, encryption: null },
    managedProviderOperationAuthority: authority, homeTarget: target };
  let row = ManagedMachineV1Schema.parse({ id: 'retained-child', homeId, custodianAccountId: 'owner', controller,
    launch: { provider: contributionRef, schemaVersion: 1, name: 'Child', choices: { name: 'native-original' } },
    allocation: 'unsubmitted', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 1,
    retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
  const requests: string[] = [];
  const approvals: unknown[] = [];
  let stopBeforeEnrollment: AbortController | undefined;
  const post = vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
    const path = new URL(String(url)).pathname;
    requests.push(path);
    if (path === '/v1/auth/response') {
      approvals.push(body);
      return { status: 200, data: {} };
    }
    if (path === '/v1/machines') {
      // HTTP request body is the genuine process boundary; fields below are
      // produced by the unchanged ordinary ApiClient serializer.
      const registration = body as { id: string; metadata: string; installationId: string; installationPublicKey: string;
        installationProof: unknown; managedEnrollment: unknown };
      expect(registration.managedEnrollment).toMatchObject({ managedId: row.id, expectedIntentRevision: row.intentRevision, resource: row.resource });
      expect(registration.installationId).not.toBe(controller.installationId);
      expect(verifyMachineInstallationProof({ payload: { version: 1, machineId: registration.id,
        installationId: registration.installationId, accountId: 'owner' }, publicKey: registration.installationPublicKey,
        proof: MachineInstallationProofV1Schema.parse(registration.installationProof) })).toBe(true);
      row = ManagedMachineV1Schema.parse({ ...row, enrolledMachineId: registration.id });
      return { status: 200, data: { machine: { id: registration.id, metadata: registration.metadata, metadataVersion: 1,
        daemonState: null, daemonStateVersion: 0, storageMode: 'plain', dataEncryptionKey: null,
        devcontainerChild: deriveManagedDevcontainerChildProjectionV1({ managedMachineId: row.id, controllerMachineId: row.controller.machineId,
          enrolledMachineId: row.enrolledMachineId, resource: row.resource }) ?? null } } };
    }
    if (path.endsWith('/admit')) {
      const admission = ManagedAdmissionInputV1Schema.parse(body);
      if (admission.input.selection.kind !== 'one-off') throw new Error('This boundary accepts only the reviewed one-off selection');
      row = ManagedMachineV1Schema.parse({ ...row, launch: admission.input.selection.launch });
      return { status: 200, data: { machine: row, replayed: false } };
    }
    if (path.endsWith('/context')) return { status: 200, data: { machine: row, requestId: 'approved-create' } };
    if (path.endsWith('/admit-control')) {
      row = ManagedMachineV1Schema.parse({ ...row, desired: 'rebuild', intentRevision: row.intentRevision + 1 });
      return { status: 200, data: { machine: row, replayed: false } };
    }
    if (path.endsWith('/submit')) { row = ManagedMachineV1Schema.parse({ ...row, allocation: 'may-exist' }); return { status: 200, data: { machine: row, submitted: true } }; }
    if (path.endsWith('/submit-intent')) {
      row = ManagedMachineV1Schema.parse({ ...row, submittedNativeEffect: { intentRevision: row.intentRevision,
        requestId: 'reviewed-rebuild', intent: 'rebuild', controller } });
      return { status: 200, data: { machine: row, submitted: true } };
    }
    if (path.endsWith('/report') || path.endsWith('/report-intent')) {
      const result = AcquireResultV1Schema.safeParse(body && typeof body === 'object' && 'result' in body ? body.result : undefined);
      if (result.success && result.data.kind === 'bound') row = ManagedMachineV1Schema.parse({ ...row, allocation: 'bound',
        resource: result.data.resource, ...(path.endsWith('/report-intent') ? { enrolledMachineId: undefined, submittedNativeEffect: undefined } : {}) });
    }
    if (path.endsWith('/enrollment-context')) stopBeforeEnrollment?.abort();
    return { status: 200, data: { machine: row } };
  });
  const get = vi.spyOn(axios, 'get').mockImplementation(async url => {
    if (String(url).endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
    throw new axios.AxiosError('not found', undefined, undefined, undefined, { status: 404, statusText: 'Not Found',
      data: {}, headers: {}, config: { headers: new axios.AxiosHeaders() } });
  });
  onTestFinished(() => { post.mockRestore(); get.mockRestore(); });
  const options = { requestId: 'approved-create', context: { operationAcceptance: { operationId: 'create-operation', accept() {} },
    operationOwnerUpdate: { update() {} } } };
  const client = createManagedMachineControllerClient(input, options, 'machines.managed.acquire');
  const native = createManagedNativeInvocation({ input, options, client, machine: row, action: 'machines.managed.acquire' }, () => row);
  const correlation = () => ManagedEnrollmentCorrelationV1Schema.parse({ ...client.correlation(row), resource: row.resource });
  async function register(machineId: string, admitted = correlation()) {
    const keys = tweetnacl.sign.keyPair();
    const installationId = `${machineId}-installation`;
    const api = await ApiClient.create({ token, encryption: null });
    return api.getOrCreateMachine({ machineId, metadata: { host: 'container', platform: 'linux', happyCliVersion: 'source-fixture',
      homeDir: '/home/custom-user', happyHomeDir: '/home/custom-user/.happier' }, managedEnrollment: admitted,
      registrationIdentity: { installationId, installationPublicKey: Buffer.from(keys.publicKey).toString('base64url'),
        installationProof: signMachineInstallationProof({ payload: { version: 1, machineId, installationId, accountId: 'owner' }, privateKey: keys.secretKey }) } });
  }
  return { input, options, client, native, runtimeRegistry, effects, requests, approvals, correlation, register, readRow: () => row,
    stopBeforeEnrollment: (signal: AbortController) => { stopBeforeEnrollment = signal; } };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('public-author Devcontainer lifecycle composition', () => {
  it('consumes the first-party native contribution through the managed driver and retains its bound namespace when the signed installer is unavailable', async ({ onTestFinished }) => {
    await withTempDir('happier-first-party-child-lifecycle-', async root => {
      const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_FIRST_PARTY_RELEASE_API_BASE_URL', 'NODE_ENV']);
      let releaseRequests = 0;
      // A genuinely unavailable release HTTP server, not an installer/signature
      // substitute. This test does not execute Docker or a guest CLI artifact.
      const mirror = createServer((_request, response) => { releaseRequests += 1; response.writeHead(404); response.end(); });
      await new Promise<void>((resolve, reject) => { mirror.once('error', reject); mirror.listen(0, '127.0.0.1', resolve); });
      onTestFinished(() => new Promise<void>((resolve, reject) => mirror.close(error => error ? reject(error) : resolve())));
      const address = mirror.address();
      if (!address || typeof address === 'string') throw new Error('Unavailable release boundary was not listening');
      // The real release resolver admits loopback QA origins only in explicit
      // development mode; keep that same scoped network-boundary contract.
      env.patch({ HAPPIER_HOME_DIR: root, HAPPIER_FIRST_PARTY_RELEASE_API_BASE_URL: `http://127.0.0.1:${address.port}`,
        NODE_ENV: 'development' });
      const configuration = await import('@/configuration');
      configuration.reloadConfiguration();
      onTestFinished(() => { env.restore(); configuration.reloadConfiguration(); });
      const configPath = join(root, '.devcontainer', 'devcontainer.json');
      await mkdir(join(root, '.devcontainer'));
      await writeFile(configPath, JSON.stringify({ image: 'example:latest', initializeCommand: 'reviewed-host-hook' }));
      const containerId = 'a'.repeat(64);
      const nativeRequests: Parameters<ExecService['run']>[0][] = [];
      const processResult = (stdout: string): PluginProcessResult => ({
        termination: { requestedBy: { kind: 'none' }, observed: { kind: 'exit', exitCode: 0 } },
        stdout: new TextEncoder().encode(stdout), stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false,
      });
      const nativeRun: ExecService['run'] = async request => {
        nativeRequests.push(request);
        const args = request.args ?? [];
        if (args[0] === 'read-configuration') return processResult(JSON.stringify({
          configuration: { image: 'example:latest', initializeCommand: 'reviewed-host-hook' },
          workspace: { workspaceFolder: '/work/custom', workspaceMount: `type=bind,source=${root},target=/work/custom` },
          mergedConfiguration: { remoteUser: 'custom-user', workspaceFolder: '/work/custom', postCreateCommands: ['reviewed-child-hook'] },
          featuresConfiguration: { featureSets: [] },
        }));
        if (args[0] === 'image') return processResult(JSON.stringify([{ Id: 'sha256:image', Config: { Labels: {} } }]));
        if (args[0] === 'up') return processResult(JSON.stringify({ outcome: 'success', containerId,
          remoteUser: 'custom-user', remoteWorkspaceFolder: '/work/custom' }));
        if (args[0] === 'inspect') return processResult(JSON.stringify([{ Id: containerId, State: { Running: true, Paused: false },
          Config: { Labels: { 'devcontainer.local_folder': root, 'devcontainer.config_file': configPath,
            'happier.managed-machine': 'retained-child' } },
          Mounts: [{ Type: 'bind', Source: root, Destination: '/work/custom' }],
        }]));
        if (args[0] === 'exec' && args.at(-1) === 'id -un; pwd -P') return processResult('custom-user\n/work/custom\n');
        if (args[0] === 'exec' && args.at(-1)?.startsWith('uname -s;')) return processResult('Linux\nx86_64\n/home/custom-user\n');
        throw new Error(`Unexpected native OS request: ${args.join(' ')}`);
      };
      const f = await lifecycleFixture(root, onTestFinished, nativeRun);
      const driver = createManagedMachineAcquisitionDriver(f.input);
      const contribution = { pluginId: DEVCONTAINER_PLUGIN.manifest.id, localId: 'devcontainer' };
      const reviewed = MachineProvisionerOptionsResultV1Schema.parse(await driver.execute('machines.provisioners.options', {
        homeId, controller, contribution, selectors: { workspaceFolder: root, configPath },
      }, f.options));
      expect(reviewed.choices[0]).toMatchObject({ available: true, effectReview: { kind: 'devcontainer' } });
      expect(nativeRequests.some(request => request.args?.[0] === 'up')).toBe(false);
      const launch = { provider: contribution, schemaVersion: 1, name: 'First-party child', choices: reviewed.choices[0]!.launch };
      const failedEnrollment = driver.execute('machines.managed.acquire', { selection: { kind: 'one-off', homeId, launch,
        controller, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } }, f.options);
      await expect(failedEnrollment).rejects.toBeInstanceOf(SystemTaskExecutionError);
      await expect(failedEnrollment).rejects.toMatchObject({ code: 'system_task_failed' });
      const failure = await failedEnrollment.catch((error: unknown) => error);
      expect(releaseRequests, `Release HTTP boundary was not reached: ${failure instanceof Error ? failure.message : String(failure)}; native commands: ${JSON.stringify(nativeRequests.map(request => request.args))}`)
        .toBeGreaterThan(0);
      const bound = f.readRow();
      expect(bound).toMatchObject({ id: 'retained-child', allocation: 'bound', controller,
        resource: { contributionRef: contribution, value: { containerId, user: 'custom-user', workspaceRoot: '/work/custom' },
          devcontainerObservation: { nativeResourceId: containerId, user: 'custom-user', workspaceFolder: '/work/custom',
            storage: { kind: 'bind', hostPath: root, childPath: '/work/custom' } } } });
      expect(bound.enrolledMachineId).toBeUndefined();
      const failedRetry = driver.execute('machines.managed.bootstrap.retry', { homeId, managedId: bound.id,
        expectedIntentRevision: bound.intentRevision }, f.options);
      await expect(failedRetry).rejects.toBeInstanceOf(SystemTaskExecutionError);
      await expect(failedRetry).rejects.toMatchObject({ code: 'system_task_failed' });
      expect(f.readRow()).toEqual(bound);
      expect(nativeRequests.filter(request => request.args?.[0] === 'up')).toHaveLength(1);
      expect(f.requests.filter(path => path.endsWith('/admit'))).toHaveLength(1);
      expect(f.requests.filter(path => path.endsWith('/submit'))).toHaveLength(1);
      expect(f.requests.filter(path => path === '/v1/machines')).toEqual([]);
      // Independent protected ordinary registration uses the retained real
      // first-party fact. It is not a claim that the failed installer paired.
      const registered = await f.register('ordinary-first-party');
      expect(registered.metadata?.devcontainerChild).toEqual(deriveManagedDevcontainerChildProjectionV1({
        managedMachineId: bound.id, controllerMachineId: controller.machineId,
        enrolledMachineId: registered.id, resource: bound.resource,
      }));
    });
  });

  it('acquires through host custody, registers the ordinary child, and routes reviewed replacement to fresh enrollment', async ({ onTestFinished }) => {
    await withTempDir('happier-public-child-lifecycle-', async root => {
      const f = await lifecycleFixture(root, onTestFinished);
      const before = f.readRow();
      expect(await executeContributedAction({ runtimeRegistry: f.runtimeRegistry, actionId: `${pluginId}/acquire`,
        input: { launch: before.launch.choices }, context: { surface: 'plugin' } }))
        .toMatchObject({ result: { ok: false, errorCode: 'plugin_managed_provider_operation_custody_invalid' } });
      expect(f.effects).toEqual([]);
      await f.client.submit(before);
      const acquired = AcquireResultV1Schema.parse(await f.native.invoke('acquire', { managedId: before.id, launch: before.launch.choices }));
      expect(acquired.kind).toBe('bound');
      if (acquired.kind !== 'bound') throw new Error('Acquire was not bound');
      await f.client.reportIssuedAcquireFact(before, acquired);
      const oldCorrelation = f.correlation();
      const registered = await f.register('ordinary-original');
      expect(registered.metadata?.devcontainerChild).toMatchObject({ relation: { managedMachineId: before.id,
        managedMachineKind: 'devcontainer', parentMachineId: controller.machineId }, observation: acquired.resource.devcontainerObservation });
      const cancellation = new AbortController();
      f.stopBeforeEnrollment(cancellation);
      const driver = createManagedMachineAcquisitionDriver(f.input);
      // Stop only at the explicit external installer boundary. This deterministic
      // test does not claim that payload installation or pairing completed.
      await expect(driver.execute('machines.managed.rebuild', { homeId, managedMachineId: before.id, kind: 'rebuild',
        expectedRevision: before.intentRevision, reviewedEffectDigest: 'reviewed-host-and-child-effects' },
        { ...f.options, requestId: 'reviewed-rebuild', signal: cancellation.signal })).rejects.toBeDefined();
      expect(f.effects).toEqual(['acquire', 'rebuild']);
      expect(f.readRow()).toMatchObject({ id: before.id, allocation: 'bound', intentRevision: 2,
        resource: { value: { name: 'native-original-replacement' } } });
      expect(f.readRow().enrolledMachineId).toBeUndefined();
      let staleDelivery = false;
      await expect(runManagedMachineEnrollment({ correlation: oldCorrelation, target,
        carrier: { kind: 'native', transport: { contributionRef, schemaVersion: 1 } } }, {
        readCurrentManagedRow: async () => f.readRow(), native: { exec: async () => { staleDelivery = true; return { status: 0, stdout: '', stderr: '' }; },
          putFile: async () => { staleDelivery = true; } },
      })).rejects.toMatchObject({ code: 'enrollment_retired' });
      expect(staleDelivery).toBe(false);
      const replacement = await f.register('ordinary-replacement');
      expect(replacement.metadata?.devcontainerChild?.observation.nativeResourceId).toBe('native-original-replacement');
      expect(f.readRow().enrolledMachineId).toBe('ordinary-replacement');
      expect(registered.metadata?.devcontainerChild?.observation.nativeResourceId).toBe('native-original');
      expect(f.requests.some(path => path.includes('/sessions'))).toBe(false);
    });
  });

  it.skipIf(process.env.HAPPIER_TEST_DEVCONTAINER_SIGNED_BOOTSTRAP !== '1')(
    'runs the real signed installer, live task runner and protected pairing through native process boundaries', async ({ onTestFinished }) => {
      await withTempDir('happier-public-child-bootstrap-', async root => {
        const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_LOCAL_SERVER_URL',
          'HAPPIER_PUBLIC_SERVER_URL', 'HAPPIER_WEBAPP_URL', 'HAPPIER_ACTIVE_SERVER_ID', 'NODE_ENV',
          'HAPPIER_FIRST_PARTY_RELEASE_API_BASE_URL', 'HAPPIER_FIRST_PARTY_RELEASE_REPO']);
        // Pin only the published external network input, never a separate
        // representation of the moving feature source. The normal installer
        // still verifies the real published signature and archive digest.
        const released = await fetchGitHubReleaseByTag({ githubRepo: 'happier-dev/happier', tag: 'cli-v0.2.15' });
        const releaseMetadata = JSON.stringify(released);
        const mirror = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(releaseMetadata); });
        await new Promise<void>((resolve, reject) => { mirror.once('error', reject); mirror.listen(0, '127.0.0.1', resolve); });
        onTestFinished(() => new Promise<void>((resolve, reject) => mirror.close(error => error ? reject(error) : resolve())));
        const address = mirror.address();
        if (!address || typeof address === 'string') throw new Error('Release metadata mirror was not listening');
        env.patch({ HAPPIER_HOME_DIR: root, HAPPIER_SERVER_URL: undefined, HAPPIER_LOCAL_SERVER_URL: undefined,
          HAPPIER_PUBLIC_SERVER_URL: undefined, HAPPIER_WEBAPP_URL: undefined, HAPPIER_ACTIVE_SERVER_ID: undefined,
          NODE_ENV: 'development', HAPPIER_FIRST_PARTY_RELEASE_API_BASE_URL: `http://127.0.0.1:${address.port}`,
          HAPPIER_FIRST_PARTY_RELEASE_REPO: 'happier-dev/happier' });
        const configuration = await import('@/configuration');
        onTestFinished(() => { env.restore(); configuration.reloadConfiguration(); });
        await writeFile(join(root, 'settings.json'), JSON.stringify({ schemaVersion: 5, onboardingCompleted: true,
          activeServerId: homeId, servers: { [homeId]: { id: homeId, name: 'Fixture Home', serverUrl: origin,
            webappUrl: origin, homeConnectionDescriptor: descriptor, createdAt: 1, updatedAt: 1, lastUsedAt: 1 } } }));
        const profileDir = join(root, 'servers', homeId);
        await mkdir(profileDir, { recursive: true });
        await writeFile(join(profileDir, 'access.key'), JSON.stringify({ token, encryption: null }));
        configuration.reloadConfiguration();
        const originalFetch = globalThis.fetch;
        vi.stubGlobal('fetch', async (url: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) => {
          if (String(url).startsWith(`${origin}/v1/features`)) return new Response(JSON.stringify({ features: {},
            capabilities: { serverIdentity: { serverIdentityId: homeId } }, homeConnectionDescriptor: descriptor }),
          { status: 200, headers: { 'content-type': 'application/json' } });
          return originalFetch(url, options);
        });
        const f = await lifecycleFixture(root, onTestFinished);
        const initial = f.readRow();
        await f.client.submit(initial);
        const acquired = AcquireResultV1Schema.parse(await f.native.invoke('acquire', { managedId: initial.id, launch: initial.launch.choices }));
        if (acquired.kind !== 'bound') throw new Error('Native acquisition was not bound');
        await f.client.reportIssuedAcquireFact(initial, acquired);
        const admitted = f.correlation();
        const keys = tweetnacl.box.keyPair();
        const publicKey = Buffer.from(keys.publicKey).toString('base64');
        const pairing = { secretB64Url: Buffer.alloc(32, 19).toString('base64url'), createdAtMs: Date.now() - 1000,
          expiresAtMs: Date.now() + 600_000 };
        const commands: string[] = [];
        const payloads: Uint8Array[] = [];
        let promoted = false;
        let taskId = '';
        const taskOwner = (await import('@/capabilities/systemTasks/liveSystemTasksRunner')).getLiveSystemTasksRunnerAdapter();
        onTestFinished(async () => { if (taskId) { await taskOwner.cancel({ taskId }); await taskOwner.wait({ taskId }); } });
        const json = (value: unknown) => ({ status: 0, stdout: JSON.stringify(value), stderr: '' });
        const result = await runManagedMachineEnrollment({ correlation: admitted, target,
          carrier: { kind: 'native', transport: { contributionRef, schemaVersion: 1 } },
          // This downloads and verifies the public stable artifact through the
          // real installer. Guest command outputs represent the CURRENT source
          // contract; this does not execute or certify the released 0.2 binary.
          channel: 'stable',
          onTask: async task => {
            taskId = task.taskId;
            for (;;) {
              const snapshot = await taskOwner.poll({ taskId, cursor: 0 }) as { pendingPrompt: { kind: string } | null; result: unknown };
              if (snapshot.pendingPrompt) {
                expect(snapshot.pendingPrompt.kind).toBe('auth.approveRemoteProvisioning');
                await taskOwner.respond({ taskId, answer: { approved: true } });
                return;
              }
              if (snapshot.result) return;
              // Test-only observation of the existing task handle, never a
              // bootstrap deadline or a competing product lifecycle owner.
              await new Promise<void>(resolve => setTimeout(resolve, 50));
            }
          },
        }, { readCurrentManagedRow: async () => f.readRow(), native: {
          putFile: async ({ bytes }) => { payloads.push(bytes); },
          exec: async ({ command, input }) => {
            commands.push(command);
            if (command === 'id -un; pwd -P') return { status: 0, stdout: 'custom-user\n/work/custom\n', stderr: '' };
            if (command.startsWith('uname -s;')) return { status: 0, stdout: 'Linux\nx86_64\n/home/custom-user\n', stderr: '' };
            if (command.startsWith('mkdir -p ')) return { status: 0, stdout: '', stderr: '' };
            if (command.startsWith('set -eu;')) {
              expect(payloads.length).toBeGreaterThan(0);
              promoted = true;
              return { status: 0, stdout: '', stderr: '' };
            }
            expect(promoted).toBe(true);
            if (command.includes("'auth' 'request'")) {
              expect(JSON.parse(input!)).toMatchObject({ managedEnrollment: admitted, homeTarget: { kind: 'descriptor', descriptor } });
              return json({ kind: 'remote_home_enrollment_pairing_request', protocolVersion: 1, publicKey, homeServerIdentityId: homeId,
                pairing, supportsTokenOnly: true, pairingRequirement: 'v3', remoteProfileId: homeId });
            }
            if (command.includes("'auth' 'wait'")) {
              expect(f.approvals).toEqual([expect.objectContaining({ publicKey, responseKind: 'tokenOnly', response: expect.any(String) })]);
              await f.register('ordinary-signed-bootstrap', admitted);
              return json({ kind: 'remote_home_enrollment_result', protocolVersion: 1, success: true, homeServerIdentityId: homeId,
                machineId: 'ordinary-signed-bootstrap', encryptionType: 'tokenOnly', pairingAuthentication: 'v3', remoteProfileId: homeId });
            }
            if (command.includes("'auth' 'status'")) return json({ ok: true, data: { authenticated: true, credentialState: 'valid',
              machineRegistrationState: 'server-confirmed', machineRegistered: true, machineId: 'ordinary-signed-bootstrap' } });
            if (command.includes("'service' 'list'")) return json({ ok: true, data: { services: [] } });
            if (command.includes("'service' 'install'") || command.includes("'service' 'start'")) return json({ ok: true });
            if (command.includes("'daemon' 'status'")) return json({ daemon: { running: true }, service: { installed: true },
              auth: { needsAuth: false, machineId: 'ordinary-signed-bootstrap' }, server: { activeServerId: homeId } });
            throw new Error('Unexpected native bootstrap command');
          },
        } });
        expect(result).toEqual({ machineId: 'ordinary-signed-bootstrap' });
        expect(f.readRow().enrolledMachineId).toBe(result.machineId);
        expect(commands.some(command => command.includes("'--managed-enrollment-stdin'"))).toBe(true);
        expect(payloads.reduce((total, payload) => total + payload.byteLength, 0)).toBeGreaterThan(0);
      });
    }, 120_000);
});
