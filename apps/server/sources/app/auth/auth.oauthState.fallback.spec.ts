import { afterEach, describe, expect, it, vi } from "vitest";

import { applyEnvValues, restoreEnv, snapshotEnv } from "@/app/api/testkit/env";

const dbAccountFindUniqueMock = vi.hoisted(() => vi.fn());
vi.mock("@/storage/db", async () => {
    const { createDbTransactionMock, inTxPostgresControlStatementMock } = await import("@/app/api/testkit/dbMocks");
    const boundary = {
        ...inTxPostgresControlStatementMock,
        account: {
            findUnique: (...args: unknown[]) => dbAccountFindUniqueMock(...args),
        },
    };
    const { wrapDb } = createDbTransactionMock(() => boundary);
    return { db: wrapDb(boundary) };
});

/**
 * Both cases reset modules and re-import the auth graph, then run the real
 * `auth.init()`; that cold import plus key derivation costs tens of seconds on a
 * loaded machine, well past the suite default. The timeout is the observed cost
 * of this file's own setup, not a tolerance for slow product code.
 */
describe("auth (oauth state fallback)", { timeout: 120_000 }, () => {
    const envBackup = snapshotEnv();

    afterEach(() => {
        restoreEnv(envBackup);
        dbAccountFindUniqueMock.mockReset();
        vi.restoreAllMocks();
        vi.resetModules();
    });

    it("keeps auth token flow available when oauth-state backend init fails", async () => {
        applyEnvValues({ HANDY_MASTER_SECRET: "fallback-seed" });
        dbAccountFindUniqueMock.mockResolvedValue({ tokenEpoch: 0, status: "active" });

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

        const token = await auth.createToken(
            "user-oauth-backend-down",
            { role: "admin" },
            { kind: "account", authority: "present_user" },
        );
        await expect(auth.verifyToken(token)).resolves.toEqual({
            userId: "user-oauth-backend-down",
            extras: { role: "admin" },
            authTokenKind: "account",
            authority: "present_user",
            authTokenMintedAuthority: "present_user",
            tokenEpoch: 0,
            legacy: false,
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
