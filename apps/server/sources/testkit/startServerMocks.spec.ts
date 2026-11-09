import { afterEach, describe, expect, it, vi } from "vitest";

import { createStartServerDbMocks, installStartServerDbModuleMock } from "./startServerMocks";

describe("startServerMocks", () => {
    afterEach(() => {
        vi.doUnmock("@/storage/db");
        vi.doUnmock("@/storage/prisma");
        vi.resetModules();
    });

    it("resets canonical startServer db mock handles back to their default provider reader", async () => {
        const dbMocks = createStartServerDbMocks();

        dbMocks.getDbProviderFromEnv.mockImplementation(() => "mysql");
        dbMocks.initDbMysql.mockResolvedValue(undefined);
        dbMocks.accountCount.mockResolvedValue(4);

        expect(dbMocks.getDbProviderFromEnv({}, "sqlite")).toBe("mysql");
        await expect(dbMocks.module.db.account.count()).resolves.toBe(4);

        dbMocks.reset();

        expect(dbMocks.getDbProviderFromEnv({}, "sqlite")).toBe("sqlite");
        await expect(dbMocks.module.db.account.count()).resolves.toBe(0);
        await expect(dbMocks.module.initDbMysql()).resolves.toBeUndefined();
    });

    it("installs the canonical startServer db module mock for subsequent dynamic imports", async () => {
        const dbMocks = createStartServerDbMocks();
        const connectionFailure = new Error("database unavailable");
        dbMocks.dbConnect.mockRejectedValueOnce(connectionFailure);

        installStartServerDbModuleMock(dbMocks);

        const storage = await import("@/storage/db");
        await expect(storage.db.$connect()).rejects.toBe(connectionFailure);
        expect(storage.getDbProviderFromEnv({}, "sqlite")).toBe("sqlite");
    });
});
