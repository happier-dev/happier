import { PendingRequestedActionV1Schema, type PendingActivationAuthorizationV1, type PendingActivationFailureCodeV1 } from '@happier-dev/protocol';
import type { Tx } from '@/storage/inTx';

type ActivationTarget = Readonly<{ accountId: string; requestId: string }>;

const AUTHORIZATION_SELECT = {
    accountId: true,
    lastActiveAt: true,
    pendingActivationRequestId: true,
    pendingActivationRequestedAt: true,
    pendingActivationStatus: true,
    pendingActivationFailureCode: true,
} as const;

function nextRequestedAt(params: Readonly<{ now: Date; lastActiveAt: Date; priorRequestedAt: Date | null }>): Date {
    return new Date(Math.max(
        params.now.getTime(),
        params.lastActiveAt.getTime() + 1,
        (params.priorRequestedAt?.getTime() ?? -1) + 1,
    ));
}

export function mapPendingActivationAuthorization(row: object): PendingActivationAuthorizationV1 | undefined {
    const value = row as Record<string, unknown>;
    const requestId = value.pendingActivationRequestId;
    const requestedAt = value.pendingActivationRequestedAt;
    const lastActiveAt = value.lastActiveAt;
    const status = value.pendingActivationStatus;
    if (
        typeof requestId !== 'string'
        || !(requestedAt instanceof Date)
        || !(lastActiveAt instanceof Date)
        || requestedAt.getTime() <= lastActiveAt.getTime()
    ) return undefined;
    if (status === 'waiting') return { requestId, requestedAt: requestedAt.getTime(), status };
    if (status === 'failed' && value.pendingActivationFailureCode === 'runtime_start_failed') {
        return { requestId, requestedAt: requestedAt.getTime(), status, failureCode: value.pendingActivationFailureCode };
    }
    return undefined;
}

export async function armPendingActivationAuthorizationInTx(params: Readonly<{
    tx: Tx;
    sessionId: string;
    requestId: string;
    now?: Date;
}>): Promise<ActivationTarget | undefined> {
    const now = params.now ?? new Date();
    const eligible = await params.tx.sessionPendingMessage.findUnique({
        where: { sessionId_localId: { sessionId: params.sessionId, localId: params.requestId } },
        select: {
            messageRole: true,
            status: true,
            deliveryState: true,
            providerAction: true,
            requestedAction: true,
        },
    });
    const requestedAction = PendingRequestedActionV1Schema.safeParse(eligible?.requestedAction);
    if (
        !eligible
        || eligible.messageRole !== 'user'
        || eligible.status !== 'queued'
        || eligible.deliveryState !== null
        || eligible.providerAction !== null
        || !requestedAction.success
        || requestedAction.data.kind !== 'send_now'
    ) return undefined;

    const session = await params.tx.session.findUniqueOrThrow({
        where: { id: params.sessionId },
        select: AUTHORIZATION_SELECT,
    });
    const requestedAt = nextRequestedAt({
        now,
        lastActiveAt: session.lastActiveAt,
        priorRequestedAt: session.pendingActivationRequestedAt,
    });
    await params.tx.session.update({
        where: { id: params.sessionId },
        data: {
            pendingActivationRequestId: params.requestId,
            pendingActivationRequestedAt: requestedAt,
            pendingActivationStatus: 'waiting',
            pendingActivationFailureCode: null,
        },
    });
    return { accountId: session.accountId, requestId: params.requestId };
}

export async function reconcilePendingActivationAuthorizationForRemovedRequestInTx(params: Readonly<{
    tx: Tx;
    sessionId: string;
    requestId: string;
    now?: Date;
}>): Promise<ActivationTarget | undefined> {
    const session = await params.tx.session.findUniqueOrThrow({
        where: { id: params.sessionId },
        select: AUTHORIZATION_SELECT,
    });
    if (session.pendingActivationRequestId !== params.requestId) return undefined;

    await params.tx.session.updateMany({
        where: {
            id: params.sessionId,
            pendingActivationRequestId: params.requestId,
            pendingActivationRequestedAt: session.pendingActivationRequestedAt,
        },
        data: {
            pendingActivationRequestId: null,
            pendingActivationRequestedAt: null,
            pendingActivationStatus: null,
            pendingActivationFailureCode: null,
        },
    });
    return undefined;
}

export async function markPendingActivationAuthorizationFailedInTx(params: Readonly<{
    tx: Tx;
    sessionId: string;
    requestId: string;
    requestedAt: Date;
    failureCode: PendingActivationFailureCodeV1;
}>): Promise<boolean> {
    const updated = await params.tx.session.updateMany({
        where: {
            id: params.sessionId,
            pendingActivationRequestId: params.requestId,
            pendingActivationRequestedAt: params.requestedAt,
            pendingActivationStatus: 'waiting',
            lastActiveAt: { lt: params.requestedAt },
        },
        data: {
            pendingActivationStatus: 'failed',
            pendingActivationFailureCode: params.failureCode,
        },
    });
    return updated.count > 0;
}
