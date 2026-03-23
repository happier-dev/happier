import { markSessionParticipantsChanged, type SessionParticipantCursor } from "@/app/session/changeTracking/markSessionParticipantsChanged";
import { db } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";
import { isPrismaErrorCode } from "@/storage/prisma";
import { log } from "@/utils/logging/log";
import { readEncryptionFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import { isStoredContentKindAllowedForSessionByStoragePolicy, type SessionStoredContentKind } from "@happier-dev/protocol";
import { resolveEncryptionWriteRejectionCode, type EncryptionPolicyRejectionCode } from "@/app/session/encryptionRejectionCodes";
import { isDeepStrictEqual } from "node:util";
import { parseSessionMessageSidechainId } from "./parseSessionMessageSidechainId";
import { didSessionActivityBadgeContributionChange, type SessionActivityBadgeInputs } from "@/app/activity/accountActivityBadge";

type ParticipantCursor = SessionParticipantCursor;

function selectSessionActivityBadgeInputs() {
    return {
        seq: true,
        pendingCount: true,
        lastViewedSessionSeq: true,
        pendingPermissionRequestCount: true,
        pendingUserActionRequestCount: true,
        active: true,
        archivedAt: true,
    } as const;
}

function toSessionActivityBadgeInputs(
    value: SessionActivityBadgeInputs | null | undefined,
): SessionActivityBadgeInputs {
    return {
        seq: value?.seq ?? 0,
        pendingCount: value?.pendingCount ?? 0,
        lastViewedSessionSeq: value?.lastViewedSessionSeq ?? null,
        pendingPermissionRequestCount: value?.pendingPermissionRequestCount ?? 0,
        pendingUserActionRequestCount: value?.pendingUserActionRequestCount ?? 0,
        active: value?.active ?? true,
        archivedAt: value?.archivedAt ?? null,
    };
}

type EnsureSessionEditAccessResult =
    | { ok: true; sessionOwnerId: string; sessionEncryptionMode: "e2ee" | "plain" }
    | { ok: false; error: "session-not-found" | "forbidden" };

async function ensureSessionEditAccess(tx: Tx, params: { actorUserId: string; sessionId: string }): Promise<EnsureSessionEditAccessResult> {
    const session = await tx.session.findUnique({
        where: { id: params.sessionId },
        select: { accountId: true, encryptionMode: true },
    });
    if (!session) {
        return { ok: false, error: "session-not-found" };
    }

    const sessionEncryptionMode: "e2ee" | "plain" = session.encryptionMode === "plain" ? "plain" : "e2ee";

    if (session.accountId === params.actorUserId) {
        return { ok: true, sessionOwnerId: session.accountId, sessionEncryptionMode };
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

    return { ok: true, sessionOwnerId: session.accountId, sessionEncryptionMode };
}

async function ensureSessionEditAccessNoTx(params: { actorUserId: string; sessionId: string }): Promise<EnsureSessionEditAccessResult> {
    return await ensureSessionEditAccess(db as unknown as Tx, params);
}

export type CreateSessionMessageResult =
    | {
        ok: true;
        didWrite: true;
        didUpdate: false;
        badgeAttentionChanged: boolean;
        message: {
            id: string;
            seq: number;
            localId: string | null;
            sidechainId: string | null;
            content: PrismaJson.SessionMessageContent;
            createdAt: Date;
            updatedAt: Date;
        };
        participantCursors: ParticipantCursor[];
      }
    | {
        ok: true;
        didWrite: false;
        didUpdate: true;
        badgeAttentionChanged: boolean;
        message: {
            id: string;
            seq: number;
            localId: string | null;
            sidechainId: string | null;
            content: PrismaJson.SessionMessageContent;
            createdAt: Date;
            updatedAt: Date;
        };
        participantCursors: ParticipantCursor[];
      }
    | {
        ok: true;
        didWrite: false;
        didUpdate: false;
        badgeAttentionChanged: false;
        message: {
            id: string;
            seq: number;
            localId: string | null;
            sidechainId: string | null;
            content: PrismaJson.SessionMessageContent;
            createdAt: Date;
            updatedAt: Date;
        };
        participantCursors: [];
      }
    | { ok: false; error: "invalid-params" | "forbidden" | "session-not-found" | "internal"; code?: EncryptionPolicyRejectionCode };

type CreateSessionMessageParamsBase = Readonly<{
    actorUserId: string;
    sessionId: string;
    localId?: string | null;
    sidechainId?: string | null;
}>;

export async function createSessionMessage(
    params: CreateSessionMessageParamsBase &
        (
            | Readonly<{ ciphertext: string; content?: never }>
            | Readonly<{ content: PrismaJson.SessionMessageContent; ciphertext?: never }>
        ),
): Promise<CreateSessionMessageResult> {
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const ciphertext = "ciphertext" in params && typeof params.ciphertext === "string" ? params.ciphertext : "";
    const localId = typeof params.localId === "string" ? params.localId : null;
    const parsedSidechainId = parseSessionMessageSidechainId(params.sidechainId, { emptyString: "invalid" });
    if (!parsedSidechainId.ok) {
        return { ok: false, error: "invalid-params" };
    }
    const sidechainId = parsedSidechainId.sidechainId;

    const content = "content" in params ? params.content : ciphertext ? ({ t: "encrypted", c: ciphertext } satisfies PrismaJson.SessionMessageContent) : null;

    if (!sessionId || !actorUserId || !content) {
        return { ok: false, error: "invalid-params" };
    }

    if (content.t === "encrypted" && (!content.c || typeof content.c !== "string")) {
        return { ok: false, error: "invalid-params" };
    }
    if (content.t === "plain" && !("v" in content)) {
        return { ok: false, error: "invalid-params" };
    }

    try {
        return await inTx(async (tx) => {
            const access = await ensureSessionEditAccess(tx, { actorUserId, sessionId });
            if (!access.ok) {
                return { ok: false, error: access.error };
            }

            const encryptionPolicy = readEncryptionFeatureEnv(process.env);
            const writeKind: SessionStoredContentKind = content.t === "plain" ? "plain" : "encrypted";
            if (
                !isStoredContentKindAllowedForSessionByStoragePolicy(encryptionPolicy.storagePolicy, access.sessionEncryptionMode, writeKind)
            ) {
                return {
                    ok: false,
                    error: "invalid-params",
                    code: resolveEncryptionWriteRejectionCode({
                        storagePolicy: encryptionPolicy.storagePolicy,
                        sessionEncryptionMode: access.sessionEncryptionMode,
                        writeKind,
                    }),
                };
            }

            if (localId) {
                const existing = await tx.sessionMessage.findUnique({
                    where: { sessionId_localId: { sessionId, localId } },
                    select: { id: true, seq: true, localId: true, sidechainId: true, content: true, createdAt: true, updatedAt: true },
                });
                if (existing) {
                    if ((existing.sidechainId ?? null) !== sidechainId) {
                        return { ok: false, error: "invalid-params" };
                    }

                    if (isDeepStrictEqual(existing.content, content)) {
                        return { ok: true, didWrite: false, didUpdate: false, badgeAttentionChanged: false, message: existing, participantCursors: [] };
                    }

                    const updated = await tx.sessionMessage.update({
                        where: { id: existing.id },
                        data: {
                            content,
                            sidechainId,
                        },
                        select: { id: true, seq: true, localId: true, sidechainId: true, content: true, createdAt: true, updatedAt: true },
                    });

                    const participantCursors = await markSessionParticipantsChanged({
                        tx,
                        sessionId,
                        hint: { updatedMessageSeq: updated.seq, updatedMessageId: updated.id },
                    });

                    return {
                        ok: true,
                        didWrite: false,
                        didUpdate: true,
                        badgeAttentionChanged: false,
                        message: updated,
                        participantCursors,
                    };
                }
            }

            const beforeBadgeInputs = await tx.session.findUnique({
                where: { id: sessionId },
                select: selectSessionActivityBadgeInputs(),
            });

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
                    sidechainId,
                },
                select: { id: true, seq: true, localId: true, sidechainId: true, content: true, createdAt: true, updatedAt: true },
            });

            const participantCursors = await markSessionParticipantsChanged({
                tx,
                sessionId,
                hint: { lastMessageSeq: created.seq, lastMessageId: created.id },
            });

            const badgeAttentionChanged = didSessionActivityBadgeContributionChange(
                toSessionActivityBadgeInputs(beforeBadgeInputs),
                {
                    ...toSessionActivityBadgeInputs(beforeBadgeInputs),
                    seq: created.seq,
                },
            );

            return {
                ok: true,
                didWrite: true,
                didUpdate: false,
                badgeAttentionChanged,
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
            const existing = await db.sessionMessage.findUnique({
                where: { sessionId_localId: { sessionId, localId } },
                select: { id: true, seq: true, localId: true, sidechainId: true, content: true, createdAt: true, updatedAt: true },
            });
            if (existing) {
                if ((existing.sidechainId ?? null) !== sidechainId) {
                    return { ok: false, error: "invalid-params" };
                }

                if (isDeepStrictEqual(existing.content, content)) {
                    return { ok: true, didWrite: false, didUpdate: false, badgeAttentionChanged: false, message: existing, participantCursors: [] };
                }

                try {
                    return await inTx(async (tx) => {
                        const updated = await tx.sessionMessage.update({
                            where: { id: existing.id },
                            data: { content, sidechainId },
                            select: { id: true, seq: true, localId: true, sidechainId: true, content: true, createdAt: true, updatedAt: true },
                        });

                        const participantCursors = await markSessionParticipantsChanged({
                            tx,
                            sessionId,
                            hint: { updatedMessageSeq: updated.seq, updatedMessageId: updated.id },
                        });

                        return {
                            ok: true,
                            didWrite: false,
                            didUpdate: true,
                            badgeAttentionChanged: false,
                            message: updated,
                            participantCursors,
                        };
                    });
                } catch {
                    return { ok: false, error: "internal" };
                }
            }
        }
        return { ok: false, error: "internal" };
    }
}

export type UpdateSessionMetadataResult =
    | { ok: true; version: number; metadata: string; participantCursors: ParticipantCursor[]; badgeAttentionChanged: boolean; lastViewedSessionSeq?: number }
    | { ok: false; error: "invalid-params" | "forbidden" | "session-not-found" | "version-mismatch" | "internal"; current?: { version: number; metadata: string } };

export async function updateSessionMetadata(params: {
    actorUserId: string;
    sessionId: string;
    expectedVersion: number;
    metadataCiphertext: string;
    readCursorHintV1?: { lastViewedSessionSeq: number };
}): Promise<UpdateSessionMetadataResult> {
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const metadataCiphertext = typeof params.metadataCiphertext === "string" ? params.metadataCiphertext : "";
    const expectedVersion = typeof params.expectedVersion === "number" ? params.expectedVersion : NaN;
    const lastViewedSessionSeqHint =
        typeof params.readCursorHintV1?.lastViewedSessionSeq === "number" && Number.isFinite(params.readCursorHintV1.lastViewedSessionSeq)
            ? Math.max(0, Math.floor(params.readCursorHintV1.lastViewedSessionSeq))
            : null;

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
                select: {
                    metadataVersion: true,
                    metadata: true,
                    ...selectSessionActivityBadgeInputs(),
                },
            });
            if (!session) {
                return { ok: false, error: "session-not-found" };
            }

            if (session.metadataVersion !== expectedVersion) {
                return { ok: false, error: "version-mismatch", current: { version: session.metadataVersion, metadata: session.metadata } };
            }

            const nextLastViewedSessionSeq = (() => {
                if (typeof lastViewedSessionSeqHint !== "number") return undefined;
                const current = session.lastViewedSessionSeq;
                // Never decrease; also avoid setting above the current server seq.
                const clamped = Math.min(lastViewedSessionSeqHint, session.seq ?? lastViewedSessionSeqHint);
                if (typeof current === "number" && clamped <= current) return undefined;
                return clamped;
            })();

            const { count } = await tx.session.updateMany({
                where: { id: sessionId, metadataVersion: expectedVersion },
                data: {
                    metadata: metadataCiphertext,
                    metadataVersion: expectedVersion + 1,
                    ...(typeof nextLastViewedSessionSeq === "number" ? { lastViewedSessionSeq: nextLastViewedSessionSeq } : {}),
                },
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

            const participantCursors = await markSessionParticipantsChanged({ tx, sessionId });
            const badgeAttentionChanged =
                typeof nextLastViewedSessionSeq === "number"
                    ? didSessionActivityBadgeContributionChange(
                        toSessionActivityBadgeInputs(session),
                        {
                            ...toSessionActivityBadgeInputs(session),
                            lastViewedSessionSeq: nextLastViewedSessionSeq,
                        },
                    )
                    : false;

            return {
                ok: true,
                version: expectedVersion + 1,
                metadata: metadataCiphertext,
                participantCursors,
                badgeAttentionChanged,
                ...(typeof nextLastViewedSessionSeq === "number" ? { lastViewedSessionSeq: nextLastViewedSessionSeq } : {}),
            };
        });
    } catch {
        return { ok: false, error: "internal" };
    }
}

