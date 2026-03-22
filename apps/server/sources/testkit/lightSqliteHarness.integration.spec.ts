import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { applyEnvValues, restoreEnvValues, snapshotEnvValues } from "@/testkit/env";
import { createLightSqliteHarness } from "@/testkit/lightSqliteHarness";

describe("createLightSqliteHarness", () => {
    it("resets env to the harness baseline before applying overrides", async () => {
        const harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-light-harness-env-",
            initAuth: false,
            initEncrypt: false,
            initFiles: false,
            env: {
                HAPPIER_LIGHT_HARNESS_SPEC_FLAG: "configured",
            },
        });

        try {
            expect(process.env.HAPPIER_LIGHT_HARNESS_SPEC_FLAG).toBe("configured");

            process.env.HAPPIER_LIGHT_HARNESS_SPEC_FLAG = "mutated";
            harness.resetEnv({
                HAPPIER_LIGHT_HARNESS_SECOND_SPEC_FLAG: "second-configured",
            });

            expect(process.env.HAPPIER_LIGHT_HARNESS_SPEC_FLAG).toBe("configured");
            expect(process.env.HAPPIER_LIGHT_HARNESS_SECOND_SPEC_FLAG).toBe("second-configured");
            expect(harness.envBase.HAPPIER_LIGHT_HARNESS_SPEC_FLAG).toBe("configured");
        } finally {
            await harness.close();
        }
    });

    it("restores env and removes temp dir when initialization fails", async () => {
        const rootDir = await mkdtemp(join(tmpdir(), "happier-light-harness-root-"));
        const prefix = "happier-light-harness-fail-";
        const envSnapshot = snapshotEnvValues(["PATH", "HAPPIER_DB_PROVIDER", "HAPPIER_SERVER_LIGHT_DATA_DIR"]);

        const listHarnessDirs = async () => {
            const entries = await readdir(rootDir, { withFileTypes: true });
            return entries
                .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
                .map((entry) => entry.name)
                .sort();
        };

        const before = await listHarnessDirs();
        applyEnvValues({ PATH: "" });

        await expect(
            createLightSqliteHarness({
                tempDirPrefix: prefix,
                tempDirBase: rootDir,
                initAuth: false,
                initEncrypt: false,
                initFiles: false,
            }),
        ).rejects.toThrow(/prisma migrate deploy failed/i);

        restoreEnvValues(envSnapshot);
        const after = await listHarnessDirs();

        expect(after).toEqual(before);
        expect(process.env.HAPPIER_DB_PROVIDER).toBe(envSnapshot.HAPPIER_DB_PROVIDER);
        expect(process.env.HAPPIER_SERVER_LIGHT_DATA_DIR).toBe(envSnapshot.HAPPIER_SERVER_LIGHT_DATA_DIR);

        await rm(rootDir, { recursive: true, force: true });
    });
});
