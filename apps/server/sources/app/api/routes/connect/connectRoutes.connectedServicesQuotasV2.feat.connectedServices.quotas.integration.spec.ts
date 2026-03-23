import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";

import { db } from "@/storage/db";
import { connectRoutes } from "./connectRoutes";
import { auth } from "@/app/auth/auth";
import { createAppCloseTracker } from "../../testkit/appLifecycle";

const { trackApp, closeTrackedApps } = createAppCloseTracker();

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

    return trackApp(typed);
}

describe("connectRoutes (connected services quotas v2) sealed quota snapshot endpoints (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-connected-services-quotas-v2-",
            initAuth: true,
            initEncrypt: true,
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });
    afterEach(async () => {
        await closeTrackedApps();
        harness.resetEnv();
        await (db as any).serviceAccountQuotaSnapshot?.deleteMany?.().catch(() => {});
        await db.serviceAccountToken.deleteMany().catch(() => {});
        await db.account.deleteMany().catch(() => {});
    });

    it("does not register quota snapshot routes when HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED=0", async () => {
        harness.resetEnv({ HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "0" });
        const user = await db.account.create({ data: { publicKey: "pk-quota-disabled" }, select: { id: true } });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "GET",
            url: "/v2/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });
        expect(res.statusCode).toBe(404);
    });

    it("stores and returns sealed quota snapshots when enabled", async () => {
        harness.resetEnv({ HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "1" });
        const user = await db.account.create({ data: { publicKey: "pk-quota-enabled" }, select: { id: true } });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const put = await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id, "content-type": "application/json" },
            payload: JSON.stringify({
                sealed: { format: "account_scoped_v1", ciphertext: "ciphertext-quota-snapshot" },
                metadata: { fetchedAt: Date.now(), staleAfterMs: 300000, status: "ok" },
            }),
        });
        expect(put.statusCode).toBe(200);

        const get = await app.inject({
            method: "GET",
            url: "/v2/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });
        expect(get.statusCode).toBe(200);
        const body = get.json() as any;
        expect(body.sealed?.format).toBe("account_scoped_v1");
        expect(body.sealed?.ciphertext).toBe("ciphertext-quota-snapshot");
        expect(typeof body.metadata?.fetchedAt).toBe("number");
        expect(typeof body.metadata?.staleAfterMs).toBe("number");
        expect(body.metadata?.status).toBe("ok");
    });

    it("accepts a refresh request and exposes refreshRequestedAt in metadata", async () => {
        harness.resetEnv({ HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "1" });
        const user = await db.account.create({ data: { publicKey: "pk-quota-refresh" }, select: { id: true } });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const fetchedAt = Date.now();
        await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id, "content-type": "application/json" },
            payload: JSON.stringify({
                sealed: { format: "account_scoped_v1", ciphertext: "ciphertext-quota-snapshot" },
                metadata: { fetchedAt, staleAfterMs: 300000, status: "ok" },
            }),
        });

        const refresh = await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/profiles/work/quotas/refresh",
            headers: { "x-test-user-id": user.id, "content-type": "application/json" },
            payload: JSON.stringify({}),
        });
        expect(refresh.statusCode).toBe(200);

        const get = await app.inject({
            method: "GET",
            url: "/v2/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });
        const body = get.json() as any;
        expect(typeof body.metadata?.refreshRequestedAt).toBe("number");
        expect(body.metadata.refreshRequestedAt).toBeGreaterThan(0);
    });

    it("accepts a refresh request even when no quota snapshot exists yet", async () => {
        harness.resetEnv({ HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "1" });
        const user = await db.account.create({ data: { publicKey: "pk-quota-refresh-missing" }, select: { id: true } });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const refresh = await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/profiles/work/quotas/refresh",
            headers: { "x-test-user-id": user.id, "content-type": "application/json" },
            payload: JSON.stringify({}),
        });
        expect(refresh.statusCode).toBe(200);

        const row = await (db as any).serviceAccountQuotaSnapshot?.findUnique?.({
            where: { accountId_vendor_profileId: { accountId: user.id, vendor: "openai-codex", profileId: "work" } },
            select: { metadata: true },
        });
        expect(row?.metadata).toBeTruthy();

        const get = await app.inject({
            method: "GET",
            url: "/v2/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });
        expect(get.statusCode).toBe(404);
    });

    it("includes refreshRequestedAt in metadata even when it is 0", async () => {
        harness.resetEnv({ HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "1" });
        const user = await db.account.create({ data: { publicKey: "pk-quota-refresh-zero" }, select: { id: true } });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const fetchedAt = Date.now();
        await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id, "content-type": "application/json" },
            payload: JSON.stringify({
                sealed: { format: "account_scoped_v1", ciphertext: "ciphertext-quota-snapshot" },
                metadata: { fetchedAt, staleAfterMs: 300000, status: "ok" },
            }),
        });

        const existing = await (db as any).serviceAccountQuotaSnapshot?.findUnique?.({
            where: { accountId_vendor_profileId: { accountId: user.id, vendor: "openai-codex", profileId: "work" } },
            select: { id: true, metadata: true },
        });
        expect(existing?.id).toBeTruthy();

        await (db as any).serviceAccountQuotaSnapshot?.update?.({
            where: { id: existing.id },
            data: { metadata: { ...(existing.metadata ?? {}), refreshRequestedAt: 0 } },
        });

        const get = await app.inject({
            method: "GET",
            url: "/v2/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });
        expect(get.statusCode).toBe(200);
        const body = get.json() as any;
        expect(body.metadata).toHaveProperty("refreshRequestedAt");
        expect(body.metadata.refreshRequestedAt).toBe(0);
    });

    it("rejects oversized ciphertext payloads", async () => {
        const user = await db.account.create({ data: { publicKey: "pk-quota-oversize" }, select: { id: true } });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const huge = "x".repeat(400_000);
        const put = await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id, "content-type": "application/json" },
            payload: JSON.stringify({
                sealed: { format: "account_scoped_v1", ciphertext: huge },
                metadata: { fetchedAt: Date.now(), staleAfterMs: 300000, status: "ok" },
            }),
        });
        expect(put.statusCode).toBe(400);
    });
});
