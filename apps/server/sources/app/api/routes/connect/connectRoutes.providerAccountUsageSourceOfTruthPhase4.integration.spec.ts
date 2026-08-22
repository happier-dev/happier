import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
    buildProviderAccountUsageRecordId,
    readAccountScopedCiphertextKindByte,
} from "@happier-dev/protocol";

import { db } from "@/storage/db";
import { connectRoutes } from "./connectRoutes";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import {
    closeProviderAccountUsageTrackedApps,
    createLegacyQuotaSnapshot,
    createProviderAccountUsageRecordKey,
    createProviderAccountUsageTestApp,
    createUsageSnapshot,
    createV3ProviderAccountUsagePayload,
} from "./providerAccountUsageTestkit";
import type { ConnectedServiceId } from "@happier-dev/protocol";
import {
    createLegacyCredentialFixtureIdentity,
    createLegacyGroupFixtureIdentity,
    createLegacyGroupMemberFixtureIdentity,
} from "./testkit/qualifiedConnectedAccountFixtureIdentity";
import { mutateQualifiedConnectedServiceCredential } from "./qualifiedConnectedAccounts/credentialRepository";
import {
    writeQualifiedProviderAccountUsageRecordFromLegacyBoundary,
} from "./qualifiedConnectedAccounts/usageRepository";
import { resolveLegacyQualifiedConnectedAccountService } from "./qualifiedConnectedAccounts/identity";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";

async function createConnectedServiceProfileBinding(
    accountId: string,
    params: Readonly<{
        providerAccountId?: string | null;
        legacyUnfenced?: boolean;
    }> = {},
): Promise<void> {
    await db.serviceAccountToken.create({
        data: {
            accountId,
            vendor: "openai-codex",
            profileId: "work",
            ...createLegacyCredentialFixtureIdentity({
                serviceId: "openai-codex",
                profileId: "work",
                credentialKind: "oauth",
            }),
            token: Buffer.from("token:openai-codex:work", "utf8"),
            metadata: {
                v: 3,
                storage: "plain_json_v1",
                kind: "oauth",
                ...(params.providerAccountId !== null ? { providerAccountId: params.providerAccountId ?? "acct_provider_subject" } : {}),
                ...(!params.legacyUnfenced
                    ? {
                        credentialRevision:
                            "csr_abcdefghijklmnopqrstuvwxyz",
                    }
                    : {}),
            },
        },
    });
}

