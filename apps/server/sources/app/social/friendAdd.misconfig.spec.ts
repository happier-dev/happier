import { describe, expect, it, vi } from "vitest";
import { createInTxWithAccountLookup, createSocialAccount } from "./socialTestHarness";

vi.mock("./friendsPolicy", () => ({
    resolveFriendsPolicyFromEnv: () => ({
        enabled: true,
        allowUsername: false,
        requiredIdentityProviderId: undefined,
    }),
}));

vi.mock("@/app/changes/markAccountChanged", () => ({ markAccountChanged: vi.fn(async () => 1) }));
vi.mock("./relationshipGet", () => ({ relationshipGet: vi.fn(async () => "none") }));
vi.mock("./relationshipSet", () => ({ relationshipSet: vi.fn(async () => {}) }));
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
const setAccountLookup = (accountsById: Record<string, any>) => {
    txAccountFindUnique = vi.fn(async (args: any) => accountsById[args.where.id] ?? null);
};
vi.mock("@/storage/inTx", () => ({
    inTx: createInTxWithAccountLookup((...args: any[]) => txAccountFindUnique(...args)).inTx,
}));

describe("friendAdd", () => {
    it("throws a clear error when friends policy is misconfigured", async () => {
        setAccountLookup({
            u1: createSocialAccount("u1"),
            u2: createSocialAccount("u2"),
        });

        const { friendAdd } = await import("./friendAdd");
        await expect(friendAdd({ uid: "u1" } as any, "u2")).rejects.toThrow(/misconfigured/i);
    });
});
