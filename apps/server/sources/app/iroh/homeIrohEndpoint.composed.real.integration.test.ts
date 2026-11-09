import { readFile } from "node:fs/promises";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import Fastify from "fastify";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { io as ioClient } from "socket.io-client";
import * as privacyKit from "privacy-kit";
import tweetnacl from "tweetnacl";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
    createIrohNodeNativeModule,
    loadIrohNodeNative,
    loadIrohNodeNativeAddon,
} from "@happier-dev/iroh-native/node";
import { createIrohTestControllerFromNativeAddon } from "@happier-dev/iroh-native/test-controller";
import { resolvePersonalHomeRuntimeLayout } from "@happier-dev/cli-common/firstPartyRuntime";
import { FeaturesResponseSchema, type HomeConnectionDescriptorV1 } from "@happier-dev/protocol";
import {
    createEphemeralTlsServerFixture,
    type EphemeralTlsServerFixture,
} from "@happier-dev/tests/testkit/tls/ephemeralTlsServerFixture";

import { registerApiRoutes } from "@/app/api/api";
import { installHomeIrohIngress } from '@/app/api/irohIngress';
import { startSocket } from "@/app/api/socket";
import type { Fastify as AppFastify } from "@/app/api/types";
import { enableAuthentication } from "@/app/api/utils/enableAuthentication";
import { enableMonitoring } from "@/app/api/utils/enableMonitoring";
import { resolveApiRateLimitPluginOptions } from "@/app/api/utils/apiRateLimitPolicy";
import { auth } from "@/app/auth/auth";
import { initializeServerIdentityCache } from "@/app/serverIdentity/serverIdentity";
import { createHomeConnectionDescriptorContinuityStoreForServer } from "@/app/features/homeConnectionDescriptorContinuity";
import {
    readHomeConnectionDescriptor,
    resetHomeConnectionDescriptorRevisionOwnerForTests,
} from "@/app/features/homeConnectionDescriptorPublication";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { resolveBoundServerListener } from '@/app/runtime/startupReceipt';

import {
    ensureHomeIrohEndpoint,
    getHomeIrohEndpointState,
    stopHomeIrohEndpoint,
} from "./homeIrohEndpoint";
import {
    HOME_IROH_RELAY_POLICY_ENV_KEY,
    HOME_IROH_RELAY_URLS_ENV_KEY,
} from "./homeIrohEndpointConfig";
import { loadHomeIrohNativeLifecycleFromModule } from "./homeIrohNativeLifecycle";
import * as nativeLifecycleBoundary from './homeIrohNativeLifecycle';
import { prepareHomeIrohStartup } from './startup';

type TestDaemonIrohRuntime = Readonly<{
    available: boolean;
    ensureHomeTunnel?: (input: Readonly<{
        descriptor: HomeConnectionDescriptorV1;
    }>) => Promise<Readonly<{
        runtimeOrigin: string;
        observedPath: "direct" | "relay" | "unknown";
        release: () => Promise<void>;
    }>>;
    shutdown: () => Promise<void>;
}>;

type CreateTestDaemonIrohRuntime = (input: Readonly<{
    happyHomeDir: string;
    relayConfig: Readonly<{
        relayPolicy: "automatic" | "disabled";
        relayUrls: readonly string[];
    }>;
    native: ReturnType<typeof createIrohNodeNativeModule>;
}>) => Promise<TestDaemonIrohRuntime>;

async function loadTestDaemonIrohRuntimeFactory(): Promise<CreateTestDaemonIrohRuntime> {
    // This is a cross-process composition fixture. Resolve the CLI composition
    // root at runtime so the server package's source-only typecheck does not
    // absorb the CLI application's private source tree into its rootDir.
    const modulePath = "../../../../cli/src/daemon/peer/iroh/daemonMachineIrohRuntime";
    const module = await vi.importActual<Readonly<{
        createDaemonMachineIrohRuntime: CreateTestDaemonIrohRuntime;
    }>>(modulePath);
    return module.createDaemonMachineIrohRuntime;
}

type TestDaemonHomeTransport = Readonly<{
    carrier: "standard" | "iroh";
    observedPath: "direct" | "relay" | "unknown";
    release(): Promise<void>;
    verifyAuthenticated(token: string): Promise<Readonly<{ status: string; errorMessage?: string }>>;
}>;

type TestServerProfile = Readonly<{
    id: string;
    name: string;
    serverUrl: string;
    webappUrl: string;
    createdAt: number;
    updatedAt: number;
    lastUsedAt: number;
    homeConnectionDescriptor?: HomeConnectionDescriptorV1;
}>;

