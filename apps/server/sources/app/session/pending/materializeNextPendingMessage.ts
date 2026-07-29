import type { SessionParticipantCursor } from "@/app/session/changeTracking/markSessionParticipantsChanged";
import type { CurrentSessionPublisherAuthority } from "@/app/presence/sessionPublisherPresence";
import { hasExactCurrentPublisherAuthorityInTx } from "@/app/session/pending/hasExactCurrentPublisherAuthorityInTx";
import { markPendingStateChangedParticipants } from "@/app/session/pending/markPendingStateChangedParticipants";
import { resolveSessionPendingOwnerAccess } from "@/app/session/pending/resolveSessionPendingAccess";
import { inTx, type Tx } from "@/storage/inTx";
import { db, isPrismaErrorCode } from "@/storage/db";
import { readEncryptionFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import {
    decideRuntimeIdleAdmission,
    readSessionRuntimeActivityProjectionForPendingDrain,
    isStoredContentKindAllowedForSessionByStoragePolicy,
    normalizePendingRequestedActionV1,
    pendingDeliveryStatusV1ToPersistedFields,
    type SessionMessageRole,
    type SessionStoredContentKind,
} from "@happier-dev/protocol";
import { didSessionActivityBadgeContributionChange } from "@/app/activity/accountActivityBadge";
import { SESSION_TRANSCRIPT_PUBLICATION_SELECT } from "@/app/session/sessionTranscriptPublicationPolicy";
import { resolveSessionMessageRole } from "@/app/session/messageRole/resolveSessionMessageRole";
import { resolvePendingTranscriptCompatibility } from "@/app/session/pending/pendingMessageTranscriptCommit";
import type { SessionReadyProjectionUpdate } from "@/app/session/sessionWriteService";
import { logger } from "@/utils/logging/log";
import {
    selectPendingProviderInvocation,
    type PendingClaimForegroundState,
    type PendingProviderAction,
} from "@/app/session/pending/selectPendingProviderInvocation";

type ParticipantCursor = SessionParticipantCursor;
class PublisherAuthorityLostError extends Error {}
class PendingProviderClaimRaceError extends Error {}
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

export type MaterializeNextPendingMessageResult =
    | {
        ok: true;
        didMaterialize: false;
        pendingCount: number;
        pendingBlockedCount: number;
        pendingVersion: number;
        deferredReason?: "waiting_for_foreground_turn" | "waiting_for_runtime_activity" | "runtime_activity_unknown" | "waiting_for_predecessor" | "steering_unavailable";
        localId?: string;
        pendingStateChanged?: boolean;
        participantCursorsPending?: ParticipantCursor[];
        badgeAttentionChanged?: boolean;
        deliveryState?: PendingMaterializationDeliveryState;
      }
    | {
        ok: true;
        didMaterialize: true;
        didWriteMessage: boolean;
        message: { id: string | null; seq: number | null; localId: string; messageRole: SessionMessageRole | null; content: PrismaJson.SessionMessageContent; requestedAction: import("@happier-dev/protocol").PendingRequestedActionV1; providerAction: PendingProviderAction; createdAt: Date; updatedAt: Date };
        participantCursorsMessage: ParticipantCursor[];
        participantCursorsPending: ParticipantCursor[];
        pendingCount: number;
        pendingBlockedCount: number;
        pendingVersion: number;
        meaningfulActivityAt?: Date;
        badgeAttentionChanged: boolean;
        readyProjection?: SessionReadyProjectionUpdate;
        deliveryState?: PendingMaterializationDeliveryState;
      }
    | { ok: false; error: "session-not-found" | "forbidden" | "invalid-params" | "transcript-conflict" | "internal" };

function toSessionMessageContentFromPending(content: PrismaJson.SessionPendingMessageContent): PrismaJson.SessionMessageContent {
    return content;
}

async function resolvePendingProviderRejoinInTx(params: {
    tx: Tx;
    authority: CurrentSessionPublisherAuthority;
    actorUserId: string;
    sessionId: string;
    materializedDeliveryState: PendingMaterializationDeliveryState;
    noopDeliveryState: PendingMaterializationDeliveryState;
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
            lastViewedSessionSeq: true,
            pendingPermissionRequestCount: true,
            pendingUserActionRequestCount: true,
            active: true,
            archivedAt: true,
        },
    });
    const row = await params.tx.sessionPendingMessage.findFirst({
        where: { sessionId: params.sessionId, status: "queued", deliveryState: "delivering" },
        orderBy: [{ position: "asc" }, { createdAt: "asc" }, { localId: "asc" }],
        select: {
            localId: true,
            messageRole: true,
            content: true,
            requestedAction: true,
            providerAction: true,
            createdAt: true,
            updatedAt: true,
        },
    });
    if (!row) return null;
    if (row.providerAction === null) {
        const blocked = pendingDeliveryStatusV1ToPersistedFields({
            status: "blocked",
            reason: "delivery_outcome_uncertain",
        });
        await params.tx.sessionPendingMessage.update({
            where: { sessionId_localId: { sessionId: params.sessionId, localId: row.localId } },
            data: {
                deliveryState: blocked.deliveryState,
                deliveryBlockedReason: blocked.deliveryBlockedReason,
            },
        });
        const pendingBlockedCount = await params.tx.sessionPendingMessage.count({
            where: { sessionId: params.sessionId, status: "queued", deliveryState: "blocked" },
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
        const participantCursorsPending = await markPendingStateChangedParticipants({
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
            participantCursorsPending: [...participantCursorsPending],
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
        select: { id: true, seq: true, content: true, messageRole: true },
    });
    if (existingTranscriptMessage) {
        const compatibility = resolvePendingTranscriptCompatibility({
            existing: existingTranscriptMessage,
            pending: { content, messageRole },
        });
        if (!compatibility.ok) {
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
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
        },
        participantCursorsMessage: [],
        participantCursorsPending: [],
        pendingCount: session.pendingCount,
        pendingBlockedCount: session.pendingBlockedCount,
        pendingVersion: session.pendingVersion,
        badgeAttentionChanged: false,
        deliveryState: params.materializedDeliveryState,
    };
}

export async function materializeNextPendingMessage(params: {
    actorUserId: string;
    sessionId: string;
    deliveryState: PendingMaterializationDeliveryStateMode;
    deliveryTiming: PendingMaterializationDeliveryTiming;
    foregroundState: PendingClaimForegroundState;
    expectedRuntimeActivityRevision?: number;
    publisherAuthority: CurrentSessionPublisherAuthority;
}): Promise<MaterializeNextPendingMessageResult> {
    return await materializeNextPendingMessageWithRaceRetry(params, true);
}

async function materializeNextPendingMessageWithRaceRetry(params: {
    actorUserId: string;
    sessionId: string;
    deliveryState: PendingMaterializationDeliveryStateMode;
    deliveryTiming: PendingMaterializationDeliveryTiming;
    foregroundState: PendingClaimForegroundState;
    expectedRuntimeActivityRevision?: number;
    publisherAuthority: CurrentSessionPublisherAuthority;
}, retryRace: boolean): Promise<MaterializeNextPendingMessageResult> {
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const materializedDeliveryState = { mode: "provider", unresolved: true } satisfies PendingMaterializationDeliveryState;
    const noopDeliveryState = { mode: "provider", unresolved: false } satisfies PendingMaterializationDeliveryState;
    const foregroundState = params.foregroundState;
    const deliveryTiming = params.deliveryTiming;
    const pendingMessageCandidateWhere = { status: "queued" as const };

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

    const access = await resolveSessionPendingOwnerAccess(actorUserId, sessionId);
    if (!access.ok) return { ok: false, error: access.error };

    const sessionRow = await db.session.findUnique({
        where: { id: sessionId },
        select: {
            encryptionMode: true,
            seq: true,
            pendingCount: true,
            pendingBlockedCount: true,
            pendingVersion: true,
            lastViewedSessionSeq: true,
            pendingPermissionRequestCount: true,
            pendingUserActionRequestCount: true,
            active: true,
            archivedAt: true,
        },
    });
    if (!sessionRow) return { ok: false, error: "session-not-found" };
    if ((sessionRow.pendingCount ?? 0) <= 0) {
        // pendingCount is a denormalized counter; treat it as a fast-path hint, not a source of truth.
        // If the counter is inconsistent (e.g. race/data corruption), fall back to checking the queue.
        const hasEligibleQueued = await db.sessionPendingMessage.findFirst({
            where: { sessionId, ...pendingMessageCandidateWhere },
            orderBy: [{ position: "asc" }, { createdAt: "asc" }, { localId: "asc" }],
            select: { localId: true },
        });
        if (!hasEligibleQueued) {
            const pendingCount = await db.sessionPendingMessage.count({
                where: { sessionId, status: "queued" },
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

    try {
        const result = await inTx(async (tx) => {
            const sessionBefore = await tx.session.findUniqueOrThrow({
                where: { id: sessionId },
                select: {
                    seq: true,
                    ...SESSION_TRANSCRIPT_PUBLICATION_SELECT,
                    pendingCount: true,
                    pendingBlockedCount: true,
                    pendingVersion: true,
                    lastViewedSessionSeq: true,
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
            });
            if (rejoin) return rejoin;

            const pendingCandidates = await tx.sessionPendingMessage.findMany({
                where: { sessionId, ...pendingMessageCandidateWhere },
                orderBy: [{ position: "asc" }, { createdAt: "asc" }, { localId: "asc" }],
                select: { localId: true, messageRole: true, content: true, requestedAction: true, providerAction: true, status: true, deliveryState: true, deliveryBlockedReason: true, position: true, createdAt: true, updatedAt: true },
            });
            const invocationSelection = selectPendingProviderInvocation({
                rows: pendingCandidates,
                foregroundState,
                deliveryTiming,
                readRuntimeActivity: () => {
                    const projection = readSessionRuntimeActivityProjectionForPendingDrain(sessionBefore);
                    if (projection === null) return "unknown";
                    if (decideRuntimeIdleAdmission(projection).decision === "allow") return "idle";
                    return projection.state === "active" ? "active" : "unknown";
                },
            });
            if ("blockedLocalId" in invocationSelection) {
                const blockedFields = pendingDeliveryStatusV1ToPersistedFields({
                    status: "blocked",
                    reason: invocationSelection.blockedReason,
                });
                await tx.sessionPendingMessage.updateMany({
                    where: {
                        sessionId,
                        localId: invocationSelection.blockedLocalId,
                        status: "queued",
                        deliveryState: null,
                    },
                    data: {
                        deliveryState: blockedFields.deliveryState,
                        deliveryBlockedReason: blockedFields.deliveryBlockedReason,
                    },
                });
                const pendingBlockedCount = await tx.sessionPendingMessage.count({
                    where: { sessionId, status: "queued", deliveryState: "blocked" },
                });
                const session = await tx.session.update({
                    where: { id: sessionId },
                    data: { pendingBlockedCount, pendingVersion: { increment: 1 } },
                    select: { pendingCount: true, pendingBlockedCount: true, pendingVersion: true },
                });
                const participantCursorsPending = await markPendingStateChangedParticipants({
                    tx,
                    sessionId,
                    pendingCount: session.pendingCount,
                    pendingBlockedCount: session.pendingBlockedCount,
                    pendingVersion: session.pendingVersion,
                });
                return {
                    ok: true,
                    didMaterialize: false,
                    pendingCount: session.pendingCount,
                    pendingBlockedCount: session.pendingBlockedCount,
                    pendingVersion: session.pendingVersion,
                    pendingStateChanged: true,
                    participantCursorsPending,
                    deferredReason: "steering_unavailable",
                    localId: invocationSelection.blockedLocalId,
                    deliveryState: noopDeliveryState,
                } as const;
            }
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
                    where: { sessionId, status: "queued" },
                });
                const blockedCount = await tx.sessionPendingMessage.count({
                    where: { sessionId, status: "queued", deliveryState: "blocked" },
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
            const requiresRuntimeActivityRevision = deliveryTiming === "after_runtime_idle"
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
                    select: { id: true, seq: true, content: true, messageRole: true },
                });
                if (existingTranscriptMessage) {
                    const compatibility = resolvePendingTranscriptCompatibility({
                        existing: existingTranscriptMessage,
                        pending: { content, messageRole },
                    });
                    if (!compatibility.ok) {
                        return { ok: false, error: "transcript-conflict" } as const;
                    }
                }

                const deliveringFields = pendingDeliveryStatusV1ToPersistedFields({ status: "delivering" });
                const claimed = await tx.sessionPendingMessage.updateMany({
                    where: {
                        sessionId,
                        localId,
                        ...pendingMessageEligibleForMaterializationWhere,
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
                    if (retryRace) throw new PendingProviderClaimRaceError();
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

                const pendingCount = await tx.sessionPendingMessage.count({
                    where: { sessionId, status: "queued" },
                });
                const pendingBlockedCount = await tx.sessionPendingMessage.count({
                    where: { sessionId, status: "queued", deliveryState: "blocked" },
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
                        seq: true,
                        ...SESSION_TRANSCRIPT_PUBLICATION_SELECT,
                        pendingCount: true,
                        pendingBlockedCount: true,
                        pendingVersion: true,
                        lastViewedSessionSeq: true,
                        pendingPermissionRequestCount: true,
                        pendingUserActionRequestCount: true,
                        active: true,
                        archivedAt: true,
                    },
                });

                const participantCursorsPending = await markPendingStateChangedParticipants({
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
                        createdAt: nextPending.createdAt,
                        updatedAt: nextPending.updatedAt,
                    },
                    participantCursorsMessage: [] as ParticipantCursor[],
                    participantCursorsPending,
                    pendingCount: session.pendingCount,
                    pendingBlockedCount: session.pendingBlockedCount,
                    pendingVersion: session.pendingVersion,
                    deliveryState: materializedDeliveryState,
                    badgeAttentionChanged: didSessionActivityBadgeContributionChange(
                        sessionBefore,
                        {
                            seq: session.seq,
                            pendingCount: session.pendingCount,
                            pendingBlockedCount: session.pendingBlockedCount,
                            lastViewedSessionSeq: session.lastViewedSessionSeq,
                            pendingPermissionRequestCount: session.pendingPermissionRequestCount,
                            pendingUserActionRequestCount: session.pendingUserActionRequestCount,
                            active: session.active,
                            archivedAt: session.archivedAt,
                        },
                    ),
            } as const;
        });
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
    } catch (error) {
        if (error instanceof PublisherAuthorityLostError) return { ok: false, error: "forbidden" };
        if (error instanceof PendingProviderClaimRaceError) {
            return await materializeNextPendingMessageWithRaceRetry(params, false);
        }
        if (retryRace && (isPrismaErrorCode(error, "P2002") || isPrismaErrorCode(error, "P2025"))) {
            return await materializeNextPendingMessageWithRaceRetry(params, false);
        }
        return { ok: false, error: "internal" };
    }
}
