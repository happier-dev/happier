import { afterEach, describe, expect, it } from "vitest";

import { createEnvPatcher, createEnvReset, restoreEnv, snapshotEnv } from "./env";

describe("testkit/env", () => {
    const envSnapshot = snapshotEnv();

    afterEach(() => {
        restoreEnv(envSnapshot);
    });

    it("restores the full environment snapshot", () => {
        process.env.HAPPIER_TESTKIT_ENV_SPEC = "before";
        const snapshot = snapshotEnv();

        process.env.HAPPIER_TESTKIT_ENV_SPEC = "after";
        process.env.HAPPIER_TESTKIT_ENV_SPEC_EXTRA = "value";

        restoreEnv(snapshot);

        expect(process.env.HAPPIER_TESTKIT_ENV_SPEC).toBe("before");
        expect(process.env.HAPPIER_TESTKIT_ENV_SPEC_EXTRA).toBeUndefined();
    });

    it("patches and restores a scoped set of env keys", () => {
        delete process.env.HAPPIER_TESTKIT_SCOPED_ENV;
        process.env.HAPPIER_TESTKIT_SCOPED_KEEP = "keep";

        const env = createEnvPatcher([
            "HAPPIER_TESTKIT_SCOPED_ENV",
            "HAPPIER_TESTKIT_SCOPED_KEEP",
        ]);

        env.setMany({
            HAPPIER_TESTKIT_SCOPED_ENV: "patched",
            HAPPIER_TESTKIT_SCOPED_KEEP: undefined,
        });

        expect(process.env.HAPPIER_TESTKIT_SCOPED_ENV).toBe("patched");
        expect(process.env.HAPPIER_TESTKIT_SCOPED_KEEP).toBeUndefined();

        env.restore();

        expect(process.env.HAPPIER_TESTKIT_SCOPED_ENV).toBeUndefined();
        expect(process.env.HAPPIER_TESTKIT_SCOPED_KEEP).toBe("keep");
    });

    it("restores a captured env baseline before applying overrides", () => {
        delete process.env.HAPPIER_TESTKIT_RESET_SECOND;
        process.env.HAPPIER_TESTKIT_RESET_FIRST = "baseline";

        const resetEnv = createEnvReset();

        process.env.HAPPIER_TESTKIT_RESET_FIRST = "mutated";
        process.env.HAPPIER_TESTKIT_RESET_SECOND = "stale";

        resetEnv({
            HAPPIER_TESTKIT_RESET_SECOND: "fresh",
        });

        expect(process.env.HAPPIER_TESTKIT_RESET_FIRST).toBe("baseline");
        expect(process.env.HAPPIER_TESTKIT_RESET_SECOND).toBe("fresh");
    });
});
