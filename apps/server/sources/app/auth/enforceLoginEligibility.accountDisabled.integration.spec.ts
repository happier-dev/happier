import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

import { initDbSqlite, db } from "@/storage/db";
import { applyLightDefaultEnv, ensureHandyMasterSecret } from "@/flavors/light/env";
import { initEncrypt } from "@/modules/encrypt";
import { disableAccount } from "@/app/auth/accountDisable";
import { enforceLoginEligibility } from "@/app/auth/enforceLoginEligibility";
import { restoreEnv, snapshotEnv } from "@/app/api/testkit/env";
import * as privacyKit from "privacy-kit";

function runServerPrismaMigrateDeploySqlite(params: { cwd: string; env: NodeJS.ProcessEnv }): void {
    const res = spawnSync(
        "yarn",
        ["-s", "prisma", "migrate", "deploy", "--schema", "prisma/sqlite/schema.prisma"],
        {
            cwd: params.cwd,
            env: { ...(params.env as Record<string, string>), RUST_LOG: "info" },
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
        },
    );
    if (res.status !== 0) {
        const out = `${res.stdout ?? ""}\n${res.stderr ?? ""}`.trim();
        throw new Error(`prisma migrate deploy failed (status=${res.status}). ${out}`);
    }
}

describe("enforceLoginEligibility (account disabled)", () => {
    const envBackup = snapshotEnv();
    let baseDir: string;

    beforeAll(async () => {
        baseDir = await mkdtemp(join(tmpdir(), "happier-auth-eligibility-disabled-"));
        const dbPath = join(baseDir, "test.sqlite");

        Object.assign(process.env, {
            HAPPIER_DB_PROVIDER: "sqlite",
            HAPPY_DB_PROVIDER: "sqlite",
            DATABASE_URL: `file:${dbPath}`,
            HAPPY_SERVER_LIGHT_DATA_DIR: baseDir,
            HAPPIER_SERVER_LIGHT_DATA_DIR: baseDir,
            // Ensure no providers are required for eligibility (this is the case we want to cover).
            AUTH_REQUIRED_LOGIN_PROVIDERS: "",
        });

        applyLightDefaultEnv(process.env);
        await ensureHandyMasterSecret(process.env);
        await initEncrypt();

        runServerPrismaMigrateDeploySqlite({ cwd: join(__dirname, "../../.."), env: process.env });
        await initDbSqlite();
        await db.$connect();
    });

    afterAll(async () => {
        await db.$disconnect();
        restoreEnv(envBackup);
        await rm(baseDir, { recursive: true, force: true });
    });

    it("blocks a disabled account even when no providers are required", async () => {
        const publicKey = privacyKit.encodeHex(new Uint8Array(32).fill(8));
        const account = await db.account.create({ data: { publicKey }, select: { id: true } });

        await disableAccount({ accountId: account.id, reason: "test", env: process.env });

        const out = await enforceLoginEligibility({ accountId: account.id, env: process.env });
        expect(out).toEqual({ ok: false, statusCode: 403, error: "account-disabled" });
    });
});
