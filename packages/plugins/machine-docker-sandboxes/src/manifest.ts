import { readManagedDependencyExecutable, projectUnavailableManagedDependency } from '@happier-dev/plugin-sdk/managed-services';
import { Buffer } from 'node:buffer';
import { machinePresentationLabel, machineCheckPresentation } from './ui/translations.js';
import { definePlugin, PluginError } from '@happier-dev/plugin-sdk';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { defineProtocolJsonValue, defineProtocolLiteral, defineProtocolObject, defineProtocolString, defineProtocolUnion } from '@happier-dev/plugin-sdk/protocol';
import {
  observeMachineProvisionerNativeRead,
  MachineProvisionerBootstrapCarrierV1Schema, MachineProvisionerCheckResultV1Schema,
  MachineProvisionerNativeExecResultV1Schema, MachineProvisionerNativeStreamResultV1Schema, MachineProvisionerObservationV1Schema,
  MachineProvisionerOptionsResultV1Schema, MachineProvisionerPowerResultV1Schema, MachineProvisionerPutFileResultV1Schema,
  projectMachineProvisionerActionFailure,
} from '@happier-dev/plugin-sdk/machine-provisioners';
import type { MachineProvisionerAuthorDefinitionV1, MachineProvisionerCheckResultV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import { createDockerSandboxesProvider, DOCKER_SANDBOXES_DEPENDENCY_ID, DOCKER_SANDBOXES_PLUGIN_ID,
  DOCKER_SANDBOXES_PROVISIONER_ID } from './machine/provider.js';
import { DOCKER_SANDBOXES_ROLE_SCHEMAS, DOCKER_SANDBOXES_RECONCILIATION_SCHEMAS, DOCKER_SANDBOXES_PREPARATION_SCHEMAS,
  DockerSandboxesLaunchV1Schema, DockerSandboxesResourceV1Schema, DockerSandboxesPreparationInputSchema,
  DockerSandboxesPreparedArtifactSchema, DockerSandboxesPreparationOperationSchema } from './machine/schemas.js';
import { DOCKER_ACCOUNT_DESCRIPTOR, DOCKER_ACCOUNT_SERVICE, DOCKER_ACCOUNT_PURPOSE, prepareDockerAccount } from './machine/dockerAccount.js';
import { DOCKER_SANDBOXES_INSTALL_RECIPE } from './machine/installRecipe.js';
import { dockerSandboxesInstallSources, installDockerSandboxes } from './machine/installRuntime.js';
import { DOCKER_CLOUD_PROVISIONER } from './cloud/contribution.js';
import { createCloudClient, cloudCode, cloudFailure } from './cloud/nativeClient.js';
import { createCloudPreparation } from './cloud/preparation.js';
import { ColdLaunchSchema as CloudLaunchSchema, ROLE as CLOUD_ROLE, RECONCILIATION as CLOUD_RECONCILIATION, RETENTION as CLOUD_RETENTION, PREPARATION as CLOUD_PREPARATION } from './cloud/schemas.js';

const processAccess = 'docker-sandboxes-process';
const actionDefaults = { scopes: ['machine'], surfaces: ['cli', 'plugin'], hostAccess: [processAccess] } as const;
function errorCode(error: unknown) {
  return error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code : 'docker_sandbox_unavailable';
}
function readDockerSignInRefusal(error: unknown) {
  if (!(error instanceof PluginError) || error.code !== 'credential_unavailable') return null;
  return { available: false, code: error.code, status: 'Sign in to Docker', prerequisites: [projectUnavailableManagedDependency(
    { pluginId: DOCKER_SANDBOXES_PLUGIN_ID, localId: DOCKER_SANDBOXES_DEPENDENCY_ID }, { reason: 'Docker Sandboxes is installed but needs native sign-in.',
    repairAction: { action: { pluginId: DOCKER_SANDBOXES_PLUGIN_ID, localId: 'sign-in' }, input: {} },
  })] } satisfies MachineProvisionerCheckResultV1;
}
class MissingDockerSandboxesDependency extends Error {
  readonly code = 'docker_sandbox_unavailable';
}
async function nativeExecutable(context: PluginInvocationContext) {
  // A system declaration uses the shared dependency owner. No vendor download,
  // license grant, install or native daemon effect occurs during discovery.
  const status = await readManagedDependencyExecutable(context.services.managedServices.dependencies, DOCKER_SANDBOXES_DEPENDENCY_ID, context.signal);
  if (status.state === 'missing') throw new MissingDockerSandboxesDependency('native Docker Sandboxes executable missing');
  if (status.state !== 'ready') throw new Error('native Docker Sandboxes executable unavailable');
  return status.executable;
}
async function provider(context: PluginInvocationContext) {
  return createDockerSandboxesProvider(context.services.exec, await nativeExecutable(context), context.invokedAtMs, context.signal);
}
function privateBytes(value: string) {
  return Buffer.from(value, 'base64');
}

export const DOCKER_SANDBOXES_MACHINE_PROVISIONER = {
  title: 'Docker Sandboxes', icon: 'cube', resourceKind: 'docker-sandbox', schemaVersion: 1,
  enrollmentRole: 'sandbox',
  sessionPlacement: { kind: 'controller-local', supportsAgentNativeSandbox: false },
  kindTitle: machinePresentationLabel('kind'), description: machinePresentationLabel('description'),
  launchSchema: DockerSandboxesLaunchV1Schema.jsonSchema, resourceSchema: DockerSandboxesResourceV1Schema.jsonSchema, resourceIdPath: 'sandboxName',
  platforms: ['darwin', 'linux', 'win32'], prerequisites: [{ kind: 'managedDependency', id: DOCKER_SANDBOXES_DEPENDENCY_ID }],
  billing: { location: 'local', stoppedBilling: 'not-billed' }, retention: { supportedIntents: ['start', 'stop', 'delete'] },
  actions: { check: 'check', options: 'options', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', power: 'power', destroy: 'destroy' },
  bootstrapTransport: { kind: 'native', exec: 'exec', putFile: 'put-file', stream: 'stream' },
  reconciliation: { nativeOperationSchema: DockerSandboxesResourceV1Schema.jsonSchema, action: 'reconcile' },
  preparation: { inputSchema: DockerSandboxesPreparationInputSchema.jsonSchema,
    artifactSchema: DockerSandboxesPreparedArtifactSchema.jsonSchema,
    nativeOperationSchema: DockerSandboxesPreparationOperationSchema.jsonSchema, artifactLaunchPath: 'launch',
    actions: { build: 'prepare-build', inspect: 'prepare-inspect', destroy: 'prepare-destroy' } },
} satisfies MachineProvisionerAuthorDefinitionV1;

export const DOCKER_SANDBOXES_PLUGIN = definePlugin({
  id: DOCKER_SANDBOXES_PLUGIN_ID, version: '0.0.0', displayName: 'Docker Sandbox Machines',
  // The provider's own mark beside its name in Machines: Docker's mark from Simple Icons 13.21.0 (CC0-1.0), brand blue #2496ED.
  brand: { iconResourceId: 'brand-icon' },
  resources: { 'brand-icon': { kind: 'asset', path: 'assets/brand.png', contentType: 'image/png' },
    "i18n-en": { kind: 'asset', path: "assets/i18n/en.json", contentType: 'application/json' },
    "i18n-de": { kind: 'asset', path: "assets/i18n/de.json", contentType: 'application/json' },
    "i18n-ru": { kind: 'asset', path: "assets/i18n/ru.json", contentType: 'application/json' },
    "i18n-pl": { kind: 'asset', path: "assets/i18n/pl.json", contentType: 'application/json' },
    "i18n-es": { kind: 'asset', path: "assets/i18n/es.json", contentType: 'application/json' },
    "i18n-fr": { kind: 'asset', path: "assets/i18n/fr.json", contentType: 'application/json' },
    "i18n-it": { kind: 'asset', path: "assets/i18n/it.json", contentType: 'application/json' },
    "i18n-pt": { kind: 'asset', path: "assets/i18n/pt.json", contentType: 'application/json' },
    "i18n-ca": { kind: 'asset', path: "assets/i18n/ca.json", contentType: 'application/json' },
    "i18n-zh-hans": { kind: 'asset', path: "assets/i18n/zh-Hans.json", contentType: 'application/json' },
    "i18n-zh-hant": { kind: 'asset', path: "assets/i18n/zh-Hant.json", contentType: 'application/json' },
    "i18n-ja": { kind: 'asset', path: "assets/i18n/ja.json", contentType: 'application/json' },
  },
  description: 'Local and remote Docker sandboxes with retained identities and private bootstrap IO.', entrypoints: { daemon: './.happier-plugin-build/daemon.js' },
  hostAccess: { required: [{ id: processAccess, capability: 'process', reason: 'Operate the exact reviewed Docker Sandbox.',
    scope: { executables: [{ kind: 'managedDependency', id: DOCKER_SANDBOXES_DEPENDENCY_ID }] },
  }, { id: DOCKER_ACCOUNT_PURPOSE, capability: 'connectedAccounts', reason: 'Use the selected Docker account for native sign-in and Docker cloud.',
    scope: { serviceRefs: [DOCKER_ACCOUNT_SERVICE.localId], operations: ['select', 'use'], materializationKinds: ['environment'] },
  }, { id: 'docker-cloud-api', capability: 'network', reason: 'Manage Docker cloud sandboxes and use their scoped private process/file endpoints.',
    scope: { targets: [{ kind: 'httpsHostSuffix', hostSuffix: 'docker.com' }], methods: ['GET', 'POST', 'PUT', 'DELETE'] },
  }], optional: [] },
  connectedAccountDescriptors: { [DOCKER_ACCOUNT_SERVICE.localId]: DOCKER_ACCOUNT_DESCRIPTOR },
  machineRecipes: { 'docker-sandboxes-install': DOCKER_SANDBOXES_INSTALL_RECIPE },
  managedDependencies: { [DOCKER_SANDBOXES_DEPENDENCY_ID]: {
    id: DOCKER_SANDBOXES_DEPENDENCY_ID, title: 'Docker Sandboxes', executable: 'sbx',
    description: 'User-installed sbx under the Docker subscription license.',
    sources: [{ kind: 'system', executableNames: ['sbx'], versionArguments: ['version'] }],
  } },
  ui: {
    translations: [
    { locale: "en", resourceId: "i18n-en" },
    { locale: "de", resourceId: "i18n-de" },
    { locale: "ru", resourceId: "i18n-ru" },
    { locale: "pl", resourceId: "i18n-pl" },
    { locale: "es", resourceId: "i18n-es" },
    { locale: "fr", resourceId: "i18n-fr" },
    { locale: "it", resourceId: "i18n-it" },
    { locale: "pt", resourceId: "i18n-pt" },
    { locale: "ca", resourceId: "i18n-ca" },
    { locale: "zh-Hans", resourceId: "i18n-zh-hans" },
    { locale: "zh-Hant", resourceId: "i18n-zh-hant" },
    { locale: "ja", resourceId: "i18n-ja" },
  ] },
  machineProvisioners: { [DOCKER_SANDBOXES_PROVISIONER_ID]: DOCKER_SANDBOXES_MACHINE_PROVISIONER, 'docker-cloud': DOCKER_CLOUD_PROVISIONER },
  actions: {
    'install-runtime': { title: 'Install Docker Sandboxes', scopes: ['machine'],
      surfaces: ['ui', 'agent', 'mcp', 'cli', 'plugin'], dangerLevel: 'writesLocal',
      confirmation: { title: 'Install Docker Sandboxes', body: 'Review and apply Docker’s native package installation on this computer.' },
      inputSchema: defineProtocolObject({}, { policy: 'closed' }), resultSchema: defineProtocolJsonValue(),
      async run(_input, context) { return installDockerSandboxes(context); } },
    'prepare-build': { ...actionDefaults, title: 'Prepare Docker Sandbox template', dangerLevel: 'writesLocal',
      confirmation: { title: 'Prepare Docker Sandbox template', body: 'Builds a dedicated local guest and retains its template until deleted.' },
      inputSchema: DOCKER_SANDBOXES_PREPARATION_SCHEMAS.buildInput, resultSchema: DOCKER_SANDBOXES_PREPARATION_SCHEMAS.buildResult,
      async run(input, context) { return (await provider(context)).buildPreparation(input); } },
    'prepare-inspect': { ...actionDefaults, title: 'Inspect prepared Docker Sandbox template', dangerLevel: 'safe',
      inputSchema: DOCKER_SANDBOXES_PREPARATION_SCHEMAS.inspectInput, resultSchema: DOCKER_SANDBOXES_PREPARATION_SCHEMAS.inspectResult,
      async run(input, context) { return (await provider(context)).inspectPreparation('nativeOperation' in input
        ? { nativeOperation: input.nativeOperation.value } : input); } },
    'prepare-destroy': { ...actionDefaults, title: 'Delete prepared Docker Sandbox template', dangerLevel: 'destructive',
      confirmation: { title: 'Delete prepared Docker Sandbox template', body: 'Deletes only its owned template and dedicated builder.' },
      inputSchema: DOCKER_SANDBOXES_PREPARATION_SCHEMAS.destroyInput, resultSchema: DOCKER_SANDBOXES_PREPARATION_SCHEMAS.destroyResult,
      async run(input, context) { return (await provider(context)).destroyPreparation({ artifact: input.artifact?.value,
        nativeOperation: input.nativeOperation?.value }); } },
    'cloud-prepare-build': { ...actionDefaults, hostAccess: ['docker-cloud-api', DOCKER_ACCOUNT_PURPOSE], title: 'Prepare Docker cloud image', dangerLevel: 'writesRemote',
      confirmation: { title: 'Prepare Docker cloud image', body: 'Docker may bill the builder, snapshot and retained storage.' },
      inputSchema: CLOUD_PREPARATION.buildInput, resultSchema: CLOUD_PREPARATION.buildResult,
      async run(input, context) { return createCloudPreparation(createCloudClient(context), () => context.services.machineProvisioners.waitForNativeObservation()).build(input.operationId, input.input); } },
    'cloud-prepare-inspect': { ...actionDefaults, hostAccess: ['docker-cloud-api', DOCKER_ACCOUNT_PURPOSE], title: 'Inspect Docker cloud preparation', dangerLevel: 'safe',
      inputSchema: CLOUD_PREPARATION.inspectInput, resultSchema: CLOUD_PREPARATION.inspectResult,
      async run(input, context) { return createCloudPreparation(createCloudClient(context), () => context.services.machineProvisioners.waitForNativeObservation()).inspect('nativeOperation' in input
        ? input.nativeOperation.value : { operationId: input.operationId, launch: input.launch }); } },
    'cloud-prepare-destroy': { ...actionDefaults, hostAccess: ['docker-cloud-api', DOCKER_ACCOUNT_PURPOSE], title: 'Delete Docker cloud preparation', dangerLevel: 'destructive',
      confirmation: { title: 'Delete Docker cloud preparation', body: 'Permanently deletes the prepared snapshot and its owned builder.' },
      inputSchema: CLOUD_PREPARATION.destroyInput, resultSchema: CLOUD_PREPARATION.destroyResult,
      async run(input, context) { const preparation = createCloudPreparation(createCloudClient(context), () => context.services.machineProvisioners.waitForNativeObservation());
        if (input.nativeOperation) return preparation.destroy(input.nativeOperation.value);
        // A ready artifact has no remaining builder. Its native name is the
        // sole deletion target; no preset freshness or composition decision here.
        const artifact = input.artifact!.value;
        return preparation.destroy({ operationId: artifact.operationId, launch: artifact.builderLaunch,
          snapshotName: artifact.snapshotName }); } },
    'cloud-check': { ...actionDefaults, hostAccess: ['docker-cloud-api', DOCKER_ACCOUNT_PURPOSE], title: 'Check Docker cloud', dangerLevel: 'safe',
      inputSchema: CLOUD_ROLE.checkInput, resultSchema: MachineProvisionerCheckResultV1Schema,
      async run(_input, context) { return createCloudClient(context).check(); } },
    'cloud-options': { ...actionDefaults, hostAccess: ['docker-cloud-api', DOCKER_ACCOUNT_PURPOSE], title: 'Docker cloud image', dangerLevel: 'safe',
      inputSchema: CloudLaunchSchema, resultSchema: MachineProvisionerOptionsResultV1Schema,
      inputHints: { fields: [{ path: 'imageRef', title: 'OCI image', widget: 'text', required: true, defaultValue: 'ubuntu:24.04' },
        { path: 'timeoutSeconds', title: 'Native lifetime (seconds)', widget: 'integer', description: 'Docker applies this lifetime. Omit to use the service policy.' }] },
      async run(launch) { return { base: { launch, guestPlatform: 'linux', retention: CLOUD_RETENTION,
        nativeFacts: { preparationGuest: { target: { os: 'linux', arch: 'x64' }, remoteHomeDir: '/opt/happier' } } },
        dimensions: { size: [], location: [], network: [], duration: [], image: [{ id: launch.imageRef,
          title: launch.imageRef, assignments: [], guestPlatform: 'linux' }] } }; } },
    'cloud-acquire': { ...actionDefaults, hostAccess: ['docker-cloud-api', DOCKER_ACCOUNT_PURPOSE], title: 'Create Docker cloud sandbox', dangerLevel: 'writesRemote',
      confirmation: { title: 'Create Docker cloud sandbox', body: 'Docker may bill running compute and retained storage.', confirmLabel: 'Create' },
      inputSchema: CLOUD_ROLE.acquireInput, resultSchema: CLOUD_RECONCILIATION.result,
      async run(input, context) { if (!input.managedId) return { kind: 'rejected', code: 'invalid_request' }; return createCloudClient(context).acquire(input.launch, input.managedId); } },
    'cloud-reconcile': { ...actionDefaults, hostAccess: ['docker-cloud-api', DOCKER_ACCOUNT_PURPOSE], title: 'Recover Docker cloud creation', dangerLevel: 'safe',
      inputSchema: CLOUD_RECONCILIATION.input, resultSchema: CLOUD_RECONCILIATION.result,
      async run(input, context) { return createCloudClient(context).recover('nativeOperation' in input ? input.nativeOperation : input.correlation); } },
    'cloud-bootstrap': { ...actionDefaults, hostAccess: ['docker-cloud-api', DOCKER_ACCOUNT_PURPOSE], title: 'Prepare Docker cloud bootstrap', dangerLevel: 'writesRemote',
      confirmation: { title: 'Prepare Docker cloud bootstrap' }, inputSchema: CLOUD_ROLE.bootstrapInput, resultSchema: MachineProvisionerBootstrapCarrierV1Schema,
      async run(input, context) { try { return await createCloudClient(context).bootstrap(input.resource); } catch (error) { return cloudFailure(error); } } },
    'cloud-inspect': { ...actionDefaults, hostAccess: ['docker-cloud-api', DOCKER_ACCOUNT_PURPOSE], title: 'Inspect Docker cloud sandbox', dangerLevel: 'safe',
      inputSchema: CLOUD_ROLE.resourceInput, resultSchema: MachineProvisionerObservationV1Schema,
      async run(input, context) { return createCloudClient(context).inspect(input.resource); } },
    'cloud-power': { ...actionDefaults, hostAccess: ['docker-cloud-api', DOCKER_ACCOUNT_PURPOSE], title: 'Start or stop Docker cloud sandbox', dangerLevel: 'writesRemote',
      confirmation: { title: 'Change Docker cloud sandbox power', body: 'Retained cloud storage may remain billed.' },
      inputSchema: CLOUD_ROLE.powerInput, resultSchema: MachineProvisionerPowerResultV1Schema,
      async run(input, context) { try { return await createCloudClient(context).power(input.resource, input.intent); } catch (error) { return { kind: 'unknown', code: cloudCode(error) }; } } },
    'cloud-destroy': { ...actionDefaults, hostAccess: ['docker-cloud-api', DOCKER_ACCOUNT_PURPOSE], title: 'Delete Docker cloud sandbox', dangerLevel: 'destructive',
      confirmation: { title: 'Delete Docker cloud sandbox', body: 'Permanently deletes its retained files.', confirmLabel: 'Delete' },
      inputSchema: CLOUD_RECONCILIATION.destroyInput, resultSchema: CLOUD_RECONCILIATION.destroyResult,
      async run(input, context) { const client = createCloudClient(context);
        if ('resource' in input) return client.destroy(input.resource);
        try { const found = await client.locate(input.nativeOperation);
          return found ? client.destroy({ sandboxName: found.name }) : { kind: 'unknown', code: 'docker_cloud_identity_unconfirmed' }; }
        catch (error) { return { kind: 'unknown', code: cloudCode(error) }; } } },
    'cloud-exec': { ...actionDefaults, hostAccess: ['docker-cloud-api', DOCKER_ACCOUNT_PURPOSE], title: 'Execute private Docker cloud bootstrap', dangerLevel: 'writesRemote',
      confirmation: { title: 'Execute Docker cloud bootstrap' }, inputSchema: CLOUD_ROLE.execInput, resultSchema: MachineProvisionerNativeExecResultV1Schema,
      async run(input, context) { try { return await createCloudClient(context).exec(input); } catch (error) { return cloudFailure(error); } } },
    'cloud-put-file': { ...actionDefaults, hostAccess: ['docker-cloud-api', DOCKER_ACCOUNT_PURPOSE], title: 'Upload private Docker cloud bootstrap file', dangerLevel: 'writesRemote',
      confirmation: { title: 'Upload Docker cloud bootstrap file' }, inputSchema: CLOUD_ROLE.putFileInput, resultSchema: MachineProvisionerPutFileResultV1Schema,
      async run(input, context) { try { return await createCloudClient(context).putFile(input.resource, input.guestPath, privateBytes(input.bytesBase64), input.mode); }
        catch (error) { return { kind: 'unknown', code: cloudCode(error) }; } } },
    'sign-in': { ...actionDefaults, title: 'Sign in to Docker', dangerLevel: 'writesLocal',
      hostAccess: [processAccess, DOCKER_ACCOUNT_PURPOSE],
      confirmation: { title: 'Sign in to Docker', body: 'Docker stores this login in its native credential store on this Machine. Use sbx logout to remove the native login.', confirmLabel: 'Sign in' },
      inputSchema: defineProtocolObject({}, { policy: 'closed' }), resultSchema: defineProtocolLiteral(null),
      async run(_input, context) {
        // Dependency resolution precedes secret acquisition. Only stdin carries
        // the PAT; captured vendor output is never returned as an Action result.
        const executable = await nativeExecutable(context);
        const selected = await prepareDockerAccount(context.services.connectedAccounts, context.signal);
        const result = await context.services.exec.run({ executable,
          args: ['login', '--username', selected.username, '--password-stdin'], stdin: new TextEncoder().encode(selected.token + '\n') }, { signal: context.signal });
        if (result.termination.requestedBy.kind !== 'none') throw new PluginError({ code: 'action_failed',
          details: { phase: 'native_login', termination: result.termination } });
        if (result.termination.observed.kind !== 'exit' || result.termination.observed.exitCode !== 0) throw new PluginError({
          code: 'credential_unavailable', message: 'Docker native sign-in failed.',
          details: { phase: 'native_login', termination: result.termination },
        });
        return null;
      },
    },
    'install-docs': { title: { key: 'machineDocker.page.getApp', fallback: 'Get Docker Sandboxes' },
      surfaces: ['ui', 'agent', 'mcp', 'cli', 'plugin'], dangerLevel: 'safe',
      execution: { target: 'client', client: { artifactId: 'docker-sandboxes-machine-native', exportName: 'activate' },
        platforms: ['web', 'ios', 'android'] },
      inputSchema: defineProtocolObject({}, { policy: 'closed' }),
      resultSchema: defineProtocolUnion([defineProtocolLiteral(null), defineProtocolObject({ url: defineProtocolString() }, { policy: 'closed' })]),
    },
    check: { ...actionDefaults, title: 'Check Docker Sandboxes', dangerLevel: 'safe',
      inputSchema: DOCKER_SANDBOXES_ROLE_SCHEMAS.checkInput, resultSchema: MachineProvisionerCheckResultV1Schema,
      async run(_input, context) {
        try { return machineCheckPresentation(await (await provider(context)).check()); }
        catch (error) {
          const signIn = readDockerSignInRefusal(error);
          if (signIn) return signIn;
          return projectMachineProvisionerActionFailure(error, () => machineCheckPresentation({ available: false, code: errorCode(error),
          ...(error instanceof MissingDockerSandboxesDependency ? { prerequisites: [projectUnavailableManagedDependency(
            { pluginId: DOCKER_SANDBOXES_PLUGIN_ID, localId: DOCKER_SANDBOXES_DEPENDENCY_ID }, {
              setupSources: dockerSandboxesInstallSources(),
              repairAction: { action: { pluginId: DOCKER_SANDBOXES_PLUGIN_ID, localId: 'install-runtime' }, input: {} },
            })] } : {}),
        })); }
      },
    },
    options: { ...actionDefaults, title: 'Discover Docker Sandbox templates', dangerLevel: 'safe',
      inputSchema: DOCKER_SANDBOXES_ROLE_SCHEMAS.checkInput, resultSchema: MachineProvisionerOptionsResultV1Schema,
      async run(_input, context) {
        try { return await (await provider(context)).options(); }
        catch (error) {
          const signIn = readDockerSignInRefusal(error);
          if (!signIn) throw error;
          throw new PluginError({ code: signIn.code, message: signIn.status, retryable: true, details: signIn });
        }
      },
    },
    acquire: { ...actionDefaults, title: 'Create Docker Sandbox', dangerLevel: 'writesLocal',
      confirmation: { title: 'Create Docker Sandbox', confirmLabel: 'Create' },
      inputSchema: DOCKER_SANDBOXES_ROLE_SCHEMAS.acquireInput, resultSchema: DOCKER_SANDBOXES_RECONCILIATION_SCHEMAS.result,
      async run(input, context) {
        // Dependency refusal is pre-effect; native uncertainty is preserved by
        // the adapter with its preselected managed-row-derived resource name.
        let native: Awaited<ReturnType<typeof provider>>;
        try { native = await provider(context); }
        catch (error) { return projectMachineProvisionerActionFailure(error, () => ({ kind: 'rejected' as const, code: 'provider_unavailable' as const })); }
        return native.acquire(input.launch, input.managedId);
      },
    },
    reconcile: { ...actionDefaults, title: 'Recover exact Docker Sandbox', dangerLevel: 'safe',
      inputSchema: DOCKER_SANDBOXES_RECONCILIATION_SCHEMAS.input, resultSchema: DOCKER_SANDBOXES_RECONCILIATION_SCHEMAS.result,
      async run(input, context) {
        return (await provider(context)).reconcile(input); },
    },
    bootstrap: { ...actionDefaults, title: 'Resolve private Docker Sandbox bootstrap', dangerLevel: 'writesLocal',
      confirmation: { title: 'Prepare Docker Sandbox bootstrap' },
      inputSchema: DOCKER_SANDBOXES_ROLE_SCHEMAS.bootstrapInput, resultSchema: MachineProvisionerBootstrapCarrierV1Schema,
      async run(input, context) { return (await provider(context)).bootstrap(input.resource); },
    },
    inspect: { ...actionDefaults, title: 'Inspect Docker Sandbox', dangerLevel: 'safe',
      inputSchema: DOCKER_SANDBOXES_ROLE_SCHEMAS.resourceInput, resultSchema: MachineProvisionerObservationV1Schema,
      async run(input, context) {
        try { return await (await provider(context)).inspect(input.resource); }
        catch (error) { return projectMachineProvisionerActionFailure(error, () => observeMachineProvisionerNativeRead(context.invokedAtMs, { kind: 'unknown', reason: errorCode(error) })); }
      },
    },
    power: { ...actionDefaults, title: 'Change Docker Sandbox power', dangerLevel: 'writesLocal',
      confirmation: { title: 'Change Docker Sandbox power' },
      inputSchema: DOCKER_SANDBOXES_ROLE_SCHEMAS.powerInput, resultSchema: MachineProvisionerPowerResultV1Schema,
      async run(input, context) {
        try { return await (await provider(context)).power(input.resource, input.intent); }
        catch (error) { return projectMachineProvisionerActionFailure(error, () => ({ kind: 'unknown' as const, code: errorCode(error) })); }
      },
    },
    destroy: { ...actionDefaults, title: 'Delete exact Docker Sandbox', dangerLevel: 'destructive',
      confirmation: { title: 'Delete Docker Sandbox', body: 'Deletes the sandbox and all of its retained files.', confirmLabel: 'Delete' },
      inputSchema: DOCKER_SANDBOXES_RECONCILIATION_SCHEMAS.destroyInput, resultSchema: MachineProvisionerPowerResultV1Schema,
      async run(input, context) {
        try { return await (await provider(context)).destroy(input); }
        catch (error) { return projectMachineProvisionerActionFailure(error, () => ({ kind: 'unknown' as const, code: errorCode(error) })); }
      },
    },
    exec: { ...actionDefaults, title: 'Execute private Docker Sandbox bootstrap', dangerLevel: 'writesLocal',
      confirmation: { title: 'Execute Docker Sandbox bootstrap' },
      inputSchema: DOCKER_SANDBOXES_ROLE_SCHEMAS.execInput, resultSchema: MachineProvisionerNativeExecResultV1Schema,
      async run(input, context) {
        const result = await (await provider(context)).exec(input.resource, input.argv,
          input.inputBase64 === undefined ? undefined : privateBytes(input.inputBase64));
        return { termination: result.termination, stdoutBase64: Buffer.from(result.stdout).toString('base64'),
          stderrBase64: Buffer.from(result.stderr).toString('base64'), stdoutTruncated: result.stdoutTruncated, stderrTruncated: result.stderrTruncated };
      },
    },
    stream: { ...actionDefaults, title: 'Open a private Docker Sandbox channel', dangerLevel: 'writesLocal',
      confirmation: { title: 'Open a Docker Sandbox channel' },
      inputSchema: DOCKER_SANDBOXES_ROLE_SCHEMAS.streamInput, resultSchema: MachineProvisionerNativeStreamResultV1Schema,
      async run(input, context) {
        const channel = await (await provider(context)).stream(input.resource, input.argv);
        try { return { termination: await channel.waitForExit() }; } finally { await channel.dispose(); }
      },
    },
    'put-file': { ...actionDefaults, title: 'Write private Docker Sandbox bootstrap file', dangerLevel: 'writesLocal',
      confirmation: { title: 'Write Docker Sandbox bootstrap file' },
      inputSchema: DOCKER_SANDBOXES_ROLE_SCHEMAS.putFileInput, resultSchema: MachineProvisionerPutFileResultV1Schema,
      async run(input, context) {
        try { return await (await provider(context)).putFile(input.resource, input.guestPath, privateBytes(input.bytesBase64), input.mode); }
        catch (error) { return projectMachineProvisionerActionFailure(error, () => ({ kind: 'unknown' as const, code: errorCode(error) })); }
      },
    },
  },
});

export const PLUGIN_MANIFEST = DOCKER_SANDBOXES_PLUGIN.manifest;
