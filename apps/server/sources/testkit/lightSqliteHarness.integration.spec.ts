import { access, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { applyEnvValues, restoreEnvValues, snapshotEnvValues } from "@/testkit/env";
import { createLightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { db } from "@/storage/db";

describe("createLightSqliteHarness", () => {
    it("migrates isolated storage, resets its env baseline, and removes its database on close", async () => {
        const envBefore = snapshotEnvValues(["DATABASE_URL", "HAPPIER_LIGHT_HARNESS_SPEC_FLAG"]);
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
            await db.account.create({ data: { id: "harness-account", publicKey: "harness-key", seq: 7 } });
            await expect(db.account.findUnique({ where: { id: "harness-account" }, select: { seq: true } }))
                .resolves.toEqual({ seq: 7 });
            await expect(access(harness.dbPath)).resolves.toBeUndefined();
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
        expect(process.env.DATABASE_URL).toBe(envBefore.DATABASE_URL);
        expect(process.env.HAPPIER_LIGHT_HARNESS_SPEC_FLAG).toBe(envBefore.HAPPIER_LIGHT_HARNESS_SPEC_FLAG);
        await expect(access(harness.baseDir)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("restores env and removes temp dir when initialization fails", async () => {
        const rootDir = await mkdtemp(join(tmpdir(), "happier-light-harness-root-"));
        const prefix = "happier-light-harness-fail-";
        const envSnapshot = snapshotEnvValues(["PATH", "HAPPIER_DB_PROVIDER", "HAPPIER_SERVER_LIGHT_DATA_DIR", "HAPPIER_E2E_SERVER_LIGHT_TEMPLATE_CACHE_DIR"]);

        const listHarnessDirs = async () => {
            const entries = await readdir(rootDir, { withFileTypes: true });
            return entries
                .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
                .map((entry) => entry.name)
                .sort();
        };

        try {
            const before = await listHarnessDirs();
            // Failure recovery needs a cold migration, independent of templates
            // legitimately prepared by another integration file in this run.
            applyEnvValues({ PATH: "", HAPPIER_E2E_SERVER_LIGHT_TEMPLATE_CACHE_DIR: join(rootDir, "templates") });

            await expect(
                createLightSqliteHarness({
                    tempDirPrefix: prefix,
                    tempDirBase: rootDir,
                    initAuth: false,
                    initEncrypt: false,
                    initFiles: false,
                }),
            ).rejects.toThrow(/migration deploy failed/i);

            expect(await listHarnessDirs()).toEqual(before);
            expect(process.env.HAPPIER_DB_PROVIDER).toBe(envSnapshot.HAPPIER_DB_PROVIDER);
            expect(process.env.HAPPIER_SERVER_LIGHT_DATA_DIR).toBe(envSnapshot.HAPPIER_SERVER_LIGHT_DATA_DIR);
        } finally {
            restoreEnvValues(envSnapshot);
            await rm(rootDir, { recursive: true, force: true });
        }
    });
});
