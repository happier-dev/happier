import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    createStartServerDbMocks,
    installStartServerDbModuleMock,
    installStartServerCommonWiringMocks,
} from "@/testkit/startServerMocks";
import { createStartServerHarness } from "@/testkit/startServerHarness";
import type { EnsureHomeIrohEndpointParams, HomeIrohEndpointState } from "@/app/iroh/homeIrohEndpoint";

const ensureHomeIrohEndpoint = vi.fn<(
    params: EnsureHomeIrohEndpointParams,
) => Promise<HomeIrohEndpointState>>(async (_params) => ({
    status: "unavailable",
    snapshot: null,
    failureReason: null,
}));
const stopHomeIrohEndpoint = vi.fn(async () => {});
const getHomeIrohEndpointState = vi.fn<() => Promise<HomeIrohEndpointState>>(async () => ({
    status: "unavailable",
    snapshot: null,
    failureReason: null,
}));
const beginHomeIrohEndpointStartup = vi.fn();
const markHomeIrohEndpointStartupUnavailable = vi.fn();
vi.mock("@/app/iroh/homeIrohEndpoint", async () => {
    const actual = await vi.importActual<typeof import("@/app/iroh/homeIrohEndpoint")>("@/app/iroh/homeIrohEndpoint");
    return {
        ...actual,
        ensureHomeIrohEndpoint,
        stopHomeIrohEndpoint,
        getHomeIrohEndpointState,
        beginHomeIrohEndpointStartup,
        markHomeIrohEndpointStartupUnavailable,
    };
});

const ping = vi.fn(async () => "PONG");
vi.mock("@/storage/redis/redis", () => ({
    getRedisClient: () => ({ ping }),
}));
vi.mock("@/app/events/createRedisStreamsRoomEmitter", () => ({
    createRedisStreamsRoomEmitter: vi.fn(() => ({})),
}));
vi.mock("@/app/events/eventRouter", () => ({
    eventRouter: { setIo: vi.fn() },
}));

const startServerDbMocks = createStartServerDbMocks({
    // Keep light-flavor startup out of the real sqlite migration path in tests.
    getDbProviderFromEnv: () => "pglite",
});

installStartServerDbModuleMock(startServerDbMocks);

installStartServerCommonWiringMocks();

