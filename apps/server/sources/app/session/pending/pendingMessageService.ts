import type { SessionParticipantCursor } from "@/app/session/changeTracking/markSessionParticipantsChanged";
import { applyPendingSessionStateChange } from "@/app/session/pending/applyPendingSessionStateChange";
import { mapPendingMessageRow } from "@/app/session/pending/mapPendingMessageRow";
import {
    resolveSessionPendingEditAccess,
    resolveSessionPendingViewAccess,
} from "@/app/session/pending/resolveSessionPendingAccess";
import type { PendingMessageRow } from "@/app/session/pending/mapPendingMessageRow";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";

type ParticipantCursor = SessionParticipantCursor;

export type { PendingMessageRow } from "@/app/session/pending/mapPendingMessageRow";

export type ListPendingMessagesResult =
    | { ok: true; pending: PendingMessageRow[] }
    | { ok: false; error: "session-not-found" | "forbidden" | "invalid-params" | "internal" };

export async function listPendingMessages(params: {
    actorUserId: string;
    sessionId: string;
    includeDiscarded?: boolean;
}): Promise<ListPendingMessagesResult> {
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const includeDiscarded = params.includeDiscarded === true;

    if (!actorUserId || !sessionId) return { ok: false, error: "invalid-params" };

    const access = await resolveSessionPendingViewAccess(actorUserId, sessionId);
    if (!access.ok) return { ok: false, error: access.error };

    const select = {
        localId: true,
        content: true,
        status: true,
        position: true,
        createdAt: true,
        updatedAt: true,
        discardedAt: true,
        discardedReason: true,
        authorAccountId: true,
    } as const;

    try {
        if (!includeDiscarded) {
            const rows = await db.sessionPendingMessage.findMany({
                where: { sessionId, status: "queued" },
                orderBy: [{ position: "asc" }, { createdAt: "asc" }],
                select,
            });
            return { ok: true, pending: rows.map(mapPendingMessageRow) };
        }

        const [queued, discarded] = await Promise.all([
            db.sessionPendingMessage.findMany({
                where: { sessionId, status: "queued" },
                orderBy: [{ position: "asc" }, { createdAt: "asc" }],
                select,
            }),
            db.sessionPendingMessage.findMany({
                where: { sessionId, status: "discarded" },
                orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
                select,
            }),
        ]);

        return { ok: true, pending: [...queued.map(mapPendingMessageRow), ...discarded.map(mapPendingMessageRow)] };
    } catch {
        return { ok: false, error: "internal" };
    }
}

export type EnqueuePendingMessageResult =
    | {
        ok: true;
        didWrite: boolean;
        pending: PendingMessageRow;
        pendingCount: number;
        pendingVersion: number;
        participantCursors: ParticipantCursor[];
      }
    | { ok: false; error: "session-not-found" | "forbidden" | "invalid-params" | "internal" };

export async function enqueuePendingMessage(params: {
    actorUserId: string;
    sessionId: string;
    localId: string;
    ciphertext: string;
}): Promise<EnqueuePendingMessageResult> {
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const localId = typeof params.localId === "string" ? params.localId : "";
    const ciphertext = typeof params.ciphertext === "string" ? params.ciphertext : "";

    if (!actorUserId || !sessionId || !localId || !ciphertext) return { ok: false, error: "invalid-params" };

    const access = await resolveSessionPendingEditAccess(actorUserId, sessionId);
    if (!access.ok) return { ok: false, error: access.error };

    try {
        return await inTx(async (tx) => {
            const existing = await tx.sessionPendingMessage.findUnique({
                where: { sessionId_localId: { sessionId, localId } },
                select: {
                    localId: true,
                    content: true,
                    status: true,
                    position: true,
                    createdAt: true,
                    updatedAt: true,
                    discardedAt: true,
                    discardedReason: true,
                    authorAccountId: true,
                },
            });
            if (existing) {
                const session = await tx.session.findUnique({
                    where: { id: sessionId },
                    select: { pendingCount: true, pendingVersion: true },
                });
                return {
                    ok: true,
                    didWrite: false,
                    pending: mapPendingMessageRow(existing),
                    pendingCount: session?.pendingCount ?? 0,
                    pendingVersion: session?.pendingVersion ?? 0,
                    participantCursors: [],
                };
            }

            const lastQueued = await tx.sessionPendingMessage.findFirst({
                where: { sessionId, status: "queued" },
                orderBy: [{ position: "desc" }, { createdAt: "desc" }],
                select: { position: true },
            });
            const position = (lastQueued?.position ?? 0) + 1;
            const content: PrismaJson.SessionPendingMessageContent = { t: "encrypted", c: ciphertext };

            const created = await tx.sessionPendingMessage.create({
                data: {
                    sessionId,
                    localId,
                    content,
                    status: "queued",
                    position,
                    authorAccountId: actorUserId,
                },
                select: {
                    localId: true,
                    content: true,
                    status: true,
                    position: true,
                    createdAt: true,
                    updatedAt: true,
                    discardedAt: true,
                    discardedReason: true,
                    authorAccountId: true,
                },
            });

            const { pendingCount, pendingVersion, participantCursors } = await applyPendingSessionStateChange({
                tx,
                sessionId,
                pendingCountDelta: 1,
            });

            return {
                ok: true,
                didWrite: true,
                pending: mapPendingMessageRow(created),
                pendingCount,
                pendingVersion,
                participantCursors,
            };
        });
    } catch {
        return { ok: false, error: "internal" };
    }
}

