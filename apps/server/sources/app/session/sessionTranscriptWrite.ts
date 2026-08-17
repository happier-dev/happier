import {
    isSessionAgentTransitionDividerLocalId,
    isStoredContentKindAllowedForSessionByStoragePolicy,
    isMessageStructuredPresentationV1Candidate,
    readMessageStructuredPresentationV1,
    SessionMessageRoleSchema,
    type SessionEncryptionMode,
    type SessionInputAdmissionReceiptV1,
    type SessionInputRequestEqualityEvidenceV1,
    type SessionMessageDeliveryResolutionV1,
    type SessionMessageRole,
    type SessionTranscriptObservationProvenanceV1,
} from "@happier-dev/protocol";
import { isDeepStrictEqual } from "node:util";

import { resolveEncryptionWriteRejectionCode, type EncryptionPolicyRejectionCode } from "@/app/session/encryptionRejectionCodes";
import { inTx, type Tx } from "@/storage/inTx";
import { isPrismaErrorCode } from "@/storage/prisma";

export const SESSION_TRANSCRIPT_WRITE_SELECT = {
    id: true,
    sessionId: true,
    seq: true,
    localId: true,
    sidechainId: true,
    messageRole: true,
    content: true,
    sourceCreatedAt: true,
    sourceUpdatedAt: true,
    transcriptObservationProvenance: true,
    deliveryResolution: true,
    createdAt: true,
    updatedAt: true,
} as const;

export type SessionTranscriptStoragePolicy = "required_e2ee" | "optional" | "plaintext_only";
export type SessionTranscriptWriteAuthority = "hosted" | "historical_import";
export type SessionTranscriptWriteRejectionCode =
    | EncryptionPolicyRejectionCode
    | "session_storage_authority_mismatch"
    | "session_message_role_conflict"
    | "session_structured_presentation_invalid"
    | "session_structured_presentation_unavailable";

/**
 * Canonical provenance for history observations. Historical-import adapters
 * must preserve it so the batch writer's stable identity remains closed.
 */
export const HISTORICAL_IMPORT_TRANSCRIPT_OBSERVATION_PROVENANCE = {
    kind: "non_dependent",
    source: "history",
} as const satisfies SessionTranscriptObservationProvenanceV1;

/**
 * One canonical comparison for a stored Session Message and an incoming
 * same-localId candidate. Callers own whether a content correction is an
 * update or a conflict; role identity itself is settled here.
 */
export type SessionMessageContentRoleComparison =
    | Readonly<{
        kind: "content-mismatch";
        existingMessageRole: SessionMessageRole | null;
      }>
    | Readonly<{
        kind: "role-conflict";
        existingMessageRole: SessionMessageRole;
      }>
    | Readonly<{
        kind: "match";
        existingMessageRole: SessionMessageRole | null;
        backfillsRole: boolean;
      }>;

export function compareSessionMessageContentAndRole(params: Readonly<{
    existing: Readonly<{
        content: unknown;
        messageRole: unknown;
    }>;
    candidate: Readonly<{
        content: PrismaJson.SessionMessageContent;
        messageRole: SessionMessageRole | null;
    }>;
}>): SessionMessageContentRoleComparison {
    const parsedExistingRole = SessionMessageRoleSchema.safeParse(params.existing.messageRole);
    const existingMessageRole = parsedExistingRole.success ? parsedExistingRole.data : null;

    if (!isDeepStrictEqual(params.existing.content, params.candidate.content)) {
        return { kind: "content-mismatch", existingMessageRole };
    }
    if (
        existingMessageRole !== null
        && params.candidate.messageRole !== null
        && existingMessageRole !== params.candidate.messageRole
    ) {
        return { kind: "role-conflict", existingMessageRole };
    }
    return {
        kind: "match",
        existingMessageRole,
        // Preserve the established backfill contract: only an actual stored
        // null is backfilled, never an invalid legacy value treated as null.
        backfillsRole: params.existing.messageRole === null && params.candidate.messageRole !== null,
    };
}

export type SessionTranscriptStorageModeConflict = Readonly<{
    ok: false;
    error: "storage-mode-conflict";
    code: SessionTranscriptWriteRejectionCode;
}>;

function isSessionTranscriptWriteAuthorityAllowed(
    currentStorageState: string,
    writeAuthority: SessionTranscriptWriteAuthority,
): boolean {
    return writeAuthority === "hosted"
        ? currentStorageState === "hosted"
        : currentStorageState === "machine_only"
            || currentStorageState === "server_partial"
            || currentStorageState === "snapshot_complete";
}

