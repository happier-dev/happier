import { beforeEach, describe, expect, it, vi } from "vitest";

describe("app/monitoring/sentry (request exception capture)", () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
    });

    it("does not attach the client IP or user agent unless the operator enabled default PII", async () => {
        const setExtra = vi.fn();
        const captureException = vi.fn();
        vi.doMock("@sentry/node", () => ({
            getClient: () => ({}),
            withScope: (callback: (scope: unknown) => void) => callback({ setTag: vi.fn(), setExtra, setUser: vi.fn() }),
            captureException,
        }));
        const { captureFastifyExceptionForSentry } = await import("./sentry");

        captureFastifyExceptionForSentry(new Error("boom"), {
            method: "GET",
            url: "/v1/sessions",
            ip: "203.0.113.9",
            userId: "account-1",
            headers: { "user-agent": "Happier/1.0 (iPhone)" },
        });

        expect(captureException).toHaveBeenCalledTimes(1);
        const extraKeys = setExtra.mock.calls.map(([key]) => key);
        expect(extraKeys).not.toContain("http.ip");
        expect(extraKeys).not.toContain("http.userAgent");
    });
});
