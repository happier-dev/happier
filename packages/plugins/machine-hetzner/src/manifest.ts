import { definePlugin, PluginError, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import { machinePresentationLabel, machineCheckPresentation } from './ui/translations.js';
import { CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 } from '@happier-dev/plugin-sdk/connected-accounts';
import { projectMachineProvisionerActionFailure, observeMachineProvisionerNativeRead, defineMachineProvisionerSchemas, defineMachineProvisionerReconciliationSchemas, prepareMachineProvisionerStoredSchemas, buildMachineProvisionerPinnedSshBootstrap,
  MachineProvisionerBootstrapCarrierV1Schema, MachineProvisionerCheckResultV1Schema,
  MachineProvisionerObservationV1Schema, MachineProvisionerOptionsResultV1Schema, MachineProvisionerSnapshotResultV1Schema,
  MachineProvisionerPowerResultV1Schema, type MachineProvisionerAuthorDefinitionV1, type MachineProvisionerOptionsResultV1, type MachineProvisionerNativeCauseV1, type MachineProvisionerCloudHostKeyV1,
} from '@happier-dev/plugin-sdk/machine-provisioners';
import { resolveMachineProvisionerSshBootstrap } from '@happier-dev/plugin-sdk/machine-provisioners/ssh';
import { createHetznerProvider } from './machine/provider.js';
import { HETZNER_SNAPSHOT_FACTS } from './machine/nativeClient.js';
import { createHetznerPreparationClient, HETZNER_PREPARATION_HOME, HetznerPreparationInputSchema, HetznerPreparedArtifactSchema, HetznerPreparationOperationSchema, PREPARATION_SCHEMAS } from './machine/preparation.js';
import { projectHetznerOptions } from './machine/options.js';
import { HetznerLaunchV1Schema, HetznerResourceV1Schema, HetznerNativeOperationV1Schema, HetznerNativeError } from './machine/schemas.js';
import { ACCOUNT_ID, ACCOUNT_PURPOSE, connectedAccountRuntime, connectedAccountPortableRuntime, nativeFetch } from './account.js';

export const PLUGIN_ID = 'happier.machine.hetzner';
export const PROVISIONER_ID = 'hetzner';
const nativeSchemas = { launch: HetznerLaunchV1Schema, resource: HetznerResourceV1Schema, nativeOperation: HetznerNativeOperationV1Schema };
const reconciliation = defineMachineProvisionerReconciliationSchemas(nativeSchemas);
export const ROLE_SCHEMAS = { ...defineMachineProvisionerSchemas(nativeSchemas), acquireResult: reconciliation.result };
export const prepareStoredSchemas = () => prepareMachineProvisionerStoredSchemas(nativeSchemas);
function resourceRef<T>(value: T) { return { contributionRef: { pluginId: PLUGIN_ID, localId: PROVISIONER_ID }, schemaVersion: 1, value }; }
function pending(correlation: string, nativeCause?: MachineProvisionerNativeCauseV1) { return { kind: 'pending' as const, nativeOperationRef: resourceRef({ correlation }), ...(nativeCause ? { nativeCause } : {}) }; }
function failureCause(error: unknown) { return error instanceof HetznerNativeError && error.nativeCause ? { nativeCause: error.nativeCause } : {}; }
const billing = { location: 'cloud', stoppedBilling: 'billed' } as const;
const defaults = { scopes: ['global'], surfaces: ['ui', 'cli', 'plugin', 'agent'], hostAccess: ['native-api', ACCOUNT_PURPOSE],
  execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } },
} as const;
async function nativeOptions(context: PluginAccountActionContext | PluginInvocationContext) {
  const material = await context.services.connectedAccounts.materialize(ACCOUNT_PURPOSE,
    { kind: 'httpHeaders', origin: 'https://api.hetzner.cloud', headerNames: ['authorization'] }, { signal: context.signal });
  context.signal.throwIfAborted();
  if (material.kind !== 'httpHeaders') throw new PluginError({ code: 'credential_unavailable' });
  return { token: 'host-bound', fetch: nativeFetch(context, material.headers), signal: context.signal };
}
async function runtime(context: PluginAccountActionContext | PluginInvocationContext, guestHostKey?: MachineProvisionerCloudHostKeyV1) {
  return createHetznerProvider({ ...await nativeOptions(context), guestHostKey });
}
async function preparationRuntime(context: PluginAccountActionContext | PluginInvocationContext) {
  return createHetznerPreparationClient(await nativeOptions(context));
}