export async function validateSessionTranscriptWriteAuthorityInTx(
    tx: Tx,
    params: Readonly<{
        sessionId: string;
        writeAuthority: SessionTranscriptWriteAuthority;
    }>,
): Promise<Readonly<{ ok: true }> | SessionTranscriptStorageModeConflict> {
    const session = await tx.session.findUnique({
        where: { id: params.sessionId },
        select: { currentStorageState: true },
    });
    if (session && isSessionTranscriptWriteAuthorityAllowed(
        session.currentStorageState,
        params.writeAuthority,
    )) {
        return { ok: true };
    }
    return {
        ok: false,
        error: "storage-mode-conflict",
        code: "session_storage_authority_mismatch",
    };
}

export function validateSessionTranscriptStoredContent(params: Readonly<{
    content: PrismaJson.SessionMessageContent;
    sessionEncryptionMode: SessionEncryptionMode;
    storagePolicy: SessionTranscriptStoragePolicy;
}>): Readonly<{ ok: true }> | SessionTranscriptStorageModeConflict {
    const writeKind = params.content.t === "plain" ? "plain" : "encrypted";
    if (!isStoredContentKindAllowedForSessionByStoragePolicy(
        params.storagePolicy,
        params.sessionEncryptionMode,
        writeKind,
    )) {
        return {
            ok: false,
            error: "storage-mode-conflict",
            code: resolveEncryptionWriteRejectionCode({
                storagePolicy: params.storagePolicy,
                sessionEncryptionMode: params.sessionEncryptionMode,
                writeKind,
            }),
        };
    }

    // The server cannot inspect E2EE ciphertext. For its readable plain
    // canonical Message envelope, reserve the structured-presentation member
    // until every reachable reader can replay it. This single writer
    // admission covers direct, Pending, and historical import paths without a
    // route-local compatibility branch.
    if (params.content.t === "plain" && isMessageStructuredPresentationV1Candidate(params.content.v)) {
        if (readMessageStructuredPresentationV1(params.content.v) !== null) {
            return {
                ok: false,
                error: "storage-mode-conflict",
                code: "session_structured_presentation_unavailable",
            };
        }
        return {
            ok: false,
            error: "storage-mode-conflict",
            code: "session_structured_presentation_invalid",
        };
    }

    return { ok: true };
}

export type SessionTranscriptMessageWriteParams = Readonly<{
    sessionId: string;
    writeAuthority: SessionTranscriptWriteAuthority;
    sessionEncryptionMode: SessionEncryptionMode;
    storagePolicy: SessionTranscriptStoragePolicy;
    content: PrismaJson.SessionMessageContent;
    localId: string | null;
    sidechainId: string | null;
    messageRole: SessionMessageRole | null;
    createdAt?: Date;
    meaningfulActivityAt?: Date;
    sourceCreatedAt?: Date;
    sourceUpdatedAt?: Date;
    transcriptObservationProvenance?: SessionTranscriptObservationProvenanceV1;
    deliveryResolution?: SessionMessageDeliveryResolutionV1;
    /** Only the Pending admission/settlement owner may supply immutable input evidence. */
    inputAdmissionReceipt?: SessionInputAdmissionReceiptV1;
    requestEqualityEvidenceV1?: SessionInputRequestEqualityEvidenceV1;
}>;

export type HistoricalSessionMessageItem = Readonly<{
    localId: string;
    sidechainId: string | null;
    messageRole: SessionMessageRole | null;
    content: PrismaJson.SessionMessageContent;
    sourceCreatedAt?: Date;
    sourceUpdatedAt?: Date;
    transcriptObservationProvenance?: SessionTranscriptObservationProvenanceV1;
}>;

/**
 * Canonical transaction-local transcript insert.
 *
 * This is the sole owner of storage-mode admission followed by session sequence allocation. The
 * caller owns command-specific dedupe and projections, and must already be inside `inTx` so a
 * failed row insert rolls the sequence increment back with it.
 */
