import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import {
    acquireQualifiedConnectedServiceRefreshLease,
    deleteQualifiedConnectedServiceCredential,
    isQualifiedConnectedAccountMigrationInventoryCompleteInTx,
    listQualifiedConnectedAccounts,
    mutateQualifiedConnectedAccountConfiguration,
    mutateQualifiedConnectedServiceCredentialHealth,
    mutateQualifiedConnectedServiceCredential,
    prepareQualifiedConnectedServiceCredentialCreate,
    readQualifiedConnectedAccountConfiguration,
    resolveQualifiedConnectedAccountHostReferenceInTx,
    readQualifiedConnectedServiceCredential,
    readQualifiedConnectedServiceCredentialForLegacyProjection,
    settlePreparedQualifiedConnectedServiceCredentialCreate,
} from "./credentialRepository";
import {
    createServiceAccountTokenIdentityFields,
    resolveLegacyServiceAccountTokenIdentityFields,
} from "./identity";
import {
    createProviderAccountUsageRecordKey,
    createUsageSnapshot,
} from "../providerAccountUsageTestkit";
import {
    QualifiedConnectedAccountUsageBasisError,
    writeQualifiedProviderAccountUsageRecord,
} from "./usageRepository";
import {
    createQualifiedConnectedAccountGroup,
    createQualifiedConnectedAccountGroupMember,
    deleteQualifiedConnectedAccountGroup,
    deleteQualifiedConnectedAccountGroupMember,
    setQualifiedConnectedAccountGroupActiveAccount,
    updateQualifiedConnectedAccountGroupMember,
} from "./groupRepository";

const service = Object.freeze({
    pluginId: "example.connected-accounts",
    localId: "service/with/path",
});
const metadata = Object.freeze({
    displayName: "Primary account",
    scopes: ["account.read"],
});

