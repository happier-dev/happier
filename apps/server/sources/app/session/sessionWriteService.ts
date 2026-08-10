import { markSessionParticipantsChanged, type SessionParticipantCursor } from "@/app/session/changeTracking/markSessionParticipantsChanged";
import { db } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";
import { isPrismaErrorCode } from "@/storage/prisma";
import { log } from "@/utils/logging/log";
import { readEncryptionFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import type { Prisma } from "@prisma/client";
import {
    isStoredContentKindAllowedForSessionByStoragePolicy,
    PrimaryTurnStatusV1Schema,
    TranscriptRawRecordV1Schema,
    agentEventLocalIdAttentionImpact,
    ExactSessionTurnEndMutationV1Schema,
    SessionTurnMutationV1Schema,
    SessionRuntimeIssueV1Schema,
    type PrimaryTurnStatusV1,
    type SessionRuntimeIssueV1,
    type SessionTurnMutationReceiptV1,
    type SessionTurnMutationV1,
    type SessionMessageRole,
    type SessionStoredContentKind,
    type SessionMessageAttentionImpact,
    type SessionTranscriptObservationProvenanceV1,
    SessionTranscriptObservationProvenanceV1Schema,
} from "@happier-dev/protocol";
import { resolveEncryptionWriteRejectionCode, type EncryptionPolicyRejectionCode } from "@/app/session/encryptionRejectionCodes";
import { isDeepStrictEqual } from "node:util";
import { parseSessionMessageSidechainId } from "./parseSessionMessageSidechainId";
import { resolveMessageAttentionImpact } from "./messageAttentionImpact";
import { didSessionActivityBadgeContributionChange, type SessionActivityBadgeInputs } from "@/app/activity/accountActivityBadge";
import {
    resolveSessionReadCursorOperation,
    resolveSessionReadState,
    type SessionReadCursorOperation,
    type SessionReadCursorReadState,
} from "./readCursor/resolveSessionReadCursorOperation";
import { parseSessionMessageRole, resolveSessionMessageRole } from "./messageRole/resolveSessionMessageRole";
import {
    resolveSessionUnreadSinceWrite,
    type SessionUnreadInputs,
    type StoredSessionUnreadSince,
} from "./attention/sessionAttentionFacts";
import {
    applySessionTurnMutationToTurns,
    type SessionTurnNoOpReason,
} from "./turns/applySessionTurnMutation";
import type { PrimaryTurnMaterializedProjection } from "./turns/materializePrimaryTurnProjection";
import {
    parseStoredSessionTurnMutationReceipt,
    parseStoredSessionTurns,
    type SessionTurnStoredRow,
} from "./turns/parseSessionTurnState";
import { hasCurrentSessionScopedMachineAccessInTx } from "@/app/api/socket/sessionScopedBinding";

type ParticipantCursor = SessionParticipantCursor;

const JSON_PARSE_FAILED = Symbol("json-parse-failed");

type SessionMessageWriteRow = {
    id: string;
    seq: number;
    localId: string | null;
    sidechainId: string | null;
    messageRole: SessionMessageRole | null;
    content: PrismaJson.SessionMessageContent;
    createdAt: Date;
    updatedAt: Date;
    sourceCreatedAt?: Date | null;
    sourceUpdatedAt?: Date | null;
    transcriptObservationProvenance?: SessionTranscriptObservationProvenanceV1 | null;
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
    sourceCreatedAt: true,
    sourceUpdatedAt: true,
    transcriptObservationProvenance: true,
} as const;

function toSessionMessageWriteRow(
    row: Omit<SessionMessageWriteRow, "messageRole" | "transcriptObservationProvenance"> & {
        messageRole: unknown;
        transcriptObservationProvenance: unknown;
    },
): SessionMessageWriteRow {
    const { transcriptObservationProvenance: rawProvenance, ...rest } = row;
    const provenance = SessionTranscriptObservationProvenanceV1Schema.safeParse(rawProvenance);
    return {
        ...rest,
        messageRole: parseSessionMessageRole(row.messageRole),
        ...(provenance.success ? { transcriptObservationProvenance: provenance.data } : {}),
    };
}

function parseJsonForComparison(value: string): unknown | typeof JSON_PARSE_FAILED {
    try {
        return JSON.parse(value);
    } catch {
        return JSON_PARSE_FAILED;
    }
}

function isSessionMetadataNoOp(params: Readonly<{
    currentMetadata: string;
    nextMetadata: string;
    encryptionMode?: unknown;
}>): boolean {
    if (params.currentMetadata === params.nextMetadata) {
        return true;
    }
    if (params.encryptionMode !== "plain") {
        return false;
    }
    const current = parseJsonForComparison(params.currentMetadata);
    const next = parseJsonForComparison(params.nextMetadata);
    if (current === JSON_PARSE_FAILED || next === JSON_PARSE_FAILED) {
        return false;
    }
    return isDeepStrictEqual(current, next);
}

export async function updateSessionMessageActivityProjection(
    tx: Tx,
    params: Readonly<{
        sessionId: string;
        created: Pick<SessionMessageWriteRow, "seq" | "createdAt">;
        trustedSessionEventType?: "ready";
        affectsMeaningfulActivity?: boolean;
    }>,
): Promise<SessionReadyProjectionUpdate | undefined> {
    if (params.affectsMeaningfulActivity !== false) {
        await tx.session.updateMany({
            where: { id: params.sessionId, seq: params.created.seq },
            data: {
                meaningfulActivityAt: params.created.createdAt,
            },
        });
    }

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
        // Not a badge input: `resolveSessionUnreadSinceWrite` decides the edge against the *stored*
        // instant, so every writer that folds the fragment into its statement reads it here.
        unreadSince: true,
        latestReadyEventSeq: true,
        pendingCount: true,
        pendingBlockedCount: true,
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
        pendingBlockedCount: value?.pendingBlockedCount ?? 0,
        lastViewedSessionSeq: value?.lastViewedSessionSeq ?? null,
        pendingPermissionRequestCount: value?.pendingPermissionRequestCount ?? 0,
        pendingUserActionRequestCount: value?.pendingUserActionRequestCount ?? 0,
        latestTurnStatus: value?.latestTurnStatus ?? null,
        lastRuntimeIssue: value?.lastRuntimeIssue ?? null,
        active: value?.active ?? true,
        archivedAt: value?.archivedAt ?? null,
    };
}

