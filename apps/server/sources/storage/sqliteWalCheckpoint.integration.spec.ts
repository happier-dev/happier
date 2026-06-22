import { statSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { db } from "@/storage/db";
import { checkpointSqliteWal } from "@/storage/sqliteWalCheckpoint";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

function walSizeBytes(dbPath: string): number {
    try {
        return statSync(`${dbPath}-wal`).size;
    } catch {
        return 0;
    }
}

describe("storage/sqliteWalCheckpoint (integration)", () => {
    let harness: LightSqliteHarness | null = null;

    afterEach(async () => {
        if (harness) {
            await harness.close();
            harness = null;
        }
    });

    it("truncates the WAL file back to zero (prevents checkpoint starvation growth)", async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-wal-checkpoint-",
            initAuth: false,
            initEncrypt: false,
            initFiles: false,
        });

        // Grow the WAL with committed writes. Stay under the ~4MB default autocheckpoint
        // threshold so the WAL is non-empty when we checkpoint explicitly.
        await db.$executeRawUnsafe("CREATE TABLE IF NOT EXISTS _wal_probe (id INTEGER PRIMARY KEY, payload TEXT);");
        const payload = "x".repeat(1024);
        for (let i = 0; i < 500; i++) {
            await db.$executeRawUnsafe("INSERT INTO _wal_probe (payload) VALUES (?);", payload);
        }

        // The WAL file is allocated and non-empty before an explicit truncate checkpoint.
        // (Passive autocheckpoint may move frames into the db, but it never shrinks the
        // -wal file itself — only TRUNCATE/RESTART does, which is the behavior under test.)
        expect(walSizeBytes(harness.dbPath)).toBeGreaterThan(0);

        const result = await checkpointSqliteWal(db);

        expect(result.busy).toBe(0);
        expect(walSizeBytes(harness.dbPath)).toBe(0);
    });
});
