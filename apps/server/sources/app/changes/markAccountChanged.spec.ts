import { afterEach, describe, expect, it, vi } from "vitest";

import { installDbModuleMock } from "../api/testkit/dbMocks";
import { eventRouter } from "../events/eventRouter";

const transaction = vi.fn();
installDbModuleMock(() => ({
    db: {
        $transaction: transaction,
    },
}));

type MarkAccountChangedParams = Parameters<typeof import("./markAccountChanged").markAccountChanged>[1];

async function runMarkAccountChanged(tx: object, params: MarkAccountChangedParams): Promise<number> {
    transaction.mockImplementationOnce(async (fn: (transactionTx: object) => Promise<number>) => await fn(tx));
    const [{ inTx }, { markAccountChanged }] = await Promise.all([
        import("@/storage/inTx"),
        import("./markAccountChanged"),
    ]);
    return await inTx(async (transactionTx) => await markAccountChanged(transactionTx, params));
}

describe("markAccountChanged", () => {
    const originalDbProvider = process.env.HAPPIER_DB_PROVIDER;

    afterEach(() => {
        process.env.HAPPIER_DB_PROVIDER = originalDbProvider;
        eventRouter.clearIo();
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

        eventRouter.setIo({ to: vi.fn(() => ({ emit: vi.fn() })) } as any);
        const cursor = await runMarkAccountChanged(tx, {
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

        eventRouter.setIo({ to: vi.fn(() => ({ emit: vi.fn() })) } as any);
        const cursor = await runMarkAccountChanged(tx, {
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

    it("keeps a retained full Collection reread broad in the Prisma fallback", async () => {
        process.env.HAPPIER_DB_PROVIDER = "sqlite";
        const existingHint = {
            pluginDomain: "dataCollection",
            pluginId: "example.tasks",
            collectionId: "tasks",
            contractDigest: "a".repeat(43),
            revision: 4,
            full: true,
        };
        const tx: any = {
            account: {
                update: vi.fn().mockResolvedValue({ seq: 7 }),
            },
            accountChange: {
                findUnique: vi.fn().mockResolvedValue({ hint: existingHint }),
                upsert: vi.fn().mockResolvedValue({}),
            },
        };

        await expect(runMarkAccountChanged(tx, {
            accountId: "a1",
            kind: "pluginDomain",
            entityId: "pluginDomain/example.tasks/data-collection/tasks",
            hint: {
                pluginDomain: "dataCollection",
                pluginId: "example.tasks",
                collectionId: "tasks",
                contractDigest: "b".repeat(43),
                revision: 5,
                rowIds: ["task-1"],
            },
        })).resolves.toBe(7);

        expect(tx.accountChange.findUnique).toHaveBeenCalledWith({
            where: {
                accountId_kind_entityId: {
                    accountId: "a1",
                    kind: "pluginDomain",
                    entityId: "pluginDomain/example.tasks/data-collection/tasks",
                },
            },
            select: { hint: true },
        });
        expect(tx.accountChange.upsert).toHaveBeenCalledWith(expect.objectContaining({
            create: expect.objectContaining({
                hint: {
                    pluginDomain: "dataCollection",
                    pluginId: "example.tasks",
                    collectionId: "tasks",
                    contractDigest: "b".repeat(43),
                    revision: 5,
                    full: true,
                },
            }),
            update: expect.objectContaining({
                hint: {
                    pluginDomain: "dataCollection",
                    pluginId: "example.tasks",
                    collectionId: "tasks",
                    contractDigest: "b".repeat(43),
                    revision: 5,
                    full: true,
                },
            }),
        }));
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

        eventRouter.setIo({ to: vi.fn(() => ({ emit: vi.fn() })) } as any);
        const cursor = await runMarkAccountChanged(tx, {
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

        await expect(runMarkAccountChanged(tx, { accountId: "", kind: "k" as any, entityId: "e" })).rejects.toThrow(/accountId/i);
        await expect(runMarkAccountChanged(tx, { accountId: "a", kind: "" as any, entityId: "e" })).rejects.toThrow(/kind/i);
        await expect(runMarkAccountChanged(tx, { accountId: "a", kind: "session", entityId: "" })).rejects.toThrow(/entityId/i);
    });

    it("rejects malformed or mismatched pluginDomain facts before allocating a cursor", async () => {
        process.env.HAPPIER_DB_PROVIDER = "sqlite";
        const tx: any = {
            account: {
                update: vi.fn().mockResolvedValue({ seq: 9 }),
            },
            accountChange: {
                upsert: vi.fn().mockResolvedValue({}),
            },
        };

        await expect(runMarkAccountChanged(tx, {
            accountId: "a1",
            kind: "pluginDomain",
            entityId: "pluginDomain/example.tasks/settings",
            hint: {
                pluginDomain: "dataCollection",
                pluginId: "example.tasks",
                collectionId: "tasks",
                contractDigest: "a".repeat(43),
                revision: 1,
                full: true,
            },
        })).rejects.toThrow(/entityId/i);
        await expect(runMarkAccountChanged(tx, {
            accountId: "a1",
            kind: "pluginDomain",
            entityId: "pluginDomain/example.tasks/availability",
            hint: {
                pluginDomain: "availability",
                pluginId: "example.tasks",
                status: "ready",
            },
        })).rejects.toThrow(/pluginDomain/i);

        expect(tx.account.update).not.toHaveBeenCalled();
        expect(tx.accountChange.upsert).not.toHaveBeenCalled();
    });
});
