import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";

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

import { db } from "@/storage/db";
import { connectRoutes } from "./connectRoutes";
import { auth } from "@/app/auth/auth";
import { createAppCloseTracker } from "../../testkit/appLifecycle";
import { mutateConnectedServiceCredential, mutateLegacyConnectedServiceVendorToken } from "./credentials/mutation";
import {
    deleteQualifiedConnectedServiceCredentialForStorageMode,
} from "./qualifiedConnectedAccounts/credentialRepository";
import {
    createServiceAccountTokenIdentityFields,
    createQualifiedConnectedAccountGroupDigest,
    resolveLegacyServiceAccountTokenIdentityFields,
} from "./qualifiedConnectedAccounts/identity";

const { trackApp, closeTrackedApps } = createAppCloseTracker();
const openAiCodexWorkIdentity = resolveLegacyServiceAccountTokenIdentityFields({
    serviceId: "openai-codex",
    profileId: "work",
});
const openAiCodexMainGroupIdentity = {
    servicePluginId: openAiCodexWorkIdentity.servicePluginId,
    serviceLocalId: openAiCodexWorkIdentity.serviceLocalId,
    qualifiedServiceDigest: openAiCodexWorkIdentity.qualifiedServiceDigest,
    qualifiedGroupDigest: createQualifiedConnectedAccountGroupDigest({
        service: {
            pluginId: openAiCodexWorkIdentity.servicePluginId,
            localId: openAiCodexWorkIdentity.serviceLocalId,
        },
        groupId: "main",
    }),
};

import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";


function createTestApp() {
    const app = Fastify();
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

    return trackApp(typed);
}

