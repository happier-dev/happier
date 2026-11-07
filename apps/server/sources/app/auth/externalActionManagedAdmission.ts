import { resolveManagedNativeCredentialActionMachineAdmissionInTx, isExternalActionManagedResourceAction, readExternalActionManagedRecoveryAdmission, type ExternalActionManagedAdmissionContext } from './externalActionManagedNativeAdmission';
export { isExternalActionManagedResourceAction, readExternalActionManagedRecoveryAdmission, type ExternalActionManagedAdmissionContext } from './externalActionManagedNativeAdmission';
import type { ExternalActionExecutionAuthorizationBindingV1, ExternalActionRequestEnvelope } from '@happier-dev/protocol/actions/externalActionApi';
import { ExternalActionManagedRecoveryAdmissionV1Schema, ExternalActionManagedControlAdmissionV1Schema, projectExternalActionManagedAdmissionV1,
    type ExternalActionManagedControlAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { resolveManagedAcquireReviewV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { MachineAdmission } from '@happier-dev/protocol/machines/machineAccessV1';
import { resolveMachineAdmissionInTx } from '@/app/machines/machineAccess';
import { resolveMachinePresetForAcquireInTx } from '@/app/machines/managed/machinePresetService';
import { isManagedMachineCreator } from '@/app/machines/managed/managedRead';
import { ManagedMachineError, readManagedMachineInTx, readManagedAdmissionState, sameManagedInput, resolveManagedMachineRole, type StoredManagedMachine } from '@/app/machines/managed/managedRows';
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





/** A creation root addresses its retained allocation, never its controller's other guests. */
export async function readExternalActionManagedAcquireResourceInTx(reader: Tx,
    binding: ExternalActionExecutionAuthorizationBindingV1): Promise<StoredManagedMachine | null> {
    if (binding.actionId !== 'machines.managed.acquire') return null;
    const row = await reader.managedMachine.findUnique({ where: { homeId_admittedActionRequestId: {
        homeId: binding.serverIdentityId, admittedActionRequestId: binding.requestId,
    } } });
    if (!row || row.custodianAccountId !== binding.custodianAccountId
        || (row.controllerMachineId === null ? resolveManagedMachineRole(row, binding.accountId) !== 'manage'
            : row.controllerMachineId !== binding.machineId || row.controllerInstallationId !== binding.installationId)
        || !(isManagedMachineCreator(row, binding.accountId)
            || readManagedAdmissionState(row.admittedInput).enrollmentAccountId === undefined
                && binding.accountId === row.custodianAccountId)) return null;
    return row;
}

/** The existing header carries exact creation recovery and its operation observation. */


/** Home and the receiving daemon consume the same public compute projection. */
export function readExternalActionManagedAcquireAdmission(envelope: ExternalActionRequestEnvelope) {
    try {
        const projected = envelope.v === 1 ? projectExternalActionManagedAdmissionV1('machines.managed.acquire', envelope.input)
            : envelope.managedAdmission;
        if (!projected || projected.actionId !== 'machines.managed.acquire'
            || envelope.managedAdmission !== undefined && !sameManagedInput(envelope.managedAdmission, projected)) return null;
        return projected;
    } catch { return null; }
}

/** Scoped Action authority never creates Machine Use/Manage or unsigned RPC access. */
export async function resolveManagedActionMachineAdmissionInTx(reader: Tx,
    input: ExternalActionManagedAdmissionContext & Readonly<{
        actorAccountId: string; machineId: string; actionId: string; requireOnline?: boolean;
    }>): Promise<MachineAdmission> {
    const denied = { kind: 'denied', code: 'access_denied' } as const;
    try {
        if (input.actionId === 'machines.managed.credentials.install') {
            return resolveManagedNativeCredentialActionMachineAdmissionInTx(reader, { ...input, actionId: input.actionId });
        }
        const acquiring = input.actionId === 'machines.managed.acquire';
        const projected = acquiring && input.envelope ? readExternalActionManagedAcquireAdmission(input.envelope) : null;
        if (acquiring && input.envelope && !projected) return denied;
        const binding = input.executionBinding;
        const recovery = acquiring ? undefined : input.envelope ? readExternalActionManagedRecoveryAdmission(input.actionId, input.envelope)
            : binding?.managedAdmission;
        if (!acquiring && (!recovery || recovery.actionId !== input.actionId
            || binding && !sameManagedInput(binding.managedAdmission, recovery))) return denied;
        if (binding && (binding.actionId !== input.actionId || binding.accountId !== input.actorAccountId
            || binding.machineId !== input.machineId || binding.target.kind !== 'machine'
            || binding.target.machineId !== input.machineId)) return denied;
        const homeId = projected?.input.selection.homeId ?? recovery?.input.homeId ?? binding?.serverIdentityId;
        const requestId = input.envelope?.requestId ?? binding?.requestId;
        if (!homeId || acquiring && !requestId || binding && (binding.serverIdentityId !== homeId || binding.requestId !== requestId)) return denied;
        const select = { admittedInput: true, custodianAccountId: true,
            controllerMachineId: true, controllerInstallationId: true } as const;
        const retained = recovery
            ? await reader.managedMachine.findFirst({ where: { homeId, id: recovery.input.managedId }, select })
            : await reader.managedMachine.findUnique({ where: { homeId_admittedActionRequestId: {
                homeId, admittedActionRequestId: requestId! } }, select });
        let custodianAccountId: string;
        let installationId: string | undefined;
        if (retained) {
            // An accepted creation survives later preset edits/withdrawal. Its
            // exact requester and compute identity remain owned by admission.
            const state = readManagedAdmissionState(retained.admittedInput);
            if (!isManagedMachineCreator(retained, input.actorAccountId)
                || (retained.controllerMachineId === null ? resolveManagedMachineRole(retained, input.actorAccountId) !== 'manage'
                    : retained.controllerMachineId !== input.machineId)
                || binding && (retained.custodianAccountId !== binding.custodianAccountId
                    || retained.controllerMachineId !== null && retained.controllerInstallationId !== binding.installationId)
                || projected && !sameManagedInput({ computeInput: state.computeInput, continuation: state.continuation }, {
                    computeInput: projected.input,
                    continuation: projected.continuationPresent ? { requestEnvelopeDigest: input.envelope
                        ? computeExternalActionRequestEnvelopeDigestV1(input.envelope) : binding?.requestEnvelopeDigest } : null,
                })) return denied;
            custodianAccountId = retained.custodianAccountId;
            installationId = retained.controllerInstallationId ?? undefined;
        } else {
            if (!acquiring || !projected || projected.input.selection.kind !== 'preset') return denied;
            const selected = await resolveMachinePresetForAcquireInTx(reader, { accountId: input.actorAccountId,
                authentication: input.authentication, ...projected.input.selection, checkCapacity: false });
            const review = resolveManagedAcquireReviewV1(projected.input);
            if (selected.kind !== 'ready' || !selected.delegated || !review.controller || !sameManagedInput(selected.preset.controller, review.controller)
                || review.controller.machineId !== input.machineId) return denied;
            custodianAccountId = selected.custodianAccountId;
            installationId = review.controller.installationId;
        }
        // Custody retains the canonical installation, encryption and availability
        // checks, without publishing controller contents or keys to the requester.
        const controller = await resolveMachineAdmissionInTx(reader, { actorAccountId: custodianAccountId,
            machineId: input.machineId, actionId: 'machines.managed.acquire', requiredRole: 'manage',
            ...(input.requireOnline === undefined ? {} : { requireOnline: input.requireOnline }) });
        if (controller.kind !== 'admitted') return controller;
        return installationId === undefined || controller.installationId === installationId
            ? { ...controller, actorAccountId: input.actorAccountId } : denied;
    } catch (error) {
        if (error instanceof ManagedMachineError) return denied;
        throw error;
    }
}
