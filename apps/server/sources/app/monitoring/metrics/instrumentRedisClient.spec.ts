import { beforeEach, describe, expect, it } from "vitest";

import { instrumentRedisClient } from "./instrumentRedisClient";
import { register } from "./registry";

type MetricSample = {
    labels: Record<string, string>;
    value: number;
};

async function readMetricSamples(name: string): Promise<MetricSample[]> {
    const metrics = await register.getMetricsAsJSON();
    const metric = metrics.find((entry) => entry.name === name);
    if (!metric) return [];
    return metric.values.map((value) => ({
        labels: Object.fromEntries(
            Object.entries(value.labels ?? {}).map(([key, labelValue]) => [key, String(labelValue)]),
        ),
        value: Number(value.value),
    }));
}

describe("instrumentRedisClient", () => {
    beforeEach(() => {
        register.resetMetrics();
    });

    it("records successful async Redis commands", async () => {
        const client = instrumentRedisClient({
            ping: async () => "PONG",
        });

        await expect(client.ping()).resolves.toBe("PONG");

        const totals = await readMetricSamples("redis_commands_total");
        expect(totals).toContainEqual({
            labels: { command: "ping", result: "ok" },
            value: 1,
        });
    });

    it("records failed async Redis commands with classified reasons", async () => {
        const client = instrumentRedisClient({
            xreadgroup: async () => {
                throw new Error("Redis connection lost");
            },
        });

        await expect(client.xreadgroup()).rejects.toThrow("Redis connection lost");

        const failures = await readMetricSamples("redis_command_failures_total");
        expect(failures).toContainEqual({
            labels: { command: "xreadgroup", reason: "connection" },
            value: 1,
        });
    });
});
