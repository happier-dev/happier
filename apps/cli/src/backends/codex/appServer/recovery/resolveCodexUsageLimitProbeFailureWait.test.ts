import { describe, expect, it } from 'vitest';

import {
  CODEX_USAGE_LIMIT_PROBE_FAILURE_RETRY_MS,
  resolveCodexUsageLimitProbeFailureWait,
} from './resolveCodexUsageLimitProbeFailureWait';

const nowMs = Date.parse('2026-06-11T10:00:00.000Z');

describe('resolveCodexUsageLimitProbeFailureWait', () => {
  it('keeps waiting until the known provider reset when the probe fails transiently', () => {
    const result = resolveCodexUsageLimitProbeFailureWait({
      resetAtMs: nowMs + 30 * 60_000,
      nextCheckAtMs: null,
      nowMs,
    });
    expect(result).toEqual({
      status: 'wait',
      nextCheckAtMs: nowMs + 30 * 60_000,
      lastProbeError: 'codex_app_server_rate_limit_probe_unavailable',
    });
  });

  it('waits until the intent next-check time when no provider reset is known', () => {
    const result = resolveCodexUsageLimitProbeFailureWait({
      resetAtMs: null,
      nextCheckAtMs: nowMs + 5 * 60_000,
      nowMs,
    });
    expect(result.status).toBe('wait');
    expect(result.nextCheckAtMs).toBe(nowMs + 5 * 60_000);
  });

  it('uses the earliest future timing when both reset and next-check are known', () => {
    const result = resolveCodexUsageLimitProbeFailureWait({
      resetAtMs: nowMs + 30 * 60_000,
      nextCheckAtMs: nowMs + 5 * 60_000,
      nowMs,
    });
    expect(result.nextCheckAtMs).toBe(nowMs + 5 * 60_000);
  });

  it('falls back to a bounded degraded retry when no future timing is known (never immediate, never terminal)', () => {
    const result = resolveCodexUsageLimitProbeFailureWait({
      resetAtMs: nowMs - 60_000,
      nextCheckAtMs: nowMs,
      nowMs,
    });
    expect(result.status).toBe('wait');
    expect(result.nextCheckAtMs).toBe(nowMs + CODEX_USAGE_LIMIT_PROBE_FAILURE_RETRY_MS);
    expect(result.nextCheckAtMs).toBeGreaterThan(nowMs);
  });

  it('treats a probe racing an app-server client replacement as a transient wait, not exhausted', () => {
    // The wait-probe can race an independent provider-process exit; the resulting transport
    // rejection must classify as retry/wait.
    const result = resolveCodexUsageLimitProbeFailureWait({
      resetAtMs: null,
      nextCheckAtMs: null,
      nowMs,
    });
    expect(result.status).toBe('wait');
    expect(result.lastProbeError).toBe('codex_app_server_rate_limit_probe_unavailable');
  });
});