export type UpdateSessionAgentStateResult =
    | {
        ok: true;
        version: number;
        agentState: string | null;
        participantCursors: ParticipantCursor[];
        badgeAttentionChanged: boolean;
        pendingPermissionRequestCount?: number;
        pendingUserActionRequestCount?: number;
      }
    | { ok: false; error: "invalid-params" | "forbidden" | "session-not-found" | "version-mismatch" | "internal"; current?: { version: number; agentState: string | null } };

export async function updateSessionAgentState(params: {
    actorUserId: string;
    sessionId: string;
    expectedVersion: number;
    agentStateCiphertext: string | null;
    pendingPermissionRequestCount?: number;
    pendingUserActionRequestCount?: number;
}): Promise<UpdateSessionAgentStateResult> {
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const expectedVersion = typeof params.expectedVersion === "number" ? params.expectedVersion : NaN;
    const agentStateCiphertext =
        typeof params.agentStateCiphertext === "string" || params.agentStateCiphertext === null ? params.agentStateCiphertext : undefined;
    const pendingPermissionRequestCount =
        typeof params.pendingPermissionRequestCount === "number" && Number.isFinite(params.pendingPermissionRequestCount)
            ? Math.max(0, Math.floor(params.pendingPermissionRequestCount))
            : undefined;
    const pendingUserActionRequestCount =
        typeof params.pendingUserActionRequestCount === "number" && Number.isFinite(params.pendingUserActionRequestCount)
            ? Math.max(0, Math.floor(params.pendingUserActionRequestCount))
            : undefined;

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
                select: {
                    agentStateVersion: true,
                    agentState: true,
                    ...selectSessionActivityBadgeInputs(),
                },
            });
            if (!session) {
                return { ok: false, error: "session-not-found" };
            }

            if (session.agentStateVersion !== expectedVersion) {
                return { ok: false, error: "version-mismatch", current: { version: session.agentStateVersion, agentState: session.agentState } };
            }

            const { count } = await tx.session.updateMany({
                where: { id: sessionId, agentStateVersion: expectedVersion },
                data: {
                    agentState: agentStateCiphertext,
                    agentStateVersion: expectedVersion + 1,
                    ...(typeof pendingPermissionRequestCount === "number"
                        ? { pendingPermissionRequestCount }
                        : {}),
                    ...(typeof pendingUserActionRequestCount === "number"
                        ? { pendingUserActionRequestCount }
                        : {}),
                },
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

            const participantCursors = await markSessionParticipantsChanged({ tx, sessionId });
            const badgeAttentionChanged = didSessionActivityBadgeContributionChange(
                toSessionActivityBadgeInputs(session),
                {
                    ...toSessionActivityBadgeInputs(session),
                    ...(typeof pendingPermissionRequestCount === "number"
                        ? { pendingPermissionRequestCount }
                        : {}),
                    ...(typeof pendingUserActionRequestCount === "number"
                        ? { pendingUserActionRequestCount }
                        : {}),
                },
            );

            return {
                ok: true,
                version: expectedVersion + 1,
                agentState: agentStateCiphertext,
                participantCursors,
                badgeAttentionChanged,
                ...(typeof pendingPermissionRequestCount === "number" ? { pendingPermissionRequestCount } : {}),
                ...(typeof pendingUserActionRequestCount === "number" ? { pendingUserActionRequestCount } : {}),
            };
        });
    } catch {
        return { ok: false, error: "internal" };
    }
}