/**
 * The **post-write** unread inputs for a writer that moves only one of them: start from the row as
 * stored and layer the column this statement writes.
 *
 * Only `seq` and `lastViewedSessionSeq` appear, because `unreadSince` is the only attention fact
 * application code maintains. The other three arms of the attention predicate move
 * `Session.needsAttention`, which the database generates.
 */
function toSessionUnreadInputs(
    stored: SessionActivityBadgeInputs,
    after: Partial<SessionUnreadInputs> = {},
): SessionUnreadInputs {
    return {
        seq: stored.seq ?? 0,
        lastViewedSessionSeq: stored.lastViewedSessionSeq ?? null,
        ...after,
    };
}

function shouldAdvanceReadCursorForNonUnreadMessage(before: SessionActivityBadgeInputs): boolean {
    const normalized = toSessionActivityBadgeInputs(before);
    const seq = typeof normalized.seq === "number" && Number.isFinite(normalized.seq)
        ? Math.max(0, Math.trunc(normalized.seq))
        : 0;
    const lastViewedSessionSeq = typeof normalized.lastViewedSessionSeq === "number" && Number.isFinite(normalized.lastViewedSessionSeq)
        ? Math.max(0, Math.trunc(normalized.lastViewedSessionSeq))
        : null;
    if (lastViewedSessionSeq !== null) return lastViewedSessionSeq >= seq;
    return seq === 0;
}

function normalizeReadSeq(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value)
        ? Math.max(0, Math.trunc(value))
        : null;
}

function maxReadSeq(left: number | null, right: number | null): number | null {
    if (left === null) return right;
    if (right === null) return left;
    return Math.max(left, right);
}

function isTerminalTurnStatus(value: unknown): value is Exclude<PrimaryTurnStatusV1, "in_progress"> {
    return value === "completed" || value === "cancelled" || value === "failed";
}

function resolveStoredSessionMessageAttentionImpact(row: Readonly<{
    localId?: string | null;
    messageRole?: unknown;
    content: PrismaJson.SessionMessageContent;
}>): SessionMessageAttentionImpact {
    const trustedLocalIdAttentionImpact = parseSessionMessageRole(row.messageRole) === "event"
        ? agentEventLocalIdAttentionImpact(row.localId)
        : null;
    return resolveMessageAttentionImpact({
        content: row.content,
        explicitAttentionImpact: trustedLocalIdAttentionImpact ?? undefined,
    });
}

async function findLatestUnreadAffectingMainTranscriptMessageSeq(tx: Tx, sessionId: string): Promise<number | null> {
    const pageSize = 100;
    let beforeSeq: number | null = null;
    for (;;) {
        const messages = await tx.sessionMessage.findMany({
            where: {
                sessionId,
                sidechainId: null,
                ...(beforeSeq === null ? {} : { seq: { lt: beforeSeq } }),
            },
            orderBy: { seq: "desc" },
            take: pageSize,
            select: {
                seq: true,
                localId: true,
                messageRole: true,
                content: true,
            },
        });
        if (!Array.isArray(messages) || messages.length === 0) return null;
        for (const message of messages) {
            if (resolveStoredSessionMessageAttentionImpact(message).affectsUnread) {
                return normalizeReadSeq(message.seq);
            }
        }
        if (messages.length < pageSize) return null;
        beforeSeq = normalizeReadSeq(messages[messages.length - 1]?.seq);
        if (beforeSeq === null) return null;
    }
}

async function resolveManualUnreadReadableSessionSeq(
    tx: Tx,
    sessionId: string,
    session: Readonly<{
        seq?: number | null;
        latestReadyEventSeq?: number | null;
        latestTurnStatus?: PrimaryTurnStatusV1 | string | null;
    }>,
): Promise<number> {
    const latestMainMessageSeq = await findLatestUnreadAffectingMainTranscriptMessageSeq(tx, sessionId);
    let readableSeq = maxReadSeq(latestMainMessageSeq, normalizeReadSeq(session.latestReadyEventSeq));
    if (readableSeq === null && isTerminalTurnStatus(parseStoredLatestTurnStatus(session.latestTurnStatus))) {
        readableSeq = normalizeReadSeq(session.seq);
    }
    return readableSeq ?? normalizeReadSeq(session.seq) ?? 0;
}

function parseStoredObservedAt(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "bigint") return Number(value);
    return null;
}

function parseStoredLatestTurnStatus(value: unknown): PrimaryTurnStatusV1 | null {
    const parsed = PrimaryTurnStatusV1Schema.safeParse(value);
    return parsed.success ? parsed.data : null;
}

