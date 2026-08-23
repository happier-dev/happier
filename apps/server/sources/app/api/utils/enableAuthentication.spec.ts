import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const verifyToken = vi.fn();
const enforceLoginEligibility = vi.fn();
const log = vi.fn();

vi.mock("@/app/auth/auth", () => ({
    auth: { verifyToken },
}));

vi.mock("@/app/auth/enforceLoginEligibility", () => ({
    enforceLoginEligibility,
}));

vi.mock("@/utils/logging/log", () => ({
    log,
}));

describe("enableAuthentication (defensive error handling)", () => {
    beforeEach(() => {
        vi.resetModules();
        verifyToken.mockReset();
        enforceLoginEligibility.mockReset();
        log.mockReset();
    });

    it("never responds with an undefined error when login eligibility rejects", async () => {
        verifyToken.mockResolvedValueOnce({ userId: "u1" });
        enforceLoginEligibility.mockResolvedValueOnce({ ok: false, statusCode: 403 } as any);

        const { enableAuthentication } = await import("./enableAuthentication");
        const app = Fastify({ logger: false }) as any;
        enableAuthentication(app);
        app.get("/private", { preHandler: app.authenticate }, async () => ({ ok: true }));
        await app.ready();

        const res = await app.inject({
            method: "GET",
            url: "/private",
            headers: { authorization: "Bearer t" },
        });

        expect(res.statusCode).toBe(403);
        expect(res.json()).toEqual({ error: "not-eligible" });

        await app.close();
    });

    it("returns 403 account-disabled when eligibility blocks a disabled account", async () => {
        verifyToken.mockResolvedValueOnce({ userId: "u1" });
        enforceLoginEligibility.mockResolvedValueOnce({ ok: false, statusCode: 403, error: "account-disabled" } as any);

        const { enableAuthentication } = await import("./enableAuthentication");
        const app = Fastify({ logger: false }) as any;
        enableAuthentication(app);
        app.get("/private", { preHandler: app.authenticate }, async () => ({ ok: true }));
        await app.ready();

        const res = await app.inject({
            method: "GET",
            url: "/private",
            headers: { authorization: "Bearer t" },
        });

        expect(res.statusCode).toBe(403);
        expect(res.json()).toEqual({ error: "account-disabled" });

        await app.close();
    });

    it("returns opaque invalid_token when bearer token verification fails", async () => {
        verifyToken.mockResolvedValueOnce(null);

        const { enableAuthentication } = await import("./enableAuthentication");
        const app = Fastify({ logger: false }) as any;
        enableAuthentication(app);
        app.get("/private", { preHandler: app.authenticate }, async () => ({ ok: true }));
        await app.ready();

        const res = await app.inject({
            method: "GET",
            url: "/private",
            headers: { authorization: "Bearer bad-token" },
        });

        expect(res.statusCode).toBe(401);
        expect(res.json()).toEqual({ error: "invalid_token" });

        await app.close();
    });

    it("returns opaque invalid_token when a token's account cannot be found", async () => {
        verifyToken.mockResolvedValueOnce({ userId: "missing-account" });
        enforceLoginEligibility.mockResolvedValueOnce({ ok: false, statusCode: 401, error: "invalid-token" } as any);

        const { enableAuthentication } = await import("./enableAuthentication");
        const app = Fastify({ logger: false }) as any;
        enableAuthentication(app);
        app.get("/private", { preHandler: app.authenticate }, async () => ({ ok: true }));
        await app.ready();

        const res = await app.inject({
            method: "GET",
            url: "/private",
            headers: { authorization: "Bearer good-signature-but-stale-account" },
        });

        expect(res.statusCode).toBe(401);
        expect(res.json()).toEqual({ error: "invalid_token" });

        await app.close();
    });

    it("does not emit per-request auth success logs by default", async () => {
        verifyToken.mockResolvedValueOnce({ userId: "u1" });
        enforceLoginEligibility.mockResolvedValueOnce({ ok: true });

        const { enableAuthentication } = await import("./enableAuthentication");
        const app = Fastify({ logger: false }) as any;
        enableAuthentication(app);
        app.get("/private", { preHandler: app.authenticate }, async () => ({ ok: true }));
        await app.ready();

        const res = await app.inject({
            method: "GET",
            url: "/private",
            headers: { authorization: "Bearer t" },
        });

        expect(res.statusCode).toBe(200);
        expect(log).not.toHaveBeenCalledWith(
            expect.objectContaining({ module: "auth-decorator" }),
            expect.stringContaining("Auth success"),
        );
        expect(log).not.toHaveBeenCalledWith(
            expect.objectContaining({ module: "auth-decorator" }),
            expect.stringContaining("Auth check"),
        );

        await app.close();
    });

    it("captures the account stored-content HTTP declaration once on the authenticated request", async () => {
        verifyToken.mockResolvedValueOnce({ userId: "u1" });
        enforceLoginEligibility.mockResolvedValueOnce({ ok: true });

        const { enableAuthentication } = await import("./enableAuthentication");
        const app = Fastify({ logger: false }) as any;
        enableAuthentication(app);
        app.get(
            "/private",
            { preHandler: app.authenticate },
            async (request: any) => request.accountStoredContentCompatibility,
        );
        await app.ready();

        const res = await app.inject({
            method: "GET",
            url: "/private",
            headers: {
                authorization: "Bearer t",
                "x-happier-account-stored-content-protocol": "1",
            },
        });

        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({
            accepted: true,
            supportsCurrentProtocol: true,
            outcome: "accepted",
            declaration: { v: 1, protocolVersion: 1 },
            upgradeRequired: null,
        });

        await app.close();
    });
});
