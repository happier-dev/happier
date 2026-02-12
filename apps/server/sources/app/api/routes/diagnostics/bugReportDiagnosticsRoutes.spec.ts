import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createFakeRouteApp, createReplyStub, getRouteHandler } from "@/app/api/testkit/routeHarness";

const ENV_SNAPSHOT = { ...process.env };

describe("bugReportDiagnosticsRoutes", () => {
    beforeEach(() => {
        vi.resetModules();
        process.env = { ...ENV_SNAPSHOT };
    });

    afterEach(() => {
        process.env = { ...ENV_SNAPSHOT };
    });

    it("returns 404 when diagnostics endpoint is disabled", async () => {
        process.env.HAPPIER_BUG_REPORTS_SERVER_DIAGNOSTICS_ENABLED = "0";
        const { bugReportDiagnosticsRoutes } = await import("./bugReportDiagnosticsRoutes");
        const app = createFakeRouteApp();
        bugReportDiagnosticsRoutes(app as any);

        const handler = getRouteHandler(app, "GET", "/v1/diagnostics/bug-report-snapshot");
        const reply = createReplyStub();
        const response = await handler({ userId: "user-1" }, reply as any);

        expect(reply.code).toHaveBeenCalledWith(404);
        expect((response as any).error).toContain("disabled");
    });

    it("registers rate limiting for diagnostics endpoint", async () => {
        const registrations: Array<{ path: string; options: any }> = [];
        const { bugReportDiagnosticsRoutes } = await import("./bugReportDiagnosticsRoutes");
        bugReportDiagnosticsRoutes({
            authenticate: vi.fn(),
            get: (path: string, options: any, _handler: any) => {
                registrations.push({ path, options });
            },
        } as any);

        const route = registrations.find((entry) => entry.path === "/v1/diagnostics/bug-report-snapshot");
        expect(route).toBeDefined();
        expect(route?.options?.config?.rateLimit).toEqual(
            expect.objectContaining({
                max: expect.any(Number),
                timeWindow: expect.any(String),
            }),
        );
    });

    it("returns redacted log tail when enabled", async () => {
        const dir = mkdtempSync(join(tmpdir(), "happier-bug-report-diag-"));
        const logPath = join(dir, "server.log");
        writeFileSync(logPath, "INFO hello\nauthorization: bearer ghp_abcd1234abcd1234abcd1234\n", "utf8");
        process.env.HAPPIER_BUG_REPORTS_SERVER_DIAGNOSTICS_ENABLED = "1";
        process.env.HAPPIER_BUG_REPORTS_SERVER_DIAGNOSTICS_ACCESS_MODE = "authenticated";
        process.env.HAPPIER_BUG_REPORTS_SERVER_LOG_PATH = logPath;

        try {
            const { bugReportDiagnosticsRoutes } = await import("./bugReportDiagnosticsRoutes");
            const app = createFakeRouteApp();
            bugReportDiagnosticsRoutes(app as any);

            const handler = getRouteHandler(app, "GET", "/v1/diagnostics/bug-report-snapshot");
            const reply = createReplyStub();
            const response = await handler({ query: {}, userId: "user-1" }, reply as any);

            expect((response as any).enabled).toBe(true);
            expect((response as any).logs.tail).toContain("[REDACTED]");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("returns only bounded tail bytes and does not leak filesystem log path", async () => {
        const dir = mkdtempSync(join(tmpdir(), "happier-bug-report-diag-bounds-"));
        const logPath = join(dir, "server.log");
        const prefix = "BEGIN_MARKER";
        const suffix = "END_MARKER";
        const filler = "x".repeat(12_000);
        writeFileSync(logPath, `${prefix}\n${filler}\n${suffix}\n`, "utf8");
        process.env.HAPPIER_BUG_REPORTS_SERVER_DIAGNOSTICS_ENABLED = "1";
        process.env.HAPPIER_BUG_REPORTS_SERVER_DIAGNOSTICS_ACCESS_MODE = "authenticated";
        process.env.HAPPIER_BUG_REPORTS_SERVER_LOG_PATH = logPath;
        process.env.HAPPIER_BUG_REPORTS_SERVER_LOG_MAX_BYTES = "256";

        try {
            const { bugReportDiagnosticsRoutes } = await import("./bugReportDiagnosticsRoutes");
            const app = createFakeRouteApp();
            bugReportDiagnosticsRoutes(app as any);

            const handler = getRouteHandler(app, "GET", "/v1/diagnostics/bug-report-snapshot");
            const reply = createReplyStub();
            const response = await handler({ query: { lines: 500 }, userId: "user-1" }, reply as any);

            expect((response as any).enabled).toBe(true);
            expect((response as any).logs.path).toBeNull();
            const tailBytes = Buffer.byteLength(String((response as any).logs.tail ?? ''), 'utf8');
            expect(tailBytes).toBeLessThanOrEqual(4096);
            expect((response as any).logs.tail).not.toContain(prefix);
            expect((response as any).logs.tail).toContain(suffix);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("does not fail when configured log path exists but cannot be read", async () => {
        const dir = mkdtempSync(join(tmpdir(), "happier-bug-report-diag-unreadable-"));
        process.env.HAPPIER_BUG_REPORTS_SERVER_DIAGNOSTICS_ENABLED = "1";
        process.env.HAPPIER_BUG_REPORTS_SERVER_DIAGNOSTICS_ACCESS_MODE = "authenticated";
        process.env.HAPPIER_BUG_REPORTS_SERVER_LOG_PATH = dir;

        try {
            const { bugReportDiagnosticsRoutes } = await import("./bugReportDiagnosticsRoutes");
            const app = createFakeRouteApp();
            bugReportDiagnosticsRoutes(app as any);

            const handler = getRouteHandler(app, "GET", "/v1/diagnostics/bug-report-snapshot");
            const reply = createReplyStub();
            const response = await handler({ query: {}, userId: "user-1" }, reply as any);

            expect((response as any).enabled).toBe(true);
            expect((response as any).logs.tail).toBe("");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("returns 403 for non-owner when owner-only access mode is enabled", async () => {
        process.env.HAPPIER_BUG_REPORTS_SERVER_DIAGNOSTICS_ENABLED = "1";
        process.env.HAPPIER_BUG_REPORTS_SERVER_DIAGNOSTICS_ACCESS_MODE = "owner";
        process.env.HAPPIER_SERVER_OWNER_USER_IDS = "owner-1,owner-2";

        const { bugReportDiagnosticsRoutes } = await import("./bugReportDiagnosticsRoutes");
        const app = createFakeRouteApp();
        bugReportDiagnosticsRoutes(app as any);

        const handler = getRouteHandler(app, "GET", "/v1/diagnostics/bug-report-snapshot");
        const reply = createReplyStub();
        const response = await handler({ query: {}, userId: "user-1" }, reply as any);

        expect(reply.code).toHaveBeenCalledWith(403);
        expect((response as any).error).toContain("owner");
    });

    it("defaults to owner-only access and rejects requests when owners are not configured", async () => {
        process.env.HAPPIER_BUG_REPORTS_SERVER_DIAGNOSTICS_ENABLED = "1";
        delete process.env.HAPPIER_BUG_REPORTS_SERVER_DIAGNOSTICS_ACCESS_MODE;
        delete process.env.HAPPIER_SERVER_OWNER_USER_IDS;

        const { bugReportDiagnosticsRoutes } = await import("./bugReportDiagnosticsRoutes");
        const app = createFakeRouteApp();
        bugReportDiagnosticsRoutes(app as any);

        const handler = getRouteHandler(app, "GET", "/v1/diagnostics/bug-report-snapshot");
        const reply = createReplyStub();
        const response = await handler({ query: {}, userId: "member-1" }, reply as any);

        expect(reply.code).toHaveBeenCalledWith(403);
        expect(String((response as any).error ?? "")).toContain("configured");
    });

    it("defaults to owner-only access and rejects non-owner users when owners are configured", async () => {
        process.env.HAPPIER_BUG_REPORTS_SERVER_DIAGNOSTICS_ENABLED = "1";
        delete process.env.HAPPIER_BUG_REPORTS_SERVER_DIAGNOSTICS_ACCESS_MODE;
        process.env.HAPPIER_SERVER_OWNER_USER_IDS = "owner-1,owner-2";

        const { bugReportDiagnosticsRoutes } = await import("./bugReportDiagnosticsRoutes");
        const app = createFakeRouteApp();
        bugReportDiagnosticsRoutes(app as any);

        const handler = getRouteHandler(app, "GET", "/v1/diagnostics/bug-report-snapshot");
        const reply = createReplyStub();
        const response = await handler({ query: {}, userId: "member-1" }, reply as any);

        expect(reply.code).toHaveBeenCalledWith(403);
        expect(String((response as any).error ?? "")).toContain("owner");
    });

    it("allows owner when owner-only access mode is enabled", async () => {
        process.env.HAPPIER_BUG_REPORTS_SERVER_DIAGNOSTICS_ENABLED = "1";
        process.env.HAPPIER_BUG_REPORTS_SERVER_DIAGNOSTICS_ACCESS_MODE = "owner";
        process.env.HAPPIER_SERVER_OWNER_USER_IDS = "owner-1,owner-2";

        const { bugReportDiagnosticsRoutes } = await import("./bugReportDiagnosticsRoutes");
        const app = createFakeRouteApp();
        bugReportDiagnosticsRoutes(app as any);

        const handler = getRouteHandler(app, "GET", "/v1/diagnostics/bug-report-snapshot");
        const reply = createReplyStub();
        const response = await handler({ query: {}, userId: "owner-2" }, reply as any);

        expect((response as any).enabled).toBe(true);
    });

    it("returns 403 when owner-only mode is enabled without configured owners", async () => {
        process.env.HAPPIER_BUG_REPORTS_SERVER_DIAGNOSTICS_ENABLED = "1";
        process.env.HAPPIER_BUG_REPORTS_SERVER_DIAGNOSTICS_ACCESS_MODE = "owner";
        process.env.HAPPIER_SERVER_OWNER_USER_IDS = "   ";

        const { bugReportDiagnosticsRoutes } = await import("./bugReportDiagnosticsRoutes");
        const app = createFakeRouteApp();
        bugReportDiagnosticsRoutes(app as any);

        const handler = getRouteHandler(app, "GET", "/v1/diagnostics/bug-report-snapshot");
        const reply = createReplyStub();
        const response = await handler({ query: {}, userId: "owner-1" }, reply as any);

        expect(reply.code).toHaveBeenCalledWith(403);
        expect((response as any).error).toContain("configured");
    });

    it("returns 403 when diagnostics access mode env is invalid", async () => {
        process.env.HAPPIER_BUG_REPORTS_SERVER_DIAGNOSTICS_ENABLED = "1";
        process.env.HAPPIER_BUG_REPORTS_SERVER_DIAGNOSTICS_ACCESS_MODE = "oops";
        process.env.HAPPIER_SERVER_OWNER_USER_IDS = "owner-1";

        const { bugReportDiagnosticsRoutes } = await import("./bugReportDiagnosticsRoutes");
        const app = createFakeRouteApp();
        bugReportDiagnosticsRoutes(app as any);

        const handler = getRouteHandler(app, "GET", "/v1/diagnostics/bug-report-snapshot");
        const reply = createReplyStub();
        const response = await handler({ query: {}, userId: "owner-1" }, reply as any);

        expect(reply.code).toHaveBeenCalledWith(403);
        expect(String((response as any).error ?? "")).toMatch(/invalid/i);
    });
});
