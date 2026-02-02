import { getSessionParticipantUserIds } from "@/app/share/sessionParticipants";
import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { db } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";
import { isPrismaErrorCode } from "@/storage/prisma";
import { log } from "@/utils/log";

type ParticipantCursor = { accountId: string; cursor: number };

type EnsureSessionEditAccessResult =
    | { ok: true; sessionOwnerId: string }
    | { ok: false; error: "session-not-found" | "forbidden" };

async function ensureSessionEditAccess(tx: Tx, params: { actorUserId: string; sessionId: string }): Promise<EnsureSessionEditAccessResult> {
    const session = await tx.session.findUnique({
        where: { id: params.sessionId },
        select: { accountId: true },
    });
    if (!session) {
        return { ok: false, error: "session-not-found" };
    }

    if (session.accountId === params.actorUserId) {
        return { ok: true, sessionOwnerId: session.accountId };
    }

    const share = await tx.sessionShare.findUnique({
        where: {
            sessionId_sharedWithUserId: {
                sessionId: params.sessionId,
                sharedWithUserId: params.actorUserId,
            },
        },
        select: { accessLevel: true },
    });

    if (!share || share.accessLevel === "view") {
        return { ok: false, error: "forbidden" };
    }

    return { ok: true, sessionOwnerId: session.accountId };
}

async function ensureSessionEditAccessNoTx(params: { actorUserId: string; sessionId: string }): Promise<EnsureSessionEditAccessResult> {
    return await ensureSessionEditAccess(db as unknown as Tx, params);
}

export type CreateSessionMessageResult =
    | {
        ok: true;
        didWrite: true;
        message: { id: string; seq: number; localId: string | null; content: PrismaJson.SessionMessageContent; createdAt: Date; updatedAt: Date };
        participantCursors: ParticipantCursor[];
      }
    | {
        ok: true;
        didWrite: false;
        message: { id: string; seq: number; localId: string | null; createdAt: Date };
        participantCursors: [];
      }
    | { ok: false; error: "invalid-params" | "forbidden" | "session-not-found" | "internal" };

export async function createSessionMessage(params: {
    actorUserId: string;
    sessionId: string;
    ciphertext: string;
    localId?: string | null;
}): Promise<CreateSessionMessageResult> {
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const ciphertext = typeof params.ciphertext === "string" ? params.ciphertext : "";
    const localId = typeof params.localId === "string" ? params.localId : null;

    if (!sessionId || !actorUserId || !ciphertext) {
        return { ok: false, error: "invalid-params" };
    }

    try {
        return await inTx(async (tx) => {
            const access = await ensureSessionEditAccess(tx, { actorUserId, sessionId });
            if (!access.ok) {
                return { ok: false, error: access.error };
            }

            if (localId) {
                const existing = await tx.sessionMessage.findFirst({
                    where: { sessionId, localId },
                    select: { id: true, seq: true, localId: true, createdAt: true },
                });
                if (existing) {
                    return { ok: true, didWrite: false, message: existing, participantCursors: [] };
                }
            }

            const next = await tx.session.update({
                where: { id: sessionId },
                select: { seq: true },
                data: { seq: { increment: 1 } },
            });

            const msgContent: PrismaJson.SessionMessageContent = { t: "encrypted", c: ciphertext };
            const created = await tx.sessionMessage.create({
                data: {
                    sessionId,
                    seq: next.seq,
                    content: msgContent,
                    localId,
                },
                select: { id: true, seq: true, localId: true, content: true, createdAt: true, updatedAt: true },
            });

            const participantUserIds = await getSessionParticipantUserIds({ sessionId, tx });
            const participantCursors: ParticipantCursor[] = [];
            for (const participantUserId of participantUserIds) {
                const cursor = await markAccountChanged(tx, {
                    accountId: participantUserId,
                    kind: "session",
                    entityId: sessionId,
                    hint: { lastMessageSeq: created.seq, lastMessageId: created.id },
                });
                participantCursors.push({ accountId: participantUserId, cursor });
            }

            return {
                ok: true,
                didWrite: true,
                message: created,
                participantCursors,
            };
        });
    } catch (e) {
        if (localId && isPrismaErrorCode(e, "P2002")) {
            const target = (e as any)?.meta?.target;
            const isLocalIdConstraint =
                Array.isArray(target)
                    ? target.includes("localId") && target.includes("sessionId")
                    : typeof target === "string"
                        ? target.includes("localId") && target.includes("sessionId")
                        : true;
            if (!isLocalIdConstraint) {
                log({ module: "session-write", level: "error", sessionId, target }, "Unexpected P2002 while creating session message");
                return { ok: false, error: "internal" };
            }
            const access = await ensureSessionEditAccessNoTx({ actorUserId, sessionId });
            if (!access.ok) {
                return { ok: false, error: access.error };
            }
            const existing = await db.sessionMessage.findFirst({
                where: { sessionId, localId },
                select: { id: true, seq: true, localId: true, createdAt: true },
            });
            if (existing) {
                return { ok: true, didWrite: false, message: existing, participantCursors: [] };
            }
        }
        return { ok: false, error: "internal" };
    }
}

