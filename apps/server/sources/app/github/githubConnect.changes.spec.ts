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

const markAccountChanged = vi.fn(async () => 222);
vi.mock("@/app/changes/markAccountChanged", () => ({ markAccountChanged }));

vi.mock("@/modules/encrypt", () => ({
    encryptString: () => "enc-token",
}));

const uploadImage = vi.fn(async () => ({ path: "avatars/x", width: 1, height: 1 }));
vi.mock("@/storage/uploadImage", () => ({ uploadImage }));

vi.mock("@/utils/separateName", () => ({
    separateName: () => ({ firstName: "Ada", lastName: "Lovelace" }),
}));

const githubDisconnect = vi.fn(async () => {});
vi.mock("./githubDisconnect", () => ({ githubDisconnect }));

const dbAccountFindFirstOrThrow = vi.fn();
const dbAccountFindFirst = vi.fn();

vi.mock("@/storage/db", () => ({
    db: {
        account: {
            findFirstOrThrow: (...args: any[]) => dbAccountFindFirstOrThrow(...args),
            findFirst: (...args: any[]) => dbAccountFindFirst(...args),
        },
    },
}));

let txGithubUserUpsert: any;
let txAccountUpdate: any;

vi.mock("@/storage/inTx", () => {
    const afterTx = (tx: any, callback: () => void) => {
        tx.__afterTxCallbacks.push(callback);
    };

    const inTx = async <T>(fn: (tx: any) => Promise<T>): Promise<T> => {
        const tx: any = {
            __afterTxCallbacks: [] as Array<() => void | Promise<void>>,
            githubUser: {
                upsert: (...args: any[]) => txGithubUserUpsert(...args),
            },
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

describe("githubConnect (AccountChange integration)", () => {
    it("marks account change and emits update using returned cursor", async () => {
        dbAccountFindFirstOrThrow.mockResolvedValue({ githubUserId: null, username: "u" });
        dbAccountFindFirst.mockResolvedValue(null);

        txGithubUserUpsert = vi.fn(async () => ({}));
        txAccountUpdate = vi.fn(async () => ({}));

        // minimal fetch mock
        (globalThis as any).fetch = vi.fn(async () => ({
            arrayBuffer: async () => new ArrayBuffer(4),
        }));

        const { githubConnect } = await import("./githubConnect");
        await githubConnect(
            { uid: "u1" } as any,
            {
                id: 123,
                login: "gh",
                name: "Ada Lovelace",
                avatar_url: "https://example.com/a.png",
            } as any,
            "token",
        );

        expect(githubDisconnect).not.toHaveBeenCalled();
        expect(markAccountChanged).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ accountId: "u1", kind: "account", entityId: "self", hint: { github: true } }),
        );
        expect(buildUpdateAccountUpdate).toHaveBeenCalledWith(
            "u1",
            expect.objectContaining({ username: "gh", firstName: "Ada", lastName: "Lovelace", github: expect.anything(), avatar: expect.anything() }),
            222,
            expect.any(String),
        );
        expect(emitUpdate).toHaveBeenCalledTimes(1);
    });
});
