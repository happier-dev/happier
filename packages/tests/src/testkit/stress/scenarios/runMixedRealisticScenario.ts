import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { MessageAckResponseSchema } from '@happier-dev/protocol/updates';

import { FailureArtifacts } from '../../failureArtifacts';
import type { RunDirs } from '../../runDir';
import { createMachineBoundSessionScopedSocketCollector } from '../../sessionSocketBinding';
import { createSession, countDuplicateLocalIds, fetchAllMessages } from '../../sessions';
import { createUserScopedSocketCollector, type CapturedEvent } from '../../socketClient';
import { sleep, waitFor } from '../../timing';
import type { StressConfig } from '../config/stressScenarioSchema';
import { finalizeStressScenario } from '../reporting/finalizeStressScenario';
import type { StartedStressTarget } from '../targets/stressTargetTypes';
import {
  type ClusterServiceMetricThresholdSignalEvent,
  fetchGatewayStubStatus,
  scrapeClusterServiceMetricCounters,
  scrapeClusterServiceMetricSelectors,
  scrapeServiceMetricCounters,
  summarizeGatewayLogs,
  summarizeGatewayLogsFromComposeLogs,
} from './fullComposeScenarioSupport';
import { buildMixedRealisticWorkload } from './mixedRealisticWorkload';
import { runStressTasksWithConcurrencyLimit } from './runStressTasksWithConcurrencyLimit';
import { summarizeLatencySamples, resolveRpcCallCount, resolveStressSocketTransports } from './stressScenarioRuntime';
import { waitForRegisteredRpcMethod } from './waitForRegisteredRpcMethod';

export type MixedScenarioAuth = Readonly<{
  token: string;
  publicKeyBase64?: string;
}>;

type MixedListener = Readonly<{
  method: string;
  machineId: string;
  authIndex: number;
  socket: Awaited<ReturnType<typeof createMachineBoundSessionScopedSocketCollector>>['socket'];
}>;

export type MixedCollector = Readonly<{
  sessionId: string;
  machineId: string;
  authIndex: number;
  socket: Awaited<ReturnType<typeof createMachineBoundSessionScopedSocketCollector>>['socket'];
}>;

export type MixedUserScopedDevice = ReturnType<typeof createUserScopedSocketCollector>;

export type MixedUserDevices = Readonly<{
  authIndex: number;
  token: string;
  devices: ReadonlyArray<MixedUserScopedDevice>;
}>;

export type MixedSessionTarget = Readonly<{
  sessionId: string;
  authIndex: number;
}>;

type MixedRpcPlan = Readonly<{
  listenerIndex: number;
  triggerMessageIndex: number;
}>;

type MixedRpcReadinessLedgerEntry = Readonly<{
  method: string;
  machineId: string;
  authIndex: number;
  status: 'ok' | 'error';
  durationMs: number;
  error?: string;
}>;

type MixedFailedRpcContext = Readonly<{
  method: string;
  machineId: string;
  authIndex: number;
  rpcCallsCompleted: number;
  messagesSentBeforeFailure: number;
  errorCode?: string;
  error?: string;
}>;

export type MixedConnectivitySnapshot = Readonly<{
  userDevices: {
    total: number;
    connected: number;
    disconnectedAuthIndexes: number[];
    disconnectedSample: Array<{
      authIndex: number;
      disconnectedDeviceCount: number;
      devices: Array<{
        deviceIndex: number;
        lastConnectError?: {
          at: number;
          message: string;
        };
        lastDisconnect?: {
          at: number;
          reason?: string;
        };
      }>;
    }>;
  };
  machineCollectors: {
    total: number;
    connected: number;
    disconnectedCount: number;
    disconnectedSample: Array<{
      sessionId: string;
      machineId: string;
      authIndex: number;
      lastConnectError?: {
        at: number;
        message: string;
      };
      lastDisconnect?: {
        at: number;
        reason?: string;
      };
    }>;
  };
}>;

function truncateConnectivityEventString(value: string | undefined, maxLength = 200): string | undefined {
  if (typeof value !== 'string') {
    return value;
  }
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function summarizeSocketConnectivityFailure(events: readonly CapturedEvent[]): {
  lastConnectError?: {
    at: number;
    message: string;
  };
  lastDisconnect?: {
    at: number;
    reason?: string;
  };
} {
  let lastConnectError: { at: number; message: string } | undefined;
  let lastDisconnect: { at: number; reason?: string } | undefined;

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event) {
      continue;
    }
    if (!lastConnectError && event.kind === 'connect_error') {
      lastConnectError = {
        at: event.at,
        message: truncateConnectivityEventString(event.message) ?? 'unknown',
      };
      continue;
    }
    if (!lastDisconnect && event.kind === 'disconnect') {
      lastDisconnect = {
        at: event.at,
        reason: truncateConnectivityEventString(event.reason),
      };
    }
    if (lastConnectError && lastDisconnect) {
      break;
    }
  }

  return {
    ...(lastConnectError ? { lastConnectError } : {}),
    ...(lastDisconnect ? { lastDisconnect } : {}),
  };
}

function summarizeStageMetric(params: { sumSeconds: number; count: number }): {
  count: number;
  totalMs: number;
  avgMs: number;
} {
  const count = Math.max(0, params.count);
  const totalMs = Math.max(0, params.sumSeconds) * 1000;
  return {
    count,
    totalMs,
    avgMs: count > 0 ? totalMs / count : 0,
  };
}

function parseGatewayStubStatus(statusText: string): {
  active: number;
  accepts: number;
  handled: number;
  requests: number;
  reading: number;
  writing: number;
  waiting: number;
} | undefined {
  const activeMatch = statusText.match(/^Active connections:\s+(\d+)$/mu);
  const totalsMatch = statusText.match(/^\s*(\d+)\s+(\d+)\s+(\d+)$/mu);
  const rwMatch = statusText.match(/^Reading:\s+(\d+)\s+Writing:\s+(\d+)\s+Waiting:\s+(\d+)$/mu);
  if (!activeMatch || !totalsMatch || !rwMatch) {
    return undefined;
  }

  return {
    active: Number.parseInt(activeMatch[1] ?? '0', 10),
    accepts: Number.parseInt(totalsMatch[1] ?? '0', 10),
    handled: Number.parseInt(totalsMatch[2] ?? '0', 10),
    requests: Number.parseInt(totalsMatch[3] ?? '0', 10),
    reading: Number.parseInt(rwMatch[1] ?? '0', 10),
    writing: Number.parseInt(rwMatch[2] ?? '0', 10),
    waiting: Number.parseInt(rwMatch[3] ?? '0', 10),
  };
}

export const MIXED_REALISTIC_API_PEAK_METRIC_NAMES = [
  'runtime_rss_bytes',
  'runtime_heap_used_bytes',
  'runtime_total_physical_size_bytes',
  'runtime_global_handles_size_bytes',
  'websocket_connections_active',
  'auth_token_cache_entries',
  'engineio_connections_active',
] as const;

