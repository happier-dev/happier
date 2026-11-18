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
import { createFreestyleNativeClient } from './machine/nativeClient.js';
import { createFreestylePreparationClient, FREESTYLE_PREPARATION_HOME, FreestylePreparationInputSchema,
  FreestylePreparedArtifactSchema, FreestylePreparationOperationSchema, PREPARATION_SCHEMAS } from './machine/preparation.js';
import { BILLING, CONTRIBUTION, FreestyleLaunchSchema, FreestyleOptionsSchema, FreestyleResourceSchema, FreestyleOperationSchema, ROLE_SCHEMAS, RECONCILIATION } from './machine/schemas.js';

export { ROLE_SCHEMAS, prepareStoredSchemas } from './machine/schemas.js';
const defaults = { scopes: ['global'], surfaces: ['cli', 'plugin', 'ui', 'agent'], hostAccess: ['native-api', ACCOUNT_PURPOSE],
  execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } },
} as const;
const confirmation = { title: 'Manage this Freestyle VM?', body: 'Freestyle charges for VM resources. Pausing retains memory and disk, subject to your Freestyle plan retention policy; deleting permanently removes it.' };
const retention = { supportedIntents: ['start', 'suspend', 'resume', 'delete'] } as const;
const runtime = (context: PluginAccountActionContext | PluginInvocationContext) => createFreestyleNativeClient(nativeFetch(context), context.signal, context.invokedAtMs);
const preparationRuntime = (context: PluginAccountActionContext | PluginInvocationContext) => createFreestylePreparationClient(nativeFetch(context), context.signal);