export const MACHINE_PROVISIONER = {
  title: 'Hetzner', icon: 'hard-drives', resourceKind: 'hetzner-server', schemaVersion: 1,
  enrollmentRole: 'server',
  kindTitle: machinePresentationLabel('kind'), description: machinePresentationLabel('description'),
  launchSchema: HetznerLaunchV1Schema.jsonSchema, resourceSchema: HetznerResourceV1Schema.jsonSchema, resourceIdPath: 'serverId',
  platforms: ['darwin', 'linux', 'win32'], prerequisites: [],
  // Required SSH bootstrap makes the whole browser create path unavailable.
  browserReachable: false,
  billing, retention: { supportedIntents: ['start', 'stop', 'delete'], guestLocalStop: 'poweroff' },
  actions: { check: 'check', options: 'options', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', power: 'power', destroy: 'destroy', snapshot: 'snapshot' },
  snapshot: HETZNER_SNAPSHOT_FACTS,
  preparation: { inputSchema: HetznerPreparationInputSchema.jsonSchema, artifactSchema: HetznerPreparedArtifactSchema.jsonSchema,
    nativeOperationSchema: HetznerPreparationOperationSchema.jsonSchema, artifactLaunchPath: 'launch',
    actions: { build: 'prepare-build', inspect: 'prepare-inspect', destroy: 'prepare-destroy' } },
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
  description: 'Manage exact reviewed Hetzner resources through captured cloud credentials.', entrypoints: { daemon: './.happier-plugin-build/daemon.js' },
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
    declaration: { title: 'Hetzner cloud account', description: 'Run coding sessions on Hetzner Cloud servers.', ui: { category: 'cloud-machines' }, authentication: {
      account: { artifactId: 'account-runtime', exportName: 'activateAccount' }, defaultModeId: 'token', modes: [{
      id: 'token', kind: 'manual', title: 'API token', outcomeReconciliation: 'none',
      setup: { url: 'https://console.hetzner.com/', createKeyTitle: 'Open Hetzner Console',
        checklist: ['Open your project in [Hetzner Console], then choose Security → API tokens.', 'Generate a token with Read & Write access, then paste it here.'] },
      credentialFieldKeys: { token: 'token' },
      credentialOrigin: 'authentication',
      directExport: { contractVersion: CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 },
      // The mode's setup guide says where the token comes from; the field repeats none of it.
      fields: [{ id: 'token', title: 'API token', schema: { type: 'string', minLength: 1 }, secret: true }],
    }] } }, runtime: connectedAccountRuntime, accountRuntime: connectedAccountPortableRuntime,
  } },
  machineProvisioners: { [PROVISIONER_ID]: MACHINE_PROVISIONER },
  actions: {
    'prepare-build': { ...defaults, title: 'Build Hetzner prepared image', dangerLevel: 'writesRemote',
      confirmation: { title: 'Build this Hetzner image?', body: 'This creates a temporary paid Server and a Snapshot billed by compressed storage size. The Snapshot remains until deleted. See https://docs.hetzner.com/cloud/billing/faq/.' },
      inputSchema: PREPARATION_SCHEMAS.buildInput, resultSchema: PREPARATION_SCHEMAS.buildResult,
      async run(input, context) { return (await preparationRuntime(context)).build(input, () => context.services.machineProvisioners.waitForNativeObservation()); } },
    'prepare-inspect': { ...defaults, title: 'Inspect Hetzner prepared image', dangerLevel: 'safe',
      inputSchema: PREPARATION_SCHEMAS.inspectInput, resultSchema: PREPARATION_SCHEMAS.inspectResult,
      async run(input, context) { return (await preparationRuntime(context)).inspect('nativeOperation' in input ? { nativeOperation: input.nativeOperation.value } : input); } },
    'prepare-destroy': { ...defaults, title: 'Delete Hetzner prepared image', dangerLevel: 'destructive',
      confirmation: { title: 'Delete this Hetzner prepared image?', body: 'This permanently deletes the owned Snapshot and temporary build Server.' },
      inputSchema: PREPARATION_SCHEMAS.destroyInput, resultSchema: PREPARATION_SCHEMAS.destroyResult,
      async run(input, context) { return (await preparationRuntime(context)).destroy({
        ...(input.artifact === undefined ? {} : { artifact: input.artifact.value }),
        ...(input.nativeOperation === undefined ? {} : { nativeOperation: input.nativeOperation.value }),
      }); } },
    snapshot: { ...defaults, scopes: ['machine'], execution: { target: 'daemon' },
      title: 'Snapshot Hetzner server disk', dangerLevel: 'externalSideEffect',
      confirmation: { title: 'Snapshot this Hetzner Server?', body: 'This creates a billable snapshot of the exact managed Server’s root disk. Attached volumes are not included.' },
      inputSchema: ROLE_SCHEMAS.snapshotInput, resultSchema: MachineProvisionerSnapshotResultV1Schema,
      async run(input, context) {
        return (await runtime(context)).snapshot(input.resource, input.label, () => context.services.machineProvisioners.waitForNativeObservation());
      },
    },
    reconcile: { ...defaults, title: 'Recover exact Hetzner resource', dangerLevel: 'safe',
      inputSchema: reconciliation.input, resultSchema: reconciliation.result,
      async run(input, context) {
        let correlation: string;
        if ('nativeOperation' in input) {
          if ('serverId' in input.nativeOperation) return { kind: 'bound' as const,
            resource: { ...resourceRef({ serverId: input.nativeOperation.serverId, owned: input.nativeOperation.owned }), origin: 'created' as const } };
          correlation = input.nativeOperation.correlation;
        } else correlation = input.correlation.managedId;
        try {
          const result = await (await runtime(context)).recover(correlation);
          if (result.kind === 'bound') return { kind: 'bound' as const, resource: { ...resourceRef(result.resource), origin: 'created' as const } };
          if (result.kind === 'rejected') return result;
          return pending(correlation, result.nativeCause);
        } catch (error) { return projectMachineProvisionerActionFailure(error, () => pending(correlation, error instanceof HetznerNativeError ? error.nativeCause : undefined)); }
      },
    },
    check: { ...defaults, title: 'Check Hetzner API access', dangerLevel: 'safe',
      inputSchema: ROLE_SCHEMAS.checkInput, resultSchema: MachineProvisionerCheckResultV1Schema,
      async run(_input, context) { try { return machineCheckPresentation(await (await runtime(context)).check()); } catch (error) { return projectMachineProvisionerActionFailure(error, () => ({ ...machineCheckPresentation({ available: false, code: 'provider_unavailable' }), ...failureCause(error) })); } },
    },
    options: { ...defaults, title: 'Discover Hetzner options', dangerLevel: 'safe',
      inputSchema: ROLE_SCHEMAS.checkInput, resultSchema: MachineProvisionerOptionsResultV1Schema,
      async run(_input, context): Promise<MachineProvisionerOptionsResultV1> {
        try { return projectHetznerOptions(await (await runtime(context)).options()); }
        catch (error) { return projectMachineProvisionerActionFailure(error, () => ({ dimensions: { size: [], image: [], location: [], network: [], duration: [] }, code: 'provider_unavailable', ...failureCause(error) })); }
      },
    },
    acquire: { ...defaults, title: 'Acquire Hetzner resource', dangerLevel: 'destructive',
      confirmation: { title: 'Create this Hetzner Server?', body: 'This creates the reviewed paid resource. Powered-off Servers remain billable.' },
      inputSchema: ROLE_SCHEMAS.acquireInput, resultSchema: ROLE_SCHEMAS.acquireResult,
      async run(input, context) {
        if (!input.managedId || !input.bootstrapPublicKey) return { kind: 'rejected' as const, code: 'invalid_request' as const };
        const managedId = input.managedId;
        const guestHostCredential = input.guestHostPublicKey === undefined ? undefined : {
          publicKey: input.guestHostPublicKey, lease: await context.services.machineProvisioners.materializeGuestHostCredential(),
        };
        try { const result = await (await runtime(context, guestHostCredential && {
          publicKey: guestHostCredential.publicKey, privateKey: new TextDecoder().decode(guestHostCredential.lease.bytes),
        })).acquire({ launch: input.launch, name: `happier-${input.managedId}`, correlation: input.managedId, bootstrapSshPublicKey: input.bootstrapPublicKey });
        if (result.kind === 'bound') return { kind: 'bound' as const, resource: { ...resourceRef(result.resource), origin: 'created' as const } };
        const nativeCause = 'nativeCause' in result ? result.nativeCause : undefined;
        return result.kind === 'rejected' ? { kind: 'rejected' as const, code: 'provider_unavailable' as const, ...(nativeCause ? { nativeCause } : {}) }
          : pending(input.managedId, nativeCause); }
        catch (error) { return projectMachineProvisionerActionFailure(error, () => pending(managedId, error instanceof HetznerNativeError ? error.nativeCause : undefined)); }
        finally { await guestHostCredential?.lease.dispose(); }
      },
    },
    bootstrap: { ...defaults, title: 'Resolve protected Hetzner bootstrap', dangerLevel: 'writesLocal',
      confirmation: { title: 'Prepare this Hetzner Server for Happier?', body: 'Allow Happier to resolve the protected SSH transport for the exact managed resource.' },
      inputSchema: ROLE_SCHEMAS.bootstrapInput, resultSchema: MachineProvisionerBootstrapCarrierV1Schema,
      async run(input, context: PluginAccountActionContext | PluginInvocationContext) {
        try {
          const connection = await (await runtime(context)).bootstrap(input.resource);
          if (input.guestHostPublicKey !== undefined && input.credentialRef !== undefined) return buildMachineProvisionerPinnedSshBootstrap({
            connection: { address: connection.address, user: connection.username, port: connection.port },
            credentialRef: input.credentialRef, guestHostPublicKey: input.guestHostPublicKey });
          return await resolveMachineProvisionerSshBootstrap({ ...('exec' in context.services ? { exec: context.services.exec } : {}), signal: context.signal,
            connection: { address: connection.address, user: connection.username, port: connection.port }, credentialRef: input.credentialRef });
        } catch (error) {
          if (error instanceof HetznerNativeError) throw new PluginError({ code: error.code,
            ...(error.nativeCause ? { details: { nativeCause: error.nativeCause } } : {}) });
          throw error;
        }
      },
    },
    inspect: { ...defaults, title: 'Inspect exact Hetzner resource', dangerLevel: 'safe',
      inputSchema: ROLE_SCHEMAS.resourceInput, resultSchema: MachineProvisionerObservationV1Schema,
      async run(input, context) { try { const result = await (await runtime(context)).inspect(input.resource);
        return observeMachineProvisionerNativeRead(context.invokedAtMs, { kind: result.kind,
          ...(result.kind === 'present' ? { power: result.power === 'transitioning' ? 'unknown' as const : result.power,
            storage: 'retained' as const, billing, ...(result.size ? { size: result.size } : {}) } : {}) });
        } catch (error) { return projectMachineProvisionerActionFailure(error, () => observeMachineProvisionerNativeRead(context.invokedAtMs, { kind: 'unknown',
          reason: error instanceof HetznerNativeError && error.code === 'native_cleanup_unconfirmed'
            ? 'native_cleanup_incomplete' : 'provider_unavailable', ...failureCause(error) })); } },
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
          ? { kind: 'confirmed' as const } : { kind: 'unknown' as const, code: 'native_power_pending' }; } catch (error) { return projectMachineProvisionerActionFailure(error, () => ({ kind: 'unknown' as const, code: 'provider_unavailable', ...failureCause(error) })); }
      },
    },
    destroy: { ...defaults, title: 'Delete exact Hetzner resource', dangerLevel: 'destructive',
      confirmation: { title: 'Delete this Hetzner Server?', body: 'This permanently deletes the exact managed Server and its recorded owned volumes and primary IPs.' },
      inputSchema: reconciliation.destroyInput, resultSchema: reconciliation.destroyResult,
      async run(input, context) {
        const resource = 'resource' in input ? input.resource : 'serverId' in input.nativeOperation ? input.nativeOperation : undefined;
        if (!resource) return { kind: 'refused' as const, code: 'native_cleanup_unavailable' };
        try {
          const continuing = !('resource' in input);
          const result = await (await runtime(context)).destroy(resource, continuing);
          if (result.kind === 'confirmed') return { kind: 'confirmed' as const };
          const code = 'code' in result ? result.code : undefined;
          const nativeCause = 'nativeCause' in result ? result.nativeCause : undefined;
          if (!code && !nativeCause) {
            return { kind: 'accepted' as const, nativeOperationRef: resourceRef(('nativeOperation' in result ? result.nativeOperation : undefined) ?? resource) };
          }
          return { kind: 'unknown' as const, code: code ?? 'native_cleanup_incomplete',
            ...(nativeCause ? { nativeCause } : {}) };
        } catch (error) { return projectMachineProvisionerActionFailure(error, () => ({ kind: 'unknown' as const, code: 'provider_unavailable', ...failureCause(error) })); } },
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