export const MIXED_REALISTIC_API_PROVISIONING_HTTP_SELECTORS = [
  { alias: 'provision_auth_create_requests_total', metricName: 'http_server_requests_total', labels: { route: '/v1/auth', method: 'POST' } },
  { alias: 'provision_auth_create_inflight', metricName: 'http_server_requests_inflight', labels: { route: '/v1/auth', method: 'POST' } },
] as const;

export const MIXED_REALISTIC_API_CACHE_ENTRY_SELECTORS = [
  { alias: 'auth_token_cache_entries_positive', metricName: 'auth_token_cache_entries', labels: { bucket: 'positive_result' } },
  { alias: 'auth_token_cache_entries_account_snapshot', metricName: 'auth_token_cache_entries', labels: { bucket: 'account_snapshot' } },
  { alias: 'auth_token_cache_entries_inflight', metricName: 'auth_token_cache_entries', labels: { bucket: 'inflight' } },
] as const;

export const MIXED_REALISTIC_API_HEAP_SPACE_PEAK_SELECTORS = [
  { alias: 'runtime_heap_space_used_old_space_bytes', metricName: 'runtime_heap_space_used_size_bytes', labels: { space: 'old_space' } },
  { alias: 'runtime_heap_space_size_old_space_bytes', metricName: 'runtime_heap_space_size_bytes', labels: { space: 'old_space' } },
  { alias: 'runtime_heap_space_available_old_space_bytes', metricName: 'runtime_heap_space_available_size_bytes', labels: { space: 'old_space' } },
  { alias: 'runtime_heap_space_size_new_space_bytes', metricName: 'runtime_heap_space_size_bytes', labels: { space: 'new_space' } },
  { alias: 'runtime_heap_space_available_new_space_bytes', metricName: 'runtime_heap_space_available_size_bytes', labels: { space: 'new_space' } },
  { alias: 'runtime_heap_space_size_large_object_space_bytes', metricName: 'runtime_heap_space_size_bytes', labels: { space: 'large_object_space' } },
  { alias: 'runtime_heap_space_available_large_object_space_bytes', metricName: 'runtime_heap_space_available_size_bytes', labels: { space: 'large_object_space' } },
] as const;

export type MixedRealisticApiDiagnosticSignalSummary = Readonly<{
  triggered: readonly ClusterServiceMetricThresholdSignalEvent[];
  errors?: readonly string[];
}>;

export function resolveMixedRealisticApiThresholdSignals(
  config: Pick<StressConfig, 'compose'>,
): ReadonlyArray<{
  valueKey: string;
  threshold: number;
  signal: NodeJS.Signals;
}> {
  const signal = config.compose.apiHeapDiagnosticSignal;
  const threshold = config.compose.apiHeapDiagnosticOldSpaceThresholdBytes;
  if (!signal || typeof threshold !== 'number' || threshold <= 0) {
    return [];
  }

  return [{
    valueKey: 'runtime_heap_space_used_old_space_bytes',
    threshold,
    signal,
  }];
}

