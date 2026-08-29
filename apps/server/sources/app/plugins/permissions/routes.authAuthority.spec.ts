import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";

const accountFindUnique = vi.hoisted(() => vi.fn(async () => ({ id: "account-1", tokenEpoch: 0 })));
const repeatKeyFindUnique = vi.hoisted(() => vi.fn(async () => null));

vi.mock("@/storage/db", () => ({
    db: {
        account: { findUnique: accountFindUnique },
        repeatKey: { findUnique: repeatKeyFindUnique },
    },
}));

import { auth } from "@/app/auth/auth";
import { enableAuthentication } from "@/app/api/utils/enableAuthentication";
import { registerPluginPermissionGrantRoutes } from "./routes";

describe("plugin permission grant HTTP auth authority", () => {
    beforeAll(async () => {
        vi.stubEnv("HANDY_MASTER_SECRET", "permission-route-real-token-authority");
        vi.stubEnv("AUTH_REQUIRED_LOGIN_PROVIDERS", "");
        vi.stubEnv("AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS", "0");
        vi.stubEnv("AUTH_LOGIN_ELIGIBILITY_ACCOUNT_SNAPSHOT_CACHE_TTL_MS", "0");
        await auth.init();
    });

    afterAll(() => vi.unstubAllEnvs());

    function buildApp(operations: Record<string, (...args: unknown[]) => unknown>) {
        const app = Fastify({ logger: false });
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        const typed = app.withTypeProvider<ZodTypeProvider>() as any;
        enableAuthentication(typed);
        registerPluginPermissionGrantRoutes(typed, { operations: operations as never });
        return app;
    }

    it("rejects account-automation credentials before grant and dismiss decisions and admits a present user", async () => {
        const operations = {
            grant: vi.fn(async () => ({})),
            dismissRequest: vi.fn(async () => ({})),
        };
        const app = buildApp(operations);
        await app.ready();

        try {
            const [presentUserToken, terminalToken] = await Promise.all([
                auth.createToken("account-1"),
                auth.createToken("account-1", { session: "terminal-automation" }),
            ]);

            for (const [path, body] of [
                ["/v1/plugins/permissions/grants/grant", { requestId: "request-1" }],
                ["/v1/plugins/permissions/grants/dismissRequest", { requestId: "request-1" }],
            ] as const) {
                const automationResponse = await app.inject({
                    method: "POST",
                    url: path,
                    headers: { authorization: `Bearer ${terminalToken}` },
                    payload: body,
                });
                expect(automationResponse.statusCode).toBe(403);
                expect(automationResponse.json()).toEqual({ error: "present_user_required" });
            }

            const presentUserResponse = await app.inject({
                method: "POST",
                url: "/v1/plugins/permissions/grants/grant",
                headers: { authorization: `Bearer ${presentUserToken}` },
                payload: { requestId: "request-1" },
            });
            expect(presentUserResponse.statusCode).toBe(200);
            expect(operations.grant).toHaveBeenCalledTimes(1);
            expect(operations.dismissRequest).not.toHaveBeenCalled();
        } finally {
            await app.close();
        }
    });

    it("refuses user-side revocation for account-automation credentials and admits a present user", async () => {
        const operations = {
            revoke: vi.fn(async () => ({ grant: { id: "grant-1" } })),
        };
        const app = buildApp(operations);
        await app.ready();

        try {
            const [presentUserToken, terminalToken] = await Promise.all([
                auth.createToken("account-1"),
                auth.createToken("account-1", { session: "terminal-automation" }),
            ]);

            const automationResponse = await app.inject({
                method: "POST",
                url: "/v1/plugins/permissions/grants/revoke",
                headers: { authorization: `Bearer ${terminalToken}` },
                payload: { grantId: "grant-1" },
            });
            expect(automationResponse.statusCode).toBe(403);
            expect(automationResponse.json()).toEqual({ error: "present_user_required" });

            const presentUserResponse = await app.inject({
                method: "POST",
                url: "/v1/plugins/permissions/grants/revoke",
                headers: { authorization: `Bearer ${presentUserToken}` },
                payload: { grantId: "grant-1" },
            });
            expect(presentUserResponse.statusCode).toBe(200);
            expect(operations.revoke).toHaveBeenCalledTimes(1);
        } finally {
            await app.close();
        }
    });
});
