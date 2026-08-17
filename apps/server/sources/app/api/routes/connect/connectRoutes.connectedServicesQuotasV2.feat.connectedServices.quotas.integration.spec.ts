import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { db } from "@/storage/db";
import { connectRoutes } from "./connectRoutes";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import {
    closeProviderAccountUsageTrackedApps,
    createProviderAccountUsageRecordKey,
    createProviderAccountUsageTestApp,
} from "./providerAccountUsageTestkit";
import {
    buildProviderAccountUsageRecordId,
    type ConnectedServiceId,
} from "@happier-dev/protocol";
import { readProviderAccountUsageRecord } from "./providerAccountUsage";
import {
    readExactQualifiedConnectedServiceUsageSource,
} from "./qualifiedConnectedAccounts/usageRepository";
import {
    resolveLegacyQualifiedConnectedAccountService,
} from "./qualifiedConnectedAccounts/identity";
import {
    createLegacyCredentialFixtureIdentity,
    createLegacyGroupFixtureIdentity,
    createLegacyGroupMemberFixtureIdentity,
} from "./testkit/qualifiedConnectedAccountFixtureIdentity";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";

async function readConnectedServiceUsageSource(params: Readonly<{
    accountId: string;
    serviceId: ConnectedServiceId;
    profileId: string;
}>): Promise<Readonly<{
    providerAccountUsageRecordId: string;
    bindingKind: "profile";
}> | null> {
    const result = await readExactQualifiedConnectedServiceUsageSource({
        accountId: params.accountId,
        source: {
            ref: {
                service:
                    resolveLegacyQualifiedConnectedAccountService(
                        params.serviceId,
                    ),
                accountId: params.profileId,
            },
            bindingKind: "account",
        },
    });
    return result
        ? {
            providerAccountUsageRecordId: result.recordId,
            bindingKind: "profile",
        }
        : null;
}

