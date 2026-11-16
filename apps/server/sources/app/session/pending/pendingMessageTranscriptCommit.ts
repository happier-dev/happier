import { decodeStoredSessionMessage } from "@/storage/sessionMessageContent";
import { normalizeSessionMessageContentForStorage } from "@/app/session/normalizeSessionMessageContentForStorage";
import { parseSessionMessageRole } from "@/app/session/messageRole/resolveSessionMessageRole";
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import {
    compareSessionMessageContentAndRole,
    resolveSurvivingSessionMessageAuthorAccountIdInTx,
    validateSessionTranscriptStoredContent,
    validateSessionTranscriptWriteAuthorityInTx,
    writeSessionTranscriptMessageInTx,
    type SessionTranscriptStoragePolicy,
    type SessionTranscriptWriteRejectionCode,
} from "@/app/session/sessionTranscriptWrite";
import type { Tx } from "@/storage/inTx";
import { PendingRequestedActionV1Schema, type PendingRequestedActionV1 } from '@happier-dev/protocol/sessions/pending/pendingRequestedActionV1';
import { deriveSessionMessageAuthorAccountIdV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageAccountActorV1';
import { readStoredSessionMessageDeliveryResolutionV1, type SessionMessageDeliveryResolutionV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageDeliveryResolutionV1';
import { readSessionInputAuthority, serializeSessionInputRequestEqualityIntentV1, SessionInputAdmissionReceiptV1Schema, SessionInputRequestEqualityEvidenceV1Schema, type SessionInputAdmissionReceiptV1, type SessionInputRequestEqualityEvidenceV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { type SessionEncryptionMode } from '@happier-dev/protocol/encryption/storagePolicyDecisions';
import { type SessionMessageRole } from '@happier-dev/protocol/sessions/messages/sessionMessageRole';
import { notifySessionTranscriptMutationAfterCommit } from '../sessionTranscriptMutationObserver';
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { SessionMessageReplyProgressV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';
import { UsageTimingBoundsV1Schema, mergeUsageTimingBoundsV1 } from '@happier-dev/protocol/usage/usageWorkEvidence';
import { getActivePrismaRuntime } from '@/storage/db';

/**
 * Pending is the sole custody owner until retirement, including when a transcript row already exists:
 * its Message carries the original's reply progress and the host's exact Turn-begin witness. One read
 * of the Pending row serves both (nothing writes it in between).
 */
async function carryPendingCustodyFactsInTx(tx: Tx, sessionId: string, localId: string, messageId: string): Promise<void> {
    const pending = await tx.sessionPendingMessage.findUnique({ where: { sessionId_localId: { sessionId, localId } },
        select: { replyProgress: true, replyTargetMachineId: true, turnStartWitnessId: true } });
    if (pending?.replyProgress != null) {
        const progress = SessionMessageReplyProgressV1Schema.parse(pending.replyProgress);
        await tx.sessionMessage.update({ where: { id: messageId }, data: { replyProgress: progress,
            replyDisposition: progress.disposition, replyTargetMachineId: pending.replyTargetMachineId,
            replySourceSessionId: progress.sourceSession?.sourceSessionId ?? null, replySourceTurnId: progress.sourceSession?.sourceTurnId ?? null } });
    }
    if (pending?.turnStartWitnessId) {
        await tx.sessionMessage.updateMany({ where: { id: messageId, turnStartWitnessId: null },
            data: { turnStartWitnessId: pending.turnStartWitnessId } });
    }
}

export type PendingTranscriptMessage = {
    id: string;
    seq: number;
    localId: string;
    sidechainId: string | null;
    messageRole: SessionMessageRole | null;
    content: PrismaJson.SessionMessageContent;
    deliveryResolution: SessionMessageDeliveryResolutionV1 | null;
    createdAt: Date;
    updatedAt: Date;
    /**
     * Server-internal committed admission evidence. The immediate realtime
     * publisher derives the sanitized Account actor from it instead of rereading
     * the row; it is never serialized onto the wire.
     */
    inputAdmissionReceipt: SessionInputAdmissionReceiptV1 | null;
    authorAccountId: string | null;
};

/** Server-internal committed receipt read; a malformed stored value projects no actor. */
function parseCommittedInputAdmissionReceipt(value: unknown): SessionInputAdmissionReceiptV1 | null {
    const parsed = createStoredReadSchema(SessionInputAdmissionReceiptV1Schema).safeParse(value);
    return parsed.success ? parsed.data : null;
}

export function derivePlainRequestEqualityEvidence(params: Readonly<{
    content: PrismaJson.SessionMessageContent;
    requestedAction: PendingRequestedActionV1;
}>): SessionInputRequestEqualityEvidenceV1 | undefined {
    if (params.content.t !== "plain") return undefined;
    return SessionInputRequestEqualityEvidenceV1Schema.parse({
        kind: "plainDigest",
        digest: createHash("sha256")
            .update(serializeSessionInputRequestEqualityIntentV1({
                requestEnvelope: params.content,
                requestedAction: params.requestedAction,
            }), "utf8")
            .digest("base64url"),
    });
}

export async function createSessionMessageFromPending(tx: Tx, params: {
    sessionId: string;
    sessionEncryptionMode: SessionEncryptionMode;
    expectedSidechainId?: string | null;
    /** Exact recipient copied only from the server-owned Pending row. */
    targetExecutionRunId?: string | null;
    storagePolicy: SessionTranscriptStoragePolicy;
    localId: string;
    /** Original protected request bytes retained only for terminal equality derivation. */
    requestContentForEquality?: PrismaJson.SessionMessageContent;
    content: PrismaJson.SessionMessageContent;
    messageRole: SessionMessageRole | null;
    /** Whole-content proof, retained beside Pending's protected content. */
    usageTimingV1?: unknown;
    /** Provider acceptance contributes a delta, never a whole-message proof. */
    deliveryUsageTimingV1?: unknown;
    deliveryResolution?: SessionMessageDeliveryResolutionV1;
    inputAdmissionReceipt?: SessionInputAdmissionReceiptV1;
    requestEqualityEvidenceV1?: SessionInputRequestEqualityEvidenceV1;
    pendingRequestedAction?: unknown;
}): Promise<{
    ok: true;
    didWrite: boolean;
    didUpdate: boolean;
    message: PendingTranscriptMessage;
} | {
    ok: false;
    error: "transcript-conflict";
    conflict: "content" | "message-role" | "delivery-resolution" | "input-admission" | "sidechain" | "execution-run-target";
} | {
    ok: false;
    error: "storage-mode-conflict";
    code: SessionTranscriptWriteRejectionCode;
}> {
    const { sessionId, localId, messageRole } = params;
    const content = normalizeSessionMessageContentForStorage(params.content);
    if (!content) return { ok: false, error: "transcript-conflict", conflict: "content" };
    const authoredTiming = UsageTimingBoundsV1Schema.safeParse(params.usageTimingV1).data ?? null;
    const deliveryTiming = UsageTimingBoundsV1Schema.safeParse(params.deliveryUsageTimingV1).data ?? null;
    const targetExecutionRunId = params.targetExecutionRunId ?? null;
    const inputAdmissionReceipt = params.inputAdmissionReceipt === undefined
        ? undefined
        : SessionInputAdmissionReceiptV1Schema.safeParse(params.inputAdmissionReceipt);
    const requestEqualityEvidenceV1 = params.requestEqualityEvidenceV1 === undefined
        ? undefined
        : SessionInputRequestEqualityEvidenceV1Schema.safeParse(params.requestEqualityEvidenceV1);
    const pendingRequestedAction = params.pendingRequestedAction === undefined
        ? undefined
        : PendingRequestedActionV1Schema.safeParse(params.pendingRequestedAction);
    if (
        inputAdmissionReceipt !== undefined && !inputAdmissionReceipt.success
        || requestEqualityEvidenceV1 !== undefined && !requestEqualityEvidenceV1.success
        || pendingRequestedAction !== undefined && !pendingRequestedAction.success
    ) {
        return { ok: false, error: "transcript-conflict", conflict: "input-admission" };
    }
    const hasSettledInputAuthority = content.t === "plain"
        && content.v !== null
        && typeof content.v === "object"
        && !Array.isArray(content.v)
        && "meta" in content.v
        // Fresh settlement always carries its original request; provider
        // delivery commits instead reuse the canonical retained Pending row.
        && readSessionInputAuthority(content.v.meta, params.requestContentForEquality === undefined ? 'stored' : 'input') !== null;
    // A settled Pending row retains the original request digest beside its final
    // authority content. Rehashing that final envelope would change input identity.
    const retainedSettledRequestEvidence = params.requestContentForEquality === undefined
        && hasSettledInputAuthority
        && requestEqualityEvidenceV1 !== undefined;
    const derivedPlainRequestEqualityEvidence = pendingRequestedAction === undefined || retainedSettledRequestEvidence
        ? undefined
        : derivePlainRequestEqualityEvidence({
            content: params.requestContentForEquality ?? content,
            requestedAction: pendingRequestedAction.data,
        });
    if (
        derivedPlainRequestEqualityEvidence !== undefined
        && requestEqualityEvidenceV1 !== undefined
        && !isDeepStrictEqual(requestEqualityEvidenceV1.data, derivedPlainRequestEqualityEvidence)
    ) {
        return { ok: false, error: "transcript-conflict", conflict: "input-admission" };
    }
    const effectiveRequestEqualityEvidenceV1 = derivedPlainRequestEqualityEvidence
        ?? (requestEqualityEvidenceV1 === undefined ? undefined : requestEqualityEvidenceV1.data);
    const authority = await validateSessionTranscriptWriteAuthorityInTx(tx, {
        sessionId,
        writeAuthority: "hosted",
    });
    if (!authority.ok) return authority;

    const existing = await tx.sessionMessage.findFirst({
        where: { sessionId, localId },
        select: { contentBytes: true,
            id: true,
            seq: true,
            localId: true,
            sidechainId: true,
            targetExecutionRunId: true,
            messageRole: true,
            content: true,
            usageTimingV1: true,
            deliveryResolution: true,
            inputAdmissionReceipt: true,
            authorAccountId: true,
            requestEqualityEvidenceV1: true,
            createdAt: true,
            updatedAt: true,
        },
    }).then(row => decodeStoredSessionMessage(row));
    if (existing && existing.localId) {
        const existingTargetExecutionRunId = existing.targetExecutionRunId ?? null;
        if (existing.sidechainId !== (params.expectedSidechainId ?? null)) {
            return { ok: false, error: "transcript-conflict", conflict: "sidechain" };
        }
        if (
            existingTargetExecutionRunId !== null
            && existingTargetExecutionRunId !== targetExecutionRunId
        ) {
            return { ok: false, error: "transcript-conflict", conflict: "execution-run-target" };
        }
        // This is the only Pending branch that does not continue into the
        // canonical insert writer. Reuse its admission before a role or
        // delivery-resolution settlement can mutate an existing row.
        const storageAdmission = validateSessionTranscriptStoredContent({
            content,
            sessionEncryptionMode: params.sessionEncryptionMode,
            storagePolicy: params.storagePolicy,
        });
        if (!storageAdmission.ok) return storageAdmission;

        const compatibility = compareSessionMessageContentAndRole({
            existing,
            candidate: { content, messageRole },
        });
        if (compatibility.kind === "content-mismatch") {
            return { ok: false, error: "transcript-conflict", conflict: "content" };
        }
        if (compatibility.kind === "role-conflict") {
            return { ok: false, error: "transcript-conflict", conflict: "message-role" };
        }

        // A provider-written transcript anchor predating settlement carries no
        // host admission identity. An absent identity is compatible with the
        // incoming admission and is backfilled below, so the joined row
        // converges to the same settled shape the insert path persists; a
        // present-but-different identity means another message already owns
        // this localId and stays a conflict.
        const existingInputAdmissionReceipt = existing.inputAdmissionReceipt == null
            ? null
            : createStoredReadSchema(SessionInputAdmissionReceiptV1Schema).safeParse(existing.inputAdmissionReceipt);
        if (
            inputAdmissionReceipt !== undefined
            && existingInputAdmissionReceipt !== null
            && (
                !existingInputAdmissionReceipt.success
                || !isDeepStrictEqual(existingInputAdmissionReceipt.data, inputAdmissionReceipt.data)
            )
        ) {
            return { ok: false, error: "transcript-conflict", conflict: "input-admission" };
        }
        const existingRequestEqualityEvidenceV1 = existing.requestEqualityEvidenceV1 == null
            ? null
            : createStoredReadSchema(SessionInputRequestEqualityEvidenceV1Schema).safeParse(existing.requestEqualityEvidenceV1);
        if (
            effectiveRequestEqualityEvidenceV1 !== undefined
            && existingRequestEqualityEvidenceV1 !== null
            && (
                !existingRequestEqualityEvidenceV1.success
                || !isDeepStrictEqual(existingRequestEqualityEvidenceV1.data, effectiveRequestEqualityEvidenceV1)
            )
        ) {
            return { ok: false, error: "transcript-conflict", conflict: "input-admission" };
        }

        const existingDeliveryResolution = readStoredSessionMessageDeliveryResolutionV1(existing.deliveryResolution);
        if (existing.deliveryResolution !== null && existingDeliveryResolution === null) {
            return { ok: false, error: "transcript-conflict", conflict: "delivery-resolution" };
        }
        if (
            params.deliveryResolution
            && existingDeliveryResolution
            && !isDeepStrictEqual(existingDeliveryResolution, params.deliveryResolution)
        ) {
            return { ok: false, error: "transcript-conflict", conflict: "delivery-resolution" };
        }

        const needsRoleUpdate = compatibility.backfillsRole;
        const needsDeliveryResolutionUpdate = params.deliveryResolution !== undefined && existingDeliveryResolution === null;
        const existingTiming = UsageTimingBoundsV1Schema.safeParse(existing.usageTimingV1).data ?? null;
        // Once a receipt is admitted, stored timing covers both protected
        // inputs. Repeating Pending's original-content proof cannot replace
        // that combined proof or certify a previously unknown receipt.
        const baseTiming = existingDeliveryResolution?.kind === 'provider_accepted' || params.usageTimingV1 === undefined
            ? existingTiming : authoredTiming;
        const nextTiming = needsDeliveryResolutionUpdate && params.deliveryResolution?.kind === 'provider_accepted'
            ? mergeUsageTimingBoundsV1(baseTiming, deliveryTiming) : baseTiming;
        const needsTimingUpdate = !isDeepStrictEqual(existingTiming, nextTiming);
        const needsAdmissionIdentityBackfill =
            inputAdmissionReceipt !== undefined && existing.inputAdmissionReceipt == null
            || effectiveRequestEqualityEvidenceV1 !== undefined && existing.requestEqualityEvidenceV1 == null;
        // A provider transcript anchor can precede Pending settlement. Pending
        // custody is the sole authority allowed to attach its exact Run target.
        const needsTargetExecutionRunIdBackfill =
            targetExecutionRunId !== null && existingTargetExecutionRunId === null;

        // A role or receipt backfill changes what the derived author projection
        // must be, so it is recomputed from the settled row in this same
        // transaction rather than by a second repair owner. The receipt stays
        // authoritative: a non-null disagreement is refused, never rewritten.
        const settledInputAdmissionReceipt = existing.inputAdmissionReceipt != null
            ? existing.inputAdmissionReceipt
            : inputAdmissionReceipt?.data;
        const settledAuthorAccountId = deriveSessionMessageAuthorAccountIdV1({
            messageRole: needsRoleUpdate ? messageRole : parseSessionMessageRole(existing.messageRole),
            inputAdmissionReceipt: settledInputAdmissionReceipt,
        }, 'stored');
        if (existing.authorAccountId != null && existing.authorAccountId !== settledAuthorAccountId) {
            return { ok: false, error: "transcript-conflict", conflict: "input-admission" };
        }
        const survivingAuthorAccountId = existing.authorAccountId
            ?? await resolveSurvivingSessionMessageAuthorAccountIdInTx(tx, settledAuthorAccountId);
        const needsAuthorProjectionBackfill =
            existing.authorAccountId == null && survivingAuthorAccountId !== null;

        const row = needsRoleUpdate || needsDeliveryResolutionUpdate || needsTimingUpdate || needsAdmissionIdentityBackfill || needsAuthorProjectionBackfill || needsTargetExecutionRunIdBackfill
            ? await tx.sessionMessage.update({
                where: { id: existing.id },
                data: {
                    ...(needsRoleUpdate ? { messageRole } : {}),
                    ...(needsDeliveryResolutionUpdate ? { deliveryResolution: params.deliveryResolution } : {}),
                    ...(needsTimingUpdate ? { usageTimingV1: nextTiming ?? getActivePrismaRuntime().DbNull } : {}),
                    ...(inputAdmissionReceipt !== undefined && existing.inputAdmissionReceipt == null
                        ? { inputAdmissionReceipt: inputAdmissionReceipt.data }
                        : {}),
                    ...(effectiveRequestEqualityEvidenceV1 !== undefined && existing.requestEqualityEvidenceV1 == null
                        ? { requestEqualityEvidenceV1: effectiveRequestEqualityEvidenceV1 }
                        : {}),
                    ...(needsAuthorProjectionBackfill ? { authorAccountId: survivingAuthorAccountId } : {}),
                    ...(needsTargetExecutionRunIdBackfill ? { targetExecutionRunId } : {}),
                    rowRevision: { increment: BigInt(1) },
                },
                select: { contentBytes: true, id: true, seq: true, localId: true, messageRole: true, content: true, deliveryResolution: true, createdAt: true, updatedAt: true },
            }).then(row => decodeStoredSessionMessage(row))
            : existing;

        if (needsRoleUpdate || needsDeliveryResolutionUpdate || needsTimingUpdate || needsAdmissionIdentityBackfill || needsAuthorProjectionBackfill || needsTargetExecutionRunIdBackfill) {
            notifySessionTranscriptMutationAfterCommit(tx, {
                kind: 'upsert',
                message: {
                    id: row.id,
                    sessionId,
                    seq: row.seq,
                    createdAtMs: row.createdAt.getTime(),
                    updatedAtMs: row.updatedAt.getTime(),
                    role: typeof row.messageRole === 'string' ? row.messageRole : null,
                    content: row.content,
                },
            });
        }

        await carryPendingCustodyFactsInTx(tx, sessionId, localId, row.id);
        return {
            ok: true,
            didWrite: false,
            didUpdate: needsRoleUpdate || needsDeliveryResolutionUpdate || needsTimingUpdate || needsAdmissionIdentityBackfill || needsAuthorProjectionBackfill || needsTargetExecutionRunIdBackfill,
            message: {
                id: row.id,
                seq: row.seq,
                localId: row.localId ?? localId,
                sidechainId: existing.sidechainId,
                messageRole: parseSessionMessageRole(row.messageRole),
                content: row.content as PrismaJson.SessionMessageContent,
                deliveryResolution: readStoredSessionMessageDeliveryResolutionV1(row.deliveryResolution),
                createdAt: row.createdAt,
                updatedAt: row.updatedAt,
                inputAdmissionReceipt: parseCommittedInputAdmissionReceipt(settledInputAdmissionReceipt),
                authorAccountId: survivingAuthorAccountId,
            },
        };
    }

    const messageCreatedAt = new Date();
    const persisted = await writeSessionTranscriptMessageInTx(tx, {
        sessionId,
        writeAuthority: "hosted",
        sessionEncryptionMode: params.sessionEncryptionMode,
        storagePolicy: params.storagePolicy,
        content,
        usageTimingV1: params.deliveryResolution?.kind === 'provider_accepted'
            ? mergeUsageTimingBoundsV1(authoredTiming, deliveryTiming) : authoredTiming,
        localId,
        sidechainId: params.expectedSidechainId ?? null,
        messageRole,
        deliveryResolution: params.deliveryResolution,
        ...(inputAdmissionReceipt === undefined ? {} : { inputAdmissionReceipt: inputAdmissionReceipt.data }),
        ...(effectiveRequestEqualityEvidenceV1 === undefined
            ? {}
            : { requestEqualityEvidenceV1: effectiveRequestEqualityEvidenceV1 }),
        createdAt: messageCreatedAt,
        recordsMeaningfulActivity: true,
    });
    if (!persisted.ok) {
        return persisted;
    }
    const created = persisted.message;
    await carryPendingCustodyFactsInTx(tx, sessionId, localId, created.id);
    if (targetExecutionRunId !== null) {
        // Keep this server-private binding inside the Pending commit owner. The
        // canonical transcript writer intentionally has no public/general
        // parameter for it, and this update shares the caller's transaction.
        await tx.sessionMessage.update({
            where: { id: created.id },
            data: { targetExecutionRunId },
            select: { id: true },
        });
    }

    return {
        ok: true,
        didWrite: true,
        didUpdate: false,
        message: {
            id: created.id,
            seq: created.seq,
            localId: created.localId!,
            sidechainId: created.sidechainId,
            messageRole: parseSessionMessageRole(created.messageRole),
            content: created.content as PrismaJson.SessionMessageContent,
            deliveryResolution: readStoredSessionMessageDeliveryResolutionV1(created.deliveryResolution),
            createdAt: created.createdAt,
            updatedAt: created.updatedAt,
            inputAdmissionReceipt: parseCommittedInputAdmissionReceipt(created.inputAdmissionReceipt),
            authorAccountId: created.authorAccountId,
        },
    };
}