export async function writeSessionTranscriptMessageInTx(
    tx: Tx,
    params: SessionTranscriptMessageWriteParams,
) {
    const storageAdmission = validateSessionTranscriptStoredContent(params);
    if (!storageAdmission.ok) return storageAdmission;

    const createdAt = params.createdAt ?? new Date();
    let next: { seq: number };
    try {
        next = await tx.session.update({
            where: {
                id: params.sessionId,
                currentStorageState: params.writeAuthority === "hosted"
                    ? "hosted"
                    : { in: ["machine_only", "server_partial", "snapshot_complete"] },
            },
            select: { seq: true },
            data: {
                seq: { increment: 1 },
                ...(params.meaningfulActivityAt ? { meaningfulActivityAt: params.meaningfulActivityAt } : {}),
            },
        });
    } catch (error) {
        if (!isPrismaErrorCode(error, "P2025")) throw error;
        return {
            ok: false as const,
            error: "storage-mode-conflict" as const,
            code: "session_storage_authority_mismatch" as const,
        };
    }
    const message = await tx.sessionMessage.create({
        data: {
            sessionId: params.sessionId,
            seq: next.seq,
            content: params.content,
            localId: params.localId,
            sidechainId: params.sidechainId,
            messageRole: params.messageRole,
            createdAt,
            ...(params.sourceCreatedAt ? { sourceCreatedAt: params.sourceCreatedAt } : {}),
            ...(params.sourceUpdatedAt ? { sourceUpdatedAt: params.sourceUpdatedAt } : {}),
            ...(params.transcriptObservationProvenance
                ? { transcriptObservationProvenance: params.transcriptObservationProvenance }
                : {}),
            ...(params.deliveryResolution ? { deliveryResolution: params.deliveryResolution } : {}),
            ...(params.inputAdmissionReceipt ? { inputAdmissionReceipt: params.inputAdmissionReceipt } : {}),
            ...(params.requestEqualityEvidenceV1
                ? { requestEqualityEvidenceV1: params.requestEqualityEvidenceV1 }
                : {}),
        },
        select: SESSION_TRANSCRIPT_WRITE_SELECT,
    });

    return { ok: true as const, message };
}

/** Historical import is deliberately only a command-specific name over the canonical writer. */
export async function writeHistoricalSessionMessageInTx(
    tx: Tx,
    params: Omit<SessionTranscriptMessageWriteParams, "writeAuthority">,
) {
    return await writeSessionTranscriptMessageInTx(tx, {
        ...params,
        writeAuthority: "historical_import",
    });
}

function historicalItemMatchesStoredMessage(
    item: HistoricalSessionMessageItem,
    stored: Readonly<{
        localId: string | null;
        sidechainId: string | null;
        messageRole: unknown;
        content: unknown;
        sourceCreatedAt: Date | null;
        sourceUpdatedAt: Date | null;
        transcriptObservationProvenance: unknown;
    }>,
): boolean {
    return stored.localId === item.localId
        && stored.sidechainId === item.sidechainId
        && stored.messageRole === item.messageRole
        && isDeepStrictEqual(stored.content, item.content)
        && stored.sourceCreatedAt?.getTime() === item.sourceCreatedAt?.getTime()
        && stored.sourceUpdatedAt?.getTime() === item.sourceUpdatedAt?.getTime()
        && isDeepStrictEqual(
            stored.transcriptObservationProvenance ?? undefined,
            item.transcriptObservationProvenance,
        );
}

/**
 * Canonical stable-history batch core. The caller declares the storage authority
 * it already owns; this batch has no publication, attention, Pending, ready, or
 * hosted-turn behavior of its own.
 */