describe("connectRoutes (connected services v3) plaintext credential endpoints (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-connected-services-v3-",
            initAuth: true,
            initEncrypt: true,
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });
    afterEach(async () => {
        await closeTrackedApps();
        harness.resetEnv();
        vi.unstubAllGlobals();
        vi.clearAllMocks();
        await db.serviceAccountToken.deleteMany().catch(() => {});
        await db.account.deleteMany().catch(() => {});
    });

    it("stores and returns a plaintext credential envelope for plaintext accounts (server sealed at rest)", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "server_sealed",
        });

        const user = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });

        const now = Date.now();
        const record = {
            v: 1,
            serviceId: "openai-codex",
            profileId: "work",
            kind: "oauth",
            createdAt: now,
            updatedAt: now,
            expiresAt: null,
            oauth: {
                accessToken: "tok_access",
                refreshToken: "tok_refresh",
                idToken: null,
                scope: null,
                tokenType: null,
                providerAccountId: null,
                providerEmail: "user@example.com",
                raw: null,
            },
            token: null,
        };

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const register = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/profiles/work/credential",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: { content: { t: "plain", v: record } },
        });
        expect(register.statusCode).toBe(200);
        expect(register.json()).toEqual(expect.objectContaining({ success: true, credentialRevision: expect.any(String) }));

        const getOne = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/profiles/work/credential",
            headers: { "x-test-user-id": user.id },
        });
        expect(getOne.statusCode).toBe(200);
        expect(getOne.json()).toEqual({
            credentialRevision: expect.any(String),
            content: { t: "plain", v: expect.any(Object) },
        });

        const row = await db.serviceAccountToken.findUnique({
            where: { accountId_vendor_profileId: { accountId: user.id, vendor: "openai-codex", profileId: "work" } },
            select: { token: true },
        });
        expect(row).not.toBeNull();
        const tokenUtf8 = Buffer.from(row!.token).toString("utf8");
        expect(tokenUtf8.includes("tok_access")).toBe(false);

        const change = await db.accountChange.findUnique({
            where: { accountId_kind_entityId: { accountId: user.id, kind: "account", entityId: "self" } },
            select: { cursor: true, hint: true },
        });
        expect(change).toEqual(expect.objectContaining({ cursor: expect.any(Number) }));
        expect((change!.hint as any)?.connectedServices).toBe(true);
        expect(emitUpdate).toHaveBeenCalledWith(expect.objectContaining({
            userId: user.id,
            recipientFilter: { type: "user-scoped-only" },
            payload: expect.objectContaining({
                seq: change!.cursor,
                body: expect.objectContaining({
                    t: "update-account",
                    connectedServicesV2: expect.arrayContaining([
                        expect.objectContaining({
                            serviceId: "openai-codex",
                            profiles: [expect.objectContaining({ profileId: "work", status: "connected" })],
                        }),
                    ]),
                }),
            }),
        }));
    });

    it("projects oauth null when V3 GET serves a canonical token credential that omitted it", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });

        const user = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const now = Date.now();
        const record = {
            v: 1,
            serviceId: "openai",
            profileId: "work",
            kind: "token",
            createdAt: now,
            updatedAt: now,
            expiresAt: null,
            token: {
                token: "sk-test",
                providerAccountId: null,
                providerEmail: null,
                raw: null,
            },
        };
        await db.serviceAccountToken.create({
            data: {
                accountId: user.id,
                vendor: record.serviceId,
                profileId: record.profileId,
                ...resolveLegacyServiceAccountTokenIdentityFields({
                    serviceId: record.serviceId,
                    profileId: record.profileId,
                }),
                token: Buffer.from(JSON.stringify(record), "utf8"),
                metadata: {
                    v: 3,
                    storage: "plain_json_v1",
                    kind: "token",
                    providerEmail: null,
                    providerAccountId: null,
                },
            },
        });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const response = await app.inject({
            method: "GET",
            url: "/v3/connect/openai/profiles/work/credential",
            headers: { "x-test-user-id": user.id },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
            credentialRevision: expect.any(String),
            content: {
                t: "plain",
                v: {
                    ...record,
                    oauth: null,
                },
            },
        });
    });

    it("publishes a profile update when a plaintext credential is deleted", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
        });

        const user = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });

        const now = Date.now();
        const record = {
            v: 1,
            serviceId: "openai-codex",
            profileId: "work",
            kind: "oauth",
            createdAt: now,
            updatedAt: now,
            expiresAt: null,
            oauth: {
                accessToken: "tok_access",
                refreshToken: "tok_refresh",
                idToken: null,
                scope: null,
                tokenType: null,
                providerAccountId: null,
                providerEmail: "user@example.com",
                raw: null,
            },
            token: null,
        };

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/profiles/work/credential",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: { content: { t: "plain", v: record } },
        });
        vi.clearAllMocks();

        const del = await app.inject({
            method: "DELETE",
            url: "/v3/connect/openai-codex/profiles/work/credential",
            headers: { "x-test-user-id": user.id },
        });
        expect(del.statusCode).toBe(200);
        expect(del.json()).toEqual({ success: true });

        const change = await db.accountChange.findUnique({
            where: { accountId_kind_entityId: { accountId: user.id, kind: "account", entityId: "self" } },
            select: { cursor: true, hint: true },
        });
        expect(change).toEqual(expect.objectContaining({ cursor: expect.any(Number) }));
        expect((change!.hint as any)?.connectedServices).toBe(true);
        expect(emitUpdate).toHaveBeenCalledWith(expect.objectContaining({
            userId: user.id,
            recipientFilter: { type: "user-scoped-only" },
            payload: expect.objectContaining({
                seq: change!.cursor,
                body: expect.objectContaining({
                    t: "update-account",
                    connectedServicesV2: [],
                }),
            }),
        }));
    });

    it("does not delete a qualified credential whose legacy shadows claim another service", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
        });
        const user = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const qualifiedIdentity = createServiceAccountTokenIdentityFields({
            ref: {
                service: {
                    pluginId: "happier.voice.openai",
                    localId: "openai",
                },
                accountId: "work",
            },
            authenticationModeId: "api-key",
        });
        const credential = await db.serviceAccountToken.create({
            data: {
                accountId: user.id,
                vendor: "openai-codex",
                profileId: "work",
                ...qualifiedIdentity,
                token: new Uint8Array([1]),
                metadata: {
                    v: 3,
                    storage: "plain_json_v1",
                    kind: "token",
                    providerEmail: null,
                    providerAccountId: null,
                },
            },
            select: { id: true },
        });
        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const response = await app.inject({
            method: "DELETE",
            url: "/v3/connect/openai-codex/profiles/work/credential",
            headers: { "x-test-user-id": user.id },
        });

        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual({
            error: "connect_credential_not_found",
        });
        await expect(db.serviceAccountToken.findUnique({
            where: { id: credential.id },
        })).resolves.not.toBeNull();
    });

    it("rejects plaintext credential content for e2ee accounts", async () => {
        harness.resetEnv({ HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "required_e2ee" });

        const user = await db.account.create({
            data: { publicKey: "pk-v3-e2ee", encryptionMode: "e2ee" },
            select: { id: true },
        });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/profiles/work/credential",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: { content: { t: "plain", v: {} } },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ error: "invalid-params" });
    });

    it("fences credential storage mode inside the canonical write transaction", async () => {
        const plain = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        const e2ee = await db.account.create({ data: { publicKey: "pk-mode-fence", encryptionMode: "e2ee" }, select: { id: true } });
        const base = {
            serviceId: "openai-codex", profileId: "work", token: new Uint8Array([1]),
            metadata: { v: 2, format: "account_scoped_v1", kind: "oauth", providerEmail: null, providerAccountId: null },
            expiresAt: null, incomingIdentity: { providerEmail: null, providerAccountId: null }, allowProviderIdentityChange: false,
        } as const;
        await expect(mutateConnectedServiceCredential({ ...base, accountId: plain.id, storageMode: "sealed" })).resolves.toEqual({ status: "storage_mode_mismatch" });
        await expect(mutateConnectedServiceCredential({ ...base, accountId: e2ee.id, storageMode: "plain" })).resolves.toEqual({ status: "storage_mode_mismatch" });
        await expect(mutateLegacyConnectedServiceVendorToken({ accountId: e2ee.id, vendor: "anthropic", token: new Uint8Array([2]) })).resolves.toEqual({ status: "written" });
        expect(await db.serviceAccountToken.count()).toBe(1);
    });

    it("does not return v3 plaintext credentials for e2ee accounts (defense-in-depth)", async () => {
        harness.resetEnv({ HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "required_e2ee" });

        const user = await db.account.create({
            data: { publicKey: "pk-v3-e2ee", encryptionMode: "e2ee" },
            select: { id: true },
        });

        const now = Date.now();
        const record = {
            v: 1,
            serviceId: "openai-codex",
            profileId: "work",
            kind: "oauth",
            createdAt: now,
            updatedAt: now,
            expiresAt: null,
            oauth: {
                accessToken: "tok_access",
                refreshToken: "tok_refresh",
                idToken: null,
                scope: null,
                tokenType: null,
                providerAccountId: null,
                providerEmail: "user@example.com",
                raw: null,
            },
            token: null,
        };

        await db.serviceAccountToken.create({
            data: {
                accountId: user.id,
                vendor: "openai-codex",
                profileId: "work",
                ...openAiCodexWorkIdentity,
                token: Buffer.from(JSON.stringify(record), "utf8"),
                metadata: {
                    v: 3,
                    storage: "plain_json_v1",
                    kind: "oauth",
                    providerEmail: "user@example.com",
                    providerAccountId: null,
                },
            },
        });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const getOne = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/profiles/work/credential",
            headers: { "x-test-user-id": user.id },
        });
        expect(getOne.statusCode).toBe(404);
        expect(getOne.json()).toEqual({ error: "connect_credential_not_found" });
    });

    it("rejects reconnect when the provider identity changes without explicit confirmation", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
        });

        const user = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const now = Date.now();
        await db.serviceAccountToken.create({
            data: {
                accountId: user.id,
                vendor: "openai-codex",
                profileId: "work",
                ...openAiCodexWorkIdentity,
                token: Buffer.from("old", "utf8"),
                metadata: {
                    v: 3,
                    storage: "plain_json_v1",
                    kind: "oauth",
                    providerEmail: "old@example.com",
                    providerAccountId: "acct_old",
                } as any,
            },
        });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const reconnect = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/profiles/work/credential",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                content: {
                    t: "plain",
                    v: {
                        v: 1,
                        serviceId: "openai-codex",
                        profileId: "work",
                        kind: "oauth",
                        createdAt: now,
                        updatedAt: now + 1,
                        expiresAt: null,
                        oauth: {
                            accessToken: "tok_access_new",
                            refreshToken: "tok_refresh_new",
                            idToken: null,
                            scope: null,
                            tokenType: null,
                            providerAccountId: "acct_new",
                            providerEmail: "new@example.com",
                            raw: null,
                        },
                        token: null,
                    },
                },
            },
        });

        expect(reconnect.statusCode).toBe(409);
        expect(reconnect.json()).toEqual({ error: "connect_reconnect_provider_identity_mismatch" });
    });

    it("rejects reconnect when incoming plaintext credential identity is omitted", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
        });

        const user = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const now = Date.now();
        await db.serviceAccountToken.create({
            data: {
                accountId: user.id,
                vendor: "openai-codex",
                profileId: "work",
                ...openAiCodexWorkIdentity,
                token: Buffer.from("old", "utf8"),
                metadata: {
                    v: 3,
                    storage: "plain_json_v1",
                    kind: "oauth",
                    providerEmail: "old@example.com",
                    providerAccountId: "acct_old",
                } as any,
            },
        });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const reconnect = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/profiles/work/credential",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                content: {
                    t: "plain",
                    v: {
                        v: 1,
                        serviceId: "openai-codex",
                        profileId: "work",
                        kind: "oauth",
                        createdAt: now,
                        updatedAt: now + 1,
                        expiresAt: null,
                        oauth: {
                            accessToken: "tok_access_new",
                            refreshToken: "tok_refresh_new",
                            idToken: null,
                            scope: null,
                            tokenType: null,
                            providerAccountId: null,
                            providerEmail: null,
                            raw: null,
                        },
                        token: null,
                    },
                },
            },
        });

        expect(reconnect.statusCode).toBe(409);
        expect(reconnect.json()).toEqual({ error: "connect_reconnect_provider_identity_mismatch" });
    });

    it("rejects reconnect when incoming plaintext credential drops the existing provider account id", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
        });

        const user = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const now = Date.now();
        await db.serviceAccountToken.create({
            data: {
                accountId: user.id,
                vendor: "openai-codex",
                profileId: "work",
                ...openAiCodexWorkIdentity,
                token: Buffer.from("old", "utf8"),
                metadata: {
                    v: 3,
                    storage: "plain_json_v1",
                    kind: "oauth",
                    providerEmail: "old@example.com",
                    providerAccountId: "acct_old",
                } as any,
            },
        });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const reconnect = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/profiles/work/credential",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                content: {
                    t: "plain",
                    v: {
                        v: 1,
                        serviceId: "openai-codex",
                        profileId: "work",
                        kind: "oauth",
                        createdAt: now,
                        updatedAt: now + 1,
                        expiresAt: null,
                        oauth: {
                            accessToken: "tok_access_new",
                            refreshToken: "tok_refresh_new",
                            idToken: null,
                            scope: null,
                            tokenType: null,
                            providerAccountId: null,
                            providerEmail: "old@example.com",
                            raw: null,
                        },
                        token: null,
                    },
                },
            },
        });

        expect(reconnect.statusCode).toBe(409);
        expect(reconnect.json()).toEqual({ error: "connect_reconnect_provider_identity_mismatch" });
    });

    it("rejects plaintext credential registration when content identity does not match the route", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
        });

        const user = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const now = Date.now();

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const register = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/profiles/work/credential",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                content: {
                    t: "plain",
                    v: {
                        v: 1,
                        serviceId: "github",
                        profileId: "other",
                        kind: "oauth",
                        createdAt: now,
                        updatedAt: now,
                        expiresAt: null,
                        oauth: {
                            accessToken: "tok_access",
                            refreshToken: "tok_refresh",
                            idToken: null,
                            scope: null,
                            tokenType: null,
                            providerAccountId: null,
                            providerEmail: "user@example.com",
                            raw: null,
                        },
                        token: null,
                    },
                },
            },
        });
        expect(register.statusCode).toBe(400);
        expect(register.json()).toEqual({ error: "connect_credential_invalid" });

        const getOne = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/profiles/work/credential",
            headers: { "x-test-user-id": user.id },
        });
        expect(getOne.statusCode).toBe(404);
    });

    it("does not return a stored plaintext credential whose content identity mismatches the route", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });

        const user = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const now = Date.now();
        await db.serviceAccountToken.create({
            data: {
                accountId: user.id,
                vendor: "openai-codex",
                profileId: "work",
                ...openAiCodexWorkIdentity,
                token: Buffer.from(JSON.stringify({
                    v: 1,
                    serviceId: "github",
                    profileId: "other",
                    kind: "oauth",
                    createdAt: now,
                    updatedAt: now,
                    expiresAt: null,
                    oauth: {
                        accessToken: "tok_access",
                        refreshToken: "tok_refresh",
                        idToken: null,
                        scope: null,
                        tokenType: null,
                        providerAccountId: null,
                        providerEmail: "user@example.com",
                        raw: null,
                    },
                    token: null,
                }), "utf8"),
                metadata: {
                    v: 3,
                    storage: "plain_json_v1",
                    kind: "oauth",
                    providerEmail: "user@example.com",
                    providerAccountId: null,
                } as any,
            },
        });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const getOne = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/profiles/work/credential",
            headers: { "x-test-user-id": user.id },
        });
        expect(getOne.statusCode).toBe(409);
        expect(getOne.json()).toEqual({ error: "connect_credential_unsupported_format" });
    });

    it("persists credential health and projects reconnect-required profiles", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
        });

        const user = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });

        const now = Date.now();
        const record = {
            v: 1,
            serviceId: "openai-codex",
            profileId: "work",
            kind: "oauth",
            createdAt: now,
            updatedAt: now,
            expiresAt: null,
            oauth: {
                accessToken: "tok_access",
                refreshToken: "tok_refresh",
                idToken: null,
                scope: null,
                tokenType: null,
                providerAccountId: null,
                providerEmail: "user@example.com",
                raw: null,
            },
            token: null,
        };

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/profiles/work/credential",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: { content: { t: "plain", v: record } },
        });
        vi.clearAllMocks();

        const health = await app.inject({
            method: "PATCH",
            url: "/v3/connect/openai-codex/profiles/work/credential/health",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                health: {
                    v: 1,
                    status: "needs_reauth",
                    reconnectRequired: true,
                    lastRefreshFailureKind: "invalid_grant",
                },
            },
        });

        expect(health.statusCode).toBe(200);
        expect(health.json()).toEqual(expect.objectContaining({ success: true, credentialRevision: expect.any(String) }));

        const row = await db.serviceAccountToken.findUnique({
            where: { accountId_vendor_profileId: { accountId: user.id, vendor: "openai-codex", profileId: "work" } },
            select: { metadata: true },
        });
        expect((row!.metadata as any).health).toEqual(expect.objectContaining({
            status: "needs_reauth",
            reconnectRequired: true,
        }));

        const profiles = await app.inject({
            method: "GET",
            url: "/v2/connect/openai-codex/profiles",
            headers: { "x-test-user-id": user.id },
        });
        expect(profiles.statusCode).toBe(200);
        expect(profiles.json().profiles).toEqual([
            expect.objectContaining({ profileId: "work", status: "needs_reauth" }),
        ]);

        expect(emitUpdate).toHaveBeenCalledWith(expect.objectContaining({
            userId: user.id,
            recipientFilter: { type: "user-scoped-only" },
            payload: expect.objectContaining({
                body: expect.objectContaining({
                    t: "update-account",
                    connectedServicesV2: expect.arrayContaining([
                        expect.objectContaining({
                            serviceId: "openai-codex",
                            profiles: [expect.objectContaining({ profileId: "work", status: "needs_reauth" })],
                        }),
                    ]),
                }),
            }),
        }));
    });

    it("fences credential deletion by account mode inside the transactional delete owner", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
        });
        const user = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        await db.serviceAccountToken.create({
            data: {
                accountId: user.id,
                vendor: "openai-codex",
                profileId: "work",
                ...openAiCodexWorkIdentity,
                token: new Uint8Array([1]),
                metadata: { v: 3, storage: "plain_json_v1", kind: "token" },
            },
        });

        const result =
            await deleteQualifiedConnectedServiceCredentialForStorageMode({
            accountId: user.id,
            ref: {
                service: {
                    pluginId: openAiCodexWorkIdentity.servicePluginId,
                    localId: openAiCodexWorkIdentity.serviceLocalId,
                },
                accountId: "work",
            },
            expectedStorageMode: "sealed",
            cleanupGroupReferences: true,
        });

        expect(result).toEqual({ status: "storage_mode_mismatch" });
        await expect(db.serviceAccountToken.findUnique({
            where: {
                accountId_vendor_profileId: {
                    accountId: user.id,
                    vendor: "openai-codex",
                    profileId: "work",
                },
            },
        })).resolves.not.toBeNull();
    });

    it("reports a group reference before storage-mode validation on non-cleanup deletion", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
        });
        const user = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const credential = await db.serviceAccountToken.create({
            data: {
                accountId: user.id,
                vendor: "openai-codex",
                profileId: "work",
                ...openAiCodexWorkIdentity,
                token: new Uint8Array([1]),
                metadata: { v: 3, storage: "plain_json_v1", kind: "token" },
            },
            select: { id: true },
        });
        const group = await db.connectedServiceAuthGroup.create({
            data: {
                accountId: user.id,
                vendor: "openai-codex",
                ...openAiCodexMainGroupIdentity,
                groupId: "main",
                policyJson: "{}",
            },
            select: { id: true },
        });
        await db.connectedServiceAuthGroupMember.create({
            data: {
                accountId: user.id,
                vendor: "openai-codex",
                groupId: "main",
                groupDbId: group.id,
                profileId: "work",
                credentialId: credential.id,
                qualifiedServiceDigest:
                    openAiCodexWorkIdentity.qualifiedServiceDigest,
                qualifiedGroupDigest:
                    openAiCodexMainGroupIdentity.qualifiedGroupDigest,
                qualifiedIdentityDigest:
                    openAiCodexWorkIdentity.qualifiedIdentityDigest,
            },
        });

        const result =
            await deleteQualifiedConnectedServiceCredentialForStorageMode({
            accountId: user.id,
            ref: {
                service: {
                    pluginId: openAiCodexWorkIdentity.servicePluginId,
                    localId: openAiCodexWorkIdentity.serviceLocalId,
                },
                accountId: "work",
            },
            expectedStorageMode: "sealed",
            cleanupGroupReferences: false,
        });

        expect(result).toEqual({ status: "referenced" });
    });

    it("preserves the v3 not-found boundary for a sealed-account delete mode mismatch", async () => {
        const user = await db.account.create({
            data: { publicKey: "pk-v3-delete-mode", encryptionMode: "e2ee" },
            select: { id: true },
        });
        await db.serviceAccountToken.create({
            data: {
                accountId: user.id,
                vendor: "openai-codex",
                profileId: "work",
                ...openAiCodexWorkIdentity,
                token: new Uint8Array([1]),
                metadata: { v: 2, format: "account_scoped_v1", kind: "token" },
            },
        });
        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const response = await app.inject({
            method: "DELETE",
            url: "/v3/connect/openai-codex/profiles/work/credential",
            headers: { "x-test-user-id": user.id },
        });

        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual({ error: "connect_credential_not_found" });
        await expect(db.serviceAccountToken.count({ where: { accountId: user.id } })).resolves.toBe(1);
    });

    it("delegates a post storage-mode mismatch to the serializable mutation owner without a route-level account precheck", async () => {
        const user = await db.account.create({
            data: { publicKey: "pk-v3-post-mode", encryptionMode: "e2ee" },
            select: { id: true },
        });
        const routeLevelAccountRead = vi.spyOn(db.account, "findUnique").mockRejectedValue(
            new Error("route-level account mode reads are stale outside the mutation transaction"),
        );
        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const response = await (async () => {
            try {
                const result = await app.inject({
                    method: "POST",
                    url: "/v3/connect/openai-codex/profiles/work/credential",
                    headers: { "content-type": "application/json", "x-test-user-id": user.id },
                    payload: {
                        content: {
                            t: "plain",
                            v: {
                                v: 1,
                                serviceId: "openai-codex",
                                profileId: "work",
                                kind: "token",
                                createdAt: 1_000,
                                updatedAt: 1_000,
                                expiresAt: null,
                                oauth: null,
                                token: {
                                    token: "plain-token",
                                    providerAccountId: null,
                                    providerEmail: null,
                                },
                            },
                        },
                        expectedCredentialRevision: null,
                    },
                });
                expect(routeLevelAccountRead).not.toHaveBeenCalled();
                return result;
            } finally {
                routeLevelAccountRead.mockRestore();
            }
        })();

        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({ error: "invalid-params" });
        await expect(db.serviceAccountToken.count({ where: { accountId: user.id } })).resolves.toBe(0);
    });
});
