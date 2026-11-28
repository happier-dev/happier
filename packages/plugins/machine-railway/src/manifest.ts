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
import { ACCOUNT_ID, ACCOUNT_PURPOSE, ORIGINS, RAILWAY_ENVIRONMENT_KEY, connectedAccountRuntime, connectedAccountPortableRuntime, nativeFetch } from './account.js';
import { railwayOAuthFields } from './oauth.js';
import { createRailwayNativeClient } from './machine/nativeClient.js';
import { createRailwayPreparationClient, RAILWAY_PREPARATION_HOME, RailwayPreparationInputSchema, RailwayPreparedArtifactSchema, RailwayPreparationOperationSchema, PREPARATION_SCHEMAS } from './machine/preparation.js';
import { BILLING, CONTRIBUTION, RailwayLaunchSchema, RailwayOptionsSchema, RailwayResourceSchema, RailwayOperationSchema, ROLE_SCHEMAS, RECONCILIATION } from './machine/schemas.js';

export { ROLE_SCHEMAS, prepareStoredSchemas } from './machine/schemas.js';
const defaults = { scopes: ['global'], surfaces: ['cli', 'plugin', 'ui', 'agent'], hostAccess: ['native-api', ACCOUNT_PURPOSE],
  execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } },
} as const;
const confirmation = { title: 'Manage this Railway sandbox?', body: 'Railway charges for sandbox resources. This sandbox stays running until you delete it; deleting permanently removes its filesystem.' };
const retention = { supportedIntents: ['delete'] } as const;
const runtime = (context: PluginAccountActionContext | PluginInvocationContext) => createRailwayNativeClient(nativeFetch(context), context.signal, context.invokedAtMs);
const preparationRuntime = (context: PluginAccountActionContext | PluginInvocationContext) => createRailwayPreparationClient(nativeFetch(context), context.signal);

