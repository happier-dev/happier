import { afterAll, beforeAll, beforeEach, describe } from "vitest";

import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { transcriptObservationWriteCostContract } from "./transcriptObservationWriteCost.testkit";

describe("transcript observation write cost (SQLite)", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-transcript-write-cost-", sqliteConnectionLimit: 1,
            initAuth: true, initEncrypt: false, initFiles: false,
        });
    }, 120_000);
    beforeEach(() => harness.resetEnv());
    afterAll(async () => await harness.close());
    transcriptObservationWriteCostContract("sqlite");
});