function parseStoredLastRuntimeIssue(value: unknown): SessionRuntimeIssueV1 | null {
    if (!value) return null;
    if (typeof value === "object") {
        const parsed = SessionRuntimeIssueV1Schema.safeParse(value);
        return parsed.success ? parsed.data : null;
    }
    if (typeof value !== "string") return null;
    try {
        const parsed = SessionRuntimeIssueV1Schema.safeParse(JSON.parse(value));
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

function readMaterializedProjectionFromSession(session: Readonly<{
    latestTurnId?: string | null;
    latestTurnStatus?: unknown;
    latestTurnStatusObservedAt?: unknown;
    lastRuntimeIssue?: unknown;
}>) {
    return {
        latestTurnId: session.latestTurnId ?? null,
        latestTurnStatus: parseStoredLatestTurnStatus(session.latestTurnStatus),
        latestTurnStatusObservedAt: parseStoredObservedAt(session.latestTurnStatusObservedAt),
        lastRuntimeIssue: parseStoredLastRuntimeIssue(session.lastRuntimeIssue),
    };
}

function buildLegacyThinkingProjectionWriteData(
    projection: PrimaryTurnMaterializedProjection,
): { thinking?: boolean; thinkingAt?: Date } {
    if (projection.latestTurnStatus === "in_progress" && projection.latestTurnStatusObservedAt !== null) {
        return {
            thinking: true,
            thinkingAt: new Date(projection.latestTurnStatusObservedAt),
        };
    }
    if (
        (projection.latestTurnStatus === "completed"
            || projection.latestTurnStatus === "cancelled"
            || projection.latestTurnStatus === "failed")
        && projection.latestTurnStatusObservedAt !== null
    ) {
        return {
            thinking: false,
            thinkingAt: new Date(projection.latestTurnStatusObservedAt),
        };
    }
    return {};
}

function serializeJsonField(value: unknown | undefined): string | null | undefined {
    if (value === undefined) return undefined;
    return value === null ? null : JSON.stringify(value);
}

function buildSessionTurnWriteData(turn: Readonly<{
    provider?: string;
    providerTurnId?: string;
    status: PrimaryTurnStatusV1;
    startedAt: number;
    updatedAt: number;
    terminalAt?: number | null;
    lastRuntimeIssue?: SessionRuntimeIssueV1 | null;
    transcriptAnchors?: unknown;
    rollback?: {
        state: string;
        reason?: string;
        providerRollbackOrdinal?: number;
        updatedAt: number;
    };
    lastMutationId?: string;
}>) {
    return {
        ...(turn.provider ? { provider: turn.provider } : {}),
        ...(turn.providerTurnId ? { providerTurnId: turn.providerTurnId } : {}),
        status: turn.status,
        startedAt: BigInt(turn.startedAt),
        updatedAt: BigInt(turn.updatedAt),
        ...(turn.status === "in_progress"
            ? { terminalAt: null }
            : turn.terminalAt !== undefined && turn.terminalAt !== null
                ? { terminalAt: BigInt(turn.terminalAt) }
                : {}),
        ...(turn.lastRuntimeIssue !== undefined ? { lastRuntimeIssueJson: serializeJsonField(turn.lastRuntimeIssue) } : {}),
        ...(turn.transcriptAnchors !== undefined ? { transcriptAnchorsJson: serializeJsonField(turn.transcriptAnchors) } : {}),
        ...(turn.rollback
            ? {
                rollbackState: turn.rollback.state,
                ...(turn.rollback.reason ? { rollbackReason: turn.rollback.reason } : {}),
                ...(typeof turn.rollback.providerRollbackOrdinal === "number"
                    ? { providerRollbackOrdinal: turn.rollback.providerRollbackOrdinal }
                    : {}),
                rollbackUpdatedAt: BigInt(turn.rollback.updatedAt),
            }
            : {}),
        ...(turn.lastMutationId ? { lastMutationId: turn.lastMutationId } : {}),
    };
}

type EnsureSessionEditAccessResult =
    | { ok: true; sessionOwnerId: string; sessionEncryptionMode: "e2ee" | "plain" }
    | { ok: false; error: "session-not-found" | "forbidden" };

type SessionTurnMutationTxResult = Readonly<{
    didApply: boolean;
    reason?: SessionTurnNoOpReason;
    receipt: SessionTurnMutationReceiptV1;
    latestTurnId: string | null;
    latestTurnStatus: PrimaryTurnStatusV1 | null;
    latestTurnStatusObservedAt: number | null;
    lastRuntimeIssue: SessionRuntimeIssueV1 | null;
    participantCursors: ParticipantCursor[];
    badgeAttentionChanged: boolean;
}>;

export async function applyLatestSessionTurnEndInTx(params: Readonly<{
    tx: Tx;
    sessionId: string;
    mutationId: string;
    observedAt: number;
}>): Promise<SessionTurnMutationTxResult | null> {
    const session = await params.tx.session.findUnique({
        where: { id: params.sessionId },
        select: {
            latestTurnId: true,
            latestTurnStatusObservedAt: true,
            ...selectSessionActivityBadgeInputs(),
        },
    });
    if (!session?.latestTurnId) return null;

    return await applySessionTurnMutationInTx({
        tx: params.tx,
        sessionId: params.sessionId,
        mutation: ExactSessionTurnEndMutationV1Schema.parse({
            v: 1,
            sessionId: params.sessionId,
            mutationId: params.mutationId,
            action: "end_session",
            turnId: session.latestTurnId,
            observedAt: params.observedAt,
        }),
        session,
        markParticipants: false,
    });
}

export type ReassertSessionLatestTurnStatusResult =
    | {
        ok: true;
        didApply: boolean;
        latestTurnId: string | null;
        latestTurnStatus: PrimaryTurnStatusV1 | null;
        latestTurnStatusObservedAt: number | null;
        lastRuntimeIssue: SessionRuntimeIssueV1 | null;
        participantCursors: ParticipantCursor[];
        badgeAttentionChanged: boolean;
    }
    | { ok: false; error: "invalid-params" | "forbidden" | "session-not-found" | "internal" };

export async function reassertSessionLatestTurnStatus(params: {
    actorUserId: string;
    sessionId: string;
    latestTurnStatus: unknown;
    latestTurnStatusObservedAt: unknown;
}): Promise<ReassertSessionLatestTurnStatusResult> {
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const latestTurnStatus = PrimaryTurnStatusV1Schema.safeParse(params.latestTurnStatus);
    const latestTurnStatusObservedAt = parseStoredObservedAt(params.latestTurnStatusObservedAt);
    if (!actorUserId || !sessionId || !latestTurnStatus.success || latestTurnStatusObservedAt === null) {
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
                    latestTurnId: true,
                    latestTurnStatusObservedAt: true,
                    ...selectSessionActivityBadgeInputs(),
                },
            });
            if (!session) {
                return { ok: false, error: "session-not-found" };
            }

            const currentObservedAt = parseStoredObservedAt(session.latestTurnStatusObservedAt);
            const currentStatus = parseStoredLatestTurnStatus(session.latestTurnStatus);
            const currentIssue = parseStoredLastRuntimeIssue(session.lastRuntimeIssue);
            if (
                currentObservedAt !== null
                && (
                    currentObservedAt > latestTurnStatusObservedAt
                    || (currentObservedAt === latestTurnStatusObservedAt && currentStatus === latestTurnStatus.data)
                )
            ) {
                return {
                    ok: true,
                    didApply: false,
                    latestTurnId: session.latestTurnId ?? null,
                    latestTurnStatus: currentStatus,
                    latestTurnStatusObservedAt: currentObservedAt,
                    lastRuntimeIssue: currentIssue,
                    participantCursors: [],
                    badgeAttentionChanged: false,
                };
            }

            await tx.session.update({
                where: { id: sessionId },
                data: {
                    latestTurnStatus: latestTurnStatus.data,
                    latestTurnStatusObservedAt: BigInt(latestTurnStatusObservedAt),
                    // `latestTurnStatus = 'failed'` is an attention arm, so this statement moves the
                    // session into or out of attention — and nothing here has to say so:
                    // `Session.needsAttention` is generated from this very column.
                    ...buildLegacyThinkingProjectionWriteData({
                        latestTurnId: session.latestTurnId ?? null,
                        latestTurnStatus: latestTurnStatus.data,
                        latestTurnStatusObservedAt,
                        lastRuntimeIssue: currentIssue,
                    }),
                },
            });

            const participantCursors = await markSessionParticipantsChanged({ tx, sessionId });
            const badgeAttentionChanged = didSessionActivityBadgeContributionChange(
                toSessionActivityBadgeInputs(session),
                {
                    ...toSessionActivityBadgeInputs(session),
                    latestTurnStatus: latestTurnStatus.data,
                    lastRuntimeIssue: currentIssue,
                },
            );
            return {
                ok: true,
                didApply: true,
                latestTurnId: session.latestTurnId ?? null,
                latestTurnStatus: latestTurnStatus.data,
                latestTurnStatusObservedAt,
                lastRuntimeIssue: currentIssue,
                participantCursors,
                badgeAttentionChanged,
            };
        });
    } catch {
        return { ok: false, error: "internal" };
    }
}

