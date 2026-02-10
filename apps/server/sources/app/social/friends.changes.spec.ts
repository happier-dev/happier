import { beforeEach, describe, expect, it, vi } from "vitest";
import { createInTxWithAccountLookup, createSocialAccount } from "./socialTestHarness";

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
    toSocialIdentities: (identities: any[]) =>
        (identities ?? []).map((identity) => ({
            provider: identity.provider,
            providerLogin: identity.providerLogin ?? null,
            profile: identity.profile,
            showOnProfile: Boolean(identity.showOnProfile),
        })),
    buildUserProfile: (user: any, status: any, _githubProfile: any) => ({ id: user.id, status }),
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
const setAccountLookup = (accountsById: Record<string, any>) => {
    txAccountFindUnique = vi.fn(async (args: any) => accountsById[args.where.id] ?? null);
};

vi.mock("@/storage/inTx", () => {
    const { inTx } = createInTxWithAccountLookup((...args: any[]) => txAccountFindUnique(...args));
    return { inTx };
});

describe("friends marking (AccountChange integration)", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("friendAdd: new request marks friends for both users", async () => {
        setAccountLookup({
            u1: createSocialAccount("u1"),
            u2: createSocialAccount("u2"),
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
        setAccountLookup({
            u1: createSocialAccount("u1"),
            u2: createSocialAccount("u2"),
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
        setAccountLookup({
            u1: { id: "u1" },
            u2: createSocialAccount("u2"),
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

    it("friendRemove: friend->none clears relationship for both users and marks friends for both", async () => {
        setAccountLookup({
            u1: { id: "u1" },
            u2: createSocialAccount("u2"),
        });
        relationshipGet.mockImplementation(async (_tx: any, from: string, _to: string) => {
            if (from === "u1") return "friend";
            if (from === "u2") return "friend";
            return "none";
        });

        const { friendRemove } = await import("./friendRemove");
        const res = await friendRemove({ uid: "u1" } as any, "u2");

        expect(res).toEqual({ id: "u2", status: "none" });
        expect(relationshipSet).toHaveBeenCalledWith(expect.anything(), "u1", "u2", "none");
        expect(relationshipSet).toHaveBeenCalledWith(expect.anything(), "u2", "u1", "none");
        expect(markAccountChanged).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ accountId: "u1", kind: "friends", entityId: "self" }));
        expect(markAccountChanged).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ accountId: "u2", kind: "friends", entityId: "self" }));
    });
});
