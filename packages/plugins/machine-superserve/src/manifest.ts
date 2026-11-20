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
import { ACCOUNT_ID, ACCOUNT_PURPOSE, API_ORIGIN, GUEST_ORIGIN, connectedAccountRuntime, connectedAccountPortableRuntime } from './account.js';
import { nativeFetch } from './machine/credentials.js';
import { createSuperserveNativeClient } from './machine/nativeClient.js';
import { createSuperservePreparationClient, SUPERSERVE_PREPARATION_HOME, SuperservePreparationInputSchema, SuperservePreparedArtifactSchema, SuperservePreparationOperationSchema, PREPARATION_SCHEMAS } from './machine/preparation.js';
import { BILLING, CONTRIBUTION, SuperserveLaunchSchema, SuperserveOptionsSchema, SuperserveResourceSchema, SuperserveOperationSchema, ROLE_SCHEMAS, RECONCILIATION } from './machine/schemas.js';

export { ROLE_SCHEMAS, prepareStoredSchemas } from './machine/schemas.js';
const defaults = { scopes: ['global'], surfaces: ['cli', 'plugin', 'ui', 'agent'], hostAccess: ['native-api', ACCOUNT_PURPOSE],
  execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } },
} as const;
const confirmation = { title: 'Manage this Superserve sandbox?', body: 'Superserve charges for sandbox resources. Pausing retains memory and disk; deleting permanently removes both.' };
const retention = { supportedIntents: ['suspend', 'resume', 'delete'] } as const;
const runtime = (context: PluginAccountActionContext | PluginInvocationContext) => createSuperserveNativeClient(nativeFetch(context), context.signal, context.invokedAtMs);
const preparationRuntime = (context: PluginAccountActionContext | PluginInvocationContext) => createSuperservePreparationClient(nativeFetch(context), context.signal);

