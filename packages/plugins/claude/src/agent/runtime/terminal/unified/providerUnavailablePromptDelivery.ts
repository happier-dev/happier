import type { SessionRuntimeUsageLimitDetailsV1 } from '@happier-dev/plugin-sdk/experimental/runtime/session';

export type ClaudeUnifiedProviderUnavailablePromptDeliveryWindow = Readonly<{
  unavailableUntilMs: number;
}>;

function readFutureTimestampMs(value: unknown, nowMs: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const timestampMs = Math.trunc(value);
  return timestampMs > nowMs ? timestampMs : null;
}

function readPositiveDurationMs(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const durationMs = Math.trunc(value);
  return durationMs > 0 ? durationMs : null;
}

export function resolveClaudeUnifiedProviderUnavailableUntilMs(
  details: SessionRuntimeUsageLimitDetailsV1,
  observedAtMs: number,
): number | null {
  const candidates = [
    readFutureTimestampMs(details.resetAtMs, observedAtMs),
    readFutureTimestampMs(details.overage?.resetAtMs, observedAtMs),
  ];
  const retryAfterMs = readPositiveDurationMs(details.retryAfterMs);
  if (retryAfterMs !== null) {
    candidates.push(observedAtMs + retryAfterMs);
  }

  const futureCandidates = candidates.filter((candidate): candidate is number => candidate !== null);
  return futureCandidates.length > 0 ? Math.max(...futureCandidates) : null;
}

export function isClaudeUnifiedProviderUnavailablePromptDeliveryWindowActive(
  window: ClaudeUnifiedProviderUnavailablePromptDeliveryWindow | null,
  nowMs: number,
): window is ClaudeUnifiedProviderUnavailablePromptDeliveryWindow {
  return window !== null && nowMs < window.unavailableUntilMs;
}
