import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AUTHORITY_CEILING_HEADER_V1 } from "@happier-dev/protocol";

import { auth } from "@/app/auth/auth";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { enableAuthentication } from "./enableAuthentication";
import type { Fastify as AppFastify } from "../types";

function createApp() {
    const app = Fastify({ logger: false }) as unknown as AppFastify;
    enableAuthentication(app);

    app.get("/legacy", { preHandler: app.authenticate }, async (request) => ({
        tokenKind: request.authTokenKind,
        authority: request.authAuthority,
    }));
    app.get("/api-token-enabled", {
        config: { allowApiToken: true },
        preHandler: app.authenticate,
    }, async (request) => ({
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
            data: { publicKey: "api-token-admission", terminalPresentUserPolicy: "allowed" },
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
                authority: "present_user",
            });
            expect(legacyPatResponse.statusCode).toBe(403);
            expect(legacyPatResponse.json()).toEqual({ error: "present_user_required" });
            expect(enabledPatResponse.statusCode).toBe(200);
            expect(enabledPatResponse.json()).toEqual({
                tokenKind: "api_token",
                authority: "account_automation",
            });

            // The Account policy can raise terminal invocation authority, never PAT
            // authority; a caller ceiling and a later policy change can only lower it.
            const loweredTerminalResponse = await app.inject({
                method: "GET",
                url: "/legacy",
                headers: { authorization: `Bearer ${terminalToken}`, [AUTHORITY_CEILING_HEADER_V1]: "account_automation" },
            });
            expect(loweredTerminalResponse.statusCode).toBe(200);
            expect(loweredTerminalResponse.json()).toEqual({ tokenKind: "terminal", authority: "account_automation" });

            await db.account.update({ where: { id: account.id }, data: { terminalPresentUserPolicy: "disallowed" } });
            const disallowedTerminalResponse = await app.inject({
                method: "GET",
                url: "/legacy",
                headers: { authorization: `Bearer ${terminalToken}` },
            });
            expect(disallowedTerminalResponse.statusCode).toBe(200);
            expect(disallowedTerminalResponse.json()).toEqual({ tokenKind: "terminal", authority: "account_automation" });
        } finally {
            await app.close();
        }
    });
});
