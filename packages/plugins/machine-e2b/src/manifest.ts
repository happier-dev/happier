import { projectE2bNativeFailure } from './machine/nativeFailure.js';
import { definePlugin, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import type { PluginLocalizedStringV2 } from '@happier-dev/plugin-sdk';
import { CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 } from '@happier-dev/plugin-sdk/connected-accounts';
import {   MachineProvisionerBootstrapCarrierV1Schema, MachineProvisionerCheckResultV1Schema,
  MachineProvisionerObservationV1Schema, MachineProvisionerOptionsResultV1Schema,
  MachineProvisionerPowerResultV1Schema, MachineProvisionerNativeExecResultV1Schema, MachineProvisionerPutFileResultV1Schema,
  observeMachineProvisionerNativeRead, type MachineProvisionerAuthorDefinitionV1, type MachineProvisionerOptionsResultV1,
} from '@happier-dev/plugin-sdk/machine-provisioners';
import { ACCOUNT_ID, ACCOUNT_PURPOSE, connectedAccountRuntime, connectedAccountPortableRuntime } from './account.js';
import { nativeFetch } from './machine/credentials.js';
import { createE2bNativeClient } from './machine/nativeClient.js';
import { createE2bPreparationClient, E2B_PREPARATION_HOME, E2bPreparationInputSchema, E2bPreparedArtifactSchema, E2bPreparationOperationSchema, PREPARATION_SCHEMAS } from './machine/preparation.js';
import { BILLING, RETENTION, CONTRIBUTION, ROLE_SCHEMAS, RECONCILIATION, E2bLaunchSchema, E2bOptionsSchema, E2bResourceSchema, E2bOperationSchema } from './machine/schemas.js';

export { ROLE_SCHEMAS, prepareStoredSchemas } from './machine/schemas.js';
const defaults = { scopes: ['global'], surfaces: ['cli', 'plugin', 'ui'], hostAccess: ['native-api', ACCOUNT_PURPOSE],
  execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } },
} as const;
const confirmation = { title: 'Manage this E2B sandbox?', body: 'E2B bills running compute. Pause preserves memory and disk; delete permanently removes both.' };
const runtime = (context: PluginAccountActionContext | PluginInvocationContext) => createE2bNativeClient(nativeFetch(context), context.signal, context.invokedAtMs);
const preparationRuntime = (context: PluginAccountActionContext | PluginInvocationContext) => createE2bPreparationClient(nativeFetch(context), context.signal);
const errorCode = (error: unknown) => error instanceof Error && error.message === 'credential_unavailable' ? 'credential_unavailable' : 'e2b_unavailable';