async function createConnectedServiceProfileBinding(
    accountId: string,
    profileId: string = "work",
    params: Readonly<{ providerAccountId?: string | null }> = {},
): Promise<{ id: string }> {
    return await db.serviceAccountToken.create({
        data: {
            accountId,
            vendor: "openai-codex",
            profileId,
            ...createLegacyCredentialFixtureIdentity({
                serviceId: "openai-codex",
                profileId,
                credentialKind: "oauth",
            }),
            token: Buffer.from(`token:openai-codex:${profileId}`, "utf8"),
            metadata: {
                v: 2,
                format: "account_scoped_v1",
                kind: "oauth",
                credentialRevision: "csr_abcdefghijklmnopqrstuvwxyz",
                ...(params.providerAccountId !== null ? { providerAccountId: params.providerAccountId ?? "acct_provider_subject" } : {}),
            },
        },
        select: { id: true },
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

async function createConnectedServiceGroupMember(params: Readonly<{
    accountId: string;
    profileId?: string;
    groupId?: string;
    generation?: number;
}>): Promise<void> {
    const profileId = params.profileId ?? "work";
    const groupId = params.groupId ?? "team";
    const credential = await db.serviceAccountToken.findUniqueOrThrow({
        where: {
            accountId_vendor_profileId: {
                accountId: params.accountId,
                vendor: "openai-codex",
                profileId,
            },
        },
        select: { id: true },
    });
    const group = await db.connectedServiceAuthGroup.create({
        data: {
            accountId: params.accountId,
            vendor: "openai-codex",
            groupId,
            ...createLegacyGroupFixtureIdentity({
                serviceId: "openai-codex",
                groupId,
            }),
            displayName: null,
            policyJson: JSON.stringify({ v: 1, strategy: "priority", autoSwitch: true }),
            activeProfileId: profileId,
            activeConnectedAccountId: profileId,
            generation: params.generation ?? 0,
            stateJson: null,
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
            ...createLegacyGroupMemberFixtureIdentity({
                serviceId: "openai-codex",
                profileId,
                groupId,
                credentialId: credential.id,
                credentialKind: "oauth",
            }),
            priority: 10,
            enabled: true,
            stateJson: null,
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
        await closeProviderAccountUsageTrackedApps();
        harness.resetEnv();
        vi.unstubAllGlobals();
        await db.connectedServiceUsageSource.deleteMany().catch(() => {});
        await db.providerAccountUsageRecord.deleteMany().catch(() => {});
        await db.serviceAccountToken.deleteMany().catch(() => {});
        await db.account.deleteMany().catch(() => {});
    });

    it("returns the source-bound kind-4 compatibility projection without exposing canonical PAU ciphertext", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "required_e2ee",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "e2ee",
        });
        const user = await createReadyE2eeAccount();
        await createConnectedServiceProfileBinding(user.id, "work", { providerAccountId: "acct_quota_v2_projection" });

        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as any);
        await app.ready();

        const recordKey = createProviderAccountUsageRecordKey({ accountSubjectId: "acct_quota_v2_projection" });
        const recordId = buildProviderAccountUsageRecordId(recordKey);
        const write = await app.inject({
            method: "POST",
            url: `/v2/connect/provider-account-usage/${recordId}`,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                recordKey,
                sealed: { format: "account_scoped_v1", ciphertext: "sealed-legacy-quota" },
                legacyQuotaCompatibility: {
                    format: "account_scoped_v1",
                    ciphertext:
                        "oQQhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzg5fEl9K9e0gbQcLrSkvsMc0Wbde5VEgjODqJnwlP50/98/oh/sEPqZQamcCTwpYsU=",
                },
                metadata: {
                    fetchedAt: 1_234,
                    staleAfterMs: 300_000,
                    status: "ok",
                    materialFingerprint: "legacy:v2:test",
                },
                source: {
                    serviceId: "openai-codex",
                    profileId: "work",
                    bindingKind: "profile",
                },
            },
        });
        expect(write.statusCode).toBe(200);

        const read = await app.inject({
            method: "GET",
            url: "/v2/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });
        expect(read.statusCode).toBe(200);
        expect(read.json()).toEqual({
            sealed: {
                format: "account_scoped_v1",
                ciphertext:
                    "oQQhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzg5fEl9K9e0gbQcLrSkvsMc0Wbde5VEgjODqJnwlP50/98/oh/sEPqZQamcCTwpYsU=",
            },
            metadata: {
                fetchedAt: 1_234,
                staleAfterMs: 300_000,
                status: "ok",
            },
        });

        await expect(readConnectedServiceUsageSource({
            accountId: user.id,
            serviceId: "openai-codex",
            profileId: "work",
        })).resolves.toEqual(expect.objectContaining({
            providerAccountUsageRecordId: recordId,
        }));
        await expect(readProviderAccountUsageRecord({
            accountId: user.id,
            recordId,
        })).resolves.toEqual(expect.objectContaining({
            payloadMode: "sealed_account_scoped_v1",
            sealedPayload: { format: "account_scoped_v1", ciphertext: "sealed-legacy-quota" },
        }));

        const newerWrite = await app.inject({
            method: "POST",
            url: `/v2/connect/provider-account-usage/${recordId}`,
            headers: {
                "content-type": "application/json",
                "x-test-user-id": user.id,
            },
            payload: {
                recordKey,
                sealed: {
                    format: "account_scoped_v1",
                    ciphertext: "newer-canonical-pau-without-shadow",
                },
                metadata: {
                    fetchedAt: 1_235,
                    staleAfterMs: 300_000,
                    status: "ok",
                    materialFingerprint: "legacy:v2:newer",
                },
                source: {
                    serviceId: "openai-codex",
                    profileId: "work",
                    bindingKind: "profile",
                },
            },
        });
        expect(newerWrite.statusCode).toBe(200);
        const staleProjectionRead = await app.inject({
            method: "GET",
            url: "/v2/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });
        expect(staleProjectionRead.statusCode).toBe(404);
    });

    it("rejects source-attached provider-account usage when the source link belongs to another provider account", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "required_e2ee",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "e2ee",
        });
        const user = await createReadyE2eeAccount();
        await createConnectedServiceProfileBinding(user.id, "work", { providerAccountId: "acct_connected_profile_subject" });

        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as any);
        await app.ready();

        const recordKey = createProviderAccountUsageRecordKey({ accountSubjectId: "acct_usage_subject" });
        const recordId = buildProviderAccountUsageRecordId(recordKey);
        const write = await app.inject({
            method: "POST",
            url: `/v2/connect/provider-account-usage/${recordId}`,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                recordKey,
                sealed: { format: "account_scoped_v1", ciphertext: "sealed-source-mismatch" },
                metadata: {
                    fetchedAt: 2_468,
                    staleAfterMs: 300_000,
                    status: "ok",
                },
                source: {
                    serviceId: "openai-codex",
                    profileId: "work",
                    bindingKind: "profile",
                },
            },
        });
        expect(write.statusCode).toBe(400);
        expect(write.json()).toEqual({
            error: "invalid-params",
            reason: "connected_service_usage_source_incompatible",
        });
        await expect(readConnectedServiceUsageSource({
            accountId: user.id,
            serviceId: "openai-codex",
            profileId: "work",
        })).resolves.toBeNull();
        await expect(readProviderAccountUsageRecord({ accountId: user.id, recordId })).resolves.toBeNull();
    });

    it("returns a machine-readable provider/source compatibility reason for rejected source links", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "required_e2ee",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "e2ee",
        });
        const user = await createReadyE2eeAccount();

        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as any);
        await app.ready();

        const recordKey = createProviderAccountUsageRecordKey({ accountSubjectId: "acct_source_incompatible" });
        const recordId = buildProviderAccountUsageRecordId(recordKey);
        const write = await app.inject({
            method: "POST",
            url: `/v2/connect/provider-account-usage/${recordId}`,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                recordKey,
                sealed: { format: "account_scoped_v1", ciphertext: "sealed-source-incompatible" },
                metadata: {
                    fetchedAt: 3_579,
                    staleAfterMs: 300_000,
                    status: "ok",
                },
                source: {
                    serviceId: "claude-subscription",
                    profileId: "work",
                    bindingKind: "profile",
                },
            },
        });

        expect(write.statusCode).toBe(400);
        expect(write.json()).toEqual({
            error: "invalid-params",
            reason: "connected_service_usage_source_incompatible",
        });
    });

    it("refreshes and deletes sealed quota views through the source relation", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "required_e2ee",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "e2ee",
        });
        const user = await createReadyE2eeAccount();
        await createConnectedServiceProfileBinding(user.id, "work", { providerAccountId: "acct_quota_v2_refresh" });
        const recordKey = createProviderAccountUsageRecordKey({ accountSubjectId: "acct_quota_v2_refresh" });
        const recordId = buildProviderAccountUsageRecordId(recordKey);

        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as any);
        await app.ready();

        expect((await app.inject({
            method: "POST",
            url: `/v2/connect/provider-account-usage/${recordId}`,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                recordKey,
                sealed: { format: "account_scoped_v1", ciphertext: "sealed-legacy-quota" },
                metadata: {
                    fetchedAt: 9_999,
                    staleAfterMs: 60_000,
                    status: "ok",
                },
                source: {
                    serviceId: "openai-codex",
                    profileId: "work",
                    bindingKind: "profile",
                },
            },
        })).statusCode).toBe(200);

        const refresh = await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/profiles/work/quotas/refresh",
            headers: { "x-test-user-id": user.id },
        });
        expect(refresh.statusCode).toBe(200);
        expect(refresh.json()).toEqual({ success: true });
        expect((await readProviderAccountUsageRecord({ accountId: user.id, recordId }))?.refreshRequestedAt).toEqual(expect.any(Number));

        const deleted = await app.inject({
            method: "DELETE",
            url: "/v2/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });
        expect(deleted.statusCode).toBe(200);
        expect(deleted.json()).toEqual({ success: true });

        await expect(readConnectedServiceUsageSource({
            accountId: user.id,
            serviceId: "openai-codex",
            profileId: "work",
        })).resolves.toBeNull();
        await expect(readProviderAccountUsageRecord({ accountId: user.id, recordId })).resolves.toEqual(expect.objectContaining({
            recordId,
            payloadMode: "sealed_account_scoped_v1",
        }));
    });

    it("preserves explicit group-member source context on canonical sealed provider-account usage writes", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "required_e2ee",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "e2ee",
        });
        const user = await createReadyE2eeAccount();
        await createConnectedServiceProfileBinding(user.id, "work", { providerAccountId: "acct_quota_v2_group_member" });
        await createConnectedServiceGroupMember({ accountId: user.id, profileId: "work", groupId: "team", generation: 4 });

        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as any);
        await app.ready();

        const recordKey = createProviderAccountUsageRecordKey({ accountSubjectId: "acct_quota_v2_group_member" });
        const recordId = buildProviderAccountUsageRecordId(recordKey);
        const write = await app.inject({
            method: "POST",
            url: `/v2/connect/provider-account-usage/${recordId}`,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                recordKey,
                source: {
                    serviceId: "openai-codex",
                    profileId: "work",
                    bindingKind: "group_member",
                    groupId: "team",
                    groupGeneration: 4,
                },
                sealed: { format: "account_scoped_v1", ciphertext: "sealed-group-member-quota" },
                metadata: {
                    fetchedAt: 12_345,
                    staleAfterMs: 60_000,
                    status: "ok",
                },
            },
        });

        expect(write.statusCode).toBe(200);
        await expect(readExactQualifiedConnectedServiceUsageSource({
            accountId: user.id,
            source: {
                ref: {
                    service:
                        resolveLegacyQualifiedConnectedAccountService(
                            "openai-codex",
                        ),
                    accountId: "work",
                },
                bindingKind: "group_member",
                groupId: "team",
                groupGeneration: 4,
            },
        })).resolves.toEqual(expect.objectContaining({
            source: expect.objectContaining({
                bindingKind: "group_member",
                groupId: "team",
                groupGeneration: 4,
            }),
        }));
    });

    it("does not flatten group-member PAU ciphertext into a legacy profile quota view", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "required_e2ee",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "e2ee",
        });
        const user = await createReadyE2eeAccount();
        await createConnectedServiceProfileBinding(user.id, "work", { providerAccountId: "acct_quota_v2_stale_generation" });
        await createConnectedServiceGroupMember({ accountId: user.id, profileId: "work", groupId: "team", generation: 4 });

        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as any);
        await app.ready();

        const recordKey = createProviderAccountUsageRecordKey({ accountSubjectId: "acct_quota_v2_stale_generation" });
        const recordId = buildProviderAccountUsageRecordId(recordKey);
        const write = await app.inject({
            method: "POST",
            url: `/v2/connect/provider-account-usage/${recordId}`,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                recordKey,
                source: {
                    serviceId: "openai-codex",
                    profileId: "work",
                    bindingKind: "group_member",
                    groupId: "team",
                    groupGeneration: 4,
                },
                sealed: { format: "account_scoped_v1", ciphertext: "sealed-stale-generation-quota" },
                metadata: {
                    fetchedAt: 45_678,
                    staleAfterMs: 60_000,
                    status: "ok",
                },
            },
        });
        expect(write.statusCode).toBe(200);

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

        const read = await app.inject({
            method: "GET",
            url: "/v2/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });
        expect(read.statusCode).toBe(404);
        expect(read.json()).toEqual({
            error: "connect_quotas_not_found",
        });
    });
});
