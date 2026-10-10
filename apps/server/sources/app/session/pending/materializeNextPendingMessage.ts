import type { SessionRecipientCursor } from "@/app/session/changeTracking/markSessionProjectionRecipientsChanged";
import type { CurrentSessionPublisherAuthority } from "@/app/presence/sessionPublisherPresence";
import {
    fenceExactCurrentPublisherAuthorityInTx,
    hasExactCurrentPublisherAuthorityInTx,
    hasCurrentPublisherTargetAdmissionCapabilityInTx,
} from "@/app/session/pending/hasExactCurrentPublisherAuthorityInTx";
import { markPendingStateChangedRecipients } from "@/app/session/pending/markPendingStateChangedRecipients";
import {
    inTx,
    isTransactionAcquisitionUnavailableError,
    isTransactionDeadlineExceededError,
    type Tx,
} from "@/storage/inTx";
import { readEncryptionFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import {
    decideRuntimeIdleAdmission,
    readSessionRuntimeActivityProjectionForPendingDrain,
    isStoredContentKindAllowedForSessionByStoragePolicy,
    normalizePendingRequestedActionV1,
    pendingDeliveryStatusV1ToPersistedFields,
    type SessionMessageRole,
    type SessionInputAdmissionReceiptV1,
    type SessionStoredContentKind,
} from "@happier-dev/protocol";
import { didSessionActivityBadgeSignalChange } from "@/app/activity/accountActivityBadge";
import { SESSION_TRANSCRIPT_PUBLICATION_SELECT } from "@/app/session/sessionTranscriptPublicationPolicy";
import { resolveSessionMessageRole } from "@/app/session/messageRole/resolveSessionMessageRole";
import { compareSessionMessageContentAndRole } from "@/app/session/sessionTranscriptWrite";
import type { SessionReadyProjectionUpdate } from "@/app/session/sessionWriteService";
import { logger } from "@/utils/logging/log";
import {
    selectPendingProviderInvocation,
    type PendingClaimForegroundState,
    type PendingProviderAction,
} from "@/app/session/pending/selectPendingProviderInvocation";
import { reconcilePendingActivationAuthorizationForRemovedRequestInTx } from "@/app/session/pending/pendingActivationAuthorization";
import { readStoredSessionInputAdmissionReceipt, isSessionInputTargetCurrentForPublisherInTx } from '@/app/session/messages/sessionInputAdmission';

type RecipientCursor = SessionRecipientCursor;
class PublisherAuthorityLostError extends Error {}
const pendingMessageEligibleForMaterializationWhere = {
    status: "queued" as const,
    deliveryState: null,
};
export type PendingMaterializationDeliveryStateMode = "provider";
export type PendingMaterializationDeliveryTiming = "after_foreground_ready" | "after_runtime_idle";
export type PendingMaterializationProviderDeliveryState = Readonly<{
    mode: "provider";
    unresolved: boolean;
}>;
export type PendingMaterializationDeliveryState = PendingMaterializationProviderDeliveryState;

type MaterializeNextPendingMessageOutcome =
    | {
        ok: true;
        didMaterialize: false;
        pendingCount: number;
        pendingBlockedCount: number;
        pendingVersion: number;
        deferredReason?: "waiting_for_foreground_turn" | "waiting_for_runtime_activity" | "runtime_activity_unknown" | "waiting_for_predecessor" | "waiting_for_quota_reset";
        localId?: string;
        pendingStateChanged?: boolean;
        recipientCursorsPending?: RecipientCursor[];
        badgeAttentionChanged?: boolean;
        deliveryState?: PendingMaterializationDeliveryState;
      }
    | {
        ok: true;
        didMaterialize: true;
        didWriteMessage: boolean;
        message: { id: string | null; seq: number | null; localId: string; messageRole: SessionMessageRole | null; content: PrismaJson.SessionMessageContent; requestedAction: import("@happier-dev/protocol").PendingRequestedActionV1; providerAction: PendingProviderAction; inputAdmissionReceipt: SessionInputAdmissionReceiptV1 | null; createdAt: Date; updatedAt: Date };
        recipientCursorsMessage: RecipientCursor[];
        recipientCursorsPending: RecipientCursor[];
        pendingCount: number;
        pendingBlockedCount: number;
        pendingVersion: number;
        meaningfulActivityAt?: Date;
        badgeAttentionChanged: boolean;
        readyProjection?: SessionReadyProjectionUpdate;
        deliveryState?: PendingMaterializationDeliveryState;
      }
    | { ok: false; error: "transaction-unavailable"; retryAfterMs: number }
    | { ok: false; error: "session-not-found" | "forbidden" | "invalid-params" | "transcript-conflict" | "internal" | "session_input_target_update_required" };

export type MaterializeNextPendingMessageResult = MaterializeNextPendingMessageOutcome & {
    authorAccountId?: string | null;
    sessionPendingStateForPublication?: { pendingCount: number; pendingBlockedCount: number; pendingVersion: number };
};

function toSessionMessageContentFromPending(content: PrismaJson.SessionPendingMessageContent): PrismaJson.SessionMessageContent {
    return content;
}

function readPendingInputAdmissionReceipt(value: unknown): SessionInputAdmissionReceiptV1 | null {
    return readStoredSessionInputAdmissionReceipt(value) ?? null;
}

async function blockPendingExecutionRunTargetMismatchInTx(params: {
    tx: Tx;
    authority: CurrentSessionPublisherAuthority;
    sessionId: string;
    localId: string;
    targetExecutionRunId: string;
    deliveryState: null | "delivering";
    noopDeliveryState: PendingMaterializationDeliveryState;
}): Promise<MaterializeNextPendingMessageResult> {
    const blocked = pendingDeliveryStatusV1ToPersistedFields({
        status: "blocked",
        reason: "session_input_target_unavailable",
    });
    const updatedRow = await params.tx.sessionPendingMessage.updateMany({
        where: {
            sessionId: params.sessionId,
            localId: params.localId,
            targetExecutionRunId: params.targetExecutionRunId,
            status: "queued",
            deliveryState: params.deliveryState,
        },
        data: {
            status: blocked.status,
            deliveryState: blocked.deliveryState,
            deliveryBlockedReason: blocked.deliveryBlockedReason,
            discardedReason: blocked.discardedReason,
        },
    });
    if (updatedRow.count !== 1) {
        const current = await params.tx.session.findUniqueOrThrow({
            where: { id: params.sessionId },
            select: { pendingCount: true, pendingBlockedCount: true, pendingVersion: true },
        });
        return {
            ok: true,
            didMaterialize: false,
            ...current,
            deliveryState: params.noopDeliveryState,
        };
    }

    const pendingCount = await params.tx.sessionPendingMessage.count({
        where: { sessionId: params.sessionId, targetExecutionRunId: null, status: "queued" },
    });
    const pendingBlockedCount = await params.tx.sessionPendingMessage.count({
        where: { sessionId: params.sessionId, targetExecutionRunId: null, status: "queued", deliveryState: "blocked" },
    });
    const publisherFence = await params.tx.session.updateMany({
        where: {
            id: params.sessionId,
            active: true,
            archivedAt: null,
            lastActiveAt: params.authority.committedFence,
        },
        data: { pendingCount, pendingBlockedCount, pendingVersion: { increment: 1 } },
    });
    if (publisherFence.count !== 1) throw new PublisherAuthorityLostError();
    const session = await params.tx.session.findUniqueOrThrow({
        where: { id: params.sessionId },
        select: { pendingCount: true, pendingBlockedCount: true, pendingVersion: true },
    });
    const recipientCursorsPending = await markPendingStateChangedRecipients({
        tx: params.tx,
        sessionId: params.sessionId,
        pendingCount: session.pendingCount,
        pendingBlockedCount: session.pendingBlockedCount,
        pendingVersion: session.pendingVersion,
    });
    return {
        ok: true,
        didMaterialize: false,
        ...session,
        localId: params.localId,
        pendingStateChanged: true,
        recipientCursorsPending,
        badgeAttentionChanged: false,
        deliveryState: params.noopDeliveryState,
    };
}

async function resolvePendingProviderRejoinInTx(params: {
    tx: Tx;
    authority: CurrentSessionPublisherAuthority;
    actorUserId: string;
    sessionId: string;
    materializedDeliveryState: PendingMaterializationDeliveryState;
    noopDeliveryState: PendingMaterializationDeliveryState;
    targetExecutionRunId: string | null;
    expectedSidechainId: string | null;
}): Promise<MaterializeNextPendingMessageResult | null> {
    if (!await hasExactCurrentPublisherAuthorityInTx(
        params.tx,
        params.authority,
        params.actorUserId,
        params.sessionId,
    )) return { ok: false, error: "forbidden" };

    const session = await params.tx.session.findUniqueOrThrow({
        where: { id: params.sessionId },
        select: {
            encryptionMode: true,
            seq: true,
            pendingCount: true,
            pendingBlockedCount: true,
            pendingVersion: true,
            pendingPermissionRequestCount: true,
            pendingUserActionRequestCount: true,
            active: true,
            archivedAt: true,
        },
    });
    const row = await params.tx.sessionPendingMessage.findFirst({
        where: { sessionId: params.sessionId, targetExecutionRunId: params.targetExecutionRunId, status: "queued", deliveryState: "delivering" },
        orderBy: [{ position: "asc" }, { createdAt: "asc" }, { localId: "asc" }],
        select: {
            localId: true,
            messageRole: true,
            content: true,
            requestedAction: true,
            providerAction: true,
            inputAdmissionReceipt: true,
            createdAt: true,
            updatedAt: true,
        },
    });
    if (!row) return null;
    if (!await isSessionInputTargetCurrentForPublisherInTx(params.tx, row.inputAdmissionReceipt, params.authority)) {
        return { ok: false, error: "forbidden" };
    }
    if (row.providerAction === null) {
        const blocked = pendingDeliveryStatusV1ToPersistedFields({
            status: "blocked",
            reason: "delivery_outcome_uncertain",
        });
        await params.tx.sessionPendingMessage.update({
            where: { sessionId_localId: { sessionId: params.sessionId, localId: row.localId }, targetExecutionRunId: params.targetExecutionRunId },
            data: {
                deliveryState: blocked.deliveryState,
                deliveryBlockedReason: blocked.deliveryBlockedReason,
            },
        });
        const pendingBlockedCount = await params.tx.sessionPendingMessage.count({
            where: { sessionId: params.sessionId, targetExecutionRunId: null, status: "queued", deliveryState: "blocked" },
        });
        const publisherFence = await params.tx.session.updateMany({
            where: {
                id: params.sessionId,
                active: true,
                archivedAt: null,
                lastActiveAt: params.authority.committedFence,
            },
            data: { pendingBlockedCount, pendingVersion: { increment: 1 } },
        });
        if (publisherFence.count !== 1) throw new PublisherAuthorityLostError();
        const updated = await params.tx.session.findUniqueOrThrow({
            where: { id: params.sessionId },
            select: { pendingCount: true, pendingBlockedCount: true, pendingVersion: true },
        });
        const recipientCursorsPending = await markPendingStateChangedRecipients({
            tx: params.tx,
            sessionId: params.sessionId,
            pendingCount: updated.pendingCount,
            pendingBlockedCount: updated.pendingBlockedCount,
            pendingVersion: updated.pendingVersion,
        });
        return {
            ok: true,
            didMaterialize: false,
            ...updated,
            pendingStateChanged: true,
            recipientCursorsPending: [...recipientCursorsPending],
            badgeAttentionChanged: false,
            deliveryState: params.noopDeliveryState,
        };
    }

    const content = toSessionMessageContentFromPending(row.content as PrismaJson.SessionPendingMessageContent);
    if (!await hasExactCurrentPublisherAuthorityInTx(
        params.tx,
        params.authority,
        params.actorUserId,
        params.sessionId,
    )) return { ok: false, error: "forbidden" };
    const storageMode = session.encryptionMode === "plain" ? "plain" as const : "e2ee" as const;
    const messageRole = resolveSessionMessageRole({
        content,
        suppliedRole: row.messageRole,
        telemetry: { sessionId: params.sessionId, storageMode, source: "pending-materialization" },
    }).messageRole;
    const existingTranscriptMessage = await params.tx.sessionMessage.findFirst({
        where: { sessionId: params.sessionId, localId: row.localId },
        select: { id: true, seq: true, sidechainId: true, content: true, messageRole: true },
    });
    if (existingTranscriptMessage) {
        const compatibility = compareSessionMessageContentAndRole({
            existing: existingTranscriptMessage,
            candidate: { content, messageRole },
        });
        if (
            params.targetExecutionRunId !== null
            && existingTranscriptMessage.sidechainId !== params.expectedSidechainId
        ) {
            return await blockPendingExecutionRunTargetMismatchInTx({
                tx: params.tx,
                authority: params.authority,
                sessionId: params.sessionId,
                localId: row.localId,
                targetExecutionRunId: params.targetExecutionRunId,
                deliveryState: "delivering",
                noopDeliveryState: params.noopDeliveryState,
            });
        }
        if (existingTranscriptMessage.sidechainId !== params.expectedSidechainId || compatibility.kind !== "match") {
            return { ok: false, error: "transcript-conflict" };
        }
    }
    if (!await hasExactCurrentPublisherAuthorityInTx(
        params.tx,
        params.authority,
        params.actorUserId,
        params.sessionId,
    )) return { ok: false, error: "forbidden" };
    return {
        ok: true,
        didMaterialize: true,
        didWriteMessage: false,
        message: {
            id: existingTranscriptMessage?.id ?? null,
            seq: existingTranscriptMessage?.seq ?? null,
            localId: row.localId,
            messageRole,
            content,
            requestedAction: normalizePendingRequestedActionV1(row.requestedAction),
            providerAction: row.providerAction,
            inputAdmissionReceipt: readPendingInputAdmissionReceipt(row.inputAdmissionReceipt),
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
        },
        recipientCursorsMessage: [],
        recipientCursorsPending: [],
        pendingCount: session.pendingCount,
        pendingBlockedCount: session.pendingBlockedCount,
        pendingVersion: session.pendingVersion,
        badgeAttentionChanged: false,
        deliveryState: params.materializedDeliveryState,
    };
}

type MaterializeNextPendingMessageParams = Readonly<{
    actorUserId: string;
    sessionId: string;
    deliveryState: PendingMaterializationDeliveryStateMode;
    deliveryTiming: PendingMaterializationDeliveryTiming;
    foregroundState: PendingClaimForegroundState;
    expectedRuntimeActivityRevision?: number;
    publisherAuthority: CurrentSessionPublisherAuthority;
    deadlineAtMs?: number;
    targetExecutionRunId?: string | null;
    expectedSidechainId?: string | null;
}>;

export async function materializeNextPendingMessage(
    params: MaterializeNextPendingMessageParams,
): Promise<MaterializeNextPendingMessageResult> {
    try {
        return await inTx(
            async (tx) => await materializeNextPendingMessageInTx({ ...params, tx }),
            params.deadlineAtMs === undefined ? undefined : { deadlineAtMs: params.deadlineAtMs },
        );
    } catch (error) {
        return mapPendingMaterializationError(error);
    }
}

export function mapPendingMaterializationError(error: unknown): MaterializeNextPendingMessageResult {
    if (error instanceof PublisherAuthorityLostError) return { ok: false, error: "forbidden" };
    if (isTransactionDeadlineExceededError(error) || isTransactionAcquisitionUnavailableError(error)) {
        return { ok: false, error: "transaction-unavailable", retryAfterMs: 1_000 };
    }
    return { ok: false, error: "internal" };
}

export async function materializeNextPendingMessageInTx(
    params: MaterializeNextPendingMessageParams & Readonly<{ tx: Tx }>,
): Promise<MaterializeNextPendingMessageResult> {
    const targetExecutionRunId = params.targetExecutionRunId ?? null;
    const expectedSidechainId = params.expectedSidechainId ?? null;
    if ((targetExecutionRunId === null) !== (expectedSidechainId === null)
        || (targetExecutionRunId !== null && (!targetExecutionRunId.trim() || !expectedSidechainId?.trim()))) {
        return { ok: false, error: "invalid-params" };
    }
    const result = await materializePendingTargetInTx({ ...params, targetExecutionRunId, expectedSidechainId });
    if (!result.ok || targetExecutionRunId === null) return result;
    // Session invalidation keeps main counters; only the exact consumer receives Run counts.
    const where = { sessionId: params.sessionId, targetExecutionRunId, status: "queued" as const };
    const [pendingCount, pendingBlockedCount, author] = await Promise.all([
        params.tx.sessionPendingMessage.count({ where }),
        params.tx.sessionPendingMessage.count({ where: { ...where, deliveryState: "blocked" } }),
        params.tx.sessionPendingMessage.findFirst({
            where: { ...where, ...(result.didMaterialize ? { localId: result.message.localId } : result.localId ? { localId: result.localId } : {}) },
            orderBy: [{ position: "asc" }, { createdAt: "asc" }, { localId: "asc" }],
            select: { authorAccountId: true },
        }),
    ]);
    return {
        ...result,
        pendingCount,
        pendingBlockedCount,
        authorAccountId: author?.authorAccountId ?? null,
        sessionPendingStateForPublication: {
            pendingCount: result.pendingCount,
            pendingBlockedCount: result.pendingBlockedCount,
            pendingVersion: result.pendingVersion,
        },
    };
}

async function materializePendingTargetInTx(
    params: MaterializeNextPendingMessageParams & { tx: Tx; targetExecutionRunId: string | null; expectedSidechainId: string | null },
): Promise<MaterializeNextPendingMessageResult> {
    const tx = params.tx;
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const materializedDeliveryState = { mode: "provider", unresolved: true } satisfies PendingMaterializationDeliveryState;
    const noopDeliveryState = { mode: "provider", unresolved: false } satisfies PendingMaterializationDeliveryState;
    const foregroundState = params.foregroundState;
    const deliveryTiming = params.deliveryTiming;
    const pendingMessageCandidateWhere = { targetExecutionRunId: params.targetExecutionRunId, status: "queued" as const };

    if (!actorUserId || !sessionId) return { ok: false, error: "invalid-params" };
    if (params.deliveryState !== "provider" || !params.publisherAuthority) return { ok: false, error: "forbidden" };
    if (
        foregroundState !== "ready"
        && foregroundState !== "active_steerable"
        && foregroundState !== "active_unsteerable"
    ) {
        return { ok: false, error: "invalid-params" };
    }
    if (deliveryTiming !== "after_foreground_ready" && deliveryTiming !== "after_runtime_idle") {
        return { ok: false, error: "invalid-params" };
    }

    if (!await fenceExactCurrentPublisherAuthorityInTx(
        tx,
        params.publisherAuthority,
        actorUserId,
        sessionId,
    )) return { ok: false, error: "forbidden" };

    if (params.targetExecutionRunId !== null && !await hasCurrentPublisherTargetAdmissionCapabilityInTx(tx, params.publisherAuthority)) {
        return { ok: false, error: "session_input_target_update_required" };
    }

    const sessionRow = await tx.session.findUnique({
        where: { id: sessionId },
        select: {
            accountId: true,
            encryptionMode: true,
            seq: true,
            pendingCount: true,
            pendingBlockedCount: true,
            pendingVersion: true,
            pendingPermissionRequestCount: true,
            pendingUserActionRequestCount: true,
            active: true,
            archivedAt: true,
        },
    });
    if (!sessionRow) return { ok: false, error: "session-not-found" };
    if (sessionRow.accountId !== actorUserId) return { ok: false, error: "forbidden" };
    if (params.targetExecutionRunId === null && (sessionRow.pendingCount ?? 0) <= 0) {
        // pendingCount is a denormalized counter; treat it as a fast-path hint, not a source of truth.
        // If the counter is inconsistent (e.g. race/data corruption), fall back to checking the queue.
        const hasEligibleQueued = await tx.sessionPendingMessage.findFirst({
            where: { sessionId, ...pendingMessageCandidateWhere },
            orderBy: [{ position: "asc" }, { createdAt: "asc" }, { localId: "asc" }],
            select: { localId: true },
        });
        if (!hasEligibleQueued) {
            const pendingCount = await tx.sessionPendingMessage.count({
                where: { sessionId, targetExecutionRunId: null, status: "queued" },
            });
            if (pendingCount <= 0) {
                return {
                    ok: true,
                    didMaterialize: false,
                    pendingCount: sessionRow.pendingCount ?? 0,
                    pendingBlockedCount: sessionRow.pendingBlockedCount ?? 0,
                    pendingVersion: sessionRow.pendingVersion ?? 0,
                    deliveryState: noopDeliveryState,
                };
            }
        }
    }

    const sessionEncryptionMode: "e2ee" | "plain" = sessionRow.encryptionMode === "plain" ? "plain" : "e2ee";
    const policy = readEncryptionFeatureEnv(process.env);

        const result = await (async () => {
            const sessionBefore = await tx.session.findUniqueOrThrow({
                where: { id: sessionId },
                select: {
                    ...SESSION_TRANSCRIPT_PUBLICATION_SELECT,
                    pendingCount: true,
                    pendingBlockedCount: true,
                    pendingVersion: true,
                    pendingPermissionRequestCount: true,
                    pendingUserActionRequestCount: true,
                    active: true,
                    archivedAt: true,
                    lastActiveAt: true,
                    runtimeActivityState: true,
                    runtimeActivityActiveCount: true,
                    runtimeActivityObservedAt: true,
                    runtimeActivityRevision: true,
                },
            });

            const rejoin = await resolvePendingProviderRejoinInTx({
                tx,
                authority: params.publisherAuthority,
                actorUserId,
                sessionId,
                materializedDeliveryState,
                noopDeliveryState,
                targetExecutionRunId: params.targetExecutionRunId,
                expectedSidechainId: params.expectedSidechainId,
            });
            if (rejoin) return rejoin;

            const pendingCandidates = await tx.sessionPendingMessage.findMany({
                where: { sessionId, ...pendingMessageCandidateWhere },
                orderBy: [{ position: "asc" }, { createdAt: "asc" }, { localId: "asc" }],
                select: { localId: true, messageRole: true, content: true, requestedAction: true, providerAction: true, inputAdmissionReceipt: true, status: true, deliveryState: true, deliveryBlockedReason: true, position: true, createdAt: true, updatedAt: true },
            });
            const invocationSelection = selectPendingProviderInvocation({
                rows: pendingCandidates,
                foregroundState,
                deliveryTiming,
                readRuntimeActivity: () => {
                    if (params.targetExecutionRunId !== null) return foregroundState === "ready" ? "idle" : "active";
                    const projection = readSessionRuntimeActivityProjectionForPendingDrain(sessionBefore);
                    if (projection === null) return "unknown";
                    if (decideRuntimeIdleAdmission(projection).decision === "allow") return "idle";
                    return projection.state === "active" ? "active" : "unknown";
                },
            });
            if ("deferredReason" in invocationSelection && invocationSelection.deferredReason !== "no_pending") {
                return {
                    ok: true,
                    didMaterialize: false,
                    pendingCount: sessionBefore.pendingCount,
                    pendingBlockedCount: sessionBefore.pendingBlockedCount,
                    pendingVersion: sessionBefore.pendingVersion,
                    deferredReason: invocationSelection.deferredReason,
                    deliveryState: noopDeliveryState,
                } as const;
            }
            const nextPending = "localId" in invocationSelection
                ? pendingCandidates.find((row) => row.localId === invocationSelection.localId) ?? null
                : null;

            if (!nextPending) {
                const pendingCount = await tx.sessionPendingMessage.count({
                    where: { sessionId, targetExecutionRunId: null, status: "queued" },
                });
                const blockedCount = await tx.sessionPendingMessage.count({
                    where: { sessionId, targetExecutionRunId: null, status: "queued", deliveryState: "blocked" },
                });
                if ((sessionBefore.pendingCount ?? 0) !== pendingCount || (sessionBefore.pendingBlockedCount ?? 0) !== blockedCount) {
                    await tx.session.updateMany({
                        where: {
                            id: sessionId,
                            pendingCount: sessionBefore.pendingCount,
                            pendingBlockedCount: sessionBefore.pendingBlockedCount,
                            pendingVersion: sessionBefore.pendingVersion,
                        },
                        data: { pendingCount, pendingBlockedCount: blockedCount, pendingVersion: { increment: 1 } },
                    });
                    const repaired = await tx.session.findUniqueOrThrow({
                        where: { id: sessionId },
                        select: { pendingCount: true, pendingBlockedCount: true, pendingVersion: true },
                    });
                    return {
                        ok: true,
                        didMaterialize: false,
                        pendingCount: repaired.pendingCount,
                        pendingBlockedCount: repaired.pendingBlockedCount,
                        pendingVersion: repaired.pendingVersion,
                        deliveryState: noopDeliveryState,
                    } as const;
                }

                return {
                    ok: true,
                    didMaterialize: false,
                    pendingCount: sessionBefore.pendingCount,
                    pendingBlockedCount: sessionBefore.pendingBlockedCount,
                    pendingVersion: sessionBefore.pendingVersion,
                    deliveryState: noopDeliveryState,
                } as const;
            }

            const localId = nextPending.localId;
            if (!await isSessionInputTargetCurrentForPublisherInTx(tx, nextPending.inputAdmissionReceipt, params.publisherAuthority)) {
                return { ok: false, error: "forbidden" } as const;
            }
            const providerAction = "localId" in invocationSelection
                ? invocationSelection.providerAction
                : "send";
            const requestedAction = normalizePendingRequestedActionV1(nextPending.requestedAction);
            const isActivityBlindAction = requestedAction.kind === "send_now"
                || requestedAction.kind === "steer_now"
                || (
                    requestedAction.kind === "steer_if_active"
                    && foregroundState === "active_steerable"
                );
            const requiresRuntimeActivityRevision = params.targetExecutionRunId === null && deliveryTiming === "after_runtime_idle"
                && !isActivityBlindAction;
            if (
                requiresRuntimeActivityRevision
                && (
                    !Number.isSafeInteger(params.expectedRuntimeActivityRevision)
                    || (params.expectedRuntimeActivityRevision ?? -1) < 0
                )
            ) {
                return {
                    ok: true,
                    didMaterialize: false,
                    pendingCount: sessionBefore.pendingCount,
                    pendingBlockedCount: sessionBefore.pendingBlockedCount,
                    pendingVersion: sessionBefore.pendingVersion,
                    deferredReason: "runtime_activity_unknown",
                    deliveryState: noopDeliveryState,
                } as const;
            }
            if (
                requiresRuntimeActivityRevision
                && sessionBefore.runtimeActivityRevision !== BigInt(params.expectedRuntimeActivityRevision!)
            ) return { ok: false, error: "forbidden" } as const;
            const content = toSessionMessageContentFromPending(nextPending.content as PrismaJson.SessionPendingMessageContent);
            const messageRole = resolveSessionMessageRole({
                content,
                suppliedRole: nextPending.messageRole,
                telemetry: {
                    sessionId,
                    storageMode: sessionEncryptionMode,
                    source: "pending-materialization",
                },
            }).messageRole;

            const writeKind: SessionStoredContentKind = content.t === "plain" ? "plain" : "encrypted";
            if (!isStoredContentKindAllowedForSessionByStoragePolicy(policy.storagePolicy, sessionEncryptionMode, writeKind)) {
                return { ok: false, error: "invalid-params" } as const;
            }

            const existingTranscriptMessage = await tx.sessionMessage.findFirst({
                    where: { sessionId, localId },
                    select: { id: true, seq: true, sidechainId: true, content: true, messageRole: true },
                });
                if (existingTranscriptMessage) {
                    const compatibility = compareSessionMessageContentAndRole({
                        existing: existingTranscriptMessage,
                        candidate: { content, messageRole },
                    });
                    if (
                        params.targetExecutionRunId !== null
                        && existingTranscriptMessage.sidechainId !== params.expectedSidechainId
                    ) {
                        return await blockPendingExecutionRunTargetMismatchInTx({
                            tx,
                            authority: params.publisherAuthority,
                            sessionId,
                            localId,
                            targetExecutionRunId: params.targetExecutionRunId,
                            deliveryState: null,
                            noopDeliveryState,
                        });
                    }
                    if (existingTranscriptMessage.sidechainId !== params.expectedSidechainId || compatibility.kind !== "match") {
                        return { ok: false, error: "transcript-conflict" } as const;
                    }
                }

                const deliveringFields = pendingDeliveryStatusV1ToPersistedFields({ status: "delivering" });
                const claimed = await tx.sessionPendingMessage.updateMany({
                    where: {
                        sessionId,
                        localId,
                        ...pendingMessageEligibleForMaterializationWhere,
                        targetExecutionRunId: params.targetExecutionRunId,
                        providerAction: null,
                    },
                    data: {
                        status: deliveringFields.status,
                        deliveryState: deliveringFields.deliveryState,
                        deliveryBlockedReason: deliveringFields.deliveryBlockedReason,
                        discardedReason: deliveringFields.discardedReason,
                        providerAction,
                    },
                });
                if (claimed.count === 0) {
                    const latestSession = await tx.session.findUniqueOrThrow({
                        where: { id: sessionId },
                        select: { pendingCount: true, pendingBlockedCount: true, pendingVersion: true },
                    });
                    return {
                        ok: true,
                        didMaterialize: false,
                        pendingCount: latestSession.pendingCount,
                        pendingBlockedCount: latestSession.pendingBlockedCount,
                        pendingVersion: latestSession.pendingVersion,
                        deliveryState: noopDeliveryState,
                    } as const;
                }

                if (params.targetExecutionRunId === null) await reconcilePendingActivationAuthorizationForRemovedRequestInTx({
                    tx,
                    sessionId,
                    requestId: localId,
                });

                const pendingCount = await tx.sessionPendingMessage.count({
                    where: { sessionId, targetExecutionRunId: null, status: "queued" },
                });
                const pendingBlockedCount = await tx.sessionPendingMessage.count({
                    where: { sessionId, targetExecutionRunId: null, status: "queued", deliveryState: "blocked" },
                });
                const sessionFence = await tx.session.updateMany({
                    where: {
                        id: sessionId,
                        active: true,
                        archivedAt: null,
                        lastActiveAt: params.publisherAuthority.committedFence,
                        ...(requiresRuntimeActivityRevision
                            ? { runtimeActivityRevision: BigInt(params.expectedRuntimeActivityRevision!) }
                            : {}),
                    },
                    data: { pendingCount, pendingBlockedCount, pendingVersion: { increment: 1 } },
                });
                if (sessionFence.count !== 1) throw new PublisherAuthorityLostError();
                const session = await tx.session.findUniqueOrThrow({
                    where: { id: sessionId },
                    select: {
                        ...SESSION_TRANSCRIPT_PUBLICATION_SELECT,
                        pendingCount: true,
                        pendingBlockedCount: true,
                        pendingVersion: true,
                        pendingPermissionRequestCount: true,
                        pendingUserActionRequestCount: true,
                        active: true,
                        archivedAt: true,
                    },
                });

                const recipientCursorsPending = await markPendingStateChangedRecipients({
                    tx,
                    sessionId,
                    pendingVersion: session.pendingVersion,
                    pendingCount: session.pendingCount,
                    pendingBlockedCount: session.pendingBlockedCount,
                });

                return {
                    ok: true,
                    didMaterialize: true,
                    didWriteMessage: false,
                    message: {
                        id: existingTranscriptMessage?.id ?? null,
                        seq: existingTranscriptMessage?.seq ?? null,
                        localId,
                        messageRole,
                        content,
                        requestedAction,
                        providerAction,
                        inputAdmissionReceipt: readPendingInputAdmissionReceipt(nextPending.inputAdmissionReceipt),
                        createdAt: nextPending.createdAt,
                        updatedAt: nextPending.updatedAt,
                    },
                    recipientCursorsMessage: [] as RecipientCursor[],
                    recipientCursorsPending,
                    pendingCount: session.pendingCount,
                    pendingBlockedCount: session.pendingBlockedCount,
                    pendingVersion: session.pendingVersion,
                    deliveryState: materializedDeliveryState,
                    badgeAttentionChanged: didSessionActivityBadgeSignalChange(
                        sessionBefore,
                        {
                            seq: session.seq,
                            pendingCount: session.pendingCount,
                            pendingBlockedCount: session.pendingBlockedCount,
                            pendingPermissionRequestCount: session.pendingPermissionRequestCount,
                            pendingUserActionRequestCount: session.pendingUserActionRequestCount,
                            active: session.active,
                            archivedAt: session.archivedAt,
                        },
                    ),
            } as const;
        })();
        if (result.ok && result.didMaterialize) {
            logger.debug({
                sessionId,
                didMaterialize: true,
                localId: result.message.localId,
                messageSeq: result.message.seq,
                messageRole: result.message.messageRole,
                didWriteMessage: result.didWriteMessage,
                pendingCount: result.pendingCount,
                pendingBlockedCount: result.pendingBlockedCount,
                pendingVersion: result.pendingVersion,
            }, "session.pending.materialize");
        }
        return result;
}
