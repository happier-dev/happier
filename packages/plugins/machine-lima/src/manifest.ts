import { Buffer } from 'node:buffer';
import { defineProtocolLiteral } from '@happier-dev/plugin-sdk/protocol';
import { machinePresentationLabel, machineCheckPresentation } from './ui/translations.js';
import { definePlugin } from '@happier-dev/plugin-sdk';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import {
  observeMachineProvisionerNativeRead,
  projectMachineProvisionerActionFailure,
  defineMachineProvisionerSchemas,
  defineMachineProvisionerReconciliationSchemas,
  MachineProvisionerBootstrapCarrierV1Schema, MachineProvisionerCheckResultV1Schema,
  MachineProvisionerNativeExecResultV1Schema, MachineProvisionerNativeStreamResultV1Schema, MachineProvisionerObservationV1Schema,
  MachineProvisionerOptionsResultV1Schema,
  MachineProvisionerPowerResultV1Schema, MachineProvisionerPutFileResultV1Schema,
  MachineProvisionerResizeResultV1Schema,
} from '@happier-dev/plugin-sdk/machine-provisioners';
import type { MachineProvisionerAuthorDefinitionV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import { createLimaSdkExecutor } from './machine/nativeExecutor.js';
import { limaArchiveSource } from './machine/dependency.js';
import { createLimaProvider, limaAcquisitionResource, LIMA_DEPENDENCY_ID, LIMA_PLUGIN_ID, LIMA_PROVISIONER_ID, LIMA_QEMU_DEPENDENCY_IDS } from './machine/provider.js';
import { LimaLaunchSchema, LimaOptionsInputSchema, LimaResourceSchema } from './machine/schemas.js';
import { createLimaPreparationClient, LimaPreparationInputSchema, LimaPreparedArtifactSchema, LimaPreparationOperationSchema, PREPARATION_SCHEMAS } from './machine/preparation.js';

export const LIMA_ROLE_SCHEMAS = defineMachineProvisionerSchemas({ launch: LimaLaunchSchema, resource: LimaResourceSchema });
export const LIMA_RECONCILIATION_SCHEMAS = defineMachineProvisionerReconciliationSchemas({
  launch: LimaLaunchSchema, resource: LimaResourceSchema, nativeOperation: LimaResourceSchema,
});
const processAccess = 'lima-process';
const actionDefaults = { scopes: ['machine'], surfaces: ['cli', 'plugin'], hostAccess: [processAccess] } as const;

function errorCode(error: unknown) {
  return error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code : 'lima_unavailable';
}

async function provider(context: PluginInvocationContext) {
  // Checking never installs or mutates a managed dependency. Executable identity
  // is resolved by the public dependency owner, never a host-specific path.
  const status = await context.services.managedServices.dependencies.status(LIMA_DEPENDENCY_ID, { signal: context.signal });
  if ((status.state !== 'ready' && status.state !== 'updateAvailable') || !status.executable) {
    throw Object.assign(new Error('declared native Lima executable is unavailable'), { code: 'lima_unavailable' });
  }
  const executor = createLimaSdkExecutor({ exec: context.services.exec, executable: status.executable, signal: context.signal });
  const current = createLimaProvider(executor, context.invokedAtMs,
    async (dependencyId) => {
      const tool = await context.services.managedServices.dependencies.status(dependencyId, { signal: context.signal });
      return (tool.state === 'ready' || tool.state === 'updateAvailable') && tool.executable !== undefined;
    });
  return { ...current, preparation: createLimaPreparationClient(executor, current) };
}

export const LIMA_MACHINE_PROVISIONER = {
  title: 'Lima', icon: 'terminal', resourceKind: 'lima-vm', schemaVersion: 1,
  enrollmentRole: 'server',
  kindTitle: machinePresentationLabel('kind'), description: machinePresentationLabel('description'),
  launchSchema: LimaLaunchSchema.jsonSchema, resourceSchema: LimaResourceSchema.jsonSchema, resourceIdPath: 'instance',
  platforms: ['darwin', 'linux'],
  // These are full Linux VMs, including on macOS; Agent isolation runs in
  // the guest kernel rather than nesting inside a restricted container.
  sessionPlacement: { kind: 'controller-local', supportsAgentNativeSandbox: true },
  prerequisites: [{ kind: 'managedDependency', id: LIMA_DEPENDENCY_ID }],
  billing: { location: 'local', stoppedBilling: 'not-billed' },
  retention: { supportedIntents: ['start', 'stop', 'delete'] },
  resize: { cpuCores: { kind: 'supported', requiresRestart: true, changes: 'any' },
    memoryBytes: { kind: 'supported', requiresRestart: true, changes: 'any' },
    diskBytes: { kind: 'supported', requiresRestart: true, changes: 'grow-only' } },
  actions: { check: 'check', options: 'options', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', power: 'power', destroy: 'destroy', resize: 'resize' },
  reconciliation: { action: 'reconcile', nativeOperationSchema: LimaResourceSchema.jsonSchema },
  bootstrapTransport: { kind: 'native', exec: 'exec', putFile: 'put-file', stream: 'stream' },
  preparation: { inputSchema: LimaPreparationInputSchema.jsonSchema, artifactSchema: LimaPreparedArtifactSchema.jsonSchema,
    nativeOperationSchema: LimaPreparationOperationSchema.jsonSchema, artifactLaunchPath: 'launch',
    actions: { build: 'prepare-build', inspect: 'prepare-inspect', destroy: 'prepare-destroy' } },
} satisfies MachineProvisionerAuthorDefinitionV1;

export const LIMA_PLUGIN = definePlugin({
  id: LIMA_PLUGIN_ID, version: '0.0.0', displayName: 'Lima Machines',
  description: 'Managed local Lima guests using native, private bootstrap IO.',
  brand: { iconResourceId: 'brand-icon', monochrome: true },
  resources: {
    'brand-icon': { kind: 'asset', path: 'assets/brand.png', contentType: 'image/png' },
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
  entrypoints: { daemon: './.happier-plugin-build/daemon.js' },
  hostAccess: { required: [{ id: processAccess, capability: 'process',
    reason: 'Operate the exact reviewed native Lima resource.',
    scope: { executables: [{ kind: 'managedDependency', id: LIMA_DEPENDENCY_ID }],
      // Lima initializes its native home even for --version; guest operations
      // also discover native tools on PATH and select their reviewed store.
      envKeys: ['HOME', 'PATH', 'LIMA_HOME'] },
  }], optional: [] },
  managedDependencies: { [LIMA_DEPENDENCY_ID]: {
    id: LIMA_DEPENDENCY_ID, title: 'Lima', description: 'Native Lima 2.x executable.', executable: 'limactl',
    platforms: ['macos', 'linux'], architectures: ['x64', 'arm64'],
    sources: [{ kind: 'system', executableNames: ['limactl'], versionArguments: ['--version'] }, limaArchiveSource],
  }, [LIMA_QEMU_DEPENDENCY_IDS.x86_64]: {
    id: LIMA_QEMU_DEPENDENCY_IDS.x86_64, title: 'QEMU x86-64', executable: 'qemu-system-x86_64',
    sources: [{ kind: 'system', executableNames: ['qemu-system-x86_64'], versionArguments: ['--version'] }],
  }, [LIMA_QEMU_DEPENDENCY_IDS.aarch64]: {
    id: LIMA_QEMU_DEPENDENCY_IDS.aarch64, title: 'QEMU AArch64', executable: 'qemu-system-aarch64',
    sources: [{ kind: 'system', executableNames: ['qemu-system-aarch64'], versionArguments: ['--version'] }],
  }, 'qemu-img': {
    id: 'qemu-img', title: 'QEMU disk image tool', executable: 'qemu-img',
    sources: [{ kind: 'system', executableNames: ['qemu-img'], versionArguments: ['--version'] }],
  } },
  ui: { translations: [
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
  machineProvisioners: { [LIMA_PROVISIONER_ID]: LIMA_MACHINE_PROVISIONER },
  actions: {
    'prepare-build': { ...actionDefaults, title: 'Build Lima prepared base', dangerLevel: 'writesLocal',
      confirmation: { title: 'Prepare this Lima base?', body: 'This creates a VM, installs the selected CLI and setup, then retains its stopped disk. It uses CPU, network and local disk storage.' },
      inputSchema: PREPARATION_SCHEMAS.buildInput, resultSchema: PREPARATION_SCHEMAS.buildResult,
      async run(input, context) { return (await provider(context)).preparation.build(input); } },
    'prepare-inspect': { ...actionDefaults, title: 'Inspect Lima prepared base', dangerLevel: 'safe',
      inputSchema: PREPARATION_SCHEMAS.inspectInput, resultSchema: PREPARATION_SCHEMAS.inspectResult,
      async run(input, context) { return (await provider(context)).preparation.inspect('nativeOperation' in input
        ? { nativeOperation: input.nativeOperation.value } : input); } },
    'prepare-destroy': { ...actionDefaults, title: 'Delete Lima prepared base', dangerLevel: 'destructive',
      confirmation: { title: 'Delete this Lima prepared base?', body: 'This permanently removes the exact owned base disk. Existing Session clones are retained.' },
      inputSchema: PREPARATION_SCHEMAS.destroyInput, resultSchema: PREPARATION_SCHEMAS.destroyResult,
      async run(input, context) { return (await provider(context)).preparation.destroy({
        ...(input.artifact === undefined ? {} : { artifact: input.artifact.value }),
        ...(input.nativeOperation === undefined ? {} : { nativeOperation: input.nativeOperation.value }),
      }); } },
    install: {
      title: 'Install Lima', scopes: ['machine'], surfaces: ['ui', 'agent', 'mcp', 'cli', 'plugin'],
      execution: { target: 'daemon' }, dangerLevel: 'writesLocal',
      confirmation: { title: 'Install Lima on this computer?', confirmLabel: 'Install' },
      inputSchema: LIMA_ROLE_SCHEMAS.checkInput, resultSchema: defineProtocolLiteral(null),
      async run(_input, context) {
        await context.services.managedServices.dependencies.ensure(LIMA_DEPENDENCY_ID, { signal: context.signal });
        return null;
      },
    },
    check: {
      ...actionDefaults, title: 'Check Lima availability', dangerLevel: 'safe',
      inputSchema: LIMA_ROLE_SCHEMAS.checkInput, resultSchema: MachineProvisionerCheckResultV1Schema,
      async run(_input, context) {
        try { return machineCheckPresentation(await (await provider(context)).check()); }
        catch (error) {
          return projectMachineProvisionerActionFailure(error, () => {
            const code = errorCode(error);
            // The missing executable is a prerequisite, so the picker treats it like every other tool that isn't installed.
            return machineCheckPresentation({ available: false, code, ...(code === 'lima_unavailable' ? { prerequisites: [{
              requirement: { kind: 'managedDependency' as const, id: { pluginId: LIMA_PLUGIN_ID, localId: LIMA_DEPENDENCY_ID } },
              status: 'unavailable' as const,
              repairAction: { action: { pluginId: LIMA_PLUGIN_ID, localId: 'install' }, input: {} } }] } : {}) });
          });
        }
      },
    },
    options: {
      ...actionDefaults, title: 'Read Lima launch choices', dangerLevel: 'safe',
      inputSchema: LimaOptionsInputSchema, resultSchema: MachineProvisionerOptionsResultV1Schema,
      inputHints: { fields: [
        { path: 'store', title: 'Lima store', widget: 'text', required: true },
        { path: 'image', title: 'Image location', widget: 'text', required: true,
          description: 'Enter a disk image URL or path when Lima does not report one in its default template.' },
        { path: 'arch', title: 'Architecture', widget: 'select', required: true, requireExplicitSelection: true,
          options: [{ value: 'x86_64', label: 'x86_64' }, { value: 'aarch64', label: 'aarch64' }] },
        { path: 'vmType', title: 'VM driver', widget: 'select', required: true, requireExplicitSelection: true,
          options: [{ value: 'qemu', label: 'QEMU' }, { value: 'vz', label: 'VZ' }] },
        { path: 'cpus', role: 'cpu', title: 'CPU cores', widget: 'integer', required: true },
        { path: 'memoryGiB', role: 'memory', title: 'Memory (GiB)', widget: 'integer', required: true },
        { path: 'diskGiB', role: 'disk', title: 'Disk (GiB)', widget: 'integer', required: true },
      ] },
      async run(input, context) { return (await provider(context)).options(input); },
    },
    acquire: {
      ...actionDefaults, title: 'Acquire Lima guest', dangerLevel: 'writesLocal',
      confirmation: { title: 'Create this Lima guest?', body: 'This creates the reviewed VM in the selected Lima storage.' },
      inputSchema: LIMA_ROLE_SCHEMAS.acquireInput, resultSchema: LIMA_RECONCILIATION_SCHEMAS.result,
      async run(input, context) {
        try { return await (await provider(context)).acquire(input); }
        catch (error) { return projectMachineProvisionerActionFailure(error, () => ({ kind: 'unknown' as const,
          recovery: { reference: input.managedId === undefined ? input.launch.store
            : `${input.launch.store}/${limaAcquisitionResource(input.launch, input.managedId).instance}`, reason: errorCode(error) } })); }
      },
    },
    reconcile: {
      ...actionDefaults, title: 'Recover exact Lima guest', dangerLevel: 'safe',
      inputSchema: LIMA_RECONCILIATION_SCHEMAS.input, resultSchema: LIMA_RECONCILIATION_SCHEMAS.result,
      async run(input, context) {
        const current = await provider(context);
        return 'nativeOperation' in input ? current.reconcile({ resource: input.nativeOperation })
          : current.reconcile({ managedId: input.correlation.managedId, launch: input.correlation.launch });
      },
    },
    bootstrap: {
      ...actionDefaults, title: 'Resolve private Lima bootstrap transport', dangerLevel: 'writesLocal',
      confirmation: { title: 'Prepare this Lima guest for Happier?', body: 'Allow Happier to use the private native transport for this managed guest.' },
      inputSchema: LIMA_ROLE_SCHEMAS.bootstrapInput, resultSchema: MachineProvisionerBootstrapCarrierV1Schema,
      async run(input, context) { return (await provider(context)).bootstrap(input.resource); },
    },
    inspect: {
      ...actionDefaults, title: 'Inspect Lima guest', dangerLevel: 'safe',
      inputSchema: LIMA_ROLE_SCHEMAS.resourceInput, resultSchema: MachineProvisionerObservationV1Schema,
      async run(input, context) {
        try { return await (await provider(context)).inspect(input.resource); }
        catch (error) { return projectMachineProvisionerActionFailure(error,
          () => observeMachineProvisionerNativeRead(context.invokedAtMs, { kind: 'unknown', reason: errorCode(error) })); }
      },
    },
    resize: {
      ...actionDefaults, title: 'Resize Lima guest', dangerLevel: 'writesLocal',
      confirmation: { title: 'Resize this Lima guest?', body: 'This changes the exact managed VM configuration. A restart applies the new size.' },
      inputSchema: LIMA_ROLE_SCHEMAS.resizeInput, resultSchema: MachineProvisionerResizeResultV1Schema,
      async run(input, context) {
        try { return await (await provider(context)).resize(input.resource, input.size); }
        catch (error) { return projectMachineProvisionerActionFailure(error, () => ({ kind: 'refused' as const, code: errorCode(error) })); }
      },
    },
    power: {
      ...actionDefaults, title: 'Change Lima guest power', dangerLevel: 'writesLocal',
      confirmation: { title: 'Change this Lima guest’s power?', body: 'This starts or stops the exact managed VM. Stop does not preserve running memory.' },
      inputSchema: LIMA_ROLE_SCHEMAS.powerInput, resultSchema: MachineProvisionerPowerResultV1Schema,
      async run(input, context) {
        if (input.intent !== 'start' && input.intent !== 'stop') return { kind: 'refused' as const, code: 'LIMA_UNSUPPORTED_INTENT' };
        try { return await (await provider(context)).power(input.resource, input.intent); }
        catch (error) { return projectMachineProvisionerActionFailure(error, () => ({ kind: 'unknown' as const, code: errorCode(error) })); }
      },
    },
    destroy: {
      ...actionDefaults, title: 'Delete exact Lima guest', dangerLevel: 'destructive',
      confirmation: { title: 'Delete this Lima guest?', body: 'This permanently removes the exact managed VM and its disk from the recorded storage.' },
      inputSchema: LIMA_RECONCILIATION_SCHEMAS.destroyInput, resultSchema: LIMA_RECONCILIATION_SCHEMAS.destroyResult,
      async run(input, context) {
        try { return await (await provider(context)).destroy('resource' in input ? input.resource : input.nativeOperation); }
        catch (error) { return projectMachineProvisionerActionFailure(error, () => ({ kind: 'unknown' as const, code: errorCode(error) })); }
      },
    },
    exec: {
      ...actionDefaults, title: 'Execute private Lima bootstrap IO', dangerLevel: 'writesLocal',
      confirmation: { title: 'Run Happier setup in this Lima guest?', body: 'This runs the admitted setup command inside the exact managed guest.' },
      inputSchema: LIMA_ROLE_SCHEMAS.execInput, resultSchema: MachineProvisionerNativeExecResultV1Schema,
      async run(input, context) {
        const result = await (await provider(context)).exec(input.resource, input.argv,
          input.inputBase64 === undefined ? undefined : Buffer.from(input.inputBase64, 'base64'));
        return { termination: result.process.termination, stdoutBase64: Buffer.from(result.process.stdout).toString('base64'),
          stderrBase64: Buffer.from(result.process.stderr).toString('base64'),
          stdoutTruncated: result.process.stdoutTruncated, stderrTruncated: result.process.stderrTruncated };
      },
    },
    stream: {
      ...actionDefaults, title: 'Open a private Lima guest channel', dangerLevel: 'writesLocal',
      confirmation: { title: 'Open a channel into this Lima guest?', body: 'This runs one admitted command inside the exact managed guest for as long as the channel is open.' },
      inputSchema: LIMA_ROLE_SCHEMAS.streamInput, resultSchema: MachineProvisionerNativeStreamResultV1Schema,
      async run(input, context) {
        const channel = await (await provider(context)).stream(input.resource, input.argv);
        try { return { termination: await channel.waitForExit() }; } finally { await channel.dispose(); }
      },
    },
    'put-file': {
      ...actionDefaults, title: 'Write private Lima bootstrap file', dangerLevel: 'writesLocal',
      confirmation: { title: 'Write this Lima guest’s setup file?', body: 'This writes the private setup payload to its reviewed path inside the exact managed guest.' },
      inputSchema: LIMA_ROLE_SCHEMAS.putFileInput, resultSchema: MachineProvisionerPutFileResultV1Schema,
      async run(input, context) {
        try {
          // The shared role schema has already admitted the bounded encoding.
          // Do not re-encode another full fragment solely to validate it again.
          const result = await (await provider(context)).putFile(input.resource, input.guestPath, Buffer.from(input.bytesBase64, 'base64'),
            input.mode === undefined ? undefined : `0${input.mode.toString(8).padStart(3, '0')}`);
          return result.kind === 'written' ? { kind: 'confirmed' as const } : { kind: 'unknown' as const };
        } catch (error) {
          return projectMachineProvisionerActionFailure(error, () => {
            const code = errorCode(error);
            return { kind: code === 'invalid_request' || code === 'LIMA_INVALID_PATH' || code === 'resource_mismatch'
              ? 'refused' as const : 'unknown' as const, code };
          });
        }
      },
    },
  },
});

export const PLUGIN_MANIFEST = LIMA_PLUGIN.manifest;
