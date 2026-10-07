import {
    PendingRequestedActionV1Schema,
    SessionInputAdmissionReceiptV1Schema,
    type PendingActivationAuthorizationV1,
    type PendingActivationFailureCodeV1,
} from '@happier-dev/protocol';
import type { Tx } from '@/storage/inTx';
import type { EffectiveSessionAccess } from '@/app/session/access/sessionAccess';

export type PendingActivationTarget = Readonly<{ accountId: string; requestId: string }>;

export function shouldArmPendingActivationAuthorization(params: Readonly<{
    requestedAction: { kind: string };
    resumeWhenAvailable?: boolean;
}>): boolean {
    return params.resumeWhenAvailable === true
        || (params.resumeWhenAvailable !== false && params.requestedAction.kind === 'send_now');
}

const AUTHORIZATION_SELECT = {
    accountId: true,
    lastActiveAt: true,
    pendingActivationRequestId: true,
    pendingActivationRequestedAt: true,
    pendingActivationStatus: true,
    pendingActivationFailureCode: true,
} as const;

const CLEAR_AUTHORIZATION_DATA = {
    pendingActivationRequestId: null,
    pendingActivationRequestedAt: null,
    pendingActivationStatus: null,
    pendingActivationFailureCode: null,
} as const;

function nextRequestedAt(params: Readonly<{
    now: Date;
    lastActiveAt: Date;
    priorRequestedAt: Date | null;
}>): Date {
    return new Date(Math.max(
        params.now.getTime(),
        params.lastActiveAt.getTime() + 1,
        (params.priorRequestedAt?.getTime() ?? -1) + 1,
    ));
}

export function clearPendingActivationAuthorizationForPublisherActivityData() {
    return CLEAR_AUTHORIZATION_DATA;
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
        return {
            requestId,
            requestedAt: requestedAt.getTime(),
            status,
            failureCode: value.pendingActivationFailureCode,
        };
    }
    return undefined;
}

export async function armPendingActivationAuthorizationInTx(params: Readonly<{
    tx: Tx;
    sessionId: string;
    requestId: string;
    /** Access resolved for this mutation's credential in the same transaction. */
    currentAccess: Pick<EffectiveSessionAccess, 'accountId' | 'sessionId' | 'level'>;
    now?: Date;
    resumeWhenAvailable?: true;
}>): Promise<PendingActivationTarget | undefined> {
    // Immutable input provenance is not current mutation authority. An editor
    // may change an owner's queued input without borrowing its owner activation.
    if (params.currentAccess.level !== 'owner' || params.currentAccess.sessionId !== params.sessionId) return undefined;
    const eligible = await params.tx.sessionPendingMessage.findUnique({
        where: { sessionId_localId: { sessionId: params.sessionId, localId: params.requestId }, targetExecutionRunId: null },
        select: {
            messageRole: true,
            status: true,
            deliveryState: true,
            providerAction: true,
            requestedAction: true,
            authorAccountId: true,
            inputAdmissionReceipt: true,
        },
    });
    const requestedAction = PendingRequestedActionV1Schema.safeParse(eligible?.requestedAction);
    const inputAdmissionReceipt = SessionInputAdmissionReceiptV1Schema.safeParse(
        eligible?.inputAdmissionReceipt,
    );
    if (
        !eligible
        || !inputAdmissionReceipt.success
        || inputAdmissionReceipt.data.issuer !== 'authenticatedAccount'
        || eligible.messageRole !== 'user'
        || eligible.status !== 'queued'
        || eligible.deliveryState !== null
        || eligible.providerAction !== null
        || !requestedAction.success
        || !shouldArmPendingActivationAuthorization({
            requestedAction: requestedAction.data,
            resumeWhenAvailable: params.resumeWhenAvailable,
        })
    ) return undefined;

    const session = await params.tx.session.findUniqueOrThrow({
        where: { id: params.sessionId },
        select: AUTHORIZATION_SELECT,
    });
    if (
        inputAdmissionReceipt.data.sessionRelationship !== 'owner'
        || session.accountId !== params.currentAccess.accountId
        || session.accountId !== inputAdmissionReceipt.data.actorAccountId
        || (
            eligible.authorAccountId !== null
            && eligible.authorAccountId !== inputAdmissionReceipt.data.actorAccountId
        )
    ) return undefined;
    const requestedAt = nextRequestedAt({
        now: params.now ?? new Date(),
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
}>): Promise<boolean> {
    const session = await params.tx.session.findUniqueOrThrow({
        where: { id: params.sessionId },
        select: AUTHORIZATION_SELECT,
    });
    if (session.pendingActivationRequestId !== params.requestId) return false;
    const updated = await params.tx.session.updateMany({
        where: {
            id: params.sessionId,
            pendingActivationRequestId: params.requestId,
            pendingActivationRequestedAt: session.pendingActivationRequestedAt,
        },
        data: CLEAR_AUTHORIZATION_DATA,
    });
    return updated.count > 0;
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
