import { checkSessionAccess, requireAccessLevel } from "@/app/share/accessControl";
import { getSessionParticipantUserIds } from "@/app/share/sessionParticipants";
import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { db } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";

type ParticipantCursor = { accountId: string; cursor: number };

export type PendingMessageRow = {
    localId: string;
    content: PrismaJson.SessionPendingMessageContent;
    status: "queued" | "discarded";
    position: number;
    createdAt: Date;
    updatedAt: Date;
    discardedAt: Date | null;
    discardedReason: string | null;
    authorAccountId: string | null;
};

type PendingMessageRowRaw = {
    localId: string;
    content: PrismaJson.SessionPendingMessageContent;
    status: "queued" | "discarded";
    position: number;
    createdAt: Date;
    updatedAt: Date;
    discardedAt: Date | null;
    discardedReason: string | null;
    authorAccountId: string | null;
};

function asPendingRow(row: PendingMessageRowRaw): PendingMessageRow {
    return {
        localId: row.localId,
        content: row.content,
        status: row.status,
        position: row.position,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        discardedAt: row.discardedAt,
        discardedReason: row.discardedReason,
        authorAccountId: row.authorAccountId,
    };
}

type Access =
    | { ok: true; isOwner: boolean }
    | { ok: false; error: "session-not-found" | "forbidden" };

async function ensureViewAccess(actorUserId: string, sessionId: string): Promise<Access> {
    const access = await checkSessionAccess(actorUserId, sessionId);
    if (!access) return { ok: false, error: "session-not-found" };
    return { ok: true, isOwner: access.isOwner };
}

async function ensureEditAccess(actorUserId: string, sessionId: string): Promise<Access> {
    const access = await checkSessionAccess(actorUserId, sessionId);
    if (!access) return { ok: false, error: "session-not-found" };
    if (!requireAccessLevel(access, "edit")) return { ok: false, error: "forbidden" };
    return { ok: true, isOwner: access.isOwner };
}

