import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import {
    proveSessionLifecycleRegistrationSettlementRace,
    proveSessionLifecycleSettlementBeforeRegistration,
} from "./sessionLifecycleRegistrationSettlementRace.testkit";

describe("Session lifecycle registration/settlement race on SQLite", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-session-lifecycle-race-",
            sqliteConnectionLimit: 2,
            initAuth: false,
            initEncrypt: false,
            initFiles: false,
        });
    }, 120_000);
    afterAll(async () => await harness.close());
    it("cannot commit a trigger after completion without its Run", async () => {
        const evidence = await proveSessionLifecycleRegistrationSettlementRace();
        expect(evidence.settlement).toBe("committed");
        expect(evidence.settlementEnteredBeforeRegistrationRelease).toBe(false);
        expect([
            { registration: "committed", triggerCount: 1, runCount: 1 },
            { registration: "rejected_after_settlement", triggerCount: 0, runCount: 0 },
        ]).toContainEqual({
            registration: evidence.registration,
            triggerCount: evidence.triggerCount,
            runCount: evidence.runCount,
        });
    });
    it("rejects registration after completion commits instead of backfilling", async () => {
        await expect(proveSessionLifecycleSettlementBeforeRegistration()).resolves.toMatchObject({
            registration: "rejected_after_settlement",
            settlement: "committed",
            triggerCount: 0,
            runCount: 0,
        });
    });
});
