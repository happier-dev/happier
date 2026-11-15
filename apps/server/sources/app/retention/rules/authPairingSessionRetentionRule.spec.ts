import { beforeEach, describe, expect, it } from "vitest";

import type { RetentionPolicy } from "@/app/retention/config/retentionPolicyTypes";
import { createDbMocks, installDbModuleMock } from "@/app/api/testkit/dbMocks";

const dbMocks = createDbMocks({
    authPairingSession: ["findMany", "deleteMany"],
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
            providerAccountUsageHistory: { mode: 'keep_forever' },
            voiceSessionLeases: keepForever,
            userFeedItems: keepForever,
            publicShareAccessLogs: keepForever,
            terminalAuthRequests: keepForever,
            accountAuthRequests: keepForever,
            authPairingSessions: keepForever,
            repeatKeys: keepForever,
            globalLocks: keepForever,
            automationRuns: keepForever,
            automationRunEvents: keepForever,
            homeAdministrationEvents: keepForever,
        },
    };
}

describe("createAuthPairingSessionRetentionRule", () => {
    beforeEach(() => {
        dbMocks.reset();
    });

    it("deletes a bounded expired batch even when historical retention is disabled", async () => {
        const now = new Date("2026-08-31T12:00:00.000Z");
        dbMocks.db.authPairingSession.findMany.mockResolvedValueOnce([
            { id: "expired-direct" },
            { id: "expired-assertion" },
        ] as never);
        dbMocks.db.authPairingSession.deleteMany.mockResolvedValueOnce({ count: 2 } as never);
        const { createAuthPairingSessionRetentionRule } = await import("./authPairingSessionRetentionRule");

        const result = await createAuthPairingSessionRetentionRule().run({
            policy: disabledKeepForeverPolicy(),
            batchSize: 10,
            dryRun: false,
            maxDeletesPerRulePerRun: 10,
            now,
        });

        expect(dbMocks.db.authPairingSession.findMany).toHaveBeenCalledWith({
            where: { expiresAt: { lte: now } },
            orderBy: { expiresAt: "asc" },
            take: 10,
            select: { id: true },
        });
        expect(dbMocks.db.authPairingSession.deleteMany).toHaveBeenCalledWith({
            where: {
                id: { in: ["expired-direct", "expired-assertion"] },
                expiresAt: { lte: now },
            },
        });
        expect(result).toEqual({
            id: "authPairingSessions",
            deleted: 2,
            candidatesExamined: 2,
            hasMore: false,
        });
    });
});
