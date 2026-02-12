import { existsSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { redactBugReportSensitiveText } from "@happier-dev/protocol";

import { parseBooleanEnv, parseIntEnv } from "@/config/env";
import { isServerOwnerUserId, resolveServerOwnerUserIds } from "@/app/features/serverOwners";
import { type Fastify } from "../../types";

function resolveServerLogPath(): string | null {
    const explicit = (process.env.HAPPIER_BUG_REPORTS_SERVER_LOG_PATH ?? "").trim();
    if (explicit) return explicit;
    const logDir = (process.env.HAPPIER_SELF_HOST_LOG_DIR ?? "").trim();
    if (logDir) return join(logDir, "server.log");
    return null;
}

function tailLines(input: string, maxLines: number): string {
    return input
        .split(/\r?\n/)
        .slice(-Math.max(1, maxLines))
        .join("\n");
}

function resolveServerLogMaxBytes(raw: string | undefined): number {
    const fallback = 262_144;
    const min = 4_096;
    const max = 5 * 1024 * 1024;
    if (typeof raw !== "string") return fallback;
    const parsed = Number.parseInt(raw.trim(), 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
}

async function readTailBytes(path: string, maxBytes: number): Promise<string> {
    const file = await open(path, "r");
    try {
        const stats = await file.stat();
        const normalizedMax = Math.max(4_096, Math.floor(maxBytes));
        const start = Math.max(0, stats.size - normalizedMax);
        const size = Math.max(0, stats.size - start);
        if (size <= 0) return "";
        const buffer = Buffer.alloc(size);
        await file.read(buffer, 0, size, start);
        return buffer.toString("utf8");
    } finally {
        await file.close();
    }
}

function resolveDiagnosticsRateLimitMax(raw: string | undefined): number {
    const fallback = 30;
    const min = 1;
    const max = 5_000;
    if (typeof raw !== "string") return fallback;
    const parsed = Number.parseInt(raw.trim(), 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
}

function resolveDiagnosticsRateLimitWindow(raw: string | undefined): string {
    const value = (raw ?? "").trim();
    return value.length > 0 ? value : "1 minute";
}

type DiagnosticsAccessMode = "authenticated" | "owner";

function resolveDiagnosticsAccessMode(raw: string | undefined): { mode: DiagnosticsAccessMode; invalid: boolean } {
    const value = (raw ?? "").trim().toLowerCase();
    if (!value) return { mode: "owner", invalid: false };
    if (value === "owner") return { mode: "owner", invalid: false };
    if (value === "authenticated") return { mode: "authenticated", invalid: false };
    return { mode: "owner", invalid: true };
}

export function bugReportDiagnosticsRoutes(app: Fastify) {
    app.get("/v1/diagnostics/bug-report-snapshot", {
        schema: {
            querystring: z.object({
                lines: z.coerce.number().int().min(10).max(500).optional(),
            }),
        },
        preHandler: app.authenticate,
        config: {
            rateLimit: {
                max: resolveDiagnosticsRateLimitMax(process.env.HAPPIER_BUG_REPORTS_SERVER_DIAGNOSTICS_RATE_LIMIT_MAX),
                timeWindow: resolveDiagnosticsRateLimitWindow(process.env.HAPPIER_BUG_REPORTS_SERVER_DIAGNOSTICS_RATE_LIMIT_WINDOW),
            },
        },
    }, async (request, reply) => {
        const enabled = parseBooleanEnv(process.env.HAPPIER_BUG_REPORTS_SERVER_DIAGNOSTICS_ENABLED, false);
        if (!enabled) {
            return reply.code(404).send({
                error: "Server diagnostics snapshot is disabled",
            });
        }
        const diagnosticsAccess = resolveDiagnosticsAccessMode(process.env.HAPPIER_BUG_REPORTS_SERVER_DIAGNOSTICS_ACCESS_MODE);
        if (diagnosticsAccess.invalid) {
            return reply.code(403).send({
                error: "Invalid diagnostics access mode configuration",
            });
        }
        if (diagnosticsAccess.mode === "owner") {
            const ownerUserIds = resolveServerOwnerUserIds(process.env);
            if (ownerUserIds.length === 0) {
                return reply.code(403).send({
                    error: "Server diagnostics owner access mode requires configured owner user ids",
                });
            }
            if (!isServerOwnerUserId(process.env, request.userId)) {
                return reply.code(403).send({
                    error: "Server diagnostics are restricted to configured server owners",
                });
            }
        }

        const query = request.query as { lines?: string | number | undefined };
        const linesRaw = typeof query?.lines === "number" ? String(query.lines) : query?.lines;
        const lines = parseIntEnv(linesRaw, 120, { min: 10, max: 500 });
        const maxBytes = resolveServerLogMaxBytes(process.env.HAPPIER_BUG_REPORTS_SERVER_LOG_MAX_BYTES);
        const logPath = resolveServerLogPath();
        let tail = "";
        if (logPath && existsSync(logPath)) {
            try {
                const content = await readTailBytes(logPath, maxBytes);
                tail = redactBugReportSensitiveText(tailLines(content, lines));
            } catch {
                tail = "";
            }
        }

        return reply.send({
            enabled: true,
            collectedAt: new Date().toISOString(),
            runtime: {
                node: process.version,
                platform: process.platform,
                pid: process.pid,
                uptimeSeconds: Math.floor(process.uptime()),
                env: {
                    nodeEnv: process.env.NODE_ENV ?? null,
                    serverHost: process.env.HAPPIER_SERVER_HOST ?? process.env.HAPPY_SERVER_HOST ?? null,
                    serverPort: process.env.PORT ?? null,
                },
            },
            logs: {
                path: null,
                lines,
                maxBytes,
                tail,
            },
        });
    });
}
