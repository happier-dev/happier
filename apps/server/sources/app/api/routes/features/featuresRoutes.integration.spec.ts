import { readServerEnabledBit, type HomeSearchCapabilities } from "@happier-dev/protocol";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { HomeIrohEndpointState } from "@/app/iroh/homeIrohEndpoint";
import {
    createFileHomeConnectionDescriptorContinuityStore,
    createSimpleCacheHomeConnectionDescriptorContinuityStore,
    type HomeConnectionDescriptorContinuityStore,
} from '@/app/features/homeConnectionDescriptorContinuity';
import { resetHomeConnectionDescriptorRevisionOwnerForTests } from '@/app/features/homeConnectionDescriptorPublication';

import { applyEnvValues, createEnvReset } from "../../testkit/env";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { db } from "@/storage/db";
import { createRouteTestBuilder } from "../../testkit/routeTestBuilder";
import { withAuthenticatedTestApp } from "../../testkit/sqliteFastify";
import {
    resolveInferredPublicServerAccess,
    resetPublicServerUrlInferenceCacheForTests,
} from "@/app/integrations/publicUrl/publicServerUrlInference";
import { resolveFeaturesFromEnv } from '@/app/features/registry';

let databaseEnv: Record<string, string | undefined> = {};

const resetEnvToDeploymentBase = createEnvReset({
    ...process.env,
    HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: undefined,
    HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: undefined,
    HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: undefined,
    HAPPIER_HOME_DIR: undefined,
    HAPPIER_STACK_CLI_HOME_DIR: undefined,
    HAPPY_HOME_DIR: undefined,
    HAPPIER_CANONICAL_SERVER_URL: undefined,
    HAPPIER_PUBLIC_SERVER_URL: undefined,
    HAPPIER_PUBLIC_SERVER_URL_INFER_TTL_MS: undefined,
    HAPPIER_WEBAPP_URL: undefined,
    HAPPY_WEBAPP_URL: undefined,
    HAPPIER_RELAY_ACCESS_INFER_PUBLIC_URL: "0",
    HAPPIER_TAILSCALE_INFER_PUBLIC_URL: "0",
    HAPPIER_BUILD_FEATURES_ALLOW: undefined,
    HAPPIER_BUILD_FEATURES_DENY: undefined,
    HAPPIER_AUTH_SIGN_IN_SERVICE_MODE: undefined,
    HAPPIER_AUTH_SIGN_IN_SERVICE_URL: undefined,
    HAPPIER_AUTH_SIGN_IN_SERVICE_SERVER_IDENTITY_ID: undefined,
    HAPPIER_ACCOUNT_SERVICE_DISPLAY_NAME: undefined,
});

/**
 * Cases reset the environment to a deployment baseline captured before the
 * SQLite harness existed, so the connection keys are re-applied after every
 * reset; without them the route's effective-Home read has no database.
 */
function resetEnv(overrides?: Parameters<typeof resetEnvToDeploymentBase>[0]): void {
    resetEnvToDeploymentBase(overrides);
    applyEnvValues(databaseEnv);
}

type ServerIdentityRouteModuleMock = Readonly<{
    getOrCreateServerIdentityId: (env?: NodeJS.ProcessEnv) => Promise<string>;
    readPinnedServerIdentityId: (env?: NodeJS.ProcessEnv) => string | null;
    readCachedServerIdentityIdForHotPath: (env?: NodeJS.ProcessEnv) => string | null;
}>;

/**
 * One case replaces the server-identity reader. It does so through a standing
 * passthrough mock with a per-case override rather than a module reset, because
 * resetting the registry for every case both exhausted this file's heap and left
 * the reset copy of the database module without a client.
 */
const serverIdentityOverride = vi.hoisted(() => ({
    value: null as ServerIdentityRouteModuleMock | null,
}));
vi.mock("@/app/serverIdentity/serverIdentity", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/app/serverIdentity/serverIdentity")>();
    return {
        ...actual,
        getOrCreateServerIdentityId: async (env?: NodeJS.ProcessEnv) =>
            await (serverIdentityOverride.value ?? actual).getOrCreateServerIdentityId(env),
        readPinnedServerIdentityId: (env?: NodeJS.ProcessEnv) =>
            (serverIdentityOverride.value ?? actual).readPinnedServerIdentityId(env),
        readCachedServerIdentityIdForHotPath: (env?: NodeJS.ProcessEnv) =>
            (serverIdentityOverride.value ?? actual).readCachedServerIdentityIdForHotPath(env),
    };
});

let descriptorContinuityDir = "";
const descriptorContinuityPath = (): string => join(descriptorContinuityDir, "home.descriptor.json");

/**
 * `/v1/features` resolves the effective Home authentication decision, which is a
 * database read, so every case in this file needs a live client — not only the
 * two that write a governance row. One file-level SQLite harness supplies it;
 * the per-case `resetEnv()` snapshot predates the harness, so the connection
 * keys are re-applied after each reset.
 */
let harness: LightSqliteHarness;

/**
 * Only the server-identity case replaces a module, and a replaced module needs a
 * fresh registry. Resetting per case instead is what exhausted this file's heap,
 * so the reset is confined here and the fresh registry gets its own client.
 */

async function getFeaturesPayload(
    requestOverrides: Record<string, unknown> = {},
    serverIdentityMock?: ServerIdentityRouteModuleMock,
    resolveHomeSearchCapability?: () => Readonly<{
        enabled: boolean;
        reason?: "index_unavailable" | "indexing";
    }> | undefined,
    resolveHomeIrohEndpointState?: () => HomeIrohEndpointState,
    continuityStoreOverride?: HomeConnectionDescriptorContinuityStore | null,
) {
    if (serverIdentityMock) serverIdentityOverride.value = serverIdentityMock;
    return await invokeFeaturesRoute(
        requestOverrides,
        resolveHomeSearchCapability,
        resolveHomeIrohEndpointState,
        continuityStoreOverride,
    );
}

async function invokeFeaturesRoute(
    requestOverrides: Record<string, unknown>,
    resolveHomeSearchCapability?: () => Readonly<{
        enabled: boolean;
        reason?: "index_unavailable" | "indexing";
    }> | undefined,
    resolveHomeIrohEndpointState?: () => HomeIrohEndpointState,
    continuityStoreOverride?: HomeConnectionDescriptorContinuityStore | null,
) {
    const { featuresRoutes } = await import("./featuresRoutes");
    const route = createRouteTestBuilder({
        method: "GET",
        path: "/v1/features",
        registerRoutes(app) {
            featuresRoutes(app as any, {
                resolveHomeSearchCapability,
                resolveHomeIrohEndpointState,
                homeConnectionDescriptorContinuityStore: continuityStoreOverride !== undefined
                    ? continuityStoreOverride
                    : resolveHomeIrohEndpointState
                        ? createFileHomeConnectionDescriptorContinuityStore(descriptorContinuityPath())
                        : null,
            });
        },
    });
    const { response, reply } = await route.invoke(requestOverrides);
    return { payload: response as any, reply };
}

