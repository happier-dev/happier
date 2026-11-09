import * as privacyKit from "privacy-kit";
import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { auth } from "@/app/auth/auth";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { setAccountStatusInTx } from "@/app/home/governance/accountLifecycle";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { enableAuthentication } from "./enableAuthentication";
import { requirePresentUser } from "./requirePresentUser";
import { AUTHORITY_CEILING_HEADER_V1 } from "@happier-dev/protocol";

function createApp() {
    const app = Fastify({ logger: false }) as any;
    enableAuthentication(app);
    const requireDirectoryAuthority = async (request: any, reply: any) => {
        if (request.authTokenKind === "account_directory") return;
        return reply.code(403).send({ error: "account_directory_authority_required" });
    };
    app.get("/ordinary", { preHandler: app.authenticate }, async (request: any) => ({
        tokenKind: request.authTokenKind,
    }));
    app.get("/ordinary-present", { preHandler: [app.authenticate, requirePresentUser] }, async () => ({ ok: true }));
    app.get("/pat-present", { config: { allowApiToken: true }, preHandler: [app.authenticate, requirePresentUser] }, async () => ({ ok: true }));
    app.get(
        "/directory",
        {
            config: { allowAccountDirectoryToken: true },
            preHandler: [app.authenticate, requireDirectoryAuthority],
        },
        async (request: any) => ({ tokenKind: request.authTokenKind }),
    );
    app.get(
        "/present-only",
        {
            config: { allowAccountDirectoryToken: true },
            preHandler: [app.authenticate, requirePresentUser],
        },
        async (request: any) => ({ tokenKind: request.authTokenKind }),
    );
    app.get(
        "/pat",
        {
            config: { allowApiToken: true },
            preHandler: app.authenticate,
        },
        async (request: any) => ({ tokenKind: request.authTokenKind }),
    );
    return app;
}