async function loadTestDaemonHomeTransportOwner(): Promise<(input: Readonly<{
    runtime: TestDaemonIrohRuntime;
    profile: TestServerProfile;
    token?: string;
    probe?: (input: Readonly<{
        serverUrl: string;
        token: string;
        expectedServerIdentityId: string;
    }>) => Promise<Readonly<{ status: "ready" }>>;
}>) => Promise<TestDaemonHomeTransport>> {
    // Same cross-process composition fixture rule as the daemon Iroh runtime
    // factory above: resolve the CLI-owned standard/Iroh Home transport
    // decision owner at runtime so the server package's source-only typecheck
    // does not absorb the CLI application's private source tree into rootDir.
    const modulePath = "../../../../cli/src/daemon/peer/iroh/daemonHomeIrohTransport";
    const module = await vi.importActual<Readonly<{
        prepareDaemonHomeIrohTransport: (input: Readonly<{
            runtime: TestDaemonIrohRuntime;
            profile: TestServerProfile;
            token?: string;
            probe?: (input: Readonly<{
                serverUrl: string;
                token: string;
                expectedServerIdentityId: string;
            }>) => Promise<Readonly<{ status: "ready" }>>;
        }>) => Promise<TestDaemonHomeTransport>;
    }>>(modulePath);
    return module.prepareDaemonHomeIrohTransport;
}

const CANONICAL_HOME_URL = "https://home-iroh-composed.invalid";

/**
 * Real TLS ingress material for the standard-carrier leg. It reuses the
 * repository's ephemeral TLS fixture instead of inventing certificate material,
 * and its trust stays scoped to the one agent and the one Socket.IO client
 * below: no global TLS relaxation and no process-wide CA injection.
 */
type TestTlsIngress = Readonly<{
    fixture: EphemeralTlsServerFixture;
    /** `cert` is one concatenated leaf+issuer chain, not a per-key cert list. */
    serverOptions: Readonly<{ key: Buffer; cert: Buffer }>;
    caCertificatePem: string;
    agent: HttpsAgent;
}>;

async function createTestTlsIngress(): Promise<TestTlsIngress> {
    const fixture = await createEphemeralTlsServerFixture();
    try {
        const [privateKey, leafCertificate, caCertificate] = await Promise.all([
            readFile(fixture.privateKeyPath),
            readFile(fixture.leafCertificatePath),
            readFile(fixture.caCertificatePath),
        ]);
        const caCertificatePem = caCertificate.toString("utf8");
        return {
            fixture,
            serverOptions: {
                key: privateKey,
                cert: Buffer.concat([leafCertificate, Buffer.from("\n"), caCertificate]),
            },
            caCertificatePem,
            // Trust is exactly this fixture CA, and certificate verification
            // stays on: a wrong or missing chain must fail the leg.
            agent: new HttpsAgent({ ca: caCertificatePem, rejectUnauthorized: true, keepAlive: false }),
        };
    } catch (error) {
        await fixture.cleanup().catch(() => undefined);
        throw error;
    }
}

type TlsHttpResponse = Readonly<{ status: number; body: unknown }>;

/**
 * One authenticated (or unauthenticated) application request that really
 * completes a TLS handshake against the ingress certificate above.
 */
async function requestOverTls(input: Readonly<{
    ingress: TestTlsIngress;
    url: string;
    method?: string;
    headers?: Readonly<Record<string, string>>;
    body?: string;
}>): Promise<TlsHttpResponse> {
    return await new Promise<TlsHttpResponse>((resolve, reject) => {
        const request = httpsRequest(
            input.url,
            {
                agent: input.ingress.agent,
                method: input.method ?? "GET",
                headers: { ...(input.headers ?? {}) },
            },
            (response) => {
                const chunks: Buffer[] = [];
                response.on("data", (chunk: Buffer) => chunks.push(chunk));
                response.on("error", reject);
                response.on("end", () => {
                    const raw = Buffer.concat(chunks).toString("utf8");
                    try {
                        resolve({
                            status: response.statusCode ?? 0,
                            body: raw.length > 0 ? JSON.parse(raw) : undefined,
                        });
                    } catch (error) {
                        reject(error);
                    }
                });
            },
        );
        request.on("error", reject);
        if (input.body !== undefined) request.write(input.body);
        request.end();
    });
}

