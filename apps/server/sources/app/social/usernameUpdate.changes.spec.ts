import { describe, expect, it, vi } from "vitest";

const emitUpdate = vi.fn();
const buildUpdateAccountUpdate = vi.fn((_userId: string, _profile: any, updSeq: number, updId: string) => ({
    id: updId,
    seq: updSeq,
    body: { t: "update-account" },
}));

vi.mock("@/app/events/eventRouter", () => ({
    eventRouter: { emitUpdate },
    buildUpdateAccountUpdate,
}));

const randomKeyNaked = vi.fn(() => "upd-id");
vi.mock("@/utils/randomKeyNaked", () => ({ randomKeyNaked }));

const markAccountChanged = vi.fn(async () => 777);
vi.mock("@/app/changes/markAccountChanged", () => ({ markAccountChanged }));

const dbAccountFindFirst = vi.fn();
vi.mock("@/storage/db", () => ({
    db: {
        account: {
            findFirst: (...args: any[]) => dbAccountFindFirst(...args),
        },
    },
}));

let txAccountUpdate: any;

vi.mock("@/storage/inTx", () => {
    const afterTx = (tx: any, callback: () => void) => {
        tx.__afterTxCallbacks.push(callback);
    };

    const inTx = async <T>(fn: (tx: any) => Promise<T>): Promise<T> => {
        const tx: any = {
            __afterTxCallbacks: [] as Array<() => void | Promise<void>>,
            account: {
                update: (...args: any[]) => txAccountUpdate(...args),
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

describe("usernameUpdate (AccountChange integration)", () => {
    it("marks account change and emits update using returned cursor", async () => {
        dbAccountFindFirst.mockResolvedValue(null);
        txAccountUpdate = vi.fn(async () => ({}));

        const { usernameUpdate } = await import("./usernameUpdate");
        await usernameUpdate({ uid: "u1" } as any, "newname");

        expect(markAccountChanged).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ accountId: "u1", kind: "account", entityId: "self", hint: { username: "newname" } }),
        );
        expect(buildUpdateAccountUpdate).toHaveBeenCalledWith("u1", { username: "newname" }, 777, expect.any(String));
        expect(emitUpdate).toHaveBeenCalledTimes(1);
    });
});
