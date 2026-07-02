import { Counter } from "prom-client";

import { register } from "./registry";

export const quotaSnapshotStaleWriteRejectedCounter = new Counter({
    name: "quota_snapshot_stale_write_rejected_total",
    help: "Total connected-service quota snapshot writes rejected because stored freshness was newer",
    labelNames: ["route"] as const,
    registers: [register],
});
