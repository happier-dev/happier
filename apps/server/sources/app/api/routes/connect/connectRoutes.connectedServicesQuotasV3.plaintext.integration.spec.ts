import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { ConnectedServiceId } from "@happier-dev/protocol";

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
                v: 3,
                storage: "plain_json_v1",
                kind: "oauth",
                ...(params.providerAccountId !== null ? { providerAccountId: params.providerAccountId ?? "acct_provider_subject" } : {}),
                credentialRevision: "csr_abcdefghijklmnopqrstuvwxyz",
            },
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

describe("connectRoutes (connected services quotas v3) plaintext quota endpoints", () => {
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
        await closeProviderAccountUsageTrackedApps();
        harness.resetEnv();
        vi.unstubAllGlobals();
        await db.connectedServiceUsageSource.deleteMany().catch(() => {});
        await db.providerAccountUsageRecord.deleteMany().catch(() => {});
        await db.serviceAccountToken.deleteMany().catch(() => {});
        await db.account.deleteMany().catch(() => {});
    });

    it("returns a plaintext quota view backed by canonical provider-account usage", async () => {
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
        await createConnectedServiceProfileBinding(user.id, "work", { providerAccountId: "acct_quota_v3_projection" });
        const snapshot = createUsageSnapshot({
            fetchedAt: Date.now(),
            recordKey: createProviderAccountUsageRecordKey({ accountSubjectId: "acct_quota_v3_projection" }),
            planLabel: "plan-secret-12345",
        });

        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as any);
        await app.ready();

        const register = await app.inject({
            method: "POST",
            url: `/v3/connect/provider-account-usage/${snapshot.recordId}`,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                ...createV3ProviderAccountUsagePayload({ snapshot }),
                source: {
                    serviceId: "openai-codex",
                    profileId: "work",
                    bindingKind: "profile",
                },
            },
        });
        expect(register.statusCode).toBe(200);
        expect(register.json()).toEqual({
            success: true,
            source: { status: "linked" },
        });

        const getOne = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });
        expect(getOne.statusCode).toBe(200);
        expect(getOne.json()).toEqual({
            content: { t: "plain", v: expect.objectContaining({ serviceId: "openai-codex", profileId: "work", planLabel: "plan-secret-12345" }) },
            metadata: {
                fetchedAt: snapshot.fetchedAtMs,
                staleAfterMs: snapshot.staleAfterMs,
                status: "ok",
            },
        });

        const source = await readConnectedServiceUsageSource({
            accountId: user.id,
            serviceId: "openai-codex",
            profileId: "work",
        });
        expect(source).toEqual(expect.objectContaining({
            providerAccountUsageRecordId: expect.any(String),
        }));
        expect(source?.providerAccountUsageRecordId).toEqual(expect.any(String));

        await expect(readProviderAccountUsageRecord({
            accountId: user.id,
            recordId: source?.providerAccountUsageRecordId ?? "",
        })).resolves.toEqual(expect.objectContaining({
            payloadMode: "plain_json_v1",
        }));
    });

    it("refreshes through the linked source relation and does not create placeholder rows", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        await createConnectedServiceProfileBinding(user.id, "work", { providerAccountId: "acct_quota_v3_refresh" });
        const snapshot = createUsageSnapshot({
            fetchedAt: Date.now(),
            recordKey: createProviderAccountUsageRecordKey({ accountSubjectId: "acct_quota_v3_refresh" }),
            planLabel: "refresh-source",
        });

        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as any);
        await app.ready();

        expect((await app.inject({
            method: "POST",
            url: `/v3/connect/provider-account-usage/${snapshot.recordId}`,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                ...createV3ProviderAccountUsagePayload({ snapshot }),
                source: {
                    serviceId: "openai-codex",
                    profileId: "work",
                    bindingKind: "profile",
                },
            },
        })).statusCode).toBe(200);

        const refresh = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/profiles/work/quotas/refresh",
            headers: { "x-test-user-id": user.id },
        });
        expect(refresh.statusCode).toBe(200);
        expect(refresh.json()).toEqual({ success: true });

        const source = await readConnectedServiceUsageSource({
            accountId: user.id,
            serviceId: "openai-codex",
            profileId: "work",
        });
        const recordId = source?.providerAccountUsageRecordId ?? "";
        expect((await readProviderAccountUsageRecord({ accountId: user.id, recordId }))?.refreshRequestedAt).toEqual(expect.any(Number));
    });

    it("deletes the quota view by unlinking the source and preserving the provider record", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        await createConnectedServiceProfileBinding(user.id, "work", { providerAccountId: "acct_quota_v3_unlink" });
        const snapshot = createUsageSnapshot({
            fetchedAt: Date.now(),
            recordKey: createProviderAccountUsageRecordKey({ accountSubjectId: "acct_quota_v3_unlink" }),
            planLabel: "unlink-only",
        });

        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as any);
        await app.ready();

        expect((await app.inject({
            method: "POST",
            url: `/v3/connect/provider-account-usage/${snapshot.recordId}`,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                ...createV3ProviderAccountUsagePayload({ snapshot, fingerprint: "unlink-only" }),
                source: {
                    serviceId: "openai-codex",
                    profileId: "work",
                    bindingKind: "profile",
                },
            },
        })).statusCode).toBe(200);

        const storedRecordBeforeDelete = await db.providerAccountUsageRecord.findFirst({
            where: { accountId: user.id },
            select: { recordId: true },
        });
        const recordId = storedRecordBeforeDelete?.recordId ?? "";

        const deleted = await app.inject({
            method: "DELETE",
            url: "/v3/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });
        expect(deleted.statusCode).toBe(200);
        expect(deleted.json()).toEqual({ success: true });

        await expect(readProviderAccountUsageRecord({ accountId: user.id, recordId })).resolves.toEqual(expect.objectContaining({
            recordId,
            payloadMode: "plain_json_v1",
        }));
        await expect(readConnectedServiceUsageSource({
            accountId: user.id,
            serviceId: "openai-codex",
            profileId: "work",
        })).resolves.toBeNull();
    });

    it("preserves explicit group-member source context on canonical plaintext provider-account usage writes", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        await createConnectedServiceProfileBinding(user.id, "work", { providerAccountId: "acct_quota_v3_group_member" });
        await createConnectedServiceGroupMember({ accountId: user.id, profileId: "work", groupId: "team", generation: 4 });
        const snapshot = createUsageSnapshot({
            fetchedAt: Date.now(),
            recordKey: createProviderAccountUsageRecordKey({ accountSubjectId: "acct_quota_v3_group_member" }),
            planLabel: "group-member-source",
        });

        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as any);
        await app.ready();

        const write = await app.inject({
            method: "POST",
            url: `/v3/connect/provider-account-usage/${snapshot.recordId}`,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                ...createV3ProviderAccountUsagePayload({ snapshot }),
                source: {
                    serviceId: "openai-codex",
                    profileId: "work",
                    bindingKind: "group_member",
                    groupId: "team",
                    groupGeneration: 4,
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
});
