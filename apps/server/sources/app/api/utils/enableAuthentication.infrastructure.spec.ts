import Fastify from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { applyEnvValues, restoreEnv, snapshotEnv } from "@/testkit/env";
import { homeConfigSnapshotPostgresQueryMock } from '@/app/home/settings/homeConfigSnapshot.testkit';

const boundary = vi.hoisted(() => ({
    account: { findUnique: vi.fn() },
    homeSettings: { findUnique: vi.fn() },
    homeGovernancePolicy: { findUnique: vi.fn() },
}));
vi.mock("@/storage/db", async () => {
    const { createDbTransactionMock, inTxPostgresControlStatementMock } = await import("@/app/api/testkit/dbMocks");
    // Replace database IO only; token crypto, transactions and HTTP error handling remain real.
    return { db: createDbTransactionMock(() => ({ ...inTxPostgresControlStatementMock, ...homeConfigSnapshotPostgresQueryMock, ...boundary })).wrapDb(boundary) };
});

describe("authentication infrastructure failures", () => {
    const envBackup = snapshotEnv();

    beforeAll(async () => {
        // Load the overlapping auth module graphs sequentially, before exercising requests.
        await import("@/app/auth/auth");
        await import("./enableAuthentication");
        await import("./enableErrorHandlers");
        await import("./optionalPublicAuth");
    }, 120_000);

    beforeEach(() => {
        applyEnvValues({
            HANDY_MASTER_SECRET: "auth-infrastructure-test",
            HAPPIER_DB_PROVIDER: "postgres",
            AUTH_REQUIRED_LOGIN_PROVIDERS: "",
        });
        boundary.account.findUnique.mockReset();
        boundary.account.findUnique.mockResolvedValue({ id: "u1", tokenEpoch: 0, status: "active" });
        boundary.homeSettings.findUnique.mockReset();
        boundary.homeSettings.findUnique.mockResolvedValue(null);
        boundary.homeGovernancePolicy.findUnique.mockReset();
        boundary.homeGovernancePolicy.findUnique.mockResolvedValue(null);
    });

    afterEach(() => restoreEnv(envBackup));

    async function createApp() {
        const { auth } = await import("@/app/auth/auth");
        const { enableAuthentication } = await import("./enableAuthentication");
        const { enableErrorHandlers } = await import("./enableErrorHandlers");
        const { readOptionalPublicAuthDisposition } = await import("./optionalPublicAuth");
        await auth.init();
        const token = await auth.createToken("u1", undefined, { kind: "account", authority: "present_user" });
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
        enableErrorHandlers(app);
        enableAuthentication(app);
        app.get("/private", {
            preHandler: app.authenticate,
        }, async () => ({ ok: true }));
        app.get("/public", async (request) => readOptionalPublicAuthDisposition(request.headers.authorization));
        return { app, token };
    }

    it.each(["credential", "configuration", "optional"] as const)(
        "returns typed unavailability on a %s database failure and accepts the same credential after recovery",
        async (phase) => {
            const { app, token } = await createApp();
            const failure = Object.assign(new Error("private database connection detail"), { code: "P1017" });
            const reader = phase === "configuration" ? boundary.homeSettings.findUnique : boundary.account.findUnique;
            let injectedFailureReached = false;
            reader.mockImplementationOnce(async () => {
                injectedFailureReached = true;
                throw failure;
            });
            const url = phase === "optional" ? "/public" : "/private";
            try {
                const failed = await app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
                expect(injectedFailureReached).toBe(true);
                expect(failed.statusCode).toBe(503);
                expect(failed.json()).toEqual({
                    error: "database_connection_unavailable",
                    statusCode: 503,
                });
                const recovered = await app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
                expect(recovered.statusCode).toBe(200);
                if (phase === "optional") expect(recovered.json().status).not.toBe("anonymous");
                else expect(recovered.json()).toEqual({ ok: true });
            } finally {
                await app.close();
            }
        },
    );

    it("keeps invalid signed credentials at 401 and anonymous on optional public routes", async () => {
        const { app } = await createApp();
        try {
            const headers = { authorization: "Bearer invalid-signature" };
            const rejected = await app.inject({ method: "GET", url: "/private", headers });
            expect(rejected.statusCode).toBe(401);
            expect(rejected.json()).toEqual({ error: "invalid_token" });
            const anonymous = await app.inject({ method: "GET", url: "/public", headers });
            expect(anonymous.statusCode).toBe(200);
            expect(anonymous.json()).toEqual({ status: "anonymous" });
        } finally {
            await app.close();
        }
    });

});
