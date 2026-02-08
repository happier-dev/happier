import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { db } from "@/storage/db";
import { Context } from "@/context";
import { createOidcIdentityProvider } from "./oidcIdentityProvider";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

describe("oidcIdentityProvider.connect (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-oidc-connect-",
            initEncrypt: true,
            initAuth: false,
            initFiles: false,
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    beforeEach(async () => {
        harness.restoreEnv();
        await harness.resetDbTables([
            () => db.accountIdentity.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    it("updates the stored identity when reconnecting the same provider user", async () => {
        const account = await db.account.create({
            data: { publicKey: `pk-${Date.now()}-oidc-reconnect` },
            select: { id: true },
        });

        const provider = createOidcIdentityProvider({
            id: "oidc-test",
            type: "oidc",
            displayName: "OIDC Test",
            issuer: "https://issuer.example.test",
            clientId: "cid",
            clientSecret: "secret",
            redirectUrl: "https://server.example.test/v1/oauth/oidc-test/callback",
            scopes: "openid profile",
            claims: { login: "preferred_username", email: "email", groups: "groups" },
            allow: { usersAllowlist: [], emailDomains: [], groupsAny: [], groupsAll: [] },
            fetchUserInfo: false,
            storeRefreshToken: false,
            ui: { buttonColor: null, iconHint: null },
            httpTimeoutSeconds: 5,
        } as any);

        await provider.connect({
            ctx: Context.create(account.id),
            profile: { sub: "sub-1", preferred_username: "alice" },
            accessToken: "access-token",
        });

        await provider.connect({
            ctx: Context.create(account.id),
            profile: { sub: "sub-1", preferred_username: "alice2" },
            accessToken: "access-token",
        });

        const identity = await db.accountIdentity.findFirst({
            where: { accountId: account.id, provider: "oidc-test" },
            select: { providerUserId: true, providerLogin: true },
        });
        expect(identity?.providerUserId).toBe("sub-1");
        expect(identity?.providerLogin).toBe("alice2");
    });
});
