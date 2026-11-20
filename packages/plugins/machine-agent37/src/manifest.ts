import { definePlugin, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import type { PluginLocalizedStringV2 } from '@happier-dev/plugin-sdk';
import { CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 } from '@happier-dev/plugin-sdk/connected-accounts';
import {
  MachineProvisionerBootstrapCarrierV1Schema, MachineProvisionerCheckResultV1Schema,
  MachineProvisionerObservationV1Schema, MachineProvisionerOptionsResultV1Schema,
  MachineProvisionerPowerResultV1Schema, MachineProvisionerNativeExecResultV1Schema, MachineProvisionerPutFileResultV1Schema,
  observeMachineProvisionerNativeRead, projectMachineProvisionerActionFailure, type MachineProvisionerAuthorDefinitionV1, type MachineProvisionerOptionsResultV1,
} from '@happier-dev/plugin-sdk/machine-provisioners';
import { ACCOUNT_ID, ACCOUNT_PURPOSE, connectedAccountRuntime, connectedAccountPortableRuntime } from './account.js';
import { nativeFetch } from './machine/credentials.js';
import { createAgent37NativeClient } from './machine/nativeClient.js';
import { Agent37PreparationInputSchema, Agent37PreparedArtifactSchema, Agent37PreparationOperationSchema, PREPARATION_SCHEMAS, createAgent37PreparationClient } from './machine/preparation.js';
import { BILLING, RETENTION, CONTRIBUTION, ROLE_SCHEMAS, RECONCILIATION, Agent37LaunchSchema, Agent37OptionsSchema, Agent37ResourceSchema, Agent37OperationSchema } from './machine/schemas.js';
import { options as projectOptions } from './machine/options.js';

export { ROLE_SCHEMAS, prepareStoredSchemas } from './machine/schemas.js';
const defaults = { scopes: ['global'], surfaces: ['cli', 'plugin', 'ui', 'agent'], hostAccess: ['native-api', ACCOUNT_PURPOSE],
  execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } },
} as const;
const confirmation = { title: 'Manage this Agent37 machine?', body: 'Agent37 bills running compute and retained disk. Stop is a cold shutdown; retained disk is still billed. Delete permanently removes the instance.' };
const runtime = (context: PluginAccountActionContext | PluginInvocationContext) => createAgent37NativeClient(nativeFetch(context), context.signal, context.invokedAtMs);
const preparationRuntime = (context: PluginAccountActionContext | PluginInvocationContext) => createAgent37PreparationClient(nativeFetch(context), context.signal);
const errorCode = (error: unknown) => error instanceof Error && error.message === 'credential_unavailable' ? 'credential_unavailable' : 'agent37_unavailable';

