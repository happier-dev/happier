import { beforeEach, describe, expect, it, vi } from "vitest";

const globalLockInsert = vi.fn();
const globalLockUpdateMany = vi.fn();
const globalLockFindUnique = vi.fn();
const globalLockDeleteMany = vi.fn();

vi.mock("@/storage/db", () => ({
    db: {
        $executeRaw: globalLockInsert,
        globalLock: {
            updateMany: globalLockUpdateMany,
            findUnique: globalLockFindUnique,
            deleteMany: globalLockDeleteMany,
        },
    },
}));

vi.mock("@/utils/keys/randomKeyNaked", () => ({ randomKeyNaked: () => "lock-owner" }));

describe("acquireGlobalLock", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        globalLockDeleteMany.mockResolvedValue({ count: 1 });
    });

    it("acquires and owner-checks release of a named database lock", async () => {
        globalLockInsert.mockResolvedValue(1);
        const { acquireGlobalLock } = await import("./globalLock");

        const lock = await acquireGlobalLock({
            key: "server.voice.provider-identity-backfill",
            ttlMs: 60_000,
            now: new Date("2026-07-10T10:00:00.000Z"),
        });
        globalLockUpdateMany.mockResolvedValueOnce({ count: 1 });
        await expect(lock?.renew({
            ttlMs: 120_000,
            now: new Date("2026-07-10T10:00:30.000Z"),
        })).resolves.toBe(true);
        await lock?.release();

        expect(lock).not.toBeNull();
        expect(globalLockDeleteMany).toHaveBeenCalledWith({
            where: {
                key: "server.voice.provider-identity-backfill",
                value: "lock-owner",
            },
        });
        expect(globalLockUpdateMany).toHaveBeenCalledWith({
            where: {
                key: "server.voice.provider-identity-backfill",
                value: "lock-owner",
            },
            data: {
                expiresAt: new Date("2026-07-10T10:02:30.000Z"),
            },
        });
    });

    it("returns null while another non-expired owner holds the lock", async () => {
        globalLockInsert.mockResolvedValue(0);
        globalLockUpdateMany.mockResolvedValue({ count: 0 });
        const { acquireGlobalLock } = await import("./globalLock");

        await expect(acquireGlobalLock({ key: "server.voice.provider-identity-backfill", ttlMs: 60_000 }))
            .resolves.toBeNull();
    });
});