describe("qualified Connected Account credential repository", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-qualified-connected-account-repository-",
            initEncrypt: true,
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    afterEach(async () => {
        await db.serviceAccountToken.deleteMany();
        await db.account.deleteMany();
    });

    it("resolves only the opaque Connected Account record within its owning Account", async () => {
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const credential = await db.serviceAccountToken.create({
            data: {
                accountId: account.id,
                servicePluginId: "example.connected-accounts",
                serviceLocalId: "service",
                qualifiedServiceDigest: "service-digest",
                connectedAccountId: "provider-account",
                qualifiedIdentityDigest: "identity-digest",
                authenticationModeId: "api-key",
                token: Buffer.from("opaque-token", "utf8"),
            },
            select: { id: true },
        });

        await expect(inTx((tx) => resolveQualifiedConnectedAccountHostReferenceInTx(
            tx,
            { accountId: account.id, targetId: credential.id },
        ))).resolves.toEqual({ status: "available" });
        await expect(inTx((tx) => resolveQualifiedConnectedAccountHostReferenceInTx(
            tx,
            { accountId: "another-account", targetId: credential.id },
        ))).resolves.toEqual({ status: "unavailable" });
    });

    it("bounds an encryption-migration inventory read one row beyond the admitted request", async () => {
        await expect(inTx(async (tx) => {
            let requestedTake: number | undefined;
            const serviceAccountToken = new Proxy(
                tx.serviceAccountToken,
                {
                    get(target, property) {
                        if (property !== "findMany") {
                            return Reflect.get(target, property, target);
                        }
                        return async (input: unknown) => {
                            requestedTake = (
                                input as Readonly<{ take?: number }>
                            ).take;
                            // Malformed sentinel rows prove overflow is rejected
                            // before stored identity parsing begins.
                            return [{}, {}, {}] as never;
                        };
                    },
                },
            );
            const complete =
                await isQualifiedConnectedAccountMigrationInventoryCompleteInTx(
                    { serviceAccountToken },
                    {
                        accountId: "migration-account",
                        legacyCredentials: [{
                            serviceId: "openai",
                            profileId: "legacy-profile",
                        }],
                        qualifiedCredentials: [{
                            ref: {
                                service: {
                                    pluginId: "example.connected-accounts",
                                    localId: "novel-service",
                                },
                                accountId: "qualified-profile",
                            },
                        }],
                    },
                );
            return { complete, requestedTake };
        })).resolves.toEqual({
            complete: false,
            requestedTake: 3,
        });
    });

    it("admits exactly one null-CAS first connect and writes required configuration atomically", async () => {
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const ref = { service, accountId: "provider/account/one" };
        const mutation = {
            accountId: account.id,
            ref,
            expectedCredentialRevision: null,
            authenticationModeId: "api-key",
            content: { t: "plain" as const, v: { token: "credential" } },
            metadata,
            initialConfiguration: {
                expectedConfigurationRevision: null as null,
                replacementContentEnvelope: {
                    t: "plain" as const,
                    v: { endpoint: "https://example.invalid" },
                },
            },
        };

        const [left, right] = await Promise.all([
            mutateQualifiedConnectedServiceCredential(mutation),
            mutateQualifiedConnectedServiceCredential(mutation),
        ]);

        expect([left.status, right.status].sort()).toEqual(["superseded", "written"]);
        expect(await db.serviceAccountToken.count({ where: { accountId: account.id } })).toBe(1);
        await expect(readQualifiedConnectedAccountConfiguration({
            accountId: account.id,
            target: { kind: "account", ref },
        })).resolves.toMatchObject({
            target: { kind: "account", ref },
            authenticationModeId: "api-key",
            configurationContent: {
                t: "plain",
                v: { endpoint: "https://example.invalid" },
            },
        });
    });

    it("projects unsupported legacy OAuth as needs-reconnect and rejects it for new qualified writes", async () => {
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const legacy = resolveLegacyServiceAccountTokenIdentityFields({
            serviceId: "gemini",
            profileId: "old-oauth",
            credentialKind: "oauth",
        });
        const ref = {
            service: {
                pluginId: legacy.servicePluginId,
                localId: legacy.serviceLocalId,
            },
            accountId: legacy.connectedAccountId,
        };
        await expect(mutateQualifiedConnectedServiceCredential({
            accountId: account.id,
            ref,
            expectedCredentialRevision: null,
            authenticationModeId: legacy.authenticationModeId,
            content: { t: "plain", v: { oauth: "historical" } },
            metadata,
            legacyIdentity: {
                serviceId: "gemini",
                profileId: "old-oauth",
            },
            initialConfiguration: {
                expectedConfigurationRevision: null,
                replacementContentEnvelope: {
                    t: "plain",
                    v: { project: "historical" },
                },
            },
        })).resolves.toMatchObject({ status: "written" });

        await expect(listQualifiedConnectedAccounts({
            accountId: account.id,
            service: ref.service,
        })).resolves.toEqual([
            expect.objectContaining({
                ref,
                authenticationModeId: null,
                status: "needs_reauth",
            }),
        ]);
        await expect(readQualifiedConnectedServiceCredential({
            accountId: account.id,
            ref,
        })).resolves.toMatchObject({
            status: "resolved",
            credential: {
                authenticationModeId: null,
                content: { t: "plain", v: { oauth: "historical" } },
            },
        });
        await expect(readQualifiedConnectedAccountConfiguration({
            accountId: account.id,
            target: { kind: "account", ref },
        })).resolves.toMatchObject({
            authenticationModeId: null,
            configurationContent: {
                t: "plain",
                v: { project: "historical" },
            },
        });
        await expect(db.serviceAccountToken.findFirstOrThrow({
            where: { accountId: account.id },
            select: { authenticationModeId: true },
        })).resolves.toEqual({
            authenticationModeId: "legacy-oauth-unsupported",
        });

        await expect(mutateQualifiedConnectedServiceCredential({
            accountId: account.id,
            ref: { ...ref, accountId: "new-write" },
            expectedCredentialRevision: null,
            authenticationModeId: "legacy-oauth-unsupported",
            content: { t: "plain", v: { oauth: "must-not-write" } },
            metadata,
        })).resolves.toEqual({
            status: "authentication_mode_mismatch",
        });
        await expect(db.serviceAccountToken.count({
            where: { accountId: account.id },
        })).resolves.toBe(1);
    });

    it("reuses one exact prepared create as successful outcome-unknown settlement", async () => {
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const ref = { service, accountId: "prepared/account" };
        const preparation =
            await prepareQualifiedConnectedServiceCredentialCreate({
                accountId: account.id,
                ref,
                expectedCredentialRevision: null,
                authenticationModeId: "api-key",
                content: { t: "plain", v: { token: "credential" } },
                metadata,
                initialConfiguration: {
                    expectedConfigurationRevision: null,
                    replacementContentEnvelope: {
                        t: "plain",
                        v: { region: "eu" },
                    },
                },
            });
        if (preparation.status !== "prepared") {
            throw new Error("Expected prepared credential create");
        }

        const first =
            await settlePreparedQualifiedConnectedServiceCredentialCreate(
                preparation.prepared,
            );
        const replay =
            await settlePreparedQualifiedConnectedServiceCredentialCreate(
                preparation.prepared,
            );

        expect(first).toEqual(replay);
        expect(replay).toMatchObject({
            status: "written",
            credentialRevision:
                preparation.prepared.write.credentialRevision,
            configurationRevision:
                preparation.prepared.write.configurationRevision,
        });
        expect(await db.serviceAccountToken.count({
            where: { accountId: account.id },
        })).toBe(1);
    });

    it("fails closed when a row carries a non-canonical legacy-prefixed digest", async () => {
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const legacy = resolveLegacyServiceAccountTokenIdentityFields({
            serviceId: "openai-codex",
            profileId: "work",
        });
        const ref = {
            service: {
                pluginId: legacy.servicePluginId,
                localId: legacy.serviceLocalId,
            },
            accountId: legacy.connectedAccountId,
        };
        const created = await mutateQualifiedConnectedServiceCredential({
            accountId: account.id,
            ref,
            expectedCredentialRevision: null,
            authenticationModeId: legacy.authenticationModeId,
            content: { t: "plain", v: { token: "credential" } },
            metadata,
            legacyIdentity: {
                serviceId: "openai-codex",
                profileId: "work",
            },
        });
        expect(created.status).toBe("written");
        const row = await db.serviceAccountToken.findFirstOrThrow({
            where: { accountId: account.id },
            select: { id: true },
        });
        await db.serviceAccountToken.update({
            where: { id: row.id },
            data: { qualifiedIdentityDigest: `legacy:${row.id}` },
        });

        await expect(readQualifiedConnectedServiceCredential({
            accountId: account.id,
            ref,
        })).rejects.toThrow(/digest mismatch/i);
        await expect(db.serviceAccountToken.findUniqueOrThrow({
            where: { id: row.id },
            select: {
                vendor: true,
                profileId: true,
                qualifiedIdentityDigest: true,
            },
        })).resolves.toEqual({
            vendor: "openai-codex",
            profileId: "work",
            qualifiedIdentityDigest: `legacy:${row.id}`,
        });
    });

    it("checks the configuration fence during reconnect without replacing sidecar bytes", async () => {
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const ref = { service, accountId: "work" };
        const created = await mutateQualifiedConnectedServiceCredential({
            accountId: account.id,
            ref,
            expectedCredentialRevision: null,
            authenticationModeId: "api-key",
            content: { t: "plain", v: { token: "first" } },
            metadata,
            initialConfiguration: {
                expectedConfigurationRevision: null,
                replacementContentEnvelope: { t: "plain", v: { region: "eu" } },
            },
        });
        expect(created.status).toBe("written");
        if (created.status !== "written" || created.configurationRevision === null) {
            throw new Error("Expected an atomic configuration create");
        }
        const before = await db.serviceAccountToken.findFirstOrThrow({
            where: { accountId: account.id },
            select: { configurationContent: true, token: true },
        });

        const staleReconnect = await mutateQualifiedConnectedServiceCredential({
            accountId: account.id,
            ref,
            expectedCredentialRevision: created.credentialRevision,
            expectedConfigurationRevision: "cscr_stale",
            authenticationModeId: "api-key",
            content: { t: "plain", v: { token: "must-not-write" } },
            metadata,
        });
        expect(staleReconnect).toMatchObject({
            status: "superseded",
            reason: "configuration_revision_mismatch",
        });
        const afterStale = await db.serviceAccountToken.findFirstOrThrow({
            where: { accountId: account.id },
            select: { token: true },
        });
        expect(Buffer.from(afterStale.token).equals(Buffer.from(before.token)))
            .toBe(true);

        const reconnected = await mutateQualifiedConnectedServiceCredential({
            accountId: account.id,
            ref,
            expectedCredentialRevision: created.credentialRevision,
            expectedConfigurationRevision: created.configurationRevision,
            authenticationModeId: "api-key",
            content: { t: "plain", v: { token: "second" } },
            metadata,
        });

        expect(reconnected).toMatchObject({
            status: "written",
            configurationRevision: created.configurationRevision,
        });
        const after = await db.serviceAccountToken.findFirstOrThrow({
            where: { accountId: account.id },
            select: { configurationContent: true },
        });
        expect(Buffer.from(after.configurationContent ?? []).equals(
            Buffer.from(before.configurationContent ?? []),
        )).toBe(true);
    });

    it("requires exact credential and configuration revisions for replacement", async () => {
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const ref = { service, accountId: "strict-cas" };
        const created = await mutateQualifiedConnectedServiceCredential({
            accountId: account.id,
            ref,
            expectedCredentialRevision: null,
            authenticationModeId: "api-key",
            content: { t: "plain", v: { token: "first" } },
            metadata,
        });
        expect(created.status).toBe("written");
        if (created.status !== "written") throw new Error("Expected credential create");

        await expect(mutateQualifiedConnectedAccountConfiguration({
            accountId: account.id,
            target: { kind: "account", ref },
            expectedCredentialRevision: "csr_wrong",
            expectedConfigurationRevision: null,
            replacementContentEnvelope: { t: "plain", v: { region: "us" } },
        })).resolves.toMatchObject({
            status: "superseded",
            reason: "credential_revision_mismatch",
        });

        const configured = await mutateQualifiedConnectedAccountConfiguration({
            accountId: account.id,
            target: { kind: "account", ref },
            expectedCredentialRevision: created.credentialRevision,
            expectedConfigurationRevision: null,
            replacementContentEnvelope: { t: "plain", v: { region: "us" } },
        });
        expect(configured.status).toBe("written");

        await expect(mutateQualifiedConnectedAccountConfiguration({
            accountId: account.id,
            target: { kind: "account", ref },
            expectedCredentialRevision: created.credentialRevision,
            expectedConfigurationRevision: null,
            replacementContentEnvelope: { t: "plain", v: { region: "apac" } },
        })).resolves.toMatchObject({
            status: "superseded",
            reason: "configuration_revision_mismatch",
        });
    });

    it("rejects envelopes that disagree with the account storage mode before writing", async () => {
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });

        await expect(mutateQualifiedConnectedServiceCredential({
            accountId: account.id,
            ref: { service, accountId: "wrong-mode" },
            expectedCredentialRevision: null,
            authenticationModeId: "api-key",
            content: { t: "encrypted", c: "ciphertext" },
            metadata,
        })).resolves.toEqual({ status: "storage_mode_mismatch" });

        expect(await db.serviceAccountToken.count({ where: { accountId: account.id } })).toBe(0);
    });

    it("derives the stored credential mode before an unqualified V4 delete and preserves a mismatched row", async () => {
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const ref = { service, accountId: "delete-derived-mode" };
        const created = await mutateQualifiedConnectedServiceCredential({
            accountId: account.id,
            ref,
            expectedCredentialRevision: null,
            authenticationModeId: "api-key",
            content: { t: "plain", v: { token: "preserve-me" } },
            metadata,
        });
        if (created.status !== "written") {
            throw new Error("Expected credential create");
        }
        const row = await db.serviceAccountToken.findFirstOrThrow({
            where: { accountId: account.id },
            select: { id: true },
        });
        await db.account.update({
            where: { id: account.id },
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
            },
        });

        await expect(deleteQualifiedConnectedServiceCredential({
            accountId: account.id,
            ref,
            expectedCredentialRevision: created.credentialRevision,
            cleanupGroupReferences: true,
        })).resolves.toEqual({ status: "storage_mode_mismatch" });
        await expect(db.serviceAccountToken.findUnique({
            where: { id: row.id },
            select: { id: true },
        })).resolves.toEqual({ id: row.id });
    });

    it("rejects a reconnect that changes the stable provider identity", async () => {
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const ref = { service, accountId: "stable-account" };
        const created = await mutateQualifiedConnectedServiceCredential({
            accountId: account.id,
            ref,
            expectedCredentialRevision: null,
            authenticationModeId: "api-key",
            content: { t: "plain", v: { token: "first" } },
            metadata: {
                ...metadata,
                providerIdentity: { accountId: "provider-account-1" },
            },
        });
        if (created.status !== "written") throw new Error("Expected credential create");

        await expect(mutateQualifiedConnectedServiceCredential({
            accountId: account.id,
            ref,
            expectedCredentialRevision: created.credentialRevision,
            expectedConfigurationRevision: null,
            authenticationModeId: "api-key",
            content: { t: "plain", v: { token: "second" } },
            metadata: {
                ...metadata,
                providerIdentity: { accountId: "provider-account-2" },
            },
        })).resolves.toEqual({ status: "provider_identity_mismatch" });
    });

    it("fails closed for incomplete sidecars and account-mode drift on reads", async () => {
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const ref = { service, accountId: "read-integrity" };
        const created = await mutateQualifiedConnectedServiceCredential({
            accountId: account.id,
            ref,
            expectedCredentialRevision: null,
            authenticationModeId: "api-key",
            content: { t: "plain", v: { token: "first" } },
            metadata,
            initialConfiguration: {
                expectedConfigurationRevision: null,
                replacementContentEnvelope: {
                    t: "plain",
                    v: { region: "eu" },
                },
            },
        });
        if (created.status !== "written") throw new Error("Expected credential create");
        const row = await db.serviceAccountToken.findFirstOrThrow({
            where: { accountId: account.id },
            select: {
                id: true,
                configurationRevision: true,
                configurationContent: true,
            },
        });

        await db.$executeRawUnsafe("PRAGMA ignore_check_constraints = ON");
        try {
            await db.serviceAccountToken.update({
                where: { id: row.id },
                data: { configurationContent: null },
            });
        } finally {
            await db.$executeRawUnsafe("PRAGMA ignore_check_constraints = OFF");
        }
        await expect(readQualifiedConnectedAccountConfiguration({
            accountId: account.id,
            target: { kind: "account", ref },
        })).rejects.toThrow(/sidecar is incomplete/i);

        await db.$executeRawUnsafe("PRAGMA ignore_check_constraints = ON");
        try {
            await db.serviceAccountToken.update({
                where: { id: row.id },
                data: {
                    configurationRevision: null,
                    configurationContent: row.configurationContent,
                },
            });
        } finally {
            await db.$executeRawUnsafe("PRAGMA ignore_check_constraints = OFF");
        }
        await expect(readQualifiedConnectedAccountConfiguration({
            accountId: account.id,
            target: { kind: "account", ref },
        })).rejects.toThrow(/sidecar is incomplete/i);

        await db.serviceAccountToken.update({
            where: { id: row.id },
            data: {
                configurationRevision: row.configurationRevision,
                configurationContent: row.configurationContent,
            },
        });
        await db.account.update({
            where: { id: account.id },
            data: {
                publicKey: "e2ee-public-key",
                encryptionMode: "e2ee",
            },
        });
        await expect(readQualifiedConnectedAccountConfiguration({
            accountId: account.id,
            target: { kind: "account", ref },
        })).resolves.toEqual({
            status: "storage_mode_mismatch",
        });
        await expect(readQualifiedConnectedServiceCredential({
            accountId: account.id,
            ref,
        })).resolves.toEqual({
            status: "storage_mode_mismatch",
        });
        await expect(
            readQualifiedConnectedServiceCredentialForLegacyProjection({
                accountId: account.id,
                ref,
            }),
        ).resolves.toEqual({ status: "storage_mode_mismatch" });

        await expect(deleteQualifiedConnectedServiceCredential({
            accountId: account.id,
            ref,
            expectedCredentialRevision: created.credentialRevision,
            cleanupGroupReferences: true,
        })).resolves.toEqual({ status: "storage_mode_mismatch" });
        await expect(db.serviceAccountToken.findUnique({
            where: { id: row.id },
            select: { id: true },
        })).resolves.toEqual({ id: row.id });
    });

    it("round-trips an E2EE opaque envelope without persisting secret-like clear metadata", async () => {
        const account = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
            },
            select: { id: true },
        });
        const ref = { service, accountId: "e2ee-account" };
        const created = await mutateQualifiedConnectedServiceCredential({
            accountId: account.id,
            ref,
            expectedCredentialRevision: null,
            authenticationModeId: "api-key",
            content: { t: "encrypted", c: "opaque-e2ee-credential" },
            metadata: {
                ...metadata,
                providerIdentity: { email: "operator@example.com" },
            },
        });
        expect(created.status).toBe("written");
        await expect(readQualifiedConnectedServiceCredential({
            accountId: account.id,
            ref,
        })).resolves.toMatchObject({
            status: "resolved",
            credential: {
                content: { t: "encrypted", c: "opaque-e2ee-credential" },
                metadata: {
                    providerIdentity: { email: "operator@example.com" },
                },
            },
        });
        const stored = await db.serviceAccountToken.findFirstOrThrow({
            where: { accountId: account.id },
            select: { metadata: true },
        });
        expect(JSON.stringify(stored.metadata)).not.toMatch(
            /accessToken|refreshToken|password|apiKey/i,
        );
    });

    it("projects V4 health without rotating credential or configuration revisions", async () => {
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const ref = { service, accountId: "health/account" };
        const created = await mutateQualifiedConnectedServiceCredential({
            accountId: account.id,
            ref,
            expectedCredentialRevision: null,
            authenticationModeId: "api-key",
            content: { t: "plain", v: { token: "credential" } },
            metadata,
            initialConfiguration: {
                expectedConfigurationRevision: null,
                replacementContentEnvelope: {
                    t: "plain",
                    v: { region: "eu" },
                },
            },
        });
        if (
            created.status !== "written"
            || created.configurationRevision === null
        ) {
            throw new Error("Expected configured credential create");
        }

        await expect(mutateQualifiedConnectedServiceCredentialHealth({
            accountId: account.id,
            ref,
            expectedCredentialRevision: created.credentialRevision,
            expectedConfigurationRevision: created.configurationRevision,
            health: {
                v: 1,
                status: "needs_reauth",
                reconnectRequired: true,
                providerErrorCode: "invalid_grant",
            },
        })).resolves.toEqual({
            status: "written",
            credentialRevision: created.credentialRevision,
            configurationRevision: created.configurationRevision,
        });
        await expect(listQualifiedConnectedAccounts({
            accountId: account.id,
            service,
        })).resolves.toEqual([
            expect.objectContaining({
                ref,
                status: "needs_reauth",
                credentialRevision: created.credentialRevision,
                configurationRevision: created.configurationRevision,
            }),
        ]);
    });

    it("rejects health mutation before changing credential metadata or publishing a profile change when Account currentness is inconsistent", async () => {
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const ref = { service, accountId: "health/currentness" };
        const created = await mutateQualifiedConnectedServiceCredential({
            accountId: account.id,
            ref,
            expectedCredentialRevision: null,
            authenticationModeId: "api-key",
            content: { t: "plain", v: { token: "credential" } },
            metadata,
        });
        if (created.status !== "written") {
            throw new Error("Expected credential create");
        }
        const beforeRow = await db.serviceAccountToken.findFirstOrThrow({
            where: { accountId: account.id },
            select: { id: true, metadata: true, updatedAt: true },
        });
        const beforeAccount = await db.account.findUniqueOrThrow({
            where: { id: account.id },
            select: { seq: true },
        });
        const beforeChange = await db.accountChange.findUniqueOrThrow({
            where: {
                accountId_kind_entityId: {
                    accountId: account.id,
                    kind: "account",
                    entityId: "self",
                },
            },
            select: { cursor: true, hint: true },
        });
        await db.account.update({
            where: { id: account.id },
            data: {
                publicKey: "incomplete-e2ee-public-key",
                encryptionMode: "e2ee",
            },
        });

        await expect(mutateQualifiedConnectedServiceCredentialHealth({
            accountId: account.id,
            ref,
            expectedCredentialRevision: created.credentialRevision,
            expectedConfigurationRevision: null,
            health: {
                v: 1,
                status: "needs_reauth",
                reconnectRequired: true,
                providerErrorCode: "invalid_grant",
            },
        })).resolves.toEqual({ status: "storage_mode_mismatch" });
        await expect(db.serviceAccountToken.findUniqueOrThrow({
            where: { id: beforeRow.id },
            select: { id: true, metadata: true, updatedAt: true },
        })).resolves.toEqual(beforeRow);
        await expect(db.account.findUniqueOrThrow({
            where: { id: account.id },
            select: { seq: true },
        })).resolves.toEqual(beforeAccount);
        await expect(db.accountChange.findUniqueOrThrow({
            where: {
                accountId_kind_entityId: {
                    accountId: account.id,
                    kind: "account",
                    entityId: "self",
                },
            },
            select: { cursor: true, hint: true },
        })).resolves.toEqual(beforeChange);
    });

    it("rejects health mutation before changing credential metadata or publishing a profile change when configuration mode is inconsistent", async () => {
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const ref = { service, accountId: "health/configuration-mode" };
        const created = await mutateQualifiedConnectedServiceCredential({
            accountId: account.id,
            ref,
            expectedCredentialRevision: null,
            authenticationModeId: "api-key",
            content: { t: "plain", v: { token: "credential" } },
            metadata,
            initialConfiguration: {
                expectedConfigurationRevision: null,
                replacementContentEnvelope: {
                    t: "plain",
                    v: { region: "eu" },
                },
            },
        });
        if (
            created.status !== "written"
            || created.configurationRevision === null
        ) {
            throw new Error("Expected configured credential create");
        }

        const e2eeAccount = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
            },
            select: { id: true },
        });
        const e2eeCreated =
            await mutateQualifiedConnectedServiceCredential({
                accountId: e2eeAccount.id,
                ref,
                expectedCredentialRevision: null,
                authenticationModeId: "api-key",
                content: {
                    t: "encrypted",
                    c: "opaque-e2ee-credential",
                },
                metadata,
                initialConfiguration: {
                    expectedConfigurationRevision: null,
                    replacementContentEnvelope: {
                        t: "encrypted",
                        c: "opaque-e2ee-configuration",
                    },
                },
            });
        if (
            e2eeCreated.status !== "written"
            || e2eeCreated.configurationRevision === null
        ) {
            throw new Error("Expected E2EE configured credential create");
        }
        const e2eeConfiguration =
            await db.serviceAccountToken.findFirstOrThrow({
                where: { accountId: e2eeAccount.id },
                select: { configurationContent: true },
            });
        if (e2eeConfiguration.configurationContent === null) {
            throw new Error("Expected E2EE configuration bytes");
        }
        const targetRow = await db.serviceAccountToken.findFirstOrThrow({
            where: { accountId: account.id },
            select: { id: true },
        });
        await db.serviceAccountToken.update({
            where: { id: targetRow.id },
            data: {
                configurationContent:
                    e2eeConfiguration.configurationContent,
            },
        });
        const beforeRow = await db.serviceAccountToken.findUniqueOrThrow({
            where: { id: targetRow.id },
            select: {
                id: true,
                metadata: true,
                configurationContent: true,
                updatedAt: true,
            },
        });
        const beforeAccount = await db.account.findUniqueOrThrow({
            where: { id: account.id },
            select: { seq: true },
        });
        const beforeChange = await db.accountChange.findUniqueOrThrow({
            where: {
                accountId_kind_entityId: {
                    accountId: account.id,
                    kind: "account",
                    entityId: "self",
                },
            },
            select: { cursor: true, hint: true },
        });

        await expect(mutateQualifiedConnectedServiceCredentialHealth({
            accountId: account.id,
            ref,
            expectedCredentialRevision: created.credentialRevision,
            expectedConfigurationRevision:
                created.configurationRevision,
            health: {
                v: 1,
                status: "needs_reauth",
                reconnectRequired: true,
                providerErrorCode: "invalid_grant",
            },
        })).resolves.toEqual({ status: "storage_mode_mismatch" });
        await expect(db.serviceAccountToken.findUniqueOrThrow({
            where: { id: targetRow.id },
            select: {
                id: true,
                metadata: true,
                configurationContent: true,
                updatedAt: true,
            },
        })).resolves.toEqual(beforeRow);
        await expect(db.account.findUniqueOrThrow({
            where: { id: account.id },
            select: { seq: true },
        })).resolves.toEqual(beforeAccount);
        await expect(db.accountChange.findUniqueOrThrow({
            where: {
                accountId_kind_entityId: {
                    accountId: account.id,
                    kind: "account",
                    entityId: "self",
                },
            },
            select: { cursor: true, hint: true },
        })).resolves.toEqual(beforeChange);
    });

    it("fails closed when Account currentness changes after a legacy-compatible health pre-read", async () => {
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const legacy = resolveLegacyServiceAccountTokenIdentityFields({
            serviceId: "openai-codex",
            profileId: "work",
        });
        const ref = {
            service: {
                pluginId: legacy.servicePluginId,
                localId: legacy.serviceLocalId,
            },
            accountId: legacy.connectedAccountId,
        };
        const created = await mutateQualifiedConnectedServiceCredential({
            accountId: account.id,
            ref,
            expectedCredentialRevision: null,
            authenticationModeId: legacy.authenticationModeId,
            content: { t: "plain", v: { token: "credential" } },
            metadata,
            legacyIdentity: {
                serviceId: "openai-codex",
                profileId: "work",
            },
        });
        if (created.status !== "written") {
            throw new Error("Expected credential create");
        }
        const admitted = await readQualifiedConnectedServiceCredential({
            accountId: account.id,
            ref,
        });
        if (
            admitted.status !== "resolved"
            || admitted.credential.credentialRevision === null
        ) {
            throw new Error("Expected legacy-compatible credential read with a current credential revision");
        }
        const beforeRow = await db.serviceAccountToken.findFirstOrThrow({
            where: { accountId: account.id },
            select: { id: true, metadata: true, updatedAt: true },
        });
        await db.account.update({
            where: { id: account.id },
            data: {
                publicKey: "incomplete-e2ee-public-key",
                encryptionMode: "e2ee",
            },
        });

        await expect(mutateQualifiedConnectedServiceCredentialHealth({
            accountId: account.id,
            ref,
            expectedCredentialRevision:
                admitted.credential.credentialRevision,
            expectedConfigurationRevision:
                admitted.credential.configurationRevision,
            health: {
                v: 1,
                status: "needs_reauth",
                reconnectRequired: true,
                providerErrorCode: "invalid_grant",
            },
        })).resolves.toEqual({ status: "storage_mode_mismatch" });
        await expect(db.serviceAccountToken.findUniqueOrThrow({
            where: { id: beforeRow.id },
            select: { id: true, metadata: true, updatedAt: true },
        })).resolves.toEqual(beforeRow);
    });

    it("rejects health settlement after the admitted configuration revision changes", async () => {
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const ref = { service, accountId: "health/configuration-cas" };
        const created = await mutateQualifiedConnectedServiceCredential({
            accountId: account.id,
            ref,
            expectedCredentialRevision: null,
            authenticationModeId: "api-key",
            content: { t: "plain", v: { token: "credential" } },
            metadata,
            initialConfiguration: {
                expectedConfigurationRevision: null,
                replacementContentEnvelope: {
                    t: "plain",
                    v: { region: "eu" },
                },
            },
        });
        if (
            created.status !== "written"
            || created.configurationRevision === null
        ) {
            throw new Error("Expected configured credential create");
        }
        const replaced = await mutateQualifiedConnectedAccountConfiguration({
            accountId: account.id,
            target: { kind: "account", ref },
            expectedCredentialRevision: created.credentialRevision,
            expectedConfigurationRevision: created.configurationRevision,
            replacementContentEnvelope: {
                t: "plain",
                v: { region: "us" },
            },
        });
        if (replaced.status !== "written") {
            throw new Error("Expected configuration replacement");
        }

        await expect(mutateQualifiedConnectedServiceCredentialHealth({
            accountId: account.id,
            ref,
            expectedCredentialRevision: created.credentialRevision,
            expectedConfigurationRevision: created.configurationRevision,
            health: {
                v: 1,
                status: "needs_reauth",
                reconnectRequired: true,
                providerErrorCode: "invalid_grant",
            },
        })).resolves.toEqual({
            status: "superseded",
            reason: "configuration_revision_mismatch",
            credentialRevision: created.credentialRevision,
            configurationRevision: replaced.configurationRevision,
        });
        await expect(listQualifiedConnectedAccounts({
            accountId: account.id,
            service,
        })).resolves.toEqual([
            expect.objectContaining({
                ref,
                status: "connected",
                configurationRevision: replaced.configurationRevision,
            }),
        ]);
    });

    it("acquires and renews a refresh lease only for the exact credential revision", async () => {
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const ref = { service, accountId: "refresh/lease" };
        const created = await mutateQualifiedConnectedServiceCredential({
            accountId: account.id,
            ref,
            expectedCredentialRevision: null,
            authenticationModeId: "api-key",
            content: { t: "plain", v: { token: "credential" } },
            metadata,
        });
        if (created.status !== "written") {
            throw new Error("Expected credential create");
        }
        const now = new Date("2026-07-25T00:00:00.000Z");

        await expect(acquireQualifiedConnectedServiceRefreshLease({
            accountId: account.id,
            ref,
            expectedCredentialRevision: "csr_abcdefghijklmnopqrstuvwxyz",
            ownerId: "machine:daemon",
            ttlMs: 30_000,
            now,
        })).resolves.toEqual({
            status: "resolved",
            acquired: false,
            leaseUntil: now.getTime(),
            ownerId: "machine:daemon",
            credentialRevision: created.credentialRevision,
        });
        await expect(acquireQualifiedConnectedServiceRefreshLease({
            accountId: account.id,
            ref,
            expectedCredentialRevision: created.credentialRevision,
            ownerId: "machine:daemon",
            ttlMs: 30_000,
            now,
        })).resolves.toEqual({
            status: "resolved",
            acquired: true,
            leaseUntil: now.getTime() + 30_000,
            ownerId: "machine:daemon",
            credentialRevision: created.credentialRevision,
        });
    });

    it("keeps the legacy active-profile shadow null when credential cleanup promotes a novel-service fallback", async () => {
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const activeRef = { service, accountId: "novel/active" };
        const fallbackRef = { service, accountId: "novel/fallback" };
        const active = await mutateQualifiedConnectedServiceCredential({
            accountId: account.id,
            ref: activeRef,
            expectedCredentialRevision: null,
            authenticationModeId: "api-key",
            content: { t: "plain", v: { token: "active" } },
            metadata,
        });
        const fallback = await mutateQualifiedConnectedServiceCredential({
            accountId: account.id,
            ref: fallbackRef,
            expectedCredentialRevision: null,
            authenticationModeId: "api-key",
            content: { t: "plain", v: { token: "fallback" } },
            metadata,
        });
        if (active.status !== "written" || fallback.status !== "written") {
            throw new Error("Expected both qualified credentials");
        }
        const groupRef = { service, groupId: "novel-group" };
        expect(await createQualifiedConnectedAccountGroup({
            accountId: account.id,
            service,
            group: { groupId: groupRef.groupId },
        })).toMatchObject({ status: "written" });
        expect(await createQualifiedConnectedAccountGroupMember({
            accountId: account.id,
            mutation: {
                group: groupRef,
                connectedAccountId: activeRef.accountId,
                priority: 1,
                enabled: true,
            },
        })).toMatchObject({
            status: "written",
            group: { runtimeStateRevision: 0 },
        });
        expect(await createQualifiedConnectedAccountGroupMember({
            accountId: account.id,
            mutation: {
                group: groupRef,
                connectedAccountId: fallbackRef.accountId,
                priority: 2,
                enabled: true,
            },
        })).toMatchObject({
            status: "written",
            group: { runtimeStateRevision: 0 },
        });
        expect(await setQualifiedConnectedAccountGroupActiveAccount({
            accountId: account.id,
            mutation: {
                group: groupRef,
                connectedAccountId: activeRef.accountId,
                expectedGeneration: 2,
            },
        })).toMatchObject({ status: "written" });

        await expect(deleteQualifiedConnectedServiceCredential({
            accountId: account.id,
            ref: activeRef,
            expectedCredentialRevision: active.credentialRevision,
            cleanupGroupReferences: true,
        })).resolves.toEqual({ status: "deleted" });
        await expect(db.connectedServiceAuthGroup.findFirstOrThrow({
            where: { accountId: account.id },
            select: {
                vendor: true,
                activeProfileId: true,
                activeConnectedAccountId: true,
            },
        })).resolves.toEqual({
            vendor: null,
            activeProfileId: null,
            activeConnectedAccountId: fallbackRef.accountId,
        });
    });

    it("rolls back credential cleanup when an affected group CAS loses", async () => {
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const activeRef = { service, accountId: "delete-cas/active" };
        const fallbackRef = {
            service,
            accountId: "delete-cas/fallback",
        };
        const active = await mutateQualifiedConnectedServiceCredential({
            accountId: account.id,
            ref: activeRef,
            expectedCredentialRevision: null,
            authenticationModeId: "api-key",
            content: { t: "plain", v: { token: "active" } },
            metadata,
        });
        const fallback = await mutateQualifiedConnectedServiceCredential({
            accountId: account.id,
            ref: fallbackRef,
            expectedCredentialRevision: null,
            authenticationModeId: "api-key",
            content: { t: "plain", v: { token: "fallback" } },
            metadata,
        });
        if (active.status !== "written" || fallback.status !== "written") {
            throw new Error("Expected both qualified credentials");
        }
        const groupRef = { service, groupId: "delete-cas" };
        expect(await createQualifiedConnectedAccountGroup({
            accountId: account.id,
            service,
            group: { groupId: groupRef.groupId },
        })).toMatchObject({ status: "written" });
        expect(await createQualifiedConnectedAccountGroupMember({
            accountId: account.id,
            mutation: {
                group: groupRef,
                connectedAccountId: activeRef.accountId,
                priority: 1,
            },
        })).toMatchObject({ status: "written" });
        expect(await createQualifiedConnectedAccountGroupMember({
            accountId: account.id,
            mutation: {
                group: groupRef,
                connectedAccountId: fallbackRef.accountId,
                priority: 2,
            },
        })).toMatchObject({ status: "written" });
        expect(await setQualifiedConnectedAccountGroupActiveAccount({
            accountId: account.id,
            mutation: {
                group: groupRef,
                connectedAccountId: activeRef.accountId,
                expectedGeneration: 2,
            },
        })).toMatchObject({ status: "written" });
        const credential =
            await db.serviceAccountToken.findFirstOrThrow({
                where: {
                    accountId: account.id,
                    connectedAccountId: activeRef.accountId,
                },
                select: { id: true },
            });
        const group = await db.connectedServiceAuthGroup.findFirstOrThrow({
            where: {
                accountId: account.id,
                groupId: groupRef.groupId,
            },
            select: { id: true },
        });
        const before = await Promise.all([
            db.serviceAccountToken.findUniqueOrThrow({
                where: { id: credential.id },
                select: { id: true, updatedAt: true },
            }),
            db.connectedServiceAuthGroup.findUniqueOrThrow({
                where: { id: group.id },
                select: {
                    generation: true,
                    runtimeStateRevision: true,
                    activeConnectedAccountId: true,
                },
            }),
            db.connectedServiceAuthGroupMember.findMany({
                where: { groupDbId: group.id },
                orderBy: { id: "asc" },
                select: {
                    id: true,
                    credentialId: true,
                    enabled: true,
                    priority: true,
                },
            }),
        ]);
        const triggerName = "qualified_credential_delete_group_cas_test";
        await db.$executeRawUnsafe(
            `DROP TRIGGER IF EXISTS "${triggerName}"`,
        );
        await db.$executeRawUnsafe(`
            CREATE TRIGGER "${triggerName}"
            AFTER DELETE ON "ServiceAccountToken"
            WHEN OLD."id" = '${credential.id}'
            BEGIN
                UPDATE "ConnectedServiceAuthGroup"
                SET "runtimeStateRevision" =
                    "runtimeStateRevision" + 1
                WHERE "id" = '${group.id}';
            END
        `);
        try {
            await expect(deleteQualifiedConnectedServiceCredential({
                accountId: account.id,
                ref: activeRef,
                expectedCredentialRevision:
                    active.credentialRevision,
                cleanupGroupReferences: true,
            })).resolves.toEqual({
                status: "superseded",
                credentialRevision:
                    active.credentialRevision,
                configurationRevision: null,
            });
        } finally {
            await db.$executeRawUnsafe(
                `DROP TRIGGER IF EXISTS "${triggerName}"`,
            );
        }
        await expect(Promise.all([
            db.serviceAccountToken.findUniqueOrThrow({
                where: { id: credential.id },
                select: { id: true, updatedAt: true },
            }),
            db.connectedServiceAuthGroup.findUniqueOrThrow({
                where: { id: group.id },
                select: {
                    generation: true,
                    runtimeStateRevision: true,
                    activeConnectedAccountId: true,
                },
            }),
            db.connectedServiceAuthGroupMember.findMany({
                where: { groupDbId: group.id },
                orderBy: { id: "asc" },
                select: {
                    id: true,
                    credentialId: true,
                    enabled: true,
                    priority: true,
                },
            }),
        ])).resolves.toEqual(before);
    });

    it("deletes the admitted credential when row bookkeeping changes without rotating its revision", async () => {
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const ref = { service, accountId: "delete-bookkeeping-race" };
        const created = await mutateQualifiedConnectedServiceCredential({
            accountId: account.id,
            ref,
            expectedCredentialRevision: null,
            authenticationModeId: "api-key",
            content: { t: "plain", v: { token: "credential" } },
            metadata,
        });
        if (created.status !== "written") {
            throw new Error("Expected qualified credential");
        }
        const credential =
            await db.serviceAccountToken.findFirstOrThrow({
                where: {
                    accountId: account.id,
                    connectedAccountId: ref.accountId,
                },
                select: { id: true },
            });
        const triggerName =
            "qualified_credential_delete_bookkeeping_cas_test";
        const markerTable =
            "QualifiedCredentialDeleteBookkeepingCasTest";
        await db.$executeRawUnsafe(
            `DROP TRIGGER IF EXISTS "${triggerName}"`,
        );
        await db.$executeRawUnsafe(
            `DROP TABLE IF EXISTS "${markerTable}"`,
        );
        await db.$executeRawUnsafe(`
            CREATE TABLE "${markerTable}" (
                "credentialId" TEXT PRIMARY KEY
            )
        `);
        await db.$executeRawUnsafe(`
            CREATE TRIGGER "${triggerName}"
            BEFORE DELETE ON "ServiceAccountToken"
            WHEN OLD."id" = '${credential.id}'
                AND NOT EXISTS (
                    SELECT 1
                    FROM "${markerTable}"
                    WHERE "credentialId" = OLD."id"
                )
            BEGIN
                INSERT INTO "${markerTable}" ("credentialId")
                VALUES (OLD."id");
                UPDATE "ServiceAccountToken"
                SET "updatedAt" = OLD."updatedAt" + 1000
                WHERE "id" = OLD."id";
                SELECT RAISE(IGNORE);
            END
        `);
        try {
            await expect(deleteQualifiedConnectedServiceCredential({
                accountId: account.id,
                ref,
                expectedCredentialRevision:
                    created.credentialRevision,
                cleanupGroupReferences: true,
            })).resolves.toEqual({ status: "deleted" });
        } finally {
            await db.$executeRawUnsafe(
                `DROP TRIGGER IF EXISTS "${triggerName}"`,
            );
            await db.$executeRawUnsafe(
                `DROP TABLE IF EXISTS "${markerTable}"`,
            );
        }
        await expect(db.serviceAccountToken.findUnique({
            where: { id: credential.id },
        })).resolves.toBeNull();
    });

    it("does not retry deletion after the credential revision changes", async () => {
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const ref = { service, accountId: "delete-stale-revision" };
        const created = await mutateQualifiedConnectedServiceCredential({
            accountId: account.id,
            ref,
            expectedCredentialRevision: null,
            authenticationModeId: "api-key",
            content: { t: "plain", v: { token: "first" } },
            metadata,
        });
        if (created.status !== "written") {
            throw new Error("Expected qualified credential");
        }
        const replaced = await mutateQualifiedConnectedServiceCredential({
            accountId: account.id,
            ref,
            expectedCredentialRevision:
                created.credentialRevision,
            expectedConfigurationRevision: null,
            authenticationModeId: "api-key",
            content: { t: "plain", v: { token: "second" } },
            metadata,
        });
        if (replaced.status !== "written") {
            throw new Error("Expected credential replacement");
        }

        await expect(deleteQualifiedConnectedServiceCredential({
            accountId: account.id,
            ref,
            expectedCredentialRevision:
                created.credentialRevision,
            cleanupGroupReferences: true,
        })).resolves.toEqual({
            status: "superseded",
            credentialRevision: replaced.credentialRevision,
            configurationRevision: null,
        });
        await expect(readQualifiedConnectedServiceCredential({
            accountId: account.id,
            ref,
        })).resolves.toMatchObject({
            status: "resolved",
            credential: {
                credentialRevision: replaced.credentialRevision,
            },
        });
    });

    it("preserves a group when its structural generation changes during delete", async () => {
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const groupId = "delete-generation-cas";
        const created = await createQualifiedConnectedAccountGroup({
            accountId: account.id,
            service,
            group: { groupId },
        });
        if (created.status !== "written") {
            throw new Error("Expected group create");
        }
        const stored =
            await db.connectedServiceAuthGroup.findFirstOrThrow({
                where: { accountId: account.id, groupId },
                select: { id: true },
            });
        const triggerName =
            "qualified_group_delete_generation_cas_test";
        await db.$executeRawUnsafe(
            `DROP TRIGGER IF EXISTS "${triggerName}"`,
        );
        await db.$executeRawUnsafe(`
            CREATE TRIGGER "${triggerName}"
            BEFORE DELETE ON "ConnectedServiceAuthGroup"
            WHEN OLD."id" = '${stored.id}'
            BEGIN
                UPDATE "ConnectedServiceAuthGroup"
                SET "generation" = "generation" + 1
                WHERE "id" = '${stored.id}';
                SELECT RAISE(IGNORE);
            END
        `);
        try {
            await expect(deleteQualifiedConnectedAccountGroup({
                accountId: account.id,
                service,
                groupId,
                expectedRuntimeStateRevision:
                    created.group.runtimeStateRevision,
            })).resolves.toEqual({
                status: "generation_superseded",
                generation: created.group.generation + 1,
            });
        } finally {
            await db.$executeRawUnsafe(
                `DROP TRIGGER IF EXISTS "${triggerName}"`,
            );
        }
        await expect(db.connectedServiceAuthGroup.findUnique({
            where: { id: stored.id },
            select: {
                generation: true,
                runtimeStateRevision: true,
            },
        })).resolves.toEqual({
            generation: created.group.generation + 1,
            runtimeStateRevision:
                created.group.runtimeStateRevision,
        });
    });

    it.each(["create", "update", "delete"] as const)(
        "rolls back a %s member mutation when its group CAS loses",
        async (operation) => {
            const account = await db.account.create({
                data: { publicKey: null, encryptionMode: "plain" },
                select: { id: true },
            });
            const ref = {
                service,
                accountId: `member-cas-${operation}`,
            };
            const credential =
                await mutateQualifiedConnectedServiceCredential({
                    accountId: account.id,
                    ref,
                    expectedCredentialRevision: null,
                    authenticationModeId: "api-key",
                    content: {
                        t: "plain",
                        v: { token: "credential" },
                    },
                    metadata: {
                        ...metadata,
                        providerIdentity: {
                            accountId: `provider-${operation}`,
                        },
                    },
                });
            if (credential.status !== "written") {
                throw new Error("Expected credential create");
            }
            const groupRef = {
                service,
                groupId: `member-cas-${operation}`,
            };
            const createdGroup =
                await createQualifiedConnectedAccountGroup({
                    accountId: account.id,
                    service,
                    group: { groupId: groupRef.groupId },
                });
            if (createdGroup.status !== "written") {
                throw new Error("Expected group create");
            }
            let group = createdGroup.group;
            if (operation !== "create") {
                const createdMember =
                    await createQualifiedConnectedAccountGroupMember({
                        accountId: account.id,
                        mutation: {
                            group: groupRef,
                            connectedAccountId: ref.accountId,
                            priority: 10,
                            expectedRuntimeStateRevision:
                                group.runtimeStateRevision,
                        },
                    });
                if (createdMember.status !== "written") {
                    throw new Error("Expected member create");
                }
                group = createdMember.group;
            }
            if (operation === "delete") {
                const recordKey =
                    createProviderAccountUsageRecordKey({
                        accountSubjectId: `provider-${operation}`,
                    });
                const snapshot = createUsageSnapshot({
                    fetchedAt: Date.now(),
                    recordKey,
                });
                const usageWrite =
                    await writeQualifiedProviderAccountUsageRecord({
                    accountId: account.id,
                    source: {
                        ref,
                        bindingKind: "group_member",
                        groupId: groupRef.groupId,
                        groupGeneration: group.generation,
                    },
                    expectedCredentialRevision:
                        credential.credentialRevision,
                    expectedConfigurationRevision: null,
                    recordId: snapshot.recordId,
                    recordKey: snapshot.recordKey,
                    payloadMode: "plain_json_v1",
                    status: "ok",
                    snapshot,
                    fetchedAt: snapshot.fetchedAtMs,
                    staleAfterMs: snapshot.staleAfterMs,
                });
                expect(usageWrite.sourceOutcome).toEqual({
                    status: "linked",
                });
            }

            const storedGroup =
                await db.connectedServiceAuthGroup.findFirstOrThrow({
                    where: {
                        accountId: account.id,
                        groupId: groupRef.groupId,
                    },
                    select: { id: true },
                });
            const before = await Promise.all([
                db.connectedServiceAuthGroup.findUniqueOrThrow({
                    where: { id: storedGroup.id },
                    select: {
                        generation: true,
                        runtimeStateRevision: true,
                        activeConnectedAccountId: true,
                    },
                }),
                db.connectedServiceAuthGroupMember.findMany({
                    where: { groupDbId: storedGroup.id },
                    orderBy: { id: "asc" },
                    select: {
                        id: true,
                        priority: true,
                        enabled: true,
                        stateJson: true,
                    },
                }),
                db.connectedServiceUsageSource.findMany({
                    where: {
                        accountId: account.id,
                        groupId: groupRef.groupId,
                    },
                    orderBy: { id: "asc" },
                    select: {
                        id: true,
                        sourceKey: true,
                        credentialId: true,
                    },
                }),
            ]);
            expect(before[1]).toHaveLength(
                operation === "create" ? 0 : 1,
            );
            expect(before[2]).toHaveLength(
                operation === "delete" ? 1 : 0,
            );
            const triggerName =
                `qualified_member_${operation}_cas_test`;
            const rowAlias = operation === "delete" ? "OLD" : "NEW";
            const triggerOperation =
                operation === "create" ? "INSERT" : operation.toUpperCase();
            await db.$executeRawUnsafe(
                `DROP TRIGGER IF EXISTS "${triggerName}"`,
            );
            await db.$executeRawUnsafe(`
                CREATE TRIGGER "${triggerName}"
                AFTER ${triggerOperation}
                ON "ConnectedServiceAuthGroupMember"
                WHEN ${rowAlias}."groupDbId" = '${storedGroup.id}'
                BEGIN
                    UPDATE "ConnectedServiceAuthGroup"
                    SET "runtimeStateRevision" =
                        "runtimeStateRevision" + 1
                    WHERE "id" = '${storedGroup.id}';
                END
            `);
            try {
                const result = operation === "create"
                    ? await createQualifiedConnectedAccountGroupMember({
                        accountId: account.id,
                        mutation: {
                            group: groupRef,
                            connectedAccountId: ref.accountId,
                            priority: 20,
                            expectedRuntimeStateRevision:
                                group.runtimeStateRevision,
                        },
                    })
                    : operation === "update"
                        ? await updateQualifiedConnectedAccountGroupMember({
                            accountId: account.id,
                            mutation: {
                                group: groupRef,
                                connectedAccountId: ref.accountId,
                                priority: 20,
                                expectedRuntimeStateRevision:
                                    group.runtimeStateRevision,
                            },
                        })
                        : await deleteQualifiedConnectedAccountGroupMember({
                            accountId: account.id,
                            mutation: {
                                group: groupRef,
                                connectedAccountId: ref.accountId,
                                expectedRuntimeStateRevision:
                                    group.runtimeStateRevision,
                            },
                        });

                expect(result).toEqual({
                    status: "superseded",
                    runtimeStateRevision:
                        group.runtimeStateRevision,
                });
            } finally {
                await db.$executeRawUnsafe(
                    `DROP TRIGGER IF EXISTS "${triggerName}"`,
                );
            }

            await expect(Promise.all([
                db.connectedServiceAuthGroup.findUniqueOrThrow({
                    where: { id: storedGroup.id },
                    select: {
                        generation: true,
                        runtimeStateRevision: true,
                        activeConnectedAccountId: true,
                    },
                }),
                db.connectedServiceAuthGroupMember.findMany({
                    where: { groupDbId: storedGroup.id },
                    orderBy: { id: "asc" },
                    select: {
                        id: true,
                        priority: true,
                        enabled: true,
                        stateJson: true,
                    },
                }),
                db.connectedServiceUsageSource.findMany({
                    where: {
                        accountId: account.id,
                        groupId: groupRef.groupId,
                    },
                    orderBy: { id: "asc" },
                    select: {
                        id: true,
                        sourceKey: true,
                        credentialId: true,
                    },
                }),
            ])).resolves.toEqual(before);
        },
    );

    it("does not persist plugin quota after its admitted configuration basis changes", async () => {
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const ref = { service, accountId: "quota/configuration-cas" };
        const created = await mutateQualifiedConnectedServiceCredential({
            accountId: account.id,
            ref,
            expectedCredentialRevision: null,
            authenticationModeId: "api-key",
            content: { t: "plain", v: { token: "credential" } },
            metadata: {
                ...metadata,
                providerIdentity: { accountId: "quota-subject" },
            },
            initialConfiguration: {
                expectedConfigurationRevision: null,
                replacementContentEnvelope: {
                    t: "plain",
                    v: { region: "eu" },
                },
            },
        });
        if (
            created.status !== "written"
            || created.configurationRevision === null
        ) {
            throw new Error("Expected configured credential create");
        }
        const replaced = await mutateQualifiedConnectedAccountConfiguration({
            accountId: account.id,
            target: { kind: "account", ref },
            expectedCredentialRevision: created.credentialRevision,
            expectedConfigurationRevision: created.configurationRevision,
            replacementContentEnvelope: {
                t: "plain",
                v: { region: "us" },
            },
        });
        if (replaced.status !== "written") {
            throw new Error("Expected configuration replacement");
        }
        const recordKey = createProviderAccountUsageRecordKey({
            accountSubjectId: "quota-subject",
        });
        const snapshot = createUsageSnapshot({
            fetchedAt: Date.now(),
            recordKey,
        });

        await expect(writeQualifiedProviderAccountUsageRecord({
            accountId: account.id,
            source: { ref, bindingKind: "account" },
            expectedCredentialRevision: created.credentialRevision,
            expectedConfigurationRevision: created.configurationRevision,
            recordId: snapshot.recordId,
            recordKey: snapshot.recordKey,
            payloadMode: "plain_json_v1",
            status: "ok",
            snapshot,
            fetchedAt: snapshot.fetchedAtMs,
            staleAfterMs: snapshot.staleAfterMs,
        })).rejects.toMatchObject({
            name: QualifiedConnectedAccountUsageBasisError.name,
            reason: "configuration_revision_mismatch",
            credentialRevision: created.credentialRevision,
            configurationRevision: replaced.configurationRevision,
        });
        await expect(db.providerAccountUsageRecord.count({
            where: { accountId: account.id },
        })).resolves.toBe(0);
    });
    it("creates a credential after an Account retains 500 existing credentials", async () => {
        const inventorySize = 501;
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        await db.serviceAccountToken.createMany({
            data: Array.from(
                { length: inventorySize - 1 },
                (_, index) => ({
                    accountId: account.id,
                    ...createServiceAccountTokenIdentityFields({
                        ref: { service, accountId: `seeded/account/${index}` },
                        authenticationModeId: "api-key",
                    }),
                    token: Buffer.from("opaque-token", "utf8"),
                }),
            ),
        });

        await expect(listQualifiedConnectedAccounts({
            accountId: account.id,
            service,
        })).resolves.toHaveLength(inventorySize - 1);

        await expect(mutateQualifiedConnectedServiceCredential({
            accountId: account.id,
            ref: { service, accountId: "provider/account/overflow" },
            expectedCredentialRevision: null,
            authenticationModeId: "api-key",
            content: { t: "plain", v: { token: "credential" } },
            metadata,
        })).resolves.toMatchObject({ status: "written" });

        await expect(db.serviceAccountToken.count({
            where: { accountId: account.id },
        })).resolves.toBe(inventorySize);
        await expect(listQualifiedConnectedAccounts({
            accountId: account.id,
            service,
        })).resolves.toHaveLength(inventorySize);
    }, 60_000);

    it("keeps updating an existing credential available in a large inventory", async () => {
        const inventorySize = 501;
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const ref = { service, accountId: "provider/account/at-ceiling" };
        const created = await mutateQualifiedConnectedServiceCredential({
            accountId: account.id,
            ref,
            expectedCredentialRevision: null,
            authenticationModeId: "api-key",
            content: { t: "plain", v: { token: "credential" } },
            metadata,
        });
        if (created.status !== "written") {
            throw new Error("Expected the first credential to be written");
        }
        await db.serviceAccountToken.createMany({
            data: Array.from(
                { length: inventorySize - 1 },
                (_, index) => ({
                    accountId: account.id,
                    ...createServiceAccountTokenIdentityFields({
                        ref: { service, accountId: `seeded/account/${index}` },
                        authenticationModeId: "api-key",
                    }),
                    token: Buffer.from("opaque-token", "utf8"),
                }),
            ),
        });

        await expect(mutateQualifiedConnectedServiceCredential({
            accountId: account.id,
            ref,
            expectedCredentialRevision: created.credentialRevision,
            expectedConfigurationRevision: null,
            authenticationModeId: "api-key",
            content: { t: "plain", v: { token: "rotated" } },
            metadata,
        })).resolves.toMatchObject({ status: "written" });
    }, 60_000);
});