export const MACHINE_PROVISIONER = {
  title: 'E2B', icon: 'cloud', resourceKind: 'e2b-sandbox', schemaVersion: 1, enrollmentRole: 'sandbox',
  kindTitle: 'Sandbox', description: 'A Linux sandbox on E2B, connected as an ordinary Happier Machine.',
  launchSchema: E2bLaunchSchema.jsonSchema, resourceSchema: E2bResourceSchema.jsonSchema,
  resourceIdPath: 'sandboxId', platforms: ['darwin', 'linux', 'win32'], prerequisites: [], browserReachable: true,
  billing: BILLING, retention: RETENTION, nativeDurationInput: { path: 'timeoutSeconds', unit: 'seconds' },
  actions: { check: 'check', options: 'options', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', power: 'power', destroy: 'destroy' },
  bootstrapTransport: { kind: 'native', exec: 'exec', putFile: 'put-file' },
  reconciliation: { nativeOperationSchema: E2bOperationSchema.jsonSchema, action: 'reconcile' },
  preparation: { inputSchema: E2bPreparationInputSchema.jsonSchema, artifactSchema: E2bPreparedArtifactSchema.jsonSchema,
    nativeOperationSchema: E2bPreparationOperationSchema.jsonSchema, artifactLaunchPath: 'launch',
    actions: { build: 'prepare-build', inspect: 'prepare-inspect', destroy: 'prepare-destroy' } },
} satisfies MachineProvisionerAuthorDefinitionV1;

export const PLUGIN = definePlugin({
  id: CONTRIBUTION.pluginId, version: '0.0.0', displayName: 'E2B Machines' satisfies PluginLocalizedStringV2, description: MACHINE_PROVISIONER.description,
  entrypoints: { daemon: './.happier-plugin-build/daemon.js' },
  hostAccess: { required: [
    { id: 'native-api', capability: 'network', reason: 'Manage E2B sandboxes and install the portable guest runtime.',
      scope: { targets: [{ kind: 'fixedOrigin', origin: 'https://api.e2b.app' }, { kind: 'httpsHostSuffix', hostSuffix: 'e2b.app' }], methods: ['GET', 'POST', 'DELETE'] } },
    { id: ACCOUNT_PURPOSE, capability: 'connectedAccounts', reason: 'Use the selected E2B API key.',
      scope: { serviceRefs: [ACCOUNT_ID], operations: ['use'], materializationKinds: ['httpHeaders'] } },
  ], optional: [] },
  connectedAccountDescriptors: { [ACCOUNT_ID]: {
    declaration: { title: 'E2B account', ui: { category: 'cloud-machines' }, authentication: {
      account: { artifactId: 'connected-account-authentication', exportName: 'activate' }, defaultModeId: 'token', modes: [{
        id: 'token', title: 'API key', kind: 'manual', apiKey: true, outcomeReconciliation: 'none', credentialOrigin: 'authentication',
        setup: { url: 'https://console.e2b.dev/?tab=keys', createKeyTitle: 'Open E2B API keys',
          checklist: ['Open the [API keys tab in the E2B dashboard] for the team that will own your sandboxes.', 'Copy an API key and paste it here.'],
          shapeHint: 'E2B API keys start with e2b_.' },
        credentialFieldKeys: { token: 'token' }, directExport: { contractVersion: CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 },
        fields: [{ id: 'token', title: 'API key', schema: { type: 'string', minLength: 1 }, secret: true }],
      }],
    } }, runtime: connectedAccountRuntime, accountRuntime: connectedAccountPortableRuntime,
  } },
  machineProvisioners: { [CONTRIBUTION.localId]: MACHINE_PROVISIONER },
  actions: {
    check: { ...defaults, title: 'Check E2B access', dangerLevel: 'safe', inputSchema: ROLE_SCHEMAS.checkInput, resultSchema: MachineProvisionerCheckResultV1Schema,
      async run(_input, context) { try { return await runtime(context).check(); }
        catch (error) { return projectE2bNativeFailure(error, () => ({ available: false, code: errorCode(error), status: 'E2B unavailable' })); } } },
    options: { ...defaults, title: 'E2B sandbox options', dangerLevel: 'safe', inputSchema: E2bOptionsSchema, resultSchema: MachineProvisionerOptionsResultV1Schema,
      inputHints: { fields: [
        { path: 'templateId', title: 'Template ID or alias', widget: 'text', required: true, defaultValue: 'base' },
        { path: 'timeoutSeconds', title: 'Running duration (seconds)', widget: 'integer', required: true, defaultValue: 300,
          description: 'E2B pauses with memory and disk retained when this duration expires. Team limits still apply.' },
      ] },
      async run(input, context): Promise<MachineProvisionerOptionsResultV1> {
        const check = await runtime(context).check();
        if (!check.available) return { dimensions: { size: [], location: [], network: [], image: [], duration: [] }, code: 'provider_unavailable' };
        const launch = E2bLaunchSchema.parse({ templateId: input.templateId ?? 'base', timeoutSeconds: input.timeoutSeconds ?? 300 });
        return { base: { launch, guestPlatform: 'linux' as const, retention: RETENTION }, dimensions: { size: [], location: [], network: [],
          image: [{ id: launch.templateId, title: launch.templateId, assignments: [], guestPlatform: 'linux' as const, nativeFacts: {
            preparationGuest: { target: { os: 'linux', arch: 'x64' }, remoteHomeDir: E2B_PREPARATION_HOME },
            image: { id: launch.templateId, title: launch.templateId },
          } }],
          duration: [{ id: String(launch.timeoutSeconds), title: `${launch.timeoutSeconds} s`, assignments: [], nativeFacts: { duration: { id: String(launch.timeoutSeconds), title: `${launch.timeoutSeconds} s`, afterMs: launch.timeoutSeconds * 1000 } } }],
        } };
      } },
    acquire: { ...defaults, title: 'Create E2B sandbox', dangerLevel: 'writesRemote', confirmation, inputSchema: ROLE_SCHEMAS.acquireInput, resultSchema: RECONCILIATION.result,
      async run(input, context) { if (!input.managedId) return { kind: 'rejected', code: 'invalid_request' };
        return runtime(context).acquire(input.launch, input.managedId); } },
    reconcile: { ...defaults, title: 'Recover E2B sandbox', dangerLevel: 'safe', inputSchema: RECONCILIATION.input, resultSchema: RECONCILIATION.result,
      async run(input, context) { return runtime(context).recover('nativeOperation' in input ? input.nativeOperation
        : { kind: 'acquire', managedId: input.correlation.managedId, launch: input.correlation.launch }); } },
    bootstrap: { ...defaults, title: 'Prepare E2B guest', dangerLevel: 'writesRemote', confirmation, inputSchema: ROLE_SCHEMAS.bootstrapInput, resultSchema: MachineProvisionerBootstrapCarrierV1Schema,
      async run(input, context) { return runtime(context).bootstrap(input.resource); } },
    inspect: { ...defaults, title: 'Inspect E2B sandbox', dangerLevel: 'safe', inputSchema: ROLE_SCHEMAS.resourceInput, resultSchema: MachineProvisionerObservationV1Schema,
      async run(input, context) { try { return await runtime(context).inspect(input.resource); }
        catch (error) { return projectE2bNativeFailure(error, () => observeMachineProvisionerNativeRead(context.invokedAtMs, { kind: 'unknown', reason: errorCode(error) })); } } },
    power: { ...defaults, title: 'Pause or resume E2B sandbox', dangerLevel: 'writesRemote', confirmation, inputSchema: ROLE_SCHEMAS.powerInput, resultSchema: MachineProvisionerPowerResultV1Schema,
      async run(input, context) { try { return await runtime(context).power(input.resource, input.intent); }
        catch (error) { return projectE2bNativeFailure(error, () => ({ kind: 'unknown', code: errorCode(error) })); } } },
    destroy: { ...defaults, title: 'Delete E2B sandbox', dangerLevel: 'destructive', confirmation, inputSchema: RECONCILIATION.destroyInput, resultSchema: RECONCILIATION.destroyResult,
      async run(input, context) { try { return await runtime(context).destroy(input); }
        catch (error) { return projectE2bNativeFailure(error, () => ({ kind: 'unknown', code: errorCode(error) })); } } },
    'prepare-build': { ...defaults, title: 'Build E2B prepared template', dangerLevel: 'writesRemote',
      confirmation: { title: 'Build this E2B template?', body: 'Provider charges apply for build, storage, and runtime. See https://e2b.dev/pricing for current pricing.' },
      inputSchema: PREPARATION_SCHEMAS.buildInput, resultSchema: PREPARATION_SCHEMAS.buildResult,
      async run(input, context) { return preparationRuntime(context).build(input); } },
    'prepare-inspect': { ...defaults, title: 'Inspect E2B prepared template', dangerLevel: 'safe',
      inputSchema: PREPARATION_SCHEMAS.inspectInput, resultSchema: PREPARATION_SCHEMAS.inspectResult,
      async run(input, context) { return preparationRuntime(context).inspect('nativeOperation' in input
        ? { nativeOperation: input.nativeOperation.value } : input); } },
    'prepare-destroy': { ...defaults, title: 'Delete E2B prepared template', dangerLevel: 'destructive',
      confirmation: { title: 'Delete this E2B template?', body: 'Deleting the template permanently removes this prepared image. E2B requires its running and paused sandboxes to be deleted first.' },
      inputSchema: PREPARATION_SCHEMAS.destroyInput, resultSchema: PREPARATION_SCHEMAS.destroyResult,
      async run(input, context) { return preparationRuntime(context).destroy({
        ...(input.artifact === undefined ? {} : { artifact: input.artifact.value }),
        ...(input.nativeOperation === undefined ? {} : { nativeOperation: input.nativeOperation.value }),
      }); } },
    exec: { ...defaults, title: 'Execute E2B guest command', dangerLevel: 'writesRemote', confirmation, inputSchema: ROLE_SCHEMAS.execInput, resultSchema: MachineProvisionerNativeExecResultV1Schema,
      async run(input, context) { return runtime(context).exec(input); } },
    'put-file': { ...defaults, title: 'Write E2B guest file', dangerLevel: 'writesRemote', confirmation, inputSchema: ROLE_SCHEMAS.putFileInput, resultSchema: MachineProvisionerPutFileResultV1Schema,
      async run(input, context) { return runtime(context).putFile(input); } },
  },
});
export const PLUGIN_MANIFEST = PLUGIN.manifest;
export const activateAccount = (api: Parameters<typeof PLUGIN.activateAccount>[0]) => PLUGIN.activateAccount(api, { artifactId: 'account-runtime', exportName: 'activateAccount' });
