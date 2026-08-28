import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { db } from "@/storage/db";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { connectRoutes } from "./connectRoutes";
import {
    closeProviderAccountUsageTrackedApps,
    createProviderAccountUsageTestApp,
} from "./providerAccountUsageTestkit";
import {
    createLegacyCredentialFixtureIdentity,
} from "./testkit/qualifiedConnectedAccountFixtureIdentity";

async function createConnectedServiceProfileBinding(
    accountId: string,
    providerAccountId: string,
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
                v: 2,
                format: "account_scoped_v1",
                kind: "oauth",
                credentialRevision: "csr_abcdefghijklmnopqrstuvwxyz",
                providerAccountId,
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
        await db.$executeRawUnsafe(
            `DELETE FROM "ServiceAccountQuotaSnapshot"`,
        ).catch(() => {});
        await db.serviceAccountToken.deleteMany().catch(() => {});
        await db.account.deleteMany().catch(() => {});
    });

    it("keeps a populated released v0.2.1 sealed quota readable until a canonical write replaces it", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "required_e2ee",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "e2ee",
        });
        const user = await createReadyE2eeAccount();
        await createConnectedServiceProfileBinding(
            user.id,
            "acct_quota_v2_predecessor",
        );
        const ciphertext =
            "oQQhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzg5fEl9K9e0gbQcLrSkvsMc0Wbde5VEgjODqJnwlP50/98/oh/sEPqZQamcCTwpYsU=";

        // Exact released server-v0.2.1 physical shape. This is intentionally
        // seeded independently of the current Prisma model so the test proves
        // old-writer -> current-reader behavior instead of current self-agreement.
        await db.$executeRawUnsafe(`
            CREATE TABLE IF NOT EXISTS "ServiceAccountQuotaSnapshot" (
                "id" TEXT NOT NULL PRIMARY KEY,
                "accountId" TEXT NOT NULL,
                "vendor" TEXT NOT NULL,
                "profileId" TEXT NOT NULL DEFAULT 'default',
                "snapshot" BLOB NOT NULL,
                "status" TEXT,
                "fetchedAt" DATETIME,
                "staleAfterMs" INTEGER,
                "metadata" JSONB,
                "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                "updatedAt" DATETIME NOT NULL
            )
        `);
        await db.$executeRawUnsafe(
            `INSERT INTO "ServiceAccountQuotaSnapshot" (
                "id", "accountId", "vendor", "profileId", "snapshot",
                "status", "fetchedAt", "staleAfterMs", "metadata", "updatedAt"
            ) VALUES (?, ?, 'openai-codex', 'work', ?, 'ok', ?, 300000, ?, ?)`,
            "released-quota-1",
            user.id,
            Buffer.from(ciphertext, "utf8"),
            new Date(1_234),
            JSON.stringify({ v: 1, format: "account_scoped_v1" }),
            new Date(1_234),
        );

        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as never);
        await app.ready();

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
        const refreshed = await app.inject({
            method: "GET",
            url: "/v2/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });
        expect(refreshed.json()).toMatchObject({
            metadata: { refreshRequestedAt: expect.any(Number) },
        });

        const replacement = await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/profiles/work/quotas",
            headers: {
                "content-type": "application/json",
                "x-test-user-id": user.id,
            },
            payload: {
                sealed: { format: "account_scoped_v1", ciphertext },
                metadata: {
                    fetchedAt: 2_222,
                    staleAfterMs: 60_000,
                    status: "estimated",
                },
            },
        });
        expect(replacement.statusCode, replacement.body).toBe(200);
        expect(await db.serviceAccountQuotaSnapshot.count({
            where: {
                accountId: user.id,
                vendor: "openai-codex",
                profileId: "work",
            },
        })).toBe(0);
        expect((await app.inject({
            method: "GET",
            url: "/v2/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        })).json()).toMatchObject({
            metadata: { fetchedAt: 2_222, status: "estimated" },
        });

        const deleted = await app.inject({
            method: "DELETE",
            url: "/v2/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });
        expect(deleted.statusCode, deleted.body).toBe(200);
        expect((await app.inject({
            method: "GET",
            url: "/v2/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        })).statusCode).toBe(404);
    });

    it("returns the released sealed profile quota projection", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "required_e2ee",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "e2ee",
        });
        const user = await createReadyE2eeAccount();
        await createConnectedServiceProfileBinding(
            user.id,
            "acct_quota_v2_projection",
        );

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
        expect(write.statusCode, write.body).toBe(200);

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
    });

    it("refreshes and deletes the released sealed profile quota", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "required_e2ee",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "e2ee",
        });
        const user = await createReadyE2eeAccount();
        await createConnectedServiceProfileBinding(
            user.id,
            "acct_quota_v2_refresh",
        );

        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as never);
        await app.ready();
        expect((await app.inject({
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
                    fetchedAt: 9_999,
                    staleAfterMs: 60_000,
                    status: "ok",
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

        const refreshed = await app.inject({
            method: "GET",
            url: "/v2/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });
        expect(refreshed.statusCode).toBe(200);
        expect(refreshed.json()).toMatchObject({
            metadata: { refreshRequestedAt: expect.any(Number) },
        });

        const deleted = await app.inject({
            method: "DELETE",
            url: "/v2/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });
        expect(deleted.statusCode).toBe(200);
        expect(deleted.json()).toEqual({ success: true });

        const missing = await app.inject({
            method: "GET",
            url: "/v2/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });
        expect(missing.statusCode).toBe(404);
        expect(missing.json()).toEqual({ error: "connect_quotas_not_found" });
    });
});