export const MACHINE_PROVISIONER = {
  title: 'Superserve', icon: 'cloud', resourceKind: 'superserve-sandbox', schemaVersion: 1,
  enrollmentRole: 'sandbox', kindTitle: 'Sandbox', description: 'Run Happier in a retained Superserve Cloud sandbox.',
  launchSchema: SuperserveLaunchSchema.jsonSchema, resourceSchema: SuperserveResourceSchema.jsonSchema,
  resourceIdPath: 'sandboxId', platforms: ['darwin', 'linux', 'win32'], prerequisites: [], browserReachable: false,
  billing: BILLING, retention,
  actions: { check: 'check', options: 'options', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', power: 'power', destroy: 'destroy' },
  bootstrapTransport: { kind: 'native', exec: 'exec', putFile: 'put-file' },
  reconciliation: { nativeOperationSchema: SuperserveOperationSchema.jsonSchema, action: 'reconcile' },
  preparation: { inputSchema: SuperservePreparationInputSchema.jsonSchema, artifactSchema: SuperservePreparedArtifactSchema.jsonSchema,
    nativeOperationSchema: SuperservePreparationOperationSchema.jsonSchema, artifactLaunchPath: 'launch',
    actions: { build: 'prepare-build', inspect: 'prepare-inspect', destroy: 'prepare-destroy' } },
} satisfies MachineProvisionerAuthorDefinitionV1;

export const PLUGIN = definePlugin({
  id: CONTRIBUTION.pluginId, version: '0.0.0', displayName: 'Superserve Machines' satisfies PluginLocalizedStringV2,
  description: 'Create and manage Superserve sandboxes as ordinary Happier Machines.',
  entrypoints: { daemon: './.happier-plugin-build/daemon.js' },
  hostAccess: { required: [
    { id: 'native-api', capability: 'network', reason: 'Manage the selected Superserve sandbox.',
      scope: { targets: [API_ORIGIN, GUEST_ORIGIN].map(origin => ({ kind: 'fixedOrigin' as const, origin })), methods: ['GET', 'POST', 'DELETE'] } },
    { id: ACCOUNT_PURPOSE, capability: 'connectedAccounts', reason: 'Use the selected Superserve API key.',
      scope: { serviceRefs: [ACCOUNT_ID], operations: ['use'], materializationKinds: ['httpHeaders'] } },
  ], optional: [] },
  connectedAccountDescriptors: { [ACCOUNT_ID]: {
    declaration: { title: 'Superserve account', ui: { category: 'cloud-machines' }, authentication: {
      account: { artifactId: 'connected-account-authentication', exportName: 'activate' }, defaultModeId: 'token', modes: [{
        id: 'token', title: 'API key', kind: 'manual', apiKey: true, outcomeReconciliation: 'none', credentialOrigin: 'authentication',
        browserReachability: 'unreachable',
        setup: { url: 'https://console.superserve.ai/', createKeyTitle: 'Open Superserve console',
          checklist: ['Select your team in the [Superserve console], then open Settings → API keys.', 'Choose Create key, then copy the new key and paste it here.'],
          shapeHint: 'Superserve API keys start with ss_live_ and belong to one team.' },
        credentialFieldKeys: { token: 'token' }, directExport: { contractVersion: CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 },
        fields: [{ id: 'token', title: 'API key', description: 'An API key from the Superserve dashboard.', schema: { type: 'string', minLength: 1 }, secret: true }],
      }] } }, runtime: connectedAccountRuntime, accountRuntime: connectedAccountPortableRuntime,
  } },
  machineProvisioners: { [CONTRIBUTION.localId]: MACHINE_PROVISIONER },
  actions: {
    check: { ...defaults, title: 'Check Superserve access', dangerLevel: 'safe', inputSchema: ROLE_SCHEMAS.checkInput, resultSchema: MachineProvisionerCheckResultV1Schema,
      async run(_input, context) { return runtime(context).check(); } },
    options: { ...defaults, title: 'Choose Superserve template', dangerLevel: 'safe', inputSchema: SuperserveOptionsSchema, resultSchema: MachineProvisionerOptionsResultV1Schema,
      inputHints: { fields: [{ path: 'template', title: 'Template', widget: 'text', required: true, defaultValue: 'superserve/base' }] },
      async run(input): Promise<MachineProvisionerOptionsResultV1> {
        const template = input.template ?? 'superserve/base';
        return { base: { launch: { template }, guestPlatform: 'linux' as const, retention },
          dimensions: { size: [], image: [{ id: template, title: template, guestPlatform: 'linux' as const, assignments: [], nativeFacts: {
            preparationGuest: { target: { os: 'linux', arch: 'x64' }, remoteHomeDir: SUPERSERVE_PREPARATION_HOME },
            image: { id: template, title: template } } }], location: [], network: [], duration: [] } };
      } },
    acquire: { ...defaults, title: 'Create Superserve sandbox', confirmation, dangerLevel: 'writesRemote', inputSchema: ROLE_SCHEMAS.acquireInput, resultSchema: RECONCILIATION.result,
      async run(input, context) { return input.managedId ? runtime(context).acquire(input.launch, input.managedId) : { kind: 'rejected' as const, code: 'invalid_request' as const }; } },
    reconcile: { ...defaults, title: 'Recover Superserve sandbox', dangerLevel: 'safe', inputSchema: RECONCILIATION.input, resultSchema: RECONCILIATION.result,
      async run(input, context) { return runtime(context).recover('nativeOperation' in input ? input.nativeOperation : { kind: 'acquire', name: 'happier-' + input.correlation.managedId, managedId: input.correlation.managedId }); } },
    bootstrap: { ...defaults, title: 'Prepare Superserve guest', confirmation, dangerLevel: 'writesRemote', inputSchema: ROLE_SCHEMAS.bootstrapInput, resultSchema: MachineProvisionerBootstrapCarrierV1Schema,
      async run(input, context) { return runtime(context).bootstrap(input.resource); } },
    inspect: { ...defaults, title: 'Inspect Superserve sandbox', dangerLevel: 'safe', inputSchema: ROLE_SCHEMAS.resourceInput, resultSchema: MachineProvisionerObservationV1Schema,
      async run(input, context) { return runtime(context).inspect(input.resource); } },
    power: { ...defaults, title: 'Change Superserve power', confirmation, dangerLevel: 'writesRemote', inputSchema: ROLE_SCHEMAS.powerInput, resultSchema: MachineProvisionerPowerResultV1Schema,
      async run(input, context) { return runtime(context).power(input.resource, input.intent); } },
    destroy: { ...defaults, title: 'Delete Superserve sandbox', confirmation, dangerLevel: 'destructive', inputSchema: RECONCILIATION.destroyInput, resultSchema: RECONCILIATION.destroyResult,
      async run(input, context) { return runtime(context).destroy(input); } },
    'prepare-build': { ...defaults, title: 'Build Superserve prepared snapshot', dangerLevel: 'writesRemote',
      confirmation: { title: 'Prepare this Superserve sandbox?', body: 'Provider compute and retained sandbox/snapshot storage charges apply. See https://www.superserve.ai/pricing/ for current pricing.' },
      inputSchema: PREPARATION_SCHEMAS.buildInput, resultSchema: PREPARATION_SCHEMAS.buildResult,
      async run(input, context) { return preparationRuntime(context).build(input); } },
    'prepare-inspect': { ...defaults, title: 'Inspect Superserve prepared snapshot', dangerLevel: 'safe',
      inputSchema: PREPARATION_SCHEMAS.inspectInput, resultSchema: PREPARATION_SCHEMAS.inspectResult,
      async run(input, context) { return preparationRuntime(context).inspect('nativeOperation' in input
        ? { nativeOperation: input.nativeOperation.value } : input); } },
    'prepare-destroy': { ...defaults, title: 'Delete Superserve prepared snapshot', dangerLevel: 'destructive',
      confirmation: { title: 'Delete this Superserve snapshot?', body: 'This permanently removes the owned prepared snapshot and its temporary build sandbox.' },
      inputSchema: PREPARATION_SCHEMAS.destroyInput, resultSchema: PREPARATION_SCHEMAS.destroyResult,
      async run(input, context) { return preparationRuntime(context).destroy({
        ...(input.artifact === undefined ? {} : { artifact: input.artifact.value }),
        ...(input.nativeOperation === undefined ? {} : { nativeOperation: input.nativeOperation.value }),
      }); } },
    exec: { ...defaults, title: 'Run in Superserve guest', confirmation, dangerLevel: 'writesRemote', inputSchema: ROLE_SCHEMAS.execInput, resultSchema: MachineProvisionerNativeExecResultV1Schema,
      async run(input, context) { return runtime(context).exec(input); } },
    'put-file': { ...defaults, title: 'Write Superserve guest file', confirmation, dangerLevel: 'writesRemote', inputSchema: ROLE_SCHEMAS.putFileInput, resultSchema: MachineProvisionerPutFileResultV1Schema,
      async run(input, context) { return runtime(context).putFile(input); } },
  },
});
export const PLUGIN_MANIFEST = PLUGIN.manifest;
export const activateAccount = (api: Parameters<typeof PLUGIN.activateAccount>[0]) =>
  PLUGIN.activateAccount(api, { artifactId: 'account-runtime', exportName: 'activateAccount' });
