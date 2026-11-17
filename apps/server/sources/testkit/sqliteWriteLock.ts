import { spawn } from "node:child_process";
import { once } from "node:events";

import { parseSqliteDatabaseUrl } from "@/storage/sqliteDriverAdapter";

/** A separate process holds SQLite's real cross-process writer lock on the DATABASE_URL file. */
export async function holdSqliteWriteLock(): Promise<Readonly<{ release: () => Promise<void> }>> {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error("DATABASE_URL is required to hold the SQLite write lock.");
    const { path } = parseSqliteDatabaseUrl(databaseUrl);
    const child = spawn(process.execPath, ["--input-type=commonjs", "-e", `
        const { DatabaseSync } = require("node:sqlite");
        const database = new DatabaseSync(process.argv[1]);
        (async () => {
            database.exec("BEGIN IMMEDIATE;");
            process.send("locked");
            await new Promise(resolve => process.once("message", resolve));
            database.exec("ROLLBACK;");
        })().catch(error => { console.error(error); process.exitCode = 1; })
          .finally(() => { database.close(); process.disconnect(); });
    `, path], { env: process.env, stdio: ["ignore", "ignore", "pipe", "ipc"] });
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
