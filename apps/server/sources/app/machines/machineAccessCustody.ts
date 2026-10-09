import { MachineAccessLossCustodyResponseV1Schema, MachineAccessLossRequesterCensusResponseV1Schema,
    type MachineAccessLossCustodyResponseV1, type MachineAccessLossCustodyRequestV1, type MachineAdmission } from '@happier-dev/protocol';
import { MACHINE_ACCESS_LOSS_SERVER_ORIGIN, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { eventRouter } from '@/app/events/connectionEventRouter';
import { readMachineAccessKeySessionBindingsInTx } from '@/app/accessKeys/sessionMachineAccessKeyMutations';
import { db } from '@/storage/db';
import { inTx, type Tx } from '@/storage/inTx';
import { log } from '@/utils/logging/log';
import { resolveEffectiveMachineRoleInTx, resolveMachineAdmissionInTx } from './machineAccess';
import type { RpcAckResponseEmitter } from '@/app/api/socket/rpc/_types';

type MachineCustody = Readonly<{ machineId: string;
    expectedCustodianAccountId: string; expectedInstallationId: string }>;
type CustodyLoss = MachineCustody & Readonly<{ subjectAccountId: string }>;
type CurrentCustodyAdmission = Extract<MachineAdmission, { kind: 'admitted' }>;

async function readCurrentCustodyInTx(tx: Tx, input: MachineCustody): Promise<CurrentCustodyAdmission | null> {
    const admission = await resolveMachineAdmissionInTx(tx, { actorAccountId: input.expectedCustodianAccountId,
        machineId: input.machineId, rpcMethod: RPC_METHODS.DAEMON_MACHINE_ACCESS_LOSS, requireOnline: true });
    return admission.kind === 'admitted' && admission.custodianAccountId === input.expectedCustodianAccountId
        && admission.installationId === input.expectedInstallationId ? admission : null;
}

/** Census and cleanup share the same exact current installation transport custody. */
async function forwardMachineAccessCustody(input: MachineCustody, callParams: MachineAccessLossCustodyRequestV1,
    readCurrent: () => Promise<CurrentCustodyAdmission | null>) {
    const current = await readCurrent();
    if (!current) return null;
    const { kind: _kind, ...machineAdmission } = current;
    const matches = (target: RpcAckResponseEmitter) => target.data?.clientType === 'machine-scoped'
        && target.data.userId === input.expectedCustodianAccountId && target.data.machineId === input.machineId
        && target.data.verifiedMachineInstallationId === input.expectedInstallationId;
    return await eventRouter.forwardServerOwnedRpc({
        targetUserId: input.expectedCustodianAccountId, method: `${input.machineId}:${RPC_METHODS.DAEMON_MACHINE_ACCESS_LOSS}`,
        callParams, authorization: MACHINE_ACCESS_LOSS_SERVER_ORIGIN,
        machineAdmission, targetGuard: {
            filterTargets: async targets => targets.filter(matches),
            runOperation: async ({ target, readLatestTarget, operation }) => {
                if (!matches(target)) return { status: 'unavailable' };
                const latest = await readLatestTarget();
                if (!latest || !matches(latest) || !await readCurrent()) return { status: 'unavailable' };
                return { status: 'current', value: await operation() };
            },
        },
    });
}

/** Delegates current effective loss to the daemon's existing composed cleanup owners. */
export async function dispatchMachineAccessLossCustody(input: CustodyLoss): Promise<MachineAccessLossCustodyResponseV1> {
    let lossNoLongerCurrent = false;
    const readCurrent = () => inTx(async tx => {
        if (await resolveEffectiveMachineRoleInTx(tx, { actorAccountId: input.subjectAccountId, machineId: input.machineId }) !== null) {
            lossNoLongerCurrent = true;
            return null;
        }
        return await readCurrentCustodyInTx(tx, input);
    });
    const response = await forwardMachineAccessCustody(input, { v: 1, subjectAccountId: input.subjectAccountId }, readCurrent);
    if (lossNoLongerCurrent) return { kind: 'settled' };
    const result = response?.ok ? MachineAccessLossCustodyResponseV1Schema.safeParse(response.result) : null;
    if (result?.success) return result.data;
    log({ module: 'machine-access', level: 'warn', machineId: input.machineId }, 'Requester work cleanup remains incomplete');
    return { kind: 'incomplete' };
}

/** History and live attribution supply subjects; only current access loss authorizes cleanup. */
export async function recoverMachineAccessLossCustody(input: MachineCustody): Promise<void> {
    const machine = await db.machine.findUnique({ where: { id: input.machineId }, select: { accountId: true, installationId: true } });
    if (!machine || machine.accountId !== input.expectedCustodianAccountId || machine.installationId !== input.expectedInstallationId) return;
    const bindings = await inTx(tx => readMachineAccessKeySessionBindingsInTx(tx, {
        accountId: input.expectedCustodianAccountId, machineId: input.machineId,
    }));
    const subjects = new Set(bindings.map(binding => binding.accountId));
    const response = await forwardMachineAccessCustody(input, { v: 1, kind: 'requesters' },
        () => inTx(tx => readCurrentCustodyInTx(tx, input)));
    const census = response?.ok ? MachineAccessLossRequesterCensusResponseV1Schema.safeParse(response.result) : null;
    if (census?.success) for (const accountId of census.data.accountIds) subjects.add(accountId);
    if (!census?.success || census.data.coverage !== 'complete') {
        log({ module: 'machine-access', level: 'warn', machineId: input.machineId }, 'Reconnect requester work census remains incomplete');
    }
    for (const subjectAccountId of subjects) {
        await dispatchMachineAccessLossCustody({ ...input, subjectAccountId });
    }
}
