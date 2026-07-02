import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { db } from "@/storage/db";
import { connectRoutes } from "./connectRoutes";
import { auth } from "@/app/auth/auth";
import { PROVIDER_ACCOUNT_USAGE_VENDOR } from "./providerAccountUsageStorage";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import {
    buildProviderAccountUsageTestRecordId,
    closeProviderAccountUsageTrackedApps,
    createLegacyQuotaSnapshot,
    createProviderAccountUsageTestApp,
    createUsageSnapshot,
    createV3ProviderAccountUsagePayload,
    type ProviderAccountUsageRecordKeyV1,
} from "./providerAccountUsageTestkit";

describe("connectRoutes (provider account usage compatibility projections)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-provider-account-usage-compat-",
            initAuth: true,
            initEncrypt: true,
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    afterEach(async () => {
        await closeProviderAccountUsageTrackedApps();
        harness.resetEnv();
        vi.unstubAllGlobals();
        await db.serviceAccountQuotaSnapshot.deleteMany().catch(() => {});
        await db.account.deleteMany().catch(() => {});
    });

    it("projects canonical connected-service aliases through the v3 compatibility quota route", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        const snapshot = createUsageSnapshot({ fetchedAt: Date.now(), planLabel: "team" });

        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as any);
        await app.ready();
        await app.inject({
            method: "POST",
            url: `/v3/connect/provider-account-usage/${snapshot.recordId}`,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: createV3ProviderAccountUsagePayload({ snapshot, fingerprint: "usage:v3:projection" }),
        });

        const projected = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });

        expect(projected.statusCode).toBe(200);
        expect(projected.json()).toEqual({
            content: {
                t: "plain",
                v: expect.objectContaining({
                    serviceId: "openai-codex",
                    profileId: "work",
                    providerId: "codex",
                    activeAccountId: "acct_secret_provider_subject",
                    planLabel: "team",
                }),
            },
            metadata: {
                fetchedAt: snapshot.fetchedAtMs,
                staleAfterMs: snapshot.staleAfterMs,
                status: "ok",
            },
        });
    });

    it("projects canonical connected-service aliases even when the matching record is older than recent unrelated usage rows", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        const baseFetchedAt = Date.now();
        const targetSnapshot = createUsageSnapshot({ fetchedAt: baseFetchedAt, planLabel: "team" });

        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as any);
        await app.ready();

        const writeTarget = await app.inject({
            method: "POST",
            url: `/v3/connect/provider-account-usage/${targetSnapshot.recordId}`,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: createV3ProviderAccountUsagePayload({ snapshot: targetSnapshot, fingerprint: "usage:v3:older-target" }),
        });
        expect(writeTarget.statusCode).toBe(200);

        for (let index = 0; index < 51; index += 1) {
            const accountSubjectId = `acct_unrelated_${index}`;
            const snapshot = {
                ...createUsageSnapshot({
                    fetchedAt: baseFetchedAt + index + 1,
                    recordKey: {
                        providerId: "codex",
                        accountSubjectId,
                        subjectKind: "account",
                        quotaScope: "account",
                    },
                }),
                aliases: [
                    {
                        kind: "connectedServiceProfile",
                        providerId: "codex",
                        serviceId: "openai-codex",
                        profileId: `unrelated-${index}`,
                        accountSubjectId,
                    },
                ],
            };
            const write = await app.inject({
                method: "POST",
                url: `/v3/connect/provider-account-usage/${snapshot.recordId}`,
                headers: { "content-type": "application/json", "x-test-user-id": user.id },
                payload: createV3ProviderAccountUsagePayload({ snapshot, fingerprint: `usage:v3:unrelated-${index}` }),
            });
            expect(write.statusCode).toBe(200);
        }

        const projected = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });

        expect(projected.statusCode).toBe(200);
        expect(projected.json()).toEqual({
            content: {
                t: "plain",
                v: expect.objectContaining({
                    serviceId: "openai-codex",
                    profileId: "work",
                    providerId: "codex",
                    activeAccountId: "acct_secret_provider_subject",
                    planLabel: "team",
                }),
            },
            metadata: {
                fetchedAt: targetSnapshot.fetchedAtMs,
                staleAfterMs: targetSnapshot.staleAfterMs,
                status: "ok",
            },
        });
    });

    it("canonicalizes legacy v3 connected-service quota writes instead of persisting service profile rows", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        const fetchedAt = Date.now();
        const legacySnapshot = createLegacyQuotaSnapshot({ fetchedAt });
        const expectedRecordKey = {
            providerId: "codex",
            accountSubjectId: "acct_legacy_connected_subject",
            subjectKind: "account",
            quotaScope: "account",
        } satisfies ProviderAccountUsageRecordKeyV1;
        const expectedRecordId = buildProviderAccountUsageTestRecordId(expectedRecordKey);

        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as any);
        await app.ready();

        const write = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/profiles/work/quotas",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                content: { t: "plain", v: legacySnapshot },
                metadata: {
                    fetchedAt,
                    staleAfterMs: 60_000,
                    status: "ok",
                    materialFingerprint: "legacy:v3:canonicalized",
                },
            },
        });
        expect(write.statusCode).toBe(200);

        const legacyRow = await db.serviceAccountQuotaSnapshot.findUnique({
            where: { accountId_vendor_profileId: { accountId: user.id, vendor: "openai-codex", profileId: "work" } },
            select: { id: true },
        });
        expect(legacyRow).toBeNull();

        const canonicalRow = await db.serviceAccountQuotaSnapshot.findUnique({
            where: { accountId_vendor_profileId: { accountId: user.id, vendor: PROVIDER_ACCOUNT_USAGE_VENDOR, profileId: expectedRecordId } },
            select: { metadata: true },
        });
        expect(canonicalRow?.metadata).toMatchObject({
            kind: "provider_account_usage",
            recordId: expectedRecordId,
            materialFingerprint: "legacy:v3:canonicalized",
        });

        const projected = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });
        expect(projected.statusCode).toBe(200);
        expect(projected.json()).toEqual({
            content: {
                t: "plain",
                v: expect.objectContaining({
                    serviceId: "openai-codex",
                    profileId: "work",
                    providerId: "codex",
                    activeAccountId: "acct_legacy_connected_subject",
                    planLabel: "team",
                }),
            },
            metadata: {
                fetchedAt,
                staleAfterMs: 60_000,
                status: "ok",
            },
        });
    });

    it("preserves connected-service aliases when same-subject legacy writes converge on one canonical row", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        const fetchedAt = Date.now();
        const workSnapshot = createLegacyQuotaSnapshot({ fetchedAt });
        const personalSnapshot = {
            ...createLegacyQuotaSnapshot({ fetchedAt: fetchedAt + 1 }),
            profileId: "personal",
        };
        const expectedRecordKey = {
            providerId: "codex",
            accountSubjectId: "acct_legacy_connected_subject",
            subjectKind: "account",
            quotaScope: "account",
        } satisfies ProviderAccountUsageRecordKeyV1;
        const expectedRecordId = buildProviderAccountUsageTestRecordId(expectedRecordKey);

        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as any);
        await app.ready();

        const writeWork = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/profiles/work/quotas",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                content: { t: "plain", v: workSnapshot },
                metadata: {
                    fetchedAt,
                    staleAfterMs: 60_000,
                    status: "ok",
                    materialFingerprint: "legacy:v3:work",
                },
            },
        });
        expect(writeWork.statusCode).toBe(200);

        const writePersonal = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/profiles/personal/quotas",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                content: { t: "plain", v: personalSnapshot },
                metadata: {
                    fetchedAt: fetchedAt + 1,
                    staleAfterMs: 60_000,
                    status: "ok",
                    materialFingerprint: "legacy:v3:personal",
                },
            },
        });
        expect(writePersonal.statusCode).toBe(200);

        const rows = await db.serviceAccountQuotaSnapshot.findMany({
            where: { accountId: user.id, vendor: PROVIDER_ACCOUNT_USAGE_VENDOR },
            select: { profileId: true },
        });
        expect(rows).toEqual([{ profileId: expectedRecordId }]);

        const projectedWork = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });
        expect(projectedWork.statusCode).toBe(200);
        expect(projectedWork.json()).toEqual({
            content: {
                t: "plain",
                v: expect.objectContaining({
                    serviceId: "openai-codex",
                    profileId: "work",
                    activeAccountId: "acct_legacy_connected_subject",
                }),
            },
            metadata: {
                fetchedAt: fetchedAt + 1,
                staleAfterMs: 60_000,
                status: "ok",
            },
        });

        const projectedPersonal = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/profiles/personal/quotas",
            headers: { "x-test-user-id": user.id },
        });
        expect(projectedPersonal.statusCode).toBe(200);
        expect(projectedPersonal.json()).toEqual({
            content: {
                t: "plain",
                v: expect.objectContaining({
                    serviceId: "openai-codex",
                    profileId: "personal",
                    activeAccountId: "acct_legacy_connected_subject",
                }),
            },
            metadata: {
                fetchedAt: fetchedAt + 1,
                staleAfterMs: 60_000,
                status: "ok",
            },
        });
    });

    it("removes only the connected-service projection alias when deleting a canonical row that still has native aliases", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        const snapshot = createUsageSnapshot({ fetchedAt: Date.now(), planLabel: "team" });

        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as any);
        await app.ready();

        const write = await app.inject({
            method: "POST",
            url: `/v3/connect/provider-account-usage/${snapshot.recordId}`,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: createV3ProviderAccountUsagePayload({ snapshot, fingerprint: "usage:v3:delete-projection" }),
        });
        expect(write.statusCode).toBe(200);

        const deletion = await app.inject({
            method: "DELETE",
            url: "/v3/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });
        expect(deletion.statusCode).toBe(200);

        const projected = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });
        expect(projected.statusCode).toBe(404);

        const canonical = await app.inject({
            method: "GET",
            url: `/v3/connect/provider-account-usage/${snapshot.recordId}`,
            headers: { "x-test-user-id": user.id },
        });
        expect(canonical.statusCode).toBe(200);
        const body = canonical.json() as { content: { v: { aliases: readonly unknown[] } } };
        expect(body.content.v.aliases).toEqual([
            expect.objectContaining({
                kind: "nativeCli",
                localCredentialRef: "codex-home-main",
            }),
        ]);
    });
});
