import { buildPendingChangedUpdate, eventRouter } from '@/app/events/eventRouter';
import {
    loadSessionTranscriptPublicationRecipientProjection,
    projectSessionTranscriptPublicationPendingProjection,
} from '@/app/session/sessionTranscriptPublicationPolicy';
import { randomKeyNaked } from '@/utils/keys/randomKeyNaked';
import { log } from '@/utils/logging/log';
import { mapPendingActivationAuthorization, readPendingActivationTargetInTx, type PendingActivationTarget } from './pendingActivationAuthorization';
import type { ParticipantExecutionRunRecipientRoutingIdentityV1 } from '@happier-dev/protocol';
import { inTx, type Tx } from '@/storage/inTx';
import { readPendingManagedWakeTargetInTx } from '@/app/machines/managed/managedWake';
import { PendingActivationRequestedEphemeralV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';

export function buildPendingActivationRequestHint(
    activationTarget: PendingActivationTarget | undefined,
): Readonly<{ pendingActivationRequestId: string }> | undefined {
    return activationTarget ? { pendingActivationRequestId: activationTarget.requestId } : undefined;
}

export async function loadPendingActivationPublication(sessionId: string) {
    return inTx(tx => loadPendingActivationPublicationInTx(tx, sessionId));
}

export async function loadPendingActivationPublicationInTx(tx: Tx, sessionId: string) {
    const row = await tx.session.findUnique({
        where: { id: sessionId },
        select: {
            lastActiveAt: true,
            pendingActivationRequestId: true,
            pendingActivationRequestedAt: true,
            pendingActivationStatus: true,
            pendingActivationFailureCode: true,
            pendingActivationManagedTarget: true,
        },
    });
    if (!row) return null;
    const authorization = mapPendingActivationAuthorization(row);
    if (authorization?.status !== 'waiting') return authorization ?? null;
    const target = await readPendingActivationTargetInTx(tx, sessionId);
    return { ...authorization, ...(target?.machinePublication ? { admittedTarget: target.machinePublication.target } : {}) };
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
    const [session, pendingActivationAuthorization] = await Promise.all([
        loadSessionTranscriptPublicationRecipientProjection(params.sessionId),
        loadPendingActivationPublication(params.sessionId),
    ]);
    if (!session) return;
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
                { sessionId: params.sessionId, ...projection.value },
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
        await emitPendingActivationHint({ ...params, activationTarget: params.activationTarget });
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
    const authorization = await loadPendingActivationPublication(params.sessionId);
    if (
        authorization?.status !== 'waiting'
        || authorization.requestId !== params.activationTarget.requestId
    ) return;
    const current = await inTx(tx => readPendingActivationTargetInTx(tx, params.sessionId));
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
        recipientFilter: { type: 'machine-only', machineId: managedWakeTargetV1.controller.machineId },
    });
}
