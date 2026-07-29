import { Counter, Histogram } from "prom-client";

import { getOrCreateMetric, register } from "./registry";

export const eventFanoutEmitsCounter = getOrCreateMetric("event_fanout_emits_total", () => new Counter({
    name: "event_fanout_emits_total",
    help: "Total event fanout dispatches by event, filter, and dispatch mode",
    labelNames: ["event_name", "filter_type", "dispatch_mode"] as const,
    registers: [register],
}));

export const eventFanoutTargetCountHistogram = getOrCreateMetric("event_fanout_target_count", () => new Histogram({
    name: "event_fanout_target_count",
    help: "Observed event fanout target counts by event, filter, dispatch mode, and target kind",
    labelNames: ["event_name", "filter_type", "dispatch_mode", "target_kind"] as const,
    buckets: [0, 1, 2, 5, 10, 25, 50, 100],
    registers: [register],
}));

export const eventFanoutPayloadBytesHistogram = getOrCreateMetric("event_fanout_payload_bytes", () => new Histogram({
    name: "event_fanout_payload_bytes",
    help: "Serialized event fanout payload size in bytes by event, filter, dispatch mode, and payload type",
    labelNames: ["event_name", "filter_type", "dispatch_mode", "payload_type"] as const,
    buckets: [100, 500, 1000, 5000, 10000, 50000, 100000, 500000, 1000000, 5000000],
    registers: [register],
}));

export const eventFanoutDropsCounter = getOrCreateMetric("event_fanout_drops_total", () => new Counter({
    name: "event_fanout_drops_total",
    help: "Total event fanout drops by event and reason",
    labelNames: ["event_name", "reason"] as const,
    registers: [register],
}));

export function recordEventFanoutEmit(params: Readonly<{
    eventName: "update" | "ephemeral";
    filterType: string;
    dispatchMode: "room" | "local";
    targetKind: "room" | "connection";
    targetCount: number;
    payloadType?: string;
    payloadBytes?: number;
}>): void {
    eventFanoutEmitsCounter.inc({
        event_name: params.eventName,
        filter_type: params.filterType,
        dispatch_mode: params.dispatchMode,
    });
    eventFanoutTargetCountHistogram.observe(
        {
            event_name: params.eventName,
            filter_type: params.filterType,
            dispatch_mode: params.dispatchMode,
            target_kind: params.targetKind,
        },
        Math.max(0, params.targetCount),
    );
    if (params.payloadType && typeof params.payloadBytes === "number") {
        eventFanoutPayloadBytesHistogram.observe(
            {
                event_name: params.eventName,
                filter_type: params.filterType,
                dispatch_mode: params.dispatchMode,
                payload_type: params.payloadType,
            },
            Math.max(0, params.payloadBytes),
        );
    }
}

export function recordEventFanoutDrop(params: Readonly<{
    eventName: "update" | "ephemeral";
    reason: "io_unavailable" | "no_connections" | "no_matching_connections";
}>): void {
    eventFanoutDropsCounter.inc({
        event_name: params.eventName,
        reason: params.reason,
    });
}
