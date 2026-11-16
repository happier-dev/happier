import { buildPendingChangedUpdate, eventRouter } from '@/app/events/eventRouter';
import {
    loadSessionTranscriptPublicationRecipientProjection,
    projectSessionTranscriptPublicationPendingProjection,
} from '@/app/session/sessionTranscriptPublicationPolicy';
import { randomKeyNaked } from '@/utils/keys/randomKeyNaked';
import { log } from '@/utils/logging/log';
import { mapPendingActivationAuthorization, readPendingActivationTargetsInTx, type PendingActivationTarget } from './pendingActivationAuthorization';
import { SESSION_ACCESS_SESSION_BATCH_SIZE } from '@/app/session/access/sessionAccess';
import type { ParticipantExecutionRunRecipientRoutingIdentityV1 } from '@happier-dev/protocol/messages/structured/participantMessageV1';
import { inReadSnapshot, inTx, type Tx } from '@/storage/inTx';
import { readPendingManagedWakeTargetInTx } from '@/app/machines/managed/managedWake';
import { listQueuedExecutionRunPendingTargetsForSessions } from '@/app/session/pending/queuedExecutionRunPendingTargets';
import { PendingActivationRequestedEphemeralV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';

export function buildPendingActivationRequestHint(
    activationTarget: PendingActivationTarget | undefined,
): Readonly<{ pendingActivationRequestId: string }> | undefined {
    return activationTarget ? { pendingActivationRequestId: activationTarget.requestId } : undefined;
}

export async function loadPendingActivationPublication(sessionId: string) {
    return (await loadPendingActivationPublicationState(sessionId)).publication;
}

/** One snapshot decides both the published authorization and its current target. */
type PendingActivationPublicationState = Readonly<{
    publication: PendingActivationPublication | null;
    target: PendingActivationTarget | undefined;
}>;

async function loadPendingActivationPublicationState(sessionId: string): Promise<PendingActivationPublicationState> {
    return inReadSnapshot(async tx => {
        const { publications, targets } = await readPendingActivationPublicationsInTx(tx, [sessionId]);
        return { publication: publications.get(sessionId) ?? null, target: targets.get(sessionId) };
    });
}

export async function loadPendingActivationPublicationInTx(tx: Tx, sessionId: string) {
    return (await loadPendingActivationPublicationsInTx(tx, [sessionId])).get(sessionId) ?? null;
}

type PendingActivationPublication = NonNullable<ReturnType<typeof mapPendingActivationAuthorization>>
    & { admittedTarget?: NonNullable<PendingActivationTarget['machinePublication']>['target'] };

export async function loadPendingActivationPublicationsInTx(tx: Tx, sessionIds: readonly string[]) {
    return (await readPendingActivationPublicationsInTx(tx, sessionIds)).publications;
}

async function readPendingActivationPublicationsInTx(tx: Tx, sessionIds: readonly string[]) {
    const result = new Map<string, PendingActivationPublication>();
    const currentTargets = new Map<string, PendingActivationTarget>();
    const ids = [...new Set(sessionIds)];
    for (let offset = 0; offset < ids.length; offset += SESSION_ACCESS_SESSION_BATCH_SIZE) {
        const rows = await tx.session.findMany({
            where: { id: { in: ids.slice(offset, offset + SESSION_ACCESS_SESSION_BATCH_SIZE) } },
            select: {
                id: true,
                lastActiveAt: true,
                pendingActivationRequestId: true,
                pendingActivationRequestedAt: true,
                pendingActivationStatus: true,
                pendingActivationFailureCode: true,
                pendingActivationManagedTarget: true,
            },
        });
        const targets = await readPendingActivationTargetsInTx(tx, rows.filter(row => mapPendingActivationAuthorization(row)?.status === 'waiting').map(row => row.id));
        for (const [id, target] of targets) currentTargets.set(id, target);
        for (const row of rows) {
            const authorization = mapPendingActivationAuthorization(row);
            if (!authorization) continue;
            const target = targets.get(row.id);
            result.set(row.id, { ...authorization, ...(authorization.status === 'waiting' && target?.machinePublication
                ? { admittedTarget: target.machinePublication.target } : {}) });
        }
    }
    return { publications: result, targets: currentTargets };
}

export async function emitPendingChanged(params: {
    sessionId: string;
    changedByAccountId: string;
    pendingCount: number;
    pendingBlockedCount?: number;
    recipient?: ParticipantExecutionRunRecipientRoutingIdentityV1;
    pendingVersion: number;
    meaningfulActivityAt?: Date;
    recipientCursors: Array<{ accountId: string; cursor: number }>;
    activationTarget?: PendingActivationTarget;
}): Promise<void> {
    const sessionRead = loadSessionTranscriptPublicationRecipientProjection(params.sessionId);
    const [session, activationState, ownerRunTargets] = await Promise.all([
        sessionRead,
        loadPendingActivationPublicationState(params.sessionId),
        // The feed hint's owner-scoped projection, pushed so the owner's hosting process needs no
        // feed read to learn its queued Execution Run targets. Only the Session owner receives it.
        sessionRead.then(row => row
            ? listQueuedExecutionRunPendingTargetsForSessions({ accountId: row.accountId, sessionIds: [params.sessionId] })
            : []),
    ]);
    if (!session) return;
    const pendingActivationAuthorization = activationState.publication;
    const pendingExecutionRunIds = ownerRunTargets.map(target => target.runId);
    const rawProjection = {
        pendingCount: params.pendingCount,
        ...(typeof params.pendingBlockedCount === 'number' ? { pendingBlockedCount: params.pendingBlockedCount } : {}),
        ...(params.recipient ? { recipient: params.recipient } : {}),
        pendingVersion: params.pendingVersion,
        changedByAccountId: params.changedByAccountId,
        ...(params.meaningfulActivityAt ? { meaningfulActivityAt: params.meaningfulActivityAt } : {}),
        pendingActivationAuthorization,
    };
    const results = await Promise.allSettled(params.recipientCursors.map(async ({ accountId, cursor }) => {
        const projection = projectSessionTranscriptPublicationPendingProjection(rawProjection, session, accountId);
        if (projection.kind === 'suppress') return;
        eventRouter.emitUpdate({
            userId: accountId,
            payload: buildPendingChangedUpdate(
                { sessionId: params.sessionId, ...projection.value,
                    ...(accountId === session.accountId && pendingExecutionRunIds.length > 0 ? { pendingExecutionRunIds } : {}) },
                cursor,
                randomKeyNaked(12),
            ),
            recipientFilter: { type: 'all-interested-in-session', sessionId: params.sessionId },
        });
    }));
    results.forEach((result, index) => {
        if (result.status === 'fulfilled') return;
        log(
            {
                module: 'session-pending-publication',
                level: 'warn',
                sessionId: params.sessionId,
                accountId: params.recipientCursors[index]?.accountId ?? 'unknown',
            },
            'failed to emit pending-changed update',
            result.reason,
        );
    });
    if (params.activationTarget) {
        // The hint consumes this publication's own decision; it does not authorize the same target again.
        await publishPendingActivationHint({ ...params, activationTarget: params.activationTarget }, activationState);
    }
}

/** The single emitter for lossy machine-scoped activation hints. Durable Session authorization is authoritative. */
export async function emitPendingActivationHint(params: {
    sessionId: string;
    changedByAccountId: string;
    pendingCount: number;
    pendingBlockedCount?: number;
    pendingVersion: number;
    meaningfulActivityAt?: Date;
    recipientCursors: Array<{ accountId: string; cursor: number }>;
    activationTarget: PendingActivationTarget;
}): Promise<void> {
    await publishPendingActivationHint(params, await loadPendingActivationPublicationState(params.sessionId));
}

async function publishPendingActivationHint(
    params: Parameters<typeof emitPendingActivationHint>[0],
    state: PendingActivationPublicationState,
): Promise<void> {
    const authorization = state.publication;
    if (
        authorization?.status !== 'waiting'
        || authorization.requestId !== params.activationTarget.requestId
    ) return;
    const current = state.target;
    if (params.activationTarget.machinePublication) {
        const publication = current?.machinePublication;
        if (publication && current.requestId === params.activationTarget.requestId
            && publication.requestedAt === authorization.requestedAt) {
            await eventRouter.emitEphemeral({
                userId: publication.custodianAccountId,
                payload: PendingActivationRequestedEphemeralV1Schema.parse({ type: 'pending-activation-requested', target: publication.target,
                    requestId: current.requestId, requestedAt: publication.requestedAt, pendingVersion: params.pendingVersion }),
                recipientFilter: { type: 'machine-only', machineId: publication.target.machineId },
            });
        }
    } else {
        // The predecessor owner-only request has no retained selected installation.
        // It never becomes a foreign target or borrows another Account's cursor.
        const ownerCursor = params.recipientCursors.find(
            ({ accountId }) => accountId === params.activationTarget.accountId,
        )?.cursor;
        if (typeof ownerCursor === 'number') {
            const hint = buildPendingActivationRequestHint(params.activationTarget);
            eventRouter.emitUpdate({
                userId: params.activationTarget.accountId,
                payload: buildPendingChangedUpdate(
                    {
                        sessionId: params.sessionId,
                        pendingCount: params.pendingCount,
                        ...(typeof params.pendingBlockedCount === 'number'
                            ? { pendingBlockedCount: params.pendingBlockedCount }
                            : {}),
                        pendingVersion: params.pendingVersion,
                        changedByAccountId: params.changedByAccountId,
                        ...(params.meaningfulActivityAt ? { meaningfulActivityAt: params.meaningfulActivityAt } : {}),
                        pendingActivationAuthorization: authorization,
                        ...hint,
                    },
                    ownerCursor,
                    randomKeyNaked(12),
                ),
                recipientFilter: { type: 'user-machine-scoped-only' },
            });
        }
    }
    const managedWakeTargetV1 = await inTx(tx => readPendingManagedWakeTargetInTx(tx, params.sessionId));
    const controllerPublication = params.activationTarget.managedControllerPublication;
    if (managedWakeTargetV1 && controllerPublication) eventRouter.emitUpdate({
        userId: controllerPublication.accountId,
        payload: buildPendingChangedUpdate({ sessionId: params.sessionId, pendingCount: params.pendingCount,
            pendingVersion: params.pendingVersion, managedWakeTargetV1 }, controllerPublication.cursor, randomKeyNaked(12)),
        recipientFilter: managedWakeTargetV1.controller
            ? { type: 'machine-only', machineId: managedWakeTargetV1.controller.machineId }
            : { type: 'user-machine-scoped-only' },
    });
}
