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

const markAccountChanged = vi.fn(async () => 333);
vi.mock("@/app/changes/markAccountChanged", () => ({ markAccountChanged }));

vi.mock("@/utils/log", () => ({ log: vi.fn() }));

const dbAccountFindUnique = vi.fn();
vi.mock("@/storage/db", () => ({
    db: {
        account: {
            findUnique: (...args: any[]) => dbAccountFindUnique(...args),
        },
    },
}));

let txAccountUpdate: any;
let txGithubUserDelete: any;

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
            githubUser: {
                delete: (...args: any[]) => txGithubUserDelete(...args),
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

describe("githubDisconnect (AccountChange integration)", () => {
    it("marks account change and emits update using returned cursor", async () => {
        dbAccountFindUnique.mockResolvedValue({ githubUserId: "123" });
        txAccountUpdate = vi.fn(async () => ({}));
        txGithubUserDelete = vi.fn(async () => ({}));

        const { githubDisconnect } = await import("./githubDisconnect");
        await githubDisconnect({ uid: "u1" } as any);

        expect(markAccountChanged).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ accountId: "u1", kind: "account", entityId: "self", hint: { github: false } }),
        );
        expect(buildUpdateAccountUpdate).toHaveBeenCalledWith("u1", { github: null, username: null }, 333, expect.any(String));
        expect(emitUpdate).toHaveBeenCalledTimes(1);
    });
});
