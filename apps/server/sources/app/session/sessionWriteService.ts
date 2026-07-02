import { markSessionParticipantsChanged, type SessionParticipantCursor } from "@/app/session/changeTracking/markSessionParticipantsChanged";
import { observeCreateSessionMessageStage } from "@/app/monitoring/metrics/sessionWriteMetrics";
import { db } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";
import { isPrismaErrorCode } from "@/storage/prisma";
import { log } from "@/utils/logging/log";
import { readEncryptionFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import {
    isStoredContentKindAllowedForSessionByStoragePolicy,
    PrimaryTurnStatusV1Schema,
    TranscriptRawRecordV1Schema,
    SessionTurnMutationV1Schema,
    SessionRuntimeIssueV1Schema,
    type PrimaryTurnStatusV1,
    type SessionMessageRole,
    type SessionRuntimeIssueV1,
    type SessionStoredContentKind,
    type SessionTurnMutationDecisionV1,
    type SessionTurnMutationReceiptV1,
    type SessionTurnMutationV1,
} from "@happier-dev/protocol";
import { resolveEncryptionWriteRejectionCode, type EncryptionPolicyRejectionCode } from "@/app/session/encryptionRejectionCodes";
import { isDeepStrictEqual } from "node:util";
import { parseSessionMessageSidechainId } from "./parseSessionMessageSidechainId";
import { didSessionActivityBadgeContributionChange, type SessionActivityBadgeInputs } from "@/app/activity/accountActivityBadge";
import {
    resolveSessionReadCursorOperation,
    type SessionReadCursorOperation,
    type SessionReadCursorReadState,
} from "./readCursor/resolveSessionReadCursorOperation";
import { parseSessionMessageRole, resolveSessionMessageRole } from "./messageRole/resolveSessionMessageRole";

type ParticipantCursor = SessionParticipantCursor;

type SessionMessageWriteRow = {
    id: string;
    seq: number;
    localId: string | null;
    sidechainId: string | null;
    messageRole: SessionMessageRole | null;
    content: PrismaJson.SessionMessageContent;
    createdAt: Date;
    updatedAt: Date;
};

const SESSION_MESSAGE_WRITE_SELECT = {
    id: true,
    seq: true,
    localId: true,
    sidechainId: true,
    messageRole: true,
    content: true,
    createdAt: true,
    updatedAt: true,
} as const;

function toSessionMessageWriteRow(row: Omit<SessionMessageWriteRow, "messageRole"> & { messageRole: unknown }): SessionMessageWriteRow {
    return {
        ...row,
        messageRole: parseSessionMessageRole(row.messageRole),
    };
}

export async function updateSessionMessageActivityProjection(
    tx: Tx,
    params: Readonly<{
        sessionId: string;
        created: Pick<SessionMessageWriteRow, "seq" | "createdAt">;
        trustedSessionEventType?: "ready";
    }>,
): Promise<SessionReadyProjectionUpdate | undefined> {
    await tx.session.updateMany({
        where: { id: params.sessionId, seq: params.created.seq },
        data: {
            meaningfulActivityAt: params.created.createdAt,
        },
    });

    if (params.trustedSessionEventType !== "ready") return undefined;

    const readyProjection: SessionReadyProjectionUpdate = {
        latestReadyEventSeq: params.created.seq,
        latestReadyEventAt: params.created.createdAt.getTime(),
    };
    const update = await tx.session.updateMany({
        where: {
            id: params.sessionId,
            OR: [
                { latestReadyEventSeq: null },
                { latestReadyEventSeq: { lt: params.created.seq } },
            ],
        },
        data: {
            latestReadyEventSeq: params.created.seq,
            latestReadyEventAt: params.created.createdAt,
        },
    });
    return update.count > 0 ? readyProjection : undefined;
}

export function resolveReadyProjectionEventType(params: Readonly<{
    actorUserId: string;
    sessionOwnerId: string;
    content: PrismaJson.SessionMessageContent;
    requestedSessionEventType?: "ready";
}>): "ready" | undefined {
    if (params.actorUserId !== params.sessionOwnerId) return undefined;
    if (params.requestedSessionEventType === "ready") return "ready";
    if (params.content.t !== "plain") return undefined;

    const parsed = TranscriptRawRecordV1Schema.safeParse(params.content.v);
    if (!parsed.success) return undefined;

    return parsed.data.role === "agent"
        && parsed.data.content.type === "event"
        && parsed.data.content.data.type === "ready"
        ? "ready"
        : undefined;
}

function selectSessionActivityBadgeInputs() {
    return {
        seq: true,
        pendingCount: true,
        lastViewedSessionSeq: true,
        pendingPermissionRequestCount: true,
        pendingUserActionRequestCount: true,
        latestTurnStatus: true,
        lastRuntimeIssue: true,
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
        latestTurnStatus: value?.latestTurnStatus ?? null,
        lastRuntimeIssue: value?.lastRuntimeIssue ?? null,
        active: value?.active ?? true,
        archivedAt: value?.archivedAt ?? null,
    };
}

function parseStoredPrimaryTurnStatus(value: unknown): PrimaryTurnStatusV1 | null {
    const parsed = PrimaryTurnStatusV1Schema.safeParse(value);
    return parsed.success ? parsed.data : null;
}

function parseStoredRuntimeIssue(value: unknown): SessionRuntimeIssueV1 | null {
    if (!value) return null;
    if (typeof value === "string") {
        try {
            const parsed = SessionRuntimeIssueV1Schema.safeParse(JSON.parse(value));
            return parsed.success ? parsed.data : null;
        } catch {
            return null;
        }
    }
    const parsed = SessionRuntimeIssueV1Schema.safeParse(value);
    return parsed.success ? parsed.data : null;
}

function buildLegacyThinkingProjectionWriteData(params: Readonly<{
    latestTurnStatus: unknown;
    latestTurnStatusObservedAt: bigint | number | null;
}>): { thinking?: boolean; thinkingAt?: Date } {
    const latestTurnStatus = parseStoredPrimaryTurnStatus(params.latestTurnStatus);
    const observedAt =
        typeof params.latestTurnStatusObservedAt === "bigint"
            ? Number(params.latestTurnStatusObservedAt)
            : params.latestTurnStatusObservedAt;
    if (typeof observedAt !== "number" || !Number.isFinite(observedAt)) {
        return {};
    }
    if (latestTurnStatus === "in_progress") {
        return {
            thinking: true,
            thinkingAt: new Date(observedAt),
        };
    }
    if (
        latestTurnStatus === "completed"
        || latestTurnStatus === "cancelled"
        || latestTurnStatus === "failed"
    ) {
        return {
            thinking: false,
            thinkingAt: new Date(observedAt),
        };
    }
    return {};
}

type EnsureSessionEditAccessResult =
    | {
        ok: true;
        sessionOwnerId: string;
        sessionEncryptionMode: "e2ee" | "plain";
        participantUserIds: string[];
        sessionActivityBadgeInputs: SessionActivityBadgeInputs;
      }
    | { ok: false; error: "session-not-found" | "forbidden" };

function extractSessionParticipantUserIds(session: {
    accountId: string;
    shares?: ReadonlyArray<{ sharedWithUserId: string }>;
}): string[] {
    const participantUserIds = new Set<string>([session.accountId]);

    for (const share of session.shares ?? []) {
        if (typeof share.sharedWithUserId === "string" && share.sharedWithUserId) {
            participantUserIds.add(share.sharedWithUserId);
        }
    }

    return Array.from(participantUserIds);
}

async function ensureSessionEditAccess(tx: Tx, params: { actorUserId: string; sessionId: string }): Promise<EnsureSessionEditAccessResult> {
    const session = await tx.session.findUnique({
        where: { id: params.sessionId },
        select: {
            accountId: true,
            encryptionMode: true,
            ...selectSessionActivityBadgeInputs(),
            shares: {
                select: {
                    sharedWithUserId: true,
                },
            },
        },
    });
    if (!session) {
        return { ok: false, error: "session-not-found" };
    }

    const sessionEncryptionMode: "e2ee" | "plain" = session.encryptionMode === "plain" ? "plain" : "e2ee";
    const participantUserIds = extractSessionParticipantUserIds(session);
    const sessionActivityBadgeInputs = toSessionActivityBadgeInputs(session);

    if (session.accountId === params.actorUserId) {
        return { ok: true, sessionOwnerId: session.accountId, sessionEncryptionMode, participantUserIds, sessionActivityBadgeInputs };
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

    return { ok: true, sessionOwnerId: session.accountId, sessionEncryptionMode, participantUserIds, sessionActivityBadgeInputs };
}

async function ensureSessionEditAccessNoTx(params: { actorUserId: string; sessionId: string }): Promise<EnsureSessionEditAccessResult> {
    return await ensureSessionEditAccess(db as unknown as Tx, params);
}

function isSessionMessageLocalIdConstraintTarget(target: unknown): boolean {
    if (Array.isArray(target)) {
        return target.includes("localId") && target.includes("sessionId");
    }
    if (typeof target === "string") {
        return target.includes("localId") && target.includes("sessionId");
    }
    return true;
}

function readUnknownProperty(value: unknown, key: string): unknown {
    if (value === null || (typeof value !== "object" && typeof value !== "function")) {
        return undefined;
    }
    return (value as Record<string, unknown>)[key];
}

function readPrismaErrorMetadata(error: unknown): { target?: unknown; message?: unknown } {
    const meta = readUnknownProperty(error, "meta");
    return {
        target: readUnknownProperty(meta, "target"),
        message: readUnknownProperty(meta, "message"),
    };
}

function isSessionMessageLocalIdConflict(error: unknown): boolean {
    const { target } = readPrismaErrorMetadata(error);
    return isPrismaErrorCode(error, "P2002")
        && isSessionMessageLocalIdConstraintTarget(target);
}

function isDuplicateSessionTurnMutationRace(error: unknown): boolean {
    if (!isPrismaErrorCode(error, "P2002")) return false;
    const { target } = readPrismaErrorMetadata(error);
    const targetFields = Array.isArray(target)
        ? target.filter((value): value is string => typeof value === "string")
        : typeof target === "string"
            ? [target]
            : [];
    if (targetFields.length === 0) return true;
    const joined = targetFields.join(",");
    return (
        (joined.includes("sessionId") && joined.includes("mutationId"))
        || (joined.includes("sessionId") && joined.includes("turnId"))
    );
}

export type CreateSessionMessageResult =
    | {
        ok: true;
        didWrite: true;
        didUpdate: false;
        badgeAttentionChanged: boolean;
        message: SessionMessageWriteRow;
        participantCursors: ParticipantCursor[];
        readyProjection?: SessionReadyProjectionUpdate;
      }
    | {
        ok: true;
        didWrite: false;
        didUpdate: true;
        badgeAttentionChanged: boolean;
        message: SessionMessageWriteRow;
        participantCursors: ParticipantCursor[];
      }
    | {
        ok: true;
        didWrite: false;
        didUpdate: false;
        badgeAttentionChanged: false;
        message: SessionMessageWriteRow;
        participantCursors: [];
      }
    | { ok: false; error: "invalid-params" | "forbidden" | "session-not-found" | "internal"; code?: EncryptionPolicyRejectionCode };

type CreateSessionMessageParamsBase = Readonly<{
    actorUserId: string;
    sessionId: string;
    localId?: string | null;
    sidechainId?: string | null;
    messageRole?: unknown;
    trustedSessionEventType?: "ready";
}>;

export type SessionReadyProjectionUpdate = Readonly<{
    latestReadyEventSeq: number;
    latestReadyEventAt: number;
}>;

export async function createSessionMessage(
    params: CreateSessionMessageParamsBase &
        (
            | Readonly<{ ciphertext: string; content?: never }>
            | Readonly<{ content: PrismaJson.SessionMessageContent; ciphertext?: never }>
        ),
): Promise<CreateSessionMessageResult> {
    const totalStartedAt = Date.now();
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

    const resolveRoleForStorageMode = (storageMode: "e2ee" | "plain") =>
        resolveSessionMessageRole({
            content,
            suppliedRole: params.messageRole,
            telemetry: {
                sessionId,
                storageMode,
                source: "session-message",
            },
        }).messageRole;

    try {
        return await inTx(async (tx) => {
            const accessStartedAt = Date.now();
            const access = await ensureSessionEditAccess(tx, { actorUserId, sessionId });
            observeCreateSessionMessageStage({
                stage: "access",
                durationMs: Date.now() - accessStartedAt,
                result: access.ok ? "ok" : "error",
            });
            if (!access.ok) {
                observeCreateSessionMessageStage({
                    stage: "total",
                    durationMs: Date.now() - totalStartedAt,
                    result: "error",
                });
                return { ok: false, error: access.error };
            }
            const resolvedRole = resolveRoleForStorageMode(access.sessionEncryptionMode);

            const encryptionPolicy = readEncryptionFeatureEnv(process.env);
            const writeKind: SessionStoredContentKind = content.t === "plain" ? "plain" : "encrypted";
            if (
                !isStoredContentKindAllowedForSessionByStoragePolicy(encryptionPolicy.storagePolicy, access.sessionEncryptionMode, writeKind)
            ) {
                observeCreateSessionMessageStage({
                    stage: "total",
                    durationMs: Date.now() - totalStartedAt,
                    result: "error",
                });
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

            const persistStartedAt = Date.now();
            const next = await tx.session.update({
                where: { id: sessionId },
                select: { seq: true },
                data: {
                    seq: { increment: 1 },
                },
            });

            const messageCreatedAt = new Date();
            const created = await tx.sessionMessage.create({
                data: {
                    sessionId,
                    seq: next.seq,
                    content,
                    localId,
                    sidechainId,
                    messageRole: resolvedRole,
                    createdAt: messageCreatedAt,
                },
                select: SESSION_MESSAGE_WRITE_SELECT,
            });
            const readyProjection = await updateSessionMessageActivityProjection(tx, {
                sessionId,
                created,
                trustedSessionEventType: resolveReadyProjectionEventType({
                    actorUserId,
                    sessionOwnerId: access.sessionOwnerId,
                    content,
                    requestedSessionEventType: params.trustedSessionEventType,
                }),
            });
            observeCreateSessionMessageStage({
                stage: "persist",
                durationMs: Date.now() - persistStartedAt,
                result: "ok",
            });

            const changeTrackingStartedAt = Date.now();
            const participantCursors = await markSessionParticipantsChanged({
                tx,
                sessionId,
                hint: { lastMessageSeq: created.seq, lastMessageId: created.id },
                participantUserIds: access.participantUserIds,
            });
            observeCreateSessionMessageStage({
                stage: "change_tracking",
                durationMs: Date.now() - changeTrackingStartedAt,
                result: "ok",
            });

            const badgeAttentionChanged = didSessionActivityBadgeContributionChange(
                access.sessionActivityBadgeInputs,
                {
                    ...access.sessionActivityBadgeInputs,
                    seq: created.seq,
                },
            );

            observeCreateSessionMessageStage({
                stage: "total",
                durationMs: Date.now() - totalStartedAt,
                result: "ok",
            });

            return {
                ok: true,
                didWrite: true,
                didUpdate: false,
                badgeAttentionChanged,
                message: toSessionMessageWriteRow(created),
                participantCursors,
                ...(readyProjection ? { readyProjection } : {}),
            };
        }, { isolationLevel: "ReadCommitted" });
    } catch (e) {
        if (localId && isSessionMessageLocalIdConflict(e)) {
            const metadata = readPrismaErrorMetadata(e);
            const target = metadata.target ?? metadata.message;
            if (!isSessionMessageLocalIdConstraintTarget(metadata.target) && !String(target ?? "").includes("SessionMessage_sessionId_localId_key")) {
                log({ module: "session-write", level: "error", sessionId, target }, "Unexpected P2002 while creating session message");
                observeCreateSessionMessageStage({
                    stage: "total",
                    durationMs: Date.now() - totalStartedAt,
                    result: "error",
                });
                return { ok: false, error: "internal" };
            }
            const access = await ensureSessionEditAccessNoTx({ actorUserId, sessionId });
            if (!access.ok) {
                observeCreateSessionMessageStage({
                    stage: "total",
                    durationMs: Date.now() - totalStartedAt,
                    result: "error",
                });
                return { ok: false, error: access.error };
            }
            const resolvedRole = resolveRoleForStorageMode(access.sessionEncryptionMode);
            const existing = await db.sessionMessage.findUnique({
                where: { sessionId_localId: { sessionId, localId } },
                select: SESSION_MESSAGE_WRITE_SELECT,
            });
            if (existing) {
                if ((existing.sidechainId ?? null) !== sidechainId) {
                    observeCreateSessionMessageStage({
                        stage: "total",
                        durationMs: Date.now() - totalStartedAt,
                        result: "error",
                    });
                    return { ok: false, error: "invalid-params" };
                }

                if (isDeepStrictEqual(existing.content, content)) {
                    if (existing.messageRole === null && resolvedRole !== null) {
                        try {
                            return await inTx(async (tx) => {
                                const duplicateRoleUpdateStartedAt = Date.now();
                                const updatedRole = await tx.sessionMessage.update({
                                    where: { id: existing.id },
                                    data: { messageRole: resolvedRole },
                                    select: SESSION_MESSAGE_WRITE_SELECT,
                                });
                                observeCreateSessionMessageStage({
                                    stage: "persist",
                                    durationMs: Date.now() - duplicateRoleUpdateStartedAt,
                                    result: "ok",
                                });
                                observeCreateSessionMessageStage({
                                    stage: "total",
                                    durationMs: Date.now() - totalStartedAt,
                                    result: "ok",
                                });
                                return {
                                    ok: true,
                                    didWrite: false,
                                    didUpdate: false,
                                    badgeAttentionChanged: false,
                                    message: toSessionMessageWriteRow(updatedRole),
                                    participantCursors: [],
                                };
                            }, { isolationLevel: "ReadCommitted" });
                        } catch {
                            observeCreateSessionMessageStage({
                                stage: "total",
                                durationMs: Date.now() - totalStartedAt,
                                result: "error",
                            });
                            return { ok: false, error: "internal" };
                        }
                    }
                    observeCreateSessionMessageStage({
                        stage: "total",
                        durationMs: Date.now() - totalStartedAt,
                        result: "ok",
                    });
                    return { ok: true, didWrite: false, didUpdate: false, badgeAttentionChanged: false, message: toSessionMessageWriteRow(existing), participantCursors: [] };
                }

                try {
                    return await inTx(async (tx) => {
                        const duplicateUpdateStartedAt = Date.now();
                        const updated = await tx.sessionMessage.update({
                            where: { id: existing.id },
                            data: { content, sidechainId, messageRole: resolvedRole },
                            select: SESSION_MESSAGE_WRITE_SELECT,
                        });
                        observeCreateSessionMessageStage({
                            stage: "persist",
                            durationMs: Date.now() - duplicateUpdateStartedAt,
                            result: "ok",
                        });

                        const duplicateChangeTrackingStartedAt = Date.now();
                        const participantCursors = await markSessionParticipantsChanged({
                            tx,
                            sessionId,
                            hint: { updatedMessageSeq: updated.seq, updatedMessageId: updated.id },
                            participantUserIds: access.participantUserIds,
                        });
                        observeCreateSessionMessageStage({
                            stage: "change_tracking",
                            durationMs: Date.now() - duplicateChangeTrackingStartedAt,
                            result: "ok",
                        });

                        observeCreateSessionMessageStage({
                            stage: "total",
                            durationMs: Date.now() - totalStartedAt,
                            result: "ok",
                        });

                        return {
                            ok: true,
                            didWrite: false,
                            didUpdate: true,
                            badgeAttentionChanged: false,
                            message: toSessionMessageWriteRow(updated),
                            participantCursors,
                        };
                    }, { isolationLevel: "ReadCommitted" });
                } catch {
                    observeCreateSessionMessageStage({
                        stage: "total",
                        durationMs: Date.now() - totalStartedAt,
                        result: "error",
                    });
                    return { ok: false, error: "internal" };
                }
            }
        }
        observeCreateSessionMessageStage({
            stage: "total",
            durationMs: Date.now() - totalStartedAt,
            result: "error",
        });
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

            const participantCursors = await markSessionParticipantsChanged({
                tx,
                sessionId,
                participantUserIds: access.participantUserIds,
            });
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
        pendingRequestObservedAt?: number | null;
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
    const hasPendingRequestCountUpdate =
        typeof pendingPermissionRequestCount === "number"
        || typeof pendingUserActionRequestCount === "number";
    const pendingRequestObservedAt =
        hasPendingRequestCountUpdate
            ? ((pendingPermissionRequestCount ?? 0) + (pendingUserActionRequestCount ?? 0)) > 0
                ? Date.now()
                : null
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
                where: {
                    id: sessionId,
                    agentStateVersion: expectedVersion,
                },
                data: {
                    agentState: agentStateCiphertext,
                    agentStateVersion: expectedVersion + 1,
                    ...(typeof pendingPermissionRequestCount === "number"
                        ? { pendingPermissionRequestCount }
                        : {}),
                    ...(typeof pendingUserActionRequestCount === "number"
                        ? { pendingUserActionRequestCount }
                        : {}),
                    ...(pendingRequestObservedAt !== undefined
                        ? { pendingRequestObservedAt: pendingRequestObservedAt === null ? null : new Date(pendingRequestObservedAt) }
                        : {}),
                },
            });

            if (count === 0) {
                const fresh = await tx.session.findUnique({
                    where: { id: sessionId },
                    select: {
                        agentStateVersion: true,
                        agentState: true,
                        ...selectSessionActivityBadgeInputs(),
                    },
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

            const participantCursors = await markSessionParticipantsChanged({
                tx,
                sessionId,
                participantUserIds: access.participantUserIds,
            });
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
                    ...(pendingRequestObservedAt !== undefined ? { pendingRequestObservedAt } : {}),
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
                ...(pendingRequestObservedAt !== undefined ? { pendingRequestObservedAt } : {}),
            };
        });
    } catch {
        return { ok: false, error: "internal" };
    }
}

export type ApplySessionTurnMutationNoOpReason =
    | "duplicate-mutation"
    | "terminal-turn"
    | "no-current-turn";

export type ApplySessionTurnMutationResult =
    | {
        ok: true;
        didApply: boolean;
        reason?: ApplySessionTurnMutationNoOpReason;
        receipt: SessionTurnMutationReceiptV1;
        latestTurnId: string | null;
        latestTurnStatus: PrimaryTurnStatusV1 | null;
        latestTurnStatusObservedAt: number | null;
        lastRuntimeIssue: SessionRuntimeIssueV1 | null;
        participantCursors: ParticipantCursor[];
        badgeAttentionChanged: boolean;
      }
    | { ok: false; error: "invalid-params" | "forbidden" | "session-not-found" | "internal" };

type SessionTurnApplicationRow = Readonly<{
    id: string;
    sessionId: string;
    turnId: string;
    provider: string | null;
    providerTurnId: string | null;
    status: string;
    startedAt: bigint | number;
    updatedAt: bigint | number;
    terminalAt: bigint | number | null;
    lastRuntimeIssueJson: string | null;
    transcriptAnchorsJson: string | null;
    rollbackState: string | null;
    rollbackReason: string | null;
    providerRollbackOrdinal: number | null;
    rollbackUpdatedAt: bigint | number | null;
    lastMutationId: string | null;
}>;

type SessionTurnMaterializedSession = Readonly<{
    latestTurnId?: string | null;
    latestTurnStatus?: string | null;
    latestTurnStatusObservedAt?: bigint | number | null;
    lastRuntimeIssue?: string | null;
}>;

function toObservedAtNumber(value: bigint | number | null | undefined): number | null {
    if (typeof value === "bigint") return Number(value);
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toObservedAtBigInt(value: number): bigint {
    return BigInt(Math.max(0, Math.floor(value)));
}

function readObservedAtNumber(value: unknown): number | null {
    return typeof value === "bigint" || typeof value === "number" ? toObservedAtNumber(value) : null;
}

function isSessionTurnTerminalStatus(status: string | null | undefined): boolean {
    return status === "completed" || status === "cancelled" || status === "failed";
}

function materializedSessionTurnState(session: SessionTurnMaterializedSession): Pick<
    Extract<ApplySessionTurnMutationResult, { ok: true }>,
    "latestTurnId" | "latestTurnStatus" | "latestTurnStatusObservedAt" | "lastRuntimeIssue"
> {
    return {
        latestTurnId: session.latestTurnId ?? null,
        latestTurnStatus: parseStoredPrimaryTurnStatus(session.latestTurnStatus),
        latestTurnStatusObservedAt: toObservedAtNumber(session.latestTurnStatusObservedAt),
        lastRuntimeIssue: parseStoredRuntimeIssue(session.lastRuntimeIssue),
    };
}

function sessionTurnRowStatus(row: SessionTurnApplicationRow | null): PrimaryTurnStatusV1 | null {
    return parseStoredPrimaryTurnStatus(row?.status);
}

function sessionTurnRowRuntimeIssue(row: SessionTurnApplicationRow | null): SessionRuntimeIssueV1 | null {
    return parseStoredRuntimeIssue(row?.lastRuntimeIssueJson);
}

function buildTranscriptAnchorsJson(mutation: SessionTurnMutationV1): string | undefined {
    if (mutation.action !== "append_transcript_anchors" && mutation.action !== "mark_rollback_eligible") {
        return undefined;
    }
    return mutation.transcriptAnchors ? JSON.stringify(mutation.transcriptAnchors) : undefined;
}

function parseTranscriptAnchorsJson(value: string | null | undefined): Record<string, unknown> {
    if (typeof value !== "string" || value.trim().length === 0) return {};
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : {};
    } catch {
        return {};
    }
}

function readFiniteNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : undefined;
}

