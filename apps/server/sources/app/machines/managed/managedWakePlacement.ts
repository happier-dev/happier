import { decodeSessionStoredContent, withSessionContentSelect } from '@/storage/sessionMachineStoredContent';
import type { Prisma, SessionPendingMessage } from '@prisma/client';
import { ManagedWakeTargetV1Schema, type ManagedWakeTargetV1 } from '@happier-dev/protocol/machines/managed/managedIntentV1';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { areCurrentSessionInputMachineTargetsInTx } from '@/app/session/messages/sessionInputAdmission';
import { readPendingSessionInputAdmission } from '@/app/session/pending/pendingInputAdmission';
import { getDbProviderFromEnv } from '@/storage/db';
import { resolveDbSqlDialect } from '@/config/databaseProvider';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import type { Tx } from '@/storage/inTx';
import { sameManagedInput } from './managedRows';
import { hasManagedWakeAuthority, readManagedWakeTargetBindingsInTx } from './managedWakeBinding';

const sessionSelect = { id: true, accountId: true, archivedAt: true, runtimeMachineTarget: true,
    pendingActivationStatus: true, pendingActivationRequestId: true, pendingActivationRequestedAt: true,
    pendingActivationManagedTarget: true } as const;
export type ManagedWakeSession = Prisma.SessionGetPayload<{ select: typeof sessionSelect }>;

/** Exact Session IDs use one Postgres array binding, independent of audience size. */
export async function readManagedWakeSessionsInTx(tx: Tx, sessionIds: readonly string[]): Promise<ManagedWakeSession[]> {
    const ids = [...new Set(sessionIds)];
    if (ids.length === 0) return [];
    if (resolveDbSqlDialect(getDbProviderFromEnv(process.env, 'postgres')) === 'postgres') return tx.$queryRawUnsafe<ManagedWakeSession[]>(
        `SELECT "id", "accountId", "archivedAt", "runtimeMachineTarget", "pendingActivationStatus",
         "pendingActivationRequestId", "pendingActivationRequestedAt", "pendingActivationManagedTarget"
         FROM "Session" WHERE "id" = ANY($1::text[])`, ids);
    const sessions: ManagedWakeSession[] = [];
    for (const chunk of portableQueryChunks({ values: ids, bindingsPerValue: 1, fixedBindings: 1 })) {
        sessions.push(...await tx.session.findMany({ where: { id: { in: [...chunk] } }, select: withSessionContentSelect(sessionSelect) }).then(decodeSessionStoredContent));
    }
    return sessions;
}

/** The retained pending origin must still name this exact accepted input. */
export function readStoredPendingManagedWakeTarget(session: Pick<ManagedWakeSession, 'id' | 'pendingActivationStatus'
    | 'pendingActivationManagedTarget' | 'pendingActivationRequestId' | 'pendingActivationRequestedAt'>): ManagedWakeTargetV1 | undefined {
    if (session.pendingActivationStatus !== 'waiting') return undefined;
    const stored = createStoredReadSchema(ManagedWakeTargetV1Schema).safeParse(session.pendingActivationManagedTarget);
    if (!stored.success || stored.data.origin.kind !== 'session-input'
        || stored.data.origin.session.sessionId !== session.id
        || stored.data.origin.session.homeId !== stored.data.homeId
        || stored.data.origin.pendingRequestId !== session.pendingActivationRequestId
        || stored.data.origin.requestedAt !== session.pendingActivationRequestedAt?.getTime()
        || !session.pendingActivationRequestedAt) return undefined;
    return stored.data;
}

type PendingManagedWakeInput = Pick<SessionPendingMessage,
    'status' | 'messageRole' | 'authorAccountId' | 'deliveryState' | 'providerAction' | 'inputAdmissionReceipt'>;

function readQueuedManagedWakeInputTarget(session: ManagedWakeSession, pending: PendingManagedWakeInput | undefined, target: ManagedWakeTargetV1) {
    if (session.archivedAt !== null
        || pending?.status !== 'queued' || pending.deliveryState !== null || pending.providerAction !== null) return undefined;
    const receipt = readPendingSessionInputAdmission({ sessionId: session.id, accountId: session.accountId, pending });
    return receipt?.admittedTarget?.machineId === target.enrolledMachineId
        ? receipt.admittedTarget : undefined;
}

