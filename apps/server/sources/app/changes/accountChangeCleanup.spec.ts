import { describe, expect, it, vi } from "vitest";

const accountChangeGroupBy = vi.fn();
const accountChangeDeleteMany = vi.fn();
const accountUpdateMany = vi.fn();

vi.mock("@/storage/db", () => ({
    db: {
        accountChange: {
            groupBy: (...args: any[]) => accountChangeGroupBy(...args),
            deleteMany: (...args: any[]) => accountChangeDeleteMany(...args),
        },
        account: {
            updateMany: (...args: any[]) => accountUpdateMany(...args),
        },
    },
}));

describe("pruneOrphanAccountChangesOnce", () => {
    it("prunes rows with missing FK targets and bumps changesFloor per affected account", async () => {
        accountChangeGroupBy
            // session + share (sessionId is null)
            .mockResolvedValueOnce([
                { accountId: "a1", _max: { cursor: 10 } },
                { accountId: "a2", _max: { cursor: 3 } },
            ])
            // machine (machineId is null)
            .mockResolvedValueOnce([{ accountId: "a1", _max: { cursor: 12 } }])
            // artifact (artifactId is null)
            .mockResolvedValueOnce([]);

        accountChangeDeleteMany
            .mockResolvedValueOnce({ count: 2 })
            .mockResolvedValueOnce({ count: 1 })
            .mockResolvedValueOnce({ count: 1 });

        const { pruneOrphanAccountChangesOnce } = await import("./accountChangeCleanup");
        const res = await pruneOrphanAccountChangesOnce();

        expect(accountChangeGroupBy).toHaveBeenCalledTimes(3);
        expect(accountChangeDeleteMany).toHaveBeenCalledTimes(3);

        // Session/share: per-account bounded delete
        expect(accountChangeDeleteMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    accountId: "a1",
                    cursor: { lte: 10 },
                    sessionId: null,
                }),
            }),
        );
        expect(accountChangeDeleteMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    accountId: "a2",
                    cursor: { lte: 3 },
                    sessionId: null,
                }),
            }),
        );

        // Machine: per-account bounded delete
        expect(accountChangeDeleteMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    accountId: "a1",
                    cursor: { lte: 12 },
                    machineId: null,
                }),
            }),
        );

        expect(accountUpdateMany).toHaveBeenCalledWith({
            where: { id: "a1", changesFloor: { lt: 12 } },
            data: { changesFloor: 12 },
        });
        expect(accountUpdateMany).toHaveBeenCalledWith({
            where: { id: "a2", changesFloor: { lt: 3 } },
            data: { changesFloor: 3 },
        });

        expect(res).toEqual({ deletedRows: 4, affectedAccounts: 2 });
    });
});
