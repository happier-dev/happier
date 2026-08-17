import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

import type { Tx } from "@/storage/inTx";
import { serializeSessionInputRequestEqualityIntentV1 } from "@happier-dev/protocol";

const transcriptWriter = vi.hoisted(() => ({
    validateSessionTranscriptStoredContent: vi.fn(),
    validateSessionTranscriptWriteAuthorityInTx: vi.fn(),
    writeSessionTranscriptMessageInTx: vi.fn(),
}));

vi.mock("@/app/session/sessionTranscriptWrite", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/app/session/sessionTranscriptWrite")>();
    return {
        ...actual,
        validateSessionTranscriptStoredContent: transcriptWriter.validateSessionTranscriptStoredContent,
        validateSessionTranscriptWriteAuthorityInTx: transcriptWriter.validateSessionTranscriptWriteAuthorityInTx,
        writeSessionTranscriptMessageInTx: transcriptWriter.writeSessionTranscriptMessageInTx,
    };
});

import { createSessionMessageFromPending } from "./pendingMessageTranscriptCommit";

const createdAt = new Date("2026-08-09T00:00:00.000Z");
const tx = {
    sessionMessage: {
        findFirst: vi.fn(),
        update: vi.fn(),
    },
} as unknown as Tx;

describe("Pending transcript commit", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        transcriptWriter.validateSessionTranscriptStoredContent.mockReturnValue({ ok: true });
        transcriptWriter.validateSessionTranscriptWriteAuthorityInTx.mockResolvedValue({ ok: true });
        (tx.sessionMessage.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
        transcriptWriter.writeSessionTranscriptMessageInTx.mockResolvedValue({
            ok: true,
            message: {
                id: "message-1",
                seq: 1,
                localId: "pending-1",
                messageRole: "user",
                content: { t: "plain", v: { type: "user", text: "hello" } },
                deliveryResolution: null,
                createdAt,
                updatedAt: createdAt,
            },
        });
    });

    it("carries immutable admission evidence from Pending into the sole transcript writer", async () => {
        const inputAdmissionReceipt = {
            v: 1,
            issuer: "authenticatedAccount",
            actorAccountId: "account-1",
            sessionRelationship: "sharedEditor",
        } as const;
        const requestEqualityEvidenceV1 = {
            kind: "plainDigest",
            digest: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        } as const;

        await expect(createSessionMessageFromPending(tx, {
            sessionId: "session-1",
            sessionEncryptionMode: "plain",
            storagePolicy: "optional",
            localId: "pending-1",
            content: { t: "plain", v: { type: "user", text: "hello" } },
            messageRole: "user",
            inputAdmissionReceipt,
            requestEqualityEvidenceV1,
        } as never)).resolves.toMatchObject({ ok: true, didWrite: true });

        expect(transcriptWriter.writeSessionTranscriptMessageInTx).toHaveBeenCalledWith(
            tx,
            expect.objectContaining({
                inputAdmissionReceipt,
                requestEqualityEvidenceV1,
            }),
        );
    });

    it("derives the terminal plain digest from the complete Pending request and requested action", async () => {
        const content = {
            t: "plain" as const,
            v: {
                happierInputRequestV1: { v: 1, producer: "cli" },
                text: "hello",
            },
        };
        const requestedAction = { v: 1, kind: "send_now" } as const;
        const expectedEvidence = {
            kind: "plainDigest",
            digest: createHash("sha256")
                .update(serializeSessionInputRequestEqualityIntentV1({
                    requestEnvelope: content,
                    requestedAction,
                }), "utf8")
                .digest("base64url"),
        } as const;

        await expect(createSessionMessageFromPending(tx, {
            sessionId: "session-1",
            sessionEncryptionMode: "plain",
            storagePolicy: "optional",
            localId: "pending-plain-digest",
            content,
            messageRole: "user",
            pendingRequestedAction: requestedAction,
        } as never)).resolves.toMatchObject({ ok: true, didWrite: true });

        expect(transcriptWriter.writeSessionTranscriptMessageInTx).toHaveBeenCalledWith(
            tx,
            expect.objectContaining({ requestEqualityEvidenceV1: expectedEvidence }),
        );
    });

    it("derives terminal equality from the replaced request while persisting only final authority content", async () => {
        const requestContent = {
            t: "plain" as const,
            v: {
                role: "user",
                content: { type: "text", text: "hello" },
                meta: { happierInputRequestV1: { v: 1, producer: "cli", caller: { kind: "host" }, permission: {} } },
            },
        };
        const authorityContent = {
            t: "plain" as const,
            v: {
                role: "user",
                content: { type: "text", text: "hello" },
                meta: {
                    happierInputAuthorityV1: {
                        v: 1,
                        producer: "cli",
                        caller: { kind: "host" },
                        permission: { admittedPermissionCeiling: "default" },
                    },
                },
            },
        };
        const requestedAction = { v: 1, kind: "send_now" } as const;
        const expectedEvidence = {
            kind: "plainDigest",
            digest: createHash("sha256")
                .update(serializeSessionInputRequestEqualityIntentV1({
                    requestEnvelope: requestContent,
                    requestedAction,
                }), "utf8")
                .digest("base64url"),
        } as const;

        await expect(createSessionMessageFromPending(tx, {
            sessionId: "session-1",
            sessionEncryptionMode: "plain",
            storagePolicy: "optional",
            localId: "pending-replaced-request",
            content: authorityContent,
            requestContentForEquality: requestContent,
            messageRole: "user",
            pendingRequestedAction: requestedAction,
        } as never)).resolves.toMatchObject({ ok: true, didWrite: true });

        expect(transcriptWriter.writeSessionTranscriptMessageInTx).toHaveBeenCalledWith(
            tx,
            expect.objectContaining({
                content: authorityContent,
                requestEqualityEvidenceV1: expectedEvidence,
            }),
        );
    });

    it("increments the private row revision when completing an existing Pending transcript row", async () => {
        const content = { t: "plain" as const, v: { type: "user", text: "hello" } };
        (tx.sessionMessage.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
            id: "message-existing",
            seq: 1,
            localId: "pending-existing",
            messageRole: null,
            content,
            deliveryResolution: null,
            inputAdmissionReceipt: null,
            requestEqualityEvidenceV1: null,
            createdAt,
            updatedAt: createdAt,
        });
        (tx.sessionMessage.update as ReturnType<typeof vi.fn>).mockResolvedValue({
            id: "message-existing",
            seq: 1,
            localId: "pending-existing",
            messageRole: "user",
            content,
            deliveryResolution: null,
            createdAt,
            updatedAt: createdAt,
        });

        await expect(createSessionMessageFromPending(tx, {
            sessionId: "session-1",
            sessionEncryptionMode: "plain",
            storagePolicy: "optional",
            localId: "pending-existing",
            content,
            messageRole: "user",
        })).resolves.toMatchObject({ ok: true, didWrite: false, didUpdate: true });

        expect(tx.sessionMessage.update).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: "message-existing" },
            data: { messageRole: "user", rowRevision: { increment: BigInt(1) } },
        }));
    });

    it("keeps established-role disagreement as a typed Pending transcript conflict", async () => {
        const content = { t: "plain" as const, v: { type: "user", text: "hello" } };
        (tx.sessionMessage.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
            id: "message-role-conflict",
            seq: 1,
            localId: "pending-role-conflict",
            messageRole: "agent",
            content,
            deliveryResolution: null,
            inputAdmissionReceipt: null,
            requestEqualityEvidenceV1: null,
            createdAt,
            updatedAt: createdAt,
        });

        await expect(createSessionMessageFromPending(tx, {
            sessionId: "session-1",
            sessionEncryptionMode: "plain",
            storagePolicy: "optional",
            localId: "pending-role-conflict",
            content,
            messageRole: "user",
        })).resolves.toEqual({
            ok: false,
            error: "transcript-conflict",
            conflict: "message-role",
        });

        expect(tx.sessionMessage.update).not.toHaveBeenCalled();
    });
});
