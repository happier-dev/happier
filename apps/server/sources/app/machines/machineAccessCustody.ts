import { MachineAccessLossCustodyResponseV1Schema, type MachineAccessLossCustodyResponseV1 } from '@happier-dev/protocol';
import { MACHINE_ACCESS_LOSS_SERVER_ORIGIN, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { eventRouter } from '@/app/events/connectionEventRouter';
import { readMachineAccessKeySessionBindingsInTx } from '@/app/accessKeys/sessionMachineAccessKeyMutations';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { log } from '@/utils/logging/log';
import { resolveEffectiveMachineRoleInTx, resolveMachineAdmissionInTx } from './machineAccess';
import type { RpcAckResponseEmitter } from '@/app/api/socket/rpc/_types';

type CustodyLoss = Readonly<{ machineId: string; subjectAccountId: string;
    expectedCustodianAccountId: string; expectedInstallationId: string }>;

/** Session cleanup only. No result here claims finite work or services have settled. */
export async function dispatchMachineAccessLossCustody(input: CustodyLoss): Promise<MachineAccessLossCustodyResponseV1> {
    let lossNoLongerCurrent = false;
    const readCurrent = () => inTx(async tx => {
        if (await resolveEffectiveMachineRoleInTx(tx, { actorAccountId: input.subjectAccountId, machineId: input.machineId }) !== null) {
            lossNoLongerCurrent = true;
            return null;
        }
        const admission = await resolveMachineAdmissionInTx(tx, { actorAccountId: input.expectedCustodianAccountId,
            machineId: input.machineId, rpcMethod: RPC_METHODS.DAEMON_MACHINE_ACCESS_LOSS, requireOnline: true });
        return admission.kind === 'admitted' && admission.custodianAccountId === input.expectedCustodianAccountId
            && admission.installationId === input.expectedInstallationId ? admission : null;
    });
    const current = await readCurrent();
    if (!current) return { kind: lossNoLongerCurrent ? 'settled' : 'incomplete' };
    const { kind: _kind, ...machineAdmission } = current;
    const matches = (target: RpcAckResponseEmitter) => target.data?.clientType === 'machine-scoped'
        && target.data.userId === input.expectedCustodianAccountId && target.data.machineId === input.machineId
        && target.data.verifiedMachineInstallationId === input.expectedInstallationId;
    const response = await eventRouter.forwardServerOwnedRpc({
        targetUserId: input.expectedCustodianAccountId, method: `${input.machineId}:${RPC_METHODS.DAEMON_MACHINE_ACCESS_LOSS}`,
        callParams: { v: 1, subjectAccountId: input.subjectAccountId }, authorization: MACHINE_ACCESS_LOSS_SERVER_ORIGIN,
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
    if (lossNoLongerCurrent) return { kind: 'settled' };
    const result = response?.ok ? MachineAccessLossCustodyResponseV1Schema.safeParse(response.result) : null;
    if (result?.success) return result.data;
    log({ module: 'machine-access', level: 'warn', machineId: input.machineId }, 'Requester Session cleanup remains incomplete');
    return { kind: 'incomplete' };
}

/** Reconnect census only: history supplies subjects, never authority to stop a process. */
export async function recoverMachineAccessLossCustody(input: Readonly<{ machineId: string;
    expectedCustodianAccountId: string; expectedInstallationId: string }>): Promise<void> {
    const machine = await db.machine.findUnique({ where: { id: input.machineId }, select: { accountId: true, installationId: true } });
    if (!machine || machine.accountId !== input.expectedCustodianAccountId || machine.installationId !== input.expectedInstallationId) return;
    const bindings = await inTx(tx => readMachineAccessKeySessionBindingsInTx(tx, {
        accountId: input.expectedCustodianAccountId, machineId: input.machineId,
    }));
    for (const subjectAccountId of new Set(bindings.map(binding => binding.accountId))) {
        await dispatchMachineAccessLossCustody({ ...input, subjectAccountId });
    }
}
