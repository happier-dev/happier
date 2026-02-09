import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    applyEnvValues,
    installStartServerCommonWiringMocks,
    restoreEnvValues,
    snapshotStartServerEnv,
} from "@/testkit/startServerMocks";

const callOrder: string[] = [];

const dbDisconnect = vi.fn(async () => {
    callOrder.push("db.$disconnect");
});

const shutdownDbPglite = vi.fn(async () => {
    callOrder.push("shutdownDbPglite");
});

vi.mock("@/storage/db", () => ({
    db: {
        $connect: vi.fn(async () => {}),
        $disconnect: dbDisconnect as any,
    },
    getDbProviderFromEnv: vi.fn(() => "pglite"),
    initDbPostgres: vi.fn(),
    initDbPglite: vi.fn(async () => {}),
    initDbMysql: vi.fn(async () => {}),
    initDbSqlite: vi.fn(async () => {}),
    shutdownDbPglite: shutdownDbPglite as any,
}));

installStartServerCommonWiringMocks();

// Avoid hanging in tests: startServer calls awaitShutdown().
vi.mock("@/utils/process/shutdown", async () => {
    const actual = await vi.importActual<any>("@/utils/process/shutdown");
    return { ...actual, awaitShutdown: vi.fn(async () => {}) };
});

describe("startServer light shutdown ordering", () => {
    const envBackup = snapshotStartServerEnv();

    beforeEach(() => {
        vi.clearAllMocks();
        restoreEnvValues(envBackup);
    });

    afterEach(() => {
        restoreEnvValues(envBackup);
    });

    it("disconnects Prisma before stopping pglite", async () => {
        callOrder.length = 0;
        applyEnvValues({
            SERVER_ROLE: "all",
            REDIS_URL: undefined,
        });

        const { startServer } = await import("./startServer");
        const { initiateShutdown } = await import("@/utils/process/shutdown");

        await startServer("light");
        await initiateShutdown("test");

        expect(callOrder).toEqual(["db.$disconnect", "shutdownDbPglite"]);
    });
});
