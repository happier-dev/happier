import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";

import {
    buildProviderAccountUsageRecordId,
    ConnectedServiceQuotaSnapshotV1Schema,
    ProviderAccountUsageSnapshotV1Schema,
} from "@happier-dev/protocol";

import { db } from "@/storage/db";
import { connectRoutes } from "./connectRoutes";
import { auth } from "@/app/auth/auth";
import { createAppCloseTracker } from "../../testkit/appLifecycle";
import { encodeUtf8Bytes } from "./connectedServicesV3/bytesCodec";
import { PROVIDER_ACCOUNT_USAGE_VENDOR, buildProviderAccountUsageMetadata } from "./providerAccountUsageStorage";

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

function createPlainQuotaSnapshot(params: Readonly<{
    fetchedAt: number;
    planLabel?: string | null;
    remaining?: number;
}>) {
    return ConnectedServiceQuotaSnapshotV1Schema.parse({
        v: 1,
        serviceId: "openai-codex",
        profileId: "work",
        fetchedAt: params.fetchedAt,
        staleAfterMs: 60_000,
        planLabel: params.planLabel ?? null,
        accountLabel: null,
        meters: [
            {
                meterId: "weekly",
                label: "Weekly",
                used: params.remaining === undefined ? 0 : 100 - params.remaining,
                limit: 100,
                unit: "count",
                utilizationPct: null,
                resetsAt: null,
                status: "ok",
                details: {},
            },
        ],
    });
}

function createV3QuotaPayload(params: Readonly<{
    snapshot: ReturnType<typeof createPlainQuotaSnapshot>;
    fingerprint?: string;
    status?: "ok" | "unavailable" | "estimated" | "error";
}>) {
    return {
        content: { t: "plain", v: params.snapshot },
        metadata: {
            fetchedAt: params.snapshot.fetchedAt,
            staleAfterMs: params.snapshot.staleAfterMs,
            status: params.status ?? "ok",
            ...(params.fingerprint ? { materialFingerprint: params.fingerprint } : {}),
        },
    };
}

const OPENAI_CODEX_WORK_PROVIDER_ACCOUNT_USAGE_RECORD_ID = buildProviderAccountUsageRecordId({
    providerId: "openai-codex",
    accountSubjectId: "connected-service:openai-codex:work",
    subjectKind: "unknown",
    quotaScope: "account",
});

function canonicalQuotaUniqueWhere(accountId: string) {
    return {
        accountId_vendor_profileId: {
            accountId,
            vendor: PROVIDER_ACCOUNT_USAGE_VENDOR,
            profileId: OPENAI_CODEX_WORK_PROVIDER_ACCOUNT_USAGE_RECORD_ID,
        },
    };
}

function canonicalQuotaFilter(accountId: string) {
    return {
        accountId,
        vendor: PROVIDER_ACCOUNT_USAGE_VENDOR,
        profileId: OPENAI_CODEX_WORK_PROVIDER_ACCOUNT_USAGE_RECORD_ID,
    };
}

