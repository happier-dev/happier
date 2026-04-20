import { beforeEach, describe, expect, it } from "vitest";

import { register } from "./registry";
import {
    recordSocketConnectConvergenceDuration,
    recordSocketConnectConvergencePhase,
    recordSocketAuthHandshake,
    recordSocketAuthHandshakeStageDuration,
    recordSocketAuthHandshakeException,
    recordSocketDisconnect,
    recordSocketTransportUpgradeOutcome,
    trackWebSocketConnection,
    untrackWebSocketConnection,
} from "./socketMetrics";

type MetricSample = {
    metricName?: string;
    labels: Record<string, string>;
    value: number;
};

async function readMetricSamples(name: string): Promise<MetricSample[]> {
    const metrics = await register.getMetricsAsJSON();
    const metric = metrics.find((entry) => entry.name === name);
    if (!metric) return [];
    return metric.values.map((value) => ({
        metricName:
            "metricName" in value && typeof value.metricName === "string"
                ? value.metricName
                : undefined,
        labels: Object.fromEntries(
            Object.entries(value.labels ?? {}).map(([key, labelValue]) => [key, String(labelValue)]),
        ),
        value: Number(value.value),
    }));
}

async function expectSampleValue(
    metricName: string,
    expectedLabels: Record<string, string>,
    expectedSampleMetricName?: string,
): Promise<number | null> {
    const samples = await readMetricSamples(metricName);
    const sample = samples.find((entry) =>
        (expectedSampleMetricName ? entry.metricName === expectedSampleMetricName : true)
        && entry.metricName !== `${metricName}_bucket`
        && entry.metricName !== `${metricName}_count`
        && Object.entries(expectedLabels).every(([key, value]) => entry.labels[key] === value),
    );
    return sample ? sample.value : null;
}

