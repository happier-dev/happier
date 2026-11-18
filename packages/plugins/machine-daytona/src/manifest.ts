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
import { createDaytonaNativeClient } from './machine/nativeClient.js';
import { createDaytonaPreparationClient, DAYTONA_PREPARATION_HOME, DaytonaPreparationInputSchema, DaytonaPreparedArtifactSchema, DaytonaPreparationOperationSchema, PREPARATION_SCHEMAS } from './machine/preparation.js';
import { BILLING, CONTRIBUTION, DaytonaLaunchSchema, DaytonaOptionsSchema, DaytonaResourceSchema, DaytonaOperationSchema, ROLE_SCHEMAS, RECONCILIATION } from './machine/schemas.js';

export { ROLE_SCHEMAS, prepareStoredSchemas } from './machine/schemas.js';
const defaults = { scopes: ['global'], surfaces: ['cli', 'plugin', 'ui', 'agent'], hostAccess: ['native-api', ACCOUNT_PURPOSE],
  execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } },
} as const;
const confirmation = { title: 'Manage this Daytona sandbox?', body: 'Daytona charges for sandbox resources. Stopping retains its filesystem; deleting permanently removes it.' };
const retention = { supportedIntents: ['start', 'stop', 'resume', 'delete'] } as const;
const runtime = (context: PluginAccountActionContext | PluginInvocationContext) => createDaytonaNativeClient(nativeFetch(context), context.signal, context.invokedAtMs);
const preparationRuntime = (context: PluginAccountActionContext | PluginInvocationContext) => createDaytonaPreparationClient(nativeFetch(context), context.signal);

