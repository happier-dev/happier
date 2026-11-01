import type { ExternalActionExecutionAuthorizationBindingV1, ExternalActionRequestEnvelope } from '@happier-dev/protocol/actions/externalActionApi';
import { ExternalActionManagedControlAdmissionV1Schema, projectExternalActionManagedAdmissionV1, type ExternalActionManagedControlAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { ManagedMachineError, readManagedMachineInTx, sameManagedInput } from '@/app/machines/managed/managedRows';
import type { Tx } from '@/storage/inTx';
import { resolveSignedManagedAccountExecutorInTx } from '@/app/machines/managed/managedRequestAuthority';

/** Home reads the same closed control projection for plain and encrypted roots. */
export function readExternalActionManagedControlAdmission(actionId: string, envelope: ExternalActionRequestEnvelope) {
    if (actionId !== 'machines.managed.power.set' && actionId !== 'machines.managed.delete') return undefined;
    const projection = envelope.v === 1 ? projectExternalActionManagedAdmissionV1(actionId, envelope.input) : envelope.managedAdmission;
    const parsed = ExternalActionManagedControlAdmissionV1Schema.safeParse(projection);
    if (!parsed.success || parsed.data.actionId !== actionId || envelope.managedAdmission !== undefined
        && !sameManagedInput(parsed.data, envelope.managedAdmission)) throw new ManagedMachineError('invalid_request');
    return parsed.data;
}

/** Qualify once at the existing root issuer; later calls consume its signed owner fact. */
export async function qualifyExternalActionManagedAccountExecutorInTx(reader: Tx,
    binding: Pick<ExternalActionExecutionAuthorizationBindingV1, 'accountId' | 'machineId' | 'serverIdentityId'>,
    admission: ExternalActionManagedControlAdmissionV1): Promise<ExternalActionExecutionAuthorizationBindingV1['managedAccountExecutor']> {
    const row = await readManagedMachineInTx(reader, admission.input);
    if (row.controllerMachineId !== null) return undefined;
    if (row.homeId !== binding.serverIdentityId || row.custodianAccountId !== binding.accountId || !row.enrolledMachineId) {
        throw new ManagedMachineError('permission_denied');
    }
    const machine = await reader.machine.findUnique({ where: { id: binding.machineId },
        select: { id: true, accountId: true, kind: true, managedResource: { select: { id: true } } } });
    if (!await resolveSignedManagedAccountExecutorInTx(reader, machine, { custodianAccountId: row.custodianAccountId,
        managedId: row.id, enrolledMachineId: row.enrolledMachineId })) throw new ManagedMachineError('permission_denied');
    return { enrolledMachineId: row.enrolledMachineId };
}