describe("startServer managed Home Iroh composition", () => {
    let descriptorDataDir: string | null = null;
    const startServerHarness = createStartServerHarness({
        SERVER_ROLE: undefined,
        REDIS_URL: undefined,
        HAPPIER_SOCKET_ADAPTER: undefined,
        HAPPY_SOCKET_ADAPTER: undefined,
        HAPPIER_DB_PROVIDER: undefined,
        HAPPY_DB_PROVIDER: undefined,
        HAPPIER_SERVER_LIGHT_DATA_DIR: "/tmp/happier-home-iroh-startup",
        HAPPY_SERVER_LIGHT_DATA_DIR: "/tmp/happier-home-iroh-startup",
    });

    beforeEach(async () => {
        // Only replace the OS signal wait. Each simulated process needs a fresh
        // shutdown controller; importActual in a static mock retained an aborted
        // controller across vi.resetModules and invalidated every later case.
        vi.doUnmock("@/utils/process/shutdown");
        vi.resetModules();
        const shutdown = await import("@/utils/process/shutdown");
        vi.doMock("@/utils/process/shutdown", () => ({ ...shutdown, awaitShutdown: vi.fn(async () => {}) }));
        startServerDbMocks.reset();
        ensureHomeIrohEndpoint.mockClear();
        stopHomeIrohEndpoint.mockClear();
        getHomeIrohEndpointState.mockClear();
        beginHomeIrohEndpointStartup.mockClear();
        markHomeIrohEndpointStartupUnavailable.mockClear();
        ensureHomeIrohEndpoint.mockImplementation(async () => ({
            status: "unavailable",
            snapshot: null,
            failureReason: null,
        }));
        stopHomeIrohEndpoint.mockImplementation(async () => {});
        getHomeIrohEndpointState.mockImplementation(async () => ({
            status: "unavailable",
            snapshot: null,
            failureReason: null,
        }));
        vi.stubGlobal("fetch", vi.fn(() => {
            throw new Error("Personal Home exposure proof must not issue a signup request");
        }));
        ping.mockClear();
        startServerHarness.reset();
    });

    afterEach(async () => {
        vi.doUnmock("@/utils/process/shutdown");
        vi.unstubAllGlobals();
        startServerHarness.restore();
        if (descriptorDataDir) {
            await rm(descriptorDataDir, { recursive: true, force: true });
            descriptorDataDir = null;
        }
    });

    it("commits the restarted Home endpoint before public discovery without an authenticated request", async () => {
        descriptorDataDir = await mkdtemp(join(tmpdir(), "happier-home-iroh-restart-"));
        const endpointId = "a".repeat(64);
        const canonicalServerUrl = "http://127.0.0.1:3005";
        const serverIdentityId = "srv_home_restart";
        const env = {
            ...process.env,
            HAPPIER_SERVER_LIGHT_DATA_DIR: descriptorDataDir,
            HAPPIER_MANAGED_RELAY_PURPOSE: "personal-home",
            HAPPIER_CANONICAL_SERVER_URL: canonicalServerUrl,
            HAPPIER_SERVER_IDENTITY_ID: serverIdentityId,
        };
        const { resolvePersonalHomeRuntimeLayout } = await import("@happier-dev/cli-common/firstPartyRuntime/server");
        const { createFileHomeConnectionDescriptorContinuityStore, createHomeConnectionDescriptorContentKey, resolveHomeConnectionDescriptorContinuityPath } =
            await import("@/app/features/homeConnectionDescriptorContinuity");
        const continuityStore = createFileHomeConnectionDescriptorContinuityStore(
            resolveHomeConnectionDescriptorContinuityPath(resolvePersonalHomeRuntimeLayout({ env }).irohEndpointKeyPath),
        );
        await continuityStore.write({
            revision: 7,
            contentKey: createHomeConnectionDescriptorContentKey({
                homeServerIdentityId: serverIdentityId,
                canonicalServerUrl,
                endpoints: [{
                    kind: "iroh",
                    endpointId,
                    relayUrls: ["https://relay.example.test"],
                    directAddresses: ["192.0.2.1:41000"],
                }],
            }),
            irohEndpointId: endpointId,
        });
        const restartedState: HomeIrohEndpointState = {
            status: "active",
            snapshot: {
                endpoint: {
                    endpointId,
                    relayUrls: ["https://relay.example.test"],
                    directAddresses: ["192.0.2.1:42000"],
                },
            },
            failureReason: null,
        };
        ensureHomeIrohEndpoint.mockImplementationOnce(async () => restartedState);
        getHomeIrohEndpointState.mockImplementation(async () => restartedState);

        await startServerHarness.start("light", {
            SERVER_ROLE: "all",
            PORT: "3005",
            HAPPIER_MANAGED_RELAY_PURPOSE: "personal-home",
            HAPPIER_CANONICAL_SERVER_URL: canonicalServerUrl,
            HAPPIER_SERVER_IDENTITY_ID: serverIdentityId,
            HAPPIER_SERVER_LIGHT_DATA_DIR: descriptorDataDir,
            AUTH_ANONYMOUS_SIGNUP_ENABLED: "0",
        });

        const { readCommittedHomeConnectionDescriptor } = await import("@/app/features/homeConnectionDescriptorPublication");
        const publicDescriptor = await readCommittedHomeConnectionDescriptor({
            env,
            continuityStore,
            resolveIrohEndpointState: async () => restartedState,
        });
        expect(publicDescriptor).toMatchObject({
            homeServerIdentityId: serverIdentityId,
            canonicalServerUrl,
            revision: 8,
            endpoints: [{ kind: "iroh", endpointId, relayUrls: ["https://relay.example.test"] }],
        });
        expect(publicDescriptor?.endpoints[0]).not.toHaveProperty("directAddresses");

        const { initiateShutdown } = await import("@/utils/process/shutdown");
        await initiateShutdown("test");
    });

    it.each(["all", "api"] as const)("composes the Home Iroh endpoint from the actual bound API port for the light flavor with role %s once anonymous signup is explicitly disabled", async (role) => {
        await startServerHarness.start("light", {
            SERVER_ROLE: role,
            PORT: "3005",
            HAPPIER_MANAGED_RELAY_PURPOSE: "personal-home",
            HAPPIER_CANONICAL_SERVER_URL: "http://127.0.0.1:3005",
            AUTH_ANONYMOUS_SIGNUP_ENABLED: "0",
        });

        expect(ensureHomeIrohEndpoint).toHaveBeenCalledTimes(1);
        expect(ensureHomeIrohEndpoint.mock.calls[0]?.[0]).toMatchObject({ apiPort: 3005 });
        const { startApi } = await import("@/app/api/api");
        expect(beginHomeIrohEndpointStartup).toHaveBeenCalledOnce();
        expect(beginHomeIrohEndpointStartup.mock.invocationCallOrder[0]).toBeLessThan(
            vi.mocked(startApi).mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
        );

        const { initiateShutdown } = await import("@/utils/process/shutdown");
        await initiateShutdown("test");
        expect(stopHomeIrohEndpoint).toHaveBeenCalledTimes(1);
    });

    it("keeps HTTP startup available and starts no Iroh endpoint when the canonical closure proof fails", async () => {
        await startServerHarness.start("light", {
            SERVER_ROLE: "all",
            PORT: "3005",
            HAPPIER_MANAGED_RELAY_PURPOSE: "personal-home",
            HAPPIER_CANONICAL_SERVER_URL: "http://127.0.0.1:3005",
            AUTH_ANONYMOUS_SIGNUP_ENABLED: "1",
        });

        const { startApi } = await import("@/app/api/api");
        expect(startApi).toHaveBeenCalledTimes(1);
        expect(beginHomeIrohEndpointStartup).toHaveBeenCalledOnce();
        expect(markHomeIrohEndpointStartupUnavailable).toHaveBeenCalledOnce();
        expect(ensureHomeIrohEndpoint).not.toHaveBeenCalled();
    });

    it("uses the actual API port even when its canonical audience has another port", async () => {
        await startServerHarness.start("light", {
            SERVER_ROLE: "all",
            PORT: "43123",
            HAPPIER_MANAGED_RELAY_PURPOSE: "personal-home",
            HAPPIER_CANONICAL_SERVER_URL: "http://127.0.0.1:43123",
            AUTH_ANONYMOUS_SIGNUP_ENABLED: "0",
        });

        expect(ensureHomeIrohEndpoint.mock.calls[0]?.[0]).toMatchObject({ apiPort: 3005 });
    });

    it("uses the actual listener when PORT is absent", async () => {
        await startServerHarness.start("light", {
            SERVER_ROLE: "all",
            HAPPIER_MANAGED_RELAY_PURPOSE: "personal-home",
            HAPPIER_CANONICAL_SERVER_URL: "http://127.0.0.1:3005",
            AUTH_ANONYMOUS_SIGNUP_ENABLED: "0",
        });

        expect(ensureHomeIrohEndpoint.mock.calls[0]?.[0]).toMatchObject({ apiPort: 3005 });
    });

    it("does not infer the acceptor port from a malformed PORT environment value", async () => {
        await startServerHarness.start("light", {
            SERVER_ROLE: "all",
            PORT: "not-a-port",
            HAPPIER_MANAGED_RELAY_PURPOSE: "personal-home",
            HAPPIER_CANONICAL_SERVER_URL: "http://127.0.0.1:3005",
            AUTH_ANONYMOUS_SIGNUP_ENABLED: "0",
        });

        expect(ensureHomeIrohEndpoint.mock.calls[0]?.[0]).toMatchObject({ apiPort: 3005 });
    });

    it.each([
        ["legacy public fallback", undefined, "http://127.0.0.1:3005"],
        ["HTTPS canonical URL", "https://127.0.0.1:3005", undefined],
        ["canonical URL with a path", "http://127.0.0.1:3005/home", undefined],
    ] as const)("accepts the canonical URL owner's %s", async (_label, canonicalServerUrl, publicServerUrl) => {
        await startServerHarness.start("light", {
            SERVER_ROLE: "all",
            PORT: "3005",
            HAPPIER_MANAGED_RELAY_PURPOSE: "personal-home",
            ...(canonicalServerUrl ? { HAPPIER_CANONICAL_SERVER_URL: canonicalServerUrl } : {}),
            ...(publicServerUrl ? { HAPPIER_PUBLIC_SERVER_URL: publicServerUrl } : {}),
            AUTH_ANONYMOUS_SIGNUP_ENABLED: "0",
        });

        expect(ensureHomeIrohEndpoint).toHaveBeenCalledOnce();
    });

    it("does not compose the Personal Home acceptor for a generic light runtime with signup disabled", async () => {
        await startServerHarness.start("light", {
            SERVER_ROLE: "all",
            HAPPIER_MANAGED_RELAY_PURPOSE: "generic",
            AUTH_ANONYMOUS_SIGNUP_ENABLED: "0",
        });

        expect(ensureHomeIrohEndpoint).not.toHaveBeenCalled();
    });

    it("composes Iroh for a single-instance full server without Personal Home purpose", async () => {
        await startServerHarness.start("full", {
            SERVER_ROLE: "all",
            HAPPIER_CANONICAL_SERVER_URL: "https://home.example.test",
            AUTH_ANONYMOUS_SIGNUP_ENABLED: "0",
        });

        expect(ensureHomeIrohEndpoint).toHaveBeenCalledOnce();
        expect(ensureHomeIrohEndpoint.mock.calls[0]?.[0]).toMatchObject({ apiPort: 3005 });
    });

    it("composes an ordinary QA Home without rewriting its .localhost audience", async () => {
        await startServerHarness.start("light", {
            SERVER_ROLE: "api",
            HAPPIER_MANAGED_RELAY_PURPOSE: "generic",
            HAPPIER_CANONICAL_SERVER_URL: "http://home-qa.localhost:3039",
            AUTH_ANONYMOUS_SIGNUP_ENABLED: "0",
        });
        expect(ensureHomeIrohEndpoint).toHaveBeenCalledOnce();
        expect(ensureHomeIrohEndpoint.mock.calls[0]?.[0].env.HAPPIER_CANONICAL_SERVER_URL).toBe("http://home-qa.localhost:3039");
    });

    it("honors deployment-fixed Iroh opt-out on a full server", async () => {
        await startServerHarness.start("full", {
            SERVER_ROLE: "api",
            HAPPIER_CANONICAL_SERVER_URL: "https://home.example.test",
            HAPPIER_PUBLIC_SERVER_URL: "https://home.example.test",
            HAPPIER_HOME_IROH_MODE: "disabled",
            AUTH_ANONYMOUS_SIGNUP_ENABLED: "1",
        });
        expect(ensureHomeIrohEndpoint).not.toHaveBeenCalled();
        const { readHomeIrohComposition, readHomeIrohEndpointLifecycleState } = await import("@/app/iroh/homeIrohEndpoint");
        expect(readHomeIrohComposition()).not.toBeNull();
        expect(readHomeIrohEndpointLifecycleState().status).toBe("retired");
    });

    it("never composes Iroh for the worker-only role", async () => {
        await startServerHarness.start("light", {
            SERVER_ROLE: "worker",
            REDIS_URL: "redis://localhost:6379",
            HAPPIER_SOCKET_ADAPTER: "redis-streams",
            AUTH_ANONYMOUS_SIGNUP_ENABLED: "0",
        });

        expect(ensureHomeIrohEndpoint).not.toHaveBeenCalled();
    });

    it("keeps the Home loopback-only and composes no Iroh while anonymous signup is explicitly enabled", async () => {
        await startServerHarness.start("light", {
            SERVER_ROLE: "all",
            HAPPIER_MANAGED_RELAY_PURPOSE: "personal-home",
            AUTH_ANONYMOUS_SIGNUP_ENABLED: "1",
        });

        expect(ensureHomeIrohEndpoint).not.toHaveBeenCalled();

        const { initiateShutdown } = await import("@/utils/process/shutdown");
        await initiateShutdown("test");
        expect(stopHomeIrohEndpoint).not.toHaveBeenCalled();
    });

    it("fails closed for the managed bootstrap default: unset anonymous signup composes no Iroh", async () => {
        await startServerHarness.start("light", {
            SERVER_ROLE: "all",
            HAPPIER_MANAGED_RELAY_PURPOSE: "personal-home",
        });

        expect(ensureHomeIrohEndpoint).not.toHaveBeenCalled();

        const { initiateShutdown } = await import("@/utils/process/shutdown");
        await initiateShutdown("test");
        expect(stopHomeIrohEndpoint).not.toHaveBeenCalled();
    });

    it("fails closed on a malformed anonymous-signup value instead of composing Iroh", async () => {
        await startServerHarness.start("light", {
            SERVER_ROLE: "all",
            HAPPIER_MANAGED_RELAY_PURPOSE: "personal-home",
            AUTH_ANONYMOUS_SIGNUP_ENABLED: "not-a-boolean",
        });

        expect(ensureHomeIrohEndpoint).not.toHaveBeenCalled();

        const { initiateShutdown } = await import("@/utils/process/shutdown");
        await initiateShutdown("test");
        expect(stopHomeIrohEndpoint).not.toHaveBeenCalled();
    });

    it("keeps startup healthy and registers Iroh shutdown when the composed endpoint fails with signup closed", async () => {
        ensureHomeIrohEndpoint.mockImplementationOnce(async () => ({
            status: "failed" as const,
            snapshot: null,
            failureReason: "native_error" as const,
        }));

        await startServerHarness.start("light", {
            SERVER_ROLE: "all",
            PORT: "3005",
            HAPPIER_MANAGED_RELAY_PURPOSE: "personal-home",
            HAPPIER_CANONICAL_SERVER_URL: "http://127.0.0.1:3005",
            AUTH_ANONYMOUS_SIGNUP_ENABLED: "0",
        });

        expect(ensureHomeIrohEndpoint).toHaveBeenCalledTimes(1);

        const { initiateShutdown } = await import("@/utils/process/shutdown");
        await initiateShutdown("test");
        expect(stopHomeIrohEndpoint).toHaveBeenCalledTimes(1);
    });

    it("keeps the standard Home server usable when configured Iroh relay support is unavailable", async () => {
        ensureHomeIrohEndpoint.mockImplementationOnce(async () => ({
            status: "unavailable" as const,
            snapshot: null,
            failureReason: null,
        }));

        await startServerHarness.start("light", {
            SERVER_ROLE: "all",
            PORT: "3005",
            HAPPIER_MANAGED_RELAY_PURPOSE: "personal-home",
            HAPPIER_CANONICAL_SERVER_URL: "http://127.0.0.1:3005",
            AUTH_ANONYMOUS_SIGNUP_ENABLED: "0",
            HAPPIER_IROH_RELAY_POLICY: "automatic",
            HAPPIER_IROH_RELAY_URLS: "https://relay.example.test",
        });

        expect(ensureHomeIrohEndpoint).toHaveBeenCalledTimes(1);
    });
});
