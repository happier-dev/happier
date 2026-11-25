import { createHash } from 'node:crypto';

import { acquireAccountChangePublicationLocksInTx, markAccountChanged } from '@/app/changes/markAccountChanged';
import { jsonPathEquals } from '@/storage/jsonPathFilter';
import { inReadSnapshot, inTx } from '@/storage/inTx';
import {
    MANAGED_MACHINE_SIGN_IN_OCCURRENCE_ENTITY_PREFIX_V1,
    ManagedMachineSignInOccurrenceV1Schema, type ManagedMachineSignInOccurrenceReportV1,
    type ManagedMachineSignInOccurrenceV1,
} from '@happier-dev/protocol/machines/managed/actionsV1';
import { hasBoundManagedLifecycle, ManagedMachineError, readManagedEnrollmentAccountId, readManagedMachineInTx,
    requireCurrentManagedMachineInTx, sameManagedInput, readManagedController, readManagedCurrentRequestId } from './managedRows';

/** The existing Account change row is the requester-only operation projection. */
export async function reportManagedMachineSignInOccurrence(input: ManagedMachineSignInOccurrenceReportV1,
    requesterAccountId: string, controllerCustodianAccountId: string): Promise<{ observed: true }> {
    return await inTx(async tx => {
        // Use the same Account writer lock as publication so a repeated report
        // cannot allocate another cursor for a transition that already committed.
        await acquireAccountChangePublicationLocksInTx(tx, [requesterAccountId], { intent: 'serializing' });
        const row = await readManagedMachineInTx(tx, input);
        if (row.custodianAccountId !== controllerCustodianAccountId
            || readManagedEnrollmentAccountId(row) !== requesterAccountId
            || !sameManagedInput(readManagedController(row), input.controller)) throw new ManagedMachineError('permission_denied');
        const occurrence: ManagedMachineSignInOccurrenceV1 = { ...input.signInOccurrence,
            homeId: row.homeId, managedId: row.id, requesterAccountId };
        // AccountChange uses a shared indexed String, including on MySQL.
        const entityId = MANAGED_MACHINE_SIGN_IN_OCCURRENCE_ENTITY_PREFIX_V1
            + createHash('sha256').update(JSON.stringify([occurrence.operationId, occurrence.taskId])).digest('hex');
        const key = { accountId: requesterAccountId, kind: 'account', entityId };
        const previous = ManagedMachineSignInOccurrenceV1Schema.safeParse(
            (await tx.accountChange.findUnique({ where: { accountId_kind_entityId: key }, select: { hint: true } }))?.hint,
        );
        if (previous.success) {
            if (previous.data.managedId !== row.id) throw new ManagedMachineError('request_conflict');
            if (previous.data.state !== 'pending' || occurrence.state === 'pending') return { observed: true };
        } else {
            if (occurrence.state !== 'pending') return { observed: true };
            await requireCurrentManagedMachineInTx(tx, input, { requestAuthority:
                input.requestId === row.admittedActionRequestId ? 'creation' : 'intent' });
            if (!hasBoundManagedLifecycle(row) || row.enrolledMachineId) throw new ManagedMachineError('enrollment_retired');
        }
        if (input.requestId !== row.admittedActionRequestId && input.requestId !== readManagedCurrentRequestId(row)) {
            throw new ManagedMachineError('request_conflict');
        }
        await markAccountChanged(tx, { ...key, kind: 'account', hint: occurrence });
        return { observed: true };
    });
}

/** First observation and reconnection read the same projection that the Account feed pushes. */
export async function listPendingManagedMachineSignInOccurrences(accountId: string) {
    return inReadSnapshot(async tx => {
        const rows = await tx.accountChange.findMany({
            where: { accountId, kind: 'account', entityId: { startsWith: MANAGED_MACHINE_SIGN_IN_OCCURRENCE_ENTITY_PREFIX_V1 },
                hint: jsonPathEquals(['state'], 'pending') },
            orderBy: { cursor: 'asc' },
            select: { hint: true },
        });
        return { occurrences: rows.flatMap(({ hint }) => {
            const occurrence = ManagedMachineSignInOccurrenceV1Schema.safeParse(hint);
            return occurrence.success ? [occurrence.data] : [];
        }) };
    });
}
