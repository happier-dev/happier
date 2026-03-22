import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";

import { db } from "@/storage/db";
import { userRoutes } from "./userRoutes";
import { auth } from "@/app/auth/auth";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

function createTestApp() {
    const app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as any;

    typed.decorate("authenticate", async (request: any, reply: any) => {
        const userId = request.headers["x-test-user-id"];
        if (typeof userId !== "string" || !userId) {
            return reply.code(401).send({ error: "Unauthorized" });
        }
        request.userId = userId;
    });

    return typed;
}

describe("userRoutes (profile badges) (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-user-badges-",
            initAuth: true,
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    afterEach(() => {
        harness.resetEnv();
        vi.unstubAllGlobals();
    });

    it("includes GitHub badge when an identity is linked and showOnProfile=true", async () => {
        const app = createTestApp();
        await userRoutes(app as any);
        await app.ready();

        const viewer = await db.account.create({ data: { publicKey: "pk-viewer", username: "viewer" }, select: { id: true } });
        const target = await db.account.create({ data: { publicKey: "pk-target", username: "target" }, select: { id: true } });

        await db.accountIdentity.create({
            data: {
                accountId: target.id,
                provider: "github",
                providerUserId: "123",
                providerLogin: "octocat",
                profile: { id: 123, login: "octocat", name: "Octo Cat", avatar_url: "x" } as any,
                showOnProfile: true,
            },
        });

        const res = await app.inject({
            method: "GET",
            url: `/v1/user/${encodeURIComponent(target.id)}`,
            headers: { "x-test-user-id": viewer.id },
        });

        expect(res.statusCode).toBe(200);
        const body = res.json() as any;
        expect(body.user?.badges).toEqual([
            {
                id: "github",
                label: "@octocat",
                url: "https://github.com/octocat",
            },
        ]);

        await app.close();
    });

    it("returns publicKey=null for keyless accounts", async () => {
        const app = createTestApp();
        await userRoutes(app as any);
        await app.ready();

        const viewer = await db.account.create({ data: { publicKey: "pk-viewer-keyless", username: "viewer_keyless" }, select: { id: true } });
        const target = await db.account.create({
            // TDD: keyless accounts allow publicKey to be null.
            data: { publicKey: null as any, username: "target_keyless" },
            select: { id: true },
        });

        const res = await app.inject({
            method: "GET",
            url: `/v1/user/${encodeURIComponent(target.id)}`,
            headers: { "x-test-user-id": viewer.id },
        });

        expect(res.statusCode).toBe(200);
        const body = res.json() as any;
        expect(body.user?.publicKey).toBeNull();

        await app.close();
    });
});
