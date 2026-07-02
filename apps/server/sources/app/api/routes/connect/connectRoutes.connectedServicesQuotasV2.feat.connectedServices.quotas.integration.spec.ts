import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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

function createV2QuotaPayload(params: Readonly<{
    ciphertext: string;
    fetchedAt: number;
    fingerprint?: string;
    status?: "ok" | "unavailable" | "estimated" | "error";
}>) {
    return {
        sealed: { format: "account_scoped_v1", ciphertext: params.ciphertext },
        metadata: {
            fetchedAt: params.fetchedAt,
            staleAfterMs: 300000,
            status: params.status ?? "ok",
            ...(params.fingerprint ? { materialFingerprint: params.fingerprint } : {}),
        },
    };
}

function readRefreshRequestedAt(metadata: unknown): number {
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
        throw new Error("Expected quota metadata object with refreshRequestedAt");
    }
    const value = (metadata as { refreshRequestedAt?: unknown }).refreshRequestedAt;
    if (typeof value !== "number") {
        throw new Error("Expected quota metadata refreshRequestedAt");
    }
    return value;
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

    it("does not rewrite sealed quota snapshot bytes when material fingerprint is unchanged and not newer", async () => {
        harness.resetEnv({ HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "1" });
        const user = await db.account.create({ data: { publicKey: "pk-quota-idempotent" }, select: { id: true } });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const fetchedAt = Date.now();
        const first = await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id, "content-type": "application/json" },
            payload: createV2QuotaPayload({ ciphertext: "ciphertext-first", fetchedAt, fingerprint: "hmac:v2-same" }),
        });
        expect(first.statusCode).toBe(200);

        const before = await db.serviceAccountQuotaSnapshot.findUniqueOrThrow({
            where: { accountId_vendor_profileId: { accountId: user.id, vendor: "openai-codex", profileId: "work" } },
            select: { snapshot: true, fetchedAt: true, metadata: true },
        });

        const duplicate = await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id, "content-type": "application/json" },
            payload: createV2QuotaPayload({ ciphertext: "ciphertext-randomized-retry", fetchedAt, fingerprint: "hmac:v2-same" }),
        });
        expect(duplicate.statusCode).toBe(200);

        const after = await db.serviceAccountQuotaSnapshot.findUniqueOrThrow({
            where: { accountId_vendor_profileId: { accountId: user.id, vendor: "openai-codex", profileId: "work" } },
            select: { snapshot: true, fetchedAt: true, metadata: true },
        });
        expect(Buffer.from(after.snapshot).toString("utf8")).toBe(Buffer.from(before.snapshot).toString("utf8"));
        expect(after.fetchedAt?.getTime()).toBe(before.fetchedAt?.getTime());
        expect(after.metadata).toMatchObject({ materialFingerprint: "hmac:v2-same" });
    });

    it("does not let older sealed quota snapshots overwrite newer stored material", async () => {
        harness.resetEnv({ HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "1" });
        const user = await db.account.create({ data: { publicKey: "pk-quota-stale" }, select: { id: true } });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const fetchedAt = Date.now();
        const newer = await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id, "content-type": "application/json" },
            payload: createV2QuotaPayload({ ciphertext: "ciphertext-newer", fetchedAt, fingerprint: "hmac:v2-newer" }),
        });
        expect(newer.statusCode).toBe(200);

        const older = await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id, "content-type": "application/json" },
            payload: createV2QuotaPayload({ ciphertext: "ciphertext-older", fetchedAt: fetchedAt - 1, fingerprint: "hmac:v2-older" }),
        });
        expect(older.statusCode).toBe(200);

        const row = await db.serviceAccountQuotaSnapshot.findUniqueOrThrow({
            where: { accountId_vendor_profileId: { accountId: user.id, vendor: "openai-codex", profileId: "work" } },
            select: { snapshot: true, fetchedAt: true, metadata: true },
        });
        expect(Buffer.from(row.snapshot).toString("utf8")).toBe("ciphertext-newer");
        expect(row.fetchedAt?.getTime()).toBe(fetchedAt);
        expect(row.metadata).toMatchObject({ materialFingerprint: "hmac:v2-newer" });
    });

    it("retries a changed-fingerprint sealed write when a newer writer wins the conditional update race", async () => {
        harness.resetEnv({ HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "1" });
        const user = await db.account.create({ data: { publicKey: "pk-quota-v2-changed-race" }, select: { id: true } });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const fetchedAt = Date.now();
        const competingFetchedAt = fetchedAt + 100;
        const newestFetchedAt = fetchedAt + 200;
        await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id, "content-type": "application/json" },
            payload: createV2QuotaPayload({ ciphertext: "ciphertext-original", fetchedAt, fingerprint: "hmac:v2-original" }),
        });

        const originalRow = await db.serviceAccountQuotaSnapshot.findUniqueOrThrow({
            where: { accountId_vendor_profileId: { accountId: user.id, vendor: "openai-codex", profileId: "work" } },
            select: { id: true, updatedAt: true },
        });

        const quotaSnapshotModel = db.serviceAccountQuotaSnapshot;
        const originalUpdateMany = quotaSnapshotModel.updateMany.bind(quotaSnapshotModel);
        type QuotaSnapshotUpdateManyArgs = Parameters<typeof quotaSnapshotModel.updateMany>[0];
        type QuotaSnapshotUpdateManyResult = ReturnType<typeof quotaSnapshotModel.updateMany>;
        let injectedCompetingWrite = false;
        async function updateManyWithCompetingWrite(args: QuotaSnapshotUpdateManyArgs) {
            if (!injectedCompetingWrite && args?.where?.id === originalRow.id && args?.where?.updatedAt) {
                injectedCompetingWrite = true;
                await quotaSnapshotModel.update({
                    where: { id: originalRow.id },
                    data: {
                        updatedAt: new Date(originalRow.updatedAt.getTime() + 1),
                        snapshot: new TextEncoder().encode("ciphertext-competing"),
                        status: "estimated",
                        fetchedAt: new Date(competingFetchedAt),
                        staleAfterMs: 300000,
                        metadata: { v: 1, format: "account_scoped_v1", materialFingerprint: "hmac:v2-competing" },
                    },
                });
            }
            return await originalUpdateMany(args);
        }
        const updateManySpy = vi.spyOn(quotaSnapshotModel, "updateMany").mockImplementation((args: QuotaSnapshotUpdateManyArgs): QuotaSnapshotUpdateManyResult => {
            // Vitest async mocks return native Promises while Prisma brands delegate results as PrismaPromise.
            return updateManyWithCompetingWrite(args) as unknown as QuotaSnapshotUpdateManyResult;
        });

        try {
            const newest = await app.inject({
                method: "POST",
                url: "/v2/connect/openai-codex/profiles/work/quotas",
                headers: { "x-test-user-id": user.id, "content-type": "application/json" },
                payload: createV2QuotaPayload({ ciphertext: "ciphertext-newest", fetchedAt: newestFetchedAt, fingerprint: "hmac:v2-newest" }),
            });
            expect(newest.statusCode).toBe(200);
        } finally {
            updateManySpy.mockRestore();
            quotaSnapshotModel.updateMany = originalUpdateMany;
        }

        expect(injectedCompetingWrite).toBe(true);
        const row = await db.serviceAccountQuotaSnapshot.findUniqueOrThrow({
            where: { accountId_vendor_profileId: { accountId: user.id, vendor: "openai-codex", profileId: "work" } },
            select: { snapshot: true, fetchedAt: true, metadata: true },
        });
        expect(Buffer.from(row.snapshot).toString("utf8")).toBe("ciphertext-newest");
        expect(row.fetchedAt?.getTime()).toBe(newestFetchedAt);
        expect(row.metadata).toMatchObject({ materialFingerprint: "hmac:v2-newest" });
    });

    it("stores the newest sealed write after repeated refresh metadata races", async () => {
        harness.resetEnv({ HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "1" });
        const user = await db.account.create({ data: { publicKey: "pk-quota-v2-refresh-race" }, select: { id: true } });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const fetchedAt = Date.now();
        const newestFetchedAt = fetchedAt + 200;
        const refreshRequestedAt = newestFetchedAt + 1000;
        await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id, "content-type": "application/json" },
            payload: createV2QuotaPayload({ ciphertext: "ciphertext-original", fetchedAt, fingerprint: "hmac:v2-original" }),
        });

        const originalRow = await db.serviceAccountQuotaSnapshot.findUniqueOrThrow({
            where: { accountId_vendor_profileId: { accountId: user.id, vendor: "openai-codex", profileId: "work" } },
            select: { id: true, updatedAt: true },
        });

        const quotaSnapshotModel = db.serviceAccountQuotaSnapshot;
        const originalUpdateMany = quotaSnapshotModel.updateMany.bind(quotaSnapshotModel);
        type QuotaSnapshotUpdateManyArgs = Parameters<typeof quotaSnapshotModel.updateMany>[0];
        type QuotaSnapshotUpdateManyResult = ReturnType<typeof quotaSnapshotModel.updateMany>;
        let injectedRefreshWrites = 0;
        async function updateManyWithRepeatedRefreshRace(args: QuotaSnapshotUpdateManyArgs) {
            const guardedUpdatedAt = args?.where?.updatedAt;
            if (injectedRefreshWrites < 3 && args?.where?.id === originalRow.id && guardedUpdatedAt instanceof Date) {
                injectedRefreshWrites += 1;
                await quotaSnapshotModel.update({
                    where: { id: originalRow.id },
                    data: {
                        updatedAt: new Date(guardedUpdatedAt.getTime() + 1),
                        metadata: {
                            v: 1,
                            format: "account_scoped_v1",
                            materialFingerprint: "hmac:v2-original",
                            refreshRequestedAt,
                        },
                    },
                });
            }
            return await originalUpdateMany(args);
        }
        const updateManySpy = vi.spyOn(quotaSnapshotModel, "updateMany").mockImplementation((args: QuotaSnapshotUpdateManyArgs): QuotaSnapshotUpdateManyResult => {
            // Vitest async mocks return native Promises while Prisma brands delegate results as PrismaPromise.
            return updateManyWithRepeatedRefreshRace(args) as unknown as QuotaSnapshotUpdateManyResult;
        });

        try {
            const newest = await app.inject({
                method: "POST",
                url: "/v2/connect/openai-codex/profiles/work/quotas",
                headers: { "x-test-user-id": user.id, "content-type": "application/json" },
                payload: createV2QuotaPayload({ ciphertext: "ciphertext-newest", fetchedAt: newestFetchedAt, fingerprint: "hmac:v2-newest" }),
            });
            expect(newest.statusCode).toBe(200);
        } finally {
            updateManySpy.mockRestore();
            quotaSnapshotModel.updateMany = originalUpdateMany;
        }

        expect(injectedRefreshWrites).toBe(3);
        const row = await db.serviceAccountQuotaSnapshot.findUniqueOrThrow({
            where: { accountId_vendor_profileId: { accountId: user.id, vendor: "openai-codex", profileId: "work" } },
            select: { snapshot: true, fetchedAt: true, metadata: true },
        });
        expect(Buffer.from(row.snapshot).toString("utf8")).toBe("ciphertext-newest");
        expect(row.fetchedAt?.getTime()).toBe(newestFetchedAt);
        expect(row.metadata).toMatchObject({
            materialFingerprint: "hmac:v2-newest",
            refreshRequestedAt,
        });
    });

    it("clears a refresh request when a duplicate fingerprint arrives with newer freshness", async () => {
        harness.resetEnv({ HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "1" });
        const user = await db.account.create({ data: { publicKey: "pk-quota-refresh-clear" }, select: { id: true } });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const fetchedAt = Date.now();
        await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id, "content-type": "application/json" },
            payload: createV2QuotaPayload({ ciphertext: "ciphertext-before-refresh", fetchedAt, fingerprint: "hmac:v2-refresh" }),
        });

        const refresh = await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/profiles/work/quotas/refresh",
            headers: { "x-test-user-id": user.id, "content-type": "application/json" },
            payload: {},
        });
        expect(refresh.statusCode).toBe(200);

        const refreshRow = await db.serviceAccountQuotaSnapshot.findUniqueOrThrow({
            where: { accountId_vendor_profileId: { accountId: user.id, vendor: "openai-codex", profileId: "work" } },
            select: { metadata: true },
        });
        const refreshedAt = readRefreshRequestedAt(refreshRow.metadata) + 1;

        const refreshed = await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id, "content-type": "application/json" },
            payload: createV2QuotaPayload({
                ciphertext: "ciphertext-after-refresh",
                fetchedAt: refreshedAt,
                fingerprint: "hmac:v2-refresh",
                status: "estimated",
            }),
        });
        expect(refreshed.statusCode).toBe(200);

        const row = await db.serviceAccountQuotaSnapshot.findUniqueOrThrow({
            where: { accountId_vendor_profileId: { accountId: user.id, vendor: "openai-codex", profileId: "work" } },
            select: { fetchedAt: true, status: true, metadata: true },
        });
        expect(row.fetchedAt?.getTime()).toBe(refreshedAt);
        expect(row.status).toBe("estimated");
        expect(row.metadata).toMatchObject({ materialFingerprint: "hmac:v2-refresh" });
        expect(row.metadata).not.toHaveProperty("refreshRequestedAt");
    });

    it("does not clear a refresh request when a duplicate fingerprint was observed before the request", async () => {
        harness.resetEnv({ HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "1" });
        const user = await db.account.create({ data: { publicKey: "pk-quota-refresh-stale-duplicate" }, select: { id: true } });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const fetchedAt = Date.now() - 10_000;
        await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id, "content-type": "application/json" },
            payload: createV2QuotaPayload({ ciphertext: "ciphertext-before-refresh", fetchedAt, fingerprint: "hmac:v2-refresh-stale" }),
        });

        const refresh = await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/profiles/work/quotas/refresh",
            headers: { "x-test-user-id": user.id, "content-type": "application/json" },
            payload: {},
        });
        expect(refresh.statusCode).toBe(200);

        const refreshRow = await db.serviceAccountQuotaSnapshot.findUniqueOrThrow({
            where: { accountId_vendor_profileId: { accountId: user.id, vendor: "openai-codex", profileId: "work" } },
            select: { metadata: true },
        });
        const refreshRequestedAt = readRefreshRequestedAt(refreshRow.metadata);

        const staleDuplicate = await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id, "content-type": "application/json" },
            payload: createV2QuotaPayload({ ciphertext: "ciphertext-stale-duplicate", fetchedAt, fingerprint: "hmac:v2-refresh-stale" }),
        });
        expect(staleDuplicate.statusCode).toBe(200);

        const row = await db.serviceAccountQuotaSnapshot.findUniqueOrThrow({
            where: { accountId_vendor_profileId: { accountId: user.id, vendor: "openai-codex", profileId: "work" } },
            select: { fetchedAt: true, metadata: true },
        });
        expect(row.fetchedAt?.getTime()).toBe(fetchedAt);
        expect(row.metadata).toMatchObject({ materialFingerprint: "hmac:v2-refresh-stale", refreshRequestedAt });
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

    it("rejects quota refresh requests with non-canonical profile ids", async () => {
        harness.resetEnv({ HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "1" });
        const user = await db.account.create({ data: { publicKey: "pk-quota-refresh-invalid-profile" }, select: { id: true } });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const refresh = await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/profiles/work.bad/quotas/refresh",
            headers: { "x-test-user-id": user.id, "content-type": "application/json" },
            payload: JSON.stringify({}),
        });

        expect(refresh.statusCode).toBe(400);
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