export type UpdateSessionMetadataResult =
    | { ok: true; version: number; metadata: string; participantCursors: ParticipantCursor[] }
    | { ok: false; error: "invalid-params" | "forbidden" | "session-not-found" | "version-mismatch" | "internal"; current?: { version: number; metadata: string } };

export async function updateSessionMetadata(params: {
    actorUserId: string;
    sessionId: string;
    expectedVersion: number;
    metadataCiphertext: string;
}): Promise<UpdateSessionMetadataResult> {
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const metadataCiphertext = typeof params.metadataCiphertext === "string" ? params.metadataCiphertext : "";
    const expectedVersion = typeof params.expectedVersion === "number" ? params.expectedVersion : NaN;

    if (!sessionId || !actorUserId || !metadataCiphertext || !Number.isFinite(expectedVersion)) {
        return { ok: false, error: "invalid-params" };
    }

    try {
        return await inTx(async (tx) => {
            const access = await ensureSessionEditAccess(tx, { actorUserId, sessionId });
            if (!access.ok) {
                return { ok: false, error: access.error };
            }

            const session = await tx.session.findUnique({
                where: { id: sessionId },
                select: { metadataVersion: true, metadata: true },
            });
            if (!session) {
                return { ok: false, error: "session-not-found" };
            }

            if (session.metadataVersion !== expectedVersion) {
                return { ok: false, error: "version-mismatch", current: { version: session.metadataVersion, metadata: session.metadata } };
            }

            const { count } = await tx.session.updateMany({
                where: { id: sessionId, metadataVersion: expectedVersion },
                data: { metadata: metadataCiphertext, metadataVersion: expectedVersion + 1 },
            });

            if (count === 0) {
                const fresh = await tx.session.findUnique({
                    where: { id: sessionId },
                    select: { metadataVersion: true, metadata: true },
                });
                if (!fresh) {
                    return { ok: false, error: "session-not-found" };
                }
                return {
                    ok: false,
                    error: "version-mismatch",
                    current: { version: fresh.metadataVersion, metadata: fresh.metadata },
                };
            }

            const participantUserIds = await getSessionParticipantUserIds({ sessionId, tx });
            const participantCursors: ParticipantCursor[] = [];
            for (const participantUserId of participantUserIds) {
                const cursor = await markAccountChanged(tx, { accountId: participantUserId, kind: "session", entityId: sessionId });
                participantCursors.push({ accountId: participantUserId, cursor });
            }

            return { ok: true, version: expectedVersion + 1, metadata: metadataCiphertext, participantCursors };
        });
    } catch {
        return { ok: false, error: "internal" };
    }
}

export type UpdateSessionAgentStateResult =
    | { ok: true; version: number; agentState: string | null; participantCursors: ParticipantCursor[] }
    | { ok: false; error: "invalid-params" | "forbidden" | "session-not-found" | "version-mismatch" | "internal"; current?: { version: number; agentState: string | null } };

export async function updateSessionAgentState(params: {
    actorUserId: string;
    sessionId: string;
    expectedVersion: number;
    agentStateCiphertext: string | null;
}): Promise<UpdateSessionAgentStateResult> {
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const expectedVersion = typeof params.expectedVersion === "number" ? params.expectedVersion : NaN;
    const agentStateCiphertext =
        typeof params.agentStateCiphertext === "string" || params.agentStateCiphertext === null ? params.agentStateCiphertext : undefined;

    if (!sessionId || !actorUserId || !Number.isFinite(expectedVersion) || agentStateCiphertext === undefined) {
        return { ok: false, error: "invalid-params" };
    }

    try {
        return await inTx(async (tx) => {
            const access = await ensureSessionEditAccess(tx, { actorUserId, sessionId });
            if (!access.ok) {
                return { ok: false, error: access.error };
            }

            const session = await tx.session.findUnique({
                where: { id: sessionId },
                select: { agentStateVersion: true, agentState: true },
            });
            if (!session) {
                return { ok: false, error: "session-not-found" };
            }

            if (session.agentStateVersion !== expectedVersion) {
                return { ok: false, error: "version-mismatch", current: { version: session.agentStateVersion, agentState: session.agentState } };
            }

            const { count } = await tx.session.updateMany({
                where: { id: sessionId, agentStateVersion: expectedVersion },
                data: { agentState: agentStateCiphertext, agentStateVersion: expectedVersion + 1 },
            });

            if (count === 0) {
                const fresh = await tx.session.findUnique({
                    where: { id: sessionId },
                    select: { agentStateVersion: true, agentState: true },
                });
                if (!fresh) {
                    return { ok: false, error: "session-not-found" };
                }
                return {
                    ok: false,
                    error: "version-mismatch",
                    current: { version: fresh.agentStateVersion, agentState: fresh.agentState },
                };
            }

            const participantUserIds = await getSessionParticipantUserIds({ sessionId, tx });
            const participantCursors: ParticipantCursor[] = [];
            for (const participantUserId of participantUserIds) {
                const cursor = await markAccountChanged(tx, { accountId: participantUserId, kind: "session", entityId: sessionId });
                participantCursors.push({ accountId: participantUserId, cursor });
            }

            return { ok: true, version: expectedVersion + 1, agentState: agentStateCiphertext, participantCursors };
        });
    } catch {
        return { ok: false, error: "internal" };
    }
}