describe("authentication token admission (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-auth-admission-",
            initAuth: true,
            env: {
                AUTH_REQUIRED_LOGIN_PROVIDERS: "",
                AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: "0",
                AUTH_TOKEN_CACHE_MAX_ENTRIES: "32",
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

    it("keeps Disable between credential verification and eligibility opaque", async () => {
        const account = await db.account.create({ data: {} });
        const token = await auth.createToken(account.id, undefined, { kind: "account", authority: "present_user" });
        const accountDelegate = db.account;
        const originalFindUnique = accountDelegate.findUnique;
        const findUnique = originalFindUnique.bind(accountDelegate);
        let transitioned = false;
        // Schedule the real lifecycle transaction at the Prisma read boundary;
        // token verification and eligibility both retain their real logic.
        accountDelegate.findUnique = (async (args) => {
            const result = await findUnique(args);
            if (!transitioned && args.where.id === account.id && args.select?.tokenEpoch) {
                transitioned = true;
                await inTx((tx) => setAccountStatusInTx(tx, {
                    actorAccountId: account.id, targetAccountId: account.id,
                    status: "disabled", authority: "account_erasure",
                }));
            }
            return result;
        }) as typeof db.account.findUnique;
        const app = createApp();
        try {
            const response = await app.inject({ method: "GET", url: "/ordinary", headers: { authorization: `Bearer ${token}` } });
            expect(transitioned).toBe(true);
            expect(response.statusCode).toBe(401);
            expect(response.json()).toEqual({ error: "invalid_token" });
        } finally {
            accountDelegate.findUnique = originalFindUnique;
            await app.close();
        }
    });

    it("keeps published pre-marker account and terminal tokens on ordinary routes but never admits either to Directory routes", async () => {
        const account = await db.account.create({ data: { publicKey: "auth-admission-legacy" }, select: { id: true } });
        const generator = await privacyKit.createPersistentTokenGenerator({ service: "handy", seed: process.env.HANDY_MASTER_SECRET! });
        const legacyTokens = [
            {
                token: await generator.new({ user: account.id, extras: { tokenEpoch: 0 } }),
                expectedKind: "account",
            },
            {
                token: await generator.new({
                    user: account.id,
                    extras: { tokenEpoch: 0, session: "released-terminal-request" },
                }),
                expectedKind: "terminal",
            },
        ] as const;
        const app = createApp();
        try {
            for (const legacy of legacyTokens) {
                const ordinaryResponse = await app.inject({
                    method: "GET",
                    url: "/ordinary",
                    headers: { authorization: `Bearer ${legacy.token}` },
                });
                const directoryResponse = await app.inject({
                    method: "GET",
                    url: "/directory",
                    headers: { authorization: `Bearer ${legacy.token}` },
                });

                expect(ordinaryResponse.statusCode).toBe(200);
                expect(ordinaryResponse.json()).toEqual({ tokenKind: legacy.expectedKind });
                expect(directoryResponse.statusCode).toBe(401);
                expect(directoryResponse.json()).toEqual({ error: "invalid_token" });
            }
        } finally {
            await app.close();
        }
    });

    it("admits Directory credentials only on an explicit Directory route", async () => {
        const account = await db.account.create({
            data: { publicKey: "auth-admission-directory" },
            select: { id: true },
        });
        const [accountToken, terminalToken, directoryToken, pat] = await Promise.all([
            auth.createToken(account.id, undefined, {
                kind: "account",
                authority: "present_user",
            }),
            auth.createToken(account.id, { session: "admission-terminal" }, {
                kind: "terminal",
                authority: "account_automation",
            }),
            auth.createToken(account.id, undefined, {
                kind: "account_directory",
                authority: "present_user",
            }),
            auth.createApiToken({ accountId: account.id, tokenId: crypto.randomUUID(), label: "admission PAT" }),
        ]);
        const app = createApp();
        await app.ready();

        try {
            const response = async (path: string, token: string) => app.inject({
                method: "GET",
                url: path,
                headers: { authorization: `Bearer ${token}` },
            });
            const [accountOrdinary, accountDirectory, terminalOrdinary, directoryOrdinary,
                directoryDirectory, directoryPresentOnly, patOrdinary, patRoute] = await Promise.all([
                response("/ordinary", accountToken),
                response("/directory", accountToken),
                response("/ordinary", terminalToken),
                response("/ordinary", directoryToken),
                response("/directory", directoryToken),
                response("/present-only", directoryToken),
                response("/ordinary", pat.token),
                response("/pat", pat.token),
            ]);

            expect(accountOrdinary.statusCode).toBe(200);
            expect(accountDirectory.statusCode).toBe(403);
            expect(accountDirectory.json()).toEqual({ error: "invalid_request" });
            expect(terminalOrdinary.statusCode).toBe(200);
            expect(directoryOrdinary.statusCode).toBe(403);
            expect(directoryDirectory.statusCode).toBe(200);
            expect(directoryPresentOnly.statusCode).toBe(403);
            expect(patOrdinary.statusCode).toBe(403);
            expect(patRoute.statusCode).toBe(200);
        } finally {
            await app.close();
        }
    });

    it("admits a terminal credential to person routes by credential class, with or without a caller-attribution ceiling", async () => {
        const account = await db.account.create({ data: { publicKey: "terminal-http-person" } });
        const [token, pat] = await Promise.all([
            auth.createToken(account.id, undefined, { kind: "terminal", authority: "account_automation" }),
            auth.createApiToken({ accountId: account.id, tokenId: crypto.randomUUID(), label: "person-route PAT" }),
        ]);
        const app = createApp();
        try {
            const response = (bearer: string, url: string, ceiling?: string) => app.inject({ method: "GET", url, headers: {
                authorization: `Bearer ${bearer}`,
                ...(ceiling ? { [AUTHORITY_CEILING_HEADER_V1]: ceiling } : {}),
            } });
            // A terminal is the person's own tool: no Account policy is consulted.
            expect((await response(token, "/ordinary-present")).statusCode).toBe(200);
            // The per-invocation ceiling attributes an agent-originated call; the
            // host Action executor's approval policy gates it, not this route.
            expect((await response(token, "/ordinary-present", "account_automation")).statusCode).toBe(200);
            // Scoped credentials are never a person, whatever header they send.
            for (const ceiling of [undefined, "present_user", "account_automation"]) {
                const refused = await response(pat.token, "/pat-present", ceiling);
                expect(refused.statusCode).toBe(403);
                expect(refused.json()).toEqual({ error: "present_user_required" });
            }
        } finally {
            await app.close();
        }
    });

    it("rejects missing and malformed provenance before route handlers", async () => {
        const account = await db.account.create({
            data: { publicKey: "auth-admission-malformed" },
            select: { id: true },
        });
        const generator = await privacyKit.createPersistentTokenGenerator({
            service: "handy",
            seed: String(process.env.HANDY_MASTER_SECRET),
        });
        const token = await generator.new({
            user: account.id,
            extras: { tokenEpoch: 0, provenance: { v: 2, kind: "account", authority: "present_user" } },
        });
        const app = createApp();
        await app.ready();
        try {
            const response = await app.inject({
                method: "GET",
                url: "/ordinary",
                headers: { authorization: `Bearer ${token}` },
            });
            expect(response.statusCode).toBe(401);
        } finally {
            await app.close();
        }
    });

});
