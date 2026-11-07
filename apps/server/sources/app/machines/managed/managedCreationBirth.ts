import type { SessionManagedCreationV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationCorrespondenceV1';
import type { Tx } from '@/storage/inTx';
import { readCurrentServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { isManagedMachineCreator } from './managedRead';
import type { ManagedMachineBirthSourceV1 } from '@happier-dev/protocol/machines/managed/birthSourceV1';
import { readManagedAdmissionState, invalidateManagedMachineInTx, type StoredManagedMachine, readManagedController, resolveManagedMachineRoleInTx, sameManagedInput } from './managedRows';

/** Fresh Session/Run birth binds the admitted creator or controller access to the exact guest. */
export async function validateManagedCreationBirthInTx(tx: Tx, input: Readonly<{
    accountId: string;
    birth: SessionManagedCreationV1;
    executionMachineId?: string;
}>): Promise<StoredManagedMachine | false> {
    const { birth } = input;
    const resource = await tx.managedMachine.findUnique({ where: { id: birth.managedId } });
    if (!resource || resource.homeId !== birth.homeId
        || birth.homeId !== await readCurrentServerIdentityId(process.env, tx)
        || !sameManagedInput(readManagedController(resource), birth.controller)
        || resource.creationState !== 'active' || resource.allocation !== 'bound'
        || !resource.enrolledMachineId || resource.archivedAt !== null
        || input.executionMachineId !== undefined && resource.enrolledMachineId !== input.executionMachineId) return false;
    const creator = isManagedMachineCreator(resource, input.accountId);
    // The scope choice belongs to the admitted creator's birth, never to a
    // controller recipient's broader ability to create an ordinary Session.
    if (readManagedAdmissionState(resource.admittedInput).creationScopeRetention && !creator) return false;
    return creator || await resolveManagedMachineRoleInTx(tx, resource, input.accountId) ? resource : false;
}


/** The successful birth admission supplies its exact resource; do not re-authorize it. */
export async function bindManagedCreationScopeRetentionInTx(tx: Tx, row: StoredManagedMachine, source: ManagedMachineBirthSourceV1): Promise<void> {
    const admission = readManagedAdmissionState(row.admittedInput);
    const scope = admission.creationScopeRetention;
    if (!scope || scope.source) return;
    await tx.managedMachine.update({ where: { id: row.id }, data: {
        admittedInput: { ...admission, creationScopeRetention: { ...scope, source } },
    } });
    await invalidateManagedMachineInTx(tx, row);
}

/** Session/Run owners emit their end; Home's retained policy alone selects its native effect. */
export async function applyManagedCreationScopeEndInTx(tx: Tx, input: Readonly<{
    managedId: string | null; accountId: string; source: ManagedMachineBirthSourceV1; endedAt: number;
}>): Promise<void> {
    if (!input.managedId) return;
    const row = await tx.managedMachine.findUnique({ where: { id: input.managedId } });
    if (!row || row.creationState !== 'active' || row.archivedAt !== null) return;
    const admission = readManagedAdmissionState(row.admittedInput);
    const scope = admission.creationScopeRetention;
    if (!scope || scope.endedAt !== undefined || admission.enrollmentAccountId !== input.accountId
        || !sameManagedInput(scope.source, input.source)) return;
    await tx.managedMachine.update({ where: { id: row.id }, data: {
        intentRevision: { increment: 1 },
        admittedInput: { ...admission, creationScopeRetention: { ...scope, endedAt: input.endedAt } },
    } });
    await invalidateManagedMachineInTx(tx, row);
}

/** Exact non-content birth lookup shared by the public read and retention edit admission. */
export async function readManagedCreationBirthInTx(tx: Tx, input: Readonly<{ accountId: string; managedId: string }>): Promise<Readonly<{ source: ManagedMachineBirthSourceV1; endedAt?: number }> | null> {
    const where = { accountId: input.accountId, managedCreationId: input.managedId };
    const runs = await tx.automationRun.findMany({ where, select: { id: true, finishedAt: true }, take: 2 });
    if (runs.length === 1) return { source: { kind: 'run' as const, source: { kind: 'workflow_run' as const, runId: runs[0]!.id } },
        ...(runs[0]!.finishedAt ? { endedAt: runs[0]!.finishedAt.getTime() } : {}) };
    const sessions = await tx.session.findMany({ where, select: { id: true, archivedAt: true }, take: 2 });
    return sessions.length === 1 ? { source: { kind: 'session' as const, sessionId: sessions[0]!.id },
        ...(sessions[0]!.archivedAt ? { endedAt: sessions[0]!.archivedAt.getTime() } : {}) } : null;
}
