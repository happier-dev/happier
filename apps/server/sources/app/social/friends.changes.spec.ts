import { beforeEach, describe, expect, it, vi } from "vitest";

const markAccountChanged = vi.fn(async () => 1);
vi.mock("@/app/changes/markAccountChanged", () => ({ markAccountChanged }));

const relationshipGet = vi.fn();
vi.mock("./relationshipGet", () => ({ relationshipGet }));

const relationshipSet = vi.fn(async () => {});
vi.mock("./relationshipSet", () => ({ relationshipSet }));

vi.mock("./friendNotification", () => ({
    sendFriendRequestNotification: vi.fn(async () => {}),
    sendFriendshipEstablishedNotification: vi.fn(async () => {}),
}));

vi.mock("./type", () => ({
    buildUserProfile: (user: any, status: any) => ({ id: user.id, status }),
}));

vi.mock("@/storage/prisma", () => ({
    RelationshipStatus: {
        none: "none",
        requested: "requested",
        pending: "pending",
        friend: "friend",
        rejected: "rejected",
    },
}));

let txAccountFindUnique: any;

vi.mock("@/storage/inTx", () => {
    const inTx = async <T>(fn: (tx: any) => Promise<T>): Promise<T> => {
        const tx: any = {
            account: {
                findUnique: (...args: any[]) => txAccountFindUnique(...args),
            },
        };
        return await fn(tx);
    };
    return { inTx };
});

describe("friends marking (AccountChange integration)", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("friendAdd: new request marks friends for both users", async () => {
        txAccountFindUnique = vi.fn(async (args: any) => {
            if (args.where.id === "u1") return { id: "u1", githubUser: null };
            if (args.where.id === "u2") return { id: "u2", githubUser: null };
            return null;
        });
        relationshipGet.mockImplementation(async (_tx: any, from: string, _to: string) => {
            if (from === "u1") return "none";
            if (from === "u2") return "none";
            return "none";
        });

        const { friendAdd } = await import("./friendAdd");
        await friendAdd({ uid: "u1" } as any, "u2");

        expect(markAccountChanged).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ accountId: "u1", kind: "friends", entityId: "self" }));
        expect(markAccountChanged).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ accountId: "u2", kind: "friends", entityId: "self" }));
    });

    it("friendAdd: accepting request marks friends for both users", async () => {
        txAccountFindUnique = vi.fn(async (args: any) => {
            if (args.where.id === "u1") return { id: "u1", githubUser: null };
            if (args.where.id === "u2") return { id: "u2", githubUser: null };
            return null;
        });
        relationshipGet.mockImplementation(async (_tx: any, from: string, _to: string) => {
            if (from === "u2") return "requested";
            return "none";
        });

        const { friendAdd } = await import("./friendAdd");
        await friendAdd({ uid: "u1" } as any, "u2");

        expect(markAccountChanged).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ accountId: "u1", kind: "friends", entityId: "self" }));
        expect(markAccountChanged).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ accountId: "u2", kind: "friends", entityId: "self" }));
    });

    it("friendRemove: requested->rejected marks friends for current user only", async () => {
        txAccountFindUnique = vi.fn(async (args: any) => {
            if (args.where.id === "u1") return { id: "u1", githubUser: null };
            if (args.where.id === "u2") return { id: "u2", githubUser: null };
            return null;
        });
        relationshipGet.mockImplementation(async (_tx: any, from: string, _to: string) => {
            if (from === "u1") return "requested";
            return "pending";
        });

        const { friendRemove } = await import("./friendRemove");
        await friendRemove({ uid: "u1" } as any, "u2");

        expect(markAccountChanged).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ accountId: "u1", kind: "friends", entityId: "self" }));
        expect(markAccountChanged).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ accountId: "u2", kind: "friends", entityId: "self" }));
    });
});
