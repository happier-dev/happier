import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const verifyToken = vi.fn();
const enforceLoginEligibility = vi.fn();

vi.mock("@/app/auth/auth", () => ({
    auth: { verifyToken },
}));

vi.mock("@/app/auth/enforceLoginEligibility", () => ({
    enforceLoginEligibility,
}));

describe("enableAuthentication (defensive error handling)", () => {
    beforeEach(() => {
        vi.resetModules();
        verifyToken.mockReset();
        enforceLoginEligibility.mockReset();
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

    it("returns 401 invalid-token code when bearer token verification fails", async () => {
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
        expect(res.json()).toEqual({ error: "Invalid token", code: "invalid-token" });

        await app.close();
    });

    it("returns 401 account-not-found code when token is valid but account cannot be found", async () => {
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
        expect(res.json()).toEqual({ error: "Invalid token", code: "account-not-found" });

        await app.close();
    });
});
