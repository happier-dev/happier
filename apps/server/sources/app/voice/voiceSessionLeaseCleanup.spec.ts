import { beforeEach, describe, expect, it, vi } from "vitest";

const deleteMany = vi.fn();

vi.mock("@/storage/db", () => ({
    db: {
        voiceSessionLease: {
            deleteMany: (...args: any[]) => deleteMany(...args),
        },
    },
}));

describe("voiceSessionLeaseCleanup", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        deleteMany.mockResolvedValue({ count: 0 });
    });

    it("deletes leases older than the cutoff", async () => {
        const { pruneExpiredVoiceSessionLeasesOnce } = await import("./voiceSessionLeaseCleanup");

        const cutoff = new Date("2026-02-01T00:00:00.000Z");
        await pruneExpiredVoiceSessionLeasesOnce({ cutoff });

        expect(deleteMany).toHaveBeenCalledWith({
            where: {
                expiresAt: { lt: cutoff },
            },
        });
    });
});