export async function scrapeMixedRealisticFullComposeMetrics(params: {
  target: StartedStressTarget;
  apiReplicaPeakMetrics?: readonly unknown[];
  apiReplicaPeakMetricsError?: string;
  apiReplicaDiagnosticSignals?: MixedRealisticApiDiagnosticSignalSummary;
  containerMemoryPeakMetrics?: readonly unknown[];
  containerMemoryPeakMetricsError?: string;
}): Promise<Record<string, unknown>> {
    const [apiCountersResult, workerCountersResult, apiStageMetricsResult, gatewayStatusResult, gatewayLogSummaryResult] = await Promise.allSettled([
    scrapeClusterServiceMetricCounters({
      target: params.target,
      service: 'api',
      metricNames: [
        'rpc_calls_total',
        'socket_cluster_fetch_sockets_total',
        'socket_cluster_fetch_sockets_failures_total',
        'websocket_auth_handshake_exceptions_total',
        'websocket_connections_active',
        'websocket_disconnects_total',
        'websocket_reconnections_total',
        'rpc_registrations_total',
        'rpc_unregistrations_total',
        'rpc_method_not_available_total',
        'rpc_target_lookup_failures_total',
        'runtime_rss_bytes',
        'runtime_heap_used_bytes',
      ],
    }),
    scrapeServiceMetricCounters({
      target: params.target,
      service: 'worker',
      metricNames: ['session_alive_events_total', 'machine_alive_events_total', 'presence_stream_pending_entries'],
    }),
    scrapeClusterServiceMetricSelectors({
      target: params.target,
      service: 'api',
      selectors: [
        { alias: 'verify_token_sum', metricName: 'websocket_auth_handshake_stage_duration_seconds_sum', labels: { stage: 'verify-token', result: 'ok' } },
        { alias: 'verify_token_count', metricName: 'websocket_auth_handshake_stage_duration_seconds_count', labels: { stage: 'verify-token', result: 'ok' } },
        { alias: 'login_eligibility_sum', metricName: 'websocket_auth_handshake_stage_duration_seconds_sum', labels: { stage: 'login-eligibility', result: 'ok' } },
        { alias: 'login_eligibility_count', metricName: 'websocket_auth_handshake_stage_duration_seconds_count', labels: { stage: 'login-eligibility', result: 'ok' } },
        { alias: 'session_binding_sum', metricName: 'websocket_auth_handshake_stage_duration_seconds_sum', labels: { stage: 'session-binding', result: 'ok' } },
        { alias: 'session_binding_count', metricName: 'websocket_auth_handshake_stage_duration_seconds_count', labels: { stage: 'session-binding', result: 'ok' } },
        { alias: 'connect_start_total', metricName: 'websocket_connect_convergence_total', labels: { phase: 'start' } },
        { alias: 'connect_complete_total', metricName: 'websocket_connect_convergence_total', labels: { phase: 'complete' } },
        { alias: 'connect_disconnect_before_ready_total', metricName: 'websocket_connect_convergence_total', labels: { phase: 'disconnect_before_ready' } },
        { alias: 'connect_ready_sum', metricName: 'websocket_connect_convergence_duration_seconds_sum', labels: { result: 'ready' } },
        { alias: 'connect_ready_count', metricName: 'websocket_connect_convergence_duration_seconds_count', labels: { result: 'ready' } },
        { alias: 'connect_disconnect_before_ready_sum', metricName: 'websocket_connect_convergence_duration_seconds_sum', labels: { result: 'disconnect_before_ready' } },
        { alias: 'connect_disconnect_before_ready_count', metricName: 'websocket_connect_convergence_duration_seconds_count', labels: { result: 'disconnect_before_ready' } },
        { alias: 'binding_owner_session_lookup_sum', metricName: 'session_scoped_binding_duration_seconds_sum', labels: { stage: 'owner_session_lookup', result: 'ok' } },
        { alias: 'binding_owner_session_lookup_count', metricName: 'session_scoped_binding_duration_seconds_count', labels: { stage: 'owner_session_lookup', result: 'ok' } },
        { alias: 'binding_machine_access_key_lookup_sum', metricName: 'session_scoped_binding_duration_seconds_sum', labels: { stage: 'machine_access_key_lookup', result: 'ok' } },
        { alias: 'binding_machine_access_key_lookup_count', metricName: 'session_scoped_binding_duration_seconds_count', labels: { stage: 'machine_access_key_lookup', result: 'ok' } },
        { alias: 'eligibility_total_sum', metricName: 'auth_login_eligibility_stage_duration_seconds_sum', labels: { stage: 'total', result: 'ok' } },
        { alias: 'eligibility_total_count', metricName: 'auth_login_eligibility_stage_duration_seconds_count', labels: { stage: 'total', result: 'ok' } },
        { alias: 'eligibility_account_lookup_sum', metricName: 'auth_login_eligibility_stage_duration_seconds_sum', labels: { stage: 'account_lookup', result: 'ok' } },
        { alias: 'eligibility_account_lookup_count', metricName: 'auth_login_eligibility_stage_duration_seconds_count', labels: { stage: 'account_lookup', result: 'ok' } },
        { alias: 'eligibility_disabled_check_sum', metricName: 'auth_login_eligibility_stage_duration_seconds_sum', labels: { stage: 'disabled_check', result: 'ok' } },
        { alias: 'eligibility_disabled_check_count', metricName: 'auth_login_eligibility_stage_duration_seconds_count', labels: { stage: 'disabled_check', result: 'ok' } },
        { alias: 'eligibility_provider_checks_sum', metricName: 'auth_login_eligibility_stage_duration_seconds_sum', labels: { stage: 'provider_checks', result: 'ok' } },
        { alias: 'eligibility_provider_checks_count', metricName: 'auth_login_eligibility_stage_duration_seconds_count', labels: { stage: 'provider_checks', result: 'ok' } },
        { alias: 'eligibility_positive_hit_total', metricName: 'auth_login_eligibility_cache_total', labels: { cache: 'positive_result', result: 'hit' } },
        { alias: 'eligibility_positive_miss_total', metricName: 'auth_login_eligibility_cache_total', labels: { cache: 'positive_result', result: 'miss' } },
        { alias: 'eligibility_account_snapshot_hit_total', metricName: 'auth_login_eligibility_cache_total', labels: { cache: 'account_snapshot', result: 'hit' } },
        { alias: 'eligibility_account_snapshot_miss_total', metricName: 'auth_login_eligibility_cache_total', labels: { cache: 'account_snapshot', result: 'miss' } },
        { alias: 'eligibility_inflight_hit_total', metricName: 'auth_login_eligibility_cache_total', labels: { cache: 'inflight', result: 'hit' } },
        { alias: 'eligibility_inflight_miss_total', metricName: 'auth_login_eligibility_cache_total', labels: { cache: 'inflight', result: 'miss' } },
        { alias: 'access_sum', metricName: 'session_write_create_message_duration_seconds_sum', labels: { stage: 'access', result: 'ok' } },
        { alias: 'access_count', metricName: 'session_write_create_message_duration_seconds_count', labels: { stage: 'access', result: 'ok' } },
        { alias: 'persist_sum', metricName: 'session_write_create_message_duration_seconds_sum', labels: { stage: 'persist', result: 'ok' } },
        { alias: 'persist_count', metricName: 'session_write_create_message_duration_seconds_count', labels: { stage: 'persist', result: 'ok' } },
        { alias: 'change_tracking_sum', metricName: 'session_write_create_message_duration_seconds_sum', labels: { stage: 'change_tracking', result: 'ok' } },
        { alias: 'change_tracking_count', metricName: 'session_write_create_message_duration_seconds_count', labels: { stage: 'change_tracking', result: 'ok' } },
        { alias: 'total_sum', metricName: 'session_write_create_message_duration_seconds_sum', labels: { stage: 'total', result: 'ok' } },
        { alias: 'total_count', metricName: 'session_write_create_message_duration_seconds_count', labels: { stage: 'total', result: 'ok' } },
        { alias: 'retry_total', metricName: 'database_transaction_retries_total', labels: { provider: 'postgres' } },
      ],
    }),
    fetchGatewayStubStatus(params.target)
      .then((statusText) => ({ status: 'ok' as const, statusText }))
      .catch((error: unknown) => ({
        status: 'error' as const,
        error: error instanceof Error ? error.message : String(error),
      })),
    summarizeGatewayLogs(params.target),
  ]);

  const partialErrors: string[] = [];
  const apiCounters = apiCountersResult.status === 'fulfilled'
    ? apiCountersResult.value
    : (partialErrors.push(apiCountersResult.reason instanceof Error ? apiCountersResult.reason.message : String(apiCountersResult.reason)), {});
  const workerCounters = workerCountersResult.status === 'fulfilled'
    ? workerCountersResult.value
    : (partialErrors.push(workerCountersResult.reason instanceof Error ? workerCountersResult.reason.message : String(workerCountersResult.reason)), {});
  const apiStageMetrics = apiStageMetricsResult.status === 'fulfilled'
    ? apiStageMetricsResult.value
    : (partialErrors.push(apiStageMetricsResult.reason instanceof Error ? apiStageMetricsResult.reason.message : String(apiStageMetricsResult.reason)), {});
  const gatewayStatusOutcome = gatewayStatusResult.status === 'fulfilled'
    ? gatewayStatusResult.value
    : {
        status: 'error' as const,
        error: gatewayStatusResult.reason instanceof Error ? gatewayStatusResult.reason.message : String(gatewayStatusResult.reason),
      };

  const gatewayStatus = gatewayStatusOutcome.status === 'ok'
    ? parseGatewayStubStatus(gatewayStatusOutcome.statusText)
    : undefined;
  const gatewayStatusError = gatewayStatusOutcome.status === 'error'
    ? gatewayStatusOutcome.error
    : !gatewayStatus
      ? 'Unable to parse nginx stub status'
      : undefined;
  const gatewayLogSummary = gatewayLogSummaryResult.status === 'fulfilled'
    ? gatewayLogSummaryResult.value
    : undefined;
  const gatewayLogSummaryError = gatewayLogSummaryResult.status === 'rejected'
    ? gatewayLogSummaryResult.reason instanceof Error ? gatewayLogSummaryResult.reason.message : String(gatewayLogSummaryResult.reason)
    : undefined;

  return {
    api: apiCounters,
    worker: workerCounters,
    authHandshakeStages: {
      verifyToken: summarizeStageMetric({
        sumSeconds: apiStageMetrics.verify_token_sum ?? 0,
        count: apiStageMetrics.verify_token_count ?? 0,
      }),
      loginEligibility: summarizeStageMetric({
        sumSeconds: apiStageMetrics.login_eligibility_sum ?? 0,
        count: apiStageMetrics.login_eligibility_count ?? 0,
      }),
      sessionBinding: summarizeStageMetric({
        sumSeconds: apiStageMetrics.session_binding_sum ?? 0,
        count: apiStageMetrics.session_binding_count ?? 0,
      }),
    },
    connectConvergence: {
      phases: {
        startTotal: apiStageMetrics.connect_start_total ?? 0,
        completeTotal: apiStageMetrics.connect_complete_total ?? 0,
        disconnectBeforeReadyTotal: apiStageMetrics.connect_disconnect_before_ready_total ?? 0,
      },
      durations: {
        ready: summarizeStageMetric({
          sumSeconds: apiStageMetrics.connect_ready_sum ?? 0,
          count: apiStageMetrics.connect_ready_count ?? 0,
        }),
        disconnectBeforeReady: summarizeStageMetric({
          sumSeconds: apiStageMetrics.connect_disconnect_before_ready_sum ?? 0,
          count: apiStageMetrics.connect_disconnect_before_ready_count ?? 0,
        }),
      },
    },
    sessionBindingStages: {
      ownerSessionLookup: summarizeStageMetric({
        sumSeconds: apiStageMetrics.binding_owner_session_lookup_sum ?? 0,
        count: apiStageMetrics.binding_owner_session_lookup_count ?? 0,
      }),
      machineAccessKeyLookup: summarizeStageMetric({
        sumSeconds: apiStageMetrics.binding_machine_access_key_lookup_sum ?? 0,
        count: apiStageMetrics.binding_machine_access_key_lookup_count ?? 0,
      }),
    },
    loginEligibilityStages: {
      total: summarizeStageMetric({
        sumSeconds: apiStageMetrics.eligibility_total_sum ?? 0,
        count: apiStageMetrics.eligibility_total_count ?? 0,
      }),
      accountLookup: summarizeStageMetric({
        sumSeconds: apiStageMetrics.eligibility_account_lookup_sum ?? 0,
        count: apiStageMetrics.eligibility_account_lookup_count ?? 0,
      }),
      disabledCheck: summarizeStageMetric({
        sumSeconds: apiStageMetrics.eligibility_disabled_check_sum ?? 0,
        count: apiStageMetrics.eligibility_disabled_check_count ?? 0,
      }),
      providerChecks: summarizeStageMetric({
        sumSeconds: apiStageMetrics.eligibility_provider_checks_sum ?? 0,
        count: apiStageMetrics.eligibility_provider_checks_count ?? 0,
      }),
    },
    loginEligibilityCache: {
      positiveResultHits: apiStageMetrics.eligibility_positive_hit_total ?? 0,
      positiveResultMisses: apiStageMetrics.eligibility_positive_miss_total ?? 0,
      accountSnapshotHits: apiStageMetrics.eligibility_account_snapshot_hit_total ?? 0,
      accountSnapshotMisses: apiStageMetrics.eligibility_account_snapshot_miss_total ?? 0,
      inflightHits: apiStageMetrics.eligibility_inflight_hit_total ?? 0,
      inflightMisses: apiStageMetrics.eligibility_inflight_miss_total ?? 0,
    },
    createSessionMessageStages: {
      access: summarizeStageMetric({
        sumSeconds: apiStageMetrics.access_sum ?? 0,
        count: apiStageMetrics.access_count ?? 0,
      }),
      persist: summarizeStageMetric({
        sumSeconds: apiStageMetrics.persist_sum ?? 0,
        count: apiStageMetrics.persist_count ?? 0,
      }),
      changeTracking: summarizeStageMetric({
        sumSeconds: apiStageMetrics.change_tracking_sum ?? 0,
        count: apiStageMetrics.change_tracking_count ?? 0,
      }),
      total: summarizeStageMetric({
        sumSeconds: apiStageMetrics.total_sum ?? 0,
        count: apiStageMetrics.total_count ?? 0,
      }),
    },
    databaseTransactionRetries: {
      postgres: apiStageMetrics.retry_total ?? 0,
    },
    ...(gatewayStatus ? { gatewayStatus } : {}),
    ...(gatewayStatusError ? { gatewayStatusError } : {}),
    ...(gatewayLogSummary ? { gatewayLogSummary } : {}),
    ...(gatewayLogSummaryError ? { gatewayLogSummaryError } : {}),
    ...(params.apiReplicaPeakMetrics ? { apiReplicaPeakMetrics: params.apiReplicaPeakMetrics } : {}),
    ...(params.apiReplicaPeakMetricsError ? { apiReplicaPeakMetricsError: params.apiReplicaPeakMetricsError } : {}),
    ...(params.apiReplicaDiagnosticSignals ? { apiReplicaDiagnosticSignals: params.apiReplicaDiagnosticSignals } : {}),
    ...(params.containerMemoryPeakMetrics ? { containerMemoryPeakMetrics: params.containerMemoryPeakMetrics } : {}),
    ...(params.containerMemoryPeakMetricsError ? { containerMemoryPeakMetricsError: params.containerMemoryPeakMetricsError } : {}),
    ...(partialErrors.length > 0 ? { failureMetricsError: partialErrors.join('; ') } : {}),
  };
}

