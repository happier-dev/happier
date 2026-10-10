import { definePlugin, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { machinePresentationLabel, machineCheckPresentation, DIGITALOCEAN_UI_TRANSLATION_BUNDLES } from './ui/translations.js';
import { CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 } from '@happier-dev/plugin-sdk/connected-accounts';
import { defineMachineProvisionerSchemas, defineMachineProvisionerReconciliationSchemas, prepareMachineProvisionerStoredSchemas,
  MachineProvisionerBootstrapCarrierV1Schema, MachineProvisionerCheckResultV1Schema,
  MachineProvisionerObservationV1Schema, MachineProvisionerOptionsResultV1Schema,
  MachineProvisionerPowerResultV1Schema, type MachineProvisionerAuthorDefinitionV1,
} from '@happier-dev/plugin-sdk/machine-provisioners';
import { resolveMachineProvisionerSshBootstrap } from '@happier-dev/plugin-sdk/machine-provisioners/ssh';
import { createDigitalOceanProvider } from './machine/provider.js';
import { dropletLaunchSchema, dropletResourceSchema, dropletNativeOperationSchema } from './machine/schemas.js';
import { ACCOUNT_ID, ACCOUNT_PURPOSE, connectedAccountRuntime, nativeFetch } from './account.js';

export const PLUGIN_ID = 'happier.machine.digitalocean';
export const PROVISIONER_ID = 'digitalocean';
const nativeSchemas = { launch: dropletLaunchSchema, resource: dropletResourceSchema, nativeOperation: dropletNativeOperationSchema };
const reconciliation = defineMachineProvisionerReconciliationSchemas(nativeSchemas);
export const ROLE_SCHEMAS = { ...defineMachineProvisionerSchemas(nativeSchemas), acquireResult: reconciliation.result };
export const prepareStoredSchemas = () => prepareMachineProvisionerStoredSchemas(nativeSchemas);
function resourceRef<T>(value: T) { return { contributionRef: { pluginId: PLUGIN_ID, localId: PROVISIONER_ID }, schemaVersion: 1, value }; }
function pending(recoveryTag: string) { return { kind: 'pending' as const, nativeOperationRef: resourceRef({ recoveryTag }) }; }
const billing = { location: 'cloud', stoppedBilling: 'billed' } as const;
const defaults = { scopes: ['machine'], surfaces: ['cli', 'plugin'], hostAccess: ['native-api', ACCOUNT_PURPOSE] } as const;
const runtime = async (context: PluginInvocationContext) => createDigitalOceanProvider({ token: 'host-bound', fetch: nativeFetch(context), signal: context.signal, now: () => new Date(context.invokedAtMs) });
function unavailable() { return { observedAt: 0, availability: 'unavailable' as const, reason: 'provider_unavailable' }; }

export const MACHINE_PROVISIONER = {
  title: 'DigitalOcean', icon: 'hard-drives', resourceKind: 'digitalocean-droplet', schemaVersion: 1,
  kindTitle: machinePresentationLabel('kind'), description: machinePresentationLabel('description'),
  launchSchema: dropletLaunchSchema.jsonSchema, resourceSchema: dropletResourceSchema.jsonSchema, resourceIdPath: 'dropletId',
  platforms: ['darwin', 'linux', 'win32'], prerequisites: [{ kind: 'systemTool', id: 'ssh-keyscan' }],
  billing, retention: { supportedIntents: ['start', 'stop', 'delete'] },
  actions: { check: 'check', options: 'options', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', power: 'power', destroy: 'destroy' },
  reconciliation: { action: 'reconcile', nativeOperationSchema: dropletNativeOperationSchema.jsonSchema },
} satisfies MachineProvisionerAuthorDefinitionV1;

export const PLUGIN = definePlugin({
  id: PLUGIN_ID, version: '0.0.0', displayName: 'DigitalOcean Machines',
  // The provider's own mark beside its name in Machines: DigitalOcean's mark from Simple Icons 13.21.0 (CC0-1.0), brand blue #0080FF.
  brand: { iconResourceId: 'brand-icon' },
  resources: { 'brand-icon': { kind: 'asset', path: 'assets/brand.png', contentType: 'image/png' } },
  description: 'Manage exact reviewed DigitalOcean resources through captured cloud credentials.',
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 }, entrypoints: { daemon: './.happier-plugin/daemon.js' },
  hostAccess: { required: [
    { id: 'native-api', capability: 'network', reason: 'Operate the exact reviewed DigitalOcean resource.',
      scope: { targets: [{ kind: 'fixedOrigin', origin: 'https://api.digitalocean.com' }], methods: ['GET', 'POST', 'DELETE'] } },
    { id: ACCOUNT_PURPOSE, capability: 'connectedAccounts', reason: 'Use only the captured DigitalOcean account.',
      scope: { serviceRefs: [ACCOUNT_ID], operations: ['use'], materializationKinds: ['httpHeaders'] } },
    { id: 'ssh-evidence', capability: 'process', reason: 'Observe the managed guest key for the canonical SSH trust prompt.',
      scope: { executables: [{ kind: 'systemTool', id: 'ssh-keyscan' }] } },
  ], optional: [] },
  systemTools: { 'ssh-keyscan': { title: 'OpenSSH host key scanner', executableNames: ['ssh-keyscan'] } },
  connectedAccountDescriptors: { [ACCOUNT_ID]: {
    declaration: { title: 'DigitalOcean cloud account', authentication: { defaultModeId: 'token', modes: [{
      id: 'token', kind: 'manual', title: 'API token', outcomeReconciliation: 'none',
      directExport: { contractVersion: CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 },
      fields: [{ id: 'token', title: 'API token', schema: { type: 'string', minLength: 1 }, secret: true }],
    }] } }, runtime: connectedAccountRuntime,
  } },
  ui: { translations: DIGITALOCEAN_UI_TRANSLATION_BUNDLES },
  machineProvisioners: { [PROVISIONER_ID]: MACHINE_PROVISIONER },
  actions: {
    reconcile: { ...defaults, title: 'Recover exact DigitalOcean resource', dangerLevel: 'safe',
      inputSchema: reconciliation.input, resultSchema: reconciliation.result,
      async run(input, context) {
        const recoveryTag = 'nativeOperation' in input ? input.nativeOperation.recoveryTag : `happier-${input.correlation.managedId}`;
        try {
          const result = await (await runtime(context)).recover(recoveryTag);
          if (result.kind === 'bound') return { kind: 'bound' as const, resource: resourceRef(result.resource) };
        } catch { /* An unavailable read neither proves absence nor authorizes another purchase. */ }
        return pending(recoveryTag);
      },
    },
    check: { ...defaults, title: 'Check DigitalOcean API access', dangerLevel: 'safe',
      inputSchema: ROLE_SCHEMAS.checkInput, resultSchema: MachineProvisionerCheckResultV1Schema,
      async run(_input, context) { try { return machineCheckPresentation(await (await runtime(context)).check()); } catch { return machineCheckPresentation({ available: false, code: 'provider_unavailable' }); } },
    },
    options: { ...defaults, title: 'Discover DigitalOcean options', dangerLevel: 'safe',
      inputSchema: ROLE_SCHEMAS.checkInput, resultSchema: MachineProvisionerOptionsResultV1Schema,
      async run(_input, context) { const facts = await (await runtime(context)).options();
        if (facts.kind !== 'available') throw new Error('provider_unavailable');
        return { choices: facts.sizes.flatMap(size => facts.regions.filter(region => size.regions.includes(region.slug))
          .flatMap(region => facts.images.filter(image => image.bootstrapSupported && image.regions.includes(region.slug))
            .flatMap(image => [false, true].map(ipv6 => ({
              id: `${size.slug}/${region.slug}/${image.id}/${Number(ipv6)}`,
              title: `${size.slug} · ${size.vcpus} CPU · ${size.memory} MB · ${size.disk} GB · ${image.name} · ${region.name}`,
              launch: { regionSlug: region.slug, sizeSlug: size.slug, imageId: image.id, publicNetworking: { ipv6 } },
              available: size.available && region.available && region.sizes.includes(size.slug) && image.status === 'available',
              prices: size.prices,
              nativeFacts: {
                size: { id: size.slug, title: `${size.slug} · ${size.vcpus} CPU · ${size.memory} MB · ${size.disk} GB`, cpuCores: size.vcpus,
                  memoryBytes: size.memory * 1024 ** 2, diskBytes: size.disk * 1000 ** 3 },
                image: { id: String(image.id), title: image.name,
                  ...(image.description ? { description: image.description } : {}) },
                location: { id: region.slug, title: region.name },
                monthlyCapStatus: size.monthlyCapStatus,
              },
            }))))) }; },
    },
    acquire: { ...defaults, title: 'Acquire DigitalOcean resource', dangerLevel: 'destructive',
      confirmation: { title: 'Create this DigitalOcean Droplet?', body: 'This creates the reviewed paid resource. Stopped Droplets remain billable.' },
      inputSchema: ROLE_SCHEMAS.acquireInput, resultSchema: ROLE_SCHEMAS.acquireResult,
      async run(input, context) {
        if (!input.managedId || !input.bootstrapPublicKey) return { kind: 'rejected' as const, code: 'invalid_request' as const };
        try { const result = await (await runtime(context)).acquire({ launch: input.launch, name: `happier-${input.managedId}`, recoveryTag: `happier-${input.managedId}`, bootstrapSshPublicKey: input.bootstrapPublicKey });
        if (result.kind === 'bound') return { kind: 'bound' as const, resource: resourceRef(result.resource) };
        if (result.kind === 'unknown') return pending(`happier-${input.managedId}`);
        return { kind: 'rejected' as const, code: 'provider_unavailable' as const }; }
        catch { return pending(`happier-${input.managedId}`); }
      },
    },
    bootstrap: { ...defaults, hostAccess: [...defaults.hostAccess, 'ssh-evidence'], title: 'Resolve protected DigitalOcean bootstrap', dangerLevel: 'writesLocal',
      confirmation: { title: 'Prepare this DigitalOcean Droplet for Happier?', body: 'Allow Happier to resolve the protected SSH transport for the exact managed resource.' },
      inputSchema: ROLE_SCHEMAS.bootstrapInput, resultSchema: MachineProvisionerBootstrapCarrierV1Schema,
      async run(input, context) { const observed = await (await runtime(context)).bootstrap(input.resource);
        if (observed.kind !== 'present' || !observed.ready || !observed.ssh) throw new Error('provider_unavailable');
        return resolveMachineProvisionerSshBootstrap({ exec: context.services.exec, signal: context.signal,
          connection: observed.ssh, credentialRef: input.credentialRef }); },
    },
    inspect: { ...defaults, title: 'Inspect exact DigitalOcean resource', dangerLevel: 'safe',
      inputSchema: ROLE_SCHEMAS.resourceInput, resultSchema: MachineProvisionerObservationV1Schema,
      async run(input, context) { try { const result = await (await runtime(context)).inspect(input.resource);
        return { observedAt: context.invokedAtMs, availability: result.kind === 'unavailable' ? 'unavailable' as const : result.kind,
          ...(result.kind === 'present' ? { power: result.power, storage: 'retained' as const, billing } : {}),
          ...(result.kind === 'unavailable' ? { reason: result.reason } : {}) }; } catch { return { ...unavailable(), observedAt: context.invokedAtMs }; } },
    },
    power: { ...defaults, title: 'Change DigitalOcean power', dangerLevel: 'destructive',
      confirmation: { title: 'Change this DigitalOcean Droplet’s power?', body: 'This starts or stops the exact managed resource. Stopped Droplets remain billable.' },
      inputSchema: ROLE_SCHEMAS.powerInput, resultSchema: MachineProvisionerPowerResultV1Schema,
      async run(input, context) {
        if (input.intent !== 'start' && input.intent !== 'stop') return { kind: 'refused' as const, code: 'native_unsupported_intent' };
        try { const native = await runtime(context);
        const changed = await native.power(input.resource, input.intent);
        if (changed.kind === 'failed') return { kind: 'refused' as const, code: 'native_action_failed' };
        if (changed.kind === 'unavailable') return { kind: 'unknown' as const, code: changed.reason };
        const observed = await native.observeAction(input.resource, changed.actionId);
        return observed.kind === 'completed' ? { kind: 'confirmed' as const } : { kind: 'unknown' as const, code: 'native_power_pending' }; } catch { return { kind: 'unknown' as const, code: 'provider_unavailable' }; }
      },
    },
    destroy: { ...defaults, title: 'Delete exact DigitalOcean resource', dangerLevel: 'destructive',
      confirmation: { title: 'Delete this DigitalOcean Droplet?', body: 'This permanently deletes the exact managed Droplet and its recorded owned volumes.' },
      inputSchema: reconciliation.destroyInput, resultSchema: MachineProvisionerPowerResultV1Schema,
      async run(input, context) {
        if (!('resource' in input)) return { kind: 'refused' as const, code: 'native_cleanup_unavailable' };
        try { const result = await (await runtime(context)).destroy(input.resource);
        return result.kind === 'deleted' ? { kind: 'confirmed' as const } : { kind: 'unknown' as const, code: 'native_cleanup_incomplete' }; } catch { return { kind: 'unknown' as const, code: 'provider_unavailable' }; } },
    },
  },
});
export const PLUGIN_MANIFEST = PLUGIN.manifest;
