import { afterEach, describe, expect, it, vi } from "vitest";

import { applyEnvValues, restoreEnv, snapshotEnv } from "@/app/api/testkit/env";

describe("auth (oauth state fallback)", () => {
    const envBackup = snapshotEnv();

    afterEach(() => {
        restoreEnv(envBackup);
        vi.restoreAllMocks();
        vi.resetModules();
    });

    it("keeps auth token flow available when oauth-state backend init fails", async () => {
        applyEnvValues({ HANDY_MASTER_SECRET: "fallback-seed" });

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
        applyEnvValues({ HANDY_MASTER_SECRET: "fallback-seed" });

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

});
