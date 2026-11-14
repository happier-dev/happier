import { ManagedInstallationPurposeV1Schema, ManagedInstallationServerOriginV1Schema,
    type ManagedInstallationPurposeV1, type ManagedInstallationServerOriginV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { inReadSnapshot, type Tx } from '@/storage/inTx';
import { ManagedMachineError, readManagedController, readManagedEnrollmentAccountId, readManagedCurrentRequestId, readManagedMachineInTx,
    requireManagedControllerInTx, sameManagedInput, matchesManagedEnrollmentResource, type StoredManagedMachine } from './managedRows';

/** Account enrollment custody authorizes this exact pending installer, never its controller Machine. */
async function requireManagedInstallationPurposeInTx(tx: Tx, row: StoredManagedMachine, actorAccountId: string, purpose: ManagedInstallationPurposeV1) {
    if (readManagedEnrollmentAccountId(row) !== actorAccountId || row.creationState !== 'active'
        || row.archivedAt !== null || row.allocation !== 'bound' || row.cleanup !== null || row.desired === 'delete'
        || purpose.phase === 'delivery' && row.enrolledMachineId !== null
        || row.intentRevision !== purpose.expectedIntentRevision || readManagedCurrentRequestId(row) !== purpose.requestId
        || !sameManagedInput(readManagedController(row), purpose.controller)
        || !matchesManagedEnrollmentResource(row, purpose.resource)) throw new ManagedMachineError('permission_denied');
    await requireManagedControllerInTx(tx, { homeId: purpose.homeId, custodianAccountId: row.custodianAccountId, controller: purpose.controller });
    return row;
}

/** The only admission: the returned stamp travels solely on the custodian controller's authenticated Home socket. */
export async function admitManagedInstallationPurpose(input: Readonly<{
    actorAccountId: string; purpose: Omit<ManagedInstallationPurposeV1, 'requestId'> & Readonly<{ requestId?: string }>;
}>): Promise<ManagedInstallationServerOriginV1> {
    return inReadSnapshot(async tx => {
        const retained = await readManagedMachineInTx(tx, input.purpose);
        const purpose = ManagedInstallationPurposeV1Schema.parse({ ...input.purpose,
            requestId: input.purpose.requestId ?? readManagedCurrentRequestId(retained) });
        const row = await requireManagedInstallationPurposeInTx(tx, retained, input.actorAccountId, purpose);
        return ManagedInstallationServerOriginV1Schema.parse({ kind: 'machine.managedInstallation.serverOrigin',
            actorAccountId: input.actorAccountId, custodianAccountId: row.custodianAccountId, purpose });
    });
}
