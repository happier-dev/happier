import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createLightSqliteHarness } from "@/testkit/lightSqliteHarness";

describe("createLightSqliteHarness", () => {
    it("restores env and removes temp dir when initialization fails", async () => {
        const rootDir = await mkdtemp(join(tmpdir(), "happier-light-harness-root-"));
        const prefix = "happier-light-harness-fail-";
        const originalPath = process.env.PATH;
        const originalDbProvider = process.env.HAPPIER_DB_PROVIDER;
        const originalLightDataDir = process.env.HAPPIER_SERVER_LIGHT_DATA_DIR;

        const listHarnessDirs = async () => {
            const entries = await readdir(rootDir, { withFileTypes: true });
            return entries
                .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
                .map((entry) => entry.name)
                .sort();
        };

        const before = await listHarnessDirs();
        process.env.PATH = "";

        await expect(
            createLightSqliteHarness({
                tempDirPrefix: prefix,
                tempDirBase: rootDir,
                initAuth: false,
                initEncrypt: false,
                initFiles: false,
            }),
        ).rejects.toThrow(/prisma migrate deploy failed/i);

        process.env.PATH = originalPath;
        const after = await listHarnessDirs();

        expect(after).toEqual(before);
        expect(process.env.HAPPIER_DB_PROVIDER).toBe(originalDbProvider);
        expect(process.env.HAPPIER_SERVER_LIGHT_DATA_DIR).toBe(originalLightDataDir);

        await rm(rootDir, { recursive: true, force: true });
    });
});
