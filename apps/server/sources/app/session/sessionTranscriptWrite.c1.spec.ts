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
        sessionFindUnique.mockResolvedValue({ encryptionMode: "plain" });
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
