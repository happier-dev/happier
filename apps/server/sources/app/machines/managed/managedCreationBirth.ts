import type { SessionManagedCreationV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationCorrespondenceV1';
import type { Tx } from '@/storage/inTx';
import { getDbProviderFromEnv } from '@/storage/prisma';
import { readCurrentServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { isManagedMachineCreator } from './managedRead';
import type { ManagedMachineBirthSourceV1 } from '@happier-dev/protocol/machines/managed/birthSourceV1';
import { readManagedAdmissionState, invalidateManagedMachineInTx, type StoredManagedMachine, readManagedController, resolveManagedMachineRoleInTx, sameManagedInput } from './managedRows';

/** Optimistic shared selection lost to an incumbent birth; the caller may acquire again. */
export class ManagedCreationBusyError extends Error {
    constructor() { super('session-managed-target-busy'); this.name = 'ManagedCreationBusyError'; }
}

async function lockManagedCreationResourceInTx(tx: Tx, id: string): Promise<void> {
    const provider = getDbProviderFromEnv(process.env, 'postgres');
    if (provider === 'sqlite') {
        await tx.$executeRawUnsafe('UPDATE "ManagedMachine" SET "id" = "id" WHERE "id" = ?', id);
    } else {
        await tx.$queryRawUnsafe(provider === 'mysql'
            ? 'SELECT `id` FROM `ManagedMachine` WHERE `id` = ? FOR UPDATE'
            : 'SELECT "id" FROM "ManagedMachine" WHERE "id" = $1 FOR UPDATE', id);
    }
}

/** Fresh Session/Run birth binds the admitted creator or controller access to the exact guest. */
export async function validateManagedCreationBirthInTx(tx: Tx, input: Readonly<{
    accountId: string;
    birth: SessionManagedCreationV1;
    executionMachineId?: string;
}>): Promise<StoredManagedMachine | false> {
    const { birth } = input;
    let resource = await tx.managedMachine.findUnique({ where: { id: birth.managedId } });
    if (resource && readManagedAdmissionState(resource.admittedInput).acquisitionMode === 'resource-bound') {
        // The same row is locked through the containing Session-create commit.
        // Re-read current lifecycle facts after waiting for a prior birth/writer.
        await lockManagedCreationResourceInTx(tx, resource.id);
        resource = await tx.managedMachine.findUnique({ where: { id: resource.id } });
    }
    if (!resource || resource.homeId !== birth.homeId
        || birth.homeId !== await readCurrentServerIdentityId(process.env, tx)
        || !sameManagedInput(readManagedController(resource), birth.controller)
        || resource.creationState !== 'active' || resource.allocation !== 'bound'
        || resource.archivedAt !== null) return false;
    const creator = isManagedMachineCreator(resource, input.accountId);
    if (readManagedAdmissionState(resource.admittedInput).acquisitionMode === 'resource-bound') {
        // Acquisition already admitted custody: a Can-use member's guest keeps the controller's Account
        // as custodian and records the member as its requester, so the birth belongs to that requester.
        if (!creator || !resource.controllerMachineId
            || input.executionMachineId !== undefined && resource.controllerMachineId !== input.executionMachineId) return false;
        if (await tx.session.findFirst({ where: { managedCreationId: resource.id, archivedAt: null }, select: { id: true } })) {
            throw new ManagedCreationBusyError();
        }
        return resource;
    }
    if (!resource.enrolledMachineId
        || input.executionMachineId !== undefined && resource.enrolledMachineId !== input.executionMachineId) return false;
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

/** Session/Run owners emit or withdraw their end; submitted native effects retain their settlement owner. */
export async function applyManagedCreationScopeEndInTx(tx: Tx, input: Readonly<{
    managedId: string | null; accountId: string; source: ManagedMachineBirthSourceV1; endedAt: number | null;
}>): Promise<void> {
    if (!input.managedId) return;
    const row = await tx.managedMachine.findUnique({ where: { id: input.managedId } });
    if (!row || row.creationState !== 'active' || row.archivedAt !== null) return;
    const admission = readManagedAdmissionState(row.admittedInput);
    const scope = admission.creationScopeRetention;
    if (!scope || (input.endedAt === null ? scope.endedAt === undefined : scope.endedAt !== undefined)
        || admission.enrollmentAccountId !== input.accountId
        || !sameManagedInput(scope.source, input.source)) return;
    const { endedAt: _previousEnd, ...retainedScope } = scope;
    await tx.managedMachine.update({ where: { id: row.id }, data: {
        intentRevision: { increment: 1 },
        admittedInput: { ...admission, creationScopeRetention: { ...retainedScope,
            ...(input.endedAt === null ? {} : { endedAt: input.endedAt }) } },
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
