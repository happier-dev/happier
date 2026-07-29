import { Counter, Histogram } from "prom-client";

import { getOrCreateMetric, register } from "./registry";

export const httpRequestsCounter = getOrCreateMetric("http_requests_total", () => new Counter({
    name: "http_requests_total",
    help: "Total number of HTTP requests",
    labelNames: ["method", "route", "status"] as const,
    registers: [register],
}));

export const httpRequestDurationHistogram = getOrCreateMetric("http_request_duration_seconds", () => new Histogram({
    name: "http_request_duration_seconds",
    help: "HTTP request duration in seconds",
    labelNames: ["method", "route", "status"] as const,
    buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10],
    registers: [register],
}));

export const httpHotEndpointRequestsCounter = getOrCreateMetric("http_hot_endpoint_requests_total", () => new Counter({
    name: "http_hot_endpoint_requests_total",
    help: "Total number of requests for hot route families",
    labelNames: ["family", "method", "route", "status"] as const,
    registers: [register],
}));

export const httpHotEndpointRequestDurationHistogram = getOrCreateMetric("http_hot_endpoint_request_duration_seconds", () => new Histogram({
    name: "http_hot_endpoint_request_duration_seconds",
    help: "HTTP request duration in seconds for hot route families",
    labelNames: ["family", "method", "route", "status"] as const,
    buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10],
    registers: [register],
}));

export const changesRequestsCounter = getOrCreateMetric("changes_requests_total", () => new Counter({
    name: "changes_requests_total",
    help: "Total /v2/changes requests by result",
    labelNames: ["result"] as const,
    registers: [register],
}));

export const changesReturnedChangesCounter = getOrCreateMetric("changes_returned_changes_total", () => new Counter({
    name: "changes_returned_changes_total",
    help: "Total number of changes entries returned by /v2/changes",
    registers: [register],
}));

export const catchupFollowupFetchesCounter = getOrCreateMetric("catchup_followup_fetches_total", () => new Counter({
    name: "catchup_followup_fetches_total",
    help: "Total catch-up follow-up fetches by type",
    labelNames: ["type"] as const,
    registers: [register],
}));

export const catchupFollowupReturnedCounter = getOrCreateMetric("catchup_followup_returned_total", () => new Counter({
    name: "catchup_followup_returned_total",
    help: "Total number of entities returned by catch-up follow-up fetches by type",
    labelNames: ["type"] as const,
    registers: [register],
}));

export function classifyHotEndpointFamily(route: string): "auth" | "changes" | null {
    if (route === "/v2/changes" || route === "/v2/cursor") {
        return "changes";
    }
    if (route === "/v1/auth" || route.startsWith("/v1/auth/")) {
        return "auth";
    }
    return null;
}
