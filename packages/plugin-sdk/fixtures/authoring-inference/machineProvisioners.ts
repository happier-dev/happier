import { definePlugin } from '@happier-dev/plugin-sdk';
import { defineProtocolObject, defineProtocolString, type ProtocolSchemaOutput } from '@happier-dev/plugin-sdk/protocol';
import { classifyManagedMachineAllocationV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import * as machineProvisioners from '@happier-dev/plugin-sdk/machine-provisioners';
import type { PluginUiHostApi } from '@happier-dev/plugin-sdk/ui';
import { defineMachineProvisionerSchemas, defineMachineProvisionerReconciliationSchemas, prepareMachineProvisionerStoredSchemas, projectMachineProvisionerSelectionV1, MachineProvisionerCheckResultV1Schema, MachineProvisionerBootstrapCarrierV1Schema, MachineProvisionerObservationV1Schema, MachineProvisionerNativeExecResultV1Schema, MachineProvisionerPutFileResultV1Schema, MachineProvisionerOptionsResultV1Schema, type MachineProvisionerOptionsResultV1, type MachineProvisionerSelectionV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import type {
  MachineProvisionerBootstrapCarrierV1,
  MachineProvisionerCheckResultV1,
  MachineProvisionerDestroyResultV1,
  MachineProvisionerNativeExecResultV1,
  MachineProvisionerNativeOptionFactsV1,
  MachineProvisionerObservationV1,
  MachineProvisionerPowerResultV1,
} from '@happier-dev/plugin-sdk/machine-provisioners';
import { MachineProvisionerPowerResultV1Schema } from '@happier-dev/plugin-sdk/machine-provisioners';

const native = defineProtocolObject({ name: defineProtocolString({ minLength: 1 }) }, { policy: 'closed' });
/** The host has already correlated the supplied receipt; no receipt means no claim of active creation. */
export function projectMachineProvisionerAuthorCreation(...input: Parameters<typeof classifyManagedMachineAllocationV1>) {
  const allocation = classifyManagedMachineAllocationV1(...input);
  return { allocation, showProgress: allocation === 'creating', requiresInspection: allocation === 'may-exist' };
}
/** The same admitted active inventory is read and observed; a watch is an invalidation signal, not row delivery. */
export async function observeMachineProvisionerAuthorInventory(host: Pick<PluginUiHostApi, 'readResource' | 'watchResource'>,
  homeId: string, listener: Parameters<PluginUiHostApi['watchResource']>[1], signal?: AbortSignal) {
  const reference = { hostRead: 'machines.managed.list', input: { homeId } } as const;
  const observation = await host.watchResource(reference, listener, { signal });
  try { return { content: await host.readResource(reference, { signal }), observation }; }
  catch (error) { observation.dispose(); throw error; }
}
const roles = defineMachineProvisionerSchemas({ launch: native, resource: native });
const nativeOperation = defineProtocolObject({ claimId: defineProtocolString({ minLength: 1 }) }, { policy: 'closed' });
const reconciliation = defineMachineProvisionerReconciliationSchemas({ launch: native, resource: native, nativeOperation });
/** A native builder receives the validated launch and the supplier's portable CLI input. */
export function createMachinePresetPreparationInputAuthorFixture() {
  return definePlugin({
    id: 'examples.machine-preparation-input', version: '1.0.0',
    actions: { build: {
      title: 'Build prepared guest', execution: { target: 'daemon' }, surfaces: ['plugin'], dangerLevel: 'safe',
      inputSchema: machineProvisioners.ManagedMachinePresetPreparationBuildInputV1Schema,
      resultSchema: machineProvisioners.ManagedGuestCliBuildInputV1Schema,
      run: async input => input.cli,
    } },
  });
}
export type MachineProvisionerAuthorAcquireInput = Parameters<typeof roles.acquireInput.parse>[0];
export type MachineProvisionerAuthorBootstrapInput = Parameters<typeof roles.bootstrapInput.parse>[0];
export const prepareMachineProvisionerAuthorStoredReaders = () => prepareMachineProvisionerStoredSchemas({ launch: native, resource: native, nativeOperation });
export const machineProvisionerAuthorNativeFacts = {
  size: { id: 'small', title: 'Small', cpuCores: 0.5 },
  image: { id: 'linux', title: 'Linux', description: 'Linux guest image',
    preview: { resource: { pluginId: 'examples.machine-provisioner', localId: 'linux-preview' }, accessibilityLabel: 'Linux desktop' } },
  location: { id: 'hel1', title: 'Helsinki', countryCode: 'FI' },
} satisfies MachineProvisionerNativeOptionFactsV1;
export const machineProvisionerAuthorOptions = { base: { launch: {} }, dimensions: {
  size: [
    { id: 'small', title: 'Small', assignments: [{ path: 'name', value: 'guest' }], nativeFacts: { size: machineProvisionerAuthorNativeFacts.size } },
    { id: 'archived', title: 'Archived preset', assignments: [{ path: 'name', value: 'archived-preset' }] },
    { id: 'unknown-power', title: 'Lost start reply', assignments: [{ path: 'name', value: 'accepted-start' }] },
    { id: 'missing-power', title: 'Missing machine', assignments: [{ path: 'name', value: 'missing-power' }] },
    { id: 'refused-power', title: 'Unavailable start', assignments: [{ path: 'name', value: 'refused-power' }] },
  ],
  image: [
    { id: 'linux', title: 'Linux', assignments: [], guestPlatform: 'linux', nativeFacts: { image: machineProvisionerAuthorNativeFacts.image } },
    { id: 'sandbox-linux', title: 'Linux sandbox', assignments: [], guestPlatform: 'linux', enrollmentRole: 'sandbox',
      nativeFacts: { image: { id: 'sandbox-linux', title: 'Linux sandbox' } } },
  ],
  location: [{ id: 'hel1', title: 'Helsinki', assignments: [], nativeFacts: { location: machineProvisionerAuthorNativeFacts.location } }],
  network: [], duration: [],
} } satisfies MachineProvisionerOptionsResultV1;
export const projectMachineProvisionerAuthorSelection = (options: MachineProvisionerOptionsResultV1, selection: MachineProvisionerSelectionV1) =>
  projectMachineProvisionerSelectionV1({ options, selection, launchSchema: native.jsonSchema });
/** A native refusal keeps its own code/copy and points to the field the person can change. */
export const machineProvisionerAuthorRefusedOptions = {
  ...machineProvisionerAuthorOptions,
  base: { launch: {}, available: false, unavailableReason: {
    code: 'native_guest_unavailable', status: { key: 'guest.unavailable', fallback: 'Choose another guest.' }, fieldPath: 'name',
  } },
} satisfies MachineProvisionerOptionsResultV1;
function createAuthorFixture(repairNeeded = false, includePreparation = false) {
  let repaired = !repairNeeded;
  const repairInput = defineProtocolObject({ machineName: defineProtocolString({ minLength: 1 }) }, { policy: 'closed' });
  const preparationArtifact = defineProtocolObject({ launch: native }, { policy: 'closed' });
  const preparation = machineProvisioners.defineMachineProvisionerPreparationSchemas({
    input: native, artifact: preparationArtifact, nativeOperation,
  });
  return definePlugin({
    id: 'examples.machine-provisioner', version: '1.0.0',
    machineProvisioners: { guest: {
      title: 'Guest', icon: 'machine', resourceKind: 'vm', schemaVersion: 1,
      launchSchema: native.jsonSchema, resourceSchema: native.jsonSchema,
      resourceIdPath: 'name',
      enrollmentRole: 'server',
      // The native connection purpose is waived only for the explicitly local
      // launch; absent name selectors keep the purpose required.
      credentialPurposeRequirements: [{ purpose: 'native-connection', optionalWhen: { op: 'eq', path: 'name', value: 'local' } }],
      // Supported controller OS; the selected image declares the guest OS.
      platforms: ['linux'], prerequisites: [{ kind: 'managedDependency', id: 'fixture-tool' }],
      sessionPlacement: { kind: 'controller-local', supportsAgentNativeSandbox: true,
        when: { op: 'eq', path: 'name', value: 'local' } },
      billing: { location: 'local', stoppedBilling: 'not-billed' }, retention: { supportedIntents: ['start', 'stop', 'delete'], finiteOnly: true },
      actions: { check: 'check', options: 'options', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', power: 'power', destroy: 'destroy' },
      bootstrapTransport: { kind: 'native', exec: 'exec', putFile: 'put-file' },
      reconciliation: { nativeOperationSchema: nativeOperation.jsonSchema, action: 'reconcile' },
      ...(includePreparation ? { preparation: {
        inputSchema: native.jsonSchema, artifactSchema: preparationArtifact.jsonSchema, nativeOperationSchema: nativeOperation.jsonSchema,
        artifactLaunchPath: 'launch',
        actions: { build: 'prepare-build', inspect: 'prepare-inspect', destroy: 'prepare-destroy' },
      } } : {}),
    } },
    resources: { 'linux-preview': { kind: 'asset', path: 'assets/linux.png', contentType: 'image/png' } },
    managedDependencies: { 'fixture-tool': { title: 'Fixture setup', executable: 'fixture-tool',
      sources: [{ kind: 'system', executableNames: ['fixture-tool'], versionArguments: ['--version'] }] } },
    actions: {
      // Actions exist independently; only the optional descriptor assigns their provider roles.
      'prepare-build': { title: 'Prepare', execution: { target: 'daemon' as const }, surfaces: ['plugin' as const], dangerLevel: 'safe' as const,
        inputSchema: preparation.buildInput, resultSchema: preparation.buildResult,
        run: async (input: ProtocolSchemaOutput<typeof preparation.buildInput>) => ({ kind: 'unknown' as const, code: 'native_reply_lost', nativeOperationRef: {
          contributionRef: { pluginId: 'examples.machine-provisioner', localId: 'guest' }, schemaVersion: 1, value: { claimId: input.operationId },
        } }) },
      'prepare-inspect': { title: 'Inspect preparation', execution: { target: 'daemon' as const }, surfaces: ['plugin' as const], dangerLevel: 'safe' as const,
        inputSchema: preparation.inspectInput, resultSchema: preparation.inspectResult,
        run: async (input: ProtocolSchemaOutput<typeof preparation.inspectInput>) => ({ kind: 'ready' as const, artifact: {
          contributionRef: { pluginId: 'examples.machine-provisioner', localId: 'guest' }, schemaVersion: 1,
          value: { launch: { name: 'nativeOperation' in input ? input.nativeOperation.value.claimId : input.operationId } },
        } }) },
      'prepare-destroy': { title: 'Delete preparation', execution: { target: 'daemon' as const }, surfaces: ['plugin' as const], dangerLevel: 'safe' as const,
        inputSchema: preparation.destroyInput, resultSchema: preparation.destroyResult,
        run: async () => ({ kind: 'confirmed' as const }) },
      options: { title: 'Native options', execution: { target: 'daemon' }, surfaces: ['plugin'], dangerLevel: 'safe',
        inputSchema: roles.checkInput, resultSchema: MachineProvisionerOptionsResultV1Schema, run: async () => machineProvisionerAuthorOptions },
      check: { title: 'Check', execution: { target: 'daemon' }, surfaces: ['plugin'], dangerLevel: 'safe',
        inputSchema: roles.checkInput, resultSchema: MachineProvisionerCheckResultV1Schema, run: async (): Promise<MachineProvisionerCheckResultV1> => repaired ? { available: true } : {
            available: false, prerequisites: [{ requirement: { kind: 'managedDependency', id: { pluginId: 'examples.machine-provisioner', localId: 'fixture-tool' } },
            status: 'unavailable', repairAction: { action: { pluginId: 'examples.machine-provisioner', localId: 'repair' }, input: { machineName: 'guest' } } }],
        } },
      repair: { title: 'Repair fixture setup', execution: { target: 'daemon' }, surfaces: ['ui', 'agent', 'mcp', 'cli', 'plugin'], dangerLevel: 'writesLocal',
        confirmation: { title: 'Repair this setup?' }, inputSchema: repairInput, resultSchema: native,
        // This fixture proves the public Action contract, not a native installer.
        run: async input => { repaired = true; return { name: input.machineName }; } },
      acquire: { title: 'Acquire', execution: { target: 'daemon' }, surfaces: ['plugin'], dangerLevel: 'safe',
        inputSchema: roles.acquireInput, resultSchema: reconciliation.result, run: async input => input.launch.name === 'archived-preset'
          ? ({ kind: 'rejected', code: 'preset_archived' })
          : input.launch.name === 'pending-claim' || input.launch.name === 'lost-response'
            ? ({ kind: 'pending', nativeOperationRef: { contributionRef: { pluginId: 'examples.machine-provisioner', localId: 'guest' }, schemaVersion: 1, value: { claimId: input.launch.name } } })
            : ({ kind: 'bound', resource: { contributionRef: { pluginId: 'examples.machine-provisioner', localId: 'guest' }, schemaVersion: 1, value: input.launch },
              // Stand-in for an accepted native start, never a retained-state inference.
              ...(input.launch.name === 'accepted-start' ? { startPending: true as const } : {}) }) },
      reconcile: { title: 'Reconcile retained claim', execution: { target: 'daemon' }, surfaces: ['plugin'], dangerLevel: 'safe',
        inputSchema: reconciliation.input, resultSchema: reconciliation.result,
        run: async input => {
          const claimId = 'nativeOperation' in input ? input.nativeOperation.claimId : input.correlation.launch.name;
          // Stand-in for a read-only native lookup: the lost reply has no
          // recoverable identity. Never replay acquire to manufacture one.
          if (claimId === 'lost-response') return { kind: 'unknown', recovery: {
            reference: 'nativeOperation' in input ? claimId : input.correlation.managedId,
            reason: 'native_identity_unavailable',
          } };
          return { kind: 'bound', resource: { contributionRef: { pluginId: 'examples.machine-provisioner', localId: 'guest' }, schemaVersion: 1,
            value: { name: claimId } } };
        } },
      bootstrap: { title: 'Bootstrap', execution: { target: 'daemon' }, surfaces: ['plugin'], dangerLevel: 'safe',
        inputSchema: roles.bootstrapInput, resultSchema: MachineProvisionerBootstrapCarrierV1Schema,
        run: async (): Promise<MachineProvisionerBootstrapCarrierV1> => ({ kind: 'native', transport: { contributionRef: { pluginId: 'examples.machine-provisioner', localId: 'guest' }, schemaVersion: 1 } }) },
      inspect: { title: 'Inspect', execution: { target: 'daemon' }, surfaces: ['plugin'], dangerLevel: 'safe',
        inputSchema: roles.resourceInput, resultSchema: MachineProvisionerObservationV1Schema,
        run: async (input): Promise<MachineProvisionerObservationV1> => input.resource.name === 'missing-power'
          ? { observedAt: 0, availability: 'absent', storage: 'lost' }
          : ({ observedAt: 0, availability: 'present', storage: 'retained',
            ...(input.resource.name === 'accepted-start' ? { power: 'running' as const } : {}) }) },
      power: { title: 'Power', execution: { target: 'daemon' }, surfaces: ['plugin'], dangerLevel: 'safe',
        inputSchema: roles.powerInput, resultSchema: MachineProvisionerPowerResultV1Schema,
        // Stand-ins for native outcomes. A lost reply is resolved by Inspect,
        // never by claiming success or submitting the mutation again.
        run: async (input): Promise<MachineProvisionerPowerResultV1> => input.resource.name === 'refused-power'
          ? { kind: 'refused', code: 'native_route_unavailable' }
          : input.resource.name === 'accepted-start' || input.resource.name === 'missing-power'
            ? { kind: 'unknown', code: 'native_reply_lost' } : { kind: 'confirmed' } },
      destroy: { title: 'Destroy', execution: { target: 'daemon' }, surfaces: ['plugin'], dangerLevel: 'safe',
        inputSchema: reconciliation.destroyInput, resultSchema: reconciliation.destroyResult,
        run: async (input): Promise<MachineProvisionerDestroyResultV1<ProtocolSchemaOutput<typeof nativeOperation>>> => ({ kind: 'resource' in input && input.resource.name === 'pending-delete' ? 'pending' : 'confirmed' }) },
      exec: { title: 'Exec', execution: { target: 'daemon' }, surfaces: ['plugin'], dangerLevel: 'safe', inputSchema: roles.execInput, resultSchema: MachineProvisionerNativeExecResultV1Schema,
        run: async (): Promise<MachineProvisionerNativeExecResultV1> => ({ termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } }, stdoutBase64: '', stderrBase64: '', stdoutTruncated: false, stderrTruncated: false }) },
      'put-file': { title: 'Put file', execution: { target: 'daemon' }, surfaces: ['plugin'], dangerLevel: 'safe', inputSchema: roles.putFileInput, resultSchema: MachineProvisionerPutFileResultV1Schema, run: async (): Promise<MachineProvisionerPowerResultV1> => ({ kind: 'confirmed' }) },
    },
  });
}
export const machineProvisionerAuthorFixture = createAuthorFixture();
export const createMachineProvisionerRepairAuthorFixture = () => createAuthorFixture(true);
export const createMachineProvisionerPreparationAuthorFixture = () => createAuthorFixture(false, true);
