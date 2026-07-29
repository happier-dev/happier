import { markSessionParticipantsChanged, type SessionParticipantCursor } from "@/app/session/changeTracking/markSessionParticipantsChanged";
import { observeCreateSessionMessageStage } from "@/app/monitoring/metrics/sessionWriteMetrics";
import { db } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";
import { isPrismaErrorCode } from "@/storage/prisma";
import { log } from "@/utils/logging/log";
import { readEncryptionFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import {
    SESSION_MESSAGE_NO_USER_ATTENTION_IMPACT,
    SESSION_MESSAGE_USER_ATTENTION_IMPACT,
    VOICE_TRANSCRIPT_HISTORY_SYSTEM_SESSION_TAG,
    agentEventAttentionImpact,
    agentEventLocalIdAttentionImpact,
    ExactSessionTurnEndMutationV1Schema,
    PrimaryTurnStatusV1Schema,
    SessionRuntimeActivityProjectionSchema,
    SessionRuntimeActivitySnapshotSchema,
    TranscriptRawAgentEventV1Schema,
    TranscriptRawRecordV1Schema,
    SessionTurnMutationActionV1Schema,
    SessionTurnMutationV1Schema,
    SessionTranscriptObservationProvenanceV1Schema,
    sanitizeSessionRuntimeIssueV1,
    isSessionOwnerMetadataCiphertextV1,
    SESSION_METADATA_LAYOUT_VERSION_V1,
    type PrimaryTurnStatusV1,
    type SessionMetadataInactiveModelIntentExpectationV1,
    type SessionMetadataOwnerMigrationPatchV1,
    type SessionMessageRole,
    type SessionRuntimeIssueV1,
    type SessionMessageAttentionImpact,
    type SessionRuntimeActivityState,
    type SessionTurnMutationActionV1,
    type SessionTurnMutationDecisionV1,
    type SessionTurnMutationReceiptV1,
    type SessionTurnMutationV1,
    type SessionTranscriptObservationProvenanceV1,
} from "@happier-dev/protocol";
import { isDeepStrictEqual } from "node:util";
import { parseSessionMessageSidechainId } from "./parseSessionMessageSidechainId";
import { didSessionActivityBadgeContributionChange, type SessionActivityBadgeInputs } from "@/app/activity/accountActivityBadge";
import {
    resolveSessionReadCursorOperation,
    type SessionReadCursorOperation,
    type SessionReadCursorReadState,
} from "./readCursor/resolveSessionReadCursorOperation";
import { parseSessionMessageRole, resolveSessionMessageRole } from "./messageRole/resolveSessionMessageRole";
import { hasCurrentSessionScopedMachineAccessInTx } from "@/app/api/socket/sessionScopedBinding";
import type { CurrentSessionPublisherAuthority } from "@/app/presence/sessionPublisherPresence";
import { hasExactCurrentPublisherAuthorityInTx } from "./pending/hasExactCurrentPublisherAuthorityInTx";
import {
    writeSessionTranscriptMessageInTx,
    type SessionTranscriptWriteRejectionCode,
} from "./sessionTranscriptWrite";
import { parseStoredSessionTurnTranscriptAnchors } from "./turns/parseSessionTurnState";
import {
    applySessionTranscriptPublicationCeilingToProjection,
    buildSessionMessagePublicationWhere,
    SESSION_TRANSCRIPT_PUBLICATION_SELECT,
    type SessionTranscriptPublicationFields,
} from "./sessionTranscriptPublicationPolicy";
import { acquireAccountSessionOwnerMetadataFenceInTx } from "@/app/encryption/accountSessionOwnerMetadataFence";

export {
    writeHistoricalSessionMessageBatch,
    writeHistoricalSessionMessageBatchInTx,
    writeHistoricalSessionMessageInTx,
} from "./sessionTranscriptWrite";

type ParticipantCursor = SessionParticipantCursor;
const JSON_PARSE_FAILED = Symbol("json-parse-failed");

function parseJsonForComparison(
    value: string,
): unknown | typeof JSON_PARSE_FAILED {
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
    if (params.currentMetadata === params.nextMetadata) return true;
    if (params.encryptionMode !== "plain") return false;
    const current = parseJsonForComparison(params.currentMetadata);
    const next = parseJsonForComparison(params.nextMetadata);
    return current !== JSON_PARSE_FAILED
        && next !== JSON_PARSE_FAILED
        && isDeepStrictEqual(current, next);
}

type SessionMessageWriteRow = {
    id: string;
    seq: number;
    localId: string | null;
    sidechainId: string | null;
    messageRole: SessionMessageRole | null;
    content: PrismaJson.SessionMessageContent;
    createdAt: Date;
    updatedAt: Date;
    sourceCreatedAt: Date | null;
    sourceUpdatedAt: Date | null;
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

function toSessionMessageWriteRow(row: Omit<SessionMessageWriteRow, "messageRole" | "transcriptObservationProvenance"> & { messageRole: unknown; transcriptObservationProvenance: unknown }): SessionMessageWriteRow {
    const { transcriptObservationProvenance: rawProvenance, ...rest } = row;
    const provenance = SessionTranscriptObservationProvenanceV1Schema.safeParse(rawProvenance);
    return {
        ...rest,
        messageRole: parseSessionMessageRole(row.messageRole),
        ...(provenance.success ? { transcriptObservationProvenance: provenance.data } : {}),
    };
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

type StoredPlainAgentEvent = ReturnType<typeof TranscriptRawAgentEventV1Schema.parse>;

function resolvePlainStoredAgentEvent(content: PrismaJson.SessionMessageContent): StoredPlainAgentEvent | null {
    if (content.t !== "plain") return null;
    const parsed = TranscriptRawRecordV1Schema.safeParse(content.v);
    if (!parsed.success) return null;
    if (parsed.data.role !== "agent" || parsed.data.content.type !== "event") return null;
    const event = TranscriptRawAgentEventV1Schema.safeParse(parsed.data.content.data);
    return event.success ? event.data : null;
}

function resolveMessageAttentionImpact(params: Readonly<{
    content: PrismaJson.SessionMessageContent;
    explicitAttentionImpact?: SessionMessageAttentionImpact;
}>): SessionMessageAttentionImpact {
    if (params.explicitAttentionImpact) return params.explicitAttentionImpact;
    const event = resolvePlainStoredAgentEvent(params.content);
    return event ? agentEventAttentionImpact(event) : SESSION_MESSAGE_USER_ATTENTION_IMPACT;
}

function resolveSessionOwnedAttentionImpact(sessionTag: string): SessionMessageAttentionImpact | null {
    return sessionTag === VOICE_TRANSCRIPT_HISTORY_SYSTEM_SESSION_TAG
        ? SESSION_MESSAGE_NO_USER_ATTENTION_IMPACT
        : null;
}

function shouldAdvanceReadCursorForNonUnreadMessage(session: SessionActivityBadgeInputs): boolean {
    const seq = typeof session.seq === "number" && Number.isFinite(session.seq)
        ? Math.max(0, Math.trunc(session.seq))
        : 0;
    const lastViewedSessionSeq =
        typeof session.lastViewedSessionSeq === "number" && Number.isFinite(session.lastViewedSessionSeq)
            ? Math.max(0, Math.trunc(session.lastViewedSessionSeq))
            : 0;
    return lastViewedSessionSeq >= seq;
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

async function findLatestUnreadAffectingMainTranscriptMessageSeq(
    tx: Tx,
    sessionId: string,
    publication: SessionTranscriptPublicationFields,
): Promise<number | null> {
    const pageSize = 100;
    let beforeSeq: number | null = null;
    for (;;) {
        const messages = await tx.sessionMessage.findMany({
            where: buildSessionMessagePublicationWhere({
                where: {
                    sessionId,
                    sidechainId: null,
                    ...(beforeSeq === null ? {} : { seq: { lt: beforeSeq } }),
                },
                publication,
            }),
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
        latestTurnStatus?: unknown;
    }> & SessionTranscriptPublicationFields,
): Promise<number> {
    const publicationProjection = applySessionTranscriptPublicationCeilingToProjection({
        seq: normalizeReadSeq(session.seq) ?? 0,
        latestReadyEventSeq: normalizeReadSeq(session.latestReadyEventSeq),
    }, session);
    const latestMainMessageSeq = await findLatestUnreadAffectingMainTranscriptMessageSeq(tx, sessionId, session);
    let readableSeq = maxReadSeq(latestMainMessageSeq, normalizeReadSeq(publicationProjection.latestReadyEventSeq));
    if (readableSeq === null && isTerminalPrimaryTurnStatus(parseStoredPrimaryTurnStatus(session.latestTurnStatus))) {
        readableSeq = publicationProjection.seq;
    }
    return readableSeq ?? publicationProjection.seq;
}

function selectSessionActivityBadgeInputs() {
    return {
        seq: true,
        ...SESSION_TRANSCRIPT_PUBLICATION_SELECT,
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
        ...(value ?? {}),
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

function parseStoredPrimaryTurnStatus(value: unknown): PrimaryTurnStatusV1 | null {
    const parsed = PrimaryTurnStatusV1Schema.safeParse(value);
    return parsed.success ? parsed.data : null;
}

function parseStoredRuntimeIssue(value: unknown): SessionRuntimeIssueV1 | null {
    if (!value) return null;
    if (typeof value === "string") {
        try {
            return sanitizeSessionRuntimeIssueV1(JSON.parse(value));
        } catch {
            return null;
        }
    }
    return sanitizeSessionRuntimeIssueV1(value);
}

function isTerminalPrimaryTurnStatus(status: PrimaryTurnStatusV1 | null): boolean {
    return status === "completed" || status === "cancelled" || status === "failed";
}

function normalizeNonNegativeTimestampMillis(value: unknown): number | null {
    const observedAt =
        typeof value === "bigint"
            ? Number(value)
            : typeof value === "number" && Number.isFinite(value)
                ? value
                : null;
    return typeof observedAt === "number" && Number.isFinite(observedAt)
        ? Math.max(0, Math.floor(observedAt))
        : null;
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
    if (isTerminalPrimaryTurnStatus(latestTurnStatus)) {
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
        sessionTag: string;
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
            tag: true,
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
        return {
            ok: true,
            sessionOwnerId: session.accountId,
            sessionTag: session.tag,
            sessionEncryptionMode,
            participantUserIds,
            sessionActivityBadgeInputs,
        };
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

    return {
        ok: true,
        sessionOwnerId: session.accountId,
        sessionTag: session.tag,
        sessionEncryptionMode,
        participantUserIds,
        sessionActivityBadgeInputs,
    };
}

async function ensureSessionOwnerAccess(tx: Tx, params: { actorUserId: string; sessionId: string }): Promise<EnsureSessionEditAccessResult> {
    const access = await ensureSessionEditAccess(tx, params);
    if (!access.ok) {
        return access;
    }
    if (access.sessionOwnerId !== params.actorUserId) {
        return { ok: false, error: "forbidden" };
    }
    return access;
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
    | { ok: false; error: "invalid-params" | "forbidden" | "session-not-found" | "internal"; code?: SessionTranscriptWriteRejectionCode };

type CreateSessionMessageParamsBase = Readonly<{
    actorUserId: string;
    sessionId: string;
    localId?: string | null;
    sidechainId?: string | null;
    messageRole?: unknown;
    trustedSessionEventType?: "ready";
    trustedAttentionImpact?: SessionMessageAttentionImpact;
    publisherAuthority?: CurrentSessionPublisherAuthority;
    trustedSourceTimestamps?: Readonly<{ createdAt: number; updatedAt: number }>;
    trustedTranscriptObservationProvenance?: SessionTranscriptObservationProvenanceV1;
}>;

export type SessionReadyProjectionUpdate = Readonly<{
    latestReadyEventSeq: number;
    latestReadyEventAt: number;
}>;

async function fenceTrustedTranscriptObservationPublisherInTx(
    tx: Tx,
    authority: CurrentSessionPublisherAuthority,
    actorUserId: string,
    sessionId: string,
): Promise<boolean> {
    if (!await hasExactCurrentPublisherAuthorityInTx(tx, authority, actorUserId, sessionId)) {
        return false;
    }
    // The conditional no-op update is intentional: it takes the same session-row lock used by
    // publisher replacement and keeps the authority check linear with the trusted provenance write.
    const fenced = await tx.session.updateMany({
        where: {
            id: sessionId,
            active: true,
            archivedAt: null,
            lastActiveAt: authority.committedFence,
        },
        data: { lastActiveAt: authority.committedFence },
    });
    return fenced.count === 1;
}

type SuccessfulSessionEditAccess = Extract<EnsureSessionEditAccessResult, { ok: true }>;

type TrustedLocalIdReconciliation =
    | {
        status: "not-found";
        access: SuccessfulSessionEditAccess;
        resolvedRole: SessionMessageRole | null;
        attentionImpact: SessionMessageAttentionImpact;
      }
    | {
        status: "reconciled";
        result: CreateSessionMessageResult;
      };

function resolveSessionMessageRoleForWrite(params: Readonly<{
    content: PrismaJson.SessionMessageContent;
    suppliedRole: unknown;
    sessionId: string;
    storageMode: "e2ee" | "plain";
}>): SessionMessageRole | null {
    return resolveSessionMessageRole({
        content: params.content,
        suppliedRole: params.suppliedRole,
        telemetry: {
            sessionId: params.sessionId,
            storageMode: params.storageMode,
            source: "session-message",
        },
    }).messageRole;
}

async function reconcileExistingTrustedLocalIdInTx(params: Readonly<{
    tx: Tx;
    actorUserId: string;
    sessionId: string;
    localId: string;
    sidechainId: string | null;
    content: PrismaJson.SessionMessageContent;
    suppliedRole: unknown;
    trustedAttentionImpact?: SessionMessageAttentionImpact;
    publisherAuthority?: CurrentSessionPublisherAuthority;
    sourceCreatedAt: Date;
    sourceUpdatedAt: Date;
    provenance: SessionTranscriptObservationProvenanceV1;
}>): Promise<TrustedLocalIdReconciliation> {
    if (
        !params.publisherAuthority
        || !await fenceTrustedTranscriptObservationPublisherInTx(
            params.tx,
            params.publisherAuthority,
            params.actorUserId,
            params.sessionId,
        )
    ) {
        return { status: "reconciled", result: { ok: false, error: "forbidden" } };
    }

    const accessStartedAt = Date.now();
    const access = await ensureSessionEditAccess(params.tx, {
        actorUserId: params.actorUserId,
        sessionId: params.sessionId,
    });
    observeCreateSessionMessageStage({
        stage: "access",
        durationMs: Date.now() - accessStartedAt,
        result: access.ok ? "ok" : "error",
    });
    if (!access.ok) {
        return { status: "reconciled", result: { ok: false, error: access.error } };
    }

    const resolvedRole = resolveSessionMessageRoleForWrite({
        content: params.content,
        suppliedRole: params.suppliedRole,
        sessionId: params.sessionId,
        storageMode: access.sessionEncryptionMode,
    });
    const trustedLocalIdAttentionImpact = access.sessionOwnerId === params.actorUserId && resolvedRole === "event"
        ? agentEventLocalIdAttentionImpact(params.localId)
        : null;
    const attentionImpact = resolveMessageAttentionImpact({
        content: params.content,
        explicitAttentionImpact:
            resolveSessionOwnedAttentionImpact(access.sessionTag)
            ?? params.trustedAttentionImpact
            ?? trustedLocalIdAttentionImpact
            ?? undefined,
    });
    const existing = await params.tx.sessionMessage.findUnique({
        where: { sessionId_localId: { sessionId: params.sessionId, localId: params.localId } },
        select: SESSION_MESSAGE_WRITE_SELECT,
    });
    if (!existing) {
        return {
            status: "not-found",
            access,
            resolvedRole,
            attentionImpact,
        };
    }

    const parsedExistingProvenance = SessionTranscriptObservationProvenanceV1Schema.safeParse(
        existing.transcriptObservationProvenance,
    );
    if (
        (existing.sidechainId ?? null) !== params.sidechainId
        || !parsedExistingProvenance.success
        || !isDeepStrictEqual(parsedExistingProvenance.data, params.provenance)
        || existing.sourceCreatedAt?.getTime() !== params.sourceCreatedAt.getTime()
        || existing.sourceUpdatedAt === null
        || params.sourceUpdatedAt.getTime() < existing.sourceUpdatedAt.getTime()
    ) {
        return { status: "reconciled", result: { ok: false, error: "invalid-params" } };
    }

    if (isDeepStrictEqual(existing.content, params.content)) {
        const advancesWatermark = params.sourceUpdatedAt.getTime() > existing.sourceUpdatedAt.getTime();
        const backfillsRole = existing.messageRole === null && resolvedRole !== null;
        if (!advancesWatermark && !backfillsRole) {
            return {
                status: "reconciled",
                result: {
                    ok: true,
                    didWrite: false,
                    didUpdate: false,
                    badgeAttentionChanged: false,
                    message: toSessionMessageWriteRow(existing),
                    participantCursors: [],
                },
            };
        }
        const updated = await params.tx.sessionMessage.update({
            where: { id: existing.id },
            data: {
                ...(advancesWatermark ? { sourceUpdatedAt: params.sourceUpdatedAt } : {}),
                ...(backfillsRole ? { messageRole: resolvedRole } : {}),
            },
            select: SESSION_MESSAGE_WRITE_SELECT,
        });
        return {
            status: "reconciled",
            result: {
                ok: true,
                didWrite: false,
                didUpdate: false,
                badgeAttentionChanged: false,
                message: toSessionMessageWriteRow(updated),
                participantCursors: [],
            },
        };
    }

    const updated = await params.tx.sessionMessage.update({
        where: { id: existing.id },
        data: {
            content: params.content,
            sidechainId: params.sidechainId,
            messageRole: resolvedRole,
            sourceUpdatedAt: params.sourceUpdatedAt,
        },
        select: SESSION_MESSAGE_WRITE_SELECT,
    });
    const participantCursors = await markSessionParticipantsChanged({
        tx: params.tx,
        sessionId: params.sessionId,
        hint: { updatedMessageSeq: updated.seq, updatedMessageId: updated.id },
        participantUserIds: access.participantUserIds,
    });
    return {
        status: "reconciled",
        result: {
            ok: true,
            didWrite: false,
            didUpdate: true,
            badgeAttentionChanged: false,
            attentionImpact,
            message: toSessionMessageWriteRow(updated),
            participantCursors,
        },
    };
}

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
    const sourceTimestamps = params.trustedSourceTimestamps;
    const hasTrustedProvenance = params.trustedTranscriptObservationProvenance !== undefined;
    if ((sourceTimestamps === undefined) !== !hasTrustedProvenance) {
        return { ok: false, error: "invalid-params" };
    }
    if (sourceTimestamps && (
        !Number.isSafeInteger(sourceTimestamps.createdAt)
        || sourceTimestamps.createdAt < 0
        || !Number.isSafeInteger(sourceTimestamps.updatedAt)
        || sourceTimestamps.updatedAt < sourceTimestamps.createdAt
    )) {
        return { ok: false, error: "invalid-params" };
    }
    const sourceCreatedAt = sourceTimestamps ? new Date(sourceTimestamps.createdAt) : null;
    const sourceUpdatedAt = sourceTimestamps ? new Date(sourceTimestamps.updatedAt) : null;
    if (
        sourceTimestamps
        && (!Number.isFinite(sourceCreatedAt?.getTime()) || !Number.isFinite(sourceUpdatedAt?.getTime()))
    ) {
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
        resolveSessionMessageRoleForWrite({
            content,
            suppliedRole: params.messageRole,
            sessionId,
            storageMode,
        });

    try {
        return await inTx(async (tx) => {
            let access: SuccessfulSessionEditAccess;
            let resolvedRole: SessionMessageRole | null;
            let attentionImpact: SessionMessageAttentionImpact;
            if (localId && hasTrustedProvenance) {
                if (
                    !sourceCreatedAt
                    || !sourceUpdatedAt
                    || !params.trustedTranscriptObservationProvenance
                ) {
                    return { ok: false, error: "invalid-params" };
                }
                const reconciliation = await reconcileExistingTrustedLocalIdInTx({
                    tx,
                    actorUserId,
                    sessionId,
                    localId,
                    sidechainId,
                    content,
                    suppliedRole: params.messageRole,
                    trustedAttentionImpact: params.trustedAttentionImpact,
                    publisherAuthority: params.publisherAuthority,
                    sourceCreatedAt,
                    sourceUpdatedAt,
                    provenance: params.trustedTranscriptObservationProvenance,
                });
                if (reconciliation.status === "reconciled") {
                    if (!reconciliation.result.ok) {
                        observeCreateSessionMessageStage({
                            stage: "total",
                            durationMs: Date.now() - totalStartedAt,
                            result: "error",
                        });
                    }
                    return reconciliation.result;
                }
                ({ access, resolvedRole, attentionImpact } = reconciliation);
            } else {
                if (hasTrustedProvenance && (
                    !params.publisherAuthority
                    || !await fenceTrustedTranscriptObservationPublisherInTx(tx, params.publisherAuthority, actorUserId, sessionId)
                )) {
                    return { ok: false, error: "forbidden" };
                }
                const accessStartedAt = Date.now();
                const accessResult = await ensureSessionEditAccess(tx, { actorUserId, sessionId });
                observeCreateSessionMessageStage({
                    stage: "access",
                    durationMs: Date.now() - accessStartedAt,
                    result: accessResult.ok ? "ok" : "error",
                });
                if (!accessResult.ok) {
                    observeCreateSessionMessageStage({
                        stage: "total",
                        durationMs: Date.now() - totalStartedAt,
                        result: "error",
                    });
                    return { ok: false, error: accessResult.error };
                }
                access = accessResult;
                resolvedRole = resolveRoleForStorageMode(access.sessionEncryptionMode);
                const trustedLocalIdAttentionImpact = access.sessionOwnerId === actorUserId && resolvedRole === "event"
                    ? agentEventLocalIdAttentionImpact(localId)
                    : null;
                attentionImpact = resolveMessageAttentionImpact({
                    content,
                    explicitAttentionImpact:
                        resolveSessionOwnedAttentionImpact(access.sessionTag)
                        ?? params.trustedAttentionImpact
                        ?? trustedLocalIdAttentionImpact
                        ?? undefined,
                });
            }

            const encryptionPolicy = readEncryptionFeatureEnv(process.env);

            const persistStartedAt = Date.now();
            const persisted = await writeSessionTranscriptMessageInTx(tx, {
                sessionId,
                writeAuthority: "hosted",
                sessionEncryptionMode: access.sessionEncryptionMode,
                storagePolicy: encryptionPolicy.storagePolicy,
                content,
                localId,
                sidechainId,
                messageRole: resolvedRole,
                ...(sourceCreatedAt ? { sourceCreatedAt } : {}),
                ...(sourceUpdatedAt ? { sourceUpdatedAt } : {}),
                ...(params.trustedTranscriptObservationProvenance
                    ? { transcriptObservationProvenance: params.trustedTranscriptObservationProvenance }
                    : {}),
            });
            if (!persisted.ok) {
                observeCreateSessionMessageStage({
                    stage: "total",
                    durationMs: Date.now() - totalStartedAt,
                    result: "error",
                });
                return { ok: false, error: "invalid-params", code: persisted.code };
            }
            const created = persisted.message;
            const readyProjection = await updateSessionMessageActivityProjection(tx, {
                sessionId,
                created,
                trustedSessionEventType: resolveReadyProjectionEventType({
                    actorUserId,
                    sessionOwnerId: access.sessionOwnerId,
                    content,
                    requestedSessionEventType: params.trustedSessionEventType,
                }),
                affectsMeaningfulActivity: attentionImpact.affectsMeaningfulActivity,
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

            const nextSessionActivityBadgeInputs = {
                ...access.sessionActivityBadgeInputs,
                seq: created.seq,
            };
            if (
                !attentionImpact.affectsUnread
                && (
                    access.sessionTag === VOICE_TRANSCRIPT_HISTORY_SYSTEM_SESSION_TAG
                    || shouldAdvanceReadCursorForNonUnreadMessage(access.sessionActivityBadgeInputs)
                )
            ) {
                const { count } = await tx.session.updateMany({
                    where: {
                        id: sessionId,
                        OR: [{ lastViewedSessionSeq: { lt: created.seq } }, { lastViewedSessionSeq: null }],
                    },
                    data: { lastViewedSessionSeq: created.seq },
                });
                if (count > 0) {
                    nextSessionActivityBadgeInputs.lastViewedSessionSeq = created.seq;
                } else {
                    const freshReadCursor = await tx.session.findUnique({
                        where: { id: sessionId },
                        select: { lastViewedSessionSeq: true },
                    });
                    nextSessionActivityBadgeInputs.lastViewedSessionSeq = freshReadCursor?.lastViewedSessionSeq ?? nextSessionActivityBadgeInputs.lastViewedSessionSeq;
                }
            }
            const badgeAttentionChanged = didSessionActivityBadgeContributionChange(
                access.sessionActivityBadgeInputs,
                nextSessionActivityBadgeInputs,
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
                attentionImpact,
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
            if (hasTrustedProvenance) {
                try {
                    return await inTx(async (tx) => {
                        if (
                            !sourceCreatedAt
                            || !sourceUpdatedAt
                            || !params.trustedTranscriptObservationProvenance
                        ) {
                            return { ok: false, error: "invalid-params" };
                        }
                        const reconciliation = await reconcileExistingTrustedLocalIdInTx({
                            tx,
                            actorUserId,
                            sessionId,
                            localId,
                            sidechainId,
                            content,
                            suppliedRole: params.messageRole,
                            trustedAttentionImpact: params.trustedAttentionImpact,
                            publisherAuthority: params.publisherAuthority,
                            sourceCreatedAt,
                            sourceUpdatedAt,
                            provenance: params.trustedTranscriptObservationProvenance,
                        });
                        return reconciliation.status === "reconciled"
                            ? reconciliation.result
                            : { ok: false, error: "invalid-params" };
                    }, { isolationLevel: "ReadCommitted" });
                } catch {
                    return { ok: false, error: "internal" };
                }
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
            const trustedLocalIdAttentionImpact = access.sessionOwnerId === actorUserId && resolvedRole === "event"
                ? agentEventLocalIdAttentionImpact(localId)
                : null;
            const attentionImpact = resolveMessageAttentionImpact({
                content,
                explicitAttentionImpact: params.trustedAttentionImpact ?? trustedLocalIdAttentionImpact ?? undefined,
            });
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
                            attentionImpact,
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
    | { ok: false; error: "invalid-params" | "forbidden" | "session-not-found" | "version-mismatch" | "metadata_privacy_upgrade_required" | "internal"; current?: { version: number; metadata: string } };

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
                    metadataLayoutVersion: true,
                    ownerMetadata: true,
                    metadataVersion: true,
                    metadata: true,
                    encryptionMode: true,
                    ...selectSessionActivityBadgeInputs(),
                },
            });
            if (!session) {
                return { ok: false, error: "session-not-found" };
            }
            if (
                (session.metadataLayoutVersion ?? 0) !== 0
                || session.ownerMetadata !== null
            ) {
                return { ok: false, error: "metadata_privacy_upgrade_required" };
            }
            if (session.metadataVersion !== expectedVersion) {
                return {
                    ok: false,
                    error: "version-mismatch",
                    current: {
                        version: session.metadataVersion,
                        metadata: session.metadata,
                    },
                };
            }

            const nextLastViewedSessionSeq = (() => {
                if (typeof lastViewedSessionSeqHint !== "number") return undefined;
                const current = session.lastViewedSessionSeq;
                const clamped = Math.min(
                    lastViewedSessionSeqHint,
                    session.seq ?? lastViewedSessionSeqHint,
                );
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
                    where: {
                        id: sessionId,
                        metadataVersion: expectedVersion,
                        metadataLayoutVersion: 0,
                        ownerMetadata: null,
                    },
                    data: {
                        lastViewedSessionSeq: nextLastViewedSessionSeq,
                    },
                });
                if (count === 0) {
                    const fresh = await tx.session.findUnique({
                        where: { id: sessionId },
                        select: {
                            metadataLayoutVersion: true,
                            ownerMetadata: true,
                            metadataVersion: true,
                            metadata: true,
                        },
                    });
                    if (!fresh) {
                        return { ok: false, error: "session-not-found" };
                    }
                    if (
                        (fresh.metadataLayoutVersion ?? 0) !== 0
                        || fresh.ownerMetadata !== null
                    ) {
                        return {
                            ok: false,
                            error: "metadata_privacy_upgrade_required",
                        };
                    }
                    return {
                        ok: false,
                        error: "version-mismatch",
                        current: {
                            version: fresh.metadataVersion,
                            metadata: fresh.metadata,
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
                    version: expectedVersion,
                    metadata: session.metadata,
                    participantCursors,
                    badgeAttentionChanged:
                        didSessionActivityBadgeContributionChange(
                            toSessionActivityBadgeInputs(session),
                            {
                                ...toSessionActivityBadgeInputs(session),
                                lastViewedSessionSeq:
                                    nextLastViewedSessionSeq,
                            },
                        ),
                    lastViewedSessionSeq: nextLastViewedSessionSeq,
                };
            }

            const { count } = await tx.session.updateMany({
                where: {
                    id: sessionId,
                    metadataVersion: expectedVersion,
                    metadataLayoutVersion: 0,
                    ownerMetadata: null,
                },
                data: {
                    metadata: metadataCiphertext,
                    metadataVersion: expectedVersion + 1,
                    ...(typeof nextLastViewedSessionSeq === "number"
                        ? { lastViewedSessionSeq: nextLastViewedSessionSeq }
                        : {}),
                },
            });
            if (count === 0) {
                const fresh = await tx.session.findUnique({
                    where: { id: sessionId },
                    select: {
                        metadataLayoutVersion: true,
                        ownerMetadata: true,
                        metadataVersion: true,
                        metadata: true,
                    },
                });
                if (!fresh) {
                    return { ok: false, error: "session-not-found" };
                }
                if (
                    (fresh.metadataLayoutVersion ?? 0) !== 0
                    || fresh.ownerMetadata !== null
                ) {
                    return {
                        ok: false,
                        error: "metadata_privacy_upgrade_required",
                    };
                }
                return {
                    ok: false,
                    error: "version-mismatch",
                    current: {
                        version: fresh.metadataVersion,
                        metadata: fresh.metadata,
                    },
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
                ...(typeof nextLastViewedSessionSeq === "number"
                    ? { lastViewedSessionSeq: nextLastViewedSessionSeq }
                    : {}),
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
    | { ok: false; error: "invalid-params" | "forbidden" | "session-not-found" | "version-mismatch" | "metadata_privacy_upgrade_required" | "internal"; current?: { version: number; agentState: string | null } };

export type SessionRuntimeActivityProjectionUpdate = {
    runtimeActivityState: SessionRuntimeActivityState;
    runtimeActivityActiveCount: number;
    runtimeActivityObservedAt: number | null;
    runtimeActivityRevision: number;
};

export type SessionRuntimeActivityProjectionInTxResult =
    | { status: "applied"; projection: SessionRuntimeActivityProjectionUpdate; becameIdle?: true }
    | { status: "unchanged"; projection: SessionRuntimeActivityProjectionUpdate }
    | { status: "rejected"; reason: "invalid-params" | "invalid_storage" | "not_found" | "revision_overflow" | "contention" };

export type AuthorizedSessionRuntimeActivityProjectionResult =
    | { status: "applied"; projection: SessionRuntimeActivityProjectionUpdate; participantCursors: ParticipantCursor[]; becameIdle?: true }
    | { status: "unchanged"; projection: SessionRuntimeActivityProjectionUpdate; participantCursors: [] }
    | { status: "rejected"; reason: "invalid-params" | "invalid_storage" | "not_found" | "unauthorized" | "archived" | "superseded" | "revision_overflow" | "contention" };

function normalizeRuntimeActivityInteger(value: unknown): number | null {
    if (typeof value === "bigint") {
        const numberValue = Number(value);
        return Number.isSafeInteger(numberValue) && numberValue >= 0 ? numberValue : null;
    }
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function parseStoredRuntimeActivityProjection(value: Readonly<{
    runtimeActivityState?: unknown;
    runtimeActivityActiveCount?: unknown;
    runtimeActivityObservedAt?: unknown;
    runtimeActivityRevision?: unknown;
}>): SessionRuntimeActivityProjectionUpdate | null {
    const observedAt = value.runtimeActivityObservedAt === null
        ? null
        : normalizeRuntimeActivityInteger(value.runtimeActivityObservedAt);
    const revision = normalizeRuntimeActivityInteger(value.runtimeActivityRevision);
    const parsed = SessionRuntimeActivityProjectionSchema.safeParse({
        state: value.runtimeActivityState,
        activeCount: value.runtimeActivityActiveCount,
        observedAt,
        revision,
    });
    if (!parsed.success) return null;
    return {
        runtimeActivityState: parsed.data.state,
        runtimeActivityActiveCount: parsed.data.activeCount,
        runtimeActivityObservedAt: parsed.data.observedAt,
        runtimeActivityRevision: parsed.data.revision,
    };
}

function runtimeActivityProjectionEquals(
    a: SessionRuntimeActivityProjectionUpdate,
    b: SessionRuntimeActivityProjectionUpdate,
): boolean {
    return a.runtimeActivityState === b.runtimeActivityState
        && a.runtimeActivityActiveCount === b.runtimeActivityActiveCount;
}

export async function clearSessionRuntimeActivityProjectionInTx(params: {
    tx: Tx;
    sessionId: string;
}): Promise<
    | { didWrite: false }
    | { didWrite: true; projection: SessionRuntimeActivityProjectionUpdate }
> {
    const result = await writeSessionRuntimeActivityProjectionInTx({
        ...params,
        state: "unknown",
        activeCount: 0,
    });
    if (result.status === "applied") return { didWrite: true, projection: result.projection };
    if (result.status === "unchanged" || result.reason === "not_found") return { didWrite: false };
    if (result.reason === "invalid_storage") throw new Error("Invalid stored Runtime Activity projection");
    if (result.reason === "revision_overflow") throw new Error("Runtime Activity revision overflow");
    if (result.reason === "contention") throw new Error("Runtime Activity projection changed concurrently");
    throw new Error("Invalid Runtime Activity clear request");
}

export async function writeSessionRuntimeActivityProjectionInTx(params: {
    tx: Tx;
    sessionId: string;
    state: unknown;
    activeCount: unknown;
}): Promise<SessionRuntimeActivityProjectionInTxResult> {
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const snapshot = SessionRuntimeActivitySnapshotSchema.safeParse({
        state: params.state,
        activeCount: params.activeCount,
    });
    if (!sessionId || !snapshot.success) {
        return { status: "rejected", reason: "invalid-params" };
    }

    const current = await params.tx.session.findUnique({
        where: { id: sessionId },
        select: {
            runtimeActivityState: true,
            runtimeActivityActiveCount: true,
            runtimeActivityObservedAt: true,
            runtimeActivityRevision: true,
        },
    });
    if (!current) {
        return { status: "rejected", reason: "not_found" };
    }

    const normalizedCurrent = parseStoredRuntimeActivityProjection(current);
    if (!normalizedCurrent) {
        return { status: "rejected", reason: "invalid_storage" };
    }
    const candidate: SessionRuntimeActivityProjectionUpdate = {
        runtimeActivityState: snapshot.data.state,
        runtimeActivityActiveCount: snapshot.data.activeCount,
        runtimeActivityObservedAt: normalizedCurrent.runtimeActivityObservedAt,
        runtimeActivityRevision: normalizedCurrent.runtimeActivityRevision,
    };
    if (runtimeActivityProjectionEquals(normalizedCurrent, candidate)) {
        return { status: "unchanged", projection: normalizedCurrent };
    }

    if (normalizedCurrent.runtimeActivityRevision >= Number.MAX_SAFE_INTEGER) {
        return { status: "rejected", reason: "revision_overflow" };
    }
    const projection: SessionRuntimeActivityProjectionUpdate = {
        ...candidate,
        runtimeActivityObservedAt: Date.now(),
        runtimeActivityRevision: normalizedCurrent.runtimeActivityRevision + 1,
    };

    const write = await params.tx.session.updateMany({
        where: {
            id: sessionId,
            runtimeActivityRevision: current.runtimeActivityRevision,
        },
        data: {
            runtimeActivityState: projection.runtimeActivityState,
            runtimeActivityActiveCount: projection.runtimeActivityActiveCount,
            runtimeActivityObservedAt: BigInt(projection.runtimeActivityObservedAt!),
            runtimeActivityRevision: BigInt(projection.runtimeActivityRevision),
        },
    });
    return write.count === 1
        ? {
            status: "applied",
            projection,
            ...(normalizedCurrent.runtimeActivityState !== "idle" && projection.runtimeActivityState === "idle"
                ? { becameIdle: true as const }
                : {}),
        }
        : { status: "rejected", reason: "contention" };
}

/** Preserves explicit idle on observer loss; every other valid Activity becomes unknown. */
export async function writeSessionRuntimeActivityObserverLossInTx(params: {
    tx: Tx;
    sessionId: string;
}): Promise<SessionRuntimeActivityProjectionInTxResult> {
    const current = await params.tx.session.findUnique({
        where: { id: params.sessionId },
        select: {
            runtimeActivityState: true,
            runtimeActivityActiveCount: true,
            runtimeActivityObservedAt: true,
            runtimeActivityRevision: true,
        },
    });
    if (!current) return { status: "rejected", reason: "not_found" };
    const normalized = parseStoredRuntimeActivityProjection(current);
    if (!normalized) return { status: "rejected", reason: "invalid_storage" };
    if (normalized.runtimeActivityState === "idle") {
        return { status: "unchanged", projection: normalized };
    }
    return await writeSessionRuntimeActivityProjectionInTx({
        ...params,
        state: "unknown",
        activeCount: 0,
    });
}

/** Applies a complete Activity snapshot only for the exact current authenticated publisher fence. */
export async function updateSessionRuntimeActivityProjection(params: {
    accountId: string;
    machineId: string;
    sessionId: string;
    boundCommittedFence: Date;
    state: unknown;
    activeCount: unknown;
}): Promise<AuthorizedSessionRuntimeActivityProjectionResult> {
    const snapshot = SessionRuntimeActivitySnapshotSchema.safeParse({
        state: params.state,
        activeCount: params.activeCount,
    });
    if (!snapshot.success) return { status: "rejected", reason: "invalid-params" };
    return await inTx(async (tx): Promise<AuthorizedSessionRuntimeActivityProjectionResult> => {
        const session = await tx.session.findUnique({
            where: { id: params.sessionId },
            select: { active: true, archivedAt: true, lastActiveAt: true },
        });
        if (!session) return { status: "rejected", reason: "not_found" };
        if (!await hasCurrentSessionScopedMachineAccessInTx({ tx, ...params })) {
            return { status: "rejected", reason: "unauthorized" };
        }
        if (session.archivedAt !== null) return { status: "rejected", reason: "archived" };
        if (!session.active || session.lastActiveAt.getTime() !== params.boundCommittedFence.getTime()) {
            return { status: "rejected", reason: "superseded" };
        }
        const activity = await writeSessionRuntimeActivityProjectionInTx({
            tx,
            sessionId: params.sessionId,
            state: snapshot.data.state,
            activeCount: snapshot.data.activeCount,
        });
        if (activity.status === "rejected") return activity;
        if (activity.status === "unchanged") return { ...activity, participantCursors: [] };
        const participantCursors = await markSessionParticipantsChanged({ tx, sessionId: params.sessionId });
        return { ...activity, participantCursors };
    });
}

export async function updateSessionAgentState(params: {
    actorUserId: string;
    sessionId: string;
    expectedVersion: number;
    agentStateCiphertext: string | null;
    pendingPermissionRequestCount?: number;
    pendingUserActionRequestCount?: number;
    pendingRequestNewestCreatedAt?: number | null;
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
    const pendingRequestNewestCreatedAt =
        params.pendingRequestNewestCreatedAt === null
            ? null
            : typeof params.pendingRequestNewestCreatedAt === "number"
                && Number.isFinite(params.pendingRequestNewestCreatedAt)
                ? Math.max(0, Math.floor(params.pendingRequestNewestCreatedAt))
                : undefined;
    const pendingRequestObservedAt =
        hasPendingRequestCountUpdate
            ? ((pendingPermissionRequestCount ?? 0) + (pendingUserActionRequestCount ?? 0)) > 0
                ? pendingRequestNewestCreatedAt ?? Date.now()
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
                    metadataLayoutVersion: true,
                    ownerMetadata: true,
                    agentStateVersion: true,
                    agentState: true,
                    ...selectSessionActivityBadgeInputs(),
                },
            });
            if (!session) {
                return { ok: false, error: "session-not-found" };
            }
            if (
                (session.metadataLayoutVersion ?? 0) !== 0
                || session.ownerMetadata !== null
            ) {
                return { ok: false, error: "metadata_privacy_upgrade_required" };
            }
            if (session.agentStateVersion !== expectedVersion) {
                return {
                    ok: false,
                    error: "version-mismatch",
                    current: {
                        version: session.agentStateVersion,
                        agentState: session.agentState,
                    },
                };
            }

            const { count } = await tx.session.updateMany({
                where: {
                    id: sessionId,
                    agentStateVersion: expectedVersion,
                    metadataLayoutVersion: 0,
                    ownerMetadata: null,
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
                        ? {
                            pendingRequestObservedAt:
                                pendingRequestObservedAt === null
                                    ? null
                                    : new Date(pendingRequestObservedAt),
                        }
                        : {}),
                },
            });
            if (count === 0) {
                const fresh = await tx.session.findUnique({
                    where: { id: sessionId },
                    select: {
                        metadataLayoutVersion: true,
                        ownerMetadata: true,
                        agentStateVersion: true,
                        agentState: true,
                        ...selectSessionActivityBadgeInputs(),
                    },
                });
                if (!fresh) {
                    return { ok: false, error: "session-not-found" };
                }
                if (
                    (fresh.metadataLayoutVersion ?? 0) !== 0
                    || fresh.ownerMetadata !== null
                ) {
                    return {
                        ok: false,
                        error: "metadata_privacy_upgrade_required",
                    };
                }
                return {
                    ok: false,
                    error: "version-mismatch",
                    current: {
                        version: fresh.agentStateVersion,
                        agentState: fresh.agentState,
                    },
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
                    ...(pendingRequestObservedAt !== undefined
                        ? { pendingRequestObservedAt }
                        : {}),
                },
            );
            return {
                ok: true,
                version: expectedVersion + 1,
                agentState: agentStateCiphertext,
                participantCursors,
                badgeAttentionChanged,
                ...(typeof pendingPermissionRequestCount === "number"
                    ? { pendingPermissionRequestCount }
                    : {}),
                ...(typeof pendingUserActionRequestCount === "number"
                    ? { pendingUserActionRequestCount }
                    : {}),
                ...(pendingRequestObservedAt !== undefined
                    ? { pendingRequestObservedAt }
                    : {}),
            };
        });
    } catch {
        return { ok: false, error: "internal" };
    }
}

export type ApplySessionTurnMutationNoOpReason =
    | "duplicate-mutation"
    | "terminal-turn"
    | "stale-in-progress"
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
    agentId: string | null;
    agentTurnId: string | null;
    status: string;
    startedAt: bigint | number;
    updatedAt: bigint | number;
    terminalAt: bigint | number | null;
    lastRuntimeIssueJson: string | null;
    transcriptAnchorsJson: string | null;
    rollbackState: string | null;
    rollbackReason: string | null;
    agentRollbackOrdinal: number | null;
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
    return parseStoredSessionTurnTranscriptAnchors(value) as Record<string, unknown> | undefined ?? {};
}

function readFiniteNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : undefined;
}

function isTrustedAnchorSeq(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

function hasTrustedRollbackAnchorsJson(value: string | null | undefined): boolean {
    const anchors = parseTranscriptAnchorsJson(value);
    return isTrustedAnchorSeq(anchors.startUserMessageSeq)
        && (
            isTrustedAnchorSeq(anchors.endSeqInclusive)
            || anchors.providerCheckpoint !== undefined
        );
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
    return mutation.action === "fail" ? sanitizeSessionRuntimeIssueV1(mutation.issue) : null;
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
        "agentTurnId" in mutation ? mutation.agentTurnId : undefined,
    );
    if (!mutationProviderTurnId) return false;

    const issue = sessionTurnRowRuntimeIssue(turn);
    const agentTurnIds = new Set(
        [turn.agentTurnId, issue?.agentTurnId]
            .map(normalizeRecoveryContextPart)
            .filter((value): value is string => value !== null),
    );
    if (!agentTurnIds.has(mutationProviderTurnId)) return false;

    const agentIds = new Set(
        [turn.agentId, issue?.agentId]
            .map(normalizeRecoveryContextPart)
            .filter((value): value is string => value !== null),
    );
    const mutationAgentId = normalizeRecoveryContextPart(mutation.agentId);
    return agentIds.size === 0 || (mutationAgentId !== null && agentIds.has(mutationAgentId));
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
    if (reason === "stale-in-progress") return "stale-in-progress";
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

function parseSessionTurnMutationAction(value: unknown): SessionTurnMutationActionV1 | null {
    const parsed = SessionTurnMutationActionV1Schema.safeParse(value);
    return parsed.success ? parsed.data : null;
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
    const action = parseSessionTurnMutationAction(params.row.action) ?? params.mutation.action;
    return {
        v: 1,
        sessionId: typeof params.row.sessionId === "string" ? params.row.sessionId : params.mutation.sessionId,
        mutationId: typeof params.row.mutationId === "string" ? params.row.mutationId : params.mutation.mutationId,
        ...(turnId ? { turnId } : {}),
        action,
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

/**
 * Repair the denormalized session turn projection from its canonical SessionTurn row.
 *
 * The client heartbeat is only a reconciliation signal: its status/timestamp must exactly match
 * the latest durable turn row. Client input never becomes a second turn-state authority.
 */
export async function reassertSessionLatestTurnStatus(params: {
    actorUserId: string;
    sessionId: string;
    latestTurnStatus: unknown;
    latestTurnStatusObservedAt: unknown;
}): Promise<ReassertSessionLatestTurnStatusResult> {
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const status = PrimaryTurnStatusV1Schema.safeParse(params.latestTurnStatus);
    const observedAt = normalizeNonNegativeTimestampMillis(params.latestTurnStatusObservedAt);
    if (!actorUserId || !sessionId || !status.success || observedAt === null) {
        return { ok: false, error: "invalid-params" };
    }

    try {
        return await inTx(async (tx) => {
            const access = await ensureSessionEditAccess(tx, { actorUserId, sessionId });
            if (!access.ok) return { ok: false, error: access.error };

            const session = await tx.session.findUnique({
                where: { id: sessionId },
                select: {
                    ...selectSessionActivityBadgeInputs(),
                    latestTurnId: true,
                    latestTurnStatusObservedAt: true,
                },
            });
            if (!session) return { ok: false, error: "session-not-found" };

            const currentState = materializedSessionTurnState(session);
            const noChange = (): Extract<ReassertSessionLatestTurnStatusResult, { ok: true }> => ({
                ok: true,
                didApply: false,
                ...currentState,
                participantCursors: [],
                badgeAttentionChanged: false,
            });
            if (
                currentState.latestTurnStatusObservedAt !== null
                && currentState.latestTurnStatusObservedAt >= observedAt
            ) {
                return noChange();
            }
            if (!currentState.latestTurnId) return noChange();

            const turn = await tx.sessionTurn.findUnique({
                where: { sessionId_turnId: { sessionId, turnId: currentState.latestTurnId } },
                select: {
                    turnId: true,
                    status: true,
                    updatedAt: true,
                    lastRuntimeIssueJson: true,
                },
            });
            const canonicalStatus = parseStoredPrimaryTurnStatus(turn?.status);
            const canonicalObservedAt = toObservedAtNumber(turn?.updatedAt);
            if (
                !turn
                || canonicalStatus !== status.data
                || canonicalObservedAt !== observedAt
            ) {
                return noChange();
            }

            const lastRuntimeIssue = parseStoredRuntimeIssue(turn.lastRuntimeIssueJson);
            const nextActivityInputs = {
                ...toSessionActivityBadgeInputs(session),
                latestTurnStatus: canonicalStatus,
                lastRuntimeIssue: turn.lastRuntimeIssueJson ?? null,
            };
            await tx.session.update({
                where: { id: sessionId },
                data: {
                    latestTurnStatus: canonicalStatus,
                    latestTurnStatusObservedAt: toObservedAtBigInt(observedAt),
                    lastRuntimeIssue: turn.lastRuntimeIssueJson ?? null,
                    ...buildLegacyThinkingProjectionWriteData({
                        latestTurnStatus: canonicalStatus,
                        latestTurnStatusObservedAt: observedAt,
                    }),
                },
            });
            const participantCursors = await markSessionParticipantsChanged({
                tx,
                sessionId,
                participantUserIds: access.participantUserIds,
            });
            return {
                ok: true,
                didApply: true,
                latestTurnId: turn.turnId,
                latestTurnStatus: canonicalStatus,
                latestTurnStatusObservedAt: observedAt,
                lastRuntimeIssue,
                participantCursors,
                badgeAttentionChanged: didSessionActivityBadgeContributionChange(
                    toSessionActivityBadgeInputs(session),
                    nextActivityInputs,
                ),
            };
        });
    } catch {
        return { ok: false, error: "internal" };
    }
}

async function applySessionTurnMutationWithOwnerAccessInTx(params: {
    tx: Tx;
    actorUserId: string;
    turnMutation: SessionTurnMutationV1;
    markParticipants: boolean;
}): Promise<ApplySessionTurnMutationResult> {
    const tx = params.tx;
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
            const isExactCurrentDaemonEnd = params.turnMutation.action === "end_session"
                && requestedTurnId === targetTurnId
                && session.latestTurnId === targetTurnId;
            const receipt = await updateSessionTurnMutationReceipt(
                tx,
                params.turnMutation,
                isExactCurrentDaemonEnd ? "duplicate-terminal" : mapSessionTurnNoOpReasonToDecision(reason),
                targetTurnId,
            );
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

        if (params.turnMutation.action === "touch_active" && session.latestTurnId && targetTurnId !== session.latestTurnId) {
            const reason = "terminal-turn";
            const receipt = await updateSessionTurnMutationReceipt(tx, params.turnMutation, mapSessionTurnNoOpReasonToDecision(reason), targetTurnId);
            return createSessionTurnNoOpResult({
                reason,
                state: materializedSessionTurnState(session),
                receipt,
            });
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
        if (params.turnMutation.action === "touch_active" && currentTurn && observedAt <= currentTurn.updatedAt) {
            const reason = "stale-in-progress";
            const receipt = await updateSessionTurnMutationReceipt(tx, params.turnMutation, mapSessionTurnNoOpReasonToDecision(reason), targetTurnId);
            return createSessionTurnNoOpResult({
                reason,
                state: materializedSessionTurnState(session),
                receipt,
            });
        }
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
                        agentId: params.turnMutation.agentId ?? null,
                        agentTurnId: "agentTurnId" in params.turnMutation ? params.turnMutation.agentTurnId ?? null : null,
                        status: "in_progress",
                        startedAt: observedAt,
                        updatedAt: observedAt,
                        terminalAt: null,
                        lastRuntimeIssueJson: null,
                        transcriptAnchorsJson: transcriptAnchorsJson ?? null,
                        rollbackState: null,
                        rollbackReason: null,
                        agentRollbackOrdinal: null,
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
                    agentId: params.turnMutation.agentId ?? currentTurn.agentId,
                    ...("agentTurnId" in params.turnMutation && params.turnMutation.agentTurnId
                        ? { agentTurnId: params.turnMutation.agentTurnId }
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
                            agentRollbackOrdinal: params.turnMutation.agentRollbackOrdinal ?? currentTurn.agentRollbackOrdinal,
                            rollbackUpdatedAt: observedAt,
                        }
                        : {}),
                    ...(params.turnMutation.action === "mark_rolled_back"
                        ? {
                            rollbackState: "rolled_back",
                            agentRollbackOrdinal: params.turnMutation.agentRollbackOrdinal ?? currentTurn.agentRollbackOrdinal,
                            rollbackUpdatedAt: observedAt,
                        }
                        : {}),
                    lastMutationId: params.turnMutation.mutationId,
                },
            }) as SessionTurnApplicationRow;
        }

        const nextLatestTurnId = params.turnMutation.action === "begin" ? targetTurnId : session.latestTurnId ?? targetTurnId;
        const shouldMaterialize = nextLatestTurnId === targetTurnId
            && (params.turnMutation.action === "begin" || params.turnMutation.action === "touch_active" || terminalStatus !== null);
        const terminalPendingRequestProjection = terminalStatus !== null
            ? {
                pendingPermissionRequestCount: 0,
                pendingUserActionRequestCount: 0,
                pendingRequestObservedAt: null,
            }
            : {};
        const nextActivityInputs = {
            ...toSessionActivityBadgeInputs(session),
            ...(shouldMaterialize ? { latestTurnStatus: appliedTurn.status } : {}),
            ...(shouldMaterialize ? { lastRuntimeIssue: appliedTurn.lastRuntimeIssueJson ?? null } : {}),
            ...(shouldMaterialize ? terminalPendingRequestProjection : {}),
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
                    ...terminalPendingRequestProjection,
                },
            });
        }

        const receipt = await updateSessionTurnMutationReceipt(tx, params.turnMutation, "applied", targetTurnId);

        const participantCursors = shouldMaterialize && params.markParticipants
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
}

async function applySessionTurnMutationWithOwnerAccess(params: {
    actorUserId: string;
    turnMutation: SessionTurnMutationV1;
}): Promise<ApplySessionTurnMutationResult> {
    return await inTx(async (tx) => await applySessionTurnMutationWithOwnerAccessInTx({
        tx,
        ...params,
        markParticipants: true,
    }));
}

export async function applyLatestSessionTurnEndInTx(params: Readonly<{
    tx: Tx;
    actorUserId: string;
    sessionId: string;
    mutationId: string;
    observedAt: number;
}>): Promise<ApplySessionTurnMutationResult | null> {
    const session = await params.tx.session.findUnique({
        where: { id: params.sessionId },
        select: { latestTurnId: true },
    });
    if (!session?.latestTurnId) return null;

    return await applySessionTurnMutationWithOwnerAccessInTx({
        tx: params.tx,
        actorUserId: params.actorUserId,
        turnMutation: ExactSessionTurnEndMutationV1Schema.parse({
            v: 1,
            sessionId: params.sessionId,
            mutationId: params.mutationId,
            action: "end_session",
            turnId: session.latestTurnId,
            observedAt: params.observedAt,
        }),
        markParticipants: false,
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
            const publicationProjection = applySessionTranscriptPublicationCeilingToProjection({
                seq: session.seq,
                lastViewedSessionSeq: session.lastViewedSessionSeq,
                latestReadyEventSeq: session.latestReadyEventSeq,
            }, session);

            const readableSessionSeq = operation.kind === "mark-unread" && session.lastViewedSessionSeq !== null
                ? await resolveManualUnreadReadableSessionSeq(tx, sessionId, session)
                : undefined;
            const resolved = resolveSessionReadCursorOperation({
                sessionSeq: publicationProjection.seq,
                readableSessionSeq,
                currentLastViewedSessionSeq: publicationProjection.lastViewedSessionSeq,
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
                    sessionSeq: publicationProjection.seq,
                    readableSessionSeq,
                    currentLastViewedSessionSeq:
                        fresh?.lastViewedSessionSeq === null || fresh?.lastViewedSessionSeq === undefined
                            ? fresh?.lastViewedSessionSeq
                            : Math.min(fresh.lastViewedSessionSeq, publicationProjection.seq),
                    operation,
                });
                const visibleFreshLastViewedSessionSeq =
                    fresh?.lastViewedSessionSeq === null || fresh?.lastViewedSessionSeq === undefined
                        ? fresh?.lastViewedSessionSeq ?? null
                        : Math.min(fresh.lastViewedSessionSeq, publicationProjection.seq);
                return {
                    ok: true,
                    lastViewedSessionSeq: visibleFreshLastViewedSessionSeq,
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
            const visibleBadgeInputs = toSessionActivityBadgeInputs({
                ...session,
                seq: publicationProjection.seq,
                lastViewedSessionSeq: publicationProjection.lastViewedSessionSeq,
            });
            return {
                ok: true,
                lastViewedSessionSeq: nextCursor,
                participantCursors,
                badgeAttentionChanged: didSessionActivityBadgeContributionChange(
                    visibleBadgeInputs,
                    {
                        ...visibleBadgeInputs,
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
        error: "invalid-params" | "forbidden" | "session-not-found" | "session_active" | "version-mismatch" | "metadata_privacy_upgrade_required" | "internal";
        current?: {
            metadata?: { version: number; value: string | null };
            agentState?: { version: number; value: string | null };
        };
      };

function isExactInactiveModelIntentExpectation(
    value: unknown,
): value is SessionMetadataInactiveModelIntentExpectationV1 {
    return typeof value === "object"
        && value !== null
        && !Array.isArray(value)
        && Object.keys(value).length === 1
        && (value as { kind?: unknown }).kind === "inactive_model_intent";
}

export async function patchSession(params: {
    actorUserId: string;
    sessionId: string;
    metadata?: { ciphertext: string; expectedVersion: number };
    agentState?: { ciphertext: string | null; expectedVersion: number };
    sessionExpectation?: SessionMetadataInactiveModelIntentExpectationV1;
}): Promise<PatchSessionResult> {
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const metadata = params.metadata;
    const agentState = params.agentState;
    const sessionExpectation = params.sessionExpectation;

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
    if (
        sessionExpectation !== undefined
        && (
            !metadata
            || !isExactInactiveModelIntentExpectation(sessionExpectation)
        )
    ) {
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
                    active: true,
                    metadataLayoutVersion: true,
                    ownerMetadata: true,
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
            if (sessionExpectation && current.active) {
                return { ok: false, error: "session_active" };
            }
            if (
                (current.metadataLayoutVersion ?? 0) !== 0
                || current.ownerMetadata !== null
            ) {
                return { ok: false, error: "metadata_privacy_upgrade_required" };
            }

            const mismatchMetadata =
                metadata && current.metadataVersion !== metadata.expectedVersion;
            const mismatchAgentState =
                agentState && current.agentStateVersion !== agentState.expectedVersion;
            if (mismatchMetadata || mismatchAgentState) {
                return {
                    ok: false,
                    error: "version-mismatch",
                    current: {
                        ...(metadata
                            ? {
                                metadata: {
                                    version: current.metadataVersion,
                                    value: current.metadata,
                                },
                            }
                            : {}),
                        ...(agentState
                            ? {
                                agentState: {
                                    version: current.agentStateVersion,
                                    value: current.agentState,
                                },
                            }
                            : {}),
                    },
                };
            }

            const metadataChanged = metadata
                ? !isSessionMetadataNoOp({
                    currentMetadata: current.metadata,
                    nextMetadata: metadata.ciphertext,
                    encryptionMode: current.encryptionMode,
                })
                : false;
            const agentStateChanged = agentState
                ? current.agentState !== agentState.ciphertext
                : false;
            if (!metadataChanged && !agentStateChanged) {
                return {
                    ok: true,
                    participantCursors: [],
                    ...(metadata
                        ? {
                            metadata: {
                                version: current.metadataVersion,
                                value: current.metadata,
                            },
                        }
                        : {}),
                    ...(agentState
                        ? {
                            agentState: {
                                version: current.agentStateVersion,
                                value: current.agentState,
                            },
                        }
                        : {}),
                };
            }

            const updateData = {
                ...(metadataChanged && metadata
                    ? {
                        metadata: metadata.ciphertext,
                        metadataVersion: metadata.expectedVersion + 1,
                    }
                    : {}),
                ...(agentStateChanged && agentState
                    ? {
                        agentState: agentState.ciphertext,
                        agentStateVersion: agentState.expectedVersion + 1,
                    }
                    : {}),
            };
            const { count } = await tx.session.updateMany({
                where: {
                    id: sessionId,
                    ...(sessionExpectation ? { active: false } : {}),
                    ...(metadata
                        ? { metadataVersion: metadata.expectedVersion }
                        : {}),
                    ...(agentState
                        ? { agentStateVersion: agentState.expectedVersion }
                        : {}),
                    metadataLayoutVersion: 0,
                    ownerMetadata: null,
                },
                data: updateData,
            });
            if (count === 0) {
                const fresh = await tx.session.findUnique({
                    where: { id: sessionId },
                    select: {
                        active: true,
                        metadataLayoutVersion: true,
                        ownerMetadata: true,
                        metadataVersion: true,
                        metadata: true,
                        agentStateVersion: true,
                        agentState: true,
                    },
                });
                if (!fresh) {
                    return { ok: false, error: "session-not-found" };
                }
                if (sessionExpectation && fresh.active) {
                    return { ok: false, error: "session_active" };
                }
                if (
                    (fresh.metadataLayoutVersion ?? 0) !== 0
                    || fresh.ownerMetadata !== null
                ) {
                    return {
                        ok: false,
                        error: "metadata_privacy_upgrade_required",
                    };
                }
                return {
                    ok: false,
                    error: "version-mismatch",
                    current: {
                        ...(metadata
                            ? {
                                metadata: {
                                    version: fresh.metadataVersion,
                                    value: fresh.metadata,
                                },
                            }
                            : {}),
                        ...(agentState
                            ? {
                                agentState: {
                                    version: fresh.agentStateVersion,
                                    value: fresh.agentState,
                                },
                            }
                            : {}),
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
                ...(metadata
                    ? {
                        metadata: {
                            version: metadataChanged
                                ? metadata.expectedVersion + 1
                                : current.metadataVersion,
                            value: metadataChanged
                                ? metadata.ciphertext
                                : current.metadata,
                        },
                    }
                    : {}),
                ...(agentState
                    ? {
                        agentState: {
                            version: agentStateChanged
                                ? agentState.expectedVersion + 1
                                : current.agentStateVersion,
                            value: agentStateChanged
                                ? agentState.ciphertext
                                : current.agentState,
                        },
                    }
                    : {}),
            };
        });
    } catch {
        return { ok: false, error: "internal" };
    }
}

export type UpdateSessionMetadataEnvelopeTupleInput =
    | (SessionMetadataOwnerMigrationPatchV1 & Readonly<{
        actorUserId: string;
        sessionId: string;
      }>)
    | Readonly<{
        mode: "owner";
        actorUserId: string;
        sessionId: string;
        metadataLayoutVersion: typeof SESSION_METADATA_LAYOUT_VERSION_V1;
        expectedOwnerMetadataCiphertext: string;
        sharedMetadata: Readonly<{ ciphertext: string; expectedVersion: number }>;
        ownerMetadata: Readonly<{ ciphertext: string }>;
        agentState: Readonly<{ ciphertext: string | null; expectedVersion: number }>;
      }>
    | Readonly<{
        mode: "owner_inactive_model_intent";
        actorUserId: string;
        sessionId: string;
        metadataLayoutVersion: typeof SESSION_METADATA_LAYOUT_VERSION_V1;
        sessionExpectation:
            SessionMetadataInactiveModelIntentExpectationV1;
        expectedOwnerMetadataCiphertext: string;
        sharedMetadata: Readonly<{ ciphertext: string; expectedVersion: number }>;
        ownerMetadata: Readonly<{ ciphertext: string }>;
        agentState: Readonly<{ ciphertext: string | null; expectedVersion: number }>;
      }>
    | Readonly<{
        mode: "shared_editor";
        actorUserId: string;
        sessionId: string;
        metadataLayoutVersion: typeof SESSION_METADATA_LAYOUT_VERSION_V1;
        sharedMetadata: Readonly<{ ciphertext: string; expectedVersion: number }>;
      }>;

export type UpdateSessionMetadataEnvelopeTupleResult =
    | Readonly<{
        ok: true;
        participantCursors: ParticipantCursor[];
        metadataLayoutVersion: typeof SESSION_METADATA_LAYOUT_VERSION_V1;
        sharedMetadata: Readonly<{ version: number; value: string }>;
        agentStateVersion: number;
        ownerMetadata?: Readonly<{ value: string }>;
        agentState?: Readonly<{ version: number; value: string | null }>;
      }>
    | Readonly<{
        ok: false;
        error:
            | "invalid-params"
            | "forbidden"
            | "session-not-found"
            | "session_active"
            | "version-mismatch"
            | "metadata_privacy_upgrade_required"
            | "internal";
        current?: Readonly<{
            metadataLayoutVersion: number;
            sharedMetadata: Readonly<{ version: number; value: string }>;
            ownerMetadata?: Readonly<{ value: string }>;
            agentState?: Readonly<{ version: number; value: string | null }>;
        }>;
      }>;

type ActiveSessionMetadataEnvelopeTupleInput = Exclude<
    UpdateSessionMetadataEnvelopeTupleInput,
    Readonly<{ mode: "owner_migration" }>
>;

type StoredSessionMetadataEnvelopeTuple = Readonly<{
    active: boolean;
    metadataLayoutVersion: number;
    metadataVersion: number;
    metadata: string;
    ownerMetadata: string | null;
    agentStateVersion: number;
    agentState: string | null;
}>;

function isNonNegativeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isExactMetadataEnvelopeTupleRetry(
    current: StoredSessionMetadataEnvelopeTuple,
    params: ActiveSessionMetadataEnvelopeTupleInput,
): boolean {
    if (
        current.metadataLayoutVersion !== SESSION_METADATA_LAYOUT_VERSION_V1
        || current.metadataVersion !== params.sharedMetadata.expectedVersion + 1
        || current.metadata !== params.sharedMetadata.ciphertext
    ) {
        return false;
    }
    if (params.mode === "shared_editor") return true;
    return current.ownerMetadata === params.ownerMetadata.ciphertext
        && current.agentStateVersion === params.agentState.expectedVersion + 1
        && current.agentState === params.agentState.ciphertext;
}

function toMetadataEnvelopeTupleSuccess(
    current: StoredSessionMetadataEnvelopeTuple,
    params: ActiveSessionMetadataEnvelopeTupleInput,
    participantCursors: ParticipantCursor[],
): UpdateSessionMetadataEnvelopeTupleResult {
    return {
        ok: true,
        participantCursors,
        metadataLayoutVersion: SESSION_METADATA_LAYOUT_VERSION_V1,
        sharedMetadata: {
            version: current.metadataVersion,
            value: current.metadata,
        },
        agentStateVersion: current.agentStateVersion,
        ...(params.mode !== "shared_editor"
            ? {
                ownerMetadata: { value: current.ownerMetadata! },
                agentState: {
                    version: current.agentStateVersion,
                    value: current.agentState,
                },
            }
            : {}),
    };
}

function toMetadataEnvelopeTupleVersionMismatch(
    current: StoredSessionMetadataEnvelopeTuple,
    params: ActiveSessionMetadataEnvelopeTupleInput,
): UpdateSessionMetadataEnvelopeTupleResult {
    return {
        ok: false,
        error: "version-mismatch",
        current: {
            metadataLayoutVersion: current.metadataLayoutVersion,
            sharedMetadata: {
                version: current.metadataVersion,
                value: current.metadata,
            },
            ...(params.mode !== "shared_editor"
                ? {
                    ...(typeof current.ownerMetadata === "string"
                        ? { ownerMetadata: { value: current.ownerMetadata } }
                        : {}),
                    agentState: {
                        version: current.agentStateVersion,
                        value: current.agentState,
                    },
                }
                : {}),
        },
    };
}

function isValidSessionMetadataEnvelopeTupleInput(
    params: UpdateSessionMetadataEnvelopeTupleInput,
): boolean {
    const hasSessionExpectation = Object.prototype.hasOwnProperty.call(
        params,
        "sessionExpectation",
    );
    const sessionExpectation = hasSessionExpectation
        && "sessionExpectation" in params
        ? params.sessionExpectation
        : undefined;
    if (
        params.mode === "owner_inactive_model_intent"
            ? (
                !hasSessionExpectation
                || !isExactInactiveModelIntentExpectation(sessionExpectation)
            )
            : hasSessionExpectation
    ) {
        return false;
    }
    if (params.mode === "owner_migration") {
        return (
            typeof params.actorUserId === "string"
            && params.actorUserId.length > 0
            && typeof params.sessionId === "string"
            && params.sessionId.length > 0
            && (
                params.expectedAccountEncryptionMode === "plain"
                || params.expectedAccountEncryptionMode === "e2ee"
            )
            && /^content-public-key-sha256:[0-9a-f]{64}$/u.test(
                params.expectedAccountContentPublicKeyFingerprint,
            )
            && params.source.metadataLayoutVersion === 0
            && typeof params.source.metadata.ciphertext === "string"
            && params.source.metadata.ciphertext.length > 0
            && isNonNegativeInteger(params.source.metadata.version)
            && params.source.metadata.version < Number.MAX_SAFE_INTEGER
            && params.source.ownerMetadata === null
            && (
                typeof params.source.agentState.ciphertext === "string"
                || params.source.agentState.ciphertext === null
            )
            && isNonNegativeInteger(params.source.agentState.version)
            && params.source.agentState.version < Number.MAX_SAFE_INTEGER
            && params.target.metadataLayoutVersion
                === SESSION_METADATA_LAYOUT_VERSION_V1
            && typeof params.target.sharedMetadata.ciphertext === "string"
            && params.target.sharedMetadata.ciphertext.length > 0
            && isSessionOwnerMetadataCiphertextV1(
                params.target.ownerMetadata.ciphertext,
            )
            && (
                typeof params.target.agentState.ciphertext === "string"
                || params.target.agentState.ciphertext === null
            )
        );
    }
    return (
        (
            params.mode === "owner"
            || params.mode === "owner_inactive_model_intent"
            || params.mode === "shared_editor"
        )
        && typeof params.actorUserId === "string"
        && params.actorUserId.length > 0
        && typeof params.sessionId === "string"
        && params.sessionId.length > 0
        && params.metadataLayoutVersion === SESSION_METADATA_LAYOUT_VERSION_V1
        && typeof params.sharedMetadata?.ciphertext === "string"
        && params.sharedMetadata.ciphertext.length > 0
        && isNonNegativeInteger(params.sharedMetadata.expectedVersion)
        && (
            params.mode === "shared_editor"
            || (
                typeof params.expectedOwnerMetadataCiphertext === "string"
                && isSessionOwnerMetadataCiphertextV1(
                    params.expectedOwnerMetadataCiphertext,
                )
                && typeof params.ownerMetadata?.ciphertext === "string"
                && isSessionOwnerMetadataCiphertextV1(params.ownerMetadata.ciphertext)
                && (
                    typeof params.agentState?.ciphertext === "string"
                    || params.agentState?.ciphertext === null
                )
                && isNonNegativeInteger(params.agentState?.expectedVersion)
            )
        )
    );
}

/**
 * Canonical Session-row/CAS owner for the CPX-R26 safe/private envelope tuple.
 * The owner-migration wire remains strict while layout-one activation is
 * frozen. Ordinary owner and shared-editor writes remain closed until layout
 * v1 exists. Shared editors cannot observe or mutate owner metadata or full
 * Agent state.
 */
export async function updateSessionMetadataEnvelopeTupleInTx(
    tx: Tx,
    params: UpdateSessionMetadataEnvelopeTupleInput,
): Promise<UpdateSessionMetadataEnvelopeTupleResult> {
    if (!isValidSessionMetadataEnvelopeTupleInput(params)) {
        return { ok: false, error: "invalid-params" };
    }

    if (params.mode === "owner_migration") {
        return {
            ok: false,
            error: "metadata_privacy_upgrade_required",
        };
    }

    if (params.mode !== "shared_editor") {
        await acquireAccountSessionOwnerMetadataFenceInTx(
            tx,
            params.actorUserId,
        );
    }

    const access = params.mode !== "shared_editor"
        ? await ensureSessionOwnerAccess(tx, params)
        : await ensureSessionEditAccess(tx, params);
    if (!access.ok) return { ok: false, error: access.error };

    const current = await tx.session.findUnique({
        where: { id: params.sessionId },
        select: {
            active: true,
            metadataLayoutVersion: true,
            metadataVersion: true,
            metadata: true,
            ownerMetadata: true,
            agentStateVersion: true,
            agentState: true,
        },
    });
    if (!current) return { ok: false, error: "session-not-found" };

    const requiresInactiveSession =
        params.mode === "owner_inactive_model_intent";
    if (
        current.metadataLayoutVersion
        !== SESSION_METADATA_LAYOUT_VERSION_V1
    ) {
        return {
            ok: false,
            error: "metadata_privacy_upgrade_required",
        };
    }
    if (isExactMetadataEnvelopeTupleRetry(current, params)) {
        return toMetadataEnvelopeTupleSuccess(current, params, []);
    }
    if (requiresInactiveSession && current.active) {
        return { ok: false, error: "session_active" };
    }
    if (
        current.metadataVersion !== params.sharedMetadata.expectedVersion
        || (
            params.mode !== "shared_editor"
            && (
                current.ownerMetadata
                    !== params.expectedOwnerMetadataCiphertext
                || current.agentStateVersion
                    !== params.agentState.expectedVersion
            )
        )
    ) {
        return toMetadataEnvelopeTupleVersionMismatch(current, params);
    }

    const nextMetadataVersion =
        params.sharedMetadata.expectedVersion + 1;
    const nextAgentStateVersion = params.mode !== "shared_editor"
        ? params.agentState.expectedVersion + 1
        : current.agentStateVersion;
    const updateData = params.mode !== "shared_editor"
        ? {
            metadata: params.sharedMetadata.ciphertext,
            metadataVersion: nextMetadataVersion,
            ownerMetadata: params.ownerMetadata.ciphertext,
            metadataLayoutVersion: SESSION_METADATA_LAYOUT_VERSION_V1,
            agentState: params.agentState.ciphertext,
            agentStateVersion: nextAgentStateVersion,
        }
        : {
            metadata: params.sharedMetadata.ciphertext,
            metadataVersion: nextMetadataVersion,
        };
    const { count } = await tx.session.updateMany({
        where: {
            id: params.sessionId,
            ...(requiresInactiveSession ? { active: false } : {}),
            metadataLayoutVersion: current.metadataLayoutVersion,
            metadataVersion: params.sharedMetadata.expectedVersion,
            ...(params.mode !== "shared_editor"
                ? {
                    ownerMetadata:
                        params.expectedOwnerMetadataCiphertext,
                    agentStateVersion: params.agentState.expectedVersion,
                }
                : {
                    OR: [
                        { accountId: params.actorUserId },
                        {
                            shares: {
                                some: {
                                    sharedWithUserId: params.actorUserId,
                                    accessLevel: { in: ["edit", "admin"] },
                                },
                            },
                        },
                    ],
                }),
        },
        data: updateData,
    });

    const nextTuple: StoredSessionMetadataEnvelopeTuple = {
        active: current.active,
        metadataLayoutVersion: SESSION_METADATA_LAYOUT_VERSION_V1,
        metadataVersion: nextMetadataVersion,
        metadata: params.sharedMetadata.ciphertext,
        ownerMetadata: params.mode !== "shared_editor"
            ? params.ownerMetadata.ciphertext
            : current.ownerMetadata,
        agentStateVersion: nextAgentStateVersion,
        agentState: params.mode !== "shared_editor"
            ? params.agentState.ciphertext
            : current.agentState,
    };
    if (count === 0) {
        const fresh = await tx.session.findUnique({
            where: { id: params.sessionId },
            select: {
                active: true,
                metadataLayoutVersion: true,
                metadataVersion: true,
                metadata: true,
                ownerMetadata: true,
                agentStateVersion: true,
                agentState: true,
            },
        });
        if (!fresh) return { ok: false, error: "session-not-found" };
        if (
            fresh.metadataLayoutVersion
            !== SESSION_METADATA_LAYOUT_VERSION_V1
        ) {
            return {
                ok: false,
                error: "metadata_privacy_upgrade_required",
            };
        }
        if (isExactMetadataEnvelopeTupleRetry(fresh, params)) {
            return toMetadataEnvelopeTupleSuccess(fresh, params, []);
        }
        if (requiresInactiveSession && fresh.active) {
            return { ok: false, error: "session_active" };
        }
        if (params.mode === "shared_editor") {
            const freshAccess = await ensureSessionEditAccess(tx, params);
            if (!freshAccess.ok) {
                return { ok: false, error: freshAccess.error };
            }
        }
        return toMetadataEnvelopeTupleVersionMismatch(fresh, params);
    }

    const participantCursors = await markSessionParticipantsChanged({
        tx,
        sessionId: params.sessionId,
        participantUserIds: access.participantUserIds,
    });
    return toMetadataEnvelopeTupleSuccess(
        nextTuple,
        params,
        participantCursors,
    );
}

export async function updateSessionMetadataEnvelopeTuple(
    params: UpdateSessionMetadataEnvelopeTupleInput,
): Promise<UpdateSessionMetadataEnvelopeTupleResult> {
    try {
        return await inTx(async (tx) =>
            updateSessionMetadataEnvelopeTupleInTx(tx, params));
    } catch {
        return { ok: false, error: "internal" };
    }
}
