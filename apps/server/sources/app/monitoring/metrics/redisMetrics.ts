import { Counter, Histogram } from "prom-client";

import { getOrCreateMetric, register } from "./registry";

type RedisFailureReason = "connection" | "timeout" | "unknown";

export const redisCommandsCounter = getOrCreateMetric("redis_commands_total", () => new Counter({
    name: "redis_commands_total",
    help: "Total app-owned Redis command executions by command and result",
    labelNames: ["command", "result"] as const,
    registers: [register],
}));

export const redisCommandDurationHistogram = getOrCreateMetric("redis_command_duration_seconds", () => new Histogram({
    name: "redis_command_duration_seconds",
    help: "Duration of app-owned Redis command executions in seconds",
    labelNames: ["command", "result"] as const,
    buckets: [0.0005, 0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
    registers: [register],
}));

export const redisCommandFailuresCounter = getOrCreateMetric("redis_command_failures_total", () => new Counter({
    name: "redis_command_failures_total",
    help: "Total app-owned Redis command failures by classified reason",
    labelNames: ["command", "reason"] as const,
    registers: [register],
}));

function classifyRedisFailureReason(error: unknown): RedisFailureReason {
    if (!(error instanceof Error)) {
        return "unknown";
    }
    const message = error.message.toLowerCase();
    if (message.includes("connect") || message.includes("connection") || message.includes("closed")) {
        return "connection";
    }
    if (message.includes("timeout")) {
        return "timeout";
    }
    return "unknown";
}

export function observeRedisCommand(params: Readonly<{
    command: string;
    durationMs: number;
    result: "ok" | "error";
    error?: unknown;
}>): void {
    redisCommandsCounter.inc({
        command: params.command,
        result: params.result,
    });
    redisCommandDurationHistogram.observe(
        {
            command: params.command,
            result: params.result,
        },
        Math.max(0, params.durationMs) / 1000,
    );
    if (params.result === "error") {
        redisCommandFailuresCounter.inc({
            command: params.command,
            reason: classifyRedisFailureReason(params.error),
        });
    }
}
