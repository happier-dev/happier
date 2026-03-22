import { afterEach, describe, expect, it, vi } from "vitest";

import { createStartServerDbMocks, installStartServerDbModuleMock } from "./startServerMocks";

describe("startServerMocks", () => {
    afterEach(() => {
        vi.doUnmock("@/storage/db");
        vi.resetModules();
    });

    it("resets canonical startServer db mock handles back to their default provider reader", async () => {
        const dbMocks = createStartServerDbMocks();

        dbMocks.getDbProviderFromEnv.mockImplementation(() => "mysql");
        dbMocks.initDbMysql.mockResolvedValue(undefined);

        expect(dbMocks.getDbProviderFromEnv({}, "sqlite")).toBe("mysql");

        dbMocks.reset();

        expect(dbMocks.getDbProviderFromEnv({}, "sqlite")).toBe("sqlite");
        await expect(dbMocks.module.initDbMysql()).resolves.toBeUndefined();
    });

    it("installs the canonical startServer db module mock for subsequent dynamic imports", async () => {
        const dbMocks = createStartServerDbMocks();

        installStartServerDbModuleMock(dbMocks);

        const storage = await import("@/storage/db");
        await storage.db.$connect();

        expect(dbMocks.dbConnect).toHaveBeenCalledTimes(1);
        expect(storage.getDbProviderFromEnv({}, "sqlite")).toBe("sqlite");
    });
});
