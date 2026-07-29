import { Counter, Histogram } from "prom-client";

import { getOrCreateMetric, register } from "./registry";

type RpcMethodScope = "user" | "session" | "machine";
type RpcFailureReason =
    | "forbidden"
    | "internal_error"
    | "invalid_method"
    | "method_not_available"
    | "request_error"
    | "self_call";
type RpcLookupResult = "resolved" | "miss";

function classifyRpcMethodScope(method: string): RpcMethodScope {
    if (method.startsWith("sess_")) {
        return "session";
    }
    if (method.includes(":")) {
        return "machine";
    }
    return "user";
}

export const rpcRegistrationsCounter = getOrCreateMetric("rpc_registrations_total", () => new Counter({
    name: "rpc_registrations_total",
    help: "Total RPC method registrations",
    labelNames: ["scope"] as const,
    registers: [register],
}));

export const rpcUnregistrationsCounter = getOrCreateMetric("rpc_unregistrations_total", () => new Counter({
    name: "rpc_unregistrations_total",
    help: "Total RPC method unregistrations",
    labelNames: ["scope"] as const,
    registers: [register],
}));

export const rpcCallsCounter = getOrCreateMetric("rpc_calls_total", () => new Counter({
    name: "rpc_calls_total",
    help: "Total RPC calls by scope",
    labelNames: ["scope"] as const,
    registers: [register],
}));

export const rpcCallDurationHistogram = getOrCreateMetric("rpc_call_duration_seconds", () => new Histogram({
    name: "rpc_call_duration_seconds",
    help: "RPC call duration in seconds",
    labelNames: ["scope", "result"] as const,
    buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10, 30, 60, 120],
    registers: [register],
}));

export const rpcCallFailuresCounter = getOrCreateMetric("rpc_call_failures_total", () => new Counter({
    name: "rpc_call_failures_total",
    help: "Total RPC call failures by scope and reason",
    labelNames: ["scope", "reason"] as const,
    registers: [register],
}));

export const rpcTargetLookupFailuresCounter = getOrCreateMetric("rpc_target_lookup_failures_total", () => new Counter({
    name: "rpc_target_lookup_failures_total",
    help: "Total RPC target lookup failures by scope and result",
    labelNames: ["scope", "result"] as const,
    registers: [register],
}));

export const rpcTargetLookupDurationHistogram = getOrCreateMetric("rpc_target_lookup_duration_seconds", () => new Histogram({
    name: "rpc_target_lookup_duration_seconds",
    help: "RPC target lookup duration in seconds",
    labelNames: ["scope", "result"] as const,
    buckets: [0.0005, 0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1],
    registers: [register],
}));

export const rpcMethodNotAvailableCounter = getOrCreateMetric("rpc_method_not_available_total", () => new Counter({
    name: "rpc_method_not_available_total",
    help: "Total RPC calls rejected because the target method is unavailable",
    labelNames: ["scope"] as const,
    registers: [register],
}));

export const rpcSelfCallRejectionsCounter = getOrCreateMetric("rpc_self_call_rejections_total", () => new Counter({
    name: "rpc_self_call_rejections_total",
    help: "Total RPC calls rejected because the caller targeted itself",
    labelNames: ["scope"] as const,
    registers: [register],
}));

export const socketClusterFetchSocketsCounter = getOrCreateMetric("socket_cluster_fetch_sockets_total", () => new Counter({
    name: "socket_cluster_fetch_sockets_total",
    help: "Total cluster fetchSockets discovery attempts",
    registers: [register],
}));

export const socketClusterFetchSocketsDurationHistogram = getOrCreateMetric("socket_cluster_fetch_sockets_duration_seconds", () => new Histogram({
    name: "socket_cluster_fetch_sockets_duration_seconds",
    help: "Cluster fetchSockets discovery duration in seconds",
    labelNames: ["result"] as const,
    buckets: [0.0005, 0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1],
    registers: [register],
}));

export const socketClusterFetchSocketsFailuresCounter = getOrCreateMetric("socket_cluster_fetch_sockets_failures_total", () => new Counter({
    name: "socket_cluster_fetch_sockets_failures_total",
    help: "Total cluster fetchSockets discovery failures",
    labelNames: ["reason"] as const,
    registers: [register],
}));

export function recordRpcRegistration(method: string): void {
    rpcRegistrationsCounter.inc({ scope: classifyRpcMethodScope(method) });
}

export function recordRpcUnregistration(method: string): void {
    rpcUnregistrationsCounter.inc({ scope: classifyRpcMethodScope(method) });
}

export function observeRpcCall(params: Readonly<{
    method: string;
    durationMs: number;
    result: "ok" | "error";
}>): void {
    const scope = classifyRpcMethodScope(params.method);
    rpcCallsCounter.inc({ scope });
    rpcCallDurationHistogram.observe({ scope, result: params.result }, params.durationMs / 1000);
}

export function recordRpcCallFailure(method: string, reason: RpcFailureReason): void {
    rpcCallFailuresCounter.inc({ scope: classifyRpcMethodScope(method), reason });
}

export function observeRpcTargetLookup(params: Readonly<{
    method: string;
    durationMs: number;
    result: RpcLookupResult;
}>): void {
    const scope = classifyRpcMethodScope(params.method);
    rpcTargetLookupDurationHistogram.observe({ scope, result: params.result }, params.durationMs / 1000);
    if (params.result !== "resolved") {
        rpcTargetLookupFailuresCounter.inc({ scope, result: params.result });
    }
}

export function recordRpcMethodNotAvailable(method: string): void {
    rpcMethodNotAvailableCounter.inc({ scope: classifyRpcMethodScope(method) });
}

export function recordRpcSelfCallRejection(method: string): void {
    rpcSelfCallRejectionsCounter.inc({ scope: classifyRpcMethodScope(method) });
}

export function recordSocketClusterFetchSockets(params: Readonly<{
    durationMs: number;
    result: "ok" | "error";
    reason?: "timeout" | "transport" | "unknown";
}>): void {
    socketClusterFetchSocketsCounter.inc();
    socketClusterFetchSocketsDurationHistogram.observe({ result: params.result }, params.durationMs / 1000);
    if (params.result === "error") {
        socketClusterFetchSocketsFailuresCounter.inc({ reason: params.reason ?? "unknown" });
    }
}
