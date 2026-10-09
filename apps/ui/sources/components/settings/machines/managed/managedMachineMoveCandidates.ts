import type { ManagedMachineV1, ManagedControllerV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';
import type { ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { describeMachinePresenceLine } from '@/utils/sessions/machinePresenceLine';
import { createManagedProvisionerClient } from './managedProvisionerClient';

export type ManagedMachineMoveCandidate = Readonly<{ id: string; controller: ManagedControllerV1 | null; reachable: boolean }>;

export function currentManagedMoveController(machine: Machine | undefined, custodianAccountId: string): ManagedControllerV1 | null {
    if (!machine?.installationId || machine.revokedAt || machine.replacedByMachineId || machine.replacedAt
        || machine.access?.accessState !== 'ready' || machine.access.role !== 'manage'
        || machine.access.custodian.accountId !== custodianAccountId || !describeMachinePresenceLine(machine).online) return null;
    return { machineId: machine.id, installationId: machine.installationId };
}

/** Reachability comes from the current installation's qualified credential check, never presence alone. */
export async function readManagedMachineMoveCandidates(input: Readonly<{
    machine: ManagedMachineV1;
    machines: readonly Machine[];
    binding: ServerCredentialAccountScopeBinding;
    signal: AbortSignal;
    onApprovalPending: (approval: ActionApprovalRegistration) => void;
}>): Promise<readonly ManagedMachineMoveCandidate[]> {
    const { machine, binding, signal } = input;
    const current = () => !signal.aborted && binding.isCurrent();
    const client = createManagedProvisionerClient(binding.scope, machine.homeId);
    const options = { signal, onApprovalPending: input.onApprovalPending };
    return Promise.all(input.machines.map(async row => {
        const controller = currentManagedMoveController(row, machine.custodianAccountId);
        const unavailable = { id: row.id, controller, reachable: false };
        if (!controller || !current() || !machine.launch.credentials?.length) return unavailable;
        const catalog = await client.read('machines.provisioners.list', { homeId: machine.homeId, controller }, options);
        if (!current() || catalog.kind === 'failed') return unavailable;
        const provisioner = catalog.value.provisioners.find(candidate => sameStrictJsonValue(candidate.contribution, machine.launch.provider)
            && candidate.descriptor.schemaVersion === machine.launch.schemaVersion && candidate.descriptor.billing.location === 'cloud');
        if (!provisioner) return unavailable;
        const checked = await client.read('machines.provisioners.check', { homeId: machine.homeId, controller,
            contribution: machine.launch.provider, credentials: machine.launch.credentials.map(({ configurationRevision: _basis, ...credential }) => credential) }, options);
        return { id: row.id, controller, reachable: current() && checked.kind === 'succeeded' && checked.value.available };
    }));
}
