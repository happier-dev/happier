import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createEnvReset } from "../../testkit/env";
import { createRouteTestBuilder } from "../../testkit/routeTestBuilder";

const resetEnv = createEnvReset();

describe("bugReportDiagnosticsRoutes", () => {
    beforeEach(() => {
        vi.resetModules();
        resetEnv();
    });

    afterEach(() => {
        resetEnv();
    });

    async function createDiagnosticsRoute() {
        const { bugReportDiagnosticsRoutes } = await import("./bugReportDiagnosticsRoutes");
        return createRouteTestBuilder({
            method: "GET",
            path: "/v1/diagnostics/bug-report-snapshot",
            defaultRequest: { query: {}, userId: "user-1" },
            registerRoutes(app) {
                bugReportDiagnosticsRoutes(app as any);
            },
        });
    }

    it("returns 404 when diagnostics endpoint is disabled", async () => {
        resetEnv({
            HAPPIER_BUG_REPORTS_SERVER_DIAGNOSTICS_ENABLED: "0",
        });
        const route = await createDiagnosticsRoute();
        const { reply, response } = await route.invoke();

        expect(reply.code).toHaveBeenCalledWith(404);
        expect((response as any).error).toContain("disabled");
    });

    it("registers rate limiting for diagnostics endpoint", async () => {
        const route = await createDiagnosticsRoute();
        const entry = route.app.routes.get("GET /v1/diagnostics/bug-report-snapshot");

        expect(entry?.opts?.config?.rateLimit).toEqual(
            expect.objectContaining({
                max: expect.any(Number),
                timeWindow: expect.any(String),
            }),
        );
    });

    it("allows overriding diagnostics snapshot max/window via HAPPIER_DIAGNOSTICS_BUG_REPORT_SNAPSHOT_RATE_LIMIT_*", async () => {
        resetEnv({
            HAPPIER_DIAGNOSTICS_BUG_REPORT_SNAPSHOT_RATE_LIMIT_MAX: "7",
            HAPPIER_DIAGNOSTICS_BUG_REPORT_SNAPSHOT_RATE_LIMIT_WINDOW: "30 seconds",
        });

        const route = await createDiagnosticsRoute();
        const entry = route.app.routes.get("GET /v1/diagnostics/bug-report-snapshot");

        expect(entry?.opts?.config?.rateLimit).toEqual(
            expect.objectContaining({
                max: 7,
                timeWindow: "30 seconds",
            }),
        );
    });

    it("returns redacted log tail when enabled", async () => {
        const dir = mkdtempSync(join(tmpdir(), "happier-bug-report-diag-"));
        const logPath = join(dir, "server.log");
        writeFileSync(logPath, "INFO hello\nauthorization: bearer ghp_abcd1234abcd1234abcd1234\n", "utf8");
        resetEnv({
            HAPPIER_BUG_REPORTS_SERVER_DIAGNOSTICS_ENABLED: "1",
            HAPPIER_BUG_REPORTS_SERVER_DIAGNOSTICS_ACCESS_MODE: "authenticated",
            HAPPIER_BUG_REPORTS_SERVER_LOG_PATH: logPath,
        });

        try {
            const route = await createDiagnosticsRoute();
            const { response } = await route.invoke();

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
        resetEnv({
            HAPPIER_BUG_REPORTS_SERVER_DIAGNOSTICS_ENABLED: "1",
            HAPPIER_BUG_REPORTS_SERVER_DIAGNOSTICS_ACCESS_MODE: "authenticated",
            HAPPIER_BUG_REPORTS_SERVER_LOG_PATH: logPath,
            HAPPIER_BUG_REPORTS_SERVER_LOG_MAX_BYTES: "256",
        });

        try {
            const route = await createDiagnosticsRoute();
            const { response } = await route.invoke({ query: { lines: 500 } });

            expect((response as any).enabled).toBe(true);
            expect((response as any).logs.path).toBeNull();
            const tailBytes = Buffer.byteLength(String((response as any).logs.tail ?? ""), "utf8");
            expect(tailBytes).toBeLessThanOrEqual(4096);
            expect((response as any).logs.tail).not.toContain(prefix);
            expect((response as any).logs.tail).toContain(suffix);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("does not fail when configured log path exists but cannot be read", async () => {
        const dir = mkdtempSync(join(tmpdir(), "happier-bug-report-diag-unreadable-"));
        resetEnv({
            HAPPIER_BUG_REPORTS_SERVER_DIAGNOSTICS_ENABLED: "1",
            HAPPIER_BUG_REPORTS_SERVER_DIAGNOSTICS_ACCESS_MODE: "authenticated",
            HAPPIER_BUG_REPORTS_SERVER_LOG_PATH: dir,
        });

        try {
            const route = await createDiagnosticsRoute();
            const { response } = await route.invoke();

            expect((response as any).enabled).toBe(true);
            expect((response as any).logs.tail).toBe("");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("returns 403 for non-owner when owner-only access mode is enabled", async () => {
        resetEnv({
            HAPPIER_BUG_REPORTS_SERVER_DIAGNOSTICS_ENABLED: "1",
            HAPPIER_BUG_REPORTS_SERVER_DIAGNOSTICS_ACCESS_MODE: "owner",
            HAPPIER_SERVER_OWNER_USER_IDS: "owner-1,owner-2",
        });

        const route = await createDiagnosticsRoute();
        const { reply, response } = await route.invoke();

        expect(reply.code).toHaveBeenCalledWith(403);
        expect((response as any).error).toContain("owner");
    });

    it("defaults to owner-only access and rejects requests when owners are not configured", async () => {
        resetEnv({
            HAPPIER_BUG_REPORTS_SERVER_DIAGNOSTICS_ENABLED: "1",
            HAPPIER_BUG_REPORTS_SERVER_DIAGNOSTICS_ACCESS_MODE: undefined,
            HAPPIER_SERVER_OWNER_USER_IDS: undefined,
        });

        const route = await createDiagnosticsRoute();
        const { reply, response } = await route.invoke({ userId: "member-1" });

        expect(reply.code).toHaveBeenCalledWith(403);
        expect(String((response as any).error ?? "")).toContain("configured");
    });

    it("defaults to owner-only access and rejects non-owner users when owners are configured", async () => {
        resetEnv({
            HAPPIER_BUG_REPORTS_SERVER_DIAGNOSTICS_ENABLED: "1",
            HAPPIER_BUG_REPORTS_SERVER_DIAGNOSTICS_ACCESS_MODE: undefined,
            HAPPIER_SERVER_OWNER_USER_IDS: "owner-1,owner-2",
        });

        const route = await createDiagnosticsRoute();
        const { reply, response } = await route.invoke({ userId: "member-1" });

        expect(reply.code).toHaveBeenCalledWith(403);
        expect(String((response as any).error ?? "")).toContain("owner");
    });

    it("allows owner when owner-only access mode is enabled", async () => {
        resetEnv({
            HAPPIER_BUG_REPORTS_SERVER_DIAGNOSTICS_ENABLED: "1",
            HAPPIER_BUG_REPORTS_SERVER_DIAGNOSTICS_ACCESS_MODE: "owner",
            HAPPIER_SERVER_OWNER_USER_IDS: "owner-1,owner-2",
        });

        const route = await createDiagnosticsRoute();
        const { response } = await route.invoke({ userId: "owner-2" });

        expect((response as any).enabled).toBe(true);
    });

    it("returns 403 when owner-only mode is enabled without configured owners", async () => {
        resetEnv({
            HAPPIER_BUG_REPORTS_SERVER_DIAGNOSTICS_ENABLED: "1",
            HAPPIER_BUG_REPORTS_SERVER_DIAGNOSTICS_ACCESS_MODE: "owner",
            HAPPIER_SERVER_OWNER_USER_IDS: "   ",
        });

        const route = await createDiagnosticsRoute();
        const { reply, response } = await route.invoke({ userId: "owner-1" });

        expect(reply.code).toHaveBeenCalledWith(403);
        expect((response as any).error).toContain("configured");
    });

    it("returns 403 when diagnostics access mode env is invalid", async () => {
        resetEnv({
            HAPPIER_BUG_REPORTS_SERVER_DIAGNOSTICS_ENABLED: "1",
            HAPPIER_BUG_REPORTS_SERVER_DIAGNOSTICS_ACCESS_MODE: "oops",
            HAPPIER_SERVER_OWNER_USER_IDS: "owner-1",
        });

        const route = await createDiagnosticsRoute();
        const { reply, response } = await route.invoke({ userId: "owner-1" });

        expect(reply.code).toHaveBeenCalledWith(403);
        expect(String((response as any).error ?? "")).toMatch(/invalid/i);
    });
});
