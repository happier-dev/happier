import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    applyEnvValues,
    installStartServerCommonWiringMocks,
    restoreEnvValues,
    snapshotStartServerEnv,
} from "@/testkit/startServerMocks";

const cleanupStop = vi.fn();
const startVoiceSessionLeaseCleanupFromEnv = vi.fn(() => ({ stop: cleanupStop }));

vi.mock("@/app/voice/voiceSessionLeaseCleanup", () => ({
    startVoiceSessionLeaseCleanupFromEnv: (...args: any[]) => startVoiceSessionLeaseCleanupFromEnv(...args),
}));

vi.mock("@/storage/redis", () => ({
    getRedisClient: () => ({ ping: vi.fn(async () => "PONG") }),
}));

vi.mock("@/storage/db", () => ({
    db: {
        $connect: vi.fn(async () => {}),
        $disconnect: vi.fn(async () => {}),
    },
    getDbProviderFromEnv: (_env: any, fallback: any) => fallback,
    initDbPostgres: vi.fn(() => {}),
    initDbPglite: vi.fn(async () => {}),
    initDbMysql: vi.fn(async () => {}),
    initDbSqlite: vi.fn(async () => {}),
    shutdownDbPglite: vi.fn(async () => {}),
}));

installStartServerCommonWiringMocks();

const onShutdown = vi.fn();
vi.mock("@/utils/shutdown", () => ({
    onShutdown: (...args: any[]) => onShutdown(...args),
    awaitShutdown: vi.fn(async () => {}),
}));

describe("startServer voice lease cleanup wiring", () => {
    const envBackup = snapshotStartServerEnv();

    beforeEach(() => {
        vi.clearAllMocks();
        restoreEnvValues(envBackup);
        applyEnvValues({
            SERVER_ROLE: "all",
            VOICE_LEASE_CLEANUP: "1",
        });
    });

    afterEach(() => {
        restoreEnvValues(envBackup);
    });

    it("starts voice lease cleanup when SERVER_ROLE=all", async () => {
        vi.resetModules();
        const { startServer } = await import("./startServer");

        await startServer("full");

        expect(startVoiceSessionLeaseCleanupFromEnv).toHaveBeenCalledTimes(1);
        expect(onShutdown).toHaveBeenCalledWith(
            "voice-lease-cleanup",
            expect.any(Function),
        );
    });
});