export type UpdateSessionReadCursorResult =
    | { ok: true; lastViewedSessionSeq: number; participantCursors: ParticipantCursor[]; badgeAttentionChanged: boolean }
    | { ok: false; error: "invalid-params" | "forbidden" | "session-not-found" | "internal" };

export async function updateSessionReadCursor(params: {
    actorUserId: string;
    sessionId: string;
    lastViewedSessionSeq: number;
}): Promise<UpdateSessionReadCursorResult> {
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const incomingCursor =
        typeof params.lastViewedSessionSeq === "number" && Number.isFinite(params.lastViewedSessionSeq)
            ? Math.max(0, Math.floor(params.lastViewedSessionSeq))
            : NaN;

    if (!sessionId || !actorUserId || !Number.isFinite(incomingCursor)) {
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
                select: selectSessionActivityBadgeInputs(),
            });
            if (!session) {
                return { ok: false, error: "session-not-found" };
            }

            const nextCursor = Math.min(incomingCursor, session.seq ?? incomingCursor);
            const currentCursor = typeof session.lastViewedSessionSeq === "number" ? session.lastViewedSessionSeq : -1;
            if (nextCursor <= currentCursor) {
                return {
                    ok: true,
                    lastViewedSessionSeq: Math.max(currentCursor, 0),
                    participantCursors: [],
                    badgeAttentionChanged: false,
                };
            }

            const { count } = await tx.session.updateMany({
                where: { id: sessionId, lastViewedSessionSeq: { lt: nextCursor } },
                data: { lastViewedSessionSeq: nextCursor },
            });

            if (count === 0) {
                const fresh = await tx.session.findUnique({
                    where: { id: sessionId },
                    select: { lastViewedSessionSeq: true },
                });
                return {
                    ok: true,
                    lastViewedSessionSeq: Math.max(fresh?.lastViewedSessionSeq ?? 0, 0),
                    participantCursors: [],
                    badgeAttentionChanged: false,
                };
            }

            const participantCursors = await markSessionParticipantsChanged({ tx, sessionId });
            return {
                ok: true,
                lastViewedSessionSeq: nextCursor,
                participantCursors,
                badgeAttentionChanged: didSessionActivityBadgeContributionChange(
                    toSessionActivityBadgeInputs(session),
                    {
                        ...toSessionActivityBadgeInputs(session),
                        lastViewedSessionSeq: nextCursor,
                    },
                ),
            };
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

            const participantCursors = await markSessionParticipantsChanged({ tx, sessionId });

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
