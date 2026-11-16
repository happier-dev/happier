import { Buffer } from 'node:buffer';
import { platform } from 'node:os';
import { definePlugin } from '@happier-dev/plugin-sdk';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { PluginLocalizedStringV2 } from '@happier-dev/plugin-sdk';
import { defineProtocolJsonValue, defineProtocolLiteral, defineProtocolObject, defineProtocolString, defineProtocolUnion } from '@happier-dev/plugin-sdk/protocol';
import {
  defineMachineProvisionerSchemas, defineMachineProvisionerReconciliationSchemas, defineMachineProvisionerPreparationSchemas, MachineProvisionerBootstrapCarrierV1Schema, MachineProvisionerCheckResultV1Schema,
  MachineProvisionerNativeExecResultV1Schema, MachineProvisionerNativeStreamResultV1Schema, MachineProvisionerObservationV1Schema, MachineProvisionerPowerResultV1Schema,
  MachineProvisionerOptionsResultV1Schema,
  MachineProvisionerResizeResultV1Schema,
} from '@happier-dev/plugin-sdk/machine-provisioners';
import type { MachineProvisionerAuthorDefinitionV1, MachineProvisionerCheckResultV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import { createDevcontainerProvider, DEVCONTAINER_PLUGIN_ID, DEVCONTAINER_PROVISIONER_ID } from './machine/provider.js';
import { DevcontainerResourceSchema, DevcontainerReviewQuerySchema, DevcontainerNativeOperationSchema, DevcontainerRuntimeSchema } from './machine/schemas.js';
import { readDevcontainerEffectReview, readDevcontainerNativeEnvironment } from './machine/effectReview.js';
import { DockerRuntimeRepairInputSchema, dockerRuntimeRepairSources, installDockerRuntime, type DockerRuntimeRepairInput } from './machine/runtimeRepair.js';
import { createDevcontainerPreparation, devcontainerPreparationOperation, resolveDevcontainerPreparationInput, DevcontainerPreparationInputSchema, DevcontainerPreparedImageSchema, DevcontainerPreparationOperationSchema } from './machine/preparation.js';

export const DEVCONTAINER_ROLE_SCHEMAS = defineMachineProvisionerSchemas({ launch: DevcontainerReviewQuerySchema, resource: DevcontainerResourceSchema });
export const DEVCONTAINER_RECONCILIATION_SCHEMAS = defineMachineProvisionerReconciliationSchemas({ launch: DevcontainerReviewQuerySchema, resource: DevcontainerResourceSchema,
  nativeOperation: DevcontainerNativeOperationSchema });
const preparationSchemas = defineMachineProvisionerPreparationSchemas({ input: DevcontainerPreparationInputSchema, launch: DevcontainerReviewQuerySchema,
  artifact: DevcontainerPreparedImageSchema, nativeOperation: DevcontainerPreparationOperationSchema });
const processAccess = 'devcontainer-process';
const devcontainerDependencyId = 'devcontainer-cli';
const defaults = { scopes: ['machine'], surfaces: ['cli', 'plugin'], hostAccess: [processAccess] } as const;
function code(error: unknown) { return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : 'provider_unavailable'; }
type NativeSelection = Readonly<{ runtime?: 'docker' | 'podman'; configPath?: string; configuration?: { kind: string } }>;
class MissingDependency extends Error {
  readonly code = 'provider_unavailable';
  constructor(readonly dependencyId: 'docker' | 'podman' | 'devcontainer-cli') { super('Container prerequisite unavailable'); }
}
function unavailable(error: unknown): MachineProvisionerCheckResultV1 {
  const failure = { available: false, code: code(error) };
  if (!(error instanceof MissingDependency)) return failure;
  const recipeRepair = error.dependencyId === 'docker' && platform() === 'linux';
  return { ...failure, prerequisites: [{
    requirement: { kind: 'managedDependency' as const, id: { pluginId: DEVCONTAINER_PLUGIN_ID, localId: error.dependencyId } },
    status: 'unavailable' as const,
    ...(recipeRepair ? { setupSources: dockerRuntimeRepairSources() } : {}),
    repairAction: { action: { pluginId: DEVCONTAINER_PLUGIN_ID,
      localId: error.dependencyId === devcontainerDependencyId ? 'install-cli' : recipeRepair ? 'install-runtime' : 'runtime-install-docs' },
      input: error.dependencyId === devcontainerDependencyId || recipeRepair ? {} : { runtime: error.dependencyId } },
  }] };
}
async function provider(context: PluginInvocationContext, selection?: NativeSelection) {
  return createDevcontainerProvider(await nativeTools(context, selection));
}
async function preparation(context: PluginInvocationContext, runtime?: 'docker' | 'podman') {
  return createDevcontainerPreparation(await nativeTools(context, { runtime }));
}
async function nativeTools(context: PluginInvocationContext, selection?: NativeSelection) {
  const executable = async (id: 'docker' | 'podman' | 'devcontainer-cli') => {
    const status = await context.services.managedServices.dependencies.status(id, { signal: context.signal });
    if ((status.state !== 'ready' && status.state !== 'updateAvailable') || !status.executable) throw new MissingDependency(id);
    return status.executable;
  };
  const docker = await executable(selection?.runtime ?? 'docker');
  const advanced = selection && selection.configuration?.kind !== 'image' && (selection.configuration || selection.configPath !== undefined);
  const devcontainer = advanced ? await executable(devcontainerDependencyId) : undefined;
  return { exec: context.services.exec, docker,
    ...(devcontainer ? { devcontainer } : {}), signal: context.signal, observedAt: context.invokedAtMs,
    environment: readDevcontainerNativeEnvironment() };
}
function bytes(value: string) {
  return Buffer.from(value, 'base64');
}
export const DEVCONTAINER_MACHINE_PROVISIONER = {
  title: 'Docker container', icon: 'cube', resourceKind: 'devcontainer', schemaVersion: 1,
  description: 'A container from any image, using Docker or Podman.',
  enrollmentRole: 'sandbox',
  launchSchema: DevcontainerReviewQuerySchema.jsonSchema, resourceSchema: DevcontainerResourceSchema.jsonSchema,
  platforms: ['darwin', 'linux', 'win32'],
  // Arbitrary images and authored devcontainers do not guarantee the kernel
  // privileges needed by an Agent's nested native sandbox.
  sessionPlacement: { kind: 'controller-local', supportsAgentNativeSandbox: false },
  prerequisites: [],
  billing: { location: 'local', stoppedBilling: 'not-billed' },
  retention: { supportedIntents: ['start', 'stop', 'delete', 'rebuild'] },
  resize: { cpuCores: { kind: 'supported', requiresRestart: false, changes: 'any' },
    memoryBytes: { kind: 'supported', requiresRestart: false, changes: 'any' },
    diskBytes: { kind: 'unsupported', code: 'container_disk_resize_unsupported' } },
  actions: { check: 'check', options: 'options', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', power: 'power', destroy: 'destroy', rebuild: 'rebuild', resize: 'resize' },
  bootstrapTransport: { kind: 'native', exec: 'exec', putFile: 'put-file', stream: 'stream' },
  reconciliation: { nativeOperationSchema: DevcontainerNativeOperationSchema.jsonSchema, action: 'reconcile' },
  preparation: { inputSchema: DevcontainerPreparationInputSchema.jsonSchema, artifactSchema: DevcontainerPreparedImageSchema.jsonSchema,
    nativeOperationSchema: DevcontainerPreparationOperationSchema.jsonSchema,
    artifactLaunchPath: 'launch',
    actions: { build: 'prepare-build', inspect: 'prepare-inspect', destroy: 'prepare-destroy' } },
} satisfies MachineProvisionerAuthorDefinitionV1;

export const DEVCONTAINER_PLUGIN = definePlugin({
  id: DEVCONTAINER_PLUGIN_ID, version: '0.0.0', displayName: 'Docker container Machines' satisfies PluginLocalizedStringV2,
  description: 'Ordinary managed children on their physical Docker controller.', entrypoints: { daemon: './.happier-plugin-build/daemon.js' },
  hostAccess: { required: [{ id: processAccess, capability: 'process', reason: 'Realize and manage the reviewed Devcontainer on this controller.',
    scope: { executables: [{ kind: 'managedDependency', id: 'docker' }, { kind: 'managedDependency', id: 'podman' }, { kind: 'managedDependency', id: devcontainerDependencyId }] } }], optional: [] },
  managedDependencies: {
    docker: { id: 'docker', title: 'Docker', executable: 'docker', sources: [{ kind: 'system', executableNames: ['docker'], versionArguments: ['--version'] }] },
    podman: { id: 'podman', title: 'Podman', executable: 'podman', sources: [{ kind: 'system', executableNames: ['podman'], versionArguments: ['--version'] }] },
    [devcontainerDependencyId]: { id: devcontainerDependencyId, title: 'Dev Containers CLI', executable: 'devcontainer',
      sources: [{ kind: 'managedJavaScriptPackage', installId: 'dep.devcontainer-cli', packageName: '@devcontainers/cli', version: '0.90.0' }] },
  },
  machineProvisioners: { [DEVCONTAINER_PROVISIONER_ID]: DEVCONTAINER_MACHINE_PROVISIONER },
  actions: {
    'prepare-build': { ...defaults, title: 'Prepare container image', dangerLevel: 'writesLocal',
      confirmation: { title: 'Build this prepared container image?' },
      inputSchema: preparationSchemas.buildInput, resultSchema: preparationSchemas.buildResult,
      async run(input, context) {
        try {
          const resolved = resolveDevcontainerPreparationInput(input.input);
          return await (await preparation(context, resolved.launch.runtime)).build(input.operationId, resolved);
        }
        catch (error) { return { kind: 'refused' as const, code: code(error) }; }
      } },
    'prepare-inspect': { ...defaults, title: 'Inspect prepared container image', dangerLevel: 'safe',
      inputSchema: preparationSchemas.inspectInput, resultSchema: preparationSchemas.inspectResult,
      async run(input, context) {
        const operation = 'nativeOperation' in input ? input.nativeOperation.value
          : devcontainerPreparationOperation(input.operationId, { launch: input.launch });
        try { return await (await preparation(context, operation.runtime)).inspect(operation); }
        catch (error) { return { kind: 'unknown' as const, code: code(error), nativeOperationRef: {
          contributionRef: { pluginId: DEVCONTAINER_PLUGIN_ID, localId: DEVCONTAINER_PROVISIONER_ID }, schemaVersion: 1, value: operation,
        } }; }
      } },
    'prepare-destroy': { ...defaults, title: 'Delete owned prepared container image', dangerLevel: 'destructive',
      confirmation: { title: 'Delete this prepared container image?' },
      inputSchema: preparationSchemas.destroyInput, resultSchema: preparationSchemas.destroyResult,
      async run(input, context) {
        const reference = input.artifact ?? input.nativeOperation!;
        try { return await (await preparation(context, reference.value.runtime)).destroy(reference.value); }
        catch (error) { return { kind: 'unknown' as const, code: code(error), nativeOperationRef: reference }; }
      } },
    'install-runtime': { title: 'Set up Docker Engine', scopes: ['machine'], surfaces: ['ui', 'agent', 'mcp', 'cli', 'plugin'],
      execution: { target: 'daemon' }, dangerLevel: 'writesLocal',
      confirmation: { title: 'Set up Docker Engine on this computer?', confirmLabel: 'Set up' },
      inputSchema: DockerRuntimeRepairInputSchema, resultSchema: defineProtocolJsonValue(),
      async run(input, context) {
        // The host validates this JSON input against the recipe-owned mode schema.
        return installDockerRuntime(context, input as DockerRuntimeRepairInput);
      } },
    'runtime-install-docs': { title: 'Install a container runtime', surfaces: ['ui', 'agent', 'mcp', 'cli', 'plugin'], dangerLevel: 'safe',
      execution: { target: 'client', client: { artifactId: 'runtime-install', exportName: 'activate' }, platforms: ['web', 'ios', 'android'] },
      inputSchema: defineProtocolObject({ runtime: DevcontainerRuntimeSchema }, { policy: 'closed' }),
      resultSchema: defineProtocolUnion([defineProtocolLiteral(null), defineProtocolObject({ url: defineProtocolString() }, { policy: 'closed' })]) },
    'install-cli': { title: 'Install Dev Containers CLI', scopes: ['machine'], surfaces: ['ui', 'agent', 'mcp', 'cli', 'plugin'], execution: { target: 'daemon' }, dangerLevel: 'writesLocal',
      confirmation: { title: 'Install Dev Containers CLI on this computer?', confirmLabel: 'Install' },
      inputSchema: DEVCONTAINER_ROLE_SCHEMAS.checkInput, resultSchema: defineProtocolLiteral(null),
      async run(_input, context) { await context.services.managedServices.dependencies.ensure(devcontainerDependencyId, { signal: context.signal }); return null; } },
    options: { ...defaults, title: 'Review Devcontainer effects', dangerLevel: 'safe',
      inputSchema: DevcontainerReviewQuerySchema, resultSchema: MachineProvisionerOptionsResultV1Schema,
      inputHints: { fields: [
        // The image is the one thing the form asks; everything else keeps a default and sits under Advanced.
        { path: 'configuration.image', title: 'Container image', widget: 'text', description: 'Any image this computer can pull, for example ubuntu:24.04.',
          visibleWhen: { op: 'eq', path: 'configuration.kind', value: 'image' }, requiredWhen: { op: 'eq', path: 'configuration.kind', value: 'image' } },
        { path: 'configuration.setupScript', title: 'Setup script', widget: 'textarea',
          description: 'Runs inside the container before it joins.', visibleWhen: { op: 'eq', path: 'configuration.kind', value: 'image' } },
        { path: 'runtime', title: 'Container runtime', widget: 'select', defaultValue: 'docker', options: [
          { value: 'docker', label: 'Docker' }, { value: 'podman', label: 'Podman' },
        ] },
        { path: 'workspaceFolder', title: 'Project folder on this computer', widget: 'text',
          description: 'Leave empty to keep files in the container. A folder here is shared with the container.',
          requiredWhen: { op: 'not', predicate: { op: 'eq', path: 'configuration.kind', value: 'image' } } },
        { path: 'configuration.kind', title: 'Build from', widget: 'select', defaultValue: 'image', options: [
          { value: 'image', label: 'Container image' }, { value: 'file', label: 'An existing devcontainer.json' }, { value: 'inline', label: 'Devcontainer JSON' },
        ] },
        { path: 'configPath', title: 'devcontainer.json path on this computer', widget: 'text',
          visibleWhen: { op: 'or', any: [{ op: 'eq', path: 'configuration.kind', value: 'file' }, { op: 'not', predicate: { op: 'truthy', path: 'configuration.kind' } }] },
          requiredWhen: { op: 'or', any: [{ op: 'eq', path: 'configuration.kind', value: 'file' }, { op: 'not', predicate: { op: 'truthy', path: 'configuration.kind' } }] } },
        { path: 'configuration.config', title: 'Devcontainer configuration', description: 'JSON or JSONC. Relative paths resolve from the workspace .devcontainer folder.', widget: 'textarea',
          visibleWhen: { op: 'eq', path: 'configuration.kind', value: 'inline' }, requiredWhen: { op: 'eq', path: 'configuration.kind', value: 'inline' } },
      ] },
      async run(input, context) {
        const dimensions = { size: [], image: [], location: [], network: [], duration: [] };
        try {
          const reviewed = await readDevcontainerEffectReview(await nativeTools(context, input), input);
          // An image launch names its image, the native fact a receipt and review say for a local machine.
          const image = input.configuration?.kind === 'image' ? input.configuration.image : undefined;
          return { base: { available: true, prerequisites: [], guestPlatform: 'linux' as const,
            launch: input, effectReview: reviewed.effectReview,
            ...(image ? { nativeFacts: { image: { id: image, title: image },
              ...('preparationGuest' in reviewed && reviewed.preparationGuest ? { preparationGuest: reviewed.preparationGuest } : {}) } } : {}) }, dimensions };
        } catch (error) {
          if (!(error instanceof MissingDependency)) throw error;
          return { base: { launch: input, available: false,
            prerequisites: unavailable(error).prerequisites, guestPlatform: 'linux' as const,
            unavailableReason: { code: 'provider_unavailable', status: error.dependencyId === devcontainerDependencyId
              ? 'Install Dev Containers CLI to use a devcontainer.json configuration.'
              : `Install ${error.dependencyId === 'podman' ? 'Podman' : 'Docker'} on this computer.` } }, dimensions };
        }
      } },
    check: { ...defaults, title: 'Check Devcontainer availability', dangerLevel: 'safe', inputSchema: DEVCONTAINER_ROLE_SCHEMAS.checkInput,
      resultSchema: MachineProvisionerCheckResultV1Schema,
      async run(_input, context) {
        const checkRuntime = async (runtime: 'docker' | 'podman') => {
          try { return await (await provider(context, { runtime })).check(); }
          catch (error) { return unavailable(error); }
        };
        const docker = await checkRuntime('docker');
        if (docker.available) return docker;
        const podman = await checkRuntime('podman');
        return podman.available ? podman : docker;
      } },
    acquire: { ...defaults, title: 'Realize Devcontainer child', dangerLevel: 'writesLocal', inputSchema: DEVCONTAINER_ROLE_SCHEMAS.acquireInput,
      confirmation: { title: 'Create Devcontainer', body: 'Runs the reviewed host and child setup hooks on this controller.', confirmLabel: 'Create' },
      resultSchema: DEVCONTAINER_RECONCILIATION_SCHEMAS.result,
      async run(input, context) { try {
        return await (await provider(context, input.launch)).acquire({ ...input.launch,
          ...(input.reviewedEffectDigest ? { reviewedEffectDigest: input.reviewedEffectDigest } : {}) }, input.managedId ?? '', input.guestHome);
      }
        catch (error) { return { kind: 'unknown' as const, recovery: { reference: input.launch.configPath ?? input.managedId ?? '', reason: code(error) } }; } } },
    bootstrap: { ...defaults, title: 'Resolve private child enrollment transport', dangerLevel: 'writesLocal',
      confirmation: { title: 'Prepare Devcontainer enrollment' },
      inputSchema: DEVCONTAINER_ROLE_SCHEMAS.bootstrapInput, resultSchema: MachineProvisionerBootstrapCarrierV1Schema,
      async run(input, context) { return (await provider(context, input.resource)).bootstrap(input.resource); } },
    inspect: { ...defaults, title: 'Inspect retained Devcontainer', dangerLevel: 'safe', inputSchema: DEVCONTAINER_ROLE_SCHEMAS.resourceInput,
      resultSchema: MachineProvisionerObservationV1Schema,
      async run(input, context) { try { return await (await provider(context, input.resource)).inspect(input.resource); }
        catch (error) { return { observedAt: context.invokedAtMs, availability: 'unavailable' as const, reason: code(error) }; } } },
    resize: { ...defaults, title: 'Resize container', dangerLevel: 'writesLocal', inputSchema: DEVCONTAINER_ROLE_SCHEMAS.resizeInput,
      confirmation: { title: 'Resize this container?' }, resultSchema: MachineProvisionerResizeResultV1Schema,
      async run(input, context) {
        try { return await (await provider(context, { runtime: input.resource.runtime })).resize(input.resource, input.size); }
        catch (error) { return { kind: 'refused' as const, code: code(error) }; }
      } },
    power: { ...defaults, title: 'Change Devcontainer power', dangerLevel: 'writesLocal', inputSchema: DEVCONTAINER_ROLE_SCHEMAS.powerInput,
      confirmation: { title: 'Change Devcontainer power' },
      resultSchema: MachineProvisionerPowerResultV1Schema,
      async run(input, context) {
        if (input.intent !== 'start' && input.intent !== 'stop') return { kind: 'refused' as const, code: 'unsupported_intent' };
        try { return await (await provider(context, input.resource)).power(input.resource, input.intent); }
        catch (error) { return { kind: 'unknown' as const, code: code(error) }; }
      } },
    destroy: { ...defaults, title: 'Delete exact Devcontainer installation', dangerLevel: 'destructive',
      confirmation: { title: 'Delete Devcontainer', body: 'Deletes this container, preserving bind-mounted sources and named volumes.', confirmLabel: 'Delete' },
      inputSchema: DEVCONTAINER_RECONCILIATION_SCHEMAS.destroyInput, resultSchema: MachineProvisionerPowerResultV1Schema,
      async run(input, context) {
        const operation = 'resource' in input ? input.resource : input.nativeOperation;
        const selection = 'launch' in operation ? operation.launch : operation;
        try { return await (await provider(context, { runtime: selection.runtime })).destroy(operation); }
        catch (error) { return { kind: 'unknown' as const, code: code(error) }; } } },
    rebuild: { ...defaults, title: 'Rebuild exact Devcontainer installation', dangerLevel: 'destructive',
      confirmation: { title: 'Rebuild Devcontainer', body: 'Replaces this container and runs the reviewed host and child setup hooks.', confirmLabel: 'Rebuild' },
      inputSchema: DEVCONTAINER_ROLE_SCHEMAS.rebuildInput, resultSchema: DEVCONTAINER_ROLE_SCHEMAS.rebuildResult,
      async run(input, context) { return (await provider(context, input.resource)).rebuild(input.resource, input.reviewedEffectDigest, input.guestHome); } },
    reconcile: { ...defaults, title: 'Observe Devcontainer replacement', dangerLevel: 'safe',
      inputSchema: DEVCONTAINER_RECONCILIATION_SCHEMAS.input, resultSchema: DEVCONTAINER_RECONCILIATION_SCHEMAS.result,
      async run(input, context) {
        if (!('nativeOperation' in input)) {
          try { return await (await provider(context, { runtime: input.correlation.launch.runtime })).reconcileAcquisition(input.correlation.managedId); }
          catch (error) { return { kind: 'unknown' as const, recovery: { reference: input.correlation.managedId, reason: code(error) } }; }
        }
        const selection = 'launch' in input.nativeOperation ? input.nativeOperation.launch : input.nativeOperation;
        return (await provider(context, selection)).reconcile(input.nativeOperation); } },
    exec: { ...defaults, title: 'Execute private child bootstrap IO', dangerLevel: 'writesLocal',
      confirmation: { title: 'Execute Devcontainer enrollment' },
      inputSchema: DEVCONTAINER_ROLE_SCHEMAS.execInput, resultSchema: MachineProvisionerNativeExecResultV1Schema,
      async run(input, context) {
        const result = await (await provider(context, input.resource)).exec(input.resource, input.argv,
          input.inputBase64 === undefined ? undefined : bytes(input.inputBase64));
        return { termination: result.termination, stdoutBase64: Buffer.from(result.stdout).toString('base64'),
          stderrBase64: Buffer.from(result.stderr).toString('base64'), stdoutTruncated: result.stdoutTruncated, stderrTruncated: result.stderrTruncated };
      } },
    stream: { ...defaults, title: 'Open a private child channel', dangerLevel: 'writesLocal',
      confirmation: { title: 'Open a Devcontainer channel' },
      inputSchema: DEVCONTAINER_ROLE_SCHEMAS.streamInput, resultSchema: MachineProvisionerNativeStreamResultV1Schema,
      async run(input, context) {
        const channel = await (await provider(context, input.resource)).stream(input.resource, input.argv);
        try { return { termination: await channel.waitForExit() }; } finally { await channel.dispose(); }
      } },
    'put-file': { ...defaults, title: 'Write private child bootstrap payload', dangerLevel: 'writesLocal',
      confirmation: { title: 'Write Devcontainer enrollment payload' },
      inputSchema: DEVCONTAINER_ROLE_SCHEMAS.putFileInput, resultSchema: MachineProvisionerPowerResultV1Schema,
      async run(input, context) { return (await provider(context, input.resource)).putFile(input.resource, input.guestPath, bytes(input.bytesBase64), input.mode); } },
  },
});
export const PLUGIN_MANIFEST = DEVCONTAINER_PLUGIN.manifest;
