import { beforeEach, describe, expect, it, vi } from "vitest";

import { createDbMocks, installDbModuleMock } from "@/app/api/testkit/dbMocks";

const dbMocks = createDbMocks({
    session: ["findMany"],
    sessionMessage: ["count"],
} as const);

installDbModuleMock({ db: dbMocks.db });
vi.mock("@/storage/inTx", () => ({
    inTx: async (fn: (tx: typeof dbMocks.db) => Promise<unknown>) => await fn(dbMocks.db),
}));

describe("loadUsageMessageStatsForQuery", () => {
    beforeEach(() => {
        dbMocks.reset();
    });

    it("counts only rows visible through each session publication ceiling", async () => {
        dbMocks.db.session.findMany.mockResolvedValue([
            {
                id: "hosted",
                currentStorageState: "hosted",
                acceptedThroughServerSeq: null,
                publishedThroughServerSeq: null,
            },
            {
                id: "partial",
                currentStorageState: "server_partial",
                acceptedThroughServerSeq: 4,
                publishedThroughServerSeq: null,
            },
        ]);
        dbMocks.db.sessionMessage.count.mockResolvedValue(9);
        const { loadUsageMessageStatsForQuery } = await import("./loadUsageMessageStatsForQuery");

        await expect(loadUsageMessageStatsForQuery(
            "account-1",
            {} as never,
            ["hosted", "partial"],
        )).resolves.toEqual({ messageCount: 9 });

        expect(dbMocks.db.sessionMessage.count).toHaveBeenCalledWith({
            where: {
                OR: [
                    { sessionId: { in: ["hosted"] } },
                    { sessionId: { in: ["partial"] }, seq: { lte: 4 } },
                ],
                createdAt: undefined,
                session: { accountId: "account-1" },
            },
        });
    });
});