export type PatchSessionResult =
    | {
        ok: true;
        participantCursors: ParticipantCursor[];
        metadata?: { version: number; value: string | null };
        agentState?: { version: number; value: string | null };
      }
    | {
        ok: false;
        error: "invalid-params" | "forbidden" | "session-not-found" | "version-mismatch" | "internal";
        current?: {
            metadata?: { version: number; value: string | null };
            agentState?: { version: number; value: string | null };
        };
      };

export async function patchSession(params: {
    actorUserId: string;
    sessionId: string;
    metadata?: { ciphertext: string; expectedVersion: number };
    agentState?: { ciphertext: string | null; expectedVersion: number };
}): Promise<PatchSessionResult> {
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const metadata = params.metadata;
    const agentState = params.agentState;

    if (!sessionId || !actorUserId) {
        return { ok: false, error: "invalid-params" };
    }
    if (!metadata && !agentState) {
        return { ok: false, error: "invalid-params" };
    }
    if (metadata && (typeof metadata.ciphertext !== "string" || typeof metadata.expectedVersion !== "number")) {
        return { ok: false, error: "invalid-params" };
    }
    if (agentState && (typeof agentState.expectedVersion !== "number" || (typeof agentState.ciphertext !== "string" && agentState.ciphertext !== null))) {
        return { ok: false, error: "invalid-params" };
    }

    try {
        return await inTx(async (tx) => {
            const access = await ensureSessionEditAccess(tx, { actorUserId, sessionId });
            if (!access.ok) {
                return { ok: false, error: access.error };
            }

            const current = await tx.session.findUnique({
                where: { id: sessionId },
                select: {
                    metadataVersion: true,
                    metadata: true,
                    agentStateVersion: true,
                    agentState: true,
                },
            });

            if (!current) {
                return { ok: false, error: "session-not-found" };
            }

            const mismatchMetadata = metadata && current.metadataVersion !== metadata.expectedVersion;
            const mismatchAgentState = agentState && current.agentStateVersion !== agentState.expectedVersion;
            if (mismatchMetadata || mismatchAgentState) {
                return {
                    ok: false,
                    error: "version-mismatch",
                    current: {
                        ...(metadata ? { metadata: { version: current.metadataVersion, value: current.metadata } } : {}),
                        ...(agentState ? { agentState: { version: current.agentStateVersion, value: current.agentState } } : {}),
                    },
                };
            }

            const updateData: any = {};
            if (metadata) {
                updateData.metadata = metadata.ciphertext;
                updateData.metadataVersion = metadata.expectedVersion + 1;
            }
            if (agentState) {
                updateData.agentState = agentState.ciphertext;
                updateData.agentStateVersion = agentState.expectedVersion + 1;
            }

            const { count } = await tx.session.updateMany({
                where: {
                    id: sessionId,
                    ...(metadata ? { metadataVersion: metadata.expectedVersion } : {}),
                    ...(agentState ? { agentStateVersion: agentState.expectedVersion } : {}),
                },
                data: updateData,
            });

            if (count === 0) {
                const fresh = await tx.session.findUnique({
                    where: { id: sessionId },
                    select: {
                        metadataVersion: true,
                        metadata: true,
                        agentStateVersion: true,
                        agentState: true,
                    },
                });
                if (!fresh) {
                    return { ok: false, error: "session-not-found" };
                }
                return {
                    ok: false,
                    error: "version-mismatch",
                    current: {
                        ...(metadata ? { metadata: { version: fresh.metadataVersion, value: fresh.metadata } } : {}),
                        ...(agentState ? { agentState: { version: fresh.agentStateVersion, value: fresh.agentState } } : {}),
                    },
                };
            }

            const participantUserIds = await getSessionParticipantUserIds({ sessionId, tx });
            const participantCursors: ParticipantCursor[] = [];
            for (const participantUserId of participantUserIds) {
                const cursor = await markAccountChanged(tx, { accountId: participantUserId, kind: "session", entityId: sessionId });
                participantCursors.push({ accountId: participantUserId, cursor });
            }

            return {
                ok: true,
                participantCursors,
                ...(metadata ? { metadata: { version: metadata.expectedVersion + 1, value: metadata.ciphertext } } : {}),
                ...(agentState ? { agentState: { version: agentState.expectedVersion + 1, value: agentState.ciphertext } } : {}),
            };
        });
    } catch {
        return { ok: false, error: "internal" };
    }
}
