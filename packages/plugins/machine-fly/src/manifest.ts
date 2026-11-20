import { decodeBase64, encodeBase64 } from '@happier-dev/plugin-sdk/protocol';
import { machinePresentationLabel, machineCheckPresentation } from './ui/translations.js';
import { definePlugin, PluginError } from '@happier-dev/plugin-sdk';
import { CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 } from '@happier-dev/plugin-sdk/connected-accounts';
import type { ActionContribution, PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import { observeMachineProvisionerNativeRead, defineMachineProvisionerReconciliationSchemas, prepareMachineProvisionerStoredSchemas,
  MachineProvisionerBootstrapCarrierV1Schema, MachineProvisionerCheckResultV1Schema,
  MachineProvisionerObservationV1Schema, MachineProvisionerOptionsResultV1Schema,
  MachineProvisionerPowerResultV1Schema, MachineProvisionerNativeExecResultV1Schema, MachineProvisionerPutFileResultV1Schema,
  projectMachineProvisionerOptionsFailure, readMachineProvisionerCredentialRefusal, type MachineProvisionerAuthorDefinitionV1,
  type MachineProvisionerNativeCauseV1, type MachineProvisionerPowerResultV1,
} from '@happier-dev/plugin-sdk/machine-provisioners';
import { createFlyNativeClient, isLaunchAvailable, type FlyCleanup } from './machine/nativeClient.js';
import { createFlyPreparationClient, FlyPreparationInputSchema, FlyPreparationOperationSchema, FlyPreparedArtifactSchema,
  FLY_PREPARATION_HOME, PREPARATION_SCHEMAS } from './machine/preparation.js';
import { FLY_DEFAULT_IMAGE, FLY_GUEST_BOOT, FLY_ROLE_SCHEMAS, FlyLaunchQueryV1Schema, FlyLaunchV1Schema, FlyNativeOperationV1Schema, FlyResourceV1Schema, resolveFlyLaunchQueryCandidate, type FlyAcquireOperationV1, type FlyLaunchV1 } from './machine/schemas.js';
import { ACCOUNT_ID, ACCOUNT_PURPOSE, connectedAccountRuntime, nativeFetch } from './account.js';
import { FLY_CONFIGURATION_LABELS } from './ui/translations.js';

export const PLUGIN_ID = 'happier.machine.fly';
export const PROVISIONER_ID = 'fly';
export const ROLE_SCHEMAS = FLY_ROLE_SCHEMAS;
const reconciliation = defineMachineProvisionerReconciliationSchemas({ launch: FlyLaunchV1Schema, resource: FlyResourceV1Schema, nativeOperation: FlyNativeOperationV1Schema });
export const prepareStoredSchemas = () => prepareMachineProvisionerStoredSchemas({ launch: FlyLaunchV1Schema, resource: FlyResourceV1Schema, nativeOperation: FlyNativeOperationV1Schema });
function nativeFailure(code: string, nativeCause?: MachineProvisionerNativeCauseV1) {
  return new PluginError({ code, ...(nativeCause ? { details: { nativeCause } } : {}) });
}
function controlFailure(result: Readonly<{ kind?: string; reason?: string; nativeCause?: MachineProvisionerNativeCauseV1 }>, fallback: string): MachineProvisionerPowerResultV1 {
  return { kind: result.kind === 'refused' ? 'refused' : 'unknown', code: result.reason ?? fallback,
    ...(result.nativeCause ? { nativeCause: result.nativeCause } : {}) };
}
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
// Published resource rates, before allowances; not a per-machine storage quote.
const billing = { location: 'cloud', stoppedBilling: 'not-billed', storageCharges: [
  { label: machinePresentationLabel('rootFilesystem'), amount: '0.15', currency: 'USD', unit: 'GB-month',
    source: 'https://docs.fly.io/about/pricing', observedAt: Date.UTC(2026, 9, 27) },
  { label: machinePresentationLabel('volumeStorage'), amount: '0.15', currency: 'USD', unit: 'GB-month',
    source: 'https://docs.fly.io/about/pricing', observedAt: Date.UTC(2026, 9, 27) },
  { label: machinePresentationLabel('snapshotStorage'), amount: '0.08', currency: 'USD', unit: 'GB-month',
    source: 'https://docs.fly.io/about/pricing', observedAt: Date.UTC(2026, 9, 27) },
] } as const;
const defaults = { scopes: ['machine'], surfaces: ['cli', 'plugin'], hostAccess: ['native-api', ACCOUNT_PURPOSE],
  execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } } } as const;
