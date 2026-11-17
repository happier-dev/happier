import { definePlugin } from '@happier-dev/plugin-sdk';
import { defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';
import {
  defineMachineProvisionerSchemas, defineMachineProvisionerReconciliationSchemas,
  MachineProvisionerCheckResultV1Schema, MachineProvisionerOptionsResultV1Schema,
  MachineProvisionerBootstrapCarrierV1Schema, MachineProvisionerObservationV1Schema,
  MachineProvisionerPowerResultV1Schema, MachineProvisionerNativeExecResultV1Schema,
  MachineProvisionerPutFileResultV1Schema,
} from '@happier-dev/plugin-sdk/machine-provisioners';

export const contribution = { pluginId: 'test.account-machine-provider', localId: 'guest' } as const;
const native = defineProtocolObject({ name: defineProtocolString({ minLength: 1 }) }, { policy: 'closed' });
const roles = defineMachineProvisionerSchemas({ launch: native, resource: native });
const reconciliation = defineMachineProvisionerReconciliationSchemas({ launch: native, resource: native, nativeOperation: native });
const defaults = { surfaces: ['ui', 'cli', 'plugin'],
  execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } },
} as const;

/** An entirely local provider: its native resource is a name, with no vendor or executable boundary. */
const plugin = definePlugin({
  id: contribution.pluginId, version: '1.0.0', displayName: 'Account machine journey fixture',
  entrypoints: { daemon: './daemon.mjs' },
  machineProvisioners: { guest: {
    title: 'Local fixture guest', icon: 'machine', resourceKind: 'fixture-guest', schemaVersion: 1,
    launchSchema: native.jsonSchema, resourceSchema: native.jsonSchema, resourceIdPath: 'name',
    platforms: ['linux', 'darwin', 'win32'], prerequisites: [], enrollmentRole: 'sandbox',
    billing: { location: 'local', stoppedBilling: 'not-billed' }, retention: { supportedIntents: ['delete'] },
    actions: { check: 'check', options: 'options', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', power: 'power', destroy: 'destroy' },
    reconciliation: { action: 'reconcile', nativeOperationSchema: native.jsonSchema },
    bootstrapTransport: { kind: 'native', exec: 'exec', putFile: 'put-file' },
  } },
  actions: {
    check: { ...defaults, title: 'Check fixture', dangerLevel: 'safe', inputSchema: roles.checkInput,
      resultSchema: MachineProvisionerCheckResultV1Schema, run: async () => ({ available: true }) },
    options: { ...defaults, title: 'Fixture options', dangerLevel: 'safe', inputSchema: roles.checkInput,
      resultSchema: MachineProvisionerOptionsResultV1Schema, run: async () => ({ dimensions: {
        size: [{ id: 'local', title: 'Local guest', assignments: [{ path: 'name', value: 'journey-guest' }] }],
        image: [], location: [], network: [], duration: [],
      } }) },
    acquire: { ...defaults, title: 'Acquire fixture', dangerLevel: 'writesRemote',
      confirmation: { title: 'Create the local fixture guest?' }, inputSchema: roles.acquireInput,
      resultSchema: reconciliation.result, run: async input => ({ kind: 'bound', resource: {
        contributionRef: contribution, schemaVersion: 1, value: input.launch,
      } }) },
    reconcile: { ...defaults, title: 'Reconcile fixture', dangerLevel: 'safe', inputSchema: reconciliation.input,
      resultSchema: reconciliation.result, run: async input => ({ kind: 'bound', resource: {
        contributionRef: contribution, schemaVersion: 1,
        value: 'nativeOperation' in input ? input.nativeOperation : input.correlation.launch,
      } }) },
    bootstrap: { ...defaults, title: 'Bootstrap fixture', dangerLevel: 'writesRemote',
      confirmation: { title: 'Bootstrap the local fixture guest?' }, inputSchema: roles.bootstrapInput,
      resultSchema: MachineProvisionerBootstrapCarrierV1Schema, run: async () => ({ kind: 'native' as const, transport: {
        contributionRef: contribution, schemaVersion: 1 as const,
      } }) },
    inspect: { ...defaults, title: 'Inspect fixture', dangerLevel: 'safe', inputSchema: roles.resourceInput,
      resultSchema: MachineProvisionerObservationV1Schema,
      run: async (_input, context) => ({ observedAt: context.invokedAtMs, availability: 'present', storage: 'retained' }) },
    power: { ...defaults, title: 'Power fixture', dangerLevel: 'safe', inputSchema: roles.powerInput,
      resultSchema: MachineProvisionerPowerResultV1Schema, run: async () => ({ kind: 'confirmed' as const }) },
    destroy: { ...defaults, title: 'Delete fixture', dangerLevel: 'safe', inputSchema: reconciliation.destroyInput,
      resultSchema: reconciliation.destroyResult, run: async () => ({ kind: 'confirmed' as const }) },
    exec: { ...defaults, title: 'Execute fixture', dangerLevel: 'safe', inputSchema: roles.execInput,
      resultSchema: MachineProvisionerNativeExecResultV1Schema, run: async () => ({
        stdoutBase64: '', stderrBase64: '', stdoutTruncated: false, stderrTruncated: false,
        // Allocation is exercised here; the fixture deliberately cannot install a guest.
        termination: { observed: { kind: 'exit' as const, exitCode: 1 }, requestedBy: { kind: 'none' as const } },
      }) },
    'put-file': { ...defaults, title: 'Write fixture', dangerLevel: 'safe', inputSchema: roles.putFileInput,
      resultSchema: MachineProvisionerPutFileResultV1Schema, run: async () => ({ kind: 'confirmed' as const }) },
  },
});
export const manifest = plugin.manifest;
export const activateAccount = plugin.activateAccount;