export const MACHINE_PROVISIONER = {
  title: 'Railway', icon: 'cloud', resourceKind: 'railway-sandbox', schemaVersion: 1,
  enrollmentRole: 'sandbox', kindTitle: 'Sandbox', description: 'Run Happier in a Railway sandbox until you delete it.',
  launchSchema: RailwayLaunchSchema.jsonSchema, resourceSchema: RailwayResourceSchema.jsonSchema,
  resourceIdPath: 'sandboxId', platforms: ['darwin', 'linux', 'win32'], prerequisites: [], browserReachable: false,
  billing: BILLING, retention,
  actions: { check: 'check', options: 'options', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', power: 'power', destroy: 'destroy' },
  bootstrapTransport: { kind: 'native', exec: 'exec', putFile: 'put-file' },
  reconciliation: { nativeOperationSchema: RailwayOperationSchema.jsonSchema, action: 'reconcile', cleanup: 'observe-cleanup' },
  preparation: { inputSchema: RailwayPreparationInputSchema.jsonSchema, artifactSchema: RailwayPreparedArtifactSchema.jsonSchema,
    nativeOperationSchema: RailwayPreparationOperationSchema.jsonSchema, artifactLaunchPath: 'launch',
    actions: { build: 'prepare-build', inspect: 'prepare-inspect', destroy: 'prepare-destroy' } },
} satisfies MachineProvisionerAuthorDefinitionV1;

export const PLUGIN = definePlugin({
  id: CONTRIBUTION.pluginId, version: '0.0.0', displayName: 'Railway Machines' satisfies PluginLocalizedStringV2,
  description: 'Create and manage Railway sandboxes as ordinary Happier Machines.',
  entrypoints: { daemon: './.happier-plugin-build/daemon.js' },
  // The provider's own mark beside its name in Machines: Railway's mark from Simple Icons 13.21.0 (CC0-1.0), monochrome so the host draws it in ink.
  brand: { iconResourceId: 'brand-icon', monochrome: true },
  resources: { 'brand-icon': { kind: 'asset' as const, path: 'assets/brand.png', contentType: 'image/png' } },
  hostAccess: { required: [
    { id: 'native-api', capability: 'network', reason: 'Manage the selected Railway sandbox.',
      scope: { targets: ORIGINS.map(origin => ({ kind: 'fixedOrigin' as const, origin })), methods: ['POST'] } },
    { id: ACCOUNT_PURPOSE, capability: 'connectedAccounts', reason: 'Use the selected Railway account.',
      scope: { serviceRefs: [ACCOUNT_ID], operations: ['use'], materializationKinds: ['httpHeaders', 'environment'] } },
  ], optional: [] },
  connectedAccountDescriptors: { [ACCOUNT_ID]: {
    declaration: { title: 'Railway account', ui: { category: 'cloud-machines' }, authentication: {
      account: { artifactId: 'connected-account-authentication', exportName: 'activate' }, defaultModeId: 'oauth', modes: [{
        id: 'oauth', title: 'Sign in with Railway', kind: 'oauthAuthorizationCode', pkce: 'required', outcomeReconciliation: 'none',
        // Railway requires matching access levels. Project creation and project or volume deletion need admin.
        scopes: ['openid', 'email', 'profile', 'offline_access', 'workspace:admin', 'project:admin'],
        postAuthenticationFieldIds: railwayOAuthFields.map(field => field.id),
        configuration: { scope: 'account', changeBehavior: 'reconnect', fields: [...railwayOAuthFields] },
      }, {
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
        const dimensions = { size: [], image: [], location: [], network: [], duration: [] };
        let environmentId = input.environmentId;
        if (environmentId === undefined) {
          const material = await context.services.connectedAccounts.materialize(ACCOUNT_PURPOSE,
            { kind: 'environment', keys: [RAILWAY_ENVIRONMENT_KEY] }, { signal: context.signal });
          context.signal.throwIfAborted();
          if (material.kind === 'environment') environmentId = material.env[RAILWAY_ENVIRONMENT_KEY];
        }
        if (environmentId === undefined) return { dimensions };
        return { base: { launch: { environmentId }, guestPlatform: 'linux', retention }, dimensions: { ...dimensions,
          image: [{ id: 'railway-default', title: 'Railway Ubuntu sandbox', guestPlatform: 'linux', assignments: [], nativeFacts: {
            preparationGuest: { target: { os: 'linux', arch: 'x64' }, remoteHomeDir: RAILWAY_PREPARATION_HOME },
            image: { id: 'railway-default', title: 'Railway Ubuntu sandbox' },
          } }],
        } };
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
    'prepare-build': { ...defaults, title: 'Build Railway prepared checkpoint', dangerLevel: 'writesRemote',
      confirmation: { title: 'Build this Railway checkpoint?', body: 'This creates a paid temporary sandbox and a stored checkpoint. The checkpoint remains until deleted. See https://docs.railway.com/sandboxes#pricing.' },
      inputSchema: PREPARATION_SCHEMAS.buildInput, resultSchema: PREPARATION_SCHEMAS.buildResult,
      async run(input, context) { return preparationRuntime(context).build(input, () => context.services.machineProvisioners.waitForNativeObservation()); } },
    'prepare-inspect': { ...defaults, title: 'Inspect Railway prepared checkpoint', dangerLevel: 'safe',
      inputSchema: PREPARATION_SCHEMAS.inspectInput, resultSchema: PREPARATION_SCHEMAS.inspectResult,
      async run(input, context) { return preparationRuntime(context).inspect('nativeOperation' in input ? { nativeOperation: input.nativeOperation.value } : input); } },
    'prepare-destroy': { ...defaults, title: 'Delete Railway prepared checkpoint', dangerLevel: 'destructive',
      confirmation: { title: 'Delete this Railway checkpoint?', body: 'This permanently deletes the owned checkpoint and any retained temporary build sandbox.' },
      inputSchema: PREPARATION_SCHEMAS.destroyInput, resultSchema: PREPARATION_SCHEMAS.destroyResult,
      async run(input, context) { return preparationRuntime(context).destroy({
        ...(input.artifact === undefined ? {} : { artifact: input.artifact.value }),
        ...(input.nativeOperation === undefined ? {} : { nativeOperation: input.nativeOperation.value }),
      }); } },
    exec: { ...defaults, title: 'Run in Railway guest', confirmation, dangerLevel: 'writesRemote', inputSchema: ROLE_SCHEMAS.execInput, resultSchema: MachineProvisionerNativeExecResultV1Schema,
      async run(input, context) { return runtime(context).exec(input); } },
    'put-file': { ...defaults, title: 'Write Railway guest file', confirmation, dangerLevel: 'writesRemote', inputSchema: ROLE_SCHEMAS.putFileInput, resultSchema: MachineProvisionerPutFileResultV1Schema,
      async run(input, context) { return runtime(context).putFile(input); } },
  },
});
export const PLUGIN_MANIFEST = PLUGIN.manifest;
export const activateAccount = (api: Parameters<typeof PLUGIN.activateAccount>[0]) =>
  PLUGIN.activateAccount(api, { artifactId: 'account-runtime', exportName: 'activateAccount' });
