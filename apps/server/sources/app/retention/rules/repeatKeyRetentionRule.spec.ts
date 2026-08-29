import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RetentionPolicy } from "@/app/retention/config/retentionPolicyTypes";
import { createDbMocks, installDbModuleMock } from "../../api/testkit/dbMocks";

const dbMocks = createDbMocks({
    repeatKey: ["findMany", "deleteMany"],
} as const);

installDbModuleMock({ db: dbMocks.db });

function disabledKeepForeverPolicy(): RetentionPolicy {
    const keepForever = { mode: "keep_forever" as const };
    return {
        enabled: false,
        intervalMs: 60_000,
        batchSize: 100,
        dryRun: false,
        maxDeletesPerRulePerRun: 100,
        domains: {
            sessions: keepForever,
            sessionSidechainMessages: keepForever,
            accountChanges: keepForever,
            usageEvents: keepForever,
            voiceSessionLeases: keepForever,
            userFeedItems: keepForever,
            sessionShareAccessLogs: keepForever,
            publicShareAccessLogs: keepForever,
            terminalAuthRequests: keepForever,
            accountAuthRequests: keepForever,
            authPairingSessions: keepForever,
            repeatKeys: keepForever,
            globalLocks: keepForever,
            automationRuns: keepForever,
            automationRunEvents: keepForever,
        },
    };
}

describe("createRepeatKeyRetentionRule", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("scans and rechecks intrinsic expiry when operator retention is disabled", async () => {
        const now = new Date("2026-08-29T12:00:00.000Z");
        dbMocks.db.repeatKey.findMany.mockResolvedValueOnce([
            { key: "expired-at-boundary" },
        ] as never);
        dbMocks.db.repeatKey.deleteMany.mockResolvedValueOnce({ count: 1 } as never);
        const { createRepeatKeyRetentionRule } = await import("./repeatKeyRetentionRule");

        const result = await createRepeatKeyRetentionRule().run({
            policy: disabledKeepForeverPolicy(),
            batchSize: 10,
            dryRun: false,
            maxDeletesPerRulePerRun: 10,
            now,
        });

        expect(dbMocks.db.repeatKey.findMany).toHaveBeenCalledWith({
            where: { expiresAt: { lte: now } },
            orderBy: { expiresAt: "asc" },
            take: 10,
            select: { key: true },
        });
        expect(dbMocks.db.repeatKey.deleteMany).toHaveBeenCalledWith({
            where: {
                key: { in: ["expired-at-boundary"] },
                expiresAt: { lte: now },
            },
        });
        expect(result).toEqual({
            id: "repeatKeys",
            deleted: 1,
            candidatesExamined: 1,
            hasMore: false,
        });
    });
});