export const MACHINE_PROVISIONER = {
  title: 'Freestyle', icon: 'cloud', resourceKind: 'freestyle-vm', schemaVersion: 1,
  enrollmentRole: 'sandbox', kindTitle: 'VM', description: 'Run Happier in a retained Freestyle VM.',
  launchSchema: FreestyleLaunchSchema.jsonSchema, resourceSchema: FreestyleResourceSchema.jsonSchema,
  resourceIdPath: 'vmId', platforms: ['darwin', 'linux', 'win32'], prerequisites: [], browserReachable: false,
  billing: BILLING, retention,
  actions: { check: 'check', options: 'options', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', power: 'power', destroy: 'destroy' },
  bootstrapTransport: { kind: 'native', exec: 'exec', putFile: 'put-file' },
  reconciliation: { nativeOperationSchema: FreestyleOperationSchema.jsonSchema, action: 'reconcile' },
  preparation: { inputSchema: FreestylePreparationInputSchema.jsonSchema, artifactSchema: FreestylePreparedArtifactSchema.jsonSchema,
    nativeOperationSchema: FreestylePreparationOperationSchema.jsonSchema, artifactLaunchPath: 'launch',
    actions: { build: 'prepare-build', inspect: 'prepare-inspect', destroy: 'prepare-destroy' } },
} satisfies MachineProvisionerAuthorDefinitionV1;

export const PLUGIN = definePlugin({
  id: CONTRIBUTION.pluginId, version: '0.0.0', displayName: 'Freestyle Machines' satisfies PluginLocalizedStringV2,
  description: 'Create and manage Freestyle VMs as ordinary Happier Machines.',
  entrypoints: { daemon: './.happier-plugin-build/daemon.js' },
  hostAccess: { required: [
    { id: 'native-api', capability: 'network', reason: 'Manage the selected Freestyle VM.',
      scope: { targets: ORIGINS.map(origin => ({ kind: 'fixedOrigin' as const, origin })), methods: ['GET', 'POST', 'PUT', 'DELETE'] } },
    { id: ACCOUNT_PURPOSE, capability: 'connectedAccounts', reason: 'Use the selected Freestyle API key.',
      scope: { serviceRefs: [ACCOUNT_ID], operations: ['use'], materializationKinds: ['httpHeaders'] } },
  ], optional: [] },
  connectedAccountDescriptors: { [ACCOUNT_ID]: {
    declaration: { title: 'Freestyle account', ui: { category: 'cloud-machines' }, authentication: {
      account: { artifactId: 'connected-account-authentication', exportName: 'activate' }, defaultModeId: 'token', modes: [{
        id: 'token', title: 'API key', kind: 'manual', apiKey: true, outcomeReconciliation: 'none', credentialOrigin: 'authentication',
        browserReachability: 'unreachable',
        setup: { url: 'https://dash.freestyle.sh/', createKeyTitle: 'Open Freestyle dashboard',
          checklist: ['Sign in to [Freestyle] and select the team that will own your VMs.', 'Create an API key in the dashboard, or use freestyle tokens create after signing in with freestyle login.', 'Copy the API key and paste it here.'],
          shapeHint: 'Use a team API key, not an end-user identity token.' },
        credentialFieldKeys: { token: 'token' }, directExport: { contractVersion: CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 },
        fields: [{ id: 'token', title: 'API key', description: 'A Freestyle API key for VM create, exec, filesystem and deletion.', schema: { type: 'string', minLength: 1 }, secret: true }],
      }] } }, runtime: connectedAccountRuntime, accountRuntime: connectedAccountPortableRuntime,
  } },
  machineProvisioners: { [CONTRIBUTION.localId]: MACHINE_PROVISIONER },
  actions: {
    check: { ...defaults, title: 'Check Freestyle access', dangerLevel: 'safe', inputSchema: ROLE_SCHEMAS.checkInput, resultSchema: MachineProvisionerCheckResultV1Schema,
      async run(_input, context) { return runtime(context).check(); } },
    options: { ...defaults, title: 'Choose Freestyle snapshot', dangerLevel: 'safe', inputSchema: FreestyleOptionsSchema, resultSchema: MachineProvisionerOptionsResultV1Schema,
      inputHints: { fields: [{ path: 'snapshotId', title: 'Snapshot', widget: 'text', required: true, defaultValue: 'freestyle/ubuntu' }] },
      async run(input, context): Promise<MachineProvisionerOptionsResultV1> {
        const check = await runtime(context).check();
        if (!check.available) return { dimensions: { size: [], image: [], location: [], network: [], duration: [] }, code: 'provider_unavailable' };
        const snapshot = input.snapshotId ?? 'freestyle/ubuntu';
        return { base: { launch: { snapshotId: snapshot }, guestPlatform: 'linux' as const, retention },
          dimensions: { size: [], image: [{ id: snapshot, title: snapshot, guestPlatform: 'linux' as const, assignments: [], nativeFacts: {
            image: { id: snapshot, title: snapshot }, preparationGuest: { target: { os: 'linux', arch: 'x64' }, remoteHomeDir: FREESTYLE_PREPARATION_HOME },
          } }], location: [], network: [], duration: [] } };
      } },
    acquire: { ...defaults, title: 'Create Freestyle VM', confirmation, dangerLevel: 'writesRemote', inputSchema: ROLE_SCHEMAS.acquireInput, resultSchema: RECONCILIATION.result,
      async run(input, context) { return input.managedId ? runtime(context).acquire(input.launch, input.managedId) : { kind: 'rejected' as const, code: 'invalid_request' as const }; } },
    reconcile: { ...defaults, title: 'Recover Freestyle VM', dangerLevel: 'safe', inputSchema: RECONCILIATION.input, resultSchema: RECONCILIATION.result,
      async run(input, context) { return runtime(context).recover('nativeOperation' in input ? input.nativeOperation : { kind: 'acquire', name: 'happier-' + input.correlation.managedId, managedId: input.correlation.managedId }); } },
    bootstrap: { ...defaults, title: 'Prepare Freestyle guest', confirmation, dangerLevel: 'writesRemote', inputSchema: ROLE_SCHEMAS.bootstrapInput, resultSchema: MachineProvisionerBootstrapCarrierV1Schema,
      async run(input, context) { return runtime(context).bootstrap(input.resource); } },
    inspect: { ...defaults, title: 'Inspect Freestyle VM', dangerLevel: 'safe', inputSchema: ROLE_SCHEMAS.resourceInput, resultSchema: MachineProvisionerObservationV1Schema,
      async run(input, context) { return runtime(context).inspect(input.resource); } },
    power: { ...defaults, title: 'Change Freestyle power', confirmation, dangerLevel: 'writesRemote', inputSchema: ROLE_SCHEMAS.powerInput, resultSchema: MachineProvisionerPowerResultV1Schema,
      async run(input, context) { return runtime(context).power(input.resource, input.intent); } },
    destroy: { ...defaults, title: 'Delete Freestyle VM', confirmation, dangerLevel: 'destructive', inputSchema: RECONCILIATION.destroyInput, resultSchema: RECONCILIATION.destroyResult,
      async run(input, context) { return runtime(context).destroy(input); } },
    'prepare-build': { ...defaults, title: 'Build Freestyle prepared snapshot', dangerLevel: 'writesRemote',
      confirmation: { title: 'Build this Freestyle snapshot?', body: 'Provider charges apply for build compute, storage and transfer. Snapshot retention depends on your plan. See https://www.freestyle.sh/docs/vms/pricing-and-limits for current pricing.' },
      inputSchema: PREPARATION_SCHEMAS.buildInput, resultSchema: PREPARATION_SCHEMAS.buildResult,
      async run(input, context) { return preparationRuntime(context).build(input); } },
    'prepare-inspect': { ...defaults, title: 'Inspect Freestyle prepared snapshot', dangerLevel: 'safe',
      inputSchema: PREPARATION_SCHEMAS.inspectInput, resultSchema: PREPARATION_SCHEMAS.inspectResult,
      async run(input, context) { return preparationRuntime(context).inspect('nativeOperation' in input ? { nativeOperation: input.nativeOperation.value } : input); } },
    'prepare-destroy': { ...defaults, title: 'Delete Freestyle prepared snapshot', dangerLevel: 'destructive',
      confirmation: { title: 'Delete this Freestyle snapshot?', body: 'Permanently delete the owned prepared snapshot and its remaining build VM.' },
      inputSchema: PREPARATION_SCHEMAS.destroyInput, resultSchema: PREPARATION_SCHEMAS.destroyResult,
      async run(input, context) { return preparationRuntime(context).destroy({
        ...(input.artifact === undefined ? {} : { artifact: input.artifact.value }),
        ...(input.nativeOperation === undefined ? {} : { nativeOperation: input.nativeOperation.value }),
      }); } },
    exec: { ...defaults, title: 'Run in Freestyle guest', confirmation, dangerLevel: 'writesRemote', inputSchema: ROLE_SCHEMAS.execInput, resultSchema: MachineProvisionerNativeExecResultV1Schema,
      async run(input, context) { return runtime(context).exec(input); } },
    'put-file': { ...defaults, title: 'Write Freestyle guest file', confirmation, dangerLevel: 'writesRemote', inputSchema: ROLE_SCHEMAS.putFileInput, resultSchema: MachineProvisionerPutFileResultV1Schema,
      async run(input, context) { return runtime(context).putFile(input); } },
  },
});
export const PLUGIN_MANIFEST = PLUGIN.manifest;
export const activateAccount = (api: Parameters<typeof PLUGIN.activateAccount>[0]) =>
  PLUGIN.activateAccount(api, { artifactId: 'account-runtime', exportName: 'activateAccount' });
