import { beforeEach, describe, expect, it, vi } from "vitest";

import {
    isRequestOnCanonicalPublicServerUrl,
    resolveCachedCanonicalPublicServerUrl,
    readCanonicalPublicServerUrlFromEnv,
    resetPublicServerUrlInferenceCacheForTests,
} from "./publicServerUrlInference";

vi.mock("@/app/integrations/tailscale/tailscaleServePublicUrlInference", () => ({
    inferAndApplyTailscaleServePublicServerUrl: vi.fn(),
}));

vi.mock("@/app/integrations/tailscale/tailscaleFunnelPublicUrlInference", () => ({
    inferAndApplyTailscaleFunnelPublicServerUrl: vi.fn(),
}));

describe("publicServerUrlInference", () => {
    beforeEach(() => {
        vi.resetAllMocks();
        resetPublicServerUrlInferenceCacheForTests();
    });

    describe("resolveCachedCanonicalPublicServerUrl", () => {
        it("infers the canonical public URL from the persisted relay access config (cloudflareNamed)", async () => {
            const { mkdtemp, writeFile, rm, mkdir } = await import("node:fs/promises");
            const { tmpdir } = await import("node:os");
            const { join } = await import("node:path");

            const homeDir = await mkdtemp(join(tmpdir(), "happier-public-url-"));
            const previousHome = process.env.HOME;
            process.env.HOME = homeDir;
            try {
                await mkdir(join(homeDir, ".happier", "relay", "access"), { recursive: true });
                await writeFile(
                    join(homeDir, ".happier", "relay", "access", "local.json"),
                    JSON.stringify({ providerId: "cloudflareNamed", hostname: "relay.example.test", token: "secret" }),
                    "utf8",
                );

                const env = {
                    HOME: homeDir,
                    HAPPIER_TAILSCALE_INFER_PUBLIC_URL: "0",
                } as NodeJS.ProcessEnv;
                resetPublicServerUrlInferenceCacheForTests();
                const resolved = await resolveCachedCanonicalPublicServerUrl(env);
                expect(resolved).toBe("https://relay.example.test");
            } finally {
                process.env.HOME = previousHome;
                await rm(homeDir, { recursive: true, force: true });
            }
        });

        it("does not infer from relay access config when HAPPIER_RELAY_ACCESS_INFER_PUBLIC_URL=0", async () => {
            const { mkdtemp, writeFile, rm, mkdir } = await import("node:fs/promises");
            const { tmpdir } = await import("node:os");
            const { join } = await import("node:path");

            const homeDir = await mkdtemp(join(tmpdir(), "happier-public-url-"));
            const previousHome = process.env.HOME;
            process.env.HOME = homeDir;
            try {
                await mkdir(join(homeDir, ".happier", "relay", "access"), { recursive: true });
                await writeFile(
                    join(homeDir, ".happier", "relay", "access", "local.json"),
                    JSON.stringify({ providerId: "cloudflareNamed", hostname: "relay.example.test", token: "secret" }),
                    "utf8",
                );

                const env = {
                    HOME: homeDir,
                    HAPPIER_TAILSCALE_INFER_PUBLIC_URL: "0",
                    HAPPIER_RELAY_ACCESS_INFER_PUBLIC_URL: "0",
                } as NodeJS.ProcessEnv;
                resetPublicServerUrlInferenceCacheForTests();
                const resolved = await resolveCachedCanonicalPublicServerUrl(env);
                expect(resolved).toBeNull();
            } finally {
                process.env.HOME = previousHome;
                await rm(homeDir, { recursive: true, force: true });
            }
        });

        it("falls back to tailscale funnel inference after serve inference returns null", async () => {
            const { inferAndApplyTailscaleServePublicServerUrl } = await import("@/app/integrations/tailscale/tailscaleServePublicUrlInference");
            const { inferAndApplyTailscaleFunnelPublicServerUrl } = await import("@/app/integrations/tailscale/tailscaleFunnelPublicUrlInference");

            vi.mocked(inferAndApplyTailscaleServePublicServerUrl).mockImplementation(async () => null);
            vi.mocked(inferAndApplyTailscaleFunnelPublicServerUrl).mockImplementation(async (env) => {
                env.HAPPIER_PUBLIC_SERVER_URL = "https://funnel.example.test";
                return "https://funnel.example.test";
            });

            const env = {
                HAPPIER_TAILSCALE_INFER_PUBLIC_URL: "1",
                HAPPIER_PUBLIC_SERVER_URL: "",
                HAPPIER_PUBLIC_SERVER_URL_INFER_TTL_MS: "60000",
            } as NodeJS.ProcessEnv;

            resetPublicServerUrlInferenceCacheForTests();
            const resolved = await resolveCachedCanonicalPublicServerUrl(env);

            expect(resolved).toBe("https://funnel.example.test");
            expect(inferAndApplyTailscaleServePublicServerUrl).toHaveBeenCalledTimes(1);
            expect(inferAndApplyTailscaleFunnelPublicServerUrl).toHaveBeenCalledTimes(1);
        });

        it("invalidates the cache when a relay access config appears after a null inference", async () => {
            const { mkdtemp, writeFile, rm, mkdir } = await import("node:fs/promises");
            const { tmpdir } = await import("node:os");
            const { join } = await import("node:path");

            const homeDir = await mkdtemp(join(tmpdir(), "happier-public-url-"));
            const previousHome = process.env.HOME;
            process.env.HOME = homeDir;
            try {
                const accessDir = join(homeDir, ".happier", "relay", "access");
                const accessPath = join(accessDir, "local.json");

                const env = {
                    HOME: homeDir,
                    HAPPIER_TAILSCALE_INFER_PUBLIC_URL: "0",
                    HAPPIER_PUBLIC_SERVER_URL_INFER_TTL_MS: "60000",
                } as NodeJS.ProcessEnv;

                resetPublicServerUrlInferenceCacheForTests();
                const resolved1 = await resolveCachedCanonicalPublicServerUrl(env);
                expect(resolved1).toBeNull();

                await mkdir(accessDir, { recursive: true });
                await writeFile(
                    accessPath,
                    JSON.stringify({ providerId: "cloudflareNamed", hostname: "relay.example.test", token: "secret" }),
                    "utf8",
                );

                const resolved2 = await resolveCachedCanonicalPublicServerUrl(env);
                expect(resolved2).toBe("https://relay.example.test");
            } finally {
                process.env.HOME = previousHome;
                await rm(homeDir, { recursive: true, force: true });
            }
        });

        it("invalidates the cache when relay access config appears under HAPPIER_HOME_DIR", async () => {
            const { mkdtemp, writeFile, rm, mkdir } = await import("node:fs/promises");
            const { tmpdir } = await import("node:os");
            const { join } = await import("node:path");

            const happyHomeDir = await mkdtemp(join(tmpdir(), "happier-home-dir-"));
            try {
                const accessDir = join(happyHomeDir, "relay", "access");
                const accessPath = join(accessDir, "local.json");

                const env = {
                    HAPPIER_HOME_DIR: happyHomeDir,
                    HAPPIER_TAILSCALE_INFER_PUBLIC_URL: "0",
                    HAPPIER_PUBLIC_SERVER_URL_INFER_TTL_MS: "60000",
                } as NodeJS.ProcessEnv;

                resetPublicServerUrlInferenceCacheForTests();
                const resolved1 = await resolveCachedCanonicalPublicServerUrl(env);
                expect(resolved1).toBeNull();

                await mkdir(accessDir, { recursive: true });
                await writeFile(
                    accessPath,
                    JSON.stringify({ providerId: "cloudflareNamed", hostname: "relay.example.test", token: "secret" }),
                    "utf8",
                );

                const resolved2 = await resolveCachedCanonicalPublicServerUrl(env);
                expect(resolved2).toBe("https://relay.example.test");
            } finally {
                await rm(happyHomeDir, { recursive: true, force: true });
            }
        });

        it("re-infers after TTL when the persisted relay access config changes", async () => {
            vi.useFakeTimers();
            const now = new Date("2026-03-31T10:00:00.000Z");
            vi.setSystemTime(now);

            const { mkdtemp, writeFile, rm, mkdir } = await import("node:fs/promises");
            const { tmpdir } = await import("node:os");
            const { join } = await import("node:path");

            const homeDir = await mkdtemp(join(tmpdir(), "happier-public-url-"));
            const previousHome = process.env.HOME;
            process.env.HOME = homeDir;

            try {
                await mkdir(join(homeDir, ".happier", "relay", "access"), { recursive: true });
                const accessPath = join(homeDir, ".happier", "relay", "access", "local.json");
                await writeFile(
                    accessPath,
                    JSON.stringify({ providerId: "cloudflareNamed", hostname: "relay1.example.test", token: "secret" }),
                    "utf8",
                );

                const env = {
                    HOME: homeDir,
                    HAPPIER_TAILSCALE_INFER_PUBLIC_URL: "0",
                    HAPPIER_PUBLIC_SERVER_URL_INFER_TTL_MS: "10",
                } as NodeJS.ProcessEnv;

                resetPublicServerUrlInferenceCacheForTests();
                const resolved1 = await resolveCachedCanonicalPublicServerUrl(env);
                expect(resolved1).toBe("https://relay1.example.test");

                await writeFile(
                    accessPath,
                    JSON.stringify({ providerId: "cloudflareNamed", hostname: "relay2.example.test", token: "secret" }),
                    "utf8",
                );

                vi.setSystemTime(new Date(now.getTime() + 25));
                const resolved2 = await resolveCachedCanonicalPublicServerUrl(env);
                expect(resolved2).toBe("https://relay2.example.test");
            } finally {
                vi.useRealTimers();
                process.env.HOME = previousHome;
                await rm(homeDir, { recursive: true, force: true });
            }
        });
    });

    describe("readCanonicalPublicServerUrlFromEnv", () => {
        it("normalizes and strips userinfo/query/hash/trailing slash", () => {
            const env = {
                HAPPIER_PUBLIC_SERVER_URL: "https://user:pass@stack.example.test/?q=1#frag",
            } as NodeJS.ProcessEnv;

            expect(readCanonicalPublicServerUrlFromEnv(env)).toBe("https://stack.example.test");
        });

        it("returns null when url is missing or invalid", () => {
            expect(readCanonicalPublicServerUrlFromEnv({} as NodeJS.ProcessEnv)).toBeNull();
            expect(readCanonicalPublicServerUrlFromEnv({ HAPPIER_PUBLIC_SERVER_URL: "not-a-url" } as NodeJS.ProcessEnv)).toBeNull();
        });
    });

    describe("isRequestOnCanonicalPublicServerUrl", () => {
        it("matches on host + protocol using direct request fields", () => {
            expect(
                isRequestOnCanonicalPublicServerUrl({
                    canonicalPublicServerUrl: "https://public.example.test",
                    request: {
                        headers: {},
                        protocol: "https",
                        hostname: "public.example.test",
                    },
                }),
            ).toBe(true);
        });

        it("matches using x-forwarded-proto + x-forwarded-host when request fields are missing", () => {
            expect(
                isRequestOnCanonicalPublicServerUrl({
                    canonicalPublicServerUrl: "https://public.example.test",
                    request: {
                        headers: {
                            "x-forwarded-proto": "https",
                            "x-forwarded-host": "public.example.test",
                        },
                    },
                }),
            ).toBe(true);
        });

        it("prefers x-forwarded-host over host and uses first forwarded entry", () => {
            expect(
                isRequestOnCanonicalPublicServerUrl({
                    canonicalPublicServerUrl: "https://public.example.test",
                    request: {
                        headers: {
                            host: "wrong.example.test",
                            "x-forwarded-proto": "https",
                            "x-forwarded-host": "public.example.test, proxy.example.test",
                        },
                    },
                }),
            ).toBe(true);
        });

        it("returns false when hostname mismatches", () => {
            expect(
                isRequestOnCanonicalPublicServerUrl({
                    canonicalPublicServerUrl: "https://public.example.test",
                    request: {
                        headers: { host: "other.example.test" },
                        protocol: "https",
                    },
                }),
            ).toBe(false);
        });
    });
});
