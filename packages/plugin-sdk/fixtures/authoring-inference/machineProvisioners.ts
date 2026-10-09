import { definePlugin } from '@happier-dev/plugin-sdk';
import { defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';
import { defineMachineProvisionerSchemas, defineMachineProvisionerReconciliationSchemas, prepareMachineProvisionerStoredSchemas, MachineProvisionerCheckResultV1Schema, MachineProvisionerBootstrapCarrierV1Schema, MachineProvisionerObservationV1Schema, MachineProvisionerPowerResultV1Schema, MachineProvisionerNativeExecResultV1Schema, MachineProvisionerPutFileResultV1Schema, MachineProvisionerOptionsResultV1Schema, type MachineProvisionerOptionsResultV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import type {
  MachineProvisionerBootstrapCarrierV1,
  MachineProvisionerCheckResultV1,
  MachineProvisionerNativeExecResultV1,
  MachineProvisionerObservationV1,
  MachineProvisionerPowerResultV1,
} from '@happier-dev/plugin-sdk/machine-provisioners';

const native = defineProtocolObject({ name: defineProtocolString({ minLength: 1 }) }, { policy: 'closed' });
const roles = defineMachineProvisionerSchemas({ launch: native, resource: native });
const nativeOperation = defineProtocolObject({ claimId: defineProtocolString({ minLength: 1 }) }, { policy: 'closed' });
const reconciliation = defineMachineProvisionerReconciliationSchemas({ launch: native, resource: native, nativeOperation });
export type MachineProvisionerAuthorAcquireInput = Parameters<typeof roles.acquireInput.parse>[0];
export type MachineProvisionerAuthorBootstrapInput = Parameters<typeof roles.bootstrapInput.parse>[0];
export const prepareMachineProvisionerAuthorStoredReaders = () => prepareMachineProvisionerStoredSchemas({ launch: native, resource: native, nativeOperation });
export const machineProvisionerAuthorOptions = { choices: [{ id: 'small-linux', title: 'Small Linux', launch: { name: 'guest' },
  nativeFacts: { size: { id: 'small', title: 'Small', cpuCores: 0.5 }, image: { id: 'linux', title: 'Linux' } } }] } satisfies MachineProvisionerOptionsResultV1;
function createAuthorFixture(repairNeeded = false) {
  let repaired = !repairNeeded;
  const repairInput = defineProtocolObject({ machineName: defineProtocolString({ minLength: 1 }) }, { policy: 'closed' });
  return definePlugin({
    id: 'examples.machine-provisioner', version: '1.0.0',
    machineProvisioners: { guest: {
      title: 'Guest', icon: 'machine', resourceKind: 'vm', schemaVersion: 1,
      launchSchema: native.jsonSchema, resourceSchema: native.jsonSchema,
      platforms: ['linux'], prerequisites: [{ kind: 'systemTool', id: 'fixture-tool' }],
      billing: { location: 'local', stoppedBilling: 'not-billed' }, retention: { supportedIntents: ['delete'], finiteOnly: true },
      actions: { check: 'check', options: 'options', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', destroy: 'destroy' },
      bootstrapTransport: { kind: 'native', exec: 'exec', putFile: 'put-file' },
      reconciliation: { nativeOperationSchema: nativeOperation.jsonSchema, action: 'reconcile' },
    } },
    systemTools: { 'fixture-tool': { title: 'Fixture setup', executableNames: ['fixture-tool'] } },
    actions: {
      options: { title: 'Native options', execution: { target: 'daemon' }, surfaces: ['plugin'], dangerLevel: 'safe',
        inputSchema: roles.checkInput, resultSchema: MachineProvisionerOptionsResultV1Schema, run: async () => machineProvisionerAuthorOptions },
      check: { title: 'Check', execution: { target: 'daemon' }, surfaces: ['plugin'], dangerLevel: 'safe',
        inputSchema: roles.checkInput, resultSchema: MachineProvisionerCheckResultV1Schema, run: async (): Promise<MachineProvisionerCheckResultV1> => repaired ? { available: true } : {
          available: false, prerequisites: [{ requirement: { kind: 'systemTool', id: { pluginId: 'examples.machine-provisioner', localId: 'fixture-tool' } },
            status: 'unavailable', repairAction: { action: { pluginId: 'examples.machine-provisioner', localId: 'repair' }, input: { machineName: 'guest' } } }],
        } },
      repair: { title: 'Repair fixture setup', execution: { target: 'daemon' }, surfaces: ['plugin'], dangerLevel: 'writesLocal',
        confirmation: { title: 'Repair this setup?' }, inputSchema: repairInput, resultSchema: native,
        // This fixture proves the public Action contract, not a native installer.
        run: async input => { repaired = true; return { name: input.machineName }; } },
      acquire: { title: 'Acquire', execution: { target: 'daemon' }, surfaces: ['plugin'], dangerLevel: 'safe',
        inputSchema: roles.acquireInput, resultSchema: reconciliation.result, run: async input => input.launch.name === 'archived-preset'
          ? ({ kind: 'rejected', code: 'preset_archived' })
          : input.launch.name === 'pending-claim'
            ? ({ kind: 'pending', nativeOperationRef: { contributionRef: { pluginId: 'examples.machine-provisioner', localId: 'guest' }, schemaVersion: 1, value: { claimId: 'pending-claim' } } })
            : ({ kind: 'bound', resource: { contributionRef: { pluginId: 'examples.machine-provisioner', localId: 'guest' }, schemaVersion: 1, value: input.launch } }) },
      reconcile: { title: 'Reconcile retained claim', execution: { target: 'daemon' }, surfaces: ['plugin'], dangerLevel: 'safe',
        inputSchema: reconciliation.input, resultSchema: reconciliation.result,
        run: async input => ({ kind: 'bound', resource: { contributionRef: { pluginId: 'examples.machine-provisioner', localId: 'guest' }, schemaVersion: 1,
          value: { name: 'nativeOperation' in input ? input.nativeOperation.claimId : input.correlation.launch.name } } }) },
      bootstrap: { title: 'Bootstrap', execution: { target: 'daemon' }, surfaces: ['plugin'], dangerLevel: 'safe',
        inputSchema: roles.bootstrapInput, resultSchema: MachineProvisionerBootstrapCarrierV1Schema,
        run: async (): Promise<MachineProvisionerBootstrapCarrierV1> => ({ kind: 'native', transport: { contributionRef: { pluginId: 'examples.machine-provisioner', localId: 'guest' }, schemaVersion: 1 } }) },
      inspect: { title: 'Inspect', execution: { target: 'daemon' }, surfaces: ['plugin'], dangerLevel: 'safe',
        inputSchema: roles.resourceInput, resultSchema: MachineProvisionerObservationV1Schema, run: async (): Promise<MachineProvisionerObservationV1> => ({ observedAt: 0, availability: 'present', storage: 'retained', daemon: 'disconnected' }) },
      destroy: { title: 'Destroy', execution: { target: 'daemon' }, surfaces: ['plugin'], dangerLevel: 'safe',
        inputSchema: reconciliation.destroyInput, resultSchema: MachineProvisionerPowerResultV1Schema, run: async (): Promise<MachineProvisionerPowerResultV1> => ({ kind: 'confirmed' }) },
      exec: { title: 'Exec', execution: { target: 'daemon' }, surfaces: ['plugin'], dangerLevel: 'safe', inputSchema: roles.execInput, resultSchema: MachineProvisionerNativeExecResultV1Schema,
        run: async (): Promise<MachineProvisionerNativeExecResultV1> => ({ termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } }, stdoutBase64: '', stderrBase64: '', stdoutTruncated: false, stderrTruncated: false }) },
      'put-file': { title: 'Put file', execution: { target: 'daemon' }, surfaces: ['plugin'], dangerLevel: 'safe', inputSchema: roles.putFileInput, resultSchema: MachineProvisionerPutFileResultV1Schema, run: async (): Promise<MachineProvisionerPowerResultV1> => ({ kind: 'confirmed' }) },
    },
  });
}
export const machineProvisionerAuthorFixture = createAuthorFixture();
export const createMachineProvisionerRepairAuthorFixture = () => createAuthorFixture(true);
