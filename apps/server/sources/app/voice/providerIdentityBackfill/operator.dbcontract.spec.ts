import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { db, initDbPglite, shutdownDbPglite } from "@/storage/db";

function runYarn(args: readonly string[], env: NodeJS.ProcessEnv) {
    return spawnSync(process.platform === "win32" ? "yarn.cmd" : "yarn", args, {
        cwd: process.cwd(),
        env: env as Record<string, string>,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    });
}

describe("voice provider identity backfill operator (pglite db contract)", () => {
    let initialized = false;

    afterEach(async () => {
        if (!initialized) return;
        await shutdownDbPglite();
        initialized = false;
    });

    it("runs the deployed command to zero and verifies two stable observations", async () => {
        const dataDir = await mkdtemp(join(tmpdir(), "happier-voice-backfill-operator-"));
        const envKeys = [
            "DATABASE_URL",
            "HAPPIER_SERVER_FLAVOR",
            "HAPPIER_DB_PROVIDER",
            "HAPPIER_SERVER_LIGHT_DATA_DIR",
            "HAPPY_SERVER_LIGHT_DATA_DIR",
        ] as const;
        const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
        const env: NodeJS.ProcessEnv = {
            ...process.env,
            HAPPIER_SERVER_FLAVOR: "light",
            HAPPIER_DB_PROVIDER: "pglite",
            HAPPIER_SERVER_LIGHT_DATA_DIR: dataDir,
            HAPPY_SERVER_LIGHT_DATA_DIR: dataDir,
        };
        try {
            const migration = runYarn(["-s", "migrate:light:deploy"], env);
            expect(migration.status, `${migration.stdout}\n${migration.stderr}`).toBe(0);

            Object.assign(process.env, env);
            await initDbPglite();
            initialized = true;
            const account = await db.account.create({
                data: { publicKey: "pk-pglite-voice-backfill-operator" },
                select: { id: true },
            });
            const lease = await db.voiceSessionLease.create({
                data: {
                    accountId: account.id,
                    sessionId: null,
                    periodKey: "2026-07",
                    grantedBy: "subscription",
                    elevenLabsAgentId: "agent_dev",
                    providerId: "elevenlabs_agents",
                    providerConversationId: "conv_pglite_operator",
                    providerConversationKey: null,
                    providerBindingNonce: "nonce_pglite_operator",
                    expiresAt: new Date(Date.now() + 60_000),
                },
                select: { id: true },
            });
            await db.voiceConversation.create({
                data: {
                    accountId: account.id,
                    leaseId: lease.id,
                    providerId: "elevenlabs_agents",
                    providerConversationId: "conv_pglite_operator",
                    providerConversationKey: null,
                    durationSeconds: 1,
                },
            });
            await shutdownDbPglite();
            initialized = false;

            const verifyBeforeRun = runYarn([
                "-s",
                "voice:identity-backfill:verify",
                "--stability-ms=1000",
            ], env);
            expect(verifyBeforeRun.status, `${verifyBeforeRun.stdout}\n${verifyBeforeRun.stderr}`).toBe(2);
            expect(verifyBeforeRun.stdout).toContain('"outcome":"nonzero"');
            expect(verifyBeforeRun.stdout).toContain('"phaseBReady":false');

            const run = runYarn([
                "-s",
                "voice:identity-backfill",
                "--batch-size=1",
                "--time-budget-ms=5000",
                "--batch-delay-ms=0",
            ], env);
            expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
            expect(run.stdout).toContain('"outcome":"completed"');

            const verify = runYarn([
                "-s",
                "voice:identity-backfill:verify",
                "--stability-ms=1000",
            ], env);
            expect(verify.status, `${verify.stdout}\n${verify.stderr}`).toBe(0);
            expect(verify.stdout).toContain('"outcome":"verified_zero"');
            expect(verify.stdout).toContain('"stableZero":true');
            expect(verify.stdout).toContain('"phaseBReady":true');
            expect(verify.stdout).toContain('"stabilityMs":1000');
        } finally {
            if (initialized) {
                await shutdownDbPglite();
                initialized = false;
            }
            for (const key of envKeys) {
                const value = originalEnv[key];
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
            await rm(dataDir, { recursive: true, force: true });
        }
    }, 120_000);
});