function createStoredProviderAccountUsageSnapshot(params: Readonly<{
    fetchedAt: number;
    planLabel?: string | null;
    remaining?: number;
}>) {
    const quota = createPlainQuotaSnapshot(params);
    return ProviderAccountUsageSnapshotV1Schema.parse({
        v: 1,
        recordId: OPENAI_CODEX_WORK_PROVIDER_ACCOUNT_USAGE_RECORD_ID,
        recordKey: {
            providerId: "openai-codex",
            accountSubjectId: "connected-service:openai-codex:work",
            subjectKind: "unknown",
            quotaScope: "account",
        },
        providerId: "openai-codex",
        accountSubject: {
            kind: "provisionalLocalSubject",
            id: "connected-service:openai-codex:work",
        },
        aliases: [
            {
                kind: "connectedServiceProfile",
                providerId: "openai-codex",
                serviceId: "openai-codex",
                profileId: "work",
                accountSubjectId: "connected-service:openai-codex:work",
            },
        ],
        observedAtMs: quota.fetchedAt,
        fetchedAtMs: quota.fetchedAt,
        staleAfterMs: quota.staleAfterMs,
        source: "connectedServiceProbe",
        confidence: "unknown",
        planLabel: quota.planLabel,
        accountLabel: quota.accountLabel,
        meters: quota.meters,
    });
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

describe("connectRoutes (connected services quotas v3) plaintext quota endpoints (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-connected-services-quotas-v3-",
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
        vi.unstubAllGlobals();
        await db.serviceAccountQuotaSnapshot.deleteMany().catch(() => {});
        await db.account.deleteMany().catch(() => {});
    });

    it("stores and returns a plaintext quota envelope for plaintext accounts (server sealed at rest)", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "server_sealed",
        });

        const user = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });

        const now = Date.now();
        const snapshot = ConnectedServiceQuotaSnapshotV1Schema.parse({
            v: 1,
            serviceId: "openai-codex",
            profileId: "work",
            fetchedAt: now,
            staleAfterMs: 60_000,
            planLabel: "plan-secret-12345",
            accountLabel: null,
            meters: [
                {
                    meterId: "weekly",
                    label: "Weekly",
                    used: 82,
                    limit: 100,
                    unit: "count",
                    utilizationPct: null,
                    resetsAt: null,
                    status: "ok",
                    details: {},
                },
            ],
        });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const register = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/profiles/work/quotas",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                content: { t: "plain", v: snapshot },
                metadata: { fetchedAt: snapshot.fetchedAt, staleAfterMs: snapshot.staleAfterMs, status: "ok" },
            },
        });
        expect(register.statusCode).toBe(200);
        expect(register.json()).toEqual({ success: true });

        const getOne = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });
        expect(getOne.statusCode).toBe(200);
        expect(getOne.json()).toEqual({
            content: { t: "plain", v: expect.any(Object) },
            metadata: {
                fetchedAt: snapshot.fetchedAt,
                staleAfterMs: snapshot.staleAfterMs,
                status: "ok",
            },
        });

        const row = await db.serviceAccountQuotaSnapshot.findUnique({
            where: canonicalQuotaUniqueWhere(user.id),
            select: { snapshot: true },
        });
        expect(row).not.toBeNull();
        const snapshotUtf8 = Buffer.from(row!.snapshot).toString("utf8");
        expect(snapshotUtf8.includes("plan-secret-12345")).toBe(false);
    });

    it("does not rewrite plaintext quota snapshot bytes when material fingerprint is unchanged and not newer", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });

        const user = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const fetchedAt = Date.now();
        const first = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/profiles/work/quotas",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: createV3QuotaPayload({
                snapshot: createPlainQuotaSnapshot({ fetchedAt, planLabel: "first-plan", remaining: 20 }),
                fingerprint: "hmac:v3-same",
            }),
        });
        expect(first.statusCode).toBe(200);

        const before = await db.serviceAccountQuotaSnapshot.findUniqueOrThrow({
            where: canonicalQuotaUniqueWhere(user.id),
            select: { snapshot: true, fetchedAt: true, metadata: true },
        });

        const duplicate = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/profiles/work/quotas",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: createV3QuotaPayload({
                snapshot: createPlainQuotaSnapshot({ fetchedAt, planLabel: "retry-plan", remaining: 10 }),
                fingerprint: "hmac:v3-same",
            }),
        });
        expect(duplicate.statusCode).toBe(200);

        const after = await db.serviceAccountQuotaSnapshot.findUniqueOrThrow({
            where: canonicalQuotaUniqueWhere(user.id),
            select: { snapshot: true, fetchedAt: true, metadata: true },
        });
        expect(Buffer.from(after.snapshot).toString("utf8")).toBe(Buffer.from(before.snapshot).toString("utf8"));
        expect(after.fetchedAt?.getTime()).toBe(before.fetchedAt?.getTime());
        expect(after.metadata).toMatchObject({ materialFingerprint: "hmac:v3-same" });
    });

    it("refreshes plaintext quota snapshot bytes when material fingerprint is unchanged but fetchedAt is newer", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });

        const user = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const fetchedAt = Date.now();
        const first = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/profiles/work/quotas",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: createV3QuotaPayload({
                snapshot: createPlainQuotaSnapshot({ fetchedAt, planLabel: "first-plan", remaining: 20 }),
                fingerprint: "hmac:v3-freshness",
            }),
        });
        expect(first.statusCode).toBe(200);

        const newer = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/profiles/work/quotas",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: createV3QuotaPayload({
                snapshot: createPlainQuotaSnapshot({ fetchedAt: fetchedAt + 1, planLabel: "newer-plan", remaining: 5 }),
                fingerprint: "hmac:v3-freshness",
                status: "estimated",
            }),
        });
        expect(newer.statusCode).toBe(200);

        const getOne = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });
        expect(getOne.statusCode).toBe(200);
        const body = getOne.json() as any;
        expect(body.content.v.planLabel).toBe("newer-plan");
        expect(body.metadata.fetchedAt).toBe(fetchedAt + 1);
        expect(body.metadata.status).toBe("estimated");
    });

    it("does not clear plaintext quota refresh markers when a duplicate fingerprint was observed before the request", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });

        const user = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const fetchedAt = Date.now() - 10_000;
        const first = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/profiles/work/quotas",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: createV3QuotaPayload({
                snapshot: createPlainQuotaSnapshot({ fetchedAt, planLabel: "before-refresh", remaining: 10 }),
                fingerprint: "hmac:v3-refresh-stale",
            }),
        });
        expect(first.statusCode).toBe(200);

        const refresh = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/profiles/work/quotas/refresh",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {},
        });
        expect(refresh.statusCode).toBe(200);

        const refreshRow = await db.serviceAccountQuotaSnapshot.findUniqueOrThrow({
            where: canonicalQuotaUniqueWhere(user.id),
            select: { metadata: true },
        });
        const refreshRequestedAt = readRefreshRequestedAt(refreshRow.metadata);

        const staleDuplicate = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/profiles/work/quotas",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: createV3QuotaPayload({
                snapshot: createPlainQuotaSnapshot({ fetchedAt, planLabel: "stale-duplicate", remaining: 5 }),
                fingerprint: "hmac:v3-refresh-stale",
            }),
        });
        expect(staleDuplicate.statusCode).toBe(200);

        const row = await db.serviceAccountQuotaSnapshot.findUniqueOrThrow({
            where: canonicalQuotaUniqueWhere(user.id),
            select: { fetchedAt: true, metadata: true },
        });
        expect(row.fetchedAt?.getTime()).toBe(fetchedAt);
        expect(row.metadata).toMatchObject({ materialFingerprint: "hmac:v3-refresh-stale", refreshRequestedAt });
    });

    it("clears plaintext quota refresh markers when a duplicate fingerprint is observed after the refresh request", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });

        const user = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const fetchedAt = Date.now() - 10_000;
        const first = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/profiles/work/quotas",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: createV3QuotaPayload({
                snapshot: createPlainQuotaSnapshot({ fetchedAt, planLabel: "before-refresh", remaining: 10 }),
                fingerprint: "hmac:v3-refresh-fresh",
            }),
        });
        expect(first.statusCode).toBe(200);

        const refresh = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/profiles/work/quotas/refresh",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {},
        });
        expect(refresh.statusCode).toBe(200);

        const refreshRow = await db.serviceAccountQuotaSnapshot.findUniqueOrThrow({
            where: canonicalQuotaUniqueWhere(user.id),
            select: { metadata: true },
        });
        const refreshedAt = readRefreshRequestedAt(refreshRow.metadata) + 1;

        const freshDuplicate = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/profiles/work/quotas",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: createV3QuotaPayload({
                snapshot: createPlainQuotaSnapshot({ fetchedAt: refreshedAt, planLabel: "after-refresh", remaining: 5 }),
                fingerprint: "hmac:v3-refresh-fresh",
                status: "estimated",
            }),
        });
        expect(freshDuplicate.statusCode).toBe(200);

        const row = await db.serviceAccountQuotaSnapshot.findUniqueOrThrow({
            where: canonicalQuotaUniqueWhere(user.id),
            select: { fetchedAt: true, metadata: true, status: true },
        });
        expect(row.fetchedAt?.getTime()).toBe(refreshedAt);
        expect(row.status).toBe("estimated");
        expect(row.metadata).toMatchObject({ materialFingerprint: "hmac:v3-refresh-fresh" });
        expect(row.metadata).not.toHaveProperty("refreshRequestedAt");
    });

    it("does not let older plaintext quota snapshots overwrite newer stored material", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });

        const user = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const fetchedAt = Date.now();
        const first = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/profiles/work/quotas",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: createV3QuotaPayload({
                snapshot: createPlainQuotaSnapshot({ fetchedAt, planLabel: "newer-plan", remaining: 10 }),
                fingerprint: "hmac:v3-newer",
            }),
        });
        expect(first.statusCode).toBe(200);

        const older = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/profiles/work/quotas",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: createV3QuotaPayload({
                snapshot: createPlainQuotaSnapshot({ fetchedAt: fetchedAt - 1, planLabel: "older-plan", remaining: 1 }),
                fingerprint: "hmac:v3-older",
            }),
        });
        expect(older.statusCode).toBe(200);

        const getOne = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });
        expect(getOne.statusCode).toBe(200);
        const body = getOne.json() as any;
        expect(body.content.v.planLabel).toBe("newer-plan");
        expect(body.metadata.fetchedAt).toBe(fetchedAt);

        const row = await db.serviceAccountQuotaSnapshot.findUniqueOrThrow({
            where: canonicalQuotaUniqueWhere(user.id),
            select: { metadata: true },
        });
        expect(row.metadata).toMatchObject({ materialFingerprint: "hmac:v3-newer" });
    });

    it("retries a changed-fingerprint plaintext write when a newer writer wins the conditional update race", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });

        const user = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const fetchedAt = Date.now();
        const competingFetchedAt = fetchedAt + 100;
        const newestFetchedAt = fetchedAt + 200;
        await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/profiles/work/quotas",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: createV3QuotaPayload({
                snapshot: createPlainQuotaSnapshot({ fetchedAt, planLabel: "original-plan", remaining: 10 }),
                fingerprint: "hmac:v3-original",
            }),
        });

        const originalRow = await db.serviceAccountQuotaSnapshot.findUniqueOrThrow({
            where: canonicalQuotaUniqueWhere(user.id),
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
                        snapshot: encodeUtf8Bytes(JSON.stringify(createStoredProviderAccountUsageSnapshot({
                            fetchedAt: competingFetchedAt,
                            planLabel: "competing-plan",
                            remaining: 5,
                        }))),
                        status: "estimated",
                        fetchedAt: new Date(competingFetchedAt),
                        staleAfterMs: 60_000,
                        metadata: buildProviderAccountUsageMetadata({
                            recordId: OPENAI_CODEX_WORK_PROVIDER_ACCOUNT_USAGE_RECORD_ID,
                            storage: "plain_json_v1",
                            materialFingerprint: "hmac:v3-competing",
                        }),
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
                url: "/v3/connect/openai-codex/profiles/work/quotas",
                headers: { "content-type": "application/json", "x-test-user-id": user.id },
                payload: createV3QuotaPayload({
                    snapshot: createPlainQuotaSnapshot({ fetchedAt: newestFetchedAt, planLabel: "newest-plan", remaining: 3 }),
                    fingerprint: "hmac:v3-newest",
                }),
            });
            expect(newest.statusCode).toBe(200);
        } finally {
            updateManySpy.mockRestore();
            quotaSnapshotModel.updateMany = originalUpdateMany;
        }

        expect(injectedCompetingWrite).toBe(true);
        const row = await db.serviceAccountQuotaSnapshot.findUniqueOrThrow({
            where: canonicalQuotaUniqueWhere(user.id),
            select: { fetchedAt: true, metadata: true },
        });
        expect(row.fetchedAt?.getTime()).toBe(newestFetchedAt);
        expect(row.metadata).toMatchObject({ materialFingerprint: "hmac:v3-newest" });

        const getOne = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });
        expect(getOne.statusCode).toBe(200);
        expect((getOne.json() as any).content.v.planLabel).toBe("newest-plan");
    });

    it("stores the newest plaintext write after repeated refresh metadata races", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });

        const user = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const fetchedAt = Date.now();
        const newestFetchedAt = fetchedAt + 200;
        const refreshRequestedAt = newestFetchedAt + 1000;
        await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/profiles/work/quotas",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: createV3QuotaPayload({
                snapshot: createPlainQuotaSnapshot({ fetchedAt, planLabel: "original-plan", remaining: 10 }),
                fingerprint: "hmac:v3-original",
            }),
        });

        const originalRow = await db.serviceAccountQuotaSnapshot.findUniqueOrThrow({
            where: canonicalQuotaUniqueWhere(user.id),
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
                            kind: "provider_account_usage",
                            recordId: OPENAI_CODEX_WORK_PROVIDER_ACCOUNT_USAGE_RECORD_ID,
                            storage: "plain_json_v1",
                            materialFingerprint: "hmac:v3-original",
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
                url: "/v3/connect/openai-codex/profiles/work/quotas",
                headers: { "content-type": "application/json", "x-test-user-id": user.id },
                payload: createV3QuotaPayload({
                    snapshot: createPlainQuotaSnapshot({ fetchedAt: newestFetchedAt, planLabel: "newest-plan", remaining: 3 }),
                    fingerprint: "hmac:v3-newest",
                }),
            });
            expect(newest.statusCode).toBe(200);
        } finally {
            updateManySpy.mockRestore();
            quotaSnapshotModel.updateMany = originalUpdateMany;
        }

        expect(injectedRefreshWrites).toBe(3);
        const row = await db.serviceAccountQuotaSnapshot.findUniqueOrThrow({
            where: canonicalQuotaUniqueWhere(user.id),
            select: { fetchedAt: true, metadata: true },
        });
        expect(row.fetchedAt?.getTime()).toBe(newestFetchedAt);
        expect(row.metadata).toMatchObject({
            materialFingerprint: "hmac:v3-newest",
            refreshRequestedAt,
        });

        const getOne = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });
        expect(getOne.statusCode).toBe(200);
        expect((getOne.json() as any).content.v.planLabel).toBe("newest-plan");
    });

    it("adds refreshRequestedAt in metadata when requesting a refresh", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
        });

        const user = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });

        const now = Date.now();
        const snapshot = ConnectedServiceQuotaSnapshotV1Schema.parse({
            v: 1,
            serviceId: "openai-codex",
            profileId: "work",
            fetchedAt: now,
            staleAfterMs: 60_000,
            planLabel: null,
            accountLabel: null,
            meters: [],
        });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const register = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/profiles/work/quotas",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                content: { t: "plain", v: snapshot },
                metadata: { fetchedAt: snapshot.fetchedAt, staleAfterMs: snapshot.staleAfterMs, status: "ok" },
            },
        });
        expect(register.statusCode).toBe(200);

        const refresh = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/profiles/work/quotas/refresh",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {},
        });
        expect(refresh.statusCode).toBe(200);
        expect(refresh.json()).toEqual({ success: true });

        const getOne = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });
        expect(getOne.statusCode).toBe(200);
        const body = getOne.json() as any;
        expect(body.metadata.refreshRequestedAt).toEqual(expect.any(Number));
        expect(body.metadata.refreshRequestedAt).toBeGreaterThanOrEqual(snapshot.fetchedAt);
    });

    it("returns not found for a server-sealed refresh placeholder before the first quota snapshot exists", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "server_sealed",
        });

        const user = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const refresh = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/profiles/work/quotas/refresh",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {},
        });
        expect(refresh.statusCode).toBe(200);

        const getOne = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });
        expect(getOne.statusCode).toBe(404);
        expect(getOne.json()).toEqual({ error: "connect_quotas_not_found" });
    });

    it("rejects quota refresh requests with non-canonical profile ids", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
        });

        const user = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const refresh = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/profiles/work.bad/quotas/refresh",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {},
        });

        expect(refresh.statusCode).toBe(400);
    });

    it("preserves existing quota snapshot storage metadata when recording refresh requests after at-rest policy changes", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "server_sealed",
        });

        const user = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });

        const now = Date.now();
        const snapshot = ConnectedServiceQuotaSnapshotV1Schema.parse({
            v: 1,
            serviceId: "openai-codex",
            profileId: "work",
            fetchedAt: now,
            staleAfterMs: 60_000,
            planLabel: "plan-secret-12345",
            accountLabel: null,
            meters: [],
        });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const register = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/profiles/work/quotas",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                content: { t: "plain", v: snapshot },
                metadata: { fetchedAt: snapshot.fetchedAt, staleAfterMs: snapshot.staleAfterMs, status: "ok" },
            },
        });
        expect(register.statusCode).toBe(200);

        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });

        const refresh = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/profiles/work/quotas/refresh",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {},
        });
        expect(refresh.statusCode).toBe(200);

        const getOne = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });
        expect(getOne.statusCode).toBe(200);
        const body = getOne.json() as any;
        expect(body.content.v.planLabel).toBe("plan-secret-12345");
        expect(body.metadata.refreshRequestedAt).toEqual(expect.any(Number));
    });

    it("handles concurrent first refresh requests for the same quota placeholder", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "server_sealed",
        });

        const user = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const [first, second] = await Promise.all([
            app.inject({
                method: "POST",
                url: "/v3/connect/openai-codex/profiles/work/quotas/refresh",
                headers: { "content-type": "application/json", "x-test-user-id": user.id },
                payload: {},
            }),
            app.inject({
                method: "POST",
                url: "/v3/connect/openai-codex/profiles/work/quotas/refresh",
                headers: { "content-type": "application/json", "x-test-user-id": user.id },
                payload: {},
            }),
        ]);
        expect(first.statusCode).toBe(200);
        expect(second.statusCode).toBe(200);

        const rows = await db.serviceAccountQuotaSnapshot.findMany({
            where: canonicalQuotaFilter(user.id),
            select: { metadata: true, snapshot: true },
        });
        expect(rows).toHaveLength(1);
        expect(rows[0]?.snapshot.byteLength).toBe(0);
        expect(rows[0]?.metadata).toMatchObject({ kind: "provider_account_usage", storage: "server_sealed_json_v1" });
    });

    it("rejects plaintext quota content for e2ee accounts", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "required_e2ee",
        });

        const user = await db.account.create({
            data: { publicKey: "pk-v3-e2ee", encryptionMode: "e2ee" },
            select: { id: true },
        });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/profiles/work/quotas",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: { content: { t: "plain", v: {} }, metadata: { fetchedAt: 1, staleAfterMs: 60_000, status: "ok" } },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ error: "invalid-params" });
    });

    it("does not return v3 plaintext quota snapshots for e2ee accounts (defense-in-depth)", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "required_e2ee",
        });

        const user = await db.account.create({
            data: { publicKey: "pk-v3-e2ee", encryptionMode: "e2ee" },
            select: { id: true },
        });

        const now = Date.now();
        const snapshot = {
            v: 1,
            serviceId: "openai-codex",
            profileId: "work",
            fetchedAt: now,
            staleAfterMs: 60_000,
            planLabel: null,
            accountLabel: null,
            meters: [],
        };

        await db.serviceAccountQuotaSnapshot.create({
            data: {
                accountId: user.id,
                vendor: "openai-codex",
                profileId: "work",
                snapshot: Buffer.from(JSON.stringify(snapshot), "utf8"),
                status: "ok",
                fetchedAt: new Date(now),
                staleAfterMs: 60_000,
                metadata: { v: 3, storage: "plain_json_v1" },
            },
        });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const getOne = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });
        expect(getOne.statusCode).toBe(404);
        expect(getOne.json()).toEqual({ error: "connect_quotas_not_found" });
    });
});