describe("socketMetrics", () => {
    beforeEach(() => {
        register.resetMetrics();
    });

    it("tracks legacy and new active connection gauges plus unique active entities", async () => {
        trackWebSocketConnection({
            socketId: "socket-user",
            userId: "user-1",
            clientType: "user-scoped",
            transport: "websocket",
        });
        trackWebSocketConnection({
            socketId: "socket-session",
            userId: "user-1",
            clientType: "session-scoped",
            sessionId: "session-1",
            transport: "polling",
        });
        trackWebSocketConnection({
            socketId: "socket-machine",
            userId: "user-1",
            clientType: "machine-scoped",
            machineId: "machine-1",
            transport: "websocket",
        });

        expect(await expectSampleValue("websocket_connections_total", { type: "user-scoped" })).toBe(1);
        expect(await expectSampleValue("websocket_connections_total", { type: "session-scoped" })).toBe(1);
        expect(await expectSampleValue("websocket_connections_total", { type: "machine-scoped" })).toBe(1);
        expect(
            await expectSampleValue("websocket_connections_active", { role: "all", type: "user-scoped" }),
        ).toBe(1);
        expect(
            await expectSampleValue("websocket_connections_active", { role: "all", type: "session-scoped" }),
        ).toBe(1);
        expect(
            await expectSampleValue("websocket_connections_active", { role: "all", type: "machine-scoped" }),
        ).toBe(1);
        expect(
            await expectSampleValue("websocket_active_entities", { role: "all", entity_type: "user" }),
        ).toBe(1);
        expect(
            await expectSampleValue("websocket_active_entities", { role: "all", entity_type: "session" }),
        ).toBe(1);
        expect(
            await expectSampleValue("websocket_active_entities", { role: "all", entity_type: "machine" }),
        ).toBe(1);
        expect(
            await expectSampleValue("websocket_transport_connections_active", {
                role: "all",
                transport: "websocket",
            }),
        ).toBe(2);
        expect(
            await expectSampleValue("websocket_transport_connections_active", {
                role: "all",
                transport: "polling",
            }),
        ).toBe(1);

        untrackWebSocketConnection({ socketId: "socket-session", reason: "transport close" });

        expect(
            await expectSampleValue("websocket_connections_active", { role: "all", type: "session-scoped" }),
        ).toBe(0);
        expect(
            await expectSampleValue("websocket_active_entities", { role: "all", entity_type: "session" }),
        ).toBe(0);

        untrackWebSocketConnection({ socketId: "socket-user", reason: "transport close" });
        untrackWebSocketConnection({ socketId: "socket-machine", reason: "transport close" });
    });

    it("records auth handshakes, reconnects, disconnects, and transport upgrades", async () => {
        recordSocketAuthHandshake({
            clientType: "user-scoped",
            transport: "polling",
            durationMs: 12,
            result: "ok",
        });
        recordSocketAuthHandshake({
            clientType: "machine-scoped",
            transport: "websocket",
            durationMs: 8,
            result: "error",
            failure: "invalid-machine",
        });
        recordSocketAuthHandshakeException({
            clientType: "session-scoped",
            transport: "websocket",
            stage: "session-binding",
            classification: "prisma-p2037",
        });
        recordSocketAuthHandshakeStageDuration({
            clientType: "session-scoped",
            transport: "websocket",
            stage: "session-binding",
            durationMs: 42,
            result: "ok",
        });

        trackWebSocketConnection({
            socketId: "socket-1",
            userId: "user-2",
            clientType: "user-scoped",
            transport: "polling",
            nowMs: 10,
        });
        recordSocketTransportUpgradeOutcome({
            socketId: "socket-1",
            fromTransport: "polling",
            toTransport: "websocket",
            result: "success",
        });
        untrackWebSocketConnection({ socketId: "socket-1", reason: "transport close", nowMs: 20 });

        trackWebSocketConnection({
            socketId: "socket-2",
            userId: "user-2",
            clientType: "user-scoped",
            transport: "websocket",
            reconnectWindowMs: 60_000,
            nowMs: 1_000,
        });
        recordSocketDisconnect({
            clientType: "user-scoped",
            transport: "websocket",
            reason: "ping timeout",
        });

        expect(
            await expectSampleValue("websocket_auth_handshakes_total", {
                role: "all",
                client_type: "user-scoped",
                transport: "polling",
                result: "ok",
                failure: "none",
            }),
        ).toBe(1);
        expect(
            await expectSampleValue("websocket_auth_handshakes_total", {
                role: "all",
                client_type: "machine-scoped",
                transport: "websocket",
                result: "error",
                failure: "invalid-machine",
            }),
        ).toBe(1);
        expect(
            await expectSampleValue("websocket_auth_handshake_exceptions_total", {
                role: "all",
                client_type: "session-scoped",
                transport: "websocket",
                stage: "session-binding",
                classification: "prisma-p2037",
            }),
        ).toBe(1);
        expect(
            await expectSampleValue("websocket_auth_handshake_stage_duration_seconds", {
                role: "all",
                client_type: "session-scoped",
                transport: "websocket",
                stage: "session-binding",
                result: "ok",
            }, "websocket_auth_handshake_stage_duration_seconds_sum"),
        ).toBeCloseTo(0.042);
        expect(
            await expectSampleValue("websocket_transport_upgrade_outcomes_total", {
                role: "all",
                from_transport: "polling",
                to_transport: "websocket",
                result: "success",
            }),
        ).toBe(1);
        expect(
            await expectSampleValue("websocket_disconnects_total", {
                role: "all",
                client_type: "user-scoped",
                transport: "websocket",
                reason: "ping timeout",
            }),
        ).toBe(1);
        expect(
            await expectSampleValue("websocket_reconnections_total", {
                role: "all",
                client_type: "user-scoped",
            }),
        ).toBe(1);

        untrackWebSocketConnection({ socketId: "socket-2", reason: "server namespace disconnect", nowMs: 1_100 });
    });

    it("records websocket connect convergence phases and durations", async () => {
        recordSocketConnectConvergencePhase({
            clientType: "user-scoped",
            transport: "websocket",
            phase: "start",
        });
        recordSocketConnectConvergencePhase({
            clientType: "user-scoped",
            transport: "websocket",
            phase: "complete",
        });
        recordSocketConnectConvergenceDuration({
            clientType: "user-scoped",
            transport: "websocket",
            result: "ready",
            durationMs: 125,
        });
        recordSocketConnectConvergencePhase({
            clientType: "machine-scoped",
            transport: "polling",
            phase: "disconnect_before_ready",
        });
        recordSocketConnectConvergenceDuration({
            clientType: "machine-scoped",
            transport: "polling",
            result: "disconnect_before_ready",
            durationMs: 250,
        });

        expect(
            await expectSampleValue("websocket_connect_convergence_total", {
                role: "all",
                client_type: "user-scoped",
                transport: "websocket",
                phase: "start",
            }),
        ).toBe(1);
        expect(
            await expectSampleValue("websocket_connect_convergence_total", {
                role: "all",
                client_type: "user-scoped",
                transport: "websocket",
                phase: "complete",
            }),
        ).toBe(1);
        expect(
            await expectSampleValue("websocket_connect_convergence_total", {
                role: "all",
                client_type: "machine-scoped",
                transport: "polling",
                phase: "disconnect_before_ready",
            }),
        ).toBe(1);
        expect(
            await expectSampleValue(
                "websocket_connect_convergence_duration_seconds",
                {
                    role: "all",
                    client_type: "user-scoped",
                    transport: "websocket",
                    result: "ready",
                },
                "websocket_connect_convergence_duration_seconds_sum",
            ),
        ).toBeCloseTo(0.125);
        expect(
            await expectSampleValue(
                "websocket_connect_convergence_duration_seconds",
                {
                    role: "all",
                    client_type: "machine-scoped",
                    transport: "polling",
                    result: "disconnect_before_ready",
                },
                "websocket_connect_convergence_duration_seconds_sum",
            ),
        ).toBeCloseTo(0.25);
    });
});
