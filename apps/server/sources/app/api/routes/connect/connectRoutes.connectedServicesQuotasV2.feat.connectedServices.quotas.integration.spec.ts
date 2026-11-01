import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
    buildProviderAccountUsageRecordId,
    openSealedProviderAccountUsageSnapshot,
    ProviderAccountUsageSnapshotV1Schema,
    sealProviderAccountUsageSnapshot,
} from "@happier-dev/protocol";

import { db } from "@/storage/db";
import { connectRoutes } from "./connectRoutes";
import { createAppCloseTracker } from "../../testkit/appLifecycle";
import Fastify from "fastify";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createProviderAccountUsageRecordKey } from "./providerAccountUsageTestkit";

const { trackApp, closeTrackedApps } = createAppCloseTracker();

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

async function createConnectedServiceProfileBinding(
    accountId: string,
    params: Readonly<{ providerAccountId?: string | null }> = {},
): Promise<void> {
    await db.serviceAccountToken.create({
        data: {
            accountId,
            vendor: "openai-codex",
            profileId: "work",
            token: Buffer.from("token:openai-codex:work", "utf8"),
            metadata: {
                kind: "oauth",
                providerAccountId: params.providerAccountId ?? "acct_provider_subject",
            },
        },
    });
}

async function createConnectedServiceGroupMember(params: Readonly<{
    accountId: string;
    providerAccountId: string;
    profileId?: string;
    groupId?: string;
    generation?: number;
}>): Promise<void> {
    const profileId = params.profileId ?? "work";
    const groupId = params.groupId ?? "team";
    await createConnectedServiceProfileBinding(params.accountId, {
        providerAccountId: params.providerAccountId,
    });
    const group = await db.connectedServiceAuthGroup.create({
        data: {
            accountId: params.accountId,
            vendor: "openai-codex",
            groupId,
            displayName: "Team",
            policyJson: "{}",
            activeProfileId: profileId,
            generation: params.generation ?? 4,
        },
        select: { id: true },
    });
    await db.connectedServiceAuthGroupMember.create({
        data: {
            groupDbId: group.id,
            accountId: params.accountId,
            vendor: "openai-codex",
            groupId,
            profileId,
            priority: 1,
            enabled: true,
        },
    });
}

