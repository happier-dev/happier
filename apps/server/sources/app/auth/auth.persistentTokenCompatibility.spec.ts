import { afterEach, describe, expect, it, vi } from "vitest";

import { applyEnvValues, restoreEnv, snapshotEnv } from "@/app/api/testkit/env";

const dbAccountFindUniqueMock = vi.hoisted(() => vi.fn());
vi.mock("@/storage/db", () => ({
    db: {
        account: {
            findUnique: (...args: unknown[]) => dbAccountFindUniqueMock(...args),
        },
    },
}));

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
        vi.resetModules();
    });

    it("keeps attempt-0 as the only signing key while accepting historical Node and Bun tokens", async () => {
        applyEnvValues({
            HANDY_MASTER_SECRET: MASTER_SECRET,
            AUTH_TOKEN_CACHE_MAX_ENTRIES: "0",
            // This retired setting must not be able to disable the read path.
            HAPPIER_AUTH_SEED_COMPAT_ATTEMPTS: "1",
        });
        dbAccountFindUniqueMock.mockResolvedValue({ tokenEpoch: 0 });

        const [{ auth }, privacyKit] = await Promise.all([
            import("./auth"),
            import("privacy-kit"),
        ]);
        await auth.init();

        await expect(auth.verifyToken(LEGACY_NODE_TOKEN)).resolves.toEqual({
            userId: "legacy-node-user",
            extras: { provenance: "privacy-kit-0.0.25-node" },
        });
        await expect(auth.verifyToken(LEGACY_BUN_RETRY_TOKEN)).resolves.toEqual({
            userId: "legacy-bun-user",
            extras: { provenance: "privacy-kit-0.0.25-bun-1.3.5" },
        });

        const attemptZero = await privacyKit.createPersistentTokenGenerator({
            service: "handy",
            seed: MASTER_SECRET,
        });
        const attemptZeroVerifier = await privacyKit.createPersistentTokenVerifier({
            service: "handy",
            publicKey: attemptZero.publicKey,
        });
        const newlyIssuedToken = await auth.createToken("new-user", { source: "canonical" });

        await expect(attemptZeroVerifier.verify(newlyIssuedToken)).resolves.toMatchObject({
            user: "new-user",
            extras: { source: "canonical" },
        });
    });
});
