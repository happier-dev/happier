import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { SessionInputMachineTargetV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import type { V2SessionRecord } from '@happier-dev/protocol/sessions/control/contract';
import { resolveEffectiveMachineAccessForMachinesInTx } from '@/app/machines/machineAccess';
import { readCurrentServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import type { Tx } from '@/storage/inTx';

/** C79: an admitted Session recipient who holds a grant on the Session's Machine receives this routing
 * hint: the same audience that may start a Session there (`session.spawn_new` admits Use, machineAccess.ts),
 * so a guest's Fork or input can name it. It tells them only which Machine they can already see runs a
 * Session they can already read. The accepted publisher placement supplies identity; no owner envelope
 * is opened or copied. This is disclosure, not admission: Machine admission still decides every call.
 */
export async function readSessionComputerBindingsInTx(tx: Tx, params: Readonly<{
    accountId: string;
    sessions: readonly Pick<V2SessionRecord, 'id' | 'ownerAccountId' | 'metadataLayoutVersion'>[];
}>): Promise<ReadonlyMap<string, NonNullable<V2SessionRecord['computerMachineBinding']>>> {
    const ids = params.sessions.filter(session => session.ownerAccountId !== params.accountId && session.metadataLayoutVersion === 1)
        .map(session => session.id);
    if (!ids.length) return new Map();
    const rows = await tx.session.findMany({ where: { id: { in: ids } },
        select: { id: true, accountId: true, runtimeMachineTarget: true } });
    const homeId = await readCurrentServerIdentityId(process.env, tx);
    const targets = rows.flatMap(row => {
        const target = createStoredReadSchema(SessionInputMachineTargetV1Schema).safeParse(row.runtimeMachineTarget);
        return target.success && target.data.sessionId === row.id && target.data.accountId === row.accountId
            && target.data.homeId === homeId ? [target.data] : [];
    });
    const access = await resolveEffectiveMachineAccessForMachinesInTx(tx, {
        machineIds: targets.map(target => target.machineId), accountIds: [params.accountId],
    });
    return new Map(targets.filter(target => access.get(target.machineId)?.get(params.accountId) != null)
        .map(target => [target.sessionId, { homeId: target.homeId, machineId: target.machineId }]));
}