describe("connectRoutes (connected services quotas v2) sealed quota endpoints", () => {
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
        await db.connectedServiceUsageSource.deleteMany().catch(() => {});
        await db.providerAccountUsageRecord.deleteMany().catch(() => {});
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

    it("returns sealed connected-service quota views backed by canonical provider-account usage", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "1",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "required_e2ee",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "e2ee",
        });
        const user = await db.account.create({ data: { publicKey: "pk-quota-enabled", encryptionMode: "e2ee" }, select: { id: true } });
        await createConnectedServiceProfileBinding(user.id, { providerAccountId: "acct_quota_v2_projection" });
        const recordKey = createProviderAccountUsageRecordKey({ accountSubjectId: "acct_quota_v2_projection" });
        const recordId = buildProviderAccountUsageRecordId(recordKey);
        const material = { type: "legacy", secret: new Uint8Array(32).fill(7) } as const;
        const snapshot = ProviderAccountUsageSnapshotV1Schema.parse({
            v: 1,
            recordId,
            recordKey,
            providerId: recordKey.providerId,
            accountSubject: { kind: "providerSubject", id: recordKey.accountSubjectId },
            observedAtMs: 1_234,
            fetchedAtMs: 1_234,
            staleAfterMs: 300_000,
            source: "connectedServiceProbe",
            confidence: "confirmed",
            state: "loaded_data",
            meters: [],
            recoveryCredits: {
                kind: "usage_limit_resets",
                availableCount: 0,
                credits: [{ providerCreditId: "saved-reset", kind: "rate_limit_reset", status: "unknown" }],
            },
            recoveryCreditDetails: {
                "saved-reset": {
                    remainingCount: 2,
                    appliesToProviderLimitIds: ["seven_day", "provider_future_window"],
                    unavailableReason: "ineligible",
                },
            },
        });
        const sealed = sealProviderAccountUsageSnapshot({
            material,
            snapshot,
            randomBytes: (length) => new Uint8Array(length).fill(3),
        });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const put = await app.inject({
            method: "POST",
            url: `/v2/connect/provider-account-usage/${recordId}`,
            headers: { "x-test-user-id": user.id, "content-type": "application/json" },
            payload: {
                recordKey,
                source: {
                    serviceId: "openai-codex",
                    profileId: "work",
                    bindingKind: "profile",
                },
                sealed,
                metadata: { fetchedAt: 1_234, staleAfterMs: 300_000, status: "ok", materialFingerprint: "v2:quota" },
            },
        });
        expect(put.statusCode).toBe(200);

        const getQuota = await app.inject({
            method: "GET",
            url: "/v2/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });
        expect(getQuota.statusCode).toBe(200);
        expect(getQuota.json()).toEqual({
            sealed,
            metadata: {
                fetchedAt: 1_234,
                staleAfterMs: 300_000,
                status: "ok",
            },
        });
        expect(openSealedProviderAccountUsageSnapshot({ material, sealed: getQuota.json().sealed })).toEqual(snapshot);

        const getProviderUsage = await app.inject({
            method: "GET",
            url: `/v2/connect/provider-account-usage/${recordId}`,
            headers: { "x-test-user-id": user.id },
        });
        expect(getProviderUsage.statusCode).toBe(200);
        expect(getProviderUsage.json()).toEqual({
            sealed,
            metadata: {
                fetchedAt: 1_234,
                staleAfterMs: 300_000,
                status: "ok",
            },
            sources: [{
                serviceId: "openai-codex",
                profileId: "work",
                bindingKind: "profile",
            }],
        });
    });

    it("rejects source-attached provider-account usage when the source link belongs to another provider account", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "1",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "required_e2ee",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "e2ee",
        });
        const user = await db.account.create({ data: { publicKey: "pk-quota-source-mismatch", encryptionMode: "e2ee" }, select: { id: true } });
        await createConnectedServiceProfileBinding(user.id, { providerAccountId: "acct_connected_profile_subject" });
        const recordKey = createProviderAccountUsageRecordKey({ accountSubjectId: "acct_usage_subject" });
        const recordId = buildProviderAccountUsageRecordId(recordKey);

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const put = await app.inject({
            method: "POST",
            url: `/v2/connect/provider-account-usage/${recordId}`,
            headers: { "x-test-user-id": user.id, "content-type": "application/json" },
            payload: {
                recordKey,
                source: {
                    serviceId: "openai-codex",
                    profileId: "work",
                    bindingKind: "profile",
                },
                sealed: { format: "account_scoped_v1", ciphertext: "ciphertext-source-mismatch" },
                metadata: { fetchedAt: 2_468, staleAfterMs: 300_000, status: "ok" },
            },
        });
        expect(put.statusCode).toBe(400);
        expect(put.json()).toEqual({
            error: "invalid-params",
            reason: "connected_service_usage_source_incompatible",
        });

        expect(await db.connectedServiceUsageSource.findFirst({
            where: {
                    accountId: user.id,
                    serviceId: "openai-codex",
                    profileId: "work",
                
            },
            select: { id: true },
        })).toBeNull();
        expect(await db.providerAccountUsageRecord.findUnique({
            where: {
                accountId_recordId: {
                    accountId: user.id,
                    recordId,
                },
            },
            select: { id: true },
        })).toBeNull();
    });

    it("returns a machine-readable provider/source compatibility reason for rejected source links", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "1",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "required_e2ee",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "e2ee",
        });
        const user = await db.account.create({ data: { publicKey: "pk-quota-source-incompatible", encryptionMode: "e2ee" }, select: { id: true } });
        const recordKey = createProviderAccountUsageRecordKey({ accountSubjectId: "acct_quota_v2_source_incompatible" });
        const recordId = buildProviderAccountUsageRecordId(recordKey);

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const put = await app.inject({
            method: "POST",
            url: `/v2/connect/provider-account-usage/${recordId}`,
            headers: { "x-test-user-id": user.id, "content-type": "application/json" },
            payload: {
                recordKey,
                source: {
                    serviceId: "claude-subscription",
                    profileId: "work",
                    bindingKind: "profile",
                },
                sealed: { format: "account_scoped_v1", ciphertext: "ciphertext-source-incompatible" },
                metadata: { fetchedAt: 3_579, staleAfterMs: 300_000, status: "ok" },
            },
        });

        expect(put.statusCode).toBe(400);
        expect(put.json()).toEqual({
            error: "invalid-params",
            reason: "connected_service_usage_source_incompatible",
        });
    });

    it("keeps sealed quota views readable after a group generation advances when the credential account still matches", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "1",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "required_e2ee",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "e2ee",
        });
        const user = await db.account.create({ data: { publicKey: "pk-quota-stale-generation", encryptionMode: "e2ee" }, select: { id: true } });
        await createConnectedServiceGroupMember({
            accountId: user.id,
            providerAccountId: "acct_quota_v2_stale_generation",
            groupId: "team",
            generation: 4,
        });
        const recordKey = createProviderAccountUsageRecordKey({ accountSubjectId: "acct_quota_v2_stale_generation" });
        const recordId = buildProviderAccountUsageRecordId(recordKey);

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const put = await app.inject({
            method: "POST",
            url: `/v2/connect/provider-account-usage/${recordId}`,
            headers: { "x-test-user-id": user.id, "content-type": "application/json" },
            payload: {
                recordKey,
                source: {
                    serviceId: "openai-codex",
                    profileId: "work",
                    bindingKind: "group_member",
                    groupId: "team",
                    groupGeneration: 4,
                },
                sealed: { format: "account_scoped_v1", ciphertext: "ciphertext-stale-generation" },
                metadata: { fetchedAt: 4_321, staleAfterMs: 300_000, status: "ok" },
            },
        });
        expect(put.statusCode).toBe(200);

        await db.connectedServiceAuthGroup.update({
            where: {
                accountId_vendor_groupId: {
                    accountId: user.id,
                    vendor: "openai-codex",
                    groupId: "team",
                },
            },
            data: { generation: 5 },
        });

        const getQuota = await app.inject({
            method: "GET",
            url: "/v2/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });
        expect(getQuota.statusCode).toBe(200);
        expect(getQuota.json()).toEqual({
            sealed: { format: "account_scoped_v1", ciphertext: "ciphertext-stale-generation" },
            metadata: {
                fetchedAt: 4_321,
                staleAfterMs: 300_000,
                status: "ok",
            },
        });
    });

    it("refreshes the linked provider-account usage record through the quota route", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "1",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "required_e2ee",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "e2ee",
        });
        const user = await db.account.create({ data: { publicKey: "pk-quota-refresh", encryptionMode: "e2ee" }, select: { id: true } });
        await createConnectedServiceProfileBinding(user.id, { providerAccountId: "acct_quota_v2_refresh" });
        const recordKey = createProviderAccountUsageRecordKey({ accountSubjectId: "acct_quota_v2_refresh" });
        const recordId = buildProviderAccountUsageRecordId(recordKey);

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        await app.inject({
            method: "POST",
            url: `/v2/connect/provider-account-usage/${recordId}`,
            headers: { "x-test-user-id": user.id, "content-type": "application/json" },
            payload: {
                recordKey,
                source: {
                    serviceId: "openai-codex",
                    profileId: "work",
                    bindingKind: "profile",
                },
                sealed: { format: "account_scoped_v1", ciphertext: "ciphertext-quota-snapshot" },
                metadata: { fetchedAt: 1_234, staleAfterMs: 300_000, status: "ok" },
            },
        });

        const refresh = await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/profiles/work/quotas/refresh",
            headers: { "x-test-user-id": user.id },
        });
        expect(refresh.statusCode).toBe(200);

        const row = await db.providerAccountUsageRecord.findUnique({
            where: {
                accountId_recordId: {
                    accountId: user.id,
                    recordId,
                },
            },
            select: { refreshRequestedAt: true },
        });
        expect(row?.refreshRequestedAt).not.toBeNull();
    });

    it("deletes quota access by unlinking the source and preserving the sealed provider-account usage record", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "1",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "required_e2ee",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "e2ee",
        });
        const user = await db.account.create({ data: { publicKey: "pk-quota-delete", encryptionMode: "e2ee" }, select: { id: true } });
        await createConnectedServiceProfileBinding(user.id, { providerAccountId: "acct_quota_v2_delete" });
        const recordKey = createProviderAccountUsageRecordKey({ accountSubjectId: "acct_quota_v2_delete" });
        const recordId = buildProviderAccountUsageRecordId(recordKey);

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        await app.inject({
            method: "POST",
            url: `/v2/connect/provider-account-usage/${recordId}`,
            headers: { "x-test-user-id": user.id, "content-type": "application/json" },
            payload: {
                recordKey,
                source: {
                    serviceId: "openai-codex",
                    profileId: "work",
                    bindingKind: "profile",
                },
                sealed: { format: "account_scoped_v1", ciphertext: "ciphertext-quota-snapshot" },
                metadata: { fetchedAt: 1_234, staleAfterMs: 300_000, status: "ok" },
            },
        });

        const deleted = await app.inject({
            method: "DELETE",
            url: "/v2/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });
        expect(deleted.statusCode).toBe(200);

        expect(await db.connectedServiceUsageSource.findFirst({
            where: {
                    accountId: user.id,
                    serviceId: "openai-codex",
                    profileId: "work",
                
            },
            select: { id: true },
        })).toBeNull();

        expect(await db.providerAccountUsageRecord.findUnique({
            where: {
                accountId_recordId: {
                    accountId: user.id,
                    recordId,
                },
            },
            select: { id: true },
        })).not.toBeNull();
    });
});
