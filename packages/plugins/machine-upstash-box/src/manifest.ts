import { definePlugin, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { PluginLocalizedStringV2 } from '@happier-dev/plugin-sdk';
import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import { CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 } from '@happier-dev/plugin-sdk/connected-accounts';
import {
  MachineProvisionerBootstrapCarrierV1Schema, MachineProvisionerCheckResultV1Schema,
  MachineProvisionerObservationV1Schema, MachineProvisionerOptionsResultV1Schema,
  MachineProvisionerPowerResultV1Schema, MachineProvisionerNativeExecResultV1Schema,
  MachineProvisionerPutFileResultV1Schema, type MachineProvisionerAuthorDefinitionV1, type MachineProvisionerOptionsResultV1,
} from '@happier-dev/plugin-sdk/machine-provisioners';
import { ACCOUNT_ID, ACCOUNT_PURPOSE, ORIGINS, connectedAccountRuntime, connectedAccountPortableRuntime, nativeFetch } from './account.js';
import { createUpstashBoxNativeClient } from './machine/nativeClient.js';
import { createUpstashBoxPreparationClient, UPSTASH_BOX_PREPARATION_HOME, UpstashBoxPreparationInputSchema, UpstashBoxPreparedArtifactSchema, UpstashBoxPreparationOperationSchema, PREPARATION_SCHEMAS } from './machine/preparation.js';
import { BILLING, CONTRIBUTION, UpstashBoxLaunchSchema, UpstashBoxOptionsSchema, UpstashBoxResourceSchema, UpstashBoxOperationSchema, ROLE_SCHEMAS, RECONCILIATION } from './machine/schemas.js';

export { ROLE_SCHEMAS, prepareStoredSchemas } from './machine/schemas.js';
const defaults = { scopes: ['global'], surfaces: ['cli', 'plugin', 'ui', 'agent'], hostAccess: ['native-api', ACCOUNT_PURPOSE],
  execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } },
} as const;
const confirmation = { title: 'Manage this Upstash Box sandbox?', body: 'Upstash Box bills active CPU and retained storage. Native idle auto-pause is based on the Upstash plan, not Happier activity. Stopping retains files; deleting permanently removes the live box.' };
const retention = { supportedIntents: ['start', 'stop', 'resume', 'delete'] } as const;
const runtime = (context: PluginAccountActionContext | PluginInvocationContext) => createUpstashBoxNativeClient(nativeFetch(context), context.signal, context.invokedAtMs);
const preparationRuntime = (context: PluginAccountActionContext | PluginInvocationContext) => createUpstashBoxPreparationClient(nativeFetch(context), context.signal);

