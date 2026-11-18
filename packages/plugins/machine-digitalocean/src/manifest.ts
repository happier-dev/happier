import { definePlugin, PluginError, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import { machinePresentationLabel, machineCheckPresentation } from './ui/translations.js';
import { CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 } from '@happier-dev/plugin-sdk/connected-accounts';
import { observeMachineProvisionerNativeRead, buildMachineProvisionerPinnedSshBootstrap, defineMachineProvisionerSchemas, defineMachineProvisionerReconciliationSchemas, prepareMachineProvisionerStoredSchemas,
  MachineProvisionerBootstrapCarrierV1Schema, MachineProvisionerCheckResultV1Schema,
  MachineProvisionerObservationV1Schema, MachineProvisionerOptionsResultV1Schema,
  MachineProvisionerPowerResultV1Schema, MachineProvisionerSnapshotResultV1Schema, projectMachineProvisionerActionFailure, type MachineProvisionerAuthorDefinitionV1, type MachineProvisionerCloudHostKeyV1,
} from '@happier-dev/plugin-sdk/machine-provisioners';
import { resolveMachineProvisionerSshBootstrap } from '@happier-dev/plugin-sdk/machine-provisioners/ssh';
import { createDigitalOceanProvider } from './machine/provider.js';
import { DIGITALOCEAN_SNAPSHOT_FACTS } from './machine/nativeClient.js';
import { CONTRIBUTION, reference as resourceRef, dropletLaunchSchema, dropletResourceSchema, dropletNativeOperationSchema } from './machine/schemas.js';
import { createDigitalOceanPreparationClient, DigitalOceanPreparationInputSchema, DigitalOceanPreparedArtifactSchema, DigitalOceanPreparationOperationSchema, PREPARATION_SCHEMAS } from './machine/preparation.js';
import { ACCOUNT_ID, ACCOUNT_PURPOSE, connectedAccountRuntime, nativeFetch } from './account.js';

export const PLUGIN_ID = CONTRIBUTION.pluginId;
export const PROVISIONER_ID = CONTRIBUTION.localId;
const nativeSchemas = { launch: dropletLaunchSchema, resource: dropletResourceSchema, nativeOperation: dropletNativeOperationSchema };
const reconciliation = defineMachineProvisionerReconciliationSchemas(nativeSchemas);
export const ROLE_SCHEMAS = { ...defineMachineProvisionerSchemas(nativeSchemas), acquireResult: reconciliation.result };
export const prepareStoredSchemas = () => prepareMachineProvisionerStoredSchemas(nativeSchemas);
function pending(recoveryTag: string) { return { kind: 'pending' as const, nativeOperationRef: resourceRef({ recoveryTag }) }; }
const billing = { location: 'cloud', stoppedBilling: 'billed' } as const;
const defaults = { scopes: ['machine'], surfaces: ['cli', 'plugin'], hostAccess: ['native-api', ACCOUNT_PURPOSE] } as const;
const accountDefaults = { ...defaults, scopes: ['global'],
  execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } },
} as const;
async function accountOptions(context: PluginAccountActionContext | PluginInvocationContext, guestHostKey?: MachineProvisionerCloudHostKeyV1) {
  const material = await context.services.connectedAccounts.materialize(ACCOUNT_PURPOSE,
    { kind: 'httpHeaders', origin: 'https://api.digitalocean.com', headerNames: ['authorization'] }, { signal: context.signal });
  context.signal.throwIfAborted();
  if (material.kind !== 'httpHeaders') throw new PluginError({ code: 'credential_unavailable' });
  return { token: 'host-bound', fetch: nativeFetch(context, material.headers),
    signal: context.signal, now: () => new Date(context.invokedAtMs), ...(guestHostKey ? { guestHostKey } : {}) };
}
async function accountRuntime(context: PluginAccountActionContext | PluginInvocationContext, guestHostKey?: MachineProvisionerCloudHostKeyV1) {
  return createDigitalOceanProvider(await accountOptions(context, guestHostKey));
}
async function preparationRuntime(context: PluginAccountActionContext | PluginInvocationContext) {
  return createDigitalOceanPreparationClient({ ...await accountOptions(context),
    waitForObservation: () => context.services.machineProvisioners.waitForNativeObservation() });
}

