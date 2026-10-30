import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDbMocks, installDbModuleMock } from "../api/testkit/dbMocks";
const dbMocks = createDbMocks({ userRelationship: ["findFirst"] } as const);
installDbModuleMock({ db: dbMocks.db });
const { areFriends } = await import("./friendshipAccess");
beforeEach(() => { vi.clearAllMocks(); dbMocks.reset(); });
    describe("areFriends", () => {
        it("should return true when users are friends (from->to)", async () => {
            dbMocks.db.userRelationship.findFirst.mockResolvedValue({
                fromUserId: "user-1",
                toUserId: "user-2",
                status: "friend",
            } as any);

            const result = await areFriends("user-1", "user-2");

            expect(result).toBe(true);
        });

        it("should return true when users are friends (to->from)", async () => {
            dbMocks.db.userRelationship.findFirst.mockResolvedValue({
                fromUserId: "user-2",
                toUserId: "user-1",
                status: "friend",
            } as any);

            const result = await areFriends("user-1", "user-2");

            expect(result).toBe(true);
        });

        it("should return false when users are not friends", async () => {
            dbMocks.db.userRelationship.findFirst.mockResolvedValue(null);

            const result = await areFriends("user-1", "user-2");

            expect(result).toBe(false);
        });

        it("queries only friend relationships in either direction", async () => {
            dbMocks.db.userRelationship.findFirst.mockResolvedValue(null);

            await areFriends("user-1", "user-2");

            expect(dbMocks.db.userRelationship.findFirst).toHaveBeenCalledWith({
                where: {
                    OR: [
                        { fromUserId: "user-1", toUserId: "user-2", status: "friend" },
                        { fromUserId: "user-2", toUserId: "user-1", status: "friend" },
                    ],
                },
            });
        });
    });
