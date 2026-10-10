import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { auth } from "@/app/auth/auth";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { enableAuthentication } from "./enableAuthentication";

function createApp() {
    const app = Fastify({ logger: false }) as any;
    enableAuthentication(app);

    app.get("/legacy", { preHandler: app.authenticate }, async (request: any) => ({
        tokenKind: request.authTokenKind,
        authority: request.authAuthority,
    }));
    app.get("/api-token-enabled", {
        config: { allowApiToken: true },
        preHandler: app.authenticate,
    }, async (request: any) => ({
        tokenKind: request.authTokenKind,
        authority: request.authAuthority,
    }));

    return app;
}

describe("enableAuthentication API-token admission (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-auth-api-token-admission-",
            initAuth: true,
            env: {
                AUTH_REQUIRED_LOGIN_PROVIDERS: "",
                AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: "0",
            },
        });
    }, 120_000);

    afterEach(async () => {
        harness.resetEnv();
        await db.account.deleteMany();
    });

    afterAll(async () => {
        await harness.close();
    });

    it("denies PATs from legacy routes while retaining terminal access and allowing explicit API-token entrypoints", async () => {
        const account = await db.account.create({
            // Current Account policy, rather than the token's minted floor,
            // decides terminal invocation authority.
            data: { publicKey: "api-token-admission", terminalPresentUserPolicy: "disallowed" },
            select: { id: true },
        });
        const [signedToken, terminalToken, pat] = await Promise.all([
            auth.createToken(account.id, undefined, { kind: "account", authority: "present_user" }),
            auth.createToken(account.id, { session: "terminal-auth-request" }, { kind: "terminal", authority: "account_automation" }),
            auth.createApiToken({ accountId: account.id, tokenId: crypto.randomUUID(), label: "PAT admission" }),
        ]);
        const app = createApp();
        await app.ready();

        try {
            const [signedResponse, terminalResponse, legacyPatResponse, enabledPatResponse] = await Promise.all([
                app.inject({
                    method: "GET",
                    url: "/legacy",
                    headers: { authorization: `Bearer ${signedToken}` },
                }),
                app.inject({
                    method: "GET",
                    url: "/legacy",
                    headers: { authorization: `Bearer ${terminalToken}` },
                }),
                app.inject({
                    method: "GET",
                    url: "/legacy",
                    headers: { authorization: `Bearer ${pat.token}` },
                }),
                app.inject({
                    method: "GET",
                    url: "/api-token-enabled",
                    headers: { authorization: `Bearer ${pat.token}` },
                }),
            ]);

            expect(signedResponse.statusCode).toBe(200);
            expect(signedResponse.json()).toEqual({
                tokenKind: "account",
                authority: "present_user",
            });
            expect(terminalResponse.statusCode).toBe(200);
            expect(terminalResponse.json()).toEqual({
                tokenKind: "terminal",
                authority: "account_automation",
            });
            expect(legacyPatResponse.statusCode).toBe(403);
            expect(legacyPatResponse.json()).toEqual({ error: "present_user_required" });
            expect(enabledPatResponse.statusCode).toBe(200);
            expect(enabledPatResponse.json()).toEqual({
                tokenKind: "api_token",
                authority: "account_automation",
            });
        } finally {
            await app.close();
        }
    });
});
