import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

/** A separate Prisma process holds SQLite's real cross-process writer lock. */
export async function holdSqliteWriteLock(): Promise<Readonly<{ release: () => Promise<void> }>> {
    const clientPath = fileURLToPath(new URL("../../generated/sqlite-client/index.js", import.meta.url));
    const child = spawn(process.execPath, ["--input-type=commonjs", "-e", `
        const { PrismaClient } = require(process.argv[1]);
        const client = new PrismaClient();
        (async () => {
            await client.$executeRawUnsafe("BEGIN IMMEDIATE;");
            process.send("locked");
            await new Promise(resolve => process.once("message", resolve));
            await client.$executeRawUnsafe("ROLLBACK;");
        })().catch(error => { console.error(error); process.exitCode = 1; })
          .finally(async () => { await client.$disconnect(); process.disconnect(); });
    `, clientPath], { env: process.env, stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let stderr = "";
    // stderr is always piped by the explicit stdio configuration above.
    child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const completed = once(child, "exit");
    try {
        const state = await Promise.race([
            once(child, "message").then(([message]) => message),
            completed.then(([code]) => { throw new Error(`SQLite lock child exited (${code}): ${stderr}`); }),
        ]);
        if (state !== "locked") throw new Error(`Unexpected SQLite lock child state: ${state}`);
    } catch (error) {
        if (child.exitCode === null) child.kill();
        await completed;
        throw error;
    }
    return {
        release: async () => {
            if (child.connected) child.send("release");
            const [code] = await completed;
            if (code !== 0) throw new Error(`SQLite lock child failed (${code}): ${stderr}`);
        },
    };
}