function createProductionProtocolApp(options?: Readonly<{
    https?: Readonly<{ key: Buffer; cert: Buffer }>;
}>): AppFastify & { irohIngress: ReturnType<typeof installHomeIrohIngress> } {
    // `https` swaps the underlying Node server type; the composition below is
    // identical for both, so the ordinary instance type stays the local shape.
    const typed = (options?.https
        ? Fastify({ logger: false, https: { key: options.https.key, cert: options.https.cert } })
            .withTypeProvider<ZodTypeProvider>()
        : Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>()) as unknown as AppFastify;
    const irohIngress = installHomeIrohIngress(typed);
    typed.register(import("@fastify/rate-limit"), resolveApiRateLimitPluginOptions(process.env));
    typed.setValidatorCompiler(validatorCompiler);
    typed.setSerializerCompiler(serializerCompiler);
    enableMonitoring(typed);
    enableAuthentication(typed);
    startSocket(typed);
    registerApiRoutes(typed, {
        // Production startServer selects this durable owner once and passes it
        // into route composition. This lower-level real fixture must preserve
        // the same contract instead of relying on the retired request-time
        // Personal Home path discovery.
        homeConnectionDescriptorContinuityStore:
            createHomeConnectionDescriptorContinuityStoreForServer(process.env),
    });
    return Object.assign(typed, { irohIngress });
}

function waitForSocketConnection(socket: ReturnType<typeof ioClient>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error("Timed out waiting for Socket.IO connection"));
        }, 10_000);
        const cleanup = () => {
            clearTimeout(timeout);
            socket.off("connect", onConnect);
            socket.off("connect_error", onConnectError);
        };
        const onConnect = () => {
            cleanup();
            resolve();
        };
        const onConnectError = (error: unknown) => {
            cleanup();
            reject(error);
        };
        socket.on("connect", onConnect);
        socket.on("connect_error", onConnectError);
    });
}

async function waitForSocketApplicationReady(socket: ReturnType<typeof ioClient>): Promise<void> {
    // Socket.IO's client `connect` event proves the namespace handshake, but
    // it can race the server's application-listener installation. Events sent
    // in that narrow window are not replayed. Retry the production ping owner
    // until it acknowledges so this real-carrier fixture tests application
    // bytes instead of depending on listener-registration scheduling.
    await vi.waitFor(async () => {
        await expect(socket.timeout(1_000).emitWithAck("ping")).resolves.toEqual({});
    }, { timeout: 15_000, interval: 100 });
}

async function expectOriginDown(origin: string): Promise<void> {
    await expect(fetch(`${origin}/health`, { signal: AbortSignal.timeout(2_000) })).rejects.toThrow();
}

