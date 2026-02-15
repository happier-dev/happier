import { afterEach, describe, expect, it, vi } from "vitest";

import { restoreEnv, snapshotEnv } from "@/app/api/testkit/env";

describe("auth (oauth state fallback)", () => {
    const envBackup = snapshotEnv();

    afterEach(() => {
        restoreEnv(envBackup);
        vi.restoreAllMocks();
        vi.resetModules();
    });

    it("keeps auth token flow available when oauth-state backend init fails", async () => {
        process.env.HANDY_MASTER_SECRET = "fallback-seed";

        vi.doMock("privacy-kit", async (importOriginal) => {
            const actual = await importOriginal<typeof import("privacy-kit")>();
            return {
                ...actual,
                createEphemeralTokenGenerator: vi.fn(async () => {
                    throw new Error("ephemeral-generator-failed");
                }),
                createEphemeralTokenVerifier: vi.fn(async () => {
                    throw new Error("ephemeral-verifier-should-not-be-called");
                }),
            };
        });

        const { auth } = await import("./auth");
        await expect(auth.init()).resolves.toBeUndefined();

        const token = await auth.createToken("user-oauth-backend-down", { role: "admin" });
        await expect(auth.verifyToken(token)).resolves.toEqual({
            userId: "user-oauth-backend-down",
            extras: { role: "admin" },
        });

        await expect(auth.createOauthStateToken({
            flow: "connect",
            provider: "github",
            sid: "sid_fallback",
        })).rejects.toThrow(/oauth_state_unavailable/i);
    });

    it("fails auth initialization when persistent auth token backend init fails", async () => {
        process.env.HANDY_MASTER_SECRET = "fallback-seed";

        vi.doMock("privacy-kit", async (importOriginal) => {
            const actual = await importOriginal<typeof import("privacy-kit")>();
            return {
                ...actual,
                createPersistentTokenGenerator: vi.fn(async () => {
                    throw new Error("persistent-generator-failed");
                }),
                createPersistentTokenVerifier: vi.fn(async () => {
                    throw new Error("persistent-verifier-failed");
                }),
                createEphemeralTokenGenerator: vi.fn(async () => {
                    throw new Error("ephemeral-generator-failed");
                }),
                createEphemeralTokenVerifier: vi.fn(async () => {
                    throw new Error("ephemeral-verifier-failed");
                }),
            };
        });

        const { auth } = await import("./auth");
        await expect(auth.init()).rejects.toThrow(/persistent-generator-failed/i);
    });

    it("retries persistent auth token initialization when runtime key import is incompatible", async () => {
        process.env.HANDY_MASTER_SECRET = "fallback-seed";

        let generatorCalls = 0;
        const mockGenerator = {
            publicKey: new Uint8Array([1, 2, 3]),
            new: vi.fn(async () => "token-1"),
        };
        const mockVerifier = {
            verify: vi.fn(async () => ({ user: "user-1", extras: { role: "admin" } })),
        };

        vi.doMock("privacy-kit", async (importOriginal) => {
            const actual = await importOriginal<typeof import("privacy-kit")>();
            return {
                ...actual,
                createPersistentTokenGenerator: vi.fn(async () => {
                    generatorCalls += 1;
                    if (generatorCalls === 1) {
                        const err = new DOMException(
                            "Data provided to an operation does not meet requirements",
                            "DataError",
                        );
                        throw err;
                    }
                    return mockGenerator;
                }),
                createPersistentTokenVerifier: vi.fn(async () => mockVerifier),
            };
        });

        const { auth } = await import("./auth");
        await expect(auth.init()).resolves.toBeUndefined();
        expect(generatorCalls).toBeGreaterThan(1);

        const token = await auth.createToken("user-1", { role: "admin" });
        expect(token).toBe("token-1");
        await expect(auth.verifyToken(token)).resolves.toEqual({
            userId: "user-1",
            extras: { role: "admin" },
        });
    });
});
