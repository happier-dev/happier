import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

function resolveYarnCommand(): string {
    return process.platform === "win32" ? "yarn.cmd" : "yarn";
}

describe("migrate:light:deploy (db contract)", () => {
    it("applies the full Prisma migration chain deterministically on a fresh embedded pglite DB", async () => {
        // Vitest runs this suite from the server workspace root (`apps/server`).
        // Using `import.meta.url` here is brittle under Vite transforms.
        const serverRoot = process.cwd();
        const dataDir = await mkdtemp(join(tmpdir(), "happier-migrate-light-"));
        try {
            const env: NodeJS.ProcessEnv = {
                ...process.env,
                // Ensure the script uses an isolated directory (never the developer's real one).
                HAPPY_SERVER_LIGHT_DATA_DIR: dataDir,
                HAPPIER_SERVER_LIGHT_DATA_DIR: dataDir,
            };

            const res = spawnSync(resolveYarnCommand(), ["-s", "run", "migrate:light:deploy"], {
                cwd: serverRoot,
                env: env as Record<string, string>,
                encoding: "utf8",
                stdio: ["ignore", "pipe", "pipe"],
            });

            if (res.status !== 0) {
                const out = `${res.stdout ?? ""}\n${res.stderr ?? ""}`.trim();
                throw new Error(`migrate:light:deploy failed (status=${res.status}). ${out}`.trim());
            }

            expect(res.status).toBe(0);
        } finally {
            await rm(dataDir, { recursive: true, force: true });
        }
    });
});