describe("composed Home Iroh application bytes", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-home-iroh-composed-",
            initAuth: true,
            initEncrypt: true,
            env: {
                HAPPIER_CANONICAL_SERVER_URL: CANONICAL_HOME_URL,
                HAPPIER_IROH_RELAY_POLICY: "disabled",
                AUTH_REQUIRED_LOGIN_PROVIDERS: "",
                AUTH_ANONYMOUS_SIGNUP_ENABLED: "0",
                AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: "0",
            },
        });
    }, 120_000);

    afterEach(async () => {
        await stopHomeIrohEndpoint();
        vi.restoreAllMocks();
        harness.resetEnv();
        vi.unstubAllGlobals();
        await db.machine.deleteMany();
        await db.account.deleteMany();
    });

    afterAll(async () => {
        await stopHomeIrohEndpoint();
        if (harness) await harness.close();
    });

    it.each([
        { topology: "direct" as const, expectedPath: "direct" as const, holder: false },
        { topology: "relay" as const, expectedPath: "relay" as const, holder: false },
        { topology: "direct" as const, expectedPath: "direct" as const, holder: true },
    ])("moves authenticated HTTP and WebSocket bytes through the production Home acceptor over $topology (redis-streams holder=$holder)", { timeout: 120_000 }, async ({ topology, expectedPath, holder }) => {
        expect(process.env.HAPPIER_IROH_REQUIRE_NODE_ADDON).toBe("1");
        const explicitAddonPath = process.env.HAPPIER_TEST_IROH_NODE_ADDON_PATH?.trim();
        if (!explicitAddonPath) {
            throw new Error("The real Iroh application-byte fixture requires an explicit test-feature addon path");
        }
        const rawAddon = loadIrohNodeNativeAddon(explicitAddonPath);
        const testController = createIrohTestControllerFromNativeAddon(rawAddon);
        if (topology === "direct") await testController.forceDirectOnly();
        else await testController.forceRelayOnly(process.env.HAPPIER_TEST_IROH_EXTERNAL_RELAY_URL);
        expect(testController.getObservedPath()).toBe("unknown");
        if (topology === "relay") {
            const relayUrl = testController.getTestRelayUrl();
            if (!relayUrl) throw new Error("Forced-relay native fixture did not publish its test relay URL");
            if (process.env.HAPPIER_TEST_IROH_EXTERNAL_RELAY_URL) {
                expect(relayUrl).toBe(process.env.HAPPIER_TEST_IROH_EXTERNAL_RELAY_URL);
            }
            process.env[HOME_IROH_RELAY_POLICY_ENV_KEY] = "automatic";
            process.env[HOME_IROH_RELAY_URLS_ENV_KEY] = relayUrl;
        } else {
            process.env[HOME_IROH_RELAY_POLICY_ENV_KEY] = "disabled";
            delete process.env[HOME_IROH_RELAY_URLS_ENV_KEY];
        }
        const loaded = explicitAddonPath
            ? {
                available: true as const,
                native: createIrohNodeNativeModule(rawAddon),
            }
            : loadIrohNodeNative();
        if (!loaded.available) throw new Error(`Required Iroh Node lifecycle addon unavailable: ${loaded.message}`);
        const native = loaded.native;
        const homeNativeLifecycle = loadHomeIrohNativeLifecycleFromModule(native);
        if (!homeNativeLifecycle) throw new Error("Required Iroh Home acceptor lifecycle is unavailable");
        // startServer initializes this cache before registering/serving routes.
        // This lower-level composed fixture must preserve that production order.
        await initializeServerIdentityCache(process.env);
        const app = createProductionProtocolApp();
        let daemonIrohRuntime: TestDaemonIrohRuntime | null = null;
        let releaseDaemonHomeTunnel: (() => Promise<void>) | null = null;
        let runtimeOrigin: string | null = null;
        let socket: ReturnType<typeof ioClient> | null = null;

        try {
            await app.listen({ port: 0, host: "127.0.0.1" });
            const address = app.server.address() as AddressInfo | null;
            if (!address?.port) throw new Error("Fastify did not bind a loopback port");

            const ingressPort = await app.irohIngress.listen();

            // Exercise production startup for the declared holder. Only native
            // addon selection changes: the loaded test-feature addon carries
            // real HTTP/WebSocket bytes through the ordinary lifecycle adapter.
            const homeState = await (async () => {
                if (!holder) return ensureHomeIrohEndpoint({
                    env: process.env, apiPort: ingressPort, native: homeNativeLifecycle,
                });
                vi.spyOn(nativeLifecycleBoundary, 'loadHomeIrohNativeLifecycle').mockReturnValue(homeNativeLifecycle);
                const env = { ...process.env, HAPPIER_SOCKET_ADAPTER: 'redis-streams', HAPPIER_HOME_IROH_HOLDER: '1' };
                await prepareHomeIrohStartup(env)({
                    listener: resolveBoundServerListener(app), ingressPort,
                    continuityStore: createHomeConnectionDescriptorContinuityStoreForServer(env),
                });
                return getHomeIrohEndpointState();
            })();
            expect(homeState).toMatchObject({
                status: "active",
                failureReason: null,
                snapshot: {
                    endpoint: {
                        endpointId: expect.any(String),
                        ...(topology === "relay"
                            ? { relayUrls: expect.arrayContaining([expect.any(String)]) }
                            : { directAddresses: expect.arrayContaining([expect.any(String)]) }),
                    },
                },
            });
            if (!homeState.snapshot) throw new Error("Home Iroh endpoint did not publish its descriptor");
            const homeConnectionDescriptor = await readHomeConnectionDescriptor({
                env: process.env,
                continuityStore: createHomeConnectionDescriptorContinuityStoreForServer(process.env)!,
                visibility: "authenticated",
                resolveIrohEndpointState: () => homeState,
            });
            if (!homeConnectionDescriptor) {
                throw new Error("Home descriptor publisher did not compose the active Iroh endpoint");
            }

            const createDaemonMachineIrohRuntime = await loadTestDaemonIrohRuntimeFactory();
            daemonIrohRuntime = await createDaemonMachineIrohRuntime({
                happyHomeDir: join(harness.baseDir, "remote-daemon"),
                relayConfig: {
                    relayPolicy: topology === "relay" ? "automatic" : "disabled",
                    relayUrls: homeState.snapshot.endpoint.relayUrls ?? [],
                },
                native,
            });
            if (!daemonIrohRuntime.available || !daemonIrohRuntime.ensureHomeTunnel) {
                throw new Error("Required daemon Iroh runtime is unavailable");
            }
            const tunnel = await daemonIrohRuntime.ensureHomeTunnel({
                descriptor: homeConnectionDescriptor,
            });
            releaseDaemonHomeTunnel = tunnel.release;
            runtimeOrigin = tunnel.runtimeOrigin;

            expect(tunnel).toMatchObject({
                observedPath: expectedPath,
            });
            expect(runtimeOrigin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
            expect(new URL(runtimeOrigin).port).not.toBe(String(address.port));
            expect(runtimeOrigin).not.toBe(CANONICAL_HOME_URL);

            const challengeResponse = await fetch(`${runtimeOrigin}/v1/auth/challenge`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: "{}",
            });
            expect(challengeResponse.status).toBe(200);
            await expect(challengeResponse.json()).resolves.toMatchObject({ audience: { origin: CANONICAL_HOME_URL } });

            const healthResponse = await fetch(`${runtimeOrigin}/health`);
            expect(healthResponse.status).toBe(200);
            await expect(healthResponse.json()).resolves.toMatchObject({
                status: "ok",
                service: "happier-server",
            });

            // The public response never exposes direct-address hints. A relay-backed
            // descriptor remains useful without them; a direct-only descriptor is
            // intentionally available only after Home authentication.
            const featuresResponse = await fetch(`${runtimeOrigin}/v1/features`);
            expect(featuresResponse.status).toBe(200);
            const featuresPayload = FeaturesResponseSchema.parse(await featuresResponse.json());
            const publishedDescriptor = featuresPayload.homeConnectionDescriptor;
            expect(publishedDescriptor).toMatchObject({
                homeServerIdentityId: homeConnectionDescriptor.homeServerIdentityId,
                endpoints: [{ kind: "iroh", endpointId: homeState.snapshot.endpoint.endpointId }],
            });
            if (!publishedDescriptor) throw new Error("Home feature response omitted its public descriptor");
            expect(publishedDescriptor?.endpoints[0]).not.toHaveProperty("directAddresses");

            const missingAuthResponse = await fetch(`${runtimeOrigin}/v1/auth/ping`);
            expect(missingAuthResponse.status).toBe(401);
            const invalidAuthResponse = await fetch(`${runtimeOrigin}/v1/auth/ping`, {
                headers: { authorization: "Bearer invalid-home-token" },
            });
            expect(invalidAuthResponse.status).toBe(401);

            const signupSeed = new Uint8Array(32).fill(31);
            const signupKeyPair = tweetnacl.sign.keyPair.fromSeed(signupSeed);
            const signupChallenge = new Uint8Array(32).fill(17);
            const signupSignature = tweetnacl.sign.detached(signupChallenge, signupKeyPair.secretKey);
            const signupResponse = await fetch(`${runtimeOrigin}/v1/auth`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    publicKey: privacyKit.encodeBase64(new Uint8Array(signupKeyPair.publicKey)),
                    challenge: privacyKit.encodeBase64(signupChallenge),
                    signature: privacyKit.encodeBase64(new Uint8Array(signupSignature)),
                }),
            });
            expect(signupResponse.status).toBe(403);
            await expect(signupResponse.json()).resolves.toEqual({ error: "signup-disabled" });

            const account = await db.account.create({
                data: { publicKey: "composed-home-iroh-account" },
                select: { id: true },
            });
            const token = await auth.createToken(account.id, undefined, {
                kind: "account",
                authority: "present_user",
                authenticationEvidence: [{ kind: "home_method", methodId: "key_challenge" }],
            });
            const authorization = `Bearer ${token}`;
            const pingResponse = await fetch(`${runtimeOrigin}/v1/auth/ping`, {
                headers: { authorization },
            });
            expect(pingResponse.status).toBe(200);
            await expect(pingResponse.json()).resolves.toEqual({ ok: true });

            const authenticatedFeaturesResponse = await fetch(`${runtimeOrigin}/v1/features/authenticated`, {
                headers: { authorization },
            });
            expect(authenticatedFeaturesResponse.status).toBe(200);
            const authenticatedFeatures = FeaturesResponseSchema.parse(await authenticatedFeaturesResponse.json());
            expect(authenticatedFeatures.homeConnectionDescriptor).toEqual({
                v: 1,
                homeServerIdentityId: homeConnectionDescriptor.homeServerIdentityId,
                canonicalServerUrl: homeConnectionDescriptor.canonicalServerUrl,
                revision: publishedDescriptor.revision,
                endpoints: [{ kind: "iroh", ...homeState.snapshot.endpoint }],
            });

            const profileResponse = await fetch(`${runtimeOrigin}/v1/account/profile`, {
                headers: { authorization },
            });
            expect(profileResponse.status).toBe(200);
            await expect(profileResponse.json()).resolves.toMatchObject({ id: account.id });

            const sessionsResponse = await fetch(`${runtimeOrigin}/v2/sessions`, {
                headers: { authorization },
            });
            expect(sessionsResponse.status).toBe(200);
            await expect(sessionsResponse.json()).resolves.toMatchObject({ sessions: [] });

            socket = ioClient(runtimeOrigin, {
                path: "/v1/updates",
                transports: ["websocket"],
                upgrade: false,
                reconnection: false,
                autoConnect: false,
                auth: { token },
            });
            const connected = waitForSocketConnection(socket);
            socket.connect();
            await connected;
            await waitForSocketApplicationReady(socket);
            expect(socket.io.engine.transport.name).toBe("websocket");

            expect(testController.getObservedPath()).toBe(expectedPath);
            const acceptor = await native.startHomeAcceptor({
                endpointHandle: resolvePersonalHomeRuntimeLayout({ env: process.env }).irohEndpointKeyPath,
                targetHost: "127.0.0.1",
                targetPort: ingressPort,
            });
            expect(acceptor).toMatchObject({
                reused: true,
                status: {
                    running: true,
                    streamsAccepted: expect.any(Number),
                    lastPath: {
                        observedPath: expectedPath,
                        isRelay: expectedPath === "relay",
                    },
                },
            });
            expect(acceptor.status.streamsAccepted).toBeGreaterThanOrEqual(2);
            await expect(testController.restoreAutomatic()).rejects.toThrow(
                /cannot change while native endpoints are active/,
            );
            // Keeping the EndpointId and the already-open transport cannot
            // restore a revoked credential's HTTP authority.
            await db.account.update({ where: { id: account.id }, data: { tokenEpoch: { increment: 1 } } });
            const revokedPing = await fetch(`${runtimeOrigin}/v1/auth/ping`, { headers: { authorization } });
            expect(revokedPing.status).toBe(401);
            expect((await getHomeIrohEndpointState()).snapshot?.endpoint.endpointId).toBe(homeState.snapshot.endpoint.endpointId);
        } finally {
            try {
                socket?.close();
                await releaseDaemonHomeTunnel?.();
                if (runtimeOrigin) await expectOriginDown(runtimeOrigin);
                await daemonIrohRuntime?.shutdown();
                await stopHomeIrohEndpoint();
                await expect(getHomeIrohEndpointState()).resolves.toEqual({
                    status: "stopping",
                    snapshot: null,
                    failureReason: null,
                });
            } finally {
                try {
                    await app.close();
                } finally {
                    await testController.restoreAutomatic();
                    expect(testController.getObservedPath()).toBe("unknown");
                }
            }
        }
    });

    it("moves the same authenticated HTTP and WebSocket bytes over the ordinary standard transport when the descriptor has no Iroh endpoint", { timeout: 120_000 }, async () => {
        // A standard-only Home is a native-unavailability carrier fact at the
        // canonical server owner, never a relay-policy fact: relay-disabled
        // keeps meaning direct-Iroh-only, not Iroh-off, and no all-Iroh-off
        // policy exists.
        expect(process.env[HOME_IROH_RELAY_POLICY_ENV_KEY]).toBe("disabled");
        expect(process.env.HAPPIER_IROH_REQUIRE_NODE_ADDON).toBe("1");
        const explicitAddonPath = process.env.HAPPIER_TEST_IROH_NODE_ADDON_PATH?.trim();
        if (!explicitAddonPath) {
            throw new Error("The real Iroh application-byte fixture requires an explicit test-feature addon path");
        }
        const rawAddon = loadIrohNodeNativeAddon(explicitAddonPath);
        const native = createIrohNodeNativeModule(rawAddon);
        // This is a distinct standard-only Home, not a later lifecycle state of
        // the Iroh Home exercised above. Give its SQLite server-light descriptor
        // continuity owner a separate data root so the prior Home's non-retired
        // Iroh endpoint cannot be silently dropped merely to make this control
        // publish HTTPS. The CLI composition singletons imported below remain
        // inside the same outer disposable harness.
        process.env.HAPPIER_SERVER_LIGHT_DATA_DIR = join(harness.baseDir, "standard-home-data");
        process.env.HAPPIER_HOME_DIR = join(harness.baseDir, "cli-home");
        resetHomeConnectionDescriptorRevisionOwnerForTests();

        // A real TLS ingress, not a declared one: the standard carrier only
        // proves anything if the advertised `https` endpoint is the origin that
        // actually terminates TLS and serves the application bytes.
        const ingress = await createTestTlsIngress();

        // startServer initializes this cache before registering/serving routes.
        // This lower-level composed fixture must preserve that production order.
        await initializeServerIdentityCache(process.env);
        const app = createProductionProtocolApp({ https: ingress.serverOptions });
        let daemonIrohRuntime: TestDaemonIrohRuntime | null = null;
        let socket: ReturnType<typeof ioClient> | null = null;

        try {
            await app.listen({ port: 0, host: "127.0.0.1" });
            const address = app.server.address() as AddressInfo | null;
            if (!address?.port) throw new Error("Fastify did not bind a loopback port");
            // The declared standard HTTPS ingress fact is the bound TLS origin.
            // The descriptor publication owner composes an `https` endpoint only
            // from this explicit operator input, so the published URL and the
            // served origin are now the same fact instead of two.
            const httpsOrigin = `https://127.0.0.1:${address.port}`;
            const ingressPort = await app.irohIngress.listen();
            process.env.HAPPIER_PUBLIC_SERVER_URL = httpsOrigin;

            // Server composition: the Home Iroh carrier is unavailable on this
            // target. Production reaches this exact state because
            // loadHomeIrohNativeLifecycle() resolves to null there; `native: null`
            // is this owner's documented test-only injection of that boundary.
            // The Home must stay runnable with the honest unavailable status and
            // start no native endpoint or Home acceptor.
            await expect(ensureHomeIrohEndpoint({
                env: process.env,
                apiPort: ingressPort,
                native: null,
            })).resolves.toEqual({
                status: "unavailable",
                snapshot: null,
                failureReason: null,
            });
            await expect(getHomeIrohEndpointState()).resolves.toEqual({
                status: "unavailable",
                snapshot: null,
                failureReason: null,
            });

            const featuresResponse = await requestOverTls({ ingress, url: `${httpsOrigin}/v1/features` });
            expect(featuresResponse.status).toBe(200);
            const featuresPayload = FeaturesResponseSchema.parse(featuresResponse.body);
            // Public discovery is read-only: it must not manufacture and
            // commit descriptor continuity from live endpoint facts. The
            // authenticated route below is the canonical publication owner.
            expect(featuresPayload.homeConnectionDescriptor).toBeUndefined();

            const missingAuthResponse = await requestOverTls({ ingress, url: `${httpsOrigin}/v1/auth/ping` });
            expect(missingAuthResponse.status).toBe(401);
            const invalidAuthResponse = await requestOverTls({
                ingress,
                url: `${httpsOrigin}/v1/auth/ping`,
                headers: { authorization: "Bearer invalid-home-token" },
            });
            expect(invalidAuthResponse.status).toBe(401);

            const account = await db.account.create({
                data: { publicKey: "composed-home-standard-account" },
                select: { id: true },
            });
            const token = await auth.createToken(account.id, undefined, {
                kind: "account",
                authority: "present_user",
                authenticationEvidence: [{ kind: "home_method", methodId: "key_challenge" }],
            });
            const authorization = `Bearer ${token}`;

            const authenticatedFeaturesResponse = await requestOverTls({
                ingress,
                url: `${httpsOrigin}/v1/features/authenticated`,
                headers: { authorization },
            });
            expect(authenticatedFeaturesResponse.status).toBe(200);
            const authenticatedFeatures = FeaturesResponseSchema.parse(authenticatedFeaturesResponse.body);
            const authenticatedDescriptor = authenticatedFeatures.homeConnectionDescriptor;
            if (!authenticatedDescriptor) throw new Error("Standard Home feature response omitted its authenticated descriptor");
            expect(authenticatedDescriptor).toEqual({
                v: 1,
                homeServerIdentityId: expect.any(String),
                canonicalServerUrl: CANONICAL_HOME_URL,
                revision: expect.any(Number),
                endpoints: [{ kind: "https", url: httpsOrigin }],
            });
            // The advertised standard endpoint is the exact URL this leg serves.
            const advertisedHttpsEndpoint = authenticatedDescriptor.endpoints
                .find((endpoint) => endpoint.kind === "https");
            if (!advertisedHttpsEndpoint || advertisedHttpsEndpoint.kind !== "https") {
                throw new Error("Standard Home descriptor advertised no HTTPS endpoint");
            }
            expect(advertisedHttpsEndpoint.url).toBe(httpsOrigin);

            const pingResponse = await requestOverTls({
                ingress,
                url: `${advertisedHttpsEndpoint.url}/v1/auth/ping`,
                headers: { authorization },
            });
            expect(pingResponse.status).toBe(200);
            expect(pingResponse.body).toEqual({ ok: true });

            const profileResponse = await requestOverTls({
                ingress,
                url: `${advertisedHttpsEndpoint.url}/v1/account/profile`,
                headers: { authorization },
            });
            expect(profileResponse.status).toBe(200);
            expect(profileResponse.body).toMatchObject({ id: account.id });

            const sessionsResponse = await requestOverTls({
                ingress,
                url: `${advertisedHttpsEndpoint.url}/v2/sessions`,
                headers: { authorization },
            });
            expect(sessionsResponse.status).toBe(200);
            expect(sessionsResponse.body).toMatchObject({ sessions: [] });

            // Ordinary Socket.IO: the standard carrier does not force the
            // websocket-only tunnel transport, so the connection may start on
            // polling and upgrade exactly as the unchanged product behavior allows.
            socket = ioClient(advertisedHttpsEndpoint.url, {
                path: "/v1/updates",
                reconnection: false,
                autoConnect: false,
                auth: { token },
                // Same narrowly scoped trust as the HTTP agent above: this
                // client trusts the fixture CA only, with verification on, so
                // both the polling and websocket transports really do TLS.
                ca: ingress.caCertificatePem,
                rejectUnauthorized: true,
            });
            const connected = waitForSocketConnection(socket);
            socket.connect();
            await connected;
            const engine = socket.io.engine;
            await vi.waitFor(() => {
                if (engine.transport.name !== "websocket") {
                    throw new Error("Standard Socket.IO transport did not upgrade to websocket");
                }
            }, { timeout: 10_000, interval: 100 });
            // `ping` is also an Engine.IO control packet name. Wait until the
            // ordinary polling connection has completed its real websocket
            // upgrade before exercising Happier's application-level `ping`
            // acknowledgement, matching the transport this assertion is meant
            // to prove rather than racing the lower protocol's probe cycle.
            await waitForSocketApplicationReady(socket);

            // Client composition: the real daemon Iroh runtime is fully capable
            // on this target (a real native endpoint is created), so the
            // standard-carrier decision below cannot be a native-unavailability
            // accident.
            const createDaemonMachineIrohRuntime = await loadTestDaemonIrohRuntimeFactory();
            daemonIrohRuntime = await createDaemonMachineIrohRuntime({
                happyHomeDir: join(harness.baseDir, "remote-daemon-standard"),
                relayConfig: { relayPolicy: "disabled", relayUrls: [] },
                native,
            });
            if (!daemonIrohRuntime.available || !daemonIrohRuntime.ensureHomeTunnel) {
                throw new Error("Required daemon Iroh runtime is unavailable");
            }
            const ensureHomeTunnelProbe = vi.fn(daemonIrohRuntime.ensureHomeTunnel);
            const prepareDaemonHomeIrohTransport = await loadTestDaemonHomeTransportOwner();
            // The production daemon probe uses the host trust store. This test's
            // ephemeral CA is deliberately scoped to `ingress.agent`, so adapt
            // only that genuine TLS boundary while still performing both real
            // readiness requests and the exact Home-identity check.
            const trustedTlsProbe = async (input: Readonly<{
                serverUrl: string;
                token: string;
                expectedServerIdentityId: string;
            }>) => {
                expect(input.serverUrl).toBe(advertisedHttpsEndpoint.url);
                const identityResponse = await requestOverTls({
                    ingress,
                    url: `${input.serverUrl}/v1/features`,
                });
                expect(identityResponse.status).toBe(200);
                const identityFeatures = FeaturesResponseSchema.parse(identityResponse.body);
                expect(identityFeatures.capabilities.serverIdentity.serverIdentityId)
                    .toBe(input.expectedServerIdentityId);
                const authResponse = await requestOverTls({
                    ingress,
                    url: `${input.serverUrl}/v1/auth/ping`,
                    headers: { authorization: `Bearer ${input.token}` },
                });
                expect(authResponse.status).toBe(200);
                return { status: "ready" as const };
            };
            const transport = await prepareDaemonHomeIrohTransport({
                runtime: { ...daemonIrohRuntime, ensureHomeTunnel: ensureHomeTunnelProbe },
                profile: {
                    id: "composed-standard-home",
                    name: "Composed Standard Home",
                    // The production caller is handed the exact URL the Home
                    // advertises, not a nearby plaintext loopback stand-in.
                    serverUrl: advertisedHttpsEndpoint.url,
                    webappUrl: CANONICAL_HOME_URL,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                    lastUsedAt: Date.now(),
                    homeConnectionDescriptor: authenticatedDescriptor,
                },
                token,
                probe: trustedTlsProbe,
            });

            // The production transport decision keeps the ordinary carrier, and
            // the fully capable native Iroh carrier acquisition is never invoked:
            // the runtime's ensureHomeTunnel is the single caller of the native
            // carrier acquisition, so an uncalled probe proves the native carrier
            // was never started for this Home.
            expect(transport.carrier).toBe("standard");
            expect(transport.observedPath).toBe("unknown");
            expect(ensureHomeTunnelProbe).not.toHaveBeenCalled();
            // The standard carrier's own readiness contract is a no-op: the
            // reachability of the advertised HTTPS origin is proven by the real
            // authenticated TLS bytes above, not by this result.
            await expect(transport.verifyAuthenticated(token)).resolves.toMatchObject({ status: "ready" });
            await expect(transport.release()).resolves.toBeUndefined();
        } finally {
            try {
                socket?.close();
                await daemonIrohRuntime?.shutdown();
            } finally {
                try {
                    await app.close();
                } finally {
                    ingress.agent.destroy();
                    await ingress.fixture.cleanup();
                }
            }
        }
    });
});