export const MACHINE_PROVISIONER = {
  title: 'Upstash Box', icon: 'cloud', resourceKind: 'upstash-box-sandbox', schemaVersion: 1,
  enrollmentRole: 'sandbox', kindTitle: 'Sandbox', description: 'Run Happier in a retained Upstash Box Cloud sandbox.',
  launchSchema: UpstashBoxLaunchSchema.jsonSchema, resourceSchema: UpstashBoxResourceSchema.jsonSchema,
  resourceIdPath: 'boxId', platforms: ['darwin', 'linux', 'win32'], prerequisites: [], browserReachable: true,
  billing: BILLING, retention,
  actions: { check: 'check', options: 'options', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', power: 'power', destroy: 'destroy' },
  bootstrapTransport: { kind: 'native', exec: 'exec', putFile: 'put-file' },
  reconciliation: { nativeOperationSchema: UpstashBoxOperationSchema.jsonSchema, action: 'reconcile', cleanup: 'observe-cleanup' },
  preparation: { inputSchema: UpstashBoxPreparationInputSchema.jsonSchema, artifactSchema: UpstashBoxPreparedArtifactSchema.jsonSchema,
    nativeOperationSchema: UpstashBoxPreparationOperationSchema.jsonSchema, artifactLaunchPath: 'launch',
    actions: { build: 'prepare-build', inspect: 'prepare-inspect', destroy: 'prepare-destroy' } },
} satisfies MachineProvisionerAuthorDefinitionV1;

export const PLUGIN = definePlugin({
  id: CONTRIBUTION.pluginId, version: '0.0.0', displayName: 'Upstash Box Machines' satisfies PluginLocalizedStringV2,
  description: 'Create and manage Upstash Box sandboxes as ordinary Happier Machines.',
  entrypoints: { daemon: './.happier-plugin-build/daemon.js' },
  // The provider's own mark beside its name in Machines: Upstash's mark from Simple Icons 13.21.0 (CC0-1.0), monochrome so the host draws it in ink.
  brand: { iconResourceId: 'brand-icon', monochrome: true },
  resources: { 'brand-icon': { kind: 'asset' as const, path: 'assets/brand.png', contentType: 'image/png' } },
  hostAccess: { required: [
    { id: 'native-api', capability: 'network', reason: 'Manage the selected Upstash Box sandbox.',
      scope: { targets: ORIGINS.map(origin => ({ kind: 'fixedOrigin' as const, origin })), methods: ['GET', 'POST', 'PUT', 'DELETE'] } },
    { id: ACCOUNT_PURPOSE, capability: 'connectedAccounts', reason: 'Use the selected Upstash Box API key.',
      scope: { serviceRefs: [ACCOUNT_ID], operations: ['use'], materializationKinds: ['httpHeaders'] } },
  ], optional: [] },
  connectedAccountDescriptors: { [ACCOUNT_ID]: {
    declaration: { title: 'Upstash Box account', ui: { category: 'cloud-machines' }, authentication: {
      account: { artifactId: 'connected-account-authentication', exportName: 'activate' }, defaultModeId: 'token', modes: [{
        id: 'token', title: 'API key', kind: 'manual', apiKey: true, outcomeReconciliation: 'none', credentialOrigin: 'authentication',
        setup: { url: 'https://console.upstash.com/', createKeyTitle: 'Open Upstash Console',
          checklist: ['Open Upstash Box in the [Upstash Console] and create a Box API key.', 'Copy the Box API key and paste it here.'],
          shapeHint: 'Use a Box API key starting with box_, not a Redis REST token or Developer API key.' },
        credentialFieldKeys: { token: 'token' }, directExport: { contractVersion: CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 },
        fields: [{ id: 'token', title: 'API key', description: 'An Upstash Box API key.', schema: { type: 'string', minLength: 1 }, secret: true }],
      }] } }, runtime: connectedAccountRuntime, accountRuntime: connectedAccountPortableRuntime,
  } },
  machineProvisioners: { [CONTRIBUTION.localId]: MACHINE_PROVISIONER },
  actions: {
    check: { ...defaults, title: 'Check Upstash Box access', dangerLevel: 'safe', inputSchema: ROLE_SCHEMAS.checkInput, resultSchema: MachineProvisionerCheckResultV1Schema,
      async run(_input, context) { return runtime(context).check(); } },
    options: { ...defaults, title: 'Choose Upstash Box size', dangerLevel: 'safe', inputSchema: UpstashBoxOptionsSchema, resultSchema: MachineProvisionerOptionsResultV1Schema,
      async run(_input): Promise<MachineProvisionerOptionsResultV1> {
        return { base: { launch: { runtime: 'node', size: 'small' }, guestPlatform: 'linux', retention },
          dimensions: { size: ['small', 'medium', 'large'].map(size => ({ id: size, title: size, assignments: [{ path: 'size', value: size }] })),
            image: [{ id: 'node', title: 'Node.js', guestPlatform: 'linux', assignments: [], nativeFacts: {
              preparationGuest: { target: { os: 'linux', arch: 'x64' }, remoteHomeDir: UPSTASH_BOX_PREPARATION_HOME },
            } }], location: [], network: [], duration: [] } };
      } },
    acquire: { ...defaults, title: 'Create Upstash Box sandbox', confirmation, dangerLevel: 'writesRemote', inputSchema: ROLE_SCHEMAS.acquireInput, resultSchema: RECONCILIATION.result,
      async run(input, context) { return input.managedId ? runtime(context).acquire(input.launch, input.managedId) : { kind: 'rejected' as const, code: 'invalid_request' as const }; } },
    reconcile: { ...defaults, title: 'Recover Upstash Box sandbox', dangerLevel: 'safe', inputSchema: RECONCILIATION.input, resultSchema: RECONCILIATION.result,
      async run(input, context) { return runtime(context).recover('nativeOperation' in input ? input.nativeOperation : { kind: 'acquire', name: 'happier-' + input.correlation.managedId, managedId: input.correlation.managedId }); } },
    bootstrap: { ...defaults, title: 'Prepare Upstash Box guest', confirmation, dangerLevel: 'writesRemote', inputSchema: ROLE_SCHEMAS.bootstrapInput, resultSchema: MachineProvisionerBootstrapCarrierV1Schema,
      async run(input, context) { return runtime(context).bootstrap(input.resource); } },
    inspect: { ...defaults, title: 'Inspect Upstash Box sandbox', dangerLevel: 'safe', inputSchema: ROLE_SCHEMAS.resourceInput, resultSchema: MachineProvisionerObservationV1Schema,
      async run(input, context) { return runtime(context).inspect(input.resource); } },
    power: { ...defaults, title: 'Change Upstash Box power', confirmation, dangerLevel: 'writesRemote', inputSchema: ROLE_SCHEMAS.powerInput, resultSchema: MachineProvisionerPowerResultV1Schema,
      async run(input, context) { return runtime(context).power(input.resource, input.intent); } },
    destroy: { ...defaults, title: 'Delete Upstash Box sandbox', confirmation, dangerLevel: 'destructive', inputSchema: RECONCILIATION.destroyInput, resultSchema: RECONCILIATION.destroyResult,
      async run(input, context) { return runtime(context).destroy(input); } },
    'observe-cleanup': { ...defaults, title: 'Observe Upstash Box deletion', dangerLevel: 'safe', inputSchema: RECONCILIATION.cleanupInput, resultSchema: RECONCILIATION.cleanupResult,
      async run(input, context) { return runtime(context).cleanup(input.nativeOperation); } },
    'prepare-build': { ...defaults, title: 'Build Upstash Box prepared snapshot', dangerLevel: 'writesRemote',
      confirmation: { title: 'Build this Upstash Box snapshot?', body: 'Build CPU and retained storage charges apply. The paused build box is retained with the snapshot for recovery. Accounts with configured environment variables cannot prepare snapshots.' },
      inputSchema: PREPARATION_SCHEMAS.buildInput, resultSchema: PREPARATION_SCHEMAS.buildResult,
      async run(input, context) { return preparationRuntime(context).build(input, () => context.services.machineProvisioners.waitForNativeObservation()); } },
    'prepare-inspect': { ...defaults, title: 'Inspect Upstash Box prepared snapshot', dangerLevel: 'safe',
      inputSchema: PREPARATION_SCHEMAS.inspectInput, resultSchema: PREPARATION_SCHEMAS.inspectResult,
      async run(input, context) { return preparationRuntime(context).inspect('nativeOperation' in input ? { nativeOperation: input.nativeOperation.value } : input); } },
    'prepare-destroy': { ...defaults, title: 'Delete Upstash Box prepared snapshot', dangerLevel: 'destructive',
      confirmation: { title: 'Delete this Upstash Box snapshot?', body: 'Deleting removes the prepared snapshot and its owned build box permanently.' },
      inputSchema: PREPARATION_SCHEMAS.destroyInput, resultSchema: PREPARATION_SCHEMAS.destroyResult,
      async run(input, context) { return preparationRuntime(context).destroy({
        ...(input.artifact === undefined ? {} : { artifact: input.artifact.value }),
        ...(input.nativeOperation === undefined ? {} : { nativeOperation: input.nativeOperation.value }),
      }); } },
    exec: { ...defaults, title: 'Run in Upstash Box guest', confirmation, dangerLevel: 'writesRemote', inputSchema: ROLE_SCHEMAS.execInput, resultSchema: MachineProvisionerNativeExecResultV1Schema,
      async run(input, context) { return runtime(context).exec(input); } },
    'put-file': { ...defaults, title: 'Write Upstash Box guest file', confirmation, dangerLevel: 'writesRemote', inputSchema: ROLE_SCHEMAS.putFileInput, resultSchema: MachineProvisionerPutFileResultV1Schema,
      async run(input, context) { return runtime(context).putFile(input); } },
  },
});
export const PLUGIN_MANIFEST = PLUGIN.manifest;
export const activateAccount = (api: Parameters<typeof PLUGIN.activateAccount>[0]) =>
  PLUGIN.activateAccount(api, { artifactId: 'account-runtime', exportName: 'activateAccount' });
