import { describe, expect, it, vi } from "vitest";

const emitUpdate = vi.fn();
const buildDeleteSessionUpdate = vi.fn((_sid: string, updSeq: number, updId: string) => ({
    id: updId,
    seq: updSeq,
    body: { t: "delete-session", sid: _sid },
}));

vi.mock("@/app/events/eventRouter", () => ({
    eventRouter: { emitUpdate },
    buildDeleteSessionUpdate,
}));

const randomKeyNaked = vi.fn()
    .mockReturnValueOnce("upd-owner")
    .mockReturnValueOnce("upd-u2");
vi.mock("@/utils/randomKeyNaked", () => ({ randomKeyNaked }));

const markAccountChanged = vi.fn(async (_tx: any, params: any) => {
    if (params.accountId === "owner") return 301;
    if (params.accountId === "u2") return 302;
    return 999;
});
vi.mock("@/app/changes/markAccountChanged", () => ({ markAccountChanged }));

vi.mock("@/utils/log", () => ({ log: vi.fn() }));

vi.mock("@/storage/inTx", () => {
    const afterTx = (tx: any, callback: () => void) => {
        tx.__afterTxCallbacks.push(callback);
    };

    const inTx = async <T>(fn: (tx: any) => Promise<T>): Promise<T> => {
        const tx: any = {
            __afterTxCallbacks: [] as Array<() => void | Promise<void>>,
            session: {
                findFirst: vi.fn(async () => ({
                    id: "s1",
                    shares: [{ sharedWithUserId: "u2" }],
                })),
                delete: vi.fn(async () => ({})),
            },
            sessionMessage: { deleteMany: vi.fn(async () => ({ count: 0 })) },
            usageReport: { deleteMany: vi.fn(async () => ({ count: 0 })) },
            accessKey: { deleteMany: vi.fn(async () => ({ count: 0 })) },
        };

        const result = await fn(tx);
        for (const cb of tx.__afterTxCallbacks) {
            await cb();
        }
        return result;
    };

    return { afterTx, inTx };
});

describe("sessionDelete (AccountChange integration)", () => {
    it("marks session change for owner and recipients and emits delete-session updates using those cursors", async () => {
        const { sessionDelete } = await import("./sessionDelete");

        const ok = await sessionDelete({ uid: "owner" } as any, "s1");
        expect(ok).toBe(true);

        expect(markAccountChanged).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ accountId: "owner", kind: "session", entityId: "s1" }));
        expect(markAccountChanged).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ accountId: "u2", kind: "session", entityId: "s1" }));

        expect(buildDeleteSessionUpdate).toHaveBeenNthCalledWith(1, "s1", 301, "upd-owner");
        expect(buildDeleteSessionUpdate).toHaveBeenNthCalledWith(2, "s1", 302, "upd-u2");

        expect(emitUpdate).toHaveBeenCalledTimes(2);
        expect(emitUpdate).toHaveBeenCalledWith(expect.objectContaining({ userId: "owner" }));
        expect(emitUpdate).toHaveBeenCalledWith(expect.objectContaining({ userId: "u2" }));
    });
});

