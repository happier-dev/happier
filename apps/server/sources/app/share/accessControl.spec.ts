import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createDbMocks, installDbModuleMock } from "../api/testkit/dbMocks";

const dbMocks = createDbMocks({
    session: ["findUnique"],
    sessionShare: ["findUnique"],
    userRelationship: ["findFirst"],
} as const);

installDbModuleMock({ db: dbMocks.db });

let checkSessionAccess: typeof import("./accessControl").checkSessionAccess;
let isSessionOwner: typeof import("./accessControl").isSessionOwner;
let canManageSharing: typeof import("./accessControl").canManageSharing;
let canManageSharingInTx: typeof import("./accessControl").canManageSharingInTx;
let areFriends: typeof import("./accessControl").areFriends;
let buildCurrentSessionParticipantWhere: typeof import("./accessControl").buildCurrentSessionParticipantWhere;

beforeAll(async () => {
    ({ checkSessionAccess, isSessionOwner, canManageSharing, canManageSharingInTx, areFriends } = await import("./accessControl"));
    ({ buildCurrentSessionParticipantWhere } = await import("./accessControl"));
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
                currentStorageState: "hosted",
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

        it.each(["machine_only", "server_partial"] as const)(
            "rejects shared-user access while transcript storage is %s",
            async (currentStorageState) => {
                dbMocks.db.session.findUnique.mockResolvedValue({
                    id: "session-1",
                    accountId: "user-owner",
                    active: false,
                    lastActiveAt: new Date("2026-01-01T00:00:00.000Z"),
                    currentStorageState,
                    acceptedThroughServerSeq: currentStorageState === "server_partial" ? 2 : null,
                    materializationPublicationId: null,
                    materializedThroughSourceAt: null,
                    publishedThroughServerSeq: null,
                } as any);
                dbMocks.db.sessionShare.findUnique.mockResolvedValue({
                    accessLevel: "view",
                } as any);

                await expect(checkSessionAccess("user-1", "session-1")).resolves.toBeNull();
                expect(dbMocks.db.sessionShare.findUnique).not.toHaveBeenCalled();
            },
        );

        it("retains owner access while transcript storage is machine_only", async () => {
            dbMocks.db.session.findUnique.mockResolvedValue({
                id: "session-1",
                accountId: "user-1",
                active: false,
                lastActiveAt: new Date("2026-01-01T00:00:00.000Z"),
                currentStorageState: "machine_only",
            } as any);

            await expect(checkSessionAccess("user-1", "session-1")).resolves.toMatchObject({
                level: "owner",
                isOwner: true,
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

    it("builds one current participant predicate for owner and current share paths", () => {
        expect(buildCurrentSessionParticipantWhere({ userId: "user-1", sessionId: "session-1" }))
            .toMatchObject({
                id: "session-1",
                OR: [
                    { accountId: "user-1" },
                    {
                        AND: [
                            { OR: expect.any(Array) },
                            { shares: { some: { sharedWithUserId: "user-1" } } },
                        ],
                    },
                ],
            });
    });

    it("builds a current-admin predicate with delegated-approval capability when requested", async () => {
        const findFirst = vi.fn().mockResolvedValue({
            accountId: "user-1",
            currentStorageState: "hosted",
        });

        await expect(canManageSharingInTx({
            session: { findFirst },
        } as never, {
            userId: "user-1",
            sessionId: "session-1",
            requirePermissionDelegation: true,
        })).resolves.toBe(true);

        expect(findFirst).toHaveBeenCalledWith({
            where: expect.objectContaining({
                id: "session-1",
                OR: [
                    { accountId: "user-1" },
                    expect.objectContaining({
                        AND: expect.arrayContaining([
                            expect.objectContaining({
                                shares: {
                                    some: expect.objectContaining({
                                        sharedWithUserId: "user-1",
                                        accessLevel: { in: ["admin"] },
                                        canApprovePermissions: true,
                                    }),
                                },
                            }),
                        ]),
                    }),
                ],
            }),
            select: expect.objectContaining({
                accountId: true,
                seq: true,
            }),
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
                currentStorageState: "hosted",
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