async function ensureOwnerAccess(actorUserId: string, sessionId: string): Promise<Access> {
    const access = await checkSessionAccess(actorUserId, sessionId);
    if (!access) return { ok: false, error: "session-not-found" };
    if (!access.isOwner) return { ok: false, error: "forbidden" };
    return { ok: true, isOwner: true };
}

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

    const access = await ensureViewAccess(actorUserId, sessionId);
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
            return { ok: true, pending: rows.map(asPendingRow) };
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

        return { ok: true, pending: [...queued.map(asPendingRow), ...discarded.map(asPendingRow)] };
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

    const access = await ensureEditAccess(actorUserId, sessionId);
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
                    pending: asPendingRow(existing),
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

            const session = await tx.session.update({
                where: { id: sessionId },
                data: { pendingCount: { increment: 1 }, pendingVersion: { increment: 1 } },
                select: { pendingCount: true, pendingVersion: true },
            });

            const participantUserIds = await getSessionParticipantUserIds({ sessionId, tx });
            const participantCursors: ParticipantCursor[] = [];
            for (const participantUserId of participantUserIds) {
                const cursor = await markAccountChanged(tx, {
                    accountId: participantUserId,
                    kind: "session",
                    entityId: sessionId,
                    hint: { pendingVersion: session.pendingVersion, pendingCount: session.pendingCount },
                });
                participantCursors.push({ accountId: participantUserId, cursor });
            }

            return {
                ok: true,
                didWrite: true,
                pending: asPendingRow(created),
                pendingCount: session.pendingCount,
                pendingVersion: session.pendingVersion,
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

    const access = await ensureEditAccess(actorUserId, sessionId);
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

            const session = await tx.session.update({
                where: { id: sessionId },
                data: { pendingVersion: { increment: 1 } },
                select: { pendingCount: true, pendingVersion: true },
            });

            const participantUserIds = await getSessionParticipantUserIds({ sessionId, tx });
            const participantCursors: ParticipantCursor[] = [];
            for (const participantUserId of participantUserIds) {
                const cursor = await markAccountChanged(tx, {
                    accountId: participantUserId,
                    kind: "session",
                    entityId: sessionId,
                    hint: { pendingVersion: session.pendingVersion, pendingCount: session.pendingCount },
                });
                participantCursors.push({ accountId: participantUserId, cursor });
            }

            return { ok: true, pendingVersion: session.pendingVersion, pendingCount: session.pendingCount, participantCursors };
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

    const access = await ensureEditAccess(actorUserId, sessionId);
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

            const session = await tx.session.update({
                where: { id: sessionId },
                data: {
                    pendingVersion: { increment: 1 },
                    ...(existing?.status === "queued" ? { pendingCount: { decrement: 1 } } : {}),
                },
                select: { pendingCount: true, pendingVersion: true },
            });

            const participantUserIds = await getSessionParticipantUserIds({ sessionId, tx });
            const participantCursors: ParticipantCursor[] = [];
            for (const participantUserId of participantUserIds) {
                const cursor = await markAccountChanged(tx, {
                    accountId: participantUserId,
                    kind: "session",
                    entityId: sessionId,
                    hint: { pendingVersion: session.pendingVersion, pendingCount: session.pendingCount },
                });
                participantCursors.push({ accountId: participantUserId, cursor });
            }

            return { ok: true, pendingVersion: session.pendingVersion, pendingCount: session.pendingCount, participantCursors };
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

    const access = await ensureEditAccess(actorUserId, sessionId);
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

            const session = await tx.session.update({
                where: { id: sessionId },
                data: {
                    pendingVersion: { increment: 1 },
                    pendingCount: { decrement: 1 },
                },
                select: { pendingCount: true, pendingVersion: true },
            });

            const participantUserIds = await getSessionParticipantUserIds({ sessionId, tx });
            const participantCursors: ParticipantCursor[] = [];
            for (const participantUserId of participantUserIds) {
                const cursor = await markAccountChanged(tx, {
                    accountId: participantUserId,
                    kind: "session",
                    entityId: sessionId,
                    hint: { pendingVersion: session.pendingVersion, pendingCount: session.pendingCount },
                });
                participantCursors.push({ accountId: participantUserId, cursor });
            }

            return { ok: true, pendingVersion: session.pendingVersion, pendingCount: session.pendingCount, participantCursors };
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

    const access = await ensureEditAccess(actorUserId, sessionId);
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

            const session = await tx.session.update({
                where: { id: sessionId },
                data: {
                    pendingVersion: { increment: 1 },
                    ...(existing.status === "discarded" ? { pendingCount: { increment: 1 } } : {}),
                },
                select: { pendingCount: true, pendingVersion: true },
            });

            const participantUserIds = await getSessionParticipantUserIds({ sessionId, tx });
            const participantCursors: ParticipantCursor[] = [];
            for (const participantUserId of participantUserIds) {
                const cursor = await markAccountChanged(tx, {
                    accountId: participantUserId,
                    kind: "session",
                    entityId: sessionId,
                    hint: { pendingVersion: session.pendingVersion, pendingCount: session.pendingCount },
                });
                participantCursors.push({ accountId: participantUserId, cursor });
            }

            return { ok: true, pendingVersion: session.pendingVersion, pendingCount: session.pendingCount, participantCursors };
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

    const access = await ensureEditAccess(actorUserId, sessionId);
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

            const session = await tx.session.update({
                where: { id: sessionId },
                data: { pendingVersion: { increment: 1 } },
                select: { pendingCount: true, pendingVersion: true },
            });

            const participantUserIds = await getSessionParticipantUserIds({ sessionId, tx });
            const participantCursors: ParticipantCursor[] = [];
            for (const participantUserId of participantUserIds) {
                const cursor = await markAccountChanged(tx, {
                    accountId: participantUserId,
                    kind: "session",
                    entityId: sessionId,
                    hint: { pendingVersion: session.pendingVersion, pendingCount: session.pendingCount },
                });
                participantCursors.push({ accountId: participantUserId, cursor });
            }

            return { ok: true, pendingVersion: session.pendingVersion, pendingCount: session.pendingCount, participantCursors };
        });
    } catch {
        return { ok: false, error: "internal" };
    }
}

export type MaterializeNextPendingMessageResult =
    | {
        ok: true;
        didMaterialize: false;
      }
    | {
        ok: true;
        didMaterialize: true;
        didWriteMessage: boolean;
        message: { id: string; seq: number; localId: string; content: PrismaJson.SessionMessageContent; createdAt: Date; updatedAt: Date };
        participantCursorsMessage: ParticipantCursor[];
        participantCursorsPending: ParticipantCursor[];
        pendingCount: number;
        pendingVersion: number;
      }
    | { ok: false; error: "session-not-found" | "forbidden" | "invalid-params" | "internal" };

function toSessionMessageContentFromPending(content: PrismaJson.SessionPendingMessageContent): PrismaJson.SessionMessageContent {
    // Shapes are identical today; keep as a helper so future schema divergence is localized.
    return content;
}