/** Shared pending-origin proof for publication, recovery and the effect's currentness assertion. */
export function readPendingManagedWakeInputTarget(session: ManagedWakeSession,
    pending: PendingManagedWakeInput | undefined, target: ManagedWakeTargetV1) {
    const retained = readStoredPendingManagedWakeTarget(session);
    if (!retained || target.origin.kind !== 'session-input' || !sameManagedInput(
        { homeId: retained.homeId, managedId: retained.managedId,
            enrolledMachineId: retained.enrolledMachineId, origin: retained.origin },
        { homeId: target.homeId, managedId: target.managedId, enrolledMachineId: target.enrolledMachineId, origin: target.origin },
    )) return undefined;
    return readQueuedManagedWakeInputTarget(session, pending, target);
}

/** A newer origin can wake the same Session for other queued inputs at its exact admitted placement. */
export async function hasManagedWakeForPendingReplayInTx(tx: Tx, session: ManagedWakeSession,
    pending: PendingManagedWakeInput & { localId: string }): Promise<boolean> {
    const retainedLocalId = session.pendingActivationRequestId;
    const target = readStoredPendingManagedWakeTarget(session);
    if (!retainedLocalId || !target) return false;
    const replayTarget = readQueuedManagedWakeInputTarget(session, pending, target);
    if (!replayTarget) return false;
    if (retainedLocalId === pending.localId) return true;

    const origin = await tx.sessionPendingMessage.findUnique({
        where: { sessionId_localId: { sessionId: session.id, localId: retainedLocalId }, targetExecutionRunId: null },
        select: { status: true, messageRole: true, authorAccountId: true, deliveryState: true, providerAction: true, inputAdmissionReceipt: true },
    });
    return sameManagedInput(replayTarget, readQueuedManagedWakeInputTarget(session, origin ?? undefined, target));
}

/** Pending recovery and the census consume the same exact binding and receipt owners. */
export async function readPendingManagedWakeTargetsInTx(tx: Tx, sessions: readonly ManagedWakeSession[]): Promise<ReadonlyMap<string, ManagedWakeTargetV1>> {
    const retained = sessions.flatMap(session => {
        const target = readStoredPendingManagedWakeTarget(session);
        return target && session.archivedAt === null ? [{ session, target }] : [];
    });
    if (retained.length === 0) return new Map();
    const bindings = await readManagedWakeTargetBindingsInTx(tx,
        retained.map(({ session, target }) => ({ actorAccountId: session.accountId, machineId: target.enrolledMachineId })));
    const pendingIds = retained.map(({ session }) => ({ sessionId: session.id, localId: session.pendingActivationRequestId! }));
    const pendingRows: SessionPendingMessage[] = [];
    if (resolveDbSqlDialect(getDbProviderFromEnv(process.env, 'postgres')) === 'postgres') pendingRows.push(...await tx.$queryRawUnsafe<SessionPendingMessage[]>(
        `SELECT p.* FROM "SessionPendingMessage" p
         JOIN jsonb_to_recordset($1::jsonb) AS requested("sessionId" text, "localId" text)
         ON p."sessionId" = requested."sessionId" AND p."localId" = requested."localId"
         WHERE p."targetExecutionRunId" IS NULL`, JSON.stringify(pendingIds)));
    else for (const ids of portableQueryChunks({ values: pendingIds, bindingsPerValue: 2, fixedBindings: 1 })) {
        pendingRows.push(...await tx.sessionPendingMessage.findMany({ where: { OR: [...ids], targetExecutionRunId: null } }));
    }
    const byPending = new Map(pendingRows.map(pending => [JSON.stringify([pending.sessionId, pending.localId]), pending]));
    const candidates = retained.flatMap(({ session, target }, index) => {
        const binding = bindings[index];
        if (!binding || !hasManagedWakeAuthority(binding.controllerRole, binding.wakeOnAcceptedMessage, 'session-input')) return [];
        const current = ManagedWakeTargetV1Schema.parse({ ...binding.binding, origin: target.origin });
        const admittedTarget = readPendingManagedWakeInputTarget(session,
            byPending.get(JSON.stringify([session.id, session.pendingActivationRequestId])), current);
        return admittedTarget ? [{ sessionId: session.id, current, admittedTarget }] : [];
    });
    const currentness = await areCurrentSessionInputMachineTargetsInTx(tx, candidates.map(candidate => candidate.admittedTarget));
    return new Map(candidates.flatMap((candidate, index) => currentness[index] ? [[candidate.sessionId, candidate.current] as const] : []));
}
