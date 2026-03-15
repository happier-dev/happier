import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

const captureExceptionSpy = vi.hoisted(() => vi.fn());

vi.mock("@sentry/node", () => ({
    getClient: () => ({}),
    withScope: (callback: (scope: any) => void) => {
        callback({
            setTag: vi.fn(),
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
});
