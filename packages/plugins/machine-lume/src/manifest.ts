import { readManagedDependencyExecutable, projectUnavailableManagedDependency } from '@happier-dev/plugin-sdk/managed-services';
import { definePlugin, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { machinePresentationLabel, machineCheckPresentation } from './ui/translations.js';
import {
  defineMachineProvisionerSchemas, defineMachineProvisionerReconciliationSchemas, prepareMachineProvisionerStoredSchemas,
  MachineProvisionerBootstrapCarrierV1Schema, MachineProvisionerCheckResultV1Schema,
  MachineProvisionerObservationV1Schema, MachineProvisionerOptionsResultV1Schema,
  MachineProvisionerPowerResultV1Schema,
  observeMachineProvisionerNativeRead,
  projectMachineProvisionerActionFailure,
  type MachineProvisionerAuthorDefinitionV1,
} from '@happier-dev/plugin-sdk/machine-provisioners';
import type { HttpMethod } from '@happier-dev/plugin-sdk/http';
import type { ActionContribution } from '@happier-dev/plugin-sdk/actions';
import { defineProtocolLiteral } from '@happier-dev/plugin-sdk/protocol';
import { lumeConfigurationLabel as label } from './ui/translations.js';
import { LUME_PLUGIN_ID, LUME_PROVISIONER_ID, LUME_DEPENDENCY_ID, LUME_BILLING } from './machine/definition.js';
import { LumeLaunchV1Schema, LumeResourceV1Schema, LumeNativeOperationV1Schema, LumeOptionsInputV1Schema } from './machine/schemas.js';
import { LumePreparationInputSchema, LumePreparedArtifactSchema, LumePreparationOperationSchema,
  PREPARATION_SCHEMAS, createLumePreparationClient } from './machine/preparation.js';
import { createLumePreparationBuildExecutor } from './machine/preparationGuest.js';

export const LUME_ROLE_SCHEMAS = defineMachineProvisionerSchemas({ launch: LumeLaunchV1Schema, resource: LumeResourceV1Schema, continueAcquire: true });
export const LUME_RECONCILIATION_SCHEMAS = defineMachineProvisionerReconciliationSchemas({ launch: LumeLaunchV1Schema,
  resource: LumeResourceV1Schema, nativeOperation: LumeNativeOperationV1Schema });
export const prepareLumeStoredSchemas = () => prepareMachineProvisionerStoredSchemas({ launch: LumeLaunchV1Schema, resource: LumeResourceV1Schema, nativeOperation: LumeNativeOperationV1Schema });
const processAccess = 'lume-process';
const networkAccess = 'lume-http';
const registryAccess = 'lume-image-registry';
const GIB = 1024 ** 3;
// Current Lume CLI create defaults (Cua docs CLI reference, generated for
// 0.5.1): 4 CPU cores and 8GB memory. Disk is image-owned.
const DEFAULT_CPU = 4;
const DEFAULT_MEMORY_BYTES = 8 * GIB;
const defaults = { scopes: ['machine'], surfaces: ['cli', 'plugin'], hostAccess: [processAccess, networkAccess] } as const;
const origin = 'http://localhost:7777';

function errorCode(error: unknown) {
  if (error !== null && typeof error === 'object' && 'code' in error
    && ['invalid_request', 'credential_unavailable', 'provider_unavailable', 'resource_mismatch'].includes(String(error.code))) {
    return String(error.code);
  }
  return 'provider_unavailable';
}

async function runtime(context: PluginInvocationContext) {
  const status = await readManagedDependencyExecutable(context.services.managedServices.dependencies, LUME_DEPENDENCY_ID, context.signal);
  if (status.state !== 'ready') {
    throw Object.assign(new Error('Declared native Lume executable unavailable'), { code: 'provider_unavailable', notInstalled: status.state === 'missing' });
  }
  const [{ createLumeNativeClient }, { createLumeProvider }] = await Promise.all([
    import('./machine/nativeClient.js'), import('./machine/provider.js'),
  ]);
  const native = createLumeNativeClient({ baseUrl: origin, command: { exec: context.services.exec, executable: status.executable }, fetch: async (rawUrl, init) => {
    const method = init?.method ?? 'GET';
    if (!(['GET', 'POST', 'PATCH', 'DELETE'] as readonly string[]).includes(method)) {
      throw new Error('Unsupported Lume native method');
    }
    const requestedUrl = String(rawUrl);
    const url = new URL(requestedUrl);
    if (url.origin !== origin && (url.origin !== 'https://ghcr.io' || method !== 'GET')) throw new Error('Undeclared Lume origin');
    const response = await context.services.http.request({ url: requestedUrl, method: method as HttpMethod,
      headers: Object.fromEntries(new Headers(init?.headers ?? { 'content-type': 'application/json' }).entries()), redirect: 'error',
      ...(init?.body === undefined ? {} : { body: new TextEncoder().encode(String(init.body)) }),
    }, { signal: init?.signal ?? context.signal });
    if (response.finalUrl !== requestedUrl) throw new Error('Native Lume origin changed');
    return new Response(new Uint8Array(response.body), { status: response.status, headers: response.headers });
  } });
  return { native, executable: status.executable,
    provider: createLumeProvider({ native, observedAt: context.invokedAtMs, signal: context.signal,
      warn: warning => context.services.logger.warn('Lume image caching could not be enabled; continuing acquisition.', warning) }) };
}

async function preparationRuntime(context: PluginInvocationContext) {
  const { native } = await runtime(context);
  return createLumePreparationClient({ native, observedAt: context.invokedAtMs, signal: context.signal,
    waitForNativeObservation: () => context.services.machineProvisioners.waitForNativeObservation(),
    executeBuild: createLumePreparationBuildExecutor({ native, exec: context.services.exec,
      waitForNativeObservation: () => context.services.machineProvisioners.waitForNativeObservation(),
      establishSshHostTrust: carrier => context.services.machineProvisioners.establishSshHostTrust(carrier) }),
  });
}

export const LUME_MACHINE_PROVISIONER = {
  title: 'Lume', icon: 'desktop', resourceKind: 'lume-vm', schemaVersion: 1,
  enrollmentRole: 'personal',
  sessionPlacement: { kind: 'controller-local' },
  kindTitle: machinePresentationLabel('kind'), description: machinePresentationLabel('description'),
  launchSchema: LumeLaunchV1Schema.jsonSchema, resourceSchema: LumeResourceV1Schema.jsonSchema, resourceIdPath: 'vmName',
  platforms: ['darwin'], prerequisites: [{ kind: 'managedDependency', id: LUME_DEPENDENCY_ID }, { kind: 'systemTool', id: 'ssh-keyscan' }, { kind: 'systemTool', id: 'ssh' }],
  billing: LUME_BILLING, retention: { supportedIntents: ['start', 'stop', 'delete'] },
  actions: { check: 'check', options: 'options', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', power: 'power', destroy: 'destroy' },
  reconciliation: { nativeOperationSchema: LumeNativeOperationV1Schema.jsonSchema, action: 'reconcile', continueAcquire: true },
  preparation: { inputSchema: LumePreparationInputSchema.jsonSchema, artifactSchema: LumePreparedArtifactSchema.jsonSchema,
    nativeOperationSchema: LumePreparationOperationSchema.jsonSchema, artifactLaunchPath: 'launch',
    actions: { build: 'prepare-build', inspect: 'prepare-inspect', destroy: 'prepare-destroy' } },
} satisfies MachineProvisionerAuthorDefinitionV1;

export const LUME_PLUGIN = definePlugin({
  id: LUME_PLUGIN_ID, version: '0.0.0', displayName: 'Lume Machines',
  description: 'Managed Lume guests on the selected Apple silicon Mac.',
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
  }, entrypoints: { daemon: './.happier-plugin-build/daemon.js' },
  hostAccess: { required: [
    { id: processAccess, capability: 'process', reason: 'Install the public SSH key over OpenSSH and inspect the reviewed local Lume guest.',
      scope: { executables: [{ kind: 'managedDependency', id: LUME_DEPENDENCY_ID }, { kind: 'systemTool', id: 'ssh-keyscan' }, { kind: 'systemTool', id: 'ssh' }] } },
    { id: networkAccess, capability: 'network', reason: 'Operate the exact managed resource through the controller-local Lume service.',
      scope: { targets: [{ kind: 'fixedOrigin', origin }], methods: ['GET', 'POST', 'PATCH', 'DELETE'] } },
    { id: registryAccess, capability: 'network', reason: 'Read native public image tags through anonymous GHCR pull-scoped authentication.',
      scope: { targets: [{ kind: 'fixedOrigin', origin: 'https://ghcr.io' }], methods: ['GET'] } },
  ], optional: [] },
  managedDependencies: { [LUME_DEPENDENCY_ID]: {
    id: LUME_DEPENDENCY_ID, title: 'Lume', executable: 'lume', platforms: ['macos'], architectures: ['arm64'],
    sources: [{ kind: 'system', executableNames: ['lume'], versionArguments: ['--version'] }, {
      // Vendor lume-v0.6.1 release-manifest.json supplies this checksum. Keep
      // the signed app bundle intact; its native executable needs its resources.
      kind: 'pinnedArchive', installId: 'dep.lume', version: '0.6.1', assetsByPlatform: {
        'darwin-arm64': {
          archiveUrl: 'https://github.com/trycua/cua/releases/download/lume-v0.6.1/lume-0.6.1-darwin-arm64.tar.gz',
          sha256: '2675b7981b7d3eb525cd27f40a385c986052eb71b3360c0b2579644725f1bad8',
          executableSubpath: 'lume.app/Contents/MacOS/lume',
        },
      },
    }],
  } },
  systemTools: { 'ssh-keyscan': { title: 'OpenSSH host key scanner', executableNames: ['ssh-keyscan'] },
    ssh: { title: 'OpenSSH client', executableNames: ['ssh'] } },
  machineProvisioners: { [LUME_PROVISIONER_ID]: LUME_MACHINE_PROVISIONER },
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
    'prepare-build': { ...defaults, hostAccess: [...defaults.hostAccess, registryAccess], title: 'Prepare Lume base VM', dangerLevel: 'writesLocal',
      confirmation: { title: 'Prepare this Lume image?', body: 'Download the selected image and install the CLI and reusable Setup steps in an owned VM. The stopped base uses disk space; each sandbox clones it.', confirmLabel: 'Prepare image' },
      inputSchema: PREPARATION_SCHEMAS.buildInput, resultSchema: PREPARATION_SCHEMAS.buildResult,
      async run(input, context) { return (await preparationRuntime(context)).build(input); },
    },
    'prepare-inspect': { ...defaults, title: 'Inspect Lume prepared image', dangerLevel: 'safe',
      inputSchema: PREPARATION_SCHEMAS.inspectInput, resultSchema: PREPARATION_SCHEMAS.inspectResult,
      async run(input, context) { return (await preparationRuntime(context)).inspect('nativeOperation' in input
        ? { nativeOperation: input.nativeOperation.value } : input); },
    },
    'prepare-destroy': { ...defaults, title: 'Delete Lume prepared image', dangerLevel: 'destructive',
      confirmation: { title: 'Delete this Lume image?', body: 'Permanently delete this owned prepared base VM and its disk.', confirmLabel: 'Delete image' },
      inputSchema: PREPARATION_SCHEMAS.destroyInput, resultSchema: PREPARATION_SCHEMAS.destroyResult,
      async run(input, context) { return (await preparationRuntime(context)).destroy({
        ...(input.artifact === undefined ? {} : { artifact: input.artifact.value }),
        ...(input.nativeOperation === undefined ? {} : { nativeOperation: input.nativeOperation.value }),
      }); },
    },
    install: { ...defaults, title: 'Install Lume', dangerLevel: 'writesLocal',
      confirmation: { title: 'Install Lume on this Mac?', body: 'Download the verified Lume app bundle for Apple silicon. This does not create a VM or start the Lume service.', confirmLabel: 'Install' },
      inputSchema: LUME_ROLE_SCHEMAS.checkInput, resultSchema: defineProtocolLiteral(null),
      async run(_input, context) {
        await context.services.managedServices.dependencies.ensure(LUME_DEPENDENCY_ID, { signal: context.signal });
        return null;
      },
    },
    check: { ...defaults, title: 'Check Lume availability', dangerLevel: 'safe',
      inputSchema: LUME_ROLE_SCHEMAS.checkInput, resultSchema: MachineProvisionerCheckResultV1Schema,
      async run(_input, context) {
        try {
          await context.services.exec.systemTools.resolve({ toolId: 'ssh-keyscan', purpose: 'Observe the native SSH host key', signal: context.signal });
          return machineCheckPresentation(await (await runtime(context)).provider.check());
        } catch (error) {
          // A missing `lume` is its own state, so its card can say how to get it; the server's own refusals stay typed below.
          const notInstalled = error !== null && typeof error === 'object' && 'notInstalled' in error && error.notInstalled === true;
          return projectMachineProvisionerActionFailure(error, () => machineCheckPresentation({ available: false, code: notInstalled ? 'lume_not_installed' : errorCode(error),
            ...(notInstalled ? { prerequisites: [projectUnavailableManagedDependency(LUME_DEPENDENCY_ID, {
              reason: 'lume_not_installed', repairAction: { action: { pluginId: LUME_PLUGIN_ID, localId: 'install' }, input: {} },
            })] } : {}),
          }));
        }
      },
    },
    options: { ...defaults, hostAccess: [...defaults.hostAccess, registryAccess], title: 'Read Lume image and storage choices', dangerLevel: 'safe',
      inputSchema: LumeOptionsInputV1Schema, resultSchema: MachineProvisionerOptionsResultV1Schema,
      inputHints: { fields: [
        { path: 'storage', title: label('storage'), description: label('storageDescription'), widget: 'text' },
        { path: 'cpu', role: 'cpu', title: label('cpu'), widget: 'integer', defaultValue: DEFAULT_CPU },
        { path: 'memoryBytes', role: 'memory', title: label('memory'), widget: 'integer', unit: 'bytes', defaultValue: DEFAULT_MEMORY_BYTES },
        { path: 'diskBytes', role: 'disk', title: label('disk'), widget: 'integer', unit: 'bytes' },
        { path: 'image.kind', title: label('imageKind'), widget: 'select', requireExplicitSelection: true,
          options: [{ value: 'catalog', label: label('publishedImage') }, { value: 'native-image', label: label('nativeReference') }] },
        { path: 'image.id', title: label('publishedReference'), widget: 'text',
          visibleWhen: { op: 'eq', path: 'image.kind', value: 'catalog' },
          requiredWhen: { op: 'eq', path: 'image.kind', value: 'catalog' } },
        { path: 'image.reference', title: label('nativeReference'),
          description: label('nativeDescription'), widget: 'text',
          visibleWhen: { op: 'eq', path: 'image.kind', value: 'native-image' },
          requiredWhen: { op: 'eq', path: 'image.kind', value: 'native-image' } },
        { path: 'image.privateCarrier.kind', title: label('privateCarrier'), widget: 'select', requireExplicitSelection: true,
          description: label('privateDescription'),
          options: [{ value: 'lume-default-password', label: label('preparedSsh') }],
          visibleWhen: { op: 'eq', path: 'image.kind', value: 'native-image' } },
        { path: 'image.privateCarrier.guestOs', title: label('guestOs'), widget: 'select', requireExplicitSelection: true,
          options: [{ value: 'linux', label: 'Linux' }, { value: 'macos', label: 'macOS' }],
          visibleWhen: { op: 'and', all: [
            { op: 'eq', path: 'image.kind', value: 'native-image' },
            { op: 'eq', path: 'image.privateCarrier.kind', value: 'lume-default-password' },
          ] },
          requiredWhen: { op: 'and', all: [
            { op: 'eq', path: 'image.kind', value: 'native-image' },
            { op: 'eq', path: 'image.privateCarrier.kind', value: 'lume-default-password' },
          ] } },
        { path: 'image.privateCarrier.user', title: label('user'), widget: 'text',
          description: label('userDescription'),
          visibleWhen: { op: 'and', all: [
            { op: 'eq', path: 'image.kind', value: 'native-image' },
            { op: 'eq', path: 'image.privateCarrier.kind', value: 'lume-default-password' },
          ] },
          requiredWhen: { op: 'and', all: [
            { op: 'eq', path: 'image.kind', value: 'native-image' },
            { op: 'eq', path: 'image.privateCarrier.kind', value: 'lume-default-password' },
          ] } },
        { path: 'keepPasswordLogin', title: label('keepPasswordLogin'),
          description: label('keepPasswordLoginDescription'), widget: 'boolean' },
      ] } satisfies NonNullable<ActionContribution['inputHints']>,
      async run(input, context) { return (await runtime(context)).provider.options(input); },
    },
    acquire: { ...defaults, hostAccess: [...defaults.hostAccess, registryAccess], title: 'Create Lume guest', dangerLevel: 'writesLocal',
      confirmation: { title: 'Create this Lume guest?', body: 'This downloads the selected image and creates a VM on the selected Mac and storage.', confirmLabel: 'Create guest' },
      inputSchema: LUME_ROLE_SCHEMAS.acquireInput, resultSchema: LUME_RECONCILIATION_SCHEMAS.result,
      async run(input, context) {
        if (!input.managedId) return { kind: 'rejected' as const, code: 'invalid_request' as const };
        let current: Awaited<ReturnType<typeof runtime>>;
        try { current = await runtime(context); }
        catch (error) { return projectMachineProvisionerActionFailure(error, () => ({ kind: 'rejected' as const, code: 'provider_unavailable' as const })); }
        try { return await current.provider.acquire(input.launch, input.managedId, input.resource); }
        catch (error) { return projectMachineProvisionerActionFailure(error, async () => { const { lumeOperationForLaunch } = await import('./machine/provider.js');
          const operation = lumeOperationForLaunch(input.launch, input.managedId);
          return operation.success ? { kind: 'pending' as const, nativeOperationRef: {
            contributionRef: { pluginId: LUME_PLUGIN_ID, localId: LUME_PROVISIONER_ID }, schemaVersion: 1, value: operation.data } }
            : { kind: 'rejected' as const, code: 'invalid_request' as const }; }); }
      },
    },
    reconcile: { ...defaults, title: 'Recover exact Lume guest acquisition', dangerLevel: 'safe',
      inputSchema: LUME_RECONCILIATION_SCHEMAS.input, resultSchema: LUME_RECONCILIATION_SCHEMAS.result,
      async run(input, context) {
        const current = await runtime(context);
        if ('nativeOperation' in input) return current.provider.reconcile(input.nativeOperation);
        const { lumeOperationForLaunch } = await import('./machine/provider.js');
        const operation = lumeOperationForLaunch(input.correlation.launch, input.correlation.managedId);
        return operation.success ? current.provider.reconcile(operation.data)
          : { kind: 'rejected' as const, code: 'invalid_request' as const };
      },
    },
    bootstrap: { ...defaults, title: 'Resolve protected Lume SSH bootstrap', dangerLevel: 'writesLocal',
      confirmation: { title: 'Prepare this Lume guest for Happier?', body: 'This installs the controller-held public SSH key in the exact managed guest.', confirmLabel: 'Prepare guest' },
      inputSchema: LUME_ROLE_SCHEMAS.bootstrapInput, resultSchema: MachineProvisionerBootstrapCarrierV1Schema,
      async run(input, context) {
        const current = await runtime(context);
        const { resolveLumeBootstrap } = await import('./machine/bootstrap.js');
        return resolveLumeBootstrap({ native: current.native,
          credentials: context.services.machineProvisioners,
          exec: context.services.exec, resource: input.resource, credentialRef: input.credentialRef,
          bootstrapPublicKey: input.bootstrapPublicKey, signal: context.signal });
      },
    },
    inspect: { ...defaults, title: 'Inspect exact Lume guest', dangerLevel: 'safe',
      inputSchema: LUME_ROLE_SCHEMAS.resourceInput, resultSchema: MachineProvisionerObservationV1Schema,
      async run(input, context) {
        try { return await (await runtime(context)).provider.inspect(input.resource); }
        catch (error) { return projectMachineProvisionerActionFailure(error, () => observeMachineProvisionerNativeRead(context.invokedAtMs, { kind: 'unknown', reason: errorCode(error) })); }
      },
    },
    power: { ...defaults, title: 'Change Lume guest power', dangerLevel: 'writesLocal',
      confirmation: { title: 'Change this Lume guest’s power?', body: 'This starts or stops the exact managed VM. Stop does not preserve running memory.', confirmLabel: 'Change power' },
      inputSchema: LUME_ROLE_SCHEMAS.powerInput, resultSchema: MachineProvisionerPowerResultV1Schema,
      async run(input, context) {
        try { return await (await runtime(context)).provider.power(input.resource, input.intent); }
        catch (error) { return projectMachineProvisionerActionFailure(error, () => ({ kind: 'unknown' as const, code: errorCode(error) })); }
      },
    },
    destroy: { ...defaults, title: 'Delete exact Lume guest', dangerLevel: 'destructive',
      confirmation: { title: 'Delete this Lume guest?', body: 'This stops the exact managed VM and permanently removes its disk from the recorded storage.', confirmLabel: 'Delete guest' },
      inputSchema: LUME_RECONCILIATION_SCHEMAS.destroyInput, resultSchema: MachineProvisionerPowerResultV1Schema,
      async run(input, context) {
        try { return await (await runtime(context)).provider.destroy('resource' in input ? input.resource : input.nativeOperation); }
        catch (error) { return projectMachineProvisionerActionFailure(error, () => ({ kind: 'unknown' as const, code: errorCode(error) })); }
      },
    },
  },
});
export const PLUGIN_MANIFEST = LUME_PLUGIN.manifest;
