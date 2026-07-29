import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

const captureExceptionSpy = vi.hoisted(() => vi.fn());
const sentryTags = vi.hoisted(() => new Map<string, unknown>());

vi.mock("@sentry/node", () => ({
    getClient: () => ({}),
    withScope: (callback: (scope: any) => void) => {
        callback({
            setTag: vi.fn((key: string, value: unknown) => sentryTags.set(key, value)),
            setExtra: vi.fn(),
            setUser: vi.fn(),
        });
    },
    captureException: (...args: any[]) => captureExceptionSpy(...args),
    init: vi.fn(),
}));

import { enableErrorHandlers } from "./enableErrorHandlers";

describe("app/api/utils/enableErrorHandlers (sentry)", () => {
    it("captures 5xx errors via Sentry", async () => {
        const app = Fastify({ logger: false }) as any;
        enableErrorHandlers(app);

        app.get("/boom", async () => {
            throw new Error("boom");
        });

        const response = await app.inject({ method: "GET", url: "/boom" });
        expect(response.statusCode).toBe(500);
        expect(captureExceptionSpy).toHaveBeenCalledTimes(1);
    });

    it("does not capture 4xx errors via Sentry", async () => {
        captureExceptionSpy.mockClear();

        const app = Fastify({ logger: false }) as any;
        enableErrorHandlers(app);

        app.get("/bad", async () => {
            const err: any = new Error("bad request");
            err.statusCode = 400;
            throw err;
        });

        const response = await app.inject({ method: "GET", url: "/bad" });
        expect(response.statusCode).toBe(400);
        expect(captureExceptionSpy).toHaveBeenCalledTimes(0);
    });

    it("templates public-share capabilities in Sentry path tags", async () => {
        sentryTags.clear();
        const secret = "SENTINEL_PUBLIC_SHARE_CAPABILITY";
        const app = Fastify({ logger: false }) as any;
        enableErrorHandlers(app);
        app.get("/v1/public-share/:token", async () => {
            throw new Error(`boom at /v1/public-share/${secret}`);
        });

        const response = await app.inject({ method: "GET", url: `/v1/public-share/${secret}` });

        expect(response.statusCode).toBe(500);
        expect(sentryTags.get("http.path")).toBe("/v1/public-share/:token");
        expect(String(captureExceptionSpy.mock.calls.at(-1)?.[0])).not.toContain(secret);
    });
});
