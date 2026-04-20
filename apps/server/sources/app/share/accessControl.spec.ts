import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createDbMocks, installDbModuleMock } from "../api/testkit/dbMocks";

const dbMocks = createDbMocks({
    session: ["findUnique"],
    sessionShare: ["findUnique"],
    publicSessionShare: ["findUnique"],
    userRelationship: ["findFirst"],
} as const);

installDbModuleMock({ db: dbMocks.db });

let checkSessionAccess: typeof import("./accessControl").checkSessionAccess;
let checkPublicShareAccess: typeof import("./accessControl").checkPublicShareAccess;
let isSessionOwner: typeof import("./accessControl").isSessionOwner;
let canManageSharing: typeof import("./accessControl").canManageSharing;
let areFriends: typeof import("./accessControl").areFriends;

beforeAll(async () => {
    ({ checkSessionAccess, checkPublicShareAccess, isSessionOwner, canManageSharing, areFriends } = await import("./accessControl"));
});

describe("accessControl", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        dbMocks.reset();
    });

    describe("checkSessionAccess", () => {
        it("should return owner access when user owns the session", async () => {
            dbMocks.db.session.findUnique.mockResolvedValue({
                id: "session-1",
                accountId: "user-1",
                active: true,
                lastActiveAt: new Date("2026-01-01T00:00:00.000Z"),
            } as any);

            const result = await checkSessionAccess("user-1", "session-1");

            expect(result).toMatchObject({
                userId: "user-1",
                sessionId: "session-1",
                level: "owner",
                isOwner: true,
                sessionActive: true,
                sessionLastActiveAt: new Date("2026-01-01T00:00:00.000Z"),
            });
        });

        it("should return null when session does not exist", async () => {
            dbMocks.db.session.findUnique.mockResolvedValue(null);

            const result = await checkSessionAccess("user-1", "session-1");

            expect(result).toBeNull();
        });

        it("should return shared access level when session is shared with user", async () => {
            dbMocks.db.session.findUnique.mockResolvedValue({
                id: "session-1",
                accountId: "user-owner",
                active: false,
                lastActiveAt: new Date("2026-01-01T00:00:00.000Z"),
            } as any);

            dbMocks.db.sessionShare.findUnique.mockResolvedValue({
                accessLevel: "view",
            } as any);

            const result = await checkSessionAccess("user-1", "session-1");

            expect(result).toMatchObject({
                userId: "user-1",
                sessionId: "session-1",
                level: "view",
                isOwner: false,
                sessionActive: false,
                sessionLastActiveAt: new Date("2026-01-01T00:00:00.000Z"),
            });
        });

        it("should return null when user has no access to session", async () => {
            dbMocks.db.session.findUnique.mockResolvedValue({
                id: "session-1",
                accountId: "user-owner",
            } as any);

            dbMocks.db.sessionShare.findUnique.mockResolvedValue(null);

            const result = await checkSessionAccess("user-1", "session-1");

            expect(result).toBeNull();
        });
    });

    describe("checkPublicShareAccess", () => {
        it("should return access info for valid token", async () => {
            const mockShare = {
                id: "public-1",
                sessionId: "session-1",
                expiresAt: null,
                maxUses: null,
                useCount: 5,
                blockedUsers: [],
            };

            dbMocks.db.publicSessionShare.findUnique.mockResolvedValue(mockShare as any);

            const result = await checkPublicShareAccess("valid-token", null);

            expect(result).toEqual({
                sessionId: "session-1",
                publicShareId: "public-1",
            });
        });

        it("should return null for invalid token", async () => {
            dbMocks.db.publicSessionShare.findUnique.mockResolvedValue(null);

            const result = await checkPublicShareAccess("invalid-token", null);

            expect(result).toBeNull();
        });

        it("should return null for expired shares", async () => {
            const pastDate = new Date(Date.now() - 1000 * 60 * 60);
            const mockShare = {
                id: "public-1",
                sessionId: "session-1",
                expiresAt: pastDate,
                maxUses: null,
                useCount: 0,
                blockedUsers: [],
            };

            dbMocks.db.publicSessionShare.findUnique.mockResolvedValue(mockShare as any);

            const result = await checkPublicShareAccess("valid-token", null);

            expect(result).toBeNull();
        });

        it("should return null when max uses reached", async () => {
            const mockShare = {
                id: "public-1",
                sessionId: "session-1",
                expiresAt: null,
                maxUses: 10,
                useCount: 10,
                blockedUsers: [],
            };

            dbMocks.db.publicSessionShare.findUnique.mockResolvedValue(mockShare as any);

            const result = await checkPublicShareAccess("valid-token", null);

            expect(result).toBeNull();
        });
    });

    describe("isSessionOwner", () => {
        it("should return true when user owns the session", async () => {
            dbMocks.db.session.findUnique.mockResolvedValue({
                id: "session-1",
                accountId: "user-1",
            } as any);

            const result = await isSessionOwner("user-1", "session-1");

            expect(result).toBe(true);
        });

        it("should return false when user does not own the session", async () => {
            dbMocks.db.session.findUnique.mockResolvedValue({
                id: "session-1",
                accountId: "user-owner",
            } as any);

            const result = await isSessionOwner("user-1", "session-1");

            expect(result).toBe(false);
        });

        it("should return false when session does not exist", async () => {
            dbMocks.db.session.findUnique.mockResolvedValue(null);

            const result = await isSessionOwner("user-1", "session-1");

            expect(result).toBe(false);
        });
    });

    describe("canManageSharing", () => {
        it("should return true for session owner", async () => {
            dbMocks.db.session.findUnique.mockResolvedValue({
                id: "session-1",
                accountId: "user-1",
            } as any);

            const result = await canManageSharing("user-1", "session-1");

            expect(result).toBe(true);
        });

        it("should return true for admin access level", async () => {
            dbMocks.db.session.findUnique.mockResolvedValue({
                id: "session-1",
                accountId: "user-owner",
            } as any);

            dbMocks.db.sessionShare.findUnique.mockResolvedValue({
                accessLevel: "admin",
            } as any);

            const result = await canManageSharing("user-1", "session-1");

            expect(result).toBe(true);
        });

        it("should return false for view access level", async () => {
            dbMocks.db.session.findUnique.mockResolvedValue({
                id: "session-1",
                accountId: "user-owner",
            } as any);

            dbMocks.db.sessionShare.findUnique.mockResolvedValue({
                accessLevel: "view",
            } as any);

            const result = await canManageSharing("user-1", "session-1");

            expect(result).toBe(false);
        });

        it("should return false for edit access level", async () => {
            dbMocks.db.session.findUnique.mockResolvedValue({
                id: "session-1",
                accountId: "user-owner",
            } as any);

            dbMocks.db.sessionShare.findUnique.mockResolvedValue({
                accessLevel: "edit",
            } as any);

            const result = await canManageSharing("user-1", "session-1");

            expect(result).toBe(false);
        });

        it("should return false when user has no access", async () => {
            dbMocks.db.session.findUnique.mockResolvedValue({
                id: "session-1",
                accountId: "user-owner",
            } as any);

            dbMocks.db.sessionShare.findUnique.mockResolvedValue(null);

            const result = await canManageSharing("user-1", "session-1");

            expect(result).toBe(false);
        });
    });

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
});
