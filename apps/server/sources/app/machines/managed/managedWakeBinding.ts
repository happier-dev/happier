import { decodeMachineStoredContent } from '@/storage/sessionMachineStoredContent';
import type { Machine, Prisma } from '@prisma/client';
import type { MachineAccessRoleV1 } from '@happier-dev/protocol/machines/machineAccessV1';
import { resolveManagedMachineRuntimeV1 } from '@happier-dev/protocol/machines/managed/resolveMachineRetentionPolicyV1';
import { isMachineReachableV1 } from '@happier-dev/protocol/machines/machineReachabilityV1';
import type { ManagedWakeTargetV1 } from '@happier-dev/protocol/machines/managed/managedIntentV1';
import { isSessionSpawnNewActionIdV1 } from '@happier-dev/protocol/actions/actionIds';
import { resolveEffectiveMachineAccessForMachinesInTx } from '@/app/machines/machineAccess';
import { classifyMachineAvailabilityState } from '@/app/machines/machineStateGuards';
import { serializeMachinePresence } from '@/app/machines/machineSerialization';
import { readCurrentServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { getDbProviderFromEnv } from '@/storage/db';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import type { Tx } from '@/storage/inTx';
import { ManagedMachineError, hasBoundManagedLifecycle, projectManagedMachine, readManagedController,
    requireManagedControllerFromFacts, resolveManagedMachineRole, type StoredManagedMachine } from './managedRows';

type WakeActor = Readonly<{ actorAccountId: string; machineId: string }>;
type WakeMachine = Machine & { account: Prisma.AccountGetPayload<{ select: { status: true } }> };

/** Owner-enabled accepted input borrows native wake; manual power retains Manage admission. */
export function hasManagedWakeAuthority(controllerRole: 'manage' | 'use' | null, wakeOnAcceptedMessage: boolean,
    origin: ManagedWakeTargetV1['origin']['kind'], finiteActionId?: string): boolean {
    return controllerRole === 'manage' || wakeOnAcceptedMessage && (origin === 'session-input'
        || origin === 'finite-command' && finiteActionId !== undefined && isSessionSpawnNewActionIdV1(finiteActionId));
}

function projectWakeBinding(homeId: string, row: StoredManagedMachine | undefined, guest: WakeMachine | undefined,
    controller: WakeMachine | undefined, guestRole: MachineAccessRoleV1 | null, controllerRole: MachineAccessRoleV1 | null,
    target: WakeActor) {
    if (!row || row.homeId !== homeId || row.archivedAt !== null || row.creationState !== 'active'
        || row.allocation !== 'bound' || row.desired === 'delete' || !hasBoundManagedLifecycle(row)) return undefined;
    const controllerBinding = readManagedController(row);
    try { requireManagedControllerFromFacts({ custodianAccountId: row.custodianAccountId, controller: controllerBinding }, controller); }
    catch (error) { if (error instanceof ManagedMachineError) return undefined; throw error; }
    if (classifyMachineAvailabilityState(guest ?? null) !== 'available' || !guestRole) return undefined;
    let projected;
    try { projected = projectManagedMachine(row); } catch { return undefined; }
    const runtime = resolveManagedMachineRuntimeV1(projected, target.machineId,
        guest !== undefined && isMachineReachableV1({ machine: serializeMachinePresence(guest) }));
    if (!runtime.available) return undefined;
    return { binding: { homeId, managedId: row.id, enrolledMachineId: target.machineId,
        expectedIntentRevision: row.intentRevision, controller: controllerBinding, reason: 'admitted-work' as const },
        controllerAccountId: controllerBinding ? controller?.accountId : undefined,
        controllerRole: resolveManagedMachineRole(row, target.actorAccountId, controllerRole, guestRole),
        wakeOnAcceptedMessage: row.wakeOnAcceptedMessage, inspectionRequired: runtime.inspectionRequired };
}

/** Point admission and publication use one eligibility projection over exact current facts. */
export async function readManagedWakeTargetBindingsInTx(tx: Tx, targets: readonly WakeActor[]) {
    if (targets.length === 0) return [];
    const homeId = await readCurrentServerIdentityId(process.env, tx);
    if (!homeId) return targets.map(() => undefined);
    const provider = getDbProviderFromEnv(process.env, 'postgres');
    const guestIds = [...new Set(targets.map(target => target.machineId))];
    const rows: StoredManagedMachine[] = [];
    if (provider === 'postgres') rows.push(...await tx.$queryRawUnsafe<StoredManagedMachine[]>(
        'SELECT * FROM "ManagedMachine" WHERE "enrolledMachineId" = ANY($1::text[])', guestIds));
    else for (const ids of portableQueryChunks({ values: guestIds, bindingsPerValue: 1, fixedBindings: 1 })) {
        rows.push(...await tx.managedMachine.findMany({ where: { enrolledMachineId: { in: [...ids] } } }));
    }
    if (rows.length === 0) return targets.map(() => undefined);
    const byGuest = new Map(rows.map(row => [row.enrolledMachineId, row]));
    const machineIds = [...new Set([...guestIds, ...rows.flatMap(row => row.controllerMachineId ? [row.controllerMachineId] : [])])];
    const machines: WakeMachine[] = [];
    if (provider === 'postgres') machines.push(...await tx.$queryRawUnsafe<WakeMachine[]>(
        `SELECT m.*, jsonb_build_object('status', a."status") AS "account" FROM "Machine" m
         JOIN "Account" a ON a."id" = m."accountId" WHERE m."id" = ANY($1::text[])`, machineIds).then(decodeMachineStoredContent));
    else for (const ids of portableQueryChunks({ values: machineIds, bindingsPerValue: 1, fixedBindings: 2 })) {
        machines.push(...await tx.machine.findMany({ where: { id: { in: [...ids] } }, include: { account: { select: { status: true } } } }).then(decodeMachineStoredContent));
    }
    const byMachine = new Map(machines.map(machine => [machine.id, machine]));
    const roles = await resolveEffectiveMachineAccessForMachinesInTx(tx, { machineIds,
        accountIds: [...new Set(targets.map(target => target.actorAccountId))] });
    return targets.map(target => {
        const row = byGuest.get(target.machineId);
        return projectWakeBinding(homeId, row, byMachine.get(target.machineId),
            row?.controllerMachineId ? byMachine.get(row.controllerMachineId) : undefined,
            roles.get(target.machineId)?.get(target.actorAccountId) ?? null,
            row?.controllerMachineId ? roles.get(row.controllerMachineId)?.get(target.actorAccountId) ?? null : null, target);
    });
}

/** Accepted-origin correlation only; this never admits a power Action or changes desired intent. */
export async function readManagedWakeTargetBindingInTx(tx: Tx, target: WakeActor) {
    return (await readManagedWakeTargetBindingsInTx(tx, [target]))[0];
}