async function createConnectedServiceGroupMemberBinding(params: Readonly<{
    accountId: string;
    serviceId?: ConnectedServiceId;
    profileId?: string;
    groupId?: string;
    generation?: number;
    providerAccountId?: string | null;
    legacyUnfenced?: boolean;
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
                v: 3,
                storage: "plain_json_v1",
                kind: "oauth",
                ...(params.providerAccountId !== null ? { providerAccountId: params.providerAccountId ?? "acct_provider_subject" } : {}),
                ...(!params.legacyUnfenced
                    ? {
                        credentialRevision:
                            "csr_abcdefghijklmnopqrstuvwxyz",
                    }
                    : {}),
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

// server-v0.2.1 (4913c1e533c872a0712ba1c25b3104fd470aacc2) V3 quota body.
// Keep this release-shaped rather than deriving it through current helpers.
const releasedServerV021PlainQuotaSnapshot = {
    v: 1,
    serviceId: "openai-codex",
    profileId: "work",
    fetchedAt: 1_234,
    staleAfterMs: 300_000,
    planLabel: "preview-release",
    accountLabel: "work",
    meters: [{
        meterId: "weekly",
        label: "Weekly",
        used: 42,
        limit: 100,
        unit: "credits",
        utilizationPct: 42,
        resetsAt: null,
        status: "ok",
    }],
} as const;

describe("connectRoutes provider-account usage source-of-truth phase 4 contract", () => {
    it("resolves exact source metadata without exposing snapshot payload bytes", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        await createConnectedServiceProfileBinding(user.id, { providerAccountId: "acct_exact_source" });
        const snapshot = createUsageSnapshot({
            fetchedAt: Date.now(),
            recordKey: createProviderAccountUsageRecordKey({ accountSubjectId: "acct_exact_source" }),
            planLabel: "exact-source",
        });
        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as never);
        await app.ready();
        await app.inject({
            method: "POST",
            url: `/v3/connect/provider-account-usage/${snapshot.recordId}`,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                ...createV3ProviderAccountUsagePayload({ snapshot, fingerprint: "usage:exact-source" }),
                source: { serviceId: "openai-codex", profileId: "work", bindingKind: "profile" },
            },
        });
        const response = await app.inject({
            method: "GET",
            url: "/v3/connect/provider-account-usage/sources/resolve?serviceId=openai-codex&profileId=work&bindingKind=profile",
            headers: { "x-test-user-id": user.id },
        });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json()).toEqual({
            source: { serviceId: "openai-codex", profileId: "work", bindingKind: "profile" },
            recordId: snapshot.recordId,
            providerAccountId: "acct_exact_source",
            fetchedAt: snapshot.fetchedAtMs,
            staleAfterMs: snapshot.staleAfterMs,
        });
        expect(response.body).not.toContain("exact-source");
    });

    it("resolves an exact group-member source when HTTP query parsing receives its numeric generation as text", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        await createConnectedServiceGroupMemberBinding({
            accountId: user.id,
            providerAccountId: "acct_group_member",
            groupId: "team",
            generation: 4,
        });
        const snapshot = createUsageSnapshot({
            fetchedAt: Date.now(),
            recordKey: createProviderAccountUsageRecordKey({ accountSubjectId: "acct_group_member" }),
            planLabel: "group-member-source",
        });
        const source = {
            serviceId: "openai-codex" as const,
            profileId: "work",
            bindingKind: "group_member" as const,
            groupId: "team",
            groupGeneration: 4,
        };
        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as never);
        await app.ready();
        const write = await app.inject({
            method: "POST",
            url: `/v3/connect/provider-account-usage/${snapshot.recordId}`,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                ...createV3ProviderAccountUsagePayload({ snapshot, fingerprint: "usage:group-member-source" }),
                source,
            },
        });
        expect(write.statusCode, write.body).toBe(200);

        const response = await app.inject({
            method: "GET",
            url: "/v3/connect/provider-account-usage/sources/resolve?serviceId=openai-codex&profileId=work&bindingKind=group_member&groupId=team&groupGeneration=4",
            headers: { "x-test-user-id": user.id },
        });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json()).toEqual({
            source,
            recordId: snapshot.recordId,
            providerAccountId: "acct_group_member",
            fetchedAt: snapshot.fetchedAtMs,
            staleAfterMs: snapshot.staleAfterMs,
        });
    });

    it("rejects non-exact source bindings and non-canonical group generations at the HTTP boundary", async () => {
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as never);
        await app.ready();

        const invalidQueries = [
            "serviceId=openai-codex&profileId=work&bindingKind=group_member&groupGeneration=4",
            "serviceId=openai-codex&profileId=work&bindingKind=group_member&groupId=team",
            "serviceId=openai-codex&profileId=work&bindingKind=profile&groupId=team",
            "serviceId=openai-codex&profileId=work&bindingKind=profile&groupGeneration=4",
            "serviceId=openai-codex&profileId=work&bindingKind=group_member&groupId=team&groupGeneration=%204%20",
            "serviceId=openai-codex&profileId=work&bindingKind=group_member&groupId=team&groupGeneration=04",
            "serviceId=openai-codex&profileId=work&bindingKind=group_member&groupId=team&groupGeneration=9007199254740992",
        ];
        for (const query of invalidQueries) {
            const response = await app.inject({
                method: "GET",
                url: `/v3/connect/provider-account-usage/sources/resolve?${query}`,
                headers: { "x-test-user-id": user.id },
            });
            expect(response.statusCode, `${query}: ${response.body}`).toBe(400);
        }
    });
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-provider-account-usage-phase4-red-",
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
        await db.connectedServiceUsageSource.deleteMany().catch(() => {});
        await db.providerAccountUsageRecord.deleteMany().catch(() => {});
        await db.serviceAccountToken.deleteMany().catch(() => {});
        await db.account.deleteMany().catch(() => {});
    });

    it("does not treat alias-only provider-account usage rows as authority for v3 connected-service quota GET", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        await createConnectedServiceProfileBinding(user.id, { providerAccountId: "acct_canonical_v3_source" });
        const snapshot = createUsageSnapshot({ fetchedAt: Date.now(), planLabel: "alias-backed" });

        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as any);
        await app.ready();

        const write = await app.inject({
            method: "POST",
            url: `/v3/connect/provider-account-usage/${snapshot.recordId}`,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: createV3ProviderAccountUsagePayload({ snapshot, fingerprint: "usage:red:alias-only" }),
        });
        expect(write.statusCode, write.body).toBe(200);
        expect(write.json()).toEqual({ success: true });

        const projected = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });

        expect(projected.statusCode).toBe(404);
        expect(projected.json()).toEqual({ error: "connect_quotas_not_found" });
    });

    it("links source context from canonical v3 provider-account usage writes and exposes it as a connected-service quota view", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        await createConnectedServiceProfileBinding(user.id, { providerAccountId: "acct_canonical_v3_source" });
        const snapshot = createUsageSnapshot({
            fetchedAt: Date.now(),
            recordKey: createProviderAccountUsageRecordKey({ accountSubjectId: "acct_canonical_v3_source" }),
            planLabel: "canonical-source",
        });

        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as any);
        await app.ready();

        const write = await app.inject({
            method: "POST",
            url: `/v3/connect/provider-account-usage/${snapshot.recordId}`,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                ...createV3ProviderAccountUsagePayload({ snapshot, fingerprint: "usage:canonical:v3-source" }),
                source: {
                    serviceId: "openai-codex",
                    profileId: "work",
                    bindingKind: "profile",
                },
            },
        });
        expect(write.statusCode, write.body).toBe(200);
        expect(write.json()).toEqual({
            success: true,
            source: { status: "linked" },
        });

        const source = await db.connectedServiceUsageSource.findFirst({
            where: {
                accountId: user.id,
                serviceId: "openai-codex",
                profileId: "work",
            },
            select: { providerAccountUsageRecordId: true, bindingKind: true },
        });
        expect(source).toEqual({
            providerAccountUsageRecordId: snapshot.recordId,
            bindingKind: "account",
        });

        const projected = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });

        expect(projected.statusCode).toBe(200);
        expect(projected.json()).toMatchObject({
            content: {
                t: "plain",
                v: {
                    serviceId: "openai-codex",
                    profileId: "work",
                    activeAccountId: "acct_canonical_v3_source",
                    planLabel: "canonical-source",
                },
            },
            metadata: {
                fetchedAt: snapshot.fetchedAtMs,
                staleAfterMs: snapshot.staleAfterMs,
                status: "ok",
            },
        });
    });

    it("returns active group-member connected-service usage sources from canonical v3 provider-account usage GET", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        await createConnectedServiceGroupMemberBinding({
            accountId: user.id,
            groupId: "team",
            generation: 7,
            providerAccountId: "acct_group_member_v3_source",
        });
        const snapshot = createUsageSnapshot({
            fetchedAt: Date.now(),
            recordKey: createProviderAccountUsageRecordKey({ accountSubjectId: "acct_group_member_v3_source" }),
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
                ...createV3ProviderAccountUsagePayload({ snapshot, fingerprint: "usage:canonical:v3-group-member" }),
                source: {
                    serviceId: "openai-codex",
                    profileId: "work",
                    bindingKind: "group_member",
                    groupId: "team",
                },
            },
        });
        expect(write.statusCode, write.body).toBe(200);

        const read = await app.inject({
            method: "GET",
            url: `/v3/connect/provider-account-usage/${snapshot.recordId}`,
            headers: { "x-test-user-id": user.id },
        });

        expect(read.statusCode).toBe(200);
        expect(read.json()).toMatchObject({
            content: {
                t: "plain",
                v: {
                    recordId: snapshot.recordId,
                    planLabel: "group-member-source",
                },
            },
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

    it("rejects same-account v3 source links when the provider usage record is incompatible with the connected service", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        await createConnectedServiceProfileBinding(user.id, { providerAccountId: "acct_legacy_connected_subject" });
        const snapshot = createUsageSnapshot({
            fetchedAt: Date.now(),
            recordKey: createProviderAccountUsageRecordKey({
                providerId: "claude",
                accountSubjectId: "acct_wrong_provider_v3_source",
            }),
            planLabel: "wrong-provider-source",
        });

        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as any);
        await app.ready();

        const write = await app.inject({
            method: "POST",
            url: `/v3/connect/provider-account-usage/${snapshot.recordId}`,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                ...createV3ProviderAccountUsagePayload({ snapshot, fingerprint: "usage:v3:wrong-provider-source" }),
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
                    recordId: snapshot.recordId,
                },
            },
            select: { id: true },
        })).toBeNull();
    });

    it("rejects same-service v3 source links when the provider account identity does not match the connected profile", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        await createConnectedServiceProfileBinding(user.id, { providerAccountId: "acct_connected_profile_v3_source" });
        const snapshot = createUsageSnapshot({
            fetchedAt: Date.now(),
            recordKey: createProviderAccountUsageRecordKey({
                providerId: "openai-codex",
                accountSubjectId: "acct_different_provider_v3_source",
            }),
            planLabel: "wrong-provider-account-source",
        });

        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as any);
        await app.ready();

        const write = await app.inject({
            method: "POST",
            url: `/v3/connect/provider-account-usage/${snapshot.recordId}`,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                ...createV3ProviderAccountUsagePayload({ snapshot, fingerprint: "usage:v3:wrong-provider-account-source" }),
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
                    recordId: snapshot.recordId,
                },
            },
            select: { id: true },
        })).toBeNull();
    });

    it("does not create provider-account refresh placeholders from profile bindings without a linked source-backed record", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "server_sealed",
        });
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        await createConnectedServiceProfileBinding(user.id, { providerAccountId: "acct_legacy_connected_subject" });

        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as any);
        await app.ready();

        const refresh = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/profiles/work/quotas/refresh",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {},
        });

        expect(refresh.statusCode).toBe(404);
        expect(refresh.json()).toEqual({ error: "connect_quotas_not_found" });
        expect(await db.providerAccountUsageRecord.findUnique({
            where: {
                accountId_recordId: {
                    accountId: user.id,
                    recordId: buildProviderAccountUsageRecordId({
                        providerId: "openai-codex",
                        accountSubjectId: "legacy-connected-service:openai-codex:work",
                        subjectKind: "unknown",
                        quotaScope: "account",
                    }),
                },
            },
            select: { id: true },
        })).toBeNull();
    });

    it("preserves the provider-account usage record when deleting a connected-service quota view", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        await createConnectedServiceProfileBinding(user.id, { providerAccountId: "acct_legacy_connected_subject" });
        const fetchedAt = Date.now();
        const snapshot = createLegacyQuotaSnapshot({ fetchedAt, planLabel: "delete-preserves-record" });

        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as any);
        await app.ready();

        const providerSnapshot = createUsageSnapshot({
            fetchedAt,
            recordKey: createProviderAccountUsageRecordKey({
                providerId: snapshot.providerId ?? "codex",
                accountSubjectId: snapshot.activeAccountId ?? "acct_delete_preserves_record",
            }),
            planLabel: snapshot.planLabel,
        });
        await writeQualifiedProviderAccountUsageRecordFromLegacyBoundary({
            accountId: user.id,
            recordId: providerSnapshot.recordId,
            recordKey: providerSnapshot.recordKey,
            payloadMode: "plain_json_v1",
            status: "ok",
            fetchedAt: providerSnapshot.fetchedAtMs,
            staleAfterMs: providerSnapshot.staleAfterMs,
            materialFingerprint: "usage:red:preserve-provider-record",
            snapshot: providerSnapshot,
            source: {
                ref: {
                    service:
                        resolveLegacyQualifiedConnectedAccountService(
                            "openai-codex",
                        ),
                    accountId: "work",
                },
                bindingKind: "account",
            },
        });

        const quotaBeforeDelete = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });
        expect(quotaBeforeDelete.statusCode).toBe(200);

        const deleted = await app.inject({
            method: "DELETE",
            url: "/v3/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });
        expect(deleted.statusCode).toBe(200);
        expect(deleted.json()).toEqual({ success: true });

        const providerRead = await app.inject({
            method: "GET",
            url: `/v3/connect/provider-account-usage/${providerSnapshot.recordId}`,
            headers: { "x-test-user-id": user.id },
        });
        expect(providerRead.statusCode).toBe(200);

        const quotaRead = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });
        expect(quotaRead.statusCode).toBe(404);
        expect(quotaRead.json()).toEqual({ error: "connect_quotas_not_found" });
    });

    it("projects the server-v0.2.1 V3 plain quota write through the canonical provider-account usage record", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        await createConnectedServiceProfileBinding(user.id, {
            providerAccountId: "acct_released_preview_v3",
            legacyUnfenced: true,
        });
        const recordKey = {
            providerId: "openai-codex",
            accountSubjectId: "acct_released_preview_v3",
            subjectKind: "account",
            quotaScope: "account",
        } as const;
        const recordId = buildProviderAccountUsageRecordId(recordKey);

        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as any);
        await app.ready();

        const write = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/profiles/work/quotas",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                content: { t: "plain", v: releasedServerV021PlainQuotaSnapshot },
                metadata: {
                    fetchedAt: releasedServerV021PlainQuotaSnapshot.fetchedAt,
                    staleAfterMs: releasedServerV021PlainQuotaSnapshot.staleAfterMs,
                    status: "ok",
                },
            },
        });
        expect(write.statusCode, write.body).toBe(200);
        expect(write.json()).toEqual({ success: true });

        const staleWrite = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/profiles/work/quotas",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                content: {
                    t: "plain",
                    v: {
                        ...releasedServerV021PlainQuotaSnapshot,
                        fetchedAt: releasedServerV021PlainQuotaSnapshot.fetchedAt - 1,
                        planLabel: "stale-release-write",
                    },
                },
                metadata: {
                    fetchedAt: releasedServerV021PlainQuotaSnapshot.fetchedAt - 1,
                    staleAfterMs: releasedServerV021PlainQuotaSnapshot.staleAfterMs,
                    status: "ok",
                },
            },
        });
        expect(staleWrite.statusCode, staleWrite.body).toBe(200);
        expect(staleWrite.json()).toEqual({ success: true });
        expect(await db.providerAccountUsageRecord.findUnique({
            where: {
                accountId_recordId: {
                    accountId: user.id,
                    recordId,
                },
            },
            select: {
                providerId: true,
                accountSubjectId: true,
                subjectKind: true,
                quotaScope: true,
                fetchedAt: true,
                staleAfterMs: true,
            },
        })).toEqual({
            providerId: "openai-codex",
            accountSubjectId: "acct_released_preview_v3",
            subjectKind: "account",
            quotaScope: "account",
            fetchedAt: new Date(releasedServerV021PlainQuotaSnapshot.fetchedAt),
            staleAfterMs: releasedServerV021PlainQuotaSnapshot.staleAfterMs,
        });
        expect(await db.connectedServiceUsageSource.findFirst({
            where: {
                accountId: user.id,
                serviceId: "openai-codex",
                profileId: "work",
            },
            select: { id: true },
        })).toEqual({ id: expect.any(String) });

        const read = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });
        expect(read.statusCode, read.body).toBe(200);
        expect(read.json()).toMatchObject({
            content: {
                t: "plain",
                v: releasedServerV021PlainQuotaSnapshot,
            },
            metadata: {
                fetchedAt: releasedServerV021PlainQuotaSnapshot.fetchedAt,
                staleAfterMs: releasedServerV021PlainQuotaSnapshot.staleAfterMs,
                status: "ok",
            },
        });

        const refresh = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/profiles/work/quotas/refresh",
            headers: { "x-test-user-id": user.id },
        });
        expect(refresh.statusCode, refresh.body).toBe(200);
        expect(refresh.json()).toEqual({ success: true });

        const refreshedRead = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });
        expect(refreshedRead.statusCode, refreshedRead.body).toBe(200);
        expect(refreshedRead.json()).toMatchObject({
            metadata: { refreshRequestedAt: expect.any(Number) },
        });

        const deleted = await app.inject({
            method: "DELETE",
            url: "/v3/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });
        expect(deleted.statusCode, deleted.body).toBe(200);
        expect(deleted.json()).toEqual({ success: true });
        expect(await db.providerAccountUsageRecord.findUnique({
            where: {
                accountId_recordId: {
                    accountId: user.id,
                    recordId,
                },
            },
            select: { id: true },
        })).toEqual({ id: expect.any(String) });
    });

    it("rejects client-authored aliases on v2 sealed provider-account usage writes", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "required_e2ee",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "e2ee",
        });
        const user = await createReadyE2eeAccount();
        const snapshot = createUsageSnapshot({ fetchedAt: Date.now() });

        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as any);
        await app.ready();

        const write = await app.inject({
            method: "POST",
            url: `/v2/connect/provider-account-usage/${snapshot.recordId}`,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                sealed: {
                    format: "account_scoped_v1",
                    ciphertext: "sealed-provider-account-usage",
                },
                metadata: {
                    fetchedAt: snapshot.fetchedAtMs,
                    staleAfterMs: snapshot.staleAfterMs,
                    status: "ok",
                    aliases: [{
                        kind: "connectedServiceProfile",
                        providerId: "codex",
                        serviceId: "openai-codex",
                        profileId: "work",
                        accountSubjectId: "acct_provider_subject",
                    }],
                },
            },
        });

        expect(write.statusCode).toBe(400);
        expect(write.json()).toEqual({
            error: "invalid-params",
            reason: "provider_account_usage_legacy_aliases_rejected",
        });
        expect(await db.providerAccountUsageRecord.findUnique({
            where: {
                accountId_recordId: {
                    accountId: user.id,
                    recordId: snapshot.recordId,
                },
            },
            select: { id: true },
        })).toBeNull();
    });

    it("rejects v3 provider-account usage writes before persisting when the source binding is unavailable", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        const snapshot = createUsageSnapshot({
            fetchedAt: Date.now(),
            recordKey: createProviderAccountUsageRecordKey({ accountSubjectId: "acct_missing_v3_source" }),
            planLabel: "missing-source-binding",
        });

        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as any);
        await app.ready();

        const write = await app.inject({
            method: "POST",
            url: `/v3/connect/provider-account-usage/${snapshot.recordId}`,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                ...createV3ProviderAccountUsagePayload({ snapshot, fingerprint: "usage:v3:missing-source" }),
                source: {
                    serviceId: "openai-codex",
                    profileId: "missing-profile-binding",
                    bindingKind: "profile",
                },
            },
        });

        expect(write.statusCode, write.body).toBe(400);
        expect(write.json()).toEqual({
            error: "invalid-params",
            reason: "connected_service_usage_source_invalid",
        });
        expect(await db.providerAccountUsageRecord.findUnique({
            where: {
                accountId_recordId: {
                    accountId: user.id,
                    recordId: snapshot.recordId,
                },
            },
            select: { id: true },
        })).toBeNull();
    });

    it("creates sealed provider-account usage records from canonical v2 writes with recordKey and source context", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "required_e2ee",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "e2ee",
        });
        const user = await createReadyE2eeAccount();
        await createConnectedServiceProfileBinding(user.id, { providerAccountId: "acct_canonical_v2_source" });
        const recordKey = createProviderAccountUsageRecordKey({ accountSubjectId: "acct_canonical_v2_source" });
        const recordId = buildProviderAccountUsageRecordId(recordKey);

        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as any);
        await app.ready();

        const write = await app.inject({
            method: "POST",
            url: `/v2/connect/provider-account-usage/${recordId}`,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                recordKey,
                sealed: {
                    format: "account_scoped_v1",
                    ciphertext: "sealed-canonical-provider-account-usage",
                },
                legacyQuotaCompatibility: {
                    format: "account_scoped_v1",
                    ciphertext:
                        "oQQhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzg5fEl9K9e0gbQcLrSkvsMc0Wbde5VEgjODqJnwlP50/98/oh/sEPqZQamcCTwpYsU=",
                },
                metadata: {
                    fetchedAt: 12_345,
                    staleAfterMs: 300_000,
                    status: "ok",
                    materialFingerprint: "usage:canonical:v2-source",
                },
                source: {
                    serviceId: "openai-codex",
                    profileId: "work",
                    bindingKind: "profile",
                },
            },
        });
        expect(write.statusCode, write.body).toBe(200);
        expect(write.json()).toEqual({
            success: true,
            source: { status: "linked" },
        });

        const canonicalRead = await app.inject({
            method: "GET",
            url: `/v2/connect/provider-account-usage/${recordId}`,
            headers: { "x-test-user-id": user.id },
        });
        expect(canonicalRead.statusCode).toBe(200);
        expect(canonicalRead.json()).toEqual({
            sealed: {
                format: "account_scoped_v1",
                ciphertext:
                    "sealed-canonical-provider-account-usage",
            },
            metadata: {
                fetchedAt: 12_345,
                staleAfterMs: 300_000,
                status: "ok",
                materialFingerprint:
                    "usage:canonical:v2-source",
            },
            sources: [{
                serviceId: "openai-codex",
                profileId: "work",
                bindingKind: "profile",
            }],
        });

        const quotaRead = await app.inject({
            method: "GET",
            url: "/v2/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });
        expect(quotaRead.statusCode).toBe(200);
        expect(quotaRead.json()).toEqual({
            sealed: {
                format: "account_scoped_v1",
                ciphertext:
                    "oQQhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzg5fEl9K9e0gbQcLrSkvsMc0Wbde5VEgjODqJnwlP50/98/oh/sEPqZQamcCTwpYsU=",
            },
            metadata: {
                fetchedAt: 12_345,
                staleAfterMs: 300_000,
                status: "ok",
            },
        });
    });

    it("converges a legacy v3 source write and a v4 write on one qualified source row", async () => {
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
        const ref = {
            service:
                resolveLegacyQualifiedConnectedAccountService(
                    "openai-codex",
                ),
            accountId: "work",
        };
        const credential =
            await mutateQualifiedConnectedServiceCredential({
                accountId: user.id,
                ref,
                expectedCredentialRevision: null,
                authenticationModeId: "oauth",
                content: {
                    t: "plain",
                    v: { token: "mixed-source-token" },
                },
                metadata: {
                    displayName: "Mixed source",
                    scopes: ["quota.read"],
                    providerIdentity: {
                        accountId: "acct_mixed_source",
                    },
                },
                legacyIdentity: {
                    serviceId: "openai-codex",
                    profileId: "work",
                },
            });
        if (credential.status !== "written") {
            throw new Error("Expected qualified credential create");
        }
        const recordKey = createProviderAccountUsageRecordKey({
            accountSubjectId: "acct_mixed_source",
        });
        const snapshot = createUsageSnapshot({
            fetchedAt: Date.now(),
            recordKey,
            planLabel: "mixed-source",
        });
        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as never);
        await app.ready();

        const legacyWrite = await app.inject({
            method: "POST",
            url: `/v3/connect/provider-account-usage/${snapshot.recordId}`,
            headers: {
                "content-type": "application/json",
                "x-test-user-id": user.id,
            },
            payload: {
                ...createV3ProviderAccountUsagePayload({
                    snapshot,
                    fingerprint: "usage:mixed-source:v3",
                }),
                source: {
                    serviceId: "openai-codex",
                    profileId: "work",
                    bindingKind: "profile",
                },
            },
        });
        expect(legacyWrite.statusCode, legacyWrite.body).toBe(200);

        const qualifiedWrite = await app.inject({
            method: "POST",
            url: "/v4/connect/qualified/provider-account-usage",
            headers: {
                "content-type": "application/json",
                "x-test-user-id": user.id,
            },
            payload: {
                source: { ref, bindingKind: "account" },
                expectedCredentialRevision:
                    credential.credentialRevision,
                expectedConfigurationRevision:
                    credential.configurationRevision,
                recordId: snapshot.recordId,
                recordKey: snapshot.recordKey,
                payloadMode: "plain_json_v1",
                status: "ok",
                snapshot,
                fetchedAt: snapshot.fetchedAtMs,
                staleAfterMs: snapshot.staleAfterMs,
                metadata: {
                    materialFingerprint:
                        "usage:mixed-source:v4",
                },
            },
        });
        expect(qualifiedWrite.statusCode, qualifiedWrite.body).toBe(200);

        await expect(db.connectedServiceUsageSource.count({
            where: {
                accountId: user.id,
                servicePluginId: ref.service.pluginId,
                serviceLocalId: ref.service.localId,
                connectedAccountId: ref.accountId,
                bindingKind: { in: ["account", "profile"] },
            },
        })).resolves.toBe(1);

        const legacyRead = await app.inject({
            method: "GET",
            url: `/v3/connect/provider-account-usage/${snapshot.recordId}`,
            headers: { "x-test-user-id": user.id },
        });
        expect(legacyRead.statusCode, legacyRead.body).toBe(200);
        expect(legacyRead.json()).toMatchObject({
            sources: [{
                serviceId: "openai-codex",
                profileId: "work",
                bindingKind: "profile",
            }],
        });
    });

    it("rejects same-account v2 source links when the provider usage record is incompatible with the connected service", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "required_e2ee",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "e2ee",
        });
        const user = await createReadyE2eeAccount();
        await createConnectedServiceProfileBinding(user.id, { providerAccountId: "acct_deleted_credential_source" });
        const recordKey = createProviderAccountUsageRecordKey({
            providerId: "claude",
            accountSubjectId: "acct_wrong_provider_v2_source",
        });
        const recordId = buildProviderAccountUsageRecordId(recordKey);

        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as any);
        await app.ready();

        const write = await app.inject({
            method: "POST",
            url: `/v2/connect/provider-account-usage/${recordId}`,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                recordKey,
                sealed: {
                    format: "account_scoped_v1",
                    ciphertext: "sealed-wrong-provider-source",
                },
                metadata: {
                    fetchedAt: 22_345,
                    staleAfterMs: 300_000,
                    status: "ok",
                    materialFingerprint: "usage:v2:wrong-provider-source",
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

    it("rejects same-service v2 source links when the provider account identity does not match the connected profile", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "required_e2ee",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "e2ee",
        });
        const user = await createReadyE2eeAccount();
        await createConnectedServiceProfileBinding(user.id, { providerAccountId: "acct_connected_profile_v2_source" });
        const recordKey = createProviderAccountUsageRecordKey({
            providerId: "openai-codex",
            accountSubjectId: "acct_different_provider_v2_source",
        });
        const recordId = buildProviderAccountUsageRecordId(recordKey);

        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as any);
        await app.ready();

        const write = await app.inject({
            method: "POST",
            url: `/v2/connect/provider-account-usage/${recordId}`,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                recordKey,
                sealed: {
                    format: "account_scoped_v1",
                    ciphertext: "sealed-wrong-provider-account-source",
                },
                metadata: {
                    fetchedAt: 23_345,
                    staleAfterMs: 300_000,
                    status: "ok",
                    materialFingerprint: "usage:v2:wrong-provider-account-source",
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

    it("unlinks a source-backed connected-service quota view when the credential is deleted", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        const ref = {
            service:
                resolveLegacyQualifiedConnectedAccountService(
                    "openai-codex",
                ),
            accountId: "work",
        };
        const credential =
            await mutateQualifiedConnectedServiceCredential({
                accountId: user.id,
                ref,
                expectedCredentialRevision: null,
                authenticationModeId: "oauth",
                content: {
                    t: "plain",
                    v: { token: "delete-credential-source-token" },
                },
                metadata: {
                    displayName: "Delete credential source",
                    scopes: ["quota.read"],
                    providerIdentity: {
                        accountId: "acct_deleted_credential_source",
                    },
                },
                legacyIdentity: {
                    serviceId: "openai-codex",
                    profileId: "work",
                },
            });
        if (credential.status !== "written") {
            throw new Error("Expected qualified credential create");
        }
        const snapshot = createUsageSnapshot({
            fetchedAt: Date.now(),
            recordKey: createProviderAccountUsageRecordKey({ accountSubjectId: "acct_deleted_credential_source" }),
        });
        await writeQualifiedProviderAccountUsageRecordFromLegacyBoundary({
            accountId: user.id,
            recordId: snapshot.recordId,
            recordKey: snapshot.recordKey,
            payloadMode: "plain_json_v1",
            status: "ok",
            fetchedAt: snapshot.fetchedAtMs,
            staleAfterMs: snapshot.staleAfterMs,
            materialFingerprint: "usage:delete-credential-source",
            snapshot,
            source: {
                ref,
                bindingKind: "account",
            },
        });

        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as any);
        await app.ready();

        const beforeDelete = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });
        expect(beforeDelete.statusCode).toBe(200);

        const deleted = await app.inject({
            method: "DELETE",
            url: `/v3/connect/openai-codex/profiles/work/credential?expectedCredentialRevision=${encodeURIComponent(credential.credentialRevision)}`,
            headers: { "x-test-user-id": user.id },
        });
        expect(deleted.statusCode).toBe(200);

        const afterDelete = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });
        expect(afterDelete.statusCode).toBe(404);
        expect(afterDelete.json()).toEqual({ error: "connect_quotas_not_found" });
        expect(await db.connectedServiceUsageSource.findFirst({
            where: {
                accountId: user.id,
                serviceId: "openai-codex",
                profileId: "work",
            },
            select: { id: true },
        })).toBeNull();
    });

    it("projects the server-v0.2.1 V2 sealed quota write for a current ready E2EE account", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "required_e2ee",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "e2ee",
        });
        const user = await createReadyE2eeAccount();
        await createConnectedServiceProfileBinding(user.id, {
            providerAccountId: "acct_released_preview_v2",
            legacyUnfenced: true,
        });
        const recordKey = {
            providerId: "openai-codex",
            accountSubjectId: "acct_released_preview_v2",
            subjectKind: "account",
            quotaScope: "account",
        } as const;
        const recordId = buildProviderAccountUsageRecordId(recordKey);
        // This is a valid account-scoped ciphertext kind-4 boundary vector; the
        // release route accepts opaque per-account ciphertext and cannot publish
        // a reusable release artifact vector.
        const ciphertext = "oQQhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzg5fEl9K9e0gbQcLrSkvsMc0Wbde5VEgjODqJnwlP50/98/oh/sEPqZQamcCTwpYsU=";
        expect(readAccountScopedCiphertextKindByte(ciphertext)).toBe(4);

        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as any);
        await app.ready();

        const write = await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/profiles/work/quotas",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                sealed: { format: "account_scoped_v1", ciphertext },
                metadata: {
                    fetchedAt: 1_234,
                    staleAfterMs: 300_000,
                    status: "ok",
                },
            },
        });
        expect(write.statusCode, write.body).toBe(200);
        expect(write.json()).toEqual({ success: true });
        expect(await db.providerAccountUsageRecord.findUnique({
            where: {
                accountId_recordId: {
                    accountId: user.id,
                    recordId,
                },
            },
            select: {
                providerId: true,
                accountSubjectId: true,
                subjectKind: true,
                quotaScope: true,
            },
        })).toEqual({
            providerId: "openai-codex",
            accountSubjectId: "acct_released_preview_v2",
            subjectKind: "account",
            quotaScope: "account",
        });

        const read = await app.inject({
            method: "GET",
            url: "/v2/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });
        expect(read.statusCode, read.body).toBe(200);
        expect(read.json()).toEqual({
            sealed: { format: "account_scoped_v1", ciphertext },
            metadata: {
                fetchedAt: 1_234,
                staleAfterMs: 300_000,
                status: "ok",
            },
        });

        const refresh = await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/profiles/work/quotas/refresh",
            headers: { "x-test-user-id": user.id },
        });
        expect(refresh.statusCode, refresh.body).toBe(200);
        expect(refresh.json()).toEqual({ success: true });

        const refreshedRead = await app.inject({
            method: "GET",
            url: "/v2/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });
        expect(refreshedRead.statusCode, refreshedRead.body).toBe(200);
        expect(refreshedRead.json()).toMatchObject({
            metadata: { refreshRequestedAt: expect.any(Number) },
        });

        const deleted = await app.inject({
            method: "DELETE",
            url: "/v2/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });
        expect(deleted.statusCode, deleted.body).toBe(200);
        expect(deleted.json()).toEqual({ success: true });
        expect(await db.providerAccountUsageRecord.findUnique({
            where: {
                accountId_recordId: {
                    accountId: user.id,
                    recordId,
                },
            },
            select: { id: true },
        })).toEqual({ id: expect.any(String) });
    });

    it("keeps the server-v0.2.1 V2 sealed quota view readable after a newer V2 sealed quota write", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "required_e2ee",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "e2ee",
        });
        const user = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
            },
            select: { id: true },
        });
        await createConnectedServiceProfileBinding(user.id, {
            providerAccountId: "acct_released_preview_v2_sequential",
            legacyUnfenced: true,
        });
        // Two distinct account-scoped kind-4 boundary vectors; the V2 sealed
        // quota route never carries a material fingerprint, so the second write
        // exercises the no-fingerprint newer-data branch of the write policy.
        const firstCiphertext = "oQQhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzg5fEl9K9e0gbQcLrSkvsMc0Wbde5VEgjODqJnwlP50/98/oh/sEPqZQamcCTwpYsU=";
        const secondCiphertext = "oQQhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzg5fEl9K9e0gbQcLrSkvsMc0Wbde5VEgjODqJnwlP50/98/oh/sEPqZQamcCTwpYjo=";
        expect(readAccountScopedCiphertextKindByte(firstCiphertext)).toBe(4);
        expect(readAccountScopedCiphertextKindByte(secondCiphertext)).toBe(4);

        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as any);
        await app.ready();

        const firstWrite = await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/profiles/work/quotas",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                sealed: { format: "account_scoped_v1", ciphertext: firstCiphertext },
                metadata: {
                    fetchedAt: 1_234,
                    staleAfterMs: 300_000,
                    status: "ok",
                },
            },
        });
        expect(firstWrite.statusCode, firstWrite.body).toBe(200);

        const secondWrite = await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/profiles/work/quotas",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                sealed: { format: "account_scoped_v1", ciphertext: secondCiphertext },
                metadata: {
                    fetchedAt: 5_678,
                    staleAfterMs: 300_000,
                    status: "estimated",
                },
            },
        });
        expect(secondWrite.statusCode, secondWrite.body).toBe(200);

        const read = await app.inject({
            method: "GET",
            url: "/v2/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });
        expect(read.statusCode, read.body).toBe(200);
        expect(read.json()).toEqual({
            sealed: { format: "account_scoped_v1", ciphertext: secondCiphertext },
            metadata: {
                fetchedAt: 5_678,
                staleAfterMs: 300_000,
                status: "estimated",
            },
        });
    });

    it("fails closed for the server-v0.2.1 V2 sealed quota write when E2EE lacks a signed content binding", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "required_e2ee",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "e2ee",
        });
        const releasedSigningBinding = createSignedAccountContentBinding();
        const user = await db.account.create({
            data: {
                publicKey: releasedSigningBinding.publicKey,
                encryptionMode: "e2ee",
                contentPublicKey: null,
                contentPublicKeySig: null,
            },
            select: { id: true },
        });
        await createConnectedServiceProfileBinding(user.id, {
            providerAccountId: "acct_unbound_e2ee_v2",
        });
        const recordId = buildProviderAccountUsageRecordId({
            providerId: "openai-codex",
            accountSubjectId: "acct_unbound_e2ee_v2",
            subjectKind: "account",
            quotaScope: "account",
        });

        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as any);
        await app.ready();

        const write = await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/profiles/work/quotas",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                sealed: {
                    format: "account_scoped_v1",
                    ciphertext: "oQQhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzg5fEl9K9e0gbQcLrSkvsMc0Wbde5VEgjODqJnwlP50/98/oh/sEPqZQamcCTwpYsU=",
                },
                metadata: {
                    fetchedAt: 1_234,
                    staleAfterMs: 300_000,
                    status: "ok",
                },
            },
        });
        expect(write.statusCode, write.body).toBe(400);
        expect(write.json()).toEqual({ error: "invalid-params" });
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
});
