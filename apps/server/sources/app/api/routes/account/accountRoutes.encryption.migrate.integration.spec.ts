import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";

import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { acquireAccountSessionOwnerMetadataFenceInTx } from "@/app/encryption/accountSessionOwnerMetadataFence";
import { registerAccountEncryptionMigrateRoutes } from "./registerAccountEncryptionMigrateRoutes";
import { registerAccountSettingsRoutes } from "./registerAccountSettingsRoutes";
import {
    createProviderAccountUsageRecordKey,
    createUsageSnapshot,
} from "../connect/providerAccountUsageTestkit";
import { mutateConnectedServiceCredential } from "../connect/credentials/mutation";
import {
    mutateQualifiedConnectedServiceCredential,
} from "../connect/qualifiedConnectedAccounts/credentialRepository";
import {
    createQualifiedConnectedAccountGroup,
    createQualifiedConnectedAccountGroupMember,
    setQualifiedConnectedAccountGroupActiveAccount,
} from "../connect/qualifiedConnectedAccounts/groupRepository";
import {
    writeQualifiedProviderAccountUsageRecordFromLegacyBoundary,
    writeQualifiedProviderAccountUsageRecord,
} from "../connect/qualifiedConnectedAccounts/usageRepository";
import {
    resolveLegacyQualifiedConnectedAccountService,
} from "../connect/qualifiedConnectedAccounts/identity";
import {
    createLegacyCredentialFixtureIdentity,
} from "../connect/testkit/qualifiedConnectedAccountFixtureIdentity";
import { registerAutomationCrudRoutes } from "../automations/registerAutomationCrudRoutes";
import tweetnacl from "tweetnacl";
import * as privacyKit from "privacy-kit";
import {
    sealAccountScopedBlobCiphertext,
} from "@happier-dev/protocol";
import { enableErrorHandlers } from "@/app/api/utils/enableErrorHandlers";

import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

const SESSION_OWNER_MATERIAL = {
    type: "legacy",
    secret: new Uint8Array(32).fill(23),
} as const;

function sealOwnerMetadata(marker: string): string {
    return sealAccountScopedBlobCiphertext({
        kind: "session_owner_metadata",
        material: SESSION_OWNER_MATERIAL,
        payload: { v: 1, marker },
        randomBytes: (length) =>
            new Uint8Array(length).fill(marker.charCodeAt(0)),
    });
}

function createSignedContentKeyBinding(
    signingSecretKey: Uint8Array,
): Readonly<{
    contentPublicKey: string;
    contentPublicKeySig: string;
    contentPublicKeyBytes: Uint8Array<ArrayBuffer>;
    contentPublicKeySigBytes: Uint8Array<ArrayBuffer>;
}> {
    const contentKey = tweetnacl.box.keyPair();
    const binding = Buffer.concat([
        Buffer.from("Happy content key v1\u0000", "utf8"),
        Buffer.from(contentKey.publicKey),
    ]);
    const signature = tweetnacl.sign.detached(binding, signingSecretKey);
    return {
        contentPublicKey: privacyKit.encodeBase64(
            new Uint8Array(contentKey.publicKey),
        ),
        contentPublicKeySig: privacyKit.encodeBase64(
            new Uint8Array(signature),
        ),
        contentPublicKeyBytes: new Uint8Array(contentKey.publicKey),
        contentPublicKeySigBytes: new Uint8Array(signature),
    };
}

async function createAccountMigrationSessionGuardFixture(params: Readonly<{
    archivedAt: Date | null;
    metadataLayoutVersion: number;
    ownerMetadata?: string | null;
}>) {
    const account = await db.account.create({
        data: {
            encryptionMode: "e2ee",
            settings: "ciphertext",
            settingsVersion: 0,
        },
        select: { id: true },
    });
    const session = await db.session.create({
        data: {
            accountId: account.id,
            tag: `layout-${params.metadataLayoutVersion}-${params.archivedAt ? "archived" : "active"}`,
            metadata: "shared-before-migration",
            metadataVersion: 1,
            metadataLayoutVersion: params.metadataLayoutVersion,
            ownerMetadata: params.ownerMetadata === undefined
                ? params.metadataLayoutVersion === 0
                    ? null
                    : sealOwnerMetadata("current-owner")
                : params.ownerMetadata,
            agentState: null,
            agentStateVersion: 2,
            archivedAt: params.archivedAt,
        },
        select: {
            id: true,
            metadata: true,
            metadataVersion: true,
            metadataLayoutVersion: true,
            ownerMetadata: true,
            agentState: true,
            agentStateVersion: true,
            archivedAt: true,
        },
    });
    await db.serviceAccountToken.create({
        data: {
            accountId: account.id,
            vendor: "anthropic",
            profileId: "default",
            ...createLegacyCredentialFixtureIdentity({
                serviceId: "anthropic",
                profileId: "default",
            }),
            token: new TextEncoder().encode("sealed-before-migration"),
        },
    });
    const automation = await db.automation.create({
        data: {
            accountId: account.id,
            name: "migration-owned automation",
            scheduleKind: "interval",
            everyMs: 60_000,
            timezone: null,
            scheduleExpr: null,
            targetType: "new_session",
            templateCiphertext: "automation-before-migration",
        },
        select: { id: true },
    });
    return { account, automation, session };
}

const { emitUpdate } = vi.hoisted(() => ({
    emitUpdate: vi.fn(),
}));

async function expectAccountMigrationGuardRefusalLeavesFixtureUnchanged(
    fixture: Awaited<
        ReturnType<typeof createAccountMigrationSessionGuardFixture>
    >,
): Promise<void> {
    await expect(db.account.findUnique({
        where: { id: fixture.account.id },
        select: {
            encryptionMode: true,
            settings: true,
            settingsVersion: true,
        },
    })).resolves.toEqual({
        encryptionMode: "e2ee",
        settings: "ciphertext",
        settingsVersion: 0,
    });
    await expect(db.serviceAccountToken.count({
        where: { accountId: fixture.account.id },
    })).resolves.toBe(1);
    await expect(db.automation.findUnique({
        where: { id: fixture.automation.id },
        select: { templateCiphertext: true },
    })).resolves.toEqual({
        templateCiphertext: "automation-before-migration",
    });
    await expect(db.session.findUnique({
        where: { id: fixture.session.id },
        select: {
            id: true,
            metadata: true,
            metadataVersion: true,
            metadataLayoutVersion: true,
            ownerMetadata: true,
            agentState: true,
            agentStateVersion: true,
            archivedAt: true,
        },
    })).resolves.toEqual(fixture.session);
    await expect(db.accountChange.count({
        where: { accountId: fixture.account.id },
    })).resolves.toBe(0);
    expect(emitUpdate).not.toHaveBeenCalled();
}

vi.mock("@/app/events/eventRouter", async () => {
    const actual = await vi.importActual<typeof import("@/app/events/eventRouter")>("@/app/events/eventRouter");
    return {
        ...actual,
        eventRouter: { emitUpdate },
    };
});

function createTestApp() {
    const app = Fastify({ logger: false });
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
    enableErrorHandlers(typed);

    return typed;
}

