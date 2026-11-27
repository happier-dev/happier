import { afterAll, afterEach, beforeAll, describe, it, vi } from "vitest";

import { db, initDbMysql, initDbPostgres, requireDbProviderFromEnv, shutdownDbClient } from "@/storage/db";
import { verifySparseSessionListing, verifySessionListExclusions } from "./sparseListing.test-support";
import { verifyFolderSessionListing } from "./folderListing.test-support";

describe("Filtered Session listing provider contract", () => {
    let connected = false;
    let provider: "postgres" | "mysql";

    beforeAll(async () => {
        if (!process.env.DATABASE_URL) throw new Error("The disposable DB-contract DATABASE_URL is required");
        const selected = requireDbProviderFromEnv(process.env, "postgres");
        if (selected === "mysql") await initDbMysql();
        else if (selected === "postgres") initDbPostgres();
        else throw new Error("This DB-contract lane requires postgres or mysql; SQLite has its own integration suite");
        provider = selected;
        await db.$connect();
        connected = true;
    });

    afterEach(() => vi.unstubAllEnvs());
    afterAll(async () => {
        if (connected) await shutdownDbClient();
    });

    it('excludes tags and applicable audiences before paging without widening access', verifySessionListExclusions);

    it("filters sparse audience, tags and personal attention before paging across overlapping grants", async () => {
        await verifySparseSessionListing(provider);
    }, 180_000);

    it("filters exact folder ANY and tag ANY together before stable cursor paging", async () => {
        await verifyFolderSessionListing();
    });
});
