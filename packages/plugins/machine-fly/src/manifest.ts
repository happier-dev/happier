import { Buffer } from 'node:buffer';
import { machinePresentationLabel, machineCheckPresentation } from './ui/translations.js';
import { definePlugin, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 } from '@happier-dev/plugin-sdk/connected-accounts';
import type { ActionContribution } from '@happier-dev/plugin-sdk/actions';
import { defineMachineProvisionerSchemas, defineMachineProvisionerReconciliationSchemas, prepareMachineProvisionerStoredSchemas,
  MachineProvisionerBootstrapCarrierV1Schema, MachineProvisionerCheckResultV1Schema,
  MachineProvisionerObservationV1Schema, MachineProvisionerOptionsResultV1Schema,
  MachineProvisionerPowerResultV1Schema, MachineProvisionerNativeExecResultV1Schema, MachineProvisionerPutFileResultV1Schema,
  type MachineProvisionerAuthorDefinitionV1,
} from '@happier-dev/plugin-sdk/machine-provisioners';
import { createFlyNativeClient, isLaunchAvailable } from './machine/nativeClient.js';
import { FLY_DEFAULT_IMAGE, FLY_GUEST_BOOT, FlyLaunchQueryV1Schema, FlyLaunchV1Schema, FlyPendingAcquireV1Schema, FlyResourceV1Schema, resolveFlyLaunchQueryCandidate, type FlyAcquireOperationV1, type FlyLaunchV1 } from './machine/schemas.js';
import { ACCOUNT_ID, ACCOUNT_PURPOSE, connectedAccountRuntime, nativeFetch } from './account.js';
import { FLY_CONFIGURATION_LABELS, FLY_TRANSLATION_BUNDLES } from './ui/translations.js';

