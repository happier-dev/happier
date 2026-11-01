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
import { buildConnectedServiceCredentialRecord } from "@happier-dev/protocol";
import { connectRoutes } from "./connectRoutes";
import { auth } from "@/app/auth/auth";
import { createAppCloseTracker } from "../../testkit/appLifecycle";
import {
    DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
    stringifyConnectedServiceAuthGroupPolicy,
} from "./connectedServicesV3/authGroupPolicy";
import {
    mutateConnectedServiceCredential,
    mutateLegacyConnectedServiceVendorToken,
} from "./credentials/mutation";

const { trackApp, closeTrackedApps } = createAppCloseTracker();

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

    it("derives the public organization identity from the plaintext credential at the write boundary", async () => {
        harness.resetEnv({ HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional", HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none" });
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" } });
        const record = buildConnectedServiceCredentialRecord({
            now: 1000, serviceId: "claude-subscription", profileId: "work", kind: "oauth",
            oauth: { accessToken: "access", refreshToken: "refresh", idToken: null, scope: null, tokenType: null,
                providerAccountId: "same-user", providerEmail: null, raw: { claudeAiOauth: { organizationUuid: "org-work" } } },
        });
        const app = createTestApp();
        connectRoutes(app);
        const response = await app.inject({ method: "POST", url: "/v3/connect/claude-subscription/profiles/work/credential",
            headers: { "content-type": "application/json", "x-test-user-id": user.id }, payload: { content: { t: "plain", v: record } } });
        expect(response.statusCode).toBe(200);
        const stored = await db.serviceAccountToken.findUnique({ where: { accountId_vendor_profileId: {
            accountId: user.id, vendor: "claude-subscription", profileId: "work",
        } } });
        expect(stored?.metadata).toMatchObject({ providerAccountId: "same-user", providerOrganizationId: "org-work" });
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

    it("applies the same credential revision CAS to plaintext reconnects", async () => {
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
        const makeRecord = (accessToken: string, refreshToken: string) => ({
            v: 1,
            serviceId: "openai-codex",
            profileId: "work",
            kind: "oauth",
            createdAt: now,
            updatedAt: now,
            expiresAt: null,
            oauth: {
                accessToken,
                refreshToken,
                idToken: null,
                scope: null,
                tokenType: null,
                providerAccountId: "account-1",
                providerEmail: "user@example.com",
                raw: null,
            },
            token: null,
        });
        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const first = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/profiles/work/credential",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: { content: { t: "plain", v: makeRecord("access-a", "refresh-a") } },
        });
        const revisionA = (first.json() as { credentialRevision: string }).credentialRevision;

        const reconnect = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/profiles/work/credential",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: { content: { t: "plain", v: makeRecord("access-b", "refresh-b") } },
        });
        const revisionB = (reconnect.json() as { credentialRevision: string }).credentialRevision;
        expect(revisionB).not.toBe(revisionA);

        vi.clearAllMocks();
        const stale = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/profiles/work/credential",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                content: { t: "plain", v: makeRecord("stale-access", "stale-refresh") },
                expectedCredentialRevision: revisionA,
            },
        });
        expect(stale.statusCode).toBe(409);
        expect(stale.json()).toEqual({
            error: "connect_credential_mutation_superseded",
            reason: "revision_mismatch",
            credentialRevision: revisionB,
        });
        expect(emitUpdate).not.toHaveBeenCalled();

        const current = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/profiles/work/credential",
            headers: { "x-test-user-id": user.id },
        });
        expect(current.statusCode).toBe(200);
        expect(current.json()).toEqual(expect.objectContaining({
            credentialRevision: revisionB,
            content: {
                t: "plain",
                v: expect.objectContaining({ oauth: expect.objectContaining({ accessToken: "access-b" }) }),
            },
        }));
    });

    it("supports protocol-valid profile ids on the canonical v3 refresh lease route", async () => {
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
            url: "/v3/connect/openai-codex/profiles/work:us/credential",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                content: {
                    t: "plain",
                    v: {
                        v: 1,
                        serviceId: "openai-codex",
                        profileId: "work:us",
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
                            providerAccountId: "acct_1",
                            providerEmail: "user@example.com",
                            raw: null,
                        },
                        token: null,
                    },
                },
            },
        });
        expect(register.statusCode).toBe(200);

        const lease = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/profiles/work:us/refresh-lease",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: { machineId: "m1", leaseMs: 10_000 },
        });

        expect(lease.statusCode).toBe(200);
        expect(lease.json()).toEqual(expect.objectContaining({ acquired: true, leaseUntil: expect.any(Number) }));
    });

    it("reconnects a plaintext credential in place, preserves group membership, and clears health", async () => {
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
                token: Buffer.from("old", "utf8"),
                metadata: {
                    v: 3,
                    storage: "plain_json_v1",
                    kind: "oauth",
                    providerEmail: "user@example.com",
                    providerAccountId: "acct_1",
                    health: {
                        v: 1,
                        status: "needs_reauth",
                        reconnectRequired: true,
                        lastRefreshFailureKind: "invalid_grant",
                    },
                } as any,
            },
        });
        const group = await db.connectedServiceAuthGroup.create({
            data: {
                accountId: user.id,
                vendor: "openai-codex",
                groupId: "codex-main",
                displayName: "Codex Main",
                activeProfileId: "work",
                policyJson: stringifyConnectedServiceAuthGroupPolicy(DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1),
            },
        });
        await db.connectedServiceAuthGroupMember.create({
            data: {
                groupDbId: group.id,
                accountId: user.id,
                vendor: "openai-codex",
                groupId: "codex-main",
                profileId: "work",
                priority: 1,
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
                            providerAccountId: "acct_1",
                            providerEmail: "user@example.com",
                            raw: null,
                        },
                        token: null,
                    },
                },
            },
        });
        expect(reconnect.statusCode).toBe(200);

        const row = await db.serviceAccountToken.findUnique({
            where: { accountId_vendor_profileId: { accountId: user.id, vendor: "openai-codex", profileId: "work" } },
            select: { metadata: true },
        });
        expect(row?.metadata).toEqual(expect.objectContaining({
            v: 3,
            providerAccountId: "acct_1",
        }));
        expect((row?.metadata as any)?.health).toBeUndefined();

        const member = await db.connectedServiceAuthGroupMember.findUnique({
            where: {
                accountId_vendor_groupId_profileId: {
                    accountId: user.id,
                    vendor: "openai-codex",
                    groupId: "codex-main",
                    profileId: "work",
                },
            },
        });
        expect(member).not.toBeNull();
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

    it("rejects a v2 delete for a plaintext credential and retains the row", async () => {
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
            kind: "token",
            createdAt: now,
            updatedAt: now,
            expiresAt: null,
            oauth: null,
            token: {
                token: "tok_plain_v3",
                providerAccountId: null,
                providerEmail: null,
                raw: null,
            },
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

        const del = await app.inject({
            method: "DELETE",
            url: "/v2/connect/openai-codex/profiles/work/credential",
            headers: { "x-test-user-id": user.id },
        });
        expect(del.statusCode).toBe(400);
        expect(del.json()).toEqual({ error: "connect_credential_invalid" });

        await expect(db.serviceAccountToken.findUnique({
            where: {
                accountId_vendor_profileId: {
                    accountId: user.id,
                    vendor: "openai-codex",
                    profileId: "work",
                },
            },
            select: { id: true },
        })).resolves.toEqual({ id: expect.any(String) });
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
            serviceId: "openai-codex",
            profileId: "work",
            token: new Uint8Array([1, 2, 3]),
            metadata: { v: 2, format: "account_scoped_v1", kind: "oauth", providerEmail: null, providerAccountId: null },
            expiresAt: null,
            incomingIdentity: { providerEmail: null, providerAccountId: null },
            allowProviderIdentityChange: false,
        } as const;

        await expect(mutateConnectedServiceCredential({ ...base, accountId: plain.id, storageMode: "sealed" }))
            .resolves.toEqual({ status: "storage_mode_mismatch" });
        await expect(mutateConnectedServiceCredential({ ...base, accountId: e2ee.id, storageMode: "plain" }))
            .resolves.toEqual({ status: "storage_mode_mismatch" });
        await expect(mutateLegacyConnectedServiceVendorToken({ accountId: e2ee.id, vendor: "anthropic", token: new Uint8Array([4]) }))
            .resolves.toEqual({ status: "written" });
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
});