export const MACHINE_PROVISIONER = {
  title: 'Agent37', icon: 'cloud', resourceKind: 'agent37-instance', schemaVersion: 1, enrollmentRole: 'sandbox',
  kindTitle: 'Linux machine', description: 'Persistent Linux machines on Agent37.',
  launchSchema: Agent37LaunchSchema.jsonSchema, resourceSchema: Agent37ResourceSchema.jsonSchema,
  resourceIdPath: 'instanceId', platforms: ['darwin', 'linux', 'win32'], prerequisites: [], browserReachable: false,
  billing: BILLING, retention: RETENTION,
  actions: { check: 'check', options: 'options', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', power: 'power', destroy: 'destroy' },
  bootstrapTransport: { kind: 'native', exec: 'exec', putFile: 'put-file' },
  reconciliation: { nativeOperationSchema: Agent37OperationSchema.jsonSchema, action: 'reconcile' },
  preparation: { inputSchema: Agent37PreparationInputSchema.jsonSchema, artifactSchema: Agent37PreparedArtifactSchema.jsonSchema,
    nativeOperationSchema: Agent37PreparationOperationSchema.jsonSchema, artifactLaunchPath: 'launch',
    actions: { build: 'prepare-build', inspect: 'prepare-inspect', destroy: 'prepare-destroy' } },
} satisfies MachineProvisionerAuthorDefinitionV1;

export const PLUGIN = definePlugin({
  id: CONTRIBUTION.pluginId, version: '0.0.0', displayName: 'Agent37 Machines' satisfies PluginLocalizedStringV2, description: MACHINE_PROVISIONER.description,
  entrypoints: { daemon: './.happier-plugin-build/daemon.js' },
  hostAccess: { required: [
    { id: 'native-api', capability: 'network', reason: 'Manage Agent37 machines and install the portable guest runtime.',
      scope: { targets: [{ kind: 'fixedOrigin', origin: 'https://api.agent37.com' }, { kind: 'fixedOrigin', origin: 'https://sandbox.agent37.app' }], methods: ['GET', 'POST', 'DELETE'] } },
    { id: ACCOUNT_PURPOSE, capability: 'connectedAccounts', reason: 'Use the selected Agent37 API key.',
      scope: { serviceRefs: [ACCOUNT_ID], operations: ['use'], materializationKinds: ['httpHeaders'] } },
  ], optional: [] },
  connectedAccountDescriptors: { [ACCOUNT_ID]: {
    declaration: { title: 'Agent37 account', ui: { category: 'cloud-machines' }, authentication: {
      account: { artifactId: 'connected-account-authentication', exportName: 'activate' }, defaultModeId: 'token', modes: [{
        id: 'token', title: 'API key', kind: 'manual', apiKey: true, outcomeReconciliation: 'none', credentialOrigin: 'authentication',
        browserReachability: 'unreachable',
        setup: { url: 'https://www.agent37.com/dashboard', createKeyTitle: 'Open Agent37 API keys',
          checklist: ['Open API keys in the [Agent37 dashboard].', 'Choose an existing Saved Secret for the API key, or enter a new key.'],
          shapeHint: 'Use an Agent37 API key.' },
        credentialFieldKeys: { token: 'token' }, directExport: { contractVersion: CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 },
        fields: [{ id: 'token', title: 'API key', schema: { type: 'string', minLength: 1 }, secret: true }],
      }],
    } }, runtime: connectedAccountRuntime, accountRuntime: connectedAccountPortableRuntime,
  } },
  machineProvisioners: { [CONTRIBUTION.localId]: MACHINE_PROVISIONER },
  actions: {
    check: { ...defaults, title: 'Check Agent37 access', dangerLevel: 'safe', inputSchema: ROLE_SCHEMAS.checkInput, resultSchema: MachineProvisionerCheckResultV1Schema,
      async run(_input, context) { try { return await runtime(context).check(); }
        catch (error) { return projectMachineProvisionerActionFailure(error, () => ({ available: false, code: errorCode(error), status: 'Agent37 unavailable' })); } } },
    options: { ...defaults, title: 'Agent37 machine options', dangerLevel: 'safe', inputSchema: Agent37OptionsSchema, resultSchema: MachineProvisionerOptionsResultV1Schema,
      async run(_input): Promise<MachineProvisionerOptionsResultV1> {
        return projectOptions();
      } },
    acquire: { ...defaults, title: 'Create Agent37 machine', dangerLevel: 'writesRemote', confirmation, inputSchema: ROLE_SCHEMAS.acquireInput, resultSchema: RECONCILIATION.result,
      async run(input, context) { if (!input.managedId) return { kind: 'rejected', code: 'invalid_request' };
        return runtime(context).acquire(input.launch, input.managedId); } },
    reconcile: { ...defaults, title: 'Recover Agent37 machine', dangerLevel: 'safe', inputSchema: RECONCILIATION.input, resultSchema: RECONCILIATION.result,
      async run(input, context) { return runtime(context).recover('nativeOperation' in input ? input.nativeOperation
        : { kind: 'acquire', managedId: input.correlation.managedId, launch: input.correlation.launch }); } },
    bootstrap: { ...defaults, title: 'Prepare Agent37 guest', dangerLevel: 'writesRemote', confirmation, inputSchema: ROLE_SCHEMAS.bootstrapInput, resultSchema: MachineProvisionerBootstrapCarrierV1Schema,
      async run(input, context) { return runtime(context).bootstrap(input.resource); } },
    inspect: { ...defaults, title: 'Inspect Agent37 machine', dangerLevel: 'safe', inputSchema: ROLE_SCHEMAS.resourceInput, resultSchema: MachineProvisionerObservationV1Schema,
      async run(input, context) { try { return await runtime(context).inspect(input.resource); }
        catch (error) { return projectMachineProvisionerActionFailure(error, () => observeMachineProvisionerNativeRead(context.invokedAtMs, { kind: 'unknown', reason: errorCode(error) })); } } },
    power: { ...defaults, title: 'Stop or start Agent37 machine', dangerLevel: 'writesRemote', confirmation, inputSchema: ROLE_SCHEMAS.powerInput, resultSchema: MachineProvisionerPowerResultV1Schema,
      async run(input, context) { try { return await runtime(context).power(input.resource, input.intent); }
        catch (error) { return projectMachineProvisionerActionFailure(error, () => ({ kind: 'unknown' as const, code: errorCode(error) })); } } },
    destroy: { ...defaults, title: 'Delete Agent37 machine', dangerLevel: 'destructive', confirmation, inputSchema: RECONCILIATION.destroyInput, resultSchema: RECONCILIATION.destroyResult,
      async run(input, context) { try { return await runtime(context).destroy(input); }
        catch (error) { return projectMachineProvisionerActionFailure(error, () => ({ kind: 'unknown' as const, code: errorCode(error) })); } } },
    'prepare-build': { ...defaults, title: 'Build Agent37 prepared template', dangerLevel: 'writesRemote',
      confirmation: { title: 'Build this Agent37 template?', body: 'Agent37 cloud builds are free. Provider charges apply to instances and retained storage; see https://www.agent37.com/docs/agents-api/billing. An active build continues after cancellation until Agent37 finishes it.' },
      inputSchema: PREPARATION_SCHEMAS.buildInput, resultSchema: PREPARATION_SCHEMAS.buildResult,
      async run(input, context) { return preparationRuntime(context).build(input); } },
    'prepare-inspect': { ...defaults, title: 'Inspect Agent37 prepared template', dangerLevel: 'safe',
      inputSchema: PREPARATION_SCHEMAS.inspectInput, resultSchema: PREPARATION_SCHEMAS.inspectResult,
      async run(input, context) { return preparationRuntime(context).inspect('nativeOperation' in input ? { nativeOperation: input.nativeOperation.value } : input); } },
    'prepare-destroy': { ...defaults, title: 'Delete Agent37 prepared template', dangerLevel: 'destructive',
      confirmation: { title: 'Delete this Agent37 template?', body: 'This removes the workspace template. Existing instances keep their image. Contact Agent37 support for physical image purge after those instances are deleted.' },
      inputSchema: PREPARATION_SCHEMAS.destroyInput, resultSchema: PREPARATION_SCHEMAS.destroyResult,
      async run(input, context) { return preparationRuntime(context).destroy({
        ...(input.artifact === undefined ? {} : { artifact: input.artifact.value }),
        ...(input.nativeOperation === undefined ? {} : { nativeOperation: input.nativeOperation.value }),
      }); } },
    exec: { ...defaults, title: 'Execute Agent37 guest command', dangerLevel: 'writesRemote', confirmation, inputSchema: ROLE_SCHEMAS.execInput, resultSchema: MachineProvisionerNativeExecResultV1Schema,
      async run(input, context) { return runtime(context).exec(input); } },
    'put-file': { ...defaults, title: 'Write Agent37 guest file', dangerLevel: 'writesRemote', confirmation, inputSchema: ROLE_SCHEMAS.putFileInput, resultSchema: MachineProvisionerPutFileResultV1Schema,
      async run(input, context) { return runtime(context).putFile(input); } },
  },
});
export const PLUGIN_MANIFEST = PLUGIN.manifest;
export const activateAccount = (api: Parameters<typeof PLUGIN.activateAccount>[0]) => PLUGIN.activateAccount(api, { artifactId: 'account-runtime', exportName: 'activateAccount' });
