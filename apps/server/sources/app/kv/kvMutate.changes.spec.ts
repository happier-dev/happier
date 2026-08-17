import { beforeEach, describe, expect, it, vi } from "vitest";

import { installDbModuleMock } from "../api/testkit/dbMocks";
import { createInTxHarness } from "../api/testkit/txHarness";

const emitUpdate = vi.fn();
const buildKVBatchUpdateUpdate = vi.fn((_changes: any, updSeq: number, updId: string) => ({
    id: updId,
    seq: updSeq,
    body: { t: "kv-batch-update" },
}));

vi.mock("@/app/events/eventRouter", () => ({
    eventRouter: { emitUpdate },
    buildKVBatchUpdateUpdate,
}));

const randomKeyNaked = vi.fn(() => "upd-id");
vi.mock("@/utils/keys/randomKeyNaked", () => ({ randomKeyNaked }));

const markAccountChanged = vi.fn(async () => 888);
vi.mock("@/app/changes/markAccountChanged", () => ({ markAccountChanged }));

let txFindUnique: any;
let txCreate: any;
let txUpdate: any;
let txAccountFindUnique: any;
let txExecuteRawUnsafe: any;
let txQueryRawUnsafe: any;

vi.mock("@/storage/inTx", () => {
    const { inTx, afterTx } = createInTxHarness(() => ({
            $executeRawUnsafe: (...args: any[]) => txExecuteRawUnsafe(...args),
            $queryRawUnsafe: (...args: any[]) => txQueryRawUnsafe(...args),
            account: {
                findUnique: (...args: any[]) => txAccountFindUnique(...args),
            },
            userKVStore: {
                findUnique: (...args: any[]) => txFindUnique(...args),
                create: (...args: any[]) => txCreate(...args),
                update: (...args: any[]) => txUpdate(...args),
            },
    }));

    return { afterTx, inTx };
});

installDbModuleMock({ db: {} });

describe("kvMutate (AccountChange integration)", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        txFindUnique = vi.fn();
        txCreate = vi.fn();
        txUpdate = vi.fn();
        txAccountFindUnique = vi.fn(async () => ({
            encryptionMode: "plain",
            publicKey: null,
            contentPublicKey: null,
            contentPublicKeySig: null,
        }));
        txExecuteRawUnsafe = vi.fn(async () => 1);
        txQueryRawUnsafe = vi.fn(async () => [{ id: "u1" }]);
    });

    it("marks kv change with keys hint (<= 50) and emits update using returned cursor", async () => {
        txFindUnique.mockImplementation(async (args: any) => {
            const key = args?.where?.accountId_key?.key;
            if (key === "k2") {
                return { version: 0, value: Buffer.from("v") };
            }
            return null;
        });
        txCreate.mockImplementation(async (args: any) => ({ key: args.data.key, version: 0 }));
        txUpdate.mockImplementation(async (args: any) => ({ key: args.where.accountId_key.key, version: 1 }));

        const { kvMutate } = await import("./kvMutate");
        const result = await kvMutate(
            { uid: "u1" },
            [
                { key: "k1", value: "dmFsdWUx", version: -1 },
                { key: "k2", value: null, version: 0 },
            ],
        );

        expect(result.success).toBe(true);

        expect(markAccountChanged).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                accountId: "u1",
                kind: "kv",
                entityId: "self",
                hint: { keys: ["k1", "k2"] },
            }),
        );

        expect(buildKVBatchUpdateUpdate).toHaveBeenCalledWith(expect.any(Array), 888, expect.any(String));
        expect(emitUpdate).toHaveBeenCalledTimes(1);
        expect(emitUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: "u1",
                payload: expect.objectContaining({ seq: 888 }),
            }),
        );
    });

    it("marks kv change with full hint when too many keys (> 50)", async () => {
        txFindUnique.mockResolvedValue(null);
        txCreate.mockImplementation(async (args: any) => ({ key: args.data.key, version: 0 }));
        txUpdate.mockResolvedValue({ version: 1 });

        const { kvMutate } = await import("./kvMutate");
        const mutations = Array.from({ length: 51 }, (_, i) => ({
            key: `k${i}`,
            value: "dmFs",
            version: -1,
        }));

        const result = await kvMutate({ uid: "u1" }, mutations);
        expect(result.success).toBe(true);

        expect(markAccountChanged).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                accountId: "u1",
                kind: "kv",
                entityId: "self",
                hint: { full: true },
            }),
        );
    });

    it("acquires Account transition admission before reading a mode-bound Todo row", async () => {
        const marker = Buffer.from(JSON.stringify({
            t: "plain",
            v: { undoneOrder: [], completedOrder: [] },
        }), "utf8");
        txFindUnique.mockResolvedValue({ version: 1, value: marker });

        const { kvMutate } = await import("./kvMutate");
        const result = await kvMutate(
            { uid: "u1" },
            [{
                key: "todo.index",
                value: marker.toString("base64"),
                version: 0,
            }],
            { supportsCurrentProtocol: true },
        );

        expect(result).toEqual({
            success: false,
            errors: [{
                key: "todo.index",
                error: "version-mismatch",
                version: 1,
                value: marker.toString("base64"),
            }],
        });
        const admissionCallOrder = [
            ...txExecuteRawUnsafe.mock.invocationCallOrder,
            ...txQueryRawUnsafe.mock.invocationCallOrder,
        ];
        expect(admissionCallOrder).toHaveLength(1);
        expect(admissionCallOrder[0]).toBeLessThan(
            txFindUnique.mock.invocationCallOrder[0],
        );
    });

    it("fails closed without reading or tombstoning a Todo row when Account admission is unavailable", async () => {
        txAccountFindUnique.mockResolvedValue({
            encryptionMode: "e2ee",
            publicKey: null,
            contentPublicKey: null,
            contentPublicKeySig: null,
        });
        txCreate.mockResolvedValue({ key: "todo.index", version: 0 });
        const { TodoKvStoredContentModeMismatchError } = await import("./todoKvStoredContent");
        const { kvMutate } = await import("./kvMutate");

        await expect(kvMutate(
            { uid: "u1" },
            [{ key: "todo.index", value: null, version: -1 }],
            { supportsCurrentProtocol: true },
        )).rejects.toBeInstanceOf(TodoKvStoredContentModeMismatchError);

        expect(txFindUnique).not.toHaveBeenCalled();
        expect(txCreate).not.toHaveBeenCalled();
        expect(txUpdate).not.toHaveBeenCalled();
    });
});