export async function applySessionTurnMutationInTx(params: Readonly<{
    tx: Tx;
    sessionId: string;
    mutation: SessionTurnMutationV1;
    session: SessionActivityBadgeInputs & StoredSessionUnreadSince & {
        latestTurnId?: string | null;
        latestTurnStatusObservedAt?: unknown;
    };
    markParticipants: boolean;
}>): Promise<SessionTurnMutationTxResult> {
    const exactMutation = ExactSessionTurnEndMutationV1Schema.safeParse(params.mutation);
    const duplicateReceipt = await params.tx.sessionTurnMutationReceipt.findUnique({
        where: { sessionId_mutationId: { sessionId: params.sessionId, mutationId: params.mutation.mutationId } },
    });
    if (duplicateReceipt) {
        const parsedReceipt = parseStoredSessionTurnMutationReceipt(duplicateReceipt);
        const exactReceiptIdentityMatches = exactMutation.success
            && parsedReceipt !== null
            && parsedReceipt.v === exactMutation.data.v
            && parsedReceipt.sessionId === exactMutation.data.sessionId
            && parsedReceipt.mutationId === exactMutation.data.mutationId
            && parsedReceipt.action === exactMutation.data.action
            && parsedReceipt.turnId === exactMutation.data.turnId
            && parsedReceipt.observedAt === exactMutation.data.observedAt;
        const shouldReevaluateExactReceipt = exactReceiptIdentityMatches
            && parsedReceipt !== null
            && parsedReceipt.decision !== "applied"
            && parsedReceipt.decision !== "duplicate-terminal";
        if (!shouldReevaluateExactReceipt) {
            const receipt = exactMutation.success && !exactReceiptIdentityMatches
                ? {
                    v: 1 as const,
                    sessionId: params.sessionId,
                    mutationId: params.mutation.mutationId,
                    turnId: exactMutation.data.turnId,
                    action: exactMutation.data.action,
                    decision: "duplicate-mutation" as const,
                    observedAt: exactMutation.data.observedAt,
                    appliedAt: exactMutation.data.observedAt,
                }
                : parsedReceipt ?? {
            v: 1,
            sessionId: params.sessionId,
            mutationId: params.mutation.mutationId,
            ...(duplicateReceipt.turnId ? { turnId: duplicateReceipt.turnId } : {}),
            action: params.mutation.action,
            decision: "duplicate-mutation",
            observedAt: params.mutation.observedAt,
            appliedAt: params.mutation.observedAt,
        };
            return {
                didApply: false,
                reason: "duplicate-mutation",
                receipt,
                ...readMaterializedProjectionFromSession(params.session),
                participantCursors: [],
                badgeAttentionChanged: false,
            };
        }
    }

    const turnRows = await params.tx.sessionTurn.findMany({
        where: { sessionId: params.sessionId },
        orderBy: [{ updatedAt: "asc" }, { createdAt: "asc" }],
    }) as SessionTurnStoredRow[];
    const turns = parseStoredSessionTurns(turnRows);
    const decision = applySessionTurnMutationToTurns({
        currentLatestTurnId: params.session.latestTurnId ?? null,
        mutation: params.mutation,
        turns,
        appliedAt: Date.now(),
    });

    if (decision.apply) {
        const existingRow = turnRows.find((row) => row.turnId === decision.changedTurn.turnId);
        const turnData = buildSessionTurnWriteData(decision.changedTurn);
        if (existingRow) {
            await params.tx.sessionTurn.update({
                where: { sessionId_turnId: { sessionId: params.sessionId, turnId: decision.changedTurn.turnId } },
                data: turnData,
            });
        } else {
            await params.tx.sessionTurn.create({
                data: {
                    sessionId: params.sessionId,
                    turnId: decision.changedTurn.turnId,
                    ...turnData,
                },
            });
        }

        await params.tx.session.update({
            where: { id: params.sessionId },
            data: {
                latestTurnId: decision.materialized.latestTurnId,
                latestTurnStatus: decision.materialized.latestTurnStatus,
                latestTurnStatusObservedAt: decision.materialized.latestTurnStatusObservedAt === null
                    ? null
                    : BigInt(decision.materialized.latestTurnStatusObservedAt),
                lastRuntimeIssue: decision.materialized.lastRuntimeIssue === null
                    ? null
                    : JSON.stringify(decision.materialized.lastRuntimeIssue),
                // `latestTurnStatus = 'failed'` is an attention arm, so this statement moves the
                // session into or out of attention — and nothing here has to say so:
                // `Session.needsAttention` is generated from this very column.
                ...buildLegacyThinkingProjectionWriteData(decision.materialized),
            },
        });
    }

    const receiptWriteData = {
            sessionId: params.sessionId,
            mutationId: params.mutation.mutationId,
            ...(decision.receipt.turnId ? { turnId: decision.receipt.turnId } : {}),
            action: params.mutation.action,
            decision: decision.receipt.decision,
            observedAt: BigInt(decision.receipt.observedAt),
            appliedAt: BigInt(decision.receipt.appliedAt),
    };
    const exactDecisionIsPositive = exactMutation.success
        && (decision.receipt.decision === "applied" || decision.receipt.decision === "duplicate-terminal");
    if (!exactMutation.success || exactDecisionIsPositive) {
        if (duplicateReceipt) {
            await params.tx.sessionTurnMutationReceipt.update({
                where: { sessionId_mutationId: { sessionId: params.sessionId, mutationId: params.mutation.mutationId } },
                data: receiptWriteData,
            });
        } else {
            await params.tx.sessionTurnMutationReceipt.create({ data: receiptWriteData });
        }
    }

    const participantCursors = decision.apply && params.markParticipants
        ? await markSessionParticipantsChanged({ tx: params.tx, sessionId: params.sessionId })
        : [];
    const badgeAttentionChanged = decision.apply
        ? didSessionActivityBadgeContributionChange(
            toSessionActivityBadgeInputs(params.session),
            {
                ...toSessionActivityBadgeInputs(params.session),
                latestTurnStatus: decision.materialized.latestTurnStatus,
                lastRuntimeIssue: decision.materialized.lastRuntimeIssue,
            },
        )
        : false;

    return {
        didApply: decision.apply,
        ...(!decision.apply ? { reason: decision.reason } : {}),
        receipt: decision.receipt,
        latestTurnId: decision.materialized.latestTurnId,
        latestTurnStatus: decision.materialized.latestTurnStatus,
        latestTurnStatusObservedAt: decision.materialized.latestTurnStatusObservedAt,
        lastRuntimeIssue: decision.materialized.lastRuntimeIssue,
        participantCursors,
        badgeAttentionChanged,
    };
}

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

