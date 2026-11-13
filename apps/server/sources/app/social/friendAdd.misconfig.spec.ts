import { afterEach, describe, expect, it, vi } from "vitest";


import { Context } from "@/context";
import { createDbTransactionMock, installDbModuleMock, inTxPostgresControlStatementMock } from "../api/testkit/dbMocks";
import { homeConfigSnapshotPostgresQueryMock } from "../home/settings/homeConfigSnapshot.testkit";

// The persistent database is the boundary; Home policy and transaction execution stay real.
const tx = {
    ...inTxPostgresControlStatementMock,
    ...homeConfigSnapshotPostgresQueryMock,
    homeSettings: { findUnique: async () => null },
    homeGovernancePolicy: { findUnique: async () => null },
};
const database = createDbTransactionMock(() => tx).wrapDb(tx);
installDbModuleMock({ db: database });

afterEach(() => vi.unstubAllEnvs());

describe("friendAdd policy admission", () => {
    it("refuses a provider policy with no configured identity provider", async () => {
        vi.stubEnv("HAPPIER_FEATURE_SOCIAL_FRIENDS__ENABLED", "1");
        vi.stubEnv("HAPPIER_FEATURE_SOCIAL_FRIENDS__ALLOW_USERNAME", "0");
        vi.stubEnv("HAPPIER_FEATURE_SOCIAL_FRIENDS__IDENTITY_PROVIDER", "");
        const { friendAdd, FriendsDisabledError } = await import("./friendAdd");
        await expect(friendAdd(Context.create("u1"), "u2")).rejects.toBeInstanceOf(FriendsDisabledError);
    });
    it("refuses a friend request when the Home disables friends", async () => {
        vi.stubEnv("HAPPIER_FEATURE_SOCIAL_FRIENDS__ENABLED", "0");
        const { friendAdd, FriendsDisabledError } = await import("./friendAdd");
        await expect(friendAdd(Context.create("u1"), "u2")).rejects.toBeInstanceOf(FriendsDisabledError);
    });
});
