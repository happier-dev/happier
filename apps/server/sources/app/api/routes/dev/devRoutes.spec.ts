import { afterEach, describe, expect, it, vi } from "vitest";

const originalEnv = { ...process.env };

describe("devRoutes", () => {
    afterEach(() => {
        process.env = { ...originalEnv };
        vi.restoreAllMocks();
        vi.resetModules();
    });

    it("does not register the combined logging route when debug env is disabled", async () => {
        delete process.env.DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING;
        const post = vi.fn();

        const { devRoutes } = await import("./devRoutes");
        devRoutes({ post } as any);

        expect(post).not.toHaveBeenCalled();
    });

    it("registers the combined logging route and forwards logs to fileConsolidatedLogger", async () => {
        process.env.DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING = "1";
        const post = vi.fn();
        const info = vi.fn();
        const warn = vi.fn();
        const debug = vi.fn();
        const error = vi.fn();

        vi.doMock("@/utils/logging/log", () => ({
            fileConsolidatedLogger: { info, warn, debug, error },
        }));

        const { devRoutes } = await import("./devRoutes");
        devRoutes({ post } as any);

        expect(post).toHaveBeenCalledTimes(1);
        expect(post.mock.calls[0]?.[0]).toBe("/logs-combined-from-cli-and-mobile-for-simple-ai-debugging");

        const handler = post.mock.calls[0]?.[2] as (request: any, reply: any) => Promise<unknown>;
        const send = vi.fn((payload: unknown) => payload);

        await handler(
            {
                body: {
                    timestamp: "2026-02-12T00:00:00.000Z",
                    level: "info",
                    message: "hello",
                    source: "cli",
                    platform: "darwin",
                },
            },
            { send },
        );

        expect(info).toHaveBeenCalledWith(
            {
                source: "cli",
                platform: "darwin",
                timestamp: "2026-02-12T00:00:00.000Z",
            },
            "hello",
        );
        expect(send).toHaveBeenCalledWith({ success: true });
    });
});