export function normalizeMixedScenarioAuths(params: {
  auths?: readonly MixedScenarioAuth[];
  token?: string;
}): readonly MixedScenarioAuth[] {
  if (Array.isArray(params.auths) && params.auths.length > 0) {
    return params.auths;
  }
  if (typeof params.token === 'string' && params.token.length > 0) {
    return [{ token: params.token }];
  }
  throw new Error('Mixed stress scenario requires at least one auth token');
}

export function resolveMixedAuth(params: {
  auths: readonly MixedScenarioAuth[];
  authIndex: number;
}): MixedScenarioAuth {
  const auth = params.auths[params.authIndex];
  if (!auth) {
    throw new Error(`Missing mixed scenario auth at index ${params.authIndex}`);
  }
  return auth;
}

export function resolveMixedUserDevices(params: {
  auths: readonly MixedScenarioAuth[];
  baseUrl: string;
  transports: readonly ('websocket' | 'polling')[];
  mixedMessageEmitterCount: number;
  mixedSocketConnectTimeoutMs: number;
}): readonly MixedUserDevices[] {
  const perAuthEmitterCount = Math.max(
    1,
    Math.ceil(Math.max(1, params.mixedMessageEmitterCount) / Math.max(1, params.auths.length)),
  );

  return params.auths.map((auth, authIndex) => ({
    authIndex,
    token: auth.token,
    devices: Array.from({ length: perAuthEmitterCount }, () =>
      createUserScopedSocketCollector(params.baseUrl, auth.token, {
        transports: params.transports,
        connectTimeoutMs: params.mixedSocketConnectTimeoutMs,
      })),
  }));
}

export function resolvePrimaryMixedUserDevice(params: {
  userDevices: readonly MixedUserDevices[];
  authIndex: number;
}): MixedUserScopedDevice {
  const device = params.userDevices[params.authIndex]?.devices[0];
  if (!device) {
    throw new Error(`Missing primary mixed user device for auth ${params.authIndex}`);
  }
  return device;
}