async function ensureSessionOwnerAccess(tx: Tx, params: { actorUserId: string; sessionId: string }): Promise<EnsureSessionEditAccessResult> {
    const access = await ensureSessionEditAccess(tx, params);
    if (!access.ok) return access;
    if (access.sessionOwnerId !== params.actorUserId) {
        return { ok: false, error: "forbidden" };
    }
    return access;
}

export type SessionReadyProjectionUpdate = Readonly<{
    latestReadyEventSeq: number;
    latestReadyEventAt: number;
}>;

function isDuplicateSessionTurnMutationRace(error: unknown): boolean {
    if (!isPrismaErrorCode(error, "P2002")) return false;
    const target = (error as { meta?: { target?: unknown } })?.meta?.target;
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
        attentionImpact: SessionMessageAttentionImpact;
        message: SessionMessageWriteRow;
        participantCursors: ParticipantCursor[];
        readyProjection?: SessionReadyProjectionUpdate;
      }
    | {
        ok: true;
        didWrite: false;
        didUpdate: true;
        badgeAttentionChanged: boolean;
        attentionImpact: SessionMessageAttentionImpact;
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
    trustedAttentionImpact?: SessionMessageAttentionImpact;
    /** Exact publisher-presence fence, revalidated in the same serializable transaction as the write. */
    trustedPublisherFence?: Readonly<{
        accountId: string;
        machineId: string;
        sessionId: string;
        committedFence: Date;
    }>;
    /** Source chronology accepted only from an authenticated, fenced transcript-observation producer. */
    trustedSourceTimestamps?: Readonly<{ createdAt: number; updatedAt: number }>;
    trustedTranscriptObservationProvenance?: SessionTranscriptObservationProvenanceV1;
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
    const sourceCreatedAt = params.trustedSourceTimestamps
        ? new Date(params.trustedSourceTimestamps.createdAt)
        : null;
    const sourceUpdatedAt = params.trustedSourceTimestamps
        ? new Date(params.trustedSourceTimestamps.updatedAt)
        : null;
    if (
        params.trustedSourceTimestamps
        && (!Number.isFinite(sourceCreatedAt?.getTime())
            || !Number.isFinite(sourceUpdatedAt?.getTime())
            || sourceUpdatedAt!.getTime() < sourceCreatedAt!.getTime())
    ) {
        return { ok: false, error: "invalid-params" };
    }
    if (Boolean(params.trustedSourceTimestamps) !== Boolean(params.trustedTranscriptObservationProvenance)) {
        return { ok: false, error: "invalid-params" };
    }

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

    const reconcileExistingLocalId = async (args: Readonly<{
        tx: Tx;
        existing: Parameters<typeof toSessionMessageWriteRow>[0];
        resolvedRole: SessionMessageRole | null;
        attentionImpact: SessionMessageAttentionImpact;
    }>): Promise<CreateSessionMessageResult> => {
        const { tx, existing, resolvedRole, attentionImpact } = args;
        if ((existing.sidechainId ?? null) !== sidechainId) {
            return { ok: false, error: "invalid-params" };
        }
        const existingHasObservationProvenance = existing.transcriptObservationProvenance != null;
        const incomingHasObservationProvenance = params.trustedTranscriptObservationProvenance !== undefined;
        if (existingHasObservationProvenance !== incomingHasObservationProvenance) {
            return { ok: false, error: "invalid-params" };
        }
        if (
            incomingHasObservationProvenance
            && (
                !isDeepStrictEqual(existing.transcriptObservationProvenance, params.trustedTranscriptObservationProvenance)
                || existing.sourceCreatedAt?.getTime() !== sourceCreatedAt?.getTime()
                || existing.sourceUpdatedAt == null
                || sourceUpdatedAt === null
                || sourceUpdatedAt.getTime() < existing.sourceUpdatedAt.getTime()
            )
        ) {
            return { ok: false, error: "invalid-params" };
        }

        if (isDeepStrictEqual(existing.content, content)) {
            const shouldBackfillRole = existing.messageRole === null && resolvedRole !== null;
            const shouldAdvanceSourceUpdatedAt = (
                incomingHasObservationProvenance
                && sourceUpdatedAt !== null
                && existing.sourceUpdatedAt != null
                && sourceUpdatedAt.getTime() > existing.sourceUpdatedAt.getTime()
            );
            if (shouldBackfillRole || shouldAdvanceSourceUpdatedAt) {
                const updatedMetadata = await tx.sessionMessage.update({
                    where: { id: existing.id },
                    data: {
                        ...(shouldBackfillRole ? { messageRole: resolvedRole } : {}),
                        ...(shouldAdvanceSourceUpdatedAt ? { sourceUpdatedAt } : {}),
                        rowRevision: { increment: 1 },
                    },
                    select: SESSION_MESSAGE_WRITE_SELECT,
                });
                return { ok: true, didWrite: false, didUpdate: false, badgeAttentionChanged: false, message: toSessionMessageWriteRow(updatedMetadata), participantCursors: [] };
            }
            return { ok: true, didWrite: false, didUpdate: false, badgeAttentionChanged: false, message: toSessionMessageWriteRow(existing), participantCursors: [] };
        }

        const updated = await tx.sessionMessage.update({
            where: { id: existing.id },
            data: {
                content,
                sidechainId,
                messageRole: resolvedRole,
                ...(sourceUpdatedAt ? { sourceUpdatedAt } : {}),
                rowRevision: { increment: 1 },
            },
            select: SESSION_MESSAGE_WRITE_SELECT,
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
            attentionImpact,
            message: toSessionMessageWriteRow(updated),
            participantCursors,
        };
    };

    try {
        return await inTx(async (tx) => {
            if (params.trustedPublisherFence) {
                const fence = params.trustedPublisherFence;
                if (
                    fence.accountId !== actorUserId
                    || fence.sessionId !== sessionId
                    || !await hasCurrentSessionScopedMachineAccessInTx({
                        tx,
                        accountId: fence.accountId,
                        machineId: fence.machineId,
                        sessionId: fence.sessionId,
                    })
                ) {
                    return { ok: false, error: "forbidden" };
                }
                const currentPublisherSession = await tx.session.findUnique({
                    where: { id: sessionId },
                    select: { active: true, archivedAt: true, lastActiveAt: true },
                });
                if (
                    !currentPublisherSession
                    || currentPublisherSession.archivedAt !== null
                    || !currentPublisherSession.active
                    || currentPublisherSession.lastActiveAt.getTime() !== fence.committedFence.getTime()
                ) {
                    return { ok: false, error: "forbidden" };
                }
            }
            const access = await ensureSessionEditAccess(tx, { actorUserId, sessionId });
            if (!access.ok) {
                return { ok: false, error: access.error };
            }
            const resolvedRole = resolveRoleForStorageMode(access.sessionEncryptionMode);
            const trustedLocalIdAttentionImpact = access.sessionOwnerId === actorUserId && resolvedRole === "event"
                ? agentEventLocalIdAttentionImpact(localId)
                : null;
            const attentionImpact = resolveMessageAttentionImpact({
                content,
                explicitAttentionImpact: params.trustedAttentionImpact ?? trustedLocalIdAttentionImpact ?? undefined,
            });

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
                    select: SESSION_MESSAGE_WRITE_SELECT,
                });
                if (existing) {
                    return await reconcileExistingLocalId({
                        tx,
                        existing,
                        resolvedRole,
                        attentionImpact,
                    });
                }
            }

            const beforeBadgeInputs = await tx.session.findUnique({
                where: { id: sessionId },
                select: selectSessionActivityBadgeInputs(),
            });
            const normalizedBeforeBadgeInputs = toSessionActivityBadgeInputs(beforeBadgeInputs);

            // The unread fact moves with `seq`, so it is maintained inside the same statement that
            // advances it. `shouldAdvanceReadCursorForNonUnreadMessage` depends only on the
            // pre-write badge inputs, so the post-write cursor is known before the write.
            const willAdvanceReadCursor = !attentionImpact.affectsUnread
                && shouldAdvanceReadCursorForNonUnreadMessage(normalizedBeforeBadgeInputs);
            const nextSeq = (normalizedBeforeBadgeInputs.seq ?? 0) + 1;

            const next = await tx.session.update({
                where: { id: sessionId },
                select: { seq: true },
                data: {
                    seq: { increment: 1 },
                    ...resolveSessionUnreadSinceWrite({
                        stored: { unreadSince: beforeBadgeInputs?.unreadSince ?? null },
                        after: toSessionUnreadInputs(normalizedBeforeBadgeInputs, {
                            seq: nextSeq,
                            lastViewedSessionSeq: willAdvanceReadCursor
                                ? nextSeq
                                : normalizedBeforeBadgeInputs.lastViewedSessionSeq,
                        }),
                        now: new Date(),
                    }),
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
                    ...(sourceCreatedAt ? { sourceCreatedAt } : {}),
                    ...(sourceUpdatedAt ? { sourceUpdatedAt } : {}),
                    ...(params.trustedTranscriptObservationProvenance
                        ? { transcriptObservationProvenance: params.trustedTranscriptObservationProvenance }
                        : {}),
                },
                select: SESSION_MESSAGE_WRITE_SELECT,
            });

            const readyProjection = await updateSessionMessageActivityProjection(tx, {
                sessionId,
                created,
                affectsMeaningfulActivity: attentionImpact.affectsMeaningfulActivity,
                trustedSessionEventType: resolveReadyProjectionEventType({
                    actorUserId,
                    sessionOwnerId: access.sessionOwnerId,
                    content,
                    requestedSessionEventType: params.trustedSessionEventType,
                }),
            });

            let nextLastViewedSessionSeq = normalizedBeforeBadgeInputs.lastViewedSessionSeq ?? null;
            if (willAdvanceReadCursor) {
                const { count } = await tx.session.updateMany({
                    where: {
                        id: sessionId,
                        OR: [{ lastViewedSessionSeq: { lt: created.seq } }, { lastViewedSessionSeq: null }],
                    },
                    data: { lastViewedSessionSeq: created.seq },
                });
                if (count > 0) {
                    nextLastViewedSessionSeq = created.seq;
                } else {
                    const freshReadCursor = await tx.session.findUnique({
                        where: { id: sessionId },
                        select: { lastViewedSessionSeq: true },
                    });
                    nextLastViewedSessionSeq = freshReadCursor?.lastViewedSessionSeq ?? nextLastViewedSessionSeq;
                }
            }

            const participantCursors = await markSessionParticipantsChanged({
                tx,
                sessionId,
                hint: { lastMessageSeq: created.seq, lastMessageId: created.id },
            });

            const badgeAttentionChanged = didSessionActivityBadgeContributionChange(
                normalizedBeforeBadgeInputs,
                {
                    ...normalizedBeforeBadgeInputs,
                    seq: created.seq,
                    lastViewedSessionSeq: nextLastViewedSessionSeq,
                },
            );

            return {
                ok: true,
                didWrite: true,
                didUpdate: false,
                badgeAttentionChanged,
                attentionImpact,
                message: toSessionMessageWriteRow(created),
                participantCursors,
                ...(readyProjection ? { readyProjection } : {}),
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
            try {
                return await inTx(async (tx) => {
                    if (params.trustedPublisherFence) {
                        const fence = params.trustedPublisherFence;
                        if (
                            fence.accountId !== actorUserId
                            || fence.sessionId !== sessionId
                            || !await hasCurrentSessionScopedMachineAccessInTx({
                                tx,
                                accountId: fence.accountId,
                                machineId: fence.machineId,
                                sessionId: fence.sessionId,
                            })
                        ) {
                            return { ok: false, error: "forbidden" } as const;
                        }
                        const currentPublisherSession = await tx.session.findUnique({
                            where: { id: sessionId },
                            select: { active: true, archivedAt: true, lastActiveAt: true },
                        });
                        if (
                            !currentPublisherSession
                            || currentPublisherSession.archivedAt !== null
                            || !currentPublisherSession.active
                            || currentPublisherSession.lastActiveAt.getTime() !== fence.committedFence.getTime()
                        ) {
                            return { ok: false, error: "forbidden" } as const;
                        }
                    }
                    const access = await ensureSessionEditAccess(tx, { actorUserId, sessionId });
                    if (!access.ok) return { ok: false, error: access.error };
                    const resolvedRole = resolveRoleForStorageMode(access.sessionEncryptionMode);
                    const trustedLocalIdAttentionImpact = access.sessionOwnerId === actorUserId && resolvedRole === "event"
                        ? agentEventLocalIdAttentionImpact(localId)
                        : null;
                    const attentionImpact = resolveMessageAttentionImpact({
                        content,
                        explicitAttentionImpact: params.trustedAttentionImpact ?? trustedLocalIdAttentionImpact ?? undefined,
                    });
                    const existing = await tx.sessionMessage.findUnique({
                        where: { sessionId_localId: { sessionId, localId } },
                        select: SESSION_MESSAGE_WRITE_SELECT,
                    });
                    if (!existing) return { ok: false, error: "internal" } as const;
                    return await reconcileExistingLocalId({
                        tx,
                        existing,
                        resolvedRole,
                        attentionImpact,
                    });
                });
            } catch {
                return { ok: false, error: "internal" };
            }
        }
        log(
            { module: "session-write", level: "error", sessionId, error: e },
            "Unexpected error while creating a session message",
        );
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
                    encryptionMode: true,
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

            if (isSessionMetadataNoOp({
                currentMetadata: session.metadata,
                nextMetadata: metadataCiphertext,
                encryptionMode: session.encryptionMode,
            })) {
                if (typeof nextLastViewedSessionSeq !== "number") {
                    return {
                        ok: true,
                        version: expectedVersion,
                        metadata: session.metadata,
                        participantCursors: [],
                        badgeAttentionChanged: false,
                    };
                }

                const { count } = await tx.session.updateMany({
                    where: { id: sessionId, metadataVersion: expectedVersion },
                    data: {
                        lastViewedSessionSeq: nextLastViewedSessionSeq,
                        ...resolveSessionUnreadSinceWrite({
                            stored: session,
                            after: toSessionUnreadInputs(session, {
                                lastViewedSessionSeq: nextLastViewedSessionSeq,
                            }),
                            now: new Date(),
                        }),
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
                return {
                    ok: true,
                    version: expectedVersion,
                    metadata: session.metadata,
                    participantCursors,
                    badgeAttentionChanged: didSessionActivityBadgeContributionChange(
                        toSessionActivityBadgeInputs(session),
                        {
                            ...toSessionActivityBadgeInputs(session),
                            lastViewedSessionSeq: nextLastViewedSessionSeq,
                        },
                    ),
                    lastViewedSessionSeq: nextLastViewedSessionSeq,
                };
            }

            const { count } = await tx.session.updateMany({
                where: { id: sessionId, metadataVersion: expectedVersion },
                data: {
                    metadata: metadataCiphertext,
                    metadataVersion: expectedVersion + 1,
                    ...(typeof nextLastViewedSessionSeq === "number"
                        ? {
                            lastViewedSessionSeq: nextLastViewedSessionSeq,
                            ...resolveSessionUnreadSinceWrite({
                                stored: session,
                                after: toSessionUnreadInputs(session, {
                                    lastViewedSessionSeq: nextLastViewedSessionSeq,
                                }),
                                now: new Date(),
                            }),
                        }
                        : {}),
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
    const pendingRequestObservedAt = hasPendingRequestCountUpdate
        && ((pendingPermissionRequestCount ?? 0) + (pendingUserActionRequestCount ?? 0)) > 0
            ? Date.now()
            : null;

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
                    ...(hasPendingRequestCountUpdate
                        ? { pendingRequestObservedAt: pendingRequestObservedAt === null ? null : new Date(pendingRequestObservedAt) }
                        : {}),
                    // Both pending counters are attention arms, so crossing zero in either direction
                    // moves the session into or out of attention — and nothing here has to say so:
                    // `Session.needsAttention` is generated from these very columns.
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
                    ...(hasPendingRequestCountUpdate ? { pendingRequestObservedAt } : {}),
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
                ...(hasPendingRequestCountUpdate ? { pendingRequestObservedAt } : {}),
            };
        });
    } catch {
        return { ok: false, error: "internal" };
    }
}

export type ApplySessionTurnMutationResult =
    | {
        ok: true;
        didApply: boolean;
        reason?: SessionTurnNoOpReason;
        receipt: SessionTurnMutationReceiptV1;
        latestTurnId: string | null;
        latestTurnStatus: PrimaryTurnStatusV1 | null;
        latestTurnStatusObservedAt: number | null;
        lastRuntimeIssue: SessionRuntimeIssueV1 | null;
        participantCursors: ParticipantCursor[];
        badgeAttentionChanged: boolean;
      }
    | { ok: false; error: "invalid-params" | "forbidden" | "session-not-found" | "internal" };

async function applySessionTurnMutationWithOwnerAccess(params: {
    actorUserId: string;
    sessionTurnMutation: SessionTurnMutationV1;
}): Promise<ApplySessionTurnMutationResult> {
    return await inTx(async (tx) => {
        const access = await ensureSessionOwnerAccess(tx, { actorUserId: params.actorUserId, sessionId: params.sessionTurnMutation.sessionId });
        if (!access.ok) {
            return { ok: false, error: access.error };
        }

        const session = await tx.session.findUnique({
            where: { id: params.sessionTurnMutation.sessionId },
            select: {
                latestTurnId: true,
                latestTurnStatusObservedAt: true,
                ...selectSessionActivityBadgeInputs(),
            },
        });
        if (!session) {
            return { ok: false, error: "session-not-found" };
        }

        const result = await applySessionTurnMutationInTx({
            tx,
            sessionId: params.sessionTurnMutation.sessionId,
            mutation: params.sessionTurnMutation,
            session,
            markParticipants: true,
        });

        return {
            ok: true,
            didApply: result.didApply,
            ...(result.reason ? { reason: result.reason } : {}),
            receipt: result.receipt,
            latestTurnId: result.latestTurnId,
            latestTurnStatus: result.latestTurnStatus,
            latestTurnStatusObservedAt: result.latestTurnStatusObservedAt,
            lastRuntimeIssue: result.lastRuntimeIssue,
            participantCursors: result.participantCursors,
            badgeAttentionChanged: result.badgeAttentionChanged,
        };
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
    const sessionTurnMutation: SessionTurnMutationV1 = mutation.data;

    try {
        return await applySessionTurnMutationWithOwnerAccess({ actorUserId, sessionTurnMutation });
    } catch (error) {
        if (isDuplicateSessionTurnMutationRace(error)) {
            try {
                return await applySessionTurnMutationWithOwnerAccess({ actorUserId, sessionTurnMutation });
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

            const readableSessionSeq = operation.kind === "mark-unread" && session.lastViewedSessionSeq !== null
                ? await resolveManualUnreadReadableSessionSeq(tx, sessionId, session)
                : undefined;
            const resolved = resolveSessionReadCursorOperation({
                sessionSeq: session.seq,
                readableSessionSeq,
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
                data: {
                    lastViewedSessionSeq: nextCursor,
                    ...resolveSessionUnreadSinceWrite({
                        stored: session,
                        after: toSessionUnreadInputs(session, { lastViewedSessionSeq: nextCursor }),
                        now: new Date(),
                    }),
                },
            });

            if (count === 0) {
                const fresh = await tx.session.findUnique({
                    where: { id: sessionId },
                    select: {
                        seq: true,
                        lastViewedSessionSeq: true,
                    },
                });
                if (!fresh) {
                    return { ok: false, error: "session-not-found" };
                }
                const readStateSeq = operation.kind === "mark-unread" && typeof readableSessionSeq === "number"
                    ? readableSessionSeq
                    : fresh.seq;
                return {
                    ok: true,
                    lastViewedSessionSeq: fresh.lastViewedSessionSeq ?? null,
                    participantCursors: [],
                    badgeAttentionChanged: false,
                    didChange: false,
                    readState: resolveSessionReadState(readStateSeq, fresh.lastViewedSessionSeq),
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
                    encryptionMode: true,
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

            const metadataChanged = !!metadata && !isSessionMetadataNoOp({
                currentMetadata: current.metadata,
                nextMetadata: metadata.ciphertext,
                encryptionMode: current.encryptionMode,
            });
            const agentStateChanged = !!agentState && current.agentState !== agentState.ciphertext;

            if (!metadataChanged && !agentStateChanged) {
                return {
                    ok: true,
                    participantCursors: [],
                    ...(metadata ? { metadata: { version: current.metadataVersion, value: current.metadata } } : {}),
                    ...(agentState ? { agentState: { version: current.agentStateVersion, value: current.agentState } } : {}),
                };
            }

            const updateData: any = {};
            if (metadataChanged && metadata) {
                updateData.metadata = metadata.ciphertext;
                updateData.metadataVersion = metadata.expectedVersion + 1;
            }
            if (agentStateChanged && agentState) {
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
                ...(metadata ? {
                    metadata: {
                        version: metadataChanged ? metadata.expectedVersion + 1 : current.metadataVersion,
                        value: metadataChanged ? metadata.ciphertext : current.metadata,
                    },
                } : {}),
                ...(agentState ? {
                    agentState: {
                        version: agentStateChanged ? agentState.expectedVersion + 1 : current.agentStateVersion,
                        value: agentStateChanged ? agentState.ciphertext : current.agentState,
                    },
                } : {}),
            };
        });
    } catch {
        return { ok: false, error: "internal" };
    }
}
