import { definePlugin, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { machinePresentationLabel, machineCheckPresentation } from './ui/translations.js';
import {
  defineMachineProvisionerSchemas, defineMachineProvisionerReconciliationSchemas, prepareMachineProvisionerStoredSchemas,
  MachineProvisionerBootstrapCarrierV1Schema, MachineProvisionerCheckResultV1Schema,
  MachineProvisionerObservationV1Schema, MachineProvisionerOptionsResultV1Schema,
  MachineProvisionerPowerResultV1Schema,
  type MachineProvisionerAuthorDefinitionV1,
} from '@happier-dev/plugin-sdk/machine-provisioners';
import type { HttpMethod } from '@happier-dev/plugin-sdk/http';
import type { ActionContribution } from '@happier-dev/plugin-sdk/actions';
import { lumeConfigurationLabel as label, LUME_UI_TRANSLATION_BUNDLES } from './ui/translations.js';
import { LUME_PLUGIN_ID, LUME_PROVISIONER_ID, LUME_DEPENDENCY_ID, LUME_BILLING } from './machine/definition.js';
import { LumeLaunchV1Schema, LumeResourceV1Schema, LumeNativeOperationV1Schema, LumeOptionsInputV1Schema } from './machine/schemas.js';

export const LUME_ROLE_SCHEMAS = defineMachineProvisionerSchemas({ launch: LumeLaunchV1Schema, resource: LumeResourceV1Schema, continueAcquire: true });
export const LUME_RECONCILIATION_SCHEMAS = defineMachineProvisionerReconciliationSchemas({ launch: LumeLaunchV1Schema,
  resource: LumeResourceV1Schema, nativeOperation: LumeNativeOperationV1Schema });
export const prepareLumeStoredSchemas = () => prepareMachineProvisionerStoredSchemas({ launch: LumeLaunchV1Schema, resource: LumeResourceV1Schema, nativeOperation: LumeNativeOperationV1Schema });
const processAccess = 'lume-process';
const networkAccess = 'lume-http';
const registryAccess = 'lume-image-registry';
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
  const status = await context.services.managedServices.dependencies.status(LUME_DEPENDENCY_ID, { signal: context.signal });
  if ((status.state !== 'ready' && status.state !== 'updateAvailable') || !status.executable) {
    throw Object.assign(new Error('Declared native Lume executable unavailable'), { code: 'provider_unavailable' });
  }
  const [{ createLumeNativeClient }, { createLumeProvider }] = await Promise.all([
    import('./machine/nativeClient.js'), import('./machine/provider.js'),
  ]);
  const native = createLumeNativeClient({ baseUrl: origin, fetch: async (rawUrl, init) => {
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
    provider: createLumeProvider({ native, observedAt: context.invokedAtMs, signal: context.signal }) };
}

export const LUME_MACHINE_PROVISIONER = {
  title: 'Lume', icon: 'desktop', resourceKind: 'lume-vm', schemaVersion: 1,
  kindTitle: machinePresentationLabel('kind'), description: machinePresentationLabel('description'),
  launchSchema: LumeLaunchV1Schema.jsonSchema, resourceSchema: LumeResourceV1Schema.jsonSchema,
  platforms: ['darwin'], prerequisites: [{ kind: 'managedDependency', id: LUME_DEPENDENCY_ID }, { kind: 'systemTool', id: 'ssh-keyscan' }],
  billing: LUME_BILLING, retention: { supportedIntents: ['start', 'stop', 'delete'] },
  actions: { check: 'check', options: 'options', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', power: 'power', destroy: 'destroy' },
  reconciliation: { nativeOperationSchema: LumeNativeOperationV1Schema.jsonSchema, action: 'reconcile', continueAcquire: true },
} satisfies MachineProvisionerAuthorDefinitionV1;

export const LUME_PLUGIN = definePlugin({
  id: LUME_PLUGIN_ID, version: '0.0.0', displayName: 'Lume Machines',
  description: 'Managed Lume guests on the selected Apple silicon Mac.',
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 }, entrypoints: { daemon: './.happier-plugin/daemon.js' },
  hostAccess: { required: [
    { id: processAccess, capability: 'process', reason: 'Prepare the public SSH key and inspect the reviewed local Lume guest.',
      scope: { executables: [{ kind: 'managedDependency', id: LUME_DEPENDENCY_ID }, { kind: 'systemTool', id: 'ssh-keyscan' }] } },
    { id: networkAccess, capability: 'network', reason: 'Operate the exact managed resource through the controller-local Lume service.',
      scope: { targets: [{ kind: 'fixedOrigin', origin }], methods: ['GET', 'POST', 'PATCH', 'DELETE'] } },
    { id: registryAccess, capability: 'network', reason: 'Read native public image tags through anonymous GHCR pull-scoped authentication.',
      scope: { targets: [{ kind: 'fixedOrigin', origin: 'https://ghcr.io' }], methods: ['GET'] } },
  ], optional: [] },
  managedDependencies: { [LUME_DEPENDENCY_ID]: {
    id: LUME_DEPENDENCY_ID, title: 'Lume', executable: 'lume', platforms: ['macos'], architectures: ['arm64'],
    sources: [{ kind: 'system', executableNames: ['lume'], versionArguments: ['--version'] }],
  } },
  systemTools: { 'ssh-keyscan': { title: 'OpenSSH host key scanner', executableNames: ['ssh-keyscan'] } },
  machineProvisioners: { [LUME_PROVISIONER_ID]: LUME_MACHINE_PROVISIONER },
  ui: { translations: LUME_UI_TRANSLATION_BUNDLES },
  actions: {
    check: { ...defaults, title: 'Check Lume availability', dangerLevel: 'safe',
      inputSchema: LUME_ROLE_SCHEMAS.checkInput, resultSchema: MachineProvisionerCheckResultV1Schema,
      async run(_input, context) {
        try {
          await context.services.exec.systemTools.resolve({ toolId: 'ssh-keyscan', purpose: 'Observe the native SSH host key', signal: context.signal });
          return machineCheckPresentation(await (await runtime(context)).provider.check());
        } catch (error) { return machineCheckPresentation({ available: false, code: errorCode(error) }); }
      },
    },
    options: { ...defaults, hostAccess: [...defaults.hostAccess, registryAccess], title: 'Read Lume image and storage choices', dangerLevel: 'safe',
      inputSchema: LumeOptionsInputV1Schema, resultSchema: MachineProvisionerOptionsResultV1Schema,
      inputHints: { fields: [
        { path: 'storage', title: label('storage'), description: label('storageDescription'), widget: 'text' },
        { path: 'cpu', title: label('cpu'), widget: 'integer' },
        { path: 'memoryBytes', title: label('memory'), widget: 'integer' },
        { path: 'diskBytes', title: label('disk'), widget: 'integer' },
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
        catch { return { kind: 'rejected' as const, code: 'provider_unavailable' as const }; }
        try { return await current.provider.acquire(input.launch, input.managedId, input.resource); }
        catch { const { lumeOperationForLaunch } = await import('./machine/provider.js');
          const operation = lumeOperationForLaunch(input.launch, input.managedId);
          return operation.success ? { kind: 'pending' as const, nativeOperationRef: {
            contributionRef: { pluginId: LUME_PLUGIN_ID, localId: LUME_PROVISIONER_ID }, schemaVersion: 1, value: operation.data } }
            : { kind: 'rejected' as const, code: 'invalid_request' as const }; }
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
        const scanner = await context.services.exec.systemTools.resolve({ toolId: 'ssh-keyscan', purpose: 'Observe the exact guest host key', signal: context.signal });
        const { resolveLumeBootstrap } = await import('./machine/bootstrap.js');
        return resolveLumeBootstrap({ native: current.native, executable: current.executable, scanner: scanner.executable,
          exec: context.services.exec, resource: input.resource, credentialRef: input.credentialRef,
          bootstrapPublicKey: input.bootstrapPublicKey, signal: context.signal });
      },
    },
    inspect: { ...defaults, title: 'Inspect exact Lume guest', dangerLevel: 'safe',
      inputSchema: LUME_ROLE_SCHEMAS.resourceInput, resultSchema: MachineProvisionerObservationV1Schema,
      async run(input, context) {
        try { return await (await runtime(context)).provider.inspect(input.resource); }
        catch (error) { return { observedAt: context.invokedAtMs, availability: 'unavailable' as const, reason: errorCode(error) }; }
      },
    },
    power: { ...defaults, title: 'Change Lume guest power', dangerLevel: 'writesLocal',
      confirmation: { title: 'Change this Lume guest’s power?', body: 'This starts or stops the exact managed VM. Stop does not preserve running memory.', confirmLabel: 'Change power' },
      inputSchema: LUME_ROLE_SCHEMAS.powerInput, resultSchema: MachineProvisionerPowerResultV1Schema,
      async run(input, context) {
        try { return await (await runtime(context)).provider.power(input.resource, input.intent); }
        catch (error) { return { kind: 'unknown' as const, code: errorCode(error) }; }
      },
    },
    destroy: { ...defaults, title: 'Delete exact Lume guest', dangerLevel: 'destructive',
      confirmation: { title: 'Delete this Lume guest?', body: 'This stops the exact managed VM and permanently removes its disk from the recorded storage.', confirmLabel: 'Delete guest' },
      inputSchema: LUME_RECONCILIATION_SCHEMAS.destroyInput, resultSchema: MachineProvisionerPowerResultV1Schema,
      async run(input, context) {
        try { return await (await runtime(context)).provider.destroy('resource' in input ? input.resource : input.nativeOperation); }
        catch (error) { return { kind: 'unknown' as const, code: errorCode(error) }; }
      },
    },
  },
});
export const PLUGIN_MANIFEST = LUME_PLUGIN.manifest;
