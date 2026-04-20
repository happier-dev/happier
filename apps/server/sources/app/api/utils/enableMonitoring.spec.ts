import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { register } from "@/app/monitoring/metrics/registry";
import { enableMonitoring } from "./enableMonitoring";

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

describe("enableMonitoring", () => {
    it("records hot endpoint metrics only for auth and changes route families", async () => {
        register.resetMetrics();
        const app = Fastify({ logger: false });
        enableMonitoring(app as any);
        app.get("/v2/changes", async () => ({ ok: true }));
        app.post("/v1/auth", async () => ({ ok: true }));
        app.get("/v1/other", async () => ({ ok: true }));
        await app.ready();

        try {
            await app.inject({ method: "GET", url: "/v2/changes" });
            await app.inject({ method: "POST", url: "/v1/auth" });
            await app.inject({ method: "GET", url: "/v1/other" });

            const samples = await readMetricSamples("http_hot_endpoint_requests_total");
            expect(samples).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        labels: { family: "changes", route: "/v2/changes", method: "GET", status: "200" },
                        value: 1,
                    }),
                    expect.objectContaining({
                        labels: { family: "auth", route: "/v1/auth", method: "POST", status: "200" },
                        value: 1,
                    }),
                ]),
            );
            expect(
                samples.find((sample) => sample.labels.route === "/v1/other"),
            ).toBeUndefined();
        } finally {
            await app.close();
        }
    });
});
