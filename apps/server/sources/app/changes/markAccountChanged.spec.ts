import { describe, expect, it, vi } from "vitest";

import { markAccountChanged } from "./markAccountChanged";

describe("markAccountChanged", () => {
    it("allocates a unique cursor and upserts the coalesced row", async () => {
        const tx: any = {
            account: {
                update: vi.fn().mockResolvedValue({ seq: 7 }),
            },
            accountChange: {
                upsert: vi.fn().mockResolvedValue({}),
            },
        };

        const cursor = await markAccountChanged(tx, {
            accountId: "a1",
            kind: "session",
            entityId: "s1",
            hint: { lastMessageSeq: 123 },
        });

        expect(cursor).toBe(7);

        expect(tx.account.update).toHaveBeenCalledWith({
            where: { id: "a1" },
            data: { seq: { increment: 1 } },
            select: { seq: true },
        });

        expect(tx.accountChange.upsert).toHaveBeenCalledWith({
            where: {
                accountId_kind_entityId: { accountId: "a1", kind: "session", entityId: "s1" },
            },
            create: {
                accountId: "a1",
                kind: "session",
                entityId: "s1",
                cursor: 7,
                changedAt: expect.any(Date),
                hint: { lastMessageSeq: 123 },
            },
            update: {
                cursor: 7,
                changedAt: expect.any(Date),
                hint: { lastMessageSeq: 123 },
            },
        });
    });

    it("throws on missing required params", async () => {
        const tx: any = {
            account: { update: vi.fn() },
            accountChange: { upsert: vi.fn() },
        };

        await expect(markAccountChanged(tx, { accountId: "", kind: "k" as any, entityId: "e" })).rejects.toThrow(/accountId/i);
        await expect(markAccountChanged(tx, { accountId: "a", kind: "" as any, entityId: "e" })).rejects.toThrow(/kind/i);
        await expect(markAccountChanged(tx, { accountId: "a", kind: "session", entityId: "" })).rejects.toThrow(/entityId/i);
    });
});
