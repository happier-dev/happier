import { parseIntEnv } from "@/config/env";
import type { FastifyReply } from "fastify";

import {
    dbReadinessChecksCounter,
    dbReadinessDurationHistogram,
} from "@/app/monitoring/metrics/index";
import { db } from "@/storage/db";
import { log } from "@/utils/logging/log";

const MONITORING_SERVICE_NAME = 'happier-server';
const DB_READINESS_ERROR = 'Database connectivity failed';
const DB_READINESS_TIMEOUT_MS_ENV = 'HAPPIER_DB_READINESS_TIMEOUT_MS';
const DEFAULT_DB_READINESS_TIMEOUT_MS = 1_000;

export type MonitoringReadinessEnv = Record<string, string | undefined>;
export type DatabaseReadinessProbe = () => Promise<unknown>;

type DbReadinessResult = 'ok' | 'error' | 'timeout';
type DbReadinessReason = 'none' | 'db_error' | 'db_timeout' | 'backpressure' | 'unknown';

class DbReadinessTimeoutError extends Error {
    constructor(timeoutMs: number) {
        super(`Database readiness check timed out after ${timeoutMs}ms`);
        this.name = 'DbReadinessTimeoutError';
    }
}

function resolveDbReadinessTimeoutMs(env: MonitoringReadinessEnv = process.env): number {
    return parseIntEnv(env[DB_READINESS_TIMEOUT_MS_ENV], DEFAULT_DB_READINESS_TIMEOUT_MS, { min: 1 });
}

async function withDbReadinessTimeout<T>(operation: () => Promise<T>, timeoutMs: number): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            Promise.resolve().then(operation),
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

export function createHealthyMonitoringResponse() {
    return {
        status: 'ok',
        timestamp: new Date().toISOString(),
        service: MONITORING_SERVICE_NAME,
    };
}

function createUnhealthyMonitoringResponse() {
    return {
        status: 'error',
        timestamp: new Date().toISOString(),
        service: MONITORING_SERVICE_NAME,
        error: DB_READINESS_ERROR,
    };
}

function createDefaultDatabaseReadinessProbe(): Promise<unknown> {
    return db.$queryRaw`SELECT 1`;
}

function readErrorField(error: unknown, key: 'name' | 'code'): string | null {
    if (!error || typeof error !== 'object') return null;
    const value = (error as Record<string, unknown>)[key];
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function classifyDbReadinessFailure(error: unknown): Readonly<{
    result: DbReadinessResult;
    reason: DbReadinessReason;
    errorName: string | null;
    errorCode: string | null;
}> {
    if (error instanceof DbReadinessTimeoutError) {
        return {
            result: 'timeout',
            reason: 'db_timeout',
            errorName: error.name,
            errorCode: null,
        };
    }
    return {
        result: 'error',
        reason: 'db_error',
        errorName: readErrorField(error, 'name'),
        errorCode: readErrorField(error, 'code'),
    };
}

function recordDbReadinessCheck(result: DbReadinessResult, reason: DbReadinessReason, startedAtMs: number): void {
    const durationSeconds = Math.max(0, Date.now() - startedAtMs) / 1000;
    dbReadinessChecksCounter.inc({ result, reason });
    dbReadinessDurationHistogram.observe({ result, reason }, durationSeconds);
}

export async function sendDatabaseReadinessResponse(
    reply: FastifyReply,
    options: Readonly<{
        env?: MonitoringReadinessEnv;
        databaseReadinessProbe?: DatabaseReadinessProbe;
    }> = {},
): Promise<void> {
    const env = options.env ?? process.env;
    const databaseReadinessProbe = options.databaseReadinessProbe ?? createDefaultDatabaseReadinessProbe;
    const startedAtMs = Date.now();
    try {
        await withDbReadinessTimeout(databaseReadinessProbe, resolveDbReadinessTimeoutMs(env));
        recordDbReadinessCheck('ok', 'none', startedAtMs);
        reply.send(createHealthyMonitoringResponse());
    } catch (error) {
        const failure = classifyDbReadinessFailure(error);
        recordDbReadinessCheck(failure.result, failure.reason, startedAtMs);
        log({
            module: 'health',
            level: 'error',
            reason: failure.reason,
            errorName: failure.errorName,
            errorCode: failure.errorCode,
        }, 'Health check failed');
        reply.code(503).send(createUnhealthyMonitoringResponse());
    }
}
