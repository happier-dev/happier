import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { db } from "@/storage/db";
import { connectRoutes } from "./connectRoutes";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import {
    closeProviderAccountUsageTrackedApps,
    createProviderAccountUsageRecordKey,
    createProviderAccountUsageTestApp,
    createUsageSnapshot,
    createV3ProviderAccountUsagePayload,
} from "./providerAccountUsageTestkit";
import { readProviderAccountUsageRecord, writeProviderAccountUsageRecord } from "./providerAccountUsage";
import type { ConnectedServiceId } from "@happier-dev/protocol";
import {
    createLegacyCredentialFixtureIdentity,
    createLegacyGroupFixtureIdentity,
    createLegacyGroupMemberFixtureIdentity,
} from "./testkit/qualifiedConnectedAccountFixtureIdentity";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";

async function createConnectedServiceGroupMemberBinding(params: Readonly<{
    accountId: string;
    serviceId?: ConnectedServiceId;
    profileId?: string;
    groupId?: string;
    generation?: number;
}>): Promise<void> {
    const serviceId = params.serviceId ?? "openai-codex";
    const profileId = params.profileId ?? "work";
    const groupId = params.groupId ?? "team";
    const generation = params.generation ?? 7;

    const credential = await db.serviceAccountToken.create({
        data: {
            accountId: params.accountId,
            vendor: serviceId,
            profileId,
            ...createLegacyCredentialFixtureIdentity({
                serviceId,
                profileId,
            }),
            token: Buffer.from(`token:${serviceId}:${profileId}`, "utf8"),
            metadata: {
                v: 2,
                format: "account_scoped_v1",
                kind: "oauth",
                credentialRevision: "csr_abcdefghijklmnopqrstuvwxyz",
                providerAccountId:
                    "acct_provider_subject",
            },
        },
        select: { id: true },
    });

    const group = await db.connectedServiceAuthGroup.create({
        data: {
            accountId: params.accountId,
            vendor: serviceId,
            groupId,
            ...createLegacyGroupFixtureIdentity({ serviceId, groupId }),
            displayName: "Team",
            policyJson: "{}",
            activeProfileId: profileId,
            activeConnectedAccountId: profileId,
            generation,
        },
        select: { id: true },
    });

    await db.connectedServiceAuthGroupMember.create({
        data: {
            groupDbId: group.id,
            accountId: params.accountId,
            vendor: serviceId,
            groupId,
            profileId,
            ...createLegacyGroupMemberFixtureIdentity({
                serviceId,
                profileId,
                groupId,
                credentialId: credential.id,
            }),
            priority: 1,
            enabled: true,
        },
    });
}

async function createReadyE2eeAccount() {
    return await db.account.create({
        data: {
            ...createSignedAccountContentBinding(),
            encryptionMode: "e2ee",
        },
        select: { id: true },
    });
}

