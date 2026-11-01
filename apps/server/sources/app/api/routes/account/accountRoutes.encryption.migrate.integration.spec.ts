import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";

import { db } from "@/storage/db";
import { updateAccountEncryptionMode } from "./updateAccountEncryptionMode";
import { registerAccountEncryptionMigrateRoutes } from "./registerAccountEncryptionMigrateRoutes";
import { registerAccountSettingsHistoryRoutes } from "./registerAccountSettingsHistoryRoutes";
import { registerAccountSettingsRoutes } from "./registerAccountSettingsRoutes";
import { writeProviderAccountUsageRecordAndLinkConnectedServiceUsageSource } from "../connect/providerAccountUsage";
import {
    createProviderAccountUsageRecordKey,
    createUsageSnapshot,
} from "../connect/providerAccountUsageTestkit";
import { mutateConnectedServiceCredential } from "../connect/credentials/mutation";
import { registerAutomationCrudRoutes } from "../automations/registerAutomationCrudRoutes";
import tweetnacl from "tweetnacl";
import { MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent } from "@happier-dev/protocol";
import * as privacyKit from "privacy-kit";

import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

const { emitUpdate } = vi.hoisted(() => ({
    emitUpdate: vi.fn(),
}));

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
        await db.account.deleteMany().catch(() => {});
    });

    afterAll(async () => {
        await harness.close();
    });

    it("requires complete Machine conversion before enabling e2ee and commits content with the Account mode", async () => {
        harness.resetEnv({ HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional", HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1" });
        const kp = tweetnacl.sign.keyPair();
        const challenge = new Uint8Array([1, 2, 3]);
        const account = await db.account.create({ data: { publicKey: privacyKit.encodeHex(new Uint8Array(kp.publicKey)), encryptionMode: "plain", settingsVersion: 0 } });
        const marker = MACHINE_PLAIN_DATA_KEY_MARKER;
        const machine = await db.machine.create({ data: {
            id: "account-mode-machine", accountId: account.id,
            metadata: encodePlainMachineStoredContent({ displayName: "Retained", extension: { v: 7 } }),
            daemonState: encodePlainMachineStoredContent({ status: "running", extension: [1, 2] }),
            dataEncryptionKey: privacyKit.decodeBase64(marker),
        } });
        const app = createTestApp();
        registerAccountEncryptionMigrateRoutes(app);
        await app.ready();
        const payload = {
            toMode: "e2ee", expectedSettingsVersion: 0, settingsContent: null,
            connectedServices: { action: "assert_empty" }, automations: { action: "assert_empty" },
            keyProof: { publicKey: privacyKit.encodeBase64(new Uint8Array(kp.publicKey)), challenge: privacyKit.encodeBase64(challenge), signature: privacyKit.encodeBase64(new Uint8Array(tweetnacl.sign.detached(challenge, kp.secretKey))) },
        };
        const inject = (body: unknown) => app.inject({ method: "POST", url: "/v1/account/encryption/migrate", headers: { "x-test-user-id": account.id }, payload: body });
        expect(await updateAccountEncryptionMode({ accountId: account.id, mode: "e2ee" })).toEqual({ status: "migration_required" });
        const omitted = await inject(payload);
        expect(omitted.statusCode).toBe(400);
        expect(omitted.json()).toEqual({ error: "machines_require_upgrade" });
        expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).encryptionMode).toBe("plain");
        const item = { machineId: machine.id, expected: { dataEncryptionKey: marker, metadataVersion: machine.metadataVersion, daemonStateVersion: machine.daemonStateVersion }, next: { metadata: "encrypted-metadata", daemonState: "encrypted-state", dataEncryptionKey: null } };
        const incomplete = await inject({ ...payload, machines: { action: "migrate", items: [] } });
        expect(incomplete.statusCode).toBe(400);
        expect(incomplete.json()).toEqual({ error: "machines_migration_incomplete" });
        const stale = await inject({ ...payload, machines: { action: "migrate", items: [{ ...item, expected: { ...item.expected, dataEncryptionKey: null } }] } });
        expect(stale.statusCode).toBe(400);
        expect(stale.json()).toEqual({ error: "machines_migration_incomplete" });
        const wrongEnvelope = await inject({ ...payload, machines: { action: "migrate", items: [{ ...item, next: { ...item.next, metadata: machine.metadata } }] } });
        expect(wrongEnvelope.statusCode).toBe(400);
        expect(wrongEnvelope.json()).toEqual({ error: "invalid-params" });
        expect((await db.machine.findUniqueOrThrow({ where: { id: machine.id } })).metadataVersion).toBe(machine.metadataVersion);
        const migrated = await inject({ ...payload, machines: { action: "migrate", items: [item] } });
        expect(migrated.statusCode).toBe(200);
        expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).encryptionMode).toBe("e2ee");
        expect(await db.machine.findUniqueOrThrow({ where: { id: machine.id } })).toMatchObject({ metadata: "encrypted-metadata", daemonState: "encrypted-state", dataEncryptionKey: null, metadataVersion: machine.metadataVersion + 1, daemonStateVersion: machine.daemonStateVersion + 1 });
        expect(await db.accountChange.findFirst({ where: { accountId: account.id, kind: "machine", entityId: machine.id } })).not.toBeNull();
        expect(emitUpdate).toHaveBeenCalledWith(expect.objectContaining({
            userId: account.id,
            payload: expect.objectContaining({ body: expect.objectContaining({ t: "update-machine", machineId: machine.id, dataEncryptionKey: null }) }),
        }));
        await app.close();
    });

    it("does not create plain Machines through migration when plaintextMachine is denied", async () => {
        harness.resetEnv({ HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional", HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1", HAPPIER_BUILD_FEATURES_DENY: "encryption.plaintextMachine" });
        const account = await db.account.create({ data: { publicKey: "machine-disabled-account", encryptionMode: "e2ee" } });
        const machine = await db.machine.create({ data: { id: "machine-disabled", accountId: account.id, metadata: "opaque", daemonState: null } });
        const app = createTestApp();
        registerAccountEncryptionMigrateRoutes(app);
        await app.ready();
        const res = await app.inject({ method: "POST", url: "/v1/account/encryption/migrate", headers: { "x-test-user-id": account.id }, payload: {
            toMode: "plain", expectedSettingsVersion: 0, settingsContent: null,
            connectedServices: { action: "assert_empty" }, automations: { action: "assert_empty" },
            machines: { action: "migrate", items: [{ machineId: machine.id, expected: { dataEncryptionKey: null, metadataVersion: machine.metadataVersion, daemonStateVersion: machine.daemonStateVersion }, next: { dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, metadata: encodePlainMachineStoredContent({ displayName: "blocked" }), daemonState: null } }] },
        } });
        expect(res.statusCode).toBe(404);
        expect(res.json()).toEqual({ error: "not_found" });
        expect((await db.machine.findUniqueOrThrow({ where: { id: machine.id } })).metadata).toBe("opaque");
        expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).encryptionMode).toBe("e2ee");
        await app.close();
    });

    it("converts encrypted Machines to plain while retaining released omitted-directive behavior", async () => {
        harness.resetEnv({ HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional", HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1" });
        const account = await db.account.create({ data: { publicKey: "machine-legacy-account", encryptionMode: "e2ee" } });
        const machine = await db.machine.create({ data: { id: "machine-legacy-history", accountId: account.id, metadata: "opaque", daemonState: null, revokedAt: new Date() } });
        const app = createTestApp();
        registerAccountEncryptionMigrateRoutes(app);
        await app.ready();
        const payload = { toMode: "plain", expectedSettingsVersion: 0, settingsContent: null, connectedServices: { action: "assert_empty" }, automations: { action: "assert_empty" } };
        const inject = (body: unknown) => app.inject({ method: "POST", url: "/v1/account/encryption/migrate", headers: { "x-test-user-id": account.id }, payload: body });
        expect((await inject(payload)).statusCode).toBe(200);
        expect((await db.machine.findUniqueOrThrow({ where: { id: machine.id } })).metadata).toBe("opaque");
        const next = { dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, metadata: encodePlainMachineStoredContent({ displayName: "retained" }), daemonState: null };
        const migrated = await inject({ ...payload, expectedSettingsVersion: 1, machines: { action: "migrate", items: [{ machineId: machine.id, expected: { dataEncryptionKey: null, metadataVersion: machine.metadataVersion, daemonStateVersion: machine.daemonStateVersion }, next }] } });
        expect(migrated.statusCode).toBe(200);
        expect(await db.machine.findUniqueOrThrow({ where: { id: machine.id } })).toMatchObject({ metadata: next.metadata, metadataVersion: machine.metadataVersion + 1, revokedAt: machine.revokedAt });
        await app.close();
    });

    it("migrates e2ee -> plain atomically and stores v2 settings in plaintext", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_SETTINGS_AT_REST: "none",
        });

        const account = await db.account.create({
            data: { publicKey: "pk-migrate-1", encryptionMode: "e2ee", settings: "ciphertext", settingsVersion: 0 },
            select: { id: true },
        });

        const app = createTestApp();
        registerAccountSettingsRoutes(app as any);
        registerAccountSettingsHistoryRoutes(app as any);
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
                automations: { action: "assert_empty" },
            },
        });

        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({ success: true, mode: "plain" });

        const storedAccount = await db.account.findUnique({
            where: { id: account.id },
            select: { encryptionMode: true, settingsVersion: true, settings: true },
        });
        expect(storedAccount?.encryptionMode).toBe("plain");
        expect(storedAccount?.settingsVersion).toBe(1);
        expect(typeof storedAccount?.settings).toBe("string");
        expect((storedAccount?.settings ?? "").includes("ciphertext")).toBe(false);

        const accountChange = await db.accountChange.findFirst({
            where: { accountId: account.id, kind: "account", entityId: "self" },
            select: { hint: true },
        });
        expect(accountChange?.hint).toEqual({ settingsVersion: 1 });
        expect(emitUpdate).toHaveBeenCalledTimes(1);
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

        const getV2 = await app.inject({
            method: "GET",
            url: "/v2/account/settings",
            headers: { "x-test-user-id": account.id },
        });
        expect(getV2.statusCode).toBe(200);
        expect(getV2.json()).toMatchObject({ version: 1, content: { t: "plain" } });

        await app.close();
    });

    it("removes connected-service usage source links when connected services are cleared during migration", async () => {
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
        await db.serviceAccountToken.create({
            data: {
                accountId: account.id,
                vendor: "openai-codex",
                profileId: "work",
                token: Buffer.from("token:openai-codex:work", "utf8"),
                metadata: { kind: "oauth", providerAccountId: "acct_clear_connected_services" },
            },
        });
        const snapshot = createUsageSnapshot({
            fetchedAt: Date.now(),
            recordKey: createProviderAccountUsageRecordKey({ accountSubjectId: "acct_clear_connected_services" }),
        });
        await writeProviderAccountUsageRecordAndLinkConnectedServiceUsageSource({
            accountId: account.id,
            recordId: snapshot.recordId,
            recordKey: snapshot.recordKey,
            payloadMode: "sealed_account_scoped_v1",
            sealedPayload: { format: "account_scoped_v1", ciphertext: "sealed-usage-before-mode-change" },
            status: "ok",
            fetchedAt: snapshot.fetchedAtMs,
            staleAfterMs: snapshot.staleAfterMs,
            materialFingerprint: "usage:account-clear-source",
            source: {
                serviceId: "openai-codex",
                profileId: "work",
                bindingKind: "profile",
            },
        });

        const app = createTestApp();
        registerAccountSettingsRoutes(app as any);
        registerAccountSettingsHistoryRoutes(app as any);
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
        expect(await db.connectedServiceUsageSource.findFirst({
            where: {
                    accountId: account.id,
                    serviceId: "openai-codex",
                    profileId: "work",
            },
            select: { id: true },
        })).toBeNull();
        expect(await db.providerAccountUsageRecord.count({ where: { accountId: account.id } })).toBe(0);
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
                token: new TextEncoder().encode("before"),
                metadata: { v: 3, storage: "plain_json_v1", kind: "token", providerAccountId: "acct-retained", providerEmail: null },
            },
        });
        const snapshot = createUsageSnapshot({
            fetchedAt: Date.now(),
            recordKey: createProviderAccountUsageRecordKey({ accountSubjectId: "acct-retained" }),
            profileId: "work",
        });
        await writeProviderAccountUsageRecordAndLinkConnectedServiceUsageSource({
            accountId: account.id,
            recordId: snapshot.recordId,
            recordKey: snapshot.recordKey,
            payloadMode: "plain_json_v1",
            status: "ok",
            fetchedAt: snapshot.fetchedAtMs,
            staleAfterMs: snapshot.staleAfterMs,
            snapshot,
            source: { serviceId: "openai-codex", profileId: "work", bindingKind: "profile" },
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
                            kind: "token",
                            oauth: null,
                            token: { token: "after", providerAccountId: "acct-retained", providerEmail: null, raw: null },
                        },
                    }],
                },
                automations: { action: "assert_empty" },
            },
        });

        expect(res.statusCode).toBe(200);
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
                vendor: "openai-codex",
                profileId: "work",
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
                        serviceId: "openai-codex",
                        profileId: "work",
                        kind: "plain",
                        record: {
                            v: 1,
                            serviceId: "openai-codex",
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
            serviceId: "openai-codex",
            profileId: "work",
            token: new TextEncoder().encode("sealed-before"),
            metadata: { v: 2, format: "account_scoped_v1", kind: "token", providerAccountId: "acct-old" },
            expiresAt: null,
            storageMode: "sealed",
            incomingIdentity: { providerAccountId: "acct-old" },
            allowProviderIdentityChange: false,
        })).resolves.toMatchObject({ status: "written" });
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
        expect(new TextDecoder().decode((await db.serviceAccountToken.findFirst({ where: { accountId: account.id }, select: { token: true } }))?.token))
            .toBe("sealed-before");
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

    it("snapshots settings rewritten by an encryption mode migration", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_SETTINGS_AT_REST: "none",
        });

        const account = await db.account.create({
            data: {
                publicKey: "pk-migrate-history",
                encryptionMode: "e2ee",
                settings: "history-ciphertext",
                settingsVersion: 0,
            },
            select: { id: true },
        });

        const app = createTestApp();
        registerAccountSettingsRoutes(app as any);
        registerAccountSettingsHistoryRoutes(app as any);
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

        const history = await app.inject({
            method: "GET",
            url: "/v2/account/settings/history",
            headers: { "x-test-user-id": account.id },
        });
        expect(history.statusCode).toBe(200);
        expect(history.json()).toEqual({
            snapshots: [
                expect.objectContaining({ version: 1, contentKind: "plain" }),
                expect.objectContaining({ version: 0, contentKind: "encrypted" }),
            ],
        });

        const previous = await app.inject({
            method: "GET",
            url: "/v2/account/settings/history/0",
            headers: { "x-test-user-id": account.id },
        });
        expect(previous.statusCode).toBe(200);
        expect(previous.json()).toEqual({
            content: { t: "encrypted", c: "history-ciphertext" },
            version: 0,
            createdAt: expect.any(String),
        });

        const current = await app.inject({
            method: "GET",
            url: "/v2/account/settings/history/1",
            headers: { "x-test-user-id": account.id },
        });
        expect(current.statusCode).toBe(200);
        expect(current.json()).toMatchObject({
            content: { t: "plain", v: expect.objectContaining({ schemaVersion: 2, pushEnabled: true }) },
            version: 1,
            createdAt: expect.any(String),
        });

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

        const account = await db.account.create({
            data: { publicKey: publicKeyHex1, encryptionMode: "e2ee", settings: "ciphertext", settingsVersion: 0 },
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
                },
            },
        });
        expect(mismatchedKey.statusCode).toBe(400);
        expect(mismatchedKey.json()).toEqual({ error: "invalid-params", reason: "restore_required" });

        const challenge1 = Uint8Array.from(crypto.getRandomValues(new Uint8Array(32)));
        const signature1 = Uint8Array.from(tweetnacl.sign.detached(challenge1, Uint8Array.from(kp1.secretKey)));
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
                },
            },
        });
        expect(correctKey.statusCode).toBe(200);
        expect(correctKey.json()).toMatchObject({ success: true, mode: "e2ee", settingsVersion: 2 });

        const storedAfterE2ee = await db.account.findUnique({
            where: { id: account.id },
            select: { encryptionMode: true, publicKey: true, settings: true, settingsVersion: true },
        });
        expect(storedAfterE2ee?.encryptionMode).toBe("e2ee");
        expect(storedAfterE2ee?.publicKey).toBe(publicKeyHex1);
        expect(storedAfterE2ee?.settings).toBe("settings-ciphertext");
        expect(storedAfterE2ee?.settingsVersion).toBe(2);

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
                token: new TextEncoder().encode("{\"kind\":\"oauth\"}"),
                refreshLeaseOwnerMachineId: "stale-daemon:refresh-attempt",
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
        expect(missingProof.json()).toEqual({ error: "invalid-params", reason: "key_proof_required" });

        const kp = tweetnacl.sign.keyPair();
        const publicKey = Uint8Array.from(kp.publicKey);
        const secretKey = Uint8Array.from(kp.secretKey);
        const challenge = Uint8Array.from(crypto.getRandomValues(new Uint8Array(32)));
        const signature = Uint8Array.from(tweetnacl.sign.detached(challenge, secretKey));

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
                },
            },
        });

        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({ success: true, mode: "e2ee", settingsVersion: 1 });

        const storedAccount = await db.account.findUnique({
            where: { id: account.id },
            select: { encryptionMode: true, publicKey: true, settings: true, settingsVersion: true },
        });
        expect(storedAccount?.encryptionMode).toBe("e2ee");
        expect(storedAccount?.settingsVersion).toBe(1);
        expect(storedAccount?.settings).toBe("settings-ciphertext");
        expect(typeof storedAccount?.publicKey).toBe("string");
        expect((storedAccount?.publicKey ?? "").length).toBeGreaterThan(0);

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
        expect((tokenRow?.metadata as any)?.v).toBe(2);
        expect((tokenRow?.metadata as any)?.format).toBe("account_scoped_v1");
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

    it("rejects a stale plain automation template update after a plain-to-e2ee migration commits", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
        });
        const kp = tweetnacl.sign.keyPair();
        const publicKey = Uint8Array.from(kp.publicKey);
        const challenge = Uint8Array.from(crypto.getRandomValues(new Uint8Array(32)));
        const signature = Uint8Array.from(tweetnacl.sign.detached(challenge, Uint8Array.from(kp.secretKey)));
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
                accountId: account.id,
                vendor: "openai-codex",
                profileId: "default",
                token: new TextEncoder().encode("sealed-before-rollback"),
                metadata: { v: 2, format: "account_scoped_v1", kind: "token", credentialRevision: previousRevision },
                refreshLeaseOwnerMachineId: "stale-daemon:rollback",
                refreshLeaseExpiresAt: new Date(Date.now() + 60_000),
            },
        });
        const automation = await db.automation.create({
            data: {
                accountId: account.id,
                name: "rollback automation",
                scheduleKind: "interval",
                everyMs: 60_000,
                timezone: null,
                scheduleExpr: null,
                targetType: "new_session",
                templateCiphertext: JSON.stringify({ kind: "happier_automation_template_encrypted_v1", payloadCiphertext: "before" }),
            },
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
                expectedSettingsVersion: 0,
                settingsContent: { t: "plain", v: { schemaVersion: 2 } },
                connectedServices: {
                    action: "migrate",
                    credentials: [{
                        serviceId: "openai-codex",
                        profileId: "default",
                        kind: "plain",
                        record: {
                            v: 1,
                            serviceId: "openai-codex",
                            profileId: "default",
                            createdAt: 1,
                            updatedAt: 2,
                            expiresAt: null,
                            kind: "token",
                            oauth: null,
                            token: { token: "plain-should-rollback", providerAccountId: null, providerEmail: null, raw: null },
                        },
                    }],
                },
                automations: {
                    action: "migrate",
                    templates: [{ automationId: automation.id, templateCiphertext: "invalid-template" }],
                },
            },
        });

        expect(res.statusCode).toBe(400);
        await expect(db.account.findUnique({
            where: { id: account.id },
            select: { encryptionMode: true, settingsVersion: true, settings: true },
        })).resolves.toEqual({ encryptionMode: "e2ee", settingsVersion: 0, settings: "ciphertext" });
        const credential = await db.serviceAccountToken.findUnique({
            where: { accountId_vendor_profileId: { accountId: account.id, vendor: "openai-codex", profileId: "default" } },
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
                    vendor: "openai-codex",
                    profileId,
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
                            serviceId: "openai-codex",
                            profileId: "default",
                            kind: "plain",
                            record: {
                                v: 1,
                                serviceId: "openai-codex",
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
                            serviceId: "openai-codex",
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
                where: { accountId_vendor_profileId: { accountId: account.id, vendor: "openai-codex", profileId } },
                select: { token: true, metadata: true, refreshLeaseOwnerMachineId: true, refreshLeaseExpiresAt: true },
            });
            expect(new TextDecoder().decode(credential?.token)).toBe(`sealed-${profileId}-before-rollback`);
            expect(credential?.metadata).toEqual(expect.objectContaining({ credentialRevision: previousRevision }));
            expect(credential?.refreshLeaseOwnerMachineId).toBe(`stale-daemon:${profileId}`);
            expect(credential?.refreshLeaseExpiresAt).not.toBeNull();
        }

        await app.close();
    });
});
