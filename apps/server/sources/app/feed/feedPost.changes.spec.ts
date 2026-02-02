import { describe, expect, it, vi } from "vitest";

const emitUpdate = vi.fn();
const buildNewFeedPostUpdate = vi.fn((_item: any, updSeq: number, updId: string) => ({
    id: updId,
    seq: updSeq,
    body: { t: "new-feed-post" },
}));

vi.mock("@/app/events/eventRouter", () => ({
    eventRouter: { emitUpdate },
    buildNewFeedPostUpdate,
}));

const randomKeyNaked = vi.fn(() => "upd-id");
vi.mock("@/utils/randomKeyNaked", () => ({ randomKeyNaked }));

const markAccountChanged = vi.fn(async () => 909);
vi.mock("@/app/changes/markAccountChanged", () => ({ markAccountChanged }));

vi.mock("@/storage/inTx", () => ({
    afterTx: (tx: any, callback: () => void | Promise<void>) => {
        tx.__afterTxCallbacks.push(callback);
    },
}));

describe("feedPost (AccountChange integration)", () => {
    it("marks feed change and emits update using returned cursor", async () => {
        const { feedPost } = await import("./feedPost");

        const tx: any = {
            __afterTxCallbacks: [] as Array<() => void | Promise<void>>,
            userFeedItem: {
                deleteMany: vi.fn(async () => ({})),
                create: vi.fn(async () => ({
                    id: "f1",
                    userId: "u1",
                    repeatKey: null,
                    body: { kind: "friend_request", uid: "u2" },
                    counter: BigInt(7),
                    createdAt: new Date(1),
                })),
            },
            account: {
                update: vi.fn(async () => ({ feedSeq: BigInt(7) })),
            },
        };

        const result = await feedPost(tx, { uid: "u1" } as any, { kind: "friend_request", uid: "u2" } as any, "rk");
        for (const cb of tx.__afterTxCallbacks) {
            await cb();
        }

        expect(markAccountChanged).toHaveBeenCalledWith(
            tx,
            expect.objectContaining({ accountId: "u1", kind: "feed", entityId: "self", hint: { cursor: result.cursor } }),
        );
        expect(buildNewFeedPostUpdate).toHaveBeenCalledWith(expect.anything(), 909, expect.any(String));
        expect(emitUpdate).toHaveBeenCalledTimes(1);
    });
});