describe("connectRoutes (provider account usage canonical routes)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-provider-account-usage-",
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
        await db.connectedServiceUsageSource.deleteMany().catch(() => {});
        await db.providerAccountUsageRecord.deleteMany().catch(() => {});
        await db.account.deleteMany().catch(() => {});
    });

    it("stores and returns a plaintext canonical usage envelope for plaintext accounts", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        const fetchedAt = Date.now();
        const snapshot = createUsageSnapshot({ fetchedAt, planLabel: "team" });
        const predecessorRecoveryCredits = {
            kind: "usage_limit_resets",
            availableCount: 1,
            totalCount: 1,
            nextExpiresAtMs: fetchedAt + 60_000,
            source: "provider_api",
            confidence: "exact",
            credits: [{
                providerCreditId: "credit-1",
                kind: "rate_limit_reset",
                status: "available",
                providerResetType: "five_hour",
                appliesToProviderLimitId: "weekly",
                title: null,
                description: "Reset the weekly limit",
                grantedAtMs: null,
                expiresAtMs: fetchedAt + 60_000,
                redeemStartedAtMs: null,
                redeemedAtMs: null,
            }],
        };
        const predecessorSnapshot = {
            ...snapshot,
            recoveryCredits: predecessorRecoveryCredits,
        };

        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as any);
        await app.ready();

        const write = await app.inject({
            method: "POST",
            url: `/v3/connect/provider-account-usage/${snapshot.recordId}`,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                content: {
                    t: "plain",
                    v: predecessorSnapshot,
                },
                metadata: {
                    fetchedAt: snapshot.fetchedAtMs,
                    staleAfterMs: snapshot.staleAfterMs,
                    status: "ok",
                    materialFingerprint: "usage:v3:1",
                },
            },
        });
        expect(write.statusCode).toBe(200);

        const read = await app.inject({
            method: "GET",
            url: `/v3/connect/provider-account-usage/${snapshot.recordId}`,
            headers: { "x-test-user-id": user.id },
        });
        expect(read.statusCode).toBe(200);
        expect(read.json()).toEqual({
            content: {
                t: "plain",
                v: expect.objectContaining({
                    recordId: snapshot.recordId,
                    planLabel: "team",
                    recoveryCredits: predecessorRecoveryCredits,
                }),
            },
            metadata: {
                fetchedAt,
                staleAfterMs: 60_000,
                status: "ok",
            },
            sources: [],
        });

        await expect(readProviderAccountUsageRecord({
            accountId: user.id,
            recordId: snapshot.recordId,
        })).resolves.toEqual(expect.objectContaining({
            recordId: snapshot.recordId,
            payloadMode: "plain_json_v1",
            metadata: { materialFingerprint: "usage:v3:1" },
            snapshot: expect.objectContaining({
                recoveryCredits: expect.objectContaining({
                    credits: [
                        expect.objectContaining({
                            id: "credit-1",
                            kind: "rate_limit_reset",
                        }),
                    ],
                }),
            }),
        }));
    });

    it("rejects stale plaintext canonical usage writes without requiring a material fingerprint", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        const fetchedAt = Date.now();
        const recordKey = createProviderAccountUsageRecordKey();
        const newerSnapshot = createUsageSnapshot({ fetchedAt, planLabel: "newer-plan", recordKey });
        const staleSnapshot = createUsageSnapshot({
            fetchedAt: fetchedAt - 1,
            planLabel: "stale-plan",
            recordKey,
        });

        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as any);
        await app.ready();

        expect((await app.inject({
            method: "POST",
            url: `/v3/connect/provider-account-usage/${newerSnapshot.recordId}`,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: createV3ProviderAccountUsagePayload({ snapshot: newerSnapshot }),
        })).statusCode).toBe(200);

        expect((await app.inject({
            method: "POST",
            url: `/v3/connect/provider-account-usage/${newerSnapshot.recordId}`,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: createV3ProviderAccountUsagePayload({ snapshot: staleSnapshot }),
        })).statusCode).toBe(200);

        const read = await app.inject({
            method: "GET",
            url: `/v3/connect/provider-account-usage/${newerSnapshot.recordId}`,
            headers: { "x-test-user-id": user.id },
        });
        expect(read.statusCode).toBe(200);
        expect(read.json()).toEqual({
            content: { t: "plain", v: expect.objectContaining({ planLabel: "newer-plan", fetchedAtMs: fetchedAt }) },
            metadata: {
                fetchedAt,
                staleAfterMs: 60_000,
                status: "ok",
            },
            sources: [],
        });
    });

    it("records refreshes and deletes canonical plaintext usage records", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        const snapshot = createUsageSnapshot({ fetchedAt: Date.now(), planLabel: "refresh-delete" });

        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as any);
        await app.ready();

        expect((await app.inject({
            method: "POST",
            url: `/v3/connect/provider-account-usage/${snapshot.recordId}`,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: createV3ProviderAccountUsagePayload({ snapshot, fingerprint: "usage:v3:refresh-delete" }),
        })).statusCode).toBe(200);

        const refresh = await app.inject({
            method: "POST",
            url: `/v3/connect/provider-account-usage/${snapshot.recordId}/refresh`,
            headers: { "x-test-user-id": user.id },
        });
        expect(refresh.statusCode).toBe(200);
        expect(refresh.json()).toEqual({ success: true });
        expect((await readProviderAccountUsageRecord({
            accountId: user.id,
            recordId: snapshot.recordId,
        }))?.refreshRequestedAt).toEqual(expect.any(Number));

        const deleted = await app.inject({
            method: "DELETE",
            url: `/v3/connect/provider-account-usage/${snapshot.recordId}`,
            headers: { "x-test-user-id": user.id },
        });
        expect(deleted.statusCode).toBe(200);
        expect(deleted.json()).toEqual({ success: true });
        await expect(readProviderAccountUsageRecord({
            accountId: user.id,
            recordId: snapshot.recordId,
        })).resolves.toBeNull();
    });

    it("fails closed on first-write sealed direct usage without trusted record-key context and updates trusted sealed records", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "required_e2ee",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "e2ee",
        });
        const user = await createReadyE2eeAccount();
        const snapshot = createUsageSnapshot({ fetchedAt: 1_234, planLabel: "sealed-direct" });

        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as any);
        await app.ready();

        const blockedCreate = await app.inject({
            method: "POST",
            url: `/v2/connect/provider-account-usage/${snapshot.recordId}`,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                sealed: { format: "account_scoped_v1", ciphertext: "sealed-provider-account-usage" },
                metadata: {
                    fetchedAt: snapshot.fetchedAtMs,
                    staleAfterMs: snapshot.staleAfterMs,
                    status: "ok",
                },
            },
        });
        expect(blockedCreate.statusCode).toBe(409);
        expect(blockedCreate.json()).toEqual({ error: "provider_account_usage_record_key_required" });

        await writeProviderAccountUsageRecord({
            accountId: user.id,
            recordId: snapshot.recordId,
            recordKey: snapshot.recordKey,
            payloadMode: "sealed_account_scoped_v1",
            sealedPayload: { format: "account_scoped_v1", ciphertext: "initial-sealed" },
            status: "ok",
            fetchedAt: snapshot.fetchedAtMs - 10,
            staleAfterMs: snapshot.staleAfterMs,
        });

        const update = await app.inject({
            method: "POST",
            url: `/v2/connect/provider-account-usage/${snapshot.recordId}`,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                sealed: { format: "account_scoped_v1", ciphertext: "sealed-provider-account-usage" },
                metadata: {
                    fetchedAt: snapshot.fetchedAtMs,
                    staleAfterMs: snapshot.staleAfterMs,
                    status: "ok",
                    materialFingerprint: "sealed:trusted",
                },
            },
        });
        expect(update.statusCode).toBe(200);

        const read = await app.inject({
            method: "GET",
            url: `/v2/connect/provider-account-usage/${snapshot.recordId}`,
            headers: { "x-test-user-id": user.id },
        });
        expect(read.statusCode).toBe(200);
        expect(read.json()).toEqual({
            sealed: { format: "account_scoped_v1", ciphertext: "sealed-provider-account-usage" },
            metadata: {
                fetchedAt: snapshot.fetchedAtMs,
                staleAfterMs: snapshot.staleAfterMs,
                status: "ok",
                materialFingerprint: "sealed:trusted",
            },
            sources: [],
        });
    });

    it("returns a 400 instead of a response serialization error for malformed sealed usage writes", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "required_e2ee",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "e2ee",
        });
        const user = await createReadyE2eeAccount();
        const snapshot = createUsageSnapshot({ fetchedAt: 1_234, planLabel: "sealed-malformed" });

        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as any);
        await app.ready();

        const response = await app.inject({
            method: "POST",
            url: `/v2/connect/provider-account-usage/${snapshot.recordId}`,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                recordKey: snapshot.recordKey,
                sealed: { format: "account_scoped_v1", ciphertext: "" },
                metadata: {
                    fetchedAt: snapshot.fetchedAtMs,
                    staleAfterMs: snapshot.staleAfterMs,
                    status: "ok",
                },
            },
        });

        expect(response.statusCode).toBe(400);
    });

    it("returns safe machine-readable reasons for invalid plaintext provider-account usage writes", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        const snapshot = createUsageSnapshot({ fetchedAt: Date.now() });
        const otherSnapshot = createUsageSnapshot({
            fetchedAt: Date.now() + 1,
            recordKey: createProviderAccountUsageRecordKey({ accountSubjectId: "other-account" }),
        });

        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as any);
        await app.ready();

        const wrongRecordId = await app.inject({
            method: "POST",
            url: `/v3/connect/provider-account-usage/${otherSnapshot.recordId}`,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: createV3ProviderAccountUsagePayload({ snapshot }),
        });
        expect(wrongRecordId.statusCode).toBe(400);
        expect(wrongRecordId.json()).toEqual({
            error: "invalid-params",
            reason: "provider_account_usage_record_id_mismatch",
        });

        const mismatchedClock = await app.inject({
            method: "POST",
            url: `/v3/connect/provider-account-usage/${snapshot.recordId}`,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                ...createV3ProviderAccountUsagePayload({ snapshot }),
                metadata: {
                    fetchedAt: snapshot.fetchedAtMs + 1,
                    staleAfterMs: snapshot.staleAfterMs,
                    status: "ok",
                },
            },
        });
        expect(mismatchedClock.statusCode).toBe(400);
        expect(mismatchedClock.json()).toEqual({
            error: "invalid-params",
            reason: "provider_account_usage_payload_invalid",
        });
    });

    it("returns active group-member connected-service usage sources from canonical v2 provider-account usage GET", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "required_e2ee",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "e2ee",
        });
        const user = await createReadyE2eeAccount();
        await createConnectedServiceGroupMemberBinding({ accountId: user.id, groupId: "team", generation: 7 });
        const snapshot = createUsageSnapshot({ fetchedAt: 2_345, planLabel: "sealed-group-member" });

        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as any);
        await app.ready();

        const write = await app.inject({
            method: "POST",
            url: `/v2/connect/provider-account-usage/${snapshot.recordId}`,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                recordKey: snapshot.recordKey,
                source: {
                    serviceId: "openai-codex",
                    profileId: "work",
                    bindingKind: "group_member",
                    groupId: "team",
                },
                sealed: { format: "account_scoped_v1", ciphertext: "sealed-group-member-provider-account-usage" },
                metadata: {
                    fetchedAt: snapshot.fetchedAtMs,
                    staleAfterMs: snapshot.staleAfterMs,
                    status: "ok",
                },
            },
        });
        expect(write.statusCode).toBe(200);

        const read = await app.inject({
            method: "GET",
            url: `/v2/connect/provider-account-usage/${snapshot.recordId}`,
            headers: { "x-test-user-id": user.id },
        });

        expect(read.statusCode).toBe(200);
        expect(read.json()).toEqual({
            sealed: { format: "account_scoped_v1", ciphertext: "sealed-group-member-provider-account-usage" },
            metadata: {
                fetchedAt: snapshot.fetchedAtMs,
                staleAfterMs: snapshot.staleAfterMs,
                status: "ok",
            },
            sources: [{
                serviceId: "openai-codex",
                profileId: "work",
                bindingKind: "group_member",
                groupId: "team",
                groupGeneration: 7,
            }],
        });
    });
});
