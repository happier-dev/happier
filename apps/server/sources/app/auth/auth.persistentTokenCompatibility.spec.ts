import { afterEach, describe, expect, it, vi } from "vitest";
import * as crypto from "crypto";
import * as privacyKit from "privacy-kit";
import { auth } from "./auth";

import { applyEnvValues, restoreEnv, snapshotEnv } from "@/app/api/testkit/env";

vi.mock("crypto", async (importOriginal) => {
    const actual = await importOriginal<typeof import("crypto")>();
    // Count OS KDF work while retaining real derivation, signing and verification.
    return { ...actual, pbkdf2: vi.fn(actual.pbkdf2) };
});

const dbAccountFindUniqueMock = vi.hoisted(() => vi.fn());
vi.mock("@/storage/db", async () => {
    const { createDbTransactionMock, inTxPostgresControlStatementMock } = await import("@/app/api/testkit/dbMocks");
    // Only persistent database IO is replaced; auth and inTx retain their real logic.
    const boundary = {
        ...inTxPostgresControlStatementMock,
        account: {
            findUnique: (...args: unknown[]) => dbAccountFindUniqueMock(...args),
        },
    };
    const { wrapDb } = createDbTransactionMock(() => boundary);
    return { db: wrapDb(boundary) };
});

const MASTER_SECRET = "compat-probe-0";

// Generated from the immutable privacy-kit@0.0.25 npm artifact under Node 22,
// with time fixed to 2000-01-01. This is the original attempt-0 signing key.
const LEGACY_NODE_TOKEN =
    "eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJsZWdhY3ktbm9kZS11c2VyIiwicHJvdmVuYW5jZSI6InByaXZhY3kta2l0LTAuMC4yNS1ub2RlIiwiaWF0Ijo5NDY2ODQ4MDAsIm5iZiI6OTQ2Njg0ODAwLCJpc3MiOiJoYW5keSIsImp0aSI6ImM5YjFiMTNjLTk5MjUtNDBmYy1iMDE5LWFlMzRiNDg2NzUxNyJ9.fxMFx-QExdVNDwOMMXIo34aVn_YoWk9gH5w_AfAcE0yh6xxR2dsVfizBJ1zix6ZygEPgQpv_RIFE-5h9xf-OCw";

// Generated from the same npm artifact under Bun 1.3.5 using Happier's
// historical retry loop. Bun rejected attempts 0-4 and signed with attempt 5.
const LEGACY_BUN_RETRY_TOKEN =
    "eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJsZWdhY3ktYnVuLXVzZXIiLCJwcm92ZW5hbmNlIjoicHJpdmFjeS1raXQtMC4wLjI1LWJ1bi0xLjMuNSIsImlhdCI6OTQ2Njg0ODAwLCJuYmYiOjk0NjY4NDgwMCwiaXNzIjoiaGFuZHkiLCJqdGkiOiIzOGJkNGRhZS0yYjBhLTRiNzMtOTJkYy01NWJjZWNhNjdiZjMifQ.DN0v0CTRRGFOa8HYdpIruS90qDCbgaaLFaY0RGn7kzEh-J7_wlOf-QHaKFLf12xRc67Sn8IhIkg3zgfo7xM7CQ";

describe("auth persistent token compatibility", () => {
    const envBackup = snapshotEnv();

    afterEach(() => {
        restoreEnv(envBackup);
        dbAccountFindUniqueMock.mockReset();
        vi.clearAllMocks();
        vi.resetModules();
    });

    it("defers legacy derivation until a primary miss and preserves historical signers", async () => {
        applyEnvValues({
            HANDY_MASTER_SECRET: MASTER_SECRET,
            AUTH_TOKEN_CACHE_MAX_ENTRIES: "0",
            // This retired setting must not be able to disable the read path.
            HAPPIER_AUTH_SEED_COMPAT_ATTEMPTS: "1",
        });
        dbAccountFindUniqueMock.mockResolvedValue({ tokenEpoch: 0, status: "active" });

        const derivations = vi.mocked(crypto.pbkdf2);
        const startedAt = performance.now();
        await auth.init();
        console.info("auth startup KDF measurement", {
            derivations: derivations.mock.calls.length,
            elapsedMs: Math.round(performance.now() - startedAt),
        });
        expect(derivations).toHaveBeenCalledTimes(2);

        await expect(auth.verifyLegacyHomeToken(LEGACY_NODE_TOKEN)).resolves.toEqual({
            userId: "legacy-node-user",
            extras: { provenance: "privacy-kit-0.0.25-node" },
            authTokenKind: "account",
            authority: "present_user",
            authTokenMintedAuthority: "present_user",
            tokenEpoch: 0,
            legacy: true,
        });
        expect(derivations).toHaveBeenCalledTimes(2);

        const legacyStartedAt = performance.now();
        const concurrentLegacy = auth.verifyLegacyHomeToken(LEGACY_BUN_RETRY_TOKEN);
        await expect(auth.verifyLegacyHomeToken(LEGACY_BUN_RETRY_TOKEN)).resolves.toEqual({
            userId: "legacy-bun-user",
            extras: { provenance: "privacy-kit-0.0.25-bun-1.3.5" },
            authTokenKind: "account",
            authority: "present_user",
            authTokenMintedAuthority: "present_user",
            tokenEpoch: 0,
            legacy: true,
        });
        await expect(concurrentLegacy).resolves.toMatchObject({ userId: "legacy-bun-user" });
        console.info("auth first legacy KDF measurement", {
            derivations: derivations.mock.calls.length - 2,
            elapsedMs: Math.round(performance.now() - legacyStartedAt),
        });
        // The pinned Bun fixture rejected attempts 0-4 and signed with attempt 5.
        expect(derivations).toHaveBeenCalledTimes(8);
        await expect(auth.verifyLegacyHomeToken(LEGACY_BUN_RETRY_TOKEN)).resolves.toMatchObject({
            userId: "legacy-bun-user",
        });
        await expect(auth.verifyLegacyHomeToken("malformed")).resolves.toBeNull();
        expect(derivations).toHaveBeenCalledTimes(8);

        const attemptZero = await privacyKit.createPersistentTokenGenerator({
            service: "handy",
            seed: MASTER_SECRET,
        });
        const attemptZeroVerifier = await privacyKit.createPersistentTokenVerifier({
            service: "handy",
            publicKey: attemptZero.publicKey,
        });
        const newlyIssuedToken = await auth.createToken(
            "new-user",
            { source: "canonical" },
            { kind: "account", authority: "present_user" },
        );

        await expect(attemptZeroVerifier.verify(newlyIssuedToken)).resolves.toMatchObject({
            user: "new-user",
            extras: { source: "canonical" },
        });
    }, 60_000);
});