export const PLUGIN_ID = 'happier.machine.fly';
export const PROVISIONER_ID = 'fly';
export const ROLE_SCHEMAS = defineMachineProvisionerSchemas({ launch: FlyLaunchV1Schema, resource: FlyResourceV1Schema });
const reconciliation = defineMachineProvisionerReconciliationSchemas({ launch: FlyLaunchV1Schema, resource: FlyResourceV1Schema, nativeOperation: FlyPendingAcquireV1Schema });
export const prepareStoredSchemas = () => prepareMachineProvisionerStoredSchemas({ launch: FlyLaunchV1Schema, resource: FlyResourceV1Schema, nativeOperation: FlyPendingAcquireV1Schema });
function configurationLabel(id: keyof typeof FLY_CONFIGURATION_LABELS.en) {
  return { key: `machineFly.configure.${id}`, fallback: FLY_CONFIGURATION_LABELS.en[id] };
}
const optionsInputHints: NonNullable<ActionContribution['inputHints']> = { fields: [
  { path: 'app.ownership', title: configurationLabel('appOwnership'), widget: 'select', required: true,
    options: [{ value: 'created', label: configurationLabel('createApp') }, { value: 'existing', label: configurationLabel('existingApp') }] },
  { path: 'app.name', title: configurationLabel('appName'), widget: 'text', required: true },
  { path: 'app.organizationSlug', title: configurationLabel('organization'), widget: 'text', required: true,
    description: configurationLabel('organizationDescription'), visibleWhen: { op: 'eq', path: 'app.ownership', value: 'created' } },
  { path: 'region', title: configurationLabel('region'), widget: 'text', required: true },
  { path: 'imageReference', title: configurationLabel('image'), widget: 'text', placeholder: FLY_DEFAULT_IMAGE,
    description: configurationLabel('imageDescription') },
  { path: 'guest.cpuKind', title: configurationLabel('cpuKind'), widget: 'select', required: true,
    options: [{ value: 'shared', label: configurationLabel('shared') }, { value: 'performance', label: configurationLabel('performance') }] },
  { path: 'guest.cpus', title: configurationLabel('cpus'), widget: 'integer', required: true },
  { path: 'guest.memoryMb', title: configurationLabel('memory'), widget: 'integer', required: true },
  { path: 'volume.kind', title: configurationLabel('volumeKind'), widget: 'select', required: true,
    options: [{ value: 'create', label: configurationLabel('createVolume') }, { value: 'attach', label: configurationLabel('attachVolume') }] },
  { path: 'volume.sizeGb', title: configurationLabel('volumeSize'), widget: 'integer', required: true,
    visibleWhen: { op: 'eq', path: 'volume.kind', value: 'create' } },
  { path: 'volume.volumeId', title: configurationLabel('volumeId'), widget: 'text', required: true,
    visibleWhen: { op: 'eq', path: 'volume.kind', value: 'attach' } },
] };
const billing = { location: 'cloud', stoppedBilling: 'not-billed' } as const;
const defaults = { scopes: ['machine'], surfaces: ['cli', 'plugin'], hostAccess: ['native-api', ACCOUNT_PURPOSE] } as const;
const runtime = (context: PluginInvocationContext) => createFlyNativeClient('host-bound', nativeFetch(context), { signal: context.signal });
async function organization(context: PluginInvocationContext) {
  const material = await context.services.connectedAccounts.materialize(ACCOUNT_PURPOSE,
    { kind: 'environment', keys: ['FLY_ORGANIZATION'] }, { signal: context.signal });
  if (material.kind !== 'environment' || !material.env.FLY_ORGANIZATION) throw new Error('credential_unavailable');
  return material.env.FLY_ORGANIZATION;
}
function bytes(value: string) {
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) throw new Error('invalid_request');
  return decoded;
}
export const MACHINE_PROVISIONER = {
  title: 'Fly Machines', icon: 'hard-drives', resourceKind: 'fly-machine', schemaVersion: 1,
  kindTitle: machinePresentationLabel('kind'), description: machinePresentationLabel('description'),
  launchSchema: FlyLaunchV1Schema.jsonSchema, resourceSchema: FlyResourceV1Schema.jsonSchema,
  platforms: ['darwin', 'linux', 'win32'], prerequisites: [],
  billing, retention: { supportedIntents: ['start', 'stop', 'resume', 'suspend', 'delete'] },
  actions: { check: 'check', options: 'options', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', power: 'power', destroy: 'destroy' },
  bootstrapTransport: { kind: 'native', exec: 'exec', putFile: 'put-file' },
  reconciliation: { nativeOperationSchema: FlyPendingAcquireV1Schema.jsonSchema, action: 'reconcile', cleanup: 'observe-cleanup' },
} satisfies MachineProvisionerAuthorDefinitionV1;

export const PLUGIN = definePlugin({
  id: PLUGIN_ID, version: '0.0.0', displayName: 'Fly Machines',
  description: 'Native Fly Machine control and private buffered bootstrap IO.',
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 }, entrypoints: { daemon: './.happier-plugin/daemon.js' },
  hostAccess: { required: [
    { id: 'native-api', capability: 'network', reason: 'Operate exact reviewed Fly resources.',
      scope: { targets: [{ kind: 'fixedOrigin', origin: 'https://api.machines.dev' }, { kind: 'fixedOrigin', origin: 'https://api.fly.io' }], methods: ['GET', 'POST', 'DELETE'] } },
    { id: ACCOUNT_PURPOSE, capability: 'connectedAccounts', reason: 'Use only the captured Fly account and native organization.',
      scope: { serviceRefs: [ACCOUNT_ID], operations: ['use'], materializationKinds: ['httpHeaders', 'environment'] } },
  ], optional: [] },
  connectedAccountDescriptors: { [ACCOUNT_ID]: {
    declaration: { title: 'Fly cloud account', authentication: { defaultModeId: 'token', modes: [{
      id: 'token', kind: 'manual', title: 'API token', outcomeReconciliation: 'none',
      directExport: { contractVersion: CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 },
      fields: [{ id: 'token', title: 'API token', schema: { type: 'string', minLength: 1 }, secret: true }],
      configuration: { scope: 'account', changeBehavior: 'reconnect', fields: [
        { id: 'organizationSlug', title: 'Organization', schema: { type: 'string', minLength: 1 }, required: true, secret: false },
      ] },
    }] } }, runtime: connectedAccountRuntime,
  } },
  machineProvisioners: { [PROVISIONER_ID]: MACHINE_PROVISIONER },
  ui: { translations: FLY_TRANSLATION_BUNDLES },
  actions: {
    check: { ...defaults, title: 'Check Fly API access', dangerLevel: 'safe',
      inputSchema: ROLE_SCHEMAS.checkInput, resultSchema: MachineProvisionerCheckResultV1Schema,
      async run(_input, context) {
        return machineCheckPresentation(await runtime(context).check({ organizationSlug: await organization(context) }));
      },
    },
    options: { ...defaults, title: 'Discover Fly options', dangerLevel: 'safe',
      inputSchema: FlyLaunchQueryV1Schema, resultSchema: MachineProvisionerOptionsResultV1Schema,
      inputHints: optionsInputHints,
      async run(input, context) {
        const organizationSlug = await organization(context);
        const facts = await runtime(context).options({ organizationSlug,
          ...(input.app?.ownership === 'existing' ? { appName: input.app.name } : input.appName ? { appName: input.appName } : {}) });
        if (facts.kind !== 'available') throw new Error('provider_unavailable');
        const selected = resolveFlyLaunchQueryCandidate(input);
        if (selected.success) {
          const launch = selected.data;
          return { choices: [{ id: 'reviewed-launch', title: launch.app.name, launch,
            available: isLaunchAvailable(launch, facts, organizationSlug), nativeFacts: {
              size: { id: `${launch.guest.cpuKind}/${launch.guest.cpus}/${launch.guest.memoryMb}`, title: `${launch.guest.cpus} CPU · ${launch.guest.memoryMb} MB`,
                cpuCores: launch.guest.cpus, memoryBytes: launch.guest.memoryMb * 1024 * 1024,
                ...(launch.volume.kind === 'create' ? { diskBytes: launch.volume.sizeGb * 1024 * 1024 * 1024 } : {}) },
              image: { id: launch.imageReference ?? FLY_DEFAULT_IMAGE, title: launch.imageReference ?? 'Ubuntu 24.04' },
              location: { id: launch.region, title: facts.regions.find(region => region.code === launch.region)?.name ?? launch.region },
            } }] };
        }
        return { choices: [
          { id: `image/${FLY_DEFAULT_IMAGE}`, title: 'Ubuntu 24.04',
            nativeFacts: { image: { id: FLY_DEFAULT_IMAGE, title: 'Ubuntu 24.04' } } },
          ...facts.regions.map(region => ({ id: `region/${region.code}`, title: region.name, available: !region.deprecated,
            nativeFacts: { location: { id: region.code, title: region.name } } })),
          ...facts.sizes.map(size => ({ id: `size/${size.name}`, title: `${size.name} · ${size.cpuCores} CPU · ${size.memoryMb} MB`,
            nativeFacts: { size: { id: size.name, title: size.name, cpuCores: size.cpuCores, memoryBytes: size.memoryMb * 1024 * 1024 } } })),
          ...facts.apps.map(app => ({ id: `app/${app.id}`, title: app.name })),
          ...facts.volumes.map(volume => ({ id: `volume/${volume.id}`, title: `${volume.id} · ${volume.size_gb ?? '?'} GB`,
            available: volume.state === 'created' && volume.attached_machine_id === null })),
        ] };
      },
    },
    acquire: { ...defaults, title: 'Acquire Fly Machine', dangerLevel: 'destructive',
      confirmation: { title: 'Create this Fly Machine?', body: 'This creates the reviewed paid Machine and any selected owned app or volume.' },
      inputSchema: ROLE_SCHEMAS.acquireInput, resultSchema: reconciliation.result,
      async run(input, context) {
        if (!input.managedId) return { kind: 'rejected', code: 'invalid_request' };
        const organizationSlug = await organization(context);
        const result = await createFlyNativeClient('host-bound', nativeFetch(context), { signal: context.signal, organizationSlug })
          .acquire({ launch: input.launch, requestId: input.managedId, boot: FLY_GUEST_BOOT });
        if (result.kind === 'rejected') return { kind: 'rejected', code: result.reason === 'provider-unavailable' ? 'provider_unavailable' : 'invalid_request' };
        const reference = { contributionRef: { pluginId: PLUGIN_ID, localId: PROVISIONER_ID }, schemaVersion: 1 };
        return result.kind === 'bound' ? { kind: 'bound', resource: { ...reference, value: result.resource } }
          : { kind: 'pending', nativeOperationRef: { ...reference, value: { operation: result.operation, launch: input.launch } } };
      },
    },
    reconcile: { ...defaults, title: 'Recover exact Fly acquisition', dangerLevel: 'safe',
      inputSchema: reconciliation.input, resultSchema: reconciliation.result,
      async run(input, context) {
        let native: { operation: FlyAcquireOperationV1; launch: FlyLaunchV1 };
        if ('nativeOperation' in input) native = input.nativeOperation;
        else {
          const { launch, managedId } = input.correlation;
          if (launch.app.ownership !== 'existing' || launch.volume.kind !== 'attach') return {
            kind: 'unknown', recovery: { reference: managedId, reason: 'native_ownership_unavailable' },
          };
          // Acquire tags native Machines with the managed row id, independently
          // of the outer Action request. Neither existing attachment is owned.
          const operation: FlyAcquireOperationV1 = { app: { name: launch.app.name, ownership: 'existing' },
            volume: { id: launch.volume.volumeId, ownership: 'attached' }, requestId: managedId, phase: 'machine' };
          native = { operation, launch };
        }
        const { operation, launch } = native;
        const result = await runtime(context).recover(operation, launch, FLY_GUEST_BOOT);
        const reference = { contributionRef: { pluginId: PLUGIN_ID, localId: PROVISIONER_ID }, schemaVersion: 1 };
        return result.kind === 'bound' ? { kind: 'bound', resource: { ...reference, value: result.resource } }
          : { kind: 'pending', nativeOperationRef: { ...reference, value: native } };
      },
    },
    bootstrap: { ...defaults, title: 'Resolve private Fly bootstrap', dangerLevel: 'writesLocal',
      confirmation: { title: 'Prepare this Fly Machine for Happier?', body: 'Allow Happier to use the private native transport for the exact managed Machine.' },
      inputSchema: ROLE_SCHEMAS.bootstrapInput, resultSchema: MachineProvisionerBootstrapCarrierV1Schema,
      async run(input, context) {
        const observed = await runtime(context).inspect(input.resource);
        if (observed.kind !== 'present' || !['started', 'stopped'].includes(observed.state) || observed.autonomousPower
          || observed.volumeMountPath !== FLY_GUEST_BOOT.homeDir) throw new Error('provider_unavailable');
        return { kind: 'native', transport: { contributionRef: { pluginId: PLUGIN_ID, localId: PROVISIONER_ID }, schemaVersion: 1 },
          guestHome: { homeDir: FLY_GUEST_BOOT.homeDir, happyHomeDir: FLY_GUEST_BOOT.happyHomeDir, daemonStartup: 'native-process' } };
      },
    },
    inspect: { ...defaults, title: 'Inspect exact Fly Machine', dangerLevel: 'safe',
      inputSchema: ROLE_SCHEMAS.resourceInput, resultSchema: MachineProvisionerObservationV1Schema,
      async run(input, context) {
        const observed = await runtime(context).inspect(input.resource);
        return { observedAt: context.invokedAtMs,
          availability: observed.kind === 'present' || observed.kind === 'absent' ? observed.kind : 'unavailable',
          ...(observed.kind === 'present' ? { power: observed.state === 'started' ? 'running' as const
            : observed.state === 'stopped' ? 'stopped' as const : observed.state === 'suspended' ? 'suspended' as const : 'unknown' as const,
            storage: observed.storage, billing, ...(observed.autonomousPower ? { reason: 'native_autonomous_power' } : {}) } : {}) };
      },
    },
    power: { ...defaults, title: 'Change Fly Machine power', dangerLevel: 'destructive',
      confirmation: { title: 'Change this Fly Machine’s power?', body: 'Stopping resets the root filesystem while keeping its volume. Resume may cold-start and lose running memory.' },
      inputSchema: ROLE_SCHEMAS.powerInput, resultSchema: MachineProvisionerPowerResultV1Schema,
      async run(input, context) {
        if (input.intent !== 'start' && input.intent !== 'stop' && input.intent !== 'suspend' && input.intent !== 'resume') return { kind: 'refused', code: 'native_unsupported_intent' };
        const observed = await runtime(context).power(input.resource, input.intent);
        const expected = input.intent === 'start' || input.intent === 'resume' ? 'started' : input.intent === 'stop' ? 'stopped' : 'suspended';
        return observed.kind === 'present' && observed.state === expected ? { kind: 'confirmed' } : { kind: 'unknown', code: 'native_power_pending' };
      },
    },
    destroy: { ...defaults, title: 'Delete exact Fly Machine and owned attachments', dangerLevel: 'destructive',
      confirmation: { title: 'Delete this Fly Machine?', body: 'This permanently deletes the exact Machine and its owned volume and app. Pre-existing attached resources are retained.' },
      inputSchema: reconciliation.destroyInput, resultSchema: MachineProvisionerPowerResultV1Schema,
      async run(input, context) {
        const result = 'resource' in input ? await runtime(context).destroy(input.resource)
          : await runtime(context).destroyPending(input.nativeOperation.operation);
        return result.complete ? { kind: 'confirmed' } : { kind: 'unknown', code: result.reason ?? 'native_cleanup_incomplete' }; },
    },
    'observe-cleanup': { ...defaults, title: 'Observe exact pending Fly cleanup', dangerLevel: 'safe',
      inputSchema: reconciliation.cleanupInput, resultSchema: reconciliation.cleanupResult,
      async run(input, context) {
        const result = await runtime(context).inspectPendingCleanup(input.nativeOperation.operation);
        return result.complete ? { kind: 'confirmed' } : result.retryable ? { kind: 'retryable' }
          : { kind: 'unknown', code: result.reason ?? 'native_cleanup_unconfirmed' };
      },
    },
    exec: { ...defaults, title: 'Execute private Fly bootstrap IO', dangerLevel: 'writesLocal',
      confirmation: { title: 'Run Happier setup in this Fly Machine?', body: 'This runs the admitted setup command inside the exact managed Machine.' },
      inputSchema: ROLE_SCHEMAS.execInput, resultSchema: MachineProvisionerNativeExecResultV1Schema,
      async run(input, context) {
        if (input.processConfig) {
          if (input.inputBase64 !== undefined) throw new Error('invalid_request');
          const configured = await runtime(context).configureProcess(input.resource, { command: [...input.argv], environment: input.processConfig.environment });
          if (configured.kind !== 'configured' || context.signal.aborted) throw new Error('native_boot_unconfirmed');
          return { kind: 'process-configured' };
        }
        // Fly accepts a JSON UTF-8 stdin string. Refuse unrepresentable bytes
        // rather than silently replacing them; putFile preserves arbitrary bytes.
        const stdin = input.inputBase64 === undefined ? undefined : new TextDecoder('utf-8', { fatal: true }).decode(bytes(input.inputBase64));
        // flyctl v0.3.214 internal/command/machine/exec.go declares the native
        // integer timeout in seconds. Round upward so its unit conversion never
        // shortens the host's millisecond budget; cancellation stays host-owned.
        const result = await runtime(context).exec(input.resource, { command: [...input.argv], ...(stdin === undefined ? {} : { stdin }),
          ...(input.timeoutMs == null ? {} : { timeout: Math.ceil(input.timeoutMs / 1000) }) });
        if (result.kind !== 'completed') throw new Error('provider_unavailable');
        return { termination: { observed: result.exitSignal ? { kind: 'signal' as const, signal: String(result.exitSignal) }
          : { kind: 'exit' as const, exitCode: result.exitCode }, requestedBy: { kind: context.signal.aborted ? 'abort' as const : 'none' as const } },
          stdoutBase64: Buffer.from(result.stdout).toString('base64'), stderrBase64: Buffer.from(result.stderr).toString('base64'),
          stdoutTruncated: false, stderrTruncated: false };
      },
    },
    'put-file': { ...defaults, title: 'Write private Fly bootstrap file', dangerLevel: 'writesLocal',
      confirmation: { title: 'Write this Fly Machine’s setup file?', body: 'This writes the private setup payload to its reviewed path inside the exact managed Machine.' },
      inputSchema: ROLE_SCHEMAS.putFileInput, resultSchema: MachineProvisionerPutFileResultV1Schema,
      async run(input, context) {
        bytes(input.bytesBase64);
        const result = await runtime(context).putFile(input.resource, { guestPath: input.guestPath, bytesBase64: input.bytesBase64, ...(input.mode === undefined ? {} : { mode: input.mode }) });
        return result.kind === 'written' && !context.signal.aborted ? { kind: 'confirmed' } : { kind: 'unknown', code: 'native_write_unconfirmed' };
      },
    },
  },
});
export const PLUGIN_MANIFEST = PLUGIN.manifest;