async function createSessionMessageFromPending(tx: Tx, params: { sessionId: string; localId: string; content: PrismaJson.SessionMessageContent }): Promise<{
    didWrite: boolean;
    message: { id: string; seq: number; localId: string; content: PrismaJson.SessionMessageContent; createdAt: Date; updatedAt: Date };
}> {
    const { sessionId, localId, content } = params;

    const existing = await tx.sessionMessage.findFirst({
        where: { sessionId, localId },
        select: { id: true, seq: true, localId: true, content: true, createdAt: true, updatedAt: true },
    });
    if (existing && existing.localId) {
        return {
            didWrite: false,
            message: {
                id: existing.id,
                seq: existing.seq,
                localId: existing.localId,
                content: existing.content as PrismaJson.SessionMessageContent,
                createdAt: existing.createdAt,
                updatedAt: existing.updatedAt,
            },
        };
    }

    const next = await tx.session.update({
        where: { id: sessionId },
        select: { seq: true },
        data: { seq: { increment: 1 } },
    });

    const created = await tx.sessionMessage.create({
        data: {
            sessionId,
            seq: next.seq,
            content,
            localId,
        },
        select: { id: true, seq: true, localId: true, content: true, createdAt: true, updatedAt: true },
    });

    return {
        didWrite: true,
        message: {
            id: created.id,
            seq: created.seq,
            localId: created.localId!,
            content: created.content as PrismaJson.SessionMessageContent,
            createdAt: created.createdAt,
            updatedAt: created.updatedAt,
        },
    };
}

export async function materializeNextPendingMessage(params: {
    actorUserId: string;
    sessionId: string;
}): Promise<MaterializeNextPendingMessageResult> {
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";

    if (!actorUserId || !sessionId) return { ok: false, error: "invalid-params" };

    const access = await ensureOwnerAccess(actorUserId, sessionId);
    if (!access.ok) return { ok: false, error: access.error };

    try {
        return await inTx(async (tx) => {
            const nextPending = await tx.sessionPendingMessage.findFirst({
                where: { sessionId, status: "queued" },
                orderBy: [{ position: "asc" }, { createdAt: "asc" }],
                select: { localId: true, content: true, status: true },
            });

            if (!nextPending) {
                return { ok: true, didMaterialize: false } as const;
            }

            const localId = nextPending.localId;
            const content = toSessionMessageContentFromPending(nextPending.content as PrismaJson.SessionPendingMessageContent);

            const created = await createSessionMessageFromPending(tx, { sessionId, localId, content });

            await tx.sessionPendingMessage.delete({
                where: { sessionId_localId: { sessionId, localId } },
            });

            const didDecrementPendingCount =
                (
                    await tx.session.updateMany({
                        where: { id: sessionId, pendingCount: { gt: 0 } },
                        data: { pendingCount: { decrement: 1 }, pendingVersion: { increment: 1 } },
                    })
                ).count > 0;

            if (!didDecrementPendingCount) {
                await tx.session.update({
                    where: { id: sessionId },
                    data: { pendingCount: 0, pendingVersion: { increment: 1 } },
                });
            }

            const session = await tx.session.findUniqueOrThrow({
                where: { id: sessionId },
                select: { pendingCount: true, pendingVersion: true },
            });

            const participantUserIds = await getSessionParticipantUserIds({ sessionId, tx });
            const participantCursorsMessage: ParticipantCursor[] = [];
            const participantCursorsPending: ParticipantCursor[] = [];
            for (const participantUserId of participantUserIds) {
                // First: message hint (for catch-up).
                const cursorMessage = await markAccountChanged(tx, {
                    accountId: participantUserId,
                    kind: "session",
                    entityId: sessionId,
                    hint: { lastMessageSeq: created.message.seq, lastMessageId: created.message.id },
                });
                participantCursorsMessage.push({ accountId: participantUserId, cursor: cursorMessage });

                // Second: pending hint (for badges).
                const cursorPending = await markAccountChanged(tx, {
                    accountId: participantUserId,
                    kind: "session",
                    entityId: sessionId,
                    hint: { pendingVersion: session.pendingVersion, pendingCount: session.pendingCount },
                });
                participantCursorsPending.push({ accountId: participantUserId, cursor: cursorPending });
            }

            return {
                ok: true,
                didMaterialize: true,
                didWriteMessage: created.didWrite,
                message: created.message,
                participantCursorsMessage,
                participantCursorsPending,
                pendingCount: session.pendingCount,
                pendingVersion: session.pendingVersion,
            } as const;
        });
    } catch {
        return { ok: false, error: "internal" };
    }
}