const runtime = (context: Parameters<typeof nativeFetch>[0]) => createFlyNativeClient('host-bound', nativeFetch(context), { signal: context.signal });
async function organization(context: PluginAccountActionContext) {
  const material = await context.services.connectedAccounts.materialize(ACCOUNT_PURPOSE,
    { kind: 'environment', keys: ['FLY_ORGANIZATION'] }, { signal: context.signal });
  if (material.kind !== 'environment' || !material.env.FLY_ORGANIZATION) throw new Error('credential_unavailable');
  return material.env.FLY_ORGANIZATION;
}
export const MACHINE_PROVISIONER = {
  title: 'Fly Machines', icon: 'hard-drives', resourceKind: 'fly-machine', schemaVersion: 1,
  enrollmentRole: 'sandbox',
  kindTitle: machinePresentationLabel('kind'), description: machinePresentationLabel('description'),
  launchSchema: FlyLaunchV1Schema.jsonSchema, resourceSchema: FlyResourceV1Schema.jsonSchema, resourceIdPath: 'machineId',
  platforms: ['darwin', 'linux', 'win32'], prerequisites: [],
  // Required GraphQL POST preflight does not permit browser Authorization/Content-Type.
  browserReachable: false,
  billing, retention: { supportedIntents: ['start', 'stop', 'resume', 'suspend', 'delete'] },
  actions: { check: 'check', options: 'options', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', power: 'power', destroy: 'destroy' },
  bootstrapTransport: { kind: 'native', exec: 'exec', putFile: 'put-file' },
  reconciliation: { nativeOperationSchema: FlyNativeOperationV1Schema.jsonSchema, action: 'reconcile', cleanup: 'observe-cleanup' },
  preparation: { inputSchema: FlyPreparationInputSchema.jsonSchema, artifactSchema: FlyPreparedArtifactSchema.jsonSchema,
    nativeOperationSchema: FlyPreparationOperationSchema.jsonSchema, artifactLaunchPath: 'launch',
    actions: { build: 'prepare-build', inspect: 'prepare-inspect', destroy: 'prepare-destroy' } },
} satisfies MachineProvisionerAuthorDefinitionV1;

export const PLUGIN = definePlugin({
  id: PLUGIN_ID, version: '0.0.0', displayName: 'Fly Machines',
  // The provider's own mark beside its name in Machines: Fly.io's mark from Simple Icons 13.21.0 (CC0-1.0), monochrome so the host draws it in ink.
  brand: { iconResourceId: 'brand-icon', monochrome: true },
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
  description: 'Native Fly Machine control and private buffered bootstrap IO.', entrypoints: { daemon: './.happier-plugin-build/daemon.js' },
  hostAccess: { required: [
    { id: 'native-api', capability: 'network', reason: 'Operate exact reviewed Fly resources.',
      scope: { targets: [{ kind: 'fixedOrigin', origin: 'https://api.machines.dev' }, { kind: 'fixedOrigin', origin: 'https://api.fly.io' },
        { kind: 'fixedOrigin', origin: 'https://registry.fly.io' }], methods: ['GET', 'POST', 'DELETE'] } },
    { id: ACCOUNT_PURPOSE, capability: 'connectedAccounts', reason: 'Use only the captured Fly account and native organization.',
      scope: { serviceRefs: [ACCOUNT_ID], operations: ['use'], materializationKinds: ['httpHeaders', 'environment'] } },
  ], optional: [] },
  connectedAccountDescriptors: { [ACCOUNT_ID]: {
    declaration: { title: 'Fly cloud account', ui: { category: 'cloud-machines' }, authentication: { defaultModeId: 'token', modes: [{
      id: 'token', kind: 'manual', title: 'API token', outcomeReconciliation: 'none',
      setup: { url: 'https://docs.fly.io/security/tokens', createKeyTitle: 'Read Fly.io token instructions',
        checklist: ['Sign in to Fly.io with fly auth login.', 'Run fly tokens create org --org YOUR_ORGANIZATION to create a token for the organization that will own your Machines.', 'Paste the token here and enter the same organization slug below.'],
        shapeHint: 'Use an organization token that can manage apps and Machines.' },
      credentialFieldKeys: { token: 'token' },
      credentialOrigin: 'authentication',
      directExport: { contractVersion: CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 },
      fields: [{ id: 'token', title: 'API token', schema: { type: 'string', minLength: 1 }, secret: true }],
      configuration: { scope: 'account', changeBehavior: 'reconnect', fields: [
        { id: 'organizationSlug', title: 'Organization', schema: { type: 'string', minLength: 1 }, required: true, secret: false },
      ] },
    }] } }, runtime: connectedAccountRuntime,
  } },
  machineProvisioners: { [PROVISIONER_ID]: MACHINE_PROVISIONER },
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
  actions: {
    'prepare-build': { ...defaults, title: 'Build Fly prepared image', dangerLevel: 'writesRemote',
      confirmation: { title: 'Build this Fly image?', body: 'Fly charges apply while the clean builder runs. See https://fly.io/docs/about/pricing/ for current prices.' },
      inputSchema: PREPARATION_SCHEMAS.buildInput, resultSchema: PREPARATION_SCHEMAS.buildResult,
      async run(input, context) {
        const client = createFlyPreparationClient(nativeFetch(context), await organization(context), context.signal);
        const material = await context.services.connectedAccounts.materialize(ACCOUNT_PURPOSE,
          { kind: 'environment', keys: ['FLY_REGISTRY_TOKEN'] }, { signal: context.signal });
        if (material.kind !== 'environment' || !material.env.FLY_REGISTRY_TOKEN) throw new PluginError({ code: 'credential_unavailable' });
        return client.build(input, material.env.FLY_REGISTRY_TOKEN);
      } },
    'prepare-inspect': { ...defaults, title: 'Inspect Fly prepared image', dangerLevel: 'safe',
      inputSchema: PREPARATION_SCHEMAS.inspectInput, resultSchema: PREPARATION_SCHEMAS.inspectResult,
      async run(input, context) {
        return createFlyPreparationClient(nativeFetch(context), await organization(context), context.signal)
          .inspect('nativeOperation' in input ? { nativeOperation: input.nativeOperation.value } : input);
      } },
    'prepare-destroy': { ...defaults, title: 'Delete Fly prepared image', dangerLevel: 'destructive',
      confirmation: { title: 'Delete this Fly prepared image?', body: 'This removes the owned builder and the prepared image registry app.' },
      inputSchema: PREPARATION_SCHEMAS.destroyInput, resultSchema: PREPARATION_SCHEMAS.destroyResult,
      async run(input, context) {
        return createFlyPreparationClient(nativeFetch(context), await organization(context), context.signal).destroy({
          ...(input.artifact === undefined ? {} : { artifact: input.artifact.value }),
          ...(input.nativeOperation === undefined ? {} : { nativeOperation: input.nativeOperation.value }),
        });
      } },
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
        if (facts.kind !== 'available') return projectMachineProvisionerOptionsFailure(
          readMachineProvisionerCredentialRefusal(facts.status), facts.nativeCause);
        const emptyDimensions = { size: [], image: [], location: [], network: [], duration: [] };
        const selected = resolveFlyLaunchQueryCandidate(input);
        if (selected.success) {
          const launch = selected.data;
          const size = { id: `${launch.guest.cpuKind}/${launch.guest.cpus}/${launch.guest.memoryMb}`, title: machinePresentationLabel('customSize'),
            cpuCores: launch.guest.cpus, memoryBytes: launch.guest.memoryMb * 1024 * 1024,
            ...(launch.volume.kind === 'create' ? { diskBytes: launch.volume.sizeGb * 1024 * 1024 * 1024 } : {}) };
          const image = { id: launch.imageReference ?? FLY_DEFAULT_IMAGE, title: launch.imageReference ?? 'Ubuntu 24.04' };
          const location = { id: launch.region, title: facts.regions.find(region => region.code === launch.region)?.name ?? launch.region };
          return { base: { launch, guestPlatform: 'linux' as const, available: isLaunchAvailable(launch, facts, organizationSlug) }, dimensions: { ...emptyDimensions,
            size: [{ id: size.id, title: size.title, assignments: [], nativeFacts: { size } }],
            image: [{ id: image.id, title: image.title, guestPlatform: 'linux' as const, assignments: [], nativeFacts: { image,
              preparationGuest: { target: { os: 'linux' as const, arch: 'x64' as const }, remoteHomeDir: FLY_PREPARATION_HOME } } }],
            location: [{ id: location.id, title: location.title, assignments: [], nativeFacts: { location } }],
          } };
        }
        // App and volume remain explicit form inputs, qualified again by acquire.
        // These catalog facts cannot complete an unreviewed form on their own.
        return { dimensions: { ...emptyDimensions,
          image: [{ id: FLY_DEFAULT_IMAGE, title: 'Ubuntu 24.04', guestPlatform: 'linux' as const, assignments: [],
            nativeFacts: { image: { id: FLY_DEFAULT_IMAGE, title: 'Ubuntu 24.04' },
              preparationGuest: { target: { os: 'linux' as const, arch: 'x64' as const }, remoteHomeDir: FLY_PREPARATION_HOME } } }],
          location: facts.regions.map(region => ({ id: region.code, title: region.name, available: !region.deprecated,
            assignments: [], nativeFacts: { location: { id: region.code, title: region.name } } })),
          size: facts.sizes.map(size => ({ id: size.name, title: `${size.name} · ${size.cpuCores} CPU · ${size.memoryMb} MB`,
            assignments: [], nativeFacts: { size: { id: size.name, title: size.name, cpuCores: size.cpuCores, memoryBytes: size.memoryMb * 1024 * 1024 } } })),
        } };
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
        if (result.kind === 'rejected') return { kind: 'rejected',
          code: result.reason === 'credential_unavailable' ? result.reason : result.reason === 'provider-unavailable' ? 'provider_unavailable' : 'invalid_request',
          ...(result.nativeCause ? { nativeCause: result.nativeCause } : {}) };
        const reference = { contributionRef: { pluginId: PLUGIN_ID, localId: PROVISIONER_ID }, schemaVersion: 1 };
        return result.kind === 'bound' ? { kind: 'bound', resource: { ...reference, value: result.resource, origin: 'created' as const } }
          : { kind: 'pending', nativeOperationRef: { ...reference, value: { operation: result.operation, launch: input.launch } },
            ...(result.nativeCause ? { nativeCause: result.nativeCause } : {}) };
      },
    },
    reconcile: { ...defaults, title: 'Recover exact Fly acquisition', dangerLevel: 'safe',
      inputSchema: reconciliation.input, resultSchema: reconciliation.result,
      async run(input, context) {
        let native: { operation: FlyAcquireOperationV1; launch: FlyLaunchV1 };
        if ('nativeOperation' in input) {
          if ('machineId' in input.nativeOperation) return { kind: 'bound', resource: { origin: 'created' as const,
            contributionRef: { pluginId: PLUGIN_ID, localId: PROVISIONER_ID }, schemaVersion: 1, value: input.nativeOperation,
          } };
          native = input.nativeOperation;
        }
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
        return result.kind === 'bound' ? { kind: 'bound', resource: { ...reference, value: result.resource, origin: 'created' as const } }
          : { kind: 'pending', nativeOperationRef: { ...reference, value: native },
            ...(result.nativeCause ? { nativeCause: result.nativeCause } : {}) };
      },
    },
    bootstrap: { ...defaults, title: 'Resolve private Fly bootstrap', dangerLevel: 'writesLocal',
      confirmation: { title: 'Prepare this Fly Machine for Happier?', body: 'Allow Happier to use the private native transport for the exact managed Machine.' },
      inputSchema: ROLE_SCHEMAS.bootstrapInput, resultSchema: MachineProvisionerBootstrapCarrierV1Schema,
      async run(input, context) {
        const observed = await runtime(context).inspect(input.resource);
        if (observed.kind !== 'present' && observed.kind !== 'absent') throw nativeFailure('provider_unavailable', observed.nativeCause);
        if (observed.kind === 'present' && ['created', 'starting'].includes(observed.state)) throw nativeFailure('native_not_ready');
        if (observed.kind !== 'present' || !['started', 'stopped'].includes(observed.state)
          || observed.volumeMountPath !== FLY_GUEST_BOOT.homeDir) throw new Error('provider_unavailable');
        return { kind: 'native', transport: { contributionRef: { pluginId: PLUGIN_ID, localId: PROVISIONER_ID }, schemaVersion: 1 },
          guestHome: { homeDir: FLY_GUEST_BOOT.homeDir, happyHomeDir: FLY_GUEST_BOOT.happyHomeDir, daemonStartup: 'native-process' } };
      },
    },
    inspect: { ...defaults, title: 'Inspect exact Fly Machine', dangerLevel: 'safe',
      inputSchema: ROLE_SCHEMAS.resourceInput, resultSchema: MachineProvisionerObservationV1Schema,
      async run(input, context) {
        const observed = await runtime(context).inspect(input.resource);
        return observeMachineProvisionerNativeRead(context.invokedAtMs, {
          kind: observed.kind === 'present' || observed.kind === 'absent' ? observed.kind : 'unknown',
          ...(observed.kind !== 'present' && observed.kind !== 'absent' ? { reason: observed.reason === 'cleanup-unconfirmed' ? 'native_cleanup_incomplete' : observed.reason,
            ...(observed.nativeCause ? { nativeCause: observed.nativeCause } : {}) } : {}),
          ...(observed.kind === 'present' ? { power: observed.state === 'started' ? 'running' as const
            : observed.state === 'stopped' ? 'stopped' as const : observed.state === 'suspended' ? 'suspended' as const : 'unknown' as const,
            storage: observed.storage, billing, ...(observed.size ? { size: observed.size } : {}),
            ...(observed.autonomousPower ? { reason: 'native_autonomous_power' } : {}) } : {}) });
      },
    },
    power: { ...defaults, title: 'Change Fly Machine power', dangerLevel: 'destructive',
      confirmation: { title: 'Change this Fly Machine’s power?', body: 'Stopping resets the root filesystem while keeping its volume. Resume may cold-start and lose running memory.' },
      inputSchema: ROLE_SCHEMAS.powerInput, resultSchema: MachineProvisionerPowerResultV1Schema,
      async run(input, context) {
        if (input.intent !== 'start' && input.intent !== 'stop' && input.intent !== 'suspend' && input.intent !== 'resume') return { kind: 'refused', code: 'native_unsupported_intent' };
        const observed = await runtime(context).power(input.resource, input.intent);
        const expected = input.intent === 'start' || input.intent === 'resume' ? 'started' : input.intent === 'stop' ? 'stopped' : 'suspended';
        return observed.kind === 'present' && observed.state === expected ? { kind: 'confirmed' }
          : controlFailure(observed.kind === 'present' || observed.kind === 'absent' ? {} : observed, 'native_power_pending');
      },
    },
    destroy: { ...defaults, title: 'Delete exact Fly Machine and owned attachments', dangerLevel: 'destructive',
      confirmation: { title: 'Delete this Fly Machine?', body: 'This permanently deletes the exact Machine and its owned volume and app. Pre-existing attached resources are retained.' },
      inputSchema: reconciliation.destroyInput, resultSchema: reconciliation.destroyResult,
      async run(input, context) {
        const resource = 'resource' in input ? input.resource : 'machineId' in input.nativeOperation ? input.nativeOperation : undefined;
        const continuing = !('resource' in input);
        let result: FlyCleanup;
        if (resource) result = await runtime(context).destroy(resource, continuing);
        else if ('nativeOperation' in input && 'operation' in input.nativeOperation) result = await runtime(context).destroyPending(input.nativeOperation.operation);
        else return { kind: 'refused', code: 'native_cleanup_unavailable' };
        if (result.kind === 'pending') {
          return { kind: 'accepted', nativeOperationRef: {
            contributionRef: { pluginId: PLUGIN_ID, localId: PROVISIONER_ID }, schemaVersion: 1,
            value: resource ?? ('nativeOperation' in input ? input.nativeOperation : input.resource),
          } };
        }
        return result.complete ? { kind: 'confirmed' } : controlFailure(result, 'native_cleanup_incomplete'); },
    },
    'observe-cleanup': { ...defaults, title: 'Observe exact pending Fly cleanup', dangerLevel: 'safe',
      inputSchema: reconciliation.cleanupInput, resultSchema: reconciliation.cleanupResult,
      async run(input, context) {
        if ('machineId' in input.nativeOperation) {
          const observed = await runtime(context).inspect(input.nativeOperation);
          if ('nativeCause' in observed && observed.nativeCause) throw nativeFailure('native_cleanup_unconfirmed', observed.nativeCause);
          return observed.kind === 'absent' ? { kind: 'confirmed' } : { kind: 'unknown', code: 'native_cleanup_unconfirmed' };
        }
        const result = await runtime(context).inspectPendingCleanup(input.nativeOperation.operation);
        if (result.nativeCause) throw nativeFailure(result.reason ?? 'native_cleanup_unconfirmed', result.nativeCause);
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
          const configured = await runtime(context).configureProcess(input.resource, {
            command: [...input.argv], environment: input.processConfig.environment,
          });
          if (configured.kind !== 'configured' || context.signal.aborted) throw nativeFailure('native_boot_unconfirmed',
            'nativeCause' in configured ? configured.nativeCause : undefined);
          return { kind: 'process-configured' };
        }
        // Fly accepts a JSON UTF-8 stdin string. Refuse unrepresentable bytes
        // rather than silently replacing them; putFile preserves arbitrary bytes.
        const stdin = input.inputBase64 === undefined ? undefined : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(decodeBase64(input.inputBase64));
        // flyctl v0.3.214 internal/command/machine/exec.go declares the native
        // integer timeout in seconds. Round upward so its unit conversion never
        // shortens the host's millisecond budget; cancellation stays host-owned.
        const result = await runtime(context).exec(input.resource, { command: [...input.argv], ...(stdin === undefined ? {} : { stdin }),
          ...(input.timeoutMs == null ? {} : { timeout: Math.ceil(input.timeoutMs / 1000) }) });
        if (result.kind !== 'completed') throw nativeFailure('provider_unavailable', 'nativeCause' in result ? result.nativeCause : undefined);
        return { termination: { observed: result.exitSignal ? { kind: 'signal' as const, signal: String(result.exitSignal) }
          : { kind: 'exit' as const, exitCode: result.exitCode }, requestedBy: { kind: context.signal.aborted ? 'abort' as const : 'none' as const } },
          stdoutBase64: encodeBase64(new TextEncoder().encode(result.stdout)), stderrBase64: encodeBase64(new TextEncoder().encode(result.stderr)),
          stdoutTruncated: false, stderrTruncated: false };
      },
    },
    'put-file': { ...defaults, title: 'Write private Fly bootstrap file', dangerLevel: 'writesLocal',
      confirmation: { title: 'Write this Fly Machine’s setup file?', body: 'This writes the private setup payload to its reviewed path inside the exact managed Machine.' },
      inputSchema: ROLE_SCHEMAS.putFileInput, resultSchema: MachineProvisionerPutFileResultV1Schema,
      async run(input, context) {
        const result = await runtime(context).putFile(input.resource, { guestPath: input.guestPath, bytesBase64: input.bytesBase64, ...(input.mode === undefined ? {} : { mode: input.mode }) });
        return result.kind === 'written' && !context.signal.aborted ? { kind: 'confirmed' }
          : controlFailure(result.kind === 'written' || result.kind === 'absent' ? {} : result, 'native_write_unconfirmed');
      },
    },
  },
});
export const PLUGIN_MANIFEST = PLUGIN.manifest;
export const activateAccount = (api: Parameters<typeof PLUGIN.activateAccount>[0]) =>
  PLUGIN.activateAccount(api, { artifactId: 'account-runtime', exportName: 'activateAccount' });
