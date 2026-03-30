import { afterEach, describe, expect, it, vi } from "vitest";
import { createEnvReset } from "../../testkit/env";
import { createRouteTestBuilder } from "../../testkit/routeTestBuilder";

const resetEnv = createEnvReset();
const combinedLoggingPath = "/logs-combined-from-cli-and-mobile-for-simple-ai-debugging";

describe("devRoutes", () => {
    afterEach(() => {
        resetEnv();
        vi.restoreAllMocks();
        vi.resetModules();
    });

    it("does not register the combined logging route when debug env is disabled", async () => {
        resetEnv({ DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING: undefined });

        const { devRoutes } = await import("./devRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: combinedLoggingPath,
            registerRoutes(app) {
                devRoutes(app as any);
            },
        });

        expect(route.routeExists).toBe(false);
    });

    it("registers the combined logging route and forwards logs to fileConsolidatedLogger", async () => {
        resetEnv({ DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING: "1" });
        const info = vi.fn();
        const warn = vi.fn();
        const debug = vi.fn();
        const error = vi.fn();

        vi.doMock("@/utils/logging/log", () => ({
            fileConsolidatedLogger: { info, warn, debug, error },
        }));

        const { devRoutes } = await import("./devRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: combinedLoggingPath,
            defaultRequest: {
                body: {
                    timestamp: "2026-02-12T00:00:00.000Z",
                    level: "info",
                    message: "hello",
                    source: "cli",
                    platform: "darwin",
                },
            },
            registerRoutes(app) {
                devRoutes(app as any);
            },
        });

        const { reply } = await route.invoke();

        expect(info).toHaveBeenCalledWith(
            {
                source: "cli",
                platform: "darwin",
                timestamp: "2026-02-12T00:00:00.000Z",
            },
            "hello",
        );
        expect(reply.send).toHaveBeenCalledWith({ success: true });
    });
});
