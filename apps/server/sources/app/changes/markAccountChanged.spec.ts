import { afterEach, describe, expect, it, vi } from "vitest";

import { markAccountChanged } from "./markAccountChanged";

describe("markAccountChanged", () => {
    const originalDbProvider = process.env.HAPPIER_DB_PROVIDER;

    afterEach(() => {
        process.env.HAPPIER_DB_PROVIDER = originalDbProvider;
    });

    it("uses the atomic postgres fast path when raw query execution is available", async () => {
        process.env.HAPPIER_DB_PROVIDER = "postgres";
        const tx: any = {
            $queryRawUnsafe: vi.fn().mockResolvedValue([{ cursor: 7 }]),
            account: {
                update: vi.fn(),
            },
            accountChange: {
                upsert: vi.fn(),
            },
        };

        const cursor = await markAccountChanged(tx, {
            accountId: "a1",
            kind: "session",
            entityId: "s1",
            hint: { lastMessageSeq: 123 },
        });

        expect(cursor).toBe(7);
        expect(tx.$queryRawUnsafe).toHaveBeenCalledTimes(1);
        expect(tx.account.update).not.toHaveBeenCalled();
        expect(tx.accountChange.upsert).not.toHaveBeenCalled();
    });

    it("falls back to the Prisma update + upsert path outside the postgres raw fast path", async () => {
        process.env.HAPPIER_DB_PROVIDER = "sqlite";
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
                sessionId: "s1",
                cursor: 7,
                changedAt: expect.any(Date),
                hint: { lastMessageSeq: 123 },
            },
            update: {
                sessionId: "s1",
                cursor: 7,
                changedAt: expect.any(Date),
                hint: { lastMessageSeq: 123 },
            },
        });
    });

    it("links pet changes to account pet packages in the Prisma fallback path", async () => {
        process.env.HAPPIER_DB_PROVIDER = "sqlite";
        const tx: any = {
            account: {
                update: vi.fn().mockResolvedValue({ seq: 8 }),
            },
            accountChange: {
                upsert: vi.fn().mockResolvedValue({}),
            },
        };

        const cursor = await markAccountChanged(tx, {
            accountId: "a1",
            kind: "pet",
            entityId: "pet-package-1",
        });

        expect(cursor).toBe(8);
        expect(tx.accountChange.upsert).toHaveBeenCalledWith({
            where: {
                accountId_kind_entityId: { accountId: "a1", kind: "pet", entityId: "pet-package-1" },
            },
            create: {
                accountId: "a1",
                kind: "pet",
                entityId: "pet-package-1",
                accountPetPackageId: "pet-package-1",
                cursor: 8,
                changedAt: expect.any(Date),
                hint: undefined,
            },
            update: {
                accountPetPackageId: "pet-package-1",
                cursor: 8,
                changedAt: expect.any(Date),
                hint: undefined,
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
