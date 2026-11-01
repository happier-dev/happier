import type { ManagedControllerCurrentnessV1, ManagedMachineActionIdV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ManagedMachineV1Schema, type ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { AcquireResultV1Schema, type AcquireResultV1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import type { MachineProvisionerContributionV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { compilePluginJsonSchema } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/actions/protocol-composable-schema';
import { ManagedMachineControllerError } from './controllerErrors.js';

export type CapturedManagedNativeIdentity = Readonly<{
    kind: 'acquire' | 'rebuild' | 'pending-acquire';
    machine: ManagedMachineV1;
    validateResource: ReturnType<typeof compilePluginJsonSchema>;
    validateNativeOperation?: ReturnType<typeof compilePluginJsonSchema>;
}>;

/** The submitted Home row owns which native identity can later be reported. */
export function captureManagedSubmittedNativeIdentity(input: Readonly<{
    kind: 'acquire' | 'rebuild'; machine: ManagedMachineV1; provisioner: MachineProvisionerContributionV1;
}>): CapturedManagedNativeIdentity {
    return { kind: input.kind, machine: ManagedMachineV1Schema.parse(input.machine),
        validateResource: compilePluginJsonSchema(input.provisioner.resourceSchema),
        ...(input.provisioner.reconciliation ? {
            validateNativeOperation: compilePluginJsonSchema(input.provisioner.reconciliation.nativeOperationSchema),
        } : {}) };
}

/** Capture the existing paid handle immediately before its safe reconciliation. */
export function captureManagedPendingNativeIdentity(input: Readonly<{
    machine: ManagedMachineV1; current: ManagedMachineV1; provisioner?: MachineProvisionerContributionV1;
}>): CapturedManagedNativeIdentity {
    const { machine, current, provisioner } = input;
    if (!provisioner?.reconciliation) throw new ManagedMachineControllerError('provider_unavailable');
    const retained = current.nativeOperationRef;
    if (current.allocation !== 'may-exist' || current.resource
        || current.custodianAccountId !== machine.custodianAccountId || !pluginJsonValuesEqual(current.launch, machine.launch)
        || (retained && (retained.contributionRef.pluginId !== current.launch.provider.pluginId
            || retained.contributionRef.localId !== current.launch.provider.localId
            || retained.schemaVersion !== current.launch.schemaVersion
            || !compilePluginJsonSchema(provisioner.reconciliation.nativeOperationSchema)(retained.value)))) {
        throw new ManagedMachineControllerError('resource_mismatch');
    }
    return { kind: 'pending-acquire', machine: current, validateResource: compilePluginJsonSchema(provisioner.resourceSchema) };
}

/** Factual reports keep the issued identity, not authority to issue another effect. */
export function readManagedIssuedNativeFact(input: Readonly<{
    machine: ManagedMachineV1;
    fact: Extract<AcquireResultV1, { kind: 'bound' | 'pending' }>;
    action: ManagedMachineActionIdV1;
    kind: CapturedManagedNativeIdentity['kind'];
    captured?: CapturedManagedNativeIdentity;
    correlation(machine: ManagedMachineV1): ManagedControllerCurrentnessV1;
}>): Readonly<{ result: Extract<AcquireResultV1, { kind: 'bound' | 'pending' }>; captured: CapturedManagedNativeIdentity }> {
    const { machine, action, kind, captured, correlation } = input;
    const result = AcquireResultV1Schema.parse(input.fact);
    if (result.kind !== 'bound' && result.kind !== 'pending') throw new ManagedMachineControllerError('resource_mismatch');
    const identity = result.kind === 'bound' ? result.resource : result.nativeOperationRef;
    if (!captured || captured.kind !== kind || (kind === 'rebuild'
        ? action !== 'machines.managed.rebuild' : action !== 'machines.managed.acquire' && action !== 'machines.managed.bootstrap.retry')
        || (result.kind === 'pending' && kind !== 'acquire')
        || !pluginJsonValuesEqual(correlation(machine), correlation(captured.machine))
        || !pluginJsonValuesEqual(machine.launch, captured.machine.launch)
        || (kind === 'pending-acquire' && !pluginJsonValuesEqual(machine.nativeOperationRef ?? null, captured.machine.nativeOperationRef ?? null))
        || identity.contributionRef.pluginId !== captured.machine.launch.provider.pluginId
        || identity.contributionRef.localId !== captured.machine.launch.provider.localId
        || identity.schemaVersion !== captured.machine.launch.schemaVersion
        || !(result.kind === 'bound' ? captured.validateResource(identity.value)
            : captured.validateNativeOperation?.(identity.value))) throw new ManagedMachineControllerError('resource_mismatch');
    return { result, captured };
}
