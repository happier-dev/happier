import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";

import { db } from "@/storage/db";
import { auth } from "@/app/auth/auth";
import { enableAuthentication } from "../../utils/enableAuthentication";
import { createAppCloseTracker } from "../../testkit/appLifecycle";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { pushRoutes } from "./pushRoutes";

const { trackApp, closeTrackedApps } = createAppCloseTracker();

function createTestApp() {
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as any;
    enableAuthentication(typed);
    pushRoutes(typed);
    return trackApp(typed);
}

describe("pushRoutes (clientServerUrl) (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-push-clientServerUrl-",
            initAuth: true,
            initEncrypt: true,
        });
    }, 120_000);

    afterEach(async () => {
        await closeTrackedApps();
        harness.resetEnv();
        vi.unstubAllGlobals();
        await db.accountPushToken.deleteMany();
        await db.account.deleteMany();
    });

    afterAll(async () => {
        await harness.close();
    });

    it("stores and returns clientServerUrl for each push token", async () => {
        const app = createTestApp();
        const account = await db.account.create({ data: { publicKey: "pk_push_1" } });
        const token = await auth.createToken(account.id);

        const post = await app.inject({
            method: "POST",
            url: "/v1/push-tokens",
            headers: { authorization: `Bearer ${token}` },
            payload: { token: "ExponentPushToken[test-1]", clientServerUrl: "http://lan.example.test:3005/" },
        });
        expect(post.statusCode).toBe(200);

        const get = await app.inject({
            method: "GET",
            url: "/v1/push-tokens",
            headers: { authorization: `Bearer ${token}` },
        });
        expect(get.statusCode).toBe(200);

        const body = get.json() as any;
        expect(body.tokens).toHaveLength(1);
        expect(body.tokens[0]).toMatchObject({
            token: "ExponentPushToken[test-1]",
            clientServerUrl: "http://lan.example.test:3005",
        });
    });

    it("returns clientServerUrl=null when the client hint is invalid", async () => {
        const app = createTestApp();
        const account = await db.account.create({ data: { publicKey: "pk_push_2" } });
        const token = await auth.createToken(account.id);

        const post = await app.inject({
            method: "POST",
            url: "/v1/push-tokens",
            headers: { authorization: `Bearer ${token}` },
            payload: { token: "ExponentPushToken[test-2]", clientServerUrl: "not a url" },
        });
        expect(post.statusCode).toBe(200);

        const get = await app.inject({
            method: "GET",
            url: "/v1/push-tokens",
            headers: { authorization: `Bearer ${token}` },
        });
        expect(get.statusCode).toBe(200);

        const body = get.json() as any;
        expect(body.tokens).toHaveLength(1);
        expect(body.tokens[0]).toMatchObject({
            token: "ExponentPushToken[test-2]",
            clientServerUrl: null,
        });
    });
});
