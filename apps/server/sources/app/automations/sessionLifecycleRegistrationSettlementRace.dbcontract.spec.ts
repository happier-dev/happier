import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, initDbMysql, initDbPostgres } from "@/storage/db";
import {
    proveSessionLifecycleRegistrationSettlementRace,
    proveSessionLifecycleSettlementBeforeRegistration,
} from "./sessionLifecycleRegistrationSettlementRace.testkit";

function provider(): "postgres" | "mysql" {
    const value = String(process.env.HAPPIER_DB_PROVIDER ?? process.env.HAPPY_DB_PROVIDER ?? "postgres").toLowerCase();
    if (value === "postgres" || value === "postgresql") return "postgres";
    if (value === "mysql") return "mysql";
    throw new Error(`Unsupported contract provider: ${value}`);
}

describe("Session lifecycle registration/settlement database contract", () => {
    const current = provider();
    beforeAll(async () => {
        if (!process.env.DATABASE_URL) throw new Error("Missing DATABASE_URL");
        if (current === "mysql") await initDbMysql(); else initDbPostgres();
        await db.$connect();
    });
    afterAll(async () => await db.$disconnect());
    it(`forbids trigger-without-Run on ${current}`, async () => {
        const evidence = await proveSessionLifecycleRegistrationSettlementRace();
        expect(evidence.settlement).toBe("committed");
        expect([
            { registration: "committed", triggerCount: 1, runCount: 1 },
            { registration: "rejected_after_settlement", triggerCount: 0, runCount: 0 },
        ]).toContainEqual({
            registration: evidence.registration,
            triggerCount: evidence.triggerCount,
            runCount: evidence.runCount,
        });
        expect(evidence.registrationAttempts).toBeGreaterThanOrEqual(1);
        expect(evidence.settlementAttempts).toBeGreaterThanOrEqual(1);
    });
    it(`rejects completion-first registration on ${current}`, async () => {
        await expect(proveSessionLifecycleSettlementBeforeRegistration()).resolves.toMatchObject({
            registration: "rejected_after_settlement",
            settlement: "committed",
            triggerCount: 0,
            runCount: 0,
        });
    });
});
