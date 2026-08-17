import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Tx } from "@/storage/inTx";

const inTx = vi.hoisted(() => vi.fn());
vi.mock("@/storage/inTx", () => ({ inTx }));

const sessionUpdate = vi.fn();
const sessionFindUnique = vi.fn();
const sessionMessageFindMany = vi.fn();
const sessionMessageCreate = vi.fn();

function createTx(): Tx {
    return {
        session: { findUnique: sessionFindUnique, update: sessionUpdate },
        sessionMessage: { findMany: sessionMessageFindMany, create: sessionMessageCreate },
    } as unknown as Tx;
}

describe("canonical session transcript writer", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        sessionUpdate.mockResolvedValue({ seq: 8 });
        sessionFindUnique.mockResolvedValue({
            encryptionMode: "plain",
            currentStorageState: "machine_only",
        });
        sessionMessageFindMany.mockResolvedValue([]);
        sessionMessageCreate.mockResolvedValue({
            id: "message-1",
            sessionId: "session-1",
            seq: 8,
            localId: "history:item-1",
            sidechainId: null,
            messageRole: "user",
            content: { t: "plain", v: { role: "user", text: "hello" } },
            sourceCreatedAt: null,
            sourceUpdatedAt: null,
            transcriptObservationProvenance: null,
            deliveryResolution: null,
            createdAt: new Date(1_000),
            updatedAt: new Date(1_000),
        });
        inTx.mockImplementation(async (operation: (tx: Tx) => Promise<unknown>) => await operation(createTx()));
    });

    it("rejects a mode-mismatched historical item before allocating a sequence", async () => {
        const service = await import("./sessionWriteService");
        const writeHistoricalSessionMessageInTx = Reflect.get(service, "writeHistoricalSessionMessageInTx") as
            | ((tx: Tx, params: unknown) => Promise<unknown>)
            | undefined;

        expect(writeHistoricalSessionMessageInTx).toBeTypeOf("function");
        const result = await writeHistoricalSessionMessageInTx!(createTx(), {
            sessionId: "session-1",
            sessionEncryptionMode: "e2ee",
            storagePolicy: "optional",
            localId: "history:item-1",
            sidechainId: null,
            messageRole: "user",
            content: { t: "plain", v: { role: "user", text: "hello" } },
        });

        expect(result).toEqual({
            ok: false,
            error: "storage-mode-conflict",
            code: "session_encryption_mode_mismatch",
        });
        expect(sessionUpdate).not.toHaveBeenCalled();
        expect(sessionMessageCreate).not.toHaveBeenCalled();
    }, 60_000);

    it("persists an admitted-input receipt and opaque equality evidence through the canonical writer", async () => {
        const service = await import("./sessionTranscriptWrite");
        const writeSessionTranscriptMessageInTx = Reflect.get(service, "writeSessionTranscriptMessageInTx") as
            | ((tx: Tx, params: unknown) => Promise<unknown>)
            | undefined;
        expect(writeSessionTranscriptMessageInTx).toBeTypeOf("function");

        const receipt = {
            v: 1,
            issuer: "authenticatedAccount",
            actorAccountId: "account-1",
            sessionRelationship: "sharedEditor",
        } as const;
        const equalityEvidence = {
            kind: "plainDigest",
            digest: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        } as const;
        await expect(writeSessionTranscriptMessageInTx!(createTx(), {
            sessionId: "session-1",
            writeAuthority: "hosted",
            sessionEncryptionMode: "plain",
            storagePolicy: "optional",
            content: { t: "plain", v: { role: "user", text: "hello" } },
            localId: "pending:item-1",
            sidechainId: null,
            messageRole: "user",
            inputAdmissionReceipt: receipt,
            requestEqualityEvidenceV1: equalityEvidence,
        })).resolves.toMatchObject({ ok: true });

        expect(sessionMessageCreate).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                inputAdmissionReceipt: receipt,
                requestEqualityEvidenceV1: equalityEvidence,
            }),
        }));
    }, 60_000);

    it("rejects every current structured presentation before mutation while preserving incumbent ACP and built-in content", async () => {
        const writer = await import("./sessionTranscriptWrite");

        const rejected = await writer.writeSessionTranscriptMessageInTx(createTx(), {
            sessionId: "session-1",
            writeAuthority: "hosted",
            sessionEncryptionMode: "plain",
            storagePolicy: "optional",
            localId: "structured:invalid",
            sidechainId: null,
            messageRole: "agent",
            content: {
                t: "plain",
                v: {
                    v: 1,
                    profile: "pluginTranscriptV1",
                    owner: { pluginId: "acme.transcript", contributionLocalId: "review-card" },
                    snapshot: {
                        kind: "field",
                        label: "Live field",
                        control: { kind: "text", settingId: "secret" },
                    },
                },
            },
        });

        expect(rejected).toEqual({
            ok: false,
            error: "storage-mode-conflict",
            code: "session_structured_presentation_invalid",
        });
        expect(sessionUpdate).not.toHaveBeenCalled();
        expect(sessionMessageCreate).not.toHaveBeenCalled();

        const blocked = await writer.writeSessionTranscriptMessageInTx(createTx(), {
            sessionId: "session-1",
            writeAuthority: "hosted",
            sessionEncryptionMode: "plain",
            storagePolicy: "optional",
            localId: "structured:valid",
            sidechainId: null,
            messageRole: "agent",
            content: {
                t: "plain",
                v: {
                    v: 1,
                    profile: "pluginTranscriptV1",
                    owner: { pluginId: "acme.transcript", contributionLocalId: "review-card" },
                    snapshot: { kind: "text", text: "Historical snapshot" },
                },
            },
        });

        expect(blocked).toEqual({
            ok: false,
            error: "storage-mode-conflict",
            code: "session_structured_presentation_unavailable",
        });
        expect(sessionUpdate).not.toHaveBeenCalled();
        expect(sessionMessageCreate).not.toHaveBeenCalled();

        const rawAcp = await writer.writeSessionTranscriptMessageInTx(createTx(), {
            sessionId: "session-1",
            writeAuthority: "hosted",
            sessionEncryptionMode: "plain",
            storagePolicy: "optional",
            localId: "acp:incumbent",
            sidechainId: null,
            messageRole: "agent",
            content: {
                t: "plain",
                v: {
                    role: "agent",
                    content: { type: "acp", data: { type: "message", message: "Incumbent ACP" } },
                },
            },
        });
        const builtInStructured = await writer.writeSessionTranscriptMessageInTx(createTx(), {
            sessionId: "session-1",
            writeAuthority: "hosted",
            sessionEncryptionMode: "plain",
            storagePolicy: "optional",
            localId: "built-in:review-comments",
            sidechainId: null,
            messageRole: "agent",
            content: {
                t: "plain",
                v: {
                    role: "agent",
                    content: { type: "acp", data: { type: "message", message: "Review comments" } },
                    meta: { happier: { kind: "review_comments.v1", payload: {} } },
                },
            },
        });

        expect(rawAcp).toMatchObject({ ok: true, message: { seq: 8 } });
        expect(builtInStructured).toMatchObject({ ok: true, message: { seq: 8 } });
        expect(sessionUpdate).toHaveBeenCalledTimes(2);
        expect(sessionMessageCreate).toHaveBeenCalledTimes(2);
    }, 60_000);

    it("writes a historical batch gaplessly and exact retries allocate nothing", async () => {
        const service = await import("./sessionWriteService");
        const writeHistoricalSessionMessageBatchInTx = Reflect.get(service, "writeHistoricalSessionMessageBatchInTx") as
            | ((tx: Tx, params: unknown) => Promise<any>)
            | undefined;
        expect(writeHistoricalSessionMessageBatchInTx).toBeTypeOf("function");

        sessionUpdate
            .mockResolvedValueOnce({ seq: 8 })
            .mockResolvedValueOnce({ seq: 9 });
        sessionMessageCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
            id: `message-${String(data.seq)}`,
            ...data,
            sourceCreatedAt: null,
            sourceUpdatedAt: null,
            transcriptObservationProvenance: null,
            deliveryResolution: null,
            updatedAt: data.createdAt,
        }));
        const items = [
            {
                localId: "history:item-1",
                sidechainId: null,
                messageRole: "user",
                content: { t: "plain", v: { role: "user", text: "one" } },
            },
            {
                localId: "history:item-2",
                sidechainId: null,
                messageRole: "agent",
                content: { t: "plain", v: { role: "agent", text: "two" } },
            },
        ];
        const first = await writeHistoricalSessionMessageBatchInTx!(createTx(), {
            sessionId: "session-1",
            storagePolicy: "optional",
            items,
        });

        expect(first).toMatchObject({ ok: true, didWrite: true, firstSeq: 8, lastSeq: 9 });
        expect(first.messages.map((message: { seq: number }) => message.seq)).toEqual([8, 9]);
        expect(sessionUpdate).toHaveBeenCalledTimes(2);

        vi.clearAllMocks();
        sessionMessageFindMany.mockResolvedValue(first.messages);
        const retry = await writeHistoricalSessionMessageBatchInTx!(createTx(), {
            sessionId: "session-1",
            storagePolicy: "optional",
            items,
        });

        expect(retry).toMatchObject({ ok: true, didWrite: false, firstSeq: 8, lastSeq: 9 });
        expect(sessionUpdate).not.toHaveBeenCalled();
        expect(sessionMessageCreate).not.toHaveBeenCalled();
    }, 60_000);

    it("admits compatibility history only with hosted authority and rejects it before allocation in finite storage", async () => {
        const writer = await import("./sessionTranscriptWrite");
        const params = {
            sessionId: "session-1",
            writeAuthority: "hosted" as const,
            storagePolicy: "optional" as const,
            items: [{
                localId: "history:host-compatibility",
                sidechainId: null,
                messageRole: "agent" as const,
                content: { t: "plain" as const, v: { role: "agent", text: "hosted history" } },
            }],
        };

        await expect(writer.writeHistoricalSessionMessageBatchInTx(createTx(), params)).resolves.toEqual({
            ok: false,
            error: "storage-mode-conflict",
            code: "session_storage_authority_mismatch",
        });
        expect(sessionUpdate).not.toHaveBeenCalled();
        expect(sessionMessageCreate).not.toHaveBeenCalled();

        sessionFindUnique.mockResolvedValue({
            encryptionMode: "plain",
            currentStorageState: "hosted",
        });
        await expect(writer.writeHistoricalSessionMessageBatchInTx(createTx(), params))
            .resolves.toMatchObject({ ok: true, didWrite: true, firstSeq: 8, lastSeq: 8 });
        expect(sessionUpdate).toHaveBeenCalledTimes(1);
        expect(sessionMessageCreate).toHaveBeenCalledTimes(1);
    }, 60_000);

    it("persists historical observation provenance as part of the stable import identity", async () => {
        const writer = await import("./sessionTranscriptWrite");
        const provenance = { kind: "non_dependent" as const, source: "history" as const };
        const item = {
            localId: "history:source-fact",
            sidechainId: null,
            messageRole: "user" as const,
            content: { t: "plain" as const, v: { role: "user", text: "historical source fact" } },
            transcriptObservationProvenance: provenance,
        };
        sessionMessageCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
            id: "message-history-source-fact",
            sessionId: "session-1",
            seq: data.seq,
            localId: data.localId,
            sidechainId: data.sidechainId,
            messageRole: data.messageRole,
            content: data.content,
            sourceCreatedAt: null,
            sourceUpdatedAt: null,
            transcriptObservationProvenance: data.transcriptObservationProvenance ?? null,
            deliveryResolution: null,
            createdAt: data.createdAt,
            updatedAt: data.createdAt,
        }));

        const first = await writer.writeHistoricalSessionMessageBatchInTx(createTx(), {
            sessionId: "session-1",
            storagePolicy: "optional",
            items: [item],
        });

        expect(first).toMatchObject({ ok: true, didWrite: true });
        expect(sessionMessageCreate).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ transcriptObservationProvenance: provenance }),
        }));

        vi.clearAllMocks();
        sessionMessageFindMany.mockResolvedValue(first.ok ? first.messages : []);
        const changedProvenance = await writer.writeHistoricalSessionMessageBatchInTx(createTx(), {
            sessionId: "session-1",
            storagePolicy: "optional",
            items: [{ ...item, transcriptObservationProvenance: { kind: "non_dependent", source: "external" } }],
        });

        expect(changedProvenance).toEqual({
            ok: false,
            error: "stable-item-conflict",
            localId: "history:source-fact",
        });
        expect(sessionUpdate).not.toHaveBeenCalled();
        expect(sessionMessageCreate).not.toHaveBeenCalled();
    }, 60_000);

    it("rejects a changed stable item before allocating another sequence", async () => {
        const service = await import("./sessionWriteService");
        const writeHistoricalSessionMessageBatchInTx = Reflect.get(service, "writeHistoricalSessionMessageBatchInTx") as
            | ((tx: Tx, params: unknown) => Promise<any>)
            | undefined;
        expect(writeHistoricalSessionMessageBatchInTx).toBeTypeOf("function");

        sessionMessageFindMany.mockResolvedValue([{
            id: "stored",
            sessionId: "session-1",
            seq: 7,
            localId: "history:item-1",
            sidechainId: null,
            messageRole: "user",
            content: { t: "plain", v: { role: "user", text: "original" } },
            sourceCreatedAt: null,
            sourceUpdatedAt: null,
            transcriptObservationProvenance: null,
            deliveryResolution: null,
            createdAt: new Date(1_000),
            updatedAt: new Date(1_000),
        }]);

        const result = await writeHistoricalSessionMessageBatchInTx!(createTx(), {
            sessionId: "session-1",
            storagePolicy: "optional",
            items: [{
                localId: "history:item-1",
                sidechainId: null,
                messageRole: "user",
                content: { t: "plain", v: { role: "user", text: "changed" } },
            }],
        });

        expect(result).toEqual({ ok: false, error: "stable-item-conflict", localId: "history:item-1" });
        expect(sessionUpdate).not.toHaveBeenCalled();
        expect(sessionMessageCreate).not.toHaveBeenCalled();
    }, 60_000);

    it("retries the whole historical transaction when an identical writer wins the local-id race", async () => {
        const service = await import("./sessionWriteService");
        const writeHistoricalSessionMessageBatch = Reflect.get(service, "writeHistoricalSessionMessageBatch") as
            | ((params: unknown) => Promise<any>)
            | undefined;
        expect(writeHistoricalSessionMessageBatch).toBeTypeOf("function");

        const winner = {
            id: "winner",
            sessionId: "session-1",
            seq: 8,
            localId: "history:item-1",
            sidechainId: null,
            messageRole: "user",
            content: { t: "plain", v: { role: "user", text: "hello" } },
            sourceCreatedAt: null,
            sourceUpdatedAt: null,
            transcriptObservationProvenance: null,
            deliveryResolution: null,
            createdAt: new Date(1_000),
            updatedAt: new Date(1_000),
        };
        sessionMessageFindMany
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([winner]);
        sessionMessageCreate.mockRejectedValueOnce(Object.assign(new Error("duplicate"), { code: "P2002" }));

        const result = await writeHistoricalSessionMessageBatch!({
            sessionId: "session-1",
            storagePolicy: "optional",
            items: [{
                localId: "history:item-1",
                sidechainId: null,
                messageRole: "user",
                content: { t: "plain", v: { role: "user", text: "hello" } },
            }],
        });

        expect(result).toMatchObject({ ok: true, didWrite: false, firstSeq: 8, lastSeq: 8 });
        expect(inTx).toHaveBeenCalledTimes(2);
    }, 60_000);
});
