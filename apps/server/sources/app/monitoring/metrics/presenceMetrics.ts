import { Counter } from "prom-client";

import { getOrCreateMetric, register } from "./registry";

export const sessionAliveEventsCounter = getOrCreateMetric("session_alive_events_total", () => new Counter({
    name: "session_alive_events_total",
    help: "Total number of session-alive events",
    registers: [register],
}));

export const machineAliveEventsCounter = getOrCreateMetric("machine_alive_events_total", () => new Counter({
    name: "machine_alive_events_total",
    help: "Total number of machine-alive events",
    registers: [register],
}));

export const databaseUpdatesSkippedCounter = getOrCreateMetric("database_updates_skipped_total", () => new Counter({
    name: "database_updates_skipped_total",
    help: "Number of database updates skipped due to debouncing",
    labelNames: ["type"] as const,
    registers: [register],
}));
