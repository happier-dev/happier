import { afterEach, describe, expect, it, vi } from "vitest";

import {
    createV2SessionListServerTiming,
    V2_SESSION_LIST_SERVER_TIMING_REQUEST_HEADER,
} from "./v2SessionListServerTiming";

describe("v2SessionListServerTiming", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("attributes opt-in query time to strict internal owners while retaining the aggregate", async () => {
        const now = vi.fn()
            .mockReturnValueOnce(0)
            .mockReturnValueOnce(10)
            .mockReturnValueOnce(15)
            .mockReturnValueOnce(20)
            .mockReturnValueOnce(28)
            .mockReturnValueOnce(30);
        vi.stubGlobal("performance", { now });
        const timing = createV2SessionListServerTiming({
            headers: { [V2_SESSION_LIST_SERVER_TIMING_REQUEST_HEADER]: "1" },
        });
        const header = vi.fn();

        await timing.measureQuery("page", async () => "page");
        await timing.initialPageTiming().measureQuery("attention", async () => "attention");
        timing.apply({ header });

        expect(header).toHaveBeenCalledWith("Server-Timing", [
            "happier_v2_sessions_cursor;dur=0.000",
            "happier_v2_sessions_query;dur=13.000",
            "happier_v2_sessions_query_page;dur=5.000",
            "happier_v2_sessions_query_pinned;dur=0.000",
            "happier_v2_sessions_query_attention;dur=8.000",
            "happier_v2_sessions_query_active;dur=0.000",
            "happier_v2_sessions_query_required;dur=0.000",
            "happier_v2_sessions_query_archived;dur=0.000",
            "happier_v2_sessions_page;dur=0.000",
            "happier_v2_sessions_total;dur=30.000",
        ].join(", "));
        expect(JSON.stringify(header.mock.calls)).not.toMatch(/account|sessionId|url|token|queryText|params/i);
    });

    it("is silent and does not read the clock beyond construction when timing is not requested", async () => {
        const now = vi.fn().mockReturnValue(0);
        vi.stubGlobal("performance", { now });
        const timing = createV2SessionListServerTiming({ headers: {} });
        const header = vi.fn();

        await timing.measureQuery("page", async () => "page");
        timing.apply({ header });

        expect(header).not.toHaveBeenCalled();
        expect(now).toHaveBeenCalledTimes(1);
    });
});
