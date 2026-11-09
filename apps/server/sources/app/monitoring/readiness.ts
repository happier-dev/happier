import type { FastifyReply } from "fastify";

import {
    dbReadinessChecksCounter,
    dbReadinessDurationHistogram,
} from "@/app/monitoring/metrics2";
import { probeDbReadiness } from "@/storage/db";
import { log } from "@/utils/logging/log";
import { isShutdown } from "@/utils/process/shutdown";

const MONITORING_SERVICE_NAME = 'happier-server';
const DB_READINESS_ERROR = 'Database connectivity failed';
const DB_READINESS_TIMEOUT_MS_ENV = 'HAPPIER_DB_READINESS_TIMEOUT_MS';
const DEFAULT_DB_READINESS_TIMEOUT_MS = 15_000;

type DbReadinessResult = "ok" | "error";
type DbReadinessReason = "none" | "db_error" | "db_timeout" | "backpressure" | "unknown";

class DbReadinessTimeoutError extends Error {
    constructor(timeoutMs: number) {
        super(`Database readiness check timed out after ${timeoutMs}ms`);
        this.name = 'DbReadinessTimeoutError';
    }
}

function resolveDbReadinessTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
    const configured = env[DB_READINESS_TIMEOUT_MS_ENV];
    if (configured === undefined || configured.trim() === '') {
        return DEFAULT_DB_READINESS_TIMEOUT_MS;
    }

    const parsed = Number(configured);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DB_READINESS_TIMEOUT_MS;
}

let inFlightDbReadinessCheck: Promise<void> | null = null;

async function withDbReadinessTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            operation,
            new Promise<never>((_, reject) => {
                timeout = setTimeout(() => {
                    reject(new DbReadinessTimeoutError(timeoutMs));
                }, timeoutMs);
            }),
        ]);
    } finally {
        if (timeout) {
            clearTimeout(timeout);
        }
    }
}

async function runDatabaseReadinessQuery(): Promise<void> {
    await probeDbReadiness();
}

export function createHealthyMonitoringResponse() {
    return {
        status: 'ok',
        timestamp: new Date().toISOString(),
        service: MONITORING_SERVICE_NAME,
    };
}

export type DatabaseReadinessResponseOptions = Readonly<{
    /** Only the API that listened passes this, so other `/ready` routes cannot carry its identity. */
    apiStartupInstanceId?: string | null;
}>;

export function createShuttingDownMonitoringResponse() {
    return {
        status: 'error',
        timestamp: new Date().toISOString(),
        service: MONITORING_SERVICE_NAME,
        reason: 'shutting_down',
    };
}

export function sendLivenessResponse(reply: FastifyReply): void {
    if (isShutdown()) {
        reply.code(503).send(createShuttingDownMonitoringResponse());
        return;
    }
    reply.send(createHealthyMonitoringResponse());
}

async function checkDatabaseReadiness() {
    if (!inFlightDbReadinessCheck) {
        const check = withDbReadinessTimeout(runDatabaseReadinessQuery(), resolveDbReadinessTimeoutMs());
        const sharedCheck = check.finally(() => {
            if (inFlightDbReadinessCheck === sharedCheck) {
                inFlightDbReadinessCheck = null;
            }
        });
        inFlightDbReadinessCheck = sharedCheck;
    }
    await inFlightDbReadinessCheck;
}

function isPrismaPoolTimeout(error: unknown): boolean {
    if (!(error instanceof Error)) {
        return false;
    }

    const maybeCode = (error as { code?: unknown }).code;
    return maybeCode === 'P2024' || error.message.toLowerCase().includes('connection pool');
}

function isPrismaOperationTimeout(error: unknown): boolean {
    if (!(error instanceof Error)) {
        return false;
    }

    const maybeCode = (error as { code?: unknown }).code;
    return maybeCode === 'P1008' || maybeCode === 'P2028';
}

function classifyDbReadinessReason(error: unknown): DbReadinessReason {
    if (error instanceof DbReadinessTimeoutError) {
        return "db_timeout";
    }

    if (isPrismaPoolTimeout(error)) {
        return "backpressure";
    }

    if (isPrismaOperationTimeout(error)) {
        return "db_timeout";
    }

    return error instanceof Error ? "db_error" : "unknown";
}

function recordDbReadinessTelemetry(result: DbReadinessResult, reason: DbReadinessReason, startedAtMs: number): void {
    const elapsedSeconds = Math.max(0, Date.now() - startedAtMs) / 1000;
    dbReadinessChecksCounter.inc({ result, reason });
    dbReadinessDurationHistogram.observe({ result, reason }, elapsedSeconds);
}

function resolveDbReadinessLogContext(error: unknown): Readonly<{ errorName?: string; errorCode?: string }> {
    if (!(error instanceof Error)) return {};
    const maybeCode = (error as { code?: unknown }).code;
    return {
        ...(error.name ? { errorName: error.name } : {}),
        ...(typeof maybeCode === "string" && maybeCode ? { errorCode: maybeCode } : {}),
    };
}

export async function sendDatabaseReadinessResponse(
    reply: FastifyReply,
    { apiStartupInstanceId = null }: DatabaseReadinessResponseOptions = {},
): Promise<void> {
    if (isShutdown()) {
        reply.code(503).send(createShuttingDownMonitoringResponse());
        return;
    }

    const startedAtMs = Date.now();
    try {
        await checkDatabaseReadiness();
        recordDbReadinessTelemetry("ok", "none", startedAtMs);
        reply.send({
            ...createHealthyMonitoringResponse(),
            ...(apiStartupInstanceId ? { apiStartupIdentity: { instanceId: apiStartupInstanceId } } : {}),
        });
    } catch (error) {
        const reason = classifyDbReadinessReason(error);
        recordDbReadinessTelemetry("error", reason, startedAtMs);
        log(
            { module: 'health', level: 'error', reason, ...resolveDbReadinessLogContext(error) },
            'Database readiness check failed',
        );
        reply.code(503).send({
            status: 'error',
            timestamp: new Date().toISOString(),
            service: MONITORING_SERVICE_NAME,
            error: DB_READINESS_ERROR,
            reason,
        });
    }
}
