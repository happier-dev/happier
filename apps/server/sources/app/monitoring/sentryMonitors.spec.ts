import { describe, expect, it, vi } from "vitest";

const captureCheckInSpy = vi.hoisted(() =>
    vi.fn<(checkIn: any, monitorConfig?: any) => string>(() => "checkin-1"),
);

vi.mock("@sentry/node", () => ({
    getClient: () => ({}),
    captureCheckIn: (checkIn: any, monitorConfig?: any) => captureCheckInSpy(checkIn, monitorConfig),
}));

import { maybeCaptureSentryMonitorCheckIn } from "./sentryMonitors";

describe("app/monitoring/sentryMonitors", () => {
    it("captures in_progress and ok when enabled", async () => {
        captureCheckInSpy.mockClear();

        await maybeCaptureSentryMonitorCheckIn({
            env: { SENTRY_MONITORS_ENABLED: "1" } as any,
            monitorSlug: "server.test.job",
            intervalMs: 60_000,
            run: async () => {},
        });

        expect(captureCheckInSpy).toHaveBeenCalledTimes(2);
        const first = captureCheckInSpy.mock.calls[0]?.[0];
        const second = captureCheckInSpy.mock.calls[1]?.[0];
        expect(first).toEqual({ monitorSlug: "server.test.job", status: "in_progress" });
        expect(second).toEqual(
            expect.objectContaining({ monitorSlug: "server.test.job", status: "ok", checkInId: "checkin-1" }),
        );
    });
});
