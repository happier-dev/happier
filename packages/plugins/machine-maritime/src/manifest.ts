import { definePlugin, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import type { PluginLocalizedStringV2 } from '@happier-dev/plugin-sdk';
import { CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 } from '@happier-dev/plugin-sdk/connected-accounts';
import {
  MachineProvisionerBootstrapCarrierV1Schema, MachineProvisionerCheckResultV1Schema,
  MachineProvisionerObservationV1Schema, MachineProvisionerOptionsResultV1Schema,
  MachineProvisionerPowerResultV1Schema, MachineProvisionerNativeExecResultV1Schema, MachineProvisionerPutFileResultV1Schema,
  observeMachineProvisionerNativeRead, type MachineProvisionerAuthorDefinitionV1, type MachineProvisionerOptionsResultV1,
} from '@happier-dev/plugin-sdk/machine-provisioners';
import { ACCOUNT_ID, ACCOUNT_PURPOSE, connectedAccountRuntime, connectedAccountPortableRuntime } from './account.js';
import { nativeFetch } from './machine/credentials.js';
import { createMaritimeNativeClient } from './machine/nativeClient.js';
import { BILLING, BILLING_BY_KIND, RETENTION, BOX_RETENTION, CONTRIBUTION, ROLE_SCHEMAS, RECONCILIATION, MaritimeLaunchSchema, MaritimeOptionsSchema, MaritimeResourceSchema, MaritimeOperationSchema } from './machine/schemas.js';

export { ROLE_SCHEMAS, prepareStoredSchemas } from './machine/schemas.js';
const defaults = { scopes: ['global'], surfaces: ['cli', 'plugin', 'ui'], hostAccess: ['native-api', ACCOUNT_PURPOSE],
  execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } },
} as const;
const confirmation = { title: 'Manage this Maritime machine?', body: 'Maritime may sleep idle machines and bills retained storage. Delete permanently removes the machine and its disk.' };
const runtime = (context: PluginAccountActionContext | PluginInvocationContext) => createMaritimeNativeClient(nativeFetch(context), context.signal, context.invokedAtMs);
const errorCode = (error: unknown) => error instanceof Error && error.message === 'credential_unavailable' ? 'credential_unavailable' : 'maritime_unavailable';