export const MACHINE_PROVISIONER = {
  title: 'Daytona', icon: 'cloud', resourceKind: 'daytona-sandbox', schemaVersion: 1,
  enrollmentRole: 'sandbox', kindTitle: 'Sandbox', description: 'Run Happier in a retained Daytona Cloud sandbox.',
  launchSchema: DaytonaLaunchSchema.jsonSchema, resourceSchema: DaytonaResourceSchema.jsonSchema,
  resourceIdPath: 'sandboxId', platforms: ['darwin', 'linux', 'win32'], prerequisites: [], browserReachable: true,
  billing: BILLING, retention,
  actions: { check: 'check', options: 'options', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', power: 'power', destroy: 'destroy' },
  bootstrapTransport: { kind: 'native', exec: 'exec', putFile: 'put-file' },
  reconciliation: { nativeOperationSchema: DaytonaOperationSchema.jsonSchema, action: 'reconcile', cleanup: 'observe-cleanup' },
  preparation: { inputSchema: DaytonaPreparationInputSchema.jsonSchema, artifactSchema: DaytonaPreparedArtifactSchema.jsonSchema,
    nativeOperationSchema: DaytonaPreparationOperationSchema.jsonSchema, artifactLaunchPath: 'launch',
    actions: { build: 'prepare-build', inspect: 'prepare-inspect', destroy: 'prepare-destroy' } },
} satisfies MachineProvisionerAuthorDefinitionV1;

export const PLUGIN = definePlugin({
  id: CONTRIBUTION.pluginId, version: '0.0.0', displayName: 'Daytona Machines' satisfies PluginLocalizedStringV2,
  description: 'Create and manage Daytona sandboxes as ordinary Happier Machines.',
  entrypoints: { daemon: './.happier-plugin-build/daemon.js' },
  hostAccess: { required: [
    { id: 'native-api', capability: 'network', reason: 'Manage the selected Daytona sandbox.',
      scope: { targets: ORIGINS.map(origin => ({ kind: 'fixedOrigin' as const, origin })), methods: ['GET', 'POST', 'DELETE'] } },
    { id: ACCOUNT_PURPOSE, capability: 'connectedAccounts', reason: 'Use the selected Daytona API key.',
      scope: { serviceRefs: [ACCOUNT_ID], operations: ['use'], materializationKinds: ['httpHeaders'] } },
  ], optional: [] },
  connectedAccountDescriptors: { [ACCOUNT_ID]: {
    declaration: { title: 'Daytona account', ui: { category: 'cloud-machines' }, authentication: {
      account: { artifactId: 'connected-account-authentication', exportName: 'activate' }, defaultModeId: 'token', modes: [{
        id: 'token', title: 'API key', kind: 'manual', apiKey: true, outcomeReconciliation: 'none', credentialOrigin: 'authentication',
        setup: { url: 'https://app.daytona.io/dashboard/keys', createKeyTitle: 'Open Daytona API keys',
          checklist: ['Select your organization in the [Daytona dashboard] and choose Create Key.', 'Name the key and enable sandbox write and delete permissions, then create it.', 'Copy the new API key and paste it here.'] },
        credentialFieldKeys: { token: 'token' }, directExport: { contractVersion: CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 },
        fields: [{ id: 'token', title: 'API key', description: 'A Daytona organization key with sandbox write and delete permissions.', schema: { type: 'string', minLength: 1 }, secret: true }],
      }] } }, runtime: connectedAccountRuntime, accountRuntime: connectedAccountPortableRuntime,
  } },
  machineProvisioners: { [CONTRIBUTION.localId]: MACHINE_PROVISIONER },
  actions: {
    check: { ...defaults, title: 'Check Daytona access', dangerLevel: 'safe', inputSchema: ROLE_SCHEMAS.checkInput, resultSchema: MachineProvisionerCheckResultV1Schema,
      async run(_input, context) { return runtime(context).check(); } },
    options: { ...defaults, title: 'Choose Daytona snapshot', dangerLevel: 'safe', inputSchema: DaytonaOptionsSchema, resultSchema: MachineProvisionerOptionsResultV1Schema,
      inputHints: { fields: [{ path: 'snapshot', title: 'Snapshot', widget: 'text', required: true, defaultValue: 'daytona-small' }] },
      async run(input): Promise<MachineProvisionerOptionsResultV1> {
        const snapshot = input.snapshot ?? 'daytona-small';
        // The clean-build branch requests Linux/AMD64; this is no assertion that
        // the selected base is ready/supported. Build alone classifies that base.
        return { base: { launch: { snapshot }, guestPlatform: 'linux' as const, retention },
          dimensions: { size: [], image: [{ id: snapshot, title: snapshot, guestPlatform: 'linux' as const, assignments: [], nativeFacts: {
            preparationGuest: { target: { os: 'linux', arch: 'x64' }, remoteHomeDir: DAYTONA_PREPARATION_HOME },
            image: { id: snapshot, title: snapshot },
          } }], location: [], network: [], duration: [] } };
      } },
    acquire: { ...defaults, title: 'Create Daytona sandbox', confirmation, dangerLevel: 'writesRemote', inputSchema: ROLE_SCHEMAS.acquireInput, resultSchema: RECONCILIATION.result,
      async run(input, context) { return input.managedId ? runtime(context).acquire(input.launch, input.managedId) : { kind: 'rejected' as const, code: 'invalid_request' as const }; } },
    reconcile: { ...defaults, title: 'Recover Daytona sandbox', dangerLevel: 'safe', inputSchema: RECONCILIATION.input, resultSchema: RECONCILIATION.result,
      async run(input, context) { return runtime(context).recover('nativeOperation' in input ? input.nativeOperation : { kind: 'acquire', name: 'happier-' + input.correlation.managedId, managedId: input.correlation.managedId }); } },
    bootstrap: { ...defaults, title: 'Prepare Daytona guest', confirmation, dangerLevel: 'writesRemote', inputSchema: ROLE_SCHEMAS.bootstrapInput, resultSchema: MachineProvisionerBootstrapCarrierV1Schema,
      async run(input, context) { return runtime(context).bootstrap(input.resource); } },
    inspect: { ...defaults, title: 'Inspect Daytona sandbox', dangerLevel: 'safe', inputSchema: ROLE_SCHEMAS.resourceInput, resultSchema: MachineProvisionerObservationV1Schema,
      async run(input, context) { return runtime(context).inspect(input.resource); } },
    power: { ...defaults, title: 'Change Daytona power', confirmation, dangerLevel: 'writesRemote', inputSchema: ROLE_SCHEMAS.powerInput, resultSchema: MachineProvisionerPowerResultV1Schema,
      async run(input, context) { return runtime(context).power(input.resource, input.intent); } },
    destroy: { ...defaults, title: 'Delete Daytona sandbox', confirmation, dangerLevel: 'destructive', inputSchema: RECONCILIATION.destroyInput, resultSchema: RECONCILIATION.destroyResult,
      async run(input, context) { return runtime(context).destroy(input); } },
    'observe-cleanup': { ...defaults, title: 'Observe Daytona deletion', dangerLevel: 'safe', inputSchema: RECONCILIATION.cleanupInput, resultSchema: RECONCILIATION.cleanupResult,
      async run(input, context) { return runtime(context).cleanup(input.nativeOperation); } },
    'prepare-build': { ...defaults, title: 'Build Daytona prepared snapshot', dangerLevel: 'writesRemote',
      confirmation: { title: 'Build this Daytona snapshot?', body: 'Provider charges apply for build, storage, and runtime. See https://www.daytona.io/pricing for current pricing.' },
      inputSchema: PREPARATION_SCHEMAS.buildInput, resultSchema: PREPARATION_SCHEMAS.buildResult,
      async run(input, context) { return preparationRuntime(context).build(input); } },
    'prepare-inspect': { ...defaults, title: 'Inspect Daytona prepared snapshot', dangerLevel: 'safe',
      inputSchema: PREPARATION_SCHEMAS.inspectInput, resultSchema: PREPARATION_SCHEMAS.inspectResult,
      async run(input, context) { return preparationRuntime(context).inspect('nativeOperation' in input
        ? { nativeOperation: input.nativeOperation.value } : input); } },
    'prepare-destroy': { ...defaults, title: 'Delete Daytona prepared snapshot', dangerLevel: 'destructive',
      confirmation: { title: 'Delete this Daytona snapshot?', body: 'Deleting the snapshot permanently removes this prepared image.' },
      inputSchema: PREPARATION_SCHEMAS.destroyInput, resultSchema: PREPARATION_SCHEMAS.destroyResult,
      async run(input, context) { return preparationRuntime(context).destroy({
        ...(input.artifact === undefined ? {} : { artifact: input.artifact.value }),
        ...(input.nativeOperation === undefined ? {} : { nativeOperation: input.nativeOperation.value }),
      }); } },
    exec: { ...defaults, title: 'Run in Daytona guest', confirmation, dangerLevel: 'writesRemote', inputSchema: ROLE_SCHEMAS.execInput, resultSchema: MachineProvisionerNativeExecResultV1Schema,
      async run(input, context) { return runtime(context).exec(input); } },
    'put-file': { ...defaults, title: 'Write Daytona guest file', confirmation, dangerLevel: 'writesRemote', inputSchema: ROLE_SCHEMAS.putFileInput, resultSchema: MachineProvisionerPutFileResultV1Schema,
      async run(input, context) { return runtime(context).putFile(input); } },
  },
});
export const PLUGIN_MANIFEST = PLUGIN.manifest;
export const activateAccount = (api: Parameters<typeof PLUGIN.activateAccount>[0]) =>
  PLUGIN.activateAccount(api, { artifactId: 'account-runtime', exportName: 'activateAccount' });