export type UpdatePendingMessageResult =
    | { ok: true; pendingVersion: number; pendingCount: number; participantCursors: ParticipantCursor[] }
    | { ok: false; error: "session-not-found" | "forbidden" | "invalid-params" | "not-found" | "internal" };

export async function updatePendingMessage(params: {
    actorUserId: string;
    sessionId: string;
    localId: string;
    ciphertext: string;
}): Promise<UpdatePendingMessageResult> {
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const localId = typeof params.localId === "string" ? params.localId : "";
    const ciphertext = typeof params.ciphertext === "string" ? params.ciphertext : "";

    if (!actorUserId || !sessionId || !localId || !ciphertext) return { ok: false, error: "invalid-params" };

    const access = await resolveSessionPendingEditAccess(actorUserId, sessionId);
    if (!access.ok) return { ok: false, error: access.error };

    try {
        return await inTx(async (tx) => {
            const existing = await tx.sessionPendingMessage.findUnique({
                where: { sessionId_localId: { sessionId, localId } },
                select: { id: true, status: true },
            });
            if (!existing) return { ok: false, error: "not-found" } as const;

            const content: PrismaJson.SessionPendingMessageContent = { t: "encrypted", c: ciphertext };
            await tx.sessionPendingMessage.update({
                where: { sessionId_localId: { sessionId, localId } },
                data: { content },
            });

            const { pendingVersion, pendingCount, participantCursors } = await applyPendingSessionStateChange({
                tx,
                sessionId,
            });
            return { ok: true, pendingVersion, pendingCount, participantCursors };
        });
    } catch {
        return { ok: false, error: "internal" };
    }
}

export type DeletePendingMessageResult =
    | { ok: true; pendingVersion: number; pendingCount: number; participantCursors: ParticipantCursor[] }
    | { ok: false; error: "session-not-found" | "forbidden" | "invalid-params" | "internal" };

export async function deletePendingMessage(params: {
    actorUserId: string;
    sessionId: string;
    localId: string;
}): Promise<DeletePendingMessageResult> {
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const localId = typeof params.localId === "string" ? params.localId : "";

    if (!actorUserId || !sessionId || !localId) return { ok: false, error: "invalid-params" };

    const access = await resolveSessionPendingEditAccess(actorUserId, sessionId);
    if (!access.ok) return { ok: false, error: access.error };

    try {
        return await inTx(async (tx) => {
            const existing = await tx.sessionPendingMessage.findUnique({
                where: { sessionId_localId: { sessionId, localId } },
                select: { status: true },
            });

            if (!existing) {
                const session = await tx.session.findUnique({
                    where: { id: sessionId },
                    select: { pendingCount: true, pendingVersion: true },
                });
                return {
                    ok: true,
                    pendingVersion: session?.pendingVersion ?? 0,
                    pendingCount: session?.pendingCount ?? 0,
                    participantCursors: [],
                };
            }

            await tx.sessionPendingMessage.delete({
                where: { sessionId_localId: { sessionId, localId } },
            });

            const { pendingVersion, pendingCount, participantCursors } = await applyPendingSessionStateChange({
                tx,
                sessionId,
                pendingCountDelta: existing.status === "queued" ? -1 : 0,
            });
            return { ok: true, pendingVersion, pendingCount, participantCursors };
        });
    } catch {
        return { ok: false, error: "internal" };
    }
}

export type DiscardPendingMessageResult =
    | { ok: true; pendingVersion: number; pendingCount: number; participantCursors: ParticipantCursor[] }
    | { ok: false; error: "session-not-found" | "forbidden" | "invalid-params" | "not-found" | "internal" };

