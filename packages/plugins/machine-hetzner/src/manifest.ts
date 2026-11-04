import { projectHetznerOptions } from './machine/options.js';
import { definePlugin, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { machinePresentationLabel, machineCheckPresentation } from './ui/translations.js';
import { CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 } from '@happier-dev/plugin-sdk/connected-accounts';
import { defineMachineProvisionerSchemas, defineMachineProvisionerReconciliationSchemas, prepareMachineProvisionerStoredSchemas,
  MachineProvisionerBootstrapCarrierV1Schema, MachineProvisionerCheckResultV1Schema,
  MachineProvisionerObservationV1Schema, MachineProvisionerOptionsResultV1Schema,
  MachineProvisionerPowerResultV1Schema, type MachineProvisionerAuthorDefinitionV1, type MachineProvisionerOptionsResultV1,
} from '@happier-dev/plugin-sdk/machine-provisioners';
import { resolveMachineProvisionerSshBootstrap } from '@happier-dev/plugin-sdk/machine-provisioners/ssh';
import { createHetznerProvider } from './machine/provider.js';
import { HetznerLaunchV1Schema, HetznerResourceV1Schema, HetznerNativeOperationV1Schema } from './machine/schemas.js';
import { ACCOUNT_ID, ACCOUNT_PURPOSE, connectedAccountRuntime, nativeFetch } from './account.js';


export const PLUGIN_ID = 'happier.machine.hetzner';
export const PROVISIONER_ID = 'hetzner';
const nativeSchemas = { launch: HetznerLaunchV1Schema, resource: HetznerResourceV1Schema, nativeOperation: HetznerNativeOperationV1Schema };
const reconciliation = defineMachineProvisionerReconciliationSchemas(nativeSchemas);
export const ROLE_SCHEMAS = { ...defineMachineProvisionerSchemas(nativeSchemas), acquireResult: reconciliation.result };
export const prepareStoredSchemas = () => prepareMachineProvisionerStoredSchemas(nativeSchemas);
function resourceRef<T>(value: T) { return { contributionRef: { pluginId: PLUGIN_ID, localId: PROVISIONER_ID }, schemaVersion: 1, value }; }
function pending(correlation: string) { return { kind: 'pending' as const, nativeOperationRef: resourceRef({ correlation }) }; }
const billing = { location: 'cloud', stoppedBilling: 'billed' } as const;
const defaults = { scopes: ['machine'], surfaces: ['cli', 'plugin'], hostAccess: ['native-api', ACCOUNT_PURPOSE] } as const;
const runtime = async (context: PluginInvocationContext) => createHetznerProvider({ token: 'host-bound', fetch: nativeFetch(context), signal: context.signal });
function unavailable() { return { observedAt: 0, availability: 'unavailable' as const, reason: 'provider_unavailable' }; }


export const MACHINE_PROVISIONER = {
  title: 'Hetzner', icon: 'hard-drives', resourceKind: 'hetzner-server', schemaVersion: 1,
  kindTitle: machinePresentationLabel('kind'), description: machinePresentationLabel('description'),
  launchSchema: HetznerLaunchV1Schema.jsonSchema, resourceSchema: HetznerResourceV1Schema.jsonSchema, resourceIdPath: 'serverId',
  platforms: ['darwin', 'linux', 'win32'], prerequisites: [{ kind: 'systemTool', id: 'ssh-keyscan' }],
  billing, retention: { supportedIntents: ['start', 'stop', 'delete'] },
  actions: { check: 'check', options: 'options', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', power: 'power', destroy: 'destroy' },
  reconciliation: { action: 'reconcile', nativeOperationSchema: HetznerNativeOperationV1Schema.jsonSchema },
} satisfies MachineProvisionerAuthorDefinitionV1;

export const PLUGIN = definePlugin({
  id: PLUGIN_ID, version: '0.0.0', displayName: 'Hetzner Machines',
  // The provider's own mark beside its name in Machines: Hetzner's mark from Simple Icons 13.21.0 (CC0-1.0), brand red #D50C2D with the white H.
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
  description: 'Manage exact reviewed Hetzner resources through captured cloud credentials.',
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 }, entrypoints: { daemon: './.happier-plugin/daemon.js' },
  hostAccess: { required: [
    { id: 'native-api', capability: 'network', reason: 'Operate the exact reviewed Hetzner resource.',
      scope: { targets: [{ kind: 'fixedOrigin', origin: 'https://api.hetzner.cloud' }], methods: ['GET', 'POST', 'DELETE'] } },
    { id: ACCOUNT_PURPOSE, capability: 'connectedAccounts', reason: 'Use only the captured Hetzner account.',
      scope: { serviceRefs: [ACCOUNT_ID], operations: ['use'], materializationKinds: ['httpHeaders'] } },
    { id: 'ssh-evidence', capability: 'process', reason: 'Observe the managed guest key for the canonical SSH trust prompt.',
      scope: { executables: [{ kind: 'systemTool', id: 'ssh-keyscan' }] } },
  ], optional: [] },
  systemTools: { 'ssh-keyscan': { title: 'OpenSSH host key scanner', executableNames: ['ssh-keyscan'] } },
  connectedAccountDescriptors: { [ACCOUNT_ID]: {
    declaration: { title: 'Hetzner cloud account', authentication: { defaultModeId: 'token', modes: [{
      id: 'token', kind: 'manual', title: 'API token', outcomeReconciliation: 'none',
      directExport: { contractVersion: CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 },
      fields: [{ id: 'token', title: 'API token', schema: { type: 'string', minLength: 1 }, secret: true }],
    }] } }, runtime: connectedAccountRuntime,
  } },
  machineProvisioners: { [PROVISIONER_ID]: MACHINE_PROVISIONER },
  actions: {
    reconcile: { ...defaults, title: 'Recover exact Hetzner resource', dangerLevel: 'safe',
      inputSchema: reconciliation.input, resultSchema: reconciliation.result,
      async run(input, context) {
        const correlation = 'nativeOperation' in input ? input.nativeOperation.correlation : input.correlation.managedId;
        try {
          const result = await (await runtime(context)).recover(correlation);
          if (result.kind === 'bound') return { kind: 'bound' as const, resource: resourceRef(result.resource) };
        } catch { /* An unavailable read neither proves absence nor authorizes another purchase. */ }
        return pending(correlation);
      },
    },
    check: { ...defaults, title: 'Check Hetzner API access', dangerLevel: 'safe',
      inputSchema: ROLE_SCHEMAS.checkInput, resultSchema: MachineProvisionerCheckResultV1Schema,
      async run(_input, context) { try { return machineCheckPresentation(await (await runtime(context)).check()); } catch { return machineCheckPresentation({ available: false, code: 'provider_unavailable' }); } },
    },
    options: { ...defaults, title: 'Discover Hetzner options', dangerLevel: 'safe',
      inputSchema: ROLE_SCHEMAS.checkInput, resultSchema: MachineProvisionerOptionsResultV1Schema,
      async run(_input, context): Promise<MachineProvisionerOptionsResultV1> { return projectHetznerOptions(await (await runtime(context)).options()); },
    },
    acquire: { ...defaults, title: 'Acquire Hetzner resource', dangerLevel: 'destructive',
      confirmation: { title: 'Create this Hetzner Server?', body: 'This creates the reviewed paid resource. Powered-off Servers remain billable.' },
      inputSchema: ROLE_SCHEMAS.acquireInput, resultSchema: ROLE_SCHEMAS.acquireResult,
      async run(input, context) {
        if (!input.managedId || !input.bootstrapPublicKey) return { kind: 'rejected' as const, code: 'invalid_request' as const };
        try { const result = await (await runtime(context)).acquire({ launch: input.launch, name: `happier-${input.managedId}`, correlation: input.managedId, bootstrapSshPublicKey: input.bootstrapPublicKey });
        if (result.kind === 'bound') return { kind: 'bound' as const, resource: resourceRef(result.resource) };
        return result.kind === 'rejected' ? { kind: 'rejected' as const, code: 'provider_unavailable' as const }
          : pending(input.managedId); }
        catch { return pending(input.managedId); }
      },
    },
    bootstrap: { ...defaults, hostAccess: [...defaults.hostAccess, 'ssh-evidence'], title: 'Resolve protected Hetzner bootstrap', dangerLevel: 'writesLocal',
      confirmation: { title: 'Prepare this Hetzner Server for Happier?', body: 'Allow Happier to resolve the protected SSH transport for the exact managed resource.' },
      inputSchema: ROLE_SCHEMAS.bootstrapInput, resultSchema: MachineProvisionerBootstrapCarrierV1Schema,
      async run(input, context) { const connection = await (await runtime(context)).bootstrap(input.resource);
        return resolveMachineProvisionerSshBootstrap({ exec: context.services.exec, signal: context.signal,
          connection: { address: connection.address, user: connection.username, port: connection.port }, credentialRef: input.credentialRef }); },
    },
    inspect: { ...defaults, title: 'Inspect exact Hetzner resource', dangerLevel: 'safe',
      inputSchema: ROLE_SCHEMAS.resourceInput, resultSchema: MachineProvisionerObservationV1Schema,
      async run(input, context) { try { const result = await (await runtime(context)).inspect(input.resource);
        return { observedAt: context.invokedAtMs, availability: result.kind,
          ...(result.kind === 'present' ? { power: result.power === 'transitioning' ? 'unknown' as const : result.power, storage: 'retained' as const, billing } : {}) }; } catch { return { ...unavailable(), observedAt: context.invokedAtMs }; } },
    },
    power: { ...defaults, title: 'Change Hetzner power', dangerLevel: 'destructive',
      confirmation: { title: 'Change this Hetzner Server’s power?', body: 'This starts or stops the exact managed resource. Powered-off Servers remain billable.' },
      inputSchema: ROLE_SCHEMAS.powerInput, resultSchema: MachineProvisionerPowerResultV1Schema,
      async run(input, context) {
        if (input.intent !== 'start' && input.intent !== 'stop') return { kind: 'refused' as const, code: 'native_unsupported_intent' };
        try { const native = await runtime(context);
        const changed = await native.power(input.resource, input.intent);
        if (changed.kind === 'refused') return { kind: 'refused' as const, code: changed.code };
        const observed = await native.inspect(input.resource);
        return observed.kind === 'present' && observed.power === (input.intent === 'start' ? 'running' : 'stopped')
          ? { kind: 'confirmed' as const } : { kind: 'unknown' as const, code: 'native_power_pending' }; } catch { return { kind: 'unknown' as const, code: 'provider_unavailable' }; }
      },
    },
    destroy: { ...defaults, title: 'Delete exact Hetzner resource', dangerLevel: 'destructive',
      confirmation: { title: 'Delete this Hetzner Server?', body: 'This permanently deletes the exact managed Server and its recorded owned volumes and primary IPs.' },
      inputSchema: reconciliation.destroyInput, resultSchema: MachineProvisionerPowerResultV1Schema,
      async run(input, context) {
        if (!('resource' in input)) return { kind: 'refused' as const, code: 'native_cleanup_unavailable' };
        try { const result = await (await runtime(context)).destroy(input.resource);
        return result.kind === 'confirmed' ? { kind: 'confirmed' as const } : { kind: 'unknown' as const, code: 'native_cleanup_incomplete' }; } catch { return { kind: 'unknown' as const, code: 'provider_unavailable' }; } },
    },
  },
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
});
export const PLUGIN_MANIFEST = PLUGIN.manifest;
export const activateAccount = (api: Parameters<typeof PLUGIN.activateAccount>[0]) =>
  PLUGIN.activateAccount(api, { artifactId: 'account-runtime', exportName: 'activateAccount' });