function deferred(): Readonly<{ promise: Promise<void>; resolve: () => void }> {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function installAccountModeReadBarrier(accountId: string): Readonly<{
    modeObserved: Promise<void>;
    release: () => void;
    restore: () => void;
}> {
    const modeObserved = deferred();
    const releaseRead = deferred();
    let paused = false;
    const mutableDb = db as any;
    const accountDelegate = mutableDb.account;
    const originalFindUnique = accountDelegate.findUnique;

    accountDelegate.findUnique = async (args: unknown) => {
        const result = await originalFindUnique.call(accountDelegate, args);
        const query = args as { where?: { id?: string }; select?: { encryptionMode?: boolean } } | undefined;
        if (!paused && query?.where?.id === accountId && query.select?.encryptionMode === true) {
            paused = true;
            modeObserved.resolve();
            await releaseRead.promise;
        }
        return result;
    };

    return {
        modeObserved: modeObserved.promise,
        release: releaseRead.resolve,
        restore: () => {
            releaseRead.resolve();
            accountDelegate.findUnique = originalFindUnique;
        },
    };
}

describe("registerAccountEncryptionMigrateRoutes (integration)", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-account-encryption-migrate-",
            initEncrypt: true,
            env: { HAPPIER_SQLITE_CONNECTION_LIMIT: "2" },
        });
    }, 120_000);

    afterEach(async () => {
        emitUpdate.mockClear();
        harness.resetEnv();
        await db.connectedServiceUsageSource.deleteMany().catch(() => {});
        await db.providerAccountUsageRecord.deleteMany().catch(() => {});
        await db.serviceAccountToken.deleteMany().catch(() => {});
        await db.automation.deleteMany().catch(() => {});
        await db.session.deleteMany().catch(() => {});
        await db.account.deleteMany().catch(() => {});
    });

    afterAll(async () => {
        await harness.close();
    });

    it("migrates e2ee -> plain atomically and stores v2 settings in plaintext", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_SETTINGS_AT_REST: "none",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });

        const account = await db.account.create({
            data: { publicKey: "pk-migrate-1", encryptionMode: "e2ee", settings: "ciphertext", settingsVersion: 0 },
            select: { id: true },
        });
        const legacySession = await db.session.create({
            data: {
                accountId: account.id,
                tag: "predecessor-layout-zero",
                metadata: "legacy-session-metadata",
                metadataVersion: 3,
                metadataLayoutVersion: 0,
                ownerMetadata: null,
                agentState: null,
                agentStateVersion: 0,
            },
            select: {
                id: true,
                metadata: true,
                metadataVersion: true,
                metadataLayoutVersion: true,
                ownerMetadata: true,
                agentState: true,
                agentStateVersion: true,
            },
        });
        const previousRevision = "csr_AAAAAAAAAAAAAAAAAAAAAA";
        await db.serviceAccountToken.create({
            data: {
                accountId: account.id,
                vendor: "anthropic",
                profileId: "work",
                ...createLegacyCredentialFixtureIdentity({
                    serviceId: "anthropic",
                    profileId: "work",
                }),
                token: new TextEncoder().encode("sealed-before-migration"),
                metadata: {
                    v: 2,
                    format: "account_scoped_v1",
                    kind: "token",
                    credentialRevision: previousRevision,
                },
                refreshLeaseOwnerMachineId: "stale-daemon:plain-migration",
                refreshLeaseExpiresAt: new Date(Date.now() + 60_000),
            },
        });

        const app = createTestApp();
        registerAccountSettingsRoutes(app as any);
        registerAccountEncryptionMigrateRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v1/account/encryption/migrate",
            headers: { "content-type": "application/json", "x-test-user-id": account.id },
            payload: {
                toMode: "plain",
                expectedSettingsVersion: 0,
                settingsContent: { t: "plain", v: { schemaVersion: 2 } },
                connectedServices: {
                    action: "migrate",
                    credentials: [{
                        serviceId: "anthropic",
                        profileId: "work",
                        kind: "plain",
                        record: {
                            v: 1,
                            serviceId: "anthropic",
                            profileId: "work",
                            createdAt: 1,
                            updatedAt: 2,
                            expiresAt: null,
                            kind: "token",
                            oauth: null,
                            token: {
                                token: "plain-after-migration",
                                providerAccountId: "acct-migrate-plain",
                                providerEmail: "plain@example.com",
                                raw: null,
                            },
                        },
                    }],
                },
                automations: { action: "assert_empty" },
            },
        });

        expect(res.statusCode, res.body).toBe(200);
        expect(res.json()).toMatchObject({ success: true, mode: "plain" });

        const storedAccount = await db.account.findUnique({
            where: { id: account.id },
            select: { encryptionMode: true, settingsVersion: true, settings: true },
        });
        expect(storedAccount?.encryptionMode).toBe("plain");
        expect(storedAccount?.settingsVersion).toBe(1);
        expect(typeof storedAccount?.settings).toBe("string");
        expect((storedAccount?.settings ?? "").includes("ciphertext")).toBe(false);
        const migratedCredential = await db.serviceAccountToken.findUnique({
            where: {
                accountId_vendor_profileId: {
                    accountId: account.id,
                    vendor: "anthropic",
                    profileId: "work",
                },
            },
            select: {
                metadata: true,
                refreshLeaseOwnerMachineId: true,
                refreshLeaseExpiresAt: true,
            },
        });
        expect(migratedCredential?.metadata).toEqual(expect.objectContaining({
            v: 4,
            storage: "stored_envelope_v1",
            credentialRevision: expect.stringMatching(/^csr_/),
        }));
        expect((migratedCredential?.metadata as { credentialRevision?: string })?.credentialRevision).not.toBe(previousRevision);
        expect(migratedCredential?.refreshLeaseOwnerMachineId).toBeNull();
        expect(migratedCredential?.refreshLeaseExpiresAt).toBeNull();
        await expect(db.session.findUnique({
            where: { id: legacySession.id },
            select: {
                id: true,
                metadata: true,
                metadataVersion: true,
                metadataLayoutVersion: true,
                ownerMetadata: true,
                agentState: true,
                agentStateVersion: true,
            },
        })).resolves.toEqual(legacySession);
        const settingsChange = await db.accountChange.findFirst({
            where: { accountId: account.id, kind: "account", entityId: "self" },
            orderBy: { cursor: "desc" },
        });
        expect(settingsChange?.hint).toEqual({ settingsVersion: 1 });
        expect(emitUpdate).toHaveBeenCalledTimes(3);
        expect(emitUpdate).toHaveBeenCalledWith(expect.objectContaining({
            userId: account.id,
            payload: expect.objectContaining({
                body: {
                    t: "account-settings-changed",
                    settingsVersion: 1,
                },
            }),
            recipientFilter: { type: "user-machine-scoped-only" },
        }));
        expect(emitUpdate).toHaveBeenCalledWith(expect.objectContaining({
            userId: account.id,
            payload: expect.objectContaining({
                body: expect.objectContaining({
                    t: "update-account",
                    connectedServicesV2: expect.any(Array),
                }),
            }),
            recipientFilter: { type: "user-machine-scoped-only" },
        }));
        expect(emitUpdate).toHaveBeenCalledWith(expect.objectContaining({
            userId: account.id,
            payload: expect.objectContaining({
                body: expect.objectContaining({ t: "update-account", connectedServicesV2: expect.any(Array) }),
            }),
            recipientFilter: { type: "user-scoped-only" },
        }));

        const getV2 = await app.inject({
            method: "GET",
            url: "/v2/account/settings",
            headers: { "x-test-user-id": account.id },
        });
        expect(getV2.statusCode).toBe(200);
        expect(getV2.json()).toMatchObject({ version: 1, content: { t: "plain" } });

        await app.close();
    });

    it("clears qualified credentials, groups, and usage atomically without changing another account", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_SETTINGS_AT_REST: "none",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });

        const account = await db.account.create({
            data: { publicKey: "pk-clear-source", encryptionMode: "e2ee", settings: "ciphertext", settingsVersion: 0 },
            select: { id: true },
        });
        const service = {
            pluginId: "example.account-clear",
            localId: "qualified/service",
        } as const;
        const ref = {
            service,
            accountId: "qualified/account",
        } as const;
        const credential = await mutateQualifiedConnectedServiceCredential({
            accountId: account.id,
            ref,
            expectedCredentialRevision: null,
            authenticationModeId: "oauth",
            content: {
                t: "encrypted",
                c: "sealed-qualified-credential",
            },
            metadata: {
                displayName: "Qualified account",
                scopes: [],
                providerIdentity: {
                    accountId: "acct_clear_connected_services",
                },
            },
        });
        if (credential.status !== "written") {
            throw new Error("Expected qualified credential");
        }
        const groupRef = {
            service,
            groupId: "qualified-group",
        } as const;
        const createdGroup = await createQualifiedConnectedAccountGroup({
            accountId: account.id,
            service,
            group: { groupId: groupRef.groupId },
        });
        if (createdGroup.status !== "written") {
            throw new Error("Expected qualified group");
        }
        const createdMember =
            await createQualifiedConnectedAccountGroupMember({
                accountId: account.id,
                mutation: {
                    group: groupRef,
                    connectedAccountId: ref.accountId,
                    priority: 1,
                    enabled: true,
                },
            });
        if (createdMember.status !== "written") {
            throw new Error("Expected qualified group member");
        }
        const activatedGroup =
            await setQualifiedConnectedAccountGroupActiveAccount({
                accountId: account.id,
                mutation: {
                    group: groupRef,
                    connectedAccountId: ref.accountId,
                    expectedGeneration:
                        createdMember.group.generation,
                },
            });
        if (activatedGroup.status !== "written") {
            throw new Error("Expected active qualified group member");
        }
        const snapshot = createUsageSnapshot({
            fetchedAt: Date.now(),
            recordKey: createProviderAccountUsageRecordKey({ accountSubjectId: "acct_clear_connected_services" }),
        });
        await writeQualifiedProviderAccountUsageRecord({
            accountId: account.id,
            source: {
                ref,
                bindingKind: "group_member",
                groupId: groupRef.groupId,
                groupGeneration:
                    activatedGroup.group.generation,
            },
            expectedCredentialRevision:
                credential.credentialRevision,
            expectedConfigurationRevision: null,
            recordId: snapshot.recordId,
            recordKey: snapshot.recordKey,
            payloadMode: "sealed_account_scoped_v1",
            sealedPayload: {
                format: "account_scoped_v1",
                ciphertext: "sealed-usage-before-mode-change",
            },
            status: "ok",
            fetchedAt: snapshot.fetchedAtMs,
            staleAfterMs: snapshot.staleAfterMs,
            materialFingerprint: "usage:account-clear-source",
        });
        const groupBeforeClear =
            await db.connectedServiceAuthGroup.findFirstOrThrow({
                where: {
                    accountId: account.id,
                    groupId: groupRef.groupId,
                },
                select: {
                    id: true,
                    generation: true,
                    runtimeStateRevision: true,
                },
            });
        const unrelatedAccount = await db.account.create({
            data: {
                publicKey: "pk-unrelated-clear-source",
                encryptionMode: "e2ee",
                settings: "unrelated-ciphertext",
                settingsVersion: 0,
            },
            select: { id: true },
        });
        const unrelatedRef = {
            service,
            accountId: "unrelated/account",
        } as const;
        const unrelatedCredential =
            await mutateQualifiedConnectedServiceCredential({
                accountId: unrelatedAccount.id,
                ref: unrelatedRef,
                expectedCredentialRevision: null,
                authenticationModeId: "oauth",
                content: {
                    t: "encrypted",
                    c: "sealed-unrelated-credential",
                },
                metadata: {
                    displayName: "Unrelated account",
                    scopes: [],
                    providerIdentity: {
                        accountId: "acct_unrelated_connected_services",
                    },
                },
            });
        if (unrelatedCredential.status !== "written") {
            throw new Error("Expected unrelated qualified credential");
        }
        const unrelatedGroupRef = {
            service,
            groupId: "unrelated-group",
        } as const;
        const unrelatedGroup =
            await createQualifiedConnectedAccountGroup({
                accountId: unrelatedAccount.id,
                service,
                group: { groupId: unrelatedGroupRef.groupId },
            });
        if (unrelatedGroup.status !== "written") {
            throw new Error("Expected unrelated qualified group");
        }
        const unrelatedMember =
            await createQualifiedConnectedAccountGroupMember({
                accountId: unrelatedAccount.id,
                mutation: {
                    group: unrelatedGroupRef,
                    connectedAccountId: unrelatedRef.accountId,
                    priority: 1,
                    enabled: true,
                },
            });
        if (unrelatedMember.status !== "written") {
            throw new Error("Expected unrelated qualified group member");
        }
        const unrelatedActive =
            await setQualifiedConnectedAccountGroupActiveAccount({
                accountId: unrelatedAccount.id,
                mutation: {
                    group: unrelatedGroupRef,
                    connectedAccountId: unrelatedRef.accountId,
                    expectedGeneration:
                        unrelatedMember.group.generation,
                },
            });
        if (unrelatedActive.status !== "written") {
            throw new Error("Expected unrelated active group member");
        }
        const unrelatedSnapshot = createUsageSnapshot({
            fetchedAt: Date.now(),
            recordKey: createProviderAccountUsageRecordKey({
                accountSubjectId:
                    "acct_unrelated_connected_services",
            }),
        });
        await writeQualifiedProviderAccountUsageRecord({
            accountId: unrelatedAccount.id,
            source: {
                ref: unrelatedRef,
                bindingKind: "group_member",
                groupId: unrelatedGroupRef.groupId,
                groupGeneration:
                    unrelatedActive.group.generation,
            },
            expectedCredentialRevision:
                unrelatedCredential.credentialRevision,
            expectedConfigurationRevision: null,
            recordId: unrelatedSnapshot.recordId,
            recordKey: unrelatedSnapshot.recordKey,
            payloadMode: "sealed_account_scoped_v1",
            sealedPayload: {
                format: "account_scoped_v1",
                ciphertext: "sealed-unrelated-usage",
            },
            status: "ok",
            fetchedAt: unrelatedSnapshot.fetchedAtMs,
            staleAfterMs: unrelatedSnapshot.staleAfterMs,
            materialFingerprint: "usage:unrelated-account",
        });
        const unrelatedGroupBeforeClear =
            await db.connectedServiceAuthGroup.findFirstOrThrow({
                where: {
                    accountId: unrelatedAccount.id,
                    groupId: unrelatedGroupRef.groupId,
                },
                select: {
                    id: true,
                    activeConnectedAccountId: true,
                    activeProfileId: true,
                    generation: true,
                    runtimeStateRevision: true,
                },
            });

        const app = createTestApp();
        registerAccountSettingsRoutes(app as any);
        registerAccountEncryptionMigrateRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v1/account/encryption/migrate",
            headers: { "content-type": "application/json", "x-test-user-id": account.id },
            payload: {
                toMode: "plain",
                expectedSettingsVersion: 0,
                settingsContent: { t: "plain", v: { schemaVersion: 2 } },
                connectedServices: { action: "clear" },
                automations: { action: "assert_empty" },
            },
        });

        expect(res.statusCode).toBe(200);
        expect(await db.serviceAccountToken.count({
            where: { accountId: account.id },
        })).toBe(0);
        expect(await db.connectedServiceAuthGroupMember.count({
            where: { accountId: account.id },
        })).toBe(0);
        await expect(db.connectedServiceAuthGroup.findUniqueOrThrow({
            where: { id: groupBeforeClear.id },
            select: {
                activeConnectedAccountId: true,
                activeProfileId: true,
                generation: true,
                runtimeStateRevision: true,
            },
        })).resolves.toEqual({
            activeConnectedAccountId: null,
            activeProfileId: null,
            generation: groupBeforeClear.generation + 1,
            runtimeStateRevision:
                groupBeforeClear.runtimeStateRevision,
        });
        const repeatedClear = await app.inject({
            method: "POST",
            url: "/v1/account/encryption/migrate",
            headers: {
                "content-type": "application/json",
                "x-test-user-id": account.id,
            },
            payload: {
                toMode: "plain",
                expectedSettingsVersion: 1,
                settingsContent: {
                    t: "plain",
                    v: { schemaVersion: 2 },
                },
                connectedServices: { action: "clear" },
                automations: { action: "assert_empty" },
            },
        });
        expect(repeatedClear.statusCode).toBe(200);
        await expect(db.connectedServiceAuthGroup.findUniqueOrThrow({
            where: { id: groupBeforeClear.id },
            select: {
                activeConnectedAccountId: true,
                activeProfileId: true,
                generation: true,
                runtimeStateRevision: true,
            },
        })).resolves.toEqual({
            activeConnectedAccountId: null,
            activeProfileId: null,
            generation: groupBeforeClear.generation + 1,
            runtimeStateRevision:
                groupBeforeClear.runtimeStateRevision,
        });
        expect(await db.connectedServiceUsageSource.count({
            where: { accountId: account.id },
        })).toBe(0);
        expect(await db.providerAccountUsageRecord.count({ where: { accountId: account.id } })).toBe(0);
        expect(await db.serviceAccountToken.count({
            where: { accountId: unrelatedAccount.id },
        })).toBe(1);
        expect(await db.connectedServiceAuthGroupMember.count({
            where: { accountId: unrelatedAccount.id },
        })).toBe(1);
        expect(await db.connectedServiceUsageSource.count({
            where: { accountId: unrelatedAccount.id },
        })).toBe(1);
        expect(await db.providerAccountUsageRecord.count({
            where: { accountId: unrelatedAccount.id },
        })).toBe(1);
        await expect(db.connectedServiceAuthGroup.findUniqueOrThrow({
            where: { id: unrelatedGroupBeforeClear.id },
            select: {
                activeConnectedAccountId: true,
                activeProfileId: true,
                generation: true,
                runtimeStateRevision: true,
            },
        })).resolves.toEqual({
            activeConnectedAccountId:
                unrelatedGroupBeforeClear.activeConnectedAccountId,
            activeProfileId:
                unrelatedGroupBeforeClear.activeProfileId,
            generation: unrelatedGroupBeforeClear.generation,
            runtimeStateRevision:
                unrelatedGroupBeforeClear.runtimeStateRevision,
        });
    });

    it("retains mode-compatible provider usage records and sources during a same-mode credential rewrite", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain", settings: null, settingsVersion: 0 },
            select: { id: true },
        });
        await db.serviceAccountToken.create({
            data: {
                accountId: account.id,
                vendor: "openai-codex",
                profileId: "work",
                ...createLegacyCredentialFixtureIdentity({
                    serviceId: "openai-codex",
                    profileId: "work",
                }),
                token: new TextEncoder().encode(JSON.stringify({
                    v: 1,
                    serviceId: "openai-codex",
                    profileId: "work",
                    kind: "oauth",
                    createdAt: 1,
                    updatedAt: 1,
                    expiresAt: null,
                    oauth: {
                        accessToken: "before",
                        refreshToken: "refresh-before",
                        idToken: null,
                        scope: null,
                        tokenType: null,
                        providerAccountId: "acct-retained",
                        providerEmail: null,
                        raw: null,
                    },
                    token: null,
                })),
                metadata: { v: 3, storage: "plain_json_v1", kind: "oauth", providerAccountId: "acct-retained", providerEmail: null },
            },
        });
        const snapshot = createUsageSnapshot({
            fetchedAt: Date.now(),
            recordKey: createProviderAccountUsageRecordKey({ accountSubjectId: "acct-retained" }),
            profileId: "work",
        });
        await writeQualifiedProviderAccountUsageRecordFromLegacyBoundary({
            accountId: account.id,
            recordId: snapshot.recordId,
            recordKey: snapshot.recordKey,
            payloadMode: "plain_json_v1",
            status: "ok",
            fetchedAt: snapshot.fetchedAtMs,
            staleAfterMs: snapshot.staleAfterMs,
            snapshot,
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
        const app = createTestApp();
        registerAccountEncryptionMigrateRoutes(app as any);
        await app.ready();
        const res = await app.inject({
            method: "POST",
            url: "/v1/account/encryption/migrate",
            headers: { "content-type": "application/json", "x-test-user-id": account.id },
            payload: {
                toMode: "plain",
                expectedSettingsVersion: 0,
                settingsContent: { t: "plain", v: { schemaVersion: 2 } },
                connectedServices: {
                    action: "migrate",
                    credentials: [{
                        serviceId: "openai-codex",
                        profileId: "work",
                        kind: "plain",
                        record: {
                            v: 1,
                            serviceId: "openai-codex",
                            profileId: "work",
                            createdAt: 1,
                            updatedAt: 2,
                            expiresAt: null,
                            kind: "oauth",
                            oauth: {
                                accessToken: "after",
                                refreshToken: "refresh-after",
                                idToken: null,
                                scope: null,
                                tokenType: null,
                                providerAccountId: "acct-retained",
                                providerEmail: null,
                                raw: null,
                            },
                            token: null,
                        },
                    }],
                },
                automations: { action: "assert_empty" },
            },
        });
        expect(res.statusCode, res.body).toBe(200);
        expect(await db.providerAccountUsageRecord.count({ where: { accountId: account.id } })).toBe(1);
        expect(await db.connectedServiceUsageSource.count({ where: { accountId: account.id } })).toBe(1);
        await app.close();
    });

    it("rejects a plaintext migration item whose embedded credential binding differs from its outer key", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });
        const account = await db.account.create({
            data: { publicKey: "pk-misbound-migration", encryptionMode: "e2ee", settings: "ciphertext", settingsVersion: 0 },
            select: { id: true },
        });
        await db.serviceAccountToken.create({
            data: {
                accountId: account.id,
                vendor: "anthropic",
                profileId: "work",
                ...createLegacyCredentialFixtureIdentity({
                    serviceId: "anthropic",
                    profileId: "work",
                }),
                token: new TextEncoder().encode("sealed-before"),
                metadata: { v: 2, format: "account_scoped_v1", kind: "token", providerAccountId: "acct-1", credentialRevision: "csr_AAAAAAAAAAAAAAAAAAAAAA" },
            },
        });
        const app = createTestApp();
        registerAccountEncryptionMigrateRoutes(app as any);
        await app.ready();
        const res = await app.inject({
            method: "POST",
            url: "/v1/account/encryption/migrate",
            headers: { "content-type": "application/json", "x-test-user-id": account.id },
            payload: {
                toMode: "plain",
                expectedSettingsVersion: 0,
                settingsContent: { t: "plain", v: { schemaVersion: 2 } },
                connectedServices: {
                    action: "migrate",
                    credentials: [{
                        serviceId: "anthropic",
                        profileId: "work",
                        kind: "plain",
                        record: {
                            v: 1,
                            serviceId: "anthropic",
                            profileId: "other",
                            createdAt: 1,
                            updatedAt: 2,
                            expiresAt: null,
                            kind: "token",
                            oauth: null,
                            token: { token: "foreign", providerAccountId: "acct-1", providerEmail: null, raw: null },
                        },
                    }],
                },
                automations: { action: "assert_empty" },
            },
        });
        expect(res.statusCode).toBe(400);
        await expect(db.account.findUnique({ where: { id: account.id }, select: { encryptionMode: true, settingsVersion: true } }))
            .resolves.toEqual({ encryptionMode: "e2ee", settingsVersion: 0 });
        expect(new TextDecoder().decode((await db.serviceAccountToken.findFirst({ where: { accountId: account.id }, select: { token: true } }))?.token))
            .toBe("sealed-before");
        expect(emitUpdate).not.toHaveBeenCalled();
    });

    it("rejects provider identity changes during credential migration and rolls back account/settings writes", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });
        const account = await db.account.create({
            data: { publicKey: "pk-identity-migration", encryptionMode: "e2ee", settings: "ciphertext", settingsVersion: 0 },
            select: { id: true },
        });
        await expect(mutateConnectedServiceCredential({
            accountId: account.id,
            serviceId: "anthropic",
            profileId: "work",
            token: new TextEncoder().encode("sealed-before"),
            metadata: { v: 2, format: "account_scoped_v1", kind: "token", providerAccountId: "acct-old" },
            expiresAt: null,
            storageMode: "sealed",
            incomingIdentity: { providerAccountId: "acct-old" },
            allowProviderIdentityChange: false,
        })).resolves.toMatchObject({ status: "written" });
        const beforeCredential = await db.serviceAccountToken.findFirstOrThrow({
            where: { accountId: account.id },
            select: { token: true, metadata: true },
        });
        emitUpdate.mockClear();
        const app = createTestApp();
        registerAccountEncryptionMigrateRoutes(app as any);
        await app.ready();
        const res = await app.inject({
            method: "POST",
            url: "/v1/account/encryption/migrate",
            headers: { "content-type": "application/json", "x-test-user-id": account.id },
            payload: {
                toMode: "plain",
                expectedSettingsVersion: 0,
                settingsContent: { t: "plain", v: { schemaVersion: 2 } },
                connectedServices: {
                    action: "migrate",
                    credentials: [{
                        serviceId: "anthropic",
                        profileId: "work",
                        kind: "plain",
                        record: {
                            v: 1,
                            serviceId: "anthropic",
                            profileId: "work",
                            createdAt: 1,
                            updatedAt: 2,
                            expiresAt: null,
                            kind: "token",
                            oauth: null,
                            token: { token: "changed", providerAccountId: "acct-new", providerEmail: null, raw: null },
                        },
                    }],
                },
                automations: { action: "assert_empty" },
            },
        });
        expect(res.statusCode).toBe(400);
        await expect(db.account.findUnique({ where: { id: account.id }, select: { encryptionMode: true, settingsVersion: true, settings: true } }))
            .resolves.toEqual({ encryptionMode: "e2ee", settingsVersion: 0, settings: "ciphertext" });
        const afterCredential = await db.serviceAccountToken.findFirstOrThrow({
            where: { accountId: account.id },
            select: { token: true, metadata: true },
        });
        expect(Array.from(afterCredential.token)).toEqual(
            Array.from(beforeCredential.token),
        );
        expect(afterCredential.metadata).toEqual(beforeCredential.metadata);
        expect(emitUpdate).not.toHaveBeenCalled();
    });

    it("does not emit a settings version hint when migration preconditions fail", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
        });

        const account = await db.account.create({
            data: { publicKey: "pk-migrate-conflict", encryptionMode: "e2ee", settings: "ciphertext", settingsVersion: 3 },
            select: { id: true },
        });

        const app = createTestApp();
        registerAccountEncryptionMigrateRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v1/account/encryption/migrate",
            headers: { "content-type": "application/json", "x-test-user-id": account.id },
            payload: {
                toMode: "plain",
                expectedSettingsVersion: 2,
                settingsContent: { t: "plain", v: { schemaVersion: 2 } },
                connectedServices: { action: "assert_empty" },
                automations: { action: "assert_empty" },
            },
        });

        expect(res.statusCode).toBe(409);
        expect(emitUpdate).not.toHaveBeenCalled();

        await app.close();
    });

    it("stores v2 settings sealed at rest for plain accounts when configured", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_SETTINGS_AT_REST: "server_sealed",
        });

        const kp = tweetnacl.sign.keyPair();
        const publicKeyHex = privacyKit.encodeHex(new Uint8Array(kp.publicKey));

        const account = await db.account.create({
            data: { publicKey: publicKeyHex, encryptionMode: "e2ee", settings: "ciphertext", settingsVersion: 0 },
            select: { id: true },
        });

        const app = createTestApp();
        registerAccountSettingsRoutes(app as any);
        registerAccountEncryptionMigrateRoutes(app as any);
        await app.ready();

        const migrate = await app.inject({
            method: "POST",
            url: "/v1/account/encryption/migrate",
            headers: { "content-type": "application/json", "x-test-user-id": account.id },
            payload: {
                toMode: "plain",
                expectedSettingsVersion: 0,
                settingsContent: { t: "plain", v: { schemaVersion: 2, pushEnabled: true } },
                connectedServices: { action: "assert_empty" },
                automations: { action: "assert_empty" },
            },
        });

        expect(migrate.statusCode).toBe(200);
        expect(migrate.json()).toMatchObject({ success: true, mode: "plain", settingsVersion: 1 });

        const storedAccount = await db.account.findUnique({
            where: { id: account.id },
            select: { encryptionMode: true, settingsVersion: true, settings: true, publicKey: true },
        });
        expect(storedAccount?.encryptionMode).toBe("plain");
        expect(storedAccount?.settingsVersion).toBe(1);
        expect(storedAccount?.publicKey).toBe(publicKeyHex);
        expect(typeof storedAccount?.settings).toBe("string");
        const wrapper = JSON.parse(storedAccount?.settings ?? "{}") as any;
        expect(wrapper?.t).toBe("sealed_v1");

        const getV2 = await app.inject({
            method: "GET",
            url: "/v2/account/settings",
            headers: { "x-test-user-id": account.id },
        });
        expect(getV2.statusCode).toBe(200);
        expect(getV2.json()).toMatchObject({
            version: 1,
            content: { t: "plain", v: expect.objectContaining({ schemaVersion: 2, pushEnabled: true }) },
        });

        await app.close();
    });

    it("does not allow rotating the account signing key across encryption-mode toggles", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
        });

        const kp1 = tweetnacl.sign.keyPair();
        const kp2 = tweetnacl.sign.keyPair();
        const publicKeyHex1 = privacyKit.encodeHex(new Uint8Array(kp1.publicKey));
        const originalContentBinding =
            createSignedContentKeyBinding(new Uint8Array(kp1.secretKey));

        const account = await db.account.create({
            data: {
                publicKey: publicKeyHex1,
                contentPublicKey:
                    originalContentBinding.contentPublicKeyBytes,
                contentPublicKeySig:
                    originalContentBinding.contentPublicKeySigBytes,
                encryptionMode: "e2ee",
                settings: "ciphertext",
                settingsVersion: 0,
            },
            select: { id: true },
        });

        const app = createTestApp();
        registerAccountEncryptionMigrateRoutes(app as any);
        await app.ready();

        const toPlain = await app.inject({
            method: "POST",
            url: "/v1/account/encryption/migrate",
            headers: { "content-type": "application/json", "x-test-user-id": account.id },
            payload: {
                toMode: "plain",
                expectedSettingsVersion: 0,
                settingsContent: { t: "plain", v: { schemaVersion: 2 } },
                connectedServices: { action: "assert_empty" },
                automations: { action: "assert_empty" },
            },
        });
        expect(toPlain.statusCode).toBe(200);

        const storedAfterPlain = await db.account.findUnique({
            where: { id: account.id },
            select: { encryptionMode: true, publicKey: true, settingsVersion: true },
        });
        expect(storedAfterPlain?.encryptionMode).toBe("plain");
        expect(storedAfterPlain?.publicKey).toBe(publicKeyHex1);
        expect(storedAfterPlain?.settingsVersion).toBe(1);

        const challenge2 = Uint8Array.from(crypto.getRandomValues(new Uint8Array(32)));
        const signature2 = Uint8Array.from(tweetnacl.sign.detached(challenge2, Uint8Array.from(kp2.secretKey)));
        const mismatchedContentBinding =
            createSignedContentKeyBinding(new Uint8Array(kp2.secretKey));
        const mismatchedKey = await app.inject({
            method: "POST",
            url: "/v1/account/encryption/migrate",
            headers: { "content-type": "application/json", "x-test-user-id": account.id },
            payload: {
                toMode: "e2ee",
                expectedSettingsVersion: 1,
                settingsContent: { t: "encrypted", c: "settings-ciphertext" },
                connectedServices: { action: "assert_empty" },
                automations: { action: "assert_empty" },
                keyProof: {
                    publicKey: privacyKit.encodeBase64(new Uint8Array(kp2.publicKey)),
                    challenge: privacyKit.encodeBase64(challenge2),
                    signature: privacyKit.encodeBase64(signature2),
                    contentPublicKey: mismatchedContentBinding.contentPublicKey,
                    contentPublicKeySig:
                        mismatchedContentBinding.contentPublicKeySig,
                },
            },
        });
        expect(mismatchedKey.statusCode).toBe(400);
        expect(mismatchedKey.json()).toEqual({ error: "invalid-params", reason: "restore_required" });

        const challenge1 = Uint8Array.from(crypto.getRandomValues(new Uint8Array(32)));
        const signature1 = Uint8Array.from(tweetnacl.sign.detached(challenge1, Uint8Array.from(kp1.secretKey)));
        const correctContentBinding =
            createSignedContentKeyBinding(new Uint8Array(kp1.secretKey));
        const correctKey = await app.inject({
            method: "POST",
            url: "/v1/account/encryption/migrate",
            headers: { "content-type": "application/json", "x-test-user-id": account.id },
            payload: {
                toMode: "e2ee",
                expectedSettingsVersion: 1,
                settingsContent: { t: "encrypted", c: "settings-ciphertext" },
                connectedServices: { action: "assert_empty" },
                automations: { action: "assert_empty" },
                keyProof: {
                    publicKey: privacyKit.encodeBase64(new Uint8Array(kp1.publicKey)),
                    challenge: privacyKit.encodeBase64(challenge1),
                    signature: privacyKit.encodeBase64(signature1),
                    contentPublicKey: correctContentBinding.contentPublicKey,
                    contentPublicKeySig:
                        correctContentBinding.contentPublicKeySig,
                },
            },
        });
        expect(correctKey.statusCode).toBe(200);
        expect(correctKey.json()).toMatchObject({ success: true, mode: "e2ee", settingsVersion: 2 });

        const storedAfterE2ee = await db.account.findUnique({
            where: { id: account.id },
            select: {
                encryptionMode: true,
                publicKey: true,
                contentPublicKey: true,
                contentPublicKeySig: true,
                settings: true,
                settingsVersion: true,
            },
        });
        expect(storedAfterE2ee?.encryptionMode).toBe("e2ee");
        expect(storedAfterE2ee?.publicKey).toBe(publicKeyHex1);
        expect(storedAfterE2ee?.settings).toBe("settings-ciphertext");
        expect(storedAfterE2ee?.settingsVersion).toBe(2);
        expect(storedAfterE2ee?.contentPublicKey).toEqual(
            correctContentBinding.contentPublicKeyBytes,
        );
        expect(storedAfterE2ee?.contentPublicKeySig).toEqual(
            correctContentBinding.contentPublicKeySigBytes,
        );
        expect(storedAfterE2ee?.contentPublicKey).not.toEqual(
            originalContentBinding.contentPublicKeyBytes,
        );

        await app.close();
    });

    it("does not replace the Account content key when a later migration validation fails", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
        });
        const signing = tweetnacl.sign.keyPair();
        const originalContentBinding =
            createSignedContentKeyBinding(new Uint8Array(signing.secretKey));
        const replacementContentBinding =
            createSignedContentKeyBinding(new Uint8Array(signing.secretKey));
        const account = await db.account.create({
            data: {
                publicKey: privacyKit.encodeHex(
                    new Uint8Array(signing.publicKey),
                ),
                contentPublicKey:
                    originalContentBinding.contentPublicKeyBytes,
                contentPublicKeySig:
                    originalContentBinding.contentPublicKeySigBytes,
                encryptionMode: "e2ee",
                settings: "original-settings",
                settingsVersion: 0,
            },
            select: { id: true, updatedAt: true },
        });
        await db.automation.create({
            data: {
                accountId: account.id,
                name: "blocks key replacement",
                scheduleKind: "interval",
                everyMs: 60_000,
                timezone: null,
                scheduleExpr: null,
                targetType: "new_session",
                templateCiphertext: JSON.stringify({
                    kind: "happier_automation_template_encrypted_v1",
                    payloadCiphertext: "original-template",
                }),
            },
        });
        const challenge = crypto.getRandomValues(new Uint8Array(32));
        const signature = tweetnacl.sign.detached(
            challenge,
            signing.secretKey,
        );

        const app = createTestApp();
        registerAccountEncryptionMigrateRoutes(app as any);
        await app.ready();
        const response = await app.inject({
            method: "POST",
            url: "/v1/account/encryption/migrate",
            headers: {
                "content-type": "application/json",
                "x-test-user-id": account.id,
            },
            payload: {
                toMode: "e2ee",
                expectedSettingsVersion: 0,
                settingsContent: {
                    t: "encrypted",
                    c: "replacement-settings",
                },
                connectedServices: { action: "assert_empty" },
                automations: { action: "assert_empty" },
                keyProof: {
                    publicKey: privacyKit.encodeBase64(
                        new Uint8Array(signing.publicKey),
                    ),
                    challenge: privacyKit.encodeBase64(challenge),
                    signature: privacyKit.encodeBase64(
                        new Uint8Array(signature),
                    ),
                    contentPublicKey:
                        replacementContentBinding.contentPublicKey,
                    contentPublicKeySig:
                        replacementContentBinding.contentPublicKeySig,
                },
            },
        });

        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({
            error: "automations_not_empty",
        });
        await expect(db.account.findUniqueOrThrow({
            where: { id: account.id },
            select: {
                contentPublicKey: true,
                contentPublicKeySig: true,
                encryptionMode: true,
                settings: true,
                settingsVersion: true,
                updatedAt: true,
            },
        })).resolves.toEqual({
            contentPublicKey:
                originalContentBinding.contentPublicKeyBytes,
            contentPublicKeySig:
                originalContentBinding.contentPublicKeySigBytes,
            encryptionMode: "e2ee",
            settings: "original-settings",
            settingsVersion: 0,
            updatedAt: account.updatedAt,
        });
        await app.close();
    });

    it("migrates plain -> e2ee atomically and requires keyProof", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
        });

        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain", settings: null, settingsVersion: 0 },
            select: { id: true },
        });

        const automation = await db.automation.create({
            data: {
                accountId: account.id,
                name: "a1",
                scheduleKind: "interval",
                everyMs: 60_000,
                timezone: null,
                scheduleExpr: null,
                targetType: "new_session",
                templateCiphertext: JSON.stringify({ kind: "happier_automation_template_plain_v1", payload: { v: 1 } }),
            },
            select: { id: true },
        });

        await db.serviceAccountToken.create({
            data: {
                accountId: account.id,
                vendor: "openai-codex",
                profileId: "work",
                ...createLegacyCredentialFixtureIdentity({
                    serviceId: "openai-codex",
                    profileId: "work",
                }),
                token: new TextEncoder().encode("{\"kind\":\"oauth\"}"),
                refreshLeaseOwnerMachineId: "stale-daemon:e2ee-migration",
                refreshLeaseExpiresAt: new Date(Date.now() + 60_000),
            },
        });

        const app = createTestApp();
        registerAccountEncryptionMigrateRoutes(app as any);
        await app.ready();

        const missingProof = await app.inject({
            method: "POST",
            url: "/v1/account/encryption/migrate",
            headers: { "content-type": "application/json", "x-test-user-id": account.id },
            payload: {
                toMode: "e2ee",
                expectedSettingsVersion: 0,
                settingsContent: { t: "encrypted", c: "settings-ciphertext" },
                connectedServices: { action: "assert_empty" },
                automations: { action: "assert_empty" },
            },
        });
        expect(missingProof.statusCode).toBe(400);
        expect(missingProof.json()).toEqual({ error: "invalid-params" });

        const kp = tweetnacl.sign.keyPair();
        const publicKey = Uint8Array.from(kp.publicKey);
        const secretKey = Uint8Array.from(kp.secretKey);
        const challenge = Uint8Array.from(crypto.getRandomValues(new Uint8Array(32)));
        const signature = Uint8Array.from(tweetnacl.sign.detached(challenge, secretKey));
        const contentBinding = createSignedContentKeyBinding(secretKey);

        const encryptedTemplateCiphertext = JSON.stringify({
            kind: "happier_automation_template_encrypted_v1",
            payloadCiphertext: "tpl-ciphertext",
        });

        const res = await app.inject({
            method: "POST",
            url: "/v1/account/encryption/migrate",
            headers: { "content-type": "application/json", "x-test-user-id": account.id },
            payload: {
                toMode: "e2ee",
                expectedSettingsVersion: 0,
                settingsContent: { t: "encrypted", c: "settings-ciphertext" },
                connectedServices: {
                    action: "migrate",
                    credentials: [
                        {
                            serviceId: "openai-codex",
                            profileId: "work",
                            kind: "sealed",
                            sealed: { format: "account_scoped_v1", ciphertext: "cred-ciphertext" },
                            metadata: { kind: "oauth", providerEmail: "x@example.com", providerAccountId: "acct", expiresAt: null },
                        },
                    ],
                },
                automations: {
                    action: "migrate",
                    templates: [{ automationId: automation.id, templateCiphertext: encryptedTemplateCiphertext }],
                },
                keyProof: {
                    publicKey: privacyKit.encodeBase64(publicKey),
                    challenge: privacyKit.encodeBase64(challenge),
                    signature: privacyKit.encodeBase64(signature),
                    contentPublicKey: contentBinding.contentPublicKey,
                    contentPublicKeySig: contentBinding.contentPublicKeySig,
                },
            },
        });

        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({ success: true, mode: "e2ee", settingsVersion: 1 });

        const storedAccount = await db.account.findUnique({
            where: { id: account.id },
            select: {
                encryptionMode: true,
                publicKey: true,
                contentPublicKey: true,
                contentPublicKeySig: true,
                settings: true,
                settingsVersion: true,
            },
        });
        expect(storedAccount?.encryptionMode).toBe("e2ee");
        expect(storedAccount?.settingsVersion).toBe(1);
        expect(storedAccount?.settings).toBe("settings-ciphertext");
        expect(typeof storedAccount?.publicKey).toBe("string");
        expect((storedAccount?.publicKey ?? "").length).toBeGreaterThan(0);
        expect(storedAccount?.contentPublicKey).toEqual(
            contentBinding.contentPublicKeyBytes,
        );
        expect(storedAccount?.contentPublicKeySig).toEqual(
            contentBinding.contentPublicKeySigBytes,
        );

        const tokenRow = await db.serviceAccountToken.findUnique({
            where: { accountId_vendor_profileId: { accountId: account.id, vendor: "openai-codex", profileId: "work" } },
            select: {
                token: true,
                metadata: true,
                refreshLeaseOwnerMachineId: true,
                refreshLeaseExpiresAt: true,
            },
        });
        expect(tokenRow?.token?.byteLength).toBeGreaterThan(0);
        expect((tokenRow?.metadata as any)?.v).toBe(4);
        expect((tokenRow?.metadata as any)?.storage).toBe("stored_envelope_v1");
        expect((tokenRow?.metadata as any)?.credentialRevision).toEqual(expect.stringMatching(/^csr_/));
        expect(tokenRow?.refreshLeaseOwnerMachineId).toBeNull();
        expect(tokenRow?.refreshLeaseExpiresAt).toBeNull();

        const stalePlainWrite = await mutateConnectedServiceCredential({
            accountId: account.id,
            serviceId: "openai-codex",
            profileId: "work",
            token: new TextEncoder().encode("stale-plain-write"),
            metadata: { v: 3, storage: "plain_json_v1", kind: "oauth", providerEmail: "x@example.com", providerAccountId: "acct" },
            expiresAt: null,
            storageMode: "plain",
            incomingIdentity: { providerEmail: "x@example.com", providerAccountId: "acct" },
            allowProviderIdentityChange: false,
        });
        expect(stalePlainWrite).toEqual({ status: "storage_mode_mismatch" });
        await expect(db.serviceAccountToken.findUnique({
            where: { accountId_vendor_profileId: { accountId: account.id, vendor: "openai-codex", profileId: "work" } },
            select: { token: true },
        })).resolves.toEqual({ token: tokenRow?.token });

        expect(emitUpdate).toHaveBeenCalledWith(expect.objectContaining({
            userId: account.id,
            payload: expect.objectContaining({
                body: expect.objectContaining({ t: "update-account", connectedServicesV2: expect.any(Array) }),
            }),
            recipientFilter: { type: "user-scoped-only" },
        }));

        const updatedAutomation = await db.automation.findUnique({
            where: { id: automation.id },
            select: { templateCiphertext: true },
        });
        expect(updatedAutomation?.templateCiphertext).toBe(encryptedTemplateCiphertext);

        await app.close();
    });

    it("rejects automation migration templates outside the authenticated account", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
        });

        const account = await db.account.create({
            data: { publicKey: "pk-owned-automation-migration", encryptionMode: "e2ee", settings: "owned-settings", settingsVersion: 0 },
            select: { id: true },
        });
        const otherAccount = await db.account.create({
            data: { publicKey: "pk-foreign-automation-migration", encryptionMode: "e2ee", settings: "foreign-settings", settingsVersion: 0 },
            select: { id: true },
        });
        const ownedTemplateCiphertext = JSON.stringify({
            kind: "happier_automation_template_encrypted_v1",
            payloadCiphertext: "owned-original",
        });
        const foreignTemplateCiphertext = JSON.stringify({
            kind: "happier_automation_template_encrypted_v1",
            payloadCiphertext: "foreign-original",
        });
        const ownedAutomation = await db.automation.create({
            data: {
                accountId: account.id,
                name: "owned automation migration",
                scheduleKind: "interval",
                everyMs: 60_000,
                timezone: null,
                scheduleExpr: null,
                targetType: "new_session",
                templateCiphertext: ownedTemplateCiphertext,
            },
            select: { id: true },
        });
        const foreignAutomation = await db.automation.create({
            data: {
                accountId: otherAccount.id,
                name: "foreign automation migration",
                scheduleKind: "interval",
                everyMs: 60_000,
                timezone: null,
                scheduleExpr: null,
                targetType: "new_session",
                templateCiphertext: foreignTemplateCiphertext,
            },
            select: { id: true },
        });

        const plainTemplate = JSON.stringify({
            kind: "happier_automation_template_plain_v1",
            payload: { v: 1, name: "foreign overwrite attempt" },
        });

        const app = createTestApp();
        registerAccountEncryptionMigrateRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v1/account/encryption/migrate",
            headers: { "content-type": "application/json", "x-test-user-id": account.id },
            payload: {
                toMode: "plain",
                expectedSettingsVersion: 0,
                settingsContent: { t: "plain", v: { schemaVersion: 2 } },
                connectedServices: { action: "assert_empty" },
                automations: {
                    action: "migrate",
                    templates: [{ automationId: foreignAutomation.id, templateCiphertext: plainTemplate }],
                },
            },
        });

        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ error: "automations_not_empty" });
        await expect(db.automation.findUnique({
            where: { id: ownedAutomation.id },
            select: { accountId: true, templateCiphertext: true },
        })).resolves.toEqual({ accountId: account.id, templateCiphertext: ownedTemplateCiphertext });
        await expect(db.automation.findUnique({
            where: { id: foreignAutomation.id },
            select: { accountId: true, templateCiphertext: true },
        })).resolves.toEqual({ accountId: otherAccount.id, templateCiphertext: foreignTemplateCiphertext });
        await expect(db.account.findUnique({
            where: { id: account.id },
            select: { encryptionMode: true, settingsVersion: true, settings: true },
        })).resolves.toEqual({ encryptionMode: "e2ee", settingsVersion: 0, settings: "owned-settings" });

        await app.close();
    });

    it("rejects duplicate automation migration ids without rewriting templates", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
        });

        const account = await db.account.create({
            data: { publicKey: "pk-duplicate-automation-migration", encryptionMode: "e2ee", settings: "ciphertext", settingsVersion: 0 },
            select: { id: true },
        });
        const originalTemplateCiphertext = JSON.stringify({
            kind: "happier_automation_template_encrypted_v1",
            payloadCiphertext: "original",
        });
        const automation = await db.automation.create({
            data: {
                accountId: account.id,
                name: "duplicate automation migration",
                scheduleKind: "interval",
                everyMs: 60_000,
                timezone: null,
                scheduleExpr: null,
                targetType: "new_session",
                templateCiphertext: originalTemplateCiphertext,
            },
            select: { id: true },
        });

        const plainTemplateOne = JSON.stringify({
            kind: "happier_automation_template_plain_v1",
            payload: { v: 1, name: "first" },
        });
        const plainTemplateTwo = JSON.stringify({
            kind: "happier_automation_template_plain_v1",
            payload: { v: 1, name: "second" },
        });

        const app = createTestApp();
        registerAccountEncryptionMigrateRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v1/account/encryption/migrate",
            headers: { "content-type": "application/json", "x-test-user-id": account.id },
            payload: {
                toMode: "plain",
                expectedSettingsVersion: 0,
                settingsContent: { t: "plain", v: { schemaVersion: 2 } },
                connectedServices: { action: "assert_empty" },
                automations: {
                    action: "migrate",
                    templates: [
                        { automationId: automation.id, templateCiphertext: plainTemplateOne },
                        { automationId: automation.id, templateCiphertext: plainTemplateTwo },
                    ],
                },
            },
        });

        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ error: "automations_not_empty" });
        await expect(db.automation.findUnique({
            where: { id: automation.id },
            select: { templateCiphertext: true },
        })).resolves.toEqual({ templateCiphertext: originalTemplateCiphertext });

        await app.close();
    });

    it("rejects a stale plain automation template update after a plain-to-e2ee migration commits", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
        });
        const kp = tweetnacl.sign.keyPair();
        const publicKey = Uint8Array.from(kp.publicKey);
        const challenge = Uint8Array.from(crypto.getRandomValues(new Uint8Array(32)));
        const signature = Uint8Array.from(tweetnacl.sign.detached(challenge, Uint8Array.from(kp.secretKey)));
        const contentBinding =
            createSignedContentKeyBinding(new Uint8Array(kp.secretKey));
        const account = await db.account.create({
            data: {
                publicKey: privacyKit.encodeHex(publicKey),
                encryptionMode: "plain",
                settings: null,
                settingsVersion: 0,
            },
            select: { id: true },
        });
        const initialPlainTemplate = JSON.stringify({
            kind: "happier_automation_template_plain_v1",
            payload: { prompt: "initial" },
        });
        const stalePlainTemplate = JSON.stringify({
            kind: "happier_automation_template_plain_v1",
            payload: { prompt: "stale update" },
        });
        const migratedEncryptedTemplate = JSON.stringify({
            kind: "happier_automation_template_encrypted_v1",
            payloadCiphertext: "migrated-ciphertext",
        });
        const automation = await db.automation.create({
            data: {
                accountId: account.id,
                name: "Migration race",
                enabled: false,
                scheduleKind: "interval",
                everyMs: 60_000,
                timezone: null,
                scheduleExpr: null,
                targetType: "new_session",
                templateCiphertext: initialPlainTemplate,
            },
            select: { id: true },
        });

        const app = createTestApp();
        registerAccountEncryptionMigrateRoutes(app as any);
        registerAutomationCrudRoutes(app as any);
        await app.ready();
        const barrier = installAccountModeReadBarrier(account.id);
        try {
            const automationPatch = app.inject({
                method: "PATCH",
                url: `/v2/automations/${automation.id}`,
                headers: { "content-type": "application/json", "x-test-user-id": account.id },
                payload: { templateCiphertext: stalePlainTemplate },
            });
            await barrier.modeObserved;

            const migration = await app.inject({
                method: "POST",
                url: "/v1/account/encryption/migrate",
                headers: { "content-type": "application/json", "x-test-user-id": account.id },
                payload: {
                    toMode: "e2ee",
                    expectedSettingsVersion: 0,
                    settingsContent: { t: "encrypted", c: "settings-ciphertext" },
                    connectedServices: { action: "assert_empty" },
                    automations: {
                        action: "migrate",
                        templates: [{ automationId: automation.id, templateCiphertext: migratedEncryptedTemplate }],
                    },
                    keyProof: {
                        publicKey: privacyKit.encodeBase64(publicKey),
                        challenge: privacyKit.encodeBase64(challenge),
                        signature: privacyKit.encodeBase64(signature),
                        contentPublicKey: contentBinding.contentPublicKey,
                        contentPublicKeySig: contentBinding.contentPublicKeySig,
                    },
                },
            });
            expect(migration.statusCode).toBe(200);

            barrier.release();
            const patchResult = await automationPatch;
            expect(patchResult.statusCode).toBe(400);
            expect(patchResult.json()).toEqual({
                error: "templateCiphertext: expected encrypted template envelope",
            });
        } finally {
            barrier.restore();
            await app.close();
        }

        await expect(db.account.findUniqueOrThrow({
            where: { id: account.id },
            select: { encryptionMode: true },
        })).resolves.toEqual({ encryptionMode: "e2ee" });
        await expect(db.automation.findUniqueOrThrow({
            where: { id: automation.id },
            select: { templateCiphertext: true },
        })).resolves.toEqual({ templateCiphertext: migratedEncryptedTemplate });
    });

    it("rolls back credential rewrites when a later automation migration fails", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });
        const account = await db.account.create({
            data: { publicKey: "pk-mode-rollback", encryptionMode: "e2ee", settings: "ciphertext", settingsVersion: 0 },
            select: { id: true },
        });
        const previousRevision = "csr_AAAAAAAAAAAAAAAAAAAAAA";
        await db.serviceAccountToken.create({
            data: {
                accountId: account.id, vendor: "anthropic", profileId: "default",
                ...createLegacyCredentialFixtureIdentity({
                    serviceId: "anthropic",
                    profileId: "default",
                }),
                token: new TextEncoder().encode("sealed-before-rollback"),
                metadata: { v: 2, format: "account_scoped_v1", kind: "token", credentialRevision: previousRevision },
                refreshLeaseOwnerMachineId: "stale-daemon:rollback",
                refreshLeaseExpiresAt: new Date(Date.now() + 60_000),
            },
        });
        const automation = await db.automation.create({
            data: {
                accountId: account.id, name: "rollback automation", scheduleKind: "interval", everyMs: 60_000,
                timezone: null, scheduleExpr: null, targetType: "new_session",
                templateCiphertext: JSON.stringify({ kind: "happier_automation_template_encrypted_v1", payloadCiphertext: "before" }),
            },
            select: { id: true },
        });
        const app = createTestApp();
        registerAccountEncryptionMigrateRoutes(app as any);
        await app.ready();
        const res = await app.inject({
            method: "POST", url: "/v1/account/encryption/migrate",
            headers: { "content-type": "application/json", "x-test-user-id": account.id },
            payload: {
                toMode: "plain", expectedSettingsVersion: 0,
                settingsContent: { t: "plain", v: { schemaVersion: 2 } },
                connectedServices: { action: "migrate", credentials: [{
                    serviceId: "anthropic", profileId: "default", kind: "plain",
                    record: {
                        v: 1, serviceId: "anthropic", profileId: "default", createdAt: 1, updatedAt: 2,
                        expiresAt: null, kind: "token", oauth: null,
                        token: { token: "plain-should-rollback", providerAccountId: null, providerEmail: null, raw: null },
                    },
                }] },
                automations: { action: "migrate", templates: [{ automationId: automation.id, templateCiphertext: "invalid-template" }] },
            },
        });
        expect(res.statusCode).toBe(400);
        await expect(db.account.findUnique({ where: { id: account.id }, select: { encryptionMode: true, settingsVersion: true, settings: true } }))
            .resolves.toEqual({ encryptionMode: "e2ee", settingsVersion: 0, settings: "ciphertext" });
        const credential = await db.serviceAccountToken.findUnique({
            where: { accountId_vendor_profileId: { accountId: account.id, vendor: "anthropic", profileId: "default" } },
            select: { token: true, metadata: true, refreshLeaseOwnerMachineId: true, refreshLeaseExpiresAt: true },
        });
        expect(new TextDecoder().decode(credential?.token)).toBe("sealed-before-rollback");
        expect(credential?.metadata).toEqual(expect.objectContaining({ credentialRevision: previousRevision }));
        expect(credential?.refreshLeaseOwnerMachineId).toBe("stale-daemon:rollback");
        expect(credential?.refreshLeaseExpiresAt).not.toBeNull();
        await app.close();
    });

    it("does not rewrite an earlier credential when a later credential has the wrong target mode", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });
        const account = await db.account.create({
            data: { publicKey: "pk-credential-mode-rollback", encryptionMode: "e2ee", settings: "ciphertext", settingsVersion: 0 },
            select: { id: true },
        });
        const previousRevision = "csr_AAAAAAAAAAAAAAAAAAAAAA";
        for (const profileId of ["default", "work"] as const) {
            await db.serviceAccountToken.create({
                data: {
                    accountId: account.id,
                    vendor: "anthropic",
                    profileId,
                    ...createLegacyCredentialFixtureIdentity({
                        serviceId: "anthropic",
                        profileId,
                    }),
                    token: new TextEncoder().encode(`sealed-${profileId}-before-rollback`),
                    metadata: { v: 2, format: "account_scoped_v1", kind: "token", credentialRevision: previousRevision },
                    refreshLeaseOwnerMachineId: `stale-daemon:${profileId}`,
                    refreshLeaseExpiresAt: new Date(Date.now() + 60_000),
                },
            });
        }

        const app = createTestApp();
        registerAccountEncryptionMigrateRoutes(app as any);
        await app.ready();
        const res = await app.inject({
            method: "POST",
            url: "/v1/account/encryption/migrate",
            headers: { "content-type": "application/json", "x-test-user-id": account.id },
            payload: {
                toMode: "plain",
                expectedSettingsVersion: 0,
                settingsContent: { t: "plain", v: { schemaVersion: 2 } },
                connectedServices: {
                    action: "migrate",
                    credentials: [
                        {
                            serviceId: "anthropic",
                            profileId: "default",
                            kind: "plain",
                            record: {
                                v: 1,
                                serviceId: "anthropic",
                                profileId: "default",
                                createdAt: 1,
                                updatedAt: 2,
                                expiresAt: null,
                                kind: "token",
                                oauth: null,
                                token: { token: "plain-should-rollback", providerAccountId: null, providerEmail: null, raw: null },
                            },
                        },
                        {
                            serviceId: "anthropic",
                            profileId: "work",
                            kind: "sealed",
                            sealed: { format: "account_scoped_v1", ciphertext: "wrong-mode-late" },
                        },
                    ],
                },
                automations: { action: "assert_empty" },
            },
        });

        expect(res.statusCode).toBe(400);
        await expect(db.account.findUnique({
            where: { id: account.id },
            select: { encryptionMode: true, settingsVersion: true, settings: true },
        })).resolves.toEqual({ encryptionMode: "e2ee", settingsVersion: 0, settings: "ciphertext" });
        for (const profileId of ["default", "work"] as const) {
            const credential = await db.serviceAccountToken.findUnique({
                where: { accountId_vendor_profileId: { accountId: account.id, vendor: "anthropic", profileId } },
                select: { token: true, metadata: true, refreshLeaseOwnerMachineId: true, refreshLeaseExpiresAt: true },
            });
            expect(new TextDecoder().decode(credential?.token)).toBe(`sealed-${profileId}-before-rollback`);
            expect(credential?.metadata).toEqual(expect.objectContaining({ credentialRevision: previousRevision }));
            expect(credential?.refreshLeaseOwnerMachineId).toBe(`stale-daemon:${profileId}`);
            expect(credential?.refreshLeaseExpiresAt).not.toBeNull();
        }

        await app.close();
    });

    it("does not let another Account's split Session block or join a migration", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
        });
        const accountAFixture =
            await createAccountMigrationSessionGuardFixture({
                archivedAt: null,
                metadataLayoutVersion: 0,
            });
        const accountBFixture =
            await createAccountMigrationSessionGuardFixture({
                archivedAt: null,
                metadataLayoutVersion: 1,
            });
        const accountBBefore = await db.account.findUniqueOrThrow({
            where: { id: accountBFixture.account.id },
        });
        const accountBTokenBefore =
            await db.serviceAccountToken.findFirstOrThrow({
                where: { accountId: accountBFixture.account.id },
            });
        const accountBAutomationBefore = await db.automation.findUniqueOrThrow({
            where: { id: accountBFixture.automation.id },
        });

        const app = createTestApp();
        registerAccountEncryptionMigrateRoutes(app as any);
        await app.ready();

        try {
            const successResponse = await app.inject({
                method: "POST",
                url: "/v1/account/encryption/migrate",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": accountAFixture.account.id,
                },
                payload: {
                    toMode: "plain",
                    expectedSettingsVersion: 0,
                    settingsContent: { t: "plain", v: { schemaVersion: 2 } },
                    connectedServices: { action: "clear" },
                    automations: { action: "clear" },
                },
            });

            expect(successResponse.statusCode, successResponse.body).toBe(200);
            expect(successResponse.json()).toMatchObject({
                success: true,
                mode: "plain",
                settingsVersion: 1,
            });
            await expect(db.session.findUnique({
                where: { id: accountAFixture.session.id },
                select: {
                    id: true,
                    metadata: true,
                    metadataVersion: true,
                    metadataLayoutVersion: true,
                    ownerMetadata: true,
                    agentState: true,
                    agentStateVersion: true,
                    archivedAt: true,
                },
            })).resolves.toEqual(accountAFixture.session);

            await expect(db.account.findUniqueOrThrow({
                where: { id: accountBFixture.account.id },
            })).resolves.toEqual(accountBBefore);
            await expect(db.serviceAccountToken.findFirstOrThrow({
                where: { accountId: accountBFixture.account.id },
            })).resolves.toEqual(accountBTokenBefore);
            await expect(db.automation.findUniqueOrThrow({
                where: { id: accountBFixture.automation.id },
            })).resolves.toEqual(accountBAutomationBefore);
            await expect(db.session.findUnique({
                where: { id: accountBFixture.session.id },
                select: {
                    id: true,
                    metadata: true,
                    metadataVersion: true,
                    metadataLayoutVersion: true,
                    ownerMetadata: true,
                    agentState: true,
                    agentStateVersion: true,
                    archivedAt: true,
                },
            })).resolves.toEqual(accountBFixture.session);
            await expect(db.accountChange.count({
                where: { accountId: accountBFixture.account.id },
            })).resolves.toBe(0);
        } finally {
            await app.close();
        }
    });

    it("refuses an Account migration when an active layout-1 Session requires owner-metadata reseal", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
        });
        const fixture = await createAccountMigrationSessionGuardFixture({
            archivedAt: null,
            metadataLayoutVersion: 1,
        });
        const app = createTestApp();
        registerAccountEncryptionMigrateRoutes(app as any);
        await app.ready();

        try {
            const response = await app.inject({
                method: "POST",
                url: "/v1/account/encryption/migrate",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": fixture.account.id,
                },
                payload: {
                    toMode: "plain",
                    expectedSettingsVersion: 0,
                    settingsContent: { t: "plain", v: { schemaVersion: 2 } },
                    connectedServices: { action: "clear" },
                    automations: { action: "clear" },
                },
            });

            expect(response.statusCode, response.body).toBe(400);
            expect(response.json()).toEqual({
                error: "metadata_privacy_upgrade_required",
            });
            await expect(db.account.findUnique({
                where: { id: fixture.account.id },
                select: {
                    encryptionMode: true,
                    settings: true,
                    settingsVersion: true,
                },
            })).resolves.toEqual({
                encryptionMode: "e2ee",
                settings: "ciphertext",
                settingsVersion: 0,
            });
            await expect(db.serviceAccountToken.count({
                where: { accountId: fixture.account.id },
            })).resolves.toBe(1);
            await expect(db.automation.findUnique({
                where: { id: fixture.automation.id },
                select: { templateCiphertext: true },
            })).resolves.toEqual({
                templateCiphertext: "automation-before-migration",
            });
            await expect(db.session.findUnique({
                where: { id: fixture.session.id },
                select: {
                    id: true,
                    metadata: true,
                    metadataVersion: true,
                    metadataLayoutVersion: true,
                    ownerMetadata: true,
                    agentState: true,
                    agentStateVersion: true,
                    archivedAt: true,
                },
            })).resolves.toEqual(fixture.session);
            await expect(db.accountChange.count({
                where: { accountId: fixture.account.id },
            })).resolves.toBe(0);
            expect(emitUpdate).not.toHaveBeenCalled();
        } finally {
            await app.close();
        }
    });

    it("refuses an Account migration when an archived layout-1 Session requires owner-metadata reseal", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
        });
        const fixture = await createAccountMigrationSessionGuardFixture({
            archivedAt: new Date(1_700_000_000_000),
            metadataLayoutVersion: 1,
        });
        const app = createTestApp();
        registerAccountEncryptionMigrateRoutes(app as any);
        await app.ready();

        try {
            const response = await app.inject({
                method: "POST",
                url: "/v1/account/encryption/migrate",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": fixture.account.id,
                },
                payload: {
                    toMode: "plain",
                    expectedSettingsVersion: 0,
                    settingsContent: { t: "plain", v: { schemaVersion: 2 } },
                    connectedServices: { action: "clear" },
                    automations: { action: "clear" },
                },
            });

            expect(response.statusCode, response.body).toBe(400);
            expect(response.json()).toEqual({
                error: "metadata_privacy_upgrade_required",
            });
            await expect(db.account.findUnique({
                where: { id: fixture.account.id },
                select: {
                    encryptionMode: true,
                    settings: true,
                    settingsVersion: true,
                },
            })).resolves.toEqual({
                encryptionMode: "e2ee",
                settings: "ciphertext",
                settingsVersion: 0,
            });
            await expect(db.serviceAccountToken.count({
                where: { accountId: fixture.account.id },
            })).resolves.toBe(1);
            await expect(db.automation.findUnique({
                where: { id: fixture.automation.id },
                select: { templateCiphertext: true },
            })).resolves.toEqual({
                templateCiphertext: "automation-before-migration",
            });
            await expect(db.session.findUnique({
                where: { id: fixture.session.id },
                select: {
                    id: true,
                    metadata: true,
                    metadataVersion: true,
                    metadataLayoutVersion: true,
                    ownerMetadata: true,
                    agentState: true,
                    agentStateVersion: true,
                    archivedAt: true,
                },
            })).resolves.toEqual(fixture.session);
            await expect(db.accountChange.count({
                where: { accountId: fixture.account.id },
            })).resolves.toBe(0);
            expect(emitUpdate).not.toHaveBeenCalled();
        } finally {
            await app.close();
        }
    });

    it("fails closed when an Account owns a future-layout Session", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
        });
        const fixture = await createAccountMigrationSessionGuardFixture({
            archivedAt: null,
            metadataLayoutVersion: 2,
            ownerMetadata: null,
        });
        const app = createTestApp();
        registerAccountEncryptionMigrateRoutes(app as any);
        await app.ready();

        try {
            const response = await app.inject({
                method: "POST",
                url: "/v1/account/encryption/migrate",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": fixture.account.id,
                },
                payload: {
                    toMode: "plain",
                    expectedSettingsVersion: 0,
                    settingsContent: { t: "plain", v: { schemaVersion: 2 } },
                    connectedServices: { action: "clear" },
                    automations: { action: "clear" },
                },
            });

            expect(response.statusCode, response.body).toBe(400);
            expect(response.json()).toEqual({
                error: "metadata_privacy_upgrade_required",
            });
            await expectAccountMigrationGuardRefusalLeavesFixtureUnchanged(
                fixture,
            );
        } finally {
            await app.close();
        }
    });

    it("fails closed when a layout-0 Session has malformed owner metadata", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
        });
        const fixture = await createAccountMigrationSessionGuardFixture({
            archivedAt: null,
            metadataLayoutVersion: 0,
            ownerMetadata: sealOwnerMetadata("malformed-layout-zero"),
        });
        const app = createTestApp();
        registerAccountEncryptionMigrateRoutes(app as any);
        await app.ready();

        try {
            const response = await app.inject({
                method: "POST",
                url: "/v1/account/encryption/migrate",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": fixture.account.id,
                },
                payload: {
                    toMode: "plain",
                    expectedSettingsVersion: 0,
                    settingsContent: { t: "plain", v: { schemaVersion: 2 } },
                    connectedServices: { action: "clear" },
                    automations: { action: "clear" },
                },
            });

            expect(response.statusCode, response.body).toBe(400);
            expect(response.json()).toEqual({
                error: "metadata_privacy_upgrade_required",
            });
            await expectAccountMigrationGuardRefusalLeavesFixtureUnchanged(
                fixture,
            );
        } finally {
            await app.close();
        }
    });

    it("decides the layout-1 refusal after a concurrent Session writer releases the shared Account-first fence", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
        });
        const fixture = await createAccountMigrationSessionGuardFixture({
            archivedAt: null,
            metadataLayoutVersion: 0,
        });
        const writerAcquired = deferred();
        const releaseWriter = deferred();
        const sessionWriter = inTx(async (tx) => {
            await acquireAccountSessionOwnerMetadataFenceInTx(
                tx,
                fixture.account.id,
            );
            await tx.session.update({
                where: { id: fixture.session.id },
                data: {
                    metadataLayoutVersion: 1,
                    ownerMetadata: sealOwnerMetadata("concurrent-owner"),
                },
            });
            writerAcquired.resolve();
            await releaseWriter.promise;
        });

        const app = createTestApp();
        registerAccountEncryptionMigrateRoutes(app as any);
        await app.ready();
        await writerAcquired.promise;
        let migrationSettled = false;
        const migration = (async () => {
            const response = await app.inject({
                method: "POST",
                url: "/v1/account/encryption/migrate",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": fixture.account.id,
                },
                payload: {
                    toMode: "plain",
                    expectedSettingsVersion: 0,
                    settingsContent: { t: "plain", v: { schemaVersion: 2 } },
                    connectedServices: { action: "clear" },
                    automations: { action: "clear" },
                },
            });
            migrationSettled = true;
            return response;
        })();

        try {
            await new Promise((resolve) => setTimeout(resolve, 100));
            expect(migrationSettled).toBe(false);
            releaseWriter.resolve();
            await sessionWriter;

            const response = await migration;
            expect(response.statusCode, response.body).toBe(400);
            expect(response.json()).toEqual({
                error: "metadata_privacy_upgrade_required",
            });
            await expect(db.account.findUnique({
                where: { id: fixture.account.id },
                select: {
                    encryptionMode: true,
                    settings: true,
                    settingsVersion: true,
                },
            })).resolves.toEqual({
                encryptionMode: "e2ee",
                settings: "ciphertext",
                settingsVersion: 0,
            });
            await expect(db.session.findUnique({
                where: { id: fixture.session.id },
                select: {
                    metadataLayoutVersion: true,
                    ownerMetadata: true,
                },
            })).resolves.toEqual({
                metadataLayoutVersion: 1,
                ownerMetadata: sealOwnerMetadata("concurrent-owner"),
            });
            await expect(db.accountChange.count({
                where: { accountId: fixture.account.id },
            })).resolves.toBe(0);
            expect(emitUpdate).not.toHaveBeenCalled();
        } finally {
            releaseWriter.resolve();
            await sessionWriter;
            await app.close();
        }
    }, 30_000);

    it("migrates an Account with layout-0-only Sessions without changing the Session", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
        });
        const fixture = await createAccountMigrationSessionGuardFixture({
            archivedAt: null,
            metadataLayoutVersion: 0,
        });
        const app = createTestApp();
        registerAccountEncryptionMigrateRoutes(app as any);
        await app.ready();

        try {
            const response = await app.inject({
                method: "POST",
                url: "/v1/account/encryption/migrate",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": fixture.account.id,
                },
                payload: {
                    toMode: "plain",
                    expectedSettingsVersion: 0,
                    settingsContent: { t: "plain", v: { schemaVersion: 2 } },
                    connectedServices: { action: "clear" },
                    automations: { action: "clear" },
                },
            });

            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toMatchObject({
                success: true,
                mode: "plain",
                settingsVersion: 1,
            });
            await expect(db.account.findUnique({
                where: { id: fixture.account.id },
                select: {
                    encryptionMode: true,
                    settingsVersion: true,
                },
            })).resolves.toEqual({
                encryptionMode: "plain",
                settingsVersion: 1,
            });
            await expect(db.serviceAccountToken.count({
                where: { accountId: fixture.account.id },
            })).resolves.toBe(0);
            await expect(db.automation.findUnique({
                where: { id: fixture.automation.id },
            })).resolves.toBeNull();
            await expect(db.session.findUnique({
                where: { id: fixture.session.id },
                select: {
                    id: true,
                    metadata: true,
                    metadataVersion: true,
                    metadataLayoutVersion: true,
                    ownerMetadata: true,
                    agentState: true,
                    agentStateVersion: true,
                    archivedAt: true,
                },
            })).resolves.toEqual(fixture.session);
            await expect(db.accountChange.count({
                where: { accountId: fixture.account.id },
            })).resolves.toBeGreaterThan(0);
            expect(emitUpdate).toHaveBeenCalled();
        } finally {
            await app.close();
        }
    });

});
