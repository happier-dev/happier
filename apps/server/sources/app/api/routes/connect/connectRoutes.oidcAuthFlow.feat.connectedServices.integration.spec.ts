import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import tweetnacl from "tweetnacl";
import * as privacyKit from "privacy-kit";

import { db } from "@/storage/db";
import { connectRoutes } from "./connectRoutes";
import { auth } from "@/app/auth/auth";
import { createAppCloseTracker } from "../../testkit/appLifecycle";
import { startOidcStubServer, type OidcStubServer } from "../../testkit/oidcStub";

const { trackApp, closeTrackedApps } = createAppCloseTracker();

import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";


function createTestApp() {
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as any;
    return trackApp(typed);
}

describe("connectRoutes (OIDC callback) external auth flow (integration)", () => {
    const originalFetch = globalThis.fetch;
    let harness: LightSqliteHarness;

    let oidcStub: OidcStubServer;
    let oidcIssuer: string;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-oidc-auth-",
            initAuth: true,
            initEncrypt: true,
        });
        oidcStub = await startOidcStubServer();
        oidcIssuer = oidcStub.issuer;
    }, 120_000);
    afterEach(async () => {
        await closeTrackedApps();
        harness.resetEnv();
        globalThis.fetch = originalFetch;
        oidcStub.reset();
        await db.repeatKey.deleteMany();
        await db.accountIdentity.deleteMany();
        await db.account.deleteMany();
    });

    afterAll(async () => {
        await harness.close();
        globalThis.fetch = originalFetch;
        await oidcStub.close();
    });

    it("creates a pending auth record for an OIDC provider and redirects without creating an account", async () => {
        harness.resetEnv({
            AUTH_SIGNUP_PROVIDERS: "okta",
            AUTH_PROVIDERS_CONFIG_JSON: JSON.stringify([
                {
                    id: "okta",
                    type: "oidc",
                    displayName: "Acme Okta",
                    issuer: oidcIssuer,
                    clientId: "oidc_client",
                    clientSecret: "oidc_secret",
                    redirectUrl: "https://api.example.test/v1/oauth/okta/callback",
                },
            ]),
            HAPPIER_WEBAPP_URL: "https://app.example.test",
        });

        const seed = new Uint8Array(32).fill(1);
        const kp = tweetnacl.sign.keyPair.fromSeed(seed);
        const publicKey = privacyKit.encodeBase64(new Uint8Array(kp.publicKey));

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const paramsRes = await app.inject({
            method: "GET",
            url: `/v1/auth/external/okta/params?publicKey=${encodeURIComponent(publicKey)}`,
        });
        expect(paramsRes.statusCode).toBe(200);
        const paramsUrl = new URL((paramsRes.json() as { url: string }).url);
        expect(paramsUrl.origin).toBe(oidcIssuer);
        expect(paramsUrl.pathname).toBe("/authorize");

        const authRes = await fetch(paramsUrl.toString(), { redirect: "manual" });
        expect(authRes.status).toBe(302);
        const location = authRes.headers.get("location");
        expect(location).toBeTruthy();

        const callback = new URL(location!);
        const res = await app.inject({
            method: "GET",
            url: `${callback.pathname}${callback.search}`,
        });

        expect(res.statusCode).toBe(302);
        const redirect = new URL(res.headers.location as string);
        expect(redirect.origin + redirect.pathname).toBe("https://app.example.test/oauth/okta");
        expect(redirect.searchParams.get("flow")).toBe("auth");
        const pending = redirect.searchParams.get("pending");
        expect(pending).toBeTruthy();

        const pendingRow = await db.repeatKey.findUnique({ where: { key: pending as string } });
        expect(pendingRow).toBeTruthy();
        const accounts = await db.account.findMany();
        expect(accounts.length).toBe(0);

        await app.close();
    });
});
