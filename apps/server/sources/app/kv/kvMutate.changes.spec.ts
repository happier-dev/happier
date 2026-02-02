import { beforeEach, describe, expect, it, vi } from "vitest";

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
vi.mock("@/utils/randomKeyNaked", () => ({ randomKeyNaked }));

const markAccountChanged = vi.fn(async () => 888);
vi.mock("@/app/changes/markAccountChanged", () => ({ markAccountChanged }));

let txFindUnique: any;
let txCreate: any;
let txUpdate: any;

vi.mock("@/storage/inTx", () => {
    const afterTx = (tx: any, callback: () => void) => {
        tx.__afterTxCallbacks.push(callback);
    };

    const inTx = async <T>(fn: (tx: any) => Promise<T>): Promise<T> => {
        const tx: any = {
            __afterTxCallbacks: [] as Array<() => void | Promise<void>>,
            userKVStore: {
                findUnique: (...args: any[]) => txFindUnique(...args),
                create: (...args: any[]) => txCreate(...args),
                update: (...args: any[]) => txUpdate(...args),
            },
        };

        const result = await fn(tx);
        for (const cb of tx.__afterTxCallbacks) {
            await cb();
        }
        return result;
    };

    return { afterTx, inTx };
});

vi.mock("@/storage/db", () => ({ db: {} }));

describe("kvMutate (AccountChange integration)", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        txFindUnique = vi.fn();
        txCreate = vi.fn();
        txUpdate = vi.fn();
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
});

