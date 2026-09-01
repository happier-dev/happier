/**
 * Classify a FAILED `account/rateLimits/read` wait-probe as a transient, non-terminal wait.
 *
 * Contract (F0/F1 + Wave-2c degraded-retry): a probe failure is never an authoritative
 * provider quota verdict. Timeouts, connection resets, RPC-unavailable errors, and probes
 * racing an independent app-server process exit or client replacement must keep the durable usage-limit intent
 * WAITING. Only an authoritative provider rate-limit response (or a terminal switch
 * outcome such as `generation_apply_failed`) may drive the intent toward `exhausted`.
 *
 * Timing: prefer the earliest known future timing (provider reset, intent next-check);
 * otherwise retry on a bounded degraded interval — never immediately, never terminal.
 */

export const CODEX_USAGE_LIMIT_PROBE_FAILURE_RETRY_MS = 60_000;

export type CodexUsageLimitProbeFailureWait = Readonly<{
  status: 'wait';
  nextCheckAtMs: number;
  lastProbeError: 'codex_app_server_rate_limit_probe_unavailable';
}>;

function readFutureTimestampMs(value: number | null | undefined, nowMs: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const truncated = Math.trunc(value);
  return truncated > nowMs ? truncated : null;
}

export function resolveCodexUsageLimitProbeFailureWait(input: Readonly<{
  resetAtMs: number | null;
  nextCheckAtMs: number | null;
  nowMs: number;
}>): CodexUsageLimitProbeFailureWait {
  const candidates = [
    readFutureTimestampMs(input.resetAtMs, input.nowMs),
    readFutureTimestampMs(input.nextCheckAtMs, input.nowMs),
  ].filter((value): value is number => value !== null);
  return {
    status: 'wait',
    nextCheckAtMs: candidates.length > 0
      ? Math.min(...candidates)
      : input.nowMs + CODEX_USAGE_LIMIT_PROBE_FAILURE_RETRY_MS,
    lastProbeError: 'codex_app_server_rate_limit_probe_unavailable',
  };
}
