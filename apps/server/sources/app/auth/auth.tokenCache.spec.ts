import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { applyEnvValues, restoreEnv, snapshotEnv } from "@/testkit/env";
import { auth as singletonAuth } from "./auth";

const dbAccountFindUniqueMock = vi.hoisted(() => vi.fn());
vi.mock("@/storage/db", async () => {
    const { createDbTransactionMock } = await import("@/app/api/testkit/dbMocks");
    // Only persistent database IO is replaced; auth and inTx retain their real logic.
    const boundary = {
        account: {
            findUnique: (...args: unknown[]) => dbAccountFindUniqueMock(...args),
        },
    };
    const { wrapDb } = createDbTransactionMock(() => boundary);
    return { db: wrapDb(boundary) };
});

const envBackup = snapshotEnv();
// Keep the canonical crypto/module graph loaded once while giving each case a
// fresh real owner: cache TTL/capacity are captured by Auth's init lifecycle.
const AuthForTest = singletonAuth.constructor as new () => typeof singletonAuth;

describe("auth (token cache)", () => {
    let auth: typeof singletonAuth;

    beforeEach(() => {
        auth = new AuthForTest();
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

        applyEnvValues({ HANDY_MASTER_SECRET: "test-master-secret" });
        dbAccountFindUniqueMock.mockReset();
        dbAccountFindUniqueMock.mockResolvedValue({ tokenEpoch: 0, status: "active" });
    });

    afterEach(() => {
        vi.useRealTimers();
        restoreEnv(envBackup);
    });

    it("evicts expired token cache entries on insert", async () => {
        applyEnvValues({
            AUTH_TOKEN_CACHE_TTL_SECONDS: "1",
            AUTH_TOKEN_CACHE_MAX_ENTRIES: "10",
        });

        await auth.init();

        const firstToken = await auth.createToken(
            "user-1",
            undefined,
            { kind: "account", authority: "present_user" },
        );
        await auth.verifyToken(firstToken);
        expect(auth.getCacheStats().size).toBe(1);

        vi.advanceTimersByTime(1500);

        const secondToken = await auth.createToken(
            "user-2",
            undefined,
            { kind: "account", authority: "present_user" },
        );
        await auth.verifyToken(secondToken);
        expect(auth.getCacheStats().size).toBe(1);
    });

    it("refreshes terminal authority from the Account policy without trusting the crypto cache", async () => {
        await auth.init();
        dbAccountFindUniqueMock.mockResolvedValue({ tokenEpoch: 0, status: "active", terminalPresentUserPolicy: "allowed" });
        const token = await auth.createToken("terminal-policy-account", undefined, { kind: "terminal", authority: "account_automation" });
        await expect(auth.verifyToken(token)).resolves.toMatchObject({ authTokenKind: "terminal", authority: "present_user" });
        dbAccountFindUniqueMock.mockResolvedValue({ tokenEpoch: 0, status: "active", terminalPresentUserPolicy: "disallowed" });
        await expect(auth.verifyToken(token)).resolves.toMatchObject({ authTokenKind: "terminal", authority: "account_automation" });
        dbAccountFindUniqueMock.mockResolvedValue({ tokenEpoch: 0, status: "active", terminalPresentUserPolicy: "allowed" });
        await expect(auth.verifyToken(token)).resolves.toMatchObject({ authority: "present_user" });
        dbAccountFindUniqueMock.mockResolvedValue({ tokenEpoch: 0, status: "active", terminalPresentUserPolicy: "unknown" });
        await expect(auth.verifyToken(token)).resolves.toMatchObject({ authority: "account_automation" });
    });

    it("enforces a max entry limit for the token cache", async () => {
        applyEnvValues({
            AUTH_TOKEN_CACHE_TTL_SECONDS: "3600",
            AUTH_TOKEN_CACHE_MAX_ENTRIES: "2",
        });

        await auth.init();

        const firstToken = await auth.createToken(
            "user-1",
            undefined,
            { kind: "account", authority: "present_user" },
        );
        const secondToken = await auth.createToken(
            "user-2",
            undefined,
            { kind: "account", authority: "present_user" },
        );
        const thirdToken = await auth.createToken(
            "user-3",
            undefined,
            { kind: "account", authority: "present_user" },
        );
        await auth.verifyToken(firstToken);
        await auth.verifyToken(secondToken);
        await auth.verifyToken(thirdToken);

        expect(auth.getCacheStats().size).toBe(2);
    });

    it.each(["suspended", "disabled"])("rejects %s Accounts at mint and on a warmed verification cache", async (status) => {
        await auth.init();
        const token = await auth.createToken("user-1", undefined, { kind: "account", authority: "present_user" });
        await expect(auth.verifyToken(token)).resolves.toMatchObject({ userId: "user-1" });
        expect(auth.getCacheStats().size).toBeGreaterThan(0);

        // The database boundary changes independently of the crypto cache/epoch.
        dbAccountFindUniqueMock.mockResolvedValue({ tokenEpoch: 0, status });
        await expect(auth.verifyToken(token)).resolves.toBeNull();
        await expect(auth.createToken("user-1", undefined, { kind: "account", authority: "present_user" }))
            .rejects.toMatchObject({ code: "account-disabled" });
    });
});
