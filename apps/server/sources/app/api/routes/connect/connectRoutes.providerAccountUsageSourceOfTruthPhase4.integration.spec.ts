import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
    encodeQualifiedConnectedAccountV4StructuredQueryValue,
    QualifiedConnectedServiceUsageSourceV4Schema,
    readAccountScopedCiphertextKindByte,
} from "@happier-dev/protocol";

import { db } from "@/storage/db";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { connectRoutes } from "./connectRoutes";
import {
    closeProviderAccountUsageTrackedApps,
    createProviderAccountUsageRecordKey,
    createProviderAccountUsageTestApp,
    createUsageSnapshot,
} from "./providerAccountUsageTestkit";
import {
    resolveLegacyQualifiedConnectedAccountService,
} from "./qualifiedConnectedAccounts/identity";
import {
    createLegacyCredentialFixtureIdentity,
} from "./testkit/qualifiedConnectedAccountFixtureIdentity";

function createQualifiedLegacyRef() {
    return {
        service: resolveLegacyQualifiedConnectedAccountService("openai-codex"),
        accountId: "work",
    };
}

async function createLegacyProfileBinding(params: Readonly<{
    accountId: string;
    providerAccountId: string;
    legacyUnfenced?: boolean;
}>): Promise<void> {
    await db.serviceAccountToken.create({
        data: {
            accountId: params.accountId,
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
                providerAccountId: params.providerAccountId,
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

async function createReadyE2eeAccount() {
    return await db.account.create({
        data: {
            ...createSignedAccountContentBinding(),
            encryptionMode: "e2ee",
        },
        select: { id: true },
    });
}

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
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-provider-account-usage-phase4-",
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

    it("resolves a V4 qualified usage source without exposing its snapshot payload", async () => {
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
        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as never);
        await app.ready();

        const ref = createQualifiedLegacyRef();
        const credential = await app.inject({
            method: "POST",
            url: "/v4/connect/qualified/credential",
            headers: {
                "content-type": "application/json",
                "x-test-user-id": user.id,
            },
            payload: {
                ref,
                authenticationModeId: "oauth",
                expectedCredentialRevision: null,
                content: { t: "plain", v: { token: "v4-credential" } },
                metadata: {
                    scopes: ["quota.read"],
                    providerIdentity: { accountId: "acct_exact_source" },
                },
                initialConfiguration: {
                    expectedConfigurationRevision: null,
                    replacementContentEnvelope: {
                        t: "plain",
                        v: { region: "eu" },
                    },
                },
            },
        });
        expect(credential.statusCode, credential.body).toBe(200);
        const credentialBody = credential.json();
        const snapshot = createUsageSnapshot({
            fetchedAt: Date.now(),
            recordKey: createProviderAccountUsageRecordKey({
                accountSubjectId: "acct_exact_source",
            }),
            planLabel: "exact-source",
        });
        const source = { ref, bindingKind: "account" } as const;
        const write = await app.inject({
            method: "POST",
            url: "/v4/connect/qualified/provider-account-usage",
            headers: {
                "content-type": "application/json",
                "x-test-user-id": user.id,
            },
            payload: {
                source,
                expectedCredentialRevision: credentialBody.credentialRevision,
                expectedConfigurationRevision:
                    credentialBody.configurationRevision,
                recordId: snapshot.recordId,
                recordKey: snapshot.recordKey,
                payloadMode: "plain_json_v1",
                status: "ok",
                snapshot,
                fetchedAt: snapshot.fetchedAtMs,
                staleAfterMs: snapshot.staleAfterMs,
            },
        });
        expect(write.statusCode, write.body).toBe(200);
        expect(write.json()).toEqual({
            success: true,
            source: { status: "linked" },
        });

        const encodedSource = encodeQualifiedConnectedAccountV4StructuredQueryValue(
            QualifiedConnectedServiceUsageSourceV4Schema,
            source,
        );
        const response = await app.inject({
            method: "GET",
            url:
                "/v4/connect/qualified/provider-account-usage/sources/resolve?source="
                + encodeURIComponent(encodedSource),
            headers: { "x-test-user-id": user.id },
        });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json()).toEqual({
            source,
            recordId: snapshot.recordId,
            providerAccountId: "acct_exact_source",
            fetchedAt: snapshot.fetchedAtMs,
            staleAfterMs: snapshot.staleAfterMs,
        });
    });

    it("projects the server-v0.2.1 V3 profile quota through refresh and delete", async () => {
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
        await createLegacyProfileBinding({
            accountId: user.id,
            providerAccountId: "acct_released_preview_v3",
            legacyUnfenced: true,
        });
        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as never);
        await app.ready();

        const write = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/profiles/work/quotas",
            headers: {
                "content-type": "application/json",
                "x-test-user-id": user.id,
            },
            payload: {
                content: {
                    t: "plain",
                    v: releasedServerV021PlainQuotaSnapshot,
                },
                metadata: {
                    fetchedAt: releasedServerV021PlainQuotaSnapshot.fetchedAt,
                    staleAfterMs:
                        releasedServerV021PlainQuotaSnapshot.staleAfterMs,
                    status: "ok",
                },
            },
        });
        expect(write.statusCode, write.body).toBe(200);

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
        });

        const refresh = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/profiles/work/quotas/refresh",
            headers: { "x-test-user-id": user.id },
        });
        expect(refresh.statusCode, refresh.body).toBe(200);

        const deleted = await app.inject({
            method: "DELETE",
            url: "/v3/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });
        expect(deleted.statusCode, deleted.body).toBe(200);
    });

    it("projects the server-v0.2.1 V2 sealed profile quota through refresh and delete", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "required_e2ee",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "e2ee",
        });
        const user = await createReadyE2eeAccount();
        await createLegacyProfileBinding({
            accountId: user.id,
            providerAccountId: "acct_released_preview_v2",
            legacyUnfenced: true,
        });
        const ciphertext =
            "oQQhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzg5fEl9K9e0gbQcLrSkvsMc0Wbde5VEgjODqJnwlP50/98/oh/sEPqZQamcCTwpYsU=";
        expect(readAccountScopedCiphertextKindByte(ciphertext)).toBe(4);
        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as never);
        await app.ready();

        const write = await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/profiles/work/quotas",
            headers: {
                "content-type": "application/json",
                "x-test-user-id": user.id,
            },
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

        const read = await app.inject({
            method: "GET",
            url: "/v2/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });
        expect(read.statusCode, read.body).toBe(200);
        expect(read.json()).toMatchObject({
            sealed: { format: "account_scoped_v1", ciphertext },
        });

        const refresh = await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/profiles/work/quotas/refresh",
            headers: { "x-test-user-id": user.id },
        });
        expect(refresh.statusCode, refresh.body).toBe(200);

        const deleted = await app.inject({
            method: "DELETE",
            url: "/v2/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });
        expect(deleted.statusCode, deleted.body).toBe(200);
    });

    it("fails closed when an E2EE account lacks a signed content binding", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "required_e2ee",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "e2ee",
        });
        const binding = createSignedAccountContentBinding();
        const user = await db.account.create({
            data: {
                publicKey: binding.publicKey,
                encryptionMode: "e2ee",
                contentPublicKey: null,
                contentPublicKeySig: null,
            },
            select: { id: true },
        });
        await createLegacyProfileBinding({
            accountId: user.id,
            providerAccountId: "acct_unbound_e2ee_v2",
        });
        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as never);
        await app.ready();

        const write = await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/profiles/work/quotas",
            headers: {
                "content-type": "application/json",
                "x-test-user-id": user.id,
            },
            payload: {
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
            },
        });
        expect(write.statusCode, write.body).toBe(400);
        expect(write.json()).toEqual({ error: "invalid-params" });
    });
});
