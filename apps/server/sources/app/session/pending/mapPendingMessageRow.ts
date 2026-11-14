import { PendingDeliveryFailureV1Schema, type PendingDeliveryFailureV1 } from '@happier-dev/protocol/sessions/messages/pendingDeliveryStatusV1';
import { parseSessionMessageRole } from "@/app/session/messageRole/resolveSessionMessageRole";
import { normalizePendingDeliveryStatusV1, type PendingDeliveryStatusV1, type PendingDeliveryRecoveryV1 } from '@happier-dev/protocol/sessions/messages/pendingDeliveryStatusV1';
import { PendingRequestedActionV1Schema, PendingRequestedActionV1StoredSchema, type PendingRequestedActionV1 } from '@happier-dev/protocol/sessions/pending/pendingRequestedActionV1';
import { type SessionMessageAccountActorV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageAccountActorV1';
import { readStoredSessionInputAdmissionReceipt } from '@/app/session/messages/sessionInputAdmission';
import type { SessionFollowInputV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowInputV1';

export type PendingMessageRow = {
    failure?: PendingDeliveryFailureV1;
    localId: string;
    /** Public original only; private rule/permission witnesses stay in admission custody. */
    hostFollowInput?: SessionFollowInputV1;
    autonomousExchangeRoot?: import('@happier-dev/protocol/sessions/messages/autonomousExchangeV1').AutonomousExchangeRootV1;
    activationHoldReason?: import('@happier-dev/protocol/sessions/pending/pendingActivationAuthorizationV1').PendingActivationHoldReasonV1;
    recipient?: { kind: "execution_run"; runId: string };
    messageRole: import("@happier-dev/protocol").SessionMessageRole | null;
    content: PrismaJson.SessionPendingMessageContent;
    requestedAction?: PendingRequestedActionV1;
    requestedActionMalformed?: true;
    status: "queued" | "discarded";
    deliveryState: string | null;
    deliveryBlockedReason: string | null;
    deliveryStatus: PendingDeliveryStatusV1;
    recovery: PendingDeliveryRecoveryV1;
    position: number;
    createdAt: Date;
    updatedAt: Date;
    discardedAt: Date | null;
    discardedReason: string | null;
    authorAccountId: string | null;
    accountActor: SessionMessageAccountActorV1 | null;
};

export type PendingMessageRowRaw = {
    deliveryFailure?: unknown;
    autonomousExchangeRootSessionId?: string | null;
    autonomousExchangeRootLocalId?: string | null;
    inputAdmissionReceipt?: unknown;
    providerAction?: unknown;
    replyProgress: unknown;
    localId: string;
    targetExecutionRunId?: string | null;
    messageRole?: unknown;
    content: PrismaJson.SessionPendingMessageContent;
    requestedAction?: unknown;
    status: "queued" | "discarded";
    deliveryState?: string | null;
    deliveryBlockedReason?: string | null;
    position: number;
    createdAt: Date;
    updatedAt: Date;
    discardedAt: Date | null;
    discardedReason: string | null;
    authorAccountId: string | null;
};

/** Shared with Send as new admission: reply custody stays with its exact original. */
export function projectPendingDeliveryRecovery(row: Pick<PendingMessageRowRaw, 'replyProgress'>): PendingDeliveryRecoveryV1 {
    return { canSendAsNew: row.replyProgress === null };
}

export function mapPendingMessageRow(row: PendingMessageRowRaw, accountActor: SessionMessageAccountActorV1 | null = null): PendingMessageRow {
    const parsedRequestedAction = row.requestedAction == null
        ? PendingRequestedActionV1Schema.safeParse({ v: 1, kind: "enqueue" })
        : PendingRequestedActionV1StoredSchema.safeParse(row.requestedAction);
    const requestedActionMalformed = !parsedRequestedAction.success;
    const deliveryState = typeof row.deliveryState === "string" && row.deliveryState.length > 0 ? row.deliveryState : null;
    const deliveryBlockedReason =
        typeof row.deliveryBlockedReason === "string" && row.deliveryBlockedReason.length > 0 ? row.deliveryBlockedReason : null;
    const receipt = readStoredSessionInputAdmissionReceipt(row.inputAdmissionReceipt);
    const failure = row.status === 'discarded' && row.discardedReason === 'resume_failed'
        ? PendingDeliveryFailureV1Schema.parse(row.deliveryFailure ?? { code: 'resume_failed' }) : undefined;
    return {
        localId: row.localId,
        ...(failure ? { failure } : {}),
        ...(receipt?.admittedTarget && receipt.followDeliveryV1 ? { hostFollowInput: receipt.followDeliveryV1 } : {}),
        ...(row.targetExecutionRunId == null ? {} : {
            recipient: { kind: "execution_run" as const, runId: row.targetExecutionRunId },
        }),
        messageRole: parseSessionMessageRole(row.messageRole),
        content: row.content,
        ...(parsedRequestedAction.success ? { requestedAction: parsedRequestedAction.data } : {}),
        ...(requestedActionMalformed ? { requestedActionMalformed: true as const } : {}),
        status: row.status,
        deliveryState,
        deliveryBlockedReason,
        recovery: projectPendingDeliveryRecovery(row),
        deliveryStatus: requestedActionMalformed && row.status !== "discarded"
            ? { status: "blocked", reason: "unsupported_action" }
            : normalizePendingDeliveryStatusV1({
                status: row.status,
                deliveryState,
                deliveryBlockedReason,
                discardedReason: row.discardedReason,
            }),
        position: row.position,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        discardedAt: row.discardedAt,
        discardedReason: row.discardedReason,
        authorAccountId: row.authorAccountId,
        accountActor,
    };
}