export function captureMixedConnectivitySnapshot(params: {
  userDevices: readonly MixedUserDevices[];
  machineCollectors: readonly MixedCollector[];
  disconnectedSampleLimit?: number;
}): MixedConnectivitySnapshot {
  const disconnectedUserDevices = params.userDevices
    .map((userDevice) => ({
      authIndex: userDevice.authIndex,
      disconnectedDevices: userDevice.devices
        .map((device, deviceIndex) => ({ device, deviceIndex }))
        .filter(({ device }) => !device.isConnected()),
    }))
    .filter((userDevice) => userDevice.disconnectedDevices.length > 0);
  const disconnectedCollectors = params.machineCollectors.filter((collector) => !collector.socket.isConnected());
  const disconnectedSampleLimit = Math.max(1, params.disconnectedSampleLimit ?? 16);

  return {
    userDevices: {
      total: params.userDevices.length,
      connected: params.userDevices.length - disconnectedUserDevices.length,
      disconnectedAuthIndexes: disconnectedUserDevices.map((userDevice) => userDevice.authIndex),
      disconnectedSample: disconnectedUserDevices.slice(0, disconnectedSampleLimit).map((userDevice) => ({
        authIndex: userDevice.authIndex,
        disconnectedDeviceCount: userDevice.disconnectedDevices.length,
        devices: userDevice.disconnectedDevices.slice(0, disconnectedSampleLimit).map(({ device, deviceIndex }) => ({
          deviceIndex,
          ...summarizeSocketConnectivityFailure(device.getEvents()),
        })),
      })),
    },
    machineCollectors: {
      total: params.machineCollectors.length,
      connected: params.machineCollectors.length - disconnectedCollectors.length,
      disconnectedCount: disconnectedCollectors.length,
      disconnectedSample: disconnectedCollectors.slice(0, disconnectedSampleLimit).map((collector) => ({
        sessionId: collector.sessionId,
        machineId: collector.machineId,
        authIndex: collector.authIndex,
        ...summarizeSocketConnectivityFailure(collector.socket.getEvents()),
      })),
    },
  };
}

export function recordProvisionedCollector(params: {
  collector: MixedCollector;
  sessionIds: string[];
  sessions: MixedSessionTarget[];
  machineCollectors: MixedCollector[];
  verificationSessionIds: string[];
  expectedLocalIdsBySession: Map<string, string[]>;
  verificationSessionCount: number;
}): void {
  params.sessionIds.push(params.collector.sessionId);
  params.sessions.push({
    sessionId: params.collector.sessionId,
    authIndex: params.collector.authIndex,
  });
  params.machineCollectors.push(params.collector);

  if (params.verificationSessionIds.length >= params.verificationSessionCount) {
    return;
  }

  params.verificationSessionIds.push(params.collector.sessionId);
  params.expectedLocalIdsBySession.set(params.collector.sessionId, []);
}

export async function emitPresencePulse(collector: MixedCollector): Promise<void> {
  const now = Date.now();
  collector.socket.emit('session-alive', {
    sid: collector.sessionId,
    time: now,
    thinking: false,
  });
  collector.socket.emit('machine-alive', {
    machineId: collector.machineId,
    time: now,
  });
}

export async function sendMixedMessageBatch(params: {
  startIndex: number;
  endIndexExclusive: number;
  sessions: readonly MixedSessionTarget[];
  concurrency: number;
  userDevices: readonly MixedUserDevices[];
  ackLatencies: number[];
  expectedLocalIdsBySession: Map<string, string[]>;
}): Promise<void> {
  const indices = Array.from(
    { length: Math.max(0, params.endIndexExclusive - params.startIndex) },
    (_, offset) => params.startIndex + offset,
  );

  await runStressTasksWithConcurrencyLimit(indices, params.concurrency, async (index) => {
    const session = params.sessions[index % params.sessions.length];
    if (!session) {
      throw new Error(`Missing session id for mixed workload at index ${index}`);
    }

    const userDeviceGroup = params.userDevices[session.authIndex];
    const device = userDeviceGroup?.devices[index % (userDeviceGroup?.devices.length || 1)];
    if (!device) {
      throw new Error(`Missing mixed workload emitter at index ${index}`);
    }

    const localId = randomUUID();
    const started = Date.now();
    const rawAck = await device.emitWithAck<unknown>('message', {
      sid: session.sessionId,
      message: Buffer.from(`mixed-${index}`, 'utf8').toString('base64'),
      localId,
    });
    const ack = MessageAckResponseSchema.parse(rawAck);
    params.ackLatencies.push(Date.now() - started);
    if (!ack.ok) {
      throw new Error(
        `Expected successful mixed message ack for ${session.sessionId}: ${JSON.stringify(ack)}`,
      );
    }
    params.expectedLocalIdsBySession.get(session.sessionId)?.push(localId);
  });
}

export async function sendMixedRpcBatch(params: {
  listeners: readonly Pick<MixedListener, 'method' | 'machineId' | 'authIndex'>[];
  rpcPlans: readonly MixedRpcPlan[];
  concurrency: number;
  userDevices: readonly MixedUserDevices[];
  rpcLatencies: number[];
}): Promise<void> {
  await runStressTasksWithConcurrencyLimit(params.rpcPlans, params.concurrency, async (rpcPlan) => {
    const listener = params.listeners[rpcPlan.listenerIndex];
    if (!listener) {
      throw new Error(`Missing mixed workload RPC listener at index ${rpcPlan.listenerIndex}`);
    }

    const rpcStarted = Date.now();
    const response = await resolvePrimaryMixedUserDevice({
      userDevices: params.userDevices,
      authIndex: listener.authIndex,
    }).rpcCall<{ ok: boolean; result?: string; errorCode?: string }>(
      listener.method,
      JSON.stringify({ index: rpcPlan.triggerMessageIndex }),
    );
    params.rpcLatencies.push(Date.now() - rpcStarted);
    if (!response.ok || typeof response.result !== 'string') {
      const errorCode = typeof response.errorCode === 'string' ? response.errorCode : 'unknown';
      throw new Error(`Mixed workload RPC failed for ${listener.method}: ${errorCode}`);
    }
    const parsed = JSON.parse(response.result) as { ok?: boolean; machineId?: string };
    if (parsed.ok !== true || parsed.machineId !== listener.machineId) {
      throw new Error(`Mixed workload RPC routed to the wrong listener for ${listener.method}`);
    }
  });
}

export async function runMixedSocketConnectTasks(params: {
  tasks: ReadonlyArray<() => Promise<void>>;
  concurrency: number;
  connectPattern?: 'burst' | 'ramped';
  rampStepMs?: number;
  sleepImpl?: (ms: number) => Promise<void>;
}): Promise<void> {
  const sleepDuringRamp = params.sleepImpl ?? sleep;
  const concurrency = Math.max(1, params.concurrency);
  if (params.connectPattern !== 'ramped') {
    await runStressTasksWithConcurrencyLimit(params.tasks, concurrency, async (task) => {
      await task();
    });
    return;
  }

  const rampStepMs = Math.max(0, params.rampStepMs ?? 0);
  for (let batchStart = 0; batchStart < params.tasks.length; batchStart += concurrency) {
    if (batchStart > 0 && rampStepMs > 0) {
      await sleepDuringRamp(rampStepMs);
    }
    const batch = params.tasks.slice(batchStart, batchStart + concurrency);
    await Promise.all(batch.map(async (task) => task()));
  }
}

