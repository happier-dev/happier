import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

function resolveBunExecutable(): string | null {
    const explicit = String(process.env.HAPPIER_TEST_BUN_EXECUTABLE ?? "").trim();
    if (explicit) return explicit;
    const result = spawnSync(process.platform === "win32" ? "where" : "which", ["bun"], { encoding: "utf8" });
    if (result.status !== 0) return null;
    return String(result.stdout ?? "").split(/\r?\n/u).map((line) => line.trim()).find(Boolean) ?? null;
}

const bunExecutable = resolveBunExecutable();
// Tokio worker threads are counted from /proc; the native-environment write itself is cross-platform.
const runtimeIt = bunExecutable && process.platform === "linux" ? it : it.skip;

describe("Prisma engine runtime under Bun (the shipped light server runtime)", () => {
    // Bun's process.env is JS-only: an assignment never reaches the native environment that
    // Prisma's engine reads when it starts its Tokio runtime, which then defaulted to one
    // worker per CPU (each worker growing its own allocator arena).
    runtimeIt("starts the engine's Tokio runtime with the worker budget the owner chose", async () => {
        const tempDir = await mkdtemp(join(tmpdir(), "happier-prisma-engine-bun-"));
        try {
            const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
            const ownerPath = fileURLToPath(new URL("./prisma.ts", import.meta.url));
            const probePath = join(tempDir, "probe.ts");
            const databaseUrl = `file:${join(tempDir, "probe.sqlite")}?connection_limit=1`;
            await writeFile(probePath, [
                `import { readdirSync, readFileSync } from "node:fs";`,
                `const { createDbMaintenanceClient } = await import(${JSON.stringify(ownerPath)});`,
                `const client = await createDbMaintenanceClient("sqlite", ${JSON.stringify(databaseUrl)});`,
                `await client.$queryRawUnsafe("SELECT 1");`,
                `const workers = readdirSync("/proc/self/task").filter((task) => readFileSync(\`/proc/self/task/\${task}/comm\`, "utf8").startsWith("tokio-runtime-w")).length;`,
                `await client.$disconnect();`,
                `console.log(JSON.stringify({ workers, budget: process.env.TOKIO_WORKER_THREADS }));`,
            ].join("\n"), "utf8");
            const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: databaseUrl, HAPPIER_DB_PROVIDER: "sqlite" };
            delete env.TOKIO_WORKER_THREADS;
            const { stdout } = await promisify(execFile)(bunExecutable!, ["--conditions=happier-source", probePath],
                { cwd: serverDir, env });
            const result = JSON.parse(stdout.trim().split(/\r?\n/u).at(-1) ?? "{}") as { workers?: number; budget?: string };
            // SQLite: one pooled connection plus the three side connections.
            expect(result.budget).toBe("4");
            // The runtime's blocking-pool thread carries the same name as its workers.
            expect(result.workers).toBeLessThanOrEqual(Number(result.budget) + 1);
        } finally {
            await rm(tempDir, { recursive: true, force: true });
        }
    }, 120_000);
});