async function writeHistoricalSessionMessageBatchWithModeInTx(
    tx: Tx,
    params: Readonly<{
        sessionId: string;
        writeAuthority: SessionTranscriptWriteAuthority;
        sessionEncryptionMode: SessionEncryptionMode;
        storagePolicy: SessionTranscriptStoragePolicy;
        items: readonly HistoricalSessionMessageItem[];
    }>,
) {
    const authority = await validateSessionTranscriptWriteAuthorityInTx(tx, {
        sessionId: params.sessionId,
        writeAuthority: params.writeAuthority,
    });
    if (!authority.ok) return authority;

    if (params.items.length === 0) {
        return { ok: true as const, didWrite: false, messages: [], firstSeq: null, lastSeq: null };
    }

    const itemByLocalId = new Map<string, HistoricalSessionMessageItem>();
    for (const item of params.items) {
        if (!item.localId) return { ok: false as const, error: "invalid-item" as const };
        // The Agent-transition divider local-ID namespace is reserved for the
        // owner-only transition service. It is refused HERE, at the canonical
        // historical-batch owner, rather than at any one of its adapters: the
        // hosted `/transcript/import` route authorizes ordinary edit/admin
        // collaborators, and the external-Session historical import command
        // reaches this same writer. A row planted at the reserved localId would
        // both forge a departure boundary and permanently block every future
        // cutover's divider append on that Session. The whole batch is refused,
        // because a partial write would still let the caller choose what lands.
        if (isSessionAgentTransitionDividerLocalId(item.localId)) {
            return { ok: false as const, error: "reserved-local-id" as const };
        }
        const storageAdmission = validateSessionTranscriptStoredContent({
            content: item.content,
            sessionEncryptionMode: params.sessionEncryptionMode,
            storagePolicy: params.storagePolicy,
        });
        if (!storageAdmission.ok) return storageAdmission;
        const prior = itemByLocalId.get(item.localId);
        if (prior && !isDeepStrictEqual(prior, item)) {
            return { ok: false as const, error: "stable-item-conflict" as const, localId: item.localId };
        }
        itemByLocalId.set(item.localId, item);
    }

    const orderedItems = [...itemByLocalId.values()];
    const existing = await tx.sessionMessage.findMany({
        where: { sessionId: params.sessionId, localId: { in: orderedItems.map((item) => item.localId) } },
        select: SESSION_TRANSCRIPT_WRITE_SELECT,
    });
    const existingByLocalId = new Map(
        existing.flatMap((message) => message.localId ? [[message.localId, message] as const] : []),
    );
    for (const item of orderedItems) {
        const stored = existingByLocalId.get(item.localId);
        if (stored && !historicalItemMatchesStoredMessage(item, stored)) {
            return { ok: false as const, error: "stable-item-conflict" as const, localId: item.localId };
        }
    }

    const messages = [];
    let didWrite = false;
    for (const item of orderedItems) {
        const stored = existingByLocalId.get(item.localId);
        if (stored) {
            messages.push(stored);
            continue;
        }
        const persisted = await writeSessionTranscriptMessageInTx(tx, {
            sessionId: params.sessionId,
            writeAuthority: params.writeAuthority,
            sessionEncryptionMode: params.sessionEncryptionMode,
            storagePolicy: params.storagePolicy,
            content: item.content,
            localId: item.localId,
            sidechainId: item.sidechainId,
            messageRole: item.messageRole,
            ...(item.sourceCreatedAt ? { sourceCreatedAt: item.sourceCreatedAt } : {}),
            ...(item.sourceUpdatedAt ? { sourceUpdatedAt: item.sourceUpdatedAt } : {}),
            ...(item.transcriptObservationProvenance
                ? { transcriptObservationProvenance: item.transcriptObservationProvenance }
                : {}),
        });
        if (!persisted.ok) return persisted;
        didWrite = true;
        messages.push(persisted.message);
    }

    const orderedMessages = [...messages].sort((left, right) => left.seq - right.seq);
    return {
        ok: true as const,
        didWrite,
        messages: orderedMessages,
        firstSeq: orderedMessages[0]?.seq ?? null,
        lastSeq: orderedMessages[orderedMessages.length - 1]?.seq ?? null,
    };
}

export async function writeHistoricalSessionMessageBatchInTx(
    tx: Tx,
    params: Readonly<{
        sessionId: string;
        writeAuthority?: SessionTranscriptWriteAuthority;
        storagePolicy: SessionTranscriptStoragePolicy;
        items: readonly HistoricalSessionMessageItem[];
    }>,
) {
    const session = await tx.session.findUnique({
        where: { id: params.sessionId },
        select: { encryptionMode: true },
    });
    if (!session) return { ok: false as const, error: "session-not-found" as const };
    return await writeHistoricalSessionMessageBatchWithModeInTx(tx, {
        ...params,
        writeAuthority: params.writeAuthority ?? "historical_import",
        sessionEncryptionMode: session.encryptionMode === "plain" ? "plain" : "e2ee",
    });
}

/**
 * Run one historical batch atomically. A concurrent identical importer can win the stable-local-id
 * constraint after this transaction's initial lookup, so retry the complete transaction once and
 * let the canonical exact-retry check return the durable winner.
 */
export async function writeHistoricalSessionMessageBatch(
    params: Readonly<{
        sessionId: string;
        storagePolicy: SessionTranscriptStoragePolicy;
        items: readonly HistoricalSessionMessageItem[];
    }>,
) {
    const attempt = async () => await inTx(
        async (tx) => await writeHistoricalSessionMessageBatchInTx(tx, params),
    );
    try {
        return await attempt();
    } catch (error) {
        if (!isPrismaErrorCode(error, "P2002")) throw error;
        return await attempt();
    }
}
