import { decodeMachineStoredContent, withMachineContentSelect } from '@/storage/sessionMachineStoredContent';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import type { ExternalActionExecutionAuthorizationBindingV1 } from '@happier-dev/protocol/actions/externalActionApi';
import type { MachineAdmission, SocketRpcMachineAdmissionContextV1 } from '@happier-dev/protocol/machines/machineAccessV1';
import { resolveEffectiveAccountEncryptionModeFromAccountRow } from '@/app/encryption/accountEncryptionMode';
import { classifyMachineAvailabilityState } from '@/app/machines/machineStateGuards';
import { resourceContentMatchesMode, resolveEffectiveMachineRoleInTx } from '@/app/machines/machineAccess';
import type { Tx } from '@/storage/inTx';

/** Only a Home-verified signed binding may reach these retained-admission readers. */
export function hasAdmittedExternalActionHandoffScope(binding: ExternalActionExecutionAuthorizationBindingV1): boolean {
    const handoff = binding.handoffAdmission;
    if (!handoff || !ActionIdSchema.safeParse(binding.actionId).success
        || !(binding.actionId === 'session.handoff' || binding.actionId.startsWith('session.handoff.')
            || binding.actionId === 'session.spawn_new' && binding.handoffContinuation)
        || binding.target.kind !== 'machine' || binding.target.machineId !== binding.machineId
        || ![handoff.sourceMachineId, handoff.targetMachineId].includes(binding.machineId)
        || binding.installationId !== (binding.machineId === handoff.sourceMachineId
            ? handoff.sourceInstallationId : handoff.targetInstallationId)
        || binding.actionId === 'session.spawn_new' && binding.machineId !== handoff.targetMachineId
        || binding.sessionActionOrigin && (!binding.sessionActionSource
            || binding.sessionActionSource.machineId !== handoff.sourceMachineId
            || binding.sessionActionSource.installationId !== handoff.sourceInstallationId)) return false;
    return true;
}

/** Installation identity remains live; requester permission was decided at the original admission. */
export async function readAdmittedExternalActionHandoffMachineInTx(
    reader: Tx,
    binding: ExternalActionExecutionAuthorizationBindingV1,
    machineId = binding.machineId,
    retained?: SocketRpcMachineAdmissionContextV1,
): Promise<Extract<MachineAdmission, { kind: 'admitted' }> | null> {
    if (!hasAdmittedExternalActionHandoffScope(binding)) return null;
    const handoff = binding.handoffAdmission!;
    const installationId = machineId === handoff.sourceMachineId ? handoff.sourceInstallationId
        : machineId === handoff.targetMachineId ? handoff.targetInstallationId : null;
    return installationId ? readAdmittedExternalActionMachineInTx(reader, binding, machineId, installationId, retained) : null;
}

/** The admitted scope owner supplies captured installation identity when present; this reader never re-admits grants. */
export async function readAdmittedExternalActionMachineInTx(
    reader: Tx,
    binding: Pick<ExternalActionExecutionAuthorizationBindingV1, 'accountId' | 'machineId' | 'custodianAccountId'>,
    machineId: string,
    installationId: string | undefined,
    retained?: SocketRpcMachineAdmissionContextV1,
): Promise<Extract<MachineAdmission, { kind: 'admitted' }> | null> {
    const machine = await reader.machine.findUnique({ where: { id: machineId }, select: withMachineContentSelect({
        accountId: true, installationId: true, revokedAt: true, replacedByMachineId: true,
        metadata: true, daemonState: true, dataEncryptionKey: true,
        account: { select: { encryptionMode: true } },
    }) }).then(decodeMachineStoredContent);
    const mode = machine && resolveEffectiveAccountEncryptionModeFromAccountRow(machine.account);
    const role = machine ? await resolveEffectiveMachineRoleInTx(reader, {
        machineId,
        actorAccountId: binding.accountId,
    }) : null;
    if (!machine?.installationId || installationId !== undefined && machine.installationId !== installationId
        || classifyMachineAvailabilityState(machine) !== 'available'
        || !mode || mode.status !== 'ready' || !resourceContentMatchesMode(machine, mode.mode)
        || !role
        || machineId === binding.machineId && machine.accountId !== binding.custodianAccountId
        || retained && (retained.machineId !== machineId || retained.installationId !== installationId
            || retained.actorAccountId !== binding.accountId || retained.custodianAccountId !== machine.accountId
            || retained.encryptionMode !== mode.mode)) return null;
    return { kind: 'admitted', actorAccountId: binding.accountId, custodianAccountId: machine.accountId,
        machineId, installationId: machine.installationId, encryptionMode: mode.mode,
        role: retained?.role ?? role };
}