function selectReadinessProbeListeners(
  listeners: readonly MixedListener[],
  probeCount: number,
): readonly MixedListener[] {
  if (listeners.length === 0) {
    return [];
  }
  if (probeCount >= listeners.length) {
    return listeners;
  }

  const selected = new Map<number, MixedListener>();
  const lastIndex = listeners.length - 1;
  for (let index = 0; index < probeCount; index += 1) {
    const offset = Math.round((index * lastIndex) / Math.max(1, probeCount - 1));
    const listener = listeners[offset];
    if (listener) {
      selected.set(offset, listener);
    }
  }

  return Array.from(selected.values());
}

export async function runMixedRealisticScenario(params: {
  run: RunDirs;
  target: StartedStressTarget;
  config: StressConfig;
  auths?: readonly MixedScenarioAuth[];
  token?: string;
}): Promise<void> {
  const testDir = params.run.testDir('mixed-realistic');
  const startedAt = new Date().toISOString();
  const workload = buildMixedRealisticWorkload(params.config);
  const auths = normalizeMixedScenarioAuths(params);
  const transports = resolveStressSocketTransports(params.config, params.target.mode);
  const mixedSetupConcurrency = params.config.load.mixedSetupConcurrency ?? 8;
  const mixedConnectConcurrency = params.config.load.mixedConnectConcurrency ?? 128;
  const mixedConnectPattern = params.config.load.mixedConnectPattern ?? 'burst';
  const mixedConnectRampStepMs = params.config.load.mixedConnectRampStepMs ?? 0;
  const mixedSocketConnectTimeoutMs = params.config.load.mixedSocketConnectTimeoutMs ?? 60_000;
  const mixedSetupRequestTimeoutMs = params.config.load.mixedSetupRequestTimeoutMs ?? 15_000;
  const mixedRpcRegistrationConcurrency = params.config.load.mixedRpcRegistrationConcurrency ?? 8;
  const mixedRpcBatchConcurrency = params.config.load.mixedRpcBatchConcurrency ?? 32;
  const mixedPresencePulseConcurrency = params.config.load.mixedPresencePulseConcurrency ?? 32;
  const mixedMessageBatchConcurrency = params.config.load.mixedMessageBatchConcurrency ?? 32;
  const mixedMessageEmitterCount = Math.max(1, params.config.load.mixedMessageEmitterCount ?? 1);
  const sessionIds: string[] = [];
  const sessions: MixedSessionTarget[] = [];
  const machineCollectors: MixedCollector[] = [];
  const expectedLocalIdsBySession = new Map<string, string[]>();
  const ackLatencies: number[] = [];
  const rpcLatencies: number[] = [];
  const verificationSessionIds: string[] = [];
  const artifacts = new FailureArtifacts();
  let listeners: MixedListener[] = [];
  const rpcReadinessLedger: MixedRpcReadinessLedgerEntry[] = [];
  let failedRpc: MixedFailedRpcContext | undefined;
  let connectivitySnapshot: MixedConnectivitySnapshot | undefined;
  let messageAckFailures = 0;
  let rpcFailures = 0;
  let reconnectFailures = 0;
  let duplicateLocalIds = 0;
  let reconnectsTriggered = 0;
  let rpcCalls = 0;
  let metrics: Record<string, unknown> = {};
  let trackedSocketsClosed = false;
  const stageDurationsMs = {
    provisionMs: 0,
    connectMs: 0,
    trafficMs: 0,
    verificationMs: 0,
    metricsScrapeMs: 0,
  };
  let failure: unknown;

  const userDevices = resolveMixedUserDevices({
    auths,
    baseUrl: params.target.baseUrl,
    transports,
    mixedMessageEmitterCount,
    mixedSocketConnectTimeoutMs,
  });

  artifacts.json('userDevices.events.json', () =>
    userDevices.map((userDevice) => ({
      authIndex: userDevice.authIndex,
      events: userDevice.devices.map((device, index) => ({ index, events: device.getEvents() })),
    })));
  artifacts.json(
    'messageEmitters.events.json',
    () =>
      userDevices.flatMap((userDevice) =>
        userDevice.devices.map((device, index) => ({
          authIndex: userDevice.authIndex,
          index,
          events: device.getEvents(),
        }))),
  );
  artifacts.json(
    'listener.events.json',
    () =>
      machineCollectors.slice(0, Math.min(machineCollectors.length, 16)).map((collector, index) => ({
        index,
        authIndex: collector.authIndex,
        machineId: collector.machineId,
          events: collector.socket.getEvents(),
      })),
  );
  artifacts.json('listeners.catalog.json', () =>
    listeners.map((listener, index) => ({
      index,
      method: listener.method,
      machineId: listener.machineId,
      authIndex: listener.authIndex,
    })));
  artifacts.json('rpc.readiness.json', () => rpcReadinessLedger);
  artifacts.json('rpc.failure.json', () => (failedRpc ? [failedRpc] : []));
  artifacts.json('connectivity.snapshot.json', () => (connectivitySnapshot ? [connectivitySnapshot] : []));

  const closeTrackedSockets = () => {
    if (trackedSocketsClosed) {
      return;
    }
    trackedSocketsClosed = true;
    userDevices.forEach((userDevice) => userDevice.devices.forEach((device) => device.close()));
    machineCollectors.forEach((collector) => collector.socket.close());
  };

  try {
    const provisionStartedAt = Date.now();
    await runStressTasksWithConcurrencyLimit(
      workload.sessionPlans,
      mixedSetupConcurrency,
      async (sessionPlan) => {
        const auth = resolveMixedAuth({
          auths,
          authIndex: sessionPlan.authIndex,
        });
        const { sessionId } = await createSession(params.target.baseUrl, auth.token, {
          timeoutMs: mixedSetupRequestTimeoutMs,
        });
        const collector = await createMachineBoundSessionScopedSocketCollector({
          baseUrl: params.target.baseUrl,
          token: auth.token,
          sessionId,
          transports,
          connectTimeoutMs: mixedSocketConnectTimeoutMs,
        });
        const mixedCollector = {
          sessionId,
          machineId: collector.machineId,
          authIndex: sessionPlan.authIndex,
          socket: collector.socket,
        } satisfies MixedCollector;
        recordProvisionedCollector({
          collector: mixedCollector,
          sessionIds,
          sessions,
          machineCollectors,
          verificationSessionIds,
          expectedLocalIdsBySession,
          verificationSessionCount: workload.verificationSessionCount,
        });
      },
    );
    stageDurationsMs.provisionMs = Date.now() - provisionStartedAt;

    listeners = machineCollectors.slice(0, Math.min(machineCollectors.length, workload.rpcListenerCount)).map((collector, index) => ({
      method: `${sessionIds[index] ?? `mixed-${index}`}:stress.mixed.rpc.${index}`,
      machineId: collector.machineId,
      authIndex: collector.authIndex,
      socket: collector.socket,
    })) satisfies MixedListener[];
    const reconnectPool = machineCollectors.slice(listeners.length);

    const connectStartedAt = Date.now();
    if (params.config.duration.warmupMs > 0) {
      await sleep(params.config.duration.warmupMs);
    }
    await runMixedSocketConnectTasks({
      concurrency: mixedConnectConcurrency,
      connectPattern: mixedConnectPattern,
      rampStepMs: mixedConnectRampStepMs,
      tasks: [
        ...userDevices.flatMap((userDevice) =>
          userDevice.devices.map(
            (device) => async () => {
              device.connect();
              await new Promise<void>((resolve) => setImmediate(resolve));
            },
          )),
        ...machineCollectors.map(
          (collector) => async () => {
            collector.socket.connect();
            await new Promise<void>((resolve) => setImmediate(resolve));
          },
        ),
      ],
    });
    try {
      await waitFor(
        () =>
          userDevices.every((userDevice) => userDevice.devices.every((device) => device.isConnected()))
          && machineCollectors.every((collector) => collector.socket.isConnected()),
        { timeoutMs: 60_000 },
      );
    } catch (error) {
      connectivitySnapshot = captureMixedConnectivitySnapshot({
        userDevices,
        machineCollectors,
      });
      throw error;
    }

    await runStressTasksWithConcurrencyLimit(listeners, mixedRpcRegistrationConcurrency, async (listener) => {
      listener.socket.onRpcRequest(async () => JSON.stringify({ ok: true, machineId: listener.machineId }));
      await listener.socket.rpcRegister(listener.method);
    });

    const readinessProbeListeners = selectReadinessProbeListeners(listeners, workload.rpcReadinessProbeCount);
    await Promise.all(
      readinessProbeListeners.map(async (listener) => {
        const startedAt = Date.now();
        try {
          await waitForRegisteredRpcMethod({
            ui: resolvePrimaryMixedUserDevice({
              userDevices,
              authIndex: listener.authIndex,
            }),
            method: listener.method,
            expectedMachineId: listener.machineId,
          });
          rpcReadinessLedger.push({
            method: listener.method,
            machineId: listener.machineId,
            authIndex: listener.authIndex,
            status: 'ok',
            durationMs: Date.now() - startedAt,
          });
        } catch (error) {
          rpcReadinessLedger.push({
            method: listener.method,
            machineId: listener.machineId,
            authIndex: listener.authIndex,
            status: 'error',
            durationMs: Date.now() - startedAt,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      }),
    );
    stageDurationsMs.connectMs = Date.now() - connectStartedAt;

    if (workload.presencePulseCollectorCount > 0) {
      await runStressTasksWithConcurrencyLimit(
        machineCollectors.slice(0, workload.presencePulseCollectorCount),
        mixedPresencePulseConcurrency,
        async (collector) => {
          await emitPresencePulse(collector);
        },
      );
    }

    const trafficStartedAt = Date.now();
    const plannedRpcCalls = resolveRpcCallCount(params.config, listeners.length);
    const rpcEveryMessages = Math.max(1, Math.floor(workload.messageCount / Math.max(1, plannedRpcCalls)));
    const reconnectEveryMessages = Math.max(1, Math.floor(workload.messageCount / Math.max(1, workload.reconnectCycles)));
    let reconnectIndex = 0;

    let nextRpcTrigger = rpcEveryMessages;
    let nextReconnectTrigger = reconnectEveryMessages;

    for (let batchStart = 0; batchStart < workload.messageCount; batchStart += mixedMessageBatchConcurrency) {
      const batchEndExclusive = Math.min(workload.messageCount, batchStart + mixedMessageBatchConcurrency);
      const acknowledgedBeforeBatch = ackLatencies.length;
      try {
        await sendMixedMessageBatch({
          startIndex: batchStart,
          endIndexExclusive: batchEndExclusive,
          sessions,
          concurrency: mixedMessageBatchConcurrency,
          userDevices,
          ackLatencies,
          expectedLocalIdsBySession,
        });
      } catch (error) {
        messageAckFailures += Math.max(1, ackLatencies.length - acknowledgedBeforeBatch);
        throw error;
      }

      const dueRpcPlans: MixedRpcPlan[] = [];
      while (
        listeners.length > 0
        && rpcCalls + dueRpcPlans.length < plannedRpcCalls
        && nextRpcTrigger <= batchEndExclusive
      ) {
        dueRpcPlans.push({
          listenerIndex: (rpcCalls + dueRpcPlans.length) % listeners.length,
          triggerMessageIndex: nextRpcTrigger - 1,
        });
        nextRpcTrigger += rpcEveryMessages;
      }

      if (dueRpcPlans.length > 0) {
        const completedRpcCallsBeforeBatch = rpcLatencies.length;
        try {
          await sendMixedRpcBatch({
            listeners,
            rpcPlans: dueRpcPlans,
            concurrency: mixedRpcBatchConcurrency,
            userDevices,
            rpcLatencies,
          });
          rpcCalls += dueRpcPlans.length;
        } catch (error) {
          rpcFailures += 1;
          const failureMessage = error instanceof Error ? error.message : String(error);
          const failedMethod = /Mixed workload RPC (?:failed for|routed to the wrong listener for) (.+?)(?:: .+)?$/u.exec(failureMessage)?.[1];
          const failedListener = listeners.find((listener) => listener.method === failedMethod);
          const completedRpcCallsThisBatch = Math.max(0, rpcLatencies.length - completedRpcCallsBeforeBatch);
          failedRpc = {
            method: failedListener?.method ?? failedMethod ?? 'unknown',
            machineId: failedListener?.machineId ?? 'unknown',
            authIndex: failedListener?.authIndex ?? -1,
            rpcCallsCompleted: rpcCalls + completedRpcCallsThisBatch,
            messagesSentBeforeFailure: ackLatencies.length,
            ...(failureMessage.includes('RPC_METHOD_NOT_AVAILABLE') ? { errorCode: 'RPC_METHOD_NOT_AVAILABLE' } : {}),
            error: failureMessage,
          };
          throw error;
        }
      }

      while (reconnectsTriggered < workload.reconnectCycles && nextReconnectTrigger <= batchEndExclusive) {
        const collectorPool = reconnectPool.length > 0 ? reconnectPool : machineCollectors;
        const collector = collectorPool[reconnectIndex % collectorPool.length];
        reconnectIndex += 1;
        if (!collector) {
          throw new Error(`Missing reconnect collector at index ${reconnectIndex}`);
        }
        collector.socket.disconnect();
        await waitFor(() => !collector.socket.isConnected(), { timeoutMs: 20_000 });
        collector.socket.connect();
        await waitFor(() => collector.socket.isConnected(), { timeoutMs: 30_000 });
        const reconnectingListener = listeners.find((listener) => listener.machineId === collector.machineId);
        if (reconnectingListener) {
          await reconnectingListener.socket.rpcRegister(reconnectingListener.method);
          await waitForRegisteredRpcMethod({
            ui: resolvePrimaryMixedUserDevice({
              userDevices,
              authIndex: reconnectingListener.authIndex,
            }),
            method: reconnectingListener.method,
            expectedMachineId: reconnectingListener.machineId,
          });
        }
        if (workload.presencePulseCollectorCount > 0) {
          await emitPresencePulse(collector);
        }
        reconnectsTriggered += 1;
        nextReconnectTrigger += reconnectEveryMessages;

        if (reconnectsTriggered % 2 === 0) {
          const reconnectUserDevice = resolvePrimaryMixedUserDevice({
            userDevices,
            authIndex: collector.authIndex,
          });
          reconnectUserDevice.disconnect();
          await waitFor(() => !reconnectUserDevice.isConnected(), { timeoutMs: 20_000 });
          reconnectUserDevice.connect();
          await waitFor(() => reconnectUserDevice.isConnected(), { timeoutMs: 30_000 });
        }
      }
    }

    if (params.config.duration.soakMs > 0) {
      await sleep(params.config.duration.soakMs);
    }
    stageDurationsMs.trafficMs = Date.now() - trafficStartedAt;

    const verificationStartedAt = Date.now();
    for (const sessionId of verificationSessionIds) {
      const session = sessions.find((candidate) => candidate.sessionId === sessionId);
      if (!session) {
        throw new Error(`Missing mixed session ownership for ${sessionId}`);
      }
      const transcript = await fetchAllMessages(
        params.target.baseUrl,
        resolveMixedAuth({
          auths,
          authIndex: session.authIndex,
        }).token,
        sessionId,
      );
      duplicateLocalIds += countDuplicateLocalIds(transcript);
      const localIdSet = new Set(
        transcript
          .map((message) => message.localId)
          .filter((value): value is string => typeof value === 'string' && value.length > 0),
      );
      for (const localId of expectedLocalIdsBySession.get(sessionId) ?? []) {
        if (!localIdSet.has(localId)) {
          throw new Error(`Mixed workload transcript verification missed localId ${localId} for ${sessionId}`);
        }
      }
    }
    stageDurationsMs.verificationMs = Date.now() - verificationStartedAt;

    if (params.target.mode === 'full-compose' && params.config.compose.metricsEnabled && params.config.artifacts.metricsScrapeEnabled) {
      const metricsScrapeStartedAt = Date.now();
      metrics = {
        ...(await scrapeMixedRealisticFullComposeMetrics({
          target: params.target,
        })),
        rpcLatencies: summarizeLatencySamples(rpcLatencies),
      };
      stageDurationsMs.metricsScrapeMs = Date.now() - metricsScrapeStartedAt;
    }

    if (params.config.duration.cooldownMs > 0) {
      await sleep(params.config.duration.cooldownMs);
    }
  } catch (error) {
    failure = error;
    if (error instanceof Error && /connect|disconnect|timed out|Missing reconnect collector/iu.test(error.message)) {
      reconnectFailures += 1;
    }
  } finally {
    if (
      failure
      && params.target.mode === 'full-compose'
      && params.config.compose.metricsEnabled
      && params.config.artifacts.metricsScrapeEnabled
      && (
        !('api' in metrics)
        || (
          typeof metrics.failureMetricsError === 'string'
          && /EBADF/u.test(metrics.failureMetricsError)
        )
      )
    ) {
      const metricsScrapeStartedAt = Date.now();
      try {
        metrics = {
          ...metrics,
          ...(await scrapeMixedRealisticFullComposeMetrics({
            target: params.target,
          })),
        };
        if (typeof metrics.failureMetricsError === 'string' && /EBADF/u.test(metrics.failureMetricsError)) {
          closeTrackedSockets();
          metrics = {
            ...metrics,
            ...(await scrapeMixedRealisticFullComposeMetrics({
              target: params.target,
            })),
          };
        }
      } catch (metricsError) {
        const metricsErrorMessage = metricsError instanceof Error ? metricsError.message : String(metricsError);
        if (/EBADF/u.test(metricsErrorMessage)) {
          closeTrackedSockets();
          try {
            metrics = {
              ...metrics,
              ...(await scrapeMixedRealisticFullComposeMetrics({
                target: params.target,
              })),
            };
          } catch (retryMetricsError) {
            metrics = {
              ...metrics,
              failureMetricsError: retryMetricsError instanceof Error ? retryMetricsError.message : String(retryMetricsError),
            };
          }
        } else {
          metrics = {
            ...metrics,
            failureMetricsError: metricsErrorMessage,
          };
        }
      }
      stageDurationsMs.metricsScrapeMs = Date.now() - metricsScrapeStartedAt;
    }

    if (
      failure
      && params.target.mode === 'full-compose'
      && params.target.artifacts?.dockerLogsFile
      && (!('gatewayLogSummary' in metrics) || typeof metrics.gatewayLogSummaryError === 'string')
    ) {
      try {
        await params.target.collectDiagnostics();
        const composeLogsText = readFileSync(params.target.artifacts.dockerLogsFile, 'utf8');
        const gatewayLogSummary = summarizeGatewayLogsFromComposeLogs(composeLogsText);
        const { gatewayLogSummaryError: _gatewayLogSummaryError, ...metricsWithoutGatewayLogSummaryError } = metrics;
        metrics = {
          ...metricsWithoutGatewayLogSummaryError,
          gatewayLogSummary,
          gatewayLogSummarySource: 'compose-diagnostics',
        };
      } catch (gatewayLogRecoveryError) {
        const recoveryErrorMessage =
          gatewayLogRecoveryError instanceof Error ? gatewayLogRecoveryError.message : String(gatewayLogRecoveryError);
        metrics = {
          ...metrics,
          gatewayLogSummaryError:
            typeof metrics.gatewayLogSummaryError === 'string'
              ? `${metrics.gatewayLogSummaryError}; compose diagnostics: ${recoveryErrorMessage}`
              : recoveryErrorMessage,
        };
      }
    }

    metrics = {
      ...metrics,
      rpcReadiness: {
        probed: rpcReadinessLedger.length,
        successful: rpcReadinessLedger.filter((entry) => entry.status === 'ok').length,
        failed: rpcReadinessLedger.filter((entry) => entry.status === 'error').length,
        ledger: rpcReadinessLedger,
      },
      ...(connectivitySnapshot ? { connectivitySnapshot } : {}),
      ...(failedRpc ? { failedRpc } : {}),
      stageDurationsMs,
    };
    await artifacts.dumpAll(testDir, { onlyIf: params.config.artifacts.saveArtifactsOnSuccess || !!failure });
    closeTrackedSockets();
    await finalizeStressScenario({
      run: params.run,
      testDir,
      testName: 'mixed.realistic',
      target: params.target,
      config: params.config,
      startedAt,
      sessionIds,
      seed: params.config.seed,
      status: failure ? 'failed' : 'passed',
      error: failure,
      counts: {
        sessions: sessionIds.length,
        machineSockets: machineCollectors.length,
        verifiedSessions: verificationSessionIds.length,
        messagesSent: ackLatencies.length,
        rpcCalls,
        rpcListeners: Math.min(machineCollectors.length, workload.rpcListenerCount),
        reconnectsTriggered,
      },
      latencies: summarizeLatencySamples(ackLatencies),
      failures: {
        duplicateLocalIds,
        messageAckFailures,
        rpcFailures,
        reconnectFailures,
      },
      metrics,
    });
  }

  if (failure) {
    throw failure;
  }
}
