import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';

import type { ManagedMachineInventoryEntry } from './useManagedMachineInventory';

type ReadStatus = ManagedMachineInventoryEntry['status'] | undefined;

export type ManagedMachineDetailReadPresentation = Readonly<{
    headerMachine: ManagedMachineV1 | undefined;
    missing: boolean;
}>;

export type ManagedMachineApprovalPresentation = Readonly<{
    kind: 'delete' | 'generic';
    artifactId: string;
}> | null;

export function projectManagedMachineDetailRead(input: Readonly<{
    managedId: string;
    detailMachine?: ManagedMachineV1;
    detailStatus: ReadStatus;
    admittedMachine?: ManagedMachineV1;
}>): ManagedMachineDetailReadPresentation {
    const admittedMachine = input.admittedMachine?.id === input.managedId ? input.admittedMachine : undefined;
    return {
        headerMachine: input.detailStatus === 'denied' || input.detailStatus === 'missing' ? undefined : input.detailMachine ?? admittedMachine,
        missing: input.detailStatus === 'missing',
    };
}

export function projectManagedMachineApproval(input: Readonly<{
    approvalId: string | null;
    submittedDeleteApprovalId: string | null;
    storedDeleteApprovalId: string | null;
}>): ManagedMachineApprovalPresentation {
    if (input.storedDeleteApprovalId) return { kind: 'delete' as const, artifactId: input.storedDeleteApprovalId };
    if (input.approvalId && input.approvalId === input.submittedDeleteApprovalId) {
        return { kind: 'delete' as const, artifactId: input.approvalId };
    }
    return input.approvalId ? { kind: 'generic' as const, artifactId: input.approvalId } : null;
}

export function shouldReleaseManagedMachinePendingOnApproval(actionId: string): boolean {
    return actionId === 'machines.managed.delete';
}
