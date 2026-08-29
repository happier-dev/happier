import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { db } from "@/storage/db";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { connectRoutes } from "./connectRoutes";
import { readProviderAccountUsageRecord } from "./providerAccountUsage";
import {
    closeProviderAccountUsageTrackedApps,
    createProviderAccountUsageRecordKey,
    createProviderAccountUsageTestApp,
    createUsageSnapshot,
} from "./providerAccountUsageTestkit";
import {
    resolveLegacyQualifiedConnectedAccountService,
} from "./qualifiedConnectedAccounts/identity";

function createQualifiedLegacyRef(profileId: string = "work") {
    return {
        service: resolveLegacyQualifiedConnectedAccountService("openai-codex"),
        accountId: profileId,
    };
}

async function createQualifiedPlainCredential(params: Readonly<{
    app: ReturnType<typeof createProviderAccountUsageTestApp>;
    accountId: string;
    providerAccountId: string;
}>) {
    const ref = createQualifiedLegacyRef();
    const created = await params.app.inject({
        method: "POST",
        url: "/v4/connect/qualified/credential",
        headers: {
            "content-type": "application/json",
            "x-test-user-id": params.accountId,
        },
        payload: {
            ref,
            authenticationModeId: "oauth",
            expectedCredentialRevision: null,
            content: { t: "plain", v: { token: "v4-credential" } },
            metadata: {
                scopes: ["quota.read"],
                providerIdentity: { accountId: params.providerAccountId },
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
    expect(created.statusCode, created.body).toBe(200);
    return { ref, ...created.json() };
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

    it("returns the released plaintext profile quota from a V4 qualified usage record", async () => {
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
        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as never);
        await app.ready();

        const credential = await createQualifiedPlainCredential({
            app,
            accountId: user.id,
            providerAccountId: "acct_quota_v3_projection",
        });
        const snapshot = createUsageSnapshot({
            fetchedAt: Date.now(),
            recordKey: createProviderAccountUsageRecordKey({
                accountSubjectId: "acct_quota_v3_projection",
            }),
            planLabel: "plan-secret-12345",
        });
        const write = await app.inject({
            method: "POST",
            url: "/v4/connect/qualified/provider-account-usage",
            headers: {
                "content-type": "application/json",
                "x-test-user-id": user.id,
            },
            payload: {
                source: { ref: credential.ref, bindingKind: "account" },
                expectedCredentialRevision: credential.credentialRevision,
                expectedConfigurationRevision: credential.configurationRevision,
                recordId: snapshot.recordId,
                recordKey: snapshot.recordKey,
                payloadMode: "plain_json_v1",
                status: "ok",
                snapshot,
                fetchedAt: snapshot.fetchedAtMs,
                staleAfterMs: snapshot.staleAfterMs,
                metadata: { materialFingerprint: "v4:v3:projection" },
            },
        });
        expect(write.statusCode, write.body).toBe(200);
        expect(write.json()).toEqual({
            success: true,
            source: { status: "linked" },
        });

        const read = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });
        expect(read.statusCode).toBe(200);
        expect(read.json()).toEqual({
            content: {
                t: "plain",
                v: expect.objectContaining({
                    serviceId: "openai-codex",
                    profileId: "work",
                    planLabel: "plan-secret-12345",
                }),
            },
            metadata: {
                fetchedAt: snapshot.fetchedAtMs,
                staleAfterMs: snapshot.staleAfterMs,
                status: "ok",
            },
        });
    });

    it("refreshes and deletes the released plaintext profile quota without deleting its V4 record", async () => {
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

        const credential = await createQualifiedPlainCredential({
            app,
            accountId: user.id,
            providerAccountId: "acct_quota_v3_refresh",
        });
        const snapshot = createUsageSnapshot({
            fetchedAt: Date.now(),
            recordKey: createProviderAccountUsageRecordKey({
                accountSubjectId: "acct_quota_v3_refresh",
            }),
            planLabel: "refresh-source",
        });
        expect((await app.inject({
            method: "POST",
            url: "/v4/connect/qualified/provider-account-usage",
            headers: {
                "content-type": "application/json",
                "x-test-user-id": user.id,
            },
            payload: {
                source: { ref: credential.ref, bindingKind: "account" },
                expectedCredentialRevision: credential.credentialRevision,
                expectedConfigurationRevision: credential.configurationRevision,
                recordId: snapshot.recordId,
                recordKey: snapshot.recordKey,
                payloadMode: "plain_json_v1",
                status: "ok",
                snapshot,
                fetchedAt: snapshot.fetchedAtMs,
                staleAfterMs: snapshot.staleAfterMs,
            },
        })).statusCode).toBe(200);

        const refresh = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/profiles/work/quotas/refresh",
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
            url: "/v3/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });
        expect(deleted.statusCode).toBe(200);
        expect(deleted.json()).toEqual({ success: true });
        await expect(readProviderAccountUsageRecord({
            accountId: user.id,
            recordId: snapshot.recordId,
        })).resolves.toEqual(expect.objectContaining({
            recordId: snapshot.recordId,
            payloadMode: "plain_json_v1",
        }));

        const missing = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });
        expect(missing.statusCode).toBe(404);
        expect(missing.json()).toEqual({ error: "connect_quotas_not_found" });
    });

    it("preserves the qualified PAU storage-mode mismatch instead of hiding it as quota not-found", async () => {
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
        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as never);
        await app.ready();
        const credential = await createQualifiedPlainCredential({
            app,
            accountId: user.id,
            providerAccountId: "acct_quota_v3_mode_drift",
        });
        const snapshot = createUsageSnapshot({
            fetchedAt: Date.now(),
            recordKey: createProviderAccountUsageRecordKey({
                accountSubjectId: "acct_quota_v3_mode_drift",
            }),
            planLabel: "retained-history",
        });
        expect((await app.inject({
            method: "POST",
            url: "/v4/connect/qualified/provider-account-usage",
            headers: {
                "content-type": "application/json",
                "x-test-user-id": user.id,
            },
            payload: {
                source: { ref: credential.ref, bindingKind: "account" },
                expectedCredentialRevision: credential.credentialRevision,
                expectedConfigurationRevision: credential.configurationRevision,
                recordId: snapshot.recordId,
                recordKey: snapshot.recordKey,
                payloadMode: "plain_json_v1",
                status: "ok",
                snapshot,
                fetchedAt: snapshot.fetchedAtMs,
                staleAfterMs: snapshot.staleAfterMs,
            },
        })).statusCode).toBe(200);

        await db.account.update({
            where: { id: user.id },
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
            },
        });
        const mismatch = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });
        expect(mismatch.statusCode).toBe(409);
        expect(mismatch.json()).toEqual({
            error: "provider_account_usage_storage_mode_mismatch",
        });
        await expect(readProviderAccountUsageRecord({
            accountId: user.id,
            recordId: snapshot.recordId,
        })).resolves.toEqual(expect.objectContaining({
            recordId: snapshot.recordId,
            payloadMode: "plain_json_v1",
        }));
    });
});