describe("featuresRoutes", () => {
    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-features-routes-",
            initAuth: true,
            env: { AUTH_REQUIRED_LOGIN_PROVIDERS: "" },
        });
        // Only the connection keys travel into each case: the harness's data
        // directory and master secret would change what the deployment baseline
        // these cases assert against actually says.
        databaseEnv = {
            HAPPIER_DB_PROVIDER: process.env.HAPPIER_DB_PROVIDER,
            HAPPY_DB_PROVIDER: process.env.HAPPY_DB_PROVIDER,
            DATABASE_URL: process.env.DATABASE_URL,
        };
    }, 300_000);

    afterAll(async () => {
        await harness.close();
    });

    beforeEach(async () => {
        serverIdentityOverride.value = null;
        resetPublicServerUrlInferenceCacheForTests();
        resetHomeConnectionDescriptorRevisionOwnerForTests();
        resetEnv();
        descriptorContinuityDir = await mkdtemp(join(tmpdir(), "features-descriptor-"));
    });

    it.each(['personal-home', 'generic', undefined])('publishes the observed host fact only to an authenticated Account (relay purpose %s)', async (purpose) => {
        const { featuresRoutes } = await import('./featuresRoutes');
        const known = { kind: 'known' as const, machineName: 'Studio', platform: 'darwin' as const, mobility: 'stationary' as const };
        resetEnv({ HAPPIER_MANAGED_RELAY_PURPOSE: purpose });
        const makeRoute = (path: string) => createRouteTestBuilder({
            method: 'GET',
            path,
            registerRoutes(app) {
                app.authenticate.mockImplementation(async (request: any) => {
                    request.userId = 'account_1';
                    request.authTokenKind = request.headers.authorization === 'Bearer restricted'
                        ? 'ephemeral_session_runner' : 'account';
                });
                featuresRoutes(app as any, { resolveHomeHostFact: async () => known });
            },
        });
        const publicRoute = makeRoute('/v1/features');
        const authenticatedRoute = makeRoute('/v1/features/authenticated');
        expect((await publicRoute.invoke()).response).not.toHaveProperty('homeHostFact');
        expect((await authenticatedRoute.invoke({ headers: { authorization: 'Bearer account' } })).response)
            .toHaveProperty('homeHostFact', known);
        expect((await authenticatedRoute.invoke({ headers: { authorization: 'Bearer restricted' } })).response)
            .not.toHaveProperty('homeHostFact');

        await withAuthenticatedTestApp((app) => featuresRoutes(app, { resolveHomeHostFact: async () => known }), async (app) => {
            const publicResponse = await app.inject({ method: 'GET', url: '/v1/features' });
            expect(publicResponse.statusCode, publicResponse.body).toBe(200);
            expect(publicResponse.json()).not.toHaveProperty('homeHostFact');
            const accountResponse = await app.inject({
                method: 'GET', url: '/v1/features/authenticated', headers: { 'x-test-user-id': 'account_1' },
            });
            expect(accountResponse.statusCode, accountResponse.body).toBe(200);
            expect(accountResponse.json().homeHostFact).toEqual(known);
        });
    });

    it('serves unknown immediately while host detection is pending or fails', async () => {
        const { featuresRoutes } = await import('./featuresRoutes');
        let rejectProbe!: (error: Error) => void;
        const probe = new Promise<{ kind: 'unknown' }>((_resolve, reject) => { rejectProbe = reject; });
        resetEnv({ HAPPIER_MANAGED_RELAY_PURPOSE: 'personal-home' });
        const route = createRouteTestBuilder({ method: 'GET', path: '/v1/features/authenticated', registerRoutes(app) {
            app.authenticate.mockImplementation(async (request: any) => { request.userId = 'account_1'; request.authTokenKind = 'account'; });
            featuresRoutes(app as any, { resolveHomeHostFact: () => probe });
        } });
        const pending = await route.invoke({ headers: { authorization: 'Bearer account' } });
        expect(pending.response).toHaveProperty('homeHostFact', { kind: 'unknown' });
        rejectProbe(new Error('OS probe unavailable'));
        await Promise.resolve();
        const failed = await route.invoke({ headers: { authorization: 'Bearer account' } });
        expect(failed.response).toHaveProperty('homeHostFact', { kind: 'unknown' });

        const probeCapture: { signal: AbortSignal | null } = { signal: null };
        await withAuthenticatedTestApp((app) => featuresRoutes(app, {
            resolveHomeHostFact: (signal) => {
                probeCapture.signal = signal;
                return new Promise<never>(() => {});
            },
        }), async (app) => {
            const response = await app.inject({
                method: 'GET', url: '/v1/features/authenticated', headers: { 'x-test-user-id': 'account_1' },
            });
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json().homeHostFact).toEqual({ kind: 'unknown' });
        });
        expect(probeCapture.signal?.aborted).toBe(true);
    });

    afterEach(async () => {
        serverIdentityOverride.value = null;
        resetPublicServerUrlInferenceCacheForTests();
        // The Home governance row is the one piece of shared state a case writes.
        await db.homeGovernancePolicy.deleteMany({});
        await db.homeSettings.deleteMany({});
        resetEnv();
        await rm(descriptorContinuityDir, { recursive: true, force: true });
        descriptorContinuityDir = "";
    });

    it("projects the single Home search lifecycle from indexing to ready", async () => {
        let capability: HomeSearchCapabilities = {
            enabled: false,
            reason: "indexing" as const,
        };
        const resolveCapability = () => capability;

        const indexing = await getFeaturesPayload({}, undefined, resolveCapability);
        expect(indexing.payload.capabilities.homeSearch).toEqual(capability);

        capability = { enabled: true };
        const ready = await getFeaturesPayload({}, undefined, resolveCapability);
        expect(ready.payload.capabilities.homeSearch).toEqual({ enabled: true });
    });

    it("publishes the persisted Home name across devices without presenting it as an Account Service", async () => {
        await db.homeSettings.create({
            data: { id: "home", revision: 1, values: { HAPPIER_HOME_DISPLAY_NAME: "Studio" } },
        });
        const { featuresRoutes } = await import("./featuresRoutes");
        await withAuthenticatedTestApp((app) => featuresRoutes(app), async (app) => {
            const response = await app.inject({ method: "GET", url: "/v1/features" });
            expect(response.statusCode, response.body).toBe(200);
            const payload = response.json();
            expect(payload.homePresentation).toEqual({ v: 1, displayName: "Studio" });
            expect(payload.accountServicePresentation).toBeUndefined();
            await db.homeSettings.update({
                where: { id: 'home' }, data: { revision: 2, values: { HAPPIER_HOME_DISPLAY_NAME: 'Northwind' } },
            });
            const renamed = await app.inject({ method: 'GET', url: '/v1/features' });
            expect(renamed.statusCode).toBe(200);
            expect(renamed.json().homePresentation).toEqual({ v: 1, displayName: 'Northwind' });
            expect(renamed.headers['cache-control']).toBe('no-store');
        });
    });

    it.each(['external', 'self'] as const)('publishes policy and own presentation through serialized HTTP for %s', async (mode) => {
        process.env.HAPPIER_AUTH_SIGN_IN_SERVICE_MODE = mode;
        process.env.HAPPIER_ACCOUNT_SERVICE_DISPLAY_NAME = 'This service';
        process.env.HANDY_MASTER_SECRET = 'features-publication-test-secret';
        if (mode === 'external') {
            process.env.HAPPIER_AUTH_SIGN_IN_SERVICE_URL = 'https://accounts.example.test';
            process.env.HAPPIER_AUTH_SIGN_IN_SERVICE_SERVER_IDENTITY_ID = 'srv_accounts';
        }
        const { featuresRoutes } = await import('./featuresRoutes');
        await withAuthenticatedTestApp((app) => featuresRoutes(app), async (app) => {
            const response = await app.inject({ method: 'GET', url: '/v1/features' });
            expect(response.statusCode, response.body).toBe(200);
            const payload = response.json();
            expect(payload.signInService).toEqual(mode === 'self' ? { v: 1, mode } : {
                v: 1,
                mode,
                endpoint: 'https://accounts.example.test',
                expectedServerIdentityId: 'srv_accounts',
            });
            expect(payload.accountServicePresentation).toEqual({ v: 1, displayName: 'This service' });
            expect(payload.capabilities.auth.methods).toBeDefined();
        });
    });

    it('projects legacy auth methods from the persisted Home decision', async () => {
        process.env.AUTH_REQUIRED_LOGIN_PROVIDERS = '';
        process.env.HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED = '1';
        process.env.HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED = '1';
        process.env.HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED = '1';
        process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY = 'optional';
        const { featuresRoutes } = await import('./featuresRoutes');
        await withAuthenticatedTestApp((app) => featuresRoutes(app), async (app) => {
            await db.homeGovernancePolicy.create({
                data: {
                    id: 'home',
                    authenticationPolicy: { v: 1, enabledMethodIds: ['email_password'] },
                },
            });
            const response = await app.inject({ method: 'GET', url: '/v1/features' });
            expect(response.statusCode, response.body).toBe(200);
            const auth = response.json().capabilities.auth;
            expect(auth.methods.find((method: { id: string }) => method.id === 'key_challenge')
                ?.actions.every((action: { enabled: boolean }) => !action.enabled)).toBe(true);
            expect(auth.login.methods.find((method: { id: string }) => method.id === 'key_challenge'))
                .toEqual({ id: 'key_challenge', enabled: false });
            // The approved all-component 0.3 upgrade does not support mixed
            // 0.2/0.3 operation, so native password is published like every
            // other effective method; old-reader omission is not required.
            expect(auth.methods.find((method: { id: string }) => method.id === 'email_password')
                ?.actions.find((action: { id: string }) => action.id === 'login'))
                .toMatchObject({ id: 'login', enabled: true });
        });
    });

    it('omits the structured catalog and fails legacy actions closed when Home auth policy is unreadable', async () => {
        process.env.AUTH_REQUIRED_LOGIN_PROVIDERS = '';
        process.env.HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED = '1';
        const priorSignup = resolveFeaturesFromEnv(process.env).capabilities.auth.signup;
        const { featuresRoutes } = await import('./featuresRoutes');
        await withAuthenticatedTestApp((app) => featuresRoutes(app), async (app) => {
            await db.homeGovernancePolicy.create({
                data: {
                    id: 'home',
                    authenticationPolicy: { v: 999, enabledMethodIds: ['key_challenge'] },
                },
            });
            const response = await app.inject({ method: 'GET', url: '/v1/features' });
            expect(response.statusCode, response.body).toBe(200);
            const auth = response.json().capabilities.auth;
            expect(auth).not.toHaveProperty('methods');
            expect(auth.signup).toEqual(priorSignup);
            expect(auth.login.methods.every((method: { enabled: boolean }) => !method.enabled)).toBe(true);
        });
    });

    it('keeps public features available and omits auth methods when the policy store is unavailable', async () => {
        const originalTransaction = db.$transaction;
        db.$transaction = (async () => {
            throw new Error('database unavailable');
        }) as typeof db.$transaction;
        try {
            const priorSignup = resolveFeaturesFromEnv(process.env).capabilities.auth.signup;
            const { featuresRoutes } = await import('./featuresRoutes');
            await withAuthenticatedTestApp((app) => featuresRoutes(app), async (app) => {
                const logError = vi.spyOn(app.log, 'error');
                const response = await app.inject({ method: 'GET', url: '/v1/features' });
                expect(response.statusCode, response.body).toBe(200);
                const auth = response.json().capabilities.auth;
                expect(auth).not.toHaveProperty('methods');
                expect(auth.signup).toEqual(priorSignup);
                expect(auth.login.methods.every((method: { enabled: boolean }) => !method.enabled)).toBe(true);
                expect(logError).toHaveBeenCalledOnce();
            });
        } finally {
            db.$transaction = originalTransaction;
        }
    });

    it('publishes the persisted Home sign-in-service narrowing instead of the deployment value', async () => {
        process.env.AUTH_REQUIRED_LOGIN_PROVIDERS = '';
        process.env.HAPPIER_AUTH_SIGN_IN_SERVICE_MODE = 'external';
        process.env.HAPPIER_AUTH_SIGN_IN_SERVICE_URL = 'https://accounts.example.test';
        process.env.HAPPIER_AUTH_SIGN_IN_SERVICE_SERVER_IDENTITY_ID = 'srv_accounts';
        const { featuresRoutes } = await import('./featuresRoutes');
        await withAuthenticatedTestApp((app) => featuresRoutes(app), async (app) => {
            await db.homeGovernancePolicy.create({
                data: {
                    id: 'home',
                    authenticationPolicy: { v: 1, signInService: { mode: 'disabled' } },
                },
            });
            const response = await app.inject({ method: 'GET', url: '/v1/features' });
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json().signInService).toEqual({ v: 1, mode: 'disabled' });
        });
    });

    it("advertises Home unavailability but makes no Home claim when no lifecycle is composed", async () => {
        const unavailable = await getFeaturesPayload({}, undefined, () => ({
            enabled: false,
            reason: "index_unavailable",
        }));
        expect(unavailable.payload.capabilities.homeSearch).toEqual({
            enabled: false,
            reason: "index_unavailable",
        });

        const nonPlain = await getFeaturesPayload();
        expect(nonPlain.payload.capabilities).not.toHaveProperty("homeSearch");
    });

    it("returns the browser sidecar feature branch enabled in the live feature payload", async () => {
        const { payload } = await getFeaturesPayload();

        expect(payload.features.browser).toBeDefined();
        expect(readServerEnabledBit(payload, "browser")).toBe(true);
        expect(readServerEnabledBit(payload, "browser.internal")).toBe(true);
        expect(readServerEnabledBit(payload, "browser.sidecar")).toBe(true);
        expect(readServerEnabledBit(payload, "browser.diagnostics")).toBe(true);
        expect(readServerEnabledBit(payload, "browser.automation")).toBe(true);
        expect(readServerEnabledBit(payload, "browser.context")).toBe(true);
        expect(readServerEnabledBit(payload, "browser.recording")).toBe(true);
    });

    it("publishes the external-session import publication fence in the live feature payload", async () => {
        const { payload } = await getFeaturesPayload();

        expect(payload.capabilities.session.externalImport).toEqual({
            publicationFenceVersion: 3,
        });
    });

    describe("server identity", () => {
        it("returns a compatibility-safe server identity capability", async () => {
            resetEnv({
                HAPPIER_SERVER_IDENTITY_ID: "srv_routeIdentity123",
            });

            const { payload } = await getFeaturesPayload();
            expect(payload.capabilities.serverIdentity).toEqual({
                serverIdentityId: "srv_routeIdentity123",
            });
            expect(payload.capabilities.server).not.toHaveProperty("serverIdentityId");
        });

        it("keeps the route usable without initialized identity storage", async () => {
            const { payload } = await getFeaturesPayload();

            expect(payload.capabilities.serverIdentity).toEqual({
                serverIdentityId: null,
            });
        });

        it("reads from the process hot-path cache without invoking storage-backed resolution", async () => {
            const getOrCreateServerIdentityId = vi.fn(async () => "srv_storageResolver123");
            const readCachedServerIdentityIdForHotPath = vi.fn(() => "srv_hotCache123");

            const { payload } = await getFeaturesPayload({}, {
                getOrCreateServerIdentityId,
                readPinnedServerIdentityId: () => null,
                readCachedServerIdentityIdForHotPath,
            });

            expect(payload.capabilities.serverIdentity).toEqual({
                serverIdentityId: "srv_hotCache123",
            });
            expect(readCachedServerIdentityIdForHotPath).toHaveBeenCalledTimes(1);
            expect(getOrCreateServerIdentityId).not.toHaveBeenCalled();
        });
    });

    describe("home iroh endpoint publication", () => {
        const activeSnapshot = {
            endpoint: {
                endpointId: "a".repeat(64),
                relayUrls: ["https://relay.example.test"],
                directAddresses: ["192.168.1.10:4242"],
            },
        } satisfies NonNullable<HomeIrohEndpointState["snapshot"]>;

        const activeState = (): HomeIrohEndpointState => ({
            status: "active",
            snapshot: activeSnapshot,
            failureReason: null,
        });

        it("does not publish an uncommitted descriptor during public feature discovery", async () => {
            let persisted: string | null = null;
            resetEnv({
                DATABASE_URL: "postgresql://relay.example.test/happier",
                HAPPIER_SERVER_FLAVOR: "full",
                HAPPIER_DB_PROVIDER: "postgres",
                HAPPIER_FILES_BACKEND: "s3",
                HAPPIER_PUBLIC_SERVER_URL: "https://relay.example.test",
                HAPPIER_SERVER_IDENTITY_ID: "srv_accountService",
            });

            const { payload } = await getFeaturesPayload(
                {},
                undefined,
                undefined,
                undefined,
                createSimpleCacheHomeConnectionDescriptorContinuityStore({
                    readSimpleCache: async () => persisted,
                    compareAndSetSimpleCache: async (_key, expectedValue, value) => {
                        if (persisted !== expectedValue) return false;
                        persisted = value;
                        return true;
                    },
                }),
            );

            expect(payload.capabilities.serverIdentity).toEqual({
                serverIdentityId: "srv_accountService",
            });
            expect(payload).not.toHaveProperty("homeConnectionDescriptor");
            expect(persisted).toBeNull();
        });

        it("does not derive a public descriptor from live endpoint facts", async () => {
            resetEnv({ HAPPIER_SERVER_IDENTITY_ID: "srv_routeIrohHome" });
            const { payload, reply } = await getFeaturesPayload(
                { headers: { authorization: "Bearer ignored-on-public-projection" } },
                undefined,
                undefined,
                activeState,
            );

            expect(payload).not.toHaveProperty("homeConnectionDescriptor");
            expect(activeSnapshot.endpoint.directAddresses).toEqual(["192.168.1.10:4242"]);
            expect(reply.headers["Cache-Control"]).toBe("no-store");
        });

        it("keeps public feature discovery read-only until an authoritative descriptor is committed", async () => {
            resetEnv({ HAPPIER_SERVER_IDENTITY_ID: "srv_publicReadOnly" });
            let persisted: string | null = null;
            const write = vi.fn(async () => {
                persisted = '{"revision":1}';
                return {
                    status: "committed" as const,
                    continuity: {
                        revision: 1,
                        contentKey: "v1:i:" + "a".repeat(64),
                    },
                };
            });
            const store = {
                read: async () => null,
                write,
            } satisfies HomeConnectionDescriptorContinuityStore;

            const { payload } = await getFeaturesPayload(
                {},
                undefined,
                undefined,
                activeState,
                store,
            );

            expect(payload).not.toHaveProperty("homeConnectionDescriptor");
            expect(write).not.toHaveBeenCalled();
            expect(persisted).toBeNull();
        });

        it("publishes the full identity-bound descriptor only from the authenticated features route", async () => {
            resetEnv({
                HAPPIER_SERVER_IDENTITY_ID: "srv_routeIrohHome",
                HAPPIER_CANONICAL_SERVER_URL: "https://home.example.test",
            });
            const { featuresRoutes } = await import("./featuresRoutes");
            const route = createRouteTestBuilder({
                method: "GET",
                path: "/v1/features/authenticated",
                registerRoutes(app) {
                    app.authenticate.mockImplementation(async (request: any) => {
                        request.userId = "account_1";
                        request.authTokenKind = request.headers.authorization === "Bearer restricted-runner-token"
                            ? "ephemeral_session_runner"
                            : "account";
                    });
                    featuresRoutes(app as any, {
                        resolveHomeIrohEndpointState: activeState,
                        homeConnectionDescriptorContinuityStore:
                            createFileHomeConnectionDescriptorContinuityStore(descriptorContinuityPath()),
                    });
                },
            });

            const { response, reply } = await route.invoke({
                headers: { authorization: "Bearer trusted-home-token" },
            });

            expect(response).toMatchObject({
                capabilities: {
                    serverIdentity: { serverIdentityId: "srv_routeIrohHome" },
                },
                homeConnectionDescriptor: {
                    v: 1,
                    homeServerIdentityId: "srv_routeIrohHome",
                    revision: 1,
                    endpoints: [{
                        kind: "iroh",
                        endpointId: "a".repeat(64),
                        directAddresses: ["192.168.1.10:4242"],
                    }],
                },
            });
            expect(route.app.authenticate).toHaveBeenCalledTimes(1);
            expect(reply.headers["Cache-Control"]).toBe("no-store");

            const restricted = await route.invoke({
                headers: { authorization: "Bearer restricted-runner-token" },
            });
            expect((restricted.response as any).homeConnectionDescriptor).toMatchObject({
                homeServerIdentityId: "srv_routeIrohHome",
                endpoints: [{
                    kind: "iroh",
                    endpointId: "a".repeat(64),
                    relayUrls: ["https://relay.example.test"],
                }],
            });
            expect((restricted.response as any).homeConnectionDescriptor.endpoints[0])
                .not.toHaveProperty("directAddresses");
            expect(route.app.authenticate).toHaveBeenCalledTimes(2);
        });

        it("publishes a Home-stored public address in the descriptor, never as the sign-in audience (§3.2, I1)", async () => {
            resetEnv({
                HAPPIER_SERVER_IDENTITY_ID: "srv_storedAddressHome",
                HAPPIER_CANONICAL_SERVER_URL: undefined,
            });
            await db.homeSettings.create({
                data: { id: "home", revision: 1, values: { HAPPIER_PUBLIC_SERVER_URL: "https://stored.example.test" } },
            });
            try {
                const { featuresRoutes } = await import("./featuresRoutes");
                const route = createRouteTestBuilder({
                    method: "GET",
                    path: "/v1/features/authenticated",
                    registerRoutes(app) {
                        app.authenticate.mockImplementation(async (request: any) => {
                            request.userId = "account_1";
                            request.authTokenKind = "account";
                        });
                        featuresRoutes(app as any, {
                            resolveHomeIrohEndpointState: () => ({ status: "unavailable", snapshot: null, failureReason: null }),
                            homeConnectionDescriptorContinuityStore:
                                createFileHomeConnectionDescriptorContinuityStore(descriptorContinuityPath()),
                        });
                    },
                });
                const { response } = await route.invoke({ headers: { authorization: "Bearer trusted-home-token" } });
                // A stored address is ingress only: with no deployment canonical address there is no
                // audience, so no descriptor, and the stored address is never promoted to one.
                expect((response as any).capabilities.server.canonicalServerUrl).toBeUndefined();
                expect(response).not.toHaveProperty("homeConnectionDescriptor");

                resetEnv({
                    HAPPIER_SERVER_IDENTITY_ID: "srv_storedAddressHome",
                    HAPPIER_CANONICAL_SERVER_URL: "https://home.example.test",
                });
                const published = await route.invoke({ headers: { authorization: "Bearer trusted-home-token" } });
                expect((published.response as any).capabilities.server.canonicalServerUrl).toBe("https://home.example.test");
                expect((published.response as any).homeConnectionDescriptor).toMatchObject({
                    canonicalServerUrl: "https://home.example.test",
                    endpoints: [{ kind: "https", url: "https://stored.example.test" }],
                });
            } finally {
                await db.homeSettings.deleteMany({});
            }
        });

        it("binds an authenticated descriptor to the current server identity", async () => {
            resetEnv({
                HAPPIER_SERVER_IDENTITY_ID: "srv_differentHome",
                HAPPIER_CANONICAL_SERVER_URL: "https://home.example.test",
            });
            const { featuresRoutes } = await import("./featuresRoutes");
            const route = createRouteTestBuilder({
                method: "GET",
                path: "/v1/features/authenticated",
                registerRoutes(app) {
                    app.authenticate.mockImplementation(async (request: any) => {
                        request.userId = "account_1";
                        request.authTokenKind = "account";
                    });
                    featuresRoutes(app as any, {
                        resolveHomeIrohEndpointState: activeState,
                        homeConnectionDescriptorContinuityStore:
                            createFileHomeConnectionDescriptorContinuityStore(descriptorContinuityPath()),
                    });
                },
            });

            const { response } = await route.invoke({
                headers: { authorization: "Bearer trusted-home-token" },
            });

            expect((response as any).capabilities.serverIdentity.serverIdentityId).toBe("srv_differentHome");
            expect((response as any).homeConnectionDescriptor?.homeServerIdentityId).toBe("srv_differentHome");
        });

        it("omits the descriptor for not-composed, unavailable, and failed states", async () => {
            for (const state of [
                { status: "not-composed", snapshot: null, failureReason: null },
                { status: "unavailable", snapshot: null, failureReason: null },
                { status: "failed", snapshot: null, failureReason: "native_error" },
            ] as const satisfies readonly HomeIrohEndpointState[]) {
                const { payload } = await getFeaturesPayload({}, undefined, undefined, () => state);
                expect(payload).not.toHaveProperty("homeConnectionDescriptor");
            }
        });

        it("does not allocate a descriptor for an uncommitted HTTPS ingress on public discovery", async () => {
            resetEnv({
                HAPPIER_CANONICAL_SERVER_URL: "http://127.0.0.1:43123",
                HAPPIER_PUBLIC_SERVER_URL: "https://home.example.test/",
            });

            const { payload } = await getFeaturesPayload(
                {},
                {
                    getOrCreateServerIdentityId: async () => "srv_publicHttpsHome",
                    readPinnedServerIdentityId: () => "srv_publicHttpsHome",
                    readCachedServerIdentityIdForHotPath: () => "srv_publicHttpsHome",
                },
                undefined,
                () => ({ status: "not-composed", snapshot: null, failureReason: null }),
            );

            expect(payload).not.toHaveProperty("homeConnectionDescriptor");
        });

        it("reads endpoint state at request time and never serves a stale descriptor", async () => {
            resetEnv({
                HAPPIER_SERVER_IDENTITY_ID: "srv_routeIrohHome",
                HAPPIER_CANONICAL_SERVER_URL: "https://home.example.test",
            });
            let state: HomeIrohEndpointState = activeState();
            const { featuresRoutes } = await import("./featuresRoutes");
            const route = createRouteTestBuilder({
                method: "GET",
                path: "/v1/features/authenticated",
                registerRoutes(app) {
                    app.authenticate.mockImplementation(async (request: any) => {
                        request.userId = "account_1";
                        request.authTokenKind = "account";
                    });
                    featuresRoutes(app as any, {
                        resolveHomeIrohEndpointState: () => state,
                        homeConnectionDescriptorContinuityStore:
                            createFileHomeConnectionDescriptorContinuityStore(descriptorContinuityPath()),
                    });
                },
            });

            const first = await route.invoke({ headers: { authorization: "Bearer trusted-home-token" } });
            expect((first.response as any).homeConnectionDescriptor?.revision).toBe(1);

            state = {
                status: "active",
                snapshot: {
                    endpoint: {
                        ...activeSnapshot.endpoint,
                        relayUrls: ["https://new-relay.example.test"],
                    },
                },
                failureReason: null,
            };
            const second = await route.invoke({ headers: { authorization: "Bearer trusted-home-token" } });
            expect((second.response as any).homeConnectionDescriptor?.revision).toBe(2);
            expect((second.response as any).homeConnectionDescriptor?.endpoints?.[0]?.relayUrls)
                .toEqual(["https://new-relay.example.test"]);

            state = { status: "failed", snapshot: null, failureReason: "endpoint_key_lost" };
            const third = await route.invoke({ headers: { authorization: "Bearer trusted-home-token" } });
            expect((third.response as any)).not.toHaveProperty("homeConnectionDescriptor");
        });
    });

    describe("friends", () => {
        it("returns friends=false when HAPPIER_FEATURE_SOCIAL_FRIENDS__ENABLED is off", async () => {
            resetEnv({
                HAPPIER_FEATURE_SOCIAL_FRIENDS__ENABLED: "0",
                GITHUB_CLIENT_ID: "id",
                GITHUB_CLIENT_SECRET: "secret",
                GITHUB_REDIRECT_URL: "https://example.com/v1/oauth/github/callback",
            });

            const { payload } = await getFeaturesPayload();
            expect(payload.features.social.friends.enabled).toBe(false);
        });

        it("returns friends=true and allowUsername=true when HAPPIER_FEATURE_SOCIAL_FRIENDS__ALLOW_USERNAME is on", async () => {
            resetEnv({
                HAPPIER_FEATURE_SOCIAL_FRIENDS__ENABLED: "1",
                HAPPIER_FEATURE_SOCIAL_FRIENDS__ALLOW_USERNAME: "1",
                GITHUB_CLIENT_ID: undefined,
                GITHUB_CLIENT_SECRET: undefined,
                GITHUB_REDIRECT_URL: undefined,
                GITHUB_REDIRECT_URI: undefined,
            });

            const { payload } = await getFeaturesPayload();
            expect(payload.features.social.friends.enabled).toBe(true);
            expect(payload.capabilities.social.friends.allowUsername).toBe(true);
            expect(payload.capabilities.social.friends.requiredIdentityProviderId).toBeNull();
        });

        it("returns friends=false when identity provider is required but OAuth provider is not configured", async () => {
            resetEnv({
                HAPPIER_FEATURE_SOCIAL_FRIENDS__ENABLED: "1",
                HAPPIER_FEATURE_SOCIAL_FRIENDS__ALLOW_USERNAME: "0",
                GITHUB_CLIENT_ID: undefined,
                GITHUB_CLIENT_SECRET: undefined,
                GITHUB_REDIRECT_URL: undefined,
                GITHUB_REDIRECT_URI: undefined,
            });

            const { payload } = await getFeaturesPayload();
            expect(payload.features.social.friends.enabled).toBe(false);
            expect(payload.capabilities.social.friends.allowUsername).toBe(false);
            expect(payload.capabilities.social.friends.requiredIdentityProviderId).toBe("github");
        });
    });

    describe("auth provisioning restrictions", () => {
        it("disables signup methods for matching public requests", async () => {
            resetEnv({
                AUTH_ANONYMOUS_SIGNUP_ENABLED: "1",
                AUTH_SIGNUP_PROVIDERS: "github",
                GITHUB_CLIENT_ID: "id",
                GITHUB_CLIENT_SECRET: "secret",
                GITHUB_REDIRECT_URL: "https://example.com/v1/oauth/github/callback",
                HAPPIER_AUTH_PUBLIC_PROVISION_DENY_METHODS: "key_challenge,github",
                HAPPIER_AUTH_PUBLIC_PROVISION_DENY_MODES: "keyed",
            });

            const { payload } = await getFeaturesPayload({ ip: "203.0.113.10" });
            expect(payload.capabilities.auth.signup.methods).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ id: "anonymous", enabled: false }),
                    expect.objectContaining({ id: "github", enabled: false }),
                ]),
            );
        });
    });

    describe("voice", () => {
        it("returns voice=false when ElevenLabs is not configured", async () => {
            resetEnv({
                NODE_ENV: "production",
                HAPPIER_FEATURE_VOICE__ENABLED: "1",
                ELEVENLABS_API_KEY: undefined,
                ELEVENLABS_AGENT_ID_PROD: undefined,
            });

            const { payload } = await getFeaturesPayload();
            // Voice settings should remain available (local / BYO voice), even when Happier Voice is misconfigured.
            expect(payload.features.voice.enabled).toBe(true);
            expect(payload.features.voice.happierVoice.enabled).toBe(false);
            expect(payload.capabilities.voice.configured).toBe(false);
            expect(payload.capabilities.voice.provider).toBe(null);
        });

        it("returns voice=true when voice is enabled and ElevenLabs is configured", async () => {
            resetEnv({
                NODE_ENV: "production",
                HAPPIER_FEATURE_VOICE__ENABLED: "1",
                ELEVENLABS_API_KEY: "el_key",
                ELEVENLABS_AGENT_ID_PROD: "agent_1",
                REVENUECAT_SECRET_KEY: "rc_secret",
            });

            const { payload } = await getFeaturesPayload();
            expect(payload.features.voice.enabled).toBe(true);
            expect(payload.features.voice.happierVoice.enabled).toBe(true);
            expect(payload.capabilities.voice.configured).toBe(true);
            expect(payload.capabilities.voice.provider).toBe("elevenlabs");
        });

        it("returns voice=false when subscription is required and RevenueCat is not configured", async () => {
            resetEnv({
                NODE_ENV: "production",
                HAPPIER_FEATURE_VOICE__ENABLED: "1",
                ELEVENLABS_API_KEY: "el_key",
                ELEVENLABS_AGENT_ID_PROD: "agent_1",
                HAPPIER_FEATURE_VOICE__REQUIRE_SUBSCRIPTION: undefined,
                REVENUECAT_SECRET_KEY: undefined,
            });

            const { payload } = await getFeaturesPayload();
            expect(payload.features.voice.enabled).toBe(true);
            expect(payload.features.voice.happierVoice.enabled).toBe(false);
            expect(payload.capabilities.voice.configured).toBe(false);
            expect(payload.capabilities.voice.provider).toBe(null);
        });

        it("returns voice=true when subscription is not required even without RevenueCat", async () => {
            resetEnv({
                NODE_ENV: "production",
                HAPPIER_FEATURE_VOICE__ENABLED: "1",
                ELEVENLABS_API_KEY: "el_key",
                ELEVENLABS_AGENT_ID_PROD: "agent_1",
                HAPPIER_FEATURE_VOICE__REQUIRE_SUBSCRIPTION: "0",
                REVENUECAT_SECRET_KEY: undefined,
            });

            const { payload } = await getFeaturesPayload();
            expect(payload.features.voice.enabled).toBe(true);
            expect(payload.features.voice.happierVoice.enabled).toBe(true);
            expect(payload.capabilities.voice.configured).toBe(true);
            expect(payload.capabilities.voice.provider).toBe("elevenlabs");
        });
    });

    describe("oauth providers", () => {
        it("marks github as configured=false when GitHub env is missing", async () => {
            resetEnv({
                GITHUB_CLIENT_ID: undefined,
                GITHUB_CLIENT_SECRET: undefined,
                GITHUB_REDIRECT_URL: undefined,
                GITHUB_REDIRECT_URI: undefined,
            });

            const { payload } = await getFeaturesPayload();
            expect(payload.capabilities.oauth.providers.github.enabled).toBe(true);
            expect(payload.capabilities.oauth.providers.github.configured).toBe(false);
        });

        it("marks github as configured=true when GitHub env is configured", async () => {
            resetEnv({
                GITHUB_CLIENT_ID: "client_id",
                GITHUB_CLIENT_SECRET: "client_secret",
                GITHUB_REDIRECT_URL: "https://example.com/v1/oauth/github/callback",
            });

            const { payload } = await getFeaturesPayload();
            expect(payload.capabilities.oauth.providers.github.enabled).toBe(true);
            expect(payload.capabilities.oauth.providers.github.configured).toBe(true);
        });

        it("includes configured OIDC providers from AUTH_PROVIDERS_CONFIG_JSON", async () => {
            resetEnv({
                AUTH_PROVIDERS_CONFIG_JSON: JSON.stringify([
                    {
                        id: "Okta",
                        type: "oidc",
                        displayName: "Acme Okta",
                        issuer: "https://issuer.example.test",
                        clientId: "cid",
                        clientAuthenticationMethod: "client_secret_post",
                        clientSecret: "secret",
                        redirectUrl: "https://api.example.test/v1/oauth/okta/callback",
                    },
                ]),
            });

            const { payload } = await getFeaturesPayload();
            expect(payload.capabilities.oauth.providers.okta).toEqual(
                expect.objectContaining({
                    enabled: true,
                    configured: true,
                }),
            );
        });
    });

    describe("auth recovery + ui", () => {
        it("exposes provider reset as enabled when configured", async () => {
            resetEnv({
                AUTH_ANONYMOUS_SIGNUP_ENABLED: "0",
                AUTH_SIGNUP_PROVIDERS: "github",
                HAPPIER_FEATURE_AUTH_RECOVERY__PROVIDER_RESET_ENABLED: "1",
                GITHUB_CLIENT_ID: "id",
                GITHUB_CLIENT_SECRET: "secret",
                GITHUB_REDIRECT_URL: "https://example.com/oauth/github/callback",
            });

            const { payload } = await getFeaturesPayload();
            expect(payload.features.auth.recovery.providerReset.enabled).toBe(true);
            expect(payload.capabilities.auth.recovery.providerReset.providers).toContain("github");
        });

        it("exposes provider reset as disabled when HAPPIER_FEATURE_AUTH_RECOVERY__PROVIDER_RESET_ENABLED=0", async () => {
            resetEnv({
                AUTH_ANONYMOUS_SIGNUP_ENABLED: "0",
                AUTH_SIGNUP_PROVIDERS: "github",
                HAPPIER_FEATURE_AUTH_RECOVERY__PROVIDER_RESET_ENABLED: "0",
                GITHUB_CLIENT_ID: "id",
                GITHUB_CLIENT_SECRET: "secret",
                GITHUB_REDIRECT_URL: "https://example.com/oauth/github/callback",
            });

            const { payload } = await getFeaturesPayload();
            expect(payload.features.auth.recovery.providerReset.enabled).toBe(false);
            expect(payload.capabilities.auth.recovery.providerReset.providers).toEqual([]);
        });

        it("defaults recovery key reminder UI flag to enabled", async () => {
            const { payload } = await getFeaturesPayload();
            expect(payload.features.auth.ui.recoveryKeyReminder.enabled).toBe(true);
        });

        it("allows disabling recovery key reminder UI via HAPPIER_FEATURE_AUTH_UI__RECOVERY_KEY_REMINDER_ENABLED=0", async () => {
            resetEnv({
                HAPPIER_FEATURE_AUTH_UI__RECOVERY_KEY_REMINDER_ENABLED: "0",
            });

            const { payload } = await getFeaturesPayload();
            expect(payload.features.auth.ui.recoveryKeyReminder.enabled).toBe(false);
        });
    });

    describe("auth login", () => {
        it("reports key-challenge login enabled by default", async () => {
            const { payload } = await getFeaturesPayload();
            expect(payload.features.auth.login.keyChallenge.enabled).toBe(true);
            expect(payload.capabilities.auth.login.methods).toEqual(
                expect.arrayContaining([{ id: "key_challenge", enabled: true }]),
            );
        });

        it("reports key-challenge login disabled when HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED=0", async () => {
            resetEnv({
                HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "0",
            });

            const { payload } = await getFeaturesPayload();
            expect(payload.features.auth.login.keyChallenge.enabled).toBe(false);
            expect(payload.capabilities.auth.login.methods).toEqual(
                expect.arrayContaining([{ id: "key_challenge", enabled: false }]),
            );
        });

        it("disables provisioning actions for public requests and sets no-store", async () => {
            resetEnv({
                AUTH_ANONYMOUS_SIGNUP_ENABLED: "1",
                HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "1",
                HAPPIER_AUTH_PUBLIC_PROVISION_DENY_METHODS: "key_challenge",
            });

            const { payload, reply } = await getFeaturesPayload({ ip: "203.0.113.10" });
            const methods = payload?.capabilities?.auth?.methods ?? [];
            const keyChallenge = methods.find((m: any) => String(m?.id ?? "").toLowerCase() === "key_challenge");
            const provision = Array.isArray(keyChallenge?.actions)
                ? keyChallenge.actions.find((a: any) => a?.id === "provision" && a?.mode === "keyed")
                : null;
            expect(provision).toEqual(expect.objectContaining({ enabled: false }));
            expect(reply.headers["Cache-Control"]).toBe("no-store");
        });

        it("keeps provisioning enabled for private requests", async () => {
            resetEnv({
                AUTH_ANONYMOUS_SIGNUP_ENABLED: "1",
                HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "1",
                HAPPIER_AUTH_PUBLIC_PROVISION_DENY_METHODS: "key_challenge",
            });

            const { payload } = await getFeaturesPayload({ ip: "10.0.0.5" });
            const methods = payload?.capabilities?.auth?.methods ?? [];
            const keyChallenge = methods.find((m: any) => String(m?.id ?? "").toLowerCase() === "key_challenge");
            const provision = Array.isArray(keyChallenge?.actions)
                ? keyChallenge.actions.find((a: any) => a?.id === "provision" && a?.mode === "keyed")
                : null;
            expect(provision).toEqual(expect.objectContaining({ enabled: true }));
        });
    });

    describe("auth mtls", () => {
        it("exposes mtls policy details under capabilities.auth.mtls.policy", async () => {
            resetEnv({
                HAPPIER_FEATURE_AUTH_MTLS__ENABLED: "1",
                HAPPIER_FEATURE_AUTH_MTLS__MODE: "forwarded",
                HAPPIER_FEATURE_AUTH_MTLS__TRUST_FORWARDED_HEADERS: "1",
                HAPPIER_FEATURE_AUTH_MTLS__ALLOWED_ISSUERS: "CN=Example Root CA\ncn=Example Intermediate CA",
                HAPPIER_FEATURE_AUTH_MTLS__ALLOWED_EMAIL_DOMAINS: "example.com, example.org",
            });

            const { payload } = await getFeaturesPayload();
            expect(payload.capabilities.auth.mtls).toEqual(
                expect.objectContaining({
                    policy: {
                        trustForwardedHeaders: true,
                        issuerAllowlist: { enabled: true, count: 2 },
                        emailDomainAllowlist: { enabled: true, count: 2 },
                    },
                }),
            );
        });
    });

    describe("encryption", () => {
        it("reports required_e2ee by default", async () => {
            const { payload } = await getFeaturesPayload();
            expect(payload.features.encryption.plaintextStorage.enabled).toBe(false);
            expect(payload.features.encryption.accountOptOut.enabled).toBe(false);
            expect(payload.capabilities.encryption).toMatchObject({
                storagePolicy: "required_e2ee",
                allowAccountOptOut: false,
                defaultAccountMode: "e2ee",
                plainAccountSettingsAtRest: "server_sealed",
                plainAccountCredentialsAtRest: "server_sealed",
            });
        });

        it("reports plaintext storage enabled when policy is optional", async () => {
            resetEnv({
                HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
                HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
                HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            });

            const { payload } = await getFeaturesPayload();
            expect(payload.features.encryption.plaintextStorage.enabled).toBe(true);
            expect(payload.features.encryption.accountOptOut.enabled).toBe(true);
            expect(payload.capabilities.encryption).toMatchObject({
                storagePolicy: "optional",
                allowAccountOptOut: true,
                defaultAccountMode: "plain",
                plainAccountSettingsAtRest: "server_sealed",
                plainAccountCredentialsAtRest: "server_sealed",
            });
        });
    });

    describe("auth misconfiguration", () => {
        it("surfaces misconfig when AUTH_PROVIDERS_CONFIG_JSON is invalid", async () => {
            resetEnv({
                AUTH_PROVIDERS_CONFIG_JSON: "{ definitely: not-json }",
            });

            const { payload } = await getFeaturesPayload();
            expect(payload.capabilities.auth.misconfig).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        code: "auth_providers_config_invalid",
                        kind: "auth-providers-config",
                        envVars: expect.arrayContaining(["AUTH_PROVIDERS_CONFIG_JSON"]),
                    }),
                ]),
            );
        });

        it("surfaces misconfig when required login providers reference unregistered provider", async () => {
            resetEnv({
                AUTH_REQUIRED_LOGIN_PROVIDERS: "okta",
            });

            const { payload } = await getFeaturesPayload();
            expect(payload.capabilities.auth.login.requiredProviders).toEqual(["okta"]);
            expect(payload.capabilities.auth.misconfig).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        code: "auth_provider_unregistered_okta",
                        kind: "auth-provider-unregistered",
                        providerId: "okta",
                        envVars: expect.arrayContaining(["AUTH_PROVIDERS_CONFIG_PATH", "AUTH_PROVIDERS_CONFIG_JSON"]),
                    }),
                ]),
            );
        });
    });

    describe("bug reports", () => {
        it("returns bug report capability enabled by default", async () => {
            resetEnv({
                HAPPIER_FEATURE_BUG_REPORTS__ENABLED: undefined,
                HAPPIER_FEATURE_BUG_REPORTS__PROVIDER_URL: undefined,
                HAPPIER_FEATURE_BUG_REPORTS__DEFAULT_INCLUDE_DIAGNOSTICS: undefined,
            });

            const { payload } = await getFeaturesPayload();
            expect(payload.features.bugReports.enabled).toBe(true);
            expect(payload.capabilities.bugReports.providerUrl).toBe("https://reports.happier.dev");
            expect(payload.capabilities.bugReports.defaultIncludeDiagnostics).toBe(true);
            expect(payload.capabilities.bugReports.contextWindowMs).toBe(30 * 60 * 1000);
        });

        it("allows disabling bug report capability via env", async () => {
            resetEnv({
                HAPPIER_FEATURE_BUG_REPORTS__ENABLED: "0",
                HAPPIER_FEATURE_BUG_REPORTS__PROVIDER_URL: "https://reports.enterprise.local",
                HAPPIER_FEATURE_BUG_REPORTS__DEFAULT_INCLUDE_DIAGNOSTICS: "0",
                HAPPIER_FEATURE_BUG_REPORTS__CONTEXT_WINDOW_MS: "60000",
            });

            const { payload } = await getFeaturesPayload();
            expect(payload.features.bugReports.enabled).toBe(false);
            expect(payload.capabilities.bugReports.providerUrl).toBe("https://reports.enterprise.local");
            expect(payload.capabilities.bugReports.defaultIncludeDiagnostics).toBe(false);
            expect(payload.capabilities.bugReports.contextWindowMs).toBe(60000);
        });

        it("fails closed when provider url env is invalid", async () => {
            resetEnv({
                HAPPIER_FEATURE_BUG_REPORTS__PROVIDER_URL: "invalid-provider-url",
            });

            const { payload } = await getFeaturesPayload();
            expect(payload.features.bugReports.enabled).toBe(false);
            expect(payload.capabilities.bugReports.providerUrl).toBeNull();
        });
    });

    describe("automations", () => {
        it("returns automations enabled by default", async () => {
            resetEnv({
                HAPPIER_FEATURE_AUTOMATIONS__ENABLED: undefined,
            });

            const { payload } = await getFeaturesPayload();
            expect(payload.features.automations.enabled).toBe(true);
        });
    });

    describe("connected services", () => {
        it("defaults connectedServices.enabled to true", async () => {
            const { payload } = await getFeaturesPayload();
            expect(payload.features.connectedServices.enabled).toBe(true);
        });

        it("keeps the compatibility-only connectedServices.enabled bit true when the retired env is off", async () => {
            resetEnv({
                HAPPIER_FEATURE_CONNECTED_SERVICES__ENABLED: "0",
            });
            const { payload } = await getFeaturesPayload();
            expect(payload.features.connectedServices.enabled).toBe(true);
        });

        it("defaults connectedServices.quotas.enabled to true", async () => {
            const { payload } = await getFeaturesPayload();
            expect(payload.features.connectedServices.quotas.enabled).toBe(true);
        });

        it("returns connectedServices.quotas.enabled=false when HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED is off", async () => {
            resetEnv({
                HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "0",
            });
            const { payload } = await getFeaturesPayload();
            expect(payload.features.connectedServices.quotas.enabled).toBe(false);
        });

        it("prunes transitive dependents in the /v1/features payload when sessions are build-disabled", async () => {
            resetEnv({
                HAPPIER_BUILD_FEATURES_DENY: "sessions",
            });

            const { payload } = await getFeaturesPayload();

            expect(payload.features.sessions.enabled).toBe(false);
            expect(payload.features.sessions.usageLimitRecovery.enabled).toBe(false);
            expect(payload.features.connectedServices.accountFallback.enabled).toBe(false);
        });
    });

    describe("server url capabilities", () => {
        it("exposes canonicalServerUrl + webappUrl when configured via env", async () => {
            resetEnv({
                HAPPIER_CANONICAL_SERVER_URL: "http://127.0.0.1:43123/",
                HAPPIER_PUBLIC_SERVER_URL: "https://stack.example.test/",
                HAPPIER_WEBAPP_URL: "https://ui.example.test/",
            });

            const { payload } = await getFeaturesPayload();
            expect(payload.capabilities.server.canonicalServerUrl).toBe("http://127.0.0.1:43123");
            expect(payload.capabilities.server.webappUrl).toBe("https://ui.example.test");
        });

        it("never promotes inferred public ingress to canonicalServerUrl", async () => {
            const { chmod, mkdir, mkdtemp, rm, writeFile } = await import("node:fs/promises");
            const { tmpdir } = await import("node:os");
            const { join } = await import("node:path");

            const homeDir = await mkdtemp(join(tmpdir(), "happier-features-home-"));
            const binDir = await mkdtemp(join(tmpdir(), "happier-features-bin-"));
            try {
                const tailscaleBin = join(binDir, "tailscale");
                await writeFile(
                    tailscaleBin,
                    [
                        "#!/usr/bin/env bash",
                        "set -euo pipefail",
                        'if [[ "${1:-}" == "status" && "${2:-}" == "--json" ]]; then',
                        "  cat <<'JSON'",
                        '{"BackendState":"Running","HaveNodeKey":true,"Self":{"DNSName":"my-machine.tailnet.ts.net"}}',
                        "JSON",
                        "  exit 0",
                        "fi",
                        'if [[ "${1:-}" == "funnel" && "${2:-}" == "status" ]]; then',
                        "  cat <<'TXT'",
                        "https://my-machine.tailnet.ts.net",
                        "|-- / proxy http://127.0.0.1:3005",
                        "TXT",
                        "  exit 0",
                        "fi",
                        "echo \"unexpected args: $*\" >&2",
                        "exit 1",
                        "",
                    ].join("\n"),
                    "utf8",
                );
                await chmod(tailscaleBin, 0o755);
                await mkdir(join(homeDir, ".happier", "relay", "access"), { recursive: true });
                await writeFile(
                    join(homeDir, ".happier", "relay", "access", "local.json"),
                    JSON.stringify({ providerId: "tailscaleFunnel" }),
                    "utf8",
                );

                resetEnv({
                    HOME: homeDir,
                    HAPPIER_HOME_DIR: undefined,
                    HAPPIER_STACK_CLI_HOME_DIR: undefined,
                    HAPPIER_PUBLIC_SERVER_URL: undefined,
                    HAPPIER_TAILSCALE_BIN: tailscaleBin,
                    HAPPIER_TAILSCALE_INFER_PUBLIC_URL: "0",
                    HAPPIER_RELAY_ACCESS_INFER_PUBLIC_URL: "1",
                    PORT: "3005",
                });

                await expect(resolveInferredPublicServerAccess(process.env)).resolves.toMatchObject({
                    inferred: { url: "https://my-machine.tailnet.ts.net", source: "relay_access" },
                });

                const { payload } = await getFeaturesPayload();
                // Inference is read-only: the address reaches readers through the overlay, never the env.
                expect(process.env.HAPPIER_PUBLIC_SERVER_URL).toBeUndefined();
                expect(payload.capabilities.server.canonicalServerUrl).toBeUndefined();
            } finally {
                await rm(homeDir, { recursive: true, force: true });
                await rm(binDir, { recursive: true, force: true });
            }
        });

        it("does not infer canonicalServerUrl during the request when startup cache is cold", async () => {
            const { mkdtemp, mkdir, rm, writeFile } = await import("node:fs/promises");
            const { tmpdir } = await import("node:os");
            const { join } = await import("node:path");

            const homeDir = await mkdtemp(join(tmpdir(), "happier-features-home-"));
            const previousHome = process.env.HOME;
            process.env.HOME = homeDir;
            try {
                await mkdir(join(homeDir, ".happier", "relay", "access"), { recursive: true });
                await writeFile(
                    join(homeDir, ".happier", "relay", "access", "local.json"),
                    JSON.stringify({ providerId: "cloudflareNamed", hostname: "relay.example.test", token: "secret" }),
                    "utf8",
                );

                resetEnv({
                    HOME: homeDir,
                    HAPPIER_PUBLIC_SERVER_URL: undefined,
                    HAPPIER_RELAY_ACCESS_INFER_PUBLIC_URL: "1",
                    HAPPIER_TAILSCALE_INFER_PUBLIC_URL: "0",
                });

                const { payload } = await getFeaturesPayload();
                expect(payload.capabilities.server.canonicalServerUrl).toBeUndefined();
            } finally {
                process.env.HOME = previousHome;
                await rm(homeDir, { recursive: true, force: true });
            }
        });

        it("exposes canonicalServerUrl when only HAPPIER_PUBLIC_SERVER_URL is set", async () => {
            resetEnv({
                HAPPIER_PUBLIC_SERVER_URL: "https://stack.example.test/",
                HAPPIER_WEBAPP_URL: undefined,
            });

            const { payload } = await getFeaturesPayload();
            expect(payload.capabilities.server.canonicalServerUrl).toBe("https://stack.example.test");
            expect(payload.capabilities.server.webappUrl).toBeUndefined();
        });

        it("exposes webappUrl when only HAPPIER_WEBAPP_URL is set", async () => {
            resetEnv({
                HAPPIER_PUBLIC_SERVER_URL: undefined,
                HAPPIER_WEBAPP_URL: "https://ui.example.test/",
            });

            const { payload } = await getFeaturesPayload();
            expect(payload.capabilities.server.canonicalServerUrl).toBeUndefined();
            expect(payload.capabilities.server.webappUrl).toBe("https://ui.example.test");
        });

        it("derives webappUrl from public ingress when the server is serving UI at root", async () => {
            resetEnv({
                HAPPIER_CANONICAL_SERVER_URL: "http://127.0.0.1:43123/",
                HAPPIER_PUBLIC_SERVER_URL: "https://stack.example.test/",
                HAPPIER_WEBAPP_URL: undefined,
                HAPPIER_SERVER_UI_DIR: "/tmp/ui",
                HAPPIER_SERVER_UI_PREFIX: "/",
            });

            const { payload } = await getFeaturesPayload();
            expect(payload.capabilities.server.canonicalServerUrl).toBe("http://127.0.0.1:43123");
            expect(payload.capabilities.server.webappUrl).toBe("https://stack.example.test");
        });

        it("derives webappUrl from public ingress plus the UI prefix when the server is serving UI below root", async () => {
            resetEnv({
                HAPPIER_CANONICAL_SERVER_URL: "http://127.0.0.1:43123/",
                HAPPIER_PUBLIC_SERVER_URL: "https://stack.example.test/base/",
                HAPPIER_WEBAPP_URL: undefined,
                HAPPIER_SERVER_UI_DIR: "/tmp/ui",
                HAPPIER_SERVER_UI_PREFIX: "/ui/",
            });

            const { payload } = await getFeaturesPayload();
            expect(payload.capabilities.server.canonicalServerUrl).toBe("http://127.0.0.1:43123");
            expect(payload.capabilities.server.webappUrl).toBe("https://stack.example.test/base/ui");
        });

        it("strips userinfo/query/hash from advertised urls", async () => {
            resetEnv({
                HAPPIER_CANONICAL_SERVER_URL: "https://canonical:secret@identity.example.test/?q=1#frag",
                HAPPIER_PUBLIC_SERVER_URL: "https://user:pass@stack.example.test/?q=1#frag",
                HAPPIER_WEBAPP_URL: "https://user:pass@ui.example.test/app/?q=1#frag",
            });

            const { payload } = await getFeaturesPayload();
            expect(payload.capabilities.server.canonicalServerUrl).toBe("https://identity.example.test");
            expect(payload.capabilities.server.webappUrl).toBe("https://ui.example.test/app");
        });

        it("exposes retention capabilities when retention env is configured", async () => {
            resetEnv({
                HAPPIER_SERVER_RETENTION__ENABLED: "true",
                HAPPIER_SERVER_RETENTION__SESSIONS__MODE: "delete_inactive",
                HAPPIER_SERVER_RETENTION__SESSIONS__INACTIVITY_DAYS: "30",
                HAPPIER_SERVER_RETENTION__ACCOUNT_CHANGES__MODE: "delete_older_than",
                HAPPIER_SERVER_RETENTION__ACCOUNT_CHANGES__DAYS: "30",
            });

            const { payload } = await getFeaturesPayload();

            expect(payload.capabilities.server.retention).toMatchObject({
                policyVersion: 1,
                enabled: true,
                sessions: {
                    mode: "delete_inactive",
                    inactivityDays: 30,
                    requires: ["updatedAt", "lastActiveAt"],
                },
                accountChanges: {
                    mode: "delete_older_than",
                    days: 30,
                },
                voiceSessionLeases: {
                    mode: "keep_forever",
                },
            });
        });

        it("omits retention capabilities when retention is not effectively enabled", async () => {
            resetEnv({
                HAPPIER_SERVER_RETENTION__ENABLED: "false",
                HAPPIER_SERVER_RETENTION__SESSIONS__MODE: "delete_inactive",
                HAPPIER_SERVER_RETENTION__SESSIONS__INACTIVITY_DAYS: "30",
                HAPPIER_SERVER_RETENTION__ACCOUNT_CHANGES__MODE: "delete_older_than",
                HAPPIER_SERVER_RETENTION__ACCOUNT_CHANGES__DAYS: "30",
            });

            const { payload } = await getFeaturesPayload();

            expect(payload.capabilities.server.retention).toBeUndefined();
        });
    });
});
