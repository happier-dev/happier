import { describe, expect, it, vi } from "vitest";
import {
    createInTxHarness,
    createSessionTransactionModel,
} from "../api/testkit/txHarness";

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
vi.mock("@/utils/keys/randomKeyNaked", () => ({ randomKeyNaked }));

const markAccountChanged = vi.fn(async (_tx: any, params: any) => {
    if (params.accountId === "owner") return 301;
    if (params.accountId === "u2") return 302;
    return 999;
});
vi.mock("@/app/changes/markAccountChanged", () => ({ markAccountChanged }));

vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));

vi.mock("@/storage/inTx", () => {
    const { inTx, afterTx } = createInTxHarness(() => {
        const { session } = createSessionTransactionModel({
            id: "s1",
            accountId: "owner",
            metadataLayoutVersion: 0,
            seq: 0,
            updatedAt: new Date("2026-07-01T00:00:00.000Z"),
            shares: [{ sharedWithUserId: "u2" }],
        });
        return {
            session,
            sessionMessage: { deleteMany: vi.fn(async () => ({ count: 0 })) },
            usageReport: { deleteMany: vi.fn(async () => ({ count: 0 })) },
            accessKey: { deleteMany: vi.fn(async () => ({ count: 0 })) },
        };
    });

    return { afterTx, inTx };
});

describe("sessionDelete (AccountChange integration)", () => {
    it("marks session change for owner and recipients and emits delete-session updates using those cursors", async () => {
        const { sessionDelete } = await import("./sessionDelete");

        const result = await sessionDelete(
            { uid: "owner" } as any,
            "s1",
        );
        expect(result).toEqual({ ok: true });

        expect(markAccountChanged).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ accountId: "owner", kind: "session", entityId: "s1" }));
        expect(markAccountChanged).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ accountId: "u2", kind: "session", entityId: "s1" }));

        expect(buildDeleteSessionUpdate).toHaveBeenNthCalledWith(1, "s1", 301, "upd-owner");
        expect(buildDeleteSessionUpdate).toHaveBeenNthCalledWith(2, "s1", 302, "upd-u2");

        expect(emitUpdate).toHaveBeenCalledTimes(2);
        expect(emitUpdate).toHaveBeenCalledWith(expect.objectContaining({ userId: "owner" }));
        expect(emitUpdate).toHaveBeenCalledWith(expect.objectContaining({ userId: "u2" }));
    });
});