function isTrustedAnchorSeq(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

function hasTrustedRollbackAnchorsJson(value: string | null | undefined): boolean {
    const anchors = parseTranscriptAnchorsJson(value);
    return isTrustedAnchorSeq(anchors.startUserMessageSeq) && isTrustedAnchorSeq(anchors.endSeqInclusive);
}

function mergeTranscriptAnchorsJson(
    currentJson: string | null | undefined,
    mutation: SessionTurnMutationV1,
): string | undefined {
    if (mutation.action !== "append_transcript_anchors" && mutation.action !== "mark_rollback_eligible") {
        return undefined;
    }
    if (!mutation.transcriptAnchors) return undefined;
    const existing = parseTranscriptAnchorsJson(currentJson);
    const incoming = mutation.transcriptAnchors as Record<string, unknown>;
    const merged: Record<string, unknown> = { ...existing, ...incoming };
    const existingSeqs = Array.isArray(existing.userMessageSeqs) ? existing.userMessageSeqs : [];
    const incomingSeqs = Array.isArray(incoming.userMessageSeqs) ? incoming.userMessageSeqs : [];
    const userMessageSeqs = [...existingSeqs, ...incomingSeqs]
        .map(readFiniteNumber)
        .filter((value): value is number => value !== undefined);
    if (userMessageSeqs.length > 0) {
        merged.userMessageSeqs = [...new Set(userMessageSeqs)].sort((a, b) => a - b);
    }
    return JSON.stringify(merged);
}

function resolveSessionTurnTerminalStatus(mutation: SessionTurnMutationV1): PrimaryTurnStatusV1 | null {
    if (mutation.action === "complete") return "completed";
    if (mutation.action === "fail") return "failed";
    if (mutation.action === "cancel" || mutation.action === "end_session") return "cancelled";
    return null;
}

function resolveSessionTurnLastRuntimeIssue(mutation: SessionTurnMutationV1): SessionRuntimeIssueV1 | null {
    return mutation.action === "fail" ? mutation.issue : null;
}

function normalizeRecoveryContextPart(value: unknown): string | null {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readFailedTurnObservedAt(turn: SessionTurnApplicationRow): number {
    const terminalAt = toObservedAtNumber(turn.terminalAt) ?? 0;
    const updatedAt = toObservedAtNumber(turn.updatedAt) ?? 0;
    const issueAt = sessionTurnRowRuntimeIssue(turn)?.occurredAt ?? 0;
    return Math.max(terminalAt, updatedAt, issueAt);
}

function doesProviderContextMatchFailedTurn(
    turn: SessionTurnApplicationRow,
    mutation: SessionTurnMutationV1,
): boolean {
    const mutationProviderTurnId = normalizeRecoveryContextPart(
        "providerTurnId" in mutation ? mutation.providerTurnId : undefined,
    );
    if (!mutationProviderTurnId) return false;

    const issue = sessionTurnRowRuntimeIssue(turn);
    const providerTurnIds = new Set(
        [turn.providerTurnId, issue?.providerTurnId]
            .map(normalizeRecoveryContextPart)
            .filter((value): value is string => value !== null),
    );
    if (!providerTurnIds.has(mutationProviderTurnId)) return false;

    const providers = new Set(
        [turn.provider, issue?.provider]
            .map(normalizeRecoveryContextPart)
            .filter((value): value is string => value !== null),
    );
    const mutationProvider = normalizeRecoveryContextPart(mutation.provider);
    return providers.size === 0 || (mutationProvider !== null && providers.has(mutationProvider));
}

function isNewerMatchingRecoveryLifecycleEvidence(params: Readonly<{
    turn: SessionTurnApplicationRow;
    mutation: SessionTurnMutationV1;
    terminalStatus: PrimaryTurnStatusV1 | null;
}>): boolean {
    if (sessionTurnRowStatus(params.turn) !== "failed") return false;
    if (params.mutation.action !== "begin" && params.terminalStatus !== "completed") return false;
    if (params.mutation.observedAt <= readFailedTurnObservedAt(params.turn)) return false;
    return doesProviderContextMatchFailedTurn(params.turn, params.mutation);
}

function mapSessionTurnNoOpReasonToDecision(reason: ApplySessionTurnMutationNoOpReason): SessionTurnMutationDecisionV1 {
    if (reason === "duplicate-mutation") return "duplicate-mutation";
    if (reason === "terminal-turn") return "stale-terminal";
    return "missing-turn";
}

function buildSessionTurnMutationReceipt(params: {
    mutation: SessionTurnMutationV1;
    decision: SessionTurnMutationDecisionV1;
    appliedAt?: number;
    turnId?: string | null;
}): SessionTurnMutationReceiptV1 {
    return {
        v: 1,
        sessionId: params.mutation.sessionId,
        mutationId: params.mutation.mutationId,
        ...(params.turnId ? { turnId: params.turnId } : "turnId" in params.mutation && params.mutation.turnId ? { turnId: params.mutation.turnId } : {}),
        action: params.mutation.action,
        decision: params.decision,
        observedAt: params.mutation.observedAt,
        appliedAt: params.appliedAt ?? Date.now(),
    };
}

function isSessionTurnMutationDecision(value: unknown): value is SessionTurnMutationDecisionV1 {
    return value === "applied"
        || value === "duplicate-mutation"
        || value === "duplicate-terminal"
        || value === "missing-turn"
        || value === "stale-in-progress"
        || value === "stale-terminal";
}

function storedSessionTurnMutationReceipt(params: {
    row: {
        sessionId?: unknown;
        mutationId?: unknown;
        turnId?: unknown;
        action?: unknown;
        decision?: unknown;
        observedAt?: unknown;
        appliedAt?: unknown;
    };
    mutation: SessionTurnMutationV1;
}): SessionTurnMutationReceiptV1 {
    const turnId = typeof params.row.turnId === "string" ? params.row.turnId : undefined;
    const observedAt = readObservedAtNumber(params.row.observedAt) ?? params.mutation.observedAt;
    const appliedAt = readObservedAtNumber(params.row.appliedAt) ?? Date.now();
    return {
        v: 1,
        sessionId: typeof params.row.sessionId === "string" ? params.row.sessionId : params.mutation.sessionId,
        mutationId: typeof params.row.mutationId === "string" ? params.row.mutationId : params.mutation.mutationId,
        ...(turnId ? { turnId } : {}),
        action: params.mutation.action,
        decision: isSessionTurnMutationDecision(params.row.decision) ? params.row.decision : "duplicate-mutation",
        observedAt,
        appliedAt,
    };
}

function buildSessionTurnReceiptData(
    mutation: SessionTurnMutationV1,
    decision: SessionTurnMutationDecisionV1,
    appliedAt: number,
    turnId?: string | null,
) {
    return {
        sessionId: mutation.sessionId,
        mutationId: mutation.mutationId,
        turnId: turnId ?? ("turnId" in mutation ? mutation.turnId ?? null : null),
        action: mutation.action,
        decision,
        observedAt: toObservedAtBigInt(mutation.observedAt),
        appliedAt: toObservedAtBigInt(appliedAt),
    };
}

async function createSessionTurnMutationReceipt(
    tx: Tx,
    mutation: SessionTurnMutationV1,
    decision: SessionTurnMutationDecisionV1,
    turnId?: string | null,
): Promise<
    | { status: "created"; receipt: SessionTurnMutationReceiptV1 }
    | { status: "duplicate"; receipt: SessionTurnMutationReceiptV1 | null }
> {
    const appliedAt = Date.now();
    try {
        await tx.sessionTurnMutationReceipt.create({
            data: buildSessionTurnReceiptData(mutation, decision, appliedAt, turnId),
        });
        return {
            status: "created",
            receipt: buildSessionTurnMutationReceipt({
                mutation,
                decision,
                appliedAt,
                turnId,
            }),
        };
    } catch (error) {
        if (isPrismaErrorCode(error, "P2002")) {
            const existingReceipt = await tx.sessionTurnMutationReceipt.findUnique({
                where: {
                    sessionId_mutationId: {
                        sessionId: mutation.sessionId,
                        mutationId: mutation.mutationId,
                    },
                },
            });
            return {
                status: "duplicate",
                receipt: existingReceipt ? storedSessionTurnMutationReceipt({ row: existingReceipt, mutation }) : null,
            };
        }
        throw error;
    }
}

async function updateSessionTurnMutationReceipt(
    tx: Tx,
    mutation: SessionTurnMutationV1,
    decision: SessionTurnMutationDecisionV1,
    turnId: string | null,
): Promise<SessionTurnMutationReceiptV1> {
    const appliedAt = Date.now();
    await tx.sessionTurnMutationReceipt.update({
        where: {
            sessionId_mutationId: {
                sessionId: mutation.sessionId,
                mutationId: mutation.mutationId,
            },
        },
        data: {
            turnId,
            action: mutation.action,
            decision,
            observedAt: toObservedAtBigInt(mutation.observedAt),
            appliedAt: toObservedAtBigInt(appliedAt),
        },
    });
    return buildSessionTurnMutationReceipt({
        mutation,
        decision,
        appliedAt,
        turnId,
    });
}

async function loadMaterializedSessionTurnState(tx: Tx, sessionId: string) {
    const session = await tx.session.findUnique({
        where: { id: sessionId },
        select: {
            latestTurnId: true,
            latestTurnStatus: true,
            latestTurnStatusObservedAt: true,
            lastRuntimeIssue: true,
        },
    });
    return session ? materializedSessionTurnState(session) : null;
}

function createSessionTurnNoOpResult(params: {
    reason: ApplySessionTurnMutationNoOpReason;
    state: ReturnType<typeof materializedSessionTurnState>;
    receipt: SessionTurnMutationReceiptV1;
}): Extract<ApplySessionTurnMutationResult, { ok: true }> {
    return {
        ok: true,
        didApply: false,
        reason: params.reason,
        receipt: params.receipt,
        ...params.state,
        participantCursors: [],
        badgeAttentionChanged: false,
    };
}

function createSessionTurnAppliedResult(params: {
    mutation: SessionTurnMutationV1;
    turn: SessionTurnApplicationRow;
    receipt: SessionTurnMutationReceiptV1;
    state?: ReturnType<typeof materializedSessionTurnState>;
    participantCursors: ParticipantCursor[];
    badgeAttentionChanged: boolean;
}): Extract<ApplySessionTurnMutationResult, { ok: true }> {
    return {
        ok: true,
        didApply: true,
        receipt: params.receipt,
        latestTurnId: params.state?.latestTurnId ?? params.turn.turnId,
        latestTurnStatus: params.state?.latestTurnStatus ?? sessionTurnRowStatus(params.turn),
        latestTurnStatusObservedAt: params.state?.latestTurnStatusObservedAt ?? params.mutation.observedAt,
        lastRuntimeIssue: params.state?.lastRuntimeIssue ?? sessionTurnRowRuntimeIssue(params.turn),
        participantCursors: params.participantCursors,
        badgeAttentionChanged: params.badgeAttentionChanged,
    };
}

async function applySessionTurnMutationWithOwnerAccess(params: {
    actorUserId: string;
    turnMutation: SessionTurnMutationV1;
}): Promise<ApplySessionTurnMutationResult> {
    return await inTx(async (tx) => {
        const access = await ensureSessionEditAccess(tx, {
            actorUserId: params.actorUserId,
            sessionId: params.turnMutation.sessionId,
        });
        if (!access.ok) {
            return { ok: false, error: access.error };
        }

        const existingReceipt = await tx.sessionTurnMutationReceipt.findUnique({
            where: {
                sessionId_mutationId: {
                    sessionId: params.turnMutation.sessionId,
                    mutationId: params.turnMutation.mutationId,
                },
            },
        });
        if (existingReceipt) {
            const state = await loadMaterializedSessionTurnState(tx, params.turnMutation.sessionId);
            if (!state) return { ok: false, error: "session-not-found" };
            return createSessionTurnNoOpResult({
                reason: "duplicate-mutation",
                state,
                receipt: storedSessionTurnMutationReceipt({ row: existingReceipt, mutation: params.turnMutation }),
            });
        }

        const reservationResult = await createSessionTurnMutationReceipt(tx, params.turnMutation, "stale-in-progress");
        if (reservationResult.status === "duplicate") {
            const state = await loadMaterializedSessionTurnState(tx, params.turnMutation.sessionId);
            if (!state) return { ok: false, error: "session-not-found" };
            return createSessionTurnNoOpResult({
                reason: "duplicate-mutation",
                state,
                receipt: reservationResult.receipt ?? buildSessionTurnMutationReceipt({
                    mutation: params.turnMutation,
                    decision: "duplicate-mutation",
                }),
            });
        }

        const session = await tx.session.findUnique({
            where: { id: params.turnMutation.sessionId },
            select: {
                ...selectSessionActivityBadgeInputs(),
                latestTurnId: true,
                latestTurnStatusObservedAt: true,
            },
        });
        if (!session) {
            return { ok: false, error: "session-not-found" };
        }

        const requestedTurnId = "turnId" in params.turnMutation ? params.turnMutation.turnId : undefined;
        const targetTurnId = requestedTurnId ?? session.latestTurnId ?? null;
        if (!targetTurnId) {
            const reason = "no-current-turn";
            const receipt = await updateSessionTurnMutationReceipt(tx, params.turnMutation, mapSessionTurnNoOpReasonToDecision(reason), null);
            return createSessionTurnNoOpResult({
                reason,
                state: materializedSessionTurnState(session),
                receipt,
            });
        }

        const currentTurn = await tx.sessionTurn.findUnique({
            where: {
                sessionId_turnId: {
                    sessionId: params.turnMutation.sessionId,
                    turnId: targetTurnId,
                },
            },
        }) as SessionTurnApplicationRow | null;
        const terminalStatus = resolveSessionTurnTerminalStatus(params.turnMutation);
        const isRecoveryLifecycleEvidence = currentTurn
            ? isNewerMatchingRecoveryLifecycleEvidence({
                turn: currentTurn,
                mutation: params.turnMutation,
                terminalStatus,
            })
            : false;

        if (params.turnMutation.action === "begin" && currentTurn && isSessionTurnTerminalStatus(currentTurn.status) && !isRecoveryLifecycleEvidence) {
            const reason = "terminal-turn";
            const receipt = await updateSessionTurnMutationReceipt(tx, params.turnMutation, mapSessionTurnNoOpReasonToDecision(reason), targetTurnId);
            return createSessionTurnNoOpResult({
                reason,
                state: materializedSessionTurnState(session),
                receipt,
            });
        }

        if (params.turnMutation.action !== "begin" && !currentTurn) {
            const reason = "no-current-turn";
            const receipt = await updateSessionTurnMutationReceipt(tx, params.turnMutation, mapSessionTurnNoOpReasonToDecision(reason), targetTurnId);
            return createSessionTurnNoOpResult({
                reason,
                state: materializedSessionTurnState(session),
                receipt,
            });
        }

        // A session-end settlement (e.g. the daemon settling a killed runner's open turn) only
        // cancels a turn that was already open when the end was observed. A NEWER turn — begun
        // after the observed exit by a replacement runner while the settlement was still queued —
        // must not be cancelled by the stale settlement.
        if (params.turnMutation.action === "end_session" && currentTurn && currentTurn.status === "in_progress") {
            const startedAtMs = toObservedAtNumber(currentTurn.startedAt);
            if (startedAtMs !== null && startedAtMs > params.turnMutation.observedAt) {
                const reason = "terminal-turn";
                const receipt = await updateSessionTurnMutationReceipt(tx, params.turnMutation, mapSessionTurnNoOpReasonToDecision(reason), targetTurnId);
                return createSessionTurnNoOpResult({
                    reason,
                    state: materializedSessionTurnState(session),
                    receipt,
                });
            }
        }

        const updatesRollbackFacet = params.turnMutation.action === "mark_rollback_eligible" || params.turnMutation.action === "mark_rolled_back";
        if (currentTurn && isSessionTurnTerminalStatus(currentTurn.status) && !updatesRollbackFacet && !isRecoveryLifecycleEvidence) {
            const reason = "terminal-turn";
            const receipt = await updateSessionTurnMutationReceipt(tx, params.turnMutation, mapSessionTurnNoOpReasonToDecision(reason), targetTurnId);
            return createSessionTurnNoOpResult({
                reason,
                state: materializedSessionTurnState(session),
                receipt,
            });
        }

        if (terminalStatus && requestedTurnId && session.latestTurnId && requestedTurnId !== session.latestTurnId) {
            const latestTurn = await tx.sessionTurn.findUnique({
                where: {
                    sessionId_turnId: {
                        sessionId: params.turnMutation.sessionId,
                        turnId: session.latestTurnId,
                    },
                },
            }) as SessionTurnApplicationRow | null;
            if (latestTurn?.status === "in_progress") {
                const reason = "terminal-turn";
                const receipt = await updateSessionTurnMutationReceipt(tx, params.turnMutation, mapSessionTurnNoOpReasonToDecision(reason), targetTurnId);
                return createSessionTurnNoOpResult({
                    reason,
                    state: materializedSessionTurnState(session),
                    receipt,
                });
            }
        }

        if (updatesRollbackFacet && (!currentTurn || currentTurn.status !== "completed")) {
            const reason = "terminal-turn";
            const receipt = await updateSessionTurnMutationReceipt(tx, params.turnMutation, mapSessionTurnNoOpReasonToDecision(reason), targetTurnId);
            return createSessionTurnNoOpResult({
                reason,
                state: materializedSessionTurnState(session),
                receipt,
            });
        }

        const observedAt = toObservedAtBigInt(params.turnMutation.observedAt);
        const transcriptAnchorsJson = currentTurn
            ? mergeTranscriptAnchorsJson(currentTurn.transcriptAnchorsJson, params.turnMutation)
            : buildTranscriptAnchorsJson(params.turnMutation);
        const lastRuntimeIssue = resolveSessionTurnLastRuntimeIssue(params.turnMutation);
        const lastRuntimeIssueJson = lastRuntimeIssue === null ? null : JSON.stringify(lastRuntimeIssue);

        if (params.turnMutation.action === "mark_rollback_eligible" && !hasTrustedRollbackAnchorsJson(transcriptAnchorsJson ?? currentTurn?.transcriptAnchorsJson)) {
            const reason = "terminal-turn";
            const receipt = await updateSessionTurnMutationReceipt(tx, params.turnMutation, mapSessionTurnNoOpReasonToDecision(reason), targetTurnId);
            return createSessionTurnNoOpResult({
                reason,
                state: materializedSessionTurnState(session),
                receipt,
            });
        }

        let appliedTurn: SessionTurnApplicationRow;
        if (!currentTurn) {
            try {
                appliedTurn = await tx.sessionTurn.create({
                    data: {
                        sessionId: params.turnMutation.sessionId,
                        turnId: targetTurnId,
                        provider: params.turnMutation.provider ?? null,
                        providerTurnId: "providerTurnId" in params.turnMutation ? params.turnMutation.providerTurnId ?? null : null,
                        status: "in_progress",
                        startedAt: observedAt,
                        updatedAt: observedAt,
                        terminalAt: null,
                        lastRuntimeIssueJson: null,
                        transcriptAnchorsJson: transcriptAnchorsJson ?? null,
                        rollbackState: null,
                        rollbackReason: null,
                        providerRollbackOrdinal: null,
                        rollbackUpdatedAt: null,
                        lastMutationId: params.turnMutation.mutationId,
                    },
                }) as SessionTurnApplicationRow;
            } catch (error) {
                if (!isPrismaErrorCode(error, "P2002")) {
                    throw error;
                }
                const state = await loadMaterializedSessionTurnState(tx, params.turnMutation.sessionId);
                if (!state) return { ok: false, error: "session-not-found" };
                const receipt = await updateSessionTurnMutationReceipt(tx, params.turnMutation, "duplicate-mutation", targetTurnId);
                return createSessionTurnNoOpResult({
                    reason: "duplicate-mutation",
                    state,
                    receipt,
                });
            }
        } else {
            const isRecoveryBegin = isRecoveryLifecycleEvidence && params.turnMutation.action === "begin";
            const nextStatus = isRecoveryBegin ? "in_progress" : terminalStatus ?? currentTurn.status;
            appliedTurn = await tx.sessionTurn.update({
                where: { id: currentTurn.id },
                data: {
                    provider: params.turnMutation.provider ?? currentTurn.provider,
                    ...("providerTurnId" in params.turnMutation && params.turnMutation.providerTurnId
                        ? { providerTurnId: params.turnMutation.providerTurnId }
                        : {}),
                    status: nextStatus,
                    ...(isRecoveryBegin ? { startedAt: observedAt } : {}),
                    updatedAt: observedAt,
                    ...(isRecoveryBegin ? { terminalAt: null } : terminalStatus ? { terminalAt: observedAt } : {}),
                    ...(isRecoveryBegin || terminalStatus ? { lastRuntimeIssueJson } : {}),
                    ...(transcriptAnchorsJson !== undefined ? { transcriptAnchorsJson } : {}),
                    ...(params.turnMutation.action === "mark_rollback_eligible"
                        ? {
                            rollbackState: "eligible",
                            providerRollbackOrdinal: params.turnMutation.providerRollbackOrdinal ?? currentTurn.providerRollbackOrdinal,
                            rollbackUpdatedAt: observedAt,
                        }
                        : {}),
                    ...(params.turnMutation.action === "mark_rolled_back"
                        ? {
                            rollbackState: "rolled_back",
                            providerRollbackOrdinal: params.turnMutation.providerRollbackOrdinal ?? currentTurn.providerRollbackOrdinal,
                            rollbackUpdatedAt: observedAt,
                        }
                        : {}),
                    lastMutationId: params.turnMutation.mutationId,
                },
            }) as SessionTurnApplicationRow;
        }

        const nextLatestTurnId = params.turnMutation.action === "begin" ? targetTurnId : session.latestTurnId ?? targetTurnId;
        const shouldMaterialize = nextLatestTurnId === targetTurnId
            && (params.turnMutation.action === "begin" || terminalStatus !== null);
        const nextActivityInputs = {
            ...toSessionActivityBadgeInputs(session),
            ...(shouldMaterialize ? { latestTurnStatus: appliedTurn.status } : {}),
            ...(shouldMaterialize ? { lastRuntimeIssue: appliedTurn.lastRuntimeIssueJson ?? null } : {}),
        };
        if (shouldMaterialize) {
            await tx.session.update({
                where: { id: params.turnMutation.sessionId },
                data: {
                    latestTurnId: targetTurnId,
                    latestTurnStatus: appliedTurn.status,
                    latestTurnStatusObservedAt: observedAt,
                    lastRuntimeIssue: appliedTurn.lastRuntimeIssueJson ?? null,
                    ...buildLegacyThinkingProjectionWriteData({
                        latestTurnStatus: appliedTurn.status,
                        latestTurnStatusObservedAt: observedAt,
                    }),
                },
            });
        }

        const receipt = await updateSessionTurnMutationReceipt(tx, params.turnMutation, "applied", targetTurnId);

        const participantCursors = shouldMaterialize
            ? await markSessionParticipantsChanged({
                tx,
                sessionId: params.turnMutation.sessionId,
                participantUserIds: access.participantUserIds,
            })
            : [];
        const badgeAttentionChanged = shouldMaterialize
            ? didSessionActivityBadgeContributionChange(toSessionActivityBadgeInputs(session), nextActivityInputs)
            : false;

        return createSessionTurnAppliedResult({
            mutation: params.turnMutation,
            turn: appliedTurn,
            receipt,
            ...(!shouldMaterialize ? { state: materializedSessionTurnState(session) } : {}),
            participantCursors,
            badgeAttentionChanged,
        });
    });
}

export async function applySessionTurnMutation(params: {
    actorUserId: string;
    mutation: unknown;
}): Promise<ApplySessionTurnMutationResult> {
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const mutation = SessionTurnMutationV1Schema.safeParse(params.mutation);
    if (!actorUserId || !mutation.success) {
        return { ok: false, error: "invalid-params" };
    }
    const turnMutation = mutation.data;

    try {
        return await applySessionTurnMutationWithOwnerAccess({ actorUserId, turnMutation });
    } catch (error) {
        if (isDuplicateSessionTurnMutationRace(error)) {
            try {
                return await applySessionTurnMutationWithOwnerAccess({ actorUserId, turnMutation });
            } catch {
                return { ok: false, error: "internal" };
            }
        }
        return { ok: false, error: "internal" };
    }
}

export type UpdateSessionReadCursorResult =
    | { ok: true; lastViewedSessionSeq: number; participantCursors: ParticipantCursor[]; badgeAttentionChanged: boolean }
    | { ok: false; error: "invalid-params" | "forbidden" | "session-not-found" | "internal" };

export type ApplySessionReadCursorOperationResult =
    | {
        ok: true;
        lastViewedSessionSeq: number | null;
        participantCursors: ParticipantCursor[];
        badgeAttentionChanged: boolean;
        didChange: boolean;
        readState: SessionReadCursorReadState;
      }
    | { ok: false; error: "invalid-params" | "forbidden" | "session-not-found" | "internal" };

function isValidSessionReadCursorOperation(operation: SessionReadCursorOperation): boolean {
    if (operation.kind === "mark-read" || operation.kind === "mark-unread") {
        return true;
    }
    return (
        operation.kind === "advance"
        && typeof operation.lastViewedSessionSeq === "number"
        && Number.isFinite(operation.lastViewedSessionSeq)
    );
}

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

    const result = await applySessionReadCursorOperation({
        actorUserId,
        sessionId,
        operation: { kind: "advance", lastViewedSessionSeq: incomingCursor },
    });
    if (!result.ok) {
        return result;
    }
    return {
        ok: true,
        lastViewedSessionSeq: Math.max(result.lastViewedSessionSeq ?? 0, 0),
        participantCursors: result.participantCursors,
        badgeAttentionChanged: result.badgeAttentionChanged,
    };
}

export async function applySessionReadCursorOperation(params: {
    actorUserId: string;
    sessionId: string;
    operation: SessionReadCursorOperation;
}): Promise<ApplySessionReadCursorOperationResult> {
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const operation = params.operation;

    if (!sessionId || !actorUserId || !operation || !isValidSessionReadCursorOperation(operation)) {
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

            const resolved = resolveSessionReadCursorOperation({
                sessionSeq: session.seq,
                currentLastViewedSessionSeq: session.lastViewedSessionSeq,
                operation,
            });
            const nextCursor = resolved.nextLastViewedSessionSeq;
            if (!resolved.didChange || typeof nextCursor !== "number") {
                return {
                    ok: true,
                    lastViewedSessionSeq: nextCursor,
                    participantCursors: [],
                    badgeAttentionChanged: false,
                    didChange: false,
                    readState: resolved.readState,
                };
            }

            const { count } = await tx.session.updateMany({
                where: operation.kind === "mark-unread"
                    ? {
                        id: sessionId,
                        lastViewedSessionSeq: { gt: nextCursor },
                    }
                    : {
                        id: sessionId,
                        OR: [{ lastViewedSessionSeq: { lt: nextCursor } }, { lastViewedSessionSeq: null }],
                    },
                data: { lastViewedSessionSeq: nextCursor },
            });

            if (count === 0) {
                const fresh = await tx.session.findUnique({
                    where: { id: sessionId },
                    select: { lastViewedSessionSeq: true },
                });
                const freshResolved = resolveSessionReadCursorOperation({
                    sessionSeq: session.seq,
                    currentLastViewedSessionSeq: fresh?.lastViewedSessionSeq,
                    operation,
                });
                return {
                    ok: true,
                    lastViewedSessionSeq: fresh?.lastViewedSessionSeq ?? null,
                    participantCursors: [],
                    badgeAttentionChanged: false,
                    didChange: false,
                    readState: freshResolved.readState,
                };
            }

            const participantCursors = await markSessionParticipantsChanged({
                tx,
                sessionId,
                participantUserIds: access.participantUserIds,
            });
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
                didChange: true,
                readState: resolved.readState,
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

            const participantCursors = await markSessionParticipantsChanged({
                tx,
                sessionId,
                participantUserIds: access.participantUserIds,
            });

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