export const MACHINE_PROVISIONER = {
  title: 'DigitalOcean', icon: 'hard-drives', resourceKind: 'digitalocean-droplet', schemaVersion: 1,
  enrollmentRole: 'server',
  browserReachable: false,
  kindTitle: machinePresentationLabel('kind'), description: machinePresentationLabel('description'),
  launchSchema: dropletLaunchSchema.jsonSchema, resourceSchema: dropletResourceSchema.jsonSchema, resourceIdPath: 'dropletId',
  platforms: ['darwin', 'linux', 'win32'], prerequisites: [],
  // Guest poweroff is the same retained Stop; host admin policy decides availability.
  billing, retention: { supportedIntents: ['start', 'stop', 'delete'], guestLocalStop: 'poweroff' },
  actions: { check: 'check', options: 'options', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', power: 'power', destroy: 'destroy', snapshot: 'snapshot' },
  snapshot: DIGITALOCEAN_SNAPSHOT_FACTS,
  reconciliation: { action: 'reconcile', nativeOperationSchema: dropletNativeOperationSchema.jsonSchema },
  preparation: { inputSchema: DigitalOceanPreparationInputSchema.jsonSchema, artifactSchema: DigitalOceanPreparedArtifactSchema.jsonSchema,
    nativeOperationSchema: DigitalOceanPreparationOperationSchema.jsonSchema, artifactLaunchPath: 'launch',
    actions: { build: 'prepare-build', inspect: 'prepare-inspect', destroy: 'prepare-destroy' } },
} satisfies MachineProvisionerAuthorDefinitionV1;

export const PLUGIN = definePlugin({
  id: PLUGIN_ID, version: '0.0.0', displayName: 'DigitalOcean Machines',
  // The provider's own mark beside its name in Machines: DigitalOcean's mark from Simple Icons 13.21.0 (CC0-1.0), brand blue #0080FF.
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
  description: 'Manage exact reviewed DigitalOcean resources through captured cloud credentials.', entrypoints: { daemon: './.happier-plugin-build/daemon.js' },
  hostAccess: { required: [
    { id: 'native-api', capability: 'network', reason: 'Operate the exact reviewed DigitalOcean resource.',
      scope: { targets: [{ kind: 'fixedOrigin', origin: 'https://api.digitalocean.com' }], methods: ['GET', 'POST', 'DELETE'] } },
    { id: ACCOUNT_PURPOSE, capability: 'connectedAccounts', reason: 'Use only the captured DigitalOcean account.',
      scope: { serviceRefs: [ACCOUNT_ID], operations: ['use'], materializationKinds: ['httpHeaders'] } },
  ], optional: [] },
  connectedAccountDescriptors: { [ACCOUNT_ID]: {
    declaration: { title: 'DigitalOcean cloud account', ui: { category: 'cloud-machines' }, authentication: { defaultModeId: 'token', modes: [{
      id: 'token', kind: 'manual', title: 'API token', outcomeReconciliation: 'none',
      setup: { url: 'https://cloud.digitalocean.com/account/api/tokens', createKeyTitle: 'Open DigitalOcean API tokens',
        checklist: ['In the DigitalOcean Control Panel, open [Account → API → Tokens] and choose Generate New Token.', 'Choose a name, expiration and permissions for managing Droplets, SSH keys, images, snapshots and tags, and reading sizes and regions.', 'Generate the personal access token, then copy and paste it here.'] },
      credentialFieldKeys: { token: 'token' },
      credentialOrigin: 'authentication',
      directExport: { contractVersion: CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 },
      fields: [{ id: 'token', title: 'API token', description: {
        key: 'machineDigitalOcean.account.tokenHint',
        fallback: 'Use a DigitalOcean personal access token. Create one in the control panel under Account → API → Tokens.',
      }, schema: { type: 'string', minLength: 1 }, secret: true }],
    }] } }, runtime: connectedAccountRuntime,
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
  machineProvisioners: { [PROVISIONER_ID]: MACHINE_PROVISIONER },
  actions: {
    'prepare-build': { ...accountDefaults, title: 'Build DigitalOcean prepared snapshot', dangerLevel: 'writesRemote',
      confirmation: { title: 'Build this DigitalOcean snapshot?', body: 'This creates a billable temporary Droplet and retains a billable snapshot. See https://www.digitalocean.com/pricing for pricing.' },
      inputSchema: PREPARATION_SCHEMAS.buildInput, resultSchema: PREPARATION_SCHEMAS.buildResult,
      async run(input, context) { return (await preparationRuntime(context)).build(input); } },
    'prepare-inspect': { ...accountDefaults, title: 'Inspect DigitalOcean prepared snapshot', dangerLevel: 'safe',
      inputSchema: PREPARATION_SCHEMAS.inspectInput, resultSchema: PREPARATION_SCHEMAS.inspectResult,
      async run(input, context) { return (await preparationRuntime(context)).inspect('nativeOperation' in input
        ? { nativeOperation: input.nativeOperation.value } : input); } },
    'prepare-destroy': { ...accountDefaults, title: 'Delete DigitalOcean prepared resources', dangerLevel: 'destructive',
      confirmation: { title: 'Delete these DigitalOcean prepared resources?', body: 'This permanently deletes the owned temporary Droplet and prepared snapshot.' },
      inputSchema: PREPARATION_SCHEMAS.destroyInput, resultSchema: PREPARATION_SCHEMAS.destroyResult,
      async run(input, context) { return (await preparationRuntime(context)).destroy({
        ...(input.artifact === undefined ? {} : { artifact: input.artifact.value }),
        ...(input.nativeOperation === undefined ? {} : { nativeOperation: input.nativeOperation.value }),
      }); } },
    snapshot: { ...defaults, surfaces: ['ui', 'cli', 'plugin', 'agent'], title: 'Snapshot exact DigitalOcean Droplet', dangerLevel: 'externalSideEffect',
      confirmation: { title: 'Snapshot this DigitalOcean Droplet?', body: 'This creates a billable snapshot of the exact managed Droplet’s root disk. Attached volumes are not included.' },
      inputSchema: ROLE_SCHEMAS.snapshotInput, resultSchema: MachineProvisionerSnapshotResultV1Schema,
      async run(input, context) {
        return (await accountRuntime(context)).snapshot(input.resource, input.label,
          () => context.services.machineProvisioners.waitForNativeObservation());
      },
    },
    reconcile: { ...accountDefaults, title: 'Recover exact DigitalOcean resource', dangerLevel: 'safe',
      inputSchema: reconciliation.input, resultSchema: reconciliation.result,
      async run(input, context) {
        let recoveryTag: string;
        if ('nativeOperation' in input) {
          if ('dropletId' in input.nativeOperation) return { kind: 'bound' as const, resource: { ...resourceRef(input.nativeOperation), origin: 'created' as const } };
          recoveryTag = input.nativeOperation.recoveryTag;
        } else recoveryTag = `happier-${input.correlation.managedId}`;
        try {
          const result = await (await accountRuntime(context)).recover(recoveryTag);
          if (result.kind === 'bound') return { kind: 'bound' as const, resource: { ...resourceRef(result.resource), origin: 'created' as const } };
          return { ...pending(recoveryTag), ...('nativeCause' in result && result.nativeCause ? { nativeCause: result.nativeCause } : {}) };
        } catch { /* An unavailable read neither proves absence nor authorizes another purchase. */ }
        return pending(recoveryTag);
      },
    },
    check: { ...accountDefaults, title: 'Check DigitalOcean API access', dangerLevel: 'safe',
      inputSchema: ROLE_SCHEMAS.checkInput, resultSchema: MachineProvisionerCheckResultV1Schema,
      async run(_input, context) { try { return machineCheckPresentation(await (await accountRuntime(context)).check()); } catch (error) { return projectMachineProvisionerActionFailure(error, () => machineCheckPresentation({ available: false, code: 'provider_unavailable' })); } },
    },
    options: { ...accountDefaults, title: 'Discover DigitalOcean options', dangerLevel: 'safe',
      inputSchema: ROLE_SCHEMAS.checkInput, resultSchema: MachineProvisionerOptionsResultV1Schema,
      async run(_input, context) { return (await accountRuntime(context)).options(); },
    },
    acquire: { ...accountDefaults, title: 'Acquire DigitalOcean resource', dangerLevel: 'destructive',
      confirmation: { title: 'Create this DigitalOcean Droplet?', body: 'This creates the reviewed paid resource. Stopped Droplets remain billable.' },
      inputSchema: ROLE_SCHEMAS.acquireInput, resultSchema: ROLE_SCHEMAS.acquireResult,
      async run(input, context) {
        if (!input.managedId || !input.bootstrapPublicKey) return { kind: 'rejected' as const, code: 'invalid_request' as const };
        // Acquire private custody before any paid request; a refusal is not an unknown allocation.
        const guestHostLease = input.guestHostPublicKey === undefined ? undefined
          : await context.services.machineProvisioners.materializeGuestHostCredential();
        try { const guestHostKey = guestHostLease && input.guestHostPublicKey !== undefined
          ? { publicKey: input.guestHostPublicKey, privateKey: new TextDecoder().decode(guestHostLease.bytes) } : undefined;
        const result = await (await accountRuntime(context, guestHostKey)).acquire({ launch: input.launch, name: `happier-${input.managedId}`, recoveryTag: `happier-${input.managedId}`, bootstrapSshPublicKey: input.bootstrapPublicKey });
        if (result.kind === 'bound') return { kind: 'bound' as const, resource: { ...resourceRef(result.resource), origin: 'created' as const } };
        if (result.kind === 'unknown') return { ...pending(`happier-${input.managedId}`), ...(result.nativeCause ? { nativeCause: result.nativeCause } : {}) };
        return { kind: 'rejected' as const, code: 'provider_unavailable' as const,
          ...('nativeCause' in result && result.nativeCause ? { nativeCause: result.nativeCause } : {}) }; }
        catch (error) { return projectMachineProvisionerActionFailure(error, () => pending(`happier-${input.managedId}`)); }
        finally { await guestHostLease?.dispose(); }
      },
    },
    bootstrap: { ...accountDefaults, title: 'Resolve protected DigitalOcean bootstrap', dangerLevel: 'writesLocal',
      confirmation: { title: 'Prepare this DigitalOcean Droplet for Happier?', body: 'Allow Happier to resolve the protected SSH transport for the exact managed resource.' },
      inputSchema: ROLE_SCHEMAS.bootstrapInput, resultSchema: MachineProvisionerBootstrapCarrierV1Schema,
      async run(input, context) { const observed = await (await accountRuntime(context)).bootstrap(input.resource);
        if (observed.kind === 'present' && observed.power === 'stopped') throw new PluginError({ code: 'native_resource_unavailable' });
        if (observed.kind === 'pending' || observed.kind === 'present' && !observed.ready) throw new PluginError({ code: 'native_not_ready' });
        if (observed.kind === 'failed') throw new PluginError({ code: 'native_action_failed' });
        if (observed.kind !== 'present' || !observed.ready || !observed.ssh) throw new PluginError({ code: 'provider_unavailable',
          ...(observed.kind === 'unavailable' && observed.nativeCause ? { details: { nativeCause: observed.nativeCause } } : {}) });
        if (input.guestHostPublicKey !== undefined && input.credentialRef) return buildMachineProvisionerPinnedSshBootstrap({
          connection: observed.ssh, credentialRef: input.credentialRef, guestHostPublicKey: input.guestHostPublicKey });
        return resolveMachineProvisionerSshBootstrap({ signal: context.signal,
          connection: observed.ssh, credentialRef: input.credentialRef }); },
    },
    inspect: { ...accountDefaults, title: 'Inspect exact DigitalOcean resource', dangerLevel: 'safe',
      inputSchema: ROLE_SCHEMAS.resourceInput, resultSchema: MachineProvisionerObservationV1Schema,
      async run(input, context) { try { const result = await (await accountRuntime(context)).inspect(input.resource);
        return observeMachineProvisionerNativeRead(context.invokedAtMs, { kind: result.kind === 'unavailable' ? 'unknown' : result.kind,
          ...(result.kind === 'present' ? { power: result.power, storage: 'retained' as const, billing, ...(result.size ? { size: result.size } : {}) } : {}),
          ...(result.kind === 'unavailable' ? { reason: result.reason === 'cleanup-unconfirmed' ? 'native_cleanup_incomplete' : result.reason,
            ...(result.nativeCause ? { nativeCause: result.nativeCause } : {}) } : {}) });
        } catch (error) { return projectMachineProvisionerActionFailure(error, () => observeMachineProvisionerNativeRead(context.invokedAtMs, { kind: 'unknown', reason: 'provider_unavailable' })); } },
    },
    power: { ...accountDefaults, title: 'Change DigitalOcean power', dangerLevel: 'destructive',
      confirmation: { title: 'Change this DigitalOcean Droplet’s power?', body: 'This starts or stops the exact managed resource. Stopped Droplets remain billable.' },
      inputSchema: ROLE_SCHEMAS.powerInput, resultSchema: MachineProvisionerPowerResultV1Schema,
      async run(input, context) {
        if (input.intent !== 'start' && input.intent !== 'stop') return { kind: 'refused' as const, code: 'native_unsupported_intent' };
        try { const native = await accountRuntime(context);
        const changed = await native.power(input.resource, input.intent);
        if (changed.kind === 'failed') return { kind: 'refused' as const, code: 'native_action_failed' };
        if (changed.kind === 'unavailable') return { kind: 'unknown' as const, code: changed.reason,
          ...('nativeCause' in changed && changed.nativeCause ? { nativeCause: changed.nativeCause } : {}) };
        const observed = await native.observeAction(input.resource, changed.actionId);
        return observed.kind === 'completed' ? { kind: 'confirmed' as const } : { kind: 'unknown' as const, code: 'native_power_pending',
          ...('nativeCause' in observed && observed.nativeCause ? { nativeCause: observed.nativeCause } : {}) }; } catch (error) { return projectMachineProvisionerActionFailure(error, () => ({ kind: 'unknown' as const, code: 'provider_unavailable' })); }
      },
    },
    destroy: { ...accountDefaults, title: 'Delete exact DigitalOcean resource', dangerLevel: 'destructive',
      confirmation: { title: 'Delete this DigitalOcean Droplet?', body: 'This permanently deletes the exact managed Droplet and its recorded owned volumes.' },
      inputSchema: reconciliation.destroyInput, resultSchema: reconciliation.destroyResult,
      async run(input, context) {
        const resource = 'resource' in input ? input.resource : 'dropletId' in input.nativeOperation ? input.nativeOperation : undefined;
        if (!resource) return { kind: 'refused' as const, code: 'native_cleanup_unavailable' };
        try {
          const continuing = !('resource' in input);
          const result = await (await accountRuntime(context)).destroy(resource, continuing);
          if (result.kind === 'deleted') return { kind: 'confirmed' as const };
          if (result.kind === 'incomplete' && !result.reason && !result.nativeCause) {
            return { kind: 'accepted' as const, nativeOperationRef: resourceRef(resource) };
          }
          return { kind: 'unknown' as const, code: 'reason' in result ? result.reason : 'native_cleanup_incomplete',
            ...('nativeCause' in result && result.nativeCause ? { nativeCause: result.nativeCause } : {}) };
        } catch (error) { return projectMachineProvisionerActionFailure(error, () => ({ kind: 'unknown' as const, code: 'provider_unavailable' })); } },
    },
  },
});
export const activateAccount = PLUGIN.activateAccount;
export const PLUGIN_MANIFEST = PLUGIN.manifest;
