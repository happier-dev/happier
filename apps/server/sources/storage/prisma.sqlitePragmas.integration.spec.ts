import { afterEach, describe, expect, it } from "vitest";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

describe("storage/prisma sqlite pragmas", () => {
    let harness: LightSqliteHarness | null = null;

    afterEach(async () => {
        if (harness) {
            await harness.close();
            harness = null;
        }
    });

    it("configures WAL + busy_timeout for sqlite connections (stack stability)", async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-sqlite-pragmas-",
            initAuth: false,
            initEncrypt: false,
            initFiles: false,
        });

        const [{ journal_mode: journalMode }] = await db.$queryRawUnsafe<Array<{ journal_mode: string }>>(
            "SELECT journal_mode FROM pragma_journal_mode;",
        );
        const [{ synchronous }] = await db.$queryRawUnsafe<Array<{ synchronous: number | bigint }>>(
            "SELECT synchronous FROM pragma_synchronous;",
        );
        const [{ timeout }] = await db.$queryRawUnsafe<Array<{ timeout: number | bigint }>>(
            "SELECT timeout FROM pragma_busy_timeout;",
        );

        expect(journalMode.toLowerCase()).toBe("wal");
        expect(Number(synchronous)).toBe(1); // NORMAL
        expect(Number(timeout)).toBe(5000);
    });
});