export const MACHINE_PROVISIONER = {
  title: 'Maritime', icon: 'cloud', resourceKind: 'maritime-machine', schemaVersion: 1, enrollmentRole: 'server',
  kindTitle: 'Machine', description: 'A persistent Linux machine. Idle machines may sleep; Happier resumes them before work.',
  launchSchema: MaritimeLaunchSchema.jsonSchema, resourceSchema: MaritimeResourceSchema.jsonSchema,
  resourceIdPath: 'machineId', platforms: ['darwin', 'linux', 'win32'], prerequisites: [], browserReachable: false,
  billing: BILLING, retention: BOX_RETENTION,
  actions: { check: 'check', options: 'options', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', power: 'power', destroy: 'destroy' },
  bootstrapTransport: { kind: 'native', exec: 'exec', putFile: 'put-file' },
  reconciliation: { nativeOperationSchema: MaritimeOperationSchema.jsonSchema, action: 'reconcile' },
} satisfies MachineProvisionerAuthorDefinitionV1;

export const PLUGIN = definePlugin({
  id: CONTRIBUTION.pluginId, version: '0.0.0', displayName: 'Maritime Machines' satisfies PluginLocalizedStringV2, description: MACHINE_PROVISIONER.description,
  entrypoints: { daemon: './.happier-plugin/daemon.js' },
  hostAccess: { required: [
    { id: 'native-api', capability: 'network', reason: 'Manage Maritime machines and install the portable guest runtime.',
      scope: { targets: [{ kind: 'fixedOrigin', origin: 'https://api.maritime.sh' }], methods: ['GET', 'POST', 'PUT', 'DELETE'] } },
    { id: ACCOUNT_PURPOSE, capability: 'connectedAccounts', reason: 'Use the selected Maritime API key.',
      scope: { serviceRefs: [ACCOUNT_ID], operations: ['use'], materializationKinds: ['httpHeaders'] } },
  ], optional: [] },
  connectedAccountDescriptors: { [ACCOUNT_ID]: {
    declaration: { title: 'Maritime account', ui: { category: 'cloud-machines' }, authentication: {
      account: { artifactId: 'connected-account-authentication', exportName: 'activate' }, defaultModeId: 'token', modes: [{
        id: 'token', title: 'API key', kind: 'manual', apiKey: true, outcomeReconciliation: 'none', credentialOrigin: 'authentication',
        browserReachability: 'unreachable',
        setup: { url: 'https://maritime.sh/docs/sdk/authentication', createKeyTitle: 'Maritime API key setup',
          checklist: ['Use one API key with manage scope: deleting agent boxes requires manage, beyond deploy and computers.', 'Select an existing Saved Secret for the API key, or enter a new key.'],
          shapeHint: 'Maritime API keys start with mk_.' },
        credentialFieldKeys: { token: 'token' }, directExport: { contractVersion: CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 },
        fields: [{ id: 'token', title: 'API key', schema: { type: 'string', minLength: 1 }, secret: true }],
      }],
    } }, runtime: connectedAccountRuntime, accountRuntime: connectedAccountPortableRuntime,
  } },
  machineProvisioners: { [CONTRIBUTION.localId]: MACHINE_PROVISIONER },
  actions: {
    check: { ...defaults, title: 'Check Maritime access', dangerLevel: 'safe', inputSchema: ROLE_SCHEMAS.checkInput, resultSchema: MachineProvisionerCheckResultV1Schema,
      async run(_input, context) { try { return await runtime(context).check(); }
        catch (error) { return { available: false, code: errorCode(error), status: 'Maritime unavailable' }; } } },
    options: { ...defaults, title: 'Maritime machine options', dangerLevel: 'safe', inputSchema: MaritimeOptionsSchema, resultSchema: MachineProvisionerOptionsResultV1Schema,
      inputHints: { fields: [
        { path: 'templateId', title: 'Agent box template', widget: 'text', defaultValue: 'zeroclaw' },
        { path: 'diskGb', title: 'Agent box disk (GB)', widget: 'integer', defaultValue: 5 },
        { path: 'alwaysOn', title: 'Keep agent boxes awake', widget: 'boolean', defaultValue: true,
          description: 'Uses the documented alwaysOn paid add-on; verify its price and availability with Maritime. Maritime also says never-sleep machines are not sold; a refused setting stops bootstrap. Linux computers still sleep when idle.' },
      ] },
      async run(input, context): Promise<MachineProvisionerOptionsResultV1> {
        const check = await runtime(context).check();
        if (!check.available) return { dimensions: { size: [], location: [], network: [], image: [], duration: [] }, code: 'provider_unavailable' };
        const launch = MaritimeLaunchSchema.parse({ kind: 'agent-box', templateId: input.templateId ?? 'zeroclaw',
          memMb: input.memMb ?? 2048, diskGb: input.diskGb ?? 5, alwaysOn: input.alwaysOn ?? true });
        const price = (amount: string, unit: string, source: string) => ({ amount, currency: 'USD', unit, source, observedAt: context.invokedAtMs });
        return { base: { launch, guestPlatform: 'linux', retention: BOX_RETENTION }, dimensions: {
          image: [
            { id: 'agent-box', title: 'Agent box', assignments: [{ path: 'kind', value: 'agent-box' }, { path: 'alwaysOn', value: input.alwaysOn ?? true }, { path: 'diskGb', value: input.diskGb ?? 5 }], guestPlatform: 'linux', billing: BILLING_BY_KIND['agent-box'], retention: BOX_RETENTION },
            { id: 'linux-computer', title: 'Linux computer (XFCE)', assignments: [{ path: 'kind', value: 'linux-computer' }, { path: 'alwaysOn', value: false }, { path: 'diskGb', value: 5 }], guestPlatform: 'linux', billing: BILLING_BY_KIND['linux-computer'], retention: RETENTION },
          ],
          size: [
            ...[2048, 4096, 8192].map(memMb => ({ id: 'box-' + memMb, title: `${memMb / 1024} GB agent box`, assignments: [{ path: 'memMb', value: memMb }],
              prices: [price(String(memMb / 2048), 'month', 'https://maritime.sh/docs/persistent-sandboxes')] })),
            { id: 'computer-4096', title: '2 vCPU / 4 GB computer', assignments: [{ path: 'memMb', value: 4096 }], prices: [price('0.12', 'hour', 'https://maritime.sh/docs/computers')] },
          ],
          location: [
            { id: 'account', title: 'Account placement', available: true, assignments: [] },
            { id: 'us', title: 'United States', available: false, unavailableReason: { code: 'maritime_region_selection_unavailable', status: 'US hosting is documented; the public create API exposes no region selector.' }, assignments: [] },
            { id: 'de', title: 'Germany', available: false, unavailableReason: { code: 'maritime_region_selection_unavailable', status: 'German hosting is documented; the public create API exposes no region selector.' }, assignments: [] },
          ], network: [], duration: [],
        }, constraints: [
          { when: { dimension: 'image', optionIds: ['agent-box'] }, requires: { dimension: 'size', optionIds: ['box-2048', 'box-4096', 'box-8192'] } },
          { when: { dimension: 'image', optionIds: ['linux-computer'] }, requires: { dimension: 'size', optionIds: ['computer-4096'] } },
        ] };
      } },
    acquire: { ...defaults, title: 'Create Maritime machine', dangerLevel: 'writesRemote', confirmation, inputSchema: ROLE_SCHEMAS.acquireInput, resultSchema: RECONCILIATION.result,
      async run(input, context) { if (!input.managedId) return { kind: 'rejected', code: 'invalid_request' };
        return runtime(context).acquire(input.launch, input.managedId); } },
    reconcile: { ...defaults, title: 'Recover Maritime machine', dangerLevel: 'safe', inputSchema: RECONCILIATION.input, resultSchema: RECONCILIATION.result,
      async run(input, context) { return runtime(context).recover('nativeOperation' in input ? input.nativeOperation
        : { kind: 'acquire', managedId: input.correlation.managedId, launch: input.correlation.launch }); } },
    bootstrap: { ...defaults, title: 'Prepare Maritime guest', dangerLevel: 'writesRemote', confirmation, inputSchema: ROLE_SCHEMAS.bootstrapInput, resultSchema: MachineProvisionerBootstrapCarrierV1Schema,
      async run(input, context) { return runtime(context).bootstrap(input.resource); } },
    inspect: { ...defaults, title: 'Inspect Maritime machine', dangerLevel: 'safe', inputSchema: ROLE_SCHEMAS.resourceInput, resultSchema: MachineProvisionerObservationV1Schema,
      async run(input, context) { try { return await runtime(context).inspect(input.resource); }
        catch (error) { return observeMachineProvisionerNativeRead(context.invokedAtMs, { kind: 'unknown', reason: errorCode(error) }); } } },
    power: { ...defaults, title: 'Sleep or wake Maritime machine', dangerLevel: 'writesRemote', confirmation, inputSchema: ROLE_SCHEMAS.powerInput, resultSchema: MachineProvisionerPowerResultV1Schema,
      async run(input, context) { try { return await runtime(context).power(input.resource, input.intent); }
        catch (error) { return { kind: 'unknown', code: errorCode(error) }; } } },
    destroy: { ...defaults, title: 'Delete Maritime machine', dangerLevel: 'destructive', confirmation, inputSchema: RECONCILIATION.destroyInput, resultSchema: RECONCILIATION.destroyResult,
      async run(input, context) { try { return await runtime(context).destroy(input); }
        catch (error) { return { kind: 'unknown', code: errorCode(error) }; } } },
    exec: { ...defaults, title: 'Execute Maritime guest command', dangerLevel: 'writesRemote', confirmation, inputSchema: ROLE_SCHEMAS.execInput, resultSchema: MachineProvisionerNativeExecResultV1Schema,
      async run(input, context) { return runtime(context).exec(input); } },
    'put-file': { ...defaults, title: 'Write Maritime guest file', dangerLevel: 'writesRemote', confirmation, inputSchema: ROLE_SCHEMAS.putFileInput, resultSchema: MachineProvisionerPutFileResultV1Schema,
      async run(input, context) { return runtime(context).putFile(input); } },
  },
});
export const PLUGIN_MANIFEST = PLUGIN.manifest;
export const activateAccount = (api: Parameters<typeof PLUGIN.activateAccount>[0]) => PLUGIN.activateAccount(api, { artifactId: 'account-runtime', exportName: 'activateAccount' });
