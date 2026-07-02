import { Counter } from "prom-client";

import { register } from "./registry";

export const usageReportWritesCounter = new Counter({
    name: "usage_report_writes_total",
    help: "Legacy usage report write decisions by report scope and result",
    labelNames: ["scope", "result"] as const,
    registers: [register],
});
