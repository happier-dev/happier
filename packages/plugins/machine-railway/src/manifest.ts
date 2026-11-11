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
import { createRailwayNativeClient } from './machine/nativeClient.js';
import { BILLING, CONTRIBUTION, RailwayLaunchSchema, RailwayOptionsSchema, RailwayResourceSchema, RailwayOperationSchema, ROLE_SCHEMAS, RECONCILIATION } from './machine/schemas.js';

export { ROLE_SCHEMAS, prepareStoredSchemas } from './machine/schemas.js';
const defaults = { scopes: ['global'], surfaces: ['cli', 'plugin', 'ui'], hostAccess: ['native-api', ACCOUNT_PURPOSE],
  execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } },
} as const;
const confirmation = { title: 'Manage this Railway sandbox?', body: 'Railway charges for sandbox resources. This sandbox stays running until you delete it; deleting permanently removes its filesystem.' };
const retention = { supportedIntents: ['delete'] } as const;
const runtime = (context: PluginAccountActionContext | PluginInvocationContext) => createRailwayNativeClient(nativeFetch(context), context.signal, context.invokedAtMs);

export const MACHINE_PROVISIONER = {
  title: 'Railway', icon: 'cloud', resourceKind: 'railway-sandbox', schemaVersion: 1,
  enrollmentRole: 'sandbox', kindTitle: 'Sandbox', description: 'Run Happier in a Railway sandbox until you delete it.',
  launchSchema: RailwayLaunchSchema.jsonSchema, resourceSchema: RailwayResourceSchema.jsonSchema,
  resourceIdPath: 'sandboxId', platforms: ['darwin', 'linux', 'win32'], prerequisites: [], browserReachable: false,
  billing: BILLING, retention,
  actions: { check: 'check', options: 'options', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', power: 'power', destroy: 'destroy' },
  bootstrapTransport: { kind: 'native', exec: 'exec', putFile: 'put-file' },
  reconciliation: { nativeOperationSchema: RailwayOperationSchema.jsonSchema, action: 'reconcile', cleanup: 'observe-cleanup' },
} satisfies MachineProvisionerAuthorDefinitionV1;

export const PLUGIN = definePlugin({
  id: CONTRIBUTION.pluginId, version: '0.0.0', displayName: 'Railway Machines' satisfies PluginLocalizedStringV2,
  description: 'Create and manage Railway sandboxes as ordinary Happier Machines.',
  entrypoints: { daemon: './.happier-plugin/daemon.js' },
  hostAccess: { required: [
    { id: 'native-api', capability: 'network', reason: 'Manage the selected Railway sandbox.',
      scope: { targets: ORIGINS.map(origin => ({ kind: 'fixedOrigin' as const, origin })), methods: ['POST'] } },
    { id: ACCOUNT_PURPOSE, capability: 'connectedAccounts', reason: 'Use the selected Railway API token.',
      scope: { serviceRefs: [ACCOUNT_ID], operations: ['use'], materializationKinds: ['httpHeaders'] } },
  ], optional: [] },
  connectedAccountDescriptors: { [ACCOUNT_ID]: {
    declaration: { title: 'Railway account', ui: { category: 'cloud-machines' }, authentication: {
      account: { artifactId: 'connected-account-authentication', exportName: 'activate' }, defaultModeId: 'token', modes: [{
        id: 'token', title: 'Account API token', kind: 'manual', outcomeReconciliation: 'none', credentialOrigin: 'authentication',
        browserReachability: 'unreachable',
        setup: { url: 'https://railway.com/account/tokens', createKeyTitle: 'Open Railway account tokens',
          checklist: ['Open [Tokens in your Railway account settings] and create a token.', 'Select No workspace to create an account token, then copy and paste it here.'],
          shapeHint: 'Use an account API token. Project and workspace tokens cannot perform the account check used here.' },
        credentialFieldKeys: { token: 'token' }, directExport: { contractVersion: CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 },
        fields: [{ id: 'token', title: 'Account API token', description: 'A Railway Account API token with access to the selected environment. Project tokens are not supported.', schema: { type: 'string', minLength: 1 }, secret: true }],
      }] } }, runtime: connectedAccountRuntime, accountRuntime: connectedAccountPortableRuntime,
  } },
  machineProvisioners: { [CONTRIBUTION.localId]: MACHINE_PROVISIONER },
  actions: {
    check: { ...defaults, title: 'Check Railway access', dangerLevel: 'safe', inputSchema: ROLE_SCHEMAS.checkInput, resultSchema: MachineProvisionerCheckResultV1Schema,
      async run(_input, context) { return runtime(context).check(); } },
    options: { ...defaults, title: 'Choose Railway environment', dangerLevel: 'safe', inputSchema: RailwayOptionsSchema, resultSchema: MachineProvisionerOptionsResultV1Schema,
      inputHints: { fields: [{ path: 'environmentId', title: 'Environment ID', widget: 'text', required: true }] },
      async run(input, context): Promise<MachineProvisionerOptionsResultV1> {
        const check = await runtime(context).check();
        const dimensions = { size: [], image: [], location: [], network: [], duration: [] };
        if (!check.available) return { dimensions, code: 'provider_unavailable' };
        if (input.environmentId === undefined) return { dimensions };
        return { base: { launch: { environmentId: input.environmentId }, guestPlatform: 'linux', retention }, dimensions };
      } },
    acquire: { ...defaults, title: 'Create Railway sandbox', confirmation, dangerLevel: 'writesRemote', inputSchema: ROLE_SCHEMAS.acquireInput, resultSchema: RECONCILIATION.result,
      async run(input, context) { return input.managedId ? runtime(context).acquire(input.launch, input.managedId) : { kind: 'rejected' as const, code: 'invalid_request' as const }; } },
    reconcile: { ...defaults, title: 'Recover Railway sandbox', dangerLevel: 'safe', inputSchema: RECONCILIATION.input, resultSchema: RECONCILIATION.result,
      async run(input, context) { return 'nativeOperation' in input ? runtime(context).recover(input.nativeOperation) : runtime(context).recoverCorrelation(input.correlation.managedId); } },
    bootstrap: { ...defaults, title: 'Prepare Railway guest', confirmation, dangerLevel: 'writesRemote', inputSchema: ROLE_SCHEMAS.bootstrapInput, resultSchema: MachineProvisionerBootstrapCarrierV1Schema,
      async run(input, context) { return runtime(context).bootstrap(input.resource); } },
    inspect: { ...defaults, title: 'Inspect Railway sandbox', dangerLevel: 'safe', inputSchema: ROLE_SCHEMAS.resourceInput, resultSchema: MachineProvisionerObservationV1Schema,
      async run(input, context) { return runtime(context).inspect(input.resource); } },
    power: { ...defaults, title: 'Change Railway power', confirmation, dangerLevel: 'writesRemote', inputSchema: ROLE_SCHEMAS.powerInput, resultSchema: MachineProvisionerPowerResultV1Schema,
      async run(input, context) { return runtime(context).power(input.resource, input.intent); } },
    destroy: { ...defaults, title: 'Delete Railway sandbox', confirmation, dangerLevel: 'destructive', inputSchema: RECONCILIATION.destroyInput, resultSchema: RECONCILIATION.destroyResult,
      async run(input, context) { return runtime(context).destroy(input); } },
    'observe-cleanup': { ...defaults, title: 'Observe Railway deletion', dangerLevel: 'safe', inputSchema: RECONCILIATION.cleanupInput, resultSchema: RECONCILIATION.cleanupResult,
      async run(input, context) { return runtime(context).cleanup(input.nativeOperation); } },
    exec: { ...defaults, title: 'Run in Railway guest', confirmation, dangerLevel: 'writesRemote', inputSchema: ROLE_SCHEMAS.execInput, resultSchema: MachineProvisionerNativeExecResultV1Schema,
      async run(input, context) { return runtime(context).exec(input); } },
    'put-file': { ...defaults, title: 'Write Railway guest file', confirmation, dangerLevel: 'writesRemote', inputSchema: ROLE_SCHEMAS.putFileInput, resultSchema: MachineProvisionerPutFileResultV1Schema,
      async run(input, context) { return runtime(context).putFile(input); } },
  },
});
export const PLUGIN_MANIFEST = PLUGIN.manifest;
export const activateAccount = (api: Parameters<typeof PLUGIN.activateAccount>[0]) =>
  PLUGIN.activateAccount(api, { artifactId: 'account-runtime', exportName: 'activateAccount' });
