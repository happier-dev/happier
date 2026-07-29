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
import tweetnacl from "tweetnacl";
import { openBoxBundle } from "@happier-dev/protocol";
import { resolveLegacyServiceAccountTokenIdentityFields } from "./qualifiedConnectedAccounts/identity";

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

describe("connectRoutes (connected services v2) sealed credential endpoints (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-connected-services-v2-",
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

    it("keeps v2 connected service routes registered when the retired master env is off", async () => {
        harness.resetEnv({ HAPPIER_FEATURE_CONNECTED_SERVICES__ENABLED: "0" });
        const user = await db.account.create({ data: { publicKey: "pk-csv2-disabled" }, select: { id: true } });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "GET",
            url: "/v2/connect/openai-codex/profiles/work/credential",
            headers: { "x-test-user-id": user.id },
        });

        expect(res.statusCode).toBe(404);
        const body = res.json() as any;
        expect(body?.error).toBe("connect_credential_not_found");
    });

    it("stores and returns sealed ciphertext for a connected service profile", async () => {
        const user = await db.account.create({ data: { publicKey: "pk-csv2-u1" }, select: { id: true } });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const register = await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/profiles/work/credential",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                sealed: { format: "account_scoped_v1", ciphertext: "c2VhbGVk" },
                metadata: { kind: "oauth", providerEmail: "user@example.com", expiresAt: Date.now() + 3600_000 },
            },
        });
        expect(register.statusCode).toBe(200);
        expect(register.json()).toEqual(expect.objectContaining({ success: true, credentialRevision: expect.any(String) }));

        const getOne = await app.inject({
            method: "GET",
            url: "/v2/connect/openai-codex/profiles/work/credential",
            headers: { "x-test-user-id": user.id },
        });
        expect(getOne.statusCode).toBe(200);
        expect(getOne.json()).toEqual({
            credentialRevision: expect.any(String),
            sealed: { format: "account_scoped_v1", ciphertext: "c2VhbGVk" },
            metadata: expect.objectContaining({ kind: "oauth", providerEmail: "user@example.com" }),
        });

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
        expect(emitUpdate).toHaveBeenCalledWith(expect.objectContaining({
            userId: user.id,
            recipientFilter: { type: "user-machine-scoped-only" },
            payload: expect.objectContaining({
                seq: change!.cursor,
                body: expect.objectContaining({
                    t: "update-account",
                    connectedServicesV2: expect.arrayContaining([
                        expect.objectContaining({
                            serviceId: "openai-codex",
                            profiles: [expect.objectContaining({
                                profileId: "work",
                                status: "connected",
                            })],
                        }),
                    ]),
                }),
            }),
        }));
    });

    it("rejects sealed ciphertext longer than CONNECTED_SERVICE_CREDENTIAL_MAX_LEN", async () => {
        harness.resetEnv({ CONNECTED_SERVICE_CREDENTIAL_MAX_LEN: "4" });
        const user = await db.account.create({ data: { publicKey: "pk-csv2-max-len" }, select: { id: true } });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const register = await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/profiles/work/credential",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                sealed: { format: "account_scoped_v1", ciphertext: "12345" },
                metadata: { kind: "oauth" },
            },
        });

        expect(register.statusCode).toBe(413);
        expect(register.json()).toEqual({ error: "connect_credential_invalid" });
    });

    it("supports v1 register-sealed and credential shims (default profile)", async () => {
        const user = await db.account.create({ data: { publicKey: "pk-csv2-v1-shims" }, select: { id: true } });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const register = await app.inject({
            method: "POST",
            url: "/v1/connect/anthropic/register-sealed",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                sealed: { format: "account_scoped_v1", ciphertext: "c2VhbGVk" },
                metadata: { kind: "token", providerEmail: "user@example.com" },
            },
        });
        expect(register.statusCode).toBe(200);
        expect(register.json()).toEqual(expect.objectContaining({ success: true, credentialRevision: expect.any(String) }));

        const sameIdentity = await app.inject({
            method: "POST",
            url: "/v1/connect/anthropic/register-sealed",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: { sealed: { format: "account_scoped_v1", ciphertext: "c2VhbGVkLTI=" }, metadata: { kind: "token", providerEmail: "user@example.com" } },
        });
        expect(sameIdentity.statusCode).toBe(200);
        const changedIdentity = await app.inject({
            method: "POST",
            url: "/v1/connect/anthropic/register-sealed",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: { sealed: { format: "account_scoped_v1", ciphertext: "Zm9yZWlnbg==" }, metadata: { kind: "token", providerEmail: "other@example.com" } },
        });
        expect(changedIdentity.statusCode).toBe(409);
        expect(changedIdentity.json()).toEqual({ error: "connect_reconnect_provider_identity_mismatch" });

        const getOne = await app.inject({
            method: "GET",
            url: "/v1/connect/anthropic/credential",
            headers: { "x-test-user-id": user.id },
        });
        expect(getOne.statusCode).toBe(200);
        expect(getOne.json()).toEqual({
            credentialRevision: expect.any(String),
            sealed: { format: "account_scoped_v1", ciphertext: "c2VhbGVkLTI=" },
            metadata: expect.objectContaining({ kind: "token", providerEmail: "user@example.com" }),
        });
    });

    it("does not let the v1 credential shim bypass the canonical qualified identity", async () => {
        const user = await db.account.create({
            data: { publicKey: "pk-csv2-v1-canonical-read" },
            select: { id: true },
        });
        await db.serviceAccountToken.create({
            data: {
                accountId: user.id,
                vendor: "anthropic",
                profileId: "default",
                ...resolveLegacyServiceAccountTokenIdentityFields({
                    serviceId: "openai",
                    profileId: "default",
                    credentialKind: "token",
                }),
                token: Buffer.from("c2VhbGVk", "utf8"),
                metadata: {
                    v: 2,
                    format: "account_scoped_v1",
                    kind: "token",
                },
            },
        });
        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const response = await app.inject({
            method: "GET",
            url: "/v1/connect/anthropic/credential",
            headers: { "x-test-user-id": user.id },
        });

        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual({
            error: "connect_credential_not_found",
        });
    });

    it("proxies OAuth token exchange and returns an encrypted bundle (openai-codex)", async () => {
        const user = await db.account.create({ data: { publicKey: "pk-csv2-oauth-proxy" }, select: { id: true } });

        const keyPair = tweetnacl.box.keyPair();
        const publicKeyB64Url = Buffer.from(keyPair.publicKey).toString("base64url");

        vi.stubGlobal("fetch", vi.fn(async (url: any, init: any) => {
            expect(String(url)).toContain("auth.openai.com/oauth/token");
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    id_token: "id_token_1",
                    access_token: "access_token_1",
                    refresh_token: "refresh_token_1",
                    expires_in: 3600,
                }),
                text: async () => "",
            } as any;
        }));

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/oauth/exchange",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                publicKey: publicKeyB64Url,
                code: "code_1",
                verifier: "verifier_1",
                redirectUri: "http://localhost:1455/auth/callback",
            },
        });

        expect(res.statusCode).toBe(200);
        const body = res.json() as any;
        expect(typeof body?.bundle).toBe("string");
        expect(body?.access_token).toBeUndefined();
        expect(body?.refresh_token).toBeUndefined();
        expect(body?.id_token).toBeUndefined();

        const bundleBytes = new Uint8Array(Buffer.from(body.bundle, "base64url"));
        const opened = openBoxBundle({ bundle: bundleBytes, recipientSecretKeyOrSeed: keyPair.secretKey });
        expect(opened).not.toBeNull();
        const openedJson = JSON.parse(Buffer.from(opened!).toString("utf8"));
        expect(openedJson).toEqual(
            expect.objectContaining({
                accessToken: "access_token_1",
                refreshToken: "refresh_token_1",
                idToken: "id_token_1",
            }),
        );
    });

    it("rejects oauth exchange when request fields exceed max length", async () => {
        const user = await db.account.create({ data: { publicKey: "pk-csv2-oauth-maxlen" }, select: { id: true } });

        const keyPair = tweetnacl.box.keyPair();
        const publicKeyB64Url = Buffer.from(keyPair.publicKey).toString("base64url");

        const fetchSpy = vi.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => ({
                id_token: "id_token_1",
                access_token: "access_token_1",
                refresh_token: "refresh_token_1",
                expires_in: 3600,
            }),
            text: async () => "",
        }) as any);
        vi.stubGlobal("fetch", fetchSpy);

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/oauth/exchange",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                publicKey: publicKeyB64Url,
                code: "c".repeat(10_000),
                verifier: "verifier_1",
                redirectUri: "http://localhost:1455/auth/callback",
            },
        });

        expect(res.statusCode).toBe(400);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("returns connect_oauth_state_mismatch when state is missing for claude-subscription oauth exchange", async () => {
        const user = await db.account.create({ data: { publicKey: "pk-csv2-oauth-state-missing" }, select: { id: true } });

        const keyPair = tweetnacl.box.keyPair();
        const publicKeyB64Url = Buffer.from(keyPair.publicKey).toString("base64url");

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v2/connect/claude-subscription/oauth/exchange",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                publicKey: publicKeyB64Url,
                code: "code_1",
                verifier: "verifier_1",
                redirectUri: "http://localhost:1455/auth/callback",
            },
        });

        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ error: "connect_oauth_state_mismatch" });
    });

    it("returns connect_oauth_timeout when token exchange times out", async () => {
        harness.resetEnv({ HAPPIER_CONNECTED_SERVICES_OAUTH_EXCHANGE_TIMEOUT_MS: "1000" });
        try {
            const user = await db.account.create({ data: { publicKey: "pk-csv2-oauth-timeout" }, select: { id: true } });

            const keyPair = tweetnacl.box.keyPair();
            const publicKeyB64Url = Buffer.from(keyPair.publicKey).toString("base64url");

            vi.stubGlobal("fetch", vi.fn(async (_url: any, init: any) => {
                return await new Promise((_resolve, reject) => {
                    init?.signal?.addEventListener?.("abort", () => {
                        const err = new Error("AbortError");
                        (err as any).name = "AbortError";
                        reject(err);
                    });
                });
            }));

            const app = createTestApp();
            connectRoutes(app as any);
            await app.ready();

            const res = await app.inject({
                method: "POST",
                url: "/v2/connect/openai-codex/oauth/exchange",
                headers: { "content-type": "application/json", "x-test-user-id": user.id },
                payload: {
                    publicKey: publicKeyB64Url,
                    code: "code_1",
                    verifier: "verifier_1",
                    redirectUri: "http://localhost:1455/auth/callback",
                },
            });

            expect(res.statusCode).toBe(400);
            expect(res.json()).toEqual({ error: "connect_oauth_timeout" });
        } finally {
            harness.resetEnv();
        }
    });

    it("lists connected service profiles without returning plaintext secrets", async () => {
        const user = await db.account.create({ data: { publicKey: "pk-csv2-u2" }, select: { id: true } });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/profiles/work/credential",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                sealed: { format: "account_scoped_v1", ciphertext: "c2VhbGVk" },
                metadata: { kind: "oauth", providerEmail: "user@example.com", expiresAt: Date.now() + 3600_000 },
            },
        });

        const list = await app.inject({
            method: "GET",
            url: "/v2/connect/openai-codex/profiles",
            headers: { "x-test-user-id": user.id },
        });
        expect(list.statusCode).toBe(200);
        const json = list.json() as any;
        expect(Array.isArray(json.profiles)).toBe(true);
        expect(json.profiles).toEqual([
            expect.objectContaining({
                profileId: "work",
                status: "connected",
                providerEmail: "user@example.com",
            }),
        ]);
        expect(JSON.stringify(json)).not.toContain("c2VhbGVk");
    });

    it("rejects invalid connected service profile ids", async () => {
        const user = await db.account.create({ data: { publicKey: "pk-csv2-profileid-invalid" }, select: { id: true } });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/profiles/work%2Fbad/credential",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                sealed: { format: "account_scoped_v1", ciphertext: "c2VhbGVk" },
                metadata: { kind: "oauth", providerEmail: "user@example.com", expiresAt: Date.now() + 3600_000 },
            },
        });

        expect(res.statusCode).toBe(400);
    });

    it("preserves released raw v1 vendor-token writes for public-key accounts", async () => {
        const user = await db.account.create({ data: { publicKey: "pk-csv2-u3" }, select: { id: true } });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const legacyRegister = await app.inject({
            method: "POST",
            url: "/v1/connect/anthropic/register",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: { token: "legacy-token" },
        });
        expect(legacyRegister.statusCode).toBe(200);
        expect(legacyRegister.json()).toEqual({ success: true });

        const getOne = await app.inject({
            method: "GET",
            url: "/v2/connect/anthropic/profiles/default/credential",
            headers: { "x-test-user-id": user.id },
        });
        expect(getOne.statusCode).toBe(409);
        expect(getOne.json()).toEqual({ error: "connect_credential_unsupported_format" });
    });

    it("acquires a refresh lease and prevents concurrent refresh", async () => {
        const user = await db.account.create({ data: { publicKey: "pk-csv2-u4" }, select: { id: true } });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/profiles/work/credential",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                sealed: { format: "account_scoped_v1", ciphertext: "c2VhbGVk" },
                metadata: { kind: "oauth", providerEmail: "user@example.com", expiresAt: Date.now() + 3600_000 },
            },
        });

        const leaseA = await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/profiles/work/refresh-lease",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: { machineId: "m1", leaseMs: 10_000 },
        });
        expect(leaseA.statusCode).toBe(200);
        expect(leaseA.json()).toEqual(expect.objectContaining({ acquired: true, leaseUntil: expect.any(Number) }));

        const leaseB = await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/profiles/work/refresh-lease",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: { machineId: "m2", leaseMs: 10_000 },
        });
        expect(leaseB.statusCode).toBe(200);
        expect(leaseB.json()).toEqual(expect.objectContaining({ acquired: false, leaseUntil: expect.any(Number) }));
    });

    it("treats duplicate daemons on one machine as distinct refresh lease owners", async () => {
        const user = await db.account.create({ data: { publicKey: "pk-csv2-lease-owner" }, select: { id: true } });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/profiles/work/credential",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                sealed: { format: "account_scoped_v1", ciphertext: "c2VhbGVk" },
                metadata: { kind: "oauth", providerEmail: "user@example.com", expiresAt: Date.now() + 3600_000 },
            },
        });

        const leaseA = await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/profiles/work/refresh-lease",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: { machineId: "m1", ownerId: "m1:daemon-a", leaseMs: 10_000 },
        });
        expect(leaseA.statusCode).toBe(200);
        expect(leaseA.json()).toEqual(expect.objectContaining({ acquired: true, leaseUntil: expect.any(Number) }));

        const sameOwner = await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/profiles/work/refresh-lease",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: { machineId: "m1", ownerId: "m1:daemon-a", leaseMs: 10_000 },
        });
        expect(sameOwner.statusCode).toBe(200);
        expect(sameOwner.json()).toEqual(expect.objectContaining({ acquired: true, leaseUntil: expect.any(Number) }));

        const siblingDaemon = await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/profiles/work/refresh-lease",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: { machineId: "m1", ownerId: "m1:daemon-b", leaseMs: 10_000 },
        });
        expect(siblingDaemon.statusCode).toBe(200);
        expect(siblingDaemon.json()).toEqual(expect.objectContaining({ acquired: false, leaseUntil: expect.any(Number) }));
    });

    it("allows only one concurrent refresh lease acquirer", async () => {
        const user = await db.account.create({ data: { publicKey: "pk-csv2-lease-race" }, select: { id: true } });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/profiles/work/credential",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                sealed: { format: "account_scoped_v1", ciphertext: "c2VhbGVk" },
                metadata: { kind: "oauth", providerEmail: "user@example.com", expiresAt: Date.now() + 3600_000 },
            },
        });

        const leases = await Promise.all(Array.from({ length: 12 }, (_, index) => app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/profiles/work/refresh-lease",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: { machineId: `m${index}`, leaseMs: 10_000 },
        })));

        expect(leases.every((lease) => lease.statusCode === 200)).toBe(true);
        expect(leases.map((lease) => lease.json().acquired).filter(Boolean)).toHaveLength(1);
    });

    it("does not acquire a refresh lease through stale legacy identity shadows", async () => {
        const user = await db.account.create({
            data: { publicKey: "pk-csv2-lease-identity" },
            select: { id: true },
        });
        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const created = await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/profiles/work/credential",
            headers: {
                "content-type": "application/json",
                "x-test-user-id": user.id,
            },
            payload: {
                sealed: {
                    format: "account_scoped_v1",
                    ciphertext: "c2VhbGVk",
                },
                metadata: { kind: "oauth" },
            },
        });
        expect(created.statusCode).toBe(200);

        await db.serviceAccountToken.update({
            where: {
                accountId_vendor_profileId: {
                    accountId: user.id,
                    vendor: "openai-codex",
                    profileId: "work",
                },
            },
            data: resolveLegacyServiceAccountTokenIdentityFields({
                serviceId: "openai",
                profileId: "work",
            }),
        });

        const lease = await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/profiles/work/refresh-lease",
            headers: {
                "content-type": "application/json",
                "x-test-user-id": user.id,
            },
            payload: { machineId: "m1", leaseMs: 10_000 },
        });

        expect(lease.statusCode).toBe(404);
        await expect(db.serviceAccountToken.findUniqueOrThrow({
            where: {
                accountId_vendor_profileId: {
                    accountId: user.id,
                    vendor: "openai-codex",
                    profileId: "work",
                },
            },
            select: {
                refreshLeaseOwnerMachineId: true,
                refreshLeaseExpiresAt: true,
            },
        })).resolves.toEqual({
            refreshLeaseOwnerMachineId: null,
            refreshLeaseExpiresAt: null,
        });
    });

    it("rejects reconnect when incoming sealed credential identity is omitted", async () => {
        const user = await db.account.create({ data: { publicKey: "pk-csv2-reconnect-unknown" }, select: { id: true } });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/profiles/work/credential",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                sealed: { format: "account_scoped_v1", ciphertext: "old" },
                metadata: { kind: "oauth", providerEmail: "old@example.com", providerAccountId: "acct_old" },
            },
        });

        const reconnect = await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/profiles/work/credential",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                sealed: { format: "account_scoped_v1", ciphertext: "new" },
                metadata: { kind: "oauth" },
            },
        });

        expect(reconnect.statusCode).toBe(409);
        expect(reconnect.json()).toEqual({ error: "connect_reconnect_provider_identity_mismatch" });
    });

    it("rejects reconnect when incoming sealed credential drops the existing provider account id", async () => {
        const user = await db.account.create({ data: { publicKey: "pk-csv2-reconnect-account-id-loss" }, select: { id: true } });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/profiles/work/credential",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                sealed: { format: "account_scoped_v1", ciphertext: "old" },
                metadata: { kind: "oauth", providerEmail: "old@example.com", providerAccountId: "acct_old" },
            },
        });

        const reconnect = await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/profiles/work/credential",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                sealed: { format: "account_scoped_v1", ciphertext: "new" },
                metadata: { kind: "oauth", providerEmail: "old@example.com" },
            },
        });

        expect(reconnect.statusCode).toBe(409);
        expect(reconnect.json()).toEqual({ error: "connect_reconnect_provider_identity_mismatch" });
    });

    it("accepts canonical profile ids containing colon separators", async () => {
        const user = await db.account.create({ data: { publicKey: "pk-csv2-profile-colon" }, select: { id: true } });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/profiles/work:us/credential",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                sealed: { format: "account_scoped_v1", ciphertext: "c2VhbGVk" },
                metadata: { kind: "oauth", providerEmail: "user@example.com", expiresAt: Date.now() + 3600_000 },
            },
        });

        expect(res.statusCode).toBe(200);
    });

    it("deletes a connected service credential for a profile", async () => {
        const user = await db.account.create({ data: { publicKey: "pk-csv2-u5" }, select: { id: true } });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/profiles/work/credential",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                sealed: { format: "account_scoped_v1", ciphertext: "c2VhbGVk" },
                metadata: { kind: "oauth", providerEmail: "user@example.com", expiresAt: Date.now() + 3600_000 },
            },
        });
        vi.clearAllMocks();

        const del = await app.inject({
            method: "DELETE",
            url: "/v2/connect/openai-codex/profiles/work/credential",
            headers: { "x-test-user-id": user.id },
        });
        expect(del.statusCode).toBe(200);
        expect(del.json()).toEqual({ success: true });

        const getOne = await app.inject({
            method: "GET",
            url: "/v2/connect/openai-codex/profiles/work/credential",
            headers: { "x-test-user-id": user.id },
        });
        expect(getOne.statusCode).toBe(404);

        const list = await app.inject({
            method: "GET",
            url: "/v2/connect/openai-codex/profiles",
            headers: { "x-test-user-id": user.id },
        });
        expect(list.statusCode).toBe(200);
        expect((list.json() as any).profiles).toEqual([]);

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

    it("fences stale refresh persistence and health with the canonical credential revision", async () => {
        const user = await db.account.create({ data: { publicKey: "pk-csv2-dev-revision" }, select: { id: true } });
        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();
        const write = async (ciphertext: string, expectedCredentialRevision?: string) => await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/profiles/work/credential",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                sealed: { format: "account_scoped_v1", ciphertext },
                metadata: { kind: "oauth", providerAccountId: "account-1" },
                ...(expectedCredentialRevision ? { expectedCredentialRevision } : {}),
            },
        });
        const first = await write("credential-a");
        const revisionA = (first.json() as { credentialRevision: string }).credentialRevision;
        expect(revisionA).toEqual(expect.stringMatching(/^csr_/));
        const reconnect = await write("credential-b");
        const revisionB = (reconnect.json() as { credentialRevision: string }).credentialRevision;

        vi.clearAllMocks();
        const stale = await write("stale-refresh", revisionA);
        expect(stale.statusCode).toBe(409);
        expect(stale.json()).toEqual({
            error: "connect_credential_mutation_superseded",
            reason: "revision_mismatch",
            credentialRevision: revisionB,
        });
        const staleHealth = await app.inject({
            method: "PATCH",
            url: "/v3/connect/openai-codex/profiles/work/credential/health",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                expectedCredentialRevision: revisionA,
                health: { v: 1, status: "needs_reauth", reconnectRequired: true },
            },
        });
        expect(staleHealth.statusCode).toBe(409);
        expect(emitUpdate).not.toHaveBeenCalled();
    });

    it("treats an explicit null revision as expect-absence", async () => {
        const user = await db.account.create({ data: { publicKey: "pk-csv2-expect-absence" }, select: { id: true } });
        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const first = await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/profiles/work/credential",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                sealed: { format: "account_scoped_v1", ciphertext: "credential-a" },
                metadata: { kind: "oauth" },
            },
        });
        expect(first.statusCode).toBe(200);
        const currentRevision = (first.json() as { credentialRevision: string }).credentialRevision;

        const expectAbsent = await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/profiles/work/credential",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                sealed: { format: "account_scoped_v1", ciphertext: "credential-b" },
                metadata: { kind: "oauth" },
                expectedCredentialRevision: null,
            },
        });

        expect(expectAbsent.statusCode).toBe(409);
        expect(expectAbsent.json()).toEqual({
            error: "connect_credential_mutation_superseded",
            reason: "revision_mismatch",
            credentialRevision: currentRevision,
        });
    });

    it("rejects a stale guarded credential delete and preserves the newer credential", async () => {
        const user = await db.account.create({ data: { publicKey: "pk-csv2-delete-cas" }, select: { id: true } });
        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const write = async (ciphertext: string, expectedCredentialRevision?: string) => await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/profiles/work/credential",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                sealed: { format: "account_scoped_v1", ciphertext },
                metadata: { kind: "oauth" },
                ...(expectedCredentialRevision ? { expectedCredentialRevision } : {}),
            },
        });
        const revisionA = (await write("credential-a").then((response) => response.json()) as { credentialRevision: string }).credentialRevision;
        const revisionB = (await write("credential-b", revisionA).then((response) => response.json()) as { credentialRevision: string }).credentialRevision;

        const staleDelete = await app.inject({
            method: "DELETE",
            url: `/v2/connect/openai-codex/profiles/work/credential?expectedCredentialRevision=${encodeURIComponent(revisionA)}`,
            headers: { "x-test-user-id": user.id },
        });
        expect(staleDelete.statusCode).toBe(409);
        expect(staleDelete.json()).toEqual({
            error: "connect_credential_mutation_superseded",
            reason: "revision_mismatch",
            credentialRevision: revisionB,
        });
        await expect(db.serviceAccountToken.count({ where: { accountId: user.id } })).resolves.toBe(1);
    });

    it("sanitizes a v2 delete mode mismatch and preserves the plaintext credential", async () => {
        const user = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        await db.serviceAccountToken.create({
            data: {
                accountId: user.id,
                vendor: "openai-codex",
                profileId: "work",
                ...resolveLegacyServiceAccountTokenIdentityFields({
                    serviceId: "openai-codex",
                    profileId: "work",
                }),
                token: new Uint8Array([1]),
                metadata: { v: 3, storage: "plain_json_v1", kind: "token" },
            },
        });
        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const response = await app.inject({
            method: "DELETE",
            url: "/v2/connect/openai-codex/profiles/work/credential",
            headers: { "x-test-user-id": user.id },
        });

        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({ error: "connect_credential_invalid" });
        await expect(db.serviceAccountToken.count({ where: { accountId: user.id } })).resolves.toBe(1);
    });
});
