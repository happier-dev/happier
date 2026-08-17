import { parseSessionMessageRole } from "@/app/session/messageRole/resolveSessionMessageRole";
import {
    compareSessionMessageContentAndRole,
    validateSessionTranscriptStoredContent,
    validateSessionTranscriptWriteAuthorityInTx,
    writeSessionTranscriptMessageInTx,
    type SessionTranscriptStoragePolicy,
    type SessionTranscriptWriteRejectionCode,
} from "@/app/session/sessionTranscriptWrite";
import type { Tx } from "@/storage/inTx";
import {
    PendingRequestedActionV1Schema,
    parseSessionMessageDeliveryResolutionV1,
    serializeSessionInputRequestEqualityIntentV1,
    SessionInputAdmissionReceiptV1Schema,
    SessionInputRequestEqualityEvidenceV1Schema,
    type SessionEncryptionMode,
    type SessionInputAdmissionReceiptV1,
    type SessionInputRequestEqualityEvidenceV1,
    type SessionMessageDeliveryResolutionV1,
    type SessionMessageRole,
    type PendingRequestedActionV1,
} from "@happier-dev/protocol";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

export type PendingTranscriptMessage = {
    id: string;
    seq: number;
    localId: string;
    messageRole: SessionMessageRole | null;
    content: PrismaJson.SessionMessageContent;
    deliveryResolution: SessionMessageDeliveryResolutionV1 | null;
    createdAt: Date;
    updatedAt: Date;
};

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
    storagePolicy: SessionTranscriptStoragePolicy;
    localId: string;
    /** Original protected request bytes retained only for terminal equality derivation. */
    requestContentForEquality?: PrismaJson.SessionMessageContent;
    content: PrismaJson.SessionMessageContent;
    messageRole: SessionMessageRole | null;
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
    conflict: "content" | "message-role" | "delivery-resolution" | "input-admission";
} | {
    ok: false;
    error: "storage-mode-conflict";
    code: SessionTranscriptWriteRejectionCode;
}> {
    const { sessionId, localId, content, messageRole } = params;
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
    const derivedPlainRequestEqualityEvidence = pendingRequestedAction === undefined
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
        select: {
            id: true,
            seq: true,
            localId: true,
            messageRole: true,
            content: true,
            deliveryResolution: true,
            inputAdmissionReceipt: true,
            requestEqualityEvidenceV1: true,
            createdAt: true,
            updatedAt: true,
        },
    });
    if (existing && existing.localId) {
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

        if (
            inputAdmissionReceipt !== undefined
            && (
                !SessionInputAdmissionReceiptV1Schema.safeParse(existing.inputAdmissionReceipt).success
                || !isDeepStrictEqual(existing.inputAdmissionReceipt, inputAdmissionReceipt.data)
            )
        ) {
            return { ok: false, error: "transcript-conflict", conflict: "input-admission" };
        }
        if (
            effectiveRequestEqualityEvidenceV1 !== undefined
            && (
                !SessionInputRequestEqualityEvidenceV1Schema.safeParse(existing.requestEqualityEvidenceV1).success
                || !isDeepStrictEqual(existing.requestEqualityEvidenceV1, effectiveRequestEqualityEvidenceV1)
            )
        ) {
            return { ok: false, error: "transcript-conflict", conflict: "input-admission" };
        }

        const existingDeliveryResolution = parseSessionMessageDeliveryResolutionV1(existing.deliveryResolution);
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
        const row = needsRoleUpdate || needsDeliveryResolutionUpdate
            ? await tx.sessionMessage.update({
                where: { id: existing.id },
                data: {
                    ...(needsRoleUpdate ? { messageRole } : {}),
                    ...(needsDeliveryResolutionUpdate ? { deliveryResolution: params.deliveryResolution } : {}),
                    rowRevision: { increment: BigInt(1) },
                },
                select: { id: true, seq: true, localId: true, messageRole: true, content: true, deliveryResolution: true, createdAt: true, updatedAt: true },
            })
            : existing;

        return {
            ok: true,
            didWrite: false,
            didUpdate: needsRoleUpdate || needsDeliveryResolutionUpdate,
            message: {
                id: row.id,
                seq: row.seq,
                localId: row.localId ?? localId,
                messageRole: parseSessionMessageRole(row.messageRole),
                content: row.content as PrismaJson.SessionMessageContent,
                deliveryResolution: parseSessionMessageDeliveryResolutionV1(row.deliveryResolution),
                createdAt: row.createdAt,
                updatedAt: row.updatedAt,
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
        localId,
        sidechainId: null,
        messageRole,
        deliveryResolution: params.deliveryResolution,
        ...(inputAdmissionReceipt === undefined ? {} : { inputAdmissionReceipt: inputAdmissionReceipt.data }),
        ...(effectiveRequestEqualityEvidenceV1 === undefined
            ? {}
            : { requestEqualityEvidenceV1: effectiveRequestEqualityEvidenceV1 }),
        createdAt: messageCreatedAt,
        meaningfulActivityAt: messageCreatedAt,
    });
    if (!persisted.ok) {
        return persisted;
    }
    const created = persisted.message;

    return {
        ok: true,
        didWrite: true,
        didUpdate: false,
        message: {
            id: created.id,
            seq: created.seq,
            localId: created.localId!,
            messageRole: parseSessionMessageRole(created.messageRole),
            content: created.content as PrismaJson.SessionMessageContent,
            deliveryResolution: parseSessionMessageDeliveryResolutionV1(created.deliveryResolution),
            createdAt: created.createdAt,
            updatedAt: created.updatedAt,
        },
    };
}