export async function discardPendingMessage(params: {
    actorUserId: string;
    sessionId: string;
    localId: string;
    reason?: string;
    now?: Date;
}): Promise<DiscardPendingMessageResult> {
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const localId = typeof params.localId === "string" ? params.localId : "";
    const reason = typeof params.reason === "string" ? params.reason : null;
    const now = params.now instanceof Date ? params.now : new Date();

    if (!actorUserId || !sessionId || !localId) return { ok: false, error: "invalid-params" };

    const access = await resolveSessionPendingEditAccess(actorUserId, sessionId);
    if (!access.ok) return { ok: false, error: access.error };

    try {
        return await inTx(async (tx) => {
            const existing = await tx.sessionPendingMessage.findUnique({
                where: { sessionId_localId: { sessionId, localId } },
                select: { status: true },
            });
            if (!existing) return { ok: false, error: "not-found" } as const;

            if (existing.status !== "queued") {
                const session = await tx.session.findUnique({
                    where: { id: sessionId },
                    select: { pendingCount: true, pendingVersion: true },
                });
                return {
                    ok: true,
                    pendingVersion: session?.pendingVersion ?? 0,
                    pendingCount: session?.pendingCount ?? 0,
                    participantCursors: [],
                } as const;
            }

            await tx.sessionPendingMessage.update({
                where: { sessionId_localId: { sessionId, localId } },
                data: { status: "discarded", discardedAt: now, discardedReason: reason },
            });

            const { pendingVersion, pendingCount, participantCursors } = await applyPendingSessionStateChange({
                tx,
                sessionId,
                pendingCountDelta: -1,
            });
            return { ok: true, pendingVersion, pendingCount, participantCursors };
        });
    } catch {
        return { ok: false, error: "internal" };
    }
}

export type RestorePendingMessageResult =
    | { ok: true; pendingVersion: number; pendingCount: number; participantCursors: ParticipantCursor[] }
    | { ok: false; error: "session-not-found" | "forbidden" | "invalid-params" | "not-found" | "internal" };

export async function restorePendingMessage(params: {
    actorUserId: string;
    sessionId: string;
    localId: string;
}): Promise<RestorePendingMessageResult> {
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const localId = typeof params.localId === "string" ? params.localId : "";

    if (!actorUserId || !sessionId || !localId) return { ok: false, error: "invalid-params" };

    const access = await resolveSessionPendingEditAccess(actorUserId, sessionId);
    if (!access.ok) return { ok: false, error: access.error };

    try {
        return await inTx(async (tx) => {
            const existing = await tx.sessionPendingMessage.findUnique({
                where: { sessionId_localId: { sessionId, localId } },
                select: { status: true },
            });
            if (!existing) return { ok: false, error: "not-found" } as const;

            if (existing.status === "discarded") {
                const lastQueued = await tx.sessionPendingMessage.findFirst({
                    where: { sessionId, status: "queued" },
                    orderBy: [{ position: "desc" }, { createdAt: "desc" }],
                    select: { position: true },
                });
                const position = (lastQueued?.position ?? 0) + 1;

                await tx.sessionPendingMessage.update({
                    where: { sessionId_localId: { sessionId, localId } },
                    data: { status: "queued", discardedAt: null, discardedReason: null, position },
                });
            }

            const { pendingVersion, pendingCount, participantCursors } = await applyPendingSessionStateChange({
                tx,
                sessionId,
                pendingCountDelta: existing.status === "discarded" ? 1 : 0,
            });
            return { ok: true, pendingVersion, pendingCount, participantCursors };
        });
    } catch {
        return { ok: false, error: "internal" };
    }
}

export type ReorderPendingMessagesResult =
    | { ok: true; pendingVersion: number; pendingCount: number; participantCursors: ParticipantCursor[] }
    | { ok: false; error: "session-not-found" | "forbidden" | "invalid-params" | "internal" };

export async function reorderPendingMessages(params: {
    actorUserId: string;
    sessionId: string;
    orderedLocalIds: string[];
}): Promise<ReorderPendingMessagesResult> {
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const orderedLocalIds = Array.isArray(params.orderedLocalIds) ? params.orderedLocalIds.filter((v) => typeof v === "string" && v.length > 0) : [];

    if (!actorUserId || !sessionId || orderedLocalIds.length === 0) return { ok: false, error: "invalid-params" };
    if (new Set(orderedLocalIds).size !== orderedLocalIds.length) return { ok: false, error: "invalid-params" };

    const access = await resolveSessionPendingEditAccess(actorUserId, sessionId);
    if (!access.ok) return { ok: false, error: access.error };

    try {
        return await inTx(async (tx) => {
            const queued = await tx.sessionPendingMessage.findMany({
                where: { sessionId, status: "queued" },
                select: { localId: true },
            });
            const queuedIds = queued.map((v) => v.localId);
            if (queuedIds.length !== orderedLocalIds.length) return { ok: false, error: "invalid-params" } as const;

            const a = new Set(queuedIds);
            for (const id of orderedLocalIds) {
                if (!a.has(id)) return { ok: false, error: "invalid-params" } as const;
            }

            let position = 1;
            for (const localId of orderedLocalIds) {
                await tx.sessionPendingMessage.update({
                    where: { sessionId_localId: { sessionId, localId } },
                    data: { position },
                });
                position++;
            }

            const { pendingVersion, pendingCount, participantCursors } = await applyPendingSessionStateChange({
                tx,
                sessionId,
            });
            return { ok: true, pendingVersion, pendingCount, participantCursors };
        });
    } catch {
        return { ok: false, error: "internal" };
    }
}

export type { MaterializeNextPendingMessageResult } from "@/app/session/pending/materializeNextPendingMessage";
export { materializeNextPendingMessage } from "@/app/session/pending/materializeNextPendingMessage";
