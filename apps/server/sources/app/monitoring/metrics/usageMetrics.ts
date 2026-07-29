import { Counter } from "prom-client";

import { getOrCreateMetric, register } from "./registry";

export const usageReportWritesCounter = getOrCreateMetric("usage_report_writes_total", () => new Counter({
    name: "usage_report_writes_total",
    help: "Legacy usage report write decisions by report scope and result",
    labelNames: ["scope", "result"] as const,
    registers: [register],
}));
