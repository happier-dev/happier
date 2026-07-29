import { describe, expect, it } from "vitest";

import { register } from "./index";

function importDuplicateMetricModule(path: string): Promise<unknown> {
    return import(/* @vite-ignore */ path);
}

describe("monitoring/metrics/index", () => {
    it("registers the modular Lane B metrics", () => {
        expect(register.getSingleMetric("http_requests_total")).toBeTruthy();
        expect(register.getSingleMetric("websocket_connections_total")).toBeTruthy();
        expect(register.getSingleMetric("websocket_connections_active")).toBeTruthy();
        expect(register.getSingleMetric("websocket_active_entities")).toBeTruthy();
        expect(register.getSingleMetric("websocket_transport_connections_active")).toBeTruthy();
        expect(register.getSingleMetric("websocket_auth_handshakes_total")).toBeTruthy();
        expect(register.getSingleMetric("websocket_auth_handshake_exceptions_total")).toBeTruthy();
        expect(register.getSingleMetric("websocket_auth_handshake_duration_seconds")).toBeTruthy();
        expect(register.getSingleMetric("websocket_auth_handshake_stage_duration_seconds")).toBeTruthy();
        expect(register.getSingleMetric("websocket_connect_convergence_total")).toBeTruthy();
        expect(register.getSingleMetric("websocket_connect_convergence_duration_seconds")).toBeTruthy();
        expect(register.getSingleMetric("websocket_disconnects_total")).toBeTruthy();
        expect(register.getSingleMetric("websocket_transport_upgrade_outcomes_total")).toBeTruthy();
        expect(register.getSingleMetric("websocket_reconnections_total")).toBeTruthy();
        expect(register.getSingleMetric("auth_login_eligibility_cache_total")).toBeTruthy();
        expect(register.getSingleMetric("auth_login_eligibility_stage_duration_seconds")).toBeTruthy();
        expect(register.getSingleMetric("redis_commands_total")).toBeTruthy();
        expect(register.getSingleMetric("redis_command_duration_seconds")).toBeTruthy();
        expect(register.getSingleMetric("redis_command_failures_total")).toBeTruthy();
        expect(register.getSingleMetric("event_fanout_emits_total")).toBeTruthy();
        expect(register.getSingleMetric("event_fanout_target_count")).toBeTruthy();
        expect(register.getSingleMetric("event_fanout_payload_bytes")).toBeTruthy();
        expect(register.getSingleMetric("event_fanout_drops_total")).toBeTruthy();
        expect(register.getSingleMetric("http_hot_endpoint_requests_total")).toBeTruthy();
        expect(register.getSingleMetric("rpc_calls_total")).toBeTruthy();
        expect(register.getSingleMetric("rpc_target_lookup_duration_seconds")).toBeTruthy();
        expect(register.getSingleMetric("socket_cluster_fetch_sockets_total")).toBeTruthy();
        expect(register.getSingleMetric("presence_stream_reads_total")).toBeTruthy();
        expect(register.getSingleMetric("presence_stream_pending_entries")).toBeTruthy();
        expect(register.getSingleMetric("presence_stream_redis_pending_entries")).toBeTruthy();
        expect(register.getSingleMetric("presence_stream_redis_pending_refresh_failures_total")).toBeTruthy();
        expect(register.getSingleMetric("presence_flush_retries_total")).toBeTruthy();
        expect(register.getSingleMetric("session_write_create_message_duration_seconds")).toBeTruthy();
        expect(register.getSingleMetric("session_message_role_mismatch_total")).toBeTruthy();
        expect(register.getSingleMetric("database_transaction_retries_total")).toBeTruthy();
        expect(register.getSingleMetric("usage_report_writes_total")).toBeTruthy();
        expect(register.getSingleMetric("session_scoped_binding_duration_seconds")).toBeTruthy();
        expect(register.getSingleMetric("runtime_event_loop_lag_seconds")).toBeTruthy();
        expect(register.getSingleMetric("runtime_heap_used_bytes")).toBeTruthy();
        expect(register.getSingleMetric("database_records_total")).toBeTruthy();
        expect(register.getSingleMetric("voice_provider_identity_backfill_remaining")).toBeTruthy();
        expect(register.getSingleMetric("voice_provider_identity_backfill_processed_total")).toBeTruthy();
        expect(register.getSingleMetric("voice_provider_identity_backfill_collisions_total")).toBeTruthy();
        expect(register.getSingleMetric("voice_provider_identity_backfill_failures_total")).toBeTruthy();
        expect(register.getSingleMetric("voice_provider_identity_backfill_last_success_unixtime_seconds")).toBeTruthy();
    });

    it("reuses already registered metrics when metric modules are evaluated again", async () => {
        await expect(importDuplicateMetricModule("./authMetrics?duplicate-registration")).resolves.toBeTruthy();
        await expect(importDuplicateMetricModule("./httpMetrics?duplicate-registration")).resolves.toBeTruthy();
        await expect(importDuplicateMetricModule("./socketMetrics?duplicate-registration")).resolves.toBeTruthy();
        await expect(importDuplicateMetricModule("./redisMetrics?duplicate-registration")).resolves.toBeTruthy();
        await expect(importDuplicateMetricModule("./fanoutMetrics?duplicate-registration")).resolves.toBeTruthy();
        await expect(importDuplicateMetricModule("./rpcMetrics?duplicate-registration")).resolves.toBeTruthy();
        await expect(importDuplicateMetricModule("./presenceMetrics?duplicate-registration")).resolves.toBeTruthy();
        await expect(importDuplicateMetricModule("./runtimeMetrics?duplicate-registration")).resolves.toBeTruthy();
        await expect(importDuplicateMetricModule("./databaseMetrics?duplicate-registration")).resolves.toBeTruthy();
        await expect(importDuplicateMetricModule("./sessionWriteMetrics?duplicate-registration")).resolves.toBeTruthy();
        await expect(importDuplicateMetricModule("./sessionBindingMetrics?duplicate-registration")).resolves.toBeTruthy();
        await expect(importDuplicateMetricModule("./usageMetrics?duplicate-registration")).resolves.toBeTruthy();
        await expect(importDuplicateMetricModule("./voiceProviderIdentityBackfillMetrics?duplicate-registration")).resolves.toBeTruthy();

        expect(register.getSingleMetric("websocket_connections_total")).toBeTruthy();
        expect(register.getSingleMetric("runtime_gc_events_total")).toBeTruthy();
    });
});
